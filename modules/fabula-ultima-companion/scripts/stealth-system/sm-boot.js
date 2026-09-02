// ============================================================================
// Stealth Mode — boot, scene gate, intent routing, public API.
//
// Wires the pieces together and arms the system only on a scene whose mode is
// "stealth". Everything the players click arrives here as an intent, is
// validated against the authoritative state, and is dispatched into the FSM.
//
// ── Validation happens HERE, not in the UI ─────────────────────────────────
// The client's reachable-cell map is a convenience, not a permission. A move
// intent is re-pathed against the GM's own lattice before a single cell is
// walked, so a stale or edited client cannot spend movement it does not have.
// ============================================================================

import {
  MODULE_ID, TAG, SCENE_MODE, FABULA_ROOT_KEY, GENERAL_KEY, SCENE_MODE_KEY,
  TUNING_SETTING, OBJECTIVE, HOOKS, readTuning, ALERT,
} from "./sm-constants.js";
import { S, E } from "./sm-states.js";
import { director } from "./sm-director.js";
import { buildHandlers, findPartyToken, controllerActor, partyActors, detectionSweep } from "./sm-handlers.js";
import {
  readState, writeState, clearState, shiftAlert, pushLog, enemyRecords, isAlert,
  concealTier, breakConcealment, applyStupor,
} from "./sm-state.js";
import { surveyObservers } from "./sm-vision.js";
import {
  cellAt, cellKey, sameCell, cellDistance, cellOfToken,
} from "./sm-grid.js";
import {
  buildLattice, invalidateLattice, syncOccupancy, reachable, pathFromReachable, propConfigOf,
} from "./sm-lattice.js";
import {
  resolveTakedown, resolveHide, resolveScan, resolveDiversion,
  resolveMoveObject, resolveBreakCover, settleLedger, makeNoise, resolveDash,
} from "./sm-actions.js";
import { spawnReinforcement, clearReinforcements } from "./sm-reinforcement.js";
import { decideActivation, pickActivation } from "./sm-enemy-ai.js";
import * as socket from "./sm-socket.js";
import * as smUi from "./sm-ui.js";
import * as overlay from "./sm-overlay.js";
import * as gmPanel from "./sm-gm-panel.js";
import { replayMotion, playAlertSfx, throwRock } from "./sm-motion.js";
import { playPhaseBannerLocal, removeBanner } from "./sm-banner.js";

// ── Scene gate ──────────────────────────────────────────────────────────────

export function sceneModeOf(scene) {
  const g = scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY]?.[GENERAL_KEY];
  return String(g?.[SCENE_MODE_KEY] ?? "");
}

export const isStealthScene = (scene = canvas?.scene) => sceneModeOf(scene) === SCENE_MODE;

// ── Intent routing (GM side) ────────────────────────────────────────────────

async function handleIntent(payload, userId) {
  if (!director.running) return;
  const sm = director.sm;
  const tune = director.tune;
  const scene = director.scene;
  if (!sm || !payload) return;

  // Only the leader's owner (or a GM) may act. The UI hides the buttons, but
  // the socket is open to anyone, so the real gate is here.
  const user = game.users?.get?.(userId);
  const leader = controllerActor(sm);
  const allowed = user?.isGM || (leader && leader.testUserPermission?.(user, "OWNER"));
  if (!allowed) {
    console.debug(TAG, `intent from ${user?.name} refused — not the leader`);
    return;
  }

  switch (payload.kind) {

    case "switch": {
      const actor = game.actors?.get?.(payload.actorId);
      if (!actor) return;
      sm.party.controllerActorId = actor.id;
      pushLog(sm, `${actor.name} takes the lead`);
      await writeState(sm, scene);
      socket.broadcastState(sm);
      gmPanel.render();
      return;
    }

    case "endTurn":
      return director.dispatch(E.END_TURN);

    case "move": {
      if (director.state !== S.ACTION) return;
      if ((sm.party.moveLeft ?? 0) <= 0) return;

      // Re-path from the GM's own lattice. The client's path is a request.
      const target = payload.path?.[payload.path.length - 1];
      if (!target) return;
      syncOccupancy(scene);
      const reach = reachable(sm.party.cell, sm.party.moveLeft, { ignoreOccupants: false });
      const node = reach.get(cellKey(target));
      if (!node) {
        console.debug(TAG, "move refused — target not reachable on the authority");
        return;
      }
      const path = pathFromReachable(reach, target);
      return director.dispatch(E.MOVE, { kind: "move", path });
    }

    case "objective": {
      if (director.state !== S.ACTION) return;
      if (sm.party.objectiveUsed) return;
      return runObjective(payload, { sm, tune, scene });
    }
  }
}

