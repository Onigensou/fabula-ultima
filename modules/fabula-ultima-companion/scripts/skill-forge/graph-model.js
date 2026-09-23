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
//
// ═══ `points_at` IS LOAD-BEARING, NOT DOCUMENTATION ════════════════════════
//
// A ref field names one of two DIFFERENT vocabularies, and conflating them is
// how this model lost data. Measured over the corpus 2026-09-23, the previous
// table treated every ref as "an effect_label in this skill", so
// `fromGraphWithEdges` — the function the save button calls — ERASED:
//
//     target_ref: "self"            1263 rows
//     allowed_skill_refs: "Muleta…"    9 rows
//
// `self` is not a step. It is a RESERVED WORD (`skill-targeting.js`
// `RESERVED_REFS`), and those skill names are a picker filter that never
// reaches the effect table at all. Opening a skill and pressing Save would
// have blanked the single most load-bearing column in the effect model on
// three quarters of the rows that have it.
//
//   "step"   — an `effect_label` on THIS skill. A missing one is a real
//              dangling reference, and a rename must follow it.
//   "target" — a target ref: a reserved word (`self`, `action_targets`,
//              `own_persistent_summons_<kind>`, …) OR the label of a
//              `targeting`-kind row. Comma means UNION, not "list of steps".
//
// Anything else is an `extra` passenger and is written back verbatim:
//   allowed_skill_refs  skill NAMES (Skill/Spell picker filter)
//   ae_template_ref     an AE template, not a row        (829 rows)
//   action_ref          "self" / a skill NAME / an action TYPE
// ═══════════════════════════════════════════════════════════════════════════
export const REF_FIELDS = {
  // → an effect_label on this skill
  chain_steps:        { kind: "list",   label: "runs",       points_at: "step" },
  menu_option_refs:   { kind: "list",   label: "offers",     points_at: "step" },
  on_hit_effect_refs: { kind: "list",   label: "on hit",     points_at: "step" },
  confirm_button_refs:{ kind: "list",   label: "buttons",    points_at: "step" },
  chain_then_ref:     { kind: "single", label: "then",       points_at: "step" },
  chance_then_ref:    { kind: "single", label: "on success", points_at: "step" },
  // Unused in the corpus today, but the engine reads it (`skill-effects.js`
  // ~11793) and it is the other half of `chance_then_ref`. Modelled so a
  // rename follows it the day someone authors one, and so the card does not
  // show "on success" with no matching failure branch.
  chance_else_ref:    { kind: "single", label: "on failure", points_at: "step" },
  // A reaction row pointing into the effect graph. Used to be handled by a
  // special case further down, which meant it was the one edge a rename could
  // not follow.
  reaction_effect_ref:{ kind: "single", label: "runs",       points_at: "step" },

  // → a reserved word, or the label of a `targeting` row
  target_ref:         { kind: "list",   label: "acts on",    points_at: "target" },
  destination_ref:    { kind: "list",   label: "moves to",   points_at: "target" },
  performer_ref:      { kind: "list",   label: "performed by", points_at: "target" },
  from_ref:           { kind: "list",   label: "taken from", points_at: "target" },
  prompt_max_ref:     { kind: "list",   label: "limit read from", points_at: "target" },
};

const TABLES = ["effect_table", "reaction_config_table"];

/**
 * The DOCUMENT-level fire points — props, not rows, that name a starting step.
 *
 * 🩸 There are THREE, and this model knew one. Found live 2026-09-23: renaming
 * a step that `pre_activate_effect_ref` pointed at moved every row reference
 * and left the fire point naming a step that no longer existed — the skill
 * still looked completely authored and its capture hook simply stopped firing.
 * 88 documents use `pre_activate_effect_ref` and 6 use `post_damage_effect_ref`.
 *
 * They are also what makes a step REACHABLE. Modelling only `on_activate`
 * meant `graphProblems` called a pre-activate-only step "never runs".
 */
