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
 * This bridge fixes that: when an ActiveEffect is applied to an actor, look up
 * its source item by UUID (`origin`) and, if the source template carries
 * `reactionConfig`, copy that flag onto the AE. The matcher in
 * reaction-triggerCore then picks it up as usual.
 *
 * ⚡ Stamped at preCreate, NOT after creation (perf)
 *   The stamp used to be a post-create `setFlag`. That is a second document
 *   write on a document that was just written, and under CSB every write forces
 *   a full `actor.prepareData()` — so every reaction-bearing AE cost TWO actor
 *   re-derivations instead of one. On a heavy PC that is a few hundred ms of
 *   pure stutter per applied AE, and combat applies them in bursts.
 *
 *   `preCreateActiveEffect` + `updateSource()` folds the flag into the SAME
 *   write, so a stamped AE now costs exactly one cycle. This is the same fix
 *   already shipped for CSB's own four bookkeeping flags (see
 *   csb-extensions/csb-derivation-perf.js). The hook must stay SYNCHRONOUS —
 *   Foundry does not await `preCreate*` handlers — hence `findTemplateAESync`
 *   and `fromUuidSync` below.
 *
 *   The post-create hook is KEPT as a fallback for what the sync path cannot
 *   resolve (a compendium `origin`, or an AE created before the template index
 *   finished building). It self-skips when preCreate already stamped, so the
 *   fast path pays nothing for it.
 *
 * Scope:
 *   • preCreate stamp: runs on whichever client initiates the creation. It only
 *     enriches that client's own create payload, so it needs no GM gate — and a
 *     player-initiated AE now gets stamped in one cycle too, where before it
 *     took a second write from the GM's client.
 *   • post-create fallback: GM-only (writes flags on documents the GM owns).
 *   • Idempotent — re-stamping is a no-op.
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
   * Path (1)'s decision, given an already-resolved source Item. Shared by the
   * sync and async resolvers so the two can never disagree about which template
   * owns an applied AE.
   *
   * @returns {{decided: true, hit: object|null} | {decided: false}}
   *   `decided:true, hit:null` is AUTHORITATIVE "this AE gets no stamp" and must
   *   NOT fall through to the index — see the leak note below.
   */
  function resolveTemplateOnItem(doc, effectName) {
    const tmplEffects = doc.effects?.contents ?? [];
    const newName = (effectName ?? "").toString();
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
      return {
        decided: true,
        hit: byName.flags?.[MODULE_ID]?.reactionConfig
          ? { tmpl: byName, sourceItem: doc }
          : null
      };
    }
    // No same-named template — legacy single-reaction-AE items whose applied
    // AE was renamed on copy: fall back to the item's sole reaction template.
    const tmpl = tmplEffects.find(e => e?.flags?.[MODULE_ID]?.reactionConfig);
    if (tmpl) return { decided: true, hit: { tmpl, sourceItem: doc } };
    return { decided: false };
  }

  /** Path (2) — sourceEffId, O(1) via the prebuilt index. */
  function findTemplateAEViaIndex(effect) {
    const sourceEffId = effect?.flags?.[MODULE_ID]?.sourceEffId
      ?? effect?.flags?.[MODULE_ID]?.originItemId
      ?? null;
    if (!sourceEffId) return null;

    const hit = templateIndex.get(sourceEffId);
    if (hit && hit.tmpl?.flags?.[MODULE_ID]?.reactionConfig) return hit;
    return null;
  }

  /**
   * Synchronous resolver for the preCreate stamp. Identical decisions to
   * `findTemplateAE`, but resolves `origin` via `fromUuidSync` so it can run
   * inside a hook Foundry will not await.
   *
   * `fromUuidSync` returns a bare index entry (no `documentName`, no `effects`)
   * for a COMPENDIUM uuid — that fails the Item check, yields no stamp here, and
   * is picked up by the async post-create fallback instead. That is the intended
   * split, not a miss.
   */
  function findTemplateAESync(effect) {
    const originUuid = effect?.origin ?? null;
    if (originUuid && typeof originUuid === "string" && typeof fromUuidSync === "function") {
      try {
        const doc = fromUuidSync(originUuid);
        if (doc?.documentName === "Item") {
          const verdict = resolveTemplateOnItem(doc, effect.name);
          if (verdict.decided) return verdict.hit;
        }
      } catch (_) { /* fall through */ }
    }
    return findTemplateAEViaIndex(effect);
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
   *
   * Async — used by the post-create FALLBACK only. The preCreate fast path
   * uses `findTemplateAESync`, which makes the same decisions.
   */
  async function findTemplateAE(effect) {
    // (1) Origin direct
    const originUuid = effect?.origin ?? null;
    if (originUuid && typeof originUuid === "string") {
      try {
        const doc = await fromUuid(originUuid);
        if (doc?.documentName === "Item") {
          const verdict = resolveTemplateOnItem(doc, effect.name);
          if (verdict.decided) return verdict.hit;
        }
      } catch (_) { /* fall through */ }
    }

    // (2) sourceEffId — O(1) via prebuilt index
    return findTemplateAEViaIndex(effect);
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

  // ── FAST PATH — fold the stamp into the creation write itself ──────────────
  // Must stay synchronous and must never return false (that would CANCEL the
  // creation). Anything it cannot resolve simply falls through to the
  // post-create fallback below.
  Hooks.on("preCreateActiveEffect", (effect /*, data, options, userId */) => {
    try {
      if (!effect) return;

      // Only AEs applied to actors — template-side AE creates are index
      // maintenance, not stamping targets.
      if (effect.parent?.documentName !== "Actor") return;

      // Already carries one (the director deep-clones the template on apply).
      if (effect.flags?.[MODULE_ID]?.reactionConfig) return;

      const found = findTemplateAESync(effect);
      if (!found) return;

      const reactionConfig = found.tmpl?.flags?.[MODULE_ID]?.reactionConfig;
      if (!reactionConfig) return;

      // deepClone so the applied AE never shares a live reference with the
      // world item's own flag object.
      effect.updateSource({
        [`flags.${MODULE_ID}.reactionConfig`]: foundry.utils.deepClone(reactionConfig)
      });
    } catch (e) {
      // Never break document creation — the fallback below still covers this AE.
      console.warn(TAG, "preCreate stamp threw (non-fatal; post-create fallback applies):", e);
    }
  });

  // ── FALLBACK — only for what the sync path above could not resolve ─────────
  // (compendium `origin`, or an AE created before the index finished building).
  // Costs the extra re-derivation cycle, so it should be rare; the `existing`
  // guard below is what keeps the fast path free of it.
  Hooks.on("createActiveEffect", async (effect /*, options, userId */) => {
    try {
      if (!game.user?.isGM) return;
      if (!effect) return;
      if (!indexReady) return;

      // Only handle AEs applied to actors — template-side AE creates are
      // index maintenance, not stamping targets.
      if (effect.parent?.documentName !== "Actor") return;

      // Already stamped — nothing to do (preCreate normally got here first).
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
