// Tests for the shop roster roll. No game required.
// Run: node scripts/shop-system/shop-roster-engine.test.mjs
import * as E from "./shop-roster-engine.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== "" ? "  " + JSON.stringify(detail) : ""}`);
  if (!ok) fail++;
};

// ── fixtures ────────────────────────────────────────────────────────────────
let n = 0;
const C = (type, rarity = "Rare", extra = {}) => ({ id: `${type}-${rarity}-${++n}`, name: `${type} ${n}`, type, rarity, owned: [], steal: "", otherShop: "", ...extra });
const many = (type, count, rarity = "Rare", extra = {}) => Array.from({ length: count }, () => C(type, rarity, extra));
const cfg = (over = {}) => E.resolveConfig(over);
const types = (cands, picks) => picks.map((p) => cands.find((c) => c.id === p.id).type);
const count = (arr, v) => arr.filter((x) => x === v).length;

const big = [
  ...many("weapon", 20), ...many("weapon", 6, "Uncommon"), C("weapon", "Legendary"), C("weapon", "Legendary"), C("weapon", "Legendary"),
  ...many("armor", 10), ...many("shield", 6), ...many("accessory", 12),
];

// ── config ──────────────────────────────────────────────────────────────────
check("config: defaults", JSON.stringify(cfg().quota) === JSON.stringify({ weapon: 8, armor: 4, shield: 2, accessory: 5 }));
check("config: partial override keeps the rest", cfg({ quota: { shield: 3 } }).quota.weapon === 8 && cfg({ quota: { shield: 3 } }).quota.shield === 3);
check("config: junk numbers fall back", cfg({ legendaryCap: "x", repeatWeight: 7 }).legendaryCap === 2 && cfg({ repeatWeight: 7 }).repeatWeight === 1);

// ── helpers ─────────────────────────────────────────────────────────────────
check("rarity: blank rolls as Uncommon", E.rarityOf("") === "Uncommon" && E.rarityOf(undefined) === "Uncommon");
check("rarity: case-insensitive", E.rarityOf("legendary") === "Legendary");
check("name: refine prefix dropped", E.normalizeName("+4 Combat Tunic") === "combat tunic");
check("name: entities decoded", E.normalizeName("Gambler&#39;s Dice") === "gambler's dice" && E.normalizeName("Rest&amp;Rage") === "rest&rage");
check("rng: same seed, same stream", E.mulberry32(7)() === E.mulberry32(7)());

// ── blocks ──────────────────────────────────────────────────────────────────
const D = cfg();
check("block: set piece", E.blockReason(C("armor", "Rare", { isSet: true, setName: "Luchador" }), D).startsWith("Set piece"));
check("block: retired", E.blockReason(C("accessory", "Rare", { retired: "Support units" }), D).startsWith("Retired"));
check("block: off", E.blockReason(C("weapon", "Rare", { off: true }), D) === "Switched off");
check("block: needs authoring", E.blockReason(C("weapon", "Rare", { needsAuthoring: true }), D) === "Needs authoring");
check("block: steal / other shop under stock rules", E.blockReason(C("weapon", "Rare", { steal: "Dire Orc" }), D) && E.blockReason(C("weapon", "Rare", { otherShop: "Brandr" }), D));
check("block: stock rules off lets them roll", !E.blockReason(C("weapon", "Rare", { steal: "Dire Orc" }), cfg({ stockRules: false })));
check("block: owned is NOT a block", !E.blockReason(C("weapon", "Rare", { owned: ["Hina"] }), D));

// ── roll shape ──────────────────────────────────────────────────────────────
{
  const r = E.rollRoster(big, D, { seed: 1 });
  const ts = types(big, r.picks);
  check("roll: quotas filled", count(ts, "weapon") === 8 && count(ts, "armor") === 4 && count(ts, "shield") === 2 && count(ts, "accessory") === 5, ts.length);
  check("roll: no duplicates", new Set(r.picks.map((p) => p.id)).size === r.picks.length);
  check("roll: no warnings with a big pool", r.warnings.length === 0, r.warnings);
  check("roll: reproducible from seed", JSON.stringify(E.rollRoster(big, D, { seed: 1 })) === JSON.stringify(r));
  check("roll: signature Legendary present", r.picks.some((p) => p.why === "signature"));
}
{
  let maxL = 0;
  for (let s = 0; s < 300; s++) {
    const r = E.rollRoster(big, cfg({ weights: { Legendary: 100, Rare: 0, Uncommon: 0, Common: 0 } }), { seed: s });
    maxL = Math.max(maxL, r.picks.filter((p) => big.find((c) => c.id === p.id).rarity === "Legendary").length);
  }
  check("roll: Legendary cap holds even at max weight", maxL === 2, maxL);
}
{
  let sig = 0;
  for (let s = 0; s < 100; s++) if (E.rollRoster(big, cfg({ signature: false, weights: { Legendary: 0 } }), { seed: s }).picks.some((p) => big.find((c) => c.id === p.id).rarity === "Legendary")) sig++;
  check("roll: signature off + weight 0 = no Legendary", sig === 0, sig);
}

