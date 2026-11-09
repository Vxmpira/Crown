/**
 * Co-Work orchestrator for Crown (BlackCrown VxJ)
 * ------------------------------------------------
 * One "Lead" model plans a task, hands three sub-agents (Builder, Reviewer,
 * Tester) their specs, runs a handoff/retry loop, and returns a finished
 * product that the Lead delivers to the user in its own voice.
 *
 * This module is backend-agnostic. It talks to the outside world ONLY through
 * the hooks you inject (callModel, meter, sandbox, emit). That means it drops
 * into the simple repo server.js OR the EC2 v3/v4 server.js without a rewrite.
 *
 * The models stay unfiltered. The ONLY restriction is a single malware gate
 * on the finished product, right before it reaches the user. It blocks a short,
 * high-precision list (ransomware/wipers, credential stealers, botnet/RAT/C2,
 * self-propagating worms, keyloggers/spyware, intrusion exploits) and nothing
 * else. Normal unfiltered work, security research, and games all pass untouched.
 * For fully ungated work, run the gateless build on your segregated network
 * (see README) — do not remove this gate from the public product.
 *
 * Injected hooks (all required unless noted):
 *   callModel(messages, opts) -> { text, inTok, outTok }
 *       messages : [{ role:"user"|"assistant", content:string }]
 *       opts     : { system, maxTokens, temperature, json(bool) }
 *   meter : {
 *       remaining() -> number        // credit tokens the user has left
 *       charge(tokens) -> void       // deduct after each model call
 *   }
 *   sandbox : {
 *       run({ language, files, testCmd }) -> { ok, logs, timedOut, skipped }
 *   }                                 // may be a no-op stub; see sandbox.js
 *   emit(event) -> void               // optional; SSE status to the browser
 *
 * Public API:
 *   runCowork({ task, history, callModel, meter, sandbox, emit, opts })
 *     -> { ok:true,  deliverable, reply, plan, spent }
 *     -> { ok:false, blocked:true, category, reason, spent }   // gate tripped
 *     -> { ok:false, error, message, spent }                   // credit/other
 */

"use strict";

const MAX_WORKER_RETRIES = 2;     // per worker, after the first attempt
const WORKER_TEMP        = 0.2;   // low: workers execute, they don't improvise
const LEAD_TEMP          = 0.4;
const DEFAULT_MAX_TOKENS = 4096;

/* ----------------------------- small helpers ----------------------------- */

function clampTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.slice(0, 3);   // three sub-agents, hard cap
}

// Pull the first JSON object/array out of a model reply, tolerating prose or
// ```json fences around it. Returns null if nothing parses.
function extractJson(text) {
  if (typeof text !== "string") return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // Try the whole thing first, then the widest {...} / [...] span.
  const tries = [t];
  const objStart = t.indexOf("{"), objEnd = t.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) tries.push(t.slice(objStart, objEnd + 1));
  const arrStart = t.indexOf("["), arrEnd = t.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) tries.push(t.slice(arrStart, arrEnd + 1));
  for (const cand of tries) {
    try { return JSON.parse(cand); } catch (_) {}
  }
  return null;
}

function filesToText(files) {
  if (!Array.isArray(files) || !files.length) return "(no files)";
  return files.map(f => `--- FILE: ${f.path} ---\n${f.content}`).join("\n\n");
}

function sanitizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .filter(f => f && typeof f.path === "string" && typeof f.content === "string")
    .slice(0, 40)
    .map(f => ({ path: f.path.replace(/^[\/\\]+/, "").slice(0, 200), content: f.content }));
}

/* ----------------------- metered single model turn ----------------------- */

async function turn(ctx, messages, opts) {
  if (ctx.meter.remaining() <= 0) {
    const e = new Error("Out of Co-Work credit.");
    e.code = "credit";
    throw e;
  }
  const out = await ctx.callModel(messages, Object.assign({
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: WORKER_TEMP,
  }, opts || {}));
  const spent = (out.inTok || 0) + (out.outTok || 0);
  ctx.spent += spent;
  ctx.meter.charge(spent);
  return out.text || "";
}

/* -------------------------------- prompts -------------------------------- */

