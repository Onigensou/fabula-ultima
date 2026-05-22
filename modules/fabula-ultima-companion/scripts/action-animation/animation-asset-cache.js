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

  // Socket message types
  const MSG_PRELOAD_MANIFEST       = "oni.animCache.preloadManifest";      // legacy: fire-and-forget
  const MSG_COMBAT_PREPARE         = "oni.animCache.combatPrepare";        // GM → players: preload BEFORE combat starts
  const MSG_COMBAT_PREPARE_ACK     = "oni.animCache.combatPrepareAck";     // player → GM: preload done
  const MSG_COMBAT_PREPARE_RELEASE = "oni.animCache.combatPrepareRelease"; // GM → players: implicit-fade release
  const MSG_CURTAIN_RAISE          = "oni.animCache.curtainRaise";         // GM → players: raise the black curtain
  const MSG_CURTAIN_DROP           = "oni.animCache.curtainDrop";          // GM → players: drop the black curtain

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
includeItemImages: true,

    // Preload the JS-hardcoded battle SFX/VFX manifest at world `ready` so the
    // first hit-sound / first reaction VFX / first roll SFX doesn't pay a
    // network round-trip mid-combat.
    preloadStaticOnReady: true,

    // When the GM clicks "Start Combat", wrap startCombat so the doc update
    // (and therefore the `combatStart` hook on every client) only fires after
    // every active non-GM client has socket-ack'd that their local preload is
    // complete. Capped by `combatPrepareTimeoutMs` so a flaky client can't
    // freeze the table indefinitely.
    gateCombatStartOnPreload: true,
    combatPrepareTimeoutMs: 8000,

