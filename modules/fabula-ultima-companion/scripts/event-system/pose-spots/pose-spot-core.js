/**
 * [ONI] Event System — Pose spots (sit / sleep)
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/pose-spots/pose-spot-core.js
 *
 * What this does:
 * - A pose spot is an event tile with flags.oni-event-system.poseSpot:
 *     { enabled, pose: "sit" | "sleep", mirror, scale,
 *       place: { x, y },   token CENTRE the character takes on the spot
 *       exit:  { x, y } }  token CENTRE they stand up at (optional)
 *   A seat (log, bench, crate) or a bedroll, on a camp or a walk map.
 * - Walk up to it and a button appears over it ("Sit" / "Sleep"); keyboard
 *   Confirm works too (window.oni.Interact). The character takes the spot and
 *   wears their pose art (sprite-facing-runtime.js: system.props.sprite_sit /
 *   sprite_sleep) until they move again: any arrow, click or Run stands them
 *   up first (movementControl-cameraRuntime.js), as in an MMO.
 * - One character per spot. The primary GM settles who gets it, so two
 *   players reaching for the same seat at once cannot both sit.
 * - Who walks: in a camp each player's own member; on a walk map the party
 *   token, by the main controller. A character with no art for the pose is
 *   not offered it.
 *
 * The pose itself is flags.fabula-ultima-companion.pose on the token
 * ({ spotId, pose, mirror, scale }); every client draws it from there.
 *
 * Exposes API to:
 *   window.oni.PoseSpots
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][PoseSpots]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};
  if (window.oni.PoseSpots?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const MODULE_ID = "fabula-ultima-companion";
  const ES_SCOPE = window.oni.EventSystem.Constants?.FLAG_SCOPE ?? "oni-event-system";
  const SPOT_KEY = "poseSpot";
  const POSE_FLAG = "pose";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const MSG = "ONI_POSE_SPOT_V1";

  const POSES = Object.freeze({
    sit:   { label: "Sit",   icon: "fas fa-chair" },
    sleep: { label: "Sleep", icon: "fas fa-bed" }
  });

  // The button shows when the character's feet are this close to the spot's
  // tile, in grid squares (the tile is the seat or bedroll itself).
  const RANGE_GRID = 0.6;

  // The button sits this far above the top of the spot's tile.
  const BUTTON_LIFT_PX = 10;

  const UI_LAYER_ID = "oni-pose-spot-layer";
  const STYLE_ID = "oni-pose-spot-style";

  const state = {
    installed: true,
    buttons: new Map(),   // tileId -> HTMLElement
    tickerFn: null,
    pending: new Set(),   // tileIds this client has asked for, awaiting the GM
    standing: null        // the stand-up under way (a Promise), so a burst of keys sends one
  };

  const runtime = () => globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
  const facing = () => globalThis.FUCompanion?.api?.spriteFacing ?? null;
  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;

  // ------------------------------------------------------------
  // Reading spots
  // ------------------------------------------------------------
  function spotOf(tileDoc) {
    const raw = tileDoc?.getFlag?.(ES_SCOPE, SPOT_KEY);
    if (!raw?.enabled || !POSES[raw.pose]) return null;
    const pt = (p) => (Number.isFinite(p?.x) && Number.isFinite(p?.y)) ? { x: p.x, y: p.y } : null;
    return {
      pose: raw.pose,
      mirror: !!raw.mirror,
      scale: Number(raw.scale) > 0 ? Number(raw.scale) : 1,
      place: pt(raw.place),
      exit: pt(raw.exit)
    };
  }

  // Spots on the viewed scene, ready to use (a hidden tile is switched off;
  // one with no place set yet is still being authored).
  function sceneSpots() {
    const out = [];
    for (const tile of canvas?.tiles?.placeables ?? []) {
      const doc = tile.document;
      if (!doc || doc.hidden) continue;
      const spot = spotOf(doc);
      if (spot?.place) out.push({ tile, doc, spot });
    }
    return out;
  }

  function poseOf(tokenDoc) {
    const p = tokenDoc?.getFlag?.(MODULE_ID, POSE_FLAG);
    return p && POSES[p.pose] ? p : null;
  }

  function occupantOf(tileId, scene = canvas?.scene) {
    for (const t of scene?.tokens ?? []) if (poseOf(t)?.spotId === tileId) return t;
    return null;
  }

  function tileRect(doc) {
    return { left: doc.x, top: doc.y, right: doc.x + doc.width, bottom: doc.y + doc.height };
  }

  // The character's feet, where they are drawn (token.x/y follow the walk).
  function feetOf(token) {
    return { x: token.x + (token.w / 2), y: token.y + (token.h * 0.85) };
  }

  function inRange(token, doc) {
    const r = tileRect(doc), f = feetOf(token);
    const dx = Math.max(r.left - f.x, 0, f.x - r.right);
    const dy = Math.max(r.top - f.y, 0, f.y - r.bottom);
    return Math.hypot(dx, dy) <= (canvas.dimensions?.size || 100) * RANGE_GRID;
  }

  // The token this client walks and may seat: its own member in a camp, the
  // party token for the main controller on a walk map. Null for everyone else.
  function myWalker() {
    const rt = runtime();
    if (!rt || game.user?.isGM) return null;
    const token = rt.getFollowToken?.();
    if (!token?.document?.isOwner) return null;
    return rt.canCurrentUserMovePartyToken?.() ? token : null;
  }

  function hasArt(token, pose) {
    return !!facing()?.poseArtSrc?.(token, pose);
  }

  // Spots this client could take right now, as { tile, doc, spot }.
  function offeredSpots() {
    const walker = myWalker();
    if (!walker || poseOf(walker.document) || game.paused) return [];
    return sceneSpots().filter(({ doc, spot }) =>
      !occupantOf(doc.id) && !state.pending.has(doc.id) && hasArt(walker, spot.pose) && inRange(walker, doc));
  }

  // ------------------------------------------------------------
  // Taking a spot (asked of the primary GM) and standing up
  // ------------------------------------------------------------
  function centreToTopLeft(centre, tokenDoc) {
    const g = canvas.dimensions?.size || 100;
    return {
      x: Math.round(centre.x - ((tokenDoc.width ?? 1) * g) / 2),
      y: Math.round(centre.y - ((tokenDoc.height ?? 1) * g) / 2)
    };
  }

  async function take(tileId) {
    const walker = myWalker();
    if (!walker) return false;
    const rt = runtime();
    rt?.haltWalk?.();
    state.pending.add(tileId);
    setTimeout(() => state.pending.delete(tileId), 3000);

    const req = { type: MSG, action: "take", sceneId: canvas.scene.id, tileId, tokenId: walker.id, userId: game.user.id };
    if (isPrimaryGM()) await gmTake(req);
    else game.socket.emit(SOCKET_CHANNEL, req);
    return true;
  }

  // Primary GM: the spot goes to the first asker, if it is still free and the
  // asker owns the character.
  async function gmTake({ sceneId, tileId, tokenId, userId }) {
    if (!isPrimaryGM()) return;
    const scene = game.scenes.get(sceneId);
    const tileDoc = scene?.tiles?.get(tileId);
    const tokenDoc = scene?.tokens?.get(tokenId);
    const user = game.users.get(userId);
    const spot = spotOf(tileDoc);
    if (!scene || !tileDoc || !tokenDoc || !user || !spot?.place || tileDoc.hidden) return;
    if (!user.isGM && !tokenDoc.testUserPermission(user, "OWNER")) return;
    const taken = occupantOf(tileId, scene);
    if (taken && taken.id !== tokenId) return;
    if (poseOf(tokenDoc)) return;

    const at = centreToTopLeft(spot.place, tokenDoc);
    await tokenDoc.update({
      x: at.x, y: at.y,
      [`flags.${MODULE_ID}.${POSE_FLAG}`]: { spotId: tileId, pose: spot.pose, mirror: spot.mirror, scale: spot.scale }
    }, { animate: false, oniBypassGate: true });
  }

  /**
   * Stand a seated or sleeping character up, at the spot's exit (or where
   * they sat). The owner writes it; nobody else can be on their spot. Resolves
   * once the token is drawn standing, so a walk can plan from there.
   */
  function standUp(token) {
    const doc = token?.document;
    const pose = poseOf(doc);
    if (!pose || !doc?.isOwner) return Promise.resolve(false);
    if (state.standing) return state.standing;

    const spot = spotOf(doc.parent?.tiles?.get(pose.spotId));
    const update = { [`flags.${MODULE_ID}.-=${POSE_FLAG}`]: null };
    if (spot?.exit) Object.assign(update, centreToTopLeft(spot.exit, doc));

    state.standing = doc.update(update, { animate: false, oniBypassGate: true })
      .then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
      .then(() => true)
      .catch((e) => { console.warn(INSTALL_TAG, "Standing up failed.", e); return false; })
      .finally(() => { state.standing = null; });
    return state.standing;
  }

  function onSocket(msg) {
    if (msg?.type !== MSG) return;
    if (msg.action === "take") gmTake(msg);
  }

  // ------------------------------------------------------------
  // The button over a spot
  // ------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
