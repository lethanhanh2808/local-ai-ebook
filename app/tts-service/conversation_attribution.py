"""
conversation_attribution.py — D3 (BACKLOG-9) Python port of `attributeConversationChapter`.

Mirror of `src/lib/attribution.ts` for the Python audiobook worker.

Why this file exists
--------------------
The Python `audiobook_generator.py` had a partial port of the conversation-
stateful attribution engine (~310 lines embedded in the worker). That
partial port was missing:

  - D1 cross-chapter seed hydration / snapshot persistence
  - E2 contradiction-signal dampening (history/scene weight vs. fresh
    parser/regex/llm signal)
  - `ALTERNATION_HISTORY_MULTIPLIER = 0.55` dampening inside detected
    alternation
  - `resolveNarrativePronounCue` for "Anh đánh nhẹ cô" between quotes
  - G4 `findPotentialNewCharacters` + `collectNovelNames`
  - `detectUnresolvedActor` timeline fallback
  - `implicitTurn` heuristic (startsWithQuote || shortTurn || narrationChars<80)
  - `roles.actor` alternation bump (0.36 → 0.48 inside alternation)
  - `ConversationChapterResult` return shape
  - `mergeAttribution(parser, regex, llm)` fusion map
  - `computeStats` hit-count summary

This module ports the missing pieces, mirrors the JS public API one-for-
one where possible, and exposes `attribute_chapter(input) -> Conversation-
ChapterResult` as the canonical entry point.

Wire-in
-------
The worker (`audiobook_generator.py`) calls this module's `attribute_chapter`
under the `ATTRIBUTION_ENGINE=conversation_v3` env toggle. The legacy
`_fuse_speaker` path remains as `ATTRIBUTION_ENGINE=legacy` for one release,
so we can roll back instantly if the parity tests reveal an audio quality
regression.

Public API
----------
  ATTRIBUTION_VERSION              # "conversation-v3"
  ConversationStateSnapshot        # dataclass mirroring JS interface
  ConversationChapterResult        # dataclass with attribution + finalState + ...
  build_context(chars)             # ConversationContext — alias map + name regex
  apply_seed(state, seed)          # D1 hydrate from previous chapter
  snapshot_state(state)            # D1 payload to persist
  decay_active(state)              # per-paragraph score decay
  touch_active(state, name, idx, amount)
  should_start_new_scene(paragraph, has_quote, state)
  reset_scene(state)
  find_potential_new_characters(text, ctx)
  collect_novel_names(paragraphs, chars)
  resolve_narrative_pronoun_cue(text, quotes, state, ctx)
  resolve_pronoun_from_state(text, state, ctx)
  attribute_chapter(input) -> ConversationChapterResult
  compute_stats(paragraphs, attribution)

Acceptance gate (per ACTION_ITEMS_V3.md §D9)
-------------------------------------------
Python-side measurement script reports ≥ 70% of dialogue paragraphs
attributed on at least three real Chương entries, with no worse-than-eval-7
misattribution rate on the 22-row inventory.
"""
from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional

# Re-use vi_g2p's diacritic helpers so Python ↔ JS stay aligned.
import vi_g2p


# PROPER_NAME_RE was originally imported from `vncorenlp_attribution.py`
# (the now-retired VnCoreNLP sidecar module, deleted 2026-07-12). The regex
# itself is parser-independent — it just recognises capital-led Vietnamese
# names in running prose — so it's inlined here verbatim. The original
# module comment is preserved so future readers know the parity contract
# the regex satisfies.
#
# Inlined from vncorenlp_attribution.py (commit a70ccb4e), which kept it in
# parity with PROPER_NAME_RE in src/lib/attribution.ts:
# two-to-six capital-led words, with the leading separator excluded from the
# capture and punctuation/whitespace terminating the candidate.
#
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

PROPER_NAME_RE = re.compile(
    rf"(?:^|[^\w])({_CAP_LETTER_CLASS}{_LETTER}*"
    rf"(?:\s+{_CAP_LETTER_CLASS}{_LETTER}*){{1,5}})"
    rf"(?=\s|[,.:;!?…]|$)",
    re.UNICODE,
)


# ── Constants ─────────────────────────────────────────────────────────────
ATTRIBUTION_VERSION = "conversation-v3"

# Tunables from the JS side — kept here so the parity test pins both
# values exactly.  Drift on these is a behavioural change that should
# be loud.
ALTERNATION_HISTORY_MULTIPLIER = 0.55
SCORE_DECAY = 0.88
SCORE_FLOOR = 0.12
ACTIVE_TOUCH_MENTION = 0.28
ACTIVE_TOUCH_OBJECT = 0.16
ACTIVE_TOUCH_SPEAKER = 0.75
ACTIVE_PRESENCE_BASE = 0.04
ACTIVE_PRESENCE_SLOPE = 0.06
ACTIVE_PRESENCE_CAP = 0.16
TURN_WEIGHT_UNIQUE = 0.48
TURN_WEIGHT_AMBIGUOUS = 0.38
NARRATIVE_PRONOUN_WEIGHT = 0.58
TWO_WAY_ALT_WEIGHT_RECIPROCAL = 0.50
TWO_WAY_ALT_WEIGHT_FIRST = 0.45
TWO_WAY_ALT_CONTINUATION = 0.08
CONTRADICTION_FACTOR = 0.4
CONTINUATION_BASE_WEIGHT = 0.38
FOCUS_BASE_WEIGHT = 0.10
FOCUS_DAMPED_WEIGHT = 0.04
ACTOR_BASE_WEIGHT = 0.36
ACTOR_ALT_WEIGHT = 0.48
LAST_ACTOR_CARRY_WEIGHT = 0.12
PARSE_HIGH_CONF_THRESHOLD = 0.75
PARSE_WEIGHT_HIGH = 0.72
PARSE_WEIGHT_LOW = 0.50
REGEX_BASE_WEIGHT = 0.55
REGEX_WEIGHT_MIN = 0.45
REGEX_WEIGHT_MAX = 0.58
LLM_WEIGHT_MIN = 0.50
LLM_WEIGHT_MAX = 0.68
LLM_CONFIDENCE_FACTOR = 0.75
ATTRIBUTION_THRESHOLD = 0.42
SOURCE_DRIFT_MIN_CONFIDENCE = 0.85
SOURCE_DRIFT_CONFIDENCE_GAP = 0.18
TURN_HISTORY_CAP = 10
SNAPSHOT_ACTIVE_CAP = 6
SNAPSHOT_HISTORY_CAP = 6
MENTION_LOOKBACK = 22
MENTION_MAX_WORDS = 6

# Vietnamese pronouns — mirror of FEMALE_PRONOUNS / MALE_PRONOUNS in
# `src/lib/attribution.ts`.
# (PRONOUNS_FEMALE / PRONOUNS_MALE used to live in `vncorenlp_attribution.py`,
# which was deleted 2026-07-12 alongside the VnCoreNLP sidecar.)
FEMALE_PRONOUN_WORDS = frozenset({"cô", "chị", "bà", "em gái", "con gái", "nàng", "nữ"})
MALE_PRONOUN_WORDS = frozenset({"anh", "ông", "chú", "bác", "em trai", "con trai", "chàng", "nam"})

# Object markers — words like "nhìn", "với", "của" that flag a following
# name as an OBJECT of an earlier verb rather than the SUBJECT.  Used by
# the mention scanner to detect object-as-name patterns.
OBJECT_MARKER_RE = re.compile(
    r"\s(?:nhìn|thấy|gặp|với|của|cho|cùng|gọi|kể|về|bằng|từ|đến|giúp|trả|đưa"
    r"|đối với|về phía|phía sau|bên cạnh|trước mặt)\s",
    re.IGNORECASE,
)

# Recipient markers — words that flag a name as the RECIPIENT of speech
# (e.g. "nói với Y Đằng Long", "hỏi Ưu Nhi").
RECIPIENT_RE = re.compile(
    r"\s(?:với|cho|nói với|hỏi|đáp|trả lời|gọi)\s",
    re.IGNORECASE,
)

