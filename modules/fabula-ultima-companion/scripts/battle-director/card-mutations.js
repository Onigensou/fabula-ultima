// scripts/battle-director/card-mutations.js
//
// In-flight action mutations driven by accepted pre-resolve reactions.
// Centralizes the "what changes when a third-party reaction is applied"
// logic so:
//   1. CONFIRM-stage write site mutates ar.targets / ar.perTargetResults
//      before RESOLVE applies damage. Damage lands on the redirected
//      target.
//   2. Action-card recompute hook reads the same mutations and patches
//      the per-target row DOM at Apply-click time so the player sees
//      the redirect before they confirm.
//
// First effect_kind handled: `redirect_target`. The structure is
// deliberately extensible — future card-mutation kinds (change-element,
// replace-damage, free-add-modifier, etc.) drop in as additional cases
// in `applyOneRow`. Order across kinds is intentional: redirect runs
// FIRST so the target identity is final before damage / element steps
// recompute against it.
//
// Why not run the reaction's effect_table directly? Two reasons:
//   - The legacy `redirect_target` handler in reaction-system/reaction-
//     grant.js targets Foundry ChatMessage cards via the `oni.Reaction
//     RedirectPendingAction` helper. BD action cards are DOM overlays
//     with their data in `director.ctx.actionResult` — different
//     surface, different mutation strategy.
//   - Authors specify the EFFECT (redirect_target) in the skill's
//     effect_table; the BD engine decides WHEN and HOW to apply the
//     in-card mutation. Centralizing it here keeps the per-skill
//     effect rows declarative.
//
// Author contract (effect_kind: "redirect_target"):
//   target_ref       — kept for forward-compat; currently unused (the
//                      subject slot is derived from the candidate's
//                      `subjectActorUuid` which the third-party
//                      dispatcher already stamped).
//   destination_ref  — kept for forward-compat; currently fixed to
//                      "self" (the reactor's actor). Future variants
//                      could redirect to a chosen ally.

import { log, warn } from "./logger.js";
import { resolveTargetRef as resolveBdTargetRef, makeChainContext as makeBdChainContext } from "./skill-targeting.js";

const FLAG_NS = "fabula-ultima-companion";

// Look up the effect_table associated with a pre-pass candidate.
// `carrierKind: "item"` → item.system.props.effect_table.
// `carrierKind: "ae"`   → ae.flags[FLAG_NS].reactionConfig.effect_table.
async function readEffectTableForCandidate(cand) {
  if (!cand?.carrierUuid) return null;
  try {
    const doc = await fromUuid(cand.carrierUuid);
    if (!doc) return null;
    if (cand.carrierKind === "ae") {
      // AE reactionConfigs use the legacy key `reaction_effect_table` (see
      // Acceleration et al.); newer ones may use `effect_table`. Accept both,
      // mirroring firePreAcceptedCandidate's fallback.
      const rc = doc?.flags?.[FLAG_NS]?.reactionConfig;
      return rc?.effect_table ?? rc?.reaction_effect_table ?? null;
    }
    // item carrier (default)
    return doc?.system?.props?.effect_table ?? null;
  } catch (e) {
    warn("card-mutations: readEffectTableForCandidate threw", e);
    return null;
  }
}

// Walk the chain reachable from the candidate's effect_ref. A `chain`
// row expands into its `chain_steps`; everything else is a leaf. Mirrors
// the recursive walk in skill-effects.applyChainEffect but reads-only.
function expandEffectChain(effectTable, startLabel) {
  const out = [];
  const byLabel = new Map();
  for (const r of Object.values(effectTable ?? {})) {
    if (!r || r.$deleted) continue;
    const lbl = String(r.effect_label ?? "").trim();
    if (lbl) byLabel.set(lbl, r);
  }
  const seen = new Set();
  (function walk(label) {
    if (!label || seen.has(label)) return;
    seen.add(label);
    const row = byLabel.get(label);
    if (!row) return;
    const kind = String(row.effect_kind ?? "").trim().toLowerCase();
    if (kind === "chain") {
      const steps = String(row.chain_steps ?? "")
        .split(/[,\n]+/g).map((s) => s.trim()).filter(Boolean);
      for (const s of steps) walk(s);
      return;
    }
    out.push(row);
  })(startLabel);
  return out;
}

