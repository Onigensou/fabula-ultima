// ─────────────────────────────────────────────────────────────
//  FU Portrait Cut-In • Receiver + Cache + Combat Hooks (V12)
//  • Cache at combat start  → textures + audio buffers
//  • Strict cache-only playback at showtime (no URL fetches)
//  • Forget per-combat cache entries on combat end
//  • Public API: window.FUCompanion.cutin.{preload,play,cacheInfo}
// ─────────────────────────────────────────────────────────────
(() => {
  const MODULE_ID  = "fabula-ultima-companion";
  const ACTION_KEY = "FU_CUTIN_PLAY";
  const ACTION_PRELOAD = "FU_CUTIN_PRELOAD";
  const FLAG       = "__FU_CUTIN_READY_v4";
  const TAG_ID     = "fu-portrait-cutin-layer";
  const NS         = "FUCompanion";

  // ---- SFX sources used for preloading (only at preload time, never at showtime)
  // You may change these URLs; they are fetched only during combatStart preloading.
  const SFX_URLS = {
    critical:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BurstMax.ogg",
    zero_power: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/ChargeAttack.ogg",
    fumble:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Down2.ogg"
  };

  // ------------------------------ Tiny cache (per-tab, in-memory) ------------------------------
  const CACHE_NS = "FU_ASSET_CACHE";
  function cacheBag() {
    globalThis[CACHE_NS] ??= {
      __createdAt: Date.now(),
      __audioCtx: null,               // single AudioContext
      __combatKeySet: new Map(),      // combatId -> Set(cacheKeys) for cleanup
      get size() { return Object.keys(this).filter(k => !k.startsWith("__")).length; }
    };
    return globalThis[CACHE_NS];
  }
  function audioCtx() {
    const bag = cacheBag();
    bag.__audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    return bag.__audioCtx;
  }
  function setCombatKey(combatId, key) {
    const bag = cacheBag();
    if (!bag.__combatKeySet.has(combatId)) bag.__combatKeySet.set(combatId, new Set());
    bag.__combatKeySet.get(combatId).add(key);
  }
  function forgetCombat(combatId) {
    const bag = cacheBag();
    const set = bag.__combatKeySet.get(combatId);
    if (!set) return;
    for (const key of set) {
      const entry = bag[key];
      if (entry?.texture && !entry.texture.destroyed) {
        entry.texture.destroy(false);
      }
      delete bag[key];
    }
    bag.__combatKeySet.delete(combatId);
  }

  // Accessors
  const cacheHas   = (key) => !!cacheBag()[key];
  const cacheGetTx = (key) => cacheBag()[key]?.texture ?? null;
  const cacheGetAB = (key) => cacheBag()[key]?.buffer  ?? null;

  // Preload helpers (URLs are used here only; showtime never touches URLs)
  async function preloadTexture(key, url) {
    const bag = cacheBag();
    if (bag[key]?.texture && !bag[key].texture.destroyed) return bag[key].texture;
    const fn = foundry?.utils?.preloadTexture ?? globalThis.loadTexture;
    if (typeof fn !== "function") throw new Error("No texture loader available.");
    const texture = await fn(url);
    bag[key] = { ...(bag[key]||{}), texture, url, cachedAt: Date.now() };
    return texture;
  }
  async function preloadAudio(key, url) {
    const bag = cacheBag();
    if (bag[key]?.buffer) return bag[key].buffer;
    const ctx = audioCtx();
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
    const resp = await fetch(url, { cache: "force-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const arr  = await resp.arrayBuffer();
    const buff = await ctx.decodeAudioData(arr.slice(0));
    bag[key] = { ...(bag[key]||{}), buffer: buff, url, cachedAt: Date.now() };
    return buff;
  }

  // ------------------------------ PIXI renderer (reuses cached texture) ------------------------------
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInCubic  = t => t * t * t;
  const easeOutQuad  = t => 1 - (1 - t) * (1 - t);
  const easeInQuad   = t => t * t;
  const sleep        = (ms) => new Promise(r => setTimeout(r, ms));

  let __installed = false, __layer=null, __dim=null, __flash=null, __portrait=null;
  function ensureLayer() {
    if (!canvas?.ready) throw new Error("Canvas not ready.");
    if (__installed && __layer?.parent) return;

    const layer = new PIXI.Container();
    layer.name = TAG_ID; layer.zIndex = 999999; layer.sortableChildren = true; layer.visible = false; layer.interactiveChildren = false;

    const dim   = new PIXI.Graphics();
    const flash = new PIXI.Graphics();
    const port  = new PIXI.Sprite(PIXI.Texture.EMPTY);
    port.anchor.set(0.0, 1.0); port.zIndex = 2; port.alpha = 0.999;

    layer.addChild(dim, flash, port);
    canvas.stage.sortableChildren = true;
    canvas.stage.addChild(layer);

    const resize = () => {
      const { width: W, height: H } = canvas.app.renderer.screen;
      dim.clear().beginFill(0x000000, 1).drawRect(0,0,W,H).endFill();
      flash.clear().beginFill(0xFFFFFF, 1).drawRect(0,0,W,H).endFill();
      flash.alpha = 0;
    };
    Hooks.on("canvasPan", resize);
    Hooks.on("resize", resize);
    resize();

    __layer = layer; __dim = dim; __flash = flash; __portrait = port; __installed = true;
  }

  async function playCutInFromCache(payload) {
    // Payload must contain imgKey (maybe null) + sfxKey (maybe null) and timing/visual numbers
    const {
      t0 = Date.now(),
      imgKey = null,
      sfxKey = null,
      dimAlpha = 0.6, dimFadeMs = 200,
      flashPeak = 0.9, flashInMs = 70, flashOutMs = 180, flashDelayMs = 60,
      slideInMs = 650, holdMs = 900, slideOutMs = 650,
      portraitHeightRatio = 0.9, portraitBottomMargin = 40, portraitInsetX = 220,
      // NEW: portrait offset (Y only). Positive moves UP, negative moves DOWN.
      portraitOffsetY = 0,
      sfxVol = 0.9
    } = payload || {};

    // Strict policy: if cache says this actor/type was a MISS, or if imgKey not found, skip quietly.
    if (!imgKey || !cacheHas(imgKey) || !cacheGetTx(imgKey)) {
      console.warn("[FU Cut-In] Cache miss for", imgKey, "—skipping render (per strict cache-only policy).");
      return;
    }

    // Wait for the shared t0
    const wait = Math.max(0, t0 - Date.now());
    if (wait) await sleep(wait);

    ensureLayer();
    const tex = cacheGetTx(imgKey);
    if (!tex || tex.destroyed) {
      console.warn("[FU Cut-In] Texture destroyed/missing at showtime:", imgKey);
      return;
    }

    // Prepare portrait
    const p = __portrait;
    p.texture = tex;
    const { width: W, height: H } = canvas.app.renderer.screen;
    const scale = (H * portraitHeightRatio) / (p.texture.height || p.texture.baseTexture?.realHeight || 512);
    p.scale.set(scale, scale);
    const finalX = portraitInsetX;

    // NEW: apply portraitOffsetY (positive => up)
    const offY = Number.isFinite(Number(portraitOffsetY)) ? Number(portraitOffsetY) : 0;
    const finalY = (H - portraitBottomMargin) - offY;

    p.x = -p.width - 80; p.y = finalY; p.alpha = 1;

    __layer.visible = true;

    // Dim
    await tween(__dim, "alpha", 0, dimAlpha, dimFadeMs, easeOutQuad);

    // Flash
    await sleep(flashDelayMs);
    await tween(__flash, "alpha", 0, flashPeak, flashInMs, easeOutQuad);
    const flashFade = tween(__flash, "alpha", __flash.alpha, 0, flashOutMs, easeInQuad);

    // SFX strictly from cached buffer
    if (sfxKey) {
      const buff = cacheGetAB(sfxKey);
      if (buff) {
        try {
          const ctx = audioCtx();
          if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
          const source = ctx.createBufferSource();
          const gain   = ctx.createGain();
          gain.gain.value = sfxVol;
          source.buffer = buff;
          source.connect(gain).connect(ctx.destination);
          source.start(0);
        } catch (e) {
          console.warn("[FU Cut-In] SFX play failed (buffer path):", e);
        }
      }
    }

    // Slide-in, hold, slide-out
    await tweenXY(p, p.x, finalX, p.y, finalY, slideInMs, easeOutCubic);
    await flashFade;
    await sleep(holdMs);

    const exitX = W + 40;
    await Promise.all([
      tween(__dim, "alpha", __dim.alpha, 0, 180, easeInQuad),
      tweenCombo([
        { obj: p,        prop: "x",     from: p.x, to: exitX, ms: slideOutMs, ease: easeInCubic },
        { obj: p,        prop: "alpha", from: 1,   to: 0,     ms: slideOutMs, ease: easeInQuad }
      ])
    ]);

    __layer.visible = false;
  }

  // Tween helpers (keep them local)
  function tween(obj, prop, from, to, ms, ease=easeOutQuad){
    return new Promise(resolve => {
      const start = performance.now(); obj[prop] = from;
      const step  = (now) => {
        const t = Math.min(1, (now - start) / ms);
        obj[prop] = from + (to - from) * ease(t);
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  function tweenXY(obj, xFrom, xTo, yFrom, yTo, ms, ease=easeOutQuad){
    return new Promise(resolve => {
      const start = performance.now(); obj.x = xFrom; obj.y = yFrom;
      const step  = (now) => {
        const t = Math.min(1, (now - start) / ms); const k = ease(t);
        obj.x = xFrom + (xTo - xFrom) * k; obj.y = yFrom + (yTo - yFrom) * k;
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  function tweenCombo(items){
    return new Promise(resolve => {
      const start = performance.now();
      for (const it of items) it.obj[it.prop] = it.from;
      const step  = (now) => {
        let done = true;
        for (const it of items) {
          const t = Math.min(1, (now - start) / it.ms);
          const k = (it.ease || easeOutQuad)(t);
          it.obj[it.prop] = it.from + (it.to - it.from) * k;
          if (t < 1) done = false;
        }
        if (!done) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  // ------------------------------ Socket receiver (cache-only) ------------------------------
  if (window[FLAG]) return; // idempotent
  Hooks.once("ready", () => {
    try {
      const sockMod = game.modules.get("socketlib");
      if (!sockMod?.active || !window.socketlib) {
        ui.notifications.error("FU Cut-In: socketlib not found/active.");
        return;
      }
      const socket = socketlib.registerModule(MODULE_ID);

      socket.register(ACTION_KEY, async (payload) => {
        // Strict cache-only: require keys; drop if expired or not for me
        const myId = game.user?.id;
        if (Array.isArray(payload?.allowedUserIds) && myId && !payload.allowedUserIds.includes(myId)) return;

        const now = Date.now();
        const expireAt = Number(payload?.expireAt) || (Number(payload?.t0) + 3000);
        if (Number.isFinite(expireAt) && now > expireAt) return;

        // Require keys, not URLs
        if (!payload?.imgKey) {
          console.warn("[FU Cut-In] Missing imgKey in payload; dropping (cache-only policy).");
          return;
        }
        await playCutInFromCache(payload);
      });

      // PRELOAD manifest handler: GM sends a list of {key,url,type:"img"|"sfx"} for a combat
      socket.register(ACTION_PRELOAD, async (manifest) => {
        try {
          const cId  = manifest?.combatId ?? null;
          const list = Array.isArray(manifest?.items) ? manifest.items : [];
          if (!cId || !list.length) return;

          // For each item, preload strictly from URL now (only during preload)
          for (const it of list) {
            if (!it?.key || !it?.url) continue;
            if (it.type === "img") {
              try { await preloadTexture(it.key, it.url); setCombatKey(cId, it.key); }
              catch (e) { cacheBag()[it.key] = { miss:true, cachedAt:Date.now(), note:"LOAD_ERROR" }; setCombatKey(cId, it.key); }
            } else if (it.type === "sfx") {
              try { await preloadAudio(it.key, it.url); setCombatKey(cId, it.key); }
              catch (e) { /* sfx load failure is non-fatal */ }
            }
          }

          console.log("[FU Cut-In] Preloaded via GM manifest for combat:", cId, "items:", list.length);
        } catch (e) {
          console.error("[FU Cut-In] Preload manifest error:", e);
        }
      });

      window.__FU_CUTIN_PLAY = playCutInFromCache;

      // Warm minimal texture to upload GPU path
      Hooks.once("canvasReady", async () => {
        try {
          ensureLayer();
          __layer.visible = true; __portrait.visible = false;
          await new Promise(r => requestAnimationFrame(r));
          __portrait.visible = true; __layer.visible = false;
        } catch (e) {
          console.warn("[FU Cut-In] Warm-up failed:", e);
        }
      });

      // ------------------------------ Combat hooks: preload & forget (robust) ------------------------------
      // We listen to three hooks to catch all end paths:
      //  • combatEnd            – when the active flag is cleared via UI
      //  • deleteCombat         – when the Combat document is deleted
      //  • updateCombat(active) – when active flips to false (some modules/UIs do this)
      Hooks.on("combatStart", async (combat) => {
        try {
          const cId = combat?.id ?? `combat:${Date.now()}`;
          const list = combat?.combatants?.contents ?? [];

          // Build a manifest only on the GM (players will receive it and preload)
          if (game.user?.isGM) {
            const items = [];

            // SFX entries (GM decides final URLs)
            for (const t of ["critical","zero_power","fumble"]) {
              items.push({ type:"sfx", key:`sfx:${t}`, url:SFX_URLS[t] });
            }

            // Portraits per combatant
            for (const c of list) {
              const actor = c?.actor; if (!actor) continue;
              const aId = actor.id;
              const props = actor?.system?.props ?? {};
              const defs = {
                critical:   props.cut_in_critical || null,
                zero_power: props.cut_in_zero_power || null,
                fumble:     props.cut_in_fumble || null
              };
              for (const [type, url] of Object.entries(defs)) {
                const key = `cutin:${aId}:${type}`;
                if (url) items.push({ type:"img", key, url });
                else     items.push({ type:"img", key, url:null }); // still create a slot; receivers will mark MISS
              }
            }

            // Broadcast the manifest to every active user
            const sock  = socketlib.registerModule(MODULE_ID);
            const users = (game.users?.filter(u => u.active) ?? []).map(u => u.id);
            await (typeof sock.executeForUsers === "function" && users.length
              ? sock.executeForUsers(ACTION_PRELOAD, users, { combatId:cId, items })
              : sock.executeForEveryone(ACTION_PRELOAD, { combatId:cId, items }));

            // GM also preloads locally using the same path (call our own handler)
            await socketlib.registerModule(MODULE_ID).executeForUser
              ?.call(null, game.user.id, ACTION_PRELOAD, { combatId:cId, items });

            ui.notifications.info("FU Cut-In: Assets cached for this combat.");
            console.log("[FU Cut-In] GM broadcasted preload manifest for combat:", cId, "items:", items.length);
          } else {
            // Non-GM: do nothing here — we rely on the GM’s manifest handler above
          }
        } catch (e) {
          console.error("[FU Cut-In] combatStart preload error:", e);
        }
      });

      // unified cleanup function + console/notification
      function _fuCleanupCombatCache(combat, reason) {
        try {
          const cId = combat?.id ?? null;
          if (cId) forgetCombat(cId);
          if (game.user?.isGM) {
            ui.notifications.info("FU Cut-In: Cleared combat cache.");
            console.log("[FU Cut-In] Cleared combat cache via", reason, "combatId:", cId);
          } else {
            console.log("[FU Cut-In] Cleared combat cache (non-GM) via", reason, "combatId:", cId);
          }
        } catch (e) {
          console.error("[FU Cut-In] cleanup error:", e);
        }
      }

      // 1) Normal end
      Hooks.on("combatEnd", (combat) => _fuCleanupCombatCache(combat, "combatEnd"));

      // 2) Document deleted
      Hooks.on("deleteCombat", (combat) => _fuCleanupCombatCache(combat, "deleteCombat"));

      // 3) Active → false
      Hooks.on("updateCombat", (combat, changed) => {
        if (Object.prototype.hasOwnProperty.call(changed, "active") && changed.active === false) {
          _fuCleanupCombatCache(combat, "updateCombat(active=false)");
        }
      });

      // Expose a tiny API for debugging (UNCHANGED — keep this)
      window[NS] = window[NS] || {};
      window[NS].cutin = {
        cacheInfo: () => ({ size: cacheBag().size, keys: Object.keys(cacheBag()).filter(k=>!k.startsWith("__")) }),
        preload:    preloadTexture,
        play:       playCutInFromCache
      };

      window[FLAG] = true;
      console.log("[FU Cut-In] Receiver+Cache installed.");
    } catch (err) {
      console.error("[FU Cut-In] Receiver failed to install:", err);
    }
  });
})();
