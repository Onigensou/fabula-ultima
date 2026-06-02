/**
 * Migration: 2026-05-29-template-options-caster-short-on-mp
 * ---------------------------------------------------------------------------
 * Template surgery: adds two new options to the `_Skill Template`'s
 * select columns so the canonical reaction config can author them:
 *
 *   reaction_trigger options → add `caster_short_on_mp`
 *   effect_kind options       → add `substitute_cost`
 *
 * Without this, CSB silently strips unknown enum values written to
 * those columns (sheet sanitization), so the Vismagus migration's
 * authored reaction row + effect row would land as empty / defaulted.
 *
 * After the template change, every existing Vismagus item is force-
 * refreshed via `FUCompanion.api.itemRefresh.refreshOne(item)` so the
 * item picks up the new option list before the Vismagus migration runs.
 * BD-scoped — only refreshes Vismagus items inside the BD folder tree.
 *
 * Dependency: `2026-05-29-vismagus-reaction-config` runs AFTER this
 * migration. The manifest order is the source of truth (this one is
 * listed earlier).
 *
 * IDEMPOTENT: re-runs no-op when the options array already contains
 * the values.
 */

export const key = "2026-05-29-template-options-caster-short-on-mp";
export const description =
  "Add `caster_short_on_mp` to reaction_trigger options + `substitute_cost` " +
  "to effect_kind options in the _Skill Template. Force-refresh Vismagus " +
  "items so they accept the new values.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const BD_ROOT_NAME = "Battle Director";

const NEW_TRIGGER_OPTION = {
  key: "caster_short_on_mp",
  value: "Caster Short on MP",
};
const NEW_EFFECT_KIND_OPTION = {
  key: "substitute_cost",
  value: "Substitute Cost (mp ↔ hp)",
};

function isInBattleDirectorTree(item) {
  let f = item?.folder;
  while (f) {
    if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) return true;
    f = f.folder;
  }
  return false;
}

function actorCopyIsBattleDirector(item, masterIndexByUniqueId) {
  const uid = String(item?.system?.uniqueId ?? "").trim();
  if (!uid) return false;
  const master = masterIndexByUniqueId.get(uid);
  if (!master) return false;
  return isInBattleDirectorTree(master);
}

// Recursive walk: find every node whose `.key` matches `columnKey` and
// which has an `options` array (CSB select-column shape). Returns the
// nodes by reference so we can mutate in place.
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

  // 1. Deep-clone the template body so mutations don't touch the live doc
  //    until we write back. Then add the two new options.
  const sysClone = foundry.utils.deepClone(tmpl.toObject(false).system ?? {});

  let added = 0;
  for (const node of findOptionNodes(sysClone, "reaction_trigger")) {
    if (ensureOption(node.options, NEW_TRIGGER_OPTION)) added += 1;
  }
  for (const node of findOptionNodes(sysClone, "effect_kind")) {
    if (ensureOption(node.options, NEW_EFFECT_KIND_OPTION)) added += 1;
  }

  if (added === 0) {
    log(`Template already has both options — no changes.`);
    return { applied: true, summary: "already canon" };
  }

  try {
    await tmpl.update({ system: sysClone });
    log(`_Skill Template: added ${added} option(s).`);
  } catch (e) {
    log(`_Skill Template update failed: ${e?.message ?? e}`);
    return { applied: false, summary: `template update failed: ${e?.message ?? e}` };
  }

  // 2. Refresh every Vismagus item (master + BD-rooted actor copies) so
  //    they pick up the new options. itemRefresh handles the CSB-side
  //    template re-pull.
  const refresh = globalThis.FUCompanion?.api?.itemRefresh;
  if (!refresh?.refreshOne) {
    log(`itemRefresh API not available — refresh step skipped.`);
    return { applied: true, summary: `added ${added} options; refresh skipped (no API)` };
  }

  const masterIndexByUniqueId = new Map();
  for (const item of game.items?.contents ?? []) {
    const uid = String(item?.system?.uniqueId ?? "").trim();
    if (uid && !masterIndexByUniqueId.has(uid)) masterIndexByUniqueId.set(uid, item);
  }

  let refreshed = 0;
  for (const item of game.items?.contents ?? []) {
    if (item.name !== "Vismagus") continue;
    if (!isInBattleDirectorTree(item)) continue;
    const r = await refresh.refreshOne(item);
    if (r?.ok) { refreshed += 1; log(`  world / "${item.name}": refreshed`); }
    else       log(`  world / "${item.name}": refresh failed (${r?.reason})`);
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Vismagus") continue;
      if (!actorCopyIsBattleDirector(item, masterIndexByUniqueId)) continue;
      const r = await refresh.refreshOne(item);
      if (r?.ok) { refreshed += 1; log(`  actor "${actor.name}" / "${item.name}": refreshed`); }
      else       log(`  actor "${actor.name}" / "${item.name}": refresh failed (${r?.reason})`);
    }
  }

  return {
    applied: true,
    summary: `added ${added} template option(s); refreshed ${refreshed} Vismagus item(s)`,
  };
}
