"""
F5-TTS FastAPI server — Vietnamese zero-shot cloning TTS backed by
f5-tts-mlx (Apple-Silicon / Metal).

Run:  cd app/tts-service/F5-TTS && ./.venv/bin/python f5_server.py

Endpoints mirror app/tts-service/vieneu_server.py so the app side stays uniform:
  GET  /health                      – liveness + engine id
  GET  /voices                      – list catalog (id, label)
  POST /synthesize                  – synthesize WAV from { text, voice?, ref_audio?, ... }

License note: the bundled hynt/F5-TTS-Vietnamese-ViVoice weights are
CC-BY-NC-SA-4.0 — non-commercial. Fine for personal use; a blocker if this
app is ever commercialised. Note also: there is NO auth on /synthesize, so
anyone reachable on the bind address can drive the GPU. Firewall by host.

2026-08-30: this server is the F5 endpoint. The VieNeu server (port 5020) is
the other one. The runtime provider switch in the app picks which one to call.
"""
import os
import io
import re
import sys
import struct
from pathlib import Path
from typing import Optional

import numpy as np
import mlx.core as mx
import soundfile as sf

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

# Voice catalog: one slug per directory under F5_VOICES_DIR. Each directory
# must contain clip.wav (24kHz mono) + transcript.txt (the exact words spoken).
F5_VOICES_DIR = Path(
    os.environ.get(
        "F5_VOICES_DIR",
        str(Path(__file__).parent / "voices"),
    )
)
F5_MODEL_DIR = Path(
    os.environ.get(
        "F5_MODEL_DIR",
        str(Path(__file__).parent / "models" / "vietnamese"),
    )
)

# Constants mirrored from f5_tts_mlx.generate — duplicated here so we can
# call F5TTS.sample() directly without importing generate.py (which pulls in
# sounddevice and a CLI player).
SAMPLE_RATE = 24_000
HOP_LENGTH = 256
FRAMES_PER_SEC = SAMPLE_RATE / HOP_LENGTH
TARGET_RMS = 0.1

# VieNeu understands these inline tags; F5 would literally read the brackets
# and the Vietnamese word aloud, so strip them on the F5 path.
EMOTION_RE = re.compile(r"\[(cười|thở dài|hắng giọng)\]", re.IGNORECASE)

app = FastAPI(title="F5-TTS (Vietnamese) Server")

_tts = None
_VOICES_CACHE = None


def get_tts():
    """Lazy-init the F5TTS model. Cached on first call so subsequent
    /synthesize requests reuse the loaded weights."""
    global _tts
    if _tts is None:
        from f5_tts_mlx.cfm import F5TTS
        # f5-tts-mlx's fetch_from_hub() rejects local paths (it always tries
        # HF snapshot_download, which validates repo_id format). When
        # F5_MODEL_DIR points at a local dir we short-circuit that call.
        # cfm.py imports fetch_from_hub into its own module namespace, so we
        # must patch it there, not on f5_tts_mlx.utils.
        import f5_tts_mlx.cfm as _cfm
        if F5_MODEL_DIR.exists():
            original = _cfm.fetch_from_hub

            def _local_fetch(hf_repo, quantization_bits=None):
                return F5_MODEL_DIR

            _cfm.fetch_from_hub = _local_fetch
            try:
                _tts = F5TTS.from_pretrained(str(F5_MODEL_DIR))
            finally:
                _cfm.fetch_from_hub = original
        else:
            _tts = F5TTS.from_pretrained(str(F5_MODEL_DIR))

        # The Vietnamese fine-tune (hynt/F5-TTS-Vietnamese-ViVoice, nguyenthienhy's
        # F5TTS_Base.yaml config) was trained with text_mask_padding=False. The
        # mlx port hardcodes True in cfm.F5TTS.from_pretrained — that mismatch
        # zeros out padded positions inside the ConvNeXt text-embedding blocks
        # at inference, muffling the high-frequency content where Vietnamese
        # tones live. The fix is a one-line override after load — the weights
        # are static, only the forward-time mask application flips. Verified
        # by spectral centroid 2048 Hz → 2716 Hz on a hong-dao test clip.
        _apply_vietnamese_finetune_overrides(_tts)

        # f5-tts-mlx 0.2.6 calls mx.random.normal((c, n)) — newer MLX rejects
        # the tuple AND the iter produces mx scalars, not Python ints, so
        # shape = (int, mx_array). Coerce both.
        _orig_normal = _cfm.mx.random.normal

        def _coerce(x):
            # mlx scalars come back as 0-d mx.array; .item() extracts the int.
            if hasattr(x, "item") and callable(x.item):
                try:
                    return int(x.item())
                except Exception:
                    return x
            return int(x) if isinstance(x, (int, float)) else x

        def _normal_compat(shape, *args, **kwargs):
            if isinstance(shape, (tuple, list)):
                shape = [_coerce(d) for d in shape]
            elif hasattr(shape, "__iter__"):
                shape = [_coerce(d) for d in shape]
            return _orig_normal(shape, *args, **kwargs)

        _cfm.mx.random.normal = _normal_compat
    return _tts


