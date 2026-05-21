// ───────────────────────────────────────────────────────────
//  Hinder Action   (User-linked)   •   Foundry VTT v12
// ───────────────────────────────────────────────────────────
(async () => {

  /* -------------------------------------------------------
   * 0.  OPTIONAL debug override
   * ----------------------------------------------------- */
  const DEBUG_ACTOR_NAME = "";                // ← put an actor name here to force-test

  /* -------------------------------------------------------
   * 1.  Resolve acting character
   * ----------------------------------------------------- */
  let actor;

  if (DEBUG_ACTOR_NAME) {
    actor = game.actors.getName(DEBUG_ACTOR_NAME);
    if (!actor) return ui.notifications.warn(`DEBUG: Actor “${DEBUG_ACTOR_NAME}” not found.`);
  } else {
    actor = game.user.character ?? canvas.tokens.controlled[0]?.actor ?? null;
    if (!actor) return ui.notifications.warn(
      "You don’t have a linked character or any controlled tokens."
    );
  }

  /* -------------------------------------------------------
   * 1b. Free-action grant (peek)
   *
   * When the actor is acting under an `open_action_menu`
   * grant (e.g. Zarg's High Speed — Attack/Hinder, +SL on
   * the Hinder check), pull the bonus and lock-target out
   * so we can apply them at roll-time and consume the grant
   * once the dialog commits. Cancel preserves the grant.
   * ----------------------------------------------------- */
  let grantedCheckBonus = 0;
  let lockedTargetTokenUuid = null;
  let hadGrant = false;
  try {
    const info = globalThis.FUCompanion?.api?.freeActions?.peek?.(actor.id);
    if (info) {
      hadGrant = true;
      grantedCheckBonus = Number(info.checkBonus) || 0;
      lockedTargetTokenUuid = info.lockedTargetTokenUuid || null;
    }
  } catch (e) { console.warn("[ONI][Hinder] free-action peek failed:", e); }

  /* -------------------------------------------------------
   * 2.  Attribute dice sizes
   * ----------------------------------------------------- */
  const attributes = {
    MIG: actor.system.props.mig_current,
    DEX: actor.system.props.dex_current,
    INS: actor.system.props.ins_current,
    WLP: actor.system.props.wlp_current
  };

  /* -------------------------------------------------------
   * 3.  Targets & UI options
   * ----------------------------------------------------- */
  let enemyTokens = canvas.tokens.placeables.filter(t => t.document.disposition === -1);
  if (!enemyTokens.length) return ui.notifications.warn("No enemy tokens on the scene.");

  // Grant lock → narrow dropdown to just that one enemy. Fall through to
  // the full list if the lock can't be honored (token isn't an enemy on
  // this scene) rather than locking the user out entirely.
  if (lockedTargetTokenUuid) {
    const locked = enemyTokens.find(t => t.document?.uuid === lockedTargetTokenUuid);
    if (locked) enemyTokens = [locked];
  }

  const enemyOptions      = enemyTokens.map(t => `<option value="${t.id}">${t.name}</option>`).join("");
  const attributeOptions  = Object.entries(attributes)
    .map(([k,v]) => `<option value="${k}">${k} (d${v})</option>`).join("");

  const basicConditions   = ["Dazed","Slow","Shaken","Weak"];
  const advanceConditions = {
    Slow    : ["Paralyzed","Fatigue","Delayed"],
    Dazed   : ["Silence","Confused","Charm"],
    Weak    : ["Bane","Frightened","Stagger"],
    Shaken  : ["Wither","Despair","Panic"],
    Enraged : ["Berserk","Burn","Blind"],
    Poisoned: ["Bleed","Envenomed","Curse"]
  };
  const advanceConditionOptions = Object.entries(advanceConditions).map(
    ([grp,conds]) => `<optgroup label="${grp} Group">` +
                     conds.map(c=>`<option value="${c}">${c}</option>`).join("") +
                     "</optgroup>"
  ).join("");

  /* -------------------------------------------------------
   * 4.  Sounds
   * ----------------------------------------------------- */
  const SND_CURSOR  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3";
  const SND_DICE    = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dice.wav";
  const SND_CANCEL  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Cursor_Cancel.mp3";

  AudioHelper.play({ src: SND_CURSOR, volume: 0.5, autoplay: true });

  /* -------------------------------------------------------
   * 5.  Build & show dialog
   * ----------------------------------------------------- */
  new Dialog({
    title: "Hinder Action",
    content: `
      <form>
        <div class="form-group"><label>Target Enemy:</label>
          <select id="target">${enemyOptions}</select></div>

        <div class="form-group"><label>Attribute 1:</label>
          <select id="attr1">${attributeOptions}</select></div>

        <div class="form-group"><label>Attribute 2:</label>
          <select id="attr2">${attributeOptions}</select></div>

        <div class="form-group"><label>Modifier:</label>
          <input type="number" id="modifier" value="0"></div>

        <div class="form-group"><label>Basic Condition:</label>
          <select id="basicCondition">
            ${basicConditions.map(c=>`<option value="${c}">${c}</option>`).join("")}
          </select></div>

        <div class="form-group"><label>Advanced Condition:</label>
          <select id="advanceCondition">
            <option value="none">None</option>
            ${advanceConditionOptions}
          </select>
          <div style="font-size:0.8em;color:gray;margin-top:2px;">
            * Advanced Conditions cannot be applied by Hinder.
          </div>
        </div>

        <div class="form-group"><label>Auto Success:</label>
          <input type="checkbox" id="autoSuccess"></div>
      </form>
    `,
    render: html => html.find('select, input')
      .on("change input", () => AudioHelper.play({ src: SND_CURSOR, volume: 0.5, autoplay: true })),
    buttons: {
      roll: {
        label: "Roll",
        callback: async html => {
          const targetId        = html.find('#target').val();
          const attr1Key        = html.find('#attr1').val();
          const attr2Key        = html.find('#attr2').val();
          const mod             = Number(html.find('#modifier').val()) || 0;
          const basicCond       = html.find('#basicCondition').val();
          const advCond         = html.find('#advanceCondition').val();
          const autoSuccess     = html.find('#autoSuccess').prop("checked");

          const tokenTarget     = canvas.tokens.get(targetId);
          if (!tokenTarget) return ui.notifications.error("Invalid target.");

          /* ---- initial dizzy stars effect ---- */
          new Sequence()
            .effect().file("modules/JB2A_DnD5e/Library/Generic/Conditions/Dizzy_Stars/DizzyStars_01_BlueOrange_400x400.webm")
            .atLocation(tokenTarget)
            .sound("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Fall.ogg")
            .play();

          await wait(1500);

          /* -------------------------------------------------
           * 6.  Roll or auto-success
           * ------------------------------------------------- */
          let roll1 = { total: "-" }, roll2 = { total: "-" }, total = "-";
          let isSuccess = autoSuccess, isCrit = false, isFumble = false;

          if (!autoSuccess) {
            AudioHelper.play({ src: SND_DICE, volume: 0.5, autoplay: true });
            roll1  = await (new Roll(`1d${attributes[attr1Key]}`)).evaluate();
            roll2  = await (new Roll(`1d${attributes[attr2Key]}`)).evaluate();
            total  = roll1.total + roll2.total + mod + grantedCheckBonus;

            isSuccess = total >= 10;
            isCrit    = roll1.total === roll2.total && roll1.total >= 6;
            isFumble  = roll1.total === 1 && roll2.total === 1;
          }

          /* -------------------------------------------------
           * 7.  Build result text
           * ------------------------------------------------- */
          const bonusLine = (!autoSuccess && grantedCheckBonus) ? ` + Bonus [${grantedCheckBonus}]` : "";
          let msg = `<strong>${actor.name} attempts to Hinder ${tokenTarget.name}!</strong><br>`;
          msg    += `Rolls: d${attributes[attr1Key]} [${roll1.total}] + d${attributes[attr2Key]} [${roll2.total}] + Modifier [${mod}]${bonusLine} = <strong>${total}</strong><br>`;

          if (isCrit)   msg += `<strong style="color:green;">Critical Success! Gains an Opportunity!</strong><br>`;
          if (isFumble) msg += `<strong style="color:red;">FUMBLE!</strong><br>`;

          await wait(1000);

          /* -------------------------------------------------
           * 8.  Success / failure resolution
           * ------------------------------------------------- */
          if (isSuccess) {
            // Success effect
            new Sequence()
              .effect().file("modules/JB2A_DnD5e/Library/Generic/Smoke/SmokePuffRing01_03_Regular_White_400x400.webm")
              .atLocation(tokenTarget)
              .sound("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Spook.mp3")
              .play();

            const appliedCond = advCond !== "none" ? advCond : basicCond;
            const aem = globalThis.FUCompanion?.api?.activeEffectManager;
            if (aem?.applyEffects) {
              await aem.applyEffects({
                actorUuids: [tokenTarget.actor.uuid],
                effects: [appliedCond],
                duplicateMode: "skip",
                duration: { rounds: 3, turns: 0 }
              });
            } else {
              await tokenTarget.actor.createEmbeddedDocuments("ActiveEffect", [{
                name: appliedCond,
                img: "icons/svg/aura.svg",
                statuses: [String(appliedCond).toLowerCase()],
                duration: { rounds: 3 }
              }]);
            }

            msg += `<strong>${tokenTarget.name} became ${appliedCond}!</strong>`;
          } else {
            // Miss effect
            new Sequence()
              .effect().file("jb2a.ui.miss")
              .atLocation(tokenTarget)
              .scale(1.5).opacity(0.8).duration(2000)
              .sound().file("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Miss.ogg").volume(0.4)
              .play();

            msg += `<strong>${tokenTarget.name} ignores ${actor.name}</strong>`;
          }

          ChatMessage.create({ content: msg, speaker: ChatMessage.getSpeaker({ actor }) });

          // Free-action grant consumed once the roll committed. Cancel
          // path doesn't reach here, so the grant remains available for
          // a later try. Auto-success counts as commitment too. Also
          // close the TurnUI free-action menu — ADF-driven actions
          // (Study, Attack, Spell, …) get this for free via post-action
          // cleanup, but Hinder is out-of-pipeline and has to call
          // TurnUI.removeButtons directly. See the comment above its
          // export in turn-ui-manager.js.
          if (hadGrant) {
            try { globalThis.FUCompanion?.api?.freeActions?.consume?.(actor.id); }
            catch (e) { console.warn("[ONI][Hinder] free-action consume failed:", e); }
            try { globalThis.TurnUI?.removeButtons?.({ clearToken: false, animate: true }); }
            catch (e) { console.warn("[ONI][Hinder] TurnUI.removeButtons failed:", e); }
          }
        }
      },
      cancel: {
        label: "Cancel",
        callback: () => AudioHelper.play({ src: SND_CANCEL, volume: 0.4, autoplay: true })
      }
    }
  }).render(true);

  /* helper */
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

})();