# Scene-transition markers — long-form narration that signals a chapter
# boundary.  Mirrors `SCENE_TRANSITION_RE` in the JS side.
SCENE_TRANSITION_RE = re.compile(
    r"(?:^|\s)(?:hôm sau|ngày hôm sau|sáng hôm sau|đêm đó|lúc này|trong khi đó"
    r"|một lúc lâu sau|vài ngày sau|một lát sau|sau đó|ở một nơi khác|bên ngoài"
    r"|trong phòng|trên đường)(?:\s|[,.:;!?…]|$)",
    re.IGNORECASE,
)

# Speech verbs — drives pronoun-resolver and quote-attribution.  Mirrors
# `SPEECH_VERBS` in `audiobook_generator.py` and `SPEECH_VERBS` in the JS
# side (the canonical list).
TEXT_SPEECH_VERBS = (
    r"(?:nói|hỏi|đáp|kêu|thì thầm|quát|hét|lẩm bẩm|nói nhỏ|cười nói|trả lời"
    r"|gọi|thét|lên tiếng|cất tiếng|mở miệng|la lên|gào|tiếp lời|nói tiếp"
    r"|khẽ nói|nói khẽ|hỏi lại|bảo|kể|reo lên|hét lên|thủ thỉ|lí nhí|rì rầm"
    r"|thao thao|buông lời|buông tiếng|lẩm nhẩm|ngân|ré|van|xin|than thở"
    r"|thở than|oằn|ê a|tập nói|hát|đọc|xướng)"
)
TEXT_ACTION_VERBS = (
    r"(?:gọi|hét|kêu|kêu rên|nói|hỏi|đáp|trả lời|thét|la|reo|than|hừ"
    r"|hắng giọng|hắng|hắng hắng|cười|mỉm cười|nhếch mép|quay đầu|quay lại"
    r"|quay đi|quay|ngoái lại|ngoảnh|ngoảnh lại|gật|lắc|vẫy|cất tiếng"
    r"|mở miệng|tiếp lời|nói tiếp|khẽ nói|nói khẽ|thì thầm|thủ thỉ|quát"
    r"|gào|gầm|gầm nhẹ|nhìn|nhìn xuống|nhìn lên|liếc|liếc xéo|liếc mắt"
    r"|trừng|trừng lại|chớp|chớp mắt|nheo|nheo mắt|nhíu|nhíu mày|ngước"
    r"|cúi|cúi đầu|nghiêng|nghiêng đầu|thở dài|thở ra|bước|đứng|ngồi"
    r"|đi tới|tiến tới|lùi|lùi lại|dậm chân|nhún vai|nhún nhún vai|nắm"
    r"|cốc|đánh|vỗ|véo|nhéo|nghịch|bĩu môi|oán giận|mạnh miệng|giả ngu"
    r"|đỏ bừng|nuốt nước bọt|cắn răng|câm miệng|phắt|phắt tay|giật"
    r"|giật mình|sựng|sựng lại|khựng|khựng lại|chép miệng|tặc lưỡi|trề môi"
    r"|nhướng mày|ôm|nắm tay|khoanh tay|khoanh|nhe răng|cười gằn|cười khẩy"
    r"|khẽ cúi|cúi chào|gật đầu|lắc đầu|lùi một bước|xoay người|xoay"
    r"|trợn|trợn mắt|lườm|lườm nguýt|liếc ngang|liếc dọc|đảo mắt"
    r"|ngước lên|cúi xuống|rùng mình|rùng cánh|nhăn|nhăn mặt|nhăn mũi"
    r"|nghiến|nghiến răng|thẹn|đỏ mặt|hoàn hồn|hoàn hồn lại|sửng sốt"
    r"|tỉnh|tỉnh ngộ)"
)


# ── Data classes ──────────────────────────────────────────────────────────


@dataclass
class ActiveCharacter:
    """Per-character presence tracking."""
    score: float
    last_mention_paragraph: int
    spoken_count: int


@dataclass
class DialogueTurn:
    """A single (paragraph_index, speaker) tuple — stored in
    conversation_state.dialogue_history (capped at TURN_HISTORY_CAP)."""
    paragraph_index: int
    speaker: str


@dataclass
class Mention:
    """A single detected-character-name occurrence in a paragraph."""
    name: str
    start: int
    end: int
    object_like: bool


@dataclass
class ConversationState:
    """Mutable in-flight state — what the JS side calls `ConversationState`.
    Lives only for the duration of one chapter's attribution loop.  At
    the end we call `snapshot_state(state)` to extract the persistable
    `ConversationStateSnapshot`."""
    scene_id: int = 0
    active_characters: dict[str, ActiveCharacter] = field(default_factory=dict)
    current_speaker: Optional[str] = None
    previous_speaker: Optional[str] = None
    current_focus_character: Optional[str] = None
    last_action_character: Optional[str] = None
    last_subject: Optional[str] = None
    last_object: Optional[str] = None
    last_recipient: Optional[str] = None
    last_mentioned_characters: list[str] = field(default_factory=list)
    dialogue_history: list[DialogueTurn] = field(default_factory=list)
    paragraphs_since_dialogue: int = 0


@dataclass
class CharacterProfile:
    """One character in the roster, with normalised gender."""
    name: str
    aliases: list[str]
    gender: str  # "female" | "male" | "unknown"


@dataclass
class ConversationContext:
    """Immutable per-chapter context — alias → canonical map, profile
    lookup, and the compiled name regex.  Built once via `build_context`."""
    profiles: list[CharacterProfile]
    alias_to_canonical: dict[str, str]
    profile_by_name: dict[str, CharacterProfile]
    name_regex: Optional[re.Pattern[str]]


@dataclass
class ConversationStateSnapshot:
    """Persistable form of a ConversationState at the end of a chapter.
    Mirrors the TypeScript `ConversationStateSnapshot` interface in
    `src/lib/db/chapter-attribution.ts`.

    JSON shape:
      {
        "sceneId": int,
        "activeCharacters": [name, ...],       # top-N by score
        "currentSpeaker": str | null,
        "previousSpeaker": str | null,
        "currentFocusCharacter": str | null,
        "lastActionCharacter": str | null,
        "lastMentionedCharacters": [str, ...],
        "dialogueHistory": [{"paragraphIndex": int, "speaker": str}, ...]
      }
    """
    sceneId: int
    activeCharacters: list[str]
    currentSpeaker: Optional[str]
    previousSpeaker: Optional[str]
    currentFocusCharacter: Optional[str]
    lastActionCharacter: Optional[str]
    lastMentionedCharacters: list[str]
    dialogueHistory: list[dict]

    def to_json_dict(self) -> dict:
        """Serialize to the JSON dict the JS `ConversationStateSnapshot`
        produces.  Field names match the TS interface exactly so the
        Next.js side can deserialize without translation."""
        return {
            "sceneId": self.sceneId,
            "activeCharacters": list(self.activeCharacters),
            "currentSpeaker": self.currentSpeaker,
            "previousSpeaker": self.previousSpeaker,
            "currentFocusCharacter": self.currentFocusCharacter,
            "lastActionCharacter": self.lastActionCharacter,
            "lastMentionedCharacters": list(self.lastMentionedCharacters),
            "dialogueHistory": list(self.dialogueHistory),
        }

    @classmethod
    def from_json_dict(cls, payload: dict) -> "ConversationStateSnapshot":
        """Inverse of `to_json_dict`.  Used by `apply_seed` when loading
        a snapshot from the database via the Next.js HTTP route."""
        return cls(
            sceneId=int(payload.get("sceneId", 0)),
            activeCharacters=list(payload.get("activeCharacters") or []),
            currentSpeaker=payload.get("currentSpeaker") or None,
            previousSpeaker=payload.get("previousSpeaker") or None,
            currentFocusCharacter=payload.get("currentFocusCharacter") or None,
            lastActionCharacter=payload.get("lastActionCharacter") or None,
            lastMentionedCharacters=list(payload.get("lastMentionedCharacters") or []),
            dialogueHistory=list(payload.get("dialogueHistory") or []),
        )


@dataclass
class ConversationChapterResult:
    """Output of `attribute_chapter(input)`.  Mirrors the TypeScript
    `ConversationChapterResult` interface in `src/lib/attribution.ts`."""
    attribution: dict[int, dict]      # paragraph_index -> attribution row
    final_state: ConversationStateSnapshot
    seed_applied: bool
    seed_reason: str                  # "fresh" | "seed-applied" | "no-characters"
    potential_new_characters: list[str]


