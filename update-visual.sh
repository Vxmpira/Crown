#!/usr/bin/env bash
# ==============================================================================
#  update-visual.sh  ·  safe to re-run on the CROWN box
#  Repoints the visual-analysis workspace at a vision model that currently
#  exists on OpenRouter. The old qwen2.5-vl-72b slug was retired, so the
#  engine had been silently falling back to a text-only default and
#  ignoring every image. Usage:  sudo bash update-visual.sh
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")"
BASE="http://127.0.0.1:3001/api/v1"
KEY="${ROOMS_API_KEY:-$(grep -E '^ROOMS_API_KEY=' /etc/crown/crown.env | cut -d= -f2- | tr -d '"' | tr -d "'")}"
[ -z "${KEY}" ] && { echo "ROOMS_API_KEY not found"; exit 1; }
AUTH=(-H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json")
MODEL="${VISION_MODEL:-qwen/qwen3.8-max-prime}"

echo "== repointing visual-analysis to ${MODEL} =="
curl -s "${AUTH[@]}" -X POST "${BASE}/workspace/visual-analysis/update" \
  -d "{\"chatProvider\":\"openrouter\",\"chatModel\":\"${MODEL}\",\"openAiTemp\":0.4}" | head -c 240; echo

echo "== smoke test (text) =="
curl -s "${AUTH[@]}" -X POST "${BASE}/workspace/visual-analysis/chat" \
  -d '{"message":"One sentence: what do you do?","mode":"chat","sessionId":"vis-update-test"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('textResponse') or d.get('error') or 'no response')[:200])"
echo "== done =="
