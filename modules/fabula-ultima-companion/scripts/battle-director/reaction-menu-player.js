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
// Visibility (Rule 1 from [[reaction-architecture]]): the GM-side
// dispatcher (`standalone-reactions.js`) broadcasts MENU_OPEN ONLY
// to the reactor's owner. Non-owners receive no broadcast and see
// no menu — they'll get a stage-2 ally-indicator broadcast in a
// follow-up slice. Stage-3 broadcast (applied chip visible to all)
// is also a follow-up.
//
// Ordering (Rule 2): clicks race the GM-local menu via the existing
// `awaitIntent` / Promise-race pattern. First click wins; the loser's
// menu is dismissed via `MENU_CLOSE`.

import { log, warn } from "./logger.js";
import { INTENTS } from "./intents.js";
import { ReactionMenu } from "./reaction-menu.js";

// Public: register the handler on a given IntentChannel. Call from
// boot on every client (GM + players). The handler no-ops on the GM
// client because the GM spawns the menu directly via the dispatcher.
//
// Returns an unregister callback.
export function registerPlayerReactionMenuHandler(channel) {
  if (!channel) return () => {};

  const offOpen = channel.onMenuOpen(async (menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "reaction-menu") return;
    // GM-side spawns directly via the dispatcher's local path; the
    // broadcast is for non-GM players only. Skipping here prevents
    // the GM from getting a duplicate menu.
    if (game.user?.isGM) return;
    try {
      const tokenDoc = await fromUuid(menuSpec.tokenUuid);
      if (!tokenDoc) {
        warn(`reaction-menu MENU_OPEN: token not found ${menuSpec.tokenUuid}`);
        return;
      }
      // Make sure the player is viewing the combat scene so the canvas
      // anchor resolves. Same trick as turn-ui — scene.view() switches
      // the local viewport without affecting other clients.
      const tokenScene = tokenDoc.parent;
      if (tokenScene && tokenScene.id !== canvas?.scene?.id) {
        log(`reaction-menu MENU_OPEN: switching player view to ${tokenScene.name}`);
        try { await tokenScene.view(); } catch (e) { warn("scene.view threw", e); }
      }
      const token = tokenDoc.object ?? canvas?.tokens?.get(tokenDoc.id);
      if (!token) {
        warn(`reaction-menu MENU_OPEN: token not on canvas ${menuSpec.tokenUuid}`);
        return;
      }

      ReactionMenu.spawn({
        director: null,  // player-side has no director ref; not used by the menu module
        token,
        combatId: menuSpec.combatId,
        candidates: menuSpec.candidates,
        trigger: menuSpec.trigger,
        label: menuSpec.label,
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

  const offClose = channel.onMenuClose((payload) => {
    if (payload?.kind && payload.kind !== "reaction-menu") return;
    if (game.user?.isGM) return;
    // Player-side: dismiss every reaction menu — the GM's authoritative
    // close (e.g. after applying a candidate, after dispatch ends).
    // Per-token despawn is a future refinement; the common case has
    // one reaction menu open at a time per player.
    try { ReactionMenu.despawnAll(); } catch {}
  });

  return () => {
    try { offOpen?.(); } catch {}
    try { offClose?.(); } catch {}
  };
}
