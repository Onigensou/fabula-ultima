/**
 * Migration: 2026-05-30-dodge-mechanical-wiring
 * ---------------------------------------------------------------------------
 * Wires the BD-tree Dodge skill (Rogue / Skill) with mechanical effect.
 *
 * RAW: "As long as you have no shields and no martial armor equipped,
 *       your Defense score is increased by 【SL】."
 *
 * Mechanics chosen — turn_start refresh pattern (same shape as Protect's
 * charge refresh, see [[force-mode-for-engine-mandatory-reactions]]):
 *
 *   • reaction row at trigger `turn_start`, `passive_mode: "force"`,
 *     condition_formula `!HAS_SHIELD && !HAS_MARTIAL_ARMOR`.
 *   • Force mode = engine-mandatory, UI-invisible — the player doesn't
 *     see a pill or menu for this; it just fires.
 *   • Effect row dispatches `apply_ae` of a self-AE named "Dodge"
 *     carrying a `bonus_def: SL` change. SL is baked at apply-time.
 *   • AE duration: 1 turn (so it expires and refreshes each round).
 *   • Duplicate mode `replace_per_caster` keeps a single instance.
 *
 * Limitation. Gate is re-evaluated at turn_start only. Equipping a
 * shield mid-turn does NOT remove the bonus until the next turn_start.
 * For a fully continuous gate we'd need CSB AEF's native formula
 * bridge to read HAS_SHIELD / HAS_MARTIAL_ARMOR at sheet-derive time
 * — those are director-side identifiers, not exposed via
 * `fetchFromParent`. Acceptable simplification for now; iterate when
 * mid-turn re-equip becomes a real workflow.
 *
 * Idempotent — re-runs no-op when the reaction row + AE already exist
 * on the BD master AND every actor copy. Scoped to BD tree only;
 * legacy `💥 Skill / Class Skill / Rogue` Dodge untouched.
 */

const FLAG_NS = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";

export const key = "2026-05-30-dodge-mechanical-wiring";
export const description =
  "Wire BD-tree Dodge skill with turn_start force-mode reaction + " +
  "self-AE applying bonus_def: SL gated by !HAS_SHIELD && !HAS_MARTIAL_ARMOR.";

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

const REACTION_ROW = {
  reaction_trigger: "turn_start",
  // No reaction_source filter — turn_start is a standalone phase
  // trigger with no `sourceActorUuid` in the payload, so a "self"
  // filter would never match. The standalone dispatcher already
  // restricts turn_start to the acting combatant
  // (`restrictTo: currentActor`), so Dodge only fires when its bearer's
  // own turn starts.
  reaction_isPassive: true,
  reaction_passive_mode: "force",
  reaction_effect_ref: "dodge_apply_bonus",
  condition_formula: "!HAS_SHIELD && !HAS_MARTIAL_ARMOR",
};

const EFFECT_TABLE = {
  // target_ref: "self" is a reserved word — RESERVED_REFS in
  // skill-targeting.js expands it to `{ candidate_source: "self" }`
  // inline, so we don't need a separate targeting row.
  "0": {
    effect_label: "dodge_apply_bonus",
    effect_kind: "apply_ae",
    target_ref: "self",
    ae_template_ref: "Dodge",
    ae_duplicate_mode: "replace_per_caster",
  },
};

const AE_TEMPLATE = {
  name: "Dodge",
  icon: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Rena/WindSneakerPassive3.png",
  duration: { turns: 1 },
  flags: {
    [FLAG_NS]: {
      directorPermanent: false,
      crossScene: false,
    },
  },
  system: { tags: ["buff"] },
  statuses: ["fud-dodge"],
  changes: [
    // CSB column is `bonus_defense` (not `bonus_def`). CSB auto-prefixes
    // bare keys to `system.props.<key>` per [[csb-ae-bare-key]]. SL is
    // a director formula identifier baked at apply time via
    // applyEffectRow's bake pass — `value: "SL"` is rewritten to a
    // literal integer (level value) before the change persists on the
    // target's AE document.
    { key: "bonus_defense", value: "SL", mode: 2, priority: 20 },
  ],
};

function hasReactionRow(item) {
  const tbl = item?.system?.props?.reaction_config_table ?? {};
  for (const row of Object.values(tbl)) {
    if (row?.reaction_effect_ref === "dodge_apply_bonus") return true;
  }
  return false;
}