# ── State machine primitives ──────────────────────────────────────────────


def create_conversation_state() -> ConversationState:
    """Fresh, empty state — equivalent to JS `createConversationState()`."""
    return ConversationState()


def decay_active_characters(state: ConversationState) -> None:
    """Per-paragraph decay of every active character's score.  Mirrors
    JS `decayActiveCharacters()`.

    Floor at SCORE_FLOOR; drop below the floor to keep the dict small
    on long passages of unrecognised characters."""
    for name in list(state.active_characters.keys()):
        active = state.active_characters[name]
        active.score *= SCORE_DECAY
        if active.score < SCORE_FLOOR:
            del state.active_characters[name]


def touch_active(
    state: ConversationState,
    name: Optional[str],
    paragraph_index: int,
    amount: float,
) -> None:
    """Bump `name`'s score by `amount`, capped at 1.8 to avoid runaway
    accumulation on extremely active characters."""
    if not name:
        return
    existing = state.active_characters.get(name)
    if existing is None:
        existing = ActiveCharacter(
            score=0.0,
            last_mention_paragraph=paragraph_index,
            spoken_count=0,
        )
    existing.score = min(1.8, existing.score + amount)
    existing.last_mention_paragraph = paragraph_index
    state.active_characters[name] = existing


def reset_scene(state: ConversationState) -> None:
    """Wipe everything that depends on the previous scene — called when
    `should_start_new_scene` returns True.  Mirrors JS `resetScene()`."""
    state.scene_id += 1
    state.active_characters.clear()
    state.current_speaker = None
    state.previous_speaker = None
    state.current_focus_character = None
    state.last_action_character = None
    state.last_subject = None
    state.last_object = None
    state.last_recipient = None
    state.last_mentioned_characters = []
    state.dialogue_history = []
    state.paragraphs_since_dialogue = 0


def should_start_new_scene(
    paragraph_index: int,
    paragraph_text: str,
    has_quote: bool,
    state: ConversationState,
) -> bool:
    """Heuristic scene-break detection.  Mirrors JS `shouldStartNewScene`.

    Rules:
      - First paragraph (index === 0) never starts a new scene (we just
        opened the chapter — the caller would be mis-detecting a
        scene break on the very first paragraph).
      - Paragraphs with dialogue don't start a new scene.
      - Long narration (>950 chars) always starts a new scene.
      - Long narration after a long quiet stretch (>4 paragraphs since
        last dialogue, AND >650 chars) starts a new scene.
      - Phrases like "hôm sau", "ngày hôm sau", "trong khi đó" start a
        new scene regardless of length.
    """
    if paragraph_index == 0:
        return False
    if not paragraph_text:
        return False
    text = paragraph_text.strip()
    if not text:
        return False
    if has_quote:
        return False
    if state.paragraphs_since_dialogue >= 4 and len(text) > 650:
        return True
    if len(text) > 950:
        return True
    if SCENE_TRANSITION_RE.search(text):
        return True
    return False


def snapshot_state(state: ConversationState) -> ConversationStateSnapshot:
    """Produce the persistable snapshot — top-N active characters by
    score, capped dialogue history.  Mirrors JS `snapshotState()`.

    NOTE: active characters beyond `SNAPSHOT_ACTIVE_CAP` are dropped.
    Their scores are lost across chapters, but their names remain in
    `lastMentionedCharacters` for the next chapter's first paragraph."""
    active = sorted(
        state.active_characters.items(),
        key=lambda kv: kv[1].score,
        reverse=True,
    )[:SNAPSHOT_ACTIVE_CAP]
    history = [
        {"paragraphIndex": turn.paragraph_index, "speaker": turn.speaker}
        for turn in state.dialogue_history[-SNAPSHOT_HISTORY_CAP:]
    ]
    return ConversationStateSnapshot(
        sceneId=state.scene_id,
        activeCharacters=[name for name, _ in active],
        currentSpeaker=state.current_speaker,
        previousSpeaker=state.previous_speaker,
        currentFocusCharacter=state.current_focus_character,
        lastActionCharacter=state.last_action_character,
        lastMentionedCharacters=list(state.last_mentioned_characters),
        dialogueHistory=history,
    )


def apply_seed_to_state(
    state: ConversationState,
    seed: Optional[ConversationStateSnapshot],
) -> None:
    """D1: hydrate a freshly-created state from the previous chapter's
    final snapshot.  Mirrors JS `applySeedToState()`.

    - Pure values (currentSpeaker, previousSpeaker, etc.) are copied
      verbatim.
    - Arrays (lastMentionedCharacters, dialogueHistory) are deep-copied
      so subsequent mutation on `state` doesn't bleed back into the
      snapshot.
    - Active characters are re-created with a moderate score (0.5) so
      the presence-scoring layer still contributes meaningful weight
      on the new chapter's early paragraphs.  Position/spoken-count
      data is lost — they'll be rebuilt within the first few paragraphs.

    No-op when `seed` is None or empty."""
    if seed is None:
        return
    state.scene_id = seed.sceneId
    state.current_speaker = seed.currentSpeaker
    state.previous_speaker = seed.previousSpeaker
    state.current_focus_character = seed.currentFocusCharacter
    state.last_action_character = seed.lastActionCharacter
    state.last_subject = None
    state.last_object = None
    state.last_recipient = None
    state.last_mentioned_characters = list(seed.lastMentionedCharacters)
    state.dialogue_history = [
        DialogueTurn(paragraph_index=int(t["paragraphIndex"]), speaker=str(t["speaker"]))
        for t in seed.dialogueHistory
    ]
    state.paragraphs_since_dialogue = 0
    for name in seed.activeCharacters:
        if not name:
            continue
        state.active_characters[name] = ActiveCharacter(
            score=0.5,
            last_mention_paragraph=-1,
            spoken_count=0,
        )


def empty_state_snapshot() -> ConversationStateSnapshot:
    """Default snapshot for the no-characters early return."""
    return ConversationStateSnapshot(
        sceneId=0,
        activeCharacters=[],
        currentSpeaker=None,
        previousSpeaker=None,
        currentFocusCharacter=None,
        lastActionCharacter=None,
        lastMentionedCharacters=[],
        dialogueHistory=[],
    )


# ── Build conversation context (Phase B.2) ────────────────────────────────


def _normalise_gender(raw: Optional[str]) -> str:
    """Coerce a string|None|null gender to one of 'female' | 'male' | 'unknown'."""
    if raw in ("female", "male"):
        return raw
    return "unknown"


def build_context(chars: Iterable[dict]) -> ConversationContext:
    """Build the immutable per-chapter context: alias map, profile
    lookup, compiled name regex.

    Mirrors JS `buildConversationContext` (src/lib/attribution.ts:838).

    `chars` is an iterable of dicts with at least {name: str,
    aliases: list[str], gender: str | None}.  We accept dicts (rather
    than a CharacterLite dataclass) so callers don't have to construct
    a dataclass just to call this — `audiobook_generator.py` already
    passes plain dicts around.
    """
    profiles: list[CharacterProfile] = []
    alias_to_canonical: dict[str, str] = {}
    profile_by_name: dict[str, CharacterProfile] = {}
    aliases_in_order: list[str] = []

    char_list = list(chars)
    for raw in char_list:
        name = raw.get("name")
        if not name:
            continue
        profile = CharacterProfile(
            name=name,
            aliases=list(raw.get("aliases") or []),
            gender=_normalise_gender(raw.get("gender")),
        )
        profiles.append(profile)
        profile_by_name[name] = profile
        for alias in [name, *profile.aliases]:
            key = alias.lower().strip()
            if not key:
                continue
            existing = alias_to_canonical.get(key)
            # JS keeps the LONGER canonical name on collision.  We mirror
            # by checking the existing canonical's length against the new
            # profile's name length.
            if existing and len(existing) >= len(profile.name):
                aliases_in_order.append(alias)
                continue
            alias_to_canonical[key] = profile.name
            aliases_in_order.append(alias)

    unique_aliases = sorted(set(aliases_in_order), key=len, reverse=True)
    if unique_aliases:
        # JS regex: (?:^|[^\p{L}\p{N}_])(NAME)(?=$|[^\p{L}\p{N}_])
        # Python:   (?:^|[^\w])(NAME)(?=$|[^\w])
        # \w with re.UNICODE covers letters+digits+underscore globally.
        name_regex = re.compile(
            rf"(?:^|[^\w])("
            rf"{'|'.join(re.escape(a) for a in unique_aliases)}"
            rf")(?=$|[^\w])",
            re.IGNORECASE | re.UNICODE,
        )
    else:
        name_regex = None

    return ConversationContext(
        profiles=profiles,
        alias_to_canonical=alias_to_canonical,
        profile_by_name=profile_by_name,
        name_regex=name_regex,
    )


