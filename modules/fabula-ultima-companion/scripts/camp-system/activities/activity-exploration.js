// ============================================================================
// Camp Activity — Exploration
// Target: Yourself
// Effect: Roll 1d6 (roulette style — owner presses STOP to land).
//   1 → Recover half normal HP/MP during this rest (Ouch!)
//   2 → Regain 2 Inventory Points
//   3-5 → Regain 3 Inventory Points
//   6 → Regain 3 Inventory Points + zenit equal to character level × 50
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  const TAG  = "[CampSystem][Exploration]";

  const OUCH_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Rena/Callofruin.png";

  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("exploration", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // 1 — Broadcast START so all clients show the roulette overlay.
        //     Socket.broadcast doesn't loop back to the sender, so call show() directly on GM too.
        CAMP.Socket.broadcast(CAMP.MSG.EXPLORATION_START, {
          actorId:   actor.id,
          actorName: actor.name,
        });
        CAMP.ExplorationUI?.show(actor.id, actor.name);

        // Small delay so clients have time to render the overlay before we await
        await new Promise(r => setTimeout(r, 300));

        // 2 — If the GM is also the actor owner (solo), handle locally;
        //     otherwise wait for the owner client to emit EXPLORATION_RESULT.
        const roll = await _waitForRoll(actor);

        // 3 — Apply outcome
        await _applyOutcome(actor, roll);

        // 4 — Chat announcement
        await _postChatResult(actor, roll);

        // 5 — Hold result screen visible for players to read before dismissing
        await new Promise(r => setTimeout(r, 5000));

        // 6 — Hide roulette overlay on all clients.
        //     Broadcast doesn't echo back to sender, so also call hide() directly on GM.
        CAMP.Socket.broadcast(CAMP.MSG.EXPLORATION_DONE, { actorId: actor.id });
        CAMP.ExplorationUI?.hide();
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Wait for roll from owner (or GM fallback)
  // ---------------------------------------------------------------------------
  function _waitForRoll(actor) {
    return new Promise(resolve => {
      CAMP.ExplorationUI ??= {};
      CAMP.ExplorationUI.pendingResolvers ??= {};

      // 60-second timeout — auto-roll if owner never responds
      const timer = setTimeout(() => {
        if (CAMP.ExplorationUI.pendingResolvers[actor.id]) {
          console.warn(TAG, "Roll timeout — auto-resolving for", actor.name);
          delete CAMP.ExplorationUI.pendingResolvers[actor.id];
          resolve(Math.ceil(Math.random() * 6));
        }
      }, 60_000);

      CAMP.ExplorationUI.pendingResolvers[actor.id] = (roll) => {
        clearTimeout(timer);
        resolve(roll);
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Apply outcome to actor
  // ---------------------------------------------------------------------------
  async function _applyOutcome(actor, roll) {
    const props    = actor.system?.props ?? {};
    const level    = parseInt(props.level)      || 1;
    const curIp    = parseInt(props.current_ip) || 0;
    const maxIp    = parseInt(props.max_ip)     || 6;
    const curZenit = parseInt(props.zenit)      || 0;

    if (roll === 1) {
      // Mark actor for halved HP/MP recovery at rest
      await CAMP.State.setExplorationDebuff(actor.id, { halfRest: true });
      // Apply visible Active Effect so the player can see the debuff on their sheet
      await actor.createEmbeddedDocuments("ActiveEffect", [{
        name:     "Ouch! (Exploration)",
        icon:     OUCH_ICON,
        origin:   `Actor.${actor.id}`,
        disabled: false,
        changes:  [],
        statuses: [],
      }]);

    } else if (roll === 2) {
      await actor.update({ "system.props.current_ip": Math.min(curIp + 2, maxIp) });

    } else if (roll <= 5) {
      await actor.update({ "system.props.current_ip": Math.min(curIp + 3, maxIp) });

    } else {
      // roll === 6
      const zenitGain = level * 50;
      await actor.update({
        "system.props.current_ip": Math.min(curIp + 3, maxIp),
        "system.props.zenit":      curZenit + zenitGain,
      });
    }

    console.debug(TAG, `${actor.name} rolled ${roll} on Exploration.`);
  }

  // ---------------------------------------------------------------------------
  // Chat result message
  // ---------------------------------------------------------------------------
  const _OUTCOME_TEXT = {
    1: { label: "1 — Ouch!",                    desc: "Recovers only <strong>half HP and MP</strong> during tonight's rest." },
    2: { label: "2 — Not what I was looking for…", desc: "Regained <strong>2 Inventory Points</strong>." },
    3: { label: "3 — Hoho, this can be useful!", desc: "Regained <strong>3 Inventory Points</strong>." },
    4: { label: "4 — Hoho, this can be useful!", desc: "Regained <strong>3 Inventory Points</strong>." },
    5: { label: "5 — Hoho, this can be useful!", desc: "Regained <strong>3 Inventory Points</strong>." },
    6: { label: "6 — Jackpot!",                 desc: "Regained <strong>3 Inventory Points</strong> and <strong>Zenit = Level × 50</strong>!" },
  };

  async function _postChatResult(actor, roll) {
    const { label, desc } = _OUTCOME_TEXT[roll] ?? { label: String(roll), desc: "" };
    const color = roll === 1 ? "#c62828" : roll === 6 ? "#c8961a" : "#3a7a35";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <img src="${OUCH_ICON}" style="width:36px;height:36px;border-radius:6px;border:none;flex-shrink:0;${roll !== 1 ? "display:none;" : ""}">
          <div>
            <div style="font-weight:700;font-size:1em;color:${color};">
              🎲 ${actor.name} — Exploration
            </div>
            <div style="font-weight:600;margin-top:2px;">${label}</div>
            <div style="font-size:.88em;margin-top:3px;opacity:.85;">${desc}</div>
          </div>
        </div>
      `,
    });

    // Hide chat header for a clean system-message look
    const styleId = `oni-expl-style-${msg.id}`;
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .chat-message[data-message-id="${msg.id}"] .message-header { display:none !important; }
        .chat-message[data-message-id="${msg.id}"] { padding-top:6px !important; }
        .chat-message[data-message-id="${msg.id}"] .message-content { margin:0 !important; }
      `;
      document.head.appendChild(style);
    }
  }
})();
