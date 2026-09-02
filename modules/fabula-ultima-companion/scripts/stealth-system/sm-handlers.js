// ============================================================================
// Stealth Mode — state handlers. What each FSM state actually does.
//
// Every handler runs on the GM inside the director's serial queue, so each one
// may read-modify-write `ctx.sm` freely and save at the end without racing the
// next event.
// ============================================================================

import { TAG, ALERT, ALERT_ORDER, AI, HOOKS, MSG } from "./sm-constants.js";
import { S, E } from "./sm-states.js";
import {
  cellOfToken, cellDistance, directionBetween, sameCell, cellKey, topLeftOf, centerOf,
} from "./sm-grid.js";
import {
  buildLattice, syncOccupancy, invalidateLattice, reachable, cellRecord,
} from "./sm-lattice.js";
import { evaluateSight, surveyObservers } from "./sm-vision.js";
import {
  emptyEnemy, shiftAlert, bumpAwareness, decayAwareness, enemyRecords,
  pendingActivations, markActivated, resetRoundCounters, pushLog, isAlert,
  engagementFor, writeState, concealTier, breakConcealment, tickConcealment,
} from "./sm-state.js";
import {
  decideActivation, pickActivation, truncateAtContact, conflictParticipants,
} from "./sm-enemy-ai.js";
import { settleLedger, makeNoise } from "./sm-actions.js";
import { spawnReinforcement } from "./sm-reinforcement.js";
import { launchConflict } from "./sm-conflict.js";
import {
  broadcastState, broadcastOverlay, broadcastMotion, broadcastBanner, broadcastDetection,
} from "./sm-socket.js";
import { walkToken } from "./sm-motion.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Party token resolution ──────────────────────────────────────────────────

/**
 * The one central party token. Same model as Exploration mode — the party
 * moves as a single piece with a designated leader, not four tokens.
 */
export function findPartyToken(scene = canvas?.scene) {
  const mc = globalThis.FUCompanion?.api?.MovementControl;
  const snap = mc?.getLastSnapshot?.();
  const id = snap?.centralPartyTokenData?.tokenId;
  if (id) {
    const t = scene?.tokens?.get?.(id);
    if (t) return t;
  }
  // Fallback: the friendly token the players own. Better than failing to start.
  return scene?.tokens?.find?.((t) => t.disposition === 1 && !t.hidden) ?? null;
}

/** The actor whose stats every check this round uses. */
export function controllerActor(sm) {
  const id = sm?.party?.controllerActorId;
  return id ? game.actors?.get?.(id) ?? null : null;
}

/**
 * The party actors — EXP payout, and the helper pool for a Hide group check.
 *
 * MovementControl's resolver first, because reading `member_id_*` off the DB
 * directly under-reports: on this world only slot 1 resolves to an actor while
 * MovementControl finds all four members. Note the field names — the actor is
 * on `partyMemberActorId`, NOT `actorId`; the obvious name is undefined on
 * every row and fails silently.
 */
export async function partyActors() {
  const out = [];
  const seen = new Set();

  try {
    const rows = (await globalThis.FUCompanion?.api?.MovementControl
      ?.getEligibleControllers?.({ onlineOnly: false, includeGM: false })) ?? [];
    for (const r of rows) {
      const a = game.actors?.get?.(r.partyMemberActorId);
      if (a && !seen.has(a.id)) { seen.add(a.id); out.push(a); }
    }
  } catch (e) {
    console.warn(TAG, "MovementControl party resolve failed:", e);
  }

  if (!out.length) {
    try {
      const { source: db } = (await globalThis.FUCompanion?.api?.getCurrentGameDb?.()) ?? {};
      const props = db?.system?.props ?? {};
      for (const [k, v] of Object.entries(props)) {
        if (!String(k).startsWith("member_id_")) continue;
        const a = game.actors?.get?.(String(v));
        if (a && !seen.has(a.id)) { seen.add(a.id); out.push(a); }
      }
    } catch (e) {
      console.warn(TAG, "party DB resolve failed:", e);
    }
  }

  if (out.length) return out;
  return game.actors?.filter?.((a) => a.hasPlayerOwner && a.type === "character") ?? [];
}

