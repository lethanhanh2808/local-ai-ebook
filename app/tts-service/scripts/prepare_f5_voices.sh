#!/usr/bin/env bash
# Prepare F5-TTS reference clips from the user-supplied voice samples.
#
# F5 is a zero-shot cloning model: it has no built-in voices, so every "voice"
# is a short reference clip plus its exact transcript. The model is strict about
# the audio format and raises on anything that is not 24 kHz — and it clones
# best from ~5-10s, not from a full-length recording.
#
# Source clips are 44.1 kHz stereo and ~29s, so each one is trimmed, downmixed,
# resampled and loudness-normalised here.
#
# Transcripts are auto-generated with mlx-whisper and MUST be reviewed by hand:
# a wrong ref_text is the single most common cause of garbled F5 output.
#
# Usage: bash scripts/prepare_f5_voices.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # app/tts-service
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
F5_DIR="$SCRIPT_DIR/F5-TTS"
SRC_DIR="$REPO_ROOT/reference/audio-voice-sample"
PY="$F5_DIR/.venv/bin/python"

# Trim window. The clips open with a beat of room tone, so we start at 2s and
# take 8s rather than using silenceremove, which tends to clip the low-energy
# onsets of Vietnamese tonal syllables.
TRIM_START=2
TRIM_DUR=8

# slug|source filename
VOICES=(
  "hong-dao|Hong-Dao-(Female).wav"
  "ngoc-ngan|Ngoc-Ngan-(Male).wav"
)

if [ ! -x "$PY" ]; then
  echo "[prep-f5] ✗ venv missing. Run scripts/setup_f5_tts.sh first."
  exit 1
fi

for entry in "${VOICES[@]}"; do
  slug="${entry%%|*}"
  fname="${entry##*|}"
  src="$SRC_DIR/$fname"
  out_dir="$F5_DIR/voices/$slug"
  clip="$out_dir/clip.wav"

  if [ ! -f "$src" ]; then
    echo "[prep-f5] ✗ missing source: $src"
    exit 1
  fi

  mkdir -p "$out_dir"

  echo "[prep-f5] $slug ← $fname"
  # -ac 1 -ar 24000 is mandatory: f5-tts-mlx raises ValueError on anything else.
  ffmpeg -hide_banner -loglevel error -y \
    -ss "$TRIM_START" -t "$TRIM_DUR" -i "$src" \
    -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
    -ac 1 -ar 24000 -c:a pcm_s16le \
    "$clip" || { echo "[prep-f5] ✗ ffmpeg failed for $slug"; exit 1; }

  # Report what we actually produced rather than what we asked for.
  ffprobe -v error -show_entries stream=sample_rate,channels \
    -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$clip" \
    | paste -sd' ' - | sed "s/^/[prep-f5]   /"

  if [ ! -f "$out_dir/transcript.txt" ]; then
    echo "[prep-f5]   transcribing ..."
    # mlx-whisper is a Python package, not a runnable CLI module, so we call
    # its transcribe() API directly. Output the transcript.txt; if anything
    # fails we surface the error so the user knows to write it by hand.
    if "$PY" - "$clip" "$out_dir/transcript.txt" <<'PYEOF'
import sys
import mlx_whisper
audio_path, out_path = sys.argv[1], sys.argv[2]
result = mlx_whisper.transcribe(
    audio_path,
    path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
    language="vi",
)
text = (result.get("text") or "").strip()
if not text:
    raise SystemExit("empty transcription")
with open(out_path, "w", encoding="utf-8") as f:
    f.write(text + "\n")
PYEOF
    then
      echo "[prep-f5]   transcript written"
    else
      echo "[prep-f5]   ⚠ auto-transcription failed — write $out_dir/transcript.txt by hand"
      rm -f "$out_dir/transcript.txt"
    fi
  else
    echo "[prep-f5]   transcript exists — keeping it"
  fi
done

echo ""
echo "[prep-f5] ✓ Clips ready. NOW REVIEW THE TRANSCRIPTS — F5 output degrades"
echo "          badly when ref_text does not match the audio:"
for entry in "${VOICES[@]}"; do
  slug="${entry%%|*}"
  f="$F5_DIR/voices/$slug/transcript.txt"
  echo ""
  echo "  --- $slug ---"
  [ -f "$f" ] && cat "$f" || echo "  (missing — write it by hand)"
done
echo ""