// Map damage element names → affinity slot index on PC/NPC templates.
// PC v3 + NPC v.2 templates store affinities as `affinity_1` (Physical)
// through `affinity_9` (Poison). Mirrors the order used by every other
// engine site that reads element-based affinities.
const ELEMENT_TO_AFFINITY_SLOT = {
  physical: 1,
  air:      2,
  bolt:     3,
  dark:     4,
  earth:    5,
  fire:     6,
  ice:      7,
  light:    8,
  poison:   9,
};

// Recompute hit + damage for a new target slot, using the action's
// existing roll context. Mirrors the Attack DECLARE branch's per-target
// math (state-handlers.js ~line 2566). Spells / skills with isCheck=false
// don't have a defense check; their hit defaults to true.
function recomputePerTargetForRedirect({ ar, reactor, reactorTok, applyAffinityToDamage }) {
  // Defense prop: CSB stores the final derived `defense` (and
  // `magic_defense`). Spells + MDEF-tagged Skills target MDEF; others
  // target DEF.
  const props = reactor.system?.props ?? {};
  const isMagicCheck =
    String(ar.kind ?? "").toLowerCase() === "spell" ||
    String(ar.skillType ?? "").toLowerCase() === "spell" ||
    String(ar.defenseTargetType ?? "").toLowerCase() === "mdef";
  const newDef = Number(
    isMagicCheck
      ? (props.magic_defense ?? props.base_magic_defense ?? 10)
      : (props.defense ?? props.base_defense ?? 10)
  );

  const total = Number(ar.roll?.total ?? 0);
  const isFumble = !!ar.roll?.isFumble;
  const isCrit   = !!ar.roll?.isCrit;
  const hasRoll  = ar.roll && typeof ar.roll?.total === "number";

  // For unchecked actions (heals, status-only) the redirect doesn't
  // re-roll — keep hit=true (the original would-be effect lands on
  // the reactor).
  const newHit = !hasRoll
    ? true
    : isCrit ? true : (!isFumble && total >= newDef);

  const elementKey = String(ar.damage?.element ?? "Physical").toLowerCase();
  const slot = ELEMENT_TO_AFFINITY_SLOT[elementKey];
  const rawAff = slot ? String(props[`affinity_${slot}`] ?? "NA") : "NA";
  // CSB stores "NA" for "no special affinity"; the rest of the engine
  // reads "NE" (Neutral). Normalize.
  const affinityCode = (rawAff === "NA" || rawAff === "" || rawAff == null) ? "NE" : rawAff;

  const damageBonus = Number(ar.damage?.base ?? 0);
  const ignoreHR   = !!ar.damage?.ignoreHR;
  const hr = isCrit
    ? Math.max(0, total - Number(ar.roll?.checkBonus ?? 0))
    : (ignoreHR ? 0 : Math.max(0, total - newDef));
  const rawDamage = newHit ? (hr + damageBonus) : 0;
  const finalDamage = newHit ? applyAffinityToDamage(rawDamage, affinityCode) : 0;

  return {
    tokenUuid: reactorTok.uuid,
    actorUuid: reactor.uuid,
    name: reactor.name,
    tokenImg: reactorTok.texture?.src ?? reactor.img,
    disposition: reactorTok.disposition,
    defense: newDef,
    hit: newHit,
    crit: isCrit && newHit,
    rawDamage,
    damage: finalDamage,
    affinity: affinityCode,
    studied: false,
  };
}

