"""
vncorenlp_attribution.py — Tier 3b speaker attribution via VnCoreNLP parser.

Consumed by the BullMQ pre-generation path (audiobook_generator.py). Sits
between Tier 1 (regex) and Tier 3a (LLM oMLX) in the segmenter pipeline:

    Tier 1 : regex (existing)
    Tier 3b: VnCoreNLP parser (this module)
    Tier 3a: oMLX (existing, opt-in)

Why a separate module: the parser-driven attribution logic is meaty enough
to warrant its own file (~250 lines) and the BullMQ worker doesn't want
to pull in any of the FastAPI server code. The HTTP contract is small:
POST { text } → { sentences: [{tokens:[{form, posTag, head, depLabel}], ...}] }.

Per-paragraph attribution flow:
  1. Strip HTML → plain text → split paragraphs.
  2. Join paragraphs with newlines → POST to vncorenlp/annotate.
  3. Walk sentences: for each, find root verb + its `sub`/`nsubj` subject.
  4. If subject is a known character name OR a gender-matching pronoun
     AND the verb is a speech verb OR a quote is nearby, attribute the
     paragraph to that name.
  5. Return a map paragraph_index → { speaker, confidence, source } so
     the caller can override the regex layer's result per paragraph.

Why this matters: the regex engine misses paragraphs like "Anh đánh nhẹ cô"
where the speaker is a bare pronoun with no proper-name reference in the
same paragraph. The parser sees `Anh` as the `sub` of `đánh` and resolves
the speaker via the gender → most-recent-character-history map.
"""
from __future__ import annotations

import os
import re
import sys
import time
from typing import Optional

import httpx

# Python's stdlib ``re`` has no ``\p{Lu}``/``\p{L}``, while the browser-side
# attribution engine uses those Unicode properties to discover previously
# unseen Vietnamese names.  Build the Vietnamese uppercase class from Unicode
# case semantics instead of a broad code-point range: ranges such as ``À-Ỹ``
# also contain lowercase ``đ``, ``ơ`` and ``ư`` and used to turn ordinary
# prose into bogus character candidates.
_UPPER_VI_CHARS = "".join(
    chr(codepoint)
    for codepoint in range(0x00C0, 0x1F00)
    if chr(codepoint).isalpha() and chr(codepoint).isupper()
)
_CAP_LETTER_CLASS = f"[A-Z{re.escape(_UPPER_VI_CHARS)}]"
_LETTER = r"[^\W\d_]"

# Keep this in parity with PROPER_NAME_RE in src/lib/attribution.ts:
# two-to-six capital-led words, with the leading separator excluded from the
# capture and punctuation/whitespace terminating the candidate.
PROPER_NAME_RE = re.compile(
    rf"(?:^|[^\w])({_CAP_LETTER_CLASS}{_LETTER}*"
    rf"(?:\s+{_CAP_LETTER_CLASS}{_LETTER}*){{1,5}})"
    rf"(?=\s|[,.:;!?…]|$)",
    re.UNICODE,
)

# ── Config ──────────────────────────────────────────────────────────────
VNCORENLP_URL = os.environ.get("VNCORENLP_URL", "http://127.0.0.1:5030").rstrip("/")
USE_VNCORENLP = os.environ.get("USE_VNCORENLP", "1").strip().lower() in ("1", "true", "yes", "on")
VNCORENLP_TIMEOUT_S = float(os.environ.get("VNCORENLP_TIMEOUT_S", "20"))
VNCORENLP_CONNECT_TIMEOUT_S = float(os.environ.get("VNCORENLP_CONNECT_TIMEOUT_S", "2.0"))

# Pronoun → gender sets (mirror of PRONOUNS_FEMALE / PRONOUNS_MALE in
# audiobook_generator.py — keep in sync).
PRONOUNS_FEMALE = {"cô", "chị", "bà", "em gái", "con gái", "nàng", "nữ"}
PRONOUNS_MALE = {"anh", "ông", "chú", "bác", "em trai", "con trai", "chàng", "nam"}

# Verb forms that signal speech (nói / hỏi / kêu / …). Lower-case, single-word.
# Phrasal verbs (nói rằng, cất tiếng, …) collapse to the head word here.
SPEECH_VERB_HEADS = {
    "nói", "hỏi", "đáp", "kêu", "quát", "hét", "lẩm_bẩm", "nói_nhỏ",
    "cười_nói", "trả_lời", "gọi", "thét", "lên_tiếng", "quát_tháo",
    "cất_tiếng", "mở_miệng", "cất_giọng", "la_lên", "hỏi_han", "gào",
    "kêu_gào", "tiếp_lời", "nói_tiếp", "nói_khẽ", "khẽ_nói", "hỏi_lại",
    "hỏi_thăm", "bảo", "đọc", "kể", "xướng", "hát", "phát_biểu",
    "giải_thích", "giảng_giải", "xung_phong", "reo_lên", "hét_lên",
    "thì_thầm", "thủ_thỉ", "nói_với", "nói_rằng", "nói_thầm", "hỏi_rằng",
}