def _apply_vietnamese_finetune_overrides(tts) -> None:
    """Apply the inference-time overrides that align the mlx port with how
    the Vietnamese fine-tune was actually trained. The mlx port hardcodes
    text_mask_padding=True in DiT.__init__; the fine-tune (hynt's checkpoint,
    nguyenthienhy's F5TTS_Base.yaml) was trained with False, so we flip it
    after the model is constructed. Verified against the hong-dao test clip
    by spectral centroid 2048 Hz → 2716 Hz (ref 3520 Hz)."""
    tts.transformer.text_embed.mask_padding = False


def _list_voice_dirs() -> list[Path]:
    if not F5_VOICES_DIR.exists():
        return []
    return sorted(p for p in F5_VOICES_DIR.iterdir() if p.is_dir())


def _voice_label(slug: str) -> str:
    """Render slug as a display label: hong-dao -> Hồng Đào fallback."""
    overrides = {
        "hong-dao": "Hồng Đào (Female)",
        "ngoc-ngan": "Ngọc Ngân (Male)",
    }
    if slug in overrides:
        return overrides[slug]
    return slug.replace("-", " ").title()


def get_voices():
    """Return the catalog as {voices: [{id, label}, ...]}."""
    global _VOICES_CACHE
    if _VOICES_CACHE is None:
        catalog = []
        for d in _list_voice_dirs():
            clip = d / "clip.wav"
            transcript = d / "transcript.txt"
            if not clip.exists() or not transcript.exists():
                # Skip half-prepared dirs rather than fail the catalog.
                continue
            catalog.append({"id": d.name, "label": _voice_label(d.name)})
        _VOICES_CACHE = catalog
    return {"voices": _VOICES_CACHE}


def _resolve_voice(voice: Optional[str]) -> tuple[Path, str]:
    """Map a voice slug to (clip.wav path, transcript). Raises HTTPException(400)
    on unknown slug or missing files."""
    if not voice:
        raise HTTPException(400, "voice is required (no built-in voices for F5)")
    d = F5_VOICES_DIR / voice
    clip = d / "clip.wav"
    transcript = d / "transcript.txt"
    if not d.exists():
        raise HTTPException(400, f"unknown voice: {voice}")
    if not clip.exists() or not transcript.exists():
        raise HTTPException(400, f"voice {voice!r} is not prepared (clip.wav + transcript.txt required)")
    return clip, transcript.read_text(encoding="utf-8").strip()


def _load_ref_audio(path: Path) -> tuple[mx.array, int]:
    """Load a reference clip and validate it. f5-tts-mlx raises ValueError
    on anything other than 24 kHz mono — surface that as a clean 400."""
    audio, sr = sf.read(str(path))
    if sr != SAMPLE_RATE:
        raise HTTPException(
            400,
            f"reference audio sample rate is {sr}, must be {SAMPLE_RATE}",
        )
    if hasattr(audio, "ndim") and audio.ndim > 1:
        # Shouldn't happen because prepare_f5_voices.sh downmixes, but defend.
        audio = audio.mean(axis=1)
    return mx.array(audio.astype(np.float32)), sr


