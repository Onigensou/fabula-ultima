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
});

// A `remotePrompt` object is { channel, targetUserId, combatId }. It rides
// through the effect ctx (ctx.remotePrompt) and the target picker's `remote`
// param. When present, the leaf picker calls remotePick() instead of
// rendering locally.

// GM-side: send a pick request to `targetUserId`, await their result intent,
// and return the value the player's picker produced. On timeout / abort /
// offline player, returns the `onTimeoutValue` (a "cancelled" sentinel the
// caller maps to its own cancel shape). `externalCancel` (a thenable) lets the
// GM tear the prompt down early (e.g. the card resolved by another path).
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
  let cancelHooked = null;
  if (externalCancel && typeof externalCancel.then === "function") {
    cancelHooked = externalCancel.then(() => {
      try { awaitP.abort?.("external-cancel"); } catch {}
    }).catch(() => {});
  }
  let intent = null;
  try {
    intent = await awaitP;
  } catch (e) {
    log(`remotePick(${kind}): no result (${e?.message ?? e}) — treating as cancelled`);
    try { channel.broadcastMenuClose({ targetUserId, kind }); } catch {}
    return onTimeoutValue;
  } finally {
    if (cancelHooked) { /* settled or will settle harmlessly */ }
  }
  // Uncache the request broadcast so a player reconnect (PLAYER_HELLO replay)
  // doesn't resurrect an already-answered picker.
  try { channel.broadcastMenuClose({ targetUserId, kind }); } catch {}
  // requestId guard — ignore a stray reply from a prior request (sequential
  // picks make this rare, but cheap to verify).
  const body = intent?.body ?? {};
  if (body.requestId && body.requestId !== requestId) {
    warn(`remotePick(${kind}): requestId mismatch (${body.requestId} ≠ ${requestId}) — using value anyway`);
  }
  return body.value ?? onTimeoutValue;
}

// Player-side: register a handler that renders the local picker when the GM
// broadcasts a pick request, then emits REMOTE_PICK_RESULT with the result.
// Returns an unregister function. Registered once at boot on non-GM clients.
export function registerRemotePickResponder(channel) {
  return channel.onMenuOpen(async (menuSpec) => {
    if (game.user?.isGM) return;
    const kind = menuSpec?.kind;
    if (kind !== REMOTE_PICK_KINDS.LIST && kind !== REMOTE_PICK_KINDS.TARGET) return;
    const reply = (value) => {
      try {
        channel.emit({
          type: INTENTS.REMOTE_PICK_RESULT,
          body: { requestId: menuSpec.requestId, value },
          combatId: menuSpec.combatId ?? null,
        });
      } catch (e) { warn("registerRemotePickResponder: emit threw", e); }
    };
    try {
      if (kind === REMOTE_PICK_KINDS.LIST) {
        const { pickFromList } = await import("./list-picker.js");
        const value = await pickFromList({
          title: menuSpec.title,
          subtitle: menuSpec.subtitle ?? null,
          options: menuSpec.options ?? null,
          sections: menuSpec.sections ?? null,
          zIndex: menuSpec.zIndex ?? 97,
          cancelLabel: menuSpec.cancelLabel ?? "Cancel",
        });
        reply(value);
      } else {
        const { requestTargeting } = await import("./target-picker.js");
        const value = await requestTargeting({
          director: null,
          eligible: menuSpec.eligible ?? [],
          mode: menuSpec.mode ?? "exact",
          count: menuSpec.count ?? 1,
          titleText: menuSpec.titleText ?? null,
          cancelLabel: menuSpec.cancelLabel ?? "Cancel",
          secondaryAction: menuSpec.secondaryAction ?? null,
          randomizeCount: !!menuSpec.randomizeCount,
          randomPool: menuSpec.randomPool ?? null,
          lockSelection: !!menuSpec.lockSelection,
        });
        reply(value);
      }
    } catch (e) {
      warn(`registerRemotePickResponder(${kind}): picker threw`, e);
      // Reply with a cancelled-shaped value so the GM doesn't hang to timeout.
      reply(kind === REMOTE_PICK_KINDS.TARGET
        ? { ok: false, cancelled: true, tokenUuids: [] }
        : null);
    }
  });
}
