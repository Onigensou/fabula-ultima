/**
 * Migration: 2026-06-07-menu-text-on-menu-row
 * ---------------------------------------------------------------------------
 * Two jobs:
 *
 * 1) TEMPLATE SURGERY (column gate) — expose the open_action_menu config fields
 *    in the CSB sheet. They were data-only (authored via migration, read at
 *    runtime, invisible/uneditable in the sheet). Adds 6 columns to the
 *    effect_table, each gated to `effect_kind === "open_action_menu"`:
 *      menu_title, menu_subtitle, menu_pick_count,
 *      menu_option_refs, menu_option_labels, menu_option_descriptions
 *
 * 2) DATA RESHAPE — move all menu TEXT onto the open_action_menu row; option
 *    rows keep only their mechanical data. The per-option display label +
 *    description now live on the menu row as `|`-separated lists positionally
 *    paired with the comma-separated `menu_option_refs`. The legacy per-option
 *    `menu_label` / `menu_description` fields are removed. The engine
 *    (buildMenuOptions) reads the menu-row lists and FALLS BACK to the old
 *    per-option fields, so this reshape is non-breaking even mid-rollout.
 *
 * Affects the open_action_menu skills: Awaken, Hallucination, Hawkeye, Reinforce,
 * Torpor, Warning Shot (masters + actor copies). free_mode menu rows (no option
 * list) are untouched.
 *
 * Ends with a templateSystemUniqueVersion sync so sheets render the new columns
 * ([[csb-template-version-sync]]).
 *
 * IDEMPOTENT: columns appended only if missing; a menu row is reshaped only when
 * it has no `menu_option_labels` yet.
 */

export const key = "2026-06-07-menu-text-on-menu-row";
export const description =
  "Expose open_action_menu config columns + move menu text (option labels/" +
  "descriptions + prompt) onto the menu row; option rows hold mechanics only.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const OAM_VIS = `equalText(sameRow("effect_kind",''), "open_action_menu")`;

function col(key, colName, { type = "textField", tooltip = "" } = {}) {
  return {
    key, colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip, visibilityFormula: OAM_VIS,
    type, size: "full-size", label: "", defaultValue: "", autocomplete: "", align: "left",
    colName, readonlyPredefined: false,
  };
}

const NEW_COLUMNS = [
  col("menu_title", "Menu Title", { tooltip: "Prompt title shown above the option list." }),
  col("menu_subtitle", "Menu Subtitle", { tooltip: "Prompt subtitle / instruction line." }),
  col("menu_pick_count", "Pick Count", { tooltip: "How many distinct options to choose. Number or formula (default 1). e.g. \"1 + HAS_SKILL_PERFECT_AIM\"." }),
  col("menu_option_refs", "Option Refs", { tooltip: "Comma-separated effect_label refs — which option rows this menu offers, in order." }),
  col("menu_option_labels", "Option Labels", { tooltip: "Pipe (|)-separated display labels, positionally paired with Option Refs." }),
  col("menu_option_descriptions", "Option Descriptions", { tooltip: "Pipe (|)-separated descriptions, positionally paired with Option Refs (may contain commas)." }),
];

function findTableNode(sys) {
  let node = null;
  (function walk(n, d) {
    if (d > 18 || !n || typeof n !== "object" || node) return;
    if (n.key === "effect_table" && n.type === "compactDynamicTable") { node = n; return; }
    if (Array.isArray(n)) n.forEach((v) => walk(v, d + 1));
    else for (const k of Object.keys(n)) walk(n[k], d + 1);
  })(sys, 0);
  return node;
}

// Phase 1 — add the columns to the effect_table rowLayout.
async function ensureColumns(game, log) {
  const tmpl = game.items.get(TEMPLATE_ID);
  if (!tmpl) { log("template not found — skipping columns"); return false; }
  const sys = foundry.utils.deepClone(tmpl.toObject(false).system ?? {});
  const table = findTableNode(sys);
  if (!table || !Array.isArray(table.rowLayout)) { log("effect_table rowLayout not found"); return false; }
  const have = new Set(table.rowLayout.map((c) => c?.key));
  const toAdd = NEW_COLUMNS.filter((c) => !have.has(c.key));
  if (!toAdd.length) { log("columns already present"); return false; }
  // Insert after the existing open_action_menu group (damage_bonus_formula) for
  // tidy grouping; fall back to append.
  let idx = table.rowLayout.findIndex((c) => c?.key === "damage_bonus_formula");
  if (idx === -1) idx = table.rowLayout.length - 1;
  table.rowLayout.splice(idx + 1, 0, ...toAdd);
  await tmpl.update({ system: sys });
  log(`added ${toAdd.length} column(s): ${toAdd.map((c) => c.key).join(", ")}`);
  return true;
}

