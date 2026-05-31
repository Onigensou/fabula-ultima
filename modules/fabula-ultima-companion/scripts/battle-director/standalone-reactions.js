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

// ── Multi-reactor dispatch coordinator ──────────────────────────────────
//
// Cross-menu signalling for the serial-with-blocking model: when ANY
// reactor's menu commits an action-creating reaction (one whose chain
// queues a free action or spawns a follow-up card — see
// isActionCreatingReaction in skill-effects.js), other reactors'
// menus must close and become "deferred" so the player can SEE the
// action play out before committing their own reaction.
//
// After the action completes, STANDALONE_REACTION_WINDOW re-enters
// itself (via the _postFreeActionTarget chain) and re-dispatches for
// the deferred reactors with re-gated conditions.
//
// Coordinator is a plain EventTarget. dispatchReactionMenu registers
// a "stop-others" listener on entry; on commit-emit, every other
// dispatchReactionMenu's listener fires and the menu closes itself.
// The acting reactor's listener is no-op (filters by source uuid).
const _dispatchCoordinator = new EventTarget();

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
//
// Subject mapping: `findPassiveCandidates` → `shouldReactionPassiveFire`
// reads `payload.sourceActorUuid` (the subject creature) to evaluate
// `reaction_source` filters ("self" / "ally" / "enemy"). Per the trigger
// schema, turn_start/turn_end carry the acting combatant as their subject,
// so we surface `actingActorUuid` → `sourceActorUuid` here. Lifecycle
// triggers without a subject (conflict_start/end, round_start/end) leave
// the field null — those triggers' schema entries don't expose a source
// filter, so the matcher's "self" check fails-open via subjectMatchesSource
// returning false (correct: a row authored with `reaction_source: "self"`
// on conflict_start has no semantic meaning).
function buildStandalonePayload(director, trigger, extras) {
  const subjectTriggers = trigger === "turn_start" || trigger === "turn_end";
  const subjectActorUuid = subjectTriggers ? (extras?.actingActorUuid ?? null) : null;
  const subjectTokenUuid = subjectTriggers ? (extras?.actingTokenUuid ?? null) : null;
  return {
    trigger,
    round: director?.dCombat?.round ?? null,
    currentSide: director?.dCombat?.currentSide ?? null,
    currentActorUuid: director?.dCombat?.current?.actorUuid ?? null,
    currentTokenUuid: director?.dCombat?.current?.tokenUuid ?? null,
    sourceActorUuid: subjectActorUuid,
    sourceTokenUuid: subjectTokenUuid,
    ...(extras ?? {}),
  };
}

