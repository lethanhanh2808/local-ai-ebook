"""
Convert the hynt/F5-TTS-Vietnamese-ViVoice checkpoint into the layout that
f5-tts-mlx's `F5TTS.from_pretrained()` expects.

Two things need fixing about the upstream repo:

  1. It ships `model_last.pt` (a PyTorch training checkpoint holding an EMA
     state dict). The MLX port loads `model_v1.safetensors`.
  2. It has no `vocab.txt`. Its `config.json` IS the character vocab — 2566
     lines of one character each — which is why Hugging Face reports the file
     as invalid JSON. We copy it to its real name.

The MLX port's own `convert_weights` path handles the `ema_model.` prefix and
the layer renames/transposes at load time, so we only change the container
format here and leave the tensors alone.

Run:  .venv/bin/python convert_ckpt.py
"""
import sys
from pathlib import Path

MODEL_DIR = Path(__file__).parent / "models" / "vietnamese"
CKPT = MODEL_DIR / "model_last.pt"
OUT = MODEL_DIR / "model_v1.safetensors"
VOCAB_SRC = MODEL_DIR / "config.json"   # actually a plain character vocab
VOCAB_DST = MODEL_DIR / "vocab.txt"

# Bookkeeping entries in the EMA dict that are not model weights.
NON_TENSOR_KEYS = {"initted", "step"}


def main() -> int:
    import torch
    from safetensors.torch import save_file

    if not CKPT.exists():
        print(f"[convert] ✗ missing checkpoint: {CKPT}", file=sys.stderr)
        return 1

    if not VOCAB_DST.exists():
        if not VOCAB_SRC.exists():
            print(f"[convert] ✗ missing vocab: {VOCAB_SRC}", file=sys.stderr)
            return 1
        VOCAB_DST.write_bytes(VOCAB_SRC.read_bytes())
        print(f"[convert] vocab.txt written ({VOCAB_DST.stat().st_size} bytes)")

    n_vocab = len(VOCAB_DST.read_text(encoding="utf-8").split("\n"))
    print(f"[convert] vocab entries: {n_vocab}")

    if OUT.exists():
        print(f"[convert] {OUT.name} already exists — skipping conversion")
        return 0

    print(f"[convert] Loading {CKPT.name} (this takes a moment) ...")
    blob = torch.load(CKPT, map_location="cpu", weights_only=False)

    state = blob.get("ema_model_state_dict") if isinstance(blob, dict) else None
    if state is None:
        # Some exports store the weights at the top level instead.
        state = blob if isinstance(blob, dict) else None
    if state is None:
        print("[convert] ✗ could not find a state dict in the checkpoint", file=sys.stderr)
        return 1

    tensors = {}
    skipped = []
    for k, v in state.items():
        if k in NON_TENSOR_KEYS or not hasattr(v, "contiguous"):
            skipped.append(k)
            continue
        tensors[k] = v.contiguous()

    if not tensors:
        print("[convert] ✗ no tensors found in the state dict", file=sys.stderr)
        return 1

    save_file(tensors, str(OUT))
    print(f"[convert] skipped non-tensor keys: {skipped or 'none'}")
    print(f"[convert] ✓ wrote {OUT.name} — {len(tensors)} tensors, "
          f"{OUT.stat().st_size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
