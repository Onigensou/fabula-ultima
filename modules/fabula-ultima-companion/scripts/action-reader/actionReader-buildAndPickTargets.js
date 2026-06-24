/* ========================================================================== *
 * ActionReader Build And Pick Targets
 * -------------------------------------------------------------------------- *
 * Module-compatible target builder and picker for the ActionReader pipeline.
 *
 * Suggested file path:
 *   scripts/action-reader/actionReader-buildAndPickTargets.js
 *
 * Purpose:
 *   1. Build legal target candidates from the current scene.
 *   2. Apply dynamic relation logic based on the performer's disposition.
 *   3. Use enmity-weighted randomization when a subset must be chosen.
 *   4. Store chosen targets in context.chosenTargets.
 *
 * Notes:
 *   - "Creature" is treated as opposing-side targets for this GM enemy AI flow.
 *   - "Exact X" requires at least X legal targets.
 *   - "Up to X" will choose the maximum legal count up to X.
 *
 * Usage:
 *   import {
 *     buildAndPickActionReaderTargets,
 *     registerActionReaderBuildAndPickTargets
 *   } from "./actionReader-buildAndPickTargets.js";
 * ========================================================================== */

import { ActionReaderCore as AR } from "./actionReader-core.js";
import { ActionReaderDebug as ARD } from "./actionReader-debug.js";

export const ACTION_READER_BUILD_AND_PICK_TARGETS_VERSION = "1.0.0";
export const ACTION_READER_BUILD_AND_PICK_TARGETS_STAGE = "BuildAndPickTargets";

