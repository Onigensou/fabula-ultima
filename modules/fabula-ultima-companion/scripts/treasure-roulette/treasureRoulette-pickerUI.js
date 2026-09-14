// ============================================================================
// [TreasureRoulette] Picker UI • Foundry VTT v12
// ----------------------------------------------------------------------------
// The two Skeletal Key screens. Same contract as the recipient and equip
// screens, so TR.Flow drives them through askScreen() exactly like those:
//   show({ payload, interactive, requestId }) -> Promise<choice | null>
//   hide(opts)
//
// KeyPromptUI — "Use a Skeletal Key?", asked BEFORE the roulette opens. It names
//   only the roulette type and the key count: the pool does not exist yet, so
//   the question is "pick or spin", never "is this pool worth a key?".
//     -> { use: boolean }
//
// PickerUI — the roulette ring itself, opened through UI.openRing so it is the
//   exact screen a spin would show, with the wheel replaced by the player's
//   hand: hover a panel for its tooltip, click it, confirm.
//     -> { tableResultId }
//   hide({ keep: true }) leaves the ring on screen, inert, so the reveal
//   (UI.play on the locked packet) can adopt it without a blink. A safety timer
//   takes it down if no reveal ever claims it.
//
// Spectators see both screens inert with "Waiting for <name>…". They can still
// hover the picker's panels to read what is on offer.
// ============================================================================

