// Skill effect dispatcher — director-native equivalent of legacy
// `FUCompanion.api.reactionSystem.applyEffectByLabel` (in
// scripts/reaction-system/reaction-grant.js).
//
// Handles seven effect_kinds in B.1.x:
//   - targeting        (delegated to skill-targeting.resolveTargetRef)
//   - grant            — apply a resource delta (HP / MP / IP / etc.)
//   - apply_ae         — create an Active Effect on the target
//   - consume_charge   — decrement a charge-tracked AE; abort chain if empty
//   - chain            — run a sequence of effect_labels in order
//   - open_action_menu — pop picker, dispatch chosen option (B.1.2)
//   - remove_tagged_ae — pick + remove an AE filtered by system.tags (B.1.4)
//
// B.2 will add: consume_resource, redirect_target.
//
// Context object (`ctx`) shape — built by skill-targeting.makeChainContext:
//   reactorActor, reactorToken, skill, dCombat, payload, actionTargetUuids,
//   isPassive, resolvedTargets (Map, mutated as resolution proceeds).

import { log, warn } from "./logger.js";
import { evaluateFormula, buildSkillResolver, isFormulaString } from "./skill-formulas.js";
import { pickFromList } from "./list-picker.js";
import { resolveTargetRef } from "./skill-targeting.js";
import { findAndConsume, findOnActor as findChargeAEsOnActor } from "./skill-charges.js";
import { readPropNum, resolveAffinity } from "./snapshot.js";
import { computeIncomingDamage } from "./damage-ruleset.js";
import { appendBattleLog, buildDamageRow } from "./director-battle-log.js";

const FLAG_NS = "fabula-ultima-companion";

// Resource definitions — match skill-cost.js. Out-of-bounds writes
// clamp to [0, max] when a max is defined.
const RESOURCE_PROPS = {
  hp:         { prop: "current_hp",    max: "max_hp"    },
  mp:         { prop: "current_mp",    max: "max_mp"    },
  ip:         { prop: "current_ip",    max: "max_ip"    },
  zero_power: { prop: "zero_power_value", max: null, hardMin: 0, hardMax: 6 },
  zenit:      { prop: "zenit",         max: null        },
  enmity:     { prop: "enmity",        max: null        },
  fp:         { prop: "fabula_point",  max: null        },
  // Shield — temporary damage buffer (absorbed before HP in applyDamageToTarget).
  // grant adds to it (Golem Soulstone "+10 Shield"); no max.
  shield:     { prop: "shield_value",  max: null, hardMin: 0 },
};

// ── Public entry points ─────────────────────────────────────────────────

// Classify an AE as "transient" (should be swept at scene/battle end) or
// "persistent" (keep — passive trait, equipped-item AE, or explicit
// cross-scene opt-in).
//
// Transient if ANY of:
//   - has `flags.fabula-ultima-companion.directorAppliedBy` (director-applied)
//   - has any duration set (`duration.rounds | .turns | .seconds`)
//   - `system.tags` includes "buff" or "debuff" (opt-in classification)
// Always persistent if EITHER opt-out is set:
//   - `flags.fabula-ultima-companion.crossScene === true`
//   - `flags.fabula-ultima-companion.directorPermanent === true`
//
// Passive AEs (equipment-derived, class-trait, etc.) typically have no
// duration, no buff/debuff tag, and no director stamp — they fall through
// to "keep".
function isTransientAE(eff) {
  const fuFlags = eff?.flags?.[FLAG_NS] ?? {};
  if (fuFlags.crossScene === true) return false;
  if (fuFlags.directorPermanent === true) return false;
  if (fuFlags.directorAppliedBy) return true;
  const d = eff?.duration ?? {};
  if (d.rounds != null || d.turns != null || d.seconds != null) return true;
  const tags = eff?.system?.tags;
  if (Array.isArray(tags) && (tags.includes("buff") || tags.includes("debuff"))) return true;
  return false;
}

// Sweep every TRANSIENT AE from every actor in the world. Used by
// `director-boot.stop()` to clean up battle-applied AEs and other
// duration-bearing effects when the scene/battle ends. Passive AEs
// (equipment / class traits / cross-scene-flagged) are preserved.
// See [[ae-default-3-turn-duration]] for the classification rule.
//
// Returns `{ swept, perActor }` for logging.
export async function sweepTransientAEsAtSceneEnd() {
  const deleteByActor = new Map();   // actorUuid -> Set<aeId>
  let swept = 0;
  for (const actor of game.actors ?? []) {
    for (const eff of actor.effects ?? []) {
      if (!isTransientAE(eff)) continue;
      let set = deleteByActor.get(actor.uuid);
      if (!set) { set = new Set(); deleteByActor.set(actor.uuid, set); }
      set.add(eff.id);
      swept += 1;
    }
  }
  await Promise.all(Array.from(deleteByActor.entries()).map(async ([actorUuid, ids]) => {
    try {
      const actor = await fromUuid(actorUuid);
      if (!actor) return;
      const existing = Array.from(ids).filter((id) => !!actor.effects?.get?.(id));
      if (!existing.length) return;
      await actor.deleteEmbeddedDocuments("ActiveEffect", existing);
    } catch (e) {
      warn(`sweepTransientAEsAtSceneEnd: delete failed for ${actorUuid}`, e);
    }
  }));
  if (swept) log(`sweepTransientAEsAtSceneEnd: cleared ${swept} transient AE(s) across ${deleteByActor.size} actor(s)`);
  return { swept, perActor: deleteByActor.size };
}

// ── Damage-taken reaction resolver ─────────────────────────────────────
//
// Generic data-driven hook called BEFORE the director writes
// `current_hp` on a damage-application path. Walks the target's AEs for
// any `reactionConfig` declaring a `creature_takes_damage` trigger whose
// filter (e.g. `reaction_damage_outcome: "would_reduce_to_zero"`)
// matches the pending damage. Matching AEs' INCOMING `adjust_damage` rows
// mutate the landed damage (which derives the final HP) — cap it (Mercy),
// reduce it, reflect, etc.
//
// Incoming damage adjustment (effect_kind: "adjust_damage",
// damage_stage: "incoming"): applies `damage_operation` (add | subtract |
// multiply | set | cap | floor) with `damage_amount` (a formula; CUR_HP /
// MAX_HP resolve to the VICTIM's sheet) to the running landed damage. The
// new HP is `curHp − adjustedDamage`. Mercy ("survive at 1 HP") = an
// incoming `cap` at `CUR_HP - 1` (only binds when the hit would be lethal).
//
// Reaction config shape (on the AE's flags.fabula-ultima-companion.reactionConfig):
//   {
//     name: "Mercy",
//     reaction_config_table: {
//       "0": {
//         reaction_trigger: "creature_takes_damage",
//         reaction_source: "self",
//         reaction_damage_outcome: "would_reduce_to_zero",
//         reaction_effect_ref: "mercy_clamp",
//         reaction_isPassive: true
//       }
//     },
//     effect_table: {
//       "0": {
//         effect_label: "mercy_clamp",
//         effect_kind: "adjust_damage",
//         damage_stage: "incoming",
//         damage_operation: "cap",
//         damage_amount: "CUR_HP - 1",
//         consume_self: true
//       }
//     }
//   }
//
// Usage:
//   const { newHp, consumedAeIds, fired } =
//     await resolveDamageReactions({ target: actor, curHp, rawDamage });
//   await actor.update({ "system.props.current_hp": newHp });
//   // Consume AEs that fired with consume_self:
//   for (const id of consumedAeIds) {
//     const ae = actor.effects?.get?.(id);
//     if (ae) await ae.delete();
//   }
export async function resolveDamageReactions({ target, curHp, rawDamage, sourceActor = null } = {}) {
  const result = { newHp: Math.max(0, curHp - rawDamage), consumedAeIds: [], fired: [] };
  if (!target || rawDamage <= 0) return result;

  // Running landed-damage value the incoming adjust_damage rows mutate.
  let dmg = rawDamage;
  let resolver = null;
  const getResolver = async () => {
    if (resolver) return resolver;
    const { buildSkillResolver } = await getSkillFormulas();
    // actor = victim, so CUR_HP / MAX_HP resolve to the victim's sheet
    // (current_hp is still the pre-damage value at this point).
    resolver = buildSkillResolver({
      actor: target,
      payload: { subjectActorUuid: sourceActor?.uuid ?? null },
      skill: null, round: 0,
    });
    return resolver;
  };

  for (const ae of (target.effects?.contents ?? Array.from(target.effects ?? []))) {
    if (ae.disabled) continue;
    const cfg = ae.flags?.[FLAG_NS]?.reactionConfig;
    if (!cfg || typeof cfg !== "object") continue;
    const triggerRows = Object.values(cfg.reaction_config_table ?? {});
    const effectTable = cfg.effect_table ?? {};

    for (const tRow of triggerRows) {
      if (tRow.reaction_trigger !== "creature_takes_damage") continue;
      // reaction_source defaults to "self" — reactor IS the damage target.
      const src = tRow.reaction_source ?? "self";
      if (src !== "self" && src !== "all" && src !== "") continue;

      // Filter: damage_outcome (evaluated against the ORIGINAL incoming damage).
      const outcome = tRow.reaction_damage_outcome ?? "any";
      if (outcome === "would_reduce_to_zero" && (curHp - rawDamage) > 0) continue;

      // Find effect row by label — must be an incoming adjust_damage row.
      const effRow = Object.values(effectTable)
        .find((r) => r.effect_label === tRow.reaction_effect_ref);
      if (!effRow) continue;
      if (String(effRow.effect_kind ?? "").toLowerCase() !== "adjust_damage") continue;
      const { op, amountFormula, stage } = readAdjustRow(effRow);
      if (stage !== "incoming" || !DAMAGE_OPS.has(op)) continue;

      let amount = 0;
      try {
        const { evaluateFormula } = await getSkillFormulas();
        amount = Number(evaluateFormula(amountFormula, await getResolver())) || 0;
      } catch (e) {
        warn(`resolveDamageReactions: damage_amount eval threw on AE "${ae.name}"`, e);
      }

      const before = dmg;
      dmg = Math.max(0, Math.floor(applyDamageOp(dmg, op, amount)));
      if (dmg !== before) {
        log(`damage-reaction: ${target.name} ${op} ${amount} → damage ${before} → ${dmg} via AE "${ae.name}"`);
        result.fired.push({ aeId: ae.id, aeName: ae.name, op, amount, from: before, to: dmg });
        if (effRow.consume_self && !result.consumedAeIds.includes(ae.id)) {
          result.consumedAeIds.push(ae.id);
        }
      }
    }
  }
  result.newHp = Math.max(0, curHp - dmg);
  return result;
}

// Lazy fire-and-forget bridge to the resource-loss VFX (floating damage
// number + impact + sound). Kept as a dynamic import so this logic module
// doesn't statically depend on the VFX layer, and so a missing/broken VFX
// module can never break the damage write. Never awaited — the cinematic
// must not gate HP/MP application.
function fireResourceLossVfx(opts) {
  try {
    import("./director-vfx.js")
      .then((m) => m.playResourceLossVfx?.(opts))
      .catch((e) => warn("fireResourceLossVfx import failed", e));
  } catch (e) {
    warn("fireResourceLossVfx threw", e);
  }
}

// Gain counterpart — floats a recover number on a heal / restore. Same
// lazy fire-and-forget contract as fireResourceLossVfx.
function fireResourceGainVfx(opts) {
  try {
    import("./director-vfx.js")
      .then((m) => m.playResourceGainVfx?.(opts))
      .catch((e) => warn("fireResourceGainVfx import failed", e));
  } catch (e) {
    warn("fireResourceGainVfx threw", e);
  }
}

// Affinity-specific feedback. Immune (IM → 0 damage) gets no loss/gain VFX
// otherwise, so it'd land silently; absorb (AB) gets an absorb-specific look so
// it doesn't masquerade as a plain heal. Same lazy fire-and-forget contract.
function fireImmuneVfx(opts) {
  try {
    import("./director-vfx.js")
      .then((m) => m.playImmuneVfx?.(opts))
      .catch((e) => warn("fireImmuneVfx import failed", e));
  } catch (e) {
    warn("fireImmuneVfx threw", e);
  }
}
function fireAbsorbVfx(opts) {
  try {
    import("./director-vfx.js")
      .then((m) => m.playAbsorbVfx?.(opts))
      .catch((e) => warn("fireAbsorbVfx import failed", e));
  } catch (e) {
    warn("fireAbsorbVfx threw", e);
  }
}

// Spend counterpart — floats a `−N` over a payer paying a self-paid cost
// (reaction / free-action `consume_resource`). Same lazy fire-and-forget
// contract; distinct look from the loss VFX (no impact / hit sound).
function fireResourceSpendVfx(opts) {
  try {
    import("./director-vfx.js")
      .then((m) => m.playResourceSpendVfx?.(opts))
      .catch((e) => warn("fireResourceSpendVfx import failed", e));
  } catch (e) {
    warn("fireResourceSpendVfx threw", e);
  }
}

// ── Damage application (shared by Attack + Skill RESOLVE) ─────────────
//
// The single source of truth for "apply this per-target damage result to
// an actor": handles AB-affinity heal flip (HP only), routes through
// resolveDamageReactions (so Mercy and similar AEs work for ANY damage
// source), consumes reacted AEs, and writes the appropriate resource.
//
// Inputs:
//   - target:       the live target actor doc
//   - damage:       the post-affinity damage value (can be 0 — no-op then)
//   - affinity:     "AB" | "VU" | "RS" | "IM" | "NE" (HP-resource only;
//                   ignored when resource === "mp")
//   - resource:     "hp" (default) or "mp"
//   - targetName:   for log strings
//   - logPrefix:    e.g. "Skill Heal:" — appears before the log line
//   - logSuffix:    e.g. " (pass 2/2)" — appears at end
//
// Returns:
//   { resource, finalValue, valueDirection, fired }
//     - resource:        "hp" | "mp"
//     - finalValue:      effective amount that came off (or healed for AB)
//     - valueDirection:  "loss" | "recover" | "none"
//     - fired:           reaction-fired descriptors (for post_damage payload)
export async function applyDamageToTarget({
  target,
  damage,
  affinity = "NE",
  resource = "hp",
  targetName = "",
  tokenUuid = null,
  logPrefix = "",
  logSuffix = "",
  // Battle-log: when present, this commit pushes ONE {entry,row} record (built
  // from the attacker-side context here + the bands computed below) into
  // `logContext.sink` (an array the owning action flushes once via
  // appendBattleLog → Multi-N action = ONE write). Carries: attackerName,
  // element, weaponType?, efficiency?, range?, accuracy?, isCrit?, sourceType?,
  // sink. Absent → no log emit (silent callers stay quiet).
  logContext = null,
} = {}) {
  const empty = { resource, finalValue: 0, valueDirection: "none", fired: [] };
  if (!target) return empty;
  const prefix = logPrefix ? `${logPrefix} ` : "";
  // Build a battle-log record from this commit's facts + the caller's context
  // and push it to the sink. The single damage/heal logging seam (misses, which
  // have no commit, are logged by the attack RESOLVE loop). Never throws into
  // the damage write.
  const _pushLog = (fields) => {
    if (!logContext?.sink) return;
    try { logContext.sink.push(buildDamageRow({ ...logContext, targetName, ...fields })); }
    catch (e) { warn("applyDamageToTarget: battle-log row build failed", e); }
  };

  // MP path — drain spells, future MP-burn. No AB flip; no reactions
  // (could add later for an MP-clamp AE if a use case appears).
  if (resource === "mp") {
    if (damage <= 0) return empty;
    const curMp = readPropNum(target, ["current_mp", "mp"]);
    const newMp = Math.max(0, curMp - damage);
    await target.update({ "system.props.current_mp": newMp });
    log(`${prefix}applied ${damage} MP damage to ${targetName}: ${curMp} → ${newMp}${logSuffix}`);
    fireResourceLossVfx({ tokenUuid, resource: "mp", amount: curMp - newMp });
    _pushLog({ resource: "mp", affinity: "NE", value: damage, valueDirection: "loss", bands: { mp: { from: curMp, to: newMp } } });
    return { resource: "mp", finalValue: damage, valueDirection: "loss", fired: [] };
  }

  // HP path — full affinity rules.
  const curHp = readPropNum(target, ["current_hp", "hp"]);
  const maxHp = readPropNum(target, ["max_hp"], curHp);

  // AB → heal flip.
  if (affinity === "AB") {
    const healed = Math.max(0, damage);
    let newHp = curHp;
    if (healed > 0) {
      newHp = Math.min(maxHp, curHp + healed);
      await target.update({ "system.props.current_hp": newHp });
      log(`${prefix}absorbed ${healed} on ${targetName}: ${curHp} → ${newHp} (heal)${logSuffix}`);
      fireAbsorbVfx({ tokenUuid, amount: newHp - curHp });
      _pushLog({ resource: "hp", affinity: "AB", value: healed, valueDirection: "recover", bands: { hp: { from: curHp, to: newHp } } });
    } else {
      log(`${prefix}no HP change for ${targetName} [AB]${logSuffix} (damage was ${damage})`);
    }
    return { resource: "hp", finalValue: healed, valueDirection: "recover", fired: [] };
  }

  // Normal damage path.
  if (damage > 0) {
    // ── Shield absorption (RAW: Shield soaks damage before HP) ──
    // `shield_value` is a temporary buffer; incoming damage hits it first and
    // only the overflow reaches HP. Absorbs all damage types (shield_type is
    // cosmetic for now). Batched into the same actor.update as the HP write.
    const curShield = readPropNum(target, ["shield_value"], 0);
    let toHp = damage;
    let absorbed = 0;
    let newShield = curShield;
    if (curShield > 0) {
      absorbed = Math.min(curShield, damage);
      newShield = curShield - absorbed;
      toHp = damage - absorbed;
      log(`${prefix}shield absorbed ${absorbed} on ${targetName}: shield ${curShield} → ${newShield}${logSuffix}`);
      fireResourceLossVfx({ tokenUuid, resource: "shield", amount: absorbed, affinity });
    }

    // Fully absorbed — only the shield changed; HP untouched.
    if (toHp <= 0) {
      await target.update({ "system.props.shield_value": newShield });
      _pushLog({ resource: "shield", affinity, value: damage, valueDirection: "loss", bands: { shield: { from: curShield, to: newShield }, hp: { from: curHp, to: curHp } } });
      return { resource: "hp", finalValue: damage, valueDirection: "loss", fired: [], shieldAbsorbed: absorbed };
    }

    // Overflow → HP, via the reaction AEs (Mercy clamp etc.).
    const { newHp, consumedAeIds, fired } = await resolveDamageReactions({ target, curHp, rawDamage: toHp });
    const update = { "system.props.current_hp": newHp };
    if (absorbed > 0) update["system.props.shield_value"] = newShield;
    await target.update(update);
    for (const aeId of consumedAeIds) {
      const ae = target.effects?.get?.(aeId);
      if (ae) {
        try { await ae.delete(); }
        catch (e) { warn("applyDamageToTarget: consume AE delete failed", e); }
      }
    }
    const reactionNote = fired.length ? ` (reactions: ${fired.map((f) => f.aeName).join(", ")})` : "";
    const shieldNote = absorbed > 0 ? ` [shield −${absorbed}]` : "";
    log(`${prefix}applied ${toHp} dmg to ${targetName} [${affinity}]: ${curHp} → ${newHp}${shieldNote}${reactionNote}${logSuffix}`);
    fireResourceLossVfx({ tokenUuid, resource: "hp", amount: curHp - newHp, affinity });
    _pushLog({ resource: "hp", affinity, value: damage, valueDirection: "loss", bands: { hp: { from: curHp, to: newHp }, shield: { from: curShield, to: newShield } } });
    return {
      resource: "hp",
      finalValue: Math.max(0, curHp - newHp) + absorbed,
      valueDirection: "loss",
      fired,
      shieldAbsorbed: absorbed,
    };
  }

  // Immune (IM) zeroed the damage — fire the immune cue so the hit isn't silent
  // (other 0-damage cases, e.g. a 0 roll, stay quiet).
  if (affinity === "IM") {
    fireImmuneVfx({ tokenUuid });
    _pushLog({ resource: "hp", affinity: "IM", value: 0, valueDirection: "none", noEffectReason: "Immune", bands: { hp: { from: curHp, to: curHp } } });
  }
  log(`${prefix}no HP change for ${targetName} [${affinity}]${logSuffix} (damage was ${damage})`);
  return empty;
}

// ── Damage-type override ────────────────────────────────────────────────
//
// Three scopes, written via AE changes rows, looked up in priority order:
//   - `override_attack_damage_type` — overrides ATTACK damage only
//   - `override_spell_damage_type`  — overrides SPELL damage only
//   - `override_all_damage_type`    — overrides BOTH (catch-all)
//
// Resolution: scope-specific key first → `override_all_damage_type` →
// native (the weapon/skill's declared element).
//
// AE author writes ONE changes row depending on intent:
//   - Soul Weapon (RAW: weapon imbue): `override_attack_damage_type`
//   - Future "Pyromancer Affinity" (all spells become Fire):
//     `override_spell_damage_type`
//   - Future "Voidstrider Form" (everything is Dark):
//     `override_all_damage_type`
//
// Treats "" / "None" / null as "no override" so the sheet's default
// passes through cleanly. Backward compatibility: still reads the legacy
// `override_damage_type` key as an alias for the attack scope. That key
// is the pre-refactor name; this kept here so any old AE / migration in
// flight doesn't silently lose its override before being repathed.
export function resolveDamageElementOverride({ actor, scope, native } = {}) {
  if (!actor) return native;
  const props = actor.system?.props ?? {};
  const isReal = (v) => {
    const s = String(v ?? "").trim();
    return s && s.toLowerCase() !== "none";
  };
  const norm = (v) => String(v).trim().toLowerCase();
  // Scope-specific first.
  if (scope === "attack") {
    if (isReal(props.override_attack_damage_type)) return norm(props.override_attack_damage_type);
    // Back-compat alias.
    if (isReal(props.override_damage_type)) return norm(props.override_damage_type);
  } else if (scope === "spell") {
    if (isReal(props.override_spell_damage_type)) return norm(props.override_spell_damage_type);
  }
  // Catch-all fallback.
  if (isReal(props.override_all_damage_type)) return norm(props.override_all_damage_type);
  return native;
}

// ── Passive trigger layer (reaction_config_table-driven) ───────────────
//
// Reaction behaviors live in any item's `system.props.reaction_config_table`.
// The dispatcher walks every item on the caster (not just skill_type==="Passive"
// — buffs / equipment with reactionConfig blobs work the same way), matches rows
// by `reaction_trigger` + filters, and fires the linked `reaction_effect_ref`
// against the item's `effect_table` per the row's `reaction_passive_mode`.
//
// Row fields honored by this dispatcher:
//   reaction_trigger          — must equal the event key (e.g. "creature_completes_spell")
//   reaction_passive_mode     — force/on auto-fire, ask = clickable, off = skip
//                               (the reaction_isPassive boolean was retired 2026-06-07)
//   reaction_source           — "self" / "ally" / "enemy" filters the SUBJECT's disposition vs reactor
//   reaction_action_target    — "ally" / "enemy" / "neutral" requires at least 1 such target in payload
//   condition_formula         — optional formula gate, evaluated against the reactor
//   reaction_passive_mode     — "on" / "ask" / "off" (default "ask"); GM dialog when "ask"
//   reaction_effect_ref       — `effect_label` in the same item's `effect_table` to fire
//
// Fire ctx mirrors the action's chain ctx: reactorActor = the casting
// actor; actionTargetUuids = the action's target token UUIDs.

function dispositionOf(actorOrToken) {
  // Resolve a token document → disposition number. Tries (in order):
  //   1. Direct: actorOrToken.disposition (TokenDocument fast path)
  //   2. Canvas: token on the currently-rendered scene
  //   3. getActiveTokens: linked tokens Foundry tracks across scenes
  //   4. Cross-scene walk: any TokenDocument in any scene whose actor
  //      uuid matches. Needed when the reactor isn't on the active scene
  //      (test harness running RESOLVE off-scene, multi-scene combats).
  // Final fallback: 0 (neutral).
  if (!actorOrToken) return 0;
  if (typeof actorOrToken.disposition === "number") return actorOrToken.disposition;
  let tok = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === actorOrToken?.uuid)?.document
    ?? actorOrToken?.getActiveTokens?.()?.[0]?.document
    ?? null;
  if (!tok) {
    const targetUuid = actorOrToken?.uuid;
    const targetId   = actorOrToken?.id;
    for (const scene of game.scenes ?? []) {
      const td = scene.tokens?.find?.((t) => t.actor?.uuid === targetUuid || t.actorId === targetId);
      if (td) { tok = td; break; }
    }
  }
  return Number(tok?.disposition ?? 0);
}

// True if at least one token in `targetUuids` matches `wantDisp` relative
// to `reactorDisp`. wantDisp: "ally" | "enemy" | "neutral".
async function payloadHasTargetOfDisposition(targetUuids, reactorDisp, wantDisp) {
  for (const u of targetUuids) {
    try {
      const t = await fromUuid(u);
      if (!t) continue;
      const td = Number(t.disposition ?? 0);
      if (wantDisp === "ally" && (td === reactorDisp || td === 0)) return true;
      if (wantDisp === "enemy" && reactorDisp !== 0 && td === -reactorDisp) return true;
      if (wantDisp === "neutral" && td === 0) return true;
    } catch (_) {}
  }
  return false;
}

// True if `subjectActorUuid` matches `wantSource` (self/ally/enemy/all)
// relative to the reactor. Used for `reaction_source` filtering.
function subjectMatchesSource(wantSource, subjectActorUuid, reactorActor) {
  if (!wantSource || wantSource === "all") return true;
  if (wantSource === "self") return subjectActorUuid === reactorActor?.uuid;
  // ally/enemy need canvas tokens for both reactor + subject.
  const reactorDisp = dispositionOf(reactorActor);
  const subjTok = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === subjectActorUuid)?.document ?? null;
  const subjDisp = Number(subjTok?.disposition ?? 0);
  if (wantSource === "ally") return subjectActorUuid !== reactorActor?.uuid && (subjDisp === reactorDisp || subjDisp === 0);
  if (wantSource === "enemy") return reactorDisp !== 0 && subjDisp === -reactorDisp;
  if (wantSource === "neutral") return subjDisp === 0;
  return true;
}

// Lazy + one-shot cache-bust for the skill-formulas import. The
// runtime dispatches via dynamic-import every time it evaluates a
// condition_formula or damage_amount; without this, the boot-time
// cached skill-formulas wins forever and any new identifier (Phase 1
// of Cheap Shot added SINGLE_TARGET_ATTACK + TARGET_STATUS_COUNT)
// resolves to 0 → falsy gate → reaction silently rejected. The
// `?cb=` query forces a fresh fetch on FIRST call; subsequent calls
// reuse the cached promise. Pattern mirrors
// state-handlers.getSkillEffectsExtras (skill-canon-hardening).
let _formulaModulePromise = null;
async function getSkillFormulas() {
  if (_formulaModulePromise) return _formulaModulePromise;
  _formulaModulePromise = import("./skill-formulas.js?cb=" + Date.now());
  return _formulaModulePromise;
}

// Hard-gate match filters (source / action_target / action_intent).
// Returns false if the row doesn't apply to this trigger AT ALL — caller
// drops the row from consideration. condition_formula is intentionally
// NOT evaluated here; see evaluateConditionFormula below.
async function passesMatchFilters(row, item, reactorActor, payload) {
  // 1. Subject-side source filter (e.g. only "self" performed the action).
  const wantSource = String(row.reaction_source ?? "").trim().toLowerCase();
  const subjectActorUuid = payload?.sourceActorUuid ?? null;
  if (!subjectMatchesSource(wantSource, subjectActorUuid, reactorActor)) {
    log(`passive ${item.name}: source filter failed — wantSource="${wantSource}" subjectActorUuid="${subjectActorUuid}" reactorUuid="${reactorActor?.uuid}"`);
    return false;
  }

  // 2. Target-disposition filter — at least one ally/enemy/neutral in payload.
  const wantActionTarget = String(row.reaction_action_target ?? "").trim().toLowerCase();
  if (wantActionTarget && wantActionTarget !== "any") {
    const reactorDisp = dispositionOf(reactorActor);
    const targets = Array.isArray(payload?.targetTokenUuids) ? payload.targetTokenUuids : [];
    if (!(await payloadHasTargetOfDisposition(targets, reactorDisp, wantActionTarget))) {
      log(`passive ${item.name}: action_target filter failed — want="${wantActionTarget}" reactorDisp=${reactorDisp} targets=${targets.length}`);
      return false;
    }
  }

  // 3. Action-intent filter (harmful / aid / neutral).
  const wantIntent = String(row.reaction_action_intent ?? "").trim().toLowerCase();
  if (wantIntent) {
    const payloadIntent = String(payload?.actionIntent ?? "").trim().toLowerCase();
    if (payloadIntent !== wantIntent) {
      log(`passive ${item.name}: action_intent filter failed — want="${wantIntent}" got="${payloadIntent}"`);
      return false;
    }
  }

  // 3b. Action-kind filter — comma-list of action TYPES this reaction accepts
  //     (Attack / Skill / Spell / Item / Guard / …), matched case-insensitively
  //     against payload.actionKind. Blank = any kind. Lets a creature_performs_action
  //     reaction scope to a subset of action types without a hardcoded trigger
  //     (Shadow Possession's Creeped: "Attack,Skill,Spell"; Barrage: "Attack").
  const wantKindRaw = String(row.reaction_action_kind ?? "").trim().toLowerCase();
  if (wantKindRaw) {
    const wantKinds = wantKindRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const gotKind = String(payload?.actionKind ?? "").trim().toLowerCase();
    // FAIL-OPEN when the payload carries no actionKind: a dispatch path that
    // omits the kind must NOT silently drop the reaction (that hid the Tinkerer
    // infusion offer on attacks). Only EXCLUDE when the kind is KNOWN and
    // doesn't match — so Attack-vs-Skill scoping still works whenever the
    // dispatch supplies actionKind (creature_performs_action always does;
    // creature_will_deal_damage does too once the payload includes it).
    if (gotKind && !wantKinds.includes(gotKind)) {
      log(`passive ${item.name}: action_kind filter failed — want="${wantKindRaw}" got="${gotKind}"`);
      return false;
    }
  }

  // 3c. Source-skill name filter — the NAME of the skill whose completion fired
  //     this trigger (payload.sourceSkillName), matched case-insensitively. Blank
  //     = any (no-op for every existing row). Lets a follow-up reaction key off a
  //     SPECIFIC named skill ("after you use Crossfire …") as DATA, with no
  //     skill-name branch in the engine. Primarily for creature_completes_skill.
  const wantSkill = String(row.reaction_source_skill ?? "").trim().toLowerCase();
  if (wantSkill && String(payload?.sourceSkillName ?? "").trim().toLowerCase() !== wantSkill) {
    log(`passive ${item.name}: source_skill filter failed — want="${wantSkill}" got="${payload?.sourceSkillName}"`);
    return false;
  }

  // 4. Resource-ledger filters (creature_lose_resource / creature_gain_resource).
  //    Blank = any (no-op for every existing row). reaction_resource_filter
  //    matches payload.resource (hp/mp/ip/fp/…); reaction_cause_filter matches
  //    payload.cause (damage/cost/drain/grant/heal).
  const wantResource = String(row.reaction_resource_filter ?? "").trim().toLowerCase();
  if (wantResource && String(payload?.resource ?? "").toLowerCase() !== wantResource) {
    log(`passive ${item.name}: resource filter failed — want="${wantResource}" got="${payload?.resource}"`);
    return false;
  }
  const wantCause = String(row.reaction_cause_filter ?? "").trim().toLowerCase();
  if (wantCause && String(payload?.cause ?? "").toLowerCase() !== wantCause) {
    log(`passive ${item.name}: cause filter failed — want="${wantCause}" got="${payload?.cause}"`);
    return false;
  }
  // 5. Status-ledger filter (creature_status_applied / creature_loses_status).
  //    Blank = any. reaction_status_filter matches payload.status (e.g. "Crisis").
  //    Used by On the Hunt ("when an enemy enters Crisis").
  const wantStatus = String(row.reaction_status_filter ?? "").trim().toLowerCase();
  if (wantStatus && String(payload?.status ?? "").toLowerCase() !== wantStatus) {
    log(`passive ${item.name}: status filter failed — want="${wantStatus}" got="${payload?.status}"`);
    return false;
  }
  return true;
}

// Soft-gate condition formula. Returns `{ ok, raw, value }`:
//   - ok=true  → formula is empty OR evaluates truthy. Row is available.
//   - ok=false → formula evaluated falsy. Row exists for the trigger
//                (matched the hard gates) but is not currently usable —
//                surfaces as a disabled blade with badge.
async function evaluateConditionFormula(row, reactorActor, payload, item) {
  const condRaw = String(row.condition_formula ?? "").trim();
  if (!condRaw) return { ok: true, raw: "", value: null };
  const { evaluateFormula, buildSkillResolver } = await getSkillFormulas();
  const resolver = buildSkillResolver({ actor: reactorActor, payload, skill: item, round: 0 });
  const val = evaluateFormula(condRaw, resolver, 0);
  if (!val) log(`passive ${item?.name ?? "?"}: condition_formula="${condRaw}" → ${val} (falsy)`);
  return { ok: !!val, raw: condRaw, value: val };
}

