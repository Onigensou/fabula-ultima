/*********************************************************
 *  Study Macro — Foundry V12
 *
 *  Dialog-less: clicking Study fires the standard Action
 *  Card pipeline immediately. The skill (Item.BIpjMuwVyKvxcP1S)
 *  bakes in INS+INS, so no formula override is needed. The
 *  JRPG target picker handles target selection — same UX as
 *  Attack / Skill / Spell.
 *
 *  Acting actor resolution:
 *    - non-GM: game.user.character's token on this scene.
 *    - GM:     first friendly controlled token, falling back
 *              to the current combatant's token. Lets the GM
 *              drive any PC's Study without a dropdown.
 *
 *  Free-action grant (e.g. Painful Lesson) is peeked here for
 *  its checkBonus (forwarded through PAYLOAD.overrides) and
 *  its lockedTargetTokenUuid (forwarded through targets so
 *  the JRPG picker constrains to that creature). ADF then
 *  consumes the grant atomically.
 *********************************************************/
(async () => {
  const TAG = "[ONI][Study]";
  const STUDY_SKILL_UUID = "Item.BIpjMuwVyKvxcP1S";

  // ───────────────────── Resolve acting token ─────────────────────
  let actorToken = null;
  if (game.user.isGM) {
    const friendlyControlled = canvas.tokens.controlled.find(t => t.document?.disposition !== -1);
    const combatantTokenId =
      game.combat?.combatant?.token?.id ?? game.combat?.combatant?.tokenId ?? null;
    const combatantToken = combatantTokenId ? canvas.tokens.get(combatantTokenId) : null;
    const combatantIsFriendly = combatantToken?.document?.disposition !== -1;
    actorToken = friendlyControlled ?? (combatantIsFriendly ? combatantToken : null);
  } else {
    const assigned = game.user.character;
    if (assigned) actorToken = canvas.tokens.placeables.find(t => t.actor?.id === assigned.id);
  }

  if (!actorToken) {
    return ui.notifications.warn(
      game.user.isGM
        ? "Study: select a friendly token (or have one on the active turn) before using Study."
        : "Study: your assigned character has no token on this scene."
    );
  }

  // ───────────────────── Free-action grant (peek) ─────────────────────
  let grantedCheckBonus = 0;
  let lockedTargetTokenUuid = null;
  try {
    const info = globalThis.FUCompanion?.api?.freeActions?.peek?.(actorToken.actor?.id);
    if (info) {
      grantedCheckBonus = Number(info.checkBonus) || 0;
      lockedTargetTokenUuid = info.lockedTargetTokenUuid || null;
    }
  } catch (e) { console.warn(TAG, "free-action peek failed:", e); }

  // ───────────────────── Targets ─────────────────────
  // Locked grant → that one token. Otherwise forward any pre-selected
  // Foundry targets; the JRPG picker will let the user adjust / confirm.
  let targets;
  if (lockedTargetTokenUuid) {
    targets = [lockedTargetTokenUuid];
  } else {
    targets = Array.from(game.user?.targets ?? [])
      .map(t => t.document?.uuid)
      .filter(Boolean);
  }

  // ───────────────────── Fire ADF ─────────────────────
  // No formula override — skill is locked to INS+INS via its system.props.
  // Only check_bonus is overridden, and only when a grant supplies one.
  const payload = {
    source: "Skill",
    skillUuid: STUDY_SKILL_UUID,
    attacker_uuid: actorToken.actor.uuid,
    attackerActorUuid: actorToken.actor.uuid,
    targets,
    originalTargetUUIDs: targets,
    ...(grantedCheckBonus !== 0 ? { overrides: { check_bonus: grantedCheckBonus } } : {})
  };

  const adf = game.macros.getName("ActionDataFetch");
  if (!adf) return ui.notifications.error("ActionDataFetch macro not found.");

  await adf.execute({ __AUTO: true, __PAYLOAD: payload });
})();
