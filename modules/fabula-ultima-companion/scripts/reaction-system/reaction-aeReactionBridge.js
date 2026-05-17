/**
 * [ONI] Reaction System — AE-borne Reaction Config Bridge
 * ---------------------------------------------------------------------------
 * CSB's `active_effect_config_table` mechanism copies an effect from a source
 * item to the target actor when a skill resolves (e.g. Acceleration applies
 * its bonus-action AE to the targeted ally). The copy preserves most of the
 * template's `flags`, but our custom `flags.fabula-ultima-companion.reactionConfig`
 * namespace gets dropped — so freshly applied AEs lose the data that the
 * reaction substrate's matcher relies on to synthesize a virtual reaction
 * item.
 *
 * This bridge fixes that on the GM side: whenever a fresh ActiveEffect is
 * created on an actor, look up its source item by UUID (`origin`) and, if
 * the source template carries `reactionConfig`, copy that flag onto the
 * just-created AE. The matcher in reaction-triggerCore then picks it up as
 * usual.
 *
 * Scope:
 *   • GM-only (writes flags on documents the GM owns).
 *   • Runs once per AE creation; idempotent — re-stamping is a no-op.
 *   • Strictly additive; doesn't touch other flag namespaces.
 *
 * Why a listener instead of fixing the template-copy path?
 *   • CSB internals own the template-copy logic. Hooking
 *     `createActiveEffect` is decoupled and survives CSB updates.
 *   • Keeps the special case for AE-borne reactions in the reaction module
 *     instead of bleeding into the bonus-actions facade.
 * ---------------------------------------------------------------------------
 */

(() => {
  const TAG = "[ReactionAEBridge]";
  const MODULE_ID = "fabula-ultima-companion";

  /**
   * Try to locate the template ActiveEffect (the one carrying the
   * `reactionConfig` flag) that an applied AE was cloned from.
   *
   * Tries in order:
   *   1. effect.origin → resolves directly to an Item document with
   *      matching effects (rare in practice — CSB-applied AEs usually
   *      stamp the caster's Token UUID into `origin`, not the source
   *      item's UUID).
   *   2. effect.flags.fabula-ultima-companion.sourceEffId → scan world
   *      items for one whose effects array contains an effect with this
   *      id. This is the path that catches CSB-applied bonus-action AEs
   *      like Acceleration.
   */
  async function findTemplateAE(effect) {
    // (1) Origin direct
    const originUuid = effect?.origin ?? null;
    if (originUuid && typeof originUuid === "string") {
      try {
        const doc = await fromUuid(originUuid);
        if (doc?.documentName === "Item") {
          const tmplEffects = doc.effects?.contents ?? [];
          const newName = (effect.name ?? "").toString();
          let tmpl = tmplEffects.find(e =>
            e?.flags?.[MODULE_ID]?.reactionConfig && (e.name ?? "") === newName
          );
          if (!tmpl) {
            tmpl = tmplEffects.find(e => e?.flags?.[MODULE_ID]?.reactionConfig);
          }
          if (tmpl) return { tmpl, sourceItem: doc };
        }
      } catch (_) { /* fall through */ }
    }

    // (2) sourceEffId on the FU flag block
    const sourceEffId = effect?.flags?.[MODULE_ID]?.sourceEffId
      ?? effect?.flags?.[MODULE_ID]?.originItemId
      ?? null;
    if (!sourceEffId) return null;

    for (const item of (game.items?.contents ?? [])) {
      const match = (item.effects?.contents ?? []).find(e => e.id === sourceEffId);
      if (match && match.flags?.[MODULE_ID]?.reactionConfig) {
        return { tmpl: match, sourceItem: item };
      }
    }
    return null;
  }

  Hooks.on("createActiveEffect", async (effect /*, options, userId */) => {
    try {
      if (!game.user?.isGM) return;
      if (!effect) return;

      // Already stamped — nothing to do.
      const existing = effect.getFlag?.(MODULE_ID, "reactionConfig");
      if (existing) return;

      const found = await findTemplateAE(effect);
      if (!found) return;

      const reactionConfig = found.tmpl.flags?.[MODULE_ID]?.reactionConfig;
      if (!reactionConfig) return;

      await effect.setFlag(MODULE_ID, "reactionConfig", reactionConfig);
      console.log(TAG, "Stamped reactionConfig onto fresh AE.", {
        effectId: effect.id,
        effectName: effect.name,
        sourceItemName: found.sourceItem?.name ?? null,
        sourceItemId: found.sourceItem?.id ?? null,
        templateEffectId: found.tmpl?.id ?? null
      });
    } catch (e) {
      console.warn(TAG, "createActiveEffect handler threw (non-fatal):", e);
    }
  });

  console.debug(TAG, "Installed.");
})();
