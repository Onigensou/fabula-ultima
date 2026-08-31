/**
 * Shared helper for the resolveAction-unification migrations.
 * ---------------------------------------------------------------------------
 * Creates (or idempotently updates) one of the canonical "action-skill" Items
 * that back the built-in turn actions — Guard, Hinder, Study, Equipment, Item.
 *
 * These are normal `equippableItem`s on the `_Skill Template`, exactly like any
 * Battle Director skill, EXCEPT they are universal (every creature uses the one
 * shared instance) and are resolved at runtime by a stable flag rather than by
 * being owned on an actor:
 *
 *   flags["fabula-ultima-companion"].coreAction = "guard" | "hinder" | ...
 *
 * The runtime resolver (`getCoreActionSkill` in state-handlers.js) scans
 * `game.items` for that flag, so the item works regardless of world/actor
 * inventory and needs no hard-coded UUID.
 *
 * Creation mirrors the CreateSkillFromSpec macro:
 *   Item.create(equippableItem + system.template) → reloadTemplate() (fill
 *   template default props + materialise the body) → merge spec.props →
 *   embed ActiveEffects. Then stamp the coreAction flag + place in
 *   Battle Director / Common.
 *
 * NOT a migration itself (leading underscore + absent from _manifest.json).
 * Foundry V12.
 */

import { ensureFolderPath } from "./_folder-tree.js";

export const MODULE_ID = "fabula-ultima-companion";
export const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j"; // _Skill Template

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
export const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

/** Find the existing core-action item by its stable flag (any world item). */
export function findCoreActionItem(game, coreAction) {
  return game.items?.find((it) =>
    it.type === "equippableItem" &&
    (it.flags?.[MODULE_ID]?.coreAction ?? null) === coreAction
  ) ?? null;
}

/**
 * Ensure the core-action Item exists + matches the spec. Idempotent.
 *
 * spec = {
 *   coreAction: "guard",            // the stable flag value (required)
 *   name: "Guard",                  // display name (required)
 *   img:  "...",                    // optional icon
 *   props: { ... },                 // system.props to write on top of defaults
 *   activeEffects: [ {...}, ... ],   // embedded AE templates (full AE doc shape)
 * }
 *
 * Returns { item, created, touched }.
 */
export async function ensureCoreActionSkill(game, spec, log = () => {}) {
  const { coreAction, name } = spec;
  if (!coreAction || !name) throw new Error("ensureCoreActionSkill: coreAction + name required");

  // Resolve / create the Common folder (self-healing).
  const { folder } = await ensureFolderPath(game, ["Battle Director", "Common"], { log });
  const folderId = folder?.id ?? null;

  let item = findCoreActionItem(game, coreAction);
  let created = false;
  let touched = false;

  if (!item) {
    // Also tolerate a prior run that created the item by name in Common but
    // (somehow) lost the flag — adopt it rather than duplicating.
    item = game.items?.find((it) =>
      it.type === "equippableItem" &&
      it.name === name &&
      (it.folder?.id ?? it.folder ?? null) === folderId
    ) ?? null;
  }

  if (!item) {
    item = await Item.create({
      name,
      img: spec.img ?? "icons/svg/shield.svg",
      type: "equippableItem",
      folder: folderId,
      system: { template: SKILL_TEMPLATE_ID, uniqueId: "", unique: true },
    });
    created = true;
    log(`  created Common/${name} (${item?.id})`);
    // Materialise the body + default props from the template.
    try { await item.templateSystem?.reloadTemplate?.(); }
    catch (e) { log(`  reloadTemplate failed on ${name}: ${e.message}`); }
    item = game.items?.get(item.id) ?? item;
  }

  // Folder placement (in case it drifted).
  if ((item.folder?.id ?? item.folder ?? null) !== folderId && folderId) {
    await item.update({ folder: folderId });
    touched = true;
  }

  // Stamp the coreAction flag.
  if ((item.flags?.[MODULE_ID]?.coreAction ?? null) !== coreAction) {
    await item.setFlag(MODULE_ID, "coreAction", coreAction);
    touched = true;
  }

  // Extra module flags (spec.flags). Objective options carry their scope + gate
  // here rather than in system.props: they have no column on the shared
  // `_Skill Template`, and a props key with no column can be dropped by a CSB
  // template re-stamp. Flags sit outside that machinery — the same reason
  // coreAction itself has always been one.
  if (spec.flags && typeof spec.flags === "object") {
    for (const [k, v] of Object.entries(spec.flags)) {
      if ((item.flags?.[MODULE_ID]?.[k] ?? null) === v) continue;
      await item.setFlag(MODULE_ID, k, v);
      touched = true;
      log(`  ${name}: flag ${k} = ${JSON.stringify(v)}`);
    }
  }

  // Merge spec.props on top of current props (preserve template defaults).
  if (spec.props && typeof spec.props === "object") {
    const baseProps = foundry.utils.deepClone(item.system?.props ?? {});
    const merged = foundry.utils.mergeObject(baseProps, spec.props, {
      inplace: false, insertKeys: true, insertValues: true, overwrite: true, recursive: true,
    });
    // Tables (effect_table / reaction_config_table) are replaced wholesale to
    // avoid CSB merge artefacts on removed rows — delete then set.
    const tableKeys = ["effect_table", "reaction_config_table", "reaction_effect_table"];
    if (!deepEqual(item.system?.props ?? {}, merged)) {
      for (const tk of tableKeys) {
        if (spec.props[tk] && !deepEqual(item.system?.props?.[tk] ?? {}, spec.props[tk])) {
          await item.update({ [`system.props.-=${tk}`]: null });
        }
      }
      await item.update({ "system.props": merged });
      touched = true;
      log(`  ${name}: props written`);
    }
  }

  // Embedded AE templates — create missing by name, normalise drift.
  if (Array.isArray(spec.activeEffects)) {
    for (const want of spec.activeEffects) {
      const existing = item.effects?.contents?.find((e) => e.name === want.name);
      if (!existing) {
        await item.createEmbeddedDocuments("ActiveEffect", [want]);
        touched = true;
        log(`  ${name}: AE "${want.name}" created`);
        continue;
      }
      const needs =
        !deepEqual(existing.changes ?? [], want.changes ?? [])
        || !deepEqual(Array.from(existing.statuses ?? []), want.statuses ?? [])
        || !deepEqual(existing.flags?.[MODULE_ID] ?? {}, want.flags?.[MODULE_ID] ?? {})
        || (want.icon && existing.icon !== want.icon)
        || (want.description && existing.description !== want.description)
        || existing.transfer !== (want.transfer ?? false);
      if (needs) {
        await existing.update({
          transfer: want.transfer ?? false,
          duration: want.duration ?? existing.duration,
          changes: want.changes ?? [],
          statuses: want.statuses ?? [],
          flags: want.flags ?? {},
          ...(want.system ? { system: want.system } : {}),
          ...(want.icon ? { icon: want.icon } : {}),
          ...(want.description ? { description: want.description } : {}),
        });
        touched = true;
        log(`  ${name}: AE "${want.name}" normalised`);
      }
    }
  }

  return { item: game.items?.get(item.id) ?? item, created, touched };
}
