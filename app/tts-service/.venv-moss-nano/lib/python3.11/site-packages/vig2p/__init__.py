"""Vietnamese G2P helpers."""

__version__ = "0.1.2"

from .core import (
    VI_FIXUPS,
    VietnameseG2P,
    fix_phonemes,
    phonemize_many,
    phonemize_text,
    tokenize_text,
)

__all__ = [
    "__version__",
    "VI_FIXUPS",
    "VietnameseG2P",
    "fix_phonemes",
    "phonemize_many",
    "phonemize_text",
    "tokenize_text",
]