// Resolve the redirect's "source slots" — which targets on the action
// card get moved to the reactor. Reads `target_ref` from the redirect_target
// row, looks up the corresponding targeting row on the carrier item, and
// runs it through the **BD-native** resolver (`skill-targeting.js`).
// The resolver honors:
//   - auto_confirm_when_obvious (1 valid candidate → auto-pick)
//   - exclude_self (the reactor isn't a valid source slot for themselves)
//   - **BD-native target picker** prompt when multiple candidates match
//     and `mode: "exact"` with a count constraint (same UI as Attack's
//     TARGET state). `mode: "all"` resolves to every matching target
//     automatically without a picker — Prophetic Defender's "take the
//     place of all threatened allies" rides on this.
// Returns an ARRAY of actor uuids:
//   - Protect's single-target targeting row → [oneActorUuid]
//   - Prophetic Defender's mode:"all" targeting row → [...allUuids]
// Results are cached on the candidate (`pickedSubjectActorUuids`) so a
// re-recompute (e.g. another pill toggled afterwards) doesn't re-prompt.
// The legacy single-uuid cache (`pickedSubjectActorUuid`) is preserved
// for snapshotReactionDecisions round-trip when N === 1.
async function resolveRedirectSubjects({ cand, row, reactor, reactorTok, ctx }) {
  if (Array.isArray(cand.pickedSubjectActorUuids) && cand.pickedSubjectActorUuids.length) {
    return cand.pickedSubjectActorUuids;
  }
  if (cand.pickedSubjectActorUuid) {
    // Backwards-compat: prior session cached a single-target pick.
    return [cand.pickedSubjectActorUuid];
  }
  const targetRef = String(row?.target_ref ?? "").trim();
  if (!targetRef) {
    warn(`redirect: row "${row?.effect_label}" missing target_ref; falling back to scan-time subject`);
    return cand.subjectActorUuid ? [cand.subjectActorUuid] : [];
  }
  const item = await fromUuid(cand.carrierUuid);
  if (!item) {
    warn(`redirect: cannot resolve carrier item ${cand.carrierUuid}; falling back`);
    return cand.subjectActorUuid ? [cand.subjectActorUuid] : [];
  }
  // Build a BD-native chain ctx. `action_targets` candidate_source reads
  // ctx.actionTargetUuids; we feed the action's full target list from
  // arSnapshot. isPassive:false → the resolver prompts when multiple
  // valid candidates exist and mode requires a pick. `skill` carries the
  // carrier item so the picker title can show the skill name.
  const allTargetTokenUuids = (ctx.ar?.targets ?? [])
    .map((t) => t?.tokenUuid)
    .filter(Boolean);
  const chainCtx = makeBdChainContext({
    reactorActor: reactor,
    reactorToken: reactorTok,
    skill: item,
    actionTargetUuids: allTargetTokenUuids,
    payload: {
      targetTokenUuids: allTargetTokenUuids,
      sourceActorUuid: ctx.ar?.attackerActorRef ?? null,
    },
    isPassive: false,
  });
  const resolved = await resolveBdTargetRef(targetRef, chainCtx);
  if (!resolved?.ok || !resolved.tokens?.length) {
    if (resolved?.cancelled) {
      log(`redirect: player cancelled target pick for ${cand.carrierName}`);
      cand._pickerCancelled = true;
      return [];
    }
    warn(`redirect: BD target resolver failed (${resolved?.reason}); falling back to scan-time subject`);
    return cand.subjectActorUuid ? [cand.subjectActorUuid] : [];
  }
  const pickedUuids = resolved.tokens
    .map((t) => t?.actor?.uuid)
    .filter(Boolean);
  if (!pickedUuids.length) {
    warn(`redirect: resolver returned tokens with no actor uuids`);
    return cand.subjectActorUuid ? [cand.subjectActorUuid] : [];
  }
  // Cache so the next recompute pass doesn't re-prompt. Mirror the
  // single-uuid field when N === 1 so snapshotReactionDecisions'
  // existing round-trip continues to work for Protect.
  cand.pickedSubjectActorUuids = pickedUuids;
  if (pickedUuids.length === 1) cand.pickedSubjectActorUuid = pickedUuids[0];
  return pickedUuids;
}

