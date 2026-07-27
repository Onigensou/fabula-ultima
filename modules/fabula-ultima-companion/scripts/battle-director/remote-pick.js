// remote-pick.js — route a secondary picker (target selection / option-menu)
// to a specific player's client and await their choice on the GM.
//
// Why this exists: when a player applies a reaction on the action card, the
// GM resolves it (recordPillDecision runs on the GM, which holds the
// payload/director state). Any secondary UI the resolution needs — Protect's
// target pick, Barrage's add-target pick, an option-menu — used to render on
// the GM's screen. This module ferries ONLY the picker UI to the initiating
// player: the GM computes the choices, broadcasts a spec, the player renders
// the SAME local picker (target-picker / list-picker) and emits the result
// back, and the GM resumes resolution with it. Nothing commits until the
// player confirms; the GM's card stays visible the whole time.
//
// Round-trip modelled on standalone-reactions.js ↔ reaction-menu-player.js.
// See [[director-player-driven-input]].

import { INTENTS } from "./intents.js";
import { log, warn } from "./logger.js";

// Menu kinds carried over the IntentChannel for the two leaf pickers.
export const REMOTE_PICK_KINDS = Object.freeze({
  LIST:   "reaction-pick-list",    // list-picker.pickFromList
  TARGET: "reaction-pick-target",  // target-picker.requestTargeting
  NUMBER: "reaction-pick-number",  // number-picker.promptNumberDialog
});

// Every kind renderLocalPick knows how to draw. The player-side responder
// gates on this set, so adding a kind above wires both ends at once.
const RENDERABLE_KINDS = new Set(Object.values(REMOTE_PICK_KINDS));

// A `remotePrompt` object is { channel, targetUserId, combatId }. It rides
// through the effect ctx (ctx.remotePrompt) and the target picker's `remote`
// param. When present, the leaf picker calls remotePick() instead of
// rendering locally.

// Render the leaf picker (list or target) LOCALLY on this client and resolve
// with its picked value (null / cancelled-shape on cancel). Shared by the GM's
// active-racer fallback in remotePick() and the player-side responder, so both
// ends render IDENTICAL choices from the same `spec` (no drift). `externalCancel`
// (a thenable) tears the open picker down early.
async function renderLocalPick({ kind, spec = {}, externalCancel = null }) {
  if (kind === REMOTE_PICK_KINDS.LIST) {
    const { pickFromList } = await import("./list-picker.js");
    return await pickFromList({
      title: spec.title,
      subtitle: spec.subtitle ?? null,
      options: spec.options ?? null,
      sections: spec.sections ?? null,
      zIndex: spec.zIndex ?? 97,
      cancelLabel: spec.cancelLabel ?? "Cancel",
      // Multi-select relay: an open_action_menu with menu_pick_count > 1 broadcasts a
      // multi-select spec. Without forwarding these fields the reaction OWNER's client
      // would fall back to a single-select menu (different UI than the GM intended /
      // than a local pick would show). Defaults keep every single-select spec identical.
      multiSelect: spec.multiSelect ?? false,
      maxSelect: spec.maxSelect ?? 0,
      preselectAll: spec.preselectAll ?? false,
      preselect: spec.preselect ?? null,
      confirmLabel: spec.confirmLabel ?? "Confirm",
      externalCancel,
    });
  }
  if (kind === REMOTE_PICK_KINDS.NUMBER) {
    const { promptNumberDialog } = await import("./number-picker.js");
    return await promptNumberDialog({
      label: spec.label,
      min: spec.min,
      max: spec.max,
      step: spec.step ?? 1,
      def: spec.def,
      title: spec.title,
      externalCancel,
    });
  }
  const { requestTargeting } = await import("./target-picker.js");
  return await requestTargeting({
    director: null,
    eligible: spec.eligible ?? [],
    mode: spec.mode ?? "exact",
    count: spec.count ?? 1,
    titleText: spec.titleText ?? null,
    cancelLabel: spec.cancelLabel ?? "Cancel",
    secondaryAction: spec.secondaryAction ?? null,
    randomizeCount: !!spec.randomizeCount,
    randomPool: spec.randomPool ?? null,
    lockSelection: !!spec.lockSelection,
    mandatoryTokenUuids: spec.mandatoryTokenUuids ?? [],
    externalCancel,
  });
}

