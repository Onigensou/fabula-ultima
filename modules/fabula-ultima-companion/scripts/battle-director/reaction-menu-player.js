// Player-side reaction-menu handler.
//
// Listens for `MENU_OPEN` broadcasts with `kind: "reaction-menu"` and
// spawns the token-anchored menu on the player's own client. Each
// blade click emits `INTENTS.REACTION_CHOICE` back to the GM which
// applies the candidate via `firePreAcceptedCandidate`.
//
// Mirrors the canonical pattern used by `turn-ui.js`'s
// `registerPlayerTurnUiHandler` — player observes the broadcast,
// renders locally, emits an intent on pick.
//
// Visibility (Rule 1 from [[reaction-architecture]]):
//   - The reactor's OWNER receives `kind: "reaction-menu"` and gets
//     the actionable menu (this handler's primary path).
//   - Every OTHER active player receives `kind: "reaction-indicator"`
//     and gets a dimmed dashed pill ("Alice reacting…") over the
//     reactor's token — Stage 2 visibility. No interaction.
//   - Stage 3 (applied chip visible to all) is a follow-up slice.
//
// Ordering (Rule 2): clicks race the GM-local menu via the existing
// `awaitIntent` / Promise-race pattern. First click wins; the loser's
// menu is dismissed via `MENU_CLOSE`.

import { log, warn } from "./logger.js";
import { INTENTS } from "./intents.js";
import { ReactionMenu } from "./reaction-menu.js";
import { ReactionIndicator } from "./reaction-indicator.js";

// How long the player's token menu waits after picking a blade for the GM to
// acknowledge before assuming the click was lost (dropped socket / GM not
// listening) and re-spawning the menu so they can pick again. The GM sends a
// "reaction-menu-ack" patch the instant it receives the pick, so a slow
// resolution does NOT trip this. Matches the action-card pill net's window.
const REACTION_SUBMIT_TIMEOUT_MS = 8000;