// ── Enemy adoption ──────────────────────────────────────────────────────────

/**
 * Adopt the scene's hostile tokens into the state model.
 *
 * Enemies are ordinary tokens the GM placed by hand — 17 of them on the
 * prototype map — so authoring a patrol stays "drag a token", and this layer
 * only adds what a token cannot carry: an AI state, an awareness meter and a
 * last-known-position.
 */
function adoptEnemies(sm, scene, config) {
  const facings = config.facings ?? {};
  const routes = config.routes ?? {};

  for (const tokenDoc of (scene?.tokens ?? [])) {
    if (tokenDoc.disposition !== -1) continue;
    if (tokenDoc.hidden) continue;

    const id = tokenDoc.id;
    const cell = cellOfToken(tokenDoc);
    if (sm.enemies[id]) {
      // Already known — refresh position only, so a GM nudging a token between
      // rounds does not wipe its awareness.
      sm.enemies[id].cell = cell;
      continue;
    }

    const rec = emptyEnemy(id, cell, facings[id] ?? "S");
    rec.name = tokenDoc.name;
    // A route's first waypoint is where the guard walks to first, so a guard
    // authored with a route starts facing it.
    const route = routes[id];
    if (route?.length) rec.facing = directionBetween(cell, route[0]) ?? rec.facing;
    sm.enemies[id] = rec;
  }

  // Drop records for tokens that no longer exist (deleted between sessions).
  for (const id of Object.keys(sm.enemies)) {
    if (!scene?.tokens?.get?.(id)) delete sm.enemies[id];
  }
}

// ── Detection sweep ─────────────────────────────────────────────────────────

/**
 * Run every enemy's eyes against the party's current cell.
 *
 * Called after EVERY cell entered during a move, not once at the end. That is
 * what makes walking into a cone stop you at its edge instead of three cells
 * past it.
 *
 * @returns {{spotted:boolean, seenBy:string[], raised:object|null}}
 */
export function detectionSweep(ctx, partyCell) {
  const { sm, tune, scene } = ctx;

  const observers = enemyRecords(sm).map((e) => ({
    tokenId: e.tokenId, cell: e.cell, facing: e.facing,
  }));

  const survey = surveyObservers(observers, partyCell, tune, {
    scene, concealTier: concealTier(sm),
  });
  const seenBy = [];
  const newMarks = [];
  let raised = null;

  for (const row of survey.results) {
    const sight = row.sight;
    if (!sight.seen) continue;
    const e = sm.enemies[row.tokenId];
    if (!e) continue;

    seenBy.push(row.tokenId);
    bumpAwareness(sm, row.tokenId, Math.max(1, sight.awareness), tune, partyCell);

    if (sight.spotted) {
      // Seen outright. The alarm goes straight to ALERT — walking the tier up
      // one notch at a time when a guard is staring at you from two tiles away
      // just meant the party got spotted twice for the same mistake.
      e.mark = "spot";
      e.markAt = sm.round;
      if (!e.raisedOnce) { e.raisedOnce = true; newMarks.push({ id: e.tokenId, kind: "spot" }); }
      else newMarks.push({ id: e.tokenId, kind: "spot" });

      // Concealment is about not being FOUND, not invisibility. A guard at
      // spotted range with clear sight sees you regardless.
      breakConcealment(sm, "seen outright");
      if (sm.alert !== ALERT.ALERT) {
        raised = shiftAlert(sm, ALERT_ORDER.length, "spotted outright");
      }
      try { Hooks.callAll(HOOKS.ENEMY_SPOTTED, { cell: partyCell, by: [row.tokenId] }); } catch (_) {}
      continue;
    }

    // Suspicious. Costs ONE tier the first time THIS guard notices anything,
    // and nothing thereafter — otherwise crossing a long cone ratchets the
    // alarm once per cell and the party is punished for a single mistake five
    // times over. The latch clears when the guard gives up and returns to
    // patrol, so a second, separate approach still costs again.
    e.mark = "suspect";
    e.markAt = sm.round;
    if (!e.raisedOnce) {
      e.raisedOnce = true;
      newMarks.push({ id: e.tokenId, kind: "suspect" });
      raised = shiftAlert(sm, 1, "something noticed") ?? raised;
    }
  }

  return { spotted: survey.anySpotted, seenBy, raised, marks: newMarks, survey };
}

