// ============================================================================
// [TreasureRoulette] UI Kit • Foundry VTT v12
// ----------------------------------------------------------------------------
// Shared vocabulary for the loot screens: rarity colours, damage-type colours,
// attribute icons, the description pipeline, staggered enter/exit motion, and
// sound. Both the recipient screen and the equip comparison read from here so
// they can't drift apart.
//
// Everything that has a canonical definition elsewhere is BORROWED, not
// re-invented:
//   - damage-type colour  → ELEMENT_COLOR / ELEMENT_GLOW (battle-director card)
//   - description parsing → parseEffectDescription + keywordChipHTML (same card)
//   - sound conventions   → ONI.CheckRequester.Sound registry shape
//
// Exposed as globalThis.ONI.TreasureRoulette.UIKit
// ============================================================================

(() => {
  const TAG = "[TreasureRoulette][UIKit]";
  const MODULE_ID = "fabula-ultima-companion";

  // ── Rarity ────────────────────────────────────────────────────────────────
  // Black / Blue / Gold / Purple, per the mockup. These sit on PARCHMENT, so
  // every value is picked for contrast against the light card, not a dark bg.
  const RARITY_COLOR = Object.freeze({
    common:    "#1b1b1b",
    uncommon:  "#1f6fb2",
    rare:      "#b8860b",
    legendary: "#7a3fb5",
  });
  const RARITY_GLOW = Object.freeze({
    common:    "none",
    uncommon:  "0 0 10px rgba(31,111,178,0.30)",
    rare:      "0 0 12px rgba(184,134,11,0.38)",
    legendary: "0 0 14px rgba(122,63,181,0.40)",
  });

  const rarityKey = (r) => String(r ?? "").trim().toLowerCase();
  const rarityColor = (r) => RARITY_COLOR[rarityKey(r)] ?? RARITY_COLOR.common;
  const rarityGlow  = (r) => RARITY_GLOW[rarityKey(r)] ?? "none";

  // ── Stat deltas ───────────────────────────────────────────────────────────
  // Blue = better, red = worse (per the mockup — NOT the usual green/red).
  const DELTA_UP   = "#1f6fb2";
  const DELTA_DOWN = "#c0392b";

  // ── Attribute icons ───────────────────────────────────────────────────────
  // Art, not FontAwesome. NOTE the border-stripping: this world's global sheet
  // puts a frame on every <img>, which shows up as a black square around any
  // transparent PNG. Every injected image in this kit carries the reset.
  const ATTR_ICON = Object.freeze({
    MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
    DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
    INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
    WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png",
  });

  // The one place that knows how to inject an image without the world's global
  // <img> frame showing up. Use this for EVERY image these screens render.
  const IMG_RESET =
    "background:transparent !important;border:0 !important;outline:0 !important;" +
    "box-shadow:none !important;";

  const esc = (s) => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  /**
   * @param {number|null} size px for BOTH dimensions. Pass 0/null to emit no
   *   width/height at all and let a CSS class own the sizing — an inline
   *   width always beats the stylesheet, including `unset`, so there is no way
   *   to "opt out" once it is written.
   */
  function imgHTML(src, { size = 24, alt = "", cls = "", extra = "" } = {}) {
    if (!src) return "";
    const dims = size ? `width:${size}px;height:${size}px;` : "";
    return `<img src="${esc(src)}" alt="${esc(alt)}" class="${esc(cls)}"
      style="${dims}object-fit:contain;${IMG_RESET}${extra}">`;
  }

  function attrIconHTML(attr, size = 26) {
    const key = String(attr ?? "").toUpperCase().trim();
    const src = ATTR_ICON[key];
    if (!src) return `<span style="opacity:.5">${esc(key || "—")}</span>`;
    return imgHTML(src, { size, alt: key, extra: "vertical-align:middle;" });
  }

  /** "DEX + INS" → two icons with a plus between. Falls back to text. */
  function attrPairHTML(attackStat, size = 26) {
    const parts = String(attackStat ?? "").split("+").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return `<span style="opacity:.45">—</span>`;
    return parts.map((p) => attrIconHTML(p, size))
      .join(`<span style="margin:0 6px;opacity:.65;font-weight:700;">+</span>`);
  }

  // ── Damage type ───────────────────────────────────────────────────────────
  // Borrowed from the battle-director card so an element reads the same colour
  // here as it does mid-combat. Imported lazily: action-card is an ES module and
  // these UI files are classic scripts.
  let _cardModPromise = null;
  function cardMod() {
    _cardModPromise ??= import(
      `/modules/${MODULE_ID}/scripts/battle-director/action-card.js`
    ).catch((e) => { console.warn(TAG, "action-card import failed:", e); return null; });
    return _cardModPromise;
  }

  // Local mirror of the card's canonical palette (parchment-tuned). Kept in sync
  // by borrowing the same values; the module import above is used for the
  // description pipeline, which cannot be mirrored.
  const ELEMENT_COLOR = Object.freeze({
    physical: "#1b1b1b", fire: "#e25822", ice: "#5ab3d4", air: "#48c774",
    wind: "#48c774", earth: "#8b5e3c", bolt: "#9b59b6", lightning: "#9b59b6",
    light: "#a38b50", dark: "#4b0082", poison: "#2e8b57", elementless: "#1b1b1b",
  });
  const ELEMENT_GLOW = Object.freeze({
    physical: "rgba(0,0,0,0.28)", fire: "rgba(226,88,34,0.45)",
    ice: "rgba(90,179,212,0.45)", air: "rgba(72,199,116,0.45)",
    earth: "rgba(139,94,60,0.45)", bolt: "rgba(155,89,182,0.45)",
    light: "rgba(163,139,80,0.45)", dark: "rgba(75,0,130,0.45)",
    poison: "rgba(46,139,87,0.45)",
  });

  const elementColor = (e) => ELEMENT_COLOR[String(e ?? "").toLowerCase()] ?? "#1b1b1b";
  const elementGlow  = (e) => ELEMENT_GLOW[String(e ?? "").toLowerCase()] ?? "rgba(0,0,0,0.25)";

  function damageTypeHTML(element) {
    const label = String(element ?? "").trim();
    if (!label) return `<span style="opacity:.45">—</span>`;
    const c = elementColor(label);
    return `<span style="color:${c};font-weight:800;text-shadow:0 0 10px ${elementGlow(label)};">${esc(label)}</span>`;
  }

  // ── Item description ──────────────────────────────────────────────────────
  /**
   * Render an item's description the way the action card does — keywords lifted
   * into chips, status links swapped, unknown links flattened — but wrapped in
   * OUR layout instead of the card's <fieldset>.
   * @returns {Promise<string>} html ("" when there's nothing to show)
   */
  async function describeHTML(descriptionHtml) {
    if (!descriptionHtml) return "";
    const mod = await cardMod();
    if (!mod?.parseEffectDescription) {
      // Degrade to the raw HTML rather than dropping the effect text entirely.
      return `<div class="tr-desc-body">${descriptionHtml}</div>`;
    }
    try {
      const { keywords, bodyHtml } = mod.parseEffectDescription(descriptionHtml);
      const chips = (keywords ?? []).length && mod.keywordChipHTML
        ? `<div class="tr-desc-kw">${keywords.map(mod.keywordChipHTML).join("")}</div>`
        : "";
      const body = bodyHtml ? `<div class="tr-desc-body">${bodyHtml}</div>` : "";
      return chips || body ? `${chips}${body}` : "";
    } catch (e) {
      console.warn(TAG, "describeHTML failed:", e);
      return `<div class="tr-desc-body">${descriptionHtml}</div>`;
    }
  }

  // ── Motion ────────────────────────────────────────────────────────────────
  // Panels enter sliding left→right with a stagger, and leave the same order in
  // the opposite direction. One helper so both screens share the timing feel.
  const STAGGER_MS = 70;
  const ENTER_MS = 320;
  const EXIT_MS = 240;

  /** Mark elements for the enter animation, then reveal them in order. */
  function staggerIn(els, { stagger = STAGGER_MS, onEach = null } = {}) {
    const list = Array.from(els ?? []);
    list.forEach((el) => el.classList.add("tr-anim-enter"));
    list.forEach((el, i) => {
      setTimeout(() => {
        el.classList.add("tr-anim-in");
        try { onEach?.(el, i); } catch {}
      }, i * stagger);
    });
    return (list.length ? (list.length - 1) * stagger : 0) + ENTER_MS;
  }

  /** Reverse: slide out the opposite way, same order. Resolves when done. */
  function staggerOut(els, { stagger = STAGGER_MS, onEach = null } = {}) {
    const list = Array.from(els ?? []);
    list.forEach((el, i) => {
      setTimeout(() => {
        el.classList.remove("tr-anim-in");
        el.classList.add("tr-anim-out");
        try { onEach?.(el, i); } catch {}
      }, i * stagger);
    });
    const total = (list.length ? (list.length - 1) * stagger : 0) + EXIT_MS;
    return new Promise((r) => setTimeout(r, total));
  }

  // Shared motion + description CSS. Injected once.
  const MOTION_STYLE_ID = "oni-tr-uikit-style";
  function ensureKitStyles() {
    if (document.getElementById(MOTION_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = MOTION_STYLE_ID;
    s.textContent = `
      .tr-anim-enter {
        opacity: 0;
        transform: translateX(-46px);
        transition: opacity ${ENTER_MS}ms cubic-bezier(.2,.9,.2,1),
                    transform ${ENTER_MS}ms cubic-bezier(.2,.9,.2,1);
      }
      .tr-anim-enter.tr-anim-in { opacity: 1; transform: translateX(0); }
      .tr-anim-enter.tr-anim-out {
        opacity: 0;
        transform: translateX(46px);
        transition: opacity ${EXIT_MS}ms cubic-bezier(.4,0,.6,1),
                    transform ${EXIT_MS}ms cubic-bezier(.4,0,.6,1);
      }

      /* Description block — parchment-friendly, and the chips keep the shared
         fud-kw-term styling so they match the action card exactly. */
      .tr-desc-kw { display:flex; flex-wrap:wrap; gap:5px; margin-bottom:6px; }
      .tr-desc-body { font-size:12px; line-height:1.5; color:#3b2314; }
      .tr-desc-body p { margin:0 0 6px; }
      .tr-desc-body ul { margin:0 0 6px; padding-left:18px; }
      .tr-desc-body img { ${IMG_RESET} }

      /* ── Parked reward panel ───────────────────────────────────────────
         The roulette's own rules are scoped to its overlay, so once the panel
         is transplanted here it needs its look re-declared. These mirror
         .oni-roulette-panel and its children, plus the winner emphasis it had
         when it left, and scale it up slightly since it is now the anchor of
         the screen rather than one of eight options. */
      #${STAGE_ID} .oni-roulette-panel {
        position: fixed;
        width: var(--oni-panel-w, 273px);
        min-width: 340px;
        height: var(--oni-panel-h, 70px);
        display: flex; align-items: center; gap: 12px;
        padding: 9px 13px; box-sizing: border-box;
        border-radius: 10px;
        background: #e7d7b7;
        opacity: 1;
        box-shadow:
          0 14px 26px rgba(0,0,0,0.35),
          0 0 0 3px rgba(255, 235, 185, 0.55),
          0 0 26px 6px rgba(255, 214, 130, 0.28),
          inset 0 0 0 2px rgba(60,35,20,0.25);
      }
      #${STAGE_ID} .oni-roulette-panel .oni-roulette-looticon {
        width: calc(var(--oni-panel-h, 70px) * 0.70);
        height: calc(var(--oni-panel-h, 70px) * 0.70);
        object-fit: contain;
        ${IMG_RESET}
        filter: drop-shadow(0 2px 2px rgba(0,0,0,0.25));
      }
      #${STAGE_ID} .oni-roulette-panel .oni-roulette-lootname {
        flex: 1;
        font-family: "Signika", "Modesto Condensed", "Palatino Linotype", serif;
        font-size: calc(var(--oni-panel-h, 70px) * 0.34);
        color: #3b2314;
        letter-spacing: 0.3px;
        text-shadow: 0 2px 0 rgba(0,0,0,0.15);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }

      /* Fixed-height description well: long text SCROLLS, the panel never grows. */
      .tr-desc-scroll {
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        padding-right: 6px;
      }
      .tr-desc-scroll::-webkit-scrollbar { width: 8px; }
      .tr-desc-scroll::-webkit-scrollbar-track { background: rgba(60,35,20,0.10); border-radius: 4px; }
      .tr-desc-scroll::-webkit-scrollbar-thumb {
        background: rgba(120,85,40,0.55); border-radius: 4px;
      }
      .tr-desc-scroll::-webkit-scrollbar-thumb:hover { background: rgba(120,85,40,0.8); }
    `;
    document.head.appendChild(s);
  }

  // ── The loot stage ────────────────────────────────────────────────────────
  // A layer that outlives the individual screens, so the reward panel can travel
  // from the reveal into the recipient screen instead of the screen going blank
  // between two overlays.
  //
  // park() TRANSPLANTS the live winner panel node out of the roulette overlay
  // and into this layer — it is the same element, so there is no re-render, no
  // flicker, and no need to match two renderers pixel-for-pixel.
  const STAGE_ID = "oni-tr-stage";
  const PARK_LEFT_VW = 22;   // where the reward panel comes to rest (mockup: left)

  function ensureStage() {
    let st = document.getElementById(STAGE_ID);
    if (st) return st;
    st = document.createElement("div");
    st.id = STAGE_ID;
    // ABOVE the screens (which sit at 9999998), not below them. The screens
    // paint a dark backdrop across the whole viewport, so a stage underneath
    // gets dimmed by it — the parked reward would read as greyed-out even
    // though it is part of the same UI. pointer-events:none keeps it from
    // swallowing clicks meant for the list behind it.
    st.style.cssText =
      "position:fixed;inset:0;z-index:9999999;pointer-events:none;";
    document.body.appendChild(st);
    return st;
  }

  /**
   * Move a live panel node into the stage and glide it to the parked position.
   * @param {HTMLElement} node the winner panel (already on screen)
   */
  function park(node) {
    if (!node) return null;
    const stage = ensureStage();

    // The panel's looks live in CSS scoped to `.oni-treasure-roulette-overlay`,
    // and its size comes from --oni-panel-w/h set on that overlay. Transplanting
    // the node out of the overlay drops every one of those rules and the panel
    // collapses to an unstyled scrap. Carry the sizing vars across, and the
    // stage stylesheet below re-declares the visuals for its new home.
    try {
      const src = node.closest(".oni-treasure-roulette-overlay");
      if (src) {
        const cs = getComputedStyle(src);
        for (const v of ["--oni-panel-w", "--oni-panel-h"]) {
          const val = cs.getPropertyValue(v);
          if (val) stage.style.setProperty(v, val.trim());
        }
      }
    } catch { /* the stage CSS has fallbacks */ }

    // Freeze current viewport position so the transplant doesn't jump.
    const r = node.getBoundingClientRect();
    node.style.transition = "none";
    node.style.position = "fixed";
    node.style.left = `${r.left + r.width / 2}px`;
    node.style.top = `${r.top + r.height / 2}px`;
    node.style.margin = "0";
    node.style.transform = "translate(-50%, -50%)";
    stage.appendChild(node);

    // Next frame: animate to the park slot.
    requestAnimationFrame(() => {
      node.style.transition =
        "left 520ms cubic-bezier(.2,.9,.2,1), top 520ms cubic-bezier(.2,.9,.2,1), transform 520ms cubic-bezier(.2,.9,.2,1)";
      node.style.left = `${PARK_LEFT_VW}vw`;
      node.style.top = "50vh";
      node.style.transform = "translate(-50%, -50%) scale(1)";
    });

    stage.dataset.parked = "1";
    return node;
  }

  const hasParked = () => document.getElementById(STAGE_ID)?.dataset.parked === "1";

  function clearStage() {
    const st = document.getElementById(STAGE_ID);
    if (!st) return;
    st.style.transition = "opacity 260ms ease";
    st.style.opacity = "0";
    setTimeout(() => st.remove(), 280);
  }

  // ── Sound ─────────────────────────────────────────────────────────────────
  // Ported from the check-requester conventions (same registry shape, same
  // local-only playback). Cues are provisional — handpick and tune later.
  const SOUNDS = Object.freeze({
    PANEL_IN:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_2.wav",
    HOVER:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3",
    SELECT:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_1.wav",
    CONFIRM:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    CANCEL:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Buzzer2.ogg",
    // Equip yes/no. YES borrows the Equipment system's own confirm sound
    // (Soundboard/Key.ogg, per [Macro] Equipment.js) so swapping gear sounds
    // the same wherever the player does it.
    EQUIP_YES:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Key.ogg",
    EQUIP_NO:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_3.wav",
  });
  const VOLUME = Object.freeze({
    PANEL_IN: 0.35, HOVER: 0.25, SELECT: 0.5, CONFIRM: 0.6, CANCEL: 0.5,
    EQUIP_YES: 0.7, EQUIP_NO: 0.6,
  });

  function play(key) {
    const src = SOUNDS[key];
    if (!src) return;
    try {
      const AH = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
      AH?.play?.({ src, volume: VOLUME[key] ?? 0.5, autoplay: true, loop: false }, false);
    } catch { /* audio is never worth throwing over */ }
  }

  function preloadAll() {
    for (const url of Object.values(SOUNDS)) {
      try { const a = new Audio(url); a.preload = "auto"; a.load(); } catch {}
    }
  }

  // ── Install ───────────────────────────────────────────────────────────────
  const API = {
    // colour
    rarityColor, rarityGlow, RARITY_COLOR,
    DELTA_UP, DELTA_DOWN,
    elementColor, elementGlow, damageTypeHTML,
    // media
    imgHTML, attrIconHTML, attrPairHTML, IMG_RESET, ATTR_ICON,
    // content
    describeHTML,
    // motion
    staggerIn, staggerOut, ensureKitStyles, STAGGER_MS, ENTER_MS, EXIT_MS,
    // the travelling reward panel
    stage: { ensure: ensureStage, park, clear: clearStage, hasParked, PARK_LEFT_VW },
    // sound
    Sound: { play, preloadAll, SOUNDS, VOLUME },
    esc,
  };

  globalThis.ONI ??= {};
  globalThis.ONI.TreasureRoulette ??= {};
  globalThis.ONI.TreasureRoulette.UIKit = API;
  window["oni.TreasureRoulette.UIKit"] = API;

  Hooks.once("ready", () => { ensureKitStyles(); preloadAll(); });

  console.debug(TAG, "installed.");
})();
