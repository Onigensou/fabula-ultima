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
import { broadcastSquash, SQUASH_OUT_MS } from "./polymorph-fx.js";
import { formNameForItem, isPolymorphPotion, findFormActor } from "./polymorph-potions.js";
import "./polymorph-ui.js";   // Form Plate (HUD) + sheet banner — side-effect module

// Sheet art the sprite systems read OFF THE ACTOR (battler-pose-rules POSES →
// sprite_<pose>; sprite-facing-runtime DIR_FIELDS walk/stand; camp poses). The
// form overrides every one with the monster's own value or "" — blank falls
// back to the token image, which is the form's art. Without this a transformed
// PC would flash its own walk/attack/hurt sprites.
const SPRITE_PROP_KEYS = Object.freeze([
  "sprite_idle", "sprite_hurt", "sprite_ko", "sprite_crisis", "sprite_guard",
  "sprite_attack", "sprite_cast", "sprite_leap", "sprite_fly",
  "sprite_standard", "sprite_walk",
  "sprite_walk_down", "sprite_stand_down", "sprite_walk_left", "sprite_stand_left",
  "sprite_walk_up_left", "sprite_stand_up_left", "sprite_walk_up", "sprite_stand_up",
  "sprite_sit", "sprite_sleep", "sprite_onsen",
]);

const NS = "fabula-ultima-companion";
const FLAG = "polymorph";
const TAG = "[Polymorph]";
const CHANNEL = `module.${NS}`;
const T_REQ = "polymorph.req";
const T_RES = "polymorph.res";
const PRIORITY = 200;                 // above every gear/status change in the world (max seen: 90)
const MODE = { CUSTOM: 0, ADD: 2, OVERRIDE: 5 };
export const REVERT_OBJECTIVE_ID = "revert_form";

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

/** Prop keys the Form effect writes (bare CSB keys, e.g. "dex_base"). */
function formOverriddenKeys(actor) {
  const out = new Set();
  for (const e of formEffects(actor)) {
    for (const c of e.changes ?? []) {
      if (c?.mode === MODE.CUSTOM) continue;
      const k = String(c?.key ?? "").replace(/^system\.props\./, "").trim();
      if (k) out.add(k);
    }
  }
  return out;
}

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
function buildChanges(profile, maxHp, maxMp, formProps = {}) {
  const ch = [];
  const ov = (key, value) => ch.push({ key, mode: MODE.OVERRIDE, priority: PRIORITY, value: String(value) });
  for (const k of SPRITE_PROP_KEYS) ov(k, String(formProps?.[k] ?? "").trim());
  for (const a of ATTR_KEYS) ov(`${a}_base`, profile.attrs[a]);
  ov("bonus_defense", profile.defOffset);
  ov("bonus_magic_defense", profile.mdefOffset);
  for (const k of AFFINITY_KEYS) ov(k, profile.affinities[k]);
  ov("max_hp", maxHp);
  ov("max_mp", maxMp);
  // The free "Revert" Objective is grant-only (objectiveScope "none"); the form
  // grants it to its bearer. CUSTOM mode: the objectives reader reads the row,
  // CSB writes nothing.
  ch.push({ key: "grant_objective", mode: MODE.CUSTOM, priority: PRIORITY, value: REVERT_OBJECTIVE_ID });
  return ch;
}

// ── Form items ───────────────────────────────────────────────────────────────
// The form's kit is COPIED onto the bearer (dnd5e Wild Shape style): every
// Battle Director path — cost, cooldown, formulas, reactions — then runs on the
// bearer's own items, and nothing is ever written to the monster template.
// Removed again on revert. Skipped: items without a skill_type (gear, loot) and
// anything tagged `no_polymorph` (boss phases, stances, clocks that only make
// sense on the real monster) — as a prop, a skill_tags entry or a flag.

const formItems = (actor) => (actor?.items?.contents ?? []).filter((i) => i?.flags?.[NS]?.polymorphItem === true);

