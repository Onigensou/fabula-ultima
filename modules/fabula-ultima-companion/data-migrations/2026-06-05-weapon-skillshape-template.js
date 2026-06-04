/**
 * Migration: 2026-06-05-weapon-skillshape-template
 * ---------------------------------------------------------------------------
 * Weapons-as-skill-shaped-items (Option B), step 1 of 3 — template surgery.
 *
 * Weapons and skills are BOTH Foundry `equippableItem`s; they differ only by
 * which CSB template `system.template` points at:
 *   - weapons (+ armor/shields/accessories) → `_Item Template`  (ZoiV53VaLzeRsEps)
 *   - skills  (+ NPC attacks)               → `_Skill Template` (j0F5Msw5RZ8aIB3j)
 *
 * Weapons already carry the skill COMBAT props under the SAME names
 * (rolled_atr1/2, check_bonus, damage_bonus, type_damage), so the basic
 * attack roll already lines up. What weapons LACK — and what this migration
 * ADDS to `_Item Template` so the BD pipeline can read a weapon as an action
 * source — are the declarative-behavior columns:
 *
 *   - skill_target            (textField)  — targeting text, parsed by
 *                                            resolveActionTargets (default
 *                                            "One Enemy"; backfilled in step 2)
 *   - effect_table            (CLONED from _Skill Template) — on-hit / on-use
 *                                            BD effects (apply_ae, grant, …)
 *   - reaction_config_table   (CLONED from _Skill Template) — triggered/passive,
 *                                            AND the home for ON-HIT effects via
 *                                            a creature_deals_damage row whose
 *                                            reaction_effect_ref → an effect_table row
 *
 * NOTE: no fire-point ref columns (on_activate_effect_ref / post_damage_effect_ref).
 * The modern BD pattern for on-hit/after-damage effects is a
 * `creature_deals_damage` reaction_config_table row referencing an
 * effect_table row (target_ref: "hit_action_targets") — which weapons get for
 * free via the cloned reaction_config_table. The top-level post_damage
 * fire-point was retired from the _Skill Template (2026-05-30).
 *
 * effect_table / reaction_config_table are CLONED verbatim from the live
 * `_Skill Template` rather than hand-reconstructed, so weapon on-hit effects
 * get the EXACT same column set + editor UX as skills and stay in lockstep
 * with whatever the skill template currently defines. The cloned table nodes
 * are self-contained (their column rowLayout + dropdown formulas read the
 * item's own `system.props.effect_table`), so they work unchanged on a weapon.
 *
 * This is purely an editor-layout/column change. The DATA backfill (default
 * skill_target + converting legacy active_effect_config_table on-hit rows) is
 * the separate step-2 migration; the pipeline wiring is step 3 (code).
 *
 * CSB column gating: a write to `system.props.effect_table` is silently
 * stripped unless effect_table is a column on the item's template — hence
 * this must land BEFORE step 2 writes any rows.
 *
 * Per [[csb-template-version-sync]]: after the body changes we bump the
 * template's templateSystemUniqueVersion and stamp it onto every
 * _Item-Template-based copy (world + actor-embedded) so sheets render the
 * new columns instead of the pre-surgery shape.
 *
 * IDEMPOTENT — every add is gated on "is this key already in the body?".
 * SCOPE: `_Item Template` (ZoiV53VaLzeRsEps) body only; version stamp on
 * items whose system.template === that id.
 */

export const key = "2026-06-05-weapon-skillshape-template";
export const description =
  "Weapon template surgery: add skill_target + on_activate/post_damage refs " +
  "and clone the skill-effects + reaction-config PANELS (header + table) from " +
  "_Skill Template into _Item Template, so weapons carry + render BD " +
  "declarative on-hit behavior. Bumps template version + stamps copies.";

const ITEM_TPL = "ZoiV53VaLzeRsEps";  // _Item Template (weapons/armor/shields/…)
const SKILL_TPL = "j0F5Msw5RZ8aIB3j"; // _Skill Template (skills/NPC attacks)

