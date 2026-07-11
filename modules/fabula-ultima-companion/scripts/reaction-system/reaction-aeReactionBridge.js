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

  // sourceEffId (template AE id) -> { tmpl: ActiveEffect, sourceItem: Item }
  // Populated on `ready` and maintained via Item/AE CRUD hooks so the
  // per-AE-create lookup is O(1) instead of O(items × effects-per-item).
  const templateIndex = new Map();
  let indexReady = false;

  function indexItem(item) {
    if (!item || item.documentName !== "Item") return;
    for (const eff of (item.effects?.contents ?? [])) {
      if (eff?.flags?.[MODULE_ID]?.reactionConfig) {
        templateIndex.set(eff.id, { tmpl: eff, sourceItem: item });
      }
    }
  }

  function unindexItem(item) {
    if (!item) return;
    for (const eff of (item.effects?.contents ?? [])) {
      if (templateIndex.get(eff.id)?.sourceItem === item) {
        templateIndex.delete(eff.id);
      }
    }
  }

  function buildIndex() {
    templateIndex.clear();
    for (const item of (game.items?.contents ?? [])) indexItem(item);
    indexReady = true;
    console.debug(TAG, `Template index built (${templateIndex.size} entries).`);
  }

  /**
   * Try to locate the template ActiveEffect (the one carrying the
   * `reactionConfig` flag) that an applied AE was cloned from.
   *
   * Tries in order:
   *   1. effect.origin → resolves directly to an Item document with
   *      matching effects (rare in practice — CSB-applied AEs usually
   *      stamp the caster's Token UUID into `origin`, not the source
   *      item's UUID).
   *   2. effect.flags.fabula-ultima-companion.sourceEffId → O(1) lookup
   *      against the prebuilt template index. This is the path that
   *      catches CSB-applied bonus-action AEs like Acceleration.
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
          // Prefer the SAME-NAMED template on the source item.
          const byName = tmplEffects.find(e => (e.name ?? "") === newName);
          if (byName) {
            // A template with this exact name exists — honor ITS reactionConfig,
            // or its DELIBERATE absence. Do NOT fall back to a sibling's config, or
            // a clean benefit AE would wrongly inherit a sibling's reaction. Items
            // can carry several benefit AEs, only some reaction-bearing — e.g. Golem
            // Dance's "Bolt Resist" (clean, affinity only) vs "Bolt Element" (carries
            // the change_damage_element override). The old greedy fallback smeared
            // Bolt Element's override onto Bolt Resist (the long-standing leak).
            return byName.flags?.[MODULE_ID]?.reactionConfig
              ? { tmpl: byName, sourceItem: doc }
              : null;
          }
          // No same-named template — legacy single-reaction-AE items whose applied
          // AE was renamed on copy: fall back to the item's sole reaction template.
          const tmpl = tmplEffects.find(e => e?.flags?.[MODULE_ID]?.reactionConfig);
          if (tmpl) return { tmpl, sourceItem: doc };
        }
      } catch (_) { /* fall through */ }
    }

    // (2) sourceEffId — O(1) via prebuilt index
    const sourceEffId = effect?.flags?.[MODULE_ID]?.sourceEffId
      ?? effect?.flags?.[MODULE_ID]?.originItemId
      ?? null;
    if (!sourceEffId) return null;

    const hit = templateIndex.get(sourceEffId);
    if (hit && hit.tmpl?.flags?.[MODULE_ID]?.reactionConfig) return hit;
    return null;
  }

  function installIndex() {
    buildIndex();

    // Keep the index live. Item-level events (create/delete/update) catch
    // bulk changes; AE-level events catch per-effect edits on world items.
    Hooks.on("createItem", (item) => indexItem(item));
    Hooks.on("updateItem", (item) => { unindexItem(item); indexItem(item); });
    Hooks.on("deleteItem", (item) => unindexItem(item));

    Hooks.on("createActiveEffect", (eff) => {
      const parent = eff?.parent;
      if (parent?.documentName === "Item" && !parent.parent) {
        if (eff?.flags?.[MODULE_ID]?.reactionConfig) {
          templateIndex.set(eff.id, { tmpl: eff, sourceItem: parent });
        }
      }
    });
    Hooks.on("updateActiveEffect", (eff) => {
      const parent = eff?.parent;
      if (parent?.documentName === "Item" && !parent.parent) {
        if (eff?.flags?.[MODULE_ID]?.reactionConfig) {
          templateIndex.set(eff.id, { tmpl: eff, sourceItem: parent });
        } else {
          templateIndex.delete(eff.id);
        }
      }
    });
    Hooks.on("deleteActiveEffect", (eff) => {
      const parent = eff?.parent;
      if (parent?.documentName === "Item" && !parent.parent) {
        templateIndex.delete(eff.id);
      }
    });
  }

  // `ready` may have already fired by the time this classic script loads
  // (dynamic re-install via evalGM, late module init). Cover both paths.
  if (game?.ready) installIndex();
  else Hooks.once("ready", installIndex);

  Hooks.on("createActiveEffect", async (effect /*, options, userId */) => {
    try {
      if (!game.user?.isGM) return;
      if (!effect) return;
      if (!indexReady) return;

      // Only handle AEs applied to actors — template-side AE creates are
      // index maintenance, not stamping targets.
      if (effect.parent?.documentName !== "Actor") return;

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