function excludedFromForm(item) {
  const p = item?.system?.props ?? {};
  if (p.no_polymorph === true || String(p.no_polymorph ?? "").trim().toLowerCase() === "true") return true;
  if (item?.flags?.[NS]?.noPolymorph === true) return true;
  const tags = String(p.skill_tags ?? "").split(/[\s,]+/).map((t) => t.trim().toLowerCase());
  return tags.includes("no_polymorph");
}

async function copyFormItems(actor, form) {
  const taken = new Set((actor.items?.contents ?? []).map((i) => i.id));
  const keep = [], fresh = [];
  for (const it of form.items?.contents ?? []) {
    if (!String(it.system?.props?.skill_type ?? "").trim()) continue;
    if (excludedFromForm(it)) continue;
    const data = it.toObject();
    data.flags = foundry.utils.mergeObject(data.flags ?? {}, {
      [NS]: { polymorphItem: true, polymorphSourceUuid: it.uuid },
    });
    // Keep ids so container links between the form's own items survive the copy;
    // a (vanishingly rare) id clash with the bearer's items gets a fresh id.
    (taken.has(it.id) ? fresh : keep).push(data);
    if (taken.has(it.id)) delete data._id;
  }
  const made = [];
  if (keep.length) made.push(...(await actor.createEmbeddedDocuments("Item", keep, { keepId: true })));
  if (fresh.length) made.push(...(await actor.createEmbeddedDocuments("Item", fresh)));
  return made.length;
}

// ── Live conflict context ────────────────────────────────────────────────────
// A form that starts mid-battle needs the round and "has the bearer already
// acted / is acting this round" (drink turn excluded). Read off the live
// Battle Director: the current combatant, or a phaseLock stamped this round
// (set on a creature's first turn of the round).
function liveConflictFor(actor) {
  try {
    const d = globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.();
    const dc = d?.dCombat;
    if (!dc || dc.ended) return null;
    const round = Number(dc.round ?? 0);
    const c = (dc.combatants ?? []).find((x) => x?.actorUuid === actor.uuid
      || x?.tokenDoc?.actor?.uuid === actor.uuid || (x?.actorId && x.actorId === actor.id));
    if (!c) return { round, bearerActedOrActing: false };
    const acting = dc.current === c || dc.current?.id === c.id;
    const acted = c.phaseLock?.round === round;
    return { round, bearerActedOrActing: !!(acting || acted) };
  } catch (e) { warn("liveConflictFor failed", e); return null; }
}

// ── Token art ────────────────────────────────────────────────────────────────
// Modes with a token on screen: the token takes the form's art. The FOOTPRINT
// (width/height) stays the bearer's, so dungeon pathing / walls / formation are
// untouched; the texture scale absorbs the size difference, so a 2×2 monster
// still LOOKS 2×2. The facing sign (mirrored scaleX) is kept. Originals are
// stored in the state and restored on revert. Theatre mode has no token: the
// party menu / sheet carry the form there.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tokensOf(actor) {
  const out = [];
  const scenes = new Set([canvas?.scene, game.scenes?.active].filter(Boolean));
  for (const sc of scenes) {
    for (const t of sc.tokens ?? []) {
      const mine = t.actorLink ? t.actorId === actor.id : t.actor?.uuid === actor.uuid;
      if (mine) out.push(t);
    }
  }
  return out;
}

function formTextureFor(token, form) {
  const pt = form.prototypeToken ?? {};
  const src = pt.texture?.src || form.img;
  if (!src) return null;
  const sign = Math.sign(Number(token.texture?.scaleX ?? 1)) || 1;
  const kx = Math.abs(Number(pt.texture?.scaleX ?? 1)) || 1;
  const ky = Math.abs(Number(pt.texture?.scaleY ?? 1)) || 1;
  const fw = Number(pt.width ?? 1) || 1, fh = Number(pt.height ?? 1) || 1;
  const tw = Number(token.width ?? 1) || 1, th = Number(token.height ?? 1) || 1;
  return { src, scaleX: sign * kx * (fw / tw), scaleY: ky * (fh / th) };
}

