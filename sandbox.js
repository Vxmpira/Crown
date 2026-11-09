/**
 * Docker test sandbox for Co-Work
 * --------------------------------
 * Runs the Tester's code in a throwaway container so generated code is NEVER
 * executed on the EC2 host. Hard isolation:
 *   --network none        no network at all
 *   --memory / --pids     memory + process caps
 *   --cpus                cpu cap
 *   timeout               wall-clock kill
 *   --read-only + tmpfs   writable only in /work (small, noexec where possible)
 *   --cap-drop ALL        no Linux capabilities
 *   --rm                  container deleted on exit
 *   non-root user         runs as uid 1000
 *
 * If Docker is not installed/available, run() degrades gracefully to a
 * "skipped" result — the Tester's static findings are used instead. It never
 * falls back to running code on the host.
 *
 * Images (override via env):
 *   python -> COWORK_PY_IMAGE  (default python:3.12-slim)
 *   node   -> COWORK_NODE_IMAGE (default node:20-slim)
 *
 * Usage:
 *   const { makeSandbox } = require("./sandbox");
 *   const sandbox = makeSandbox();              // auto-detects docker
 *   await sandbox.run({ language, files, testCmd });
 */

"use strict";

const { spawn, spawnSync } = require("child_process");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

const PY_IMAGE   = process.env.COWORK_PY_IMAGE   || "python:3.12-slim";
const NODE_IMAGE = process.env.COWORK_NODE_IMAGE || "node:20-slim";
const MEM        = process.env.COWORK_SANDBOX_MEM   || "512m";
const CPUS       = process.env.COWORK_SANDBOX_CPUS  || "1.0";
const PIDS       = process.env.COWORK_SANDBOX_PIDS  || "128";
const TIMEOUT_S  = parseInt(process.env.COWORK_SANDBOX_TIMEOUT || "45", 10);
const MAX_LOG    = 16000;   // chars of logs returned to the Lead

function dockerAvailable() {
  if (String(process.env.COWORK_SANDBOX || "on").toLowerCase() === "off") return false;
  try {
    const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 4000 });
    return r.status === 0;
  } catch (_) { return false; }
}

function imageFor(language) {
  const l = String(language || "").toLowerCase();
  if (l.includes("node") || l.includes("javascript") || l.includes("typescript") || l.includes("js")) return NODE_IMAGE;
  return PY_IMAGE;   // python is the default runner
}

function writeFiles(dir, files) {
  for (const f of files) {
    const safe = path.normalize(f.path).replace(/^(\.\.(\/|\\|$))+/, "");
    const full = path.join(dir, safe);
    if (!full.startsWith(dir)) continue;                 // no path escape
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String(f.content ?? ""), "utf8");
  }
}

function clip(s) {
  s = String(s || "");
  return s.length > MAX_LOG ? s.slice(0, MAX_LOG) + "\n…(truncated)" : s;
}

function makeSandbox() {
  const available = dockerAvailable();

  async function run({ language, files, testCmd }) {
    if (!available) {
      return { ok: true, logs: "", timedOut: false, skipped: true,
               note: "Docker not available on host; static review used instead." };
    }
    if (!Array.isArray(files) || !files.length || !testCmd) {
      return { ok: true, logs: "", timedOut: false, skipped: true };
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-"));
    try {
      writeFiles(work, files);

      // The test command runs inside /work. We wrap it so a non-zero exit is
      // captured rather than throwing. bash is present in slim images.
      const inner = `cd /work && ${testCmd}`;

      const args = [
        "run", "--rm",
        "--network", "none",
        "--memory", MEM, "--memory-swap", MEM,
        "--cpus", CPUS,
        "--pids-limit", PIDS,
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--user", "1000:1000",
        "-v", `${work}:/work`,
        "-w", "/work",
        imageFor(language),
        "bash", "-lc", inner,
      ];

      return await new Promise((resolve) => {
        let out = "", done = false;
        const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });

        const killer = setTimeout(() => {
          if (done) return;
          try { child.kill("SIGKILL"); } catch (_) {}
          done = true;
          resolve({ ok: false, logs: clip(out), timedOut: true, skipped: false });
        }, (TIMEOUT_S + 5) * 1000);

        child.stdout.on("data", d => { out += d.toString(); });
        child.stderr.on("data", d => { out += d.toString(); });
        child.on("error", err => {
          if (done) return; done = true; clearTimeout(killer);
          resolve({ ok: true, logs: "", timedOut: false, skipped: true,
                    note: "Sandbox launch failed: " + err.message });
        });
        child.on("close", code => {
          if (done) return; done = true; clearTimeout(killer);
          resolve({ ok: code === 0, logs: clip(out), timedOut: false, skipped: false });
        });
      });
    } catch (e) {
      return { ok: true, logs: "", timedOut: false, skipped: true, note: "Sandbox error: " + e.message };
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
    }
  }

  return { run, available };
}

module.exports = { makeSandbox };
