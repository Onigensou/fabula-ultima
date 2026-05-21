/**
 * Migration: 2026-05-21-actor-template-formula-repair
 * ---------------------------------------------------------------------------
 * Undoes a regression introduced by [[2026-05-21-actor-template-bonus-hp-mp]].
 *
 * That migration patched every _template actor's max_hp / max_mp Label
 * formulas to append `+ref('bonus_hp')` / `+ref('bonus_mp')`. On templates
 * whose original formula was a placeholder `${()}$` (NPC / villain templates
 * that don't compute max_hp from a formula and instead read a stored field),
 * the append produced `${()+ref('bonus_hp')}$` — a malformed expression that
 * evaluates to `bonus_hp` alone (typically 0), which is wrong.
 *
 * This repair narrowly rewinds those two exact patterns back to `${()}$`.
 * Templates whose formulas reference other meaningful props (skill_hp,
 * mig_base, level, etc.) are untouched.
 *
 * The bug also exists in the v1 migration itself; that migration has been
 * hardened in the same commit to skip empty/placeholder formulas, so fresh
 * installs won't take the damage. This repair only matters for worlds
 * that already ran v1.
 *
 * IDEMPOTENT — gated on the exact broken pattern.
 *
 * SCOPE: every actor of type "_template".
 */

export const key = "2026-05-21-actor-template-formula-repair";
export const description =
  "Repair max_hp/max_mp formulas on _template actors that were damaged " +
  "by 2026-05-21-actor-template-bonus-hp-mp (rewinds " +
  "${()+ref('bonus_hp')}$ back to ${()}$).";

const REPAIRS = [
  {
    propKey: "bonus_hp",
    broken: "${()+ref('bonus_hp')}$",
    restore: "${()}$"
  },
  {
    propKey: "bonus_mp",
    broken: "${()+ref('bonus_mp')}$",
    restore: "${()}$"
  }
];

function findNodeMutable(root, want, seen = new WeakSet()) {
  if (!root || typeof root !== "object") return null;
  if (seen.has(root)) return null;
  seen.add(root);
  if (root.key === want) return root;
  if (Array.isArray(root)) {
    for (const v of root) { const hit = findNodeMutable(v, want, seen); if (hit) return hit; }
    return null;
  }
  for (const k of Object.keys(root)) {
    if (k === "_id" || k === "permission" || k === "flags" || k === "ownership") continue;
    const hit = findNodeMutable(root[k], want, seen);
    if (hit) return hit;
  }
  return null;
}

async function repairTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);
  let changed = false;

  for (const { propKey, broken, restore } of REPAIRS) {
    const maxKey = propKey === "bonus_hp" ? "max_hp" : "max_mp";
    const node = findNodeMutable(sysClone.header, maxKey)
              ?? findNodeMutable(sysClone.body,   maxKey);
    if (!node) continue;
    if (String(node.value ?? "").trim() === broken) {
      node.value = restore;
      log(`  • repaired ${maxKey} on "${template.name}" (reverted to ${restore})`);
      changed = true;
    }
  }

  if (!changed) return false;
  await template.update({ system: sysClone });
  return true;
}

export async function migrate(game, log) {
  const templates = (game.actors?.contents ?? []).filter(a => a.type === "_template");
  let touched = 0;
  for (const t of templates) {
    try { if (await repairTemplate(t, log)) touched++; }
    catch (e) { log(`  • repair on "${t.name}" threw: ${e?.message ?? e}`); }
  }
  return {
    applied: true,
    summary: `${touched} template${touched === 1 ? "" : "s"} repaired`
  };
}