// Apply a single redirect_target mutation to ctx. The "source slot" is
// resolved via the BD-native effect-targeting resolver (auto-confirm
// when 1 valid candidate, BD picker prompt otherwise — see
// `resolvePickedSubject`). The "destination" is the reactor's actor
// (Protect's canonical "you take their place" semantic). Future
// variants with destination_ref pointing elsewhere can extend here.
//
// Returns:
//   "applied"   — mutation landed
//   "cancelled" — player cancelled the target picker (caller should
//                 revert the provisional pill decision)
//   "failed"    — hard failure (missing data, no token, etc.)
async function applyRedirectTargetMutation(ctx, cand, row) {
  const reactorUuid = cand.reactorActorUuid;
  if (!reactorUuid) {
    warn(`redirect: missing reactor on candidate`);
    return "failed";
  }
  const reactor = await fromUuid(reactorUuid);
  if (!reactor) {
    warn(`redirect: reactor actor ${reactorUuid} not resolvable`);
    return "failed";
  }
  const reactorTok = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === reactor.uuid)?.document
    ?? reactor?.getActiveTokens?.()?.[0]?.document
    ?? null;
  if (!reactorTok) {
    warn(`redirect: no token for reactor ${reactor.name}`);
    return "failed";
  }

  // INVERTED redirect (destination_ref present): the REACTOR is the SOURCE slot
  // (the deciding target), and the action moves to a CHOSEN DESTINATION resolved
  // via destination_ref — e.g. Condemn/Torment's "you may pass this to an ally"
  // (target-owned reaction, reactor = the target). This is the mirror of the
  // default Protect direction (source = target_ref, destination = reactor). The
  // destination targeting row picks relative to the reactor (category "ally",
  // exclude_self), so it offers the target's own allies.
  const destRef = String(row?.destination_ref ?? "").trim();
  if (destRef && destRef.toLowerCase() !== "self") {
    const srcIdx = ctx.targets.findIndex((t) => t?.actorUuid === reactorUuid);
    if (srcIdx === -1) {
      warn(`redirect(dest): reactor ${reactor.name} not in target list — nothing to redirect`);
      return "failed";
    }
    const carrier = await fromUuid(cand.carrierUuid).catch(() => null);
    // Cache the destination pick so a re-recompute pass doesn't re-prompt.
    let destActorUuid = cand.pickedDestActorUuid ?? null;
    let destTokDoc = null;
    if (!destActorUuid) {
      const chainCtx = makeBdChainContext({
        reactorActor: reactor,
        reactorToken: reactorTok,
        skill: carrier,
        actionTargetUuids: (ctx.ar?.targets ?? []).map((t) => t?.tokenUuid).filter(Boolean),
        payload: { sourceActorUuid: ctx.ar?.attackerActorRef ?? null },
        isPassive: false,   // a real choice — prompt for the ally pick
      });
      const resolved = await resolveBdTargetRef(destRef, chainCtx);
      if (resolved?.cancelled) { cand._pickerCancelled = true; return "cancelled"; }
      const destTok = resolved?.tokens?.[0];
      if (!resolved?.ok || !destTok?.actor) {
        log(`redirect(dest): no destination for ${cand.carrierName} (${resolved?.reason ?? "empty"})`);
        return "failed";
      }
      destActorUuid = destTok.actor.uuid;
      destTokDoc = destTok.document ?? destTok;
      cand.pickedDestActorUuid = destActorUuid;
    }
    const destActor = await fromUuid(destActorUuid).catch(() => null);
    if (!destTokDoc) {
      destTokDoc = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === destActorUuid)?.document
        ?? destActor?.getActiveTokens?.()?.[0]?.document ?? null;
    }
    if (!destActor || !destTokDoc) { warn(`redirect(dest): destination actor/token unresolved`); return "failed"; }
    const { applyAffinityToDamage } = await import("./snapshot.js");
    const originalName = ctx.targets[srcIdx]?.name ?? "?";
    const per = recomputePerTargetForRedirect({ ar: ctx.ar, reactor: destActor, reactorTok: destTokDoc, applyAffinityToDamage });
    per.redirectedFrom = { actorUuid: reactorUuid, name: originalName, via: cand.carrierName ?? "redirect", reactorName: destActor.name };
    ctx.targets[srcIdx] = {
      actorUuid: destActor.uuid,
      tokenUuid: destTokDoc.uuid,
      name: destActor.name,
      tokenImg: destTokDoc.texture?.src ?? destActor.img,
      disposition: destTokDoc.disposition,
      defense: per.defense,
      redirectedFrom: { actorUuid: reactorUuid, name: originalName, via: cand.carrierName ?? "redirect" },
    };
    ctx.perTargets[srcIdx] = per;
    log(`redirect(dest): slot ${srcIdx} ${originalName} → ${destActor.name} (chosen via ${cand.carrierName})`);
    return "applied";
  }

  // Distinguish cancel vs fall-through-fail by tagging the result with
  // a sentinel before resolveRedirectSubjects. Returns [] on player
  // cancel (paired with _pickerCancelled=true); array of uuids on
  // success / fail-fallback.
  cand._pickerCancelled = false;
  const subjectUuids = await resolveRedirectSubjects({ cand, row, reactor, reactorTok, ctx });
  if (cand._pickerCancelled) {
    return "cancelled";
  }
  if (!subjectUuids.length) {
    return "failed";
  }

  const { applyAffinityToDamage } = await import("./snapshot.js");

  // Iterate over each subject — Protect's single-target case swaps one
  // slot; Prophetic Defender's multi-target case ("take the place of
  // all those allies") swaps every matching slot, so the damage
  // pipeline applies the action once per original target against the
  // reactor's stats.
  let touchedSlots = 0;
  for (const subjectUuid of subjectUuids) {
    const idx = ctx.targets.findIndex((t) => t?.actorUuid === subjectUuid);
    if (idx === -1) {
      warn(`redirect: picked subject ${subjectUuid} not found in ar.targets — skipping slot`);
      continue;
    }
    const originalName = ctx.targets[idx]?.name ?? "?";

    // Per-slot recompute. The reactor's defense/affinity is identical
    // across slots, so the same shape applies; the redirectedFrom
    // annotation differs per slot so the card-renderer can show "via
    // PD, originally targeting Hina" etc. per row.
    const perTargetForSlot = recomputePerTargetForRedirect({
      ar: ctx.ar, reactor, reactorTok, applyAffinityToDamage,
    });
    perTargetForSlot.redirectedFrom = {
      actorUuid: subjectUuid,
      name: originalName,
      via: cand.carrierName ?? "redirect",
      reactorName: reactor.name,
    };

    ctx.targets[idx] = {
      actorUuid: reactor.uuid,
      tokenUuid: reactorTok.uuid,
      name: reactor.name,
      tokenImg: reactorTok.texture?.src ?? reactor.img,
      disposition: reactorTok.disposition,
      defense: perTargetForSlot.defense,
      redirectedFrom: { actorUuid: subjectUuid, name: originalName, via: cand.carrierName ?? "redirect" },
    };
    ctx.perTargets[idx] = perTargetForSlot;
    touchedSlots += 1;
    log(`redirect: slot ${idx} ${originalName} → ${reactor.name} (via ${cand.carrierName})`);
  }

  if (touchedSlots === 0) {
    warn(`redirect: no matching slots found for picked subjects [${subjectUuids.join(", ")}]`);
    return "failed";
  }
  return "applied";
}

