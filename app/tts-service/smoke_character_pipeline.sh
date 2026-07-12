#!/usr/bin/env bash
# End-to-end smoke test: detect characters → assign voices → pre-generate.
set -uo pipefail

cd "$(dirname "$0")"

OMLX_KEY=$(cat /Volumes/EXT-SSD/Users/anhl/Local-AI/omlx-home/settings.json | python3 -c "import json,sys; print(json.load(sys.stdin)['auth']['api_key'])")
OMLX_MODEL=$(curl -s http://127.0.0.1:8080/health | python3 -c "import json,sys; print(json.load(sys.stdin).get('default_model', 'default'))")
BOOK=$(ls /Volumes/EXT-SSD/Users/anhl/Local-AI/app/ebook-converter/data/library/*.epub | head -1)

echo "════════════════════════════════════════════════════════"
echo "  STEP 1: Detect characters in book"
echo "════════════════════════════════════════════════════════"
echo "Book: $BOOK"
echo ""

OMLX_API_KEY="$OMLX_KEY" OMLX_MODEL="$OMLX_MODEL" python3 character_detector.py "$BOOK" > /tmp/character_detect.json 2> /tmp/character_detect.log &
DET_PID=$!
for i in $(seq 1 24); do
  sleep 5
  if ! kill -0 $DET_PID 2>/dev/null; then break; fi
done
if kill -0 $DET_PID 2>/dev/null; then
  echo "Detector still running — killing"
  kill $DET_PID
fi

cat /tmp/character_detect.log
echo ""
python3 << 'PYEOF'
import json
d = json.load(open('/tmp/character_detect.json'))
print(f"Detected {len(d['characters'])} characters in {d['language']}")
print()
for c in d['characters'][:15]:
    sample = (c.get('sample_lines') or ['—'])[0][:50]
    print(f"  {c['name']:25} {c['gender']:6} {c['tone']:12} ~{c['lines_estimate']:3} lines  | \"{sample}\"")
PYEOF

echo ""
echo "════════════════════════════════════════════════════════"
echo "  STEP 2: Build a CHARACTER_MAP for one chapter"
echo "════════════════════════════════════════════════════════"

# Build a CHARACTER_MAP using 2 detected characters + 2 built-in voices
python3 << 'PYEOF'
import json
d = json.load(open('/tmp/character_detect.json'))

# Pick narrator + 2 most-named characters
names = [c['name'] for c in d['characters'][:3] if c['name']]
# Heuristic: assign narrator to "Bình An", assign first 2 characters to other voices
voices_by_id = {
    "v_narrator": {
        "name": "Bình An",
        "refAudioPath": "",
        "isBuiltinVieNeu": True,
        "defaultSpeed": None,
    },
}
characters = []
voice_picks = ["Ngọc Linh", "Trúc Ly"]
for i, n in enumerate(names):
    vid = f"v_{i}"
    voices_by_id[vid] = {
        "name": voice_picks[i % len(voice_picks)],
        "refAudioPath": "",
        "isBuiltinVieNeu": True,
    }
    characters.append({"name": n, "aliases": [], "voiceId": vid})

cmap = {
    "voices_by_id": voices_by_id,
    "characters": characters,
    "default_voice_id": "v_narrator",
}
print(json.dumps(cmap, ensure_ascii=False, indent=2))
with open('/tmp/cmap.json', 'w') as f:
    json.dump(cmap, f)
PYEOF

echo ""
echo "════════════════════════════════════════════════════════"
echo "  STEP 3: Pre-generate 1 chapter with CHARACTER_MAP"
echo "════════════════════════════════════════════════════════"

# Extract one chapter from the book
PYTHON=/Library/Frameworks/Users/anhl/.local/share/uv/python/cpython-3.11.11-macosx_11_0_arm64-none/bin/python3.11
[ -x "$PYTHON" ] || PYTHON=/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11
$PYTHON << 'PYEOF'
import zipfile, re, json
book = '/Volumes/EXT-SSD/Users/anhl/Local-AI/app/ebook-converter/data/library/0a8dac9c-f6cc-43bb-9e04-30698ec48983.epub'
with zipfile.ZipFile(book) as z:
    opf = next(n for n in z.namelist() if n.endswith('.opf'))
    opf_c = z.read(opf).decode('utf-8', errors='ignore')
    spine = re.findall(r'<itemref\s+idref="([^"]+)"', opf_c)
    items = dict(re.findall(r'<item\s[^>]*id="([^"]+)"[^>]*href="([^"]+)"', opf_c))
    # Pick chapter 5 (skip TOC at 1)
    for sid in spine[4:6]:
        href = items.get(sid)
        if not href: continue
        opf_dir = opf.rsplit('/', 1)[0] if '/' in opf else ''
        path = (opf_dir + '/' + href) if opf_dir else href
        if path not in z.namelist(): continue
        c = z.read(path).decode('utf-8', errors='ignore')
        bm = re.search(r'<body[^>]*>([\s\S]*?)</body>', c)
        body = bm.group(1) if bm else c
        # Save body
        with open('/tmp/test_chapter_body.xhtml', 'w', encoding='utf-8') as f:
            f.write(body)
        print(f'Saved {sid}: {len(body)} chars')
        break
PYEOF

CMAP=$(cat /tmp/cmap.json)
echo "CMAP characters:"
echo "$CMAP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(' ', [c['name']+'→'+d['voices_by_id'][c['voiceId']]['name'] for c in d['characters']])"
echo ""

CHARACTER_MAP="$CMAP" time python3 audiobook_generator.py \
  --book-id smoke-test \
  --chapter-file chapter005.xhtml \
  --backend vieneu \
  --language Vietnamese \
  --chapter-text-file /tmp/test_chapter_body.xhtml \
  --out-dir /tmp/audiobook-smoke 2>&1 | tail -30
echo ""
ls -lh /tmp/audiobook-smoke/smoke-test/chapter005.wav 2>/dev/null && file /tmp/audiobook-smoke/smoke-test/chapter005.wav