// Weapon-Mode Picker — director-native overlay.
//
// Shown by the TARGET state for Attack actions when the attacker is
// eligible for Two-Weapon Fighting (RAW Core p.69: same Category in
// both hands). Player picks Main / Two-Weapon / Off-Hand.
//
// Same lifecycle pattern as TurnPicker + battlefield action-card:
//   - One overlay per director.combatId (Map-keyed)
//   - Despawned on Stopped, on resolution, and from boot.stop() / preflight
//   - Returns a Promise resolving to: "main" | "two-weapon" | "off" | null
//     (null = cancelled / closed without choice)

import { log, warn } from "./logger.js";

const CSS_ID  = "fud-weapon-mode-picker-style";
const ROOT_ID = "fud-weapon-mode-picker-root";

const _overlays = new Map();

function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const css = document.createElement("style");
  css.id = CSS_ID;
  css.textContent = `
    #${ROOT_ID} {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) scale(0.92);
      opacity: 0;
      z-index: 96;   /* above the action-card overlay (95) */
      pointer-events: none;
      transition: transform 200ms cubic-bezier(.2,.7,.2,1), opacity 200ms ease-out;
    }
    #${ROOT_ID}.is-visible {
      transform: translate(-50%, -50%) scale(1);
      opacity: 1;
    }
    #${ROOT_ID}.is-resolving {
      transform: translate(-50%, -50%) scale(0.96);
      opacity: 0;
      transition: transform 180ms ease-out, opacity 180ms ease-out;
    }

    .fud-wmp-card {
      pointer-events: auto;
      width: 360px;
      max-width: 92vw;
      padding: 12px 14px 10px;
      border: 2px solid var(--fud-stroke, #7a6a55);
      border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top, #f6f1e6), var(--fud-parchment-bot, #ebe3d0));
      box-shadow:
        0 16px 48px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(255, 255, 255, 0.5) inset;
      color: var(--fud-ink, #3a3228);
      font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif;
      letter-spacing: 0.2px;
    }
    .fud-wmp-card .fud-wmp-title {
      font-size: 14px; font-weight: 900; letter-spacing: 0.32px; text-transform: uppercase;
      text-align: center;
      padding-bottom: 7px;
      border-bottom: 2px solid var(--fud-stroke, #7a6a55);
      margin-bottom: 10px;
    }
    .fud-wmp-card .fud-wmp-options {
      display: flex; flex-direction: column; gap: 6px;
    }
    .fud-wmp-card .fud-wmp-section-label {
      font-size: 9.5px;
      font-weight: 900;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--fud-stroke, #7a6a55);
      padding: 6px 4px 3px;
      border-bottom: 1px solid rgba(122, 106, 85, 0.4);
      margin-bottom: 1px;
    }
    .fud-wmp-card .fud-wmp-section-label:first-child {
      margin-top: 0;
      padding-top: 2px;
    }
    .fud-wmp-card .fud-wmp-section-label .hint {
      font-size: 9px;
      font-weight: 700;
      opacity: 0.75;
      text-transform: none;
      letter-spacing: 0.2px;
      margin-left: 6px;
    }
    .fud-wmp-card .fud-wmp-option {
      display: grid; grid-template-columns: 40px 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 8px 12px;
      border-radius: 9px;
      border: 2px solid rgba(90, 62, 28, 0.5);
      background: linear-gradient(180deg, #fffef8, #f5eedd);
      color: #2d1f0d;
      box-shadow:
        0 2px 0 rgba(41, 33, 24, 0.25),
        0 0 0 1px rgba(255, 255, 255, 0.8) inset;
      cursor: pointer;
      user-select: none;
      transition: transform 100ms ease, filter 100ms ease, box-shadow 100ms ease;
    }
    .fud-wmp-card .fud-wmp-option:hover  { filter: brightness(1.03); transform: translateY(-1px); }
    .fud-wmp-card .fud-wmp-option:active { transform: translateY(0); }
    .fud-wmp-card .fud-wmp-option .icon {
      display: flex; align-items: center; justify-content: center;
      width: 36px; height: 36px;
    }
    .fud-wmp-card .fud-wmp-option .icon img {
      width: 36px; height: 36px;
      border-radius: 6px;
      object-fit: cover;
      border: 0 !important;
      outline: 0 !important;
      background: transparent !important;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35) !important;
    }
    .fud-wmp-card .fud-wmp-option .icon i.fa-solid { font-size: 22px; opacity: 0.9; }
    .fud-wmp-card .fud-wmp-option .info {
      min-width: 0;
    }
    .fud-wmp-card .fud-wmp-option .primary {
      font-weight: 900; letter-spacing: 0.2px;
      font-size: 13px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      display: flex; align-items: center; gap: 6px;
    }
    .fud-wmp-card .fud-wmp-option .secondary {
      font-size: 10.5px; opacity: 0.82; font-weight: 600;
      letter-spacing: 0.2px;
      margin-top: 2px;
    }
    .fud-wmp-card .fud-wmp-option .secondary .dot { margin: 0 5px; opacity: 0.6; }
    .fud-wmp-card .fud-wmp-option .kbd {
      font-size: 10px; font-weight: 800; padding: 2px 6px;
      border: 1px solid var(--fud-stroke, #7a6a55);
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.4);
      color: var(--fud-stroke, #7a6a55);
    }
    .fud-wmp-card .fud-wmp-cancel {
      margin-top: 8px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 2px solid var(--fud-stroke, #7a6a55);
      background: linear-gradient(180deg, #e5d6c5, #c9b294);
      color: var(--fud-ink, #3a3228);
      font-weight: 800; letter-spacing: 0.32px; text-transform: uppercase;
      font-size: 11px;
      cursor: pointer;
      text-align: center;
      user-select: none;
      box-shadow:
        0 3px 0 rgba(41, 33, 24, 0.55),
        0 0 0 1px var(--fud-highlight, rgba(255, 255, 255, 0.7)) inset;
    }
    .fud-wmp-card .fud-wmp-cancel:hover { filter: brightness(1.05); }
  `;
  document.head.appendChild(css);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