def _find_quote_spans(text: str) -> list[tuple[int, int]]:
    """Locate (start, end) spans of dialogue quotes in `text`.  Mirrors
    JS `findQuoteSpans`.  Vietnamese EPUBs use U+201C / U+201D curly
    quotes; ASCII straight quotes are also accepted."""
    # Note: lookahead/lookbehind doesn't work easily here because
    # we want nested-looking quote pairs but never overlapping.  Walk
    # the string linearly.
    OPENERS = "\"'“”‘’「『"
    CLOSERS = "\"'“”‘’」』"
    spans: list[tuple[int, int]] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] not in OPENERS:
            i += 1
            continue
        start = i
        i += 1
        while i < n and text[i] not in CLOSERS:
            i += 1
        if i >= n:
            break
        spans.append((start, i + 1))
        i += 1
    return spans


def scan_mentions(text: str, ctx: ConversationContext) -> list[Mention]:
    """Walk `text` for known character names.  Mirrors JS `scanMentions`.

    Returns one Mention per match, with `object_like` set if the
    preceding 22 chars contain an object marker (nhìn / với / của / …)."""
    if not ctx.name_regex:
        return []
    mentions: list[Mention] = []
    for m in ctx.name_regex.finditer(text):
        raw = m.group(1)
        if not raw:
            continue
        name = ctx.alias_to_canonical.get(raw.lower())
        if not name:
            continue
        # Start of the captured name within the whole match (the match
        # may include the leading `[^\w]` boundary).
        start = m.start(1)
        end = m.end(1)
        before = text[max(0, start - MENTION_LOOKBACK):start]
        object_like = bool(OBJECT_MARKER_RE.search(before))
        mentions.append(Mention(
            name=name,
            start=start,
            end=end,
            object_like=object_like,
        ))
    return mentions


def latest_unique_mentions(mentions: list[Mention], limit: int = 4) -> list[str]:
    """Return up to `limit` distinct character names from `mentions`,
    walking right-to-left (most-recent-first).  Mirrors JS
    `latestUniqueMentions`."""
    seen: set[str] = set()
    out: list[str] = []
    for m in reversed(mentions):
        if m.name in seen:
            continue
        seen.add(m.name)
        out.append(m.name)
        if len(out) >= limit:
            break
    return out


def _pronoun_gender(form: str) -> Optional[str]:
    """Map a single-word pronoun to its gender, or None.

    Mirrors JS `pronounGender`."""
    n = form.lower().strip()
    if n in FEMALE_PRONOUN_WORDS:
        return "female"
    if n in MALE_PRONOUN_WORDS:
        return "male"
    return None


# ── Novel-name detection (Phase B.3 — G4 parity) ───────────────────────────


def _is_known_surface_name(surface: str, ctx: ConversationContext) -> bool:
    """True if `surface` could plausibly refer to a roster character.

    Three tiers, mirroring JS `isKnownSurfaceName`:
      1. Exact (case-insensitive) match against any stored name/alias.
      2. Diacritic-tolerant full match (via vi_g2p.name_canonical).
      3. Partial-prefix/suffix match: surface = stored-name with
         optional leading or trailing word(s).

    The third tier is what catches "Y Đằng Long" matching the stored
    name "Đằng Long", and vice versa."""
    normalized = surface.lower().strip()
    if not normalized:
        return False
    if normalized in ctx.alias_to_canonical:
        return True
    canonical_surface = vi_g2p.name_canonical(surface)
    surface_words = canonical_surface.split()
    if not surface_words:
        return False
    for profile in ctx.profiles:
        all_names = [profile.name, *profile.aliases]
        # Tier 1
        if any(n.lower().strip() == normalized for n in all_names):
            return True
        # Tier 2
        if any(vi_g2p.name_canonical(n) == canonical_surface for n in all_names):
            return True
        # Tier 3: partial-prefix/suffix
        for profile_name in all_names:
            profile_words = profile_name.lower().split()
            profile_canonical_words = [
                vi_g2p.name_canonical(w) for w in profile_name.split() if w
            ]
            # Surface is a STRICT EXTENSION of profile (surface = profile + extra words).
            if (
                len(profile_canonical_words) >= 2
                and len(profile_canonical_words) <= len(surface_words)
                and all(
                    pw == surface_words[i]
                    for i, pw in enumerate(profile_canonical_words)
                )
            ):
                return True
            # Profile is a STRICT EXTENSION of surface (profile = surface + extra words).
            if (
                len(surface_words) >= 2
                and len(surface_words) <= len(profile_canonical_words)
                and all(
                    pw == surface_words[i]
                    for i, pw in enumerate(profile_canonical_words)
                    if i < len(surface_words)
                )
            ):
                return True
    return False


def find_potential_new_characters(text: str, ctx: ConversationContext) -> list[str]:
    """G4 novel-name scan.

    Run `PROPER_NAME_RE` over `text`.  For each match that ISN'T in
    the roster (per `_is_known_surface_name`), accumulate it.  Return
    a deduplicated list sorted by frequency desc, ties by lexical
    order (vi locale).  Display form = the most-frequent casing seen.

    Mirrors JS `findPotentialNewCharacters` (src/lib/attribution.ts:1134).
    """
    by_key: dict[str, dict] = {}
    for m in PROPER_NAME_RE.finditer(text):
        raw = (m.group(1) or "").strip()
        if not raw:
            continue
        if _is_known_surface_name(raw, ctx):
            continue
        key = raw.lower()
        prev = by_key.get(key)
        count = (prev["count"] if prev else 0) + 1
        # Update if: new entry, OR higher count, OR same count + lex-smaller.
        if (
            not prev
            or count > prev["count"]
            or (count == prev["count"] and raw < prev["display"])
        ):
            by_key[key] = {"display": raw, "count": count}
    # Sort: count desc, then vi-lex.
    items = sorted(
        by_key.values(),
        key=lambda e: (-e["count"], e["display"]),
    )
    return [e["display"] for e in items]


def aggregate_potential_new_characters(
    paragraphs: Iterable[dict],
    ctx: ConversationContext,
) -> list[str]:
    """Chapter-wide novel-name aggregation.  Each paragraph is expected
    to be a dict with at least `text`.  Mirrors JS
    `aggregatePotentialNewCharacters`."""
    by_key: dict[str, dict] = {}
    for paragraph in paragraphs:
        text = paragraph.get("text") if isinstance(paragraph, dict) else getattr(paragraph, "text", None)
        if not text:
            continue
        for raw in find_potential_new_characters(text, ctx):
            key = raw.lower()
            prev = by_key.get(key)
            count = (prev["count"] if prev else 0) + 1
            if (
                not prev
                or count > prev["count"]
                or (count == prev["count"] and raw < prev["display"])
            ):
                by_key[key] = {"display": raw, "count": count}
    items = sorted(
        by_key.values(),
        key=lambda e: (-e["count"], e["display"]),
    )
    return [e["display"] for e in items]


def collect_novel_names(
    paragraphs: Iterable[dict],
    characters: Iterable[dict],
) -> list[str]:
    """Public chapter-wide novel-name aggregator.  Routes can call this
    directly with a `CharacterLite[]` (or dict list — same shape the
    Next.js API returns) without having to expose the internal
    ConversationContext type.

    Mirrors JS `collectNovelNames`."""
    ctx = build_context(characters)
    return aggregate_potential_new_characters(paragraphs, ctx)


# ── Pronoun resolution (Phase B.4) ──────────────────────────────────────────


@dataclass
class PronounResolution:
    """Result shape for the two pronoun resolvers.

    Mirrors the JS `{speaker, weight, detail}` object returned by
    `resolvePronounFromState` and `resolveNarrativePronounCue`."""
    speaker: str
    weight: float
    detail: str


