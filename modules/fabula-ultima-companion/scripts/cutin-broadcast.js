// ─────────────────────────────────────────────────────────────
//  FU Portrait Cut-In • Broadcaster (Cache-Keys Only) (V12)
//  • Sends imgKey/sfxKey + shared t0/expiry + visual params
//  • Assumes receiver has preloaded assets at combat start
//  • UPDATE: Critical-only portraitOffsetY from actor.system.props.cut_in_offset_y
// ─────────────────────────────────────────────────────────────
(() => {
  const MODULE_ID    = "fabula-ultima-companion";
  const ACTION_KEY   = "FU_CUTIN_PLAY";
  const NS           = "FUCompanion";
  const DEBOUNCE_KEY = "__FU_CUTIN_LAST_EMIT";
  const DEBOUNCE_MS  = 600;

  const DEFAULTS = {
    delayMs: 900,
    dimAlpha: 0.6, dimFadeMs: 200,
    flashPeak: 0.9, flashInMs: 70, flashOutMs: 180, flashDelayMs: 60,
    slideInMs: 650, holdMs: 900, slideOutMs: 650,
    portraitHeightRatio: 0.9, portraitBottomMargin: 40, portraitInsetX: 220,
    sfxVol: 0.9,
    ttlMs: 3000
  };

  // Build cache keys — must match receiver’s preloading scheme
  function imgKeyFor(anyUuid, type) {
    // Accept either a Token UUID or an Actor UUID.
    // We will resolve to an Actor and return:  cutin:<actorId>:<type>
    try {
      const doc = fromUuidSync?.(anyUuid);
      if (!doc) return null;

      // Token → Actor
      if (doc.documentName === "Token" || doc.isToken) {
        const actor = doc.actor ?? doc.document?.actor ?? null;
        const actorId = actor?.id ?? null;
        return actorId ? `cutin:${actorId}:${type}` : null;
      }

      // Actor directly
      if (doc.documentName === "Actor" || doc.constructor?.name === "Actor") {
        const actorId = doc.id ?? null;
        return actorId ? `cutin:${actorId}:${type}` : null;
      }

      // Some UUID variants still expose .actor
      const actorId = doc.actor?.id ?? doc.document?.actor?.id ?? null;
      return actorId ? `cutin:${actorId}:${type}` : null;
    } catch {
      return null;
    }
  }

  function sfxKeyFor(type) {
    return `sfx:${type}`;
  }

  function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }

  // Resolve actor from a Token UUID or Actor UUID
  function actorFromUuid(anyUuid) {
    try {
      const doc = fromUuidSync?.(anyUuid);
      if (!doc) return null;

      // Token → Actor
      if (doc.documentName === "Token" || doc.isToken) {
        return doc.actor ?? doc.document?.actor ?? null;
      }

      // Actor directly
      if (doc.documentName === "Actor" || doc.constructor?.name === "Actor") {
        return doc;
      }

      return doc.actor ?? doc.document?.actor ?? null;
    } catch {
      return null;
    }
  }

  async function cutinBroadcast({
    tokenUuid,
    type,                 // "critical" | "zero_power" | "fumble"
    // optional visual overrides:
    delayMs, dimAlpha, dimFadeMs,
    flashPeak, flashInMs, flashOutMs, flashDelayMs,
    slideInMs, holdMs, slideOutMs,
    portraitHeightRatio, portraitBottomMargin, portraitInsetX,
    sfxVol,
    ttlMs
  } = {}) {
    // Debounce
    const now  = Date.now();
    const last = window[DEBOUNCE_KEY] ?? 0;
    if (now - last < DEBOUNCE_MS) {
      ui.notifications.warn("Cut-in already queued—please wait a moment.");
      return;
    }
    window[DEBOUNCE_KEY] = now;

    // socketlib
    const sockMod = game.modules.get("socketlib");
    if (!sockMod?.active || !window.socketlib) {
      ui.notifications.error("FU Cut-In: socketlib not found/active.");
      return;
    }
    const socket = socketlib.registerModule(MODULE_ID);

    // Resolve cache keys (no URLs)
    const imgKey = tokenUuid && type ? imgKeyFor(tokenUuid, type) : null;
    const sfxKey = type ? sfxKeyFor(type) : null;

    // Validate numbers
    const v = {
      delayMs:              num(delayMs,              DEFAULTS.delayMs),
      dimAlpha:             num(dimAlpha,             DEFAULTS.dimAlpha),
      dimFadeMs:            num(dimFadeMs,            DEFAULTS.dimFadeMs),
      flashPeak:            num(flashPeak,            DEFAULTS.flashPeak),
      flashInMs:            num(flashInMs,            DEFAULTS.flashInMs),
      flashOutMs:           num(flashOutMs,           DEFAULTS.flashOutMs),
      flashDelayMs:         num(flashDelayMs,         DEFAULTS.flashDelayMs),
      slideInMs:            num(slideInMs,            DEFAULTS.slideInMs),
      holdMs:               num(holdMs,               DEFAULTS.holdMs),
      slideOutMs:           num(slideOutMs,           DEFAULTS.slideOutMs),
      portraitHeightRatio:  num(portraitHeightRatio,  DEFAULTS.portraitHeightRatio),
      portraitBottomMargin: num(portraitBottomMargin, DEFAULTS.portraitBottomMargin),
      portraitInsetX:       num(portraitInsetX,       DEFAULTS.portraitInsetX),
      sfxVol:               num(sfxVol,               DEFAULTS.sfxVol),
      ttlMs:                num(ttlMs,                DEFAULTS.ttlMs)
    };

    // Critical-only: read offset from actor template field
    let portraitOffsetY = 0;
    if (type === "critical" && tokenUuid) {
      const actor = actorFromUuid(tokenUuid);
      const raw = actor?.system?.props?.cut_in_offset_y;
      portraitOffsetY = num(raw, 0);
    }

    // Shared start & expiry
    const t0       = Date.now() + v.delayMs;
    const expireAt = t0 + v.ttlMs;

    const activeUsers = (game.users?.filter(u => u.active) ?? []).map(u => u.id);

    console.log("[FU Cut-In • Broadcast] resolved keys:", { imgKey, sfxKey, type, tokenUuid, portraitOffsetY });

    const payload = {
      t0, expireAt,
      imgKey,           // ← strictly a cache key; receiver will skip if missing
      sfxKey,           // ← strictly a cache key; receiver will skip if missing
      sfxVol: v.sfxVol,

      dimAlpha: v.dimAlpha,
      dimFadeMs: v.dimFadeMs,
      flashPeak: v.flashPeak,
      flashInMs: v.flashInMs,
      flashOutMs: v.flashOutMs,
      flashDelayMs: v.flashDelayMs,

      slideInMs: v.slideInMs,
      holdMs: v.holdMs,
      slideOutMs: v.slideOutMs,

      portraitHeightRatio: v.portraitHeightRatio,
      portraitBottomMargin: v.portraitBottomMargin,
      portraitInsetX: v.portraitInsetX,

      // NEW: receiver uses this to shift finalY (positive => up)
      portraitOffsetY,

      allowedUserIds: activeUsers
    };

    // Dispatch
    if (typeof socket.executeForUsers === "function" && activeUsers.length) {
      await socket.executeForUsers(ACTION_KEY, activeUsers, payload);
    } else {
      await socket.executeForEveryone(ACTION_KEY, payload);
    }

    // Optional local run (helps testing a single client)
    try { window.__FU_CUTIN_PLAY?.(payload); } catch {}

    // Release debounce after the delay
    setTimeout(() => {
      if (window[DEBOUNCE_KEY] === now) window[DEBOUNCE_KEY] = 0;
    }, v.delayMs + 200);

    console.log("[FU Cut-In • Broadcast] payload:", payload);
  }

  // Expose API (same name as before, but now cache-only)
  window[NS] = window[NS] || {};
  window[NS].api = window[NS].api || {};
  window[NS].api.cutinBroadcast = cutinBroadcast;
})();
