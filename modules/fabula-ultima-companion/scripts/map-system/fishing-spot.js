/**
 * [ONI] Fishing spots — fish from any body of water on a walk map or camp
 * Foundry VTT v12
 *
 * File:
 * scripts/map-system/fishing-spot.js
 *
 * What this does:
 * - A fishing spot is a water Region with flags.fabula-ultima-companion.water
 *     { fishable: true, fishTable: "<RollTable uuid>" (optional), ... }
 *   set in Region Config → Identity → Water (pose-spot-config.js). It needs no
 *   depth: a pond the party cannot wade in can still be fished.
 * - Walk up to its edge and a FISH button shows there (its own icon: the one
 *   exception to the "!" rule the user made for fishing). Keyboard Confirm
 *   works too (window.oni.Interact).
 * - Who may fish is who walks (PoseSpots' rule): the main controller on a walk
 *   map, each player's own member in a camp. The angler is the character the
 *   pressing player plays: their camp member, or on a walk map their own
 *   party member.
 * - Bait costs 1 IP, asked first on the parchment Yes / No. The primary GM
 *   checks and takes the IP, then runs the camp Fishing minigame for ONE round
 *   (activity-fishing.js, source "spot": no camp state is touched). The camp
 *   activity and the dungeon Fishing tile stay free.
 * - One angler at a time per scene (the minigame UI is one per client).
 * - Who watches: on a walk map everyone (the party is one unit). In a camp only
 *   the angler and the GMs open the minigame; everyone else keeps roaming and
 *   sees a small fish speech bubble over the angler.
 *
 * The angler's token carries flags.fabula-ultima-companion.fishing
 * = { actorId, userId } while the session runs; every client draws the bubble
 * and hides the spot buttons from it.
 *
 * Exposes API to:
 *   window.oni.FishingSpots
 */

