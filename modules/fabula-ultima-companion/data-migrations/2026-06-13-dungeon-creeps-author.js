/**
 * Migration: 2026-06-13-dungeon-creeps-author
 * ---------------------------------------------------------------------------
 * Author the Current Dungeon "Creeps" monster's only skill: Shadow Possession.
 *
 *   Shadow Possession (Active) — "Possess the target's Shadow. This round, if the
 *   target performs an Attack/Skill/Spell, negate it and inflict Frightened."
 *   IMPROVED design (user): the skill applies a custom "Creeped" debuff to ALL
 *   enemies; ONE random enemy gets the BLOCK variant (its next Attack/Skill/Spell
 *   is negated), the REST get the BUFF variant (when they Attack/Skill/Spell they
 *   gain Energized instead). A "which of us is actually possessed?" gamble — both
 *   variants share the same name/icon/description so players can't tell.
 *
 *   Creeped is CUSTOM, authored here as two embedded AE templates on the skill
 *   (same display name "Creeped", distinct _ids, different reactionConfig). The
 *   apply_ae rows reference them by _id (resolveAeTemplate resolves skill-local
 *   templates by id). Both: statuses ["fud-creeped"] (token icon), transfer false,
 *   system.tags ["debuff"], duration 1 applier-turn → auto-removed at CREEPS' next
 *   turn start; reaction creature_performs_action / self / on /
 *   reaction_action_kind "Attack,Skill,Spell" / consume_self (fire once → remove).
 *     - block → chain[ negate_action, apply_ae Frightened→self ]
 *     - buff  → apply_ae Energized→self
 *
 *   Frightened's AE lands now; its MECHANIC is DEFERRED to after the monster pass
 *   (user). Energized is the existing common buff (Buff hub).
 *
 * Engine this skill depends on (all GENERIC, built alongside — Ctrl+Shift+R to go
 * live): targeting `mode: "random"`; reaction `reaction_action_kind` filter;
 * `creature_performs_action` firing for ALL action kinds; `negate_action`
 * effect_kind + `ar.negated` (block: no outcome, no reactions).
 *
 * RUN ONCE (NOT manifest-tagged idempotent); patch logic is drift-safe if re-run.
 * Creeps is a co-dev world actor; delivery = WORLD-DATA PUSH (USER says when).
 */

export const key = "2026-06-13-dungeon-creeps-author";
export const description =
  "Author Creeps / Shadow Possession: apply custom Creeped debuff to all enemies " +
  "(1 random = block variant negates its next Attack/Skill/Spell + Frightened; rest " +
  "= buff variant grants Energized on those actions). Two embedded Creeped AE " +
  "templates (by id), targeting mode random + exclude, negate_action + " +
  "reaction_action_kind / creature_performs_action(all kinds) engine.";

const ACTOR_NAME = "Creeps";
const NS = "fabula-ultima-companion";
const BLOCK_ID = "CreepedBlockAE01";
const BUFF_ID = "CreepedBuffAE001";
const CREEPED_IMG = "icons/svg/terror.svg";
const CREEPED_DESC = "<p><em>Shadow Possession:</em> This creature's shadow is possessed.</p>";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

const SKILL_EFFECT_TABLE = {
  "0": { effect_label: "creep_chain", effect_kind: "chain", chain_steps: "creep_possessed,creep_rest,creep_apply_block,creep_apply_buff" },
  "1": { effect_label: "creep_possessed", effect_kind: "targeting", candidate_source: "action_targets", mode: "random", count: "1" },
  "2": { effect_label: "creep_rest", effect_kind: "targeting", candidate_source: "action_targets", exclude: "creep_possessed", mode: "all", allow_empty: true },
  "3": { effect_label: "creep_apply_block", effect_kind: "apply_ae", ae_template_ref: BLOCK_ID, target_ref: "creep_possessed", ae_duplicate_mode: "replace" },
  "4": { effect_label: "creep_apply_buff", effect_kind: "apply_ae", ae_template_ref: BUFF_ID, target_ref: "creep_rest", ae_duplicate_mode: "replace" },
};

// Reaction config shared shape; only the effect chain differs per variant.
const blockReactionConfig = {
  reaction_config_table: {
    "0": { reaction_trigger: "creature_performs_action", reaction_source: "self", reaction_passive_mode: "on", reaction_action_kind: "Attack,Skill,Spell", consume_self: true, reaction_effect_ref: "creep_block_react" },
  },
  effect_table: {
    "0": { effect_label: "creep_block_react", effect_kind: "chain", chain_steps: "creep_negate,creep_frighten" },
    "1": { effect_label: "creep_negate", effect_kind: "negate_action" },
    "2": { effect_label: "creep_frighten", effect_kind: "apply_ae", ae_template_ref: "Frightened", target_ref: "self" },
  },
};
const buffReactionConfig = {
  reaction_config_table: {
    "0": { reaction_trigger: "creature_performs_action", reaction_source: "self", reaction_passive_mode: "on", reaction_action_kind: "Attack,Skill,Spell", consume_self: true, reaction_effect_ref: "creep_buff_react" },
  },
  effect_table: {
    "0": { effect_label: "creep_buff_react", effect_kind: "apply_ae", ae_template_ref: "Energized", target_ref: "self" },
  },
};