// Combined helper preserved for callers that want the legacy "matched
// AND condition passed" boolean (firePassiveTriggers, etc.). Pre-resolve
// callers (findPassiveCandidates) split the two phases for badge surfacing.
async function shouldReactionPassiveFire(row, item, reactorActor, payload) {
  if (!(await passesMatchFilters(row, item, reactorActor, payload))) return false;
  const cond = await evaluateConditionFormula(row, reactorActor, payload, item);
  return cond.ok;
}

// ── Auto-affordability walker ─────────────────────────────────────────
//
// Statically walk an effect chain from `startLabel` and tally the
// resources it would debit on the reactor if fired. NO side effects, NO
// document writes, NO async I/O — safe to call inline from
// findPassiveCandidates' hot path.
//
// Used by the standalone reaction dispatcher to surface unaffordable
// reactions as disabled blades with "Not enough MP/HP/IP" badges instead
// of silently filtering them out. The MP-bug class (player clicks a
// reaction that has no MP, nothing happens, no feedback) is the bug
// this exists to prevent.
//
// Walks: `chain` (every step), `consume_resource` (resource tally),
// `consume_charge` (charge tally — only when on_empty defaults to
// "abort"; "skip" rows are soft, no shortfall). Does NOT walk into
// `open_action_menu` options (player choice — each option's cost is
// checked when picked). Other effect_kinds (grant, apply_ae,
// remove_tagged_ae, etc.) don't gate the reactor, so they're a no-op.
//
// consume_charge note: the walker checks the REACTOR's matching charge
// AE regardless of the row's target_ref. The canonical pattern is
// bearer-self charges (Protect / Rampart / Counterattack-style) where
// reactor == target. A non-self target_ref would over-restrict the
// blade rather than under-restrict, which is the safer failure mode.
//
// Inputs:
//   effectTable — { [key]: row } from skill.system.props.effect_table OR
//                 an AE's reactionConfig.effect_table.
//   startLabel  — effect_label of the chain's entry row.
//   actor       — the reactor whose pools / charges are checked.
//   skill       — optional carrier (skill item) for the formula resolver.
//                 Pass when available so SL / CHAR_LEVEL / HAS_SKILL_*
//                 evaluate against the right skill context.
//
// Returns:
//   { ok, debit, chargeDebit, sufficient, shortfalls, badge }
//   - ok           : chain was walkable (start row found).
//   - debit        : Record<resource, totalAmount> after walking.
//   - chargeDebit  : Record<chargeKey, totalCount> after walking.
//   - sufficient   : actor.current >= debit for every resource AND
//                    actor has >= required charges for every chargeKey.
//   - shortfalls   : [{ kind: "resource"|"charge", ... }] for failures.
//                    Resource form: { kind:"resource", resource, required, current }.
//                    Charge form:   { kind:"charge", chargeKey, required, current }.
//   - badge        : "Low MP" / "No Charge" / "Low MP, No Charge" style
//                    label, or null when ok.
// Deep Pockets et al.: an actor's `ip_reduction_value` lowers every IP SPEND
// by that much, never below 1. Mirrors command-itemCreate.buildReducedIpCost so
// BD item-create and skill-config IP spends behave identically (same store, same
// floor). Populate the store via a permanent AE (Deep Pockets).
function actorIpReduction(actor) {
  const n = Number(actor?.system?.props?.ip_reduction_value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}
function ipReducedAmount(amount, actor) {
  return amount > 0 ? Math.max(1, amount - actorIpReduction(actor)) : amount;
}

export function analyzeChainCost(effectTable, startLabel, actor, skill = null) {
  const out = {
    ok: false, debit: {}, chargeDebit: {}, variable: false,
    sufficient: true, shortfalls: [], badge: null,
  };
  if (!effectTable || typeof effectTable !== "object" || !startLabel || !actor) return out;
  const byLabel = new Map();
  for (const r of Object.values(effectTable)) {
    if (!r || r.$deleted) continue;
    const lbl = String(r.effect_label ?? "").trim();
    if (lbl) byLabel.set(lbl, r);
  }
  if (!byLabel.has(startLabel)) return out;

  const resolver = buildSkillResolver({ actor, payload: {}, skill, round: 0 });
  const seen = new Set();
  const debit = {};
  const chargeDebit = {};
  let variable = false;

  // Does `label`'s reachable chain contain a SELF resource/charge cost? Used to
  // flag choice-gated costs (open_action_menu options / confirm branches) as
  // "variable" so the picker can show e.g. "Varied" instead of undercounting.
  const hasCostUnder = (lbl, seenC = new Set()) => {
    if (!lbl || seenC.has(lbl)) return false;
    seenC.add(lbl);
    const r = byLabel.get(lbl); if (!r) return false;
    const k = String(r.effect_kind ?? "").trim().toLowerCase();
    if (k === "consume_resource") {
      const tref = String(r.target_ref ?? "self").trim() || "self";
      return tref === "self" && !!RESOURCE_PROPS[String(r.consume_resource ?? "").trim().toLowerCase()];
    }
    if (k === "consume_charge") return String(r.on_empty ?? "abort").toLowerCase() === "abort" && !!String(r.charge_key ?? "").trim();
    if (k === "chain") return parseEffectRefList(r.chain_steps).some((s) => hasCostUnder(s, seenC));
    if (k === "open_action_menu") return parseEffectRefList(r.menu_option_refs).some((s) => hasCostUnder(s, seenC));
    if (k === "confirm") return parseEffectRefList(r.confirm_button_refs).some((s) => hasCostUnder(s, seenC));
    return false;
  };

  function walk(label) {
    if (!label || seen.has(label)) return;
    seen.add(label);
    const row = byLabel.get(label);
    if (!row) return;
    const kind = String(row.effect_kind ?? "").trim().toLowerCase();
    if (kind === "consume_resource") {
      // Only the actor's OWN spend is a cost — a consume targeting an enemy
      // (e.g. an MP-drain) is a mechanic, not the caster's cost.
      const tref = String(row.target_ref ?? "self").trim() || "self";
      if (tref !== "self") return;
      const resource = String(row.consume_resource ?? row.grant_resource ?? "").trim().toLowerCase();
      const def = RESOURCE_PROPS[resource];
      if (!def) return;
      const amountRaw = row.consume_amount ?? row.grant_amount;
      let amount = Number(evaluateFormula(amountRaw, resolver, 0)) || 0;
      // IP spends honor the actor's ip_reduction_value (Deep Pockets) so the
      // "Low IP" gate matches the actually-debited cost.
      if (resource === "ip") amount = ipReducedAmount(amount, actor);
      if (amount > 0) debit[resource] = (debit[resource] ?? 0) + amount;
      return;
    }
    if (kind === "consume_charge") {
      // on_empty: "abort" (default) → missing charge fails the chain
      // → real gate. on_empty: "skip" → missing charge silently noops
      // → soft, don't surface as shortfall.
      const onEmpty = String(row.on_empty ?? "abort").trim().toLowerCase();
      if (onEmpty !== "abort") return;
      const chargeKey = String(row.charge_key ?? "").trim();
      if (!chargeKey) return;
      const count = Math.max(1, Math.floor(Number(row.count ?? 1) || 1));
      chargeDebit[chargeKey] = (chargeDebit[chargeKey] ?? 0) + count;
      return;
    }
    if (kind === "chain") {
      const steps = String(row.chain_steps ?? "")
        .split(/[,\n]+/g).map((s) => s.trim()).filter(Boolean);
      for (const s of steps) walk(s);
      return;
    }
    if (kind === "open_action_menu") {
      // Options are player choices — NOT summed into the fixed cost. But if any
      // option carries a self-cost, flag the action as variable-cost.
      if (row.free_mode !== true) {
        if (parseEffectRefList(row.menu_option_refs).some((r) => hasCostUnder(r))) variable = true;
        const inline = Array.isArray(row.menu_options) ? row.menu_options
          : (row.menu_options && typeof row.menu_options === "object" ? Object.values(row.menu_options) : []);
        if (inline.some((o) => ["consume_resource", "consume_charge"].includes(String(o?.effect_kind ?? "").toLowerCase()))) variable = true;
      }
      return;
    }
    if (kind === "confirm") {
      // Branch buttons are player choices — flag variable if any branch costs.
      if (parseEffectRefList(row.confirm_button_refs).some((r) => hasCostUnder(r))) variable = true;
      return;
    }
    // grant / apply_ae / remove_tagged_ae / leave_combat / etc.: not a gate on
    // the reactor; no-op.
  }
  walk(startLabel);

  out.ok = true;
  out.debit = debit;
  out.chargeDebit = chargeDebit;
  out.variable = variable;

  // Resource shortfalls.
  for (const [resource, required] of Object.entries(debit)) {
    const def = RESOURCE_PROPS[resource];
    if (!def) continue;
    const current = Number(actor.system?.props?.[def.prop] ?? 0) || 0;
    if (current < required) {
      out.shortfalls.push({ kind: "resource", resource, required, current });
      out.sufficient = false;
    }
  }
  // Charge shortfalls — sum the reactor's matching enabled charge AEs
  // for each required key. findChargeAEsOnActor excludes disabled AEs.
  for (const [chargeKey, required] of Object.entries(chargeDebit)) {
    const hits = findChargeAEsOnActor(actor, { key: chargeKey });
    const current = hits.reduce((acc, h) => acc + (Number(h.charges) || 0), 0);
    if (current < required) {
      out.shortfalls.push({ kind: "charge", chargeKey, required, current });
      out.sufficient = false;
    }
  }

  if (!out.sufficient) {
    // Short badge — rubber-stamp overlay has limited horizontal space.
    // Resources: "Low MP" / "Low MP/HP" (existing convention).
    // Charges:   "No Charge" (singular; players don't think of the
    //            internal chargeKey, just "the skill's charge").
    // Mixed:     "Low MP, No Charge".
    const resShort   = out.shortfalls.filter((s) => s.kind === "resource");
    const chargeShort = out.shortfalls.filter((s) => s.kind === "charge");
    const parts = [];
    if (resShort.length) {
      parts.push("Low " + resShort.map((s) => s.resource.toUpperCase()).join("/"));
    }
    if (chargeShort.length) parts.push("No Charge");
    out.badge = parts.join(", ");
  }
  return out;
}

// Resolve the four-state mode (on/ask/off/force) for a reaction-config
// passive row. Reads `reaction_passive_mode`, default "ask".
//
// Modes (per [[force-mode-for-engine-mandatory-reactions]]):
//   "on"    — auto-fire on match; surfaces as Auto chip / pill (player
//             sees what fired)
//   "ask"   — player decides (pill button / menu blade)
//   "off"   — never fires (toggle-off for intrusive passives)
//   "force" — auto-fires like "on" but UI-invisible — for engine
//             housekeeping (Protect charge refresh etc.). NOT shown
//             in pill row, NOT shown in menu, NOT shown in Passive
//             Manager toggle list.
function resolveReactionPassiveMode(row) {
  const explicit = String(row?.reaction_passive_mode ?? "").trim().toLowerCase();
  if (explicit === "on" || explicit === "ask" || explicit === "off" || explicit === "force") return explicit;
  return "ask";
}

// Note: the legacy `resolvePassiveMode(props)` shim that read top-level
// `passive_mode` / `passive_optional` was removed 2026-05-30 along with
// the template columns. Mode lives exclusively on
// `reaction_config_table[N].reaction_passive_mode` now; read it via
// `resolveReactionPassiveMode` above.

async function promptPassiveOptin(itemName, reactorActor, description) {
  if (!ui?.notifications) return true;
  if (typeof Dialog !== "function") return true;
  return new Promise((resolve) => {
    new Dialog({
      title: `Passive: ${itemName}`,
      content: `<p><strong>${reactorActor?.name ?? "Reactor"}</strong> may fire <strong>${itemName}</strong>.</p>${description ?? ""}<p><em>Apply this passive's effect now?</em></p>`,
      buttons: {
        apply: { label: "Apply", callback: () => resolve(true) },
        skip:  { label: "Skip",  callback: () => resolve(false) },
      },
      default: "apply",
      close: () => resolve(false),
    }).render(true);
  });
}

// Pre-resolve reaction candidates — same matcher as firePassiveTriggers
// but DOES NOT execute the effects. Returns the metadata the action card
// (or token-anchored reaction menu) needs to surface reaction options
// before Confirm:
//   { carrierKind, carrierUuid, carrierName, rowKey, mode, kind, ref,
//     carrierImg, carrierDescription }
//
// Modes (passive only — manual reactions ignore this and always require
// a click):
//   "on"  → caller treats as auto-accepted (renders as Auto chip, applied
//           on resolve)
//   "ask" → caller renders as clickable; pending player decision
//   "off" → caller auto-rejects (not rendered, not applied)
//
// Kinds (DERIVED from `reaction_passive_mode` — the reaction_isPassive
// boolean was retired 2026-06-07):
//   "passive" → mode on/force/off. on/force auto-fire; off auto-rejected.
//   "manual"  → mode ask. Requires the player to click; surfaces in the
//               menu as an active blade. (Kept as a label for downstream
//               readers; it is purely `mode === "ask"`.)
//
// Classify a reaction row as "action-creating" or "state-only" by
// walking its effect chain from `reaction_effect_ref` through any
// `chain` / `open_action_menu` references. An action-creating reaction
// is one whose acceptance would spawn a player-driven action — a free
// action (open_action_menu free_mode) OR (future) a post-resolve card
// like Counterattack. State-only reactions resolve immediately
// (apply_ae, grant, modify_damage_taken, etc.).
//
// Used by the multi-reactor dispatch orchestrator: action-creating
// reactions are EXCLUSIVE (one runs at a time, others' pills show
// "<actor> Acting" until re-gate); state-only reactions are
// CONCURRENT (fire freely).
//
// Effect_kinds that mark a row as action-creating:
//   - `open_action_menu` with `free_mode: true` → enqueues free action
//   - (future) `spawn_action_card` / `post_resolve_card` etc.
//
// Returns `true` if any reachable effect in the chain is action-creating.
export function isActionCreatingReaction(item, reactionRow) {
  if (!item || !reactionRow) return false;
  const startRef = String(reactionRow.reaction_effect_ref ?? "").trim();
  if (!startRef) return false;

  // Build a lookup of effect rows by label from item's effect_table.
  const table = item.system?.props?.effect_table ?? {};
  const byLabel = new Map();
  for (const r of Object.values(table)) {
    if (!r || r.$deleted) continue;
    const label = String(r.effect_label ?? "").trim();
    if (label) byLabel.set(label, r);
  }
  // Also walk inline `menu_options` arrays for open_action_menu rows;
  // each option carries its own effect_kind which could be action-
  // creating.
  function rowIsActionCreating(row) {
    if (!row) return false;
    const kind = String(row.effect_kind ?? "").trim().toLowerCase();
    // open_action_menu with free_mode → enqueues free action via FREE_ACTION_WINDOW
    if (kind === "open_action_menu" && row.free_mode === true) return true;
    // free_action ALWAYS enqueues a free action (its whole purpose)
    if (kind === "free_action") return true;
    // Future post-resolve card spawns wire here. Add new effect_kinds
    // to this list as they ship.
    // if (kind === "spawn_action_card") return true;
    return false;
  }

  const seen = new Set();
  const queue = [startRef];
  while (queue.length) {
    const label = queue.shift();
    if (seen.has(label)) continue;
    seen.add(label);
    const row = byLabel.get(label);
    if (!row) continue;
    if (rowIsActionCreating(row)) return true;
    const kind = String(row.effect_kind ?? "").trim().toLowerCase();
    // Chain: walk every step.
    if (kind === "chain") {
      const steps = String(row.chain_steps ?? "").split(/[,\n]/).map(s => s.trim()).filter(Boolean);
      for (const s of steps) queue.push(s);
      continue;
    }
    // open_action_menu (non-free_mode): walk both refs form + inline.
    if (kind === "open_action_menu") {
      const refs = String(row.menu_option_refs ?? "").split(/[,\n]/).map(s => s.trim()).filter(Boolean);
      for (const ref of refs) queue.push(ref);
      const opts = row.menu_options;
      const inline = Array.isArray(opts) ? opts
        : (opts && typeof opts === "object" ? Object.values(opts) : []);
      for (const opt of inline) {
        if (opt && typeof opt === "object" && rowIsActionCreating(opt)) return true;
      }
    }
  }
  return false;
}

// AE-borne reactions (carrier is an AE, not an Item). Same walker,
// reads from the AE's flags.fabula-ultima-companion.reactionConfig.
export function isActionCreatingReactionForAE(ae, reactionRow) {
  if (!ae || !reactionRow) return false;
  const cfg = ae.flags?.[FLAG_NS]?.reactionConfig;
  const fakeItem = { system: { props: { effect_table: cfg?.effect_table ?? {} } } };
  return isActionCreatingReaction(fakeItem, reactionRow);
}

// Single-mode model (2026-06-07): every matching non-deleted row is
// returned regardless of mode — the caller surfaces it per its
// `reaction_passive_mode` (off = auto-reject, ask = clickable, on/force =
// auto). The old `includeManual` filter (which dropped manual rows) is gone.
//
// `includeUnavailable` (default false) controls whether reactions that
// pass the hard match gates BUT fail their condition_formula or chain
// affordability check are returned. Default behavior (legacy) drops them
// for callers that just want "what can fire right now" — Cheap Shot
// pre-passive aggregator, etc. The standalone-reaction dispatcher opts
// in with `includeUnavailable: true` so it can surface them as disabled
// blades with badges ("Not enough MP" / "Conditions not met") rather
// than silently filtering them — the player gets visible feedback for
// WHY the reaction isn't usable.
//
// Each returned candidate carries:
//   { ..., available: boolean, unavailableReason: string|null }
// `available: false` candidates are still in the array; the caller
// decides how to render them.
// Weapons now carry reaction_config_table (Option B — weapons are skill-shaped
// action sources). Unlike skills/AEs, a weapon's reactions are only live when
// the weapon is actually in play, so we gate weapon-type carriers:
//
//   - The ACTING creature (the one whose action fired this trigger — i.e.
//     casterActor === payload.sourceActorUuid) only fires the weapon that
//     struck. payload.weaponUuid identifies it, so a second equipped weapon
//     (two-weapon) or an inventory weapon doesn't also fire its on-hit row.
//   - A BYSTANDER reactor (target / ally reacting to someone else's action)
//     fires its own EQUIPPED weapons; payload.weaponUuid belongs to the
//     attacker and must not gate the bystander's gear out.
//   - No weapon context (lifecycle triggers etc.) → equipped weapons only.
//
// Non-weapon carriers (skills, equipment, accessories, AEs) are never gated.
function weaponReactionInPlay(item, payload, casterActor) {
  if (String(item?.system?.props?.item_type ?? "").toLowerCase() !== "weapon") return true;
  const usedUuid = payload?.weaponUuid ?? null;
  const actingActorUuid = payload?.sourceActorUuid ?? null;
  const reactorIsActor = !!actingActorUuid && casterActor?.uuid === actingActorUuid;
  if (usedUuid && reactorIsActor) return item.uuid === usedUuid;
  return item?.system?.props?.isEquipped === true;
}

// NOTE: the old `skillActionPassiveApplies` item-level gate (which used an
// item's `skill_type` to decide whether its reaction rows were "ambient" vs.
// "self-scoped to the acting skill") was REMOVED 2026-06-15. `skill_type`
// conflates "is this skill invokable?" with "should this reaction fire on
// other actions?" — two orthogonal axes — which silently hid ambient reaction
// skills (Warning Shot / Gadgets / Barrage, all skill_type "Active") on basic
// attacks because their UUID didn't match the acting weapon's.
//
// Self-scoping is now a PER-ROW config concern: a reaction row that should
// only fire when its own skill is the acting one sets `reaction_source_skill`
// to that skill's name (matched against `payload.sourceSkillName` in
// passesMatchFilters). Riders (Fiery Onslaught's blaze_chain, monster on-hit
// effects) set it; ambient reactions leave it blank. `weaponReactionInPlay`
// still handles weapon-item two-weapon scoping (unrelated to skill_type).

// Does the effect reached by `ref` (following one level of chain steps) include
// an `add_target` row? Used to tag ONLY Barrage-style add_target reactions for
// the onAddTargetApply path — other creature_performs_action reactions (Creeped
// negate/buff) resolve as ordinary pre-resolve pills.
function effectRefUsesAddTarget(effectTable, ref, depth = 0) {
  if (!effectTable || !ref || depth > 8) return false;
  const row = Object.values(effectTable).find((r) => r?.effect_label === ref && !r?.$deleted);
  if (!row) return false;
  if (row.effect_kind === "add_target") return true;
  if (row.effect_kind === "chain") {
    return String(row.chain_steps ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
      .some((s) => effectRefUsesAddTarget(effectTable, s, depth + 1));
  }
  return false;
}

export async function findPassiveCandidates({ casterActor, trigger, payload, includeUnavailable = false }) {
  if (!casterActor || !trigger) return [];
  const out = [];

  // Single-mode model (reaction_isPassive retired 2026-06-07): every row's
  // behavior comes from `reaction_passive_mode` ∈ {force, on, ask, off}.
  // `kind` is derived (ask → "manual" pill, on/force/off → "passive") only
  // for back-compat with downstream readers; the auth-time manual/passive
  // split and the `includeManual` filter are gone — every matching non-deleted
  // row surfaces here, and the mode decides how (off is auto-rejected by the
  // caller). See [[reaction-passive-mode-single-field]].
  function shouldKeep(row) {
    if (!row || row.$deleted) return false;
    if (String(row.reaction_trigger ?? "").trim() !== trigger) return false;
    return true;
  }
  function modeFor(row) {
    return resolveReactionPassiveMode(row);
  }
  function kindForMode(mode) {
    return mode === "ask" ? "manual" : "passive";
  }

  // Evaluate availability for a row that already passed the hard match
  // gates. Returns { available, unavailableReason }.
  //
  // Cost-walker wins over condition_formula failure when both indicate
  // unavailable — the cost badge is more specific. condition_formula
  // failure that ISN'T a cost issue falls back to "Conditions not met".
  async function evaluateAvailability(row, effectTable, refLabel, carrierForFormula) {
    const cost = analyzeChainCost(effectTable, refLabel, casterActor, carrierForFormula);
    if (cost.ok && !cost.sufficient) {
      return { available: false, unavailableReason: cost.badge };
    }
    const cond = await evaluateConditionFormula(row, casterActor, payload, carrierForFormula);
    if (!cond.ok) {
      return { available: false, unavailableReason: "Conditions not met" };
    }
    return { available: true, unavailableReason: null };
  }

  for (const item of casterActor.items?.contents ?? []) {
    const rc = item.system?.props?.reaction_config_table;
    if (!rc || typeof rc !== "object") continue;
    if (!weaponReactionInPlay(item, payload, casterActor)) continue;
    const effectTable = item.system?.props?.effect_table ?? {};
    for (const key of Object.keys(rc)) {
      const row = rc[key];
      if (!shouldKeep(row)) continue;
      if (!(await passesMatchFilters(row, item, casterActor, payload))) continue;
      const refLabel = String(row.reaction_effect_ref ?? "").trim();
      const { available, unavailableReason } =
        await evaluateAvailability(row, effectTable, refLabel, item);
      if (!includeUnavailable && !available) continue;
      const mode = modeFor(row);
      out.push({
        carrierKind: "item",
        carrierUuid: item.uuid,
        carrierName: item.name,
        carrierImg:  item.img,
        carrierDescription: item.system?.props?.description ?? "",
        rowKey: key,
        kind: kindForMode(mode),
        mode,
        ref: refLabel,
        usesAddTarget: effectRefUsesAddTarget(effectTable, refLabel),
        available,
        unavailableReason,
      });
    }
  }
  for (const ae of casterActor.effects?.contents ?? []) {
    if (ae.disabled) continue;
    const cfg = ae.flags?.[FLAG_NS]?.reactionConfig;
    if (!cfg || typeof cfg !== "object") continue;
    const rc = cfg.reaction_config_table;
    if (!rc || typeof rc !== "object") continue;
    const effectTable = cfg.effect_table ?? {};
    const fakeItem = { name: ae.name, system: { props: { effect_table: effectTable } } };
    for (const key of Object.keys(rc)) {
      const row = rc[key];
      if (!shouldKeep(row)) continue;
      if (!(await passesMatchFilters(row, ae, casterActor, payload))) continue;
      const refLabel = String(row.reaction_effect_ref ?? "").trim();
      const { available, unavailableReason } =
        await evaluateAvailability(row, effectTable, refLabel, fakeItem);
      if (!includeUnavailable && !available) continue;
      const mode = modeFor(row);
      out.push({
        carrierKind: "ae",
        carrierUuid: ae.uuid,
        carrierName: ae.name,
        carrierImg:  ae.icon ?? ae.img,
        carrierDescription: ae.description ?? "",
        rowKey: key,
        kind: kindForMode(mode),
        mode,
        ref: refLabel,
        usesAddTarget: effectRefUsesAddTarget(effectTable, refLabel),
        available,
        unavailableReason,
      });
    }
  }
  return out;
}

// Fire a single pre-evaluated candidate, given the same payload that
// findPassiveCandidates was called with. Used by the resolve path to
// apply pre-accepted candidates. Mirrors the dispatch in
// firePassiveTriggers' main loop, minus the matcher/mode gating
// (caller has already done both).
export async function firePreAcceptedCandidate({ director, casterActor, candidate, payload }) {
  if (!candidate?.ref) return { ok: false, reason: "no-ref" };
  const { makeChainContext } = await import("./skill-targeting.js");
  const reactorToken = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === casterActor.uuid)?.document
    ?? casterActor?.getActiveTokens?.()?.[0]?.document ?? null;
  let runtimeEffectTable;
  let firePoints;
  let skillForCtx;
  let carrier;
  let aeReactionCfg = null;  // Captured for AE post-fire bookkeeping below.
  if (candidate.carrierKind === "item") {
    carrier = await fromUuid(candidate.carrierUuid);
    if (!carrier) return { ok: false, reason: "carrier-gone" };
    const { getRuntimeSkillView } = await import("./skill-recipes.js");
    const view = getRuntimeSkillView(carrier);
    runtimeEffectTable = view.effect_table;
    firePoints = view.fire_points;
    skillForCtx = carrier;
  } else {
    carrier = await fromUuid(candidate.carrierUuid);
    if (!carrier) return { ok: false, reason: "carrier-gone" };
    aeReactionCfg = carrier.flags?.[FLAG_NS]?.reactionConfig ?? {};
    runtimeEffectTable = aeReactionCfg.effect_table ?? aeReactionCfg.reaction_effect_table ?? {};
    firePoints = null;
    skillForCtx = null;
  }
  const ctx = makeChainContext({
    reactorActor: casterActor,
    reactorToken,
    skill: skillForCtx,
    dCombat: director?.dCombat ?? null,
    director: director ?? null,
    // Carrier identity for itemized resource-ledger lines (originLabel/Uuid):
    // the AE or item running these effects (e.g. "Burn").
    sourceLabel: carrier?.name ?? null,
    sourceUuid: carrier?.uuid ?? null,
    payload,
    // Pass the action's target list through — `target_ref:
    // "ally_action_targets"` (Healing Power) + `hit_action_targets`
    // (Support Magic) resolve via these. Without them, the targeting
    // candidate list is empty and the grant/apply_ae no-ops silently.
    //
    // Accepts both naming conventions: `targetTokenUuids`/`hitTargetTokenUuids`
    // (legacy firePassiveTriggers payloads) and `targets`/`hitTargets`
    // (newer creature_deals_damage payloads).
    actionTargetUuids: payload?.targetTokenUuids ?? payload?.targets ?? [],
    hitActionTargetUuids:
      payload?.hitTargetTokenUuids
      ?? payload?.hitTargets
      ?? payload?.targetTokenUuids
      ?? payload?.targets
      ?? [],
    firePoints,
    runtimeEffectTable,
    isPassive: true,
    // Replay menu picks the player already made at Apply-click
    // (previewReactionMenu cached them on the candidate). With these set,
    // open_action_menu dispatches the chosen options without re-prompting.
    menuPicks: Array.isArray(candidate.chosenMenuPicks) ? candidate.chosenMenuPicks : null,
  });
  const r = await applyEffectByLabel(candidate.ref, ctx);

  // ── AE post-fire bookkeeping ─────────────────────────────────────────
  // Moved here from firePassiveTriggers so EVERY dispatch path (standalone
  // ReactionMenu, post-resolve firePassiveTriggers, pre-resolve pill accept)
  // honors consume_self / charges semantics. Signals supported:
  //   - row.consume_self === true       → unconditional delete after fire
  //   - effRow.consume_self === true    → effect-row-driven delete
  //   - AE carries charges flag AND its Expiry is "After effect activation"
  //     (lifetimeMode === "on_activation") → decrement; auto-delete at 0.
  // The expiry gate is what lets a charge-bearing AE NOT consume on fire:
  // e.g. a Poison that stacks (charges = intensity) but expires by turn-tick
  // uses lifetimeMode "" / "round_end" so its charges persist. Only the
  // "on_activation" expiry (Burn, Hawkeye, Protect refills, …) consumes here.
  if (candidate.carrierKind === "ae" && r?.ok && carrier) {
    try {
      const row = aeReactionCfg?.reaction_config_table?.[candidate.rowKey] ?? null;
      const effRow = candidate.ref
        ? Object.values(runtimeEffectTable ?? {}).find((er) => er?.effect_label === candidate.ref)
        : null;
      const consumeSelfFlag = row?.consume_self === true || effRow?.consume_self === true;
      const chargeFlags = carrier.flags?.[FLAG_NS] ?? {};
      const lifetimeMode = String(chargeFlags.lifetimeMode ?? "").trim().toLowerCase();
      const hasCharges = chargeFlags.charges != null || chargeFlags.chargesMax != null;
      if (consumeSelfFlag) {
        try {
          await carrier.delete();
          log(`firePreAcceptedCandidate: ${candidate.carrierName} consume_self → AE deleted`);
        } catch (e) { warn("consume_self delete failed", e); }
      } else if (hasCharges && lifetimeMode === "on_activation") {
        const { consume: consumeCharge } = await import("./skill-charges.js");
        const res = await consumeCharge(carrier, { count: 1 });
        log(`firePreAcceptedCandidate: ${candidate.carrierName} charge consumed (remaining=${res?.remaining ?? "?"}, deleted=${!!res?.deleted})`);
      }
    } catch (e) {
      warn("firePreAcceptedCandidate: AE post-fire bookkeeping threw", e);
    }
  }

  return { ok: !!r?.ok, kind: r?.kind, applied: r?.applied, reason: r?.reason ?? null, abort: !!r?.abort };
}

// ── Unified damage adjustment (effect_kind: "adjust_damage") ─────────────
// One kind replaces the former `add_damage` (outgoing/sender-side) and
// `modify_damage_taken` (incoming/receiver-side). Every row is:
//   { effect_kind: "adjust_damage",
//     damage_operation: "add"|"subtract"|"multiply"|"set"|"cap"|"floor",
//     damage_amount:    <formula>,          // the operand
//     damage_stage:     "outgoing"|"incoming" }   // default "outgoing"
// "outgoing" rows adjust the attacker's base damage pre-resolve (read by
// computeSenderDamageBonuses); "incoming" rows adjust the landed damage at
// HP-write (read by resolveDamageReactions). `cap` = upper bound, `floor` =
// lower bound. Mercy ("survive at 1") = incoming cap at `CUR_HP - 1`.
const DAMAGE_OPS = new Set(["add", "subtract", "multiply", "set", "cap", "floor"]);
export function applyDamageOp(d, op, amount) {
  switch (op) {
    case "add":      return d + amount;
    case "subtract": return d - amount;
    case "multiply": return d * amount;
    case "set":      return amount;
    case "cap":      return Math.min(d, amount); // upper bound
    case "floor":    return Math.max(d, amount); // lower bound
    default:         return d;
  }
}
function readAdjustRow(row) {
  return {
    op: String(row.damage_operation ?? "add").trim().toLowerCase(),
    amountFormula: String(row.damage_amount ?? "0"),
    stage: String(row.damage_stage ?? "outgoing").trim().toLowerCase(),
  };
}

// Phase 2: sender-side damage accumulator for pre-resolve outgoing
// adjust_damage candidates (Cheap Shot, Hawkeye, Warning Shot et al.).
//
// Walks the accepted pre-resolve candidates and finds every effect row
// of `effect_kind: "add_damage"`. For each, evaluates `damage_amount`
// against the candidate's payload + carrier skill and accumulates a
// **base-damage** bonus on the candidate's subject (the specific hit
// target). Returns Map<subjectActorUuid, totalBaseDamageBonus>.
//
// The result feeds `recomputePerTargetDamages` below, which produces a
// new perTargetResults array with `damage` re-derived from
// `applyAffinityToDamage(rawDamage + bonus, affinity)`. So affinity
// re-applies once over the combined total — the user's "base damage,
// affinity applied once" rule.
//
// Candidate shape (as augmented by the per-target dispatch in Phase 3):
//   {
//     ...findPassiveCandidates fields...,
//     subjectActorUuid,         // which target this candidate targets
//     subjectTokenUuid,
//     payloadAtFire,            // the payload at trigger fire-time
//                               // (carries rawDamage, damageType, etc.)
//   }
//
// dCombat.round threads through to the resolver so ROUND-aware formulas
// (and SL via the carrier skill's level) resolve cleanly.
export async function computeSenderDamageBonuses({
  casterActor,
  acceptedPrePassives,
  dCombat,
} = {}) {
  const out = new Map();
  if (!Array.isArray(acceptedPrePassives) || !acceptedPrePassives.length) return out;

  // Per-subject base (pre-bonus) damage — used to project FINAL_DAMAGE for any
  // keyword condition gates (e.g. pierce "FINAL_DAMAGE >= 100"). Same value the
  // recompute starts each entry from (entry.rawDamage).
  const subjectBaseRaw = new Map();

  for (const cand of acceptedPrePassives) {
    if (!cand?.ref) continue;
    // Carrier resolution mirrors firePreAcceptedCandidate so item-bound
    // and AE-bound effects both work. Bail on missing carriers — a
    // deleted skill mid-resolve shouldn't crash the recompute pass.
    let runtimeEffectTable;
    let carrierSkill = null;
    if (cand.carrierKind === "item") {
      const carrier = await fromUuid(cand.carrierUuid).catch(() => null);
      if (!carrier) continue;
      const { getRuntimeSkillView } = await import("./skill-recipes.js");
      const view = getRuntimeSkillView(carrier);
      runtimeEffectTable = view.effect_table;
      carrierSkill = carrier;
    } else {
      const carrier = await fromUuid(cand.carrierUuid).catch(() => null);
      if (!carrier) continue;
      const cfg = carrier.flags?.[FLAG_NS]?.reactionConfig ?? {};
      runtimeEffectTable = cfg.effect_table ?? cfg.reaction_effect_table ?? {};
      carrierSkill = null;
    }
    // Walk from cand.ref through the effect table, summing every
    // add_damage row reachable via chain steps. Handles both the simple
    // case (cand.ref points directly to an add_damage row) and the
    // chained case (cand.ref points to a chain that contains add_damage
    // rows — e.g. Salamander Blaze: blaze_chain → blaze_damage + blaze_consume).
    let subjectUuids;
    if (Array.isArray(cand.appliesToTargetUuids) && cand.appliesToTargetUuids.length) {
      subjectUuids = cand.appliesToTargetUuids;
    } else {
      const single = String(cand.subjectActorUuid ?? cand.payloadAtFire?.subjectActorUuid ?? "").trim();
      if (!single) continue;
      subjectUuids = [single];
    }

    // Effect-table label map — static across subjects, built once.
    const byLabel = new Map();
    for (const r of Object.values(runtimeEffectTable ?? {})) {
      if (!r || r.$deleted) continue;
      const lbl = String(r.effect_label ?? "").trim();
      if (lbl) byLabel.set(lbl, r);
    }

    // Evaluate the outgoing ops PER SUBJECT so per-target formulas
    // (TARGET_AE_CHARGES_*, TARGET_*) resolve against EACH subject's own state.
    // A multi-target Blaze (Fiery Onslaught: +5×each target's OWN Burn) yields a
    // different bonus per target; evaluating once off payloadAtFire would apply
    // the first hit target's value to every subject. Single-subject candidates
    // and flat ops (Hawkeye +N) are unaffected — same amount, re-derived.
    const candBaseRaw = Number(cand.payloadAtFire?.rawDamage ?? cand.payload?.rawDamage);
    let formulas = null;
    try { formulas = await getSkillFormulas(); }
    catch (e) { warn(`computeSenderDamageBonuses: getSkillFormulas threw`, e); }
    for (const uuid of subjectUuids) {
      const ops = []; // ordered outgoing damage operations for THIS subject
      if (formulas) {
        try {
          const { buildSkillResolver, evaluateFormula } = formulas;
          const resolver = buildSkillResolver({
            actor: casterActor,
            payload: { ...(cand.payloadAtFire ?? {}), subjectActorUuid: uuid },
            skill: carrierSkill,
            round: dCombat?.round ?? 0,
          });
          const seen = new Set();
          const walkDamage = (label) => {
            if (!label || seen.has(label)) return;
            seen.add(label);
            const row = byLabel.get(label);
            if (!row) return;
            const kind = String(row.effect_kind ?? "").toLowerCase();
            if (kind === "adjust_damage") {
              const { op, amountFormula, stage } = readAdjustRow(row);
              if (stage !== "outgoing" || !DAMAGE_OPS.has(op)) return; // incoming handled receiver-side
              const amount = Number(evaluateFormula(amountFormula, resolver)) || 0;
              // `source` lets the action-card damage breakdown attribute this
              // in-flight bonus to its carrier (e.g. Bite's +50%-vs-Grappled) instead
              // of silently folding it into the per-target total. See action-profile
              // projectProfileToActionResult / buildPerTarget.
              ops.push({ op, amount, source: cand.carrierName || carrierSkill?.name || "Reaction" });
            } else if (kind === "apply_action_keyword") {
              // Tag the hit with an action keyword (pierce, …). Carried as a
              // non-numeric op so recomputePerTargetDamages can apply its damage-calc
              // effect after the numeric ops. Extensible: new keywords are new strings.
              const kw = String(row.action_keyword ?? "").trim().toLowerCase();
              // Optional gate evaluated AFTER the numeric ops (Phase 2 below), so the
              // formula can reference FINAL_DAMAGE (the post-bonus, pre-affinity hit).
              const condition = String(row.condition_formula ?? "").trim() || null;
              if (kw) ops.push({ op: "keyword", keyword: kw, condition, source: cand.carrierName || carrierSkill?.name || "Keyword" });
            } else if (kind === "change_damage_element") {
              // Override the in-flight attack's element for THIS subject (Tinkerer
              // Infusions: Cryo→ice, Pyro→fire, …). The element is a literal
              // ("ice") or a VAR_<NAME> chain-var (a prompt_element pick). Affinity
              // for the new element is resolved per-subject AFTER the walk (needs
              // the victim's sheet — async). Carried as a non-numeric op so the
              // recompute applies it together with the +5 (one affinity pass).
              const rawEl = String(row.change_element ?? row.damage_element ?? row.element ?? "").trim();
              let element = rawEl.toLowerCase();
              if (/^var_/i.test(rawEl)) {
                const vkey = rawEl.slice(4).toLowerCase().trim();
                const v = cand.payloadAtFire?._chainVars?.[vkey] ?? cand.payload?._chainVars?.[vkey];
                element = String(v ?? "").trim().toLowerCase();
              }
              if (element) ops.push({ op: "element", element, source: cand.carrierName || carrierSkill?.name || "Infusion" });
            } else if (kind === "chain") {
              const steps = String(row.chain_steps ?? "").split(/[,\n]+/g).map((s) => s.trim()).filter(Boolean);
              for (const s of steps) walkDamage(s);
            } else if (kind === "open_action_menu") {
              // Follow the player's CHOSEN option(s) — captured at apply-click on
              // cand.chosenMenuPicks (by display label) — so a menu that selects
              // WHICH damage modifier to apply (Tinkerer Infusions: pick "Pyro" →
              // its fire-element + 5 chain) feeds the recompute. Unchosen options
              // are NOT walked (else every infusion's +5 would stack). With no
              // captured pick we can't know which → walk nothing.
              const picks = Array.isArray(cand.chosenMenuPicks) ? cand.chosenMenuPicks : [];
              if (picks.length) {
                const optRefs = parseEffectRefList(row.menu_option_refs);
                const optLabels = (row.menu_option_labels == null || String(row.menu_option_labels).trim() === "")
                  ? [] : String(row.menu_option_labels).split("|").map((s) => s.trim());
                const labelToRef = new Map();
                for (let oi = 0; oi < optRefs.length; oi++) {
                  const oref = optRefs[oi];
                  const orow = byLabel.get(oref);
                  const lbl = (optLabels[oi] && optLabels[oi] !== "")
                    ? optLabels[oi] : String(orow?.menu_label ?? orow?.effect_label ?? oref);
                  labelToRef.set(String(lbl).trim().toLowerCase(), oref);
                }
                for (const pk of picks) {
                  const oref = labelToRef.get(String(pk).trim().toLowerCase());
                  if (oref) walkDamage(oref);
                }
              }
            }
          };
          walkDamage(cand.ref);
        } catch (e) {
          warn(`computeSenderDamageBonuses: adjust_damage eval threw on ${cand.carrierName}`, e);
          ops.length = 0;
        }
      }
      if (!ops.length) continue;
      // Resolve the new-element affinity per subject (async — reads the victim's
      // affinity_<slot>). Done here (not in walkDamage, which is sync) so the
      // recompute can apply the chosen element's affinity to (raw + numeric ops).
      const elementOps = ops.filter((o) => o.op === "element" && o.affinity === undefined);
      if (elementOps.length) {
        const subjectActor = await fromUuid(uuid).catch(() => null);
        for (const eop of elementOps) {
          eop.affinity = subjectActor ? resolveAffinity(subjectActor, eop.element) : "NE";
        }
      }
      out.set(uuid, (out.get(uuid) ?? []).concat(ops));
      if (Number.isFinite(candBaseRaw) && !subjectBaseRaw.has(uuid)) subjectBaseRaw.set(uuid, candBaseRaw);
    }
  }

  // Phase 2 — resolve keyword condition gates against FINAL_DAMAGE (the
  // post-numeric-ops, pre-affinity hit — what the recompute will produce). A
  // keyword op with a `condition` is kept only if it passes; unconditional
  // keyword ops always pass. This is where "pierce when FINAL_DAMAGE >= 100"
  // fires AFTER the ×Kill-Frenzy multiply (which a discovery-time reaction
  // condition couldn't see).
  for (const [uuid, ops] of out) {
    if (!ops.some((o) => o.op === "keyword" && o.condition)) continue;
    const numeric = ops.filter((o) => o.op !== "keyword" && o.op !== "element");
    let d = Number(subjectBaseRaw.get(uuid)) || 0;
    for (const { op, amount } of numeric) d = applyDamageOp(d, op, amount);
    d = Math.max(0, Math.floor(d));
    let resolver = null;
    try {
      const { buildSkillResolver, evaluateFormula } = await getSkillFormulas();
      const kept = [];
      for (const o of ops) {
        if (o.op !== "keyword" || !o.condition) { kept.push(o); continue; }
        if (!resolver) resolver = buildSkillResolver({ actor: casterActor, payload: { finalDamage: d }, round: dCombat?.round ?? 0 });
        if (Number(evaluateFormula(o.condition, resolver, 0))) kept.push(o);
      }
      out.set(uuid, kept);
    } catch (e) {
      warn(`computeSenderDamageBonuses: keyword condition eval threw`, e);
    }
  }
  return out;
}

// Phase 2: produce a recomputed perTargetResults array given a bonus
// map from computeSenderDamageBonuses. For each entry:
//   newRaw = entry.rawDamage + bonus
//   newDamage = applyAffinityToDamage(newRaw, entry.affinity)
// Entries without a bonus pass through unchanged (referential equality
// preserved per-entry so DOM diffs stay minimal). Returns a new array
// — callers (CONFIRM preview + RESOLVE applier) re-freeze actionResult
// with this so downstream reads see the modified values.
//
// `applyAffinity` is injected so this helper stays decoupled from the
// snapshot module (snapshot has the affinity table). state-handlers
// passes `applyAffinityToDamage` from snapshot.js at call sites.
export function recomputePerTargetDamages(perTargetResults, opsMap, applyAffinity) {
  if (!Array.isArray(perTargetResults) || !perTargetResults.length) return perTargetResults;
  if (!opsMap || opsMap.size === 0) return perTargetResults;
  if (typeof applyAffinity !== "function") {
    warn("recomputePerTargetDamages: applyAffinity not supplied; returning original");
    return perTargetResults;
  }
  return perTargetResults.map((entry) => {
    const ops = opsMap.get(entry?.actorUuid);
    if (!ops || !ops.length) return entry;
    if (!entry.hit) return entry;  // misses don't take damage adjustments
    const baseRaw = Number(entry.rawDamage) || 0;
    // Separate numeric damage ops from action-keyword tags (pierce, …) and the
    // element-override op (change_damage_element — Infusions).
    const numericOps = ops.filter((o) => o.op !== "keyword" && o.op !== "element");
    const keywords = new Set(ops.filter((o) => o.op === "keyword").map((o) => o.keyword));
    // Element override (last one wins) — recompute affinity against the NEW
    // element (resolved per-subject upstream in computeSenderDamageBonuses).
    const elementOp = [...ops].reverse().find((o) => o.op === "element" && o.element);
    let d = baseRaw;
    for (const { op, amount } of numericOps) d = applyDamageOp(d, op, amount);
    d = Math.max(0, Math.floor(d));
    // Affinity: the overridden element's affinity if an Infusion changed it,
    // else the entry's original affinity.
    let affinity = elementOp ? String(elementOp.affinity ?? "NE") : String(entry.affinity ?? "NE");
    // Action-keyword damage-calc effects. PIERCE ignores Resistance only — a
    // pierced hit treats RS as neutral (full damage); VU / IM / AB are untouched.
    // (New keywords add a branch here.)
    if (keywords.has("pierce") && affinity === "RS") affinity = "NE";
    const newDamage = applyAffinity(d, affinity);
    return {
      ...entry,
      rawDamage: d,
      damage: newDamage,
      affinity,
      // Action keywords applied to this hit (pierce, drain, …). Surfaced at the
      // entry top-level so the RESOLVE damage loop can act on post-damage
      // keywords (drain → heal the attacker 50% of the HP dealt). Pierce is
      // already consumed above (affinity), but carrying it is harmless.
      ...(keywords.size ? { keywords: [...keywords] } : {}),
      // Surface the new element for the card / log when an Infusion changed it.
      ...(elementOp ? { element: elementOp.element } : {}),
      // Diagnostic — lets the action card show a "+X / ×0 (Skill)" hint and
      // lets the RESOLVE log explain the change. `baseBonus` kept for back-compat
      // with readers that show a simple delta. `keywords` surfaces applied tags.
      bonusBreakdown: { ops: numericOps, from: baseRaw, to: d, baseBonus: d - baseRaw, keywords: [...keywords], ...(elementOp ? { element: elementOp.element, affinity } : {}) },
    };
  });
}

// Walk every reaction_config_table row on the reactor's items, fire any
// passive rows matching `trigger`. Replaces the old passive_trigger-field
// dispatcher.
// Post-resolve passive trigger dispatcher.
//
// As of the promptPassiveOptin → ReactionMenu migration, this is a thin
// wrapper over dispatchReactionMenu (standalone-reactions.js). The
// candidate-iteration / Dialog-per-candidate model is gone; the token-
// anchored ReactionMenu unifies the UI with standalone triggers
// (conflict_start et al.) per [[reaction-menu-on-token]].
//
// What this still owns: locating a token for the caster (off-scene
// safe so harness scenarios on the Training Ground scene work when the
// GM is viewing a different scene). Everything else — candidate
// collection, auto-fire, ask-mode menu, harness override, AE consume-
// self / charges bookkeeping — happens downstream in dispatchReactionMenu
// → firePreAcceptedCandidate.
// ── Resource-ledger trigger ──────────────────────────────────────────────
// Queue a `creature_lose_resource` / `creature_gain_resource` event for
// post-save, supervised dispatch (drained at RESOLVE's tail via
// firePassiveTriggers — same path + timing as creature_deals_damage, so
// reaction-applied AEs land after the rewind anchor). This is the SINGLE
// post-commit "resource ledger" family: HP/MP/IP/FP/zero_power/shield/etc.
// "Damage" is a `cause`, not its own event — the payload carries
// cause ∈ damage|hazard|cost|drain|grant|heal (+ attacker/source for
// cause==damage). damage = inflicted attack; hazard = Burn/Poison/environment.
// Reactor (= subject) is the creature whose resource changed; its own
// reaction_source:"self" rows fire, and Part 2's built-in crisis reactor reads
// the subject. No-op without a director (out of combat) — resource reactions
// are combat-context by design. Rows filter via reaction_resource_filter +
// reaction_cause_filter (see passesMatchFilters).
export function fireResourceChangeTrigger({ director, actor, tokenUuid, resource, direction, amount, cause, source = {}, element = null, originLabel = null, originUuid = null, weaponType = null, weaponRange = null, actionKind = null, actionIntent = null, isCrit = null, isFumble = null, accuracyTotal = null, highRoll = null, pierce = null }) {
  if (!director?.ctx || !actor || !resource || !(amount > 0)) return;
  if (direction !== "loss" && direction !== "recover") return;
  if (!Array.isArray(director.ctx._postResolveTriggers)) director.ctx._postResolveTriggers = [];
  director.ctx._postResolveTriggers.push({
    casterActor: actor,
    trigger: direction === "loss" ? "creature_lose_resource" : "creature_gain_resource",
    payload: {
      resource: String(resource).toLowerCase(),
      amount,
      cause: cause ?? null,
      direction,
      // ── Itemized source identity (NEVER summed across lines) ──
      // Distinct from `cause` (the deferred category axis): these answer
      // "which effect contributed this exact line + by how much", so the
      // turn breakdown can render "−5 Burn / −10 Poison" and a per-source
      // reaction can match exactly one line. `element` = fire|poison|… ;
      // `originLabel` = display name (the AE/skill, e.g. "Burn"); `originUuid`
      // = the originating effect/item.
      element: element ?? null,
      originLabel: originLabel ?? null,
      originUuid: originUuid ?? null,
      // ── "How it changed" context (attack/skill losses only; null for tick/
      // status damage, which has no weapon or roll). Additive + future-facing:
      // populated at the attack-damage site, available for "react when my HP
      // drops to a melee/crit/<element> hit" style gates once a reader identifier
      // exists for the field. All null-safe — absence reads as "not applicable".
      weaponType: weaponType ?? null,       // sword | bow | brawling | dagger | …
      weaponRange: weaponRange ?? null,     // melee | ranged
      actionKind: actionKind ?? null,       // Attack | Skill | Spell | Item
      actionIntent: actionIntent ?? null,
      isCrit: isCrit ?? null,
      isFumble: isFumble ?? null,
      accuracyTotal: accuracyTotal ?? null, // the to-hit total that landed it
      highRoll: highRoll ?? null,           // HR of the producing roll
      pierce: pierce ?? null,               // hit through immunity/affinity
      // The reaction_source filter (self/ally/enemy) keys off
      // `payload.sourceActorUuid` — so it MUST be the SUBJECT of this event =
      // the creature whose resource changed (its own "self" rows fire; an
      // observer's "enemy" rows resolve against it). Mirrors how
      // creature_deals_damage sets sourceActorUuid = the acting creature.
      sourceActorUuid: actor.uuid,
      sourceTokenUuid: tokenUuid ?? null,
      subjectActorUuid: actor.uuid,
      subjectTokenUuid: tokenUuid ?? null,
      // Who/what CAUSED the change (e.g. the attacker, for cause==damage) — for
      // reflect/leech-style reactions (Painful Lesson). NOT the source filter.
      causeActorUuid: source.actorUuid ?? null,
      causeTokenUuid: source.tokenUuid ?? null,
    },
  });
}

export async function firePassiveTriggers({ director, casterActor, trigger, payload, skipEvaluated }) {
  if (!casterActor || !trigger) return { fired: [] };

  // Token resolution preference:
  //   1. Active canvas scene — the menu anchors to the token's pixel
  //      position via canvas.stage.toGlobal(); using a token on a
  //      different scene yields off-viewport menu placement (Vanish
  //      reaction menu rendered in the letterbox below the battle map).
  //   2. game.scenes walk — fallback for harness / cross-scene runs
  //      where the GM is viewing a scene that doesn't contain the actor.
  let casterToken = null;
  const activeScene = canvas?.scene ?? null;
  if (activeScene) {
    casterToken = activeScene.tokens?.contents?.find((t) => t.actor?.uuid === casterActor.uuid) ?? null;
  }
  if (!casterToken) {
    for (const scene of game.scenes?.contents ?? []) {
      const tok = scene.tokens?.contents?.find((t) => t.actor?.uuid === casterActor.uuid);
      if (tok) { casterToken = tok; break; }
    }
  }
  if (!casterToken) {
    log(`firePassiveTriggers[${trigger}]: no token for ${casterActor.name}, skipping`);
    return { fired: [] };
  }

  // Dynamic import preserves the existing cache-bust pattern this module
  // uses for cross-module hops.
  const mod = await import("./standalone-reactions.js?cb=" + Date.now());
  const result = await mod.dispatchReactionMenu({
    director,
    reactor: casterActor,
    token: casterToken,
    trigger,
    payload,
    skipEvaluated,
    // Single-mode model: every non-off row for this trigger surfaces here.
    // `ask` rows render as clickable blades in the token reaction menu;
    // `on`/`force` auto-fire. (Previously `includeManual: false` excluded
    // manual rows, leaving "may"-on-post-resolve skills — Consume, Painful
    // Lesson, Life Transference — dormant.) See [[reaction-passive-mode-single-field]].
    // No scope/scene — post-resolve trigger events are not persistent
    // across actions. Each new event prompts fresh; firedSet stays empty.
  });
  return { fired: Array.isArray(result?.fired) ? result.fired : [] };
}

// Sweep AEs whose `directorAppliedBy.lifetimeMode === "round_end"` —
// removes them at the end of any round (the FSM's round_end transition
// calls this from director-boot / state-handlers). Independent of the
// applier-turn ticker; AEs marked with this lifetime live for at most
// the remainder of the round they were applied in.
//
// First consumer: Rampart's playtest-2025 mechanic ("RS to all + cannot
// suffer status effects until the end of the round"). The Rampart AE
// template stamps `flags.fabula-ultima-companion.lifetimeMode = "round_end"`
// and applyApplyAeEffect forwards it onto the cloned AE's
// `directorAppliedBy.lifetimeMode`.
//
// Returns `{ swept: <number>, names: [<aeName>] }` for logging.
export async function tickDirectorAEsAtRoundEnd() {
  const deleteByActor = new Map();   // actorUuid -> Set<aeId>
  const names = [];
  for (const actor of game.actors ?? []) {
    for (const eff of actor.effects ?? []) {
      const stamp = eff.flags?.[FLAG_NS]?.directorAppliedBy;
      if (!stamp) continue;
      if (String(stamp.lifetimeMode ?? "").toLowerCase() !== "round_end") continue;
      let set = deleteByActor.get(actor.uuid);
      if (!set) { set = new Set(); deleteByActor.set(actor.uuid, set); }
      set.add(eff.id);
      names.push(eff.name);
    }
  }
  let swept = 0;
  await Promise.all(Array.from(deleteByActor.entries()).map(async ([uuid, ids]) => {
    try {
      const actor = await fromUuid(uuid);
      if (!actor) return;
      const existing = Array.from(ids).filter((id) => !!actor.effects?.get?.(id));
      if (!existing.length) return;
      await actor.deleteEmbeddedDocuments("ActiveEffect", existing);
      swept += existing.length;
    } catch (e) { warn(`tickDirectorAEsAtRoundEnd: delete failed for ${uuid}`, e); }
  }));
  return { swept, names };
}

// Tick down `turnsRemaining` on every AE in the world whose
// `directorAppliedBy.reactorActorUuid` matches the given applier. Called
// from TurnStart.onEnter when the applier's next turn begins
// (homebrew rule [[ae-default-3-turn-duration]]). AEs that reach 0 are
// deleted in batch per owning actor. AEs with `turnsRemaining === null`
// are explicit opt-outs (permanent) and are skipped.
//
// Returns `{ ticked: <number>, expired: [<aeName>] }` for logging.
export async function tickDirectorAEsForApplier(applierActorUuid) {
  if (!applierActorUuid) return { ticked: 0, expired: [] };
  const deleteByActor = new Map();    // actorUuid -> Set<aeId>
  const updateByActor = new Map();    // actorUuid -> [{_id, flags.fabula-ultima-companion.directorAppliedBy.turnsRemaining}]
  const expiredNames = [];
  let ticked = 0;
  for (const actor of game.actors ?? []) {
    for (const eff of actor.effects ?? []) {
      const stamp = eff.flags?.[FLAG_NS]?.directorAppliedBy;
      if (!stamp) continue;
      if (stamp.reactorActorUuid !== applierActorUuid) continue;
      if (stamp.turnsRemaining == null) continue;  // explicit opt-out
      // "target_turn_end" AEs are owned by the bearer-turn-end tick, not the
      // applier-turn-start tick — skip so they're not double-counted.
      if (stamp.lifetimeMode === "target_turn_end") continue;
      const next = Number(stamp.turnsRemaining) - 1;
      ticked += 1;
      if (next <= 0) {
        let set = deleteByActor.get(actor.uuid);
        if (!set) { set = new Set(); deleteByActor.set(actor.uuid, set); }
        set.add(eff.id);
        expiredNames.push(eff.name);
      } else {
        let arr = updateByActor.get(actor.uuid);
        if (!arr) { arr = []; updateByActor.set(actor.uuid, arr); }
        arr.push({ _id: eff.id, [`flags.${FLAG_NS}.directorAppliedBy.turnsRemaining`]: next });
      }
    }
  }
  // Batch by owning actor + parallel-await across actors.
  await Promise.all([
    ...Array.from(updateByActor.entries()).map(async ([actorUuid, updates]) => {
      try {
        const actor = await fromUuid(actorUuid);
        if (!actor) return;
        await actor.updateEmbeddedDocuments("ActiveEffect", updates);
      } catch (e) { warn(`tickDirectorAEsForApplier: update failed for ${actorUuid}`, e); }
    }),
    ...Array.from(deleteByActor.entries()).map(async ([actorUuid, ids]) => {
      try {
        const actor = await fromUuid(actorUuid);
        if (!actor) return;
        await actor.deleteEmbeddedDocuments("ActiveEffect", Array.from(ids));
      } catch (e) { warn(`tickDirectorAEsForApplier: delete failed for ${actorUuid}`, e); }
    }),
  ]);
  if (ticked) log(`tickDirectorAEsForApplier: ticked ${ticked} AE(s) for ${applierActorUuid}; expired ${expiredNames.length}: ${expiredNames.join(", ")}`);
  return { ticked, expired: expiredNames };
}

// Tick down `turnsRemaining` on every AE OWNED BY the given bearer whose
// lifetimeMode is "target_turn_end" — called from TURN_END for the actor whose
// turn just ended. This is the "lasts N of the AFFECTED creature's turns,
// decrement at the END of each of their turns" model used by the homebrew
// action-gating Advanced Debuffs (Frightened/Silence/Confused/Disarmed/Berserk).
// Distinct from tickDirectorAEsForApplier (applier-turn-START tick): here the
// counter is keyed to the BEARER (the AE's owning actor), not the applier, so a
// debuff lands and runs out on the victim's own turns regardless of who cast it.
// AEs reaching 0 are deleted. Returns `{ ticked, expired: [names] }`.
export async function tickDirectorAEsForBearerTurnEnd(bearerActorUuid) {
  if (!bearerActorUuid) return { ticked: 0, expired: [] };
  const actor = await fromUuid(bearerActorUuid).catch(() => null);
  if (!actor?.effects) return { ticked: 0, expired: [] };
  const updates = [];
  const deletes = [];
  const expiredNames = [];
  for (const eff of actor.effects) {
    const stamp = eff.flags?.[FLAG_NS]?.directorAppliedBy;
    if (!stamp) continue;
    if (stamp.lifetimeMode !== "target_turn_end") continue;
    if (stamp.turnsRemaining == null) continue;
    const next = Number(stamp.turnsRemaining) - 1;
    if (next <= 0) { deletes.push(eff.id); expiredNames.push(eff.name); }
    else updates.push({ _id: eff.id, [`flags.${FLAG_NS}.directorAppliedBy.turnsRemaining`]: next });
  }
  try {
    if (updates.length) await actor.updateEmbeddedDocuments("ActiveEffect", updates);
    if (deletes.length) await actor.deleteEmbeddedDocuments("ActiveEffect", deletes);
  } catch (e) { warn(`tickDirectorAEsForBearerTurnEnd: write failed for ${bearerActorUuid}`, e); }
  const ticked = updates.length + deletes.length;
  if (ticked) log(`tickDirectorAEsForBearerTurnEnd: ticked ${ticked} AE(s) on ${actor.name}; expired ${expiredNames.length}: ${expiredNames.join(", ")}`);
  return { ticked, expired: expiredNames };
}

// Reap orphaned APPLIER-TIED AEs when their applier leaves the battle (defeated
// or removed from combat). The default lifetime mode decrements only at the
// START of the applier's turn (tickDirectorAEsForApplier) — so if the applier
// never gets another turn, the AE is stranded on the bearer until the conflict-
// end sweep. This reaps exactly that stuck set: director-applied AEs whose
// `directorAppliedBy.reactorActorUuid` is the departing actor AND that are
// applier-turn-tied (default mode: turnsRemaining set + no explicit lifetimeMode).
//
// Deliberately NARROW — leaves alone everything that does NOT depend on the
// applier's turns, so they're never wrongly dropped when the applier dies:
//   - bearer-tied AEs (lifetimeMode "target_turn_end") — keyed to the victim;
//   - round-end / charge-governed (lifetimeMode "round_end" / "on_activation");
//   - permanent AEs (turnsRemaining == null).
// Target-resident DoTs (Burn = charge/on_activation, etc.) are therefore NOT reaped.
//
// GM-authoritative (driven by the director, which is GM-only). Returns
// `{ reaped, names }`.
export async function reapApplierTiedAEs(applierActorUuid) {
  if (!applierActorUuid) return { reaped: 0, names: [] };
  const deleteByActor = new Map();   // actorUuid -> Set<aeId>
  const names = [];
  for (const actor of game.actors ?? []) {
    for (const eff of actor.effects ?? []) {
      const stamp = eff.flags?.[FLAG_NS]?.directorAppliedBy;
      if (!stamp) continue;
      if (stamp.reactorActorUuid !== applierActorUuid) continue;
      if (stamp.turnsRemaining == null) continue;   // permanent / charge / round-end → not applier-tied
      if (stamp.lifetimeMode) continue;              // only the DEFAULT mode is applier-turn-start
      let set = deleteByActor.get(actor.uuid);
      if (!set) { set = new Set(); deleteByActor.set(actor.uuid, set); }
      set.add(eff.id);
      names.push(eff.name);
    }
  }
  await Promise.all(Array.from(deleteByActor.entries()).map(async ([actorUuid, ids]) => {
    try {
      const actor = await fromUuid(actorUuid);
      if (actor) await actor.deleteEmbeddedDocuments("ActiveEffect", Array.from(ids));
    } catch (e) { warn(`reapApplierTiedAEs: delete failed for ${actorUuid}`, e); }
  }));
  if (names.length) log(`reapApplierTiedAEs: applier ${applierActorUuid} left battle → reaped ${names.length} stranded AE(s): ${names.join(", ")}`);
  return { reaped: names.length, names };
}

// Apply an effect by its `effect_label`. Looks up the row in the
// skill's effect_table and dispatches to the right handler.
// Returns `{ ok, kind, applied, reason?, abort?, skipBody? }`.
export async function applyEffectByLabel(effectLabel, ctx) {
  if (!effectLabel) return { ok: false, reason: "no-label" };
  const row = findEffectRow(ctx, effectLabel);
  if (!row) {
    warn(`skill-effects: effect_label "${effectLabel}" not found`);
    return { ok: false, reason: "no-row" };
  }
  return applyEffectRow(row, ctx);
}

// ── Effect-kind registry — SINGLE SOURCE OF TRUTH ────────────────────────────
// One map drives BOTH the runtime dispatch (applyEffectRow) AND the CSB template
// `effect_kind` dropdown (the `effect-kind-template-options` boot migration
// imports SUPPORTED_EFFECT_KINDS + EFFECT_KIND_LABELS and ensures every key is a
// template option). This kills the recurring class of bug where a new effect_kind
// works in data/harness but CSB STRIPS it the moment a human opens the sheet
// (select values absent from the option list are silently dropped → effect_kind
// "" → falls back to "grant" → "unknown resource"). Add a new kind in ONE place
// (here) and both the engine + the dropdown stay in sync. See
// [[feedback_csb_template_gating]] + [[feedback_effect_kind_check_all_passive_modes]].
//
// ── adjust_charges ───────────────────────────────────────────────────────
//
// Charge arithmetic on a TARGET's named charge-AE — the charge-side twin of
// adjust_damage. For each resolved target, read the current total charges on
// AEs named `charge_ae_name`, apply `charge_operation` (add/subtract/multiply/
// set/cap/floor) with `charge_amount` (number or per-target formula), clamp ≥0
// (+ optional `charge_max`), then write the result back — consolidating into one
// AE (deletes the rest). No-op if the target has no such AE (can't multiply a
// nonexistent stack). Used by Enkindle ("double the target's Burn": Burn ×2).
async function applyAdjustChargesEffect(row, ctx) {
  const aeName = String(row.charge_ae_name ?? "").trim();
  if (!aeName) {
    warn(`skill-effects.adjust_charges: missing charge_ae_name on "${row.effect_label}"`);
    return { ok: false, kind: "adjust_charges", reason: "no-ae-name" };
  }
  const op = String(row.charge_operation ?? "set").trim().toLowerCase();
  if (!DAMAGE_OPS.has(op)) {
    warn(`skill-effects.adjust_charges: bad charge_operation "${op}" on "${row.effect_label}"`);
    return { ok: false, kind: "adjust_charges", reason: "bad-op" };
  }
  const targetResult = await resolveTargetRef(row.target_ref, ctx);
  if (!targetResult.ok || !targetResult.tokens?.length) {
    return { ok: false, kind: "adjust_charges", reason: targetResult.reason ?? "no-targets" };
  }
  const needle = aeName.toLowerCase();
  const maxRaw = String(row.charge_max ?? "").trim();
  const capN = maxRaw === "" ? null : (Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : null);
  const { buildSkillResolver, evaluateFormula } = await getSkillFormulas();

  const applied = [];
  for (const token of targetResult.tokens) {
    const actor = token.actor;
    if (!actor) continue;
    const matches = Array.from(actor.effects ?? []).filter(
      (e) => !e.disabled && String(e?.name ?? "").trim().toLowerCase() === needle
    );
    if (!matches.length) {
      log(`skill-effects.adjust_charges: ${actor.name} has no "${aeName}" — skipping`);
      continue;
    }
    const current = matches.reduce((s, e) => s + (Number(e.flags?.[FLAG_NS]?.charges ?? 0) || 0), 0);
    // Per-target resolver so the amount formula can read the target's own state.
    const resolver = buildSkillResolver({ actor, payload: ctx.payload, skill: ctx.skill, round: ctx.dCombat?.round ?? 0 });
    const amount = Number(evaluateFormula(String(row.charge_amount ?? "0"), resolver, 0)) || 0;
    let next = Math.max(0, Math.floor(applyDamageOp(current, op, amount)));
    if (capN != null) next = Math.min(next, capN);
    try {
      if (next <= 0) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", matches.map((e) => e.id).filter(Boolean));
      } else {
        await matches[0].update({ [`flags.${FLAG_NS}.charges`]: next });
        if (matches.length > 1) {
          await actor.deleteEmbeddedDocuments("ActiveEffect", matches.slice(1).map((e) => e.id).filter(Boolean));
        }
      }
      applied.push({ actorUuid: actor.uuid, aeName, op, from: current, to: next });
      log(`skill-effects.adjust_charges: ${actor.name} "${aeName}" ${op} ${amount}: ${current} → ${next}`);
    } catch (e) {
      warn(`skill-effects.adjust_charges: write failed on ${actor.name}`, e);
    }
  }
  return { ok: true, kind: "adjust_charges", applied };
}

