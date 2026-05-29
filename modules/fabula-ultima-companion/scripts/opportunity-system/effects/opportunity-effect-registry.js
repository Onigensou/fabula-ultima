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
  window["oni.OppEffectRegistry"] = Object.freeze({
    register(id, fn) {
      if (typeof fn !== "function") {
        console.warn(TAG, `register("${id}"): handler must be a function.`);
        return;
      }
      if (_registry.has(id)) console.warn(TAG, `Effect "${id}" already registered — overwriting.`);
      _registry.set(id, fn);
      console.debug(TAG, `Registered effect: ${id}`);
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
   * @param {object}  opts
   * @param {string}  [opts.title]           Shown as the targeting UI header text
   * @param {string}  [opts.skillTarget]     Targeting string, e.g. "One Creature"
   * @param {string}  [opts.sourceActorUuid] UUID of the acting actor; their tokens
   *                                         are excluded from the valid target list
   */
  async function pickToken({
    title           = "Choose Target",
    skillTarget     = "One Creature",
    sourceActorUuid = null,
  } = {}) {
    const targeting = globalThis["__ONI_JRPG_TARGETING_API__"];
    console.debug(TAG, "[pickToken] entry", { title, skillTarget, sourceActorUuid, apiFound: !!targeting });

    if (!targeting) {
      console.error(TAG, "[pickToken] JRPG Targeting API not found at globalThis[\"__ONI_JRPG_TARGETING_API__\"]");
      ui.notifications?.error("[Opportunity] Targeting API not available.");
      return null;
    }

    // Build explicit allowed list so we can exclude the source actor's tokens
    let allowedTokenUuids;
    if (sourceActorUuid) {
      const srcDoc   = await fromUuid(sourceActorUuid).catch(() => null);
      const srcActor = srcDoc?.actor ?? (srcDoc?.documentName === "Actor" ? srcDoc : null);
      const srcId    = srcActor?.id ?? null;
      console.debug(TAG, "[pickToken] source actor resolved", { srcId, srcName: srcActor?.name });
      const allowed  = (canvas?.tokens?.placeables ?? [])
        .filter(t => t.actor && (!srcId || t.actor.id !== srcId))
        .map(t => t.document?.uuid)
        .filter(Boolean);
      if (allowed.length) allowedTokenUuids = allowed;
      console.debug(TAG, "[pickToken] allowed token UUIDs", allowedTokenUuids ?? "(all)");
    }

    console.debug(TAG, "[pickToken] calling requestTargeting...");
    const result = await targeting.requestTargeting({
      skillTarget,
      sourceActorUuid: sourceActorUuid ?? null,
      ...(allowedTokenUuids ? { allowedTargetTokenUuids: allowedTokenUuids } : {}),
      uiTitleText: title,
      userId: game.user.id,
    }).catch(e => { console.error(TAG, "[pickToken] requestTargeting error:", e); return null; });

    console.debug(TAG, "[pickToken] result", { confirmed: result?.confirmed, cancelled: result?.cancelled, tokenCount: result?.tokens?.length, tokens: result?.tokens });

    if (!result?.confirmed || !result.tokens?.length) {
      console.debug(TAG, "[pickToken] → null (cancelled or no tokens selected)");
      return null;
    }

    // result.tokens contains plain info objects — resolve back to PlaceableToken
    const info  = result.tokens[0];
    console.debug(TAG, "[pickToken] resolving PlaceableToken from info", info);
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
