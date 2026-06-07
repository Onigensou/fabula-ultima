/**
 * Migration: 2026-06-07-retire-reaction-ispassive
 * ---------------------------------------------------------------------------
 * Retire the `reaction_isPassive` boolean. Every reaction_config_table row's
 * behavior now comes from a single 4-state field `reaction_passive_mode`
 * ∈ {force, on, ask, off}. The old boolean + the `includeManual` dispatch
 * filter are gone (see skill-effects.js / standalone-reactions.js).
 *
 * Conversion (preserves current behavior):
 *   reaction_isPassive === true  → reaction_passive_mode = existing mode or "ask"
 *   reaction_isPassive !== true  → reaction_passive_mode = "ask"   (manual was
 *                                  always an ask-pill)
 *   (the reaction_isPassive key is then deleted from the row)
 *
 * BEHAVIOR CHANGE (intended — see session decision 2026-06-07): former-manual
 * rows on POST-RESOLVE triggers (Consume, Life Transference, Painful Lesson)
 * were dormant under includeManual:false; as mode "ask" they now surface in the
 * post-resolve reaction menu. Card-trigger "may" reactions (Protect, Crossfire,
 * Hawkeye) are unchanged in play but become visible/toggleable in the Passive
 * Manager.
 *
 * Two jobs:
 *   1) TEMPLATE SURGERY — on every CSB template that has a reaction_config_table:
 *        • remove the `reaction_isPassive` column from the rowLayout
 *        • make `reaction_passive_mode` always-visible (its visibilityFormula
 *          referenced the now-removed reaction_isPassive column) + ensure the
 *          force/on/ask/off options + relabel "Firing Mode"
 *      Ends with a templateSystemUniqueVersion sync ([[csb-template-version-sync]]).
 *   2) DATA CONVERSION — convert every row on world Items, actor Item copies,
 *      item-embedded AE reactionConfigs, and actor-direct AE reactionConfigs.
 *
 * IDEMPOTENT: a row already lacking reaction_isPassive AND carrying a mode is
 * skipped; columns are removed/patched only if present/stale.
 */

export const key = "2026-06-07-retire-reaction-ispassive";
export const description =
  "Retire reaction_isPassive → single reaction_passive_mode (force/on/ask/off): " +
  "convert all rows + template column surgery.";

const NS = "fabula-ultima-companion";
const VALID_MODES = new Set(["on", "ask", "off", "force"]);

const MODE_OPTIONS = [
  { key: "ask",   value: "Ask — player decides (clickable pill)" },
  { key: "on",    value: "On — auto-fires, visible" },
  { key: "off",   value: "Off — disabled" },
  { key: "force", value: "Force — auto-fires, UI-invisible (engine-mandatory)" },
];

// Full column definition — inserted into any reaction_config_table that has no
// reaction_passive_mode column yet (legacy / non-skill templates the 2026-05-28
// column-add migration didn't reach). Mirrors that migration's column shape.
function makeModeColumn() {
  return {
    key: "reaction_passive_mode",
    colSpan: 1, rowSpan: 1, cssClass: "", role: 0, editRole: 0, permission: 0,
    tooltip: "Firing mode. ask = clickable pill · on = auto-fire visible · off = disabled · force = auto-fire, engine-only.",
    visibilityFormula: "",
    type: "select", size: "full-size", label: "", defaultValue: "ask",
    selectedOptionType: "custom",
    options: MODE_OPTIONS.map((o) => ({ ...o })),
    align: "left", colName: "Firing Mode", readonlyPredefined: false,
  };
}

// ── DATA CONVERSION ─────────────────────────────────────────────────────────

function convertRow(row) {
  if (!row || typeof row !== "object") return null;
  const hadIsPassive = Object.prototype.hasOwnProperty.call(row, "reaction_isPassive");
  const m = String(row.reaction_passive_mode ?? "").trim().toLowerCase();
  const hasValidMode = VALID_MODES.has(m);
  if (!hadIsPassive && hasValidMode) return null;  // already converted

  let mode;
  if (row.reaction_isPassive === true) {
    mode = hasValidMode ? m : "ask";       // passive: keep explicit mode, default ask
  } else {
    mode = "ask";                          // manual (false/undefined) was always ask
  }
  const { reaction_isPassive, ...rest } = row;
  return { ...rest, reaction_passive_mode: mode };
}

