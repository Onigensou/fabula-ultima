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
  MODULE_ID, TAG, ALERT, AI, OBJECTIVE, ARC, HOOKS,
} from "./sm-constants.js";
import { cellDistance, relativeArc, directionBetween } from "./sm-grid.js";
import { cellRecord, invalidateLattice, propConfigOf, TILE_FLAG } from "./sm-lattice.js";
import {
  shiftAlert, bankTakedown, pushLog, awareEnemies, enemyRecords, bumpAwareness,
  concealTierFor, setConcealment, breakConcealment,
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

  // A stupored guard is out of the fiction for the moment — reeling, not
  // standing there waiting to be throttled. Letting the party cash in a free
  // kill on the enemies they just RAN from would turn the escape they bought
  // into a farming loop, which is the opposite of what Stupor is for.
  if ((enemy.stupor ?? 0) > 0) {
    return { ok: false, reason: "They are still reeling — leave them be." };
  }

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
 * Lower the alert tier by one — a party-wide GROUP CHECK, not a solo roll.
 *
 * Hiding is the one objective the whole party does together: everyone has to
 * get out of sight, so one person's brilliance cannot cover for the rest. That
 * is exactly the shape of a Fabula Group Check — the Main Controller leads
 * against the real DL, every other member rolls a support check at the
 * standard helper DL, and each success gives the leader +1.
 *
 * ── The DL, rebalanced for a group ─────────────────────────────────────────
 * A leader now arrives with help, so the old solo numbers would make this
 * trivial. The leader's DL rises with the party size it is being helped by
 * (`hideDlPerHelper`), which keeps the check honest: more bodies mean more
 * help AND more people to hide. Cover and the number of alerted guards still
 * move it, as before.
 *
 * `participantMode: "designated"` on purpose — the "open" mode opens a lobby
 * and waits for players to claim roles, which hangs a solo-GM table and stalls
 * a turn that is already mid-flight.
 */
export async function resolveHide(state, controllerActor, partyCell, tune, {
  scene = canvas?.scene, inActiveCone = false, partyActors = [],
} = {}) {
  if (inActiveCone) {
    return { ok: false, reason: "You cannot hide while someone is looking straight at you." };
  }
  if (state.alert === ALERT.STEALTH) {
    return { ok: false, reason: "You are already unseen." };
  }
  if (!controllerActor) return { ok: false, reason: "No leader assigned." };

  // ── A flat DL per tier ────────────────────────────────────────────────────
  //
  // The stacked version (base + per-aware-enemy + per-helper − cover) reached
  // DL 22 in ordinary play, which is not a check, it is a wall. It also made
  // the number impossible to reason about at the table: nobody could say what
  // hiding cost without doing arithmetic first.
  //
  // One number per alert tier, and the tier already encodes everything the
  // modifiers were groping at — how many guards are up, and how hard they are
  // looking. Cover still helps, because standing behind a crate should.
  const cover = !!cellRecord(partyCell, scene)?.cover;
  const helpers = partyActors.filter((a) => a && a.id !== controllerActor.id);

  const tierDl = tune.hideDlByAlert?.[state.alert] ?? tune.hideDlByAlert?.[ALERT.NEUTRAL] ?? 10;
  const leaderDl = Math.max(5, tierDl - (cover ? tune.hideCoverBonus : 0));

  const GC = globalThis.ONI?.GroupCheck;
  const label = `Hide${cover ? " (in cover)" : ""} — DL ${leaderDl}`;

  // A lone leader has nobody to lead. Fall back to a plain check rather than
  // opening a group check with an empty helper list.
  if (!GC?.request || !helpers.length) {
    const CR = globalThis.ONI?.CheckRequester;
    if (!CR?.requestOne) return { ok: false, reason: "Check Requester unavailable." };
    const solo = await CR.requestOne(controllerActor, {
      attrA: "DEX", attrB: "INS", dl: leaderDl, label,
      mode: "interactive", allowInvokes: true, postChat: true,
      context: { system: "stealth", kind: "hide" },
    });
    return finishHide(state, tune, !!solo?.pass, leaderDl, solo, 0, cover);
  }

  const res = await GC.request({
    leaderUuid: controllerActor.uuid,
    participantMode: "designated",
    helperActorUuids: helpers.map((a) => a.uuid),
    allActorUuids: [controllerActor.uuid, ...helpers.map((a) => a.uuid)],
    helperDl: tune.hideHelperDl,
    leaderDl,
    helperBonus: tune.hideHelperBonus,
    attrA: "DEX", attrB: "INS",
    label,
    allowInvokes: true,
    postChat: true,
  });

  return finishHide(state, tune, !!res?.leaderPass, leaderDl, res, res?.bonus ?? 0, cover);
}

/**
 * Land a Hide result and apply its Concealment.
 *
 * The MARGIN over the DL is what buys the tier — a pass/fail hide makes the
 * roll a formality where the DL is the only lever, while reading the margin
 * turns one roll into a spread of outcomes and gives the Alert-tier DL real
 * work to do: a harder DL now costs you tier as well as chance.
 */
/**
 * A cell roughly `radius` away from `origin`, in a random direction.
 *
 * This is the "general direction" a talked-down hunter walks toward: near
 * enough that the party still has to move, wrong enough that the guard is not
 * marching at their actual tile. Falls back to the origin when the map has
 * nowhere to scatter to, which is correct — in a closet there IS nowhere else
 * to look.
 */
function scatterCell(origin, radius, scene) {
  const ring = [];
  for (let di = -radius; di <= radius; di++) {
    for (let dj = -radius; dj <= radius; dj++) {
      const c = { i: origin.i + di, j: origin.j + dj };
      const d = cellDistance(origin, c, scene);
      if (d < Math.max(1, radius - 1) || d > radius) continue;
      if (cellRecord(c, scene)?.passable) ring.push(c);
    }
  }
  if (!ring.length) return { ...origin };
  return ring[Math.floor(Math.random() * ring.length)];
}

function finishHide(state, tune, passed, dl, roll, bonus = 0, inCover = false) {
  if (!passed) {
    pushLog(state, "Hide failed (DL " + dl + (bonus ? ", +" + bonus + " from helpers" : "") + ")");
    return { ok: true, passed: false, dl, roll, bonus, tier: 0 };
  }

  const total = num(roll?.total ?? roll?.leaderResult?.total, dl);
  const margin = Math.max(0, total - dl);
  const tier = concealTierFor(margin, tune);
  const downgrade = total >= tune.hideDowngradeRoll;

  setConcealment(state, tier, tune, { hidInCover: inCover });
  shiftAlert(state, tier >= 3 ? -tune.concealTier3AlertDrop : -1, "hide");

  // Cooling the room means cooling the guards; leaving them hot would make the
  // tier drop cosmetic — they would simply re-raise it next round.
  for (const e of enemyRecords(state)) {
    e.awareness = Math.max(0, e.awareness - tune.hideAwarenessRelief);

    // Tier 1+: the trail goes cold. A searcher keeps hunting, but for where
    // the party WAS — which is the whole reason last-known-position exists.
    if (e.ai === AI.SEARCH || e.ai === AI.SUSPICIOUS) {
      e.lastKnownCell = e.lastKnownCell ?? state.party.cell;
      e.raisedOnce = false;
    }

    // A strong hide talks the room down. A guard that was CHASING — pathing at
    // your true position every activation, which is unescapable at equal speed
    // — loses the fix and drops to investigating a rough direction instead.
    // Being hunted should be recoverable by hiding well, or hiding is only
    // ever a way to avoid trouble you have not yet found.
    if (downgrade && e.ai === AI.CHASE) {
      e.ai = AI.SUSPICIOUS;
      e.lastKnownCell = scatterCell(state.party.cell, tune.hideScatterRadius, canvas?.scene);
      e.awareness = Math.min(e.awareness, tune.searchAt - 1);
      e.raisedOnce = false;
    }

    // Tier 3: the hunt is called off outright. This is the mode's one way to
    // recover from a botched approach that is not simply running.
    if (tier >= 3 && (e.ai === AI.SEARCH || e.ai === AI.CHASE || e.ai === AI.SUSPICIOUS)) {
      e.ai = AI.PATROL;
      e.awareness = 0;
      e.lastKnownCell = null;
      e.searchRounds = 0;
      e.raisedOnce = false;
    }
  }

  const label = tier >= 3 ? "Vanished" : tier === 2 ? "Well Hidden" : "Concealed";
  pushLog(state, "Hide succeeded — " + label + " (rolled " + total + " vs DL " + dl + ")"
    + (downgrade ? " — hunters lost the trail" : ""));
  return { ok: true, passed: true, dl, roll, bonus, tier, margin, label, total, downgrade };
}

// ── Scan ────────────────────────────────────────────────────────────────────

/**
 * Sweep the surroundings. INS + INS — this is pure perception, so the same
 * attribute twice rather than a pairing that smuggles in agility or nerve.
 *
 * The roll buys RADIUS. A 10 is average and yields the baseline sweep; a great
 * roll reaches most of a room, a poor one barely past arm's length. That makes
 * Scan worth spending an Objective on in a place you cannot see, rather than a
 * flat reveal that is either always or never worth it.
 *
 * What it finds is reported through the FOG: the outlines are drawn on their
 * own layer above it, so the party learns positions they could not see without
 * anything about the scene's real visibility changing. The knowledge expires
 * with the outlines.
 */
export async function resolveScan(state, controllerActor, partyCell, tune, {
  scene = canvas?.scene,
} = {}) {
  const CR = globalThis.ONI?.CheckRequester;

  let roll = null;
  let total = tune.scanAverageRoll;
  if (CR?.requestOne && controllerActor) {
    roll = await CR.requestOne(controllerActor, {
      attrA: "INS", attrB: "INS",
      dl: tune.scanAverageRoll,
      label: "Scan — sweep the surroundings",
      mode: "interactive", allowInvokes: true, postChat: true,
      context: { system: "stealth", kind: "scan" },
    });
    total = num(roll?.total, tune.scanAverageRoll);
  }

  // Radius scales off the roll around the average, clamped so a fumble still
  // tells you something and a crit does not reveal the whole map.
  const radius = Math.max(
    tune.scanRadiusMin,
    Math.min(
      tune.scanRadiusMax,
      Math.round(tune.scanRadiusBase + (total - tune.scanAverageRoll) * tune.scanRadiusPerPoint),
    ),
  );

  const enemies = enemyRecords(state)
    .filter((e) => cellDistance(e.cell, partyCell, scene) <= radius)
    .map((e) => ({
      tokenId: e.tokenId, cell: e.cell, facing: e.facing,
      ai: e.ai, awareness: e.awareness, kind: "enemy",
      distance: cellDistance(e.cell, partyCell, scene),
    }));

  // Props too — the point of scanning a fogged room is learning what is IN it,
  // and a movable crate is as much a discovery as a guard.
  const props = [];
  for (const t of (scene?.tiles ?? [])) {
    if (t.hidden) continue;
    const cfg = propConfigOf(t);
    if (!cfg) continue;
    const gs = canvas?.grid?.size ?? 100;
    const cell = cellOfPoint(t.x + (t.width || gs) / 2, t.y + (t.height || gs) / 2);
    const d = cellDistance(cell, partyCell, scene);
    if (d > radius) continue;
    props.push({ cell, kind: "prop", tileId: t.id, label: cfg.label, distance: d });
  }

  const found = [...enemies, ...props].sort((a, b) => a.distance - b.distance);
  pushLog(state, `Scan (roll ${total}) → radius ${radius}, found ${enemies.length} enemy / ${props.length} prop`);
  return { ok: true, found, enemies, props, radius, roll, total };
}

function cellOfPoint(x, y) {
  const o = canvas?.grid?.getOffset?.({ x, y });
  return o ? { i: o.i, j: o.j } : { i: 0, j: 0 };
}

// ── Dash ────────────────────────────────────────────────────────────────────

/**
 * Spend the Objective to buy movement. MIG + DEX — a burst of speed is legs
 * and lungs, not cunning.
 *
 * The gain is rolled rather than flat so Dash is a gamble rather than a known
 * quantity: at Alert, where Dash is the party's only escape lever, a flat
 * bonus would make escape arithmetic and a rolled one keeps it a decision.
 */
export async function resolveDash(state, controllerActor, tune) {
  const CR = globalThis.ONI?.CheckRequester;

  let roll = null;
  let total = tune.dashAverageRoll;
  if (CR?.requestOne && controllerActor) {
    roll = await CR.requestOne(controllerActor, {
      attrA: "MIG", attrB: "DEX",
      dl: tune.dashAverageRoll,
      label: "Dash — a burst of speed",
      mode: "interactive", allowInvokes: true, postChat: true,
      context: { system: "stealth", kind: "dash" },
    });
    total = num(roll?.total, tune.dashAverageRoll);
  }

  const gain = Math.max(
    tune.dashGainMin,
    Math.min(
      tune.dashGainMax,
      Math.round(tune.dashGainBase + (total - tune.dashAverageRoll) * tune.dashGainPerPoint),
    ),
  );

  pushLog(state, `Dash (roll ${total}) → +${gain} movement`);
  return { ok: true, gain, roll, total };
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
  // The noise has a REACH, and it is the rock's, not the party's.
  //
  // This used to be suspicionRadius + 2, which on the current tuning pulled
  // every guard within five cells — wide enough that a diversion was less a
  // placed distraction than a map-wide summons, and the player had no way to
  // reason about who would answer it. A published radius they can see landing
  // makes the throw a decision about WHICH guard to move.
  const r = radius ?? tune.diversionRadius ?? 3;
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
  // Noise gives you away: whatever you were hiding behind, they heard it.
  breakConcealment(state, reason);
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
