// ───────────────────────────────────────────────────────────
//  Objective Action Roll   (User-linked)   •   Foundry v12
// ───────────────────────────────────────────────────────────
(async () => {

  /* -------------------------------------------------------
   * 0.  OPTIONAL dev override
   * ----------------------------------------------------- */
  const DEBUG_ACTOR_NAME = "";            // ← put an actor name here to force-test

  /* -------------------------------------------------------
   * 1.  Resolve the acting character
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
   * 2.  Gather attribute dice sizes (Fabula Ultima style)
   * ----------------------------------------------------- */
  const attributes = {
    MIG: actor.system.props.mig_current,
    DEX: actor.system.props.dex_current,
    INS: actor.system.props.ins_current,
    WLP: actor.system.props.wlp_current
  };

  /* -------------------------------------------------------
   * 3.  Helper sounds
   * ----------------------------------------------------- */
  const SND_CURSOR = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3";
  const SND_DICE   = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dice.wav";
  const SND_CANCEL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Cursor_Cancel.mp3";

  const playDiceSound = () => AudioHelper.play({ src: SND_DICE, volume: 0.8, autoplay: true });

  // initial blip
  AudioHelper.play({ src: SND_CURSOR, volume: 0.5, autoplay: true });

  /* -------------------------------------------------------
   * 4.  Build & render dialog
   * ----------------------------------------------------- */
  new Dialog({
    title: "Objective Action Roll",
    content: `
      <form>
        <div class="form-group">
          <label>Primary Attribute:</label>
          <select id="primary-attr">
            ${Object.keys(attributes).map(a => `<option value="${a}">${a} (d${attributes[a]})</option>`).join("")}
          </select>
        </div>
        <div class="form-group">
          <label>Secondary Attribute:</label>
          <select id="secondary-attr">
            ${Object.keys(attributes).map(a => `<option value="${a}">${a} (d${attributes[a]})</option>`).join("")}
          </select>
        </div>
        <div class="form-group">
          <label>Bonus Modifier:</label>
          <input type="number" id="bonus-mod" value="0"/>
        </div>
        <div class="form-group">
          <label>Difficulty Level (DL):</label>
          <input type="number" id="difficulty" value="0"/>
        </div>
        <div class="form-group">
          <label>Blind Roll:</label>
          <input type="checkbox" id="blind-roll" checked/>
        </div>
      </form>
    `,
    render: html => html.find('select, input')
      .on("change input", () => AudioHelper.play({ src: SND_CURSOR, volume: 0.5, autoplay: true })),
    buttons: {
      roll: {
        label: "Roll",
        callback: async html => {
          const primAttr   = html.find("#primary-attr").val();
          const secAttr    = html.find("#secondary-attr").val();
          const bonusMod   = Number(html.find("#bonus-mod").val()) || 0;
          const difficulty = Number(html.find("#difficulty").val()) || 0;
          const blindRoll  = html.find("#blind-roll").is(":checked");

          playDiceSound();

          const roll1 = await (new Roll(`1d${attributes[primAttr]}`)).evaluate({ async: false });
          const roll2 = await (new Roll(`1d${attributes[secAttr]}`)).evaluate({ async: false });

          const total = roll1.total + roll2.total + bonusMod;

          /* ---- build result HTML ---- */
          let msg = `<b>${actor.name} performs the Objective Action</b><br><br>
                     🎲 <b>${primAttr}</b> (d${attributes[primAttr]}) : ${roll1.total}<br>
                     🎲 <b>${secAttr}</b> (d${attributes[secAttr]}) : ${roll2.total}<br>
                     <b>✨ Result: ${total} ✨</b>`;

          if (!blindRoll) msg += ` (VS DL: ${difficulty})`;
          msg += "<br><br><hr>";

          /* critical / fumble */
          if (roll1.total === roll2.total && roll1.total >= 6) {
            msg += `<b style="color:green;">🎉 CRITICAL SUCCESS! Gains an Opportunity! 🎉</b><br><br>`;
          } else if (roll1.total === 1 && roll2.total === 1) {
            msg += `<b style="color:red;">💀 FUMBLE! 💀</b><br><br>`;
          }

          /* success / failure (if not blind) */
          if (!blindRoll) {
            msg += total >= difficulty
              ? `<b style="color:blue;">✅ Objective Action SUCCESS! ✅</b><br><br>`
              : `<b style="color:red;">❌ Objective Action FAILURE! ❌</b><br><br>`;
          } else {
            msg += `<b>(🔍 Blind Roll: The GM will announce results.)</b>`;
          }

          ChatMessage.create({
            content: msg,
            whisper: blindRoll ? [game.users.find(u => u.isGM).id] : [],
            blind:   blindRoll,
            speaker: ChatMessage.getSpeaker({ actor })
          });
        }
      },
      cancel: {
        label: "Cancel",
        callback: () => AudioHelper.play({ src: SND_CANCEL, volume: 0.3, autoplay: true })
      }
    }
  }).render(true);

})();
