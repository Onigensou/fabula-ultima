// ═════════ Sonic Katar (Rare) · Sonic Blow (30 MP, Chain 8 Volley) + Gunblade (Uncommon, two forms) — globals
const SKL = [];
function def(key, s) { s.tune = s.tune || []; if (!SK[key]) SKL.push(key); SK[key] = s; }
const T = (k, label, v, min, max, step = 10) => ({ k, label, v, min, max, step });
const TO = (k, label, opts, v = 0) => ({ k, label, v, opts });
const GROUPS = { sonic: "Sonic Katar · Rare dagger", gunblade: "Gunblade · Uncommon (replaces Imperial Gunblade)" };
const ORC = ACT.orc;
const WA = () => ACT[WIELD];
WIELD = "keren";   // user 2026-11-21: Keren holds the weapons in this mockup (the chips switch it)
const hand = (a) => ({ x: OX(a) + face(a) * wid(a) * .34, y: OY(a) - (a.lift || 0) - hgt(a) * .52 });
const bodyAt = (a) => ({ x: OX(a), y: OY(a) - (a.lift || 0) - hgt(a) * .5 });
const FIRE = "255,140,50", STEEL = "170,210,255", GOLD = "255,214,120", PINK = "255,170,210";
const ggTint = (hex) => `brightness(0) saturate(100%) invert(1) drop-shadow(0 0 0 ${hex})`;
// no trigger gauge on this page (part-ui still calls these)
const G = { el: null, armed: false };
function gaugeClose() { G.armed = false; }
function gaugeMount() {}
// the game's accuracy dice: crit = matching dice of 6 or more (check.js / action-card.js), fumble = double 1s
const DICE = [6, 8, 10, 12];
const ri = (n) => 1 + Math.floor(Math.random() * n);
function rollAcc(dA, dB, bonus, def) { const a = ri(dA), b = ri(dB), fum = a === 1 && b === 1, crit = !fum && a === b && a >= 6, tot = a + b + bonus;
  return { a, b, tot, fum, crit, hit: !fum && (crit || tot >= def) }; }
// exact odds over every die face pair (same rule)
function accOdds(dA, dB, bonus, def) { let h = 0, c = 0, odd = 0, oddHit = 0, n = 0;
  for (let a = 1; a <= dA; a++) for (let b = 1; b <= dB; b++) { n++; const fum = a === 1 && b === 1, crit = !fum && a === b && a >= 6, tot = a + b + bonus, hit = !fum && (crit || tot >= def);
    if (hit) h++; if (crit) c++; if (tot % 2) { odd++; if (hit) oddHit++; } }
  return { hit: h / n, crit: c / n, odd: odd / n, oddHit: oddHit / n }; }
const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
const RUNLOG = { sb: null, gb: null };   // last runs, for the balance panels
