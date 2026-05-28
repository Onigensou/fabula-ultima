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
import { pickOption } from "./option-picker.js";
import { resolveTargetRef } from "./skill-targeting.js";
import { findAndConsume } from "./skill-charges.js";
import { readPropNum } from "./snapshot.js";

const FLAG_NS = "fabula-ultima-companion";

// Resource definitions — match skill-cost.js. Out-of-bounds writes
// clamp to [0, max] when a max is defined.
const RESOURCE_PROPS = {
  hp:         { prop: "current_hp",    max: "max_hp"    },
  mp:         { prop: "current_mp",    max: "max_mp"    },
  ip:         { prop: "current_ip",    max: "max_ip"    },
  zero_power: { prop: "zero_power",    max: null, hardMin: 0, hardMax: 6 },
  zenit:      { prop: "zenit",         max: null        },
  enmity:     { prop: "enmity",        max: null        },
  fp:         { prop: "fabula_points", max: null        },
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

// Legacy export — kept as an alias so older call sites still resolve.
// New callers should use `sweepTransientAEsAtSceneEnd`.
export const sweepDirectorAEsAll = sweepTransientAEsAtSceneEnd;

// ── Damage-taken reaction resolver ─────────────────────────────────────
//
// Generic data-driven hook called BEFORE the director writes
// `current_hp` on a damage-application path. Walks the target's AEs for
// any `reactionConfig` declaring a `creature_takes_damage` trigger whose
// filter (e.g. `reaction_damage_outcome: "would_reduce_to_zero"`)
// matches the pending damage. Matching AEs' effect rows can MUTATE the
// pending HP — set a floor (Mercy), cap damage (future), reflect, etc.
//
// Currently implemented modify modes (via effect_kind: "modify_damage_taken"):
//   - `set_hp_floor` — if the computed newHp would be below `modify_value`,
//     clamp it up to that value. Used by Mercy (value=1).
//
// Future modes (placeholder):
//   - `cap_damage`     — cap pre-affinity damage at modify_value
//   - `reflect_damage` — reflect pct/value back at the source
//   - `multiply_damage` — additional affinity-like multiplier
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
//         effect_kind: "modify_damage_taken",
//         modify_mode: "set_hp_floor",
//         modify_value: 1,
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
  const baselineHp = Math.max(0, curHp - rawDamage);
  const result = { newHp: baselineHp, consumedAeIds: [], fired: [] };
  if (!target || rawDamage <= 0) return result;

  for (const ae of (target.effects?.contents ?? Array.from(target.effects ?? []))) {
    if (ae.disabled) continue;
    const cfg = ae.flags?.[FLAG_NS]?.reactionConfig;
    if (!cfg || typeof cfg !== "object") continue;
    const triggerRows = Object.values(cfg.reaction_config_table ?? {});
    const effectTable = cfg.effect_table ?? {};

    for (const tRow of triggerRows) {
      if (tRow.reaction_trigger !== "creature_takes_damage") continue;
      // reaction_source defaults to "self" — reactor IS the damage target.
      // For damage-time clamps the AE-bearer is always the target, so
      // anything except an explicit cross-actor source ("ally" etc.) is
      // a match. Leaving the full source-matrix to Phase F.
      const src = tRow.reaction_source ?? "self";
      if (src !== "self" && src !== "all" && src !== "") continue;

      // Filter: damage_outcome.
      const outcome = tRow.reaction_damage_outcome ?? "any";
      if (outcome === "would_reduce_to_zero") {
        if ((curHp - rawDamage) > 0) continue; // damage wouldn't drop them → skip
      }
      // (Future filters — reaction_damage_source / element / intent — can
      // gate here. For Mercy none are needed.)

      // Find effect row by label.
      const effRow = Object.values(effectTable)
        .find((r) => r.effect_label === tRow.reaction_effect_ref);
      if (!effRow) continue;
      if (effRow.effect_kind !== "modify_damage_taken") continue;

      const mode = effRow.modify_mode ?? "set_hp_floor";
      if (mode === "set_hp_floor") {
        const floor = Number(effRow.modify_value ?? 1) || 1;
        if (result.newHp < floor) {
          log(`damage-reaction: ${target.name} clamped HP floor at ${floor} via AE "${ae.name}"`);
          result.newHp = floor;
          result.fired.push({ aeId: ae.id, aeName: ae.name, mode, floor });
        }
      }
      // (Other modes wire here when implemented.)

      if (effRow.consume_self) {
        if (!result.consumedAeIds.includes(ae.id)) result.consumedAeIds.push(ae.id);
      }
    }
  }
  return result;
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
  logPrefix = "",
  logSuffix = "",
} = {}) {
  const empty = { resource, finalValue: 0, valueDirection: "none", fired: [] };
  if (!target) return empty;
  const prefix = logPrefix ? `${logPrefix} ` : "";

  // MP path — drain spells, future MP-burn. No AB flip; no reactions
  // (could add later for an MP-clamp AE if a use case appears).
  if (resource === "mp") {
    if (damage <= 0) return empty;
    const curMp = readPropNum(target, ["current_mp", "mp"]);
    const newMp = Math.max(0, curMp - damage);
    await target.update({ "system.props.current_mp": newMp });
    log(`${prefix}applied ${damage} MP damage to ${targetName}: ${curMp} → ${newMp}${logSuffix}`);
    return { resource: "mp", finalValue: damage, valueDirection: "loss", fired: [] };
  }

  // HP path — full affinity rules.
  const curHp = readPropNum(target, ["current_hp", "hp"]);
  const maxHp = readPropNum(target, ["max_hp"], curHp);

  // AB → heal flip.
  if (affinity === "AB") {
    const healed = Math.max(0, damage);
    if (healed > 0) {
      const newHp = Math.min(maxHp, curHp + healed);
      await target.update({ "system.props.current_hp": newHp });
      log(`${prefix}absorbed ${healed} on ${targetName}: ${curHp} → ${newHp} (heal)${logSuffix}`);
    } else {
      log(`${prefix}no HP change for ${targetName} [AB]${logSuffix} (damage was ${damage})`);
    }
    return { resource: "hp", finalValue: healed, valueDirection: "recover", fired: [] };
  }

  // Normal damage path — reaction AEs first, then write, then consume.
  if (damage > 0) {
    const { newHp, consumedAeIds, fired } = await resolveDamageReactions({ target, curHp, rawDamage: damage });
    await target.update({ "system.props.current_hp": newHp });
    for (const aeId of consumedAeIds) {
      const ae = target.effects?.get?.(aeId);
      if (ae) {
        try { await ae.delete(); }
        catch (e) { warn("applyDamageToTarget: consume AE delete failed", e); }
      }
    }
    const reactionNote = fired.length ? ` (reactions: ${fired.map((f) => f.aeName).join(", ")})` : "";
    log(`${prefix}applied ${damage} dmg to ${targetName} [${affinity}]: ${curHp} → ${newHp}${reactionNote}${logSuffix}`);
    return {
      resource: "hp",
      finalValue: Math.max(0, curHp - newHp),
      valueDirection: "loss",
      fired,
    };
  }

  log(`${prefix}no HP change for ${targetName} [${affinity}]${logSuffix} (damage was ${damage})`);
  return empty;
}

