/**
 * Migration: 2026-11-27-condition-sleep-stunned-fields
 * ---------------------------------------------------------------------------
 * Sleep and Stunned get resistance fields like every other status:
 * `condition_sleep` and `condition_stunned` on the active PC / NPC actor templates
 * ("NA" / "RS" / "IM", read by shared/condition-affinity.js, the party Status page's
 * Resistance tab and the encyclopedia). User call 2026-11-27.
 *
 * Each new field is a copy of the template's own `condition_anomaly` node (so it
 * keeps whatever shape that template uses today: a label since
 * 2026-06-03-condition-fields-label-type), placed right after it in the same panel.
 *
 * Masters only. Actors pick the field up on their next template reload; until then
 * a value can still be granted by an Active Effect (OVERRIDE condition_sleep "IM"),
 * which the engine and both lists already read. No mass reload here: reloadTemplate
 * prunes undeclared props, so it is not something to run on every actor unasked.
 *
 * Needs a page reload (F5) before the sheet shows the new fields (CSB caches the
 * parsed tree per session). IDEMPOTENT.
 */

export const key = "2026-11-27-condition-sleep-stunned-fields";
export const description =
  "Actor templates: add condition_sleep + condition_stunned resistance fields next to condition_anomaly.";

const TEMPLATE_IDS = [
  "OmwL5UqoVwjshkJo",  // _FabU Char Template v3.fire (PC, active)
  "N6ahjuHb0FjN5Y0Q",  // _FabU Char Template v3.fire (Copy)
  "yegF6R8aaymhrvCg",  // _Fabula NPC template v.2
  "PV7MpTp8eVrAlW3O",  // _Fabula NPC template v.2 (Copy)
];
const ANCHOR = "condition_anomaly";
const NEW = [
  { key: "condition_sleep", label: "Sleep" },
  { key: "condition_stunned", label: "Stunned" },
];

function hasKey(node, want, depth = 0) {
  if (!node || typeof node !== "object" || depth > 24) return false;
  if (node.key === want) return true;
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) { for (const c of v) if (hasKey(c, want, depth + 1)) return true; }
    else if (v && typeof v === "object" && hasKey(v, want, depth + 1)) return true;
  }
  return false;
}

// The node whose `contents` holds the anchor field.
function findParent(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 24) return null;
  if (Array.isArray(node.contents) && node.contents.some((c) => c?.key === ANCHOR)) return node;
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) { for (const c of v) { const r = findParent(c, depth + 1); if (r) return r; } }
    else if (v && typeof v === "object") { const r = findParent(v, depth + 1); if (r) return r; }
  }
  return null;
}

async function patchTemplate(t, log) {
  const sys = foundry.utils.duplicate(t.system);
  const roots = [sys.body, sys.header].filter(Boolean);
  const missing = NEW.filter((f) => !roots.some((r) => hasKey(r, f.key)));
  if (!missing.length) { log(`  ${t.name}: already has both fields`); return 0; }
  let parent = null;
  for (const r of roots) { parent = findParent(r); if (parent) break; }
  if (!parent) { log(`  ${t.name}: no ${ANCHOR} field, skipped`); return 0; }
  const anchor = parent.contents.find((c) => c?.key === ANCHOR);
  let at = parent.contents.indexOf(anchor) + 1;
  for (const f of missing) {
    const node = foundry.utils.duplicate(anchor);
    node.key = f.key;
    node.label = f.label;
    node.tooltip = "";
    parent.contents.splice(at++, 0, node);
  }
  await t.update({ "system.body": sys.body, "system.header": sys.header });
  log(`  ${t.name}: added ${missing.map((f) => f.key).join(", ")}`);
  return missing.length;
}

export async function migrate(game, log = () => {}) {
  let fields = 0, touched = 0;
  for (const id of TEMPLATE_IDS) {
    const t = game.actors?.get?.(id);
    if (!t) { log(`no template at id ${id}, skipped`); continue; }
    try {
      const n = await patchTemplate(t, log);
      if (n) { fields += n; touched++; }
    } catch (e) { log(`  ${t.name}: patch threw ${e?.message ?? e}`); }
  }
  return { applied: true, summary: `${fields} field(s) added across ${touched}/${TEMPLATE_IDS.length} template(s)` };
}
