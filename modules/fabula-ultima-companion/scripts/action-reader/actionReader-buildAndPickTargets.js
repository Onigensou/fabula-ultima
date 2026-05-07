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

function chooseTargetsFromCandidates(candidates, targetRule) {
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
    const chosen = AR.weightedPickMany(candidates, wanted, candidate => candidate.enmity);

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

  const chosen = AR.weightedPickMany(candidates, exactCount, candidate => candidate.enmity);
  const ok = chosen.length === exactCount;

  return {
    ok,
    chosenTargets: chosen,
    reason: ok
      ? `Exact rule selected ${chosen.length} target(s).`
      : `Exact rule failed to select the required ${exactCount} target(s).`
  };
}

function summarizeCandidates(candidates) {
  return candidates.map(candidate => ({
    tokenName: candidate.tokenName,
    actorName: candidate.actorName,
    tokenId: candidate.tokenId,
    disposition: candidate.disposition,
    side: candidate.side,
    relationToPerformer: candidate.relationToPerformer,
    enmity: candidate.enmity,
    isSelf: candidate.isSelf
  }));
}

function summarizeChosenTargets(targets) {
  return targets.map(target => ({
    tokenName: target.tokenName,
    actorName: target.actorName,
    tokenId: target.tokenId,
    relationToPerformer: target.relationToPerformer,
    enmity: target.enmity,
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
    const legalCandidates = filterCandidatesByRule(context, allCandidates, targetRule, options);

    context.targetCandidatesAll = allCandidates;
    context.targetCandidates = legalCandidates;

    const pickResult = chooseTargetsFromCandidates(legalCandidates, targetRule);
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
      reason: pickResult.reason
    };

    ARD.recordStage(context, stage, context.targetPickMeta);

    if (ARD.isVerbose(context)) {
      ARD.table(stage, "All scene candidates", summarizeCandidates(allCandidates), context);
      ARD.table(stage, "Legal target candidates", summarizeCandidates(legalCandidates), context);
      ARD.table(stage, "Chosen targets", summarizeChosenTargets(context.chosenTargets), context);
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

  console.log(`[ActionReader] Build And Pick Targets registered to module API for "${moduleId}".`);
}
