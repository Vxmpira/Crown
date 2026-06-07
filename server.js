/**
 * Crown — backend (Node + Express)
 * --------------------------------
 * nginx serves static files and proxies /api/* here (127.0.0.1:3000).
 * Secrets + config live in /etc/crown/crown.env (NOT in git). SQLite DB at /var/lib/crown/crown.db.
 *
 *   Accounts      — register/login/logout/me, hashed passwords, HTTP-only session cookies
 *   Metering      — per-user (and per-IP anonymous) monthly token budgets, enforced server-side
 *   Rate limiting — per-IP request caps on /api/chat and auth
 *   Billing       — Stripe Checkout + webhook writes Pro/Free to the DB, keyed to the user
 *
 * Card data NEVER touches this server. Stripe stays dormant until STRIPE_* keys are set.
 */
const express  = require("express");
const crypto   = require("crypto");
const fs       = require("fs");
const path     = require("path");
const bcrypt   = require("bcryptjs");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");

const KEY    = process.env.ANTHROPIC_API_KEY;
const MODEL  = process.env.MODEL || "claude-sonnet-4-20250514";
const PORT   = process.env.PORT || 3000;
const SYSTEM = "You are Crown, the assistant for BlackCrown VxJ. Confident, refined, concise. Help with writing, code, strategy and ideas.";

// usage budgets (override in crown.env)
const FREE_LIMIT   = parseInt(process.env.FREE_TOKEN_LIMIT || "10000", 10);   // logged-in free / month
const ANON_LIMIT   = parseInt(process.env.ANON_TOKEN_LIMIT || "3000", 10);    // try-before-signup / month
const PRO_FAIR_USE = parseInt(process.env.PRO_FAIR_USE     || "5000000", 10); // fair-use ceiling on "unlimited" Pro
const PERIOD_MS    = 30 * 24 * 60 * 60 * 1000;
const SESSION_DAYS = 30;

// Stripe
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE  = process.env.STRIPE_PRICE_ID;
const STRIPE_WHSEC  = process.env.STRIPE_WEBHOOK_SECRET;
const PUBLIC_URL    = process.env.PUBLIC_URL || "https://blackcrown-intelligence.com";
const stripe = STRIPE_SECRET ? require("stripe")(STRIPE_SECRET) : null;

