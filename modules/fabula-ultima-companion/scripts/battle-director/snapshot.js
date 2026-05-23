// State-entry snapshot helpers.
// See docs/battle-director-design.md §8 — every state captures an immutable
// snapshot of its inputs at entry so the state body operates on a frozen
// view rather than racing with live document mutations.

import { warn } from "./logger.js";

// Numeric prop reader with multiple candidate keys + default.
export function readPropNum(actor, keys, fallback = 0) {
  const props = actor?.system?.props ?? actor?.system ?? {};
  for (const k of keys) {
    const v = props?.[k];
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9-]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// Look up a CSB attribute die size for an actor. Default to d8.
export function attrDieSize(actor, key) {
  if (!actor) return 8;
  const A = String(key || "").toUpperCase();
  const props = actor?.system?.props ?? actor?.system ?? {};
  const candidates = [
    props[`${A}_die_size`],
    props[`${A}_die`],
    props[`current_${A}_die`],
    props[`current_${A}`],
    props[A],
  ];
  for (const c of candidates) {
    const s = String(c ?? "").replace(/[^0-9]/g, "");
    const n = Number(s);
    if (Number.isFinite(n) && n >= 4) return n;
  }
  return 8;
}

// Director-owned snapshot. Takes a DirectorCombatant (live tokenDoc + actorDoc
// refs) and produces the same frozen shape that snapshotCombatant returns.
// This is what TurnStart calls in the dCombat path.
export function snapshotDirectorCombatant(dc) {
  try {
    if (!dc) { warn("snapshotDirectorCombatant: null combatant"); return null; }
    const tokenDoc = dc.tokenDoc;
    const actor = dc.actorDoc;
    if (!tokenDoc) { warn("snapshotDirectorCombatant: combatant missing tokenDoc", dc.id); return null; }
    if (!actor) { warn("snapshotDirectorCombatant: combatant missing actor", dc.id); return null; }
    return Object.freeze({
      // dCombatantId — the director's combatant id (NOT a Foundry combatant)
      combatantId: dc.id,
      tokenId: tokenDoc.id,
      tokenUuid: tokenDoc.uuid,
      actorId: actor.id,
      actorUuid: actor.uuid,
      name: actor.name ?? dc.name ?? "Unknown",
      disposition: dc.disposition ?? tokenDoc.disposition ?? 0,
      hp: readPropNum(actor, ["current_hp", "hp"]),
      maxHp: readPropNum(actor, ["max_hp"]),
      mp: readPropNum(actor, ["current_mp", "mp"]),
      maxMp: readPropNum(actor, ["max_mp"]),
      defense: readPropNum(actor, ["defense", "current_def", "def"]),
      magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
      attributes: Object.freeze({
        DEX: attrDieSize(actor, "DEX"),
        INS: attrDieSize(actor, "INS"),
        MIG: attrDieSize(actor, "MIG"),
        WLP: attrDieSize(actor, "WLP"),
      }),
    });
  } catch (e) {
    warn("snapshotDirectorCombatant threw", e);
    return null;
  }
}

// Snapshot the active combatant. Captures token + actor identity + a few
// numeric props so state bodies don't have to refetch.
//
// Legacy path: reads `combat.combatant` directly (Foundry Combat doc).
// Used only in the manual-fallback start path (no payload, no PREP).
export function snapshotCombatant(combat) {
  try {
    const combatant = combat?.combatant ?? null;
    if (!combatant) { warn("snapshotCombatant: no current combatant"); return null; }
    const token = combatant.token;
    const actor = combatant.actor;
    if (!token) { warn("snapshotCombatant: combatant has no token", combatant.id); return null; }
    if (!actor) { warn("snapshotCombatant: combatant has no actor", combatant.id); return null; }

    return Object.freeze({
      combatantId: combatant.id,
      tokenId: token.id,
      tokenUuid: token.uuid,
      actorId: actor.id,
      actorUuid: actor.uuid,
      name: actor.name ?? "Unknown",
      disposition: token.disposition ?? 0,
      hp: readPropNum(actor, ["current_hp", "hp"]),
      maxHp: readPropNum(actor, ["max_hp"]),
      mp: readPropNum(actor, ["current_mp", "mp"]),
      maxMp: readPropNum(actor, ["max_mp"]),
      defense: readPropNum(actor, ["defense", "current_def", "def"]),
      magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
      attributes: Object.freeze({
        DEX: attrDieSize(actor, "DEX"),
        INS: attrDieSize(actor, "INS"),
        MIG: attrDieSize(actor, "MIG"),
        WLP: attrDieSize(actor, "WLP"),
      }),
    });
  } catch (e) {
    warn("snapshotCombatant threw", e);
    return null;
  }
}

// Snapshot eligible targets read from a DirectorCombat (the no-Foundry-doc
// path). Same returned shape as `snapshotEligibleTargets` so callers can swap
// without changing downstream code.
export function snapshotEligibleTargetsFromDCombat(dCombat, attackerSnapshot, { category = "any" } = {}) {
  const combatants = dCombat?.combatants ?? [];
  const attackerDisp = attackerSnapshot?.disposition ?? 0;
  const out = [];
  for (const c of combatants) {
    const token = c.tokenDoc;
    const actor = c.actorDoc;
    if (!token || !actor) continue;
    const disp = c.disposition ?? token.disposition ?? 0;
    const hp = readPropNum(actor, ["current_hp", "hp"]);
    if (hp <= 0) continue;
    let ok = true;
    if (category === "ally") {
      ok = (disp === attackerDisp) && (disp !== 0);
    } else if (category === "enemy") {
      ok = (disp !== attackerDisp) || (disp === 0);
    } else if (category === "self") {
      ok = c.id === attackerSnapshot?.combatantId;
    }
    if (!ok) continue;
    out.push(Object.freeze({
      combatantId: c.id,
      tokenId: token.id,
      tokenUuid: token.uuid,
      actorId: actor.id,
      actorUuid: actor.uuid,
      name: actor.name,
      disposition: disp,
      hp,
      maxHp: readPropNum(actor, ["max_hp"]),
      defense: readPropNum(actor, ["defense", "current_def", "def"]),
      magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
    }));
  }
  return Object.freeze(out);
}

// Snapshot eligible targets for a given action category.
// `category`: "any" | "ally" | "enemy" | "self".
// For the prototype we keep this simple — token UUIDs + name + disposition.
export function snapshotEligibleTargets(combat, attackerSnapshot, { category = "any" } = {}) {
  const combatants = combat?.combatants ?? [];
  const attackerDisp = attackerSnapshot?.disposition ?? 0;
  const out = [];
  for (const c of combatants) {
    const token = c.token;
    const actor = c.actor;
    if (!token || !actor) continue;
    const disp = token.disposition;
    const hp = readPropNum(actor, ["current_hp", "hp"]);
    if (hp <= 0) continue; // defeated combatants are not targetable in v1
    let ok = true;
    if (category === "ally") {
      ok = (disp === attackerDisp) && (disp !== 0);
    } else if (category === "enemy") {
      ok = (disp !== attackerDisp) || (disp === 0);
    } else if (category === "self") {
      ok = c.id === attackerSnapshot?.combatantId;
    }
    if (!ok) continue;
    out.push(Object.freeze({
      combatantId: c.id,
      tokenId: token.id,
      tokenUuid: token.uuid,
      actorId: actor.id,
      actorUuid: actor.uuid,
      name: actor.name,
      disposition: disp,
      hp,
      maxHp: readPropNum(actor, ["max_hp"]),
      defense: readPropNum(actor, ["defense", "current_def", "def"]),
      magicDefense: readPropNum(actor, ["magic_defense", "current_mdef", "mdef"]),
    }));
  }
  return Object.freeze(out);
}

// Snapshot the action result computed by COMPUTE. Used by CONFIRM + RESOLVE.
export function freezeActionResult(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return Object.freeze(obj.map(freezeActionResult));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = (v && typeof v === "object") ? freezeActionResult(v) : v;
  }
  return Object.freeze(out);
}

// Re-read live actor HP/MP. Used when the snapshot is stale (rare in v1).
export function readLiveResources(actor) {
  if (!actor) return null;
  try {
    return {
      hp: readPropNum(actor, ["current_hp", "hp"]),
      maxHp: readPropNum(actor, ["max_hp"]),
      mp: readPropNum(actor, ["current_mp", "mp"]),
      maxMp: readPropNum(actor, ["max_mp"]),
    };
  } catch (e) {
    warn("readLiveResources failed", e);
    return null;
  }
}