#${UI_LAYER_ID} { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 90; }
.oni-pose-btn {
  position: absolute; pointer-events: auto; width: 34px; height: 34px; display: grid; place-items: center;
  background: rgba(255,255,255,0.95); border: 2px solid rgba(0,0,0,0.75); border-radius: 999px;
  box-shadow: 0 6px 10px rgba(0,0,0,0.35); cursor: pointer; user-select: none;
  color: rgba(20,16,10,0.95); font-size: 15px;
  transform: translate(-50%, -100%) scale(0.75); transform-origin: 50% 100%; opacity: 0;
  transition: transform 160ms ease-out, opacity 160ms ease-out;
}
.oni-pose-btn.is-visible { transform: translate(-50%, -100%) scale(1); opacity: 1; }
.oni-pose-btn.is-visible:hover { transform: translate(-50%, -100%) scale(1.06); }
.oni-pose-btn.is-visible:active { transform: translate(-50%, -100%) scale(0.98); }
`;
    document.head.appendChild(style);
  }

  function layer() {
    let el = document.getElementById(UI_LAYER_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = UI_LAYER_ID;
      document.body.appendChild(el);
    }
    return el;
  }

  function worldToScreen(x, y) {
    const wt = canvas?.stage?.worldTransform;
    return wt ? { x: (x * wt.a) + wt.tx, y: (y * wt.d) + wt.ty } : { x, y };
  }

  function buttonFor(tileId, spot) {
    let el = state.buttons.get(tileId);
    if (!el) {
      ensureStyle();
      el = document.createElement("div");
      el.className = "oni-pose-btn";
      el.dataset.tileId = tileId;
      el.addEventListener("pointerdown", (ev) => { ev.preventDefault(); ev.stopPropagation(); take(tileId); });
      layer().appendChild(el);
      state.buttons.set(tileId, el);
      requestAnimationFrame(() => el.classList.add("is-visible"));
    }
    const p = POSES[spot.pose];
    if (el.dataset.pose !== spot.pose) {
      el.dataset.pose = spot.pose;
      el.title = p.label;
      el.innerHTML = `<i class="${p.icon}"></i>`;
    }
    return el;
  }

  function removeButton(tileId) {
    const el = state.buttons.get(tileId);
    if (!el) return;
    state.buttons.delete(tileId);
    el.classList.remove("is-visible");
    setTimeout(() => el.remove(), 170);
  }

  function clearButtons() {
    for (const id of [...state.buttons.keys()]) removeButton(id);
  }

  // Every frame: the buttons on offer, each over the top of its tile.
  function tick() {
    if (!canvas?.ready) return;
    try {
      const offered = offeredSpots();
      const keep = new Set();
      for (const { doc, spot } of offered) {
        keep.add(doc.id);
        const el = buttonFor(doc.id, spot);
        const s = worldToScreen(doc.x + (doc.width / 2), doc.y);
        const left = `${Math.round(s.x)}px`, top = `${Math.round(s.y - BUTTON_LIFT_PX)}px`;
        if (el.style.left !== left) el.style.left = left;
        if (el.style.top !== top) el.style.top = top;
      }
      for (const id of [...state.buttons.keys()]) if (!keep.has(id)) removeButton(id);
    } catch (e) {
      // A ticker callback that throws stops PIXI's frame loop: never let it.
      console.warn(INSTALL_TAG, "Button update failed.", e);
    }
  }

  function attachTicker() {
    if (state.tickerFn || !canvas?.app?.ticker) return;
    state.tickerFn = tick;
    canvas.app.ticker.add(state.tickerFn, null, PIXI.UPDATE_PRIORITY.UTILITY);
  }

  function detachTicker() {
    if (state.tickerFn && canvas?.app?.ticker) canvas.app.ticker.remove(state.tickerFn);
    state.tickerFn = null;
    clearButtons();
  }

  // Keyboard players: the same buttons through Interact (Confirm on the one faced).
  function interactProvider() {
    const out = [];
    for (const { doc, spot } of offeredSpots()) {
      const p = POSES[spot.pose];
      out.push({
        target: `poseSpot:${doc.id}`,
        label: p.label,
        icon: p.icon,
        order: 30,
        anchor: { x: doc.x + (doc.width / 2), y: doc.y + (doc.height / 2) },
        el: state.buttons.get(doc.id) ?? null,
        run: () => take(doc.id)
      });
    }
    return out;
  }

  // ------------------------------------------------------------
  // Hooks
  // ------------------------------------------------------------
  Hooks.on("canvasReady", () => { state.pending.clear(); attachTicker(); });
  Hooks.on("canvasTearDown", detachTicker);

  // The GM got the spot for us: nothing pending any more.
  Hooks.on("updateToken", (doc, change) => {
    const spotId = change?.flags?.[MODULE_ID]?.[POSE_FLAG]?.spotId;
    if (spotId) state.pending.delete(spotId);
  });

  Hooks.once("ready", () => {
    try { game.socket.on(SOCKET_CHANNEL, onSocket); } catch (e) { console.error(INSTALL_TAG, "Socket listener failed.", e); }
    window.oni.Interact?.register?.("poseSpot", interactProvider);
    if (canvas?.ready) attachTicker();
  });

  window.oni.PoseSpots = {
    installed: true,
    POSES, SPOT_KEY, POSE_FLAG, ES_SCOPE,
    spotOf, sceneSpots, occupantOf, offeredSpots,
    isPosed: (token) => !!poseOf(token?.document ?? token),
    take, standUp,
    state
  };

  console.debug(INSTALL_TAG, "Installed. API: window.oni.PoseSpots");
})();
