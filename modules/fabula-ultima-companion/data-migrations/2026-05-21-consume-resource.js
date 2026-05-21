/**
 * Migration: 2026-05-21-consume-resource
 * ---------------------------------------------------------------------------
 * Three coordinated changes:
 *
 *   PHASE 1 — Template: add `consume_resource` effect_kind to the editor.
 *     - Append `consume_resource` to the effect_kind select options.
 *     - Extend grant_resource / grant_amount visibility formulas to also
 *       show for `consume_resource` (they were "grant"-only).
 *     - Extend `count` visibility to also show for `consume_charge`
 *       (was targeting-only — completes the editor for that kind).
 *     - Add new `on_empty` select column (abort / skip), visible for
 *       consume_charge OR consume_resource.
 *
 *   PHASE 2 — Protect chain reorder: was [protect_gate, protect_redirect],
 *     now [protect_redirect, protect_gate]. With redirect_target's new
 *     skipBody-not-abort return, the chain continues past redirect; the
 *     consume_charge step at the END only runs when redirect actually
 *     committed. Cancelling the targeting picker no longer consumes the
 *     Ready AE.
 *
 *   PHASE 3 — High Speed MP gate: wrap hs_free_action in a chain whose
 *     first step is a new consume_resource (mp=10) — aborts if Zarg
 *     can't pay. Adds `hs_mp_cost` (consume_resource) + `hs_self`
 *     (targeting) + `hs_react` (chain) rows; flips the trigger row's
 *     reaction_effect_ref from `hs_free_action` to `hs_react`.
 *
 *     Note: consume_resource runs FIRST here (gate semantics) since High
 *     Speed's chain has no mid-chain cancel point. Protect's reorder
 *     puts consume LAST because its chain DOES have a cancel point
 *     (the targeting picker on redirect_target).
 *
 * All phases idempotent.
 */

export const key = "2026-05-21-consume-resource";
export const description =
  "Add consume_resource effect_kind to template + handler; reorder Protect " +
  "chain to fix the cancel-still-consumed bug; wrap High Speed in a chain " +
  "with a 10-MP cost gate.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const PROTECT_MASTER_ID = "gTXdzJjV4Lmwfm7i";
const HIGH_SPEED_MASTER_ID = "pGPOqWRyrAFLbHho";

// ---------------------------------------------------------------------------
// PHASE 1 — Template surgery
// ---------------------------------------------------------------------------

const VF_KIND_IS_CONSUME_RESOURCE =
  "equalText(sameRow(\"effect_kind\",''), \"consume_resource\")";
const VF_KIND_IS_GRANT =
  "equalText(sameRow(\"effect_kind\",''), \"grant\")";
const VF_KIND_IS_CONSUME_CHARGE =
  "equalText(sameRow(\"effect_kind\",''), \"consume_charge\")";
const VF_RESOURCE_FIELDS =
  `or(${VF_KIND_IS_GRANT}, ${VF_KIND_IS_CONSUME_RESOURCE})`;
const VF_ON_EMPTY =
  `or(${VF_KIND_IS_CONSUME_CHARGE}, ${VF_KIND_IS_CONSUME_RESOURCE})`;

const ON_EMPTY_COLUMN = {
  key: "on_empty",
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: 0,
  editRole: 0,
  permission: 0,
  tooltip:
    "What to do when at least one target lacks the resource/charge. " +
    "`abort` cancels the chain AND signals the skill body to skip. " +
    "`skip` records the failure but continues the chain.",
  visibilityFormula: VF_ON_EMPTY,
  type: "select",
  size: "full-size",
  label: "",
  defaultValue: "abort",
  selectedOptionType: "custom",
  options: [
    { key: "abort", value: "Abort chain" },
    { key: "skip",  value: "Skip (continue)" }
  ],
  align: "left",
  colName: "On Empty",
  readonlyPredefined: false
};

function findEffectTable(node) {
  if (!node || typeof node !== "object") return null;
  if (node.key === "effect_table" && node.type === "compactDynamicTable") return node;
  for (const child of node.contents ?? []) {
    const hit = findEffectTable(child);
    if (hit) return hit;
  }
  return null;
}

