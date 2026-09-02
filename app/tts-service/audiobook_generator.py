"""
Audiobook pre-generation worker.

Reads a single chapter HTML, splits it into segments (narration vs. dialogue),
assigns the right voice to each segment, and synthesises the whole chapter to
one concatenated WAV file using the unified TTS server.

Reads CHARACTER_MAP env var (JSON) to know which voice to use for each
character and which built-in VieNeu voices are available.

Run as:  python audiobook_generator.py --book-id X --chapter-file Y ...
"""
import argparse
import html
import io
import json
import os
import re
import struct
import sys
import time
import wave
from pathlib import Path
from typing import Optional

import httpx

# ── Defaults ────────────────────────────────────────────────────────────────
# 2026-07-12: VieNeu is the sole TTS backend. Piper + MOSS-TTS-Nano were
# removed. UNIFIED_TTS_URL is preserved as a back-compat alias for VIENEU_URL.
VIENEU_URL = os.environ.get("VIENEU_URL", os.environ.get("UNIFIED_TTS_URL", "http://127.0.0.1:5020"))
EBOOK_ROOT = Path(os.environ.get("EBOOK_ROOT", "/Volumes/EXT-SSD/Users/anhl/Local-AI/app/ebook-converter"))
DATA_DIR = EBOOK_ROOT / "data" / "audiobooks"

_VALID_ATTRIBUTION_ENGINES = frozenset({"conversation_v3", "legacy"})
_requested_attribution_engine = os.environ.get(
    "ATTRIBUTION_ENGINE", "conversation_v3"
).strip().lower()
if _requested_attribution_engine not in _VALID_ATTRIBUTION_ENGINES:
    print(
        f"[attribution_engine] unknown ATTRIBUTION_ENGINE="
        f"{_requested_attribution_engine!r}; using conversation_v3",
        file=sys.stderr,
    )
    _requested_attribution_engine = "conversation_v3"
ATTRIBUTION_ENGINE = _requested_attribution_engine
print(f"[attribution_engine] active={ATTRIBUTION_ENGINE}", file=sys.stderr)

QUOTE_OPEN_CHARS = "\u201c\u300c\u300e\""  # Vietnamese & ASCII double quotes
QUOTE_CLOSE_CHARS = "\u201d\u300d\u300f\""
QUOTE_OPEN = QUOTE_OPEN_CHARS[0]   # kept for back-compat
QUOTE_CLOSE = QUOTE_CLOSE_CHARS[0]

# Match any of: " " 「 」 『 』 << >>. One-character answers such as “Ừ” are
# valid dialogue; the old 3-character minimum silently sent them to the
# narrator. The upper bound protects the regex from consuming a malformed,
# chapter-spanning quote.
QUOTE_RE = re.compile(f"([{re.escape(QUOTE_OPEN_CHARS)}]|\\<\\<)([^{''.join(QUOTE_OPEN_CHARS)}{''.join(QUOTE_CLOSE_CHARS)}]{{1,1200}}?)([{re.escape(QUOTE_CLOSE_CHARS)}]|\\>\\>)", re.DOTALL)


# ── Strict speaker attribution (port of EbookReader.tsx findSpeakerForQuote) ──
# Vietnamese speech verbs — the presence of one of these BEFORE or AFTER a
# quote (within the attribution window) is required to attribute the quote to
# a character. Without a speech verb, the quote falls back to the default
# (narrator) voice — narration that *mentions* a character must NOT trigger
# that character's voice.
SPEECH_VERBS = (
    r"(?:nói|hỏi|đáp|kêu|thì thầm|quát|hét|lẩm bẩm|nói nhỏ|cười nói"
    r"|trả lời|gọi|thét|lên tiếng|quát tháo|cất tiếng|mở miệng|cất giọng"
    r"|la lên|hỏi han|gào|kêu gào|tiếp lời|nói tiếp|nói khẽ|khẽ nói"
    r"|hỏi lại|hỏi thăm|bảo|đọc|kể|xướng|hát|hỏi rằng|nói rằng"
    r"|nói với|thì thầm|nói thầm|phát biểu|giải thích|giảng giải"
    r"|xung phong|nói khẽ|reo lên|hét lên|la lên)"
)

# Vietnamese verbs/prepositions that take a name as their OBJECT (not subject).
# If a known name appears RIGHT AFTER one of these (within ~12 chars), it's
# the object of that verb, NOT the speaker of the upcoming speech verb.
#   "Cậu bé gật đầu, nhìn La Dạ, rồi nói"  → La Dạ is OBJECT of "nhìn"
#   "La Dạ cười nói"                        → La Dạ is SUBJECT (no marker)
OBJECT_MARKER_RE = re.compile(
    r"\s(?:nhìn|thấy|gặp|với|của|cho|cùng|gọi|kể|về|bằng|từ|đến|giúp|trả|đưa|đối với|về phía|phía sau|bên cạnh|trước mặt)\s",
    re.IGNORECASE,
)

# ── Thought verbs (cảm thán / nghĩ / thì thầm / tự nhủ …) ───────────────
# Used by the BARE-EXCLAMATION attribution pass below. When a paragraph
# contains "<Name> ... <thought_verb> <Object>", the Name is the THINKER
# and any bare exclamation that follows (with no speech verb of its own)
# is from the thinker — i.e. internal-monologue-out-loud, or a half-spoken
# reaction like "Quỷ nghịch ngợm!" addressed to the object.
#
# IMPORTANT: this list contains only REAL thought verbs. Bare modifiers
# like "âm thầm", "thầm", "trong lòng" are deliberately EXCLUDED — they
# almost always appear before a real verb ("âm thầm cảm thán") and should
# be absorbed into the gap so the regex matches the actual predicate. If
# we listed "âm thầm" here, the non-greedy gap would stop at "âm thầm"
# and return a partial match with no thinker.
#
# Example:
#   "...Ngay cả Y Đằng Long ... cũng không thể không âm thầm cảm thán:
#    Tiểu Ưu Nhi thật sự trưởng thành rồi!"
#   "Quỷ nghịch ngợm!"         ← Long talking to Ưu Nhi (his sister)
THOUGHT_VERBS = (
    r"(?:cảm thán|thầm nghĩ|nghĩ thầm|thì thầm|lẩm bẩm|tự nhủ|thầm nhủ"
    r"|nói thầm|bình phẩm|đánh giá|cảm nhận|hy vọng|thắc mắc|lo lắng"
    r"|băn khoăn|suy nghĩ|tự hỏi|nghĩ tới|nghĩ đến|tưởng nhớ|nhớ ra"
    r"|thở dài|thở ra|than thở|than rằng|tự trách)"
)

# ── Reactive action verbs ─────────────────────────────────────────────────
# When a paragraph contains "<Name> <reactive_action> <Object>", the Name is
# the DOER of an action that typically prompts a reaction. A bare
# exclamation immediately after is usually from the DOER ("thả tim", "vỗ
# vai", "ghé tai" …) — they're the one performing the teasing/affection.
# Without this fallback the closest-name wins logic mis-attributes the
# exclamation to the object of the action.
#
# NOT included: pure physical actions like đánh / chém / giết — those are
# violence, not reactive teasing.
REACTIVE_ACTIONS = (
    r"(?:cười|mỉm cười|nhếch mép|nháy mắt|chớp mắt|vỗ vai|vỗ lưng"
    r"|ôm|ghé tai|nắm tay|kéo tay|vuốt tóc|xoa đầu|gõ nhẹ|vẫy tay"
    r"|giơ tay|chỉ vào|nhìn|liếc nhìn|nhìn trộm)"
)

# ── Generic "subject + action" verbs (for name-as-subject attribution) ───
# When the BEFORE window ends with "<Subject> <action>" right before a quote,
# the SUBJECT is the doer / speaker of the action that produced the quote.
# Combined with the closest-name-wins + object-marker filter, this catches
# patterns like:
#   "Y Đằng Ưu Nhi bị âm thanh bất ngờ làm hoảng sợ, quay phắt đầu lại, "Long......""
#   "Y Đằng Ưu Nhi hừ một tiếng, khoanh tay trước ngực, cười khẽ hất cằm lên, "Còn nói nữa!""
#   "Anh không khách khí nắm tay cốc cho cô một cái, "Sai!""
#
# IMPORTANT: only verbs that PRECEDE speech (introduce a quote) belong here.
# Physical actions like "đánh" (hit), "vỗ" (pat), "ôm" (hug), "đấm" (punch)
# describe what the subject DID, then the quote is usually the OTHER
# character's response ("he hit her lightly. 'Ouch!'" — the "Ouch" is hers,
# not his). Including those would cause mis-attribution.
SUBJECT_ACTION_VERBS = (
    r"(?:gọi|hét|kêu|nói|hỏi|đáp|trả lời|thét|la|reo|than|giận|dỗi"
    r"|hừ|hắng|hắng giọng|cười|cười khẽ|cười nói|mỉm cười|nhếch mép"
    r"|quay phắt|quay đầu|ngoái đầu|ngoảnh đầu|ngoái lại|ngoảnh lại"
    r"|nhéo|vặn|xoắn|bẻ|giật|kéo|lôi|cầm|nhặt|cúi|ngẩng|nghiêng"
    r"|lắc|gật|vẫy|cất tiếng|mở miệng|tiếp lời|nói tiếp|nói rằng"
    r"|khẽ nói|nói khẽ|thì thầm|thủ thỉ|thề|nguyền rủa|chửi|mắng"
    r"|quát|quát tháo|gào|kêu gào|gào thét|hô|hô to|hô lớn"
    # Action verbs commonly appearing AFTER a quote, e.g.
    #   "?" Anh đánh nhẹ vào mông cô, "Sai!"
    #   "?" Cô hừ một tiếng, khoanh tay trước ngực, "..."
    r"|đánh|đấm|nắm|véo|vỗ|nhéo|thở dài|thở ra|thở"
    r"|nhíu|nhíu mày|lườm|liếc|trừng|ngước|cúi|gật|lắc|vẫy)"
)

# ── Pronoun resolution (Pass 5a) ─────────────────────────────────────────
# Vietnamese pronouns can act as SUBJECT in "<pronoun> <verb>" patterns.
# We resolve them to a known character by gender — most recently mentioned
# character whose gender matches the pronoun.
#
# Gender sources:
#   1. Character voice's builtinName (Ngọc Lan/Linh/Trúc Ly/Mỹ Duyên = female,
#      Bình An/Gia Bảo/Đức Trí/Thái Sơn/Trọng Hữu/Xuân Vĩnh = male)
#   2. If the character's voice is custom (cloned) and not in the builtin
#      list, fall back to "unknown" — pronoun resolution skips that case.
#
# Pronoun → gender (female / male):
PRONOUNS_FEMALE = (
    r"(?:cô|chị|bà|em gái|con gái|nàng|nữ)"
)
PRONOUNS_MALE = (
    r"(?:anh|ông|chú|bác|em trai|con trai|chàng|nam)"
)
# Neutral first-person / second-person — these often refer to the speaker
# themselves, but for attribution we treat them as "speaker unknown" (do NOT
# use them to attribute a quote to anyone except via later passes).
PRONOUNS_SELF = (
    r"(?:tôi|tao|ta|mình|em|anh|cô|chị|ông|bà)"
)

# Window for pronoun history — how far back to look for the most recent
# same-gender character mention. This is wider than ATTR_WINDOW_BEFORE
# because the pronoun resolution relies on who was just mentioned.
PRONOUN_HISTORY_WINDOW = 400

# Window sizes for the attribution search. The TS browser version uses the
# same numbers (BEFORE=80, AFTER=40) — keep them in sync.
ATTR_WINDOW_BEFORE = 80
ATTR_WINDOW_AFTER = 40
# Max chars allowed between a name and a speech verb inside the BEFORE window.
# Set generously (70) so the regex sees a wider context; the candidate with
# the SMALLEST name-to-verb distance wins, so a too-wide gap just won't be
# picked over a closer match.
ATTR_NAME_TO_VERB_GAP = 70

# Wider window for the THOUGHT-VERB fallback only. Thought verbs ("cảm thán",
# "nghĩ thầm", …) often sit much further back than the speech-verb-attached
# names — a single internal-monologue sentence can be 200-400 chars, and the
# speaker-of-the-bare-exclamation is the THINKER, not the closest name.
# Set wide enough to capture a full preceding paragraph; the candidate with
# the LATEST name+verb start wins, so over-matching is bounded.
ATTR_THOUGHT_WINDOW_BEFORE = 500


def find_quote_spans(text: str) -> list[tuple[int, int, str]]:
    """Return [(start, end, content), ...] for every quoted span in text."""
    spans = []
    for m in QUOTE_RE.finditer(text):
        # Boundaries cover the delimiters so emitted narration never contains
        # a dangling opening/closing quote; content remains delimiter-free.
        spans.append((m.start(), m.end(), m.group(2)))
    return spans


def split_paragraphs_with_offsets(plain: str) -> list[tuple[int, int, str]]:
    """Split `plain` on blank lines and return [(start, end, text), ...] for
    each paragraph. Used by `_regex_segment_chapter` to attribute dialogue
    segments to the paragraph they fall in, which feeds the stateful scene
    memory (`_update_state`). The `plain` text passed in here is the same
    text used for quote spans, so paragraph offsets line up with quote offsets."""
    if not plain:
        return []
    paragraphs: list[tuple[int, int, str]] = []
    # ``strip_html`` preserves visible block boundaries as newlines. Each
    # non-empty line is therefore an independently attributable paragraph.
    # The previous expression accidentally *consumed* single newlines and
    # merged adjacent blocks into one paragraph.
    for m in re.finditer(r"[^\n]+", plain):
        raw = m.group(0)
        text = raw.strip()
        if not text:
            continue
        leading = len(raw) - len(raw.lstrip())
        trailing = len(raw) - len(raw.rstrip())
        paragraphs.append((m.start() + leading, m.end() - trailing, text))
    # If the regex split produced a single mega-paragraph (no newlines),
    # fall back to sentence-boundary splitting.
    if len(paragraphs) <= 1 and len(plain) > 1500:
        paragraphs = []
        sentence_re = re.compile(r"([^.!?\n]{1,400}[.!?…\"]+)\s+")
        pos = 0
        for m in sentence_re.finditer(plain):
            s, e = m.start(1), m.end(1)
            paragraphs.append((s, e, plain[s:e]))
            pos = e
        if pos < len(plain):
            tail = plain[pos:].strip()
            if tail:
                paragraphs.append((pos, len(plain), tail))
    return paragraphs