export const FIRE_POINTS = Object.freeze({
  on_activate_effect_ref:  "When the skill is used, run",
  pre_activate_effect_ref: "Before the card is shown, run",
  post_damage_effect_ref:  "After each damage event, run",
});

/** Live rows of a CSB dynamic table, tombstones dropped, keys preserved. */
function liveEntries(table) {
  if (!table || typeof table !== "object") return [];
  return Object.entries(table)
    .filter(([, r]) => r && typeof r === "object" && r.$deleted !== true);
}

/**
 * Rows CSB has soft-deleted (`$deleted: true`).
 *
 * They are NOT steps and must never become nodes — but they must survive the
 * write, because this module's stated rule is that it carries every key it
 * finds, understood or not. Measured over the whole corpus 2026-09-23: 66 such
 * rows exist, and an earlier `fromGraph` emitted none of them, so the first
 * human-triggered save of any of those 315 documents would have silently
 * deleted content the graph never showed and the author never touched.
 *
 * Today none of them carry `$predefinedIdx`, so nothing resurrects them — but
 * see `isPredefinedRow`: for a row that DOES, removal is not deletion.
 */
function tombstoneEntries(table) {
  if (!table || typeof table !== "object") return [];
  return Object.entries(table)
    .filter(([, r]) => r && typeof r === "object" && r.$deleted === true);
}

/**
 * True for a row CSB planted from the TEMPLATE's predefined lines.
 *
 * `_synchronizePredefinedLines` re-adds any predefined line that is absent
 * from the document, matching on `$predefinedIdx`. So deleting such a row by
 * dropping its key does not delete it — it comes back, live, at a new index,
 * the next time the template syncs. CSB's own `_deleteRow` tombstones these
 * and hard-removes everything else; an editor that writes rows back must obey
 * the same split or "delete" silently means "delete until the next reload".
 */