// ── prompt_number ─────────────────────────────────────────────────────────
//
// Interactive amount picker. Opens a number-input Dialog (min..max), clamps the
// entry, and stashes it as a chain-local variable on `ctx.payload._chainVars`
// under `prompt_var`, where later rows read it via the VAR_<NAME> formula
// identifier (e.g. Blazing Tether's two adjust_charges move VAR_MOVE_AMOUNT Burn
// stacks from giver to receiver). Generic: any "choose how much" skill.
//
// Fields:
//   prompt_var      — variable name to store under (e.g. "move_amount").
//   prompt_label    — dialog prompt text.
//   prompt_min      — formula/number, default 0.
//   prompt_max      — formula/number, default unbounded. Evaluated against
//                     prompt_max_ref's first token's actor if set, else caster.
//   prompt_max_ref  — optional target ref whose actor the formulas read (so
//                     prompt_max "AE_CHARGES_BURN" reads the GIVER's Burn).
//   prompt_default  — formula/number for the input's starting value (default max).
//
// Harness: inject via ctx.harnessNumbers[prompt_var] to skip the dialog so the
// deterministic downstream rows are sim-verifiable. Passive auto-fire / no DOM
// → falls back to the (clamped) default with no UI.
async function applyPromptNumberEffect(row, ctx) {
  const varName = String(row.prompt_var ?? "").trim().toLowerCase();
  if (!varName) {
    warn(`skill-effects.prompt_number: missing prompt_var on "${row.effect_label}"`);
    return { ok: false, kind: "prompt_number", reason: "no-var" };
  }
  const { buildSkillResolver, evaluateFormula } = await getSkillFormulas();

  // Actor the min/max/default formulas read from (prompt_max_ref or the caster).
  let formulaActor = ctx.reactorActor ?? null;
  if (row.prompt_max_ref) {
    const r = await resolveTargetRef(String(row.prompt_max_ref), ctx);
    const tok = r?.tokens?.[0];
    if (tok?.actor) formulaActor = tok.actor;
  }
  const resolver = buildSkillResolver({ actor: formulaActor, payload: ctx.payload, skill: ctx.skill, round: ctx.dCombat?.round ?? 0 });
  const minV = Math.floor(Number(evaluateFormula(String(row.prompt_min ?? "0"), resolver, 0)) || 0);
  const maxRaw = String(row.prompt_max ?? "").trim();
  let maxV = maxRaw ? Math.floor(Number(evaluateFormula(maxRaw, resolver, 0)) || 0) : 1e9;
  if (maxV < minV) maxV = minV;
  const defRaw = String(row.prompt_default ?? "").trim();
  let defV = defRaw ? Math.floor(Number(evaluateFormula(defRaw, resolver, maxV)) || 0) : maxV;
  const clamp = (n) => Math.max(minV, Math.min(maxV, Math.floor(Number(n) || 0)));
  defV = clamp(defV);

  let value = defV;
  const injected = ctx?.harnessNumbers?.[varName];
  if (injected != null && Number.isFinite(Number(injected))) {
    value = clamp(injected);
  } else if (ctx.isPassive || typeof Dialog === "undefined" || typeof document === "undefined") {
    value = defV; // auto-fire / headless — take the default, no UI
  } else {
    const entered = await promptNumberDialog({
      label: String(row.prompt_label ?? "Enter a number"),
      min: minV, max: maxV, def: defV, title: ctx.skill?.name ?? "Choose Amount",
    });
    value = entered == null ? minV : clamp(entered); // closed without confirm → min
  }

  if (!ctx.payload) ctx.payload = {};
  if (!ctx.payload._chainVars) ctx.payload._chainVars = {};
  ctx.payload._chainVars[varName] = value;
  log(`skill-effects.prompt_number: ${varName} = ${value} (range ${minV}..${maxV})`);
  return { ok: true, kind: "prompt_number", value };
}

