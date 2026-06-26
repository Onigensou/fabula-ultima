/**
 * Migration: 2026-06-27-creeps-curse-author
 * ---------------------------------------------------------------------------
 * Two related jobs for the homebrew "Curse" keyword (JournalEntry
 * V8mKI3BdXusfSBLq): "Cursed creatures lose 20% of their MaxMP at the start of
 * their turn (10% against Champion-rank creatures). Duration 3 Rounds."
 * (The keyword also lists Poisoned as a Basic Condition; per the author that
 * part is DROPPED — Curse here is the MP-drain rule only.)
 *
 * 1. COMMON "Cursed" status AE — wire the existing shell on the world Debuff hub
 *    (item "Debuff" XVOWOq9oUmEECGrU, AE "Cursed" k5Ovdpt7oSm8soLU; ships with
 *    empty `changes` + no reactionConfig). Modelled on the hub "Burn" AE: a
 *    FORCED `turn_start` reaction on self, but draining MP via `consume_resource`
 *    instead of dealing HP damage. consume_resource fires the −N spend VFX (so
 *    Curse "ticks" visibly like Burn) and `on_empty: "skip"` keeps it from
 *    aborting the turn machinery when the bearer can't cover the full drain.
 *    Amount = ceil(MAX_MP * (0.2 - RANK_IS_CHAMPION*0.1)) → 20% normally, 10%
 *    when the BEARER (reactor/self) is Champion-rank (RANK_IS_CHAMPION reads the
 *    resolver actor's npc_rank). LIFECYCLE = Burn's exactly: chargeKey "cursed" +
 *    charges 3 + lifetimeMode "on_activation" (NO chargesMax, NO Foundry duration,
 *    like Burn) → the visible 3-charge badge DECREMENTS at the moment the drain
 *    fires (turn start), auto-deleting at 0. Being on the hub makes it reusable by
 *    every skill that inflicts Curse (Hexer Curse spell, Bandit Roo, Creeps).
 *
 * 2. CREEPS "Curse" passive — wire the shell skill (item "Curse"
 *    WElsRrkCJQeqfxWt, skill_type Passive, isReaction, empty tables). RAW:
 *    "Whenever this creature is reduced to 0 HP, inflict Curse to the target who
 *    triggered this ability." Proven Fire-Slime death pattern: a
 *    `creature_lose_resource` reaction (resource hp, cause damage, source self,
 *    condition CUR_HP <= 0) whose apply_ae targets the KILLER via the
 *    `cause_actor` targeting ref (reads payload.causeTokenUuid).
 *
 * Engine deps (all pre-existing, verified): consume_resource effect_kind;
 * formula ids MAX_MP / RANK_IS_CHAMPION; turn_start + creature_lose_resource
 * reactions; reaction_resource_filter / reaction_cause_filter; cause_actor
 * targeting ref. No new engine code required.
 *
 * RUN ONCE (NOT manifest-tagged idempotent); patch logic is drift-safe if
 * re-run. The Debuff hub + Creeps are co-dev world data; delivery = WORLD-DATA
 * PUSH (USER says when).
 */

export const key = "2026-06-27-creeps-curse-author";
export const description =
  "Wire the common 'Cursed' hub AE (turn_start MP drain, 20%/10% Champion) and " +
  "the Creeps 'Curse' passive (inflict Cursed on the killer when Creeps hits 0 HP).";

const NS = "fabula-ultima-companion";
const HUB_ITEM_NAME = "Debuff";
const CURSED_AE_ID = "k5Ovdpt7oSm8soLU";
const CURSED_AE_NAME = "Cursed";
const ACTOR_NAME = "Creeps";
const CURSE_SKILL_NAME = "Curse";

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

