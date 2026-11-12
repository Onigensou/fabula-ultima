// ============================================================================
// Polymorph — core API: one actor takes on another actor's body.
//
//   FUCompanion.api.polymorph.transform(actor, form, { source, conflict })
//   FUCompanion.api.polymorph.revert(actor, { reason })
//   FUCompanion.api.polymorph.getForm(actor) / isTransformed / hasTag / listTransformed
//   FUCompanion.api.polymorph.noteTurnEnded(actor, { round })      ← Battle Director (phase 2)
//   FUCompanion.api.polymorph.noteConflictStart({ round })          ← Battle Director (phase 2)
//   FUCompanion.api.polymorph.revertAll({ reason })
//
// ARCHITECTURE — a form LAYER on the bearer, never an actor swap (WoW druid
// form / PF2e Battle Form, not dnd5e transformInto). Identity, ownership, the
// party DB roster, saves, bonds and EXP all stay keyed to the PC. The monster
// actor is a read-only template; nothing is ever written to it.
//
// The layer is two things on the bearer:
//   1. ONE Active Effect ("Polymorph: <form>") — high-priority CSB changes:
//        <attr>_base  OVERRIDE  the form's die      (bonus_<attr> statuses still apply)
//        bonus_defense / bonus_magic_defense OVERRIDE the form's offset over
//                     DEX / INS — which also drops every gear DEF/MDEF add
//        affinity_1..9 OVERRIDE the form's affinities (beats gear floors/caps)
//        max_hp / max_mp OVERRIDE own max × m
//      Flagged directorPermanent so the Battle Director's scene/turn sweeps
//      leave it alone: only revert() may end a form, because only revert()
//      carries HP/MP back.
//   2. flags.fabula-ultima-companion.polymorph — the state (form, maxima,
//      multipliers, conflict counter). Read by every consumer via getForm().
//
// RULES live in polymorph-math.js (user decisions 2026-11-12). Not here yet:
// battle action menu, token/sprite visuals (horizontal squash), party menu /
// sheet / HUD, potion item wiring — later phases.
//
// WRITES run on ONE GM (game.users.activeGM). A player call is relayed over the
// module socket; the GM checks the server-stamped sender owns the bearer.
// ============================================================================

import {
  formMultiplier, scaleIntoForm, scaleOutOfForm, newConflictCounter,
  counterOnConflictStart, tickOnTurnEnd, readFormProfile, formTags,
  AFFINITY_KEYS, ATTR_KEYS, FORM_TURNS_IN_CONFLICT,
} from "./polymorph-math.js";

const NS = "fabula-ultima-companion";
const FLAG = "polymorph";
const TAG = "[Polymorph]";
const CHANNEL = `module.${NS}`;
const T_REQ = "polymorph.req";
const T_RES = "polymorph.res";
const PRIORITY = 200;                 // above every gear/status change in the world (max seen: 90)
const MODE = { ADD: 2, OVERRIDE: 5 };

const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

const _reverting = new Set();          // actor uuids mid-revert (re-entrancy guard)
const _pending = new Map();            // socket request id → { resolve, timer }

// ── Helpers ──────────────────────────────────────────────────────────────────

function isActiveGM() {
  if (!game.user?.isGM) return false;
  const active = game.users?.activeGM ?? null;
  if (active) return active.id === game.user.id;
  const first = game.users?.filter?.((u) => u.isGM && u.active)?.sort?.((a, b) => a.id.localeCompare(b.id))?.[0];
  return first ? first.id === game.user.id : true;
}

const props = (actor) => actor?.system?.props ?? {};

/** PC vs NPC — test BOTH npc_rank and species (reference_pc_npc_discriminator). */
function isNpc(actor) {
  const p = props(actor);
  return !!(String(p.npc_rank ?? "").trim() || String(p.species ?? "").trim());
}

function isGuest(actor) {
  return !!(actor?.flags?.[NS]?.bdGuest || actor?.getFlag?.(NS, "bdGuest"));
}

async function resolveActor(ref) {
  if (!ref) return null;
  if (ref instanceof Actor) return ref;
  if (ref?.actor instanceof Actor) return ref.actor;                     // Token / TokenDocument
  const s = String(ref);
  if (s.includes(".")) {
    const doc = await fromUuid(s).catch(() => null);
    return doc instanceof Actor ? doc : (doc?.actor ?? null);
  }
  return game.actors?.get(s) ?? game.actors?.getName?.(s) ?? null;
}

