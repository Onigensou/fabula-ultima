/**
 * [ONI] Opportunity System — Action Pipeline Hook
 *
 * Detects critical hits on action cards via renderChatMessage.
 * Fires BEFORE reactions (which trigger on Confirm, after AdvanceDamage).
 *
 * Only the attacker's owner sees the picker — other clients silently skip.
 * In-memory dedup Set prevents double-offers when the card is re-rendered.
 */
(() => {
  const TAG       = "[ONI][OpportunitySystem:ActionHook]";
  const MODULE_ID = "fabula-ultima-companion";

  // Tracks action card IDs that have already had an opportunity offered this session.
  // Cleared on page reload — intentional, same as reaction system's grace locks.
  const _offeredCards = new Set();

  Hooks.on("renderChatMessage", async (msg, html) => {
    // Must be an action card
    const flags = msg.flags?.[MODULE_ID];
    const card  = flags?.actionCard;
    if (!card) return;

    // Must be a crit (not a fumble — fumble overrides crit per game rules)
    const payload  = card.payload;
    const accuracy = payload?.accuracy;
    if (!accuracy?.isCrit || accuracy?.isFumble) return;

    // Dedup — don't re-offer on re-renders (reactions update the card)
    const actionCardId = card.actionCardId;
    if (!actionCardId) return;
    if (_offeredCards.has(actionCardId)) return;

    // Only the attacker's owner processes this on their client
    const ownerUserId = payload?.meta?.ownerUserId;
    if (ownerUserId && game.user.id !== ownerUserId) return;

    // Stamp immediately before the async dialog opens — prevents a second
    // renderChatMessage (which can fire while the dialog is awaiting) from re-triggering.
    _offeredCards.add(actionCardId);

    const sys = globalThis.ONI?.OpportunitySystem;
    if (!sys) {
      console.error(TAG, "ONI.OpportunitySystem not loaded.");
      return;
    }

    await sys.offer({
      actorUuid:    payload?.meta?.attackerUuid,
      actorName:    payload?.meta?.attackerName ?? "Unknown",
      source:       "action",
      actionCardId,
      context: { payload },
    }).catch(e => console.error(TAG, "offer() error:", e));
  });

  console.debug(`${TAG} renderChatMessage hook installed.`);
})();