function convertTable(table) {
  if (!table || typeof table !== "object") return null;
  let changed = false;
  const out = {};
  for (const [k, row] of Object.entries(table)) {
    const conv = convertRow(row);
    if (conv) { out[k] = conv; changed = true; }
    else out[k] = row;
  }
  return changed ? out : null;
}

async function convertItemProps(item, log, label) {
  const next = convertTable(item.system?.props?.reaction_config_table);
  if (!next) return 0;
  await item.update({ "system.props.-=reaction_config_table": null });
  await item.update({ "system.props.reaction_config_table": next });
  log(`  ${label} ${item.name}: reaction_config_table converted`);
  return 1;
}

async function convertAEReactionConfig(ae, log, label) {
  const cfg = ae.flags?.[NS]?.reactionConfig;
  if (!cfg || typeof cfg !== "object") return 0;
  const nt = convertTable(cfg.reaction_config_table);
  if (!nt) return 0;
  // setFlag/update DEEP-MERGES, so a deleted nested key (reaction_isPassive)
  // would survive the merge. Delete-then-set the whole reactionConfig blob so
  // the retired key is actually gone.
  const nextCfg = { ...cfg, reaction_config_table: nt };
  await ae.update({ [`flags.${NS}.-=reactionConfig`]: null });
  await ae.update({ [`flags.${NS}.reactionConfig`]: nextCfg });
  log(`  ${label} AE "${ae.name}": reactionConfig converted`);
  return 1;
}

// ── TEMPLATE SURGERY ────────────────────────────────────────────────────────

function findReactionConfigNode(node, depth = 0) {
  if (depth > 20 || !node || typeof node !== "object") return null;
  if (node.key === "reaction_config_table" && Array.isArray(node.rowLayout)) return node;
  if (Array.isArray(node)) {
    for (const c of node) { const r = findReactionConfigNode(c, depth + 1); if (r) return r; }
    return null;
  }
  for (const k of Object.keys(node)) { const r = findReactionConfigNode(node[k], depth + 1); if (r) return r; }
  return null;
}

// Patch one template's rowLayout. Returns true if changed.
function patchRowLayout(layout, log, tplName) {
  let changed = false;

  // 1) Remove the retired reaction_isPassive column.
  const isPassiveIdx = layout.findIndex((c) => c?.key === "reaction_isPassive");
  if (isPassiveIdx !== -1) {
    layout.splice(isPassiveIdx, 1);
    changed = true;
    log(`  ${tplName}: removed reaction_isPassive column`);
  }

  // 2) Make reaction_passive_mode always visible + ensure options/labels.
  let modeCol = layout.find((c) => c?.key === "reaction_passive_mode");
  if (!modeCol) {
    // Insert a fresh mode column (legacy/non-skill template that never got it).
    modeCol = makeModeColumn();
    let idx = layout.findIndex((c) => c?.key === "reaction_passive_target");
    if (idx === -1) idx = layout.findIndex((c) => c?.key === "reaction_effect_ref");
    const at = idx === -1 ? layout.length : idx + 1;
    layout.splice(at, 0, modeCol);
    changed = true;
    log(`  ${tplName}: inserted reaction_passive_mode column`);
  } else {
    if (modeCol.visibilityFormula !== "") { modeCol.visibilityFormula = ""; changed = true; }
    if (modeCol.colName !== "Firing Mode") { modeCol.colName = "Firing Mode"; changed = true; }
    if (!modeCol.defaultValue) { modeCol.defaultValue = "ask"; changed = true; }
    if (!Array.isArray(modeCol.options)) { modeCol.options = []; changed = true; }
    const have = new Set(modeCol.options.map((o) => o?.key));
    for (const opt of MODE_OPTIONS) {
      if (!have.has(opt.key)) { modeCol.options.push({ ...opt }); changed = true; }
    }
    if (changed) log(`  ${tplName}: reaction_passive_mode column normalized (always-visible, ${modeCol.options.length} options)`);
  }

  return changed;
}

