// ============================================================================
// Execute / Cripple — keyword-driven damage rule.
//
//     node scripts/battle-director/crisis-keywords.test.mjs
//
// The rule belongs to the KEYWORD, not to the skill's name. Before this, each
// skill carried its own ×2 reaction scoped by `reaction_source_skill`, so a
// rename silently disabled it and the keyword itself was inert. These assert
// the replacement: the op set derives from the keyword list plus the target's
// Crisis state, and nothing else.
//
// Pure function, so no Foundry globals are needed.
// ============================================================================

const { crisisKeywordOps } = await import("./action-profile.js");

let failed = 0;
const show = (ops) => ops.map((o) => `${o.source}:${o.op}${o.amount}`).join(",") || "(none)";
function check(label, keywords, inCrisis, expected) {
  const got = show(crisisKeywordOps(keywords, inCrisis));
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: [${keywords}] inCrisis=${inCrisis} -> ${got}${ok ? "" : ` (expected ${expected})`}`);
}

// Execute: doubles ONLY against a target already in Crisis.
check("execute vs Crisis",      ["execute"], true,  "Execute:multiply2");
check("execute vs healthy",     ["execute"], false, "(none)");

// Cripple: the mirror.
check("cripple vs healthy",     ["cripple"], false, "Cripple:multiply2");
check("cripple vs Crisis",      ["cripple"], true,  "(none)");

// Unrelated keywords never contribute, and coexist with the two that do.
check("pierce alone",           ["pierce"], true,  "(none)");
check("execute + pierce",       ["execute", "pierce"], true, "Execute:multiply2");
check("multi + cripple",        ["multi", "cripple"], false, "Cripple:multiply2");

// Both on one action: exactly one side can apply to a given target.
check("both vs Crisis",         ["execute", "cripple"], true,  "Execute:multiply2");
check("both vs healthy",        ["execute", "cripple"], false, "Cripple:multiply2");

// Degenerate inputs are inert, never throwing.
check("empty list",             [], true, "(none)");
check("null list",              null, true, "(none)");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
