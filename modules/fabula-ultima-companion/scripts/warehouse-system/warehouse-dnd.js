// scripts/warehouse-system/warehouse-dnd.js
// ----------------------------------------------------------------------------
// ONI Warehouse — Drag & Drop (Planning only)
//
// PATCH:
// - Tight quantity logic: live clamp while typing (prevents "9999 but stays 2" confusion)
// - Shows a small "clamped" hint when user exceeds max/min
// - Prevents keyboard events from bubbling to Foundry while typing in the qty dialog
// ----------------------------------------------------------------------------

import { WarehouseDebug } from "./warehouse-debug.js";

export class WarehouseDnD {
  static init(root, payload, { onChange } = {}) {
    if (!root) return;

    // DOM-level guard (important: rerender replaces DOM, so new root must bind again)
    if (root.dataset.whDndBound === "1") return;
    root.dataset.whDndBound = "1";

    const state = {
      dragging: false,
      originSide: null,
      originUuid: null,
      originName: null,
      originType: null,
      originQty: 1,
      originImg: null,
      originDesc: null,
      ghostEl: null
    };

    const makeGhost = (imgSrc) => {
      const g = document.createElement("img");
      g.className = "wh-ghost";
      g.src = imgSrc;
      g.style.position = "fixed";
      g.style.zIndex = "1000000";
      g.style.width = "44px";
      g.style.height = "44px";
      g.style.opacity = "0.65";
      g.style.pointerEvents = "none";
      g.style.borderRadius = "10px";
      g.style.boxShadow = "0 10px 25px rgba(0,0,0,0.35)";
      document.body.appendChild(g);
      return g;
    };

    const moveGhost = (ev) => {
      if (!state.ghostEl) return;
      const pad = 10;
      state.ghostEl.style.left = `${ev.clientX + pad}px`;
      state.ghostEl.style.top = `${ev.clientY + pad}px`;
    };

    const killGhost = () => {
      if (state.ghostEl?.parentNode) state.ghostEl.parentNode.removeChild(state.ghostEl);
      state.ghostEl = null;
    };

    const findDropSide = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const panel = el?.closest?.(".wh-panel");
      const side = panel?.dataset?.side;
      return side === "actor" || side === "storage" ? side : null;
    };

    const getVirtualQty = (side, itemUuid) => {
      const snapList = side === "actor" ? (payload.snapshot.actorItems ?? []) : (payload.snapshot.storageItems ?? []);
      const base = snapList.find(it => (it.itemUuid ?? it.uuid) === itemUuid);
      const baseQty = Number(base?.qty ?? 1);

      const moves = payload.plan?.itemMoves ?? [];
      let delta = 0;

      for (const m of moves) {
        if (m.itemUuid !== itemUuid) continue;
        if (m.from === side) delta -= Number(m.qty ?? 0);
        if (m.to === side) delta += Number(m.qty ?? 0);
      }

      return Math.max(0, baseQty + delta);
    };

    const pushPlannedMove = ({ from, to, itemUuid, itemName, itemType, itemImg, itemDesc, qty }) => {
      payload.plan.itemMoves = payload.plan.itemMoves ?? [];

      payload.plan.itemMoves.push({
        id: crypto.randomUUID?.() ?? Math.random().toString(16).slice(2),
        ts: Date.now(),
        userId: payload.ctx.userId,
        from,
        to,
        itemUuid,
        itemName,
        itemType,

        // preserve meta for preview
        itemImg,
        itemDesc,

        qty
      });

      payload.plan.lastEditedAt = Date.now();
      payload.plan.lastEditedBy = payload.ctx.userId;

      WarehouseDebug.log(payload, "DND", "Planned move added", {
        from, to, itemName, itemUuid, qty,
        hasImg: !!itemImg,
        hasDesc: !!itemDesc,
        totalMoves: payload.plan.itemMoves.length
      });
    };