// ── Accuracy adjustment (effect_kind: "adjust_accuracy") ─────────────────
// Action-level mutation: rewrite the in-flight Accuracy Check total, then
// recompute every target's hit/miss against the new total. The accuracy
// equivalent of `adjust_damage`, but action-scoped (one roll) rather than
// per-target. Crossfire `set`s it to 0 so a ranged attack "fails
// automatically against all targets".
//   { effect_kind: "adjust_accuracy",
//     accuracy_operation: "set" | "add" | "subtract",   // default "set"
//     accuracy_amount:    <number | formula> }          // the operand
const ACCURACY_OPS = new Set(["set", "add", "subtract"]);
function applyAccuracyOp(total, op, amount) {
  switch (op) {
    case "add":      return total + amount;
    case "subtract": return total - amount;
    case "set":      return amount;
    default:         return total;
  }
}

// Override the action's Accuracy total and recompute hit/miss for every
// existing target against its own defense. Damage is only re-derived on the
// MISS side (zeroed) — Crossfire's `set 0` makes everything miss, which is the
// only operation in use today. (A future `add`/positive that flips a miss to a
// hit would need full HR/damage recompute; left out until a skill needs it.)
// Records `ctx.accuracyOverride` so the caller + card UI can show "Blocked".
async function applyAdjustAccuracyMutation(ctx, cand, row) {
  const op = String(row.accuracy_operation ?? "set").trim().toLowerCase();
  if (!ACCURACY_OPS.has(op)) {
    warn(`adjust_accuracy: unknown accuracy_operation "${op}" — skipping`);
    return "failed";
  }
  const amountFormula = String(row.accuracy_amount ?? "0");

  // Resolve the operand. A bare number short-circuits; otherwise evaluate the
  // formula against the reactor + the candidate's fire-time payload (so e.g.
  // SL / payload-derived values work).
  let amount = Number(amountFormula);
  if (!Number.isFinite(amount)) {
    try {
      const reactor = cand?.reactorActorUuid
        ? await fromUuid(cand.reactorActorUuid).catch(() => null)
        : null;
      const { buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");
      const resolver = buildSkillResolver({
        actor: reactor,
        payload: cand?.payloadAtFire ?? null,
        skill: null,
        round: ctx.ar?.round ?? 0,
      });
      amount = Number(evaluateFormula(amountFormula, resolver)) || 0;
    } catch (e) {
      warn("adjust_accuracy: formula eval threw — treating amount as 0", e);
      amount = 0;
    }
  }

  const oldTotal = Number(ctx.ar?.roll?.total ?? 0);
  const newTotal = applyAccuracyOp(oldTotal, op, amount);
  const isCrit = !!ctx.ar?.roll?.isCrit;
  const isFumble = !!ctx.ar?.roll?.isFumble;

  for (let i = 0; i < ctx.perTargets.length; i++) {
    const pt = ctx.perTargets[i];
    if (!pt) continue;
    const def = Number(pt.defense ?? 10);
    // Crit always hits, fumble always misses; otherwise compare the new total
    // to this target's defense. (Crossfire's condition gate already excludes
    // crits, but keep the rule here so the primitive is self-consistent.)
    const newHit = isCrit ? true : (!isFumble && newTotal >= def);
    ctx.perTargets[i] = {
      ...pt,
      hit: newHit,
      crit: isCrit && newHit,
      rawDamage: newHit ? pt.rawDamage : 0,
      damage: newHit ? pt.damage : 0,
      accuracyBlocked: !newHit,
    };
  }

  ctx.accuracyOverride = {
    from: oldTotal,
    to: newTotal,
    blocked: newTotal <= 0,
    via: cand?.carrierName ?? cand?.reactorActorName ?? "reaction",
    reactorName: cand?.reactorActorName ?? null,
  };
  log(`adjust_accuracy: ${op} ${amount} — total ${oldTotal} → ${newTotal} (via ${ctx.accuracyOverride.via})`);
  return "applied";
}

// Phase dispatch — orchestrates accepted card-mutations against an
// action's targets / perTargetResults. Returns NEW arrays (caller
// re-freezes ar with them) and a count for diagnostics.
//
// Ordering:
//   1. redirect_target — rewrites target identity
//   2. (future) change_damage_element / replace_damage / etc.
//   3. (future) add_damage handled separately via computeSenderDamageBonuses
//      so element / damage adjustments compose with Cheap Shot-style
//      bonuses computed against the (possibly redirected) target.
// ── Add target (effect_kind: "add_target", card-mutation path) ───────────
// Grappled "shared space" splash (rule #1): the grappler's "Grappling" AE
// hosts a creature_targeted_by_action reaction whose add_target row resolves
// `grappled_by_self` and APPENDS the grappled victim(s) to the action. They
// share the attacker's already-locked roll, each recomputed against its own
// defense/affinity (same per-target math as a redirect). The collector
// excludes the attacker, so a grappled unit attacking its own grappler doesn't
// splash onto itself. See [[project_grappled_advanced_debuff]].
//
// NOTE: distinct from Barrage's add_target, which is an ATTACKER-side
// (creature_performs_action) reaction committed at Apply-click via
// onAddTargetApply + the _preRoll sink — those candidates are tagged
// `_addTarget` and excluded from the card-mutation `applied` list, so they
// never reach here. This path handles TARGET-side add_target only.
async function applyAddTargetMutation(ctx, cand, row, effectTable) {
  const reactorUuid = cand.reactorActorUuid;
  if (!reactorUuid) { warn("add_target: missing reactor on candidate"); return "failed"; }
  const reactor = await fromUuid(reactorUuid);
  if (!reactor) { warn(`add_target: reactor ${reactorUuid} not resolvable`); return "failed"; }

  // target_ref may be a labelled targeting row OR an inline object (sugar).
  // For an AE-carried reaction the labelled row lives in the AE's effect_table
  // (flags.reactionConfig.effect_table), NOT system.props — pass it as
  // runtimeEffectTable so the resolver can find a string label.
  const rawRef = row?.target_ref;
  const isObjRef = !!rawRef && typeof rawRef === "object";
  const targetRef = isObjRef ? rawRef : String(rawRef ?? "").trim();
  if (!isObjRef && !targetRef) { warn(`add_target: row "${row?.effect_label}" missing target_ref`); return "failed"; }

  // The grappler's EXACT token = the slot being attacked (precise for unlinked
  // NPC tokens that share a base actor); fall back to a canvas lookup.
  const slot = ctx.targets.find((t) => t?.actorUuid === reactorUuid);
  const reactorTok = (slot?.tokenUuid ? await fromUuid(slot.tokenUuid).catch(() => null) : null)
    ?? canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === reactor.uuid)?.document
    ?? reactor?.getActiveTokens?.()?.[0]?.document
    ?? null;

  // Feed the attacker into the payload so candidate_source "grappled_by_self"
  // can drop a victim who IS the attacker (the spec's "someone OTHER than the
  // grappled unit" clause).
  const attackerActorUuid = ctx.ar?.attackerActorRef ?? ctx.ar?.attacker?.actorUuid ?? null;
  const attackerTokenUuid = ctx.ar?.attacker?.tokenUuid ?? null;
  const carrier = await fromUuid(cand.carrierUuid).catch(() => null);
  const chainCtx = makeBdChainContext({
    reactorActor: reactor,
    reactorToken: reactorTok,
    skill: carrier,
    runtimeEffectTable: effectTable ?? null,
    payload: { attackerActorUuid, attackerTokenUuid },
    isPassive: true,
  });
  const resolved = await resolveBdTargetRef(targetRef, chainCtx);
  const tokens = resolved?.tokens ?? [];
  if (!resolved?.ok || !tokens.length) {
    log(`add_target: no extra targets for ${cand.carrierName ?? "?"} (${resolved?.reason ?? "empty"})`);
    return "failed";
  }

  const { applyAffinityToDamage } = await import("./snapshot.js");
  let added = 0;
  for (const tok of tokens) {
    const victim = tok?.actor;
    if (!victim) continue;
    // Dedup — skip a victim already in the target list (incl. the original).
    if (ctx.targets.some((t) => t?.tokenUuid === tok.uuid || t?.actorUuid === victim.uuid)) continue;
    const per = recomputePerTargetForRedirect({ ar: ctx.ar, reactor: victim, reactorTok: tok, applyAffinityToDamage });
    const addedVia = { via: cand.carrierName ?? "Grappling", reactorName: reactor.name };
    per.addedVia = addedVia;
    ctx.targets.push({
      actorUuid: victim.uuid,
      tokenUuid: tok.uuid,
      name: victim.name,
      tokenImg: tok.texture?.src ?? victim.img,
      disposition: tok.disposition,
      defense: per.defense,
      addedVia,
    });
    ctx.perTargets.push(per);
    added += 1;
    log(`add_target: +${victim.name} splashed in (via ${cand.carrierName ?? "Grappling"})`);
  }
  return added ? "applied" : "failed";
}