// We clone the skill template's WRAPPING PANELS (header + table), not the bare
// tables — a bare compactDynamicTable renders as an unlabeled/empty collapsible
// bar on the weapon sheet (it relies on its wrapping panel for the header +
// structure). Each panel is post-processed for the weapon context.
const CLONE_PANELS = [
  // skill_effects_panel = [header, effect_table, on_activate_effect_ref].
  // Drop on_activate_effect_ref — weapons author on-hit effects as reactions,
  // not fire-point refs.
  { key: "skill_effects_panel", dropChildKeys: ["on_activate_effect_ref"], clearVis: false },
  // reaction_config_panel = [header, reaction_config_table]. Its own
  // visibilityFormula is "isReaction" (a skill-only field) — clear it so the
  // panel shows on weapons.
  { key: "reaction_config_panel", dropChildKeys: [], clearVis: true },
];

// Bare-table keys a prior version of this migration may have grafted directly
// into custom_logic_panel — removed on re-run so they don't duplicate the
// tables now living inside the cloned panels.
const STALE_BARE_TABLE_KEYS = ["effect_table", "reaction_config_table"];

// ── node helpers ─────────────────────────────────────────────────────────

// Recursive find of a body node by `key`. Survives panel reordering.
function findByKey(node, k) {
  if (!node || typeof node !== "object") return null;
  if (node.key === k) return node;
  const kids = Array.isArray(node.contents) ? node.contents : [];
  for (const child of kids) {
    const hit = findByKey(child, k);
    if (hit) return hit;
  }
  return null;
}

// A plain CSB textField component (mirrors the shape used by the
// 2026-05-17-skill-template-fire-points migration).
function textFieldComponent(spec) {
  return {
    key: spec.key,
    colSpan: 1,
    rowSpan: 1,
    cssClass: "",
    role: 0,
    editRole: 0,
    permission: 0,
    tooltip: spec.tooltip ?? "",
    visibilityFormula: spec.visibilityFormula ?? "",
    type: "textField",
    size: "full-size",
    label: spec.label ?? spec.key,
    defaultValue: spec.defaultValue ?? "",
    charList: "",
    maxLength: null,
    autocomplete: "",
  };
}

// The authored (non-cloned) columns weapons need. Just targeting text —
// every behavior column (effect_table + reaction_config_table) is cloned
// from the skill template. No fire-point ref columns: on-hit effects are
// authored as a `creature_deals_damage` reaction_config_table row whose
// reaction_effect_ref points at an effect_table row (the retired
// post_damage_effect_ref / on_activate_effect_ref fire-points aren't used).
function authoredColumns() {
  return [
    textFieldComponent({
      key: "skill_target",
      label: "Target",
      defaultValue: "One Enemy",
      tooltip:
        "Targeting text, parsed the same way skills are (resolveActionTargets). " +
        "Examples: \"One Enemy\", \"All Enemies\", \"Up to three creatures\", " +
        "\"Self\". Blank → defaults to One Enemy at action time.",
    }),
  ];
}

// Where to graft the new columns: the existing `custom_logic_panel` tab if
// present, else the top-level body panel. Returns the contents array to
// push into, or null.
function targetContents(sysBody) {
  const panel = findByKey(sysBody, "custom_logic_panel");
  if (panel && Array.isArray(panel.contents)) return panel.contents;
  // Fall back to the root body panel's contents.
  if (sysBody && Array.isArray(sysBody.contents)) return sysBody.contents;
  return null;
}

