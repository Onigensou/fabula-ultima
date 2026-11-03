// Minimal file-IPC client for the FU test-bridge. Avoids CDP entirely.
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
// FVTT_WORLD picks the world (e.g. staging-world); default is the live world.
// FVTT_STAGING=1 means the Staging World here too: a script that never calls loadConfig() (sim-scenario,
// skill-regression) otherwise wrote its requests to the LIVE world, and timed out (2026-11-03).
const DATA = fileURLToPath(new URL("../../../", import.meta.url));   // the Foundry Data folder
const DIR = `${DATA}worlds/${process.env.FVTT_WORLD || ([process.env.FVTT_STAGING, process.env.FVTT_LAB].some((v) => v === "1" || v === "true") ? "staging-world" : "fabula-ultima-2")}/test-bridge`;
const secret = readFileSync(`${DIR}/bridge-secret.txt`, "utf8").trim();
let _n = 0;
export async function call(kind, args = {}, { auth = false, timeoutMs = 30000 } = {}) {
  const id = `${kind}_${Date.now()}_${_n++}`;
  const req = { id, kind, args, requestedAt: new Date().toISOString(), timeoutMs };
  if (auth) req.auth = secret;
  const reqPath = `${DIR}/inbox/req-${id}.json`;
  const resPath = `${DIR}/outbox/res-${id}.json`;
  writeFileSync(reqPath, JSON.stringify(req));
  const deadline = Date.now() + timeoutMs + 8000;
  while (Date.now() < deadline) {
    if (existsSync(resPath)) {
      // The bridge may still be mid-write — a partial read parses as truncated
      // JSON. Treat a parse failure as "not ready yet" and re-poll rather than
      // crashing the caller (same guard bridge-eval.mjs uses).
      let res = null;
      try { res = JSON.parse(readFileSync(resPath, "utf8")); } catch { res = null; }
      if (res) {
        try { rmSync(reqPath); } catch {}
        try { rmSync(resPath); } catch {}
        return res;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  try { rmSync(reqPath); } catch {}
  throw new Error(`bridge timeout for ${kind}`);
}
// gm-eval convenience
export const evalGM = (code, timeoutMs = 30000) => call("evalGM", { code }, { auth: true, timeoutMs });
