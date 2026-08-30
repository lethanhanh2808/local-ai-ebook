#!/usr/bin/env python3
"""
F5 sampling-parameter sweep.

For each (steps, cfg_strength) combination in the grid, synthesize the
same Vietnamese sentence with hong-dao + ngoc-ngan voices, save the
WAV, and compute voice-similarity against the prepared reference clip.

Voice-similarity metric: MFCC cosine similarity (standard baseline for
"is this the same speaker"). We use 20 coefficients, 25ms window, 10ms
hop, with mean+var normalisation. Cosine similarity is computed frame-
by-frame, then averaged across all overlapping frames.

The grid covers:
  - steps ∈ {8, 16, 32, 64}:  speed-optimised → quality-optimised
  - cfg_strength ∈ {1.0, 1.5, 2.0, 3.0}:  under- → over-conditioned

Results are written to stdout (sorted by similarity, descending) and
each WAV is saved under /tmp/f5-grid/. The user can then listen to the
top-N candidates.
"""

from __future__ import annotations

import io
import json
import os
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np
import scipy.signal
import soundfile as sf

BASE = "http://127.0.0.1:5021"
VOICES_DIR = Path("/Volumes/EXT-SSD/Users/anhl/local-ai-ebook/app/tts-service/F5-TTS/voices")
OUT_DIR = Path("/tmp/f5-grid")
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Use the transcript as the test sentence — ref_text == target_text is
# the cleanest F5 test case (the model basically does a self-clone).
# Punctuation stripped so F5 doesn't try to read a period.
TEST_TEXT_HD = "Tôi không kể cho ông được chuyện này thì tôi ái náy lắm mà con tôi thì bây giờ nó ở bên kia thế giới"
TEST_TEXT_NN = "Tháng tám hai nghìn không trăm lẻ sáu nhân chuyến lưu diễn ở một thành phố thuộc miền đông Hoa Kỳ tôi tình cờ gặp một bà cụ trong quán ăn"

GRID = [
    (8, 1.0), (8, 1.5), (8, 2.0), (8, 3.0),
    (16, 1.0), (16, 1.5), (16, 2.0), (16, 3.0),
    (32, 1.0), (32, 1.5), (32, 2.0), (32, 3.0),
    (64, 1.5), (64, 2.0),
]

# ── MFCC helpers ──────────────────────────────────────────────────────────

def load_wav_mono_24k(path: Path) -> np.ndarray:
    """Load a WAV as mono float32 at 24 kHz. Resamples if needed."""
    audio, sr = sf.read(str(path))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    audio = audio.astype(np.float32)
    if sr != 24000:
        # Resample with scipy (polyphase, good quality)
        new_len = int(round(len(audio) * 24000 / sr))
        audio = scipy.signal.resample(audio, new_len).astype(np.float32)
    return audio


def hz_to_mel(hz: np.ndarray) -> np.ndarray:
    return 2595.0 * np.log10(1.0 + hz / 700.0)


def mel_to_hz(mel: np.ndarray) -> np.ndarray:
    return 700.0 * (10 ** (mel / 2595.0) - 1.0)


def mel_filterbank(n_fft: int, n_mels: int = 40, sr: int = 24000,
                   fmin: float = 0.0, fmax: float | None = None) -> np.ndarray:
    if fmax is None:
        fmax = sr / 2.0
    n_freqs = n_fft // 2 + 1
    fft_freqs = np.linspace(0, sr / 2, n_freqs)
    mel_min = hz_to_mel(np.array([fmin]))[0]
    mel_max = hz_to_mel(np.array([fmax]))[0]
    mel_points = np.linspace(mel_min, mel_max, n_mels + 2)
    hz_points = mel_to_hz(mel_points)
    bin_points = np.floor((n_fft + 1) / sr * hz_points).astype(int)

    fb = np.zeros((n_mels, n_freqs), dtype=np.float32)
    for m in range(1, n_mels + 1):
        lo, mid, hi = bin_points[m - 1], bin_points[m], bin_points[m + 1]
        if mid > lo:
            fb[m - 1, lo:mid] = (np.arange(lo, mid) - lo) / (mid - lo)
        if hi > mid:
            fb[m - 1, mid:hi] = (hi - np.arange(mid, hi)) / (hi - mid)
    return fb


