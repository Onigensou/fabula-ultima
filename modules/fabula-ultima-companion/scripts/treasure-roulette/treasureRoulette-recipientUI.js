// ============================================================================
// [TreasureRoulette] Recipient UI • Foundry VTT v12
// ----------------------------------------------------------------------------
// Screen 2: "Give to" — the reward sits parked on the left (it travelled here
// from the reveal), an arrow points right, and the candidates stack vertically
// with their portraits breaking out over the panel edge.
//
//   [ Poison Lash ]   ▶    ┌ Party ┐
//                          ┌ Hina  ┐
//                          ┌ Zarg  ┐   ← stagger in left→right
//                          ┌ Keren ┐      stagger out the opposite way
//
// Pure presentation:
//   show({ payload, interactive }) -> Promise<{kind, actorUuid} | null>
//   hide()
// Spectators see the same screen, inert, with "Waiting for <name>…".
//
// The reward panel is NOT drawn here when one is already parked on the loot
// stage — that node is the very element from the spin. Only when this screen is
// opened standalone (the UX bench) does it draw its own stand-in.
//
// Party Inventory is the default and is hidden entirely for IP rewards, which
// cannot be stored on the Party Inventory actor.
// ============================================================================

(() => {
  const TAG = "[TreasureRoulette][RecipientUI]";
  const OVL_ID = "oni-tr-recipient-overlay";
  const STYLE_ID = "oni-tr-recipient-style";

  const PARTY_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/bag.png";

  const kit = () => globalThis.ONI?.TreasureRoulette?.UIKit;
  const esc = (s) => (kit()?.esc ?? ((v) => String(v ?? "")))(s);

  let _resolve = null;
  let _keyHandler = null;
  let _ownsStage = false;   // true when WE drew the reward panel (bench path)

  function ensureStyles() {
    kit()?.ensureKitStyles?.();
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      #${OVL_ID} {
        position: fixed; inset: 0; z-index: 9999998;
        background: rgba(10, 7, 4, 0.72);
        opacity: 0; transition: opacity 240ms cubic-bezier(.2,.9,.2,1);
        font-family: "Signika", "Palatino Linotype", Palatino, Georgia, serif;
      }
      #${OVL_ID}.oni-in { opacity: 1; }
      #${OVL_ID}.oni-out { opacity: 0; }
      #${OVL_ID} * { user-select: none; box-sizing: border-box; }

      #${OVL_ID} .tr-rc-title {
        position: absolute; top: 5vh; left: 0; right: 0; text-align: center;
        font-size: 40px; font-weight: 800; letter-spacing: 1px;
        color: #fff6e2; text-shadow: 0 3px 0 rgba(0,0,0,.5), 0 0 22px rgba(255,200,110,.35);
      }

      /* Arrow sits between the parked reward and the list. */
      #${OVL_ID} .tr-rc-arrow {
        position: absolute; left: 36vw; top: 50vh; transform: translate(-50%,-50%);
        font-size: 54px; color: #8d2f24; line-height: 1;
        text-shadow: 0 2px 0 rgba(0,0,0,.4);
      }

      /* Candidate column, right of the arrow. */
      #${OVL_ID} .tr-rc-list {
        position: absolute; left: 44vw; top: 50vh; transform: translateY(-50%);
        display: flex; flex-direction: column; gap: 30px;
        width: 430px; max-height: 84vh; overflow: visible;
      }

      #${OVL_ID} .tr-rc-card {
        position: relative; height: 84px; padding: 0 20px 0 104px;
        display: flex; align-items: center;
        border-radius: 10px; cursor: pointer;
        background: linear-gradient(178deg, #f3e5c4 0%, #e7d7b7 55%, #dcc9a4 100%);
        border: 2px solid #8B6914;
        box-shadow: 0 0 0 1px #c9973a, 0 10px 22px rgba(0,0,0,.45),
                    inset 0 1px 0 rgba(255,255,255,.45);
        transition: filter 130ms ease, box-shadow 130ms ease, transform 130ms ease;
      }
      #${OVL_ID} .tr-rc-card:hover { filter: brightness(1.06); transform: translateX(6px); }
      #${OVL_ID} .tr-rc-card.tr-rc-selected {
        box-shadow: 0 0 0 3px rgba(255,220,130,.85), 0 12px 26px rgba(0,0,0,.5),
                    inset 0 1px 0 rgba(255,255,255,.45);
        transform: translateX(6px);
      }

      /* Portrait breaks out above the bar, as in the mockup. It stands ON the
         bar (bottom-aligned) and rises above it, so the row gap has to clear
         the overhang — otherwise it lands on top of the card above. z-index
         keeps it over its own card while the next card still draws above it. */
      #${OVL_ID} .tr-rc-portrait {
        position: absolute; left: -4px; bottom: 0;
        width: 88px; height: 96px; object-fit: contain; object-position: bottom;
        pointer-events: none; z-index: 2;
        filter: drop-shadow(0 6px 10px rgba(0,0,0,.55));
      }
      #${OVL_ID} .tr-rc-name {
        font-size: 30px; font-weight: 800; color: #3b2314; line-height: 1;
      }
      #${OVL_ID} .tr-rc-sub {
        margin-left: auto; font-size: 12px; font-style: italic;
        color: rgba(59,35,20,.62);
      }

      #${OVL_ID} .tr-rc-foot {
        position: absolute; left: 0; right: 0; bottom: 3vh; text-align: center;
        font-size: 13px; font-style: italic; color: rgba(240,220,176,.6);
      }

      #${OVL_ID}.tr-rc-spectator .tr-rc-card { cursor: default; pointer-events: none; }

      /* Stand-in reward panel — only drawn when nothing is parked (bench use).
         Mirrors the roulette panel so the bench looks like the real flow. */
      .tr-rc-standin {
        position: fixed; left: 22vw; top: 50vh; transform: translate(-50%,-50%);
        width: 300px; height: 78px; padding: 10px 14px;
        display: flex; align-items: center; gap: 12px;
        border-radius: 10px; background: #e7d7b7; color: #3b2314;
        box-shadow: 0 10px 20px rgba(0,0,0,.25), inset 0 0 0 2px rgba(60,35,20,.25);
        font-family: "Signika", "Palatino Linotype", serif;
      }
      .tr-rc-standin .tr-rc-standin-name {
        font-size: 22px; font-weight: 800; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis;
      }
    `;
    document.head.appendChild(s);
  }

  function memberSubtitle(m, kind) {
    if (kind === "itempoint") {
      const { cur, max } = m.ip ?? {};
      if (Number(max) > 0) return `IP ${cur}/${max}`;
    }
    return "";
  }

  function cardHTML({ id, portrait, name, sub, selected }) {
    const K = kit();
    return `
      <div class="tr-rc-card${selected ? " tr-rc-selected" : ""}" data-id="${esc(id)}">
        ${/* size/position come from .tr-rc-portrait — passing them inline here
              would win over the stylesheet and silently pin the old values. */""}
        ${K.imgHTML(portrait, { size: 0, alt: name, cls: "tr-rc-portrait", extra: "" })}
        <div class="tr-rc-name">${esc(name)}</div>
        ${sub ? `<div class="tr-rc-sub">${esc(sub)}</div>` : ""}
      </div>`;
  }

  function buildOverlay(payload, interactive) {
    ensureStyles();
    document.getElementById(OVL_ID)?.remove();

    const K = kit();
    const kind = String(payload?.reward?.kind ?? "").toLowerCase();
    const allowParty = payload?.allowParty !== false && !!payload?.partyInventory;

    const cards = [];
    if (allowParty) {
      cards.push({
        id: payload.partyInventory.actorUuid,
        portrait: PARTY_ICON,
        name: "Party",
        sub: "Shared stash",
        kind: "party",
      });
    }
    for (const m of payload?.members ?? []) {
      cards.push({ id: m.actorUuid, portrait: m.portrait, name: m.name, sub: memberSubtitle(m, kind), kind: "member" });
    }
    const defaultId = cards[0]?.id ?? null;

    // Only draw a reward panel if the spin didn't already park one.
    _ownsStage = false;
    if (!K.stage.hasParked()) {
      const stage = K.stage.ensure();
      const standin = document.createElement("div");
      standin.className = "tr-rc-standin";
      standin.innerHTML =
        `${K.imgHTML(payload?.reward?.img ?? "icons/svg/chest.svg", { size: 46 })}
         <div class="tr-rc-standin-name">${esc(payload?.reward?.name ?? "Reward")}</div>`;
      stage.appendChild(standin);
      _ownsStage = true;
    }

    const overlay = document.createElement("div");
    overlay.id = OVL_ID;
    if (!interactive) overlay.classList.add("tr-rc-spectator");
    overlay.innerHTML = `
      <div class="tr-rc-title">Give to</div>
      <div class="tr-rc-arrow">&#10230;</div>
      <div class="tr-rc-list">
        ${cards.map((c) => cardHTML({ ...c, selected: c.id === defaultId })).join("")}
      </div>
      <div class="tr-rc-foot"></div>`;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("oni-in"));

    K.staggerIn(overlay.querySelectorAll(".tr-rc-card"), {
      onEach: () => K.Sound.play("PANEL_IN"),
    });

    return { overlay, cards, defaultId };
  }

  async function close(result) {
    const fn = _resolve;
    _resolve = null;

    if (_keyHandler) { window.removeEventListener("keydown", _keyHandler, true); _keyHandler = null; }

    const el = document.getElementById(OVL_ID);
    if (el) {
      const K = kit();
      await K.staggerOut(el.querySelectorAll(".tr-rc-card"));
      el.classList.remove("oni-in");
      el.classList.add("oni-out");
      setTimeout(() => el.remove(), 260);
    }

    // If we drew the stand-in, we own the stage and must clean it up. When the
    // spin parked the real panel, the FLOW owns it — it has to survive into the
    // equip screen.
    if (_ownsStage) { kit()?.stage?.clear?.(); _ownsStage = false; }

    fn?.(result ?? null);
  }

  const API = {
    /** @returns {Promise<{kind:string, actorUuid:string}|null>} */
    show({ payload, interactive = false } = {}) {
      if (_resolve) close(null);

      const { overlay, cards, defaultId } = buildOverlay(payload, interactive);
      let selectedId = defaultId;

      return new Promise((resolve) => {
        _resolve = resolve;
        const K = kit();
        const foot = overlay.querySelector(".tr-rc-foot");

        if (!interactive) {
          const who = payload?.controllerName;
          foot.textContent = who ? `Waiting for ${who}…` : "Waiting for the party leader…";
          return;
        }
        foot.textContent = "Click to choose · Enter confirms";

        const select = (id) => {
          if (id === selectedId) return;
          selectedId = id;
          K.Sound.play("SELECT");
          overlay.querySelectorAll(".tr-rc-card").forEach((el) =>
            el.classList.toggle("tr-rc-selected", el.dataset.id === id));
        };

        const confirm = () => {
          const card = cards.find((c) => c.id === selectedId) ?? cards[0];
          if (!card) return close(null);
          K.Sound.play("CONFIRM");
          close({ kind: card.kind, actorUuid: card.id });
        };

        overlay.querySelectorAll(".tr-rc-card").forEach((el) => {
          el.addEventListener("mouseenter", () => K.Sound.play("HOVER"));
          // Single click picks AND commits — the mockup has no separate confirm.
          el.addEventListener("click", () => { select(el.dataset.id); confirm(); });
        });

        _keyHandler = (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); confirm(); }
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
  globalThis.ONI.TreasureRoulette.RecipientUI = API;
  window["oni.TreasureRoulette.RecipientUI"] = API;

  console.debug(TAG, "installed.");
})();