// ── prompt_element ─────────────────────────────────────────────────────────
// Pop a damage-type picker and stash the chosen element STRING as a chain-local
// variable on ctx.payload._chainVars[prompt_var]. A later row reads it back via
// the VAR_<NAME> reference — e.g. `deal_damage` with `damage_element:
// "VAR_ELEMENT"`, so ONE deal_damage deals whatever type the player picked
// instead of one hard-coded row per element. The string counterpart to
// prompt_number; generic for any "choose a damage type, then apply it" skill
// (Meteor Shower; later the Infusion line's damage-type override).
//
// Fields:
//   prompt_var       — variable name to store under (e.g. "element").
//   element_options  — optional `|`/`,`/newline-separated element id list; default
//                      the 9 FU types. Labels are auto-capitalized in the picker.
//   menu_title       — picker title (falls back to prompt_label / a default).
// Reuses selectMenuPicks (the open_action_menu picker), so harness picks
// (ctx.harnessPicks / picks:[...] by label), passive auto-pick, and the parchment
// UI all come for free. Cancel → abort (chain stops before any cost/damage).
const DEFAULT_DAMAGE_ELEMENTS = ["physical", "air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"];
async function applyPromptElementEffect(row, ctx) {
  const varName = String(row.prompt_var ?? "").trim().toLowerCase();
  if (!varName) {
    warn(`skill-effects.prompt_element: missing prompt_var on "${row.effect_label}"`);
    return { ok: false, kind: "prompt_element", reason: "no-var" };
  }
  // Already captured (pre_activate ran the pick before the card; the value was
  // rehydrated onto _chainVars at RESOLVE) → use it, don't re-prompt.
  const pre = ctx?.payload?._chainVars?.[varName];
  if (typeof pre === "string" && pre.trim() !== "") {
    log(`skill-effects.prompt_element: ${varName} already captured = ${pre}; skipping prompt`);
    return { ok: true, kind: "prompt_element", value: pre };
  }
  const raw = String(row.element_options ?? "").trim();
  const elements = raw
    ? raw.split(/[|,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_DAMAGE_ELEMENTS.slice();
  if (!elements.length) {
    warn(`skill-effects.prompt_element: no element options on "${row.effect_label}"`);
    return { ok: false, kind: "prompt_element", reason: "no-options" };
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const options = elements.map((e) => ({ label: cap(e) }));
  // Build a picker row: reuse the option-menu title + passive auto-pick knob so a
  // passive/headless reuse never hangs (interactive Active casts still prompt).
  const pickRow = {
    ...row,
    menu_title: row.menu_title ?? row.prompt_label ?? "Choose a damage type",
    skip_when_passive: true,
  };
  const { chosenIndices, cancelled } = await selectMenuPicks(pickRow, ctx, options);
  if (cancelled) {
    log(`skill-effects.prompt_element: "${row.effect_label}" cancelled by user`);
    return { ok: true, kind: "prompt_element", applied: [], reason: "cancelled", abort: true };
  }
  const idx = chosenIndices?.[0] ?? 0;
  const chosen = elements[idx] ?? elements[0];
  if (!ctx.payload) ctx.payload = {};
  if (!ctx.payload._chainVars) ctx.payload._chainVars = {};
  ctx.payload._chainVars[varName] = chosen;
  log(`skill-effects.prompt_element: ${varName} = ${chosen}`);
  return { ok: true, kind: "prompt_element", value: chosen };
}

// Number-input dialog (mirrors the attribute-pair-picker DL input). Resolves to
// the clamped integer on Confirm, or null if closed without confirming.
async function promptNumberDialog({ label, min, max, def, title }) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    const content = `
      <div class="fud-num-prompt" style="display:flex;flex-direction:column;gap:8px;padding:4px 2px;">
        <label style="font-size:13px;">${esc(label)}</label>
        <input type="number" min="${min}" max="${max}" step="1" value="${def}"
               class="fud-num-prompt-input" style="width:100%;text-align:center;font-size:16px;"
               aria-label="${esc(label)}">
        <div style="font-size:11px;opacity:0.7;">Range ${min}–${max}</div>
      </div>`;
    const dlg = new Dialog({
      title,
      content,
      buttons: {
        ok: {
          icon: '<i class="fas fa-check"></i>', label: "Confirm",
          callback: (html) => {
            const rootEl = html?.[0] ?? html;
            const input = rootEl?.querySelector?.(".fud-num-prompt-input");
            const raw = input ? Number(input.value) : def;
            done(Math.max(min, Math.min(max, Math.floor(Number.isFinite(raw) ? raw : def))));
          },
        },
      },
      default: "ok",
      close: () => done(null),
      render: (html) => {
        const rootEl = html?.[0] ?? html;
        const input = rootEl?.querySelector?.(".fud-num-prompt-input");
        if (input) { try { input.focus(); input.select(); } catch { /* noop */ } }
      },
    });
    dlg.render(true);
  });
}

// ── confirm — N-button decision dialog (gate or branch) ──────────────────
// A reusable confirmation/decision step rendered as a parchment overlay
// (matching the shared list-picker UI family). Modes:
//   GATE   (no confirm_button_refs): [OK][Cancel]. OK → chain continues;
//          Cancel / dismiss → { abort: true } (the chain stops, so a later
//          consume_resource never fires — order cost AFTER this gate).
//   BRANCH (confirm_button_refs set): one button per ref (any number) + a
//          Cancel button. Clicking dispatches that ref's effect, then stops
//          the parent chain (the branch IS the outcome).
// Buttons are uniform width and accept a named style: default | danger |
// primary | warning | success. Player-facing — in a passive/headless ctx it
// auto-proceeds (gate) / auto-runs the first ref (branch), never blocking.
const FUD_CONFIRM_STYLE_ID = "fud-confirm-style";
// Parchment overlay matching the shared list-picker (.fud-lp-*) so confirm
// dialogs read as the same UI family as targeting / option menus — not a raw
// Foundry Dialog. Style variants tint within the parchment palette.
function ensureConfirmStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(FUD_CONFIRM_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = FUD_CONFIRM_STYLE_ID;
  el.textContent = `
    .fud-confirm-backdrop { position:fixed; inset:0; z-index:100; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.34); }
    .fud-confirm-card {
      min-width:280px; max-width:min(92vw,440px); padding:0 0 12px; overflow:hidden;
      border:2px solid var(--fud-stroke,#7a6a55); border-radius:14px;
      background:linear-gradient(180deg, var(--fud-parchment-top,#f6f1e6), var(--fud-parchment-bot,#ebe3d0));
      box-shadow:0 14px 44px rgba(0,0,0,0.5);
      color:var(--fud-ink,#3a3228); font-family:"Inter","Signika","Segoe UI",system-ui,sans-serif;
      transform:scale(0.96); opacity:0; transition:transform 140ms ease-out, opacity 140ms ease-out;
    }
    .fud-confirm-card.is-visible { transform:scale(1); opacity:1; }
    .fud-confirm-card .fud-confirm-title {
      font-size:14px; font-weight:900; letter-spacing:0.32px; text-transform:uppercase; text-align:center;
      padding:10px 14px; border-bottom:2px solid var(--fud-stroke,#7a6a55);
    }
    .fud-confirm-card .fud-confirm-message {
      font-size:12px; line-height:1.45; padding:13px 16px; color:var(--fud-ink-soft,#4b4338);
    }
    .fud-confirm-card .fud-confirm-buttons { display:flex; gap:8px; padding:0 12px; }
    .fud-confirm-card .fud-cbtn {
      flex:1 1 0; min-width:0; padding:9px 10px; border-radius:9px;
      border:2px solid var(--fud-stroke,#7a6a55);
      background:linear-gradient(180deg,#e5d6c5,#c9b294); color:var(--fud-ink,#3a3228);
      font-weight:800; letter-spacing:0.32px; text-transform:uppercase; font-size:11px;
      cursor:pointer; user-select:none; text-align:center;
      box-shadow:0 3px 0 rgba(41,33,24,0.55), 0 0 0 1px rgba(255,255,255,0.7) inset;
      transition:filter 100ms ease, transform 60ms ease;
    }
    .fud-confirm-card .fud-cbtn:hover { filter:brightness(1.05); }
    .fud-confirm-card .fud-cbtn:active { transform:translateY(2px); box-shadow:0 1px 0 rgba(41,33,24,0.55), 0 0 0 1px rgba(255,255,255,0.7) inset; }
    .fud-confirm-card .fud-cbtn-danger  { background:linear-gradient(180deg,#caa0a0,#a86b6b); border-color:#7a3a3a; color:#3a1414; }
    .fud-confirm-card .fud-cbtn-primary { background:linear-gradient(180deg,#a8bcd0,#6f93b8); border-color:#3a5a7a; color:#142433; }
    .fud-confirm-card .fud-cbtn-warning { background:linear-gradient(180deg,#d8c79a,#bda35f); border-color:#7a5f1f; color:#3a2e0a; }
    .fud-confirm-card .fud-cbtn-success { background:linear-gradient(180deg,#a8c9ad,#6f9d77); border-color:#2f6d3a; color:#143a1c; }
  `;
  document.head.appendChild(el);
}

// Render an N-button confirm overlay (parchment theme). `buttons` =
// [{key,label,style}]; always appends a Cancel button. Resolves to the chosen
// button key, or null on Cancel / Escape / backdrop click.
function confirmButtonDialog({ title, message, buttons, cancelLabel, cancelStyle }) {
  ensureConfirmStyle();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return new Promise((resolve) => {
    let resolved = false;
    let onKey = null;
    const backdrop = document.createElement("div");
    backdrop.className = "fud-confirm-backdrop";
    const done = (v) => {
      if (resolved) return; resolved = true;
      if (onKey) document.removeEventListener("keydown", onKey, true);
      backdrop.querySelector(".fud-confirm-card")?.classList.remove("is-visible");
      setTimeout(() => { try { backdrop.remove(); } catch { /* noop */ } }, 140);
      resolve(v);
    };
    const btnHtml = buttons.map((b) =>
      `<button type="button" class="fud-cbtn fud-cbtn-${esc(String(b.style ?? "default").toLowerCase())}" data-key="${esc(b.key)}">${esc(b.label)}</button>`
    ).join("");
    const cancelHtml = `<button type="button" class="fud-cbtn fud-cbtn-${esc(String(cancelStyle ?? "default").toLowerCase())}" data-key="__cancel__">${esc(cancelLabel ?? "Cancel")}</button>`;
    backdrop.innerHTML = `
      <div class="fud-confirm-card" role="dialog" aria-modal="true">
        <div class="fud-confirm-title">${esc(title ?? "Confirm")}</div>
        <div class="fud-confirm-message">${esc(message ?? "")}</div>
        <div class="fud-confirm-buttons">${btnHtml}${cancelHtml}</div>
      </div>`;
    backdrop.addEventListener("click", (ev) => {
      const btn = ev.target?.closest?.("[data-key]");
      if (btn) { const k = btn.getAttribute("data-key"); done(k === "__cancel__" ? null : k); return; }
      if (ev.target === backdrop) done(null);   // backdrop click = cancel
    });
    onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); done(null); } };
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.querySelector(".fud-confirm-card")?.classList.add("is-visible"));
  });
}

async function applyConfirmEffect(row, ctx) {
  const title = String(row.confirm_title ?? ctx.skill?.name ?? "Confirm");
  const message = String(row.confirm_message ?? "Are you sure?");
  const headless = ctx.isPassive || typeof Dialog === "undefined" || typeof document === "undefined";
  const refs = parseEffectRefList(row.confirm_button_refs);

  if (refs.length) {
    // BRANCH mode.
    if (headless) {
      const first = findEffectRow(ctx, refs[0]);
      if (first?.effect_kind) await applyEffectRow({ ...first, effect_label: `${row.effect_label ?? "confirm"}:${refs[0]}` }, ctx);
      return { ok: true, kind: "confirm", branch: refs[0], auto: true, abort: true };
    }
    const buttons = refs.map((ref) => {
      const r = findEffectRow(ctx, ref);
      return { key: ref, label: String(r?.button_label ?? r?.menu_label ?? r?.effect_label ?? ref), style: r?.button_style ?? "default" };
    });
    const chosen = await confirmButtonDialog({ title, message, buttons, cancelLabel: row.confirm_cancel_label, cancelStyle: row.confirm_cancel_style });
    if (chosen == null) return { ok: true, kind: "confirm", reason: "cancelled", abort: true };
    const r = findEffectRow(ctx, chosen);
    let sub = null;
    if (r?.effect_kind) sub = await applyEffectRow({ ...r, effect_label: `${row.effect_label ?? "confirm"}:${chosen}` }, ctx);
    // A branch is the whole outcome — stop the parent chain either way.
    return { ok: sub ? sub.ok : true, kind: "confirm", branch: chosen, nested: sub, abort: true };
  }

  // GATE mode.
  if (headless) return { ok: true, kind: "confirm", confirmed: true, auto: true };
  const okKey = "__ok__";
  const chosen = await confirmButtonDialog({
    title, message,
    buttons: [{ key: okKey, label: String(row.confirm_ok_label ?? "Confirm"), style: row.confirm_ok_style ?? "default" }],
    cancelLabel: row.confirm_cancel_label ?? "Cancel",
    cancelStyle: row.confirm_cancel_style,
  });
  if (chosen === okKey) return { ok: true, kind: "confirm", confirmed: true };
  return { ok: true, kind: "confirm", confirmed: false, abort: true };
}

// ── leave_combat — remove the target from the active conflict ─────────────
// Drops the target's combatant from the director's turn order (dCombat) AND
// removes its token from the scene (RAW "vanish from the scene"). Re-entry is
// GM narrative. Self-targeted in practice (See you later). Routes through the
// director's removeCombatant API so the FSM/turn-order/banner stay consistent.
async function applyLeaveCombatEffect(row, ctx) {
  const tr = await resolveTargetRef(row.target_ref || "self", ctx);
  if (!tr.ok || !tr.tokens.length) return { ok: false, kind: "leave_combat", reason: "no-targets", abort: true };
  // The director API lives at FUCompanion.api.experimental.battleDirector.
  const bd = globalThis.FUCompanion?.api?.experimental?.battleDirector;
  const applied = [];
  for (const token of tr.tokens) {
    if (typeof bd?.removeCombatant === "function") {
      try {
        const res = await bd.removeCombatant({ tokenUuid: token.uuid });
        if (res?.ok) applied.push(token.uuid);
        else warn(`skill-effects.leave_combat: removeCombatant failed — ${res?.error}`);
      } catch (e) { warn("skill-effects.leave_combat: removeCombatant threw", e); }
    } else {
      warn("skill-effects.leave_combat: director removeCombatant API unavailable");
    }
  }
  return { ok: true, kind: "leave_combat", applied };
}

// ── notify — surface a short message (chat + UI toast) ────────────────────
// Generic "tell the player something" step. Primary use: branch STUBS for
// not-yet-built subsystems (the Gadgets Alchemy/Magitech branches notify
// "not yet implemented" so the skill is complete-shaped and fills in later
// with no restructuring). Reads:
//   notify_message — the text (required)
//   notify_type    — "info" | "warning" | "error" (UI toast level; default info)
//   notify_abort   — truthy → stop the chain after notifying (default true: a
//                    stub branch has nothing more to do)
// Headless (passive/no-DOM) → no toast, message logged; still returns ok.
async function applyNotifyEffect(row, ctx) {
  const message = String(row.notify_message ?? "").trim();
  const type = String(row.notify_type ?? "info").trim().toLowerCase();
  const abort = row.notify_abort === undefined ? true : !!row.notify_abort;
  if (message) {
    const headless = ctx.isPassive || typeof ui === "undefined" || !ui?.notifications;
    if (headless) {
      log(`skill-effects.notify: ${message}`);
    } else {
      const fn = ui.notifications[type] ? type : "info";
      try { ui.notifications[fn](message); } catch { /* non-fatal */ }
    }
  }
  return { ok: true, kind: "notify", message, abort };
}

// Data-only kinds (adjust_damage / redirect_target / adjust_accuracy) return ok
// without acting — their real work happens earlier (computeSenderDamageBonuses /
// resolveDamageReactions / card-mutations at the CONFIRM write site); ok keeps
// the chain running so downstream cost steps still fire ([[consume-last-in-chain]]).
const EFFECT_KIND_DISPATCH = {
  targeting:           applyTargetingEffect,
  grant:               applyGrantEffect,
  set_resource:        applySetResourceEffect,
  apply_ae:            applyApplyAeEffect,
  consume_charge:      applyConsumeChargeEffect,
  chain:               applyChainEffect,
  open_action_menu:    applyOpenActionMenuEffect,
  free_action:         applyFreeActionEffect,
  adjust_charges:      applyAdjustChargesEffect,
  prompt_number:       applyPromptNumberEffect,
  prompt_element:      applyPromptElementEffect,
  remove_tagged_ae:    applyRemoveTaggedAeEffect,
  substitute_cost:     applySubstituteCostEffect,
  consume_resource:    applyConsumeResourceEffect,
  confirm:             applyConfirmEffect,
  leave_combat:        applyLeaveCombatEffect,
  add_target:          applyAddTargetEffect,
  roll_loot_table:     applyRollLootTableEffect,
  deal_damage:         applyDealDamageEffect,
  equip_swap:          applyEquipSwapEffect,
  encyclopedia_record: applyEncyclopediaRecordEffect,
  notify:              applyNotifyEffect,
  adjust_damage:       (row) => ({ ok: true, kind: "adjust_damage", applied: [], reason: "data-only" }),
  // change_damage_element: override the in-flight attack's damage element for the
  // chosen targets (Tinkerer Infusions: Cryo/Pyro/Volt/… make the attack "become"
  // ice/fire/bolt/…). Data-only here — the real work rides the SAME per-subject
  // damage-recompute path as adjust_damage: computeSenderDamageBonuses extracts an
  // {op:"element"} (resolving the new element's affinity per victim) and
  // recomputePerTargetDamages applies that affinity to (rawDamage + any +N), so
  // element + bonus compose in one affinity pass. Element is read from
  // row.change_element (literal) or VAR_<NAME> via _chainVars.
  change_damage_element: (row) => ({ ok: true, kind: "change_damage_element", applied: [], reason: "applied-at-damage-recompute" }),
  // apply_action_keyword: tag the in-flight per-target hit with an action keyword
  // (pierce, …). Data-only here — the real work is in computeSenderDamageBonuses
  // (collects the keyword per subject) + recomputePerTargetDamages (applies its
  // damage-calc effect, e.g. pierce → Resistance treated as neutral). A generic,
  // extensible slot: new keywords add one option + one recompute branch.
  apply_action_keyword: (row) => ({ ok: true, kind: "apply_action_keyword", applied: [], reason: "applied-at-damage-recompute" }),
  redirect_target:     (row) => ({ ok: true, kind: "redirect_target", applied: [], reason: "applied-at-card-mutation-phase" }),
  adjust_accuracy:     (row) => ({ ok: true, kind: "adjust_accuracy", applied: [], reason: "applied-at-card-mutation-phase" }),
  // negate_action: nullify the performer's in-flight action (Shadow Possession's
  // Creeped). Data-only here — the real work is at the card-mutation phase
  // (card-mutations.js Phase 0 sets ar.negated + a Blocked override) and RESOLVE
  // (skips outcome + effect/reaction firing when ar.negated). The reaction's OTHER
  // rows (Frightened, consume_self) still fire normally.
  negate_action:       (row) => ({ ok: true, kind: "negate_action", applied: [], reason: "applied-at-card-mutation-phase" }),
};

// Canonical effect_kind keys (every kind the engine dispatches). The template
// migration ensures each has a dropdown option.
export const SUPPORTED_EFFECT_KINDS = Object.keys(EFFECT_KIND_DISPATCH);

// Human-readable dropdown labels for the CSB template `effect_kind` select.
// One entry per SUPPORTED_EFFECT_KINDS key (the migration falls back to the key
// itself if a label is missing, but keep this complete).
export const EFFECT_KIND_LABELS = {
  targeting:           "Targeting (produce token list)",
  grant:               "Grant / Drain Resource",
  set_resource:        "Set Resource",
  apply_ae:            "Apply Active Effect",
  consume_charge:      "Consume Charge",
  chain:               "Chain (invoke other effects)",
  open_action_menu:    "Open Action Menu",
  free_action:         "Free Action (perform single action)",
  adjust_charges:      "Adjust Charges (multiply/add a target's stacks)",
  prompt_number:       "Prompt Number (ask the user for an amount)",
  prompt_element:      "Prompt Element (ask the user for a damage type)",
  remove_tagged_ae:    "Remove Tagged AE",
  substitute_cost:     "Substitute Cost",
  consume_resource:    "Consume Resource",
  confirm:             "Confirm (decision dialog — gate / multi-button)",
  leave_combat:        "Leave Combat (remove self from the conflict)",
  add_target:          "Add Target",
  roll_loot_table:     "Roll Loot Table",
  deal_damage:         "Deal Damage",
  equip_swap:          "Equip Swap",
  encyclopedia_record: "Encyclopedia Record",
  notify:              "Notify (show a message — stub / info)",
  adjust_damage:       "Adjust Damage",
  change_damage_element: "Change Damage Element (override in-flight element)",
  apply_action_keyword: "Apply Action Keyword (Pierce, …)",
  redirect_target:     "Redirect Target",
  adjust_accuracy:     "Adjust Accuracy",
  negate_action:       "Negate Action (block — no outcome/reactions)",
};

// ── Effect-kind PREVIEW registry (ActionProfile / Action Card) ───────────────
// The COMPUTE-side twin of EFFECT_KIND_DISPATCH. Each entry is a PURE function
// `(row, pctx) => EffectPreview | null` that describes what the row WILL do
// (for the card) without writing anything. `computeActionProfile` walks effects
// in preview; `resolveAction` walks the SAME rows in apply (EFFECT_KIND_DISPATCH).
// Card and commit cannot disagree because both read the same row fields.
//
// pctx (preview context) carries (all optional):
//   resolver   — a buildSkillResolver() result; when present, formula amounts
//                are evaluated to concrete numbers (per-target callers pass a
//                per-target resolver so MAX_HP/CUR_HP read the victim's sheet).
//   targetRef  — the row's resolved target_ref (provenance only).
//   defaultValence — fallback valence when the kind can't infer one.
//
// EffectPreview shape: see docs/battle-director-action-profile-contract.md.
// A null return = "nothing to show on the card" (pure plumbing rows like
// `targeting`, or host-mutation rows handled at the reaction layer).

function _previewAmount(formula, pctx) {
  // Concrete number when a resolver is available; else the raw formula string
  // so the card can render "?"/a range placeholder. Mirrors the apply path's
  // evaluateFormula(..., 0) default.
  if (formula == null || formula === "") return 0;
  if (pctx?.resolver) return evaluateFormula(formula, pctx.resolver, 0);
  return String(formula);
}

function _valenceForResource(resource, amount) {
  // hp/mp grant: positive = beneficial (heal/restore), negative = harmful (drain).
  if (typeof amount === "number") return amount >= 0 ? "beneficial" : "harmful";
  return "neutral";
}

const EFFECT_KIND_PREVIEW = {
  // Pure plumbing — produces a token list, nothing visible on the card.
  targeting: () => null,

  // add_target augments the action's target set; the host (Barrage) renders the
  // extra rows. Surface a neutral marker so a chain audit can list it.
  add_target: (row) => ({ type: "grant", what: "target", amount: 1,
    valence: "neutral", source: row.effect_label, targetRef: row.target_ref ?? null }),

  grant: (row, pctx) => {
    const resource = String(row.grant_resource ?? "").trim().toLowerCase();
    const amount = _previewAmount(row.grant_amount, pctx);
    // hp/mp grants render as heal; other resources (fp/ip/shield/charge) as grant.
    if (resource === "hp" || resource === "mp") {
      return { type: "heal", resource, value: amount,
        valence: _valenceForResource(resource, amount), source: row.effect_label,
        targetRef: row.target_ref ?? null };
    }
    return { type: "grant", what: resource, amount,
      valence: _valenceForResource(resource, amount), source: row.effect_label,
      targetRef: row.target_ref ?? null };
  },

  set_resource: (row, pctx) => {
    const resource = String(row.grant_resource ?? row.set_resource ?? "").trim().toLowerCase();
    const value = _previewAmount(row.grant_amount ?? row.set_amount, pctx);
    return { type: (resource === "hp" || resource === "mp") ? "heal" : "grant",
      resource, what: resource, value, amount: value, valence: "beneficial",
      source: row.effect_label, targetRef: row.target_ref ?? null };
  },

  deal_damage: (row, pctx) => {
    // A VAR_<NAME> element is chosen via prompt_element. If the pick was already
    // captured (pre_activate → pctx.chainVars), show the real type on the card;
    // otherwise (RESOLVE-time pick) show "varies".
    const rawEl = String(row.damage_element ?? row.element ?? "elementless").trim();
    let element;
    if (/^var_/i.test(rawEl)) {
      const key = rawEl.slice(4).toLowerCase().trim();
      const v = pctx?.chainVars?.[key];
      element = (typeof v === "string" && v.trim()) ? v.toLowerCase() : "varies";
    } else {
      element = rawEl.toLowerCase();
    }
    return {
      type: "damage",
      element,
      resource: "hp",
      damageClass: "effect",
      value: _previewAmount(row.damage_amount ?? row.amount, pctx),
      valence: "harmful", source: row.effect_label, targetRef: row.target_ref ?? "self",
    };
  },

  consume_resource: (row, pctx) => ({
    type: "cost",
    resource: String(row.consume_resource ?? row.grant_resource ?? "").trim().toLowerCase(),
    amount: _previewAmount(row.consume_amount ?? row.grant_amount, pctx),
    valence: "neutral", source: row.effect_label, targetRef: row.target_ref ?? "self",
  }),

  consume_charge: (row) => ({
    type: "cost", resource: `charge:${String(row.charge_key ?? "").trim()}`,
    amount: Math.max(1, Math.floor(Number(row.count ?? 1) || 1)),
    valence: "neutral", source: row.effect_label, targetRef: row.target_ref ?? "self",
  }),

  apply_ae: (row) => ({
    type: "status",
    status: String(row.ae_template_ref ?? "").trim(),
    dupMode: String(row.ae_duplicate_mode ?? "replace").trim().toLowerCase(),
    valence: "neutral",   // refined by the profile builder from the AE's tags
    source: row.effect_label, targetRef: row.target_ref ?? null,
  }),

  remove_tagged_ae: (row) => ({
    type: "cleanse", filter: String(row.filter_tag ?? "").trim().toLowerCase() || null,
    valence: "beneficial", source: row.effect_label, targetRef: row.target_ref ?? null,
  }),

  encyclopedia_record: (row) => ({
    type: "reveal", aspect: "encyclopedia", tier: null,
    valence: "neutral", source: row.effect_label, targetRef: row.target_ref ?? null,
  }),

  equip_swap: (row) => ({
    type: "equip", change: null,
    valence: "neutral", source: row.effect_label, targetRef: "self",
  }),

  roll_loot_table: (row) => ({
    type: "random", label: String(row.effect_label ?? "Random"), possibilities: [],
    valence: "neutral", source: row.effect_label, targetRef: row.target_ref ?? "self",
  }),

  // open_action_menu surfaces as a Decision node, not an inline EffectPreview —
  // the profile builder handles it separately. Return null here.
  open_action_menu: () => null,

  // prompt_element is a RESOLVE-time player prompt (pick a damage type) — no
  // inline card preview. (prompt_number has its own entry below.)
  prompt_element: () => null,

  // free_action enqueues a free turn-action (drained by FREE_ACTION_WINDOW) —
  // not a target-facing inline row. No standalone card preview.
  free_action: () => null,

  // adjust_charges mutates a target's charge-AE at apply time — no card row.
  adjust_charges: () => null,

  // prompt_number opens an input dialog at apply time — no target-facing row.
  prompt_number: () => null,

  // confirm pops a decision dialog at apply time; leave_combat removes a
  // combatant — neither is a target-facing inline card row.
  confirm: () => null,
  leave_combat: () => null,

  // chain recurses; the profile builder expands sub-steps. No standalone card row.
  chain: () => null,

  // Host-mutation / data-only kinds: their effect is on the in-flight action
  // (handled at the reaction / card-mutation layer), not a target-facing row.
  substitute_cost: () => null,
  adjust_damage: () => null,
  redirect_target: () => null,
  adjust_accuracy: () => null,
  negate_action: () => null,
};

