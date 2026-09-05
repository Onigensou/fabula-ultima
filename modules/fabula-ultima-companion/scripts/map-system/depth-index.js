/**
 * depth-index.js
 * Fabula Ultima Companion - Exploration Depth Index (pseudo-3D sprite scaling)
 * Foundry VTT v12
 *
 * Purpose:
 * - PS1-JRPG "pre-rendered background" depth on an Exploration scene: a token
 *   drawn near the top of the map (far from the camera) is rendered smaller,
 *   and grows back to its true size as it walks toward the bottom (near the
 *   camera). Optionally also y-sorts tokens so a nearer one draws in front.
 *
 * Scope:
 * - Only runs when the scene's sceneMode is "exploration" AND depthEnabled is
 *   set. Every other mode is untouched.
 *
 * WHY THIS IS PURELY VISUAL (read before changing anything here):
 * - We NEVER write to the token document. An earlier attempt (the world macro
 *   "[DEMO] Pseudo Depth of Field") wrote texture.scaleX/scaleY through
 *   token.document.update(). That persists the depth factor, costs a socket
 *   round-trip per step, and is re-stamped as the token's TRUE scale by
 *   movementControl-api.js (which preserves texture.scaleX/Y when it swaps the
 *   controller sprite) and by the "[DEVTOOL] Token Scale Mirror" macro. Depth
 *   must stay in the PIXI layer or it corrupts real token data.
 *
 * WHY refreshToken IS THE RIGHT HOOK (verified against the v12 client):
 * - Token#animate -> #animateFrame merges the INTERPOLATED position into
 *   this.document each frame, then sets renderFlags {refreshPosition: true}.
 *   PlaceableObject#applyRenderFlags calls Hooks.callAll("refreshToken") right
 *   after _applyRenderFlags. So refreshToken fires once per animation frame and
 *   token.document.y holds the live animated y. Reading doc.y in an
 *   updateToken hook instead would snap the scale at frame 1 of the walk.
 *
 * WHY WE CALL mesh.resize() INSTEAD OF TOUCHING mesh.scale:
 * - Token.RENDER_FLAGS: refreshPosition does NOT propagate to refreshMesh. So
 *   mesh.scale is NOT recomputed on a movement frame, and a multiply-in-place
 *   (mesh.scale.y *= f) would compound every frame - the same runaway that
 *   idle-animation-logic.js documents for its bounce ticker.
 *   Re-running Foundry's own _refreshMesh math with the factor folded into
 *   scaleX/scaleY is idempotent: it is always derived from the document, never
 *   from the current mesh state. resize() also maintains mesh._width/_height,
 *   which a raw scale.set() silently desynchronises.
 *
 * Storage (scene flags, under flags.<module>.oniFabula.general):
 *   depthEnabled    boolean  master switch
 *   depthFarY       number   scene y of the "horizon" line (smallest)
 *   depthNearY      number   scene y of the "near" line (full size)
 *   depthFarScale   number   multiplier at the horizon
 *   depthNearScale  number   multiplier at the near line
 *   depthCurve      number   ramp power (>1 = shrink faster toward the top)
 *   depthSort       boolean  also y-sort tokens (nearer draws in front)
 *
 * Per-token opt-out:
 *   flags.<module>.depthExempt = true
 *
 * Globals:
 *   globalThis.__ONI_DEPTH_INDEX__
 *
 * API:
 *   FUCompanion.api.DepthIndex
 */