async function writeTokenArt(updates) {
  const byScene = new Map();
  for (const u of updates) {
    const sc = u.token?.parent;
    if (!sc) continue;
    if (!byScene.has(sc)) byScene.set(sc, []);
    byScene.get(sc).push({ _id: u.token.id, "texture.src": u.src, "texture.scaleX": u.scaleX, "texture.scaleY": u.scaleY });
  }
  for (const [sc, rows] of byScene) {
    try { await sc.updateEmbeddedDocuments("Token", rows); }
    catch (e) { warn(`token art write failed on ${sc.name}`, e); }
  }
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
  if (isTransformed(actor) || formEffects(actor).length) await revertGM(actor, { reason: "replaced", quiet: true, noFx: true });

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

  const changes = buildChanges(profile, hp.max, mp.max, props(form));

  // Visuals: every client squashes the current art out while the layer is
  // built; the new art is written once the squash has closed.
  const tokens = tokensOf(actor);
  const fxStart = Date.now();
  const squashed = opts.noFx ? 0 : broadcastSquash(tokens);

  const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: `Polymorph: ${form.name}`,
    img: form.img || "icons/svg/mystery-man.svg",
    origin: opts.sourceUuid ?? form.uuid,
    disabled: false,
    transfer: false,
    changes,
    description: `Transformed into ${form.name}. Lasts until the end of the scene or your next ${FORM_TURNS_IN_CONFLICT} turns during a conflict.`,
    // uncleansable: a tag / "*" dispel never ends a form — only revert() or a
    // row that names it. Remedy-style cleanses don't touch it (it isn't a status).
    flags: { [NS]: { [FLAG]: true, directorPermanent: true, uncleansable: true, formActorUuid: form.uuid } },
  }]);
  if (!effect) return { ok: false, reason: "effect-create-failed" };

  let itemCount = 0;
  try { itemCount = await copyFormItems(actor, form); }
  catch (e) { warn(`copying ${form.name}'s items onto ${actor.name} failed`, e); }

  const gotMax = { hp: num(props(actor).max_hp), mp: num(props(actor).max_mp) };
  if (gotMax.hp !== hp.max || gotMax.mp !== mp.max) {
    warn(`max did not land for ${actor.name}: HP ${gotMax.hp}/${hp.max}, MP ${gotMax.mp}/${mp.max} — using what landed`);
  }
  const formMax = { hp: gotMax.hp || hp.max, mp: gotMax.mp || mp.max };

  // A LIST, never an object keyed by uuid: a flag update expands the dots in
  // "Scene.x.Token.y" into nested paths (runner 2026-11-12: revert found nothing).
  const tokenArt = [];
  const swaps = [];
  for (const t of tokens) {
    const nt = formTextureFor(t, form);
    if (!nt) continue;
    tokenArt.push({ uuid: t.uuid, src: t.texture?.src ?? null, scaleX: t.texture?.scaleX ?? 1, scaleY: t.texture?.scaleY ?? 1 });
    swaps.push({ token: t, ...nt });
  }
  if (squashed) await sleep(Math.max(0, SQUASH_OUT_MS - (Date.now() - fxStart)));
  await writeTokenArt(swaps);

  const c = opts.conflict ?? liveConflictFor(actor);
  const state = {
    formActorUuid: form.uuid,
    formName: form.name,
    formImg: form.img ?? null,
    formTokenImg: form.prototypeToken?.texture?.src ?? null,
    tags: formTags(form.flags?.[NS]?.polymorphTags, profile.species),
    species: profile.species,
    effectId: effect.id,
    itemCount,
    tokenArt,
    sourceUuid: opts.sourceUuid ?? null,
    sceneId: canvas?.scene?.id ?? game.scenes?.active?.id ?? null,
    appliedAt: Date.now(),
    m,
    own: { maxHp: own.maxHp, maxMp: own.maxMp },
    form: { maxHp: formMax.hp, maxMp: formMax.mp },
    // Revert anchors: only what changes in form carries back (polymorph-math).
    start: {
      ownHp: own.curHp, ownMp: own.curMp,
      formHp: Math.min(hp.cur, formMax.hp), formMp: Math.min(mp.cur, formMax.mp),
    },
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

async function revertGM(actorRef, { reason = "voluntary", quiet = false, noFx = false } = {}) {
  const actor = await resolveActor(actorRef);
  if (!actor) return { ok: false, reason: "no-actor" };
  if (_reverting.has(actor.uuid)) return { ok: true, reason: "already-reverting" };
  const state = getForm(actor);
  const strays = formEffects(actor);
  const kit = formItems(actor);
  if (!state && !strays.length && !kit.length) return { ok: true, reason: "not-transformed" };

  _reverting.add(actor.uuid);
  try {
    const p = props(actor);
    const formCur = { hp: num(p.current_hp), mp: num(p.current_mp) };
    // Token art back (with the squash). A token that no longer exists (battle
    // tokens after a battle, a deleted token) is skipped.
    const restore = [];
    for (const o of (Array.isArray(state?.tokenArt) ? state.tokenArt : [])) {
      let t = null;
      try { t = fromUuidSync(o?.uuid); } catch { t = null; }
      if (t && o?.src) restore.push({ token: t, src: o.src, scaleX: o.scaleX, scaleY: o.scaleY });
    }
    const fxStart = Date.now();
    const squashed = (noFx || !restore.length) ? 0 : broadcastSquash(restore.map((r) => r.token));
    if (kit.length) {
      try { await actor.deleteEmbeddedDocuments("Item", kit.map((i) => i.id)); }
      catch (e) { warn(`removing form items from ${actor.name} failed`, e); }
    }
    if (strays.length) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", strays.map((e) => e.id), { fuNoFollowup: true });
    }
    if (squashed) await sleep(Math.max(0, SQUASH_OUT_MS - (Date.now() - fxStart)));
    await writeTokenArt(restore);
    const update = { [`flags.${NS}.-=${FLAG}`]: null };
    let hpBack = null, mpBack = null;
    if (state) {
      const s = state.start ?? null;
      hpBack = scaleOutOfForm(formCur.hp, state.form?.maxHp, state.own?.maxHp, s && { ownStart: s.ownHp, formStart: s.formHp });
      mpBack = scaleOutOfForm(formCur.mp, state.form?.maxMp, state.own?.maxMp, s && { ownStart: s.ownMp, formStart: s.formMp });
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

// ── Polymorph Potions ────────────────────────────────────────────────────────
// "Polymorph Potion: <Monster>" (polymorph-potions.js). Used on yourself or a
// willing ally (user ruling 2026-11-12). Out of battle this consumes the potion
// itself; the Battle Director's Item action consumes it in resolveAction and
// calls with consume:false. A missing monster or a refused transform (KO'd,
// a Guest, a monster as target) leaves the potion unused.

/** Read-only: what a potion would do. { isPotion, formName, form } */
export function potionInfo(item) {
  const formName = formNameForItem(item);
  return { isPotion: !!formName, formName, form: formName ? findFormActor(item) : null };
}

async function usePotionGM({ item: itemRef, target = null, consume = true, opts = {} } = {}) {
  const item = itemRef instanceof Item ? itemRef : await fromUuid(String(itemRef ?? "")).catch(() => null);
  if (!item) return { ok: false, reason: "no-item" };
  if (!isPolymorphPotion(item)) return { ok: false, reason: "not-a-polymorph-potion" };
  const form = findFormActor(item);
  if (!form) return { ok: false, reason: "form-missing", formName: formNameForItem(item) };
  const holder = item.parent instanceof Actor ? item.parent : null;
  const bearer = await resolveActor(target ?? holder);
  if (!bearer) return { ok: false, reason: "no-target" };
  const r = await transformGM(bearer, form, { ...opts, sourceUuid: item.uuid });
  if (!r.ok) return r;
  let consumed = false;
  if (consume && holder) {
    try {
      const { consumeOne } = await import("../battle-director/item-resource.js");
      const c = await consumeOne(holder, item);
      consumed = c?.ok !== false;
    } catch (e) { warn(`consuming ${item.name} failed`, e); }
  }
  return { ...r, consumed };
}

// ── Conflict turn counting (called by the Battle Director in phase 2) ───────

async function noteTurnEndedGM(actorRef, { round } = {}) {
  const actor = await resolveActor(actorRef);
  const state = getForm(actor);
  if (!state) return { ok: true, reason: "not-transformed" };
  const base = state.counter ?? counterOnConflictStart({ round });
  const { counter, ticked, expired } = tickOnTurnEnd(base, round);
  if (expired) return { ...(await revertGM(actor, { reason: "turns" })), ticked, expired, turnsLeft: 0 };
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
  usePotion: (args) => usePotionGM(args.opts ?? {}),
};

/** A player may transform / revert only an actor they own. Everything else is GM-only. */
async function authorize(op, args, senderId) {
  const user = game.users?.get(senderId);
  if (!user) return false;
  if (user.isGM) return true;
  // A potion: the player must own whoever HOLDS it (they may give it to a
  // willing ally; transformGM still refuses monsters, Guests and the KO'd).
  // Out of battle only — in battle the Battle Director drives it as the GM.
  if (op === "usePotion") {
    const ref = args.opts?.item;
    const item = ref ? await fromUuid(String(ref)).catch(() => null) : null;
    const holder = item?.parent instanceof Actor ? item.parent : null;
    return !!(args.opts?.consume !== false && holder?.testUserPermission?.(user, "OWNER"));
  }
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
  const opts = args.opts ? { ...args.opts } : args.opts;
  if (opts) { if ("item" in opts) opts.item = toRef(opts.item); if ("target" in opts) opts.target = toRef(opts.target); }
  return { ...args, actor: toRef(args.actor), form: toRef(args.form), opts };
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
/** Use a Polymorph Potion: `{ item, target?, consume = true }`. */
export const usePotion = (opts = {}) => run("usePotion", { opts });

const API = Object.freeze({
  transform, revert, revertAll, getForm, isTransformed, hasTag, listTransformed,
  noteTurnEnded, noteConflictStart, usePotion, potionInfo, isPolymorphPotion,
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

  // BAKE-IN GUARD (runs on every client, before the write leaves it). A CSB
  // sheet submits its inputs on close, and an input shows the AE-applied value
  // — so closing a transformed PC's sheet wrote the FORM's DEX/MIG/max HP/
  // affinities/blank sprite art into the PC's real data, permanently (runner,
  // 2026-11-12: Keren kept DEX 10, MIG 12, max HP 132 after reverting). While a
  // form is on, a write to any key the Form effect overrides is dropped; HP/MP
  // and everything else go through untouched.
  Hooks.on("preUpdateActor", (actor, changes) => {
    if (!getForm(actor) || _reverting.has(actor.uuid)) return;
    const keys = formOverriddenKeys(actor);
    if (!keys.size) return;
    const nested = changes?.system?.props;
    let dropped = 0;
    if (nested && typeof nested === "object") {
      for (const k of Object.keys(nested)) if (keys.has(k)) { delete nested[k]; dropped++; }
    }
    for (const k of Object.keys(changes ?? {})) {
      const m = k.match(/^system\.props\.(.+)$/);
      if (m && keys.has(m[1])) { delete changes[k]; dropped++; }
    }
    if (dropped) log(`${actor.name}: kept ${dropped} form-overridden field(s) out of a save (sheet submit while transformed)`);
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