(() => {
  const TAG = "[TreasureRoulette][PickerUI]";
  const STYLE_ID = "oni-tr-picker-style";
  const HEAD_CLASS = "tr-pk-head";
  const FOOT_CLASS = "tr-pk-foot";

  // A kept ring that no reveal adopts (the flow died between pick and lock) is
  // removed after this long rather than left up as a dead overlay.
  const KEEP_SAFETY_MS = 20000;

  const kit = () => globalThis.ONI?.TreasureRoulette?.UIKit;
  const rouletteUI = () => window["oni.TreasureRoulette.UI"];
  const esc = (s) => (kit()?.esc ?? ((v) => String(v ?? "")))(s);

  const waitingFor = (who, what = "") =>
    who ? `Waiting for ${who}${what}…` : `Waiting for the party leader${what}…`;

  function ensureStyles() {
    kit()?.ensureKitStyles?.();
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      /* The ring lays its panels out with pointer-events off — a spin is not
         clickable. The picker turns them back on. */
      .oni-treasure-roulette-overlay.tr-pk-live .oni-roulette-panel {
        pointer-events: auto;
      }
      .oni-treasure-roulette-overlay.tr-pk-live.tr-pk-interactive .oni-roulette-panel {
        cursor: pointer;
      }
      .oni-treasure-roulette-overlay.tr-pk-live .oni-roulette-panel:hover {
        opacity: 1;
        filter: brightness(1.06);
        transform: translate(-50%, -50%) scale(1.03);
      }
      .oni-treasure-roulette-overlay.tr-pk-live.tr-pk-interactive .oni-roulette-panel:hover {
        box-shadow:
          0 14px 26px rgba(0,0,0,0.35),
          0 0 0 3px rgba(255, 235, 185, 0.55),
          inset 0 0 0 2px rgba(60,35,20,0.25);
      }

      .oni-treasure-roulette-overlay .${HEAD_CLASS} {
        position: absolute; top: 4vh; left: 0; right: 0;
        text-align: center; pointer-events: none;
        font-family: "Signika", "Palatino Linotype", Palatino, Georgia, serif;
      }
      .${HEAD_CLASS} .tr-pk-title {
        font-size: 36px; font-weight: 800; letter-spacing: 1px;
        color: #fff6e2;
        text-shadow: 0 3px 0 rgba(0,0,0,.5), 0 0 22px rgba(255,200,110,.35);
      }
      .${HEAD_CLASS} .tr-pk-keys {
        margin-top: 6px; display: inline-flex; align-items: center; gap: 8px;
        font-size: 15px; color: rgba(255,233,190,.85);
        text-shadow: 0 2px 6px rgba(0,0,0,.8);
      }
      .oni-treasure-roulette-overlay .${FOOT_CLASS} {
        position: absolute; left: 0; right: 0; bottom: 3vh;
        text-align: center; pointer-events: none;
        font-family: "Signika", "Palatino Linotype", serif;
        font-size: 13px; font-style: italic; color: rgba(240,220,176,.7);
      }

      /* Bodies for the two confirmations. */
      .tr-kp-key {
        display: flex; align-items: center; justify-content: center;
        gap: 12px; margin-bottom: 10px;
      }
      .tr-kp-count { font-size: 22px; font-weight: 800; }
      .tr-kp-text { font-size: 15px; line-height: 1.45; }
      .tr-kp-pick { display: flex; align-items: center; justify-content: center; gap: 12px; }
      .tr-kp-pick-name { font-size: 22px; font-weight: 800; }
    `;
    document.head.appendChild(s);
  }

  // --------------------------------------------------------------------------
  // Key prompt
  // --------------------------------------------------------------------------
  let _prompt = null;

  const KeyPromptUI = {
    /** @returns {Promise<{use: boolean} | null>} */
    show({ payload, interactive = false } = {}) {
      const K = kit();
      if (!K?.confirm) return Promise.resolve(null);
      ensureStyles();
      _prompt?.close(null);

      const count = Number(payload?.count ?? 0) || 0;
      const name = payload?.name ?? "Skeletal Key";
      const label = payload?.rouletteLabel || "Treasure";

      const c = K.confirm({
        title: "Use a Skeletal Key?",
        bodyHTML: `
          <div class="tr-kp-key">
            ${K.imgHTML(payload?.icon, { size: 52, alt: name })}
            <div class="tr-kp-count">${esc(name)} &times;${count}</div>
          </div>
          <div class="tr-kp-text">Choose your reward from the <b>${esc(label)}</b> roulette instead of spinning for it.</div>`,
        yes: "Use Key",
        no: "Spin",
        interactive,
        waitingText: waitingFor(payload?.controllerName),
        yesSound: "EQUIP_YES",
        noSound: "EQUIP_NO",
      });
      _prompt = c;

      return c.result.then((v) => {
        if (_prompt === c) _prompt = null;
        return v == null ? null : { use: v === true };
      });
    },

    hide() {
      const c = _prompt;
      _prompt = null;
      c?.close(null);
    },
  };

  // --------------------------------------------------------------------------
  // Picker
  // --------------------------------------------------------------------------
  // { ring, resolve, confirm } for the open picker, if any.
  let _pick = null;

  function stripLive(overlay) {
    overlay.classList.remove("tr-pk-live", "tr-pk-interactive");
    overlay.querySelector(`.${HEAD_CLASS}`)?.remove();
    overlay.querySelector(`.${FOOT_CLASS}`)?.remove();
  }

  const PickerUI = {
    /** @returns {Promise<{tableResultId: string|null} | null>} */
    show({ payload, interactive = false, requestId = null } = {}) {
      const K = kit();
      const UI = rouletteUI();
      const rows = Array.isArray(payload?.displayPool) ? payload.displayPool : [];

      if (!K?.confirm || !UI?.openRing || !rows.length) {
        console.warn(TAG, "picker cannot open (UI/UIKit missing or empty pool).");
        // Answering null would leave the flow waiting out the full timeout, which
        // ends in a random pick from the pool anyway — so say that now.
        return Promise.resolve(interactive ? { tableResultId: null } : null);
      }

      ensureStyles();
      if (_pick) PickerUI.hide();

      const ring = UI.openRing({ requestId: requestId ?? payload?.requestId, rows });
      const { overlay, panels } = ring;
      overlay.classList.add("tr-pk-live");
      if (interactive) overlay.classList.add("tr-pk-interactive");

      // The key tracker: the player has just spent one, so say how many are left.
      const remaining = Number(payload?.keysRemaining);
      const head = document.createElement("div");
      head.className = HEAD_CLASS;
      head.innerHTML = `
        <div class="tr-pk-title">Choose your reward</div>
        <div class="tr-pk-keys">
          ${K.imgHTML(payload?.keyIcon, { size: 22, alt: "" })}
          <span>Skeletal Key used${Number.isFinite(remaining) ? ` &middot; ${remaining} left` : ""}</span>
        </div>`;
      overlay.appendChild(head);

      const foot = document.createElement("div");
      foot.className = FOOT_CLASS;
      foot.textContent = interactive
        ? "Hover to inspect · Click to choose"
        : waitingFor(payload?.controllerName, " to choose");
      overlay.appendChild(foot);

      const details = payload?.details ?? {};

      return new Promise((resolve) => {
        const st = { ring, resolve, confirm: null };
        _pick = st;

        panels.forEach((panel, i) => {
          const row = rows[i];

          panel.addEventListener("mouseenter", () => {
            if (_pick !== st || st.confirm) return;
            K.Sound.play("HOVER");
            K.tooltip.show(panel, details[row?.tableResultId]);
          });
          panel.addEventListener("mouseleave", () => {
            if (_pick === st) K.tooltip.hide();
          });

          if (!interactive) return;

          panel.addEventListener("click", async () => {
            if (_pick !== st || st.confirm || !row) return;
            K.tooltip.hide();
            K.Sound.play("SELECT");
            panels.forEach((p) => p.classList.toggle("oni-selected", p === panel));

            const c = K.confirm({
              title: "Take this reward?",
              bodyHTML: `
                <div class="tr-kp-pick">
                  ${K.imgHTML(row.img, { size: 46, alt: row.name })}
                  <div class="tr-kp-pick-name">${esc(row.name)}</div>
                </div>`,
              yes: "Take it",
              no: "Back",
              defaultYes: true,
            });
            st.confirm = c;
            const ok = await c.result;
            if (st.confirm === c) st.confirm = null;
            if (_pick !== st) return;   // closed from outside meanwhile

            if (ok === true) {
              const done = st.resolve;
              st.resolve = null;
              done?.({ tableResultId: row.tableResultId });
            } else {
              panel.classList.remove("oni-selected");
            }
          });
        });

        UI.easeIn?.(ring);
      });
    },

    /**
     * @param {object}  [opts]
     * @param {boolean} [opts.keep]  leave the ring up for the reveal to adopt
     */
    hide({ keep = false } = {}) {
      const st = _pick;
      if (!st) return;
      _pick = null;

      const done = st.resolve;
      st.resolve = null;
      st.confirm?.close(null);
      st.confirm = null;
      kit()?.tooltip?.hide?.();

      const { overlay } = st.ring;
      stripLive(overlay);

      if (keep && overlay.isConnected) {
        overlay.dataset.awaitReveal = "1";
        setTimeout(() => {
          if (overlay.isConnected && overlay.dataset.awaitReveal === "1") {
            rouletteUI()?.closeRing?.(st.ring);
          }
        }, KEEP_SAFETY_MS);
      } else {
        rouletteUI()?.closeRing?.(st.ring);
      }

      done?.(null);
    },
  };

  globalThis.ONI ??= {};
  globalThis.ONI.TreasureRoulette ??= {};
  globalThis.ONI.TreasureRoulette.KeyPromptUI = KeyPromptUI;
  globalThis.ONI.TreasureRoulette.PickerUI = PickerUI;
  window["oni.TreasureRoulette.KeyPromptUI"] = KeyPromptUI;
  window["oni.TreasureRoulette.PickerUI"] = PickerUI;

  console.debug(TAG, "installed.");
})();
