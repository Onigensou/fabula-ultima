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
 *       exit:  { x, y },   token CENTRE they stand up at (optional)
 *       slot }             sleep only: the camp member spot (1-4) whose member
 *                          camp-walk.js lays here at bedtime (unset = nearest)
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
    sleep: { label: "Sleep", icon: "fas fa-bed" },
    bath:  { label: "Bathe", icon: "fas fa-water" }   // a water Region, not a spot (see Bathing)
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
    // Read the flags directly: getFlag only accepts registered scopes, and the
    // Event System's own scope is not one (it reads doc.flags the same way).
    const raw = tileDoc?.flags?.[ES_SCOPE]?.[SPOT_KEY];
    if (!raw?.enabled || !POSES[raw.pose]) return null;
    const pt = (p) => (Number.isFinite(p?.x) && Number.isFinite(p?.y)) ? { x: p.x, y: p.y } : null;
    const slot = Number(raw.slot);
    return {
      pose: raw.pose,
      mirror: !!raw.mirror,
      scale: Number(raw.scale) > 0 ? Number(raw.scale) : 1,
      place: pt(raw.place),
      exit: pt(raw.exit),
      // Sleep spots only: which camp member spot's member it is the bed of
      // (1-4, the room's member spots in order). null = the nearest member.
      slot: (raw.pose === "sleep" && Number.isInteger(slot) && slot >= 1 && slot <= 4) ? slot : null
    };
  }

  // A scene's sleep spots, from the documents (bedtime runs on the primary
  // GM, who may not be looking at the camp).
  function sleepSpotsOf(scene) {
    const out = [];
    for (const doc of scene?.tiles ?? []) {
      if (doc.hidden) continue;
      const spot = spotOf(doc);
      if (spot?.pose === "sleep" && spot.place) out.push({ doc, spot });
    }
    return out;
  }

  // The token update that puts a character on a spot in its pose.
  function poseUpdate(tokenDoc, tileDoc, spot) {
    const g = tokenDoc.parent?.grid?.size || canvas.dimensions?.size || 100;
    return {
      x: Math.round(spot.place.x - ((tokenDoc.width ?? 1) * g) / 2),
      y: Math.round(spot.place.y - ((tokenDoc.height ?? 1) * g) / 2),
      [`flags.${MODULE_ID}.${POSE_FLAG}`]: { spotId: tileDoc.id, pose: spot.pose, mirror: spot.mirror, scale: spot.scale }
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
  // asker owns the character. Requests are settled one at a time, and a spot
  // counts as taken from the moment it is given, not when the write lands:
  // two players asking in the same instant both got it before (seen live).
  let gmQueue = Promise.resolve();
  const gmClaims = new Map();   // tileId -> tokenId, given but not yet written

  function gmTake(req) {
    gmQueue = gmQueue.then(() => gmTakeNow(req)).catch((e) => console.warn(INSTALL_TAG, "Taking a spot failed.", e));
    return gmQueue;
  }

  async function gmTakeNow({ sceneId, tileId, tokenId, userId }) {
    if (!isPrimaryGM()) return;
    const scene = game.scenes.get(sceneId);
    const tileDoc = scene?.tiles?.get(tileId);
    const tokenDoc = scene?.tokens?.get(tokenId);
    const user = game.users.get(userId);
    const spot = spotOf(tileDoc);
    if (!scene || !tileDoc || !tokenDoc || !user || !spot?.place || tileDoc.hidden) return;
    if (!user.isGM && !tokenDoc.testUserPermission(user, "OWNER")) return;
    const taken = occupantOf(tileId, scene)?.id ?? gmClaims.get(tileId) ?? null;
    if (taken && taken !== tokenId) return;
    if (poseOf(tokenDoc)) return;

    gmClaims.set(tileId, tokenId);
    try {
      const at = centreToTopLeft(spot.place, tokenDoc);
      await tokenDoc.update({
        x: at.x, y: at.y,
        [`flags.${MODULE_ID}.${POSE_FLAG}`]: { spotId: tileId, pose: spot.pose, mirror: spot.mirror, scale: spot.scale }
      }, { animate: false, oniBypassGate: true });
    } finally {
      gmClaims.delete(tileId);
    }
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

  // ------------------------------------------------------------
  // Bathing: water Regions marked bathable
  // ------------------------------------------------------------
  // flags.fabula-ultima-companion.bath = { enabled, depth, autoColor, color }
  // on a Region (usually the scene's footstep "water" Region). A character at
  // its edge gets the "!"; pressing it steps them into the water, in their
  // onsen art, sunk to the depth. They wade freely inside (the pool's walls
  // keep them in) and leave by walking toward land: they step out over the
  // edge and the bath ends. Any number can bathe in one pool.
  const BATH_FLAG = "bath";
  const BATH_ENTER_RANGE_GRID = 0.7;   // how near the edge the "!" shows
  const BATH_STEP_IN_GRID = 0.6;       // how far past the edge they land in the water
  const BATH_STEP_OUT_GRID = 0.45;     // and past the edge on the way out

  // Water is flags.<module>.water = { depth, bathable, ... } (map-system/
  // water-wade.js sinks anyone walking in it); the "!" bath is offered where
  // it is bathable. The first build's flags.<module>.bath = { enabled, depth }
  // still counts.
  function bathOf(regionDoc) {
    const w = regionDoc?.getFlag?.(MODULE_ID, "water");
    if (w) {
      const depth = Number(w.depth);
      return w.bathable && depth > 0 ? { depth } : null;
    }
    const b = regionDoc?.getFlag?.(MODULE_ID, BATH_FLAG);
    if (!b?.enabled) return null;
    const depth = Number(b.depth);
    return { depth: Number.isFinite(depth) && depth > 0 ? depth : 0.5 };
  }

  function bathRegions() {
    return (canvas?.regions?.placeables ?? []).filter(r => !!bathOf(r.document));
  }

  function inRegion(region, pt) {
    try { return !!region?.testPoint?.(pt, 0); } catch (_) { return false; }
  }

  // The nearest point on the region's outline (polygons and rectangles).
  function nearestEdge(regionDoc, p) {
    let best = null;
    const seg = (a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, l2 = (dx * dx) + (dy * dy);
      const t = l2 ? Math.min(1, Math.max(0, (((p.x - a.x) * dx) + ((p.y - a.y) * dy)) / l2)) : 0;
      const q = { x: a.x + (t * dx), y: a.y + (t * dy) }, d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || d < best.dist) best = { point: q, dist: d };
    };
    for (const s of regionDoc?.shapes ?? []) {
      if (s.hole) continue;
      let pts = null;
      if (s.type === "polygon" && s.points?.length >= 6) {
        pts = [];
        for (let i = 0; i < s.points.length; i += 2) pts.push({ x: s.points[i], y: s.points[i + 1] });
      } else if (s.type === "rectangle") {
        pts = [{ x: s.x, y: s.y }, { x: s.x + s.width, y: s.y }, { x: s.x + s.width, y: s.y + s.height }, { x: s.x, y: s.y + s.height }];
      }
      if (!pts) continue;
      for (let i = 0; i < pts.length; i++) seg(pts[i], pts[(i + 1) % pts.length]);
    }
    return best;
  }

  // Feet are the bottom of the token square (feetOf); a token centre sits this far above them.
  function feetOffset(token) { return token.h * 0.35; }

  function bathOffers() {
    const walker = myWalker();
    if (!walker || poseOf(walker.document) || game.paused) return [];
    const feet = feetOf(walker), g = canvas.dimensions?.size || 100, out = [];
    for (const region of bathRegions()) {
      if (inRegion(region, feet)) { out.push({ region, edge: feet, inside: true }); continue; }
      const e = nearestEdge(region.document, feet);
      if (e && e.dist <= g * BATH_ENTER_RANGE_GRID) out.push({ region, edge: e.point, inside: false });
    }
    return out;
  }

  // Into the water: past the edge, along the way from the feet to it, until well inside.
  async function enterBath(regionId) {
    const walker = myWalker();
    const region = canvas.regions?.get(regionId);
    const bath = bathOf(region?.document);
    if (!walker || !bath) return false;
    runtime()?.haltWalk?.();

    const g = canvas.dimensions?.size || 100;
    const feet = feetOf(walker);
    let land = feet, dirX = 0;
    if (!inRegion(region, feet)) {
      const e = nearestEdge(region.document, feet);
      if (!e) return false;
      const len = Math.hypot(e.point.x - feet.x, e.point.y - feet.y) || 1;
      const u = { x: (e.point.x - feet.x) / len, y: (e.point.y - feet.y) / len };
      dirX = u.x;
      land = null;
      for (let d = BATH_STEP_IN_GRID; d <= 2; d += 0.2) {
        const q = { x: e.point.x + (u.x * g * d), y: e.point.y + (u.y * g * d) };
        if (inRegion(region, q)) { land = q; break; }
      }
      if (!land) return false;
    }

    const doc = walker.document;
    const at = centreToTopLeft({ x: land.x, y: land.y - feetOffset(walker) }, doc);
    await doc.update({
      x: at.x, y: at.y,
      [`flags.${MODULE_ID}.${POSE_FLAG}`]: { pose: "bath", regionId, depth: bath.depth, mirror: dirX > 0 }
    }, { animate: false, oniBypassGate: true });
    return true;
  }

  // Out of the water, toward `target` (a token centre the walk is heading for).
  function leaveBath(token, target) {
    const doc = token?.document;
    const pose = poseOf(doc);
    if (pose?.pose !== "bath" || !doc?.isOwner) return Promise.resolve(false);
    if (state.standing) return state.standing;

    const region = canvas.regions?.get(pose.regionId);
    const g = canvas.dimensions?.size || 100;
    const feet = feetOf(token);
    const goal = { x: target.x, y: target.y + feetOffset(token) };
    const len = Math.hypot(goal.x - feet.x, goal.y - feet.y) || 1;
    const u = { x: (goal.x - feet.x) / len, y: (goal.y - feet.y) / len };
    let out = null;
    for (let d = 4; d <= g * 3; d += 4) {
      const q = { x: feet.x + (u.x * d), y: feet.y + (u.y * d) };
      if (!inRegion(region, q)) { out = { x: q.x + (u.x * g * BATH_STEP_OUT_GRID), y: q.y + (u.y * g * BATH_STEP_OUT_GRID) }; break; }
    }
    const update = { [`flags.${MODULE_ID}.-=${POSE_FLAG}`]: null };
    if (out) Object.assign(update, centreToTopLeft({ x: out.x, y: out.y - feetOffset(token) }, doc));

    state.standing = doc.update(update, { animate: false, oniBypassGate: true })
      .then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
      .then(() => true)
      .catch((e) => { console.warn(INSTALL_TAG, "Leaving the bath failed.", e); return false; })
      .finally(() => { state.standing = null; });
    return state.standing;
  }

  /**
   * Called by the walk before it moves a character who holds a pose. `target`
   * is the token centre the walk heads for. Seated or asleep: they stand up.
   * Bathing: they wade on, unless the target is out of the water, when they
   * step out first. True when something was done (the walk re-plans).
   */
  async function beforeWalk(token, target) {
    const pose = poseOf(token?.document);
    if (!pose) return false;
    if (pose.pose !== "bath") return standUp(token);
    if (!target) return false;
    const region = canvas.regions?.get(pose.regionId);
    if (region && inRegion(region, { x: target.x, y: target.y + feetOffset(token) })) return false;
    return leaveBath(token, target);
  }

  // A bather this client walks who is no longer in the water (the GM moved
  // them, a teleport): the bath ends where they are.
  function checkOwnBather() {
    const walker = myWalker();
    const doc = walker?.document;
    const pose = poseOf(doc);
    if (pose?.pose !== "bath" || state.standing) return;
    const region = canvas.regions?.get(pose.regionId);
    // Where the token IS (its stored position, the end of any wade), not where
    // it is drawn: right after stepping in, the drawing is still on the shore
    // for a frame, and that read as "left the water" (seen live).
    const feet = { x: doc._source.x + (walker.w / 2), y: doc._source.y + (walker.h * 0.85) };
    if (region && inRegion(region, feet)) return;
    state.standing = walker.document.update({ [`flags.${MODULE_ID}.-=${POSE_FLAG}`]: null }, { oniBypassGate: true })
      .catch(() => {}).finally(() => { state.standing = null; });
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
    // The same "!" as every interactable in the game (the examine button of
    // event-runtimeUI.js, whose CSS this button also carries the class of).
    // These rules repeat it in case that sheet is not on the page yet.
    style.textContent = `
#${UI_LAYER_ID} { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 90; }
.oni-pose-btn {
  position: absolute; pointer-events: auto; width: 34px; height: 34px; display: grid; place-items: center;
  background: rgba(255,255,255,0.95); border: 2px solid rgba(0,0,0,0.75); border-radius: 999px;
  box-shadow: 0 6px 10px rgba(0,0,0,0.35); cursor: pointer; user-select: none;
  transform: translate(-50%, -50%) scale(0.75); transform-origin: 50% 100%; opacity: 0;
  transition: transform 160ms ease-out, opacity 160ms ease-out;
}
.oni-pose-btn .mark {
  font-family: "Cinzel","Signika",var(--font-primary,"Signika"),system-ui,sans-serif;
  font-weight: 900; font-size: 20px; line-height: 1; color: rgba(20,16,10,0.95); transform: translateY(-1px);
}
.oni-pose-btn.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
.oni-pose-btn.is-visible:hover { transform: translate(-50%, -50%) scale(1.06); }
.oni-pose-btn.is-visible:active { transform: translate(-50%, -50%) scale(0.98); }
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

  // Everything this client could do right now: seats and bedrolls (spot
  // tiles) and baths (water Regions), as
  // { key, label, icon, world (button point), centre (Interact anchor), run }.
  function allOffers() {
    const out = [];
    for (const { doc, spot } of offeredSpots()) {
      const p = POSES[spot.pose];
      out.push({
        key: doc.id, label: p.label, icon: p.icon,
        world: { x: doc.x + (doc.width / 2), y: doc.y },
        centre: { x: doc.x + (doc.width / 2), y: doc.y + (doc.height / 2) },
        run: () => take(doc.id)
      });
    }
    const g = canvas.dimensions?.size || 100;
    for (const { region, edge } of bathOffers()) {
      out.push({
        key: `bath:${region.id}`, label: POSES.bath.label, icon: POSES.bath.icon,
        world: { x: edge.x, y: edge.y - (g * 0.25) },
        centre: edge,
        run: () => enterBath(region.id)
      });
    }
    return out;
  }

  function buttonFor(offer) {
    let el = state.buttons.get(offer.key);
    if (!el) {
      ensureStyle();
      el = document.createElement("div");
      el.className = `${window.oni.EventSystem.Constants?.INTERACT_BUTTON_CLASS ?? "oni-event-btn"} oni-pose-btn`;
      el.dataset.key = offer.key;
      el.innerHTML = `<div class="mark">!</div>`;
      el.addEventListener("pointerdown", (ev) => { ev.preventDefault(); ev.stopPropagation(); el._run?.(); });
      layer().appendChild(el);
      state.buttons.set(offer.key, el);
      requestAnimationFrame(() => el.classList.add("is-visible"));
    }
    // One symbol for everything you can interact with: "!". What it does
    // (Sit / Sleep / Bathe) is only named on hover and in the keyboard menu.
    el._run = offer.run;
    if (el.title !== offer.label) el.title = offer.label;
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
      checkOwnBather();
      const keep = new Set();
      for (const offer of allOffers()) {
        keep.add(offer.key);
        const el = buttonFor(offer);
        // Centred on left/top (translate -50%, as the examine "!" is).
        const s = worldToScreen(offer.world.x, offer.world.y);
        const half = (el.offsetHeight || 34) / 2;
        const left = `${Math.round(s.x)}px`, top = `${Math.round(s.y - BUTTON_LIFT_PX - half)}px`;
        if (el.style.left !== left) el.style.left = left;
        if (el.style.top !== top) el.style.top = top;
      }
      for (const id of [...state.buttons.keys()]) if (!keep.has(id)) removeButton(id);
    } catch (e) {
      // A ticker callback that throws stops PIXI's frame loop: never let it.
      // Said at most once every few seconds, not every frame.
      const now = Date.now();
      if (now - (state.lastWarnAt ?? 0) > 5000) {
        state.lastWarnAt = now;
        console.warn(INSTALL_TAG, "Button update failed.", e);
      }
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
    return allOffers().map((offer) => ({
      target: `poseSpot:${offer.key}`,
      label: offer.label,
      icon: offer.icon,
      order: 30,
      anchor: offer.centre,
      el: state.buttons.get(offer.key) ?? null,
      run: offer.run
    }));
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
    spotOf, sceneSpots, sleepSpotsOf, poseUpdate, occupantOf, offeredSpots,
    isPosed: (token) => !!poseOf(token?.document ?? token),
    take, standUp, beforeWalk,
    bathOf, bathRegions, enterBath, leaveBath, BATH_FLAG,
    state
  };

  console.debug(INSTALL_TAG, "Installed. API: window.oni.PoseSpots");
})();
