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
 * - Camp scenes: every party member walks. A player hears their own member
 *   at full volume and the others softer (client setting footstepsOthers:
 *   Normal / Quiet / Off), faded by distance and capped to one step per
 *   150 ms, nearest first. The GM and a spectator hear everyone as "others".
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
  // dragged or however quickly walks are restarted. Below the keyboard run's
  // stride (0.9 square at 4.8 squares a second, about 187 ms), so a run is
  // heard at its own pace.
  const MIN_STEP_GAP_MS = 170;

  // Standing still this long ends a walk; the next movement opens with a step.
  const IDLE_RESET_MS = 180;

  // A single-frame move longer than this many grid squares is a jump, not a walk.
  const JUMP_GRIDS = 2;

  const VOLUME = 0.6;
  const VOLUME_VARIATION = 0.12;
  const PITCH_VARIATION = 0.06;

  // Camp scenes: every party member walks at once. As in an MMO, a player
  // hears their own steps as on a walk map and everyone else's much softer,
  // fading with distance, and never more than one of theirs per OTHERS_GAP_MS
  // (the nearest wins), so four people walking is a light shuffle, not a drum
  // line. Each player picks how loud the others are (client setting).
  const OTHERS_SETTING = "footstepsOthers";
  const OTHERS_LEVELS = Object.freeze({ normal: 0.5, quiet: 0.25, off: 0 });
  const OTHERS_DEFAULT = "quiet";
  const OTHERS_GAP_MS = 150;
  // Others at most this far (grid squares) are heard at their full level;
  // beyond, they fade linearly down to OTHERS_FAR_GAIN at OTHERS_FAR_GRIDS.
  const OTHERS_NEAR_GRIDS = 2;
  const OTHERS_FAR_GRIDS = 10;
  const OTHERS_FAR_GAIN = 0.3;

  const state = {
    installed: true,
    enabled: ENABLED,

    partyActorId: null,
    tokenId: null,          // the party token (walk maps)
    camp: false,            // a camp scene: every party member is a walker
    campWalkerIds: null,    // worked out again when tokens come or go

    // tokenId -> the stride of one walking token (see newWalker)
    walkers: new Map(),
    lastOtherStepAt: 0,

    stepsPlayed: 0,
    stepsCapped: 0,         // others' steps left silent by the cap
    lastSurface: null,

    tickerFn: null
  };

  function newWalker() {
    return {
      lastX: null,
      lastY: null,
      travelled: 0,
      lastMoveAt: 0,
      lastStepAt: 0,
      walking: false,
      skipNextMove: false,
      nextFile: 0
    };
  }

  function walkerFor(tokenId) {
    let w = state.walkers.get(tokenId);
    if (!w) {
      w = newWalker();
      state.walkers.set(tokenId, w);
    }
    return w;
  }

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

  function walkRuntime() {
    return globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
  }

  function sceneIsCamp(scene) {
    return scene?.flags?.[MODULE_ID]?.oniFabula?.general?.sceneMode === "camp";
  }

  // Every token whose steps are heard: the party token on a walk map, each
  // party member in a camp.
  function walkerTokens() {
    if (!state.camp) {
      const party = findPartyToken();
      return party ? [party] : [];
    }
    if (!state.campWalkerIds) {
      const isMember = walkRuntime()?.isCampMemberToken
        ?? ((t) => !!t.document?.getFlag?.(MODULE_ID, "campMember"));
      state.campWalkerIds = (canvas.tokens?.placeables ?? []).filter(t => isMember(t)).map(t => t.id);
    }
    const out = [];
    for (const id of state.campWalkerIds) {
      const token = canvas.tokens?.get(id);
      if (token) out.push(token);
    }
    return out;
  }

  // The token this client walks, in a camp (null for the GM or a spectator).
  // On a walk map the party token belongs to everyone.
  function ownTokenId() {
    if (!state.camp) return state.tokenId;
    const rt = walkRuntime();
    return rt?.isCampWalk?.() ? (rt.getFollowToken?.()?.id ?? null) : null;
  }

  function othersLevel() {
    let key = OTHERS_DEFAULT;
    try { key = game.settings.get(MODULE_ID, OTHERS_SETTING) ?? OTHERS_DEFAULT; } catch (_) {}
    return OTHERS_LEVELS[key] ?? OTHERS_LEVELS[OTHERS_DEFAULT];
  }

  function centreOf(token) {
    return { x: token.x + (token.w / 2), y: token.y + (token.h / 2) };
  }

  // How loud another member's step is: the player's level, faded by the
  // distance to the player's own member (no fade without one).
  function othersGain(token, listener) {
    const level = othersLevel();
    if (!level || !listener) return level;
    const grid = canvas.dimensions?.size || 100;
    const a = centreOf(token);
    const b = centreOf(listener);
    const d = Math.hypot(a.x - b.x, a.y - b.y) / grid;
    if (d <= OTHERS_NEAR_GRIDS) return level;
    const t = Math.min(1, (d - OTHERS_NEAR_GRIDS) / (OTHERS_FAR_GRIDS - OTHERS_NEAR_GRIDS));
    return level * (1 - (t * (1 - OTHERS_FAR_GAIN)));
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

  function playStep(surface, w, gain = 1) {
    const def = SURFACES[surface];
    if (!def) return;

    const file = def.files[w.nextFile % def.files.length];
    w.nextFile++;

    const volume = Math.max(0, gain * VOLUME * (1 + ((Math.random() * 2) - 1) * VOLUME_VARIATION));
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

  // A step is due: start the next stride. False when too soon after the last.
  function step(w, now) {
    if ((now - w.lastStepAt) < MIN_STEP_GAP_MS) return false;

    w.lastStepAt = now;
    w.travelled = 0;
    return true;
  }

  function sound(token, w, gain) {
    if (gain <= 0) return;
    if (isSuppressed()) return;
    if (token.document?.hidden || token.visible === false) return;

    const surface = resolveSurfaceAt(centreOf(token), token.document?.elevation ?? 0);
    if (surface) playStep(surface, w, gain);
  }

  // Follow one walker's drawn travel this frame. True when it takes a step.
  function trackStride(token, now) {
    const w = walkerFor(token.id);

    // token.x/y is the drawn position; the document can read the destination
    // for an instant while Foundry prepares a move.
    const x = token.x;
    const y = token.y;

    if (w.lastX === null || w.skipNextMove) {
      w.lastX = x;
      w.lastY = y;
      w.skipNextMove = false;
      return false;
    }

    const moved = Math.hypot(x - w.lastX, y - w.lastY);
    w.lastX = x;
    w.lastY = y;

    if (moved < 0.01) {
      if (w.walking && (now - w.lastMoveAt) > IDLE_RESET_MS) {
        w.walking = false;
        w.travelled = 0;
      }
      return false;
    }

    const grid = canvas.dimensions?.size || 100;
    if (moved > (grid * JUMP_GRIDS)) {
      w.walking = false;
      w.travelled = 0;
      return false;
    }

    w.lastMoveAt = now;

    if (!w.walking) {
      w.walking = true;
      w.travelled = 0;
      return step(w, now);
    }

    w.travelled += moved;
    return w.travelled >= (grid * STRIDE_GRIDS) && step(w, now);
  }

  function tick() {
    if (!state.enabled || !canvas?.ready) return;

    const now = performance.now();
    const walkers = walkerTokens();

    // A walker that left: forget its stride.
    if (state.walkers.size > walkers.length) {
      const live = new Set(walkers.map(t => t.id));
      for (const id of [...state.walkers.keys()]) if (!live.has(id)) state.walkers.delete(id);
    }

    const own = ownTokenId();
    const others = [];
    for (const token of walkers) {
      if (!trackStride(token, now)) continue;
      if (!state.camp || token.id === own) sound(token, walkerFor(token.id), 1);
      else others.push(token);
    }
    if (!others.length) return;

    // Others' steps: the nearest one, and only one per OTHERS_GAP_MS.
    if ((now - state.lastOtherStepAt) < OTHERS_GAP_MS || !othersLevel()) {
      state.stepsCapped += others.length;
      return;
    }
    const listener = own ? canvas.tokens?.get(own) : null;
    if (listener && others.length > 1) {
      const here = centreOf(listener);
      const dist = (t) => { const c = centreOf(t); return Math.hypot(c.x - here.x, c.y - here.y); };
      others.sort((a, b) => dist(a) - dist(b));
    }
    state.lastOtherStepAt = now;
    state.stepsCapped += others.length - 1;
    sound(others[0], walkerFor(others[0].id), othersGain(others[0], listener));
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
    state.campWalkerIds = null;
    state.camp = sceneIsCamp(canvas?.scene);
    state.walkers.clear();
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

  Hooks.on("createToken", () => { state.tokenId = null; state.campWalkerIds = null; });
  Hooks.on("deleteToken", () => { state.tokenId = null; state.campWalkerIds = null; });

  Hooks.on("updateScene", (scene) => {
    if (!canvas?.scene || scene.id !== canvas.scene.id) return;
    if (sceneIsCamp(scene) !== state.camp) resetTracking();
  });

  // A move applied without animation (door warp, teleport, GM placement) puts
  // the token somewhere new in one frame; it is not a walk.
  Hooks.on("updateToken", (doc, change, options) => {
    const w = state.walkers.get(doc.id);
    if (!w) return;
    if (!("x" in change) && !("y" in change)) return;
    if (options?.animate === false || options?.teleport === true) {
      w.skipNextMove = true;
      w.walking = false;
      w.travelled = 0;
    }
  });

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, OTHERS_SETTING, {
      name: "Other party members' footsteps",
      hint: "In camp, everyone walks at once. How loud the other members' steps are, against your own.",
      scope: "client",
      config: true,
      type: String,
      choices: { normal: "Normal", quiet: "Quiet", off: "Off" },
      default: OTHERS_DEFAULT
    });
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
      resetTracking();
      await refreshPartyActor();
      attachTicker();
      preloadSceneSounds();
    }
  });
})();
