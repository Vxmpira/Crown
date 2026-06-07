/**
 * Crown — backend (Node + Express, runs on your EC2 box)
 * ------------------------------------------------------
 * nginx serves the static files and proxies /api/* to this process (127.0.0.1:3000).
 * Secrets live in /etc/crown/crown.env (NOT in git) and never reach the browser.
 *
 *   Phase 2  — secure AI proxy (/api/chat)
 *   Phase 5  — Stripe Checkout for the $29/mo Pro plan (/api/checkout + /api/stripe/webhook)
 *
 * Card data NEVER touches this server — Stripe Checkout (hosted by Stripe) handles all of it.
 * Stripe stays dormant until you set the STRIPE_* keys in /etc/crown/crown.env.
 */
const express = require("express");

const KEY    = process.env.ANTHROPIC_API_KEY;
const MODEL  = process.env.MODEL || "claude-sonnet-4-20250514";
const PORT   = process.env.PORT || 3000;
const SYSTEM = "You are Crown, the assistant for BlackCrown VxJ. Confident, refined, concise. Help with writing, code, strategy and ideas.";

// --- Stripe (activates automatically once these are set in /etc/crown/crown.env) ---
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE  = process.env.STRIPE_PRICE_ID;       // the recurring $29/mo price, e.g. price_123
const STRIPE_WHSEC  = process.env.STRIPE_WEBHOOK_SECRET; // webhook signing secret, e.g. whsec_123
const PUBLIC_URL    = process.env.PUBLIC_URL || "https://blackcrown-intelligence.com";
const stripe = STRIPE_SECRET ? require("stripe")(STRIPE_SECRET) : null;

const app = express();

/* The Stripe webhook needs the RAW request body to verify the signature,
   so it must be registered BEFORE express.json(). */
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe || !STRIPE_WHSEC) return res.status(400).send("Stripe not configured");
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WHSEC);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  switch (event.type) {
    case "checkout.session.completed":
      // TODO (accounts/DB phase): mark this customer as Pro in your datastore.
      console.log("PAID  ->", event.data.object.customer_email || event.data.object.customer);
      break;
    case "customer.subscription.deleted":
      // TODO (accounts/DB phase): downgrade this customer to Free.
      console.log("CANCEL->", event.data.object.customer);
      break;
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, model: MODEL, keyLoaded: !!KEY, stripe: !!stripe, priceSet: !!STRIPE_PRICE }));

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

/* Accept either a price_… or a prod_… in STRIPE_PRICE_ID. If it's a product,
   resolve it to that product's active price at checkout time. */
async function resolvePriceId(){
  if (!STRIPE_PRICE) return null;
  if (STRIPE_PRICE.startsWith("price_")) return STRIPE_PRICE;
  if (STRIPE_PRICE.startsWith("prod_")) {
    const list = await stripe.prices.list({ product: STRIPE_PRICE, active: true, limit: 1 });
    return list.data[0] ? list.data[0].id : null;
  }
  return STRIPE_PRICE;
}

/* Create a Stripe Checkout Session for the $29/mo Pro plan; returns the hosted checkout URL. */
app.post("/api/checkout", async (req, res) => {
  if (!stripe || !STRIPE_PRICE)
    return res.status(503).json({ error: "stripe_unconfigured", message: "Stripe is not set up on the server yet." });
  try {
    const price = await resolvePriceId();
    if (!price) return res.status(503).json({ error: "no_price", message: "No active price found for the configured Stripe product." });
    const email = (req.body && typeof req.body.email === "string") ? req.body.email : undefined;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      customer_email: email,
      allow_promotion_codes: true,
      success_url: `${PUBLIC_URL}/chat.html?checkout=success`,
      cancel_url:  `${PUBLIC_URL}/chat.html?checkout=cancel`
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("Checkout error:", e.message);
    res.status(500).json({ error: "checkout_failed", message: e.message });
  }
});

app.listen(PORT, "127.0.0.1", () => console.log(`Crown backend on 127.0.0.1:${PORT} | model ${MODEL} | stripe ${!!stripe}`));