// ── Objectives ──────────────────────────────────────────────────────────────

async function runObjective(payload, { sm, tune, scene }) {
  const leader = controllerActor(sm);
  const partyCell = sm.party.cell;
  const id = payload.id;

  // Dash is the one objective that spends the slot to BUY movement, so it goes
  // straight through RESOLUTION with a grant rather than resolving here.
  if (id === OBJECTIVE.DASH) {
    const res = await resolveDash(sm, leader, tune);
    return director.dispatch(E.OBJECTIVE, {
      kind: "objective", id, grantMove: res.gain, noisy: true,
    });
  }

  if (id === OBJECTIVE.TAKEDOWN) {
    const enemy = sm.enemies?.[payload.enemyId];
    if (!enemy) return;
    const res = await resolveTakedown(sm, enemy, leader, tune, { scene, partyCell });
    if (!res.ok) { ui.notifications?.warn?.(res.reason); return; }

    if (res.passed) {
      // The guard leaves the board. Hidden rather than deleted, so a GM can
      // put them back if the table decides otherwise — and so the world actor
      // is never touched.
      const t = scene?.tokens?.get?.(enemy.tokenId);
      if (t) await t.update({ hidden: true });
      invalidateLattice();
      syncOccupancy(scene);
    }

    return director.dispatch(E.OBJECTIVE, {
      kind: "objective", id, contact: !res.passed, enemyId: enemy.tokenId,
    });
  }

  if (id === OBJECTIVE.HIDE) {
    // Only being SEEN OUTRIGHT bars hiding — suspicion never does.
    //
    // This used to call detectionSweep(), which MUTATES: it bumped awareness,
    // stamped marks and could shift the Alert tier. Asking whether you were
    // allowed to hide therefore raised the alarm, before the roll, whether or
    // not you got to hide at all. It reads a pure survey now.
    const survey = surveyObservers(
      enemyRecords(sm).map((e) => ({ tokenId: e.tokenId, cell: e.cell, facing: e.facing })),
      partyCell, tune, { scene, concealTier: concealTier(sm) },
    );
    const inCone = survey.anySpotted;
    const roster = await partyActors();
    const res = await resolveHide(sm, leader, partyCell, tune, { scene, inActiveCone: inCone, partyActors: roster });
    if (!res.ok) { ui.notifications?.warn?.(res.reason); return; }
    return director.dispatch(E.OBJECTIVE, { kind: "objective", id });
  }

  if (id === OBJECTIVE.SCAN) {
    const res = await resolveScan(sm, leader, partyCell, tune, { scene });
    // Broadcast the sweep itself, not a toast: the finding IS the animation.
    socket.broadcastOverlay({
      kind: "scan",
      origin: partyCell,
      radius: res.radius,
      finds: res.found.map((f) => ({
        cell: f.cell, kind: f.kind, tokenId: f.tokenId ?? null, tileId: f.tileId ?? null,
      })),
      holdMs: tune.scanHoldMs,
    });
    return director.dispatch(E.OBJECTIVE, { kind: "objective", id });
  }

  if (id === OBJECTIVE.DIVERSION) {
    if (!payload.cell) return;
    // The client lights only legal tiles, but the intent arrives over a socket
    // and the GM is the authority — an out-of-range point must be refused here
    // regardless of what the sender believed.
    if (cellDistance(partyCell, payload.cell, scene) > (tune.diversionRange ?? 5)) {
      ui.notifications?.warn?.("That is out of throwing range.");
      return;
    }
    // Show the throw BEFORE resolving, and wait for it. The guards turning is
    // the consequence; playing both at once reads as the guards reacting to
    // nothing and the rock arriving late to explain it.
    await socket.broadcastOverlayAwait({
      kind: "throw", from: partyCell, to: payload.cell, radius: tune.diversionRadius,
    });
    const div = resolveDiversion(sm, payload.cell, partyCell, tune, { scene });
    // A "?" over everyone the noise reached. Without it the area is invisible:
    // two guards stand equally near the landing point, one answers and one
    // does not, and nothing on screen says which — or why.
    socket.broadcastDetection(
      (div.pulled ?? []).map((id) => ({ id, kind: "suspect" })), { silent: true });
    return director.dispatch(E.OBJECTIVE, { kind: "objective", id });
  }

  if (id === OBJECTIVE.MOVE_OBJECT || id === OBJECTIVE.BREAK_COVER) {
    const tileDoc = tileAtCell(payload.cell, scene);
    if (!tileDoc) { ui.notifications?.warn?.("Nothing to work on there."); return; }
    const res = id === OBJECTIVE.MOVE_OBJECT
      ? await resolveMoveObject(sm, tileDoc, payload.cell, tune, { scene })
      : await resolveBreakCover(sm, tileDoc, tune, { scene });
    if (!res.ok) { ui.notifications?.warn?.(res.reason); return; }
    if (res.noisy) makeNoise(sm, partyCell, tune, { scene, strength: 2, reason: id });
    return director.dispatch(E.OBJECTIVE, { kind: "objective", id });
  }

  if (id === OBJECTIVE.CUSTOM) {
    // The roleplay space. The GM picks the attributes and the DL from what the
    // player wrote — RAW p.72, and exactly what objective:custom already does.
    const desc = String(payload.description ?? "").trim();
    ChatMessage.create({
      content: `<p><b>Objective — the party attempts:</b></p><blockquote>${foundry.utils.escapeHTML?.(desc) ?? desc}</blockquote>
                <p style="opacity:.7;font-size:12px">GM: set the attribute pair and DL, then use the Stealth panel's <b>Request a Check</b>.</p>`,
      whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
    });
    pushLog(sm, `Custom objective: ${desc.slice(0, 60)}`);
    return director.dispatch(E.OBJECTIVE, { kind: "objective", id });
  }
}

