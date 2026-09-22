// ============================================================================
// Test runner — result extraction and the honesty audit.
//
//     node scripts/skill-forge/test-runner.test.mjs
//
// The runner's job is not to simulate — the harness does that. Its job is to
// stop a green result from meaning more than the run supports, because a
// harness that omits a payload field fails PERMISSIVE: a missing identifier
// resolves to 0, and for a `== 0` gate that is the PASSING answer.
//
// So these assertions are mostly about the caveats: the test button is only
// worth having if it refuses to say "works" when it cannot know.
// ============================================================================

const tr = await import("./test-runner.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const blocking = (cs) => cs.filter((c) => c.severity === "blocking");

function doc(props = {}, name = "Test Skill") {
  return { name, system: { props } };
}
function rows(...list) {
  const o = {}; list.forEach((r, i) => { o[String(i)] = r; }); return o;
}

// ── result shape: the inverted contract ─────────────────────────────────────
// The guideline told SKILL authors to read res.passes[0].actionResult. That is
// the ATTACK shape; runDirectorSkillSimulate returns a top-level actionResult.
// Reading the wrong one yields undefined, "which looks exactly like the
// reaction didn't fire".
console.log("\n— result extraction —");
eq("skill run reads the top-level actionResult",
  tr.extractActionResults({ actionResult: { id: 1 } }, "skill").results, [{ id: 1 }]);
eq("attack run reads passes[]",
  tr.extractActionResults({ passes: [{ actionResult: { id: 1 } }, { actionResult: { id: 2 } }] }, "attack").results,
  [{ id: 1 }, { id: 2 }]);
eq("a skill run handed the ATTACK shape SAYS SO rather than coping silently",
  /ATTACK result shape/.test(tr.extractActionResults({ passes: [] }, "skill").problem), true);
eq("an attack run with no passes says so",
  /no `passes/.test(tr.extractActionResults({ actionResult: {} }, "attack").problem), true);
eq("an empty result is reported, not returned as 'nothing happened'",
  /did not produce a result/.test(tr.extractActionResults({}, "skill").problem), true);
eq("a null result is handled", tr.extractActionResults(null).results, []);

// ── caveat: pre-resolve reactions need acceptReactions ──────────────────────
console.log("\n— caveat: unaccepted pre-resolve reactions —");
{
  const d = doc({ reaction_config_table: rows(
    { reaction_trigger: "creature_will_deal_damage", reaction_effect_ref: "r" }) });
  eq("without acceptReactions the run is called out",
    blocking(tr.auditRun({ doc: d, args: {} })).length >= 1, true);
  eq("the caveat names the real fix",
    blocking(tr.auditRun({ doc: d, args: {} }))[0].fix, "Re-run with acceptReactions: true.");
  eq("with acceptReactions it is not raised",
    blocking(tr.auditRun({ doc: d, args: { acceptReactions: true } }))
      .filter((c) => /pre-resolve/.test(c.text)).length, 0);
  eq("a POST-resolve trigger does not raise it",
    blocking(tr.auditRun({ doc: doc({ reaction_config_table: rows(
      { reaction_trigger: "creature_deals_damage", reaction_effect_ref: "r" }) }), args: {} }))
      .filter((c) => /pre-resolve/.test(c.text)).length, 0);
}

// ── caveat: the argument that does not exist ────────────────────────────────
console.log("\n— caveat: prePassives is not an argument —");
eq("passing prePassives is flagged as silently ignored",
  blocking(tr.auditRun({ doc: doc(), args: { prePassives: true } }))
    .some((c) => /nowhere in module source/.test(c.text)), true);

// ── caveat: COMPUTE is thin ─────────────────────────────────────────────────
console.log("\n— caveat: compute-only run —");
{
  const d = doc({ effect_table: rows({ effect_kind: "deal_damage", effect_label: "h" }) });
  eq("a compute-only run over a RESOLVE-side row is flagged",
    blocking(tr.auditRun({ doc: d, args: { computeOnly: true } }))
      .some((c) => /RESOLVE/.test(c.text)), true);
  eq("a simulate run is not flagged for it",
    blocking(tr.auditRun({ doc: d, args: {} })).some((c) => /RESOLVE/.test(c.text)), false);
}

// ── caveat: target affinity ─────────────────────────────────────────────────
// The bench dummy is air-IMMUNE and bolt-VULNERABLE; an air skill writes 0
// against it and looks broken.
console.log("\n— caveat: target affinity —");
{
  const air = doc({ type_damage: "air" });
  eq("an immune target invalidates a 0",
    blocking(tr.auditRun({ doc: air, args: { targetAffinities: { air: "IM" } } }))
      .some((c) => /IMMUNE/.test(c.text)), true);
  eq("a vulnerable target is a note, not blocking",
    tr.auditRun({ doc: air, args: { targetAffinities: { air: "VU" } } })
      .some((c) => c.severity === "note"), true);
  eq("a neutral target raises nothing",
    tr.auditRun({ doc: air, args: { targetAffinities: { air: "" } } })
      .filter((c) => /IMMUNE|vulnerable/.test(c.text)).length, 0);
}

// ── caveat: THE permissive case ─────────────────────────────────────────────
// A gate reading a payload field the rig never set. This is the one that let a
// Scene spell pass an instantaneous-only gate.
console.log("\n— caveat: payload field the gate reads was never supplied —");
{
  const d = doc({ effect_table: rows(
    { effect_kind: "chain", effect_label: "c", condition_formula: "ACTION_DURATION == 0" }) });
  const cs = blocking(tr.auditRun({ doc: d, args: { acceptReactions: true, payloadKeys: [] } }));
  eq("a gate on an unsupplied payload field is flagged", cs.length >= 1, true);
  eq("the caveat names the identifier AND the payload key",
    /ACTION_DURATION \(needs payload\.skillDuration\)/.test(cs[0].text), true);
  eq("the caveat explains the permissive direction",
    /PASSING answer/.test(cs[0].text), true);
  eq("supplying the field clears it",
    blocking(tr.auditRun({ doc: d, args: { acceptReactions: true, payloadKeys: ["skillDuration"] } }))
      .filter((c) => /ACTION_DURATION/.test(c.text)).length, 0);
  eq("an actor-backed identifier is not flagged",
    blocking(tr.auditRun({ doc: doc({ effect_table: rows(
      { effect_kind: "chain", effect_label: "c", condition_formula: "CUR_MP >= 10" }) }),
      args: { acceptReactions: true, payloadKeys: [] } })).length, 0);
}

// ── caveat: could this run have failed at all? ──────────────────────────────
console.log("\n— caveat: zero writes —");
eq("a run that wrote nothing is called out",
  blocking(tr.auditRun({ doc: doc(), args: { acceptReactions: true }, result: { captures: {} } }))
    .some((c) => /ZERO document writes/.test(c.text)), true);
eq("the fix is the gate-neutralising trick",
  blocking(tr.auditRun({ doc: doc(), args: { acceptReactions: true }, result: { captures: {} } }))
    .find((c) => /ZERO/.test(c.text)).fix.includes("literal 1"), true);
eq("a run that wrote something is not flagged",
  blocking(tr.auditRun({ doc: doc(), args: { acceptReactions: true },
    result: { captures: { damage: [{ amount: 5 }] } } })).some((c) => /ZERO/.test(c.text)), false);

// ── prose ───────────────────────────────────────────────────────────────────
console.log("\n— prose —");
{
  const out = tr.describeRun({
    doc: doc({}, "Fire Bolt"),
    result: { captures: {
      damage: [{ targetName: "Goblin", amount: 20, element: "fire" }],
      resources: [{ targetName: "Hero", delta: -10, resource: "mp" }],
      effects: [{ targetName: "Goblin", name: "Burning", rounds: 3 }],
    } },
    caveats: [],
  });
  eq("names the skill", out.split("\n")[0], "Fire Bolt");
  eq("states damage plainly", /Goblin takes 20 fire damage/.test(out), true);
  eq("states a resource loss plainly", /Hero loses 10 MP/.test(out), true);
  eq("states an effect plainly", /Goblin gains the effect "Burning" for 3 round\(s\)/.test(out), true);

  const empty = tr.describeRun({ doc: doc({}, "Dud"), result: { captures: {} }, caveats: [] });
  eq("says plainly when nothing was written", /NOTHING WAS WRITTEN/.test(empty), true);

  const caveated = tr.describeRun({
    doc: doc({}, "X"), result: { captures: { damage: [{ amount: 1 }] } },
    caveats: [{ severity: "blocking", text: "reason", fix: "do this" }],
  });
  eq("a blocking caveat refuses to let green read as a pass",
    /DOES NOT PROVE THE SKILL WORKS/.test(caveated), true);
}

// ── runTest guards ──────────────────────────────────────────────────────────
console.log("\n— runTest —");
{
  const noHarness = await tr.runTest({ skillUuid: "x" });
  eq("without the harness it refuses rather than pretending", noHarness.ok, false);
  eq("and says why", noHarness.reason, "harness_unavailable");

  globalThis.FUCompanion = { api: { test: {
    runDirectorSkillSimulate: async () => { throw new Error("boom"); },
  } } };
  const threw = await tr.runTest({ skillUuid: "x", doc: doc() });
  eq("a thrown simulate is reported", threw.reason, "simulate_threw");
  // I4a: the throw leaves write-capture patches installed and every later write
  // is silently swallowed. The caveat has to say so or the next hour is lost.
  eq("and warns that later writes are now swallowed",
    /silently swallowed/.test(threw.caveats[0].text), true);
  eq("and tells the user to reload", /[Rr]eload/.test(threw.caveats[0].fix), true);

  globalThis.FUCompanion.api.test.runDirectorSkillSimulate =
    async () => ({ ok: true, actionResult: { id: 1 }, captures: { damage: [{ amount: 7 }] } });
  const good = await tr.runTest({ skillUuid: "x", doc: doc() });
  eq("a healthy run reports ok", good.ok, true);
  eq("and extracts the result", good.actionResults, [{ id: 1 }]);
  eq("and renders prose", /takes 7/.test(good.prose), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
