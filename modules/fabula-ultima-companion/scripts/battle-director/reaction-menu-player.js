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

// Public: register the handler on a given IntentChannel. Call from
// boot on every client (GM + players). The handler no-ops on the GM
// client because the GM spawns the menu directly via the dispatcher.
//
// Returns an unregister callback.
export function registerPlayerReactionMenuHandler(channel) {
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

  const offOpen = channel.onMenuOpen(async (menuSpec) => {
    if (!menuSpec) return;
    // GM-side spawns directly via the dispatcher's local path; the
    // broadcast is for non-GM players only. Skipping here prevents
    // the GM from getting a duplicate menu / indicator.
    if (game.user?.isGM) return;

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
      const token = await resolveCanvasToken(menuSpec.tokenUuid, "reaction-menu MENU_OPEN");
      if (!token) return;

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
          // candidate + broadcasts MENU_CLOSE.
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
          // Close the local menu — the GM may rebroadcast with the
          // remaining candidates if there are any. Until then the menu
          // is gone client-side.
          ReactionMenu.despawn({ combatId: menuSpec.combatId, tokenId: token.id });
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
        },
      });
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
    if (game.user?.isGM) return;
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
    if (game.user?.isGM) return;
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
    // director.stop or scene-change clears everything.
    try { ReactionMenu.despawnAll(); } catch {}
    if (!kind) {
      try { ReactionIndicator.despawnAll(); } catch {}
    }
  });

  return () => {
    try { offOpen?.(); } catch {}
    try { offPatch?.(); } catch {}
    try { offClose?.(); } catch {}
  };
}
