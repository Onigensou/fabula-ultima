/**
 * Migration: 2026-05-17-reaction-action-intent
 * ---------------------------------------------------------------------------
 * Backfills `reaction_action_intent` on standard action-driven reaction
 * skills, matching their RAW descriptions:
 *
 *   - "attack, spell or other danger" / "when X attack(s) you" → "harmful"
 *
 * For each TARGET below: looks up the skill by name in `game.items`, finds
 * the row matching the named trigger, and writes the intent if not already
 * set. Also ensures the `_Skill Template` master and each affected item
 * carries the `reaction_action_intent` column in its rowLayout so the CSB
 * editor surfaces it.
 *
 * IDEMPOTENT: every write is gated on "is this already done?". Safe to run
 * multiple times, and against worlds that have only partial state from
 * earlier ad-hoc patches.
 *
 * MATCHING POLICY: by `name + trigger`, NOT by UUID. UUIDs differ across
 * worlds and forks; standard skill names + their trigger keys are stable.
 * If a world has a same-named but differently-shaped skill, we skip it
 * (verified via the trigger key check).
 */

export const key = "2026-05-17-reaction-action-intent";
export const description =
  "Backfill reaction_action_intent='harmful' on standard action-driven " +
  "reactions (Protect, Counterattack, Cheap Shot, etc.) so they don't fire " +
  "on an ally's buff or heal.";

// Each entry: {name, trigger} — we match the FIRST row whose
// reaction_trigger equals `trigger` and set its `reaction_action_intent`
// to `intent`. `intent` is uniform "harmful" for this migration; future
// migrations can mix.
const INTENT = "harmful";

const TARGETS = [
  { name: "Cheap Shot",       trigger: "creature_performs_action" },
  { name: "Counterattack",    trigger: "creature_hit_by_action" },
  { name: "Fancy Footwork",   trigger: "creature_miss_action" },
  { name: "Illusory Shield",  trigger: "creature_targeted_by_action" },
  { name: "Pases",            trigger: "creature_miss_action" },
  { name: "Protect",          trigger: "creature_targeted_by_action" },
  { name: "Swordbreak",       trigger: "creature_miss_action" },
  { name: "Warning Shot",     trigger: "creature_performs_check" },
];

const SKILL_TEMPLATE_NAME = "_Skill Template";

// Shape of the new column. Mirrors the inline shape used in
// `tools/safe-edit/bin/_patch-reaction-action-intent.js`.
const ACTION_INTENT_COL = Object.freeze({
  key: "reaction_action_intent",
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: 0,
  editRole: 0,
  permission: 0,
  tooltip:
    'Match only on actions with this intent. "harmful" = attack / offensive spell / damage source (Protect, Counterattack, Cover). "aid" = heal / buff spell / utility active. "neutral" = Passive / Item / Other. Blank = no filter.',
  visibilityFormula: 'triggerHasSubject(sameRow("reaction_trigger",\'\'))',
  type: "select",
  size: "full-size",
  label: "",
  defaultValue: "",
  selectedOptionType: "custom",
  options: [
    { key: "",        value: "—"       },
    { key: "harmful", value: "Harmful" },
    { key: "aid",     value: "Aid"     },
    { key: "neutral", value: "Neutral" },
  ],
  align: "left",
  colName: "Action Intent",
  readonlyPredefined: false,
});

// rowLayout may be either an array OR a keyed object (CSB normalizes both
// shapes at runtime, and existing in-DB data uses both). Read generically.
function rowLayoutEntries(layout) {
  if (Array.isArray(layout)) {
    return layout.map((col, i) => [String(i), col]);
  }
  if (layout && typeof layout === "object") {
    return Object.keys(layout)
      .map(k => [k, layout[k]])
      .filter(([, v]) => v && typeof v === "object");
  }
  return [];
}

function rowLayoutHasColumn(layout, columnKey) {
  return rowLayoutEntries(layout).some(([, col]) => col?.key === columnKey);
}

// Splice ACTION_INTENT_COL into a rowLayout (after reaction_ownership if
// present, else at the end). Returns the new layout in the same shape as
// the input, or null if no change is needed.
function appendIntentColumn(rowLayout) {
  if (rowLayoutHasColumn(rowLayout, "reaction_action_intent")) return null;
  const entries = rowLayoutEntries(rowLayout);
  const out = [];
  let inserted = false;
  for (const [, col] of entries) {
    out.push(col);
    if (!inserted && col?.key === "reaction_ownership") {
      out.push({ ...ACTION_INTENT_COL });
      inserted = true;
    }
  }
  if (!inserted) out.push({ ...ACTION_INTENT_COL });
  if (Array.isArray(rowLayout)) return out;
  const obj = {};
  out.forEach((col, i) => { obj[String(i)] = col; });
  return obj;
}

// Locate the reaction_config_table node inside item.system.body. Returns
// {tableNode, topField} (topField is the system.* key under which the node
// lives — usually "body"). Returns null if not found.
function findReactionTable(item) {
  const sys = item?.system ?? {};
  for (const topField of Object.keys(sys)) {
    const root = sys[topField];
    if (!root || typeof root !== "object") continue;
    const tableNode = walkForKey(root, "reaction_config_table");
    if (tableNode) return { tableNode, topField };
  }
  return null;
}

function walkForKey(node, key) {
  if (!node || typeof node !== "object") return null;
  if (node.key === key && (node.rowLayout != null || node.contents != null || node.predefinedLines != null)) {
    return node;
  }
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = walkForKey(v, key);
      if (r) return r;
    }
  } else {
    for (const k of Object.keys(node)) {
      const r = walkForKey(node[k], key);
      if (r) return r;
    }
  }
  return null;
}