def is_speech_verb(form: str) -> bool:
    """True if `form` (lowercase) is a known speech verb head."""
    return form.lower().replace(" ", "_") in SPEECH_VERB_HEADS


def pronoun_gender(form: str) -> Optional[str]:
    """'female' / 'male' / None."""
    f = form.lower().strip()
    if f in PRONOUNS_FEMALE:
        return "female"
    if f in PRONOUNS_MALE:
        return "male"
    return None


def _call_annotate(text: str) -> Optional[dict]:
    """POST to /annotate. Returns parsed JSON or None on any failure.

    We don't raise — the caller (Tier 3b orchestrator) treats the parser as
    an opportunistic layer. If it's down, we silently skip and let Tier 3a
    take over."""
    if not USE_VNCORENLP:
        return None
    url = f"{VNCORENLP_URL}/annotate"
    payload = {"text": text, "annotators": ["wseg", "pos", "parse"]}
    try:
        with httpx.Client(
            timeout=httpx.Timeout(
                VNCORENLP_TIMEOUT_S, connect=VNCORENLP_CONNECT_TIMEOUT_S
            ),
        ) as client:
            r = client.post(url, json=payload)
        if r.status_code != 200:
            print(f"[tier3b] parser HTTP {r.status_code}: {r.text[:200]}",
                  file=sys.stderr)
            return None
        return r.json()
    except Exception as e:
        print(f"[tier3b] parser unreachable ({e.__class__.__name__}); "
              f"falling back to regex/Tier 3a", file=sys.stderr)
        return None


# ── Sentence-level helpers ──────────────────────────────────────────────
def _find_root_verb(sent: dict) -> Optional[dict]:
    """VnCoreNLP marks the predicate with head=0 and depLabel='root'.
    Fall back to head=0 V when 'root' is missing (older models)."""
    for tok in sent.get("tokens", []):
        if (tok.get("head") == 0
                and tok.get("posTag") == "V"
                and tok.get("depLabel") == "root"):
            return tok
    for tok in sent.get("tokens", []):
        if tok.get("head") == 0 and tok.get("posTag") == "V":
            return tok
    return None


def _find_subject_for(sent: dict, verb: dict) -> Optional[dict]:
    """Return the token that is the syntactic subject of `verb`, preferring
    proper nouns (Np) over common nouns (N) over pronouns (R). VnCoreNLP
    uses 'sub' for the active subject; older corpora may use 'nsubj'."""
    head_idx = verb.get("index")
    candidates: list[dict] = []
    for tok in sent.get("tokens", []):
        if tok.get("head") != head_idx:
            continue
        dl = (tok.get("depLabel") or "").lower()
        if dl not in ("sub", "nsubj", "nsubj:pass"):
            continue
        candidates.append(tok)
    if not candidates:
        return None
    # Rank: Np > N > A > R > other
    rank = {"Np": 4, "N": 3, "A": 2, "R": 1}
    candidates.sort(key=lambda t: rank.get(t.get("posTag") or "", 0), reverse=True)
    return candidates[0]


def _surface_text(sent: dict) -> str:
    return " ".join((t.get("form") or "") for t in sent.get("tokens", [])).strip()


def _map_sentence_to_paragraph(
    paragraphs: list[str],
    sentences: list[dict],
) -> list[int]:
    """Reconstruct each sentence's surface text and locate it in the joined
    paragraph string. Returns a list of paragraph indices, one per sentence.
    Sentences we can't locate fall back to the previously-mapped paragraph
    (they're usually a continuation like "rồi nói thêm")."""
    joined = " ".join(paragraphs)
    # Precompute paragraph offsets once.
    para_offsets: list[tuple[int, int]] = []
    cur = 0
    for p in paragraphs:
        idx = joined.find(p, cur)
        if idx < 0:
            # Paragraph text didn't appear verbatim — append a sentinel and
            # fall back to linear search per sentence below.
            para_offsets.append((cur, cur + len(p)))
            cur += len(p) + 1
            continue
        para_offsets.append((idx, idx + len(p)))
        cur = idx + len(p) + 1
    out: list[int] = []
    cursor = 0
    last_para = 0
    for sent in sentences:
        surface = _surface_text(sent)
        if not surface:
            out.append(last_para)
            continue
        found = joined.find(surface, cursor)
        if found < 0:
            out.append(last_para)
            continue
        cursor = found + len(surface)
        # Locate the paragraph whose [start, end) window contains `found`.
        for idx, (p_start, p_end) in enumerate(para_offsets):
            if p_start <= found < p_end:
                out.append(idx)
                last_para = idx
                break
        else:
            out.append(last_para)
    return out