// ── owned = last tier ───────────────────────────────────────────────────────
{
  const shields = [C("shield", "Rare", { owned: ["Blanche"] }), C("shield", "Rare"), C("shield", "Rare", { owned: ["Stash"] })];
  const pool = [...shields, ...many("weapon", 10)];
  let ownedPicked = 0;
  for (let s = 0; s < 200; s++) {
    const r = E.rollRoster(pool, D, { seed: s });
    const sh = r.picks.filter((p) => pool.find((c) => c.id === p.id).type === "shield");
    // 2 slots, 1 unowned → exactly one owned fallback every time
    if (sh.length !== 2 || !sh.some((p) => p.id === shields[1].id)) { ownedPicked = -999; break; }
    ownedPicked += sh.filter((p) => p.tier === 1).length;
  }
  check("owned: unowned always taken first, owned fills the gap", ownedPicked === 200, ownedPicked);
}
{
  const pool = [...many("armor", 4), ...many("armor", 6, "Rare", { owned: ["Hina"] })];
  let leak = 0;
  for (let s = 0; s < 200; s++) leak += E.rollRoster(pool, D, { seed: s }).picks.filter((p) => p.tier === 1).length;
  check("owned: never rolls while enough unowned exist", leak === 0, leak);
}
{
  const pool = many("accessory", 7, "Rare", { owned: ["Zarg"] });
  const r = E.rollRoster(pool, D, { seed: 3 });
  check("owned: everything owned → shop still full (never runs out)", r.picks.length === 5 && r.picks.every((p) => p.tier === 1));
}
{
  const pool = [...many("weapon", 10), C("weapon", "Legendary", { owned: ["Keren"] })];
  let sigOwned = 0;
  for (let s = 0; s < 100; s++) if (E.rollRoster(pool, D, { seed: s }).picks.some((p) => p.why === "signature")) sigOwned++;
  check("owned: signature never picks an owned Legendary", sigOwned === 0, sigOwned);
}

// ── pins, shortfall, freshness ──────────────────────────────────────────────
{
  const pinned = C("shield", "Common", { pin: true, owned: ["Hina"] });
  const r = E.rollRoster([pinned, ...many("shield", 5)], D, { seed: 9 });
  check("pin: stocked even when owned and Common", r.picks.some((p) => p.id === pinned.id && p.why === "pin"));
}
{
  const r = E.rollRoster(many("shield", 1), D, { seed: 9 });
  check("shortfall: warns instead of looping", r.picks.length === 1 && r.warnings.some((w) => /^shield: .* 1 of 2/.test(w)), r.warnings);
}
{
  const blocked = [C("weapon", "Rare", { isSet: true }), C("weapon", "Rare", { needsAuthoring: true }), C("weapon", "Rare", { steal: "X" })];
  const r = E.rollRoster([...blocked, ...many("weapon", 3)], D, { seed: 2 });
  check("blocked items never appear", !r.picks.some((p) => blocked.some((b) => b.id === p.id)));
}
{
  const pool = many("weapon", 16);
  const last = new Set(pool.slice(0, 8).map((c) => c.id));
  let repeats = 0;
  for (let s = 0; s < 200; s++) repeats += E.rollRoster(pool, cfg({ signature: false }), { seed: s, lastIds: last }).picks.filter((p) => last.has(p.id)).length;
  const avg = repeats / 200;
  check("freshness: last roster mostly rotates out (avg repeats < 3 of 8)", avg < 3, avg.toFixed(2));
  let zero = 0;
  for (let s = 0; s < 50; s++) zero += E.rollRoster(pool, cfg({ signature: false, repeatWeight: 0 }), { seed: s, lastIds: last }).picks.filter((p) => last.has(p.id)).length;
  check("freshness: weight 0 = full rotation when the pool allows", zero === 0, zero);
}

// ── odds ────────────────────────────────────────────────────────────────────
{
  const o = E.simulateOdds(big, D, { runs: 200 });
  const legend = big.filter((c) => c.rarity === "Legendary").reduce((s, c) => s + (o.hit[c.id] ?? 0), 0);
  check("odds: Legendary per roster between 1 and cap", legend >= 1 && legend <= 2, legend.toFixed(2));
  const total = Object.values(o.perRarity).reduce((a, b) => a + b, 0);
  check("odds: per-rarity sums to roster size", Math.abs(total - 19) < 1e-9, total);
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
