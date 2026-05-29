// ============================================================================
// Opportunity System — Effect Registry
//
// Mirror of CAMP.ActivityRegistry for the opportunity system.
//
// Each effect file calls:
//   window["oni.OppEffectRegistry"].register("id", async (ctx) => { ... });
//
// The manager reads effects via:
//   window["oni.OpportunityEffects"][optionId]
// which is a Proxy backed by the registry Map — no manager changes needed.
//
// Shared helpers for effect files:
//   window["oni.OppEffectUtils"].resolveActor(uuid)
//   window["oni.OppEffectUtils"].pickToken({ title, excludeActorId })
// ============================================================================
(() => {
  const TAG = "[ONI][OpportunitySystem:EffectRegistry]";

  // ── Registry Map ─────────────────────────────────────────────────────────────
  const _registry = new Map();

  // ── window["oni.OpportunityEffects"] — Proxy used by the manager ─────────────
  // manager calls: effects[optionId](ctx)
  window["oni.OpportunityEffects"] = new Proxy(_registry, {
    get(map, id) {
      if (typeof id !== "string") return undefined;
      return map.get(id) ?? null;
    },
    has(map, id) { return map.has(id); },
  });

  // ── Registration API used by individual effect files ─────────────────────────
  //
  // Handlers may be either:
  //   - async function(ctx) { ... }           legacy: runs after the banner
  //   - { pre: async (ctx) => result,         pre  runs BEFORE the banner (targeting, etc.)
  //       post: async (ctx, preResult) => {} } post runs AFTER the banner
  //
  // pre() returns a serializable plain object on success, or null to cancel.
  // post() receives the same plain object so it can resolve live tokens/actors.
  window["oni.OppEffectRegistry"] = Object.freeze({
    register(id, handler) {
      const isLegacyFn = typeof handler === "function";
      const isPhased   = handler && typeof handler === "object"
        && (typeof handler.pre === "function" || typeof handler.post === "function");
      if (!isLegacyFn && !isPhased) {
        console.warn(TAG, `register("${id}"): handler must be a function or { pre, post } object.`);
        return;
      }
      if (_registry.has(id)) console.warn(TAG, `Effect "${id}" already registered — overwriting.`);
      _registry.set(id, handler);
      console.debug(TAG, `Registered effect: ${id}`, isPhased ? "(pre/post)" : "(legacy fn)");
    },
    has(id)  { return _registry.has(id); },
    getAll() { return Array.from(_registry.entries()); },
  });

  // ── Shared helpers ────────────────────────────────────────────────────────────

  /** Resolve the world-actor from any UUID (token or actor). */
  async function resolveActor(uuid) {
    if (!uuid) return null;
    const doc   = await fromUuid(uuid).catch(() => null);
    const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
    if (!actor) return null;
    return actor.isToken ? (game.actors?.get(actor.id) ?? actor) : actor;
  }

  /**
   * Pick a single target token using the JRPG Targeting UI.
   * Always returns a PlaceableToken or null (cancelled / no valid targets).
   *
   * API is at globalThis["__ONI_JRPG_TARGETING_API__"], installed on "setup".
   *
   * Known issue: requestTargeting's promise can hang if the UI's animateOut()
   * never fires .finished (seen when the user confirms before animateIn()
   * fully settles). We work around this by racing the session promise against
   * a store-poll: the store is written BEFORE the exit animation starts, so
   * the poll picks up the result within ≤80 ms regardless of animation state.
   *
   * @param {object}  opts
   * @param {string}  [opts.title]           Shown as the targeting UI header text
   * @param {string}  [opts.skillTarget]     Targeting string, e.g. "One Creature"
   * @param {string}  [opts.sourceActorUuid] UUID of the acting actor
   * @param {boolean} [opts.includeSource]   If true, source actor's own tokens
   *                                         remain in the eligible list (allows
   *                                         self-targeting). Default: false.
   */
  async function pickToken({
    title           = "Choose Target",
    skillTarget     = "One Creature",
    sourceActorUuid = null,
    includeSource   = false,
  } = {}) {
    const targeting = globalThis["__ONI_JRPG_TARGETING_API__"];
    console.debug(TAG, "[pickToken] entry", { title, skillTarget, sourceActorUuid, includeSource, apiFound: !!targeting });

    if (!targeting) {
      console.error(TAG, "[pickToken] JRPG Targeting API not found at globalThis[\"__ONI_JRPG_TARGETING_API__\"]");
      ui.notifications?.error("[Opportunity] Targeting API not available.");
      return null;
    }

    // Build allowed list — optionally keep source actor's tokens in it
    let allowedTokenUuids;
    if (sourceActorUuid) {
      const srcDoc   = await fromUuid(sourceActorUuid).catch(() => null);
      const srcActor = srcDoc?.actor ?? (srcDoc?.documentName === "Actor" ? srcDoc : null);
      const srcId    = srcActor?.id ?? null;
      console.debug(TAG, "[pickToken] source actor resolved", { srcId, srcName: srcActor?.name, includeSource });
      const allowed  = (canvas?.tokens?.placeables ?? [])
        .filter(t => t.actor && (includeSource || !srcId || t.actor.id !== srcId))
        .map(t => t.document?.uuid)
        .filter(Boolean);
      if (allowed.length) allowedTokenUuids = allowed;
      console.debug(TAG, "[pickToken] allowed token UUIDs", allowedTokenUuids ?? "(all)");
    }

    // Unique sessionId so the store-race can verify it's our result
    const sessionId = `opp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const sessionPromise = targeting.requestTargeting({
      sessionId,
      skillTarget,
      sourceActorUuid: sourceActorUuid ?? null,
      ...(allowedTokenUuids ? { allowedTargetTokenUuids: allowedTokenUuids } : {}),
      uiTitleText: title,
      userId: game.user.id,
    }).catch(e => { console.error(TAG, "[pickToken] requestTargeting error:", e); return null; });

    // Store-race: the store is written before animateOut starts, so we can
    // resolve via the store even if requestTargeting's promise hangs.
    let storeRaceCleanup = null;
    const storeRacePromise = new Promise(resolve => {
      const userId = game.user.id;
      let pollId;
      const check = () => {
        const stored = targeting.getLastResult?.(userId);
        if (stored?.sessionId !== sessionId) return;
        clearInterval(pollId);
        // Stored tokens use { uuid, id }; live tokens use { tokenUuid, tokenId }.
        // Normalise to { tokenUuid, tokenId } so the PlaceableToken lookup below
        // works regardless of which branch resolved.
        const adaptedTokens = (stored.tokens ?? []).map(t => ({
          ...t, tokenUuid: t.uuid, tokenId: t.id,
        }));
        console.debug(TAG, "[pickToken] store-race resolved", { sessionId, confirmed: stored.confirmed, tokenCount: adaptedTokens.length });
        resolve({ ok: stored.confirmed, confirmed: stored.confirmed, cancelled: stored.cancelled, tokens: adaptedTokens });
      };
      pollId = setInterval(check, 80);
      storeRaceCleanup = () => clearInterval(pollId);
      setTimeout(() => { clearInterval(pollId); resolve(null); }, 30_000);
    });

    const result = await Promise.race([sessionPromise, storeRacePromise]);
    storeRaceCleanup?.();   // stop the poll if sessionPromise won
    console.debug(TAG, "[pickToken] result", { confirmed: result?.confirmed, cancelled: result?.cancelled, tokenCount: result?.tokens?.length });

    if (!result?.confirmed || !result.tokens?.length) {
      console.debug(TAG, "[pickToken] → null (cancelled or no tokens)");
      return null;
    }

    // Resolve back to a live PlaceableToken
    const info  = result.tokens[0];
    const found = (canvas?.tokens?.placeables ?? []).find(t =>
      t.document?.uuid === info.tokenUuid || t.id === info.tokenId
    );
    console.debug(TAG, "[pickToken] → PlaceableToken", found ? found.name : "NOT FOUND on canvas");
    return found ?? null;
  }

  // ── Resolve non-GM owner user ID for an actor UUID ───────────────────────────
  function resolveOwnerUserId(actorUuid) {
    if (!actorUuid) return null;
    const shortId   = String(actorUuid).replace(/^Actor\./, "").replace(/^.*\.Actor\./, "");
    const candidates = [];

    const worldActor = game.actors?.get(shortId);
    if (worldActor) {
      for (const [userId, level] of Object.entries(worldActor.ownership ?? {})) {
        if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
          const user = game.users?.get(userId);
          if (user && !user.isGM) candidates.push(userId);
        }
      }
    } else {
      for (const t of (canvas?.tokens?.placeables ?? [])) {
        const actor = t.actor;
        if (!actor) continue;
        if (actor.uuid !== actorUuid && actor.id !== shortId) continue;
        for (const [userId, level] of Object.entries(actor.ownership ?? {})) {
          if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
            const user = game.users?.get(userId);
            if (user && !user.isGM) candidates.push(userId);
          }
        }
        break;
      }
    }
    return candidates[0] ?? null;
  }

  /**
   * Show a GM-side text-input dialog with an optional textarea.
   * Returns the trimmed string, or null if cancelled / empty.
   *
   * @param {object} opts
   * @param {string}  opts.title
   * @param {string}  [opts.label]          HTML rendered above the textarea
   * @param {string}  [opts.placeholder]
   * @param {boolean} [opts.multiline=true]  false → single <input type="text">
   */
  function gmTextPrompt({ title = "Enter Text", label = "", placeholder = "", multiline = true } = {}) {
    return new Promise(resolve => {
      const escAttr = s => String(s ?? "").replaceAll("&","&amp;").replaceAll('"',"&quot;");
      const field   = multiline
        ? `<textarea id="oni-opp-text-in" rows="3" placeholder="${escAttr(placeholder)}"
             style="width:100%;padding:6px;resize:vertical;box-sizing:border-box;"></textarea>`
        : `<input id="oni-opp-text-in" type="text" placeholder="${escAttr(placeholder)}"
             style="width:100%;padding:6px;box-sizing:border-box;" />`;

      new Dialog({
        title,
        content: `<div style="padding:4px 0 8px;">
          ${label ? `<p style="margin:0 0 6px;">${label}</p>` : ""}
          ${field}
        </div>`,
        buttons: {
          confirm: {
            label:    "Confirm",
            callback: html => {
              const val = String(html.find("#oni-opp-text-in").val() ?? "").trim();
              resolve(val || null);
            },
          },
          cancel: { label: "Cancel", callback: () => resolve(null) },
        },
        default: "confirm",
        close:   () => resolve(null),
      }).render(true);
    });
  }

  /**
   * Show an item-picker dialog for a given actor (GM-side).
   * Returns the chosen Item document, or null if cancelled / no items.
   */
  function pickItem(actor) {
    const items = Array.from(actor?.items ?? []).filter(i => i.name);
    if (!items.length) {
      ui.notifications?.warn(`[Opportunity] ${actor?.name ?? "Actor"} has no items.`);
      return Promise.resolve(null);
    }
    if (items.length === 1) return Promise.resolve(items[0]);

    return new Promise(resolve => {
      const esc  = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
      const opts = items.map((it, i) =>
        `<option value="${i}">${esc(it.name)}</option>`
      ).join("");
      new Dialog({
        title:   `Lost Item — ${actor.name}`,
        content: `<div style="padding:4px 0 8px;">
          <select id="oni-opp-item-sel" style="width:100%;padding:4px;">${opts}</select>
        </div>`,
        buttons: {
          confirm: {
            label:    "Confirm",
            callback: html => {
              const idx = parseInt(html.find("#oni-opp-item-sel").val() ?? "0", 10);
              resolve(items[Number.isFinite(idx) ? idx : 0] ?? null);
            },
          },
          cancel: { label: "Cancel", callback: () => resolve(null) },
        },
        default: "confirm",
        close:   () => resolve(null),
      }).render(true);
    });
  }

  window["oni.OppEffectUtils"] = Object.freeze({
    resolveActor,
    pickToken,
    resolveOwnerUserId,
    gmTextPrompt,
    pickItem,
  });

  console.debug(TAG, "Effect registry ready.");
})();