function hasEffectRows(item) {
  const tbl = item?.system?.props?.effect_table ?? {};
  for (const row of Object.values(tbl)) {
    if (row?.effect_label === "dodge_apply_bonus"
      && row?.effect_kind === "apply_ae"
      && row?.target_ref === "self") return true;
  }
  return false;
}

function hasAeTemplate(item) {
  for (const ae of item.effects?.contents ?? []) {
    if (ae.name === "Dodge") return true;
  }
  return false;
}

async function patchOne(item, log, ownerLabel) {
  let touched = false;

  // 1. Reaction row — self-heal: rebuild the table from scratch with
  // the canonical Dodge row, preserving any unrelated rows. Foundry's
  // update() deep-merges so a stale `reaction_source: "self"` from an
  // earlier migration version would otherwise survive; the delete-then-
  // set pattern (same as the effect_table fix) clears the slot.
  {
    const current = item.system?.props?.reaction_config_table ?? {};
    const preserved = {};
    let idx = 0;
    for (const row of Object.values(current)) {
      if (row?.reaction_effect_ref === "dodge_apply_bonus") continue;
      preserved[String(idx++)] = row;
    }
    const want = { ...preserved, [String(idx)]: REACTION_ROW };
    if (JSON.stringify(current) !== JSON.stringify(want)) {
      await item.update({ "system.props.-=reaction_config_table": null });
      await item.update({
        "system.props.reaction_config_table": want,
        "system.props.isReaction": true,
      });
      log(`  ${ownerLabel} / "${item.name}": reaction_config_table normalised`);
      touched = true;
    }
  }

  // 2. Effect table — self-heal: replace the whole table with the
  // canonical shape so previous bad rows (`dodge_target_self`,
  // `target_ref: "dodge_target_self"`) get cleaned out. The labels we
  // own ("dodge_apply_bonus", optionally "dodge_target_self") are
  // dropped; any unrelated rows are preserved.
  //
  // Foundry's update() deep-merges by default — `item.update({ "...table": next })`
  // would MERGE next per-key onto the existing table, leaving stale
  // fields and unused row keys behind. We work around this by first
  // deleting the table with the `-=` sentinel, THEN writing the new
  // table in a second update. Two calls, but a clean replace.
  {
    const current = item.system?.props?.effect_table ?? {};
    const ownedLabels = new Set(["dodge_apply_bonus", "dodge_target_self"]);
    const preserved = {};
    let idx = 0;
    for (const row of Object.values(current)) {
      if (ownedLabels.has(String(row?.effect_label ?? ""))) continue;
      preserved[String(idx++)] = row;
    }
    const want = { ...preserved };
    for (const row of Object.values(EFFECT_TABLE)) {
      want[String(idx++)] = row;
    }
    if (JSON.stringify(current) !== JSON.stringify(want)) {
      await item.update({ "system.props.-=effect_table": null });
      await item.update({ "system.props.effect_table": want });
      log(`  ${ownerLabel} / "${item.name}": effect_table normalised`);
      touched = true;
    }
  }

  // 3. AE template — self-heal: ensure the `Dodge` AE exists AND its
  // change uses `bonus_defense` (not the earlier `bonus_def` typo).
  const existing = item.effects?.contents?.find((e) => e.name === "Dodge");
  if (!existing) {
    await item.createEmbeddedDocuments("ActiveEffect", [AE_TEMPLATE]);
    log(`  ${ownerLabel} / "${item.name}": added Dodge AE template`);
    touched = true;
  } else {
    const ch = existing.changes ?? [];
    const wantKey = "bonus_defense";
    const needsFix = !ch.some((c) => c?.key === wantKey)
      || ch.some((c) => c?.key === "bonus_def");
    if (needsFix) {
      await existing.update({ changes: AE_TEMPLATE.changes });
      log(`  ${ownerLabel} / "${item.name}": Dodge AE changes normalised`);
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

  // World masters.
  for (const item of game.items?.contents ?? []) {
    if (item.name !== "Dodge") continue;
    if (!isInBattleDirectorTree(item)) { nonBd += 1; continue; }
    const touched = await patchOne(item, log, "world");
    if (touched) masters += 1;
    else skipped += 1;
  }

  // Actor copies.
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
