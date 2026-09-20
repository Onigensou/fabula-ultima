// ============================================================================
// ORIGINAL_TARGET_CURRENT_HP / ORIGINAL_TARGET_MAX_HP — formula harness.
//
//     node scripts/battle-director/original-target-hp.test.mjs
//
// The redirect-aware twins of TARGET_CURRENT_HP / TARGET_MAX_HP. When Protect /
// Prophetic Defender moves a slot onto a defender, TARGET_* reads the defender;
// these read the ally that was covered. Hilde-Fafnir's Reinslaughter scales on
// the victim's missing HP, and the design says a defender who covers a 1-HP ally
// takes the 1-HP hit. If these silently fell back to the defender, the rule would
// quietly stop working and nothing at the table would show why.
//
// Foundry globals are stubbed just far enough for fromUuidSync to resolve.
// ============================================================================

const ACTORS = {
  "Actor.defender": { documentName: "Actor", system: { props: { current_hp: 180, max_hp: 200 } } },
  "Actor.allyLow":  { documentName: "Actor", system: { props: { current_hp: 1,   max_hp: 150 } } },
  "Actor.allyMid":  { documentName: "Actor", system: { props: { current_hp: 60,  max_hp: 120 } } },
};
globalThis.foundry = { utils: { fromUuidSync: (u) => ACTORS[u] ?? null } };

const { buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");

let failed = 0;
function check(label, payload, formula, expected) {
  const resolver = buildSkillResolver({ actor: null, payload });
  const got = Number(evaluateFormula(formula, resolver));
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${formula} = ${got}${ok ? "" : ` (expected ${expected})`}`);
}

// No redirect → identical to TARGET_*.
check("no redirect, current", { subjectActorUuid: "Actor.defender" }, "ORIGINAL_TARGET_CURRENT_HP", 180);
check("no redirect, max",     { subjectActorUuid: "Actor.defender" }, "ORIGINAL_TARGET_MAX_HP", 200);
check("TARGET_* unchanged",   { subjectActorUuid: "Actor.defender", originalSubjectActorUuids: ["Actor.allyLow"] },
      "TARGET_CURRENT_HP", 180);

// Redirected: reads the covered ally, not the defender.
check("redirect, current", { subjectActorUuid: "Actor.defender", originalSubjectActorUuids: ["Actor.allyLow"] },
      "ORIGINAL_TARGET_CURRENT_HP", 1);
check("redirect, max",     { subjectActorUuid: "Actor.defender", originalSubjectActorUuids: ["Actor.allyLow"] },
      "ORIGINAL_TARGET_MAX_HP", 150);

// Covering several allies (plus own slot): the lowest HP% wins, cur+max from the SAME creature.
const multi = { subjectActorUuid: "Actor.defender", originalSubjectActorUuids: ["Actor.defender", "Actor.allyMid", "Actor.allyLow"] };
check("multi, current", multi, "ORIGINAL_TARGET_CURRENT_HP", 1);
check("multi, max",     multi, "ORIGINAL_TARGET_MAX_HP", 150);

// Empty list falls back to the subject.
check("empty list fallback", { subjectActorUuid: "Actor.allyMid", originalSubjectActorUuids: [] }, "ORIGINAL_TARGET_CURRENT_HP", 60);

// No subject at all → 0, never throws.
check("no subject", {}, "ORIGINAL_TARGET_MAX_HP", 0);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
