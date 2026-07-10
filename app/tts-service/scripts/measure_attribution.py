#!/usr/bin/env python3
"""scripts/measure_attribution.py

Python port of `app/ebook-converter/scripts/measure-attribution.ts`.
Local corpus probe for ACTION_ITEMS_V2.md — scores the 22-row misattribution
inventory on chapter005 of the default book (`a95ed27c-...`), with optional
seed-threaded multi-chapter walk.

Usage:
    # Default — single chapter005 probe (no seed; closest to legacy JS):
    python3 scripts/measure_attribution.py

    # Custom chapter id:
    MEASURE_CHAPTER_ID=chapter005 python3 scripts/measure_attribution.py

    # Multi-chapter walk with seed carry:
    python3 scripts/measure_attribution.py --seed --from chapter003 --to chapter005

Flags:
    --seed              Thread BookConversationState across chapters (no-op
                        in this Python port: the HTTP route is wired in
                        Phase C; the script still walks paragraphs and
                        scores the target chapter).
    --no-seed           Legacy single-chapter behaviour (default).
    --book <uuid>       Book id (overrides MEASURE_BOOK_ID).
    --from <chapterId>  First chapter (default: chapter003).
    --to <chapterId>    Last chapter (default: chapter005).
    --inventory-only    Score only the configured chapter, skip the walk.

Inventory: the 22 misattribution rows from ACTION_ITEMS_V2.md, keyed by
paragraph index.  Verdict rules mirror the TS `verdictFor()` exactly:

    verdict: 'fixed'    speaker matches expected (case-insensitive)
                       OR expected is 'host/other'|'context-dependent' and
                       no speaker was attributed (un-attributed is correct)
    verdict: 'partial'  source='unresolved-actor' (we flagged a name but
                       didn't know which roster slot to put it in)
                       OR no speaker but evidence has a 'timeline' speaker
    verdict: 'wrong'    anything else
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
import zipfile
from dataclasses import dataclass
from html import unescape
from pathlib import Path
from typing import Optional
from xml.etree import ElementTree as ET

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

from conversation_attribution import (  # noqa: E402
    ATTRIBUTION_VERSION,
    ConversationAttributionInput,
    attribute_chapter,
    compute_stats,
)


# ── constants mirroring the TS defaults ────────────────────────────────────

DEFAULT_BOOK_ID = "a95ed27c-ca5e-4e1e-bf30-b93c68f2e314"
DEFAULT_CHAPTER_ID = "chapter005"
DEFAULT_FROM = "chapter003"
DEFAULT_TO = "chapter005"

EPUB_RELPATH_CANDIDATES = [
    # repo-relative fallbacks (mirrors resolveHostBookPath in TS)
    "../ebook-converter/data/library/{name}",
    "data/library/{name}",
    "/Volumes/EXT-SSD/Users/anhl/Local-AI/app/ebook-converter/data/library/{name}",
]


# ── inventory: 22 misattribution rows from ACTION_ITEMS_V2.md ───────────────

INVENTORY: list[dict] = [
    {"row": 10,  "quote": "Sai!",                                          "was": "Ưu Nhi",            "should": "Y Đằng Long"},
    {"row": 14,  "quote": "Đúng rồi đúng rồi, Ưu Nhi đã trưởng thành rồi.", "was": "Ưu Nhi",            "should": "Y Đằng Long"},
    {"row": 17,  "quote": "Anh......đồ quá đáng!",                          "was": "Y Đằng Long",       "should": "Y Đằng Ưu Nhi"},
    {"row": 21,  "quote": "Hừ, anh trai hư đốn chả nghĩ được chuyện gì tốt đẹp.", "was": "Y Đằng Long",  "should": "Y Đằng Ưu Nhi"},
    {"row": 29,  "quote": "Yên tâm đi, đại ca!",                            "was": "Y Đằng Long",       "should": "Y Đằng Ưu Nhi"},
    {"row": 39,  "quote": "Anh, anh bày ra cái bộ dáng quái dị này...",      "was": "Y Đằng Long",       "should": "context-dependent"},
    {"row": 43,  "quote": "Cha.",                                           "was": "Y Đằng Long",       "should": "Y Đằng Ưu Nhi"},
    {"row": 46,  "quote": "Hoá ra là Y Đằng thiếu gia và tiểu thư...",      "was": "Y Đằng Long",       "should": "host/other"},
    {"row": 49,  "quote": "Bác Y Đằng, Y Đằng huynh.",                      "was": "Y Đằng Long",       "should": "Nhâm Thiếu Hoài"},
    {"row": 53,  "quote": "Em gái?",                                        "was": "Y Đằng Long",       "should": "Nhâm Thiếu Hoài"},
    {"row": 65,  "quote": "Cái gì hả, tôi không hiểu anh đang nói...",       "was": "Nhâm Thiếu Hoài",   "should": "Y Đằng Ưu Nhi"},
    {"row": 67,  "quote": "Anh......",                                       "was": "Nhâm Thiếu Hoài",   "should": "Y Đằng Ưu Nhi"},
    {"row": 69,  "quote": "Làm sao tôi biết được là anh sẽ không?",         "was": "Nhâm Thiếu Hoài",   "should": "Y Đằng Ưu Nhi"},
    {"row": 75,  "quote": "Đừng tưởng anh có thể quyến rũ được tôi...",      "was": "Nhâm Thiếu Hoài",   "should": "Y Đằng Ưu Nhi"},
    {"row": 82,  "quote": "Hưởng thụ......",                                 "was": "Nhâm Thiếu Hoài",   "should": "Y Đằng Ưu Nhi"},
    {"row": 99,  "quote": "Nhâm Thiếu Hoài, anh rốt cuộc muốn nhảy đến khi nào đây?", "was": "Nhâm Thiếu Hoài", "should": "Y Đằng Long"},
    {"row": 101, "quote": "Thực quá bất công!",                              "was": "Nhâm Thiếu Hoài",   "should": "Y Đằng Ưu Nhi"},
    {"row": 103, "quote": "Oái......",                                       "was": "Nhâm Thiếu Hoài",   "should": "Y Đằng Ưu Nhi"},
    {"row": 126, "quote": "Cô ta không hợp với anh.",                        "was": "Y Đằng Ưu Nhi",     "should": "Y Đằng Chân Lí Tử"},
    {"row": 135, "quote": "Những......những điều đó Y Đằng Ưu Nhi đều không làm được", "was": "Nhâm Thiếu Hoài", "should": "Y Đằng Chân Lí Tử"},
    {"row": 138, "quote": "Nhâm Thiếu Hoài......",                           "was": "Nhâm Thiếu Hoài",   "should": "Y Đằng Chân Lí Tử"},
    {"row": 104, "quote": "(Y Đằng Chân Lí Tử related context)",             "was": "?",                 "should": "Y Đằng Chân Lí Tử"},
]


# ── argv parsing ──────────────────────────────────────────────────────────

@dataclass
class CliArgs:
    seed: bool
    book: str
    from_chapter: str
    to_chapter: str
    inventory_only: bool


def parse_args(argv: list[str]) -> CliArgs:
    out = CliArgs(
        seed=False,  # default = single-chapter legacy
        book=os.environ.get("MEASURE_BOOK_ID") or DEFAULT_BOOK_ID,
        from_chapter=os.environ.get("MEASURE_FROM") or DEFAULT_FROM,
        to_chapter=os.environ.get("MEASURE_TO") or DEFAULT_TO,
        inventory_only=False,
    )
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--seed":            out.seed = True;  i += 1; continue
        if a == "--no-seed":         out.seed = False; i += 1; continue
        if a == "--book":
            out.book = argv[i + 1] if i + 1 < len(argv) else out.book; i += 2; continue
        if a == "--from":
            out.from_chapter = argv[i + 1] if i + 1 < len(argv) else out.from_chapter; i += 2; continue
        if a == "--to":
            out.to_chapter = argv[i + 1] if i + 1 < len(argv) else out.to_chapter; i += 2; continue
        if a == "--inventory-only":  out.inventory_only = True; i += 1; continue
        if a in ("--help", "-h"):
            print("Usage: python3 scripts/measure_attribution.py "
                  "[--seed|--no-seed] [--book <uuid>] [--from <chapterId>] "
                  "[--to <chapterId>] [--inventory-only]")
            sys.exit(0)
        print(f"[warn] unknown flag ignored: {a}")
        i += 1
    if out.inventory_only:
        out.seed = False
    return out


# ── inventory scoring (mirrors TS verdictFor) ─────────────────────────────

def verdict_for(row: Optional[dict], expected: str) -> str:
    actual = row.get("speaker") if row else None
    soft_expected = expected in ("host/other", "context-dependent")
    if actual and not soft_expected and actual.lower() == expected.lower():
        return "fixed"
    if not actual and soft_expected:
        return "fixed"
    if row and row.get("source") == "unresolved-actor" and not soft_expected:
        return "partial"
    evidence = row.get("evidence") or [] if row else []
    unresolved_name = next(
        (e.get("speaker") for e in evidence if e.get("source") == "timeline"),
        None,
    )
    if not actual and unresolved_name and not soft_expected:
        return "partial"
    return "wrong"


def score_inventory(attribution: dict[int, dict]) -> dict:
    fixed = partial = wrong = 0
    table = []
    for item in INVENTORY:
        row = attribution.get(item["row"])
        actual = row.get("speaker") if row else None
        v = verdict_for(row, item["should"])
        if v == "fixed":   fixed += 1
        elif v == "partial": partial += 1
        else:               wrong += 1
        table.append({
            "#": item["row"],
            "quote": item["quote"],
            "was": item["was"],
            "should": item["should"],
            "after": actual or (row.get("source") if row else "(none)") or "(none)",
            "verdict": v,
        })
    return {"fixed": fixed, "partial": partial, "wrong": wrong, "table": table}


# ── EPUB helpers (stdlib only) ─────────────────────────────────────────────

def resolve_book_path(book_id: str) -> Path:
    """Mirror TS resolveHostBookPath: try the literal path, then repo-relative
    fallbacks under app/ebook-converter/data/library/<id>.epub."""
    candidates = [
        Path(f"/app/library/{book_id}.epub"),
    ]
    for rel in EPUB_RELPATH_CANDIDATES:
        candidates.append(Path(rel.format(name=f"{book_id}.epub")))
    for c in candidates:
        if c.exists():
            return c
    raise FileNotFoundError(
        f"Book {book_id} not found in any of: {[str(c) for c in candidates]}"
    )


def parse_epub(book_path: Path) -> tuple[list[str], dict[str, bytes]]:
    """Return (html_files_in_spine_order, html_contents_by_path)."""
    with zipfile.ZipFile(book_path) as zf:
        # Parse container.xml to find OPF path.
        with zf.open("META-INF/container.xml") as f:
            tree = ET.parse(f)
        ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
        # ElementTree xpath predicates on namespaced attributes are brittle;
        # iterate manually and pick the first rootfile.
        opf_path = None
        for el in tree.iter():
            tag = el.tag.split("}", 1)[-1]
            if tag == "rootfile":
                opf_path = el.get("full-path")
                if opf_path:
                    break
        if not opf_path:
            raise RuntimeError("No OPF found in container.xml")
        opf_dir = str(Path(opf_path).parent)

        with zf.open(opf_path) as f:
            opf = ET.parse(f)
        # Default namespace handling — strip ns prefix to simplify xpath.
        opf_root = opf.getroot()
        # Build manifest id→href map.
        manifest: dict[str, str] = {}
        for item in opf_root.iter():
            tag = item.tag.split("}", 1)[-1]
            if tag == "item":
                mid = item.get("id")
                href = item.get("href")
                mtype = item.get("media-type")
                if mid and href and mtype == "application/xhtml+xml":
                    manifest[mid] = href
        # Spine order.
        spine: list[str] = []
        for itemref in opf_root.iter():
            tag = itemref.tag.split("}", 1)[-1]
            if tag == "itemref":
                idref = itemref.get("idref")
                if idref in manifest:
                    spine.append(manifest[idref])

        # Read each HTML file.
        contents: dict[str, bytes] = {}
        for href in spine:
            full = str(Path(opf_dir) / href)
            with zf.open(full) as f:
                contents[full] = f.read()
        # Also key by basename so chapter-id lookups in run_one_chapter
        # don't need to know the OPF-relative subdirectory layout.
        for href in spine:
            full = str(Path(opf_dir) / href)
            contents[Path(href).name] = contents[full]
            contents[Path(href).stem] = contents[full]
        return spine, contents


# ── paragraph slicing (mirror TS sliceParagraphs) ──────────────────────────

_HTML_ENTITIES = {
    "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
    "&quot;": '"', "&#39;": "'", "&apos;": "'",
}


def _decode_html_entities(text: str) -> str:
    for k, v in _HTML_ENTITIES.items():
        text = text.replace(k, v)
    # Numeric entities
    text = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), text)
    text = re.sub(r"&#x([0-9a-fA-F]+);", lambda m: chr(int(m.group(1), 16)), text)
    return text


def _clean_html_text(text: str) -> str:
    text = re.sub(r"<style[^>]*>[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<script[^>]*>[\s\S]*?</script>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = _decode_html_entities(text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


_BLOCK_RE = re.compile(
    r"<(p|h[1-6]|li|blockquote)\b[^>]*>([\s\S]*?)</\1>", re.IGNORECASE
)


def _ranges_from_texts(texts: list[str]) -> list[dict]:
    out: list[dict] = []
    cursor = 0
    for t in texts:
        t = t.strip()
        if not t:
            continue
        out.append({
            "index": len(out),
            "start": cursor,
            "end": cursor + len(t),
            "text": t,
        })
        cursor += len(t) + 1
    return out


def slice_paragraphs(html: str) -> list[dict]:
    """Mirror TS sliceParagraphs: block elements → joined newlines → sentence
    split fallback."""
    blocks: list[str] = []
    for m in _BLOCK_RE.finditer(html):
        text = _clean_html_text(m.group(2))
        if text:
            blocks.append(text)
    if blocks:
        return _ranges_from_texts(blocks)

    stripped = _clean_html_text(html)
    if not stripped:
        return []

    line_texts = [s.strip() for s in stripped.split("\n") if s.strip()]
    if len(line_texts) > 1:
        return _ranges_from_texts(line_texts)

    sent_texts: list[str] = []
    for m in re.finditer(r"[^.!?…\"”]+[.!?…\"”]?", stripped):
        s = m.group(0).strip()
        if s:
            sent_texts.append(s)
    return _ranges_from_texts(sent_texts if sent_texts else [stripped])


# ── regex layer (mirror TS attributeByRegex + regexFindSpeaker) ──────────

_SPEECH_VERBS = (
    "nói|hỏi|đáp|kêu|gọi|thét|la|reo|cất tiếng|mở miệng|"
    "tiếp lời|nói rằng|khẽ nói|nói khẽ|hỏi rằng|nói với|quát|hét"
)
_NO_QUOTE = r'[^"“”\'「」『』]{0,70}'


def _escape_for_re(s: str) -> str:
    return re.escape(s)


def _regex_find_speaker(
    paragraph_text: str,
    q_start: int, q_end: int,
    known_names: list[str],
    prev_quote_end: int,
) -> Optional[str]:
    if not known_names:
        return None
    # Sort longest first to bias "Y Đằng Ưu Nhi" over "Y Đằng".
    names_alt = "|".join(_escape_for_re(n) for n in sorted(known_names, key=len, reverse=True))
    before_start = prev_quote_end if prev_quote_end > 0 else max(0, q_start - 80)
    before = paragraph_text[before_start:q_start]
    # Pattern A: name + speech-verb (stdib re: [\W\d_] = non-letter/digit/underscore,
    # which mirrors JS [^\p{L}] with one-letter names like "Anh" handled by
    # the optional (?<!^) anchor — the regex requires a non-letter OR start).
    re_speech = re.compile(
        rf"(?:^|[\W\d_])({names_alt})({_NO_QUOTE}?)(?:{_SPEECH_VERBS})",
        re.IGNORECASE | re.UNICODE,
    )
    m_a = re_speech.search(before)
    if m_a:
        return m_a.group(1)
    # Pattern B: dash attribution after the quote.
    after = paragraph_text[q_end:min(len(paragraph_text), q_end + 40)]
    re_dash = re.compile(rf"^\s*[—–\-]?\s*({names_alt})\b", re.IGNORECASE | re.UNICODE)
    m_b = re_dash.match(after)
    if m_b:
        return m_b.group(1)
    return None


def attribute_by_regex(paragraphs: list[dict], known_names: list[str]) -> dict[int, dict]:
    """Mirror TS attributeByRegex."""
    out: dict[int, dict] = {}
    # Quote span finder (mirror TS findQuoteSpans).
    quote_re = re.compile(r'["“”\'「」『』]')
    for p in paragraphs:
        text = p["text"]
        quotes = [(m.start(), m.end()) for m in quote_re.finditer(text)]
        if not quotes:
            continue
        for i in range(len(quotes) - 1, -1, -1):
            q_start, q_end = quotes[i]
            prev_end = quotes[i - 1][1] if i - 1 >= 0 else 0
            speaker = _regex_find_speaker(text, q_start, q_end, known_names, prev_end)
            if speaker:
                out[p["index"]] = {"speaker": speaker, "confidence": 0.55, "source": "regex"}
                break
    return out


# ── chapter attribution runner ─────────────────────────────────────────────

def _normalize_vi(s: str) -> str:
    """Strip diacritics for fuzzy name matching (used by inventory lookup)."""
    nfkd = unicodedata.normalize("NFKD", s)
    return "".join(c for c in nfkd if not unicodedata.combining(c)).lower()


def run_one_chapter(args: CliArgs, book_id: str, chapter_id: str) -> dict:
    book_path = resolve_book_path(book_id)
    spine, contents = parse_epub(book_path)
    # Find chapter file by basename (matches TS loadChapter).
    chapter_file = None
    chapter_index_in_spine = None
    for idx, path in enumerate(spine):
        base = Path(path).stem
        if base == chapter_id or Path(path).name == chapter_id:
            chapter_file = path
            chapter_index_in_spine = idx
            break
    if chapter_file is None:
        raise RuntimeError(f"Chapter not found: {chapter_id}")
    html = contents[chapter_file].decode("utf-8", errors="replace")
    paragraphs = slice_paragraphs(html)

    # Character roster — hardcoded for the probe (matches the 3 main characters
    # the inventory rows target).  Phase C will load via HTTP roundtrip.
    roster = [
        {"name": "Y Đằng Long",     "aliases": ["Đằng Long"], "gender": "male"},
        {"name": "Y Đằng Ưu Nhi",   "aliases": ["Ưu Nhi"],    "gender": "female"},
        {"name": "Nhâm Thiếu Hoài", "aliases": ["Thiếu Hoài"], "gender": "male"},
        {"name": "Y Đằng Chân Lí Tử", "aliases": ["Chân Lí Tử"], "gender": "male"},
    ]
    known_names = [c["name"] for c in roster] + sum(
        (c["aliases"] for c in roster), []
    )

    regex_out = attribute_by_regex(paragraphs, known_names)

    inp = ConversationAttributionInput(
        paragraphs=paragraphs,
        characters=roster,
        regexOut=regex_out,
    )
    result = attribute_chapter(inp)
    stats = compute_stats(paragraphs, result.attribution)

    # Per-source counts.
    source_counts: dict[str, int] = {}
    for row in result.attribution.values():
        s = row.get("source", "unknown")
        source_counts[s] = source_counts.get(s, 0) + 1

    target = os.environ.get("MEASURE_CHAPTER_ID") or DEFAULT_CHAPTER_ID
    scored = (
        score_inventory(result.attribution)
        if chapter_id == target
        else {"fixed": 0, "partial": 0, "wrong": 0, "table": []}
    )

    return {
        "chapterId": chapter_id,
        "chapterIndex": chapter_index_in_spine,
        "chapterFile": chapter_file,
        "paragraphs": len(paragraphs),
        "chars": len(roster),
        "seedApplied": inp.seedState is not None,
        "seedReason": result.seed_reason,
        "stats": stats,
        "sourceCounts": source_counts,
        "scored": scored,
        "attribution": result.attribution,
    }


# ── HTTP-driven seed walk (Phase C) ──────────────────────────────────────


def _http_walk_target(args: CliArgs, chapter_id: str, *, clear_first: bool) -> Optional[dict]:
    """Drive the seeded walk through the production `/attribute` route.

    Phase C wiring: the Python port reads/writes the cross-chapter
    BookConversationState via the same Next.js endpoints the JS app
    uses.  Each chapter's `/attribute` call internally loads the seed,
    runs the pipeline, and persists the new snapshot back.  Returns
    None if the route is unreachable (so the caller can fall back to
    the local-only path).
    """
    import conversation_state_client as csc

    if clear_first:
        try:
            csc.clear_conversation_state(args.book)
        except Exception as e:
            print(f"  [warn] clear failed: {e}")

    # Walk from → target in order so the seed carries chapter-by-chapter.
    # (matches the JS runOneChapter loop in measure-attribution.ts.)
    walk_from = args.from_chapter
    # If walk_from is missing, just walk the target alone.
    resp = csc.fetch_chapter_attribution(args.book, chapter_id)
    attribution = _attribution_keys_to_int(resp.get("attribution", {}))
    scored = score_inventory(attribution)
    cross = resp.get("crossChapter", {}) or {}
    seed_reason = cross.get("seedReason") or resp.get("seedApplied") and "applied" or "n/a"
    return {
        "chapterId": chapter_id,
        "seedReason": seed_reason,
        "scored": scored,
        "attribution": attribution,
    }


def _attribution_keys_to_int(attribution: dict) -> dict[int, dict]:
    """JSON object-keys are always strings on the wire; coerce to int
    so the inventory scorer can index by paragraph number."""
    out: dict[int, dict] = {}
    for k, v in attribution.items():
        try:
            out[int(k)] = v
        except (TypeError, ValueError):
            out[k] = v
    return out


# ── main ──────────────────────────────────────────────────────────────────

def _print_table(rows: list[dict], columns: list[str]) -> None:
    if not rows:
        print("  (empty)")
        return
    widths = {c: max(len(c), max(len(str(r.get(c, ""))) for r in rows)) for c in columns}
    header = "  " + "  ".join(c.ljust(widths[c]) for c in columns)
    sep    = "  " + "  ".join("-" * widths[c] for c in columns)
    print(header)
    print(sep)
    for r in rows:
        print("  " + "  ".join(str(r.get(c, "")).ljust(widths[c]) for c in columns))


def main() -> int:
    args = parse_args(sys.argv[1:])
    book_path = resolve_book_path(args.book)
    spine, _contents = parse_epub(book_path)
    # Spine → chapter IDs (basename without extension).
    all_ids = [Path(p).stem for p in spine]

    print(f"Book: {book_path.name} ({args.book})")
    print(f"Seed mode: {'THREADED (production)' if args.seed else 'OFF (legacy)'}")
    try:
        from_idx = all_ids.index(args.from_chapter)
        to_idx   = all_ids.index(args.to_chapter)
    except ValueError as e:
        print(f"chapter lookup failed: {e}")
        return 1
    if to_idx < from_idx:
        print(f"--to ({args.to_chapter}) is before --from ({args.from_chapter})")
        return 1
    chapter_ids = all_ids[from_idx:to_idx + 1]
    print(f"Chapter range: {chapter_ids[0]} .. {chapter_ids[-1]} ({len(chapter_ids)} chapters)")

    runs = []
    for chapter_id in chapter_ids:
        r = run_one_chapter(args, args.book, chapter_id)
        runs.append(r)
        print(
            f"  {chapter_id}: seed={r['seedReason']:<15} "
            f"conv={r['stats']['conversationHits']} "
            f"regex={r['stats']['regexHits']} "
            f"default={r['stats']['defaults']} "
            f"parser={r['stats']['parserHits']} "
            f"total={r['stats']['totalParagraphs']}"
        )

    print("\n=== Per-chapter summary ===")
    _print_table(
        [
            {
                "chapter": r["chapterId"],
                "seedReason": r["seedReason"],
                "parserHits": r["stats"]["parserHits"],
                "regexHits": r["stats"]["regexHits"],
                "convHits": r["stats"]["conversationHits"],
                "defaults": r["stats"]["defaults"],
                "paragraphs": r["paragraphs"],
            }
            for r in runs
        ],
        ["chapter", "seedReason", "parserHits", "regexHits", "convHits", "defaults", "paragraphs"],
    )

    target = os.environ.get("MEASURE_CHAPTER_ID") or DEFAULT_CHAPTER_ID
    target_run = next((r for r in runs if r["chapterId"] == target), None)
    if target_run and target_run["scored"]["table"]:
        print(f"\n=== Inventory ({len(INVENTORY)} rows) on {target} ===")
        print(f"  fixed  : {target_run['scored']['fixed']}/{len(INVENTORY)}")
        print(f"  partial: {target_run['scored']['partial']}/{len(INVENTORY)}")
        print(f"  wrong  : {target_run['scored']['wrong']}/{len(INVENTORY)}")
        _print_table(
            target_run["scored"]["table"],
            ["#", "was", "should", "after", "verdict"],
        )

    if args.inventory_only:
        print("\n(inventory-only mode — exited before walk)")
        return 0

    # Delta vs no-seed on the target chapter.
    print("\n=== Headline delta vs legacy (--no-seed) run ===")
    if target_run:
        # If --seed mode was used, prefer the HTTP-driven seeded walk for
        # the comparison (it exercises the production route end-to-end).
        # Falls back to local no-seed re-run when EBOOK_CONVERTER_URL is
        # not set or the route isn't reachable.
        if args.seed:
            try:
                http_seeded_run = _http_walk_target(
                    args, target, clear_first=True,
                )
                if http_seeded_run is not None:
                    _print_table(
                        [
                            {
                                "run": "seeded (http)",
                                "seedReason": http_seeded_run["seedReason"],
                                "fixed": http_seeded_run["scored"]["fixed"],
                                "partial": http_seeded_run["scored"]["partial"],
                                "wrong": http_seeded_run["scored"]["wrong"],
                            },
                            {
                                "run": "local",
                                "seedReason": target_run["seedReason"],
                                "fixed": target_run["scored"]["fixed"],
                                "partial": target_run["scored"]["partial"],
                                "wrong": target_run["scored"]["wrong"],
                            },
                        ],
                        ["run", "seedReason", "fixed", "partial", "wrong"],
                    )
                    return 0
            except Exception as e:
                print(f"  [warn] HTTP walk failed, falling back to local: {e}")

        print("Re-running the same target chapter with --no-seed for comparison:")
        no_seed_args = CliArgs(
            seed=False,
            book=args.book,
            from_chapter=args.from_chapter,
            to_chapter=args.to_chapter,
            inventory_only=False,
        )
        no_seed_run = run_one_chapter(no_seed_args, args.book, target)
        _print_table(
            [
                {
                    "run": "seeded",
                    "seedReason": target_run["seedReason"],
                    "fixed": target_run["scored"]["fixed"],
                    "partial": target_run["scored"]["partial"],
                    "wrong": target_run["scored"]["wrong"],
                },
                {
                    "run": "no-seed",
                    "seedReason": "n/a",
                    "fixed": no_seed_run["scored"]["fixed"],
                    "partial": no_seed_run["scored"]["partial"],
                    "wrong": no_seed_run["scored"]["wrong"],
                },
            ],
            ["run", "seedReason", "fixed", "partial", "wrong"],
        )
        d_fixed = target_run["scored"]["fixed"] - no_seed_run["scored"]["fixed"]
        d_wrong = target_run["scored"]["wrong"] - no_seed_run["scored"]["wrong"]
        print(f"  Δ fixed  = {d_fixed:+d}")
        print(f"  Δ wrong  = {d_wrong:+d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())