// Generic reaction-menu dispatcher for a SINGLE reactor.
//
// Handles the full multi-client flow:
//   - findPassiveCandidates (matcher gates the row's filters/formula)
//   - Auto-fire "on"/"force" passives silently (no menu surface).
//   - For ask-mode candidates: spawn ReactionMenu over the reactor's
//     token, broadcast the same menu to the reactor's player owner,
//     broadcast a dimmed indicator to non-owner active players, race
//     local-vs-remote click via Promise.race + awaitIntent.
//   - On blade pick → firePreAcceptedCandidate, re-render with remaining
//     candidates (if any) or close.
//   - On Pass/Cancel → close, mark all remaining as passed (in scope
//     idempotency if scope+scene supplied).
//
// Returns `{ cancelled, fired }`:
//   - `cancelled: true`  → user clicked Pass/Cancel without firing
//                          anything (including auto-fires). The caller
//                          should treat this as "the reactor declined."
//   - `cancelled: false` → at least one reaction fired (auto-fire OR
//                          ask-mode pick). The caller proceeds.
//   - `fired` is the array of candidate objects that actually applied.
//
// Idempotency persistence (optional): pass `scope` (string) + `scene`
// (SceneDocument) to record decisions in the scene's standaloneFired
// flag — used by standalone triggers so F5 mid-reaction doesn't double-
// fire on resume. Synchronous callers (Vismagus in TARGET) omit both.
//
// `passLabel` (optional): bottom-button text. Defaults to "Pass" for
// standalone triggers; Vismagus passes "Cancel" because declining =
// can't afford the spell, so we return the player to the action picker.
export async function dispatchReactionMenu({
  director,
  reactor,
  token,
  trigger,
  payload,
  label = null,
  passLabel = "Pass",
  includeManual = true,
  scope = null,
  scene = null,
} = {}) {
  if (!director || !reactor || !token || !trigger) {
    return { cancelled: false, fired: [] };
  }
  const { findPassiveCandidates, firePreAcceptedCandidate, isActionCreatingReaction, isActionCreatingReactionForAE } = await getSkillEffectsExtras();
  const fired = [];
  let deferredByPeer = false;  // set if another reactor's action-creating commit forces us to close

  // Idempotency filter — drop already-handled rows when scope+scene set.
  const firedSet = (scope && scene) ? readFiredSet(scene, scope) : new Set();

  let candidates;
  try {
    candidates = await findPassiveCandidates({
      casterActor: reactor,
      trigger,
      payload,
      includeManual,
    });
  } catch (e) {
    warn(`reaction[${trigger}]: findPassiveCandidates threw for ${reactor?.name}`, e);
    return { cancelled: false, fired: [] };
  }
  if (!candidates?.length) return { cancelled: false, fired: [] };

  const fresh = candidates.filter(
    (c) => !firedSet.has(entryKey(reactor.uuid, c.rowKey, c.carrierUuid))
  );
  if (fresh.length !== candidates.length) {
    log(`reaction[${trigger}]: ${reactor.name} — ${candidates.length - fresh.length} candidate(s) already handled, skipping`);
  }
  if (!fresh.length) return { cancelled: false, fired: [] };

  // Auto-fire "on" + "force" passives silently.
  const autoFire = [];
  const askable = [];
  for (const c of fresh) {
    if (c.kind === "passive" && (c.mode === "on" || c.mode === "force")) autoFire.push(c);
    else if (c.mode !== "off") askable.push(c);
  }
  for (const c of autoFire) {
    try {
      await firePreAcceptedCandidate({
        director, casterActor: reactor, candidate: c, payload,
      });
      fired.push(c);
      log(`reaction[${trigger}]: auto-fired "${c.carrierName}" for ${reactor.name}`);
    } catch (e) {
      warn(`reaction[${trigger}]: auto-fire threw for ${c.carrierName}`, e);
    }
    if (scope && scene) {
      await appendFired(scene, scope, {
        reactorUuid: reactor.uuid, rowKey: c.rowKey, carrierUuid: c.carrierUuid,
        decision: "auto",
      });
    }
  }

  if (!askable.length) {
    // Nothing left to interact with. cancelled stays false — auto-fires
    // (if any) already counted as "fired"; with zero auto-fires the
    // caller sees `{ cancelled: false, fired: [] }` and proceeds.
    return { cancelled: false, fired };
  }

  // Spawn the interactive menu.
  const ReactionMenu = await getReactionMenu();
  const combatId = director?.combatId ?? director?.dCombat?.id ?? null;
  let resolveClose;
  const closed = new Promise((r) => { resolveClose = r; });

  let remaining = askable.slice();
  let cancelled = false;

  const ownerUserId = resolveReactorOwnerUserId(reactor);
  const channel = director?.intentChannel ?? null;
  const indicatorRecipients = resolveAllyIndicatorRecipients(ownerUserId);
  const ownerLabel = ownerUserId
    ? `${userDisplayName(ownerUserId)} reacting…`
    : `${reactor.name ?? "Reactor"} reacting…`;
  const menuLabel = label ?? labelForTrigger(trigger);

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
        } catch (e) { warn(`reaction[${trigger}]: broadcastMenuClose(menu) threw`, e); }
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
        } catch (e) { warn(`reaction[${trigger}]: broadcastMenuClose(indicator) threw`, e); }
      }
    }
  }

  function buildIndicatorSpec() {
    return {
      kind: "reaction-indicator",
      combatId,
      tokenUuid: token.document?.uuid ?? token.uuid ?? null,
      reactorActorUuid: reactor.uuid,
      label: ownerLabel,
      trigger,
    };
  }

  function buildPlayerMenuSpec() {
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
      reactorActorUuid: reactor.uuid,
      candidates: serialised,
      trigger,
      label: menuLabel,
      passLabel,
    };
  }

  async function processDecision(cand) {
    // Classify BEFORE firing the chain — if action-creating, signal
    // peers to close their menus so the player can see the action
    // play out before they commit. The classifier reads the carrier
    // doc's reaction_config_table[rowKey] + walks its effect chain.
    let isActionCreating = false;
    try {
      const carrier = await fromUuid(cand.carrierUuid).catch(() => null);
      if (carrier) {
        const cfg = cand.carrierKind === "ae"
          ? (carrier?.flags?.["fabula-ultima-companion"]?.reactionConfig?.reaction_config_table)
          : (carrier?.system?.props?.reaction_config_table);
        const reactionRow = cfg?.[cand.rowKey] ?? null;
        if (reactionRow) {
          isActionCreating = cand.carrierKind === "ae"
            ? isActionCreatingReactionForAE(carrier, reactionRow)
            : isActionCreatingReaction(carrier, reactionRow);
        }
      }
    } catch (e) {
      warn(`reaction[${trigger}]: action-creating classification threw`, e);
    }
    if (isActionCreating) {
      log(`reaction[${trigger}]: ${reactor.name} → action-creating commit "${cand.carrierName}", signalling peers to defer`);
      try {
        _dispatchCoordinator.dispatchEvent(new CustomEvent("stop-others", {
          detail: { sourceReactorUuid: reactor.uuid, actorName: reactor.name ?? "Someone", trigger, carrierName: cand.carrierName },
        }));
      } catch (e) { warn(`reaction[${trigger}]: stop-others dispatch threw`, e); }
    }
    try {
      await firePreAcceptedCandidate({
        director, casterActor: reactor, candidate: cand, payload,
      });
      fired.push(cand);
      log(`reaction[${trigger}]: fired "${cand.carrierName}" for ${reactor.name}`);
    } catch (e) {
      warn(`reaction[${trigger}]: firePreAcceptedCandidate threw for ${cand.carrierName}`, e);
    }
    if (scope && scene) {
      await appendFired(scene, scope, {
        reactorUuid: reactor.uuid, rowKey: cand.rowKey, carrierUuid: cand.carrierUuid,
        decision: "fired",
      });
    }
    remaining = remaining.filter(
      (r) => !(r.rowKey === cand.rowKey && r.carrierUuid === cand.carrierUuid)
    );
    return remaining.length > 0;
  }

  async function processPass() {
    log(`reaction[${trigger}]: passed for ${reactor.name}`);
    if (scope && scene) {
      for (const c of remaining) {
        await appendFired(scene, scope, {
          reactorUuid: reactor.uuid, rowKey: c.rowKey, carrierUuid: c.carrierUuid,
          decision: "passed",
        });
      }
    }
    // cancelled = true only when NOTHING fired (no auto-fires AND no
    // ask-pick before this pass). Auto-fires set fired[] in the outer
    // loop above; if any landed, cancelled stays false.
    cancelled = fired.length === 0;
    remaining = [];
  }

  function armRemoteAwait() {
    if (!ownerUserId || !channel) return null;
    try {
      return channel.awaitIntent(INTENTS.REACTION_CHOICE, {
        fromUserId: ownerUserId,
        timeoutMs: 30 * 60 * 1000,
      });
    } catch (e) {
      warn(`reaction[${trigger}]: awaitIntent threw`, e);
      return null;
    }
  }

  const renderMenu = () => {
    if (!remaining.length) {
      closeMenusEverywhere();
      resolveClose();
      return;
    }
    if (ownerUserId && channel) {
      try {
        channel.broadcastMenuOpen({
          targetUserId: ownerUserId,
          menuSpec: buildPlayerMenuSpec(),
        });
      } catch (e) { warn(`reaction[${trigger}]: broadcastMenuOpen threw`, e); }
    }
    if (channel && indicatorRecipients.length) {
      const spec = buildIndicatorSpec();
      for (const uid of indicatorRecipients) {
        try {
          channel.broadcastMenuOpen({ targetUserId: uid, menuSpec: spec });
        } catch (e) { warn(`reaction[${trigger}]: broadcastMenuOpen(indicator) threw`, e); }
      }
    }
    const remoteAwait = armRemoteAwait();
    let localPickFired = false;

    ReactionMenu.spawn({
      director, token,
      candidates: remaining,
      combatId,
      trigger,
      label: menuLabel,
      passLabel,
      onPick: async (cand) => {
        if (localPickFired) return;
        localPickFired = true;
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
        const cand = remaining.find(
          (c) => c.rowKey === body.rowKey && c.carrierUuid === body.carrierUuid
        );
        if (!cand) {
          warn(`reaction[${trigger}]: remote REACTION_CHOICE rowKey ${body.rowKey} not found in remaining`);
          localPickFired = false;
          return;
        }
        const keepGoing = await processDecision(cand);
        if (keepGoing) renderMenu();
        else { closeMenusEverywhere(); resolveClose(); }
      }).catch((e) => {
        if (!String(e?.message ?? e).includes("local-won")) {
          warn(`reaction[${trigger}]: awaitIntent rejected`, e);
        }
      });
    }
  };

  // Cross-reactor stop signal — another reactor's menu just committed an
  // action-creating reaction. Close my menu cleanly and return as
  // "deferred" so the orchestrator knows I haven't decided yet.
  // Source filter: ignore my own emit so the acting reactor doesn't
  // close itself.
  const stopHandler = (ev) => {
    const sourceUuid = ev?.detail?.sourceReactorUuid ?? null;
    if (sourceUuid && sourceUuid === reactor.uuid) return;
    if (deferredByPeer) return;
    deferredByPeer = true;
    log(`reaction[${trigger}]: ${reactor.name} deferred (peer "${ev?.detail?.actorName ?? "?"}" took action-creating)`);
    try { closeMenusEverywhere(); } catch {}
    try { resolveClose(); } catch {}
  };
  _dispatchCoordinator.addEventListener("stop-others", stopHandler);

  try {
    renderMenu();
    await closed;
  } finally {
    _dispatchCoordinator.removeEventListener("stop-others", stopHandler);
  }
  return { cancelled, fired, deferred: deferredByPeer };
}

