// ============================================================================
// Shop Roster — the roll itself (no Foundry, no game state; unit-tested)
//
// A "roster shop" (Hako today) rerolls its equipment from a curated pool. The
// service (shop-roster-service.js) turns the live world into plain candidate
// objects; this file decides which of them go on sale.
//
// One roll:
//   1. Items that can never roll are set aside (blockReason).
//   2. The rest split into two tiers: tier 0 = nobody in the party owns it,
//      tier 1 = owned. Tier 1 only fills a slot when tier 0 has nothing left in
//      that category, so the shop never runs out but never repeats owned gear
//      while something new exists (user 2026-11-25).
//   3. Pins first, then one guaranteed "signature" Legendary from tier 0.
//   4. Each remaining slot: pick a rarity by weight among the rarities that
//      category still has, then an item of that rarity. Items from the roster
//      being replaced roll at `repeatWeight`, so back-to-back rosters differ.
//
// Candidate shape:
//   { id, name, type: "weapon"|"armor"|"shield"|"accessory", rarity,
//     isSet, setName, retired, off, pin, needsAuthoring,
//     owned: string[]   (who owns a copy: actor names / "Stash"),
//     steal: string     (a monster that can drop/steal it, or ""),
//     otherShop: string (another shop that sells it right now, or "") }
// ============================================================================

export const EQUIP_TYPES = ["weapon", "armor", "shield", "accessory"];
export const RARITIES = ["Legendary", "Rare", "Uncommon", "Common"];

export const DEFAULT_CONFIG = Object.freeze({
  quota: { weapon: 8, armor: 4, shield: 2, accessory: 5 },
  weights: { Legendary: 8, Rare: 55, Uncommon: 32, Common: 5 },
  legendaryCap: 2,
  signature: true,
  repeatWeight: 0.25,
  stockRules: true,        // skip monster-stealable + sold-in-another-shop items
  cooldownHours: 12,       // a second Rest the same night keeps the roster
});

/** Merge a stored (possibly partial / older) config over the defaults. */
export function resolveConfig(stored) {
  stored ??= {};   // the shop flag stores null for "all defaults"
  const d = DEFAULT_CONFIG;
  const num = (v, def, min = 0) => (Number.isFinite(Number(v)) ? Math.max(min, Number(v)) : def);
  const quota = {}, weights = {};
  for (const t of EQUIP_TYPES) quota[t] = Math.floor(num(stored.quota?.[t], d.quota[t]));
  for (const r of RARITIES) weights[r] = num(stored.weights?.[r], d.weights[r]);
  return {
    quota, weights,
    legendaryCap: Math.floor(num(stored.legendaryCap, d.legendaryCap)),
    signature: stored.signature ?? d.signature,
    repeatWeight: Math.min(1, num(stored.repeatWeight, d.repeatWeight)),
    stockRules: stored.stockRules ?? d.stockRules,
    cooldownHours: num(stored.cooldownHours, d.cooldownHours),
  };
}

/** Deterministic PRNG so a roll can be reproduced from its seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rarity as the roll sees it: blank / unknown values roll as Uncommon. */
export function rarityOf(r) {
  const s = String(r ?? "").trim().toLowerCase();
  return RARITIES.find((x) => x.toLowerCase() === s) ?? "Uncommon";
}

/**
 * Name key for "does the party own this": decodes HTML entities, drops the
 * refine prefix ("+4 Combat Tunic" → "combat tunic"), folds case and spaces.
 */
