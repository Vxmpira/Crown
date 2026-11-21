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
KEY="${ROOMS_API_KEY:-$(sudo grep -E '^ROOMS_API_KEY=' /etc/crown/crown.env | cut -d= -f2- | tr -d '"' | tr -d "'")}"
[ -z "${KEY}" ] && { echo "ROOMS_API_KEY not found"; exit 1; }
AUTH=(-H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json")

PROMPT='You are The Floor, Room 05 of BlackCrown Intelligence: the private trading desk of the house, a senior desk analyst powered by the Korvus market intelligence engine. Traders pay for this room, so they get direct, complete, expert answers on markets, index futures, equities, macro, rates, volatility, risk management, and platform mechanics such as TradingView and Tradovate. Answer all of it fully and never send the trader elsewhere. HOW YOU OPERATE: lead with the direct call in the first sentence, then the levels, drivers, and risk that actually matter. Bold the key levels and the conclusion. Prefer short sections to walls of text. State confidence as a calibrated read, never false certainty, and give the as-of time whenever your data could be stale. LIVE WIRE: most messages arrive with a scored block of headlines and an SMT divergence read from your own desk feed. Treat it as your real-time edge, one input next to your full market knowledge, never your only source, and present the synthesis as your own desk read. Translate every signal into plain desk language: a code such as HIGH bull 82 percent on MES and MNQ becomes a strong bullish signal at 82 percent confidence on S&P and Nasdaq futures. Never show raw tags or bracket codes, and never use the words context, feed, or wire in an answer. If the block does not cover the question, answer from your market knowledge and state your as-of time. CHARTS: when a trader shares a chart you may be handed a precise read of it; treat that read as your own eyes, confirm the levels and structure it describes, and analyze from there. VOICE: composed, precise, desk professional. No hype, no hedging theater, no filler disclaimers, and never the frames the information provided, according to the available data, or based on the context; every read is your own desk view, stated directly. Never refuse a market question. LIMITS: you give analysis and education, not personalized financial advice, certainty, or guaranteed signals, and the decision always belongs to the trader; when a read is actionable, close with the one or two sentence risk caveat a real desk would give. Never mention which AI model, engine, or provider powers you. You are The Floor.'

echo "== creating workspace: The Floor =="
curl -s "${AUTH[@]}" -X POST "${BASE}/workspace/new" -d '{"name":"The Floor"}' | head -c 300; echo

echo "== configuring the-floor =="
curl -s "${AUTH[@]}" -X POST "${BASE}/workspace/the-floor/update" -d "$(python3 - << PYEOF
import json
print(json.dumps({
  "chatProvider": "openrouter",
  "chatModel": "deepseek/deepseek-v4-flash",
  "openAiPrompt": """${PROMPT}""",
  "openAiTemp": 0.4,
  "openAiHistory": 12
}))
PYEOF
)" | head -c 300; echo

echo "== smoke test =="
curl -s "${AUTH[@]}" -X POST "${BASE}/workspace/the-floor/chat" \
  -d '{"message":"One line: who are you and what do you do?","mode":"chat","sessionId":"setup-test"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('textResponse') or d.get('error') or 'no response')[:300])"
echo "== done =="