/**
 * The stealth prop whose centre sits in this cell.
 *
 * Only flagged props are candidates: the prototype map carries 64 decorative
 * tiles, and letting the player shove an arbitrary bit of scenery would turn
 * every barrel on the map into a puzzle piece the GM never authored.
 */
function tileAtCell(cell, scene) {
  if (!cell) return null;
  const gs = canvas?.grid?.size ?? 100;
  for (const t of (scene?.tiles ?? [])) {
    if (t.hidden) continue;
    if (!propConfigOf(t)) continue;
    const c = cellAt({ x: t.x + (t.width || gs) / 2, y: t.y + (t.height || gs) / 2 });
    if (sameCell(c, cell)) return t;
  }
  return null;
}

// ── GM panel actions ────────────────────────────────────────────────────────

const gmApi = {
  director,
  partyActors,

  async shiftAlert(delta, reason) {
    if (!director.sm) return;
    shiftAlert(director.sm, delta, reason);
    await writeState(director.sm, director.scene);
    socket.broadcastState(director.sm);
    gmPanel.render();
  },

  async forceActivation() {
    if (!director.running) return;
    await director.dispatch(E.MORE_ENEMIES);
  },

  async forceSpawn() {
    if (!director.sm) return;
    const res = await spawnReinforcement(director.sm, director.tune, { scene: director.scene });
    if (!res.spawned) ui.notifications?.warn?.(`No reinforcement: ${res.reason}`);
    await writeState(director.sm, director.scene);
    socket.broadcastState(director.sm);
    gmPanel.render();
  },

  async settleNow() {
    if (!director.sm) return;
    const pa = await partyActors();
    const res = await settleLedger(director.sm, pa, director.tune);
    if (res?.skipped) ui.notifications?.info?.("Nothing banked.");
    await writeState(director.sm, director.scene);
    gmPanel.render();
  },

  async stopStealth() {
    await stopStealth({ settle: true });
  },
};

