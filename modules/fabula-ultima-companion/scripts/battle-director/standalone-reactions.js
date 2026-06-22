// Standalone reaction dispatcher — fires at FSM transitions for triggers
// that aren't tied to an action card (conflict_start / conflict_end /
// turn_start / turn_end / round_start / round_end).
//
// Per [[reaction-menu-on-token]]: these are the canonical "no host card"
// triggers. For each reactor in the active combat we ask
// findPassiveCandidates for every matching non-deleted row (the
// reaction_isPassive/includeManual split was retired 2026-06-07 — each
// row's reaction_passive_mode decides surfacing), then spawn the token menu
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

// A reaction chain reports user-cancellation (a secondary picker — target
// selection / option menu — dismissed before committing) via `cancelled:true`
// on its result, with `reason` carrying "cancelled" as a fallback signal
// (single-consumer reactions propagate the reason but the chain wrapper sets
// the bool). Either marks the decision as "never mind", not a failure — the
// reactor menu should re-offer the reaction rather than consume it.
function isCancelledResult(res) {
  if (!res) return false;
  // Explicit bool — target-picker cancels (ok:false) and chain-forwarded cancels.
  if (res.cancelled === true) return true;
  // Picker/menu/confirm cancels: open_action_menu / prompt_element / confirm
  // abort with ok:true + reason "cancelled"; target-picker fails with ok:false
  // + reason "cancelled". Either is a "never mind", not a chain failure.
  return String(res.reason ?? "").includes("cancelled");
}

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
// itself via the continuation stack: SRW pushed an `srwDetour:*` frame
// before routing to FAW; FAW exits to top.resumeAt = SRW after the
// queue drains, where SRW pops its own frame and re-dispatches for
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

// Every active non-GM non-primary client EXCEPT the reactor's owner.
// Secondary GMs receive the full reaction-menu (same as the primary GM)
// so they are excluded here — they are NOT spectators to reactions.
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
    // Per-ACTIVATION discriminator. A boss/elite with multiple activations per
    // round acts several times as the SAME actor in the SAME round; a bare
    // round+actor scope would dedup a force turn_start reaction (Zero Trigger:
    // Suffering's per-turn ZP gain) to ONCE per round. The current combatant's
    // turnsRemaining differs each activation, so it separates them while still
    // deduping re-entry WITHIN one activation (free-action detour → SRW re-entry).
    const act = payload?.actingActivationsRemaining ?? "?";
    return `${trigger}::r${round}::${actingUuid}::a${act}`;
  }
  return trigger;
}

function entryKey(reactorUuid, rowKey, carrierUuid) {
  return `${reactorUuid}::${rowKey}::${carrierUuid}`;
}

