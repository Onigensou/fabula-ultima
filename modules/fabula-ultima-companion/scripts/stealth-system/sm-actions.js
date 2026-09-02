// ============================================================================
// Stealth Mode — Objective actions, Takedown, and the EXP ledger.
//
// One Objective slot per Player Phase. The pool is data-driven exactly as the
// Battle Director's is — every option is a CSB Item flagged
// `coreAction: "objective:<id>"` — so cost, target, attributes and DL are
// authored content rather than code. What lives here is the behaviour an
// option needs that a generic effect table cannot express: a dynamic DL, a
// silent defeat, an alert shift.
//
// The freeform space is `objective:custom`, which already ships: no fixed
// attributes, the GM picks the pair and the DL from what the player describes.
// That is the "what do you want to do this turn" slot, and it needed no code.
// ============================================================================

import {
  MODULE_ID, TAG, ALERT, OBJECTIVE, ARC, HOOKS,
} from "./sm-constants.js";
import { cellDistance, relativeArc, directionBetween } from "./sm-grid.js";
import { cellRecord, invalidateLattice, propConfigOf, TILE_FLAG } from "./sm-lattice.js";
import {
  shiftAlert, bankTakedown, pushLog, awareEnemies, enemyRecords, bumpAwareness,
} from "./sm-state.js";

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ── Takedown ────────────────────────────────────────────────────────────────

/**
 * Is a Takedown legal against this enemy right now, and at what DL?
 *
 * Legality: Stealth or Neutral only, adjacent only, and never from the enemy's
 * front arc. Walking up to a guard's face and garrotting them is not stealth,
 * it is a fight you chose to start standing still.
 *
 * @returns {{ok:boolean, reason?:string, dl?:number, arc?:string, breakdown?:object}}
 */
export function takedownCheck(state, enemy, partyCell, controllerActor, tune, {
  scene = canvas?.scene,
} = {}) {
  if (state.alert === ALERT.ALERT) {
    return { ok: false, reason: "The room is on alert — nobody is off their guard." };
  }
  if (!enemy || enemy.defeated) return { ok: false, reason: "No target." };

  const dist = cellDistance(partyCell, enemy.cell, scene);
  if (dist > 1) return { ok: false, reason: "You must be adjacent." };

  // Arc is measured from the ENEMY's facing toward the party.
  const arc = relativeArc(enemy.cell, enemy.facing, partyCell, tune.coneHalfAngle);
  if (arc === ARC.FRONT) return { ok: false, reason: "They are facing you." };

  const targetActor = game.actors?.get?.(tokenActorId(enemy.tokenId, scene));
  const targetLevel = num(targetActor?.system?.props?.level, 1);
  const rank = String(targetActor?.system?.props?.npc_rank ?? "soldier").toLowerCase();
  const ctrlLevel = num(controllerActor?.system?.props?.level, 1);

  const rankDl = num(tune.takedownRankDl?.[rank], 0);
  const levelTerm = tune.takedownLevelCoef * (targetLevel - ctrlLevel);
  const arcBonus = arc === ARC.REAR ? tune.takedownRearBonus : 0;
  const stealthBonus = state.alert === ALERT.STEALTH ? tune.takedownStealthBonus : 0;

  // The brief's flat +1 during Stealth is applied as a -1 to DL. Same thing,
  // and it keeps every term in this sum pointing one direction.
  const raw = tune.takedownBaseDl + rankDl + levelTerm - arcBonus - stealthBonus;
  const dl = Math.round(Math.min(tune.takedownDlMax, Math.max(tune.takedownDlMin, raw)));

  return {
    ok: true, dl, arc,
    targetActor, targetLevel, rank,
    breakdown: { base: tune.takedownBaseDl, rankDl, levelTerm, arcBonus, stealthBonus, raw, dl },
  };
}

function tokenActorId(tokenId, scene = canvas?.scene) {
  return scene?.tokens?.get?.(tokenId)?.actorId ?? null;
}

/**
 * Resolve a Takedown. GM-side.
 *
 * On success the enemy leaves the map and is banked in the ledger. On failure
 * the guard reacts and contact follows — but at whatever tier the failure
 * produced, NOT a forced ambush. A botched takedown from Stealth still opens
 * with Advantage; punishing the fumble twice would make the option unusable.
 */
