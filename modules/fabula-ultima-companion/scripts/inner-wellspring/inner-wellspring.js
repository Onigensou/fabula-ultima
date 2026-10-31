// scripts/inner-wellspring/inner-wellspring.js
//
// INNER WELLSPRING (Invoker heroic skill): the holder carries one wellspring
// within. Modelled on the Upgrade heroic's camp flow (orbment-upgrade.js):
//   • At camp (Free Roam / Sleep lobby) the holder picks tonight's wellspring.
//     The pick is queued on the HOLDER: flags.<ns>.innerWellspring =
//       { current, tonight, setAt }
//     and every write goes through the primary GM over a socket.
//   • fabula.restPerformed (after the rest's temp-AE sweep) applies
//     `tonight ?? current`: with no pick, last night's wellspring carries over
//     (house rule; RAW lets it lapse).
//   • First acquire: the holder has the skill but has never chosen. The window
//     opens straight away, can't be closed until a pick, and applies at once.
//
// The effect is ONE self Active Effect on the holder:
//   flags.<ns>.wellspring_<elem> = 1   — field-api's wellspringAvailableFor
//                                         already honours a creature's own flag,
//                                         which unlocks WELLSPRING_<ELEM>_AVAILABLE
//   affinity_<idx> = aeAffinityFloor("RS") — Resistance (keeps a better IM/AB)
// It is directorPermanent + crossScene so no battle sweep, dungeon tick, rest
// sweep or Cleanse removes it; this module replaces it at each rest.
//
// Not built here (need engine work): the Elementalism ritual benefit and the
// "change damage type, ignore Resistances" benefit.

import { FLAG_NS, WELLSPRINGS, wellspringChangeKey, wellspringFlagKey } from "../field-system/field-core.js";

const TAG = "[InnerWellspring]";
const CHANNEL = "module.fabula-ultima-companion";
export const SKILL_NAME = "Inner Wellspring";
export const IW_FLAG = "innerWellspring";        // holder state + the AE's marker
export const IW_TAG = "inner_wellspring";
export const IW_MSG = Object.freeze({ REQ: "innerWellspring:req", RES: "innerWellspring:res" });
const TIMEOUT_MS = 15000;
const OPEN_PHASES = ["free_roam", "sleep_lobby"];

// The five scene wellsprings. Labels are the WELLSPRING names (user, 2026-11-01:
// Air, Earth, Fire, Lightning, Water whatever their damage type); `id` is the
// damage type (Lightning deals bolt, Water deals ice).
const AFFINITY_IDX = { air: 2, bolt: 3, earth: 5, fire: 6, ice: 7 };
export const IW_ELEMENTS = Object.freeze([
  { id: "air",   label: "Air",   rgb: "95,211,198",  ink: "#1f7a71" },
  { id: "earth", label: "Earth", rgb: "193,154,107", ink: "#7a5530" },
  { id: "fire",  label: "Fire",  rgb: "232,96,60",   ink: "#b8432c" },
  { id: "bolt",  label: "Lightning", rgb: "232,201,60",  ink: "#8a6c06" },
  { id: "ice",   label: "Water", rgb: "111,183,232", ink: "#2f6fa8" },
].map((e) => Object.freeze({ ...e, affinity: AFFINITY_IDX[e.id], img: WELLSPRINGS.find((w) => w.elem === e.id)?.img ?? "icons/svg/aura.svg" })));
const ELEM_IDS = new Set(IW_ELEMENTS.map((e) => e.id));
export const elementOf = (id) => IW_ELEMENTS.find((e) => e.id === id) ?? null;

const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const isTrue = (v) => v === true || String(v) === "true";

export const skillItemOf = (actor) => actor?.items?.find?.((i) =>
  String(i.name ?? "").trim().toLowerCase() === SKILL_NAME.toLowerCase() && isTrue(i.system?.props?.isHeroic)) ?? null;
export const hasInnerWellspring = (actor) => !!skillItemOf(actor);

/** The holder's Inner Wellspring AEs (normally one). */
export const iwEffects = (actor) => Array.from(actor?.effects ?? []).filter((e) => ELEM_IDS.has(e?.flags?.[FLAG_NS]?.[IW_FLAG]));

/**
 * { current, tonight } — current is what is ACTIVE now: the flag's record,
 * falling back to a live AE (so a hand-made or migrated AE still counts).
 */
