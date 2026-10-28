// ============================================================================
// Camp System — Walking at camp
//
// Every player walks their own member around the camp, all at once (the walk
// itself is movementControl-cameraRuntime.js). This file holds the camp's
// side of it:
//
//   Phase lock   Walking is for the roaming phases (Free Roam and the two
//                ready lobbies). Activities, bonds, sleep, the rest-save
//                ceremony and setting out lock it; a walk under way stops.
//   Bedtime      When the camp goes to sleep, the primary GM puts every
//                spawned member back on the spot they were placed on, facing
//                the way they were placed (flags.<module>.campHome).
//   Pass-through Members walk through one another. Where two overlap, the one
//                drawn in front fades, so the one behind stays visible.
//                Drawn locally on every client; nothing is written.
// ============================================================================
(() => {
  const CAMP   = globalThis.CampSystem ??= {};
  const MOD    = CAMP.MODULE_ID;
  const TAG    = "[CampSystem][Walk]";
  const GLOBAL = "__ONI_CAMP_WALK__";

  if (globalThis[GLOBAL]?.installed) return;

  const LOCK_ID = "campPhase";

  // Phases in which members may walk. Every other phase locks the walk.
  const WALK_PHASES = new Set([
    CAMP.PHASE.FREE_ROAM,
    CAMP.PHASE.SLEEP_LOBBY,
    CAMP.PHASE.SET_OUT_LOBBY,
  ]);

  // Overlap fade: how see-through the member in front goes, how long the fade
  // takes, and how much of a token's box two members must share to count.
  const FADE_ALPHA   = 0.5;
  const FADE_MS      = 150;
  const OVERLAP_SHARE = 0.2;

  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? false;
  const isCampScene = (scene) => scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode === "camp";
  const runtime     = () => globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;

  const state = {
    installed: true,
    locked: false,
    lastPhase: null,
    // tokenId -> { fade (0 = clear, 1 = fully faded), lastAlpha, baseAlpha }
    fades: new Map(),
    tickerFn: null,
    lastFrame: 0,
  };
  globalThis[GLOBAL] = state;

  // ---------------------------------------------------------------------------
  // Phase lock (players)
  // ---------------------------------------------------------------------------
  function applyLock() {
    if (game.user?.isGM) return;
    const rt = runtime();
    if (!rt) return;

    const lock = !!canvas?.scene && isCampScene(canvas.scene) && !WALK_PHASES.has(CAMP.State?.getPhase?.());
    if (lock === state.locked) return;
    state.locked = lock;

    if (lock) {
      rt.lockMovement(LOCK_ID);
      rt.haltWalk?.();
    } else {
      rt.unlockMovement(LOCK_ID);
    }
    console.debug(TAG, lock ? "Walking locked for this phase." : "Walking unlocked.");
  }

  // ---------------------------------------------------------------------------
  // Bedtime: members back on their spots (primary GM)
  // ---------------------------------------------------------------------------
  async function sendMembersHome(scene) {
    if (!isPrimaryGM() || !scene || !isCampScene(scene)) return;

    const updates = [];
    for (const t of scene.tokens) {
      const home = t.getFlag(MOD, CAMP.Members?.FLAG_HOME ?? "campHome");
      if (!t.getFlag(MOD, CAMP.Members?.FLAG_MEMBER ?? "campMember")) continue;
      if (!Number.isFinite(home?.x) || !Number.isFinite(home?.y)) continue;

      const u = { _id: t.id };
      if (t._source.x !== home.x || t._source.y !== home.y) Object.assign(u, { x: home.x, y: home.y });
      // Facing as placed. A spot authored without one faces the way it was
      // set on the map: the drawn way, the other way when the token is
      // flipped (texture.scaleX < 0; sprite-facing-runtime.js restFacing).
      const drawnRight = t.getFlag(MOD, "spriteFacesRight")
        ?? game.actors.get(t.actorId)?.prototypeToken?.flags?.[MOD]?.spriteFacesRight;
      const flipped = (Number(t.texture?.scaleX) || 1) < 0;
      const facing = home.facing ?? ((!!drawnRight !== flipped) ? "right" : "left");
      const facingDir = home.facingDir ?? "downLeft";
      if (t.getFlag(MOD, "facing") !== facing) u[`flags.${MOD}.facing`] = facing;
      if (t.getFlag(MOD, "facingDir") !== facingDir) u[`flags.${MOD}.facingDir`] = facingDir;
      // Off any seat or bedroll they were resting on (event-system/pose-spots).
      if (t.getFlag(MOD, "pose")) u[`flags.${MOD}.-=pose`] = null;
      if (Object.keys(u).length > 1) updates.push(u);
    }
    if (!updates.length) return;

    try {
      await scene.updateEmbeddedDocuments("Token", updates, { animate: false, oniBypassGate: true });
      console.debug(TAG, `${updates.length} member(s) back on their spots.`);
    } catch (e) {
      console.error(TAG, "Could not send members home:", e);
    }
  }

  function onPhase() {
    const phase = CAMP.State?.getPhase?.();
    const changed = phase !== state.lastPhase;
    state.lastPhase = phase;
    applyLock();
    // The screen is dark by now; nobody sees them jump.
    if (changed && phase === CAMP.PHASE.SLEEPING) sendMembersHome(canvas?.scene);
  }

  // ---------------------------------------------------------------------------
  // Pass-through fade (every client)
  // ---------------------------------------------------------------------------
  function overlapShare(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (w <= 0 || h <= 0) return 0;
    return (w * h) / Math.min(a.w * a.h, b.w * b.h);
  }

  // Foundry sets the mesh's alpha whenever it refreshes the token (hover, a
  // hidden token on the GM's screen). An alpha that is not the one written
  // here last is Foundry's, and becomes the base the fade is laid over.
  function applyFade(token, entry) {
    const mesh = token?.mesh;
    if (!mesh || mesh.destroyed) return;
    if (entry.lastAlpha === null || Math.abs(mesh.alpha - entry.lastAlpha) > 1e-4) entry.baseAlpha = mesh.alpha;
    const alpha = entry.baseAlpha * (1 - (entry.fade * (1 - FADE_ALPHA)));
    entry.lastAlpha = alpha;
    if (Math.abs(mesh.alpha - alpha) > 1e-4) mesh.alpha = alpha;
  }

  function clearFades() {
    for (const [id, entry] of state.fades) {
      const mesh = canvas?.tokens?.get(id)?.mesh;
      if (mesh && !mesh.destroyed && entry.lastAlpha !== null && Math.abs(mesh.alpha - entry.lastAlpha) < 1e-4) {
        mesh.alpha = entry.baseAlpha;
      }
    }
    state.fades.clear();
  }

  function tick() {
    if (!canvas?.ready) return;
    const now = performance.now();
    const dt = state.lastFrame ? Math.min(100, now - state.lastFrame) : 16;
    state.lastFrame = now;

    const isMember = runtime()?.isCampMemberToken;
    if (!isMember) return;
    const members = (canvas.tokens?.placeables ?? []).filter(t => t.visible && isMember(t));

    // The member drawn in front (feet lower on the screen) of any overlap fades.
    const front = new Set();
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j];
        if (overlapShare(a, b) < OVERLAP_SHARE) continue;
        front.add(((a.y + a.h) >= (b.y + b.h) ? a : b).id);
      }
    }

    const step = dt / FADE_MS;
    for (const token of members) {
      let entry = state.fades.get(token.id);
      const target = front.has(token.id) ? 1 : 0;
      if (!entry) {
        if (!target) continue;
        entry = { fade: 0, lastAlpha: null, baseAlpha: token.mesh?.alpha ?? 1 };
        state.fades.set(token.id, entry);
      }
      entry.fade = target > entry.fade ? Math.min(1, entry.fade + step) : Math.max(0, entry.fade - step);
      applyFade(token, entry);
      if (!target && entry.fade === 0) state.fades.delete(token.id);
    }
    // A faded member that is gone or hidden is simply forgotten.
    for (const id of [...state.fades.keys()]) {
      if (!members.some(t => t.id === id)) state.fades.delete(id);
    }
  }

  function attachTicker() {
    if (state.tickerFn || !canvas?.app?.ticker) return;
    state.tickerFn = tick;
    state.lastFrame = 0;
    // After Foundry's own refresh, before the frame is drawn.
    canvas.app.ticker.add(state.tickerFn, undefined, PIXI.UPDATE_PRIORITY.LOW + 1);
  }

  function detachTicker() {
    if (state.tickerFn && canvas?.app?.ticker) canvas.app.ticker.remove(state.tickerFn);
    state.tickerFn = null;
    clearFades();
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------
  function onScene() {
    state.lastPhase = CAMP.State?.getPhase?.() ?? null;
    applyLock();
    if (canvas?.scene && isCampScene(canvas.scene)) attachTicker();
    else detachTicker();
  }

  Hooks.on("canvasReady", onScene);
  Hooks.on("canvasTearDown", detachTicker);

  Hooks.on("updateScene", (scene) => {
    if (canvas?.scene && scene.id === canvas.scene.id) onScene();
  });

  Hooks.on("updateSetting", (setting) => {
    if ((setting?.key ?? "") === `${MOD}.${CAMP.SETTING.PHASE}`) onPhase();
  });

  Hooks.once("ready", () => {
    if (canvas?.ready) onScene();
  });

  CAMP.Walk = { WALK_PHASES, sendMembersHome, state };

  console.debug(TAG, "Camp walk loaded.");
})();