export async function resolveTakedown(state, enemy, controllerActor, tune, {
  scene = canvas?.scene, partyCell,
} = {}) {
  const gate = takedownCheck(state, enemy, partyCell, controllerActor, tune, { scene });
  if (!gate.ok) return { ok: false, reason: gate.reason };

  const CR = globalThis.ONI?.CheckRequester;
  if (!CR?.requestOne) return { ok: false, reason: "Check Requester unavailable." };

  const res = await CR.requestOne(controllerActor, {
    attrA: "DEX", attrB: "INS",
    dl: gate.dl,
    label: `Takedown — ${enemy.name ?? "guard"} (${gate.arc})`,
    mode: "interactive",
    allowInvokes: true,
    postChat: true,
    context: { system: "stealth", kind: "takedown", enemyId: enemy.tokenId },
  });

  const passed = !!res?.pass;

  if (passed) {
    enemy.defeated = true;
    const actor = gate.targetActor;
    bankTakedown(state, {
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? enemy.name ?? "Unknown",
      tokenId: enemy.tokenId,
      cell: enemy.cell,
    });

    // A missing guard is itself a stimulus. Anyone who reaches the empty post
    // raises the alarm — which is what stops a stealth run being a free win.
    for (const other of enemyRecords(state)) {
      if (other.tokenId === enemy.tokenId) continue;
      if (cellDistance(other.cell, enemy.cell, scene) <= tune.suspicionRadius) {
        bumpAwareness(state, other.tokenId, 1, tune, enemy.cell);
      }
    }

    try { Hooks.callAll(HOOKS.TAKEDOWN, { enemyId: enemy.tokenId, dl: gate.dl }); } catch (_) {}
    pushLog(state, `Takedown succeeded on ${actor?.name ?? enemy.tokenId} (DL ${gate.dl})`);
    return { ok: true, passed: true, dl: gate.dl, roll: res };
  }

  bumpAwareness(state, enemy.tokenId, tune.awarenessMax, tune, partyCell);
  shiftAlert(state, 1, "failed takedown");
  pushLog(state, `Takedown FAILED on ${enemy.tokenId} (DL ${gate.dl})`);
  return { ok: true, passed: false, dl: gate.dl, roll: res, contact: true };
}

// ── The EXP ledger ──────────────────────────────────────────────────────────

/**
 * Pay out every banked takedown as ONE virtual encounter.
 *
 * Batching is not an optimisation, it is the balance. Paying each kill out at
 * the moment it happens would give every one of them the full first-enemy
 * weight (1.00) AND its own EXP floor, so six guards picked off individually
 * would out-earn the same six fought together — the exact inverse of the
 * intent. Running the whole banked list through the shared formula at once
 * applies the diminishing weights and the single clamp exactly as a fight does.
 *
 * The multiplier lands BEFORE the clamp, with its own lower floor, so the
 * discount survives on small hauls instead of being swallowed by the floor of 1.
 */
export async function settleLedger(state, partyActors, tune, { source = "Stealth Takedown" } = {}) {
  const core = globalThis["oni.ExpCore"];
  if (!core?.computeExpAward || !core?.applyExpAward) {
    console.warn(TAG, "exp core unavailable — ledger not settled.");
    return { ok: false, reason: "no-exp-core" };
  }
  if (!state.ledger?.length) return { ok: true, skipped: true, entries: [] };
  if (!partyActors?.length) return { ok: false, reason: "no-party" };

  const enemyActors = state.ledger
    .map((row) => game.actors?.get?.(row.actorId))
    .filter(Boolean);

  if (!enemyActors.length) {
    state.ledger = [];
    return { ok: true, skipped: true, entries: [] };
  }

  const { expByActorId } = await core.computeExpAward({
    partyActors,
    enemyActors,
    isBoss: false,
    mult: tune.takedownExpMult,
    floor: tune.takedownExpFloor,
  });

  const res = await core.applyExpAward({
    amountByActorId: expByActorId,
    source,
    playUi: true,   // the standalone award panel — this IS the presentation here
  });

  pushLog(state, `Ledger settled: ${enemyActors.length} takedown(s) → EXP awarded`);
  state.ledger = [];
  return res;
}

// ── Hide ────────────────────────────────────────────────────────────────────

/**
 * Lower the alert tier by one on a successful check.
 * DL scales with how many enemies currently hold awareness — how hot the room
 * is, not how hot it was when you walked in.
 */
export async function resolveHide(state, controllerActor, partyCell, tune, {
  scene = canvas?.scene, inActiveCone = false,
} = {}) {
  if (inActiveCone) {
    return { ok: false, reason: "You cannot hide while someone is looking straight at you." };
  }
  if (state.alert === ALERT.STEALTH) {
    return { ok: false, reason: "You are already unseen." };
  }

  const CR = globalThis.ONI?.CheckRequester;
  if (!CR?.requestOne) return { ok: false, reason: "Check Requester unavailable." };

  const aware = awareEnemies(state, 1).length;
  const cover = !!cellRecord(partyCell, scene)?.cover;
  const dl = Math.max(
    5,
    tune.hideBaseDl + aware * tune.hideDlPerAwareEnemy - (cover ? tune.hideCoverBonus : 0),
  );

  const res = await CR.requestOne(controllerActor, {
    attrA: "DEX", attrB: "INS",
    dl,
    label: `Hide${cover ? " (in cover)" : ""}`,
    mode: "interactive", allowInvokes: true, postChat: true,
    context: { system: "stealth", kind: "hide" },
  });

  if (res?.pass) {
    shiftAlert(state, -1, "hide");
    // Cooling the room means cooling the guards; leaving them hot would make
    // the tier drop cosmetic.
    for (const e of enemyRecords(state)) {
      e.awareness = Math.max(0, e.awareness - 2);
    }
    return { ok: true, passed: true, dl, roll: res };
  }

  pushLog(state, `Hide failed (DL ${dl})`);
  return { ok: true, passed: false, dl, roll: res };
}