async function migrateTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);
  const table = findEffectTable({ contents: [sysClone.body] });
  if (!table) return { ok: false, summary: "effect_table not found" };
  const rows = Array.isArray(table.rowLayout) ? table.rowLayout : null;
  if (!rows) return { ok: false, summary: "rowLayout missing" };

  let modified = false;

  // 1. Add consume_resource option to effect_kind dropdown.
  const ek = rows.find(r => r?.key === "effect_kind");
  if (ek && Array.isArray(ek.options) && !ek.options.some(o => o?.key === "consume_resource")) {
    // Insert after consume_charge if present, else at the end.
    const ccIdx = ek.options.findIndex(o => o?.key === "consume_charge");
    const newOpt = { key: "consume_resource", value: "Consume Resource" };
    if (ccIdx >= 0) ek.options.splice(ccIdx + 1, 0, newOpt);
    else ek.options.push(newOpt);
    log("added 'consume_resource' option to effect_kind dropdown");
    modified = true;
  }

  // 2. Extend grant_resource / grant_amount visibility to consume_resource.
  for (const key of ["grant_resource", "grant_amount"]) {
    const col = rows.find(r => r?.key === key);
    if (col && col.visibilityFormula !== VF_RESOURCE_FIELDS) {
      col.visibilityFormula = VF_RESOURCE_FIELDS;
      log(`updated ${key}.visibilityFormula to include consume_resource`);
      modified = true;
    }
  }

  // 3. Extend `count` visibility to ALSO show for consume_charge (was
  //    targeting-only; consume_charge has a count field too).
  const countCol = rows.find(r => r?.key === "count");
  if (countCol) {
    const targetingAndCountMeaningful =
      "and(equalText(sameRow(\"effect_kind\",''), \"targeting\"), not(equalText(sameRow(\"mode\",''), \"all\")))";
    const newVis = `or(${targetingAndCountMeaningful}, ${VF_KIND_IS_CONSUME_CHARGE})`;
    if (countCol.visibilityFormula !== newVis) {
      countCol.visibilityFormula = newVis;
      log("updated count.visibilityFormula to include consume_charge");
      modified = true;
    }
  }

  // 4. Add the on_empty column if missing.
  if (!rows.some(r => r?.key === "on_empty")) {
    // Insert after `count` if present, else at end.
    const cIdx = rows.findIndex(r => r?.key === "count");
    if (cIdx >= 0) rows.splice(cIdx + 1, 0, ON_EMPTY_COLUMN);
    else rows.push(ON_EMPTY_COLUMN);
    log(`added on_empty column (now ${rows.length} columns in effect_table rowLayout)`);
    modified = true;
  }

  if (!modified) return { ok: true, summary: "template already up-to-date" };
  await template.update({ system: sysClone });
  return { ok: true, summary: "template updated" };
}

// ---------------------------------------------------------------------------
// PHASE 2 — Protect chain reorder
// ---------------------------------------------------------------------------

function tableToArray(tbl) {
  if (!tbl) return [];
  if (Array.isArray(tbl)) return tbl.slice();
  return Object.keys(tbl).map(k => tbl[k]);
}
function arrayToObjectTable(arr) {
  const out = {};
  arr.forEach((row, i) => { out[String(i)] = row; });
  return out;
}

const PROTECT_NEW_CHAIN_STEPS = "protect_redirect, protect_gate";

async function reorderProtectChain(item, log) {
  const matches = item.id === PROTECT_MASTER_ID
               || item.system?.uniqueId === PROTECT_MASTER_ID;
  if (!matches) return false;
  const tbl = item.system?.props?.effect_table;
  if (!tbl) return false;
  const rows = tableToArray(tbl);
  const chainRow = rows.find(r => r?.effect_label === "protect_react" && r?.effect_kind === "chain");
  if (!chainRow) return false;
  const cur = String(chainRow.chain_steps ?? "").replace(/\s+/g, "");
  const want = PROTECT_NEW_CHAIN_STEPS.replace(/\s+/g, "");
  if (cur === want) return false; // already reordered
  chainRow.chain_steps = PROTECT_NEW_CHAIN_STEPS;
  await item.update({ "system.props.effect_table": arrayToObjectTable(rows) });
  log(`Protect "${item.name}" [${item.id}] chain_steps now "${PROTECT_NEW_CHAIN_STEPS}"`);
  return true;
}

// ---------------------------------------------------------------------------
// PHASE 3 — High Speed MP gate
// ---------------------------------------------------------------------------

