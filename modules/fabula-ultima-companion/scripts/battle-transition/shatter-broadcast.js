// ============================================================================
// Battle shatter — the all-clients side.
//
// The GM-side director calls beginBattleShatter() at the start of PREP. Every
// client (GM included) then freezes ITS OWN canvas, cracks it, and holds the
// cracked frame while its canvas swaps to the battle scene behind it (players
// follow the world's active scene; the GM views it). The glass breaks when the
// GM releases it — after tokens are spawned, assets preloaded and the rest
// framing settled, the moment the old curtain dropped — AND that client's own
// battlefield is drawn. Breaking earlier would show the framing settle and the
// spawn behind the glass.
//
//   const sh = beginBattleShatter({ battleScene, payload });
//   await sh.frozen;          // GM's cracked frame is up: safe to swap scenes
//   ... activate + view + spawn + preload ...
//   sh.release();             // every client: break the glass
//   await sh.done;            // GM's own glass has cleared
//
// Transport: socketlib, the module's shared socket (same pattern as
// director-sfx.js). Classic black-curtain path stays in director-init.js for
// when the world setting picks it, the window is hidden, or lean mode.
// ============================================================================

import { playShatterTransition, resolveShatterCast, preloadShatterCast, shatterDebugSpeed } from "./shatter-transition.js";
import { playSfx, preloadSfx } from "../battle-director/director-sfx.js";
import { BATTLE_TRANSITION_SFX_URL, BATTLE_CRACK_SFX_URL } from "../battle-director/director-vfx.js";

const MODULE_ID = "fabula-ultima-companion";
const TAG = "[FU Shatter]";
const ACTION_START = "FU_SHATTER_START";
const ACTION_RELEASE = "FU_SHATTER_RELEASE";
export const BATTLE_TRANSITION_SETTING = "battleStartTransition";
// a client never waits longer than this for its battle scene, or for the GM's release
const SCENE_WAIT_MS = 15000;
// the cracked frame breaks anyway after this (the director's own preload watchdog is 20 s; a cold
// load measured 24 s on a software-GL client)
const RELEASE_WAIT_MS = 45000;
// each client plays these at its own moments: the crack at its impact, the sting when its glass breaks
const SFX = { crack: { url: BATTLE_CRACK_SFX_URL, vol: 0.5 }, shatter: { url: BATTLE_TRANSITION_SFX_URL, vol: 0.2 } };
const cue = (k) => { try { playSfx(SFX[k].url, SFX[k].vol); } catch (e) { console.warn(TAG, "sfx failed", e); } };

let _socket = null;
const sessions = new Map();   // id -> { release() }
const gmReleases = new Map(); // id -> release() for every client, GM side

/** "shatter" (default) or "classic" (Sequencer crack + black curtain). */
export function battleTransitionMode() {
  try { return game.settings.get(MODULE_ID, BATTLE_TRANSITION_SETTING) || "shatter"; } catch { return "shatter"; }
}

// resolves once this client's canvas is drawn on sceneId (or after a timeout)
function waitForScene(sceneId, timeoutMs = SCENE_WAIT_MS) {
  const onIt = () => !!(canvas?.ready && canvas.scene?.id === sceneId && !canvas.loading);
  if (onIt()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false, hookId = null;
    const finish = (ok) => {
      if (done) return; done = true;
      try { Hooks.off("canvasReady", hookId); } catch { /* gone */ }
      clearTimeout(timer);
      resolve(ok);
    };
    hookId = Hooks.on("canvasReady", () => { if (canvas.scene?.id === sceneId) finish(true); });
    const timer = setTimeout(() => { console.warn(TAG, `battle scene not drawn after ${timeoutMs} ms; breaking the glass anyway`); finish(false); }, timeoutMs);
  });
}

// Run the shatter on THIS client. Returns { frozen, ending, done }: frozen resolves when the cracked
// frame is up (or straight away when this client skips the effect), ending as the glass is finishing,
// done when it has cleared.
function startLocal({ id, sceneId, cast }) {
  let release;
  const released = new Promise((r) => { release = r; });
  const timer = setTimeout(() => { console.warn(TAG, "no release from the GM; clearing the glass"); release(); }, RELEASE_WAIT_MS);
  sessions.set(id, { release: () => { clearTimeout(timer); release(); } });
  let frozenOk, endingOk;
  const frozen = new Promise((r) => { frozenOk = r; });
  const ending = new Promise((r) => { endingOk = r; });
  // a hidden tab draws nothing: skip the effect (it would only queue work for when it returns), but
  // keep the cues so the battle still announces itself
  if (globalThis.FUCompanion?.api?.vfxSuppressed?.()) {
    frozenOk(false); cue("crack");
    const done = released.then(() => cue("shatter")).finally(() => { sessions.delete(id); endingOk(); });
    return { frozen, ending, done };
  }
  const done = playShatterTransition({
    load: () => Promise.all([waitForScene(sceneId), released]),
    cast,
    onPhase: (n) => {
      if (n === "impact") cue("crack");
      if (n === "cut" || n === "skip") cue("shatter");
      if (n === "hold" || n === "skip" || n === "done") frozenOk(n === "hold");
      if (n === "ending" || n === "skip" || n === "done") endingOk();
    },
  }).catch((e) => console.error(TAG, "shatter failed", e))
    .finally(() => { clearTimeout(timer); sessions.delete(id); frozenOk(false); endingOk(); });
  return { frozen, ending, done };
}

