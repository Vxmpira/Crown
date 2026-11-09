# Co-Work · The Round Table

A **Lead** model on the Unfiltered workspace plans a task, hands three sub-agents (**Builder**, **Reviewer**, **Tester**) their specs, runs a handoff/retry loop, and returns a finished product that the Lead delivers in its own voice. Billed in top-up credit, exactly like Deep-Logic.

## Where it lives

- Toggle in the composer, shown **only** in the Unfiltered room (Room I). Flip it on and the next message convenes the table instead of a normal room reply.
- Sub-agents run **unfiltered** on the room engine (`COWORK_WS`, default `unfiltered`), so the chain inherits the Unfiltered workspace's model.
- One **malware gate** runs on the finished product, on Anthropic (`MODEL`), not on the chain — reliable, and not billed to the user. It blocks only ransomware/wipers, credential stealers, botnet/RAT/C2, self-propagating worms, keyloggers/spyware, and intrusion exploits. Everything else — normal work, games, security research — passes untouched. It runs for **every account, admin included**, by design: its only job is to keep the public product inside AWS's AUP and Stripe's rules, which is what protects the LLC.

## Files

| File | Role |
|---|---|
| `cowork.js` | Orchestrator (Lead + 3 sub-agents + handoff loop + gate). Backend-agnostic. |
| `sandbox.js` | Docker test runner. Throwaway container, no network, cpu/mem/pid/time caps. Static-review fallback if Docker is absent. |
| `server.js` | Wired: `coworkEngineCall` (chain → engine), `coworkClassify` (gate → Anthropic), `POST /api/cowork` (SSE, top-up gated). |
| `chat.html` | Wired: composer toggle, SSE status trail, downloadable file cards. |

## crown.env (add to `/etc/crown/crown.env`)

```
# Co-Work. All optional — these are the defaults.
COWORK_WS=unfiltered          # engine workspace the sub-agents run on
COWORK_MULT=1                 # top-up billing multiplier per raw token

# Sandbox (optional)
COWORK_SANDBOX=on             # off = skip Docker, static review only
COWORK_PY_IMAGE=python:3.12-slim
COWORK_NODE_IMAGE=node:20-slim
COWORK_SANDBOX_MEM=512m
COWORK_SANDBOX_CPUS=1.0
COWORK_SANDBOX_TIMEOUT=45
```

No new Stripe product: Co-Work spends the existing top-up balance. The Deep-Logic top-up packs already fund it.

## Docker (for live test execution) — Amazon Linux 2023

The Crown host is Amazon Linux 2023, so Docker installs via `dnf`, not `apt`:

```
sudo dnf install -y docker
sudo systemctl enable --now docker

# The crown service runs the containers, so ITS user needs the docker group.
SVC_USER=$(systemctl show -p User --value crown); [ -z "$SVC_USER" ] && SVC_USER=root
echo "crown runs as: $SVC_USER"
sudo usermod -aG docker ec2-user                         # for your interactive testing
[ "$SVC_USER" != "root" ] && [ "$SVC_USER" != "ec2-user" ] && sudo usermod -aG docker "$SVC_USER"

docker pull python:3.12-slim && docker pull node:20-slim
sudo systemctl restart crown                             # pick up the new group
```

If `crown runs as: root`, the service can already reach the Docker socket and no usermod is needed for it. After installing, confirm the daemon with `docker ps` (no sudo) in a fresh shell (`newgrp docker` or re-login).

Without Docker, Co-Work still works — the Tester does a static review and nothing ever runs on the EC2 host. Generated code is **never** executed outside a container.

## Roblox / Luau note

Luau can't run in a generic container, so for Roblox builds the Tester does a static review instead of a live run (the Lead flags `runnable:false`). You still get the full file structure and a review, just not an executed test.

## Billing

Charged to top-up credit at every model call (`COWORK_MULT` tunes the rate), 402 on zero balance, logged to the usage ledger under kind `cowork`. One build is roughly 4–6 engine calls. The gate call is on the house.

## Fully ungated research build

For ungated work on your segregated network, run a second copy of this stack there and remove the `gateCheck` call in `cowork.js` (or wrap it behind an env flag set only on that box). Keep that build **off** the public EC2 product.

## Smoke test

Grant yourself credit, start the service, open the Unfiltered room, toggle Co-Work on, and ask for *"a Python script that reverses each word in a sentence, with tests."* You should see the status trail (planning → builder → reviewer → tester → gate → delivering), then the files with Download buttons and a green "tests passed" line.

```
sqlite3 /var/lib/crown/crown.db "UPDATE users SET topup_tokens = topup_tokens + 500000 WHERE email='YOUR@EMAIL';"
```
