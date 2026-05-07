/* ============================================================================
 * FabulaUltimaCompanion — Idle Animation System (LOGIC)
 * File: scripts/idle-animation/idle-animation-logic.js
 * Foundry VTT v12
 *
 * IMPORTANT RULE (ANTI-SPAM):
 * We ONLY apply idle animations from:
 *  1) Token spawn: drawToken
 *  2) User press "Update Token": UI submit -> socket/apply calls
 *
 * Float apply is idempotent + locked:
 *  - If already ON, skip additional apply attempts
 *  - If currently applying, deny/skip concurrent attempts
 *  - Same for removal
 * ============================================================================ */

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][IdleAnim][Logic]";

  // DEBUG TOGGLE
  if (globalThis.ONI_IDLE_ANIM_DEBUG === undefined) globalThis.ONI_IDLE_ANIM_DEBUG = false;
  function dbg(...args) { if (globalThis.ONI_IDLE_ANIM_DEBUG) console.log(TAG, ...args); }
  function warn(...args) { console.warn(TAG, ...args); }
  function err(...args) { console.error(TAG, ...args); }

  // GLOBAL API (NO IMPORTS)
  const API_KEY = "__ONI_IDLE_ANIM_API__";
  if (globalThis[API_KEY]) {
    dbg("API already installed, skipping re-init.");
    return;
  }

  // FLAGS
  const ACTOR_FLAG_KEY = "idleAnimation";          // flags.<module>.idleAnimation
  const TOKEN_OVERRIDE_FLAG_KEY = "idleAnimToken"; // flags.<module>.idleAnimToken (per-token override)

  function normalizeConfig(cfg) {
    return { float: !!cfg?.float, bounce: !!cfg?.bounce };
  }

  // --------------------------------------------------------------------------
  // INTERNAL STATE (idempotency + locks)
  // --------------------------------------------------------------------------
  const STATE_NS = "__ONI_IDLE_ANIM_STATE__";
  const state = (globalThis[STATE_NS] = globalThis[STATE_NS] || {
    tokens: new Map(), // tokenId -> { floatOn, bounceOn, floatLock, bounceLock, lastConfigKey }
  });

  function getTokenState(tokenId) {
    if (!state.tokens.has(tokenId)) {
      state.tokens.set(tokenId, {
        floatOn: false,
        bounceOn: false,
        floatLock: false,
        bounceLock: false,
        lastConfigKey: ""
      });
    }
    return state.tokens.get(tokenId);
  }

  function dropTokenState(tokenId) {
    state.tokens.delete(tokenId);
  }

  function getTokenById(tokenId) {
    try { return canvas?.tokens?.get?.(tokenId) ?? null; }
    catch { return null; }
  }

  function tokenExists(token) {
    if (!token?.id) return false;
    const live = getTokenById(token.id);
    return !!live;
  }

  function configKey(cfg) {
    const c = normalizeConfig(cfg);
    return `F:${c.float ? 1 : 0}|B:${c.bounce ? 1 : 0}`;
  }

  // ----------------------------
  // ACTOR DEFAULT (prototype)
  // ----------------------------
  async function getActorDefaultConfig(actor) {
    if (!actor) return normalizeConfig(null);
    return normalizeConfig(actor.getFlag(MODULE_ID, ACTOR_FLAG_KEY));
  }

  async function setActorDefaultConfig(actor, cfg) {
    if (!actor) return;
    const next = normalizeConfig(cfg);
    dbg("Saving ACTOR default config", { actor: actor.name, actorId: actor.id, next });
    await actor.setFlag(MODULE_ID, ACTOR_FLAG_KEY, next);
    return next;
  }

  // ----------------------------
  // TOKEN OVERRIDE
  // ----------------------------
  async function getTokenOverrideConfig(tokenDocOrToken) {
    const doc = tokenDocOrToken?.document ?? tokenDocOrToken;
    if (!doc) return null;
    const cfg = doc.getFlag?.(MODULE_ID, TOKEN_OVERRIDE_FLAG_KEY);
    if (!cfg) return null;
    return normalizeConfig(cfg);
  }

  async function setTokenOverrideConfig(tokenDocOrToken, cfg) {
    const doc = tokenDocOrToken?.document ?? tokenDocOrToken;
    if (!doc) return;
    const next = normalizeConfig(cfg);
    dbg("Saving TOKEN override config", { tokenId: doc.id, name: doc.name, next });
    await doc.setFlag(MODULE_ID, TOKEN_OVERRIDE_FLAG_KEY, next);
    return next;
  }

  async function clearTokenOverrideConfig(tokenDocOrToken) {
    const doc = tokenDocOrToken?.document ?? tokenDocOrToken;
    if (!doc) return;
    dbg("Clearing TOKEN override config", { tokenId: doc.id, name: doc.name });
    await doc.unsetFlag(MODULE_ID, TOKEN_OVERRIDE_FLAG_KEY);
  }

  // ----------------------------
  // EFFECTIVE CONFIG (token view)
  // ----------------------------
  async function getEffectiveConfigForToken(token) {
    const sourceActorId = token?.document?.actorId;
    const actor = sourceActorId ? game.actors?.get(sourceActorId) : null;

    const override = await getTokenOverrideConfig(token);
    if (override) return { config: override, source: "tokenOverride" };

    const base = await getActorDefaultConfig(actor);
    return { config: base, source: "actorDefault" };
  }

  function getTokensForSourceActor(sourceActorId) {
    if (!canvas?.ready) return [];
    const list = canvas.tokens?.placeables ?? [];
    return list.filter(t => t?.document?.actorId === sourceActorId);
  }

  // ==========================================================================
  // FLOAT (TokenMagic) — OnSelected approach (same style as Idle Float.js) :contentReference[oaicite:1]{index=1}
  // ==========================================================================
  const FLOAT_FILTER_ID = "oniIdleFloat";

  function hasTokenMagic() {
    return !!globalThis.TokenMagic
      && typeof TokenMagic.addUpdateFiltersOnSelected === "function"
      && typeof TokenMagic.deleteFiltersOnSelected === "function";
  }

  async function withTempControl(token, fn) {
    // Hard safety: token may have been deleted between queue and run
    if (!tokenExists(token)) throw new Error(`Token "${token?.id}" does not exist on canvas`);

    const previously = canvas.tokens.controlled.map(t => t.id);
    const wasControlled = token.controlled;

    try {
      canvas.tokens.releaseAll();
      token.control({ releaseOthers: true });

      // check again after control (very defensive)
      if (!tokenExists(token)) throw new Error(`Token "${token?.id}" does not exist after control`);

      await fn();
    } finally {
      // Restore controls (only if canvas still exists)
      if (canvas?.tokens) {
        canvas.tokens.releaseAll();
        for (const id of previously) canvas.tokens.get(id)?.control({ releaseOthers: false });
        if (!wasControlled) token.release?.();
      }
    }
  }

  async function applyFloatOnce(token) {
    if (!token?.document) return;
    const st = getTokenState(token.id);

    if (!hasTokenMagic()) {
      warn("Float requested, but TokenMagic OnSelected APIs are not available.");
      return;
    }

    // DENY if already ON or currently applying
    if (st.floatOn) {
      dbg("Float apply denied (already ON)", { token: token.name, tokenId: token.id });
      return;
    }
    if (st.floatLock) {
      dbg("Float apply denied (LOCKED / in-progress)", { token: token.name, tokenId: token.id });
      return;
    }

    st.floatLock = true;

    // Based on your Idle Float.js params :contentReference[oaicite:2]{index=2}
    const params = [{
      filterType: "transform",
      filterId: FLOAT_FILTER_ID,
      padding: 50,
      animated: {
        translationX: { animType: "sinOscillation", val1: -0, val2: +0, loopDuration: 1400 },
        translationY: { animType: "cosOscillation", val1: -0.05, val2: +0.05, loopDuration: 3000 }
      }
    }];

    try {
      await withTempControl(token, async () => {
        await TokenMagic.addUpdateFiltersOnSelected(params);
      });

      st.floatOn = true;
      dbg("Float applied (ONCE)", { token: token.name, tokenId: token.id });
    } catch (e) {
      err("Failed to apply Float", e);
    } finally {
      st.floatLock = false;
    }
  }

  async function removeFloatOnce(token) {
    if (!token?.document) return;
    const st = getTokenState(token.id);

    if (!globalThis.TokenMagic) return;

    // DENY if already OFF or currently removing/applying
    if (!st.floatOn) {
      dbg("Float remove denied (already OFF)", { token: token.name, tokenId: token.id });
      return;
    }
    if (st.floatLock) {
      dbg("Float remove denied (LOCKED / in-progress)", { token: token.name, tokenId: token.id });
      return;
    }

    st.floatLock = true;

    try {
      // Prefer targeted deleteFilters if available (doesn't rely on selection)
      if (typeof TokenMagic.deleteFilters === "function") {
        try {
          await TokenMagic.deleteFilters(token, FLOAT_FILTER_ID);
          st.floatOn = false;
          dbg("Float removed (targeted deleteFilters)", { token: token.name, tokenId: token.id });
          return;
        } catch {
          // fallback to OnSelected
        }
      }

      if (typeof TokenMagic.deleteFiltersOnSelected === "function") {
        await withTempControl(token, async () => {
          await TokenMagic.deleteFiltersOnSelected();
        });

        st.floatOn = false;
        dbg("Float removed (OnSelected)", { token: token.name, tokenId: token.id });
        return;
      }
    } catch (e) {
      err("Failed to remove Float", e);
    } finally {
      st.floatLock = false;
    }
  }

  // ==========================================================================
  // BOUNCE (PIXI) — unchanged core, but idempotent toggles
  // ==========================================================================
  const BOUNCE_NS = "__ONI_IDLE_BOUNCE__";
  const BOUNCE_AMP = 0.025;
  const BOUNCE_PERIOD_MS = 2500;

  function bounceState() {
    return (globalThis[BOUNCE_NS] = globalThis[BOUNCE_NS] || {
      active: new Map(), // tokenId -> state
      tickerFn: null,
      timeMs: 0
    });
  }

  function ensureBounceTicker() {
    const g = bounceState();
    if (g.tickerFn) return;

    g.timeMs = 0;
    g.tickerFn = () => {
      if (!canvas?.ready) return;

      g.timeMs += canvas.app.ticker.deltaMS;
      const twoPi = Math.PI * 2;

      for (const [id, st] of g.active) {
        const token = canvas.tokens.get(id);
        if (!token || !token.mesh) {
          g.active.delete(id);
          continue;
        }
        const phase = ((g.timeMs + st.phaseOffsetMs) % BOUNCE_PERIOD_MS) / BOUNCE_PERIOD_MS;
        const scaleY = 1 + BOUNCE_AMP * Math.sin(phase * twoPi);
        token.mesh.scale.y = st.baseScaleY * scaleY;
      }

      if (!g.active.size) {
        canvas.app.ticker.remove(g.tickerFn);
        g.tickerFn = null;
        dbg("Bounce ticker stopped (no active tokens).");
      }
    };

    canvas.app.ticker.add(g.tickerFn);
    dbg("Bounce ticker started.");
  }

  function startBounceOnce(token) {
    if (!token?.mesh) return;
    const st = getTokenState(token.id);
    const g = bounceState();

    if (st.bounceOn || g.active.has(token.id)) {
      dbg("Bounce start denied (already ON)", { token: token.name, tokenId: token.id });
      st.bounceOn = true; // keep consistent
      return;
    }

    const original = {
      anchorX: token.mesh.anchor.x,
      anchorY: token.mesh.anchor.y,
      scaleX: token.mesh.scale.x,
      scaleY: token.mesh.scale.y
    };

    token.mesh.anchor.set(0.5, 1.0);
    const phaseOffsetMs = Math.floor(Math.random() * BOUNCE_PERIOD_MS);

    g.active.set(token.id, { original, baseScaleY: token.mesh.scale.y, phaseOffsetMs });
    st.bounceOn = true;

    ensureBounceTicker();
    dbg("Bounce started", { token: token.name, tokenId: token.id });
  }

  function stopBounceOnce(token) {
    const st = getTokenState(token.id);
    const g = bounceState();
    const b = g.active.get(token?.id);

    if (!st.bounceOn && !b) {
      dbg("Bounce stop denied (already OFF)", { token: token.name, tokenId: token.id });
      st.bounceOn = false;
      return;
    }

    if (b && token?.mesh) {
      token.mesh.anchor.set(b.original.anchorX, b.original.anchorY);
      token.mesh.scale.set(b.original.scaleX, b.original.scaleY);
    }

    g.active.delete(token.id);
    st.bounceOn = false;

    dbg("Bounce stopped", { token: token.name, tokenId: token.id });
  }

  function refreshBounceToken(token) {
    const g = bounceState();
    const b = g.active.get(token?.id);
    if (!b) return;
    if (!token?.mesh) return;

    token.mesh.anchor.set(0.5, 1.0);
    b.baseScaleY = token.mesh.scale.y;

    dbg("Bounce refreshed (mesh rebuild)", { token: token.name, tokenId: token.id });
  }

  // ==========================================================================
  // APPLY CONFIG (idempotent)
  // ==========================================================================
  async function applyConfigToToken(token, cfg, reason = "unknown") {
    if (!token) return;

    // only allow from: spawn or update
    if (reason !== "spawn" && reason !== "update") {
      dbg("applyConfigToToken denied (reason not allowed)", { reason, tokenId: token.id });
      return;
    }

    const config = normalizeConfig(cfg);
    const st = getTokenState(token.id);

    // If config hasn't changed, skip entirely (hard anti-spam)
    const key = configKey(config);
    if (st.lastConfigKey === key) {
      dbg("Apply skipped (config unchanged)", { token: token.name, tokenId: token.id, key, reason });
      return;
    }

    st.lastConfigKey = key;

    dbg("Applying config to token", {
      token: token.name,
      tokenId: token.id,
      actorId: token?.document?.actorId,
      config,
      reason
    });

    // Float
    if (config.float) await applyFloatOnce(token);
    else await removeFloatOnce(token);

    // Bounce
    if (config.bounce) startBounceOnce(token);
    else stopBounceOnce(token);
  }

  async function applyEffectiveConfigToToken(token, reason = "unknown") {
    const { config, source } = await getEffectiveConfigForToken(token);
    dbg("applyEffectiveConfigToToken()", { tokenId: token.id, token: token.name, source, config, reason });
    await applyConfigToToken(token, config, reason);
  }

  async function applyActorToAllTokens(sourceActorId, reason = "update") {
    const tokens = getTokensForSourceActor(sourceActorId);
    dbg("applyActorToAllTokens()", { sourceActorId, tokenCount: tokens.length, reason });

    for (const t of tokens) {
      await applyEffectiveConfigToToken(t, reason); // respects overrides
    }
  }

  // ==========================================================================
  // SPAWN APPLY (NO QUEUE SPAM)
  // We only hook drawToken for spawn apply (reliable for visuals).
  // ==========================================================================
  async function applyOnSpawn(tokenObj) {
    try {
      const token = tokenObj;
      if (!token?.id) return;

      // ensure state exists
      getTokenState(token.id);

      // IMPORTANT: spawn apply is allowed
      await applyEffectiveConfigToToken(token, "spawn");
    } catch (e) {
      err("applyOnSpawn failed", e);
    }
  }

  // ==========================================================================
  // SOCKET SYNC (still needed for multi-client)
  // ==========================================================================
  const SOCKET_EVENT = "idleAnimSync";

  function emitSocketApplyActor(actorId) {
    try {
      game.socket.emit(`module.${MODULE_ID}`, { type: SOCKET_EVENT, mode: "applyActor", actorId });
      dbg("Socket emit -> applyActor", { actorId });
    } catch (e) {
      err("Socket emit failed", e);
    }
  }

  function emitSocketApplyToken(tokenId) {
    try {
      game.socket.emit(`module.${MODULE_ID}`, { type: SOCKET_EVENT, mode: "applyToken", tokenId });
      dbg("Socket emit -> applyToken", { tokenId });
    } catch (e) {
      err("Socket emit failed", e);
    }
  }

  function installSocketListener() {
    const KEY = "__ONI_IDLE_ANIM_SOCKET__";
    if (globalThis[KEY]) return;
    globalThis[KEY] = true;

    game.socket.on(`module.${MODULE_ID}`, async (payload) => {
      try {
        if (!payload || payload.type !== SOCKET_EVENT) return;

        if (payload.mode === "applyActor") {
          dbg("Socket receive <- applyActor", payload);
          await applyActorToAllTokens(payload.actorId, "update");
          return;
        }

        if (payload.mode === "applyToken") {
          dbg("Socket receive <- applyToken", payload);

          const token = getTokenById(payload.tokenId);
          if (!token) {
            // token might not exist on this client (deleted/scene changed)
            dbg("applyToken skipped (token not on canvas)", { tokenId: payload.tokenId });
            dropTokenState(payload.tokenId);
            return;
          }

          await applyEffectiveConfigToToken(token, "update");
          return;
        }
      } catch (e) {
        err("Socket handler error", e);
      }
    });

    dbg("Socket listener installed:", `module.${MODULE_ID}`);
  }

  // ==========================================================================
  // HOOKS
  // - Spawn: drawToken only
  // - RefreshToken: bounce refresh only (NO re-apply)
  // ==========================================================================
  function installHooks() {
    Hooks.on("drawToken", (tokenObj) => {
      dbg("drawToken (spawn) -> apply", { tokenId: tokenObj?.id, name: tokenObj?.name });
      applyOnSpawn(tokenObj);
    });

    Hooks.on("refreshToken", (token) => {
      // Only bounce needs mesh refresh; DO NOT re-apply float here (prevents spam)
      try { refreshBounceToken(token); }
      catch (e) { err("refreshToken handler failed", e); }
    });

    Hooks.on("deleteToken", (doc) => {
      try {
        dbg("deleteToken -> drop state", { tokenId: doc?.id, name: doc?.name });
        dropTokenState(doc?.id);
      } catch (e) {
        err("deleteToken handler failed", e);
      }
    });

    dbg("Hooks installed: drawToken(spawn), refreshToken(bounce-only), deleteToken(cleanup)");
  }

  // ----------------------------
  // PUBLIC API for UI
  // ----------------------------
  globalThis[API_KEY] = {
    MODULE_ID,
    TAG,

    normalizeConfig,

    // actor default
    getActorDefaultConfig,
    setActorDefaultConfig,

    // token override
    getTokenOverrideConfig,
    setTokenOverrideConfig,
    clearTokenOverrideConfig,

    // apply
    applyConfigToToken,
    applyEffectiveConfigToToken,
    applyActorToAllTokens,

    // sockets
    emitSocketApplyActor,
    emitSocketApplyToken
  };

  Hooks.once("ready", () => {
    dbg("System ready -> installing socket + hooks");
    installSocketListener();
    installHooks();
  });

  dbg("Idle Animation LOGIC loaded (anti-spam mode).");
})();
