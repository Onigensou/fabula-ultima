// ============================================================================
// Step palette — what a NEW row is allowed to contain.
//
//     node scripts/skill-forge/step-palette.test.mjs
//
// THE ASSERTION THAT MATTERS: every key the palette would write is a column the
// registry declares. A key it does not is written, reported as saved, and
// silently dropped — the exact failure the Skill Forge exists to prevent,
// committed by the Skill Forge.
// ============================================================================

const pal = await import("./step-palette.js");
const gm = await import("./graph-model.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

console.log("\n— the kind vocabulary comes from the registry —");
{
  const kinds = pal.stepKinds();
  eq("there are many kinds", kinds.length > 30, true);
  for (const k of ["deal_damage", "apply_ae", "chain", "targeting", "grant", "consume_resource"]) {
    eq(`  ${k} is offered`, kinds.includes(k), true);
  }
  eq("a kind nobody declares is NOT offered", kinds.includes("make_tea"), false);
}

console.log("\n— gates are parsed, not guessed —");
{
  eq("a single-kind gate",
    [...pal.kindsInGate(`equalText(sameRow("effect_kind",''), "deal_damage")`)], ["deal_damage"]);
  eq("an or() of two",
    [...pal.kindsInGate(`or(equalText(sameRow("effect_kind",''), "remove_ae"), equalText(sameRow("effect_kind",''), "remove_tagged_ae"))`)],
    ["remove_ae", "remove_tagged_ae"]);
  eq("a blank gate names nothing", [...pal.kindsInGate("")], []);
  eq("a gate on some OTHER column names nothing",
    [...pal.kindsInGate(`equalText(sameRow("free_mode",''), "true")`)], []);
}

console.log("\n— a kind's columns —");
{
  const dmg = pal.columnsForKind("deal_damage").map((c) => c.key);
  eq("deal_damage gets its own fields", dmg.includes("damage_amount") && dmg.includes("damage_element"), true);
  // A column gated to a DIFFERENT kind must not appear.
  eq("…and not another kind's", dmg.includes("menu_option_labels"), false);

  const menu = pal.columnsForKind("open_action_menu").map((c) => c.key);
  eq("open_action_menu gets the menu fields", menu.includes("menu_option_labels"), true);
  eq("…and not the damage ones", menu.includes("damage_element"), false);

  eq("an unknown kind still yields only ungated columns",
    pal.columnsForKind("make_tea").every((c) => !String(c.visibilityFormula ?? "").trim() ||
      !pal.kindsInGate(c.visibilityFormula).size), true);
  eq("a blank kind yields nothing", pal.columnsForKind(""), []);
}

console.log("\n— THE INVARIANT: a new row writes only DECLARED columns —");
{
  const declared = pal.declaredColumnKeys("effect_table");
  eq("the registry declares columns at all", declared.size > 100, true);

  const offenders = [];
  for (const kind of pal.stepKinds()) {
    const made = pal.newRowFor(kind, "zz_probe");
    if (!made.ok) { offenders.push(`${kind}: ${made.reason}`); continue; }
    for (const key of Object.keys(made.row)) {
      // effect_kind / effect_label are the row's identity; every template that
      // has the table has them.
      if (key === "effect_kind" || key === "effect_label") continue;
      if (!declared.has(key)) offenders.push(`${kind}.${key}`);
    }
  }
  eq("EVERY key a new row carries is a declared column", offenders, []);
}

console.log("\n— a new row is minimal —");
{
  const made = pal.newRowFor("deal_damage", "burn");
  eq("it is created", made.ok, true);
  eq("it names the kind", made.row.effect_kind, "deal_damage");
  eq("it names the step", made.row.effect_label, "burn");
  // Minimal: nothing beyond identity + what the engine refuses to run without.
  const req = pal.requiredFieldsForKind("deal_damage");
  const expected = 2 + req.all.length + req.either.filter((g) => g[0]).length;
  eq("…and carries nothing else", Object.keys(made.row).length, expected);

  eq("a nameless step is refused", pal.newRowFor("deal_damage", "  ").ok, false);
  eq("a kindless step is refused", pal.newRowFor("", "x").ok, false);
  eq("an invented kind is refused", pal.newRowFor("make_tea", "x").ok, false);
}

console.log("\n— adding it to a graph —");
{
  const props = { effect_table: {
    0: { effect_kind: "chain", effect_label: "root", chain_steps: "" },
    // A tombstone at key 1: the next key must be 2, never 1.
    1: { $deleted: true, effect_kind: "grant", effect_label: "gone" },
  } };
  const g = gm.toGraph(props);
  const made = pal.newRowFor("deal_damage", "burn");
  const res = gm.addNode(g, "effect_table", made.row);
  eq("the row is added", res.ok, true);
  eq("…at a key past the tombstone", res.rowKey, "2");

  const out = gm.fromGraphWithEdges(g);
  eq("the tombstone still survives", out.effect_table["1"].$deleted, true);
  eq("the new row is written", out.effect_table["2"].effect_kind, "deal_damage");
  eq("…and is immediately referenceable",
    (gm.setNodeRef(g, g.nodes.find((n) => n.label === "root").id, "chain_steps", ["burn"])).ok, true);
  eq("…with the reference emitted",
    gm.fromGraphWithEdges(g).effect_table["0"].chain_steps, "burn");

  eq("a duplicate name is refused",
    gm.addNode(g, "effect_table", pal.newRowFor("grant", "burn").row).ok, false);
  eq("an unknown table is refused",
    gm.addNode(g, "not_a_table", made.row).ok, false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