/** Every actor that could carry a form: world actors + unlinked token actors. */
function allBearers() {
  const out = new Map();
  for (const a of game.actors ?? []) out.set(a.uuid, a);
  for (const sc of game.scenes ?? []) {
    for (const t of sc.tokens ?? []) if (!t.actorLink && t.actor) out.set(t.actor.uuid, t.actor);
  }
  return [...out.values()];
}

const formEffects = (actor) => (actor?.effects?.contents ?? [...(actor?.effects ?? [])])
  .filter((e) => e?.flags?.[NS]?.[FLAG] === true);

// ── Read API (any client) ────────────────────────────────────────────────────

export function getForm(actor) {
  const s = actor?.flags?.[NS]?.[FLAG];
  return s && typeof s === "object" && s.formName ? s : null;
}
export const isTransformed = (actor) => !!getForm(actor);
export function hasTag(actor, tag) {
  const f = getForm(actor);
  return !!f && (f.tags ?? []).includes(String(tag ?? "").trim().toLowerCase());
}
export const listTransformed = () => allBearers().filter(isTransformed);

// ── Effect construction ──────────────────────────────────────────────────────

// max_hp / max_mp are sheet LABELS (level + 5·MIG + …). A label override lands
// (affinity_N are labels too) — an ADD on skill_hp/skill_mp does NOT (measured
// 2026-11-12 in the runner: ignored), so the maxima are overridden outright.
function buildChanges(profile, maxHp, maxMp) {
  const ch = [];
  const ov = (key, value) => ch.push({ key, mode: MODE.OVERRIDE, priority: PRIORITY, value: String(value) });
  for (const a of ATTR_KEYS) ov(`${a}_base`, profile.attrs[a]);
  ov("bonus_defense", profile.defOffset);
  ov("bonus_magic_defense", profile.mdefOffset);
  for (const k of AFFINITY_KEYS) ov(k, profile.affinities[k]);
  ov("max_hp", maxHp);
  ov("max_mp", maxMp);
  return ch;
}

// ── transform (GM) ───────────────────────────────────────────────────────────

async function transformGM(actorRef, formRef, opts = {}) {
  const actor = await resolveActor(actorRef);
  const form = await resolveActor(formRef);
  if (!actor) return { ok: false, reason: "no-actor" };
  if (!form) return { ok: false, reason: "no-form" };
  if (isNpc(actor)) return { ok: false, reason: "bearer-not-pc" };
  if (isGuest(actor)) return { ok: false, reason: "bearer-is-guest" };
  if (!isNpc(form)) return { ok: false, reason: "form-not-monster" };
  if (actor.id === form.id) return { ok: false, reason: "same-actor" };

  // A new potion replaces the current form (never stacks).
  if (isTransformed(actor) || formEffects(actor).length) await revertGM(actor, { reason: "replaced", quiet: true });

  const p = props(actor);
  const own = {
    maxHp: num(p.max_hp), maxMp: num(p.max_mp),
    curHp: num(p.current_hp), curMp: num(p.current_mp),
    attrs: Object.fromEntries(ATTR_KEYS.map((a) => [a, num(p[`${a}_base`])])),
  };
  if (own.maxHp <= 0) return { ok: false, reason: "bearer-has-no-hp" };
  if (own.curHp <= 0) return { ok: false, reason: "bearer-knocked-out" };

  const profile = readFormProfile(props(form));
  const m = { hp: formMultiplier(own.maxHp, profile.maxHp), mp: formMultiplier(own.maxMp, profile.maxMp) };
  const hp = scaleIntoForm(own.curHp, own.maxHp, m.hp);
  const mp = scaleIntoForm(own.curMp, own.maxMp, m.mp);

  const changes = buildChanges(profile, hp.max, mp.max);

  const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: `Polymorph: ${form.name}`,
    img: form.img || "icons/svg/mystery-man.svg",
    origin: opts.sourceUuid ?? form.uuid,
    disabled: false,
    transfer: false,
    changes,
    description: `Transformed into ${form.name}. Lasts until the end of the scene or your next ${FORM_TURNS_IN_CONFLICT} turns during a conflict.`,
    flags: { [NS]: { [FLAG]: true, directorPermanent: true, formActorUuid: form.uuid } },
  }]);
  if (!effect) return { ok: false, reason: "effect-create-failed" };

  const gotMax = { hp: num(props(actor).max_hp), mp: num(props(actor).max_mp) };
  if (gotMax.hp !== hp.max || gotMax.mp !== mp.max) {
    warn(`max did not land for ${actor.name}: HP ${gotMax.hp}/${hp.max}, MP ${gotMax.mp}/${mp.max} — using what landed`);
  }
  const formMax = { hp: gotMax.hp || hp.max, mp: gotMax.mp || mp.max };

  const c = opts.conflict;
  const state = {
    formActorUuid: form.uuid,
    formName: form.name,
    formImg: form.img ?? null,
    formTokenImg: form.prototypeToken?.texture?.src ?? null,
    tags: formTags(form.flags?.[NS]?.polymorphTags, profile.species),
    species: profile.species,
    effectId: effect.id,
    sourceUuid: opts.sourceUuid ?? null,
    sceneId: canvas?.scene?.id ?? game.scenes?.active?.id ?? null,
    appliedAt: Date.now(),
    m,
    own: { maxHp: own.maxHp, maxMp: own.maxMp },
    form: { maxHp: formMax.hp, maxMp: formMax.mp },
    counter: c ? newConflictCounter({ round: c.round, bearerActedOrActing: !!c.bearerActedOrActing }) : null,
  };

  await actor.update({
    "system.props.current_hp": Math.min(hp.cur, formMax.hp),
    "system.props.current_mp": Math.min(mp.cur, formMax.mp),
    [`flags.${NS}.${FLAG}`]: state,
  });

  log(`${actor.name} → ${form.name}: HP ${own.curHp}/${own.maxHp} → ${hp.cur}/${formMax.hp} (×${m.hp}), MP ${own.curMp}/${own.maxMp} → ${mp.cur}/${formMax.mp} (×${m.mp})`);
  Hooks.callAll("fuPolymorphTransformed", { actorUuid: actor.uuid, form: state });
  return { ok: true, actorUuid: actor.uuid, form: state };
}

