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
  const _offeredCards    = new Set();
  // Tracks action card IDs whose opportunityAdvantage charge has already been consumed.
  const _consumedAdvantage = new Set();

  Hooks.on("renderChatMessage", async (msg, html) => {
    // Must be an action card
    const flags = msg.flags?.[MODULE_ID];
    const card  = flags?.actionCard;
    if (!card) return;

    const payload      = card.payload;
    const actionCardId = card.actionCardId;
    if (!actionCardId) return;

    // Only one client processes this card. With an owning player, that's the
    // owner's client. With no resolvable owner (GM-owned NPC / unknown), the
    // card renders on BOTH GM clients in the dual-GM (Co-DM) setup — gate to the
    // primary GM so the offer + Advantage-charge consume don't run twice. offer()
    // re-resolves the real owner and routes the picker to a player if there is one.
    const ownerUserId = payload?.meta?.ownerUserId;
    if (ownerUserId) {
      if (game.user.id !== ownerUserId) return;
    } else if (game.user?.isGM) {
      const isPrimary = globalThis.ONI?.OpportunitySystem?.isPrimaryGM;
      if (isPrimary && !isPrimary()) return;
    }

    // ── Consume opportunityAdvantage charge on first render of this card ────
    // The AE's changes entry (check_mod_all / attack_accuracy_mod_all) was
    // already factored into the accuracy roll by ActionDataComputation. Consume
    // the charge now so the AE is removed and won't apply to future actions.
    if (!_consumedAdvantage.has(actionCardId)) {
      _consumedAdvantage.add(actionCardId);
      const charges    = globalThis.FUCompanion?.api?.charges;
      const actorUuid  = payload?.meta?.attackerUuid;
      if (charges && actorUuid) {
        const doc   = await fromUuid(actorUuid).catch(() => null);
        const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
        if (actor) {
          const candidates = charges.findOnActor(actor, { key: "opportunityAdvantage" }) ?? [];
          if (candidates.length) {
            const result = await charges.consume(candidates[0].effect, { count: 1, deleteWhenEmpty: true })
              .catch(e => { console.error(TAG, "Action pipeline Advantage consume error:", e); return null; });
            if (result?.ok) console.debug(TAG, "Action pipeline: Advantage charge consumed — AE removed.");
          }
        }
      }
    }

    // Must be a crit (not a fumble — fumble overrides crit per game rules)
    const accuracy = payload?.accuracy;
    if (!accuracy?.isCrit || accuracy?.isFumble) return;

    // Dedup — don't re-offer on re-renders (reactions update the card)
    if (_offeredCards.has(actionCardId)) return;

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

    // ── Advantage consume step ───────────────────────────────────────────────────
    // Runs AFTER render. The AE's changes entry (check_mod_all +4) is already
    // factored into the roll by the time compute reads it. This step only needs
    // to consume the charge so the AE is deleted and won't apply to future checks.
    MANAGER.registerStep(
      {
        id:    "opportunity-advantage",
        label: "Consume Advantage charge after roll",
        run: async (ctx) => {
          const charges = globalThis.FUCompanion?.api?.charges;
          if (!charges) return ctx;

          const actorUuid = ctx.payload?.meta?.actorUuid;
          if (!actorUuid) return ctx;

          const doc   = await fromUuid(actorUuid).catch(() => null);
          const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
          if (!actor) return ctx;

          const candidates = charges.findOnActor(actor, { key: "opportunityAdvantage" }) ?? [];
          if (!candidates.length) return ctx;

          const result = await charges.consume(candidates[0].effect, { count: 1, deleteWhenEmpty: true })
            .catch(e => { console.error(TAG, "Advantage charge consume error:", e); return null; });
          if (result?.ok) console.debug(TAG, "Advantage charge consumed — AE removed.");

          return ctx;
        },
      },
      { afterId: "render" }
    );

    // ── Opportunity offer step ───────────────────────────────────────────────────
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

    console.debug(`${TAG} CheckRoller "opportunity-advantage" (post-render) and "opportunity" steps registered.`);
  });
})();
