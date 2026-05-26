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
import { evaluateFormula, buildSkillResolver } from "./skill-formulas.js";
import { pickOption } from "./option-picker.js";
import { resolveTargetRef } from "./skill-targeting.js";
import { findAndConsume } from "./skill-charges.js";

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

// ── Mercy HP clamp ──────────────────────────────────────────────────────
//
// Spiritist Mercy applies an AE flagged `mercyActive` to one ally. If the
// target would be reduced to 0 HP, they instead end at exactly 1 HP and
// the AE is consumed. Call this helper from any damage-application path
// BEFORE writing `current_hp` — receives the raw damage and the target
// actor, returns the clamped final HP and a side-effect (delete the
// Mercy AE if it fires).
//
// Usage:
//   const { newHp, mercyFired } = await applyMercyClamp(targetActor, curHp, rawDamage);
//   await targetActor.update({ "system.props.current_hp": newHp });
//
// No-op pass-through when target has no `mercyActive` AE or when damage
// wouldn't kill them.
export async function applyMercyClamp(targetActor, curHp, rawDamage) {
  const fallback = { newHp: Math.max(0, curHp - rawDamage), mercyFired: false };
  if (!targetActor || rawDamage <= 0) return fallback;
  const wouldBeZeroOrLess = (curHp - rawDamage) <= 0;
  if (!wouldBeZeroOrLess) return fallback;
  // Find an active Mercy AE on the target.
  const mercyAe = Array.from(targetActor.effects ?? []).find((eff) => {
    if (eff.disabled) return false;
    return eff.flags?.[FLAG_NS]?.mercyActive === true;
  });
  if (!mercyAe) return fallback;
  try {
    await mercyAe.delete();
    log(`mercy: ${targetActor.name} clamped from ${curHp - rawDamage} to 1 HP and consumed Mercy AE`);
  } catch (e) { warn("applyMercyClamp: AE delete failed", e); }
  return { newHp: 1, mercyFired: true };
}

// ── Damage-type override ────────────────────────────────────────────────
//
// Generic helper used by the Attack damage-compute path: consults the
// actor's `system.props.override_damage_type` field (already declared
// in the Actor template's Miscellaneous panel) and returns the override
// element when set to a real damage type, otherwise the original
// element. Powers Soul Weapon today; any future skill that writes the
// same prop via an AE `changes` entry — mode 5 (OVERRIDE in this CSB
// build) — gets the same behaviour for free.
//
// Treats "None" / empty / null as "no override" so the sheet's default
// value passes through cleanly.
export function applyDamageTypeOverride(attackerActor, originalElement) {
  if (!attackerActor) return originalElement;
  const raw = String(attackerActor.system?.props?.override_damage_type ?? "").trim();
  if (!raw || raw.toLowerCase() === "none") return originalElement;
  return raw.toLowerCase();
}

// Legacy alias — kept so the prior import name in state-handlers.js still
// resolves until that import is updated.
export const applySoulWeaponElementOverride = applyDamageTypeOverride;

// ── Passive trigger layer ───────────────────────────────────────────────
//
// Some skills (skill_type === "Passive") fire automatically in response to
// pipeline events instead of being picked from the skill menu. They declare:
//
//   passive_trigger                   — string event name. Currently honored:
//                                       "spell_complete" (fires from
//                                       resolveSkillAction after a Spell
//                                       resolves on its targets).
//   passive_trigger_filter            — optional. "ally_targets",
//                                       "enemy_targets", or "self_only".
//                                       Only fires if the trigger payload
//                                       includes a target of that
//                                       disposition (vs caster). Default:
//                                       no filter — fires every time the
//                                       trigger event fires.
//   passive_condition_formula         — optional formula evaluated against
//                                       the caster. Must evaluate truthy
//                                       for the passive to fire.
//                                       Identifiers available: same as
//                                       on_activate formulas + the
//                                       HAS_ARCANE_WEAPON() helper.
//   on_passive_trigger_effect_ref     — effect_label to fire when the
//                                       passive matches. Resolves the
//                                       same way as on_activate_effect_ref.
//
// Passives that fire prompt the GM with a Yes/Skip dialog when the RAW
// uses "may" wording — controlled by the `passive_optional` flag on the
// skill. Default is `true` (RAW Spiritist passives are all "may").
//
// Fire ctx mirrors the action's chain ctx: reactorActor = the casting
// actor; actionTargetUuids = the action's target token UUIDs; payload
// carries the trigger event's data (e.g. spell uuid, target uuids).
async function shouldPassiveFire(skill, casterActor, payload) {
  const p = skill?.system?.props ?? {};
  // 1. Filter by trigger payload's target disposition (if filter set).
  const filter = String(p.passive_trigger_filter ?? "").trim().toLowerCase();
  if (filter && filter !== "any") {
    const casterToken = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === casterActor?.uuid)?.document
      ?? casterActor?.getActiveTokens?.()?.[0]?.document
      ?? null;
    const casterDisp = Number(casterToken?.disposition ?? 0);
    const targetUuids = Array.isArray(payload?.targetTokenUuids) ? payload.targetTokenUuids : [];
    let matched = false;
    for (const u of targetUuids) {
      try {
        const t = await fromUuid(u);
        if (!t) continue;
        const td = Number(t.disposition ?? 0);
        if (filter === "ally_targets" && (td === casterDisp || td === 0)) { matched = true; break; }
        if (filter === "enemy_targets" && casterDisp !== 0 && td === -casterDisp) { matched = true; break; }
        if (filter === "self_only" && t.actor?.uuid === casterActor?.uuid) { matched = true; break; }
      } catch (_) { /* skip resolution failures */ }
    }
    if (!matched) return false;
  }
  // 2. Optional condition formula.
  const condRaw = String(p.passive_condition_formula ?? "").trim();
  if (condRaw) {
    const { evaluateFormula: e, buildSkillResolver: b } = await import("./skill-formulas.js");
    const r = b({ actor: casterActor, payload, skill, round: 0 });
    const val = e(condRaw, r, 0);
    if (!val) return false;
  }
  return true;
}

