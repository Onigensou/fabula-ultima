/**
 * movementControl-cameraRuntime.js
 * Fabula Ultima Companion - Movement Control Camera Runtime
 * Foundry VTT v12
 *
 * Purpose:
 * - Keep the camera-follow-token behavior for player clients
 * - Only operate when scene flag cameraFollowToken is true
 * - Follow the current Central Party Token resolved by Movement Control API
 * - Allow only the current Main Controller to right-click move the party token,
 *   or walk it by holding the arrow keys
 * - Keep other players in observer mode (their arrow keys do nothing here)
 *
 * Notes:
 * - GM client is never affected
 * - UI is not handled here
 * - This script depends on movementControl-api.js
 *
 * Globals:
 *   globalThis.__ONI_MOVEMENT_CONTROL_CAMERA_RUNTIME__
 *
 * API:
 *   FUCompanion.api.MovementControlCameraRuntime
 */

(() => {
  const GLOBAL_KEY = "__ONI_MOVEMENT_CONTROL_CAMERA_RUNTIME__";
  if (globalThis[GLOBAL_KEY]?.state?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "movementControl";

  const FABULA_ROOT_KEY = "oniFabula";
  const GENERAL_KEY = "general";
  const CAMERA_FOLLOW_KEY = "cameraFollowToken";
  const SCENE_MODE_KEY    = "sceneMode";

  const WORLD_LOCK_SCOPE = "world";
  const WORLD_LOCK_KEY = "oniMovementControlCameraLocked";

  const SMOOTHING = 0.18;

  // Walk speed in grid squares per second. Stated here so every hop, however
  // short, is a timed glide: left to the defaults, a module such as token-ease
  // may zero the duration of a short move, which Foundry plays as a warp.
  const WALK_SPEED = 3;

  // How far short of a wall the token's centre stops, in pixels. Foundry rounds
  // a collision point to whole pixels, so a centre parked on the wall itself
  // can land a fraction past it, and from there every click back is blocked.
  const WALL_STANDOFF_PX = 6;
  const WALL_BACKOFF_STEPS = 7;

  // Least distance kept between the token's centre and any wall, measured
  // square to the wall. Has to exceed the rounding described above.
  const WALL_CLEARANCE_PX = 3;

  // Sliding: a walk stopped by a wall carries on along it until the token is
  // level with the clicked point. Set SLIDE_ENABLED false to stop at the wall.
  const SLIDE_ENABLED = true;

  // Slides shorter than this are skipped; they read as a twitch, not a step.
  const SLIDE_MIN_PX = 12;

  // The slide is sent this long before the first leg ends, about one server
  // round trip, so the token turns along the wall without standing still.
  const SLIDE_LEAD_MS = 80;
  const SLIDE_RETRY_MS = 30;

  // The slide aims this far off the wall beyond where the first leg stopped,
  // so rounding to whole pixels cannot eat into the clearance on the way.
  const SLIDE_NUDGE_PX = 1.5;

  // Keyboard walking: while an arrow is held, each leg aims this many grid
  // squares ahead, and the next leg is sent this long before the current one
  // ends (about one server round trip), so a held key walks without stopping.
  const KEY_STEP_GRID = 1;
  const KEY_LEAD_MS = 120;

  // Pushing into a wall with nothing to slide along: look again this often,
  // without moving, in case the direction now has room.
  const KEY_BLOCKED_RETRY_MS = 100;

  // A leg shorter than this is not sent; at a wall it would be a twitch.
  const KEY_MIN_STEP_PX = 2;

  // On release the party carries on this long before stopping, so the stop
  // lands ahead of where it is drawn instead of pulling it back.
  const KEY_COAST_MS = 60;

  const KEY_VECTORS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };

  /**
   * Where the followed token should sit, in world units.
   *
   * The camera renders the pivot at the WINDOW centre, but the chat sidebar
   * covers the right of it. Following the token directly therefore parks the
   * party right-of-centre in the area the player can actually see, and roughly
   * a sidebar-width of map to their right is permanently behind the chat box.
   * That is what makes a chest near the right edge unfindable.
   *
   * Shifting the pivot right by half the reserved chrome puts the party at the
   * centre of the VISIBLE rect, so the map is symmetric around them again.
   * Costs no zoom and no board size, and it reads the live sidebar width, so it
   * self-corrects whether chat is open or closed.
   */
  function followOffset(scale) {
    try {
      const cam = globalThis.FUCompanion?.api?.camera;
      if (!cam?.viewportOf || !cam?.pivotShift) return { x: 0, y: 0 };
      return cam.pivotShift(cam.viewportOf().insets ?? null, scale || 1);
    } catch (_) { return { x: 0, y: 0 }; }
  }

  const state = {
    installed: true,
    enabled: true,

    activeSceneId: null,
    followEnabledForScene: false,

    mode: "inactive", // inactive | waiting | follow

    followTokenId: null,
    followTokenActorId: null,
    followTokenActorName: null,

    lockedScale: null,
    lockX: null,
    lockY: null,

    curX: null,
    curY: null,

    cachedCurrentControllerUserId: null,
    cachedCurrentControllerUserName: null,
    cachedIsMainController: false,

    pendingDestination: null,
    isMoving: false,

    walkSeq: 0,
    slideTimer: null,

    // Arrow keys held down for walking, the pending next leg, and the last
    // direction walked by keyboard (which way the party is "looking").
    heldKeys: new Set(),
    keySeq: 0,
    keyTimer: null,
    keyFacing: null,

    inputLocked: false,
    movementLockIds: new Set(),

    // Who has taken the camera from the follow (an event's camera pan).
    cameraHolds: new Set(),

    inputInstalled: false,
    listeners: [],
    hookIds: [],
    tickerFn: null,
    preUpdateInstalled: false,

    isApplying: false,
    applyTimer: null
  };

  function getDebug() {
    const dbg = globalThis.__ONI_MOVEMENT_CONTROL_DEBUG__;
    if (dbg?.installed) return dbg;

    const noop = () => {};
    return {
      log: noop,
      info: noop,
      verbose: noop,
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      group: noop,
      groupCollapsed: noop,
      table: noop,
      divider: noop,
      startTimer: noop,
      endTimer: () => null
    };
  }

  function getMovementAPI() {
    return globalThis.__ONI_MOVEMENT_CONTROL_API__
      ?? globalThis.FUCompanion?.api?.MovementControl
      ?? null;
  }

  const DBG = getDebug();

  function safeGet(obj, path, fallback) {
    try {
      const parts = String(path).split(".");
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return fallback;
        cur = cur[p];
      }
      return cur === undefined ? fallback : cur;
    } catch {
      return fallback;
    }
  }

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function hasText(value) {
    return cleanString(value).length > 0;
  }

  function normalizeBoolean(v, fallback = false) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(s)) return true;
      if (["false", "0", "no", "n", "off"].includes(s)) return false;
    }
    return fallback;
  }

  function getSceneCameraFollowEnabled(scene) {
    const fab = scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY];

    // sceneMode takes precedence over the legacy cameraFollowToken boolean.
    // Dungeon mode explicitly disables camera follow (and right-click movement).
    const sceneMode = safeGet(fab, `${GENERAL_KEY}.${SCENE_MODE_KEY}`, null);
    if (sceneMode === "dungeon")     return false;
      if (sceneMode === "stealth")     return false;  // stealth owns its own movement + HUD
    if (sceneMode === "exploration") return true;
    if (sceneMode === "none")        return false;

    // Legacy fallback: read the old boolean flag directly.
    const raw = safeGet(fab, `${GENERAL_KEY}.${CAMERA_FOLLOW_KEY}`, false);
    return normalizeBoolean(raw, false);
  }

  function smoothingAlpha(deltaFrames) {
    return 1 - Math.pow(1 - SMOOTHING, deltaFrames);
  }

  function addDomListener(el, type, fn, options) {
    el.addEventListener(type, fn, options);
    state.listeners.push(() => el.removeEventListener(type, fn, options));
  }

  // Drop a slide that is waiting for its first leg. Every new walk, lock and
  // scene change goes through here, so a stale second leg can never fire.
  function cancelPendingSlide() {
    state.walkSeq++;
    if (state.slideTimer) clearTimeout(state.slideTimer);
    state.slideTimer = null;
  }

  function clearPendingMove() {
    state.pendingDestination = null;
    cancelPendingSlide();
  }

  function isMovementLocked() {
    if (state.inputLocked) return true;
    if (state.movementLockIds.size > 0) return true;

    const doc = getFollowTokenDocument();
    if (!doc) return false;

    try {
      return !!doc.getFlag(WORLD_LOCK_SCOPE, WORLD_LOCK_KEY);
    } catch {
      return false;
    }
  }

  function lockMovement(lockId = "default") {
    state.movementLockIds.add(String(lockId));
    state.inputLocked = true;
    clearPendingMove();
    // A key still held when the lock lifts must be pressed again, or the party
    // walks off the moment the dialogue closes.
    dropHeldKeys();

    DBG.verbose("CameraRuntime", "Movement locked", {
      lockId: String(lockId),
      activeLocks: Array.from(state.movementLockIds)
    });
  }

  function unlockMovement(lockId = "default") {
    state.movementLockIds.delete(String(lockId));
    if (state.movementLockIds.size === 0) {
      state.inputLocked = false;
    }

    DBG.verbose("CameraRuntime", "Movement unlocked", {
      lockId: String(lockId),
      activeLocks: Array.from(state.movementLockIds)
    });
  }

  async function setWorldMovementLocked(locked) {
    const doc = getFollowTokenDocument();
    if (!doc?.isOwner) return false;

    try {
      if (locked) await doc.setFlag(WORLD_LOCK_SCOPE, WORLD_LOCK_KEY, true);
      else await doc.unsetFlag(WORLD_LOCK_SCOPE, WORLD_LOCK_KEY);

      DBG.verbose("CameraRuntime", "Updated world movement lock flag", {
        tokenId: doc.id,
        locked: !!locked
      });

      return true;
    } catch (err) {
      DBG.warn("CameraRuntime", "Failed to update world movement lock flag", {
        tokenId: doc?.id ?? null,
        locked: !!locked,
        error: err?.message ?? err
      });
      return false;
    }
  }

  function getFollowToken() {
    if (!canvas?.ready || !state.followTokenId) return null;
    return canvas.tokens?.get(state.followTokenId) ?? null;
  }

  // Another system takes the camera for a while (an event pans to a point).
  // The follow stands down while any hold is out; two systems writing the
  // same transform is how a camera starts to stutter.
  function holdCamera(holdId = "default") {
    state.cameraHolds.add(String(holdId));
  }

  function releaseCamera(holdId = "default") {
    state.cameraHolds.delete(String(holdId));
    if (state.cameraHolds.size > 0 || !canvas?.ready) return;

    // Carry on from where the camera was left, so the follow does not jump.
    state.curX = canvas.stage.pivot.x;
    state.curY = canvas.stage.pivot.y;
  }

  // Where the follow would put the camera right now: { x, y, scale }, or null
  // when this client's camera is not being driven (the GM, a dungeon scene).
  function getFollowTarget() {
    if (!canvas?.ready || state.mode === "inactive") return null;

    const scale = state.lockedScale ?? canvas.stage.scale.x;

    if (state.mode === "follow") {
      const token = getFollowToken();
      if (token) {
        const raw = drawnCenter(token);
        const off = followOffset(scale);
        return { x: raw.x + off.x, y: raw.y + off.y, scale };
      }
    }

    return {
      x: state.lockX ?? canvas.stage.pivot.x,
      y: state.lockY ?? canvas.stage.pivot.y,
      scale
    };
  }

  function getFollowTokenDocument() {
    return getFollowToken()?.document ?? null;
  }

  function findTokenByActorFallback(actorId, actorName) {
    if (!canvas?.ready) return null;

    if (hasText(actorId)) {
      const byActorId = canvas.tokens?.placeables?.find(t => t?.actor?.id === actorId) ?? null;
      if (byActorId) return byActorId;
    }

    if (hasText(actorName)) {
      const byActorName = canvas.tokens?.placeables?.find(t => cleanString(t?.name) === cleanString(actorName)) ?? null;
      if (byActorName) return byActorName;
    }

    return null;
  }

  function hasXYChange(change) {
    return ("x" in (change ?? {})) || ("y" in (change ?? {}));
  }

  function clampToSceneTopLeft(x, y, token) {
    const rect = canvas.dimensions?.sceneRect;
    if (!rect) return { x, y };

    const minX = rect.x;
    const minY = rect.y;
    const maxX = rect.x + rect.width - token.w;
    const maxY = rect.y + rect.height - token.h;

    return {
      x: Math.min(Math.max(x, minX), maxX),
      y: Math.min(Math.max(y, minY), maxY)
    };
  }

  function snapTopLeftIfGrid(x, y) {
    if (!canvas.grid || canvas.grid.type === CONST.GRID_TYPES.GRIDLESS) return { x, y };
    return canvas.grid.getSnappedPosition(x, y, 1);
  }

  function pointToTopLeftFromCenter(center, token) {
    return {
      x: center.x - (token.w / 2),
      y: center.y - (token.h / 2)
    };
  }

  // token.x/y is the drawn position. token.center reads the document, which
  // follows the walk but snaps to the destination for an instant whenever
  // Foundry prepares the next move.
  function drawnCenter(token) {
    return {
      x: token.x + (token.w / 2),
      y: token.y + (token.h / 2)
    };
  }

  function topLeftToCenter(topLeft, token) {
    return {
      x: topLeft.x + (token.w / 2),
      y: topLeft.y + (token.h / 2)
    };
  }

  function walkCollides(token, origin, center) {
    try {
      return token.checkCollision(center, { origin, mode: "any", type: "move" }) === true;
    } catch {
      return false;
    }
  }

  // Token x/y are whole pixels, so settle on the rounded position first and
  // test that exact spot rather than the ideal one.
  function toWalkPosition(center, token) {
    const topLeft = pointToTopLeftFromCenter(center, token);
    return clampToSceneTopLeft(Math.round(topLeft.x), Math.round(topLeft.y), token);
  }

  // Walls that stop a walk from either side. One-way walls are left to
  // Foundry's own test, which knows their direction.
  function blockingEdges() {
    const out = [];
    for (const edge of canvas.edges?.values?.() ?? []) {
      if (!edge?.move) continue;
      if (edge.type === "innerBounds" || edge.type === "outerBounds") continue;
      if (edge.direction) continue;
      out.push(edge);
    }
    return out;
  }

  function distanceToEdge(p, edge) {
    const ax = edge.a.x, ay = edge.a.y;
    const dx = edge.b.x - ax, dy = edge.b.y - ay;
    const len2 = (dx * dx) + (dy * dy);
    let t = len2 ? (((p.x - ax) * dx) + ((p.y - ay) * dy)) / len2 : 0;
    t = Math.min(Math.max(t, 0), 1);
    return Math.hypot(p.x - (ax + (t * dx)), p.y - (ay + (t * dy)));
  }

  function segmentCrossesEdge(p, q, edge) {
    const side = (a, b, c) => ((b.x - a.x) * (c.y - a.y)) - ((b.y - a.y) * (c.x - a.x));
    const d1 = side(p, q, edge.a);
    const d2 = side(p, q, edge.b);
    const d3 = side(edge.a, edge.b, p);
    const d4 = side(edge.a, edge.b, q);

    // A token already standing on the wall line must still be able to step off it.
    if (d3 === 0) return false;
    return (d1 * d2 <= 0) && (d3 * d4 <= 0) && !(d1 === 0 && d2 === 0);
  }

  // A spot is safe to walk to when the straight line there is clear and the
  // spot keeps its distance from every wall. Foundry's test alone is not
  // enough: it rounds both ends to whole pixels, so a token left a fraction
  // of a pixel from a wall can be read as already standing on the far side.
  function isSafeWalkSpot(token, origin, center, edges) {
    if (walkCollides(token, origin, center)) return false;

    for (const edge of edges) {
      if (distanceToEdge(center, edge) < WALL_CLEARANCE_PX) return false;
      if (segmentCrossesEdge(origin, center, edge)) return false;
    }
    return true;
  }

  /**
   * Where a walk from origin toward destination ends, as a token top-left.
   * Open ground: the clicked point. Blocked: a point short of the wall, backed
   * off along the line until it is safe. Null when nowhere that way is.
   *
   * Returned as `spot`, with `hit`: the point where a wall stopped the walk
   * (null on open ground), which is what a slide is worked out from.
   */
  function resolveWalk(token, origin, destination, { snap = true } = {}) {
    const span = Math.hypot(destination.x - origin.x, destination.y - origin.y);
    if (span < 1) return { spot: null, hit: null };

    const ux = (destination.x - origin.x) / span;
    const uy = (destination.y - origin.y) / span;
    const edges = blockingEdges();

    // Probe a little past the click, so a click that lands just in front of
    // a wall is held back from it the same way a click beyond the wall is.
    let hit = null;
    try {
      hit = token.checkCollision(
        { x: destination.x + (ux * WALL_STANDOFF_PX), y: destination.y + (uy * WALL_STANDOFF_PX) },
        { origin, mode: "closest", type: "move" }
      );
    } catch {
      hit = null;
    }

    const blocked =
      hit && typeof hit === "object" && typeof hit.x === "number" && typeof hit.y === "number";

    if (!blocked) {
      const free = toWalkPosition(destination, token);
      const spots = [free];

      // A click lands on the grid; a held key does not, or every leg would
      // bend toward the nearest square.
      if (snap) {
        const snapped = snapTopLeftIfGrid(free.x, free.y);
        spots.unshift(clampToSceneTopLeft(snapped.x, snapped.y, token));
      }

      for (const spot of spots) {
        if (isSafeWalkSpot(token, origin, topLeftToCenter(spot, token), edges)) return { spot, hit: null };
      }
    }

    const wallHit = blocked ? { x: hit.x, y: hit.y } : null;

    // Blocked, or the clicked spot itself is too tight: back off along the
    // line. The step doubles so a wall met at a shallow angle, where a short
    // step back gains almost no distance from it, is still cleared.
    const reach = blocked
      ? Math.min(span, Math.hypot(hit.x - origin.x, hit.y - origin.y))
      : span;

    let back = WALL_STANDOFF_PX;
    for (let step = 0; step < WALL_BACKOFF_STEPS; step++, back *= 2) {
      const travel = reach - back;
      if (travel < 1) break;

      const spot = toWalkPosition(
        { x: origin.x + (ux * travel), y: origin.y + (uy * travel) },
        token
      );
      if (isSafeWalkSpot(token, origin, topLeftToCenter(spot, token), edges)) return { spot, hit: wallHit };
    }

    return { spot: null, hit: wallHit };
  }

  /**
   * The second leg of a blocked walk: from where the first leg stops (or from
   * where the token stands, when it is already against the wall), along the
   * wall that was hit, until level with the clicked point. Returns a token
   * top-left, or null when there is no slide worth making.
   */
  function resolveSlide(token, start, destination, hit, { snap = true } = {}) {
    if (!SLIDE_ENABLED || !hit) return null;

    let wall = null;
    let wallDistance = WALL_CLEARANCE_PX;
    for (const edge of blockingEdges()) {
      const d = distanceToEdge(hit, edge);
      if (d < wallDistance) {
        wall = edge;
        wallDistance = d;
      }
    }
    if (!wall) return null;

    const wx = wall.b.x - wall.a.x;
    const wy = wall.b.y - wall.a.y;
    const wallLength = Math.hypot(wx, wy);
    if (wallLength < 1) return null;

    const tx = wx / wallLength;
    const ty = wy / wallLength;

    // Only the part of the leftover movement that runs along the wall.
    const along = ((destination.x - start.x) * tx) + ((destination.y - start.y) * ty);
    if (Math.abs(along) < SLIDE_MIN_PX) return null;

    // Unit normal pointing to the side of the wall the token is on.
    let nx = -ty;
    let ny = tx;
    if ((((start.x - wall.a.x) * nx) + ((start.y - wall.a.y) * ny)) < 0) {
      nx = -nx;
      ny = -ny;
    }

    const slideTo = {
      x: start.x + (tx * along) + (nx * SLIDE_NUDGE_PX),
      y: start.y + (ty * along) + (ny * SLIDE_NUDGE_PX)
    };

    const spot = resolveWalk(token, start, slideTo, { snap }).spot;
    if (!spot) return null;

    const center = topLeftToCenter(spot, token);
    if (Math.hypot(center.x - start.x, center.y - start.y) < SLIDE_MIN_PX) return null;

    return spot;
  }

  function removeInputBlockers() {
    for (const remove of state.listeners) {
      try {
        remove();
      } catch (_) {}
    }
    state.listeners = [];
    state.inputInstalled = false;
  }

  function canCurrentUserMovePartyToken() {
    if (game.user?.isGM) return true;
    if (!state.followEnabledForScene) return false;
    if (isMovementLocked()) return false;
    return !!state.cachedIsMainController;
  }

  async function refreshAuthorityFromApi() {
    const api = getMovementAPI();
    if (!api) {
      state.cachedCurrentControllerUserId = null;
      state.cachedCurrentControllerUserName = null;
      state.cachedIsMainController = false;
      return;
    }

    try {
      const controller = await api.getCurrentControllerUser();
      state.cachedCurrentControllerUserId = controller?.userId ?? null;
      state.cachedCurrentControllerUserName = controller?.userName ?? null;
      state.cachedIsMainController = !!controller && controller.userId === game.user?.id;

      DBG.verbose("CameraRuntime", "Authority refreshed from API", {
        currentUserId: game.user?.id ?? null,
        controllerUserId: state.cachedCurrentControllerUserId,
        controllerUserName: state.cachedCurrentControllerUserName,
        isMainController: state.cachedIsMainController
      });
    } catch (err) {
      state.cachedCurrentControllerUserId = null;
      state.cachedCurrentControllerUserName = null;
      state.cachedIsMainController = false;

      DBG.warn("CameraRuntime", "Failed to refresh authority from API", {
        error: err?.message ?? err
      });
    }
  }

  async function resolveFollowSnapshot() {
    const api = getMovementAPI();
    if (!api) return null;

    try {
      const snapshot = await api.refresh({
        source: "cameraRuntime",
        broadcast: false
      });

      return snapshot ?? api.getLastSnapshot?.() ?? null;
    } catch (err) {
      DBG.warn("CameraRuntime", "Failed to resolve follow snapshot", {
        error: err?.message ?? err
      });

      return api.getLastSnapshot?.() ?? null;
    }
  }

  async function applyForActiveScene(reason = "manual") {
    if (state.isApplying) return;
    if (game.user?.isGM) return;
    if (!canvas?.ready || !canvas.scene) return;

    state.isApplying = true;
    DBG.startTimer("movement-control-camera-apply", "CameraRuntime", "Applying camera runtime state");

    try {
      const scene = canvas.scene;
      state.activeSceneId = scene.id;
      state.followEnabledForScene = getSceneCameraFollowEnabled(scene);

      await refreshAuthorityFromApi();

      if (!state.followEnabledForScene) {
        state.mode = "inactive";
        state.followTokenId = null;
        state.followTokenActorId = null;
        state.followTokenActorName = null;
        state.pendingDestination = null;
        state.isMoving = false;

        DBG.verbose("CameraRuntime", "Camera runtime inactive because scene flag is off", {
          reason,
          sceneId: scene.id,
          sceneName: scene.name ?? null
        });
        return;
      }

      state.lockedScale = canvas.stage.scale.x;
      state.lockX = canvas.stage.pivot.x;
      state.lockY = canvas.stage.pivot.y;

      // Keep the token already being followed while the snapshot re-resolves.
      // Dropping it here opened a window in which the camera stopped and a
      // right-click found no token to move, so the click was lost.
      const wasFollowing =
        state.mode === "follow" && !!state.followTokenId && !!getFollowToken();

      if (!wasFollowing) {
        state.mode = "waiting";
        state.followTokenId = null;
      }

      const snapshot = await resolveFollowSnapshot();

      const token =
        snapshot?.centralPartyToken
        ?? (snapshot?.centralPartyActorId || snapshot?.centralPartyActorName
          ? findTokenByActorFallback(snapshot?.centralPartyActorId ?? null, snapshot?.centralPartyActorName ?? null)
          : null);

      state.followTokenActorId = snapshot?.centralPartyActorId ?? null;
      state.followTokenActorName = snapshot?.centralPartyActorName ?? null;

      if (token) {
        const sameToken = wasFollowing && state.followTokenId === token.id;

        state.followTokenId = token.id;
        state.mode = "follow";
        if (!sameToken) {
          state.curX = canvas.stage.pivot.x;
          state.curY = canvas.stage.pivot.y;
        }

        DBG.groupCollapsed("CameraRuntime", "Following central party token", {
          reason,
          tokenId: token.id,
          tokenName: token.name ?? null,
          actorId: token.actor?.id ?? null,
          actorName: token.actor?.name ?? null,
          controllerUserId: state.cachedCurrentControllerUserId,
          controllerUserName: state.cachedCurrentControllerUserName,
          isMainController: state.cachedIsMainController
        });
      } else {
        if (wasFollowing) {
          state.mode = "waiting";
          state.followTokenId = null;
          state.lockX = canvas.stage.pivot.x;
          state.lockY = canvas.stage.pivot.y;
        }

        DBG.verbose("CameraRuntime", "Camera runtime is waiting for central party token", {
          reason,
          centralPartyActorId: state.followTokenActorId,
          centralPartyActorName: state.followTokenActorName
        });
      }
    } finally {
      state.isApplying = false;
      DBG.endTimer("movement-control-camera-apply", "CameraRuntime", "Applied camera runtime state");
    }
  }

  function scheduleApply(reason = "scheduled", delay = 0) {
    if (state.applyTimer) clearTimeout(state.applyTimer);
    state.applyTimer = setTimeout(() => {
      state.applyTimer = null;
      applyForActiveScene(reason);
    }, Math.max(0, Number(delay) || 0));
  }

  async function attemptMoveTokenToCanvasPoint(destCanvasPoint) {
    const token = getFollowToken();
    if (!token) return;

    if (!canCurrentUserMovePartyToken()) {
      DBG.verbose("CameraRuntime", "Right-click move ignored because current user is not allowed to move", {
        currentUserId: game.user?.id ?? null,
        currentUserName: game.user?.name ?? null,
        controllerUserId: state.cachedCurrentControllerUserId,
        controllerUserName: state.cachedCurrentControllerUserName
      });
      return;
    }

    if (!token.document?.isOwner) {
      DBG.verbose("CameraRuntime", "Right-click move ignored because token is not owner-editable on this client", {
        tokenId: token.id,
        tokenName: token.name ?? null
      });
      return;
    }

    // Start from where the token is drawn, so a click made mid-walk is tested
    // along the line the token will actually travel.
    const origin = drawnCenter(token);
    const destination = { x: destCanvasPoint.x, y: destCanvasPoint.y };

    // A new walk replaces whatever slide the last one still had pending.
    cancelPendingSlide();
    const walkSeq = state.walkSeq;

    const walk = resolveWalk(token, origin, destination);
    const firstCenter = walk.spot ? topLeftToCenter(walk.spot, token) : null;
    const firstDistance = firstCenter
      ? Math.hypot(firstCenter.x - origin.x, firstCenter.y - origin.y)
      : 0;
    const hasFirstLeg = firstDistance >= 1;

    const slideSpot = resolveSlide(token, hasFirstLeg ? firstCenter : origin, destination, walk.hit);

    if (!hasFirstLeg && !slideSpot) {
      DBG.verbose("CameraRuntime", "Right-click move ignored because no reachable point lies that way", {
        tokenId: token.id,
        tokenName: token.name ?? null
      });
      return;
    }

    // Already against the wall: the slide is the whole walk.
    if (!hasFirstLeg) {
      await walkTokenTo(token, slideSpot, origin);
      return;
    }

    const duration = await walkTokenTo(token, walk.spot, origin);
    if (!slideSpot || walkSeq !== state.walkSeq) return;

    scheduleSlide(walkSeq, token.id, firstCenter, slideSpot, Math.max(0, duration - SLIDE_LEAD_MS));
  }

  function walkDuration(distance) {
    const gridSize = canvas.dimensions?.size || 100;
    return Math.max(1, Math.round((distance / gridSize / WALK_SPEED) * 1000));
  }

  // One straight, timed leg. Returns its duration in milliseconds.
  async function walkTokenTo(token, spot, from) {
    const center = topLeftToCenter(spot, token);
    const duration = walkDuration(Math.hypot(center.x - from.x, center.y - from.y));

    await token.document.update({ x: spot.x, y: spot.y }, {
      animate: true,
      animation: { duration, movementSpeed: WALK_SPEED }
    });

    DBG.verbose("CameraRuntime", "Central party token moved by right-click", {
      tokenId: token.id,
      tokenName: token.name ?? null,
      x: spot.x,
      y: spot.y
    });

    return duration;
  }

  /**
   * Send the slide leg once the first leg is nearly done. Sent early, the
   * token bends from wherever it is drawn straight to the end of the slide,
   * so that shortcut is checked first; while it is not yet safe, wait for the
   * token to get closer to the wall and try again.
   */
  function scheduleSlide(walkSeq, tokenId, firstCenter, slideSpot, delay) {
    const sceneId = canvas.scene?.id ?? null;

    const attempt = async () => {
      state.slideTimer = null;
      if (walkSeq !== state.walkSeq) return;
      if (!state.enabled || canvas.scene?.id !== sceneId) return;
      if (!canCurrentUserMovePartyToken()) return;

      const token = getFollowToken();
      if (!token || token.id !== tokenId || !token.document?.isOwner) return;

      const here = drawnCenter(token);
      const slideCenter = topLeftToCenter(slideSpot, token);
      const arrived = Math.hypot(here.x - firstCenter.x, here.y - firstCenter.y) < 1;

      if (!isSafeWalkSpot(token, here, slideCenter, blockingEdges())) {
        if (!arrived) state.slideTimer = setTimeout(attempt, SLIDE_RETRY_MS);
        return;
      }

      await walkTokenTo(token, slideSpot, here);
    };

    state.slideTimer = setTimeout(attempt, delay);
  }

  /**
   * Stop the party where it is drawn. Used when something takes over (an
   * event beginning) while a walk is still in progress. Only the client that
   * walks the token acts; everyone else sees the result.
   */
  async function haltWalk() {
    clearPendingMove();

    if (game.user?.isGM || !state.cachedIsMainController) return;

    const token = getFollowToken();
    const doc = token?.document;
    if (!doc?.isOwner) return;

    const x = Math.round(token.x);
    const y = Math.round(token.y);
    if (Math.abs(x - doc._source.x) < 1 && Math.abs(y - doc._source.y) < 1) return;

    try {
      await doc.update({ x, y }, {
        animate: true,
        animation: { duration: 1, movementSpeed: WALK_SPEED },
        oniBypassGate: true
      });
    } catch (err) {
      DBG.warn("CameraRuntime", "haltWalk failed", { error: err?.message ?? err });
    }
  }

  // ------------------------------------------------------------------
  // Keyboard walking (arrow keys, held)
  // ------------------------------------------------------------------

  // Where the held keys point, as a unit vector. Two keys make a diagonal at
  // the same speed as a straight walk; opposite keys cancel out.
  function keyVector() {
    let x = 0;
    let y = 0;
    for (const key of state.heldKeys) {
      x += KEY_VECTORS[key]?.x ?? 0;
      y += KEY_VECTORS[key]?.y ?? 0;
    }
    const length = Math.hypot(x, y);
    if (length < 0.5) return null;
    return { x: x / length, y: y / length };
  }

  function cancelKeyLeg() {
    state.keySeq++;
    if (state.keyTimer) clearTimeout(state.keyTimer);
    state.keyTimer = null;
  }

  // Forget the held keys without stopping the token: whatever takes over (a
  // click, a lock, a scene change) decides where it goes next. The keys only
  // walk again once pressed again, since a held key does not repeat.
  function dropHeldKeys() {
    state.heldKeys.clear();
    cancelKeyLeg();
  }

  /**
   * An arrow key went down or up. Returns true when the key belongs to the
   * walk, so Foundry does not also pan the map or nudge a token with it. On a
   * walk map every player's arrows belong to the walk: the one holding the
   * party walks, everyone else's arrows do nothing. The GM is never affected.
   */
  function pressDirection(direction, pressed) {
    if (game.user?.isGM) return false;
    if (!state.enabled || state.mode === "inactive" || !state.followEnabledForScene) return false;
    if (!KEY_VECTORS[direction]) return false;

    if (pressed) {
      if (game.paused || !canCurrentUserMovePartyToken()) return true;
      state.heldKeys.add(direction);
    } else if (!state.heldKeys.delete(direction)) {
      // Dropped already (a click or a lock took over); nothing to release.
      return true;
    }

    // Any change of keys turns the party at once, from where it is drawn.
    cancelKeyLeg();
    keyStep();
    return true;
  }

  /**
   * Send the next leg of a keyboard walk: about one square ahead, through the
   * same wall rules as a click (stop short, slide along), then queue the leg
   * after it so a held key walks without a break.
   */
  async function keyStep() {
    state.keyTimer = null;
    const seq = state.keySeq;

    const dir = keyVector();
    if (!dir) {
      stopKeyWalk();
      return;
    }
    if (game.paused) return;
    if (!canCurrentUserMovePartyToken()) {
      dropHeldKeys();
      return;
    }

    const token = getFollowToken();
    if (!token?.document?.isOwner) return;

    // The keys take over from a click walk and its pending slide.
    clearPendingMove();
    state.keyFacing = dir;

    const origin = drawnCenter(token);
    const reach = (canvas.dimensions?.size || 100) * KEY_STEP_GRID;
    const target = { x: origin.x + (dir.x * reach), y: origin.y + (dir.y * reach) };

    const walk = resolveWalk(token, origin, target, { snap: false });
    let spot = walk.spot;
    if (spot) {
      const c = topLeftToCenter(spot, token);
      if (Math.hypot(c.x - origin.x, c.y - origin.y) < KEY_MIN_STEP_PX) spot = null;
    }
    if (!spot) spot = resolveSlide(token, origin, target, walk.hit, { snap: false });

    if (!spot) {
      // Pushing straight into a wall: stand, and look again shortly.
      if (seq === state.keySeq) state.keyTimer = setTimeout(keyStep, KEY_BLOCKED_RETRY_MS);
      return;
    }

    let duration;
    try {
      duration = await walkTokenTo(token, spot, origin);
    } catch (err) {
      DBG.warn("CameraRuntime", "Keyboard walk leg failed", { error: err?.message ?? err });
      dropHeldKeys();
      return;
    }

    if (seq !== state.keySeq) return;
    state.keyTimer = setTimeout(keyStep, Math.max(0, duration - KEY_LEAD_MS));
  }

  /**
   * All keys up: stop a little ahead of where the party is drawn, along the
   * way it is already going, so it neither runs on to the end of the leg nor
   * pulls back to where it was a moment ago.
   */
  async function stopKeyWalk() {
    cancelKeyLeg();
    if (game.user?.isGM || !state.cachedIsMainController) return;

    const token = getFollowToken();
    const doc = token?.document;
    if (!doc?.isOwner) return;

    const here = drawnCenter(token);
    const end = topLeftToCenter({ x: doc._source.x, y: doc._source.y }, token);
    const left = Math.hypot(end.x - here.x, end.y - here.y);
    const coast = (canvas.dimensions?.size || 100) * WALK_SPEED * (KEY_COAST_MS / 1000);

    // Nearly there anyway: let the leg finish.
    if (left <= coast + 1) return;

    const stop = toWalkPosition({
      x: here.x + (((end.x - here.x) / left) * coast),
      y: here.y + (((end.y - here.y) / left) * coast)
    }, token);

    try {
      await doc.update({ x: stop.x, y: stop.y }, {
        animate: true,
        animation: { duration: KEY_COAST_MS, movementSpeed: WALK_SPEED },
        oniBypassGate: true
      });
    } catch (err) {
      DBG.warn("CameraRuntime", "Keyboard walk stop failed", { error: err?.message ?? err });
    }
  }

  // Window lost focus, game paused: a key released while we were not looking
  // never sends its key-up, so stop as if every key had been released.
  function releaseAllKeys() {
    if (!state.heldKeys.size) return;
    state.heldKeys.clear();
    stopKeyWalk();
  }

  async function consumeMoveQueue() {
    if (state.isMoving) return;
    state.isMoving = true;

    try {
      while (state.enabled && state.pendingDestination) {
        if (!canCurrentUserMovePartyToken()) {
          clearPendingMove();
          break;
        }

        const dest = state.pendingDestination;
        state.pendingDestination = null;
        await attemptMoveTokenToCanvasPoint(dest);
      }
    } finally {
      state.isMoving = false;
    }
  }

  function ensureInputBlockersInstalled() {
    const view = canvas?.app?.view;
    if (!view) return;
    if (state.inputInstalled) return;

    state.inputInstalled = true;

    const onWheel = (ev) => {
      if (state.mode === "inactive") return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    addDomListener(view, "wheel", onWheel, { capture: true, passive: false });

    const onContextMenu = (ev) => {
      if (state.mode === "inactive") return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    addDomListener(view, "contextmenu", onContextMenu, { capture: true });

    const onPointerDown = (ev) => {
      if (state.mode === "inactive") return;
      if (ev.target !== view) return;

      // Right-click
      if (ev.button === 2) {
        ev.preventDefault();
        ev.stopPropagation();

        if (!canCurrentUserMovePartyToken()) {
          DBG.verbose("CameraRuntime", "Blocked right-click move input", {
            currentUserId: game.user?.id ?? null,
            currentUserName: game.user?.name ?? null,
            controllerUserId: state.cachedCurrentControllerUserId,
            controllerUserName: state.cachedCurrentControllerUserName,
            isMainController: state.cachedIsMainController,
            locked: isMovementLocked()
          });
          return;
        }

        const p = canvas.canvasCoordinatesFromClient({
          x: ev.clientX,
          y: ev.clientY
        });

        // The latest input wins: a click ends a keyboard walk.
        dropHeldKeys();
        state.pendingDestination = p;
        consumeMoveQueue();
        return;
      }

      // Middle-click pan
      if (ev.button === 1) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    // Listen on the window, not the view: the canvas has its own pointerdown
    // listener on the view, and stopPropagation cannot hold back a listener on
    // the same element. Left reachable, a quick second right-click on the
    // party token is Foundry's "open Token Config", and while that sheet is
    // open every move of the token is applied without animation.
    addDomListener(window, "pointerdown", onPointerDown, { capture: true });

    const onPointerMove = (ev) => {
      if (state.mode === "inactive") return;

      if ((ev.buttons & 2) === 2) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    addDomListener(view, "pointermove", onPointerMove, { capture: true });

    addDomListener(window, "blur", releaseAllKeys);

    DBG.verbose("CameraRuntime", "Installed input blockers");
  }

  function detachTicker() {
    if (state.tickerFn && canvas?.app?.ticker) {
      canvas.app.ticker.remove(state.tickerFn);
    }
    state.tickerFn = null;
  }

  function attachTicker() {
    if (!canvas?.ready || !canvas?.app?.ticker) return;
    if (state.tickerFn) return;

    state.tickerFn = (delta) => {
      if (!state.enabled) return;
      if (!canvas?.ready) return;
      if (state.mode === "inactive") return;
      if (state.cameraHolds.size > 0) return;

      const scale = state.lockedScale ?? canvas.stage.scale.x;

      if (state.mode === "waiting") {
        const x = state.lockX ?? canvas.stage.pivot.x;
        const y = state.lockY ?? canvas.stage.pivot.y;
        // Only pan if the viewport has drifted from the lock point (user panned, etc.)
        const ldx = canvas.stage.pivot.x - x;
        const ldy = canvas.stage.pivot.y - y;
        if (ldx * ldx + ldy * ldy > 0.01 || canvas.stage.scale.x !== scale) {
          canvas.pan({ x, y, scale });
        }
        return;
      }

      if (state.mode === "follow") {
        let token = getFollowToken();

        if (!token && (state.followTokenActorId || state.followTokenActorName)) {
          token = findTokenByActorFallback(state.followTokenActorId, state.followTokenActorName);
          if (token) state.followTokenId = token.id;
        }

        if (!token) {
          state.mode = "waiting";
          state.lockX = canvas.stage.pivot.x;
          state.lockY = canvas.stage.pivot.y;
          canvas.pan({ x: state.lockX, y: state.lockY, scale });
          return;
        }

        const raw = drawnCenter(token);
        const off = followOffset(scale);
        const targetCenter = { x: raw.x + off.x, y: raw.y + off.y };

        state.curX = state.curX ?? canvas.stage.pivot.x;
        state.curY = state.curY ?? canvas.stage.pivot.y;

        const dx  = targetCenter.x - state.curX;
        const dy  = targetCenter.y - state.curY;
        const dSq = dx * dx + dy * dy;

        if (dSq <= 1) {
          // Within 1wu of target — snap to exact position once, then stop panning
          // until the token moves again.  Mirrors dp-scan-mode.js settled logic.
          if (dSq > 0.0001) {
            state.curX = targetCenter.x;
            state.curY = targetCenter.y;
            canvas.pan({ x: state.curX, y: state.curY, scale });
          }
          return;
        }

        const alpha = smoothingAlpha(delta);
        state.curX += dx * alpha;
        state.curY += dy * alpha;
        canvas.pan({ x: state.curX, y: state.curY, scale });
      }
    };

    canvas.app.ticker.add(state.tickerFn);

    DBG.verbose("CameraRuntime", "Attached camera follow ticker");
  }

  function installPreUpdateGateOnce() {
    if (state.preUpdateInstalled) return;
    state.preUpdateInstalled = true;

    Hooks.on("preUpdateToken", (doc, change, options) => {
      try {
        if (game.user?.isGM) return;
        if (options?.oniBypassGate) return;
        if (!doc) return;
        if (!hasXYChange(change)) return;
        if (!state.followEnabledForScene) return;
        if (!canvas?.scene || doc.parent?.id !== canvas.scene.id) return;

        const matchesByTokenId =
          !!state.followTokenId &&
          cleanString(doc.id) === cleanString(state.followTokenId);

        const matchesByActor =
          hasText(state.followTokenActorId) &&
          cleanString(doc.actorId) === cleanString(state.followTokenActorId);

        const matchesByName =
          hasText(state.followTokenActorName) &&
          cleanString(doc.name) === cleanString(state.followTokenActorName);

        if (!matchesByTokenId && !matchesByActor && !matchesByName) return;

        if (canCurrentUserMovePartyToken()) return;

        if ("x" in change) delete change.x;
        if ("y" in change) delete change.y;

        DBG.verbose("CameraRuntime", "Blocked unauthorized token movement in preUpdateToken", {
          docId: doc.id,
          docName: doc.name ?? null,
          actorId: doc.actorId ?? null,
          currentUserId: game.user?.id ?? null,
          controllerUserId: state.cachedCurrentControllerUserId,
          isMainController: state.cachedIsMainController,
          locked: isMovementLocked()
        });
      } catch (err) {
        DBG.warn("CameraRuntime", "preUpdateToken gate error", {
          error: err?.message ?? err
        });
      }
    });
  }

  function installHooks() {
    const register = (hook, fn) => {
      const id = Hooks.on(hook, fn);
      state.hookIds.push([hook, id]);
    };

    register("canvasReady", async () => {
      if (game.user?.isGM) return;
      if (!state.enabled) return;

      installPreUpdateGateOnce();
      ensureInputBlockersInstalled();
      attachTicker();
      scheduleApply("canvasReady", 0);
    });

    register("canvasTearDown", () => {
      if (game.user?.isGM) return;
      cancelPendingSlide();
      dropHeldKeys();
      detachTicker();
      removeInputBlockers();
    });

    register("updateScene", async (scene) => {
      if (game.user?.isGM) return;
      if (!canvas?.scene) return;
      if (scene.id !== canvas.scene.id) return;
      scheduleApply("updateScene", 20);
    });

    register("createToken", () => {
      if (game.user?.isGM) return;
      if (!state.followEnabledForScene) return;
      scheduleApply("createToken", 20);
    });

    register("deleteToken", () => {
      if (game.user?.isGM) return;
      if (!state.followEnabledForScene) return;
      scheduleApply("deleteToken", 20);
    });

    register("updateToken", (doc, change) => {
      if (game.user?.isGM) return;
      if (!state.followEnabledForScene) return;

      // A plain move cannot change which token is the party token.
      const keys = Object.keys(change ?? {}).filter(k => k !== "_id");
      if (keys.length && keys.every(k => k === "x" || k === "y")) {
        // The full refresh used to re-seat the follow position on the real
        // camera here. Keep that part: where the camera is held at the map
        // edge, the follow position would otherwise run on past it.
        if (state.mode === "follow" && canvas?.stage) {
          state.curX = canvas.stage.pivot.x;
          state.curY = canvas.stage.pivot.y;
        }
        return;
      }

      scheduleApply("updateToken", 20);
    });

    register("pauseGame", (paused) => {
      if (game.user?.isGM) return;
      if (paused) releaseAllKeys();
    });

    register("updateActor", () => {
      if (game.user?.isGM) return;
      if (!state.followEnabledForScene) return;
      scheduleApply("updateActor", 40);
    });

    register("updateUser", () => {
      if (game.user?.isGM) return;
      if (!state.followEnabledForScene) return;
      scheduleApply("updateUser", 40);
    });

    DBG.verbose("CameraRuntime", "Installed hooks", {
      hookCount: state.hookIds.length
    });
  }

  function uninstallHooks() {
    for (const [hook, id] of state.hookIds) {
      try {
        Hooks.off(hook, id);
      } catch (_) {}
    }
    state.hookIds = [];
  }

  function shutdown() {
    if (state.applyTimer) clearTimeout(state.applyTimer);
    state.applyTimer = null;

    detachTicker();
    removeInputBlockers();
    uninstallHooks();

    state.mode = "inactive";
    state.followTokenId = null;
    state.followTokenActorId = null;
    state.followTokenActorName = null;

    DBG.verbose("CameraRuntime", "Camera runtime shutdown complete");
  }

  const api = {
    state,

    refresh: () => applyForActiveScene("apiRefresh"),
    scheduleRefresh: (reason = "apiScheduled", delay = 0) => scheduleApply(reason, delay),

    lockMovement,
    unlockMovement,
    setWorldMovementLocked,
    haltWalk,

    getFollowToken,
    getFollowTokenDocument,
    canCurrentUserMovePartyToken,

    holdCamera,
    releaseCamera,
    getFollowTarget,

    pressDirection,
    // The last direction walked by keyboard, as a unit vector, or null.
    getKeyFacing: () => (state.keyFacing ? { ...state.keyFacing } : null),

    shutdown
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", async () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.MovementControlCameraRuntime = api;
    } catch (err) {
      console.warn("[MovementControl:CameraRuntime] Failed to attach API to FUCompanion.api", err);
    }

    if (game.user?.isGM) {
      DBG.verbose("CameraRuntime", "GM client detected; camera runtime remains inactive");
      return;
    }

    installPreUpdateGateOnce();
    installHooks();
    window.oni?.Input?.setWalker?.(pressDirection);

    if (canvas?.ready) {
      ensureInputBlockersInstalled();
      attachTicker();
      await applyForActiveScene("ready");
    }

    DBG.verbose("CameraRuntime", "movementControl-cameraRuntime.js ready", {
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });
  });

  Hooks.once("shutdown", () => {
    shutdown();
  });
})();
