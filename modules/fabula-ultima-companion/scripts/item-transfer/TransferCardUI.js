// ============================================================================
// TransferCardUI (Foundry VTT v12) — Receiver-only "Obtained Item" popup
// ----------------------------------------------------------------------------
// - Installs once per browser (singleton manager)
// - Uses socket broadcast, but each client decides locally whether to show,
//   based on recipientUserIds (multi-client pattern).
//
// Public API:
//   window["oni.TransferCardUI"].showLocal(payload)   // local-only (debug)
//   window["oni.TransferCardUI"].emitToRecipients(payload) // GM-side helper (optional)
//
// Socket message format (what ItemTransferCore will emit):
//   {
//     type: "ONI_ITEMTRANSFER_SHOW_CARD",
//     payload: {
//       recipientUserIds: string[],   // only these users show the card
//       quantity: number,
//       itemName: string,
//       itemImg: string,
//       receiverActorUuid?: string,
//       receiverItemUuid?: string,
//       lingerSeconds?: number,
//       scale?: number
//     }
//   }
// ============================================================================

(() => {
  const NSKEY = "oni.TransferCardUI";

  // Avoid double-installing
  if (window[NSKEY]?.installed) {
    console.warn(`[TransferCardUI] Already installed as window["${NSKEY}"].`);
    return;
  }

  const TransferCardUI = (window[NSKEY] = window[NSKEY] || {});
  TransferCardUI.installed = true;

  // ---------------------------
  // CONFIG (edit if needed)
  // ---------------------------

  // IMPORTANT:
  // This should match the same channel you already use for multi-client UI patterns.
  // If your module id is different, change it here AND in ItemTransferCore patch.
  const SOCKET_CHANNEL = "module.fabula-ultima-companion";

  const MSG_TYPE_SHOW_CARD = "ONI_ITEMTRANSFER_SHOW_CARD";

  const DEFAULT_SCALE = 1.1;
  const DEFAULT_LINGER_SECONDS = 3.0;
  const ANIM_DURATION_MS = 400;

  const STYLE_ID = "oni-item-transfer-style";
  const CONTAINER_ID = "oni-item-transfer-container";

  // ---------------------------
  // CSS / DOM helpers
  // ---------------------------

  function ensureCss() {
    const existing = document.getElementById(STYLE_ID);
    if (existing) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
#${CONTAINER_ID} {
  position: fixed;
  top: 80px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

/* The card itself */
.oni-item-transfer-card {
  background: rgba(255, 255, 255, 0.96);
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.25);
  padding: 4px 10px;
  min-width: 260px;
  max-width: 360px;
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.35);
  font-family: var(--font-primary, "Signika"), sans-serif;
  font-size: 13px;
  color: #222;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: translateY(-20px) scale(var(--oni-item-transfer-scale, 1));
  transition:
    opacity ${ANIM_DURATION_MS}ms ease-out,
    transform ${ANIM_DURATION_MS}ms ease-out;
  pointer-events: none;
}

.oni-item-transfer-card.oni-show {
  opacity: 1;
  transform: translateY(0) scale(var(--oni-item-transfer-scale, 1));
}

.oni-item-transfer-card.oni-hide {
  opacity: 0;
  transform: translateY(-20px) scale(var(--oni-item-transfer-scale, 1));
}

.oni-item-transfer-label {
  font-weight: 600;
  margin-right: 4px;
}

.oni-item-transfer-qty {
  font-weight: 600;
  margin-right: 4px;
}

.oni-item-transfer-icon {
  width: 24px;
  height: 24px;
  margin: 0 4px;
  image-rendering: pixelated;
  border-radius: 3px;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3);
  background: rgba(0, 0, 0, 0.1);
}

