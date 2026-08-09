// ============================================================================
// [TreasureRoulette] Equip UI • Foundry VTT v12
// ----------------------------------------------------------------------------
// Screen 3: "Switch Equipment" — two parchment cards side by side, the wearer
// between them, No/Yes in the middle.
//
//   [ EQUIPPED ]        (actor)        [ NEW ]
//    Longsword           ▶ arrow ▶      Bow
//    stats                 No/Yes       stats + deltas
//    effect text                        effect text
//
// Pure presentation, same contract as RecipientUI:
//   show({ payload, interactive }) -> Promise<{equip, slotKey} | null>
//   hide()
// Spectators get the identical screen with the controls inert.
//
// Conventions all come from the UI Kit so this can't drift from the rest of the
// game: rarity colour on the item name, blue/red stat deltas, the battle-
// director's damage-type palette, art attribute icons, and the action card's
// description pipeline. Panels are a FIXED height — long effect text scrolls
// inside its own well rather than stretching the card.
//
// Slot tabs remain (a weapon may be legal in more than one hand), but they now
// carry legality: illegal slots are shown DISABLED with the reason, and the
// default selection auto-picks the first empty LEGAL slot.
// ============================================================================

(() => {
  const TAG = "[TreasureRoulette][EquipUI]";
  const OVL_ID = "oni-tr-equip-overlay";
  const STYLE_ID = "oni-tr-equip-style";
  const MODULE_ID = "fabula-ultima-companion";

  const kit = () => globalThis.ONI?.TreasureRoulette?.UIKit;
  const esc = (s) => (kit()?.esc ?? ((v) => String(v ?? "")))(s);

  let _resolve = null;
  let _keyHandler = null;

  // ── Styles ────────────────────────────────────────────────────────────────
  function ensureStyles() {
    kit()?.ensureKitStyles?.();
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      #${OVL_ID} {
        position: fixed; inset: 0; z-index: 9999998;
        background: rgba(10, 7, 4, 0.76);
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 240ms cubic-bezier(.2,.9,.2,1);
        font-family: "Signika", "Palatino Linotype", Palatino, Georgia, serif;
      }
      #${OVL_ID}.oni-in { opacity: 1; }
      #${OVL_ID}.oni-out { opacity: 0; }
      #${OVL_ID} * { user-select: none; box-sizing: border-box; }

      #${OVL_ID} .tr-eq-title {
        position: absolute; top: 6vh; left: 0; right: 0; text-align: center;
        font-size: 34px; font-weight: 800; letter-spacing: 1px;
        color: #fff6e2; text-shadow: 0 3px 0 rgba(0,0,0,.5), 0 0 22px rgba(255,200,110,.35);
      }

      #${OVL_ID} .tr-eq-stage {
        display: flex; align-items: center; justify-content: center;
        gap: 26px; margin-top: 4vh;
      }

      /* Card visuals live UNSCOPED in the UI Kit — the card is transplanted
         between screens and scoped rules would not survive the move. */

      /* ── Middle column: wearer, arrow, choices ── */
      #${OVL_ID} .tr-eq-mid {
        display: flex; flex-direction: column; align-items: center;
        gap: 12px; width: 190px;
      }
      #${OVL_ID} .tr-eq-portrait {
        width: 150px; height: 190px; object-fit: contain;
        filter: drop-shadow(0 10px 16px rgba(0,0,0,.6));
      }
      /* Solid pointing triangle, not a long-tailed arrow — the tail vanished
         against the battlefield. Stroked and glowed so it reads on any scene. */
      #${OVL_ID} .tr-eq-arrow {
        font-size: 40px; line-height: 1; color: #c9482f;
        -webkit-text-stroke: 2px #2a0f0a;
        paint-order: stroke fill;
        text-shadow: 0 0 12px rgba(255,140,90,.75), 0 0 26px rgba(255,90,50,.45);
        animation: trArrowBob 2.4s ease-in-out infinite;
      }
      /* Flow-positioned here, so a plain translate is enough. */
      @keyframes trArrowBob {
        0%, 100% { transform: translateX(-2px); }
        50%      { transform: translateX(3px); }
      }
      #${OVL_ID} .tr-eq-choices {
        display: flex; flex-direction: column; gap: 8px; width: 130px;
        padding: 12px 10px; border-radius: 10px;
        background: linear-gradient(178deg, #f3e5c4 0%, #e2d0ac 100%);
        border: 2px solid #8B6914;
        box-shadow: 0 0 0 1px #c9973a, 0 10px 22px rgba(0,0,0,.45);
      }
      #${OVL_ID} .tr-eq-btn {
        padding: 9px 6px; border-radius: 7px; cursor: pointer; text-align: center;
        font-size: 21px; font-weight: 800; color: #3b2314;
        transition: filter 120ms ease, transform 80ms ease, background 120ms ease;
      }
      #${OVL_ID} .tr-eq-btn:hover { background: rgba(120,85,40,.16); }
      #${OVL_ID} .tr-eq-btn:active { transform: translateY(1px); }
      #${OVL_ID} .tr-eq-btn.tr-eq-default { box-shadow: inset 0 0 0 2px rgba(120,85,40,.5); }
      /* No legal slot for this item on this actor — Yes must not be pressable. */
      #${OVL_ID} .tr-eq-btn.tr-eq-btn-disabled {
        opacity: .38; cursor: not-allowed; text-decoration: line-through;
        filter: grayscale(1);
      }
      #${OVL_ID} .tr-eq-btn.tr-eq-btn-disabled:hover { background: transparent; filter: grayscale(1); }

      /* ── Slot tabs — above the wearer, inside the middle column ──
         A 2-column grid rather than a wrapping flex row: two tabs sit side by
         side instead of stacking, and the columns stay even whatever the
         labels are. */
      #${OVL_ID} .tr-eq-slots {
        position: relative; width: 100%;
        display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px;
        margin-bottom: 4px;
      }
      #${OVL_ID} .tr-eq-slot {
        padding: 7px 6px; border-radius: 999px; cursor: pointer;
        text-align: center; white-space: nowrap;
        font-size: 13px; font-weight: 800; letter-spacing: .03em;
        color: rgba(240,220,176,.8);
        border: 1px solid #6b5210; background: rgba(0,0,0,.42);
        transition: all 130ms ease;
      }
      #${OVL_ID} .tr-eq-slot.tr-eq-slot-active {
        color: #1e150c; border-color: #f0d060;
        background: linear-gradient(175deg, #f0d060 0%, #c8960c 100%);
      }
      #${OVL_ID} .tr-eq-slot.tr-eq-slot-illegal {
        cursor: not-allowed; opacity: .5;
        color: #e0a0a0; border-color: #7a3b3b;
        text-decoration: line-through;
      }
      #${OVL_ID} .tr-eq-slot-reason {
        position: absolute; left: 0; right: 0; bottom: -22px; text-align: center;
        font-size: 12px; font-style: italic; color: #e0a0a0;
      }

      #${OVL_ID} .tr-eq-foot {
        position: absolute; left: 0; right: 0; bottom: 2.4vh; text-align: center;
        font-size: 12px; font-style: italic; color: rgba(240,220,176,.6);
      }

      #${OVL_ID}.tr-eq-spectator .tr-eq-btn,
      #${OVL_ID}.tr-eq-spectator .tr-eq-slot { cursor: default; pointer-events: none; }
      #${OVL_ID}.tr-eq-spectator .tr-eq-choices { opacity: .5; }
    `;
    document.head.appendChild(s);
  }

  // ── Row model ─────────────────────────────────────────────────────────────
  // Only the rows that mean something for the category, so a shield isn't padded
  // with blank weapon rows.
  // Card rendering lives in the UI Kit so screen 2 and screen 3 draw the SAME
  // element. Deltas appear only when a comparison is supplied — screen 2 has
  // none, so it shows bare values.
  const cardHTML = (cand, opts) => kit().renderItemCard(cand, opts);

  function slotTabsHTML(slots, activeKey) {
    if (!slots?.length) return "";
    const tabs = slots.map((s) => {
      const illegal = s.legal === false;
      const cls = `tr-eq-slot${s.key === activeKey ? " tr-eq-slot-active" : ""}${illegal ? " tr-eq-slot-illegal" : ""}`;
      const free = !s.occupied && !illegal ? " · free" : "";
      return `<div class="${cls}" data-slot="${esc(s.key)}" ${illegal ? `title="${esc(s.reason ?? "")}"` : ""}>${esc(s.label)}${free}</div>`;
    }).join("");
    return `<div class="tr-eq-slots">${tabs}<div class="tr-eq-slot-reason"></div></div>`;
  }

  // ── Build ─────────────────────────────────────────────────────────────────
  async function buildOverlay(payload, interactive) {
    ensureStyles();
    document.getElementById(OVL_ID)?.remove();

    // The reward panel travelled from the reveal and anchored screen 2, but
    // screen 3 is the two cards and the wearer — the parked panel has no place
    // in this composition and would sit on top of the left card. Fade it out as
    // this screen comes in. The flow's own stage.clear() at the end is then a
    // no-op, so ownership is unchanged.
    // Drop the parked reward but KEEP the backdrop — this is a hand-off inside
    // one sequence, not the end of it.
    try { kit()?.stage?.clear?.({ immediate: true, keepDim: true }); } catch { /* nothing parked */ }

    const slots = payload?.slots ?? [];
    const activeKey = payload?.preferredSlotKey ?? slots.find((s) => s.legal !== false)?.key ?? slots[0]?.key ?? null;
    const active = slots.find((s) => s.key === activeKey) ?? slots[0] ?? null;

    const overlay = document.createElement("div");
    overlay.id = OVL_ID;
    if (!interactive) overlay.classList.add("tr-eq-spectator");

    const [leftCard, rightCard] = await Promise.all([
      cardHTML(active?.current ?? null, { side: "current", stamp: true }),
      cardHTML(payload?.incoming ?? null, { side: "new", compareTo: active?.current ?? null }),
    ]);

    if (kit().stage.hasDim()) overlay.style.background = "transparent";

    overlay.innerHTML = `
      <div class="tr-eq-title">Switch Equipment</div>
      <div class="tr-eq-stage">
        ${leftCard}
        <div class="tr-eq-mid">
          ${slotTabsHTML(slots, activeKey)}
          ${/* size comes from .tr-eq-portrait; inline values would override it. */""}
          ${kit().imgHTML(payload?.portrait, { size: 0, alt: payload?.actorName ?? "", cls: "tr-eq-portrait", extra: "" })}
          <div class="tr-eq-arrow">&#9654;</div>
          <div class="tr-eq-choices">
            <div class="tr-eq-btn tr-eq-btn-no tr-eq-default">No</div>
            <div class="tr-eq-btn tr-eq-btn-yes">Yes</div>
          </div>
        </div>
        ${rightCard}
      </div>
      <div class="tr-eq-foot"></div>`;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("oni-in"));

    // Stagger the two cards + the middle column in, left → right.
    const K = kit();
    const order = [
      overlay.querySelector('.tr-eq-card[data-side="current"]'),
      overlay.querySelector(".tr-eq-mid"),
      overlay.querySelector('.tr-eq-card[data-side="new"]'),
    ].filter(Boolean);
    K.staggerIn(order, { onEach: () => K.Sound.play("PANEL_IN") });

    return { overlay, slots, activeKey, order };
  }

  async function close(result) {
    const fn = _resolve;
    _resolve = null;

    if (_keyHandler) { window.removeEventListener("keydown", _keyHandler, true); _keyHandler = null; }

    const el = document.getElementById(OVL_ID);
    if (el) {
      const K = kit();
      const order = [
        el.querySelector('.tr-eq-card[data-side="current"]'),
        el.querySelector(".tr-eq-mid"),
        el.querySelector('.tr-eq-card[data-side="new"]'),
      ].filter(Boolean);
      await K.staggerOut(order);
      el.classList.remove("oni-in");
      el.classList.add("oni-out");
      setTimeout(() => el.remove(), 260);
    }

    fn?.(result ?? null);
  }

  const API = {
    /** @returns {Promise<{equip:boolean, slotKey:string}|null>} */
    async show({ payload, interactive = false } = {}) {
      if (_resolve) await close(null);

      const { overlay, slots } = await buildOverlay(payload, interactive);
      let activeKey = payload?.preferredSlotKey ?? slots.find((s) => s.legal !== false)?.key ?? slots[0]?.key ?? null;

      return new Promise((resolve) => {
        _resolve = resolve;

        const K = kit();
        const foot = overlay.querySelector(".tr-eq-foot");
        const reasonEl = overlay.querySelector(".tr-eq-slot-reason");

        if (!interactive) {
          const who = payload?.controllerName;
          foot.textContent = who ? `Waiting for ${who}…` : "Waiting for the party leader…";
          return;
        }
        foot.textContent = "Default: No";

        const stage = overlay.querySelector(".tr-eq-stage");

        overlay.querySelectorAll(".tr-eq-slot").forEach((el) => {
          const slot = slots.find((s) => s.key === el.dataset.slot);

          el.addEventListener("mouseenter", () => {
            if (slot?.legal === false && reasonEl) reasonEl.textContent = slot.reason ?? "";
          });
          el.addEventListener("mouseleave", () => { if (reasonEl) reasonEl.textContent = ""; });

          el.addEventListener("click", async () => {
            // Illegal slot: greyed out is the whole message. A buzzer on top of
            // that just punishes the player for reading the screen.
            if (slot?.legal === false) return;
            if (el.dataset.slot === activeKey) return;
            activeKey = el.dataset.slot;
            K.Sound.play("SELECT");

            overlay.querySelectorAll(".tr-eq-slot").forEach((t) =>
              t.classList.toggle("tr-eq-slot-active", t.dataset.slot === activeKey));

            // Re-render both cards for the newly selected slot.
            const s = slots.find((x) => x.key === activeKey);
            const [l, r] = await Promise.all([
              cardHTML(s?.current ?? null, { side: "current", stamp: true }),
              cardHTML(payload?.incoming ?? null, { side: "new", compareTo: s?.current ?? null }),
            ]);
            stage.querySelector('.tr-eq-card[data-side="current"]').outerHTML = l;
            stage.querySelector('.tr-eq-card[data-side="new"]').outerHTML = r;
            stage.querySelectorAll(".tr-eq-card").forEach((c) => c.classList.add("tr-anim-enter", "tr-anim-in"));
          });
        });

        // "Yes" is only meaningful if there is somewhere legal to put the item.
        // Gating the slot tabs alone left Yes clickable, which would commit a
        // swap the rules forbid (applyEquipmentSwap does not reject on martial
        // grounds). Reflect legality on the button itself, and re-evaluate it
        // whenever the selected slot changes.
        const yesBtn = overlay.querySelector(".tr-eq-btn-yes");
        const refreshYes = () => {
          const slot = slots.find((s) => s.key === activeKey);
          const ok = !!slot && slot.legal !== false;
          yesBtn.classList.toggle("tr-eq-btn-disabled", !ok);
          yesBtn.title = ok ? "" : (slot?.reason ?? "Cannot equip this here");
          if (!ok) foot.textContent = slot?.reason ?? "Cannot equip this here";
          else foot.textContent = "Default: No";
          return ok;
        };

        const answer = (equip) => {
          if (equip && !refreshYes()) return;   // silently inert — the button is already greyed
          K.Sound.play(equip ? "EQUIP_YES" : "EQUIP_NO");
          close({ equip, slotKey: activeKey });
        };

        yesBtn.addEventListener("click", () => answer(true));
        overlay.querySelector(".tr-eq-btn-no").addEventListener("click", () => answer(false));
        overlay.querySelectorAll(".tr-eq-btn").forEach((b) =>
          b.addEventListener("mouseenter", () => K.Sound.play("HOVER")));

        refreshYes();   // the auto-picked slot may already be illegal

        _keyHandler = (ev) => {
          if (ev.key === "Escape" || ev.key === "Enter") {
            ev.preventDefault(); ev.stopPropagation(); answer(false);
          }
        };
        window.addEventListener("keydown", _keyHandler, true);
      });
    },

    hide() {
      if (!_resolve && !document.getElementById(OVL_ID)) return;
      close(null);
    },
  };

  globalThis.ONI ??= {};
  globalThis.ONI.TreasureRoulette ??= {};
  globalThis.ONI.TreasureRoulette.EquipUI = API;
  window["oni.TreasureRoulette.EquipUI"] = API;

  console.debug(TAG, "installed.");
})();