# Pronoun alternation in regex form — must mirror the JS-side
# FEMALE_PRONOUN_TEXT / MALE_PRONOUN_TEXT literals (attribution.ts:67-68).
FEMALE_PRONOUN_TEXT = r"(?:cô|chị|bà|em gái|con gái|nàng|nữ)"
MALE_PRONOUN_TEXT = r"(?:anh|ông|chú|bác|em trai|con trai|chàng|nam)"

# Compiled version of TEXT_SPEECH_VERBS | TEXT_ACTION_VERBS used by
# the pronoun resolvers to short-circuit when the pronoun isn't being
# used as actor.
ANY_VERB_RE = re.compile(
    rf"(?:{TEXT_SPEECH_VERBS}|{TEXT_ACTION_VERBS})",
    re.IGNORECASE | re.UNICODE,
)

# Pronoun-cue regex used by resolveNarrativePronounCue (matches
# attribution.ts:1301-1306).
#
# NOTE on stdlib-vs-JS regex parity: the JS side uses Unicode property
# escapes `[^\p{L}]` for boundary detection.  stdlib `re` doesn't
# support `\p{L}` directly, so we approximate with `[^\W\d_]` — "not
# (non-word, digit, underscore)" = "letter or ideograph".  The
# `_UPPER_VI_CHARS` constant defined above uses the same Unicode case
# semantic workaround for the `\p{Lu}` half.
NARRATIVE_PRONOUN_CUE_RE = re.compile(
    rf"(?:^|[\W\d_])({FEMALE_PRONOUN_TEXT}|{MALE_PRONOUN_TEXT})"
    rf"\s+[^,。.!?''\"\"「」『』]{{0,90}}?"
    rf"(?:{TEXT_SPEECH_VERBS}|{TEXT_ACTION_VERBS})",
    re.IGNORECASE | re.UNICODE,
)

# The "is this pronoun an object?" negative lookbehind — `của`, `cho`,
# `với`, `nhìn`, `thấy`, `gặp` directly preceding the pronoun.  Mirrors
# attribution.ts:1317.
_NARRATIVE_OBJECT_BEFORE_RE = re.compile(
    r"(?:^|\s)(?:của|cho|với|nhìn|thấy|gặp)\s*$",
    re.IGNORECASE | re.UNICODE,
)


def best_active_by_gender(
    gender: str,
    state: ConversationState,
    ctx: ConversationContext,
) -> Optional[str]:
    """Pick the active character of the given gender with the highest
    weighted score.  Weights favour recent subject/action/speaker/focus
    roles.  Mirrors JS `bestActiveByGender` (attribution.ts:1265-1282)."""
    candidates: list[tuple[str, float]] = []
    for name, active in state.active_characters.items():
        profile = ctx.profile_by_name.get(name)
        if not profile or profile.gender != gender:
            continue
        score = active.score
        if state.last_subject == name:
            score += 0.45
        if state.last_action_character == name:
            score += 0.40
        if state.current_speaker == name:
            score += 0.25
        if state.current_focus_character == name:
            score += 0.20
        candidates.append((name, score))
    if not candidates:
        return None
    candidates.sort(key=lambda kv: kv[1], reverse=True)
    return candidates[0][0]


def resolve_narrative_pronoun_cue(
    text: str,
    quotes: list[tuple[int, int]],
    state: ConversationState,
    ctx: ConversationContext,
) -> Optional[PronounResolution]:
    """Look for a narration pronoun "Anh đánh nhẹ cô" BEFORE / BETWEEN
    quote spans.  When found, resolve by `best_active_by_gender`.

    Mirrors JS `resolveNarrativePronounCue` (attribution.ts:1284-1330).

    `quotes` is a list of `(start, end)` spans from `_find_quote_spans`."""
    if not quotes:
        return None
    windows: list[str] = []
    before_first = text[:quotes[0][0]]
    if before_first.strip():
        windows.append(before_first)
    for i, (qs, qe) in enumerate(quotes):
        nxt = quotes[i + 1][0] if i + 1 < len(quotes) else len(text)
        end = min(nxt, qe + 180)
        between = text[qe:end]
        if between.strip():
            windows.append(between)

    for window in windows:
        best: Optional[dict] = None
        for m in NARRATIVE_PRONOUN_CUE_RE.finditer(window):
            pronoun_text = m.group(1) or ""
            gender = _pronoun_gender(pronoun_text)
            if not gender:
                continue
            pronoun_start = m.start() + m.group(0).index(pronoun_text)
            before = window[max(0, pronoun_start - 12):pronoun_start]
            if _NARRATIVE_OBJECT_BEFORE_RE.search(before):
                continue
            if best is None or pronoun_start > best["index"]:
                best = {
                    "pronoun_text": pronoun_text,
                    "gender": gender,
                    "index": pronoun_start,
                }
        if best is None:
            continue
        speaker = best_active_by_gender(best["gender"], state, ctx)
        if not speaker:
            continue
        return PronounResolution(
            speaker=speaker,
            weight=NARRATIVE_PRONOUN_WEIGHT,
            detail=(
                f"narration pronoun \"{best['pronoun_text']}\" with "
                f"action/speech verb resolves by active scene roles"
            ),
        )
    return None


# Pronoun regex used by `resolve_pronoun_from_state` — matches the JS
# version at attribution.ts:1221-1227.  Note the JS regex uses Unicode
# property escapes (`\p{L}`) for boundary detection; we approximate
# with `[^\w]` because stdlib re doesn't support `\p{L}` directly.
PRONOUN_FROM_STATE_RE = re.compile(
    rf"(?:^|(?<=[,。.!?:；。、…—\-–'\"“”]))\s*"
    rf"({FEMALE_PRONOUN_TEXT}|{MALE_PRONOUN_TEXT})"
    rf"(?:\s+[^,。.!?''\"\"「」『』]{{0,70}})?"
    rf"(?:{TEXT_SPEECH_VERBS}|{TEXT_ACTION_VERBS})",
    re.IGNORECASE | re.UNICODE,
)


def resolve_pronoun_from_state(
    text: str,
    state: ConversationState,
    ctx: ConversationContext,
) -> Optional[PronounResolution]:
    """Pick up a pronoun (Anh/Cô) inside `text` that acts as the speaker
    (followed by a speech or action verb).  Resolve by gender +
    weighted active-character score.  Mirrors JS `resolvePronounFromState`
    (attribution.ts:1216-1263).

    Returns None when no pronoun matches or no candidates exist."""
    for m in PRONOUN_FROM_STATE_RE.finditer(text):
        pronoun_text = m.group(1) or m.group(0)
        pronoun_start = m.start() + m.group(0).index(pronoun_text)
        preceding = text[max(0, pronoun_start - 30):pronoun_start]
        # If there's no verb before the pronoun, only accept it when the
        # trailing 80 chars contain a verb after the pronoun (otherwise
        # it's "Anh" with no verb and we skip).
        if not ANY_VERB_RE.search(preceding):
            trailing = text[pronoun_start:pronoun_start + 80]
            after_pronoun = trailing[len(pronoun_text):len(pronoun_text) + 70]
            if re.search(r"[,….\-—:!?]+\s*$", trailing):
                continue
            if not ANY_VERB_RE.search(after_pronoun):
                continue
        gender = _pronoun_gender(pronoun_text)
        if not gender:
            continue
        # Build candidates (active chars of the same gender).
        candidates: list[tuple[str, float]] = []
        for name, active in state.active_characters.items():
            profile = ctx.profile_by_name.get(name)
            if not profile or profile.gender != gender:
                continue
            score = active.score
            if state.last_subject == name:
                score += 0.45
            if state.last_action_character == name:
                score += 0.40
            if state.current_speaker == name:
                score += 0.25
            if state.current_focus_character == name:
                score += 0.20
            candidates.append((name, score))
        candidates.sort(key=lambda kv: kv[1], reverse=True)
        if not candidates:
            continue
        best_name = candidates[0][0]
        unique = len(candidates) == 1
        return PronounResolution(
            speaker=best_name,
            weight=TURN_WEIGHT_UNIQUE if unique else TURN_WEIGHT_AMBIGUOUS,
            detail=(
                f"pronoun \"{pronoun_text}\" resolves to the only active "
                f"{gender} character"
                if unique
                else f"pronoun \"{pronoun_text}\" resolves by active scene roles"
            ),
        )
    return None


