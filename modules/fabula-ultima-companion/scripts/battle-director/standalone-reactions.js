// Standalone reaction dispatcher — fires at FSM transitions for triggers
// that aren't tied to an action card (conflict_start / conflict_end /
// turn_start / turn_end / round_start / round_end).
//
// Per [[reaction-menu-on-token]]: these are the canonical "no host card"
// triggers. For each reactor in the active combat we ask
// findPassiveCandidates for matching rows (BOTH passive and manual —
// `includeManual: true`), then spawn the token-anchored reaction menu
// over the reactor's token. A blade click fires the reaction via
// firePreAcceptedCandidate; the Pass blade just closes the menu.
//
// Auto-mode passive ("on") candidates auto-fire on menu spawn rather
// than rendering a chip the player has to acknowledge — there's no
// "action card" to gate them behind. Ask-mode passives and ALL manual
// rows render as clickable blades.
//
// This file is GM-only — the director runs only on the GM client. A
// future iteration ([[reaction-menu-on-token]] §5) will mirror the menu
// to the owning player via the same INTENT/socket pattern turn-ui uses.

import { log, warn } from "./logger.js";

// ── Idempotency persistence (A) ─────────────────────────────────────
//
// Each accept/pass/auto-fire decision is written to a scene flag so a
// F5 mid-reaction doesn't double-fire on resume. Scope keys are
// trigger-aware so per-round / per-turn re-dispatches don't collide:
//
//   conflict_start / conflict_end  → "conflict_start"
//   round_start / round_end        → "round_start::r3"
//   turn_start / turn_end          → "turn_start::r3::Actor.<uuid>"
//
// **Storage shape** — a flat array of entries, NOT a nested object
// keyed by scope. The flat shape sidesteps Foundry's setFlag path-
// expansion quirk: dots in property names (Actor UUIDs are "Actor.xxx")
// would get re-interpreted as object paths on persist, mangling the
// stored key. With a flat array each entry carries its own `scope`
// string field so dots stay safely inside values.
//
//   { entries: [{ scope, reactorUuid, rowKey, carrierUuid, decision }, ...] }
//
// Skip set on next dispatch reads `${reactorUuid}::${rowKey}::${carrierUuid}`
// for entries whose `scope` matches the current dispatch's scope, so any
// prior decision (positive or negative) takes the row out of the running.
// Cleared on combat end via persistence.clearAllDirectorStateFlags.

const STANDALONE_FLAG_NS  = "fabula-ultima-companion";
const STANDALONE_FLAG_KEY = "standaloneFired";

function scopeKeyFor(trigger, payload) {
  const round = payload?.round ?? "?";
  if (trigger === "conflict_start" || trigger === "conflict_end") return trigger;
  if (trigger === "round_start" || trigger === "round_end") return `${trigger}::r${round}`;
  if (trigger === "turn_start" || trigger === "turn_end") {
    const actingUuid = payload?.actingActorUuid ?? payload?.currentActorUuid ?? "?";
    return `${trigger}::r${round}::${actingUuid}`;
  }
  return trigger;
}

function entryKey(reactorUuid, rowKey, carrierUuid) {
  return `${reactorUuid}::${rowKey}::${carrierUuid}`;
}

function readFiredSet(scene, scopeKey) {
  if (!scene) return new Set();
  try {
    const stored = scene.getFlag(STANDALONE_FLAG_NS, STANDALONE_FLAG_KEY) ?? {};
    const entries = Array.isArray(stored.entries) ? stored.entries : [];
    const out = new Set();
    for (const e of entries) {
      if (e?.scope === scopeKey) {
        out.add(entryKey(e?.reactorUuid, e?.rowKey, e?.carrierUuid));
      }
    }
    return out;
  } catch (e) {
    warn("standalone-reactions: readFiredSet failed", e);
    return new Set();
  }
}

