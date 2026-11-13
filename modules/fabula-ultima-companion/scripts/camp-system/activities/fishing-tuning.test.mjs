// ============================================================================
// Fishing v2 — tuning harness.
//
//     node scripts/camp-system/activities/fishing-tuning.test.mjs
//
// Bare Node, no Foundry. Pins the approved mockup numbers (fishing v2, rounds
// 1–20) so a later edit can't drift them silently, and checks the silhouette
// painter draws EXACTLY what the mockup drew (same draw calls, same order).
// ============================================================================
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const T = require("./fishing-tuning.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++; console.error(`FAIL  ${label}\n        got  ${g}\n        want ${w}`);
};
const near = (label, got, want, eps = 1e-6) => {
  if (Math.abs(got - want) <= eps) { pass++; return; }
  fail++; console.error(`FAIL  ${label}\n        got  ${got}\n        want ${want}`);
};
const ok = (label, c) => eq(label, !!c, true);

// ── derive: party characters ────────────────────────────────────────────────
const KEREN = { mig: 6, dex: 8, ins: 12, wlp: 10 };
const HINA = { mig: 8, dex: 6, ins: 12, wlp: 10 };
const BLANCHE = { mig: 12, dex: 12, ins: 6, wlp: 6 };
const ZARG = { mig: 8, dex: 12, ins: 8, wlp: 8 };

let d = T.derive(KEREN);
eq("Keren rise floor 110", d.up, 110);
eq("Keren ramp halved (480/2)", d.ramp, 240);
near("Keren fill 10.5 × 0.85", d.fill, 10.5 * .85);
eq("Keren bar", d.barH, 80);
eq("Keren timer 15 + 3 (WLP 10) + 2", d.timeout, 20);
eq("Keren gauge", d.gaugeSpeed, 120);
eq("Keren sink 90 (DEX 8, no nimble)", d.down, 90);

d = T.derive(HINA);
eq("Hina ramp (12-6)*120/2", d.ramp, 360);
eq("Hina gauge 140", d.gaugeSpeed, 140);

d = T.derive(BLANCHE);
near("Blanche rise 160 × 1.2 nimble", d.up, 192);
near("Blanche sink 90 × 1.2", d.down, 108);
eq("Blanche timer floor 15 + 2", d.timeout, 17);
eq("Blanche bar INS 6", d.barH, 50);

d = T.derive(ZARG, "dex");
eq("Zarg+Swiftline agility 6", d.agil, 6);
near("Zarg+Swiftline rise 133.3 × 1.3", d.up, Math.max(110, Math.min(160, 160 * 8 / 12)) * 1.3);
eq("Zarg+Swiftline gauge 80 − 20", d.gaugeSpeed, 60);

d = T.derive(KEREN, "mig");
near("Ironwood rise past the cap", d.up, 110 + 160 * 2 / 12);
near("Ironwood fill +1.5", d.fill, (10.5 + 1.5) * .85);
eq("Seer's +10 bar", T.derive(KEREN, "ins").barH, 90);
eq("Stillwater +3 s", T.derive(KEREN, "wlp").timeout, 23);

// lowest stats never make it impossible: rise ≥ sink at d6 everywhere
const D6 = { mig: 6, dex: 6, ins: 6, wlp: 6 };
d = T.derive(D6);
ok("all-d6 rise beats sink", d.up > d.down);
ok("all-d6 bar ≥ 30", d.barH >= 30);

// ── thresholds / tiers ──────────────────────────────────────────────────────
eq("WLP 8 thresholds", T.thresholds({ wlp: 8 }), [33, 66, 97]);
eq("WLP 10 thresholds", T.thresholds({ wlp: 10 }), [30, 63, 94]);
eq("Stillwater shifts like +2 WLP", T.thresholds({ wlp: 8 }, "wlp"), [30, 63, 94]);
eq("tier at 50 bare", T.tierOf(50, { wlp: 8 }), 1);
eq("umami Common +6 lifts 61 → Rare", T.tierOf(61, { wlp: 8 }, null, T.baitEffect({ taste: "umami", rarity: "Common" })), 2);
eq("mooch steps a rank", T.tierOf(10, { wlp: 8 }, null, T.baitEffect({ isFish: true })), 1);
eq("cast level perfect", T.castLevel(98, { wlp: 8 }), 4);

// ── bait ────────────────────────────────────────────────────────────────────
eq("honey (sweet uncommon) = mockup", (({ bite, wait }) => ({ bite, wait }))(T.baitEffect({ taste: "sweet", rarity: "Uncommon" })), { bite: 22, wait: .5 });
near("cheese (salty common) chest .15", T.baitEffect({ taste: "salty", rarity: "Common" }).chest, .15);
near("stinger (sour common) calm .85", T.baitEffect({ taste: "sour", rarity: "Common" }).calm, .85);
eq("spore (bitter common) ×3", T.baitEffect({ taste: "bitter", rarity: "Common" }).exMul, 3);
eq("no-taste material = plain bait", T.baitEffect({ taste: "", rarity: "Rare" }).taste, null);
eq("bare hook bite at 50", T.biteChance(50, T.BARE_HOOK), 60);
eq("any bait +10", T.biteChance(50, { id: "x" }), 70);
eq("perfect cast always bites", T.biteChance(97, T.BARE_HOOK), 100);