# ── Attribution orchestration (Phase B.5) ──────────────────────────────────


@dataclass
class ConversationAttributionInput:
    """Input to `attribute_chapter`.  Mirrors the TypeScript
    `ConversationAttributionInput` interface (attribution.ts:803-816)."""
    paragraphs: list[dict]               # each: {index, start, end, text}
    characters: Iterable[dict]            # character roster (name/aliases/gender)
    parserOut: dict[int, dict] = field(default_factory=dict)
    regexOut: dict[int, dict] = field(default_factory=dict)
    llmOut: dict[int, dict] = field(default_factory=dict)
    seedState: Optional[ConversationStateSnapshot] = None


@dataclass
class TimelineRoles:
    """Result of `detect_timeline_roles`."""
    subject: Optional[str] = None
    object: Optional[str] = None  # noqa: A002 — JS uses `object` as field name
    recipient: Optional[str] = None
    actor: Optional[str] = None


@dataclass
class AttributionEvidence:
    """One weighted signal that contributed to a paragraph's attribution."""
    source: str          # parser | regex | llm | conversation | scene | history | presence | timeline | pronoun | unresolved-actor
    weight: float
    detail: str
    speaker: Optional[str] = None


@dataclass
class ScoreBucket:
    """Per-name score accumulator for one paragraph's attribution."""
    score: float = 0.0
    evidence: list[AttributionEvidence] = field(default_factory=list)
    explicit_weight: float = 0.0
    dominant_explicit_source: Optional[str] = None
    dominant_explicit_weight: float = 0.0


# Object-or-recipient marker regex — used by `detect_unresolved_actor` to
# skip names preceded by a preposition.  Mirrors
# `TRAILING_OBJECT_OR_RECIPIENT_RE` (attribution.ts:824-825).
TRAILING_OBJECT_OR_RECIPIENT_RE = re.compile(
    r"(?:^|\s)(?:nhìn|thấy|gặp|với|của|cho|cùng|gọi|kể|về|bằng|từ|đến|giúp"
    r"|trả|đưa|đối với|về phía|phía sau|bên cạnh|trước mặt)\s*$",
    re.IGNORECASE | re.UNICODE,
)


def normalize_speaker_name(
    speaker: Optional[str],
    ctx: ConversationContext,
) -> Optional[str]:
    """Map a raw speaker name (from parser/regex/llm) to its canonical
    form via the alias map, or via g2p match as a fallback.

    Mirrors JS `normalizeSpeakerName` (attribution.ts:868-874)."""
    if not speaker:
        return None
    key = speaker.lower().strip()
    exact = ctx.alias_to_canonical.get(key)
    if exact:
        return exact
    for profile in ctx.profiles:
        if vi_g2p.g2p_match(profile.name, speaker):
            return profile.name
    return None


def add_score(
    scores: dict[str, ScoreBucket],
    speaker: str,
    weight: float,
    evidence: AttributionEvidence,
) -> None:
    """Add `weight` to `scores[speaker]`'s bucket and append `evidence`.

    Tracks `explicit_weight` separately so `source_for_bucket` can decide
    whether to attribute the paragraph to the explicit source or to
    'conversation'.  Mirrors JS `addScore` (attribution.ts:1192-1214)."""
    bucket = scores.get(speaker)
    if bucket is None:
        bucket = ScoreBucket()
        scores[speaker] = bucket
    bucket.score += weight
    bucket.evidence.append(AttributionEvidence(
        source=evidence.source,
        weight=weight,
        detail=evidence.detail,
        speaker=speaker,
    ))
    if evidence.source in ("parser", "regex", "llm"):
        bucket.explicit_weight += weight
        if weight > bucket.dominant_explicit_weight:
            bucket.dominant_explicit_weight = weight
            bucket.dominant_explicit_source = evidence.source


def quoted_content_length(text: str, quotes: list[tuple[int, int]]) -> int:
    """Sum of (quote-span length minus 2 for the open/close chars)."""
    return sum(max(0, end - start - 2) for start, end in quotes)


def source_for_bucket(bucket: ScoreBucket) -> str:
    """Pick the attribution source for a paragraph: 'parser'/'regex'/'llm'
    if a single dominant explicit weight is close to the total, else
    'conversation'.  Mirrors JS `sourceForBucket`."""
    if (
        bucket.dominant_explicit_source
        and bucket.score - bucket.dominant_explicit_weight < 0.18
    ):
        return bucket.dominant_explicit_source
    return "conversation"


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def detect_timeline_roles(
    text: str,
    mentions: list[Mention],
) -> TimelineRoles:
    """Pick subject/object/recipient/actor from mentions.

    The first non-object mention becomes the subject.  Object mentions
    become the object (and recipient if preceded by a recipient marker).
    A mention with a verb within 100 chars after it becomes the actor.

    Mirrors JS `detectTimelineRoles` (attribution.ts:1037-1070)."""
    subject: Optional[str] = None
    object_: Optional[str] = None
    recipient: Optional[str] = None
    actor: Optional[str] = None
    for mention in mentions:
        tail = text[mention.end:min(len(text), mention.end + 100)]
        before = text[max(0, mention.start - 24):mention.start]
        if mention.object_like:
            object_ = mention.name
            if RECIPIENT_RE.search(before):
                recipient = mention.name
            continue
        subject = mention.name
        if ANY_VERB_RE.search(tail):
            actor = mention.name
    return TimelineRoles(
        subject=subject,
        object=object_,
        recipient=recipient,
        actor=actor,
    )


def detect_unresolved_actor(text: str, ctx: ConversationContext) -> Optional[str]:
    """Detect a proper noun that acts (followed by a verb) but isn't in
    the roster — likely a missing character.

    Mirrors JS `detectUnresolvedActor` (attribution.ts:1156-1173)."""
    quote_spans = _find_quote_spans(text)
    best: Optional[dict] = None
    for m in PROPER_NAME_RE.finditer(text):
        raw = (m.group(1) or "").strip()
        if not raw or _is_known_surface_name(raw, ctx):
            continue
        start = m.start() + len(m.group(0)) - len(raw)
        if any(qs < start < qe for qs, qe in quote_spans):
            continue
        before = text[max(0, start - 22):start]
        if TRAILING_OBJECT_OR_RECIPIENT_RE.search(before):
            continue
        tail = text[start + len(raw):min(len(text), start + len(raw) + 100)]
        if not ANY_VERB_RE.search(tail):
            continue
        if best is None or start > best["start"]:
            best = {"name": raw, "start": start}
    return best["name"] if best else None


def update_state_after_paragraph(
    state: ConversationState,
    paragraph_index: int,
    mentions: list[Mention],
    roles: TimelineRoles,
    speaker: Optional[str],
) -> None:
    """Apply per-paragraph mutations to `state`.  Mirrors JS
    `updateStateAfterParagraph` (attribution.ts:1346-1376)."""
    for mention in mentions:
        touch_active(
            state,
            mention.name,
            paragraph_index,
            amount=(ACTIVE_TOUCH_OBJECT if mention.object_like else ACTIVE_TOUCH_MENTION),
        )
    state.last_mentioned_characters = latest_unique_mentions(mentions)
    if roles.subject is not None:
        state.current_focus_character = roles.subject
    elif state.last_mentioned_characters:
        state.current_focus_character = state.last_mentioned_characters[0]
    state.last_subject = roles.subject or state.last_subject
    state.last_object = roles.object or state.last_object
    state.last_recipient = roles.recipient or state.last_recipient
    state.last_action_character = roles.actor or state.last_action_character

    if speaker:
        touch_active(state, speaker, paragraph_index, amount=ACTIVE_TOUCH_SPEAKER)
        active = state.active_characters.get(speaker)
        if active:
            active.spoken_count += 1
        state.previous_speaker = state.current_speaker
        state.current_speaker = speaker
        state.current_focus_character = speaker
        state.dialogue_history.append(
            DialogueTurn(paragraph_index=paragraph_index, speaker=speaker)
        )
        state.dialogue_history = state.dialogue_history[-TURN_HISTORY_CAP:]
        state.paragraphs_since_dialogue = 0
    else:
        state.paragraphs_since_dialogue += 1