// Preview a single effect row. Returns an EffectPreview or null (nothing to
// render). Defensive: an unknown kind returns null rather than throwing.
export function previewEffectRow(row, pctx = {}) {
  if (!row) return null;
  const kind = String(row.effect_kind ?? "").trim().toLowerCase();
  const fn = EFFECT_KIND_PREVIEW[kind];
  if (!fn) return null;
  try {
    const out = fn(row, pctx);
    if (out && out.id == null) out.id = `${kind}:${row.effect_label ?? ""}`;
    return out;
  } catch (e) {
    warn(`skill-effects.previewEffectRow: "${kind}" threw on row "${row.effect_label}"`, e);
    return null;
  }
}

export { EFFECT_KIND_PREVIEW };

// Dispatch a single effect row. Callers that already have the row
// (e.g. chain steps) call this directly.
// effect_kinds whose `condition_formula` is evaluated in a LATER phase (not at
// dispatch) — exempt from the dispatch-time gate below so we don't double-gate
// them against a payload that lacks the deferred value. apply_action_keyword's
// gate (e.g. Chomp "FINAL_DAMAGE >= 100") is resolved in computeSenderDamageBonuses'
// keyword pass; FINAL_DAMAGE isn't in the dispatch payload, so gating here would
// always skip a row whose dispatch is a data-only no-op anyway.
const DISPATCH_CONDITION_EXEMPT_KINDS = new Set(["apply_action_keyword"]);

export async function applyEffectRow(row, ctx) {
  if (!row) return { ok: false, reason: "no-row" };
  const kind = String(row.effect_kind ?? "").trim().toLowerCase();

  // Effect-row condition gate. A non-empty `condition_formula` gates the row at
  // dispatch: falsy → SKIP this row and CONTINUE the chain (ok, not a failure).
  // Mirrors the reaction-level gate; lets fire-point / chain rows be conditional
  // (Prepare to Charge: apply Swift only if no Slow; Soul Steal HIT_COUNT>0;
  // Quaking Titan HAS_MARTIAL_ARMOR==1). Evaluated against the reactor + payload.
  const condRaw = String(row.condition_formula ?? "").trim();
  if (condRaw && !DISPATCH_CONDITION_EXEMPT_KINDS.has(kind)) {
    try {
      const { evaluateFormula, buildSkillResolver } = await getSkillFormulas();
      const resolver = buildSkillResolver({
        actor: ctx.reactorActor, payload: ctx.payload, skill: ctx.skill, round: ctx.dCombat?.round ?? 0,
      });
      const val = evaluateFormula(condRaw, resolver, 0);
      if (!val) {
        log(`skill-effects: row "${row.effect_label}" condition_formula="${condRaw}" → falsy; skipping (chain continues)`);
        return { ok: true, kind, applied: [], skipped: true, reason: "condition-false" };
      }
    } catch (e) {
      // Fail-open: a broken formula shouldn't silently drop the effect.
      warn(`skill-effects: condition_formula eval threw on "${row.effect_label}" — running row anyway`, e);
    }
  }

  // Capture mode (the pre_activate window, fired BEFORE the action card is
  // built). Only CHOICE rows run — they record the player's picks (element via
  // prompt_element, menu options via open_action_menu) into the payload so the
  // card can reflect them and RESOLVE can replay them. Consequence rows
  // (deal_damage, apply_ae, consume_resource, …) are NO-OP here; they fire for
  // real at RESOLVE (on_activate). This is what lets a skill gather its choices
  // up front so the cast animation flows straight into damage with no mid-
  // resolve prompts. See fireActivationEffectPre.
  if (ctx?.captureMode) {
    const CAPTURE_KINDS = new Set(["chain", "prompt_element", "prompt_number", "open_action_menu"]);
    if (!CAPTURE_KINDS.has(kind)) {
      return { ok: true, kind, applied: [], skipped: true, reason: "capture-mode-noop" };
    }
  }

  const handler = EFFECT_KIND_DISPATCH[kind];
  if (handler) return handler(row, ctx);
  warn(`skill-effects: unknown effect_kind "${kind}" on row "${row.effect_label}"`);
  return { ok: false, kind, reason: "unknown-kind" };
}

// Fire the skill's `on_activate_effect_ref` hook — runs after the skill
// activates but before damage applies. Returns the dispatch result, or
// null if the skill doesn't declare one.
//
// Fire-point label is read from `ctx.firePoints` when provided (recipe-
// merged), else from the skill's raw props.
export async function fireActivationEffect(skill, ctx) {
  const label = String(
    ctx?.firePoints?.on_activate_effect_ref
    ?? skill?.system?.props?.on_activate_effect_ref
    ?? ""
  ).trim();
  if (!label) return null;
  return applyEffectByLabel(label, ctx);
}

// Clear a choice step's captured value so re-running it RE-PROMPTS (used by the
// pre_activate wizard's back-navigation). prompt_element/prompt_number stash a
// chain var; open_action_menu stashes its picks under its effect_label.
function clearCapturedForStep(row, ctx) {
  if (!row) return;
  const kind = String(row.effect_kind ?? "").trim().toLowerCase();
  if (kind === "prompt_element" || kind === "prompt_number") {
    const v = String(row.prompt_var ?? "").trim().toLowerCase();
    if (v && ctx?.payload?._chainVars) delete ctx.payload._chainVars[v];
  } else if (kind === "open_action_menu") {
    const lbl = row.effect_label;
    if (lbl && ctx?.payload?._capturedMenuPicks) delete ctx.payload._capturedMenuPicks[lbl];
  }
}

// Fire the skill's `pre_activate_effect_ref` hook in CAPTURE mode — runs BEFORE
// the action card is built (skill COMPUTE). Choice rows (prompt_element /
// open_action_menu) prompt and RECORD the player's picks onto ctx.payload
// (_chainVars for element vars, _capturedMenuPicks for menu option labels);
// consequence rows are no-op here (applyEffectRow's capture guard). The caller
// persists the captured picks onto the actionResult and rehydrates them at
// RESOLVE so the on_activate chain replays them with NO re-prompt — letting the
// player make all choices up front, then watch the animation flow straight into
// damage.
//
// WIZARD back-navigation: when the pre_activate root is a `chain`, its steps run
// as an ordered wizard. Cancelling a step goes BACK to the previous step (re-
// prompting it) rather than aborting; cancelling the FIRST step returns
// { abort:true } so the caller drops to the Action Menu. So for Meteor Shower:
// cancel the status pick → re-show the element pick; cancel the element pick →
// Action Menu. No shared-picker change — a picker's "cancel" is reinterpreted
// here as "step back". Non-chain roots run once. Returns the result, or null if
// no pre_activate hook.
export async function fireActivationEffectPre(skill, ctx) {
  const label = String(
    ctx?.firePoints?.pre_activate_effect_ref
    ?? skill?.system?.props?.pre_activate_effect_ref
    ?? ""
  ).trim();
  if (!label) return null;

  const capCtx = { ...ctx, captureMode: true };
  const root = findEffectRow(capCtx, label);
  if (!root) {
    warn(`skill-effects.fireActivationEffectPre: no effect row "${label}"`);
    return { ok: false, reason: "no-row" };
  }
  // Non-chain root → single run (no wizard).
  if (String(root.effect_kind ?? "").trim().toLowerCase() !== "chain") {
    return applyEffectRow(root, capCtx);
  }

  const steps = parseEffectRefList(root.chain_steps);
  let i = 0;
  while (i < steps.length) {
    const stepRow = findEffectRow(capCtx, steps[i]);
    if (!stepRow) { i += 1; continue; }
    const res = await applyEffectRow(stepRow, capCtx);
    // Cancel = step back. First step → Action Menu (abort up to the caller).
    if (res?.abort && res?.reason === "cancelled") {
      if (i === 0) return { ok: true, abort: true, reason: "cancelled-to-menu" };
      i -= 1;
      clearCapturedForStep(findEffectRow(capCtx, steps[i]), capCtx); // re-prompt prev step
      continue;
    }
    if (res?.abort) return res; // a real abort (e.g. consume-on-empty) — propagate
    i += 1;
  }
  return { ok: true };
}

// Fire `post_damage_effect_ref` for ONE damage event. Caller invokes
// this once per damaged target so per-event formulas (HP_DEALT etc.)
// see the correct payload. `damagePayload` overrides ctx.payload for
// this fire so the formula resolver sees the per-target finalValue.
//
// The fire-point label is read from `ctx.firePoints` (recipe-merged).
// The legacy `?? skill.system.props.post_damage_effect_ref` raw-prop
// fallback was dropped 2026-05-30 when the top-level column was
// removed from the template — the `drain` recipe still expands into
// `firePoints.post_damage_effect_ref` so that path remains active for
// recipe-authored skills.
export async function firePostDamageEffect(skill, ctx, damagePayload) {
  const label = String(ctx?.firePoints?.post_damage_effect_ref ?? "").trim();
  if (!label) return null;
  const subCtx = { ...ctx, payload: damagePayload, resolvedTargets: new Map() };
  return applyEffectByLabel(label, subCtx);
}

// ── Row lookup ──────────────────────────────────────────────────────────

function findEffectRow(ctxOrSkill, label) {
  if (!ctxOrSkill || !label) return null;
  // Caller passes the chain context (with possibly recipe-merged
  // effect_table) OR the raw skill item. Support both shapes — the
  // recipe-merged table wins when present.
  const isCtx = ctxOrSkill.skill !== undefined || ctxOrSkill.runtimeEffectTable !== undefined;
  const skill = isCtx ? ctxOrSkill.skill : ctxOrSkill;
  const tables = [
    isCtx ? ctxOrSkill.runtimeEffectTable : null,
    skill?.system?.props?.effect_table,
    skill?.system?.props?.reaction_effect_table,  // legacy alias
  ];
  for (const table of tables) {
    if (!table) continue;
    for (const key of Object.keys(table)) {
      const row = table[key];
      if (!row || row.$deleted) continue;
      if (row.effect_label === label) return row;
    }
  }
  return null;
}

// ── targeting ──────────────────────────────────────────────────────────
// Direct effect_kind:"targeting" invocation (rare — usually targeting
// rows are referenced via target_ref). Just resolves and reports.

async function applyTargetingEffect(row, ctx) {
  const result = await resolveTargetRef(row.effect_label, ctx);
  return { ok: !!result.ok, kind: "targeting", applied: result.tokens ?? [], reason: result.reason };
}

// ── add_target ───────────────────────────────────────────────────────────
// Target augmentation (Barrage). Resolves a `target_ref` targeting row —
// typically "pick 1 enemy not already targeted" (category: enemy,
// exclude_action_targets: true, skip_when_passive: false so it prompts even
// inside the passive reaction chain) — and stashes the picked token uuids on
// the mutable side-channel `ctx.payload._preRoll.addedTokenUuids`. The CONFIRM
// onAddTargetApply callback reads them back and splices them into the action,
// projecting the new target(s) against the already-rolled accuracy total so
// they share the single accuracy roll ("shared roll, post-roll pick").
//
// Returns abort when nothing was picked (empty pool / all already targeted /
// player cancelled) so a downstream consume_resource cost is skipped — the
// player pays only when a target is actually added ([[consume-last-in-chain]]:
// place the cost AFTER add_target in the chain).
async function applyAddTargetEffect(row, ctx) {
  const ref = row.target_ref;
  if (!ref) {
    warn(`skill-effects.add_target: row "${row.effect_label}" missing target_ref`);
    return { ok: false, kind: "add_target", reason: "no-target-ref", abort: true };
  }
  const res = await resolveTargetRef(ref, ctx);
  const tokens = res?.tokens ?? [];
  if (!res?.ok || !tokens.length) {
    return {
      ok: false, kind: "add_target",
      reason: res?.reason ?? "no-target",
      cancelled: !!res?.cancelled,
      abort: true,
    };
  }
  const sink = ctx?.payload?._preRoll;
  if (!sink || !Array.isArray(sink.addedTokenUuids)) {
    warn("skill-effects.add_target: no add-target sink on payload — fired outside an add_target window?");
    return { ok: false, kind: "add_target", reason: "no-sink", abort: true };
  }
  const added = [];
  for (const t of tokens) {
    const uuid = t?.uuid ?? t?.document?.uuid ?? null;
    if (uuid) { sink.addedTokenUuids.push(uuid); added.push(uuid); }
  }
  log(`skill-effects.add_target: queued ${added.length} extra target(s) for the add_target window`);
  return { ok: true, kind: "add_target", applied: added };
}

// ── grant ──────────────────────────────────────────────────────────────

async function applyGrantEffect(row, ctx) {
  const resource = String(row.grant_resource ?? "").trim().toLowerCase();
  const def = RESOURCE_PROPS[resource];
  if (!def) {
    warn(`skill-effects.grant: unknown resource "${row.grant_resource}" on row "${row.effect_label}"`);
    return { ok: false, kind: "grant", reason: "unknown-resource" };
  }

  // target_ref resolves to a token list. Without one, fail.
  const targetResult = await resolveTargetRef(row.target_ref, ctx);
  if (!targetResult.ok) {
    return { ok: false, kind: "grant", reason: targetResult.reason ?? "no-targets" };
  }
  const tokens = targetResult.tokens;
  if (!tokens.length) {
    return { ok: false, kind: "grant", reason: "no-targets" };
  }

  // Build the resolver freshly per consumer so DAMAGE_DEALT / HP_DEALT
  // etc. reflect THIS event's payload. SL reads from ctx.skill.
  const resolver = buildSkillResolver({
    actor: ctx.reactorActor,
    payload: ctx.payload,
    skill: ctx.skill,
    round: ctx.dCombat?.round ?? 0,
  });
  const amount = evaluateFormula(row.grant_amount, resolver, 0);
  if (amount === 0) {
    log(`skill-effects.grant: amount evaluated to 0 (row "${row.effect_label}"); skipping write`);
    return { ok: true, kind: "grant", applied: [], reason: "zero-amount" };
  }

  const applied = [];
  const suppressSelfHpHeal = !!ctx.payload?.vismagusHpPaid
    && resource === "hp"
    && amount > 0;
  for (const token of tokens) {
    const actor = token.actor;
    if (!actor) {
      warn(`skill-effects.grant: token has no actor (${token.uuid})`);
      continue;
    }
    // Vismagus self-heal suppression — if the caster paid HP for the
    // spell, they can't ALSO recover HP from it. Other targets unaffected.
    if (suppressSelfHpHeal && actor.uuid === ctx.reactorActor?.uuid) {
      log(`skill-effects.grant: Vismagus suppresses caster self-heal on row "${row.effect_label}"`);
      continue;
    }
    const result = await writeResourceDelta(actor, def, amount);
    if (result.ok) {
      applied.push({ actorUuid: actor.uuid, resource, delta: result.applied, newValue: result.newValue });
      // Recover VFX on a positive grant (heal / restore). A negative grant
      // (drain authored as a grant) is a loss; per the loss-VFX scoping
      // decision that path stays silent, so we only float gains here.
      if (result.applied > 0) {
        fireResourceGainVfx({ tokenUuid: token.uuid, resource, amount: result.applied });
      }
    }
  }
  log(`skill-effects.grant: row "${row.effect_label}" applied ${amount} ${resource} to ${applied.length} actor(s)`);
  return { ok: true, kind: "grant", applied };
}

// ── set_resource (raise-to-value / shield-apply / restore-revive) ────────
//
// Sets a resource UP TO a value — newValue = clamp(max(current, amount),
// hardMin, max). NEVER lowers (raise-only). Two canonical uses:
//   - Shield application — RAW: a new Shield does NOT stack; you keep the
//     BIGGER of the two (Golem Soulstone "gain 10 Shield" → max(cur, 10)).
//   - Restore-to-value revive — Phoenix Feather "restore HP to the Crisis
//     score" → max(cur, MAX_HP/2); a KO ally (0 HP) comes back at Crisis.
//     Setting HP > 0 un-defeats them (defeated is HP-derived, no flag).
//
// Row fields: grant_resource (hp|mp|shield|…), grant_amount (formula —
//   evaluated per target so MAX_HP reads the VICTIM's sheet), target_ref.
async function applySetResourceEffect(row, ctx) {
  const resource = String(row.grant_resource ?? row.set_resource ?? "").trim().toLowerCase();
  const def = RESOURCE_PROPS[resource];
  if (!def) {
    warn(`skill-effects.set_resource: unknown resource "${resource}" on row "${row.effect_label}"`);
    return { ok: false, kind: "set_resource", reason: "unknown-resource" };
  }
  const targetResult = await resolveTargetRef(row.target_ref, ctx);
  if (!targetResult.ok || !targetResult.tokens.length) {
    return { ok: false, kind: "set_resource", reason: targetResult.reason ?? "no-targets" };
  }
  const applied = [];
  for (const token of targetResult.tokens) {
    const actor = token.actor;
    if (!actor) continue;
    const resolver = buildSkillResolver({ actor, payload: ctx.payload, skill: ctx.skill, round: ctx.dCombat?.round ?? 0 });
    let value = Math.floor(Number(evaluateFormula(row.grant_amount ?? row.set_amount, resolver, 0)) || 0);
    const maxVal = def.max ? (Number(actor.system?.props?.[def.max]) || null) : null;
    if (maxVal != null) value = Math.min(value, maxVal);
    value = Math.max(def.hardMin ?? 0, value);
    const cur = Number(actor.system?.props?.[def.prop] ?? 0) || 0;
    const newValue = Math.max(cur, value); // raise-only
    if (newValue === cur) {
      log(`skill-effects.set_resource: ${actor.name} ${resource} already ≥ ${value} (cur ${cur}); no change`);
      continue;
    }
    try {
      await actor.update({ [`system.props.${def.prop}`]: newValue });
      applied.push({ actorUuid: actor.uuid, resource, from: cur, to: newValue });
      try { fireResourceGainVfx({ tokenUuid: token.uuid, resource, amount: newValue - cur }); } catch {}
      log(`skill-effects.set_resource: ${actor.name} ${resource} ${cur} → ${newValue} (row "${row.effect_label}")`);
    } catch (e) { warn(`skill-effects.set_resource: update failed on ${actor.name}`, e); }
  }
  return { ok: true, kind: "set_resource", applied };
}

// ── deal_damage ────────────────────────────────────────────────────────
//
// Deal element-typed damage OUTRIGHT to the target(s) — the offensive
// counterpart to `grant` (a raw resource delta with no affinity). Routes
// through the BD-native damage path: `computeIncomingDamage` (the incoming
// ruleset — DR + affinity + damage_taken_mult) → `applyDamageToTarget` (the
// single BD-supervised commit), so target affinity (VU ×2 / RS ½ / IM ×0 /
// AB → heal) applies automatically and the hit shares the attack pipeline's
// shield/Mercy/VFX handling. (Was the Gen-2 Universal Damage API,
// `FUCompanion.api.applyDamage.applyToActor`, which dragged in legacy chat-card
// display; retired here as part of the Gen-3 damage unification.)
// For status ticks (Burn) and any reaction that INFLICTS flat/elemental
// damage rather than modifying an in-flight attack (that is `add_damage`).
//
// Row fields:
//   damage_element  | element   — "fire" | "ice" | … | "physical" (default "elementless")
//   damage_amount   | amount    — formula evaluated PER TARGET (so MAX_HP / CUR_HP
//                                 read the VICTIM's sheet). Floored; ≤0 skips.
//   target_ref                  — defaults to "self".
//   attacker_name               — display label (default the skill/AE name).
// (`damage_verbosity` is no longer honored — Gen 3 has no verbosity knob yet;
//  the hit surfaces via the director VFX + log. Re-add if a silent tick is needed.)
// No attacker outgoing modifiers are applied (status/environmental damage),
// so a self-tick is not inflated by the bearer's own damage bonuses.
async function applyDealDamageEffect(row, ctx) {
  // Element may be a literal ("fire") OR a chain-local variable reference
  // ("VAR_ELEMENT") set earlier by a `prompt_element` row — so one deal_damage
  // can deal whatever type the player just chose (Meteor Shower, Infusions),
  // instead of one hard-coded row per element. VAR_ reads the STRING stashed on
  // ctx.payload._chainVars (the same bag prompt_number uses for numbers).
  const rawElement = String(row.damage_element ?? row.element ?? "elementless").trim();
  let element = rawElement.toLowerCase();
  if (/^var_/i.test(rawElement)) {
    const key = rawElement.slice(4).toLowerCase().trim();
    const v = ctx?.payload?._chainVars?.[key];
    element = String(v ?? "elementless").trim().toLowerCase() || "elementless";
  }
  const amountFormula = row.damage_amount ?? row.amount ?? "0";
  const targetRef = row.target_ref || "self";
  const attackerName = row.attacker_name || ctx.skill?.name || "Effect";
  // Opt-out of affinity (RS/VU/IM/AB) for flat/"true" effect damage — e.g. a
  // fixed opposed-check consequence (Pounce's 20) that should land regardless of
  // the target's resistances. Default off, so elemental ticks (Burn) still
  // respect affinity. Reads the declarative `damage_ignore_affinity` checkbox.
  const ignoreAffinity = row.damage_ignore_affinity === true || String(row.damage_ignore_affinity).toLowerCase() === "true";
  // Resource-ledger cause: deal_damage is direct/elemental damage (status ticks,
  // opposed-check consequences, riders), so it's HAZARD by default — it must NOT
  // trip "player-inflicted damage" reactions the way a real attack does. Authors
  // set damage_cause:"damage" for inflicted deal_damage that should count as an
  // attack. (Real attacks route through applyDamageToTarget, which stamps
  // cause:"damage" directly.)
  const damageCause = String(row.damage_cause ?? "").trim().toLowerCase() || "hazard";

  const targetResult = await resolveTargetRef(targetRef, ctx);
  if (!targetResult.ok || !targetResult.tokens.length) {
    return { ok: false, kind: "deal_damage", reason: targetResult.reason ?? "no-targets" };
  }
  // Battle-log sink: inherit the owning action's sink when fired as a rider
  // (so an attack + its deal_damage riders coalesce into ONE write), else own a
  // local sink and flush it here (a standalone Burn tick = one write; a multi-
  // target deal_damage = one write for all its targets).
  const inheritedSink = Array.isArray(ctx.battleLogSink) ? ctx.battleLogSink : null;
  const battleLogSink = inheritedSink ?? [];
  const applied = [];
  for (const token of targetResult.tokens) {
    const actor = token.actor;
    if (!actor) continue;
    // Per-target resolver so MAX_HP / CUR_HP read the VICTIM's sheet.
    const resolver = buildSkillResolver({
      actor,
      payload: ctx.payload,
      skill: ctx.skill,
      round: ctx.dCombat?.round ?? 0,
    });
    const amount = Math.floor(Number(evaluateFormula(amountFormula, resolver, 0)) || 0);
    if (amount <= 0) {
      log(`skill-effects.deal_damage: amount ≤ 0 for ${actor.name} (row "${row.effect_label}"); skipping`);
      continue;
    }
    try {
      // BD-native incoming ruleset → BD-supervised commit (Gen 3). Replaces the
      // Gen-2 apply-damage-core path (which dragged in the legacy chat-card
      // display). No attacker OUTGOING modifiers — status/environmental damage
      // isn't inflated by the bearer's own bonuses; the base is baked in the
      // damage_amount formula. The commit also applies shield absorption and the
      // Mercy reaction-AE clamp (shared with the attack pipeline).
      const ruled = computeIncomingDamage(actor, { base: amount, element, ignoreAffinity });
      const hpBefore = readPropNum(actor, ["current_hp", "hp"]);
      const res = await applyDamageToTarget({
        target: actor,
        damage: ruled.damage,
        affinity: ruled.affinity,
        resource: "hp",
        targetName: actor.name,
        tokenUuid: token.document?.uuid ?? null,
        logPrefix: `${attackerName}:`,
        // Effect/tick damage → Battle Log (one row per target, flushed once
        // below). sourceType "effect" so the log distinguishes ticks/riders
        // from weapon attacks. No weapon/efficiency/range (status damage).
        logContext: { attackerName, element, sourceType: "effect", sink: battleLogSink },
      });
      applied.push({ actorUuid: actor.uuid, amount, element, final: res?.finalValue ?? null, direction: res?.valueDirection });

      // Resource-ledger (cause taxonomy): itemize this hit onto the running
      // director's post-commit ledger so the Start-of-Turn transaction's settle
      // (crisis reactor etc.) and the turn breakdown see one line per source.
      // Derived from the ACTUAL committed HP delta (re-read the now-mutated
      // in-memory actor) — Gen 3 absorbs shield before HP, so the HP delta can
      // be < `ruled.damage`. deal_damage is HP-only, so we ledger only the HP
      // line; a tick fully soaked by shield moves no HP and (by design) emits no
      // ledger line. NOTE: the old Gen-2 path also itemized shield/mp bands —
      // restore those lines here if a shield-loss reaction ever needs to fire on
      // tick damage. No-op out of combat (getActiveDirector() → null).
      const _director = ctx?.director
        ?? globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.();
      if (_director) {
        const hpAfter = readPropNum(actor, ["current_hp", "hp"]);
        const delta = hpAfter - hpBefore;
        if (delta !== 0) {
          fireResourceChangeTrigger({
            director: _director,
            actor,
            tokenUuid: token.document?.uuid ?? null,
            resource: "hp",
            direction: delta < 0 ? "loss" : "recover",
            amount: Math.abs(delta),
            cause: damageCause,          // hazard (default) | damage (declared)
            element,                     // itemized identity
            // Source name for the breakdown: an explicit attacker_name wins,
            // else the carrier (AE/item, e.g. "Burn"), else the skill, else
            // the generic damage label.
            originLabel: row.attacker_name || ctx.sourceLabel || ctx.skill?.name || attackerName,
            originUuid: ctx.sourceUuid ?? ctx.skill?.uuid ?? null,
          });
        }
      }
    } catch (e) {
      warn(`skill-effects.deal_damage: applyDamageToTarget failed on ${actor.name}`, e);
    }
  }
  // Flush only when WE own the sink — if a parent action lent us theirs, they
  // flush after their own loop so the whole action is one write.
  if (!inheritedSink && battleLogSink.length) await appendBattleLog(battleLogSink);
  log(`skill-effects.deal_damage: row "${row.effect_label}" dealt ${element} to ${applied.length} actor(s)`);
  return { ok: true, kind: "deal_damage", applied };
}

// ── consume_resource ───────────────────────────────────────────────────
//
// Spend a fixed amount of a resource (mp/hp/ip) on the target(s). Mirrors
// the legacy reaction-grant.js semantics: the cost is debited at chain
// fire time, BEFORE the next chain step. On insufficient funds, the
// chain aborts (`on_empty: "abort"` default — only "abort" is supported
// in this shipping; other behaviors deferred).
//
// Row fields:
//   consume_resource | grant_resource — "mp" | "hp" | "ip" (latter alias
//                                       for legacy compatibility)
//   consume_amount   | grant_amount   — formula string (SL, CHAR_LEVEL, ...)
//   target_ref                        — defaults to "self" if omitted
//   on_empty                          — "abort" (default) | "warn" | "skip"
//
// Used by High Speed (spend 10 MP for a free action), Stolen Time
// (variable cost), and any other "spend X to fire next step" pattern.
async function applyConsumeResourceEffect(row, ctx) {
  const resource = String(row.consume_resource ?? row.grant_resource ?? "").trim().toLowerCase();
  const def = RESOURCE_PROPS[resource];
  if (!def) {
    warn(`skill-effects.consume_resource: unknown resource "${resource}" on row "${row.effect_label}"`);
    return { ok: false, kind: "consume_resource", reason: "unknown-resource", abort: true };
  }
  const targetRef = row.target_ref || "self";
  const targetResult = await resolveTargetRef(targetRef, ctx);
  if (!targetResult.ok || !targetResult.tokens.length) {
    return { ok: false, kind: "consume_resource", reason: "no-targets", abort: true };
  }
  const resolver = buildSkillResolver({
    actor: ctx.reactorActor,
    payload: ctx.payload,
    skill: ctx.skill,
    round: ctx.dCombat?.round ?? 0,
  });
  const amount = evaluateFormula(row.consume_amount ?? row.grant_amount, resolver, 0);
  if (amount <= 0) {
    log(`skill-effects.consume_resource: amount evaluated to ${amount} (row "${row.effect_label}"); no debit`);
    return { ok: true, kind: "consume_resource", applied: [], reason: "zero-amount" };
  }
  const onEmpty = String(row.on_empty ?? "abort").toLowerCase();
  const applied = [];
  for (const token of targetResult.tokens) {
    const actor = token.actor;
    if (!actor) continue;
    // IP spends honor the payer's own ip_reduction_value (Deep Pockets), never
    // below 1 — same rule as BD item-create. Per-target so each payer's mod applies.
    const effAmount = resource === "ip" ? ipReducedAmount(amount, actor) : amount;
    const cur = Number(actor.system?.props?.[def.prop] ?? 0) || 0;
    if (cur < effAmount) {
      log(`skill-effects.consume_resource: ${actor.name} has ${cur} ${resource}, needs ${effAmount}; ${onEmpty}`);
      if (onEmpty === "abort") {
        return { ok: false, kind: "consume_resource", reason: "insufficient", abort: true };
      }
      // Other behaviors (skip / warn) would continue here — kept minimal for ship.
      continue;
    }
    const result = await writeResourceDelta(actor, def, -effAmount);
    if (result.ok) {
      applied.push({ actorUuid: actor.uuid, resource, delta: result.applied, newValue: result.newValue });
      // Spend float over the payer's token. `result.applied` is negative for
      // a debit; the VFX shows its magnitude as `−N`.
      const spent = Math.abs(result.applied);
      if (spent > 0) fireResourceSpendVfx({ tokenUuid: token.uuid, resource, amount: spent });
    }
  }
  log(`skill-effects.consume_resource: row "${row.effect_label}" debited ${amount} ${resource} from ${applied.length} actor(s)`);
  return { ok: true, kind: "consume_resource", applied };
}

async function writeResourceDelta(actor, resourceDef, delta) {
  const cur = Number(actor.system?.props?.[resourceDef.prop] ?? 0) || 0;
  const max = resourceDef.max ? Number(actor.system?.props?.[resourceDef.max] ?? 0) || 0 : null;
  const hardMin = Number.isFinite(resourceDef.hardMin) ? resourceDef.hardMin : 0;
  const hardMax = Number.isFinite(resourceDef.hardMax) ? resourceDef.hardMax : Infinity;

  let next = cur + delta;
  if (max != null) next = Math.min(max, next);
  next = Math.min(hardMax, Math.max(hardMin, next));
  if (next === cur) return { ok: true, applied: 0, newValue: cur };

  try {
    await actor.update({ [`system.props.${resourceDef.prop}`]: next });
    return { ok: true, applied: next - cur, newValue: next };
  } catch (e) {
    warn("skill-effects.grant: actor.update threw", e);
    return { ok: false, applied: 0, newValue: cur, error: e };
  }
}

// ── apply_ae ───────────────────────────────────────────────────────────

