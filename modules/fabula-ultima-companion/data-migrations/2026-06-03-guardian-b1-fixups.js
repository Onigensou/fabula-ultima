/**
 * Migration: 2026-06-03-guardian-b1-fixups
 * ---------------------------------------------------------------------------
 * Follow-up fixes from live-test feedback on the same-day Guardian B.1
 * batch:
 *
 *   1. CSB template surgery — add `creature_guards` to the
 *      `_Skill Template`'s `reaction_trigger` dropdown so authors can
 *      pick it from the sheet UI (and so CSB column-gating doesn't
 *      silently strip it on future row writes). Mirrors the pattern in
 *      `2026-05-21-trigger-add-conflict-end`.
 *
 *   2. Fortress AE — drop `statuses[]` (was "fud-fortress"). Per the
 *      always-active-passive convention (Dodge, Adversity, Magical
 *      Artillery), passives that are *literally always on* shouldn't
 *      render a token-icon ring; the ring is reserved for transient /
 *      situational state. Apply on master + actor copies.
 *
 *      Defensive Mastery is intentionally NOT swept here — its gate
 *      (`aeEquippedWhen("shield,martial_armor", ...)`) makes it
 *      situational rather than always-on, so the token icon serves a
 *      useful signal (player can see at a glance whether the bonus is
 *      active for their current loadout).
 *
 * IDEMPOTENT.
 */

export const key = "2026-06-03-guardian-b1-fixups";
export const description =
  "Add creature_guards to reaction_trigger dropdown + drop statuses from " +
  "Fortress AE (always-active passive → no token icon).";

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const NEW_TRIGGER_OPTION = {
  key:   "creature_guards",
  value: "After performing a Guard action",
};

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

// ── 1. CSB template surgery ────────────────────────────────────────────────

function findReactionConfigTable(node) {
  if (!node || typeof node !== "object") return null;
  if (node.key === "reaction_config_table" && node.type === "compactDynamicTable") {
    return node;
  }
  const contents = Array.isArray(node.contents) ? node.contents : [];
  for (const child of contents) {
    const hit = findReactionConfigTable(child);
    if (hit) return hit;
  }
  return null;
}

async function patchSkillTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);
  const table = findReactionConfigTable({ contents: [sysClone.body] });
  if (!table) {
    log("template surgery: reaction_config_table compactDynamicTable not found — aborting");
    return false;
  }
  const triggerCol = (table.rowLayout ?? []).find((c) => c?.key === "reaction_trigger");
  if (!triggerCol) {
    log("template surgery: reaction_trigger column not found in rowLayout — aborting");
    return false;
  }
  const opts = Array.isArray(triggerCol.options) ? triggerCol.options : [];
  if (opts.some((o) => o?.key === NEW_TRIGGER_OPTION.key)) {
    log("template surgery: creature_guards already in dropdown — no-op");
    return false;
  }
  // Insert near the other creature_* action triggers so the dropdown
  // stays semantically grouped. Fall back to creature_takes_damage,
  // creature_deals_damage, or list end.
  const anchors = ["creature_deals_damage", "creature_takes_damage", "creature_will_deal_damage"];
  let insertAt = opts.length;
  for (const anchor of anchors) {
    const idx = opts.findIndex((o) => o?.key === anchor);
    if (idx >= 0) { insertAt = idx + 1; break; }
  }
  opts.splice(insertAt, 0, NEW_TRIGGER_OPTION);
  triggerCol.options = opts;
  await template.update({ system: sysClone });
  log(`template surgery: inserted "creature_guards" at dropdown index ${insertAt} (total options now ${opts.length})`);
  return true;
}

// ── 2. Fortress AE — drop statuses ─────────────────────────────────────────

async function patchFortressItem(item, log, ownerLabel) {
  const existing = item.effects?.contents?.find((e) => e.name === "Fortress");
  if (!existing) return false;
  const current = Array.from(existing.statuses ?? []);
  if (current.length === 0) return false;
  await existing.update({ statuses: [] });
  log(`  ${ownerLabel} Fortress: dropped statuses (was [${current.join(", ")}]) — always-active passive`);
  return true;
}

// ── DRIVER ──────────────────────────────────────────────────────────────────

export async function migrate(game, log) {
  let templateTouched = false;
  let fortressMasters = 0;
  let fortressCopies = 0;

  const template = game.items?.get(SKILL_TEMPLATE_ID);
  if (template) {
    templateTouched = await patchSkillTemplate(template, log);
  } else {
    log(`no _Skill Template (${SKILL_TEMPLATE_ID}); skipping template surgery`);
  }

  for (const item of game.items?.contents ?? []) {
    if (item.name !== "Fortress") continue;
    if (!isInBattleDirectorTree(item)) continue;
    if (!templateMatches(item)) continue;
    if (await patchFortressItem(item, log, "master")) fortressMasters += 1;
  }

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== "Fortress") continue;
      if (!templateMatches(item)) continue;
      if (await patchFortressItem(item, log, `actor "${actor.name}"`)) fortressCopies += 1;
    }
  }

  return {
    applied: true,
    summary:
      `template ${templateTouched ? "patched" : "unchanged"}, ` +
      `${fortressMasters} Fortress master(s) + ${fortressCopies} actor copy(s) icon-stripped`,
  };
}