// ── Scan ────────────────────────────────────────────────────────────────────

/** Reveal enemy positions, facings and AI states within a radius. */
export function resolveScan(state, partyCell, tune, { scene = canvas?.scene } = {}) {
  const radius = tune.visionRange + 2;
  const found = enemyRecords(state)
    .filter((e) => cellDistance(e.cell, partyCell, scene) <= radius)
    .map((e) => ({
      tokenId: e.tokenId,
      cell: e.cell,
      facing: e.facing,
      ai: e.ai,
      awareness: e.awareness,
      distance: cellDistance(e.cell, partyCell, scene),
    }))
    .sort((a, b) => a.distance - b.distance);

  pushLog(state, `Scan revealed ${found.length} enemy position(s)`);
  return { ok: true, found, radius };
}

// ── Diversion ───────────────────────────────────────────────────────────────

/**
 * Plant a false lead: enemies in earshot have their last-known cell moved to
 * `targetCell` and go looking there. The clean counter to a cone you cannot
 * walk around.
 */
export function resolveDiversion(state, targetCell, partyCell, tune, {
  scene = canvas?.scene, radius = null,
} = {}) {
  const r = radius ?? tune.suspicionRadius + 2;
  const pulled = [];

  for (const e of enemyRecords(state)) {
    if (cellDistance(e.cell, targetCell, scene) > r) continue;
    e.lastKnownCell = targetCell;
    e.searchRounds = 0;
    // A diversion must not out-shout a guard that can literally see you.
    if (e.ai !== "chase") {
      e.ai = "search";
      e.awareness = Math.max(e.awareness, tune.searchAt);
    }
    pulled.push(e.tokenId);
  }

  pushLog(state, `Diversion at ${targetCell.i},${targetCell.j} pulled ${pulled.length} enemy(ies)`);
  return { ok: true, pulled, targetCell };
}

// ── Props: move and break ───────────────────────────────────────────────────

/** Shove a movable prop one cell. Opens or closes a lane; makes noise. */
export async function resolveMoveObject(state, tileDoc, toCell, tune, { scene = canvas?.scene } = {}) {
  const cfg = propConfigOf(tileDoc);
  if (!cfg) return { ok: false, reason: "That is not a stealth prop." };
  if (!cfg.movable) return { ok: false, reason: "That will not budge." };

  const { topLeftOf } = await import("./sm-grid.js");
  const p = topLeftOf(toCell);
  await tileDoc.update({ x: p.x, y: p.y }, { stealthAuthorised: true });
  invalidateLattice();

  pushLog(state, `Moved ${cfg.label || "a prop"}`);
  return { ok: true, noisy: true };
}

/** Destroy a destructible prop. Loud, and permanent for the scene. */
export async function resolveBreakCover(state, tileDoc, tune, { scene = canvas?.scene } = {}) {
  const cfg = propConfigOf(tileDoc);
  if (!cfg) return { ok: false, reason: "That is not a stealth prop." };
  if (!cfg.destructible) return { ok: false, reason: "That will not break." };

  await tileDoc.update({ hidden: true });
  invalidateLattice();

  pushLog(state, `Broke ${cfg.label || "cover"}`);
  return { ok: true, noisy: true };
}

// ── Noise ───────────────────────────────────────────────────────────────────

/**
 * A loud act. Nearby enemies gain awareness, and the tier may rise.
 *
 * Chance-based rather than certain: a guaranteed alert on every Dash makes
 * Dash unusable, and a free Dash makes the Alert tier survivable by simply
 * running. The knob is where that argument gets settled.
 */
export function makeNoise(state, atCell, tune, { scene = canvas?.scene, strength = 1, reason = "noise" } = {}) {
  const heard = [];
  for (const e of enemyRecords(state)) {
    if (cellDistance(e.cell, atCell, scene) > tune.suspicionRadius + strength) continue;
    bumpAwareness(state, e.tokenId, strength, tune, atCell);
    heard.push(e.tokenId);
  }

  let raised = null;
  if (heard.length && Math.random() < tune.noiseAlertChance) {
    raised = shiftAlert(state, 1, reason);
  }

  return { heard, raised };
}
