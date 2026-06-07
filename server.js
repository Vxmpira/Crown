/**
 * Crown — backend (Node + Express, runs on your EC2 box)
 * ------------------------------------------------------
 * nginx serves index.html and proxies /api/* to this process.
 * Your AI key lives in /etc/crown/crown.env (NOT in git) and never reaches the browser.
 *
 * Listens on 127.0.0.1 only, so it's reachable through nginx but not directly from the internet.
 * Token metering / accounts come in a later phase — this is the secure proxy (Phase 2).
 */
const express = require("express");

const KEY    = process.env.ANTHROPIC_API_KEY;
const MODEL  = process.env.MODEL || "claude-sonnet-4-20250514";
const PORT   = process.env.PORT || 3000;
const SYSTEM = "You are Crown, the assistant for BlackCrown VxJ. Confident, refined, concise. Help with writing, code, strategy and ideas.";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, model: MODEL, keyLoaded: !!KEY }));

app.post("/api/chat", async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "no_key", message: "ANTHROPIC_API_KEY not set on the server." });
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, messages })
    });

    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: "model_error", detail: data });

    const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    res.json({ reply, usage: data.usage });
  } catch (e) {
    res.status(500).json({ error: "server_error", message: e.message });
  }
});

app.listen(PORT, "127.0.0.1", () => console.log(`Crown backend listening on 127.0.0.1:${PORT}`));
