/**
 * ActiveEffect Charges — Token Badge (Foundry VTT v12)
 * -----------------------------------------------------------------------------
 * Renders the current charge count as a small numeric badge in the TOP-right
 * corner of each token effect icon whose source ActiveEffect carries
 * flags.fabula-ultima-companion.charges — hidden ONLY when chargesMax === 1 (a
 * pure on/off effect, where a "1" is noise). Shown for max > 1 and for an unset
 * max (unlimited / open-ended count).
 *
 * Storage (matches ActiveEffectManager-charges.js):
 *   flags.fabula-ultima-companion.charges     Number  current count
 *   flags.fabula-ultima-companion.chargesMax  Number? max — badge hidden iff === 1
 *
 * Strategy:
 *   Wrap Token.prototype.drawEffects. After Foundry finishes drawing the
 *   icon sprites, walk token.effects.children, match each sprite back to a
 *   charged AE on the actor (by normalized texture path — same trick the
 *   active-effect-tooltip uses), and attach a PIXI.Text as a child of the
 *   icon sprite. Foundry calls drawEffects whenever effects change, so
 *   badges stay in sync without explicit listeners.
 *
 *   Children inherit their parent sprite's transform, so we measure the
 *   badge in the texture's local pixel space — the badge then scales
 *   naturally with the icon when a token has many effects packed into
 *   small slots.
 *
 *   Pairs with: ActiveEffectManager-charges.js (runtime API).
 */
