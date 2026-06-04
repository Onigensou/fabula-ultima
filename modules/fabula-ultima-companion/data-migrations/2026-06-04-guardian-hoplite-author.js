/**
 * Migration: 2026-06-04-guardian-hoplite-author
 * ---------------------------------------------------------------------------
 * Author Hoplite (Atlas High Fantasy / Hybrid Heroic Skill) per Atlas HF p.159:
 *
 *   Requirements: Commander or Guardian.
 *   "As long as you have a weapon equipped in your main hand slot and a
 *    shield equipped in your off-hand slot, your attacks with that weapon
 *    deal 5 extra damage and you gain a +1 bonus to Defense."
 *
 *   Restrictions (descriptive only — engine doesn't enforce):
 *     - Cannot combine with custom weapons having the "defence boost"
 *       customization (Atlas HF p.107)
 *     - Cannot combine with Dual Shieldbearer (Core Rulebook p.197)
 *
 * BD-native design — true bearer-resident passive.
 *
 *   Skill embeds one transfer:true AE that conditionally grants:
 *     - bonus_defense += 1     when (main has weapon AND off has shield)
 *     - weapon1_damage += 5    when same condition (main-hand attacks only;
 *                              snapshot.resolveAttackerWeapon reads
 *                              weapon1_damage for main, off_mod_2 for off)
 *
 *   Conditional gate uses the new `aeSlotEquippedWhen` helper:
 *     value: 'aeSlotEquippedWhen("main:weapon&off:shield", "1")'
 *   Grammar: slot:type pairs joined by '&' (AND) or ',' (OR). Slot tokens
 *   `main`/`off`; type tokens `weapon`/`shield`/`any`. Returns trueValue
 *   when active, else falls back to actor's base value for the key.
 *
 *   Folder: `Battle Director / Hybrid Heroic Skill / Hoplite`. The Hybrid
 *   Heroic Skill folder is a sibling of the per-class folders for Heroic
 *   Skills available to multiple classes (Commander/Guardian here).
 *
 * IDEMPOTENT.
 */

export const key = "2026-06-04-guardian-hoplite-author";
export const description =
  "Author Hoplite per Atlas HF p.159: true bearer-resident passive granting " +
  "+1 Defense + 5 extra main-hand damage when wielding weapon in main + shield " +
  "in off-hand. New slot-aware AE gate `aeSlotEquippedWhen`.";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const HYBRID_HEROIC_FOLDER = "Hybrid Heroic Skill";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

// Default skill icon — Atlas HF Hoplite art isn't in the asset library;
// use a generic shield-and-spear icon that mirrors the skill's flavor
// (weapon-and-shield fighter).
const HOPLITE_DEFAULT_ICON =
  "icons/equipment/shield/heater-steel-gray.webp";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

function isInBattleDirectorTree(item) {
  let f = item?.folder;
  while (f) {
    if (f.name === BD_ROOT_NAME && !(f.folder?.id ?? f.folder)) return true;
    f = f.folder;
  }
  return false;
}

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

// Find the Hybrid Heroic Skill folder under Battle Director.
function findHybridHeroicFolder(game) {
  const bd = game.folders?.find?.((f) =>
    f.name === BD_ROOT_NAME && f.type === "Item" && !(f.folder?.id ?? f.folder));
  if (!bd) return null;
  return game.folders.find((f) =>
    f.name === HYBRID_HEROIC_FOLDER && f.type === "Item" && f.folder?.id === bd.id) ?? null;
}

// ── DATA ────────────────────────────────────────────────────────────────────

const HOPLITE_DESCRIPTION =
  "<p>As long as you have a <strong>weapon</strong> equipped in your " +
  "<strong>main hand</strong> slot and a <strong>shield</strong> equipped in your " +
  "<strong>off-hand</strong> slot, your attacks with that weapon deal " +
  "<strong>5 extra damage</strong> and you gain a <strong>+1 bonus to Defense</strong>.</p>" +
  "<p><em>This Skill cannot be combined with custom weapons with the defence boost " +
  "customization, nor with the Dual Shieldbearer Skill.</em></p>";

