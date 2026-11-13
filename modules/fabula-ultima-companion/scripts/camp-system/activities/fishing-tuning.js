// ============================================================================
// Camp Activity — Fishing: tuning + pure rules (v2, 2026-11-13)
//
// Every number the fishing minigame plays by, in one place, plus the pure
// helpers both sides need (owner client, spectators, GM). No DOM except
// fishSprite(), which paints the pixel silhouette onto a canvas.
//
// All values were tuned and approved in the fishing v2 mockup (rounds 1–20):
//   • Keren fix: bar rise never below 110 px/s, DEX wind-up halved.
//   • WLP: +1.5 s reel time per point above 8, no penalty below.
//   • Rods: a bonus ON TOP, worth one die stage of their attribute.
//   • DEX "nimble bar": +5% bar speed both ways per DEX point above 8.
//   • Fights by rank ×0.75 / 0.9 / 1.05 / 1.25; fill ×0.85, drain ×0.75, +2 s.
//   • Strike timing: normal 40%, Nice ±130 ms → 45%, Perfect ±70 ms → 65%.
//   • Chest: 20% (+ salty bait), three timing patterns, safety net at 85%.
//
// Loaded as a classic script (CampSystem.FishingTuning). Node tests require()
// it directly: fishing-tuning.test.mjs.
// ============================================================================
(() => {
  // ── Fight lane (game px) ──────────────────────────────────────────────────
  const H         = 300;     // fight lane height the rules run in
  const CRUISE    = 58;      // fish cruise speed, px/s
  const BURST     = 185;     // fish burst speed, px/s
  const BURST_MS  = 550;
  const BMIN      = 3500;    // quiet time between bursts, ms
  const BMAX      = 6500;
  const START_HP  = 40;      // catch meter at a normal strike (%)
  const DRAIN     = 20 * .75;   // meter drain while the fish is outside the bar, %/s
  const FILL_MUL  = .85;     // fights a little longer, same feel (v19)
  const TIME_ADD  = 2;       // + seconds on every fight timer (v19)

  // Fish difficulty by rank (Common → Legendary). User-locked.
  const RANK = ["Common", "Uncommon", "Rare", "Legendary"];
  const DIFF = [.75, .9, 1.05, 1.25];
  const RARITY_TIER = { common: 0, uncommon: 1, rare: 2, legendary: 3 };

  // Silhouette length by rank (px at scene scale), times the fish's own size.
  const LEN_BY_TIER = [30, 38, 48, 62];

  // ── Rods: one die stage on top of the base tuning ─────────────────────────
  //   MIG +26.7 px/s rise (160·2/12, past the d12 cap) and +1.5 fill
  //   DEX −20 gauge speed, −120 ms wind-up (and +2 toward the nimble bar)
  //   INS +10 px bar · WLP +3 s reel time (and +2 toward the rank thresholds)
  const STAGE = { up: 160 * 2 / 12, fill: 1.5, gauge: 20, ramp: 120, bar: 10, time: 3 };
  const ROD_ATTRS = ["mig", "dex", "ins", "wlp"];

  function stat(stats, rodAttr, a) {
    return (Number(stats?.[a]) || 8) + (rodAttr === a ? 2 : 0);
  }

  function derive(stats, rodAttr = null) {
    const s = { mig: stat(stats, null, "mig"), dex: stat(stats, null, "dex"),
                ins: stat(stats, null, "ins"), wlp: stat(stats, null, "wlp") };
    const d = {
      gaugeSpeed: Math.max(20, 120 - (s.dex - 8) * 10),
      ramp:       Math.max(0, (12 - s.dex) * 120) / 2,
      up:         Math.max(110, Math.min(160, 160 * s.mig / 12)),
      fill:       Math.max(5, 12 + (s.mig - 8) * .75),
      barH:       Math.min(130, Math.max(30, 60 + (s.ins - 8) * 5)),
      timeout:    15 + Math.max(0, s.wlp - 8) * 1.5,
    };
    if (rodAttr === "mig") { d.up += STAGE.up; d.fill += STAGE.fill; }
    if (rodAttr === "dex") { d.gaugeSpeed = Math.max(20, d.gaugeSpeed - STAGE.gauge); d.ramp = Math.max(0, d.ramp - STAGE.ramp); }
    if (rodAttr === "ins") { d.barH += STAGE.bar; }
    if (rodAttr === "wlp") { d.timeout += STAGE.time; }
    // DEX nimble bar: every DEX point above 8 (rod included) → +5% both ways.
    d.agil = Math.max(0, stat(stats, rodAttr, "dex") - 8);
    d.up  *= 1 + .05 * d.agil;
    d.down = 90 * (1 + .05 * d.agil);
    d.fill   *= FILL_MUL;
    d.timeout += TIME_ADD;
    return d;
  }

  // Cast strength needed for ★★ / ★★★ / ★★★★ (WLP shifts them down).
  function thresholds(stats, rodAttr = null) {
    const sh = (stat(stats, rodAttr, "wlp") - 8) * 1.5;
    return [Math.max(5, 33 - sh), Math.max(20, 66 - sh), Math.max(50, 97 - sh)];
  }

  // ── Bait: any material (the Cooking concept). Taste = effect, rarity = strength.
  const TASTE_LABEL = { umami: "Umami", sweet: "Sweet", salty: "Salty", sour: "Sour", bitter: "Bitter" };
  const BARE_HOOK = Object.freeze({ id: "none", name: "Bare Hook", desc: "No bait. With any bait, fish take the hook more often." });

  /**
   * @param {{taste?:string, rarity?:string, isFish?:boolean}} d
   * @returns effect fields: tierBonus / bite / wait / chest / calm / exMul / step / diff, plus desc + taste
   */
  function baitEffect(d = {}) {
    const r = RARITY_TIER[String(d.rarity ?? "common").trim().toLowerCase()] ?? 0;
    const rarity = RANK[r];
    if (d.isFish) return { step: 1, diff: .15, taste: d.taste || null,
      desc: "Any caught fish: the fish that bite are one rank higher, but they fight harder." };
    const taste = String(d.taste ?? "").trim().toLowerCase();
    const label = TASTE_LABEL[taste];
    if (taste === "umami")  { const v = 6 + 3 * r;   return { taste, tierBonus: v, desc: `${label} · ${rarity}: your cast counts +${v} toward the fish's rank.` }; }
    if (taste === "sweet")  { const v = 12 + 10 * r; return { taste, bite: v, wait: [.7, .5, .4, .35][r], desc: `${label} · ${rarity}: fish come sooner and take the hook more readily.` }; }
    if (taste === "salty")  { const v = .15 + .05 * r; return { taste, chest: v, desc: `${label} · ${rarity}: chest chance +${Math.round(v * 100)} points.` }; }
    if (taste === "sour")   { const v = .85 - .05 * r; return { taste, calm: v, desc: `${label} · ${rarity}: the fish fights ${Math.round((1 - v) * 100)}% calmer.` }; }
    if (taste === "bitter") { const v = 3 + r;       return { taste, exMul: v, desc: `${label} · ${rarity}: this area's own fish bite ${v}× as often.` }; }
    return { taste: null, desc: "Plain bait: fish take the hook more often." };
  }

  function biteChance(str, bait) {
    if (str >= 97) return 100;
    const b = bait ?? BARE_HOOK;
    return Math.min(100, Math.max(25, str + 10 + (b.id !== "none" ? 10 : 0) + (b.bite || 0)));
  }

  function tierOf(str, stats, rodAttr, bait) {
    const [t2, t3, t4] = thresholds(stats, rodAttr);
    const b = bait ?? BARE_HOOK;
    const v = str + (b.tierBonus || 0);
    let t = v >= t4 ? 3 : v >= t3 ? 2 : v >= t2 ? 1 : 0;
    return Math.min(3, t + (b.step || 0));
  }

  // Cast sound level: 0–3 = the rank the cast reaches, 4 = a perfect cast (97+).
  function castLevel(str, stats, rodAttr, bait) {
    return str >= 97 ? 4 : tierOf(str, stats, rodAttr, bait);
  }

  // ── Lure phase ────────────────────────────────────────────────────────────
  // Visitors are rolled one at a time. The cast sets the TOP rank that can
  // come (55% top, 30% one below, 15% lower), so waiting for the big one is a
  // choice. Patterns: look → leave, nibble → leave, nibble → hook ("!").
  const LURE_LIMIT = { camp: 20, dungeon: 20, spot: 0 };
  const HOOK_WIN   = 1300;   // ms the "!" stays up before the fish shakes free
  const HIT_T      = 1000;   // the approach ring meets the bubble here
  const TIMING = [
    { ms: 70,  hp: 25, key: "perfect", label: "PERFECT TIMING!", tag: "PERFECT", snd: "cTrait" },
    { ms: 130, hp: 5,  key: "nice",    label: "NICE TIMING!",    tag: "NICE",    snd: "cS1" },
  ];

  function visitorTier(top, rng = Math.random) {
    const r = rng();
    if (top === 0 || r < .55) return top;
    if (top === 1 || r < .85) return top - 1;
    return Math.floor(rng() * (top - 1));
  }
  function hookP(tier, str, bait) {   // Legendary fish are warier
    return (.15 + .45 * biteChance(str, bait) / 100) * (tier === 3 ? .7 : 1);
  }
  function gapMs(first, str, bait, rng = Math.random) {
    const w = (bait ?? BARE_HOOK).wait || 1;
    if (first) return (700 + (100 - str) * 22) * w;                                // a good cast brings the first fish sooner
    return (rng() < .25 ? 4500 + rng() * 3500 : 1200 + rng() * 2200) * w;         // sometimes a long empty stretch
  }
  function strikeTiming(offMs) {
    return TIMING.find(t => Math.abs(offMs) <= t.ms) ?? null;
  }

  // Fish pick: a tier the table leaves empty falls to the nearest lower tier
  // with fish, then the nearest higher one (shipped rule). Bitter bait favours
  // this area's own fish; a fish whose liked taste matches the bait bites 2×.
  function pickFish(pools, tier, bait, rng = Math.random) {
    const order = [0, 1, 2, 3].sort((a, b) => (a <= tier ? tier - a : 10 + a) - (b <= tier ? tier - b : 10 + b));
    const t = order.find(i => pools?.[i]?.length) ?? tier;
    const b = bait ?? BARE_HOOK;
    const pool = (pools?.[t] ?? []).map(f => ({ f,
      w: (Number(f.weight) || 0) * (f.ex && b.exMul ? b.exMul : 1) * (f.likes && b.taste && f.likes === b.taste ? 2 : 1) }));
    if (!pool.length) return { fish: null, tier: t };
    let roll = rng() * pool.reduce((s, e) => s + e.w, 0);
    const hit = pool.find(e => (roll -= e.w) < 0) ?? pool[pool.length - 1];
    return { fish: hit.f, tier: t };
  }

  // ── Fight ─────────────────────────────────────────────────────────────────
  function fightProfile(tier, bait) {
    const b = bait ?? BARE_HOOK;
    const dm = ((DIFF[tier] ?? 1) + (b.diff || 0)) * (b.calm || 1);
    return { dm, cruise: CRUISE * (dm !== 1 ? (0.85 + 0.15 * dm) : 1), burst: BURST * dm, bmin: BMIN / dm, bmax: BMAX / dm };
  }
  function meterColor(hp) {
    const h = hp < 50 ? (hp / 50) * 40 : hp < 90 ? 40 + ((hp - 50) / 40) * 90 : 130 - ((hp - 90) / 10) * 85;
    return `linear-gradient(0deg,hsl(${h} 75% 40%),hsl(${h} 90% 60%))`;
  }

  // ── Treasure chest ────────────────────────────────────────────────────────
  // One pattern rolled per chest. at = clock spawn (ms) · p = spawn once the
  // meter has covered this share of what's left (maxT fallback) · dist = px
  // from the fish · drift px/s · rate/decay = chest ring %/s on / off it.
  const CHEST_BASE = .2;
  const CHEST_SAFE = 85;     // meter past this when due → no chest this fight
  const CHEST_PATTERNS = [
    { id: "early", name: "Early · easy",  w: 45, at: [500, 1100],   dist: [60, 110],  drift: 0,  rate: 60, decay: 14 },
    { id: "mid",   name: "Mid · medium",  w: 35, p: .25, maxT: 4000, dist: [100, 170], drift: 12, rate: 50, decay: 20 },
    { id: "late",  name: "Late · hard",   w: 20, p: .5,  maxT: 7000, dist: [150, 260], drift: 24, rate: 42, decay: 26 },
  ];
  function chestChance(bait) { return CHEST_BASE + ((bait ?? BARE_HOOK).chest || 0); }
  function rollChestPattern(rng = Math.random, force = null) {
    if (force) return CHEST_PATTERNS.find(p => p.id === force) ?? null;
    let r = rng() * CHEST_PATTERNS.reduce((a, p) => a + p.w, 0);
    return CHEST_PATTERNS.find(p => (r -= p.w) < 0) ?? CHEST_PATTERNS[0];
  }
  // Loot categories the chest draws from (scene table keys, as TR.Flow names them).
  const CHEST_LOOT = [
    { key: "item",       label: "IP",         w: 35 },
    { key: "consumable", label: "Consumable", w: 25 },
    { key: "zenit",      label: "Zenit",      w: 18 },
    { key: "accessory",  label: "Accessory",  w: 9 },
    { key: "armor",      label: "Armor",      w: 6 },
    { key: "weapon",     label: "Weapon",     w: 5 },
    { key: "treasure",   label: "Treasure",   w: 2 },
  ];

  // ── Per-fish data (flag fabula-ultima-companion.fish) ─────────────────────
  // { shape: "std"|"long"|"round", size: 0.8–1.2, likes: taste|null }.
  // Every field is optional: a fish without data plays as a standard shape,
  // standard size, liking nothing.
  const SHAPE_KEYS = ["std", "long", "round"];
  function fishData(flag) {
    const f = flag && typeof flag === "object" ? flag : {};
    const shape = SHAPE_KEYS.includes(f.shape) ? f.shape : "std";
    const size  = Math.min(1.25, Math.max(.75, Number(f.size) || 1));
    const likes = TASTE_LABEL[String(f.likes ?? "").toLowerCase()] ? String(f.likes).toLowerCase() : null;
    return { shape, size, likes };
  }
  function fishLen(tier, size) { return Math.round((LEN_BY_TIER[tier] ?? 30) * (Number(size) || 1)); }

  // ── Procedural pixel fish (ported exactly from the approved mockup) ───────
  // A 32×16 sprite; three body shapes so a silhouette tells long / standard /
  // round fish apart. sil = paint it all one dark colour (the fish stays a
  // silhouette everywhere; only the result window reveals the item art).
  const PAL = [["#6f7d5a", "#9fae7f", "#3c4630"], ["#3f9a86", "#8fe0c4", "#1f4f45"], ["#3f6fb8", "#9fc4ff", "#1f355f"], ["#d6a22a", "#fff0a0", "#7a4a0a"]];
  const SHAPES = { std: { cx: 13, rx: 11, ry: 5.6 }, long: { cx: 16, rx: 14.5, ry: 3.4 }, round: { cx: 16, rx: 9.5, ry: 7.3 } };
  const SIL_COLOR = "#04182a";

  // Paints onto any 2D context with fillStyle/fillRect (a canvas, or a test stub).
  function paintFish(g, pal, sil, shape = "std") {
    const [body, belly, dark] = pal, S = SHAPES[shape] ?? SHAPES.std, t0 = Math.max(0, Math.round(S.cx - S.rx - 1));
    for (let x = 0; x < 32; x++) for (let y = 0; y < 16; y++) {
      const bx = (x - S.cx) / S.rx, by = (y - 8) / S.ry;
      if (bx * bx + by * by <= 1) { g.fillStyle = y > 9 ? belly : body; if (bx * bx + by * by > .78) g.fillStyle = dark; g.fillRect(x, y, 1, 1); }
    }
    g.fillStyle = dark; for (let i = 0; i < 7; i++) g.fillRect(t0 + i, 8 - i * .8 - 1, 1, i * 1.6 + 2);
    g.fillStyle = body; for (let i = 0; i < 5; i++) g.fillRect(t0 + 1 + i, 8 - i * .6, 1, i * 1.2);
    const fy = Math.round(8 - S.ry) - 1; g.fillStyle = dark; for (let i = 0; i < 6; i++) g.fillRect(S.cx - 2 + i, fy + 1 - (i < 3 ? i * .5 : (5 - i) * .5), 1, 2);
    const ex = Math.round(S.cx + S.rx * .55); g.fillStyle = "#fff"; g.fillRect(ex, 6, 2, 2); g.fillStyle = "#000"; g.fillRect(ex + 1, 6, 1, 1);
    g.fillStyle = dark; g.fillRect(S.cx + 2, 10, 3, 1);
    if (sil) { g.globalCompositeOperation = "source-atop"; g.fillStyle = SIL_COLOR; g.fillRect(0, 0, 32, 16); }
  }

  const _spriteCache = new Map();
  function fishSprite(pal, sil, shape = "std") {
    const key = `${pal.join()}|${sil ? 1 : 0}|${shape}`;
    if (_spriteCache.has(key)) return _spriteCache.get(key);
    const c = document.createElement("canvas"); c.width = 32; c.height = 16;
    paintFish(c.getContext("2d"), pal, sil, shape);
    const url = c.toDataURL();
    _spriteCache.set(key, url);
    return url;
  }
  function silhouette(shape = "std") { return fishSprite(PAL[0], true, SHAPE_KEYS.includes(shape) ? shape : "std"); }

  const api = {
    H, CRUISE, BURST, BURST_MS, BMIN, BMAX, START_HP, DRAIN, FILL_MUL, TIME_ADD,
    RANK, DIFF, RARITY_TIER, LEN_BY_TIER, STAGE, ROD_ATTRS, TASTE_LABEL, BARE_HOOK,
    LURE_LIMIT, HOOK_WIN, HIT_T, TIMING,
    CHEST_BASE, CHEST_SAFE, CHEST_PATTERNS, CHEST_LOOT,
    PAL, SHAPES, SHAPE_KEYS, SIL_COLOR,
    stat, derive, thresholds, baitEffect, biteChance, tierOf, castLevel,
    visitorTier, hookP, gapMs, strikeTiming, pickFish, fightProfile, meterColor,
    chestChance, rollChestPattern, fishData, fishLen,
    paintFish, fishSprite, silhouette,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof globalThis !== "undefined") {
    const CAMP = globalThis.CampSystem ??= {};
    CAMP.FishingTuning = api;
  }
})();
