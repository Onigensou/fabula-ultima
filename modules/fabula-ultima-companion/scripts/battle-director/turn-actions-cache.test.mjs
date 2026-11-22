// node scripts/battle-director/turn-actions-cache.test.mjs   (bare Node)
import { setTurnActionsCache, clearTurnActionsCache, getTurnActionsCache, turnActionsCacheGen, shouldRenderPulled } from "./turn-actions-cache.js";
let pass = 0, fail = 0;
const eq = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : (fail++, console.log("FAIL", l, g, w)); };

eq("no battle -> null", getTurnActionsCache(), null);
const snap = [{ id: "a", active: true }];
setTurnActionsCache(snap);
eq("GET returns cached list", getTurnActionsCache(), snap);
setTurnActionsCache({ not: "array" });
eq("non-array stored as null", getTurnActionsCache(), null);
setTurnActionsCache(snap);
clearTurnActionsCache();
eq("cleared at battle end -> null", getTurnActionsCache(), null);

// pull race handling
clearTurnActionsCache();
let g = turnActionsCacheGen();
eq("renders a fresh non-empty pull", shouldRenderPulled(snap, g), true);
eq("null pull skipped", shouldRenderPulled(null, g), false);
eq("empty pull skipped", shouldRenderPulled([], g), false);
setTurnActionsCache(snap); // broadcast overtook the request
eq("overtaken by broadcast -> skipped", shouldRenderPulled(snap, g), false);
g = turnActionsCacheGen();
clearTurnActionsCache(); // battle ended in flight
eq("overtaken by clear -> skipped", shouldRenderPulled(snap, g), false);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