export function iwState(actor) {
  const f = actor?.flags?.[FLAG_NS]?.[IW_FLAG] ?? {};
  const fromAe = iwEffects(actor).find((e) => !e.disabled)?.flags?.[FLAG_NS]?.[IW_FLAG] ?? null;
  const current = ELEM_IDS.has(f.current) ? f.current : fromAe;
  const tonight = ELEM_IDS.has(f.tonight) && f.tonight !== current ? f.tonight : null;
  return { current: current ?? null, tonight };
}
export const needsFirstPick = (actor) => hasInnerWellspring(actor) && !iwState(actor).current;

export const campPhase = () => globalThis.CampSystem?.State?.getPhase?.() ?? null;
// Open = the party is at camp (the ACTIVE scene) and hasn't gone to sleep yet.
export const iwCampOpen = () => OPEN_PHASES.includes(campPhase())
  && game.scenes?.active?.flags?.[FLAG_NS]?.oniFabula?.general?.sceneMode === "camp";

export function iwFailText(r) {
  switch (r?.reason) {
    case "not_now": return "The wellspring is changed at camp, before the party sleeps.";
    case "needs_first_pick": return "Choose your first wellspring before you change it.";
    case "already_chosen": return "A wellspring is already chosen. Change it at camp.";
    case "bad_element": return "Choose one of the five wellsprings.";
    case "no_skill": return "That takes the Inner Wellspring heroic skill.";
    case "not_your_character": return "You can only choose your own character's wellspring.";
    case "no_gm": return "Inner Wellspring needs a GM online.";
    case "timeout": return "No answer from the GM. Try again in a moment.";
    default: return `Inner Wellspring failed (${r?.reason ?? "unknown"}).`;
  }
}

// ── The Active Effect ────────────────────────────────────────────────────────
export function buildIwEffect(actor, elem) {
  const e = elementOf(elem);
  const skill = skillItemOf(actor);
  return {
    // Guideline D3: multi-option AE = "Skill (Option)".
    name: `${SKILL_NAME} (${e.label})`,
    img: e.img,
    description: `<p>The ${e.label} wellspring within: always available to you, and Resistance to ${e.id} damage, until your next rest.</p>`,
    changes: [
      { key: wellspringChangeKey(e.id), mode: 5, priority: 20, value: "1" },
      { key: `affinity_${e.affinity}`, mode: 5, priority: 3, value: 'aeAffinityFloor("RS")' },
    ],
    disabled: false,
    transfer: false,
    origin: skill?.uuid ?? null,
    duration: {},
    statuses: [`fud-inner-wellspring-${e.id}`],
    // NOT "buff": that tag makes it strippable by remove_tagged_ae buff/dispels.
    system: { tags: [IW_TAG] },
    flags: { [FLAG_NS]: { [IW_FLAG]: e.id, directorPermanent: true, crossScene: true } },
  };
}

// What makes an existing AE good enough to keep (anything else is replaced).
const effectSig = (x) => JSON.stringify([x.name, [...(x.statuses ?? [])].sort(),
  (x.changes ?? []).map((c) => [c.key, Number(c.mode), String(c.value), Number(c.priority ?? 0)])]);

/** Make the holder's Inner Wellspring AE match `elem` (GM side). */
export async function applyIwEffect(actor, elem) {
  const want = buildIwEffect(actor, elem);
  const have = iwEffects(actor);
  const keep = have.find((x) => x.flags?.[FLAG_NS]?.[IW_FLAG] === elem && !x.disabled && effectSig(x) === effectSig(want));
  const drop = have.filter((x) => x !== keep).map((x) => x.id);
  if (drop.length) await actor.deleteEmbeddedDocuments("ActiveEffect", drop);
  if (!keep) await actor.createEmbeddedDocuments("ActiveEffect", [want]);
  return { created: !keep, removed: drop.length };
}

async function writeState(actor, patch) {
  const cur = actor.flags?.[FLAG_NS]?.[IW_FLAG] ?? {};
  await actor.setFlag(FLAG_NS, IW_FLAG, { current: cur.current ?? null, tonight: cur.tonight ?? null, ...patch, setAt: Date.now() });
}

