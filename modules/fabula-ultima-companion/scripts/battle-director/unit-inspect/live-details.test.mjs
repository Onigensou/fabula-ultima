// Study / Inspect card: battle-variable Details values come from the LIVE token.
//
//     node scripts/battle-director/unit-inspect/live-details.test.mjs
//
// The 11-28 playtest bug (#15): Rakshasa's token had bow_ef 25 (Adaptive Defense),
// its prototype 100, and the card showed 100%. The gate (details present or not)
// must stay the Encyclopedia's: a locked entry never reveals anything.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { liveWeapons, liveConditions, withLiveDetails, WEAPON_TYPES, CONDITIONS } from "./live-details.js";

let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.message}`); }
}

const protoDetails = {
  hidden: false,
  affinities: [],
  weapons: WEAPON_TYPES.map((type) => ({ type, pct: 100 })),
  conditions: [{ name: "charm", code: "IM" }],
  conditionTotal: CONDITIONS.length,
};
const tokenProps = { bow_ef: "25", brawling_ef: "40", sword_ef: "0", condition_charm: "IM", condition_wet: "vu", condition_slow: "NA" };

check("the token's adapted bow lane shows, not the prototype's 100", () => {
  const det = withLiveDetails(protoDetails, tokenProps);
  assert.equal(det.weapons.find((w) => w.type === "bow").pct, 25);
  assert.equal(det.weapons.find((w) => w.type === "brawling").pct, 40);
});
check("a stored 0 or blank reads 100% (readWeaponEfficiency's rule)", () => {
  const w = liveWeapons(tokenProps);
  assert.equal(w.find((x) => x.type === "sword").pct, 100);
  assert.equal(w.find((x) => x.type === "arcane").pct, 100);
  assert.equal(w.length, WEAPON_TYPES.length);
});
check("status affinities come from the token (case-insensitive, NA dropped)", () => {
  const c = liveConditions(tokenProps);
  assert.deepEqual(c, [{ name: "wet", code: "VU" }, { name: "charm", code: "IM" }].sort((a, b) => CONDITIONS.indexOf(a.name) - CONDITIONS.indexOf(b.name)));
});
check("a locked entry (details null) stays locked", () => {
  assert.equal(withLiveDetails(null, tokenProps), null);
  assert.equal(withLiveDetails(undefined, tokenProps), null);
});
check("the gate fields (hidden = GM-only peek) are kept", () => {
  const det = withLiveDetails({ ...protoDetails, hidden: true }, tokenProps);
  assert.equal(det.hidden, true);
  assert.equal(det.conditionTotal, CONDITIONS.length);
});
check("no live props: the entry is returned as is", () => {
  assert.equal(withLiveDetails(protoDetails, null), protoDetails);
});
check("lists match encyclopedia-core.js WEAPON_TYPES / CONDITIONS", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "../../encyclopedia/encyclopedia-core.js"), "utf8");
  const grab = (name) => {
    const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
    return [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
  };
  assert.deepEqual(grab("WEAPON_TYPES"), [...WEAPON_TYPES]);
  assert.deepEqual(grab("CONDITIONS"), [...CONDITIONS]);
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