def paragraph_index_at(offset: int,
                       paragraph_offsets: list[tuple[int, int, str]]) -> int:
    """Return the index of the paragraph whose [start, end) window contains
    `offset`. Falls back to the closest preceding paragraph; -1 when empty."""
    if not paragraph_offsets:
        return -1
    for idx, (s, e, _) in enumerate(paragraph_offsets):
        if s <= offset < e:
            return idx
    # Offset is past the last paragraph's end → assign to last
    if offset >= paragraph_offsets[-1][1]:
        return len(paragraph_offsets) - 1
    # Offset is before the first paragraph's start → assign to first
    return 0


# Narration chunk target — keep synthesized chunks under ~1500 chars so
# a single TTS request stays under timeout. Tune as needed.
NARRATION_CHUNK_TARGET = 1200


# ── Emotion injection ─────────────────────────────────────────────────────
# VieNeu TTS supports inline emotion markers: [cười] [thở dài] [hắng giọng].
# We sprinkle these into the synthesized text based on:
#  1. Character voice's `defaultEmotion` field (if set in DB)
#  2. Heuristic keyword detection per segment (Tier 1, expanded below)
#  3. Per-segment LLM tone classification (Tier 2, off by default)
# This makes the reading more expressive without breaking the source text.
KEYWORD_EMOTIONS = [
    # ── Laughs / amusement ─────────────────────────────────────────────
    # Distinctive laugh patterns only. The bare word "cười" is intentionally
    # OMITTED — in Vietnamese narration it overwhelmingly appears as the
    # noun "nụ cười" (a smile) or the descriptive "cười nhạt" (faint smile)
    # rather than an actual laugh, and matching it causes "[cười]" to be
    # injected into nearly every paragraph.
    (re.compile(r"\b(?:haha|ha ha|hehe|hihi|hê hê|cười lớn|phá lên cười|cười khanh khách|cười khúc khích|cười ha hả|cười hô hố|cười rúc rích|cười gằn|哈哈)\b", re.IGNORECASE), " [cười] "),
    (re.compile(r"\*?(?:khanh khách|khúc khích|hô hố|ha hả|khẽ cười|nhếch mép cười|cười gượng)\*?", re.IGNORECASE), " [cười] "),
    (re.compile(r"\(\s*(?:cười gằn|cười khổ)\s*\)", re.IGNORECASE), " [cười] "),

    # ── Sighs / resignation ────────────────────────────────────────────
    # Distinguish the actual SIGH keywords from neutral breathing verbs.
    # "thở ra" (to exhale) is removed from the bare-word list — it's used for
    # normal breathing, not sighs. Keep "thở ra một hơi" only when wrapped in
    # asterisks (action-description style) below.
    # "thở phào" (sigh of relief) added — a distinctive sigh variant.
    (re.compile(r"\b(?:thở dài|thở một tiếng|thở dốc|thở phào|than thở|thở hắt ra|哀)\b", re.IGNORECASE), " [thở dài] "),
    (re.compile(r"\*?(?:thở dài|thở dốc|thở ra một hơi|thở phào|tiếng thở dài)\*?", re.IGNORECASE), " [thở dài] "),
    (re.compile(r"\(\s*(?:thở dài|thở một tiếng|than thở|thở phào)\s*\)", re.IGNORECASE), " [thở dài] "),
    # NOTE: trailing "..." and "…" are intentionally NOT mapped to [thở dài].
    # Vietnamese narration uses ellipses for hesitation, trailing thoughts,
    # scene transitions, and internal monologue — none of which mean "sigh".
    # Matching them caused [thở dài] to be injected into almost every paragraph.

    # ── Throat-clearing / choked voice ─────────────────────────────────
    # "khàn giọng" (hoarse voice) removed — that's a VOICE QUALITY the
    # narrator describes ("anh ta nói bằng giọng khàn"), not a one-time
    # throat-clearing action. Injecting [hắng giọng] there forced a forced
    # throat-clear that didn't match the prose.
    # Bare "khóc" (cry) removed from the asterisk-optional list — it's a very
    # common Vietnamese verb that matches in most narration contexts. Only
    # distinctive cries (khóc thét / khóc nức nở / khóc sụt sịt) trigger.
    (re.compile(r"\b(?:hắng giọng|hắng hắng|hắng một tiếng|khụt khịt|nghẹn lại|nghẹn ngào)\b", re.IGNORECASE), " [hắng giọng] "),
    (re.compile(r"\*?(?:hắng giọng|khóc thét|khóc nức nở|khóc sụt sịt|sụt sịt|sniff sniff)\*?", re.IGNORECASE), " [hắng giọng] "),
    (re.compile(r"\(\s*(?:hắng giọng|khóc thét|khóc nức nở)\s*\)", re.IGNORECASE), " [hắng giọng] "),
    # Onomatopoeic choked/sobbing markers in the text
    (re.compile(r"\bsniff\s*sniff\b|\bsniff\b", re.IGNORECASE), " [hắng giọng] "),
]

# VieNeu currently documents exactly these inline non-verbal cues. Treat the
# model and source text as untrusted input: unsupported short bracket tokens
# can otherwise be spoken literally or interpreted unpredictably by a backend.
PERMITTED_EMOTION_MARKERS = frozenset({
    "[cười]",
    "[thở dài]",
    "[hắng giọng]",
})
_SHORT_BRACKET_TOKEN_RE = re.compile(r"\[([^\[\]\r\n]{1,16})\]")


def _strip_off_list_markers(text: str) -> str:
    """Remove unsupported short ``[marker]`` tokens, preserving real prose.

    Long bracketed passages (footnotes/citations) are source content rather
    than TTS control tokens and therefore remain untouched. The operation is
    deliberately idempotent because segments may pass through multiple
    emotion layers.
    """
    if not text or "[" not in text:
        return text

    def replace(match: re.Match[str]) -> str:
        token = match.group(0)
        return token if token in PERMITTED_EMOTION_MARKERS else ""

    swept = _SHORT_BRACKET_TOKEN_RE.sub(replace, text)
    # Removing a token between words must not leave doubled horizontal
    # whitespace; preserve newlines because they encode audiobook pauses.
    return re.sub(r"[ \t]{2,}", " ", swept).strip()

# Per-character-tone → emotion markers (applied once at the start of the
# segment, BUT only as a last-resort fallback — content evidence in the
# dialogue text always wins, see `inject_emotions` below).
#
# IMPORTANT: "cheerful" and "warm" are intentionally NOT mapped to "[cười]".
# They describe the voice TIMBRE (how warm/cheerful the voice sounds), not
# the emotion the character is currently expressing. Mapping them to a laugh
# marker caused every line of a "warm" or "cheerful" character to be read
# with a forced laugh — even threats like "Chết tiệt, cậu tốt nhất nên có
# chuyện gì quan trọng".
TONE_TO_EMOTION = {
    "angry":      " [hắng giọng] ",
    "sad":        " [thở dài] ",
    "cold":       "",
    "mysterious": "",
    "calm":       "",
    "cheerful":   "",          # voice timbre, not emotion — do NOT inject [cười]
    "warm":       "",          # voice timbre, not emotion — do NOT inject [cười]
    "unknown":    "",
}

# Tier 2: per-segment LLM emotion taxonomy (one-word output → marker)
LLM_EMOTION_TO_MARKER = {
    "neutral": "",
    "cheerful": " [cười] ",
    "happy": " [cười] ",
    "joy": " [cười] ",
    "laugh": " [cười] ",
    "amused": " [cười] ",
    "sad": " [thở dài] ",
    "sorrow": " [thở dài] ",
    "sigh": " [thở dài] ",
    "regret": " [thở dài] ",
    "angry": " [hắng giọng] ",
    "rage": " [hắng giọng] ",
    "furious": " [hắng giọng] ",
    "shout": " [hắng giọng] ",
    "sneer": " [hắng giọng] ",
    "cold": "",
    "calm": "",
    "mysterious": "",
    "serious": "",
    "unknown": "",
}

# Tier 2 toggle: set ENABLE_LLM_EMOTION=1 in the env to classify segments via oMLX
ENABLE_LLM_EMOTION = os.environ.get("ENABLE_LLM_EMOTION", "0").strip() in ("1", "true", "yes", "on")
# Tier 3a toggle: set USE_LLM_SEGMENTER=1 to delegate both segmentation and
# per-segment emotion to a single oMLX call. Falls back to regex on failure.
USE_LLM_SEGMENTER = os.environ.get("USE_LLM_SEGMENTER", "0").strip() in ("1", "true", "yes", "on")
OMLX_URL = os.environ.get("OMLX_BASE_URL", "http://127.0.0.1:8080/v1").rstrip("/")
OMLX_KEY = os.environ.get("OMLX_API_KEY", "")
OMLX_MODEL = os.environ.get("OMLX_MODEL", "")  # caller may pass via env
# Max chars of chapter text sent to oMLX in one call. Beyond this we chunk.
LLM_SEGMENT_MAX_CHARS = int(os.environ.get("LLM_SEGMENT_MAX_CHARS", "8000"))
# When the LLM-segmenter prefill guard rejects a chunk at LLM_SEGMENT_MAX_CHARS,
# retry with chunks proportionally smaller. Set fraction of original (0 < f < 1).
LLM_SEGMENT_RETRY_FACTOR = float(os.environ.get("LLM_SEGMENT_RETRY_FACTOR", "0.6"))
# Min chunk size we won't go below — protects against infinite shrinking.
LLM_SEGMENT_MIN_CHARS = int(os.environ.get("LLM_SEGMENT_MIN_CHARS", "600"))


def _segmenter_max_tokens(text_len: int) -> int:
    """Compute the LLM-segmenter `max_tokens` budget.

    Priority:
      1. `OMLX_MAX_TOKENS` env var (forwarded from DB Settings.aiMaxTokens
         by the Next.js detectorEnvOverrides). When set, the user is in
         control — clamp to a sane range and use it directly.
      2. Length-based heuristic: long chapters produce 30+ segments with
         verbatim text fields. ~1 token / 1.5 chars of output plus 30 tokens
         per segment. Capped at 8192 — 4B models on M-series generate
         ~50 tokens/sec, so 8K tokens finishes in ~3 min worst case.
    """
    try:
        env_max = int(os.environ.get("OMLX_MAX_TOKENS", ""))
    except (TypeError, ValueError):
        env_max = 0
    if env_max > 0:
        return max(256, min(env_max, 16384))
    return min(8192, 1500 + int(text_len * 0.6))


# Cache: text → marker (so the same dialogue across chapters isn't re-classified)
_LLM_EMOTION_CACHE: dict[str, str] = {}
_LLM_EMOTION_CACHE_MAX = 4096


def _classify_segments_with_llm(segments: list[dict]) -> list[str]:
    """Use oMLX to classify the dominant emotion of each dialogue segment.

    Returns a list of marker strings (one per input segment, in order).
    Narration segments are skipped — they get the per-character tone marker
    only. Falls back to empty strings if the model is unreachable or rejects.

    One oMLX call per call (batched across many segments) keeps latency low.
    """
    if not segments or not ENABLE_LLM_EMOTION:
        return [""] * len(segments)

    # Build the prompt only from dialogue segments; remember original indices.
    dialogue_idx: list[int] = []
    dialogue_texts: list[str] = []
    for i, seg in enumerate(segments):
        if seg.get("kind") != "dialogue":
            continue
        # Use the original (pre-injection) text so the model sees clean prose.
        # If we already injected markers, the segment text contains "[cười]" etc.
        # — strip those for the prompt.
        clean = re.sub(r"\s*\[(?:cười|thở dài|hắng giọng)\]\s*", " ", seg.get("text", ""))
        clean = clean.strip()
        if not clean:
            continue
        dialogue_idx.append(i)
        dialogue_texts.append(clean)

    if not dialogue_texts:
        return [""] * len(segments)

    # Filter out already-cached ones; classify only the rest.
    unknown_positions: list[int] = []  # positions in dialogue_texts needing classification
    unknown_texts: list[str] = []
    cache_results: list[Optional[str]] = [None] * len(dialogue_texts)
    for pos, txt in enumerate(dialogue_texts):
        if txt in _LLM_EMOTION_CACHE:
            cache_results[pos] = _LLM_EMOTION_CACHE[txt]
        else:
            unknown_positions.append(pos)
            unknown_texts.append(txt)

    if unknown_texts:
        try:
            classification = _call_omlx_emotion_batch(unknown_texts)
            for pos_in_unknown, marker in zip(unknown_positions, classification):
                cache_results[pos_in_unknown] = marker
                # Cache the text → marker mapping (LRU-bounded)
                if len(_LLM_EMOTION_CACHE) >= _LLM_EMOTION_CACHE_MAX:
                    _LLM_EMOTION_CACHE.pop(next(iter(_LLM_EMOTION_CACHE)))
                _LLM_EMOTION_CACHE[dialogue_texts[pos_in_unknown]] = marker
        except Exception as e:
            print(f"[emotion] oMLX classify failed: {e}", file=sys.stderr)
            # On failure, return empty markers for the unknowns — fall back to T1.
            for pos_in_unknown in unknown_positions:
                cache_results[pos_in_unknown] = ""

    # Map back to original segment indices
    out = [""] * len(segments)
    for dialogue_pos, original_idx in enumerate(dialogue_idx):
        out[original_idx] = cache_results[dialogue_pos] or ""
    return out


