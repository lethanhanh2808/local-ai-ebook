"""
Character detector — uses OMLX (local LLM) to extract character names
from an EPUB and estimate gender/tone for each.

Usage:
  python character_detector.py <book.epub> [model_name]
  # prints JSON to stdout

The model name is optional — when provided (as the 2nd CLI arg), it
overrides the OMLX_MODEL env var. The caller (Next.js route) reads the
user-selected model from the Settings DB and passes it explicitly so
the user always gets their chosen model, not whatever env var happens
to be set.

Or importable:
  from character_detector import detect_characters
  result = detect_characters(book_path, max_chapters=10, model="…")
"""
import json
import html
import os
import posixpath
import re
import sys
import zipfile
import time
from typing import Any
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

import httpx

# Vietnamese-aware name normalization (diacritic + tone folding).
# `vig2p` is an optional dep — vi_g2p falls back gracefully if missing.
try:
    from vi_g2p import name_canonical as _vi_canonical, g2p_match as _vi_match
    _HAS_VI_G2P = True
except Exception:  # pragma: no cover
    _vi_canonical = lambda s: (s or "").strip().lower()  # type: ignore
    _vi_match = lambda a, b: (a or "").strip().lower() == (b or "").strip().lower()  # type: ignore
    _HAS_VI_G2P = False

OMLX_URL = os.environ.get("OMLX_BASE_URL", "http://127.0.0.1:8080/v1").rstrip("/")
OMLX_KEY = os.environ.get("OMLX_API_KEY", "")
# Model resolution priority:
#   1. CLI arg  (explicit caller intent — used by the Next.js route)
#   2. OMLX_MODEL env var  (fallback for direct CLI usage)
#   3. "" (empty) — lets OMLX pick its server-side default instead of
#      throwing "Model 'default' not found".
_OMLX_MODEL_CLI = sys.argv[2] if len(sys.argv) >= 3 else ""
OMLX_MODEL = _OMLX_MODEL_CLI or os.environ.get("OMLX_MODEL", "")
MAX_CHAPTER_CHARS = 3000   # total sample size to send to OMLX
MAX_CHAPTERS = 5           # number of chapters to sample