const LEAD_PLAN_SYSTEM = `You are the Lead of a small build team. You do not write the final product yourself.
You read the user's request and produce a precise work order for up to three sub-agents:
  - "builder"  : writes the code / content
  - "reviewer" : checks the builder's output against the spec and fixes defects
  - "tester"   : writes and runs tests to prove it works
Return ONLY JSON, no prose, in exactly this shape:
{
  "summary": "one line restating what the user wants",
  "language": "primary language or stack, e.g. python, node, luau, html",
  "runnable": true | false,          // true only if a generic Linux container can execute tests
  "deliverable": "what the finished product is, concretely",
  "tasks": [
    { "role": "builder",  "goal": "...", "inputs": "...", "constraints": "...", "expected": "..." },
    { "role": "reviewer", "goal": "...", "inputs": "...", "constraints": "...", "expected": "..." },
    { "role": "tester",   "goal": "...", "inputs": "...", "constraints": "...", "expected": "..." }
  ]
}
Keep each field short. Set "runnable" false for things like Roblox/Luau, mobile, or GUI code a headless container can't run — the tester will do static checks instead.`;

const BUILDER_SYSTEM = `You are the Builder sub-agent. Execute the Lead's spec exactly. No commentary, no chat.
Return ONLY JSON: { "files": [ { "path": "relative/name.ext", "content": "full file text" } ], "notes": "short build notes" }.
Write complete, runnable files. Do not abbreviate with "...". Honor every constraint in the spec.`;

const REVIEWER_SYSTEM = `You are the Reviewer sub-agent. You receive the spec and the Builder's files.
Find defects: spec misses, bugs, missing pieces, unsafe assumptions. Fix them directly.
Return ONLY JSON: { "files": [ full corrected file set ], "changed": true|false, "notes": "what you changed and why" }.
Return the COMPLETE file set, not a diff. If nothing needed changing, set changed=false and return the files unchanged.`;

const TESTER_SYSTEM = `You are the Tester sub-agent. You receive the spec and the current files.
Write tests that exercise the deliverable against the spec.
Return ONLY JSON: {
  "testFiles": [ { "path": "...", "content": "..." } ],
  "testCmd": "shell command to run the tests, e.g. 'python -m pytest -q' or 'node test.js'",
  "staticFindings": "if the code cannot be executed here, your best static review instead"
}.`;

const LEAD_JUDGE_SYSTEM = `You are the Lead reviewing a sub-agent's returned work against its spec and any test output.
Return ONLY JSON: { "accept": true|false, "worker": "builder"|"reviewer"|"tester", "notes": "if rejecting, exactly what to fix" }.
Accept unless there is a real defect or the tests failed. Be specific when rejecting so the worker can fix it in one pass.`;

const LEAD_DELIVER_SYSTEM = `You are the Lead handing the finished product to the user, in your own confident, concise voice (you are Crown for BlackCrown VxJ).
You are given the user's original request and the final files. Write a short message that:
  - says what was built in one or two sentences,
  - gives only the essential how-to-use / how-to-run notes,
  - does NOT paste entire files back (the files are delivered separately).
Plain, direct, no filler.`;

/* ------------------------------ the gate --------------------------------- */
/*
 * Single, high-precision malware check on the FINISHED product. This is the
 * one restriction; it protects the LLC (AWS AUP, Stripe) and nothing more.
 * It runs for every account, admin included, by design.
 */

const GATE_SYSTEM = `You are a release gate. You are shown a finished software deliverable.
Block ONLY if its PRIMARY purpose is one of these malicious categories:
  - ransomware or data-wiper (encrypt/destroy a victim's files for leverage)
  - credential / token / wallet stealer (harvest and exfiltrate secrets)
  - botnet, RAT, or command-and-control client/agent
  - self-propagating worm or virus (auto-spreads to other machines)
  - keylogger or covert surveillance/spyware against a person
  - an exploit whose purpose is unauthorized intrusion into systems the user does not own
Do NOT block ordinary software, games, websites, automation, data tools, or legitimate
security work (CTF solvers, scanners, pentest tooling used with authorization, crypto,
parsers, scrapers, bots for public APIs). When in doubt, ALLOW.
Return ONLY JSON: { "block": true|false, "category": "", "reason": "one line" }.`;

async function gateCheck(ctx, userTask, files) {
  // The gate runs on ctx.classify (a reliable instruct model), NOT the
  // unfiltered worker chain, and is NOT billed to the user — it's a house-side
  // safety cost. Any error or parse failure => ALLOW, because this gate must
  // never become a general-purpose refuser.
  let text;
  try {
    const out = await ctx.classify([{
      role: "user",
      content: `USER REQUEST:\n${userTask}\n\nFINISHED DELIVERABLE:\n${filesToText(files)}`,
    }], { system: GATE_SYSTEM, temperature: 0, json: true, maxTokens: 300 });
    text = out && typeof out.text === "string" ? out.text : "";
  } catch (e) {
    return { block: false };
  }
  const v = extractJson(text);
  if (!v || typeof v.block !== "boolean") return { block: false };
  return v;
}