def _call_omlx_emotion_batch(texts: list[str]) -> list[str]:
    """Send a batched prompt to oMLX, return one marker per input text."""
    system_prompt = (
        "/no_think\n"
        "You output ONLY a JSON object. No reasoning, no prose, no markdown.\n"
        "For each numbered segment below, decide the dominant emotion the speaker "
        "is expressing. Choose ONE label per segment from this closed set:\n"
        "neutral, cheerful, sad, angry, sigh, laugh, sneer, cold, calm, mysterious, "
        "serious, warm.\n"
        "Output a JSON object mapping segment index (1-based) to label, like:\n"
        '{"1":"cheerful","2":"sigh","3":"neutral",...}\n'
        "Be concise — never write explanations, never repeat the input."
    )

    # Build the user message. Cap each text to ~400 chars to keep the prompt manageable.
    numbered = "\n".join(f"[{i+1}] {t[:400]}" for i, t in enumerate(texts))

    body = {
        "model": OMLX_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": numbered},
        ],
        "temperature": 0.1,
        "max_tokens": 200 + len(texts) * 6,  # ~6 tokens per label
    }
    headers = {"Content-Type": "application/json"}
    if OMLX_KEY:
        headers["Authorization"] = f"Bearer {OMLX_KEY}"

    with httpx.Client(timeout=60.0) as client:
        r = client.post(f"{OMLX_URL}/chat/completions", json=body, headers=headers)
    if r.status_code != 200:
        raise RuntimeError(f"oMLX {r.status_code}: {r.text[:200]}")
    data = r.json()
    raw = data["choices"][0]["message"]["content"]

    parsed = _parse_emotion_map(raw, expected_n=len(texts))
    return [
        LLM_EMOTION_TO_MARKER.get(parsed.get(i + 1, "neutral").lower().strip(), "")
        for i in range(len(texts))
    ]


def _parse_emotion_map(raw: str, expected_n: int) -> dict[int, str]:
    """Best-effort parse of `{"1":"cheerful","2":"sigh"}` out of LLM output."""
    if not raw:
        return {}
    text = raw.strip()
    # Strip markdown fences if present
    text = re.sub(r"^```(?:json)?\s*\n?", "", text)
    text = re.sub(r"\n?```\s*$", "", text)
    try:
        v = json.loads(text)
        if isinstance(v, dict):
            out = {}
            for k, val in v.items():
                try:
                    idx = int(str(k))
                except (ValueError, TypeError):
                    continue
                out[idx] = str(val)
            return out
    except Exception:
        pass
    # Fallback: search for a JSON object substring
    m = re.search(r"\{[^{}]*\}", text)
    if m:
        try:
            v = json.loads(m.group(0))
            if isinstance(v, dict):
                out = {}
                for k, val in v.items():
                    try:
                        idx = int(str(k))
                    except (ValueError, TypeError):
                        continue
                    out[idx] = str(val)
                return out
        except Exception:
            pass
    return {}


def inject_emotions(text: str, segment_kind: str, character_tone: Optional[str] = None,
                    llm_marker: str = "") -> str:
    """Insert VieNeu emotion markers into the segment text.

    Priority (strongest → weakest signal):
      1. Tier 1: KEYWORD matches in the text itself. STRONGEST — this is
         direct evidence of the emotion in the dialogue content.
      2. Tier 2: per-segment LLM emotion classification. Strong, but can
         disagree with content (e.g. classifies "Chết tiệt" as cheerful
         because the character has a cheerful default voice).
      3. Character tone (from Voice.defaultEmotion). WEAKEST signal —
         describes voice timbre, often contradicts the current line's
         actual emotion.

    Earlier versions applied Tier 2 / tone as a PREFIX before Tier 1 ran,
    which produced contradictory segments like " [cười] <threat> [hắng giọng] ".
    Now Tier 1 wins outright, and Tier 2 / tone only fire when Tier 1
    found nothing. Only dialogue gets the tier-2/tone fallback; narration
    stays neutral so the narrator doesn't get emotions injected on every line.
    """
    out = text

    # ── Tier 1: keyword matches in the CONTENT (strongest signal) ────────
    # IMPORTANT: strip any markers we've already injected before searching,
    # otherwise a pattern like \bhắng giọng\b would match its own prefix and
    # duplicate itself.
    search_text = re.sub(r"\s*\[(?:cười|thở dài|hắng giọng)\]\s*", " ", out)
    inserted = {"[cười]": False, "[thở dài]": False, "[hắng giọng]": False}
    for pattern, marker in KEYWORD_EMOTIONS:
        key = marker.strip()
        if inserted.get(key):
            continue
        if pattern.search(search_text):
            out = out + " " + marker.strip() + " "
            inserted[key] = True

    # If Tier 1 matched anything, we're done — content evidence beats the
    # weaker signals below.
    if out.lstrip().startswith("["):
        return _strip_off_list_markers(out)

    # ── Tier 2: LLM-derived marker (per-segment). Applied as prefix. ─────
    llm = (llm_marker or "").strip()
    if llm:
        out = (llm + " " + out).strip()
        if out.lstrip().startswith("["):
            return _strip_off_list_markers(out)

    # ── Tone fallback: only for dialogue. The character's default tone is a
    # weak signal and must NOT override content evidence or LLM classification.
    if segment_kind == "dialogue" and character_tone:
        tone_marker = TONE_TO_EMOTION.get(character_tone, "")
        if tone_marker:
            out = (tone_marker + out).strip()
    return _strip_off_list_markers(out)

# Built-in VieNeu voices — used when CHARACTER_MAP says a character has no
# custom voice but their "name" matches one of these.
BUILTIN_VIENEU = {
    "Ngọc Lan", "Gia Bảo", "Thái Sơn", "Đức Trí", "Mỹ Duyên",
    "Trúc Ly", "Xuân Vĩnh", "Trọng Hữu", "Bình An", "Ngọc Linh",
}

# Gender of each builtin VieNeu voice. Used to resolve Vietnamese pronouns
# (Cô / Anh / Em / Chị / Ông / Bà …) to the most recently mentioned
# same-gender character. Mirrors VIENEU_PROFILES in TS
# (app/ebook-converter/src/lib/ai/voice-selector.ts) — keep in sync.
# Canonical VieNeu builtin voices (22 presets in voices_v3_turbo.json).
# Kept in sync with app/ebook-converter/src/lib/tts/vieneu-voices.ts.
VIENEU_GENDER = {
    # Female
    "Trúc Ly":    "female",
    "Ngọc Linh":  "female",
    "Đoan Trang": "female",
    "Mai Anh":    "female",
    "Thục Đoan":  "female",
    "Hồng Đào":   "female",
    "Thùy Dung":  "female",
    "Ngọc Trân":  "female",
    "Mỹ Duyên":   "female",
    "Quỳnh Anh":  "female",
    "Kim Thanh":  "female",
    "Ngọc Huyền": "female",
    # Male
    "Phạm Tuyên": "male",
    "Xuân Vĩnh":  "male",
    "Thái Sơn":   "male",
    "Thanh Bình": "male",
    "Minh Đức":   "male",
    "Ngọc Ngạn":  "male",
    "Minh Triết": "male",
    "Quang Sơn":  "male",
    "Đức Trí":    "male",
    "Adam":       "male",
}

def _voice_gender(voice_name: str) -> str:
    """Return 'female' / 'male' / 'unknown' for a voice display name.

    Looks up the canonical VieNeu builtin map first, then falls back to a
    substring check for cloned voices that include the original speaker's
    name in the display label (rare but possible). Returns 'unknown' when
    nothing matches so pronoun resolution skips that character rather than
    making an unfounded guess.
    """
    if not voice_name:
        return "unknown"
    direct = VIENEU_GENDER.get(voice_name.strip())
    if direct:
        return direct
    lower = voice_name.lower()
    for vn, g in VIENEU_GENDER.items():
        if vn.lower() in lower:
            return g
    return "unknown"

# ── Character/voice map (loaded from env) ──────────────────────────────────
def _load_character_map() -> dict:
    raw = os.environ.get("CHARACTER_MAP", "")
    if not raw:
        return {"voices_by_id": {}, "characters": [], "default_voice_id": None}
    try:
        return json.loads(raw)
    except Exception as e:
        print(f"[warn] CHARACTER_MAP parse failed: {e}", file=sys.stderr)
        return {"voices_by_id": {}, "characters": [], "default_voice_id": None}


def _load_voice_plan() -> dict:
    """Optional per-sentence voice plan produced by the app's Voice Assign Editor.

    Env var VOICE_PLAN is a JSON array of { "text": str, "voiceId": str|null }.
    A segment whose (cleaned) text matches a plan entry uses that voiceId,
    overriding the character auto-detection. A null voiceId means "use the
    narration (default) voice". When VOICE_PLAN is unset the function is a
    no-op and the generator behaves exactly as before.

    Returns a dict keyed by normalized segment text → voiceId (str) or None.
    """
    raw = os.environ.get("VOICE_PLAN", "")
    if not raw:
        return {}
    try:
        rows = json.loads(raw)
    except Exception as e:
        print(f"[warn] VOICE_PLAN parse failed: {e}", file=sys.stderr)
        return {}
    plan: dict = {}
    for row in rows:
        text = (row.get("text") or "").strip().lower()
        if not text:
            continue
        plan[text] = row.get("voiceId")  # may be None → narration
    return plan


def _resolve_voice_plan_override(
    text: str,
    plan: dict,
    cmap: dict,
) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """If `text` matches a VOICE_PLAN entry, return (voice_id, voice_name, tone)
    for that assignment. Returns (None, None, None) when there is no match so the
    caller falls through to the normal character/attribution resolution."""
    key = text.strip().lower()
    if key not in plan:
        return (None, None, None)
    voice_id = plan[key]
    if not voice_id:
        # Explicit narration override → default voice (or builtin default).
        default_voice_id = cmap.get("default_voice_id")
        if default_voice_id:
            v = cmap["voices_by_id"].get(default_voice_id, {})
            if v.get("isBuiltinVieNeu"):
                return (default_voice_id, v.get("name"), v.get("defaultEmotion"))
            return (default_voice_id, None, v.get("defaultEmotion"))
        return (None, None, None)
    voice = cmap["voices_by_id"].get(voice_id)
    if not voice:
        return (None, None, None)
    tone = voice.get("defaultEmotion")
    if voice.get("isBuiltinVieNeu"):
        return (voice_id, voice.get("name"), tone)
    return (voice_id, None, tone)