// Shared add_target dispatch — append every accepted candidate's add_target
// victims into ctx (targets + perTargets). Returns the count applied. Used by
// both the full card-mutation pipeline (post-confirm) and applyAddTargetSplices
// (the pre-card pre-splice for FORCE add_target, so the card shows the victim).
async function runAddTargetPhase(ctx, cands) {
  let count = 0;
  for (const cand of cands ?? []) {
    if (!cand?.reactorActorUuid) continue;
    const effectTable = await readEffectTableForCandidate(cand);
    if (!effectTable) continue;
    const rows = expandEffectChain(effectTable, cand.ref);
    for (const row of rows) {
      const kind = String(row.effect_kind ?? "").trim().toLowerCase();
      if (kind === "add_target") {
        const result = await applyAddTargetMutation(ctx, cand, row, effectTable);
        if (result === "applied") count += 1;
      }
    }
  }
  return count;
}

// Pre-card splice for FORCE add_target reactions (the Grappled shared-space
// splash). CONFIRM calls this BEFORE postActionCard so the spliced victim(s)
// render as normal target rows on the card. Idempotent vs the post-confirm
// pass: applyAddTargetMutation dedups against ctx.targets, so re-running over
// the same accepted candidates adds nothing. Returns
// { targets, perTargetResults, mutationsApplied }.
export async function applyAddTargetSplices(arSnapshot, cands) {
  const targets = Array.isArray(arSnapshot.targets) ? [...arSnapshot.targets] : [];
  const perTargets = Array.isArray(arSnapshot.perTargetResults) ? [...arSnapshot.perTargetResults] : [];
  const ctx = { ar: arSnapshot, targets, perTargets };
  const mutationsApplied = await runAddTargetPhase(ctx, cands);
  return { targets: ctx.targets, perTargetResults: ctx.perTargets, mutationsApplied };
}