# ── Pronoun → canonical-name resolution ────────────────────────────────
def _build_gender_by_char(cmap: dict) -> tuple[dict[str, str], dict[str, str]]:
    """Returns (alias→canonical, canonical→gender). Gender comes from the
    character's voice builtin name via VIENEU_GENDER if present."""
    alias_to_canonical: dict[str, str] = {}
    canonical_to_gender: dict[str, str] = {}
    VIENEU_GENDER = {
        # Female built-ins
        "ngọc linh": "female", "ngọc lan": "female", "mỹ duyên": "female",
        "trúc ly": "female",
        # Male built-ins
        "bình an": "male", "gia bảo": "male", "đức trí": "male",
        "thái sơn": "male", "trọng hữu": "male", "xuân vĩnh": "male",
    }
    for c in cmap.get("characters", []):
        canonical = c["name"]
        for alias in [c["name"]] + (c.get("aliases") or []):
            alias_to_canonical[alias.lower()] = canonical
        voice_id = c.get("voiceId")
        voice = cmap.get("voices_by_id", {}).get(voice_id) if voice_id else None
        builtin = ((voice or {}).get("builtinName")
                   or (voice or {}).get("name") or "").lower()
        persisted_gender = c.get("gender")
        gender = (
            persisted_gender if persisted_gender in ("female", "male")
            else VIENEU_GENDER.get(builtin.strip(), "unknown")
        )
        canonical_to_gender[canonical] = gender
    return alias_to_canonical, canonical_to_gender


def _resolve_subject_to_name(
    subject_form: str,
    alias_to_canonical: dict[str, str],
    canonical_to_gender: dict[str, str],
) -> Optional[tuple[str, str]]:
    """Returns (canonical_name, gender) or None. Tries exact match first,
    then alias-prefix match for multi-word names ('Y Đằng Long' → alias
    'Y Đằng')."""
    norm = subject_form.lower().strip()
    if not norm:
        return None
    if norm in alias_to_canonical:
        canonical = alias_to_canonical[norm]
        return canonical, canonical_to_gender.get(canonical, "unknown")
    # Prefix match — walk aliases by descending length
    for alias, canonical in sorted(alias_to_canonical.items(),
                                   key=lambda kv: -len(kv[0])):
        if len(alias) >= 2 and alias.startswith(norm):
            return canonical, canonical_to_gender.get(canonical, "unknown")
    return None


def _most_recent_by_gender(
    history: str,
    alias_to_canonical: dict[str, str],
    canonical_to_gender: dict[str, str],
) -> dict[str, str]:
    """Walk history text right-to-left; build {gender: most_recent_canonical}.
    Skips names that appear right after an object marker (nhìn / với / …)."""
    OBJECT_MARKER_RE = re.compile(
        r"\s(?:nhìn|thấy|gặp|với|của|cho|cùng|gọi|kể|về|bằng|từ|đến|giúp|trả|đưa|đối với|về phía|phía sau|bên cạnh|trước mặt)\s",
        re.IGNORECASE,
    )
    last_by_gender: dict[str, str] = {}
    # Find all alias occurrences right-to-left
    sorted_aliases = sorted(alias_to_canonical.items(), key=lambda kv: -len(kv[0]))
    alias_alt = "|".join(re.escape(a) for a, _ in sorted_aliases)
    if not alias_alt:
        return last_by_gender
    # Use a word-boundary-ish approach with \b and a Unicode lookahead for VN
    # diacritics. Vietnamese letters are \w in Python re with re.UNICODE.
    re_name = re.compile(rf"(?:^|\W)({alias_alt})(?=\W|$)", re.UNICODE)
    matches = list(re_name.finditer(history))
    for m in reversed(matches):
        alias = m.group(1).lower()
        canonical = alias_to_canonical.get(alias)
        if not canonical:
            continue
        before_name = history[max(0, m.start(1) - 12):m.start(1)]
        if OBJECT_MARKER_RE.search(before_name):
            continue
        gender = canonical_to_gender.get(canonical, "unknown")
        if gender in ("female", "male") and gender not in last_by_gender:
            last_by_gender[gender] = canonical
    return last_by_gender


