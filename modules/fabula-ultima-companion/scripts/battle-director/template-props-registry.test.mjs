// ============================================================================
// Template PROP registry — the sync, and the one constraint that makes it safe.
//
//     node scripts/battle-director/template-props-registry.test.mjs
//
// THE ASSERTION THAT MATTERS: no managed field carries a default value.
// `reloadTemplate` stamps a declared prop's default onto every instance, so a
// default here is a silent write to 2,374 documents — larger than any authoring
// change this project makes, and exactly the kind of churn that hides a real
// removal in the export review. Everything else in this file is bookkeeping.
// ============================================================================

const reg = await import("./template-props-registry.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// A stand-in for the skill template's shape: a body panel holding a tabbedPanel.
const makeBody = (extra = []) => ({
  type: "panel", key: "custom_body",
  contents: [{
    type: "tabbedPanel", key: "skill_main_tab",
    contents: [
      { type: "tab", key: "main", name: "📜", contents: [
        { type: "textField", key: "skill_type", label: "Kind" },
        ...extra,
      ] },
    ],
  }],
});

console.log("\n— THE SAFETY CONSTRAINT —");
{
  const withDefault = reg.MANAGED_PROPS.filter((p) => {
    // A falsy default takes getAllProperties' `: undefined` branch and stamps
    // nothing. Anything truthy is written to every document that lacks the key.
    if (p.type === "checkbox") return !!p.defaultChecked;
    return !!p.defaultValue;
  }).map((p) => p.key);
  eq("NO managed field carries a default value", withDefault, []);
  eq("every field has a key", reg.MANAGED_PROPS.filter((p) => !p.key).length, 0);
  eq("every field has a type", reg.MANAGED_PROPS.filter((p) => !p.type).length, 0);
  eq("no key is listed twice",
    reg.MANAGED_PROPS.length, new Set(reg.MANAGED_PROPS.map((p) => p.key)).size);
  // The dead legacy alias must stay OUT: it is an empty object on all 14
  // documents that carry it, so the prune is the correct outcome there.
  eq("the empty legacy table is not declared",
    reg.MANAGED_PROPS.some((p) => p.key === "reaction_effect_table"), false);
}

console.log("\n— the sync —");
{
  const body = makeBody();
  const r = reg.ensureManagedProps(body);
  eq("it reports a change", r.changed, true);
  eq("it adds every managed key", r.added.length, reg.MANAGED_PROPS.length);

  const tab = body.contents[0].contents.find((t) => t.key === reg.MANAGED_TAB_KEY);
  eq("the managed tab exists", !!tab, true);
  eq("…and holds the fields", tab.contents.length, reg.MANAGED_PROPS.length);
  eq("…and hand-authored layout is untouched",
    body.contents[0].contents[0].contents.map((c) => c.key), ["skill_type"]);

  // Steady state must do NOTHING — this runs on every boot.
  const again = reg.ensureManagedProps(body);
  eq("running it again changes nothing", again.changed, false);
  eq("…and adds nothing", again.added, []);
  const third = reg.ensureManagedProps(body);
  eq("…still nothing on a third run", third.changed, false);
  eq("the tab did not grow", tab.contents.length, reg.MANAGED_PROPS.length);
}

console.log("\n— it never declares a key twice —");
{
  // A key the template already declares elsewhere is left alone: two controls
  // writing one prop is worse than one control in the wrong place.
  const already = { type: "textField", key: "action_command", label: "Command" };
  const body = makeBody([already]);
  const r = reg.ensureManagedProps(body);
  eq("the existing declaration is not duplicated",
    r.added.includes("action_command"), false);
  eq("…and it is reported as adopted", r.adopted.includes("action_command"), true);
  const tab = body.contents[0].contents.find((t) => t.key === reg.MANAGED_TAB_KEY);
  eq("…so the managed tab is one field shorter",
    tab.contents.length, reg.MANAGED_PROPS.length - 1);
}

console.log("\n— a radioButton is matched on its GROUP —");
{
  // RadioButton.js:45 — propertyKey is the group, so a radio writing
  // `action_command` already declares it even though its `key` differs.
  const radio = { type: "radioButton", key: "cmd_widget", group: "action_command" };
  const body = makeBody([radio]);
  const r = reg.ensureManagedProps(body);
  eq("the group counts as a declaration", r.added.includes("action_command"), false);
}

console.log("\n— it refuses rather than inventing a layout —");
{
  const noTabs = { type: "panel", key: "custom_body", contents: [
    { type: "textField", key: "x" },
  ] };
  const r = reg.ensureManagedProps(noTabs);
  eq("no tabbedPanel ⇒ no change", r.changed, false);
  eq("…and it says why", !!r.reason, true);
  eq("a missing body is handled", reg.ensureManagedProps(null).changed, false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
