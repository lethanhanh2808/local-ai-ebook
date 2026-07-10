# tests/test_unicode_fold.py
#
# Phase A of D3 (BACKLOG-9) — Vietnamese Unicode-fold parity pin.
#
# Locks down the round-trip behaviour of the g2p / name-canonical /
# strip-vi helpers in `vi_g2p.py` so the Python attribution engine
# can't drift from `src/lib/vi-text-qa.ts` in the Next.js stack.
#
# What's pinned here:
#   1. `name_canonical(name)` byte-equivalent to JS nameCanonical for a
#      curated fixture of Vietnamese names.
#   2. `strip_vi(text)` produces the same folded form for every entry.
#   3. `g2p_match(a, b)` accepts/rejects the same pairs as JS g2pMatch.
#   4. `has_vietnamese(text)` returns True for any string containing a
#      diacritic-bearing letter, False otherwise.
#   5. Whitespace + punctuation collapse matches JS:
#      "Y  Đằng,Long"  →  "y dang long"
#      "y-dang long"    →  "y dang long"
#   6. NFC input vs NFD input — both normalize to the same canonical.
#   7. Empty string + None-safe — both return "".
#
# Run: python3 -m unittest tests.test_unicode_fold -v
#
# If you add a new fixture row below and it fails, the divergence is in
# `vi_g2p.py` — fix it there.  Never paper over with a regex override in
# the caller; we want the helper itself to be the single source of truth.

from __future__ import annotations

import sys
import unittest
import unicodedata
from pathlib import Path

_TTS_ROOT = Path(__file__).resolve().parent.parent
if str(_TTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TTS_ROOT))

import vi_g2p  # noqa: E402


# ── Fixture: canonical-form oracle ────────────────────────────────────────────
#
# Each row is (input, expected_canonical).  These are hand-verified
# against `src/lib/vi-text-qa.ts` (JS nameCanonical) and the NFKD +
# Mn-strip pipeline.  Adding a row without understanding WHY the
# expected output is what it is will mask real divergences.

CANONICAL_FIXTURES: list[tuple[str, str]] = [
    # ── the roster from Chiếm Đoạt Vợ Yêu (real names) ──────────────────
    ("Y Đằng Long",      "y dang long"),
    ("Y Đằng Ưu Nhi",    "y dang uu nhi"),
    ("Ưu Nhi",           "uu nhi"),
    ("Đằng Long",        "dang long"),
    ("Đằng Ưu Nhi",      "dang uu nhi"),
    ("Y Đằng Chân Lí Tử", "y dang chan li tu"),
    ("Nhâm Thiếu Hoài",  "nham thieu hoai"),
    ("Trần Minh Tuấn",   "tran minh tuan"),
    ("Tuan Ngoc",         "tuan ngoc"),
    ("Ngọc Linh",        "ngoc linh"),
    ("Trúc Ly",          "truc ly"),
    ("Bình An",          "binh an"),

    # ── diacritic-only-removed variants must collapse to the same form ──
    ("Y DANG LONG",      "y dang long"),
    ("y đằng long",      "y dang long"),
    ("Y. Đằng, Long",    "y dang long"),
    ("Y   Đằng    Long", "y dang long"),

    # ── đ/Đ → d/D ────────────────────────────────────────────────────────
    ("Đặng",             "dang"),
    ("ĐẠI",              "dai"),

    # ── multi-tone letters (combining marks must all strip) ──────────────
    ("ế",                "e"),       # e + circumflex + acute
    ("ự",                "u"),       # u + horn + dot below
    ("ổ",                "o"),       # o + circumflex + tilde

    # ── empty + whitespace-only ──────────────────────────────────────────
    ("",                 ""),
    ("   ",              ""),
    ("\t\n",             ""),

    # ── punctuation-only → empty ──────────────────────────────────────────
    ("...",              ""),
    ("!!!",              ""),
]


# ── g2p_match fixtures: pairs that MUST match, pairs that MUST NOT ────────────
G2P_MUST_MATCH: list[tuple[str, str]] = [
    ("Y Đằng Long",      "y đằng long"),
    ("Y Đằng Long",      "Y.Đằng,Long"),
    ("Trần Minh Tuấn",   "tran minh tuan"),
    ("TUẤN NGỌC",        "Tuan Ngoc"),
    ("Đằng Ưu Nhi",      "DANG Uu Nhi"),
    ("Y-Đằng-Long",      "Y Đằng Long"),
]

