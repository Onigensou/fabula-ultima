/**
 * Migration: 2026-05-21-prophetic-defender-author-v6
 * ---------------------------------------------------------------------------
 * Author Hina's Prophetic Defender Style WITHOUT touching Black & White.
 *
 * v6 — switches the transfer AE target from system.props.skill_hp to
 *      system.props.bonus_hp. The user added a dedicated bonus_hp /
 *      bonus_mp pair to the actor template and wired them into the
 *      max_hp / max_mp label formulas. bonus_hp is a stored numberField
 *      with no formula override, so transfer AEs land cleanly and the
 *      bump flows through max_hp without being wiped by CSB's per-prop
 *      AE re-application loop (TemplateSystem.js:611 excludeTransfer:true).
 *
 *      Targeting bonus_hp also avoids stacking on top of any manual
 *      "HP from skills" the player typed into skill_hp.
 *
 * Matching rule (unchanged from v4/v5): STRICTLY by
 *   item.name === "PROPHETIC DEFENDER STYLE".
 * Black & White is never inspected — Hina's PDS forked from B&W and
 * still shares its uniqueId, so any uniqueId-based query would corrupt
 * every B&W copy in the world.
 *
 * Author process:
 *   Phase 0  Ensure a world master named "PROPHETIC DEFENDER STYLE" exists.
 *   Phase 1  Author effect_table + reaction_config_table on every
 *            PDS-named item (master + actor copies). Re-key
 *            system.uniqueId to PDS_UNIQUE_ID, severing the B&W link.
 *   Phase 2  Install the Prophecy Point template AE + transfer bonus-HP AE
 *            on each PDS-named item. AEs are looked up by NAME at apply
 *            time ("Prophecy Point"), so the master's _id is not
 *            referenced anywhere in effect_table.
 *
 * Dependency: 2026-05-21-reaction-gate-columns (template surgery for
 * condition_formula + requires_skill).
 *
 * IDEMPOTENT — re-runs are safe; each phase checks observable state.
 */

export const key = "2026-05-21-prophetic-defender-author-v6";
export const description =
  "Author Prophetic Defender Style (v6): name-based matching, target " +
  "system.props.bonus_hp (template's dedicated HP-bonus field) so the " +
  "transfer AE flows through max_hp without CSB's formula loop wiping it.";

const PDS_NAME = "PROPHETIC DEFENDER STYLE";
const PDS_UNIQUE_ID = "propheticDefStyle";
const DIVINATION_UNIQUE_ID = "BmgIHS4DdDAT1rUc";
const PP_AE_ID = "propheticPoint01";
const MAXHP_AE_ID = "propheticMaxHp01";
const PP_AE_NAME = "Prophecy Point";

const TARGETING_DEFAULTS = {
  auto_confirm_when_obvious: true,
  skip_when_passive: true,
  iteration_mode: "together"
};

function targetingRow(spec) {
  return {
    effect_kind: "targeting",
    category: "",
    exclude_self: false,
    ...TARGETING_DEFAULTS,
    ...spec
  };
}

function buildEffectTableRows() {
  return [
    targetingRow({
      effect_label: "pds_self",
      candidate_source: "self",
      mode: "exact",
      count: 1
    }),
    targetingRow({
      effect_label: "pds_threatened",
      candidate_source: "action_targets",
      mode: "all"
    }),
    {
      effect_label: "pds_gain",
      effect_kind: "apply_ae",
      target_ref: "pds_self",
      ae_template_ref: PP_AE_NAME,
      ae_duplicate_mode: "stack"
    },
    {
      effect_label: "pds_consume",
      effect_kind: "consume_charge",
      charge_key: "prophecy",
      target_ref: "pds_self",
      on_empty: "abort",
      count: 1
    },
    {
      effect_label: "pds_clear",
      effect_kind: "apply_ae",
      target_ref: "pds_self",
      ae_template_ref: PP_AE_NAME,
      ae_duplicate_mode: "remove"
    },
    {
      effect_label: "pds_redirect",
      effect_kind: "redirect_target",
      target_ref: "pds_threatened",
      destination_ref: "pds_self",
      rebuild_card: true
    },
    {
      effect_label: "pds_reaction",
      effect_kind: "chain",
      chain_steps: "pds_consume, pds_redirect"
    }
  ];
}