const PROP_PATCH = {
  skill_type:             "Passive",
  skill_target:           "-",
  skill_range:            "-",
  cost:                   "",
  isCheck:                false,
  isReaction:             false,
  isHeroic:               true,
  on_activate_effect_ref: "",
  max_level:              "1",
  description:            HOPLITE_DESCRIPTION,
  heroic_requirement:     "You must have mastered one or more Classes among Commander and Guardian.",
};

// ── EMBEDDED AE ────────────────────────────────────────────────────────────

const HOPLITE_AE_DESCRIPTION =
  "<p><em>Hoplite:</em> Wielding weapon + shield: +1 Defense, +5 main-hand damage.</p>";

// AE template — true bearer-resident passive per [[ae-template-no-transfer]].
// transfer:true so Foundry auto-derives it onto the bearer the moment the
// skill is added. No statuses[] per [[always-active-passive-no-token-icon]]
// (always-on passive, no transient state to surface on the token).
function makeHopliteAeTemplate(iconUrl) {
  return {
    name: "Hoplite",
    icon: iconUrl ?? HOPLITE_DEFAULT_ICON,
    description: HOPLITE_AE_DESCRIPTION,
    transfer: true,
    disabled: false,
    duration: {
      startTime: null, seconds: null, rounds: null, turns: null,
      startRound: null, startTurn: null, type: "none", duration: null,
    },
    statuses: [],
    changes: [
      {
        // +1 Defense when wielding weapon in main + shield in off.
        key: "bonus_defense",
        value: 'aeSlotEquippedWhen("main:weapon&off:shield", "1")',
        mode: 2,
        priority: 20,
      },
      {
        // +5 main-hand attack damage when wielding weapon in main + shield
        // in off. weapon1_damage is the main-hand damage bonus prop;
        // snapshot.resolveAttackerWeapon reads it for "main" attacks
        // (off-hand attacks read off_mod_2, so off-hand naturally
        // excluded — matching RAW "your attacks with that weapon").
        key: "weapon1_damage",
        value: 'aeSlotEquippedWhen("main:weapon&off:shield", "5")',
        mode: 2,
        priority: 20,
      },
    ],
    flags: {
      [MODULE_ID]: {
        category: "buff",
      },
    },
    system: { tags: ["buff"] },
  };
}

// ── PATCH FUNCTIONS ────────────────────────────────────────────────────────

async function ensureAeTemplate(item, name, makeFn, log, ownerLabel) {
  const want = makeFn(item.img);
  const existing = item.effects?.contents?.find((e) => e.name === name);
  if (!existing) {
    await item.createEmbeddedDocuments("ActiveEffect", [want]);
    log(`  ${ownerLabel} Hoplite: AE template "${name}" created`);
    return true;
  }
  const wantChanges  = want.changes;
  const wantStatuses = want.statuses;
  const wantFlags    = want.flags;
  const wantDesc     = want.description;
  const wantTransfer = want.transfer;
  const needs =
    !deepEqual(existing.changes ?? [], wantChanges)
    || !deepEqual(Array.from(existing.statuses ?? []), wantStatuses)
    || !deepEqual(existing.flags?.[MODULE_ID] ?? {}, wantFlags[MODULE_ID])
    || (want.icon && existing.icon !== want.icon)
    || (wantDesc && existing.description !== wantDesc)
    || existing.transfer !== wantTransfer;
  if (!needs) return false;
  await existing.update({
    transfer:    wantTransfer,
    duration:    want.duration,
    changes:     wantChanges,
    statuses:    wantStatuses,
    flags:       wantFlags,
    system:      want.system,
    ...(want.icon ? { icon: want.icon } : {}),
    ...(wantDesc ? { description: wantDesc } : {}),
  });
  log(`  ${ownerLabel} Hoplite: AE template "${name}" normalised`);
  return true;
}

