/**
 * Migration: 2026-05-21-prophetic-defender-author-v4
 * ---------------------------------------------------------------------------
 * Author Hina's Prophetic Defender Style WITHOUT touching Black & White.
 *
 * Why v4 exists:
 *   The PDS copy on Hina was hand-edited from a duplicate of the Black &
 *   White card-mage skill (uniqueId TSCAUfjpOlNl6WwV). CSB doesn't re-issue
 *   uniqueId when an actor renames a copy, so Hina's PDS still points at
 *   B&W's content id. Matching by uniqueId would (and did, in v2/v3) drag
 *   in every B&W instance across the world and corrupt them.
 *
 * v4's matching rule: STRICTLY by item.name === "PROPHETIC DEFENDER STYLE".
 * Black & White is never inspected.
 *
 * Author process:
 *   Phase 0  Ensure a world master named "PROPHETIC DEFENDER STYLE" exists.
 *            If none, seed from any actor copy of the same name. Don't reuse
 *            the borrowed uniqueId TSCAUfjpOlNl6WwV — generate a fresh
 *            content id (PDS_UNIQUE_ID) and stamp it on the master.
 *   Phase 1  Author effect_table + reaction_config_table on every
 *            PDS-named item (master + actor copies). Also rewrite each
 *            item's system.uniqueId to PDS_UNIQUE_ID, severing the
 *            B&W link.
 *   Phase 2  Install the Prophecy Point template AE + transfer max-HP AE
 *            on each PDS-named item. AEs are looked up by NAME at apply
 *            time ("Prophecy Point"), so the master's _id is not
 *            referenced anywhere in effect_table.
 *
 * Dependency: 2026-05-21-reaction-gate-columns (template surgery for
 * condition_formula + requires_skill).
 *
 * IDEMPOTENT — re-runs are safe; each phase checks observable state.
 */

// v5 — switches the transfer AE target from system.props.max_hp to
// system.props.skill_hp. CSB's prepareData computes max_hp from a label
// formula AFTER Foundry's standard applyActiveEffects, and CSB's
// per-formula-prop AE re-application loop excludes transfer AEs
// ([TemplateSystem.js:611] excludeTransfer:true). Net result for v4:
// transfer-AE bumps to max_hp were wiped on every prep pass. skill_hp
// is a stored numberField (no formula), so transfer AE writes persist,
// and max_hp's formula reads skill_hp — the bump flows through.
export const key = "2026-05-21-prophetic-defender-author-v5";
export const description =
  "Author Prophetic Defender Style (v5): name-based matching, target " +
  "system.props.skill_hp (not max_hp) so CSB's formula loop doesn't " +
  "overwrite the transfer-AE bump.";

const PDS_NAME = "PROPHETIC DEFENDER STYLE";
const PDS_UNIQUE_ID = "propheticDefStyle"; // fresh content id, never collides with B&W
const DIVINATION_UNIQUE_ID = "BmgIHS4DdDAT1rUc"; // gates the even-round PP gain
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
      // Name-based ref — AEM's registry findByName resolves it on every
      // actor independently of the master's _id. Decoupled from world
      // structure entirely.
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
      // Consume FIRST: no mid-chain cancel point (pds_threatened mode=all
      // has no picker), so gate semantics — 0 PP aborts before the
      // multi-redirect runs.
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
    name: "Prophetic Defender Style (Skill HP)",
    img: "icons/svg/aura.svg",
    transfer: true,
    disabled: false,
    changes: [
      {
        // Bump skill_hp (a stored numberField — "HP from Skills"), NOT max_hp.
        // Hina's max_hp label formula reads skill_hp; the bump flows through.
        // Writing to max_hp directly is wiped by CSB's prepareData formula
        // loop because transfer AEs are excluded from CSB's per-prop AE
        // re-application path. skill_hp has no formula so transfer AEs to
        // it persist.
        key: "system.props.skill_hp",
        mode: 2, // ADD
        value: "${(target.ins_current)}$",
        priority: 20
      }
    ],
    duration: {},
    description: "<p>Permanent skill_hp increase equal to the bearer's INS die size. Max HP's label formula reads skill_hp, so the bump shows up there. <code>target.ins_current</code> re-evaluates on every prepareDerivedData pass — live INS buffs/debuffs flow through automatically.</p>",
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

// Walk world + actors, return every item literally named PROPHETIC DEFENDER STYLE.
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

  // No master yet — seed from any actor copy.
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
    console.error("[ProphDefMig-v4] Phase 0 throw:", e);
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
  log(`  • refreshed AE "${desired.name}" [${MAXHP_AE_ID}] on item ${item.id} (changes drifted)`);
  return true;
}

async function authorPdsItem(item, log) {
  let touched = false;

  // Re-stamp uniqueId so this item never matches Black & White-derived
  // queries again. Idempotent: only updates when the value differs.
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
  console.info("[ProphDefMig-v4] migrate() entered.");

  let touched = 0;

  // Phase 0: ensure the world master exists.
  const { created, master } = await ensureMaster(game, log);
  if (created) touched++;

  // Phase 1 + 2: author every PDS-named item.
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
    summary: `${touched} item${touched === 1 ? "" : "s"} touched (master + ${allPds.length} PDS-named items found)`
  };
}
