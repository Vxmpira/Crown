#!/usr/bin/env python3
# ==============================================================================
#  verify-crown.py  ·  end-to-end check of every chat model, every scenario
#
#  Logs in as a real user and exercises the LIVE product the way a customer
#  does: the Crown console (Anthropic, streaming) and all five rooms through
#  /api/room-chat. Scenarios: basic, complex reasoning, long-chat memory,
#  image upload (console + Visual room), PDF upload, and live web search.
#  The Floor gets regression checks for the persona fix (no tag leaks, no
#  "provided context" refusals).
#
#  Usage, from anywhere with network to the site (the EC2 box works):
#      CROWN_TEST_EMAIL="you@example.com" CROWN_TEST_PASSWORD="..." \
#        python3 verify-crown.py
#  Optional: CROWN_BASE="https://blackcrown-intelligence.com" (default)
#
#  Uses a Crowned account with the floor flag to cover everything. Pure
#  stdlib, no pip installs. Exit code 0 only if every test passes.
# ==============================================================================
import os, sys, json, time, zlib, struct, re, urllib.request, urllib.error, http.cookiejar

BASE = os.environ.get("CROWN_BASE", "https://blackcrown-intelligence.com").rstrip("/")
EMAIL = os.environ.get("CROWN_TEST_EMAIL", "")
PASSWORD = os.environ.get("CROWN_TEST_PASSWORD", "")
TIMEOUT = int(os.environ.get("CROWN_TIMEOUT", "240"))

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

RESULTS = []
def clip(x, n=130): return (x or "").replace("\n", " ").strip()[:n]
def record(section, name, ok, note="", ms=0):
    RESULTS.append((section, name, ok, note, ms))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}" + (f"  ({ms/1000:.1f}s)" if ms else "") + (f"  {clip(note)}" if note else ""))

def post(path, payload, stream=False):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return opener.open(req, timeout=TIMEOUT)

def post_json(path, payload):
    t0 = time.time()
    try:
        with post(path, payload) as r:
            return json.loads(r.read().decode()), None, int((time.time()-t0)*1000)
    except urllib.error.HTTPError as e:
        try: body = json.loads(e.read().decode())
        except Exception: body = {"error": str(e)}
        return body, e.code, int((time.time()-t0)*1000)
    except Exception as e:
        return {"error": str(e)}, -1, int((time.time()-t0)*1000)

def chat_sse(messages, web=False):
    """POST /api/chat and collect the streamed reply."""
    t0 = time.time()
    text, searched, sources, err = "", False, [], None
    try:
        with post("/api/chat", {"messages": messages, "web": web}) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data: "): continue
                try: ev = json.loads(line[6:])
                except Exception: continue
                if "t" in ev: text += ev["t"]
                if ev.get("status") == "searching": searched = True
                if ev.get("done"): sources = ev.get("sources") or []
                if ev.get("error"): err = ev.get("message") or ev["error"]
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode())
            err = f"HTTP {e.code}: " + str(body.get("message") or body.get("error") or body)[:160]
            d = body.get("detail")
            if isinstance(d, dict) and isinstance(d.get("error"), dict):
                err += f" [{d['error'].get('type')}] " + str(d['error'].get('message', ''))[:120]
        except Exception: err = f"HTTP {e.code}: {e}"
    except Exception as e:
        err = str(e)
    if not text and not err: err = "(empty stream: no deltas, no error event)"
    return text, searched, sources, err, int((time.time()-t0)*1000)

# ---------- tiny solid-color PNG (stdlib only) ----------
def solid_png(rgb, size=64):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    row = b"\x00" + bytes(rgb) * size
    raw = row * size
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    import base64; return base64.b64encode(png).decode()

# ---------- minimal one-page PDF containing a known word ----------
def tiny_pdf(word):
    stream = f"BT /F1 24 Tf 72 700 Td (Project reference: {word}) Tj ET".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"; offsets = []
    for n, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n".encode()
    for off in offsets: out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    import base64; return base64.b64encode(out).decode()

def has_any(text, *needles): return any(n.lower() in text.lower() for n in needles)

# ==============================================================================
print(f"\n== Crown end-to-end verification · {BASE} ==\n")