// GM-side: send a pick request to `targetUserId` AND render the same picker
// locally on the GM, racing the two ("active racer"). Whoever commits first
// wins; the loser is torn down. Returns the winning picker's value, or the
// `onTimeoutValue` cancel-sentinel.
//
// Why race instead of a blind await: the choice happens mid-resolve on an
// action that ISN'T COMMITTED yet (a player-cast spell's element pick, a
// Protect/Barrage target pick). Awaiting only the player left the GM with NO
// UI and no recourse if the player disconnected — the GM "lost the menu" while
// the action hung. Now the GM holds a live local copy and can finish it,
// exactly like the GM-local composeAction fallback in DECLARE. The GM already
// has the full `spec`, so its local picker shows the same choices.
//
// `externalCancel` (a thenable) lets the GM's caller tear the whole prompt down
// early (e.g. the card resolved by another path).
export async function remotePick({
  channel,
  targetUserId,
  combatId = null,
  kind,
  spec = {},
  timeoutMs = 30 * 60 * 1000,
  externalCancel = null,
  onTimeoutValue = null,
} = {}) {
  if (!channel || !targetUserId || !kind) {
    warn("remotePick: missing channel/targetUserId/kind — cannot route");
    return onTimeoutValue;
  }
  const requestId = foundry.utils?.randomID?.() ?? `pick-${Date.now()}`;
  // Arm the await BEFORE broadcasting so a fast player reply can't race ahead
  // of the listener registration.
  let awaitP;
  try {
    awaitP = channel.awaitIntent(INTENTS.REMOTE_PICK_RESULT, { fromUserId: targetUserId, timeoutMs });
  } catch (e) {
    warn("remotePick: awaitIntent threw", e);
    return onTimeoutValue;
  }
  try {
    channel.broadcastMenuOpen({ targetUserId, menuSpec: { kind, requestId, combatId, ...spec } });
  } catch (e) {
    warn("remotePick: broadcastMenuOpen threw", e);
    try { awaitP.abort?.("broadcast-failed"); } catch {}
    return onTimeoutValue;
  }

  // GM-local picker tear-down signal (fired when the player wins / external
  // cancel) so the GM's copy closes instead of lingering.
  let gmCancelFire = null;
  const gmCancel = new Promise((res) => { gmCancelFire = res; });

  return await new Promise((resolveRace) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      // Tear down whichever side didn't win: stop awaiting the player, close the
      // GM-local picker, and uncache + dismiss the player's open picker (a
      // reconnect replay must not resurrect an already-answered prompt).
      try { awaitP.abort?.("race-settled"); } catch {}
      try { gmCancelFire?.(); } catch {}
      try { channel.broadcastMenuClose({ targetUserId, kind, data: { requestId } }); } catch {}
      resolveRace(value ?? onTimeoutValue);
    };

    // GM's caller tore the whole prompt down (card resolved another way).
    if (externalCancel && typeof externalCancel.then === "function") {
      externalCancel.then(() => finish(onTimeoutValue)).catch(() => {});
    }

    // Player branch — their reply wins the race.
    awaitP.then((intent) => {
      const body = intent?.body ?? {};
      if (body.requestId && body.requestId !== requestId) {
        warn(`remotePick(${kind}): requestId mismatch (${body.requestId} ≠ ${requestId}) — using value anyway`);
      }
      finish(body.value ?? onTimeoutValue);
    }).catch((e) => {
      // Timeout / abort / external-cancel — do NOT settle here; the GM-local
      // picker is still live and will resolve the race (its catch settles with
      // onTimeoutValue if it too dies).
      log(`remotePick(${kind}): player await ended (${e?.message ?? e})`);
    });

    // GM-local branch — the active racer.
    renderLocalPick({ kind, spec, externalCancel: gmCancel })
      .then((value) => finish(value))
      .catch((e) => {
        warn(`remotePick(${kind}): GM-local picker threw`, e);
        finish(onTimeoutValue);
      });
  });
}

