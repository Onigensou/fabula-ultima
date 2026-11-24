// Late-join resync — repair what a client missed while it was loading.
//
// Foundry core only starts listening for document changes after `ready`, while
// the world snapshot is fetched at the start of the boot. Every create / update
// / delete broadcast in between is dropped silently, so a player who loads
// while a battle is being set up can keep missing statuses, tokens or summons
// (or keep ghosts) until the next reload. Root cause + measurements:
// tools/handoffs/late-join-hunt-2026-11-24.md; design:
// tools/handoffs/fix-late-join-2026-11-24.md.
//
// Flow (every client that is not the BD host, after `ready` and after a socket
// reconnect):
//   1. ask the HOST (executeAsUser — the host is an explicit claim, see
//      director-host.js) for a digest of the battle scene; no battle = done;
//   2. build the same digest locally and compare, twice ~1.5 s apart: only a
//      difference seen both times counts (an event in flight is not drift);
//   3. re-read the stale documents from the SERVER (a "get", never broadcast,
//      writes nothing), rebuild the local digest AFTER those reads, and replay
//      the difference into core's own modifyDocument socket handler, exactly as
//      the dropped broadcast would have been handled: same collections, same
//      placeables, create/delete hooks run once here. A create whose id this
//      client already holds is dropped;
//   4. if that can't be done, or drift survives: ONE reload at a settled moment
//      (the host's FSM is waiting on a human, no menu cached for this user, no
//      picker / reaction hand / own action card open here), with a toast, at
//      most once per 10 minutes per tab.
//   A GM client never replays and never reloads by itself (GM-gated hooks
//   WRITE on create: grappled, AE reaction bridge, polymorph, equip sync...):
//   it gets a toast with a Reload button instead.
//
// Up to MAX_ROUNDS (5) rounds; one retry ~5 s later when the host can't be
// asked. Read-only on the server. Idempotent: every pass recomputes from scratch.

import { log, warn } from "./logger.js";
import { hostUserId, probeHost, amHost } from "./director-host.js";
import { getIntentChannel } from "./intent-channel.js";
import { remotePicksOpen } from "./remote-pick.js";
import {
  buildDigest, compareDigests, stableIssues, fetchPlan, planReconcile, toSocketResponse,
  dropExistingCreates, recheckOp, hostSettledFor, pageBusyReason,
} from "./late-join-core.js";

const NS = "fabula-ultima-companion";
const ACTION_DIGEST = "FU_LATE_JOIN_DIGEST";
const START_DELAY_MS = 2500;
const STABLE_GAP_MS = 1500;
const AFTER_FIX_MS = 700;
const MAX_ROUNDS = 5;
const ASK_TIMEOUT_MS = 6000;
const RETRY_MS = 5000;
const RECONNECT_DELAY_MS = 2500;
const RELOAD_WAIT_MS = 180_000;
const RELOAD_KEY = `${NS}.lateJoinReloadAt`;
const RELOAD_COOLDOWN_MS = 10 * 60_000;