// Safer scanner behavior.
// false = only scan known animation-related fields.
// true = scan all item data, but may catch icons, map art, and unrelated images.
broadFallbackScan: false,

    // Skip extremely tiny / invalid paths.
    minUrlLength: 5
  };

  // ============================================================================
  // Static battle manifest
  // ----------------------------------------------------------------------------
  // Assets that are *hardcoded* in JS playback sites (not in item data, so the
  // combatant scanner can't see them). These all play during combat or in the
  // tight UI loop around it. Each URL is annotated with the site that plays it
  // — keep this list in sync when those constants change.
  //
  // Source-of-truth lives at the playback site; this list duplicates the URL
  // so the preloader can warm the HTTP cache + PIXI texture cache before the
  // sound/image is actually requested.
  // ============================================================================

  const FORGE_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb";
  const ROAR_BASE = `${FORGE_BASE}/Sound`;
  const ICON_BASE = `${FORGE_BASE}/Item%20Icon`;

  const STATIC_BATTLE_URLS = Object.freeze([
    // ── apply-damage-core.js _SFX ────────────────────────────────────────────
    `${FORGE_BASE}/Sound/HitSlashM.wav`,
    `${FORGE_BASE}/Sound/Heal3.ogg`,
    `${FORGE_BASE}/Sound/Dispel%20Magic.ogg`,
    `${FORGE_BASE}/Sound/AbsorbElement.ogg`,
    `${FORGE_BASE}/Sound/Hit_SlashingB.wav`,
    `${FORGE_BASE}/Sound/Soundboard/Parry.ogg`,
    // apply-damage-core JB2A VFX
    "modules/JB2A_DnD5e/Library/Generic/Healing/HealingAbility_01_Green_400x400.webm",
    "modules/JB2A_DnD5e/Library/Generic/Impact/Impact_07_Regular_Orange_400x400.webm",
    "modules/JB2A_DnD5e/Library/Generic/Healing/HealingAbility_01_Blue_400x400.webm",
    "modules/JB2A_DnD5e/Library/2nd_Level/Misty_Step/MistyStep_01_Regular_Blue_400x400.webm",

    // ── ActiveEffectManager-fx.js ───────────────────────────────────────────
    `${FORGE_BASE}/Sound/Recovery.ogg`,
    // Dispel Magic.ogg already above

    // ── check-roller (rollSfx, critSfx, fumbleSfx, portrait, attribute icons)
    `${FORGE_BASE}/Sound/Dice.wav`,
    `${FORGE_BASE}/Sound/Flash2.ogg`,
    `${FORGE_BASE}/Sound/ME/Shock2.ogg`,
    `${FORGE_BASE}/Character/Cherry/Cherry_Portrait.png`,
    `${ICON_BASE}/asan.png`,   // MIG
    `${ICON_BASE}/boot.png`,   // DEX
    `${ICON_BASE}/book.png`,   // INS
    `${ICON_BASE}/stat.png`,   // WLP
    `${ICON_BASE}/dice.png`,   // fallback
    // checkRoller-dialog cursor sounds
    `${FORGE_BASE}/Sound/BattleCursor_4.wav`,
    `${FORGE_BASE}/Sound/BattleCursor_1.wav`,
    `${FORGE_BASE}/Sound/BattleCursor_2.wav`,

    // ── check-requester (multi-player checks during combat) ─────────────────
    `${FORGE_BASE}/Sound/check_start.wav`,
    `${FORGE_BASE}/Sound/check_ready.wav`,
    `${FORGE_BASE}/Sound/participant_enter.wav`,
    `${FORGE_BASE}/Sound/participant_exit.wav`,
    `${FORGE_BASE}/Sound/Critical_1.wav`,
    `${FORGE_BASE}/Sound/failed_1.wav`,
    `${FORGE_BASE}/Sound/success_4.wav`,
    `${FORGE_BASE}/Sound/success2.ogg`,
    `${FORGE_BASE}/Sound/Soundboard/Buzzer2.ogg`,

    // ── cutin-receiver (crit / zero-power / fumble cut-ins) ─────────────────
    `${FORGE_BASE}/Sound/BurstMax.ogg`,
    `${FORGE_BASE}/Sound/ChargeAttack.ogg`,
    `${FORGE_BASE}/Sound/Down2.ogg`,

    // ── auto-defeat ─────────────────────────────────────────────────────────
    `${FORGE_BASE}/Sound/Enemy_Death.ogg`,

    // ── battle-init: party dash + per-species roars ─────────────────────────
    `${FORGE_BASE}/Sound/DashA.wav`,
    `${ROAR_BASE}/Monster1.ogg`,
    `${ROAR_BASE}/Monster2.ogg`,
    `${ROAR_BASE}/Monster3.ogg`,
    `${ROAR_BASE}/Monster4.ogg`,
    `${ROAR_BASE}/Monster5.ogg`,
    `${ROAR_BASE}/Gundam.mp3`,
    `${ROAR_BASE}/Spook.mp3`,
    `${ROAR_BASE}/Pollen.ogg`,
    `${ROAR_BASE}/Unsheathe.wav`,

    // ── battle-end summary UI ───────────────────────────────────────────────
    `${FORGE_BASE}/Sound/System_Tick.mp3`,
    `${FORGE_BASE}/Sound/Soundboard/SE_SYS_Upgrade_New_success2.ogg`,
    `${ICON_BASE}/GP.png`,

    // ── reaction-protectFeedback ────────────────────────────────────────────
    "modules/JB2A_DnD5e/Library/Generic/Conditions/Boon01/ConditionBoon01_012_Green_600x600.webm",
    `${FORGE_BASE}/Sound/Shield2.wav`,

    // ── turn-ui-manager ─────────────────────────────────────────────────────
    `${FORGE_BASE}/Sound/switch_mode.wav`,

    // ── main.js / dialog-system cursor (everywhere, including combat UI) ────
    `${FORGE_BASE}/Sound/Soundboard/Cursor1.ogg`,
  ]);

  // ============================================================================
  // Internal state
  // ============================================================================

  const visualCache = new Map();
  const audioCache = new Map();
  const failed = new Map();

  const combatPreloadStarted = new Set();
  const manifestSeen = new Set();
  let staticManifestPreloaded = false;

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

  // ============================================================================
  // Preload curtain overlay
  // ----------------------------------------------------------------------------
  // Single fixed-position div that we use as a curtain — either as a "raise
  // instantly + drop with fade" pair (the BattleInit pipeline uses this:
  // Battle Transition raises, Preload Assets drops) or as the implicit
  // fade-in/fade-out used by `prepareUrlsAcrossClients({ fadeOverlay })`.
  //
  // Same GPU-friendly pattern as screen-transition.js:
  //   - `will-change: opacity` promotes to its own compositor layer so the
  //     opacity tween runs entirely on the GPU (no per-frame paint).
  //   - `forceReflow()` synchronously commits the initial state so the
  //     subsequent opacity change actually transitions (instead of being
  //     batched into a single paint).
  //   - `transitionend` fires the cleanup; a fallback timer guards against
  //     the event not firing (e.g. element detached, target opacity already
  //     matches).
  //
  // Important positioning rules:
  //   - Color is BLACK so the curtain visually continues the existing
  //     screen-transition.js black fade (no jarring color change between the
  //     two overlays during scene transition).
  //   - z-index is 25 — ABOVE the canvas (z 0) but BELOW Foundry's UI
  //     panels (sidebar, hotbar, navigation, controls all sit at z 30+).
  //     Net effect: the curtain covers the scene visually, but the UI
  //     remains visible and clickable. We deliberately do NOT use
  //     z-index 99999 (that's screen-transition.js, full-screen blackout).
  //   - `pointer-events: all` when raised — blocks clicks on the canvas
  //     underneath; UI panels are above in z-stack so their clicks pass
  //     through normally.
  // ============================================================================

  const FADE_OVERLAY_ID = "oni-anim-cache-preload-fade";
  const FADE_DEFAULTS = Object.freeze({
    color: "#000000",
    fadeInMs: 250,
    fadeOutMs: 600,
    maxHoldMs: 30000,  // failsafe: auto-drop if the release message never arrives
    zIndex: 25         // above canvas (0), below UI panels (≥30)
  });

  let fadeMaxHoldTimer = null;

  function buildFadeOverlay() {
    let el = document.getElementById(FADE_OVERLAY_ID);
    if (el) return el;

    el = document.createElement("div");
    el.id = FADE_OVERLAY_ID;
    Object.assign(el.style, {
      position:      "fixed",
      inset:         "0",
      zIndex:        String(FADE_DEFAULTS.zIndex),
      background:    FADE_DEFAULTS.color,
      opacity:       "0",
      pointerEvents: "none",
      willChange:    "opacity"
    });
    document.body.appendChild(el);
    return el;
  }

  function forceFadeReflow(el) { void el.offsetHeight; }

  function clearFadeMaxHold() {
    if (fadeMaxHoldTimer) {
      clearTimeout(fadeMaxHoldTimer);
      fadeMaxHoldTimer = null;
    }
  }

  async function fadePreloadIn(options = {}) {
    const fadeInMs = Number(options.fadeInMs ?? FADE_DEFAULTS.fadeInMs);
    const maxHoldMs = Number(options.maxHoldMs ?? FADE_DEFAULTS.maxHoldMs);
    const color = String(options.color ?? FADE_DEFAULTS.color);

    const el = buildFadeOverlay();
    el.style.background = color;

    // Cancel any in-flight transition so we can drive from a known starting
    // state. Set opacity to current computed value to avoid a jump.
    el.style.transition = "none";
    forceFadeReflow(el);

    el.style.transition = `opacity ${fadeInMs}ms ease-in-out`;
    el.style.pointerEvents = "all";
    forceFadeReflow(el);
    el.style.opacity = "1";

    // Failsafe: if no release message arrives within maxHoldMs, drop the
    // curtain automatically so the user is never stranded behind white.
    clearFadeMaxHold();
    fadeMaxHoldTimer = setTimeout(() => {
      warn(`fade curtain auto-released after ${maxHoldMs}ms (no release received)`);
      fadePreloadOut({ fadeOutMs: FADE_DEFAULTS.fadeOutMs }).catch(() => {});
    }, Math.max(1000, maxHoldMs));

    await new Promise(resolve => {
      const fallback = setTimeout(resolve, fadeInMs + 50);
      el.addEventListener("transitionend", () => {
        clearTimeout(fallback);
        resolve();
      }, { once: true });
    });
  }

  async function fadePreloadOut(options = {}) {
    clearFadeMaxHold();

    const el = document.getElementById(FADE_OVERLAY_ID);
    if (!el) return;
    const fadeOutMs = Number(options.fadeOutMs ?? FADE_DEFAULTS.fadeOutMs);

    el.style.transition = `opacity ${fadeOutMs}ms ease-in-out`;
    forceFadeReflow(el);
    el.style.opacity = "0";

    await new Promise(resolve => {
      const cleanup = () => {
        el.style.pointerEvents = "none";
        resolve();
      };
      const fallback = setTimeout(cleanup, fadeOutMs + 100);
      el.addEventListener("transitionend", () => {
        clearTimeout(fallback);
        cleanup();
      }, { once: true });
    });
  }

  // --------------------------------------------------------------------------
  // raiseCurtain / dropCurtain — explicit (vs. the fadePreloadIn/Out variants
  // wired implicitly into prepareUrlsAcrossClients). Used by the BattleInit
  // pipeline so the Battle Transition step can raise the curtain BEFORE the
  // scene activate, and the Preload Assets step can drop it AFTER everything
  // is loaded. Spawner / Layout run entirely behind the curtain.
  //
  // `broadcast: true` emits a socket message so every connected client
  // raises/drops in sync. Defaults: instant raise (matches the moment
  // screen-transition.js's own black overlay is at opacity 1), gentle drop.
  // --------------------------------------------------------------------------

  async function raiseCurtain(options = {}) {
    const color = String(options.color ?? FADE_DEFAULTS.color);
    const durationMs = Number(options.durationMs ?? 0);  // instant by default
    const maxHoldMs = Number(options.maxHoldMs ?? FADE_DEFAULTS.maxHoldMs);

    const el = buildFadeOverlay();
    el.style.background = color;
    el.style.transition = durationMs > 0 ? `opacity ${durationMs}ms ease-in-out` : "none";
    el.style.pointerEvents = "all";
    forceFadeReflow(el);
    el.style.opacity = "1";

    // Failsafe drop if nothing eventually calls dropCurtain.
    clearFadeMaxHold();
    fadeMaxHoldTimer = setTimeout(() => {
      warn(`curtain auto-dropped after ${maxHoldMs}ms (no explicit drop received)`);
      dropCurtain({ fadeOutMs: FADE_DEFAULTS.fadeOutMs }).catch(() => {});
    }, Math.max(1000, maxHoldMs));

    if (options.broadcast && game.user?.isGM) {
      try {
        game.socket?.emit?.(SOCKET_NS, {
          type: MSG_CURTAIN_RAISE,
          color,
          durationMs,
          maxHoldMs,
          senderUserId: game.userId ?? null,
          sentAt: now()
        });
        log("broadcast curtain raise", { color, durationMs });
      } catch (e) {
        err("curtain raise broadcast failed", e);
      }
    }

    if (durationMs > 0) {
      await new Promise(resolve => {
        const fallback = setTimeout(resolve, durationMs + 50);
        el.addEventListener("transitionend", () => {
          clearTimeout(fallback);
          resolve();
        }, { once: true });
      });
    }
  }

  async function dropCurtain(options = {}) {
    clearFadeMaxHold();

    const fadeOutMs = Number(options.fadeOutMs ?? FADE_DEFAULTS.fadeOutMs);

    if (options.broadcast && game.user?.isGM) {
      try {
        game.socket?.emit?.(SOCKET_NS, {
          type: MSG_CURTAIN_DROP,
          fadeOutMs,
          senderUserId: game.userId ?? null,
          sentAt: now()
        });
        log("broadcast curtain drop", { fadeOutMs });
      } catch (e) {
        err("curtain drop broadcast failed", e);
      }
    }

    await fadePreloadOut({ fadeOutMs });
  }

  async function onSocketCurtainRaise(msg) {
    try {
      const sender = game.users?.get?.(msg.senderUserId);
      if (!sender?.isGM) {
        warn("ignored curtain-raise from non-GM sender", { senderUserId: msg.senderUserId });
        return;
      }
      log("received curtain-raise", { from: sender.name, color: msg.color, durationMs: msg.durationMs });
      // Local raise only (broadcast: false) — we ARE the recipient of the broadcast.
      await raiseCurtain({
        color: msg.color,
        durationMs: msg.durationMs,
        maxHoldMs: msg.maxHoldMs,
        broadcast: false
      });
    } catch (e) {
      err("onSocketCurtainRaise failed", e);
    }
  }

  async function onSocketCurtainDrop(msg) {
    try {
      const sender = game.users?.get?.(msg.senderUserId);
      if (!sender?.isGM) {
        warn("ignored curtain-drop from non-GM sender", { senderUserId: msg.senderUserId });
        return;
      }
      log("received curtain-drop", { from: sender.name, fadeOutMs: msg.fadeOutMs });
      await dropCurtain({ fadeOutMs: msg.fadeOutMs, broadcast: false });
    } catch (e) {
      err("onSocketCurtainDrop failed", e);
    }
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

    // Seed with the JS-hardcoded battle manifest so it survives deleteCombat's
    // releaseSoft (which clears visualCache/audioCache) and gets re-preloaded
    // on every combatStart alongside the per-combatant scan.
    for (const url of STATIC_BATTLE_URLS) urls.add(url);

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
      // Step 1: warm the browser HTTP cache deterministically.
      //
      // The previous approach used `<audio>.load()`, which the browser is free
      // to defer or partially fulfill — the first real `play()` could still pay
      // a network round-trip. A plain `fetch()` forces a full GET, and the
      // response is stored in the HTTP cache (subject to the server's
      // Cache-Control headers — Forge CDN sends sensible ones).
      //
      // `mode: 'no-cors'` is required because Forge CDN doesn't send CORS
      // headers; the response is opaque to JS, but it IS cached by the browser
      // and that's all we need.
      let httpWarmed = false;
      try {
        const res = await fetch(cleanUrl, { mode: "no-cors", cache: "default" });
        // For an opaque (no-cors) response we can't read the body, but draining
        // it forces the browser to actually download + cache it. For a CORS
        // response we still drain to be safe.
        try { await res.blob(); } catch (_) {}
        httpWarmed = true;
      } catch (fetchErr) {
        log("audio HTTP warm-up failed (non-fatal)", {
          url: cleanUrl,
          error: String(fetchErr?.message ?? fetchErr)
        });
      }

      // Step 2: ask Foundry's audio layer to decode the buffer. In v12 this
      // returns a Sound/AudioContainer that's ready to play() without further
      // network or decode work.
      const helper =
        foundry?.audio?.AudioHelper ??
        globalThis.AudioHelper ??
        null;

      if (helper?.preload) {
        try {
          await helper.preload(cleanUrl);
        } catch (helperErr) {
          log("AudioHelper.preload failed (HTTP cache still warm)", {
            url: cleanUrl,
            error: String(helperErr?.message ?? helperErr)
          });
        }
      }

      audioCache.set(key, {
        url: cleanUrl,
        key,
        httpWarmed,
        loadedAt: now(),
        reason: options.reason ?? null
      });

      log("audio preloaded", { url: cleanUrl, key, httpWarmed });
      return { ok: true, type: "audio", url: cleanUrl, key, httpWarmed };
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
      type: MSG_PRELOAD_MANIFEST,
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
      if (!msg) return;
      if (msg.type === MSG_COMBAT_PREPARE) {
        await onSocketCombatPrepare(msg);
        return;
      }
      if (msg.type === MSG_COMBAT_PREPARE_ACK) {
        onSocketCombatPrepareAck(msg);
        return;
      }
      if (msg.type === MSG_COMBAT_PREPARE_RELEASE) {
        await onSocketCombatPrepareRelease(msg);
        return;
      }
      if (msg.type === MSG_CURTAIN_RAISE) {
        await onSocketCurtainRaise(msg);
        return;
      }
      if (msg.type === MSG_CURTAIN_DROP) {
        await onSocketCurtainDrop(msg);
        return;
      }
      if (msg.type !== MSG_PRELOAD_MANIFEST) return;

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

  // ============================================================================
  // Combat-prepare protocol: GM waits for every active non-GM client to
  // socket-ack that its local preload is complete before the doc update fires.
  // ----------------------------------------------------------------------------
  // Flow:
  //   1. GM clicks "Start Combat" → wrapped startCombat calls
  //      prepareCombatAcrossClients(combat).
  //   2. GM scans the combat, broadcasts MSG_COMBAT_PREPARE with sessionId +
  //      asset URL manifest, and starts its own local preload.
  //   3. Each player receives MSG_COMBAT_PREPARE, runs preloadMany on the URLs,
  //      then emits MSG_COMBAT_PREPARE_ACK back.
  //   4. GM collects ACKs (deduped by userId). Resolves when every active
  //      non-GM has ACK'd, OR when CFG.combatPrepareTimeoutMs elapses.
  //   5. Wrapped startCombat awaits this, then calls the original startCombat.
  //      The doc update — and thus combatStart on every client — only happens
  //      after every client (or all that responded in time) is ready.
  // ============================================================================

  // GM-side: sessionId → { expectedUserIds, ackedUserIds, resolve, timeoutHandle }
  const pendingPrepareSessions = new Map();

  function newSessionId(combatId) {
    return `prep:${combatId ?? "no-combat"}:${game.userId ?? "no-user"}:${now()}:${Math.random().toString(36).slice(2, 8)}`;
  }

  function expectedAckUserIds() {
    // Every active user that is NOT the local (GM) client.
    return new Set(
      Array.from(game.users ?? [])
        .filter(u => u.active && u.id !== game.userId)
        .map(u => u.id)
    );
  }

  async function onSocketCombatPrepare(msg) {
    // Player-side: a GM has asked us to preload BEFORE combat starts. Fade in
    // (if the GM asked for it), do the preload, ACK, then wait for the
    // explicit release message to drop the curtain in sync with everyone else.
    try {
      const sender = game.users?.get?.(msg.senderUserId);
      if (!sender?.isGM) {
        warn("ignored combat-prepare from non-GM sender", {
          senderUserId: msg.senderUserId,
          senderUserName: msg.senderUserName
        });
        return;
      }

      log("received combat-prepare", {
        sessionId: msg.sessionId,
        combatId: msg.combatId ?? null,
        urls: Array.isArray(msg.urls) ? msg.urls.length : 0,
        sender: sender.name,
        fade: !!msg.fadeOverlay
      });

      const fadeRequested = !!msg.fadeOverlay;
      const fadeConfig = (fadeRequested && typeof msg.fadeOverlay === "object")
        ? msg.fadeOverlay
        : null;

      // Raise the curtain BEFORE the preload so decode hitches are hidden.
      if (fadeRequested) {
        try { await fadePreloadIn(fadeConfig ?? {}); }
        catch (e) { warn("player fadePreloadIn failed (non-fatal)", e); }
      }

      ui.notifications?.info?.("Preparing battle assets…");

      const startedAt = now();
      const summary = await preloadMany(msg.urls ?? [], {
        reason: "combat-prepare-player",
        combatId: msg.combatId ?? null
      });

      // ACK back to all clients (GM listens; everyone else ignores).
      const ack = {
        type: MSG_COMBAT_PREPARE_ACK,
        sessionId: msg.sessionId,
        combatId: msg.combatId ?? null,
        senderUserId: game.userId ?? null,
        senderUserName: game.user?.name ?? null,
        loadedOrCached: summary?.loadedOrCached ?? 0,
        failed: summary?.failed ?? 0,
        ms: summary?.ms ?? (now() - startedAt),
        sentAt: now()
      };

      try {
        game.socket?.emit?.(SOCKET_NS, ack);
        log("sent combat-prepare ack", ack);
      } catch (e) {
        err("ack emit failed", e);
      }

      // Note: we deliberately do NOT fade out here. The curtain stays up
      // until MSG_COMBAT_PREPARE_RELEASE arrives, so every client drops it
      // together (and the entrance animation can fire without any client
      // seeing the scene early). The failsafe timer inside fadePreloadIn
      // drops the curtain if the release message never arrives.
    } catch (e) {
      err("onSocketCombatPrepare failed", e);
    }
  }

  async function onSocketCombatPrepareRelease(msg) {
    // Player-side: GM has signaled that every client (or the timeout) is done.
    // Drop the curtain.
    try {
      const sender = game.users?.get?.(msg.senderUserId);
      if (!sender?.isGM) {
        warn("ignored combat-prepare-release from non-GM sender", {
          senderUserId: msg.senderUserId
        });
        return;
      }

      log("received combat-prepare-release", {
        sessionId: msg.sessionId,
        combatId: msg.combatId ?? null,
        sender: sender.name
      });

      if (msg.fadeOverlay) {
        const fadeConfig = (typeof msg.fadeOverlay === "object")
          ? msg.fadeOverlay
          : {};
        try { await fadePreloadOut(fadeConfig); }
        catch (e) { warn("player fadePreloadOut failed (non-fatal)", e); }
      }
    } catch (e) {
      err("onSocketCombatPrepareRelease failed", e);
    }
  }

  function onSocketCombatPrepareAck(msg) {
    // GM-side: a player has finished preloading.
    const session = pendingPrepareSessions.get(msg.sessionId);
    if (!session) {
      // Late ack (after timeout) or wrong session — drop silently.
      log("dropped combat-prepare-ack for unknown session", {
        sessionId: msg.sessionId,
        from: msg.senderUserName
      });
      return;
    }

    if (!session.expectedUserIds.has(msg.senderUserId)) {
      // Ack from a user who isn't in our expected set (joined late, GM, etc.).
      log("ignored ack from non-expected user", {
        sessionId: msg.sessionId,
        from: msg.senderUserName
      });
      return;
    }

    session.ackedUserIds.add(msg.senderUserId);

    log("received combat-prepare-ack", {
      sessionId: msg.sessionId,
      from: msg.senderUserName,
      acked: session.ackedUserIds.size,
      expected: session.expectedUserIds.size,
      ms: msg.ms,
      loadedOrCached: msg.loadedOrCached
    });

    const allAcked = [...session.expectedUserIds].every(id => session.ackedUserIds.has(id));
    if (allAcked) {
      clearTimeout(session.timeoutHandle);
      pendingPrepareSessions.delete(msg.sessionId);
      session.resolve({
        ok: true,
        sessionId: msg.sessionId,
        ackedUserIds: [...session.ackedUserIds],
        timedOut: false
      });
    }
  }

  // Low-level: broadcast a URL list, run local preload, wait for player ACKs.
  // Used by both `prepareCombatAcrossClients` (Combat-doc driven) and the
  // BattleInit "Preload Assets" pipeline step (token-doc driven, fired before
  // the Combat doc exists).
  //
  // Pass `options.fadeOverlay = true` (or a config object) to raise a white
  // curtain on every client while preload runs. Players receive the same hint
  // in the broadcast and mirror the fade locally; the GM emits an explicit
  // release message at the end so all clients drop the curtain together.
  async function prepareUrlsAcrossClients(urls, options = {}) {
    if (!game.user?.isGM) {
      // Defensive: only GMs initiate. Players run preload via the socket message.
      return { ok: false, reason: "not-gm" };
    }

    const dedupedUrls = uniqueStrings(urls);
    const labelHint = String(options.label ?? options.combatId ?? "manual");
    const reason = String(options.reason ?? "urls-prepare-gm");
    const combatId = options.combatId ?? null;

    const fadeRequested = !!options.fadeOverlay;
    const fadeConfig = (fadeRequested && typeof options.fadeOverlay === "object")
      ? options.fadeOverlay
      : null;

    const sessionId = newSessionId(labelHint);
    const expectedUserIds = expectedAckUserIds();

    log("prepare start", {
      sessionId,
      label: labelHint,
      combatId,
      urlCount: dedupedUrls.length,
      expectedPlayers: [...expectedUserIds],
      fade: fadeRequested
    });

    // Fire-and-forget broadcast FIRST so player clients start their fade-in
    // at roughly the same wall-clock moment as the GM. Socket latency
    // (typically < 50ms) is well inside the fade-in duration (250ms default).
    try {
      game.socket?.emit?.(SOCKET_NS, {
        type: MSG_COMBAT_PREPARE,
        sessionId,
        combatId,
        urls: dedupedUrls,
        fadeOverlay: fadeRequested ? (fadeConfig ?? true) : false,
        senderUserId: game.userId ?? null,
        senderUserName: game.user?.name ?? null,
        sentAt: now()
      });
    } catch (e) {
      err("prepare broadcast failed", e);
    }

    // Start the GM-local fade-in in parallel with the broadcast. We must
    // await it BEFORE starting the local preload, so any decode hitches
    // happen behind a fully-opaque curtain.
    if (fadeRequested) {
      try { await fadePreloadIn(fadeConfig ?? {}); }
      catch (e) { warn("fadePreloadIn failed (non-fatal)", e); }
    }

    // Helper: broadcast release + fade GM out. Used in every exit path below
    // so we never strand players (or the GM) behind a white curtain.
    const releaseAndFadeOut = async () => {
      try {
        game.socket?.emit?.(SOCKET_NS, {
          type: MSG_COMBAT_PREPARE_RELEASE,
          sessionId,
          combatId,
          fadeOverlay: fadeRequested ? (fadeConfig ?? true) : false,
          senderUserId: game.userId ?? null,
          sentAt: now()
        });
      } catch (e) {
        err("prepare release broadcast failed", e);
      }
      if (fadeRequested) {
        try { await fadePreloadOut(fadeConfig ?? {}); }
        catch (e) { warn("fadePreloadOut failed (non-fatal)", e); }
      }
    };

    // try/finally guarantees releaseAndFadeOut runs even if something throws
    // mid-flow (rare — preloadMany swallows its own errors and ackPromise
    // always resolves via the timeout — but defensive).
    try {
      // Local GM preload — happens AFTER the curtain is up, so first-load
      // decode hitches are hidden.
      const localPreloadPromise = preloadMany(dedupedUrls, {
        reason,
        combatId
      });

      // No active non-GM clients → no ACKs to wait for.
      if (expectedUserIds.size === 0) {
        const summary = await localPreloadPromise;
        log("prepare done (no players)", { sessionId, summary });
        return { ok: true, sessionId, summary, ackedUserIds: [], localOnly: true };
      }

      // Set up the ACK collector. NOTE: we set this up AFTER the broadcast —
      // that is safe because the broadcast hasn't started a round-trip yet
      // (the local fade-in took ~250ms before this point, plenty of time for
      // the ACK handler to be ready). A fast player ACK won't be missed
      // because the socket loop is single-threaded in JS.
      let resolveAll;
      const ackPromise = new Promise(resolve => { resolveAll = resolve; });

      const session = {
        expectedUserIds,
        ackedUserIds: new Set(),
        resolve: resolveAll,
        timeoutHandle: null,
        startedAt: now()
      };
      pendingPrepareSessions.set(sessionId, session);

      session.timeoutHandle = setTimeout(() => {
        const still = pendingPrepareSessions.get(sessionId);
        if (!still) return;
        const missing = [...still.expectedUserIds].filter(id => !still.ackedUserIds.has(id));
        const missingNames = missing.map(id => game.users?.get?.(id)?.name ?? id);
        warn("prepare timed out — proceeding without acks from:", missingNames);
        pendingPrepareSessions.delete(sessionId);
        still.resolve({
          ok: true,
          sessionId,
          ackedUserIds: [...still.ackedUserIds],
          timedOut: true,
          missing,
          missingNames
        });
      }, Math.max(500, Number(CFG.combatPrepareTimeoutMs) || 8000));

      // Wait for both the player ACKs (or timeout) AND the local GM preload.
      const [ackResult, localSummary] = await Promise.all([
        ackPromise,
        localPreloadPromise
      ]);

      log("prepare done", {
        sessionId,
        label: labelHint,
        acked: ackResult.ackedUserIds.length,
        expected: expectedUserIds.size,
        timedOut: !!ackResult.timedOut,
        missing: ackResult.missingNames ?? [],
        localLoaded: localSummary?.loadedOrCached ?? 0
      });

      return { ...ackResult, localSummary };
    } finally {
      await releaseAndFadeOut();
    }
  }

  async function prepareCombatAcrossClients(combat) {
    if (!combat) return { ok: false, reason: "no-combat" };

    // Build manifest from the existing combatant scan (already seeds with
    // STATIC_BATTLE_URLS) — one source of truth for what gets preloaded.
    const scan = scanCombatAssets(combat);
    return await prepareUrlsAcrossClients(scan.urls, {
      label: `combat:${combat.id}`,
      reason: "combat-prepare-gm",
      combatId: combat.id
    });
  }

  async function preloadStaticBattle(options = {}) {
    if (staticManifestPreloaded && !options.force) {
      return { ok: true, skipped: true, reason: "already-preloaded" };
    }
    staticManifestPreloaded = true;

    return await preloadMany(STATIC_BATTLE_URLS, {
      reason: "static-battle-manifest",
      maxAssets: STATIC_BATTLE_URLS.length
    });
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
  // Combat.startCombat monkey-patch — defers the original (and therefore the
  // `combatStart` hook + the doc update that propagates to players) until the
  // combat-prepare protocol has resolved.
  // ============================================================================

  function getCombatClass() {
    // Prefer CONFIG.Combat.documentClass — a system (or another module) may
    // subclass Combat and register the subclass there. The global `Combat`
    // remains the base class.
    return (
      globalThis.CONFIG?.Combat?.documentClass ??
      globalThis.Combat ??
      null
    );
  }

  function installStartCombatGate() {
    if (!CFG.gateCombatStartOnPreload) {
      log("combat-start gate disabled by CFG.gateCombatStartOnPreload");
      return false;
    }

    const Klass = getCombatClass();
    if (!Klass?.prototype?.startCombat) {
      warn("Combat.prototype.startCombat not found — gate not installed");
      return false;
    }

    if (Klass.prototype.__oniAnimCacheGated) {
      log("combat-start gate already installed");
      return true;
    }

    const originalStartCombat = Klass.prototype.startCombat;

    Klass.prototype.startCombat = async function gatedStartCombat(...args) {
      // Only the GM client actually calls startCombat in Foundry. Players
      // never reach this method — they receive the started=true doc update
      // over the socket and pre-load via the MSG_COMBAT_PREPARE handler that
      // we sent from this very method.
      if (!game.user?.isGM) {
        return originalStartCombat.apply(this, args);
      }

      try {
        ui.notifications?.info?.("Preparing battle assets…");

        // Ensure the static manifest finished its ready-time warm-up before we
        // build the combat scan (the scan seeds itself from STATIC_BATTLE_URLS,
        // but we want the GM's own buffers warm too).
        await preloadStaticBattle().catch((e) => {
          warn("preloadStaticBattle during startCombat failed (non-fatal)", e);
        });

        const result = await prepareCombatAcrossClients(this);

        if (result?.timedOut) {
          ui.notifications?.warn?.(
            `Some clients didn't finish preloading in time (${(result.missingNames ?? []).join(", ")}). Starting anyway.`
          );
        }
      } catch (e) {
        warn("startCombat gate failed; proceeding to original anyway", e);
      }

      return originalStartCombat.apply(this, args);
    };

    Klass.prototype.__oniAnimCacheGated = true;
    log("combat-start gate installed on Combat.prototype.startCombat");
    return true;
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
    staticManifestPreloaded = false;

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
      preloadStaticBattle,

      // Combat-prepare protocol (GM gates startCombat on every-client preload)
      prepareCombatAcrossClients,
      prepareUrlsAcrossClients,
      installStartCombatGate,

      // Curtain control (black overlay over scene; UI panels stay visible)
      // - raiseCurtain / dropCurtain: explicit, broadcast-capable. Use these
      //   from the BattleInit pipeline (Battle Transition raises, Preload
      //   Assets drops) so the curtain spans transition + spawner + preload.
      // - fadePreloadIn / fadePreloadOut: implicit fade used by
      //   prepareUrlsAcrossClients({ fadeOverlay: true }). Kept for standalone
      //   prepare-protocol calls where there's no surrounding pipeline.
      raiseCurtain,
      dropCurtain,
      fadePreloadIn,
      fadePreloadOut,

      // Static manifest (read-only view)
      STATIC_BATTLE_URLS,

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

  Hooks.once("ready", async () => {
    if (!apiReady) exposeApi();

    try {
      game.socket?.on?.(SOCKET_NS, onSocketMessage);
      log("socket listener ready", SOCKET_NS);
    } catch (e) {
      warn("socket listener setup failed", e);
    }

    // Install the combat-start gate. Every active GM client runs this; only
    // the one that actually clicks "Start Combat" will invoke the wrapper.
    try {
      installStartCombatGate();
    } catch (e) {
      err("installStartCombatGate failed", e);
    }

    // If the script was loaded after combat had already started, allow manual call:
    // FUCompanion.api.animationCache.preloadCombat()
    log("ready", {
      isGM: !!game.user?.isGM,
      isPrimaryGM: isPrimaryActiveGMClient(),
      preloadOnCombatStart: CFG.preloadOnCombatStart,
      preloadStaticOnReady: CFG.preloadStaticOnReady,
      gateCombatStartOnPreload: CFG.gateCombatStartOnPreload,
      combatPrepareTimeoutMs: CFG.combatPrepareTimeoutMs,
      staticManifestSize: STATIC_BATTLE_URLS.length
    });

    // Warm the hardcoded battle SFX/VFX manifest at world load so the first
    // hit-sound / first roll SFX / first reaction VFX doesn't pay a network
    // round-trip mid-combat. Cheap when the browser HTTP cache is already warm.
    if (CFG.preloadStaticOnReady) {
      try {
        await preloadStaticBattle();
      } catch (e) {
        err("preloadStaticBattle on ready failed", e);
      }
    }

    // ------------------------------------------------------------------------
    // Player-reload / late-join recovery
    // ------------------------------------------------------------------------
    // `combatStart` only fires inside the GM's `Combat#startCombat()` call
    // (Foundry v12 source). A player whose client comes online AFTER the
    // combat was already started never sees that hook — they'd have to wait
    // for the next combat update (round/turn advance) to hit the
    // `updateCombat` fallback below, which can be many seconds away.
    //
    // BattleInit's "Preload Assets" pipeline step is also unreachable for a
    // reloaded player: it broadcasts MSG_COMBAT_PREPARE once, and a client
    // that wasn't connected at that moment misses the broadcast entirely.
    //
    // Run the per-combat scan now for every in-flight combat so the rejoined
    // client has warm token / item / animation-script caches immediately.
    // `combatPreloadStarted` provides idempotency: this is a no-op if the
    // same combat was already covered earlier in the session.
    try {
      const inFlight = Array.from(game.combats ?? []).filter(c => c?.started);
      if (inFlight.length) {
        log("rejoin recovery: preloading in-flight combats", {
          count: inFlight.length,
          combatIds: inFlight.map(c => c.id)
        });
        for (const c of inFlight) {
          try {
            await preloadCombat(c, { source: "ready-rejoin" });
          } catch (e) {
            err("ready-rejoin preload failed for combat", c?.id, e);
          }
        }
      }
    } catch (e) {
      err("rejoin recovery sweep failed", e);
    }
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