export async function applyAcceptedCardMutations(arSnapshot, acceptedPrePassives) {
  const targets = Array.isArray(arSnapshot.targets) ? [...arSnapshot.targets] : [];
  const perTargets = Array.isArray(arSnapshot.perTargetResults) ? [...arSnapshot.perTargetResults] : [];
  const ctx = { ar: arSnapshot, targets, perTargets };
  let mutationsApplied = 0;
  let cancelled = false;

  // Phase 0: negate_action — a performer/self reaction (Shadow Possession's
  // Creeped block variant) nullifies the WHOLE action: no hit, no damage, no
  // effects, no reactions. Scans EVERY accepted candidate (not just third-party
  // reactorActorUuid ones — the negate reaction is the actor's OWN). When found,
  // mark `negated`, zero every per-target hit/damage, and set a Blocked accuracy
  // override for the card UI. RESOLVE honors `ar.negated` to skip the outcome +
  // effect/reaction firing. Short-circuits the other phases (they're moot).
  let negated = false;
  for (const cand of acceptedPrePassives ?? []) {
    const effectTable = await readEffectTableForCandidate(cand);
    if (!effectTable) continue;
    const rows = expandEffectChain(effectTable, cand.ref);
    if (rows.some((r) => String(r.effect_kind ?? "").trim().toLowerCase() === "negate_action")) {
      negated = true;
      break;
    }
  }
  if (negated) {
    ctx.negated = true;
    // Keep the REAL accuracy / damage / per-target results on the card — the UI
    // shows them dimmed with a red "Negated" overlay (NOT "Blocked"/zeroed). The
    // outcome is still fully nullified at RESOLVE via ar.negated, so these values
    // are display-only. No accuracyOverride (that drives the "Blocked" treatment).
    return {
      targets: ctx.targets,
      perTargetResults: ctx.perTargets,
      mutationsApplied: 1,
      cancelled: false,
      accuracyOverride: null,
      negated: true,
    };
  }

  // Phase 1: redirect_target (only third-party candidates produce these
  // today — `reactorActorUuid` is the discriminator). A cancelled
  // picker short-circuits the whole pipeline so the caller can revert
  // the provisional pill decision.
  for (const cand of acceptedPrePassives ?? []) {
    if (!cand?.reactorActorUuid) continue;
    const effectTable = await readEffectTableForCandidate(cand);
    if (!effectTable) continue;
    const rows = expandEffectChain(effectTable, cand.ref);
    for (const row of rows) {
      const kind = String(row.effect_kind ?? "").trim().toLowerCase();
      if (kind === "redirect_target") {
        const result = await applyRedirectTargetMutation(ctx, cand, row);
        if (result === "applied") mutationsApplied += 1;
        else if (result === "cancelled") { cancelled = true; break; }
      }
    }
    if (cancelled) break;
  }

  // Phase 2: adjust_accuracy (Crossfire). Action-level — overrides the roll
  // total and recomputes hit/miss for every target. Runs AFTER redirect so it
  // recomputes against the final target identities. Third-party only today
  // (`reactorActorUuid` discriminator), matching the existing card-mutation
  // candidates.
  for (const cand of acceptedPrePassives ?? []) {
    if (!cand?.reactorActorUuid) continue;
    const effectTable = await readEffectTableForCandidate(cand);
    if (!effectTable) continue;
    const rows = expandEffectChain(effectTable, cand.ref);
    for (const row of rows) {
      const kind = String(row.effect_kind ?? "").trim().toLowerCase();
      if (kind === "adjust_accuracy") {
        const result = await applyAdjustAccuracyMutation(ctx, cand, row);
        if (result === "applied") mutationsApplied += 1;
      }
    }
  }

  // Phase 3: add_target (Grappled "shared space" splash). Runs AFTER redirect
  // + accuracy so the appended victims reflect the final target identities and
  // the locked roll. The grappler's Grappling AE (self reaction on
  // creature_targeted_by_action) is the only producer today; Barrage's
  // attacker-side add_target is tagged `_addTarget` and excluded upstream.
  mutationsApplied += await runAddTargetPhase(ctx, acceptedPrePassives);

  return {
    targets: ctx.targets,
    perTargetResults: ctx.perTargets,
    mutationsApplied,
    cancelled,
    accuracyOverride: ctx.accuracyOverride ?? null,
    negated: false,
  };
}