(() => {
  const GLOBAL_KEY = "__ONI_DEPTH_INDEX__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";

  // Scene flag paths — these MUST match dungeon-configuration-ui.js.
  const FABULA_ROOT_KEY = "oniFabula";
  const GENERAL_KEY     = "general";
  const SCENE_MODE_KEY  = "sceneMode";

  const DEPTH_ENABLED_KEY    = "depthEnabled";
  const DEPTH_FAR_Y_KEY      = "depthFarY";
  const DEPTH_NEAR_Y_KEY     = "depthNearY";
  const DEPTH_FAR_SCALE_KEY  = "depthFarScale";
  const DEPTH_NEAR_SCALE_KEY = "depthNearScale";
  const DEPTH_CURVE_KEY      = "depthCurve";
  const DEPTH_SORT_KEY       = "depthSort";

  const TOKEN_EXEMPT_FLAG = "depthExempt";

  // Defaults used when a flag is unset or unusable.
  const DEFAULT_FAR_SCALE  = 0.55;
  const DEFAULT_NEAR_SCALE = 1.00;
  const DEFAULT_CURVE      = 1.60;
  const DEFAULT_SORT       = true;

  // Hard clamps. A corrupt flag should degrade to "slightly wrong", never to an
  // invisible or screen-filling sprite.
  const HARD_MIN_FACTOR = 0.10;
  const HARD_MAX_FACTOR = 4.00;

  const DEBUG_KEY = "ONI_DEPTH_INDEX_DEBUG";
  if (globalThis[DEBUG_KEY] === undefined) globalThis[DEBUG_KEY] = false;
  const TAG = "[ONI][DepthIndex]";
  const dbg  = (...a) => { if (globalThis[DEBUG_KEY]) console.log(TAG, ...a); };
  const warn = (...a) => console.warn(TAG, ...a);

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------
  function safeGet(obj, path, fallback = undefined) {
    try {
      const out = foundry.utils.getProperty(obj, path);
      return out === undefined ? fallback : out;
    } catch {
      return fallback;
    }
  }

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function bool(value, fallback = false) {
    if (value === true || value === false) return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // --------------------------------------------------------------------------
  // Scene config cache
  //
  // refreshToken is a hot path (every token, every animation frame). Resolving
  // flags per call would mean a getProperty walk per token per frame, so the
  // resolved config is cached per scene id and invalidated on canvasReady /
  // updateScene. When depth is off the handler costs one property read and a
  // return.
  // --------------------------------------------------------------------------
  const state = {
    installed: false,
    sceneId: null,
    config: null   // null = depth off for the active scene
  };

  function readSceneConfig(scene) {
    if (!scene) return null;

    const fab = scene.getFlag?.(MODULE_ID, FABULA_ROOT_KEY) ?? null;
    if (!fab) return null;

    const mode = safeGet(fab, `${GENERAL_KEY}.${SCENE_MODE_KEY}`, null);
    if (mode !== "exploration") return null;

    if (!bool(safeGet(fab, `${GENERAL_KEY}.${DEPTH_ENABLED_KEY}`, false), false)) return null;

    // Default band = the whole scene rectangle: far at the top edge, near at
    // the bottom edge. sceneRect excludes the padding, which is what we want —
    // the padding is off-image and nothing walks there.
    const rect = canvas?.dimensions?.sceneRect ?? null;
    const defFarY  = rect ? rect.y : 0;
    const defNearY = rect ? rect.y + rect.height : 1000;

    const farY  = num(safeGet(fab, `${GENERAL_KEY}.${DEPTH_FAR_Y_KEY}`,  null), defFarY);
    const nearY = num(safeGet(fab, `${GENERAL_KEY}.${DEPTH_NEAR_Y_KEY}`, null), defNearY);

    // A zero-height band would divide by zero. Treat it as misconfigured.
    if (!Number.isFinite(farY) || !Number.isFinite(nearY) || farY === nearY) {
      warn("Depth band is degenerate (farY === nearY); depth disabled for this scene.", { farY, nearY });
      return null;
    }

    const farScale  = clamp(num(safeGet(fab, `${GENERAL_KEY}.${DEPTH_FAR_SCALE_KEY}`,  null), DEFAULT_FAR_SCALE),  HARD_MIN_FACTOR, HARD_MAX_FACTOR);
    const nearScale = clamp(num(safeGet(fab, `${GENERAL_KEY}.${DEPTH_NEAR_SCALE_KEY}`, null), DEFAULT_NEAR_SCALE), HARD_MIN_FACTOR, HARD_MAX_FACTOR);
    const curve     = clamp(num(safeGet(fab, `${GENERAL_KEY}.${DEPTH_CURVE_KEY}`,      null), DEFAULT_CURVE), 0.05, 8);
    const sort      = bool(safeGet(fab, `${GENERAL_KEY}.${DEPTH_SORT_KEY}`, DEFAULT_SORT), DEFAULT_SORT);

    return { farY, nearY, farScale, nearScale, curve, sort };
  }

  function invalidateConfig(reason = "unknown") {
    state.sceneId = null;
    state.config = null;
    dbg("Config invalidated", { reason });
  }

  function getConfig() {
    const scene = canvas?.scene ?? null;
    if (!scene) return null;
    if (state.sceneId === scene.id) return state.config;

    state.sceneId = scene.id;
    state.config = readSceneConfig(scene);
    dbg("Config resolved for scene", { sceneId: scene.id, sceneName: scene.name, config: state.config });
    return state.config;
  }

  // --------------------------------------------------------------------------
  // The depth ramp
  // --------------------------------------------------------------------------
  /**
   * Depth multiplier for a scene y coordinate.
   * t = 0 at the far (horizon) line, 1 at the near line, clamped outside the
   * band so tokens above the horizon or below the near line hold the endpoint
   * scale instead of inverting.
   */
  function factorForY(y, cfg) {
    const span = cfg.nearY - cfg.farY;
    const t = clamp((y - cfg.farY) / span, 0, 1);
    const eased = Math.pow(t, cfg.curve);
    const f = cfg.farScale + (cfg.nearScale - cfg.farScale) * eased;
    return clamp(f, HARD_MIN_FACTOR, HARD_MAX_FACTOR);
  }

  // --------------------------------------------------------------------------
  // Bounce coordination (idle-animation-logic.js)
  //
  // The bounce ticker writes token.mesh.scale.y from a cached baseScaleY, and
  // its refreshBounceToken() re-captures that base whenever the live scale.y
  // differs from the value the ticker last wrote. Our resize() is exactly such
  // a difference, so without this the bounce base would absorb the depth factor
  // and compound frame over frame.
  //
  // Handing the bounce entry the freshly depth-scaled values keeps it
  // oscillating around the correct base (its phase is time-derived, not
  // accumulated from scale) and keeps its re-capture heuristic quiet.
  // --------------------------------------------------------------------------
  function getBounceEntry(tokenId) {
    try {
      return globalThis.__ONI_IDLE_BOUNCE__?.active?.get?.(tokenId) ?? null;
    } catch {
      return null;
    }
  }

  function syncBounceBase(token, bounce) {
    const mesh = token.mesh;
    bounce.baseScaleY = mesh.scale.y;
    bounce.lastAppliedY = mesh.scale.y;
    if (bounce.original) {
      bounce.original.scaleX = mesh.scale.x;
      bounce.original.scaleY = mesh.scale.y;
    }
  }

  // --------------------------------------------------------------------------
  // Apply
  // --------------------------------------------------------------------------
  /**
   * Re-run Token#_refreshMesh's own maths with the depth factor folded into the
   * texture scale, then plant the sprite's feet and set the depth sort key.
   *
   * Idempotent by construction: every input is read from the document or from
   * canvas dimensions, never from the mesh's current transform.
   */
  function applyDepthToToken(token, cfg) {
    const mesh = token?.mesh;
    if (!mesh || !token.document) return false;

    if (token.document.getFlag?.(MODULE_ID, TOKEN_EXEMPT_FLAG) === true) return false;

    const doc = token.document;
    const { anchorX, anchorY, fit, scaleX, scaleY } = doc.texture ?? {};

    // token.center is derived from document x/y + size, and document x/y is the
    // live animated position during a move.
    const f = factorForY(token.center?.y ?? doc.y, cfg);

    let sx = num(scaleX, 1) * f;
    let sy = num(scaleY, 1) * f;

    // Mirror _refreshMesh's dynamic-ring adjustment so a ringed token keeps its
    // subject fitted inside the ring.
    if (token.hasDynamicRing && CONFIG.Token.ring.isGridFitMode) {
      sx *= token.ring.subjectScaleAdjustment;
      sy *= token.ring.subjectScaleAdjustment;
    }

    const size = token.getSize?.() ?? { width: doc.width * canvas.grid.size, height: doc.height * canvas.grid.size };

    // Height the mesh would have at the token's TRUE scale, needed to work out
    // how far to push the sprite back down after shrinking it.
    const baseHeight = Math.abs(size.height * num(scaleY, 1));

    mesh.resize(size.width, size.height, { fit: fit ?? "fill", scaleX: sx, scaleY: sy });

    // Keep the feet planted. Scaling about the mesh anchor lifts the sprite off
    // the path as it shrinks; shifting down by the height we just lost puts the
    // bottom edge back where it was.
    //
    // The anchor is read live rather than from the document because the bounce
    // system forces anchor.y = 1.0 on the tokens it animates.
    const bounce = getBounceEntry(token.id);
    const effAnchorY = bounce ? 1.0 : num(anchorY, 0.5);
    if (bounce) mesh.anchor.set(num(anchorX, 0.5), 1.0);

    // _refreshPosition has already reset mesh.position to token.center this
    // frame, so this offset is applied to a clean base every time.
    mesh.position.set(token.center.x, token.center.y + (1 - effAnchorY) * baseHeight * (1 - f));

    if (bounce) syncBounceBase(token, bounce);

    // Depth ordering: within the TOKENS sort layer, PrimaryCanvasGroup breaks
    // elevation ties on mesh.sort, so a larger y draws in front. The setter
    // flags the parent sortDirty by itself.
    if (cfg.sort) {
      const key = Math.round(token.center?.y ?? doc.y);
      if (mesh.sort !== key) mesh.sort = key;
    }

    return true;
  }

  /** Restore one token to Foundry's own mesh layout. */
  function clearDepthOnToken(token) {
    try {
      token?.renderFlags?.set?.({ refreshMesh: true, refreshPosition: true, refreshState: true });
    } catch (e) {
      warn("Failed to clear depth on token", { tokenId: token?.id, error: e?.message ?? e });
    }
  }

  /** Re-apply (or clear) depth across every token on the active scene. */
  function refreshAllTokens(reason = "manual") {
    const tokens = canvas?.tokens?.placeables ?? [];
    const cfg = getConfig();
    dbg("Refreshing all tokens", { reason, count: tokens.length, enabled: !!cfg });

    for (const token of tokens) {
      if (cfg) {
        try { applyDepthToToken(token, cfg); }
        catch (e) { warn("applyDepthToToken failed", { tokenId: token?.id, error: e?.message ?? e }); }
      } else {
        clearDepthOnToken(token);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Hooks
  // --------------------------------------------------------------------------
  function installHooks() {
    // The hot path. `flags` tells us which of Foundry's refresh steps ran; we
    // only need to re-assert after one that moved, resized, re-meshed or
    // re-stated the token (refreshState rewrites mesh.sort from document.sort).
    Hooks.on("refreshToken", (token, flags) => {
      const cfg = getConfig();
      if (!cfg) return;

      if (flags && !(flags.refreshPosition || flags.refreshMesh || flags.refreshSize || flags.refreshState || flags.refreshShape)) {
        return;
      }

      try { applyDepthToToken(token, cfg); }
      catch (e) { warn("refreshToken handler failed", { tokenId: token?.id, error: e?.message ?? e }); }
    });

    // drawToken fires before the first refresh on spawn; applying here avoids a
    // single full-size frame as the token pops in.
    Hooks.on("drawToken", (token) => {
      const cfg = getConfig();
      if (!cfg) return;
      try { applyDepthToToken(token, cfg); }
      catch (e) { warn("drawToken handler failed", { tokenId: token?.id, error: e?.message ?? e }); }
    });

    Hooks.on("canvasReady", () => {
      invalidateConfig("canvasReady");
      getConfig();
    });

    Hooks.on("canvasTearDown", () => invalidateConfig("canvasTearDown"));

    // Saving Scene Config changes the band live, with no reload.
    Hooks.on("updateScene", (scene) => {
      if (!canvas?.scene || scene.id !== canvas.scene.id) return;
      invalidateConfig("updateScene");
      refreshAllTokens("updateScene");
    });

    dbg("Hooks installed: refreshToken, drawToken, canvasReady, canvasTearDown, updateScene");
  }

  // --------------------------------------------------------------------------
  // API
  // --------------------------------------------------------------------------
  const api = {
    installed: true,
    MODULE_ID,

    // flag keys, so the config UI and any tooling stay in step with this file
    KEYS: {
      FABULA_ROOT_KEY,
      GENERAL_KEY,
      DEPTH_ENABLED_KEY,
      DEPTH_FAR_Y_KEY,
      DEPTH_NEAR_Y_KEY,
      DEPTH_FAR_SCALE_KEY,
      DEPTH_NEAR_SCALE_KEY,
      DEPTH_CURVE_KEY,
      DEPTH_SORT_KEY,
      TOKEN_EXEMPT_FLAG
    },
    DEFAULTS: {
      farScale: DEFAULT_FAR_SCALE,
      nearScale: DEFAULT_NEAR_SCALE,
      curve: DEFAULT_CURVE,
      sort: DEFAULT_SORT
    },

    readSceneConfig,
    getConfig,
    invalidateConfig,
    factorForY,
    applyDepthToToken,
    refreshAllTokens,

    /** Depth factor a token would be drawn at right now (debug aid). */
    factorForToken(token) {
      const cfg = getConfig();
      if (!cfg || !token) return null;
      return factorForY(token.center?.y ?? token.document?.y, cfg);
    }
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.DepthIndex = api;
    } catch (err) {
      warn("Failed to attach API to FUCompanion.api", err);
    }

    installHooks();
    state.installed = true;
    invalidateConfig("ready");

    dbg("depth-index.js ready", { userId: game.user?.id ?? null, isGM: !!game.user?.isGM });
  });
})();