/* ------------------------------ sub-agents ------------------------------- */

async function runBuilder(ctx, spec) {
  const text = await turn(ctx, [{
    role: "user",
    content: `SPEC:\n${JSON.stringify(spec, null, 2)}\n\nOriginal user request (for context):\n${ctx.task}`,
  }], { system: BUILDER_SYSTEM, temperature: WORKER_TEMP, json: true, maxTokens: 6144 });
  const j = extractJson(text) || {};
  return { files: sanitizeFiles(j.files), notes: String(j.notes || "") };
}

async function runReviewer(ctx, spec, files) {
  const text = await turn(ctx, [{
    role: "user",
    content: `SPEC:\n${JSON.stringify(spec, null, 2)}\n\nBUILDER FILES:\n${filesToText(files)}`,
  }], { system: REVIEWER_SYSTEM, temperature: WORKER_TEMP, json: true, maxTokens: 6144 });
  const j = extractJson(text) || {};
  const fixed = sanitizeFiles(j.files);
  return {
    files: fixed.length ? fixed : files,   // never lose the build on a bad parse
    changed: j.changed !== false,
    notes: String(j.notes || ""),
  };
}

async function runTester(ctx, spec, files, runnable) {
  const text = await turn(ctx, [{
    role: "user",
    content: `SPEC:\n${JSON.stringify(spec, null, 2)}\n\nFILES:\n${filesToText(files)}\n\nRunnable in a headless Linux container: ${runnable}`,
  }], { system: TESTER_SYSTEM, temperature: WORKER_TEMP, json: true, maxTokens: 4096 });
  const j = extractJson(text) || {};
  const testFiles = sanitizeFiles(j.testFiles);
  const testCmd = String(j.testCmd || "").slice(0, 300);
  const staticFindings = String(j.staticFindings || "");

  let exec = { ok: true, logs: "", timedOut: false, skipped: true };
  if (runnable && testFiles.length && testCmd) {
    ctx.emit({ status: "tester", detail: "running tests in sandbox" });
    exec = await ctx.sandbox.run({
      language: spec.language || ctx.language,
      files: files.concat(testFiles),
      testCmd,
    });
  }
  return { testFiles, testCmd, staticFindings, exec };
}

/* --------------------------- the orchestrator ---------------------------- */