export function isPredefinedRow(row) {
  return !!row && typeof row === "object" && row.$predefinedIdx != null;
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
  // Everything the editor must give back untouched: rows it does not show, and
  // the order the table's keys were in.
  const tombstones = {};
  const tableKeyOrder = {};

  for (const table of TABLES) {
    const raw = props[table] && typeof props[table] === "object" ? props[table] : {};
    tableKeyOrder[table] = Object.keys(raw);
    tombstones[table] = Object.fromEntries(tombstoneEntries(raw));

    for (const [rowKey, row] of liveEntries(props[table])) {
      const authored = String(row.effect_label ?? "").trim();
      // A row with no `effect_label` gets a made-up handle so the graph can
      // talk about it. That handle EXISTS NOWHERE IN THE DATA, which is why
      // `labelIsSynthetic` has to travel with it — see `renameNode`.
      const label = authored
        || String(row.reaction_effect_ref ? `__reaction_${rowKey}` : `__row_${rowKey}`);
      const kind = String(row.effect_kind ?? row.reaction_trigger ?? "").trim();

      const extra = {};
      const refs = {};
      for (const [k, v] of Object.entries(row)) {
        // `$deleted: false` USED to be dropped here, which cost the round trip
        // its fidelity on 1084 rows — CSB reads absent and `false` the same
        // way, so nothing broke in play, but every one of those rows changed
        // in `_authored-export`, and that export is the only surface a world
        // push is reviewed through. Noise at that scale is what hides a real
        // removal. CSB internals (`$…`) are passengers like any other column.
        if (REF_FIELDS[k]) { refs[k] = v; continue; }
        extra[k] = v;
      }

      nodes.push({
        id: `${table}:${rowKey}`,
        table, rowKey, label, kind,
        labelIsSynthetic: !authored,
        isTrigger: table === "reaction_config_table",
        // The row's ORIGINAL key order. Splitting fields into refs/extra and
        // re-merging reorders them, which is semantically harmless to CSB but
        // shows up as churn in `_authored-export` — and that export is the
        // review surface a world-data push is read through. Noise there is not
        // cosmetic: it is what hides a one-line removal.
        keyOrder: Object.keys(row),
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
    // The ref strings EXACTLY as authored. If an edit does not change what a
    // field points at, the original string is written back untouched — so
    // `chain_steps: "fire_ae,asc_up"` does not become `"fire_ae, asc_up"` on
    // every save. That normalisation alone churned 274 rows of the corpus, and
    // churn on a save is what hides a real change in the export review.
    n.refRaw = { ...n.refs };
    // Ref PARTS that are not a step in this skill. Kept verbatim and put back
    // on write. This model cannot tell a reserved word from a typo, and the
    // safe reading of that uncertainty is to preserve, not to delete.
    n.refLiterals = {};

    for (const [field, value] of Object.entries(n.refs)) {
      const spec = REF_FIELDS[field];
      const targets = spec.kind === "list" ? splitRefs(value) : [String(value ?? "").trim()];
      targets.filter(Boolean).forEach((t, i) => {
        const to = byLabel.get(t) ?? null;
        if (!to) (n.refLiterals[field] ??= []).push({ value: t, order: i });
        edges.push({
          from: n.id,
          to,                            // null = not a step here; see refLiterals
          toLabel: t,
          field,
          order: i,
          dangling: !to,
          // A dangling STEP ref is a broken skill. A dangling TARGET ref is
          // usually just `self`. The UI must not paint them the same red.
          pointsAt: spec.points_at,
        });
      });
    }
  }

  // Each fire point is an edge from the document itself into the graph. Only
  // the ones the document ACTUALLY CARRIES are recorded — writing back a prop
  // the skill never had is how an editor adds an undeclared key that
  // `reloadTemplate` then prunes, reporting success the whole way.
  const entries = {};
  for (const field of Object.keys(FIRE_POINTS)) {
    if (!(field in props)) continue;
    const value = String(props[field] ?? "").trim();
    entries[field] = value;
    if (!value) continue;
    edges.push({
      from: "__document__", to: byLabel.get(value) ?? null, toLabel: value,
      field, order: 0, dangling: !byLabel.has(value), pointsAt: "step",
    });
  }

  return {
    nodes, edges, tombstones, tableKeyOrder, entries,
    // The primary fire point, kept as its own field because it is the one
    // every skill has and the one the panel leads with.
    entry: entries.on_activate_effect_ref || null,
  };
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
  const rows = {};
  for (const table of TABLES) { out[table] = {}; rows[table] = {}; }

  for (const n of graph.nodes) {
    const merged = { ...(n.extra ?? {}), ...(n.refs ?? {}) };
    const row = {};
    // Emit in the row's original key order, then anything new the editor added.
    for (const k of (n.keyOrder ?? [])) if (k in merged) row[k] = merged[k];
    for (const k of Object.keys(merged)) if (!(k in row)) row[k] = merged[k];
    rows[n.table][n.rowKey] = row;
  }

  // Rows the graph never showed, put back exactly as they were found. A node
  // the editor DELETED is simply absent from `graph.nodes` and so is genuinely
  // dropped — that distinction is the whole point of keeping the two apart.
  for (const table of TABLES) {
    for (const [rowKey, row] of Object.entries(graph.tombstones?.[table] ?? {})) {
      if (!(rowKey in rows[table])) rows[table][rowKey] = row;
    }
  }

  // Original key order first, then anything new. CSB does not care, but the
  // raw LevelDB does, and a stable order keeps a two-row edit a two-row diff.
  for (const table of TABLES) {
    for (const k of (graph.tableKeyOrder?.[table] ?? [])) {
      if (k in rows[table]) out[table][k] = rows[table][k];
    }
    for (const k of Object.keys(rows[table])) {
      if (!(k in out[table])) out[table][k] = rows[table][k];
    }
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
  const partsFor = new Map(graph.nodes.map((n) => [n.id, {}]));

  // Edges that still land on a node contribute that node's CURRENT label, so a
  // rename propagates to everything pointing at it.
  for (const e of graph.edges) {
    if (e.from === "__document__") continue;
    const target = e.to ? byId.get(e.to) : null;
    // No node on the other end. Either the editor deleted it — in which case
    // the reference SHOULD go — or it was never a node, and `refLiterals`
    // below is what puts it back.
    if (!target) continue;
    const bag = partsFor.get(e.from);
    if (!bag) continue;
    (bag[e.field] ??= []).push({ value: target.label, order: e.order });
  }

  // Parts that were never nodes: reserved target words, skill names, typos.
  for (const n of graph.nodes) {
    const bag = partsFor.get(n.id);
    if (!bag) continue;
    for (const [field, lits] of Object.entries(n.refLiterals ?? {})) {
      for (const lit of lits) (bag[field] ??= []).push({ value: lit.value, order: lit.order });
    }
  }

  const rebuilt = graph.nodes.map((n) => {
    const bag = partsFor.get(n.id) ?? {};
    const refs = {};
    for (const field of Object.keys(n.refs ?? {})) {
      const parts = (bag[field] ?? []).sort((a, b) => a.order - b.order).map((x) => x.value);
      const raw = n.refRaw?.[field];
      const spec = REF_FIELDS[field];
      // Unchanged? Write back the author's own string, spacing and all.
      if (raw != null && sameParts(parts, raw, spec)) { refs[field] = raw; continue; }
      // A key the node HAD is kept as an empty string rather than dropped —
      // the column exists on the sheet and a missing key reads differently
      // from a blank one to CSB's merge.
      refs[field] = spec?.kind === "list" ? parts.join(", ") : (parts[0] ?? "");
    }
    return { ...n, refs };
  });

  return fromGraph({ ...graph, nodes: rebuilt });
}

/** Does this part list say the same thing the authored string already said? */
function sameParts(parts, raw, spec) {
  const was = spec?.kind === "list" ? splitRefs(raw) : [String(raw ?? "").trim()].filter(Boolean);
  return was.length === parts.length && was.every((v, i) => v === parts[i]);
}

// ── integrity ───────────────────────────────────────────────────────────────

/** Problems visible in the graph itself, before the validator ever runs. */
export function graphProblems(graph, { isReservedTargetRef = null } = {}) {
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
  // A ref with no node on the other end is a BROKEN skill or a perfectly
  // ordinary reserved word, and the two are told apart only by the resolver's
  // own vocabulary. Guessing here is what would make the Wire tab shout
  // "Points at a step that isn't there" over 1263 rows that say `self`.
  //
  // So the oracle is injected, and when it is absent the check is SKIPPED AND
  // NAMED rather than answered — the validator's skip contract, which exists
  // because a rule that quietly passes is worse than one that admits it did
  // not run.
  let skippedTargetChecks = 0;
  for (const e of graph.edges) {
    if (!e.dangling) continue;
    if (e.pointsAt === "target") {
      if (typeof isReservedTargetRef !== "function") { skippedTargetChecks += 1; continue; }
      if (isReservedTargetRef(e.toLabel)) continue;
      problems.push({
        kind: "unknown_target_ref", field: e.field, label: e.toLabel,
        text: `"${e.toLabel}" is not one of the engine's target words, and no targeting step is ` +
          `named that. It resolves to nobody, so this step acts on nothing.`,
      });
      continue;
    }
    problems.push({
      kind: "dangling_ref", field: e.field, label: e.toLabel,
      text: `"${e.toLabel}" is referenced by ${e.field} but no row is named that. The reference ` +
        `resolves to nothing and the step is skipped.`,
    });
  }
  if (skippedTargetChecks) {
    // Reported AS A PROBLEM, not as a side-channel property on the array.
    // `reference_targeting_reason_not_shown_to_player` is this codebase's
    // standing lesson on that: an array-valued extra is the thing every caller
    // forgets and every serialiser drops. A row in the list cannot be missed.
    problems.push({
      kind: "not_checked", field: null, label: null,
      text: `${skippedTargetChecks} target reference(s) were NOT CHECKED — the engine's list of ` +
        `target words was not available here, so this panel cannot say whether they resolve.`,
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

// ── editing ─────────────────────────────────────────────────────────────────
//
// Mutations the Wire tab applies. They live here, not in the Application,
// because the Application is the one layer with no suite — and because every
// one of them has a way to silently destroy content:
//
//   rename   must carry every REFERENCE with it, or the skill breaks quietly
//   setRef   must not ADD a column the row's kind does not declare
//   remove   must TOMBSTONE a predefined row, or CSB resurrects it
//
// All of them work on the graph in place and leave it in a shape `toGraph`
// would have produced, so `fromGraphWithEdges` stays the only writer.

/** Index of label -> node id, rebuilt after any rename. */
function labelIndex(graph) {
  const m = new Map();
  for (const n of graph.nodes) if (n.label) m.set(n.label, n.id);
  return m;
}

/**
 * Rename a step, carrying every reference to it along.
 *
 * This is the operation that justifies the graph. In the CSB sheet, renaming a
 * row means finding each of `chain_steps` / `menu_option_refs` / `target_ref` /
 * `reaction_effect_ref` / the fire point by eye and editing the label in each —
 * and a missed one does not error, it just stops running.
 *
 * Returns `{ ok }`, or `{ ok: false, reason }` for a name that is blank or
 * already taken. A duplicate is refused rather than allowed-and-warned: two
 * rows with one label resolve differently on different engine paths, so
 * creating one is never what the author meant.
 */
export function renameNode(graph, nodeId, nextLabel) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: "no such step" };
  const label = String(nextLabel ?? "").trim();
  if (!label) return { ok: false, reason: "a step needs a name" };
  if (label === node.label) return { ok: true, unchanged: true };

  // 🩸 A SYNTHETIC label is not stored anywhere, so renaming it writes nothing
  // — while the rename still propagates to every referrer through the edges.
  // The result: the UI shows the new name, other rows start pointing at it,
  // and the row itself is still nameless. Every one of this world's 655
  // reaction rows is in exactly that state (none carries `effect_label`).
  //
  // Creating the column instead is not the safer option: `effect_label` is in
  // neither table's self-healing column set, so writing it to a row whose
  // table does not declare it is the "reports success and vanishes" failure
  // this whole tool exists to prevent. Refuse, and say why.
  if (node.labelIsSynthetic) {
    return {
      ok: false,
      reason: node.isTrigger
        ? "a trigger row has no name of its own — it is identified by what it reacts to, " +
          "and the name shown here is one this panel made up to draw the arrows"
        : "this row has no name stored in the data, so there is nothing to rename",
    };
  }
  if (graph.nodes.some((n) => n.id !== nodeId && n.label === label)) {
    return { ok: false, reason: `another step is already called "${label}"` };
  }

  const was = node.label;
  node.label = label;
  // `effect_label` is the field the engine actually reads; the node's `label`
  // is only this model's handle on it. Moving one without the other would
  // rename the step on screen and nowhere else.
  if ("effect_label" in node.extra) node.extra.effect_label = label;

  // Edges carry the node id, so `fromGraphWithEdges` already emits the new
  // label. `toLabel` is what the PANEL draws, and a stale one there means the
  // arrow still reads the old name after the rename.
  for (const e of graph.edges) if (e.to === nodeId) e.toLabel = label;
  // ALL THREE fire points, not just the primary one. This is the miss that a
  // live run caught: `pre_activate_effect_ref` kept naming the old step.
  for (const [field, value] of Object.entries(graph.entries ?? {})) {
    if (value === was) graph.entries[field] = label;
  }
  if (graph.entry === was) graph.entry = label;
  return { ok: true, from: was, to: label };
}

/**
 * Point one ref field at an ordered list of values.
 *
 * A value that matches a step becomes an edge; anything else is kept as a
 * literal (a reserved target word, or something the author typed). Order is
 * the list order.
 */
export function setNodeRef(graph, nodeId, field, values) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const spec = REF_FIELDS[field];
  if (!node || !spec) return { ok: false, reason: "not an editable reference" };

  const list = (Array.isArray(values) ? values : [values])
    .map((v) => String(v ?? "").trim()).filter(Boolean);
  const kept = spec.kind === "list" ? list : list.slice(0, 1);

  graph.edges = graph.edges.filter((e) => !(e.from === nodeId && e.field === field));
  node.refLiterals[field] = [];
  // The authored string no longer describes this field, so it must not be
  // written back verbatim.
  if (node.refRaw) delete node.refRaw[field];

  // A row with no `effect_label` cannot be pointed AT: the name the graph uses
  // for it exists only in this model, so writing it into a ref would produce a
  // reference to a label that is nowhere in the data. The UI already leaves
  // such rows out of its pickers; this is the half that a test can hold.
  const unnameable = new Set(graph.nodes.filter((n) => n.labelIsSynthetic).map((n) => n.label));
  const refused = kept.filter((v) => unnameable.has(v));
  const usable = kept.filter((v) => !unnameable.has(v));

  const byLabel = labelIndex(graph);
  usable.forEach((value, order) => {
    const to = byLabel.get(value) ?? null;
    if (!to) node.refLiterals[field].push({ value, order });
    graph.edges.push({
      from: nodeId, to, toLabel: value, field, order,
      dangling: !to, pointsAt: spec.points_at,
    });
  });

  if (usable.length) {
    // Mark the field PRESENT so `fromGraphWithEdges`, which walks
    // `Object.keys(node.refs)`, emits it at all. Its value here is ignored —
    // the edges are what the string is rebuilt from.
    node.refs[field] = "";
    return { ok: true, refused: refused.length ? refused : undefined };
  }

  // Cleared. A field the row ALREADY had stays present as a blank — CSB reads
  // an absent key differently from an empty one. A field it never had is
  // removed outright: adding `chain_then_ref: ""` to a row whose kind does not
  // declare that column is how an author gets a warning for a change they did
  // not make, and on some kinds how the value silently vanishes.
  if (node.keyOrder?.includes(field)) node.refs[field] = "";
  else delete node.refs[field];
  // `refused` rides on THIS branch too. It used to be returned only when
  // something survived, so refusing EVERY value reported nothing at all — the
  // caller showed no warning and the field just silently went blank, which is
  // the loudest case of the very thing the refusal exists to announce.
  return { ok: true, cleared: true, refused: refused.length ? refused : undefined };
}

/**
 * Remove a step.
 *
 * References to it go with it — that is the point of deriving refs from edges.
 * A PREDEFINED row is tombstoned instead of dropped, because dropping one only
 * deletes it until the next template sync puts it back.
 */
export function removeNode(graph, nodeId) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: "no such step" };

  graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);
  graph.edges = graph.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  for (const [field, value] of Object.entries(graph.entries ?? {})) {
    if (value === node.label) graph.entries[field] = "";
  }
  if (graph.entry === node.label) graph.entry = null;

  if (isPredefinedRow(node.extra)) {
    graph.tombstones[node.table] = graph.tombstones[node.table] ?? {};
    graph.tombstones[node.table][node.rowKey] = { ...node.extra, ...node.refs, $deleted: true };
    return { ok: true, tombstoned: true };
  }
  return { ok: true };
}

/**
 * Set the fire point — the step the skill runs when it is used.
 *
 * Its own memory entry exists because a row with no fire point is DEAD while
 * looking completely authored: `feedback_effect_rows_need_a_fire_point`.
 */
export function setEntry(graph, label, field = "on_activate_effect_ref") {
  if (!(field in FIRE_POINTS)) return { ok: false, reason: "not a fire point" };
  const next = String(label ?? "").trim();
  // Only THIS fire point's edge is replaced. Clearing them all was safe while
  // one was modelled and is data loss now.
  graph.edges = graph.edges.filter((e) => !(e.from === "__document__" && e.field === field));
  graph.entries = graph.entries ?? {};
  graph.entries[field] = next;
  if (field === "on_activate_effect_ref") graph.entry = next || null;
  if (!next) return { ok: true, cleared: true };
  const to = labelIndex(graph).get(next) ?? null;
  graph.edges.push({
    from: "__document__", to, toLabel: next, field, order: 0, dangling: !to, pointsAt: "step",
  });
  return { ok: true };
}

/**
 * Set one NON-reference field on a step.
 *
 * The Conditions tab writes `condition_formula` through here so that every
 * change to a skill still leaves by the one proven writer — `fromGraphWithEdges`
 * — rather than growing a second write path with its own way of losing data.
 *
 * Reference fields are refused: they are rebuilt from edges, so a value written
 * straight into `extra` would be silently overwritten on the next emit. That is
 * a wrong answer that LOOKS like it worked, so it must not be reachable.
 */
export function setNodeField(graph, nodeId, field, value) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: "no such step" };
  if (REF_FIELDS[field]) {
    return { ok: false, reason: `"${field}" is a reference — set it with setNodeRef` };
  }
  if (String(field).startsWith("$")) {
    return { ok: false, reason: "CSB bookkeeping is not editable" };
  }
  const v = String(value ?? "");
  if (v.trim()) { node.extra[field] = v; return { ok: true }; }

  // Same rule as `setNodeRef`: a column the row ALREADY had stays present as a
  // blank, because CSB reads an absent key differently from an empty one; a
  // column it never had is removed rather than added blank, which is how an
  // author avoids a finding for a change they did not make.
  if (node.keyOrder?.includes(field)) node.extra[field] = "";
  else delete node.extra[field];
  return { ok: true, cleared: true };
}