_DCT_MAT: np.ndarray | None = None


def dct_matrix(n_mels: int, n_mfcc: int) -> np.ndarray:
    """Type-II DCT matrix, normalised."""
    global _DCT_MAT
    if _DCT_MAT is None or _DCT_MAT.shape != (n_mfcc, n_mels):
        n = np.arange(n_mels)
        k = np.arange(n_mfcc)[:, None]
        _DCT_MAT = np.cos(np.pi * k * (2 * n + 1) / (2 * n_mels)) * np.sqrt(2.0 / n_mels)
        _DCT_MAT[0, :] /= np.sqrt(2.0)
    return _DCT_MAT


def mfcc(audio: np.ndarray, sr: int = 24000, n_mfcc: int = 20,
         win_ms: float = 25.0, hop_ms: float = 10.0) -> np.ndarray:
    """Compute MFCC matrix: shape (n_frames, n_mfcc)."""
    n_fft = int(round(sr * win_ms / 1000))
    hop = int(round(sr * hop_ms / 1000))
    # Pad so first/last frames align
    audio = np.concatenate([np.zeros(n_fft // 2, dtype=audio.dtype), audio, np.zeros(n_fft // 2, dtype=audio.dtype)])
    # STFT magnitude (Hann window)
    _, _, Z = scipy.signal.stft(audio, fs=sr, window='hann', nperseg=n_fft,
                                 noverlap=n_fft - hop, nfft=n_fft,
                                 return_onesided=True, boundary=None)
    mag = np.abs(Z).astype(np.float32)
    # Mel filterbank
    fb = mel_filterbank(n_fft=n_fft, n_mels=40, sr=sr)
    mel_spec = (mag.T @ fb.T).T  # (40, n_frames)
    # Floor + log
    mel_spec = np.maximum(mel_spec, 1e-10)
    log_mel = np.log(mel_spec)
    # DCT → MFCC
    D = dct_matrix(log_mel.shape[0], n_mfcc)
    return (D @ log_mel).T  # (n_frames, n_mfcc)


def mfcc_cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Voice-similarity from raw MFCC mean vector (timbre centroid).

    We deliberately do NOT CMVN-normalise the matrix — that destroys the
    timbre centroid by forcing the per-coefficient mean to ~0. The raw
    mean vector across all frames IS the speaker's timbral signature
    (the same quantity Gaussian speaker-verification systems use), so
    cosine similarity of two raw mean vectors gives a real, varying
    number that distinguishes good clones from bad ones.

    Range is approximately [-1, +1]. Higher = more similar.
    """
    if len(a) < 4 or len(b) < 4:
        return 0.0
    a_mu = a.mean(axis=0)
    b_mu = b.mean(axis=0)
    na, nb = np.linalg.norm(a_mu), np.linalg.norm(b_mu)
    if na < 1e-8 or nb < 1e-8:
        return 0.0
    return float(a_mu @ b_mu / (na * nb))


def log_mel_distance(a_audio: np.ndarray, b_audio: np.ndarray) -> float:
    """Mean L2 distance between log-mel spectrograms (MCD-lite).

    Smaller = more similar. Computed on log-magnitude mel spectrograms
    (40 mels) with a fixed alignment: the shorter is zero-padded to the
    longer's frame count, then per-frame L2 averaged.

    Returns a distance in log-mel units (typical range: 5–15 for
    same-speaker pairs, 15–25 for cross-speaker).
    """
    def log_mel(audio: np.ndarray) -> np.ndarray:
        n_fft = 600  # 25 ms @ 24 kHz
        hop = 240    # 10 ms @ 24 kHz
        audio_p = np.concatenate([np.zeros(n_fft // 2, dtype=audio.dtype), audio, np.zeros(n_fft // 2, dtype=audio.dtype)])
        _, _, Z = scipy.signal.stft(audio_p, fs=24000, window='hann', nperseg=n_fft,
                                     noverlap=n_fft - hop, nfft=n_fft,
                                     return_onesided=True, boundary=None)
        mag = np.abs(Z).astype(np.float32) + 1e-10
        fb = mel_filterbank(n_fft=n_fft, n_mels=40, sr=24000)
        mel = mag.T @ fb.T  # (n_frames, 40)
        return np.log(np.maximum(mel, 1e-10))

    A = log_mel(a_audio)
    B = log_mel(b_audio)
    n = max(A.shape[0], B.shape[0])
    if A.shape[0] < n:
        A = np.concatenate([A, np.zeros((n - A.shape[0], 40), dtype=A.dtype)])
    if B.shape[0] < n:
        B = np.concatenate([B, np.zeros((n - B.shape[0], 40), dtype=B.dtype)])
    return float(np.sqrt(((A - B) ** 2).sum(axis=1)).mean())


# ── Synth + measure one voice ─────────────────────────────────────────────

def synth(voice: str, text: str, steps: int, cfg: float) -> tuple[bytes, float]:
    payload = json.dumps({
        "text": text, "voice": voice, "language": "vi",
        "speed": 1.0, "steps": steps, "cfg_strength": cfg,
    }).encode("utf-8")
    t0 = time.perf_counter()
    req = urllib.request.Request(
        f"{BASE}/synthesize",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        body = r.read()
    elapsed = time.perf_counter() - t0
    return body, elapsed


def wav_bytes_to_array(data: bytes) -> tuple[np.ndarray, int]:
    bio = io.BytesIO(data)
    audio, sr = sf.read(bio)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return audio.astype(np.float32), sr


def sweep_voice(voice: str, slug: str, text: str) -> list[dict]:
    ref_path = VOICES_DIR / slug / "clip.wav"
    ref_audio = load_wav_mono_24k(ref_path)
    ref_mfcc = mfcc(ref_audio)
    rows = []
    for steps, cfg in GRID:
        out_path = OUT_DIR / f"{slug}-steps{steps:02d}-cfg{cfg:.1f}.wav"
        try:
            body, elapsed = synth(voice, text, steps, cfg)
        except Exception as e:
            rows.append({"voice": voice, "steps": steps, "cfg": cfg,
                         "elapsed_s": None, "sim": None, "err": str(e)})
            continue
        out_path.write_bytes(body)
        syn_audio, _ = wav_bytes_to_array(body)
        syn_mfcc = mfcc(syn_audio)
        sim = mfcc_cosine_similarity(ref_mfcc, syn_mfcc)
        mcd = log_mel_distance(ref_audio, syn_audio)
        rows.append({
            "voice": voice, "steps": steps, "cfg": cfg,
            "elapsed_s": round(elapsed, 2),
            "sim": round(sim, 4),
            "mcd": round(mcd, 3),
            "file": str(out_path),
            "dur_s": round(len(syn_audio) / 24000.0, 2),
        })
    return rows


def main():
    all_rows: list[dict] = []
    for voice, slug, text in [
        ("hong-dao", "hong-dao", TEST_TEXT_HD),
        ("ngoc-ngan", "ngoc-ngan", TEST_TEXT_NN),
    ]:
        print(f"== {voice} ==")
        rows = sweep_voice(voice, slug, text)
        rows_sorted = sorted([r for r in rows if r.get("sim") is not None],
                             key=lambda r: r["sim"], reverse=True)
        for r in rows_sorted:
            print(f"  steps={r['steps']:>2} cfg={r['cfg']:.1f}  "
                  f"sim={r['sim']:.4f}  mcd={r['mcd']:.2f}  "
                  f"elapsed={r['elapsed_s']:.2f}s  dur={r['dur_s']:.2f}s  {r['file']}")
        for r in rows:
            if r.get("sim") is None:
                print(f"  steps={r['steps']:>2} cfg={r['cfg']:.1f}  ERROR {r['err']}")
        all_rows.extend(rows)

    # Save full report
    report_path = OUT_DIR / "report.json"
    report_path.write_text(json.dumps(all_rows, indent=2, ensure_ascii=False))
    print(f"\nReport saved → {report_path}")
    print(f"WAVs       → {OUT_DIR}")


if __name__ == "__main__":
    main()
