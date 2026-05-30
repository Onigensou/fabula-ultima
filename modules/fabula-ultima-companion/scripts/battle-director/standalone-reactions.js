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
// This file is GM-driven but mirrors to the reactor's owning player
// via the IntentChannel: when the GM spawns a menu over a player-
// owned reactor, it ALSO broadcasts `MENU_OPEN { kind: "reaction-menu" }`
// to that player. The player's client (registerPlayerReactionMenuHandler
// in reaction-menu-player.js) spawns the menu locally + emits
// `REACTION_CHOICE` back to the GM on click. The GM races local-vs-
// remote picks via Promise.race; first click wins.
//
// Visibility (Rule 1, [[reaction-architecture]]): the broadcast is
// targeted ONLY to the reactor's owner. Non-owners receive nothing —
// the stage-2 ally-indicator broadcast is a future slice.

import { log, warn } from "./logger.js";
import { INTENTS } from "./intents.js";
import { ReactionAppliedChip } from "./reaction-applied-chip.js";

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

// Find the active non-GM user who owns this reactor actor (FU PCs
// typically have a single human owner). Returns the user id, or null
// if the reactor has no human owner online (NPC or owner-offline).
// Mirrors the resolveActingOwnerForActor helper in state-handlers.js.
function resolveReactorOwnerUserId(actor) {
  if (!actor) return null;
  const candidates = (game.users?.contents ?? []).filter((u) => {
    if (u.isGM) return false;
    if (!u.active) return false;
    try { return actor.testUserPermission?.(u, "OWNER"); }
    catch { return false; }
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return candidates[0].id;
}

// Every active non-GM user EXCEPT the reactor's owner. These clients
// get the dimmed ally indicator (Rule 1 stage 2) so they know someone
// is deciding without seeing the candidate list.
function resolveAllyIndicatorRecipients(ownerUserId) {
  return (game.users?.contents ?? [])
    .filter((u) => !u.isGM && u.active && u.id !== ownerUserId)
    .map((u) => u.id);
}

function userDisplayName(userId) {
  const u = game.users?.get(userId);
  return u?.name ?? "Player";
}

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

    // Stage-3 applied chip: visible to every client (GM + all players).
    // Skips "force" mode per [[force-mode-for-engine-mandatory-reactions]]
    // — engine-mandatory reactions stay UI-invisible. Sender is also the
    // GM client itself; we spawn locally + broadcast in parallel so the
    // GM sees the same chip the players see.
    const combatIdForChip = director?.combatId ?? director?.dCombat?.id ?? null;
    const channelForChip = director?.intentChannel ?? null;
    const allActivePlayers = (game.users?.contents ?? [])
      .filter((u) => !u.isGM && u.active)
      .map((u) => u.id);
    function announceApplied(candidate, anchorToken) {
      if (!candidate || candidate.mode === "force") return;
      const tokenUuid = anchorToken?.document?.uuid ?? anchorToken?.uuid ?? null;
      const spec = {
        kind: "reaction-applied",
        combatId: combatIdForChip,
        tokenUuid,
        label: candidate.carrierName ?? "Reaction",
        icon: candidate.carrierImg ?? null,
      };
      try {
        if (anchorToken) {
          ReactionAppliedChip.spawn({
            token: anchorToken,
            label: spec.label,
            icon: spec.icon,
          });
        }
      } catch (e) { warn("standalone: ReactionAppliedChip.spawn threw", e); }
      if (channelForChip) {
        for (const uid of allActivePlayers) {
          try {
            channelForChip.broadcastMenuOpen({ targetUserId: uid, menuSpec: spec });
          } catch (e) { warn("standalone: broadcastMenuOpen(applied) threw", e); }
        }
      }
    }

    for (const c of autoFire) {
      let fired = false;
      try {
        await firePreAcceptedCandidate({
          director, casterActor: actor, candidate: c, payload,
        });
        fired = true;
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
      if (fired) announceApplied(c, token);
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

    // Resolve the reactor's online player owner. When present, mirror
    // the menu to their client via MENU_OPEN broadcast. The GM still
    // renders locally; both click paths funnel into the same
    // processDecision() below + are racing each other.
    const ownerUserId = resolveReactorOwnerUserId(actor);
    const channel = director?.intentChannel ?? null;
    // Non-owner active players get the dimmed ally indicator (Rule 1
    // stage 2). NPC reactors have no owner so the indicator goes to
    // every active player.
    const indicatorRecipients = resolveAllyIndicatorRecipients(ownerUserId);
    const ownerLabel = ownerUserId
      ? `${userDisplayName(ownerUserId)} reacting…`
      : `${actor.name ?? "Reactor"} reacting…`;

    // GM-side menu close that ALSO dismisses the player-side mirror +
    // every ally indicator we broadcast.
    function closeMenusEverywhere() {
      ReactionMenu.despawn({ combatId, tokenId: token.id });
      if (channel) {
        if (ownerUserId) {
          try {
            channel.broadcastMenuClose({
              targetUserId: ownerUserId,
              kind: "reaction-menu",
              reason: "fired-or-passed",
            });
          } catch (e) { warn("standalone: broadcastMenuClose(menu) threw", e); }
        }
        const indicatorTokenUuid = token.document?.uuid ?? token.uuid ?? null;
        for (const uid of indicatorRecipients) {
          try {
            channel.broadcastMenuClose({
              targetUserId: uid,
              kind: "reaction-indicator",
              reason: "fired-or-passed",
              data: { tokenUuid: indicatorTokenUuid, combatId },
            });
          } catch (e) { warn("standalone: broadcastMenuClose(indicator) threw", e); }
        }
      }
    }

    function buildIndicatorSpec() {
      return {
        kind: "reaction-indicator",
        combatId,
        tokenUuid: token.document?.uuid ?? token.uuid ?? null,
        reactorActorUuid: actor.uuid,
        label: ownerLabel,
        trigger,
      };
    }

    // Build the menu spec payload broadcast to the player. Includes
    // everything the player-side reaction-menu-player.js handler needs
    // to render locally (token uuid, candidates, label) + the
    // reactorActorUuid so the player-side click can tag its
    // REACTION_CHOICE intent for routing back here.
    function buildPlayerMenuSpec() {
      // Serialize candidates minimally — pull only the fields the menu
      // module uses to render blades + the click handler. Avoids
      // round-tripping large nested objects through the socket.
      const serialised = remaining.map((c) => ({
        rowKey: c.rowKey,
        carrierUuid: c.carrierUuid,
        carrierName: c.carrierName,
        carrierImg: c.carrierImg,
        carrierDescription: c.carrierDescription,
        mode: c.mode,
        kind: c.kind,
        ref: c.ref,
      }));
      return {
        kind: "reaction-menu",
        combatId,
        tokenUuid: token.document?.uuid ?? token.uuid ?? null,
        reactorActorUuid: actor.uuid,
        candidates: serialised,
        trigger,
        label: labelForTrigger(trigger),
      };
    }

    // Apply a candidate decision — shared by local onPick + remote
    // REACTION_CHOICE intent. Returns true if the menu should keep
    // running (more remaining), false if it should close.
    async function processDecision(cand) {
      let fired = false;
      try {
        await firePreAcceptedCandidate({
          director, casterActor: actor, candidate: cand, payload,
        });
        fired = true;
        log(`standalone[${trigger}]: fired "${cand.carrierName}" for ${actor.name}`);
      } catch (e) {
        warn(`standalone[${trigger}]: firePreAcceptedCandidate threw for ${cand.carrierName}`, e);
      }
      await appendFired(scene, scope, {
        reactorUuid: actor.uuid, rowKey: cand.rowKey, carrierUuid: cand.carrierUuid,
        decision: "fired",
      });
      if (fired) announceApplied(cand, token);
      remaining = remaining.filter(
        (r) => !(r.rowKey === cand.rowKey && r.carrierUuid === cand.carrierUuid)
      );
      return remaining.length > 0;
    }

    async function processPass() {
      log(`standalone[${trigger}]: passed for ${actor.name}`);
      for (const c of remaining) {
        await appendFired(scene, scope, {
          reactorUuid: actor.uuid, rowKey: c.rowKey, carrierUuid: c.carrierUuid,
          decision: "passed",
        });
      }
      remaining = [];
    }

    // Re-arm the awaitIntent each iteration of the menu render loop —
    // the IntentChannel's awaitIntent is one-shot. Without this, the
    // first remote pick resolves but the second player click on the
    // refreshed menu wouldn't be heard.
    function armRemoteAwait() {
      if (!ownerUserId || !channel) return null;
      try {
        return channel.awaitIntent(INTENTS.REACTION_CHOICE, {
          fromUserId: ownerUserId,
          timeoutMs: 30 * 60 * 1000,  // 30 min — practically forever
        });
      } catch (e) {
        warn(`standalone[${trigger}]: awaitIntent threw`, e);
        return null;
      }
    }

    const renderMenu = () => {
      if (!remaining.length) {
        closeMenusEverywhere();
        resolveClose();
        return;
      }
      // Broadcast the current remaining set to the player. Re-broadcasts
      // on every render so the player always sees the same set the GM
      // sees.
      if (ownerUserId && channel) {
        try {
          channel.broadcastMenuOpen({
            targetUserId: ownerUserId,
            menuSpec: buildPlayerMenuSpec(),
          });
        } catch (e) { warn("standalone: broadcastMenuOpen threw", e); }
      }
      // Stage-2 ally indicator: dimmed dashed pill rendered to every
      // active non-owner player so they know someone is reacting
      // without leaking the candidate list. Broadcast once per render
      // iteration so a late-joining client still receives it via the
      // PLAYER_HELLO replay cache. See [[reaction-architecture]] Rule 1.
      if (channel && indicatorRecipients.length) {
        const spec = buildIndicatorSpec();
        for (const uid of indicatorRecipients) {
          try {
            channel.broadcastMenuOpen({ targetUserId: uid, menuSpec: spec });
          } catch (e) { warn("standalone: broadcastMenuOpen(indicator) threw", e); }
        }
      }
      // Arm the remote awaitIntent BEFORE spawning the local menu so
      // a near-instant player click isn't dropped.
      const remoteAwait = armRemoteAwait();
      let localPickFired = false;

      ReactionMenu.spawn({
        director, token,
        candidates: remaining,
        combatId,
        trigger,
        label: labelForTrigger(trigger),
        onPick: async (cand) => {
          if (localPickFired) return;
          localPickFired = true;
          // Abort the racing remote await so it doesn't linger and
          // resolve a stale intent on the next menu iteration.
          try { remoteAwait?.abort?.("local-won"); } catch {}
          const keepGoing = await processDecision(cand);
          if (keepGoing) renderMenu();
          else { closeMenusEverywhere(); resolveClose(); }
        },
        onPass: async () => {
          if (localPickFired) return;
          localPickFired = true;
          try { remoteAwait?.abort?.("local-won"); } catch {}
          await processPass();
          closeMenusEverywhere();
          resolveClose();
        },
      });

      // Handle remote pick. If the player clicks first, this race-
      // path fires; we cancel the GM-local menu via closeMenusEverywhere
      // (which also closes the mirror it would re-broadcast).
      if (remoteAwait) {
        remoteAwait.then(async (intent) => {
          if (localPickFired) return;
          localPickFired = true;
          const body = intent?.body ?? {};
          if (body.decision === "pass") {
            await processPass();
            closeMenusEverywhere();
            resolveClose();
            return;
          }
          // Look up the candidate by rowKey + carrierUuid against the
          // current remaining set. The remote intent CARRIES these but
          // the candidate object itself stays on the GM side.
          const cand = remaining.find(
            (c) => c.rowKey === body.rowKey && c.carrierUuid === body.carrierUuid
          );
          if (!cand) {
            warn(`standalone[${trigger}]: remote REACTION_CHOICE rowKey ${body.rowKey} not found in remaining`);
            // Re-arm and continue — the menu didn't actually fire.
            localPickFired = false;
            return;
          }
          const keepGoing = await processDecision(cand);
          if (keepGoing) renderMenu();
          else { closeMenusEverywhere(); resolveClose(); }
        }).catch((e) => {
          // Aborted by local-won path — expected, no warning.
          if (!String(e?.message ?? e).includes("local-won")) {
            warn(`standalone[${trigger}]: awaitIntent rejected`, e);
          }
        });
      }
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
