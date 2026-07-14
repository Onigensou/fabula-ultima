/**
 * Migration: 2026-07-14-arcanum-template
 * ---------------------------------------------------------------------------
 * Create the dedicated `_Arcanum Template` — the CSB item template that backs
 * Arcanist Arcana. An Arcanum is a CONTAINER item (like a gear shell): it holds
 * three linked child `_skill`s (Merge / Pulse / Dismiss, via `system.container`)
 * and carries a couple of identity fields (domain + element).
 *
 * There is no precedent for authoring a CSB template's `system.header`/`.body`
 * component tree from scratch (they're large + hand-built), so we CLONE the
 * validated `_Item Template` (ZoiV53VaLzeRsEps — the gear container template,
 * which already knows how to hold linked skills) into a new
 * `_equippableItemTemplate` document, then (a) inject a small "Arcanum" panel with
 * `domain` + `element` textFields and (b) PRUNE the gear-only panels the Arcanum
 * never uses (weapon/armor stats, the type-efficiency grid, cooking, refinement,
 * defense, set, custom-logic). We KEEP the container machinery (related_item_list +
 * the skill projection) — that's what holds the Merge/Pulse/Dismiss children — plus
 * description + the Arcanum panel. The engine is decoupled from the body
 * (isArcanumContainer resolves by template id; children link via system.container),
 * so pruning only cleans the SHEET, never the game behavior.
 *
 * Enumeration of "which items are Arcana" does NOT depend on this template: the
 * authoring migration stamps each Arcanum with the `flags.fabula-ultima-companion
 * .isArcanum` flag (survives sheet saves, no hard-coded template UUID in engine).
 * The template is the authoring/display surface.
 *
 * Idempotent: re-running finds the existing `_Arcanum Template` by name+type and
 * only ensures the arcanum_panel is present.
 */

export const key = "2026-07-14-arcanum-template";
export const description =
  "Create the _Arcanum Template (clone of _Item Template) with a domain + element " +
  "panel — the container template for Arcanist Arcana.";

const ITEM_TEMPLATE_ID = "ZoiV53VaLzeRsEps"; // _Item Template (gear container)
const ARCANUM_TEMPLATE_NAME = "_Arcanum Template";
const ARCANUM_TEMPLATE_VERSION = 4207140005; // bumped: flattened body to a single tab-less view

// Gear-only panels (by component `key`) the Arcanum never uses — removed from the
// cloned body anywhere they appear. KEPT (not listed): main_panel/tabs, description_panel,
// flavorText_panel, related_item_panel (related_item_list — holds the children),
// arcanum_panel (domain/element), backyard_panel + skill_panel (item_skill_active/passive
// projection). Removing whole self-contained panels (not table rows) avoids the CSB
// sheet-blank traps that row-level surgery hits.
const GEAR_PANEL_KEYS = new Set([
  "weaponStat_panel",   // category / range / hand slots / attack stat / damage
  "armorStat_panel",    // def / mdef
  "set_panel",          // equipment-set name/description
  "stat_panel",         // "Bonus Stat" — optional_params + item_activeEffect (Arcanum has no AEs)
  "defenseStat_panel",
  "efficiency_panel",   // the huge type / sub-type efficiency grid
  "refinement_panel",
  "cooking_panel",
  "custom_logic_tab",   // legacy custom-logic + effect/reaction tables (children carry those)
  "ip_cost_panel",      // empty IP-cost box inside description_panel (gear leftover)
]);

// The entire `custom_header` is gear (Type/Rarity/Cost/Quantity/IP/Equipped/Tags +
// classification table) — none used by an Arcanum, and the item NAME is rendered by CSB's
// built-in header, not this component tree. So we empty it wholesale (clean, no orphan
// labels). Idempotent: re-running on an already-empty header is a no-op.
function stripGearHeader(sysClone, log) {
  const h = sysClone.header;
  if (h && typeof h === "object" && Array.isArray(h.contents) && h.contents.length) {
    h.contents = [];
    log(`  emptied gear header (custom_header)`);
    return 1;
  }
  return 0;
}

const TEXT_FIELD_BASE = {
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: 0,
  editRole: 4,
  permission: 0,
  tooltip: "",
  visibilityFormula: "",
  type: "textField",
  size: "medium",
  label: "",
  defaultValue: "",
  maxLength: 0,
  style: "",
};