# ---- health + login ----
print("-- Health & session --")
h, code, ms = post_json("/api/health", {}) if False else (None, None, 0)
try:
    with opener.open(BASE + "/api/health", timeout=30) as r:
        h = json.loads(r.read().decode())
    record("sys", "API health", bool(h.get("ok")),
           f"rooms:{h.get('rooms')} floorFeed:{h.get('floorFeed')} stripe:{h.get('stripe')}")
except Exception as e:
    record("sys", "API health", False, str(e))

if not EMAIL or not PASSWORD:
    print("\nSet CROWN_TEST_EMAIL and CROWN_TEST_PASSWORD to run the full suite.")
    sys.exit(2)

me, code, ms = post_json("/api/login", {"email": EMAIL, "password": PASSWORD})
user = (me or {}).get("user") or {}
record("sys", "Login", bool(user), f"tier:{user.get('tier')} floor:{user.get('floor')}", ms)
if not user:
    print("\nCannot continue without a session."); sys.exit(1)
IS_PRO, HAS_FLOOR = user.get("tier") == "pro", bool(user.get("floor"))
CODE = "Obsidian-" + str(int(time.time()))[-5:]

# ---- Crown console (/api/chat) ----
print("\n-- Crown console (Anthropic, streaming) --")
def chat_sse_retry(messages, web=False):
    t, se, so, err, ms = chat_sse(messages, web)
    if (not t) or err:
        time.sleep(4)
        t2, se2, so2, err2, ms2 = chat_sse(messages, web)
        if t2 and not err2: return t2, se2, so2, err2, ms + ms2
        return t2 or t, se or se2, so2 or so, err2 or err, ms + ms2
    return t, se, so, err, ms

t, _, _, err, ms = chat_sse([{"role": "user", "content": "In one short sentence, who are you?"}])
record("crown", "Basic reply", bool(t) and not err, (err or t[:70]).replace("\n", " "), ms)

t, _, _, err, ms = chat_sse_retry([{"role": "user", "content":
    "Two parts, answer both precisely: 1) 17 multiplied by 23. 2) Spell the word crown backwards."}])
record("crown", "Complex reasoning", has_any(t, "391") and has_any(t, "nworc"), (err or t[:80]).replace("\n", " "), ms)

hist = [{"role": "user", "content": f"Quick note before we start: my side project is called {CODE}. Keep that in mind."},
        {"role": "assistant", "content": "Got it, nice name. What would you like to work on?"}]
for k in range(14):
    hist.append({"role": "user", "content": f"Filler question {k}: name a color."})
    hist.append({"role": "assistant", "content": f"Color {k}: blue."})
hist.append({"role": "user", "content": "By the way, what did I say my side project is called? Just the name."})
time.sleep(1.5)
t, _, _, err, ms = chat_sse_retry(hist)
record("crown", f"Long chat memory ({len(hist)} msgs)", CODE.lower() in t.lower(), (err or t[:60]).replace("\n", " "), ms)

img = solid_png((255, 45, 149))  # the house pink
time.sleep(1.5)
t, _, _, err, ms = chat_sse_retry([{"role": "user", "content": [
    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": img}},
    {"type": "text", "text": "One word: what color is this square?"}]}])
record("crown", "Image upload", has_any(t, "pink", "magenta", "fuchsia", "rose"), (err or t[:60]).replace("\n", " "), ms)

pdf = tiny_pdf(CODE)
time.sleep(1.5)
t, _, _, err, ms = chat_sse_retry([{"role": "user", "content": [
    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf}},
    {"type": "text", "text": "What is the project reference named in this PDF? Just the name."}]}])
record("crown", "PDF upload", CODE.lower() in t.lower(), (err or t[:60]).replace("\n", " "), ms)

if IS_PRO:
    t, searched, sources, err, ms = chat_sse(
        [{"role": "user", "content": "What is today's date and one current financial news headline?"}], web=True)
    record("crown", "Live web search", bool(t) and not err and (searched or sources),
           f"searched:{searched} sources:{len(sources)}", ms)
else:
    record("crown", "Live web search", True, "skipped: account is not Crowned")

# ---- The rooms (/api/room-chat) ----
ROOM_CALLS = []  # the server allows 20 room calls per minute per IP; stay under it
def room_chat(room, message, images=None):
    payload = {"room": room, "message": message}
    if images: payload["images"] = images
    for attempt in range(4):
        now = time.time()
        ROOM_CALLS[:] = [t for t in ROOM_CALLS if now - t < 62]
        if len(ROOM_CALLS) >= 17:
            wait = 63 - (now - ROOM_CALLS[0])
            print(f"      (pacing: waiting {wait:.0f}s for the rate-limit window)")
            time.sleep(max(1, wait))
        ROOM_CALLS.append(time.time())
        r, code, ms = post_json("/api/room-chat", payload)
        if code == 429 or (r or {}).get("error") == "rate":
            time.sleep(12); continue
        return r, code, ms
    return r, code, ms