// ── 1. Common "Cursed" status: turn_start MP drain — TRUE Burn analog ────────
// Burn = `deal_damage` to HP; Curse = `deal_damage` to MP (damage_resource:"mp").
// Routes through applyDamageToTarget's MP path, which CLAMPS at 0 (drains what's
// available — a bearer with 5 MP facing a 60 drain goes 5→0, it does NOT skip)
// AND fires the −N loss VFX AND logs. damage_amount is POSITIVE (the MP path
// subtracts it): ceil(MAX_MP * (0.2 - RANK_IS_CHAMPION*0.1)) → 20% normally, 10%
// when the BEARER is Champion-rank. emit_status/emit_trigger fire the
// creature_status_triggered signal (Burn-parity; lets future skills react to a
// Curse tick). Requires the deal_damage `damage_resource` engine knob (added with
// this migration in skill-effects.js + template-field-registry).
//   HISTORY: first consume_resource (skipped drain when MP < amount — user bug),
//   then a negative grant workaround (drained-to-0 but VFX-silent). Both replaced
//   by exposing the engine's existing MP damage path — the system fix, not a hack.
const CURSED_REACTION_CONFIG = {
  effect_table: {
    "0": {
      effect_label: "curse_mp_drain",
      effect_kind: "deal_damage",
      damage_resource: "mp",
      damage_amount: "ceil(MAX_MP * (0.2 - RANK_IS_CHAMPION * 0.1))",
      target_ref: "self",
      emit_status: "Cursed",
      emit_trigger: "creature_status_triggered",
    },
  },
  reaction_config_table: {
    "0": {
      reaction_effect_ref: "curse_mp_drain",
      reaction_trigger: "turn_start",
      reaction_passive_mode: "force",
      reaction_passive_target: "self",
      reaction_source: "self",
    },
  },
};

// Charge badge — mirrors the hub BURN AE exactly: chargeKey + charges 3 +
// lifetimeMode "on_activation" (NO chargesMax, NO Foundry-native duration). The
// charge is the lifetime: it decrements when the turn_start drain reaction fires
// (post-fire bookkeeping in firePreAcceptedCandidate, agnostic to effect_kind),
// so the token badge ticks 3 → 2 → 1 → gone at the drain moment, Burn-identical.
// (The MP-drain amount is %-of-MaxMP, NOT charge-scaled.)
const CURSED_CHARGE_KEY = "cursed";
const CURSED_CHARGES = 3;
const CURSED_LIFETIME = "on_activation";

async function wireCursedHubAe(game, log) {
  const hub = (game.items?.contents ?? []).find((i) => i.name === HUB_ITEM_NAME);
  if (!hub) { log(`  hub item "${HUB_ITEM_NAME}" not found — skipped Cursed AE`); return 0; }
  const ae = hub.effects.get(CURSED_AE_ID) ?? hub.effects.find((e) => e.name === CURSED_AE_NAME);
  if (!ae) { log(`  "${CURSED_AE_NAME}" AE not found on "${HUB_ITEM_NAME}" — skipped`); return 0; }

  const cur = ae.toObject();
  const fuc = cur.flags?.[NS] ?? {};
  const same =
    cur.transfer === false &&
    cur.duration?.rounds == null &&
    fuc.lifetimeMode === CURSED_LIFETIME &&
    fuc.chargeKey === CURSED_CHARGE_KEY &&
    Number(fuc.charges) === CURSED_CHARGES &&
    fuc.chargesMax == null &&
    deepEqual(fuc.reactionConfig ?? {}, CURSED_REACTION_CONFIG);
  if (same) { log(`  "${CURSED_AE_NAME}" hub AE already canonical`); return 0; }

  await ae.update({
    transfer: false,
    "duration.rounds": null,                       // Burn carries no Foundry duration
    [`flags.${NS}.lifetimeMode`]: CURSED_LIFETIME,
    [`flags.${NS}.chargeKey`]: CURSED_CHARGE_KEY,
    [`flags.${NS}.charges`]: CURSED_CHARGES,
    [`flags.${NS}.-=chargesMax`]: null,            // Burn has no chargesMax
    [`flags.${NS}.reactionConfig`]: CURSED_REACTION_CONFIG,
  });
  log(`  wired "${CURSED_AE_NAME}" hub AE (turn_start MP drain, on_activation/charges 3, Burn lifecycle)`);
  return 1;
}