const ARCANUM_PANEL = {
  key: "arcanum_panel",
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: 0,
  editRole: 4,
  permission: 0,
  tooltip: "",
  visibilityFormula: "",
  type: "panel",
  contents: [
    { ...TEXT_FIELD_BASE, key: "domain",  label: "Domain",  tooltip: "The Arcanum's domains (e.g. Vengeance, Burn) — feeds Ritual Arcanism / Arcane Echoes." },
    { ...TEXT_FIELD_BASE, key: "element", label: "Element", tooltip: "The Arcanum's associated damage type (e.g. fire), for its Dismiss burst." },
  ],
  flow:             "grid-2",
  align:            "left",
  collapsible:      true,
  defaultCollapsed: false,
  title:            "Arcanum",
  titleStyle:       "default",
};

// Recursively drop any node whose `key` is in GEAR_PANEL_KEYS, then drop unkeyed
// wrapper panels left empty by that removal (so the sheet has no hollow boxes).
// Returns the count removed. Mutates `node.contents` in place.
function pruneGearPanels(node) {
  if (!node || typeof node !== "object" || !Array.isArray(node.contents)) return 0;
  let removed = 0;
  const kept = [];
  for (const child of node.contents) {
    if (child && GEAR_PANEL_KEYS.has(child.key)) { removed++; continue; }
    removed += pruneGearPanels(child);
    // Drop a now-empty, unkeyed, untitled wrapper panel (pure layout scaffold).
    const isHollowWrapper = child && child.type === "panel" && !child.key && !child.title
      && Array.isArray(child.contents) && child.contents.length === 0;
    if (isHollowWrapper) { removed++; continue; }
    kept.push(child);
  }
  node.contents = kept;
  return removed;
}

// _Item Template gates its container panels on `item_type` — e.g. main_panel:
// `not(equalText(item_type,""))`, the skill panels: `switchCase(item_type,'weapon'…,false)`.
// An Arcanum has NO item_type, so those formulas evaluate FALSE and HIDE the panel: the
// sheet renders but shows nothing (content is in the DOM, display-none). Clear the
// visibilityFormula on any CONTAINER panel (panel/tabbedPanel/tab) that references a removed
// gear field, so the Arcanum's tabs + skills are always visible. Label-level formulas (the
// consumable/recipe description-header variants) are left alone. Returns count cleared.
function clearGearVisibility(node) {
  if (!node || typeof node !== "object") return 0;
  let cleared = 0;
  const isContainer = node.type === "panel" || node.type === "tabbedPanel" || node.type === "tab";
  if (isContainer && String(node.visibilityFormula ?? "").includes("item_type")) {
    node.visibilityFormula = "";
    cleared++;
  }
  for (const c of node.contents ?? []) cleared += clearGearVisibility(c);
  return cleared;
}

// Prune the body (and header, in case a gear panel lives there), then clear the item_type
// visibility gates the Arcanum can never satisfy. Returns total changes.
function pruneGearFromSystem(sysClone, log) {
  const before = JSON.stringify(sysClone).length;
  let removed = 0;
  if (sysClone.body)   removed += pruneGearPanels({ contents: [sysClone.body] });
  if (sysClone.header) removed += pruneGearPanels({ contents: [sysClone.header] });
  const after = JSON.stringify(sysClone).length;
  if (removed) log(`  pruned ${removed} gear panel(s) (${before}→${after} bytes)`);
  let unhidden = 0;
  if (sysClone.body)   unhidden += clearGearVisibility(sysClone.body);
  if (sysClone.header) unhidden += clearGearVisibility(sysClone.header);
  if (unhidden) log(`  cleared ${unhidden} item_type visibility gate(s)`);
  return removed + unhidden;
}

function findNode(node, targetKey) {
  if (!node || typeof node !== "object") return null;
  if (node.key === targetKey) return node;
  for (const child of node.contents ?? []) {
    const hit = findNode(child, targetKey);
    if (hit) return hit;
  }
  return null;
}

