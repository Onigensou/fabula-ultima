/* ========================================================================== *
 * ActionReader Resolve Performer
 * -------------------------------------------------------------------------- *
 * Module-compatible performer resolver for the ActionReader pipeline.
 *
 * Suggested file path:
 *   scripts/action-reader/actionReader-resolvePerformer.js
 *
 * Purpose:
 *   1. Find who should perform the action.
 *   2. Support Lancer Initiative active combatant first.
 *   3. Fallback to currently controlled tokens.
 *   4. Normalize the chosen performer into the ActionReader context.
 *
 * Usage:
 *   import {
 *     collectActionReaderPerformerCandidates,
 *     resolveActionReaderPerformer,
 *     registerActionReaderResolvePerformer
 *   } from "./actionReader-resolvePerformer.js";
 *
 * ========================================================================= */

import { ActionReaderCore as AR } from "./actionReader-core.js";
import { ActionReaderDebug as ARD } from "./actionReader-debug.js";

export const ACTION_READER_RESOLVE_PERFORMER_VERSION = "1.0.0";
export const ACTION_READER_RESOLVE_PERFORMER_STAGE = "ResolvePerformer";

function getModuleApiContainer(moduleId) {
  const module = game.modules.get(moduleId);
  if (!module) return null;

  module.api ??= {};
  module.api.ActionReader ??= {};
  return module.api.ActionReader;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

function normalizeTokenToPerformerEntry(tokenLike, source = "selection", combat = null, combatant = null) {
  const token = tokenLike?.object ?? tokenLike ?? null;
  const tokenDocument = AR.getTokenDocument(token);
  const actor = AR.getTokenActor(token);

  if (!tokenDocument || !actor) return null;

  return {
    source,
    combat: combat ?? null,
    combatant: combatant ?? null,
    token,
    tokenDocument,
    actor,
    actorId: actor.id ?? null,
    tokenId: tokenDocument.id ?? null,
    actorName: AR.getActorName(actor),
    tokenName: AR.getTokenName(token),
    disposition: combatant ? AR.getCombatantDisposition(combatant) : AR.getTokenDisposition(token),
    uuid: tokenDocument.uuid ?? actor.uuid ?? null
  };
}

function getControlledTokenEntries() {
  const controlled = Array.from(canvas?.tokens?.controlled ?? []);
  return controlled
    .map(token => normalizeTokenToPerformerEntry(token, "selection", null, null))
    .filter(Boolean);
}

function getActiveCombatPerformerEntry(combat = AR.getActiveCombat()) {
  if (!combat) return null;

  const combatant = AR.getActiveCombatant(combat);
  if (!combatant) return null;

  const tokenDocument = combatant.token ?? null;
  const token = tokenDocument?.object ?? null;
  const actor = combatant.actor ?? token?.actor ?? tokenDocument?.actor ?? null;

  if (!actor || !tokenDocument) return null;

  return normalizeTokenToPerformerEntry(
    token ?? tokenDocument,
    "combat",
    combat,
    combatant
  );
}

function dedupePerformerEntries(entries) {
  const seen = new Set();
  const result = [];

  for (const entry of entries ?? []) {
    if (!entry) continue;

    const key = entry.tokenId || entry.actorId || entry.uuid;
    if (!key) continue;
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(entry);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Exported collection function for launcher use                               */
/* -------------------------------------------------------------------------- */

/**
 * Collects all valid performer candidates in priority order.
 *
 * Priority:
 *   1. Explicit token / combatant / actor passed in options
 *   2. Active combatant from active combat
 *   3. Controlled tokens on canvas
 *
 * Returns an array because the launcher may need to run once per selected token.
 */
export function collectActionReaderPerformerCandidates(options = {}) {
  const {
    token = null,
    tokenDocument = null,
    actor = null,
    combat = AR.getActiveCombat(),
    combatant = null
  } = options;

  const entries = [];

  if (combatant) {
    const combatantEntry = normalizeTokenToPerformerEntry(
      combatant.token?.object ?? combatant.token,
      "explicit-combatant",
      combat ?? combatant.parent ?? null,
      combatant
    );
    if (combatantEntry) entries.push(combatantEntry);
  }

  if (token || tokenDocument) {
    const tokenEntry = normalizeTokenToPerformerEntry(
      token ?? tokenDocument,
      "explicit-token",
      combat ?? null,
      null
    );
    if (tokenEntry) entries.push(tokenEntry);
  }

  if (actor && !token && !tokenDocument && !combatant) {
    const sceneTokens = Array.from(canvas?.tokens?.placeables ?? []).filter(t => t.actor?.id === actor.id);
    for (const sceneToken of sceneTokens) {
      const actorEntry = normalizeTokenToPerformerEntry(sceneToken, "explicit-actor", combat ?? null, null);
      if (actorEntry) entries.push(actorEntry);
    }
  }

  if (!entries.length) {
    const activeCombatEntry = getActiveCombatPerformerEntry(combat);
    if (activeCombatEntry) entries.push(activeCombatEntry);
  }

  if (!entries.length) {
    entries.push(...getControlledTokenEntries());
  }

  return dedupePerformerEntries(entries);
}

/* -------------------------------------------------------------------------- */
/* Exported stage function                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resolves one performer into the ActionReader context packet.
 *
 * Expected use:
 *   const context = AR.createBaseContext();
 *   await resolveActionReaderPerformer(context, { performerEntry });
 */
export async function resolveActionReaderPerformer(context, options = {}) {
  const stage = ACTION_READER_RESOLVE_PERFORMER_STAGE;
  ARD.beginStage(context, stage, { optionsSummary: summarizeResolveOptions(options) });

  try {
    if (!context) {
      context = AR.createBaseContext();
    }

    const performerEntry =
      options.performerEntry ??
      collectActionReaderPerformerCandidates(options)[0] ??
      null;

    if (!performerEntry) {
      ARD.addError(context, stage, "No valid performer could be found.", {
        reason: "No active combatant and no controlled token."
      });
      ARD.endStage(context, stage, { ok: false });
      return context;
    }

    const combat = performerEntry.combat ?? AR.getActiveCombat() ?? null;
    const combatant = performerEntry.combatant ?? null;
    const token = performerEntry.token ?? performerEntry.tokenDocument?.object ?? null;
    const tokenDocument = performerEntry.tokenDocument ?? AR.getTokenDocument(token) ?? null;
    const actor = performerEntry.actor ?? AR.getTokenActor(token) ?? null;

    if (!actor || !tokenDocument) {
      ARD.addError(context, stage, "Resolved performer is missing actor or token document.", {
        actorFound: Boolean(actor),
        tokenDocumentFound: Boolean(tokenDocument)
      });
      ARD.endStage(context, stage, { ok: false });
      return context;
    }

    const disposition =
      combatant
        ? AR.getCombatantDisposition(combatant)
        : AR.getTokenDisposition(tokenDocument);

    context.performer = {
      source: performerEntry.source ?? "unknown",
      actor,
      token: token ?? tokenDocument?.object ?? null,
      tokenDocument,
      combatant,
      disposition,
      actorId: actor.id ?? null,
      tokenId: tokenDocument.id ?? null,
      actorName: AR.getActorName(actor),
      tokenName: AR.getTokenName(token ?? tokenDocument)
    };

    context.combat = {
      combat: combat ?? null,
      combatId: combat?.id ?? null,
      round: AR.getCombatRound(combat),
      turnIndex: AR.getCombatTurnIndex(combat),
      combatantId: combatant?.id ?? null,
      started: Boolean(combat?.started)
    };

    ARD.recordStage(context, stage, {
      source: context.performer.source,
      actorName: context.performer.actorName,
      tokenName: context.performer.tokenName,
      actorId: context.performer.actorId,
      tokenId: context.performer.tokenId,
      combatId: context.combat.combatId,
      combatantId: context.combat.combatantId,
      round: context.combat.round,
      turnIndex: context.combat.turnIndex,
      disposition: context.performer.disposition
    });

    ARD.endStage(context, stage, {
      ok: true,
      source: context.performer.source,
      actorName: context.performer.actorName,
      tokenName: context.performer.tokenName
    });

    return context;
  } catch (error) {
    ARD.addError(context, stage, "Unexpected error while resolving performer.", {
      error: error?.message ?? String(error)
    });
    console.error("[ActionReader][ResolvePerformer] Unexpected error:", error);
    ARD.endStage(context, stage, { ok: false, crashed: true });
    return context;
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience helper for launcher                                             */
/* -------------------------------------------------------------------------- */

/**
 * Returns performer entries for launcher flow.
 * This is mainly for the front-end macro.
 */
export function getActionReaderLaunchPerformers(options = {}) {
  return collectActionReaderPerformerCandidates(options);
}

/* -------------------------------------------------------------------------- */
/* Small summary helper                                                        */
/* -------------------------------------------------------------------------- */

function summarizeResolveOptions(options = {}) {
  return {
    hasPerformerEntry: Boolean(options.performerEntry),
    hasCombatant: Boolean(options.combatant),
    hasToken: Boolean(options.token),
    hasTokenDocument: Boolean(options.tokenDocument),
    hasActor: Boolean(options.actor),
    hasCombat: Boolean(options.combat)
  };
}

/* -------------------------------------------------------------------------- */
/* Optional module API registration                                            */
/* -------------------------------------------------------------------------- */

export function registerActionReaderResolvePerformer(moduleId) {
  if (!moduleId || typeof moduleId !== "string") {
    console.warn("[ActionReader] registerActionReaderResolvePerformer called without a valid moduleId.");
    return;
  }

  const api = getModuleApiContainer(moduleId);
  if (!api) {
    console.warn(`[ActionReader] Could not find module "${moduleId}" while registering Resolve Performer.`);
    return;
  }

  api.ResolvePerformer = {
    collectActionReaderPerformerCandidates,
    getActionReaderLaunchPerformers,
    resolveActionReaderPerformer
  };

  console.log(`[ActionReader] Resolve Performer registered to module API for "${moduleId}".`);
}
