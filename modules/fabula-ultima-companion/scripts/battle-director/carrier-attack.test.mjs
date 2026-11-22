// ============================================================================
// Carrier attacks (Sonic Blow, 2026-11-21) + the Chain "Perfect" bonus.
//
//     node scripts/battle-director/carrier-attack.test.mjs
//
// Pure modules, no Foundry globals.
// ============================================================================

const {
  isCarrierAttackSkill, findCarrierWeaponSnapshot, carrierRiders, buildCarrierAttackWeapon,
  rewriteCarrierAttackBundle, carrierDamageMults,
} = await import("./carrier-attack.js");
const { createStrikeWalker, volleyShotContext, volleyPrimary } = await import("./chain-strikes.js");

let failed = 0, passed = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; return; }
  failed++;
  console.log(`FAIL  ${label}\n      got  ${g}\n      want ${w}`);
}

const NS = "fabula-ultima-companion";
const katar = { hand: "main", name: "Sonic Katar", A1: "DEX", A2: "DEX", checkBonus: 1, damageBonus: 5, damageType: "Physical",
  range: "Melee", weaponType: "Dagger", uuid: "Actor.a.Item.KATAR", actionKeywords: "", skillTarget: "One Enemy" };
const skill = {
  uuid: "Actor.a.Item.SB", name: "Sonic Blow", img: "sb.png",
  system: { container: "KATAR", props: { attack_with_carrier: true, check_bonus: "-2", action_keywords: "chain 8 volley",
    skill_target: "One creature", description: "<p>x</p>" } },
  flags: { [NS]: { carrierAttack: { damageMult: 2, critDamageMult: 1.5, noCritOpportunity: true, perfectMult: 1.5 } } },
};

// ── recognising + finding the carrier ────────────────────────────────────────
eq("carrier skill", isCarrierAttackSkill(skill), true);
eq("plain skill", isCarrierAttackSkill({ system: { props: {} } }), false);
eq("string flag", isCarrierAttackSkill({ system: { props: { attack_with_carrier: "true" } } }), true);
eq("finds main hand", findCarrierWeaponSnapshot(skill, { weapon: katar })?.name, "Sonic Katar");
eq("finds off hand", findCarrierWeaponSnapshot(skill, { weapon: { uuid: "Actor.a.Item.OTHER" }, offWeapon: katar })?.name, "Sonic Katar");
eq("not in hand", findCarrierWeaponSnapshot(skill, { weapon: { uuid: "Actor.a.Item.OTHER" } }), null);
eq("riders", carrierRiders(skill), { damageMult: 2, critDamageMult: 1.5, noCritOpportunity: true, perfectMult: 1.5 });
eq("riders default", carrierRiders({}), { damageMult: 1, critDamageMult: 1, noCritOpportunity: false, perfectMult: 1 });

// ── the pseudo-weapon ────────────────────────────────────────────────────────
const w = buildCarrierAttackWeapon(skill, { weapon: katar });
eq("pseudo: weapon pair + damage", [w.A1, w.A2, w.damageBonus, w.damageType, w.range, w.weaponType], ["DEX", "DEX", 5, "Physical", "Melee", "Dagger"]);
eq("pseudo: accuracy = weapon + skill", w.checkBonus, -1);
eq("pseudo: keywords merged", w.actionKeywords, "chain 8 volley");
eq("pseudo: keeps the WEAPON uuid (on-hit rows)", w.uuid, "Actor.a.Item.KATAR");
eq("pseudo: skill named for cost + animation", [w.npcAttackItemUuid, w.animationItemUuid, w.name, w.hand], ["Actor.a.Item.SB", "Actor.a.Item.SB", "Sonic Blow", "npc"]);
eq("pseudo: riders", [w.damageMult, w.critDamageMult, w.noCritOpportunity, w.chainPerfectMult], [2, 1.5, true, 1.5]);
eq("pseudo: skill target", w.skillTarget, "One creature");
eq("pseudo: weapon keywords kept", buildCarrierAttackWeapon(skill, { weapon: { ...katar, actionKeywords: "pierce" } }).actionKeywords, "pierce, chain 8 volley");
eq("pseudo: no weapon → null", buildCarrierAttackWeapon(skill, { weapon: null }), null);

// ── DECLARE rewrite ──────────────────────────────────────────────────────────
const get = (u) => (u === skill.uuid ? skill : { system: { props: {} } });
eq("bundle rewritten", rewriteCarrierAttackBundle({ command: "Skill", skillUuid: skill.uuid, targetUuids: ["T"] }, get),
  { command: "Attack", skillUuid: skill.uuid, targetUuids: ["T"], attackMode: "npc", npcAttackItemUuid: skill.uuid, carrierAttack: true });