// Status-immunity gate. Returns true if any element of `statuses` matches
// a `condition_<id>` prop on `actor` whose value is "IM" (immune). Used
// by apply_ae to refuse applying a status AE to an actor that's immune
// (Rampart's "cannot suffer status effects" mechanic + future per-actor
// permanent immunities).
//
// Convention: a status id like "slow" or "dazed" maps to actor prop
// `condition_slow` / `condition_dazed`. The CSB template carries these
// fields as `label` type (post 2026-06-03 surgery) so AEs can write
// "NA" / "RS" / "IM" / "AB" into them.
//
// Custom non-status template ids ("fud-bodyguard", "fud-aura", etc.)
// have no matching `condition_*` prop, so the lookup returns undefined
// and the gate doesn't trigger.
function isTargetImmuneToStatuses(actor, statuses) {
  if (!actor) return false;
  if (!Array.isArray(statuses) || !statuses.length) return false;
  const props = actor.system?.props ?? {};
  for (const sid of statuses) {
    const id = String(sid ?? "").trim().toLowerCase();
    if (!id) continue;
    const propKey = `condition_${id}`;
    if (!(propKey in props)) continue;  // not a known status condition
    if (String(props[propKey] ?? "").trim().toUpperCase() === "IM") return true;
  }
  return false;
}

// True iff a string value looks like a NUMERIC formula (worth baking) rather
// than a bare string literal. Real formulas carry arithmetic/grouping/comma
// punctuation, OR a function call (parens), OR an ALL-CAPS schema identifier
// (2+ consecutive capitals: SL, HR, TOTAL, BOND_STRENGTH, HP_DEALT, CUR_MP …).
// Bare words ("melee", "ranged", "Light") have none and must pass through
// unbaked — used as OVERRIDE (mode 5) change values.
function looksLikeNumericFormula(s) {
  const str = String(s);
  if (/[+\-*/%(),]/.test(str)) return true;
  if (/[A-Z]{2,}/.test(str)) return true;
  return false;
}

// Hinder's card-picked status → canonical AE name. The Common/Hinder item
// uses `ae_template_ref: "status_value"` and the apply_ae handler resolves the
// concrete debuff name from ctx.actionResult.statusValue at fire time.
const HINDER_STATUS_NAMES = { dazed: "Dazed", shaken: "Shaken", slow: "Slow", weak: "Weak" };

async function applyApplyAeEffect(row, ctx) {
  let aeRef = String(row.ae_template_ref ?? "").trim();
  // Dynamic ref: resolve the debuff name from the action's picked status
  // (Hinder). Done before the empty-check so a missing pick fails cleanly.
  if (aeRef === "status_value" || aeRef === "{status_value}") {
    const sv = String(ctx.actionResult?.statusValue ?? "").trim().toLowerCase();
    aeRef = HINDER_STATUS_NAMES[sv] ?? "";
    if (!aeRef) {
      warn(`skill-effects.apply_ae: status_value ref but no/unknown actionResult.statusValue ("${ctx.actionResult?.statusValue}")`);
      return { ok: false, kind: "apply_ae", reason: "no-status-value" };
    }
  }
  if (!aeRef) {
    warn(`skill-effects.apply_ae: missing ae_template_ref on "${row.effect_label}"`);
    return { ok: false, kind: "apply_ae", reason: "no-ae-ref" };
  }
  const dupMode = String(row.ae_duplicate_mode ?? "replace").trim().toLowerCase();
  // Per-caster modes (`replace_per_caster`, `skip_per_caster`,
  // `remove_per_caster`) restrict the duplicate match to AEs that THIS
  // caster previously applied — read from
  // `flags.fabula-ultima-companion.directorAppliedBy.reactorActorUuid`,
  // stamped on every AE created via this dispatcher. Lets buffs from
  // different casters coexist on the same target (Spiritist A's
  // Reinforce(Dazed) + Spiritist B's Reinforce(Dazed) = two AEs) while
  // a single caster re-casting only ever maintains one instance.
  const isPerCaster = dupMode.endsWith("_per_caster");
  const baseMode = isPerCaster ? dupMode.slice(0, -"_per_caster".length) : dupMode;
  const casterUuid = ctx.reactorActor?.uuid ?? null;

  const targetResult = await resolveTargetRef(row.target_ref, ctx);
  if (!targetResult.ok) return { ok: false, kind: "apply_ae", reason: targetResult.reason ?? "no-targets" };
  const tokens = targetResult.tokens;
  if (!tokens.length) return { ok: false, kind: "apply_ae", reason: "no-targets" };

  // Resolve the AE template data. B.1 supports:
  //   - "Item.<id>.ActiveEffect.<id>"  full UUID
  //   - the AE's name as it appears on the skill's effects collection
  //   - an effect's _id on the skill's effects collection
  const template = await resolveAeTemplate(aeRef, ctx);
  if (!template) {
    warn(`skill-effects.apply_ae: AE template "${aeRef}" not found`);
    return { ok: false, kind: "apply_ae", reason: "template-not-found" };
  }

  // Charge counts (ae_initial_charges / _max) may be FORMULAS — evaluated per
  // target so they can read the victim's state or chain vars (Blazing Tether's
  // "give" = apply_ae Burn add_charges ae_initial_charges "VAR_MOVE_AMOUNT" → add
  // the entered move amount, creating the AE if the receiver has none). A plain
  // number string ("3") takes evaluateFormula's literal fast-path; an unparseable
  // value folds to null (same as the old Number()→NaN→template-default behavior).
  const { buildSkillResolver, evaluateFormula } = await getSkillFormulas();
  const applied = [];
  for (const token of tokens) {
    const actor = token.actor;
    if (!actor) continue;
    const chargeResolver = buildSkillResolver({ actor, payload: ctx.payload, skill: ctx.skill, round: ctx.dCombat?.round ?? 0 });
    const evalCharge = (raw) => {
      if (raw == null || String(raw).trim() === "") return null;
      const n = Number(evaluateFormula(String(raw), chargeResolver, NaN));
      return Number.isFinite(n) ? n : null;
    };

    // Status-immunity gate (engine-gap #4 stub — Rampart's "cannot suffer
    // status effects" lands as `condition_<status> = "IM"` AE writes on
    // the target). When the cloned template carries `statuses` AND the
    // target's `condition_<id>` reads "IM", skip the entire AE for this
    // target. The gate only fires when the prop EXISTS — non-status
    // template ids like "fud-bodyguard" have no matching prop so they
    // pass through.
    if (isTargetImmuneToStatuses(actor, template.statuses)) {
      log(`skill-effects.apply_ae: ${actor.name} immune to "${template.name}" (condition_<id>=IM matches a status)`);
      continue;
    }

    // `replace_same_status` — Hinder semantics. Distinct statuses coexist
    // (Weak + Slow together is RAW-legal), but re-applying the SAME status
    // replaces the prior instance. Match by the template's canonical Foundry
    // status ids OR the literal name (the four basic debuffs share one parent
    // world Item, so name/status — not parent id — distinguishes them). This
    // folds the bespoke Hinder dedup (state-handlers.js) into apply_ae.
    // `add_charges` — find existing AE by name; if found, increment its
    // charges by ae_initial_charges (or the template's charges value) up
    // to ae_initial_charges_max (or the existing AE's chargesMax). If no
    // existing AE, fall through to create a fresh one with the normal path.
    if (baseMode === "add_charges") {
      const rowChargesAdd = evalCharge(row.ae_initial_charges);
      const rowChargesMax = evalCharge(row.ae_initial_charges_max);
      const existing = findDuplicateAe(actor, template, null);
      if (existing) {
        const curCharges = Number(existing.flags?.[FLAG_NS]?.charges ?? 0) || 0;
        const addCharges = (rowChargesAdd != null && Number.isFinite(rowChargesAdd))
          ? rowChargesAdd
          : (Number(template.flags?.[FLAG_NS]?.charges ?? 0) || 0);
        const maxCharges = (rowChargesMax != null && Number.isFinite(rowChargesMax))
          ? rowChargesMax
          : (Number(existing.flags?.[FLAG_NS]?.chargesMax ?? template.flags?.[FLAG_NS]?.chargesMax ?? 99999) || 99999);
        const newCharges = Math.min(maxCharges, curCharges + addCharges);
        await existing.update({ [`flags.${FLAG_NS}.charges`]: newCharges });
        log(`skill-effects.apply_ae add_charges: "${template.name}" on ${actor.name} charges ${curCharges}+${addCharges}=${newCharges} (max=${maxCharges})`);
        applied.push({ actorUuid: actor.uuid, aeId: existing.id, name: existing.name, chargesAdded: addCharges, newCharges });
        continue;
      }
      // No existing AE — fall through to create a new one below.
    } else if (baseMode === "replace_same_status") {
      const existingSame = findSameStatusAe(actor, template);
      if (existingSame) { try { await existingSame.delete(); } catch (e) { warn("apply_ae replace_same_status delete failed", e); } }
      // fall through to create the fresh instance
    } else {
      const existing = findDuplicateAe(actor, template, isPerCaster ? { casterActorUuid: casterUuid } : null);
      if (existing) {
        if (baseMode === "skip") { log(`skill-effects.apply_ae: ${actor.name} already has "${template.name}"${isPerCaster ? " from this caster" : ""} (skip)`); continue; }
        if (baseMode === "remove") { try { await existing.delete(); applied.push({ actorUuid: actor.uuid, removed: existing.name }); } catch (e) { warn("apply_ae remove failed", e); } continue; }
        if (baseMode === "replace") { try { await existing.delete(); } catch (e) { warn("apply_ae replace-delete failed", e); } }
        // "stack" falls through to create a new one
      }
    }

    // Build the data — stamp `origin` to the firing skill so the AE
    // tracks back to its source (matches legacy behavior).
    const data = foundry.utils.deepClone(template);
    delete data._id;  // let Foundry assign a fresh id
    // ae_initial_charges / ae_initial_charges_max — row-level charge
    // override. Lets the effect row stamp a specific charge count onto an
    // otherwise chargeless world-template AE (e.g. the "Burn" Debuff
    // container entry has no charges; the burn_apply row specifies 3).
    {
      const rowC = evalCharge(row.ae_initial_charges);
      const rowCMax = evalCharge(row.ae_initial_charges_max);
      if (rowC != null && Number.isFinite(rowC) && rowC > 0) {
        data.flags = data.flags ?? {};
        data.flags[FLAG_NS] = data.flags[FLAG_NS] ?? {};
        data.flags[FLAG_NS].charges = rowC;
        if (rowCMax != null && Number.isFinite(rowCMax)) {
          data.flags[FLAG_NS].chargesMax = rowCMax;
        }
      }
    }
    // Clear Foundry core duration fields so the core AE-expiry system never
    // touches director-applied AEs. BD uses directorAppliedBy.turnsRemaining
    // instead. Without this, world-template AEs that carry duration.rounds
    // (e.g. the Debuff-container Burn has duration.rounds=3) expire via
    // Foundry core mid-turn when the BD advances the combat turn for a free
    // action — causing the AE to be deleted before the second sweep can find it.
    if (data.duration) {
      data.duration.rounds    = null;
      data.duration.turns     = null;
      data.duration.seconds   = null;
      data.duration.startRound = null;
      data.duration.startTurn  = null;
    }
    // Force `transfer: false` on the clone. Foundry's `transfer` flag
    // only fires for AE-on-Item → equip-to-Actor transfers; once we've
    // CLONED the template onto a target actor it's not transferable
    // by definition. Authors should also uncheck "Apply to parent" on
    // their templates for sheet hygiene (see [[opt-in-ae-classification]]),
    // but the engine guarantees the runtime invariant either way.
    data.transfer = false;
    if (!data.origin) data.origin = ctx.skill?.uuid ?? ctx.reactorActor?.uuid ?? null;

    // ── Bake formula identifiers in `changes[].value` at apply-time ──
    //
    // AE templates often carry identifiers like `BOND_STRENGTH` or
    // `SL` as the change's `value`. CSB's own AE-formula bridge resolves
    // against the BEARER actor (the ally), which is wrong for caster-
    // derived values — caster's bond toward THIS specific ally has to
    // be evaluated NOW, against the caster + this target's pair.
    //
    // We resolve via the director's buildSkillResolver and write the
    // computed literal number into `data.changes[].value`. Each target's
    // AE then carries its own baked value (Ally A: bonus_check += 3;
    // Ally B: bonus_check += 1). Non-formula values (plain numbers,
    // strings like "Light") pass through unchanged.
    let bakeResolver = null;
    function getBakeResolver() {
      if (bakeResolver) return bakeResolver;
      bakeResolver = buildSkillResolver({
        actor: ctx.reactorActor,
        skill: ctx.skill,
        payload: {
          ...(ctx.payload ?? {}),
          subjectName: actor.name,
          targetName:  actor.name,
          actorName:   actor.name,
          tokenName:   token.name ?? actor.name,
        },
        round: ctx.dCombat?.round ?? 0,
      });
      return bakeResolver;
    }

    // String-token pre-bake. Substitutes a fixed allowlist of identifier
    // tokens with non-numeric literal strings (e.g. the caster's actor
    // UUID) BEFORE the numeric formula bake. Numeric values would bail
    // the evaluateFormula path below (`!Number.isFinite(resolved)`), so
    // string substitutions live here as a pre-step.
    //
    // Tokens use the same `${name}$` syntax as numeric formulas so authors
    // get a consistent feel. Allowlist is intentionally narrow; each
    // entry's getter returns null/empty if the source isn't resolvable
    // (rare — apply_ae always has the caster in ctx). First consumer:
    // Vanish's `cannot_target_uuids` AE change writes `${casterActorUuid}$`
    // and target-picker filters read the baked UUID literal.
    const STRING_TOKEN_GETTERS = {
      casterActorUuid: () => ctx.reactorActor?.uuid ?? "",
      casterTokenUuid: () => ctx.reactorToken?.uuid ?? "",
      targetActorUuid: () => actor?.uuid ?? "",
      targetTokenUuid: () => token?.uuid ?? "",
    };
    if (Array.isArray(data.changes) && data.changes.length) {
      for (const ch of data.changes) {
        if (typeof ch?.value !== "string") continue;
        let v = ch.value;
        for (const [token, get] of Object.entries(STRING_TOKEN_GETTERS)) {
          const pat = `\${${token}}$`;
          if (v.includes(pat)) {
            const replacement = String(get() ?? "");
            v = v.split(pat).join(replacement);
          }
        }
        if (v !== ch.value) {
          log(`apply_ae bake (string-token): "${ch.value}" → "${v}" (target=${actor.name})`);
          ch.value = v;
        }
      }
    }
    if (Array.isArray(data.changes) && data.changes.length) {
      for (const ch of data.changes) {
        if (typeof ch?.value !== "string") continue;
        // Affinity-slot changes carry affinity CODES (VU/RS/IM/AB/NE) — bare
        // 2-letter all-caps tokens that collide with the all-caps-identifier
        // heuristic below, which would "evaluate" the unknown code to 0 and
        // corrupt e.g. Oil/Wet's affinity_N "VU" → "0". These are never numeric
        // formulas; never bake them (the per-target affinity-override filter
        // further down owns affinity_N handling).
        if (/^(?:system\.props\.)?affinity_\d+$/.test(String(ch.key ?? ""))) continue;
        if (!isFormulaString(ch.value)) continue;
        // Only bake values that actually LOOK like a numeric formula. A bare
        // word string-literal change ("melee", "Light", "ranged" — used by
        // OVERRIDE (mode 5) directives like cannot_be_targeted_by) is not a
        // number, but evaluateFormula would resolve its unknown identifier to
        // 0 and silently corrupt it. Real formulas always carry arithmetic /
        // grouping punctuation OR an ALL-CAPS schema identifier (SL, HR,
        // BOND_STRENGTH, HP_DEALT, CUR_MP, …) OR a function call (parens).
        if (!looksLikeNumericFormula(ch.value)) continue;
        const resolved = evaluateFormula(ch.value, getBakeResolver(), null);
        if (resolved == null || !Number.isFinite(resolved)) continue;
        log(`apply_ae bake: "${ch.value}" → ${resolved} (target=${actor.name})`);
        ch.value = String(resolved);
      }
    }

    // Gap 9 from canon hardening: bake formula identifiers in a narrow
    // set of `flags["fabula-ultima-companion"].*` fields at apply-time.
    // Same rationale as the changes[].value bake — the caster's state at
    // apply-time is what we want recorded, not the bearer's state at
    // fire-time. Allowlist (intentionally narrow):
    //   • chargesMax — integer; consumed by skill-charges.consume.
    //     Authors may want `chargesMax: "SL"` etc.
    //   • <anything>Formula — convention for "this flag carries a formula".
    //     Bake to a literal numeric value.
    function shouldBakeFlagKey(k) {
      if (k === "chargesMax") return true;
      if (typeof k === "string" && k.endsWith("Formula")) return true;
      return false;
    }
    if (data.flags?.[FLAG_NS]) {
      for (const [k, v] of Object.entries(data.flags[FLAG_NS])) {
        if (!shouldBakeFlagKey(k)) continue;
        if (typeof v !== "string") continue;
        if (!isFormulaString(v)) continue;
        const resolved = evaluateFormula(v, getBakeResolver(), null);
        if (resolved == null || !Number.isFinite(resolved)) continue;
        log(`apply_ae bake: flags.${FLAG_NS}.${k} "${v}" → ${resolved} (target=${actor.name})`);
        data.flags[FLAG_NS][k] = Number.isInteger(resolved) ? resolved : Number(resolved);
      }
    }

    // Bake reaction-formula fields on the cloned AE's carried reactionConfig.
    // An applied buff AE's reaction (e.g. Hawkeye's "+SL×2 to your next ranged
    // attack") lives in flags.<ns>.reactionConfig.effect_table[*]. SL there
    // resolves against the CARRIER AE at fire-time — but an applied AE has no
    // level, so SL would fall back to 1 and lose the granting skill's scaling.
    // Resolve `damage_amount` / `grant_amount` formulas NOW (against the
    // caster + granting skill in ctx), writing literals so the buff reflects
    // the skill's SL at apply-time. Same gate as changes[] (skip bare-word
    // string literals; only bake true numeric formulas). Reusable for any
    // SL-scaling applied-buff reaction, not just Hawkeye.
    const REACTION_FORMULA_FIELDS = ["damage_amount", "grant_amount"];
    const rcfg = data.flags?.[FLAG_NS]?.reactionConfig;
    const rcfgTable = rcfg?.effect_table ?? rcfg?.reaction_effect_table;
    if (rcfgTable && typeof rcfgTable === "object") {
      for (const erow of Object.values(rcfgTable)) {
        if (!erow || typeof erow !== "object" || erow.$deleted) continue;
        for (const f of REACTION_FORMULA_FIELDS) {
          const raw = erow[f];
          if (typeof raw !== "string") continue;
          if (!isFormulaString(raw) || !looksLikeNumericFormula(raw)) continue;
          const resolved = evaluateFormula(raw, getBakeResolver(), null);
          if (resolved == null || !Number.isFinite(resolved)) continue;
          log(`apply_ae bake (reactionConfig.${f}): "${raw}" → ${resolved} (target=${actor.name})`);
          erow[f] = String(resolved);
        }
      }
    }

    if (!data.flags) data.flags = {};
    data.flags[FLAG_NS] = data.flags[FLAG_NS] ?? {};
    // Per-AE duration counter (homebrew rule: default 3 turns, tick at
    // the start of the AE applier's turn; see [[ae-default-3-turn-duration]]).
    // Templates can override by setting `duration.rounds` to a positive
    // integer; setting it to 0 (or stamping `directorPermanent` in
    // the template's `flags.fabula-ultima-companion`) opts out of
    // ticking entirely.
    const flagsNS = template.flags?.[FLAG_NS] ?? {};
    const explicit = Number(template.duration?.rounds);
    const lifetimeMode = String(flagsNS.lifetimeMode ?? "").trim().toLowerCase();
    // Per-AE lifecycle mode (homebrew):
    //   - lifetimeMode === "round_end"  → expires via tickDirectorAEsAtRoundEnd
    //     at the END of the round it was applied in (Rampart). The
    //     applier-turn tick skips it (turnsRemaining stays null).
    //   - directorPermanent === true    → never expires (legacy trait pattern).
    //   - Otherwise                     → applier-turn tick decrements
    //     turnsRemaining (default 3, override via duration.rounds).
    let turnsRemaining;
    if (flagsNS.directorPermanent === true) {
      turnsRemaining = null;  // opt-out: never expires
    } else if (lifetimeMode === "round_end") {
      turnsRemaining = null;  // owned by round-end sweep, not applier-turn tick
    } else if (lifetimeMode === "on_activation") {
      turnsRemaining = null;  // charge-governed: expires when charges deplete on fire, not by turn-tick
    } else if (lifetimeMode === "target_turn_end") {
      // "Lasts N of the AFFECTED creature's turns, decrement at the END of each
      // of the bearer's turns" — the homebrew action-gating Advanced Debuffs
      // (Frightened/Silence/Confused/Disarmed/Berserk). Counted here (default 3,
      // override via duration.rounds) but ticked by tickDirectorAEsForBearerTurnEnd
      // at TURN_END, NOT by the applier-turn-start tick (which skips this mode).
      turnsRemaining = Number.isFinite(explicit) && explicit > 0 ? explicit : 3;
    } else if (Number.isFinite(explicit) && explicit > 0) {
      turnsRemaining = explicit;
    } else {
      turnsRemaining = 3;
    }
    data.flags[FLAG_NS].directorAppliedBy = {
      skillUuid: ctx.skill?.uuid ?? null,
      reactorActorUuid: ctx.reactorActor?.uuid ?? null,
      // Applier's TOKEN — needed by relationship statuses that must resolve the
      // SPECIFIC token (not just the world actor), e.g. Grappled tracks the
      // grappler's token for its "same space" / redirect-targeting rule and for
      // unlinked NPC tokens that share one base actor. See [[project_grappled_advanced_debuff]].
      reactorTokenUuid: ctx.reactorToken?.uuid ?? null,
      effectLabel: row.effect_label,
      appliedAtRound: ctx.dCombat?.round ?? 0,
      turnsRemaining,
      ...(lifetimeMode ? { lifetimeMode } : {}),
    };
    // Guard-cover marker (Grappled rule #2 — [[project_grappled_advanced_debuff]]).
    // The Covered AE is the canonical "this ally is being covered by X" effect;
    // `target_ref: "cover_target"` is the generic signal (only Guard's
    // guard_cover row targets it). Stamp the guarder so endGuardCoverProvidedBy
    // can find + remove this cover (and its riders) when the guarder becomes
    // Grappled. The guarder keeps its own self-Guard (a separate AE on itself).
    if (row?.target_ref === "cover_target" && ctx.reactorActor?.uuid) {
      data.flags[FLAG_NS].guardCoverBy = ctx.reactorActor.uuid;
    }
    // Affinity-override protection: an AE that OVERRIDES element-affinity props
    // (affinity_1..9 — e.g. Guard's "Resistance to all") must NOT downgrade an
    // element the target is natively Immune/Absorbing to. Drop those specific
    // override changes per target so IM/AB are preserved. Generic — applies to
    // any affinity-buff AE, keeping the affinity props the single source of truth.
    if (Array.isArray(data.changes) && data.changes.length) {
      const nativeProps = actor.system?.props ?? {};
      data.changes = data.changes.filter((c) => {
        const m = /^(?:system\.props\.)?(affinity_\d+)$/.exec(String(c?.key ?? ""));
        if (!m) return true; // non-affinity change — keep
        const native = String(nativeProps[m[1]] ?? "").trim().toUpperCase();
        if (native === "IM" || native === "AB") {
          log(`apply_ae: ${actor.name} natively ${native} on ${m[1]} — dropping "${data.name}" affinity override (preserve IM/AB)`);
          return false;
        }
        return true;
      });
    }
    try {
      const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [data]);
      applied.push({ actorUuid: actor.uuid, aeId: created?.id ?? null, name: data.name });
    } catch (e) {
      warn(`skill-effects.apply_ae: createEmbeddedDocuments failed on ${actor.name}`, e);
    }
  }
  // Reciprocal AE (declarative, director-supervised). A template may carry
  // flags[FLAG_NS].reciprocalAe = "<AE name>" to ALSO apply that AE to the
  // APPLIER (ctx.reactorActor) whenever this AE lands. Grappled → "Grappling"
  // on the grappler, which hosts the shared-space splash reaction (rule #1).
  // Runs INSIDE this supervised apply flow (stamped + snapshot/rewind-safe) —
  // deliberately NOT a global hook. Applied once via a self-targeted recursive
  // call with skip-dup; recursion-safe (the reciprocal carries no reciprocalAe
  // of its own + the _reciprocalApply guard). See [[project_grappled_advanced_debuff]].
  const reciprocalName = String(template.flags?.[FLAG_NS]?.reciprocalAe ?? "").trim();
  if (reciprocalName && applied.length && !ctx._reciprocalApply && ctx.reactorActor) {
    try {
      await applyApplyAeEffect(
        {
          effect_label: `${row.effect_label}__reciprocal`,
          effect_kind: "apply_ae",
          ae_template_ref: reciprocalName,
          target_ref: "self",
          ae_duplicate_mode: "skip",
        },
        { ...ctx, _reciprocalApply: true },
      );
    } catch (e) { warn(`skill-effects.apply_ae: reciprocal "${reciprocalName}" apply failed`, e); }
  }
  log(`skill-effects.apply_ae: row "${row.effect_label}" applied "${template.name}" to ${applied.length} actor(s)`);
  return { ok: true, kind: "apply_ae", applied };
}