// Optional GM confirmation for "may" passives. Returns true to proceed,
// false to skip. Falls back to true if no dialog renderer is wired (e.g.
// in headless test contexts).
async function promptPassiveOptin(skill, casterActor) {
  if (!ui?.notifications) return true;
  if (typeof Dialog !== "function") return true;
  return new Promise((resolve) => {
    new Dialog({
      title: `Passive: ${skill.name}`,
      content: `<p><strong>${casterActor?.name ?? "Caster"}</strong> may fire <strong>${skill.name}</strong>.</p>${skill.system?.props?.description ?? ""}<p><em>Apply this passive's effect now?</em></p>`,
      buttons: {
        apply: { label: "Apply", callback: () => resolve(true) },
        skip:  { label: "Skip",  callback: () => resolve(false) },
      },
      default: "apply",
      close: () => resolve(false),
    }).render(true);
  });
}

export async function firePassiveTriggers({ director, casterActor, trigger, payload }) {
  if (!casterActor || !trigger) return { fired: [] };
  const items = casterActor.items?.contents ?? [];
  const matched = items.filter((it) => {
    const p = it.system?.props ?? {};
    if (String(p.skill_type ?? "").toLowerCase() !== "passive") return false;
    if (String(p.passive_trigger ?? "").trim() !== trigger) return false;
    return true;
  });
  if (!matched.length) return { fired: [] };

  const fired = [];
  for (const skill of matched) {
    const p = skill.system?.props ?? {};
    if (!(await shouldPassiveFire(skill, casterActor, payload))) {
      log(`passive: ${skill.name} skipped (filter/condition mismatch)`);
      continue;
    }
    // "may" prompt — defaults to true unless the author sets passive_optional:false.
    const optional = p.passive_optional !== false;
    if (optional) {
      const ok = await promptPassiveOptin(skill, casterActor);
      if (!ok) { log(`passive: ${skill.name} declined by GM`); continue; }
    }
    const refLabel = String(p.on_passive_trigger_effect_ref ?? "").trim();
    if (!refLabel) { warn(`passive ${skill.name}: no on_passive_trigger_effect_ref`); continue; }
    // Build a passive-specific chain ctx — reactorActor + caster's token,
    // payload from the trigger, skill = the passive itself.
    const { makeChainContext } = await import("./skill-targeting.js");
    const { getRuntimeSkillView } = await import("./skill-recipes.js");
    const reactorToken = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === casterActor.uuid)?.document
      ?? casterActor?.getActiveTokens?.()?.[0]?.document
      ?? null;
    const view = getRuntimeSkillView(skill);
    const ctx = makeChainContext({
      reactorActor: casterActor,
      reactorToken,
      skill,
      dCombat: director?.dCombat ?? null,
      payload,
      actionTargetUuids: payload?.targetTokenUuids ?? [],
      hitActionTargetUuids: payload?.hitTargetTokenUuids ?? payload?.targetTokenUuids ?? [],
      isPassive: false,  // GM-prompted → behaves as user-driven; auto-firing passives can set true
      runtimeEffectTable: view.effect_table,
      firePoints: view.fire_points,
    });
    try {
      const r = await applyEffectByLabel(refLabel, ctx);
      fired.push({ skill: skill.name, ok: !!r.ok, kind: r.kind });
      log(`passive ${skill.name}: fired ref "${refLabel}" → ok=${!!r.ok}`);
    } catch (e) {
      warn(`passive ${skill.name}: applyEffectByLabel threw`, e);
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
  if (ctx.isPassive) {
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
