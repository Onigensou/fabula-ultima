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

// ── the capture shape, COPIED FROM A LIVE RUN — do not hand-write this ───────
// Recorded 2026-09-23 from `runDirectorSkillSimulate` on the practice scene:
// a one-target damaging skill, Test Caster -> Test Target Enemy.
//
// 🚨 This fixture exists because the previous version of this suite INVENTED
// the shape (`captures.damage[].amount`, `captures.resources[].delta`, …).
// Those keys are not what the harness returns, and because the renderer read
// the same invention, 38 assertions passed while the live Test button could
// only ever print "NOTHING WAS WRITTEN" — on a skill that took the target from
// 10000 HP to 9988. A suite that cannot fail in the direction that matters is
// worse than no suite. If the harness changes, RE-CAPTURE this; never edit it
// to make an assertion go green.
const LIVE_CAPTURES = {
  actorUpdates: [
    { actorUuid: "Actor.WJnlTHuNJaILbnrc", actorName: "Test Target Enemy",
      patch: { "system.props.current_hp": 9988 } },
    { actorUuid: "Actor.t6E3CQ0pGxwLgXrn", actorName: "EXFURSION Party",
      patch: { "system.props.battle_log": "[{\"ts\":\"…\"}]" } },
  ],
  itemUpdates: [], aeUpdates: [], aeCreates: [], aeDeletes: [], freeActions: [],
};

// Same run, `status_to_enemy` pattern -> one applied AE. Note the actor key is
// `parentName` here and `actorName` in actorUpdates; the renderer reads both.
const LIVE_AE_CREATES = [
  { parentUuid: "Actor.WJnlTHuNJaILbnrc", parentName: "Test Target Enemy", name: "Poisoned",
    statusIds: ["DHsoSawNEZAxsnQ9"],
    changes: [{ key: "bonus_mig", mode: 2, value: "-2", priority: null }],
    duration: { startTime: null, seconds: null, combat: null, rounds: null, turns: null } },
];

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
    result: { captures: LIVE_CAPTURES } })).some((c) => /ZERO/.test(c.text)), false);
// The battle_log write rides along on EVERY simulate. If it counted, the
// zero-writes caveat could never fire again.
eq("a run whose only write is the session battle_log still counts as zero",
  blocking(tr.auditRun({ doc: doc(), args: { acceptReactions: true }, result: { captures: {
    actorUpdates: [{ actorName: "Party", patch: { "system.props.battle_log": "[…]" } }],
  } } })).some((c) => /ZERO document writes/.test(c.text)), true);
eq("an unrecognised capture bucket HOLDING SOMETHING is reported, not rendered as silence",
  blocking(tr.auditRun({ doc: doc(), args: { acceptReactions: true },
    result: { captures: { ...LIVE_CAPTURES, tokenUpdates: [{}] } } }))
    .some((c) => /tokenUpdates/.test(c.text)), true);
// A banner that is always on is wallpaper. An EMPTY unrecognised bucket, or a
// non-array key the harness might add later, must not trip it.
eq("an empty unrecognised bucket does not trip the tripwire",
  tr.unknownCaptureBuckets({ captures: { ...LIVE_CAPTURES, tokenUpdates: [] } }).length, 0);
eq("a non-array capture key does not trip the tripwire",
  tr.unknownCaptureBuckets({ captures: { ...LIVE_CAPTURES, summary: { n: 3 } } }).length, 0);
// The harness explicitly allows a non-object patch; Object.entries on a string
// would count each character as a write and suppress the zero-writes caveat.
eq("a non-object patch counts as zero writes, not one per character",
  blocking(tr.auditRun({ doc: doc(), args: { acceptReactions: true }, result: { captures: {
    actorUpdates: [{ actorName: "X", patch: "hello" }],
  } } })).some((c) => /ZERO document writes/.test(c.text)), true);
// A per-row battle_log write must still read as volatile — a leaf-segment rule
// would see "text" here and silently re-arm the suppression.
eq("a per-row battle_log path is still treated as volatile",
  blocking(tr.auditRun({ doc: doc(), args: { acceptReactions: true }, result: { captures: {
    actorUpdates: [{ actorName: "P", patch: { "system.props.battle_log_table.0.text": "x" } }],
  } } })).some((c) => /ZERO document writes/.test(c.text)), true);