// GM-side: broadcast ONE pick request to MULTIPLE players and resolve on the
// FIRST valid reply (the "loudest wins" model — Cruel Ultimatum's enemy choice).
// All targets share one requestId; the first player to answer wins, the losers'
// open pickers are force-closed via MENU_CLOSE (their picker tears down through
// `externalCancel`, see registerRemotePickResponder). On all-timeout / all-offline
// returns onTimeoutValue (caller falls back to a local pick).
//
// Returns `{ value, winnerUserId }` — `value` is the answering player's pick (or
// onTimeoutValue if nobody answered); `winnerUserId` identifies WHO answered so
// the caller can route any FOLLOW-ON picks to the same player (Cruel Ultimatum:
// whoever chose branch A then chooses which enemy). Single-target calls delegate
// to remotePick.
export async function remotePickAny({
  channel,
  targetUserIds = [],
  combatId = null,
  kind,
  spec = {},
  timeoutMs = 30 * 60 * 1000,
  externalCancel = null,
  onTimeoutValue = null,
} = {}) {
  const uids = Array.from(new Set((targetUserIds ?? []).filter(Boolean)));
  if (!channel || !uids.length || !kind) {
    warn("remotePickAny: missing channel/targetUserIds/kind — cannot route");
    return { value: onTimeoutValue, winnerUserId: null };
  }
  if (uids.length === 1) {
    const v = await remotePick({ channel, targetUserId: uids[0], combatId, kind, spec, timeoutMs, externalCancel, onTimeoutValue });
    return { value: v, winnerUserId: (v == null || v === onTimeoutValue) ? null : uids[0] };
  }
  const requestId = foundry.utils?.randomID?.() ?? `pick-${Date.now()}`;
  // Arm one await per user BEFORE broadcasting so a fast reply can't race the
  // listener registration. Tag each so the winner is identifiable.
  const armed = uids.map((uid) => {
    try {
      const p = channel.awaitIntent(INTENTS.REMOTE_PICK_RESULT, { fromUserId: uid, timeoutMs });
      return { uid, p, tagged: p.then((intent) => ({ uid, intent })) };
    } catch (e) {
      warn(`remotePickAny: awaitIntent threw for ${uid}`, e);
      return { uid, p: null, tagged: Promise.reject(e) };
    }
  });
  try { channel.broadcastMenuOpen({ targetUserIds: uids, menuSpec: { kind, requestId, combatId, ...spec } }); }
  catch (e) { warn("remotePickAny: broadcastMenuOpen threw", e); }
  let cancelHooked = null;
  if (externalCancel && typeof externalCancel.then === "function") {
    cancelHooked = externalCancel.then(() => {
      for (const a of armed) { try { a.p?.abort?.("external-cancel"); } catch {} }
    }).catch(() => {});
  }
  const closeAll = () => {
    try { channel.broadcastMenuClose({ targetUserIds: uids, kind, data: { requestId } }); } catch {}
  };
  let winnerUid = null, intent = null;
  try {
    // First FULFILLED wins; rejections (timeout/abort) are ignored until all fail.
    const res = await Promise.any(armed.map((a) => a.tagged));
    winnerUid = res.uid; intent = res.intent;
  } catch {
    log(`remotePickAny(${kind}): no reply from any of ${uids.length} target(s) — cancelled`);
    closeAll();
    return { value: onTimeoutValue, winnerUserId: null };
  } finally {
    if (cancelHooked) { /* settles harmlessly */ }
  }
  // Abort the losers' awaits + force-close every target's picker (winner already
  // closed theirs by clicking; the close is a harmless uncache for them).
  for (const a of armed) { if (a.uid !== winnerUid) { try { a.p?.abort?.("another-answered"); } catch {} } }
  closeAll();
  const body = intent?.body ?? {};
  if (body.requestId && body.requestId !== requestId) {
    warn(`remotePickAny(${kind}): requestId mismatch (${body.requestId} ≠ ${requestId}) — using value anyway`);
  }
  return { value: body.value ?? onTimeoutValue, winnerUserId: winnerUid };
}

// Player-side: register a handler that renders the local picker when the GM
// broadcasts a pick request, then emits REMOTE_PICK_RESULT with the result.
// Returns an unregister function. Registered once at boot on non-GM clients.
export function registerRemotePickResponder(channel) {
  // Requests whose picker is currently rendered on this client. Guards
  // against a same-requestId MENU_OPEN replay (the GM re-replays its
  // _recentBroadcasts cache on our reconnect re-announce — see
  // director-boot.js) stacking a SECOND picker on top of the one already
  // open. A genuinely-missed broadcast (socket was down when it fired) has
  // no entry here, so it still renders; an already-open picker is kept.
  const activeRequestIds = new Set();
  return channel.onMenuOpen(async (menuSpec) => {
    if (game.user?.isGM) return;
    const kind = menuSpec?.kind;
    if (!RENDERABLE_KINDS.has(kind)) return;
    const requestId = menuSpec?.requestId ?? null;
    if (requestId && activeRequestIds.has(requestId)) {
      log(`registerRemotePickResponder(${kind}): duplicate MENU_OPEN for requestId ${requestId} — picker already open, ignoring`);
      return;
    }
    if (requestId) activeRequestIds.add(requestId);
    const reply = (value) => {
      try {
        channel.emit({
          type: INTENTS.REMOTE_PICK_RESULT,
          body: { requestId: menuSpec.requestId, value },
          combatId: menuSpec.combatId ?? null,
        });
      } catch (e) { warn("registerRemotePickResponder: emit threw", e); }
    };
    // Force-close hook — when the GM broadcasts MENU_CLOSE for THIS pick (a
    // multi-target race another player won, or a GM teardown), tear our open
    // picker down via its `externalCancel`. Scoped by kind + requestId so an
    // unrelated close doesn't dismiss us. Unhooked once the picker settles.
    let closeFire = null;
    const closeSignal = new Promise((res) => { closeFire = res; });
    const offClose = channel.onMenuClose((payload) => {
      if (payload?.kind && payload.kind !== kind) return;
      if (payload?.data?.requestId && payload.data.requestId !== menuSpec.requestId) return;
      closeFire?.();
    });
    try {
      // Render the SAME leaf picker the GM races locally (see renderLocalPick).
      // closeSignal tears it down when the GM broadcasts MENU_CLOSE for this
      // pick (the GM won the race, a sibling answered, or a teardown).
      const value = await renderLocalPick({ kind, spec: menuSpec, externalCancel: closeSignal });
      reply(value);
    } catch (e) {
      warn(`registerRemotePickResponder(${kind}): picker threw`, e);
      // Reply with a cancelled-shaped value so the GM doesn't hang to timeout.
      reply(kind === REMOTE_PICK_KINDS.TARGET
        ? { ok: false, cancelled: true, tokenUuids: [] }
        : null);
    } finally {
      if (requestId) activeRequestIds.delete(requestId);
      try { offClose?.(); } catch {}
    }
  });
}