// ── Handlers ────────────────────────────────────────────────────────────────

export function buildHandlers() {
  return {

    // ── PREP ──────────────────────────────────────────────────────────────
    async [S.PREP](ctx) {
      const { sm, scene } = ctx;

      invalidateLattice();
      buildLattice(scene);
      syncOccupancy(scene);

      const cfg = readSceneConfig(scene);
      sm.__config = cfg;

      const partyToken = findPartyToken(scene);
      if (!partyToken) {
        ui.notifications?.error?.("Stealth: no party token on this scene.");
        return ctx.dispatch(E.ABORT);
      }

      sm.party.tokenId = partyToken.id;
      sm.party.cell = cellOfToken(partyToken);

      adoptEnemies(sm, scene, cfg);

      if (!sm.round) sm.round = 0;
      pushLog(sm, `Stealth started — ${Object.keys(sm.enemies).length} enemies`);

      await ctx.save();
      broadcastState(sm);
      return ctx.dispatch(E.DONE);
    },

    // ── ROUND_START ───────────────────────────────────────────────────────
    async [S.ROUND_START](ctx) {
      const { sm } = ctx;
      sm.round += 1;
      resetRoundCounters(sm);

      try { Hooks.callAll(HOOKS.ROUND_START, { round: sm.round, alert: sm.alert }); } catch (_) {}
      pushLog(sm, `── Round ${sm.round} (${sm.alert}) ──`);

      await ctx.save();
      broadcastState(sm);
      return ctx.dispatch(E.DONE);
    },

    // ── PLAYER_START ──────────────────────────────────────────────────────
    async [S.PLAYER_START](ctx) {
      const { sm, tune, scene } = ctx;

      broadcastBanner("player");

      syncOccupancy(scene);
      const token = scene?.tokens?.get?.(sm.party.tokenId);
      if (token) sm.party.cell = cellOfToken(token);

      sm.party.moveLeft = tune.partyMove;
      sm.party.objectiveUsed = false;

      await ctx.save();
      broadcastState(sm);
      return ctx.dispatch(E.DONE);
    },

    // ── CONTROLLER_PICK ───────────────────────────────────────────────────
    // The brief: at the start of the Player Phase the party decides who leads,
    // and that actor's stats carry every check for the round. Kept as its own
    // state so the choice cannot be revisited after a bad roll.
    async [S.CONTROLLER_PICK](ctx) {
      const { sm } = ctx;

      if (!sm.party.controllerActorId) {
        const mc = globalThis.FUCompanion?.api?.MovementControl;
        try {
          const info = await mc?.getEffectiveControllerInfo?.();
          const actorId = info?.controller?.actorId ?? info?.snapshot?.currentGameActorId ?? null;
          if (actorId) sm.party.controllerActorId = actorId;
        } catch (_) { /* the UI can still set one */ }
      }

      await ctx.save();
      broadcastState(sm);
      // The command UI opens on ACTION; picking is offered there as a free
      // Switch, so we do not block the turn waiting for a decision nobody
      // needs to change.
      return ctx.dispatch(E.DONE);
    },

    // ── ACTION ────────────────────────────────────────────────────────────
    // Passive: the command UI is up and the director is waiting. Intents
    // arrive from the controller's client via the socket.
    async [S.ACTION](ctx) {
      broadcastState(ctx.sm);
    },

    // ── RESOLUTION ────────────────────────────────────────────────────────
    async [S.RESOLUTION](ctx, payload) {
      const { sm, tune, scene } = ctx;

      // A move arrives as a path; detection is evaluated per cell entered and
      // the walk STOPS at the cell that got them spotted.
      if (payload?.kind === "move" && Array.isArray(payload.path)) {
        const token = scene?.tokens?.get?.(sm.party.tokenId);
        let spottedAt = null;

        // Decide the walk BEFORE animating it. Detection is evaluated per cell
        // entered and the walk must stop where the party was spotted, so the
        // cells actually travelled are resolved first and only those are
        // animated. Animating the whole path and rewinding on a spot would
        // show the player a move that never happened.
        // Only a genuine SIGHTING halts the walk. Suspicion registers, marks
        // the guard and may cost a tier, but the party keeps moving — halting
        // on every suspicious cell was what turned crossing one cone into a
        // stop-start loop the player could not escape by moving.
        const walked = [];
        const marks = [];
        for (const cell of payload.path) {
          if (sm.party.moveLeft <= 0) break;

          sm.party.cell = cell;
          sm.party.moveLeft -= 1;
          walked.push(cell);

          const det = detectionSweep(ctx, cell);
          marks.push(...(det.marks ?? []));
          if (det.spotted) { spottedAt = cell; break; }
        }
        if (marks.length) broadcastDetection(marks);

        // One glide, one document write — see sm-motion.
        if (token && walked.length) {
          await walkToken(token, walked, {
            msPerLeg: tune.stepMs,
            broadcast: (p) => broadcastMotion(p),
          });
        }

        // Ordinary movement does NOT break concealment — hiding then slipping
        // away has to work, or the party is pinned by the system meant to free
        // them. But if the hide was made behind cover, walking out of cover is
        // walking out of the thing that was hiding you.
        if (sm.party.conceal?.tier && sm.party.conceal.hidInCover
            && !cellRecord(sm.party.cell, scene)?.cover) {
          breakConcealment(sm, "left cover");
        }

        syncOccupancy(scene);
        await maybeTeleport(ctx);
        try { Hooks.callAll(HOOKS.PARTY_MOVED, { cell: sm.party.cell }); } catch (_) {}

        // No ui.notifications here. Being seen is a thing that happens ON the
        // board — the guard wears an exclamation mark and the alarm sounds.
        // A toast in the corner said the same thing worse, and pulled the
        // player away from the map at the exact moment it mattered.
        if (spottedAt) pushLog(sm, `Spotted at ,`);

        if (payload.noisy) makeNoise(sm, sm.party.cell, tune, { scene, strength: 2, reason: "dash" });
      }

      if (payload?.kind === "objective") {
        sm.party.objectiveUsed = true;
        if (payload.grantMove) sm.party.moveLeft += payload.grantMove;
        if (payload.contact) {
          await ctx.save();
          return ctx.dispatch(E.CONTACT, { cell: sm.party.cell, enemyId: payload.enemyId });
        }
      }

      await ctx.save();
      broadcastState(sm);
      return ctx.dispatch(E.DONE);
    },

    // ── PLAYER_END ────────────────────────────────────────────────────────
    async [S.PLAYER_END](ctx) {
      await ctx.save();
      return ctx.dispatch(E.DONE);
    },

    // ── ENEMY_START ───────────────────────────────────────────────────────
    async [S.ENEMY_START](ctx) {
      const { sm, tune } = ctx;

      broadcastBanner("enemy");
      await sleep(700);   // let the flash land before guards start walking
      const budget = tune.activationsPerRound;
      const used = (sm.activatedThisRound ?? []).length;
      const pending = pendingActivations(sm);

      if (used >= budget || !pending.length) return ctx.dispatch(E.NO_MORE);
      return ctx.dispatch(E.MORE_ENEMIES);
    },

    // ── ACTIVATE ──────────────────────────────────────────────────────────
    async [S.ACTIVATE](ctx) {
      const { sm, tune, scene } = ctx;

      const partyCell = sm.party.cell;
      const enemy = pickActivation(sm, partyCell, { scene });

      if (!enemy) return ctx.dispatch(E.NO_MORE);

      const intent = decideActivation(sm, enemy, partyCell, tune, { scene });
      const { path, contact } = truncateAtContact(intent.path, partyCell, scene);

      enemy.facing = intent.facing;
      if (intent.sawParty) {
        enemy.lastKnownCell = partyCell;
        enemy.lostRounds = 0;
      }

      // Walk it, so the players can watch a guard close in. Same glide the
      // party gets — a guard that teleports cell to cell reads as a bug, and
      // watching one close the distance is most of the tension.
      const tokenDoc = scene?.tokens?.get?.(enemy.tokenId);
      if (path.length) {
        enemy.cell = path[path.length - 1];
        if (tokenDoc) {
          await walkToken(tokenDoc, path, {
            msPerLeg: tune.stepMs,
            sfx: false,   // only the party's own steps are audible
            broadcast: (p) => broadcastMotion(p),
          });
        }
      } else if (intent.move) {
        enemy.cell = intent.move;
      }

      enemy.ai = intent.ai;
      markActivated(sm, enemy.tokenId);
      syncOccupancy(scene);

      if (intent.note) pushLog(sm, `${tokenDoc?.name ?? enemy.tokenId}: ${intent.note}`);

      await ctx.save();
      broadcastState(sm);

      if (contact || intent.contact) {
        return ctx.dispatch(E.CONTACT, { cell: enemy.cell, enemyId: enemy.tokenId });
      }

      const used = (sm.activatedThisRound ?? []).length;
      if (used >= tune.activationsPerRound || !pendingActivations(sm).length) {
        return ctx.dispatch(E.NO_MORE);
      }
      return ctx.dispatch(E.MORE_ENEMIES);
    },

    // ── REINFORCE ─────────────────────────────────────────────────────────
    async [S.REINFORCE](ctx) {
      const { sm, tune, scene } = ctx;

      if (isAlert(sm)) {
        const res = await spawnReinforcement(sm, tune, { scene });
        if (res?.spawned) pushLog(sm, `Reinforcement arrived: ${res.name}`);
      }

      await ctx.save();
      return ctx.dispatch(E.DONE);
    },

    // ── ENEMY_END ─────────────────────────────────────────────────────────
    async [S.ENEMY_END](ctx) {
      const { sm, tune, scene } = ctx;

      // Anyone who saw the party this round keeps their awareness; everyone
      // else cools off, and may drop an AI state on the way.
      const sawIds = new Set();
      for (const e of enemyRecords(sm)) {
        const r = evaluateSight(e.cell, e.facing, sm.party.cell, tune, { scene });
        if (r.seen) { sawIds.add(e.tokenId); e.lastKnownCell = sm.party.cell; }
      }
      decayAwareness(sm, tune, sawIds);
      tickConcealment(sm);

      await ctx.save();
      broadcastState(sm);
      return ctx.dispatch(E.DONE);
    },

    // ── ROUND_END ─────────────────────────────────────────────────────────
    async [S.ROUND_END](ctx) {
      const { sm, tune } = ctx;

      // Optional passive cooling. Off by default — automatic cooling undercuts
      // the tension the mode exists for.
      if (tune.alertDecayRounds > 0 && sm.alert !== ALERT.STEALTH) {
        sm.__quietRounds = (sm.__quietRounds ?? 0) + (enemyRecords(sm).some((e) => e.awareness > 0) ? 0 : 1);
        if (sm.__quietRounds >= tune.alertDecayRounds) {
          shiftAlert(sm, -1, "quiet");
          sm.__quietRounds = 0;
        }
      }

      await ctx.save();
      return ctx.dispatch(E.DONE);
    },

    // ── CONFLICT_HANDOFF ──────────────────────────────────────────────────
    // Contact is enemy-initiated only. Walking up to a guard is the setup for a
    // Takedown, not a mistake — so this is only ever reached from an enemy's
    // activation or a failed Takedown.
    async [S.CONFLICT_HANDOFF](ctx, payload) {
      const { sm, tune, scene } = ctx;

      const atCell = payload?.cell ?? sm.party.cell;
      const participants = conflictParticipants(sm, atCell, tune, { scene });

      pushLog(sm, `Contact — conflict opens as "${engagementFor(sm.alert)}" with ${participants.length} enemy(ies)`);
      try { Hooks.callAll(HOOKS.CONTACT, { cell: atCell, participants: participants.map((p) => p.tokenId) }); } catch (_) {}

      // The banked ledger settles FIRST, so takedown EXP and battle EXP arrive
      // as two clearly-labelled awards rather than one number nobody can audit.
      try {
        const pa = await partyActors();
        await settleLedger(sm, pa, tune);
      } catch (e) {
        console.error(TAG, "ledger settle failed", e);
      }

      await ctx.save();

      try {
        await launchConflict({ sm, tune, scene, participants, atCell });
      } catch (e) {
        console.error(TAG, "conflict launch failed", e);
        ui.notifications?.error?.("Stealth: conflict launch failed — check console.");
      }

      return ctx.dispatch(E.DONE);
    },

    // ── STOPPED ───────────────────────────────────────────────────────────
    async [S.STOPPED](ctx) {
      broadcastState(ctx.sm);
    },
  };
}

