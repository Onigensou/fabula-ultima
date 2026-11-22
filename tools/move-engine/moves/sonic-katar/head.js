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
// the accuracy dice sizes (the rule itself, rollCheck / rollAcc / accOdds, is shared/results.js)
const DICE = [6, 8, 10, 12];
const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
const RUNLOG = { sb: null, gb: null };   // last runs, for the balance panels
