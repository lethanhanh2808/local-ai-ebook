#!/usr/bin/env bash
# Generate sample WAVs for every built-in VieNeu voice.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$SCRIPT_DIR/voice_samples"
mkdir -p "$OUT"

# Use Python heredoc to safely escape Vietnamese characters.
read -r -d '' TEXT << 'EOF' || true
Xin chào bạn đọc. Đây là giọng đọc mặc định của hệ thống VieNeu TTS. Câu chuyện hôm nay bắt đầu từ một buổi sáng sương mù bao phủ cả ngọn núi cao [thở dài].
EOF

VOICES=( "Ngọc Lan" "Gia Bảo" "Thái Sơn" "Đức Trí" "Mỹ Duyên" "Trúc Ly" "Xuân Vĩnh" "Trọng Hữu" "Bình An" "Ngọc Linh" )

echo "=== Generating $(echo ${#VOICES[@]}) voice samples ==="
for voice in "${VOICES[@]}"; do
  safe=$(echo "$voice" | tr ' ' '_' | tr '[:upper:]' '[:lower:]')
  out="$OUT/${safe}.wav"
  payload=$(python3 -c "import json,sys; print(json.dumps({'text': sys.argv[1], 'voice': sys.argv[2]}))" "$TEXT" "$voice")
  size=$(curl -s -X POST http://127.0.0.1:5010/synthesize \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    -o "$out" -w '%{http_code} %{size_download} %{time_total}')
  echo "  $voice → $size  → $(basename $out)"
done

echo ""
echo "=== Summary ==="
ls -lh "$OUT"
echo ""
du -sh "$OUT"
