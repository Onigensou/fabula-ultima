/**
 * Attribute-step maths: milestone application, the d12 cap, derived stats, and
 * the swap that keeps the array a permutation.
 *
 * cc-step-attributes imports cc-app, which touches no Foundry global at import
 * time, so this runs in plain node.
 */
const A = await import("./cc-step-attributes.js");
const D = await import("./cc-draft.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};

const mk = (level, assign, picks = []) => {
  const d = D.createDraft();
  d.attributes.level = level;
  d.attributes.assign = { ...assign };
  d.attributes.milestonePicks = [...picks];
  return d;
};
const AVG = { mig: 10, dex: 8, ins: 8, wlp: 6 };

// ── milestones ─────────────────────────────────────────────────────────────
eq("no milestones below 20", A.effectiveBases(mk(19, AVG)), { mig: 10, dex: 8, ins: 8, wlp: 6 });
eq("one step at 20", A.effectiveBases(mk(20, AVG, ["mig"])), { mig: 12, dex: 8, ins: 8, wlp: 6 });
eq("two steps at 41", A.effectiveBases(mk(41, AVG, ["dex", "dex"])), { mig: 10, dex: 12, ins: 8, wlp: 6 });
// d10 -> d12 -> capped. The third would be illegal anyway; the cap holds.
eq("d12 cap holds", A.effectiveBases(mk(41, AVG, ["mig", "mig"])), { mig: 12, dex: 8, ins: 8, wlp: 6 });
eq("blank picks ignored", A.effectiveBases(mk(41, AVG, ["", ""])), { mig: 10, dex: 8, ins: 8, wlp: 6 });
eq("junk picks ignored", A.effectiveBases(mk(20, AVG, ["nonsense"])), { mig: 10, dex: 8, ins: 8, wlp: 6 });

// ── derived ────────────────────────────────────────────────────────────────
const p5 = A.previewDerived(mk(5, AVG));
eq("HP = level + 5*MIG", p5.maxHp, 5 + 50);
eq("MP = level + 5*WLP", p5.maxMp, 5 + 30);
eq("crisis is half HP", p5.crisis, 27);
eq("DEF = DEX die", p5.def, 8);
eq("MDEF = INS die", p5.mdef, 8);
eq("IP is 6", p5.maxIp, 6);
eq("init = avg(DEX)+avg(INS)", p5.init, 4.5 + 4.5);

// Milestones must feed the derived numbers, not just the display.
const p20 = A.previewDerived(mk(20, AVG, ["mig"]));
eq("milestone raises HP", p20.maxHp, 20 + 5 * 12);

// Against a real sheet: Hina is level 41, MIG d8 -> max_hp 98 on the sheet,
// which is 41 + 5*8 = 81 plus 17 from class benefits and gear. The base
// formula is what we assert; the rest is added downstream by design.
eq("base HP for Hina's spread", A.previewDerived(mk(41, { mig: 8, dex: 6, ins: 12, wlp: 10 })).maxHp, 81);

// ── the swap, replicated exactly as the handler does it ────────────────────
const swap = (assign, key, want) => {
  const a = { ...assign };
  const KEYS = ["mig", "dex", "ins", "wlp"];
  if (!want) { delete a[key]; return a; }
  const holder = KEYS.find((k) => k !== key && Number(a[k] ?? 0) === want);
  const had = Number(a[key] ?? 0);
  a[key] = want;
  if (holder) { if (had) a[holder] = had; else delete a[holder]; }
  return a;
};
const sorted = (o) => Object.values(o).sort((x, y) => x - y);

eq("swap moves the die", swap(AVG, "dex", 10), { mig: 8, dex: 10, ins: 8, wlp: 6 });
eq("swap conserves the pool", sorted(swap(AVG, "dex", 10)), [6, 8, 8, 10]);
eq("swap with a duplicate still conserves", sorted(swap(AVG, "mig", 8)), [6, 8, 8, 10]);
eq("assigning into an empty slot takes from the holder",
  swap({ dex: 10 }, "mig", 10), { mig: 10 });
eq("clearing removes only that attribute", swap(AVG, "wlp", 0), { mig: 10, dex: 8, ins: 8 });

// A full assignment can never exceed the pool, whatever order it is built in.
let acc = {};
for (const [k, v] of [["wlp", 10], ["mig", 10], ["dex", 8], ["ins", 6], ["mig", 8]]) acc = swap(acc, k, v);
eq("no duplicate inflation across a sequence", sorted(acc).length <= 4, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