// Public: register the handler on a given IntentChannel. Call from
// boot on every client (GM + players). The handler no-ops on the GM
// client because the GM spawns the menu directly via the dispatcher.
//
// Returns an unregister callback.
export function registerPlayerReactionMenuHandler(channel, isActiveDirector = () => false) {
  if (!channel) return () => {};

  // Resolve a token doc → on-canvas PIXI Token. Switches the local view
  // to the token's scene if necessary so the anchor coordinates resolve.
  // Returns null if the token can't be located or placed.
  async function resolveCanvasToken(tokenUuid, contextLabel) {
    const tokenDoc = await fromUuid(tokenUuid);
    if (!tokenDoc) {
      warn(`${contextLabel}: token not found ${tokenUuid}`);
      return null;
    }
    const tokenScene = tokenDoc.parent;
    if (tokenScene && tokenScene.id !== canvas?.scene?.id) {
      log(`${contextLabel}: switching player view to ${tokenScene.name}`);
      try { await tokenScene.view(); } catch (e) { warn("scene.view threw", e); }
    }
    const token = tokenDoc.object ?? canvas?.tokens?.get(tokenDoc.id);
    if (!token) {
      warn(`${contextLabel}: token not on canvas ${tokenUuid}`);
      return null;
    }
    return token;
  }

  // No-response re-spawn timers, keyed by `${combatId}:${tokenId}`. Armed when
  // the player picks a blade (the menu despawns immediately on click); cleared
  // by the GM's ack, by the GM's authoritative close/rebroadcast, or by firing
  // (which re-spawns the menu so the player can retry a lost pick).
  const pendingResend = new Map();
  const resendKey = (combatId, tokenId) => `${combatId ?? "no-combat"}:${tokenId ?? "no-token"}`;
  function clearResend(key) {
    const e = pendingResend.get(key);
    if (e) { try { clearTimeout(e.timer); } catch {} pendingResend.delete(key); }
  }
  function clearAllResend() {
    for (const e of pendingResend.values()) { try { clearTimeout(e.timer); } catch {} }
    pendingResend.clear();
  }

  // Resolve the token + spawn the actionable reaction menu. Reused for the
  // initial GM broadcast AND for the no-response re-spawn, so a lost pick
  // restores an identical, clickable menu.
  async function spawnReactionMenu(menuSpec) {
    const token = await resolveCanvasToken(menuSpec.tokenUuid, "reaction-menu MENU_OPEN");
    if (!token) return;
    const key = resendKey(menuSpec.combatId, token.id);
    clearResend(key); // a fresh spawn supersedes any pending re-send for this token
    const armResend = () => {
      clearResend(key);
      const timer = setTimeout(() => {
        pendingResend.delete(key);
        // No GM ack within the window — the pick was likely lost. Re-spawn the
        // menu so the player can try again instead of being left with no UI.
        spawnReactionMenu(menuSpec);
        try { ui.notifications?.warn("No response from the host — pick your reaction again."); } catch {}
      }, REACTION_SUBMIT_TIMEOUT_MS);
      pendingResend.set(key, { timer });
    };
    ReactionMenu.spawn({
      director: null,  // player-side has no director ref; not used by the menu module
      token,
      combatId: menuSpec.combatId,
      candidates: menuSpec.candidates,
      trigger: menuSpec.trigger,
      label: menuSpec.label,
      passLabel: menuSpec.passLabel,
      disabledLabels: menuSpec.disabledLabels ?? null,
      onPick: (cand) => {
        // Emit REACTION_CHOICE back to the GM. The GM-side awaitIntent
        // in standalone-reactions.js picks this up + applies the
        // candidate + broadcasts MENU_CLOSE (or a rebroadcast with the
        // remaining candidates).
        channel.emit({
          type: INTENTS.REACTION_CHOICE,
          body: {
            reactorActorUuid: menuSpec.reactorActorUuid,
            rowKey: cand.rowKey,
            carrierUuid: cand.carrierUuid,
            decision: "apply",
          },
          combatId: menuSpec.combatId,
        });
        // Close the local menu — the GM may rebroadcast with the remaining
        // candidates if there are any. Arm the no-response net in case the
        // pick was lost on the wire.
        ReactionMenu.despawn({ combatId: menuSpec.combatId, tokenId: token.id });
        armResend();
      },
      onPass: () => {
        channel.emit({
          type: INTENTS.REACTION_CHOICE,
          body: {
            reactorActorUuid: menuSpec.reactorActorUuid,
            rowKey: null,
            carrierUuid: null,
            decision: "pass",
          },
          combatId: menuSpec.combatId,
        });
        ReactionMenu.despawn({ combatId: menuSpec.combatId, tokenId: token.id });
        armResend();
      },
    });
  }

  const offOpen = channel.onMenuOpen(async (menuSpec) => {
    if (!menuSpec) return;
    // Primary GM spawns menus directly via the dispatcher's local path;
    // skip here to avoid duplicates. Secondary GMs (no active director)
    // receive menus via socket just like players.
    if (isActiveDirector()) return;

    // Indicator branch — dimmed dashed pill rendered to non-owner
    // allies. Stage 2 visibility (Rule 1). No interaction.
    //
    // Two indicator surfaces share this branch:
    //   - "reaction-indicator"    — someone's reaction window is open.
    //   - "turn-action-indicator" — someone is composing their turn.
    // Both render the same dimmed pill; only the label differs.
    if (menuSpec.kind === "reaction-indicator" || menuSpec.kind === "turn-action-indicator") {
      try {
        const token = await resolveCanvasToken(menuSpec.tokenUuid, `${menuSpec.kind} MENU_OPEN`);
        if (!token) return;
        ReactionIndicator.spawn({
          token,
          combatId: menuSpec.combatId,
          label: menuSpec.label,
          trigger: menuSpec.trigger,
        });
      } catch (e) {
        warn(`${menuSpec.kind} MENU_OPEN handler threw`, e);
      }
      return;
    }

    if (menuSpec.kind !== "reaction-menu") return;
    try {
      await spawnReactionMenu(menuSpec);
    } catch (e) {
      warn("reaction-menu MENU_OPEN handler threw", e);
    }
  });

  // In-place patch for an already-open reaction menu. Refreshes the
  // disabled-blade overlay (peer-acting / unaffordable labels) WITHOUT
  // tearing down the menu. ReactionMenu.updateDisabledLabels returns
  // false silently when there's no instance for this token (lagged
  // client missed the prior MENU_OPEN — we just drop the patch; the
  // next MENU_OPEN will carry the fresh disabledLabels baked in).
  const offPatch = channel.onMenuPatch((patch) => {
    if (isActiveDirector()) return;
    // GM acknowledged a pick — the click landed; cancel the no-response
    // re-spawn timer for this token (the close / rebroadcast follows).
    if (patch?.kind === "reaction-menu-ack") {
      clearResend(resendKey(patch.combatId, patch.tokenId));
      return;
    }
    if (!patch || patch.kind !== "reaction-menu-disabled") return;
    try {
      ReactionMenu.updateDisabledLabels({
        combatId: patch.combatId,
        tokenId: patch.tokenId,
        disabledLabels: patch.disabledLabels ?? {},
      });
    } catch (e) {
      warn("reaction-menu MENU_PATCH handler threw", e);
    }
  });

  const offClose = channel.onMenuClose((payload) => {
    if (isActiveDirector()) return;
    const kind = payload?.kind;
    if (kind === "reaction-indicator" || kind === "turn-action-indicator") {
      // Per-actor close when the GM carries a tokenUuid; otherwise
      // sweep all indicators (defensive — e.g. forced teardown).
      const tokenUuid = payload?.data?.tokenUuid;
      const combatId  = payload?.data?.combatId ?? null;
      if (tokenUuid) {
        try { ReactionIndicator.despawn({ combatId, tokenUuid }); } catch {}
      } else {
        try { ReactionIndicator.despawnAll(); } catch {}
      }
      return;
    }
    if (kind && kind !== "reaction-menu") return;
    // Player-side: dismiss every reaction menu — the GM's authoritative
    // close (e.g. after applying a candidate, after dispatch ends).
    // Untyped close (kind=null) sweeps menu + indicator so a
    // director.stop or scene-change clears everything. The authoritative
    // close means the GM responded, so cancel any pending re-spawn timers.
    clearAllResend();
    try { ReactionMenu.despawnAll(); } catch {}
    if (!kind) {
      try { ReactionIndicator.despawnAll(); } catch {}
    }
  });

  return () => {
    try { clearAllResend(); } catch {}
    try { offOpen?.(); } catch {}
    try { offPatch?.(); } catch {}
    try { offClose?.(); } catch {}
  };
}
