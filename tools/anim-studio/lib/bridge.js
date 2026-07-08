// anim-studio/lib/bridge.js
//
// Minimal client for the live test-bridge (scripts/_test-bridge.js). Same
// file-IPC protocol safe-edit-adjacent tools use: write inbox/req-<id>.json,
// poll outbox/res-<id>.json. Requires the game RUNNING with a GM logged in and
// the bridge activated (FUCompanion.api.testBridge.activate()).
//
// Pure Node fs, no deps.
"use strict";

const fs = require("fs");
const path = require("path");

// Data dir = three levels up from tools/anim-studio/lib.
const DATA_DIR = path.resolve(__dirname, "..", "..", "..");
const WORLDS_DIR = path.join(DATA_DIR, "worlds");

// Locate the world whose test-bridge has the freshest heartbeat (or an
// explicit --world / ANIM_WORLD override). Falls back to fabula-ultima-2.
function resolveWorld(explicit) {
  if (explicit) return explicit;
  if (process.env.ANIM_WORLD) return process.env.ANIM_WORLD;
  let best = null, bestT = -1;
  try {
    for (const w of fs.readdirSync(WORLDS_DIR)) {
      const state = path.join(WORLDS_DIR, w, "test-bridge", "state.json");
      if (!fs.existsSync(state)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(state, "utf8"));
        const t = Date.parse(s.lastHeartbeat ?? 0) || 0;
        if (t > bestT) { bestT = t; best = w; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return best ?? "fabula-ultima-2";
}

class Bridge {
  constructor({ world = null } = {}) {
    this.world = resolveWorld(world);
    this.dir = path.join(WORLDS_DIR, this.world, "test-bridge");
    this.inbox = path.join(this.dir, "inbox");
    this.outbox = path.join(this.dir, "outbox");
  }

  secret() {
    try { return fs.readFileSync(path.join(this.dir, "bridge-secret.txt"), "utf8").trim(); }
    catch { return null; }
  }

  // Returns { alive, bootId, ageMs } from state.json.
  health() {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(this.dir, "state.json"), "utf8"));
      const ageMs = Date.now() - (Date.parse(s.lastHeartbeat ?? 0) || 0);
      return { alive: ageMs < 15000, bootId: s.bootId, ageMs, gmUserId: s.gmUserId };
    } catch { return { alive: false, bootId: null, ageMs: Infinity }; }
  }

  // Send a request and poll for the response. Rejects on timeout.
  async send(kind, args = {}, { timeoutMs = 30000, auth = false } = {}) {
    if (!fs.existsSync(this.inbox)) fs.mkdirSync(this.inbox, { recursive: true });
    const id = `anim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const req = { id, kind, args };
    if (auth) {
      const sec = this.secret();
      if (!sec) throw new Error("bridge-secret.txt not found (needed for evalGM).");
      req.auth = sec;
    }
    const reqPath = path.join(this.inbox, `req-${id}.json`);
    const resPath = path.join(this.outbox, `res-${id}.json`);
    fs.writeFileSync(reqPath, JSON.stringify(req), "utf8");

    const t0 = Date.now();
    try {
      while (Date.now() - t0 < timeoutMs) {
        if (fs.existsSync(resPath)) {
          // Small settle so we never read a half-written file.
          await sleep(40);
          let res;
          try { res = JSON.parse(fs.readFileSync(resPath, "utf8")); }
          catch { await sleep(60); res = JSON.parse(fs.readFileSync(resPath, "utf8")); }
          fs.rmSync(resPath, { force: true });
          if (!res.ok) throw new Error(`bridge error [${kind}]: ${res.error ?? "unknown"}`);
          return res.result;
        }
        await sleep(250);
      }
      throw new Error(`bridge timeout after ${timeoutMs}ms (is the game running + bridge active?)`);
    } finally {
      fs.rmSync(reqPath, { force: true });
    }
  }

  // A real round-trip liveness check. The bridge idles its heartbeat when no
  // requests arrive (state.json goes stale) but still answers requests — so a
  // live ping is more reliable than trusting `health().alive`. Returns the
  // bootId, or throws on timeout.
  async pingLive({ timeoutMs = 6000 } = {}) {
    const r = await this.send("ping", {}, { timeoutMs });
    return r?.bootId ?? null;
  }

  evalGM(code, opts = {}) { return this.send("evalGM", { code }, { auth: true, ...opts }); }
  updateDocument(uuid, changes, opts = {}) { return this.send("updateDocument", { uuid, changes }, opts); }
  fromUuid(uuid, opts = {}) { return this.send("query", { kind: "fromUuid", filter: { uuid } }, opts); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { Bridge, DATA_DIR, WORLDS_DIR, resolveWorld };