const HS_NEW_ROWS = [
  // consume_resource — gate at chain start (no mid-chain cancel point on
  // High Speed today, so gate-first is correct).
  {
    $deleted: false,
    effect_label: "hs_mp_cost",
    effect_kind: "consume_resource",
    grant_resource: "mp",
    grant_amount: "10",
    target_ref: "hs_self",
    on_empty: "abort"
  },
  // self-target row used by the cost step.
  {
    $deleted: false,
    effect_label: "hs_self",
    effect_kind: "targeting",
    candidate_source: "self",
    category: "",
    mode: "exact",
    count: 1,
    auto_confirm_when_obvious: true,
    skip_when_passive: true,
    iteration_mode: "together"
  },
  // chain wrapper.
  {
    $deleted: false,
    effect_label: "hs_react",
    effect_kind: "chain",
    chain_steps: "hs_mp_cost, hs_free_action"
  }
];

async function authorHighSpeedGate(item, log) {
  const matches = item.id === HIGH_SPEED_MASTER_ID
               || item.system?.uniqueId === HIGH_SPEED_MASTER_ID;
  if (!matches) return false;

  const props = item.system?.props ?? {};
  const etRaw = props.effect_table;
  const rows = tableToArray(etRaw);

  let modified = false;

  // 1. Add the 3 new rows if missing (by label).
  for (const newRow of HS_NEW_ROWS) {
    if (!rows.some(r => r?.effect_label === newRow.effect_label)) {
      rows.push({ ...newRow });
      modified = true;
    }
  }

  // 2. Flip the trigger row's reaction_effect_ref to "hs_react".
  const rcRaw = props.reaction_config_table;
  const isArray = Array.isArray(rcRaw);
  const rcKeys = isArray ? rcRaw.map((_, i) => String(i)) : Object.keys(rcRaw ?? {});
  let triggerRowKey = null;
  for (const k of rcKeys) {
    const r = isArray ? rcRaw[Number(k)] : rcRaw[k];
    if (r?.reaction_trigger === "conflict_start" && !r?.$deleted) { triggerRowKey = k; break; }
  }
  let refPatch = null;
  if (triggerRowKey != null) {
    const existing = isArray ? rcRaw[Number(triggerRowKey)] : rcRaw[triggerRowKey];
    if (existing?.reaction_effect_ref !== "hs_react") {
      refPatch = `system.props.reaction_config_table.${triggerRowKey}.reaction_effect_ref`;
      modified = true;
    }
  }

  if (!modified) return false;

  const patch = {};
  patch["system.props.effect_table"] = arrayToObjectTable(rows);
  if (refPatch) patch[refPatch] = "hs_react";
  await item.update(patch);
  log(`High Speed "${item.name}" [${item.id}] wrapped in MP gate; reaction_effect_ref → "hs_react"`);
  return true;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export async function migrate(game, log) {
  // Phase 1
  const template = game.items?.get(TEMPLATE_ID);
  let tplSummary = "no template";
  if (template) {
    const r = await migrateTemplate(template, log);
    tplSummary = r.summary;
  }

  // Phase 2 + 3 — walk masters AND actor copies.
  let protectCount = 0;
  let hsCount = 0;
  for (const item of game.items?.contents ?? []) {
    try { if (await reorderProtectChain(item, log)) protectCount++; }
    catch (e) { log(`Protect master "${item.name}" failed: ${e?.message ?? e}`); }
    try { if (await authorHighSpeedGate(item, log)) hsCount++; }
    catch (e) { log(`High Speed master "${item.name}" failed: ${e?.message ?? e}`); }
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      try { if (await reorderProtectChain(item, log)) protectCount++; }
      catch (e) { log(`actor "${actor.name}" Protect "${item.name}" failed: ${e?.message ?? e}`); }
      try { if (await authorHighSpeedGate(item, log)) hsCount++; }
      catch (e) { log(`actor "${actor.name}" High Speed "${item.name}" failed: ${e?.message ?? e}`); }
    }
  }

  return {
    applied: true,
    summary: `template: ${tplSummary}; Protect chain reordered on ${protectCount} item${protectCount === 1 ? "" : "s"}; High Speed gate added on ${hsCount} item${hsCount === 1 ? "" : "s"}`
  };
}
