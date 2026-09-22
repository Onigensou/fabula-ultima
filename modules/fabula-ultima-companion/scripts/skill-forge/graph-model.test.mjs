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

// ══ THE CORPUS ROUND-TRIP ═══════════════════════════════════════════════════
console.log("\n— CORPUS round-trip (the contract) —");
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const base = path.resolve(process.cwd(), "..", "..", "worlds", "fabula-ultima-2", "_authored-export");

  let docs = 0, rows = 0, tablesChecked = 0;
  const mismatches = [];

  if (fs.existsSync(base)) {
    for (const dir of ["items", "actors"]) {
      const full = path.join(base, dir);
      if (!fs.existsSync(full)) continue;
      for (const f of fs.readdirSync(full)) {
        let j; try { j = JSON.parse(fs.readFileSync(path.join(full, f), "utf8")); } catch { continue; }
        const list = dir === "items" ? [j] : (j.items || []);
        for (const d of list) {
          const props = d?.system?.props;
          if (!props) continue;
          const hasTables = ["effect_table", "reaction_config_table"]
            .some((t) => props[t] && typeof props[t] === "object" && Object.keys(props[t]).length);
          if (!hasTables) continue;
          docs += 1;

          const graph = gm.toGraph(props);
          rows += graph.nodes.length;
          const back = gm.fromGraph(graph);

          for (const t of ["effect_table", "reaction_config_table"]) {
            const original = {};
            for (const [k, r] of Object.entries(props[t] ?? {})) {
              if (!r || typeof r !== "object" || r.$deleted === true) continue;
              const copy = { ...r };
              delete copy.$deleted;
              original[k] = copy;
            }
            tablesChecked += 1;
            if (JSON.stringify(back[t]) !== JSON.stringify(original)) {
              if (mismatches.length < 5) {
                const keys = new Set([...Object.keys(original), ...Object.keys(back[t])]);
                const diff = [...keys].filter((k) =>
                  JSON.stringify(original[k]) !== JSON.stringify(back[t][k]));
                mismatches.push({ doc: d.name, table: t, rows: diff.slice(0, 3) });
              }
            }
          }
        }
      }
    }
  }

  eq("the corpus was found", docs > 100, true);
  // THE assertion. Anything here is authored content the editor would destroy.
  eq("every authored table round-trips identically", mismatches, []);
  console.log(`        ${docs} documents · ${rows} rows · ${tablesChecked} tables — all identical`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