def _resolve_segment_voice(char_name: Optional[str], cmap: dict, default_voice_id: Optional[str]) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Decide which voice to use for a segment.
    Returns (voice_id_for_db, voice_name_for_vieneu_or_none, character_tone).
    voice_name_for_vieneu is set when the character is assigned a BUILTIN VieNeu voice
    (its name in the Voice table matches BUILTIN_VIENEU) so we pass it as `voice`
    to the unified server.
    character_tone is the user-defined defaultEmotion for the character's voice.
    """
    tone = None
    if not char_name:
        if default_voice_id:
            v = cmap["voices_by_id"].get(default_voice_id, {})
            tone = v.get("defaultEmotion") if isinstance(v, dict) else None
            if v.get("isBuiltinVieNeu"):
                return (default_voice_id, v["name"], tone)
        return (default_voice_id, None, tone)

    char_record = next((c for c in cmap["characters"] if c["name"] == char_name), None)
    if not char_record or not char_record.get("voiceId"):
        if default_voice_id:
            v = cmap["voices_by_id"].get(default_voice_id, {})
            tone = v.get("defaultEmotion") if isinstance(v, dict) else None
            if v.get("isBuiltinVieNeu"):
                return (default_voice_id, v["name"], tone)
        return (default_voice_id, None, tone)

    voice_id = char_record["voiceId"]
    voice = cmap["voices_by_id"].get(voice_id)
    if not voice:
        return (default_voice_id, None, None)
    tone = voice.get("defaultEmotion") if isinstance(voice, dict) else None
    if voice.get("isBuiltinVieNeu"):
        return (voice_id, voice["name"], tone)
    return (voice_id, None, tone)


# ── Chapter splitting ──────────────────────────────────────────────────────
BLOCK_TAG_RE = re.compile(
    r"</?(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|"
    r"footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)\b[^>]*>",
    re.IGNORECASE,
)
TAG_RE = re.compile(r"<[^>]+>")
HORIZONTAL_WS_RE = re.compile(r"[^\S\r\n]+")
EXCESS_NEWLINES_RE = re.compile(r"\n\s*\n+")


def strip_html(html: str) -> str:
    """Convert XHTML to readable text while retaining block boundaries.

    Attribution is paragraph-indexed. Flattening every tag and then applying
    ``\s+`` used to collapse a chapter into one mega-paragraph, so a parser
    result for one speaker could leak to every quote. Entity decoding also
    prevents the synthesizer from literally reading ``&amp;``/``&quot;``.
    """
    text = re.sub(r"<(?:script|style|head)\b[^>]*>[\s\S]*?</(?:script|style|head)>", " ", html, flags=re.IGNORECASE)
    text = BLOCK_TAG_RE.sub("\n", text)
    text = TAG_RE.sub(" ", text)
    text = html_module_unescape(text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = HORIZONTAL_WS_RE.sub(" ", text)
    text = re.sub(r" *\n *", "\n", text)
    return EXCESS_NEWLINES_RE.sub("\n\n", text).strip()


def html_module_unescape(text: str) -> str:
    """Small wrapper kept separate for focused tests/mocking."""
    return html.unescape(text)


# Explicitly non-spoken quoted text must stay on the narrator voice. These
# cues cover silent thought/inner monologue and written/displayed material;
# audible cues such as "thì thầm", "lẩm bẩm" and "nói thầm" intentionally
# remain in SPEECH_VERBS and are still eligible for character voices.
SILENT_QUOTE_CUE_RE = re.compile(
    r"(?:nghĩ thầm|thầm nghĩ|tự nhủ|thầm nhủ|tự hỏi|trong (?:lòng|đầu)|"
    r"ý nghĩ|suy nghĩ|nghĩ rằng|nghĩ bụng)",
    re.IGNORECASE,
)
WRITTEN_QUOTE_CUE_RE = re.compile(
    r"(?:bức thư|lá thư|thư viết|tin nhắn|dòng chữ|tấm biển|biển báo|"
    r"tiêu đề|tựa đề|cuốn sách|quyển sách|tác phẩm|đoạn trích|trích dẫn|"
    r"mật khẩu|cụm từ)\b",
    re.IGNORECASE,
)
AUDIBLE_QUOTE_CUE_RE = re.compile(SPEECH_VERBS, re.IGNORECASE)


def _last_match_end(pattern: re.Pattern[str], text: str) -> int:
    matches = list(pattern.finditer(text))
    return matches[-1].end() if matches else -1


def is_non_spoken_quote(
    plain: str,
    q_start: int,
    q_end: int,
    prev_quote_end: int = 0,
) -> bool:
    """Return true for thoughts, letters, titles and other silent quotes.

    If a later audible verb follows a thought cue (``nghĩ rồi nói: “…”``),
    the audible cue wins. For post-quote attributions, the first nearby cue
    wins (``“…” cô nghĩ`` versus ``“…” cô nói``).
    """
    before_start = max(prev_quote_end, q_start - 180, plain.rfind("\n", 0, q_start) + 1)
    before = plain[before_start:q_start]
    after = plain[q_end:min(len(plain), q_end + 100)].split("\n", 1)[0]

    silent_end = _last_match_end(SILENT_QUOTE_CUE_RE, before)
    audible_end = _last_match_end(AUDIBLE_QUOTE_CUE_RE, before)
    if silent_end >= 0 and silent_end > audible_end:
        return True

    # Written/displayed text is narrator material unless explicitly read
    # aloud or spoken after the written-material cue.
    written_end = _last_match_end(WRITTEN_QUOTE_CUE_RE, before)
    if written_end >= 0 and audible_end <= written_end:
        return True

    silent_after = SILENT_QUOTE_CUE_RE.search(after)
    audible_after = AUDIBLE_QUOTE_CUE_RE.search(after)
    if silent_after and (not audible_after or silent_after.start() < audible_after.start()):
        return True
    return False


def split_into_segments(html_body: str, cmap: dict) -> list[dict]:
    """
    Walk the body text and yield segments:
      { kind: 'narration'|'dialogue', text: str, character: str|None,
        voice_id: str|None, voice_name: str|None,
        emotion?: str  (set by Tier 3a when LLM segmenter is used) }
    Dialogue detection: any quoted span (Vietnamese or ASCII quotes).
    Attribution: looks at the preceding narration for a character name (or alias).
    Narration is further split into ≤ NARRATION_CHUNK_TARGET-char chunks at
    sentence boundaries so each TTS call stays short.

    Pipeline (Tier 1 / 3a):
      1. Tier 3a — oMLX segmentation + emotion (opt-in via USE_LLM_SEGMENTER).
      2. Tier 1  — regex fallback (always runs as the last resort).

    The previous Tier 3b VnCoreNLP parser layer was retired on 2026-07-12
    (VnCoreNLP sidecar removed). The regex/3a path now drives attribution
    off paragraph offsets + conversation-state memory alone.
    """
    plain = strip_html(html_body)
    if not plain:
        return []

    # Paragraph offsets feed the stateful scene memory (`_update_state`) by
    # tagging each quote with the paragraph index it falls in. Cheap to
    # compute — kept even after the Tier 3b parser removal.
    paragraph_offsets: list[tuple[int, int, str]] = []
    if ATTRIBUTION_ENGINE == "conversation_v3":
        paragraph_offsets = split_paragraphs_with_offsets(plain)

    # ── Tier 3a: LLM-based segmentation + emotion ────────────────────────
    if USE_LLM_SEGMENTER:
        try:
            llm_segs = _llm_segment_chapter(plain, cmap,
                                            paragraph_offsets=paragraph_offsets)
            if llm_segs:
                # Resolve voices + inject emotions for each segment
                char_tones = _char_tone_map(cmap)
                default_voice_id = cmap.get("default_voice_id")
                for s in llm_segs:
                    char = s.get("character")
                    s["voice_id"], s["voice_name"], _ = _resolve_segment_voice(
                        char, cmap, default_voice_id
                    )
                    # If the LLM gave us an emotion, use it as the llm_marker
                    emo = (s.get("emotion") or "").strip().lower()
                    llm_marker = LLM_EMOTION_TO_MARKER.get(emo, "")
                    char_tone = char_tones.get(char) if char else None
                    s["text"] = inject_emotions(
                        s["text"], s["kind"], char_tone, llm_marker=llm_marker
                    )
                return llm_segs
        except Exception as e:
            print(f"[tier3a] LLM segmenter failed, falling back to regex: {e}",
                  file=sys.stderr)

    # ── Regex path (existing, now factored as _regex_segment_chapter) ───
    return _regex_segment_chapter(plain, cmap,
                                  paragraph_offsets=paragraph_offsets)


def _char_tone_map(cmap: dict) -> dict[str, str]:
    """Build {canonical_name: defaultEmotion} from the character map.

    Per-character defaultEmotion takes precedence over the shared Voice's
    defaultEmotion, so two characters sharing a voice keep independent tones.
    """
    tones: dict[str, str] = {}
    for c in cmap.get("characters", []):
        v_id = c.get("voiceId")
        if not v_id:
            continue
        v = cmap["voices_by_id"].get(v_id, {})
        # Character-level emotion wins; fall back to the voice's.
        tone = (c.get("defaultEmotion") if isinstance(c, dict) else None) \
            or (v.get("defaultEmotion") if isinstance(v, dict) else None)
        if tone:
            tones[c["name"]] = tone
    return tones


# ── Tier 3a: LLM-based chapter segmentation + emotion ─────────────────────
def _character_context_block(cmap: dict) -> str:
    """Build the canonical character list + aliases we'll hand to the LLM."""
    lines: list[str] = []
    for c in cmap.get("characters", []):
        aliases = c.get("aliases") or []
        alias_part = f" (còn gọi: {', '.join(aliases)})" if aliases else ""
        lines.append(f"- {c['name']}{alias_part}")
    return "\n".join(lines) if lines else "(none — treat all dialogue as narrator)"


def _match_character_name(name: str, cmap: dict) -> Optional[str]:
    """Resolve an LLM-emitted character name back to a canonical entry.
    Falls back to case-insensitive substring, then alias lookup."""
    if not name:
        return None
    cleaned = name.strip()
    if not cleaned:
        return None
    # Exact match
    for c in cmap.get("characters", []):
        if c["name"] == cleaned:
            return c["name"]
    # Case-insensitive match
    low = cleaned.lower()
    for c in cmap.get("characters", []):
        if c["name"].lower() == low:
            return c["name"]
        for a in c.get("aliases") or []:
            if a.lower() == low:
                return c["name"]
    # First-name prefix — many Vietnamese names are referenced by given name only
    for c in cmap.get("characters", []):
        tokens = c["name"].lower().split()
        if tokens and tokens[-1] == low:
            return c["name"]
        for a in c.get("aliases") or []:
            if a.lower().split()[-1] == low:
                return c["name"]
    # Substring match as last resort (helps when LLM re-spells)
    for c in cmap.get("characters", []):
        if low in c["name"].lower():
            return c["name"]
        for a in c.get("aliases") or []:
            if low in a.lower():
                return c["name"]
    return None


def _chunk_plain_by_paragraphs(plain: str, max_chars: int) -> list[str]:
    """Split chapter text into ≤ max_chars chunks at paragraph boundaries.

    We never split mid-sentence — every chunk holds complete sentences. Falls
    back to sentence boundaries when a single paragraph exceeds the cap.
    Returns the chunks as a list, in source order."""
    if not plain or len(plain) <= max_chars:
        return [plain] if plain else []
    # First split on newlines (paragraphs)
    paragraphs = re.split(r"\n\s*\n", plain)
    # If no paragraph breaks (single dense paragraph), synthesize them by
    # splitting on sentence boundaries.
    if len(paragraphs) == 1:
        sentences = re.split(r"(?<=[.!?。！？…])\s+", paragraphs[0])
        paragraphs = [s.strip() for s in sentences if s.strip()]

    chunks: list[str] = []
    buf = ""
    for p in paragraphs:
        p = p.strip()
        if not p:
            continue
        # Single paragraph larger than max → emit as its own chunk and split
        # it on sentences inside the next stage.
        if len(p) > max_chars:
            if buf:
                chunks.append(buf.strip())
                buf = ""
            chunks.append(p)
            continue
        if len(buf) + len(p) + 2 <= max_chars:
            buf = (buf + "\n\n" + p).strip()
        else:
            if buf:
                chunks.append(buf.strip())
            buf = p
    if buf.strip():
        chunks.append(buf.strip())
    return chunks


def _normalize_segment(item: dict, cmap: dict) -> Optional[dict]:
    """Validate + normalize one segment object from the LLM. Returns None
    if the segment has no usable text.

    Tolerant of model drift: maps kind/emotion aliases back to the closed set
    (e.g., "speech"/"quote" → "dialogue", "emotion"/"silence" → "narration",
    "happy"/"joy" → "cheerful", "sorrow"/"regret" → "sad").
    """
    text = (item.get("text") or "").strip()
    if not text:
        return None
    # kind: map aliases to closed set
    raw_kind = (item.get("kind") or "narration").strip().lower()
    KIND_ALIASES = {
        "narration": "narration", "narrative": "narration", "description": "narration",
        "scene": "narration", "silence": "narration", "action": "narration",
        "thought": "narration", "emotion": "narration",
        "dialogue": "dialogue", "dialog": "dialogue", "speech": "dialogue",
        "quote": "dialogue", "line": "dialogue",
    }
    kind = KIND_ALIASES.get(raw_kind, "narration")
    # emotion: map aliases + default to neutral
    raw_emo = (item.get("emotion") or "").strip().lower() or "neutral"
    EMO_ALIASES = {
        "neutral": "neutral", "calm": "neutral", "calmly": "neutral",
        "cheerful": "cheerful", "happy": "cheerful", "joy": "cheerful",
        "joyful": "cheerful", "laugh": "cheerful", "amused": "cheerful",
        "warm": "cheerful",
        "sad": "sad", "sorrow": "sad", "regret": "sad", "sigh": "sad",
        "angry": "angry", "rage": "angry", "furious": "angry",
        "shout": "angry", "sneer": "angry", "irritated": "angry",
        "cold": "cold", "coldly": "cold", "mysterious": "mysterious",
        "serious": "serious", "stern": "serious",
    }
    emo = EMO_ALIASES.get(raw_emo, "neutral")
    # Resolve character name back to canonical form (only for dialogue)
    char_raw = (item.get("character") or "").strip()
    character = _match_character_name(char_raw, cmap) if kind == "dialogue" else None
    return {"kind": kind, "text": text, "character": character, "emotion": emo}


def _llm_segment_chunk(plain_chunk: str, cmap: dict, chunk_max: int) -> list[dict]:
    """Segment one chunk via oMLX. Returns normalized segments."""
    characters = _character_context_block(cmap)
    raw_list = _call_omlx_segmenter(plain_chunk, characters, chunk_max)
    out: list[dict] = []
    for item in raw_list:
        seg = _normalize_segment(item, cmap)
        if not seg:
            continue
        # Cap very long narration segments at sentence boundaries
        if seg["kind"] == "narration" and len(seg["text"]) > NARRATION_CHUNK_TARGET:
            sentence_re = re.compile(r"([.!?。！？]+)\s+")
            parts: list[str] = []
            buf = ""
            for piece in sentence_re.split(seg["text"]):
                if sentence_re.match(piece + " "):
                    if buf:
                        buf += piece
                        if len(buf) >= 40:
                            parts.append(buf.strip())
                            buf = ""
                    else:
                        buf = piece
                else:
                    if len(buf) + len(piece) > NARRATION_CHUNK_TARGET and buf:
                        parts.append(buf.strip())
                        buf = piece
                    else:
                        buf += piece
            if buf.strip():
                parts.append(buf.strip())
            for p in parts:
                if p:
                    out.append({"kind": "narration", "text": p, "character": None,
                                "emotion": seg["emotion"]})
        else:
            out.append(seg)
    return out


def _llm_segment_chapter(
    plain: str,
    cmap: dict,
    *,
    paragraph_offsets: Optional[list[tuple[int, int, str]]] = None,
) -> list[dict]:
    """Chunked oMLX segmentation. Splits into ≤ LLM_SEGMENT_MAX_CHARS chunks at
    paragraph boundaries, sends each to oMLX, and stitches the results.

    On prefill-guard rejection (oMLX 400 with 'predicted peak' in the message),
    the chunk size shrinks by LLM_SEGMENT_RETRY_FACTOR and we retry — once.
    If a chunk still fails, we drop it (regex fallback will run later if the
    whole chapter returns empty)."""
    if not plain:
        return []
    base_chunk = LLM_SEGMENT_MAX_CHARS
    chunks = _chunk_plain_by_paragraphs(plain, base_chunk)
    if not chunks:
        return []
    if len(chunks) > 1:
        print(f"[tier3a] split chapter ({len(plain)} chars) into {len(chunks)} "
              f"chunks of ≤{base_chunk} chars each", file=sys.stderr)

    all_segs: list[dict] = []
    for idx, chunk in enumerate(chunks):
        current_max = base_chunk
        segs: list[dict] = []
        for attempt in range(2):  # up to 2 attempts (original + 1 retry smaller)
            try:
                segs = _llm_segment_chunk(chunk, cmap, current_max)
                break
            except Exception as e:
                msg = str(e)
                # If the prefill guard rejected (memory), shrink & retry once
                if ("prefill memory guard" in msg or "predicted peak" in msg) \
                        and attempt == 0 \
                        and current_max > LLM_SEGMENT_MIN_CHARS:
                    new_max = max(LLM_SEGMENT_MIN_CHARS,
                                  int(current_max * LLM_SEGMENT_RETRY_FACTOR))
                    print(f"[tier3a] chunk {idx+1}/{len(chunks)}: oMLX prefill "
                          f"rejected at {current_max} chars, retrying at "
                          f"{new_max} chars", file=sys.stderr)
                    current_max = new_max
                    continue
                # Non-recoverable error: skip this chunk
                print(f"[tier3a] chunk {idx+1}/{len(chunks)} failed, skipping: {e}",
                      file=sys.stderr)
                break
        all_segs.extend(segs)
    return all_segs


# Closed-set emotion taxonomy the segmenter is allowed to emit.
# Mapped to TTS markers downstream via LLM_EMOTION_TO_MARKER.
_SEGMENTER_EMOTIONS = (
    "neutral, cheerful, sad, angry, sigh, laugh, sneer, cold, calm, mysterious, "
    "serious, warm"
)


