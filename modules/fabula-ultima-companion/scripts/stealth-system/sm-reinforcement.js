// ============================================================================
// Stealth Mode — reinforcements.
//
// While the Alert tier holds, one more guard arrives each Enemy Phase, capped
// per round and in total. Dropping back below Alert stops the spawning, but
// anyone already on the map stays — which is what gives clearing an alarm a
// cost that outlives the alarm itself.
//
// Reinforcements enter already in SEARCH, heading for the party's last known
// cell. Arriving in PATROL would make them decorative: the point of the Alert
// tier is pressure, and a guard who strolls a route while the alarm rings is
// not pressure.
// ============================================================================

import { TAG, AI } from "./sm-constants.js";
import {
  cellOfToken, topLeftOf, cellDistance, cellKey, neighbours as neighboursOf,
} from "./sm-grid.js";
import {
  cellRecord, syncOccupancy, invalidateLattice, getLattice, connectedCells,
} from "./sm-lattice.js";
import { emptyEnemy, pushLog, enemyRecords } from "./sm-state.js";
import { readSceneConfig } from "./sm-handlers.js";

/**
 * Draw one actor from the scene's reinforcement table.
 * Falls back to cloning an existing enemy, so a scene with no table configured
 * still functions rather than silently never reinforcing.
 */
async function pickReinforcementActor(sm, cfg) {
  const uuid = cfg.reinforcementTable;
  if (uuid) {
    try {
      const table = await fromUuid(uuid);
      if (table) {
        const draw = await table.draw({ displayChat: false });
        const result = draw?.results?.[0];
        const docUuid = result?.documentUuid
          ?? (result?.documentCollection && result?.documentId
              ? `${result.documentCollection}.${result.documentId}` : null);
        if (docUuid) {
          const actor = await fromUuid(docUuid);
          if (actor) return actor;
        }
      }
    } catch (e) {
      console.warn(TAG, "reinforcement table draw failed:", e);
    }
  }

  // Fallback: whatever kind of guard this map already uses.
  const existing = enemyRecords(sm)[0];
  const tokenDoc = existing ? canvas?.scene?.tokens?.get?.(existing.tokenId) : null;
  return tokenDoc?.actor ?? null;
}

/**
 * Where a reinforcement walks in.
 *
 * Authored spawn points win. With none configured we fall back to the passable
 * cell FURTHEST from the party — a guard materialising in the party's lap is
 * indistinguishable from a bug, and the failure should look like a long walk,
 * not an ambush nobody designed.
 */
/** Every teleporter tile on the scene, as passable cells. */
function teleporterCells(scene) {
  const TP = globalThis.TeleporterSystem?.api;
  if (!TP?.isTeleporterEnabled) return [];
  const gs = canvas?.grid?.size ?? 100;
  const out = [];
  for (const t of (scene?.tiles ?? [])) {
    if (t.hidden) continue;
    if (!TP.isTeleporterEnabled(t)) continue;
    const o = canvas?.grid?.getOffset?.({
      x: t.x + (t.width || gs) / 2,
      y: t.y + (t.height || gs) / 2,
    });
    if (o) out.push({ i: o.i, j: o.j });
  }
  return out;
}