// ── Start / stop ────────────────────────────────────────────────────────────

export async function startStealth(scene = canvas?.scene, opts = {}) {
  if (!game.user?.isGM) return { ok: false, reason: "GM only" };
  if (!scene) return { ok: false, reason: "no scene" };

  director.registerHandlers(buildHandlers());
  const res = await director.start(scene, opts);
  if (!res.ok) return res;

  gmPanel.wire(gmApi);
  gmPanel.render();
  smUi.applyState(socket.serialiseForClients(director.sm), director.tune);
  socket.broadcastState(director.sm);

  return res;
}

export async function stopStealth({ settle = true, cleanup = true } = {}) {
  if (!game.user?.isGM) return;

  if (settle && director.sm?.ledger?.length) {
    try {
      const pa = await partyActors();
      await settleLedger(director.sm, pa, director.tune);
    } catch (e) {
      console.error(TAG, "ledger settle on stop failed", e);
    }
  }

  if (cleanup) {
    try { await clearReinforcements(director.scene); } catch (_) {}
  }

  const scene = director.scene;
  await director.stop({ persist: false });
  try { await clearState(scene); } catch (_) {}

  gmPanel.remove();
  smUi.disable();
  overlay.destroyAll();
  overlay.destroyMarkLayer();
  overlay.destroyStuporLayer();
  removeBanner();
  socket.broadcastState({ active: false });
}


// ── Resolving a fight the stealth scene handed off ──────────────────────────

const PENDING_FLAG = "stealthPendingConflict";

/**
 * React to a battle this scene started.
 *
 * A stealth contact hands its guards to the Battle Director and the scene
 * changes, which tears the stealth run down. Without this the guards simply
 * came back: the fight was won, the party returned, and the same enemies were
 * re-adopted standing exactly where they died.
 *
 *   victory  the guards are gone. Hidden rather than deleted, matching what a
 *            Takedown does, so a GM can put them back and the world actor is
 *            never touched.
 *   escaped  the guards remain but are STUPORED for a round — running away
 *            has to actually buy distance, or the fight just restarts on the
 *            next enemy phase with the party standing right there.
 *   defeat   left alone. The party has bigger problems.
 */
async function resolvePendingConflict(scene, outcome) {
  if (!game.user?.isGM || !scene) return null;

  const pending = scene.flags?.[MODULE_ID]?.[PENDING_FLAG];
  if (!pending?.participants?.length) return null;

  // Consume it first: a half-applied resolution that runs twice is worse than
  // one that does not run at all.
  try { await scene.unsetFlag(MODULE_ID, PENDING_FLAG); } catch (_) {}

  const ids = pending.participants;

  if (outcome === "victory") {
    const alive = ids.filter((id) => scene.tokens?.get?.(id) && !scene.tokens.get(id).hidden);
    if (alive.length) {
      await scene.updateEmbeddedDocuments("Token",
        alive.map((id) => ({ _id: id, hidden: true })));
    }
    // Drop them from the runtime model too, if a run is already back up.
    if (director.sm) {
      for (const id of ids) if (director.sm.enemies?.[id]) director.sm.enemies[id].defeated = true;
    }
    invalidateLattice();
    console.debug(TAG, `conflict victory — removed ${alive.length} guard(s) from the map`);
    return { outcome, removed: alive.length };
  }

  if (outcome === "escaped") {
    // Stash it for PREP: the run may not be back up yet when this fires.
    try {
      await scene.setFlag(MODULE_ID, "stealthPendingStupor", { ids, at: Date.now() });
    } catch (_) {}
    if (director.sm) {
      applyStupor(director.sm, ids, director.tune ?? readTuning(scene));
      await writeState(director.sm, scene);
      socket.broadcastState(director.sm);
    }
    console.debug(TAG, `conflict escaped — ${ids.length} guard(s) left reeling`);
    return { outcome, stupored: ids.length };
  }

  return { outcome, skipped: true };
}