async function patchHopliteItem(item, log, ownerLabel) {
  let touched = false;
  const p = item.system?.props ?? {};

  // 1. Top-level props.
  const propUpdates = {};
  for (const [k, v] of Object.entries(PROP_PATCH)) {
    if (p[k] !== v) propUpdates[`system.props.${k}`] = v;
  }
  if (Object.keys(propUpdates).length) {
    await item.update(propUpdates);
    log(`  ${ownerLabel} Hoplite: props patched (${Object.keys(propUpdates).map(k => k.replace("system.props.", "")).join(", ")})`);
    touched = true;
  }

  // 2. Clear any leftover reaction_config_table / effect_table.
  if (p.reaction_config_table && Object.keys(p.reaction_config_table).length) {
    await item.update({ "system.props.reaction_config_table": {} });
    log(`  ${ownerLabel} Hoplite: cleared reaction_config_table`);
    touched = true;
  }
  if (p.effect_table && Object.keys(p.effect_table).length) {
    await item.update({ "system.props.effect_table": {} });
    log(`  ${ownerLabel} Hoplite: cleared effect_table`);
    touched = true;
  }

  // 3. Embedded AE template.
  if (await ensureAeTemplate(item, "Hoplite", makeHopliteAeTemplate, log, ownerLabel)) touched = true;

  // 4. Sync CSB template version stamp per [[csb-template-version-sync]].
  const tpl = game.items.get(item.system?.template);
  const wantVersion = tpl?.system?.templateSystemUniqueVersion;
  if (wantVersion !== undefined
      && item.system?.templateSystemUniqueVersion !== wantVersion) {
    await item.update({ "system.templateSystemUniqueVersion": wantVersion });
    log(`  ${ownerLabel} Hoplite: templateSystemUniqueVersion → ${wantVersion}`);
    touched = true;
  }

  // 5. Force CSB template reload — the stamp set above is insufficient;
  //    the sheet's cached field schema for THIS item is only rebuilt
  //    when `templateSystem.reloadTemplate()` fires. Without it, newly-
  //    added template fields stay hidden until the manual "Refresh from
  //    Template" click. See [[csb-template-version-sync]] for the
  //    canonical pattern.
  if (touched && item.templateSystem?.reloadTemplate) {
    try {
      await item.templateSystem.reloadTemplate();
      log(`  ${ownerLabel} Hoplite: CSB templateSystem.reloadTemplate() fired`);
    } catch (e) {
      log(`  ${ownerLabel} Hoplite: reloadTemplate threw — ${e?.message ?? e}`);
    }
  }

  return touched;
}

export async function migrate(game, log) {
  // Locate or create the master in Battle Director / Hybrid Heroic Skill.
  const hybridFolder = findHybridHeroicFolder(game);
  if (!hybridFolder) {
    log(`  ERROR: no "${HYBRID_HEROIC_FOLDER}" folder found under "${BD_ROOT_NAME}". Run folder-bootstrap first.`);
    return { applied: false, summary: `Hoplite: missing folder "${BD_ROOT_NAME}/${HYBRID_HEROIC_FOLDER}"` };
  }

  let master = game.items?.contents?.find?.((i) =>
    i.name === "Hoplite"
    && i.folder?.id === hybridFolder.id
    && templateMatches(i));

  if (!master) {
    // Create the master with the CSB skill-template stamp + the
    // canonical folder placement. Stamp templateSystemUniqueVersion
    // AT CREATION TIME (not after) so the sheet doesn't render against
    // a stale template body during the window between create and the
    // post-create version-sync step. See [[csb-template-version-sync]].
    const tpl = game.items.get(SKILL_TEMPLATE_ID);
    const versionStamp = tpl?.system?.templateSystemUniqueVersion;
    const created = await Item.create({
      name: "Hoplite",
      type: "equippableItem",
      img: HOPLITE_DEFAULT_ICON,
      folder: hybridFolder.id,
      system: {
        template: SKILL_TEMPLATE_ID,
        ...(versionStamp !== undefined ? { templateSystemUniqueVersion: versionStamp } : {}),
        props: { skill_type: "Passive", isHeroic: true, level: 1, max_level: 1 },
      },
    });
    master = created;
    log(`  Hoplite: master created in ${BD_ROOT_NAME}/${HYBRID_HEROIC_FOLDER}` +
        (versionStamp !== undefined ? ` (stamp ${versionStamp})` : " (no template stamp)"));
  }

  let masters = 0;
  let copies = 0;
  if (await patchHopliteItem(master, log, "master")) masters += 1;

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Hoplite") continue;
      if (!templateMatches(item)) continue;
      if (await patchHopliteItem(item, log, `actor "${actor.name}"`)) copies += 1;
    }
  }

  return {
    applied: true,
    summary: `Hoplite authored: ${masters} master(s), ${copies} actor copy(s)`,
  };
}