// Image generation (Pro perk). Dormant until IMAGE_API_KEY is set in crown.env.
// NOTE: Claude/Anthropic does NOT generate images — this calls a separate image provider.
// Default provider is PicsArt (async submit→poll). Set IMAGE_PROVIDER=openai to use OpenAI instead.
const IMAGE_PROVIDER = (process.env.IMAGE_PROVIDER || "picsart").toLowerCase();
const IMAGE_KEY      = process.env.IMAGE_API_KEY;
const IMAGE_MODEL    = process.env.IMAGE_MODEL || "";   // empty = provider's default model
const OPENAI_IMG_URL = process.env.IMAGE_API_URL || "https://api.openai.com/v1/images/generations";
const PICSART_T2I    = "https://genai-api.picsart.io/v1/text2image";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Admin portal: a logged-in user whose email is in ADMIN_EMAILS (comma-separated) gets admin access.
const ADMIN_EMAILS  = String(process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const PRO_PRICE_USD = parseFloat(process.env.PRO_PRICE_USD || "29");
const isAdmin = u => !!u && ADMIN_EMAILS.includes(String(u.email).toLowerCase());

// Email (AWS SES via SMTP). Dormant until SMTP_* are set in crown.env — powers password reset.
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || "no-reply@blackcrown-intelligence.com";
const mailer = (SMTP_HOST && SMTP_USER && SMTP_PASS)
  ? nodemailer.createTransport({ host:SMTP_HOST, port:SMTP_PORT, secure:SMTP_PORT===465, auth:{ user:SMTP_USER, pass:SMTP_PASS } })
  : null;
const sha256 = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const escapeHtml = s => String(s==null?"":s).replace(/[&<>"']/g, m => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[m]));

// ---- database ----
const DB_PATH = process.env.CROWN_DB || "/var/lib/crown/crown.db";
try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (_) {}
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");   // readers don't block the writer
db.pragma("busy_timeout = 5000");  // wait, don't error, if the DB is briefly locked (e.g. backup)
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  period_start INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS anon_usage (
  ip TEXT PRIMARY KEY,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  period_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  user_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`);

const q = {
  userByEmail:    db.prepare("SELECT * FROM users WHERE email = ?"),
  userById:       db.prepare("SELECT * FROM users WHERE id = ?"),
  userByCustomer: db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?"),
  insertUser:     db.prepare("INSERT INTO users (email,username,password_hash,tier,tokens_used,period_start,created_at) VALUES (?,?,?,'free',0,?,?)"),
  setTokens:      db.prepare("UPDATE users SET tokens_used = ?, period_start = ? WHERE id = ?"),
  addTokens:      db.prepare("UPDATE users SET tokens_used = tokens_used + ? WHERE id = ?"),
  setTier:        db.prepare("UPDATE users SET tier = ? WHERE id = ?"),
  setTierCust:    db.prepare("UPDATE users SET tier = ?, stripe_customer_id = ? WHERE id = ?"),
  setCustomer:    db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?"),
  insertSession:  db.prepare("INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)"),
  sessionByToken: db.prepare("SELECT * FROM sessions WHERE token = ?"),
  delSession:     db.prepare("DELETE FROM sessions WHERE token = ?"),
  anonGet:        db.prepare("SELECT * FROM anon_usage WHERE ip = ?"),
  anonUpsert:     db.prepare("INSERT INTO anon_usage (ip,tokens_used,period_start) VALUES (?,?,?) ON CONFLICT(ip) DO UPDATE SET tokens_used=excluded.tokens_used, period_start=excluded.period_start"),
  getWorkspace:   db.prepare("SELECT data FROM workspaces WHERE user_id = ?"),
  upsertWorkspace:db.prepare("INSERT INTO workspaces (user_id,data,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at"),
  adminUsers:     db.prepare("SELECT username, email, tier, created_at FROM users ORDER BY created_at DESC LIMIT 2000"),
  countAll:       db.prepare("SELECT COUNT(*) AS c FROM users"),
  countPro:       db.prepare("SELECT COUNT(*) AS c FROM users WHERE tier='pro'"),
  countSince:     db.prepare("SELECT COUNT(*) AS c FROM users WHERE created_at >= ?"),
  setPassword:    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
  delUserSessions:db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  insertReset:    db.prepare("INSERT INTO password_resets (token_hash,user_id,expires_at,used) VALUES (?,?,?,0)"),
  getReset:       db.prepare("SELECT * FROM password_resets WHERE token_hash = ?"),
  markResetUsed:  db.prepare("UPDATE password_resets SET used = 1 WHERE token_hash = ?"),
};

const now      = () => Date.now();
const inDays   = d => now() + d * 24 * 60 * 60 * 1000;
const genToken = () => crypto.randomBytes(32).toString("hex");
const validEmail = e => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const clientIp = req => String(req.headers["x-real-ip"] || (req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "0.0.0.0").trim();

function parseCookies(req){
  const out = {}; const h = req.headers.cookie; if (!h) return out;
  h.split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) out[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1).trim()); });
  return out;
}
function rollPeriod(u){
  if (now() - u.period_start >= PERIOD_MS) { q.setTokens.run(0, now(), u.id); u.tokens_used = 0; u.period_start = now(); }
  return u;
}
function getSessionUser(req){
  const t = parseCookies(req).crown_session; if (!t) return null;
  const s = q.sessionByToken.get(t); if (!s) return null;
  if (s.expires_at < now()) { q.delSession.run(t); return null; }
  const u = q.userById.get(s.user_id); if (!u) return null;
  return rollPeriod(u);
}
function setSessionCookie(res, token){
  res.cookie("crown_session", token, { httpOnly:true, secure:true, sameSite:"lax", path:"/", maxAge: SESSION_DAYS*24*60*60*1000 });
}
const effectiveTier = u => (isAdmin(u) ? "pro" : u.tier);   // owner/admins get full Pro access
const userLimit = u => (effectiveTier(u) === "pro" ? PRO_FAIR_USE : FREE_LIMIT);
const publicUser = u => ({ username:u.username, email:u.email, tier:effectiveTier(u), tokensUsed:u.tokens_used, limit:userLimit(u) });

// in-memory rate limiter (per key)
const rl = new Map();
function rateLimited(key, max, windowMs){
  const t = now(); let e = rl.get(key);
  if (!e || t > e.reset) { e = { n:0, reset:t+windowMs }; rl.set(key, e); }
  e.n++; return e.n > max;
}
const sweep = setInterval(() => { const t = now(); for (const [k,v] of rl) if (t > v.reset) rl.delete(k); }, 5*60*1000);
if (sweep.unref) sweep.unref();

const app = express();
app.disable("x-powered-by");

/* Stripe webhook — RAW body, registered BEFORE express.json() */
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe || !STRIPE_WHSEC) return res.status(400).send("Stripe not configured");
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WHSEC); }
  catch (err) { console.error("Webhook signature failed:", err.message); return res.status(400).send(`Webhook Error: ${err.message}`); }
  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      let u = s.client_reference_id ? q.userById.get(parseInt(s.client_reference_id, 10)) : null;
      if (!u && s.customer_email) u = q.userByEmail.get(String(s.customer_email).toLowerCase());
      if (u) { q.setTierCust.run("pro", s.customer || u.stripe_customer_id || null, u.id); console.log("PRO  ->", u.email); }
      else console.log("PAID but no matching user:", s.customer_email);
    } else if (event.type === "customer.subscription.deleted") {
      const u = q.userByCustomer.get(event.data.object.customer);
      if (u) { q.setTier.run("free", u.id); console.log("FREE ->", u.email); }
    } else if (event.type === "customer.subscription.updated") {
      const sub = event.data.object; const u = q.userByCustomer.get(sub.customer);
      if (u) q.setTier.run((sub.status === "active" || sub.status === "trialing") ? "pro" : "free", u.id);
    }
  } catch (e) { console.error("Webhook handler error:", e.message); }
  res.json({ received: true });
});

app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (_req, res) =>
  res.json({ ok:true, model:MODEL, keyLoaded:!!KEY, stripe:!!stripe, priceSet:!!STRIPE_PRICE, db:true, accounts:true, images:!!IMAGE_KEY, email:!!mailer }));

// ---- auth ----
app.post("/api/register", (req, res) => {
  if (rateLimited("auth:"+clientIp(req), 12, 60000)) return res.status(429).json({ error:"rate", message:"Too many attempts. Try again shortly." });
  const email = String(req.body.email || "").trim().toLowerCase();
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!validEmail(email))    return res.status(400).json({ error:"bad_email", message:"Enter a valid email address." });
  if (username.length < 3)   return res.status(400).json({ error:"bad_username", message:"Username must be at least 3 characters." });
  if (password.length < 8)   return res.status(400).json({ error:"bad_password", message:"Password must be at least 8 characters." });
  if (q.userByEmail.get(email)) return res.status(409).json({ error:"exists", message:"That email is already registered." });
  const info = q.insertUser.run(email, username, bcrypt.hashSync(password, 10), now(), now());
  const token = genToken(); q.insertSession.run(token, info.lastInsertRowid, inDays(SESSION_DAYS));
  setSessionCookie(res, token);
  res.json({ user: publicUser(q.userById.get(info.lastInsertRowid)) });
});

app.post("/api/login", (req, res) => {
  if (rateLimited("auth:"+clientIp(req), 12, 60000)) return res.status(429).json({ error:"rate", message:"Too many attempts. Try again shortly." });
  const email = String(req.body.email || "").trim().toLowerCase();
  const u = q.userByEmail.get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ""), u.password_hash))
    return res.status(401).json({ error:"bad_creds", message:"Wrong email or password." });
  const token = genToken(); q.insertSession.run(token, u.id, inDays(SESSION_DAYS));
  setSessionCookie(res, token);
  res.json({ user: publicUser(rollPeriod(u)) });
});

app.post("/api/logout", (req, res) => {
  const t = parseCookies(req).crown_session; if (t) q.delSession.run(t);
  res.clearCookie("crown_session", { path:"/" });
  res.json({ ok:true });
});

app.get("/api/me", (req, res) => {
  const u = getSessionUser(req);
  res.json({ user: u ? publicUser(u) : null });
});

// ---- password reset ----
app.post("/api/forgot", async (req, res) => {
  if (rateLimited("auth:"+clientIp(req), 12, 60000)) return res.status(429).json({ error:"rate", message:"Too many attempts. Try again shortly." });
  if (!mailer) return res.status(503).json({ error:"email_unconfigured", message:"Password reset isn't available yet." });
  const email = String(req.body.email || "").trim().toLowerCase();
  const u = validEmail(email) ? q.userByEmail.get(email) : null;
  if (u) {
    const token = genToken();
    q.insertReset.run(sha256(token), u.id, now() + 3600000);  // valid 1 hour
    const link = `${PUBLIC_URL}/reset?token=${token}`;
    try {
      await mailer.sendMail({
        from: `Crown <${MAIL_FROM}>`,
        to: u.email,
        subject: "Reset your Crown password",
        text: `Hi ${u.username},\n\nWe received a request to reset your Crown password. Use the link below within the next hour:\n\n${link}\n\nIf you didn't request this, you can safely ignore this email — your password won't change.\n\n— BlackCrown VxJ`,
        html: `<div style="font-family:Arial,sans-serif;background:#070709;color:#ece7dd;padding:28px;border-radius:14px;max-width:520px;margin:auto">
          <div style="font-size:20px;font-weight:bold;color:#d4af37;letter-spacing:1px">BLACKCROWN VxJ</div>
          <h2 style="color:#f5e0a3;margin:18px 0 6px">Reset your password</h2>
          <p style="color:#bfb9ad;line-height:1.6">Hi ${escapeHtml(u.username)}, we received a request to reset your Crown password. This link is valid for one hour.</p>
          <p style="margin:22px 0"><a href="${link}" style="background:#d4af37;color:#1a1405;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px;display:inline-block">Reset password</a></p>
          <p style="color:#5f5b52;font-size:13px;line-height:1.6">If the button doesn't work, paste this into your browser:<br>${link}</p>
          <p style="color:#5f5b52;font-size:13px">If you didn't request this, ignore this email — your password won't change.</p>
        </div>`
      });
    } catch (e) { console.error("Reset email failed:", e.message); }
  }
  // Always generic — never reveal whether an email is registered.
  res.json({ ok:true, message:"If that email is registered, a reset link is on its way." });
});

app.post("/api/reset", (req, res) => {
  if (rateLimited("auth:"+clientIp(req), 12, 60000)) return res.status(429).json({ error:"rate", message:"Too many attempts. Try again shortly." });
  const token = String(req.body.token || "");
  const password = String(req.body.password || "");
  if (password.length < 8) return res.status(400).json({ error:"bad_password", message:"Password must be at least 8 characters." });
  const row = token ? q.getReset.get(sha256(token)) : null;
  if (!row || row.used || row.expires_at < now()) return res.status(400).json({ error:"bad_token", message:"This reset link is invalid or has expired." });
  q.setPassword.run(bcrypt.hashSync(password, 10), row.user_id);
  q.markResetUsed.run(sha256(token));
  q.delUserSessions.run(row.user_id);   // sign out everywhere after a reset
  res.json({ ok:true });
});

// ---- per-user workspace (chats + projects persistence) ----
app.get("/api/workspace", (req, res) => {
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ error:"auth_required", message:"Please log in first." });
  const row = q.getWorkspace.get(u.id);
  if (!row) return res.json({ chats:[], projects:[] });
  try {
    const d = JSON.parse(row.data);
    res.json({ chats: Array.isArray(d.chats) ? d.chats : [], projects: Array.isArray(d.projects) ? d.projects : [] });
  } catch (_) { res.json({ chats:[], projects:[] }); }
});
app.put("/api/workspace", (req, res) => {
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ error:"auth_required", message:"Please log in first." });
  const chats    = Array.isArray(req.body.chats)    ? req.body.chats    : [];
  const projects = Array.isArray(req.body.projects) ? req.body.projects : [];
  const data = JSON.stringify({ chats, projects });
  if (data.length > 4500000) return res.status(413).json({ error:"too_large", message:"Workspace is too large to save." });
  q.upsertWorkspace.run(u.id, data, now());
  res.json({ ok:true });
});

// ---- admin portal (allowlisted by ADMIN_EMAILS) ----
app.get("/api/admin/overview", (req, res) => {
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ error:"auth_required", message:"Please log in." });
  if (!isAdmin(u)) return res.status(403).json({ error:"forbidden", message:"Admin access only." });
  const DAY = 86400000;
  const total = q.countAll.get().c;
  const pro   = q.countPro.get().c;
  const free  = total - pro;
  const d7    = q.countSince.get(now() - 7  * DAY).c;
  const d30   = q.countSince.get(now() - 30 * DAY).c;
  res.json({
    statuses: { anthropic:!!KEY, stripe:!!stripe, priceSet:!!STRIPE_PRICE, images:!!IMAGE_KEY, db:true },
    stats:    { total, pro, free, signups7d:d7, signups30d:d30, conversionPct: total ? Math.round((pro/total)*1000)/10 : 0 },
    revenue:  { proCount:pro, pricePerMonth:PRO_PRICE_USD, mrr: Math.round(pro*PRO_PRICE_USD*100)/100, annualRunRate: Math.round(pro*PRO_PRICE_USD*12*100)/100, currency:"USD" },
    users:    q.adminUsers.all()
  });
});


app.post("/api/chat", async (req, res) => {
  if (rateLimited("chat:"+clientIp(req), 30, 60000)) return res.status(429).json({ error:"rate", message:"You're going a bit fast — give it a moment." });
  if (!KEY) return res.status(500).json({ error:"no_key", message:"ANTHROPIC_API_KEY not set on the server." });

  const u = getSessionUser(req);
  let tier, limit, used, apply;
  if (u) {
    tier = effectiveTier(u); limit = userLimit(u); used = u.tokens_used;
    apply = n => q.addTokens.run(n, u.id);
  } else {
    const ip = clientIp(req);
    tier = "free"; limit = ANON_LIMIT;
    let a = q.anonGet.get(ip);
    if (a && now() - a.period_start >= PERIOD_MS) a = null;
    used = a ? a.tokens_used : 0;
    const start = a ? a.period_start : now();
    apply = n => q.anonUpsert.run(ip, used + n, start);
  }
  if (used >= limit) {
    return res.status(402).json({ error:"limit", tier, used, limit,
      message: u ? (tier === "pro"
            ? "You've reached the fair-use ceiling for this period. Please contact support."
            : "You've used your free monthly allotment. Upgrade to Pro for unlimited use.")
          : "You've reached the free trial limit. Create an account to keep going." });
  }
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{ "content-type":"application/json", "x-api-key":KEY, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:MODEL, max_tokens:1024, system:SYSTEM, messages })
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error:"model_error", detail:data });
    const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const spent = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
    apply(spent);
    const nowUsed = used + spent;
    res.json({ reply, usage:{ tier, used:nowUsed, limit, remaining:Math.max(0, limit - nowUsed) } });
  } catch (e) {
    res.status(500).json({ error:"server_error", message:e.message });
  }
});

// Pull the first image URL (or base64) out of various provider response shapes.
function pickImage(o){
  if(!o || typeof o!=="object") return null;
  if(Array.isArray(o.data)){ const d=o.data.find(x=>x && (x.url||x.b64_json)); if(d) return d.b64_json ? ("data:image/png;base64,"+d.b64_json) : d.url; }
  if(o.data && (o.data.url||o.data.b64_json)) return o.data.b64_json ? ("data:image/png;base64,"+o.data.b64_json) : o.data.url;
  if(Array.isArray(o.images)){ const im=o.images.find(x=>x && (x.url||typeof x==="string")); if(im) return (typeof im==="string") ? im : im.url; }
  if(o.url) return o.url;
  if(o.b64_json) return "data:image/png;base64,"+o.b64_json;
  return null;
}

// PicsArt Text2Image: POST returns 202 + inference_id, then poll the inference endpoint until FINISHED.
async function generatePicsart(prompt){
  const body = Object.assign({ prompt, count:1, width:1024, height:1024 }, IMAGE_MODEL ? { model:IMAGE_MODEL } : {});
  const post = await fetch(PICSART_T2I, {
    method:"POST",
    headers:{ "content-type":"application/json", "accept":"application/json", "X-Picsart-API-Key":IMAGE_KEY },
    body: JSON.stringify(body)
  });
  const pj = await post.json().catch(()=>({}));
  if(!post.ok) throw new Error(pj.message || pj.detail || ("Picsart error "+post.status));
  let url = pickImage(pj);
  if(url) return url;
  const id = pj.inference_id || pj.id || (pj.data && pj.data.inference_id);
  if(!id) throw new Error("Picsart returned no inference id");
  const base = PICSART_T2I + "/inferences/" + encodeURIComponent(id);
  for(let i=0;i<30;i++){               // up to ~45s, within nginx's 120s proxy timeout
    await sleep(1500);
    const g = await fetch(base, { headers:{ "accept":"application/json", "X-Picsart-API-Key":IMAGE_KEY } });
    const gj = await g.json().catch(()=>({}));
    url = pickImage(gj);
    if(url) return url;
    const st = String(gj.status||"").toUpperCase();
    if(st==="FAILED" || st==="ERROR") throw new Error("Picsart generation failed");
  }
  throw new Error("Timed out waiting for the image");
}

// OpenAI Images (kept as an option via IMAGE_PROVIDER=openai)
async function generateOpenAI(prompt){
  const model = IMAGE_MODEL || "gpt-image-1";
  const body = { model, prompt, n:1, size:"1024x1024" };
  if(model.startsWith("dall-e")) body.response_format = "b64_json";
  const r = await fetch(OPENAI_IMG_URL, { method:"POST", headers:{ "content-type":"application/json", "authorization":"Bearer "+IMAGE_KEY }, body:JSON.stringify(body) });
  const data = await r.json();
  if(!r.ok) throw new Error((data.error && data.error.message) || "Image provider error");
  return pickImage(data);
}

// ---- image generation (Pro only; dormant until IMAGE_API_KEY is set) ----
app.post("/api/image", async (req, res) => {
  if (rateLimited("img:"+clientIp(req), 20, 60000)) return res.status(429).json({ error:"rate", message:"You're generating images quickly — give it a moment." });
  if (!IMAGE_KEY) return res.status(503).json({ error:"image_unconfigured", message:"Image generation is not set up on the server yet." });
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ error:"auth_required", message:"Please log in first." });
  if (effectiveTier(u) !== "pro") return res.status(403).json({ error:"pro_only", message:"Image generation is a Pro feature." });
  const prompt = String(req.body.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error:"no_prompt", message:"Describe the image you want." });
  try {
    const image = IMAGE_PROVIDER === "openai" ? await generateOpenAI(prompt) : await generatePicsart(prompt);
    if (!image) return res.status(502).json({ error:"image_empty", message:"No image returned by the provider." });
    res.json({ image });
  } catch (e) {
    console.error("Image error:", e.message);
    res.status(502).json({ error:"image_error", message:e.message });
  }
});


async function resolvePriceId(){
  if (!STRIPE_PRICE) return null;
  if (STRIPE_PRICE.startsWith("price_")) return STRIPE_PRICE;
  if (STRIPE_PRICE.startsWith("prod_")) { const l = await stripe.prices.list({ product:STRIPE_PRICE, active:true, limit:1 }); return l.data[0] ? l.data[0].id : null; }
  return STRIPE_PRICE;
}
app.post("/api/checkout", async (req, res) => {
  if (!stripe || !STRIPE_PRICE) return res.status(503).json({ error:"stripe_unconfigured", message:"Stripe is not set up on the server yet." });
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ error:"auth_required", message:"Please log in first." });
  try {
    const price = await resolvePriceId();
    if (!price) return res.status(503).json({ error:"no_price", message:"No active price found for the configured Stripe product." });
    const session = await stripe.checkout.sessions.create({
      mode:"subscription",
      line_items:[{ price, quantity:1 }],
      customer: u.stripe_customer_id || undefined,
      customer_email: u.stripe_customer_id ? undefined : u.email,
      client_reference_id: String(u.id),
      allow_promotion_codes:true,
      success_url:`${PUBLIC_URL}/chat?checkout=success`,
      cancel_url:`${PUBLIC_URL}/chat?checkout=cancel`
    });
    res.json({ url: session.url });
  } catch (e) { console.error("Checkout error:", e.message); res.status(500).json({ error:"checkout_failed", message:e.message }); }
});
app.post("/api/portal", async (req, res) => {
  if (!stripe) return res.status(503).json({ error:"stripe_unconfigured", message:"Stripe is not set up yet." });
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ error:"auth_required", message:"Please log in first." });
  try {
    let customerId = u.stripe_customer_id;
    if (!customerId) { const c = await stripe.customers.list({ email:u.email, limit:1 }); customerId = c.data[0] && c.data[0].id; if (customerId) q.setCustomer.run(customerId, u.id); }
    if (!customerId) return res.status(404).json({ error:"no_customer", message:"No subscription found yet." });
    const session = await stripe.billingPortal.sessions.create({ customer:customerId, return_url:`${PUBLIC_URL}/chat` });
    res.json({ url: session.url });
  } catch (e) { console.error("Portal error:", e.message); res.status(500).json({ error:"portal_failed", message:e.message }); }
});

app.listen(PORT, "127.0.0.1", () => console.log(`Crown backend on 127.0.0.1:${PORT} | model ${MODEL} | stripe ${!!stripe} | db ${DB_PATH}`));
