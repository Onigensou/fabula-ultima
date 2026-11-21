// ═════════ Sonic Katar (Rare) · Sonic Blow + Gunblade (Uncommon, two forms) — family head, HOST-NEUTRAL (move-engine)
// Runs in the mockup page AND the game. Actors come from the host (moveCaster / moveTarget): on the page the wielder chip and
// the Dire Orc (window.MOVE_ROLES), in the game the action's caster and first target. def / T / TO: shared/moves.js;
// colours + hand / bodyAt: shared/fx-melee.js. From the approved v2 page's part-sonic-head.js (2026-11-21).
const GROUPS = { sonic: "Sonic Katar · Rare dagger", gunblade: "Gunblade · Uncommon (replaces Imperial Gunblade)" };
const ORC = moveTarget();
const WA = () => moveCaster();
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