// ── GM side ──────────────────────────────────────────────────────────────────
// op "attune" — first pick: applies now. Refused once a wellspring is chosen.
// op "queue"  — tonight's pick at camp; queueing the active one clears the change.
export async function executeIwOp({ op, holderUuid, elem, requesterUserId = null } = {}) {
  try {
    const holder = await fromUuid(String(holderUuid ?? "")).catch(() => null);
    if (!holder || holder.documentName !== "Actor") return fail("holder_not_found");
    const requester = requesterUserId ? game.users.get(requesterUserId) : game.user;
    if (requester && !requester.isGM && !holder.testUserPermission(requester, "OWNER")) return fail("not_your_character");
    if (!hasInnerWellspring(holder)) return fail("no_skill");
    if (!ELEM_IDS.has(elem)) return fail("bad_element");
    const st = iwState(holder);

    if (op === "attune") {
      if (st.current) return fail("already_chosen");
      // The flag first: it is the truth the reconciler restores the AE to.
      await withBusy(holder, async () => {
        await writeState(holder, { current: elem, tonight: null });
        await applyIwEffect(holder, elem);
      });
      console.debug(TAG, "attuned", holder.name, elem);
      return { ok: true, op, current: elem, tonight: null };
    }
    if (op !== "queue") return fail("bad_op");
    if (!st.current) return fail("needs_first_pick");
    if (!iwCampOpen()) return fail("not_now");
    const tonight = elem === st.current ? null : elem;
    await writeState(holder, { current: st.current, tonight });
    console.debug(TAG, "queued", holder.name, tonight ?? `(keep ${st.current})`);
    return { ok: true, op, current: st.current, tonight };
  } catch (e) {
    console.error(TAG, "executeIwOp failed", e);
    return fail("error", { message: String(e?.message ?? e) });
  }
}

// Rest complete: every rested holder takes tonight's pick, or keeps the last one.
export async function applyAtRest(actors = []) {
  const done = [];
  for (const holder of actors) {
    if (!hasInnerWellspring(holder)) continue;
    const st = iwState(holder);
    const elem = st.tonight ?? st.current;
    if (!elem) continue;          // never chosen: the first-pick window handles it
    try {
      await withBusy(holder, async () => {
        await writeState(holder, { current: elem, tonight: null });
        await applyIwEffect(holder, elem);
      });
      done.push({ actor: holder.name, elem, changed: !!st.tonight });
      console.debug(TAG, "rest:", holder.name, elem, st.tonight ? "(changed)" : "(kept)");
    } catch (e) { console.error(TAG, "rest apply failed", holder.name, e); }
  }
  return done;
}

function onRestPerformed(actors) {
  if (!isPrimaryGM()) return;
  applyAtRest(Array.isArray(actors) ? actors : []).catch((e) => console.error(TAG, "applyAtRest", e));
}

// ── Reconcile: the AE always matches the flag ───────────────────────────────
// Loading a save can break the pairing, measured by review 2026-11-01:
//   • save-extractors keeps a live crossScene/directorPermanent AE AND recreates
//     the saved one (different id + name once the element changed) → two IW AEs;
//   • partyData.extract snapshots the PREPARED actor.flags, so the AE-applied
//     wellspring_<elem> flag is written into _source on load and would make that
//     element available forever, AE or not.
// So the primary GM restores "exactly one AE, for flags.innerWellspring.current"
// and drops any wellspring_<elem> stored in a holder's SOURCE flags (only an AE
// may grant it to a creature) whenever a holder's IW state or AEs change.
const _busy = new Set();
async function withBusy(actor, fn) {
  _busy.add(actor.id);
  try { return await fn(); } finally { setTimeout(() => _busy.delete(actor.id), 400); }
}

export async function reconcileIw(actor) {
  const fixes = [];
  if (!actor || !hasInnerWellspring(actor) || _busy.has(actor.id)) return fixes;
  await withBusy(actor, async () => {
    const src = actor._source?.flags?.[FLAG_NS] ?? {};
    const strays = IW_ELEMENTS.map((e) => wellspringFlagKey(e.id)).filter((k) => Object.prototype.hasOwnProperty.call(src, k));
    if (strays.length) {
      await actor.update(Object.fromEntries(strays.map((k) => [`flags.${FLAG_NS}.-=${k}`, null])));
      fixes.push(`dropped source flag ${strays.join(", ")}`);
    }
    const cur = actor.flags?.[FLAG_NS]?.[IW_FLAG]?.current;
    if (!ELEM_IDS.has(cur)) return;        // nothing recorded: leave any AE alone
    const effs = iwEffects(actor);
    const ok = effs.length === 1 && effs[0].flags[FLAG_NS][IW_FLAG] === cur && !effs[0].disabled;
    if (!ok) {
      const r = await applyIwEffect(actor, cur);
      fixes.push(`AE reset to ${cur} (had ${effs.length}; removed ${r.removed})`);
    }
  });
  if (fixes.length) console.warn(TAG, "reconciled", actor.name, fixes);
  return fixes;
}