function buildReactionConfigRows() {
  return [
    {
      reaction_trigger: "conflict_start",
      reaction_effect_ref: "pds_gain",
      reaction_isPassive: true,
      reaction_passive_target: "self",
      condition_formula: "",
      requires_skill: ""
    },
    {
      reaction_trigger: "round_end",
      reaction_effect_ref: "pds_gain",
      reaction_isPassive: true,
      reaction_passive_target: "self",
      condition_formula: "ROUND % 2 == 0",
      requires_skill: DIVINATION_UNIQUE_ID
    },
    {
      reaction_trigger: "conflict_end",
      reaction_effect_ref: "pds_clear",
      reaction_isPassive: true,
      reaction_passive_target: "self",
      condition_formula: "",
      requires_skill: ""
    },
    {
      reaction_trigger: "creature_performs_action",
      reaction_source: "enemy",
      reaction_action_intent: "harmful",
      reaction_effect_ref: "pds_reaction",
      condition_formula: "ACTION_TARGET_COUNT >= 2",
      requires_skill: ""
    }
  ];
}

function arrayToObjectTable(arr) {
  const out = {};
  arr.forEach((row, i) => { out[String(i)] = row; });
  return out;
}

function buildPpAe() {
  return {
    _id: PP_AE_ID,
    name: PP_AE_NAME,
    img: "icons/svg/aura.svg",
    transfer: false,
    disabled: false,
    changes: [],
    duration: {},
    description: "<p>A reserve of foresight Hina spends to take the place of all creatures threatened by a single danger.</p>",
    statuses: [],
    flags: {
      "fabula-ultima-companion": {
        chargeKey: "prophecy",
        charges: 1,
        chargesMax: 1
      }
    }
  };
}

function buildMaxHpAe() {
  return {
    _id: MAXHP_AE_ID,
    name: "Prophetic Defender Style (Bonus HP)",
    img: "icons/svg/aura.svg",
    transfer: true,
    disabled: false,
    changes: [
      {
        // Bump bonus_hp by the bearer's INS die size.
        //   - Bare key ("bonus_hp", not "system.props.bonus_hp"): CSB's
        //     CustomActiveEffect.apply auto-prefixes. Bare is the CSB idiom.
        //   - fetchFromParent('ins_current'): for an item-owned transfer AE,
        //     this is the ONLY reliable way to read the equipping actor's
        //     props. `target.X`, `ref()`, and bare names all silently fail
        //     in this eval context. See memory: csb-ae-actor-data-access.
        key: "bonus_hp",
        mode: 2, // ADD
        value: "${fetchFromParent('ins_current')}$",
        priority: 20
      }
    ],
    duration: {},
    description: "<p>Permanent bonus_hp increase equal to the bearer's INS die size. Max HP's label formula reads bonus_hp, so the bump shows up there. <code>target.ins_current</code> re-evaluates on every prepareDerivedData pass — live INS buffs/debuffs flow through automatically.</p>",
    statuses: [],
    flags: {
      "fabula-ultima-companion": {
        sourceSkillUniqueId: PDS_UNIQUE_ID
      }
    }
  };
}

function isPdsNamed(item) {
  return String(item?.name ?? "").trim().toUpperCase() === PDS_NAME;
}

function findAllPdsItems(game) {
  const hits = [];
  for (const item of game.items?.contents ?? []) {
    if (isPdsNamed(item)) hits.push(item);
  }
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (isPdsNamed(item)) hits.push(item);
    }
  }
  return hits;
}

async function ensureMaster(game, log) {
  log(`Phase 0: scanning for existing PDS master in game.items...`);

  for (const item of game.items?.contents ?? []) {
    if (isPdsNamed(item)) {
      log(`Phase 0: master already exists at id="${item.id}" (name="${item.name}")`);
      return { created: false, master: item };
    }
  }

  let seed = null;
  for (const actor of game.actors?.contents ?? []) {
    for (const item of actor.items?.contents ?? []) {
      if (isPdsNamed(item)) { seed = item; break; }
    }
    if (seed) break;
  }
  if (!seed) {
    log(`Phase 0: WARN no PDS-named item found anywhere. Add the skill to a character first, then re-run.`);
    return { created: false, master: null };
  }
  log(`Phase 0: seed actor item ${seed.id} on actor "${seed.parent?.name ?? "?"}" (type=${seed.type})`);

  const seedSystem = foundry.utils.duplicate(seed.system ?? {});
  seedSystem.uniqueId = PDS_UNIQUE_ID;
  seedSystem.props = seedSystem.props ?? {};

  const itemData = {
    name: PDS_NAME,
    type: seed.type || "equippableItem",
    img: seed.img || "icons/svg/aura.svg",
    system: seedSystem,
    effects: [],
    ownership: { default: 0 }
  };

  log(`Phase 0: creating world master (type="${itemData.type}", template=${seedSystem.template ?? "(none)"})`);
  try {
    const created = await Item.implementation.create(itemData);
    if (!created) {
      log(`Phase 0: Item.implementation.create returned ${created} — failure without throw`);
      return { created: false, master: null };
    }
    log(`Phase 0: created world master "${created.name}" [${created.id}]`);
    return { created: true, master: created };
  } catch (e) {
    log(`Phase 0: Item.implementation.create THREW: ${e?.message ?? e}`);
    console.error("[ProphDefMig-v6] Phase 0 throw:", e);
    return { created: false, master: null };
  }
}

