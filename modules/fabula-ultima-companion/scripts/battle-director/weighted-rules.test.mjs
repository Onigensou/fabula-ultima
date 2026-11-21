// ============================================================================
// Weighted keyword — pure rules.
//
//     node scripts/battle-director/weighted-rules.test.mjs
//
// "You can only perform one attack per turn with this weapon. You cannot
//  perform attacks without HR with this weapon."
// Pure module, so no Foundry globals are needed.
// ============================================================================

const {
  keywordListHasWeighted, isWeightedWeapon, weaponKey, weightedActorKey, weaponsForMode,
  modeDropsHighRoll, weightedBlockReason, weightedModeBlock, weightedAttackCommandBlock,
  WEIGHTED_REASON_ONCE: ONCE, WEIGHTED_REASON_HR: HR,
} = await import("./weighted-rules.js");

let failed = 0, passed = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; return; }
  failed++;
  console.log(`FAIL  ${label}\n      got  ${g}\n      want ${w}`);
}

const club   = { name: "Giant Club", uuid: "Actor.a.Item.club", actionKeywords: "Weighted" };
const morn   = { name: "Morning Star", uuid: "Actor.a.Item.ms", actionKeywords: "crush, weighted" };
const sword  = { name: "Sword", uuid: "Actor.a.Item.sw", actionKeywords: "pierce" };
const dagger = { name: "Dagger", uuid: "Actor.a.Item.dg", actionKeywords: "" };
const shieldGranted = { name: "Sword", uuid: "Actor.a.Item.sw2", actionKeywords: "", weighted: true };

// ── keyword ──────────────────────────────────────────────────────────────────
eq("bare",            keywordListHasWeighted("weighted"), true);
eq("case + list",     keywordListHasWeighted("Crush, WEIGHTED\npierce"), true);
eq("array",           keywordListHasWeighted(["pierce", " weighted "]), true);
eq("substring no",    keywordListHasWeighted("overweighted"), false);
eq("empty",           keywordListHasWeighted(""), false);
eq("weapon kw",       isWeightedWeapon(club), true);
eq("weapon stamp",    isWeightedWeapon(shieldGranted), true);
eq("plain weapon",    isWeightedWeapon(sword), false);
eq("null weapon",     isWeightedWeapon(null), false);
eq("key uuid",        weaponKey(club), "Actor.a.Item.club");
eq("key name",        weaponKey({ name: "Claw" }), "Claw");
eq("actor key token", weightedActorKey({ tokenUuid: "Scene.s.Token.t", actorId: "a" }), "Scene.s.Token.t");
eq("actor key id",    weightedActorKey({ actorId: "a" }), "a");

// ── mode mapping (mirrors state-handlers weaponsUsed) ────────────────────────
const kit = { mainWeapon: club, offWeapon: dagger, multiAttack: { count: 3, keepHr: true }, virtualAttacks: [sword] };
eq("main",      weaponsForMode("main", kit).map((w) => w.name), ["Giant Club"]);
eq("off",       weaponsForMode("off", kit).map((w) => w.name), ["Dagger"]);
eq("twf",       weaponsForMode("two-weapon", kit).map((w) => w.name), ["Giant Club", "Dagger"]);
eq("twf off1",  weaponsForMode("two-weapon-off-first", kit).map((w) => w.name), ["Dagger", "Giant Club"]);
eq("multi x3",  weaponsForMode("two-weapon-multi", kit).length, 3);
eq("virtual",   weaponsForMode("virtual:0", kit).map((w) => w.name), ["Sword"]);
eq("hr twf",    modeDropsHighRoll("two-weapon"), true);
eq("hr multi keep", modeDropsHighRoll("two-weapon-multi", { keepHr: true }), false);
eq("hr multi drop", modeDropsHighRoll("two-weapon-multi", { keepHr: false }), true);
eq("hr main",   modeDropsHighRoll("main"), false);

// ── clause 1: one attack per turn ───────────────────────────────────────────
eq("first swing ok",       weightedModeBlock("main", { mainWeapon: club }), null);
eq("second swing blocked", weightedModeBlock("main", { mainWeapon: club, usedKeys: [club.uuid] }), ONCE);
eq("other weapon ok",      weightedModeBlock("off", { mainWeapon: club, offWeapon: dagger, usedKeys: [club.uuid] }), null);
eq("non-weighted repeat",  weightedModeBlock("main", { mainWeapon: sword, usedKeys: [sword.uuid] }), null);
eq("multi keepHr blocked", weightedModeBlock("two-weapon-multi", { mainWeapon: club, multiAttack: { count: 2, keepHr: true } }), ONCE);
eq("multi plain ok",       weightedModeBlock("two-weapon-multi", { mainWeapon: sword, multiAttack: { count: 2 } }), null);

// ── clause 2: no attacks without HR ─────────────────────────────────────────
eq("twf weighted main",    weightedModeBlock("two-weapon", { mainWeapon: club, offWeapon: dagger }), HR);
eq("twf weighted off",     weightedModeBlock("two-weapon-off-first", { mainWeapon: dagger, offWeapon: morn }), HR);
eq("twf plain ok",         weightedModeBlock("two-weapon", { mainWeapon: sword, offWeapon: dagger }), null);
eq("multi drops HR",       weightedModeBlock("two-weapon-multi", { mainWeapon: club, multiAttack: { count: 2 } }), HR);
eq("free hrAsZero",        weightedModeBlock("main", { mainWeapon: club, grant: { hrAsZero: true } }), HR);
eq("free hrAsZero plain",  weightedModeBlock("main", { mainWeapon: sword, grant: { hrAsZero: true } }), null);
eq("free attack w/ HR ok", weightedModeBlock("main", { mainWeapon: club, grant: { hrAsZero: false } }), null);
eq("free attack 2nd swing", weightedModeBlock("main", { mainWeapon: club, grant: {}, usedKeys: [club.uuid] }), ONCE);
eq("chain strike exempt",  weightedModeBlock("main", { mainWeapon: club, grant: { chain: true, hrAsZero: true }, usedKeys: [club.uuid] }), null);
eq("shield-granted",       weightedModeBlock("main", { mainWeapon: shieldGranted, usedKeys: [shieldGranted.uuid] }), ONCE);
eq("raw list",             weightedBlockReason({ weapons: [club, club] }), ONCE);
eq("npc pseudo",           weightedModeBlock("npc", { mainWeapon: { name: "Smash", uuid: "Item.x", actionKeywords: "weighted" }, usedKeys: ["Item.x"] }), ONCE);

// ── whole Attack command ────────────────────────────────────────────────────
eq("cmd all blocked",  weightedAttackCommandBlock({ mainWeapon: club, usedKeys: [club.uuid] }), ONCE);
eq("cmd off rescues",  weightedAttackCommandBlock({ mainWeapon: club, offWeapon: dagger, usedKeys: [club.uuid] }), null);
eq("cmd virtual rescues", weightedAttackCommandBlock({ mainWeapon: club, virtualAttacks: [sword], usedKeys: [club.uuid] }), null);
eq("cmd hr grant",     weightedAttackCommandBlock({ mainWeapon: club, grant: { hrAsZero: true } }), HR);
eq("cmd fresh",        weightedAttackCommandBlock({ mainWeapon: club }), null);
eq("cmd no weapons",   weightedAttackCommandBlock({}), null);
eq("cmd solo double",  weightedAttackCommandBlock({ mainWeapon: club, offWeapon: club, usedKeys: [club.uuid] }), ONCE);

console.log(`\nweighted-rules: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