G2P_MUST_NOT_MATCH: list[tuple[str, str]] = [
    ("Y Đằng Long",      "Ưu Nhi"),
    ("Trần Minh Tuấn",   "Trần Văn Nam"),
    ("Tuấn",             "Tú"),         # distinct given names
    ("Ngọc Linh",        "Bình An"),
    ("Y Đằng Long",      ""),            # empty b
    ("",                 "Y Đằng Long"),# empty a
]


class TestNameCanonical(unittest.TestCase):
    """Pins `name_canonical` to the JS `nameCanonical` behaviour."""

    def test_canonical_fixture_table(self):
        for inp, expected in CANONICAL_FIXTURES:
            with self.subTest(input=inp):
                got = vi_g2p.name_canonical(inp)
                self.assertEqual(
                    got, expected,
                    f"name_canonical({inp!r}) returned {got!r}, "
                    f"expected {expected!r}",
                )

    def test_canonical_is_lowercase(self):
        # Pin: output is ALWAYS lowercase, regardless of input casing.
        self.assertEqual(vi_g2p.name_canonical("ABC"), "abc")
        self.assertEqual(vi_g2p.name_canonical("Trần"), "tran")

    def test_canonical_strips_punctuation(self):
        # [^\w\s] is dropped in `strip_vi`. Periods, commas, dashes,
        # quotes all become spaces then collapse.
        self.assertEqual(
            vi_g2p.name_canonical("Y.Đằng,Long!"),
            "y dang long",
        )

    def test_canonical_handles_hyphen(self):
        # Hyphen → space (matches JS).
        self.assertEqual(
            vi_g2p.name_canonical("Y-Đằng-Long"),
            "y dang long",
        )

    def test_canonical_handles_đ_uppercase(self):
        # Đ → D (uppercase preserved through the explicit translate).
        self.assertEqual(vi_g2p.name_canonical("ĐẠI"), "dai")

    def test_canonical_collapses_whitespace(self):
        # Multiple spaces / tabs / newlines → single space then trimmed.
        self.assertEqual(
            vi_g2p.name_canonical("Y\t\nĐằng   Long\n"),
            "y dang long",
        )

    def test_canonical_empty_input(self):
        self.assertEqual(vi_g2p.name_canonical(""), "")
        self.assertEqual(vi_g2p.name_canonical(None), "")


class TestStripVi(unittest.TestCase):
    """Pins `strip_vi` — should equal `name_canonical` since one delegates to
    the other, but we lock both down to catch any future refactor that
    decouples them."""

    def test_strip_vi_matches_name_canonical(self):
        for inp, _expected in CANONICAL_FIXTURES:
            with self.subTest(input=inp):
                self.assertEqual(
                    vi_g2p.strip_vi(inp),
                    vi_g2p.name_canonical(inp),
                )

    def test_strip_vi_handles_vietnamese_only_range(self):
        # A paragraph of pure Vietnamese → fully stripped, no Mn left.
        out = vi_g2p.strip_vi("Trời ơi, trời đất ơi")
        for ch in out:
            cp = ord(ch)
            # Every codepoint in the output must be ASCII or whitespace.
            self.assertTrue(
                cp < 0x80 or ch.isspace(),
                f"strip_vi left a non-ASCII char {ch!r} (U+{cp:04X}) in {out!r}",
            )