function pickSpawnCell(sm, cfg, scene) {
  const partyCell = sm.party.cell;
  const free = (c) => {
    const rec = cellRecord(c, scene);
    return rec?.passable && !rec.occupant;
  };

  // ── Teleporters first ────────────────────────────────────────────────────
  // Reinforcements come from somewhere. A teleporter is the one thing on the
  // map that visibly explains how a guard arrived, so if the scene has any,
  // the NEAREST one to the party is where the response comes through — which
  // also makes a teleporter a piece of terrain the party has a reason to
  // watch, avoid, or block.
  const region = connectedCells(partyCell, { scene });
  const inRegion = (c) => region.has(`${c.i},${c.j}`);

  // A teleporter pad is exempt from the connectivity rule: crossing a wall is
  // the entire point of one, so a pad in a sealed room is a legitimate way in.
  const pads = teleporterCells(scene).filter(free);
  if (pads.length) {
    return pads
      .map((c) => ({ c, d: cellDistance(c, partyCell, scene) }))
      .sort((a, b) => a.d - b.d)[0].c;
  }

  const authored = (cfg.spawnPoints ?? []).filter((c) => free(c) && inRegion(c));

  if (authored.length) {
    // The nearest authored point that is not right on top of the party — the
    // GM placed these deliberately, so respect them, just not absurdly.
    const ranked = authored
      .map((c) => ({ c, d: cellDistance(c, partyCell, scene) }))
      .filter((r) => r.d >= 3)
      .sort((a, b) => a.d - b.d);
    if (ranked.length) return ranked[0].c;
    return authored[0];
  }

  // Furthest CONNECTED cell — not simply furthest.
  //
  // A map can have regions a wall seals off entirely, and picking by distance
  // alone will happily choose one: the guard appears, is visibly present, and
  // can never take a single step toward the party. Seen live on a map whose
  // outer band was walled off from the play area. Flooding from the party
  // first guarantees whatever we pick can actually walk here.
  const reachableSet = connectedCells(partyCell, { scene });
  let best = null;
  let bestD = -Infinity;
  for (const cell of reachableSet.values()) {
    const rec = cellRecord(cell, scene);
    if (!rec || rec.occupant) continue;
    const d = cellDistance(cell, partyCell, scene);
    if (d > bestD) { bestD = d; best = cell; }
  }

  // Nowhere connected and free at all (a one-tile closet, everything occupied):
  // better to arrive right beside the party than not at all — a reinforcement
  // that never spawns is an Alert tier that silently stops escalating.
  if (!best) {
    for (const { cell } of neighboursOf(partyCell, scene)) {
      const rec = cellRecord(cell, scene);
      if (rec?.passable && !rec.occupant) return cell;
    }
  }
  return best;
}

/**
 * Spawn one reinforcement if the caps allow.
 * @returns {Promise<{spawned:boolean, name?:string, tokenId?:string, reason?:string}>}
 */
export async function spawnReinforcement(sm, tune, { scene = canvas?.scene } = {}) {
  const r = sm.reinforcements ?? (sm.reinforcements = { spawned: 0, thisRound: 0 });

  if (r.thisRound >= tune.reinforcePerRound) return { spawned: false, reason: "round cap" };
  if (r.spawned >= tune.reinforceMax)        return { spawned: false, reason: "total cap" };

  const cfg = readSceneConfig(scene);
  const actor = await pickReinforcementActor(sm, cfg);
  if (!actor) return { spawned: false, reason: "no actor available" };

  const cell = pickSpawnCell(sm, cfg, scene) ?? sm.party.cell;
  const p = topLeftOf(cell);

  let created;
  try {
    const proto = actor.prototypeToken?.toObject?.() ?? {};
    created = await scene.createEmbeddedDocuments("Token", [{
      ...proto,
      name: actor.name,
      actorId: actor.id,
      actorLink: false,
      x: p.x, y: p.y,
      hidden: false,
      disposition: -1,
      flags: { "fabula-ultima-companion": { stealthReinforcement: true } },
    }]);
  } catch (e) {
    console.error(TAG, "reinforcement token create failed", e);
    return { spawned: false, reason: String(e?.message ?? e) };
  }

  const tokenDoc = created?.[0];
  if (!tokenDoc) return { spawned: false, reason: "no token created" };

  const rec = emptyEnemy(tokenDoc.id, cellOfToken(tokenDoc), "S");
  rec.name = tokenDoc.name;
  rec.reinforcement = true;
  // Arrives hunting, not strolling.
  rec.ai = AI.SEARCH;
  rec.awareness = tune.searchAt;
  rec.lastKnownCell = sm.party.cell;
  sm.enemies[tokenDoc.id] = rec;

  r.spawned += 1;
  r.thisRound += 1;

  invalidateLattice();
  syncOccupancy(scene);
  pushLog(sm, `Reinforcement: ${tokenDoc.name} at ${cell.i},${cell.j}`);

  return { spawned: true, name: tokenDoc.name, tokenId: tokenDoc.id, cell };
}

/**
 * Remove tokens this system spawned. Called on teardown so an abandoned
 * infiltration does not leave a scene permanently more crowded than authored.
 */
export async function clearReinforcements(scene = canvas?.scene) {
  const ids = (scene?.tokens ?? [])
    .filter((t) => t.flags?.["fabula-ultima-companion"]?.stealthReinforcement)
    .map((t) => t.id);
  if (!ids.length) return 0;
  try {
    await scene.deleteEmbeddedDocuments("Token", ids);
  } catch (e) {
    console.warn(TAG, "reinforcement cleanup failed:", e);
    return 0;
  }
  return ids.length;
}
