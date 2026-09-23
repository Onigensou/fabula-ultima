// ============================================================================
// Graph model — the round-trip contract.
//
//     node scripts/skill-forge/graph-model.test.mjs
//
// THE TEST THAT JUSTIFIES THE STAGE:
//   Load every authored effect_table / reaction_config_table in the corpus into
//   the graph model, emit it back, and assert the result is IDENTICAL.
//
// Why this and not UI tests: `visibility-audit` reports 41 row keys / 275
// authored cells that no sheet renders, and they survive today only because
// "no write path rebuilds a row from its rendered cells". An editor IS such a
// write path. If the model drops a key it does not understand, opening and
// saving a skill silently deletes authored content — a data-loss bug created
// by the act of adding the editor.
//
// So: same oracle world-pack uses for LevelDB. Byte-identical or it is broken.
// ============================================================================

const gm = await import("./graph-model.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ── basic shape ─────────────────────────────────────────────────────────────
console.log("\n— graph construction —");
{
  const props = {
    on_activate_effect_ref: "root",
    effect_table: {
      0: { effect_kind: "targeting", effect_label: "tgt", candidate_source: "combat", category: "enemy" },
      1: { effect_kind: "deal_damage", effect_label: "hit", target_ref: "tgt", damage_amount: "10" },
      2: { effect_kind: "chain", effect_label: "root", chain_steps: "hit" },
    },
  };
  const g = gm.toGraph(props);
  eq("one node per row", g.nodes.length, 3);
  eq("the fire point is recorded", g.entry, "root");
  eq("target_ref becomes an edge",
    g.edges.some((e) => e.field === "target_ref" && e.toLabel === "tgt" && !e.dangling), true);
  eq("chain_steps becomes an edge",
    g.edges.some((e) => e.field === "chain_steps" && e.toLabel === "hit"), true);
  eq("the document's fire point is an edge from __document__",
    g.edges.some((e) => e.from === "__document__" && e.toLabel === "root"), true);
  eq("a row's non-reference fields land in extra",
    g.nodes.find((n) => n.label === "hit").extra.damage_amount, "10");
  eq("reference fields do NOT land in extra",
    "target_ref" in g.nodes.find((n) => n.label === "hit").extra, false);
}

// ── tombstones ──────────────────────────────────────────────────────────────
console.log("\n— tombstones —");
{
  const g = gm.toGraph({ effect_table: {
    0: { effect_kind: "grant", effect_label: "a" },
    1: { $deleted: true, effect_kind: "grant", effect_label: "b" },
  } });
  eq("a $deleted row is not a node", g.nodes.map((n) => n.label), ["a"]);
}

// ── THE INVARIANT: unknown keys survive ─────────────────────────────────────
console.log("\n— unknown keys survive (the 275-cell risk) —");
{
  // Every one of these is a REAL data-only key from visibility-audit's list —
  // authored, engine-read, and rendered by no sheet.
  const exotic = {
    effect_kind: "summon", effect_label: "call",
    summon_actor: "Phantasm", summon_count: "2", summon_max: "3",
    summon_overrides: "{}", only_clones: true, summon_folder: "Summons",
    ae_lifetime_mode: "persistent_counter", disable_ui_type: "grey",
    disabled_reason: "No minions", chance_percent: "50", focus_max_formula: "SL",
  };
  const props = { effect_table: { 0: exotic } };
  const back = gm.fromGraph(gm.toGraph(props));
  eq("every exotic key round-trips byte-identical", back.effect_table["0"], exotic);
}

// ── row keys are preserved, not renumbered ──────────────────────────────────
console.log("\n— row keys —");
{
  // CSB table keys are not dense: "0", "7", "99" is legal and occurs in the
  // corpus (High Speed uses row 99). Renumbering would repoint references.
  const props = { effect_table: {
    0: { effect_kind: "grant", effect_label: "a" },
    7: { effect_kind: "grant", effect_label: "b" },
    99: { effect_kind: "grant", effect_label: "c" },
  } };
  const back = gm.fromGraph(gm.toGraph(props));
  eq("sparse row keys are preserved", Object.keys(back.effect_table).sort(), ["0", "7", "99"]);
}

// ── rewiring from edges ─────────────────────────────────────────────────────
console.log("\n— rewiring —");
{
  const props = { effect_table: {
    0: { effect_kind: "targeting", effect_label: "tgt" },
    1: { effect_kind: "deal_damage", effect_label: "hit", target_ref: "tgt" },
    2: { effect_kind: "chain", effect_label: "root", chain_steps: "hit" },
  } };
  const g = gm.toGraph(props);
  const back = gm.fromGraphWithEdges(g);
  eq("an untouched graph rewires to the same rows", back.effect_table, props.effect_table);

  // Delete the targeting node; the reference must VANISH, not dangle.
  const pruned = { ...g, nodes: g.nodes.filter((n) => n.label !== "tgt") };
  const after = gm.fromGraphWithEdges(pruned);
  eq("deleting a node clears references to it, rather than leaving a dangling label",
    after.effect_table["1"].target_ref, "");

  // Reordering a list edge must reorder the emitted comma list.
  const multi = gm.toGraph({ effect_table: {
    0: { effect_kind: "grant", effect_label: "a" },
    1: { effect_kind: "grant", effect_label: "b" },
    2: { effect_kind: "chain", effect_label: "root", chain_steps: "a, b" },
  } });
  const flipped = { ...multi, edges: multi.edges.map((e) =>
    e.field === "chain_steps" ? { ...e, order: e.order === 0 ? 1 : 0 } : e) };
  eq("list order follows the edges", gm.fromGraphWithEdges(flipped).effect_table["2"].chain_steps, "b, a");
}

// ── problems ────────────────────────────────────────────────────────────────
console.log("\n— graph problems —");
{
  const dup = gm.toGraph({ effect_table: {
    0: { effect_kind: "grant", effect_label: "same" },
    1: { effect_kind: "grant", effect_label: "same" },
  } });
  eq("duplicate labels are reported",
    gm.graphProblems(dup).filter((p) => p.kind === "duplicate_label").length, 1);

  const dangling = gm.toGraph({ on_activate_effect_ref: "root", effect_table: {
    0: { effect_kind: "chain", effect_label: "root", chain_steps: "ghost" },
  } });
  eq("a dangling reference is reported",
    gm.graphProblems(dangling).filter((p) => p.kind === "dangling_ref").length, 1);

  const orphan = gm.toGraph({ on_activate_effect_ref: "root", effect_table: {
    0: { effect_kind: "chain", effect_label: "root", chain_steps: "" },
    1: { effect_kind: "grant", effect_label: "lonely" },
  } });
  eq("an unreachable row is reported",
    gm.graphProblems(orphan).filter((p) => p.kind === "unreachable").map((p) => p.label), ["lonely"]);

  const reachable = gm.toGraph({ on_activate_effect_ref: "root", effect_table: {
    0: { effect_kind: "chain", effect_label: "root", chain_steps: "used" },
    1: { effect_kind: "grant", effect_label: "used" },
  } });
  eq("a reachable row is NOT reported", gm.graphProblems(reachable).length, 0);
}

// ── depth layout ────────────────────────────────────────────────────────────
console.log("\n— layout —");
{
  const g = gm.toGraph({ on_activate_effect_ref: "root", effect_table: {
    0: { effect_kind: "chain", effect_label: "root", chain_steps: "mid" },
    1: { effect_kind: "chain", effect_label: "mid", chain_steps: "leaf" },
    2: { effect_kind: "grant", effect_label: "leaf" },
  } });
  const d = gm.assignDepths(g);
  const byLabel = (l) => d.get(g.nodes.find((n) => n.label === l).id);
  eq("the fire point is depth 0", byLabel("root"), 0);
  eq("its child is depth 1", byLabel("mid"), 1);
  eq("its grandchild is depth 2", byLabel("leaf"), 2);
}

// ── editing ─────────────────────────────────────────────────────────────────
console.log("\n— editing: rename —");
{
  const props = {
    on_activate_effect_ref: "root",
    effect_table: {
      0: { effect_kind: "chain", effect_label: "root", chain_steps: "hurt, heal" },
      1: { effect_kind: "damage", effect_label: "hurt", target_ref: "picked" },
      2: { effect_kind: "restore", effect_label: "heal", target_ref: "self" },
      3: { effect_kind: "targeting", effect_label: "picked", candidate_source: "combat" },
    },
    reaction_config_table: {
      0: { reaction_trigger: "on_hit", reaction_effect_ref: "root" },
    },
  };
  const g = gm.toGraph(props);
  const hurt = g.nodes.find((n) => n.label === "hurt");
  eq("rename succeeds", gm.renameNode(g, hurt.id, "burn").ok, true);

  const out = gm.fromGraphWithEdges(g);
  eq("the row's own effect_label moved", out.effect_table["1"].effect_label, "burn");
  eq("…and every reference to it followed", out.effect_table["0"].chain_steps, "burn, heal");

  // The four references a hand edit has to find separately.
  const g2 = gm.toGraph(props);
  const root = g2.nodes.find((n) => n.label === "root");
  gm.renameNode(g2, root.id, "start");
  const o2 = gm.fromGraphWithEdges(g2);
  eq("a reaction's pointer followed", o2.reaction_config_table["0"].reaction_effect_ref, "start");
  eq("…and so did the fire point", g2.entry, "start");

  const g3 = gm.toGraph(props);
  const picked = g3.nodes.find((n) => n.label === "picked");
  gm.renameNode(g3, picked.id, "chosen");
  const o3 = gm.fromGraphWithEdges(g3);
  eq("a TARGETING row's name followed into target_ref", o3.effect_table["1"].target_ref, "chosen");
  eq("…and the reserved word next to it was untouched", o3.effect_table["2"].target_ref, "self");

  const g4 = gm.toGraph(props);
  eq("a duplicate name is refused",
    gm.renameNode(g4, g4.nodes.find((n) => n.label === "hurt").id, "heal").ok, false);
  eq("a blank name is refused",
    gm.renameNode(g4, g4.nodes.find((n) => n.label === "hurt").id, "   ").ok, false);
  eq("…and a refusal changes nothing", JSON.stringify(gm.fromGraphWithEdges(g4)),
    JSON.stringify(gm.fromGraphWithEdges(gm.toGraph(props))));
}

console.log("\n— editing: rows with no name of their own —");
{
  // 🩸 EVERY reaction row in this world (655 of 655) carries no `effect_label`,
  // so the graph gives it a made-up handle. Renaming one used to write nothing
  // — `renameNode` only moved `effect_label` when the key already existed —
  // while still propagating the new name to every referrer through the edges.
  // The UI showed the rename, other rows pointed at it, and the row stayed
  // nameless. Found by reviewing the diff, not by a run.
  const props = {
    effect_table: { 0: { effect_kind: "damage", effect_label: "hurt" } },
    reaction_config_table: { 0: { reaction_trigger: "on_hit", reaction_effect_ref: "hurt" } },
  };
  const g = gm.toGraph(props);
  const trigger = g.nodes.find((n) => n.isTrigger);
  const real = g.nodes.find((n) => !n.isTrigger);

  eq("a nameless row is flagged as such", trigger.labelIsSynthetic, true);
  eq("…and a named one is not", real.labelIsSynthetic, false);

  const res = gm.renameNode(g, trigger.id, "my_trigger");
  eq("renaming it is REFUSED", res.ok, false);
  eq("…with a reason a human can act on", /identified by what it reacts to/.test(res.reason), true);
  eq("…and nothing moved", JSON.stringify(gm.fromGraphWithEdges(g)),
    JSON.stringify(gm.fromGraphWithEdges(gm.toGraph(props))));

  // …and it cannot be pointed AT either. Writing the made-up handle into a ref
  // would produce a reference to a label that is nowhere in the data — the
  // dangling-reference class this whole stage exists to make unrepresentable,
  // created by the editor itself.
  const g3 = gm.toGraph(props);
  const r3 = gm.setNodeRef(g3, g3.nodes.find((n) => !n.isTrigger).id, "chain_then_ref",
    [g3.nodes.find((n) => n.isTrigger).label]);
  eq("pointing at a nameless row is refused", r3.refused?.length, 1);
  eq("…and no such reference is written",
    /__reaction/.test(JSON.stringify(gm.fromGraphWithEdges(g3))), false);
  eq("…and the field is left clear, not dangling",
    gm.fromGraphWithEdges(g3).effect_table["0"].chain_then_ref, undefined);

  // The reaction row's pointer INTO the graph still follows a real rename.
  const g2 = gm.toGraph(props);
  gm.renameNode(g2, g2.nodes.find((n) => !n.isTrigger).id, "burn");
  eq("a real rename still reaches the trigger's pointer",
    gm.fromGraphWithEdges(g2).reaction_config_table["0"].reaction_effect_ref, "burn");
}

console.log("\n— editing: references —");
{
  const props = {
    effect_table: {
      0: { effect_kind: "chain", effect_label: "root", chain_steps: "a" },
      1: { effect_kind: "damage", effect_label: "a", target_ref: "self" },
      2: { effect_kind: "damage", effect_label: "b" },
    },
  };
  const g = gm.toGraph(props);
  const root = g.nodes.find((n) => n.label === "root");
  gm.setNodeRef(g, root.id, "chain_steps", ["b", "a"]);
  eq("order follows the list", gm.fromGraphWithEdges(g).effect_table["0"].chain_steps, "b, a");

  const g2 = gm.toGraph(props);
  const a = g2.nodes.find((n) => n.label === "a");
  gm.setNodeRef(g2, a.id, "target_ref", ["all_enemies"]);
  eq("a reserved word is kept even though it is not a step",
    gm.fromGraphWithEdges(g2).effect_table["1"].target_ref, "all_enemies");

  // 🪤 The undeclared-column trap: clearing a field the row never had must not
  // leave a blank key behind, or the author gets a finding for a column they
  // never touched.
  const g3 = gm.toGraph(props);
  const b = g3.nodes.find((n) => n.label === "b");
  gm.setNodeRef(g3, b.id, "chain_then_ref", []);
  eq("clearing a field the row never had adds no key",
    "chain_then_ref" in gm.fromGraphWithEdges(g3).effect_table["2"], false);

  // …but a field it DID have stays present as a blank, because CSB reads an
  // absent key differently from an empty one.
  const g4 = gm.toGraph(props);
  gm.setNodeRef(g4, g4.nodes.find((n) => n.label === "a").id, "target_ref", []);
  eq("clearing a field the row HAD leaves it blank, not missing",
    gm.fromGraphWithEdges(g4).effect_table["1"].target_ref, "");
}

console.log("\n— editing: a plain field (conditions) —");
{
  const props = {
    effect_table: {
      0: { effect_kind: "damage", effect_label: "a", condition_formula: "CUR_MP >= 10" },
      1: { effect_kind: "damage", effect_label: "b", target_ref: "self" },
    },
  };
  const g = gm.toGraph(props);
  const a = g.nodes.find((n) => n.label === "a");
  const b = g.nodes.find((n) => n.label === "b");

  gm.setNodeField(g, a.id, "condition_formula", "CUR_HP <= 5");
  eq("it writes the value", gm.fromGraphWithEdges(g).effect_table["0"].condition_formula, "CUR_HP <= 5");

  // A reference field must NOT be settable this way: refs are rebuilt from the
  // edges, so a value written into `extra` is silently overwritten on emit —
  // a wrong answer that looks like it worked.
  const bad = gm.setNodeField(g, a.id, "chain_steps", "b");
  eq("a reference field is refused", bad.ok, false);
  eq("…and says which verb to use instead", /setNodeRef/.test(bad.reason), true);
  eq("…and nothing was written",
    gm.fromGraphWithEdges(g).effect_table["0"].chain_steps, undefined);

  // CSB bookkeeping is off limits.
  eq("$deleted is refused", gm.setNodeField(g, a.id, "$deleted", "true").ok, false);

  // Clearing follows the same had-it / never-had-it rule as setNodeRef.
  gm.setNodeField(g, a.id, "condition_formula", "");
  eq("clearing a column the row HAD leaves it blank",
    gm.fromGraphWithEdges(g).effect_table["0"].condition_formula, "");
  gm.setNodeField(g, b.id, "condition_formula", "");
  eq("clearing one it never had adds no key",
    "condition_formula" in gm.fromGraphWithEdges(g).effect_table["1"], false);
}

console.log("\n— editing: remove —");
{
  const props = {
    on_activate_effect_ref: "root",
    effect_table: {
      0: { effect_kind: "chain", effect_label: "root", chain_steps: "a, b" },
      1: { effect_kind: "damage", effect_label: "a", target_ref: "self" },
      2: { effect_kind: "damage", effect_label: "b", target_ref: "self" },
    },
  };
  const g = gm.toGraph(props);
  gm.removeNode(g, g.nodes.find((n) => n.label === "a").id);
  const out = gm.fromGraphWithEdges(g);
  eq("the row is gone", "1" in out.effect_table, false);
  eq("references to it went too, rather than dangling", out.effect_table["0"].chain_steps, "b");
  eq("the other row is untouched", out.effect_table["2"].target_ref, "self");

  const g2 = gm.toGraph(props);
  gm.removeNode(g2, g2.nodes.find((n) => n.label === "root").id);
  eq("deleting the fire point clears it", g2.entry, null);

  // 🪤 CSB resurrects a predefined row that is merely absent.
  const withPredef = {
    effect_table: {
      0: { effect_kind: "damage", effect_label: "a", $predefinedIdx: 0, $deleted: false },
    },
  };
  const g3 = gm.toGraph(withPredef);
  const res = gm.removeNode(g3, g3.nodes[0].id);
  eq("a predefined row is tombstoned, not dropped", res.tombstoned, true);
  const o3 = gm.fromGraphWithEdges(g3);
  eq("…so the key survives", "0" in o3.effect_table, true);
  eq("…marked deleted", o3.effect_table["0"].$deleted, true);
}

console.log("\n— editing: fire points (ALL THREE) —");
{
  // 🩸 Found by a LIVE run, not by this suite. The model knew only
  // `on_activate_effect_ref`, so renaming a step that `pre_activate_effect_ref`
  // pointed at moved every row reference and left the fire point naming a step
  // that no longer existed — silent, and the skill still read as authored.
  // 88 documents in this world use pre_activate, 6 use post_damage.
  const props = {
    on_activate_effect_ref: "main",
    pre_activate_effect_ref: "capture",
    post_damage_effect_ref: "after",
    effect_table: {
      0: { effect_kind: "chain", effect_label: "main" },
      1: { effect_kind: "prompt_number", effect_label: "capture" },
      2: { effect_kind: "grant", effect_label: "after" },
    },
  };
  const g = gm.toGraph(props);
  eq("every fire point is recorded", g.entries, {
    on_activate_effect_ref: "main", pre_activate_effect_ref: "capture", post_damage_effect_ref: "after",
  });
  eq("…and none of their steps reads as unreachable",
    gm.graphProblems(g).filter((p) => p.kind === "unreachable").length, 0);

  for (const [field, was] of [["pre_activate_effect_ref", "capture"], ["post_damage_effect_ref", "after"]]) {
    const g2 = gm.toGraph(props);
    gm.renameNode(g2, g2.nodes.find((n) => n.label === was).id, "zz");
    eq(`renaming the step ${field} points at moves it too`, g2.entries[field], "zz");
  }

  const g3 = gm.toGraph(props);
  gm.removeNode(g3, g3.nodes.find((n) => n.label === "capture").id);
  eq("deleting it clears that fire point only", g3.entries,
    { on_activate_effect_ref: "main", pre_activate_effect_ref: "", post_damage_effect_ref: "after" });

  const g4 = gm.toGraph(props);
  gm.setEntry(g4, "after", "pre_activate_effect_ref");
  eq("setting one leaves the others alone", g4.entries,
    { on_activate_effect_ref: "main", pre_activate_effect_ref: "after", post_damage_effect_ref: "after" });

  // A fire point the document does not carry must not be invented.
  const g5 = gm.toGraph({ effect_table: { 0: { effect_kind: "damage", effect_label: "a" } } });
  eq("a prop the skill never had is not recorded", g5.entries, {});
}

console.log("\n— editing: fire point —");
{
  const props = {
    effect_table: { 0: { effect_kind: "damage", effect_label: "a" } },
  };
  const g = gm.toGraph(props);
  eq("a skill with no fire point reports its row unreachable",
    gm.graphProblems(g).some((p) => p.kind === "unreachable"), true);
  gm.setEntry(g, "a");
  eq("setting one makes it reachable",
    gm.graphProblems(g).some((p) => p.kind === "unreachable"), false);
  eq("and it is recorded", g.entry, "a");
}

console.log("\n— problems: reserved target words —");
{
  const props = {
    on_activate_effect_ref: "root",
    effect_table: {
      0: { effect_kind: "chain", effect_label: "root", chain_steps: "a" },
      1: { effect_kind: "damage", effect_label: "a", target_ref: "self" },
    },
  };
  const g = gm.toGraph(props);
  // Without the engine's vocabulary the check must SAY it did not run…
  const blind = gm.graphProblems(g);
  eq("an unavailable vocabulary is reported as NOT CHECKED",
    blind.some((p) => p.kind === "not_checked"), true);
  eq("…and is NOT reported as a broken reference",
    blind.some((p) => p.kind === "unknown_target_ref"), false);

  // …and with it, `self` is simply fine.
  const seen = gm.graphProblems(g, { isReservedTargetRef: (r) => r === "self" });
  eq("a reserved word is not a problem", seen.length, 0);

  const bad = gm.graphProblems(gm.toGraph({
    ...props,
    effect_table: { ...props.effect_table, 1: { effect_kind: "damage", effect_label: "a", target_ref: "slef" } },
  }), { isReservedTargetRef: (r) => r === "self" });
  eq("a typo IS", bad.filter((p) => p.kind === "unknown_target_ref").length, 1);
}

// ══ THE CORPUS ROUND-TRIP ═══════════════════════════════════════════════════
//
// 🩸 THIS TEST WAS GREEN AND CHECKING NOTHING. Four defects, all found on
// 2026-09-23 when a save button was finally about to make the write path
// reachable by a human:
//
//  1. the corpus path was resolved from `process.cwd()`, so it found the export
//     only when the runner happened to be started from
//     `modules/fabula-ultima-companion/`. From the repo root — how it is
//     actually run — `docs` was 0;
//  2. …and the contract assertion below then passed VACUOUSLY, printing
//     "0 documents — all identical" under a red line nobody connected to it;
//  3. the expectation was built by DELETING `$deleted` from every row and
//     skipping tombstones — i.e. it was constructed to match what the code
//     did, so it could never report the 66 tombstone rows and 1084 `$deleted`
//     keys the round trip dropped. See
//     `feedback_cross_check_must_not_share_a_source_list`;
//  4. it only exercised `fromGraph`. The SAVE BUTTON calls
//     `fromGraphWithEdges`, which was erasing `target_ref` on 1263 rows.
//
// The rules now: resolve from THIS FILE, compare against the RAW table with
// nothing stripped, exercise BOTH write paths, and refuse to pass on an empty
// corpus.
console.log("\n— CORPUS round-trip (the contract) —");
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  // From this file, never from the working directory:
  //   scripts/skill-forge/ -> scripts/ -> fabula-ultima-companion/ -> modules/ -> Data/
  const here = path.dirname(fileURLToPath(import.meta.url));
  const base = path.resolve(here, "..", "..", "..", "..", "worlds", "fabula-ultima-2", "_authored-export");

  let docs = 0, rows = 0, tablesChecked = 0, arrayShaped = 0;
  const mismatches = [];
  const J = (v) => JSON.stringify(v);

  const visit = (d) => {
    const props = d?.system?.props;
    if (props) {
      const hasTables = ["effect_table", "reaction_config_table"]
        .some((t) => props[t] && typeof props[t] === "object" && Object.keys(props[t]).length);
      if (hasTables) {
        docs += 1;
        const graph = gm.toGraph(props);
        rows += graph.nodes.length;
        const plain = gm.fromGraph(graph);
        const rewired = gm.fromGraphWithEdges(graph);

        for (const t of ["effect_table", "reaction_config_table"]) {
          const original = props[t];
          if (!original || typeof original !== "object") continue;
          // 3 documents in this world store the table as an ARRAY rather than
          // a CSB row object. Counted and reported, never quietly normalised.
          if (Array.isArray(original)) { arrayShaped += 1; continue; }
          tablesChecked += 1;
          for (const [via, back] of [["fromGraph", plain], ["fromGraphWithEdges", rewired]]) {
            if (J(original) === J(back[t])) continue;
            if (mismatches.length < 6) {
              const keys = new Set([...Object.keys(original), ...Object.keys(back[t] ?? {})]);
              const diff = [...keys].filter((k) => J(original[k]) !== J(back[t]?.[k]));
              mismatches.push({ via, doc: d.name, table: t, rows: diff.slice(0, 3) });
            }
          }
        }
      }
    }
    for (const child of (d?.items ?? [])) visit(child);
  };

  const found = fs.existsSync(base);
  if (found) {
    for (const dir of ["items", "actors"]) {
      const full = path.join(base, dir);
      if (!fs.existsSync(full)) continue;
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith(".json")) continue;
        let j; try { j = JSON.parse(fs.readFileSync(path.join(full, f), "utf8")); } catch { continue; }
        visit(j);
      }
    }
  }

  // An empty corpus is NOT a pass. It is the absence of the check, and it says
  // so in those words — the validator's skip contract, applied to its own test.
  eq("the corpus was found", docs > 100, true);
  if (docs > 100) {
    // THE assertion. Anything here is authored content the editor would destroy.
    eq("every authored table round-trips identically, through BOTH write paths", mismatches, []);
    console.log(`        ${docs} documents · ${rows} rows · ${tablesChecked} tables` +
      `${arrayShaped ? ` · ${arrayShaped} array-shaped table(s) skipped` : ""}`);
  } else {
    fail += 1;
    console.log(`  NOT CHECKED  the round-trip contract did not run — no corpus at ${base}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
