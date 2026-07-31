/**
 * Server AI (Eclipse-X Discord assistant)
 * ---------------------------------------
 * Runs beside the Crown backend on the same box, as its own systemd service
 * (crown-serverai). Watches one Discord channel, answers each member as a
 * direct reply to their message, and follows reply chains so follow-ups keep
 * their context. Per-member quota: SERVERAI_WEEKLY_LIMIT calls per week,
 * resetting Monday 00:00 New York time. Usage lives in its own SQLite file so
 * it never touches crown.db.
 *
 * Secrets + config come from /etc/crown/crown.env via systemd:
 *   SERVERAI_DISCORD_TOKEN  required, the bot token for this listener
 *   ANTHROPIC_API_KEY       already present, shared with the Crown backend
 *   SERVERAI_MODEL          optional, falls back to MODEL, then the default
 *   SERVERAI_CHANNEL_ID     optional, defaults to #server-ai
 *   SERVERAI_WEEKLY_LIMIT   optional, defaults to 10
 *   SERVERAI_DB             optional, defaults to /var/lib/crown/serverai.db
 *   SERVERAI_MAX_TOKENS     optional, defaults to 700
 *   SERVERAI_CONTEXT_DEPTH  optional, defaults to 10 messages per thread
 */
const fs   = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { Client, GatewayIntentBits } = require("discord.js");

const DISCORD_TOKEN = process.env.SERVERAI_DISCORD_TOKEN;
const KEY           = process.env.ANTHROPIC_API_KEY;
const MODEL         = process.env.SERVERAI_MODEL || process.env.MODEL || "claude-sonnet-4-6";
const CHANNEL_ID    = process.env.SERVERAI_CHANNEL_ID || "1519381180175220766";
const WEEKLY_LIMIT  = parseInt(process.env.SERVERAI_WEEKLY_LIMIT || "10", 10);
const MAX_TOKENS    = parseInt(process.env.SERVERAI_MAX_TOKENS || "700", 10);
const CONTEXT_DEPTH = parseInt(process.env.SERVERAI_CONTEXT_DEPTH || "10", 10);
const REPLY_CAP     = 1800;   // hard character ceiling before the footer, Discord caps content at 2000

const SYSTEM = "You are Server AI, the member assistant inside the Eclipse-X Discord server, " +
  "built and run by BlackCrown Intelligence, the AI division of BlackCrownVxJ LLC. " +
  "Eclipse-X has three wings: stock and forex trading, e-commerce, and artificial intelligence. " +
  "The company also ships Korvus at korvus.industries, a market intelligence terminal for index " +
  "futures traders, and Crown at blackcrown-intelligence.com, a private AI workspace. " +
  "Be confident, refined, and concise. Write plain conversational text that reads well in Discord: " +
  "short paragraphs, no markdown headers, no bullet walls, under 1500 characters. " +
  "You give information and education, never financial advice; when markets come up, the decision " +
  "always belongs to the trader. Never use em dashes.";

if (!DISCORD_TOKEN) { console.error("[serverai] SERVERAI_DISCORD_TOKEN is not set in /etc/crown/crown.env"); process.exit(1); }
if (!KEY)           { console.error("[serverai] ANTHROPIC_API_KEY is not set in /etc/crown/crown.env");      process.exit(1); }

// ---- quota database (its own file, same conventions as crown.db) ----
const DB_PATH = process.env.SERVERAI_DB || "/var/lib/crown/serverai.db";
try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch (_) {}
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec(`
CREATE TABLE IF NOT EXISTS serverai_usage (
  user_id  TEXT PRIMARY KEY,
  week_key TEXT NOT NULL,
  calls    INTEGER NOT NULL DEFAULT 0
);
`);
const q = {
  get:    db.prepare("SELECT * FROM serverai_usage WHERE user_id = ?"),
  upsert: db.prepare("INSERT INTO serverai_usage (user_id, week_key, calls) VALUES (?, ?, ?) " +
                     "ON CONFLICT(user_id) DO UPDATE SET week_key = excluded.week_key, calls = excluded.calls")
};

