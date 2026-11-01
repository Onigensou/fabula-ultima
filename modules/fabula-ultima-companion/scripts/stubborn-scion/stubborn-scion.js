// scripts/stubborn-scion/stubborn-scion.js
//
// STUBBORN SCION (Quirk): two bodyguards share one Fatigue pool, the
// "Bodyguard Fatigue" AE on the holder (flags.<ns>.charges). Each benefit adds
// 1d6 Fatigue; at 10 or more the bodyguards can't help. Fatigue itself has no
// ceiling (user, 2026-11-01): it can climb past 10, and 1d6 comes off at the
// start of each session (the AE's own session_started row).
//
// The three benefits:
//   1. "Be careful!" (halve damage you suffer) and
//   3. "Stay down, I'll take care of this!" (a shard you create deals extra
//      damage) are reaction rows on the Stubborn Scion skill's transfer AEs.
//   2. "Here is the information you previously requested" (ask the GM one
//      question during a Rest) lives HERE: a camp button, like Upgrade and
//      Inner Wellspring, shown only to the holder at camp before the party
//      sleeps. Once per rest. The GM rolls the 1d6, adds it to the pool and
//      posts the moment to chat; the question itself is asked at the table.
//
// Holder state: flags.<ns>.stubbornScion = { askedAt } while this rest's
// question is spent; fabula.restPerformed clears it. Every write goes through
// the primary GM over a socket.

const TAG = "[StubbornScion]";
const CHANNEL = "module.fabula-ultima-companion";
export const FLAG_NS = "fabula-ultima-companion";
export const SKILL_NAME = "Stubborn Scion";
export const FATIGUE_AE = "Bodyguard Fatigue";
export const FATIGUE_LOCK = 10;
export const SCION_FLAG = "stubbornScion";
export const SCION_MSG = Object.freeze({ REQ: "stubbornScion:req", RES: "stubbornScion:res" });
const TIMEOUT_MS = 15000;
const OPEN_PHASES = ["free_roam", "sleep_lobby"];

const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const lower = (v) => String(v ?? "").trim().toLowerCase();

export const hasStubbornScion = (actor) => !!actor?.items?.some?.((i) => lower(i.name) === lower(SKILL_NAME));

// The pool, summed like AE_CHARGES_BODYGUARD_FATIGUE reads it (enabled AEs of that name).
export const fatigueEffects = (actor) => Array.from(actor?.effects ?? [])
  .filter((e) => !e.disabled && lower(e.name) === lower(FATIGUE_AE));
export const readFatigue = (actor) => fatigueEffects(actor)
  .reduce((s, e) => s + (Number(e.flags?.[FLAG_NS]?.charges ?? 0) || 0), 0);
export const askedThisRest = (actor) => !!actor?.flags?.[FLAG_NS]?.[SCION_FLAG]?.askedAt;

export const campPhase = () => globalThis.CampSystem?.State?.getPhase?.() ?? null;
// Open = the party is at camp (the ACTIVE scene) and hasn't gone to sleep yet.
export const scionCampOpen = () => OPEN_PHASES.includes(campPhase())
  && game.scenes?.active?.flags?.[FLAG_NS]?.oniFabula?.general?.sceneMode === "camp";

/** Why the question can't be asked right now, or null if it can. */
export function askBlocker(actor) {
  if (!hasStubbornScion(actor)) return "no_skill";
  if (!fatigueEffects(actor).length) return "no_pool";
  if (askedThisRest(actor)) return "already_asked";
  if (readFatigue(actor) >= FATIGUE_LOCK) return "exhausted";
  return null;
}

export function scionFailText(r, actor = null) {
  switch (r?.reason) {
    case "already_asked": return "You've already asked your question this rest.";
    case "exhausted": return `Your bodyguards are too tired to help (${r.fatigue ?? readFatigue(actor)} Fatigue; they need less than ${FATIGUE_LOCK}).`;
    case "no_pool": return `No "${FATIGUE_AE}" effect on this character. The GM needs to add it.`;
    case "not_now": return "Ask at camp, before the party sleeps.";
    case "no_skill": return "That takes the Stubborn Scion quirk.";
    case "not_your_character": return "You can only ask for your own character.";
    case "no_gm": return "This needs a GM online.";
    case "timeout": return "No answer from the GM. Try again in a moment.";
    default: return `That didn't work (${r?.reason ?? "unknown"}).`;
  }
}

