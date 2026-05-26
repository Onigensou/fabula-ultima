/**
 * Migration: 2026-05-27-skill-template-passive-mode
 * ---------------------------------------------------------------------------
 * Swaps the `passive_optional` checkbox column for a `passive_mode` select
 * dropdown (on / ask / off) on the _Skill Template, and converts every
 * existing skill's `passive_optional: true|false` into the matching
 * `passive_mode: "ask"|"on"` value.
 *
 * Why: a tri-state mode handles RAW "may" passives (ask), auto-fire
 * passives that the player wants to keep on without prompting (on),
 * and toggle-off (off) — useful when a player wants to temporarily
 * disable an intrusive passive (e.g. Vismagus auto-offering HP). The
 * boolean `passive_optional` can't express the "off" state.
 *
 * Engine behaviour:
 *   - `passive_mode === "on"`  → fires automatically when conditions match
 *   - `passive_mode === "ask"` → GM is prompted (Apply / Skip dialog)
 *   - `passive_mode === "off"` → never fires
 *   - missing → fallback: `passive_optional === false` → "on", else "ask"
 *
 * IDEMPOTENT: skips column install if `passive_mode` already declared;
 * skips per-item conversion if `passive_mode` already set on that item.
 */

export const key = "2026-05-27-skill-template-passive-mode";
export const description =
  "Replace passive_optional checkbox with passive_mode select " +
  "(on/ask/off); convert existing items' booleans to the new field.";

const SKILL_TEMPLATE_UUID = "Item.j0F5Msw5RZ8aIB3j";
const GATE_FORMULA = `equalText(skill_type, "Passive")`;

const PASSIVE_MODE_COL = Object.freeze({
  key: "passive_mode",
  colSpan: 1, rowSpan: 1,
  cssClass: "", role: 0, editRole: 0, permission: 0,
  tooltip: 'Tri-state control. "on" — auto-fires whenever conditions match (no prompt). "ask" — GM is prompted Apply/Skip before firing (default; matches RAW "may" wording). "off" — never fires (useful for temporarily disabling an intrusive passive).',
  visibilityFormula: GATE_FORMULA,
  type: "select",
  size: "full-size",
  label: "Passive Mode",
  defaultValue: "ask",
  selectedOptionType: "custom",
  options: [
    { key: "on",  value: "on — always fire" },
    { key: "ask", value: "ask — prompt GM" },
    { key: "off", value: "off — disable" },
  ],
});

function findInBody(body, key) {
  let found = null;
  const walk = (node) => {
    if (!node || typeof node !== "object" || found) return;
    if (Array.isArray(node)) { for (const c of node) walk(c); return; }
    if (node.key === key) { found = node; return; }
    for (const v of Object.values(node)) walk(v);
  };
  walk(body);
  return found;
}

function findInBodyArrayCtx(body, key) {
  let foundCol = null, foundParent = null, foundIdx = -1;
  const walk = (node, parentArr, idx) => {
    if (!node || typeof node !== "object" || foundCol) return;
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) walk(node[i], node, i); return; }
    if (node.key === key && parentArr) { foundCol = node; foundParent = parentArr; foundIdx = idx; return; }
    for (const v of Object.values(node)) walk(v, null, null);
  };
  walk(body, null, null);
  return { col: foundCol, parent: foundParent, index: foundIdx };
}

export async function migrate(game, log) {
  const tpl = await fromUuid(SKILL_TEMPLATE_UUID);
  if (!tpl) {
    log(`skill template ${SKILL_TEMPLATE_UUID} not found — skipping template patch`);
  } else {
    const body = foundry.utils.deepClone(tpl.system?.body ?? {});
    const existingMode = findInBody(body, "passive_mode");
    if (existingMode) {
      log(`passive_mode column already present`);
    } else {
      // Install the new column. Anchor: replace passive_optional's slot
      // if present (cleaner UX — same row position); else append to
      // skill_effects_panel.
      const optCtx = findInBodyArrayCtx(body, "passive_optional");
      if (optCtx.col && optCtx.parent) {
        optCtx.parent[optCtx.index] = { ...PASSIVE_MODE_COL };
        log(`replaced passive_optional column with passive_mode`);
      } else {
        const findPanel = (node) => {
          if (!node || typeof node !== "object") return null;
          if (node.type === "panel" && node.key === "skill_effects_panel") return node;
          for (const v of Object.values(node)) {
            const r = findPanel(v);
            if (r) return r;
          }
          return null;
        };
        const panel = findPanel(body);
        if (!panel || !Array.isArray(panel.contents)) {
          log(`skill_effects_panel anchor missing — bailing without template change`);
        } else {
          panel.contents.push({ ...PASSIVE_MODE_COL });
          log(`appended passive_mode column to skill_effects_panel`);
        }
      }
      await tpl.update({ "system.body": body });
    }
  }

  // Convert existing items' passive_optional → passive_mode. Walk world
  // items + every actor's items. Idempotent: skip items that already
  // carry a passive_mode value.
  let converted = 0;
  for (const it of game.items?.contents ?? []) {
    converted += await convertItemPassiveMode(it, "world", log);
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const it of actor.items?.contents ?? []) {
      converted += await convertItemPassiveMode(it, `actor:${actor.name}`, log);
    }
  }
  return { applied: true, summary: `converted ${converted} item(s)` };
}

async function convertItemPassiveMode(item, where, log) {
  const p = item.system?.props ?? {};
  if (String(p.skill_type ?? "").toLowerCase() !== "passive") return 0;
  if (typeof p.passive_mode === "string" && p.passive_mode.length) return 0;
  let mode;
  if (p.passive_optional === false) mode = "on";
  else if (p.passive_optional === true) mode = "ask";
  else return 0;  // wasn't set either way — leave alone (engine default is "ask")
  try {
    await item.update({ "system.props.passive_mode": mode });
    log(`  ${where}: "${item.name}" → passive_mode="${mode}"`);
    return 1;
  } catch (e) {
    log(`  ${where}: "${item.name}" update threw: ${e?.message ?? e}`);
    return 0;
  }
}