// ---- week key: ISO week (Monday start) computed on the New York calendar day ----
// Reset needs no cron: a stored key from last week simply stops matching on Monday.
function weekKey() {
  const ny = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()); // YYYY-MM-DD
  const [y, m, d] = ny.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);       // Thursday of this week
  const isoYear = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((t - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return isoYear + "-W" + String(week).padStart(2, "0");
}
function usageFor(userId) {
  const wk = weekKey();
  const row = q.get.get(String(userId));
  const calls = (row && row.week_key === wk) ? row.calls : 0;
  return { wk, calls, left: Math.max(0, WEEKLY_LIMIT - calls) };
}

// ---- context: walk the reply chain so follow-ups keep their thread ----
async function buildThread(message, botId) {
  const turns = [];
  let cur = message;
  for (let i = 0; i < CONTEXT_DEPTH && cur; i++) {
    const role = cur.author.id === botId ? "assistant" : "user";
    const text = String(cur.content || "")
      .split("\n").filter(l => !l.startsWith("-#")).join("\n")   // drop the calls-left footer from old bot replies
      .trim();
    if (text) turns.unshift({ role, content: text });
    const refId = cur.reference && cur.reference.messageId;
    if (!refId) break;
    try { cur = await message.channel.messages.fetch(refId); } catch { break; }
  }
  // the API wants the conversation to start on a user turn, with roles merged when they repeat
  while (turns.length && turns[0].role !== "user") turns.shift();
  const merged = [];
  for (const t of turns) {
    if (merged.length && merged[merged.length - 1].role === t.role) merged[merged.length - 1].content += "\n" + t.content;
    else merged.push(t);
  }
  return merged.length ? merged : [{ role: "user", content: String(message.content || "").trim() }];
}

// ---- the model call, same shape as the Crown backend uses ----
async function askModel(messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages })
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error("Anthropic " + r.status + ": " + detail.slice(0, 300));
  }
  const data = await r.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

// ---- Discord ----
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once("clientReady", () => console.log("[serverai] online as " + client.user.tag + ", watching channel " + CHANNEL_ID + ", model " + MODEL));

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channelId !== CHANNEL_ID) return;

    const content = String(message.content || "").trim();
    if (!content) {
      await message.reply("Text only for now. Ask your question as a plain message.");
      return;   // no quota charge
    }

    const { wk, calls, left } = usageFor(message.author.id);
    if (left <= 0) {
      await message.reply("You are out of Server AI calls for this week. Your " + WEEKLY_LIMIT + " reset Monday.");
      return;   // no quota charge
    }

    await message.channel.sendTyping();
    const thread = await buildThread(message, client.user.id);

    let answer;
    try {
      answer = await askModel(thread);
    } catch (err) {
      console.error("[serverai] model error: " + err.message);
      await message.reply("The engine hit a snag. Give it a minute and try again.");
      return;   // failed calls are free
    }
    if (!answer) answer = "I came back empty on that one. Try rewording the question.";
    if (answer.length > REPLY_CAP) answer = answer.slice(0, REPLY_CAP - 1).trimEnd() + "\u2026";

    const remaining = left - 1;
    await message.reply({
      content: answer + "\n-# Calls left this week: " + remaining + "/" + WEEKLY_LIMIT,
      allowedMentions: { repliedUser: true }
    });
    q.upsert.run(String(message.author.id), wk, calls + 1);   // charge only after a successful send
  } catch (err) {
    console.error("[serverai] handler error: " + (err && err.message ? err.message : err));
  }
});

process.on("unhandledRejection", err => console.error("[serverai] unhandled: " + (err && err.message ? err.message : err)));

client.login(DISCORD_TOKEN);