async function migrateTemplate(itemTpl, skillTpl, log) {
  const sysClone = foundry.utils.duplicate(itemTpl.system);
  const dest = targetContents(sysClone.body);
  if (!dest) {
    log("could not locate a contents[] to graft into on _Item Template — aborting");
    return { ok: false, summary: "no graft point" };
  }

  let added = 0;

  // 0. Self-heal: remove any bare tables a prior version of this migration
  //    grafted as DIRECT children of the graft panel (they render as blank
  //    collapsible bars). The real tables live inside the cloned panels below.
  for (let i = dest.length - 1; i >= 0; i--) {
    const c = dest[i];
    if (c?.type === "compactDynamicTable" && STALE_BARE_TABLE_KEYS.includes(c.key)) {
      dest.splice(i, 1);
      log(`removed stale bare table "${c.key}"`);
      added++;
    }
  }

  // 1. Clone the skill template's WRAPPING PANELS (header + table) — a bare
  //    table renders unlabeled/blank on the weapon sheet. Post-process each
  //    for the weapon context (drop skill-only children, clear skill-only
  //    visibility). Idempotent by panel key. (Column-level visibility INSIDE
  //    each table's rowLayout is left intact — it keys off each row's own
  //    effect_kind and works fine on weapons.)
  for (const spec of CLONE_PANELS) {
    if (findByKey(sysClone.body, spec.key)) continue; // already cloned
    const srcPanel = findByKey(skillTpl.system.body, spec.key);
    if (!srcPanel) {
      log(`WARN: panel "${spec.key}" not found on _Skill Template body — skipping`);
      continue;
    }
    const clone = foundry.utils.duplicate(srcPanel);
    if (spec.clearVis) clone.visibilityFormula = "";
    if (spec.dropChildKeys?.length && Array.isArray(clone.contents)) {
      clone.contents = clone.contents.filter((c) => !spec.dropChildKeys.includes(c?.key));
    }
    dest.push(clone);
    log(`cloned panel "${spec.key}" from _Skill Template`);
    added++;
  }

  // 2. Add the authored text-field columns.
  for (const col of authoredColumns()) {
    if (findByKey(sysClone.body, col.key)) continue; // idempotent
    dest.push(col);
    log(`added column "${col.key}"`);
    added++;
  }

  if (added === 0) {
    return { ok: true, summary: "template already has all weapon-skill columns", changed: false };
  }

  // 3. Bump the template version so copies re-derive against the new body.
  const oldV = Number(sysClone.templateSystemUniqueVersion ?? 0) || 0;
  sysClone.templateSystemUniqueVersion = oldV + 1;

  await itemTpl.update({ system: sysClone });
  log(`_Item Template updated (+${added} columns; version ${oldV} → ${sysClone.templateSystemUniqueVersion})`);
  return { ok: true, summary: `added ${added} column(s)`, changed: true, newVersion: sysClone.templateSystemUniqueVersion };
}

// Stamp the template's current version onto every copy that follows it, so
// CSB renders the new body. Batched per [[csb-template-version-sync]].
async function syncVersion(game, templateId, version, log) {
  let world = 0;
  const worldUpdates = [];
  for (const item of game.items?.contents ?? []) {
    if (String(item.system?.template ?? "").trim() !== templateId) continue;
    if (item.system?.templateSystemUniqueVersion === version) continue;
    worldUpdates.push({ _id: item.id, "system.templateSystemUniqueVersion": version });
  }
  if (worldUpdates.length) {
    await CONFIG.Item.documentClass.updateDocuments(worldUpdates);
    world = worldUpdates.length;
  }

  let copies = 0;
  let actors = 0;
  for (const actor of game.actors?.contents ?? []) {
    const updates = [];
    for (const item of actor.items?.contents ?? []) {
      if (String(item.system?.template ?? "").trim() !== templateId) continue;
      if (item.system?.templateSystemUniqueVersion === version) continue;
      updates.push({ _id: item.id, "system.templateSystemUniqueVersion": version });
    }
    if (updates.length) {
      await actor.updateEmbeddedDocuments("Item", updates);
      copies += updates.length;
      actors++;
    }
  }
  log(`version sync: ${world} world item(s), ${copies} actor copy(s) across ${actors} actor(s)`);
  return { world, copies, actors };
}

export async function migrate(game, log) {
  const itemTpl = game.items?.get(ITEM_TPL);
  if (!itemTpl) {
    return { applied: true, summary: `no _Item Template (${ITEM_TPL}); nothing to do` };
  }
  const skillTpl = game.items?.get(SKILL_TPL);
  if (!skillTpl) {
    return { applied: false, summary: `_Skill Template (${SKILL_TPL}) missing — cannot clone effect tables` };
  }

  const res = await migrateTemplate(itemTpl, skillTpl, log);
  if (!res.ok) return { applied: false, summary: res.summary };

  // Sync copies to the template's CURRENT stored version, re-read from the
  // live doc AFTER the update — CSB may recompute its own body-hash stamp on
  // save, so our computed oldV+1 isn't authoritative. Reading live avoids a
  // stamp mismatch that would leave copies rendering the old body.
  const version = itemTpl.system?.templateSystemUniqueVersion ?? res.newVersion;
  const sync = await syncVersion(game, ITEM_TPL, version, log);

  return {
    applied: true,
    summary: `${res.summary}; version synced to ${version} (${sync.world} world, ${sync.copies} copies/${sync.actors} actors)`,
  };
}