async function ensureEmbeddedAe(item, aeData, log) {
  const existing = item.effects?.get?.(aeData._id) ?? null;
  if (existing) return false;
  await item.createEmbeddedDocuments("ActiveEffect", [aeData], { keepId: true });
  log(`  • created AE "${aeData.name}" [${aeData._id}] on item ${item.id}`);
  return true;
}

async function ensureMaxHpAe(item, log) {
  const desired = buildMaxHpAe();
  const existing = item.effects?.get?.(MAXHP_AE_ID) ?? null;
  if (!existing) {
    await item.createEmbeddedDocuments("ActiveEffect", [desired], { keepId: true });
    log(`  • created AE "${desired.name}" [${MAXHP_AE_ID}] on item ${item.id}`);
    return true;
  }
  const cur = existing.changes ?? [];
  const want = desired.changes;
  const drifted =
    cur.length !== want.length ||
    cur.some((c, i) =>
      String(c?.key ?? "") !== String(want[i]?.key ?? "") ||
      Number(c?.mode ?? -1) !== Number(want[i]?.mode ?? -1) ||
      String(c?.value ?? "") !== String(want[i]?.value ?? "")
    );
  if (!drifted) return false;
  await existing.update({
    name: desired.name,
    changes: desired.changes,
    description: desired.description,
    flags: desired.flags
  });
  log(`  • refreshed AE "${desired.name}" [${MAXHP_AE_ID}] on item ${item.id} (changes drifted to bonus_hp)`);
  return true;
}

async function authorPdsItem(item, log) {
  let touched = false;

  const curUniq = item.system?.uniqueId ?? null;
  if (curUniq !== PDS_UNIQUE_ID) {
    await item.update({ "system.uniqueId": PDS_UNIQUE_ID });
    log(`re-keyed system.uniqueId on ${item.id} (${curUniq ?? "(unset)"} → ${PDS_UNIQUE_ID})`);
    touched = true;
  }

  const props = item.system?.props ?? {};
  const existingTable = props.effect_table ?? {};
  const hasPdsSelfRow =
    (Array.isArray(existingTable)
      ? existingTable.some(r => r?.effect_label === "pds_self")
      : Object.values(existingTable).some(r => r?.effect_label === "pds_self"));

  if (!hasPdsSelfRow) {
    const effectTableObj = arrayToObjectTable(buildEffectTableRows());
    const reactionCfgObj = arrayToObjectTable(buildReactionConfigRows());
    await item.update({
      "system.props.isReaction": true,
      "system.props.effect_table": effectTableObj,
      "system.props.reaction_config_table": reactionCfgObj
    });
    log(`authored props on ${item.id} (effect_table=${Object.keys(effectTableObj).length} rows, reaction_config_table=${Object.keys(reactionCfgObj).length} rows)`);
    touched = true;
  }

  const ppCreated    = await ensureEmbeddedAe(item, buildPpAe(), log);
  const maxHpChanged = await ensureMaxHpAe(item, log);
  if (ppCreated || maxHpChanged) touched = true;

  return touched;
}

export async function migrate(game, log) {
  log(`migrate() entered. items.size=${game.items?.size ?? "?"} actors.size=${game.actors?.size ?? "?"}`);
  console.info("[ProphDefMig-v6] migrate() entered.");

  let touched = 0;

  const { created, master } = await ensureMaster(game, log);
  if (created) touched++;

  const allPds = findAllPdsItems(game);
  log(`found ${allPds.length} PDS-named item(s) to author`);
  for (const item of allPds) {
    try {
      if (await authorPdsItem(item, log)) touched++;
    } catch (e) {
      log(`item ${item.id} (parent=${item.parent?.name ?? "world"}) failed: ${e?.message ?? e}`);
    }
  }

  return {
    applied: true,
    summary: `${touched} item${touched === 1 ? "" : "s"} touched (master + ${allPds.length} PDS-named items found, AE→bonus_hp)`
  };
}
