// ============================================================================
// Check Requester — Sidebar Button
//
// GM-only floating button (🎯) that opens a "Request Check" setup dialog.
// Actors loaded from db-resolver (active party members only).
// Supports 1-die (single attribute) and 2-die (dual attribute) modes.
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
    // Fabula Ultima attributes
    // -------------------------------------------------------------------------
    const FU_ATTRS = [
      { value: "DEX", label: "DEX", full: "Dexterity" },
      { value: "INS", label: "INS", full: "Insight"   },
      { value: "MIG", label: "MIG", full: "Might"     },
      { value: "WLP", label: "WLP", full: "Willpower" },
    ];

    const attrOptions = (selected) =>
      FU_ATTRS.map(a =>
        `<option value="${a.value}"${a.value === selected ? " selected" : ""}>${a.label} — ${a.full}</option>`
      ).join("");

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

        const props = db.system?.props ?? {};
        const actors = [];
        for (let i = 1; i <= 4; i++) {
          const raw = String(props[`member_id_${i}`] ?? "").trim();
          if (!raw) continue;
          const uuid = raw.startsWith("Actor.") ? raw : `Actor.${raw}`;
          const actor = await fromUuid(uuid).catch(() => null);
          if (actor) actors.push(actor);
        }
        return actors.length > 0 ? actors : null;
      } catch (e) {
        console.warn(TAG, "loadPartyActors failed:", e);
        return null;
      }
    };

    // -------------------------------------------------------------------------
    // Token image helper (same priority as cr-api.js)
    // -------------------------------------------------------------------------
    const getTokenImg = (actor) => {
      const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
      const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
      const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
      return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
    };

    // -------------------------------------------------------------------------
    // Build dialog HTML
    // -------------------------------------------------------------------------
    const buildDialogContent = (partyActors, preSelectedUuids) => {
      const actorCards = partyActors.map(a => {
        const img     = getTokenImg(a);
        const checked = preSelectedUuids.has(a.uuid) ? "checked" : "";
        const cid     = `oni-creq-actor-${a.id}`;
        return `
          <label class="oni-creq-actor-card${checked ? " is-checked" : ""}" for="${cid}" title="${a.name}">
            <input type="checkbox" id="${cid}" name="actor" value="${a.uuid}" ${checked} class="oni-creq-actor-cb">
            <div class="oni-creq-actor-img-wrap">
              <img src="${img}" alt="" onerror="this.src='icons/svg/mystery-man.svg'">
            </div>
            <div class="oni-creq-actor-name">${a.name}</div>
          </label>`;
      }).join("");

      return `
        <style>
          /* === Request Check Dialog Styles === */
          .oni-creq-form { display:flex; flex-direction:column; gap:0; font-family:inherit; }

          /* Section header — matches AEM panel header style */
          .oni-creq-section {
            padding: 8px 12px 6px;
            border-bottom: 1px solid rgba(0,0,0,.12);
          }
          .oni-creq-section:last-child { border-bottom: none; }
          .oni-creq-section-title {
            font-size: 10px; font-weight: 700; text-transform: uppercase;
            letter-spacing: .08em; opacity: .5; margin-bottom: 8px;
          }

          /* Actor grid */
          .oni-creq-actor-grid {
            display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
          }
          .oni-creq-actor-card {
            display: flex; flex-direction: column; align-items: center; gap: 4px;
            padding: 6px 4px; border-radius: 8px; cursor: pointer;
            border: 1.5px solid rgba(0,0,0,.12);
            transition: border-color 120ms ease, background 120ms ease;
            user-select: none; position: relative;
          }
          .oni-creq-actor-card:hover { border-color: rgba(91,63,38,.5); background: rgba(91,63,38,.04); }
          .oni-creq-actor-card.is-checked { border-color: rgba(91,63,38,.75); background: rgba(91,63,38,.08); }
          .oni-creq-actor-cb { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
          .oni-creq-actor-img-wrap {
            width: 48px; height: 48px; border-radius: 50%; overflow: hidden;
            border: 2px solid rgba(91,63,38,.4); flex-shrink: 0;
            background: rgba(0,0,0,.06);
          }
          .oni-creq-actor-img-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
          .oni-creq-actor-name {
            font-size: 10px; font-weight: 700; text-align: center;
            max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            opacity: .8;
          }

          /* Mode toggle */
          .oni-creq-mode-row {
            display: flex; gap: 0; border-radius: 8px; overflow: hidden;
            border: 1.5px solid rgba(0,0,0,.18); width: fit-content;
          }
          .oni-creq-mode-btn {
            padding: 5px 16px; font-size: 12px; font-weight: 700; cursor: pointer;
            border: none; background: transparent; transition: background 100ms ease, color 100ms ease;
            color: inherit; opacity: .6;
          }
          .oni-creq-mode-btn.active { background: rgba(91,63,38,.15); opacity: 1; color: inherit; }
          .oni-creq-mode-btn:first-child { border-right: 1.5px solid rgba(0,0,0,.12); }

          /* Attribute + DL row */
          .oni-creq-attr-row { display: flex; gap: 8px; align-items: flex-end; }
          .oni-creq-field { display: flex; flex-direction: column; gap: 3px; flex: 1; }
          .oni-creq-field-label {
            font-size: 10px; font-weight: 700; text-transform: uppercase;
            letter-spacing: .06em; opacity: .5;
          }
          .oni-creq-field select,
          .oni-creq-field input[type=number],
          .oni-creq-field input[type=text] {
            width: 100%; padding: 5px 8px; border-radius: 6px; font-size: 12px;
            border: 1px solid rgba(0,0,0,.2); background: rgba(0,0,0,.04); color: inherit;
            font-family: inherit;
          }
          .oni-creq-field-dl { max-width: 70px; }
          .oni-creq-sep { display: flex; align-items: center; padding: 0 2px; opacity: .4;
            font-size: 14px; font-weight: 900; margin-bottom: 1px; }

          /* Empty state */
          .oni-creq-empty { font-size: 12px; opacity: .5; font-style: italic; padding: 4px 0; }
        </style>

        <form class="oni-creq-form" id="oni-creq-form" autocomplete="off">

          <!-- Target Actors -->
          <div class="oni-creq-section">
            <div class="oni-creq-section-title">Target Actors</div>
            ${partyActors.length > 0
              ? `<div class="oni-creq-actor-grid">${actorCards}</div>`
              : `<div class="oni-creq-empty">No active party members found in Database Actor.</div>`}
          </div>

          <!-- Check Mode -->
          <div class="oni-creq-section">
            <div class="oni-creq-section-title">Check Mode</div>
            <div class="oni-creq-mode-row" id="oni-creq-mode-row">
              <button type="button" class="oni-creq-mode-btn active" data-mode="2">2 Attributes</button>
              <button type="button" class="oni-creq-mode-btn" data-mode="1">1 Attribute</button>
            </div>
          </div>

          <!-- Attributes & DL -->
          <div class="oni-creq-section">
            <div class="oni-creq-section-title">Check Configuration</div>
            <div class="oni-creq-attr-row">
              <div class="oni-creq-field">
                <div class="oni-creq-field-label">Attribute A</div>
                <select name="attrA">${attrOptions("DEX")}</select>
              </div>
              <div class="oni-creq-sep" id="oni-creq-sep">+</div>
              <div class="oni-creq-field" id="oni-creq-attrB-wrap">
                <div class="oni-creq-field-label">Attribute B</div>
                <select name="attrB">${attrOptions("MIG")}</select>
              </div>
              <div class="oni-creq-field oni-creq-field-dl">
                <div class="oni-creq-field-label">DL</div>
                <input type="number" name="dl" value="10" min="1" max="40" step="1">
              </div>
            </div>
          </div>

          <!-- Context -->
          <div class="oni-creq-section">
            <div class="oni-creq-section-title">Context (Optional)</div>
            <div class="oni-creq-field">
              <input type="text" name="context" placeholder="e.g. Escape the collapsing bridge…">
            </div>
          </div>

        </form>

        <script>
          (function() {
            // Actor card toggle
            document.querySelectorAll(".oni-creq-actor-card").forEach(card => {
              card.addEventListener("click", () => {
                const cb = card.querySelector(".oni-creq-actor-cb");
                if (!cb) return;
                cb.checked = !cb.checked;
                card.classList.toggle("is-checked", cb.checked);
              });
            });

            // Mode toggle
            let singleDie = false;
            const modeRow = document.getElementById("oni-creq-mode-row");
            const attrBWrap = document.getElementById("oni-creq-attrB-wrap");
            const sep = document.getElementById("oni-creq-sep");
            modeRow?.addEventListener("click", e => {
              const btn = e.target.closest(".oni-creq-mode-btn");
              if (!btn) return;
              singleDie = btn.dataset.mode === "1";
              modeRow.querySelectorAll(".oni-creq-mode-btn").forEach(b => b.classList.toggle("active", b === btn));
              if (attrBWrap) attrBWrap.style.display = singleDie ? "none" : "";
              if (sep)       sep.style.display       = singleDie ? "none" : "";
              const form = document.getElementById("oni-creq-form");
              if (form) form.dataset.singleDie = singleDie ? "1" : "0";
            });
          })();
        </script>`;
    };

    // -------------------------------------------------------------------------
    // Open dialog
    // -------------------------------------------------------------------------
    const openDialog = async () => {
      // Load party from DB, fallback to character actors
      const partyActors = await loadPartyActors()
        ?? (game.actors?.contents ?? []).filter(a => a.type === "character");

      const preSelectedUuids = new Set(
        (canvas?.tokens?.controlled ?? [])
          .map(t => t.actor?.uuid)
          .filter(Boolean)
      );

      return new Promise((resolve) => {
        const d = new Dialog({
          title: "🎯 Request Check",
          content: buildDialogContent(partyActors, preSelectedUuids),
          buttons: {
            confirm: {
              icon: '<i class="fas fa-check"></i>',
              label: "Request",
              callback: async (html) => {
                const form = (html[0] ?? html).querySelector("#oni-creq-form") ?? (html[0] ?? html);
                const singleDie = form.dataset?.singleDie === "1";

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
                    singleDie,
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
          width: 460,
          classes: ["oni-creq-dialog"],
        });

        d.render(true);
      });
    };

    // -------------------------------------------------------------------------
    // CSS — floating button
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

        #${DOM.BTN_ID} .oni-creq-icon {
          font-size: 22px;
          line-height: 1;
          filter: drop-shadow(0 2px 2px rgba(0,0,0,0.45));
        }

        #${DOM.BTN_ID} .oni-creq-tip {
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

        #${DOM.BTN_ID}:hover .oni-creq-tip {
          opacity: 1;
          transform: translateY(0);
        }

        /* Remove default dialog padding so sections bleed to edges */
        .oni-creq-dialog .dialog-content {
          padding: 0 !important;
        }
        .oni-creq-dialog .dialog-buttons {
          padding: 8px 12px !important;
          border-top: 1px solid rgba(0,0,0,.12);
        }
      `;
      document.head.appendChild(style);
    };

    // -------------------------------------------------------------------------
    // DOM — floating button
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
        <div class="oni-creq-tip">${CFG.label}</div>
        <div class="oni-creq-icon">${CFG.iconText}</div>
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
