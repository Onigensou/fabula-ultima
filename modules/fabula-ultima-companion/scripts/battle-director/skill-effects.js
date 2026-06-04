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
import { findAndConsume, findOnActor as findChargeAEsOnActor } from "./skill-charges.js";
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
  fp:         { prop: "fabula_point",  max: null        },
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
    fireResourceLossVfx({ tokenUuid, resource: "mp", amount: curMp - newMp });
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
      fireAbsorbVfx({ tokenUuid, amount: newHp - curHp });
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
    fireResourceLossVfx({ tokenUuid, resource: "hp", amount: curHp - newHp, affinity });
    return {
      resource: "hp",
      finalValue: Math.max(0, curHp - newHp),
      valueDirection: "loss",
      fired,
    };
  }

  // Immune (IM) zeroed the damage — fire the immune cue so the hit isn't silent
  // (other 0-damage cases, e.g. a 0 roll, stay quiet).
  if (affinity === "IM") fireImmuneVfx({ tokenUuid });
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
export function analyzeChainCost(effectTable, startLabel, actor, skill = null) {
  const out = {
    ok: false, debit: {}, chargeDebit: {},
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

  function walk(label) {
    if (!label || seen.has(label)) return;
    seen.add(label);
    const row = byLabel.get(label);
    if (!row) return;
    const kind = String(row.effect_kind ?? "").trim().toLowerCase();
    if (kind === "consume_resource") {
      const resource = String(row.consume_resource ?? row.grant_resource ?? "").trim().toLowerCase();
      const def = RESOURCE_PROPS[resource];
      if (!def) return;
      const amountRaw = row.consume_amount ?? row.grant_amount;
      const amount = Number(evaluateFormula(amountRaw, resolver, 0)) || 0;
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
    // open_action_menu options are player choices — affordability of
    // each option is checked when chosen, not aggregated up here.
    // grant / apply_ae / remove_tagged_ae / etc.: not a gate on the
    // reactor; no-op.
  }
  walk(startLabel);

  out.ok = true;
  out.debit = debit;
  out.chargeDebit = chargeDebit;

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
// Kinds:
//   "passive" → row has reaction_isPassive === true. Dispatcher fires
//               automatically per mode tri-state above.
//   "manual"  → row has reaction_isPassive === false / undefined. ALWAYS
//               requires the player to click — no mode bypass. Surfaces
//               in the menu as an active blade; the caller is expected
//               to treat its mode as "ask" regardless of the row value.
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

// Default behavior (no opts) preserves the legacy pre-resolve pill flow:
// only passive rows are returned. Pass `includeManual: true` (used by
// the token-anchored reaction menu for standalone trigger sites where
// High Speed-style manual reactions also live) to surface manual rows
// alongside passives.
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

export async function findPassiveCandidates({ casterActor, trigger, payload, includeManual = false, includeUnavailable = false }) {
  if (!casterActor || !trigger) return [];
  const out = [];

  function classifyRow(row) {
    return row?.reaction_isPassive === true ? "passive" : "manual";
  }
  function shouldKeep(row) {
    if (!row || row.$deleted) return false;
    if (String(row.reaction_trigger ?? "").trim() !== trigger) return false;
    const isPassive = row.reaction_isPassive === true;
    if (!isPassive && !includeManual) return false;
    return true;
  }
  function modeFor(row, kind) {
    // Manual rows are always "ask" — the player has to click. Passive
    // rows respect the configured tri-state (on/ask/off).
    if (kind === "manual") return "ask";
    return resolveReactionPassiveMode(row);
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
      const kind = classifyRow(row);
      out.push({
        carrierKind: "item",
        carrierUuid: item.uuid,
        carrierName: item.name,
        carrierImg:  item.img,
        carrierDescription: item.system?.props?.description ?? "",
        rowKey: key,
        kind,
        mode: modeFor(row, kind),
        ref: refLabel,
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
      const kind = classifyRow(row);
      out.push({
        carrierKind: "ae",
        carrierUuid: ae.uuid,
        carrierName: ae.name,
        carrierImg:  ae.icon ?? ae.img,
        carrierDescription: ae.description ?? "",
        rowKey: key,
        kind,
        mode: modeFor(row, kind),
        ref: refLabel,
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
  });
  const r = await applyEffectByLabel(candidate.ref, ctx);

  // ── AE post-fire bookkeeping ─────────────────────────────────────────
  // Moved here from firePassiveTriggers so EVERY dispatch path (standalone
  // ReactionMenu, post-resolve firePassiveTriggers, pre-resolve pill accept)
  // honors consume_self / charges semantics. Two signals supported:
  //   - row.consume_self === true       → unconditional delete after fire
  //   - effRow.consume_self === true    → effect-row-driven delete
  //   - AE carries charges flag         → decrement; auto-delete at 0
  if (candidate.carrierKind === "ae" && r?.ok && carrier) {
    try {
      const row = aeReactionCfg?.reaction_config_table?.[candidate.rowKey] ?? null;
      const effRow = candidate.ref
        ? Object.values(runtimeEffectTable ?? {}).find((er) => er?.effect_label === candidate.ref)
        : null;
      const consumeSelfFlag = row?.consume_self === true || effRow?.consume_self === true;
      const chargeFlags = carrier.flags?.[FLAG_NS] ?? {};
      const hasCharges = chargeFlags.charges != null || chargeFlags.chargesMax != null;
      if (consumeSelfFlag) {
        try {
          await carrier.delete();
          log(`firePreAcceptedCandidate: ${candidate.carrierName} consume_self → AE deleted`);
        } catch (e) { warn("consume_self delete failed", e); }
      } else if (hasCharges) {
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

// Phase 2: sender-side damage accumulator for pre-resolve add_damage
// candidates (Cheap Shot et al.).
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

    let amount = 0;
    try {
      const { buildSkillResolver, evaluateFormula } = await getSkillFormulas();
      const resolver = buildSkillResolver({
        actor: casterActor,
        payload: cand.payloadAtFire ?? null,
        skill: carrierSkill,
        round: dCombat?.round ?? 0,
      });
      const byLabel = new Map();
      for (const r of Object.values(runtimeEffectTable ?? {})) {
        if (!r || r.$deleted) continue;
        const lbl = String(r.effect_label ?? "").trim();
        if (lbl) byLabel.set(lbl, r);
      }
      const seen = new Set();
      function walkDamage(label) {
        if (!label || seen.has(label)) return;
        seen.add(label);
        const row = byLabel.get(label);
        if (!row) return;
        const kind = String(row.effect_kind ?? "").toLowerCase();
        if (kind === "add_damage") {
          amount += Number(evaluateFormula(String(row.damage_amount ?? "0"), resolver)) || 0;
        } else if (kind === "chain") {
          const steps = String(row.chain_steps ?? "").split(/[,\n]+/g).map((s) => s.trim()).filter(Boolean);
          for (const s of steps) walkDamage(s);
        }
      }
      walkDamage(cand.ref);
    } catch (e) {
      warn(`computeSenderDamageBonuses: damage_amount eval threw on ${cand.carrierName}`, e);
      amount = 0;
    }
    amount = Math.max(0, Math.floor(amount));
    if (amount <= 0) continue;

    for (const uuid of subjectUuids) {
      out.set(uuid, (out.get(uuid) ?? 0) + amount);
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
export function recomputePerTargetDamages(perTargetResults, bonusMap, applyAffinity) {
  if (!Array.isArray(perTargetResults) || !perTargetResults.length) return perTargetResults;
  if (!bonusMap || bonusMap.size === 0) return perTargetResults;
  if (typeof applyAffinity !== "function") {
    warn("recomputePerTargetDamages: applyAffinity not supplied; returning original");
    return perTargetResults;
  }
  return perTargetResults.map((entry) => {
    const bonus = bonusMap.get(entry?.actorUuid) ?? 0;
    if (bonus <= 0) return entry;
    if (!entry.hit) return entry;  // misses don't accumulate damage bonuses
    const newRaw = (Number(entry.rawDamage) || 0) + bonus;
    const newDamage = applyAffinity(newRaw, String(entry.affinity ?? "NE"));
    return {
      ...entry,
      rawDamage: newRaw,
      damage: newDamage,
      // Diagnostic — lets the action card show a "+X (Cheap Shot)" hint
      // and lets the RESOLVE log explain where the extra came from.
      bonusBreakdown: { baseBonus: bonus },
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
    // Post-resolve triggers only consider rows authored as `reaction_isPassive`.
    // Manual rows are surfaced through other UI (turn-UI / action card), so
    // explicitly opt out here to match the legacy firePassiveTriggers shape.
    includeManual: false,
    // No scope/scene — post-resolve trigger events are not persistent
    // across actions. Each new event prompts fresh; firedSet stays empty.
  });
  return { fired: Array.isArray(result?.fired) ? result.fired : [] };
}

// ── Legacy firePassiveTriggers body — retained as a comment for diff
//    clarity and as documentation of the previous structure. Safe to
//    delete in a follow-up cleanup pass once the migration has soaked.
async function _legacy_firePassiveTriggers_unused({ director, casterActor, trigger, payload, skipEvaluated }) {
  if (!casterActor || !trigger) return { fired: [] };
  const skipSet = new Set(
    (Array.isArray(skipEvaluated) ? skipEvaluated : [])
      .map((e) => `${e?.rowKey ?? ""}:${e?.carrierUuid ?? ""}`)
  );

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
      if (skipSet.has(`${key}:${item.uuid}`)) continue;
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
      if (skipSet.has(`${key}:${ae.uuid}`)) continue;
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
    // "force" mode is engine-mandatory — fires without prompt, same
    // path as "on", just doesn't surface to UI elsewhere. Falls
    // through to the dispatch below.
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
      // "on" and "force" are both auto-fired without GM prompt → treat
      // as passive for the targeting-auto-skip / prompt-bypass flow.
      isPassive: mode === "on" || mode === "force",
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
    case "consume_resource": return applyConsumeResourceEffect(row, ctx);
    case "roll_loot_table":  return applyRollLootTableEffect(row, ctx);
    // resolveAction-unification: built-in action commits expressed as effect
    // rows. Each wraps the proven bespoke function so behavior is identical,
    // just routed through the unified resolver.
    case "equip_swap":          return applyEquipSwapEffect(row, ctx);
    case "encyclopedia_record": return applyEncyclopediaRecordEffect(row, ctx);
    // add_damage is data-only — read by `computeSenderDamageBonuses`
    // which walks acceptedPrePassives BEFORE the standard fire loop and
    // accumulates per-target base-damage bonuses. By the time
    // firePreAcceptedCandidate routes this row through applyEffectRow,
    // the bonus is already accumulated and perTargetResults is already
    // recomputed; firing here is a no-op. Returning ok keeps the chain
    // log clean. See Phase 2/3 of the Cheap Shot integration plan.
    case "add_damage":
      return { ok: true, kind, applied: [], reason: "data-only" };
    case "redirect_target":
      // Data-only at chain-fire time. The target replacement happens in
      // card-mutations.js at the CONFIRM write site (before RESOLVE reads
      // ar.targets / ar.perTargetResults). Returning ok keeps the chain
      // running so downstream cost steps (consume_charge, consume_resource)
      // fire after the redirect is recorded as accepted —
      // [[consume-last-in-chain]].
      return { ok: true, kind, applied: [], reason: "applied-at-card-mutation-phase" };
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
    const cur = Number(actor.system?.props?.[def.prop] ?? 0) || 0;
    if (cur < amount) {
      log(`skill-effects.consume_resource: ${actor.name} has ${cur} ${resource}, needs ${amount}; ${onEmpty}`);
      if (onEmpty === "abort") {
        return { ok: false, kind: "consume_resource", reason: "insufficient", abort: true };
      }
      // Other behaviors (skip / warn) would continue here — kept minimal for ship.
      continue;
    }
    const result = await writeResourceDelta(actor, def, -amount);
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

  const applied = [];
  for (const token of tokens) {
    const actor = token.actor;
    if (!actor) continue;

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
    if (baseMode === "replace_same_status") {
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
      ...(lifetimeMode === "round_end" ? { lifetimeMode: "round_end" } : {}),
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
    const checkBonus  = Math.max(0, evaluateFormula(row.check_bonus_formula  ?? "", resolver, 0) || 0);
    const damageBonus = Math.max(0, evaluateFormula(row.damage_bonus_formula ?? "", resolver, 0) || 0);
    const sourceLabel = ctx.skill?.name ?? row.effect_label ?? "Free Action";
    freeActionQueue.enqueue({
      reactorActorId:   reactor.id,
      reactorActorUuid: reactor.uuid,
      reactorTokenUuid: ctx.reactorToken?.uuid ?? null,
      enabledLabels, checkBonus, damageBonus,
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

    // Independent per-row rolls — each row gets its own d100 check.
    // "(Empty)" + zero-pct rows are skipped silently. Items already
    // claimed by another caster (in claimedKeys) skip too.
    const won = [];
    const wonKeys = [];
    for (const rRow of rows) {
      const pct = Number(rRow.loot_percentage) || 0;
      if (pct <= 0) continue;
      const roll = Math.floor(Math.random() * 100) + 1;  // 1..100
      if (roll > pct) continue;
      const lootName = String(rRow.loot_id ?? "").trim();
      if (!lootName || lootName === "(Empty)") continue;
      const entry = Object.entries(lootMap).find(
        ([, e]) => String(e?.name ?? "").trim() === lootName
      );
      if (!entry) {
        log(`roll_loot_table: ${target.name}.${chanceProp} references "${lootName}" but ${lootProp} has no entry`);
        continue;
      }
      const [lootKey, lootEntry] = entry;
      if (claimedKeys.has(lootKey)) {
        log(`roll_loot_table: "${lootName}" already claimed on ${target.name} — skipping`);
        continue;
      }

      // Resolve the source item — prefer world Item via
      // system.uniqueId / compendiumSource (matches legacy Study macro's
      // `resolveStealItemOpenUuid`). Falls back to the embedded item.
      const sourceItem = await resolveStealSourceItem(lootEntry);
      if (!sourceItem) {
        log(`roll_loot_table: no source resolvable for ${lootName}; skipping transfer`);
        continue;
      }

      // Stack consumables/materials; create fresh embedded copy for
      // equipment. The stacking key is `system.uniqueId` — same-uniqueId
      // items already on the caster are treated as the same stack and
      // their item_quantity is incremented.
      const transferred = await transferLootToCaster(caster, sourceItem);
      if (!transferred) continue;

      wonKeys.push(lootKey);
      won.push({
        name: lootName,
        img: sourceItem.img ?? null,
        desc: String(lootEntry.loot_description ?? ""),
        sourceItem,
        stacked: transferred.stacked,
        rolled: roll,
        chance: pct,
      });
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