// ── revert (GM) ──────────────────────────────────────────────────────────────

async function revertGM(actorRef, { reason = "voluntary", quiet = false } = {}) {
  const actor = await resolveActor(actorRef);
  if (!actor) return { ok: false, reason: "no-actor" };
  if (_reverting.has(actor.uuid)) return { ok: true, reason: "already-reverting" };
  const state = getForm(actor);
  const strays = formEffects(actor);
  if (!state && !strays.length) return { ok: true, reason: "not-transformed" };

  _reverting.add(actor.uuid);
  try {
    const p = props(actor);
    const formCur = { hp: num(p.current_hp), mp: num(p.current_mp) };
    if (strays.length) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", strays.map((e) => e.id), { fuNoFollowup: true });
    }
    const update = { [`flags.${NS}.-=${FLAG}`]: null };
    let hpBack = null, mpBack = null;
    if (state) {
      hpBack = scaleOutOfForm(formCur.hp, state.form?.maxHp, state.own?.maxHp);
      mpBack = scaleOutOfForm(formCur.mp, state.form?.maxMp, state.own?.maxMp);
      update["system.props.current_hp"] = hpBack;
      update["system.props.current_mp"] = mpBack;
    }
    await actor.update(update);
    if (state) log(`${actor.name} reverted from ${state.formName} (${reason}): HP ${formCur.hp}/${state.form?.maxHp} → ${hpBack}/${state.own?.maxHp}, MP → ${mpBack}/${state.own?.maxMp}`);
    if (!quiet) Hooks.callAll("fuPolymorphReverted", { actorUuid: actor.uuid, reason, form: state });
    return { ok: true, actorUuid: actor.uuid, reason, hp: hpBack, mp: mpBack };
  } finally {
    _reverting.delete(actor.uuid);
  }
}

async function revertAllGM({ reason = "scene" } = {}) {
  const list = listTransformed();
  const out = [];
  for (const a of list) out.push(await revertGM(a, { reason }));
  if (list.length) log(`revertAll(${reason}): ${list.length} form(s) ended`);
  return { ok: true, count: list.length, results: out };
}

// ── Conflict turn counting (called by the Battle Director in phase 2) ───────

async function noteTurnEndedGM(actorRef, { round } = {}) {
  const actor = await resolveActor(actorRef);
  const state = getForm(actor);
  if (!state) return { ok: true, reason: "not-transformed" };
  const base = state.counter ?? counterOnConflictStart({ round });
  const { counter, ticked, expired } = tickOnTurnEnd(base, round);
  if (expired) return { ...(await revertGM(actor, { reason: "turns" })), ticked, expired };
  if (ticked || !state.counter) await actor.update({ [`flags.${NS}.${FLAG}.counter`]: counter });
  return { ok: true, ticked, expired, turnsLeft: counter.turnsLeft };
}

async function noteConflictStartGM({ round = 1 } = {}) {
  let n = 0;
  for (const a of listTransformed()) {
    if (getForm(a)?.counter) continue;
    await a.update({ [`flags.${NS}.${FLAG}.counter`]: counterOnConflictStart({ round }) });
    n++;
  }
  return { ok: true, armed: n };
}