async function appendFired(scene, scopeKey, entry) {
  if (!scene) return;
  try {
    const stored = scene.getFlag(STANDALONE_FLAG_NS, STANDALONE_FLAG_KEY) ?? {};
    const entries = Array.isArray(stored.entries) ? stored.entries.slice() : [];
    entries.push({ scope: scopeKey, ...entry });
    await scene.setFlag(STANDALONE_FLAG_NS, STANDALONE_FLAG_KEY, { entries });
  } catch (e) {
    warn("standalone-reactions: appendFired failed", e);
  }
}

// Both skill-effects.js and reaction-menu.js are dynamically imported
// with one-shot cache-bust so a fresh module load (harness or probe)
// picks up the live source rather than the boot-cached version. The
// static-import alternative bakes whichever version was loaded at boot
// into this module, and harness cache-busts only refresh THIS module
// — not the modules statically-imported by it.
let _seExtraModule = null;
async function getSkillEffectsExtras() {
  if (_seExtraModule) return _seExtraModule;
  _seExtraModule = await import("./skill-effects.js?cb=" + Date.now());
  return _seExtraModule;
}
let _rmModule = null;
async function getReactionMenu() {
  if (_rmModule) return _rmModule.ReactionMenu;
  _rmModule = await import("./reaction-menu.js?cb=" + Date.now());
  return _rmModule.ReactionMenu;
}

// Walk the director's combatants and return [{ actor, token }] entries
// for every live reactor on the active battle. Skips combatants whose
// actor doc went stale or token isn't on canvas (they can't host a menu).
async function collectReactors(director) {
  const out = [];
  const dc = director?.dCombat;
  if (!dc) return out;
  const list = Array.isArray(dc.combatants) ? dc.combatants : Object.values(dc.combatants ?? {});
  for (const dcc of list) {
    if (!dcc || dcc.defeated) continue;
    let actor = dcc.actorDoc ?? null;
    if (!actor && dcc.actorUuid) {
      try { actor = await fromUuid(dcc.actorUuid); } catch (_) { actor = null; }
    }
    if (!actor) continue;
    // Find this actor's token on the current scene. Prefer the canvas
    // placeable so we get a PIXI Token with the .center accessor the
    // menu uses for anchoring.
    let token = null;
    if (dcc.tokenId) token = canvas?.tokens?.get(dcc.tokenId) ?? null;
    if (!token) {
      token = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === actor.uuid) ?? null;
    }
    if (!token) continue;
    out.push({ actor, token, combatantId: dcc.id });
  }
  return out;
}

// Human-readable phase label for the menu header chip. Kept short so it
// fits on one line over the token.
function labelForTrigger(trigger) {
  switch (trigger) {
    case "conflict_start": return "Start of Conflict";
    case "conflict_end":   return "End of Conflict";
    case "round_start":    return "Start of Round";
    case "round_end":      return "End of Round";
    case "turn_start":     return "Start of Turn";
    case "turn_end":       return "End of Turn";
    default:               return "Reaction";
  }
}

// Default payload shape for standalone triggers. Most rows don't read
// payload fields (the trigger key itself is the match condition), but
// some condition formulas reference round / phase metadata, so we ship
// what we can derive cheaply.
function buildStandalonePayload(director, trigger, extras) {
  return {
    trigger,
    round: director?.dCombat?.round ?? null,
    currentSide: director?.dCombat?.currentSide ?? null,
    currentActorUuid: director?.dCombat?.current?.actorUuid ?? null,
    currentTokenUuid: director?.dCombat?.current?.tokenUuid ?? null,
    ...(extras ?? {}),
  };
}

