// Minimal test-bridge client: round-trips an evalGM request through the
// file-IPC bridge and returns the parsed response. Game must be OPEN.
const fs = require("fs");
const path = require("path");

const BRIDGE_DIR = path.resolve(__dirname, "../../../worlds/fabula-ultima-2/test-bridge");

function readSecret() {
  return fs.readFileSync(path.join(BRIDGE_DIR, "bridge-secret.txt"), "utf8").trim();
}

function bridgeAlive() {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "state.json"), "utf8"));
    // Heartbeat is UTC; treat as alive if the file was touched in the last 90s.
    const mtime = fs.statSync(path.join(BRIDGE_DIR, "state.json")).mtimeMs;
    return st.ready === true && (Date.now() - mtime) < 90_000;
  } catch { return false; }
}

// Send an evalGM `code` string; resolve the parsed `result` (throws on bridge
// error / non-ok). timeoutSecs default 300 (a full-roster capture can be slow).
function evalGM(code, { timeoutSecs = 300 } = {}) {
  return new Promise((resolve, reject) => {
    const secret = readSecret();
    const id = "rg-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    const req = path.join(BRIDGE_DIR, "inbox", `req-${id}.json`);
    const res = path.join(BRIDGE_DIR, "outbox", `res-${id}.json`);
    // `timeoutMs` extends the bridge's server-side handler timeout (default 30s,
    // clamped to a 5-min max in the bridge). We poll a hair longer than that.
    const serverTimeoutMs = Math.min(290_000, Math.max(1000, timeoutSecs * 1000));
    fs.writeFileSync(req, JSON.stringify({ id, kind: "evalGM", args: { code }, auth: secret, timeoutMs: serverTimeoutMs }));
    const deadline = Date.now() + serverTimeoutMs + 15_000;
    const cleanup = () => { try { fs.unlinkSync(req); } catch {} try { fs.unlinkSync(res); } catch {} };
    let parseAttempts = 0;
    (function poll() {
      if (fs.existsSync(res)) {
        // The res file can appear before its contents are fully flushed (the
        // write is not atomic on Windows). An empty or truncated read means
        // "still writing" — retry a few times before treating it as an error.
        let raw = "";
        try { raw = fs.readFileSync(res, "utf8"); } catch { raw = ""; }
        if (raw.length) {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { parsed = null; }
          if (parsed) {
            cleanup();
            if (!parsed.ok) return reject(new Error("bridge error: " + (parsed.error || "unknown")));
            return resolve(parsed.result);
          }
        }
        if (++parseAttempts > 25) { cleanup(); return reject(new Error("bad response JSON (still truncated after retries)")); }
        return setTimeout(poll, 120);
      }
      if (Date.now() > deadline) { try { fs.unlinkSync(req); } catch {} return reject(new Error(`bridge timeout after ${timeoutSecs}s`)); }
      setTimeout(poll, 400);
    })();
  });
}

module.exports = { evalGM, bridgeAlive, BRIDGE_DIR };