def extract_chapter_samples(epub_path: str, max_chapters: int = MAX_CHAPTERS,
                            max_chars: int = MAX_CHAPTER_CHARS) -> list[dict]:
    """Return up to N (chapter_name, plain_text) pairs sampled across the book."""
    if max_chapters <= 0 or max_chars <= 0:
        return []
    with zipfile.ZipFile(epub_path) as z:
        names = z.namelist()
        opf = next((n for n in names if n.lower().endswith(".opf")), None)
        if not opf:
            return []
        opf_content = z.read(opf)
        opf_dir = opf.rsplit("/", 1)[0] if "/" in opf else ""

        # XML attribute order is not significant. Regex parsing previously
        # missed valid manifests that wrote href before id or used single
        # quotes/namespaces, causing "No chapters found" for healthy EPUBs.
        try:
            root = ElementTree.fromstring(opf_content)
        except ElementTree.ParseError:
            return []
        item_map: dict[str, str] = {}
        spine_ids: list[str] = []
        for elem in root.iter():
            local = elem.tag.rsplit("}", 1)[-1]
            if local == "item":
                item_id, href = elem.get("id"), elem.get("href")
                if item_id and href:
                    item_map[item_id] = href
            elif local == "itemref":
                idref = elem.get("idref")
                if idref:
                    spine_ids.append(idref)

        # Sample evenly across the full spine, including the last chapter.
        samples = []
        sample_count = min(max_chapters, len(spine_ids))
        if sample_count == 0:
            return []
        if sample_count == 1:
            selected_ids = [spine_ids[0]]
        else:
            selected_ids = [
                spine_ids[(i * (len(spine_ids) - 1)) // (sample_count - 1)]
                for i in range(sample_count)
            ]
        per_sample_chars = max(1, max_chars // sample_count)

        for sid in selected_ids:
            href = item_map.get(sid)
            if not href:
                continue
            href_path = unquote(urlsplit(href).path).replace("\\", "/")
            chapter_path = posixpath.normpath(
                posixpath.join(opf_dir, href_path) if opf_dir else href_path
            )
            if chapter_path not in names:
                # try without opf_dir
                if href_path in names:
                    chapter_path = href_path
                else:
                    continue
            raw = z.read(chapter_path).decode("utf-8", errors="ignore")
            text = re.sub(r"<[^>]+>", " ", raw)
            text = re.sub(r"\s+", " ", html.unescape(text)).strip()
            if text:
                samples.append({"id": sid, "title": sid, "text": text[:per_sample_chars]})
    return samples


def call_omlx(system: str, user: str, timeout: float = 120.0) -> str:
    """Call OMLX chat completions and return the assistant text."""
    body = {
        "model": OMLX_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.1,
        "max_tokens": 1500,
    }
    headers = {"Content-Type": "application/json"}
    if OMLX_KEY:
        headers["Authorization"] = f"Bearer {OMLX_KEY}"

    # OMLX_INSECURE_TLS=1 mirrors the app's `aiAllowInsecureTls` Settings flag:
    # skip TLS certificate verification. Needed for self-signed / corporate-CA
    # gateways (e.g. a custom OpenAI-compatible endpoint behind an internal CA)
    # where Python's httpx would otherwise raise CERTIFICATE_VERIFY_FAILED.
    verify = not os.environ.get("OMLX_INSECURE_TLS", "").strip() in ("1", "true", "yes")
    with httpx.Client(timeout=timeout, verify=verify) as client:
        r = client.post(f"{OMLX_URL}/chat/completions", json=body, headers=headers)
    if r.status_code != 200:
        raise RuntimeError(f"OMLX error {r.status_code}: {r.text[:300]}")
    data = r.json()
    return data["choices"][0]["message"]["content"]


def detect_characters(epub_path: str, max_chapters: int = MAX_CHAPTERS,
                     max_chars: int = MAX_CHAPTERS * 2000) -> dict:
    """
    Returns:
      {
        "characters": [
          { "name": str, "aliases": [str], "gender": "male|female|unknown",
            "tone": "calm|angry|cheerful|...|unknown",
            "lines_estimate": int,
            "sample_lines": [str, ...]
          }
        ],
        "total_dialogue_lines": int,
        "narrator_gender_hint": "male|female|unknown",
        "language": "vi|en|...",
        "summary": str
      }
    """
    samples = extract_chapter_samples(epub_path, max_chapters=max_chapters, max_chars=max_chars)
    if not samples:
        return {"characters": [], "total_dialogue_lines": 0, "language": "unknown",
                "narrator_gender_hint": "unknown", "summary": "No chapters found"}

    sample_blob = "\n\n---\n\n".join(
        f"### {s['id']}\n{s['text']}" for s in samples
    )[:max_chars]
    return _run_detection(sample_blob, scope=f"{len(samples)} chapters")


def detect_characters_in_chapter_html(html_text: str, chapter_id: str = "chapter") -> dict:
    """Run character detection on a SINGLE chapter's HTML.

    Used for lazy per-chapter detection: when the user starts TTS on a new
    chapter, we run detection just on that chapter and merge the results
    into the book's character table. Much faster than re-scanning the
    whole book for every chapter change.

    Returns the same JSON shape as `detect_characters`.
    """
    text = re.sub(r"<[^>]+>", " ", html_text)
    text = re.sub(r"\s+", " ", html.unescape(text)).strip()
    if not text:
        return {"characters": [], "total_dialogue_lines": 0,
                "language": "unknown", "narrator_gender_hint": "unknown",
                "summary": "Empty chapter content"}

    # Cap to ~5000 chars — enough for 2-3 pages of typical Vietnamese prose,
    # which is plenty to find recurring characters.
    sample_blob = f"### {chapter_id}\n{text[:5000]}"
    return _run_detection(sample_blob, scope=f"chapter {chapter_id}")


def _run_detection(sample_blob: str, scope: str) -> dict:
    """Shared core — given text, build prompt, call OMLX, parse JSON."""
    # Strong JSON-only prompt — reasoning models often ignore plain "return JSON" instructions.
    system_prompt = (
        "/no_think\n"
        "You output ONLY a JSON object. No reasoning, no prose, no markdown.\n"
        "Analyze the Vietnamese-novel chapters below and extract every distinct character "
        "who has spoken dialogue (including background voices like 'tiếng la', "
        "'người qua đường', 'ông lão', 'cô gái' — call these 'role':'crowd').\n"
        "IMPORTANT — extract characters even when their name NEVER appears in the dialogue "
        "they speak. In Vietnamese cổ trang / huyền huyễn, royal/court characters are usually "
        "referred to ONLY by title/pronoun in their own speech:\n"
        "  - 'trẫm' / 'trẫm đệ' / 'trẫm mệnh' → the EMPEROR (Hoàng Thượng). Find his proper "
        "    name in the narration (e.g. 'Hoàng đế Khương Thiên Thái tuyên ...') and emit it "
        "    as the character's name. If the narration never names him, fall back to a "
        "    synthesized identity like 'Hoàng Thượng' or 'Bệ Hạ' as the name.\n"
        "  - 'thần' / 'thần thiếp' / 'thần nữ' / 'thần đây' → a SUBJECT / consort / official "
        "    addressing the Emperor or a superior. Match by surrounding narration ('Đại Hạ Lý "
        "    Mục Thanh quỳ xuống ...') to the proper name. If unnamed, use their title.\n"
        "  - 'lão phu' / 'lão tổ' / 'lão gia' / 'lão tông' → an ELDER patriarch / sect leader.\n"
        "  - 'bần tăng' / 'bần đạo' → a MONK speaker.\n"
        "  - 'tại hạ' / 'tại hạ người' → a wandering martial-arts / jianghu character.\n"
        "  - 'muội' / 'tỷ tỷ' / 'ca ca' / 'đệ đệ' / 'nương' / 'đại ca' → sibling-style "
        "    address; the speaker's identity must come from the surrounding narration.\n"
        "For each character output:\n"
        "  name (string — proper name from narration, OR a stable synthesized identity like "
        "    'Hoàng Thượng' / 'Lão Tổ Vạn Kiếm' if no name is ever given),\n"
        "  pronouns (array of strings — the speaker-pronoun(s) this character uses: "
        "    ['trẫm', 'thiếp'] for the Emperor+consort pair, ['lão phu'] for the elder, etc.),\n"
        "  aliases (array of strings — every variant of the proper name you saw in narration:\n"
        "    full name, given name only, surname only, plus any title like 'Bệ Hạ'),\n"
        "  gender (male|female|unknown), age (young|mature|old|unknown),\n"
        "  tone (calm|cheerful|cold|mysterious|serious|angry|sad|warm|unknown),\n"
        "  role (main|supporting|minor|crowd — main=protagonist/antagonist with lots of "
        "    dialogue, supporting=recurring side character, minor=appears briefly, "
        "    crowd=anonymous background voice),\n"
        "  lines_estimate (integer), sample_lines (array of 1-2 short example lines).\n"
        "Also output: narrator_gender_hint (male|female|unknown), language (vi|en|...), "
        "total_dialogue_lines (integer), summary (1-2 short sentences).\n"
        "Return JSON now, no commentary."
    )
    user_prompt = (
        "Vietnamese-novel excerpts (return JSON only):\n\n"
        f"{sample_blob}\n\n"
        "Output (JSON only, starting with { and ending with }):"
    )

    raw = call_omlx(system_prompt, user_prompt, timeout=180.0)
    # Try multiple JSON-extraction strategies — reasoning models put JSON after prose.
    data = _parse_json_anywhere(raw)

    if "characters" not in data or not isinstance(data.get("characters"), list):
        # Fallback: regex-extract character names from the raw text + infer metadata.
        # BUGFIX 2026-07-11: tag the result with `source = "regex-fallback"`
        # so the UI can warn the user that the LLM path produced nothing
        # parseable. Without this tag the user sees "9 nhân vật" with garbage
        # names and no clue why.
        names = _regex_extract_names(raw)
        if names:
            meta = _extract_metadata_from_prose(raw, names)
            data = {
                "characters": [
                    {
                        "name": n,
                        "aliases": [],
                        "gender": meta[n]["gender"],
                        "age": meta[n]["age"],
                        "role": meta[n]["role"],
                        "tone": meta[n]["tone"],
                        "lines_estimate": 0,
                        "sample_lines": meta[n]["sample_lines"],
                    } for n in names[:30]
                ],
                "narrator_gender_hint": "unknown",
                "language": "vi",
                "total_dialogue_lines": 0,
                "summary": f"Fallback regex extraction ({len(names)} names from {scope}).",
                "source": "regex-fallback",
            }
        else:
            return {
                "characters": [], "total_dialogue_lines": 0,
                "language": "unknown", "narrator_gender_hint": "unknown",
                "summary": f"Detection failed: could not parse JSON or names from {scope}. Raw: {raw[:300]}",
                "raw": raw[:2000],
                "source": "failed",
            }

    # Ensure each character has the required fields
    cleaned = []
    allowed_tones = {"calm", "cheerful", "cold", "mysterious", "serious", "angry", "sad", "warm", "unknown"}
    for c in data.get("characters", []):
        if not isinstance(c, dict): continue
        name = c.get("name") or c.get("character") or ""
        name = str(name).strip().strip(".,;:\"'")
        if not name or len(name) > 60: continue
        # Normalize role
        role = str(c.get("role", "supporting")).strip().lower()
        if role not in ("main", "supporting", "minor", "crowd"):
            role = "supporting"
        # Normalize age
        age = str(c.get("age", "unknown")).strip().lower()
        if age not in ("young", "mature", "old"):
            age = "unknown"
        raw_aliases = c.get("aliases") if isinstance(c.get("aliases"), list) else []
        aliases: list[str] = []
        seen_aliases = {_vi_canonical(name)}
        for alias in raw_aliases:
            if not isinstance(alias, str):
                continue
            value = alias.strip().strip(".,;:\"'")
            key = _vi_canonical(value)
            if not value or len(value) > 60 or not key or key in seen_aliases:
                continue
            seen_aliases.add(key)
            aliases.append(value)
            if len(aliases) >= 8:
                break
        tone = str(c.get("tone", "unknown")).strip().lower()
        if tone not in allowed_tones:
            tone = "unknown"
        raw_samples = c.get("sample_lines") if isinstance(c.get("sample_lines"), list) else []
        # BUGFIX 2026-07-11: name-marker overrides. When the LLM leaves
        # gender/age/role as "unknown" but the Vietnamese name itself
        # carries an unambiguous title ("Cửu Thiên Huyền Nữ" → female,
        # "Phù Quang Thánh Vương" → male/mature/main), trust the marker.
        # We never DOWNGRADE an LLM-confirmed value to "unknown" — only
        # fill gaps. Marker-derived main/royal is preferred over the LLM's
        # default "supporting" only when the LLM didn't specify a role.
        llm_gender = c.get("gender")
        gender = llm_gender if llm_gender in ("male", "female", "unknown") else "unknown"
        inferred = _infer_metadata_from_name(name)
        if gender == "unknown" and inferred["gender"] != "unknown":
            gender = inferred["gender"]
        if age == "unknown" and inferred["age"] != "unknown":
            age = inferred["age"]
        # Role: only override when LLM didn't pick one of the canonical
        # values. The marker-based "main" is reserved for titles that are
        # clearly protagonists (Vương / Đế / Huyền Nữ / etc.).
        llm_role = str(c.get("role", "")).strip().lower()
        if llm_role not in ("main", "supporting", "minor", "crowd"):
            role = inferred["role"]
        cleaned.append({
            "name": name,
            "aliases": aliases,
            "gender": gender,
            "age": age,
            "tone": tone,
            "role": role,
            "lines_estimate": _safe_nonnegative_int(c.get("lines_estimate")),
            "sample_lines": [s.strip()[:240] for s in raw_samples if isinstance(s, str) and s.strip()][:2],
        })

    # ── Merge near-duplicate names (OCR-degraded variants, LLM re-spellings) ──
    # "Tuấn Ngọc", "Tuan Ngoc", "TUẤN NGỌC" should all become one entry with
    # aliases. Keeps the most-informative (longest lines_estimate + diacritics)
    # version as primary.
    if cleaned and _HAS_VI_G2P:
        cleaned = _merge_duplicate_characters(cleaned)
        # BUGFIX 2026-07-11: substring aliasing ("Đằng Ưu Nhi" ↔
        # "Y Đằng Ưu Nhi"). The canonical merge above only catches exact
        # and diacritic-equivalent names; substring matches slip through.
        cleaned = _merge_substring_aliases(cleaned)

    # BUGFIX 2026-07-11: source defaults to "omlx" (the happy path). The
    # fallback branch above sets it explicitly.
    return {
        "characters": cleaned,
        "narrator_gender_hint": data.get("narrator_gender_hint", "unknown"),
        "language": data.get("language", "vi"),
        "total_dialogue_lines": _safe_nonnegative_int(data.get("total_dialogue_lines")),
        "summary": str(data.get("summary", ""))[:500],
        "source": data.get("source", "omlx"),
    }


def _safe_nonnegative_int(value: Any, maximum: int = 1_000_000) -> int:
    """Coerce noisy LLM numerics without letting one bad field abort a run."""
    try:
        number = int(float(value))
    except (TypeError, ValueError, OverflowError):
        return 0
    return max(0, min(maximum, number))


def _parse_json_anywhere(raw: str) -> dict:
    """Try to find and parse a JSON object inside the raw LLM output."""
    if not raw: return {}
    text = raw.strip()
    # Strip markdown fences
    text = re.sub(r"^```(?:json)?\s*\n?", "", text)
    text = re.sub(r"\n?```\s*$", "", text)
    # Try direct parse
    try:
        v = json.loads(text)
        return v if isinstance(v, dict) else {}
    except Exception:
        pass
    # Find first { and try progressively larger slices
    starts = [i for i, ch in enumerate(text) if ch == "{"]
    for s in starts:
        # Try balanced match
        depth = 0
        for e in range(s, len(text)):
            if text[e] == "{": depth += 1
            elif text[e] == "}":
                depth -= 1
                if depth == 0:
                    candidate = text[s:e+1]
                    try:
                        v = json.loads(candidate)
                        if isinstance(v, dict): return v
                    except Exception:
                        continue
    return {}


def _merge_duplicate_characters(characters: list[dict]) -> list[dict]:
    """Merge near-duplicate character entries (different spellings of the same
    person) using Vietnamese diacritic+tone folding.

    Keeps the entry with the longest `lines_estimate` (most confident) as the
    primary record; folds the rest into its `aliases` list. Order preserved.
    """
    if not characters:
        return characters

    n = len(characters)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    # Cluster indices by canonical-form equality.
    by_canonical: dict[str, int] = {}
    for idx, c in enumerate(characters):
        canon = _vi_canonical(c.get("name", ""))
        if not canon:
            union(idx, idx)  # leave alone
            continue
        if canon in by_canonical:
            union(idx, by_canonical[canon])
        else:
            by_canonical[canon] = idx

    # Also union via g2p_match for cross-dialect / spacing variants the
    # canonical form misses.
    keys = list(by_canonical.keys())
    for i, k1 in enumerate(keys):
        for k2 in keys[i + 1:]:
            if _vi_match(k1, k2):
                union(by_canonical[k1], by_canonical[k2])

    # Merge each cluster.
    clusters: dict[int, list[int]] = {}
    for idx in range(n):
        clusters.setdefault(find(idx), []).append(idx)

    merged: list[dict] = []
    for idx in range(n):
        if find(idx) != idx:
            continue  # handled when we reach the cluster root
        members = clusters[idx]

        # Pick primary: prefer one with diacritics, then largest lines_estimate,
        # then longest name (richer info).
        def _score(c: dict):
            n = c.get("name", "")
            has_dia = any("À" <= ch <= "ỹ" for ch in n)
            return (has_dia, _safe_nonnegative_int(c.get("lines_estimate")), len(n))
        primary = max((characters[m] for m in members), key=_score)

        # Fold every other name in the cluster into aliases.
        aliases: list[str] = []
        for m in members:
            other_name = characters[m].get("name", "")
            if other_name and other_name != primary["name"] and other_name not in aliases:
                aliases.append(other_name)
            for a in characters[m].get("aliases", []) or []:
                if a and a != primary["name"] and a not in aliases:
                    aliases.append(a)
        primary["aliases"] = aliases[:8]

        # Keep the highest lines_estimate across the cluster.
        primary["lines_estimate"] = max(
            _safe_nonnegative_int(characters[m].get("lines_estimate")) for m in members
        )

        # Union sample_lines (dedup, cap at 2).
        seen_lines: set[str] = set()
        merged_lines: list[str] = []
        for m in members:
            for s in characters[m].get("sample_lines", []) or []:
                if s and s not in seen_lines:
                    seen_lines.add(s)
                    merged_lines.append(s)
                    if len(merged_lines) >= 2:
                        break
            if len(merged_lines) >= 2:
                break
        primary["sample_lines"] = merged_lines

        merged.append(primary)

    return merged


def _merge_substring_aliases(characters: list[dict]) -> list[dict]:
    """Collapse names where one is a strict word-subset of another.

    Catches the Vietnamese pattern "Y Đằng Ưu Nhi" vs "Đằng Ưu Nhi" — both
    refer to the same person; the longer form should win and the shorter
    should fold into `aliases`. The canonical-name merge above only handles
    exact + diacritic-equivalent matches, so it misses these.

    Anchored to the word set, not substring-of-string: "Ưu Nhi" ↔
    "Y Đằng Ưu Nhi" merges, but "Thiếu" ↔ "Nhâm Thiếu Hoài" does not
    because "Thiếu" alone has too few words to be a stable primary name.

    Keeps the longer name (more complete) as primary, folds the rest.
    """
    if not characters:
        return characters

    def _word_set(name: str) -> set[str]:
        canon = _vi_canonical(name or "")
        if not canon:
            return set()
        return set(canon.split())

    n = len(characters)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    # Cluster: pair (i, j) iff one word-set is a strict subset of the other.
    # Refuse to merge single-word names — too ambiguous.
    for i, ci in enumerate(characters):
        wi = _word_set(ci.get("name", ""))
        if len(wi) < 2:
            continue
        for j in range(i + 1, n):
            cj = characters[j]
            wj = _word_set(cj.get("name", ""))
            if len(wj) < 2:
                continue
            if wi == wj:
                continue
            smaller, larger = (wj, wi) if len(wj) < len(wi) else (wi, wj)
            if smaller.issubset(larger):
                union(i, j)

    clusters: dict[int, list[int]] = {}
    for idx in range(n):
        clusters.setdefault(find(idx), []).append(idx)

    merged: list[dict] = []
    for members in clusters.values():
        if len(members) == 1:
            merged.append(characters[members[0]])
            continue
        # Pick primary: longest name (most complete), then largest lines_estimate.
        primary = max(
            (characters[m] for m in members),
            key=lambda c: (len(c.get("name", "")), _safe_nonnegative_int(c.get("lines_estimate"))),
        )
        aliases: list[str] = []
        for m in members:
            other = characters[m].get("name", "")
            if other and other != primary["name"] and other not in aliases:
                aliases.append(other)
            for a in characters[m].get("aliases", []) or []:
                if a and a != primary["name"] and a not in aliases:
                    aliases.append(a)
        primary["aliases"] = aliases[:8]
        # Union sample_lines (dedup, cap at 2).
        seen_lines: set[str] = set()
        merged_lines: list[str] = []
        for m in members:
            for s in characters[m].get("sample_lines", []) or []:
                if s and s not in seen_lines:
                    seen_lines.add(s)
                    merged_lines.append(s)
                    if len(merged_lines) >= 2:
                        break
            if len(merged_lines) >= 2:
                break
        primary["sample_lines"] = merged_lines
        merged.append(primary)

    return merged


# Stop-words / phrases that frequently appear in oMLX thinking but are not character names.
_NAME_SKIP = {
    "The", "This", "That", "These", "Those", "Chapter", "Excerpt", "Excerpts",
    "First", "Next", "Return", "Output", "Below", "Above", "Total", "None",
    "JSON", "Vi", "En", "Vietnamese", "Note", "Example", "Sample", "Schema",
    "From", "Male", "Female", "Unknown", "Thinking", "Process", "Input",
    "Text", "Check", "Characters", "Speaking", "Lines", "Estimate",
    "Synthesize", "Data", "Language", "Gender", "Aliases", "Name",
    "Together", "Act", "Head", "Hit", "Quiet", "Light", "Stars", "Night", "Moon",
    "Romanized", "Pinyin", "Tone", "Happy", "Sad", "Angry",
    "Im", "Lặng", "Là", "Ánh", "Sao", "Trong", "Đêm", "Trăng",
}

# Phrases that aren't valid Vietnamese names — fragments ending with common particles.
_NAME_REJECT_SUFFIXES = ("là", "ở", "đến", "đây", "đi", "đâu", "rồi", "sao", "nha", "nhỉ",
                       "nhé", "thôi", "vậy", "đó", "này", "kìa", "à", "ạ", "hả", "nhỉ")

# Honorifics we treat as alias-prefixes (drop them when matching).
_HONORIFICS = ("thiếu gia", "đại tiểu thư", "cô nương", "tiểu thư", "cô", "chú",
               "bà", "ông", "anh", "chị", "em", "huynh", "tỷ", "tiên tử", "tông chủ",
               "ma tôn", "đại sư", "trưởng lão", "hầu gia", "phu nhân", "lão gia",
               "thiếp thân", "bệ hạ", "thái tử", "hoàng thượng")


def _is_valid_name(name: str) -> bool:
    """Heuristic to decide if a string looks like a Vietnamese proper name."""
    if not name or len(name) > 40 or len(name) < 4:
        return False
    parts = name.split()
    if len(parts) < 2 or len(parts) > 5:
        return False
    if parts[0] in _NAME_SKIP:
        return False
    if any(p.lower() in _HONORIFICS for p in parts):
        # Allow as alias but not as primary name
        return False
    if any(parts[-1].lower().endswith(s) for s in _NAME_REJECT_SUFFIXES):
        return False
    # All parts must start with uppercase (Vietnamian names)
    if not all(p[0].isupper() for p in parts):
        return False
    # BUGFIX 2026-07-11: every part must look Vietnamese (have diacritics) OR
    # be a short non-prose chunk. A pure-ASCII word like "Actually" signals
    # reasoning prose \u2014 "Actually Nh\u00E2m Thi\u1EBFu Ho\u00E0i" should not pass.
    # Single-letter initials ("Y") are accepted as Vietnamese family-name
    # initials. Romanized Vietnamese syllables without diacritics (e.g. "Nhi",
    # "Thieu") are accepted ONLY if the whole name is multi-part and at least
    # one part already carries a Vietnamese diacritic \u2014 otherwise we can't
    # tell romanized-Vietnamese apart from English prose.
    has_dia = any(re.search(r"[\u00C0-\u1EF9\u1E00-\u1EFF]", p) for p in parts)
    for p in parts:
        if re.search(r"[\u00C0-\u1EF9\u1E00-\u1EFF]", p):
            continue
        if len(p) == 1 and p.isupper():
            continue  # Vietnamese single-letter initial
        if (2 <= len(p) <= 8) and not re.fullmatch(r"[A-Za-z]+", p):
            continue  # short non-prose chunk
        # Pure ASCII Latin word \u2014 must be diacritic-free romanized VN,
        # only acceptable when the overall name has diacritics elsewhere.
        if re.fullmatch(r"[A-Za-z]+", p) and has_dia and 2 <= len(p) <= 8:
            continue
        return False
    # Must look Vietnamese (have diacritics) OR be a typical Chinese-origin name
    # (no diacritics but each part 2-8 chars)
    has_diacritics = any("\u00C0" <= c <= "\u1EF9" or "\u0300" <= c <= "\u036f" for c in name)
    return has_diacritics or all(2 <= len(p) <= 8 for p in parts)


# Country names that frequently appear in Vietnamese novel prose but are
# NEVER character names. When the regex fallback runs on LLM reasoning it
# often pulls these out as multi-word capitalized phrases. Without this
# blocklist "Nh\u1EADt B\u1EA3n" / "Trung Qu\u1ED1c" sneak through as suggestions.
_COUNTRY_BLACKLIST = {
    "Nh\u1EADt B\u1EA3n", "Trung Qu\u1ED1c", "Vi\u1EC7t Nam", "H\u00E0n Qu\u1ED1c", "M\u1EF9", "Anh",
    "Ph\u00E1p", "\u0110\u1EE9c", "Nga", "Th\u00E1i Lan", "Singapore", "\u00DAc", "Canada",
    "\u0110\u00E0i Loan", "H\u1ED3ng K\u00F4ng", "Qu\u1EA3ng \u0110\u00F4ng", "B\u1EAFc Kinh", "Th\u01B0\u1EE3ng H\u1EA3i",
}

# Honorific-only or title-only "names" \u2014 the LLM sometimes lists these
# alone in its reasoning prose, which the regex captures. They're not
# character names on their own (e.g. "Th\u00E1i H\u1EADu" = Empress Dowager).
_TITLE_ONLY = {
    "Th\u00E1i H\u1EADu", "Ho\u00E0ng H\u1EADu", "Th\u00E1i T\u1EED", "Ho\u00E0ng Th\u01B0\u1EE3ng", "Qu\u1ED1c V\u01B0\u01A1ng",
    "Ho\u00E0ng T\u1EED", "\u0110\u1EA1i V\u01B0\u01A1ng", "Ti\u00EAn T\u1EED", "Thi\u00EAn H\u1EA1",
    "\u00D4ng N\u1ED9i", "B\u00E0 N\u1ED9i", "\u00D4ng Ngo\u1EA1i", "B\u00E0 Ngo\u1EA1i",
    "M\u1EB9 Ch\u1ED3ng", "M\u1EB9 V\u1EE3", "B\u1ED1 Ch\u1ED3ng", "B\u1ED1 V\u1EE3",
}


def _regex_extract_names(raw: str) -> list[str]:
    """
    Fallback extractor: pull capitalized Vietnamese multi-word names from the
    reasoning prose. Filter aggressively to remove thinking artifacts.
    """
    # First word: either a single uppercase Latin letter (Vietnamese initial
    # like "Y") OR a normal Latin/Vietnamese capitalized word. Subsequent
    # words: full Vietnamese range. Spaces only \u2014 newlines mean we're past
    # the name.
    pattern = r"\b(?:[A-Z]|[A-Z\u00C0-\u1EF9][\u00C0-\u1EF9a-z]{1,15})(?:[ ][A-Z\u00C0-\u1EF9][\u00C0-\u1EF9a-z]{1,15}){1,4}\b"
    found = re.findall(pattern, raw)
    seen = set()
    out = []
    for name in found:
        if not _is_valid_name(name): continue
        if name in seen: continue
        # BUGFIX 2026-07-11: country names are NEVER characters.
        if name in _COUNTRY_BLACKLIST: continue
        # BUGFIX 2026-07-11: titles alone ("Thái Hậu") are not character names.
        if name in _TITLE_ONLY: continue
        seen.add(name)
        out.append(name)
    return out


# Vietnamese title/honorific markers used to infer character metadata when
# the LLM doesn't supply it (regex fallback) or supplies a guess that
# contradicts the name itself (post-LLM override). Each entry is a tuple
# of (regex, gender, age, role_hint) — order matters: first match wins.
# Patterns are anchored to whole words (case-sensitive Vietnamese) so
# "Vương" inside "Vương Quốc" still matches but "Vươn" doesn't.
#
# Why this exists: the regex fallback in `_extract_metadata_from_prose`
# only inspects ~280 chars of prose around the name, which on a 5-chapter
# sample often misses. The NAME itself almost always carries a reliable
# gender/age signal in Vietnamese web-novel prose — every Phù Quang Thánh
# Vương is male and royal, every Cửu Thiên Huyền Nữ is female, every Quý
# Lão is an elder male. Running this BEFORE the prose scan guarantees we
# at least get the obvious cases right.
_NAME_TITLE_MARKERS: list[tuple[str, str, str, str]] = [
    # Female — title-first (more specific than word-boundary matches)
    (r"\bCửu\s+Thiên\s+Huyền\s+Nữ\b",   "female", "mature", "main"),
    (r"\bHuyền\s+Nữ\b",                  "female", "mature", "main"),
    (r"\bThiếu\s+Nữ\b",                  "female", "young",  "supporting"),
    (r"\bTiên\s+Nữ\b",                   "female", "mature", "supporting"),
    (r"\bYêu\s+Nữ\b",                   "female", "mature", "supporting"),
    (r"\bMa\s+Nữ\b",                    "female", "mature", "supporting"),
    (r"\bCông\s+Chúa\b",                "female", "young",  "main"),
    (r"\bHoàng\s+Hậu\b",                "female", "mature", "main"),
    (r"\bThái\s+Hậu\b",                 "female", "old",    "main"),
    (r"\bPhu\s+Nhân\b",                 "female", "mature", "supporting"),
    (r"\bNương\s+Tử\b",                 "female", "young",  "supporting"),
    (r"\bTiểu\s+Thư\b",                 "female", "young",  "supporting"),
    (r"\bĐại\s+Tiểu\s+Thư\b",           "female", "young",  "supporting"),
    # Male — royal/noble/martial (mostly adult, often main or supporting)
    (r"\bHoàng\s+Thượng\b",             "male",   "mature", "main"),
    (r"\bQuốc\s+Vương\b",               "male",   "mature", "main"),
    (r"\bThánh\s+Vương\b",              "male",   "mature", "main"),
    (r"\b(Phù\s+Quang|Vạn\s+Phật|Tiên\s+|Thiên\s+)\s*Vương\b", "male", "mature", "main"),
    (r"\bVương\b",                      "male",   "mature", "main"),
    (r"\bHoàng\s+Tử\b",                 "male",   "young",  "main"),
    (r"\bThái\s+Tử\b",                  "male",   "young",  "main"),
    (r"\bThiên\s+Đế\b",                 "male",   "mature", "main"),
    (r"\b(Đại\s+|Ma\s+|Tông\s+)?Đế\b",  "male",   "mature", "main"),
    (r"\bTông\s+Chủ\b",                 "male",   "mature", "main"),
    (r"\bMa\s+Tôn\b",                   "male",   "mature", "main"),
    (r"\bThánh\b",                      "male",   "mature", "main"),
    (r"\bThiếu\s+Gia\b",                "male",   "young",  "supporting"),
    (r"\bLão\s+Gia\b",                  "male",   "old",    "supporting"),
    (r"\bLão\b",                        "male",   "old",    "supporting"),
    (r"\bTrưởng\s+Lão\b",               "male",   "old",    "supporting"),
    (r"\bThiếu\s+Niên\b",               "male",   "young",  "supporting"),
    (r"\bĐại\s+Sư\b",                   "male",   "old",    "supporting"),
]


def _infer_metadata_from_name(name: str) -> dict:
    """Infer gender/age/role from Vietnamese name markers (title-prefixed or
    single-title names). Returns a dict with all four keys set to safe
    defaults if no marker matches — caller decides whether to use them.
    """
    gender = "unknown"
    age = "unknown"
    role = "supporting"
    if not name:
        return {"gender": gender, "age": age, "role": role}
    # Match against the full name plus each individual word, longest first,
    # so multi-word titles ("Cửu Thiên Huyền Nữ") win before single words.
    candidates = [name]
    for w in name.split():
        if w not in candidates:
            candidates.append(w)
    for cand in candidates:
        for pattern, g, a, r in _NAME_TITLE_MARKERS:
            if re.search(pattern, cand):
                gender, age, role = g, a, r
                return {"gender": gender, "age": age, "role": role}
    return {"gender": gender, "age": age, "role": role}


def _extract_metadata_from_prose(raw: str, names: list[str]) -> dict:
    """When JSON parsing fails, infer gender/tone from the reasoning prose.
    Vietnamese name-marker heuristics run first (see `_infer_metadata_from_name`)
    so the obvious gender/age/role signals in the NAME itself are caught
    even when the LLM's reasoning prose around the name is sparse."""
    result = {n: {"gender": "unknown", "age": "unknown", "role": "supporting",
                  "tone": "unknown", "sample_lines": []} for n in names}
    # BUGFIX 2026-07-11: seed gender/age/role from Vietnamese name markers
    # FIRST — the name itself almost always carries a reliable signal
    # (e.g. "Cửu Thiên Huyền Nữ" → female / mature / main) that the prose
    # scan below would miss because the LLM reasoning around it is sparse.
    # Prose cues only OVERRIDE the marker-derived gender if the marker left
    # it as "unknown" — we trust an explicit title over an ambiguous prose
    # token like "cô gái bên cạnh" appearing nearby.
    for n in names:
        inferred = _infer_metadata_from_name(n)
        result[n]["gender"] = inferred["gender"]
        result[n]["age"] = inferred["age"]
        result[n]["role"] = inferred["role"]
    # Split prose into sentences
    sentences = re.split(r"(?<=[.!?])\s+|\n", raw)
    for n in names:
        for s in sentences:
            if n in s:
                # Look for gender cues near the name. ONLY override when the
                # name-marker inference (done above) left gender as "unknown"
                # — an explicit "Huyền Nữ" title beats an ambiguous prose
                # token like "cô gái bên cạnh" appearing nearby.
                #
                # BUGFIX 2026-07-11: when two detected names appear in the
                # same sentence (e.g. "Cửu Thiên Huyền Nữ stood near Lâm
                # Phàm"), a 280-char window around "Lâm Phàm" still contains
                # the "Nữ" token from "Cửu Thiên Huyền Nữ", bleeding the
                # other character's gender cue. Strip OTHER detected names
                # from the window so each character only sees prose cues
                # that refer to it (or its surrounding narration).
                window_start = max(0, s.find(n) - 80)
                window_end = min(len(s), s.find(n) + len(n) + 200)
                nearby_raw = s[window_start:window_end]
                nearby = nearby_raw
                for other in names:
                    if other != n and other in nearby:
                        nearby = nearby.replace(other, " ")
                nearby_low = nearby.lower()
                if result[n]["gender"] == "unknown":
                    # BUGFIX 2026-07-11: word-boundary regex match — bare
                    # `in` substring used to false-positive (e.g. "chỉ huy"
                    # contains "chú", "nhân vật nam chính" contains "nam" but
                    # is a generic narration token, etc.). The Vietnamese
                    # honorific cues are real words — match them as such.
                    if re.search(r"\b(nữ|cô|chị|tỷ|ma\s+nữ|nương\s+tử|tiểu\s+thư|phu\s+nhân)\b", nearby_low):
                        result[n]["gender"] = "female"
                    elif re.search(r"\b(nam|chú|anh|huynh|thiếu\s+gia|tông\s+chủ|ma\s+tôn|hoàng\s+thượng|lão\s+gia)\b", nearby_low):
                        result[n]["gender"] = "male"
                # Tone cues
                if any(w in nearby_low for w in ["hài hước", "vui", "cười", "tươi"]):
                    result[n]["tone"] = "cheerful"
                elif any(w in nearby_low for w in ["lạnh lùng", "lạnh", "tàn nhẫn", "ác"]):
                    result[n]["tone"] = "cold"
                elif any(w in nearby_low for w in ["nóng nảy", "phẫn nộ", "giận"]):
                    result[n]["tone"] = "angry"
                elif any(w in nearby_low for w in ["bí ẩn", "thần bí", "trầm"]):
                    result[n]["tone"] = "mysterious"
                # Sample lines: any quoted phrase right after the name in the same sentence.
                # Search the ORIGINAL window (with names intact) so the quote
                # boundary characters don't get confused with name stripping.
                quote = re.search(r"[\"“][^\"”]{5,80}[\"”]", nearby_raw)
                if quote and len(result[n]["sample_lines"]) < 1:
                    inner = quote.group(0)[1:-1].strip()
                    # BUGFIX 2026-07-11: reject single-word "quotes" — those are
                    # aliases the LLM is citing, not character dialogue
                    # (produced bare-quote strings like '"Thiếu Hoài"').
                    if inner and not re.fullmatch(r"[A-ZÀ-ỹ][À-ỹa-z]+(\s+[A-ZÀ-ỹ][À-ỹa-z]+){0,2}", inner):
                        result[n]["sample_lines"].append(inner[:240])
                break
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: character_detector.py <book.epub|chapter.html> [model]", file=sys.stderr)
        sys.exit(1)
    target = sys.argv[1]
    t0 = time.time()

    # Mode 0: chapter HTML on stdin (target "-"). This lets the Next.js
    # route avoid temp files that were orphaned on cancellation/restart.
    # Mode 1: single chapter HTML/XHTML file
    # Mode 2: EPUB file (samples chapters)
    is_stdin_chapter = target == "-"
    is_single_chapter = is_stdin_chapter or (
        target.lower().endswith(('.html', '.xhtml', '.htm'))
        and not target.lower().endswith('.epub')
    )

    if is_single_chapter:
        chapter_id = (
            os.environ.get("CHARACTER_DETECTOR_CHAPTER_ID", "chapter")
            if is_stdin_chapter
            else os.path.basename(target).rsplit('.', 1)[0]
        )
        print(f"[character_detector] Single-chapter mode: {chapter_id}", file=sys.stderr)
        if is_stdin_chapter:
            html_text = sys.stdin.read(5 * 1024 * 1024 + 1)
            if len(html_text) > 5 * 1024 * 1024:
                raise RuntimeError("stdin chapter HTML exceeds 5 MiB")
        else:
            with open(target, 'r', encoding='utf-8', errors='ignore') as f:
                html_text = f.read()
        result = detect_characters_in_chapter_html(html_text, chapter_id)
    else:
        print(f"[character_detector] EPUB mode: {target}", file=sys.stderr)
        result = detect_characters(target)

    print(f"[character_detector] Done in {time.time()-t0:.1f}s", file=sys.stderr)
    print(json.dumps(result, ensure_ascii=False, indent=2))