// Find every template Item (an item whose OWN system contains a
// reaction_config_table rowLayout) and surgery it. Returns the set of
// template ids that were touched (for the version-sync pass).
async function surgeryAllTemplates(game, log) {
  const touchedIds = new Set();
  const allTemplateIds = new Set();
  for (const item of game.items?.contents ?? []) {
    const node = findReactionConfigNode(item.system);
    if (!node) continue;                 // not a template (or no reaction table)
    allTemplateIds.add(item.id);
    const sys = foundry.utils.deepClone(item.toObject(false).system ?? {});
    const liveNode = findReactionConfigNode(sys);
    if (!liveNode) continue;
    if (patchRowLayout(liveNode.rowLayout, log, item.name)) {
      await item.update({ system: sys });
      touchedIds.add(item.id);
    }
  }
  return { touchedIds, allTemplateIds };
}

// Push each touched template's current version stamp to every instance that
// references it, so sheets re-derive against the surgered body.
async function versionSync(game, templateIds, log) {
  if (!templateIds.size) return;
  const wantById = new Map();
  for (const id of templateIds) {
    const tpl = game.items.get(id);
    const want = tpl?.system?.templateSystemUniqueVersion;
    if (want !== undefined && want !== null) wantById.set(id, want);
  }
  const cls = CONFIG.Item.documentClass;
  const worldUpdates = [];
  for (const item of game.items?.contents ?? []) {
    const tid = String(item.system?.template ?? "");
    if (!wantById.has(tid)) continue;
    if (item.system?.templateSystemUniqueVersion === wantById.get(tid)) continue;
    worldUpdates.push({ _id: item.id, "system.templateSystemUniqueVersion": wantById.get(tid) });
  }
  if (worldUpdates.length) await cls.updateDocuments(worldUpdates);
  let actorCopies = 0;
  for (const actor of game.actors?.contents ?? []) {
    const updates = [];
    for (const item of actor.items?.contents ?? []) {
      const tid = String(item.system?.template ?? "");
      if (!wantById.has(tid)) continue;
      if (item.system?.templateSystemUniqueVersion === wantById.get(tid)) continue;
      updates.push({ _id: item.id, "system.templateSystemUniqueVersion": wantById.get(tid) });
    }
    if (updates.length) { await actor.updateEmbeddedDocuments("Item", updates); actorCopies += updates.length; }
  }
  log(`  version-sync: ${worldUpdates.length} world item(s), ${actorCopies} actor copy(s)`);
}

// ── ENTRY ───────────────────────────────────────────────────────────────────

export async function migrate(game, log = () => {}) {
  // 1) Template column surgery.
  const { touchedIds } = await surgeryAllTemplates(game, log);

  // 2) Data conversion — world items + their AEs.
  let items = 0, aes = 0;
  const sweepItem = async (item, label) => {
    items += await convertItemProps(item, log, label);
    for (const ae of item.effects?.contents ?? []) aes += await convertAEReactionConfig(ae, log, label);
  };
  for (const item of game.items?.contents ?? []) await sweepItem(item, "[world]");
  for (const actor of game.actors?.contents ?? []) {
    for (const ae of actor.effects?.contents ?? []) aes += await convertAEReactionConfig(ae, log, `[${actor.name}]`);
    for (const item of actor.items?.contents ?? []) await sweepItem(item, `[${actor.name}]`);
  }

  // 3) Version-sync the surgered templates so sheets render the new layout.
  await versionSync(game, touchedIds, log);

  return {
    applied: true,
    summary: `isPassive retired: ${touchedIds.size} template(s) surgered, ${items} item table(s) + ${aes} AE config(s) converted`,
  };
}