/** Apply a stupor that was recorded before the stealth run came back up. */
export async function drainPendingStupor(sm, scene, tune) {
  const pend = scene?.flags?.[MODULE_ID]?.stealthPendingStupor;
  if (!pend?.ids?.length) return 0;
  try { await scene.unsetFlag(MODULE_ID, "stealthPendingStupor"); } catch (_) {}
  return applyStupor(sm, pend.ids, tune);
}

// ── Boot ────────────────────────────────────────────────────────────────────

function armForScene(scene) {
  const on = isStealthScene(scene);

  if (!on) {
    if (director.running) stopStealth({ settle: true }).catch(() => {});
    smUi.disable();
    overlay.destroyAll();
    gmPanel.remove();
    return;
  }

  const tune = readTuning(scene);
  invalidateLattice();

  if (game.user?.isGM) {
    // Auto-start rather than making the GM find a button: arriving on a stealth
    // scene IS the intent. A resume picks the existing state back up.
    startStealth(scene).catch((e) => console.error(TAG, "start failed", e));
  } else {
    smUi.enable(tune);
  }
}

Hooks.once("init", () => {
  try {
    game.settings.register(MODULE_ID, TUNING_SETTING, {
      name: "Stealth Mode tuning (JSON)",
      hint: "Overrides for the stealth ruleset. Any key from TUNE_DEFAULTS; a scene flag can override again.",
      scope: "world", config: true, type: String, default: "",
    });
  } catch (e) { console.warn(TAG, "settings.register failed", e); }
});

