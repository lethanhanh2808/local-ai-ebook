# tests/test_build_context_and_novel_names.py
#
# Phase B.2 + B.3 of D3 (BACKLOG-9).
#
# Pins:
#   - build_context: profile construction, alias map, name regex
#   - scan_mentions: alias/prefix matching with object_like detection
#   - latest_unique_mentions: right-to-left dedup walk
#   - _is_known_surface_name: 3-tier known-surface check
#   - find_potential_new_characters: G4 novel-name scan
#   - collect_novel_names: public chapter-wide aggregator
#
# Run: python3 -m unittest tests.test_build_context_and_novel_names -v

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

from conversation_attribution import (  # noqa: E402
    FEMALE_PRONOUN_WORDS,
    MALE_PRONOUN_WORDS,
    Mention,
    build_context,
    collect_novel_names,
    find_potential_new_characters,
    latest_unique_mentions,
    scan_mentions,
    _is_known_surface_name,
    _pronoun_gender,
)


# ── Roster fixture used across most tests ─────────────────────────────────

ROSTER_CHIEM_DOAT = [
    {"name": "Y Đằng Long", "aliases": ["Đằng Long", "Long"], "gender": "male"},
    {"name": "Y Đằng Ưu Nhi", "aliases": ["Ưu Nhi"], "gender": "female"},
    {"name": "Y Đằng Chân Lí Tử", "aliases": ["Chân Lí Tử"], "gender": "male"},
    {"name": "Nhâm Thiếu Hoài", "aliases": ["Thiếu Hoài"], "gender": "male"},
]