(() => {
  const INSTALL_TAG = "[ONI][FishingSpots]";

  window.oni = window.oni || {};
  if (window.oni.FishingSpots?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const MSG = "ONI_FISHING_SPOT_V1";
  const WATER_FLAG = "water";
  const FISHING_FLAG = "fishing";

  const BAIT_IP = 1;
  const ROUNDS_PER_BAIT = 1;

  const LABEL = "Fish";
  const ICON = "fas fa-fish";

  // The button shows when the walker's feet are this near the water's edge
  // (or in the water), in grid squares: the same reach as the bath "!".
  const ENTER_RANGE_GRID = 0.7;
  const BUTTON_LIFT_PX = 10;

  // The angler holds still from the press until the session ends. If the GM
  // never answers (gone, reloaded), let go after this long.
  const PENDING_GIVE_UP_MS = 10 * 60 * 1000;

  const UI_LAYER_ID = "oni-fishing-spot-layer";
  const STYLE_ID = "oni-fishing-spot-style";
  const BTN_CLASS = "oni-fish-spot-btn";
  const BUBBLE_CLASS = "oni-fish-bubble";
  const FISH_OVERLAY_ID = "oni-camp-fish-ovl";   // activity-fishing-ui.js
  const MOVE_LOCK_ID = "fishing-spot";

  const state = {
    installed: true,
    buttons: new Map(),   // regionId -> HTMLElement
    bubbles: new Map(),   // tokenId -> HTMLElement
    tickerFn: null,
    pending: null,        // { tokenId, sawFlag, timer } while this client's session is asked for / running
    asking: false,        // the bait prompt is open
    running: new Set(),   // GM: sceneIds with a session under way
    lastWarnAt: 0
  };

  const runtime = () => globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
  const poseSpots = () => window.oni.PoseSpots ?? null;

  const isCampScene = (scene) => scene?.flags?.[MODULE_ID]?.oniFabula?.general?.sceneMode === "camp";

  // ------------------------------------------------------------
  // Reading spots
  // ------------------------------------------------------------
  // { table } for a fishable water Region (table "" = the scene's fish table).
  function fishOf(regionDoc) {
    const w = regionDoc?.getFlag?.(MODULE_ID, WATER_FLAG);
    if (!w?.fishable) return null;
    return { table: String(w.fishTable ?? "").trim() };
  }

  function fishRegions() {
    return (canvas?.regions?.placeables ?? []).filter(r => !!fishOf(r.document));
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

  function feetOf(token) {
    return { x: token.x + (token.w / 2), y: token.y + (token.h * 0.85) };
  }

  // The token this client walks (PoseSpots' rule), else null.
  function myWalker() {
    const rt = runtime();
    if (!rt || game.user?.isGM) return null;
    const token = rt.getFollowToken?.();
    if (!token?.document?.isOwner) return null;
    return rt.canCurrentUserMovePartyToken?.() ? token : null;
  }

  function fishingOf(tokenDoc) {
    const f = tokenDoc?.getFlag?.(MODULE_ID, FISHING_FLAG);
    return f?.actorId ? f : null;
  }

  function someoneFishing(scene = canvas?.scene) {
    for (const t of scene?.tokens ?? []) if (fishingOf(t)) return true;
    return false;
  }

  // Spots this client could fish right now, as { region, edge }.
  function offers() {
    const walker = myWalker();
    if (!walker || game.paused || state.pending || state.asking) return [];
    if (runtime()?.state?.inputLocked) return [];
    if (poseSpots()?.isPosed?.(walker)) return [];
    if (document.getElementById(FISH_OVERLAY_ID)) return [];
    if (someoneFishing()) return [];

    const feet = feetOf(walker), g = canvas.dimensions?.size || 100, out = [];
    for (const region of fishRegions()) {
      if (inRegion(region, feet)) { out.push({ region, edge: feet }); continue; }
      const e = nearestEdge(region.document, feet);
      if (e && e.dist <= g * ENTER_RANGE_GRID) out.push({ region, edge: e.point });
    }
    return out;
  }

  // ------------------------------------------------------------
  // The angler and their IP
  // ------------------------------------------------------------
  function ownsActor(actor, userId) {
    return (actor?.ownership?.[userId] ?? 0) >= 3;
  }

  // Camp: the walker's own member. Walk map: this player's party member
  // (their linked character first).
  function anglerFor(walker) {
    const rt = runtime();
    if (rt?.state?.walkKind === "camp") return walker?.actor ?? null;
    const ids = rt?.state?.partyMemberIds ?? new Set();
    const own = game.user?.character;
    if (own && ids.has(own.id)) return own;
    for (const id of ids) {
      const a = game.actors?.get(id);
      if (a && ownsActor(a, game.user.id)) return a;
    }
    return null;
  }

  function ipOf(actor) {
    const p = actor?.system?.props ?? {};
    return { cur: parseInt(p.current_ip) || 0, max: parseInt(p.max_ip) || 0 };
  }

  // ------------------------------------------------------------
  // Pressing the button (the angler's client)
  // ------------------------------------------------------------
  async function press(regionId) {
    if (state.pending || state.asking) return false;
    const walker = myWalker();
    const region = canvas.regions?.get(regionId);
    if (!walker || !fishOf(region?.document)) return false;
    runtime()?.haltWalk?.();

    const angler = anglerFor(walker);
    if (!angler) {
      ui.notifications?.warn("Fishing | None of your characters is in the party.");
      return false;
    }
    const ip = ipOf(angler);
    if (ip.cur < BAIT_IP) {
      ui.notifications?.warn(`Fishing | ${angler.name} needs ${BAIT_IP} IP to buy bait.`);
      return false;
    }

    const camp = isCampScene(canvas.scene);
    const ask = globalThis.TeleporterSystem?.askYesNo;
    state.asking = true;
    let yes = false;
    try {
      yes = ask
        ? await ask(["Buy bait for ", `${BAIT_IP} IP`, ` and fish? (${angler.name}: ${ip.cur}/${ip.max} IP)`], { mirror: !camp })
        : true;
    } finally {
      state.asking = false;
    }
    if (!yes) return false;

    beginPending(walker.id);
    const payload = {
      action: "start", userId: game.user.id,
      sceneId: canvas.scene.id, regionId, tokenId: walker.id, actorId: angler.id
    };
    try {
      game.socket.emit(SOCKET_CHANNEL, { type: MSG, payload });
    } catch (e) {
      console.warn(INSTALL_TAG, "Could not reach the GM.", e);
      endPending();
      return false;
    }
    return true;
  }

  // The angler holds still until the GM ends the session (the fishing flag
  // comes off their token) or turns the request down.
  function beginPending(tokenId) {
    endPending();
    runtime()?.lockMovement?.(MOVE_LOCK_ID);
    state.pending = {
      tokenId, sawFlag: false,
      timer: setTimeout(() => {
        console.warn(INSTALL_TAG, "No answer from the GM; letting go.");
        endPending();
      }, PENDING_GIVE_UP_MS)
    };
  }

  function endPending() {
    if (!state.pending) return;
    clearTimeout(state.pending.timer);
    state.pending = null;
    runtime()?.unlockMovement?.(MOVE_LOCK_ID);
  }

  // ------------------------------------------------------------
  // The session (primary GM)
  // ------------------------------------------------------------
  function reply(userId, action, extra = {}) {
    const payload = { action, userId, ...extra };
    if (userId === game.user?.id) onSocket({ type: MSG, payload });
    else game.socket.emit(SOCKET_CHANNEL, { type: MSG, payload });
  }

  async function gmStart({ userId, sceneId, regionId, tokenId, actorId } = {}) {
    if (!game.user?.isGM || !isPrimaryGM()) return;
    const deny = (reason) => reply(userId, "denied", { reason });

    const scene = game.scenes?.get(sceneId);
    const region = scene?.regions?.get(regionId);
    const tokenDoc = scene?.tokens?.get(tokenId);
    const actor = game.actors?.get(actorId);
    if (!scene || !fishOf(region) || !tokenDoc || !actor) return deny("The fishing spot is gone.");
    if (!ownsActor(actor, userId)) return deny(`${actor.name} is not yours to fish with.`);
    if (state.running.has(scene.id) || someoneFishing(scene)) return deny("Someone is already fishing here.");

    const fishing = globalThis.CampSystem?.ActivityRegistry?.get?.("fishing");
    if (!fishing?.execute) return deny("The fishing minigame is not loaded.");

    const ip = ipOf(actor);
    if (ip.cur < BAIT_IP) return deny(`${actor.name} needs ${BAIT_IP} IP to buy bait.`);

    state.running.add(scene.id);
    let paid = false;
    try {
      await actor.update({ "system.props.current_ip": ip.cur - BAIT_IP });
      paid = true;
      await tokenDoc.update({ [`flags.${MODULE_ID}.${FISHING_FLAG}`]: { actorId: actor.id, userId } }, { oniBypassGate: true });

      // Camp: only the angler (and the GMs) open the minigame; the others roam.
      const audience = isCampScene(scene) ? [userId] : null;
      const ran = await fishing.execute(actor, scene, {
        totalRounds: ROUNDS_PER_BAIT,
        fishTable: fishOf(region).table,
        source: "spot",
        audience
      });
      // Nothing to catch here (no fish table at all): the bait goes back.
      if (ran === false) {
        await actor.update({ "system.props.current_ip": ipOf(actor).cur + BAIT_IP });
        paid = false;
      }
    } catch (e) {
      console.error(INSTALL_TAG, "Fishing session failed.", e);
      if (paid) {
        // Refund only if the minigame never got going.
        try { if (!document.getElementById(FISH_OVERLAY_ID)) await actor.update({ "system.props.current_ip": ipOf(actor).cur + BAIT_IP }); } catch (_) {}
      }
    } finally {
      state.running.delete(scene.id);
      try {
        if (fishingOf(tokenDoc)) await tokenDoc.update({ [`flags.${MODULE_ID}.-=${FISHING_FLAG}`]: null }, { oniBypassGate: true });
      } catch (e) {
        console.warn(INSTALL_TAG, "Could not clear the fishing mark.", e);
      }
      reply(userId, "ended");
    }
  }

  // A fishing mark with no session behind it (the GM reloaded mid-session).
  async function gmClearStale(scene) {
    if (!game.user?.isGM || !isPrimaryGM() || !scene || state.running.has(scene.id)) return;
    const updates = [];
    for (const t of scene.tokens ?? []) {
      if (fishingOf(t)) updates.push({ _id: t.id, [`flags.${MODULE_ID}.-=${FISHING_FLAG}`]: null });
    }
    if (!updates.length) return;
    try {
      await scene.updateEmbeddedDocuments("Token", updates, { oniBypassGate: true });
      console.debug(INSTALL_TAG, `Cleared ${updates.length} stale fishing mark(s) on ${scene.name}.`);
    } catch (e) {
      console.warn(INSTALL_TAG, "Could not clear stale fishing marks.", e);
    }
  }

  function onSocket(msg) {
    if (msg?.type !== MSG) return;
    const p = msg.payload ?? {};
    if (p.action === "start") { gmStart(p); return; }
    if (p.userId !== game.user?.id) return;
    if (p.action === "denied") {
      endPending();
      if (p.reason) ui.notifications?.warn(`Fishing | ${p.reason}`);
    } else if (p.action === "ended") {
      endPending();
    }
  }

  // ------------------------------------------------------------
  // Buttons and bubbles
  // ------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    // The same round white button as the "!" (event-runtimeUI.js), with a
    // fish in place of the mark. The bubble is the NPC talk bubble's shape.
    style.textContent = `
#${UI_LAYER_ID} { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 90; }
.${BTN_CLASS} {
  position: absolute; pointer-events: auto; width: 34px; height: 34px; display: grid; place-items: center;
  background: rgba(255,255,255,0.95); border: 2px solid rgba(0,0,0,0.75); border-radius: 999px;
  box-shadow: 0 6px 10px rgba(0,0,0,0.35); cursor: pointer; user-select: none;
  transform: translate(-50%, -50%) scale(0.75); transform-origin: 50% 100%; opacity: 0;
  transition: transform 160ms ease-out, opacity 160ms ease-out;
}
.${BTN_CLASS} i { font-size: 16px; line-height: 1; color: rgba(20,16,10,0.95); }
.${BTN_CLASS}.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
.${BTN_CLASS}.is-visible:hover { transform: translate(-50%, -50%) scale(1.06); }
.${BTN_CLASS}.is-visible:active { transform: translate(-50%, -50%) scale(0.98); }

.${BUBBLE_CLASS} {
  position: absolute; pointer-events: none; width: 42px; height: 40px;
  transform: translate(-50%, -100%); opacity: 0; transition: opacity 200ms ease-out;
}
.${BUBBLE_CLASS}.is-visible { opacity: 1; }
.${BUBBLE_CLASS} .bubble {
  position: relative; box-sizing: border-box; width: 42px; height: 30px;
  display: flex; align-items: center; justify-content: center;
  background: rgb(255,255,255); border: 2px solid rgba(0,0,0,0.75); border-radius: 15px;
  filter: drop-shadow(0 5px 5px rgba(0,0,0,0.35));
  animation: oni-fish-bubble-bob 2600ms ease-in-out infinite;
}
.${BUBBLE_CLASS} .bubble::after {
  content: ""; position: absolute; left: 50%; bottom: -7px; width: 10px; height: 10px;
  background: rgb(255,255,255);
  border-right: 2px solid rgba(0,0,0,0.75); border-bottom: 2px solid rgba(0,0,0,0.75);
  border-bottom-right-radius: 3px; transform: translateX(-50%) rotate(45deg);
}
.${BUBBLE_CLASS} .bubble i {
  font-size: 15px; color: rgba(20,16,10,0.95);
  animation: oni-fish-bubble-wiggle 1800ms ease-in-out infinite;
}
@keyframes oni-fish-bubble-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes oni-fish-bubble-wiggle { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(-12deg); } 75% { transform: rotate(12deg); } }
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

  function buttonFor(regionId) {
    let el = state.buttons.get(regionId);
    if (!el) {
      ensureStyle();
      el = document.createElement("div");
      el.className = BTN_CLASS;
      el.dataset.regionId = regionId;
      el.title = `${LABEL} (${BAIT_IP} IP)`;
      el.innerHTML = `<i class="${ICON}"></i>`;
      el.addEventListener("pointerdown", (ev) => { ev.preventDefault(); ev.stopPropagation(); press(regionId); });
      layer().appendChild(el);
      state.buttons.set(regionId, el);
      requestAnimationFrame(() => el.classList.add("is-visible"));
    }
    return el;
  }

  function removeEl(map, key) {
    const el = map.get(key);
    if (!el) return;
    map.delete(key);
    el.classList.remove("is-visible");
    setTimeout(() => el.remove(), 200);
  }

  function bubbleFor(tokenId) {
    let el = state.bubbles.get(tokenId);
    if (!el) {
      ensureStyle();
      el = document.createElement("div");
      el.className = BUBBLE_CLASS;
      el.innerHTML = `<div class="bubble"><i class="${ICON}"></i></div>`;
      layer().appendChild(el);
      state.bubbles.set(tokenId, el);
      requestAnimationFrame(() => el.classList.add("is-visible"));
    }
    return el;
  }

  function placeAt(el, left, top) {
    const l = `${Math.round(left)}px`, t = `${Math.round(top)}px`;
    if (el.style.left !== l) el.style.left = l;
    if (el.style.top !== t) el.style.top = t;
  }

  // Our own session is over once its mark has come and gone.
  function watchOwnPending() {
    const p = state.pending;
    if (!p) return;
    const doc = canvas.scene?.tokens?.get(p.tokenId);
    if (!doc) return;
    if (fishingOf(doc)) p.sawFlag = true;
    else if (p.sawFlag) endPending();
  }

  // Every frame: a button at each spot within reach, a bubble over each angler.
  function tick() {
    if (!canvas?.ready) return;
    try {
      watchOwnPending();

      const keep = new Set();
      for (const { region, edge } of offers()) {
        const id = region.id;
        keep.add(id);
        const el = buttonFor(id);
        const s = worldToScreen(edge.x, edge.y - ((canvas.dimensions?.size || 100) * 0.25));
        placeAt(el, s.x, s.y - BUTTON_LIFT_PX - ((el.offsetHeight || 34) / 2));
        el._anchor = edge;
      }
      for (const id of [...state.buttons.keys()]) if (!keep.has(id)) removeEl(state.buttons, id);

      const anglers = new Set();
      for (const token of canvas.tokens?.placeables ?? []) {
        if (!fishingOf(token.document) || !token.visible || !token.mesh || token.mesh.destroyed) continue;
        anglers.add(token.id);
        const el = bubbleFor(token.id);
        const b = token.mesh.getBounds();
        placeAt(el, b.x + (b.width / 2), b.top - 4);
      }
      for (const id of [...state.bubbles.keys()]) if (!anglers.has(id)) removeEl(state.bubbles, id);
    } catch (e) {
      // A ticker callback that throws stops PIXI's frame loop: never let it.
      const now = Date.now();
      if (now - state.lastWarnAt > 5000) {
        state.lastWarnAt = now;
        console.warn(INSTALL_TAG, "Update failed.", e);
      }
    }
  }

  function clearAll() {
    for (const id of [...state.buttons.keys()]) removeEl(state.buttons, id);
    for (const id of [...state.bubbles.keys()]) removeEl(state.bubbles, id);
  }

  function attachTicker() {
    if (state.tickerFn || !canvas?.app?.ticker) return;
    state.tickerFn = tick;
    canvas.app.ticker.add(state.tickerFn, null, PIXI.UPDATE_PRIORITY.UTILITY);
  }

  function detachTicker() {
    if (state.tickerFn && canvas?.app?.ticker) canvas.app.ticker.remove(state.tickerFn);
    state.tickerFn = null;
    clearAll();
  }

  // Keyboard players: Confirm on the spot faced.
  function interactProvider() {
    const out = [];
    for (const [regionId, el] of state.buttons) {
      if (!el._anchor) continue;
      out.push({
        target: `fishSpot:${regionId}`,
        label: `${LABEL} (${BAIT_IP} IP)`,
        icon: ICON,
        order: 35,
        anchor: el._anchor,
        el,
        run: () => press(regionId)
      });
    }
    return out;
  }

  // ------------------------------------------------------------
  // Hooks
  // ------------------------------------------------------------
  Hooks.on("canvasReady", (cv) => {
    attachTicker();
    gmClearStale(cv?.scene);
  });
  Hooks.on("canvasTearDown", () => { detachTicker(); endPending(); });

  Hooks.once("ready", () => {
    try { game.socket.on(SOCKET_CHANNEL, onSocket); } catch (e) { console.error(INSTALL_TAG, "Socket listener failed.", e); }
    window.oni.Interact?.register?.("fishSpot", interactProvider);
    if (canvas?.ready) attachTicker();
    gmClearStale(game.scenes?.active);
    if (canvas?.scene && canvas.scene !== game.scenes?.active) gmClearStale(canvas.scene);
  });

  window.oni.FishingSpots = {
    installed: true,
    BAIT_IP, ROUNDS_PER_BAIT, WATER_FLAG, FISHING_FLAG,
    fishOf, fishRegions, offers, anglerFor, press,
    isFishing: (token) => !!fishingOf(token?.document ?? token),
    state
  };

  console.debug(INSTALL_TAG, "Installed. API: window.oni.FishingSpots");
})();
