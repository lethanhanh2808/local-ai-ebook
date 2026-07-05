#!/usr/bin/env python3
"""_backfill_helper.py

Called by _backfill_gender.js with `python _backfill_helper.py <epub_path>`.

Extracts every chapter from the EPUB (full text, no truncation), runs
character_detector._run_detection per chapter, merges the results by name
(majority vote on gender/tone/age), and emits JSON on stdout:

    {"per_chapter": [{"chapter": "chapter003", "count": 4}, ...],
     "merged":      [{"name": "Y Đằng Long", "gender": "male", ...}, ...],
     "total_unique": 13}

Why a separate file?
- The JS template-literal approach kept stripping backslashes from
  Python regexes (\\s in JS source became \s in JS string, then was
  somehow lost on write). A plain .py file dodges the whole escape mess.

Env:
  OMLX_API_KEY     oMLX bearer token
  OMLX_BASE_URL    default http://127.0.0.1:8080/v1
  OMLX_MODEL       default FastContext-1.0-4B-SFT-Dynamic-4bit-MLX
"""

import sys, json, re, zipfile, os

# Make the detector module importable
sys.path.insert(0, "/Volumes/EXT-SSD/Users/anhl/Local-AI/app/tts-service")
import character_detector as cd  # noqa: E402

epub = sys.argv[1]

with zipfile.ZipFile(epub) as z:
    names = z.namelist()
    opf = next((n for n in names if n.endswith(".opf")), None)
    if not opf:
        print(json.dumps({"per_chapter": [], "merged": [], "total_unique": 0}))
        sys.exit(0)
    opf_content = z.read(opf).decode("utf-8", errors="ignore")
    opf_dir = opf.rsplit("/", 1)[0] if "/" in opf else ""
    spine_ids = re.findall(r'<itemref\s+idref="([^"]+)"', opf_content)
    items = re.findall(r'<item\s[^>]*id="([^"]+)"[^>]*href="([^"]+)"', opf_content)
    item_map = dict(items)
    samples = []
    for sid in spine_ids:
        href = item_map.get(sid)
        if not href:
            continue
        cp = (opf_dir + "/" + href) if opf_dir else href
        cp = cp.replace("\\", "/")
        if cp not in names and href in names:
            cp = href
        if cp not in names:
            continue
        raw = z.read(cp).decode("utf-8", errors="ignore")
        text = re.sub(r"<[^>]+>", " ", raw)
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            samples.append({"id": sid, "text": text})

print(f"Extracted {len(samples)} chapters (full text)", file=sys.stderr)


per_chapter = []
merged_acc = {}  # name.lower() -> {name, gender_votes, tone_votes, age_votes, alias_set}


def merge(name, gender, tone, age, aliases):
    k = (name or "").lower()
    if not k:
        return
    if k not in merged_acc:
        merged_acc[k] = {
            "name": name,
            "gender_votes": {}, "tone_votes": {}, "age_votes": {},
            "alias_set": set(),
        }
    e = merged_acc[k]
    if gender and gender != "unknown":
        e["gender_votes"][gender] = e["gender_votes"].get(gender, 0) + 1
    if tone and tone != "unknown":
        e["tone_votes"][tone] = e["tone_votes"].get(tone, 0) + 1
    if age:
        e["age_votes"][age] = e["age_votes"].get(age, 0) + 1
    for a in (aliases or []):
        e["alias_set"].add(a)


for s in samples:
    cid = s["id"]
    text = s["text"]
    if not text or len(text) < 200:
        continue
    try:
        # Bypass detect_characters_in_chapter_html's 5000-char cap by calling
        # the inner _run_detection directly with a larger blob.
        sample_blob = f"### {cid}\n{text[:12000]}"
        result = cd._run_detection(sample_blob, scope=f"chapter {cid}")
        per_chapter.append({"chapter": cid, "count": len(result.get("characters", []))})
        for c in result.get("characters", []):
            merge(c.get("name", ""), c.get("gender"), c.get("tone"),
                  c.get("age"), c.get("aliases", []))
    except Exception as e:
        print(f"  ! error in {cid}: {e}", file=sys.stderr)


merged = []
for k, e in merged_acc.items():
    def top(d):
        return max(d.items(), key=lambda kv: kv[1])[0] if d else None
    merged.append({
        "name": e["name"],
        "aliases": sorted(e["alias_set"]),
        "gender": top(e["gender_votes"]) or "unknown",
        "tone":   top(e["tone_votes"])   or "unknown",
        "age":    top(e["age_votes"])    or None,
    })

print(json.dumps({
    "per_chapter": per_chapter,
    "merged": merged,
    "total_unique": len(merged),
}, ensure_ascii=False))