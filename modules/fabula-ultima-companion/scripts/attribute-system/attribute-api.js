/**
 * Attribute system — backend.
 *
 * Reads and summarises an actor's attributes and derived stats, and applies the
 * die-step advance earned at character level 20 and 40.
 *
 * AUTHORITY
 * ---------
 * Every write runs GM-side through the shared advancement transport — the same
 * channel, authority gate and request-id dedupe the skill system uses. Rules are
 * re-checked there because the client's copy is a convenience, not a guarantee.
 *
 * WHAT IT TOUCHES
 * ---------------
 * `<attr>_base` only, written as a string. Everything downstream — `_current`,
 * DEF/MDEF, max HP/MP — is CSB-computed and updates itself.
 */

import { ATTR, ATTR_KEYS, ATTR_META, STEP_EFFECT, num, nextDie, prevDie, log, warn, err } from "./attribute-const.js";
import { isActingGM, registerHandler, request, installNet } from "../advancement/advancement-net.js";
import { isAdvancementSubject, subjectFailure } from "../advancement/advancement-subject.js";
import { gateState } from "../levelup-system/levelup-gate.js";

const PROP = ATTR.PROP;

const resolveActor = (uuid) => {
  const doc = (typeof fromUuidSync === "function" ? fromUuidSync(uuid) : null) ?? null;
  if (doc?.documentName === "Actor") return doc;
  return game.actors?.get(String(uuid ?? "").replace(/^Actor\./, "")) ?? null;
};

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

/**
 * Is the actor behind this uuid a subject of advancement?
 *
 * Exported so the window can check a uuid handed to it directly, using the same
 * resolver as the write path (which accepts a bare id as well as a uuid).
 */
export const isSubjectUuid = (uuid) => isAdvancementSubject(resolveActor(uuid));

// ── ledger ─────────────────────────────────────────────────────────────────

/** The whole ledger flag, normalised. */
export function readLedger(actor) {
  const f = actor?.getFlag?.(ATTR.FLAG_SCOPE, ATTR.FLAG_KEY) ?? null;
  const log = Array.isArray(f?.log) ? f.log.filter((e) => e && ATTR_KEYS.includes(e.attr)) : [];
  return { claimed: Math.max(0, num(f?.claimed, 0)), log };
}

export const readLog = (actor) => readLedger(actor).log;

/** Milestones the actor's LEVEL has reached — not their class-level total. */
export const milestonesReached = (actor) => {
  const lvl = num(actor?.system?.props?.[PROP.LEVEL], 0);
  return ATTR.MILESTONES.filter((m) => lvl >= m).length;
};

export const claimedCount = (actor) => readLedger(actor).claimed;

/** Advances the actor may still spend. */
export const availableAdvances = (actor) =>
  Math.max(0, milestonesReached(actor) - claimedCount(actor));

// ── read model ─────────────────────────────────────────────────────────────

/**
 * Everything the status window draws, in one read. Safe on any client.
 *
 * `base` is the permanent die and the only thing an advance changes. `current`
 * is what the actor is rolling right now, after buffs and debuffs — shown
 * beside it so a debuffed player can see both without mistaking the temporary
 * value for the one they are upgrading.
 */
export function readStatus(actorUuid) {
  const actor = resolveActor(actorUuid);
  if (!actor) return fail("actor_not_found");
  const p = actor.system?.props ?? {};

  const attributes = ATTR_KEYS.map((key) => {
    const base = num(p[`${key}_base`], 0);
    const current = num(p[`${key}_current`], base);
    return {
      key,
      ...ATTR_META[key],
      base,
      current,
      // -1 debuffed, 0 unchanged, +1 buffed. Drives the colour, so the window
      // never has to know why they differ.
      shift: current === base ? 0 : (current > base ? 1 : -1),
      atMax: base >= ATTR.DIE.MAX,
      next: nextDie(base),
    };
  });

  const byKey = Object.fromEntries(attributes.map((a) => [a.key, a]));

  // An NPC has a level and therefore reaches milestones on paper, but is not a
  // subject of this system. Reported rather than hidden so the window can draw
  // a monster's stats read-only if something opens it deliberately, while
  // `available` stays 0 and no arrow is ever offered.
  const eligible = isAdvancementSubject(actor);

  return {
    ok: true,
    eligible,
    actor: { uuid: actor.uuid, id: actor.id, name: actor.name, img: actor.img },
    attributes,
    derived: readDerived(p, byKey),
    advances: {
      reached: milestonesReached(actor),
      claimed: claimedCount(actor),
      available: eligible ? availableAdvances(actor) : 0,
    },
    ledger: readLog(actor),
    gate: gateState(),
  };
}

