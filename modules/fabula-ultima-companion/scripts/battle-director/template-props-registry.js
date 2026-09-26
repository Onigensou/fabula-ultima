// Template PROP registry — the top-level counterpart to
// `template-field-registry.js`.
//
// ═══ WHY THIS EXISTS ═══════════════════════════════════════════════════════
//
// A top-level `system.props` key that the template declares no field for is
// **deleted**. `TemplateSystem.reloadTemplate` (CSB
// `module/documents/templateSystem.js:672-677`) builds the declared key set and
// then, for every prop not in it, sets `props['-=' + prop] = true`. That is the
// documented 112-key loss, and it is not hypothetical: `visibility-audit`
// reports **20 keys across 118 authored cells** in exactly that state on the
// skill template today, and `skill-forge-design.md` D11 established that all
// twenty are read by the engine. They are live behaviour one template reload
// away from deletion.
//
// The row-field registry solved the same problem for dynamic-table COLUMNS with
// a self-healing boot sync. This is that mechanism for top-level props.
//
//   ➜ TO PROTECT A NEW TOP-LEVEL PROP: add ONE entry below. The boot sync
//     gives it a field on the template, which both stops the prune and makes
//     it editable. Do NOT hand-write a migration.
//
// ═══ THE CONSTRAINT THAT MAKES THIS SAFE: NO DEFAULT VALUE ═════════════════
//
// The same `reloadTemplate` also STAMPS declared props onto every instance:
//
//     for (const prop in allProperties)
//       if (props[prop] === undefined && allProperties[prop] !== null)
//         props[prop] = allProperties[prop];
//
// and `Container.getAllProperties` yields a component's computed
// `defaultValue`, or `undefined` when it has none (falsy `defaultValue` takes
// the `: undefined` branch). `undefined` does not survive a document update, so
// a field declared WITHOUT a default adds no key to any document.
//
// With a default, it would write that value onto **2,374 skill documents at
// once** — a change that dwarfs any authoring edit and would bury a real
// removal in the export review. So:
//
//   🚨 EVERY MANAGED FIELD MUST LEAVE `defaultValue` EMPTY. `checkbox` uses
//      `defaultChecked: false`, which is falsy and therefore equally safe.
//
// Types are chosen from the values the corpus actually holds, and where a key
// is enum-ish it is still a `textField`: a `select` whose option list misses a
// live value HIDES that value, which is the failure this file exists to stop.
// The dropdown-option sync can promote one later, from evidence.

/** Templates that receive the managed props. */
//
// An explicit list, not a shape test. These keys are skill semantics
// (`action_command`, `undying_zp_cost`, `recipe_*`), so handing them to every
// template that happens to carry an `effect_table` would declare skill fields
// on gear.
//
// ⚠ The monster-skill template `FZmpKcQRP7hZQqbV` is deliberately absent: 53
// documents in this world name it and **it does not exist as a world item**,
// so there is nothing to sync onto. That is a real defect, but it is a content
// defect, not this file's business.
export const MANAGED_PROP_TEMPLATES = Object.freeze(["j0F5Msw5RZ8aIB3j"]);

/** The tab the managed fields live in, so the sync never touches hand-authored layout. */
export const MANAGED_TAB_KEY = "fu_engine_fields";
export const MANAGED_PANEL_KEY = "fu_engine_fields_panel";

const base = (key, label, tooltip) => ({
  key,
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: 0,
  editRole: 0,
  permission: 0,
  tooltip,
  visibilityFormula: "",
  size: "full-size",
  label,
});

const textProp = (key, label, tooltip = "") => ({
  ...base(key, label, tooltip),
  type: "textField",
  // 🚨 Empty. See the header — a default here writes to 2,374 documents.
  defaultValue: "",
  charList: "",
  maxLength: null,
  autocomplete: "",
});

const areaProp = (key, label, tooltip = "") => ({
  ...base(key, label, tooltip),
  type: "textArea",
  defaultValue: "",
  style: "dialog",
});

const checkProp = (key, label, tooltip = "") => {
  const n = { ...base(key, label, tooltip), type: "checkbox" };
  delete n.defaultValue;
  n.defaultChecked = false;   // falsy ⇒ getAllProperties yields undefined
  return n;
};

/**
 * The fields. Each is a key `visibility-audit` reports as data-only on the
 * skill template, with the cell count it reported on 2026-09-23.
 *
 * `reaction_effect_table` is POINTEDLY ABSENT. It is data-only on 14 documents
 * and it is an **empty object on every one of them** — a dead legacy alias
 * (`skill-targeting.js` still reads it as a fallback table). Declaring it would
 * preserve nothing and add a table to the sheet; letting the prune take it is
 * the correct outcome, and the only key in the list of twenty for which that is
 * true.
 */