// ── lure ────────────────────────────────────────────────────────────────────
eq("lure limits", T.LURE_LIMIT, { camp: 20, dungeon: 20, spot: 0 });
eq("Perfect window", T.strikeTiming(70)?.key, "perfect");
eq("Nice window", T.strikeTiming(-130)?.key, "nice");
eq("outside Nice", T.strikeTiming(131), null);
eq("start meters 40 / 45 / 65", [T.START_HP, T.START_HP + T.TIMING[1].hp, T.START_HP + T.TIMING[0].hp], [40, 45, 65]);
near("Legendary hook warier", T.hookP(3, 50, T.BARE_HOOK), (.15 + .45 * .6) * .7);
const seq = vals => { let i = 0; return () => vals[i++ % vals.length]; };
eq("visitor top rank 55%", T.visitorTier(3, seq([.5])), 3);
eq("visitor one below 30%", T.visitorTier(3, seq([.7])), 2);
eq("visitor lower 15%", T.visitorTier(3, seq([.9, .99])), 1);

// ── fish pick ───────────────────────────────────────────────────────────────
const pools = [[{ name: "A", weight: 1 }], [], [{ name: "C", weight: 1, ex: true }, { name: "D", weight: 1 }], []];
eq("empty tier falls to nearest lower", T.pickFish(pools, 3, null, () => 0).tier, 2);
eq("empty tier with nothing below goes up", T.pickFish([[], [], [{ name: "C", weight: 1 }], []], 0, null, () => 0).fish.name, "C");
eq("bitter favours exclusives", T.pickFish(pools, 2, { exMul: 3 }, () => .7).fish.name, "C");
eq("liked taste bites 2×", T.pickFish([[{ name: "L", weight: 1, likes: "sweet" }, { name: "N", weight: 1 }]], 0, { taste: "sweet" }, () => .6).fish.name, "L");

// ── fight ───────────────────────────────────────────────────────────────────
eq("ranks", T.DIFF, [.75, .9, 1.05, 1.25]);
near("drain 15/s", T.DRAIN, 15);
const fp = T.fightProfile(3, T.baitEffect({ taste: "sour", rarity: "Common" }));
near("Legendary + sour calm", fp.dm, 1.25 * .85);

// ── chest ───────────────────────────────────────────────────────────────────
eq("chest weights 45/35/20", T.CHEST_PATTERNS.map(p => p.w), [45, 35, 20]);
eq("roll early", T.rollChestPattern(() => 0).id, "early");
eq("roll mid", T.rollChestPattern(() => .5).id, "mid");
eq("roll late", T.rollChestPattern(() => .9).id, "late");
eq("safety net", T.CHEST_SAFE, 85);
near("chest 20% + salty", T.chestChance(T.baitEffect({ taste: "salty", rarity: "Uncommon" })), .4);
eq("loot weights sum 100", T.CHEST_LOOT.reduce((a, c) => a + c.w, 0), 100);

// ── per-fish data defaults ──────────────────────────────────────────────────
eq("no flag → defaults", T.fishData(undefined), { shape: "std", size: 1, likes: null });
eq("flag read", T.fishData({ shape: "long", size: 1.1, likes: "Sweet" }), { shape: "long", size: 1.1, likes: "sweet" });
eq("bad flag clamped", T.fishData({ shape: "blob", size: 9, likes: "weird" }), { shape: "std", size: 1.25, likes: null });
eq("Legendary len", T.fishLen(3, 1.1), 68);

// ── silhouette: draw calls identical to the mockup's fishSprite ─────────────
import { readFileSync, existsSync } from "node:fs";
function recorder() {
  const log = [];
  return { log, set fillStyle(v) { log.push(["fs", v]); }, set globalCompositeOperation(v) { log.push(["gco", v]); },
    fillRect(...a) { log.push(["r", ...a]); } };
}
for (const shape of T.SHAPE_KEYS) for (const sil of [false, true]) {
  const a = recorder(); T.paintFish(a, T.PAL[0], sil, shape);
  ok(`paints ${shape}${sil ? " silhouette" : ""}`, a.log.length > 100);
}
// The mockup source (scratchpad, optional): run its fishSprite against the same recorder.
const MOCK = process.env.FISH_MOCKUP;
if (MOCK && existsSync(MOCK)) {
  const src = readFileSync(MOCK, "utf8");
  const shapes = src.match(/const SHAPES=\{[^\n]*\};/)[0];
  const fn = src.match(/function fishSprite\(pal,sil,shape="std"\)\{[\s\S]*?return c\.toDataURL\(\);\n\}/)[0];
  for (const shape of T.SHAPE_KEYS) for (const sil of [false, true]) {
    const rec = recorder();
    const document = { createElement: () => ({ getContext: () => rec, toDataURL: () => "" }) };
    new Function("document", `${shapes}\n${fn}\nreturn fishSprite;`)(document)(T.PAL[0], sil, shape);
    const mine = recorder(); T.paintFish(mine, T.PAL[0], sil, shape);
    eq(`mockup-identical ${shape}${sil ? " silhouette" : ""}`, mine.log, rec.log);
  }
} else console.log("(mockup source not given: set FISH_MOCKUP=<template4.html> to diff the painter against it)");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