// Add `amount` to the pool (no ceiling). Same write as adjust_charges: the first
// AE holds the total, duplicates fold into it, a visible counter badge follows.
async function addFatigue(actor, amount) {
  const effs = fatigueEffects(actor);
  const from = readFatigue(actor);
  const to = Math.max(0, from + amount);
  const primary = effs[0];
  const upd = { [`flags.${FLAG_NS}.charges`]: to };
  if (primary.flags?.statuscounter?.visible === true) upd["flags.statuscounter.value"] = to;
  await primary.update(upd);
  if (effs.length > 1) await actor.deleteEmbeddedDocuments("ActiveEffect", effs.slice(1).map((e) => e.id));
  return { from, to };
}

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── GM side ──────────────────────────────────────────────────────────────────
// Holders with an ask in flight. Checked and set before the first await: the
// asked flag only lands after setFlag's server round-trip, so a retry after a
// timeout (or a second tab) would otherwise pass askBlocker and roll twice.
const _inFlight = new Set();
export async function executeScionOp({ op, holderUuid, requesterUserId = null } = {}) {
  const key = String(holderUuid ?? "");
  if (_inFlight.has(key)) return fail("already_asked");
  _inFlight.add(key);
  try {
    const holder = await fromUuid(String(holderUuid ?? "")).catch(() => null);
    if (!holder || holder.documentName !== "Actor") return fail("holder_not_found");
    const requester = requesterUserId ? game.users.get(requesterUserId) : game.user;
    if (requester && !requester.isGM && !holder.testUserPermission(requester, "OWNER")) return fail("not_your_character");
    if (op !== "ask") return fail("bad_op");
    if (!scionCampOpen()) return fail("not_now");
    const blocked = askBlocker(holder);
    if (blocked) return fail(blocked, { fatigue: readFatigue(holder) });

    // Spend the question before rolling (the in-flight set covers the round-trip).
    await holder.setFlag(FLAG_NS, SCION_FLAG, { askedAt: Date.now() });
    const roll = await new Roll("1d6").evaluate();
    const { from, to } = await addFatigue(holder, roll.total);
    const spent = to >= FATIGUE_LOCK;
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: holder }),
      flavor: `<div class="fu-scion-ask">`
        + `<p><strong>${esc(SKILL_NAME)}: "Here is the information you previously requested."</strong></p>`
        + `<p>${esc(holder.name)} asks the GM one question, and the GM answers truthfully.</p>`
        + `<p>Bodyguard Fatigue: ${from} → <strong>${to}</strong>${spent ? ` (${FATIGUE_LOCK}+: the bodyguards can't help until they recover)` : ""}.</p>`
        + `</div>`,
    });
    console.debug(TAG, "asked", holder.name, `${from} → ${to}`);
    return { ok: true, op, rolled: roll.total, from, to };
  } catch (e) {
    console.error(TAG, "executeScionOp failed", e);
    return fail("error", { message: String(e?.message ?? e) });
  } finally {
    _inFlight.delete(key);
  }
}

// Rest complete: every rested holder gets their question back.
export async function resetAtRest(actors = []) {
  const reset = [];
  for (const holder of actors) {
    if (!askedThisRest(holder)) continue;
    await holder.unsetFlag(FLAG_NS, SCION_FLAG);
    reset.push(holder.name);
  }
  if (reset.length) console.debug(TAG, "rest: question back for", reset.join(", "));
  return reset;
}

function onRestPerformed(actors) {
  if (!isPrimaryGM()) return;
  resetAtRest(Array.isArray(actors) ? actors : []).catch((e) => console.error(TAG, "resetAtRest", e));
}

// ── Client side ──────────────────────────────────────────────────────────────
const _reqs = new Map();
export function requestScion(op, data = {}) {
  if (isPrimaryGM()) return executeScionOp({ op, ...data, requesterUserId: game.user.id });
  if (!game.users?.activeGM && !game.users?.some?.((u) => u.isGM && u.active)) return Promise.resolve(fail("no_gm"));
  const reqId = foundry.utils.randomID();
  return new Promise((resolve) => {
    _reqs.set(reqId, resolve);
    game.socket.emit(CHANNEL, { type: SCION_MSG.REQ, payload: { reqId, op, ...data, requesterUserId: game.user.id } });
    setTimeout(() => { if (_reqs.delete(reqId)) resolve(fail("timeout")); }, TIMEOUT_MS);
  });
}

function onSocket(msg) {
  if (msg?.type === SCION_MSG.REQ) {
    if (!isPrimaryGM()) return;
    const { reqId, ...req } = msg.payload ?? {};
    executeScionOp(req)
      .catch((e) => fail("server_error", { message: String(e?.message ?? e) }))
      .then((r) => game.socket.emit(CHANNEL, { type: SCION_MSG.RES, payload: { reqId, toUserId: req.requesterUserId, ...r } }));
    return;
  }
  if (msg?.type === SCION_MSG.RES) {
    const { reqId, toUserId, ...rest } = msg.payload ?? {};
    if (toUserId && toUserId !== game.user.id) return;
    const resolve = _reqs.get(reqId);
    if (!resolve) return;
    _reqs.delete(reqId);
    resolve(rest);
  }
}

let _installed = false;
export function installStubbornScion() {
  if (_installed) return;
  _installed = true;
  game.socket.on(CHANNEL, onSocket);
  Hooks.on("fabula.restPerformed", onRestPerformed);
}
