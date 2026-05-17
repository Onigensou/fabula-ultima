/**
 * Migration: 2026-05-17-adversity-master-author
 * ---------------------------------------------------------------------------
 * Authors Adversity declaratively on the world master + actor copies using
 * the new passive bonus formula columns. The rule (Jan 2025 playtest):
 *   "+1 check per status (cap +3), +2 damage per status (cap +6)".
 *
 * Runs AFTER `2026-05-17-passive-bonus-formula-columns` so the template
 * declares the new columns and writes persist.
 *
 * Authoring target (on every Adversity item linked to the _Skill Template):
 *   system.props.passive_check_bonus_formula  = "min(STATUS_COUNT, 3)"
 *   system.props.passive_damage_bonus_formula = "min(STATUS_COUNT * 2, 6)"
 *
 * Also updates the skill description to reflect the playtest cap.
 *
 * GATING: only authors items whose `system.template` points at the
 * `_Skill Template` (id `j0F5Msw5RZ8aIB3j`). Items on other templates
 * (e.g. a non-standard Adversity master) won't have these columns declared
 * and writes would be silently stripped — better to skip and log than to
 * write into the void.
 *
 * IDEMPOTENT: skips items whose formulas + description already match.
 *
 * MATCHING POLICY: by exact item name "Adversity". The Hina + Darkblade
 * actor copies are both linked to master `Item.Uml73l4MKy1gSJYU` via
 * uniqueId — both get authored.
 */

export const key = "2026-05-17-adversity-master-author";
export const description =
  "Author Adversity declaratively on world master + actor copies using " +
  "passive_check_bonus_formula + passive_damage_bonus_formula.";

const ITEM_NAME = "Adversity";
const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";

const TARGET_CHECK_FORMULA  = "min(STATUS_COUNT, 3)";
const TARGET_DAMAGE_FORMULA = "min(STATUS_COUNT * 2, 6)";
const TARGET_DESCRIPTION =
  "<p>As long as you are suffering from one or more status effects, you gain " +
  "the following effects:</p>" +
  "<ul>" +
  "<li><p>+1 bonus on all Checks for every status effect you are suffering " +
  "from (up to a maximum of +3),</p></li>" +
  "<li><p>You deal 2 extra damage for every status effect you are suffering " +
  "from <em>(be it with attacks, spells, Arcana, items or any other method; " +
  "up to a maximum of 6 extra damage)</em>.</p></li>" +
  "</ul>";

function templateMatches(item) {
  return String(item?.system?.template ?? "") === SKILL_TEMPLATE_ID;
}

async function authorOnItem(item, label, log) {
  const props = item.system?.props ?? {};
  const checkOk = String(props.passive_check_bonus_formula ?? "") === TARGET_CHECK_FORMULA;
  const dmgOk   = String(props.passive_damage_bonus_formula ?? "") === TARGET_DAMAGE_FORMULA;
  const descOk  = String(props.description ?? "") === TARGET_DESCRIPTION;

  if (checkOk && dmgOk && descOk) {
    log(`${label}: already authored`);
    return false;
  }

  const update = {};
  if (!checkOk) update["system.props.passive_check_bonus_formula"]  = TARGET_CHECK_FORMULA;
  if (!dmgOk)   update["system.props.passive_damage_bonus_formula"] = TARGET_DAMAGE_FORMULA;
  if (!descOk)  update["system.props.description"]                  = TARGET_DESCRIPTION;

  await item.update(update);
  log(
    `${label}: authored (` +
    [
      !checkOk && "check formula",
      !dmgOk && "damage formula",
      !descOk && "description"
    ].filter(Boolean).join(", ") +
    ")"
  );
  return true;
}

export async function migrate(game, log) {
  let mastersAuthored = 0;
  let mastersSkipped = 0;
  let copiesAuthored = 0;
  let copiesSkipped = 0;

  for (const item of game.items?.contents ?? []) {
    if (item.name !== ITEM_NAME) continue;
    if (!templateMatches(item)) {
      log(`world master "${item.name}" [${item.id}]: skipped — template ${item.system?.template} is not _Skill Template`);
      mastersSkipped++;
      continue;
    }
    if (await authorOnItem(item, `world master "${item.name}" [${item.id}]`, log)) {
      mastersAuthored++;
    }
  }

  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (item.name !== ITEM_NAME) continue;
      if (!templateMatches(item)) {
        log(`actor "${actor.name}" item "${item.name}" [${item.id}]: skipped — template ${item.system?.template} is not _Skill Template`);
        copiesSkipped++;
        continue;
      }
      if (await authorOnItem(item, `actor "${actor.name}" item "${item.name}" [${item.id}]`, log)) {
        copiesAuthored++;
      }
    }
  }

  return {
    applied: true,
    summary:
      `${mastersAuthored} master${mastersAuthored === 1 ? "" : "s"} authored ` +
      `(${mastersSkipped} skipped), ` +
      `${copiesAuthored} copies authored (${copiesSkipped} skipped)`
  };
}