    // ✅ Tight quantity prompt (live clamp + clear feedback)
    const promptQuantity = async ({ max, defaultValue = 1 }) => {
      const safeMax = Math.max(1, Math.floor(Number(max ?? 1)));
      const safeDefault = Math.min(safeMax, Math.max(1, Math.floor(Number(defaultValue ?? 1))));

      return await new Promise((resolve) => {
        let resolved = false;
        const finish = (result) => {
          if (resolved) return;
          resolved = true;
          resolve(result);
        };

        const dlg = new Dialog({
          title: "Move Quantity",
          content: `
            <div style="display:flex; flex-direction:column; gap:10px;">
              <div>How many do you want to move?</div>

              <input class="wh-qty-input" type="number" min="1" max="${safeMax}" step="1" value="${safeDefault}"
                     style="width: 120px; padding: 6px 8px; border-radius: 8px;">

              <div class="wh-qty-hint" style="opacity:0.75; font-size:12px;">Max: ${safeMax}</div>
              <div class="wh-qty-clamp" style="display:none; opacity:0.85; font-size:12px; color:#ffd1d1;">
                Value clamped to allowed range.
              </div>
            </div>
          `,
          buttons: {
            ok: {
              icon: '<i class="fas fa-check"></i>',
              label: "Confirm",
              callback: (html) => {
                const el = html[0].querySelector(".wh-qty-input");
                const raw = Math.floor(Number(el?.value ?? safeDefault));
                const numeric = Number.isFinite(raw) ? raw : safeDefault;

                const finalV = Math.max(1, Math.min(safeMax, numeric));
                finish({ ok: true, qty: finalV });
              }
            },
            cancel: {
              icon: '<i class="fas fa-times"></i>',
              label: "Cancel",
              callback: () => finish({ ok: false })
            }
          },
          default: "ok",
          close: () => finish({ ok: false }),
          render: (html) => {
            const input = html[0].querySelector(".wh-qty-input");
            const clampMsg = html[0].querySelector(".wh-qty-clamp");

            if (!input) return;

            // Stop Foundry keybinds while typing
            const stop = (ev) => ev.stopPropagation();
            input.addEventListener("keydown", stop);
            input.addEventListener("keyup", stop);
            input.addEventListener("keypress", stop);
            input.addEventListener("mousedown", stop);

            const clampNow = () => {
              const raw = Math.floor(Number(input.value ?? safeDefault));
              const numeric = Number.isFinite(raw) ? raw : safeDefault;

              const clamped = Math.max(1, Math.min(safeMax, numeric));

              // If user exceeded range, immediately clamp the visible value
              if (String(clamped) !== String(numeric)) {
                input.value = String(clamped);
                if (clampMsg) clampMsg.style.display = "block";
              } else {
                if (clampMsg) clampMsg.style.display = "none";
              }
            };

            input.addEventListener("input", clampNow);
            input.addEventListener("blur", clampNow);

            // Autofocus for speed
            setTimeout(() => {
              input.focus();
              input.select();
            }, 10);
          }
        }, { width: 380 });

        dlg.render(true);
      });
    };

    const beginDrag = (ev, slot) => {
      const side = slot.dataset.side;
      const uuid = slot.dataset.itemUuid;
      const name = slot.dataset.itemName;
      const type = slot.dataset.itemType;

      const available = getVirtualQty(side, uuid);
      if (available <= 0) {
        WarehouseDebug.warn(payload, "DND", "Drag blocked (qty=0)", { side, uuid, name });
        return;
      }

      state.dragging = true;
      state.originSide = side;
      state.originUuid = uuid;
      state.originName = name;
      state.originType = type;
      state.originQty = available;

      // capture meta from slot (always correct)
      const imgEl = slot.querySelector("img");
      state.originImg = imgEl?.src ?? null;
      state.originDesc = slot.dataset.itemDesc ?? null;

      state.ghostEl = makeGhost(state.originImg || "icons/svg/item-bag.svg");
      moveGhost(ev);

      WarehouseDebug.log(payload, "DND", "Drag start", {
        side, uuid, name, available,
        hasImg: !!state.originImg,
        hasDesc: !!state.originDesc
      });
    };

    const endDrag = async (ev) => {
      if (!state.dragging) return;

      const dropSide = findDropSide(ev);
      const from = state.originSide;
      const to = dropSide;

      WarehouseDebug.log(payload, "DND", "Drag end", { from, to, name: state.originName });

      killGhost();
      state.dragging = false;

      if (!to || to === from) return;

      const max = getVirtualQty(from, state.originUuid);
      if (max <= 0) {
        WarehouseDebug.warn(payload, "DND", "Drop blocked: no qty left in planning space", {
          from, to, uuid: state.originUuid
        });
        return;
      }

      const q = await promptQuantity({ max, defaultValue: 1 });
      if (!q.ok) {
        WarehouseDebug.log(payload, "DND", "Quantity cancelled", {});
        return;
      }

      pushPlannedMove({
        from,
        to,
        itemUuid: state.originUuid,
        itemName: state.originName,
        itemType: state.originType,
        itemImg: state.originImg,
        itemDesc: state.originDesc,
        qty: q.qty
      });

      onChange?.();
      ui.notifications?.info?.(`Planned: Move ${q.qty} × ${state.originName}`);
    };

    // Pointer event wiring (delegation)
    root.addEventListener("pointerdown", (ev) => {
      const slot = ev.target?.closest?.(".oni-inv-slot.oni-item");
      if (!slot) return;
      if (ev.button !== 0) return;

      ev.preventDefault();
      beginDrag(ev, slot);
      root.setPointerCapture?.(ev.pointerId);
    });

    root.addEventListener("pointermove", (ev) => {
      if (!state.dragging) return;
      moveGhost(ev);
    });

    root.addEventListener("pointerup", async (ev) => {
      if (!state.dragging) return;
      await endDrag(ev);
      root.releasePointerCapture?.(ev.pointerId);
    });

    root.addEventListener("pointercancel", () => {
      if (!state.dragging) return;
      killGhost();
      state.dragging = false;
      WarehouseDebug.warn(payload, "DND", "Drag cancelled", {});
    });

    window.addEventListener("blur", () => {
      if (!state.dragging) return;
      killGhost();
      state.dragging = false;
    });
  }
}
