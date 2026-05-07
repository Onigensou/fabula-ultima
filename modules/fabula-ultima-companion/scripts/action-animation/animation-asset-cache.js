/**
 * scripts/animation-asset-cache.js
 * Foundry VTT v12
 *
 * [ONI][AnimCache]
 * Phase 2 + 3:
 * - Preload likely animation assets when combat starts.
 * - Keep soft references during combat.
 * - Release cache references when combat ends / combat is deleted.
 * - Expose helper API for future upgraded animation scripts.
 *
 * Backward-compatible:
 * - Old animation scripts do NOT need to be updated.
 * - Old pseudo scripts that use loadTexture(url) can still benefit because this
 *   preloads the same URL through loadTexture(url).
 * - Future scripts may get stronger benefit by using:
 *     FUCompanion.api.animationCache.getTexture(url)
 *     FUCompanion.api.animationCache.loadTexturePreferCache(url)
 *
 * Important:
 * - This performs SOFT release only.
 * - It does NOT destroy PIXI textures, because textures may be shared by tokens,
 *   Foundry, Sequencer, or other animations.
 */

(() => {
  // ============================================================================
  // Config
  // ============================================================================

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_NS = `module.${MODULE_ID}`;
  const TAG = "[ONI][AnimCache]";

  const CFG = {
    debug: false,

    // Combat hooks
    preloadOnCombatStart: true,
    releaseOnDeleteCombat: true,

    // Loading behavior
    maxConcurrentLoads: 4,
    maxAssetsPerCombat: 250,

    preloadVisuals: true,
    preloadAudio: true,

    // GM can scan all combatant actors more reliably.
    // The primary active GM broadcasts only URL strings to players.
    broadcastManifestFromPrimaryGM: true,

    // Non-GM clients also scan what they can locally.
    // This is useful if no GM manifest arrives or for player-owned animations.
    allowLocalClientScan: true,

    // Include common related art. Useful for cut-ins and token clone effects.
includeActorImages: false,
includeTokenImages: true,
includeItemImages: false,

// Safer scanner behavior.
// false = only scan known animation-related fields.
// true = scan all item data, but may catch icons, map art, and unrelated images.
broadFallbackScan: false,

    // Skip extremely tiny / invalid paths.
    minUrlLength: 5
  };

  // ============================================================================
  // Internal state
  // ============================================================================

  const visualCache = new Map();
  const audioCache = new Map();
  const failed = new Map();

  const combatPreloadStarted = new Set();
  const manifestSeen = new Set();

  let apiReady = false;

  // ============================================================================
  // Logging
  // ============================================================================

  function log(...args) {
    if (CFG.debug) console.log(TAG, ...args);
  }

  function warn(...args) {
    console.warn(TAG, ...args);
  }

  function err(...args) {
    console.error(TAG, ...args);
  }

  // ============================================================================
  // Small helpers
  // ============================================================================

  function now() {
    return Date.now();
  }

  function safeClone(value, fallback = null) {
    try {
      return foundry?.utils?.deepClone
        ? foundry.utils.deepClone(value)
        : JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  }

  function uniqueStrings(values) {
    return Array.from(
      new Set(
        (Array.isArray(values) ? values : [])
          .filter(v => v != null)
          .map(v => String(v).trim())
          .filter(Boolean)
      )
    );
  }

  function normalizeUrl(raw) {
    let s = String(raw ?? "").trim();
    if (!s) return "";

    // Common HTML escaping from rich text.
    s = s.replaceAll("&amp;", "&");

    // Remove accidental wrapping quotes.
    s = s.replace(/^['"`]+|['"`]+$/g, "").trim();

    // Remove trailing punctuation that sometimes gets caught by broad regex.
    s = s.replace(/[),.;]+$/g, "").trim();

    if (s.length < CFG.minUrlLength) return "";

    return s;
  }

  function isLikelyVisualUrl(url) {
    return /\.(webm|mp4|png|jpg|jpeg|webp|gif)(?:\?|#|$)/i.test(String(url ?? ""));
  }

  function isLikelyAudioUrl(url) {
    return /\.(ogg|mp3|wav|m4a|flac)(?:\?|#|$)/i.test(String(url ?? ""));
  }

  function isLikelyAssetUrl(url) {
    return isLikelyVisualUrl(url) || isLikelyAudioUrl(url);
  }

  function getPrimaryActiveGM() {
    const gms = Array.from(game.users ?? [])
      .filter(u => u.active && u.isGM)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    return gms[0] ?? null;
  }

  function isPrimaryActiveGMClient() {
    const primary = getPrimaryActiveGM();
    return !!primary && primary.id === game.userId;
  }

  function getRichTextApi() {
    try {
      return game.modules?.get(MODULE_ID)?.api?.richText ?? globalThis.FUCompanion?.api?.richText ?? null;
    } catch {
      return null;
    }
  }

  function htmlToPlain(html = "") {
    const s = String(html ?? "");
    if (!s.trim()) return "";

    const richText = getRichTextApi();
    if (richText?.toScript) {
      try {
        return String(richText.toScript(s) ?? "");
      } catch (e) {
        warn("richText.toScript failed; using fallback plain-text extraction.", e);
      }
    }

    try {
      const div = document.createElement("div");
      div.innerHTML = s;
      return div.textContent || div.innerText || s;
    } catch {
      return s;
    }
  }

  async function mapLimit(items, limit, worker) {
    const list = Array.isArray(items) ? items : [];
    const results = [];
    let index = 0;

    const count = Math.max(1, Number(limit) || 1);

    async function runOneWorker() {
      while (index < list.length) {
        const currentIndex = index++;
        try {
          results[currentIndex] = await worker(list[currentIndex], currentIndex);
        } catch (e) {
          results[currentIndex] = { ok: false, error: String(e?.message ?? e) };
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(count, list.length || 1) },
      () => runOneWorker()
    );

    await Promise.all(workers);
    return results;
  }

  function keyLooksAnimationRelated(key) {
  const k = String(key ?? "").toLowerCase();

  return (
    k.includes("anim") ||
    k.includes("animation") ||
    k.includes("vfx") ||
    k.includes("sfx") ||
    k.includes("sound") ||
    k.includes("audio") ||
    k.includes("cutin") ||
    k.includes("cut_in") ||
    k.includes("battler") ||
    k.includes("fx")
  );
}

  // ============================================================================
  // URL extraction
  // ============================================================================

  function extractAssetUrlsFromText(text = "") {
    const s = String(text ?? "");
    if (!s.trim()) return [];

    const urls = new Set();

    // Quoted strings:
    // "modules/x/y.webm"
    // 'https://.../sound.ogg'
    // `worlds/.../image.png`
    const quotedRx =
      /["'`]([^"'`<>]*?(?:https?:\/\/|modules\/|systems\/|worlds\/|uploads\/|\/)[^"'`<>]*?\.(?:webm|mp4|png|jpg|jpeg|webp|gif|ogg|mp3|wav|m4a|flac)(?:\?[^"'`<>]*)?)["'`]/gi;

    let m;
    while ((m = quotedRx.exec(s))) {
      const url = normalizeUrl(m[1]);
      if (url && isLikelyAssetUrl(url)) urls.add(url);
    }

    // CSS url(...)
    const cssRx =
      /url\(\s*["']?([^"')<>]*?\.(?:webm|mp4|png|jpg|jpeg|webp|gif|ogg|mp3|wav|m4a|flac)(?:\?[^"')<>]*)?)["']?\s*\)/gi;

    while ((m = cssRx.exec(s))) {
      const url = normalizeUrl(m[1]);
      if (url && isLikelyAssetUrl(url)) urls.add(url);
    }

    // Broad fallback for unquoted module/world/system/http paths.
    const broadRx =
      /\b((?:https?:\/\/|modules\/|systems\/|worlds\/|uploads\/|\/)[^\s"'<>)]*?\.(?:webm|mp4|png|jpg|jpeg|webp|gif|ogg|mp3|wav|m4a|flac)(?:\?[^\s"'<>)]*)?)/gi;

    while ((m = broadRx.exec(s))) {
      const url = normalizeUrl(m[1]);
      if (url && isLikelyAssetUrl(url)) urls.add(url);
    }

    return [...urls];
  }

function collectStringsFromObject(obj, options = {}) {
  const {
    maxDepth = 5,
    maxStringLength = 250000,
    maxStrings = 500,
    animationKeysOnly = true
  } = options;

  const out = [];
  const seen = new Set();

  function visit(value, depth, keyName = "") {
    if (out.length >= maxStrings) return;
    if (depth > maxDepth) return;
    if (value == null) return;

    if (typeof value === "string") {
      if (value.length > maxStringLength) return;

      if (!animationKeysOnly || keyLooksAnimationRelated(keyName)) {
        out.push(value);
      }

      return;
    }

    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1, keyName);
      return;
    }

    for (const [k, entry] of Object.entries(value)) {
      visit(entry, depth + 1, k);
    }
  }

  visit(obj, 0, "");
  return out;
}

  function extractAssetUrlsFromItem(item) {
    const urls = new Set();
    if (!item) return [];

    const props = item.system?.props ?? {};
    const system = item.system ?? {};

    const preferredFields = [
      props.animation_script,
      props.animation_script_raw,
      props.animationScript,
      props.animationScriptRaw,
      props.active_animation,
      props.active_animation_script,
      props.custom_animation,
      props.skill_animation,
      props.vfx_script,
      props.sfx_script,
      system.animation_script,
      system.animationScript,
      item.animationScript,
      item.animationScriptRaw
    ];

    for (const raw of preferredFields) {
      const text = htmlToPlain(raw ?? "");
      for (const url of extractAssetUrlsFromText(text)) urls.add(url);
    }

// Fallback scan.
// Keep this conservative by default so we do not preload every item icon,
// inventory image, map image, or unrelated artwork.
if (CFG.broadFallbackScan) {
  const strings = [
    ...collectStringsFromObject(props, { animationKeysOnly: false }),
    ...collectStringsFromObject(system, { animationKeysOnly: false })
  ];

  for (const raw of strings) {
    const text = htmlToPlain(raw);
    for (const url of extractAssetUrlsFromText(text)) urls.add(url);
  }
} else {
  const strings = [
    ...collectStringsFromObject(props, { animationKeysOnly: true }),
    ...collectStringsFromObject(system, { animationKeysOnly: true })
  ];

  for (const raw of strings) {
    const text = htmlToPlain(raw);
    for (const url of extractAssetUrlsFromText(text)) urls.add(url);
  }
}

    if (CFG.includeItemImages && item.img) {
      const img = normalizeUrl(item.img);
      if (img && isLikelyVisualUrl(img)) urls.add(img);
    }

    return [...urls];
  }

  function extractAssetUrlsFromActor(actor, { includeOwnedItems = true } = {}) {
    const urls = new Set();
    if (!actor) return [];

    if (CFG.includeActorImages && actor.img) {
      const img = normalizeUrl(actor.img);
      if (img && isLikelyVisualUrl(img)) urls.add(img);
    }

    if (includeOwnedItems) {
      for (const item of actor.items ?? []) {
        for (const url of extractAssetUrlsFromItem(item)) {
          urls.add(url);
        }
      }
    }

    return [...urls];
  }

  function extractAssetUrlsFromToken(tokenOrDoc) {
    const urls = new Set();
    if (!tokenOrDoc) return [];

    const tokenDoc = tokenOrDoc.document ?? tokenOrDoc;
    const textureSrc =
      tokenDoc?.texture?.src ??
      tokenDoc?.texture?.src ??
      tokenDoc?.img ??
      null;

    if (CFG.includeTokenImages && textureSrc) {
      const src = normalizeUrl(textureSrc);
      if (src && isLikelyVisualUrl(src)) urls.add(src);
    }

    const actor = tokenOrDoc.actor ?? tokenDoc.actor ?? null;
    for (const url of extractAssetUrlsFromActor(actor)) {
      urls.add(url);
    }

    return [...urls];
  }

  function getCombatantTokenDoc(combatant) {
    return combatant?.token ?? combatant?.tokenDocument ?? combatant?.tokenDoc ?? null;
  }

  function scanCombatAssets(combat = game.combat) {
    const urls = new Set();

    if (!combat) {
      return {
        combatId: null,
        urls: [],
        combatants: 0,
        reason: "no-combat"
      };
    }

    const combatants = Array.from(combat.combatants ?? []);

    for (const c of combatants) {
      const actor = c.actor ?? null;

      if (actor) {
        for (const url of extractAssetUrlsFromActor(actor)) {
          urls.add(url);
        }
      }

      const tokenDoc = getCombatantTokenDoc(c);
      if (tokenDoc) {
        for (const url of extractAssetUrlsFromToken(tokenDoc)) {
          urls.add(url);
        }
      }
    }

    const all = [...urls].filter(Boolean).slice(0, CFG.maxAssetsPerCombat);

    return {
      combatId: combat.id ?? null,
      urls: all,
      combatants: combatants.length,
      capped: urls.size > all.length,
      foundTotal: urls.size
    };
  }

  // ============================================================================
  // Preload functions
  // ============================================================================

  async function preloadTexture(url, options = {}) {
    const cleanUrl = normalizeUrl(url);
    if (!cleanUrl || !isLikelyVisualUrl(cleanUrl)) {
      return { ok: false, skipped: true, reason: "not_visual_url", url: cleanUrl };
    }

    const key = String(options.key ?? cleanUrl);

    if (visualCache.has(key)) {
      return { ok: true, cached: true, type: "visual", url: cleanUrl, key };
    }

    if (failed.has(cleanUrl)) {
      return {
        ok: false,
        skipped: true,
        reason: "previous_failure",
        url: cleanUrl,
        previous: failed.get(cleanUrl)
      };
    }

    if (typeof loadTexture !== "function") {
      return { ok: false, reason: "loadTexture_unavailable", url: cleanUrl };
    }

    try {
      const texture = await loadTexture(cleanUrl);

      visualCache.set(key, {
        url: cleanUrl,
        key,
        texture,
        loadedAt: now(),
        reason: options.reason ?? null
      });

      log("visual preloaded", { url: cleanUrl, key });
      return { ok: true, type: "visual", url: cleanUrl, key };
    } catch (e) {
      const failure = {
        type: "visual",
        url: cleanUrl,
        at: now(),
        error: String(e?.message ?? e)
      };

      failed.set(cleanUrl, failure);
      warn("visual preload failed", failure);

      return { ok: false, reason: "preload_failed", ...failure };
    }
  }

  async function preloadAudio(url, options = {}) {
    const cleanUrl = normalizeUrl(url);
    if (!cleanUrl || !isLikelyAudioUrl(cleanUrl)) {
      return { ok: false, skipped: true, reason: "not_audio_url", url: cleanUrl };
    }

    const key = String(options.key ?? cleanUrl);

    if (audioCache.has(key)) {
      return { ok: true, cached: true, type: "audio", url: cleanUrl, key };
    }

    if (failed.has(cleanUrl)) {
      return {
        ok: false,
        skipped: true,
        reason: "previous_failure",
        url: cleanUrl,
        previous: failed.get(cleanUrl)
      };
    }

    try {
      // Foundry/browser audio caching is less deterministic than PIXI texture caching.
      // This is still useful because it asks the browser to warm the asset.
      const helper =
        foundry?.audio?.AudioHelper ??
        globalThis.AudioHelper ??
        null;

      if (helper?.preload) {
        try {
          await helper.preload(cleanUrl);
        } catch (helperErr) {
          // Fallback below.
          log("AudioHelper.preload failed; using HTMLAudio fallback.", {
            url: cleanUrl,
            error: String(helperErr?.message ?? helperErr)
          });
        }
      }

      const audio = new Audio();
      audio.preload = "auto";
      audio.src = cleanUrl;

      // load() is allowed without playing sound.
      try {
        audio.load();
      } catch (_) {}

      audioCache.set(key, {
        url: cleanUrl,
        key,
        audio,
        loadedAt: now(),
        reason: options.reason ?? null
      });

      log("audio preloaded", { url: cleanUrl, key });
      return { ok: true, type: "audio", url: cleanUrl, key };
    } catch (e) {
      const failure = {
        type: "audio",
        url: cleanUrl,
        at: now(),
        error: String(e?.message ?? e)
      };

      failed.set(cleanUrl, failure);
      warn("audio preload failed", failure);

      return { ok: false, reason: "preload_failed", ...failure };
    }
  }

  async function preloadAsset(url, options = {}) {
    const cleanUrl = normalizeUrl(url);

    if (isLikelyVisualUrl(cleanUrl)) {
      if (!CFG.preloadVisuals) return { ok: false, skipped: true, reason: "visuals_disabled", url: cleanUrl };
      return await preloadTexture(cleanUrl, options);
    }

    if (isLikelyAudioUrl(cleanUrl)) {
      if (!CFG.preloadAudio) return { ok: false, skipped: true, reason: "audio_disabled", url: cleanUrl };
      return await preloadAudio(cleanUrl, options);
    }

    return { ok: false, skipped: true, reason: "unknown_asset_type", url: cleanUrl };
  }

  async function preloadMany(urls = [], options = {}) {
    const unique = uniqueStrings(urls)
      .map(normalizeUrl)
      .filter(Boolean)
      .filter(isLikelyAssetUrl)
      .slice(0, Number(options.maxAssets ?? CFG.maxAssetsPerCombat) || CFG.maxAssetsPerCombat);

    const visualCount = unique.filter(isLikelyVisualUrl).length;
    const audioCount = unique.filter(isLikelyAudioUrl).length;

    log("preloadMany start", {
      total: unique.length,
      visualCount,
      audioCount,
      reason: options.reason ?? null
    });

    const startedAt = performance.now?.() ?? Date.now();

    const results = await mapLimit(
      unique,
      Number(options.maxConcurrentLoads ?? CFG.maxConcurrentLoads) || CFG.maxConcurrentLoads,
      async (url) => preloadAsset(url, options)
    );

    const endedAt = performance.now?.() ?? Date.now();

    const ok = results.filter(r => r?.ok).length;
    const cached = results.filter(r => r?.cached).length;
    const skipped = results.filter(r => r?.skipped).length;
    const bad = results.length - ok - skipped;

    const summary = {
      ok: true,
      total: unique.length,
      loadedOrCached: ok,
      cached,
      skipped,
      failed: bad,
      visualCacheSize: visualCache.size,
      audioCacheSize: audioCache.size,
      ms: Math.round(endedAt - startedAt)
    };

    log("preloadMany done", summary);
    return summary;
  }

  async function loadTexturePreferCache(url, options = {}) {
    const cleanUrl = normalizeUrl(url);
    const key = String(options.key ?? cleanUrl);

    const cached = visualCache.get(key)?.texture ?? visualCache.get(cleanUrl)?.texture ?? null;
    if (cached) return cached;

    const result = await preloadTexture(cleanUrl, options);
    if (result?.ok) {
      return visualCache.get(key)?.texture ?? visualCache.get(cleanUrl)?.texture ?? null;
    }

    // Final fallback, so future scripts can use this helper safely.
    return await loadTexture(cleanUrl);
  }

  function getTexture(urlOrKey) {
    const key = String(urlOrKey ?? "").trim();
    if (!key) return null;

    return (
      visualCache.get(key)?.texture ??
      visualCache.get(normalizeUrl(key))?.texture ??
      null
    );
  }

  function hasAsset(urlOrKey) {
    const key = String(urlOrKey ?? "").trim();
    const clean = normalizeUrl(key);

    return !!(
      visualCache.has(key) ||
      visualCache.has(clean) ||
      audioCache.has(key) ||
      audioCache.has(clean)
    );
  }

  // ============================================================================
  // Combat preload + socket manifest
  // ============================================================================

  function buildManifestMessage({ combatId, urls, source = "combatStart" }) {
    return {
      type: "oni.animCache.preloadManifest",
      combatId: combatId ?? null,
      urls: uniqueStrings(urls).slice(0, CFG.maxAssetsPerCombat),
      source,
      senderUserId: game.userId ?? null,
      senderUserName: game.user?.name ?? null,
      sentAt: now()
    };
  }

  function broadcastManifest({ combatId, urls, source = "combatStart" }) {
    if (!CFG.broadcastManifestFromPrimaryGM) return false;
    if (!game.user?.isGM) return false;
    if (!isPrimaryActiveGMClient()) return false;
    if (!game.socket) return false;

    const msg = buildManifestMessage({ combatId, urls, source });

    try {
      game.socket.emit(SOCKET_NS, msg);
      log("broadcast manifest", {
        combatId,
        urls: msg.urls.length,
        sender: game.user?.name
      });
      return true;
    } catch (e) {
      warn("broadcast manifest failed", e);
      return false;
    }
  }

  async function onSocketMessage(msg) {
    try {
      if (!msg || msg.type !== "oni.animCache.preloadManifest") return;

      const sender = game.users?.get?.(msg.senderUserId);
      if (!sender?.isGM) {
        warn("ignored preload manifest from non-GM sender", {
          senderUserId: msg.senderUserId,
          senderUserName: msg.senderUserName
        });
        return;
      }

      const manifestKey = `${msg.combatId ?? "no-combat"}:${msg.sentAt ?? "no-time"}:${msg.senderUserId ?? "no-user"}`;
      if (manifestSeen.has(manifestKey)) return;
      manifestSeen.add(manifestKey);

      log("received GM preload manifest", {
        combatId: msg.combatId ?? null,
        urls: Array.isArray(msg.urls) ? msg.urls.length : 0,
        sender: sender.name
      });

      await preloadMany(msg.urls ?? [], {
        reason: "gm-manifest",
        combatId: msg.combatId ?? null
      });
    } catch (e) {
      err("socket message failed", e);
    }
  }

  async function preloadCombat(combat = game.combat, options = {}) {
    if (!combat) {
      warn("preloadCombat skipped: no combat.");
      return { ok: false, reason: "no-combat" };
    }

    const combatId = combat.id ?? "NO_COMBAT_ID";

    if (combatPreloadStarted.has(combatId) && !options.force) {
      log("preloadCombat skipped: already started for this combat.", { combatId });
      return { ok: true, skipped: true, reason: "already-started", combatId };
    }

    combatPreloadStarted.add(combatId);

    const canLocalScan = game.user?.isGM || CFG.allowLocalClientScan;
    if (!canLocalScan) {
      return { ok: false, skipped: true, reason: "local-scan-disabled", combatId };
    }

    const scan = scanCombatAssets(combat);

    log("combat scan result", {
      combatId,
      combatants: scan.combatants,
      urls: scan.urls.length,
      foundTotal: scan.foundTotal,
      capped: !!scan.capped,
      isGM: !!game.user?.isGM,
      isPrimaryGM: isPrimaryActiveGMClient()
    });

    if (game.user?.isGM && isPrimaryActiveGMClient()) {
      broadcastManifest({
        combatId,
        urls: scan.urls,
        source: "combatStart"
      });
    }

    return await preloadMany(scan.urls, {
      reason: "combat-start",
      combatId,
      maxAssets: CFG.maxAssetsPerCombat
    });
  }

  // ============================================================================
  // Release / diagnostics
  // ============================================================================

  function releaseSoft(reason = "manual") {
    const before = {
      visual: visualCache.size,
      audio: audioCache.size,
      failed: failed.size,
      combats: combatPreloadStarted.size,
      manifests: manifestSeen.size
    };

    // Soft release only.
    // Do NOT texture.destroy(true). These assets may be shared.
    visualCache.clear();
    audioCache.clear();
    failed.clear();
    combatPreloadStarted.clear();
    manifestSeen.clear();

    const after = {
      visual: visualCache.size,
      audio: audioCache.size,
      failed: failed.size,
      combats: combatPreloadStarted.size,
      manifests: manifestSeen.size
    };

    log("soft release", { reason, before, after });

    return {
      ok: true,
      reason,
      before,
      after
    };
  }

  function cacheInfo() {
    return {
      visual: visualCache.size,
      audio: audioCache.size,
      failed: failed.size,
      combatPreloadStarted: [...combatPreloadStarted],
      manifestSeenCount: manifestSeen.size,
      visualKeys: [...visualCache.keys()],
      audioKeys: [...audioCache.keys()],
      failedKeys: [...failed.keys()]
    };
  }

  function setDebug(enabled) {
    CFG.debug = !!enabled;
    console.log(TAG, `debug = ${CFG.debug}`);
    return CFG.debug;
  }

  // ============================================================================
  // API exposure
  // ============================================================================

  function exposeApi() {
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};

    const mod = game.modules?.get?.(MODULE_ID);
    if (mod) mod.api ??= {};

    const api = {
      version: "0.1.0",

      config: CFG,

      // URL extraction
      extractAssetUrlsFromText,
      extractAssetUrlsFromItem,
      extractAssetUrlsFromActor,
      extractAssetUrlsFromToken,
      scanCombatAssets,

      // Preload
      preloadAsset,
      preloadTexture,
      preloadAudio,
      preloadMany,
      preloadCombat,

      // Future animation helper
      getTexture,
      hasAsset,
      loadTexturePreferCache,

      // Cleanup / diagnostics
      releaseSoft,
      cacheInfo,
      setDebug
    };

    globalThis.FUCompanion.api.animationCache = api;
    if (mod) mod.api.animationCache = api;

    apiReady = true;

    log("API ready: FUCompanion.api.animationCache");
    return api;
  }

  // ============================================================================
  // Hooks
  // ============================================================================

  Hooks.once("init", () => {
    exposeApi();
  });

  Hooks.once("ready", () => {
    if (!apiReady) exposeApi();

    try {
      game.socket?.on?.(SOCKET_NS, onSocketMessage);
      log("socket listener ready", SOCKET_NS);
    } catch (e) {
      warn("socket listener setup failed", e);
    }

    // If the script was loaded after combat had already started, allow manual call:
    // FUCompanion.api.animationCache.preloadCombat()
    log("ready", {
      isGM: !!game.user?.isGM,
      isPrimaryGM: isPrimaryActiveGMClient(),
      preloadOnCombatStart: CFG.preloadOnCombatStart
    });
  });

  Hooks.on("combatStart", async (combat) => {
    if (!CFG.preloadOnCombatStart) return;

    try {
      await preloadCombat(combat, { source: "combatStart" });
    } catch (e) {
      err("combatStart preload failed", e);
    }
  });

  // Fallback: some workflows create/update combat differently.
  // This catches combat that becomes active/started without relying only on combatStart.
  Hooks.on("updateCombat", async (combat, changed) => {
    if (!CFG.preloadOnCombatStart) return;
    if (!combat?.started && !combat?.active) return;

    const combatId = combat.id ?? null;
    if (!combatId || combatPreloadStarted.has(combatId)) return;

    try {
      await preloadCombat(combat, { source: "updateCombat" });
    } catch (e) {
      err("updateCombat preload failed", e);
    }
  });

  Hooks.on("deleteCombat", async (combat) => {
    if (!CFG.releaseOnDeleteCombat) return;

    try {
      releaseSoft(`deleteCombat:${combat?.id ?? "unknown"}`);
    } catch (e) {
      err("deleteCombat release failed", e);
    }
  });
})();