Hooks.once("ready", () => {
  socket.install({
    onRequest: (payload, userId) => handleIntent(payload, userId).catch(
      (e) => console.error(TAG, "intent handler threw", e)),
    onState: (view) => smUi.applyState(view, readTuning(canvas?.scene)),
    onOverlay: (payload) => {
      if (payload?.kind === "throw") {
        return throwRock(payload.from, payload.to, { radiusCells: payload.radius });
      }
      if (payload?.kind === "scan") {
        overlay.playSonar(payload.origin, payload.radius, payload.finds ?? [],
          { holdMs: payload.holdMs });
      }
    },
    onMotion: (payload) => { replayMotion(payload).catch(() => {}); },
    onBanner: (payload) => { playPhaseBannerLocal(payload?.kind).catch(() => {}); },
    onDetect: (payload) => {
      // Marks over the guards who noticed, plus one alarm cue for the batch.
      const view = smUi.currentView();
      let sounded = false;
      for (const m of (payload?.marks ?? [])) {
        const e = (view?.enemies ?? []).find((x) => x.tokenId === m.id);
        if (e?.cell) overlay.popDetectionMark(e.cell, m.kind);
        if (!payload.silent && !sounded) { playAlertSfx(); sounded = true; }
      }
    },
    onNarrate: (payload) => {
      if (!payload?.text) return;
      ui.notifications?.info?.(payload.text);
      ChatMessage.create({ content: `<p><i>${payload.text}</i></p>`, speaker: { alias: "" } })
        .catch(() => {});
    },
  });

  // The GM's own HUD never goes over the socket, so it listens on the hook.
  Hooks.on("stealth.stateBroadcast", (view) => {
    if (!game.user?.isGM) return;
    smUi.applyState(view, director.tune ?? readTuning(canvas?.scene));
    gmPanel.render();
  });

  Hooks.on("canvasReady", () => armForScene(canvas?.scene));

  // A fight this scene started has finished — clear the dead or daze the fled.
  Hooks.on("fu.battleEnd", (info) => {
    if (!game.user?.isGM) return;
    const scene = game.scenes?.get?.(info?.sourceSceneId) ?? null;
    if (!scene || !isStealthScene(scene)) return;
    resolvePendingConflict(scene, info?.outcome).catch(
      (e) => console.error(TAG, "resolvePendingConflict threw", e));
  });

  // Native dragging has to go while a run is live. A movement pool that a
  // player can sidestep by dragging the token is not a movement pool, and a
  // token moved outside the lattice desyncs every cone on the map.
  //
  // The GM is exempt: they are the authority, they may need to correct a
  // position mid-run, and blocking them would make a stuck state unfixable.
  // Their drag re-syncs the state instead of being refused.
  Hooks.on("preUpdateToken", (tokenDoc, changes, options) => {
    if (!director.running) return;
    if (tokenDoc.parent?.id !== director.scene?.id) return;
    if (options?.stealthAuthorised) return;
    if (!("x" in changes) && !("y" in changes)) return;

    if (!game.user?.isGM) {
      ui.notifications?.warn?.("Stealth: click a highlighted cell to move.");
      return false;
    }
    return; // GM drag allowed — reconciled in updateToken below
  });

  Hooks.on("updateToken", (tokenDoc, changes, options) => {
    if (!director.running || !game.user?.isGM) return;
    if (tokenDoc.parent?.id !== director.scene?.id) return;
    if (options?.stealthAuthorised) return;
    if (!("x" in changes) && !("y" in changes)) return;

    // A GM repositioned something by hand. Believe the token, not the record.
    const sm = director.sm;
    if (!sm) return;
    const cell = cellOfToken(tokenDoc);
    if (tokenDoc.id === sm.party?.tokenId) sm.party.cell = cell;
    else if (sm.enemies?.[tokenDoc.id]) sm.enemies[tokenDoc.id].cell = cell;
    else return;

    syncOccupancy(director.scene);
    writeState(sm, director.scene).then(() => socket.broadcastState(sm)).catch(() => {});
  });

  // Authoring changes invalidate the lattice: a moved wall or a re-flagged
  // crate must not leave a stale passability map behind.
  for (const h of ["createWall", "updateWall", "deleteWall",
                   "createTile", "updateTile", "deleteTile"]) {
    Hooks.on(h, () => { if (director.running) { invalidateLattice(); buildLattice(director.scene); } });
  }

  // Public API — console and other systems.
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.stealth = {
    start: startStealth,
    stop: stopStealth,
    status: () => director.status(),
    state: () => director.sm,
    tuning: () => director.tune,
    isStealthScene,
    director,
    gm: gmApi,
    // Authoring helpers — see docs/stealth-mode-design.md.
    // Writes BOTH the live record and the scene's authoring config. Runtime
    // state alone would look right until the next fresh start, at which point
    // every guard would silently snap back to the default facing — and a
    // stealth map whose cones moved overnight is a map nobody can author.
    setFacing: async (tokenId, dir, scene = canvas?.scene) => {
      const cfg = scene?.flags?.[MODULE_ID]?.stealthConfig ?? {};
      const facings = { ...(cfg.facings ?? {}), [tokenId]: dir };
      await scene?.setFlag(MODULE_ID, "stealthConfig", { ...cfg, facings });

      if (director.sm?.enemies?.[tokenId]) {
        director.sm.enemies[tokenId].facing = dir;
        director.sm.__config = { ...(director.sm.__config ?? {}), facings };
        await writeState(director.sm, director.scene);
        socket.broadcastState(director.sm);
      }
      return true;
    },
    setRoute: async (tokenId, cells, scene = canvas?.scene) => {
      const cfg = scene.flags?.[MODULE_ID]?.stealthConfig ?? {};
      const routes = { ...(cfg.routes ?? {}), [tokenId]: cells };
      await scene.setFlag(MODULE_ID, "stealthConfig", { ...cfg, routes });
      if (director.sm) director.sm.__config = { ...(director.sm.__config ?? {}), routes };
      return true;
    },
    setSpawnPoints: async (cells, scene = canvas?.scene) => {
      const cfg = scene.flags?.[MODULE_ID]?.stealthConfig ?? {};
      await scene.setFlag(MODULE_ID, "stealthConfig", { ...cfg, spawnPoints: cells });
      return true;
    },
  };

  if (canvas?.ready) armForScene(canvas.scene);
  console.debug(TAG, "stealth system ready");
});
