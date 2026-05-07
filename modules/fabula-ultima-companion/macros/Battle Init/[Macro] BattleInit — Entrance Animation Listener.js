// ============================================================================
// BattleInit — Entrance Animation Listener • Foundry VTT v12
// ----------------------------------------------------------------------------
// Install multi-client listener for Entrance Animation broadcasts.
// Channel: module.fabula-ultima-companion
//
// Supports phased entrance:
// - GM broadcasts: { type:"BI_ENTRANCE_START", phase:"party"|"enemy", data:{...} }
// - Clients play pseudo animation and send ACK:
//     { type:"BI_ENTRANCE_ACK", runId, phase, userId }
//
// Also supports camera lock during the cinematic:
// - GM broadcasts: { type:"BI_CAMERA_LOCK", runId }
// - GM broadcasts: { type:"BI_CAMERA_UNLOCK", runId }
//
// NOTE:
// - This listener does NOT update TokenDocuments (players can’t).
// - GM reveals real tokens after ACKs.
// ============================================================================

(() => {
  const DEBUG = true;

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;

  const BROADCAST_SCOPE = "world";
  const BROADCAST_KEY = "battleInit.entrance.broadcast";

  const tag = "[BattleInit:Entrance:Listener]";
  const log = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // -----------------------------
  // Party Dash SFX (played locally per client)
  // -----------------------------
  const PARTY_DASH_SFX_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/DashA.wav";

  function playPartyDashSfx(config = {}) {
    const src = String(config.partyDashSfxSrc ?? PARTY_DASH_SFX_SRC);
    const volume = Number(config.partyDashSfxVol ?? 0.85);

    if (!src) return;

    try {
      if (typeof AudioHelper?.play === "function") {
        AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
        if (DEBUG) log("Dash SFX played", { src, volume });
        return;
      }

      if (typeof game?.audio?.play === "function") {
        game.audio.play(src, { volume, loop: false });
        if (DEBUG) log("Dash SFX played (fallback)", { src, volume });
        return;
      }

      warn("Dash SFX: no audio API found on this client.");
    } catch (e) {
      warn("Dash SFX failed:", e);
    }
  }

  // -----------------------------
  // Enemy Roar SFX (species-based, one roar per enemy phase)
  // - We read enemy token actors -> system.props.species
  // - We random-pick one enemy from the group and play its mapped roar
  // -----------------------------
  const ROAR_BASE_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

  // Mapping matches your Legacy EncounterSpawner approach
  const ROAR_BY_SPECIES = {
    BEAST:     "Monster1.ogg",
    CONSTRUCT: "Gundam.mp3",
    DEMON:     "Spook.mp3",
    ELEMENTAL: "Pollen.ogg",
    HUMANOID:  "Unsheathe.wav",
    MONSTER:   "Monster5.ogg",
    PLANT:     "Monster3.ogg",
    UNDEAD:    "Monster2.ogg"
  };

  const ROAR_FALLBACK = "Monster4.ogg";

  function pickRoarFileForSpecies(speciesRaw) {
    const key = String(speciesRaw ?? "").trim().toUpperCase();
    return ROAR_BY_SPECIES[key] ?? ROAR_FALLBACK;
  }

  function pickOne(arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function playEnemyRoarSfxFromTokens(enemyTokens = [], config = {}) {
    const volume = Number(config.enemyRoarVol ?? 0.2);
    const baseUrl = String(config.enemyRoarBaseUrl ?? ROAR_BASE_URL);

    if (!enemyTokens.length) return;

    const candidates = enemyTokens.map(tok => {
      const actor = tok?.actor ?? tok?.document?.actor ?? null;
      const species =
        actor?.system?.props?.species ??
        actor?.system?.species ??
        null;

      const file = pickRoarFileForSpecies(species);
      return {
        tokenId: tok?.id ?? null,
        name: tok?.name ?? actor?.name ?? "Enemy",
        species: species ?? null,
        file
      };
    }).filter(c => !!c.file);

    const chosen = pickOne(candidates) ?? { file: ROAR_FALLBACK, name: "Enemy", species: null };
    const src = `${baseUrl}${chosen.file}`;

    try {
      if (typeof AudioHelper?.play === "function") {
        AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
        if (DEBUG) log("Roar SFX played", { src, volume, chosen });
        return;
      }

      if (typeof game?.audio?.play === "function") {
        game.audio.play(src, { volume, loop: false });
        if (DEBUG) log("Roar SFX played (fallback)", { src, volume, chosen });
        return;
      }

      warn("Roar SFX: no audio API found on this client.");
    } catch (e) {
      warn("Roar SFX failed:", e);
    }
  }

  // Prevent double-install
  if (globalThis.__BI_ENTRANCE_LISTENER_INSTALLED) {
    ui.notifications?.info?.("BattleInit: Entrance Animation Listener already installed.");
    log("Already installed.");
    return;
  }
  globalThis.__BI_ENTRANCE_LISTENER_INSTALLED = true;

  // Track (runId:phase) we already played on THIS client
  globalThis.__BI_ENTRANCE_PLAYED ??= new Set();

  // --------------------------------------------------------------------------
  // Sprite storage per runId so GM can keep them until tokens are revealed
  // --------------------------------------------------------------------------
  globalThis.__BI_ENTRANCE_SPRITES ??= { party: new Map(), enemy: new Map() };

  function storeSprites(role, runId, sprites) {
    const map = globalThis.__BI_ENTRANCE_SPRITES?.[role];
    if (!map) return;

    const old = map.get(runId);
    if (Array.isArray(old)) {
      for (const spr of old) {
        try { canvas.stage.removeChild(spr); } catch (_) {}
        try { spr.destroy(); } catch (_) {}
      }
    }

    map.set(runId, sprites);
  }

  function takeSprites(role, runId) {
    const map = globalThis.__BI_ENTRANCE_SPRITES?.[role];
    if (!map) return [];
    const arr = map.get(runId) ?? [];
    map.delete(runId);
    return Array.isArray(arr) ? arr : [];
  }

  // --------------------------------------------------------------------------
  // Camera Lock (blocks Foundry auto-pan during cinematic)
  // --------------------------------------------------------------------------
  globalThis.__BI_CAMERA_LOCK ??= {
    locked: false,
    prevAnimatePan: null,
    prevPan: null,
    lockRunId: null
  };

  function lockCameraPan(runId) {
    const st = globalThis.__BI_CAMERA_LOCK;

    if (st.locked) {
      log("Camera already locked", { runId, lockRunId: st.lockRunId });
      return;
    }

    st.locked = true;
    st.lockRunId = String(runId ?? "");

    // Save originals
    st.prevAnimatePan = canvas.animatePan?.bind(canvas) ?? null;
    st.prevPan = canvas.pan?.bind(canvas) ?? null;

    // Block animated pans
    canvas.animatePan = async function patchedAnimatePan(opts = {}) {
      if (DEBUG) log("CameraLock: blocked animatePan", { runId: st.lockRunId, opts });
      return;
    };

    // Block instant pans too (combat start sometimes uses this)
    canvas.pan = function patchedPan(opts = {}) {
      if (DEBUG) log("CameraLock: blocked pan", { runId: st.lockRunId, opts });
      return;
    };

    log("Camera locked ✅", { runId: st.lockRunId });
  }

  function unlockCameraPan(runId) {
    const st = globalThis.__BI_CAMERA_LOCK;

    if (!st.locked) {
      log("Camera already unlocked", { runId });
      return;
    }

    // Safety: only unlock if same runId (unless runId is omitted)
    if (st.lockRunId && runId && String(runId) !== String(st.lockRunId)) {
      log("CameraLock: ignore unlock from different runId", { runId, lockRunId: st.lockRunId });
      return;
    }

    if (st.prevAnimatePan) canvas.animatePan = st.prevAnimatePan;
    if (st.prevPan) canvas.pan = st.prevPan;

    log("Camera unlocked ✅", { runId: String(runId ?? "") });

    st.locked = false;
    st.prevAnimatePan = null;
    st.prevPan = null;
    st.lockRunId = null;
  }

  // Expose for GM Step (no-echo safe)
  globalThis.BI_CameraLock = lockCameraPan;
  globalThis.BI_CameraUnlock = unlockCameraPan;

  // --------------------------------------------------------------------------
  // Animation helpers
  // --------------------------------------------------------------------------
  function easeOutCubic(t) {
    const x = Math.max(0, Math.min(1, Number(t)));
    return 1 - Math.pow(1 - x, 3);
  }

  function animateTween(obj, toProps, durationMs, easeFn = easeOutCubic) {
    return new Promise(resolve => {
      const startTime = performance.now();
      const ticker = canvas.app.ticker;

      const update = () => {
        const now = performance.now();
        const elapsed = now - startTime;
        const t0 = Math.min(elapsed / durationMs, 1);
        const t = easeFn(t0);

        for (const [key, [from, to]] of Object.entries(toProps)) {
          obj[key] = from + (to - from) * t;
        }

        if (t0 >= 1) {
          ticker.remove(update);
          resolve();
        }
      };

      ticker.add(update);
    });
  }

  async function waitUntilTokensVisible(tokenIds, timeoutMs = 10_000, label = "") {
    const t0 = Date.now();

    function snap(id) {
      const tok = canvas.tokens?.get?.(id);
      if (!tok) return { id, ok: false, reason: "missing-token" };

      const docHidden = Boolean(tok.document?.hidden);
      const docAlpha  = Number(tok.document?.alpha ?? 1);
      const tokAlpha  = (typeof tok.alpha === "number") ? tok.alpha : 1;
      const meshAlpha = (tok.mesh && typeof tok.mesh.alpha === "number") ? tok.mesh.alpha : null;
      const iconAlpha = (tok.icon && typeof tok.icon.alpha === "number") ? tok.icon.alpha : null;
      const visible = Boolean(tok.visible);

      const ok = (!docHidden) && (docAlpha >= 0.99) && (tokAlpha >= 0.99) && visible
        && (meshAlpha == null || meshAlpha >= 0.99)
        && (iconAlpha == null || iconAlpha >= 0.99);

      return { id, ok, docHidden, docAlpha, tokAlpha, meshAlpha, iconAlpha, visible };
    }

    let lastLogAt = 0;

    while (true) {
      const states = tokenIds.map(snap);
      const allOk = states.every(s => s.ok);

      if (allOk) {
        if (DEBUG) log("waitUntilTokensVisible OK", { label, tokenIds });
        return true;
      }

      const now = Date.now();
      if (DEBUG && (now - lastLogAt) > 400) {
        lastLogAt = now;
        log("waitUntilTokensVisible pending", { label, states });
      }

      if ((now - t0) > timeoutMs) {
        warn("Timed out waiting tokens visible:", { label, states });
        return false;
      }

      await wait(50);
    }
  }

    function getTokenDisplaySizePx(token) {
    const gridSize = Number(canvas?.grid?.size ?? 100);

    // Prefer Token object pixel size if present (usually correct once drawn)
    const wTok = Number(token?.w);
    const hTok = Number(token?.h);
    if (Number.isFinite(wTok) && wTok > 0 && Number.isFinite(hTok) && hTok > 0) {
      return { w: wTok, h: hTok };
    }

    // Fallback: compute from TokenDocument grid units + token "Scale"
    const doc = token?.document;
    const docW = Number(doc?.width ?? 1);     // grid units
    const docH = Number(doc?.height ?? 1);    // grid units
    const docScale = Number(doc?.scale ?? 1); // Token configuration "Scale"

    return {
      w: docW * gridSize * docScale,
      h: docH * gridSize * docScale
    };
  }

  async function ensureVideoTexturePlaying(texture, { loop = true } = {}) {
  const bt = texture?.baseTexture;
  const res = bt?.resource;
  const src = res?.source;

  const isVideo =
    (typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement) ||
    (src && typeof src === "object" && String(src.tagName).toUpperCase?.() === "VIDEO");

  if (!isVideo) return;

  const vid = src;

  // Autoplay safety: most token WEBMs have no audio, but browsers can block autoplay if not muted.
  try {
    vid.muted = true;
    vid.loop = Boolean(loop);
    vid.playsInline = true;
  } catch (e) {
    // ignore
  }

  // Only kick it if it's paused (don’t constantly restart it)
  if (vid.paused) {
    try {
      await vid.play();
    } catch (e) {
      console.warn("[BattleInit:Entrance] Could not autoplay token WEBM video:", e);
    }
  }
}

 async function createSpriteFromToken(token) {
  const baseObj = token?.mesh ?? token?.icon ?? null;
  const texSrc = token?.document?.texture?.src ?? null;

  let texture = null;

  // Helper: try to read the URL behind an already-rendered PIXI.Texture
  function textureUrlFromPixiTexture(tex) {
    const res = tex?.baseTexture?.resource ?? null;
    if (!res) return null;

    if (typeof res.url === "string" && res.url) return res.url;

    const src = res.source ?? null;
    if (src && typeof src.currentSrc === "string" && src.currentSrc) return src.currentSrc;
    if (src && typeof src.src === "string" && src.src) return src.src;

    return null;
  }

  const desiredSrc = String(texSrc ?? "").trim();
  const baseTex = baseObj?.texture ?? null;
  const baseUrl = textureUrlFromPixiTexture(baseTex);

  // IMPORTANT:
  // - We prefer the already-rendered token texture (best chance to preserve WEBM animation)
  // - BUT if the token document was just updated (adopted party tokens), the rendered texture can lag behind.
  //   In that case, prefer loading from token.document.texture.src.
  const docDiffersFromRendered = Boolean(desiredSrc && baseUrl && String(baseUrl).trim() !== desiredSrc);

  if (baseTex && !docDiffersFromRendered) {
    texture = baseTex;
  } else if (desiredSrc) {
    texture = await loadTexture(desiredSrc);
  } else if (baseTex) {
    texture = baseTex;
  } else {
    texture = await loadTexture("icons/svg/mystery-man.svg");
  }

  // ✅ NEW: if this texture is a WEBM/video texture, force it to play (looping)
  await ensureVideoTexturePlaying(texture, { loop: true });


  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5);

  // Position at token center
  sprite.x = token.center.x;
  sprite.y = token.center.y;

  // ------------------------------------------------------------
  // Match the token’s *displayed* size including Texture Scale
  // ------------------------------------------------------------
  const docScaleX =
    Number(token?.document?.texture?.scaleX) ||
    Number(token?.document?.texture?.scale?.x) ||
    1;

  const docScaleY =
    Number(token?.document?.texture?.scaleY) ||
    Number(token?.document?.texture?.scale?.y) ||
    1;

  const sxAbs = Math.abs(Number.isFinite(docScaleX) ? docScaleX : 1) || 1;
  const syAbs = Math.abs(Number.isFinite(docScaleY) ? docScaleY : 1) || 1;

  const tokW = (typeof token?.w === "number") ? token.w : null;
  const tokH = (typeof token?.h === "number") ? token.h : null;

  const baseW = (baseObj && typeof baseObj.width === "number") ? baseObj.width : null;
  const baseH = (baseObj && typeof baseObj.height === "number") ? baseObj.height : null;

  let finalW = baseW ?? tokW ?? null;
  let finalH = baseH ?? tokH ?? null;

  if (tokW != null && tokH != null && baseW != null && baseH != null) {
    const tol = 0.5;

    const expectedScaledW = tokW * sxAbs;
    const expectedScaledH = tokH * syAbs;

    const baseLooksUnscaled =
      (Math.abs(baseW - tokW) < tol) &&
      (Math.abs(baseH - tokH) < tol);

    const baseLooksScaled =
      (Math.abs(baseW - expectedScaledW) < tol) &&
      (Math.abs(baseH - expectedScaledH) < tol);

    if (baseLooksUnscaled && !baseLooksScaled) {
      finalW = expectedScaledW;
      finalH = expectedScaledH;
    } else {
      finalW = baseW;
      finalH = baseH;
    }
  } else if (tokW != null && tokH != null) {
    finalW = tokW * sxAbs;
    finalH = tokH * syAbs;
  }

  if (finalW != null && finalH != null) {
    sprite.width = finalW;
    sprite.height = finalH;
  }

  sprite.zIndex = 5000;
  canvas.stage.sortableChildren = true;
  canvas.stage.addChild(sprite);
  canvas.stage.sortChildren();

  return sprite;
}

  // --------------------------------------------------------------------------
  // Facing helpers (Default vs Battle)
  // - default_facing_direction: how the sprite art is drawn (Left/Right)
  // - battle_facing_direction: how we want it to face in the battle scene (Left/Right)
  // Rule:
  //   If default != battle => flip horizontally (mirror)
  // --------------------------------------------------------------------------
  function normalizeFacingDir(v, fallback = "left") {
    const s = String(v ?? "").trim().toLowerCase();
    if (s.startsWith("r")) return "right";
    if (s.startsWith("l")) return "left";
    return String(fallback).trim().toLowerCase() === "right" ? "right" : "left";
  }

  function shouldFlipForBattleFromActor(actor) {
    const hasDefault = (actor?.system?.props?.default_facing_direction != null);
    const hasBattle  = (actor?.system?.props?.battle_facing_direction != null);

    // If neither field exists, caller should fall back to token document.
    if (!hasDefault && !hasBattle) return null;

    const def = normalizeFacingDir(actor?.system?.props?.default_facing_direction, "left");
    const bat = normalizeFacingDir(actor?.system?.props?.battle_facing_direction, def);
    return def !== bat;
  }

  function shouldFlipForBattleFromTokenDocument(token) {
    const sx =
      Number(token?.document?.texture?.scaleX) ||
      Number(token?.document?.texture?.scale?.x) ||
      1;
    return Number(sx) < 0;
  }

  function applyBattleFacingToSprite(sprite, token) {
    if (!sprite || !token) return;

    const actor = token?.actor ?? token?.document?.actor ?? null;

    // Prefer actor props (your new fields). If missing, fall back to whatever the token doc currently says.
    let flip = shouldFlipForBattleFromActor(actor);
    if (flip === null) flip = shouldFlipForBattleFromTokenDocument(token);

    const baseScaleX = Math.abs(sprite.scale.x || 1);
    sprite.scale.x = flip ? -baseScaleX : baseScaleX;
  }

  async function waitForTokensPresent(tokenIds, timeoutMs = 10_000) {
    const t0 = Date.now();
    while (true) {
      const missing = tokenIds.filter(id => !canvas.tokens?.get?.(id));
      if (!missing.length) return true;

      if ((Date.now() - t0) > timeoutMs) {
        warn("Timed out waiting for tokens:", missing);
        return false;
      }
      await wait(100);
    }
  }

  // --------------------------------------------------------------------------
  // Party / Enemy local runners (client + GM modes)
  // --------------------------------------------------------------------------
  async function runPartyLocal(data, opts = {}) {
    const {
      runId,
      battleSceneId,
      partyTokenIds = [],
      config = {}
    } = data ?? {};

    const mode = String(opts.mode ?? "client"); // "client" | "gm-playonly" | "gm-cleanup"
    if (!runId) return;

    log("PARTY start", { runId, mode, partyCount: partyTokenIds.length });

    // Ensure correct scene
    const t0 = Date.now();
    while (canvas.scene?.id !== battleSceneId) {
      if ((Date.now() - t0) > 15_000) {
        warn("Not on battle scene after 15s; skipping PARTY.", { battleSceneId, current: canvas.scene?.id });
        return;
      }
      await wait(200);
    }

    // Ensure canvas ready
    if (!canvas.ready) {
      const t1 = Date.now();
      while (!canvas.ready) {
        if ((Date.now() - t1) > 10_000) break;
        await wait(100);
      }
    }

    const PARTY_RUN_MS = Number(config.partyRunMs ?? 650);
    const PARTY_START_OFFSET_X = Number(config.partyStartOffsetX ?? 650);

    await waitForTokensPresent([...partyTokenIds], 12_000);

    const partyTokens = partyTokenIds.map(id => canvas.tokens.get(id)).filter(Boolean);
    const partySprites = [];

    if (mode === "gm-cleanup") {
      const ok = await waitUntilTokensVisible(partyTokenIds, 10_000, `party-cleanup:${runId}`);
      const stored = takeSprites("party", runId);

      log("PARTY cleanup", { runId, ok, storedCount: stored.length });

      for (const spr of stored) {
        try { canvas.stage.removeChild(spr); } catch (_) {}
        try { spr.destroy(); } catch (_) {}
      }
      return;
    }

    try {
      // Dash SFX when party begins their run-in
      if (partyTokens.length > 0) {
        playPartyDashSfx(config);
      }

      const partyMoves = [];

      for (const tok of partyTokens) {
        const spr = await createSpriteFromToken(tok);

        spr.x = tok.center.x + PARTY_START_OFFSET_X;
        spr.y = tok.center.y;
        spr.alpha = 1;

        // NEW: Face according to actor props (default_facing_direction vs battle_facing_direction)
        applyBattleFacingToSprite(spr, tok);

        partySprites.push(spr);

        partyMoves.push(
          animateTween(
            spr,
            { x: [spr.x, tok.center.x], y: [spr.y, tok.center.y] },
            PARTY_RUN_MS
          )
        );
      }

      await Promise.all(partyMoves);
      log("PARTY tween done", { runId, mode });

      sendAck(runId, "party");

      if (mode === "gm-playonly") {
        storeSprites("party", runId, partySprites);
        log("PARTY stored sprites for GM", { runId, count: partySprites.length });
        return;
      }

      const ok = await waitUntilTokensVisible(partyTokenIds, 10_000, `party:${runId}`);
      log("PARTY visible check", { runId, ok });

      for (const spr of partySprites) {
        try { canvas.stage.removeChild(spr); } catch (_) {}
        try { spr.destroy(); } catch (_) {}
      }
    } catch (e) {
      console.error(tag, "PARTY local error:", e);

      for (const spr of partySprites) {
        try { canvas.stage.removeChild(spr); } catch (_) {}
        try { spr.destroy(); } catch (_) {}
      }
    }
  }

  async function runEnemyLocal(data, opts = {}) {
    const {
      runId,
      battleSceneId,
      enemyTokenIds = [],
      config = {}
    } = data ?? {};

    const mode = String(opts.mode ?? "client"); // "client" | "gm-playonly" | "gm-cleanup"
    if (!runId) return;

    log("ENEMY start", { runId, mode, enemyCount: enemyTokenIds.length });

    const t0 = Date.now();
    while (canvas.scene?.id !== battleSceneId) {
      if ((Date.now() - t0) > 15_000) {
        warn("Not on battle scene after 15s; skipping ENEMY.", { battleSceneId, current: canvas.scene?.id });
        return;
      }
      await wait(200);
    }

    if (!canvas.ready) {
      const t1 = Date.now();
      while (!canvas.ready) {
        if ((Date.now() - t1) > 10_000) break;
        await wait(100);
      }
    }

    const ENEMY_FADE_MS = Number(config.enemyFadeMs ?? 550);

    await waitForTokensPresent([...enemyTokenIds], 12_000);

    const enemyTokens = enemyTokenIds.map(id => canvas.tokens.get(id)).filter(Boolean);
    const enemySprites = [];

    if (mode === "gm-cleanup") {
      const ok = await waitUntilTokensVisible(enemyTokenIds, 10_000, `enemy-cleanup:${runId}`);
      const stored = takeSprites("enemy", runId);

      log("ENEMY cleanup", { runId, ok, storedCount: stored.length });

      for (const spr of stored) {
        try { canvas.stage.removeChild(spr); } catch (_) {}
        try { spr.destroy(); } catch (_) {}
      }
      return;
    }

    // Roar SFX when enemies begin appearing (one roar, randomized from group)
    if (enemyTokens.length > 0) {
      playEnemyRoarSfxFromTokens(enemyTokens, config);
    }

    try {
      const enemyFades = [];

      for (const tok of enemyTokens) {
                const spr = await createSpriteFromToken(tok);
        spr.x = tok.center.x;
        spr.y = tok.center.y;
        spr.alpha = 0;

        // NEW: Face according to actor props (default_facing_direction vs battle_facing_direction)
        applyBattleFacingToSprite(spr, tok);

        enemySprites.push(spr);

        enemyFades.push(
          animateTween(
            spr,
            { alpha: [0, 1] },
            ENEMY_FADE_MS
          )
        );
      }

      await Promise.all(enemyFades);
      log("ENEMY tween done", { runId, mode });

      sendAck(runId, "enemy");

      if (mode === "gm-playonly") {
        storeSprites("enemy", runId, enemySprites);
        log("ENEMY stored sprites for GM", { runId, count: enemySprites.length });
        return;
      }

      const ok = await waitUntilTokensVisible(enemyTokenIds, 10_000, `enemy:${runId}`);
      log("ENEMY visible check", { runId, ok });

      for (const spr of enemySprites) {
        try { canvas.stage.removeChild(spr); } catch (_) {}
        try { spr.destroy(); } catch (_) {}
      }
    } catch (e) {
      console.error(tag, "ENEMY local error:", e);

      for (const spr of enemySprites) {
        try { canvas.stage.removeChild(spr); } catch (_) {}
        try { spr.destroy(); } catch (_) {}
      }
    }
  }

  // --------------------------------------------------------------------------
  // Exports for Step 5c (GM no-echo safe) + normal client play
  // --------------------------------------------------------------------------
  globalThis.BI_Entrance_playPartyLocal = (data) => runPartyLocal(data, { mode: "client" });
  globalThis.BI_Entrance_playEnemyLocal = (data) => runEnemyLocal(data, { mode: "client" });

  globalThis.BI_Entrance_GM_playParty    = (data) => runPartyLocal(data, { mode: "gm-playonly" });
  globalThis.BI_Entrance_GM_cleanupParty = (data) => runPartyLocal(data, { mode: "gm-cleanup" });

  globalThis.BI_Entrance_GM_playEnemy    = (data) => runEnemyLocal(data, { mode: "gm-playonly" });
  globalThis.BI_Entrance_GM_cleanupEnemy = (data) => runEnemyLocal(data, { mode: "gm-cleanup" });

  // --------------------------------------------------------------------------
  // ACK + message dispatcher
  // --------------------------------------------------------------------------
  function sendAck(runId, phase) {
    try {
      game.socket.emit(SOCKET_CHANNEL, {
        type: "BI_ENTRANCE_ACK",
        runId: String(runId),
        phase: String(phase ?? ""),
        userId: game.user?.id ?? null,
        at: Date.now()
      });
    } catch (e) {
      warn("Failed to send ACK:", e);
    }
  }

  async function handleStartMessage(msg) {
    const data = msg?.data ?? null;
    const runId = data?.runId;
    const phase = String(msg?.phase ?? "");

    if (!data || !runId) return;

    // Avoid double fire on same client
    const key = `${String(runId)}:${phase}`;
    if (globalThis.__BI_ENTRANCE_PLAYED.has(key)) {
      log("Skipping already-played", { key });
      return;
    }
    globalThis.__BI_ENTRANCE_PLAYED.add(key);

    const expiresAtMs = Number(data?.expiresAtMs ?? 0);
    if (expiresAtMs && Date.now() > expiresAtMs) {
      log("Ignoring expired entrance broadcast:", { runId, expiresAtMs });
      return;
    }

    if (phase === "party") {
      await runPartyLocal(data, { mode: "client" });
      return;
    }

    if (phase === "enemy") {
      await runEnemyLocal(data, { mode: "client" });
      return;
    }

    warn("Unknown entrance phase:", phase);
  }

  // Socket listener
  game.socket.on(SOCKET_CHANNEL, (msg) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "BI_CAMERA_LOCK") {
      log("Received CAMERA LOCK:", msg);
      lockCameraPan(msg.runId);
      return;
    }

    if (msg.type === "BI_CAMERA_UNLOCK") {
      log("Received CAMERA UNLOCK:", msg);
      unlockCameraPan(msg.runId);
      return;
    }

    if (msg.type === "BI_ENTRANCE_START") {
      log("Received START:", msg);
      handleStartMessage(msg);
      return;
    }
  });

  // Catch-up on canvas ready (log only)
  Hooks.on("canvasReady", async () => {
    try {
      const b = canvas.scene?.getFlag?.(BROADCAST_SCOPE, BROADCAST_KEY);
      if (!b || !b.runId) return;

      const expiresAtMs = Number(b?.expiresAtMs ?? 0);
      if (expiresAtMs && Date.now() > expiresAtMs) return;

      log("catchUp(canvasReady) broadcast found (no auto-replay):", b);
    } catch (e) {
      console.error(tag, "catchUp failed:", e);
    }
  });

  ui.notifications?.info?.("BattleInit: Entrance Animation Listener installed ✅");
  log("Installed on channel:", SOCKET_CHANNEL);
})();
