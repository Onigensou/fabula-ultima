// ============================================================================
// expAwarder-sidebar.js (Foundry V12 Module Script)
// - GM-only floating sidebar button: 📙
// - Positioned slightly ABOVE your Combat Button
// - Clicking runs the EXP Awarder Manager logic INLINE (no macro call)
// - Pattern mirrors your combat-button-installer (state guard + style + cleanup)
// ============================================================================
// References: combat-button-installer pattern :contentReference[oaicite:0]{index=0}
// Manager logic is inlined from your EXPAwarder Manager :contentReference[oaicite:1]{index=1}

Hooks.once("ready", () => {
  (() => {
    const TAG = "[ONI][EXPAwarder][SidebarBtn]";
    const STATE_KEY = "__ONI_EXPAWARDER_SIDEBARBTN_STATE__";

    // -------------------------------------------------------------------------
    // CONFIG (match combat button placement, but a bit higher)
    // -------------------------------------------------------------------------
    const CFG = {
      gmOnly: true,

      // Placement (match CombatButton's right offset, but higher bottom)
      offsetRightPx: 313,
      offsetBottomPx: 180, // <- "a bit above" the combat button (combat is 110)

      // Visual
      sizePx: 60,
      zIndex: 82, // slightly above combat button
      iconText: "📙",
      tooltip: "EXP Awarder",

      // Debug
      debug: false,
    };

    const log = (...a) => (CFG.debug ? console.log(TAG, ...a) : null);
    const warn = (...a) => console.warn(TAG, ...a);
    const err = (...a) => console.error(TAG, ...a);

    // -------------------------------------------------------------------------
    // DOM ids/classes
    // -------------------------------------------------------------------------
    const DOM = {
      ROOT_ID: "oni-expbtn-root",
      BTN_ID: "oni-expbtn",
      STYLE_ID: "oni-expbtn-style",
    };

    // -------------------------------------------------------------------------
    // Shared state (prevents duplicates)
    // -------------------------------------------------------------------------
    const STATE = (globalThis[STATE_KEY] ??= {
      installed: false,
    });

    const cleanupUI = () => {
      try { document.getElementById(DOM.ROOT_ID)?.remove(); } catch (_) {}
      try { document.getElementById(DOM.STYLE_ID)?.remove(); } catch (_) {}
    };

    // -------------------------------------------------------------------------
    // GM-only guard
    // -------------------------------------------------------------------------
    if (CFG.gmOnly && !game.user?.isGM) {
      cleanupUI();
      STATE.installed = false;
      return;
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    const ensureStyle = () => {
      let style = document.getElementById(DOM.STYLE_ID);
      if (style) return style;

      style = document.createElement("style");
      style.id = DOM.STYLE_ID;
      style.textContent = `
        /* [EXPAwarder] Floating Button */
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
          transition: transform 120ms ease, background 120ms ease, border-color 120ms ease, opacity 120ms ease;
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

        #${DOM.BTN_ID} .oni-expbtn-icon {
          font-size: 22px;
          line-height: 1;
          filter: drop-shadow(0 2px 2px rgba(0,0,0,0.45));
        }

        #${DOM.BTN_ID} .oni-expbtn-tip {
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

        #${DOM.BTN_ID}:hover .oni-expbtn-tip {
          opacity: 1;
          transform: translateY(0);
        }
      `;
      document.head.appendChild(style);
      return style;
    };

    const ensureRoot = () => {
      let root = document.getElementById(DOM.ROOT_ID);
      if (!root) {
        root = document.createElement("div");
        root.id = DOM.ROOT_ID;
        document.body.appendChild(root);
      }
      return root;
    };

    // -------------------------------------------------------------------------
    // INLINE Manager Logic (no macro call)
    // -------------------------------------------------------------------------
    const runExpAwarderManagerInline = async () => {
      const TAGM = "[ONI][EXPAwarder][ManagerInline]";
      const DBG = false;

      const logM = (...a) => (DBG ? console.log(TAGM, ...a) : null);
      const warnM = (...a) => console.warn(TAGM, ...a);
      const errM = (...a) => console.error(TAGM, ...a);

      if (!game.user?.isGM) return ui.notifications.warn("EXP Awarder: GM only.");

      if (!globalThis.FUCompanion?.api?.getCurrentGameDb) {
        ui.notifications.error("EXP Awarder: FUCompanion DB_Resolver API not found.");
        return;
      }
      if (!globalThis.FUCompanion?.api?.expAwarder?.awardExp) {
        ui.notifications.error("EXP Awarder: expAwarder API not found. (expAwarder-api.js not loaded?)");
        return;
      }

      // --- Resolve DB Actor ---
      let db;
      try {
        const res = await globalThis.FUCompanion.api.getCurrentGameDb();
        db = res?.db;
      } catch (e) {
        errM("DB_Resolver crashed", e);
      }
      if (!db) return ui.notifications.error("EXP Awarder: Could not resolve Database Actor (db is null).");

      const props = db.system?.props ?? {};
      if (!props || typeof props !== "object") {
        ui.notifications.error("EXP Awarder: db.system.props is missing (unexpected DB schema).");
        return;
      }

      const esc = (s) => String(s ?? "")
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

      const normText = (v) => String(v ?? "").trim();

      function normalizeActorUuid(v) {
        const raw = normText(v);
        if (!raw) return "";
        if (raw.startsWith("Actor.")) return raw;
        return `Actor.${raw}`;
      }

      function getProp(key, fallback = "") {
        const v = props?.[key];
        if (v == null) return fallback;
        return String(v).trim();
      }

      function buildGroup(groupKey, count, idPrefix, namePrefix) {
        const out = [];
        for (let i = 1; i <= count; i++) {
          const actorUuid = normalizeActorUuid(getProp(`${idPrefix}${i}`, ""));
          if (!actorUuid) continue;

          const name = getProp(`${namePrefix}${i}`, "");
          out.push({ actorUuid, name: name || actorUuid, group: groupKey });
        }
        return out;
      }

      const rosterActive = buildGroup("active", 4, "member_id_", "member_name_");
      const rosterBench  = buildGroup("bench",  6, "bench_id_",  "bench_name_");
      const rosterAway   = buildGroup("away",   4, "away_id_",   "away_name_");
      const rosterAll = [...rosterActive, ...rosterBench, ...rosterAway];

      if (!rosterAll.length) {
        const sampleKeys = Object.keys(props).filter(k =>
          k.startsWith("member_") || k.startsWith("bench_") || k.startsWith("away_")
        );
        warnM("No roster found. Party-related keys on db.system.props:", sampleKeys.slice(0, 80));
        ui.notifications.warn("EXP Awarder: No party members found in Database Actor. Check console for debug keys.");
        return;
      }

      function renderChecklist(groupLabel, items) {
        const rows = items.map((m) => `
          <label style="display:flex;align-items:center;gap:8px;margin:4px 0;">
            <input type="checkbox" class="oni-exp-target"
              data-uuid="${esc(m.actorUuid)}"
              data-name="${esc(m.name)}"
              data-group="${esc(m.group)}">
            <span><b>${esc(m.name)}</b> <span style="opacity:0.75;">(${esc(m.group)})</span></span>
          </label>
        `).join("");

        return `
          <details open style="margin:8px 0;">
            <summary style="cursor:pointer;"><b>${esc(groupLabel)}</b> <span style="opacity:0.7;">(${items.length})</span></summary>
            <div style="margin:6px 0 0 12px;">
              ${rows || `<div style="opacity:0.7;">(none)</div>`}
            </div>
          </details>
        `;
      }

      const content = `
        <form class="oni-exp-form" autocomplete="off">
          <div style="display:flex;flex-direction:column;gap:10px;">
            <div>
              <label><b>EXP Amount</b></label>
              <input type="number" name="amount" step="0.01" value="1" style="width: 140px;">
              <span style="opacity:0.75;margin-left:8px;">(decimals supported)</span>
            </div>

            <div style="border-top:1px solid rgba(0,0,0,0.15);padding-top:8px;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <b>Who to award to?</b>
                <div style="display:flex;gap:6px;">
                  <button type="button" class="oni-exp-select-all">Select All</button>
                  <button type="button" class="oni-exp-clear-all">Clear</button>
                </div>
              </div>

              ${renderChecklist("Active Members", rosterActive)}
              ${renderChecklist("Bench Members", rosterBench)}
              ${renderChecklist("Away Members", rosterAway)}
            </div>

            <div style="border-top:1px solid rgba(0,0,0,0.15);padding-top:8px;">
              <label><b>Source</b> <span style="opacity:0.7;">(optional)</span></label>
              <input type="text" name="source" placeholder="e.g. Boss defeated, Quest reward..." style="width:100%;">
            </div>

            <div style="display:flex;align-items:center;gap:8px;">
              <input type="checkbox" name="playUi" checked>
              <label><b>Play Animation</b></label>
            </div>
          </div>
        </form>
      `;

      new Dialog({
        title: "EXP Awarder",
        content,
        buttons: {
          award: {
            label: "Award EXP",
            callback: async (html) => {
              try {
                const form = html[0].querySelector(".oni-exp-form");
                const amount = Number(form.amount.value);
                const source = String(form.source.value ?? "").trim();
                const playUi = !!form.playUi.checked;

                const checks = [...html[0].querySelectorAll(".oni-exp-target:checked")];
                if (!checks.length) return ui.notifications.warn("EXP Awarder: Please select at least 1 target.");
                if (!Number.isFinite(amount)) return ui.notifications.warn("EXP Awarder: Invalid EXP amount.");

                const targets = checks.map((c) => ({
                  actorUuid: c.dataset.uuid,
                  label: c.dataset.name,
                  group: c.dataset.group,
                }));

                const payload = {
                  targets,
                  amount,
                  source,
                  playUi,
                  user: { id: game.user.id, name: game.user.name },
                };

                logM("Calling API with payload:", payload);
                const res = await globalThis.FUCompanion.api.expAwarder.awardExp(payload);

                if (!res?.ok) {
                  warnM("API returned not ok:", res);
                  ui.notifications.warn(`EXP Awarder: Failed (${res?.error ?? "unknown"}). Check console.`);
                } else {
                  ui.notifications.info(`EXP Awarder: Awarded ${amount} EXP to ${res.entries.length} actor(s).`);
                }
              } catch (e) {
                errM("Award callback crashed", e);
                ui.notifications.error("EXP Awarder: Manager crashed. Check console.");
              }
            },
          },
          cancel: { label: "Cancel" },
        },
        default: "award",
        render: (html) => {
          try {
            const root = html[0];
            root.querySelector(".oni-exp-select-all")?.addEventListener("click", () => {
              for (const cb of root.querySelectorAll(".oni-exp-target")) cb.checked = true;
            });
            root.querySelector(".oni-exp-clear-all")?.addEventListener("click", () => {
              for (const cb of root.querySelectorAll(".oni-exp-target")) cb.checked = false;
            });
          } catch (e) {
            errM("Render hook crashed", e);
          }
        },
      }, { width: 620 }).render(true);
    };

    // -------------------------------------------------------------------------
    // Build Button
    // -------------------------------------------------------------------------
    const buildButton = () => {
      const root = ensureRoot();
      root.innerHTML = "";

      const btn = document.createElement("div");
      btn.id = DOM.BTN_ID;
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");
      btn.setAttribute("aria-label", "EXP Awarder");

      btn.innerHTML = `
        <div class="oni-expbtn-tip">${CFG.tooltip}</div>
        <div class="oni-expbtn-icon">${CFG.iconText}</div>
      `;

      const onClick = async (ev) => {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        try {
          await runExpAwarderManagerInline();
        } catch (e) {
          err("Button click error:", e);
          ui?.notifications?.error?.("EXP Awarder: An error occurred. Check console.");
        }
      };

      const onKeyDown = (ev) => {
        if (ev.key === "Enter" || ev.key === " ") onClick(ev);
      };

      btn.addEventListener("click", onClick);
      btn.addEventListener("keydown", onKeyDown);

      root.appendChild(btn);
      return btn;
    };

    // -------------------------------------------------------------------------
    // Boot
    // -------------------------------------------------------------------------
    const boot = () => {
      cleanupUI();
      ensureStyle();
      buildButton();
      STATE.installed = true;
      log("Installed");
    };

    boot();
  })();
});
