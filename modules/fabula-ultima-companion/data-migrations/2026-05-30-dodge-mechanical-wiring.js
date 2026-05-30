/**
 * Migration: 2026-05-30-dodge-mechanical-wiring
 * ---------------------------------------------------------------------------
 * Wires the BD-tree Dodge skill (Rogue / Skill) with mechanical effect via
 * the **always-on passive AE pattern** (transfer:true on the item's AE).
 *
 * RAW: "As long as you have no shields and no martial armor equipped,
 *       your Defense score is increased by 【SL】."
 *
 * Mechanics chosen — true-passive AE pattern (user-canonical 2026-05-30):
 *
 *   • AE lives on the skill item with `transfer: true`. When the
 *     skill item is on an actor, CSB auto-applies the AE's changes
 *     to the bearer's derived props on every sheet derive. No
 *     reaction trigger, no apply_ae effect dispatch, no per-turn
 *     refresh — it's just there.
 *   • Change: `bonus_defense` += SL (CSB column, ADD mode).
 *   • Value is BAKED at author time as a literal integer matching
 *     the skill's current SL (default "1"). CSB's AEF formula context
 *     doesn't expose `item.level` to transfer-mode AEs, so we can't
 *     read the bearing skill's level dynamically — a level-up
 *     re-bake hook is the planned follow-up (see canon doc).
 *
 * Equipment gate. RAW says the bonus applies only when no shields /
 * martial armor are equipped. The director-side `HAS_SHIELD` /
 * `HAS_MARTIAL_ARMOR` formulas don't bridge to CSB AEF, so we
 * intentionally do NOT enforce the gate at the engine level. The
 * player honours the rule by not equipping shield/armor when they
 * want the bonus — same UX as the rest of the FU equipment-gated
 * passives. Future canon iteration: extend the conditional AE gate
 * (`aeWhen` / `aeStatusWhen`) with `aeEquippedWhen("shield", ...)`.
 *
 * Idempotent — re-runs reset the AE shape via the `-=` deletion
 * sentinel so previous reaction-config-based versions of this
 * migration get cleaned out. Earlier wiring (reaction_config_table
 * row + effect_table apply_ae) is purged.
 */

const FLAG_NS = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";

export const key = "2026-05-30-dodge-mechanical-wiring";
export const description =
  "Wire BD-tree Dodge skill with always-on passive AE pattern — " +
  "transfer:true AE on item granting bonus_defense += SL. Equipment " +
  "gate is player-honour, not engine-enforced.";

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
  return master ? isInBattleDirectorTree(master) : false;
}

// Bake SL into the literal value here. Default SL 1 per the spec
// convention (`level: 1` on every new spec). When the bearer levels
// up, a planned hook will re-bake the change.value to match.
function aeTemplateForLevel(skillLevel) {
  const SL = Number(skillLevel) || 1;
  return {
    name: "Dodge",
    icon: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Rena/WindSneakerPassive3.png",
    transfer: true,
    disabled: false,
    duration: {},
    flags: {
      [FLAG_NS]: {
        // Not a director-applied AE — it's an item-transfer AE.
        // Doesn't need the directorPermanent / crossScene flags.
      },
    },
    system: { tags: ["buff"] },
    statuses: ["fud-dodge"],
    changes: [
      // CSB column is `bonus_defense` (not `bonus_def`). CSB auto-prefixes
      // bare keys to `system.props.<key>` per [[csb-ae-bare-key]]. mode 2
      // = ADD. The value is the LITERAL skill level — CSB AEF doesn't
      // expose `item.level` for transfer-mode AEs, so we bake at author
      // time and re-bake on level-up via the planned hook.
      { key: "bonus_defense", value: String(SL), mode: 2, priority: 20 },
    ],
  };
}

