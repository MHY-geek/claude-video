#!/bin/sh
# 一条命令重建整支片：影像 → 字体 → 配音 → 检查 → 时间线 → 事件 → 画面 → 混音 → 成片 → 字幕 → 检查 → 海报
set -e
LIB=/Users/mahaoyun/lemo-opuscar
HERE=$(cd "$(dirname "$0")" && pwd)
export LIB PATH="/opt/homebrew/bin:$PATH"
PY="$LIB/.venv/bin/python"
sh "$HERE/tools/fetch_assets.sh"
"$PY" "$HERE/tools/plates.py"
"$PY" "$HERE/tools/fonts.py"
"$PY" "$LIB/core/tts/tts_zh.py" "$HERE/voice/lines.json" "$HERE/voice"
"$PY" "$LIB/core/tts/asr_check.py" "$HERE/voice/lines.json" "$HERE/voice" --lang zh --model medium || echo "注意：语音识别有差异，请人工听一遍"
"$PY" "$HERE/tools/timeline.py"
cd "$LIB"
node core/render/events.mjs "$HERE"
node "$HERE/tools/video.mjs" "$HERE" --fps 24 --workers 5 --out "$HERE/out/video.mp4"
"$PY" "$HERE/mix.py"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/tenochtitlan.mp4" 24 0.8
"$PY" core/render/srt.py "$HERE/cues.json" "$HERE/tenochtitlan.srt"
node core/render/readcheck.mjs "$HERE" --step 0.25 || echo "注意：有文字停留时间不够"
ffmpeg -y -loglevel error -ss 30 -i "$HERE/tenochtitlan.mp4" -frames:v 1 -q:v 2 "$HERE/poster.jpg"
echo "完成：$HERE/tenochtitlan.mp4"
