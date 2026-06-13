// ============================================================================
// Cooking System — API
//
// Public API:  FUCompanion.api.cooking
//   .getConfig()                            → resolved config (defaults ⊕ _Cooking Config item flags)
//   .resolve(contributions, opts)           → pure resolver, NO side effects
//   .applyDish(dishUuid, targetActorUuids)  → food-AE slot logic (GM context)
//   .start(options)                         → full hot-pot session (GM context)
//   .describeItem(item)                     → contribution descriptor from an Item doc
//
// Contribution descriptor:
//   { name, taste, taste2, rarity, isIngredient, actorUuid?, itemUuid? }
//
// resolve() opts:
//   { cookerCheck: { total, isCrit, isFumble } | null,
//     knownRecipes: [{ name, dishUuid, ingredientNames: string[] }],
//     rng: () => number }                   // injectable for tests
//
// Resolution order: exact recipe (bypasses goop + check) → goop (weirdness ≥
// threshold) → clash tie = mystery → taste math (potency sum + check mod).
//
// Food buffs are AEs tagged via flags.<MOD>.foodBuff with campRestCharges: 1
// (survive the rest that follows camp, expire at the next one). One meal slot:
// applying a dish removes any previous foodBuff AE first.
// ============================================================================
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const TAG = "[FUCompanion][Cooking]";
  const GUARD = "__ONI_COOKING_API__";
  if (window[GUARD]) return;
  window[GUARD] = true;

  const MSG = Object.freeze({
    PICK_REQUEST: "COOKING_PICK_REQUEST",   // GM → all (targeted by userId)
    PICK_SUBMIT:  "COOKING_PICK_SUBMIT",    // player → all (GM processes)
  });

  const TASTES = ["bitter", "salty", "sour", "sweet", "umami"];

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    matrix: {},            // { family: { 1: dishId, 2: dishId, 3: dishId } } — from _Cooking Config
    mysteryDishId: null,
    goopDishId: null,
    tierBreakpoints: [8, 12],
    weirdThreshold: 2,
    tastePoints: { primary: 2, secondary: 1 },
    rarityPotency: { Common: 1, Uncommon: 2, Rare: 3, Legendary: 4 },
    cookerCheck: {
      attrA: "INS", attrB: "DEX", helperDl: 10,
      bands: [
        { max: 6, potency: -1 },
        { max: 12, potency: 0 },
        { max: 15, potency: 1 },
        { max: 9999, potency: 2 },
      ],
      critPotency: 2,
      fumbleWeird: 1,
    },
    pickTimeoutMs: 120_000,
  };

  function getConfig() {
    const item = game.items?.find?.(i => i.name === "_Cooking Config");
    const flags = item?.getFlag?.(MODULE_ID, "cookingConfig") ?? {};
    return foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_CONFIG), flags, { inplace: false });
  }

  // ---------------------------------------------------------------------------
  // Descriptors
  // ---------------------------------------------------------------------------
  function describeItem(item, actorUuid = null) {
    let p = item?.system?.props ?? {};
    // Embedded inventory copies usually predate ingredient tagging and never
    // receive prop updates made to world items — the world item by the same
    // name is the source of truth for cooking data.
    if (!p.isIngredient) {
      const worldItem = game.items?.find?.(i => i.name === item?.name && i.system?.props?.item_type === "material");
      if (worldItem?.system?.props?.isIngredient) p = worldItem.system.props;
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

  // ---------------------------------------------------------------------------
  // Pure resolver
  // ---------------------------------------------------------------------------
  function resolve(contributions, opts = {}) {
    const cfg = opts.config ?? getConfig();
    const rng = opts.rng ?? Math.random;
    const check = opts.cookerCheck ?? null;
    const recipes = opts.knownRecipes ?? [];
    const contribs = (contributions ?? []).filter(Boolean);

    const breakdown = [];

    // — cooker check → potency modifier / fumble weirdness
    let potencyMod = 0;
    let fumbleWeird = 0;
    if (check) {
      if (check.isFumble) {
        fumbleWeird = cfg.cookerCheck.fumbleWeird;
        breakdown.push(`Cooker fumbled the check — +${fumbleWeird} weirdness`);
      } else if (check.isCrit) {
        potencyMod = cfg.cookerCheck.critPotency;
        breakdown.push(`Critical cooking! +${potencyMod} potency`);
      } else {
        const band = cfg.cookerCheck.bands.find(b => check.total <= b.max);
        potencyMod = band?.potency ?? 0;
        if (potencyMod) breakdown.push(`Cooker check ${check.total} — ${potencyMod > 0 ? "+" : ""}${potencyMod} potency`);
      }
    }

    // — 1. exact recipe match (multiset of names; bypasses goop AND check)
    const potNames = contribs.map(c => c.name).sort();
    for (const r of recipes) {
      const reqNames = [...(r.ingredientNames ?? [])].sort();
      if (reqNames.length && reqNames.length === potNames.length &&
          reqNames.every((n, i) => n === potNames[i])) {
        breakdown.push(`Recipe match: ${r.name}`);
        return { kind: "recipe", dishId: r.dishUuid, recipeName: r.name, potency: null, weirdness: 0, breakdown };
      }
    }

    // — weirdness + taste points + potency
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

    // — 2. goop gate
    if (weirdness >= cfg.weirdThreshold) {
      breakdown.push(`Weirdness ${weirdness} ≥ ${cfg.weirdThreshold} — the pot is lost`);
      return { kind: "goop", dishId: cfg.goopDishId, potency, weirdness, points, breakdown };
    }

    // — 3. dominance / clash
    const max = Math.max(...Object.values(points));
    const leaders = TASTES.filter(t => points[t] === max && max > 0);
    if (leaders.length !== 1) {
      breakdown.push(leaders.length === 0 ? "No taste dominates" : `Taste clash: ${leaders.join(" vs ")}`);
      const family = leaders.length ? leaders[Math.floor(rng() * leaders.length)] : TASTES[Math.floor(rng() * TASTES.length)];
      const redirect = cfg.matrix?.[family]?.[1] ?? null;
      return {
        kind: "mystery", dishId: cfg.mysteryDishId, redirectDishId: redirect,
        redirectFamily: family, potency, weirdness, points, breakdown,
      };
    }

    // — 4. taste math
    const family = leaders[0];
    const tier = potency >= cfg.tierBreakpoints[1] ? 3 : potency >= cfg.tierBreakpoints[0] ? 2 : 1;
    breakdown.push(`Dominant taste: ${family} — potency ${potency} → tier ${tier}`);
    const dishId = cfg.matrix?.[family]?.[tier] ?? null;
    return { kind: "dish", dishId, family, tier, potency, weirdness, points, breakdown };
  }

  // ---------------------------------------------------------------------------
  // applyDish — one-meal-slot AE application (GM context)
  // ---------------------------------------------------------------------------
  async function applyDish(dishUuid, targetActorUuids, opts = {}) {
    if (!game.user?.isGM) throw new Error(`${TAG} applyDish requires GM context`);
    const dishId = String(dishUuid).replace(/^Item\./, "");
    const dish = game.items?.get(dishId) ?? await fromUuid(String(dishUuid)).catch(() => null);
    if (!dish) throw new Error(`${TAG} dish not found: ${dishUuid}`);

    const meta = dish.getFlag(MODULE_ID, "cookingDish") ?? {};
    const srcAe = dish.effects?.contents?.[0] ?? null;

    for (const uuid of targetActorUuids) {
      const actor = await fromUuid(String(uuid).startsWith("Actor.") ? String(uuid) : `Actor.${uuid}`).catch(() => null);
      if (!actor) { console.warn(TAG, "applyDish: actor not found", uuid); continue; }

      // One meal slot: clear any previous food buff
      const oldIds = actor.effects
        .filter(e => e.getFlag(MODULE_ID, "foodBuff"))
        .map(e => e.id);
      if (oldIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", oldIds);

      // Day-long AE (campRestCharges: 1 → survives tonight's rest, expires at the next)
      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: dish.name,
        img: dish.img,
        description: srcAe?.description ?? "",
        origin: dish.uuid,
        disabled: false,
        transfer: false,
        changes: foundry.utils.deepClone(srcAe?.changes ?? []),
        statuses: ["permanent"],
        system: { tags: ["food"] },
        flags: { [MODULE_ID]: { foodBuff: true, campRestCharges: 1, cookingDish: { dishId: dish.id, ...meta } } },
      }]);

      // Instant effects (Shield pool)
      const shield = Number(meta.instant?.shield ?? 0);
      if (shield > 0) {
        const cur = parseInt(actor.system?.props?.shield_value) || 0;
        await actor.update({ "system.props.shield_value": cur + shield });
      }
    }
    return { dishId: dish.id, dishName: dish.name, targets: targetActorUuids.length };
  }

  // ---------------------------------------------------------------------------
  // Contribution gathering (socket + dialogs)
  // ---------------------------------------------------------------------------
  const _pending = new Map(); // `${sessionId}:${actorId}` → resolve(itemId|null)

  function _materialChoices(actor) {
    return (actor?.items ?? [])
      .filter(i => i.system?.props?.item_type === "material" &&
                   (parseInt(i.system?.props?.item_quantity) || 0) > 0)
      .map(i => {
        const d = describeItem(i);
        const taste = d.isIngredient && d.taste
          ? d.taste.charAt(0).toUpperCase() + d.taste.slice(1)
          : "❓";
        return { id: i.id, label: `${i.name} [${taste}] ×${parseInt(i.system.props.item_quantity) || 0}` };
      });
  }

  async function _promptPick(actor) {
    const choices = _materialChoices(actor);
    if (!choices.length) {
      ui.notifications?.info(`${actor.name} has nothing to put in the pot.`);
      return null;
    }
    const options = choices.map(c => `<option value="${c.id}">${c.label}</option>`).join("");
    return new Promise(res => {
      new Dialog({
        title: `🍲 Cooking — ${actor.name}'s ingredient`,
        content: `<p>Choose one item to add to the hot-pot.<br>
                  <em>Unknown tastes (❓) count as Weird — 2+ weird things ruin the pot!</em></p>
                  <select id="oni-cook-pick" style="width:100%">${options}</select>`,
        buttons: {
          ok: { label: "Into the pot!", callback: (html) => res(html.find("#oni-cook-pick").val() || null) },
          skip: { label: "Contribute nothing", callback: () => res(null) },
        },
        default: "ok",
        close: () => res(null),
      }, { classes: ["dialog", "oni-cook-dialog"] }).render(true);
    });
  }

  function _ownerUserId(actor) {
    // Assigned character is the strongest actor→player mapping; ownership
    // scans can land on GM users, who carry explicit OWNER on most actors.
    const assigned = game.users?.find(u => !u.isGM && u.character?.id === actor?.id);
    if (assigned) return assigned.id;
    return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      const user = game.users?.get(id);
      return id !== "default" && lvl >= 3 && user && !user.isGM;
    })?.[0] ?? null;
  }

  function _waitForPick(sessionId, actorId, timeoutMs) {
    return new Promise(resolveP => {
      const key = `${sessionId}:${actorId}`;
      const timer = setTimeout(() => {
        if (_pending.has(key)) { _pending.delete(key); resolveP(null); }
      }, timeoutMs);
      _pending.set(key, (itemId) => { clearTimeout(timer); _pending.delete(key); resolveP(itemId); });
    });
  }

  Hooks.once("ready", () => {
    // Camp overlays sit at z-index 1200–1500; cooking dialogs must float above
    const style = document.createElement("style");
    style.textContent = `.app.oni-cook-dialog { z-index: 1600 !important; }`;
    document.head.appendChild(style);

    game.socket?.on(SOCKET_CH, async (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === MSG.PICK_REQUEST) {
        if (msg.userId !== game.user?.id) return;
        const actor = game.actors?.get(msg.actorId);
        if (!actor) return;
        const itemId = await _promptPick(actor);
        game.socket.emit(SOCKET_CH, { type: MSG.PICK_SUBMIT, sessionId: msg.sessionId, actorId: msg.actorId, itemId });
      } else if (msg.type === MSG.PICK_SUBMIT) {
        if (!game.user?.isGM) return;
        _pending.get(`${msg.sessionId}:${msg.actorId}`)?.(msg.itemId ?? null);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Recipes known by the party (cooking-kind recipe items in inventories)
  // ---------------------------------------------------------------------------
  function _gatherKnownRecipes(actors) {
    const recipes = [];
    for (const actor of actors) {
      for (const item of actor?.items ?? []) {
        const p = item.system?.props ?? {};
        if (p.item_type !== "recipe" || p.recipe_kind !== "cooking") continue;
        const dishUuid = String(p.recipe_dish_uuid ?? "").trim();
        if (!dishUuid) continue;
        const rel = p.related_item_list ?? {};
        const ingredientNames = Object.values(rel).map(r => r?.name).filter(Boolean);
        if (!ingredientNames.length) continue;
        recipes.push({ name: item.name, dishUuid, ingredientNames });
      }
    }
    return recipes;
  }

  // ---------------------------------------------------------------------------
  // Ingredient consumption (decrement quantity, delete at 0)
  // ---------------------------------------------------------------------------
  async function _consume(actor, item) {
    const qty = parseInt(item.system?.props?.item_quantity) || 0;
    if (qty > 1) {
      await item.update({ "system.props.item_quantity": String(qty - 1) });
    } else {
      await item.delete();
    }
  }

  // ---------------------------------------------------------------------------
  // start — full session orchestrator (GM context)
  // ---------------------------------------------------------------------------
  async function start(options = {}) {
    if (!game.user?.isGM) throw new Error(`${TAG} start() must run on the GM client`);
    const cfg = getConfig();

    // World content (dishes + _Cooking Config) is required to resolve a pot.
    // Bail out before prompting anyone if it hasn't been authored yet.
    const hasDishes = Object.values(cfg.matrix ?? {}).some(t => Object.values(t ?? {}).some(Boolean));
    if (!hasDishes) {
      ui.notifications?.warn("Cooking: no dish content configured (_Cooking Config / Dishes folder missing) — skipping the hot-pot.");
      return null;
    }

    const sessionId = foundry.utils.randomID();

    // — participants
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
    // Re-route any entry whose userId is missing or points at a GM — picks
    // must reach the owning player's client, never a GM account.
    for (const e of entries) {
      const u = e.userId ? game.users?.get(e.userId) : null;
      if (!u || u.isGM) e.userId = _ownerUserId(e.actor);
    }
    if (!entries.length) throw new Error(`${TAG} no participants`);

    const cookerUuid = String(options.cookerUuid ?? entries[0].actor.uuid);
    const cookerId = cookerUuid.replace(/^Actor\./, "");
    const cooker = game.actors.get(cookerId);

    // — contribution phase (player owners via socket, GM-owned sequentially)
    const picks = []; // { entry, item }
    const waits = [];
    for (const e of entries) {
      const uid = e.userId && game.users?.get(e.userId)?.active ? e.userId : null;
      if (uid && uid !== game.user.id) {
        game.socket.emit(SOCKET_CH, { type: MSG.PICK_REQUEST, sessionId, actorId: e.actorId, userId: uid });
        waits.push(_waitForPick(sessionId, e.actorId, cfg.pickTimeoutMs).then(itemId => ({ e, itemId })));
      } else {
        // GM-owned or offline owner — GM picks on their behalf, sequentially
        waits.push((async () => ({ e, itemId: await _promptPick(e.actor) }))());
      }
    }
    for (const w of await Promise.all(waits)) {
      const item = w.itemId ? w.e.actor.items.get(w.itemId) : null;
      if (item) picks.push({ entry: w.e, item });
    }
    if (!picks.length) {
      ui.notifications?.warn("Cooking: nobody put anything in the pot.");
      return null;
    }

    // — cooker group check (open lobby via Check Requester)
    let cookerCheck = null;
    try {
      const gc = await globalThis.ONI?.GroupCheck?.request?.({
        leaderUuid: cooker?.uuid ?? cookerUuid,
        participantMode: "open",
        allActorUuids: entries.map(e => e.actor.uuid),
        attrA: cfg.cookerCheck.attrA,
        attrB: cfg.cookerCheck.attrB,
        helperDl: cfg.cookerCheck.helperDl,
        label: "🍲 Cooking",
      });
      if (gc?.leaderResult) {
        cookerCheck = {
          total: gc.leaderResult.total,
          isCrit: !!gc.leaderResult.isCrit,
          isFumble: !!gc.leaderResult.isFumble,
        };
      }
    } catch (err) {
      console.warn(TAG, "Group check failed/cancelled — cooking without check.", err);
    }

    // — resolve
    const contributions = picks.map(p => describeItem(p.item, p.entry.actor.uuid));
    const knownRecipes = _gatherKnownRecipes(entries.map(e => e.actor));
    const outcome = resolve(contributions, { config: cfg, cookerCheck, knownRecipes });

    // — consume ingredients (world actors; linked PC tokens inherit)
    for (const p of picks) await _consume(p.entry.actor, p.item);

    // — apply (mystery redirects to a random tier-1 dish)
    const applyId = outcome.kind === "mystery" ? (outcome.redirectDishId ?? outcome.dishId) : outcome.dishId;
    let applied = null;
    if (applyId) {
      applied = await applyDish(applyId, entries.map(e => e.actor.uuid));
    } else {
      console.warn(TAG, "No dish id resolved — outcome:", outcome);
    }

    // — chat card
    const dishItem = applied ? game.items.get(applied.dishId) : null;
    const faceName = outcome.kind === "mystery" ? "Mysterious Hot-Pot" : (dishItem?.name ?? "???");
    const faceImg = (outcome.kind === "mystery" ? game.items.get(String(cfg.mysteryDishId))?.img : dishItem?.img) ?? "icons/svg/item-bag.svg";
    const contribLines = picks.map(p => `<li><b>${p.entry.actor.name}</b> — ${p.item.name}</li>`).join("");
    const detail = outcome.breakdown.map(b => `<div style="opacity:.75;font-size:.85em">${b}</div>`).join("");
    await ChatMessage.create({
      speaker: { alias: "Camp Cooking" },
      content: `
        <div style="border:1px solid #8a4b2d;border-radius:6px;padding:8px">
          <div style="display:flex;align-items:center;gap:8px">
            <img src="${faceImg}" width="36" height="36" style="border:none"/>
            <div>
              <div style="font-weight:bold">${faceName}${outcome.kind === "mystery" && dishItem ? ` → ${dishItem.name}` : ""}</div>
              <div style="font-size:.85em;opacity:.8">Cooked by ${cooker?.name ?? "?"}${cookerCheck ? ` (check ${cookerCheck.total}${cookerCheck.isCrit ? ", CRIT!" : cookerCheck.isFumble ? ", FUMBLE" : ""})` : ""}</div>
            </div>
          </div>
          <ul style="margin:6px 0">${contribLines}</ul>
          ${detail}
        </div>`,
    });

    return { ...outcome, appliedDishId: applied?.dishId ?? null, sessionId };
  }

  // ---------------------------------------------------------------------------
  // Register API
  // ---------------------------------------------------------------------------
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.cooking = { getConfig, resolve, applyDish, start, describeItem };
  console.debug(TAG, "Cooking API loaded.");
})();