// Dispatch a standalone trigger across every reactor with at least one
// matching row. Spawns a per-reactor menu; clicks fire the reaction.
//
// BLOCKING: returns a Promise that resolves only when every spawned
// menu has been closed (every ask resolved via blade click or the
// reactor's Pass blade dismissed the menu). Auto-mode passives still
// fire synchronously and don't block.
//
// This makes "reactions block the next FSM phase" trivial — the FSM
// handlers (`PREP.onEnter`, `TURN_START.onEnter`, etc.) just `await`
// dispatch before enqueueing INTERNAL_DONE, so Take Action / next
// turn / next round can't surface until every reactor has decided.
//
// Result: `{ spawned, closed }` — spawned counts how many menus
// went up; closed is the await-resolution that the caller already
// blocked on (kept for log readability).
//
// `restrictTo` (optional): when present, only this reactor actor is
// considered — used by turn_start/turn_end to fire only for the
// acting combatant (everyone else's turn-start handlers don't apply).
export async function dispatchStandaloneTrigger({ director, trigger, restrictTo = null, payload: extraPayload = null } = {}) {
  if (!director || !trigger) return 0;
  const { findPassiveCandidates, firePreAcceptedCandidate } = await getSkillEffectsExtras();

  let reactors = await collectReactors(director);
  if (restrictTo) {
    const wantedUuid = String(restrictTo?.uuid ?? "");
    reactors = reactors.filter((r) => r.actor?.uuid === wantedUuid);
  }
  if (!reactors.length) return 0;

  const payload = buildStandalonePayload(director, trigger, extraPayload);
  // Idempotency (A): persist per-decision so F5 mid-reaction doesn't
  // re-fire on resume. Scope keys are round/turn-aware so re-dispatch
  // in a new round still surfaces the same row.
  const scene = director?.dCombat?.scene ?? null;
  const scope = scopeKeyFor(trigger, payload);
  const firedSet = readFiredSet(scene, scope);

  let spawned = 0;
  // Each spawned menu pushes a Promise here; Promise.all at the end
  // blocks dispatch return until every reactor has dismissed their menu.
  const closePromises = [];

  for (const { actor, token } of reactors) {
    let candidates;
    try {
      candidates = await findPassiveCandidates({
        casterActor: actor,
        trigger,
        payload,
        includeManual: true,
      });
    } catch (e) {
      warn(`dispatchStandaloneTrigger: findPassiveCandidates threw for ${actor?.name}`, e);
      continue;
    }
    if (!candidates?.length) continue;

    // Filter out already-handled rows (resume after F5, or a re-entry
    // into the same standalone window). Tracked via the firedSet
    // computed at dispatch entry.
    const fresh = candidates.filter(
      (c) => !firedSet.has(entryKey(actor.uuid, c.rowKey, c.carrierUuid))
    );
    if (fresh.length !== candidates.length) {
      log(`standalone[${trigger}]: ${actor.name} — ${candidates.length - fresh.length} candidate(s) already handled, skipping`);
    }
    if (!fresh.length) continue;

    // Auto-fire "on" and "force" passives immediately (no menu blade —
    // no action card to gate; just run). Ask-mode and manual rows go
    // to the menu for the player to pick. "force" rows differ from
    // "on" semantically only in UI: both auto-fire here, but force is
    // hidden from the Passive Manager toggle list as well (see
    // [[force-mode-for-engine-mandatory-reactions]]).
    const autoFire = [];
    const askable = [];
    for (const c of fresh) {
      if (c.kind === "passive" && (c.mode === "on" || c.mode === "force")) autoFire.push(c);
      else if (c.mode !== "off") askable.push(c);
    }

    for (const c of autoFire) {
      try {
        await firePreAcceptedCandidate({
          director, casterActor: actor, candidate: c, payload,
        });
        log(`standalone[${trigger}]: auto-fired "${c.carrierName}" for ${actor.name}`);
      } catch (e) {
        warn(`standalone[${trigger}]: auto-fire threw for ${c.carrierName}`, e);
      }
      // Mark as handled regardless of fire success — a failed auto-fire
      // shouldn't loop forever on resume.
      await appendFired(scene, scope, {
        reactorUuid: actor.uuid, rowKey: c.rowKey, carrierUuid: c.carrierUuid,
        decision: "auto",
      });
    }

    if (!askable.length) continue;

    // Lazy-resolve the menu module once per reactor before any spawn /
    // despawn calls — the cache-bust pattern lives in getReactionMenu()
    // so a probe / harness sees the live source.
    const ReactionMenu = await getReactionMenu();

    // Render the menu — onPick fires the candidate and respawns the
    // menu with the remaining askables; onPass closes the menu.
    // The whole interaction is wrapped in a single deferred Promise
    // (`closed`) so the dispatch caller can await every reactor.
    const combatId = director?.combatId ?? director?.dCombat?.id ?? null;
    let resolveClose;
    const closed = new Promise((r) => { resolveClose = r; });
    closePromises.push(closed);

    let remaining = askable.slice();
    const renderMenu = () => {
      if (!remaining.length) {
        ReactionMenu.despawn({ combatId, tokenId: token.id });
        resolveClose();
        return;
      }
      ReactionMenu.spawn({
        director, token,
        candidates: remaining,
        combatId,
        trigger,
        label: labelForTrigger(trigger),
        onPick: async (cand) => {
          try {
            await firePreAcceptedCandidate({
              director, casterActor: actor, candidate: cand, payload,
            });
            log(`standalone[${trigger}]: fired "${cand.carrierName}" for ${actor.name}`);
          } catch (e) {
            warn(`standalone[${trigger}]: firePreAcceptedCandidate threw for ${cand.carrierName}`, e);
          }
          // Persist this decision (A) — subsequent dispatches (resume,
          // re-entry) skip it. Awaited so the write lands before the
          // next blade click is possible.
          await appendFired(scene, scope, {
            reactorUuid: actor.uuid, rowKey: cand.rowKey, carrierUuid: cand.carrierUuid,
            decision: "fired",
          });
          // Drop the fired entry from the remaining list and re-render.
          remaining = remaining.filter(
            (r) => !(r.rowKey === cand.rowKey && r.carrierUuid === cand.carrierUuid)
          );
          renderMenu();
        },
        onPass: async () => {
          log(`standalone[${trigger}]: passed for ${actor.name}`);
          ReactionMenu.despawn({ combatId, tokenId: token.id });
          // Mark every remaining row as passed so the player can't
          // re-surface them on resume after a F5. Batched into one
          // setFlag write by appending sequentially against the same
          // scene flag (Foundry setFlag is idempotent on repeat keys).
          for (const c of remaining) {
            await appendFired(scene, scope, {
              reactorUuid: actor.uuid, rowKey: c.rowKey, carrierUuid: c.carrierUuid,
              decision: "passed",
            });
          }
          resolveClose();
        },
      });
    };
    renderMenu();
    spawned++;
  }

  if (closePromises.length) {
    log(`dispatchStandaloneTrigger[${trigger}]: awaiting ${closePromises.length} reactor menu(s)`);
    await Promise.all(closePromises);
    log(`dispatchStandaloneTrigger[${trigger}]: all menus resolved`);
  }

  return spawned;
}

// Clear every reaction menu spawned by the standalone dispatcher.
// Called from FSM teardown (Stopped.onEnter) so menus don't linger
// past combat end. Lazy-imports so a probe / harness sees the live
// source (matches dispatchStandaloneTrigger's lazy pattern).
export async function clearAllStandaloneMenus() {
  const ReactionMenu = await getReactionMenu();
  ReactionMenu.despawnAll();
}

// Clear the standaloneFired idempotency flag on a scene. Invoked via
// persistence.clearAllDirectorStateFlags alongside directorState +
// directorHistory so a finished battle leaves no state behind.
export async function clearStandaloneFiredFlag(scene) {
  if (!scene) return;
  try {
    if (scene.getFlag(STANDALONE_FLAG_NS, STANDALONE_FLAG_KEY)) {
      await scene.unsetFlag(STANDALONE_FLAG_NS, STANDALONE_FLAG_KEY);
    }
  } catch (e) {
    warn("standalone-reactions: clearStandaloneFiredFlag failed", e);
  }
}