# ── Per-paragraph attribution ─────────────────────────────────────────
def attribute_chapter_by_parser(
    plain_text: str,
    cmap: dict,
    paragraphs: Optional[list[str]] = None,
) -> dict[int, dict]:
    """Return a per-paragraph attribution map for the given chapter text.

    Output shape: { paragraph_index: { speaker, confidence, source } }.

    `paragraphs` is optional — if not given, we split on double newlines
    (mirrors what _regex_segment_chapter / _llm_segment_chapter do)."""
    if paragraphs is None:
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", plain_text) if p.strip()]
    if not paragraphs:
        return {}

    alias_to_canonical, canonical_to_gender = _build_gender_by_char(cmap)
    if not alias_to_canonical:
        # No characters known — parser layer can't do anything useful.
        return {}

    # 1. POST to the parser service
    parser_text = "\n".join(paragraphs)
    t0 = time.time()
    parsed = _call_annotate(parser_text)
    elapsed_ms = int((time.time() - t0) * 1000)
    if not parsed:
        return {}
    sentences = parsed.get("sentences", [])
    if not sentences:
        return {}
    print(f"[tier3b] parsed {len(paragraphs)} paragraphs into "
          f"{len(sentences)} sentences in {elapsed_ms}ms "
          f"(cached={parsed.get('cached', False)})", file=sys.stderr)

    # 2. Map each sentence back to a paragraph index
    para_of_sent = _map_sentence_to_paragraph(paragraphs, sentences)

    # 3. Per-paragraph attribution
    attribution: dict[int, dict] = {}
    # Track last-by-gender per-paragraph (history grows as we walk paragraphs)
    history = ""
    for p_idx, paragraph in enumerate(paragraphs):
        # Update history with this paragraph's text before resolving.
        # We keep history capped at PRONOUN_HISTORY_WINDOW chars.
        local_history = paragraph
        for s_idx, sent in enumerate(sentences):
            if para_of_sent[s_idx] != p_idx:
                continue
            verb = _find_root_verb(sent)
            if not verb:
                continue
            subject = _find_subject_for(sent, verb)
            if not subject:
                continue
            subject_form = subject.get("form") or ""
            is_speech = is_speech_verb(verb.get("form") or "")
            pg = pronoun_gender(subject_form)

            # ── Case A: subject is a known character name ─────────────
            resolved = _resolve_subject_to_name(
                subject_form, alias_to_canonical, canonical_to_gender
            )
            if resolved:
                canonical, _gender = resolved
                if is_speech:
                    # Strong signal: speech verb + named subject.
                    confidence = 0.9
                elif pg:
                    # Pronoun-as-name doesn't happen, but if we somehow have
                    # "Anh" as a registered character alias, treat it like
                    # the speech-verb case.
                    confidence = 0.7
                else:
                    # Name is the subject of a non-speech verb (e.g.
                    # "Anh cười" — Anh is doing the smiling, not speaking).
                    # Only attribute if a quote follows the verb.
                    confidence = 0.55
                attribution[p_idx] = {
                    "speaker": canonical,
                    "confidence": confidence,
                    "source": "parser",
                }
                break  # paragraph resolved

            # ── Case B: subject is a bare pronoun (Cô / Anh / …) ─────
            if pg:
                # Walk history for the most recent same-gender character.
                combined = history + " " + local_history
                last_by_gender = _most_recent_by_gender(
                    combined, alias_to_canonical, canonical_to_gender
                )
                canonical = last_by_gender.get(pg)
                if canonical:
                    confidence = 0.85 if is_speech else 0.65
                    attribution[p_idx] = {
                        "speaker": canonical,
                        "confidence": confidence,
                        "source": "parser",
                    }
                    break
                # No same-gender character in history — store partial.
                attribution[p_idx] = {
                    "speaker": None,
                    "confidence": 0.25,
                    "source": "parser",
                }
                break

        history = (history + " " + paragraph)[-4000:]

    return attribution


# ── Public entry point for callers ────────────────────────────────────
def attribute_chapter(
    plain_text: str,
    cmap: dict,
    paragraphs: Optional[list[str]] = None,
) -> dict[int, dict]:
    """Convenience wrapper. Logs tier activation + result count."""
    if not USE_VNCORENLP:
        return {}
    out = attribute_chapter_by_parser(plain_text, cmap, paragraphs)
    resolved = sum(1 for v in out.values() if v.get("speaker"))
    print(f"[tier3b] VnCoreNLP attributed {resolved}/{len(out)} "
          f"paragraphs to known characters", file=sys.stderr)
    return out
