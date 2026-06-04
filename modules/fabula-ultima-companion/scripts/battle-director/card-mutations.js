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
      return doc?.flags?.[FLAG_NS]?.reactionConfig?.effect_table ?? null;
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
export async function applyAcceptedCardMutations(arSnapshot, acceptedPrePassives) {
  const targets = Array.isArray(arSnapshot.targets) ? [...arSnapshot.targets] : [];
  const perTargets = Array.isArray(arSnapshot.perTargetResults) ? [...arSnapshot.perTargetResults] : [];
  const ctx = { ar: arSnapshot, targets, perTargets };
  let mutationsApplied = 0;
  let cancelled = false;

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

  return {
    targets: ctx.targets,
    perTargetResults: ctx.perTargets,
    mutationsApplied,
    cancelled,
  };
}