async function resolveAeTemplate(aeRef, ctx) {
  // 1. Full UUID with /ActiveEffect/?
  if (aeRef.includes("ActiveEffect.")) {
    try {
      const eff = await fromUuid(aeRef);
      if (eff) return eff.toObject();
    } catch {}
  }
  // 2. Search skill's own effects by name / id (per-skill local templates,
  //    e.g. Reinforce's "Reinforced (Dazed)").
  const skillEffects = ctx.skill?.effects ?? [];
  for (const eff of skillEffects) {
    if (eff.name === aeRef || eff.id === aeRef) return eff.toObject();
  }
  // 3. Fallback: any `activeEffectContainer` Item in the world holding an
  //    effect by that name. This is how the canonical status library
  //    works — the GM curates "Debuff" / "Buff" / "Active Effects"
  //    container Items, and skills reference status AEs by bare name
  //    (`"Slow"`, `"Enraged"`, ...). Returns the FIRST match; logs a
  //    warning if multiple containers expose the same name so authors
  //    can disambiguate via UUID if it ever matters.
  const matches = [];
  for (const it of game.items ?? []) {
    if (it.type !== "activeEffectContainer") continue;
    for (const eff of it.effects ?? []) {
      if (eff.name === aeRef) matches.push({ container: it.name, effect: eff });
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    warn(`skill-effects.resolveAeTemplate: "${aeRef}" matched ${matches.length} containers — using "${matches[0].container}". Use the full ActiveEffect UUID for explicit selection.`);
  }
  return matches[0].effect.toObject();
}

function findDuplicateAe(actor, template, scope = null) {
  if (!actor?.effects) return null;
  const targetName = template.name;
  // Scope.casterActorUuid restricts the match to AEs THIS caster
  // applied. Identified via the `directorAppliedBy.reactorActorUuid`
  // flag we stamp in applyApplyAeEffect. Other casters' AEs with the
  // same name are skipped — they coexist alongside the new one.
  const casterFilter = scope?.casterActorUuid ?? null;
  for (const eff of actor.effects) {
    if (eff.name !== targetName) continue;
    if (casterFilter != null) {
      const aeCaster = eff.flags?.["fabula-ultima-companion"]?.directorAppliedBy?.reactorActorUuid ?? null;
      if (aeCaster !== casterFilter) continue;
    }
    return eff;
  }
  return null;
}

// `replace_same_status` matcher (Hinder). An existing enabled AE is "the same
// status" if it shares any of the template's canonical Foundry status ids OR
// has the same literal name. This distinguishes Weak from Slow even though the
// four basic debuffs share one parent world Item — mirrors the bespoke Hinder
// dedup in state-handlers.js.
function findSameStatusAe(actor, template) {
  if (!actor?.effects) return null;
  const canonical = new Set(
    (Array.isArray(template.statuses) ? template.statuses : []).map((s) => String(s).toLowerCase())
  );
  const wantName = String(template.name ?? "").toLowerCase();
  for (const eff of actor.effects) {
    if (eff.disabled) continue;
    const effStatuses = eff.statuses ? Array.from(eff.statuses).map((s) => String(s).toLowerCase()) : [];
    if (effStatuses.some((s) => canonical.has(s))) return eff;
    if (wantName && String(eff.name ?? "").toLowerCase() === wantName) return eff;
  }
  return null;
}

// ── equip_swap (Equipment action) ────────────────────────────────────────
// Commits the per-slot equipment selections the Equipment card collected onto
// the acting actor. Wraps the proven `applyEquipmentSwap` (equipment-swap.js)
// so behavior is byte-identical to the bespoke RESOLVE branch — this is just
// the declarative entry point. Selections are threaded onto ctx.actionResult
// by resolveAction (ar.equipmentSelections). Dynamic import avoids a static
// circular dependency with the action pipeline.
async function applyEquipSwapEffect(row, ctx) {
  const actor = ctx.reactorActor;
  if (!actor) return { ok: false, kind: "equip_swap", reason: "no-actor" };
  const selections = ctx.actionResult?.equipmentSelections ?? null;
  if (!selections) {
    log("skill-effects.equip_swap: no slot selections on action result — no-op");
    return { ok: true, kind: "equip_swap", reason: "no-selections", applied: [] };
  }
  try {
    const { applyEquipmentSwap } = await import("./equipment-swap.js");
    const result = await applyEquipmentSwap(actor, selections);
    if (result?.skipped) {
      log(`skill-effects.equip_swap: no changes for ${actor.name}`);
      return { ok: true, kind: "equip_swap", reason: "no-change", applied: [] };
    }
    log(`skill-effects.equip_swap: committed ${result?.changes?.length ?? 0} change(s) for ${actor.name}`);
    return { ok: true, kind: "equip_swap", applied: result?.changes ?? [] };
  } catch (e) {
    warn("skill-effects.equip_swap threw", e);
    return { ok: false, kind: "equip_swap", reason: "threw" };
  }
}

// ── encyclopedia_record (Study action) ────────────────────────────────────
// Records the Study Open-Check result on the studied creature's Monster
// Encyclopedia page (party-wide best result; lower rolls don't downgrade).
// Wraps the existing `encApi.recordResult`. Per RAW Core p.74 a Fumble yields
// no information — skip the record. Reads the studied target + roll from
// ctx.actionResult. Presentation (token VFX, opening the sheet) stays in the
// Study RESOLVE wrapper — this effect_kind is the data write only.
async function applyEncyclopediaRecordEffect(row, ctx) {
  const ar = ctx.actionResult;
  const encApi = globalThis.FUCompanion?.api?.encyclopedia;
  if (!encApi?.recordResult) {
    warn("skill-effects.encyclopedia_record: encyclopedia.recordResult unavailable");
    return { ok: false, kind: "encyclopedia_record", reason: "no-api" };
  }
  if (ar?.roll?.isFumble) {
    log("skill-effects.encyclopedia_record: fumble — no information gained (RAW)");
    return { ok: true, kind: "encyclopedia_record", reason: "fumble", recordedUuid: null };
  }
  const candidates = [ar?.target?.worldActorUuid, ar?.target?.actorUuid].filter(Boolean);
  for (const uuid of candidates) {
    try {
      const result = await encApi.recordResult({
        actorUuid: uuid,
        total: ar?.roll?.total ?? 0,
        studierActorId: ar?.attacker?.actorId ?? null,
        isCrit: !!ar?.roll?.isCrit,
        isFumble: !!ar?.roll?.isFumble,
      });
      log(`skill-effects.encyclopedia_record: ${ar?.target?.name ?? uuid} — changed=${!!result?.changed}`);
      return { ok: true, kind: "encyclopedia_record", recordedUuid: uuid, changed: !!result?.changed,
               previousBest: result?.previousBest ?? null, newBest: result?.newBest ?? null };
    } catch (e) {
      warn("skill-effects.encyclopedia_record: recordResult threw on", uuid, e);
    }
  }
  return { ok: false, kind: "encyclopedia_record", reason: "no-record" };
}

// ── consume_charge ──────────────────────────────────────────────────────

async function applyConsumeChargeEffect(row, ctx) {
  const chargeKey = String(row.charge_key ?? "").trim();
  if (!chargeKey) {
    warn(`skill-effects.consume_charge: missing charge_key on "${row.effect_label}"`);
    return { ok: false, kind: "consume_charge", reason: "no-charge-key" };
  }
  const onEmpty = String(row.on_empty ?? "abort").trim().toLowerCase();
  const count = Math.max(1, Math.floor(Number(row.count ?? 1) || 1));

  const targetResult = await resolveTargetRef(row.target_ref, ctx);
  if (!targetResult.ok) return { ok: false, kind: "consume_charge", reason: targetResult.reason ?? "no-targets" };
  const tokens = targetResult.tokens;
  if (!tokens.length) return { ok: false, kind: "consume_charge", reason: "no-targets" };

  const applied = [];
  let anyFailed = false;
  for (const token of tokens) {
    const actor = token.actor;
    if (!actor) continue;
    const r = await findAndConsume(actor, chargeKey, { count });
    if (r.ok) applied.push({ actorUuid: actor.uuid, consumed: r.consumed, remaining: r.remaining, deleted: r.deleted });
    else anyFailed = true;
  }

  if (anyFailed && onEmpty === "abort") {
    log(`skill-effects.consume_charge: "${chargeKey}" empty/missing; aborting chain (on_empty=abort)`);
    return { ok: true, kind: "consume_charge", applied, abort: true, reason: "empty" };
  }
  // on_empty=skip: silently no-op the failures; chain continues.
  return { ok: true, kind: "consume_charge", applied };
}

// ── substitute_cost ─────────────────────────────────────────────────────
//
// Generalizes Vismagus-style "spend X instead of Y" cost-substitution.
// Fires from a reaction on `caster_short_on_mp` (or any future trigger
// thread that hands us a cost map). The effect MUTATES
// `ctx.payload.costMap` in-place — the calling cost gate re-reads it
// after the reaction returns.
//
// Row fields:
//   from_resource    "mp" | "hp" | "ip" | "zenit" | ... — the resource
//                    the caster can't afford
//   to_resource      "hp" | "mp" | "ip" | ... — the substitute
//   multiplier       Number — to_amount = from_amount * multiplier.
//                    Default 2 (RAW Vismagus: 2× HP for missing MP).
//   min_remaining    Number — minimum the caster must retain in the
//                    target resource AFTER substitution. Default 1
//                    (Vismagus: "cannot reduce yourself to 0 HP").
//   suppress_self_grant
//                    Optional. When true, also stamps a flag on the
//                    payload so RESOLVE suppresses any grant TO the
//                    substituting resource on the caster (Vismagus
//                    RAW: "if the spell would heal you, you recover
//                    no HP"). Renamed from the legacy `vismagusHpPaid`
//                    AR flag; we set BOTH for back-compat.
async function applySubstituteCostEffect(row, ctx) {
  const fromRes = String(row.from_resource ?? "mp").trim().toLowerCase();
  const toRes   = String(row.to_resource   ?? "hp").trim().toLowerCase();
  const multiplier   = Number(row.multiplier ?? 2) || 2;
  const minRemaining = Number(row.min_remaining ?? 1) || 1;
  const suppressSelf = row.suppress_self_grant === true || fromRes === "mp"; // RAW Vismagus default

  const costMap = ctx.payload?.costMap;
  if (!costMap) {
    warn(`substitute_cost: no costMap on payload for row "${row.effect_label}"`);
    return { ok: false, kind: "substitute_cost", reason: "no-cost-map" };
  }

  // Read the current required amount of `fromRes` from the cost map.
  const readMap = (k) => Number(
    (costMap.get ? costMap.get(k) : costMap[k]) ?? 0
  ) || 0;
  const writeMap = (k, v) => {
    if (costMap.set) costMap.set(k, v);
    else costMap[k] = v;
  };
  const deleteMap = (k) => {
    if (costMap.delete) costMap.delete(k);
    else delete costMap[k];
  };

  const fromAmount = readMap(fromRes);
  if (fromAmount <= 0) {
    return { ok: false, kind: "substitute_cost", reason: "from-not-required" };
  }

  // Affordability check on the TARGET resource: caster must have enough
  // to pay AND still retain `minRemaining` after the substitution.
  const actor = ctx.reactorActor;
  const propKey = ({ hp: "current_hp", mp: "current_mp", ip: "current_ip" })[toRes] ?? `current_${toRes}`;
  const curTo = Number(actor?.system?.props?.[propKey] ?? 0) || 0;
  const newToCost = fromAmount * multiplier;
  if (curTo - newToCost < minRemaining) {
    log(`substitute_cost: ${actor?.name ?? "?"} cur ${toRes}=${curTo}, needs ${newToCost}, min_remaining=${minRemaining} → reject`);
    return {
      ok: false, kind: "substitute_cost", reason: "not-enough-target-resource",
      curTo, needed: newToCost, minRemaining,
    };
  }

  // Rewrite the cost map: remove `fromRes`, add `toRes`.
  deleteMap(fromRes);
  writeMap(toRes, readMap(toRes) + newToCost);
  if (suppressSelf) {
    ctx.payload.suppressSelfGrantOf = toRes;
    // Back-compat: legacy RESOLVE grant handler reads `vismagusHpPaid`.
    if (toRes === "hp") ctx.payload.vismagusHpPaid = true;
  }
  log(`substitute_cost: rewrote ${fromAmount} ${fromRes} → ${newToCost} ${toRes} (caster=${actor?.name ?? "?"})`);
  return {
    ok: true, kind: "substitute_cost",
    fromResource: fromRes, toResource: toRes,
    fromAmount, toAmount: newToCost,
    suppressSelfGrantOf: suppressSelf ? toRes : null,
  };
}

// ── shared helpers for ref-list–style effect_kinds ──────────────────────

// Parse a comma- or newline-separated list of effect_table labels (used
// by `chain.chain_steps` and `open_action_menu.menu_option_refs`).
// Returns the trimmed labels in declaration order, blanks dropped.
function parseEffectRefList(raw) {
  return String(raw ?? "")
    .split(/[,\n]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── open_action_menu ────────────────────────────────────────────────────
//
// Pause the effect chain, show a picker overlay listing the row's
// options, then run the SELECTED option's effect against the same ctx
// and resume. Two equivalent author forms:
//
// 1) Refs form (CSB-friendly): `menu_option_refs` is a comma-separated
//    list of effect_label values; each referenced row uses its own
//    `effect_kind` + params, and provides `menu_label` (+ optional
//    `menu_description`) for the picker display. Mirrors `chain_steps`.
//
//      {
//        effect_label:     "reinforce_pick",
//        effect_kind:      "open_action_menu",
//        menu_title:       "Reinforce: pick one",
//        menu_option_refs: "reinforce_dazed, reinforce_shaken, ..."
//      }
//      // ↑ each ref is a normal effect_table row with `menu_label` set.
//
// 2) Inline form (JSON-spec friendly): `menu_options` is an array of
//    self-contained option objects, each with its own `effect_kind` +
//    params + `label`/`description`. No separate rows needed.
//
//      {
//        effect_label:  "reinforce_pick",
//        effect_kind:   "open_action_menu",
//        menu_title:    "...",
//        menu_options: [
//          { label: "Dazed", effect_kind: "apply_ae", ... },
//          ...
//        ]
//      }
//
// Both forms produce identical runtime behavior. When both are present
// on the same row, refs win (CSB sheet's view of the data is the
// authoritative one).
//
// On cancel (Escape / Cancel button) the chain aborts with abort:true
// so callers can decide whether to short-circuit downstream effects.
// The host action card stays up; only the chain stops.
//
// Passive paths (`ctx.isPassive === true`) auto-pick the first option
// — passives must never prompt mid-resolution.

// Build the menu's option list (refs preferred, inline fallback). Returns
// { options: [{label, description}], optionRows: [sourceRow] } — parallel
// arrays. Shared by the live dispatch (applyOpenActionMenuEffect) and the
// apply-click preview (previewReactionMenu) so both see the identical menu.
//
// Option display TEXT lives on the menu row (the open_action_menu row), NOT on
// the option rows: `menu_option_labels` + `menu_option_descriptions` are
// `|`-separated lists positionally paired with the comma-separated
// `menu_option_refs`. The option rows then carry only their mechanical data.
// Back-compat: if the menu row doesn't supply a label/description for an option,
// fall back to that option row's legacy `menu_label` / `menu_description`
// (so skills authored under the old per-option shape still render correctly).
function buildMenuOptions(row, ctx) {
  const refs = parseEffectRefList(row.menu_option_refs);
  const splitPipe = (s) =>
    (s == null || String(s).trim() === "") ? [] : String(s).split("|").map((x) => x.trim());
  const rowLabels = splitPipe(row.menu_option_labels);
  const rowDescs  = splitPipe(row.menu_option_descriptions);
  const rowIcons  = splitPipe(row.menu_option_icons);
  const rowColors = splitPipe(row.menu_option_colors);
  // An option whose row carries a non-empty `condition_formula` evaluating falsy
  // is DROPPED from the menu entirely (hidden, not disabled) — the clean shape
  // for "you don't own this option". Mirrors the dispatch-time row gate, so the
  // menu only ever offers options that would actually fire. Used by the Tinkerer
  // Gadgets menu to show only tier-unlocked infusions (GADGET_INFUSION_TIER >= N).
  // Options with no condition_formula are unaffected (every existing menu).
  let _menuResolver = null;
  const optionGatePasses = (optRow) => {
    const cond = String(optRow?.condition_formula ?? "").trim();
    if (!cond) return true;
    try {
      if (!_menuResolver) {
        _menuResolver = buildSkillResolver({
          actor: ctx.reactorActor, payload: ctx.payload, skill: ctx.skill, round: ctx.dCombat?.round ?? 0,
        });
      }
      return !!evaluateFormula(cond, _menuResolver, 0);
    } catch (e) {
      // Fail-open: a broken gate shouldn't silently hide a legit option.
      warn(`skill-effects.open_action_menu: option condition_formula="${cond}" threw — showing anyway`, e);
      return true;
    }
  };
  let options = [];
  let optionRows = [];
  if (refs.length) {
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const refRow = findEffectRow(ctx, ref);
      if (!refRow) {
        warn(`skill-effects.open_action_menu: ref "${ref}" → no matching effect_table row; skipping`);
        continue;
      }
      if (!optionGatePasses(refRow)) continue;
      // Menu-row text wins; fall back to the option row's legacy fields, then
      // to the ref label. (Empty entries in the |-list also fall through.)
      const label = (rowLabels[i] && rowLabels[i] !== "")
        ? rowLabels[i]
        : String(refRow.menu_label ?? refRow.effect_label ?? ref);
      const desc = (rowDescs[i] && rowDescs[i] !== "")
        ? rowDescs[i]
        : (refRow.menu_description ?? null);
      // Optional per-option presentation (icon image + accent color). Menu-row
      // pipe-list wins; fall back to the option row's own field. Absent → null,
      // and the picker renders a plain row (back-compat for every existing menu).
      const icon = (rowIcons[i] && rowIcons[i] !== "")
        ? rowIcons[i]
        : (refRow.menu_icon ?? null);
      const color = (rowColors[i] && rowColors[i] !== "")
        ? rowColors[i]
        : (refRow.menu_color ?? null);
      options.push({ label, description: desc ? String(desc) : null, icon: icon || null, color: color || null });
      optionRows.push(refRow);
    }
  }
  if (!options.length) {
    // Inline form. `menu_options` may be an array or numeric-keyed object.
    const optsRaw = row.menu_options;
    const inline = Array.isArray(optsRaw)
      ? optsRaw
      : (optsRaw && typeof optsRaw === "object" ? Object.values(optsRaw) : []);
    const valid = inline.filter((o) => o && typeof o === "object" && o.label && optionGatePasses(o));
    options = valid.map((o) => ({
      label: String(o.label),
      description: o.description ? String(o.description) : null,
      icon: o.menu_icon ?? o.icon ?? null,
      color: o.menu_color ?? o.color ?? null,
    }));
    optionRows = valid;
  }
  return { options, optionRows };
}

// Select which option indices to dispatch from an option-menu row. Returns
// { chosenIndices: number[], cancelled: bool }. pickCount is `menu_pick_count`
// (default 1, formula-aware — Perfect Aim → 2 via "1 + HAS_SKILL_PERFECT_AIM").
// Sources, in precedence: a pre-chosen queue (`ctx.harnessPicks` for tests, or
// `ctx.menuPicks` = picks the player already made at Apply-click, replayed at
// RESOLVE); else passive auto-pick (only when `skip_when_passive: true`); else
// an interactive prompt per pick over the remaining options. Cancelling the
// FIRST interactive pick → {cancelled:true}; a later cancel keeps prior picks.
// Shared by the live dispatch + the apply-click preview so both pick identically.
// Escape author text for the list-picker (it renders primary/secondary as HTML).
function escapeMenuHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

// Map menu options ({label, description, icon?, color?}) to list-picker rows.
// `value` is the LOCAL index — the caller maps it back into its own list.
function menuOptionsToRows(opts) {
  return opts.map((o, i) => ({
    value: i,
    primary: escapeMenuHtml(o.label),
    secondary: o.description ? escapeMenuHtml(o.description) : null,
    imageUrl: o.icon ?? null,
    color: o.color ?? null,
  }));
}

async function selectMenuPicks(row, ctx, options) {
  // Replay captured picks — the pre_activate window recorded these BEFORE the
  // card was built; RESOLVE replays them so the menu applies without re-
  // prompting (keyed by the menu row's effect_label). Mirrors the reaction
  // apply-click → RESOLVE replay, but for the caster's own skill.
  const captured = ctx?.capturedMenuPicksByLabel?.[row.effect_label];
  if (Array.isArray(captured) && captured.length) {
    const idxs = [];
    for (const label of captured) {
      const want = String(label).trim().toLowerCase();
      const i = options.findIndex((o) => String(o.label).trim().toLowerCase() === want);
      if (i >= 0 && !idxs.includes(i)) idxs.push(i);
    }
    if (idxs.length) {
      log(`skill-effects.selectMenuPicks: replaying captured picks for "${row.effect_label}" → ${idxs.map((i) => options[i].label).join(", ")}`);
      return { chosenIndices: idxs, cancelled: false };
    }
  }
  let pickCount = 1;
  const pcRaw = row.menu_pick_count;
  if (pcRaw !== undefined && pcRaw !== null && String(pcRaw).trim() !== "") {
    const resolver = buildSkillResolver({
      actor: ctx.reactorActor, payload: ctx.payload, skill: ctx.skill, round: ctx.dCombat?.round ?? 0,
    });
    const n = Number(evaluateFormula(String(pcRaw), resolver, 1));
    if (Number.isFinite(n) && n >= 1) pickCount = Math.floor(n);
  }
  pickCount = Math.max(1, Math.min(pickCount, options.length));

  const chosenIndices = [];
  const remainingIdx = options.map((_, i) => i);
  const takeIndex = (idx) => {
    chosenIndices.push(idx);
    const pos = remainingIdx.indexOf(idx);
    if (pos !== -1) remainingIdx.splice(pos, 1);
  };

  for (let pick = 0; pick < pickCount; pick++) {
    const queue = Array.isArray(ctx?.harnessPicks) ? ctx.harnessPicks
      : (Array.isArray(ctx?.menuPicks) ? ctx.menuPicks : null);
    let idx = -1;
    if (queue && queue.length > (ctx._harnessPicksCursor ?? 0)) {
      const cursor = ctx._harnessPicksCursor ?? 0;
      ctx._harnessPicksCursor = cursor + 1;
      const next = queue[cursor];
      if (typeof next === "number" && Number.isFinite(next)) idx = next;
      else if (typeof next === "string") {
        const want = next.trim().toLowerCase();
        idx = options.findIndex((o) => String(o.label).trim().toLowerCase() === want);
      } else if (next && typeof next === "object") {
        if (Number.isFinite(next.index)) idx = next.index;
        else if (next.menuLabel) {
          const want = String(next.menuLabel).trim().toLowerCase();
          idx = options.findIndex((o) => String(o.label).trim().toLowerCase() === want);
        }
      }
      if (idx < 0 || idx >= options.length || !remainingIdx.includes(idx)) {
        warn(`skill-effects.open_action_menu: pre-chosen pick ${JSON.stringify(next)} did not match a remaining option — falling back to first remaining`);
        idx = remainingIdx[0];
      }
      log(`skill-effects.open_action_menu: pre-chosen pick → "${options[idx].label}"`);
    } else if (ctx.isPassive && row.skip_when_passive === true) {
      // Option-menus PROMPT by default even in a passive ctx (firePreAcceptedCandidate
      // runs Applied "ask" chains with isPassive:true). Only auto-pick when the row
      // explicitly opts in with skip_when_passive:true. Mirrors targeting's knob.
      idx = remainingIdx[0];
      log(`skill-effects.open_action_menu: passive + skip_when_passive — auto-picking "${options[idx].label}"`);
    } else {
      const baseSubtitle = row.menu_subtitle ? String(row.menu_subtitle) : null;
      const subtitle = pickCount > 1
        ? `${baseSubtitle ? baseSubtitle + " — " : ""}choose ${pickCount} (${pick + 1}/${pickCount})`
        : baseSubtitle;
      const remOptions = remainingIdx.map((i) => options[i]);
      const pickedLocal = await pickFromList({
        title: String(row.menu_title ?? "Choose an option"),
        subtitle,
        options: menuOptionsToRows(remOptions),
        zIndex: 97,  // above the action card (95) during RESOLVE
      });
      if (pickedLocal == null) {
        if (pick === 0) return { chosenIndices: [], cancelled: true };
        // Capture mode (pre_activate wizard): a multi-pick menu steps BACK one
        // sub-pick on cancel — undo the previous selection and re-prompt it
        // (e.g. cancel debuff 2/2 → re-pick debuff 1/2). Cancelling at 1/2 falls
        // to the pick===0 branch above → cancelled → the wizard steps back to the
        // previous choice. Non-capture menus keep "stop early, keep partials".
        if (ctx?.captureMode) {
          const last = chosenIndices.pop();
          if (last != null && !remainingIdx.includes(last)) {
            remainingIdx.push(last);
            remainingIdx.sort((a, b) => a - b);
          }
          pick -= 2; // for-loop's pick++ lands us back on the previous sub-pick
          continue;
        }
        log(`skill-effects.open_action_menu: player stopped after ${pick} pick(s)`);
        break;
      }
      idx = remainingIdx[pickedLocal];
    }
    takeIndex(idx);
  }
  return { chosenIndices, cancelled: false };
}

// Describe an option's gameplay RIDER effects for the action card's Effect
// panel — human-readable, no commit. Returns an ARRAY (a chain option has
// several riders). The panel shows only effects OUTSIDE of damage: applied
// statuses and special keywords (Drain → self-heal). Cost (consume_resource)
// and damage (adjust_damage / change_damage_element / the chosen element)
// are intentionally OMITTED — cost is implied by the pick and element/+N
// render in the Damage panel. A chain option (Tinkerer infusions:
// inf_venom → inf_pay,inf_el_poison,inf_plus5,inf_poison) is WALKED so the
// panel reads "Poisoned" / "Heal 50%", not the bare option label. An option
// with no riders (a pure element infusion: Pyro = element + 5 only) returns
// [] → no Effect panel for it (its element shows in the Damage panel).
function describeMenuOptionEffect(optionRow, ctx) {
  const out = [];
  const seen = new Set();
  const walk = (row) => {
    if (!row) return;
    const kind = String(row.effect_kind ?? "").trim().toLowerCase();
    if (kind === "apply_ae") {
      out.push({ kind: "apply_ae", statusName: String(row.ae_template_ref ?? row.menu_label ?? "Effect") });
    } else if (kind === "apply_action_keyword") {
      const kw = String(row.action_keyword ?? "").trim().toLowerCase();
      if (kw === "drain") out.push({ kind: "keyword", keyword: "drain", label: "Heal 50% of damage" });
      else if (kw) out.push({ kind: "keyword", keyword: kw, label: kw.charAt(0).toUpperCase() + kw.slice(1) });
    } else if (kind === "chain") {
      const steps = String(row.chain_steps ?? "").split(/[,\n]+/g).map((s) => s.trim()).filter(Boolean);
      for (const s of steps) {
        if (seen.has(s)) continue;
        seen.add(s);
        walk(findEffectRow(ctx, s));
      }
    }
    // consume_resource (cost) + adjust_damage / change_damage_element (damage)
    // are deliberately not surfaced here (riders-only Effect panel).
  };
  walk(optionRow);
  return out;
}

// Apply-click PREVIEW of a reaction's option-menu(s). Walks the candidate's
// chain, prompts every open_action_menu (skipping free_mode), and returns the
// chosen pick LABELS (to cache on the candidate + replay at RESOLVE via
// ctx.menuPicks) plus human-readable effect descriptors (for the card's Effect
// panel). COMMITS NOTHING — the AEs / costs apply later at RESOLVE. Returns
// { ok, cancelled, hasMenu, picks: string[], effects: [...] }.
export async function previewReactionMenu({ casterActor, candidate, payload, dCombat, picks = null, isPassive = false } = {}) {
  if (!candidate?.ref || !casterActor) return { ok: true, cancelled: false, hasMenu: false, picks: [], effects: [] };

  // Resolve the carrier's effect_table (mirror firePreAcceptedCandidate).
  let runtimeEffectTable;
  let skillForCtx = null;
  const carrier = await fromUuid(candidate.carrierUuid).catch(() => null);
  if (!carrier) return { ok: false, reason: "carrier-gone", cancelled: false, hasMenu: false, picks: [], effects: [] };
  if (candidate.carrierKind === "item") {
    const { getRuntimeSkillView } = await import("./skill-recipes.js");
    runtimeEffectTable = getRuntimeSkillView(carrier).effect_table;
    skillForCtx = carrier;
  } else {
    const cfg = carrier.flags?.[FLAG_NS]?.reactionConfig ?? {};
    runtimeEffectTable = cfg.effect_table ?? cfg.reaction_effect_table ?? {};
  }

  const { makeChainContext } = await import("./skill-targeting.js");
  const reactorToken = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === casterActor.uuid)?.document
    ?? casterActor?.getActiveTokens?.()?.[0]?.document ?? null;
  const ctx = makeChainContext({
    reactorActor: casterActor,
    reactorToken,
    skill: skillForCtx,
    dCombat: dCombat ?? null,
    payload,
    actionTargetUuids: payload?.targetTokenUuids ?? payload?.targets ?? [],
    hitActionTargetUuids: payload?.hitTargetTokenUuids ?? payload?.hitTargets ?? payload?.targetTokenUuids ?? payload?.targets ?? [],
    runtimeEffectTable,
    // ask (apply-click) → isPassive false = always PROMPT. on/force (spawn
    // auto-apply) → isPassive true, so selectMenuPicks honors skip_when_passive
    // (auto-pick the first option) but still PROMPTS when it's not set — an
    // auto-applied reaction with a real choice must still let the player choose.
    isPassive: !!isPassive,
    // Optional pre-supplied picks (tests / auto-callers) → selectMenuPicks
    // consumes them instead of prompting. Omitted in real apply-click use.
    menuPicks: Array.isArray(picks) ? picks : null,
  });

  // Collect open_action_menu rows reachable from candidate.ref (chain-aware,
  // skipping free_mode rows which run a separate flow). Read-only walk.
  const byLabel = new Map();
  for (const r of Object.values(runtimeEffectTable ?? {})) {
    if (!r || r.$deleted) continue;
    const lbl = String(r.effect_label ?? "").trim();
    if (lbl) byLabel.set(lbl, r);
  }
  const menuRows = [];
  let damageNullified = false;   // chain zeroes outgoing damage (Warning Shot)
  const seen = new Set();
  (function walk(label) {
    if (!label || seen.has(label)) return;
    seen.add(label);
    const r = byLabel.get(label);
    if (!r) return;
    const kind = String(r.effect_kind ?? "").trim().toLowerCase();
    if (kind === "chain") {
      for (const s of String(r.chain_steps ?? "").split(/[,\n]+/g).map((x) => x.trim()).filter(Boolean)) walk(s);
    } else if (kind === "open_action_menu" && r.free_mode !== true) {
      menuRows.push(r);
    } else if (kind === "adjust_damage") {
      const op = String(r.damage_operation ?? "").trim().toLowerCase();
      const stage = String(r.damage_stage ?? "outgoing").trim().toLowerCase();
      const amt = Number(r.damage_amount);
      if (stage === "outgoing" && ((op === "multiply" && amt === 0) || (op === "set" && amt === 0))) {
        damageNullified = true;
      }
    }
  })(candidate.ref);

  // No menu to resolve — still report damageNullified so the card can strike
  // the damage panel for a no-menu "deal no damage" reaction.
  if (!menuRows.length) return { ok: true, cancelled: false, hasMenu: false, picks: [], effects: [], damageNullified };

  const chosenLabels = [];
  const effects = [];
  for (const menuRow of menuRows) {
    const { options, optionRows } = buildMenuOptions(menuRow, ctx);
    if (!options.length) continue;
    const { chosenIndices, cancelled } = await selectMenuPicks(menuRow, ctx, options);
    if (cancelled) return { ok: true, cancelled: true, hasMenu: true, picks: [], effects: [], damageNullified };
    for (const idx of chosenIndices) {
      chosenLabels.push(options[idx].label);
      // describeMenuOptionEffect now returns an ARRAY of rider descriptors
      // (walks chain options) — spread them into the panel's effect list.
      effects.push(...describeMenuOptionEffect(optionRows[idx], ctx));
    }
  }
  return { ok: true, cancelled: false, hasMenu: true, picks: chosenLabels, effects, damageNullified };
}

async function applyOpenActionMenuEffect(row, ctx) {
  // Free-action mode (legacy reaction-grant.js parity). When `free_mode`
  // is true, the row does NOT show an inline picker; instead it
  // registers a free-action grant on the reactor and spawns a mini-turn
  // via composeAction restricted to `allowed_types`. Used by High Speed,
  // Acceleration, Painful Lesson, Stolen Time, etc.
  if (row.free_mode === true) {
    const { freeActionQueue } = await import("./free-action-queue.js");
    const reactor = ctx.reactorActor;
    if (!reactor) {
      warn(`skill-effects.open_action_menu free_mode: no reactorActor on ctx`);
      return { ok: false, kind: "open_action_menu", reason: "no-reactor" };
    }
    const allowedRaw = String(row.allowed_types ?? "").trim();
    const enabledLabels = allowedRaw
      ? allowedRaw.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
      : [];
    const resolver = buildSkillResolver({
      actor: reactor, payload: ctx.payload, skill: ctx.skill, round: ctx.dCombat?.round ?? 0,
    });
    const checkBonus  = evaluateFormula(row.check_bonus_formula  ?? "", resolver, 0) || 0;
    const damageBonus = evaluateFormula(row.damage_bonus_formula ?? "", resolver, 0) || 0;
    // free_hr_as_zero: the granted free attack treats High Roll as 0 for damage
    // (Hawkeye option b, Soaring Strike-style). Declarative — any free_mode row
    // can set it; threaded to the grant → consumed at Attack COMPUTE.
    const hrAsZero = row.free_hr_as_zero === true || String(row.free_hr_as_zero ?? "").toLowerCase() === "true";
    const sourceLabel = ctx.skill?.name ?? row.effect_label ?? "Free Action";
    freeActionQueue.enqueue({
      reactorActorId:   reactor.id,
      reactorActorUuid: reactor.uuid,
      reactorTokenUuid: ctx.reactorToken?.uuid ?? null,
      enabledLabels, checkBonus, damageBonus, hrAsZero,
      sourceLabel,
      sourceItemUuid: ctx.skill?.uuid ?? null,
      maxMpCost:             null,    // future: row.max_mp_cost
      lockedTargetTokenUuid: null,    // future: Painful Lesson
    });
    log(`open_action_menu free_mode: enqueued "${sourceLabel}" request for ${reactor.name} (enabled: ${enabledLabels.join(", ") || "any"}, +${checkBonus} check / +${damageBonus} dmg)`);
    // The queue persists in-memory until drained. FREE_ACTION_WINDOW
    // pops one request at a time, swaps in the reactor's turn snapshot,
    // sets the `freeActions` singleton from the request, and routes to
    // DECLARE so the player composes + commits the free action with
    // bonuses applied. See [[free-actions]].
    return { ok: true, kind: "open_action_menu", freeMode: true, queued: true, applied: [{ actor: reactor.uuid, sourceLabel, enabledLabels, checkBonus, damageBonus }] };
  }

  // Resolve options (refs preferred, inline fallback) via the shared helper —
  // so the apply-click preview (previewReactionMenu) builds the identical list.
  const { options, optionRows } = buildMenuOptions(row, ctx);
  if (!options.length) {
    warn(`skill-effects.open_action_menu: row "${row.effect_label}" has no usable options`);
    return { ok: false, kind: "open_action_menu", reason: "no-options" };
  }

  // Select the option indices (pickCount-driven; harness / cached / passive /
  // interactive). Shared with the apply-click preview (previewReactionMenu).
  const { chosenIndices, cancelled } = await selectMenuPicks(row, ctx, options);
  if (cancelled) {
    log(`skill-effects.open_action_menu: row "${row.effect_label}" cancelled by user`);
    return { ok: true, kind: "open_action_menu", applied: [], reason: "cancelled", abort: true };
  }

  // Capture mode (pre_activate window): record the chosen option LABELS onto the
  // payload and return WITHOUT dispatching — the options apply for real at
  // RESOLVE, where selectMenuPicks replays these via capturedMenuPicksByLabel.
  if (ctx?.captureMode) {
    if (!ctx.payload) ctx.payload = {};
    if (!ctx.payload._capturedMenuPicks) ctx.payload._capturedMenuPicks = {};
    const labels = chosenIndices.map((i) => options[i].label);
    ctx.payload._capturedMenuPicks[row.effect_label] = labels;
    log(`skill-effects.open_action_menu: capture mode — recorded "${row.effect_label}" → ${labels.join(", ")} (not dispatched)`);
    return { ok: true, kind: "open_action_menu", captured: true, selectedLabels: labels };
  }

  // Dispatch each chosen option in pick order. Refs path: the referenced row
  // IS the dispatch row. Inline path: the inline option object IS the row.
  const nestedResults = [];
  let anyAbort = false;
  for (const idx of chosenIndices) {
    const selectedRow = optionRows[idx];
    if (!selectedRow?.effect_kind) {
      warn(`skill-effects.open_action_menu: option "${options[idx].label}" missing effect_kind`);
      continue;
    }
    // Stamp a traceable label without mutating the source row.
    const syntheticRow = {
      ...selectedRow,
      effect_label: `${row.effect_label ?? "menu"}:${options[idx].label}`,
    };
    log(`skill-effects.open_action_menu: row "${row.effect_label}" → option "${options[idx].label}" (${syntheticRow.effect_kind})`);
    const sub = await applyEffectRow(syntheticRow, ctx);
    nestedResults.push(sub);
    if (sub.abort) { anyAbort = true; break; }
  }

  return {
    ok: nestedResults.length > 0 && nestedResults.every((s) => s.ok),
    kind: "open_action_menu",
    // Plural results for multi-pick; singular aliases kept for back-compat.
    selectedIndices: chosenIndices,
    selectedLabels: chosenIndices.map((i) => options[i].label),
    nestedResults,
    selectedIndex: chosenIndices[0] ?? -1,
    selectedLabel: chosenIndices.length ? options[chosenIndices[0]].label : null,
    nestedResult: nestedResults[0] ?? null,
    abort: anyAbort,
  };
}

// ── free_action ──────────────────────────────────────────────────────────
//
// Perform ONE free turn-action — no option menu (contrast open_action_menu,
// which is the Hinder/Hawkeye-style CHOICE picker). Reuses the SAME free-action
// queue + FREE_ACTION_WINDOW + bonus machinery as open_action_menu's free_mode,
// so it inherits snapshot-swap, check/damage bonuses, HR-as-0, and "free action
// doesn't consume the turn". The one addition is a `preset` on the request: when
// `action_ref` names a SPECIFIC action (a skill name, or "self" = the carrier
// skill), DECLARE skips composeAction and stages that exact action directly,
// then flows normally through TARGET → COMPUTE → RESOLVE (so targeting + Confirm
// happen by role — GM picks/auto, owner gets the picker).
//
// `action_ref` forms:
//   - "self"                       → re-perform the carrier skill (Blazing Sweep
//                                     repeats itself).
//   - a skill/item NAME on the actor → perform that exact skill (preset).
//   - an action TYPE or comma-list  → no preset; behaves like free_mode (compose
//     ("Attack" / "Attack,Hinder")    filtered by type). Lets the player choose
//                                     the specific action within those types.
// Bonus fields mirror free_mode: check_bonus_formula / damage_bonus_formula /
// free_hr_as_zero / max_mp_cost. `target_ref` (optional) locks the action's
// targets (e.g. Counterattack → the triggering attacker); empty → picked at TARGET.
const FREE_ACTION_TYPES = new Set([
  "attack", "skill", "spell", "guard", "hinder", "study", "equipment", "item", "objective",
]);

async function applyFreeActionEffect(row, ctx) {
  const { freeActionQueue } = await import("./free-action-queue.js");
  const reactor = ctx.reactorActor;
  if (!reactor) {
    warn(`skill-effects.free_action: no reactorActor on ctx`);
    return { ok: false, kind: "free_action", reason: "no-reactor" };
  }

  const resolver = buildSkillResolver({
    actor: reactor, payload: ctx.payload, skill: ctx.skill, round: ctx.dCombat?.round ?? 0,
  });
  const checkBonus  = evaluateFormula(row.check_bonus_formula  ?? "", resolver, 0) || 0;
  const damageBonus = evaluateFormula(row.damage_bonus_formula ?? "", resolver, 0) || 0;
  const hrAsZero = row.free_hr_as_zero === true || String(row.free_hr_as_zero ?? "").toLowerCase() === "true";
  const mpRaw = String(row.max_mp_cost ?? "").trim();
  const maxMpCost = mpRaw === "" ? null : (Number.isFinite(Number(mpRaw)) ? Number(mpRaw) : null);

  // Optional locked targets.
  let presetTargetTokenUuids = null;
  if (String(row.target_ref ?? "").trim()) {
    try {
      const tr = await resolveTargetRef(row.target_ref, ctx);
      if (tr.ok && tr.tokens?.length) {
        presetTargetTokenUuids = tr.tokens.map((t) => t.uuid ?? t.document?.uuid).filter(Boolean);
      }
    } catch (e) { warn(`skill-effects.free_action: target_ref "${row.target_ref}" resolve threw`, e); }
  }

  // Resolve action_ref → a specific item (preset) OR a type filter.
  const ref = String(row.action_ref ?? "").trim();
  let presetItem = null;
  let enabledLabels = [];
  if (ref.toLowerCase() === "self") {
    presetItem = ctx.skill ?? null;
  } else if (ref) {
    const parts = ref.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const allTypes = parts.length > 0 && parts.every((p) => FREE_ACTION_TYPES.has(p.toLowerCase()));
    if (allTypes) {
      // Type-filter path — identical to open_action_menu free_mode.
      enabledLabels = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
    } else {
      // Skill-name path — find the named item on the reactor.
      const wanted = parts[0].toLowerCase();
      presetItem = (reactor.items?.find?.((i) => String(i.name ?? "").trim().toLowerCase() === wanted)) ?? null;
      if (!presetItem) warn(`skill-effects.free_action: action_ref "${parts[0]}" — no matching item on ${reactor.name}`);
    }
  }

  // Build the preset bundle for a specific action (skill name / self).
  let preset = null;
  if (presetItem) {
    let kind = "Skill";
    try {
      const { getRuntimeActionView } = await import("./skill-recipes.js");
      kind = getRuntimeActionView(presetItem).kind || "Skill";
    } catch (e) { warn(`skill-effects.free_action: getRuntimeActionView threw for ${presetItem.name}`, e); }
    const targetUuids = presetTargetTokenUuids ?? undefined;
    if (kind === "Attack") {
      preset = { command: "Attack", attackMode: "npc", npcAttackItemUuid: presetItem.uuid, targetUuids };
    } else if (kind === "Spell") {
      preset = { command: "Spell", skillUuid: presetItem.uuid, sourceItemUuid: presetItem.uuid, targetUuids };
    } else if (kind === "Skill") {
      preset = { command: "Skill", skillUuid: presetItem.uuid, sourceItemUuid: presetItem.uuid, targetUuids };
    } else {
      preset = { command: kind, skillUuid: presetItem.uuid, targetUuids };
    }
    // Keep the grant's type filter consistent with the preset command.
    enabledLabels = [preset.command];
  }

  const sourceLabel = ctx.skill?.name ?? row.effect_label ?? "Free Action";
  freeActionQueue.enqueue({
    reactorActorId:   reactor.id,
    reactorActorUuid: reactor.uuid,
    reactorTokenUuid: ctx.reactorToken?.uuid ?? null,
    enabledLabels, checkBonus, damageBonus, hrAsZero,
    sourceLabel,
    sourceItemUuid: ctx.skill?.uuid ?? null,
    maxMpCost,
    lockedTargetTokenUuid: null,
    preset,                                    // null = compose; set = staged directly in DECLARE
    // chain: this free action is a CHAIN strike, not a "free attack" — it
    // BYPASSES preventFreeAttack (a "no Free Attacks" debuff must not stop a
    // Chain N attack). freeActions.get/set honor this flag. Default false.
    chain: row.chain === true || String(row.chain ?? "").trim().toLowerCase() === "true",
  });
  log(`free_action: enqueued "${sourceLabel}" for ${reactor.name} — ${preset ? `preset ${preset.command} (${presetItem?.name})` : `compose [${enabledLabels.join(", ") || "any"}]`} (+${checkBonus} check / +${damageBonus} dmg)`);
  return { ok: true, kind: "free_action", queued: true, freeMode: true, applied: [{ actor: reactor.uuid, sourceLabel, enabledLabels, checkBonus, damageBonus, preset: preset ? preset.command : null }] };
}

// ── remove_tagged_ae ────────────────────────────────────────────────────
//
// Per-target dynamic picker that removes Active Effects matching a
// `system.tags` filter (e.g. "debuff", "buff"). The list of options is
// computed at runtime from each target's current AE set, so authors
// don't enumerate status templates statically — anything tagged correctly
// becomes a valid removal target.
//
// Author shape:
//
//   {
//     effect_label:  "cleanse_pick",
//     effect_kind:   "remove_tagged_ae",
//     target_ref:    "action_targets",
//     filter_tag:    "debuff",          // looks in ae.system.tags
//     count:         1,                  // 1 (picker), N (loop), or "all"
//     menu_title:    "Cleanse: choose a debuff to remove",
//     menu_subtitle: "Removes 1 debuff from each target"
//   }
//
// Per-target loop: each target gets its own picker prompt. If a target
// has zero matching AEs, that target is skipped (no prompt). If count
// is "all" or exceeds the matching count, every match is removed without
// prompting. Passive ctx auto-picks the first match per target.
//
// Cancel on a target's picker skips that target only — other targets in
// the same effect still get prompted (does NOT abort the whole chain).

async function applyRemoveTaggedAeEffect(row, ctx) {
  const filterTag = String(row.filter_tag ?? "").trim().toLowerCase();
  if (!filterTag) {
    warn(`skill-effects.remove_tagged_ae: missing filter_tag on "${row.effect_label}"`);
    return { ok: false, kind: "remove_tagged_ae", reason: "no-filter-tag" };
  }
  // count semantics: ABSENT/empty OR "all" → remove ALL matches. A number N →
  // remove N: auto-remove when N ≥ matches (nothing to choose), else show the
  // list-picker so the player chooses which N (passive ctx auto-picks). Default
  // is ALL (a bare "remove these tagged AEs" clears the whole category — Cleanse
  // = filter_tag "cleansable", Dispel = "dispellable"); set count to gate it.
  const rawCount = row.count;
  const rawCountStr = String(rawCount ?? "").trim().toLowerCase();
  const removeAll = rawCountStr === "" || rawCountStr === "all";
  const count = removeAll ? Infinity : Math.max(1, Number(rawCount) || 1);

  const targetResult = await resolveTargetRef(row.target_ref, ctx);
  if (!targetResult.ok) return { ok: false, kind: "remove_tagged_ae", reason: targetResult.reason ?? "no-targets" };
  const tokens = targetResult.tokens;
  if (!tokens.length) return { ok: false, kind: "remove_tagged_ae", reason: "no-targets" };

  const removed = [];
  for (const token of tokens) {
    const actor = token.actor;
    if (!actor) continue;

    // Match on system.tags OR the charge-AE identity flag (chargeKey). A
    // charge-based status's REAL identity is its chargeKey (e.g. "burn"), and
    // templates aren't tagged consistently (some Burn templates carry only
    // ["debuff"], or no tags) — so a tag-only match would silently skip Burn
    // applied from those sources. chargeKey is the same identity the cost
    // walker (findChargeAEsOnActor) keys on, so this keeps the two aligned.
    const matches = Array.from(actor.effects ?? []).filter((eff) => {
      const tags = eff?.system?.tags;
      if (Array.isArray(tags) && tags.includes(filterTag)) return true;
      const chargeKey = String(eff?.flags?.[FLAG_NS]?.chargeKey ?? "").trim().toLowerCase();
      return !!chargeKey && chargeKey === filterTag;
    });

    if (!matches.length) {
      log(`skill-effects.remove_tagged_ae: ${actor.name} has no "${filterTag}" AE; skipping target`);
      continue;
    }

    // Bulk-remove path: count="all" or count exceeds matches.
    if (count >= matches.length) {
      try {
        const ids = matches.map((e) => e.id).filter(Boolean);
        await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
        for (const m of matches) removed.push({ actorUuid: actor.uuid, aeName: m.name });
        log(`skill-effects.remove_tagged_ae: removed ${matches.length} ${filterTag} from ${actor.name}`);
      } catch (e) {
        warn(`skill-effects.remove_tagged_ae: bulk remove failed on ${actor.name}`, e);
      }
      continue;
    }

    // Picker loop — `count` removals from this target. Each pass narrows
    // the candidate list. Passive ctx auto-picks the first remaining match.
    let remainingMatches = matches.slice();
    for (let i = 0; i < count && remainingMatches.length; i += 1) {
      let chosenIdx = null;
      if (ctx.isPassive) {
        chosenIdx = 0;
      } else {
        const options = remainingMatches.map((eff) => ({
          label: String(eff.name ?? "(unnamed)"),
          description: eff.description ? String(eff.description) : null,
        }));
        const title = String(row.menu_title ?? `Choose a ${filterTag} to remove`);
        const subtitle = `${actor.name}${row.menu_subtitle ? ` · ${row.menu_subtitle}` : ""}`;
        chosenIdx = await pickFromList({ title, subtitle, options: menuOptionsToRows(options) });
      }
      if (chosenIdx == null) {
        log(`skill-effects.remove_tagged_ae: ${actor.name} picker cancelled; skipping rest of this target`);
        break;
      }
      const picked = remainingMatches[chosenIdx];
      try {
        await picked.delete();
        removed.push({ actorUuid: actor.uuid, aeName: picked.name });
        log(`skill-effects.remove_tagged_ae: removed "${picked.name}" from ${actor.name}`);
      } catch (e) {
        warn(`skill-effects.remove_tagged_ae: delete failed on ${actor.name} / ${picked.name}`, e);
      }
      remainingMatches = remainingMatches.filter((e) => e !== picked);
    }
  }

  return { ok: true, kind: "remove_tagged_ae", applied: removed };
}

// ── roll_loot_table ────────────────────────────────────────────────────
//
// Rolls a percentile loot table per target and transfers won items to
// the caster's inventory. Backbone for Soul Steal's item-steal branch.
//
// Per-target data on the target actor's `system.props`:
//   stealable_loot          — map keyed by embedded-item id; each entry:
//                             { name, id, uuid, loot_description, roll? }
//   steal_percentage_table  — map of dynamicTable rows:
//                             { loot_id (name string), loot_percentage (0-100), $deleted? }
//                             Includes an "(Empty)" loot_id meaning "no
//                             steal this attempt"; rows roll independently.
//
// State tracking (rewind-safe): one hidden AE per (target, caster) pair
// named "Soul Stolen by <CasterName>" carrying:
//   flags.fabula-ultima-companion.soulStolenBy   — caster actorUuid
//   flags.fabula-ultima-companion.stolenLootKeys — array of lootKeys won
//   flags.fabula-ultima-companion.directorPermanent: true   (no tick)
//   transfer: false, statuses: [] (hidden, no token icon)
//
// Two gates this AE enforces:
//   1. Per-caster: target with an AE matching this caster's UUID =
//      "you already soul-stole this creature" — skip further attempts.
//   2. Per-item availability across the party: union of stolenLootKeys
//      across ALL soulStolenBy AEs on target = items already claimed.
//      Roll outcomes resolving to a claimed item are skipped.
//
// Rewind: AEs ride the [[director-rewind-tool-plan]] actor snapshot, so
// rewinding past a Soul Steal removes the AE and the gates clear.
//
// Row fields (effect_table):
//   target_ref     — which targets to roll for (typically hit_action_targets)
//   loot_prop      — actor prop holding the stealable map (default "stealable_loot")
//   chance_prop    — actor prop holding the percentile table (default "steal_percentage_table")
//
// Output: surfaces a Dialog (GM client) summarising per-target outcomes
// in equipment-card style (hover = description + stats).
async function applyRollLootTableEffect(row, ctx) {
  const targetRef = row.target_ref || "hit_action_targets";
  // Hit set — only these proceed to the roll-and-transfer path.
  const hitResult = await resolveTargetRef(targetRef, ctx);
  const hitTokens = (hitResult.ok ? (hitResult.tokens ?? []) : []);
  const hitUuidSet = new Set(hitTokens.map((t) => t.uuid));
  // Full action-target set — used so the dialog can show a "Missed"
  // line for every creature that was attacked but failed the Check.
  // Otherwise misses would be silent and the player can't tell whether
  // their Soul Steal didn't drop loot (rolled, nothing won) vs didn't
  // connect (Check missed). Resolved separately so authors don't have
  // to change target_ref on the row.
  const actionResult = await resolveTargetRef("action_targets", ctx);
  const actionTokens = (actionResult.ok ? (actionResult.tokens ?? []) : []);
  // Iterate the action targets when available (so misses surface).
  // Fall back to hit targets when action_targets resolves empty —
  // e.g. some chain paths build ctx without an action-target uuid list.
  const iterTokens = actionTokens.length ? actionTokens : hitTokens;
  if (!iterTokens.length) {
    return { ok: true, kind: "roll_loot_table", applied: [], reason: "no-targets" };
  }
  const lootProp   = String(row.loot_prop ?? "stealable_loot").trim();
  const chanceProp = String(row.chance_prop ?? "steal_percentage_table").trim();

  const caster = ctx.reactorActor;
  if (!caster) {
    warn("skill-effects.roll_loot_table: no caster (ctx.reactorActor missing)");
    return { ok: false, kind: "roll_loot_table", reason: "no-caster" };
  }

  // Helper: aggregate the soulStolen tracking state on a target.
  // Returns { thisCasterAlreadyStole, claimedKeys: Set }.
  function readStolenState(target) {
    const thisCasterUuid = caster.uuid;
    const claimedKeys = new Set();
    let thisCasterAlreadyStole = false;
    for (const ae of (target.effects?.contents ?? [])) {
      const fns = ae.flags?.[FLAG_NS];
      if (!fns?.soulStolenBy) continue;
      if (fns.soulStolenBy === thisCasterUuid) thisCasterAlreadyStole = true;
      for (const k of (fns.stolenLootKeys ?? [])) claimedKeys.add(k);
    }
    return { thisCasterAlreadyStole, claimedKeys };
  }

  const results = [];
  for (const token of iterTokens) {
    const target = token.actor;
    if (!target) continue;

    // Check-missed branch — target was attacked but the Check didn't
    // land. No roll, no AE stamp; just surface "missed" so the player
    // can plan a retry.
    if (actionTokens.length && !hitUuidSet.has(token.uuid)) {
      results.push({ targetName: target.name, missed: true, won: [] });
      continue;
    }

    const { thisCasterAlreadyStole, claimedKeys } = readStolenState(target);
    if (thisCasterAlreadyStole) {
      results.push({ targetName: target.name, alreadyStolen: true, won: [] });
      continue;
    }

    const lootMap   = target.system?.props?.[lootProp] ?? {};
    const chanceTbl = target.system?.props?.[chanceProp] ?? {};
    const rows = Object.values(chanceTbl).filter((r) => r && !r.$deleted);
    if (!rows.length) {
      results.push({ targetName: target.name, noTable: true, won: [] });
      continue;
    }

    // SINGLE weighted d100 roll per enemy. The steal table's loot_percentage
    // values partition 1..100 (e.g. 15 Zombie Potion / 30 Rotten Nail /
    // 25 Bloodied Coin / 30 "(Empty)" = 100), so ONE roll lands in exactly one
    // bucket and each enemy yields AT MOST one item (or nothing). Rows are
    // walked in table order, accumulating their percentages; the first bucket
    // the roll falls into wins. A roll past the defined buckets (table sums to
    // < 100) — or landing on an "(Empty)"/zero-pct bucket — steals nothing.
    // (Was previously an independent d100 PER row, which let one enemy drop
    // several items — not the intended single-pick-per-enemy loot model.)
    const won = [];
    const wonKeys = [];
    const roll = Math.floor(Math.random() * 100) + 1;  // 1..100
    let cumulative = 0;
    let chosenRow = null;
    for (const rRow of rows) {
      const pct = Number(rRow.loot_percentage) || 0;
      if (pct <= 0) continue;          // zero-pct buckets occupy no range
      cumulative += pct;
      if (roll <= cumulative) { chosenRow = rRow; break; }
    }
    const chosenName = String(chosenRow?.loot_id ?? "").trim();
    if (chosenRow && chosenName && chosenName !== "(Empty)") {
      const chosenPct = Number(chosenRow.loot_percentage) || 0;
      const entry = Object.entries(lootMap).find(
        ([, e]) => String(e?.name ?? "").trim() === chosenName
      );
      if (!entry) {
        log(`roll_loot_table: ${target.name}.${chanceProp} references "${chosenName}" but ${lootProp} has no entry`);
      } else {
        const [lootKey, lootEntry] = entry;
        if (claimedKeys.has(lootKey)) {
          // Rolled an item a prior caster already took — nothing stolen this
          // roll (the bucket is "spent"; no re-roll). Matches the steal model.
          log(`roll_loot_table: rolled "${chosenName}" but already claimed on ${target.name} — nothing stolen`);
        } else {
          // Resolve the source item — prefer world Item via
          // system.uniqueId / compendiumSource (matches legacy Study macro's
          // `resolveStealItemOpenUuid`). Falls back to the embedded item.
          const sourceItem = await resolveStealSourceItem(lootEntry);
          if (!sourceItem) {
            log(`roll_loot_table: no source resolvable for ${chosenName}; nothing stolen`);
          } else {
            // Stack consumables/materials; create fresh embedded copy for
            // equipment. The stacking key is `system.uniqueId` — same-uniqueId
            // items already on the caster are treated as the same stack and
            // their item_quantity is incremented.
            const transferred = await transferLootToCaster(caster, sourceItem);
            if (transferred) {
              wonKeys.push(lootKey);
              won.push({
                name: chosenName,
                img: sourceItem.img ?? null,
                desc: String(lootEntry.loot_description ?? ""),
                sourceItem,
                stacked: transferred.stacked,
                rolled: roll,
                chance: chosenPct,
              });
            }
          }
        }
      }
    }

    // Stamp the hidden tracker AE if anything stuck. The AE marks both
    // "this caster has used Soul Steal on this target" AND "these
    // specific items were claimed" so future rolls (including the
    // SAME caster's failed-rolls retry, if any) skip claimed items.
    // No statuses → no token icon. No changes → no game effect.
    if (won.length) {
      try {
        await target.createEmbeddedDocuments("ActiveEffect", [{
          name: `Soul Stolen by ${caster.name}`,
          icon: caster.img ?? null,
          transfer: false,
          changes: [],
          statuses: [],
          duration: {},
          flags: {
            [FLAG_NS]: {
              directorPermanent: true,
              soulStolenBy: caster.uuid,
              stolenLootKeys: wonKeys,
              appliedAtRound: ctx.dCombat?.round ?? 0,
            },
          },
        }]);
      } catch (e) {
        warn(`roll_loot_table: failed to stamp soulStolenBy AE on ${target.name}`, e);
      }
    }

    results.push({ targetName: target.name, won, rolled: true });
  }

  // Surface the summary dialog. Blocking — RESOLVE awaits the player's
  // OK so the action card doesn't dismiss until they've read the result.
  try {
    await showLootTableDialog({ casterName: caster.name, results });
  } catch (e) {
    warn(`roll_loot_table: dialog threw`, e);
  }

  return { ok: true, kind: "roll_loot_table", applied: results };
}

// Resolve a stealable_loot entry to its "source" Item document. Walks:
//   (a) embedded item's compendiumSource if it points at a world Item
//   (b) embedded item's system.uniqueId → game.items lookup
//   (c) the embedded item itself (last resort)
// Returns null if everything fails.
async function resolveStealSourceItem(lootEntry) {
  const uuid = String(lootEntry?.uuid ?? "").trim();
  if (!uuid) return null;
  try {
    const embedded = await fromUuid(uuid);
    if (!embedded || embedded.documentName !== "Item") return null;
    const compendiumSource = String(embedded?._stats?.compendiumSource ?? "").trim();
    if (compendiumSource.startsWith("Item.")) {
      const fromCs = await fromUuid(compendiumSource).catch(() => null);
      if (fromCs) return fromCs;
    }
    const uniqueId = String(embedded?.system?.uniqueId ?? "").trim();
    if (uniqueId) {
      const fromUid = game.items?.get(uniqueId) ?? null;
      if (fromUid) return fromUid;
    }
    return embedded;
  } catch (e) {
    warn("resolveStealSourceItem threw", e);
    return null;
  }
}

// Transfer one source-item's contents onto the caster. Consumables and
// materials stack on `system.uniqueId`; if the caster already has a
// matching item, its `item_quantity` is incremented. Equipment always
// creates a fresh embedded doc (each weapon/armor/accessory instance is
// distinct).
//
// Returns `{ item, stacked: boolean }` ONLY when the operation
// genuinely succeeded — i.e. the embedded doc exists. A preCreateItem
// hook returning `false` causes Foundry's `createEmbeddedDocuments` to
// resolve with an empty array (NO exception, no warning); we must
// detect that and return null so the caller skips the AE stamp + the
// dialog won't lie about a transfer that didn't happen.
async function transferLootToCaster(caster, sourceItem) {
  const itemType = String(sourceItem.system?.props?.item_type ?? "").toLowerCase();
  const isStackable = (itemType === "consumable" || itemType === "material");
  const sourceUniqueId = String(sourceItem.system?.uniqueId ?? "").trim();

  if (isStackable && sourceUniqueId) {
    const existing = caster.items?.contents?.find?.((i) =>
      String(i.system?.uniqueId ?? "").trim() === sourceUniqueId
    );
    if (existing) {
      const curQty = Number(existing.system?.props?.item_quantity ?? 0) || 0;
      try {
        await existing.update({ "system.props.item_quantity": curQty + 1 });
        return { item: existing, stacked: true };
      } catch (e) {
        warn(`transferLootToCaster: increment failed on ${caster.name}.${existing.name}`, e);
        return null;
      }
    }
  }

  try {
    const data = sourceItem.toObject();
    delete data._id;
    // Make sure quantity starts at 1 for stackables (in case source has 0).
    if (isStackable) {
      const ip = data.system?.props ?? {};
      if (!Number(ip.item_quantity)) {
        foundry.utils.setProperty(data, "system.props.item_quantity", 1);
      }
    }
    const created = await caster.createEmbeddedDocuments("Item", [data]);
    // Silent-rejection guard — Foundry returns `[]` (not throw) when a
    // preCreateItem hook returns false. Treat that as a transfer
    // failure: the caller should NOT push to `won`, should NOT stamp
    // the soulStolenBy AE, and the dialog should NOT pretend an item
    // landed.
    if (!Array.isArray(created) || !created.length || !created[0]) {
      warn(`transferLootToCaster: createEmbeddedDocuments returned empty on ${caster.name} for "${sourceItem.name}" — likely a preCreateItem hook rejection`);
      return null;
    }
    return { item: created[0], stacked: false };
  } catch (e) {
    warn(`transferLootToCaster: createEmbeddedDocuments threw on ${caster.name}`, e);
    return null;
  }
}

// Render the loot-roll summary dialog. Each item is presented in the
// same visual language as the Equipment action card's option list —
// black-bordered icon, bold name, meta line. Hovering an item surfaces
// the shared desc-tooltip with the item's description body + a stats
// strip (acc/dmg/def + traits) for equipment.
async function showLootTableDialog({ casterName, results }) {
  if (!Array.isArray(results) || !results.length) return;

  // Lazy-import desc-tooltip so this module can be tree-shaken cleanly
  // in non-UI contexts (harness, tests).
  const { ensureDescTooltipStyles, attachDescTooltip } = await import("./desc-tooltip.js");
  ensureDescTooltipStyles();
  ensureLootDialogStyles();

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  // Build the per-item stats strip — equipment-style chips (ACC/DMG/DEF +
  // traits like weapon type, range, hand slots, rarity). Returns "" for
  // non-equipment items so consumables don't surface chips they don't have.
  function buildStatsStrip(sourceItem) {
    if (!sourceItem) return "";
    const p = sourceItem.system?.props ?? {};
    const type = String(p.item_type ?? "").toLowerCase();
    const bits = [];
    const checkBonus = Number(p.check_bonus);
    if (type === "weapon" && Number.isFinite(checkBonus) && checkBonus !== 0) {
      const sign = checkBonus >= 0 ? "+" : "";
      bits.push(`<span class="fud-bf-desc-tip-stat-acc">ACC ${sign}${checkBonus}</span>`);
    }
    const dmgBonus = Number(p.damage_bonus);
    if (type === "weapon" && Number.isFinite(dmgBonus) && dmgBonus !== 0) {
      const sign = dmgBonus >= 0 ? "+" : "";
      bits.push(`<span class="fud-bf-desc-tip-stat-dmg">DMG ${sign}${dmgBonus}</span>`);
    }
    const defBonus = Number(p.item_def_bonus);
    const mdefBonus = Number(p.item_mdef_bonus);
    if (type === "armor" || type === "accessory") {
      const baseDef = Number(p.item_baseDef);
      const baseMdef = Number(p.item_baseMdef);
      const defParts = [];
      if (Number.isFinite(baseDef) && baseDef !== 0) defParts.push(`DEF ${baseDef >= 0 ? "+" : ""}${baseDef}`);
      else if (Number.isFinite(defBonus) && defBonus !== 0) defParts.push(`DEF ${defBonus >= 0 ? "+" : ""}${defBonus}`);
      if (Number.isFinite(baseMdef) && baseMdef !== 0) defParts.push(`MDEF ${baseMdef >= 0 ? "+" : ""}${baseMdef}`);
      else if (Number.isFinite(mdefBonus) && mdefBonus !== 0) defParts.push(`MDEF ${mdefBonus >= 0 ? "+" : ""}${mdefBonus}`);
      if (defParts.length) bits.push(`<span class="fud-bf-desc-tip-stat-def">${esc(defParts.join(" / "))}</span>`);
    }
    const trait = (t) => `<span class="fud-bf-desc-tip-stat-trait">${esc(t)}</span>`;
    if (type === "weapon") {
      const damageType = String(p.type_damage ?? "").trim();
      if (damageType) bits.push(trait(damageType));
      const range = String(p.weapon_range ?? "").trim();
      if (range) bits.push(trait(range));
      const hands = String(p.hand_slots ?? "").trim();
      if (hands) bits.push(trait(hands));
      if (p.isMartial) bits.push(`<span class="fud-bf-desc-tip-stat-trait is-flag">${esc("Martial")}</span>`);
    } else if (type === "armor" || type === "accessory") {
      bits.push(trait(type === "armor" ? "Armor" : "Accessory"));
      if (p.isMartial) bits.push(`<span class="fud-bf-desc-tip-stat-trait is-flag">${esc("Martial")}</span>`);
    } else if (type === "consumable") {
      bits.push(trait("Consumable"));
    } else if (type === "material") {
      bits.push(trait("Material"));
    }
    const rarity = String(p.item_rarity ?? "").trim();
    if (rarity && rarity !== "Common") {
      bits.push(`<span class="fud-bf-desc-tip-stat-trait is-flag">${esc(rarity)}</span>`);
    }
    return bits.join("");
  }

  function renderItemRow(targetName, won) {
    const stats = buildStatsStrip(won.sourceItem);
    const tipBody = won.desc ? esc(won.desc) : "";
    const descAttr = tipBody ? ` data-fud-equip-desc="${tipBody}" data-fud-equip-desc-name="${esc(won.name)}"` : "";
    const statsAttr = stats ? ` data-fud-equip-stats="${esc(stats)}"` : "";
    const stackedTag = won.stacked
      ? `<span class="fud-steal-stacked-pill" title="Added to existing stack">+1</span>`
      : "";
    const iconStyle = won.img ? `background-image:url('${esc(won.img)}')` : "";
    return `
      <div class="fud-steal-option"${descAttr}${statsAttr}>
        <div class="fud-steal-icon" style="${iconStyle}"></div>
        <div class="fud-steal-text">
          <div class="fud-steal-line">
            Obtain <b>${esc(won.name)}</b> from <b>${esc(targetName)}</b>${stackedTag}
          </div>
        </div>
      </div>
    `;
  }

  function renderTargetBlock(r) {
    if (r.missed) {
      return `<div class="fud-steal-empty"><b>Missed</b> — Check failed against <b>${esc(r.targetName)}</b>.</div>`;
    }
    if (r.alreadyStolen) {
      return `<div class="fud-steal-empty"><b>Already stolen</b> from <b>${esc(r.targetName)}</b>.</div>`;
    }
    if (r.noTable) {
      return `<div class="fud-steal-empty"><b>No stealable items</b> on <b>${esc(r.targetName)}</b>.</div>`;
    }
    if (!r.won.length) {
      return `<div class="fud-steal-empty">Stole <b>nothing</b> from <b>${esc(r.targetName)}</b>.</div>`;
    }
    return r.won.map((w) => renderItemRow(r.targetName, w)).join("");
  }

  const content = `
    <div class="fud-steal-dialog">
      <div class="fud-steal-header"><b>${esc(casterName)}</b> performs Soul Steal:</div>
      <div class="fud-steal-body">${results.map(renderTargetBlock).join("")}</div>
    </div>
  `;

  // Bind the desc-tooltip on the rendered Dialog element so hovering
  // an item surfaces the equipment-style tooltip.
  let detachTooltip = null;
  const dialog = new Dialog({
    title: "Soul Steal — Results",
    content,
    buttons: { ok: { label: "OK", callback: () => {} } },
    default: "ok",
    close: () => { try { detachTooltip?.(); } catch (e) { /* noop */ } },
    render: (html) => {
      try {
        const root = html?.[0] ?? html;
        if (root instanceof HTMLElement) {
          detachTooltip = attachDescTooltip(root, { isAlive: () => true });
        }
      } catch (e) {
        warn("loot-dialog: attachDescTooltip threw", e);
      }
    },
  }, { width: 460, classes: ["fud-steal-dialog-window"] });
  await new Promise((resolve) => {
    const origClose = dialog.close.bind(dialog);
    dialog.close = (opts) => {
      const p = origClose(opts);
      resolve();
      return p;
    };
    dialog.render(true);
  });
}

const LOOT_DIALOG_STYLE_ID = "fud-steal-dialog-style";
function ensureLootDialogStyles() {
  if (document.getElementById(LOOT_DIALOG_STYLE_ID)) return;
  const css = document.createElement("style");
  css.id = LOOT_DIALOG_STYLE_ID;
  css.textContent = `
    .fud-steal-dialog { font-family: "Signika", "Roboto", sans-serif; font-size: 13px; }
    .fud-steal-header { margin: 4px 0 8px; font-size: 13px; }
    .fud-steal-body { display: flex; flex-direction: column; gap: 6px; }
    .fud-steal-option {
      display: grid;
      grid-template-columns: 56px 1fr;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-radius: 6px;
      background: rgba(122, 155, 182, 0.10);
      transition: background 120ms ease;
    }
    .fud-steal-option:hover {
      background: rgba(122, 155, 182, 0.22);
    }
    .fud-steal-icon {
      width: 52px; height: 52px;
      border-radius: 6px;
      background-color: rgba(20, 20, 20, 0.08);
      background-size: cover;
      background-position: center;
      border: 2px solid #000;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4) inset;
    }
    .fud-steal-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .fud-steal-line {
      font-size: 13.5px;
      line-height: 1.25;
      color: #3a3228;
    }
    .fud-steal-line b { font-weight: 800; }
    .fud-steal-roll {
      font-size: 10.5px;
      opacity: 0.7;
      font-weight: 600;
    }
    .fud-steal-stacked-pill {
      display: inline-block;
      margin-left: 6px;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 800;
      background: rgba(42, 110, 61, 0.18);
      color: #2a6e3d;
      vertical-align: 1px;
    }
    .fud-steal-empty {
      padding: 6px 8px;
      border-radius: 6px;
      background: rgba(90, 106, 133, 0.08);
      font-size: 12.5px;
    }
    .fud-steal-empty b { font-weight: 800; }
  `;
  document.head.appendChild(css);
}

// ── chain ──────────────────────────────────────────────────────────────

async function applyChainEffect(row, ctx) {
  // Shared parser with `open_action_menu.menu_option_refs` — same
  // "comma- or newline-separated list of effect_table labels" grammar.
  const steps = parseEffectRefList(row.chain_steps);
  if (!steps.length) return { ok: false, kind: "chain", reason: "no-steps" };

  const aggregated = [];
  for (const label of steps) {
    const r = await applyEffectByLabel(label, ctx);
    aggregated.push({ label, result: r });
    if (!r.ok) {
      log(`skill-effects.chain: step "${label}" returned ok=false (${r.reason ?? "?"}); stopping chain`);
      return { ok: false, kind: "chain", applied: aggregated, reason: `step-failed:${label}`, abort: r.abort };
    }
    if (r.abort) {
      log(`skill-effects.chain: step "${label}" set abort:true; stopping chain`);
      return { ok: true, kind: "chain", applied: aggregated, abort: true };
    }
    if (r.skipBody) {
      // `redirect_target` returns skipBody:true (B.2). We surface it
      // upward but DON'T stop the chain — schema doc rationale: cost
      // steps AFTER the redirect should still run.
      // For B.1 redirect_target isn't implemented; this path is dead
      // until B.2.
    }
  }
  return { ok: true, kind: "chain", applied: aggregated };
}
