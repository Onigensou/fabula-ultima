/**
 * scripts/fabula-initiative/end-of-round.js
 * Fabula Ultima Companion — End of Round announcer (Lancer Initiative compatible)
 * Single-file install: includes Hooks.once("ready") inside this file (no main.js edits needed).
 */

(() => {
  const MODULE_ID = "fabula-ultima-companion";

  const NS = "oni-li-eor";
  const FLAG_SCOPE = "world";
  const FLAG_KEY_ANNOUNCED = "oniLiEor.announcedRound";
  const LI = "lancer-initiative";

  const DEBUG = false;

  // ---------- Debug helpers ----------
  const tag = (op) => `%c[${MODULE_ID}][LI-EOR][${op}]`;
  const style = "color:#7fd7ff;font-weight:700;";
  const dlog = (op, ...args) => DEBUG && console.log(tag(op), style, ...args);

  // =========================================================
  // Multi-GM authority helpers
  // =========================================================
  function getPrimaryActiveGM() {
    const gms = (game.users?.contents ?? []).filter((u) => u?.isGM && u?.active);
    return gms[0] ?? null;
  }

  function isPrimaryActiveGM() {
    const gm = getPrimaryActiveGM();
    return !!gm && game.user?.id === gm.id;
  }

  // =========================================================
  // Summon filter helpers
  // =========================================================
  function isSummonActor(actor) {
    if (!actor) return false;
    const v =
      foundry.utils.getProperty(actor, "system.props.isSummon") ??
      foundry.utils.getProperty(actor, "system.isSummon");
    return v === true;
  }

  function isSummonCombatant(c) {
    const actor = c?.actor ?? (c?.actorId ? game.actors?.get?.(c.actorId) : null);
    return isSummonActor(actor);
  }

  function injectStylesOnce() {
    const id = `${NS}-style-split`;
    if (document.getElementById(id)) return;

    const el = document.createElement("style");
    el.id = id;
    el.textContent = `
      .chat-message.${NS}__msg .message-header { display:none !important; }
      .chat-message.${NS}__msg .message-metadata { display:none !important; }
      .chat-message.${NS}__msg .message-delete { display:none !important; }
      .chat-message.${NS}__msg .message-edit { display:none !important; }
      .chat-message.${NS}__msg { padding-top: 6px !important; }
      .chat-message.${NS}__msg .message-content { margin: 0 !important; }

      .chat-message.${NS}__msg .${NS}__wrap { text-align:right; }
      .chat-message.${NS}__msg .${NS}__title {
        margin:0 !important;
        font-weight: 900 !important;
        font-size: 1.8em !important;
        line-height: 1.1 !important;
      }
      .chat-message.${NS}__msg .${NS}__btn {
        width: 100% !important;
        margin-top: 10px !important;
      }
    `;
    document.head.appendChild(el);
  }

  function getSilentSpeaker() {
    // ChatMessage will still have an author; we hide headers via CSS on every client.
    return { scene: null, actor: null, token: null, alias: "" };
  }

  function getGMUserIds() {
    return game.users?.filter((u) => u.isGM)?.map((u) => u.id) ?? [];
  }

  function getPendingActivationsTotal(combat) {
    // Lancer Initiative tracks remaining activations here:
    // flags.lancer-initiative.activations.value
    return combat.combatants.reduce((sum, c) => {
      // Ignore Summons entirely
      if (isSummonCombatant(c)) return sum;

      const v = c.getFlag(LI, "activations.value") ?? 0;
      return sum + Math.max(0, v);
    }, 0);
  }

  async function postEndOfRoundCards(combat) {
    const roundNum = combat.round ?? 0;

    // Card A: everyone sees (no button)
    const contentA = `
      <div class="${NS}__wrap" data-oni-li-eor="1">
        <div class="${NS}__title">End of Round ${roundNum}</div>
      </div>
    `;

    // Card B: GM-only whisper (button only)
    const contentB = `
      <div class="${NS}__wrap" data-oni-li-eor-control="1">
        <button
          type="button"
          class="${NS}__btn ${NS}__next-round"
          data-combat-id="${combat.id}"
        >Next Round</button>
      </div>
    `;

    await ChatMessage.create({
      speaker: getSilentSpeaker(),
      content: contentA,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
    });

    const gmIds = getGMUserIds();
    if (gmIds.length) {
      await ChatMessage.create({
        speaker: getSilentSpeaker(),
        content: contentB,
        type: CONST.CHAT_MESSAGE_TYPES.OTHER,
        whisper: gmIds,
      });
    }
  }

  async function maybeAnnounceEndOfRound(combat) {
    if (!combat) return;

    // Only meaningful after round starts
    if ((combat.round ?? 0) <= 0) return;

    // End-of-turn deactivation state in lancer-initiative is represented as turn === null
    if (combat.turn !== null) return;

    const pendingTotal = getPendingActivationsTotal(combat);
    dlog("CHECK", "pendingTotal", pendingTotal);
    if (pendingTotal > 0) return;

    // Only the primary active GM creates messages
    if (!game.user?.isGM) return;
    if (!isPrimaryActiveGM()) return;

    // Dedupe per round (world flags are always valid)
    const announced = combat.getFlag(FLAG_SCOPE, FLAG_KEY_ANNOUNCED);
    if (announced === combat.round) return;

    try {
      await combat.setFlag(FLAG_SCOPE, FLAG_KEY_ANNOUNCED, combat.round);
    } catch (e) {
      console.warn(`[${MODULE_ID}][LI-EOR] setFlag failed (scope=world)`, e);
      // Don't block announcement if flags fail
    }

    await postEndOfRoundCards(combat);
  }

  function install() {
    // Idempotent install per client session
    if (globalThis.__FUC_LI_EOR_INSTALLED__) {
      dlog("INSTALL", "Already installed on this client");
      return;
    }
    globalThis.__FUC_LI_EOR_INSTALLED__ = true;

    const prevTurnByCombatId = new Map();

    injectStylesOnce();

    // Ensure every client hides headers for our cards and wires GM button if present
    Hooks.on("renderChatMessage", (message, html) => {
      injectStylesOnce();

      const msgEl = html?.[0];
      if (!msgEl) return;

      const isPublicCard = !!msgEl.querySelector?.(`[data-oni-li-eor="1"]`);
      const isControlCard = !!msgEl.querySelector?.(`[data-oni-li-eor-control="1"]`);

      if (isPublicCard || isControlCard) {
        msgEl.classList.add(`${NS}__msg`);
      }

      if (!isControlCard) return;

      // Control card is whispered to GM only, but hard-check anyway
      if (!game.user?.isGM) return;

      const btn = msgEl.querySelector?.(`button.${NS}__next-round`);
      if (!btn) return;

      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const combatId = btn.dataset.combatId;
        const combat = game.combats?.get(combatId);
        if (!combat) return ui.notifications?.warn("[LI EoR] Combat not found.");

        btn.disabled = true;
        try {
          await combat.nextRound();
        } catch (e) {
          console.error(`[${MODULE_ID}][LI-EOR] nextRound error`, e);
          btn.disabled = false;
        }
      });
    });

    // Detect turn changes (turn -> null indicates deactivation in lancer-initiative)
    Hooks.on("preUpdateCombat", (combat, change) => {
      if (!Object.prototype.hasOwnProperty.call(change ?? {}, "turn")) return;
      prevTurnByCombatId.set(combat.id, combat.turn);
    });

    Hooks.on("updateCombat", async (combat, change) => {
      if (!Object.prototype.hasOwnProperty.call(change ?? {}, "turn")) return;

      const prevTurn = prevTurnByCombatId.get(combat.id);
      const looksLikeTurnNull = (change.turn === null && combat.turn === null);
      const deactivatedByPrev = (prevTurn !== null && prevTurn !== undefined && combat.turn === null);

      if (deactivatedByPrev || looksLikeTurnNull) {
        await Promise.resolve();
        await maybeAnnounceEndOfRound(combat);
      }
    });

    // Reset dedupe on new round
    Hooks.on("combatRound", async (combat) => {
      if (!game.user?.isGM) return;
      if (!isPrimaryActiveGM()) return;

      try {
        await combat.unsetFlag(FLAG_SCOPE, FLAG_KEY_ANNOUNCED);
      } catch (e) {
        // ignore
      }
    });

    ui.notifications?.info("[FabulaUltimaCompanion] End of Round announcer installed.");
    dlog("INSTALL", "Installed hooks", {
      localUserId: game.user?.id ?? null,
      isGM: !!game.user?.isGM,
      primaryGmUserId: getPrimaryActiveGM()?.id ?? null,
      isPrimaryActiveGM: isPrimaryActiveGM()
    });
  }

  // Single-file module install point
  Hooks.once("ready", () => {
    try {
      install();
    } catch (e) {
      console.error(`[${MODULE_ID}][LI-EOR] install failed`, e);
    }
  });
})();