const other = { command: "Skill", skillUuid: "Actor.a.Item.X", targetUuids: [] };
eq("other skill untouched", rewriteCarrierAttackBundle(other, get) === other, true);
const atk = { command: "Attack", attackMode: "main" };
eq("attack untouched", rewriteCarrierAttackBundle(atk, get) === atk, true);

// ── damage multipliers ───────────────────────────────────────────────────────
const v8 = volleyShotContext({ count: 8, mode: "volley" }, 1);
eq("volley ×2 over 8 shots", carrierDamageMults({ damageMult: 2 }, v8), { shotMult: 0.25, flatMult: 2 });
eq("single hit ×2", carrierDamageMults({ damageMult: 2 }, null), { shotMult: 2, flatMult: 1 });
eq("no mult", carrierDamageMults({}, v8), { shotMult: 1, flatMult: 1 });
// One normal Sonic Katar hit at HR 7: 7 + 5 = 12. A Sonic Blow shot at the same HR:
// floor((7 + 5) × 0.25) = 3 = 0.25 × 12. With a +10 flat bonus (Powerful Shot): a
// normal hit is 22; the shots share 10 × 2 = 20 → 3,3,3,3,2,2,2,2, so each shot is
// 0.25 × 22 = 5.5 on average (6,6,6,6,5,5,5,5 → 44 = 2 × 22 over 8 shots).
const shot = (k) => {
  const v = volleyShotContext({ count: 8, mode: "volley" }, k);
  const prim = volleyPrimary({ damageBonus: 5, grantDamageBonus: 0, outgoingTotal: 10 * 2 }, v);
  return Math.floor((7 + prim.ownBonus) * 0.25) + prim.flatShare;
};
eq("8 shots with +10 flat = 2 × a normal hit", [1, 2, 3, 4, 5, 6, 7, 8].map(shot), [6, 6, 6, 6, 5, 5, 5, 5]);
eq("sum = 44 = 2 × 22", [1, 2, 3, 4, 5, 6, 7, 8].map(shot).reduce((a, b) => a + b, 0), 44);

// ── Perfect ──────────────────────────────────────────────────────────────────
function walk(hits, { hp = 200, mult = 1.5 } = {}) {
  const states = new Map([["T", { hp, maxHp: 200, shield: 0, blockers: 0, priorHits: 0 }]]);
  const wk = createStrikeWalker(states);
  hits.forEach((h, i) => wk.step({ index: i + 1, roll: { total: 10, isCrit: false }, targets: ["T"] },
    () => (h ? { hit: true, kind: "hit", amount: h, affinity: "NE", element: "physical" } : { hit: false, kind: "miss" })));
  const pf = wk.perfect(mult);
  return { pf, res: wk.finish(), state: states.get("T") };
}
const all = walk([3, 3, 4, 3, 3, 3, 4, 3]);
eq("8/8: perfect strike added", [all.pf?.index, all.pf?.perfect, all.pf?.outcomes?.[0]?.amount], [9, true, 13]);   // 26 × 0.5 = 13
eq("8/8: gold, no banner", [all.pf.outcomes[0].isCrit, all.pf.outcomes[0].critBanner], [true, false]);
eq("8/8: target total ×1.5", all.res.perTarget.get("T").damage, 39);
eq("8/8: HP", all.state.hp, 161);
eq("8/8: not a hit, not a crit", [all.res.perTarget.get("T").hitsLanded, all.res.perTarget.get("T").crits, all.res.landed], [8, 0, 8]);
eq("8/8: no Opportunity from it", all.res.attackerOpportunity, false);
const seven = walk([3, 3, 0, 3, 3, 3, 4, 3]);
eq("7/8: no perfect", [seven.pf, seven.res.strikes.length, seven.res.perTarget.get("T").damage], [null, 8, 22]);
eq("mult 1: no perfect", walk([3, 3], { mult: 1 }).pf, null);
const kill = walk([3, 3, 3, 3, 3, 3, 3, 3], { hp: 30 });
eq("perfect can kill", [kill.pf.outcomes[0].amount, kill.pf.outcomes[0].hpLoss, kill.pf.outcomes[0].killing, kill.state.hp], [12, 6, true, 0]);
const dead = walk([10, 10, 10], { hp: 25 });
eq("target already down: lost strikes are not landed → no perfect", dead.pf, null);

console.log(`carrier-attack: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
