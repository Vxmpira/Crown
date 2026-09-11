#!/usr/bin/env bash
# ==============================================================================
#  floor-feed.sh  ·  runs on the CROWN box (blackcrown-vxj-AI)
#  Pulls Korvus scored news (keyed endpoint) + the public SMT read, merges them
#  into /var/lib/crown/floor-context.json. server.js injects that file into
#  every Room 05 (The Floor) prompt. Runs every 5 minutes from cron.
#  Requires KORVUS_FEED_KEY in /etc/crown/crown.env (same value as the
#  FLOOR_FEED_KEY on the Korvus box).
# ==============================================================================
set -u
OUT="/var/lib/crown/floor-context.json"
TMP="${OUT}.tmp"
BASE="https://korvus.industries"

# read the shared key from crown.env without exporting everything
KEY="$(grep -E '^KORVUS_FEED_KEY=' /etc/crown/crown.env | cut -d= -f2- | tr -d '"' | tr -d "'")"
if [ -z "${KEY}" ]; then echo "floor-feed: KORVUS_FEED_KEY missing in /etc/crown/crown.env" >&2; exit 1; fi

NEWS="$(curl -s --max-time 20 -H "X-Floor-Key: ${KEY}" "${BASE}/api/feed/floor" || true)"
SMT="$(curl -s --max-time 20 "${BASE}/api/smt" || true)"

python3 - "$NEWS" "$SMT" > "${TMP}" << 'PYEOF'
import json, sys, time
news_raw, smt_raw = sys.argv[1], sys.argv[2]
out = {"generated_at": int(time.time() * 1000), "items": [], "smt": None}
try:
    n = json.loads(news_raw)
    if isinstance(n.get("items"), list):
        out["items"] = n["items"][:30]
except Exception:
    pass
try:
    s = json.loads(smt_raw)
    verdict = s.get("verdict")
    if isinstance(verdict, dict):
        out["smt"] = {"verdict": str(verdict.get("label") or verdict.get("state") or ""),
                      "note": str(verdict.get("note") or verdict.get("detail") or "")[:200]}
    elif isinstance(verdict, str) and verdict:
        out["smt"] = {"verdict": verdict, "note": str(s.get("fresh_note") or "")[:200]}
except Exception:
    pass
print(json.dumps(out))
PYEOF

# only publish if we actually got items; otherwise keep the previous cache
if python3 -c "import json,sys; d=json.load(open('${TMP}')); sys.exit(0 if d.get('items') else 1)"; then
  mv "${TMP}" "${OUT}"
else
  rm -f "${TMP}"
  echo "floor-feed: empty pull, kept previous cache" >&2
fi
