// ============================================================================
// DEMO_TradeWindow_UI
// UI layer for the shared Trade Window – Foundry VTT v12
//
// UPDATED (Quantity support):
//  - On drop, prompt for quantity using ItemTransferQuantityUI
//  - Offer list displays "xN"
// ============================================================================

(() => {
  Hooks.once("ready", () => {

  const NS     = "__OniTradeWindow__";
  const GLOBAL = (globalThis[NS] = globalThis[NS] || {});

  const readAllSessions = GLOBAL.readAllSessions;
  const requestOp       = GLOBAL.requestOp;
  const esc             = GLOBAL.esc || ((v) => String(v ?? ""));

  if (!readAllSessions || !requestOp) {
    console.warn(
      "[OniTradeWindow_UI] Core helpers not available yet. " +
      "Make sure DEMO_TradeWindow_Core is loaded on this client."
    );
  }

  console.log(
    "=== [OniTradeWindow_UI] Install on user",
    game.user.id,
    "isGM:",
    game.user.isGM,
    "==="
  );

  function normalizePositiveInt(raw, fallback = 1) {
    let n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) n = fallback;
    return Math.max(1, Math.floor(n));
  }

  // ---------------------------------------------------------------------------
  // Helper: build offer item from drag data
  // ---------------------------------------------------------------------------
  async function buildOfferItemFromDragData(dragData) {
    if (!dragData || typeof dragData !== "object") {
      console.warn("[OniTradeWindow_UI] buildOfferItemFromDragData: no dragData.");
      return null;
    }

    console.log("[OniTradeWindow_UI] Raw drag data:", dragData);

    let uuid = dragData.uuid ?? null;
    let doc  = null;

    try {
      if (uuid) {
        doc = await fromUuid(uuid);
      } else if (dragData.id && dragData.type) {
        const collection =
          game.collections?.get(dragData.type) ??
          game[dragData.type]?.contents ??
          null;
        doc = collection?.get?.(dragData.id);
        if (doc && !uuid) uuid = doc.uuid;
      }
    } catch (err) {
      console.error("[OniTradeWindow_UI] Error resolving doc from drag:", err);
      doc = null;
    }

    if (!doc) {
      ui.notifications?.warn?.("OniTrade: Could not resolve dropped document. See console for details.");
      return null;
    }

    if (doc.documentName !== "Item") {
      console.warn("[OniTradeWindow_UI] Dropped document is not an Item:", {
        documentName: doc.documentName,
        dragData
      });
      ui.notifications?.warn?.("OniTrade: Please drop an Item document into the trade window.");
      return null;
    }

    const name = doc.name ?? "Item";
    const img =
      doc.img ??
      doc.prototypeToken?.texture?.src ??
      doc.texture?.src ??
      null;

    const offerItem = {
      itemUuid: uuid ?? doc.uuid ?? null,
      name,
      img
      // quantity is added later after prompt
    };

    console.log("[OniTradeWindow_UI] Built offerItem from drag:", offerItem);
    return offerItem;
  }

  // Try to detect max quantity from the source item doc (if embedded/has item_quantity)
  async function detectMaxQuantityFromItemUuid(itemUuid) {
    if (!itemUuid) return null;
    try {
      const doc = await fromUuid(itemUuid);
      const raw = doc?.system?.props?.item_quantity;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return null;
      return Math.floor(n);
    } catch (err) {
      console.warn("[OniTradeWindow_UI] detectMaxQuantityFromItemUuid failed (non-fatal):", err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Trade Window Application
  // ---------------------------------------------------------------------------
  class OniTradeWindowApp extends Application {
    constructor(options = {}) {
      super(options);

      this.requestId           = options.requestId;
      this.initiatorUserId     = options.initiatorUserId;
      this.targetUserId        = options.targetUserId;
      this.initiatorName       = options.initiatorName ?? "Initiator";
      this.targetName          = options.targetName ?? "Target";
      this.initiatorActorUuid  = options.initiatorActorUuid ?? null;
      this.targetActorUuid     = options.targetActorUuid ?? null;
      this.localSide           = options.localSide; // "initiator" | "target"
    }

    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id: "oni-trade-window",
        title: "Trade Window",
        width: 640,
        height: "auto",
        resizable: true,
        popOut: true
      });
    }

    async getData() {
      let sess = null;
      if (typeof readAllSessions === "function") {
        const allSessions = await readAllSessions();
        sess = allSessions[this.requestId] ?? null;
      } else {
        console.error("[OniTradeWindow_UI] readAllSessions not available.");
      }

      return {
        requestId: this.requestId,
        initiatorName: this.initiatorName,
        targetName: this.targetName,
        localSide: this.localSide,
        sess
      };
    }

    activateListeners(html) {
      super.activateListeners(html);

      console.log("[OniTradeWindow_UI] activateListeners called.", {
        requestId: this.requestId,
        localSide: this.localSide,
        hasRequestOp: typeof requestOp === "function"
      });

      const rootEl = html[0].querySelector("#oni-trade-root");
      if (!rootEl) {
        console.warn("[OniTradeWindow_UI] #oni-trade-root NOT FOUND in activateListeners.", {
          htmlElement: html[0]
        });
      } else {
        console.log("[OniTradeWindow_UI] Found #oni-trade-root.", rootEl);
      }

      // Confirm / Cancel buttons
      html.on("click", "[data-oni-trade-confirm]", async () => {
        console.log("[OniTradeWindow_UI] Confirm button clicked.", {
          requestId: this.requestId,
          side: this.localSide
        });

        if (typeof requestOp !== "function") {
          console.warn("[OniTradeWindow_UI] requestOp is not a function (confirm click).");
          return;
        }

        await requestOp({
          requestId: this.requestId,
          op: "confirm",
          side: this.localSide,
          initiatorUserId: this.initiatorUserId,
          targetUserId: this.targetUserId,
          initiatorName: this.initiatorName,
          targetName: this.targetName
        });
      });

      html.on("click", "[data-oni-trade-cancel]", async () => {
        console.log("[OniTradeWindow_UI] Cancel button clicked.", {
          requestId: this.requestId,
          side: this.localSide
        });

        if (typeof requestOp !== "function") {
          console.warn("[OniTradeWindow_UI] requestOp is not a function (cancel click).");
          return;
        }

        await requestOp({
          requestId: this.requestId,
          op: "cancel",
          side: this.localSide,
          initiatorUserId: this.initiatorUserId,
          targetUserId: this.targetUserId,
          initiatorName: this.initiatorName,
          targetName: this.targetName
        });
      });
    }

    async _renderInner(data) {
      const { requestId, initiatorName, targetName, localSide, sess } = data;

      const app = this;

      const confirmedInitiator = !!sess?.confirmInitiator;
      const confirmedTarget    = !!sess?.confirmTarget;
      const cancelled          = !!sess?.cancelled;
      const cancelledBySide    = sess?.cancelledBySide ?? null;
      const settled            = !!sess?.settled;

      const offerInitiator = Array.isArray(sess?.offerInitiator) ? sess.offerInitiator : [];
      const offerTarget    = Array.isArray(sess?.offerTarget)    ? sess.offerTarget    : [];

      const zenitOfferInitiator = Math.max(0, Math.floor(Number(sess?.zenitOfferInitiator ?? 0)));
      const zenitOfferTarget    = Math.max(0, Math.floor(Number(sess?.zenitOfferTarget    ?? 0)));

      // Auto-close when trade is settled
      if (settled) {
        console.log("[OniTradeWindow_UI] Session is settled; scheduling auto-close for Trade Window.", {
          requestId,
          localSide
        });

        setTimeout(() => {
          try {
            if (GLOBAL && GLOBAL.apps && GLOBAL.apps[requestId] === app) {
              delete GLOBAL.apps[requestId];
            }
            app.close({ force: true });
          } catch (err) {
            console.error("[OniTradeWindow_UI] Error while auto-closing Trade Window:", err);
          }
        }, 200);
      }

      const root = document.createElement("div");
      root.id = "oni-trade-root";
      root.style.padding = "12px";
      root.style.display = "flex";
      root.style.flexDirection = "column";
      root.style.gap = "12px";
      root.style.fontFamily = "sans-serif";

      // CSS
      const style = document.createElement("style");
      style.textContent = `
        #oni-trade-root .oni-trade-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 4px;
        }
        #oni-trade-root .oni-trade-header-title {
          font-weight: bold;
          font-size: 15px;
        }
        #oni-trade-root .oni-trade-you {
          font-size: 12px;
          opacity: 0.8;
        }
        #oni-trade-root .oni-trade-body {
          display: grid;
          grid-template-columns: 1fr 16px 1fr;
          gap: 8px;
        }
        #oni-trade-root .oni-trade-side {
          border: 1px solid var(--color-border, #666);
          border-radius: 8px;
          padding: 8px;
          min-height: 80px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          background: rgba(0,0,0,0.05);
        }
        #oni-trade-root .oni-trade-divider {
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          opacity: 0.8;
        }
        #oni-trade-root .oni-trade-side-title {
          font-weight: bold;
          font-size: 13px;
        }
        #oni-trade-root .oni-trade-side-sub {
          font-size: 11px;
          opacity: 0.8;
        }
        #oni-trade-root .oni-trade-drop-zone {
          min-height: 40px;
          border: 1px dashed rgba(0,0,0,0.3);
          border-radius: 6px;
          padding: 4px;
          font-size: 11px;
          opacity: 0.9;
          background: rgba(0,0,0,0.02);
          transition:
            border-color 150ms ease,
            background-color 150ms ease,
            box-shadow 150ms ease;
        }
        #oni-trade-root .oni-trade-drop-zone.is-hover {
          border-color: #ffcc66;
          background: rgba(255, 255, 255, 0.05);
          box-shadow: 0 0 8px rgba(255, 204, 102, 0.8);
        }
        #oni-trade-root .oni-trade-drop-zone.is-remote {
          opacity: 0.6;
        }
        #oni-trade-root .oni-trade-offer-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        #oni-trade-root .oni-trade-offer-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 2px;
        }
        #oni-trade-root .oni-trade-offer-left {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }
        #oni-trade-root .oni-trade-offer-item img {
          width: 18px;
          height: 18px;
          object-fit: contain;
          border-radius: 2px;
          flex: 0 0 auto;
        }
        #oni-trade-root .oni-trade-offer-name {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        #oni-trade-root .oni-trade-offer-qty {
          font-weight: bold;
          opacity: 0.9;
          flex: 0 0 auto;
        }
        #oni-trade-root .oni-trade-zenit-row {
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: 6px;
          font-size: 11px;
          margin-top: 4px;
        }
        #oni-trade-root .oni-trade-zenit-row input[type="number"] {
          max-width: 80px;
        }
        #oni-trade-root .oni-trade-zenit-value {
          font-weight: bold;
        }
        #oni-trade-root .oni-trade-zenit-icon {
          width: 24px;
          height: 24px;
          object-fit: contain;
          border: none;
          box-shadow: none;
          background: transparent;
        }
        #oni-trade-root .oni-trade-buttons {
          display: flex;
          gap: 6px;
          margin-top: 8px;
        }
        #oni-trade-root .oni-trade-meta {
          font-size: 12px;
          opacity: 0.8;
          margin-top: 4px;
        }
        #oni-trade-root .oni-trade-status-ok {
          color: #2e8b57;
        }
        #oni-trade-root .oni-trade-status-wait {
          color: #c27c0e;
        }
        #oni-trade-root .oni-trade-status-cancel {
          color: #b22222;
        }
      `;
      root.appendChild(style);

      // Header
      const header = document.createElement("div");
      header.classList.add("oni-trade-header");

      const headerTitle = document.createElement("div");
      headerTitle.classList.add("oni-trade-header-title");
      headerTitle.textContent = `Trade: ${initiatorName} ↔ ${targetName}`;

      const headerYou = document.createElement("div");
      headerYou.classList.add("oni-trade-you");
      headerYou.innerHTML = `You are: <strong>${
        localSide === "initiator" ? esc(initiatorName) : esc(targetName)
      }</strong>`;

      header.append(headerTitle, headerYou);

      const body = document.createElement("div");
      body.classList.add("oni-trade-body");

      // Offer list now displays quantity
      function buildOfferList(offers) {
        if (!offers || offers.length === 0) {
          const p = document.createElement("div");
          p.style.opacity = "0.8";
          p.textContent = "Drag Items here to offer them in the trade.";
          return p;
        }

        const ul = document.createElement("ul");
        ul.classList.add("oni-trade-offer-list");

        for (const off of offers) {
          const li = document.createElement("li");
          li.classList.add("oni-trade-offer-item");

          const left = document.createElement("div");
          left.classList.add("oni-trade-offer-left");

          if (off.img) {
            const img = document.createElement("img");
            img.src = off.img;
            img.alt = off.name ?? "Item";
            left.appendChild(img);
          }

          const nameSpan = document.createElement("span");
          nameSpan.classList.add("oni-trade-offer-name");
          nameSpan.textContent = off.name ?? "Item";
          left.appendChild(nameSpan);

          const qty = normalizePositiveInt(off.quantity ?? 1, 1);
          const qtySpan = document.createElement("span");
          qtySpan.classList.add("oni-trade-offer-qty");
          qtySpan.textContent = `x${qty}`;

          li.append(left, qtySpan);
          ul.appendChild(li);
        }

        return ul;
      }

      function buildSide(sideKey, displayName, isLocal, isConfirmed, offers, zenitOffer) {
        const sideDiv = document.createElement("div");
        sideDiv.classList.add("oni-trade-side");

        const title = document.createElement("div");
        title.classList.add("oni-trade-side-title");
        title.textContent = displayName;

        const sub = document.createElement("div");
        sub.classList.add("oni-trade-side-sub");
        sub.textContent = isLocal ? "This is you." : "The other trader.";

        const itemsBox = document.createElement("div");
        itemsBox.classList.add("oni-trade-drop-zone");
        itemsBox.dataset.side = sideKey;
        if (!isLocal) itemsBox.classList.add("is-remote");

        itemsBox.appendChild(buildOfferList(offers));

        // Drag/drop only on local side, and only if not cancelled/settled
        if (isLocal && !cancelled && !settled && typeof requestOp === "function") {
          console.log("[OniTradeWindow_UI] Wiring drag/drop on local itemsBox.", {
            requestId,
            sideKey,
            localSide
          });

          const setHover = (hover) => itemsBox.classList.toggle("is-hover", hover);

          itemsBox.addEventListener("dragover", (event) => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
            setHover(true);
          });

          itemsBox.addEventListener("dragleave", (event) => {
            event.preventDefault();
            setHover(false);
          });

          itemsBox.addEventListener("drop", async (event) => {
            event.preventDefault();
            setHover(false);

            console.log("[OniTradeWindow_UI] DROP on itemsBox.", {
              requestId,
              sideKey,
              localSide,
              hasRequestOp: typeof requestOp === "function"
            });

            if (typeof requestOp !== "function") {
              console.warn("[OniTradeWindow_UI] requestOp is not a function; aborting drop.");
              return;
            }

            let dragData;
            try {
              dragData = TextEditor.getDragEventData(event) || {};
            } catch (err) {
              console.error("[OniTradeWindow_UI] Error in TextEditor.getDragEventData:", err);
              return;
            }

            const offerItem = await buildOfferItemFromDragData(dragData);
            if (!offerItem) return;

            // 1) Detect max quantity if possible
            const maxQty = await detectMaxQuantityFromItemUuid(offerItem.itemUuid);

            // 2) Prompt user for quantity
            const QtyUI = window["oni.ItemTransferQuantityUI"];
            let chosenQty = 1;

            if (!QtyUI || typeof QtyUI.promptQuantity !== "function") {
              console.warn(
                "[OniTradeWindow_UI] ItemTransferQuantityUI missing; fallback to quantity=1."
              );
              chosenQty = 1;
            } else {
              const res = await QtyUI.promptQuantity({
                itemName: offerItem.name,
                maxQuantity: maxQty,
                defaultQuantity: 1
              });

              // Cancel → do nothing
              if (res == null) {
                console.log("[OniTradeWindow_UI] Quantity prompt cancelled; not adding offer.");
                return;
              }

              chosenQty = normalizePositiveInt(res, 1);
              if (maxQty) chosenQty = Math.min(chosenQty, maxQty);
            }

            offerItem.quantity = chosenQty;

            console.log("[OniTradeWindow_UI] Sending addOfferItem with quantity:", {
              offerItem,
              localSide: app.localSide,
              sideKey
            });

            await requestOp({
              requestId: app.requestId,
              op: "addOfferItem",
              side: app.localSide,
              initiatorUserId: app.initiatorUserId,
              targetUserId: app.targetUserId,
              initiatorName: app.initiatorName,
              targetName: app.targetName,
              initiatorActorUuid: app.initiatorActorUuid,
              targetActorUuid: app.targetActorUuid,
              item: offerItem
            });
          });
        }

        // Zenit row
        const zenitRow = document.createElement("div");
        zenitRow.classList.add("oni-trade-zenit-row");

        const zenitIcon = document.createElement("img");
        zenitIcon.src = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png";
        zenitIcon.alt = "Zenit";
        zenitIcon.classList.add("oni-trade-zenit-icon");

        if (isLocal) {
          const input = document.createElement("input");
          input.type = "number";
          input.min = "0";
          input.step = "1";
          input.value = String(zenitOffer || 0);
          input.disabled = cancelled || settled;

          input.addEventListener("change", async (event) => {
            if (typeof requestOp !== "function") return;

            let amt = Number(event.currentTarget.value);
            if (!Number.isFinite(amt) || amt < 0) amt = 0;
            amt = Math.floor(amt);

            await requestOp({
              requestId: app.requestId,
              op: "setZenitOffer",
              side: app.localSide,
              initiatorUserId: app.initiatorUserId,
              targetUserId: app.targetUserId,
              initiatorName: app.initiatorName,
              targetName: app.targetName,
              initiatorActorUuid: app.initiatorActorUuid,
              targetActorUuid: app.targetActorUuid,
              amount: amt
            });
          });

          zenitRow.append(zenitIcon, input);
        } else {
          const value = document.createElement("span");
          value.classList.add("oni-trade-zenit-value");
          value.textContent = String(zenitOffer || 0);
          zenitRow.append(zenitIcon, value);
        }

        // Status line
        const status = document.createElement("div");
        status.classList.add("oni-trade-meta");
        if (isConfirmed) {
          status.classList.add("oni-trade-status-ok");
          status.textContent = "Status: Confirmed.";
        } else {
          status.classList.add("oni-trade-status-wait");
          status.textContent = "Status: Waiting for confirmation.";
        }

        sideDiv.append(title, sub, itemsBox, zenitRow, status);

        if (isLocal && !cancelled) {
          const btnRow = document.createElement("div");
          btnRow.classList.add("oni-trade-buttons");

          const confirmBtn = document.createElement("button");
          confirmBtn.type = "button";
          confirmBtn.dataset.oniTradeConfirm = "1";
          confirmBtn.textContent =
            isConfirmed && !settled ? "Confirmed" :
            settled                ? "Trade Completed" :
                                     "Confirm Trade";
          confirmBtn.disabled = isConfirmed || settled;

          const cancelBtn = document.createElement("button");
          cancelBtn.type = "button";
          cancelBtn.dataset.oniTradeCancel = "1";
          cancelBtn.textContent = "Cancel Trade";
          cancelBtn.disabled = settled;

          btnRow.append(confirmBtn, cancelBtn);
          sideDiv.appendChild(btnRow);
        }

        return sideDiv;
      }

      const leftIsLocal  = localSide === "initiator";
      const rightIsLocal = localSide === "target";

      const leftSide = buildSide(
        "initiator",
        initiatorName,
        leftIsLocal,
        confirmedInitiator,
        offerInitiator,
        zenitOfferInitiator
      );

      const rightSide = buildSide(
        "target",
        targetName,
        rightIsLocal,
        confirmedTarget,
        offerTarget,
        zenitOfferTarget
      );

      const divider = document.createElement("div");
      divider.classList.add("oni-trade-divider");
      divider.textContent = "⇄";

      body.append(leftSide, divider, rightSide);

      const footer = document.createElement("div");
      footer.classList.add("oni-trade-meta");

      if (cancelled) {
        footer.classList.add("oni-trade-status-cancel");
        const who =
          cancelledBySide === "initiator"
            ? initiatorName
            : cancelledBySide === "target"
            ? targetName
            : "Someone";
        footer.innerHTML = `Trade has been cancelled by <strong>${esc(who)}</strong>.`;
      } else if (settled) {
        footer.classList.add("oni-trade-status-ok");
        footer.textContent = "Trade completed. Items and Zenit have been transferred.";
      } else if (confirmedInitiator && confirmedTarget) {
        footer.classList.add("oni-trade-status-ok");
        footer.textContent = "Both sides have confirmed. Finalizing trade...";
      } else {
        footer.classList.add("oni-trade-status-wait");
        footer.textContent = "Drag items into your side, set your Zenit offer, and confirm when ready.";
      }

      root.append(header, body, footer);
      return $(root);
    }
  }

   GLOBAL.AppClass = OniTradeWindowApp;

  // Debug / status (does not change logic)
  GLOBAL.uiInstalled = true;
  GLOBAL.installed = true;

  console.log("[OniTradeWindow_UI] AppClass registered into __OniTradeWindow__.");
  });
})();
