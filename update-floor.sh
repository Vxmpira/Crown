#!/usr/bin/env bash
# ==============================================================================
#  update-floor.sh  ·  safe to re-run any time on the CROWN box
#  Re-applies The Floor persona + model settings to the EXISTING the-floor
#  workspace in the room engine. Does NOT create a workspace (that is
#  setup-floor.sh, which runs once). The persona text lives in setup-floor.sh
#  as the single source of truth; this script reads it from there.
#  Usage:  bash update-floor.sh
#          (reads ROOMS_API_KEY from /etc/crown/crown.env automatically)
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")"
BASE="http://127.0.0.1:3001/api/v1"
KEY="${ROOMS_API_KEY:-$(grep -E '^ROOMS_API_KEY=' /etc/crown/crown.env | cut -d= -f2- | tr -d '"' | tr -d "'")}"
[ -z "${KEY}" ] && { echo "ROOMS_API_KEY not found"; exit 1; }
AUTH=(-H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json")

# pull the canonical persona out of setup-floor.sh
eval "$(grep '^PROMPT=' setup-floor.sh)"
[ -z "${PROMPT:-}" ] && { echo "PROMPT not found in setup-floor.sh"; exit 1; }

echo "== updating the-floor persona + settings =="
curl -s "${AUTH[@]}" -X POST "${BASE}/workspace/the-floor/update" -d "$(python3 - << PYEOF
import json
print(json.dumps({
  "chatProvider": "openrouter",
  "chatModel": "meta-llama/llama-3.3-70b-instruct",
  "openAiPrompt": """${PROMPT}""",
  "openAiTemp": 0.6,
  "openAiHistory": 12
}))
PYEOF
)" | head -c 300; echo

echo "== smoke test =="
curl -s "${AUTH[@]}" -X POST "${BASE}/workspace/the-floor/chat" \
  -d '{"message":"Is the Nasdaq at all time highs right now?","mode":"chat","sessionId":"update-test"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('textResponse') or d.get('error') or 'no response')[:600])"
echo "== done =="
