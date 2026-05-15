// ============================================================================
// Check Requester — Sidebar Button
//
// GM-only floating button (🎯). Dialog matches AEM theming.
// Actors from db-resolver (active party). Attr pickers scroll ◀▶ like
// Check-Roller. Attr B supports "—" (None) = single-die mode.
// ============================================================================

Hooks.once("ready", () => {
  (() => {
    const TAG = "[ONI][CheckRequester:Button]";
    const STATE_KEY = "__ONI_CR_BUTTON_STATE__";

    // -------------------------------------------------------------------------
    // CONFIG
    // -------------------------------------------------------------------------
    const CFG = {
      gmOnly: true,
      offsetRightPx: 313,
      offsetBottomPx: 322,
      sizePx: 60,
      zIndex: 83,
      iconText: "🎯",
      label: "Request Check",
    };

    const DOM = {
      ROOT_ID:  "oni-creq-button-root",
      BTN_ID:   "oni-creq-button",
      STYLE_ID: "oni-creq-button-style",
    };

    const STATE = (globalThis[STATE_KEY] ??= { installed: false });

    const cleanupUI = () => {
      try { document.getElementById(DOM.ROOT_ID)?.remove(); } catch (_) {}
      try { document.getElementById(DOM.STYLE_ID)?.remove(); } catch (_) {}
    };

    if (CFG.gmOnly && !game.user?.isGM) { cleanupUI(); return; }

    // -------------------------------------------------------------------------
    // Attribute definitions (mirrors Check-Roller)
    // -------------------------------------------------------------------------
    const ATTR_ICONS = {
      DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
      INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
      MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
      WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png",
    };
    const ATTRS_A = ["DEX", "INS", "MIG", "WLP"];
    const ATTRS_B = ["—",   "DEX", "INS", "MIG", "WLP"]; // "—" = 1-die / None

    const cycleAttr = (list, current, dir) => {
      const i = list.indexOf(current);
      const n = list.length;
      return list[((i < 0 ? 0 : i) + dir + n) % n];
    };

    // -------------------------------------------------------------------------
    // DB resolver — load active party members
    // -------------------------------------------------------------------------
    const loadPartyActors = async () => {
      try {
        const api = globalThis.FUCompanion?.api;
        if (typeof api?.getCurrentGameDb !== "function") return null;
        const resolved = await api.getCurrentGameDb();
        const db = resolved?.db;
        if (!db) return null;

        const props  = db.system?.props ?? {};
        const actors = [];
        for (let i = 1; i <= 4; i++) {
          const raw = String(props[`member_id_${i}`] ?? "").trim();
          if (!raw) continue;
          const uuid  = raw.startsWith("Actor.") ? raw : `Actor.${raw}`;
          const actor = await fromUuid(uuid).catch(() => null);
          if (actor) actors.push(actor);
        }
        return actors.length > 0 ? actors : null;
      } catch (e) {
        console.warn(TAG, "loadPartyActors failed:", e);
        return null;
      }
    };

    // Sprite image for the dialog card (full-body, like AEM)
    const getSpriteImg = (actor) => {
      const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
      const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
      return std || proto || actor.img || "icons/svg/mystery-man.svg";
    };

    // -------------------------------------------------------------------------
    // Scroll picker CSS + HTML
    // -------------------------------------------------------------------------
    const PICKER_CSS = `
      .oni-creq-pickers-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }

      .oni-creq-picker {
        display:grid; grid-template-columns:32px 1fr 32px;
        align-items:center; height:52px; border-radius:12px;
        border:2.5px solid rgba(87,58,33,.90);
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.55) 0%, rgba(255,255,255,.20) 22%, transparent 40%),
          linear-gradient(180deg,#fff3dc 0%,#f3e2bd 55%,#e8cea0 100%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.70), 0 4px 10px rgba(0,0,0,.10);
        overflow:hidden; user-select:none;
      }
      .oni-creq-picker.is-none {
        opacity:.55;
        border-style:dashed;
      }

      .oni-creq-picker-arrow {
        height:100%; width:100%; border:none; background:transparent;
        cursor:pointer; display:flex; align-items:center; justify-content:center;
        font-size:13px; opacity:.70; color:#2b1f17; padding:0;
      }
      .oni-creq-picker-arrow:hover { opacity:1; }

      .oni-creq-picker-center {
        display:flex; align-items:center; justify-content:center;
        gap:6px; overflow:hidden; height:100%;
      }
      .oni-creq-picker-icon {
        width:24px; height:24px; object-fit:contain; flex-shrink:0;
        border:none!important; background:transparent!important;
        box-shadow:none!important; outline:none!important;
      }
      .oni-creq-picker-name {
        font-size:13px; font-weight:900; color:#2b1f17;
        white-space:nowrap; min-width:2em; text-align:center;
      }
      .oni-creq-picker-sublabel {
        font-size:10px; font-weight:700; color:#2b1f17; opacity:.55;
        margin-top:1px;
      }
    `;

    const buildPickerHtml = (slot, attr, sublabel) => {
      const isNone = attr === "—";
      const icon   = isNone ? "" : ATTR_ICONS[attr] ?? "";
      const imgHtml = isNone
        ? `<span class="oni-creq-picker-name" style="font-size:18px;opacity:.4;">—</span>`
        : `<img class="oni-creq-picker-icon" src="${icon}" alt="${attr}">
           <div style="display:flex;flex-direction:column;align-items:center;">
             <div class="oni-creq-picker-name">${attr}</div>
             ${sublabel ? `<div class="oni-creq-picker-sublabel">${sublabel}</div>` : ""}
           </div>`;
      return `
        <div class="oni-creq-picker${isNone ? " is-none" : ""}" data-slot="${slot}" data-attr="${attr}">
          <button type="button" class="oni-creq-picker-arrow" data-dir="-1">◀</button>
          <div class="oni-creq-picker-center">${imgHtml}</div>
          <button type="button" class="oni-creq-picker-arrow" data-dir="1">▶</button>
        </div>`;
    };

    // -------------------------------------------------------------------------
    // Dialog HTML
    // -------------------------------------------------------------------------
    const buildDialogContent = (partyActors, preSelectedUuids, stateA, stateB) => {
      const actorCards = partyActors.map(a => {
        const img  = getSpriteImg(a);
        const sel  = preSelectedUuids.has(a.uuid);
        const cid  = `oni-creq-ac-${a.id}`;
        return `
          <label class="oni-creq-actor-card${sel ? " sel" : ""}" for="${cid}" title="${a.name}">
            <input type="checkbox" id="${cid}" name="actor" value="${a.uuid}"${sel ? " checked" : ""}>
            <div class="oni-creq-actor-img-wrap">
              <img src="${img}" alt="" onerror="this.src='icons/svg/mystery-man.svg'">
            </div>
            <div class="oni-creq-actor-lbl">${a.name}</div>
          </label>`;
      }).join("");

      return `
        <style>
          /* === Request Check Dialog — AEM-matched theme === */
          .oni-creq-body { display:flex; flex-direction:column; padding:0; font-family:inherit; }

          /* ---- Section headers ---- */
          .oni-creq-sec { padding:8px 14px 10px; border-bottom:1px solid rgba(0,0,0,.1); }
          .oni-creq-sec:last-child { border-bottom:none; }
          .oni-creq-sec-title {
            font-size:10px; font-weight:700; text-transform:uppercase;
            letter-spacing:.08em; opacity:.45; margin-bottom:8px; display:block;
          }

          /* ---- Actor cards (AEM sprite style — full image, no crop) ---- */
          .oni-creq-actor-grid {
            display:grid; grid-template-columns:repeat(4,1fr); gap:6px;
          }
          .oni-creq-actor-card {
            display:flex; flex-direction:column; align-items:center; gap:3px;
            padding:5px 2px; border-radius:8px; cursor:pointer;
            border:1.5px solid rgba(0,0,0,.12); transition:border-color 100ms,background 100ms;
            user-select:none;
          }
          .oni-creq-actor-card:hover { border-color:rgba(87,58,33,.45); background:rgba(87,58,33,.04); }
          .oni-creq-actor-card.sel   { border-color:rgba(87,58,33,.80); background:rgba(87,58,33,.09); }
          .oni-creq-actor-card input { position:absolute; opacity:0; pointer-events:none; width:0; height:0; }
          .oni-creq-actor-img-wrap {
            width:68px; height:80px; display:flex; align-items:flex-end; justify-content:center;
            overflow:hidden; flex-shrink:0;
          }
          .oni-creq-actor-img-wrap img {
            max-width:100%; max-height:100%; object-fit:contain; display:block;
            background:transparent!important; border:none!important; box-shadow:none!important;
          }
          .oni-creq-actor-lbl {
            font-size:10px; font-weight:700; text-align:center;
            max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
            opacity:.75;
          }

          /* ---- Pickers (injected via PICKER_CSS) ---- */
          ${PICKER_CSS}

          /* ---- DL + Context row ---- */
          .oni-creq-config-row { display:flex; gap:10px; align-items:flex-start; }
          .oni-creq-field { display:flex; flex-direction:column; gap:3px; flex:1; }
          .oni-creq-field-lbl { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; opacity:.45; }
          .oni-creq-field input {
            padding:5px 8px; border-radius:6px; font-size:12px; font-family:inherit;
            border:1px solid rgba(0,0,0,.2); background:rgba(0,0,0,.04); color:inherit; width:100%;
          }
          .oni-creq-dl-wrap { max-width:64px; }

          /* ---- Picker slot labels ---- */
          .oni-creq-attr-labels {
            display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:4px;
          }
          .oni-creq-attr-label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; opacity:.45; }

          /* ---- Empty state ---- */
          .oni-creq-empty { font-size:12px; opacity:.5; font-style:italic; padding:4px 0; }
        </style>

        <div class="oni-creq-body" id="oni-creq-body">

          <div class="oni-creq-sec">
            <span class="oni-creq-sec-title">Target Actors</span>
            ${partyActors.length > 0
              ? `<div class="oni-creq-actor-grid">${actorCards}</div>`
              : `<div class="oni-creq-empty">No active party members found in Database Actor.</div>`}
          </div>

          <div class="oni-creq-sec">
            <span class="oni-creq-sec-title">Attributes</span>
            <div class="oni-creq-attr-labels">
              <div class="oni-creq-attr-label">Attribute A</div>
              <div class="oni-creq-attr-label">Attribute B &nbsp;<span style="opacity:.55;font-style:italic;font-weight:400;text-transform:none;letter-spacing:0">(— = 1 die)</span></div>
            </div>
            <div class="oni-creq-pickers-row" id="oni-creq-pickers">
              ${buildPickerHtml("A", stateA)}
              ${buildPickerHtml("B", stateB)}
            </div>
          </div>

          <div class="oni-creq-sec">
            <div class="oni-creq-config-row">
              <div class="oni-creq-field oni-creq-dl-wrap">
                <div class="oni-creq-field-lbl">DL</div>
                <input type="number" id="oni-creq-dl" name="dl" value="10" min="1" max="40" step="1">
              </div>
              <div class="oni-creq-field">
                <div class="oni-creq-field-lbl">Context (optional)</div>
                <input type="text" id="oni-creq-ctx" name="context" placeholder="e.g. Escape the collapsing bridge…">
              </div>
            </div>
          </div>

        </div>

        <script>
        (function() {
          // Actor card toggle
          document.querySelectorAll(".oni-creq-actor-card").forEach(card => {
            card.addEventListener("click", () => {
              const cb = card.querySelector("input[type=checkbox]");
              if (!cb) return;
              cb.checked = !cb.checked;
              card.classList.toggle("sel", cb.checked);
            });
          });

          // Picker cycling
          const ATTRS_A = ${JSON.stringify(ATTRS_A)};
          const ATTRS_B = ${JSON.stringify(ATTRS_B)};

          function updatePicker(pickerEl, attr) {
            const isNone = attr === "—";
            const icons  = ${JSON.stringify(ATTR_ICONS)};
            const icon   = icons[attr] ?? "";
            const center = pickerEl.querySelector(".oni-creq-picker-center");
            if (!center) return;
            pickerEl.dataset.attr = attr;
            pickerEl.classList.toggle("is-none", isNone);
            if (isNone) {
              center.innerHTML = '<span class="oni-creq-picker-name" style="font-size:18px;opacity:.4;">—</span>';
            } else {
              center.innerHTML =
                '<img class="oni-creq-picker-icon" src="' + icon + '" alt="' + attr + '">'
                + '<div style="display:flex;flex-direction:column;align-items:center;">'
                + '<div class="oni-creq-picker-name">' + attr + '</div>'
                + '</div>';
            }
          }

          function cycle(slot, dir) {
            const picker = document.querySelector('.oni-creq-picker[data-slot="' + slot + '"]');
            if (!picker) return;
            const cur  = picker.dataset.attr || (slot === "A" ? "DEX" : "MIG");
            const list = slot === "A" ? ATTRS_A : ATTRS_B;
            const i    = list.indexOf(cur);
            const next = list[((i < 0 ? 0 : i) + dir + list.length) % list.length];
            updatePicker(picker, next);
          }

          document.getElementById("oni-creq-pickers")?.addEventListener("click", e => {
            const btn = e.target.closest(".oni-creq-picker-arrow");
            if (!btn) return;
            const picker = btn.closest(".oni-creq-picker");
            const slot   = picker?.dataset?.slot;
            const dir    = parseInt(btn.dataset.dir, 10) || 1;
            if (slot) cycle(slot, dir);
          });

          // Wheel on pickers
          document.querySelectorAll(".oni-creq-picker").forEach(el => {
            el.addEventListener("wheel", e => {
              e.preventDefault();
              const slot = el.dataset.slot;
              if (slot) cycle(slot, e.deltaY > 0 ? 1 : -1);
            }, { passive: false });
          });
        })();
        </script>`;
    };

    // -------------------------------------------------------------------------
    // Open dialog
    // -------------------------------------------------------------------------
    const openDialog = async () => {
      const partyActors = await loadPartyActors()
        ?? (game.actors?.contents ?? []).filter(a => a.type === "character");

      const preSelectedUuids = new Set(
        (canvas?.tokens?.controlled ?? [])
          .map(t => t.actor?.uuid)
          .filter(Boolean)
      );

      const state = { attrA: "DEX", attrB: "MIG" };

      return new Promise((resolve) => {
        const d = new Dialog({
          title: "🎯 Request Check",
          content: buildDialogContent(partyActors, preSelectedUuids, state.attrA, state.attrB),
          buttons: {
            confirm: {
              icon: '<i class="fas fa-check"></i>',
              label: "Request",
              callback: async (html) => {
                const root = html[0] ?? html;

                // Checked actors
                const checkedUuids = [...root.querySelectorAll('input[name="actor"]:checked')]
                  .map(el => el.value);
                if (checkedUuids.length === 0) {
                  ui?.notifications?.warn?.("Request Check: No actors selected.");
                  resolve(null); return;
                }

                const actors = (await Promise.all(
                  checkedUuids.map(uuid => fromUuid(uuid).catch(() => null))
                )).filter(Boolean);
                if (actors.length === 0) {
                  ui?.notifications?.warn?.("Request Check: Could not resolve actors.");
                  resolve(null); return;
                }

                // Read picker state from DOM
                const pickA   = root.querySelector('.oni-creq-picker[data-slot="A"]');
                const pickB   = root.querySelector('.oni-creq-picker[data-slot="B"]');
                const attrA   = pickA?.dataset?.attr ?? "DEX";
                const rawB    = pickB?.dataset?.attr ?? "MIG";
                const singleDie = rawB === "—";
                const attrB   = singleDie ? attrA : rawB;

                const dl      = parseInt(root.querySelector('[name="dl"]')?.value ?? "10", 10) || 10;
                const context = root.querySelector('[name="context"]')?.value?.trim() ?? "";

                const CR = globalThis.ONI?.CheckRequester;
                if (!CR?.request) {
                  ui?.notifications?.error?.("ONI.CheckRequester is not loaded.");
                  resolve(null); return;
                }

                try {
                  const results = await CR.request(actors, {
                    attrA, attrB, dl, singleDie,
                    label:        context || "Skill Check",
                    mode:         "interactive",
                    allowInvokes: true,
                    postChat:     true,
                    context,
                  });
                  resolve(results);
                } catch (e) {
                  console.error(TAG, "Check request failed:", e);
                  ui?.notifications?.error?.("Request Check: An error occurred.");
                  resolve(null);
                }
              },
            },
            cancel: {
              icon: '<i class="fas fa-times"></i>',
              label: "Cancel",
              callback: () => resolve(null),
            },
          },
          default: "confirm",
          close: () => resolve(null),
        }, {
          width: 460,
          classes: ["oni-creq-dialog"],
        });

        d.render(true);
      });
    };

    // -------------------------------------------------------------------------
    // Floating button CSS
    // -------------------------------------------------------------------------
    const ensureStyle = () => {
      if (document.getElementById(DOM.STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = DOM.STYLE_ID;
      style.textContent = `
        #${DOM.ROOT_ID} {
          position: fixed;
          right: ${CFG.offsetRightPx}px;
          bottom: ${CFG.offsetBottomPx}px;
          z-index: ${CFG.zIndex};
          pointer-events: none;
        }

        #${DOM.BTN_ID} {
          pointer-events: auto;
          width: ${CFG.sizePx}px; height: ${CFG.sizePx}px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.22);
          background: rgba(18,18,22,0.86);
          box-shadow: 0 10px 24px rgba(0,0,0,.35), 0 2px 0 rgba(255,255,255,.06) inset;
          display: grid; place-items: center;
          cursor: pointer; user-select: none; -webkit-user-select: none;
          transform: translateZ(0);
          transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
          position: relative;
        }
        #${DOM.BTN_ID}:hover  { transform: translateY(-1px) scale(1.02); background: rgba(28,28,34,.92); border-color: rgba(255,255,255,.32); }
        #${DOM.BTN_ID}:active { transform: translateY(0) scale(.99); }

        #${DOM.BTN_ID} .oni-creq-icon { font-size:22px; line-height:1; filter:drop-shadow(0 2px 2px rgba(0,0,0,.45)); }

        #${DOM.BTN_ID} .oni-creq-tip {
          position:absolute; right:0; bottom:calc(100% + 10px);
          background:rgba(10,10,12,.92); border:1px solid rgba(255,255,255,.18);
          border-radius:10px; padding:8px 10px; font-size:12px;
          color:rgba(255,255,255,.9); white-space:nowrap;
          opacity:0; transform:translateY(4px);
          transition:opacity 120ms ease, transform 120ms ease;
          pointer-events:none; box-shadow:0 10px 24px rgba(0,0,0,.35);
        }
        #${DOM.BTN_ID}:hover .oni-creq-tip { opacity:1; transform:translateY(0); }

        /* Dialog layout overrides */
        .oni-creq-dialog .window-content { padding:0 !important; overflow:visible !important; }
        .oni-creq-dialog .dialog-content  { padding:0 !important; }
        .oni-creq-dialog .dialog-buttons  {
          display:grid !important; grid-template-columns:1fr 1fr !important;
          gap:8px !important; padding:8px 14px !important;
          border-top:1px solid rgba(0,0,0,.1);
        }
        .oni-creq-dialog .dialog-buttons button { margin:0 !important; }
      `;
      document.head.appendChild(style);
    };

    // -------------------------------------------------------------------------
    // Floating button DOM
    // -------------------------------------------------------------------------
    const buildButton = () => {
      let root = document.getElementById(DOM.ROOT_ID);
      if (!root) {
        root = document.createElement("div");
        root.id = DOM.ROOT_ID;
        document.body.appendChild(root);
      }
      root.innerHTML = "";

      const btn = document.createElement("div");
      btn.id = DOM.BTN_ID;
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");
      btn.setAttribute("aria-label", CFG.label);
      btn.innerHTML = `<div class="oni-creq-tip">${CFG.label}</div><div class="oni-creq-icon">${CFG.iconText}</div>`;

      let busy = false;
      const onClick = async (ev) => {
        ev?.preventDefault?.(); ev?.stopPropagation?.();
        if (busy) return;
        busy = true;
        try { await openDialog(); }
        catch (e) { console.error(TAG, e); }
        finally { busy = false; }
      };
      btn.addEventListener("click", onClick);
      btn.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") onClick(ev); });
      root.appendChild(btn);
    };

    // -------------------------------------------------------------------------
    // Boot
    // -------------------------------------------------------------------------
    cleanupUI();
    ensureStyle();
    buildButton();
    STATE.installed = true;
    console.debug(TAG, "Request Check button installed.");
  })();
});