// ── 2. Creeps "Curse" passive: inflict Cursed on the killer at 0 HP ──────────
const CURSE_SKILL_EFFECT_TABLE = {
  "0": {
    effect_label: "curse_inflict",
    effect_kind: "apply_ae",
    ae_template_ref: CURSED_AE_NAME,
    target_ref: "cause_actor",
  },
};
// Triggers on `creature_defeated` — NOT `creature_lose_resource`. The killing
// hp-event drains through settleInstance's normal authored dispatch, which walks
// `collectReactors` — and that SKIPS the just-defeated subject, so a self-reaction
// on the dying creature never gets collected there. The builtin defeatReactor
// works around this by firing the dying creature's own `creature_defeated`
// reactions (re-adding the subject to the reactor list) BEFORE token removal,
// forwarding the killing blow's cause/causeActorUuid into the defeat payload
// (defeat-reactor.js emitCreatureDefeated). So an on-death self-reaction MUST use
// creature_defeated. (No reaction_resource_filter — the defeat payload carries no
// `resource` field; and no CUR_HP<=0 — creature_defeated already means HP hit 0.)
const CURSE_SKILL_REACTION_TABLE = {
  "0": {
    reaction_effect_ref: "curse_inflict",
    reaction_trigger: "creature_defeated",
    // cause "damage" = a creature's direct attack/inflicted damage (forwarded from
    // the killing hp-event). deal_damage status ticks (Burn/DoT)/hazards default to
    // cause "hazard" → excluded, so dying to Burn/poison/environment does NOT Curse.
    reaction_cause_filter: "damage",
    // ...AND the cause-actor must be an ENEMY CREATURE of Creeps. Closes the
    // sourceless-"damage" edge (a GM/macro hit with no attacker → no cause-actor →
    // not an enemy → gated). RAW: "Curse the ENEMY that kills it."
    reaction_damage_source: "enemy",
    reaction_source: "self",
    reaction_passive_mode: "on",
  },
};

async function wireCreepsCurseSkill(game, log) {
  const actors = (game.actors?.contents ?? []).filter((a) => a.name === ACTOR_NAME);
  if (!actors.length) { log(`  no "${ACTOR_NAME}" actor found — skipped Curse skill`); return 0; }
  let changed = 0;
  for (const actor of actors) {
    const skill = actor.items.find(
      (i) => i.name === CURSE_SKILL_NAME && String(i.system?.props?.skill_type).toLowerCase() === "passive",
    );
    if (!skill) { log(`  [${actor.name}] passive "${CURSE_SKILL_NAME}" not found — skipped`); continue; }

    const p = skill.system?.props ?? {};
    if (!deepEqual(p.effect_table ?? {}, CURSE_SKILL_EFFECT_TABLE)) {
      await skill.update({ "system.props.-=effect_table": null });
      await skill.update({ "system.props.effect_table": CURSE_SKILL_EFFECT_TABLE });
      log(`  [${actor.name}/Curse] effect_table written`); changed++;
    }
    if (!deepEqual(p.reaction_config_table ?? {}, CURSE_SKILL_REACTION_TABLE)) {
      await skill.update({ "system.props.-=reaction_config_table": null });
      await skill.update({ "system.props.reaction_config_table": CURSE_SKILL_REACTION_TABLE });
      log(`  [${actor.name}/Curse] reaction_config_table written`); changed++;
    }
  }
  return changed;
}

export async function migrate(game, log = () => {}) {
  let changed = 0;
  changed += await wireCursedHubAe(game, log);
  changed += await wireCreepsCurseSkill(game, log);
  return { applied: true, summary: `Curse authored (Cursed hub AE + Creeps Curse passive; changes: ${changed})` };
}