def _call_omlx_segmenter(plain: str, characters_block: str, chunk_max_chars: int) -> list[dict]:
    """Send one chunk of chapter text to oMLX with a JSON-mode prompt asking
    it to return [{text, kind, character, emotion}, ...] segments.

    Raises RuntimeError on network/HTTP failure or if the LLM produces no
    parseable JSON array. The chunk_max_chars is applied as a hard cap on
    the input length we send (safety net; caller usually pre-chunks)."""
    text = plain[:chunk_max_chars]
    if len(plain) > chunk_max_chars:
        print(f"[tier3a] WARNING: chunk exceeds {chunk_max_chars} chars, "
              f"truncating input to fit", file=sys.stderr)

    system_prompt = (
        "You segment Vietnamese text into audiobook chunks. Respond with a JSON array ONLY.\n"
        'Format strictly: [{"text":"...","kind":"narration","character":"","emotion":"neutral"}, ...]\n'
        "RULES:\n"
        '- Always use double quotes for keys AND string values (valid JSON).\n'
        "- Every character field is either one of the names listed, or empty string \"\" for narration.\n"
        "- Every kind field is exactly \"narration\" or \"dialogue\".\n"
        f"- Every emotion field is exactly one of: {_SEGMENTER_EMOTIONS}\n"
        "- text field must be a VERBATIM substring from the input. Do NOT paraphrase or summarize.\n"
        "- Preserve order. Cover the entire input — every sentence in exactly one segment.\n"
        "- For a quoted span, strip the opening/closing quotes from the text field and use kind=dialogue.\n"
        "- ATTRIBUTION STRICT: Only set the character field on a dialogue segment if the\n"
        "  character is actually SPEAKING that line. A Vietnamese speech verb MUST appear\n"
        "  within ~80 chars BEFORE the quote (nói / hỏi / đáp / kêu / thì thầm / quát / hét /\n"
        "  lẩm bẩm / trả lời / gọi / thét / lên tiếng / cất tiếng / mở miệng / la lên / gào /\n"
        "  tiếp lời / nói tiếp / khẽ nói / hỏi lại), OR within ~40 chars AFTER the quote (same\n"
        "  verbs, or a dash-attribution pattern: `\"…\" — Name` or `\"…\" Name nói:`).\n"
        "- CLOSEST-SPEAKER-WINS: When multiple character names appear in the BEFORE\n"
        "  window, the speaker is the name with the SMALLEST name-to-verb distance\n"
        "  (closest to the speech verb), NOT the first name that appears in the text.\n"
        "  Example: in `Y Đằng Long cùng Y Đằng Ưu Nhi bàn về chuyện này. Y Đằng Long nói: \"...\"`\n"
        "  Long speaks (the SECOND `Long` is closest to `nói`), NOT Ưu Nhi.\n"
        "- Names that appear as OBJECTS of verbs (nhìn / thấy / gặp / với / của / cho / cùng /\n"
        "  gọi / kể / về / bằng / từ / đến / đối với / về phía) are NOT the speaker — leave\n"
        "  character empty. Example: `Long nhìn Ưu Nhi rồi nói: \"...\"` → speaker = Long,\n"
        "  not Ưu Nhi (Ưu Nhi is the object of `nhìn`).\n"
        "- Names that follow a SENTENCE-BREAK (period + space) are usually a new subject\n"
        "  and the speaker of the next speech verb. Example: `Long đứng im. Ưu Nhi nói: \"...\"`\n"
        "  → speaker = Ưu Nhi (new sentence, new subject).\n"
        "- Narration that merely MENTIONS a character must NOT trigger that character's voice.\n"
        "- When in doubt (no clear speech verb attached to the quote), leave character empty\n"
        "  so the segment falls back to the narrator's default voice.\n"
        "- Output ONLY the JSON array. No comments, no markdown, no explanation.\n"
    )

    user_prompt = (
        "CHARACTERS IN THIS BOOK:\n"
        f"{characters_block}\n\n"
        "CHAPTER TEXT TO SPLIT:\n"
        f"{text}\n\n"
        "OUTPUT (JSON array only):"
    )

    body = {
        "model": OMLX_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        # Generous budget — long chapters can produce 30+ segments, and JSON
        # with verbatim text fields is verbose. Estimate ~1 token / 1.5 chars
        # of output plus ~30 tokens / segment for metadata + JSON overhead.
        # 2026-09-01: honor OMLX_MAX_TOKENS (forwarded from DB
        # Settings.aiMaxTokens by the Next.js detectorEnvOverrides) when set;
        # fall back to the length-based heuristic so direct CLI usage still
        # produces a sensible budget. Capped at 16384 — past that the
        # gateway can OOM and a chapter that long needs chunking anyway.
        "max_tokens": _segmenter_max_tokens(len(text)),
    }
    headers = {"Content-Type": "application/json"}
    if OMLX_KEY:
        headers["Authorization"] = f"Bearer {OMLX_KEY}"

    with httpx.Client(timeout=180.0) as client:
        r = client.post(f"{OMLX_URL}/chat/completions", json=body, headers=headers)
    if r.status_code != 200:
        raise RuntimeError(f"oMLX {r.status_code}: {r.text[:200]}")
    data = r.json()
    raw = data["choices"][0]["message"]["content"]
    parsed = _parse_segment_list(raw)
    if not parsed:
        raise RuntimeError("LLM segmenter returned no parseable JSON array")
    return parsed


def _parse_segment_list(raw: str) -> list[dict]:
    """Best-effort parse of a JSON array of segment objects out of LLM output.

    Tolerant of:
      - clean JSON arrays
      - markdown-fenced JSON arrays
      - garbage prefix/suffix around the JSON
      - non-standard variants emitted by smaller models (unquoted keys/values,
        trailing commas, single quotes) — we recover field-by-field via regex.
    """
    if not raw:
        return []
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*\n?", "", text)
    text = re.sub(r"\n?```\s*$", "", text)

    # 1. clean JSON array
    try:
        v = json.loads(text)
        if isinstance(v, list):
            return [x for x in v if isinstance(x, dict)]
    except Exception:
        pass

    # 2. JSON array substring
    m = re.search(r"\[[\s\S]*\]", text)
    if m:
        try:
            v = json.loads(m.group(0))
            if isinstance(v, list):
                return [x for x in v if isinstance(x, dict)]
        except Exception:
            pass

    # 3. Loose pseudo-JSON: extract top-level {...} blocks and pull fields via
    #    tolerant regex (handles unquoted keys, single quotes, etc.)
    items: list[dict] = []
    for obj_m in re.finditer(r"\{[^{}]*\}", text):
        obj_text = obj_m.group(0)
        d: dict = {}
        for field in ("text", "kind", "character", "emotion"):
            v_m = re.search(
                rf'["\']?{field}["\']?\s*:\s*(?:["\']*([^"\']*)["\']|([A-Za-z_0-9\-]+))',
                obj_text,
            )
            if v_m:
                d[field] = v_m.group(1) if v_m.group(1) is not None else v_m.group(2) or ""
        if d:
            items.append(d)
    return items

