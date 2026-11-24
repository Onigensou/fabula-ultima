// ============================================================================
// player-presence — how long before a missing player counts as gone.
//
//     node scripts/battle-director/player-presence-grace.test.mjs
//
// A player who presses F5 during a reaction window disconnects, reconnects a
// second later (socket up = "loading") and only says hello once the page is
// ready: 27-30 s on the live world. The old flat 20 s rule passed their
// reaction while the page was still loading (late-join-hunt-2026-11-24).
// The rule this pins: loading gets LOADING_GRACE_MS (90 s); truly offline keeps
// GRACE_MS (20 s); a ready player is never gone.
// ============================================================================

let NOW = 1_000_000;
Date.now = () => NOW;

const hooks = {};
const intervals = [];
globalThis.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
globalThis.Hooks = { on(n, f) { (hooks[n] ??= []).push(f); }, once(n, f) { (hooks[n] ??= []).push(f); }, callAll() {}, off() {} };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.foundry = { utils: { randomID: () => "id" + Math.random().toString(36).slice(2) } };
const users = new Map();
const mkUser = (id, isGM = false) => { const u = { id, name: id, isGM, active: false }; users.set(id, u); return u; };
const gm = mkUser("GM", true); gm.active = true;
const P = mkUser("PLAYER"); const Q = mkUser("OFFLINER");
globalThis.game = {
  user: gm,
  users: { get: (id) => users.get(id), get contents() { return [...users.values()]; }, [Symbol.iterator]: () => users.values() },
  socket: { on() {}, off() {}, emit() {} },
  settings: { get: () => null, set: () => {} },
};

const presence = await import("./player-presence.js");
const { getIntentChannel } = await import("./intent-channel.js");
const { installPlayerPresence, isGone, presenceOf, GRACE_MS } = presence;
const LOADING_GRACE_MS = presence.LOADING_GRACE_MS ?? GRACE_MS;   // HEAD has no loading grace

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
// Advance the clock in 5 s probe ticks so this GM never looks stalled.
const advance = (ms) => { const end = NOW + ms; while (NOW < end) { NOW = Math.min(end, NOW + 5000); for (const f of intervals) f(); } };
const connect = (u, on) => { u.active = on; for (const f of hooks.userConnected ?? []) f(u, on); };

installPlayerPresence();

// ── Both players were here and ready ────────────────────────────────────────
connect(P, true); getIntentChannel()._notifyPeerReady(P.id);
connect(Q, true); getIntentChannel()._notifyPeerReady(Q.id);
eq("P ready", presenceOf(P.id), "ready");
eq("ready player is never gone", isGone(P.id), false);

// ── P presses F5: drops, socket comes back a second later, page still loading
connect(P, false);
advance(1000);
connect(P, true);
eq("P reloading reads loading", presenceOf(P.id), "loading");
advance(24_000);                       // 25 s since the drop: the live world is still booting
eq("loading at 25 s: NOT gone (was gone under the flat 20 s rule)", isGone(P.id), false);
advance(60_000);                       // 85 s
eq("loading at 85 s: still not gone", isGone(P.id), false);
advance(6_000);                        // 91 s
eq("loading at 91 s: gone", isGone(P.id), true);
getIntentChannel()._notifyPeerReady(P.id);
eq("hello clears it", isGone(P.id), false);

// ── Q closes the tab: no socket at all ──────────────────────────────────────
connect(Q, false);
eq("Q offline", presenceOf(Q.id), "offline");
advance(19_000);
eq("offline at 19 s: not gone", isGone(Q.id), false);
advance(2_000);
eq("offline at 21 s: gone (20 s rule kept)", isGone(Q.id), true);

eq("constants", [GRACE_MS, LOADING_GRACE_MS], [20_000, 90_000]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