// Dispatch a standalone trigger across every live reactor. Each reactor's
// menu fires concurrently; the Promise resolves only when ALL reactors
// have resolved their menu (block-the-FSM semantics).
//
// `restrictTo` (optional): when present, only this reactor actor is
// considered — used by turn_start/turn_end to fire only for the
// acting combatant.
export async function dispatchStandaloneTrigger({ director, trigger, restrictTo = null, payload: extraPayload = null } = {}) {
  if (!director || !trigger) return 0;
  let reactors = await collectReactors(director);
  if (restrictTo) {
    const wantedUuid = String(restrictTo?.uuid ?? "");
    reactors = reactors.filter((r) => r.actor?.uuid === wantedUuid);
  }
  if (!reactors.length) return 0;

  const payload = buildStandalonePayload(director, trigger, extraPayload);
  const scene = director?.dCombat?.scene ?? null;
  const scope = scopeKeyFor(trigger, payload);
  const triggerLabel = labelForTrigger(trigger);

  const dispatches = reactors.map(({ actor, token }) =>
    dispatchReactionMenu({
      director,
      reactor: actor,
      token,
      trigger,
      payload,
      label: triggerLabel,
      passLabel: "Pass",
      includeManual: true,
      scope,
      scene,
    }).catch((e) => {
      warn(`dispatchStandaloneTrigger[${trigger}]: reactor ${actor?.name} threw`, e);
      return { cancelled: true, fired: [] };
    })
  );
  const results = await Promise.all(dispatches);
  const involved = results.filter((r) => r.fired.length || !r.cancelled).length;
  log(`dispatchStandaloneTrigger[${trigger}]: ${results.length} reactor(s) processed`);
  return involved;
}

// Clear every reaction menu + indicator spawned by the standalone
// dispatcher. Called from FSM teardown (Stopped.onEnter) so menus
// don't linger past combat end, AND from director-boot's stop() so
// rewind tears down menus even when the FSM transition can't fully
// unwind (mid-await dispatch). Lazy-imports so a probe / harness sees
// the live source (matches dispatchStandaloneTrigger's lazy pattern).
export async function clearAllStandaloneMenus() {
  const ReactionMenu = await getReactionMenu();
  try { ReactionMenu.despawnAll(); } catch {}
  try {
    const ri = await import("./reaction-indicator.js?cb=" + Date.now());
    ri.ReactionIndicator.despawnAll();
  } catch (e) { warn("clearAllStandaloneMenus: indicator despawn threw", e); }
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