function getModuleApiContainer(moduleId) {
  const module = game.modules.get(moduleId);
  if (!module) return null;

  module.api ??= {};
  module.api.ActionReader ??= {};
  return module.api.ActionReader;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function getPerformerTokenDocument(context) {
  return context?.performer?.tokenDocument ?? AR.getTokenDocument(context?.performer?.token) ?? null;
}

function getPerformerActor(context) {
  return context?.performer?.actor ?? context?.actorData?.actor ?? null;
}

function getPerformerDisposition(context) {
  return context?.performer?.disposition ?? AR.getTokenDisposition(getPerformerTokenDocument(context));
}

function getTargetRule(context) {
  return context?.targetRule ?? null;
}

function getScenePlaceableTokens() {
  return Array.from(canvas?.tokens?.placeables ?? []);
}

function normalizeSceneToken(tokenLike) {
  const token = tokenLike?.object ?? tokenLike ?? null;
  const tokenDocument = AR.getTokenDocument(token);
  const actor = AR.getTokenActor(token);

  if (!tokenDocument || !actor) return null;

  const disposition = AR.getTokenDisposition(tokenDocument);
  const hp = AR.getResourcePair(actor, AR.keys.hpCurrent, AR.keys.hpMax);
  const defenses = AR.getActorDefenses(actor);

  return {
    token: token ?? tokenDocument?.object ?? null,
    tokenDocument,
    actor,
    tokenId: tokenDocument.id ?? null,
    actorId: actor.id ?? null,
    tokenName: AR.getTokenName(token ?? tokenDocument),
    actorName: AR.getActorName(actor),
    disposition,
    side: AR.getDispositionSide(disposition),
    enmity: AR.getActorEnmity(actor, 100),
    // Targeting-intelligence fields (used by focus weighting)
    hpPercent: AR.toInteger(hp?.percent, 100),
    hpCurrent: AR.toInteger(hp?.current, 0),
    hpMax: AR.toInteger(hp?.max, 0),
    def: AR.toNumber(defenses?.def, 0),
    mdef: AR.toNumber(defenses?.mdef, 0),
    statusNames: AR.getEffectNames(actor).map(n => AR.normalizeText(n)).filter(Boolean),
    affinityMap: AR.getActorAffinityMap(actor),
    uuid: tokenDocument.uuid ?? actor.uuid ?? null
  };
}

function getCandidatePool(context, options = {}) {
  const explicitTokens = Array.isArray(options?.sceneTokens) ? options.sceneTokens : null;
  const rawTokens = explicitTokens ?? getScenePlaceableTokens();

  const normalized = rawTokens
    .map(normalizeSceneToken)
    .filter(Boolean);

  const seen = new Set();
  const deduped = [];

  for (const entry of normalized) {
    const key = entry.tokenId || entry.actorId || entry.uuid;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

function resolveRelationToPerformer(candidateDisposition, performerDisposition) {
  if (AR.isSameSide(candidateDisposition, performerDisposition)) return "ally";
  if (AR.isOpposingSide(candidateDisposition, performerDisposition)) return "enemy";

  const side = AR.getDispositionSide(candidateDisposition);
  if (side === AR.sideKeys.NEUTRAL) return "neutral";
  if (side === AR.sideKeys.SECRET) return "secret";

  return "other";
}

function decorateCandidate(entry, context) {
  const performerTokenDocument = getPerformerTokenDocument(context);
  const performerDisposition = getPerformerDisposition(context);

  const isSelf = Boolean(
    performerTokenDocument &&
    entry?.tokenId &&
    performerTokenDocument.id === entry.tokenId
  );

  const relationToPerformer = resolveRelationToPerformer(entry.disposition, performerDisposition);

  return {
    ...entry,
    isSelf,
    relationToPerformer,
    performerDisposition,
    performerSide: AR.getDispositionSide(performerDisposition)
  };
}

function buildDecoratedCandidates(context, options = {}) {
  return getCandidatePool(context, options).map(entry => decorateCandidate(entry, context));
}

function filterCandidatesByRule(context, candidates, targetRule, options = {}) {
  const relation = AR.toString(targetRule?.relation, "creature");
  const includeSelfInAlly = options?.includeSelfInAlly !== false;

  switch (relation) {
    case "self":
      return candidates.filter(candidate => candidate.isSelf);

    case "ally":
      return candidates.filter(candidate => {
        if (candidate.relationToPerformer !== "ally") return false;
        if (!includeSelfInAlly && candidate.isSelf) return false;
        return true;
      });

    case "enemy":
      return candidates.filter(candidate => candidate.relationToPerformer === "enemy");

    case "neutral":
      return candidates.filter(candidate => candidate.relationToPerformer === "neutral");

    case "secret":
      return candidates.filter(candidate => candidate.relationToPerformer === "secret");

    case "creature":
    default:
      // Per project rule: for this AI flow, "Creature" should fetch opposing-side targets.
      return candidates.filter(candidate => candidate.relationToPerformer === "enemy");
  }
}

/* -------------------------------------------------------------------------- */
/* Target focus (#2): affinity / HP / defense-aware weighting                 */
/* -------------------------------------------------------------------------- */

/*
 * Build the focus context from the chosen action:
 *   - damageType    ("fire", "ice", ...) from the item's type_damage
 *   - defenseTarget ("def" | "mdef")
 *   - focus mode    from the optional action_pattern_target_focus column on
 *                   the chosen pattern row ("" => "auto")
 */
function getFocusContext(context) {
  const chosen = context?.chosenAction ?? null;
  const props = chosen?.itemSnapshot?.props ?? chosen?.item?.system?.props ?? {};
  const focusRaw = AR.normalizeText(chosen?.row?.raw?.[AR.keys.actionPatternTargetFocusKey] ?? "");

  return {
    damageType: AR.normalizeDamageType(props?.[AR.keys.typeDamage]),
    defenseTarget: AR.getItemDefenseTarget(props),
    focus: focusRaw || "auto"
  };
}

function affinityMultiplier(candidate, damageType) {
  if (!damageType) return 1;
  const code = AR.toString(candidate?.affinityMap?.[damageType], "NA").toUpperCase();
  switch (code) {
    case "VU": return 2.0;   // vulnerable -> strongly prefer
    case "RS": return 0.5;   // resistant -> avoid
    case "IM": return 0.05;  // immune -> almost never
    case "AB": return 0.02;  // absorb (heals them) -> effectively never
    default: return 1.0;     // normal
  }
}

function hpBias(candidate, kind) {
  const pct = AR.clamp(AR.toNumber(candidate?.hpPercent, 100), 0, 100) / 100;
  switch (kind) {
    case "low": return 0.2 + (1 - pct) * 1.8;   // 0.2 .. 2.0, favor wounded
    case "high": return 0.2 + pct * 1.8;        // favor healthy
    case "mildLow": return 0.8 + (1 - pct) * 0.6; // 0.8 .. 1.4, gentle finish bias
    default: return 1;
  }
}

function squishyBias(candidate, defenseTarget) {
  const value = defenseTarget === "mdef"
    ? AR.toNumber(candidate?.mdef, 10)
    : AR.toNumber(candidate?.def, 10);
  // Lower defense -> higher weight. Clamped to a sane band.
  return AR.clamp(20 / (value + 5), 0.3, 2.5);
}

/* Combined per-candidate selection weight, blended onto the enmity base. */
function focusWeightFor(candidate, focusCtx) {
  const mode = focusCtx?.focus || "auto";
  let weight = Math.max(0.01, AR.toNumber(candidate?.enmity, 1));

  const useAffinity = mode === "auto" || mode === "by_affinity";
  if (useAffinity && focusCtx?.damageType) {
    let mult = affinityMultiplier(candidate, focusCtx.damageType);
    if (mode === "by_affinity") mult = Math.pow(mult, 1.5); // sharper emphasis
    weight *= mult;
  }

  if (mode === "lowest_hp") weight *= hpBias(candidate, "low");
  else if (mode === "highest_hp") weight *= hpBias(candidate, "high");
  else if (mode === "auto") weight *= hpBias(candidate, "mildLow");

  if (mode === "squishy") weight *= squishyBias(candidate, focusCtx?.defenseTarget);

  return Math.max(0.001, weight);
}

/*
 * Creature-wide, Burn-aware target selection (overrides relation filtering).
 *   - "burn_spread": pick at random among creatures (excl. self) that have Burn.
 *   - "burn_focus":  pick the creature(s) (excl. self) with the most Burn stacks
 *                    (random tiebreak among the top).
 * Pool is ALL dispositions except the performer (ally + enemy + neutral).
 */
function selectBurnFocusTargets(allCandidates, mode, targetRule) {
  const pool = (Array.isArray(allCandidates) ? allCandidates : []).filter(c => !c.isSelf);
  if (!pool.length) {
    return { ok: false, chosenTargets: [], reason: "No creature (other than self) to target." };
  }

  const count = Math.max(1, AR.toInteger(targetRule?.count, 1));
  const withStacks = pool.map(c => ({ c, stacks: AR.getEffectStackCount(c.actor, "Burn") }));

  if (mode === "burn_spread") {
    const holders = withStacks.filter(x => x.stacks >= 1).map(x => x.c);
    if (!holders.length) {
      return { ok: false, chosenTargets: [], reason: "No creature has Burn for burn_spread." };
    }
    const chosen = AR.weightedPickMany(holders, Math.min(count, holders.length), () => 1);
    return { ok: chosen.length > 0, chosenTargets: chosen,
      reason: `burn_spread selected ${chosen.length} Burn-holder(s) of ${holders.length}.` };
  }

  // burn_focus
  const maxStacks = Math.max(...withStacks.map(x => x.stacks));
  const top = withStacks.filter(x => x.stacks === maxStacks).map(x => x.c);
  const chosen = AR.weightedPickMany(top, Math.min(count, top.length), () => 1);
  return { ok: chosen.length > 0, chosenTargets: chosen,
    reason: `burn_focus picked among ${top.length} creature(s) with ${maxStacks} Burn.` };
}

function chooseTargetsFromCandidates(candidates, targetRule, focusCtx = null) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return {
      ok: false,
      chosenTargets: [],
      reason: "No legal targets were found."
    };
  }

  if (targetRule?.isSelf) {
    const chosen = candidates.filter(candidate => candidate.isSelf);
    return {
      ok: chosen.length > 0,
      chosenTargets: chosen,
      reason: chosen.length > 0
        ? "Self target selected."
        : "Self target rule found no performer token in candidate pool."
    };
  }

  if (targetRule?.isAll) {
    return {
      ok: true,
      chosenTargets: [...candidates],
      reason: `All-target rule selected ${candidates.length} target(s).`
    };
  }

  const exactCount = Math.max(1, AR.toInteger(targetRule?.count, 1));
  const maxCount = Math.max(1, AR.toInteger(targetRule?.maxCount, exactCount));

  if (targetRule?.isUpTo) {
    const wanted = Math.min(maxCount, candidates.length);
    const chosen = AR.weightedPickMany(candidates, wanted, candidate => focusWeightFor(candidate, focusCtx));

    return {
      ok: chosen.length > 0,
      chosenTargets: chosen,
      reason: chosen.length > 0
        ? `Up-to rule selected ${chosen.length} target(s) out of ${candidates.length}.`
        : "Up-to rule could not select any target."
    };
  }

  if (candidates.length < exactCount) {
    return {
      ok: false,
      chosenTargets: [],
      reason: `Exact target rule requires ${exactCount} target(s), but only ${candidates.length} legal target(s) exist.`
    };
  }

  const chosen = AR.weightedPickMany(candidates, exactCount, candidate => focusWeightFor(candidate, focusCtx));
  const ok = chosen.length === exactCount;

  return {
    ok,
    chosenTargets: chosen,
    reason: ok
      ? `Exact rule selected ${chosen.length} target(s).`
      : `Exact rule failed to select the required ${exactCount} target(s).`
  };
}

function summarizeCandidates(candidates, focusCtx = null) {
  return candidates.map(candidate => ({
    tokenName: candidate.tokenName,
    actorName: candidate.actorName,
    tokenId: candidate.tokenId,
    disposition: candidate.disposition,
    side: candidate.side,
    relationToPerformer: candidate.relationToPerformer,
    enmity: candidate.enmity,
    hpPercent: candidate.hpPercent,
    affinity: focusCtx?.damageType ? candidate.affinityMap?.[focusCtx.damageType] : null,
    focusWeight: focusCtx ? Number(focusWeightFor(candidate, focusCtx).toFixed(2)) : null,
    isSelf: candidate.isSelf
  }));
}

function summarizeChosenTargets(targets, focusCtx = null) {
  return targets.map(target => ({
    tokenName: target.tokenName,
    actorName: target.actorName,
    tokenId: target.tokenId,
    relationToPerformer: target.relationToPerformer,
    enmity: target.enmity,
    hpPercent: target.hpPercent,
    affinity: focusCtx?.damageType ? target.affinityMap?.[focusCtx.damageType] : null,
    isSelf: target.isSelf
  }));
}

/* -------------------------------------------------------------------------- */
/* Exported stage function                                                    */
/* -------------------------------------------------------------------------- */

export async function buildAndPickActionReaderTargets(context, options = {}) {
  const stage = ACTION_READER_BUILD_AND_PICK_TARGETS_STAGE;
  ARD.beginStage(context, stage, {
    optionsSummary: {
      customSceneTokens: Array.isArray(options?.sceneTokens),
      includeSelfInAlly: options?.includeSelfInAlly !== false
    }
  });

  try {
    if (!context) {
      context = AR.createBaseContext();
    }

    const targetRule = getTargetRule(context);
    if (!targetRule) {
      ARD.addError(context, stage, "BuildAndPickTargets requires a parsed target rule first.", {
        hasTargetRule: false
      });
      ARD.endStage(context, stage, { ok: false });
      return context;
    }

    const performerActor = getPerformerActor(context);
    const performerTokenDocument = getPerformerTokenDocument(context);

    if (!performerActor || !performerTokenDocument) {
      ARD.addError(context, stage, "BuildAndPickTargets requires a resolved performer first.", {
        actorFound: Boolean(performerActor),
        tokenFound: Boolean(performerTokenDocument)
      });
      ARD.endStage(context, stage, { ok: false });
      return context;
    }

    const allCandidates = buildDecoratedCandidates(context, options);
    const focusCtx = getFocusContext(context);
    const creatureWide = focusCtx.focus === "burn_spread" || focusCtx.focus === "burn_focus";

    // Creature-wide focus modes ignore relation filtering (ally+enemy, excl. self).
    const legalCandidates = creatureWide
      ? allCandidates.filter(c => !c.isSelf)
      : filterCandidatesByRule(context, allCandidates, targetRule, options);

    context.targetCandidatesAll = allCandidates;
    context.targetCandidates = legalCandidates;

    const pickResult = creatureWide
      ? selectBurnFocusTargets(legalCandidates, focusCtx.focus, targetRule)
      : chooseTargetsFromCandidates(legalCandidates, targetRule, focusCtx);
    context.chosenTargets = pickResult.chosenTargets ?? [];

    context.targetPickMeta = {
      parseMode: targetRule.parseMode,
      relation: targetRule.relation,
      isAll: Boolean(targetRule.isAll),
      isSelf: Boolean(targetRule.isSelf),
      isUpTo: Boolean(targetRule.isUpTo),
      candidatePoolCount: allCandidates.length,
      legalCandidateCount: legalCandidates.length,
      chosenCount: context.chosenTargets.length,
      focusMode: focusCtx.focus,
      focusDamageType: focusCtx.damageType || null,
      focusDefenseTarget: focusCtx.defenseTarget || null,
      reason: pickResult.reason
    };

    ARD.recordStage(context, stage, context.targetPickMeta);

    if (ARD.isVerbose(context)) {
      ARD.table(stage, "All scene candidates", summarizeCandidates(allCandidates, focusCtx), context);
      ARD.table(stage, "Legal target candidates", summarizeCandidates(legalCandidates, focusCtx), context);
      ARD.table(stage, "Chosen targets", summarizeChosenTargets(context.chosenTargets, focusCtx), context);
    }

    if (!legalCandidates.length) {
      ARD.addError(context, stage, "No legal targets were found for the chosen target rule.", {
        targetRule: targetRule.description,
        performerName: context?.performer?.actorName ?? null
      });
      ARD.endStage(context, stage, {
        ok: false,
        legalCandidateCount: 0,
        chosenCount: 0
      });
      return context;
    }

    if (!pickResult.ok || !context.chosenTargets.length) {
      ARD.addError(context, stage, "Target selection failed.", {
        targetRule: targetRule.description,
        legalCandidateCount: legalCandidates.length,
        reason: pickResult.reason
      });
      ARD.endStage(context, stage, {
        ok: false,
        legalCandidateCount: legalCandidates.length,
        chosenCount: context.chosenTargets.length
      });
      return context;
    }

    ARD.endStage(context, stage, {
      ok: true,
      legalCandidateCount: legalCandidates.length,
      chosenCount: context.chosenTargets.length,
      chosenNames: context.chosenTargets.map(target => target.tokenName)
    });

    return context;
  } catch (error) {
    ARD.addError(context, stage, "Unexpected error while building and picking targets.", {
      error: error?.message ?? String(error)
    });
    console.error("[ActionReader][BuildAndPickTargets] Unexpected error:", error);
    ARD.endStage(context, stage, { ok: false, crashed: true });
    return context;
  }
}

/* -------------------------------------------------------------------------- */
/* Optional module API registration                                           */
/* -------------------------------------------------------------------------- */

export function registerActionReaderBuildAndPickTargets(moduleId) {
  if (!moduleId || typeof moduleId !== "string") {
    console.warn("[ActionReader] registerActionReaderBuildAndPickTargets called without a valid moduleId.");
    return;
  }

  const api = getModuleApiContainer(moduleId);
  if (!api) {
    console.warn(`[ActionReader] Could not find module "${moduleId}" while registering Build And Pick Targets.`);
    return;
  }

  api.BuildAndPickTargets = {
    buildAndPickActionReaderTargets
  };

  console.debug(`[ActionReader] Build And Pick Targets registered to module API for "${moduleId}".`);
}
