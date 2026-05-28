/**
 * [ONI] Opportunity System — Action Pipeline & Check Roller Hooks
 *
 * Two integration points:
 *
 * 1. Action pipeline — renderChatMessage on new action cards with isCrit=true.
 *    Fires BEFORE reactions (which trigger on Confirm, after AdvanceDamage).
 *    Only the attacker's owner sees the picker.
 *
 * 2. Check Roller — pipeline step registered after "render".
 *    CheckRoller runs on the rolling player's own client, so offer() shows
 *    the dialog directly without GM socket routing.
 */
(() => {
  const TAG       = "[ONI][OpportunitySystem:ActionHook]";
  const MODULE_ID = "fabula-ultima-companion";

  // ── 1. Action Pipeline ───────────────────────────────────────────────────────
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

  // ── 2. Check Roller pipeline step ───────────────────────────────────────────
  // Registered after "ready" so ONI.CheckRoller is guaranteed to exist.
  // Runs after the "render" step — the card is already posted and visible.
  // CheckRoller is always local to the roller's own client, so offer() shows
  // the dialog directly (no GM socket needed).
  Hooks.once("ready", () => {
    const MANAGER = globalThis.ONI?.CheckRoller;
    if (!MANAGER?.__isCheckRollerManager) {
      console.warn(`${TAG} CheckRoller manager not found — Check Roller opportunity integration skipped.`);
      return;
    }

    MANAGER.registerStep(
      {
        id: "opportunity",
        label: "Offer opportunity on crit",
        run: async (ctx) => {
          const result = ctx.result;
          // Only fire on true crit (fumble overrides)
          if (!result?.isCrit || result?.isFumble) return ctx;

          const sys = globalThis.ONI?.OpportunitySystem;
          if (!sys) return ctx;

          const actorUuid = ctx.payload?.meta?.actorUuid ?? "";
          const actorName = ctx.payload?.meta?.actorName ?? "Unknown";

          await sys.offer({
            actorUuid,
            actorName,
            source:  "check_roller",
            context: { checkRollerCtx: ctx },
          }).catch(e => console.error(TAG, "CheckRoller offer() error:", e));

          return ctx;
        },
      },
      { afterId: "render" }
    );

    console.debug(`${TAG} CheckRoller "opportunity" step registered.`);
  });
})();
