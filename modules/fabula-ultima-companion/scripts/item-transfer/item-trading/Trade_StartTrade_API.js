// ============================================================================
// Trade_StartTrade_API (Foundry VTT v12)
// ----------------------------------------------------------------------------
// Module-side wrapper for the old DEMO_Trade_StartTrade macro.
// 
// Why this file exists:
// - In a module, scripts auto-load at game start.
// - The old macro was an IIFE that would immediately pop a dialog.
// - We keep the SAME logic, but wrap it in a callable function.
//
// Public API:
//   await window["oni.TradeStartTrade"].startTrade();
// ============================================================================

(() => {
  const KEY = "oni.TradeStartTrade";

  // Avoid double-install
  if (window[KEY]) {
    console.warn("[Trade_StartTrade_API] Already installed.");
    return;
  }

  async function startTrade() {
    const MODULE_ID = "fabula-ultima-companion";
    const CHANNEL   = `module.${MODULE_ID}`;

    const localUser = game.user;

    if (!game.socket) {
      ui.notifications?.error?.("OniTrade: game.socket is not available.");
      return;
    }

    // Ensure there is at least one active GM (someone to mediate)
    const activeGMs = game.users.filter((u) => u.isGM && u.active);
    if (activeGMs.length === 0) {
      ui.notifications?.error?.("OniTrade: No active GM online to act as server.");
      return;
    }

    // Small HTML escaper
    const esc = (v) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;");

    // ---------------------------------------------------------------------------
    // Build list of possible trade targets
    // ---------------------------------------------------------------------------
    const candidates = [];

    for (const user of game.users) {
      if (!user.active) continue;
      if (user.id === localUser.id) continue; // cannot trade with yourself

      // If this user is GM: always offer as "GM / System"
      if (user.isGM) {
        candidates.push({
          userId: user.id,
          userName: user.name ?? "GM",
          isGM: true,
          actorUuid: null,
          label: `${user.name ?? "GM"} (GM / System)`
        });
        continue;
      }

      // For non-GM users, we require they have a linked actor for trade.
      const char = user.character;
      if (!char) {
        console.warn(
          "[OniTrade] Skipping user with no linked actor for trade.",
          user.id,
          user.name
        );
        continue;
      }

      candidates.push({
        userId: user.id,
        userName: user.name ?? "Player",
        isGM: false,
        actorUuid: char.uuid,
        label: `${user.name ?? "Player"} – Actor: ${char.name}`
      });
    }

    if (candidates.length === 0) {
      ui.notifications?.warn?.(
        "OniTrade: No valid trade targets found (no other active users with actors)."
      );
      return;
    }

    // ---------------------------------------------------------------------------
    // Build the dialog HTML
    // ---------------------------------------------------------------------------
    const optionsHtml = candidates
      .map((c, idx) => {
        const value = [
          c.userId,
          c.actorUuid ?? "",
          c.isGM ? "1" : "0"
        ].join("|");
        return `<option value="${esc(value)}"${idx === 0 ? " selected" : ""}>${esc(
          c.label
        )}</option>`;
      })
      .join("");

    const localChar = localUser.character ?? null;
    const localSideDescription = localUser.isGM
      ? `You are GM (System side).`
      : localChar
      ? `You are controlling Actor: <strong>${esc(localChar.name)}</strong>.`
      : `You are a player without a linked Actor (you can still trade as GM/System side).`;

    const content = `
      <form>
        <p style="margin-bottom:0.5rem;">
          ${localSideDescription}
        </p>
        <div class="form-group">
          <label for="oni-trade-target-select"><strong>Who do you want to trade with?</strong></label>
          <select name="oni-trade-target" id="oni-trade-target-select" style="width:100%;margin-top:0.25rem;">
            ${optionsHtml}
          </select>
        </div>
        <p style="margin-top:0.5rem;font-size:11px;opacity:0.8;">
          Tip: This only starts the trade. The other player still has to accept.<br>
          A GM mediates the process using the OniTrade module listener.
        </p>
      </form>
    `;

    // ---------------------------------------------------------------------------
    // Show the dialog and get user choice
    // ---------------------------------------------------------------------------
    const dialogResult = await new Promise((resolve) => {
      new Dialog({
        title: "Start Trade",
        content,
        buttons: {
          ok: {
            label: "Start Trade",
            callback: (html) => {
              const form = html[0].querySelector("form");
              const select = form.querySelector("select[name='oni-trade-target']");
              const raw = select?.value ?? "";
              resolve({ choice: raw });
            }
          },
          cancel: {
            label: "Cancel",
            callback: () => resolve(null)
          }
        },
        default: "ok"
      }).render(true);
    });

    if (!dialogResult) {
      console.log("[OniTrade] User cancelled StartTrade dialog.");
      return;
    }

    const rawChoice = dialogResult.choice ?? "";
    if (!rawChoice) {
      ui.notifications?.warn?.("OniTrade: No target selected.");
      return;
    }

    const [targetUserId, targetActorUuidRaw, isGMFlag] = rawChoice.split("|");
    const targetActorUuid = targetActorUuidRaw || null;
    const targetIsGM      = isGMFlag === "1";

    const targetUser = game.users.get(targetUserId);
    if (!targetUser) {
      ui.notifications?.error?.("OniTrade: Selected target user no longer exists.");
      return;
    }

    if (!targetUser.active) {
      ui.notifications?.error?.("OniTrade: Selected target is not active.");
      return;
    }

    const targetName = targetUser.name ?? "Unknown";

    // ---------------------------------------------------------------------------
    // Build OniTrade_Request payload
    // ---------------------------------------------------------------------------
    const requestId = randomID();

    const initiatorUserId = localUser.id;
    const initiatorName   = localUser.name ?? "Unknown";

    const initiatorActor  = localUser.character ?? null;
    const initiatorActorUuid = initiatorActor ? initiatorActor.uuid : null;

    const payload = {
      requestId,
      initiatorUserId,
      initiatorName,
      initiatorActorUuid,
      targetUserId,
      targetName,
      targetActorUuid
    };

    console.log("[OniTrade] Emitting OniTrade_Request on", CHANNEL, "payload:", payload);

    game.socket.emit(CHANNEL, {
      type: "OniTrade_Request",
      payload
    });

    ui.notifications?.info?.(
      `OniTrade: Sent trade request to ${targetName}. Waiting for them to accept.`
    );
  }

  window[KEY] = {
    startTrade
  };

  console.log('[Trade_StartTrade_API] Installed as window["oni.TradeStartTrade"].');
})();