/**
 * Derived stats for the right-hand panel.
 *
 * Initiative is NOT the actor's stored init value: it is the average of a
 * DEX + INS roll, plus mods — the number a player actually wants to compare
 * against. Average of dN is (N+1)/2, so d12 + d8 reads 6.5 + 4.5 = 11.
 */
function readDerived(p, byKey) {
  const avgRoll = (die) => (num(die, 0) + 1) / 2;
  const initMod = num(p.check_mod_init, 0) - num(p.init_penalty, 0);

  return {
    hp:   { cur: num(p.current_hp, 0), max: num(p.max_hp, 0) },
    mp:   { cur: num(p.current_mp, 0), max: num(p.max_mp, 0) },
    ip:   { cur: num(p.current_ip, 0), max: num(p.max_ip, 0) },
    def:  num(p.defense, 0),
    mdef: num(p.magic_defense, 0),
    init: {
      value: avgRoll(byKey.dex?.current ?? 0) + avgRoll(byKey.ins?.current ?? 0) + initMod,
      mod: initMod,
    },
    level: num(p[PROP.LEVEL], 0),
    zenit: num(p.zenit, 0),
    fabula: num(p.fabula_point, 0),
    crisis: Math.floor(num(p.max_hp, 0) / 2),
  };
}

/**
 * What a set of staged steps would do to the derived stats.
 *
 * Applies deltas to CSB's CURRENT values rather than recomputing the formulas.
 * Zarg's max_hp is 111 where `level + 5×MIG` gives 81 — the other 30 comes from
 * equipment, and a recompute would quietly delete it. Confirmed live: one MIG
 * step moved 111 → 121.
 *
 * @param {object} status  from readStatus
 * @param {object} staged  { mig: 1, dex: 0, ... } steps per attribute
 */
export function previewDerived(status, staged) {
  const out = foundry.utils.deepClone(status.derived);
  const bump = {};

  for (const key of ATTR_KEYS) {
    const steps = Math.max(0, num(staged?.[key], 0));
    if (!steps) continue;
    for (const fx of STEP_EFFECT[key] ?? []) {
      bump[fx.prop] = (bump[fx.prop] ?? 0) + fx.delta * steps;
    }
  }

  if (bump.max_hp) { out.hp.max += bump.max_hp; out.crisis = Math.floor(out.hp.max / 2); }
  if (bump.max_mp) out.mp.max += bump.max_mp;
  if (bump.defense) out.def += bump.defense;
  if (bump.magic_defense) out.mdef += bump.magic_defense;

  // Initiative moves with DEX and INS, so it has to follow the staged dice
  // rather than a fixed delta — half a step each, since it is an average.
  const stepAvg = (key) => {
    const steps = Math.max(0, num(staged?.[key], 0));
    if (!steps) return 0;
    const a = status.attributes.find((x) => x.key === key);
    let die = a?.current ?? 0, gained = 0;
    for (let i = 0; i < steps; i++) {
      const n = nextDie(die);
      if (n == null) break;
      gained += (n - die) / 2;
      die = n;
    }
    return gained;
  };
  out.init = { ...out.init, value: out.init.value + stepAvg("dex") + stepAvg("ins") };

  return out;
}

// ── writes (GM-side) ───────────────────────────────────────────────────────

/**
 * Apply staged advances. Re-validates everything: the client's staging is a
 * proposal, not permission.
 */