function creepedAeData(id, reactionConfig) {
  return {
    _id: id,
    name: "Creeped",
    img: CREEPED_IMG,
    transfer: false,
    disabled: false,
    description: CREEPED_DESC,
    statuses: ["fud-creeped"],
    duration: { rounds: 1 },
    changes: [],
    system: { tags: ["debuff"] },
    flags: { [NS]: { reactionConfig } },
  };
}

// Create (keepId) or update an embedded Creeped AE so it matches the template.
async function ensureCreepedAe(item, id, reactionConfig, log, label) {
  const want = creepedAeData(id, reactionConfig);
  const existing = item.effects.get(id);
  if (!existing) {
    await item.createEmbeddedDocuments("ActiveEffect", [want], { keepId: true });
    log(`  [${label}] created embedded Creeped AE "${id}"`);
    return 1;
  }
  // Drift-safe: rewrite the fields we own if any differ.
  const cur = existing.toObject();
  const same =
    cur.name === want.name &&
    cur.transfer === false &&
    deepEqual(cur.statuses ?? [], want.statuses) &&
    deepEqual(cur.system?.tags ?? [], want.system.tags) &&
    Number(cur.duration?.rounds) === 1 &&
    deepEqual(cur.flags?.[NS]?.reactionConfig ?? {}, reactionConfig);
  if (same) { log(`  [${label}] embedded Creeped AE "${id}" already canonical`); return 0; }
  await existing.update({
    name: want.name, img: want.img, transfer: false, description: want.description,
    statuses: want.statuses, "duration.rounds": 1,
    "system.tags": want.system.tags,
    [`flags.${NS}.reactionConfig`]: reactionConfig,
  });
  log(`  [${label}] updated embedded Creeped AE "${id}"`);
  return 1;
}

export async function migrate(game, log = () => {}) {
  const actors = (game.actors?.contents ?? []).filter((a) => a.name === ACTOR_NAME);
  if (!actors.length) return { applied: false, summary: `No "${ACTOR_NAME}" actor found` };
  let changed = 0;
  for (const actor of actors) {
    const sp = actor.items.find((i) => i.name === "Shadow Possession");
    if (!sp) { log(`  [${actor.name}] "Shadow Possession" not found — skipped`); continue; }

    // 1. Embedded Creeped AE templates (block + buff).
    changed += await ensureCreepedAe(sp, BLOCK_ID, blockReactionConfig, log, `${actor.name}/Shadow Possession`);
    changed += await ensureCreepedAe(sp, BUFF_ID, buffReactionConfig, log, `${actor.name}/Shadow Possession`);

    // 2. Skill props — effect_table (delete-then-write so removals stick) + fire-point + target.
    if (!deepEqual(sp.system?.props?.effect_table ?? {}, SKILL_EFFECT_TABLE)) {
      await sp.update({ "system.props.-=effect_table": null });
      await sp.update({ "system.props.effect_table": SKILL_EFFECT_TABLE });
      log(`  [${actor.name}/Shadow Possession] effect_table written`); changed++;
    }
    if (sp.system?.props?.on_activate_effect_ref !== "creep_chain") {
      await sp.update({ "system.props.on_activate_effect_ref": "creep_chain" });
      log(`  [${actor.name}/Shadow Possession] on_activate_effect_ref → creep_chain`); changed++;
    }
    if (sp.system?.props?.skill_target !== "All Enemy") {
      await sp.update({ "system.props.skill_target": "All Enemy" });
      log(`  [${actor.name}/Shadow Possession] skill_target → All Enemy`); changed++;
    }
    // Active skills with no damage classify as "aid" intent, which OVERRIDES the
    // explicit "All Enemy" and flips targeting to allies. Force harmful intent so
    // it targets the PCs (Shadow Possession is a control debuff).
    if (sp.system?.props?.action_intent !== "harmful") {
      await sp.update({ "system.props.action_intent": "harmful" });
      log(`  [${actor.name}/Shadow Possession] action_intent → harmful`); changed++;
    }
  }
  return { applied: true, summary: `Creeps / Shadow Possession authored (changes: ${changed})` };
}
