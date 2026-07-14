// ============================================================================
// Cooking System — API
//
// Public API:  FUCompanion.api.cooking
//   .getConfig()                            → resolved config
//   .resolve(contributions, opts)           → pure resolver, no side effects
//   .applyDish(dishUuid, targetActorUuids)  → food-AE slot logic (GM context)
//   .start(options)                         → full hot-pot session (GM context)
//   .describeItem(item)                     → contribution descriptor
//   .proceed(sessionId)                     → resolve a waiting proceed gate
//
// Socket messages (cooking-ui.js handles the visual side):
//   GM → ALL:    COOKING_PANEL_OPEN  { sessionId, entries, cookerActorId }
//   PLAYER → ALL: COOKING_HOVER     { sessionId, actorId, itemImg, itemName, itemTaste, itemTaste2, isSelect? }
//   PLAYER → GM:  COOKING_LOCK      { sessionId, actorId, itemId, itemImg, itemName }
//   GM → ALL:    COOKING_STATE      { sessionId, slots, tasteValues }
//   GM → ALL:    COOKING_ANIMATE    { sessionId, contributions }
//   GM → ALL:    COOKING_RESULTS    { sessionId, outcome }
//   GM → ALL:    COOKING_CLOSE      { sessionId }
//   GM → ALL:    COOKING_SFX        { sessionId, sfx: "START"|"EAT" }
//   PLAYER → GM: COOKING_PROCEED    { sessionId, userId }
// ============================================================================
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const TAG = "[FUCompanion][Cooking]";
  const GUARD = "__ONI_COOKING_API__";
  if (window[GUARD]) return;
  window[GUARD] = true;

  const TASTES = ["bitter", "salty", "sour", "sweet", "umami"];

  // ── Config ─────────────────────────────────────────────────────────────────
  const DEFAULT_CONFIG = {
    matrix: {},
    recipes: [],
    mysteryDishId: null,
    goopDishId: null,
    tierBreakpoints: [8, 12],
    weirdThreshold: 2,
    tastePoints: { primary: 2, secondary: 1 },
    rarityPotency: { Common: 1, Uncommon: 2, Rare: 3, Legendary: 4 },
    cookerCheck: {
      attrA: "INS", attrB: "DEX", helperDl: 10,
      bands: [
        { max: 6, potency: -1 }, { max: 12, potency: 0 },
        { max: 15, potency: 1 }, { max: 9999, potency: 2 },
      ],
      critPotency: 2, fumbleWeird: 1,
    },
    pickTimeoutMs: 120_000,
  };

  function getConfig() {
    const item = game.items?.find?.(i => i.name === "_Cooking Config");
    const flags = item?.getFlag?.(MODULE_ID, "cookingConfig") ?? {};
    return foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_CONFIG), flags, { inplace: false });
  }

  // ── Descriptors ────────────────────────────────────────────────────────────
  function describeItem(item, actorUuid = null) {
    let p = item?.system?.props ?? {};
    if (!p.isIngredient) {
      const world = game.items?.find?.(i => i.name === item?.name && i.system?.props?.item_type === "material");
      if (world?.system?.props?.isIngredient) p = world.system.props;
    }
    return {
      name: item?.name ?? "?",
      taste: String(p.ingredient_taste ?? "").toLowerCase(),
      taste2: String(p.ingredient_taste2 ?? "").toLowerCase(),
      rarity: String(p.item_rarity ?? "Common"),
      isIngredient: !!p.isIngredient,
      actorUuid,
      itemUuid: item?.uuid ?? null,
    };
  }

  function _materialChoices(actor) {
    return (actor?.items ?? [])
      .filter(i => (parseInt(i.system?.props?.item_quantity) || 0) > 0)
      .map(i => ({ i, d: describeItem(i) }))
      .filter(({ d }) => d.isIngredient)
      .map(({ i, d }) => {
        const taste  = d.taste  && TASTES.includes(d.taste)  ? d.taste  : null;
        const taste2 = d.taste2 && TASTES.includes(d.taste2) ? d.taste2 : null;
        const rawDesc = String(i.system?.props?.description ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
        return {
          id: i.id,
          name: i.name,
          img: i.img || "icons/svg/item-bag.svg",
          taste, taste2,
          rarity: d.rarity || "Common",
          qty: parseInt(i.system?.props?.item_quantity) || 0,
          description: rawDesc,
        };
      });
  }

  // ── Recipes ────────────────────────────────────────────────────────────────
  // A recipe entry accepts either an already-flat name list (`ingredientNames`,
  // used by recipe ITEMS whose CSB itemContainer can only hold one row per item)
  // or a counted list (`ingredients: [{ name, qty }]`, used by _Cooking Config).
  // Counted entries expand to repeated names so a pot of 4 Jellopy can match a
  // "Jellopy x4" recipe — the matcher below compares exact multisets.
  function _recipeIngredientNames(r) {
    if (Array.isArray(r?.ingredients) && r.ingredients.length) {
      return r.ingredients.flatMap(row => {
        const name = row?.name;
        const qty = Math.max(1, parseInt(row?.qty) || 1);
        return name ? Array(qty).fill(name) : [];
      });
    }
    return [...(r?.ingredientNames ?? [])].filter(Boolean);
  }

  // ── Pure resolver ──────────────────────────────────────────────────────────
  function resolve(contributions, opts = {}) {
    const cfg = opts.config ?? getConfig();
    const rng = opts.rng ?? Math.random;
    const check = opts.cookerCheck ?? null;
    // Config recipes are intrinsic to the system (nobody has to "know" them);
    // knownRecipes are the actor-owned recipe-item path.
    const recipes = [...(cfg.recipes ?? []), ...(opts.knownRecipes ?? [])];
    const contribs = (contributions ?? []).filter(Boolean);
    const breakdown = [];

    let potencyMod = 0, fumbleWeird = 0;
    if (check) {
      if (check.isFumble) {
        // A fumble always ruins the pot (see the goop gate below), so the
        // weirdness bump is bookkeeping only — don't narrate it twice.
        fumbleWeird = cfg.cookerCheck.fumbleWeird;
      } else if (check.isCrit) {
        potencyMod = cfg.cookerCheck.critPotency;
        breakdown.push(`Critical cooking! +${potencyMod} potency`);
      } else {
        const band = cfg.cookerCheck.bands.find(b => check.total <= b.max);
        potencyMod = band?.potency ?? 0;
        if (potencyMod) breakdown.push(`Cooker check ${check.total} → ${potencyMod > 0 ? "+" : ""}${potencyMod} potency`);
      }
    }

    // Exact recipe match (bypasses the taste math and the weirdness/goop check).
    // A fumbled cooker check ruins even a unique recipe, so skip matching there.
    const potNames = contribs.map(c => c.name).sort();
    if (!check?.isFumble) {
      for (const r of recipes) {
        const req = _recipeIngredientNames(r).sort();
        if (req.length && req.length === potNames.length && req.every((n,i) => n === potNames[i])) {
          breakdown.push(`Recipe match: ${r.name}`);
          const dishId = r.dishUuid ?? r.dishId ?? null;
          return { kind: "recipe", dishId, recipeName: r.name, potency: null, weirdness: 0, breakdown };
        }
      }
    }

    let weirdness = fumbleWeird;
    const points = Object.fromEntries(TASTES.map(t => [t, 0]));
    let potency = potencyMod;
    for (const c of contribs) {
      const rp = cfg.rarityPotency[c.rarity] ?? 1;
      potency += rp;
      if (!c.isIngredient || c.taste === "weird" || !TASTES.includes(c.taste)) {
        weirdness += 1;
        breakdown.push(`${c.name}: weird (+1 weirdness, +${rp} potency)`);
        continue;
      }
      points[c.taste] += cfg.tastePoints.primary;
      let line = `${c.name}: ${c.taste} +${cfg.tastePoints.primary}`;
      if (c.taste2 && TASTES.includes(c.taste2)) {
        points[c.taste2] += cfg.tastePoints.secondary;
        line += `, ${c.taste2} +${cfg.tastePoints.secondary}`;
      }
      breakdown.push(`${line} (+${rp} potency)`);
    }

    if (check?.isFumble || weirdness >= cfg.weirdThreshold) {
      breakdown.push(check?.isFumble
        ? "Cooker fumbled — the pot is ruined"
        : `Weirdness ${weirdness} ≥ ${cfg.weirdThreshold} — the pot is ruined`);
      return { kind: "goop", dishId: cfg.goopDishId, potency, weirdness, points, breakdown };
    }

    const max = Math.max(...Object.values(points));
    const leaders = TASTES.filter(t => points[t] === max && max > 0);
    if (leaders.length !== 1) {
      breakdown.push(leaders.length === 0 ? "No taste dominates" : `Taste clash: ${leaders.join(" vs ")}`);
      const family = leaders.length ? leaders[Math.floor(rng() * leaders.length)] : TASTES[Math.floor(rng() * TASTES.length)];
      return {
        kind: "mystery", dishId: cfg.mysteryDishId,
        redirectDishId: cfg.matrix?.[family]?.[1] ?? null,
        redirectFamily: family, potency, weirdness, points, breakdown,
      };
    }

    const family = leaders[0];
    const tier = potency >= cfg.tierBreakpoints[1] ? 3 : potency >= cfg.tierBreakpoints[0] ? 2 : 1;
    breakdown.push(`Dominant taste: ${family} — potency ${potency} → tier ${tier}`);
    return { kind: "dish", dishId: cfg.matrix?.[family]?.[tier] ?? null, family, tier, potency, weirdness, points, breakdown };
  }

  // ── applyDish ──────────────────────────────────────────────────────────────
  async function applyDish(dishUuid, targetActorUuids) {
    if (!game.user?.isGM) throw new Error(`${TAG} applyDish requires GM context`);
    const dishId = String(dishUuid).replace(/^Item\./, "");
    const dish = game.items?.get(dishId) ?? await fromUuid(String(dishUuid)).catch(() => null);
    if (!dish) throw new Error(`${TAG} dish not found: ${dishUuid}`);

    const meta = dish.getFlag(MODULE_ID, "cookingDish") ?? {};
    const srcAe = dish.effects?.contents?.[0] ?? null;

    for (const uuid of targetActorUuids) {
      const actor = await fromUuid(String(uuid).startsWith("Actor.") ? String(uuid) : `Actor.${uuid}`).catch(() => null);
      if (!actor) { console.warn(TAG, "applyDish: actor not found", uuid); continue; }

      const oldIds = actor.effects.filter(e => e.getFlag(MODULE_ID, "foodBuff")).map(e => e.id);
      if (oldIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", oldIds);

      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: dish.name, img: dish.img,
        description: srcAe?.description ?? "",
        origin: dish.uuid, disabled: false, transfer: false,
        changes: foundry.utils.deepClone(srcAe?.changes ?? []),
        statuses: ["permanent"],
        system: { tags: ["food"] },
        flags: { [MODULE_ID]: { foodBuff: true, campRestCharges: 1, cookingDish: { dishId: dish.id, ...meta } } },
      }]);

      const shield = Number(meta.instant?.shield ?? 0);
      if (shield > 0) {
        const cur = parseInt(actor.system?.props?.shield_value) || 0;
        await actor.update({ "system.props.shield_value": cur + shield });
      }
    }
    return { dishId: dish.id, dishName: dish.name, targets: targetActorUuids.length };
  }

  // ── Async gates ────────────────────────────────────────────────────────────
  const _pendingLocks   = new Map(); // `${sessionId}:${actorId}` → resolve({ itemId, itemImg, itemName })
  const _pendingProceed = new Map(); // sessionId → resolve(userId)

  function _waitForLock(sessionId, actorId, timeoutMs) {
    return new Promise(resolve => {
      const key = `${sessionId}:${actorId}`;
      const t = setTimeout(() => { _pendingLocks.delete(key); resolve({ itemId: null, itemImg: null, itemName: null }); }, timeoutMs);
      _pendingLocks.set(key, r => { clearTimeout(t); _pendingLocks.delete(key); resolve(r); });
    });
  }

  function _waitForProceed(sessionId, timeoutMs = 300_000) {
    return new Promise(resolve => {
      const t = setTimeout(() => { _pendingProceed.delete(sessionId); resolve(null); }, timeoutMs);
      _pendingProceed.set(sessionId, uid => { clearTimeout(t); _pendingProceed.delete(sessionId); resolve(uid); });
    });
  }

  function proceed(sessionId) {
    _pendingProceed.get(sessionId)?.(game.user?.id);
  }

  // ── Taste values helper (GM session state) ─────────────────────────────────
  const _sessionStates = new Map(); // sessionId → { entries, slots }

  function _computeTastes(sessionId, cfg) {
    const state = _sessionStates.get(sessionId);
    if (!state) return Object.fromEntries(TASTES.map(t => [t, 0]));
    const values = Object.fromEntries(TASTES.map(t => [t, 0]));
    for (const [actorId, slot] of Object.entries(state.slots)) {
      if (!slot.locked || !slot.itemId) continue;
      const entry = state.entries.find(e => e.actorId === actorId);
      const item = entry?.actor?.items?.get(slot.itemId);
      if (!item) continue;
      const d = describeItem(item);
      if (d.isIngredient && d.taste && TASTES.includes(d.taste)) {
        values[d.taste] += cfg.tastePoints.primary;
        if (d.taste2 && TASTES.includes(d.taste2)) values[d.taste2] += cfg.tastePoints.secondary;
      }
    }
    return values;
  }

  // ── Misc helpers ───────────────────────────────────────────────────────────
  function _ownerUserId(actor) {
    const assigned = game.users?.find(u => !u.isGM && u.character?.id === actor?.id);
    if (assigned) return assigned.id;
    return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      const user = game.users?.get(id);
      return id !== "default" && lvl >= 3 && user && !user.isGM;
    })?.[0] ?? null;
  }

  function _gatherKnownRecipes(actors) {
    const recipes = [];
    for (const actor of actors) {
      for (const item of actor?.items ?? []) {
        const p = item.system?.props ?? {};
        if (p.item_type !== "recipe" || p.recipe_kind !== "cooking") continue;
        const dishUuid = String(p.recipe_dish_uuid ?? "").trim();
        if (!dishUuid) continue;
        const ingredientNames = Object.values(p.related_item_list ?? {}).map(r => r?.name).filter(Boolean);
        if (!ingredientNames.length) continue;
        recipes.push({ name: item.name, dishUuid, ingredientNames });
      }
    }
    return recipes;
  }

  async function _consume(actor, item) {
    const qty = parseInt(item.system?.props?.item_quantity) || 0;
    if (qty > 1) await item.update({ "system.props.item_quantity": String(qty - 1) });
    else await item.delete();
  }

  // ── devSim ─────────────────────────────────────────────────────────────────
  // Simulates a complete cooking loop from a single GM client.
  // GM picks ingredients one character at a time via the normal picker UI.
  // Uses the real group check flow; ingredients NOT consumed by default.
  // opts: { consume:false, apply:true, cookerUuid }
  async function devSim(opts = {}) {
    if (!game.user?.isGM) { ui.notifications?.error("devSim: GM only"); return; }
    const cfg = getConfig();
    const hasDishes = Object.values(cfg.matrix ?? {}).some(t => Object.values(t ?? {}).some(Boolean));
    if (!hasDishes) { ui.notifications?.warn("Cooking: no dish content configured."); return; }

    const sessionId = foundry.utils.randomID();
    ui.notifications?.info("🍲 devSim: pick ingredients for each character…");

    // --- gather party entries ---
    let entries = (await globalThis.CampSystem?.Party?.resolve?.()) ?? [];
    for (const e of entries) {
      const u = e.userId ? game.users?.get(e.userId) : null;
      if (!u || u.isGM) e.userId = _ownerUserId(e.actor);
    }
    if (!entries.length) { ui.notifications?.error("devSim: no party members found."); return; }

    const cookerUuid = String(opts.cookerUuid ?? entries[0].actor.uuid);
    const cookerId   = cookerUuid.replace(/^Actor\./, "");
    const cooker     = game.actors.get(cookerId);

    // --- session state ---
    const sessionState = { entries, slots: {} };
    _sessionStates.set(sessionId, sessionState);

    const panelEntries = entries.map(e => ({
      actorId: e.actorId, userId: e.userId,
      actorName: e.actor.name,
      portraitUrl: e.actor.img || "icons/svg/mystery-man.svg",
    }));

    // --- open main panel locally (no broadcast) ---
    globalThis.CookingUI?.openMainPanel(sessionId, panelEntries, cookerId);

    // --- sequential picker per character ---
    const allResults = [];
    for (const e of entries) {
      const choices = _materialChoices(e.actor);
      const itemId = await globalThis.CookingUI?.openPicker(sessionId, e.actorId, choices, e.actor.name) ?? null;
      const item = itemId ? e.actor.items.get(itemId) : null;
      const r = { e, itemId: itemId ?? null, itemImg: item?.img ?? null, itemName: item?.name ?? null };
      if (item) {
        sessionState.slots[e.actorId] = { itemId, itemImg: item.img, itemName: item.name, locked: true };
        const tv = _computeTastes(sessionId, cfg);
        globalThis.CookingUI?.applyState(sessionId, sessionState.slots, tv);
      }
      allResults.push(r);
    }

    const picks = allResults
      .filter(r => r.itemId)
      .map(r => ({ entry: r.e, item: r.e.actor.items.get(r.itemId), itemImg: r.itemImg, itemName: r.itemName }))
      .filter(p => p.item);

    if (!picks.length) {
      ui.notifications?.warn("devSim: nobody contributed an ingredient.");
      globalThis.CookingUI?.closeAll();
      _sessionStates.delete(sessionId);
      return null;
    }

    // --- animate ---
    const contributions = picks.map(p => ({
      actorId: p.entry.actorId,
      itemImg: p.itemImg || p.item?.img || "icons/svg/item-bag.svg",
      itemName: p.itemName || p.item?.name || "?",
    }));
    await globalThis.CookingUI?.runAnimation(sessionId, contributions) ?? new Promise(r => setTimeout(r, 1600));
    await new Promise(r => setTimeout(r, 4000));

    // --- real group check ---
    let cookerCheck = null;
    try {
      const gc = await globalThis.ONI?.GroupCheck?.request?.({
        leaderUuid: cooker?.uuid ?? cookerUuid,
        participantMode: "open",
        allActorUuids: entries.map(e => e.actor.uuid),
        attrA: cfg.cookerCheck.attrA, attrB: cfg.cookerCheck.attrB,
        helperDl: cfg.cookerCheck.helperDl, helperBonus: 1, hiddenDl: true,
        label: "🍲 Cooking (Dev Sim)",
      });
      if (gc?.leaderResult) {
        cookerCheck = { total: gc.leaderResult.total, isCrit: !!gc.leaderResult.isCrit, isFumble: !!gc.leaderResult.isFumble };
      }
    } catch (err) { console.warn(TAG, "devSim group check skipped:", err); }

    // --- play cooking start sfx for all clients (fires after group check) ---
    game.socket.emit(SOCKET_CH, { type: "COOKING_SFX", sfx: "START", sessionId });
    globalThis.CookingUI?.playSfx?.("START");

    // --- resolve ---
    const contribDescs = picks.map(p => describeItem(p.item, p.entry.actor.uuid));
    const knownRecipes = _gatherKnownRecipes(entries.map(e => e.actor));
    const outcome = resolve(contribDescs, { config: cfg, cookerCheck, knownRecipes });

    // --- consume (default: false for dev safety) ---
    if (opts.consume === true) {
      for (const p of picks) await _consume(p.entry.actor, p.item);
    }

    // --- apply dish ---
    const applyId = outcome.kind === "mystery" ? (outcome.redirectDishId ?? outcome.dishId) : outcome.dishId;
    let applied = null;
    if (opts.apply !== false && applyId) {
      applied = await applyDish(applyId, entries.map(e => e.actor.uuid));
    }

    // --- build results payload ---
    const dishItem = applied ? game.items.get(applied.dishId) : null;
    const isMyster = outcome.kind === "mystery";
    const dishName  = isMyster ? "Mysterious Hot-Pot" : (dishItem?.name ?? "???");
    const dishImg   = (isMyster ? game.items.get(String(cfg.mysteryDishId))?.img : dishItem?.img) ?? "icons/svg/item-bag.svg";
    const tierStars = outcome.tier ? `<span style="color:#ffd700;font-size:1.25em;letter-spacing:2px">${"★".repeat(outcome.tier)}</span>` : "";
    const kindLabel = outcome.kind === "dish"    ? `${outcome.family.charAt(0).toUpperCase()+outcome.family.slice(1)} ${tierStars}`
                    : outcome.kind === "mystery" ? "🎲 Mystery Pot!"
                    : outcome.kind === "goop"    ? "💀 Abyssal Goop"
                    : "📖 Recipe Match";
    const rawEffect = dishItem?.system?.props?.description ?? "";
    const dishEffect = rawEffect.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const ingredientNames = picks.map(p => ({ actorName: p.entry.actor.name, itemName: p.item.name }));
    const resultsPayload = {
      dishName, dishImg, kindLabel,
      cookerCheck,
      dishEffect,
      ingredientNames,
      kind: outcome.kind,
      breakdown: outcome.breakdown,
    };

    // --- show results locally ---
    globalThis.CookingUI?.showResults(sessionId, resultsPayload);

    // --- wait for proceed ---
    await _waitForProceed(sessionId);

    // --- cleanup ---
    _sessionStates.delete(sessionId);
    globalThis.CookingUI?.closeAll();

    // --- chat card ---
    const contribLines = picks.map(p => `<li><b>${p.entry.actor.name}</b> — ${p.item.name}</li>`).join("");
    await ChatMessage.create({
      speaker: { alias: "Camp Cooking" },
      content: `<div style="border:1px solid #8a4b2d;border-radius:6px;padding:8px">
        <div style="background:rgba(200,100,0,.15);font-size:.72em;font-weight:700;color:#b85c00;padding:2px 6px;border-radius:4px;margin-bottom:6px;display:inline-block">⚙️ DEV SIM — ingredients ${opts.consume === true ? "consumed" : "NOT consumed"}</div>
        <div style="display:flex;align-items:center;gap:8px">
          <img src="${dishImg}" width="36" height="36" style="border:none">
          <div>
            <div style="font-weight:bold">${dishName}${isMyster && dishItem ? ` → ${dishItem.name}` : ""}</div>
            <div style="font-size:.85em;opacity:.8">Cooked by ${cooker?.name ?? "?"}${cookerCheck ? ` (check ${cookerCheck.total}${cookerCheck.isCrit ? ", CRIT!" : cookerCheck.isFumble ? ", FUMBLE" : ""})` : " (no check)"}</div>
          </div>
        </div>
        <ul style="margin:6px 0">${contribLines}</ul>
      </div>`,
    });

    console.log(TAG, "devSim complete:", outcome);
    return { ...outcome, appliedDishId: applied?.dishId ?? null, sessionId };
  }

  // ── start ──────────────────────────────────────────────────────────────────
  async function start(options = {}) {
    if (!game.user?.isGM) throw new Error(`${TAG} start() must run on the GM client`);
    const cfg = getConfig();

    const hasDishes = Object.values(cfg.matrix ?? {}).some(t => Object.values(t ?? {}).some(Boolean));
    if (!hasDishes) {
      ui.notifications?.warn("Cooking: no dish content configured — skipping.");
      return null;
    }

    const sessionId = foundry.utils.randomID();

    // --- gather entries ---
    let entries;
    if (Array.isArray(options.participants) && options.participants.length) {
      entries = [];
      for (const u of options.participants) {
        const actor = await fromUuid(String(u).startsWith("Actor.") ? String(u) : `Actor.${u}`).catch(() => null);
        if (actor) entries.push({ actor, actorId: actor.id, userId: _ownerUserId(actor) });
      }
    } else {
      entries = (await globalThis.CampSystem?.Party?.resolve?.()) ?? [];
    }
    for (const e of entries) {
      const u = e.userId ? game.users?.get(e.userId) : null;
      if (!u || u.isGM) e.userId = _ownerUserId(e.actor);
    }
    if (!entries.length) throw new Error(`${TAG} no participants`);

    const cookerUuid = String(options.cookerUuid ?? entries[0].actor.uuid);
    const cookerId   = cookerUuid.replace(/^Actor\./, "");
    const cooker     = game.actors.get(cookerId);

    // --- session state ---
    const sessionState = { entries, slots: {} };
    _sessionStates.set(sessionId, sessionState);

    const panelEntries = entries.map(e => ({
      actorId: e.actorId, userId: e.userId,
      actorName: e.actor.name,
      portraitUrl: e.actor.img || "icons/svg/mystery-man.svg",
    }));

    // --- open GM's main panel (socket doesn't echo to self) ---
    globalThis.CookingUI?.openMainPanel(sessionId, panelEntries, cookerId);

    // --- register pending locks for active player entries BEFORE broadcasting ---
    const lockWaits = [];
    for (const e of entries) {
      const uid = e.userId && game.users?.get(e.userId)?.active ? e.userId : null;
      if (uid && uid !== game.user.id) {
        lockWaits.push(
          _waitForLock(sessionId, e.actorId, cfg.pickTimeoutMs)
            .then(r => ({ e, ...r }))
        );
      }
    }

    // --- broadcast PANEL_OPEN to all clients ---
    game.socket.emit(SOCKET_CH, { type: "COOKING_PANEL_OPEN", sessionId, entries: panelEntries, cookerActorId: cookerId });

    // --- GM opens pickers locally for offline / GM-owned entries ---
    const gmPickWaits = [];
    for (const e of entries) {
      const uid = e.userId && game.users?.get(e.userId)?.active ? e.userId : null;
      if (!uid || uid === game.user.id) {
        const choices = _materialChoices(e.actor);
        gmPickWaits.push((async () => {
          const itemId = await globalThis.CookingUI?.openPicker(sessionId, e.actorId, choices, e.actor.name) ?? null;
          const item = itemId ? e.actor.items.get(itemId) : null;
          const r = { itemId, itemImg: item?.img ?? null, itemName: item?.name ?? null };
          // Update session state + broadcast STATE
          sessionState.slots[e.actorId] = { ...r, locked: true };
          const tv = _computeTastes(sessionId, cfg);
          game.socket.emit(SOCKET_CH, { type: "COOKING_STATE", sessionId, slots: sessionState.slots, tasteValues: tv });
          globalThis.CookingUI?.applyState(sessionId, sessionState.slots, tv);
          return { e, ...r };
        })());
      }
    }

    const allResults = await Promise.all([...lockWaits, ...gmPickWaits]);

    const picks = allResults
      .map(r => ({ entry: r.e, item: r.itemId ? r.e.actor.items.get(r.itemId) : null, itemImg: r.itemImg, itemName: r.itemName }))
      .filter(p => p.item);

    if (!picks.length) {
      ui.notifications?.warn("Cooking: nobody put anything in the pot.");
      game.socket.emit(SOCKET_CH, { type: "COOKING_CLOSE", sessionId });
      globalThis.CookingUI?.closeAll();
      _sessionStates.delete(sessionId);
      return null;
    }

    // --- animate ---
    const contributions = picks.map(p => ({ actorId: p.entry.actorId, itemImg: p.itemImg || p.item?.img || "icons/svg/item-bag.svg", itemName: p.itemName || p.item?.name || "?" }));
    game.socket.emit(SOCKET_CH, { type: "COOKING_ANIMATE", sessionId, contributions });
    await globalThis.CookingUI?.runAnimation(sessionId, contributions) ?? new Promise(r => setTimeout(r, 1600));

    // 4-second anticipation pause
    await new Promise(r => setTimeout(r, 4000));

    // --- cooker group check ---
    let cookerCheck = null;
    try {
      const gc = await globalThis.ONI?.GroupCheck?.request?.({
        leaderUuid: cooker?.uuid ?? cookerUuid,
        participantMode: "open",
        allActorUuids: entries.map(e => e.actor.uuid),
        attrA: cfg.cookerCheck.attrA, attrB: cfg.cookerCheck.attrB,
        helperDl: cfg.cookerCheck.helperDl, helperBonus: 1, hiddenDl: true,
        label: "🍲 Cooking",
      });
      if (gc?.leaderResult) {
        cookerCheck = { total: gc.leaderResult.total, isCrit: !!gc.leaderResult.isCrit, isFumble: !!gc.leaderResult.isFumble };
      }
    } catch (err) { console.warn(TAG, "Group check skipped:", err); }

    // --- play cooking start sfx for all clients (fires after group check) ---
    game.socket.emit(SOCKET_CH, { type: "COOKING_SFX", sfx: "START", sessionId });
    globalThis.CookingUI?.playSfx?.("START");

    // --- resolve ---
    const contribDescs = picks.map(p => describeItem(p.item, p.entry.actor.uuid));
    const knownRecipes = _gatherKnownRecipes(entries.map(e => e.actor));
    const outcome = resolve(contribDescs, { config: cfg, cookerCheck, knownRecipes });

    // --- consume ---
    for (const p of picks) await _consume(p.entry.actor, p.item);

    // --- apply ---
    const applyId = outcome.kind === "mystery" ? (outcome.redirectDishId ?? outcome.dishId) : outcome.dishId;
    let applied = null;
    if (applyId) applied = await applyDish(applyId, entries.map(e => e.actor.uuid));

    // --- build results payload ---
    const dishItem = applied ? game.items.get(applied.dishId) : null;
    const isMyster = outcome.kind === "mystery";
    const dishName = isMyster ? "Mysterious Hot-Pot" : (dishItem?.name ?? "???");
    const dishImg  = (isMyster ? game.items.get(String(cfg.mysteryDishId))?.img : dishItem?.img) ?? "icons/svg/item-bag.svg";
    const tierStars = outcome.tier ? `<span style="color:#ffd700;font-size:1.25em;letter-spacing:2px">${"★".repeat(outcome.tier)}</span>` : "";
    const kindLabel = outcome.kind === "dish"    ? `${outcome.family.charAt(0).toUpperCase()+outcome.family.slice(1)} ${tierStars}`
                    : outcome.kind === "mystery" ? "🎲 Mystery Pot!"
                    : outcome.kind === "goop"    ? "💀 Abyssal Goop"
                    : "📖 Recipe Match";
    const rawEffect = dishItem?.system?.props?.description ?? "";
    const dishEffect = rawEffect.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const ingredientNames = picks.map(p => ({ actorName: p.entry.actor.name, itemName: p.item.name }));
    const resultsPayload = {
      dishName, dishImg, kindLabel,
      cookerCheck,
      dishEffect,
      ingredientNames,
      kind: outcome.kind,
      breakdown: outcome.breakdown,
    };

    // --- show results ---
    game.socket.emit(SOCKET_CH, { type: "COOKING_RESULTS", sessionId, outcome: resultsPayload });
    globalThis.CookingUI?.showResults(sessionId, resultsPayload);

    // --- wait for proceed ---
    await _waitForProceed(sessionId);

    // --- cleanup + close ---
    _sessionStates.delete(sessionId);
    game.socket.emit(SOCKET_CH, { type: "COOKING_CLOSE", sessionId });
    globalThis.CookingUI?.closeAll();

    // --- chat card ---
    const contribLines = picks.map(p => `<li><b>${p.entry.actor.name}</b> — ${p.item.name}</li>`).join("");
    const detail = outcome.breakdown.map(b => `<div style="opacity:.7;font-size:.85em">${b}</div>`).join("");
    await ChatMessage.create({
      speaker: { alias: "Camp Cooking" },
      content: `<div style="border:1px solid #8a4b2d;border-radius:6px;padding:8px">
        <div style="display:flex;align-items:center;gap:8px">
          <img src="${dishImg}" width="36" height="36" style="border:none">
          <div>
            <div style="font-weight:bold">${dishName}${isMyster && dishItem ? ` → ${dishItem.name}` : ""}</div>
            <div style="font-size:.85em;opacity:.8">Cooked by ${cooker?.name ?? "?"}${cookerCheck ? ` (check ${cookerCheck.total}${cookerCheck.isCrit ? ", CRIT!" : cookerCheck.isFumble ? ", FUMBLE" : ""})` : ""}</div>
          </div>
        </div>
        <ul style="margin:6px 0">${contribLines}</ul>
        ${detail}
      </div>`,
    });

    return { ...outcome, appliedDishId: applied?.dishId ?? null, sessionId };
  }

  // ── Socket handler ─────────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    game.socket?.on(SOCKET_CH, async (msg) => {
      if (!msg || typeof msg !== "object") return;
      const { type, sessionId } = msg;

      // GM-only: resolve pending gates
      if (game.user?.isGM) {
        if (type === "COOKING_LOCK") {
          const key = `${sessionId}:${msg.actorId}`;
          _pendingLocks.get(key)?.({ itemId: msg.itemId ?? null, itemImg: msg.itemImg ?? null, itemName: msg.itemName ?? null });
          // Update session state + broadcast STATE
          const state = _sessionStates.get(sessionId);
          if (state && msg.actorId) {
            state.slots[msg.actorId] = { itemId: msg.itemId ?? null, itemImg: msg.itemImg ?? null, itemName: msg.itemName ?? null, locked: true };
            const tv = _computeTastes(sessionId, getConfig());
            game.socket.emit(SOCKET_CH, { type: "COOKING_STATE", sessionId, slots: state.slots, tasteValues: tv });
            globalThis.CookingUI?.applyState(sessionId, state.slots, tv);
          }
          return;
        }
        if (type === "COOKING_PROCEED") {
          _pendingProceed.get(sessionId)?.(msg.userId ?? null);
          return;
        }
      }

      // All clients
      if (type === "COOKING_PANEL_OPEN") {
        globalThis.CookingUI?.openMainPanel(sessionId, msg.entries, msg.cookerActorId);
        // Player opens picker for their character
        const myEntry = msg.entries?.find(e => e.userId === game.user?.id);
        if (myEntry && !game.user?.isGM) {
          const actor = game.actors?.get(myEntry.actorId);
          const choices = _materialChoices(actor);
          const itemId = await globalThis.CookingUI?.openPicker(sessionId, myEntry.actorId, choices) ?? null;
          const item = actor?.items?.get(itemId);
          game.socket.emit(SOCKET_CH, {
            type: "COOKING_LOCK", sessionId,
            actorId: myEntry.actorId,
            itemId: itemId ?? null,
            itemImg: item?.img ?? null,
            itemName: item?.name ?? null,
          });
        }
      } else if (type === "COOKING_SFX") {
        globalThis.CookingUI?.playSfx?.(msg.sfx);
      } else if (type === "COOKING_HOVER") {
        globalThis.CookingUI?._applyHover(msg.actorId, msg.itemImg, msg.itemName, msg.itemTaste||null, msg.itemTaste2||null, msg.isSelect||false);
      } else if (type === "COOKING_STATE") {
        globalThis.CookingUI?.applyState(sessionId, msg.slots, msg.tasteValues);
      } else if (type === "COOKING_ANIMATE") {
        await globalThis.CookingUI?.runAnimation(sessionId, msg.contributions);
      } else if (type === "COOKING_RESULTS") {
        globalThis.CookingUI?.showResults(sessionId, msg.outcome);
      } else if (type === "COOKING_CLOSE") {
        globalThis.CookingUI?.closeAll();
      }
    });
    console.debug(TAG, "Cooking API loaded.");
  });

  // ── Register API ───────────────────────────────────────────────────────────
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.cooking = { getConfig, resolve, applyDish, start, describeItem, proceed, devSim };
})();
