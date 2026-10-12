/**
 * footstep-runtime.js
 * Fabula Ultima Companion - Footstep sounds
 * Foundry VTT v12
 *
 * Purpose:
 * - Play footsteps for the party token while it is actually moving
 * - Pick the sound from the surface Region under the token
 *
 * How it works:
 * - Every client watches the party token's drawn position each frame and
 *   plays a step locally each time it has travelled one stride. Nothing is
 *   sent over the network: every client already sees the same walk.
 * - A Region carries its surface in flags.fabula-ultima-companion.footstepSurface
 *   (ground | grass | wood | water). footstepMuted keeps a region silent.
 * - A scene with no surface Region makes no footsteps.
 *
 * Replaces the per-surface Footstep macros that Regions used to run on every
 * move. Those played two steps per move however long the move was, so a
 * slide, a short hop and a burst of clicks all sounded wrong.
 *
 * Globals:
 *   globalThis.__ONI_FOOTSTEP_RUNTIME__
 *
 * API:
 *   FUCompanion.api.footsteps
 */

(() => {
  const GLOBAL_KEY = "__ONI_FOOTSTEP_RUNTIME__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SURFACE_FLAG = "footstepSurface";
  const MUTED_FLAG = "footstepMuted";

  const ENABLED = true;

  const SOUND_ROOT = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/";

  // Where surface Regions overlap, the highest priority is the one heard.
  const SURFACES = Object.freeze({
    ground: { label: "Ground", priority: 1, files: ["SE_BTL_FootStepNormal_1.ogg", "SE_BTL_FootStepNormal_2.ogg"] },
    grass:  { label: "Grass",  priority: 2, files: ["SE_BTL_FootStepGrass_1.ogg", "SE_BTL_FootStepGrass_2.ogg"] },
    wood:   { label: "Wood",   priority: 3, files: ["SE_BTL_FootStepWood_1.ogg", "SE_BTL_FootStepWood_2.ogg"] },
    water:  { label: "Water",  priority: 4, files: ["SE_BTL_FootStepWater_1.ogg", "SE_BTL_FootStepWater_2.ogg"] }
  });

  // One step per stride of drawn travel. At the exploration walk speed of
  // 3 grid squares a second, 0.9 of a square is a step about every 300 ms.
  const STRIDE_GRIDS = 0.9;

  // Steps are never closer together than this, however fast the token is
  // dragged or however quickly walks are restarted.
  const MIN_STEP_GAP_MS = 220;

  // Standing still this long ends a walk; the next movement opens with a step.
  const IDLE_RESET_MS = 180;

  // A single-frame move longer than this many grid squares is a jump, not a walk.
  const JUMP_GRIDS = 2;

  const VOLUME = 0.6;
  const VOLUME_VARIATION = 0.12;
  const PITCH_VARIATION = 0.06;

  const state = {
    installed: true,
    enabled: ENABLED,

    partyActorId: null,
    tokenId: null,

    lastX: null,
    lastY: null,
    travelled: 0,
    lastMoveAt: 0,
    lastStepAt: 0,
    walking: false,
    skipNextMove: false,

    nextFile: 0,
    stepsPlayed: 0,
    lastSurface: null,

    tickerFn: null
  };

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function normalizeSurface(value) {
    const key = cleanString(value).toLowerCase();
    return Object.prototype.hasOwnProperty.call(SURFACES, key) ? key : null;
  }

  async function refreshPartyActor() {
    try {
      const res = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
      state.partyActorId = res?.db?.id ?? null;
    } catch {
      state.partyActorId = null;
    }
    state.tokenId = null;
  }

  function findPartyToken() {
    if (!canvas?.ready) return null;

    const cached = state.tokenId ? canvas.tokens?.get(state.tokenId) : null;
    if (cached) return cached;

    const tokens = canvas.tokens?.placeables ?? [];
    const token =
      (state.partyActorId ? tokens.find(t => t.document?.actorId === state.partyActorId) : null)
      ?? tokens.find(t => t.actor?.system?.props?.isParty_boolean === true)
      ?? null;

    state.tokenId = token?.id ?? null;
    return token;
  }

  // The surface under a point: the highest-priority unmuted surface Region
  // that contains it, or null.
  function resolveSurfaceAt(point, elevation = 0) {
    let best = null;

    for (const region of canvas?.regions?.placeables ?? []) {
      const doc = region.document;
      const surface = normalizeSurface(doc?.getFlag?.(MODULE_ID, SURFACE_FLAG));
      if (!surface) continue;
      if (doc.getFlag(MODULE_ID, MUTED_FLAG)) continue;

      let inside = false;
      try {
        inside = region.testPoint(point, elevation);
      } catch {
        inside = false;
      }
      if (!inside) continue;

      if (!best || SURFACES[surface].priority > SURFACES[best].priority) best = surface;
    }

    return best;
  }

  function isSuppressed() {
    try {
      return !!globalThis.FUCompanion?.api?.vfxSuppressed?.();
    } catch {
      return false;
    }
  }

  function playStep(surface) {
    const def = SURFACES[surface];
    if (!def) return;

    const file = def.files[state.nextFile % def.files.length];
    state.nextFile++;

    const volume = Math.max(0, VOLUME * (1 + ((Math.random() * 2) - 1) * VOLUME_VARIATION));
    const rate = 1 + ((Math.random() * 2) - 1) * PITCH_VARIATION;

    try {
      const playing = foundry.audio.AudioHelper.play(
        { src: SOUND_ROOT + file, volume, loop: false, channel: "interface" },
        false
      );

      Promise.resolve(playing).then((sound) => {
        const param = sound?.sourceNode?.playbackRate;
        if (param && typeof param.value === "number") param.value = rate;
      }).catch(() => {});
    } catch (err) {
      console.warn("[Footsteps] Failed to play a footstep", err);
    }

    state.stepsPlayed++;
    state.lastSurface = surface;
  }

  function step(token, now) {
    if ((now - state.lastStepAt) < MIN_STEP_GAP_MS) return false;

    state.lastStepAt = now;
    state.travelled = 0;

    if (isSuppressed()) return true;
    if (token.document?.hidden || token.visible === false) return true;

    const surface = resolveSurfaceAt(
      { x: token.x + (token.w / 2), y: token.y + (token.h / 2) },
      token.document?.elevation ?? 0
    );
    if (surface) playStep(surface);

    return true;
  }

  function tick() {
    if (!state.enabled || !canvas?.ready) return;

    const token = findPartyToken();
    if (!token) {
      state.lastX = null;
      state.lastY = null;
      state.walking = false;
      return;
    }

    // token.x/y is the drawn position; the document can read the destination
    // for an instant while Foundry prepares a move.
    const x = token.x;
    const y = token.y;
    const now = performance.now();

    if (state.lastX === null || state.skipNextMove) {
      state.lastX = x;
      state.lastY = y;
      state.skipNextMove = false;
      return;
    }

    const moved = Math.hypot(x - state.lastX, y - state.lastY);
    state.lastX = x;
    state.lastY = y;

    if (moved < 0.01) {
      if (state.walking && (now - state.lastMoveAt) > IDLE_RESET_MS) {
        state.walking = false;
        state.travelled = 0;
      }
      return;
    }

    const grid = canvas.dimensions?.size || 100;
    if (moved > (grid * JUMP_GRIDS)) {
      state.walking = false;
      state.travelled = 0;
      return;
    }

    state.lastMoveAt = now;

    if (!state.walking) {
      state.walking = true;
      state.travelled = 0;
      step(token, now);
      return;
    }

    state.travelled += moved;
    if (state.travelled >= (grid * STRIDE_GRIDS)) step(token, now);
  }

  function attachTicker() {
    if (state.tickerFn || !canvas?.app?.ticker) return;
    state.tickerFn = tick;
    canvas.app.ticker.add(state.tickerFn, undefined, PIXI.UPDATE_PRIORITY.LOW);
  }

  function detachTicker() {
    if (state.tickerFn && canvas?.app?.ticker) canvas.app.ticker.remove(state.tickerFn);
    state.tickerFn = null;
  }

  function resetTracking() {
    state.tokenId = null;
    state.lastX = null;
    state.lastY = null;
    state.travelled = 0;
    state.walking = false;
  }

  function preloadSceneSounds() {
    const used = new Set();
    for (const region of canvas?.scene?.regions ?? []) {
      const surface = normalizeSurface(region.getFlag(MODULE_ID, SURFACE_FLAG));
      if (surface) used.add(surface);
    }

    for (const surface of used) {
      for (const file of SURFACES[surface].files) {
        try {
          game.audio?.preload?.(SOUND_ROOT + file);
        } catch (_) {}
      }
    }
  }

  // ------------------------------------------------------------
  // Region config: a Surface picker, so a new map needs no macro wiring
  // ------------------------------------------------------------
  function injectRegionConfig(app, html) {
    try {
      const doc = app?.document;
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!doc || !root) return;
      if (root.querySelector(".oni-footstep-surface")) return;

      const host =
        root.querySelector('section[data-tab="identity"]')
        ?? root.querySelector("form")
        ?? root;

      const current = normalizeSurface(doc.getFlag(MODULE_ID, SURFACE_FLAG)) ?? "";
      const muted = !!doc.getFlag(MODULE_ID, MUTED_FLAG);

      const options = [`<option value="" ${current ? "" : "selected"}>None</option>`]
        .concat(Object.entries(SURFACES).map(([key, def]) =>
          `<option value="${key}" ${current === key ? "selected" : ""}>${def.label}</option>`
        ))
        .join("");

      const wrap = document.createElement("fieldset");
      wrap.className = "oni-footstep-surface";
      wrap.innerHTML = `
        <legend>Footsteps</legend>
        <div class="form-group">
          <label>Surface</label>
          <div class="form-fields">
            <select name="flags.${MODULE_ID}.${SURFACE_FLAG}">${options}</select>
          </div>
          <p class="hint">The footstep sound the party makes inside this Region.</p>
        </div>
        <div class="form-group">
          <label>Muted</label>
          <div class="form-fields">
            <input type="checkbox" name="flags.${MODULE_ID}.${MUTED_FLAG}" ${muted ? "checked" : ""}>
          </div>
        </div>
      `;

      host.appendChild(wrap);
    } catch (err) {
      console.warn("[Footsteps] Failed to add the Surface picker to the Region config", err);
    }
  }

  const api = {
    installed: true,
    state,
    SURFACES,
    SURFACE_FLAG,
    MUTED_FLAG,

    resolveSurfaceAt,
    setEnabled(value) {
      state.enabled = !!value;
      resetTracking();
    }
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.on("renderRegionConfig", injectRegionConfig);

  Hooks.on("canvasReady", async () => {
    resetTracking();
    await refreshPartyActor();
    attachTicker();
    preloadSceneSounds();
  });

  Hooks.on("canvasTearDown", () => {
    detachTicker();
    resetTracking();
  });

  Hooks.on("createToken", () => { state.tokenId = null; });
  Hooks.on("deleteToken", () => { state.tokenId = null; });

  // A move applied without animation (door warp, teleport, GM placement) puts
  // the token somewhere new in one frame; it is not a walk.
  Hooks.on("updateToken", (doc, change, options) => {
    if (doc.id !== state.tokenId) return;
    if (!("x" in change) && !("y" in change)) return;
    if (options?.animate === false || options?.teleport === true) {
      state.skipNextMove = true;
      state.walking = false;
      state.travelled = 0;
    }
  });

  Hooks.once("ready", async () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.footsteps = api;
    } catch (err) {
      console.warn("[Footsteps] Failed to attach API to FUCompanion.api", err);
    }

    if (canvas?.ready) {
      await refreshPartyActor();
      attachTicker();
      preloadSceneSounds();
    }
  });
})();