export const MANAGED_PROPS = Object.freeze([
  areaProp("skill_description", "Skill Description",
    "Long-form rules text (HTML). 42 cells across 22 documents."),
  // carrier-scan's carrier 10: the pointer for a skill whose rules are GM
  // adjudication (a question answered truthfully, a language spoken) or live in
  // another doc. Undeclared, the note would be pruned on the next reload.
  areaProp("implementation_note", "Implementation Note",
    "Why this skill has no rows: GM-adjudicated, or implemented elsewhere (name it)."),
  areaProp("animation_preload_urls", "Animation Preload URLs",
    "Newline/comma list of asset paths warmed before the animation plays."),
  textProp("check_mode", "Check Mode",
    "none | open | difficulty — how this skill's check is resolved."),
  textProp("check_difficulty_level", "Check Difficulty",
    "Target number when check_mode is difficulty. Held as a string or a number."),
  textProp("arcanum_role", "Arcanum Role", "pulse | merge | dismiss."),
  textProp("action_intent", "Action Intent",
    "harmful | helpful — what the action is FOR, independent of its target."),
  textProp("action_command", "Action Command",
    "The player-facing COMMAND (Attack / Skill / Spell / Item). Engine-read by " +
    "domination, state-handlers and skill-recipes; see docs/action-command-taxonomy-proposal.md."),
  textProp("post_damage_effect_ref", "After-Damage Step",
    "effect_label run once per damage event. One of the three fire points."),
  textProp("target_sequence", "Target Sequence",
    "Comma list of targeting-row labels resolved in order."),
  textProp("picker", "Picker", "Which interactive picker this skill opens."),
  textProp("recipe", "Recipe", "Named recipe overlay applied to the action."),
  textProp("recipe_resource", "Recipe: Resource", ""),
  textProp("recipe_amount", "Recipe: Amount", "Formula."),
  textProp("recipe_target", "Recipe: Target", ""),
  textProp("undying_zp_cost", "Undying: ZP Cost", ""),
  textProp("undying_restore_decay", "Undying: Restore Decay", "Multiplier, e.g. 0.7."),
  checkProp("menu_hidden", "Hidden From Menu", "Do not offer this in the action menu."),
  checkProp("has_pierce", "Has Pierce", ""),
  checkProp("has_roulette", "Has Roulette", ""),
]);

/** The tab node the sync creates when it is missing. */
function managedTab() {
  return {
    key: MANAGED_TAB_KEY,
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: "0",
    editRole: 0,
    permission: "0",
    tooltip: "Engine fields — declared so they are not deleted on reload. Managed automatically.",
    visibilityFormula: "",
    type: "tab",
    contents: [],
    name: "⚙",
  };
}

/**
 * Ensure every managed prop has a field on this template's body.
 *
 * PURE — takes and returns plain data, so the whole of it is testable in Node.
 * The boot step around it only reads and writes documents.
 *
 * It owns exactly one tab and never looks anywhere else, with one exception: a
 * key already declared SOMEWHERE in the template is left alone, because
 * declaring it twice would give the sheet two controls writing one prop.
 *
 * Returns `{ changed, added, adopted }`. Steady state is `changed: false` and
 * therefore zero writes, so it is safe to run on every boot.
 */
export function ensureManagedProps(body, props = MANAGED_PROPS) {
  if (!body || typeof body !== "object") return { changed: false, added: [], adopted: [] };

  // Every key the template already declares, anywhere.
  const declared = new Set();
  let managedTabNode = null;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.key === MANAGED_TAB_KEY && node.type === "tab") managedTabNode = node;
    // A radioButton writes its `group`, not its `key` (RadioButton.js:45).
    const propKey = node.type === "radioButton" ? (node.group ?? node.key) : node.key;
    if (node.type && propKey) declared.add(propKey);
    for (const c of node.contents || []) walk(c);
    for (const c of node.rowLayout || []) walk(c);
  };
  walk(body);

  const missing = props.filter((p) => !declared.has(p.key));
  // Keys this sync would have added but something else already declares. Worth
  // naming rather than silently skipping: it means the registry and the
  // template disagree about who owns the field.
  const adopted = props.filter((p) => declared.has(p.key) && !insideManagedTab(managedTabNode, p.key))
    .map((p) => p.key);
  if (!missing.length) return { changed: false, added: [], adopted };

  if (!managedTabNode) {
    // The tab lives inside the body's first tabbedPanel, which is where this
    // template keeps its tabs. With no tabbedPanel there is nowhere sensible to
    // put it, and inventing a layout is worse than doing nothing.
    const host = findTabbedPanel(body);
    if (!host) return { changed: false, added: [], adopted, reason: "no tabbedPanel to host the managed tab" };
    managedTabNode = managedTab();
    host.contents = host.contents || [];
    host.contents.push(managedTabNode);
  }
  managedTabNode.contents = managedTabNode.contents || [];
  for (const p of missing) managedTabNode.contents.push({ ...p });

  return { changed: true, added: missing.map((p) => p.key), adopted };
}

function insideManagedTab(tabNode, key) {
  if (!tabNode) return false;
  return (tabNode.contents || []).some((c) => c && c.key === key);
}

function findTabbedPanel(node, depth = 0) {
  if (depth > 18 || !node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const c of node) { const r = findTabbedPanel(c, depth + 1); if (r) return r; }
    return null;
  }
  if (node.type === "tabbedPanel" && Array.isArray(node.contents)) return node;
  for (const c of node.contents || []) { const r = findTabbedPanel(c, depth + 1); if (r) return r; }
  return null;
}
