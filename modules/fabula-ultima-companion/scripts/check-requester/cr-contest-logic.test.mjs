// Contest Check rules — node modules/fabula-ultima-companion/scripts/check-requester/cr-contest-logic.test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = require("./cr-contest-logic.js");

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (cond) console.log("  ok   " + msg); else { fails++; console.log("  FAIL " + msg); } };
const side = (a, b, extra = {}) => ({ a, b, mods: [], ...extra });

// ── ranking (core p.48) ──
ok(L.isCrit(side(6, 6)) && !L.isCrit(side(5, 5)) && L.isCrit(side(8, 8)), "crit = doubles of 6+");
ok(L.isFumble(side(1, 1)) && !L.isCrit(side(1, 1)), "1+1 is a fumble, never a crit");
ok(L.leaderIndex([side(8, 8), side(9, 10)]) === 0, "a crit (16) beats a bigger total (19) — the book's Montblanc example");
ok(L.leaderIndex([side(6, 6), side(8, 8)]) === -1, "two crits are a draw whatever their totals");
ok(L.leaderIndex([side(1, 1), side(1, 1), side(2, 3)]) === 2, "two fumbles at the bottom do not matter when someone else leads");
ok(L.leaderIndex([side(1, 1), side(1, 1)]) === -1, "two fumbles between the only sides = draw");
ok(L.leaderIndex([side(1, 1), side(1, 2)]) === 1, "a fumble is the lowest possible Result (2 beats 1+1)");
ok(L.leaderIndex([side(5, 6), side(4, 7)]) === -1, "equal totals = draw");
ok(L.leaderIndex([side(5, 6, { mods: [{ value: 2 }] }), side(6, 6)]) === 1, "modifiers count toward the total, but the crit still wins");
ok(L.leaderIndex([side(5, 6, { mods: [{ value: 2 }] }), side(4, 7)]) === 0, "a +2 bonus breaks the tie");

// ── ties: only the tied-for-first sides reroll ──
{
  const s = [side(6, 7), side(4, 5), side(9, 4), side(6, 5)];
  ok(JSON.stringify(L.tiedForFirst(s)) === "[0,2]", "race: Keren 13 and Hina 13 tie for first");
  const tied = L.beginRerollRound(s);
  ok(JSON.stringify(tied) === "[0,2]" && s[1].out && s[3].out && s[0].a == null && s[2].b == null, "only the tied sides reroll; the rest are out of the running");
  s[0].a = 5; s[0].b = 5; s[2].a = 8; s[2].b = 7;
  ok(L.leaderIndex(s) === 2, "round 2 decides among the tied sides only");
  const pl = L.placings(s);
  ok(pl[0].index === 2 && pl[1].index === 0 && pl.length === 2, "placings list the live sides best first");
}
{
  const s = [side(5, 6, { usedTrait: true, usedBond: true, mods: [{ value: 2, perCheck: true }, { value: 1 }] }), side(6, 7)];
  s[1].mods = [{ value: 1 }];   // 14 vs 14: a tie
  L.beginRerollRound(s);
  ok(s[0].usedTrait === false && s[0].usedBond === false, "a tie reroll is a new Check: Trait and Bond open again");
  ok(s[0].mods.length === 1 && s[0].mods[0].value === 1, "a Bond bonus (perCheck) is dropped on the reroll; standing modifiers stay");
}

// ── answer windows (D1: the side behind answers first) ──
{
  const s = [side(5, 6), side(7, 8)];
  const all = () => true;
  ok(L.nextAnswerer(s, all) === 0, "the side that is behind answers first");
  s[0].accepted = true;
  ok(L.nextAnswerer(s, all) === null, "the leader never answers; once the side behind accepts, it resolves");
  s[0].accepted = false; s[0].a = 7; s[0].b = 9; L.reopenAfterChange(s, 0);   // 16 vs 15
  ok(L.nextAnswerer(s, all) === 1, "after an invoke flips the lead, the window passes to the new side behind");
  ok(L.nextAnswerer(s, (i) => i !== 1) === null, "a side with nothing to spend is skipped");
}
{
  const s = [side(6, 7), side(4, 5), side(9, 4), side(6, 5)];
  ok(L.nextAnswerer(s, () => true) === 1, "4-way: worst first (Blanche 9 before Jack 11)");
  ok(L.nextAnswerer(s, (i) => i !== 1) === 3, "then the next worst");
  const s2 = [side(5, 6), side(4, 7)];
  ok(L.nextAnswerer(s2, () => true) === 0, "on a level tie both may answer, in side order");
}

// ── margin + clock (D3) ──
ok(L.marginTier(side(6, 7), side(4, 5)) === 1 && L.clockSections(1) === 2, "won by 4: tier 1 = 2 sections");
ok(L.marginTier(side(6, 8), side(4, 3)) === 2 && L.clockSections(2) === 3, "won by 7: tier 2 = 3 sections");
ok(L.marginTier(side(6, 7), side(6, 6 - 1)) === 0, "won by 2: 1 section");
ok(L.marginTier(side(8, 8), side(9, 10)) === 2 && L.margin(side(8, 8), side(9, 10)) === null, "a crit win counts as the 6+ tier, with no raw margin");
ok(L.marginTier(side(2, 3), side(1, 1)) === 2, "a win against a fumble counts as the 6+ tier");

// ── sting priority ──
ok(L.stingFor([{ mine: true, party: true }, { party: false }], 0) === "winner", "my side won -> winner sting");
ok(L.stingFor([{ mine: true, party: true }, { party: false }], 1) === "loser", "my side lost -> the piano drop");
ok(L.stingFor([{ party: true }, { party: false }], 1) === "loser", "watching ally (or the GM): the party lost -> loser");
ok(L.stingFor([{ party: true }, { party: true }], 1) === "winner", "party vs party, watching: an ally won -> winner");
ok(L.stingFor([{ party: false }, { party: false }], 0) === "winner", "NPC vs NPC -> winner sting");

// ── team side + attributes ──
ok(L.pickTeamRoller([{ id: "k", dA: 8, dB: 10 }, { id: "h", dA: 10, dB: 10 }, { id: "b", dA: 8, dB: 8 }]) === "h", "team: the best dice roll");
ok(L.pickTeamRoller([{ id: "k", dA: 8, dB: 8, mod: 0 }, { id: "h", dA: 8, dB: 8, mod: 2 }]) === "h", "team tie on dice: the bigger modifier");
ok(JSON.stringify(L.sideAttrs({ attrA: "mig", attrB: "mig" }, { attrB: "dex" })) === '{"attrA":"MIG","attrB":"DEX"}', "per-side override on top of the shared default");
ok(JSON.stringify(L.sideAttrs({ attrA: "WLP" }, {})) === '{"attrA":"WLP","attrB":"WLP"}', "shared default; B falls back to A");

// ── silent contest ──
{
  const rolls = [[5, 6], [4, 7], [3, 3], [6, 2]];   // round 1 ties at 11, round 2 6 vs 8
  let k = 0; const flat = rolls.flat();
  const s = [side(null, null), side(null, null)];
  const r = L.runSilent(s, () => flat[k++]);
  ok(r.winner === 1 && r.rounds === 2, "silent: rerolls a tie until there is a winner");
}

console.log(`\n${n - fails}/${n} passed`);
if (fails) process.exit(1);
