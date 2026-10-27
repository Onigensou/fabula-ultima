// ============================================================================
// Formation — where battle units stand.
//
//     node scripts/battle-director/formation.test.mjs
//
// Every count the encounter tables can roll must come out with zero clashes
// (a label on another unit's body or label, or two sprites piled together),
// on both sides, including mid-battle joins. Sizes are the real drawn sprites
// (texture contain-fit into one cell × token scale), measured 2026-10-27.
// ============================================================================
import assert from "node:assert/strict";
import { planEnemies, planEnemyJoin, planParty, placeSupport, clashes, partyLine, REF_H } from "./formation.js";

const CELL = 110;
const lab = (name, shield) => ({ lw: Math.max(name.length * 8.3 + (shield ? 22 : 0), 60), lh: 41 });
// fw/fh = image size, s = token scale, as in the world data.
function unit(key, name, fw, fh, s, extra = {}) {
  const f = CELL / Math.max(fw, fh) * s;
  const kind = extra.kind ?? "enemy";
  return { key, w: fw * f, h: fh * f, ...(kind === "pc" ? { lw: 0, lh: 0 } : lab(name, extra.shield)), kind, rank: extra.rank ?? "soldier", caster: extra.caster };
}
const bandit = (k = "bandit") => unit(k, "Bandit", 107, 202, 1.34, { shield: 1 });
const goblin = () => unit("goblin", "Goblin Bandit", 135, 168, 1.33);
const mage = () => unit("mage", "Bandit Mage", 112, 203, 1.31, { shield: 1 });
const wolf = () => unit("wolf", "Bandit Wolf", 150, 139, 1.27);
const imp = () => unit("imp", "Imp", 95, 154, 0.95);
const gigas = () => unit("gigas", "Gigas", 142, 216, 2.45, { rank: "elite", shield: 1 });

let n = 0;
const t = (name, fn) => { fn(); n++; };
const onStage = (units, pos) => units.every((u) => pos[u.key].y - u.h / 2 >= 0 && pos[u.key].y + u.h / 2 + u.lh <= REF_H);

t("enemy picker: 3–4 one diagonal, 5–6 two diagonals, all clean", () => {
  const cases = [
    [[bandit(), goblin(), mage()], "B"],
    [[bandit(), goblin(), mage(), wolf()], "B"],
    [[bandit(), goblin(), mage(), wolf(), imp()], "B×2"],
    [[bandit(), goblin(), mage(), wolf(), imp(), bandit("bandit2")], "B×2"],
  ];
  for (const [units, pick] of cases) {
    const r = planEnemies(units);
    assert.equal(r.pick, pick, `${units.length} enemies`);
    assert.equal(clashes(units, r.pos), 0, `${units.length} enemies clash-free`);
    assert.ok(onStage(units, r.pos), `${units.length} enemies on stage`);
  }
});

t("an elite or champion with adds gets the two columns", () => {
  const units = [gigas(), bandit(), goblin()];
  const r = planEnemies(units);
  assert.equal(r.pick, "C");
  assert.equal(clashes(units, r.pos), 0);
  const lone = planEnemies([gigas()]);
  assert.notEqual(lone.pick, "C", "a boss alone is not 'with adds'");
});

t("encounter override wins", () => {
  const units = [bandit(), goblin(), mage()];
  assert.equal(planEnemies(units, { mode: "columns" }).pick, "C");
  assert.equal(planEnemies(units, { mode: "line" }).pick, "B");
});

t("a joiner never lands on anyone; a giant with no room re-forms the group", () => {
  const squad = [bandit(), goblin(), mage(), wolf()], base = planEnemies(squad);
  const small = imp(), j = planEnemyJoin(squad, base.pos, small);
  const all = j.reform ? j.pos : { ...base.pos, ...j.pos };
  assert.equal(clashes([...squad, small], all), 0, "imp joins clean");
  const g = gigas(), jg = planEnemyJoin(squad, base.pos, g);
  const allg = jg.reform ? jg.pos : { ...base.pos, ...jg.pos };
  assert.equal(clashes([...squad, g], allg), 0, "gigas joins clean");
});

t("an anchored summon stays near its caster and never re-forms", () => {
  const squad = [bandit(), goblin(), mage()], base = planEnemies(squad);
  const anchor = { x: base.pos.bandit.x + 120, y: base.pos.bandit.y };
  const j = planEnemyJoin(squad, base.pos, imp(), { anchor });
  assert.equal(j.reform, false);
  assert.ok(j.pos.imp, "placed");
});

// Party: real battler frames (webm) and scales.
const pcs = () => [
  unit("hina", "Hina", 110, 254, 1.44, { kind: "pc" }),
  unit("keren", "Keren", 192, 248, 1.47, { kind: "pc" }),
  unit("blanche", "Blanche", 112, 250, 1.55, { kind: "pc" }),
  unit("zarg", "Zarg", 174, 250, 1.56, { kind: "pc" }),
];
const kalina = () => unit("kalina", "Kalina", 204, 202, 1.38, { kind: "guest", rank: "champion" });
const crysta = () => unit("crysta", "Crysta", 226, 292, 1.82, { kind: "summon", rank: "elite", caster: "keren" });
const fox = (k) => unit(k, "Fox fire", 100, 100, 0.44, { kind: "summon", caster: "keren" });

t("party: PCs keep the tuned diagonal exactly", () => {
  const p = pcs(), pos = planParty(p, [kalina()]), line = partyLine(4);
  p.forEach((u, i) => assert.deepEqual(pos[u.key], line[i]));
  assert.deepEqual(line[0], { x: 1202, y: 162 });
  assert.deepEqual(line[3], { x: 1367, y: 492 });
});

t("party: support row is clean up to all eight", () => {
  for (const extras of [[], [kalina()], [kalina(), crysta()], [kalina(), crysta(), fox("fox1"), fox("fox2")]]) {
    const p = pcs(), pos = planParty(p, extras), units = [...p, ...extras];
    assert.ok(extras.every((u) => pos[u.key]), `${extras.length} extras placed`);
    assert.equal(clashes(units, pos), 0, `${extras.length} extras clash-free`);
    for (const u of extras) assert.ok(pos[u.key].x > 1202, `${u.key} stands behind the line`);
  }
});

t("party: a mid-battle summon joins behind, near its caster", () => {
  const p = pcs(), k = kalina(), pos = planParty(p, [k]);
  const c = crysta(), at = placeSupport(p, [...p, k], pos, c);
  assert.ok(at, "placed");
  assert.equal(clashes([...p, k, c], { ...pos, crysta: at }), 0);
  const keren = pos.keren, hina = pos.hina, zarg = pos.zarg;
  assert.ok(Math.abs(at.y - keren.y) < Math.abs(at.y - zarg.y), "nearer Keren than Zarg");
  assert.ok(hina.y < at.y + 200);
});

console.log(`formation: ${n} groups passed`);