class TestG2pMatch(unittest.TestCase):
    """Pins `g2p_match` against curated match / non-match tables.  These
    tables are derived from `src/lib/vi-text-qa.ts:g2pMatch`."""

    def test_must_match_pairs(self):
        for a, b in G2P_MUST_MATCH:
            with self.subTest(a=a, b=b):
                self.assertTrue(
                    vi_g2p.g2p_match(a, b),
                    f"g2p_match({a!r}, {b!r}) returned False; "
                    f"should match",
                )

    def test_must_not_match_pairs(self):
        for a, b in G2P_MUST_NOT_MATCH:
            with self.subTest(a=a, b=b):
                self.assertFalse(
                    vi_g2p.g2p_match(a, b),
                    f"g2p_match({a!r}, {b!r}) returned True; "
                    f"should not match",
                )

    def test_match_is_symmetric(self):
        # g2p_match(a, b) should be true iff g2p_match(b, a).  Pin.
        for a, b in G2P_MUST_MATCH:
            with self.subTest(a=a, b=b):
                self.assertEqual(
                    vi_g2p.g2p_match(a, b),
                    vi_g2p.g2p_match(b, a),
                )

    def test_match_to_self(self):
        # Every input that canonicalizes to a non-empty string must g2p-match
        # itself.  Inputs that canonicalize to "" (whitespace-only, punctuation-
        # only) intentionally return False — `g2p_match` rejects empties.
        for inp, expected in CANONICAL_FIXTURES:
            if inp and expected:
                with self.subTest(input=inp):
                    self.assertTrue(vi_g2p.g2p_match(inp, inp))


class TestHasVietnamese(unittest.TestCase):
    """Pins `has_vietnamese` — used by JS-side `hasVietnamese` mirror in
    `src/lib/vi-text-qa.ts`."""

    def test_true_for_diacritic_letters(self):
        for s in ["Đằng", "Trời", "Ưu Nhi", "Ôi", "Yến"]:
            with self.subTest(s=s):
                self.assertTrue(vi_g2p.has_vietnamese(s))

    def test_false_for_pure_ascii(self):
        for s in ["hello", "Long", "Y", "123", ""]:
            with self.subTest(s=s):
                self.assertFalse(vi_g2p.has_vietnamese(s))

    def test_true_for_mixed_strings(self):
        # One diacritic letter anywhere in the string is enough.
        self.assertTrue(vi_g2p.has_vietnamese("Long Đằng"))
        self.assertTrue(vi_g2p.has_vietnamese("hello ơi"))


class TestNormalizeVi(unittest.TestCase):
    """Pins `normalize_vi` (NFC + lowercase + whitespace collapse).  Note:
    unlike `name_canonical`, this preserves diacritics."""

    def test_nfc_normalization(self):
        # NFD-decomposed input should NFC-normalize to the same output as
        # precomposed input.  This is the canonicalization the JS side
        # applies in `normalizeVietnamese`.
        precomposed = "Y Đằng Long"
        decomposed = unicodedata.normalize("NFD", precomposed)
        self.assertEqual(
            vi_g2p.normalize_vi(precomposed),
            vi_g2p.normalize_vi(decomposed),
        )

    def test_lowercases(self):
        self.assertEqual(vi_g2p.normalize_vi("Y Đằng Long"), "y đằng long")
        self.assertEqual(vi_g2p.normalize_vi("Y.Đằng,Long"), "y.đằng,long")

    def test_collapses_whitespace(self):
        self.assertEqual(
            vi_g2p.normalize_vi("Y\t\nĐằng   Long"),
            "y đằng long",
        )

    def test_preserves_diacritics(self):
        # Critical difference from name_canonical: diacritics must remain.
        out = vi_g2p.normalize_vi("Trời ơi")
        self.assertEqual(out, "trời ơi")

    def test_empty(self):
        self.assertEqual(vi_g2p.normalize_vi(""), "")
        self.assertEqual(vi_g2p.normalize_vi(None), "")


class TestNFKDConsistency(unittest.TestCase):
    """Cross-check the underlying `_strip_diacritics_and_tones` against
    the canonical fixture.  This catches future refactors that change
    which Mn marks are stripped."""

    def test_strip_diacritics_and_tones_matches_name_canonical_for_fixtures(self):
        for inp, expected in CANONICAL_FIXTURES:
            with self.subTest(input=inp):
                # _strip_diacritics_and_tones does NFKD + Mn-strip +
                # đ→d + NFC, but does NOT lowercase or strip punctuation.
                # For the fixture inputs (lowercase + no punct), it
                # should equal name_canonical.
                stripped = vi_g2p._strip_diacritics_and_tones(inp)
                # Apply lowercase + punct-strip manually for parity check.
                import re
                manual = re.sub(r"\s+", " ",
                                re.sub(r"[^\w\s]", " ", stripped.lower())).strip()
                self.assertEqual(
                    vi_g2p.name_canonical(inp),
                    manual,
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)