let _socket = null;
let _getDirector = () => null;
let _installed = false;
let _running = null;
let _lastReport = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${label} timed out`)), ms))]);

function fieldActorIds() {
  return (game.actors?.contents ?? []).filter((a) => a?.flags?.[NS]?.isField).map((a) => a.id);
}

// ── Host side ───────────────────────────────────────────────────────────────
/** A non-GM, active owner of the creature whose turn it is (CONFIRM is theirs). */
function actingOwnerOf(d) {
  try {
    const actor = d?.combat?.combatant?.actor ?? d?.dCombat?.combat?.combatant?.actor ?? null;
    if (!actor) return null;
    const u = (game.users?.contents ?? []).find((x) => !x.isGM && x.active && actor.testUserPermission?.(x, "OWNER"));
    return u?.id ?? null;
  } catch (_e) { return null; }
}

function hostDigest({ userId } = {}) {
  const d = _getDirector();
  const scene = d?.dCombat?.scene ?? d?.combat?.scene ?? null;
  if (!d || !scene) return { v: 1, active: false };
  let settled = false;
  try {
    const cached = userId ? (getIntentChannel()?._recentBroadcasts?.get?.(userId) ?? null) : null;
    settled = hostSettledFor({ state: d.state, cached, userId, actingOwnerId: actingOwnerOf(d) });
  } catch (_e) { settled = false; }
  return buildDigest({ scene, actorIds: fieldActorIds(), getActor: (id) => game.actors?.get(id) ?? null, settled });
}

// ── Client side ─────────────────────────────────────────────────────────────
function localDigest(host) {
  const scene = game.scenes?.get(host.sceneId) ?? null;
  // An absent scene is itself a difference: report it as an active digest with no tokens.
  const d = buildDigest({ scene: scene ?? { id: host.sceneId, tokens: [] }, actorIds: Object.keys(host.actors ?? {}), getActor: (id) => game.actors?.get(id) ?? null });
  return d;
}

class HostCallError extends Error {}

async function askHost(hostId) {
  try {
    return await withTimeout(_socket.executeAsUser(ACTION_DIGEST, hostId, { userId: game.user?.id ?? null }), ASK_TIMEOUT_MS, "host digest");
  } catch (e) {
    throw new HostCallError(String(e?.message ?? e));
  }
}

async function resolveHost() {
  let id = hostUserId();
  if (!id) id = await probeHost();
  return id && id !== game.user?.id ? id : null;
}

/** Raw server read — the request ClientDatabaseBackend#_getDocuments sends, without building documents. */
async function serverGet(type, id) {
  // v12 declares SocketInterface as a top-level class in a classic script: a global
  // lexical binding, reachable by bare name but NOT as globalThis.SocketInterface.
  // eslint-disable-next-line no-undef
  const SI = typeof SocketInterface !== "undefined" ? SocketInterface : (foundry?.helpers?.SocketInterface ?? null);
  if (!SI?.dispatch) throw new Error("SocketInterface unavailable");
  const res = await withTimeout(SI.dispatch("modifyDocument", { type, action: "get", operation: { query: { _id: id }, broadcast: false } }), ASK_TIMEOUT_MS, `server get ${type}`);
  return (res?.result ?? [])[0] ?? null;
}

/** Core's own modifyDocument listener (ClientDatabaseBackend#onModifyDocument, bound). */
function coreModifyHandler() {
  const ls = game.socket?.listeners?.("modifyDocument") ?? [];
  return ls.find((fn) => /onModifyDocument/.test(fn?.name ?? "")) ?? null;
}

function localDeltaId(sceneId, tokenId) {
  return game.scenes?.get(sceneId)?.tokens?.get(tokenId)?.delta?.id ?? null;
}

/** The local document a replay op's parentUuid names (Actor / Scene / Token / a token's ActorDelta). */
function parentOf(parentUuid) {
  const p = String(parentUuid ?? "").split(".");
  if (p[0] === "Actor") return game.actors?.get(p[1]) ?? null;
  if (p[0] !== "Scene") return null;
  const scene = game.scenes?.get(p[1]) ?? null;
  if (p.length === 2) return scene;
  const tok = p[2] === "Token" ? scene?.tokens?.get(p[3]) : null;
  if (p.length === 4) return tok ?? null;
  return p[4] === "ActorDelta" ? (tok?.delta ?? null) : null;
}

/** Does the collection this create op targets already hold `id` on this client? */
function alreadyHere(op, id) {
  try {
    if (op.type === "Actor") return !!game.actors?.has(id);
    const parent = parentOf(op.parentUuid);
    if (!parent) return false;
    if (op.type === "Token") return !!parent.tokens?.has?.(id);
    if (op.type === "ActiveEffect") {
      if (parent.effects?.has?.(id)) return true;
      // A token's synthetic actor also shows its base actor's effects.
      return !!(parent.documentName === "ActorDelta" && parent.parent?.actor?.effects?.has?.(id));
    }
  } catch (_e) { /* treat as absent */ }
  return false;
}

async function waitFor(test, ms = 1500) {
  const t0 = Date.now();
  while (!test() && Date.now() - t0 < ms) await sleep(50);
  return test();
}

/**
 * Replay ops into core's listener, in order. Core's #onModifyDocument does not
 * return its handler's promise (client-backend.mjs:435-449), so a create that a
 * later op depends on (actor create -> token reset) is waited for by polling.
 */
async function applyOps(ops, { sceneId, hostId }) {
  const handler = coreModifyHandler();
  if (!handler) throw new Error("core modifyDocument listener not found");
  for (const planned of ops) {
    // The plan was built before awaits (server reads, earlier ops, waitFor): look
    // at the live collections again right before each call. A create whose id is
    // already here, or a delete whose id is already gone, has been handled live.
    const op = planned.action === "reset-token" ? planned : recheckOp(planned, alreadyHere);
    if (!op) continue;
    if (op.action === "reset-token") {
      const tok = game.scenes?.get(sceneId)?.tokens?.get(op.tokenId);
      if (tok?.actorId) await waitFor(() => !!game.actors?.has(tok.actorId));
      try { tok?.reset(); tok?.object?.renderFlags?.set({ redraw: true }); }
      catch (e) { warn("[late-join] token reset threw", e); }
      continue;
    }
    handler(toSocketResponse(op, { userId: hostId }));
    if (op.type === "Actor" && op.action === "create") {
      const ids = (op.result ?? []).map((r) => r._id);
      await waitFor(() => ids.every((id) => game.actors?.has(id)));
    }
  }
}

function detail(i) {
  const n = (a) => (a?.length ? a.length : 0);
  return `${i.k}${i.missing ? ` -${n(i.missing)}` : ""}${i.extra ? ` +${n(i.extra)}` : ""}${i.changed?.length ? ` ~${i.changed.length}` : ""}`;
}

function summarize(issues) {
  const by = {};
  for (const i of issues) by[i.kind] = (by[i.kind] ?? 0) + 1;
  return by;
}

/** This page's own "mid-decision" probe (the host can't see what is on screen here). */
function pageBusyNow() {
  try {
    let picks = 0;
    try { picks = remotePicksOpen(); } catch (_e) {}
    return pageBusyReason((sel) => document.querySelector(sel), { userId: game.user?.id ?? null, picksOpen: picks });
  } catch (_e) { return "probe-failed"; }
}

/** GM client: never repaired in place (GM-gated hooks would write); offer a reload. */
function offerGmReload(report) {
  report.status = "gm-drift-offered";
  warn("[late-join] this GM page is out of sync with the battle host; offering a reload", report);
  try {
    document.getElementById("fu-late-join-toast")?.remove();
    const el = document.createElement("div");
    el.id = "fu-late-join-toast";
    el.setAttribute("role", "alert");
    el.style.cssText = [
      "position:fixed", "right:16px", "bottom:16px", "z-index:10000", "max-width:340px",
      "padding:10px 12px", "border-radius:6px", "background:#1d1b24", "color:#eee",
      "border:1px solid #c9a227", "box-shadow:0 2px 10px rgba(0,0,0,.5)", "font-size:13px", "line-height:1.35",
    ].join(";");
    const n = report.firstIssueCount || 0;
    el.innerHTML = `<div style="margin-bottom:8px">Battle Director: this page missed ${n} battle change${n === 1 ? "" : "s"} while it was loading (statuses, tokens or HP may look out of date).</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" data-act="later" style="width:auto;padding:2px 10px">Later</button>
        <button type="button" data-act="reload" style="width:auto;padding:2px 10px;font-weight:bold">Reload</button>
      </div>`;
    el.addEventListener("click", (ev) => {
      const act = ev.target?.closest?.("[data-act]")?.dataset?.act;
      if (act === "reload") (foundry.utils?.debouncedReload ?? (() => window.location.reload()))();
      if (act) el.remove();
    });
    document.body.appendChild(el);
  } catch (e) { warn("[late-join] GM reload toast threw", e); }
}

async function reloadWhenSettled(hostId, report) {
  // A GM page never reloads by itself (toast path only), whichever way it got here.
  if (game.user?.isGM) { offerGmReload(report); return; }
  let last = 0;
  try { last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0) || 0; } catch (_e) {}
  if (Date.now() - last < RELOAD_COOLDOWN_MS) {
    warn("[late-join] still out of sync, but this tab already reloaded for it recently — not reloading again");
    report.status = "drift-after-reload";
    return;
  }
  const t0 = Date.now();
  while (Date.now() - t0 < RELOAD_WAIT_MS) {
    let d = null;
    try { d = await askHost(hostId); } catch (_e) {}
    if (!d?.active) { report.status = "battle-ended-before-reload"; return; }
    const busy = pageBusyNow();
    report.lastBusy = busy;
    if (d.settled && !busy) {
      try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch (_e) {}
      report.status = "reload";
      log("[late-join] battle state could not be repaired in place — reloading", report);
      ui.notifications?.info("Battle Director: catching up with the battle — reloading this page.");
      (foundry.utils?.debouncedReload ?? (() => window.location.reload()))();
      return;
    }
    await sleep(2000);
  }
  report.status = "reload-gave-up";
  warn("[late-join] out of sync, and the battle never settled long enough to reload", report);
}

/** One pass against the current host. Throws HostCallError when the host can't be asked. */
async function resyncPass(report) {
  const hostId = await resolveHost();
  if (!hostId) { report.status = "no-host"; return report; }
  report.hostId = hostId;
  let lastOps = 0;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const h1 = await askHost(hostId);
    if (!h1?.active) { report.status = round === 1 ? "no-battle" : "battle-ended"; return report; }
    const i1 = compareDigests(h1, localDigest(h1));
    if (round === 1) { report.firstIssueCount = i1.length; report.firstIssues = summarize(i1); report.firstDetail = i1.slice(0, 40).map(detail); }
    if (!i1.length) { report.status = round === 1 ? "clean" : "repaired"; return report; }
    await sleep(STABLE_GAP_MS);
    const h2 = await askHost(hostId);
    if (!h2?.active) { report.status = "battle-ended"; return report; }
    const l2 = localDigest(h2);
    const i2 = compareDigests(h2, l2);
    const stable = stableIssues(i1, i2);
    const R = { round, seen: i1.length, again: i2.length, stable: stable.length, kinds: summarize(stable) };
    report.rounds.push(R);
    if (!i2.length) { report.status = "repaired"; return report; }
    if (!stable.length) continue;                          // still moving — look again

    if (game.user?.isGM) { offerGmReload(report); return report; }

    const plan = fetchPlan(stable, h2);
    R.phase = plan.phase;
    let serverScene = null;
    const serverActors = {};
    try {
      if (plan.scene) serverScene = await serverGet("Scene", h2.sceneId);
      for (const id of plan.actorIds) serverActors[id] = await serverGet("Actor", id);
    } catch (e) {
      R.fetchError = String(e?.message ?? e);
      warn("[late-join] server read failed", e);
      break;
    }
    // Rebuild the local digest NOW, synchronously after the awaited reads and
    // right before planning: an event that reached this client normally while
    // we waited on the server must not be replayed a second time.
    const l3 = localDigest(h2);
    const live = stableIssues(stable, compareDigests(h2, l3));
    R.resolvedWhileFetching = stable.length - live.length;
    const planned = planReconcile(live, {
      local: l3, sceneId: h2.sceneId, serverScene, serverActors,
      localDeltaId: (tid) => localDeltaId(h2.sceneId, tid),
    });
    const unfixable = planned.unfixable;
    const { ops, dropped } = dropExistingCreates(planned.ops, alreadyHere);
    if (dropped.length) R.droppedCreates = dropped;
    R.ops = ops.map((o) => `${o.action} ${o.type}${o.parentUuid ? ` @${o.parentUuid}` : ""} x${o.result?.length ?? 0}`);
    R.unfixable = unfixable.length;
    lastOps = ops.length;
    if (!ops.length) {
      if (!live.length || dropped.length) continue;          // caught up on its own -- look again
      // The server agrees with THIS client: the host is the one behind. Nothing to repair here.
      if (!unfixable.length) { report.status = "host-differs"; return report; }
      break;
    }
    try { await applyOps(ops, { sceneId: h2.sceneId, hostId }); }
    catch (e) { R.applyError = String(e?.message ?? e); warn("[late-join] in-place repair failed", e); break; }
    log(`[late-join] round ${round}: repaired ${ops.length} op(s)`, R);
    await sleep(AFTER_FIX_MS);
  }
  // Rounds used up, or the in-place repair could not run.
  report.lastOps = lastOps;
  await reloadWhenSettled(hostId, report);
  return report;
}

/** One resync pass. Resolves with a report; never throws. */
export async function runLateJoinResync({ startDelayMs = START_DELAY_MS, reason = "ready" } = {}) {
  if (_running) return _running;
  _running = (async () => {
    const report = { startedAt: Date.now(), reason, status: "running", rounds: [], firstIssues: null, firstIssueCount: 0 };
    _lastReport = report;
    try {
      if (!_socket || amHost()) { report.status = "skipped"; return report; }
      if (startDelayMs) await sleep(startDelayMs);
      try { return await resyncPass(report); }
      catch (e) {
        if (!(e instanceof HostCallError)) throw e;
        // One retry: the host may be mid-reload or busy for a moment.
        report.retry = { error: e.message, at: Date.now() };
        warn(`[late-join] host did not answer (${e.message}); retrying once in ${RETRY_MS} ms`);
        await sleep(RETRY_MS);
        report.rounds = [];
        try { return await resyncPass(report); }
        catch (e2) {
          if (!(e2 instanceof HostCallError)) throw e2;
          report.status = "host-unreachable";
          report.error = e2.message;
          return report;
        }
      }
    } catch (e) {
      report.status = "error";
      report.error = String(e?.message ?? e);
      warn("[late-join] resync threw", e);
      return report;
    } finally {
      report.finishedAt = Date.now();
      report.ms = report.finishedAt - report.startedAt;
      if (report.status !== "skipped" && report.status !== "no-battle" && report.status !== "no-host") log(`[late-join] ${report.status} in ${report.ms} ms`, report);
      _running = null;
    }
  })();
  return _running;
}

export function lateJoinReport() { return _lastReport; }

/** After a socket reconnect (no reload): the broadcasts sent while it was down were dropped too. */
export function resyncAfterReconnect() {
  if (!_installed) return null;
  return runLateJoinResync({ startDelayMs: RECONNECT_DELAY_MS, reason: "reconnect" }).catch((e) => warn("[late-join] reconnect resync threw", e));
}

/**
 * Register the host-side digest handler (every client: whoever hosts answers)
 * and expose the API. Call once at `ready`.
 */
export function installLateJoinResync({ getActiveDirector } = {}) {
  if (_installed) return;
  _installed = true;
  if (typeof getActiveDirector === "function") _getDirector = getActiveDirector;
  try {
    if (typeof socketlib !== "undefined" && game.modules.get("socketlib")?.active) {
      _socket = socketlib.registerModule(NS);
      _socket?.register(ACTION_DIGEST, hostDigest);
    }
  } catch (e) { warn("[late-join] socket registration failed", e); }
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.lateJoin = Object.freeze({
    run: (opts) => runLateJoinResync({ startDelayMs: 0, ...(opts ?? {}) }),
    report: lateJoinReport,
    digest: () => hostDigest({ userId: null }),
  });
}