// Patch a single item's row data: find a live row whose reaction_trigger
// equals `trigger`, and set its reaction_action_intent if not already set.
// Returns one of "applied" | "already_set" | "no_row" | "no_table".
//
// Writes the WHOLE `reaction_config_table` back (per the no-dotted-array
// hazard) — preserves the table's array-vs-object shape.
async function patchRowIntent(item, trigger, intent) {
  const props = item?.system?.props ?? {};
  const tblRaw = props.reaction_config_table;
  if (!tblRaw) return "no_table";

  const wasArray = Array.isArray(tblRaw);
  const rowKeys = wasArray
    ? tblRaw.map((_, i) => i)
    : Object.keys(tblRaw);

  let matchKey = null;
  for (const k of rowKeys) {
    const row = wasArray ? tblRaw[k] : tblRaw[k];
    if (!row || typeof row !== "object") continue;
    if (row.$deleted) continue;
    if (String(row.reaction_trigger ?? "") === trigger) {
      matchKey = k;
      break;
    }
  }
  if (matchKey === null) return "no_row";

  const oldRow = wasArray ? tblRaw[matchKey] : tblRaw[matchKey];
  if (String(oldRow.reaction_action_intent ?? "") === intent) {
    return "already_set";
  }

  const newRow = { ...oldRow, reaction_action_intent: intent };
  const newTbl = wasArray ? [...tblRaw] : { ...tblRaw };
  newTbl[matchKey] = newRow;

  await item.update({ "system.props.reaction_config_table": newTbl });
  return "applied";
}

// Patch a single item's rowLayout (if the reaction_config_table node is
// present in its system.body / equivalent). Writes the whole top field
// back to avoid dotted-array hazards. Returns one of "applied" |
// "already_present" | "no_table_node".
async function patchRowLayoutColumn(item) {
  const hit = findReactionTable(item);
  if (!hit) return "no_table_node";
  const { tableNode, topField } = hit;
  if (!tableNode.rowLayout) return "no_table_node";

  const newLayout = appendIntentColumn(tableNode.rowLayout);
  if (!newLayout) return "already_present";

  // Clone the whole top field with the rowLayout swapped in. We mutate the
  // cloned tree (NOT the live one) and pass it through update().
  const clone = foundry.utils.deepClone(item.system[topField]);
  const cloneTable = walkForKey(clone, "reaction_config_table");
  if (!cloneTable) {
    // Shouldn't happen — we just found one — but bail safely.
    return "no_table_node";
  }
  cloneTable.rowLayout = newLayout;

  await item.update({ [`system.${topField}`]: clone });
  return "applied";
}

export async function migrate(game, log) {
  const items = game.items?.contents ?? [];
  if (!items.length) {
    return { applied: true, summary: "no world items present; nothing to migrate" };
  }

  const tallies = {
    rowsAppliedByTarget: {},   // name → count of row-data writes
    rowsAlreadyByTarget: {},   // name → already-set count
    rowsMissingByTarget: {},   // name → no-row-matched count
    layoutAppliedCount: 0,
    layoutAlreadyCount: 0,
    layoutMissingCount: 0,
    templatesPatched: 0,
  };

  // (A) Ensure the master _Skill Template carries the new rowLayout column.
  // New worlds with a single _Skill Template should pick this up so future
  // skill copies inherit the column.
  for (const item of items) {
    if (item.name !== SKILL_TEMPLATE_NAME) continue;
    const res = await patchRowLayoutColumn(item);
    if (res === "applied") tallies.templatesPatched++;
    log(`master template "${item.name}" rowLayout: ${res}`);
  }

  // (B) For each TARGET: patch row data + that item's rowLayout column.
  for (const target of TARGETS) {
    const matches = items.filter(it =>
      it.name === target.name &&
      it?.system?.props?.isReaction
    );
    if (!matches.length) {
      log(`skill "${target.name}" not present in this world`);
      continue;
    }
    for (const item of matches) {
      // Row data patch
      const rowRes = await patchRowIntent(item, target.trigger, INTENT);
      if (rowRes === "applied") {
        tallies.rowsAppliedByTarget[target.name] =
          (tallies.rowsAppliedByTarget[target.name] ?? 0) + 1;
      } else if (rowRes === "already_set") {
        tallies.rowsAlreadyByTarget[target.name] =
          (tallies.rowsAlreadyByTarget[target.name] ?? 0) + 1;
      } else if (rowRes === "no_row") {
        tallies.rowsMissingByTarget[target.name] =
          (tallies.rowsMissingByTarget[target.name] ?? 0) + 1;
      }
      log(`item "${item.name}" [${item.id}] row(${target.trigger}): ${rowRes}`);

      // rowLayout column patch (cosmetic, for CSB editor parity)
      const layoutRes = await patchRowLayoutColumn(item);
      if (layoutRes === "applied") tallies.layoutAppliedCount++;
      else if (layoutRes === "already_present") tallies.layoutAlreadyCount++;
      else tallies.layoutMissingCount++;
    }
  }

  const totalApplied = Object.values(tallies.rowsAppliedByTarget)
    .reduce((s, n) => s + n, 0);
  const totalAlready = Object.values(tallies.rowsAlreadyByTarget)
    .reduce((s, n) => s + n, 0);
  const totalMissing = Object.values(tallies.rowsMissingByTarget)
    .reduce((s, n) => s + n, 0);

  const summary =
    `rows: ${totalApplied} applied, ${totalAlready} already-set, ${totalMissing} no-row; ` +
    `layouts: ${tallies.layoutAppliedCount} patched, ${tallies.layoutAlreadyCount} already, ${tallies.layoutMissingCount} no-node; ` +
    `master templates patched: ${tallies.templatesPatched}`;

  return { applied: true, summary, details: tallies };
}
