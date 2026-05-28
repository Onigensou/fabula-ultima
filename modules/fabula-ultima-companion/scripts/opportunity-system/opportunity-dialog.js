/**
 * [ONI] Opportunity System — Dialog
 * Floating card-picker UI for spending an opportunity.
 * Consistent with the CheckRequester parchment aesthetic.
 *
 * CSS prefix: oni-opp-
 * z-index: 100020 (above reaction windows at ~100010)
 *
 * Public API: window["oni.OpportunityDialog"].showPicker(opts) → Promise<{ optionId } | { cancelled: true }>
 */
(() => {
  const TAG     = "[ONI][OpportunitySystem:Dialog]";
  const STYLE_ID = "oni-opp-styles";

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const esc = s => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // ── CSS ─────────────────────────────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* Backdrop */
      .oni-opp-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,.68);
        z-index: 100020;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 18px; pointer-events: auto;
      }

      /* Title */
      .oni-opp-title {
        font-family: 'Palatino Linotype', Palatino, serif;
        font-size: 1.15rem; font-weight: 900; color: #fcd470;
        text-shadow: 0 1px 8px rgba(0,0,0,.9), 0 0 24px rgba(252,212,112,.3);
        letter-spacing: .06em; text-align: center;
      }
      .oni-opp-subtitle {
        font-size: .8rem; color: #f6ebd3; opacity: .65;
        text-align: center; margin-top: -12px;
      }

      /* Option grid */
      .oni-opp-grid {
        display: flex; flex-wrap: wrap; justify-content: center;
        gap: 10px; max-width: 580px;
      }

      /* Option card */
      @keyframes oni-opp-card-in {
        from { opacity: 0; transform: translateY(16px) scale(0.96); }
        to   { opacity: 1; transform: translateY(0)    scale(1); }
      }
      .oni-opp-card {
        width: 160px;
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.40) 0%,
            rgba(255,255,255,.12) 22%, transparent 40%),
          linear-gradient(180deg, #f6ebd3 0%, #eddecb 55%, #e4d0b5 100%);
        border: 2.5px solid rgba(91,63,38,.85);
        border-radius: 14px;
        box-shadow: 0 8px 22px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,248,232,.7);
        color: #3b2a19;
        display: flex; flex-direction: column; align-items: center;
        padding: 12px 8px 10px; gap: 6px;
        cursor: pointer;
        transition: filter .12s, transform .12s, box-shadow .12s, border-color .12s;
        animation: oni-opp-card-in 300ms cubic-bezier(.22,1,.36,1) both;
        user-select: none;
      }
      .oni-opp-card:hover {
        filter: brightness(1.06);
        transform: translateY(-2px);
        box-shadow: 0 12px 28px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,248,232,.7);
      }
      .oni-opp-card.is-selected {
        border-color: #fcd470;
        box-shadow: 0 0 0 2.5px rgba(252,212,112,.5), 0 10px 24px rgba(0,0,0,.32);
      }

      /* Icon */
      .oni-opp-card-icon {
        font-size: 1.5rem; line-height: 1;
        /* tinted by the option's accent color via inline style */
      }

      /* Label */
      .oni-opp-card-label {
        font-family: 'Signika', serif;
        font-size: .82rem; font-weight: 900;
        text-align: center; line-height: 1.2;
      }

      /* Description */
      .oni-opp-card-desc {
        font-size: .68rem; opacity: .65; text-align: center;
        line-height: 1.35; max-height: 52px; overflow: hidden;
      }

      /* Footer buttons */
      .oni-opp-footer {
        display: flex; gap: 12px; align-items: center;
      }
      .oni-opp-btn {
        padding: 7px 22px; font-size: .85rem; font-weight: 800;
        border-radius: 10px; cursor: pointer;
        transition: filter .1s, transform .1s;
        font-family: 'Signika', serif; letter-spacing: .03em;
      }
      .oni-opp-btn:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
      .oni-opp-btn:disabled { opacity: .38; cursor: not-allowed; transform: none; }

      .oni-opp-btn-spend {
        background: linear-gradient(180deg, #d4a017, #a87800);
        border: 2px solid #a87800;
        color: #fff;
        box-shadow: 0 3px 9px rgba(0,0,0,.28);
      }
      .oni-opp-btn-decline {
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        border: 2px solid rgba(91,63,38,.75);
        color: #3b2a19;
      }
    `;
    document.head.appendChild(s);
  }

  // ── Build card HTML ──────────────────────────────────────────────────────────
  function buildCardHtml(option, index) {
    const delay = `${index * 55}ms`;
    return `
      <div class="oni-opp-card" data-id="${esc(option.id)}" style="animation-delay:${delay}">
        <div class="oni-opp-card-icon" style="color:${esc(option.color ?? '#3b2a19')}">
          <i class="fas ${esc(option.icon ?? 'fa-star')}"></i>
        </div>
        <div class="oni-opp-card-label">${esc(option.label)}</div>
        <div class="oni-opp-card-desc">${esc(option.description)}</div>
      </div>`;
  }

  // ── Show Picker ──────────────────────────────────────────────────────────────
  /**
   * Display the opportunity picker for the given actor.
   *
   * @param {object} opts
   * @param {string}  opts.actorName    Display name shown in subtitle
   * @param {Array}   opts.options      Array of option objects from OpportunityConfig.OPTIONS
   * @param {boolean} [opts.canDecline] Whether the Decline button is shown (default true)
   *
   * @returns {Promise<{ optionId: string } | { cancelled: true }>}
   */
  function showPicker({ actorName, options, canDecline = true }) {
    ensureStyles();

    return new Promise(resolve => {
      // Close any existing picker first
      document.getElementById("oni-opp-backdrop")?.remove();

      const backdrop = document.createElement("div");
      backdrop.className = "oni-opp-backdrop";
      backdrop.id = "oni-opp-backdrop";

      const titleEl = document.createElement("div");
      titleEl.className = "oni-opp-title";
      titleEl.textContent = "✦ Critical! — Spend an Opportunity?";
      backdrop.appendChild(titleEl);

      if (actorName) {
        const sub = document.createElement("div");
        sub.className = "oni-opp-subtitle";
        sub.textContent = actorName;
        backdrop.appendChild(sub);
      }

      // Grid
      const grid = document.createElement("div");
      grid.className = "oni-opp-grid";
      grid.innerHTML = options.map((opt, i) => buildCardHtml(opt, i)).join("");
      backdrop.appendChild(grid);

      // Footer
      const footer = document.createElement("div");
      footer.className = "oni-opp-footer";

      const spendBtn = document.createElement("button");
      spendBtn.className = "oni-opp-btn oni-opp-btn-spend";
      spendBtn.textContent = "✦ Spend";
      spendBtn.disabled = true;
      footer.appendChild(spendBtn);

      if (canDecline) {
        const declineBtn = document.createElement("button");
        declineBtn.className = "oni-opp-btn oni-opp-btn-decline";
        declineBtn.textContent = "Decline";
        footer.appendChild(declineBtn);
        declineBtn.addEventListener("click", () => {
          backdrop.remove();
          resolve({ cancelled: true });
        });
      }

      backdrop.appendChild(footer);
      document.body.appendChild(backdrop);

      // Track selection
      let selectedId = null;

      grid.addEventListener("click", e => {
        const card = e.target.closest(".oni-opp-card");
        if (!card) return;
        const id = card.dataset.id;

        // Toggle: clicking selected card again de-selects it
        if (selectedId === id) {
          selectedId = null;
          card.classList.remove("is-selected");
          spendBtn.disabled = true;
          return;
        }

        grid.querySelectorAll(".oni-opp-card").forEach(c => c.classList.remove("is-selected"));
        card.classList.add("is-selected");
        selectedId = id;
        spendBtn.disabled = false;
      });

      spendBtn.addEventListener("click", () => {
        if (!selectedId || spendBtn.disabled) return;
        backdrop.remove();
        resolve({ optionId: selectedId });
      });

      // ESC key to decline
      const onKey = e => {
        if (e.key !== "Escape") return;
        document.removeEventListener("keydown", onKey);
        backdrop.remove();
        resolve({ cancelled: true });
      };
      document.addEventListener("keydown", onKey);

      // Clean up key listener if resolved via button
      backdrop.addEventListener("remove", () => document.removeEventListener("keydown", onKey), { once: true });
    });
  }

  window["oni.OpportunityDialog"] = Object.freeze({ showPicker });

  console.debug(`${TAG} Ready.`);
})();
