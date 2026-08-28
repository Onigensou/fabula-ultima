// ============================================================================
// Dungeon Pathing System — Vertigo
//
// A Vertigo tile plunges the party into disorienting darkness. While the debuff
// holds:
//
//   · Vision collapses to a single tile — a dark veil covers the board and only
//     a small circle around the party token stays lit. Players are fully
//     obscured; the GM sees the same veil at low alpha so they keep their
//     overview of the map.
//   · Scan Mode is locked out (the button greys, ESC/click are inert).
//   · Movement AUTO-CONFIRMS. The party steps onto a tile and its effect
//     resolves immediately — no confirm panel, no Go Back.
//   · Every party member is Blinded (applied by the tile's own effectConfig, so
//     the debuff travels with them into a Conflict/Battle).
//
// Duration: DP.UI.VERTIGO.DEFAULT_MOVES confirmed dungeon steps. Re-entering a
// Vertigo tile REFRESHES the counter back to full rather than stacking. A
// battle does not consume a step — only a confirmed move ticks it down.
//
// It also ends early the moment the party is no longer Blinded: a cleanse is
// meant to lift the darkness, so Blind is treated as the fiction and the
// counter merely as its ceiling.
//
// ── State ────────────────────────────────────────────────────────────────────
// One scene flag, matching the tileStates / visitedTiles / fogRevealed
// convention:
//
//   flags.<MODULE>.dungeonPathing.vertigo = {
//     movesRemaining, maxMoves, sourceTileId, sawBlind
//   }
//
// GM-only writes; every other client picks it up from the `updateScene`
// broadcast for free. `sawBlind` latches once a tick has actually observed
// Blind on a member — without it the cleanse check would fire during the very
// turn Vertigo lands, because the tile effect engine applies Blind AFTER the
// tile handler returns (and asynchronously, over a socket, for player clients).
//
// Hooks.callAll is LOCAL, so the per-move tick fires on the moving player's
// client, not the GM's. Writes route through DP.Socket.vertigo* the same way
// dp-ae-lifecycle routes its AE tick.
//
// ── Overlay ──────────────────────────────────────────────────────────────────
// The veil is a single DOM element, not a PIXI container. See
// feedback_dp_perf_pitfalls: PIXI children orphaned on canvas.stage (which has
// sortableChildren = true) are a recurring source of creeping per-turn lag, and
// a stage overlay would also need manual coverage of everything outside the
// scene rect. One div, one rAF, one resize listener — all torn down in hide().
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const MOD = DP.MODULE_ID ?? "fabula-ultima-companion";
  const TAG = "[DungeonPathing][Vertigo]";

  const FLAG_PATH = `${DP.PATHING_ROOT_KEY ?? "dungeonPathing"}.vertigo`;
  const EL_ID     = "oni-dp-vertigo-overlay";
  const STYLE_ID  = "oni-dp-vertigo-styles";

  // What counts as "the party is still Blinded". Match on both the name and the
  // status id so a hand-applied Blind counts the same as the tile's.
  //
  // ⚠ The tile MUST reference Blind by its CONFIG.statusEffects form
  // ("status:7FLtIUvENcYDAJKC"), never by the world AE's uuid
  // (Item.XVOWOq9oUmEECGrU.ActiveEffect.WIZRIA6k5cnFQoak) — even though both
  // resolve to the same effect. AEM stamps `origin` from the registry entry's
  // sourceUuid, which for an item-owned AE is "Item.…"; ae-lifetime then reads
  // that as item-transferred and NEVER turn-ticks it. The debuff would be
  // permanent, and the cleanse rule below would be the only way out of Vertigo.
  // The config-status form carries ownerUuid null → origin null → tickable.
  const BLIND_NAME_RE   = /\bblind(ed)?\b/i;
  const BLIND_STATUS_ID = "7FLtIUvENcYDAJKC";

  const cfg = () => DP.UI?.VERTIGO ?? {};

  // ---------------------------------------------------------------------------
  // State read
  // ---------------------------------------------------------------------------
  function readState(scene) {
    const raw = scene?.flags?.[MOD]?.[DP.PATHING_ROOT_KEY]?.vertigo;
    if (!raw || typeof raw !== "object") return null;
    const moves = Number(raw.movesRemaining);
    if (!Number.isFinite(moves) || moves <= 0) return null;
    return {
      movesRemaining: moves,
      maxMoves:       Number(raw.maxMoves) || moves,
      sourceTileId:   raw.sourceTileId ?? null,
      sawBlind:       raw.sawBlind === true,
    };
  }

  /** True when the party is currently under Vertigo on the viewed scene. */
  function isActive() {
    return !!readState(canvas?.scene);
  }

  /** Steps left, or 0 when Vertigo is not active. */
  function movesRemaining() {
    return readState(canvas?.scene)?.movesRemaining ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Vision radius — derived from the graph, not hardcoded
  //
  // "One tile of vision" is scene-relative: nodes are 20-50px and their spacing
  // differs per map. Take the distance to the furthest walkable neighbour of the
  // node the party is standing on. Every client derives the same number from the
  // same graph, so nothing about it needs to travel in the flag.
  // ---------------------------------------------------------------------------
  // Memoised for the life of a graph: paint() runs at 60fps and the answer only
  // changes when the party's node does. Invalidated on GRAPH_REBUILT.
  let _radiusCache = null;

  function computeRadius() {
    if (_radiusCache != null) return _radiusCache;
    _radiusCache = _computeRadius();
    return _radiusCache;
  }

  function _computeRadius() {
    const c   = cfg();
    const api = globalThis.__ONI_DUNGEON_PATHING__;
    const gSize = Number(canvas?.grid?.size ?? 100) || 100;
    const fallback = gSize * (c.FALLBACK_GRIDS ?? 1.5);

    const node  = api?.currentNode;
    const graph = api?.graph;
    if (!node?.center || !graph) return fallback;

    let furthest = 0;
    for (const nodeId of (api.state?.neighborIds ?? [])) {
      const n = graph.nodeMap?.get(nodeId);
      if (!n?.center) continue;
      const dx = n.center.x - node.center.x;
      const dy = n.center.y - node.center.y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d > furthest) furthest = d;
    }
    if (!(furthest > 0)) return fallback;

    const r = furthest * (c.NEIGHBOR_FACTOR ?? 1.15);
    return Math.min(c.MAX_RADIUS ?? 460, Math.max(c.MIN_RADIUS ?? 70, r));
  }

  // ---------------------------------------------------------------------------
  // Overlay
  // ---------------------------------------------------------------------------
  let _el        = null;
  let _rafId     = null;
  let _onResize  = null;
  let _rect      = { left: 0, top: 0, width: 1, height: 1 };
  let _center    = null;   // world-space centre of the lit circle (lerped)
  let _target    = null;   // world-space centre we are easing toward
  let _lastPaint = "";     // last background string written — skips no-op writes

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const c = cfg();
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#${EL_ID} {
  position: fixed;
  pointer-events: none;
  z-index: var(--dp-vertigo-z, ${c.Z_INDEX ?? 5});
  opacity: 0;
  transition: opacity ${c.FADE_MS ?? 500}ms ease;
  will-change: opacity;
}
#${EL_ID}.dp-vertigo-visible { opacity: var(--dp-vertigo-alpha, 1); }
    `;
    document.head.appendChild(s);
  }

  /**
   * Where to mount the veil, and at what z.
   *
   * Measured live against Foundry 12.343: #board is a DIRECT child of <body>
   * at z-index 0, and #interface — which holds #ui-left / #ui-right / #sidebar
   * at z-index 30 — is its SIBLING, not its parent. #interface has z-index auto
   * and so creates no stacking context, which is why those UI children stack
   * above the canvas in the root context.
   *
   * The veil therefore mounts on <body> at a z strictly between the two.
   * Anything at or above 30 dims the sidebar and chat — at player alpha 1.0
   * that makes them unreadable, which is what the first live test caught. DP's
   * own UI (status HUD 99990, buttons 99998/99999) sits far above and is
   * unaffected. #hud (token HUD, z 1) is deliberately under the veil.
   */
  function overlayParent() {
    return { host: document.body, z: cfg().Z_INDEX ?? 5 };
  }

  function getCanvasView() {
    return canvas?.app?.view ?? canvas?.app?.renderer?.view
        ?? document.querySelector("#board canvas") ?? document.querySelector("canvas");
  }

  /** World point → client px. Mirrors dp-confirm-dialog.worldToClient(). */
  function worldToClient(worldX, worldY) {
    const t = canvas?.stage?.worldTransform;
    if (!t) return { x: 0, y: 0 };
    const rx  = t.a * worldX + t.c * worldY + t.tx;
    const ry  = t.b * worldX + t.d * worldY + t.ty;
    const el  = getCanvasView();
    const elW = el?.width  || _rect.width  || 1;
    const elH = el?.height || _rect.height || 1;
    return {
      x: _rect.left + (rx / elW) * _rect.width,
      y: _rect.top  + (ry / elH) * _rect.height,
    };
  }

  /**
   * Where the lit circle wants to be, in world space: the party token's centre,
   * shifted back off TOKEN_OFFSET so it sits on the tile rather than the token's
   * feet-aligned display position.
   */
  function tokenTargetCentre() {
    const token = globalThis.__ONI_DUNGEON_PATHING__?.state?.partyToken;
    const doc   = token?.document;
    if (!doc) return null;
    const gSize = Number(canvas?.grid?.size ?? 100) || 100;
    const tw    = Number(token.w ?? (Number(doc.width  ?? 1) * gSize));
    const th    = Number(token.h ?? (Number(doc.height ?? 1) * gSize));
    return {
      x: Number(doc.x) + tw / 2 - Number(DP.UI?.TOKEN_OFFSET?.x ?? 0),
      y: Number(doc.y) + th / 2 - Number(DP.UI?.TOKEN_OFFSET?.y ?? 0),
    };
  }

  function paint() {
    if (!_el) return;
    const c = cfg();

    // Ease toward the target. The token document only updates near the END of
    // the 650ms move animation (dp-movement animates a throwaway sprite), so
    // without this the light would sit on the old tile and then snap. The lerp
    // makes the circle travel WITH the party instead.
    const want = _target ?? tokenTargetCentre();
    if (want) {
      if (!_center) _center = { ...want };
      else {
        const k = c.FOLLOW_LERP ?? 0.12;
        _center.x += (want.x - _center.x) * k;
        _center.y += (want.y - _center.y) * k;
      }
    }
    if (!_center) return;

    const pt    = worldToClient(_center.x, _center.y);
    const scale = Number(canvas?.stage?.scale?.x ?? 1) || 1;
    const inner = Math.round(computeRadius() * scale);
    const outer = Math.round(inner * (1 + (c.FEATHER ?? 0.6)));

    // Coordinates are relative to the overlay element, which is pinned to the
    // canvas rect.
    const x = Math.round(pt.x - _rect.left);
    const y = Math.round(pt.y - _rect.top);

    const dark = c.DARKNESS ?? 0.94;
    const bg = `radial-gradient(circle at ${x}px ${y}px,`
             + ` rgba(0,0,0,0) 0px, rgba(0,0,0,0) ${inner}px,`
             + ` rgba(0,0,0,${dark}) ${outer}px)`;

    // Writing an identical background string every frame still costs a style
    // recalc; skip it when nothing moved.
    if (bg !== _lastPaint) {
      _el.style.background = bg;
      _lastPaint = bg;
    }
  }

  function startTracking() {
    stopTracking();

    const view = getCanvasView();
    _rect = view?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 1, height: 1 };
    applyRect();

    // Module-level so stopTracking() can always remove it — a per-call closure
    // leaks one listener per activation (feedback_dp_perf_pitfalls #2).
    _onResize = () => {
      const v = getCanvasView();
      _rect = v?.getBoundingClientRect?.() ?? _rect;
      applyRect();
    };
    window.addEventListener("resize", _onResize, { passive: true });

    const tick = () => {
      if (!_el) { stopTracking(); return; }
      paint();
      _rafId = requestAnimationFrame(tick);
    };
    _rafId = requestAnimationFrame(tick);
  }

  function stopTracking() {
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = null;
    if (_onResize) window.removeEventListener("resize", _onResize);
    _onResize = null;
  }

  /** Pin the overlay to the canvas rect so the sidebar/UI stay unshaded. */
  function applyRect() {
    if (!_el) return;
    _el.style.left   = `${Math.round(_rect.left)}px`;
    _el.style.top    = `${Math.round(_rect.top)}px`;
    _el.style.width  = `${Math.round(_rect.width)}px`;
    _el.style.height = `${Math.round(_rect.height)}px`;
    _lastPaint = ""; // geometry moved — force the next paint through
  }

  function showOverlay() {
    injectStyles();
    if (_el) return;

    const { host, z } = overlayParent();
    _el = document.createElement("div");
    _el.id = EL_ID;
    _el.style.setProperty(
      "--dp-vertigo-alpha",
      String(game.user?.isGM ? (cfg().GM_ALPHA ?? 0.35) : 1)
    );
    _el.style.setProperty("--dp-vertigo-z", String(z));
    host.appendChild(_el);

    _center = tokenTargetCentre();  // snap on first show — never sweep in from 0,0
    _target = _center ? { ..._center } : null;
    _lastPaint = "";

    startTracking();
    paint();
    requestAnimationFrame(() => { _el?.classList.add("dp-vertigo-visible"); });
  }

  function hideOverlay({ animate = true } = {}) {
    stopTracking();
    if (!_el) return;
    const el = _el;
    _el = null;
    _center = null;
    _target = null;
    _lastPaint = "";
    _radiusCache = null;
    if (animate) {
      el.classList.remove("dp-vertigo-visible");
      setTimeout(() => el.remove(), (cfg().FADE_MS ?? 500) + 60);
    } else {
      el.remove();
    }
  }

  // ---------------------------------------------------------------------------
  // Local sync — drive the overlay + scan lockout off the scene flag
  // ---------------------------------------------------------------------------
  let _wasActive         = false;
  // Whether Vertigo was already in force when the current turn began — see the
  // TURN_START / TURN_END pair below.
  let _activeAtTurnStart = false;
  // Set when this client's Vertigo tile handler (re)applies the debuff during the
  // current turn. Such a turn must NOT also tick: the apply and the tick are two
  // independent socket messages, and with no ordering between them the tick's
  // read-modify-write clobbers the refresh (live test: re-entry landed on 3
  // instead of refreshing to 5).
  let _appliedThisTurn   = false;

  function sync({ silent = false } = {}) {
    const dungeonActive = !!globalThis.__ONI_DUNGEON_PATHING__?.state?.active;
    const active        = dungeonActive && isActive();

    if (active && !_wasActive) {
      showOverlay();
      DP.ScanMode?.setScanDisabled?.(true);
      // Local-only sounds (push=false), so every client plays its own copy when
      // it observes the flag turn on — no separate broadcast needed.
      if (!silent) DP.Sound?.playVertigo?.();
    } else if (!active && _wasActive) {
      hideOverlay();
      DP.ScanMode?.setScanDisabled?.(false);
    } else if (active) {
      // Still active — keep the button greyed through rebuilds / re-shows.
      DP.ScanMode?.setScanDisabled?.(true);
    }

    _wasActive = active;
    DP.StatusHUD?.refresh?.();
  }

  // ---------------------------------------------------------------------------
  // Blind detection (GM side)
  // ---------------------------------------------------------------------------
  function isBlindEffect(eff) {
    if (!eff) return false;
    if (BLIND_NAME_RE.test(String(eff.name ?? eff.label ?? ""))) return true;
    const st = eff.statuses;
    if (!st) return false;
    if (typeof st.has === "function") return st.has(BLIND_STATUS_ID);
    return Array.isArray(st) && st.includes(BLIND_STATUS_ID);
  }

  async function resolveParty() {
    try {
      return await DP.TileEffectEngine?.resolvePartyMembers?.() ?? [];
    } catch (e) {
      console.warn(TAG, "party resolve failed:", e);
      return [];
    }
  }

  async function partyHasBlind() {
    const members = await resolveParty();
    return members.some(a => (a?.effects ?? []).some(isBlindEffect));
  }

  // ---------------------------------------------------------------------------
  // GM-side writes
  // ---------------------------------------------------------------------------
  // Every GM-side mutation goes through one promise chain. apply / tick / clear
  // arrive as independent socket messages with no ordering guarantee, and each is
  // a read-modify-write on the same flag — without this they interleave and the
  // last writer wins with stale data.
  let _writeQueue = Promise.resolve();
  function serialize(op) {
    const next = _writeQueue.then(op, op);
    _writeQueue = next.catch(() => {});
    return next;
  }

  async function writeState(scene, value) {
    if (!game.user?.isGM || !scene) return;
    if (value === null) {
      await scene.unsetFlag(MOD, FLAG_PATH)
        .catch(e => console.warn(TAG, "clear failed:", e));
    } else {
      // setFlag merges, and every field is rewritten each time, so a plain set
      // is enough — there are no stale sub-keys to strand.
      await scene.setFlag(MOD, FLAG_PATH, value)
        .catch(e => console.warn(TAG, "write failed:", e));
    }
  }

  /** GM: afflict the party. Re-entry REFRESHES to full rather than stacking. */
  async function applyAsGM(args = {}) { return serialize(() => _applyAsGM(args)); }
  async function _applyAsGM({ sceneId, tileId, moves } = {}) {
    const scene = game.scenes.get(sceneId) ?? canvas?.scene;
    if (!scene) return;
    const max = Math.max(1, Number(moves) || cfg().DEFAULT_MOVES || 5);
    await writeState(scene, {
      movesRemaining: max,
      maxMoves:       max,
      sourceTileId:   tileId ?? null,
      sawBlind:       false,
    });
    console.debug(TAG, `applied — ${max} move(s) on "${scene.name}"`);
  }

  /**
   * GM: one confirmed dungeon step has resolved. Counts down, and ends early if
   * the party has been cleansed of Blind.
   */
  async function tickAsGM(args = {}) { return serialize(() => _tickAsGM(args)); }
  async function _tickAsGM({ sceneId } = {}) {
    const scene = game.scenes.get(sceneId) ?? canvas?.scene;
    const st    = readState(scene);
    if (!st) return;

    const hasBlind = await partyHasBlind();

    // The cleanse rule only arms once we have actually seen Blind land. The tile
    // effect engine applies it after the handler returns — asynchronously, via
    // socket, on player clients — so an un-latched check would clear Vertigo on
    // the very turn it was inflicted.
    if (st.sawBlind && !hasBlind) {
      await writeState(scene, null);
      console.debug(TAG, "ended early — the party is no longer Blinded.");
      return;
    }

    const next = st.movesRemaining - 1;
    if (next <= 0) {
      await writeState(scene, null);
      console.debug(TAG, "expired.");
      return;
    }
    await writeState(scene, {
      ...st,
      movesRemaining: next,
      sawBlind: st.sawBlind || hasBlind,
    });
    console.debug(TAG, `tick — ${next} move(s) left`);
  }

  /** GM: lift Vertigo immediately (cleanse, or the GM's own override). */
  async function clearAsGM(args = {}) { return serialize(() => _clearAsGM(args)); }
  async function _clearAsGM({ sceneId } = {}) {
    const scene = game.scenes.get(sceneId) ?? canvas?.scene;
    if (!readState(scene)) return;
    await writeState(scene, null);
    console.debug(TAG, "cleared.");
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    // Scene flag changed anywhere → re-sync this client.
    Hooks.on("updateScene", (sceneDoc, diff) => {
      if (!canvas?.scene || sceneDoc.id !== canvas.scene.id) return;
      const dp = diff?.flags?.[MOD]?.[DP.PATHING_ROOT_KEY];
      if (!dp) return;
      if (!("vertigo" in dp) && !("-=vertigo" in dp)) return;
      sync();
    });

    // A fresh canvas re-reads the flag, but without the sting: re-entering the
    // scene is not a new affliction.
    Hooks.on("canvasReady", () => {
      _wasActive = false;
      _activeAtTurnStart = false;
      sync({ silent: true });
    });
    Hooks.on("canvasTearDown", () => {
      hideOverlay({ animate: false });
      _wasActive = false;
      _activeAtTurnStart = false;
    });

    // Lead the circle toward the destination the moment the player commits, so
    // the light travels with the party instead of snapping at the end of the
    // move animation.
    Hooks.on(DP.HOOKS.STANDBY_END, ({ chosenNode }) => {
      if (!_el || !chosenNode?.center) return;
      _target = { x: chosenNode.center.x, y: chosenNode.center.y };
    });
    // Covers every other arrival path (force move, gusty push-back, fast travel).
    Hooks.on(DP.HOOKS.TOKEN_MOVED, ({ toNode }) => {
      if (!_el || !toNode?.center) return;
      _target = { x: toNode.center.x, y: toNode.center.y };
    });
    Hooks.on(DP.HOOKS.TURN_REVERTED, ({ fromNode }) => {
      if (!_el || !fromNode?.center) return;
      _target = { x: fromNode.center.x, y: fromNode.center.y };
    });
    // The graph may have moved the party without a turn (scene load, GM nudge,
    // fast travel). Node spacing can differ wherever they ended up, so the
    // memoised radius goes with it.
    Hooks.on(DP.HOOKS.GRAPH_REBUILT, () => {
      _radiusCache = null;
      if (!_el) return;
      _target = tokenTargetCentre();
      _lastPaint = "";
    });

    // One confirmed step = one tick. Hooks.callAll is local, so this fires on
    // the moving client; DP.Socket routes the write to the GM.
    //
    // The tick is gated on Vertigo having been active when the turn BEGAN, not
    // when it ended. On a GM client the tile handler's flag write is awaited
    // inline, so by TURN_END the debuff is already live and an end-state check
    // would spend a step on the very turn the party was afflicted (5 → 4 before
    // they had moved once). Player clients wouldn't, because their flag arrives
    // over the socket a beat later — so the same fight would count differently
    // depending on who was walking. Snapshotting at TURN_START makes it
    // deterministic on every client, and keeps a force-move/gusty chain as the
    // single step it reads as.
    Hooks.on(DP.HOOKS.TURN_START, () => {
      _activeAtTurnStart = isActive();
      _appliedThisTurn   = false;
    });

    Hooks.on(DP.HOOKS.TURN_END, () => {
      const due     = _activeAtTurnStart;
      const applied = _appliedThisTurn;
      _activeAtTurnStart = false;
      _appliedThisTurn   = false;
      // A turn that (re)applied Vertigo never also spends a step — the landing
      // IS the affliction. This is what keeps a refresh at full duration.
      if (applied || !due || !isActive()) return;
      DP.Socket?.vertigoTick?.().catch(e => console.warn(TAG, "tick dispatch failed:", e));
    });

    // Cleanse ends it immediately rather than at the next step. Only the primary
    // GM evaluates, and only when a Blind actually left a party member — so this
    // can never misfire during the turn Vertigo lands.
    Hooks.on("deleteActiveEffect", (eff) => {
      if (!game.user?.isGM) return;
      if (DP.isPrimaryGM && !DP.isPrimaryGM()) return;
      if (!isBlindEffect(eff)) return;
      const scene = canvas?.scene;
      if (!readState(scene)) return;
      const parentId = eff?.parent?.id;
      if (!parentId) return;

      (async () => {
        const members = await resolveParty();
        if (!members.some(a => a?.id === parentId)) return; // not a party member
        if (await partyHasBlind()) return;                  // someone is still Blind
        await writeState(scene, null);
        console.debug(TAG, "ended early — Blind was cleansed from the party.");
      })().catch(e => console.warn(TAG, "cleanse check failed:", e));
    });

    console.debug(TAG, "Vertigo subsystem loaded.");
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  DP.Vertigo = {
    isActive,
    movesRemaining,
    computeRadius,
    sync,

    /**
     * Called by the Vertigo tile handler on the client running the turn, to mark
     * that this turn IS the affliction. Suppresses that turn's tick so a refresh
     * keeps its full duration instead of racing the countdown.
     */
    noteApplied() { _appliedThisTurn = true; },
    partyHasBlind,

    // GM entry points — the socket layer calls these after routing.
    applyAsGM,
    tickAsGM,
    clearAsGM,

    /** Afflict the party from any client. */
    async apply(scene, tileId, moves) {
      return DP.Socket?.vertigoApply?.(scene ?? canvas?.scene, tileId, moves);
    },

    /** Lift Vertigo from any client (GM tool / cleanse hook). */
    async clear(scene) {
      return DP.Socket?.vertigoClear?.(scene ?? canvas?.scene);
    },
  };
})();