.oni-item-transfer-name {
  margin-left: 2px;
}
    `;
    document.head.appendChild(style);
  }

  function ensureContainer() {
    let container = document.getElementById(CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = CONTAINER_ID;
      document.body.appendChild(container);
    }
    return container;
  }

  function setScale(scale) {
    const s = Number(scale);
    const safe = Number.isFinite(s) && s > 0 ? s : DEFAULT_SCALE;
    document.documentElement.style.setProperty("--oni-item-transfer-scale", safe.toString());
    return safe;
  }

  function normalizeQty(qty) {
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.max(1, Math.floor(n));
  }

  function normalizeLingerSeconds(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LINGER_SECONDS;
    return Math.max(0.5, n);
  }

  function showCardNow({ quantity, itemName, itemImg, scale, lingerSeconds }) {
    ensureCss();
    const container = ensureContainer();

    const safeQty = normalizeQty(quantity);
    const safeScale = setScale(scale);
    const lingerMs = normalizeLingerSeconds(lingerSeconds) * 1000;

    const card = document.createElement("div");
    card.classList.add("oni-item-transfer-card");

    card.innerHTML = `
      <span class="oni-item-transfer-label">Obtained</span>
      <span class="oni-item-transfer-qty">${safeQty}</span>
      <img class="oni-item-transfer-icon" src="${itemImg}" alt="${itemName}">
      <span class="oni-item-transfer-name">${itemName}</span>
    `;

    container.appendChild(card);

    requestAnimationFrame(() => {
      card.classList.add("oni-show");
    });

    setTimeout(() => {
      card.classList.remove("oni-show");
      card.classList.add("oni-hide");

      setTimeout(() => {
        card.remove();
        if (!container.querySelector(".oni-item-transfer-card")) {
          container.remove();
        }
      }, ANIM_DURATION_MS);
    }, lingerMs);

    console.log(`[TransferCardUI] Shown: Obtained ${safeQty} × ${itemName} (scale=${safeScale}, linger=${lingerMs}ms)`);
  }

  // ---------------------------
  // Multi-client routing logic
  // ---------------------------

  function shouldThisClientShow(recipientUserIds) {
    const myId = game.user?.id;
    if (!myId) return false;
    if (!Array.isArray(recipientUserIds) || recipientUserIds.length === 0) return false;
    return recipientUserIds.includes(myId);
  }

  function onSocketMessage(data) {
    try {
      if (!data || typeof data !== "object") return;
      if (data.type !== MSG_TYPE_SHOW_CARD) return;

      const payload = data.payload || {};
      const recipientUserIds = payload.recipientUserIds || [];

      const okToShow = shouldThisClientShow(recipientUserIds);

      console.log("[TransferCardUI] Socket received:", {
        type: data.type,
        okToShow,
        myUserId: game.user?.id,
        recipientUserIds,
        payload
      });

      if (!okToShow) return;

      const itemName = String(payload.itemName || "");
      const itemImg = String(payload.itemImg || "");
      const quantity = payload.quantity;

      if (!itemName || !itemImg) {
        console.warn("[TransferCardUI] Missing itemName/itemImg in payload. Not showing card.", payload);
        return;
      }

      showCardNow({
        quantity,
        itemName,
        itemImg,
        scale: payload.scale,
        lingerSeconds: payload.lingerSeconds
      });
    } catch (err) {
      console.error("[TransferCardUI] Error handling socket message:", err);
    }
  }

  // Install socket listener once per browser
  function installSocketListener() {
  if (TransferCardUI._socketInstalled) {
    console.warn("[TransferCardUI] Socket listener already installed. Skipping.");
    return;
  }

  if (!game.socket) {
    console.error("[TransferCardUI] game.socket not found; cannot install multi-client listener.");
    return;
  }

  console.log(`[TransferCardUI] Installing socket listener on "${SOCKET_CHANNEL}"...`, {
    gameReady: game.ready,
    myUserId: game.user?.id,
    myName: game.user?.name
  });

  game.socket.on(SOCKET_CHANNEL, (data) => {
    onSocketMessage(data);
  });

  TransferCardUI._socketInstalled = true;
  console.log("[TransferCardUI] Socket listener installed.");
}

// If this script is run AFTER ready (macro/manual), install immediately.
// Otherwise, install on ready.
if (game.ready) {
  installSocketListener();
} else {
  Hooks.once("ready", installSocketListener);
}

  // ---------------------------
  // Public API
  // ---------------------------

  TransferCardUI.showLocal = function (payload) {
    // local-only (debug)
    const p = payload || {};
    showCardNow({
      quantity: p.quantity,
      itemName: p.itemName,
      itemImg: p.itemImg,
      scale: p.scale,
      lingerSeconds: p.lingerSeconds
    });
  };

  TransferCardUI.emitToRecipients = function (payload) {
  // Optional helper if you want to emit from other systems too.
  // NOTE: Any client can emit, but typically the GM or the “finalizer” client does.
  if (!game.socket) {
    console.error("[TransferCardUI] emitToRecipients failed: game.socket missing.");
    return;
  }

  const p = payload || {};
  const packet = {
    type: MSG_TYPE_SHOW_CARD,
    payload: p
  };

  console.log("[TransferCardUI] emitToRecipients(): emitting packet", {
    channel: SOCKET_CHANNEL,
    myUserId: game.user?.id,
    myName: game.user?.name,
    packet
  });

  // 1) Send to server so OTHER clients can receive it
  game.socket.emit(SOCKET_CHANNEL, packet);

  // 2) LOCAL LOOPBACK:
  // Foundry commonly does NOT echo socket.emit back to the sender client.
  // This forces the sender client to process the message too.
  // It still respects recipientUserIds filtering inside onSocketMessage().
  try {
    onSocketMessage(packet);
  } catch (err) {
    console.error("[TransferCardUI] emitToRecipients(): local loopback failed", err);
  }
};


  console.log(`[TransferCardUI] Installed as window["${NSKEY}"].`);
})();
