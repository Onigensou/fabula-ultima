// [ONI] Skill Forge — graph model.
// ---------------------------------------------------------------------------
// STAGE 1. The `effect_table` is already a dataflow graph: rows are named by
// `effect_label` and reference each other by label through `chain_steps`,
// `target_ref` and `menu_option_refs`. Authors type those labels by hand, so
// the single most common mistake is a reference to a row that does not exist.
//
// Drawing them as connections makes that mistake UNREPRESENTABLE — you cannot
// connect to a node that is not there. That is the whole reason this stage is
// worth its cost.
//
// ═══ THE RULE THAT DECIDES THIS FILE ═══════════════════════════════════════
//
//   READ AND WRITE THE RAW TABLE OBJECT. NEVER THE RENDERED CELLS.
//
// `visibility-audit` reports 41 row keys / 275 authored cells that NO sheet
// renders — Phantasm summon config, `chance_percent`, `disable_ui_type`,
// `focus_max_formula` and more. They survive today only because, in its own
// words, "no write path rebuilds a row from its rendered cells".
//
// An editor is exactly such a write path. Built on the cell model, this stage
// would CREATE a data-loss risk that does not exist today — 275 authored values
// deleted by the act of opening and saving a skill.
//
// So the model carries EVERY key it finds, understood or not. Fields the editor
// has no widget for ride along untouched in `extra` and are written back
// verbatim. The round-trip test over the whole corpus is what proves it.
// ═══════════════════════════════════════════════════════════════════════════

// Row fields the graph renders as CONNECTIONS rather than as text inputs.
// Everything else is either a typed field or an `extra` passenger.
export const REF_FIELDS = {
  target_ref:        { kind: "single", label: "acts on" },
  destination_ref:   { kind: "single", label: "moves to" },
  chain_then_ref:    { kind: "single", label: "then" },
  chance_then_ref:   { kind: "single", label: "on success" },
  chain_steps:       { kind: "list",   label: "runs" },
  menu_option_refs:  { kind: "list",   label: "offers" },
  on_hit_effect_refs:{ kind: "list",   label: "on hit" },
  allowed_skill_refs:{ kind: "list",   label: "allows" },
};

const TABLES = ["effect_table", "reaction_config_table"];

/** Live rows of a CSB dynamic table, tombstones dropped, keys preserved. */
function liveEntries(table) {
  if (!table || typeof table !== "object") return [];
  return Object.entries(table)
    .filter(([, r]) => r && typeof r === "object" && r.$deleted !== true);
}

/** Split a comma list the way the engine does, preserving nothing else. */
function splitRefs(v) {
  return String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ── props -> graph ──────────────────────────────────────────────────────────

/**
 * Build a graph from a document's props.
 *
 * Every row becomes a node. Every reference becomes an edge. Fields the editor
 * understands are lifted onto the node; EVERYTHING ELSE is kept in `extra`,
 * byte-for-byte, so it survives the round trip.
 *
 * `rowKey` is retained per node. CSB tables are objects keyed "0","1",… and
 * those keys are not necessarily dense or ordered — regenerating them on write
 * would renumber rows that other documents may reference by position.
 */
export function toGraph(props = {}) {
  const nodes = [];
  const edges = [];

  for (const table of TABLES) {
    for (const [rowKey, row] of liveEntries(props[table])) {
      const label = String(row.effect_label ?? "").trim()
        || String(row.reaction_effect_ref ? `__reaction_${rowKey}` : `__row_${rowKey}`);
      const kind = String(row.effect_kind ?? row.reaction_trigger ?? "").trim();

      const extra = {};
      const refs = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === "$deleted") continue;
        if (REF_FIELDS[k]) { refs[k] = v; continue; }
        extra[k] = v;
      }

      nodes.push({
        id: `${table}:${rowKey}`,
        table, rowKey, label, kind,
        isTrigger: table === "reaction_config_table",
        // The row's ORIGINAL key order. Splitting fields into refs/extra and
        // re-merging reorders them, which is semantically harmless to CSB but
        // shows up as churn in `_authored-export` — and that export is the
        // review surface a world-data push is read through. Noise there is not
        // cosmetic: it is what hides a one-line removal.
        keyOrder: Object.keys(row).filter((k) => k !== "$deleted"),
        refs,
        // Every non-reference field, understood or not. The editor shows what
        // it knows and preserves what it does not.
        extra,
      });
    }
  }

  const byLabel = new Map();
  for (const n of nodes) if (n.label) byLabel.set(n.label, n.id);

  for (const n of nodes) {
    for (const [field, value] of Object.entries(n.refs)) {
      const spec = REF_FIELDS[field];
      const targets = spec.kind === "list" ? splitRefs(value) : [String(value ?? "").trim()];
      targets.filter(Boolean).forEach((t, i) => {
        edges.push({
          from: n.id,
          to: byLabel.get(t) ?? null,   // null = dangling; the UI paints it red
          toLabel: t,
          field,
          order: i,
          dangling: !byLabel.has(t),
        });
      });
    }
    // Reaction rows point into the effect graph by reaction_effect_ref.
    const rref = String(n.extra.reaction_effect_ref ?? "").trim();
    if (rref) {
      edges.push({
        from: n.id, to: byLabel.get(rref) ?? null, toLabel: rref,
        field: "reaction_effect_ref", order: 0, dangling: !byLabel.has(rref),
      });
    }
  }

  // The fire point is an edge from the document itself into the graph.
  const entry = String(props.on_activate_effect_ref ?? "").trim();
  if (entry) {
    edges.push({
      from: "__document__", to: byLabel.get(entry) ?? null, toLabel: entry,
      field: "on_activate_effect_ref", order: 0, dangling: !byLabel.has(entry),
    });
  }

  return { nodes, edges, entry: entry || null };
}