async function patchOne(item, log, ownerLabel) {
  let touched = false;

  // 1. Strip any stale reaction_config_table — the earlier turn_start
  //    refresh pattern lived in this table; the always-on pattern
  //    doesn't need it. Preserve any unrelated rows.
  {
    const current = item.system?.props?.reaction_config_table ?? {};
    const preserved = {};
    let idx = 0;
    for (const row of Object.values(current)) {
      if (row?.reaction_effect_ref === "dodge_apply_bonus") continue;
      preserved[String(idx++)] = row;
    }
    if (JSON.stringify(current) !== JSON.stringify(preserved)) {
      await item.update({ "system.props.-=reaction_config_table": null });
      const updates = { "system.props.reaction_config_table": preserved };
      // If no reaction rows remain after the strip, clear isReaction.
      if (Object.keys(preserved).length === 0) {
        updates["system.props.isReaction"] = false;
      }
      await item.update(updates);
      log(`  ${ownerLabel} / "${item.name}": reaction_config_table stripped`);
      touched = true;
    }
  }

  // 2. Strip any stale effect_table — same reasoning.
  {
    const current = item.system?.props?.effect_table ?? {};
    const ownedLabels = new Set(["dodge_apply_bonus", "dodge_target_self"]);
    const preserved = {};
    let idx = 0;
    for (const row of Object.values(current)) {
      if (ownedLabels.has(String(row?.effect_label ?? ""))) continue;
      preserved[String(idx++)] = row;
    }
    if (JSON.stringify(current) !== JSON.stringify(preserved)) {
      await item.update({ "system.props.-=effect_table": null });
      await item.update({ "system.props.effect_table": preserved });
      log(`  ${ownerLabel} / "${item.name}": effect_table stripped`);
      touched = true;
    }
  }

  // 3. Embedded AE template — self-heal: ensure exactly one "Dodge"
  //    AE exists with the always-on shape (transfer:true, no duration,
  //    correct value bake).
  const skillLevel = Number(item.system?.props?.level ?? 1) || 1;
  const wantAE = aeTemplateForLevel(skillLevel);
  const existing = item.effects?.contents?.find((e) => e.name === "Dodge");
  if (!existing) {
    await item.createEmbeddedDocuments("ActiveEffect", [wantAE]);
    log(`  ${ownerLabel} / "${item.name}": added Dodge AE template (SL=${skillLevel})`);
    touched = true;
  } else {
    const needsFix =
      existing.transfer !== true
      || (existing.duration?.turns ?? null) !== null
      || (existing.duration?.rounds ?? null) !== null
      || !(existing.changes ?? []).some((c) => c?.key === "bonus_defense" && String(c?.value) === String(skillLevel))
      || (existing.changes ?? []).some((c) => c?.key === "bonus_def")
      || (existing.changes ?? []).some((c) => c?.key === "bonus_defense" && String(c?.value).trim().toUpperCase() === "SL");
    if (needsFix) {
      await existing.update({
        transfer: true,
        duration: { turns: null, rounds: null, seconds: null, type: "none" },
        changes: wantAE.changes,
        statuses: wantAE.statuses,
        system: wantAE.system,
      });
      log(`  ${ownerLabel} / "${item.name}": Dodge AE normalised to transfer-mode (SL=${skillLevel})`);
      touched = true;
    }
  }

  return touched;
}

export async function migrate(game, log) {
  const masterIndexByUniqueId = new Map();
  for (const item of game.items?.contents ?? []) {
    const uid = String(item?.system?.uniqueId ?? "").trim();
    if (uid && !masterIndexByUniqueId.has(uid)) masterIndexByUniqueId.set(uid, item);
  }

  let masters = 0;
  let copies = 0;
  let skipped = 0;
  let nonBd = 0;

  for (const item of game.items?.contents ?? []) {
    if (item.name !== "Dodge") continue;
    if (!isInBattleDirectorTree(item)) { nonBd += 1; continue; }
    const touched = await patchOne(item, log, "world");
    if (touched) masters += 1;
    else skipped += 1;
  }

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Dodge") continue;
      if (!actorCopyIsBattleDirector(item, masterIndexByUniqueId)) { nonBd += 1; continue; }
      const touched = await patchOne(item, log, `actor "${actor.name}"`);
      if (touched) copies += 1;
      else skipped += 1;
    }
  }

  return {
    applied: true,
    summary:
      `wired ${masters} master(s) + ${copies} actor copy(s); ` +
      `already-wired: ${skipped}; non-BD skipped: ${nonBd}`,
  };
}
