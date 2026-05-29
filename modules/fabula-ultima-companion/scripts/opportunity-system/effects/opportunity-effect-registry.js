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
   * Show a token-picker dialog (GM-side, uses a <select> for any number of tokens).
   * Returns the chosen PlaceableToken or null if cancelled / no tokens.
   */
  function pickToken({ title = "Choose Target", excludeActorId = null } = {}) {
    const esc    = s => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
    const tokens = (canvas?.tokens?.placeables ?? []).filter(t => {
      if (!t.actor) return false;
      if (excludeActorId && t.actor.id === excludeActorId) return false;
      return true;
    });

    if (!tokens.length) {
      ui.notifications?.warn("[Opportunity] No valid tokens on scene.");
      return Promise.resolve(null);
    }
    if (tokens.length === 1) return Promise.resolve(tokens[0]);

    return new Promise(resolve => {
      const opts = tokens.map((t, i) =>
        `<option value="${i}">${esc(t.name ?? `Token ${i + 1}`)}</option>`
      ).join("");
      new Dialog({
        title,
        content: `<div style="padding:4px 0 8px;">
          <select id="oni-opp-target-sel" style="width:100%;padding:4px;">${opts}</select>
        </div>`,
        buttons: {
          confirm: {
            label: "Confirm",
            callback: html => {
              const idx = parseInt(html.find("#oni-opp-target-sel").val() ?? "0", 10);
              resolve(tokens[Number.isFinite(idx) ? idx : 0] ?? null);
            },
          },
          cancel: { label: "Cancel", callback: () => resolve(null) },
        },
        default: "confirm",
        close:   () => resolve(null),
      }).render(true);
    });
  }

  window["oni.OppEffectUtils"] = Object.freeze({ resolveActor, pickToken });

  console.debug(TAG, "Effect registry ready.");
})();