export function normalizeName(name) {
  return String(name ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/^\s*\+\d+\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Why a candidate can never roll, or "" when it can. */
export function blockReason(c, cfg) {
  if (c.isSet) return `Set piece${c.setName ? ` · ${c.setName}` : ""}`;
  if (c.retired) return `Retired${typeof c.retired === "string" ? ` · ${c.retired}` : ""}`;
  if (c.off) return "Switched off";
  if (c.needsAuthoring) return "Needs authoring";
  if (cfg.stockRules && c.steal) return `Stealable · ${c.steal}`;
  if (cfg.stockRules && c.otherShop) return `Sold at ${c.otherShop}`;
  return "";
}

export const tierOf = (c) => (c.owned?.length ? 1 : 0);

function pickWeighted(list, weightOf, rng) {
  let total = 0;
  const ws = list.map((x) => { const w = Math.max(0, Number(weightOf(x)) || 0); total += w; return w; });
  if (total <= 0) return list[Math.floor(rng() * list.length)];
  let r = rng() * total;
  for (let i = 0; i < list.length; i++) { r -= ws[i]; if (r < 0) return list[i]; }
  return list[list.length - 1];
}

/**
 * @param {object[]} candidates
 * @param {object} cfg            resolved config (resolveConfig)
 * @param {{seed:number, lastIds?:Set<string>}} opts
 * @returns {{seed:number, picks:{id:string, tier:0|1, why:"pin"|"signature"|"roll"}[], warnings:string[]}}
 */
export function rollRoster(candidates, cfg, { seed, lastIds = new Set() } = {}) {
  const rng = mulberry32(seed);
  const live = candidates.filter((c) => EQUIP_TYPES.includes(c.type) && !blockReason(c, cfg));
  const picks = [], taken = new Set(), warnings = [];
  const perType = Object.fromEntries(EQUIP_TYPES.map((t) => [t, 0]));
  let legends = 0;

  const room = (c) => perType[c.type] < cfg.quota[c.type];
  const freshness = (c) => (lastIds.has(c.id) ? cfg.repeatWeight : 1);
  const take = (c, why) => {
    picks.push({ id: c.id, tier: tierOf(c), why });
    taken.add(c.id);
    perType[c.type]++;
    if (rarityOf(c.rarity) === "Legendary") legends++;
  };

  // 1. Pins: always stocked (owned or not) while the category has room.
  for (const c of live) if (c.pin && room(c)) take(c, "pin");

  // 2. Signature Legendary: one unowned Legendary when any is left.
  if (cfg.signature && legends < cfg.legendaryCap) {
    const pool = live.filter((c) => !taken.has(c.id) && rarityOf(c.rarity) === "Legendary" && tierOf(c) === 0 && room(c));
    if (pool.length) take(pickWeighted(pool, freshness, rng), "signature");
  }

  // 3. Fill every category: rarity first, then the item.
  for (const type of EQUIP_TYPES) {
    while (perType[type] < cfg.quota[type]) {
      const legalRarity = (c) => rarityOf(c.rarity) !== "Legendary" || legends < cfg.legendaryCap;
      const inType = live.filter((c) => c.type === type && !taken.has(c.id) && legalRarity(c));
      let tier = inType.filter((c) => tierOf(c) === 0);
      if (!tier.length) tier = inType;
      if (!tier.length) {
        warnings.push(`${type}: the pool only filled ${perType[type]} of ${cfg.quota[type]} slots`);
        break;
      }
      const present = RARITIES.filter((r) => tier.some((c) => rarityOf(c.rarity) === r));
      const rarity = pickWeighted(present, (r) => cfg.weights[r], rng);
      take(pickWeighted(tier.filter((c) => rarityOf(c.rarity) === rarity), freshness, rng), "roll");
    }
  }
  return { seed, picks, warnings };
}

/**
 * Chance that each candidate appears in the next roll, by simulation.
 * @returns {{hit: Record<string, number>, perRarity: Record<string, number>}}
 */
export function simulateOdds(candidates, cfg, { lastIds = new Set(), runs = 400, seed = 12345 } = {}) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const hit = {}, perRarity = Object.fromEntries(RARITIES.map((r) => [r, 0]));
  let s = seed >>> 0;
  for (let i = 0; i < runs; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    for (const p of rollRoster(candidates, cfg, { seed: s, lastIds }).picks) {
      hit[p.id] = (hit[p.id] ?? 0) + 1;
      perRarity[rarityOf(byId.get(p.id)?.rarity)]++;
    }
  }
  for (const k in hit) hit[k] /= runs;
  for (const k in perRarity) perRarity[k] /= runs;
  return { hit, perRarity };
}
