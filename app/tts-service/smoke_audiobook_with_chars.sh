#!/usr/bin/env bash
# Generate audiobook for one chapter using persisted character voices.
set -uo pipefail

BOOK_ID="${1:-a75c2296-4472-4d59-a02f-e947b760bf67}"
EBOOK_CONVERTER_DIR="/Volumes/EXT-SSD/Users/anhl/Local-AI/app/ebook-converter"

echo "═══════════════════════════════════════════════════════"
echo "  Generate audiobook for $BOOK_ID"
echo "═══════════════════════════════════════════════════════"

cd "$EBOOK_CONVERTER_DIR"

# Build CHARACTER_MAP JSON from DB
node -e "
const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
const bookId = '$BOOK_ID';
(async () => {
  const voices = await p.voice.findMany({where:{bookId}});
  const characters = await p.character.findMany({where:{bookId},include:{voice:true}});
  const defaultVoice = await p.voice.findFirst({where:{bookId, isDefault:true}});
  const book = await p.book.findUnique({where:{id:bookId},select:{filePath:true}});

  const BUILTIN = new Set(['Ngọc Lan','Gia Bảo','Thái Sơn','Đức Trí','Mỹ Duyên','Trúc Ly','Xuân Vĩnh','Trọng Hữu','Bình An','Ngọc Linh']);
  const voicesById = {};
  for (const v of voices) {
    voicesById[v.id] = {
      name: v.name,
      refAudioPath: v.refAudioPath || '',
      isBuiltinVieNeu: BUILTIN.has(v.name),
      defaultEmotion: v.defaultEmotion || null,
    };
  }
  const cmap = {
    book_path: book.filePath,
    voices_by_id: voicesById,
    characters: characters.map(c => ({
      name: c.name,
      aliases: c.aliases ? JSON.parse(c.aliases) : [],
      voiceId: c.voiceId,
    })),
    default_voice_id: defaultVoice?.id ?? null,
  };
  console.log(JSON.stringify(cmap));
  await p.\$disconnect();
})();
" > /tmp/cmap_and_book.json

BOOK_PATH=$(python3 -c "import json; d=json.load(open('/tmp/cmap_and_book.json')); print(d['book_path'])")
CMAP=$(python3 -c "import json; d=json.load(open('/tmp/cmap_and_book.json')); d.pop('book_path'); print(json.dumps(d))")
echo "Book: $BOOK_PATH"

python3 -c "
import json
d = json.loads(open('/tmp/cmap_and_book.json').read())
print(f'Voices: {len(d[\"voices_by_id\"])}')
print(f'Characters: {len(d[\"characters\"])}')
"

# Extract first chapter HTML
echo ""
echo "Extracting chapter 3 (skip TOC at chapter001)..."
python3 << PYEOF
import zipfile, re
book = '''$BOOK_PATH'''
with zipfile.ZipFile(book) as z:
    opf = next(n for n in z.namelist() if n.endswith('.opf'))
    opf_c = z.read(opf).decode('utf-8', errors='ignore')
    spine = re.findall(r'<itemref\s+idref="([^"]+)"', opf_c)
    items = dict(re.findall(r'<item\s[^>]*id="([^"]+)"[^>]*href="([^"]+)"', opf_c))
    opf_dir = opf.rsplit('/', 1)[0] if '/' in opf else ''
    # Pick the 3rd spine item (skip TOC + chapter001)
    for sid in spine[2:4]:
        href = items.get(sid)
        if not href: continue
        path = (opf_dir + '/' + href) if opf_dir else href
        if path not in z.namelist(): continue
        c = z.read(path).decode('utf-8', errors='ignore')
        bm = re.search(r'<body[^>]*>([\s\S]*?)</body>', c)
        body = bm.group(1) if bm else c
        with open('/tmp/smoke_chapter.xhtml', 'w', encoding='utf-8') as f:
            f.write(body)
        print(f'Saved {sid}: {len(body)} chars  →  /tmp/smoke_chapter.xhtml')
        break
PYEOF

echo ""
echo "Generating audiobook..."
echo "═══════════════════════════════════════════════════════"
START=$(date +%s)
CHARACTER_MAP="$CMAP" /Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service/.venv-moss-nano/bin/python \
  /Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service/audiobook_generator.py \
  --book-id "$BOOK_ID" \
  --chapter-file EPUB/chapter003.xhtml \
  --backend vieneu \
  --language Vietnamese \
  --chapter-text-file /tmp/smoke_chapter.xhtml \
  --out-dir /tmp/audiobook-final-test 2>&1 | tail -20
END=$(date +%s)
echo ""
echo "Generation took $((END-START))s"
echo ""
ls -lh /tmp/audiobook-final-test/$BOOK_ID/ 2>/dev/null