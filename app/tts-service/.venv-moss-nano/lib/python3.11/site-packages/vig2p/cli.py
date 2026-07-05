from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .core import VietnameseG2P


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert Vietnamese text to Kokoro-compatible phonemes.")
    parser.add_argument("text", nargs="*", help="Text to phonemize. Multiple arguments are joined with spaces.")
    parser.add_argument("--file", type=Path, help="Read one text line per input line.")
    parser.add_argument("--json", action="store_true", help="Write JSON lines with text and phonemes.")
    parser.add_argument("--separator", default="\t", help="Separator for plain line output. Default: tab.")
    return parser.parse_args(argv)


def iter_inputs(args: argparse.Namespace) -> list[str]:
    if args.file:
        return [
            line.rstrip("\n")
            for line in args.file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    if args.text:
        return [" ".join(args.text)]
    stdin_text = sys.stdin.read()
    return [line.strip() for line in stdin_text.splitlines() if line.strip()]


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    converter = VietnameseG2P()

    for text in iter_inputs(args):
        phonemes = converter(text)
        if args.json:
            print(json.dumps({"text": text, "phonemes": phonemes}, ensure_ascii=False))
        else:
            print(f"{text}{args.separator}{phonemes}")
    return 0
