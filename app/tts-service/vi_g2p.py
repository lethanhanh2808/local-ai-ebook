"""
Vietnamese G2P + text normalization helpers.

Built on top of the `vig2p` package (the same Vietnamese grapheme-to-phoneme
engine used by iamdinhthuan/Kokoro-Vietnamese). We don't ship the Kokoro
model itself — only the Vietnamese-aware normalization, which is useful in
many places where raw Vietnamese text is messy:

  * Character-name matching (OCR-degraded EPUBs often drop diacritics:
    "Tuấn" → "Tuan", "Ngọc" → "Ngoc", "Trúc" → "Truc")
  * Library/search queries
  * Vietnamese text QA (the minimal-pair collapse checks)

If `vig2p` is not installed we fall back to a pure-Python diacritic+tone
stripper, which still helps but is less phonetically accurate.

API:
  normalize_vi(text)            -> "tuấn ngọc"
  strip_vi(text)                -> "tuan ngoc"  (diacritics + tones removed)
  name_canonical(name)          -> "tuan ngoc"
  g2p_match(a, b)               -> bool   (diacritic + tone insensitive)
  g2p_similarity(a, b)          -> float  (0..1, Jaccard over phonemes)
  phonemize_vi(text)            -> "twˈə↗n ŋˈɔʔ↓k"
  has_vietnamese(text)          -> bool
  find_g2p_duplicates(names)    -> list[list[str]]
  audit_minimal_pairs(text)     -> list[dict]
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from typing import Iterable

# ── Lazy vig2p import with graceful fallback ────────────────────────────────
_vig2p = None
_vig2p_error: str | None = None


def _load_vig2p():
    global _vig2p, _vig2p_error
    if _vig2p is not None or _vig2p_error is not None:
        return _vig2p
    try:
        import vig2p  # noqa: WPS433
        _vig2p = vig2p
    except Exception as e:  # ImportError or runtime error
        _vig2p_error = repr(e)
    return _vig2p


# ── Pure-Python fallback: diacritic + tone stripper ─────────────────────────
# After NFKD decomposition, every Vietnamese precomposed letter splits into
# <base letter> + <one or more combining marks>. We want only the base
# letters (a, e, i, o, u, y, d) in the output, so we strip ALL combining
# marks (Unicode category Mn). Tones, circumflexes, breves, horns, dots
# above, dots below — everything goes. The two letters with no ASCII
# decomposition (đ, Đ) get an explicit translation.

# "đ"/"Đ" don't have any ASCII decomposition, so we replace them explicitly.
_D_TO_D = str.maketrans({"đ": "d", "Đ": "D"})


def _strip_diacritics_and_tones(s: str) -> str:
    """Aggressive ASCII fallback: removes diacritics + all Vietnamese tone marks."""
    if not s:
        return s
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.translate(_D_TO_D)
    return unicodedata.normalize("NFC", s)


# ── Public helpers ───────────────────────────────────────────────────────────
def has_vietnamese(text: str) -> bool:
    """Cheap heuristic: any character in the Vietnamese Latin extended range."""
    if not text:
        return False
    for c in text:
        cp = ord(c)
        if 0x00C0 <= cp <= 0x024F or 0x1E00 <= cp <= 0x1EFF:
            return True
    return False


def strip_vi(text: str) -> str:
    """Return ASCII-folded, lowercase, single-spaced version of the input.

    Works without vig2p (pure-Python path).
    """
    if not text:
        return ""
    s = _strip_diacritics_and_tones(text)
    s = s.lower()
    s = re.sub(r"[^\w\s]", " ", s)  # drop punctuation
    s = re.sub(r"\s+", " ", s).strip()
    return s


def normalize_vi(text: str) -> str:
    """NFC-normalized lowercase with internal whitespace collapsed.

    Safe to use even when vig2p isn't installed.
    """
    if not text:
        return ""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip().lower()


def name_canonical(name: str) -> str:
    """Canonical form of a Vietnamese name for matching across spellings.

    Returns the diacritic+tone-stripped lowercase string, which is stable
    across common OCR / input-method variants. Example:
      "Tuấn Ngọc"   -> "tuan ngoc"
      "Tuan Ngoc"   -> "tuan ngoc"
      "TUẤN  NGỌC"  -> "tuan ngoc"
    """
    return strip_vi(name)


@lru_cache(maxsize=2048)
def _phonemes_cached(s: str) -> str:
    g = _load_vig2p()
    if g is None:
        # Without vig2p we can't produce real IPA — fall back to stripped form
        # so callers that just want *some* canonicalization still work.
        return strip_vi(s)
    try:
        return g.phonemize_text(s)
    except Exception:
        return strip_vi(s)


def phonemize_vi(text: str) -> str:
    """Vietnamese → IPA-ish phoneme string (tone arrows preserved).

    Falls back to `strip_vi` if vig2p isn't available.
    """
    return _phonemes_cached(text or "")


def g2p_match(a: str, b: str) -> bool:
    """True if two strings refer to the same Vietnamese entity under
    diacritic + tone normalization. Whitespace-insensitive."""
    ca = name_canonical(a)
    cb = name_canonical(b)
    if not ca or not cb:
        return False
    if ca == cb:
        return True
    # Allow one extra space / hyphen difference
    ca2 = re.sub(r"[\s\-]+", "", ca)
    cb2 = re.sub(r"[\s\-]+", "", cb)
    return ca2 == cb2 and len(ca2) >= 2


def g2p_similarity(a: str, b: str) -> float:
    """0..1 similarity: 1 if phonemes identical, lower if they share prefixes
    or token sets. Useful for ranking candidates, not just bool matching."""
    pa = phonemize_vi(a)
    pb = phonemize_vi(b)
    if not pa or not pb:
        return 0.0
    if pa == pb:
        return 1.0
    # Token-Jaccard over phoneme words
    ta = set(pa.split())
    tb = set(pb.split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def find_g2p_duplicates(names: Iterable[str]) -> list[list[str]]:
    """Group an iterable of names into clusters that likely refer to the same
    entity. Returns a list of clusters (each cluster is a list of names).

    Used to merge "Tuấn Ngọc" / "Tuan Ngoc" / "tuấn" into one character entry
    with aliases.
    """
    items = list(names)
    n = len(items)
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

    for i in range(n):
        for j in range(i + 1, n):
            if g2p_match(items[i], items[j]):
                union(i, j)

    clusters: dict[int, list[str]] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(items[i])
    return list(clusters.values())


# ── Minimal-pair audit (from improve_phoneme.md) ────────────────────────────
# Pairs that are easy for AI-generated text (or OCR) to collapse. We don't
# run phonemization here; we just detect both forms appearing close together,
# which is the most reliable signal that one was substituted for the other.
_MINIMAL_PAIR_HINTS = [
    (("tường", "thường"), "t vs th — both can sound similar in casual speech"),
    (("trước", "chước"), "tr vs ch — easy to swap by mistake"),
    (("số", "xố"), "s vs x — collapsed in southern Vietnamese"),
    (("giải", "dải"), "gi vs d — collapsed in central Vietnamese"),
    (("cách", "kếch"), "e- vs e vowel — distinct front vs mid vowel"),
]


def audit_minimal_pairs(text: str) -> list[dict]:
    """Return suspicious cases where minimal pairs appear together in the text —
    a strong signal one has been replaced with the other by an LLM or OCR."""
    findings: list[dict] = []
    if not text:
        return findings
    low = text.lower()
    for pair, hint in _MINIMAL_PAIR_HINTS:
        a, b = pair
        if a in low and b in low:
            findings.append({
                "type": "minimal_pair",
                "pair": [a, b],
                "hint": hint,
                "why": "both forms appear in the text — verify the intended contrast",
            })
    return findings


# ── Self-test when run directly ─────────────────────────────────────────────
if __name__ == "__main__":
    print(f"vig2p loaded: {_load_vig2p() is not None} ({_vig2p_error or 'ok'})")
    print(f"name_canonical('Tuấn Ngọc')     = {name_canonical('Tuấn Ngọc')!r}")
    print(f"name_canonical('Tuan Ngoc')      = {name_canonical('Tuan Ngoc')!r}")
    print(f"g2p_match('Tuấn', 'tuan')         = {g2p_match('Tuấn', 'tuan')}")
    print(f"g2p_match('Tuấn', 'Tú')           = {g2p_match('Tuấn', 'Tú')}")
    print(f"g2p_similarity('Tuấn','Tuan')     = {g2p_similarity('Tuấn','Tuan'):.3f}")
    print(f"phonemize_vi('Tuấn Ngọc')         = {phonemize_vi('Tuấn Ngọc')!r}")
    print(f"audit_minimal_pairs('Anh ấy sống ở xố.') = {audit_minimal_pairs('Anh ấy sống ở xố.')}")
    print(f"find_g2p_duplicates(['Tuấn Ngọc','Tuan Ngoc','Mai Linh','mai linh']) = "
          f"{find_g2p_duplicates(['Tuấn Ngọc', 'Tuan Ngoc', 'Mai Linh', 'mai linh'])}")