def _regex_segment_chapter(
    plain: str,
    cmap: dict,
    *,
    paragraph_offsets: Optional[list[tuple[int, int, str]]] = None,
) -> list[dict]:
    """Original regex-based splitter. Kept as a Tier-3a fallback when oMLX is
    unavailable or rejects. Same shape as `split_into_segments`'s return."""
    # Build alias → canonical-name lookup
    char_aliases: dict[str, str] = {}
    char_gender: dict[str, str] = {}   # canonical → 'female' | 'male' | 'unknown'
    char_tones = _char_tone_map(cmap)
    for c in cmap.get("characters", []):
        canonical = c["name"]
        for alias in [c["name"]] + (c.get("aliases") or []):
            char_aliases[alias.lower()] = canonical
        # Prefer persisted Character.gender; fall back to the voice builtin
        # name for older character maps that do not include gender.
        voice_id = c.get("voiceId")
        voice = cmap.get("voices_by_id", {}).get(voice_id) if voice_id else None
        builtin = (voice or {}).get("builtinName") or (voice or {}).get("name") or ""
        persisted_gender = c.get("gender")
        char_gender[canonical] = (
            persisted_gender if persisted_gender in ("female", "male")
            else _voice_gender(builtin)
        )

    default_voice_id = cmap.get("default_voice_id")

    # Find every quoted span in order
    quote_spans = find_quote_spans(plain)
    segments: list[dict] = []
    cursor = 0

    def emit_narration(text: str, character: Optional[str] = None) -> None:
        """Emit narration as one or more chunks split at sentence boundaries."""
        text = text.strip()
        if not text:
            return
        char_tone = char_tones.get(character) if character else None
        if len(text) <= NARRATION_CHUNK_TARGET:
            vid, vname, _ = _resolve_segment_voice(character, cmap, default_voice_id)
            injected = inject_emotions(text, "narration", char_tone)
            segments.append({"kind": "narration", "text": injected, "character": character,
                              "voice_id": vid, "voice_name": vname})
            return
        # Split at sentence boundaries (period, question mark, exclamation in VN)
        sentence_re = re.compile(r"([.!?。！？]+)\s+")
        parts: list[str] = []
        buf = ""
        for chunk in sentence_re.split(text):
            if sentence_re.match(chunk + " "):
                if buf:
                    buf += chunk
                    if len(buf) >= 40:
                        parts.append(buf.strip())
                        buf = ""
                else:
                    buf = chunk
            else:
                if len(buf) + len(chunk) > NARRATION_CHUNK_TARGET and buf:
                    parts.append(buf.strip())
                    buf = chunk
                else:
                    buf += chunk
        if buf.strip():
            parts.append(buf.strip())
        for p in parts:
            if not p: continue
            vid, vname, _ = _resolve_segment_voice(character, cmap, default_voice_id)
            injected = inject_emotions(p, "narration", char_tone)
            segments.append({"kind": "narration", "text": injected, "character": character,
                              "voice_id": vid, "voice_name": vname})

    # Build the sorted name list once — used by both regex fallback and the
    # Tier-3a prompt. Longest aliases first so longer names win on ties.
    sorted_aliases = sorted(char_aliases.items(), key=lambda kv: -len(kv[0]))

    # Pre-compile the candidate-names alternation regex for find_speaker_for_quote.
    # Each alias is escaped; longest first.
    names_alt = "|".join(re.escape(a) for a, _ in sorted_aliases)

    def find_speaker_for_quote(q_start: int, q_end: int, prev_quote_end: int) -> Optional[str]:
        """Strict speaker attribution — port of EbookReader.tsx findSpeakerForQuote.

        Returns the canonical character name (matching a key in char_aliases)
        or None to fall back to the default (narrator) voice. Requires a
        SPEECH_VERBS match in the BEFORE or AFTER window — narration that
        merely mentions a character does NOT trigger that character's voice.
        """
        # BEFORE window: when a previous quote exists in this paragraph, the
        # narrator context for THIS quote is the narration between the two
        # quotes — not just the last 80 chars. The speaker is often mentioned
        # at the start of that narration, e.g.
        #   '"…một tiếng?" Anh đánh nhẹ vào mông cô, "Sai!"'
        #     → "Anh" is at the start of the gap, before the 80-char cutoff.
        # For multi-quote paragraphs we use the full gap (up to
        # ATTR_WINDOW_BEFORE) so the name at the start of the gap is still
        # reachable. For the first/only quote in a paragraph the 80-char
        # window is enough.
        if prev_quote_end > 0:
            before_start = prev_quote_end
        else:
            before_start = max(0, q_start - ATTR_WINDOW_BEFORE)
        before = plain[before_start:q_start]
        # AFTER window: 40 chars after this quote's close
        after_end = min(len(plain), q_end + ATTR_WINDOW_AFTER)
        after = plain[q_end:after_end]

        # Word-boundary approximation for Vietnamese letters (Latin with
        # diacritics). Standard re has no \p{L}; this range covers À-ỹ
        # (U+00C0-U+1EF9) which includes all common Vietnamese letters.
        WB = r"[^A-Za-zÀ-ỹ]"
        # Allow up to ATTR_NAME_TO_VERB_GAP non-quote chars between name and
        # speech verb. A second character name appearing between candidate and
        # verb means someone ELSE is the (closer) speaker; we filter those
        # matches out via _gap_has_other_name() below.
        NO_QUOTE_INNER = rf"[^{''.join(QUOTE_OPEN_CHARS)}{''.join(QUOTE_CLOSE_CHARS)}]{{0,{ATTR_NAME_TO_VERB_GAP}}}"

        # ── BEFORE: collect ALL name + (gap) + speech verb matches, then
        # pick the one whose name-to-verb distance is SMALLEST (the closer
        # speaker wins). A wider gap just won't be picked over a tighter one,
        # so over-attribution from a too-permissive gap is naturally avoided.
        # We scan EACH name occurrence independently — re.finditer is
        # non-overlapping, so it would stop at the first match and miss
        # closer-name patterns that overlap with the first match's range.
        # ──────────────────────────────────────────────────────────────────
        # Use a regex that matches a name (with WB before, optional WB after)
        # and verify each match against a separate verb-search regex on the
        # tail of the BEFORE window. We allow the name to be FOLLOWED by a
        # speech verb directly (no WB), so "Y Đằng Long nói:" matches.
        # Longer names take precedence over shorter ones (Long matches inside
        # Y Đằng Long → we accept the longer one when both overlap).
        re_name = re.compile(rf"(?:^|{WB})({names_alt})", re.IGNORECASE)
        re_verb = re.compile(
            rf"({WB}{NO_QUOTE_INNER})({SPEECH_VERBS})",
            re.IGNORECASE,
        )
        best_dist: Optional[int] = None
        best_name: Optional[str] = None
        best_start: Optional[int] = None
        # Walk every name occurrence and look for a speech verb within
        # ATTR_NAME_TO_VERB_GAP chars AFTER it.
        for m in re_name.finditer(before):
            matched_name = m.group(1)
            name_start = m.start(1)
            name_end = m.end(1)
            # Object-marker filter: if the 12 chars just BEFORE the candidate
            # name end with an object marker (nhìn / với / của / …), this name
            # is being USED AS OBJECT of an earlier verb, not as the speaker.
            before_name = before[max(0, name_start - 12):name_start]
            if OBJECT_MARKER_RE.search(before_name):
                continue
            window_end = min(len(before), name_end + ATTR_NAME_TO_VERB_GAP + 30)
            tail = before[name_end:window_end]
            mv = re_verb.search(tail)
            if not mv:
                continue
            dist = len(matched_name) + len(mv.group(1))  # name + gap chars
            # When two candidates have equal dist, prefer the one whose NAME
            # starts LATER (closer to the quote) AND the longer name (covers
            # more chars, more specific).
            if best_dist is None or dist < best_dist or (
                dist == best_dist and (name_start > (best_start or 0)
                                       or len(matched_name) > len(best_name or ""))
            ):
                best_dist = dist
                best_name = matched_name
                best_start = name_start
        if best_name is not None:
            return char_aliases[best_name.lower()]

        # ── AFTER: punctuation + name + (gap) + speech/action verb ────────
        # SUBJECT_ACTION_VERBS is included because narration after a quote
        # often uses action verbs rather than speech verbs, e.g.
        #   "?" Anh đánh nhẹ vào mông cô ra vẻ khiển trách.
        #   "?" Cô hừ một tiếng, khoanh tay trước ngực, "..."
        # The action verbs (đánh, nắm, hừ, thở dài …) carry the speaker.
        re_after = re.compile(
            rf"(^|[\s—\-–:：,，])({names_alt})({WB}{NO_QUOTE_INNER})"
            rf"(?:{SPEECH_VERBS}|{SUBJECT_ACTION_VERBS})",
            re.IGNORECASE,
        )
        m_after = re_after.search(after)
        if m_after:
            return char_aliases[m_after.group(2).lower()]

        # ── AFTER (dash attribution): em-dash + Name alone ───────────────
        re_dash = re.compile(
            rf"^\s*[—\-–]\s*({names_alt})\s*[.,!?:：]?\s*$",
            re.IGNORECASE,
        )
        m_dash = re_dash.search(after)
        if m_dash:
            return char_aliases[m_dash.group(1).lower()]

        # ── Pass 5a (AFTER): PRONOUN-AS-SUBJECT IN AFTER WINDOW ──────────
        # When the quote is followed by a pronoun + verb (e.g.
        #   "Sai!" Anh không khách khí nắm tay cốc cho cô một cái
        #     → Anh (he) + nắm → ACTION → speaker is the most-recent male
        #       character in the history BEFORE the quote.
        #   "Con quỷ nghịch ngợm này …" Anh đánh nhẹ vào mông cô
        #     → Anh (he) + đánh → ACTION → male speaker.
        # Run BEFORE the BEFORE-pronoun pass: AFTER-pronoun narrows the
        # search to the immediately-following clause, which is more
        # specific than any pronoun match in the gap.
        after_pronoun_resolved = _resolve_after_pronoun_subject(
            plain, q_start, after, char_aliases, char_gender, names_alt,
        )
        if after_pronoun_resolved is not None:
            return after_pronoun_resolved

        # ── Pass 5a: PRONOUN RESOLUTION ──────────────────────────────────
        # Vietnamese narration frequently uses pronouns (Cô / Anh / Em / Chị /
        # Ông / Bà …) as the subject of a quote-introducing verb:
        #
        #   "Cô vui vẻ gọi một tiếng, ôm lấy thắt lưng anh trai, "Anh hư quá đi…""
        #     → Cô (she) + gọi (call) → SPEECH_VERB → speaker is female
        #   "Anh không khách khí nắm tay cốc cho cô một cái, "Sai!""
        #     → Anh (he) + cốc cho → ACTION → speaker is male
        #
        # The closest-name pass above already handles this for the SPEECH_VERB
        # case if the subject is a known name. Here we extend it to pronouns:
        # resolve Cô → most-recent-female-character, Anh → most-recent-male,
        # etc., using char_gender inferred from the character's voice.
        #
        # We walk the BEFORE window and the wider PRONOUN_HISTORY_WINDOW back
        # to find the most recent mention of each gender, then pick the
        # subject of a quote-introducing verb.
        gender_resolved = _resolve_pronoun_subject(
            plain, q_start, prev_quote_end, char_aliases, char_gender, names_alt,
        )
        if gender_resolved is not None:
            return gender_resolved

        # ── Pass 5b: NAME AS SUBJECT of a quote-introducing ACTION verb ──
        # When the BEFORE window ends with a known name + SUBJECT_ACTION_VERB
        # (no SPEECH_VERB needed) and a quote follows, the name is the speaker.
        # Catches patterns where narration introduces dialogue via an action:
        #
        #   "Y Đằng Ưu Nhi quay phắt đầu lại, "Long......""
        #   "Y Đằng Ưu Nhi hừ một tiếng, …, "Còn nói nữa!""
        #   "Ưu Nhi nhéo cái nơ hoàn mỹ của Y Đằng Long, …, "Nói! Mấy ngày nay anh …""
        #
        # The closest name + an action verb that introduces a quote = speaker.
        # We restrict the action verbs to ones that "introduce" speech (gọi,
        # hét, reo, nhéo, ôm, hừ, cười, …). Pure descriptive verbs like "đi"
        # or "ngồi" are NOT included.
        action_subject = _resolve_subject_action_speaker(
            before, names_alt,
        )
        if action_subject is not None:
            return char_aliases[action_subject.lower()]

        # ── BARE EXCLAMATION fallback: reactive action only ──────────────
        # Silent thoughts are deliberately excluded: inner monologue must use
        # the narrator voice. A concrete reactive action ("X nháy mắt / vỗ
        # vai / ghé tai …") can still introduce a short spoken reaction.
        thought_start = max(prev_quote_end, q_start - ATTR_THOUGHT_WINDOW_BEFORE)
        wide_before = plain[thought_start:q_start]
        re_reactive = re.compile(
            rf"(?:^|{WB})({names_alt})({WB}[^{''.join(QUOTE_OPEN_CHARS)}{''.join(QUOTE_CLOSE_CHARS)}]{{0,40}}?){REACTIVE_ACTIONS}",
            re.IGNORECASE,
        )

        reactive_matches = list(re_reactive.finditer(wide_before))
        if reactive_matches:
            best = max(reactive_matches, key=lambda m: m.start(1))
            doer = best.group(1)
            before_name = wide_before[max(0, best.start(1) - 12):best.start(1)]
            if not OBJECT_MARKER_RE.search(before_name):
                return char_aliases[doer.lower()]

        return None

    # ── Pass 5a helper: PRONOUN RESOLUTION ─────────────────────────────
    # Walks the BEFORE window + a wider history window looking for
    # Vietnamese pronouns (Cô/Anh/Em/Chị/Ông/Bà) used as the subject of
    # a quote-introducing verb (either SPEECH_VERB or SUBJECT_ACTION_VERBS).
    # Returns the canonical character name whose gender matches the pronoun,
    # choosing the most-recently-mentioned same-gender character.
    def _resolve_pronoun_subject(
        text: str,
        q_start: int,
        prev_quote_end: int,
        char_aliases: dict,
        char_gender: dict,
        names_alt: str,
    ) -> Optional[str]:
        # Walk back through characters in mention order. Build a gender-keyed
        # recent-character map: every time we see a known name, remember it
        # under its gender. Skip names followed by object markers (they're
        # objects, not subject mentions for tracking purposes).
        history_start = max(0, q_start - PRONOUN_HISTORY_WINDOW)
        history = text[history_start:q_start]

        # Build per-gender "most recent" canonical name by walking history.
        last_by_gender: dict[str, str] = {}  # 'female' / 'male' → canonical
        # Find every name occurrence in history (longest first, with WB)
        WB = r"[^A-Za-zÀ-ỹ]"
        re_name = re.compile(rf"(?:^|{WB})({names_alt})", re.IGNORECASE)
        # Walk all name occurrences; record the latest (right-most) for each
        # gender. We update last_by_gender on EACH occurrence so the final
        # value is the most recent same-gender character.
        for m in re_name.finditer(history):
            matched = m.group(1)
            # Skip if preceded by object marker (e.g. "nhìn Y Đằng Long")
            before_name = history[max(0, m.start(1) - 12):m.start(1)]
            if OBJECT_MARKER_RE.search(before_name):
                continue
            canonical = char_aliases.get(matched.lower())
            if not canonical:
                continue
            g = char_gender.get(canonical, "unknown")
            if g in ("female", "male"):
                last_by_gender[g] = canonical

        if not last_by_gender:
            return None

        # Now find a pronoun + (gap) + (speech-verb OR action-verb) in the
        # BEFORE window. The pronoun must be the SUBJECT (not object) — we
        # enforce this by requiring it to be at the start of a clause
        # (preceded by punctuation, or at position 0, or after a sentence-
        # ending punctuation). This avoids matching "Anh" inside "anh trai"
        # (where "anh" is a noun, not a pronoun-as-subject).
        before_start = max(prev_quote_end, q_start - ATTR_WINDOW_BEFORE)
        before = text[before_start:q_start]

        # Pronoun-as-subject pattern: clause-start + pronoun + (gap) + verb.
        # Clause-start = beginning of string OR preceded by `,` / `.` / `!`
        # / `?` / `…` / `;` / `:` / `—` / em-dash / opening-quote.
        re_pronoun_clause = re.compile(
            rf"(?:^|(?<=[,。.!?:；。、…—\-–\"\'“”]))"
            rf"\s*(?:"
            rf"{PRONOUNS_FEMALE}|{PRONOUNS_MALE}"
            rf")\s+([^,。\.!?{{}}{''.join(QUOTE_OPEN_CHARS)}]{{0,{ATTR_NAME_TO_VERB_GAP}}}?)"
            rf"(?:{SPEECH_VERBS}|{SUBJECT_ACTION_VERBS})",
            re.IGNORECASE,
        )
        m = re_pronoun_clause.search(before)
        if not m:
            return None

        # Identify which gender the matched pronoun has. We try female first
        # (because Cô/Chị/Bà/Em-gái are unambiguous), then male.
        pronoun_text = m.group(0)
        gender = None
        if re.search(rf"^{PRONOUNS_FEMALE}\b|\s{PRONOUNS_FEMALE}\b", pronoun_text, re.IGNORECASE):
            gender = "female"
        elif re.search(rf"^{PRONOUNS_MALE}\b|\s{PRONOUNS_MALE}\b", pronoun_text, re.IGNORECASE):
            gender = "male"
        if gender is None:
            return None

        resolved = last_by_gender.get(gender)
        return resolved

    # ── Pass 5a (AFTER) helper: PRONOUN-AS-SUBJECT IN AFTER WINDOW ────
    # Mirror of _resolve_pronoun_subject, but applied to the narration that
    # comes AFTER the quote's close. Vietnamese novels often attribute a
    # quote to a pronoun that appears AFTER the quote itself, when the
    # speaker was implicit before:
    #   "Sai!" Anh không khách khí nắm tay cốc cho cô một cái
    #     → "Anh" (he) + nắm (grasp) → ACTION → speaker is the most-recent
    #       male character in the history BEFORE the quote.
    #   "Con quỷ nghịch ngợm này …" Anh đánh nhẹ vào mông cô
    #     → "Anh" (he) + đánh (hit) → ACTION → male speaker.
    #
    # Uses the same history-walked gender resolution as _resolve_pronoun_subject
    # so speakers stay coherent with the closest-name-wins history.
    def _resolve_after_pronoun_subject(
        text: str,
        q_start: int,
        after: str,
        char_aliases: dict,
        char_gender: dict,
        names_alt: str,
    ) -> Optional[str]:
        history_start = max(0, q_start - PRONOUN_HISTORY_WINDOW)
        history = text[history_start:q_start]

        last_by_gender: dict[str, str] = {}
        WB = r"[^A-Za-zÀ-ỹ]"
        re_name = re.compile(rf"(?:^|{WB})({names_alt})", re.IGNORECASE)
        for m in re_name.finditer(history):
            matched = m.group(1)
            before_name = history[max(0, m.start(1) - 12):m.start(1)]
            if OBJECT_MARKER_RE.search(before_name):
                continue
            canonical = char_aliases.get(matched.lower())
            if not canonical:
                continue
            g = char_gender.get(canonical, "unknown")
            if g in ("female", "male"):
                last_by_gender[g] = canonical

        if not last_by_gender:
            return None

        # Pronoun at the start of the AFTER clause (the very first chars of
        # the narration that follows the quote). The verb set is broader
        # than the BEFORE-pronoun pass because physical actions like đánh /
        # nắm / véo / thở dài are common here — the quote has just been
        # spoken and the speaker's reaction follows.
        SUBJECT_ACTION_VERBS_AFTER = (
            r"(?:gọi|hét|kêu|nói|hỏi|đáp|trả lời|thét|la|reo|than|giận|dỗi"
            r"|hừ|hắng|hắng giọng|cười|cười khẽ|cười nói|mỉm cười|nhếch mép"
            r"|quay phắt|quay đầu|ngoái đầu|ngoảnh đầu|ngoái lại|ngoảnh lại"
            r"|nhéo|vặn|xoắn|bẻ|giật|kéo|lôi|cầm|nhặt|cúi|ngẩng|nghiêng"
            r"|lắc|gật|vẫy|cất tiếng|mở miệng|tiếp lời|nói tiếp|nói rằng"
            r"|khẽ nói|nói khẽ|thì thầm|thủ thỉ|thề|nguyền rủa|chửi|mắng"
            r"|quát|quát tháo|gào|kêu gào|gào thét|hô|hô to|hô lớn"
            r"|đánh|đấm|nắm|véo|vỗ|thở dài|thở ra|thở"
            r"|nhíu|nhíu mày|lườm|liếc|trừng|ngước|xoa|sờ|vuốt)"
        )
        re_pronoun = re.compile(
            rf"^\s*(?:{PRONOUNS_FEMALE}|{PRONOUNS_MALE})"
            rf"\s+([^,。\.!?{{}}{''.join(QUOTE_OPEN_CHARS)}]{{0,{ATTR_NAME_TO_VERB_GAP}}}?)"
            rf"(?:{SPEECH_VERBS}|{SUBJECT_ACTION_VERBS_AFTER})",
            re.IGNORECASE,
        )
        m = re_pronoun.search(after)
        if not m:
            return None

        pronoun_text = m.group(0)
        gender = None
        if re.search(rf"^{PRONOUNS_FEMALE}\b|\s{PRONOUNS_FEMALE}\b", pronoun_text, re.IGNORECASE):
            gender = "female"
        elif re.search(rf"^{PRONOUNS_MALE}\b|\s{PRONOUNS_MALE}\b", pronoun_text, re.IGNORECASE):
            gender = "male"
        if gender is None:
            return None

        return last_by_gender.get(gender)

    # ── Pass 5b helper: NAME AS SUBJECT of a quote-introducing ACTION verb ─
    # When the BEFORE window ends with a known name (canonical or alias)
    # + SUBJECT_ACTION_VERB right before the quote, attribute the quote to
    # that name. Catches patterns where the closest-name speech-verb pass
    # missed because the introducing verb is NOT in SPEECH_VERBS:
    #
    #   "Y Đằng Ưu Nhi quay phắt đầu lại, "Long......""
    #   "Ưu Nhi nhéo cái nơ hoàn mỹ của Y Đằng Long, …, "Nói! Mấy ngày nay …""
    #
    # This is the name-equivalent of pass 5a (pronoun + action).
    def _resolve_subject_action_speaker(before: str, names_alt: str) -> Optional[str]:
        WB = r"[^A-Za-zÀ-ỹ]"
        # Match: name (with WB before) + (gap, no quotes, no internal quote
        # chars) + an action verb that introduces a quote. We don't require
        # WB AFTER the action verb because it usually sits flush against a
        # comma or quote after.
        re_subject_action = re.compile(
            rf"(?:^|{WB})({names_alt})"
            rf"([^A-Za-zÀ-ỹ{''.join(QUOTE_OPEN_CHARS)}{''.join(QUOTE_CLOSE_CHARS)}]"
            rf"{{0,{ATTR_NAME_TO_VERB_GAP}}}?)"
            rf"{SUBJECT_ACTION_VERBS}",
            re.IGNORECASE,
        )
        matches = list(re_subject_action.finditer(before))
        if not matches:
            return None
        # Pick the LATEST name (closest to quote) — the introducing action
        # is typically the most recent one. Tie-break: longer name wins.
        best = max(
            matches,
            key=lambda m: (m.start(1), len(m.group(1))),
        )
        name = best.group(1)
        # Object-marker filter: if the 12 chars just BEFORE the name end with
        # an object marker (nhìn / với / của / …), this name is being used as
        # object of an earlier verb, not as the subject.
        before_name = before[max(0, best.start(1) - 12):best.start(1)]
        if OBJECT_MARKER_RE.search(before_name):
            return None
        return name

    # ── Stateful conversation memory + weighted evidence fusion ─────────
    # This mirrors the TypeScript attributeByConversation() pass. The regex
    # helper above is the sole explicit-attribution layer (VnCoreNLP parser
    # removed 2026-07-12); scene participants, recent actors, pronouns and
    # dialogue turns can resolve otherwise-unattributed quotes.
    conversation_state: dict = {
        "scene_id": 0,
        "active": {},  # canonical → {score, last, spoken}
        "current_speaker": None,
        "previous_speaker": None,
        "current_focus": None,
        "last_actor": None,
        "last_subject": None,
        "last_object": None,
        "last_recipient": None,
        "last_mentions": [],
        "dialogue_history": [],
        "since_dialogue": 0,
    }

    SCENE_TRANSITION_RE = re.compile(
        r"(?:^|\s)(?:hôm sau|ngày hôm sau|sáng hôm sau|đêm đó|lúc này|trong khi đó|một lúc lâu sau|vài ngày sau|một lát sau|sau đó|ở một nơi khác|bên ngoài|trong phòng|trên đường)(?:\s|[,.:;!?…]|$)",
        re.IGNORECASE,
    )
    CONTEXT_ACTION_VERBS = (
        r"(?:gọi|hét|kêu|nói|hỏi|đáp|trả lời|thét|la|reo|than|hừ"
        r"|hắng giọng|cười|mỉm cười|nhếch mép|quay đầu|ngoái lại"
        r"|gật|lắc|vẫy|cất tiếng|mở miệng|tiếp lời|nói tiếp|khẽ nói"
        r"|nói khẽ|thì thầm|thủ thỉ|quát|gào|nhìn|liếc|thở dài"
        r"|thở ra|ngước|cúi|bước|đứng|ngồi|đi tới|tiến tới)"
    )
    WB_CONTEXT = r"[^A-Za-zÀ-ỹ]"

    re_name_context = re.compile(
        rf"(?:^|{WB_CONTEXT})({names_alt})(?=$|{WB_CONTEXT})",
        re.IGNORECASE,
    ) if names_alt else None

    def _normalize_speaker(name: Optional[str]) -> Optional[str]:
        if not name:
            return None
        return char_aliases.get(name.lower(), name if name in char_gender else None)

    def _decay_active() -> None:
        active = conversation_state["active"]
        for name in list(active.keys()):
            active[name]["score"] *= 0.88
            if active[name]["score"] < 0.12:
                del active[name]

    def _touch_active(name: Optional[str], paragraph_idx: int, amount: float) -> None:
        if not name:
            return
        active = conversation_state["active"]
        row = active.get(name, {"score": 0.0, "last": paragraph_idx, "spoken": 0})
        row["score"] = min(1.8, row["score"] + amount)
        row["last"] = paragraph_idx
        active[name] = row

    def _scan_mentions(text: str) -> list[dict]:
        if not re_name_context:
            return []
        mentions: list[dict] = []
        for m in re_name_context.finditer(text):
            raw = m.group(1)
            canonical = char_aliases.get(raw.lower())
            if not canonical:
                continue
            start = m.start(1)
            before_name = text[max(0, start - 22):start]
            mentions.append({
                "name": canonical,
                "start": start,
                "end": m.end(1),
                "object": bool(OBJECT_MARKER_RE.search(before_name)),
                "recipient": bool(re.search(
                    r"\s(?:với|cho|nói với|hỏi|đáp|trả lời|gọi)\s",
                    before_name,
                    re.IGNORECASE,
                )),
            })
        return mentions

    def _latest_mentions(mentions: list[dict], limit: int = 4) -> list[str]:
        out: list[str] = []
        for item in reversed(mentions):
            name = item["name"]
            if name not in out:
                out.append(name)
            if len(out) >= limit:
                break
        return out

    def _timeline_roles(text: str, mentions: list[dict]) -> dict:
        subject = object_name = recipient = actor = None
        action_re = re.compile(
            rf"^.{{0,80}}(?:{SPEECH_VERBS}|{CONTEXT_ACTION_VERBS})",
            re.IGNORECASE,
        )
        for item in mentions:
            name = item["name"]
            if item["object"]:
                object_name = name
                if item["recipient"]:
                    recipient = name
                continue
            subject = name
            tail = text[item["end"]: min(len(text), item["end"] + 100)]
            if action_re.search(tail):
                actor = name
        return {
            "subject": subject,
            "object": object_name,
            "recipient": recipient,
            "actor": actor,
        }

    def _reset_scene() -> None:
        conversation_state["scene_id"] += 1
        conversation_state["active"] = {}
        conversation_state["current_speaker"] = None
        conversation_state["previous_speaker"] = None
        conversation_state["current_focus"] = None
        conversation_state["last_actor"] = None
        conversation_state["last_subject"] = None
        conversation_state["last_object"] = None
        conversation_state["last_recipient"] = None
        conversation_state["last_mentions"] = []
        conversation_state["dialogue_history"] = []
        conversation_state["since_dialogue"] = 0

    def _maybe_scene_break(narration_text: str) -> None:
        text = narration_text.strip()
        if not text:
            return
        if len(text) > 950 or (
            conversation_state["since_dialogue"] >= 4
            and (len(text) > 650 or SCENE_TRANSITION_RE.search(text))
        ):
            _reset_scene()

    def _update_state(text: str, mentions: list[dict], roles: dict,
                      speaker: Optional[str], paragraph_idx: int) -> None:
        for item in mentions:
            _touch_active(item["name"], paragraph_idx, 0.16 if item["object"] else 0.28)
        latest = _latest_mentions(mentions)
        if latest:
            conversation_state["last_mentions"] = latest
        if roles.get("subject"):
            conversation_state["last_subject"] = roles["subject"]
            conversation_state["current_focus"] = roles["subject"]
        elif latest:
            conversation_state["current_focus"] = latest[0]
        if roles.get("object"):
            conversation_state["last_object"] = roles["object"]
        if roles.get("recipient"):
            conversation_state["last_recipient"] = roles["recipient"]
        if roles.get("actor"):
            conversation_state["last_actor"] = roles["actor"]

        if speaker:
            _touch_active(speaker, paragraph_idx, 0.75)
            if speaker in conversation_state["active"]:
                conversation_state["active"][speaker]["spoken"] += 1
            conversation_state["previous_speaker"] = conversation_state["current_speaker"]
            conversation_state["current_speaker"] = speaker
            conversation_state["current_focus"] = speaker
            conversation_state["dialogue_history"].append({
                "paragraph": paragraph_idx,
                "speaker": speaker,
            })
            conversation_state["dialogue_history"] = conversation_state["dialogue_history"][-10:]
            conversation_state["since_dialogue"] = 0
        else:
            conversation_state["since_dialogue"] += 1

    def _resolve_pronoun_from_state(text: str) -> Optional[tuple[str, float, str]]:
        re_pronoun = re.compile(
            rf"(?:^|(?<=[,。.!?:；。、…—\-–\"'“”]))\s*"
            rf"({PRONOUNS_FEMALE}|{PRONOUNS_MALE})"
            rf"(?:\s+[^,。.!?\"'“”「」『』]{{0,70}})?"
            rf"(?:{SPEECH_VERBS}|{CONTEXT_ACTION_VERBS})",
            re.IGNORECASE,
        )
        m = re_pronoun.search(text)
        if not m:
            return None
        pronoun = m.group(1)
        gender = None
        if re.search(rf"^(?:{PRONOUNS_FEMALE})$", pronoun, re.IGNORECASE):
            gender = "female"
        elif re.search(rf"^(?:{PRONOUNS_MALE})$", pronoun, re.IGNORECASE):
            gender = "male"
        if not gender:
            return None
        candidates: list[tuple[str, float]] = []
        for name, active in conversation_state["active"].items():
            if char_gender.get(name) != gender:
                continue
            score = float(active.get("score", 0))
            if conversation_state.get("last_subject") == name:
                score += 0.45
            if conversation_state.get("last_actor") == name:
                score += 0.4
            if conversation_state.get("current_speaker") == name:
                score += 0.25
            if conversation_state.get("current_focus") == name:
                score += 0.2
            candidates.append((name, score))
        if not candidates:
            return None
        candidates.sort(key=lambda row: row[1], reverse=True)
        weight = 0.48 if len(candidates) == 1 else 0.38
        detail = (
            f"pronoun {pronoun!r} resolves to only active {gender} character"
            if len(candidates) == 1
            else f"pronoun {pronoun!r} resolves by active scene roles"
        )
        return candidates[0][0], weight, detail

    def _add_score(scores: dict, speaker: Optional[str], weight: float,
                   source: str, detail: str) -> None:
        speaker = _normalize_speaker(speaker)
        if not speaker:
            return
        bucket = scores.setdefault(speaker, {
            "score": 0.0,
            "evidence": [],
            "explicit": 0.0,
            "dominant_source": None,
            "dominant_weight": 0.0,
        })
        bucket["score"] += weight
        bucket["evidence"].append({
            "source": source,
            "speaker": speaker,
            "weight": weight,
            "detail": detail,
        })
        if source in ("parser", "regex", "llm"):
            bucket["explicit"] += weight
            if weight > bucket["dominant_weight"]:
                bucket["dominant_weight"] = weight
                bucket["dominant_source"] = source

    def _fuse_speaker(regex_speaker: Optional[str],
                      context_text: str,
                      quote_text: str,
                      paragraph_idx: int,
                      explicit_parser_source: str = "") -> tuple[Optional[str], str, list[dict], float]:
        # `explicit_parser_source` is a backward-compat no-op slot kept on the
        # signature: when the VnCoreNLP parser layer was retired (2026-07-12)
        # callers stopped passing anything here, but downstream callers still
        # pass through the attribute slot, so we keep it to avoid a wider
        # refactor.
        del explicit_parser_source
        scores: dict = {}
        if regex_speaker:
            _add_score(scores, regex_speaker, 0.55, "regex",
                       "nearby speech-verb/name pattern")

        for name, active in conversation_state["active"].items():
            weight = min(0.16, 0.04 + float(active.get("score", 0)) * 0.06)
            _add_score(scores, name, weight, "presence",
                       "character is active in current scene")

        mentions = _scan_mentions(context_text)
        roles = _timeline_roles(context_text, mentions)
        for name in _latest_mentions(mentions, 3):
            _add_score(scores, name, 0.08, "presence",
                       "character is mentioned near the quote")
        pronoun = _resolve_pronoun_from_state(context_text)
        if pronoun:
            name, weight, detail = pronoun
            _add_score(scores, name, weight, "pronoun", detail)
        if roles.get("actor"):
            _add_score(scores, roles["actor"], 0.36, "timeline",
                       "last named actor before/around the quote")
        elif conversation_state.get("last_actor"):
            _add_score(scores, conversation_state["last_actor"], 0.12,
                       "timeline", "last actor carried over from event timeline")

        implicit_turn = not regex_speaker and len(quote_text) <= 120
        current_speaker = conversation_state.get("current_speaker")
        if implicit_turn and current_speaker:
            active_names = list(conversation_state["active"].keys())
            others = [name for name in active_names if name != current_speaker]
            if len(active_names) == 2 and len(others) == 1:
                previous_previous = None
                if len(conversation_state["dialogue_history"]) >= 2:
                    previous_previous = conversation_state["dialogue_history"][-2]["speaker"]
                other = others[0]
                weight = 0.50 if previous_previous == other else 0.45
                _add_score(scores, other, weight, "history",
                           "dialogue turn likely alternates between two active speakers")
                _add_score(scores, current_speaker, 0.08, "history",
                           "possible continuation by previous speaker")
            else:
                _add_score(scores, current_speaker, 0.38, "history",
                           "unattributed quote continues previous speaker")

        if conversation_state.get("current_focus"):
            _add_score(scores, conversation_state["current_focus"], 0.10,
                       "scene", "current focus character in scene memory")

        if not scores:
            return None, "", [], 0.0
        best_name, best = max(scores.items(), key=lambda item: item[1]["score"])
        if best["score"] < 0.42:
            return None, "", best["evidence"], best["score"]
        if best.get("dominant_source") and best["score"] - best["dominant_weight"] < 0.18:
            source = best["dominant_source"]
        else:
            source = "conversation"
        return best_name, source or explicit_parser_source, best["evidence"], min(1.0, best["score"])

    # Walk quotes last → first (so each quote's BEFORE window is bounded by
    # the *previous* quote's close, not the *next* quote's open). This is the
    # same ordering the TS browser path uses.
    prev_quote_end_for_each = [0] * len(quote_spans)
    for i in range(len(quote_spans) - 1):
        prev_quote_end_for_each[i] = quote_spans[i - 1][1] if i - 1 >= 0 else 0
    # Actually: when walking last → first, the "previous quote" is the one
    # at index i-1 in the original forward order — its end bounds our window.
    # Build the (forward-index → previous-quote-end) map by walking forward.
    forward_prev_quote_end = [0] * len(quote_spans)
    for i in range(len(quote_spans)):
        forward_prev_quote_end[i] = quote_spans[i - 1][1] if i - 1 >= 0 else 0

    # Walk through text + quotes in FORWARD order so we can emit segments in
    # reading order, but do the speaker attribution per-quote using the
    # previous-quote-end mapping.
    cursor = 0
    for q_idx, (q_start, q_end, q_content) in enumerate(quote_spans):
        _decay_active()
        # Narration between cursor and q_start (strip any trailing quote chars)
        narr_text = plain[cursor:q_start]
        for qc in QUOTE_OPEN_CHARS + QUOTE_CLOSE_CHARS:
            narr_text = narr_text.replace(qc, "")
        _maybe_scene_break(narr_text)
        p_idx_for_quote = paragraph_index_at(q_start, paragraph_offsets) if paragraph_offsets else -1
        narr_mentions = _scan_mentions(narr_text)
        narr_roles = _timeline_roles(narr_text, narr_mentions)
        if narr_text.strip():
            _update_state(narr_text, narr_mentions, narr_roles, None, p_idx_for_quote)
        emit_narration(narr_text)
        non_spoken = is_non_spoken_quote(
            plain, q_start, q_end, forward_prev_quote_end[q_idx]
        )
        # The quoted dialogue itself — regex pass.
        regex_speaker = None if non_spoken else find_speaker_for_quote(
            q_start, q_end, forward_prev_quote_end[q_idx]
        )
        # Strip leading/trailing quotes from content
        clean_content = q_content.strip()
        for qc in QUOTE_OPEN_CHARS + QUOTE_CLOSE_CHARS + '"':
            clean_content = clean_content.strip(qc).strip()
        after_context = plain[q_end:min(len(plain), q_end + ATTR_WINDOW_AFTER)]
        context_text = f"{narr_text} {after_context}".strip()
        if non_spoken:
            speaker_name, attribution_source, evidence, confidence = (
                None, "narrator-non-spoken-quote", [], 1.0
            )
        else:
            # NOTE 2026-07-12: previously fused in a Tier 3b parser override
            # here. VnCoreNLP sidecar was retired; the regex + stateful
            # layers are now the sole explicit attribution sources.
            speaker_name, attribution_source, evidence, confidence = _fuse_speaker(
                regex_speaker,
                context_text,
                clean_content,
                p_idx_for_quote,
            )
        vid, vname, _ = _resolve_segment_voice(speaker_name, cmap, default_voice_id)
        char_tone = char_tones.get(speaker_name) if speaker_name else None
        # First pass: Tier 1 (keyword) + character-tone only. Tier 2 marker is
        # applied in a post-pass after we batch-classify all dialogue segments.
        segment_kind = "narration" if non_spoken else "dialogue"
        injected = inject_emotions(clean_content, segment_kind, char_tone, llm_marker="")
        seg: dict = {
            "kind": segment_kind,
            "text": injected,
            "character": speaker_name,
            "voice_id": vid,
            "voice_name": vname,
        }
        if non_spoken:
            seg["attribution_source"] = attribution_source
        elif attribution_source:
            seg["attribution_source"] = attribution_source
        if evidence:
            seg["attribution_confidence"] = confidence
            seg["attribution_evidence"] = evidence[:5]
        segments.append(seg)
        quote_mentions = _scan_mentions(context_text)
        quote_roles = _timeline_roles(context_text, quote_mentions)
        _update_state(context_text, quote_mentions, quote_roles, speaker_name, p_idx_for_quote)
        cursor = q_end

    # Remaining narration
    emit_narration(plain[cursor:])

    # ── Tier 2: one oMLX call per chapter, classifying all dialogue segments ──
    if ENABLE_LLM_EMOTION and segments:
        try:
            markers = _classify_segments_with_llm(segments)
            for seg, marker in zip(segments, markers):
                if seg["kind"] != "dialogue" or not marker:
                    continue
                # Re-inject with the LLM-derived marker as the prefix.
                # Strip any previously prepended marker first so we don't double up.
                raw = re.sub(
                    r"^\s*\[(?:cười|thở dài|hắng giọng)\]\s*",
                    "",
                    seg["text"],
                )
                char_tone = char_tones.get(seg.get("character")) if seg.get("character") else None
                seg["text"] = inject_emotions(raw, "dialogue", char_tone, llm_marker=marker)
        except Exception as e:
            print(f"[emotion] Tier-2 classification skipped: {e}", file=sys.stderr)

    return segments


