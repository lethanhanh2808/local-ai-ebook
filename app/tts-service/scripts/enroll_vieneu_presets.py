#!/usr/bin/env python3
"""
Enroll new voices into VieNeu-TTS v3 Turbo's built-in catalog.

For each (name, wav, gender, region, style, description) in VOICES below, this
script:
  1. Loads Vieneu() (default mode='v3turbo', CPU ONNX).
  2. Calls tts.encode_reference(ref_audio) → (speaker_emb, ref_codes).
  3. Patches voices_v3_turbo.json with the new entry under the existing
     'presets' map. Re-running is idempotent — the same name replaces.

The catalog file lives at:
  app/tts-service/VieNeu-TTS/src/vieneu/assets/voices_v3_turbo.json
and is the source of truth for built-in presets consumed by _load_v3_voices()
in v3turbo.py.

**Important — two copies on disk.** When `uv sync` installs `vieneu`
non-editable (default on the VM docker stack), the package lands under
`/path/to/VieNeu-TTS/.venv/lib/python3.11/site-packages/vieneu/assets/voices_v3_turbo.json`
and the runtime reads THAT copy, not the source-tree one. The script patches
every copy it can find on disk so both editable (Mac) and non-editable (VM)
installs pick up the new voices. Each is overwritten with the same JSON.

Usage (from app/tts-service/VieNeu-TTS/):
  uv run python ../scripts/enroll_vieneu_presets.py
"""
from __future__ import annotations
import json
from pathlib import Path

from vieneu import Vieneu

# (1) Source-tree JSON (the repo's own copy).
SOURCE_TREE_JSON = (
    Path(__file__).resolve().parents[1]  # app/tts-service
    / "VieNeu-TTS"
    / "src"
    / "vieneu"
    / "assets"
    / "voices_v3_turbo.json"
)

# (2) Tìm thư mục chứa reference audio. Thứ tự ưu tiên:
#     - ~/reference/audio-voice-sample/         (VM-side convention)
#     - ~/Documents/local-ai-ebook/reference/   (Mac alt)
#     - /Volumes/EXT-SSD/.../local-ai-ebook/... (Mac primary)
AUDIO_DIR_CANDIDATES = [
    Path.home() / "reference" / "audio-voice-sample",
    Path.home() / "Documents" / "local-ai-ebook" / "reference" / "audio-voice-sample",
    Path("/Volumes/EXT-SSD/Users/anhl/local-ai-ebook/reference/audio-voice-sample"),
]


def find_wav(stem: str) -> Path | None:
    """Return the first existing candidate matching the stem (any extension)."""
    for d in AUDIO_DIR_CANDIDATES:
        if not d.is_dir():
            continue
        for ext in (".wav", ".WAV"):
            p = d / f"{stem}{ext}"
            if p.exists():
                return p
    return None


def find_all_voices_jsons() -> list[Path]:
    """Return every voices_v3_turbo.json under the local VieNeu-TTS tree.

    Edits every copy so non-editable installs (uv sync on the VM docker stack,
    which copies the package to site-packages) pick up changes too. Idempotent:
    re-running replaces the same name in-place, and writes the same content to
    every copy. Typical counts: 1 on Mac (editable install), 3 on the VM
    (source tree + site-packages + build/).
    """
    root = Path(__file__).resolve().parents[1] / "VieNeu-TTS"
    return sorted(set(root.rglob("voices_v3_turbo.json")))


# (3) Danh sách voice cần enroll. Mỗi entry:
#     name: tên hiển thị (đã có trong file audio-voice-sample).
#     ref_stem: tên file WAV (không extension) — đường dẫn đầy đủ suy ra từ AUDIO_DIR_CANDIDATES.
#     gender / region / style: metadata khớp với schema trong voices_v3_turbo.json.
#     description: chuỗi tiếng Việt hiển thị trong dropdown UI.
VOICES = [
    {
        "name": "Ngọc Ngạn",
        "ref_stem": "Ngoc-Ngan-(Male)",
        "gender": "male",
        "region": "Nam",
        "style": "tu_nhien",
        "description": "Nam · Nam · Phong cách tự nhiên",
    },
    {
        "name": "Hồng Đào",
        "ref_stem": "Hong-Dao-(Female)",
        "gender": "female",
        "region": "Nam",
        "style": "tu_nhien",
        "description": "Nữ · Nam · Phong cách tự nhiên",
    },
]


def main() -> int:
    targets = find_all_voices_jsons()
    if not targets:
        raise SystemExit(f"voices_v3_turbo.json not found under {Path(__file__).resolve().parents[1] / 'VieNeu-TTS'}")

    print(f"[enroll] Will patch {len(targets)} voices_v3_turbo.json file(s):")
    for p in targets:
        print(f"           - {p}")
    print()

    print(f"[enroll] Loading Vieneu() — first import downloads ~1.2 GB ONNX model.")
    tts = Vieneu()
    print(f"[enroll] Loaded backend={type(tts).__name__}, sample_rate={tts.sample_rate}")
    print()

    # Build the canonical catalog from the first existing copy, then patch all
    # of them to match.
    seed = next(p for p in targets if p.exists())
    catalog = json.loads(seed.read_text(encoding="utf-8"))
    presets = catalog.setdefault("presets", {})

    for entry in VOICES:
        name = entry["name"]
        wav = find_wav(entry["ref_stem"])
        if wav is None:
            print(f"[enroll] ✗ skip {name!r}: ref audio not found in any of:")
            for d in AUDIO_DIR_CANDIDATES:
                print(f"           - {d}")
            continue
        print(f"[enroll] Encoding {name!r} from {wav.name} ({wav.stat().st_size/1e6:.1f} MB) ...")
        # encode_reference does mono-downmix + silence-trim + NeuCodec pass.
        speaker_emb, ref_codes = tts.encode_reference(wav, denoise=True)
        emb_list = [round(float(x), 6) for x in speaker_emb.reshape(-1)]
        codes_list = (
            None
            if ref_codes is None
            else [[int(t) for t in row] for row in ref_codes.tolist()]
        )
        presets[name] = {
            "description": entry["description"],
            "gender": entry["gender"],
            "region": entry["region"],
            "style": entry["style"],
            "speaker_emb": emb_list,
            "codes": codes_list,
        }
        print(
            f"[enroll]   ✓ {name!r}: speaker_emb={len(emb_list)}-d, "
            f"codes={'None' if codes_list is None else f'{len(codes_list)}x{len(codes_list[0])}'}"
        )

    out = json.dumps(catalog, ensure_ascii=False, indent=2)
    for path in targets:
        path.write_text(out, encoding="utf-8")
        print(f"[enroll] ✓ Wrote {len(presets)} presets → {path}")
    print()
    print("[enroll] Restart the TTS server for changes to take effect.")
    print("         On the Mac:    bash app/tts-service/stop_all.sh && bash app/tts-service/start_all.sh")
    print("         On the VM:     cd app/ebook-converter && docker compose restart tts-vieneu")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

