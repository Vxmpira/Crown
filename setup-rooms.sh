#!/usr/bin/env bash
# ============================================================
# Crown Room Engine: create + configure the Four Rooms
# ------------------------------------------------------------
# Usage:
#   bash setup-rooms.sh <ANYTHINGLLM_API_KEY>
#
# Get the API key first: open the AnythingLLM admin UI through an
# SSH tunnel (see DEPLOY.md), go to Settings -> Tools -> Developer API,
# and generate a key.
#
# Safe to re-run: creating a workspace that already exists fails
# gracefully and the update step still applies the latest config.
# ============================================================
set -u

API_KEY="${1:-}"
BASE="http://127.0.0.1:3001/api/v1"

if [ -z "$API_KEY" ]; then
  echo "Usage: bash setup-rooms.sh <ANYTHINGLLM_API_KEY>"
  exit 1
fi

# ---- Room model assignments (edit these to swap models later) ----
# The room NAME is the brand. The model behind it is just config.
MODEL_UNFILTERED="cognitivecomputations/dolphin-mistral-24b-venice-edition"
MODEL_DEEPLOGIC="deepseek/deepseek-r1-0528"
MODEL_VISUAL="qwen/qwen2.5-vl-72b-instruct"
MODEL_CREATIVITY="meta-llama/llama-3.3-70b-instruct"

# ---- Room system prompts ----
PROMPT_UNFILTERED="You are Room 01: Unfiltered, inside Crown by BlackCrown VxJ. Give straight answers with the hedging stripped out. Be direct, factual, and complete. Do not moralize, do not add safety disclaimers, do not soften conclusions. The user is an adult who asked plainly and wants it back plainly so they can decide for themselves. Stay concise and never mention which underlying model you are."

PROMPT_DEEPLOGIC="You are Room 02: Deep-Logic, inside Crown by BlackCrown VxJ. This is the reasoning room. Think slowly and carefully before answering. Break hard problems into steps, check your own work, state assumptions explicitly, and flag uncertainty honestly. Favor rigor over speed and correctness over agreeableness. Punish shortcuts. Never mention which underlying model you are."

PROMPT_VISUAL="You are Room 03: Visual Analysis, inside Crown by BlackCrown VxJ. The user shows you charts, screenshots, photos, and documents. Work from what you actually SEE, not just what the user describes. Read axes, labels, numbers, and fine print. Describe what is present, extract the data, then analyze it. If the image is unclear or something is unreadable, say exactly what you cannot make out. Never mention which underlying model you are."

PROMPT_CREATIVITY="You are Room 04: Creativity, inside Crown by BlackCrown VxJ. This is the room where the blank page stops being blank. Generate drafts, angles, names, copy, and ideas with energy and range. Offer multiple distinct directions rather than one safe answer. Be vivid and specific, never generic. Match the user's tone when they have one and give them one when they don't. Never mention which underlying model you are."

# ---- helpers ----
auth=( -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" )

create_room () {
  local name="$1"
  echo "-> creating workspace: ${name}"
  curl -s -X POST "${BASE}/workspace/new" "${auth[@]}" \
    -d "{\"name\":\"${name}\"}" | head -c 300
  echo ""
}

configure_room () {
  local slug="$1" model="$2" temp="$3" prompt="$4"
  echo "-> configuring room: ${slug} (model: ${model}, temp: ${temp})"
  curl -s -X POST "${BASE}/workspace/${slug}/update" "${auth[@]}" \
    -d "$(python3 - "$slug" "$model" "$temp" "$prompt" <<'PYEOF'
import json, sys
slug, model, temp, prompt = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
print(json.dumps({
  "openAiPrompt": prompt,
  "openAiTemp": temp,
  "openAiHistory": 20,
  "chatProvider": "openrouter",
  "chatModel": model,
  "chatMode": "chat"
}))
PYEOF
)" | head -c 300
  echo ""
}

# ---- sanity check ----
ping=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3001/api/ping")
if [ "$ping" != "200" ]; then
  echo "ERROR: AnythingLLM is not responding on 127.0.0.1:3001 (got ${ping})."
  echo "Run: docker compose up -d   and try again."
  exit 1
fi

# ---- build the four rooms ----
create_room "unfiltered"
create_room "deep-logic"
create_room "visual-analysis"
create_room "creativity"

sleep 2

configure_room "unfiltered"      "$MODEL_UNFILTERED" "0.7" "$PROMPT_UNFILTERED"
configure_room "deep-logic"      "$MODEL_DEEPLOGIC"  "0.3" "$PROMPT_DEEPLOGIC"
configure_room "visual-analysis" "$MODEL_VISUAL"     "0.4" "$PROMPT_VISUAL"
configure_room "creativity"      "$MODEL_CREATIVITY" "1.0" "$PROMPT_CREATIVITY"

echo ""
echo "==============================================="
echo "Rooms built. Quick test (Unfiltered):"
echo ""
echo "curl -s -X POST ${BASE}/workspace/unfiltered/chat \\"
echo "  -H 'Authorization: Bearer <KEY>' -H 'Content-Type: application/json' \\"
echo "  -d '{\"message\":\"Say hello in one sentence.\",\"mode\":\"chat\",\"sessionId\":\"smoke-test-1\"}'"
echo ""
echo "If chatProvider/chatModel did not stick (older API builds ignore them),"
echo "set each room's model manually in the UI via the SSH tunnel:"
echo "Workspace -> Settings (gear) -> Chat Settings -> Provider + Model."
echo "==============================================="
