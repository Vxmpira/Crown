#!/usr/bin/env bash
# ==============================================================================
#  diag-rooms.sh  ·  run on the CROWN box (sudo for the env file)
#  Pinpoints why the Visual room ignores images: prints each workspace's
#  actual provider + model straight from the engine, then sends an image
#  attachment DIRECTLY to the engine (bypassing server.js) and times it.
#    - If the direct call also answers wrong/instantly: the engine or its
#      workspace config is the problem (wrong model or provider).
#    - If the direct call reads the image: the fault is in the site path.
#  Usage:  sudo bash diag-rooms.sh
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")"
BASE="http://127.0.0.1:3001/api/v1"
KEY="${ROOMS_API_KEY:-$(grep -E '^ROOMS_API_KEY=' /etc/crown/crown.env | cut -d= -f2- | tr -d '"' | tr -d "'")}"
[ -z "${KEY}" ] && { echo "ROOMS_API_KEY not found"; exit 1; }
AUTH=(-H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json")

echo "== engine version =="
curl -s "${BASE%/v1}/ping" ; echo
docker inspect crown-rooms --format 'image: {{.Config.Image}}  created: {{.Created}}' 2>/dev/null || true

echo ""
echo "== per-room provider + model (as the engine sees them) =="
for slug in unfiltered deep-logic visual-analysis creativity the-floor; do
  curl -s "${AUTH[@]}" "${BASE}/workspace/${slug}" | python3 -c "
import json,sys
try:
  w=json.load(sys.stdin).get('workspace')
  w=w[0] if isinstance(w,list) else (w or {})
  print(f\"  {w.get('slug','?'):17s} provider={w.get('chatProvider')}  model={w.get('chatModel')}  temp={w.get('openAiTemp')}\")
except Exception as e:
  print('  ${slug}: unreadable:', e)"
done

# a 48x48 solid magenta-pink square, base64 PNG
PNG="iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAQklEQVR4nO3OQQ0AIAwAsQlDLJpQhAuOR5MK6Jy1vzL5QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF7hzHuJNSUFqAAAAAElFTkSuQmCC"

echo ""
echo "== direct engine test: visual-analysis WITH image attachment =="
T0=$(date +%s.%N)
RESP=$(curl -s "${AUTH[@]}" -X POST "${BASE}/workspace/visual-analysis/chat" -d "{
  \"message\": \"One word: what color is this square?\",
  \"mode\": \"chat\",
  \"sessionId\": \"diag-$(date +%s)\",
  \"attachments\": [{\"name\":\"swatch.png\",\"mime\":\"image/png\",\"contentString\":\"data:image/png;base64,${PNG}\"}]
}")
T1=$(date +%s.%N)
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  elapsed:', round(${T1}-${T0},1), 's')
print('  reply  :', (d.get('textResponse') or d.get('error') or 'no response')[:200])
m=d.get('metrics') or {}
print('  metrics:', {k:m[k] for k in ('prompt_tokens','completion_tokens','total_tokens') if k in m})
print()
print('  VERDICT: the square is magenta/pink. A correct color word in >2s means the')
print('  vision path works and the site path is at fault. An instant wrong answer')
print('  means this workspace is not actually running its vision model.')"

echo ""
echo "== engine logs: last attachment/vision related lines =="
docker logs crown-rooms --since 10m 2>&1 | grep -iE "attach|image|vision|qwen|openrouter" | tail -12 || echo "  (none)"
echo "== done =="
