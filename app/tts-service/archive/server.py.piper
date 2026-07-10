"""
Piper TTS FastAPI server — wraps rhasspy/piper-tts for local Vietnamese TTS.
Run: /tmp/tts-venv/bin/python server.py
"""
import io
import json
import struct
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from piper import PiperVoice
from piper.config import SynthesisConfig

app = FastAPI(title="Piper TTS")

MODEL_DIR = Path(__file__).parent / "models"
_VOICES: dict[str, PiperVoice] = {}

DEFAULT_VOICE = "vi_VN-vais1000-medium"


def _model_meta(name: str) -> dict:
    cfg_path = MODEL_DIR / f"{name}.onnx.json"
    if not cfg_path.exists():
        return {"num_speakers": 1, "speaker_id_map": {}}
    with cfg_path.open() as f:
        d = json.load(f)
    return {
        "num_speakers": d.get("num_speakers", 1),
        "speaker_id_map": d.get("speaker_id_map", {}),
        "sample_rate": d.get("audio", {}).get("sample_rate", 22050),
        "default_noise_scale": d.get("inference", {}).get("noise_scale", 0.667),
        "default_length_scale": d.get("inference", {}).get("length_scale", 1.0),
    }


def load_voice(model: str) -> PiperVoice:
    if model not in _VOICES:
        onnx = MODEL_DIR / f"{model}.onnx"
        if not onnx.exists():
            raise FileNotFoundError(f"Model not found: {onnx}")
        _VOICES[model] = PiperVoice.load(str(onnx))
    return _VOICES[model]


@app.on_event("startup")
async def _startup() -> None:
    load_voice(DEFAULT_VOICE)
    print(f"[TTS] Ready — voice: {DEFAULT_VOICE}", flush=True)


@app.get("/models")
async def list_models() -> dict:
    """Return all available voice models with speaker counts."""
    models = []
    for onnx in sorted(MODEL_DIR.glob("*.onnx")):
        meta = _model_meta(onnx.stem)
        models.append({"id": onnx.stem, **meta})
    return {"models": models}


class SynthRequest(BaseModel):
    text: str
    model: str = DEFAULT_VOICE
    speaker: Optional[int] = None       # speaker_id for multi-speaker models
    # length_scale: 1.0 = normal, 0.75 = 33% faster, 1.5 = slower
    length_scale: float = 1.0
    # noise_scale: expressiveness / pitch variation (0.3 flat → 1.0 lively)
    noise_scale: float = 0.667
    # noise_w: phoneme duration variation (0.3 uniform → 1.0 natural)
    noise_w: float = 0.8


@app.post("/synthesize")
async def synthesize(req: SynthRequest) -> Response:
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")

    try:
        voice = load_voice(req.model)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    syn_cfg = SynthesisConfig(
        speaker_id=req.speaker,
        length_scale=req.length_scale,
        noise_scale=req.noise_scale,
        noise_w_scale=req.noise_w,
    )

    # Collect all audio chunks then build a WAV file manually
    chunks = list(voice.synthesize(text, syn_cfg))
    if not chunks:
        raise HTTPException(500, "No audio generated")

    sample_rate = chunks[0].sample_rate
    num_channels = chunks[0].sample_channels
    sample_width = chunks[0].sample_width

    # Concatenate raw PCM bytes
    pcm = b"".join(c.audio_int16_bytes for c in chunks)

    # Build WAV in memory
    buf = io.BytesIO()
    # RIFF header
    data_len = len(pcm)
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_len))
    buf.write(b"WAVE")
    # fmt chunk
    buf.write(b"fmt ")
    buf.write(struct.pack("<IHHIIHH", 16, 1, num_channels, sample_rate,
                          sample_rate * num_channels * sample_width,
                          num_channels * sample_width, sample_width * 8))
    # data chunk
    buf.write(b"data")
    buf.write(struct.pack("<I", data_len))
    buf.write(pcm)

    audio = buf.getvalue()
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={
            "Content-Length": str(len(audio)),
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*",
        },
    )


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "voices": list(_VOICES.keys())}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=5002, log_level="info")
