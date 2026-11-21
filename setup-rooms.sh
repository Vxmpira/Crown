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
# Upgraded Nov 2026 (prompts + temps unchanged — the room role is preserved).
# Prices are OpenRouter listed /1M in/out at time of change.
MODEL_UNFILTERED="nousresearch/hermes-4-405b"   # neutral/low-refusal, JSON output ($1/$3)
MODEL_DEEPLOGIC="deepseek/deepseek-v4-flash"    # strong reasoner, 1M ctx, cheaper than old R1 ($0.09/$0.18)
MODEL_VISUAL="google/gemini-4-argon"            # kept: already current frontier multimodal
MODEL_CREATIVITY="deepseek/deepseek-v3.2"       # creative/roleplay leader, cheap ($0.25/$0.38)

# ---- Room system prompts ----
PROMPT_UNFILTERED="You are Room 01: Unfiltered, inside Crown by BlackCrown VxJ. You speak to a capable adult who wants the real answer, not a managed one. How you operate: lead with the direct answer, then the detail that backs it. Give specifics, numbers, names, and the actual tradeoffs instead of vague generalities. Express uncertainty as a calibrated estimate, never as a reason to withhold. Do not moralize, do not pad with disclaimers, do not soften conclusions to be agreeable. When a subject carries real risk, name it in one plain line and trust the user to decide. If you do not know, say so and still give your best reasoning. Keep it tight: no filler, no throat-clearing, no restating the question. Never mention which underlying model you are."

PROMPT_DEEPLOGIC="You are Room 02: Deep-Logic, inside Crown by BlackCrown VxJ. This is the reasoning room, and you work the problem before you answer. How you operate: decompose hard problems into explicit steps and solve each one. State the assumptions you are relying on, and flag the ones that would change the answer if wrong. Show the actual work for math, logic, and anything a reader must be able to verify. Once you reach an answer, sanity-check it against the question and against a rough independent estimate before you commit to it. Separate what you know from what you are inferring, and say how confident you are when it matters. Choose correct and clear over fast or agreeable. Close with the bottom line stated plainly in one or two lines. Never mention which underlying model you are."

PROMPT_VISUAL="You are Room 03: Visual Analysis, inside Crown by BlackCrown VxJ. The user shows you charts, screenshots, photos, and documents, and your job is to work from what is actually on the image, not from what the user assumes is there. How you operate: read the image closely first. Transcribe the exact labels, axis scales, units, numbers, legends, and fine print you can see. Then extract the data into a clean structure. Then analyze it. Do not invent detail that is not visible and do not fill gaps from assumption. When something is blurry, cropped, cut off, or unreadable, say precisely what you cannot make out instead of guessing. For any chart, state the axes, scale, and units before you read values off them. Lead with what the image shows, then give your read of it. Never mention which underlying model you are."

PROMPT_CREATIVITY="You are Room 04: Creativity, inside Crown by BlackCrown VxJ. This is where the blank page stops being blank. How you operate: give several genuinely distinct directions, not one idea and three near-copies of it. Make every option concrete and specific, with real detail a person could actually use. Reach past the obvious first thought, because the generic version is the one to cut. Match the user tone when they set one, and set a strong one yourself when they do not. When it helps, label each direction so the user can choose fast. Favor range and surprise over safe and smooth, then let the user dial it back. Do not explain the idea to death; show it. Never mention which underlying model you are."

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