Hooks.once("ready", () => {
  (() => {
    const TAG = "[ONI][AECharges:Badge]";
    const PATCH_KEY = "__ONI_AE_CHARGES_BADGE_V1__";
    const MODULE_ID = "fabula-ultima-companion";
    const FLAG_CHARGES = "charges";
    const FLAG_CHARGES_MAX = "chargesMax";
    const BADGE_MARKER = "__oniChargeBadge";
    const DEBUG = false;

    if (globalThis[PATCH_KEY]) return;
    globalThis[PATCH_KEY] = true;

    const log  = (...a) => { if (DEBUG) console.log(TAG, ...a); };
    const warn = (...a) => console.warn(TAG, ...a);

    function normalizePath(p) {
      const s = String(p ?? "").replace(/^https?:\/\/[^/]+/i, "").trim();
      // An AE stores img as a RELATIVE path ("icons/foo.webp") but the rendered
      // sprite's texture src is the ABSOLUTE server URL ("/icons/foo.webp", or a
      // full host URL for remote assets). After stripping the host these differ
      // only by a leading slash, so a core/local icon (Grave Points) never
      // matched its sprite while an absolute-URL icon (Forge-hosted Brainwave
      // Clock) did. Drop leading slashes so both forms reduce to the same key.
      return s.replace(/^\/+/, "");
    }

    function extractTexturePath(obj) {
      return (
        obj?.texture?.baseTexture?.resource?.src ??
        obj?.texture?.baseTexture?.resource?.url ??
        obj?.texture?.baseTexture?.cacheId ??
        null
      );
    }

    function getChargeCount(effect) {
      if (!effect) return null;
      let raw;
      try { raw = effect.getFlag?.(MODULE_ID, FLAG_CHARGES); } catch (_e) {}
      if (raw === undefined || raw === null) {
        raw = effect?.flags?.[MODULE_ID]?.[FLAG_CHARGES];
      }
      if (raw === undefined || raw === null || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }

    function getChargeMax(effect) {
      if (!effect) return null;
      let raw;
      try { raw = effect.getFlag?.(MODULE_ID, FLAG_CHARGES_MAX); } catch (_e) {}
      if (raw === undefined || raw === null) {
        raw = effect?.flags?.[MODULE_ID]?.[FLAG_CHARGES_MAX];
      }
      if (raw === undefined || raw === null || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }

    function clearBadge(iconSprite) {
      if (!iconSprite?.children?.length) return;
      const old = iconSprite.children.find(c => c?.[BADGE_MARKER]);
      if (!old) return;
      try { old.destroy?.({ children: true }); }
      catch (_e) { try { iconSprite.removeChild?.(old); } catch (_e2) {} }
    }

    function attachBadge(iconSprite, count, max = null) {
      if (!iconSprite || typeof PIXI === "undefined") return;

      clearBadge(iconSprite);

      // Measure in the texture's *local* pixel space — children inherit
      // the sprite's scale, so the badge will follow the icon's rendered size.
      const tex = iconSprite.texture;
      const localW = tex?.orig?.width ?? tex?.width ?? 64;
      const localH = tex?.orig?.height ?? tex?.height ?? 64;
      if (!localW || !localH) return;

      // Foundry packs effect icons into a small (~20 world-px) grid slot
      // regardless of token size, so sizing the font off the icon's LOCAL
      // texture made the badge scale with the (tiny) slot — unreadable on 1×1
      // tokens carrying a stack of statuses. Instead, target a WORLD size
      // (canvas px) with a legibility floor, then back out the local font size
      // by dividing through the sprite's own scale (the badge is a child of the
      // icon sprite, so it inherits that scale). Result: a badge of consistent
      // on-screen size that still grows with bigger creatures and zooms with
      // the canvas. Tune via WORLD_FLOOR (min world px) and SLOT_FRAC (fraction
      // of the icon slot, which itself scales with token size).
      const WORLD_FLOOR = 13;   // minimum badge height in canvas px
      const SLOT_FRAC   = 0.5;  // badge as a fraction of the icon slot
      const spriteScale = Math.abs(iconSprite.scale?.x || 1) || 1;
      const slotWorld   = Math.min(localW, localH) * spriteScale; // icon on-canvas size
      const targetWorld = Math.max(slotWorld * SLOT_FRAC, WORLD_FLOOR);
      const fontSize = Math.max(12, Math.round(targetWorld / spriteScale));
      const stroke   = Math.max(2, Math.round(fontSize * 0.18));

      // Gold when the charge pool is topped off (count ≥ max); white otherwise.
      // An unset max (unlimited) never reads as "full" → stays white.
      const atMax = (max !== null && Number.isFinite(max) && count >= max);
      const fill  = atMax ? "#ffd23f" : "#ffffff";

      const style = new PIXI.TextStyle({
        fontFamily: "Signika, sans-serif",
        fontSize,
        fontWeight: "bold",
        fill,
        stroke: "#000000",
        strokeThickness: stroke,
        align: "right",
        dropShadow: true,
        dropShadowColor: "#000000",
        dropShadowAlpha: 0.6,
        dropShadowDistance: Math.max(1, Math.round(fontSize * 0.05)),
        dropShadowBlur: 0
      });

      const badge = new PIXI.Text(String(count), style);
      badge[BADGE_MARKER] = true;
      badge.anchor?.set?.(1, 0); // top-right anchor

      // The icon sprite's anchor shifts where (0,0) of its local space sits
      // on the texture. Texture TOP-right in local space is at:
      //   x = (1 - anchor.x) * localW
      //   y = (0 - anchor.y) * localH
      const ax = iconSprite.anchor?.x ?? 0;
      const ay = iconSprite.anchor?.y ?? 0;
      // Push the badge's top-right corner slightly BEYOND the icon's top-right
      // corner so the number overlaps the icon border a bit (sits half-on /
      // half-off the top-right edge). The y offset also absorbs PIXI.Text's
      // internal top-leading. Offsets scale with fontSize so it holds across
      // icon sizes.
      badge.x = (1 - ax) * localW + Math.round(fontSize * 0.22);
      badge.y = (0 - ay) * localH - Math.round(fontSize * 0.30);
      badge.zIndex = 100;

      iconSprite.sortableChildren = true;
      iconSprite.addChild(badge);
    }

    function collectChargedEffects(actor) {
      // Foundry uses actor.temporaryEffects to populate token effect icons,
      // which includes effects from items — actor.effects only sees
      // actor-direct effects, so we'd miss item-granted ones.
      const seen = new Set();
      const out = [];
      const pushIfCharged = (eff) => {
        if (!eff || seen.has(eff)) return;
        seen.add(eff);
        const count = getChargeCount(eff);
        if (count === null) return;
        // Hide the badge ONLY for a fixed max of 1 (a pure on/off effect, where
        // a "1" is noise). Show for max > 1, and for an UNSET max (unlimited /
        // open-ended charges — the running count is still meaningful).
        const max = getChargeMax(eff);
        if (max === 1) return;
        const imgNorm = normalizePath(eff.img ?? eff.icon ?? "");
        if (!imgNorm) return;
        out.push({ effect: eff, count, max, imgNorm });
      };

      try {
        for (const eff of (actor?.temporaryEffects ?? [])) pushIfCharged(eff);
      } catch (_e) {}
      try {
        for (const eff of (actor?.effects?.contents ?? [])) pushIfCharged(eff);
      } catch (_e) {}
      try {
        const all = actor?.allApplicableEffects?.();
        if (all) for (const eff of all) pushIfCharged(eff);
      } catch (_e) {}

      return out;
    }

    function applyChargeBadges(token) {
      const effectsLayer = token?.effects;
      if (!effectsLayer?.children?.length) {
        log("applyChargeBadges: no effects layer / children.", { token: token?.name });
        return;
      }
      const actor = token.actor;
      if (!actor) return;

      const pool = collectChargedEffects(actor);

      // Debug payload is built ONLY when logging is on — these .map()s ran on
      // every badge pass before, wasted work in the (default) DEBUG=false case.
      if (DEBUG) {
        log("applyChargeBadges:", {
          token: token.name,
          actorEffectsTotal: (actor.effects?.contents ?? []).length,
          temporaryEffects: (actor.temporaryEffects ?? []).length,
          chargedCandidates: pool.length,
          candidateSummary: pool.map(p => ({ name: p.effect.name, count: p.count, img: p.imgNorm })),
          spriteChildren: effectsLayer.children.length,
          childTextures: effectsLayer.children.map(c => normalizePath(extractTexturePath(c)))
        });
      }

      if (!pool.length) {
        for (const child of effectsLayer.children) clearBadge(child);
        return;
      }

      for (const child of effectsLayer.children) {
        if (!child) continue;
        const tex = normalizePath(extractTexturePath(child));
        if (!tex) { clearBadge(child); continue; }

        const idx = pool.findIndex(p => p.imgNorm === tex);
        if (idx < 0) { clearBadge(child); continue; }

        const match = pool.splice(idx, 1)[0];
        try {
          attachBadge(child, match.count, match.max);
          log("Badge attached:", { token: token.name, effect: match.effect.name, count: match.count });
        } catch (e) {
          warn("Failed to attach charge badge.", e);
        }
      }
    }

    // Coalesce badge refreshes into one pass per token per animation frame.
    //
    // applyChargeBadges is driven by SIX triggers (drawEffects wrapper,
    // drawToken, refreshToken, and the create/update/deleteActiveEffect
    // hooks). A single AE apply fires the drawEffects redraw + refreshToken +
    // the create hook — so the badge work ran ~3× per token per AE, and
    // O(tokens × AEs) when several effects change in close proximity (the
    // reported lag). Queueing the affected tokens in a Set and flushing once
    // on the next frame collapses all of that to a single pass per token,
    // and dedupes overlapping tokens across multiple AE changes in the same
    // frame. One-frame (~16ms) deferral is visually imperceptible for a
    // numeric badge.
    const _badgeQueue = new Set();
    let _badgeRaf = 0;
    function flushBadgeQueue() {
      _badgeRaf = 0;
      const tokens = Array.from(_badgeQueue);
      _badgeQueue.clear();
      for (const t of tokens) {
        try { applyChargeBadges(t); } catch (e) { warn("badge queue flush failed.", e); }
      }
    }
    function scheduleChargeBadges(token) {
      if (!token) return;
      _badgeQueue.add(token);
      if (_badgeRaf) return;
      _badgeRaf = requestAnimationFrame(flushBadgeQueue);
    }

    function refreshAll() {
      const tokens = canvas?.tokens?.placeables ?? [];
      for (const token of tokens) {
        try { scheduleChargeBadges(token); } catch (_e) {}
      }
    }

    function findTokenClass() {
      const candidates = [
        ["globalThis.Token", globalThis.Token],
        ["CONFIG.Token.objectClass", globalThis.CONFIG?.Token?.objectClass],
        ["foundry.canvas.placeables.Token", globalThis.foundry?.canvas?.placeables?.Token]
      ];

      for (const [name, cls] of candidates) {
        if (typeof cls === "function" && cls.prototype) {
          log("Token class candidate:", { source: name,
            hasDrawEffects: typeof cls.prototype.drawEffects === "function",
            has_drawEffects: typeof cls.prototype._drawEffects === "function",
            hasDrawEffect: typeof cls.prototype.drawEffect === "function" });
        } else {
          log("Token class candidate missing:", { source: name, value: cls });
        }
      }

      for (const [, cls] of candidates) {
        if (typeof cls?.prototype?.drawEffects === "function") return { cls, method: "drawEffects" };
      }
      for (const [, cls] of candidates) {
        if (typeof cls?.prototype?._drawEffects === "function") return { cls, method: "_drawEffects" };
      }
      return null;
    }

    function patchDrawEffects() {
      const found = findTokenClass();
      if (!found) {
        warn("No Token class with drawEffects/_drawEffects found; falling back to hooks only.");
        return false;
      }

      const { cls, method } = found;
      const original = cls.prototype[method];

      cls.prototype[method] = async function patchedDrawEffects(...args) {
        const result = await original.apply(this, args);
        try { scheduleChargeBadges(this); }
        catch (e) { warn("scheduleChargeBadges failed inside drawEffects wrapper.", e); }
        return result;
      };

      console.log(TAG, `Patched ${cls.name}.prototype.${method}.`);
      return true;
    }

    const patched = patchDrawEffects();

    // Hook fallbacks — these fire regardless of whether the prototype patch
    // succeeded, so badges still appear even if Foundry's rendering API
    // shifted under us.
    Hooks.on("drawToken", (token) => {
      try { scheduleChargeBadges(token); } catch (e) { warn("drawToken hook failed.", e); }
    });
    Hooks.on("refreshToken", (token) => {
      try { scheduleChargeBadges(token); } catch (e) { warn("refreshToken hook failed.", e); }
    });
    Hooks.on("createActiveEffect", (effect) => {
      const tokens = canvas?.tokens?.placeables?.filter(t => t.actor === effect.parent) ?? [];
      for (const t of tokens) { try { scheduleChargeBadges(t); } catch (_e) {} }
    });
    Hooks.on("updateActiveEffect", (effect) => {
      const tokens = canvas?.tokens?.placeables?.filter(t => t.actor === effect.parent) ?? [];
      for (const t of tokens) { try { scheduleChargeBadges(t); } catch (_e) {} }
    });
    Hooks.on("deleteActiveEffect", (effect) => {
      const tokens = canvas?.tokens?.placeables?.filter(t => t.actor === effect.parent) ?? [];
      for (const t of tokens) { try { scheduleChargeBadges(t); } catch (_e) {} }
    });

    // Existing tokens were already drawn before this patch installed —
    // give them their badges now, and on every subsequent canvas swap.
    refreshAll();
    Hooks.on("canvasReady", refreshAll);

    if (!patched) {
      console.log(TAG, "Running in hook-only mode (no prototype patch).");
    }

    // Manual handle for console testing.
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.chargesBadge = Object.freeze({
      refreshAll,
      refreshToken: (token) => applyChargeBadges(token),
      collectChargedEffects
    });

    console.debug(TAG, "Installed. Console handle: FUCompanion.api.chargesBadge");
  })();
});
