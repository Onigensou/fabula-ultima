// ============================================================================
// Travel Roll API
// Fabula Ultima — Journeys and Travels (Core Rulebook p.106–108)
//
// Exposed as: globalThis.TravelRoll
//
// Usage:
//   await TravelRoll.performRoll()           — uses canvas.scene threat level
//   await TravelRoll.performRoll(scene)      — explicit scene
//   TravelRoll.getThreatLevel(scene)         — "minimal"|"low"|"medium"|"high"|"very_high"
//   TravelRoll.getDieFormula(level)          — "1d6" … "1d20"
//   TravelRoll.getOutcome(total)             — "discovery"|"safe"|"danger"
//   TravelRoll.getCartographyHolder()        — { actor, effect } | null
//
// Hook fired after final result:
//   Hooks.callAll("oni.travelRoll.completed", { roll, total, outcome, level, formula, rerolled, rerollBy })
//
// Scene flag for threat level:
//   flags.fabula-ultima-companion.oniDungeon.threatLevel
//   Values: "minimal" | "low" | "medium" | "high" | "very_high"  (default: "medium")
//
// Cartography AE marker (set by activity-cartography.js):
//   flags.fabula-ultima-companion.cartographyReroll: true
// ============================================================================
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[TravelRoll]";

  // ---------------------------------------------------------------------------
  // Threat level → die mapping
  // ---------------------------------------------------------------------------
  const THREAT_DIE = Object.freeze({
    minimal:   "1d6",
    low:       "1d8",
    medium:    "1d10",
    high:      "1d12",
    very_high: "1d20",
  });

  const THREAT_LABEL = Object.freeze({
    minimal:   "Minimal",
    low:       "Low",
    medium:    "Medium",
    high:      "High",
    very_high: "Very High",
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function getThreatLevel(scene) {
    const raw = scene?.flags?.[MODULE_ID]?.oniDungeon?.threatLevel;
    return (raw && THREAT_DIE[raw]) ? raw : "medium";
  }

  function getDieFormula(level) {
    return THREAT_DIE[level] ?? THREAT_DIE.medium;
  }

  function getOutcome(total) {
    if (total === 1)  return "discovery";
    if (total >= 6)   return "danger";
    return "safe";
  }

  function getCartographyHolder() {
    for (const actor of game.actors ?? []) {
      if (actor.type !== "character") continue;
      for (const effect of actor.effects ?? []) {
        if (effect.flags?.[MODULE_ID]?.cartographyReroll === true) {
          return { actor, effect };
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Chat card
  // ---------------------------------------------------------------------------
  const OUTCOME_STYLE = Object.freeze({
    danger:    { color: "#a82828", label: "Danger!",      icon: "fas fa-skull-crossbones" },
    discovery: { color: "#b8860b", label: "Discovery!",   icon: "fas fa-star"             },
    safe:      { color: "#3a7a35", label: "Safe passage", icon: "fas fa-route"            },
  });

  async function _postTravelRollChat({ roll, outcome, level, formula, rerolled = false, rerollBy = null }) {
    const style   = OUTCOME_STYLE[outcome];
    const dieIcon = formula.replace("1d", "fa-dice-d");

    const rerollNote = rerolled
      ? `<div style="font-size:.8em;margin-top:4px;opacity:.7;font-style:italic;">
           <i class="fas fa-redo"></i> Cartography reroll used by <b>${rerollBy}</b>
         </div>`
      : "";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <div style="font-size:2rem;color:${style.color};flex-shrink:0;line-height:1;">
            <i class="${dieIcon} fas fa-dice-d10" style="font-size:1.8rem;"></i>
          </div>
          <div>
            <div style="font-weight:700;font-size:1em;color:${style.color};">
              <i class="${style.icon}"></i>&ensp;Travel Roll — ${THREAT_LABEL[level]} (${formula})
            </div>
            <div style="font-size:1.4em;font-weight:800;margin:2px 0;color:${style.color};">
              ${roll.total}
            </div>
            <div style="font-weight:600;font-size:.9em;">${style.label}</div>
            ${rerollNote}
          </div>
        </div>
      `,
    });

    const styleId = `oni-travel-roll-style-${msg.id}`;
    if (!document.getElementById(styleId)) {
      const s = document.createElement("style");
      s.id = styleId;
      s.textContent = `
        .chat-message[data-message-id="${msg.id}"] .message-header { display:none !important; }
        .chat-message[data-message-id="${msg.id}"] { padding-top:6px !important; }
        .chat-message[data-message-id="${msg.id}"] .message-content { margin:0 !important; }
      `;
      document.head.appendChild(s);
    }

    return msg;
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------
  async function performRoll(scene) {
    const targetScene = scene ?? canvas?.scene ?? null;

    const level   = getThreatLevel(targetScene);
    const formula = getDieFormula(level);

    const roll = await new Roll(formula).evaluate();
    const outcome = getOutcome(roll.total);

    console.debug(TAG, `Travel Roll: ${formula} → ${roll.total} (${outcome}), scene: ${targetScene?.name ?? "none"}, level: ${level}`);

    await _postTravelRollChat({ roll, outcome, level, formula, rerolled: false });

    // Check for Cartography reroll
    let finalRoll    = roll;
    let finalOutcome = outcome;
    let rerolled     = false;
    let rerollBy     = null;

    const holder = getCartographyHolder();
    if (holder) {
      const charges = holder.effect.flags?.["fabula-ultima-companion"]?.cartographyCharges ?? 1;
      const chargeNote = charges > 1 ? ` <em>(${charges} charges remaining)</em>` : "";

      const use = await Dialog.confirm({
        title:   "Cartography — Reroll Available",
        content: `<p><b>${holder.actor.name}</b> has <b>Cartography</b> active.${chargeNote}</p>
                  <p>Reroll the travel die and keep the new result?</p>`,
        yes:     () => true,
        no:      () => false,
        defaultYes: true,
      });

      if (use) {
        finalRoll    = await new Roll(formula).evaluate();
        finalOutcome = getOutcome(finalRoll.total);
        rerolled     = true;
        rerollBy     = holder.actor.name;

        // Consume one charge — delete AE when last charge is spent
        try {
          const remaining = charges - 1;
          if (remaining <= 0) {
            await holder.effect.delete();
          } else {
            const newName = remaining === 1 ? "Cartography" : `Cartography ×${remaining}`;
            await holder.effect.update({ name: newName });
            await holder.effect.setFlag("fabula-ultima-companion", "cartographyCharges", remaining);
          }
          console.debug(TAG, `Cartography charge consumed from ${holder.actor.name}. Remaining: ${remaining}`);
        } catch (e) {
          console.warn(TAG, "Could not update Cartography AE:", e.message);
        }

        await _postTravelRollChat({ roll: finalRoll, outcome: finalOutcome, level, formula, rerolled: true, rerollBy });
      }
    }

    const result = {
      roll:      finalRoll,
      total:     finalRoll.total,
      outcome:   finalOutcome,
      level,
      formula,
      rerolled,
      rerollBy,
    };

    Hooks.callAll("oni.travelRoll.completed", result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  globalThis.TravelRoll = {
    performRoll,
    getThreatLevel,
    getDieFormula,
    getOutcome,
    getCartographyHolder,
    THREAT_DIE,
    THREAT_LABEL,
  };

  Hooks.once("ready", () => {
    console.debug(TAG, "Travel Roll API ready. Call TravelRoll.performRoll() to perform a travel roll.");
  });
})();