/** Cut-in cast for the battle: the payload's party members, with their cut_in_critical art. */
function castFromPayload(payload) {
  const members = Array.isArray(payload?.party?.members) ? payload.party.members : [];
  const actors = members.map((m) => {
    try { return m?.actorUuid ? fromUuidSync(m.actorUuid) : (m?.actorId ? game.actors.get(m.actorId) : null); } catch { return null; }
  }).filter((a) => a && !a.pack);
  // plain records: they travel over the socket
  return resolveShatterCast(actors).map((c) => ({ slot: c.slot, name: c.name, src: c.src, focus: c.focus, at: c.at, h: c.h, lean: c.lean, fade: c.fade }));
}

/**
 * GM: start the shatter on every client. Returns { frozen, release, done } (see the header).
 * Never throws; with no socket the GM still plays it locally.
 */
export function beginBattleShatter({ battleScene, payload } = {}) {
  const id = foundry.utils.randomID();
  const sceneId = battleScene?.id ?? null;
  let cast = [];
  try { cast = castFromPayload(payload); } catch (e) { console.warn(TAG, "cast resolve failed", e); }
  try { _socket?.executeForOthers?.(ACTION_START, { id, sceneId, cast }); }
  catch (e) { console.warn(TAG, "broadcast start failed", e); }
  const local = startLocal({ id, sceneId, cast });
  let released = false;
  const release = () => {
    if (released) return; released = true;
    gmReleases.delete(id);
    try { _socket?.executeForOthers?.(ACTION_RELEASE, { id }); } catch (e) { console.warn(TAG, "broadcast release failed", e); }
    sessions.get(id)?.release();
  };
  gmReleases.set(id, release);
  // the director waits on `ending` before the entrance: never longer than the glass needs (~2.5 s)
  const cap = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 6000 * shatterDebugSpeed()))]);
  return { id, frozen: local.frozen, ending: cap(local.ending), done: cap(local.done), release };
}

/** GM: release every shatter still hanging (a failed prep). */
export function releaseActiveShatters() {
  for (const r of [...gmReleases.values()]) r();
}

/** Warm the current party's cut-in art on this client (boot, idle). */
async function preloadPartyCast() {
  const res = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
  const props = res?.db?.system?.props ?? {};
  const actors = [];
  for (let i = 1; i <= 4; i++) {
    const raw = String(props[`member_id_${i}`] ?? "").trim().replace(/^Actor\./i, "");
    const a = raw ? game.actors.get(raw) : null;
    if (a) actors.push(a);
  }
  await preloadShatterCast(resolveShatterCast(actors));
}

/** Register the socket handlers and settings hooks (every client, on ready). */
export function initShatterBroadcast() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      console.warn(TAG, "socketlib unavailable; the shatter plays on the GM only");
    } else {
      _socket = socketlib.registerModule(MODULE_ID);
      _socket.register(ACTION_START, (data = {}) => { if (data.id && !sessions.has(data.id)) startLocal(data); });
      _socket.register(ACTION_RELEASE, ({ id } = {}) => sessions.get(id)?.release());
    }
  } catch (e) { console.warn(TAG, "socket init failed", e); }
  // Warm the transition's cues and the party's cut-in art now, at boot, so the first battle of the
  // session plays them on time (decodeAudioData works before any user gesture). Re-warm the art
  // when the party changes.
  preloadSfx([SFX.crack.url, SFX.shatter.url]).catch((e) => console.debug(TAG, "sfx preload failed", e));
  preloadPartyCast().catch((e) => console.debug(TAG, "cast preload skipped", e));
  Hooks.on("updateActor", (actor, change) => {
    if (!foundry.utils.hasProperty(change, "system.props")) return;
    const p = change.system.props;
    if (Object.keys(p).some((k) => /^member_id_\d$/.test(k) || k === "cut_in_critical")) preloadPartyCast().catch(() => {});
  });
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, BATTLE_TRANSITION_SETTING, {
    name: "Battle start transition",
    hint: "Shatter: the field freezes, cracks and breaks into shards carrying the party's cut-ins. Classic: the orange crack and black curtain.",
    scope: "world",
    config: true,
    type: String,
    choices: { shatter: "Shatter", classic: "Classic (crack + curtain)" },
    default: "shatter",
  });
});