/**
 * Add a step.
 *
 * `row` must already be a COMPLETE row for its kind — see
 * `step-palette.js`, which builds one from the column registry. This function
 * deliberately knows nothing about which columns a kind declares: inventing a
 * row here would put a second, unregistered opinion about the schema next to
 * the one `template-field-registry.js` exists to be.
 *
 * 🪤 The new key follows CSB's own rule, `max(existing) + 1`
 * (`DynamicTable._createRow`), and counts TOMBSTONES in the maximum. Reusing a
 * tombstoned key would resurrect a deleted row's identity — and on a
 * predefined row, its content.
 */
export function addNode(graph, table, row) {
  if (!TABLES.includes(table)) return { ok: false, reason: `not a table: ${table}` };
  if (!row || typeof row !== "object") return { ok: false, reason: "a step needs a row" };

  const label = String(row.effect_label ?? "").trim();
  if (!label) return { ok: false, reason: "a step needs a name" };
  if (graph.nodes.some((n) => n.label === label)) {
    return { ok: false, reason: `another step is already called "${label}"` };
  }

  const used = new Set([
    ...graph.nodes.filter((n) => n.table === table).map((n) => String(n.rowKey)),
    ...Object.keys(graph.tombstones?.[table] ?? {}),
    ...(graph.tableKeyOrder?.[table] ?? []).map(String),
  ]);
  let next = 0;
  for (const k of used) {
    const n = Number(k);
    if (Number.isFinite(n) && n >= next) next = n + 1;
  }
  const rowKey = String(next);

  const extra = {};
  const refs = {};
  for (const [k, v] of Object.entries(row)) {
    if (REF_FIELDS[k]) refs[k] = v; else extra[k] = v;
  }

  const node = {
    id: `${table}:${rowKey}`,
    table, rowKey, label,
    kind: String(row.effect_kind ?? row.reaction_trigger ?? "").trim(),
    labelIsSynthetic: false,
    isTrigger: table === "reaction_config_table",
    keyOrder: Object.keys(row),
    refs,
    extra,
    refRaw: { ...refs },
    refLiterals: {},
  };
  graph.nodes.push(node);
  graph.tableKeyOrder = graph.tableKeyOrder ?? {};
  graph.tableKeyOrder[table] = [...(graph.tableKeyOrder[table] ?? []), rowKey];

  return { ok: true, nodeId: node.id, rowKey };
}