def merge_attribution(
    parser_out: dict[int, dict],
    regex_out: dict[int, dict],
    llm_out: dict[int, dict] | None = None,
) -> dict[int, dict]:
    """Merge per-paragraph attribution rows from parser/regex/llm layers
    into a single map.  Priority: parser (high conf) > regex > llm >
    parser (low conf as unresolved).

    Mirrors JS `mergeAttribution` (attribution.ts:1797-1830)."""
    if llm_out is None:
        llm_out = {}
    merged: dict[int, dict] = {}
    keys = set(parser_out) | set(regex_out) | set(llm_out)
    for k in keys:
        p = parser_out.get(k)
        r = regex_out.get(k)
        l = llm_out.get(k)
        if p and p.get("speaker") and (p.get("confidence") or 0) >= 0.75:
            merged[k] = p
        elif r:
            merged[k] = r
        elif l and l.get("speaker"):
            merged[k] = l
        elif p:
            merged[k] = {
                "speaker": None,
                "confidence": 0.2,
                "source": "parser",
                "reason": (
                    "parser saw a possible subject but could not map it "
                    "to a known character"
                ),
                "evidence": [{
                    "source": "parser",
                    "speaker": None,
                    "weight": 0.2,
                    "detail": "unresolved parser partial",
                }],
            }
    return merged


def compute_stats(
    paragraphs: list[dict],
    attribution: dict[int, dict],
) -> dict:
    """Tally attribution hits by source plus a source-drift counter.

    Mirrors JS `computeStats` (attribution.ts:1833-1872)."""
    parser_hits = regex_hits = llm_hits = conversation_hits = source_drift = 0
    for v in attribution.values():
        if v.get("speaker") and v.get("source") == "parser":
            parser_hits += 1
        elif v.get("speaker") and v.get("source") == "regex":
            regex_hits += 1
        elif v.get("speaker") and v.get("source") == "llm":
            llm_hits += 1
        elif v.get("speaker") and v.get("source") == "conversation":
            conversation_hits += 1
        evidence = v.get("evidence") or []
        if evidence:
            top_source = evidence[0].get("source") if isinstance(evidence[0], dict) else getattr(evidence[0], "source", None)
            if (
                v.get("speaker")
                and v.get("source") == "conversation"
                and top_source in ("regex", "llm")
                and (v.get("confidence") or 0) > 0.85
            ):
                source_drift += 1
    resolved = parser_hits + regex_hits + llm_hits + conversation_hits
    return {
        "parserHits": parser_hits,
        "regexHits": regex_hits,
        "llmHits": llm_hits,
        "conversationHits": conversation_hits,
        "sourceDrift": source_drift,
        "defaults": max(0, len(paragraphs) - resolved),
        "totalParagraphs": len(paragraphs),
    }


# Quote open/close chars for `startsWithQuote` parity check.
QUOTE_OPEN_CHARS = "\"'“”‘’「『"
QUOTE_CLOSE_CHARS = "\"'“”‘’」』"


def _paragraph_starts_with_quote(text: str) -> bool:
    """True when the first non-whitespace char is a quote opener."""
    stripped = text.lstrip()
    return bool(stripped) and stripped[0] in QUOTE_OPEN_CHARS