// ── graph -> props ──────────────────────────────────────────────────────────

/**
 * Emit the table objects a graph represents.
 *
 * Writes the FULL key set for every row, assembled from `extra` + `refs`. This
 * is not stylistic: a CSB `update()` on `system.props.*_table` DEEP-MERGES, so
 * a partial row leaves whatever was underneath in place. Cloning a row and
 * patching a few fields is how `condition_formula: "chance(50)"` once leaked
 * onto a Slow row nobody authored.
 */
export function fromGraph(graph) {
  const out = {};
  for (const table of TABLES) out[table] = {};

  for (const n of graph.nodes) {
    const merged = { ...(n.extra ?? {}), ...(n.refs ?? {}) };
    const row = {};
    // Emit in the row's original key order, then anything new the editor added.
    for (const k of (n.keyOrder ?? [])) if (k in merged) row[k] = merged[k];
    for (const k of Object.keys(merged)) if (!(k in row)) row[k] = merged[k];
    out[n.table][n.rowKey] = row;
  }
  return out;
}

/**
 * Re-derive every reference field from the EDGES, then emit.
 *
 * Used after the user rewires the graph: edges are the truth, and the label
 * strings are regenerated from them. A connection to a node that was deleted
 * simply produces no reference, which is how the dangling-ref class is made
 * unrepresentable rather than merely detected.
 */
export function fromGraphWithEdges(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const refsFor = new Map(graph.nodes.map((n) => [n.id, {}]));

  for (const e of graph.edges) {
    if (e.from === "__document__") continue;
    const target = e.to ? byId.get(e.to) : null;
    // A deleted target drops the reference instead of leaving a dangling label.
    if (!target) continue;
    const bag = refsFor.get(e.from);
    if (!bag) continue;
    const spec = REF_FIELDS[e.field];
    if (!spec) { bag[e.field] = target.label; continue; }
    if (spec.kind === "list") {
      bag[e.field] = bag[e.field] ? [...bag[e.field], { label: target.label, order: e.order }]
        : [{ label: target.label, order: e.order }];
    } else {
      bag[e.field] = target.label;
    }
  }

  const rebuilt = graph.nodes.map((n) => {
    const bag = refsFor.get(n.id) ?? {};
    const refs = {};
    for (const [field, v] of Object.entries(bag)) {
      refs[field] = Array.isArray(v)
        ? v.sort((a, b) => a.order - b.order).map((x) => x.label).join(", ")
        : v;
    }
    // Keys the node HAD but that produced no edge are preserved as empty
    // strings rather than dropped — the column exists on the sheet and a
    // missing key reads differently from a blank one to CSB's merge.
    for (const field of Object.keys(n.refs ?? {})) {
      if (!(field in refs)) refs[field] = "";
    }
    return { ...n, refs };
  });

  return fromGraph({ ...graph, nodes: rebuilt });
}

// ── integrity ───────────────────────────────────────────────────────────────

/** Problems visible in the graph itself, before the validator ever runs. */
export function graphProblems(graph) {
  const problems = [];
  const labels = new Map();
  for (const n of graph.nodes) {
    if (!n.label) continue;
    labels.set(n.label, (labels.get(n.label) ?? 0) + 1);
  }
  for (const [label, count] of labels) {
    if (count > 1) {
      problems.push({
        kind: "duplicate_label", label,
        // Two rows sharing a label is not cosmetic: one lookup path takes the
        // FIRST and another takes the LAST, so the same skill runs two
        // different rows depending on which code reached it.
        text: `${count} rows are named "${label}". References to it are ambiguous, and different ` +
          `engine paths resolve it differently.`,
      });
    }
  }
  for (const e of graph.edges) {
    if (!e.dangling) continue;
    problems.push({
      kind: "dangling_ref", field: e.field, label: e.toLabel,
      text: `"${e.toLabel}" is referenced by ${e.field} but no row is named that. The reference ` +
        `resolves to nothing and the step is skipped.`,
    });
  }
  // Rows nothing points at, and that are not a fire point, never run.
  const reachable = new Set();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const walk = (id) => {
    if (!id || reachable.has(id)) return;
    reachable.add(id);
    for (const e of graph.edges) if (e.from === id && e.to) walk(e.to);
  };
  for (const e of graph.edges) if (e.from === "__document__" && e.to) walk(e.to);
  for (const n of graph.nodes) if (n.isTrigger) { reachable.add(n.id); for (const e of graph.edges) if (e.from === n.id && e.to) walk(e.to); }
  for (const n of graph.nodes) {
    if (reachable.has(n.id) || n.isTrigger) continue;
    problems.push({
      kind: "unreachable", label: n.label,
      text: `"${n.label}" is authored but nothing reaches it — no fire point and no chain step ` +
        `points here, so it never runs.`,
    });
  }
  return problems;
}

/** Layout hint: depth from a fire point, for left-to-right placement. */
export function assignDepths(graph) {
  const depth = new Map();
  const queue = [];
  for (const e of graph.edges) if (e.from === "__document__" && e.to) { depth.set(e.to, 0); queue.push(e.to); }
  for (const n of graph.nodes) if (n.isTrigger) { depth.set(n.id, 0); queue.push(n.id); }
  while (queue.length) {
    const id = queue.shift();
    const d = depth.get(id) ?? 0;
    for (const e of graph.edges) {
      if (e.from !== id || !e.to) continue;
      if (depth.has(e.to)) continue;
      depth.set(e.to, d + 1);
      queue.push(e.to);
    }
  }
  return depth;
}