async function applyAdvance(payload) {
  try {
    const actor = resolveActor(payload?.actorUuid);
    if (!actor) return fail("actor_not_found");

    // Checked BEFORE the gate: an ineligible subject is not a "come back at
    // camp" condition, it is a permanent no. Every UI path already filters, but
    // this is the authority — a future entry point that forgets must still fail
    // here rather than write a die step onto a monster.
    const wrongSubject = subjectFailure(actor);
    if (wrongSubject) return fail(wrongSubject);

    const gate = gateState();
    if (!gate.open) return fail("gate_closed", { gate });

    const picks = Array.isArray(payload?.picks) ? payload.picks : [];
    if (!picks.length) return fail("nothing_staged");

    const available = availableAdvances(actor);
    if (picks.length > available) return fail("not_enough_advances", { available });

    // Walk the picks against a working copy so several steps on the same
    // attribute cap correctly instead of each reading the stored value.
    const p = actor.system?.props ?? {};
    const working = Object.fromEntries(ATTR_KEYS.map((k) => [k, num(p[`${k}_base`], 0)]));
    const { claimed: already, log: entries } = readLedger(actor);
    const update = {};
    const applied = [];

    for (let i = 0; i < picks.length; i++) {
      const key = String(picks[i] ?? "").toLowerCase();
      if (!ATTR_KEYS.includes(key)) return fail("unknown_attribute", { key });

      const from = working[key];
      const to = nextDie(from);
      if (to == null) return fail("at_maximum", { key, die: from });

      working[key] = to;
      update[`system.props.${key}_base`] = String(to);
      const milestone = ATTR.MILESTONES[already + i] ?? 0;
      entries.push({ milestone, attr: key, from, to });
      applied.push({ key, from, to });
    }

    update[`flags.${ATTR.FLAG_SCOPE}.${ATTR.FLAG_KEY}`] = {
      claimed: already + picks.length,
      log: entries,
    };

    await actor.update(update);
    log(`advance: ${actor.name} — ${applied.map((a) => `${a.key} d${a.from}→d${a.to}`).join(", ")}`);
    return { ok: true, applied, claimed: already + picks.length };
  } catch (e) {
    err("applyAdvance threw", e);
    return fail("error", { message: String(e?.message ?? e) });
  }
}

/**
 * Undo the most recent advance.
 *
 * Nothing in the game exposes this yet — there is no in-game way to unspend an
 * attribute point. It exists because the ledger makes it possible and because
 * building it later without the log would mean guessing which attribute to
 * lower. Kept honest by the same validation as the forward path.
 */
async function applyRefund(payload) {
  try {
    const actor = resolveActor(payload?.actorUuid);
    if (!actor) return fail("actor_not_found");

    const wrongSubject = subjectFailure(actor);
    if (wrongSubject) return fail(wrongSubject);

    const { claimed, log: entries } = readLedger(actor);
    const last = entries.pop();
    if (!last) return fail("nothing_to_refund");

    const key = last.attr;
    if (!ATTR_KEYS.includes(key)) return fail("unknown_attribute", { key });

    const cur = num(actor.system?.props?.[`${key}_base`], 0);
    // Only unwind if the die is still where the log left it — a hand-edit or a
    // later advance means the ledger no longer describes reality, and stepping
    // down blindly would corrupt a value nobody asked us to touch.
    if (cur !== last.to) return fail("ledger_stale", { key, expected: last.to, found: cur });

    const back = prevDie(cur);
    if (back == null) return fail("at_minimum", { key, die: cur });

    await actor.update({
      [`system.props.${key}_base`]: String(back),
      [`flags.${ATTR.FLAG_SCOPE}.${ATTR.FLAG_KEY}`]: {
        claimed: Math.max(0, claimed - 1),
        log: entries,
      },
    });
    log(`refund: ${actor.name} — ${key} d${cur}→d${back}`);
    return { ok: true, key, from: cur, to: back };
  } catch (e) {
    err("applyRefund threw", e);
    return fail("error", { message: String(e?.message ?? e) });
  }
}

// ── transport ──────────────────────────────────────────────────────────────
//
// Shares the skill system's channel, authority gate and dedupe. Types are
// namespaced ("attribute.*") so the two domains cannot collide.

registerHandler(ATTR.CHANNEL_MSG.ADVANCE_REQ, ATTR.CHANNEL_MSG.ADVANCE_RES, applyAdvance);
registerHandler(ATTR.CHANNEL_MSG.REFUND_REQ,  ATTR.CHANNEL_MSG.REFUND_RES,  applyRefund);

const REQ_OPTS = { timeoutMs: ATTR.REQUEST_TIMEOUT_MS };

export const advance = (p) => request(ATTR.CHANNEL_MSG.ADVANCE_REQ, p, REQ_OPTS);
export const refund  = (p) => request(ATTR.CHANNEL_MSG.REFUND_REQ,  p, REQ_OPTS);

function registerApi() {
  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.attributes = {
    readStatus, previewDerived, advance, refund,
    availableAdvances: (uuid) => {
      const a = resolveActor(uuid);
      return a && isAdvancementSubject(a) ? availableAdvances(a) : 0;
    },
    // For callers that cannot import — the Status macro.
    isSubject: isSubjectUuid,
  };
}

Hooks.once("init", registerApi);
Hooks.once("ready", () => { installNet(); log("ready"); });
