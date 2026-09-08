# Crown Room Engine: EC2 Deployment (Step 2 of the blueprint)

What this is: AnythingLLM running as a private Docker service on the same EC2
box as the existing Crown backend. It is the room engine. Your existing
server.js stays the front door for everything (auth, metering, Stripe, chat
history). Nothing here is reachable from the internet.

Traffic shape after this step:

    Browser -> nginx (443) -> server.js (127.0.0.1:3000)
                                 |-> Anthropic API          (Free tier, unchanged)
                                 |-> 127.0.0.1:3001         (the Four Rooms, new)

------------------------------------------------------------
## 0. One-time prep on the EC2 box

Install Docker if it is not already there (Ubuntu):

    sudo apt-get update
    sudo apt-get install -y docker.io docker-compose-v2
    sudo usermod -aG docker $USER
    # log out and back in so the group applies

Repo placement: commit this `deploy/anythingllm/` folder (compose file,
env.example, setup-rooms.sh, this file) to the BlackCrown-Intelligence repo on
main. The runtime lives OUTSIDE the web root so a site deploy can never touch
it:

    sudo mkdir -p /opt/crown-rooms
    sudo chown $USER:$USER /opt/crown-rooms

------------------------------------------------------------
## 1. First deployment

    # local machine: commit + push the deploy folder to main, then on EC2:
    cd ~/BlackCrown-Intelligence && git pull
    cp deploy/anythingllm/docker-compose.yml /opt/crown-rooms/
    cp deploy/anythingllm/env.example        /opt/crown-rooms/
    cp deploy/anythingllm/setup-rooms.sh     /opt/crown-rooms/

    cd /opt/crown-rooms
    cp env.example .env
    nano .env        # fill in the three secrets + the NEW OpenRouter key

Secrets: run `openssl rand -hex 32` three times for JWT_SECRET, SIG_KEY,
SIG_SALT.

OpenRouter key: create a FRESH key at openrouter.ai and fund it with PREPAID
credits. The key from the desktop app is exposed on the laptop in plaintext.
Treat it as burned and delete it from the OpenRouter dashboard.

Start it:

    docker compose up -d
    curl -s http://127.0.0.1:3001/api/ping     # expect {"online":true}

------------------------------------------------------------
## 2. Create the admin account + API key (SSH tunnel, one time)

The UI is not public. From your laptop:

    ssh -L 3001:127.0.0.1:3001 <user>@<elastic-ip>

Then open http://localhost:3001 in your browser:

1. Complete the first-run setup (single user mode, set an instance password).
2. Confirm LLM provider shows OpenRouter (it reads .env).
3. Settings -> Tools -> Developer API -> Generate New API Key. Copy it.

Store that key on the box for the backend to use later (step 3 of the
blueprint):

    sudo nano /etc/crown/crown.env
    # add:  ROOMS_API_KEY=<the key>
    #       ROOMS_BASE_URL=http://127.0.0.1:3001/api/v1

------------------------------------------------------------
## 3. Build the Four Rooms

    cd /opt/crown-rooms
    bash setup-rooms.sh <ANYTHINGLLM_API_KEY>

This creates and configures:

| Room slug        | Brand name       | Model (config, swappable)                                | Temp |
|------------------|------------------|----------------------------------------------------------|------|
| unfiltered       | Unfiltered       | cognitivecomputations/dolphin-mistral-24b-venice-edition | 0.7  |
| deep-logic       | Deep-Logic       | deepseek/deepseek-r1-0528                                | 0.3  |
| visual-analysis  | Visual Analysis  | qwen/qwen2.5-vl-72b-instruct                             | 0.4  |
| creativity       | Creativity       | meta-llama/llama-3.3-70b-instruct                        | 1.0  |

The user only ever sees the room name. Swapping a model later is one line in
setup-rooms.sh (or the workspace UI), zero frontend changes.

Smoke test each room:

    curl -s -X POST http://127.0.0.1:3001/api/v1/workspace/unfiltered/chat \
      -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" \
      -d '{"message":"Say hello in one sentence.","mode":"chat","sessionId":"smoke-1"}'

Repeat for deep-logic, visual-analysis, creativity. Deep-logic will be slow,
that is normal, reasoning models think before they speak.

------------------------------------------------------------
## 4. Privacy posture of this box (current state, be honest in copy)

- Bound to localhost only: nothing public.
- Native embedder + LanceDB: no data leaves for embeddings.
- Telemetry disabled.
- Inference goes to OpenRouter PAID endpoints under your key. Verify the
  no-logging/no-training policy per model provider in the OpenRouter
  dashboard before marketing claims go live.
- AnythingLLM keeps chat history in its own SQLite on this box. Until the
  zero-knowledge layer (blueprint step 3) is live, that history exists in
  plaintext server-side. The step 3 middleware makes server.js the only
  history keeper (encrypted) and treats the room engine as stateless, with a
  purge job wiping room-engine threads.

------------------------------------------------------------
## 5. Updating later

    cd /opt/crown-rooms
    docker compose pull && docker compose up -d    # upgrade AnythingLLM
    docker compose logs -f --tail 100              # watch logs
    docker compose down                            # stop (storage persists)

Storage lives in /opt/crown-rooms/storage. Back it up before upgrades:

    tar czf ~/crown-rooms-backup-$(date +%F).tgz -C /opt/crown-rooms storage