def attribute_chapter(input: ConversationAttributionInput) -> ConversationChapterResult:
    """Main orchestration entry point.  Mirrors JS
    `attributeConversationChapter` (attribution.ts:1421-1457) +
    `runAttributionLoop` (attribution.ts:1500-1793).

    For each paragraph:
      1. Decay active-character scores.
      2. Detect quotes + reset scene if a break is detected.
      3. Scan mentions + timeline roles + unresolved actor.
      4. Aggregate novel-name candidates.
      5. If the paragraph has a quote, run the per-paragraph scoring
         pipeline (parser/regex/llm weights, presence, pronoun,
         alternation, E2 contradiction dampening, focus/scene).
      6. Pick the best-scoring speaker (>= 0.42 confidence), or flag
         as unresolved actor / unresolved parser partial.
      7. Update state.

    Returns `ConversationChapterResult` with attribution rows, final
    snapshot, and novel-name candidates."""
    ctx = build_context(input.characters)
    if not ctx.profiles:
        return ConversationChapterResult(
            attribution=merge_attribution(input.parserOut, input.regexOut, input.llmOut),
            final_state=empty_state_snapshot(),
            seed_applied=False,
            seed_reason="no-characters",
            potential_new_characters=aggregate_potential_new_characters(input.paragraphs, ctx),
        )

    state = create_conversation_state()
    if input.seedState is not None:
        apply_seed_to_state(state, input.seedState)

    out: dict[int, dict] = {}
    novel_names: dict[str, dict] = {}

    for paragraph in input.paragraphs:
        text = paragraph["text"]
        idx = paragraph["index"]
        decay_active_characters(state)

        quotes = _find_quote_spans(text)
        has_quote = bool(quotes)
        if should_start_new_scene(idx, text, has_quote, state):
            reset_scene(state)

        mentions = scan_mentions(text, ctx)
        roles = detect_timeline_roles(text, mentions)
        unresolved_actor = detect_unresolved_actor(text, ctx)

        # G4 — accumulate novel-name candidates.
        for raw in find_potential_new_characters(text, ctx):
            key = raw.lower()
            prev = novel_names.get(key)
            count = (prev["count"] if prev else 0) + 1
            if (
                not prev
                or count > prev["count"]
                or (count == prev["count"] and raw < prev["display"])
            ):
                novel_names[key] = {"display": raw, "count": count}

        if not has_quote:
            update_state_after_paragraph(state, idx, mentions, roles, None)
            continue

        scores: dict[str, ScoreBucket] = {}
        parser_entry = input.parserOut.get(idx)
        regex_entry = input.regexOut.get(idx)
        llm_entry = input.llmOut.get(idx)

        parser_speaker = normalize_speaker_name(parser_entry.get("speaker") if parser_entry else None, ctx)
        if parser_speaker:
            confidence = parser_entry.get("confidence") or 0
            weight = PARSE_WEIGHT_HIGH if confidence >= PARSE_HIGH_CONF_THRESHOLD else PARSE_WEIGHT_LOW
            add_score(scores, parser_speaker, weight, AttributionEvidence(
                source="parser",
                weight=weight,
                detail=f"VnCoreNLP subject/verb parse ({round(confidence * 100)}%)",
            ))

        regex_speaker = normalize_speaker_name(regex_entry.get("speaker") if regex_entry else None, ctx)
        if regex_speaker:
            confidence = (regex_entry.get("confidence") if regex_entry else 0) or 0.55
            weight = max(REGEX_WEIGHT_MIN, min(REGEX_WEIGHT_MAX, confidence))
            add_score(scores, regex_speaker, weight, AttributionEvidence(
                source="regex",
                weight=weight,
                detail="nearby speech-verb/name pattern",
            ))

        llm_speaker = normalize_speaker_name(llm_entry.get("speaker") if llm_entry else None, ctx)
        if llm_speaker:
            confidence = (llm_entry.get("confidence") if llm_entry else 0) or 0.7
            weight = max(LLM_WEIGHT_MIN, min(LLM_WEIGHT_MAX, confidence * LLM_CONFIDENCE_FACTOR))
            add_score(scores, llm_speaker, weight, AttributionEvidence(
                source="llm",
                weight=weight,
                detail=f"LLM attribution fallback ({round(confidence * 100)}%)",
            ))

        # Presence scoring — every active character gets a tiny weight.
        for name, active in state.active_characters.items():
            weight = min(ACTIVE_PRESENCE_CAP, ACTIVE_PRESENCE_BASE + active.score * ACTIVE_PRESENCE_SLOPE)
            add_score(scores, name, weight, AttributionEvidence(
                source="presence",
                weight=weight,
                detail="character is active in current scene",
            ))

        for name in latest_unique_mentions(mentions, limit=3):
            add_score(scores, name, 0.08, AttributionEvidence(
                source="presence",
                weight=0.08,
                detail="character is mentioned in the dialogue paragraph",
            ))

        pronoun = resolve_pronoun_from_state(text, state, ctx)
        if pronoun:
            add_score(scores, pronoun.speaker, pronoun.weight, AttributionEvidence(
                source="pronoun",
                weight=pronoun.weight,
                detail=pronoun.detail,
            ))
        narrative_pronoun = resolve_narrative_pronoun_cue(text, quotes, state, ctx)
        if narrative_pronoun and (not pronoun or narrative_pronoun.speaker != pronoun.speaker):
            add_score(scores, narrative_pronoun.speaker, narrative_pronoun.weight, AttributionEvidence(
                source="pronoun",
                weight=narrative_pronoun.weight,
                detail=narrative_pronoun.detail,
            ))

        explicit_speaker = bool(parser_speaker or regex_speaker or llm_speaker)
        quote_chars = quoted_content_length(text, quotes)
        narration_chars = max(0, len(text) - quote_chars)
        starts_with_quote = _paragraph_starts_with_quote(text)
        short_turn = 0 < quote_chars <= 120
        implicit_turn = (
            not explicit_speaker
            and (starts_with_quote or short_turn or narration_chars < 80)
        )
        history = state.dialogue_history
        alternation_strength = (
            1.0
            if len(history) >= 2
            and history[-2].speaker != history[-1].speaker
            else 0.0
        )
        history_multiplier = (
            ALTERNATION_HISTORY_MULTIPLIER if alternation_strength > 0 else 1.0
        )

        if roles.actor:
            actor_weight = ACTOR_ALT_WEIGHT if alternation_strength > 0 else ACTOR_BASE_WEIGHT
            add_score(scores, roles.actor, actor_weight, AttributionEvidence(
                source="timeline",
                weight=actor_weight,
                detail=(
                    "last named actor before/around the quote (alternating turn — bumped)"
                    if alternation_strength > 0
                    else "last named actor before/around the quote"
                ),
            ))
        elif state.last_action_character:
            add_score(scores, state.last_action_character, LAST_ACTOR_CARRY_WEIGHT, AttributionEvidence(
                source="timeline",
                weight=LAST_ACTOR_CARRY_WEIGHT,
                detail="last actor carried over from event timeline",
            ))

        if implicit_turn and state.current_speaker:
            active_names = list(state.active_characters.keys())
            other_active = [n for n in active_names if n != state.current_speaker]
            if len(active_names) == 2 and len(other_active) == 1:
                other = other_active[0]
                prev_prev_speaker = (
                    history[-2].speaker if len(history) >= 2 else None
                )
                alternation_weight = (
                    TWO_WAY_ALT_WEIGHT_RECIPROCAL
                    if prev_prev_speaker == other
                    else TWO_WAY_ALT_WEIGHT_FIRST
                ) * history_multiplier
                add_score(scores, other, alternation_weight, AttributionEvidence(
                    source="history",
                    weight=alternation_weight,
                    detail="dialogue turn likely alternates between two active speakers",
                ))
                continuation_weight = TWO_WAY_ALT_CONTINUATION * history_multiplier
                add_score(scores, state.current_speaker, continuation_weight, AttributionEvidence(
                    source="history",
                    weight=continuation_weight,
                    detail="possible continuation by previous speaker",
                ))
            else:
                # E2 contradiction dampening.
                contradicting = bool(
                    (parser_speaker and parser_speaker != state.current_speaker)
                    or (regex_speaker and regex_speaker != state.current_speaker)
                    or (llm_speaker and llm_speaker != state.current_speaker)
                    or (roles.actor and roles.actor != state.current_speaker)
                    or (pronoun and pronoun.speaker != state.current_speaker)
                )
                continuation_weight = (
                    CONTINUATION_BASE_WEIGHT
                    * (CONTRADICTION_FACTOR if contradicting else 1.0)
                    * history_multiplier
                )
                add_score(scores, state.current_speaker, continuation_weight, AttributionEvidence(
                    source="history",
                    weight=continuation_weight,
                    detail=(
                        "unattributed quote, history dampened (contradicting lexical signal present)"
                        if contradicting
                        else "unattributed quote continues previous speaker"
                    ),
                ))

        if state.current_focus_character:
            explicit_elsewhere = bool(
                (parser_speaker and parser_speaker != state.current_focus_character)
                or (regex_speaker and regex_speaker != state.current_focus_character)
                or (llm_speaker and llm_speaker != state.current_focus_character)
                or (roles.actor and roles.actor != state.current_focus_character)
                or (pronoun and pronoun.speaker != state.current_focus_character)
            )
            scene_weight = FOCUS_DAMPED_WEIGHT if explicit_elsewhere else FOCUS_BASE_WEIGHT
            add_score(scores, state.current_focus_character, scene_weight, AttributionEvidence(
                source="scene",
                weight=scene_weight,
                detail=(
                    "current focus character (dampened — contradicting signal present)"
                    if explicit_elsewhere
                    else "current focus character in scene memory"
                ),
            ))

        # Pick the best scorer.
        best_name: Optional[str] = None
        best_bucket: Optional[ScoreBucket] = None
        for name, bucket in scores.items():
            if best_bucket is None or bucket.score > best_bucket.score:
                best_name = name
                best_bucket = bucket

        unresolved_actor_should_win = (
            unresolved_actor is not None
            and not explicit_speaker
            and (best_bucket is None or best_bucket.score < 0.30)
        )

        if unresolved_actor_should_win:
            out[idx] = {
                "speaker": None,
                "confidence": 0,
                "source": "unresolved-actor",
                "reason": (
                    f'Detected "{unresolved_actor}" as named actor but not '
                    "in character roster"
                ),
                "evidence": [{
                    "source": "timeline",
                    "speaker": unresolved_actor,
                    "weight": 0.36,
                    "detail": (
                        f'unresolved actor "{unresolved_actor}" - likely a '
                        "character missing from the roster"
                    ),
                }],
                "sceneId": state.scene_id,
                "state": snapshot_state(state).to_json_dict(),
            }
            update_state_after_paragraph(state, idx, mentions, roles, None)
        elif best_name and best_bucket and best_bucket.score >= ATTRIBUTION_THRESHOLD:
            source = source_for_bucket(best_bucket)
            evidence = sorted(
                [
                    {
                        "source": e.source,
                        "speaker": e.speaker,
                        "weight": e.weight,
                        "detail": e.detail,
                    }
                    for e in best_bucket.evidence
                ],
                key=lambda e: e["weight"],
                reverse=True,
            )[:8]
            out[idx] = {
                "speaker": best_name,
                "confidence": clamp01(best_bucket.score),
                "source": source,
                "reason": "; ".join(e["detail"] for e in evidence[:3]),
                "evidence": evidence,
                "sceneId": state.scene_id,
                "state": snapshot_state(state).to_json_dict(),
            }
            update_state_after_paragraph(state, idx, mentions, roles, best_name)
        else:
            if parser_entry and not parser_speaker:
                out[idx] = {
                    "speaker": None,
                    "confidence": 0.2,
                    "source": "parser",
                    "reason": (
                        "parser saw a possible subject but could not map it "
                        "to a known character"
                    ),
                    "evidence": [{
                        "source": "parser",
                        "speaker": None,
                        "weight": 0.2,
                        "detail": "unresolved parser partial",
                    }],
                    "sceneId": state.scene_id,
                    "state": snapshot_state(state).to_json_dict(),
                }
            elif unresolved_actor:
                out[idx] = {
                    "speaker": None,
                    "confidence": 0,
                    "source": "unresolved-actor",
                    "reason": (
                        f'Detected "{unresolved_actor}" as named actor but '
                        "not in character roster"
                    ),
                    "evidence": [{
                        "source": "timeline",
                        "speaker": unresolved_actor,
                        "weight": 0.36,
                        "detail": (
                            f'unresolved actor "{unresolved_actor}" - likely a '
                            "character missing from the roster"
                        ),
                    }],
                    "sceneId": state.scene_id,
                    "state": snapshot_state(state).to_json_dict(),
                }
            update_state_after_paragraph(state, idx, mentions, roles, None)

    potential_new_characters = [
        e["display"]
        for e in sorted(
            novel_names.values(),
            key=lambda e: (-e["count"], e["display"]),
        )
    ]

    return ConversationChapterResult(
        attribution=out,
        final_state=snapshot_state(state),
        seed_applied=input.seedState is not None,
        seed_reason=("seed-applied" if input.seedState is not None else "fresh"),
        potential_new_characters=potential_new_characters,
    )