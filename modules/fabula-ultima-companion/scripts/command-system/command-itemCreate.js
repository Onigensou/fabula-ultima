// ============================================================================
// scripts/Item-create.js
// Foundry VTT v12 — Item Create Helper API
//
// Purpose:
//   Build the "Create Item with IP" list for the Item UI.
//
// What this script does:
//   1. Adds default Fabula Ultima creatable items.
//   2. Finds recipe items owned by the acting actor.
//   3. Finds recipe items owned by the central party / database actor.
//   4. Reads each recipe's related_item_list.
//   5. Resolves the linked consumable item.
//   6. Returns clean "creatable item" data for Item.js to display.
//   7. Builds the ActionDataFetch payload for Create mode.
//
// Public API:
//   FUCompanion.api.itemCreate.getCreatableItems({ actor })
//   FUCompanion.api.itemCreate.collectDefaultCreatableItems()
//   FUCompanion.api.itemCreate.getActiveSkillEntries(item)
//   FUCompanion.api.itemCreate.buildCreatePayload({...})
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ItemCreate]";
  const DEBUG = true;

  // --------------------------------------------------------------------------
  // Default Fabula Ultima creatable item list
  //
  // These are always creatable even without a recipe.
  //
  // To add more default creatable items later, add a new row here.
  // itemUuid should point to the main consumable item, not the active skill item.
  // ipCost can override the item's own system.props.ip_cost when needed.
  // --------------------------------------------------------------------------

  const DEFAULT_CREATABLE_ITEMS = [
    {
      key: "elixir",
      displayName: "Elixir",
      itemUuid: "Item.C1sbMzuHM6lA5u8q",
      fallbackName: "Elixir",
      ipCost: 3,
      sort: 10,
      enabled: true
    },
    {
      key: "remedy",
      displayName: "Remedy",
      itemUuid: "Item.LIkvHKcRlhLRuRyt",
      fallbackName: "Remedy",
      ipCost: 3,
      sort: 20,
      enabled: true
    },
    {
      key: "tonic",
      displayName: "Tonic",
      itemUuid: "Item.ZO0vkyhHeR2pR4QH",
      fallbackName: "Tonic",
      ipCost: 2,
      sort: 30,
      enabled: true
    },
    {
      key: "elemental_shard",
      displayName: "Elemental Shard",
      itemUuid: "Item.1fnaiAu6HCHl75Cm",
      fallbackName: "Elemental Shard",
      ipCost: 2,
      sort: 40,
      enabled: true
    }
  ];

  const log  = (...args) => DEBUG && console.log(TAG, ...args);
  const warn = (...args) => DEBUG && console.warn(TAG, ...args);
  const err  = (...args) => DEBUG && console.error(TAG, ...args);

  // --------------------------------------------------------------------------
  // API exposure
  // --------------------------------------------------------------------------

  function ensureGlobalApi() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    return globalThis.FUCompanion.api;
  }

  function ensureModuleApi() {
    const mod = game?.modules?.get?.(MODULE_ID);
    if (!mod) return null;
    mod.api = mod.api || {};
    return mod.api;
  }

  function exposeApi(api) {
    const globalApi = ensureGlobalApi();
    globalApi.itemCreate = api;

    try {
      const moduleApi = ensureModuleApi();
      if (moduleApi) moduleApi.itemCreate = api;
    } catch (e) {
      warn("Could not expose itemCreate API on module API.", e);
    }

    log("API exposed at FUCompanion.api.itemCreate");
  }

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function toLower(value) {
    return safeString(value).toLowerCase();
  }

  function getProps(doc) {
    return doc?.system?.props ?? {};
  }

  function asObjectValues(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === "object") return Object.values(value).filter(Boolean);
    return [];
  }

  function uniqueBy(array, keyFn) {
    const out = [];
    const seen = new Set();

    for (const item of Array.isArray(array) ? array : []) {
      const key = safeString(keyFn(item));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }

    return out;
  }

  function htmlToPlainText(html = "") {
    try {
      const div = document.createElement("div");
      div.innerHTML = String(html ?? "");
      return div.textContent ?? div.innerText ?? "";
    } catch {
      return String(html ?? "").replace(/<[^>]*>/g, "");
    }
  }

  function parseIpCost(...values) {
    for (const value of values) {
      if (value === null || value === undefined) continue;

      const raw = String(value).trim();
      if (!raw) continue;

      const match = raw.match(/-?\d+/);
      if (!match) continue;

      const n = Number(match[0]);
      if (Number.isFinite(n)) return Math.max(0, Math.trunc(n));
    }

    return 0;
  }

    function getActorIpReductionValue(actor) {
    const raw =
      actor?.system?.props?.ip_reduction_value ??
      actor?.system?.ip_reduction_value ??
      0;

    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;

    // Reduction should never be negative.
    return Math.max(0, Math.trunc(n));
  }

  function buildReducedIpCost(baseIpCost, actor) {
    const base = Math.max(0, Math.trunc(Number(baseIpCost) || 0));
    const reduction = getActorIpReductionValue(actor);

    // Hard rule:
    // If an item has a real IP cost, reduction can never make it lower than 1.
    // If base cost is 0/missing, keep it 0 so broken data stays obvious.
    const final = base > 0
      ? Math.max(1, base - reduction)
      : 0;

    const applied = Math.max(0, base - final);

    return {
      baseIpCost: base,
      ipReductionValue: reduction,
      ipReductionApplied: applied,
      ipCost: final,
      finalIpCost: final,

      costRawOriginal: `${base} IP`,
      costRaw: `${final} IP`,
      costRawFinal: `${final} IP`,

      wasReduced: applied > 0
    };
  }

  function normalizeItemType(item) {
    const props = getProps(item);
    return toLower(
      props.item_type ??
      item?.system?.item_type ??
      item?.type ??
      ""
    );
  }

  function isRecipeItem(item) {
    return normalizeItemType(item) === "recipe";
  }

  function isConsumableItem(item) {
    return normalizeItemType(item) === "consumable";
  }

  function isWorldItem(item) {
    return String(item?.uuid ?? "").startsWith("Item.");
  }

  function isBadDocumentUuid(value) {
    const s = safeString(value);
    if (!s) return true;
    if (s === "ERROR") return true;
    if (s.includes("${")) return true;
    return false;
  }

  function clonePlain(value, fallback = {}) {
    try {
      if (value == null) return foundry.utils.deepClone(fallback);
      return foundry.utils.deepClone(value);
    } catch {
      if (Array.isArray(value)) return [...value];
      if (value && typeof value === "object") return { ...value };
      return fallback;
    }
  }

  function extractUuid(entry) {
    if (!entry) return "";

    if (typeof entry === "string") {
      return entry.trim();
    }

    return safeString(
      entry.uuid ??
      entry.itemUuid ??
      entry.item_uuid ??
      entry.recipeUuid ??
      entry.recipe_uuid ??
      entry.documentUuid ??
      entry.document_uuid ??
      ""
    );
  }

  async function resolveDocument(uuidOrDoc) {
    if (!uuidOrDoc) return null;
    if (typeof uuidOrDoc !== "string") return uuidOrDoc;

    try {
      return await fromUuid(uuidOrDoc);
    } catch (e) {
      warn("fromUuid failed.", {
        uuid: uuidOrDoc,
        error: String(e?.message ?? e)
      });
      return null;
    }
  }

  async function resolveActor(actorOrUuid) {
    if (!actorOrUuid) return null;

    const doc = await resolveDocument(actorOrUuid);
    if (!doc) return null;

    if (doc.documentName === "Actor" || doc.constructor?.name === "Actor") return doc;
    if (doc.actor) return doc.actor;
    if (doc.object?.actor) return doc.object.actor;
    if (doc.token?.actor) return doc.token.actor;
    if (doc.document?.actor) return doc.document.actor;

    return null;
  }

  function actorLabel(actor) {
    if (!actor) return "(none)";
    return `${actor.name ?? "(unnamed)"} <${actor.uuid ?? actor.id ?? "no-uuid"}>`;
  }

  // --------------------------------------------------------------------------
  // Central party / database actor
  // --------------------------------------------------------------------------

  async function getCurrentGameSourceActor() {
    const resolver = globalThis.FUCompanion?.api?.getCurrentGameDb;

    if (typeof resolver !== "function") {
      warn("DB Resolver API not found. Party recipes will be skipped.");
      return null;
    }

    try {
      const result = await resolver();
      const source = result?.source ?? result?.db ?? null;

      if (!source) {
        warn("DB Resolver returned no source/db actor.", { result });
        return null;
      }

      log("Resolved current game source actor.", {
        actor: actorLabel(source),
        gameName: result?.gameName ?? null
      });

      return source;
    } catch (e) {
      err("Failed to resolve current game source actor.", e);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Recipe collection
  // --------------------------------------------------------------------------

  function getRecipeTableEntriesFromActor(actor) {
    const props = actor?.system?.props ?? {};

    const possibleTables = [
      props.recipe_list,
      props.recipes,
      props.recipe_inventory,
      props.known_recipe_list,
      props.item_recipe_list
    ];

    const entries = [];

    for (const table of possibleTables) {
      for (const entry of asObjectValues(table)) {
        entries.push(entry);
      }
    }

    return entries;
  }

  async function collectRecipeDocsFromActor(actor, sourceLabel = "actor") {
    const out = [];

    if (!actor) return out;

    // A) Embedded recipe items directly owned by the actor.
    for (const item of Array.from(actor.items ?? [])) {
      if (!isRecipeItem(item)) continue;

      out.push({
        recipe: item,
        ownerActor: actor,
        source: `${sourceLabel}.items`
      });
    }

    // B) Recipe table entries that point to item UUIDs.
    const tableEntries = getRecipeTableEntriesFromActor(actor);

    for (const entry of tableEntries) {
      const uuid = extractUuid(entry);
      if (!uuid) continue;

      const doc = await resolveDocument(uuid);
      if (!doc || !isRecipeItem(doc)) continue;

      out.push({
        recipe: doc,
        ownerActor: actor,
        source: `${sourceLabel}.recipe_table`
      });
    }

    const unique = uniqueBy(out, row => row.recipe?.uuid);

    log("Collected recipe docs from actor.", {
      sourceLabel,
      actor: actorLabel(actor),
      count: unique.length,
      recipes: unique.map(r => ({
        name: r.recipe?.name,
        uuid: r.recipe?.uuid,
        source: r.source
      }))
    });

    return unique;
  }

  async function collectKnownRecipes({ actor = null, includeParty = true } = {}) {
    const actingActor = await resolveActor(actor);
    const all = [];

    if (actingActor) {
      all.push(...await collectRecipeDocsFromActor(actingActor, "actor"));
    }

    if (includeParty) {
      const partyActor = await getCurrentGameSourceActor();

      // Avoid double-reading the same actor.
      if (partyActor && partyActor.uuid !== actingActor?.uuid) {
        all.push(...await collectRecipeDocsFromActor(partyActor, "party"));
      }
    }

    const unique = uniqueBy(all, row => row.recipe?.uuid);

    log("Collected known recipes.", {
      actingActor: actorLabel(actingActor),
      includeParty,
      count: unique.length,
      recipes: unique.map(r => ({
        name: r.recipe?.name,
        uuid: r.recipe?.uuid,
        source: r.source,
        owner: r.ownerActor?.name ?? null
      }))
    });

    return unique;
  }

  // --------------------------------------------------------------------------
  // Related item / active skill collection
  // --------------------------------------------------------------------------

  function getRelatedItemEntries(recipeItem) {
    const props = getProps(recipeItem);

    const related =
      props.related_item_list ??
      props.related_items ??
      props.unlocked_item_list ??
      props.creatable_item_list ??
      {};

    return asObjectValues(related);
  }

  function normalizeActiveSkillEntry(item, entry, key = "") {
    if (!entry) return null;

    // If the table stores a direct UUID string, keep it.
    if (typeof entry === "string") {
      if (!isBadDocumentUuid(entry)) return entry;

      // Fallback: if the row key is an item ID, recover it as a world item UUID.
      if (key && !isBadDocumentUuid(key)) return `Item.${key}`;
      return null;
    }

    const out = clonePlain(entry, {});
    const rawUuid = extractUuid(out);

    // Some older item containers store "ERROR" in uuid,
    // but the row key is still the actual skill item ID.
    if (isBadDocumentUuid(rawUuid)) {
      if (key && !isBadDocumentUuid(key)) {
        out.uuid = `Item.${key}`;
        out.__recoveredUuidFromRowKey = true;
      }
    }

    return extractUuid(out) ? out : null;
  }

  function getActiveSkillEntries(item) {
    const props = getProps(item);

    const container =
      props.item_skill_active ??
      props.active_skill_list ??
      props.skill_active_list ??
      {};

    if (!container || typeof container !== "object") return [];

    return Object.entries(container)
      .map(([key, entry]) => normalizeActiveSkillEntry(item, entry, key))
      .filter(entry => !!extractUuid(entry));
  }

  // --------------------------------------------------------------------------
  // Default creatable items
  // --------------------------------------------------------------------------

  function getDefaultCreatableDefinitions() {
    return DEFAULT_CREATABLE_ITEMS
      .filter(def => def?.enabled !== false)
      .map(def => clonePlain(def, {}));
  }

  async function resolveDefaultItemDocument(def) {
    const uuidCandidates = [
      def?.itemUuid,
      def?.itemId ? `Item.${def.itemId}` : ""
    ].filter(Boolean);

    for (const uuid of uuidCandidates) {
      const doc = await resolveDocument(uuid);
      if (doc) return doc;
    }

    // Name fallback makes the default list easier to repair if item IDs change.
    const fallbackName = safeString(def?.fallbackName ?? def?.displayName);
    if (fallbackName) {
      const byName = game.items?.find?.(item => {
        return (
          item?.name === fallbackName &&
          normalizeItemType(item) === "consumable"
        );
      });

      if (byName) {
        warn("Default creatable item UUID failed, recovered by name.", {
          key: def?.key,
          fallbackName,
          recoveredUuid: byName.uuid
        });
        return byName;
      }
    }

    return null;
  }

  async function collectDefaultCreatableItems({ actor = null } = {}) {
    const out = [];

    for (const def of getDefaultCreatableDefinitions()) {
      const item = await resolveDefaultItemDocument(def);

      if (!item) {
        warn("Default creatable item could not be resolved.", def);
        continue;
      }

      const itemProps = getProps(item);
      const itemType = normalizeItemType(item);

      if (itemType && itemType !== "consumable") {
        warn("Default creatable item is not consumable. Skipping.", {
          key: def?.key,
          itemName: item?.name,
          itemUuid: item?.uuid,
          itemType
        });
        continue;
      }

      const baseIpCost = parseIpCost(
        def?.ipCost,
        itemProps.ip_cost
      );

      const ipCostInfo = buildReducedIpCost(baseIpCost, actor);
      const ipCost = ipCostInfo.ipCost;

      const activeSkillEntries = getActiveSkillEntries(item);

      if (!activeSkillEntries.length) {
        warn("Default creatable item has no active skills wired.", {
          key: def?.key,
          itemName: item?.name,
          itemUuid: item?.uuid
        });
      }

      const descriptionHtml = itemProps.description ?? "";
      const displayName = safeString(def?.displayName, item?.name ?? "Unknown Item");

      out.push({
        // Display
        name: displayName,
        img: item?.img ?? "icons/svg/item-bag.svg",
        descriptionHtml,
        descriptionText: htmlToPlainText(descriptionHtml),

        // Cost
        baseIpCost: ipCostInfo.baseIpCost,
        ipCost,
        finalIpCost: ipCostInfo.finalIpCost,

        ipReductionValue: ipCostInfo.ipReductionValue,
        ipReductionApplied: ipCostInfo.ipReductionApplied,

        costRawOriginal: ipCostInfo.costRawOriginal,
        costRaw: ipCostInfo.costRaw,
        costRawFinal: ipCostInfo.costRawFinal,

        // Creatable item
        item,
        itemUuid: item?.uuid ?? def?.itemUuid ?? null,
        itemId: item?.id ?? null,
        itemName: item?.name ?? displayName,
        itemProps,

        // Default source marker
        isDefaultCreatable: true,
        defaultKey: def?.key ?? null,
        defaultSort: Number(def?.sort ?? 999) || 999,

        // Recipe-like fields stay present so Item.js does not need special logic.
        recipe: null,
        recipeUuid: null,
        recipeId: null,
        recipeName: "Default Item",
        recipeOwnerActorUuid: null,
        recipeOwnerActorName: null,
        recipeSource: "default",

        // Skills inside the consumable item
        activeSkillEntries,

        key: `default::${safeString(def?.key, displayName)}::${item?.uuid ?? ""}`
      });
    }

    log("Built default creatable item list.", {
      count: out.length,
      items: out.map(c => ({
        name: c.name,
        itemUuid: c.itemUuid,
        ipCost: c.ipCost,
        activeSkills: c.activeSkillEntries.length
      }))
    });

    return out;
  }

  // --------------------------------------------------------------------------
  // Candidate helpers
  // --------------------------------------------------------------------------

  function candidateSort(a, b) {
    const an = safeString(a?.name).toLowerCase();
    const bn = safeString(b?.name).toLowerCase();
    return an.localeCompare(bn);
  }

  function preferCandidate(current, next) {
    if (!current) return next;

    const currentIsWorld = isWorldItem(current.item);
    const nextIsWorld = isWorldItem(next.item);

    // Prefer world item templates over embedded actor item copies.
    if (!currentIsWorld && nextIsWorld) return next;

    // Prefer candidate with active skills.
    const currentSkills = current.activeSkillEntries?.length ?? 0;
    const nextSkills = next.activeSkillEntries?.length ?? 0;
    if (nextSkills > currentSkills) return next;

    return current;
  }

  // --------------------------------------------------------------------------
  // Main creatable item collection
  // --------------------------------------------------------------------------

  async function getCreatableItems({
    actor = null,
    includeParty = true,
    includeDefault = true,
    includeRecipeWithoutRelatedItems = false
  } = {}) {
    const actingActor = await resolveActor(actor);
    const recipeRows = await collectKnownRecipes({ actor: actingActor, includeParty });

    const byDisplayKey = new Map();

    // A) Default Fabula Ultima creatable items.
    if (includeDefault) {
      const defaultCandidates = await collectDefaultCreatableItems({
  actor: actingActor
});

      for (const candidate of defaultCandidates) {
        const displayKey = `${safeString(candidate.name).toLowerCase()}::${candidate.ipCost}`;
        const current = byDisplayKey.get(displayKey);
        byDisplayKey.set(displayKey, preferCandidate(current, candidate));
      }
    }

    // B) Recipe-unlocked creatable items.
    for (const recipeRow of recipeRows) {
      const recipe = recipeRow.recipe;
      const recipeProps = getProps(recipe);
      const relatedEntries = getRelatedItemEntries(recipe);

      if (!relatedEntries.length) {
        if (includeRecipeWithoutRelatedItems) {
          warn("Recipe has no related_item_list.", {
            recipe: recipe?.name,
            uuid: recipe?.uuid
          });
        }
        continue;
      }

      for (const relatedEntry of relatedEntries) {
        const relatedUuid = extractUuid(relatedEntry);
        if (!relatedUuid) continue;

        const item = await resolveDocument(relatedUuid);
        if (!item) {
          warn("Could not resolve related item.", {
            recipe: recipe?.name,
            relatedUuid
          });
          continue;
        }

        const itemType = normalizeItemType(item);

        // If the item has an item_type and it is not consumable, skip it.
        // If item_type is missing, allow it but log a warning.
        if (itemType && itemType !== "consumable") {
          log("Skipping related item because it is not consumable.", {
            item: item?.name,
            itemType,
            uuid: item?.uuid
          });
          continue;
        }

        if (!itemType) {
          warn("Related item has no item_type. Allowing it, but check the item sheet.", {
            item: item?.name,
            uuid: item?.uuid
          });
        }

        const itemProps = getProps(item);

        const baseIpCost = parseIpCost(
          relatedEntry.ip_cost,
          relatedEntry.ipCost,
          recipeProps.ip_cost,
          recipeProps.recipe_ip_cost,
          itemProps.ip_cost
        );

        const ipCostInfo = buildReducedIpCost(baseIpCost, actingActor);
        const ipCost = ipCostInfo.ipCost;

        const activeSkillEntries = getActiveSkillEntries(item);

        const descriptionHtml =
          relatedEntry.related_item_description ??
          relatedEntry.description ??
          itemProps.description ??
          "";

        const candidate = {
          // Display
          name: safeString(relatedEntry.name, item?.name ?? "Unknown Item"),
          img: item?.img ?? "icons/svg/item-bag.svg",
          descriptionHtml,
          descriptionText: htmlToPlainText(descriptionHtml),

          // Cost
          baseIpCost: ipCostInfo.baseIpCost,
          ipCost,
          finalIpCost: ipCostInfo.finalIpCost,

          ipReductionValue: ipCostInfo.ipReductionValue,
          ipReductionApplied: ipCostInfo.ipReductionApplied,

          costRawOriginal: ipCostInfo.costRawOriginal,
          costRaw: ipCostInfo.costRaw,
          costRawFinal: ipCostInfo.costRawFinal,

          // Creatable item
          item,
          itemUuid: item?.uuid ?? relatedUuid,
          itemId: item?.id ?? null,
          itemName: item?.name ?? safeString(relatedEntry.name, "Unknown Item"),
          itemProps,

          // Recipe source
          recipe,
          recipeUuid: recipe?.uuid ?? null,
          recipeId: recipe?.id ?? null,
          recipeName: recipe?.name ?? "Unknown Recipe",
          recipeOwnerActorUuid: recipeRow.ownerActor?.uuid ?? null,
          recipeOwnerActorName: recipeRow.ownerActor?.name ?? null,
          recipeSource: recipeRow.source,

          // Skills inside the consumable item
          activeSkillEntries,

          // Useful for Item.js map lookup
          key: `recipe::${recipe?.id ?? recipe?.uuid ?? "recipe"}::${item?.id ?? item?.uuid ?? relatedUuid}::${ipCost}`
        };

        const displayKey = `${safeString(candidate.name).toLowerCase()}::${candidate.ipCost}`;
        const current = byDisplayKey.get(displayKey);
        byDisplayKey.set(displayKey, preferCandidate(current, candidate));
      }
    }

    const result = Array.from(byDisplayKey.values()).sort((a, b) => {
      const ad = Number(a?.defaultSort ?? 9999) || 9999;
      const bd = Number(b?.defaultSort ?? 9999) || 9999;

      // Default items first, then recipe items.
      if (ad !== bd) return ad - bd;

      return candidateSort(a, b);
    });

    log("Built creatable item list.", {
      actingActor: actorLabel(actingActor),
      count: result.length,
      items: result.map(c => ({
        name: c.name,
        ipCost: c.ipCost,
        itemUuid: c.itemUuid,
        recipeName: c.recipeName,
        recipeUuid: c.recipeUuid,
        defaultKey: c.defaultKey ?? null,
        activeSkills: c.activeSkillEntries.length
      }))
    });

    return result;
  }

  // --------------------------------------------------------------------------
  // Payload builder for Item.js → ActionDataFetch
  // --------------------------------------------------------------------------

  function buildCreatePayload({
    actor,
    candidate,
    skillItem,
    targets = []
  } = {}) {
    if (!actor) throw new Error("ItemCreate.buildCreatePayload requires actor.");
    if (!candidate) throw new Error("ItemCreate.buildCreatePayload requires candidate.");
    if (!skillItem) throw new Error("ItemCreate.buildCreatePayload requires skillItem.");

    // Use the original/base IP cost if available, then apply actor IP reduction again.
    // This makes the payload safe even if the actor's reduction changed after the dialog opened.
    const baseIpCost = parseIpCost(
      candidate.baseIpCost ??
      candidate.ipCost
    );

    const ipCostInfo = buildReducedIpCost(baseIpCost, actor);

    const ipCost = ipCostInfo.ipCost;
    const costRawOriginal = ipCostInfo.costRawOriginal;
    const costRawFinal = ipCostInfo.costRawFinal;

    const safeTargets = Array.from(
      new Set((Array.isArray(targets) ? targets : []).filter(Boolean).map(String))
    );

    const itemCreateData = {
      enabled: true,
      mode: "create",

      recipeUuid: candidate.recipeUuid,
      recipeName: candidate.recipeName,

      isDefaultCreatable: !!candidate.isDefaultCreatable,
      defaultKey: candidate.defaultKey ?? null,

      createdItemUuid: candidate.itemUuid,
      createdItemId: candidate.itemId ?? null,
      createdItemName: candidate.itemName ?? candidate.name,

      // IP cost data
      baseIpCost: ipCostInfo.baseIpCost,
      ipCost,
      finalIpCost: ipCostInfo.finalIpCost,

      ipReductionValue: ipCostInfo.ipReductionValue,
      ipReductionApplied: ipCostInfo.ipReductionApplied,

      costRawOriginal,
      costRaw: costRawFinal,
      costRawFinal,

      consumeQuantity: false
    };

    return {
      // Keep same entry point as normal item usage.
      source: "Item",

      // ActionDataFetch currently reads this field name.
      attacker_uuid: actor.uuid,

      // Actual active skill wired inside the created item.
      skillUuid: skillItem.uuid,

      // Created item identity.
      itemUuid: candidate.itemUuid,
      itemName: candidate.itemName ?? candidate.name,

      // New mode markers.
      itemUseMode: "create",

      itemCreate: itemCreateData,

      // Put the final reduced cost where ResourceGate already knows how to read it.
      meta: {
        itemUseMode: "create",

        // Original cost is kept for debugging/card history.
        costRawOriginal,

        // costRaw can show the base/original value.
        costRaw: costRawOriginal,

        // costRawFinal is the real amount ResourceGate should check/spend.
        costRawFinal,

        itemCreate: itemCreateData
      },

      // Targets, or empty if ActionDataFetch/Targeting should handle it later.
      targets: safeTargets
    };
  }

  // --------------------------------------------------------------------------
  // Debug helper
  // --------------------------------------------------------------------------

  async function debugSnapshot({ actor = null } = {}) {
    const actingActor = await resolveActor(actor);
    const partyActor = await getCurrentGameSourceActor();
    const defaultItems = await collectDefaultCreatableItems({
  actor: actingActor
});
    const recipes = await collectKnownRecipes({ actor: actingActor, includeParty: true });
    const creatableItems = await getCreatableItems({
      actor: actingActor,
      includeParty: true,
      includeDefault: true
    });

    const snapshot = {
      actor: actingActor ? {
        name: actingActor.name,
        uuid: actingActor.uuid
      } : null,

      partyActor: partyActor ? {
        name: partyActor.name,
        uuid: partyActor.uuid
      } : null,

      defaultItems: defaultItems.map(c => ({
        name: c.name,
        itemUuid: c.itemUuid,
        ipCost: c.ipCost,
        baseIpCost: c.baseIpCost,
ipCost: c.ipCost,
ipReductionValue: c.ipReductionValue,
ipReductionApplied: c.ipReductionApplied,
        activeSkillCount: c.activeSkillEntries.length
      })),

      recipes: recipes.map(r => ({
        name: r.recipe?.name ?? null,
        uuid: r.recipe?.uuid ?? null,
        source: r.source,
        owner: r.ownerActor?.name ?? null,
        relatedCount: getRelatedItemEntries(r.recipe).length
      })),

      creatableItems: creatableItems.map(c => ({
        name: c.name,
        itemUuid: c.itemUuid,
        ipCost: c.ipCost,
        recipeName: c.recipeName,
        recipeUuid: c.recipeUuid,
        isDefaultCreatable: !!c.isDefaultCreatable,
        defaultKey: c.defaultKey ?? null,
        baseIpCost: c.baseIpCost,
ipCost: c.ipCost,
ipReductionValue: c.ipReductionValue,
ipReductionApplied: c.ipReductionApplied,
        activeSkillCount: c.activeSkillEntries.length
      }))
    };

    console.log(TAG, "DEBUG SNAPSHOT", snapshot);
    return snapshot;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const api = {
    getCurrentGameSourceActor,

    collectKnownRecipes,

    getDefaultCreatableDefinitions,
    collectDefaultCreatableItems,

    getCreatableItems,
    getActiveSkillEntries,
    buildCreatePayload,
    debugSnapshot,

utils: {
  getProps,
  isRecipeItem,
  isConsumableItem,
  parseIpCost,
  getActorIpReductionValue,
  buildReducedIpCost,
  htmlToPlainText,
  resolveActor,
  resolveDocument
}
  };

  exposeApi(api);
})();