// Collapse the inherited 2-tab layout (📜 main / ⚙️ status) into ONE tab-less body:
// arcanum_panel (Domain/Element) → text_panel (Description/flavor) → skill_panel (the
// Merge/Pulse/Dismiss child container). Drops the tabbedPanel wrapper AND the redundant
// related_item_panel (the children already show under Skill). Idempotent: no-op once flat.
function flattenArcanumBody(sysClone, log) {
  const body = sysClone.body;
  if (!body || !Array.isArray(body.contents)) return 0;
  const hasTabbed = body.contents.some((c) => c && c.key === "main_panel");
  if (!hasTabbed) return 0; // already flattened
  const arcanumPanel = findNode(body, "arcanum_panel");
  const textPanel    = findNode(body, "text_panel");
  const skillPanel   = findNode(body, "skill_panel");
  const kept = [arcanumPanel, textPanel, skillPanel].filter(Boolean);
  body.contents = kept;
  log(`  flattened body → single view [${kept.map((k) => k.key).join(", ")}]`);
  return 1;
}

// Inject the arcanum_panel into the template body. Prefer the "status" tab (known
// to exist on the item template); else fall back to the body root's contents.
function injectArcanumPanel(sysClone, log) {
  if (findNode({ contents: [sysClone.body] }, "arcanum_panel")) {
    return false; // already present
  }
  const statusTab = findNode({ contents: [sysClone.body] }, "status");
  const host = statusTab ?? sysClone.body;
  host.contents = host.contents ?? [];
  host.contents.unshift(ARCANUM_PANEL);
  log(`  injected arcanum_panel into ${statusTab ? "status tab" : "body root"}`);
  return true;
}

export async function migrate(game, log = () => {}) {
  const src = game.items?.get(ITEM_TEMPLATE_ID);
  if (!src) return { applied: false, summary: `source template ${ITEM_TEMPLATE_ID} not found` };

  let tpl = game.items?.find((it) =>
    it.type === "_equippableItemTemplate" && it.name === ARCANUM_TEMPLATE_NAME);

  // Place alongside the other CSB templates (the "Template" folder).
  const templateFolder = game.folders?.find((f) => f.type === "Item" && f.name === "Template" && !f.folder)
    ?? (src.folder?.id ? game.folders?.get(src.folder.id ?? src.folder) : null);
  const templateFolderId = templateFolder?.id ?? (src.folder?.id ?? src.folder ?? null);

  if (!tpl) {
    const sysClone = foundry.utils.duplicate(src.system);
    sysClone.templateSystemUniqueVersion = ARCANUM_TEMPLATE_VERSION;
    injectArcanumPanel(sysClone, log);
    pruneGearFromSystem(sysClone, log);
    stripGearHeader(sysClone, log);
    flattenArcanumBody(sysClone, log);
    tpl = await Item.create({
      name: ARCANUM_TEMPLATE_NAME,
      type: "_equippableItemTemplate",
      img: "icons/svg/daze.svg",
      folder: templateFolderId,
      system: sysClone,
    });
    log(`created ${ARCANUM_TEMPLATE_NAME} (${tpl?.id}) in folder ${templateFolderId}`);
    return { applied: true, summary: `created _Arcanum Template ${tpl?.id}` };
  }

  // Ensure folder placement on re-run.
  if (templateFolderId && (tpl.folder?.id ?? tpl.folder ?? null) !== templateFolderId) {
    await tpl.update({ folder: templateFolderId });
    log(`  _Arcanum Template -> Template folder`);
  }

  // Exists — ensure the arcanum_panel is present + gear panels pruned (idempotent).
  const sysClone = foundry.utils.duplicate(tpl.system);
  let changed = injectArcanumPanel(sysClone, log);
  const pruned = pruneGearFromSystem(sysClone, log);
  const headerStripped = stripGearHeader(sysClone, log);
  const flattened = flattenArcanumBody(sysClone, log);
  changed = changed || pruned > 0 || headerStripped > 0 || flattened > 0;
  if (sysClone.templateSystemUniqueVersion !== ARCANUM_TEMPLATE_VERSION) {
    sysClone.templateSystemUniqueVersion = ARCANUM_TEMPLATE_VERSION;
    changed = true;
  }
  if (changed) {
    await tpl.update({ system: sysClone });
    return { applied: true, summary: `_Arcanum Template ${tpl.id}: arcanum_panel + gear-prune ensured (${pruned} removed)` };
  }
  return { applied: true, summary: `_Arcanum Template ${tpl.id} already clean` };
}

export const ARCANUM_TEMPLATE = { NAME: ARCANUM_TEMPLATE_NAME, VERSION: ARCANUM_TEMPLATE_VERSION };