def _estimate_duration_seconds(ref_audio: mx.array, ref_text: str, gen_text: str, speed: float = 1.0) -> float:
    """Heuristic from f5_tts_mlx.generate.estimated_duration — slightly tweaked
    for Vietnamese (the Chinese-punctuation regex contributes nothing here,
    but the byte-length-based ratio still holds). Used because the Vietnamese
    fine-tune does not ship a duration_v2.safetensors predictor."""
    import re as _re
    ref_audio_len_frames = ref_audio.shape[0] // HOP_LENGTH
    zh_pause_punc = r"。，、；：？！"
    ref_text_len = len(ref_text.encode("utf-8")) + 3 * len(_re.findall(zh_pause_punc, ref_text))
    gen_text_len = len(gen_text.encode("utf-8")) + 3 * len(_re.findall(zh_pause_punc, gen_text))
    if ref_text_len <= 0 or gen_text_len <= 0:
        # Degenerate — fall back to 8s of generation so the sampler has room.
        return max(1.0, len(gen_text) / 20.0)
    duration_in_frames = ref_audio_len_frames + int(ref_audio_len_frames / ref_text_len * gen_text_len / speed)
    return max(0.5, duration_in_frames / FRAMES_PER_SEC)


def _apply_speed(wave: mx.array, speed: float) -> mx.array:
    """F5's `speed` parameter scales the *duration* of the generated audio
    inside the sampler (it changes how long the diffusion runs for). For a
    server we additionally want the output length to actually match — at
    speed=2.0 we want half the samples. We do that with a simple resample.
    F5 is at 24 kHz so soxr isn't required; np.interp is fine."""
    if abs(speed - 1.0) < 0.01:
        return wave
    n_in = int(wave.shape[0])
    n_out = max(1, int(n_in / speed))
    x_old = np.linspace(0.0, 1.0, n_in, endpoint=False)
    x_new = np.linspace(0.0, 1.0, n_out, endpoint=False)
    return mx.array(np.interp(x_new, x_old, np.array(wave)).astype(np.float32))


