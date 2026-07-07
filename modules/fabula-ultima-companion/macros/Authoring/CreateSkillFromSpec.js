// ──────────────────────────────────────────────────────────
//  CreateSkillFromSpec — author a skill Item from a JSON spec
//  Foundry V12 — GM only.
// ──────────────────────────────────────────────────────────
//
// Creates a new `equippableItem` linked to the `_Skill Template`
// (a `_equippableItemTemplate`), then writes spec.props on top of the
// template's default props.
//
// Why the template (not another skill): cloning an existing skill
// carries its content forward — reaction_config rows, embedded AEs,
// custom_logic scripts, prop values you don't want. The structural
// template (`_Skill Template`, Item.j0F5Msw5RZ8aIB3j by default) has
// only the schema; the new skill starts clean.
//
// Schema reference:
//   modules/fabula-ultima-companion/docs/action-payload-shape.md
//     — every `system.props.*` field a skill exposes to the action
//       pipeline ("dataCore" section).
//   modules/fabula-ultima-companion/docs/reaction-config-schema.md
//     — `reaction_config_table` and `reaction_effect_table` row schemas.
//
// Spec shape (passed as PAYLOAD.spec when headless, or pasted JSON when
// invoked interactively):
//
//   {
//     name: "Soulshield",                       // required
//     img:  "icons/svg/aura.svg",               // optional
//
//     templateUuid: "Item.j0F5Msw5RZ8aIB3j",    // optional — defaults to
//                                               //   _Skill Template. Override
//                                               //   only if you have a custom
//                                               //   _equippableItemTemplate.
//
//     folder: "FXvx1GCGhUWCMScV",               // optional — items folder id
//                                               //   (back-compat). If `class`
//                                               //   is set, this is read as a
//                                               //   sub-folder NAME under the
//                                               //   Battle Director tree
//                                               //   instead (see below).
//     class: "Arcanist",                        // optional — when set, the
//                                               //   item lands in
//                                               //   `Battle Director / <class>
//                                               //    / <folder>` (defaults to
//                                               //   "Skill" if folder absent).
//                                               //   Valid folder names per
//                                               //   class: "Skill" /
//                                               //   "Spell" / "Heroic Skill"
//                                               //   (+ "Arcana" for Arcanist).
//                                               //   Convention: skills that
//                                               //   are MAGIC SPELLS (skill_type
//                                               //   = "Spell") go in "Spell";
//                                               //   active + passive non-spell
//                                               //   skills go in "Skill". Run
//                                               //   the folder scaffold once
//                                               //   per world to create the
//                                               //   tree.
//     actorUuid: null,                          // optional — if set, the new
//                                               //   skill is created on that
//                                               //   actor instead of in world
//                                               //   items.
//
//     uniqueId: "",                             // optional — content master
//                                               //   link. Default blank means
//                                               //   "new skill is its own
//                                               //   master" (safe).
//
//     // Anything in spec.props is written over the template defaults.
//     // Field names match what you'd see in the CSB editor.
//     props: {
//       skill_type: "Active",
//       isCheck: true,
//       rolled_atr1: "DEX",
//       rolled_atr2: "INS",
//       damage_bonus: 5,
//       type_damage: "fire",
//       cost: "10 MP",
//       skill_range: "Ranged",
//       skill_target: "One Creature",
//
//       // Reaction config (see reaction-config-schema.md).
//       reaction_config_table: {
//         "0": {
//           reaction_trigger: "creature_takes_damage",
//           reaction_source: "self",
//           reaction_effect_ref: "shield_up"
//         }
//       },
//       reaction_effect_table: {
//         "0": {
//           effect_label: "shield_up",
//           effect_kind: "grant",
//           grant_resource: "hp",
//           grant_amount: 5,
//           grant_target: "self"
//         }
//       }
//     },
//
//     // Optional: embedded Active Effects (Foundry AE document shape).
//     activeEffects: [
//       { name: "Shield Up", icon: "icons/svg/aura.svg", changes: [...] }
//     ]
//   }
//
// Returns: { ok, uuid, id, name, warnings: [...] }.

