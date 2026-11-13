// ============================================================================
// Cooking System — API  (v2: flavor links, Yaminabe, recipe/taste wheels, cookbook)
//
// Public API:  FUCompanion.api.cooking
//   .getConfig()                            → resolved config
//   .resolve(contributions, opts)           → pure resolver, no side effects (wheels use opts.rng)
//   .applyDish(dishUuid, targets, opts)     → food-AE slot logic (GM context); opts.displayName names the AE
//   .start(options)                         → full hot-pot session (GM context)
//   .describeItem(item, actorUuid, extra)   → contribution descriptor
//   .proceed(sessionId)                     → resolve a waiting proceed gate
//   .requestYaminabe(sessionId)             → cook asks to switch this pot to Yaminabe (one way)
//   .devSim(opts)                           → GM-only local run of the full loop
//
// Socket messages (cooking-ui.js handles the visual side):
//   GM → ALL:     COOKING_PANEL_OPEN  { sessionId, entries, cookerActorId, cookerUserId, mode, view }
//   PLAYER → ALL: COOKING_HOVER       { sessionId, actorId, itemImg, itemName, itemTaste, itemTaste2, isSelect? }  (Hot Pot only)
//   PLAYER → GM:  COOKING_LOCK        { sessionId, actorId, itemId, itemImg, itemName }
//   GM → ALL:     COOKING_STATE       { sessionId, slots, tasteValues }   (redacted while the pot is Yaminabe)
//   ANY → GM:     COOKING_MODE_REQ    { sessionId, userId }
//   GM → ALL:     COOKING_MODE        { sessionId, mode, byName }
//   GM → ALL:     COOKING_MODE_DENIED { sessionId, userId, reason }
//   GM → ALL:     COOKING_ANIMATE     { sessionId, contributions, mode }
//   GM → ALL:     COOKING_RESOLVE     { sessionId, contributions, mode, wheel }
//   GM → ALL:     COOKING_RESULTS     { sessionId, outcome }
//   GM → ALL:     COOKING_CLOSE       { sessionId }
//   GM → ALL:     COOKING_SFX         { sessionId, sfx }
//   PLAYER → GM:  COOKING_PROCEED     { sessionId, userId }
// ============================================================================
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const TAG = "[FUCompanion][Cooking]";
  const GUARD = "__ONI_COOKING_API__";
  if (window[GUARD]) return;
  window[GUARD] = true;

  // Flavor wheel order: neighbours harmonize, tastes across the chart clash.
  // Bitter–Sweet (dark chocolate) · Sweet–Sour · Sour–Salty (pickles) · Salty–Umami (broth) · Umami–Bitter (char)
  const TASTES = ["bitter", "sweet", "sour", "salty", "umami"];
  const TASTE_LABEL = { bitter: "Bitter", sweet: "Sweet", sour: "Sour", salty: "Salty", umami: "Umami" };
  const TASTE_ADJ   = { bitter: "Smoky", sweet: "Honeyed", sour: "Tangy", salty: "Brined", umami: "Savory" };
  const STYLES = {
    sea: { label: "Sea", noun: "Chowder" }, meat: { label: "Meat", noun: "Skewers" },
    monster: { label: "Monster", noun: "Hot-Pot" }, garden: { label: "Garden", noun: "Stir-fry" },
    pantry: { label: "Pantry", noun: "Porridge" }, arcane: { label: "Arcane", noun: "Elixir Broth" },
  };
  const STYLE_KEYS = Object.keys(STYLES);

  // ── Config ─────────────────────────────────────────────────────────────────
  const DEFAULT_CONFIG = {
    matrix: {},
    recipes: [],
    mysteryDishId: null,           // v1 only; v2 never cooks the Mysterious Hot-Pot
    goopDishId: null,
    darkDishIds: {},               // taste → dish id (Yaminabe only, potency ≥ yaminabe.darkAt)
    spoiledDishIds: {},            // taste → dish id (muddled pot: 4+ different tastes)
    ingredientKinds: {},           // ingredient name → sea|meat|monster|garden|pantry|arcane
    tierBreakpoints: [8, 12],
    weirdThreshold: 2,
    link: 2,                       // resonance / harmony +link, clash −link
    muddledAt: 4,
    yaminabe: { bonus: 2, darkAt: 15 },
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
    discovered: [],                // v1 recipe discoveries (kept)
    cookbook: [],                  // v2 cookbook entry keys
    tasted: [],                    // ingredient names that have been in a pot (picker ✦)
    hints: [],                     // recipe names with an unlocked hint
  };

  function getConfig() {
    const item = _configItem();
    const flags = item?.getFlag?.(MODULE_ID, "cookingConfig") ?? {};
    return foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_CONFIG), flags, { inplace: false });
  }
  function _configItem() { return game.items?.find?.(i => i.name === "_Cooking Config") ?? null; }

  // ── Descriptors ────────────────────────────────────────────────────────────
  function describeItem(item, actorUuid = null, extra = {}) {
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
      img: item?.img ?? null,
      ...extra,
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

  // ── Small pure helpers ─────────────────────────────────────────────────────
  const rel = (a, b) => {
    if (a === b) return "same";
    const d = Math.abs(TASTES.indexOf(a) - TASTES.indexOf(b));
    return d === 1 || d === TASTES.length - 1 ? "harm" : "clash";
  };
  function _pickWeighted(cands, rng) {
    const tot = cands.reduce((s, c) => s + c.w, 0) || 1;
    let r = rng() * tot;
    for (let i = 0; i < cands.length; i++) { r -= cands[i].w; if (r < 0) return i; }
    return cands.length - 1;
  }
  const _kindOf = (cfg, name) => STYLES[cfg.ingredientKinds?.[name]] ? cfg.ingredientKinds[name] : "monster";

  // ── Recipes ────────────────────────────────────────────────────────────────
  // `ingredients` / `ingredientNames` = exact full pot. `core` = the pot must CONTAIN it, the rest is filler.
  // A core entry is { name, qty } (named) or { taste, qty } / { kind, qty } (pattern).
  function _expandCounted(rows) {
    return (rows ?? []).flatMap(row => {
      const qty = Math.max(1, parseInt(row?.qty) || 1);
      return (row?.name || row?.taste || row?.kind) ? Array(qty).fill(row) : [];
    });
  }
  function _recipeExactNames(r) {
    if (Array.isArray(r?.ingredients) && r.ingredients.length) return _expandCounted(r.ingredients).map(x => x.name).filter(Boolean);
    return [...(r?.ingredientNames ?? [])].filter(Boolean);
  }
  const _isPattern = r => Array.isArray(r?.core) && r.core.some(e => !e?.name);
  function _slotOk(e, c) {
    if (e.name) return c.name === e.name;
    if (e.taste) return c.taste === String(e.taste).toLowerCase();
    if (e.kind) return c.kind === e.kind;
    return false;
  }
  // distinct-item assignment (≤ party size, so brute force is fine)
  function _coreMissing(core, contribs) {
    const slots = _expandCounted(core);
    let best = slots.length;
    const used = Array(contribs.length).fill(false);
    const go = (i, missing) => {
      if (missing >= best) return;
      if (i === slots.length) { best = missing; return; }
      let placed = false;
      for (let j = 0; j < contribs.length; j++) {
        if (!used[j] && _slotOk(slots[i], contribs[j])) { placed = true; used[j] = true; go(i + 1, missing); used[j] = false; if (best === 0) return; }
      }
      go(i + 1, missing + 1);
      void placed;
    };
    go(0, 0);
    return best;
  }
  // Recipe-wheel weight. Named: rarity of the named items (rarer recipes win more often; replaces `priority`).
  // Pattern: specificity (name 2, kind 1.5, taste 1 per slot). `weight` multiplies, `priority` adds.
  function _recipeWeight(r, cfg, rarityOf) {
    const slots = Array.isArray(r.core) && r.core.length ? _expandCounted(r.core) : _recipeExactNames(r).map(n => ({ name: n }));
    let w = _isPattern(r)
      ? slots.reduce((s, e) => s + (e.name ? 2 : e.kind ? 1.5 : 1), 0)
      : slots.reduce((s, e) => s + (cfg.rarityPotency[rarityOf?.(e.name) ?? "Common"] ?? 1), 0);
    w = w * (Number(r.weight) || 1) + (Number(r.priority) || 0);
    return Math.max(0.01, w);
  }
  const _coreText = r => (Array.isArray(r.core) && r.core.length ? r.core : (r.ingredients ?? (r.ingredientNames ?? []).map(n => ({ name: n }))))
    .map(e => `${e.name ?? (e.taste ? `any ${TASTE_LABEL[String(e.taste).toLowerCase()] ?? e.taste}` : `any ${STYLES[e.kind]?.label ?? e.kind}`)}${(parseInt(e.qty) || 1) > 1 ? ` ×${e.qty}` : ""}`)
    .join(" + ");

  // ── Pure resolver ──────────────────────────────────────────────────────────
  // contributions: describeItem() descriptors (+ actorName/actorId). opts: { config, rng, cookerCheck, knownRecipes, mode, rarityOf }
  function resolve(contributions, opts = {}) {
    const cfg = opts.config ?? getConfig();
    const rng = opts.rng ?? Math.random;
    const check = opts.cookerCheck ?? null;
    const dark = opts.mode === "dark";
    const rarityOf = opts.rarityOf ?? (() => "Common");
    const L = Number(cfg.link) || 2;
    const recipes = [...(cfg.recipes ?? []), ...(opts.knownRecipes ?? [])];
    const contribs = (contributions ?? []).filter(Boolean).map(c => ({ ...c, kind: c.kind ?? _kindOf(cfg, c.name) }));
    const breakdown = [];

    let checkMod = 0;
    if (check && !check.isFumble) {
      if (check.isCrit) { checkMod = cfg.cookerCheck.critPotency; breakdown.push(`Critical cooking! +${checkMod} potency`); }
      else {
        const band = cfg.cookerCheck.bands.find(b => check.total <= b.max);
        checkMod = band?.potency ?? 0;
        if (checkMod) breakdown.push(`Cooker check ${check.total} → ${checkMod > 0 ? "+" : ""}${checkMod} potency`);
      }
    }
    const base = { checkMod, mode: dark ? "dark" : "open" };
    const goop = (why) => {
      breakdown.push(why);
      return { ...base, kind: "goop", dishId: cfg.goopDishId, key: "special:Goop", potency: null, breakdown, wheel: null, near: [] };
    };
    if (!contribs.length) return goop("Nothing went into the pot");
    if (check?.isFumble) return goop("Cooker fumbled — the pot is ruined");

    // ── recipes: exact full pot > named core > pattern core; several hits in one layer → recipe wheel ──
    const potNames = contribs.map(c => c.name).sort();
    const exact = [], named = [], pattern = [], near = [];
    recipes.forEach(r => {
      const req = _recipeExactNames(r).sort();
      if (req.length && req.length === potNames.length && req.every((n, i) => n === potNames[i])) { exact.push(r); return; }
      if (!Array.isArray(r.core) || !r.core.length) return;
      const missing = _coreMissing(r.core, contribs);
      if (missing === 0) (_isPattern(r) ? pattern : named).push(r);
      else if (missing === 1 && !_isPattern(r) && _expandCounted(r.core).length >= 2) near.push(r);
    });
    const layer = exact.length ? exact : named.length ? named : pattern;
    if (layer.length) {
      const cands = layer.map(r => ({ r, w: _recipeWeight(r, cfg, rarityOf) }));
      const idx = cands.length > 1 ? _pickWeighted(cands, rng) : 0;
      const r = cands[idx].r;
      const tot = cands.reduce((s, c) => s + c.w, 0);
      const wheel = cands.length > 1 ? {
        type: "recipe", title: "Which recipe?", landIdx: idx,
        segments: cands.map(c => ({ key: "recipe:" + c.r.name, name: c.r.name, p: c.w / tot, dishId: c.r.dishUuid ?? c.r.dishId ?? null })),
      } : null;
      breakdown.push(`Recipe match: ${r.name}${wheel ? ` (wheel of ${cands.length})` : ""}`);
      return { ...base, kind: "recipe", dishId: r.dishUuid ?? r.dishId ?? null, recipeName: r.name, key: "recipe:" + r.name,
        pattern: _isPattern(r), coreText: _coreText(r), potency: null, breakdown, wheel, near: [] };
    }

    // ── weirdness (non-ingredients) ──
    const weird = contribs.filter(c => !c.isIngredient || !TASTES.includes(c.taste));
    const weirdness = weird.length;
    if (weirdness >= cfg.weirdThreshold) return goop(`Weirdness ${weirdness} ≥ ${cfg.weirdThreshold} — the pot is ruined`);
    const tasted = contribs.filter(c => c.isIngredient && TASTES.includes(c.taste));
    const nearOut = near.map(r => ({ name: r.name, have: _expandCounted(r.core).map(e => e.name).filter(n => contribs.some(c => c.name === n)) }));
    if (!tasted.length) return goop("No taste in the pot");

    // ── taste math ──
    const cnt = Object.fromEntries(TASTES.map(t => [t, 0])), rar = Object.fromEntries(TASTES.map(t => [t, 0]));
    let rarityBase = 0;
    for (const c of contribs) rarityBase += cfg.rarityPotency[c.rarity] ?? 1;
    for (const c of tasted) { cnt[c.taste]++; rar[c.taste] += cfg.rarityPotency[c.rarity] ?? 1; }
    const present = TASTES.filter(t => cnt[t] > 0);
    const wheelOf = (ts, title) => {
      const cands = ts.map(t => ({ t, w: Math.max(0.01, rar[t]) }));
      const idx = cands.length > 1 ? _pickWeighted(cands, rng) : 0;
      const tot = cands.reduce((s, c) => s + c.w, 0);
      return { fam: cands[idx].t, wheel: cands.length > 1 ? { type: "taste", title, landIdx: idx, segments: cands.map(c => ({ key: c.t, taste: c.t, name: TASTE_LABEL[c.t], p: c.w / tot })) } : null };
    };
    const featuredOf = fam => tasted.filter(c => c.taste === fam)
      .slice().sort((a, b) => (cfg.rarityPotency[b.rarity] ?? 1) - (cfg.rarityPotency[a.rarity] ?? 1))[0] ?? null;

    // muddled: 4+ different tastes fight → spoiled; the taste wheel decides whose taste ruined it
    if (present.length >= (cfg.muddledAt ?? 4)) {
      const { fam, wheel } = wheelOf(present, "Whose taste ruined it?");
      const featured = featuredOf(fam);
      breakdown.push(`${present.length} different tastes — muddled, the pot spoils (${TASTE_LABEL[fam]})`);
      return { ...base, kind: "spoiled", family: fam, tier: 0, dishId: cfg.spoiledDishIds?.[fam] ?? cfg.goopDishId, key: "spoiled:" + fam,
        featured, distinct: present.length, potency: null, breakdown, wheel, near: nearOut, weirdness };
    }

    const max = Math.max(...Object.values(cnt));
    const lead = TASTES.filter(t => cnt[t] === max);
    const { fam, wheel } = lead.length > 1 ? wheelOf(lead, "Which taste wins?") : { fam: lead[0], wheel: null };
    if (wheel) breakdown.push(`Taste tie: ${lead.map(t => TASTE_LABEL[t]).join(" vs ")} → ${TASTE_LABEL[fam]}`);

    const resonance = L * (tasted.length - present.length);
    let harm = 0, clash = 0;
    for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) {
      if (rel(present[i], present[j]) === "harm") harm++; else clash++;
    }
    const links = L * (harm - clash);
    const yami = dark ? (Number(cfg.yaminabe?.bonus) || 0) : 0;
    const potency = rarityBase + checkMod + resonance + links + yami;
    const [b2, b3] = cfg.tierBreakpoints;
    const darkAt = Number(cfg.yaminabe?.darkAt) || 15;
    const tier = dark && potency >= darkAt && cfg.darkDishIds?.[fam] ? 4 : potency >= b3 ? 3 : potency >= b2 ? 2 : 1;
    if (resonance) breakdown.push(`Resonance +${resonance}`);
    if (harm) breakdown.push(`Harmony +${harm * L}`);
    if (clash) breakdown.push(`Clash −${clash * L}`);
    if (yami) breakdown.push(`Yaminabe +${yami}`);
    breakdown.push(`${TASTE_LABEL[fam]} — potency ${potency} → ${tier === 4 ? "Dark Delicacy" : `tier ${tier}`}`);

    const featured = featuredOf(fam);
    const kc = {}; for (const c of contribs) kc[c.kind] = (kc[c.kind] ?? 0) + 1;
    const kmax = Math.max(...Object.values(kc));
    const style = featured && kc[featured.kind] === kmax ? featured.kind : STYLE_KEYS.find(s => kc[s] === kmax) ?? "monster";
    const fname = String(featured?.name ?? "").replace(/^Magnificent /, "");
    const tw = tier === 3 ? "Grand " : tier === 2 ? "Hearty " : "";
    let displayName = null, key, label;
    if (tier === 4) { key = "dark:" + fam; label = `Dark Delicacy · ${TASTE_LABEL[fam]} · Yaminabe only`; }
    else if (lead.length === 2) {
      const [a, b] = lead;
      displayName = `${tw}${TASTE_ADJ[a]}-${TASTE_ADJ[b]} ${fname} ${STYLES[style].noun}`;
      key = "fusion:" + a + "+" + b; label = `Fusion · ${TASTE_LABEL[a]} + ${TASTE_LABEL[b]} · ${STYLES[style].label} style`;
    } else {
      displayName = `${tw}${TASTE_ADJ[fam]} ${fname} ${STYLES[style].noun}`;
      key = `dish:${fam}:${style}`; label = `${TASTE_LABEL[fam]} · ${STYLES[style].label} style`;
    }
    const dishId = tier === 4 ? cfg.darkDishIds[fam] : (cfg.matrix?.[fam]?.[tier] ?? null);
    return { ...base, kind: tier === 4 ? "dark" : "dish", family: fam, tier, dishId, key, label, displayName, style, featured,
      potency, parts: { rarity: rarityBase, check: checkMod, resonance, harm: harm * L, clash: clash * L, yami },
      distinct: present.length, weirdness, breakdown, wheel, near: nearOut };
  }

  // ── applyDish ──────────────────────────────────────────────────────────────
  async function applyDish(dishUuid, targetActorUuids, opts = {}) {
    if (!game.user?.isGM) throw new Error(`${TAG} applyDish requires GM context`);
    const dishId = String(dishUuid).replace(/^Item\./, "");
    const dish = game.items?.get(dishId) ?? await fromUuid(String(dishUuid)).catch(() => null);
    if (!dish) throw new Error(`${TAG} dish not found: ${dishUuid}`);

    const meta = dish.getFlag(MODULE_ID, "cookingDish") ?? {};
    const srcAe = dish.effects?.contents?.[0] ?? null;
    const zpGain = Number(meta.instant?.zp ?? 0) || 0;
    const zp = [];
    const aeName = opts.displayName || dish.name;

    for (const uuid of targetActorUuids) {
      const actor = await fromUuid(String(uuid).startsWith("Actor.") ? String(uuid) : `Actor.${uuid}`).catch(() => null);
      if (!actor) { console.warn(TAG, "applyDish: actor not found", uuid); continue; }

      // Eating is eating: every dish takes the meal slot. An `instantOnly`
      // dish (the Zero Power dishes) clears yesterday's buff and leaves none.
      const oldIds = actor.effects.filter(e => e.getFlag(MODULE_ID, "foodBuff")).map(e => e.id);
      if (oldIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", oldIds);

      if (zpGain > 0) { const r = await _grantZp(actor, zpGain); if (r) zp.push(r); }
      if (meta.instantOnly) continue;

      // `conflictStart.shield` rides on the AE as a flag rather than an AE
      // change: it is not a static modifier but a per-battle grant, re-applied
      // by the Battle Director's conflict_start sweep (food-conflict-start.js).
      const conflictShield = Number(meta.conflictStart?.shield ?? 0) || 0;

      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: aeName, img: dish.img,
        description: srcAe?.description ?? "",
        origin: dish.uuid, disabled: false, transfer: false,
        changes: foundry.utils.deepClone(srcAe?.changes ?? []),
        statuses: ["permanent"],
        system: { tags: ["food"] },
        flags: { [MODULE_ID]: {
          foodBuff: true, campRestCharges: 1,
          ...(conflictShield > 0 ? { conflictStartShield: conflictShield } : {}),
          cookingDish: { dishId: dish.id, ...meta },
        } },
      }]);

      const shield = Number(meta.instant?.shield ?? 0);
      if (shield > 0) {
        const cur = parseInt(actor.system?.props?.shield_value) || 0;
        await actor.update({ "system.props.shield_value": cur + shield });
      }
    }

    // Guests and unique summons travelling with the party share a Zero Power
    // dish. They never take the meal slot — only the ZP.
    if (zpGain > 0) {
      const seen = new Set(targetActorUuids.map(u => String(u).replace(/^Actor\./, "")));
      let companions = [];
      try { companions = (await globalThis.FUCompanion?.api?.partyCompanions?.()) ?? []; }
      catch (err) { console.warn(TAG, "applyDish: companions unavailable", err); }
      for (const c of companions) {
        if (!c?.actor || seen.has(c.actor.id)) continue;
        seen.add(c.actor.id);
        const r = await _grantZp(c.actor, zpGain);
        if (r) zp.push(r);
      }
    }
    return { dishId: dish.id, dishName: dish.name, aeName, targets: targetActorUuids.length, zp };
  }

  // Raise Zero Power by `n`, stopping at the actor's max (hard cap 6); the
  // excess is wasted. The PC template has no `max_zero` field — PCs always
  // have the gauge, capped at 6. NPCs (guests, summons) carry `max_zero`, and
  // "0" there means no Zero Power: they are skipped.
  async function _grantZp(actor, n) {
    const p = actor.system?.props ?? {};
    const hasField = p.max_zero !== undefined && p.max_zero !== null && String(p.max_zero).trim() !== "";
    const max = Math.min(hasField ? (Number(p.max_zero) || 0) : 6, 6);
    if (max <= 0) return null;
    const before = Math.max(0, Number(p.zero_power_value) || 0);
    const after = Math.min(before + n, max);
    if (after !== before) await actor.update({ "system.props.zero_power_value": after });
    return { name: actor.name, before, after, max, wasted: n - (after - before) };
  }

  function _zpLines(applied) {
    return (applied?.zp ?? []).map(z =>
      `${z.name} ${z.before} → ${z.after}${z.wasted > 0 ? ` (full, ${z.wasted} wasted)` : ""}`);
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

  // ── Session state (GM) ─────────────────────────────────────────────────────
  const _sessionStates = new Map(); // sessionId → { entries, slots, mode, cookerId, cookerUserId, broadcast }

  function _computeTastes(sessionId, cfg) {
    const state = _sessionStates.get(sessionId);
    const values = Object.fromEntries(TASTES.map(t => [t, 0]));
    if (!state || state.mode === "dark") return values;      // Yaminabe: nothing about the pot leaks
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
  // what every client may see of the slots: in Yaminabe only "locked", never the item
  function _publicSlots(state) {
    if (state.mode !== "dark") return state.slots;
    return Object.fromEntries(Object.entries(state.slots).map(([id, s]) => [id, { locked: !!s.locked, hidden: true, itemId: null, itemImg: null, itemName: null }]));
  }
  function _broadcastState(sessionId, cfg) {
    const state = _sessionStates.get(sessionId);
    if (!state) return;
    const slots = _publicSlots(state), tv = _computeTastes(sessionId, cfg);
    if (state.broadcast) game.socket.emit(SOCKET_CH, { type: "COOKING_STATE", sessionId, slots, tasteValues: tv });
    globalThis.CookingUI?.applyState(sessionId, slots, tv);
  }

  // Yaminabe: one way, cook only, and only before anyone has locked an ingredient
  // (Hot Pot picks are public, so a late switch would hide nothing).
  function _modeRequest(sessionId, userId) {
    const state = _sessionStates.get(sessionId);
    const deny = reason => {
      if (state?.broadcast) game.socket.emit(SOCKET_CH, { type: "COOKING_MODE_DENIED", sessionId, userId, reason });
      if (userId === game.user?.id) ui.notifications?.warn(reason);
    };
    if (!state) return;
    if (state.mode === "dark") return;
    const user = game.users?.get(userId);
    const isCook = !!user && (user.isGM || userId === state.cookerUserId || game.actors?.get(state.cookerId)?.testUserPermission?.(user, "OWNER"));
    if (!isCook) return deny("Only the cook can turn off the lights.");
    if (state.closedForMode || Object.values(state.slots).some(s => s.locked)) return deny("Too late — someone already locked in an ingredient.");
    state.mode = "dark";
    const byName = game.actors?.get(state.cookerId)?.name ?? "The cook";
    if (state.broadcast) game.socket.emit(SOCKET_CH, { type: "COOKING_MODE", sessionId, mode: "dark", byName });
    globalThis.CookingUI?.setMode?.(sessionId, "dark", { animate: true, byName });
    console.log(TAG, `session ${sessionId}: Yaminabe engaged by ${user?.name}`);
  }
  function requestYaminabe(sessionId) {
    if (game.user?.isGM) return _modeRequest(sessionId, game.user.id);
    game.socket?.emit(SOCKET_CH, { type: "COOKING_MODE_REQ", sessionId, userId: game.user?.id });
  }

  // ── Misc helpers ───────────────────────────────────────────────────────────
  function _ownerUserId(actor) {
    const assigned = game.users?.find(u => !u.isGM && u.character?.id === actor?.id);
    if (assigned) return assigned.id;
    return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      const user = game.users?.get(id);
      return id !== "default" && lvl >= 3 && user && !user.isGM
        && !globalThis.FUCompanion?.api?.Spectator?.isSpectator?.(user);
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

  const _rarityOf = name => {
    const w = game.items?.find?.(i => i.name === name && i.system?.props?.item_type === "material");
    return String(w?.system?.props?.item_rarity ?? "Common");
  };

  // ── Cookbook (party-wide, persisted on the config item) ────────────────────
  const COOKBOOK_TOTAL = cfg => TASTES.length * STYLE_KEYS.length
    + (TASTES.length * (TASTES.length - 1)) / 2
    + (cfg.recipes ?? []).length + 1                                  // + Goop
    + Object.keys(cfg.darkDishIds ?? {}).length + Object.keys(cfg.spoiledDishIds ?? {}).length;

  // A view model the UI can render without reading the (GM-only) config item.
  function _cookbookView(cfg) {
    const got = new Set([...(cfg.cookbook ?? []), ...(cfg.discovered ?? []).map(n => "recipe:" + n)]);
    const hints = new Set(cfg.hints ?? []);
    const dishName = id => (id ? game.items?.get(String(id).replace(/^Item\./, ""))?.name : null) ?? null;
    const dishImg  = id => (id ? game.items?.get(String(id).replace(/^Item\./, ""))?.img : null) ?? null;
    return {
      total: COOKBOOK_TOTAL(cfg),
      found: got.size,
      matrix: TASTES.map(t => ({ taste: t, label: TASTE_LABEL[t], adj: TASTE_ADJ[t],
        styles: STYLE_KEYS.map(s => ({ style: s, label: STYLES[s].label, noun: STYLES[s].noun, got: got.has(`dish:${t}:${s}`) })) })),
      fusions: TASTES.flatMap((a, i) => TASTES.slice(i + 1).map(b => ({ a, b, label: `${TASTE_ADJ[a]}-${TASTE_ADJ[b]}`, hint: `${TASTE_LABEL[a]} + ${TASTE_LABEL[b]}`, got: got.has(`fusion:${a}+${b}`) }))),
      recipes: (cfg.recipes ?? []).map(r => {
        const g = got.has("recipe:" + r.name), id = r.dishUuid ?? r.dishId;
        const first = _expandCounted(r.core ?? r.ingredients ?? [])[0];
        const firstText = first ? (first.name ?? (first.taste ? `any ${TASTE_LABEL[first.taste]}` : `any ${STYLES[first.kind]?.label}`)) : "?";
        return { name: g ? r.name : null, img: g ? dishImg(id) : null, got: g, pattern: _isPattern(r),
          hint: g ? null : (_isPattern(r) ? _coreText(r) : hints.has(r.name) ? `${firstText} + ?` : null) };
      }),
      specials: [
        ...TASTES.filter(t => cfg.darkDishIds?.[t]).map(t => ({ group: "dark", taste: t, name: got.has("dark:" + t) ? dishName(cfg.darkDishIds[t]) : null, img: got.has("dark:" + t) ? dishImg(cfg.darkDishIds[t]) : null, got: got.has("dark:" + t) })),
        ...TASTES.filter(t => cfg.spoiledDishIds?.[t]).map(t => ({ group: "spoiled", taste: t, name: got.has("spoiled:" + t) ? dishName(cfg.spoiledDishIds[t]) : null, img: got.has("spoiled:" + t) ? dishImg(cfg.spoiledDishIds[t]) : null, got: got.has("spoiled:" + t) })),
        { group: "goop", name: got.has("special:Goop") ? "Goop" : null, img: got.has("special:Goop") ? dishImg(cfg.goopDishId) : null, got: got.has("special:Goop") },
      ],
    };
  }

  // Record the entry (+ an unlocked hint for a near miss). Returns { isNew, hint }.
  async function _markCookbook(outcome, cfg, ingredientNames = []) {
    const res = { isNew: false, hint: null };
    if (!game.user?.isGM) return res;
    const item = _configItem();
    if (!item) return res;
    const tasted = new Set([...(cfg.tasted ?? []), ...ingredientNames]);
    const book = new Set(cfg.cookbook ?? []);
    const disc = new Set(cfg.discovered ?? []);
    const hints = new Set(cfg.hints ?? []);
    const had = book.has(outcome.key) || (outcome.kind === "recipe" && disc.has(outcome.recipeName));
    res.isNew = !!outcome.key && !had;
    if (outcome.key) book.add(outcome.key);
    if (outcome.kind === "recipe") disc.add(outcome.recipeName);
    const nearNew = (outcome.near ?? []).find(n => !book.has("recipe:" + n.name) && !disc.has(n.name));
    if (nearNew) { hints.add(nearNew.name); res.hint = nearNew.have; }
    try {
      await item.setFlag(MODULE_ID, "cookingConfig.cookbook", [...book]);
      await item.setFlag(MODULE_ID, "cookingConfig.discovered", [...disc]);
      await item.setFlag(MODULE_ID, "cookingConfig.hints", [...hints]);
      await item.setFlag(MODULE_ID, "cookingConfig.tasted", [...tasted]);
    } catch (e) { console.warn(TAG, "could not record cookbook entry", e); }
    return res;
  }

  // ── Results payload (one definition for start() and devSim()) ──────────────
  function _buildResultsPayload({ outcome, applied, cfg, picks, cookerCheck, book }) {
    const dishItem = applied ? game.items.get(applied.dishId) : (outcome.dishId ? game.items.get(String(outcome.dishId).replace(/^Item\./, "")) : null);
    const dishName = outcome.displayName || (outcome.kind === "goop" ? "Goop" : dishItem?.name) || "???";
    const dishImg = dishItem?.img ?? "icons/svg/item-bag.svg";
    const label = outcome.kind === "recipe" ? (outcome.pattern ? "★ Pattern recipe" : "★ Unique recipe")
      : outcome.kind === "goop" ? (cookerCheck?.isFumble ? "Fumble! The pot is ruined" : "The pot is ruined")
      : outcome.kind === "spoiled" ? `Muddled · ${outcome.distinct} tastes fought in the pot`
      : outcome.label ?? "";
    const rawEffect = String(dishItem?.system?.props?.description ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    // v1 dish descriptions mix lore and effect in one paragraph; the card shows only the effect sentence.
    const effAt = rawEffect.search(/\b(Everyone who|Grants|Increases|Widens|At the start|Immune|Reduces)\b/);
    const effectOnly = effAt > 0 ? rawEffect.slice(effAt) : rawEffect;
    const zpLines = _zpLines(applied);
    const featuredId = outcome.featured?.actorId ?? null;
    let hint = null;
    if (book?.hint?.length) hint = `So close! A recipe uses ${[...new Set(book.hint)].join(" + ")} and one more ingredient. Hint added to the Cookbook.`;
    // `payload` crosses the socket — plain data only, never a Document.
    return {
      kind: outcome.kind, mode: outcome.mode,
      dishName, dishImg, label,
      tier: outcome.tier ?? null,
      cookerCheck,
      potency: outcome.potency ?? null, parts: outcome.parts ?? null,
      dishEffect: zpLines.length ? `${effectOnly} — Zero Power: ${zpLines.join(", ")}` : effectOnly,
      baseDishName: outcome.displayName ? (dishItem?.name ?? null) : null,
      zpLines,
      contributors: picks.map(p => ({ actorId: p.entry.actorId, actorName: p.entry.actor.name, itemName: p.item.name, itemImg: p.item.img, featured: p.entry.actorId === featuredId })),
      isNew: !!book?.isNew, hint,
      sfx: outcome.kind === "spoiled" ? "FAIL" : outcome.kind === "goop" ? "GOOP" : "RESULTS",
      breakdown: outcome.breakdown,
    };
  }

  // ── The session (shared by start() and devSim()) ───────────────────────────
  async function _runSession({ entries, cookerId, broadcast, sequentialPicks = false, consume = true, apply = true, label = "🍲 Cooking", devTag = null }) {
    const cfg = getConfig();
    const sessionId = foundry.utils.randomID();
    const cooker = game.actors.get(cookerId);
    const cookerEntry = entries.find(e => e.actorId === cookerId);
    const state = { entries, slots: {}, mode: "open", cookerId, cookerUserId: cookerEntry?.userId ?? null, broadcast };
    _sessionStates.set(sessionId, state);
    const emit = msg => { if (broadcast) game.socket.emit(SOCKET_CH, { ...msg, sessionId }); };

    const panelEntries = entries.map(e => ({ actorId: e.actorId, userId: e.userId, actorName: e.actor.name, portraitUrl: e.actor.img || "icons/svg/mystery-man.svg" }));
    const view = { cookbook: _cookbookView(cfg), kinds: cfg.ingredientKinds ?? {}, tasted: cfg.tasted ?? [] };
    globalThis.CookingUI?.openMainPanel(sessionId, panelEntries, cookerId, { mode: "open", cookerUserId: state.cookerUserId, view });
    emit({ type: "COOKING_PANEL_OPEN", entries: panelEntries, cookerActorId: cookerId, cookerUserId: state.cookerUserId, mode: "open", view });

    // ── picks ──
    const lockOne = (e, r) => { state.slots[e.actorId] = { ...r, locked: true }; _broadcastState(sessionId, cfg); };
    let allResults = [];
    if (sequentialPicks) {
      for (const e of entries) {
        const choices = _materialChoices(e.actor);
        const itemId = await globalThis.CookingUI?.openPicker(sessionId, e.actorId, choices, e.actor.name) ?? null;
        const item = itemId ? e.actor.items.get(itemId) : null;
        const r = { itemId: itemId ?? null, itemImg: item?.img ?? null, itemName: item?.name ?? null };
        lockOne(e, r); allResults.push({ e, ...r });
      }
    } else {
      // Online players pick in parallel on their own clients. The GM picks for everyone else
      // ONE AT A TIME: there is a single docked picker, so concurrent GM pickers would replace
      // each other and the earlier picks would never resolve.
      const waits = [], local = [];
      for (const e of entries) {
        const uid = e.userId && game.users?.get(e.userId)?.active ? e.userId : null;
        if (uid && uid !== game.user.id) waits.push(_waitForLock(sessionId, e.actorId, cfg.pickTimeoutMs).then(r => ({ e, ...r })));
        else local.push(e);
      }
      const localChain = (async () => {
        const out = [];
        for (const e of local) {
          const choices = _materialChoices(e.actor);
          const itemId = await globalThis.CookingUI?.openPicker(sessionId, e.actorId, choices, e.actor.name) ?? null;
          const item = itemId ? e.actor.items.get(itemId) : null;
          const r = { itemId, itemImg: item?.img ?? null, itemName: item?.name ?? null };
          lockOne(e, r); out.push({ e, ...r });
        }
        return out;
      })();
      const [remote, mineLocal] = await Promise.all([Promise.all(waits), localChain]);
      const byActor = new Map([...remote, ...mineLocal].map(r => [r.e.actorId, r]));
      allResults = entries.map(e => byActor.get(e.actorId)).filter(Boolean);   // keep party order for the throws
    }
    state.closedForMode = true;
    const mode = state.mode;

    const picks = allResults
      .map(r => ({ entry: r.e, item: r.itemId ? r.e.actor.items.get(r.itemId) : null }))
      .filter(p => p.item);
    if (!picks.length) {
      ui.notifications?.warn("Cooking: nobody put anything in the pot.");
      emit({ type: "COOKING_CLOSE" });
      globalThis.CookingUI?.closeAll();
      _sessionStates.delete(sessionId);
      return null;
    }

    // ── throws (+ flavor pips in Hot Pot) ──
    const descs = picks.map(p => describeItem(p.item, p.entry.actor.uuid, { actorId: p.entry.actorId, actorName: p.entry.actor.name, kind: _kindOf(cfg, p.item.name) }));
    const contributions = picks.map((p, i) => ({
      actorId: p.entry.actorId, actorName: p.entry.actor.name,
      itemImg: p.item.img || "icons/svg/item-bag.svg", itemName: p.item.name,
      taste: TASTES.includes(descs[i].taste) ? descs[i].taste : null, rarity: descs[i].rarity, kind: descs[i].kind,
    }));
    emit({ type: "COOKING_ANIMATE", contributions, mode });
    await (globalThis.CookingUI?.runAnimation(sessionId, contributions, mode) ?? new Promise(r => setTimeout(r, 1600)));
    await new Promise(r => setTimeout(r, 1500));

    // ── cooker group check ──
    let cookerCheck = null;
    try {
      const gc = await globalThis.ONI?.GroupCheck?.request?.({
        leaderUuid: cooker?.uuid ?? `Actor.${cookerId}`,
        participantMode: "open",
        allActorUuids: entries.map(e => e.actor.uuid),
        attrA: cfg.cookerCheck.attrA, attrB: cfg.cookerCheck.attrB,
        helperDl: cfg.cookerCheck.helperDl, helperBonus: 1, hiddenDl: true,
        label,
      });
      if (gc?.leaderResult) cookerCheck = { total: gc.leaderResult.total, isCrit: !!gc.leaderResult.isCrit, isFumble: !!gc.leaderResult.isFumble };
    } catch (err) { console.warn(TAG, "Group check skipped:", err); }

    emit({ type: "COOKING_SFX", sfx: "START" });
    globalThis.CookingUI?.playSfx?.("START");

    // ── resolve (the host decides every wheel; clients only replay it) ──
    const knownRecipes = _gatherKnownRecipes(entries.map(e => e.actor));
    const outcome = resolve(descs, { config: cfg, cookerCheck, knownRecipes, mode, rarityOf: _rarityOf });
    const wheel = outcome.wheel ? {
      ...outcome.wheel,
      segments: outcome.wheel.segments.map(s => {
        if (outcome.wheel.type !== "recipe") return s;
        const seen = (cfg.cookbook ?? []).includes(s.key) || (cfg.discovered ?? []).includes(s.name);
        const dish = s.dishId ? game.items.get(String(s.dishId).replace(/^Item\./, "")) : null;
        return { ...s, name: seen ? s.name : "???", img: seen ? (dish?.img ?? null) : null };
      }),
    } : null;
    emit({ type: "COOKING_RESOLVE", contributions, mode, wheel });
    await (globalThis.CookingUI?.runResolve?.(sessionId, contributions, mode, wheel) ?? Promise.resolve());

    // ── consume + apply ──
    if (consume) for (const p of picks) await _consume(p.entry.actor, p.item);
    let applied = null;
    if (apply && outcome.dishId) applied = await applyDish(outcome.dishId, entries.map(e => e.actor.uuid), { displayName: outcome.displayName });

    const book = await _markCookbook(outcome, cfg, picks.map(p => p.item.name));
    const resultsPayload = _buildResultsPayload({ outcome, applied, cfg, picks, cookerCheck, book });
    resultsPayload.cookbook = _cookbookView(getConfig());
    emit({ type: "COOKING_RESULTS", outcome: resultsPayload });
    globalThis.CookingUI?.showResults(sessionId, resultsPayload);

    await _waitForProceed(sessionId);
    _sessionStates.delete(sessionId);
    emit({ type: "COOKING_CLOSE" });
    globalThis.CookingUI?.closeAll();

    // ── chat card ──
    const contribLines = picks.map(p => `<li><b>${p.entry.actor.name}</b> — ${p.item.name}</li>`).join("");
    const detail = outcome.breakdown.map(b => `<div style="opacity:.7;font-size:.85em">${b}</div>`).join("");
    const { dishName, dishImg } = resultsPayload;
    await ChatMessage.create({
      speaker: { alias: "Camp Cooking" },
      content: `<div style="border:1px solid #8a4b2d;border-radius:6px;padding:8px">
        ${devTag ? `<div style="background:rgba(200,100,0,.15);font-size:.72em;font-weight:700;color:#b85c00;padding:2px 6px;border-radius:4px;margin-bottom:6px;display:inline-block">${devTag}</div>` : ""}
        ${mode === "dark" ? `<div style="font-size:.75em;font-weight:700;color:#555;margin-bottom:4px">🌑 Yaminabe</div>` : ""}
        <div style="display:flex;align-items:center;gap:8px">
          <img src="${dishImg}" width="36" height="36" style="border:none">
          <div>
            <div style="font-weight:bold">${dishName}</div>
            <div style="font-size:.85em;opacity:.8">${resultsPayload.label}${resultsPayload.baseDishName ? ` (${resultsPayload.baseDishName})` : ""}</div>
            <div style="font-size:.85em;opacity:.8">Cooked by ${cooker?.name ?? "?"}${cookerCheck ? ` (check ${cookerCheck.total}${cookerCheck.isCrit ? ", CRIT!" : cookerCheck.isFumble ? ", FUMBLE" : ""})` : ""}</div>
          </div>
        </div>
        <ul style="margin:6px 0">${contribLines}</ul>
        ${resultsPayload.zpLines.length ? `<div style="color:#b061ff;font-weight:700;margin:4px 0">Zero Power</div><ul style="margin:2px 0 6px">${resultsPayload.zpLines.map(l => `<li>${l}</li>`).join("")}</ul>` : ""}
        ${book.isNew ? `<div style="color:#b8860b;font-weight:700;margin:4px 0">✦ New in the Cookbook: ${dishName}</div>` : ""}
        ${detail}
      </div>`,
    });
    return { ...outcome, appliedDishId: applied?.dishId ?? null, isNew: book.isNew, sessionId };
  }

  async function _partyEntries(participants) {
    let entries;
    if (Array.isArray(participants) && participants.length) {
      entries = [];
      for (const u of participants) {
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
    return entries;
  }
  const _hasDishes = cfg => Object.values(cfg.matrix ?? {}).some(t => Object.values(t ?? {}).some(Boolean));

  // ── start / devSim ─────────────────────────────────────────────────────────
  async function start(options = {}) {
    if (!game.user?.isGM) throw new Error(`${TAG} start() must run on the GM client`);
    if (!_hasDishes(getConfig())) { ui.notifications?.warn("Cooking: no dish content configured — skipping."); return null; }
    const entries = await _partyEntries(options.participants);
    if (!entries.length) throw new Error(`${TAG} no participants`);
    const cookerId = String(options.cookerUuid ?? entries[0].actor.uuid).replace(/^Actor\./, "");
    return _runSession({ entries, cookerId, broadcast: true });
  }

  // GM-only local run: the GM picks for everyone in turn; nothing is broadcast.
  // opts: { consume:false, apply:true, cookerUuid }
  async function devSim(opts = {}) {
    if (!game.user?.isGM) { ui.notifications?.error("devSim: GM only"); return; }
    if (!_hasDishes(getConfig())) { ui.notifications?.warn("Cooking: no dish content configured."); return; }
    const entries = await _partyEntries(opts.participants);
    if (!entries.length) { ui.notifications?.error("devSim: no party members found."); return; }
    ui.notifications?.info("🍲 devSim: pick ingredients for each character…");
    const cookerId = String(opts.cookerUuid ?? entries[0].actor.uuid).replace(/^Actor\./, "");
    return _runSession({ entries, cookerId, broadcast: false, sequentialPicks: true, consume: opts.consume === true, apply: opts.apply !== false,
      label: "🍲 Cooking (Dev Sim)", devTag: `⚙️ DEV SIM — ingredients ${opts.consume === true ? "consumed" : "NOT consumed"}` });
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
          const state = _sessionStates.get(sessionId);
          if (state && msg.actorId) {
            state.slots[msg.actorId] = { itemId: msg.itemId ?? null, itemImg: msg.itemImg ?? null, itemName: msg.itemName ?? null, locked: true };
            _broadcastState(sessionId, getConfig());
          }
          return;
        }
        if (type === "COOKING_PROCEED") { _pendingProceed.get(sessionId)?.(msg.userId ?? null); return; }
        if (type === "COOKING_MODE_REQ") { _modeRequest(sessionId, msg.userId); return; }
      }

      // All clients
      if (type === "COOKING_PANEL_OPEN") {
        globalThis.CookingUI?.openMainPanel(sessionId, msg.entries, msg.cookerActorId, { mode: msg.mode, cookerUserId: msg.cookerUserId, view: msg.view });
        const myEntry = msg.entries?.find(e => e.userId === game.user?.id);
        if (myEntry && !game.user?.isGM) {
          const actor = game.actors?.get(myEntry.actorId);
          const choices = _materialChoices(actor);
          const itemId = await globalThis.CookingUI?.openPicker(sessionId, myEntry.actorId, choices) ?? null;
          const item = actor?.items?.get(itemId);
          game.socket.emit(SOCKET_CH, { type: "COOKING_LOCK", sessionId, actorId: myEntry.actorId, itemId: itemId ?? null, itemImg: item?.img ?? null, itemName: item?.name ?? null });
        }
      } else if (type === "COOKING_SFX") {
        globalThis.CookingUI?.playSfx?.(msg.sfx);
      } else if (type === "COOKING_HOVER") {
        globalThis.CookingUI?._applyHover(msg.actorId, msg.itemImg, msg.itemName, msg.itemTaste || null, msg.itemTaste2 || null, msg.isSelect || false);
      } else if (type === "COOKING_STATE") {
        globalThis.CookingUI?.applyState(sessionId, msg.slots, msg.tasteValues);
      } else if (type === "COOKING_MODE") {
        globalThis.CookingUI?.setMode?.(sessionId, msg.mode, { animate: true, byName: msg.byName });
      } else if (type === "COOKING_MODE_DENIED") {
        if (msg.userId === game.user?.id) ui.notifications?.warn(msg.reason);
      } else if (type === "COOKING_ANIMATE") {
        await globalThis.CookingUI?.runAnimation(sessionId, msg.contributions, msg.mode);
      } else if (type === "COOKING_RESOLVE") {
        await globalThis.CookingUI?.runResolve?.(sessionId, msg.contributions, msg.mode, msg.wheel);
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
  globalThis.FUCompanion.api.cooking = {
    getConfig, resolve, applyDish, start, describeItem, proceed, devSim, requestYaminabe,
    _internals: { rel, TASTES, STYLES, TASTE_LABEL, TASTE_ADJ, _cookbookView },
  };
})();