// ── Scene authoring config ──────────────────────────────────────────────────

export function readSceneConfig(scene = canvas?.scene) {
  const MODULE_ID = "fabula-ultima-companion";
  const raw = scene?.flags?.[MODULE_ID]?.stealthConfig;
  return {
    routes:      raw?.routes ?? {},       // tokenId → [cell, cell, …]
    facings:     raw?.facings ?? {},      // tokenId → direction key
    spawnPoints: raw?.spawnPoints ?? [],  // [cell, …]
    reinforcementTable: raw?.reinforcementTable ?? null,
    tuning:      raw?.tuning ?? {},
  };
}

// ── Teleporters ─────────────────────────────────────────────────────────────

/**
 * Fire a teleporter the party landed on.
 *
 * The teleporter system's own detector is a per-frame ticker gated to
 * exploration mode, and it reads the token's VISUAL position — which in this
 * mode is a hidden token standing at its old cell while a clone glides. It
 * would never fire here, and making it fire would mean it firing mid-glide.
 *
 * So stealth drives it explicitly: after a committed walk, check the cell the
 * party actually stopped on and call the public API. One trigger, at the one
 * moment the party is genuinely standing there.
 */
export async function maybeTeleport(ctx) {
  const { sm, scene } = ctx;
  const TP = globalThis.TeleporterSystem?.api;
  if (!TP?.teleportToken || !TP?.isTeleporterEnabled) return false;

  const gs = canvas?.grid?.size ?? 100;
  const tokenDoc = scene?.tokens?.get?.(sm.party.tokenId);
  if (!tokenDoc) return false;

  for (const tile of (scene?.tiles ?? [])) {
    if (tile.hidden) continue;
    if (!TP.isTeleporterEnabled(tile)) continue;

    const c = cellOfPointLocal(tile.x + (tile.width || gs) / 2, tile.y + (tile.height || gs) / 2);
    if (!sameCell(c, sm.party.cell)) continue;

    const flags = TP.getFlags(tile);
    const destination = flags?.destination ?? flags?.target ?? null;
    if (!destination) {
      console.warn(TAG, "teleporter tile has no destination", tile.id);
      continue;
    }

    pushLog(sm, "Stepped onto a teleporter");
    try {
      await TP.teleportToken(tokenDoc, destination, { sfxUrl: flags.sfxUrl ?? "" });
    } catch (e) {
      console.error(TAG, "teleport failed", e);
      return false;
    }

    // The token has moved under us — the lattice's occupancy and the party's
    // recorded cell are both stale, and a same-scene hop leaves the rest of
    // the turn running against the wrong position.
    const landed = cellOfToken(scene?.tokens?.get?.(sm.party.tokenId));
    if (landed) sm.party.cell = landed;
    invalidateLattice();
    buildLattice(scene);
    syncOccupancy(scene);
    return true;
  }
  return false;
}

function cellOfPointLocal(x, y) {
  const o = canvas?.grid?.getOffset?.({ x, y });
  return o ? { i: o.i, j: o.j } : { i: 0, j: 0 };
}
