// ============================================================================
// Check Requester — Sidebar Button
//
// GM-only floating button (🎯) that opens a "Request Check" setup dialog.
// On confirm, calls ONI.CheckRequester.request(actors, opts).
//
// Position: above Active Effect Manager (bottom 322, matching the button stack).
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
      ROOT_ID: "oni-cr-button-root",
      BTN_ID:  "oni-cr-button",
      STYLE_ID: "oni-cr-button-style",
    };

    const STATE = (globalThis[STATE_KEY] ??= { installed: false });

    const cleanupUI = () => {
      try { document.getElementById(DOM.ROOT_ID)?.remove(); } catch (_) {}
      try { document.getElementById(DOM.STYLE_ID)?.remove(); } catch (_) {}
    };

    if (CFG.gmOnly && !game.user?.isGM) { cleanupUI(); return; }

    // -------------------------------------------------------------------------
    // Fabula Ultima attribute options
    // -------------------------------------------------------------------------
    const FU_ATTRS = [
      { value: "DEX", label: "DEX — Dexterity" },
      { value: "INS", label: "INS — Insight"   },
      { value: "MIG", label: "MIG — Might"     },
      { value: "WLP", label: "WLP — Willpower" },
    ];

    const attrOptions = (selected) =>
      FU_ATTRS.map(a =>
        `<option value="${a.value}"${a.value === selected ? " selected" : ""}>${a.label}</option>`
      ).join("");

    // -------------------------------------------------------------------------
    // Collect candidate actors
    // -------------------------------------------------------------------------
    const getPartyActors = () => {
      // All PC actors that have an active user owner (party members likely online)
      return (game.actors?.contents ?? []).filter(a => a.type === "character");
    };

    const getSelectedTokenActors = () => {
      const tokens = canvas?.tokens?.controlled ?? [];
      const actors = tokens
        .map(t => t.actor)
        .filter(Boolean)
        .filter((a, i, arr) => arr.findIndex(x => x.uuid === a.uuid) === i);
      return actors;
    };

    // -------------------------------------------------------------------------
    // Dialog HTML builder
    // -------------------------------------------------------------------------
    const buildDialogContent = (preSelected) => {
      const party = getPartyActors();
      const preUuids = new Set(preSelected.map(a => a.uuid));

      const actorRows = party.map(a => {
        const img = a.prototypeToken?.texture?.src ?? a.img ?? "";
        const checked = preUuids.has(a.uuid) ? "checked" : "";
        return `
          <label class="oni-crb-actor-row" title="${a.name}">
            <input type="checkbox" name="actor" value="${a.uuid}" ${checked}>
            <img src="${img}" class="oni-crb-actor-img" alt="">
            <span class="oni-crb-actor-name">${a.name}</span>
          </label>`;
      }).join("");

      return `
        <style>
          .oni-crb-dialog { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; font-family: inherit; }
          .oni-crb-section-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; opacity: .6; margin-bottom: 2px; }
          .oni-crb-actor-list { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow-y: auto; padding: 2px 0; }
          .oni-crb-actor-row {
            display: flex; align-items: center; gap: 8px;
            padding: 5px 8px; border-radius: 6px; cursor: pointer;
            border: 1px solid transparent;
            transition: background 100ms ease, border-color 100ms ease;
          }
          .oni-crb-actor-row:hover { background: rgba(255,255,255,.05); border-color: rgba(255,255,255,.12); }
          .oni-crb-actor-row input[type=checkbox] { width: 14px; height: 14px; flex-shrink: 0; accent-color: #a07040; cursor: pointer; }
          .oni-crb-actor-img { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; flex-shrink: 0; border: 1px solid rgba(91,63,38,.6); }
          .oni-crb-actor-name { font-size: 13px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .oni-crb-row { display: flex; gap: 10px; align-items: flex-start; }
          .oni-crb-field { display: flex; flex-direction: column; gap: 3px; flex: 1; }
          .oni-crb-field label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; opacity: .6; }
          .oni-crb-field select, .oni-crb-field input { width: 100%; padding: 5px 7px; border-radius: 6px; font-size: 13px;
            background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.18); color: inherit; }
          .oni-crb-field input[type=number] { width: 72px; }
          .oni-crb-divider { border: none; border-top: 1px solid rgba(255,255,255,.1); margin: 0; }
          .oni-crb-no-actors { font-size: 12px; opacity: .55; font-style: italic; padding: 6px 2px; }
        </style>
        <div class="oni-crb-dialog">
          <div>
            <div class="oni-crb-section-label">Target Actors</div>
            <div class="oni-crb-actor-list" id="oni-crb-actor-list">
              ${party.length > 0 ? actorRows : '<div class="oni-crb-no-actors">No character actors found.</div>'}
            </div>
          </div>
          <hr class="oni-crb-divider">
          <div class="oni-crb-row">
            <div class="oni-crb-field">
              <label>Attribute A</label>
              <select name="attrA">${attrOptions("DEX")}</select>
            </div>
            <div class="oni-crb-field">
              <label>Attribute B</label>
              <select name="attrB">${attrOptions("MIG")}</select>
            </div>
            <div class="oni-crb-field" style="max-width:80px">
              <label>DL</label>
              <input type="number" name="dl" value="10" min="1" max="40" step="1">
            </div>
          </div>
          <div class="oni-crb-field">
            <label>Context (optional)</label>
            <input type="text" name="context" placeholder="e.g. Escape the collapsing bridge…" style="width:100%">
          </div>
        </div>`;
    };

    // -------------------------------------------------------------------------
    // Open dialog and run check
    // -------------------------------------------------------------------------
    const openDialog = async () => {
      const preSelected = getSelectedTokenActors();

      return new Promise((resolve) => {
        const d = new Dialog({
          title: "🎯 Request Check",
          content: buildDialogContent(preSelected),
          buttons: {
            confirm: {
              icon: '<i class="fas fa-check"></i>',
              label: "Request",
              callback: async (html) => {
                const form = html[0] ?? html;

                // Collect checked actor UUIDs
                const checkedUuids = [...form.querySelectorAll('input[name="actor"]:checked')]
                  .map(el => el.value);

                if (checkedUuids.length === 0) {
                  ui?.notifications?.warn?.("Request Check: No actors selected.");
                  resolve(null);
                  return;
                }

                const actors = (await Promise.all(
                  checkedUuids.map(uuid => fromUuid(uuid).catch(() => null))
                )).filter(Boolean);

                if (actors.length === 0) {
                  ui?.notifications?.warn?.("Request Check: Could not resolve any actors.");
                  resolve(null);
                  return;
                }

                const attrA   = form.querySelector('[name="attrA"]')?.value  ?? "DEX";
                const attrB   = form.querySelector('[name="attrB"]')?.value  ?? "MIG";
                const dl      = parseInt(form.querySelector('[name="dl"]')?.value ?? "10", 10) || 10;
                const context = form.querySelector('[name="context"]')?.value?.trim() ?? "";

                const CR = globalThis.ONI?.CheckRequester;
                if (!CR?.request) {
                  ui?.notifications?.error?.("ONI.CheckRequester is not loaded.");
                  resolve(null);
                  return;
                }

                try {
                  const results = await CR.request(actors, {
                    attrA,
                    attrB,
                    dl,
                    label:        context || "Skill Check",
                    mode:         "interactive",
                    allowInvokes: true,
                    postChat:     true,
                    context,
                  });
                  resolve(results);
                } catch (e) {
                  console.error(TAG, "Check request failed:", e);
                  ui?.notifications?.error?.("Request Check: An error occurred. Check console.");
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
          width: 380,
          classes: ["oni-cr-request-dialog"],
        });

        d.render(true);
      });
    };

    // -------------------------------------------------------------------------
    // CSS
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
          width: ${CFG.sizePx}px;
          height: ${CFG.sizePx}px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.22);
          background: rgba(18, 18, 22, 0.86);
          box-shadow:
            0 10px 24px rgba(0,0,0,0.35),
            0 2px 0 rgba(255,255,255,0.06) inset;
          display: grid;
          place-items: center;
          cursor: pointer;
          user-select: none;
          -webkit-user-select: none;
          transform: translateZ(0);
          transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
          position: relative;
        }

        #${DOM.BTN_ID}:hover {
          transform: translateY(-1px) scale(1.02);
          background: rgba(28, 28, 34, 0.92);
          border-color: rgba(255,255,255,0.32);
        }

        #${DOM.BTN_ID}:active {
          transform: translateY(0px) scale(0.99);
        }

        #${DOM.BTN_ID} .oni-crb-icon {
          font-size: 22px;
          line-height: 1;
          filter: drop-shadow(0 2px 2px rgba(0,0,0,0.45));
        }

        #${DOM.BTN_ID} .oni-crb-tip {
          position: absolute;
          right: 0;
          bottom: calc(100% + 10px);
          background: rgba(10,10,12,0.92);
          border: 1px solid rgba(255,255,255,0.18);
          border-radius: 10px;
          padding: 8px 10px;
          font-size: 12px;
          color: rgba(255,255,255,0.9);
          white-space: nowrap;
          opacity: 0;
          transform: translateY(4px);
          transition: opacity 120ms ease, transform 120ms ease;
          pointer-events: none;
          box-shadow: 0 10px 24px rgba(0,0,0,0.35);
        }

        #${DOM.BTN_ID}:hover .oni-crb-tip {
          opacity: 1;
          transform: translateY(0);
        }
      `;
      document.head.appendChild(style);
    };

    // -------------------------------------------------------------------------
    // DOM
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

      btn.innerHTML = `
        <div class="oni-crb-tip">${CFG.label}</div>
        <div class="oni-crb-icon">${CFG.iconText}</div>
      `;

      let busy = false;
      const onClick = async (ev) => {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        if (busy) return;
        busy = true;
        try {
          await openDialog();
        } catch (e) {
          console.error(TAG, "Dialog error:", e);
        } finally {
          busy = false;
        }
      };

      btn.addEventListener("click", onClick);
      btn.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") onClick(ev);
      });

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