# ── WAV concatenation ─────────────────────────────────────────────────────
def wav_to_pcm_int16(wav_bytes: bytes) -> tuple[bytes, int, int]:
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        pcm = w.readframes(w.getnframes())
    if sw != 2:
        # We only deal with int16 PCM here
        return pcm, sr, ch
    return pcm, sr, ch


def make_silence(duration_ms: int, sample_rate: int = 22050) -> bytes:
    n = int(sample_rate * duration_ms / 1000)
    return b"\x00\x00" * n


def concatenate_wavs(parts: list[bytes], pause_ms: int = 350) -> tuple[bytes, int]:
    """Concatenate PCM WAV parts with a short silence gap between them."""
    pcms: list[bytes] = []
    sr = 22050
    for i, w in enumerate(parts):
        pcm, s, _ = wav_to_pcm_int16(w)
        sr = s
        pcms.append(pcm)
        if pause_ms > 0 and i < len(parts) - 1:
            pcms.append(make_silence(pause_ms, sr))
    combined = b"".join(pcms)

    buf = io.BytesIO()
    data_len = len(combined)
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_len))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16))
    buf.write(b"data")
    buf.write(struct.pack("<I", data_len))
    buf.write(combined)
    return buf.getvalue(), len(combined)


def synthesize_segment(text: str, voice_name: Optional[str] = None,
                      voice_ref: Optional[str] = None,
                      language: str = "Vietnamese", backend: str = "vieneu",
                      speed: float = 1.0, max_retries: int = 3) -> bytes:
    """POST one segment to the unified TTS server.

    Args:
      voice_name: built-in VieNeu voice id (e.g. "Bình An"). Sent as `voice`.
      voice_ref:  filesystem path to a reference WAV for cloning. Sent as
                  `reference_path` (unified server routes this to the appropriate
                  cloning backend).
    """
    payload = {"text": text, "language": language, "speed": speed, "backend": backend}
    if voice_name:
        payload["voice"] = voice_name
    if voice_ref:
        payload["reference_path"] = voice_ref

    last_err: Optional[Exception] = None
    for attempt in range(max_retries + 1):
        try:
            # Longer timeout (300s) — first-time VieNeu inference can be slow.
            with httpx.Client(timeout=300.0) as client:
                r = client.post(f"{VIENEU_URL}/synthesize", json=payload)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("audio/"):
                return r.content
            last_err = RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
        except Exception as e:
            last_err = e
        time.sleep(1.0 * (attempt + 1))
    raise RuntimeError(f"TTS failed after {max_retries+1} attempts: {last_err}")