class TestBuildContext(unittest.TestCase):
    """Pins `build_context` behaviour."""

    def test_empty_roster_yields_null_regex(self):
        ctx = build_context([])
        self.assertEqual(ctx.profiles, [])
        self.assertEqual(ctx.alias_to_canonical, {})
        self.assertEqual(ctx.profile_by_name, {})
        self.assertIsNone(ctx.name_regex)

    def test_basic_profiles_and_aliases(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        self.assertEqual(len(ctx.profiles), 4)
        self.assertIn("Y Đằng Long", ctx.profile_by_name)

    def test_alias_map_canonicalises_to_longest_name(self):
        # JS keeps the longest canonical name on alias collision.
        # "Đằng Long" is an alias of "Y Đằng Long" (longer).  The map
        # should canonicalise "đằng long" → "Y Đằng Long".
        ctx = build_context(ROSTER_CHIEM_DOAT)
        self.assertEqual(
            ctx.alias_to_canonical["đằng long"],
            "Y Đằng Long",
        )
        self.assertEqual(
            ctx.alias_to_canonical["ưu nhi"],
            "Y Đằng Ưu Nhi",
        )
        self.assertEqual(
            ctx.alias_to_canonical["thiếu hoài"],
            "Nhâm Thiếu Hoài",
        )

    def test_gender_normalisation(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        self.assertEqual(ctx.profile_by_name["Y Đằng Long"].gender, "male")
        self.assertEqual(ctx.profile_by_name["Y Đằng Ưu Nhi"].gender, "female")
        # Unknown gender → "unknown".
        ctx2 = build_context([{"name": "X", "aliases": [], "gender": None}])
        self.assertEqual(ctx2.profile_by_name["X"].gender, "unknown")
        # Non-binary string → "unknown".
        ctx3 = build_context([{"name": "Y", "aliases": [], "gender": "other"}])
        self.assertEqual(ctx3.profile_by_name["Y"].gender, "unknown")

    def test_name_regex_matches_longest_aliases_first(self):
        # The regex is built with longest-first ordering so prefix
        # matching prefers the longer name.  This is what catches
        # "Đằng Long" preferring "Y Đằng Long" over a hypothetical
        # shorter roster entry.
        ctx = build_context(ROSTER_CHIEM_DOAT)
        text = "Đằng Long nói."
        matches = [m.group(1) for m in ctx.name_regex.finditer(text)]
        self.assertIn("Đằng Long", matches)

    def test_name_regex_handles_no_aliases(self):
        ctx = build_context([{"name": "Alice", "aliases": [], "gender": None}])
        text = "Alice đi."
        matches = [m.group(1) for m in ctx.name_regex.finditer(text)]
        self.assertEqual(matches, ["Alice"])


class TestPronounGender(unittest.TestCase):
    """Pins pronoun → gender mapping."""

    def test_female_pronouns(self):
        for p in ["cô", "chị", "bà", "em gái", "con gái", "nàng", "nữ"]:
            self.assertEqual(_pronoun_gender(p), "female", p)

    def test_male_pronouns(self):
        for p in ["anh", "ông", "chú", "bác", "em trai", "con trai", "chàng", "nam"]:
            self.assertEqual(_pronoun_gender(p), "male", p)

    def test_non_pronoun_returns_none(self):
        for p in ["Y Đằng Long", "Ưu Nhi", "trời", "", "hello"]:
            self.assertIsNone(_pronoun_gender(p), p)

    def test_case_insensitive(self):
        self.assertEqual(_pronoun_gender("Anh"), "male")
        self.assertEqual(_pronoun_gender("ANH"), "male")
        self.assertEqual(_pronoun_gender("Cô"), "female")


class TestScanMentions(unittest.TestCase):
    """Pins the mention scan + object_like flag."""

    def test_no_mentions_when_roster_empty(self):
        ctx = build_context([])
        self.assertEqual(scan_mentions("Y Đằng Long nói.", ctx), [])

    def test_single_mention_no_object_marker(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        mentions = scan_mentions("Y Đằng Long nói.", ctx)
        self.assertEqual(len(mentions), 1)
        self.assertEqual(mentions[0].name, "Y Đằng Long")
        self.assertFalse(mentions[0].object_like)

    def test_mention_object_marker_detected(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        # "nhìn Y Đằng Long" — the 22-char window before "Y" has "nhìn"
        # which is an object marker.
        text = "Cô ấy quay đầu nhìn Y Đằng Long rồi đi."
        mentions = scan_mentions(text, ctx)
        y_mention = next(m for m in mentions if m.name == "Y Đằng Long")
        self.assertTrue(y_mention.object_like)

    def test_mention_via_alias(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        mentions = scan_mentions("Ưu Nhi mỉm cười.", ctx)
        self.assertEqual(len(mentions), 1)
        self.assertEqual(mentions[0].name, "Y Đằng Ưu Nhi")

    def test_multiple_mentions_preserve_order(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        mentions = scan_mentions(
            "Y Đằng Long nói với Ưu Nhi.",
            ctx,
        )
        names = [m.name for m in mentions]
        self.assertEqual(names, ["Y Đằng Long", "Y Đằng Ưu Nhi"])


class TestLatestUniqueMentions(unittest.TestCase):
    """Pins right-to-left dedup walk."""

    def test_empty(self):
        self.assertEqual(latest_unique_mentions([]), [])

    def test_single(self):
        self.assertEqual(
            latest_unique_mentions([Mention(name="Y Đằng Long", start=0, end=10, object_like=False)]),
            ["Y Đằng Long"],
        )

    def test_reversed_order(self):
        # Mentions here use the canonical name (the JS `latestUniqueMentions`
        # reads only `Mention.name`, and the upstream `scanMentions` is what
        # canonicalises via `aliasToCanonical.get(raw.toLowerCase())`).
        mentions = [
            Mention(name="Y Đằng Long", start=0, end=10, object_like=False),
            Mention(name="Y Đằng Ưu Nhi", start=20, end=26, object_like=False),
            Mention(name="Y Đằng Long", start=30, end=40, object_like=False),
        ]
        # Right-to-left: Y Đằng Long (last seen, idx 2) first, then Ưu Nhi
        # (idx 1).  Y Đằng Long appears twice; only the most recent counts.
        self.assertEqual(
            latest_unique_mentions(mentions),
            ["Y Đằng Long", "Y Đằng Ưu Nhi"],
        )

    def test_limit(self):
        mentions = [
            Mention(name=f"Char{i}", start=i, end=i + 5, object_like=False)
            for i in range(10)
        ]
        # limit=3 → right-to-left top 3.
        self.assertEqual(
            latest_unique_mentions(mentions, limit=3),
            ["Char9", "Char8", "Char7"],
        )


class TestIsKnownSurfaceName(unittest.TestCase):
    """Pins the 3-tier known-surface check."""

    def test_exact_match_canonical(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        self.assertTrue(_is_known_surface_name("Y Đằng Long", ctx))

    def test_exact_match_alias(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        self.assertTrue(_is_known_surface_name("Đằng Long", ctx))
        self.assertTrue(_is_known_surface_name("Ưu Nhi", ctx))

    def test_case_insensitive_exact(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        self.assertTrue(_is_known_surface_name("y đằng long", ctx))
        self.assertTrue(_is_known_surface_name("Y ĐẰNG LONG", ctx))

    def test_diacritic_tolerant_match(self):
        # "Tuan Ngoc" should match "Tuấn Ngọc" via name_canonical fold.
        ctx = build_context([{"name": "Tuấn Ngọc", "aliases": [], "gender": None}])
        self.assertTrue(_is_known_surface_name("Tuan Ngoc", ctx))
        self.assertTrue(_is_known_surface_name("TUAN NGOC", ctx))

    def test_partial_prefix_match(self):
        # JS parity pin: tier-3 partial-prefix is BIASED.  The only
        # direction that fires is "profile is a leading prefix of
        # surface" (i.e. surface = profile + trailing words, profile's
        # first N words equal surface's first N).  The inverse — surface
        # contains profile's words as an interior run — does NOT match.
        # So surface "Y Đằng Long" against profile "Đằng Long" must NOT
        # match, even though one might naively expect tier-3 to catch
        # it.  This matches JS exactly (verified against
        # src/lib/attribution.ts:1072-1116).
        ctx = build_context([{"name": "Đằng Long", "aliases": [], "gender": None}])
        self.assertFalse(_is_known_surface_name("Y Đằng Long", ctx))

    def test_partial_suffix_match_profile_is_prefix_of_surface(self):
        # JS parity pin: the ONLY tier-3 direction that fires.  Surface
        # = profile's words + extra trailing words.  Surface "Y Đằng
        # Long Cường" against profile "Y Đằng Long" → matches.
        ctx = build_context([{"name": "Y Đằng Long", "aliases": [], "gender": None}])
        self.assertTrue(_is_known_surface_name("Y Đằng Long Cường", ctx))

    def test_partial_suffix_no_match_outside_prefix(self):
        # Inverse: surface "Đằng Long" against profile "Y Đằng Long"
        # — surface words are NOT a strict prefix of profile words.
        # Both tier-3 directions evaluate False.  The JS code does NOT
        # filter this without an explicit alias.
        ctx = build_context([{"name": "Y Đằng Long", "aliases": [], "gender": None}])
        self.assertFalse(_is_known_surface_name("Đằng Long", ctx))

    def test_unknown_name_returns_false(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        self.assertFalse(_is_known_surface_name("Dũng Chi Trợ", ctx))
        self.assertFalse(_is_known_surface_name("Thiên Hạ", ctx))

    def test_empty_surface_returns_false(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        self.assertFalse(_is_known_surface_name("", ctx))
        self.assertFalse(_is_known_surface_name("   ", ctx))


class TestFindPotentialNewCharacters(unittest.TestCase):
    """Pins G4 novel-name detection."""

    def test_novel_name_surfaced(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        novel = find_potential_new_characters("Dũng Chi Trợ đứng đó.", ctx)
        self.assertEqual(novel, ["Dũng Chi Trợ"])

    def test_known_name_filtered_out(self):
        ctx = build_context(ROSTER_CHIEM_DOAT)
        # "Y Đằng Long" is in roster → not surfaced.
        novel = find_potential_new_characters("Y Đằng Long nói.", ctx)
        self.assertEqual(novel, [])

    def test_partial_prefix_filtered_out(self):
        # The roster stores BOTH the canonical AND the suffix alias so the
        # tier-1 alias map catches it.  Without the alias, the JS code does
        # NOT filter (see `test_partial_suffix_no_match_outside_prefix`).
        ctx = build_context([{"name": "Y Đằng Long", "aliases": ["Đằng Long"], "gender": None}])
        novel = find_potential_new_characters("Đằng Long đứng đó.", ctx)
        self.assertEqual(novel, [])

    def test_single_cap_pronoun_not_surfaced(self):
        # "Anh" is 1 cap-led word → below regex minimum.
        ctx = build_context(ROSTER_CHIEM_DOAT)
        novel = find_potential_new_characters("Anh đánh nhẹ cô.", ctx)
        self.assertEqual(novel, [])

    def test_diacritic_variants_do_not_collapse(self):
        # JS parity pin: dedup is by `raw.toLowerCase()` (plain lowercase).
        # Diacritics are preserved by `.lower()`, so "Tuấn Ngọc" and
        # "Tuan Ngoc" do NOT collapse to the same key.  This matches JS
        # `String.prototype.toLowerCase()` exactly.  Only case-variant
        # forms (uppercase vs lowercase diacritic-preserved strings)
        # collapse.
        ctx = build_context([])
        text = "Tuấn Ngọc nói. Tuan Ngoc nhìn."
        novel = find_potential_new_characters(text, ctx)
        self.assertEqual(len(novel), 2)
        self.assertIn("Tuấn Ngọc", novel)
        self.assertIn("Tuan Ngoc", novel)

    def test_case_variants_collapse(self):
        # JS parity pin: pure case variants (no diacritic changes) collapse
        # via the `.toLowerCase()` key.  "Y Đằng Long", "y đằng long",
        # "Y ĐẰNG LONG" all share key "y đằng long".
        ctx = build_context([])
        text = "Y Đằng Long nói. y đằng long nhìn. Y ĐẰNG LONG đi."
        novel = find_potential_new_characters(text, ctx)
        self.assertEqual(len(novel), 1)

    def test_frequency_desc(self):
        ctx = build_context([])
        text = "Bê Bê Ca nói. Ca Bê Bê nói. Bê Bê Ca đi. Ca Bê Bê đi."
        novel = find_potential_new_characters(text, ctx)
        # Both forms appear twice; tied — lex order wins.
        self.assertEqual(len(novel), 2)
        # Verify counts: tie-break is lex ascending.
        self.assertLessEqual(novel[0], novel[1])

    def test_empty_roster_still_surfaces_names(self):
        # No roster = every proper noun is "novel".
        ctx = build_context([])
        novel = find_potential_new_characters("Dũng Chi Trợ đứng đó.", ctx)
        self.assertEqual(novel, ["Dũng Chi Trợ"])

    def test_alphabetical_on_tie(self):
        # Same frequency → alphabetical (vi locale).
        ctx = build_context([])
        text = "Bê Ca nói. Ca Bê đi."  # both 2 words, both 1 occurrence
        novel = find_potential_new_characters(text, ctx)
        # Tie → lex order.
        self.assertEqual(novel, sorted(novel))

    def test_most_frequent_casing_wins(self):
        # JS parity pin: when the same surface appears with different
        # capitalisation, the most-frequent casing wins.  PROPER_NAME_RE
        # requires a leading uppercase letter so all variants must start
        # with a capital — diacritic-preserved case shifts only.
        ctx = build_context([])
        text = "Y Đằng Long nói. Y ĐẰNG LONG nhìn. Y ĐẰNG LONG đi."
        novel = find_potential_new_characters(text, ctx)
        # 1 lowercase-vs-diacritic + 2 all-caps = display = "Y ĐẰNG LONG".
        self.assertEqual(novel, ["Y ĐẰNG LONG"])

    def test_lex_order_breaks_tie(self):
        # Same frequency → lex-smallest casing wins.
        ctx = build_context([])
        text = "Bê Ca nói. Bê Ca đi."  # 1 each — wait both 2 words
        novel = find_potential_new_characters(text, ctx)
        # Only one entry since same form repeated.
        self.assertEqual(len(novel), 1)
        self.assertEqual(novel[0], "Bê Ca")


class TestCollectNovelNames(unittest.TestCase):
    """Pins chapter-wide aggregation."""

    def test_chapter_004_corpus(self):
        # Empirical pin from ACTION_ITEMS_V3.md §D10.
        paragraphs = [
            {"index": 0, "text": "Y Đằng Long quay đầu lại."},
            {"index": 1, "text": "Dũng Chi Trợ đứng bên cạnh."},
            {"index": 2, "text": "Tiểu Mai nhìn họ."},
            {"index": 3, "text": "Y Đằng Ưu Nhi bước vào phòng."},
            {"index": 4, "text": "Anh ta nhìn quanh."},
        ]
        novel = collect_novel_names(paragraphs, ROSTER_CHIEM_DOAT)
        # "Y Đằng Long" and "Y Đằng Ưu Nhi" are in roster.
        # Novel: Dũng Chi Trợ, Tiểu Mai.
        # "Anh" alone is below min-2 threshold so not surfaced.
        self.assertIn("Dũng Chi Trợ", novel)
        self.assertIn("Tiểu Mai", novel)
        self.assertNotIn("Y Đằng Long", novel)
        self.assertNotIn("Y Đằng Ưu Nhi", novel)

    def test_no_paragraphs_returns_empty(self):
        self.assertEqual(collect_novel_names([], ROSTER_CHIEM_DOAT), [])

    def test_dedup_across_paragraphs(self):
        # Same novel name appearing in multiple paragraphs counts
        # multiple times for ranking but only surfaces once.
        paragraphs = [
            {"index": 0, "text": "Dũng Chi Trợ nói."},
            {"index": 1, "text": "Dũng Chi Trợ đi."},
            {"index": 2, "text": "Dũng Chi Trợ nhìn."},
        ]
        novel = collect_novel_names(paragraphs, ROSTER_CHIEM_DOAT)
        self.assertEqual(novel.count("Dũng Chi Trợ"), 1)

    def test_paragraph_dict_flexible(self):
        # Accept both dict shape and arbitrary objects with .text.
        paragraphs = [
            type("P", (), {"text": "Dũng Chi Trợ nói."})(),
        ]
        novel = collect_novel_names(paragraphs, ROSTER_CHIEM_DOAT)
        self.assertEqual(novel, ["Dũng Chi Trợ"])


if __name__ == "__main__":
    unittest.main(verbosity=2)