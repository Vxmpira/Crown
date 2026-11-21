#!/usr/bin/env bash
# ============================================================
# Crown Room Engine: smoke-test the Four Rooms after a model swap
# ------------------------------------------------------------
# Usage:
#   bash test-rooms.sh <ANYTHINGLLM_API_KEY>
#
# Hits each room with a tiny prompt and prints the reply + the
# model that answered. A room that errors or returns empty is a
# FAIL you want to see BEFORE users do. Run it right after
# setup-rooms.sh so a bad slug surfaces immediately.
# ============================================================
set -u

API_KEY="${1:-}"
BASE="http://127.0.0.1:3001/api/v1"
[ -z "$API_KEY" ] && { echo "Usage: bash test-rooms.sh <ANYTHINGLLM_API_KEY>"; exit 1; }

auth=( -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" )

# room slug  ->  tiny prompt that exercises the room's job
declare -A PROMPTS=(
  [unfiltered]="Reply with one short sentence confirming you are online."
  [deep-logic]="What is 17 * 23? Show one line of working."
  [visual-analysis]="Reply with one short sentence confirming you are online."
  [creativity]="Give one punchy five-word tagline for a raven-themed brand."
)

ping=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3001/api/ping")
[ "$ping" != "200" ] && { echo "ERROR: engine not responding on :3001 (got $ping). docker compose up -d"; exit 1; }

fail=0
for slug in unfiltered deep-logic visual-analysis creativity; do
  echo "──────────────────────────────────────────────"
  echo "ROOM: $slug"
  sid="smoke-$(date +%s)-$RANDOM"
  resp=$(curl -s -X POST "${BASE}/workspace/${slug}/chat" "${auth[@]}" \
    -d "{\"message\":\"${PROMPTS[$slug]}\",\"mode\":\"chat\",\"sessionId\":\"${sid}\"}")

  # pull fields with python (always present on the box)
  parsed=$(python3 - "$resp" <<'PYEOF'
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception as e:
    print("PARSE_FAIL|"+str(e)+"|"); sys.exit(0)
err  = d.get("error")
text = (d.get("textResponse") or "").strip().replace("\n"," ")
# AnythingLLM reports the model under a few possible keys across builds
model = d.get("chatModel") or (d.get("metrics") or {}).get("model") or ""
print(("ERR" if err else "OK")+"|"+(err or text)[:200]+"|"+str(model))
PYEOF
)
  status="${parsed%%|*}"; rest="${parsed#*|}"; body="${rest%%|*}"; model="${rest#*|}"
  if [ "$status" = "OK" ] && [ -n "$body" ]; then
    echo "  ✅ reply: $body"
    [ -n "$model" ] && echo "     model: $model"
  else
    echo "  ❌ FAIL: $body"
    echo "     (check the model slug for this room in setup-rooms.sh, then re-run setup-rooms.sh)"
    fail=1
  fi
done

echo "──────────────────────────────────────────────"
[ "$fail" = "0" ] && echo "ALL ROOMS OK ✅" || { echo "ONE OR MORE ROOMS FAILED ❌"; exit 1; }