// Phase 2 — reshape menu rows on one item's effect_table. Returns true if changed.
function reshapeEffectTable(et) {
  if (!et || typeof et !== "object") return null;
  const clone = foundry.utils.deepClone(et);
  const rows = Object.values(clone).filter((r) => r && typeof r === "object");
  const byLabel = new Map(rows.map((r) => [String(r.effect_label ?? "").trim(), r]));
  let changed = false;

  for (const m of rows) {
    if (String(m.effect_kind ?? "").toLowerCase() !== "open_action_menu") continue;
    if (m.free_mode === true) continue;
    const refsRaw = String(m.menu_option_refs ?? "").trim();
    if (!refsRaw) continue;
    // Already reshaped? (menu row carries the labels) → skip.
    if (m.menu_option_labels != null && String(m.menu_option_labels).trim() !== "") continue;

    const refs = refsRaw.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    const labels = [];
    const descs = [];
    for (const ref of refs) {
      const opt = byLabel.get(ref);
      labels.push(String(opt?.menu_label ?? ref));
      descs.push(String(opt?.menu_description ?? ""));
    }
    m.menu_option_labels = labels.join(" | ");
    m.menu_option_descriptions = descs.join(" | ");
    changed = true;

    // Strip the now-migrated text from the option rows (mechanics only).
    for (const ref of refs) {
      const opt = byLabel.get(ref);
      if (!opt) continue;
      if ("menu_label" in opt) { delete opt.menu_label; changed = true; }
      if ("menu_description" in opt) { delete opt.menu_description; changed = true; }
    }
  }
  return changed ? clone : null;
}

async function reshapeItem(item, log) {
  const next = reshapeEffectTable(item.system?.props?.effect_table);
  if (!next) return false;
  // Force-replace (null then set) so deleted keys don't survive Foundry's merge.
  await item.update({ "system.props.effect_table": null });
  await item.update({ "system.props.effect_table": next });
  return true;
}

// Phase 3 — version-sync so sheets re-derive against the new template body.
async function versionSync(game, log) {
  const tmpl = game.items.get(TEMPLATE_ID);
  const want = tmpl?.system?.templateSystemUniqueVersion;
  if (want === undefined || want === null) { log("no template version stamp — skipping sync"); return; }
  const cls = CONFIG.Item.documentClass;
  const worldUpdates = [];
  for (const item of game.items?.contents ?? []) {
    if (String(item.system?.template ?? "") !== TEMPLATE_ID) continue;
    if (item.system?.templateSystemUniqueVersion === want) continue;
    worldUpdates.push({ _id: item.id, "system.templateSystemUniqueVersion": want });
  }
  if (worldUpdates.length) await cls.updateDocuments(worldUpdates);
  let actorCopies = 0;
  for (const actor of game.actors?.contents ?? []) {
    const updates = [];
    for (const item of actor.items?.contents ?? []) {
      if (String(item.system?.template ?? "") !== TEMPLATE_ID) continue;
      if (item.system?.templateSystemUniqueVersion === want) continue;
      updates.push({ _id: item.id, "system.templateSystemUniqueVersion": want });
    }
    if (updates.length) { await actor.updateEmbeddedDocuments("Item", updates); actorCopies += updates.length; }
  }
  log(`version-sync: ${worldUpdates.length} world item(s), ${actorCopies} actor copy(s)`);
}

export async function migrate(game, log = () => {}) {
  await ensureColumns(game, log);

  // Reshape menu rows on every templated item (masters + actor copies).
  let masters = 0, copies = 0;
  for (const item of game.items?.contents ?? []) {
    if (String(item.system?.template ?? "") !== TEMPLATE_ID) continue;
    try { if (await reshapeItem(item, log)) masters += 1; }
    catch (e) { log(`reshape failed for master "${item.name}": ${e?.message ?? e}`); }
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (String(item.system?.template ?? "") !== TEMPLATE_ID) continue;
      try { if (await reshapeItem(item, log)) copies += 1; }
      catch (e) { log(`reshape failed for ${actor.name}/"${item.name}": ${e?.message ?? e}`); }
    }
  }
  log(`reshaped menu rows: ${masters} master(s), ${copies} actor copy(s)`);

  await versionSync(game, log);
  return { applied: true, summary: `menu columns exposed; reshaped ${masters} master(s) + ${copies} copy(s)` };
}