TOPUP = int(user.get("topupTokens") or 0)
ROOM_LIST = ["unfiltered", "deep-logic", "visual-analysis", "creativity"] + (["the-floor"] if HAS_FLOOR else [])
for room in ROOM_LIST:
    print(f"\n-- Room: {room} --")
    if room == "deep-logic" and TOPUP <= 0:
        r, code, ms = room_chat(room, "ping")
        gated = code == 402 and (r or {}).get("error") == "topup_required"
        record(room, "Top-up paywall enforced ($0 balance)", gated, (r or {}).get("message", ""), ms)
        record(room, "Model checks", True, "skipped: add top-up credit to exercise the Deep-Logic model itself")
        continue
    r, code, ms = room_chat(room, "In one sentence, what is this room for?")
    txt = (r or {}).get("text", "")
    record(room, "Basic reply", bool(txt) and not code, (r.get("message", "") if code else txt[:70]).replace("\n", " "), ms)

    r, code, ms = room_chat(room, "Answer precisely: what is 17 multiplied by 23? Show the number.")
    txt = (r or {}).get("text", "")
    record(room, "Complex / arithmetic", has_any(txt, "391"), (r.get("message", "") if code else txt[:60]).replace("\n", " "), ms)

    r, code, ms = room_chat(room, f"Quick note: my side project is called {CODE}. Keep that in mind for this chat.")
    ok1 = bool((r or {}).get("text")) and not code
    r2, code2, ms2 = room_chat(room, "What did I just say my side project is called? Just the name.")
    txt2 = (r2 or {}).get("text", "")
    record(room, "Session memory (2 turns)", ok1 and CODE.lower() in txt2.lower(), txt2[:60].replace("\n", " "), ms + ms2)

    if room == "visual-analysis":
        r, code, ms = room_chat(room, "One word: what color is this square?",
                                images=[{"name": "swatch.png", "mime": "image/png", "data": solid_png((212, 172, 95))}])
        txt = (r or {}).get("text", "")
        vis_ok = has_any(txt, "gold", "yellow", "tan", "mustard", "ochre", "beige", "brown", "orange")
        vis_note = (r.get("message", "") if code else txt[:60])
        if not vis_ok and not code and ms < 2000:
            vis_note = (f"'{txt[:24]}' in {ms/1000:.1f}s: too fast for a 72B vision model, the engine likely "
                        "ignored the attachment. Update it: cd /opt/crown-rooms && docker compose pull && docker compose up -d")
        record(room, "Image upload (vision model)", vis_ok, vis_note, ms)
        r, code, ms = room_chat("unfiltered", "describe this", images=[{"name": "x.png", "mime": "image/png", "data": solid_png((1, 2, 3))}])
        record(room, "Non-vision room rejects images cleanly", code == 400 and (r or {}).get("error") == "no_vision",
               (r or {}).get("message", "")[:70], ms)

    if room == "the-floor":
        r, code, ms = room_chat(room, "Is the Nasdaq at all time highs right now?")
        txt = (r or {}).get("text", "")
        leaks = has_any(txt, "provided context", "[LIVE", "LIVE MARKET CONTEXT", "KORVUS WIRE", "[END",
                        "the context does not", "recommend checking the current prices")
        record(room, "Persona: answers, no tag leaks or refusals", bool(txt) and not leaks and not code,
               ("LEAKED/REFUSED: " if leaks else "") + txt[:80].replace("\n", " "), ms)
        codes = re.findall(r"\[(?:HIGH|MED|LOW)\b[^\]]*\]", txt)
        record(room, "Persona: raw signal codes translated", not codes, " ".join(codes)[:60], 0)

# ---- summary ----
print("\n" + "=" * 62)
fails = [r for r in RESULTS if not r[2]]
print(f"  {len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
if fails:
    print("  Failed:")
    for sec, name, _, note, _ in fails:
        print(f"    - [{sec}] {name}" + (f": {note}" if note else ""))
print("=" * 62)
sys.exit(1 if fails else 0)
