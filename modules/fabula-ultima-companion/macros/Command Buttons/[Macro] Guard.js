/*********************************************************
 *  Guard / Cover Action – v4.2  •  Foundry V12 CORE-ONLY
 *  • Adds HP-based removal conditions (see above)
 *  • Linked-character aware
 *  • Friendly-token filter (ignores hidden & KO’d)
 *  • Plays JB2A “shield” intro FX
 *  • Adds “Guard” / “Covered” Active Effects (no preset duration)
 *  • Removes both effects at the start of the guarder’s
 *    very next turn, when HP rules trigger, or when combat ends
 *  • Auto-adds icons to the HUD palette **only while needed**
 *********************************************************/
(async () => {

  /*────────────────────────────────────────────────────────
   * 0. CONFIG & CONSTANTS
   *──────────────────────────────────────────────────────*/
  const DEBUG_CHARACTER_NAME = "";                          // ← hard-code a test name if you like

  const STATUS_DATA = {
    Guard   : { icon: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/shield_oath.png" },
    Covered : { icon: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/intervene.png" }
  };

  const SND_CURSOR  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3";
  const SND_CONFIRM = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Parry.ogg";
  const SND_REMOVE  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Skill1.ogg";
  const SND_CANCEL  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Cursor_Cancel.mp3";

  const FX_GUARD    = "modules/JB2A_DnD5e/Library/1st_Level/Shield/Shield_01_Regular_Blue_Intro_400x400.webm";

  /*────────────────────────────────────────────────────────
   * Helpers – status palette management
   *──────────────────────────────────────────────────────*/
  const statusId = label =>
    label.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "");

  const ensureStatusRegistered = label => {
    const id = statusId(label);
    if (!CONFIG.statusEffects.some(se => se.id === id)) {
      CONFIG.statusEffects.push({ id, label, icon: STATUS_DATA[label].icon });
    }
  };

  const maybeUnregisterStatus = async label => {
    const id = statusId(label);
    const stillUsed = game.actors.some(a =>
      a.effects?.some(e => e.getFlag("core", "statusId") === id)
    ) || game.scenes.some(s =>
      s.tokens.some(t => t.actor?.effects?.some(e => e.getFlag("core", "statusId") === id))
    );

    if (!stillUsed) {
      CONFIG.statusEffects = CONFIG.statusEffects.filter(se => se.id !== id);
      canvas.tokens.hud?.render(true);                      // refresh HUD palette
    }
  };

  const applyStatus = async (token, label) => {
    ensureStatusRegistered(label);

    const id        = statusId(label);
    const existing  = token.actor?.effects.find(e => e.getFlag("core", "statusId") === id);
    if (existing) return existing;                          // don’t double-stack

    const { icon } = STATUS_DATA[label];

    const aeData = {
      name   : label,
      icon,
      origin : token.actor.uuid,
      flags  : { core: { statusId: id } },
      duration: {                                   // no “rounds” key → indefinite
        startRound: game.combat ? game.combat.round : 0,
        startTurn : game.combat ? game.combat.turn  : 0
      },
      changes: []
    };
    const [ae] = await token.actor.createEmbeddedDocuments("ActiveEffect", [aeData]);
    return ae;
  };

  const removeStatus = async (token, label) => {
    const id  = statusId(label);
    const eff = token.actor?.effects.find(e => e.getFlag("core", "statusId") === id);
    if (eff) await eff.delete();
    await maybeUnregisterStatus(label);
  };

  const hp = doc => Number(getProperty(doc, "system.props.current_hp") ?? 0);

  /*────────────────────────────────────────────────────────
   * 1. Resolve actor & guarding token
   *──────────────────────────────────────────────────────*/
  let actor, gToken;

  if (DEBUG_CHARACTER_NAME) {
    actor = game.actors.getName(DEBUG_CHARACTER_NAME);
    if (!actor) return ui.notifications.warn(`DEBUG: Actor “${DEBUG_CHARACTER_NAME}” not found.`);
  } else {
    const user = game.user;
    actor = user.character ?? canvas.tokens.controlled[0]?.actor ?? null;
    if (!actor) return ui.notifications.warn("You don’t have a linked character or any controlled tokens.");
  }

  gToken = canvas.scene.tokens.find(t => t.actor?.id === actor.id);
  if (!gToken) return ui.notifications.warn("Your character’s token is not on the scene.");

  /*────────────────────────────────────────────────────────
   * 2. Find friendly tokens eligible for Cover
   *──────────────────────────────────────────────────────*/
  const friendlyTokens = canvas.tokens.placeables.filter(t =>
    t.document.disposition === 1 &&                        // friendly
    t.id !== gToken.id &&
    !t.document.hidden &&                                  // ignore hidden/off-field
    Number(t.actor?.system?.props?.max_hp ?? 0) > 0        // must have HP
  );

  /*────────────────────────────────────────────────────────
   * 3. Build & show dialog
   *──────────────────────────────────────────────────────*/
  let dlgHTML = "<p>Do you want to use the <b>Guard</b> action?</p>";

  if (friendlyTokens.length) {
    dlgHTML += `<p>Select a target to provide Cover:</p>
                <select id="coverTarget"><option value=''>None</option>`;
    friendlyTokens.forEach(t => dlgHTML += `<option value='${t.id}'>${t.name}</option>`);
    dlgHTML += "</select>";
  } else {
    dlgHTML += "<p><em>No eligible allies with HP detected.</em></p>";
  }

  AudioHelper.play({ src: SND_CURSOR, volume: 0.8, autoplay: true });

  new Dialog({
    title   : "Guard Action",
    content : dlgHTML,
    render  : html => html.find('select').on("change", () =>
      AudioHelper.play({ src: SND_CURSOR, volume: 0.5, autoplay: true })
    ),
    buttons : {
      confirm: {
        label   : "Confirm",
        callback: async html => {

          /*────────── Resolve Cover target ──────────*/
          AudioHelper.play({ src: SND_CONFIRM, volume: 0.8, autoplay: true });

          const coverID  = html.find('#coverTarget').val();
          const coverTkn = coverID ? canvas.tokens.get(coverID) : null;

          /*────────── FX ──────────*/
          new Sequence().effect().file(FX_GUARD).atLocation(gToken).play();
          if (coverTkn) new Sequence().effect().file(FX_GUARD).atLocation(coverTkn).play();

          /*────────── Apply statuses ──────────*/
          await applyStatus(gToken , "Guard");
          if (coverTkn) await applyStatus(coverTkn, "Covered");

          /*────────── Chat message ──────────*/
          let msg = `<strong>${actor.name}</strong> Defends`;
          if (coverTkn) msg += `<br><strong>${actor.name}</strong> covers <strong>${coverTkn.name}</strong>`;
          ChatMessage.create({ content: msg, speaker: { alias: actor.name } });

          /*────────── Removal hooks ──────────*/

          /* 3.a – start-of-next-turn / end-of-combat */
          Hooks.off("updateCombat", game.guardHook);
          game.guardHook = Hooks.on("updateCombat", async (combat, changed) => {

            /* Combat ended altogether */
            if (!combat.started) {
              await removeStatus(gToken , "Guard");
              if (coverTkn) await removeStatus(coverTkn, "Covered");
              Hooks.off("updateCombat", game.guardHook);
              Hooks.off("updateActor" , game.guardHPHook);
              return;
            }

            /* Start of guarder’s next turn */
            const guardTurn = combat.turns.findIndex(t => t.tokenId === gToken.id);
            if (changed.turn === guardTurn) {
              let removeMsg = `<strong>${actor.name}</strong> Defend wears off`;
              await removeStatus(gToken, "Guard");

              if (coverTkn) {
                await removeStatus(coverTkn, "Covered");
                removeMsg += `<br><strong>${coverTkn.name}</strong> cover wears off`;
              }

              AudioHelper.play({ src: SND_REMOVE, volume: 0.8, autoplay: true });
              ChatMessage.create({ content: removeMsg, speaker: { alias: actor.name } });
              Hooks.off("updateCombat", game.guardHook);
              Hooks.off("updateActor" , game.guardHPHook);
            }
          });

          /* 3.b – HP-based removal */
          Hooks.off("updateActor", game.guardHPHook);
          game.guardHPHook = Hooks.on("updateActor", async (actDoc, diff) => {
            // Bail if HP didn't change
            if (!hasProperty(diff, "system.props.current_hp")) return;

            /* Guarder drops to 0 → remove both effects */
            if (actDoc.id === actor.id && hp(actDoc) <= 0) {
              await removeStatus(gToken, "Guard");
              if (coverTkn) await removeStatus(coverTkn, "Covered");

              AudioHelper.play({ src: SND_REMOVE, volume: 0.8, autoplay: true });
              ChatMessage.create({
                content: `<strong>${actor.name}</strong> is down – Guard ends`,
                speaker: { alias: actor.name }
              });

              Hooks.off("updateCombat", game.guardHook);
              Hooks.off("updateActor" , game.guardHPHook);
              return;
            }

            /* Covered ally drops to 0 → remove Covered only */
            if (coverTkn && actDoc.id === coverTkn.actor.id && hp(actDoc) <= 0) {
              await removeStatus(coverTkn, "Covered");
              AudioHelper.play({ src: SND_REMOVE, volume: 0.8, autoplay: true });
              ChatMessage.create({
                content: `<strong>${coverTkn.name}</strong> is down – Cover ends`,
                speaker: { alias: actor.name }
              });

              // Guard may still need to clear on next turn, so keep hooks alive
            }
          });
        }
      },
      cancel : {
        label   : "Cancel",
        callback: () => AudioHelper.play({ src: SND_CANCEL, volume: 1.5, autoplay: true })
      }
    }
  }).render(true);

})();
