/**
 * Migration: 2026-05-30-template-options-force-mode
 * ---------------------------------------------------------------------------
 * Template surgery: adds `force` as a fourth option to the
 * `passive_mode` and `reaction_passive_mode` select columns in the
 * `_Skill Template`.
 *
 * Why: passive_mode grows from `on | ask | off` → `on | ask | off | force`
 * per [[force-mode-for-engine-mandatory-reactions]]. The engine accepts
 * "force" everywhere it accepts the other modes, but authors need a
 * fourth dropdown entry to actually select it from the CSB sheet (skill
 * canon Rule 5: writes to system.props.X are silently stripped if X
 * isn't a template column / option). Future authoring: Protect's charge-
 * refresh row at conflict_start / turn_start gets `reaction_passive_mode
 * = "force"`.
 *
 * Idempotent: re-runs no-op when the options arrays already contain
 * `force`.
 */

export const key = "2026-05-30-template-options-force-mode";
export const description =
  "Add `force` to the passive_mode and reaction_passive_mode select " +
  "options in the _Skill Template so authors can pick it from the CSB sheet.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const PASSIVE_MODE_FORCE_OPTION = {
  key: "force",
  value: "force — engine-mandatory (hidden in UI)",
};

const REACTION_PASSIVE_MODE_FORCE_OPTION = {
  key: "force",
  value: "Force — engine-mandatory (hidden)",
};

function findOptionNodes(node, columnKey, out = [], depth = 0) {
  if (depth > 14 || !node || typeof node !== "object") return out;
  if (node.key === columnKey && Array.isArray(node.options)) out.push(node);
  if (Array.isArray(node)) {
    for (const v of node) findOptionNodes(v, columnKey, out, depth + 1);
  } else {
    for (const k of Object.keys(node)) findOptionNodes(node[k], columnKey, out, depth + 1);
  }
  return out;
}

function ensureOption(optionsArr, newOpt) {
  if (optionsArr.some((o) => o?.key === newOpt.key)) return false;
  optionsArr.push(newOpt);
  return true;
}

export async function migrate(game, log) {
  const tmpl = game.items.get(TEMPLATE_ID);
  if (!tmpl) {
    log(`_Skill Template "${TEMPLATE_ID}" not found — nothing to do.`);
    return { applied: true, summary: "no template" };
  }

  const sysClone = foundry.utils.deepClone(tmpl.toObject(false).system ?? {});

  let added = 0;
  for (const node of findOptionNodes(sysClone, "passive_mode")) {
    if (ensureOption(node.options, PASSIVE_MODE_FORCE_OPTION)) {
      added += 1;
      log(`  passive_mode column: added "force" option`);
    }
  }
  for (const node of findOptionNodes(sysClone, "reaction_passive_mode")) {
    if (ensureOption(node.options, REACTION_PASSIVE_MODE_FORCE_OPTION)) {
      added += 1;
      log(`  reaction_passive_mode column: added "force" option`);
    }
  }

  if (added === 0) {
    log(`Template already has "force" option on both columns — no changes.`);
    return { applied: true, summary: "already canon" };
  }

  try {
    await tmpl.update({ system: sysClone });
    log(`_Skill Template: added ${added} option(s).`);
  } catch (e) {
    log(`_Skill Template update failed: ${e?.message ?? e}`);
    return { applied: false, summary: `template update failed: ${e?.message ?? e}` };
  }

  // No per-item refresh — the option list change doesn't affect any
  // existing item's stored value. Future items authoring `force` mode
  // get the option as soon as this migration applies.
  return {
    applied: true,
    summary: `added ${added} dropdown option(s)`,
  };
}