// ── GM relay ─────────────────────────────────────────────────────────────────

const OPS = {
  transform: (args) => transformGM(args.actor, args.form, args.opts ?? {}),
  revert: (args) => revertGM(args.actor, args.opts ?? {}),
  revertAll: (args) => revertAllGM(args.opts ?? {}),
  noteTurnEnded: (args) => noteTurnEndedGM(args.actor, args.opts ?? {}),
  noteConflictStart: (args) => noteConflictStartGM(args.opts ?? {}),
};

/** A player may transform / revert only an actor they own. Everything else is GM-only. */
async function authorize(op, args, senderId) {
  const user = game.users?.get(senderId);
  if (!user) return false;
  if (user.isGM) return true;
  if (op !== "transform" && op !== "revert") return false;
  const actor = await resolveActor(args.actor);
  return !!actor?.testUserPermission?.(user, "OWNER");
}

async function run(op, args) {
  if (isActiveGM()) return OPS[op](args);
  const id = foundry.utils.randomID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { _pending.delete(id); resolve({ ok: false, reason: "gm-timeout" }); }, 15000);
    _pending.set(id, { resolve, timer });
    game.socket.emit(CHANNEL, { type: T_REQ, id, fromUserId: game.user.id, op, args: serializeArgs(args) });
  });
}

/** Documents do not survive the socket; send uuids. */
function serializeArgs(args) {
  const toRef = (v) => (v?.uuid ? v.uuid : v);
  return { ...args, actor: toRef(args.actor), form: toRef(args.form) };
}

function onSocket(msg, senderId) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === T_REQ) {
    if (!isActiveGM() || !OPS[msg.op]) return;
    (async () => {
      let result;
      try {
        result = (await authorize(msg.op, msg.args ?? {}, senderId ?? msg.fromUserId))
          ? await OPS[msg.op](msg.args ?? {})
          : { ok: false, reason: "not-permitted" };
      } catch (e) { warn(`relay ${msg.op} threw`, e); result = { ok: false, reason: "exception" }; }
      game.socket.emit(CHANNEL, { type: T_RES, id: msg.id, toUserId: msg.fromUserId, result });
    })();
  } else if (msg.type === T_RES && msg.toUserId === game.user?.id) {
    const p = _pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer); _pending.delete(msg.id); p.resolve(msg.result);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export const transform = (actor, form, opts = {}) => run("transform", { actor, form, opts });
export const revert = (actor, opts = {}) => run("revert", { actor, opts });
export const revertAll = (opts = {}) => run("revertAll", { opts });
export const noteTurnEnded = (actor, opts = {}) => run("noteTurnEnded", { actor, opts });
export const noteConflictStart = (opts = {}) => run("noteConflictStart", { opts });

const API = Object.freeze({
  transform, revert, revertAll, getForm, isTransformed, hasTag, listTransformed,
  noteTurnEnded, noteConflictStart,
});

// ── Wiring ───────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.polymorph = API;
  const mod = game.modules.get(NS);
  if (mod) { mod.api = mod.api || {}; mod.api.polymorph = API; }

  game.socket.on(CHANNEL, onSocket);

  // "Until the end of the scene" = until the GM ACTIVATES a map (the same
  // signal the Area Name Panel uses). Viewing / navigating does not end it.
  // Entering a battle activates the battle map, so it ends a form too — the
  // intended "no pre-buffing" rule.
  Hooks.on("updateScene", (scene, changes) => {
    if (changes?.active !== true || !isActiveGM()) return;
    revertAllGM({ reason: "scene" }).catch((e) => warn("scene revert failed", e));
  });

  // Something other than revert() removed the form effect (effects panel, a GM
  // delete, a cleanup sweep): still carry HP/MP back and clear the state.
  Hooks.on("deleteActiveEffect", (effect) => {
    if (effect?.flags?.[NS]?.[FLAG] !== true || !isActiveGM()) return;
    const actor = effect.parent;
    if (!(actor instanceof Actor) || _reverting.has(actor.uuid) || !getForm(actor)) return;
    revertGM(actor, { reason: "effect-removed" }).catch((e) => warn("effect-removed revert failed", e));
  });

  // Knocked out in form → the form ends; the bearer stays at 0 (normal KO /
  // Surrender rules take it from there).
  Hooks.on("updateActor", (actor, changes) => {
    const hp = changes?.system?.props?.current_hp;
    if (hp === undefined || num(hp) > 0 || !isActiveGM()) return;
    if (!getForm(actor) || _reverting.has(actor.uuid)) return;
    revertGM(actor, { reason: "ko" }).catch((e) => warn("ko revert failed", e));
  });

  log("ready");
});