// Read the set of entry-keys whose decision is "fired" or "auto" — i.e.
// the reaction actually ran. These become "Used" stamps on SRW re-entry.
//
// Pre-2026-06-01 the persistence layer ALSO wrote decision: "passed" /
// "aborted" entries which were used to filter candidates out forever.
// That model was reverted (Pass is now window-scoped; aborts re-prompt
// the player); legacy "passed" / "aborted" entries on existing scenes
// are ignored here so they don't surface as bogus "Used" stamps.
function readFiredSet(scene, scopeKey) {
  if (!scene) return new Set();
  try {
    const stored = scene.getFlag(STANDALONE_FLAG_NS, STANDALONE_FLAG_KEY) ?? {};
    const entries = Array.isArray(stored.entries) ? stored.entries : [];
    const out = new Set();
    for (const e of entries) {
      if (e?.scope !== scopeKey) continue;
      const d = String(e?.decision ?? "").toLowerCase();
      if (d === "fired" || d === "auto") {
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
export async function collectReactors(director) {
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
    // Current combatant's remaining activations this round — the per-activation
    // discriminator the fired-set scope uses so multi-activation bosses re-fire
    // turn_start/turn_end reactions each activation (see scopeKeyFor).
    actingActivationsRemaining: subjectTriggers
      ? (director?.dCombat?.current?.turnsRemaining ?? null)
      : null,
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
  scope = null,
  scene = null,
  // skipEvaluated: [{ carrierUuid, rowKey }] entries the caller has
  // already dispatched (pre-resolve pill accepts, cross-trigger relay).
  // Used by post-resolve creature_completes_spell so a Spell that fired
  // pre-resolve passives at CONFIRM doesn't re-prompt the same rows.
  skipEvaluated = null,
  // Firing-phase filter for the transactional instance frame:
  //   "forced" → process only auto-fire (force/on); skip the ask menu.
  //   "ask"    → surface only ask-mode; skip auto-fire (already ran in the
  //              forced pass).
  //   null     → both, in one pass (legacy behavior, all non-phased triggers).
  phase = null,
} = {}) {
  if (!director || !reactor || !token || !trigger) {
    return { cancelled: false, fired: [] };
  }
  const { findPassiveCandidates, firePreAcceptedCandidate, isActionCreatingReaction, isActionCreatingReactionForAE } = await getSkillEffectsExtras();
  const fired = [];

  const skipSet = new Set(
    (Array.isArray(skipEvaluated) ? skipEvaluated : [])
      .map((e) => `${e?.rowKey ?? ""}:${e?.carrierUuid ?? ""}`)
  );

  // Harness override (Phase 2.1): when `__FU_HARNESS_ACCEPT_PASSIVES__`
  // is set, treat askable candidates as auto-accepted/declined without
  // spawning the menu. Mirrors the legacy firePassiveTriggers behavior
  // so existing harness scenarios (acceptPassives: true / per-skill map)
  // keep working when dispatched through this unified menu path.
  function harnessChoiceFor(c) {
    const ov = globalThis.__FU_HARNESS_ACCEPT_PASSIVES__;
    if (ov === undefined || ov === null) return null;
    if (typeof ov === "boolean") return ov;
    if (typeof ov === "object") {
      for (const [name, val] of Object.entries(ov)) {
        if (String(c.carrierName ?? "").includes(name) || name.includes(String(c.carrierName ?? ""))) return !!val;
      }
      return null;
    }
    return null;
  }

  // Used-badge derivation — keep previously-fired reactions VISIBLE
  // (stamped "Used"), don't filter them out. Pass is now window-scoped
  // (see processPass below) — only "fired" / "auto" decisions persist
  // in standaloneFired, and those become the Used stamps on re-entry.
  // The set is scoped per trigger+round (see scopeKeyFor); fired-set
  // is cleared on combat end via persistence.clearAllDirectorStateFlags.
  const firedSet = (scope && scene) ? readFiredSet(scene, scope) : new Set();

  let candidates;
  try {
    // includeUnavailable: surface reactions that fail their condition
    // formula or affordability check as disabled blades with badges
    // ("Low MP" / "Conditions not met") rather than dropping them
    // silently. The MP-bug class (player clicks, nothing happens, no
    // feedback) is what we're guarding against.
    candidates = await findPassiveCandidates({
      casterActor: reactor,
      trigger,
      payload,
      includeUnavailable: true,
    });
  } catch (e) {
    warn(`reaction[${trigger}]: findPassiveCandidates threw for ${reactor?.name}`, e);
    return { cancelled: false, fired: [] };
  }
  // Apply skipEvaluated filter — drop candidates the caller already
  // dispatched in an earlier phase.
  if (skipSet.size) {
    candidates = candidates.filter((c) => !skipSet.has(`${c.rowKey}:${c.carrierUuid}`));
  }
  if (!candidates?.length) return { cancelled: false, fired: [] };

  // Auto-skip ONLY when every candidate has already been used in this
  // scope. "Used" is permanent for the scope, so there's nothing the
  // player can do — spawning a menu of all-stamped blades just to make
  // them click Pass is friction. Other unavailability sources (Low MP,
  // peer-acting, condition formulas) might clear, so those still get
  // shown stamped + the player decides via Pass.
  const allAlreadyUsed = candidates.every((c) =>
    firedSet.has(entryKey(reactor.uuid, c.rowKey, c.carrierUuid))
  );
  if (allAlreadyUsed) {
    log(`reaction[${trigger}]: ${reactor.name} — all candidates already used this scope, auto-skip`);
    return { cancelled: false, fired: [] };
  }

  // Auto-fire "on" + "force" passives silently — but ONLY when they're
  // currently available AND not already-used in this scope. An auto
  // passive that can't pay its cost (or already fired this scope) falls
  // through to the askable list with its badge so the player sees WHY
  // it didn't fire (rather than silently no-op).
  const autoFire = [];
  const askable = [];
  const harnessSkipped = [];
  for (const c of candidates) {
    const isAutoMode = c.mode === "on" || c.mode === "force";
    const wasUsed = firedSet.has(entryKey(reactor.uuid, c.rowKey, c.carrierUuid));
    if (isAutoMode && c.available && !wasUsed) {
      autoFire.push(c);
      continue;
    }
    // Exclude from askable:
    //   - "off" — explicit player opt-out
    //   - "force" — engine-mandatory + UI-invisible per [[force-mode-canonical-rows]]
    //   - wasUsed — already fired/auto'd this scope
    //   - unavailableKind === "condition" — the trigger fundamentally doesn't
    //     apply right now (e.g. Agony with no Bond toward any damaged creature).
    //     Surfacing it is noise / info-leak, matching findPassiveCandidates'
    //     "condition → keep hidden" contract. COST unavailability is different —
    //     "you could react but can't pay" is actionable, so cost-disabled rows
    //     still show dimmed with a badge ("Low MP") so the player knows why.
    if (c.mode === "off" || c.mode === "force" || wasUsed) continue;
    if (c.unavailableKind === "condition") continue;
    if (isAutoMode && !c.available) continue;

    // Harness override — auto-resolve without spawning the menu when the
    // test harness has stamped __FU_HARNESS_ACCEPT_PASSIVES__. true →
    // promote to autoFire; false → silently skip. null/no-match → fall
    // through to interactive askable.
    const harnessChoice = harnessChoiceFor(c);
    if (harnessChoice === true && c.available) autoFire.push(c);
    else if (harnessChoice === false) harnessSkipped.push(c);
    else askable.push(c);
  }
  // Phase: "ask" suppresses auto-fire (force/on already ran in the forced
  // pass); "forced"/null run it.
  for (const c of (phase === "ask" ? [] : autoFire)) {
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

  // Forced pass of the transaction: auto-fires are done; the ask menu is the
  // caller's separate ask pass. Don't surface anything here.
  if (phase === "forced") {
    return { cancelled: false, fired };
  }

  if (!askable.length) {
    // Nothing left to interact with. cancelled stays false — auto-fires
    // (if any) already counted as "fired"; with zero auto-fires the
    // caller sees `{ cancelled: false, fired: [] }` and proceeds.
    return { cancelled: false, fired };
  }

  // Auto-skip when EVERY askable candidate is unavailable. Mirrors the
  // "all already used" auto-skip above: spawning a menu of pure-disabled
  // blades just so the player can click Pass is friction. Spawn-time
  // unavailability sources (`Low MP`, `No Charge`, `Conditions not met`)
  // are intrinsic to the reactor's state at THIS instant and won't clear
  // within the reaction window — there's no in-window event that can
  // refill MP / re-arm a charge / flip a condition formula before the
  // player decides. Peer-acting badges are session-local + set AFTER
  // spawn, so they don't factor into the spawn decision.
  const allUnavailable = askable.every((c) => !c.available);
  if (allUnavailable) {
    log(`reaction[${trigger}]: ${reactor.name} — all askable candidates unavailable, auto-skip`);
    return { cancelled: false, fired };
  }

  // Spawn the interactive menu.
  const ReactionMenu = await getReactionMenu();
  const combatId = director?.combatId ?? director?.dCombat?.id ?? null;
  let resolveClose;
  const closed = new Promise((r) => { resolveClose = r; });

  // When battle end is triggered mid-reaction, the director signals this
  // one-shot promise. All in-flight dispatchReactionMenu calls race against
  // it so their `closed` promise resolves immediately, releasing the lock.
  const interruptPromise = director?._battleEndInterruptPromise ?? null;
  if (interruptPromise) {
    interruptPromise.then(() => resolveClose());
  }

  let remaining = askable.slice();
  let cancelled = false;
  // Three-source disabled-blade overlay (merged at spawn + patch time):
  //   - costBadges:  intrinsic per-reactor unavailability surfaced by
  //                  findPassiveCandidates' affordability walker /
  //                  condition_formula evaluator. Built ONCE here from
  //                  the candidate's `unavailableReason`; never mutated
  //                  thereafter. Re-derived from scratch only on SRW
  //                  re-entry.
  //   - usedBadges:  per-scope "Used" stamp for reactions already fired
  //                  in this trigger window (read from standaloneFired
  //                  scene flag). Built ONCE here; never mutated.
  //                  Permanent for the scope (until combat end).
  //   - peerBadges:  session-local "{Actor} Acting" overlay added by
  //                  stopHandler when a peer commits an action-creating
  //                  reaction. Cleared on SRW re-entry.
  //
  // Priority: peer > used > cost (most-current state wins). Peer is
  // transient ("right now they're acting"); used is permanent for
  // scope; cost is intrinsic-but-recoverable.
  const costBadges = {};
  for (const c of askable) {
    if (!c.available && c.unavailableReason) {
      costBadges[`${c.carrierUuid}::${c.rowKey}`] = c.unavailableReason;
    }
  }
  const usedBadges = {};
  for (const c of askable) {
    if (firedSet.has(entryKey(reactor.uuid, c.rowKey, c.carrierUuid))) {
      usedBadges[`${c.carrierUuid}::${c.rowKey}`] = "Used";
    }
  }
  let peerBadges = {};
  function mergedDisabledLabels() {
    return { ...costBadges, ...usedBadges, ...peerBadges };
  }

  const ownerUserId = resolveReactorOwnerUserId(reactor);
  // Active GMs other than the primary director. They receive the full
  // reaction-menu (same path as the player owner) so they can resolve
  // reactions just like the primary GM.
  const secondaryGmIds = (game.users?.contents ?? [])
    .filter((u) => u.isGM && u.active && u.id !== game.user?.id)
    .map((u) => u.id);
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
      for (const gmId of secondaryGmIds) {
        try {
          channel.broadcastMenuClose({
            targetUserId: gmId,
            kind: "reaction-menu",
            reason: "fired-or-passed",
          });
        } catch (e) { warn(`reaction[${trigger}]: broadcastMenuClose(menu,secondary GM) threw`, e); }
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
      disabledLabels: mergedDisabledLabels(),
    };
  }

  async function processDecision(cand) {
    // GM-side authoritative stale-click safeguard. If a player click
    // arrives for a blade that's currently disabled (peer-acting badge
    // OR cost-walker badge), reject it before firing the chain. Two
    // scenarios this catches:
    //   1) Player click raced a MENU_PATCH — their client hadn't
    //      received the latest disabledLabels yet, so the blade still
    //      looked clickable on their end.
    //   2) Same as #1 but for cost-walker badges that became active
    //      between the initial MENU_OPEN and re-evaluation.
    // The acting reactor's own emit is filtered out at stopHandler
    // entry, so this never blocks the click that TRIGGERED the stop.
    {
      const key = `${cand.carrierUuid}::${cand.rowKey}`;
      // Priority matches mergedDisabledLabels: peer > used > cost.
      const badge = peerBadges[key] ?? usedBadges[key] ?? costBadges[key] ?? null;
      if (badge) {
        log(`reaction[${trigger}]: REJECT stale click on "${cand.carrierName}" (currently disabled: "${badge}")`);
        try { ui.notifications?.info(`${cand.carrierName}: ${badge}`); } catch {}
        return remaining.length > 0;  // keep menu open
      }
    }
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
    // Fire the chain + capture its result. If it aborts (consume_resource
    // insufficient, condition_formula failure on a nested row, etc.) we
    // record the decision as "aborted" rather than "fired" so the
    // reaction stays clickable on SRW re-entry (the player didn't get
    // their action). The action-creating peer-defer is NOT undone — by
    // the time we know the chain failed, peers have already stopped,
    // and re-emitting "resume" would race with their pending stop UI.
    // A cleaner reversal is future work; for now, the safer behavior is
    // to let peers see SRW re-enter (the queue is empty so SRW exits if
    // nothing else fired, or re-dispatches if there's more to do).
    let chainResult = null;
    try {
      chainResult = await firePreAcceptedCandidate({
        director, casterActor: reactor, candidate: cand, payload,
      });
      if (isCancelledResult(chainResult)) {
        // The player backed out of a secondary picker (target selection /
        // option menu) BEFORE committing. That's not a failure — it's
        // "never mind, take me back". Checked FIRST because menu/confirm
        // cancels report ok:true (abort) yet must NOT count as fired. The
        // short-circuit below leaves the candidate clickable + re-renders.
        log(`reaction[${trigger}]: "${cand.carrierName}" cancelled by ${reactor.name} → back to menu`);
      } else if (chainResult?.ok) {
        fired.push(cand);
        log(`reaction[${trigger}]: fired "${cand.carrierName}" for ${reactor.name}`);
      } else {
        log(`reaction[${trigger}]: chain ABORTED for "${cand.carrierName}" (${chainResult?.reason ?? "?"}) — not marking fired`);
        ui.notifications?.warn(`${cand.carrierName} could not fire: ${chainResult?.reason ?? "chain aborted"}`);
      }
    } catch (e) {
      warn(`reaction[${trigger}]: firePreAcceptedCandidate threw for ${cand.carrierName}`, e);
    }
    // Cancellation = back to the menu. Don't write a fired/aborted ledger
    // entry and don't drop the candidate from `remaining` — the reaction
    // stays in the menu so the player can re-pick it (or choose another).
    // Returning keepGoing re-renders the menu via the onPick handler.
    if (isCancelledResult(chainResult)) {
      return remaining.length > 0;
    }
    if (scope && scene) {
      await appendFired(scene, scope, {
        reactorUuid: reactor.uuid, rowKey: cand.rowKey, carrierUuid: cand.carrierUuid,
        decision: chainResult?.ok ? "fired" : "aborted",
      });
    }
    remaining = remaining.filter(
      (r) => !(r.rowKey === cand.rowKey && r.carrierUuid === cand.carrierUuid)
    );
    // Action-creating commits end this reactor's pre-action decision —
    // the player committed to running their free action / spawned card.
    // Closing the menu now (rather than re-rendering with leftover
    // reactions) unblocks SRW so FREE_ACTION_WINDOW can drain the queue
    // and the action plays out. The reactor's un-fired reactions come
    // back on SRW re-entry post-action — standaloneFired only marked
    // the fired one, so the others re-emerge in the next dispatch with
    // freshly re-gated conditions.
    if (isActionCreating && chainResult?.ok) return false;
    // Chain aborted — don't close, let the player try another reaction.
    return remaining.length > 0;
  }

  async function processPass() {
    log(`reaction[${trigger}]: passed for ${reactor.name}`);
    // Pass is WINDOW-SCOPED — don't write standaloneFired entries.
    // On SRW re-entry the reactor's menu re-spawns with the same
    // candidates (any that fired in this scope show stamped "Used"
    // via the usedBadges map). The legacy behavior wrote
    // decision: "passed" for every remaining candidate which filtered
    // them out forever — that was wrong: Pass should mean "save it
    // for later, ask me again next round", not "never offer again".
    cancelled = fired.length === 0;
    remaining = [];
  }

  // Race an intent await across all remote reaction-menu participants:
  // the player owner (if any) + every secondary GM. Returns a combined
  // object whose .then/.catch race via Promise.race and whose .abort
  // cancels every individual await so orphaned awaits don't consume
  // future REACTION_CHOICE intents from the next reaction window.
  function armRemoteAwaits() {
    if (!channel) return null;
    const participantIds = [
      ...(ownerUserId ? [ownerUserId] : []),
      ...secondaryGmIds,
    ];
    if (!participantIds.length) return null;
    const awaits = participantIds.map((uid) => {
      try {
        return channel.awaitIntent(INTENTS.REACTION_CHOICE, {
          fromUserId: uid,
          timeoutMs: 30 * 60 * 1000,
        });
      } catch (e) {
        warn(`reaction[${trigger}]: awaitIntent(${uid}) threw`, e);
        return null;
      }
    }).filter(Boolean);
    if (!awaits.length) return null;
    return {
      abort(reason) { for (const a of awaits) try { a.abort?.(reason); } catch {} },
      then(fn) { return Promise.race(awaits).then(fn); },
      catch(fn) { return Promise.race(awaits).catch(fn); },
    };
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
    for (const gmId of secondaryGmIds) {
      try {
        channel?.broadcastMenuOpen({ targetUserId: gmId, menuSpec: buildPlayerMenuSpec() });
      } catch (e) { warn(`reaction[${trigger}]: broadcastMenuOpen(secondary GM) threw`, e); }
    }
    if (channel && indicatorRecipients.length) {
      const spec = buildIndicatorSpec();
      for (const uid of indicatorRecipients) {
        try {
          channel.broadcastMenuOpen({ targetUserId: uid, menuSpec: spec });
        } catch (e) { warn(`reaction[${trigger}]: broadcastMenuOpen(indicator) threw`, e); }
      }
    }
    const remoteAwait = armRemoteAwaits();
    let localPickFired = false;

    ReactionMenu.spawn({
      director, token,
      candidates: remaining,
      combatId,
      trigger,
      label: menuLabel,
      passLabel,
      disabledLabels: mergedDisabledLabels(),
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
        // Abort remaining awaits so orphaned remote windows don't consume
        // future REACTION_CHOICE intents from the next reaction window.
        try { remoteAwait.abort("remote-won"); } catch {}
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

  // Cross-reactor stop signal — another reactor committed an
  // action-creating reaction. Stamp action-creating blades on MY menu
  // with "{Actor} Acting"; state-only blades + Pass stay clickable.
  // The menu NEVER auto-closes here — even if every blade ends up
  // stamped, the player chooses to Pass manually so the model is
  // legible ("I see what's happening; I'm explicitly bowing out").
  // Pass is window-scoped (see processPass) so passing now doesn't
  // prevent the reactor from getting a fresh menu on SRW re-entry.
  //
  // Update path: in-place DOM mutation via ReactionMenu.updateDisabledLabels
  // (GM-side) + broadcastMenuPatch (player-side). NO despawn+respawn —
  // the entrance-animation replay was the jarring redraw we're avoiding.
  //
  // Source filter: ignore my own emit so the acting reactor doesn't
  // re-stamp itself.
  const stopHandler = async (ev) => {
    const sourceUuid = ev?.detail?.sourceReactorUuid ?? null;
    if (sourceUuid && sourceUuid === reactor.uuid) return;
    const actorName = ev?.detail?.actorName ?? "Someone";
    const blockLabel = `${actorName} Acting`;
    let blockedCount = 0;
    for (const cand of remaining) {
      const key = `${cand.carrierUuid}::${cand.rowKey}`;
      // Already-stamped sources win (per merge priority: peer > used >
      // cost). If cost or used already covers this blade, peer-acting
      // adds no new info. Skip — keeps the existing stamp text.
      if (costBadges[key] || usedBadges[key]) continue;
      let isAC = false;
      try {
        const carrier = await fromUuid(cand.carrierUuid).catch(() => null);
        if (carrier) {
          const cfg = cand.carrierKind === "ae"
            ? carrier?.flags?.["fabula-ultima-companion"]?.reactionConfig?.reaction_config_table
            : carrier?.system?.props?.reaction_config_table;
          const reactionRow = cfg?.[cand.rowKey] ?? null;
          if (reactionRow) {
            isAC = cand.carrierKind === "ae"
              ? isActionCreatingReactionForAE(carrier, reactionRow)
              : isActionCreatingReaction(carrier, reactionRow);
          }
        }
      } catch (e) { warn(`reaction[${trigger}]: classify on stop threw`, e); }
      if (isAC) {
        peerBadges[key] = blockLabel;
        blockedCount++;
      }
    }
    log(`reaction[${trigger}]: ${reactor.name} ${blockedCount} blade(s) blocked by "${actorName}"`);
    // GM-side: directly mutate the open menu's DOM (zero-churn).
    try {
      ReactionMenu.updateDisabledLabels({
        combatId, tokenId: token.id,
        disabledLabels: mergedDisabledLabels(),
      });
    } catch (e) { warn(`reaction[${trigger}]: GM-side updateDisabledLabels threw`, e); }
    // Player-side: send MENU_PATCH; their handler applies the same
    // in-place mutation. Best-effort — lag-resilient. The GM is
    // authoritative; the stale-click safeguard in processDecision
    // handles late clicks against now-stamped blades.
    if (channel && ownerUserId) {
      try {
        channel.broadcastMenuPatch({
          targetUserId: ownerUserId,
          patch: {
            kind: "reaction-menu-disabled",
            combatId,
            tokenId: token.id,
            disabledLabels: mergedDisabledLabels(),
          },
        });
      } catch (e) { warn(`reaction[${trigger}]: broadcastMenuPatch threw`, e); }
    }
    for (const gmId of secondaryGmIds) {
      try {
        channel?.broadcastMenuPatch({
          targetUserId: gmId,
          patch: {
            kind: "reaction-menu-disabled",
            combatId,
            tokenId: token.id,
            disabledLabels: mergedDisabledLabels(),
          },
        });
      } catch (e) { warn(`reaction[${trigger}]: broadcastMenuPatch(secondary GM) threw`, e); }
    }
  };
  _dispatchCoordinator.addEventListener("stop-others", stopHandler);

  try {
    renderMenu();
    await closed;
  } finally {
    _dispatchCoordinator.removeEventListener("stop-others", stopHandler);
  }
  // `deferred` is gone — the auto-close-on-allDisabled branch was
  // removed in favor of always keeping the menu open with stamped
  // blades. Callers that read `deferred` will get undefined (truthy-
  // false), which matches the old "not deferred" case.
  return { cancelled, fired };
}

// Dispatch a standalone trigger across every live reactor. Each reactor's
// menu fires concurrently; the Promise resolves only when ALL reactors
// have resolved their menu (block-the-FSM semantics).
//
// `restrictTo` (optional): when present, only this reactor actor is
// considered — used by turn_start/turn_end to fire only for the
// acting combatant.
export async function dispatchStandaloneTrigger({ director, trigger, restrictTo = null, payload: extraPayload = null, phase = null } = {}) {
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
      scope,
      scene,
      phase,
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
