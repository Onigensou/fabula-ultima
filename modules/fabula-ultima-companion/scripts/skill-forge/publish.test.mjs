// ============================================================================
// Draft / publish gate.
//
//     node scripts/skill-forge/publish.test.mjs
//
// The gate's whole job is to keep a skill that reads correct but BEHAVES
// otherwise out of play, because that is the failure a non-programmer cannot
// diagnose. So the assertions are about what blocks, what only informs, and
// that a forced publish can never be mistaken for a clean one.
// ============================================================================

const pub = await import("./publish.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const err = (code, location = "system.props.x") => ({
  severity: "error", code, location, title: `${code} title`, why: "because", fix: "do this",
});
const warn = (code, location = "system.props.y") => ({
  severity: "warning", code, location, title: `${code} title`, why: "because", fix: "do this",
});

// ── draft flag ──────────────────────────────────────────────────────────────
console.log("\n— draft state —");
eq("a fresh document is not a draft", pub.isDraft({}), false);
eq("the flag is read from the module namespace",
  pub.isDraft({ flags: { "fabula-ultima-companion": { skillForgeDraft: true } } }), true);
eq("marking a draft sets the flag",
  pub.draftPatch(true)["flags.fabula-ultima-companion.skillForgeDraft"], true);
// null, not false — Foundry deletes a flag on null, so an unpublished document
// carries no residue rather than an explicit `false` nobody reads.
eq("clearing a draft NULLS the flag rather than writing false",
  pub.draftPatch(false)["flags.fabula-ultima-companion.skillForgeDraft"], null);

// ── what blocks ─────────────────────────────────────────────────────────────
console.log("\n— the gate —");
eq("no findings publishes", pub.canPublish([]).ok, true);
eq("an error blocks", pub.canPublish([err("PROP_UNDECLARED")]).ok, false);
// Warnings are real but do not change what the skill DOES, so they inform.
eq("a warning alone does NOT block", pub.canPublish([warn("ROW_COLUMN_UNDECLARED")]).ok, true);
eq("warnings are still reported", pub.canPublish([warn("ROW_COLUMN_UNDECLARED")]).warnings.length, 1);
eq("errors and warnings are separated",
  (() => { const d = pub.canPublish([err("A"), warn("B"), err("C")]);
    return [d.errors.length, d.warnings.length]; })(), [2, 1]);

// The same finding on eight rows is ONE thing to fix, not eight.
console.log("\n— grouping —");
{
  const d = pub.canPublish([err("SAME", "a"), err("SAME", "b"), err("OTHER", "c")]);
  eq("findings group by code", d.blockers.length, 2);
  eq("every location is kept", d.blockers.find((b) => b.code === "SAME").where, ["a", "b"]);
}

// ── explanation ─────────────────────────────────────────────────────────────
console.log("\n— explanation —");
{
  const ok = pub.explainDecision(pub.canPublish([]), "Fire Bolt");
  eq("a clean skill says it is ready", /Fire Bolt is ready to publish/.test(ok), true);

  const withAdvice = pub.explainDecision(pub.canPublish([warn("W")]), "Fire Bolt");
  eq("advisories are listed but do not read as blockers",
    /ready to publish/.test(withAdvice) && /advisories/.test(withAdvice), true);

  const blocked = pub.explainDecision(pub.canPublish([err("E")]), "Fire Bolt");
  eq("a blocked skill says so", /cannot be published yet/.test(blocked), true);
  // The consequence, not the rule id — "PROP_UNDECLARED" is not actionable to
  // the person this whole layer exists for.
  eq("it states the consequence", /behave differently from how it reads/.test(blocked), true);
  eq("it carries the fix", /do this/.test(blocked), true);
}

// ── publishing ──────────────────────────────────────────────────────────────
console.log("\n— publish —");
{
  let wrote = null;
  const write = async (p) => { wrote = p; };

  wrote = null;
  const blocked = await pub.publish({ doc: { name: "X" }, findings: [err("E")], write });
  eq("a blocked publish does not write", wrote, null);
  eq("and reports not-ok", blocked.ok, false);

  wrote = null;
  const clean = await pub.publish({ doc: { name: "X" }, findings: [], write });
  eq("a clean publish writes the flag clear",
    wrote["flags.fabula-ultima-companion.skillForgeDraft"], null);
  eq("and reports ok", clean.ok, true);

  // A forced publish is a decision on the record — like clearing world-export's
  // removal warnings. It must never render as a clean pass.
  wrote = null;
  const forced = await pub.publish({ doc: { name: "X" }, findings: [err("E")], write, force: true });
  eq("a forced publish writes", wrote !== null, true);
  eq("and is marked as forced", forced.forced, true);
  eq("and says so loudly", /PUBLISHED WITH 1 UNRESOLVED ERROR\(S\) — forced/.test(forced.message), true);
  eq("and still lists what was unresolved", /cannot be published yet/.test(forced.message), true);

  wrote = null;
  await pub.unpublish({ write });
  eq("unpublishing is always allowed",
    wrote["flags.fabula-ultima-companion.skillForgeDraft"], true);
}

// ── the draft flag has to mean something to the ENGINE, not just the panel ──
// It was read only by the Forge's own Publish tab, so a draft dropped on a
// creature was offered and resolved exactly like finished content while the
// panel promised it "is not offered in play until you publish it". The engine
// now skips drafts in `candidateFromSkill`; these pin the predicate that gate
// depends on, including the shape a LIVE Foundry document presents.
console.log("\n— draft predicate (engine-facing) —");
{
  const NS = "fabula-ultima-companion";
  eq("a freshly forged skill is a draft",
    pub.isDraft({ flags: { [NS]: { skillForgeDraft: true } } }), true);
  eq("a published skill is not",
    pub.isDraft({ flags: { [NS]: { skillForgeDraft: null } } }), false);
  eq("content that never touched the Forge is not a draft",
    pub.isDraft({ flags: {} }), false);
  eq("nor is a doc with no flags at all", pub.isDraft({}), false);
  eq("nor is a missing doc", pub.isDraft(null), false);
  // 🚨 Strict true only. A truthy-but-not-true value must NOT hide a skill —
  // over-blocking here silently removes working content from every menu, which
  // is worse than the bug this gate fixes.
  eq("a truthy non-true flag does not hide the skill",
    pub.isDraft({ flags: { [NS]: { skillForgeDraft: "yes" } } }), false);
  eq("another module's flag of the same name is ignored",
    pub.isDraft({ flags: { other: { skillForgeDraft: true } } }), false);
  // draftPatch round-trips through the predicate
  const on = pub.draftPatch(true), off = pub.draftPatch(false);
  eq("draftPatch(true) sets the key the predicate reads",
    on[`flags.${NS}.skillForgeDraft`], true);
  eq("draftPatch(false) nulls it", off[`flags.${NS}.skillForgeDraft`], null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