async function runCowork({ task, history, callModel, classify, meter, sandbox, emit, opts }) {
  const ctx = {
    task: String(task || "").trim(),
    history: Array.isArray(history) ? history : [],
    callModel,
    classify: typeof classify === "function" ? classify : callModel,   // gate model; defaults to the chain model
    meter,
    sandbox: sandbox || { run: async () => ({ ok: true, logs: "", timedOut: false, skipped: true }) },
    emit: typeof emit === "function" ? emit : () => {},
    opts: opts || {},
    spent: 0,
    language: "text",
  };

  if (!ctx.task) {
    return { ok: false, error: "empty", message: "Nothing to build.", spent: 0 };
  }

  try {
    /* 1 — Lead plans */
    ctx.emit({ status: "planning", detail: "Lead is drafting the work order" });
    const planText = await turn(ctx,
      ctx.history.concat([{ role: "user", content: ctx.task }]),
      { system: LEAD_PLAN_SYSTEM, temperature: LEAD_TEMP, json: true, maxTokens: 1500 });
    const plan = extractJson(planText);
    if (!plan || !Array.isArray(plan.tasks)) {
      return { ok: false, error: "plan_failed", message: "The Lead could not form a plan. Try rephrasing the task.", spent: ctx.spent };
    }
    plan.tasks = clampTasks(plan.tasks);
    ctx.language = plan.language || "text";
    const runnable = plan.runnable === true;
    ctx.emit({ status: "planned", detail: plan.summary || "", plan });

    /* 2 — Builder */
    ctx.emit({ status: "builder", detail: "writing the first version" });
    const builderSpec = plan.tasks.find(t => t.role === "builder") || plan.tasks[0] || {
      role: "builder", goal: ctx.task, inputs: "", constraints: "", expected: plan.deliverable,
    };
    let files = (await buildWithRetries(ctx, builderSpec)).files;
    if (!files.length) {
      return { ok: false, error: "no_output", message: "The Builder returned nothing usable.", spent: ctx.spent };
    }

    /* 3 — Reviewer */
    const reviewerSpec = plan.tasks.find(t => t.role === "reviewer") || {
      role: "reviewer", goal: "verify against spec and fix defects", expected: plan.deliverable,
    };
    ctx.emit({ status: "reviewer", detail: "checking against spec" });
    const reviewed = await runReviewer(ctx, reviewerSpec, files);
    files = reviewed.files;

    /* 4 — Tester + Lead handoff loop */
    const testerSpec = plan.tasks.find(t => t.role === "tester") || {
      role: "tester", goal: "prove it works", expected: plan.deliverable,
    };
    let tested = await runTester(ctx, testerSpec, files, runnable);

    let attempt = 0;
    while (attempt < MAX_WORKER_RETRIES) {
      const judgeText = await turn(ctx, [{
        role: "user",
        content:
          `SPEC:\n${JSON.stringify(plan, null, 2)}\n\n` +
          `FILES:\n${filesToText(files)}\n\n` +
          `TEST RESULT:\n${tested.exec.skipped
            ? "(not executed) static review:\n" + tested.staticFindings
            : `exit ${tested.exec.ok ? "ok" : "FAIL"}${tested.exec.timedOut ? " (timed out)" : ""}\nlogs:\n` + tested.exec.logs}`,
      }], { system: LEAD_JUDGE_SYSTEM, temperature: 0, json: true, maxTokens: 600 });

      const verdict = extractJson(judgeText) || { accept: true };
      if (verdict.accept !== false) break;

      // Re-dispatch the worker the Lead named, with its notes.
      attempt++;
      ctx.emit({ status: "revising", detail: `Lead sent it back to ${verdict.worker || "builder"} (pass ${attempt})` });
      const notes = String(verdict.notes || "");
      if (verdict.worker === "tester") {
        tested = await runTester(ctx, testerSpec, files, runnable);
      } else if (verdict.worker === "reviewer") {
        const r = await runReviewer(ctx, Object.assign({}, reviewerSpec, { constraints: notes }), files);
        files = r.files;
        tested = await runTester(ctx, testerSpec, files, runnable);
      } else {
        const b = await buildWithRetries(ctx, Object.assign({}, builderSpec, { constraints: `${builderSpec.constraints || ""}\nLead feedback: ${notes}` }), 0);
        if (b.files.length) files = b.files;
        const r = await runReviewer(ctx, reviewerSpec, files);
        files = r.files;
        tested = await runTester(ctx, testerSpec, files, runnable);
      }
    }

    /* 5 — Gate (the one restriction) */
    ctx.emit({ status: "gate", detail: "final safety check" });
    const gate = await gateCheck(ctx, ctx.task, files);
    if (gate.block) {
      return {
        ok: false, blocked: true,
        category: gate.category || "malware",
        reason: gate.reason || "Deliverable falls into a blocked malware category.",
        spent: ctx.spent,
      };
    }

    /* 6 — Lead delivers */
    ctx.emit({ status: "delivering", detail: "Lead is writing your handoff" });
    const reply = await turn(ctx, [{
      role: "user",
      content: `ORIGINAL REQUEST:\n${ctx.task}\n\nFINAL FILES:\n${filesToText(files)}`,
    }], { system: LEAD_DELIVER_SYSTEM, temperature: LEAD_TEMP, maxTokens: 1200 });

    ctx.emit({ status: "done" });
    return {
      ok: true,
      deliverable: {
        language: ctx.language,
        summary: plan.summary || "",
        files,
        tests: tested.testFiles,
        testCmd: tested.testCmd,
        testExecuted: !tested.exec.skipped,
        testPassed: tested.exec.skipped ? null : tested.exec.ok,
        staticFindings: tested.exec.skipped ? tested.staticFindings : "",
      },
      reply: reply || "Done.",
      plan,
      spent: ctx.spent,
    };
  } catch (e) {
    if (e.code === "credit") {
      return { ok: false, error: "credit", message: "Ran out of Co-Work credit mid-task. Top up and retry.", spent: ctx.spent };
    }
    return { ok: false, error: "cowork_failed", message: e.message || "Co-Work failed.", spent: ctx.spent };
  }
}

async function buildWithRetries(ctx, spec, _depth) {
  let out = await runBuilder(ctx, spec);
  let tries = 0;
  while (!out.files.length && tries < 1) {   // one re-ask if the builder whiffed
    tries++;
    out = await runBuilder(ctx, Object.assign({}, spec, {
      constraints: `${spec.constraints || ""}\nYour previous reply did not parse as the required JSON. Return ONLY the JSON object.`,
    }));
  }
  return out;
}

module.exports = { runCowork };