const _pending = new Map();
function queueReconcile(actor) {
  if (!isPrimaryGM() || !actor || actor.documentName !== "Actor" || !hasInnerWellspring(actor)) return;
  clearTimeout(_pending.get(actor.id));
  _pending.set(actor.id, setTimeout(() => {
    _pending.delete(actor.id);
    const live = game.actors.get(actor.id) ?? actor;
    reconcileIw(live).catch((e) => console.warn(TAG, "reconcile", e));
  }, 600));
}
function onUpdateActor(actor, diff) {
  const f = diff?.flags?.[FLAG_NS];
  if (f && Object.keys(f).some((k) => k === IW_FLAG || k.startsWith("wellspring_") || k.startsWith("-=wellspring_"))) queueReconcile(actor);
}
function onEffectChange(eff) {
  if (eff?.flags?.[FLAG_NS]?.[IW_FLAG]) queueReconcile(eff.parent);
}

// Losing the skill takes its effect with it.
function onDeleteItem(item) {
  if (!isPrimaryGM()) return;
  const actor = item?.parent;
  if (!actor || actor.documentName !== "Actor" || hasInnerWellspring(actor)) return;
  if (String(item.name ?? "").trim().toLowerCase() !== SKILL_NAME.toLowerCase()) return;
  const ids = iwEffects(actor).map((e) => e.id);
  if (ids.length) actor.deleteEmbeddedDocuments("ActiveEffect", ids).catch((e) => console.warn(TAG, "cleanup", e));
}

// ── Client side ──────────────────────────────────────────────────────────────
const _reqs = new Map();
export function requestIw(op, data = {}) {
  if (isPrimaryGM()) return executeIwOp({ op, ...data, requesterUserId: game.user.id });
  if (!game.users?.activeGM && !game.users?.some?.((u) => u.isGM && u.active)) return Promise.resolve(fail("no_gm"));
  const reqId = foundry.utils.randomID();
  return new Promise((resolve) => {
    _reqs.set(reqId, resolve);
    game.socket.emit(CHANNEL, { type: IW_MSG.REQ, payload: { reqId, op, ...data, requesterUserId: game.user.id } });
    setTimeout(() => { if (_reqs.delete(reqId)) resolve(fail("timeout")); }, TIMEOUT_MS);
  });
}

function onSocket(msg) {
  if (msg?.type === IW_MSG.REQ) {
    if (!isPrimaryGM()) return;
    const { reqId, ...req } = msg.payload ?? {};
    executeIwOp(req)
      .catch((e) => fail("server_error", { message: String(e?.message ?? e) }))
      .then((r) => game.socket.emit(CHANNEL, { type: IW_MSG.RES, payload: { reqId, toUserId: req.requesterUserId, ...r } }));
    return;
  }
  if (msg?.type === IW_MSG.RES) {
    const { reqId, toUserId, ...rest } = msg.payload ?? {};
    if (toUserId && toUserId !== game.user.id) return;
    const resolve = _reqs.get(reqId);
    if (!resolve) return;
    _reqs.delete(reqId);
    resolve(rest);
  }
}

let _installed = false;
export function installInnerWellspring() {
  if (_installed) return;
  _installed = true;
  game.socket.on(CHANNEL, onSocket);
  Hooks.on("fabula.restPerformed", onRestPerformed);
  Hooks.on("deleteItem", onDeleteItem);
  Hooks.on("updateActor", onUpdateActor);
  Hooks.on("createActiveEffect", onEffectChange);
  Hooks.on("deleteActiveEffect", onEffectChange);
  // A world opened from an older state (or a save loaded while no GM was on).
  setTimeout(() => {
    if (!isPrimaryGM()) return;
    for (const a of game.actors ?? []) if (hasInnerWellspring(a)) reconcileIw(a).catch(() => {});
  }, 4000);
}