// Legacy alias — kept temporarily so any straggling call sites resolve.
// New code should use resolveDamageReactions() above.
export async function applyMercyClamp(targetActor, curHp, rawDamage) {
  const r = await resolveDamageReactions({ target: targetActor, curHp, rawDamage });
  // Consume the AEs that fired (matches the old helper's behavior).
  for (const id of r.consumedAeIds) {
    const ae = targetActor?.effects?.get?.(id);
    if (ae) { try { await ae.delete(); } catch (e) { warn("applyMercyClamp compat: AE delete failed", e); } }
  }
  return { newHp: r.newHp, mercyFired: r.fired.length > 0 };
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

// Legacy single-arg helper kept so the existing import sites resolve
// during the transition. Implicitly scope="attack" because that's
// the only damage-compute path that calls it today.
export function applyDamageTypeOverride(attackerActor, originalElement) {
  return resolveDamageElementOverride({
    actor: attackerActor,
    scope: "attack",
    native: originalElement,
  });
}

// Older alias name retained for compatibility.
export const applySoulWeaponElementOverride = applyDamageTypeOverride;

// ── Passive trigger layer (reaction_config_table-driven) ───────────────
//
// Passive behaviors live in any item's `system.props.reaction_config_table`
// as rows with `reaction_isPassive: true`. The dispatcher walks every item
// on the caster (not just skill_type==="Passive" — buffs / equipment with
// reactionConfig blobs work the same way), matches rows by `reaction_trigger`
// + filters, and fires the linked `reaction_effect_ref` against the item's
// `effect_table`.
//
// Row fields honored by this dispatcher:
//   reaction_trigger          — must equal the event key (e.g. "creature_completes_spell")
//   reaction_isPassive        — must be true (manual reactions don't auto-fire here)
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

async function shouldReactionPassiveFire(row, item, reactorActor, payload) {
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

  // 4. Optional condition formula (resolved against the reactor).
  const condRaw = String(row.condition_formula ?? "").trim();
  if (condRaw) {
    const { evaluateFormula, buildSkillResolver } = await import("./skill-formulas.js");
    const resolver = buildSkillResolver({ actor: reactorActor, payload, skill: item, round: 0 });
    const val = evaluateFormula(condRaw, resolver, 0);
    if (!val) {
      log(`passive ${item.name}: condition_formula="${condRaw}" → ${val} (falsy)`);
      return false;
    }
  }
  return true;
}

// Resolve the tri-state mode (on/ask/off) for a reaction-config passive row.
// Reads `reaction_passive_mode`, default "ask".
function resolveReactionPassiveMode(row) {
  const explicit = String(row?.reaction_passive_mode ?? "").trim().toLowerCase();
  if (explicit === "on" || explicit === "ask" || explicit === "off") return explicit;
  return "ask";
}

// Legacy shim — old callers (Vismagus cost-gate etc.) read passive_mode off
// the props directly. Kept until those paths are migrated to reaction config.
export function resolvePassiveMode(props) {
  const explicit = String(props?.passive_mode ?? "").trim().toLowerCase();
  if (explicit === "on" || explicit === "ask" || explicit === "off") return explicit;
  if (props?.passive_optional === false) return "on";
  return "ask";
}

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

// Walk every reaction_config_table row on the reactor's items, fire any
// passive rows matching `trigger`. Replaces the old passive_trigger-field
// dispatcher.
export async function firePassiveTriggers({ director, casterActor, trigger, payload }) {
  if (!casterActor || !trigger) return { fired: [] };

  // ── Collect candidates from BOTH items and AEs ───────────────────────
  //
  // Carrier kinds:
  //   - "item": props.reaction_config_table on the item, effect_table on
  //             the item via getRuntimeSkillView. Classic firing site for
  //             passives like Healing Power / Support Magic (item-bound).
  //   - "ae":   ae.flags.fabula-ultima-companion.reactionConfig carries
  //             both reaction_config_table and effect_table. Used by
  //             AE-bound buffs that react to subsequent events on the
  //             AE's bearer (Support Magic's check-bonus AE auto-consume,
  //             Mercy-style damage-time clamps without the bespoke
  //             resolveDamageReactions path).
  const candidates = [];
  for (const item of casterActor.items?.contents ?? []) {
    const rc = item.system?.props?.reaction_config_table;
    if (!rc || typeof rc !== "object") continue;
    for (const key of Object.keys(rc)) {
      const row = rc[key];
      if (!row || row.$deleted) continue;
      if (row.reaction_isPassive !== true) continue;
      if (String(row.reaction_trigger ?? "").trim() !== trigger) continue;
      candidates.push({
        carrierKind: "item",
        carrier: item,
        carrierName: item.name,
        carrierDescription: item.system?.props?.description,
        row,
      });
    }
  }
  for (const ae of casterActor.effects?.contents ?? []) {
    if (ae.disabled) continue;
    const cfg = ae.flags?.[FLAG_NS]?.reactionConfig;
    if (!cfg || typeof cfg !== "object") continue;
    const rc = cfg.reaction_config_table;
    if (!rc || typeof rc !== "object") continue;
    for (const key of Object.keys(rc)) {
      const row = rc[key];
      if (!row || row.$deleted) continue;
      if (row.reaction_isPassive !== true) continue;
      if (String(row.reaction_trigger ?? "").trim() !== trigger) continue;
      candidates.push({
        carrierKind: "ae",
        carrier: ae,
        carrierName: ae.name,
        carrierDescription: ae.description ?? "",
        aeEffectTable: cfg.effect_table ?? {},
        row,
      });
    }
  }
  if (!candidates.length) return { fired: [] };

  const fired = [];
  for (const cand of candidates) {
    const { carrierKind, carrier, carrierName, row } = cand;
    if (!(await shouldReactionPassiveFire(row, carrier, casterActor, payload))) {
      log(`passive: ${carrierName} skipped (reaction-config filter/condition mismatch)`);
      continue;
    }
    const mode = resolveReactionPassiveMode(row);
    if (mode === "off") {
      log(`passive: ${carrierName} mode=off — skipping`);
      continue;
    }
    if (mode === "ask") {
      // Harness override (Phase 2.1): see __FU_HARNESS_ACCEPT_PASSIVES__.
      const ovAccept = globalThis.__FU_HARNESS_ACCEPT_PASSIVES__;
      let ok;
      if (ovAccept !== undefined && ovAccept !== null) {
        if (typeof ovAccept === "boolean") ok = ovAccept;
        else if (typeof ovAccept === "object") {
          let matched = null;
          for (const [name, val] of Object.entries(ovAccept)) {
            if (carrierName.includes(name) || name.includes(carrierName)) { matched = !!val; break; }
          }
          ok = matched ?? await promptPassiveOptin(carrierName, casterActor, cand.carrierDescription);
        } else ok = await promptPassiveOptin(carrierName, casterActor, cand.carrierDescription);
      } else {
        ok = await promptPassiveOptin(carrierName, casterActor, cand.carrierDescription);
      }
      if (!ok) { log(`passive: ${carrierName} declined by GM`); continue; }
    }
    const refLabel = String(row.reaction_effect_ref ?? "").trim();

    const { makeChainContext } = await import("./skill-targeting.js");
    const reactorToken = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === casterActor.uuid)?.document
      ?? casterActor?.getActiveTokens?.()?.[0]?.document
      ?? null;

    // Build the effect_table that applyEffectByLabel will resolve against.
    // For item carriers, run through getRuntimeSkillView so recipes / sugar
    // expand. For AE carriers, the AE-borne effect_table is already the
    // final shape.
    let runtimeEffectTable;
    let firePoints;
    let skillForCtx;
    if (carrierKind === "item") {
      const { getRuntimeSkillView } = await import("./skill-recipes.js");
      const view = getRuntimeSkillView(carrier);
      runtimeEffectTable = view.effect_table;
      firePoints = view.fire_points;
      skillForCtx = carrier;
    } else {
      runtimeEffectTable = cand.aeEffectTable;
      firePoints = null;
      // AE-bound reactions don't have a parent skill — pass the AE for
      // any formula resolver that wants SL/recipe context (resolver
      // tolerates null skill).
      skillForCtx = null;
    }
    const ctx = makeChainContext({
      reactorActor: casterActor,
      reactorToken,
      skill: skillForCtx,
      dCombat: director?.dCombat ?? null,
      payload,
      actionTargetUuids: payload?.targetTokenUuids ?? [],
      hitActionTargetUuids: payload?.hitTargetTokenUuids ?? payload?.targetTokenUuids ?? [],
      isPassive: mode === "on",
      runtimeEffectTable,
      firePoints,
    });
    try {
      // refLabel may be blank for AE-bound reactions that only need to
      // consume themselves (the firing IS the effect). Skip the dispatch
      // in that case; the post-fire consume-self path still runs.
      let r = { ok: true, kind: "noop" };
      if (refLabel) {
        r = await applyEffectByLabel(refLabel, ctx);
      }
      fired.push({ carrier: carrierName, carrierKind, ok: !!r.ok, kind: r.kind });
      log(`passive ${carrierName} (${carrierKind}): fired ref "${refLabel || "(none)"}" → ok=${!!r.ok}`);

      // Post-fire bookkeeping for AE carriers: consume self / decrement
      // charges. AE-bound passives commonly want "fire once then remove";
      // the dispatcher handles this so individual reactions don't have
      // to author a consume_charge effect_row pointing at themselves.
      //
      // Two consume signals supported:
      //   - row.consume_self === true       → unconditional delete after fire
      //   - effectRow.consume_self === true → effect-row-driven delete
      //   - AE carries charges flag         → decrement; delete when 0
      if (carrierKind === "ae" && r.ok) {
        const effRow = refLabel
          ? Object.values(cand.aeEffectTable).find((er) => er?.effect_label === refLabel)
          : null;
        const consumeSelfFlag = row.consume_self === true || effRow?.consume_self === true;
        const chargeFlags = carrier.flags?.[FLAG_NS] ?? {};
        const hasCharges = chargeFlags.charges != null || chargeFlags.chargesMax != null;
        if (consumeSelfFlag) {
          try {
            await carrier.delete();
            log(`passive ${carrierName}: consume_self → AE deleted`);
          } catch (e) { warn(`consume_self delete failed`, e); }
        } else if (hasCharges) {
          // Decrement via the shared charges API (auto-deletes at 0).
          const { consume: consumeCharge } = await import("./skill-charges.js");
          const res = await consumeCharge(carrier, { count: 1 });
          log(`passive ${carrierName}: charge consumed (remaining=${res?.remaining ?? "?"}, deleted=${!!res?.deleted})`);
        }
      }
    } catch (e) {
      warn(`passive ${carrierName}: applyEffectByLabel threw`, e);
    }
  }
  return { fired };
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

// Dispatch a single effect row. Callers that already have the row
// (e.g. chain steps) call this directly.
export async function applyEffectRow(row, ctx) {
  if (!row) return { ok: false, reason: "no-row" };
  const kind = String(row.effect_kind ?? "").trim().toLowerCase();
  switch (kind) {
    case "targeting":      return applyTargetingEffect(row, ctx);
    case "grant":          return applyGrantEffect(row, ctx);
    case "apply_ae":       return applyApplyAeEffect(row, ctx);
    case "consume_charge": return applyConsumeChargeEffect(row, ctx);
    case "chain":          return applyChainEffect(row, ctx);
    case "open_action_menu": return applyOpenActionMenuEffect(row, ctx);
    case "remove_tagged_ae": return applyRemoveTaggedAeEffect(row, ctx);
    case "substitute_cost":  return applySubstituteCostEffect(row, ctx);
    // B.2+:
    case "consume_resource":
    case "redirect_target":
      warn(`skill-effects: effect_kind "${kind}" not implemented in B.1; skipping row "${row.effect_label}"`);
      return { ok: true, kind, applied: [], reason: "not-implemented" };
    default:
      warn(`skill-effects: unknown effect_kind "${kind}" on row "${row.effect_label}"`);
      return { ok: false, kind, reason: "unknown-kind" };
  }
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

// Fire `post_damage_effect_ref` for ONE damage event. Caller invokes
// this once per damaged target so per-event formulas (HP_DEALT etc.)
// see the correct payload. `damagePayload` overrides ctx.payload for
// this fire so the formula resolver sees the per-target finalValue.
//
// The fire-point label is read from `ctx.firePoints` when provided
// (recipe-merged), else from the skill's raw props.
export async function firePostDamageEffect(skill, ctx, damagePayload) {
  const label = String(
    ctx?.firePoints?.post_damage_effect_ref
    ?? skill?.system?.props?.post_damage_effect_ref
    ?? ""
  ).trim();
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
    if (result.ok) applied.push({ actorUuid: actor.uuid, resource, delta: result.applied, newValue: result.newValue });
  }
  log(`skill-effects.grant: row "${row.effect_label}" applied ${amount} ${resource} to ${applied.length} actor(s)`);
  return { ok: true, kind: "grant", applied };
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

async function applyApplyAeEffect(row, ctx) {
  const aeRef = String(row.ae_template_ref ?? "").trim();
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

  const applied = [];
  for (const token of tokens) {
    const actor = token.actor;
    if (!actor) continue;

    const existing = findDuplicateAe(actor, template, isPerCaster ? { casterActorUuid: casterUuid } : null);
    if (existing) {
      if (baseMode === "skip") { log(`skill-effects.apply_ae: ${actor.name} already has "${template.name}"${isPerCaster ? " from this caster" : ""} (skip)`); continue; }
      if (baseMode === "remove") { try { await existing.delete(); applied.push({ actorUuid: actor.uuid, removed: existing.name }); } catch (e) { warn("apply_ae remove failed", e); } continue; }
      if (baseMode === "replace") { try { await existing.delete(); } catch (e) { warn("apply_ae replace-delete failed", e); } }
      // "stack" falls through to create a new one
    }

    // Build the data — stamp `origin` to the firing skill so the AE
    // tracks back to its source (matches legacy behavior).
    const data = foundry.utils.deepClone(template);
    delete data._id;  // let Foundry assign a fresh id
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

    if (Array.isArray(data.changes) && data.changes.length) {
      for (const ch of data.changes) {
        if (typeof ch?.value !== "string") continue;
        if (!isFormulaString(ch.value)) continue;
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
    let turnsRemaining;
    if (flagsNS.directorPermanent === true) {
      turnsRemaining = null;  // opt-out: never expires
    } else if (Number.isFinite(explicit) && explicit > 0) {
      turnsRemaining = explicit;
    } else {
      turnsRemaining = 3;
    }
    data.flags[FLAG_NS].directorAppliedBy = {
      skillUuid: ctx.skill?.uuid ?? null,
      reactorActorUuid: ctx.reactorActor?.uuid ?? null,
      effectLabel: row.effect_label,
      appliedAtRound: ctx.dCombat?.round ?? 0,
      turnsRemaining,
    };
    try {
      const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [data]);
      applied.push({ actorUuid: actor.uuid, aeId: created?.id ?? null, name: data.name });
    } catch (e) {
      warn(`skill-effects.apply_ae: createEmbeddedDocuments failed on ${actor.name}`, e);
    }
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
async function applyOpenActionMenuEffect(row, ctx) {
  // Resolve options. Prefer refs (CSB-friendly) over inline.
  const refs = parseEffectRefList(row.menu_option_refs);
  let options = [];
  let optionRows = [];  // parallel array of source effect_table rows (refs path)
  if (refs.length) {
    for (const label of refs) {
      const refRow = findEffectRow(ctx, label);
      if (!refRow) {
        warn(`skill-effects.open_action_menu: ref "${label}" → no matching effect_table row; skipping`);
        continue;
      }
      // The referenced row provides menu_label / menu_description for
      // display, and its own effect_kind + params for dispatch.
      const displayLabel = String(refRow.menu_label ?? refRow.effect_label ?? label);
      options.push({
        label: displayLabel,
        description: refRow.menu_description ? String(refRow.menu_description) : null,
      });
      optionRows.push(refRow);
    }
  }
  if (!options.length) {
    // Inline form fallback. `menu_options` may be an array or an
    // object-keyed-by-index (CSB stores arrays as numeric-keyed objects).
    const optsRaw = row.menu_options;
    const inline = Array.isArray(optsRaw)
      ? optsRaw
      : (optsRaw && typeof optsRaw === "object" ? Object.values(optsRaw) : []);
    const valid = inline.filter((o) => o && typeof o === "object" && o.label);
    options = valid.map((o) => ({
      label: String(o.label),
      description: o.description ? String(o.description) : null,
    }));
    optionRows = valid;  // inline objects already row-shaped
  }

  if (!options.length) {
    warn(`skill-effects.open_action_menu: row "${row.effect_label}" has no usable options`);
    return { ok: false, kind: "open_action_menu", reason: "no-options" };
  }

  let chosen = null;
  // Test harness — consume a queued pick if present (set by
  // FUCompanion.api.test.runDirectorSkillSimulate via harnessPicks).
  // The shape is { menuLabel?: string, index?: number } or a plain
  // string (alias for menuLabel). Falls through to the normal path if
  // the queue is empty.
  // `ctx.harnessPicks` may be a frozen array (freezeActionResult applied
  // it recursively when the harness stamped `_harnessPicks` on the ar).
  // We can't shift() a frozen array, so we mutate a parallel index via
  // a counter on the ctx instead. First call initializes the cursor at 0.
  const harnessQueue = Array.isArray(ctx?.harnessPicks) ? ctx.harnessPicks : null;
  if (harnessQueue && harnessQueue.length > (ctx._harnessPicksCursor ?? 0)) {
    const cursor = ctx._harnessPicksCursor ?? 0;
    ctx._harnessPicksCursor = cursor + 1;
    const next = harnessQueue[cursor];
    let idx = -1;
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
    if (idx < 0 || idx >= options.length) {
      warn(`skill-effects.open_action_menu: harnessPick ${JSON.stringify(next)} did not match any of ${options.map(o => o.label).join(", ")} — falling back to index 0`);
      idx = 0;
    }
    chosen = { index: idx, option: options[idx] };
    log(`skill-effects.open_action_menu: harness pick → "${options[idx].label}"`);
  } else if (ctx.isPassive) {
    // Passive: no prompt — pick the first option. Author-controlled
    // ordering means option[0] = "default" for autoresolution.
    chosen = { index: 0, option: options[0] };
    log(`skill-effects.open_action_menu: passive ctx — auto-picking first option "${options[0].label}"`);
  } else {
    chosen = await pickOption({
      title: String(row.menu_title ?? "Choose an option"),
      subtitle: row.menu_subtitle ? String(row.menu_subtitle) : null,
      options,
    });
    if (!chosen) {
      log(`skill-effects.open_action_menu: row "${row.effect_label}" cancelled by user`);
      return { ok: true, kind: "open_action_menu", applied: [], reason: "cancelled", abort: true };
    }
  }

  // Build a synthetic row from the chosen option. Refs path: the
  // referenced row IS the dispatch row (already has effect_kind +
  // params). Inline path: the inline option object IS the dispatch row
  // (we trust its effect_kind field).
  const selectedRow = optionRows[chosen.index];
  if (!selectedRow?.effect_kind) {
    warn(`skill-effects.open_action_menu: option "${options[chosen.index].label}" missing effect_kind`);
    return { ok: false, kind: "open_action_menu", reason: "option-missing-effect-kind" };
  }
  // Stamp a traceable label on the synthetic row for logs without
  // mutating the referenced source row.
  const syntheticRow = {
    ...selectedRow,
    effect_label: `${row.effect_label ?? "menu"}:${options[chosen.index].label}`,
  };
  log(`skill-effects.open_action_menu: row "${row.effect_label}" → option "${options[chosen.index].label}" (${syntheticRow.effect_kind})`);
  const sub = await applyEffectRow(syntheticRow, ctx);
  return {
    ok: !!sub.ok,
    kind: "open_action_menu",
    selectedIndex: chosen.index,
    selectedLabel: options[chosen.index].label,
    nestedResult: sub,
    abort: sub.abort,
  };
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
  const rawCount = row.count;
  const removeAll = String(rawCount ?? "1").toLowerCase() === "all";
  const count = removeAll ? Infinity : Math.max(1, Number(rawCount ?? 1) || 1);

  const targetResult = await resolveTargetRef(row.target_ref, ctx);
  if (!targetResult.ok) return { ok: false, kind: "remove_tagged_ae", reason: targetResult.reason ?? "no-targets" };
  const tokens = targetResult.tokens;
  if (!tokens.length) return { ok: false, kind: "remove_tagged_ae", reason: "no-targets" };

  const removed = [];
  for (const token of tokens) {
    const actor = token.actor;
    if (!actor) continue;

    const matches = Array.from(actor.effects ?? []).filter((eff) => {
      const tags = eff?.system?.tags;
      return Array.isArray(tags) && tags.includes(filterTag);
    });

    if (!matches.length) {
      log(`skill-effects.remove_tagged_ae: ${actor.name} has no "${filterTag}" AE; skipping target`);
      ui.notifications?.info(`${actor.name} has no ${filterTag} to remove.`);
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
      let chosen = null;
      if (ctx.isPassive) {
        chosen = { index: 0, option: { label: remainingMatches[0].name } };
      } else {
        const options = remainingMatches.map((eff) => ({
          label: String(eff.name ?? "(unnamed)"),
          description: eff.description ? String(eff.description) : null,
        }));
        const title = String(row.menu_title ?? `Choose a ${filterTag} to remove`);
        const subtitle = `${actor.name}${row.menu_subtitle ? ` · ${row.menu_subtitle}` : ""}`;
        chosen = await pickOption({ title, subtitle, options });
      }
      if (!chosen) {
        log(`skill-effects.remove_tagged_ae: ${actor.name} picker cancelled; skipping rest of this target`);
        break;
      }
      const picked = remainingMatches[chosen.index];
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
