// ============================================================================
// ItemTransferQuantityUI (Foundry VTT v12)
// ----------------------------------------------------------------------------
// A tiny helper UI that asks the user "How many?" before adding an item into
// the Trade Window offer list.
//
// Install API:
//   window["oni.ItemTransferQuantityUI"].promptQuantity({
//     itemName: "Potion",
//     maxQuantity: 12,          // optional (null/undefined = no cap shown)
//     defaultQuantity: 1        // optional
//   }) -> Promise<number|null>  // number if confirmed, null if cancelled
// ============================================================================

(() => {
  const KEY = "oni.ItemTransferQuantityUI";

  if (window[KEY]) {
    console.warn("[ItemTransferQuantityUI] Already installed.");
    return;
  }

  function clampPositiveInt(n, fallback = 1) {
    const x = Number(n);
    if (!Number.isFinite(x)) return fallback;
    return Math.max(1, Math.floor(x));
  }

  // Safe HTML escape that works even if Foundry APIs change
  function escapeHTML(str) {
    const s = String(str ?? "");
    // Prefer Foundry's encoder if present
    if (typeof TextEditor?.encodeHTML === "function") return TextEditor.encodeHTML(s);

    // Fallback manual escape
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /**
   * Show a small dialog that asks for quantity.
   * Returns:
   *  - number (>=1) if confirmed
   *  - null if cancelled/closed
   */
  async function promptQuantity({ itemName, maxQuantity, defaultQuantity } = {}) {
    const name = String(itemName ?? "Item");
    const max =
      maxQuantity == null
        ? null
        : Math.max(1, Math.floor(Number(maxQuantity) || 1));

    const def = clampPositiveInt(defaultQuantity ?? 1, 1);
    const initial = max ? Math.min(def, max) : def;

    console.log("[ItemTransferQuantityUI] promptQuantity()", {
      itemName: name,
      maxQuantity: max,
      defaultQuantity: def
    });

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const content = `
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div style="font-weight:bold;">Trade Quantity</div>
          <div style="opacity:0.9;">
            How many <strong>${escapeHTML(name)}</strong> do you want to offer?
          </div>

          ${
            max
              ? `<div style="font-size:12px; opacity:0.8;">
                   Available (detected): <strong>${max}</strong>
                 </div>`
              : `<div style="font-size:12px; opacity:0.6;">
                   (No maximum detected — you can still type a number.)
                 </div>`
          }

          <input
            id="oni-qty-input"
            type="number"
            min="1"
            step="1"
            value="${initial}"
            style="width:120px;"
          />
        </div>
      `;

      const dlg = new Dialog({
        title: "Choose Quantity",
        content,
        buttons: {
          confirm: {
            icon: '<i class="fas fa-check"></i>',
            label: "Confirm",
            callback: (html) => {
              const raw = html.find("#oni-qty-input").val();
              let qty = clampPositiveInt(raw ?? 1, 1);

              if (max) qty = Math.min(qty, max);

              console.log("[ItemTransferQuantityUI] Confirmed quantity:", qty);
              finish(qty);
            }
          },
          cancel: {
            icon: '<i class="fas fa-times"></i>',
            label: "Cancel",
            callback: () => {
              console.log("[ItemTransferQuantityUI] Cancelled.");
              finish(null);
            }
          }
        },
        default: "confirm",
        close: () => {
          // Closed via X
          console.log("[ItemTransferQuantityUI] Closed dialog via X (treated as cancel).");
          finish(null);
        }
      });

      dlg.render(true);

      // Auto-focus the input after render
      setTimeout(() => {
        const el = document.querySelector("#oni-qty-input");
        if (el) {
          el.focus();
          el.select();
        }
      }, 50);
    });
  }

  window[KEY] = { promptQuantity };

  console.log('[ItemTransferQuantityUI] Installed as window["oni.ItemTransferQuantityUI"].');
})();
