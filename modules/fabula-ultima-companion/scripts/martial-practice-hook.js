// ============================================================================
// Martial Practice Hook — "You May" attack notification
//
// When an actor that carries the Martial Practice AE (martialPracticeActive)
// performs an attack, their owner receives a dialog asking whether they used
// the Multi charge on that attack.  If accepted, the AE is consumed.
//
// Timing: oni:action:resolved fires after the attack fully resolves.
// The player must already have the intent to use Multi in mind (declaring it
// during targeting / card confirmation), and this dialog records the use.
//
// The hook fires on all clients via Hooks.callAll — guarded so only the
// actor's owner sees the dialog.  The owner can update their own AE directly;
// no GM routing is needed.
// ============================================================================
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[MartialPracticeHook]";

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function _getOwnerUserId(actor) {
    return Object.entries(actor?.ownership ?? {}).find(([id, lvl]) => {
      if (id === "default") return false;
      const user = game.users?.get(id);
      return lvl === 3 && user && !user.isGM;
    })?.[0] ?? null;
  }

  function _isActorOwner(actor) {
    const uid = _getOwnerUserId(actor);
    return uid ? uid === game.user?.id : (game.user?.isGM ?? false);
  }

  function _findMartialPracticeAE(actor) {
    return Array.from(actor?.effects ?? []).find(
      e => e.flags?.[MODULE_ID]?.martialPracticeActive === true
    ) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Core: show dialog and consume AE on confirmation
  // ---------------------------------------------------------------------------
  async function _handleAttack(actor, ae) {
    const multiValue = ae.flags?.[MODULE_ID]?.martialPracticeMulti ?? 2;

    const accepted = await Dialog.confirm({
      title:      "⚔️ Martial Practice",
      content: `
        <p style="margin:0 0 8px">
          <strong>${actor.name}</strong> performed an attack.
        </p>
        <p style="margin:0">
          Did you use <strong>Martial Practice</strong> to grant this attack
          <strong>Multi (${multiValue})</strong>?
        </p>
        <p style="margin:6px 0 0;font-size:.85em;opacity:.7;">
          Confirming will consume the charge.
        </p>
      `,
      defaultYes: false,
    });

    if (!accepted) return;

    await ae.delete().catch(err =>
      console.warn(TAG, "Could not delete Martial Practice AE:", err)
    );

    ui.notifications?.info(
      `⚔️ Martial Practice used — Multi (${multiValue}) applied. Charge consumed.`,
      { permanent: false, console: false }
    );
    console.debug(TAG, `Consumed Martial Practice AE (Multi ${multiValue}) for ${actor.name}`);
  }

  // ---------------------------------------------------------------------------
  // oni:action:resolved listener
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    Hooks.on("oni:action:resolved", async ({ payload } = {}) => {
      try {
        // Only care about attacks
        if (payload?.core?.skillTypeRaw !== "Attack") return;

        const attackerUuid = payload?.meta?.attackerUuid;
        if (!attackerUuid) return;

        const attacker = await fromUuid(attackerUuid);
        if (!attacker) return;

        // Guard: only show on this actor's owner client
        if (!_isActorOwner(attacker)) return;

        const ae = _findMartialPracticeAE(attacker);
        if (!ae) return;

        await _handleAttack(attacker, ae);
      } catch (err) {
        console.error(TAG, "Error in oni:action:resolved handler:", err);
      }
    });

    console.debug(TAG, "Martial Practice hook loaded.");
  });
})();