def generate_chapter(
    book_id: str,
    chapter_file: str,
    chapter_html_body: str,
    out_dir: Path,
    language: str = "Vietnamese",
    backend: str = "vieneu",
    on_progress: Optional[callable] = None,
) -> dict:
    """Generate one chapter using persisted character→voice map (CHARACTER_MAP env).

    Returns dict with audio_path, duration_ms, size_bytes, segments counts.
    """
    cmap = _load_character_map()
    voice_plan = _load_voice_plan()
    segments = split_into_segments(chapter_html_body, cmap)
    if not segments:
        raise RuntimeError("No segments extracted from chapter")

    # Apply the Voice Assign Editor plan (VOICE_PLAN env). Each segment whose
    # cleaned text matches a plan entry gets its voice overridden; a null
    # voiceId forces the narration (default) voice. No-op when no plan is set.
    if voice_plan:
        for seg in segments:
            override_id, override_name, _ = _resolve_voice_plan_override(
                seg["text"], voice_plan, cmap,
            )
            if override_id is not None or (seg["text"].strip().lower() in voice_plan):
                seg["voice_id"] = override_id
                seg["voice_name"] = override_name
                if override_id is None:
                    seg["character"] = None

    wav_parts: list[bytes] = []
    total_chars = sum(len(s["text"]) for s in segments)
    chars_done = 0
    for i, seg in enumerate(segments):
        voice_id = seg.get("voice_id")
        voice = cmap["voices_by_id"].get(voice_id) if voice_id else None
        voice_name = seg.get("voice_name")  # set if character has built-in VieNeu voice
        # If the character has a custom (non-builtin) voice, pass its ref audio
        voice_ref = voice.get("refAudioPath") if voice and not voice.get("isBuiltinVieNeu") else None
        # Per-character speed/emotion takes precedence over the shared Voice's
        # values, so two characters sharing a voice stay independent.
        char_record = next((c for c in cmap["characters"] if c.get("name") == seg.get("character")), None)
        char_speed = char_record.get("defaultSpeed") if char_record else None
        char_emotion = char_record.get("defaultEmotion") if char_record else None
        speed = char_speed or (voice.get("defaultSpeed") if voice else None) or 1.0
        char_tag = f"[{seg['character']}]" if seg.get("character") else ""
        # Strip emotion markers from the log (they're in the text already)
        log_text = seg["text"][:60].replace("\n", " ")
        print(f"  [seg {i+1}/{len(segments)}] {seg['kind'][:4]} {char_tag:14} voice={voice_name or voice_id or '(default)':12} len={len(seg['text']):5}  | {log_text}", file=sys.stderr)
        try:
            wav = synthesize_segment(seg["text"],
                                     voice_name=voice_name,
                                     voice_ref=voice_ref,
                                     language=language, backend=backend,
                                     speed=speed)
        except Exception as e:
            print(f"  [seg {i+1}/{len(segments)}] FAILED: {e}", file=sys.stderr)
            # Never publish an audiobook chapter with missing sentences. A
            # partial success used to be concatenated and marked "ready",
            # silently deleting failed dialogue/narration from playback.
            # Bubble the failure so BullMQ can retry the complete chapter.
            raise RuntimeError(
                f"segment {i + 1}/{len(segments)} failed; chapter output discarded"
            ) from e
        wav_parts.append(wav)
        chars_done += len(seg["text"])
        if on_progress:
            on_progress(min(99, int(chars_done / max(1, total_chars) * 100)))

    if not wav_parts:
        raise RuntimeError("All segments failed to synthesise")

    out_dir.mkdir(parents=True, exist_ok=True)
    safe = chapter_file.replace("/", "_").replace("\\", "_").replace(".xhtml", "").replace(".html", "")
    out_path = out_dir / f"{safe}.wav"

    combined, pcm_bytes = concatenate_wavs(wav_parts)
    out_path.write_bytes(combined)
    # Estimate duration from total PCM bytes (assume 22.05 kHz 16-bit mono for mixing)
    duration_ms = int((pcm_bytes / 2) / 22050 * 1000)
    # Count segments by voice for reporting
    by_voice: dict[str, int] = {}
    for seg in segments:
        key = seg.get("voice_name") or seg.get("voice_id") or "(default)"
        by_voice[key] = by_voice.get(key, 0) + 1
    return {
        "audio_path": str(out_path),
        "duration_ms": duration_ms,
        "size_bytes": len(combined),
        "segments": len(segments),
        "segments_ok": len(wav_parts),
        "by_voice": by_voice,
    }


# ── CLI ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--book-id", required=True)
    ap.add_argument("--chapter-file", required=True)
    ap.add_argument("--backend", default="vieneu",
                    choices=["vieneu"])  # 2026-07-12: Piper + MOSS-TTS-Nano removed
    ap.add_argument("--language", default="Vietnamese")
    ap.add_argument("--chapter-text-file", help="path to chapter .xhtml on disk")
    ap.add_argument("--out-dir", default=str(DATA_DIR))
    args = ap.parse_args()

    if not args.chapter_text_file:
        print("--chapter-text-file is required for standalone run")
        sys.exit(1)

    body = Path(args.chapter_text_file).read_text(encoding="utf-8")
    # CLI: --out-dir is expected to be the per-book directory already
    # (the worker passes data/audiobooks/<bookId>). When called from the
    # CLI directly, append book_id so the layout stays consistent.
    out_dir_arg = Path(args.out_dir)
    if not str(out_dir_arg).endswith(args.book_id):
        out_dir_arg = out_dir_arg / args.book_id
    out_dir = out_dir_arg
    res = generate_chapter(
        book_id=args.book_id,
        chapter_file=args.chapter_file,
        chapter_html_body=body,
        out_dir=out_dir,
        language=args.language,
        backend=args.backend,
    )
    print(json.dumps(res, ensure_ascii=False, indent=2))
