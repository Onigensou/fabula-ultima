/**
 * Migration: 2026-05-29-template-options-modify-damage-taken
 * ---------------------------------------------------------------------------
 * Template surgery: adds `modify_damage_taken` to the `_Skill Template`'s
 * `effect_kind` select-column options.
 *
 * Why: engine-canon-lint (Gap 2 from canon hardening) surfaces this as
 * ENGINE_KIND_UNEXPOSED — Mercy uses `modify_damage_taken` (out-of-band
 * dispatch from the damage-application path), but the CSB sheet has no
 * way for an author to select it. Future skills that want damage-time
 * clamping / multiplier / floor logic need to author the value via the
 * sheet, not just Item.create migrations.
 *
 * Note: `modify_damage_taken` is NOT in the central `applyEffectRow`
 * switch — it's dispatched from `resolveDamageReactions` (skill-effects.js
 * line ~191). Authors selecting this kind should understand they're
 * targeting that side-pipeline. The doc-comment in the dropdown's tooltip
 * + skill-authoring-canon.md cover this.
 *
 * Force-refreshes Mercy items (master + BD-rooted actor copies) so they
 * pick up the new template option. BD-scoped — never touches legacy
 * NPC items outside the Battle Director folder tree.
 *
 * IDEMPOTENT: re-runs no-op when the option array already contains it.
 */

export const key = "2026-05-29-template-options-modify-damage-taken";
export const description =
  "Add `modify_damage_taken` to effect_kind options in the _Skill Template " +
  "so authors can select it from the CSB sheet. Refresh Mercy items.";

const TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";
const BD_ROOT_NAME = "Battle Director";

const NEW_EFFECT_KIND_OPTION = {
  key: "modify_damage_taken",
  value: "Modify Damage Taken (side-pipeline)",
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
  for (const node of findOptionNodes(sysClone, "effect_kind")) {
    if (ensureOption(node.options, NEW_EFFECT_KIND_OPTION)) added += 1;
  }

  if (added === 0) {
    log(`Template already has modify_damage_taken option — no changes.`);
    return { applied: true, summary: "already canon" };
  }

  try {
    await tmpl.update({ system: sysClone });
    log(`_Skill Template: added ${added} option(s).`);
  } catch (e) {
    log(`_Skill Template update failed: ${e?.message ?? e}`);
    return { applied: false, summary: `template update failed: ${e?.message ?? e}` };
  }

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
    if (item.name !== "Mercy") continue;
    if (!isInBattleDirectorTree(item)) continue;
    const r = await refresh.refreshOne(item);
    if (r?.ok) { refreshed += 1; log(`  world / "${item.name}": refreshed`); }
    else       log(`  world / "${item.name}": refresh failed (${r?.reason})`);
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Mercy") continue;
      if (!actorCopyIsBattleDirector(item, masterIndexByUniqueId)) continue;
      const r = await refresh.refreshOne(item);
      if (r?.ok) { refreshed += 1; log(`  actor "${actor.name}" / "${item.name}": refreshed`); }
      else       log(`  actor "${actor.name}" / "${item.name}": refresh failed (${r?.reason})`);
    }
  }

  return {
    applied: true,
    summary: `added ${added} template option(s); refreshed ${refreshed} Mercy item(s)`,
  };
}