return (async () => {
  const TAG = "[CreateSkillFromSpec]";
  const DEFAULT_TEMPLATE_UUID = "Item.j0F5Msw5RZ8aIB3j"; // _Skill Template

  let AUTO = false, PAYLOAD = {};
  if (typeof __AUTO !== "undefined") { AUTO = __AUTO; PAYLOAD = __PAYLOAD ?? {}; }

  if (!game.user?.isGM) {
    ui.notifications?.warn(`${TAG} GM only.`);
    return { ok: false, reason: "gm_only" };
  }

  // ---------------- Spec acquisition ----------------
  async function promptForSpec() {
    const sample = `{
  "name": "New Skill",
  "props": {
    "skill_type": "Active",
    "type_damage": "physical"
  }
}`;
    return await new Promise((resolve) => {
      new Dialog({
        title: "Create Skill From Spec",
        content:
          `<form>
             <p><b>Paste a JSON skill spec.</b> See <code>docs/reaction-config-schema.md</code> and the macro file header for fields. Defaults to the <code>_Skill Template</code>.</p>
             <textarea name="spec" style="width:100%;height:240px;font-family:monospace;font-size:11px;">${sample}</textarea>
           </form>`,
        default: "ok",
        buttons: {
          ok: {
            label: "Create",
            callback: (html) => {
              const raw = html?.[0]?.querySelector?.("[name='spec']")?.value ?? "";
              try {
                resolve(JSON.parse(raw));
              } catch (e) {
                ui.notifications?.error(`${TAG} JSON parse failed: ${e.message}`);
                resolve(null);
              }
            }
          },
          cancel: { label: "Cancel", callback: () => resolve(null) }
        },
        close: () => resolve(null)
      }).render(true);
    });
  }

  let spec = PAYLOAD?.spec ?? null;
  if (!spec) spec = await promptForSpec();
  if (!spec) return { ok: false, reason: "no_spec" };

  // ---------------- Validation ----------------
  const warnings = [];

  if (!spec.name || typeof spec.name !== "string") {
    ui.notifications?.error(`${TAG} spec.name is required.`);
    return { ok: false, reason: "missing_name" };
  }

  // Resolve template (default to _Skill Template). Accept the legacy
  // `templateSkillUuid` key as an alias for one-session backward compat.
  const templateUuid =
    spec.templateUuid ??
    spec.templateSkillUuid ??
    PAYLOAD?.templateUuid ??
    DEFAULT_TEMPLATE_UUID;

  let templateItem;
  try {
    templateItem = await fromUuid(templateUuid);
  } catch (e) {
    ui.notifications?.error(`${TAG} fromUuid(${templateUuid}) failed: ${e.message}`);
    return { ok: false, reason: "template_resolve_failed", error: String(e?.message ?? e) };
  }
  if (!templateItem) {
    ui.notifications?.error(`${TAG} templateUuid resolved to nothing: ${templateUuid}`);
    return { ok: false, reason: "template_not_found" };
  }
  if (templateItem.documentName !== "Item") {
    ui.notifications?.error(`${TAG} templateUuid must point at an Item; got ${templateItem.documentName}.`);
    return { ok: false, reason: "template_not_an_item" };
  }
  if (templateItem.type !== "_equippableItemTemplate") {
    warnings.push(
      `templateUuid resolved to an Item of type "${templateItem.type}" — expected "_equippableItemTemplate". ` +
      `The new skill will still be created with system.template linked to this item, but if it's a regular ` +
      `skill (equippableItem), the structural template chain may behave unexpectedly. ` +
      `For a clean start, use _Skill Template (${DEFAULT_TEMPLATE_UUID}).`
    );
  }

  // Reaction-config sanity. Warn (don't block) on typos so the author
  // can catch them. The runtime accepts unknown values silently.
  // Trigger validity consults BOTH the legacy `oni.ReactionTriggers`
  // registry (for legacy-bridged triggers) AND the director-native set
  // exposed on `FUCompanion.api.directorTriggers.all` (Phase 1 of the
  // Cheap Shot integration added creature_will_deal_damage there).
  const triggerApi = globalThis["oni.ReactionTriggers"] ?? null;
  const directorTriggers = globalThis.FUCompanion?.api?.directorTriggers?.all ?? null;
  const isKnownTrigger = (key) => {
    if (directorTriggers?.has?.(key)) return true;
    if (triggerApi?.isValidKey?.(key)) return true;
    return false;
  };
  // add_damage shipped 2026-05-30 (Cheap Shot Phase 2) as a data-only
  // effect_kind consumed by the sender-side damage accumulator.
  // modify_damage_taken is its receiver-side sibling (Mercy).
  const KNOWN_EFFECT_KINDS = new Set([
    "grant", "apply_ae", "consume_charge", "redirect_target", "chain",
    "add_damage", "modify_damage_taken", "open_action_menu",
    "consume_resource", "targeting", "remove_tagged_ae", "substitute_cost",
    "adjust_charges", "adjust_damage", "roll_dice",
  ]);
  const KNOWN_SOURCE_VALUES = new Set(["self", "ally", "enemy", "neutral", "all", ""]);
  const KNOWN_RESOURCES = new Set(["hp", "mp", "ip", "zero_power", "zenit", "enmity"]);
  const KNOWN_DUP_MODES = new Set(["skip", "replace", "stack", "remove", "ask"]);

  const rcTable = spec?.props?.reaction_config_table ?? null;
  if (rcTable && typeof rcTable === "object") {
    for (const [rowKey, row] of Object.entries(rcTable)) {
      if (!row || row.$deleted) continue;
      const trigger = (row.reaction_trigger ?? "").toString().trim();
      if (trigger && !isKnownTrigger(trigger)) {
        warnings.push(`reaction_config_table.${rowKey}: unknown trigger "${trigger}"`);
      }
      const src = (row.reaction_source ?? "").toString().trim();
      if (src && !KNOWN_SOURCE_VALUES.has(src.toLowerCase())) {
        warnings.push(`reaction_config_table.${rowKey}: unknown reaction_source "${src}"`);
      }
    }
  }

  const efTable = spec?.props?.reaction_effect_table ?? null;
  if (efTable && typeof efTable === "object") {
    for (const [rowKey, row] of Object.entries(efTable)) {
      if (!row || row.$deleted) continue;
      const kind = (row.effect_kind ?? "grant").toString().trim().toLowerCase();
      if (!KNOWN_EFFECT_KINDS.has(kind)) {
        warnings.push(`reaction_effect_table.${rowKey}: unknown effect_kind "${kind}"`);
      }
      if (kind === "grant" && row.grant_resource && !KNOWN_RESOURCES.has(String(row.grant_resource).toLowerCase())) {
        warnings.push(`reaction_effect_table.${rowKey}: unknown grant_resource "${row.grant_resource}"`);
      }
      if (kind === "apply_ae" && row.ae_duplicate_mode && !KNOWN_DUP_MODES.has(String(row.ae_duplicate_mode).toLowerCase())) {
        warnings.push(`reaction_effect_table.${rowKey}: unknown ae_duplicate_mode "${row.ae_duplicate_mode}"`);
      }
    }
    if (rcTable) {
      const knownLabels = new Set(
        Object.values(efTable)
          .filter(r => r && !r.$deleted)
          .map(r => (r.effect_label ?? "").toString().trim())
          .filter(Boolean)
      );
      for (const [rowKey, row] of Object.entries(rcTable)) {
        if (!row || row.$deleted) continue;
        const ref = (row.reaction_effect_ref ?? "").toString().trim();
        if (ref && !knownLabels.has(ref)) {
          warnings.push(`reaction_config_table.${rowKey}: reaction_effect_ref "${ref}" has no matching effect_label`);
        }
      }
    }
  }

  // ── Canon-deprecation guard (BLOCK, not warn) ─────────────────────────
  //
  // The shared validator lives at
  // `modules/fabula-ultima-companion/scripts/lint/spec-canon-guard.js`
  // so migrations that author items via `Item.create({...})` can reuse
  // the same rules without bypassing them. Keep the macro and the
  // module in sync — both ultimately read from there.
  const specProps = spec?.props ?? {};
  let canonErrors = [];
  try {
    const guard = await import(
      "/modules/fabula-ultima-companion/scripts/lint/spec-canon-guard.js"
    );
    const verdict = guard.validateSpecCanon({
      props: specProps,
      activeEffects: spec?.activeEffects,
    });
    canonErrors = verdict.errors ?? [];
  } catch (e) {
    console.error(`${TAG} spec-canon-guard load failed; failing safe`, e);
    return {
      ok: false,
      reason: "canon_guard_load_failed",
      error: String(e?.message ?? e),
    };
  }
  if (canonErrors.length) {
    console.error(`${TAG} Spec rejected (canon violations):`, canonErrors);
    ui.notifications?.error(
      `${TAG} Spec rejected: ${canonErrors.length} canon violation(s). See console.`
    );
    return {
      ok: false,
      reason: "canon_violation",
      errors: canonErrors,
    };
  }

  if (warnings.length) {
    console.warn(`${TAG} Spec warnings:`, warnings);
  }

  // ---------------- Resolve parent (world items vs actor) ----------------
  let parent = null;
  if (spec.actorUuid) {
    try {
      parent = await fromUuid(spec.actorUuid);
    } catch (e) {
      ui.notifications?.error(`${TAG} actorUuid resolve failed: ${e.message}`);
      return { ok: false, reason: "actor_resolve_failed", error: String(e?.message ?? e) };
    }
    if (!parent || parent.documentName !== "Actor") {
      ui.notifications?.error(`${TAG} actorUuid must point at an Actor; got ${parent?.documentName ?? "null"}.`);
      return { ok: false, reason: "actor_not_an_actor" };
    }
  }

  // ---------------- Step 1: Create the skeleton item ----------------
  // Type "equippableItem" linked to the structural template. We do NOT
  // set system.props here — let reloadTemplate fill defaults from the
  // template, then we override with spec.props on top.
  const createData = {
    name: spec.name,
    img: spec.img ?? "icons/svg/dice-target.svg",
    type: "equippableItem",
    system: {
      template: templateItem.id,
      uniqueId: (spec.uniqueId ?? "").toString(),
      // CSB "Make item unique" flag. Battle Director skills default to
      // unique:true (a PC shouldn't carry two copies of the same skill
      // — duplicates would double-fire reactions, double-bill costs in
      // confused ways, etc.). Author can override with `spec.unique:
      // false` for cases where stacking IS intended (rare).
      unique: spec.unique ?? true
    }
  };
  // Folder resolution.
  //
  //   • `spec.class` set → resolve the canonical `💥 Skill / Class Skill /
  //     <class>` library folder (Heroic Skill / Spell mapped to their legacy
  //     sub-locations below), CREATING any missing level on demand
  //     (idempotent). Authors write `{ class: "Arcanist", folder: "Skill" }` —
  //     no ID lookup needed. The old `Battle Director / <class>` org tree was
  //     retired 2026-07-06 (folded into 💥 Skill / Class Skill).
  //
  //   • `spec.class` unset → `spec.folder` is treated as a literal
  //     folder ID (back-compat with pre-tree authoring).
  if (!parent) {
    let folderId = null;
    if (spec.class) {
      const subName = (spec.folder ?? spec.category ?? "Skill").toString();
      // Ensure each level of Battle Director / <class> / <sub> exists,
      // parent-first. Match by (name, parentId); create when absent.
      const ensureFolderPath = async (segments) => {
        let parentId = null;
        let current = null;
        for (const name of segments) {
          let f = game.folders.find(x =>
            x.type === "Item" &&
            x.name === name &&
            ((x.folder?.id ?? x.folder ?? null) === (parentId ?? null))
          );
          if (!f) {
            f = await Folder.create({ name, type: "Item", folder: parentId, sorting: "a" });
          }
          current = f;
          parentId = f?.id ?? null;
        }
        return current;
      };
      // RETIRED (2026-07-06) the "Battle Director" org tree; new skills now land
      // in the canonical "💥 Skill / Class Skill" library (single source of
      // truth). Map the sub-folder hint to the legacy tree's layout:
      //   Heroic Skill → 💥 Skill / Heroic Skill   (flat, all classes)
      //   Spell        → 💥 Skill / Class Skill / <class> / <class> Spell
      //   Skill/other  → 💥 Skill / Class Skill / <class>
      let segments;
      if (subName === "Heroic Skill") {
        segments = ["💥 Skill", "Heroic Skill"];
      } else if (subName === "Spell") {
        segments = ["💥 Skill", "Class Skill", spec.class, `${spec.class} Spell`];
      } else {
        segments = ["💥 Skill", "Class Skill", spec.class];
      }
      try {
        const leaf = await ensureFolderPath(segments);
        folderId = leaf?.id ?? null;
      } catch (e) {
        warnings.push(`${segments.join(" / ")} could not be ensured (${e?.message ?? e}); item created at world root.`);
      }
    } else if (spec.folder) {
      folderId = spec.folder;  // legacy: literal ID
    }
    if (folderId) createData.folder = folderId;
  }

  let newItem;
  try {
    newItem = await Item.create(createData, parent ? { parent } : {});
  } catch (e) {
    console.error(`${TAG} Item.create failed`, e);
    ui.notifications?.error(`${TAG} Item.create failed: ${e.message}`);
    return { ok: false, reason: "create_failed", error: String(e?.message ?? e) };
  }
  if (!newItem) {
    ui.notifications?.error(`${TAG} Item.create returned nothing.`);
    return { ok: false, reason: "create_returned_nothing" };
  }

  // ---------------- Step 2: Materialize the body via CSB ----------------
  // reloadTemplate pulls body/header/prop-schema from system.template and
  // populates default prop values. Existing props are preserved (none yet).
  const ts = newItem.templateSystem;
  if (ts?.reloadTemplate) {
    try {
      await ts.reloadTemplate();
    } catch (e) {
      warnings.push(`reloadTemplate failed — body may be empty: ${e.message}`);
      console.warn(`${TAG} reloadTemplate failed`, e);
    }
  } else {
    warnings.push("newItem.templateSystem.reloadTemplate is unavailable — body will not be populated automatically.");
  }

  // ---------------- Step 3: Apply spec.props on top ----------------
  if (spec.props && typeof spec.props === "object") {
    // Re-fetch in case reloadTemplate mutated the doc.
    const live = game.items?.get(newItem.id) ?? newItem;
    const baseProps = foundry.utils.deepClone(live.system?.props ?? {});
    const mergedProps = foundry.utils.mergeObject(baseProps, spec.props, {
      inplace: false,
      insertKeys: true,
      insertValues: true,
      overwrite: true,
      recursive: true
    });
    try {
      await newItem.update({ "system.props": mergedProps });
    } catch (e) {
      warnings.push(`spec.props update failed: ${e.message}`);
      console.error(`${TAG} props update failed`, e);
    }
  }

  // ---------------- Step 4: Embedded ActiveEffects ----------------
  if (Array.isArray(spec.activeEffects) && spec.activeEffects.length) {
    try {
      await newItem.createEmbeddedDocuments("ActiveEffect", spec.activeEffects);
    } catch (e) {
      warnings.push(`activeEffects createEmbeddedDocuments failed: ${e.message}`);
      console.error(`${TAG} embedded AE creation failed`, e);
    }
  }

  const result = {
    ok: true,
    uuid: newItem.uuid,
    id: newItem.id,
    name: newItem.name,
    warnings
  };

  console.info(`${TAG} Created skill`, {
    ...result,
    propsKeys: Object.keys(newItem.system?.props ?? {}).length,
    aeCount: newItem.effects.size,
    parent: parent ? parent.name : "(world items)"
  });

  const noteWarn = warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : "";
  ui.notifications?.info(`${TAG} Created "${newItem.name}"${noteWarn}. UUID: ${newItem.uuid}`);

  return result;
})();