// ── caveats that CANNOT run must say so, never pass in silence ──────────────
console.log("\n— named skips —");
{
  const gated = doc({ type_damage: "air", effect_table: rows(
    { effect_kind: "chain", effect_label: "c", condition_formula: "HIT_MARGIN >= 1" }) });
  const cs = tr.auditRun({ doc: gated, args: { acceptReactions: true } });
  eq("a payload-backed gate with no payload report is flagged, not skipped quietly",
    cs.some((c) => /NOT CHECKED/.test(c.text)), true);
  eq("and an unsupplied target affinity is named",
    cs.some((c) => /affinity to air was not supplied/.test(c.text)), true);
}

// ── prose ───────────────────────────────────────────────────────────────────
console.log("\n— prose —");
{
  const out = tr.describeRun({ doc: doc({}, "Fire Bolt"), result: { captures: LIVE_CAPTURES }, caveats: [] });
  eq("names the skill", out.split("\n")[0], "Fire Bolt");
  // The defect this replaced: these key names never existed, so this line was
  // "NOTHING WAS WRITTEN" for every skill ever tested.
  eq("states a resource write plainly", /Test Target Enemy: HP set to 9988/.test(out), true);
  eq("does not report the run as empty", /NOTHING WAS WRITTEN/.test(out), false);
  eq("leaves the session battle_log out of the report", /battle_log/.test(out), false);

  const live = tr.describeRun({ doc: doc({}, "Venom"), result: { captures: { aeCreates: LIVE_AE_CREATES } }, caveats: [] });
  eq("names the actor an AE landed on (parentName, not actorName)",
    /Test Target Enemy gains the effect "Poisoned"/.test(live), true);
  eq("and does not fall back to the placeholder", /someone/.test(live), false);

  // 🚨 These fixtures are the shapes `installWriteCaptures()` DECLARES, not
  // shapes convenient for the assertions. An earlier version of this block
  // invented `{parentName:"Hero"}` on aeDeletes and `{actorName, label}` on
  // freeActions — keys the harness never emits — so three assertions passed
  // against a renderer that produced "someone loses an active effect" in the
  // real world. Second-generation tautology; do not "simplify" these back.
  const ae = tr.describeRun({ doc: doc({}, "Hex"), result: { captures: {
    aeCreates:  [{ parentUuid: "Actor.aaa", parentName: "Goblin", name: "Burning",
                   duration: { rounds: 3, turns: null, seconds: null } }],
    aeDeletes:  [{ aeId: "e1", aeName: "Shielded", parentUuid: "Actor.bbb" }],
    aeUpdates:  [{ aeId: "e2", aeName: "Burning", parentUuid: "Actor.ccc",
                   patch: { "duration.rounds": 1 } }],
    itemUpdates:[{ itemUuid: "Item.ddd", itemName: "Potion", parentUuid: "Actor.bbb",
                   patch: { "system.props.quantity": 2 } }],
    freeActions:[{ sourceLabel: "Dash", reactorActorId: "abc", actionType: "move",
                   presetName: "dash", request: {} }],
  } }, caveats: [] });
  eq("states an applied effect plainly", /Goblin gains the effect "Burning" for 3 round\(s\)/.test(ae), true);
  eq("names a REMOVED effect from aeName", /loses the effect "Shielded"/.test(ae), true);
  eq("names an UPDATED effect from aeName", /the effect "Burning" changes/.test(ae), true);
  eq("names a changed item from itemName", /Potion changes/.test(ae), true);
  eq("names a free action from sourceLabel", /a free action is granted \(Dash\)/.test(ae), true);
  eq("never falls back to the placeholder when the harness supplied a name",
    /someone/.test(ae), false);

  // An AE update/delete carries no actor NAME at all — only parentUuid.
  const anon = tr.describeRun({ doc: doc({}, "Q"), result: { captures: {
    aeDeletes: [{ aeId: "e1", parentUuid: "Actor.zzz" }],
  } }, caveats: [] });
  eq("an unnamed effect still identifies its bearer by uuid",
    /the creature zzz loses an active effect/.test(anon), true);

  // The harness stores itemName as `data?.name ?? ""`, and `??` does not skip
  // an empty string — this rendered as a bare " changes" with no subject.
  const blank = tr.describeRun({ doc: doc({}, "Q"), result: { captures: {
    itemUpdates: [{ itemUuid: "Item.eee", itemName: "", patch: {} }],
  } }, caveats: [] });
  eq("an empty itemName does not render a subjectless line",
    /^\s*changes/m.test(blank), false);

  // Durations are rounds OR turns OR seconds; reading only rounds drops it.
  const turns = tr.describeRun({ doc: doc({}, "Q"), result: { captures: {
    aeCreates: [{ parentName: "Goblin", name: "Slow", duration: { rounds: null, turns: 2 } }],
  } }, caveats: [] });
  eq("a turn-based duration is not dropped", /for 2 turn\(s\)/.test(turns), true);

  const empty = tr.describeRun({ doc: doc({}, "Dud"), result: { captures: {} }, caveats: [] });
  eq("says plainly when nothing was written", /NOTHING WAS WRITTEN/.test(empty), true);

  const caveated = tr.describeRun({
    doc: doc({}, "X"), result: { captures: LIVE_CAPTURES },
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

  // A harness REFUSAL carries a precise reason + hint. Dropping them and
  // falling through to the entry-point caveat told an author to "check the
  // entry point" when the practice scene was simply missing a token.
  globalThis.FUCompanion.api.test.runDirectorSkillSimulate = async () =>
    ({ ok: false, reason: "missing_args", hint: "skillUuid + casterTokenUuid + targetTokenUuids[] all required" });
  const refused = await tr.runTest({ skillUuid: "x", doc: doc() });
  eq("a refused run is not reported as ok", refused.ok, false);
  eq("and keeps the harness's own reason", refused.reason, "missing_args");
  eq("and repeats the harness's hint verbatim",
    /skillUuid \+ casterTokenUuid \+ targetTokenUuids\[\] all required/.test(refused.caveats[0].text), true);
  eq("and does NOT blame the entry point",
    /entry point/i.test(refused.caveats.map((c) => c.text).join(" ")), false);

  // 🚨 The simulate returns `ok: !resolveError`, so a skill that THREW while
  // resolving arrives ok:false WITH captures and no reason/hint. Treating it as
  // a refusal printed "the harness refused to run: no reason given. Nothing was
  // simulated." directly above the writes it had already made.
  globalThis.FUCompanion.api.test.runDirectorSkillSimulate = async () => ({
    ok: false,
    resolveError: { message: "Cannot read properties of undefined (reading 'x')" },
    captures: LIVE_CAPTURES,
  });
  const threwMid = await tr.runTest({ skillUuid: "x", doc: doc() });
  eq("a mid-resolve throw is not mistaken for a refusal", threwMid.reason, "resolve_threw");
  eq("and surfaces the error message",
    /Cannot read properties of undefined/.test(threwMid.caveats[0].text), true);
  eq("and does NOT claim nothing was simulated",
    /Nothing was simulated|THE RUN DID NOT START/.test(threwMid.prose), false);
  eq("and still reports the writes it captured before the throw",
    /Test Target Enemy: HP set to 9988/.test(threwMid.prose), true);

  globalThis.FUCompanion.api.test.runDirectorSkillSimulate =
    async () => ({ ok: true, actionResult: { id: 1 }, captures: LIVE_CAPTURES });
  const good = await tr.runTest({ skillUuid: "x", doc: doc() });
  eq("a healthy run reports ok", good.ok, true);
  eq("and extracts the result", good.actionResults, [{ id: 1 }]);
  eq("and renders prose", /Test Target Enemy: HP set to 9988/.test(good.prose), true);
  eq("and does not call a real run empty", /NOTHING WAS WRITTEN/.test(good.prose), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