def synthesize(
    text: str,
    voice: Optional[str] = None,
    ref_audio: Optional[str] = None,
    ref_text: Optional[str] = None,
    speed: float = 1.0,
    style: str = "doc_truyen",  # accepted for contract compatibility; ignored
    # 2026-08-31: cfg=2.0 (not 1.0) is the right default once
    # text_mask_padding=False is in effect — the previous f5_param_search.py
    # sweep was measured against the buggy mlx port default (mask_padding=True)
    # which muffled high frequencies, and cfg=1.0 was tuned to compensate for
    # that. With the mask fix, cfg=2.0 gets spectral centroid 3776 Hz (ref
    # 3520 Hz) and formant2 energy 10.3% (ref 7%) on the hong-dao test clip;
    # cfg=1.0 sits at 2716 Hz / 3.9% and sounds toneless. RTF cost is the
    # same — the cfg term just adds one more transformer forward per step.
    steps: int = 16,
    cfg_strength: float = 2.0,
    seed: Optional[int] = None,
) -> bytes:
    from f5_tts_mlx.utils import convert_char_to_pinyin

    text = EMOTION_RE.sub("", text).strip()
    if not text:
        raise HTTPException(400, "text is empty after stripping emotion markers")

    # Resolve reference audio + its exact transcript.
    if voice:
        ref_path, ref_transcript = _resolve_voice(voice)
    elif ref_audio:
        ref_path = Path(ref_audio)
        if not ref_path.exists():
            raise HTTPException(400, f"ref_audio not found: {ref_audio}")
        ref_transcript = (ref_text or "").strip()
        if not ref_transcript:
            raise HTTPException(400, "ref_text is required when ref_audio is supplied")
    else:
        raise HTTPException(400, "either `voice` or `ref_audio`+`ref_text` is required")

    audio, sr = _load_ref_audio(ref_path)
    if sr != SAMPLE_RATE:
        # Already guarded in _load_ref_audio, but the type checker likes this.
        raise HTTPException(400, f"reference audio sample rate is {sr}, must be {SAMPLE_RATE}")

    # Reference-audio loudness normalisation (mirrors generate.py).
    rms = float(mx.sqrt(mx.mean(mx.square(audio))))
    if rms < TARGET_RMS:
        audio = audio * (TARGET_RMS / max(rms, 1e-8))

    # Same single-shot path as generate.py: prepend the reference transcript
    # so the model conditions on the speaker, then trim those frames off the
    # front of the output.
    speed = max(0.5, min(2.0, float(speed or 1.0)))
    f5tts = get_tts()
    pinyin_text = convert_char_to_pinyin([ref_transcript + " " + text])

    # The Vietnamese checkpoint does not ship a duration predictor, so we
    # must pass an explicit duration. Heuristic from generate.py.
    duration_seconds = _estimate_duration_seconds(audio, ref_transcript, text, speed)
    duration_frames = int(duration_seconds * FRAMES_PER_SEC)

    wave, _ = f5tts.sample(
        mx.expand_dims(audio, axis=0),
        text=pinyin_text,
        duration=duration_frames,
        steps=steps,
        method="rk4",
        cfg_strength=cfg_strength,
        speed=speed,
        sway_sampling_coef=-1.0,
        seed=seed,
    )
    wave = wave[audio.shape[0]:]
    mx.eval(wave)

    # Apply speed post-hoc so the returned WAV is actually the requested speed.
    if abs(speed - 1.0) >= 0.01:
        wave = _apply_speed(wave, speed)
        mx.eval(wave)

    audio_np = np.asarray(wave, dtype=np.float32)
    audio_np = np.clip(audio_np, -1.0, 1.0)
    pcm = (audio_np * 32767.0).astype("<i2").tobytes()

    buf = io.BytesIO()
    data_len = len(pcm)
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_len))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<IHHIIHH", 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16))
    buf.write(b"data")
    buf.write(struct.pack("<I", data_len))
    buf.write(pcm)
    return buf.getvalue()


class SynthesizeRequest(BaseModel):
    text: str
    voice: Optional[str] = None            # catalog slug, e.g. "hong-dao"
    ref_audio: Optional[str] = None        # path on disk for ad-hoc cloning
    ref_text: Optional[str] = None
    speed: Optional[float] = 1.0
    style: Optional[str] = "doc_truyen"    # ignored (no F5 equivalent)
    steps: Optional[int] = 16
    cfg_strength: Optional[float] = 2.0
    seed: Optional[int] = None


@app.get("/health")
async def health():
    return {"status": "ok", "engine": "f5-tts-vietnamese"}


@app.get("/voices")
async def voices_endpoint():
    return get_voices()


@app.post("/synthesize")
async def synthesize_endpoint(req: SynthesizeRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "text is required")
    if len(text) > 10_000:
        raise HTTPException(413, "text is too long (maximum 10000 characters)")
    try:
        wav = synthesize(
            text,
            req.voice,
            req.ref_audio,
            req.ref_text,
            req.speed or 1.0,
            req.style or "doc_truyen",
            req.steps or 16,
            req.cfg_strength or 1.0,
            req.seed,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"F5 synthesis failed: {e}")
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "X-TTS-Engine": "f5",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*",
        },
    )


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("F5_HOST", "0.0.0.0")
    port = int(os.environ.get("F5_PORT", "5021"))
    print(f"[f5] Loading model from {F5_MODEL_DIR} (first run: ~30s) ...")
    get_tts()  # warm up so the first /synthesize isn't 30s late
    print(f"[f5] Voices: {[v['id'] for v in get_voices()['voices']]}")
    print(f"[f5] ⚠ no auth on /synthesize — anyone who can reach {host}:{port} can drive the GPU")
    uvicorn.run(app, host=host, port=port, log_level="info")