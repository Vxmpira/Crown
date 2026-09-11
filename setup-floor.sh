#!/usr/bin/env bash
# ==============================================================================
#  setup-floor.sh  ·  runs ONCE on the CROWN box
#  Creates the fifth workspace, "the-floor", inside the internal room engine.
#  Mirrors setup-rooms.sh: create, then configure provider, model, and persona.
#  Usage:  ROOMS_API_KEY=xxxx bash setup-floor.sh
#          (or it reads ROOMS_API_KEY from /etc/crown/crown.env automatically)
# ==============================================================================
set -euo pipefail
BASE="http://127.0.0.1:3001/api/v1"
KEY="${ROOMS_API_KEY:-$(grep -E '^ROOMS_API_KEY=' /etc/crown/crown.env | cut -d= -f2- | tr -d '"' | tr -d "'")}"
[ -z "${KEY}" ] && { echo "ROOMS_API_KEY not found"; exit 1; }
AUTH=(-H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json")

PROMPT='You are The Floor, Room 05 of BlackCrown Intelligence: the private trading room of the house, powered by the Korvus market intelligence engine. Most prompts arrive with a [LIVE MARKET CONTEXT] block of scored headlines (impact, direction, confidence, instruments) and an SMT divergence read. Ground every market answer in that block: cite the impact rating and confidence when you lean on an item, connect stories to the instruments they touch, and read the tape like a desk analyst briefing a trader. If the context block is missing, stale, or does not cover the question, say so plainly instead of inventing market data, then answer from general knowledge clearly labeled as such. You provide information, analysis, and context. You never give financial advice, never predict with certainty, and never issue trade signals: the decision always belongs to the trader. Voice: composed, precise, desk-professional. No hype, no hedging theater. You never mention which AI model, engine, or provider powers you. You are The Floor.'

echo "== creating workspace: The Floor =="
curl -s "${AUTH[@]}" -X POST "${BASE}/workspace/new" -d '{"name":"The Floor"}' | head -c 300; echo

echo "== configuring the-floor =="
curl -s "${AUTH[@]}" -X POST "${BASE}/workspace/the-floor/update" -d "$(python3 - << PYEOF
import json
print(json.dumps({
  "chatProvider": "openrouter",
  "chatModel": "meta-llama/llama-3.3-70b-instruct",
  "openAiPrompt": """${PROMPT}""",
  "openAiTemp": 0.55,
  "openAiHistory": 12
}))
PYEOF
)" | head -c 300; echo

echo "== smoke test =="
curl -s "${AUTH[@]}" -X POST "${BASE}/workspace/the-floor/chat" \
  -d '{"message":"One line: who are you and what do you do?","mode":"chat","sessionId":"setup-test"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('textResponse') or d.get('error') or 'no response')[:300])"
echo "== done =="