const WEAPON_ICON = {
  arcane: "fa-book", bow: "fa-bow-arrow", brawling: "fa-hand-fist",
  dagger: "fa-dagger", firearm: "fa-gun", flail: "fa-mace",
  heavy: "fa-hammer", spear: "fa-location-arrow", sword: "fa-sword",
  thrown: "fa-bomb",
};

function weaponIcon(weaponType) {
  const cls = WEAPON_ICON[String(weaponType || "").toLowerCase()] ?? "fa-sword";
  return `<i class="fa-solid ${cls}" aria-hidden="true"></i>`;
}

// Open the picker. Awaits a Promise of the user's choice.
//   `main`                   → main-hand only (no penalty)
//   `two-weapon`             → both, main hand fires first (RAW: any order)
//   `two-weapon-off-first`   → both, off hand fires first
//   `off`                    → off-hand only (always available when off equipped)
//   `virtual:<N>`            → exposed virtual attack at virtualAttacks[N]
//                              (e.g. Dual Shieldbearer's Twin Shields when
//                              two shields are equipped)
//   `null`                   → cancelled (escape / cancel button)
//
// `allowTwoWeapon` is true only when the two equipped weapons share the
// same Category (RAW Core p.69). When false, the Two-Weapon options are
// hidden — Main / Off only.
//
// `virtualAttacks` is an array of frozen profile objects from
// snapshot.resolveVirtualAttacks — each gets its own pick option in a
// separate "Virtual" section.
//
// RAW grants both orders ("you perform the two attacks in any order you
// prefer"). Order matters because some weapon riders (poison ticks,
// status applies, on-hit reactions) depend on which strike lands first.
export async function pickWeaponMode({ director, mainWeapon, offWeapon, allowTwoWeapon = false, virtualAttacks = [], externalCancel = null }) {
  // No GM gate: weapon-mode picker is client-local.
  ensureStyles();

  // Overlay keying. GM uses director.combatId; player runs without a
  // director so falls back to a fixed key (only one weapon-mode picker
  // is ever open per client at a time).
  const overlayKey = director?.combatId ?? "no-director";

  // Despawn any prior.
  const prior = _overlays.get(overlayKey);
  if (prior) { try { prior.cleanup(); } catch {} _overlays.delete(overlayKey); }

  // Inline URL guard — strips anything that could break inline HTML.
  const safeUrl = (raw) => {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s || /['"<>\n\r]/.test(s)) return null;
    return s;
  };
  // Primary visual = weapon image (or weapon-type FA icon when no image
  // resolves); primary label = weapon name. The "Main / Off / Two-Weapon"
  // role moves to the smaller secondary line so the player's eye lands on
  // the weapon they're actually firing.
  //
  // Options are grouped into sections (Single Hand / Two-Weapon) with a
  // subtle header so the player can scan: "what hand am I picking?" vs
  // "am I declaring a Two-Weapon round?".
  const arrow = `<i class="fa-solid fa-arrow-right" style="opacity:0.55; font-size:10.5px;"></i>`;
  const opts = []; // flat list for keyboard shortcut lookup
  const sections = [];

  const singleHand = [];
  if (mainWeapon) {
    singleHand.push({
      mode: "main",
      imageUrl: safeUrl(mainWeapon.imageUrl),
      fallbackIcon: weaponIcon(mainWeapon.weaponType),
      primary: escapeHtml(mainWeapon.name),
      secondary: `Main Hand<span class="dot">•</span>${escapeHtml(mainWeapon.A1)} + ${escapeHtml(mainWeapon.A2)}`,
    });
  }
  if (offWeapon) {
    singleHand.push({
      mode: "off",
      imageUrl: safeUrl(offWeapon.imageUrl),
      fallbackIcon: weaponIcon(offWeapon.weaponType),
      primary: escapeHtml(offWeapon.name),
      secondary: `Off-Hand<span class="dot">•</span>${escapeHtml(offWeapon.A1)} + ${escapeHtml(offWeapon.A2)}`,
    });
  }
  if (singleHand.length) {
    sections.push({ label: "Single Hand", hint: null, items: singleHand });
  }

  if (allowTwoWeapon && mainWeapon && offWeapon) {
    sections.push({
      label: "Two-Weapon",
      hint: "Both attack — HR 0",
      items: [
        {
          mode: "two-weapon",
          imageUrl: safeUrl(mainWeapon.imageUrl),
          fallbackIcon: `<i class="fa-solid fa-swords" aria-hidden="true"></i>`,
          primary: `${escapeHtml(mainWeapon.name)} ${arrow} ${escapeHtml(offWeapon.name)}`,
          secondary: `Main fires first`,
        },
        {
          mode: "two-weapon-off-first",
          imageUrl: safeUrl(offWeapon.imageUrl),
          fallbackIcon: `<i class="fa-solid fa-swords" aria-hidden="true"></i>`,
          primary: `${escapeHtml(offWeapon.name)} ${arrow} ${escapeHtml(mainWeapon.name)}`,
          secondary: `Off fires first`,
        },
      ],
    });
  }

  // Virtual attacks — synthesised profiles exposed by AEs
  // (Dual Shieldbearer's Twin Shields, future "X+Y unlocks Z").
  // Author label per profile so multiple exposures are distinguishable.
  if (Array.isArray(virtualAttacks) && virtualAttacks.length) {
    sections.push({
      label: "Virtual",
      hint: virtualAttacks.length === 1 ? null : `${virtualAttacks.length} options`,
      items: virtualAttacks.map((va, i) => ({
        mode: `virtual:${i}`,
        imageUrl: safeUrl(va.imageUrl),
        fallbackIcon: weaponIcon(va.weaponType),
        primary: escapeHtml(va.name),
        secondary: `${escapeHtml(va.weaponType || "Brawling")}<span class="dot">•</span>${escapeHtml(va.A1)} + ${escapeHtml(va.A2)}`,
      })),
    });
  }

  // Number keyboard shortcuts in visual order across sections, then
  // collapse to a flat `opts` list for the key listener below.
  let nextKey = 1;
  const sectionsHTML = sections.map((section) => {
    const itemsHTML = section.items.map((o) => {
      o.key = String(nextKey++);
      opts.push(o);
      return `
        <div class="fud-wmp-option" data-fud-mode="${o.mode}" role="button" tabindex="0">
          <div class="icon">${o.imageUrl ? `<img src="${o.imageUrl}" alt="">` : o.fallbackIcon}</div>
          <div class="info">
            <div class="primary">${o.primary}</div>
            <div class="secondary">${o.secondary}</div>
          </div>
          <div class="kbd">${o.key}</div>
        </div>
      `;
    }).join("");
    const hintHTML = section.hint ? `<span class="hint">${escapeHtml(section.hint)}</span>` : "";
    return `
      <div class="fud-wmp-section-label">${escapeHtml(section.label)}${hintHTML}</div>
      ${itemsHTML}
    `;
  }).join("");
  const optsHTML = sectionsHTML;

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="fud-wmp-card" role="dialog" aria-label="Weapon Mode">
      <div class="fud-wmp-title">Choose Attack Mode</div>
      <div class="fud-wmp-options">${optsHTML}</div>
      <div class="fud-wmp-cancel" data-fud-mode="cancel" role="button" tabindex="0">Cancel</div>
    </div>
  `;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("is-visible"));

  log("WeaponModePicker spawned", opts.map((o) => o.mode).join(" / "));

  return new Promise((resolve) => {
    let resolved = false;
    let keyListener = null;
    let despawnTid = null;

    const finish = (mode) => {
      if (resolved) return;
      resolved = true;

      root.classList.remove("is-visible");
      root.classList.add("is-resolving");
      despawnTid = setTimeout(() => {
        try { root.remove(); } catch {}
        _overlays.delete(overlayKey);
      }, 200);

      if (keyListener) {
        try { window.removeEventListener("keydown", keyListener, true); } catch {}
        keyListener = null;
      }

      resolve(mode === "cancel" ? null : mode);
    };

    const onClick = (ev) => {
      const target = ev.target?.closest?.("[data-fud-mode]");
      if (!target) return;
      ev.stopPropagation();
      finish(target.dataset.fudMode);
    };
    root.addEventListener("click", onClick);

    keyListener = (ev) => {
      if (resolved) return;
      if (ev.key === "Escape") { ev.preventDefault(); finish("cancel"); return; }
      // Number-key shortcuts: 1=main, 2=two-weapon, 3=off
      const opt = opts.find((o) => o.key === ev.key);
      if (opt) { ev.preventDefault(); finish(opt.mode); }
    };
    window.addEventListener("keydown", keyListener, true);

    // External cancellation: caller resolves externalCancel to tear
    // down this overlay (e.g. composeAction lost the race and needs
    // to close its picker). Routes through the same path as Esc.
    if (externalCancel && typeof externalCancel.then === "function") {
      externalCancel.then(() => {
        if (resolved) return;
        try { finish("cancel"); } catch {}
      });
    }

    const cleanup = () => {
      try { clearTimeout(despawnTid); } catch {}
      try { window.removeEventListener("keydown", keyListener, true); } catch {}
      try { root.remove(); } catch {}
      _overlays.delete(overlayKey);
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    };

    _overlays.set(overlayKey, { cleanup, root });
  });
}

export const WeaponModePicker = {
  despawn({ director }) {
    const rec = _overlays.get(director.combatId);
    if (!rec) return;
    try { rec.cleanup(); } catch {}
    _overlays.delete(overlayKey);
  },

  despawnAll() {
    for (const rec of _overlays.values()) {
      try { rec.cleanup(); } catch {}
    }
    _overlays.clear();
  },
};
