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
    // Item descriptions carry Foundry content links (@UUID[JournalEntry.x]{Poisoned}).
    // Nothing on these screens enriches them, so every card showed the raw
    // syntax. Reduce each link to its label before parsing.
    descriptionHtml = String(descriptionHtml ?? "").replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1");
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

      /* Keyword/status chips carry their own icon sized for the battle card's
         larger type. Dropped into 12px prose they tower over the text, so tie
         the icon to the current font size instead of letting it keep its
         native dimensions. */
      .tr-desc-body .fud-kw-term img,
      .tr-desc-kw .fud-kw-term img,
      .tr-desc-body .fud-kw-term i,
      .tr-desc-kw .fud-kw-term i {
        width: 1.15em !important;
        height: 1.15em !important;
        object-fit: contain;
        vertical-align: -0.18em;
        ${IMG_RESET}
      }
      .tr-desc-body .fud-kw-term,
      .tr-desc-kw .fud-kw-term {
        font-size: inherit;
        line-height: 1.4;
        vertical-align: baseline;
      }
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

      /* ── Item stat card ───────────────────────────────────────────────
         UNSCOPED on purpose: the card is transplanted between screens, and
         overlay-scoped rules would vanish the moment it moved. */
      .tr-eq-card {
        position: relative;
        width: 420px; height: 520px;
        padding: 18px 20px 16px;
        display: flex; flex-direction: column;
        border-radius: 12px;
        background: linear-gradient(178deg, #f3e5c4 0%, #e7d7b7 55%, #dcc9a4 100%);
        border: 2px solid #8B6914;
        box-shadow: 0 0 0 1px #c9973a, 0 18px 40px rgba(0,0,0,.55),
                    inset 0 1px 0 rgba(255,255,255,.5);
        color: #3b2314;
        font-family: "Signika", "Palatino Linotype", Palatino, Georgia, serif;
        box-sizing: border-box;
      }
      .tr-eq-card * { box-sizing: border-box; }
      .tr-eq-head { display:flex; align-items:center; gap:10px; }
      .tr-eq-name { font-size: 27px; font-weight: 800; line-height: 1.1; }
      .tr-eq-sub {
        margin-top: 2px; font-size: 13px; letter-spacing: .5px;
        border-bottom: 2px solid rgba(60,35,20,.45);
        padding-bottom: 7px; margin-bottom: 12px; opacity: .85;
      }
      .tr-eq-rows { display: flex; flex-direction: column; gap: 9px; }
      .tr-eq-row {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        font-size: 17px; font-weight: 700;
      }
      .tr-eq-row .tr-eq-val { font-size: 20px; font-weight: 800; }
      .tr-eq-label { display: inline-flex; align-items: center; gap: 8px; }
      .tr-eq-label i {
        width: 18px; text-align: center; font-size: 15px; color: rgba(59,35,20,.55);
      }
      .tr-eq-delta { font-size: 14px; margin-left: 6px; font-weight: 800; }
      .tr-eq-desc {
        margin-top: 12px; padding-top: 10px; flex: 1; min-height: 0;
        border-top: 2px solid rgba(60,35,20,.28);
      }
      .tr-eq-stamp {
        position: absolute; right: 16px; bottom: 12px;
        font-size: 22px; font-weight: 800; letter-spacing: 1px;
        color: #6b4a22; opacity: .55; transform: rotate(-4deg);
        text-shadow: 0 1px 0 rgba(255,255,255,.45);
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

      /* ── Skeletal Key picker: hover tooltip ───────────────────────────
         Above the roulette overlay (9999999) and never under the pointer, so
         moving from panel to panel does not make it flicker. */
      #${TIP_ID} {
        position: fixed; z-index: 10000001; pointer-events: none;
        opacity: 0; transform: translateY(4px);
        transition: opacity 140ms ease, transform 140ms ease;
      }
      #${TIP_ID}.tr-tip-in { opacity: 1; transform: translateY(0); }
      /* The stat card is a fixed 420x520. Scaling does not shrink its layout
         box, so the wrapper is sized to the scaled result for positioning. */
      #${TIP_ID} .tr-tip-gear { width: 315px; height: 390px; }
      #${TIP_ID} .tr-tip-gear .tr-eq-card { transform: scale(.75); transform-origin: top left; }
      .tr-tip-card {
        width: 320px; padding: 14px 16px 12px;
        border-radius: 12px;
        background: linear-gradient(178deg, #f3e5c4 0%, #e7d7b7 55%, #dcc9a4 100%);
        border: 2px solid #8B6914;
        box-shadow: 0 0 0 1px #c9973a, 0 14px 32px rgba(0,0,0,.55),
                    inset 0 1px 0 rgba(255,255,255,.5);
        color: #3b2314;
        font-family: "Signika", "Palatino Linotype", Palatino, Georgia, serif;
        box-sizing: border-box;
      }
      .tr-tip-card * { box-sizing: border-box; }
      .tr-tip-head { display: flex; align-items: center; gap: 10px; }
      .tr-tip-name { font-size: 22px; font-weight: 800; line-height: 1.1; }
      .tr-tip-sub {
        margin-top: 3px; margin-bottom: 8px; padding-bottom: 6px;
        font-size: 13px; letter-spacing: .5px; opacity: .85;
        border-bottom: 2px solid rgba(60,35,20,.35);
      }
      .tr-tip-desc { max-height: 240px; overflow: hidden; }

      /* ── In-game confirmation ──────────────────────────────────────── */
      #${CONFIRM_ID} {
        position: fixed; inset: 0; z-index: 10000002;
        display: flex; align-items: center; justify-content: center;
        background: rgba(10,7,4,.45);
        opacity: 0; transition: opacity 200ms cubic-bezier(.2,.9,.2,1);
        font-family: "Signika", "Palatino Linotype", Palatino, Georgia, serif;
      }
      #${CONFIRM_ID}.tr-cf-in { opacity: 1; }
      #${CONFIRM_ID} * { user-select: none; box-sizing: border-box; }
      #${CONFIRM_ID} .tr-cf-frame {
        width: 400px; max-width: 90vw; padding: 18px 22px 16px;
        border-radius: 12px; text-align: center; color: #3b2314;
        background: linear-gradient(178deg, #f3e5c4 0%, #e7d7b7 55%, #dcc9a4 100%);
        border: 2px solid #8B6914;
        box-shadow: 0 0 0 1px #c9973a, 0 18px 40px rgba(0,0,0,.55),
                    inset 0 1px 0 rgba(255,255,255,.5);
        transform: scale(.94);
        transition: transform 200ms cubic-bezier(.2,.9,.2,1);
      }
      #${CONFIRM_ID}.tr-cf-in .tr-cf-frame { transform: scale(1); }
      #${CONFIRM_ID} .tr-cf-title {
        font-size: 26px; font-weight: 800; line-height: 1.15;
        margin-bottom: 12px; padding-bottom: 8px;
        border-bottom: 2px solid rgba(60,35,20,.35);
      }
      #${CONFIRM_ID} .tr-cf-body { margin-bottom: 16px; }
      #${CONFIRM_ID} .tr-cf-btns { display: flex; gap: 10px; }
      #${CONFIRM_ID} .tr-cf-btn {
        flex: 1; padding: 9px 6px; border-radius: 7px; cursor: pointer;
        font-size: 20px; font-weight: 800; color: #3b2314;
        background: rgba(120,85,40,.06);
        transition: background 120ms ease, transform 80ms ease;
      }
      #${CONFIRM_ID} .tr-cf-btn:hover { background: rgba(120,85,40,.18); }
      #${CONFIRM_ID} .tr-cf-btn:active { transform: translateY(1px); }
      #${CONFIRM_ID} .tr-cf-btn.tr-cf-default { box-shadow: inset 0 0 0 2px rgba(120,85,40,.5); }
      #${CONFIRM_ID} .tr-cf-wait { font-size: 13px; font-style: italic; opacity: .7; }
      #${CONFIRM_ID}.tr-cf-spectator { background: rgba(10,7,4,.3); }
    `;
    document.head.appendChild(s);
  }

  // ── The item stat card ────────────────────────────────────────────────────
  // Lives here, not in the equip screen, because BOTH screens draw it: screen 2
  // shows the player what they are handing out before they choose a recipient,
  // and screen 3 shows the same card again beside what is currently worn.
  //
  // Its CSS is deliberately UNSCOPED (no `#overlay` prefix). The card gets
  // transplanted between screens, and overlay-scoped rules would evaporate the
  // moment it moved — the exact failure the parked reward panel already had.

  // Label icons. Chosen to agree with the battle-director action card where it
  // has an opinion — fa-shield-halved is exactly what the card uses for defence.
  const LABEL_ICON = Object.freeze({
    Attribute: "fa-dice-d20",
    Accuracy:  "fa-crosshairs",
    Damage:    "fa-burst",
    Type:      "fa-fire-flame-curved",
    DEF:       "fa-shield-halved",
    MDEF:      "fa-wand-magic-sparkles",
  });

  // Candidates expose defence as one string ("DEF +1 • MDEF +0"); the design
  // wants a row each, so pull the two numbers back out.
  function defParts(cand) {
    const s = String(cand?.defenseLine ?? "");
    const def  = s.match(/(?:^|[^M])DEF\s*([+-]?\d+)/i);
    const mdef = s.match(/MDEF\s*([+-]?\d+)/i);
    return { def: def ? Number(def[1]) : null, mdef: mdef ? Number(mdef[1]) : null };
  }

  function rowsFor(cand) {
    const cat = String(cand?.category ?? "weapon").toLowerCase();
    if (cat === "shield" || cat === "armor") {
      return [
        { label: "DEF",  icon: LABEL_ICON.DEF,  get: (c) => defParts(c).def,  kind: "num" },
        { label: "MDEF", icon: LABEL_ICON.MDEF, get: (c) => defParts(c).mdef, kind: "num" },
      ];
    }
    if (cat === "accessory") return [];
    return [
      { label: "Attribute", icon: LABEL_ICON.Attribute, get: (c) => c?.attackStat,  kind: "attr" },
      { label: "Accuracy",  icon: LABEL_ICON.Accuracy,  get: (c) => c?.checkBonus,  kind: "num" },
      { label: "Damage",    icon: LABEL_ICON.Damage,    get: (c) => c?.damageBonus, kind: "num" },
      { label: "Type",      icon: LABEL_ICON.Type,      get: (c) => c?.element,     kind: "element" },
    ];
  }

  function subtitleFor(cand) {
    if (!cand) return "";
    const cat = String(cand.category ?? "").toLowerCase();
    const bits = cat === "shield" ? ["Shield", cand.handSlots]
      : cat === "armor" ? ["Armor"]
      : cat === "accessory" ? ["Accessory"]
      : [cand.weaponType, cand.weaponRange, cand.handSlots];
    return bits.filter(Boolean).join(" · ");
  }

  /**
   * @param {object|null} cand      the item, or null to render the empty slot
   * @param {object}  opts
   * @param {string}  opts.side     "current" | "new" | "solo"
   * @param {object}  [opts.compareTo]  previous item — deltas render ONLY when
   *   this is supplied, which is what keeps screen 2 (no comparison yet) to
   *   bare values and screen 3 showing the change.
   * @param {boolean} [opts.stamp]  draw the "Equipped" mark
   */
  async function renderItemCard(cand, { side = "solo", compareTo = null, stamp = false } = {}) {
    const isEmpty = !cand;
    const nameColor = isEmpty ? "rgba(59,35,20,.45)" : rarityColor(cand.rarity);
    const nameGlow  = isEmpty ? "none" : rarityGlow(cand.rarity);
    const nameText  = isEmpty ? "(Empty)" : (cand.name ?? "—");
    const icon = isEmpty ? "" : imgHTML(cand.img, { size: 34, alt: nameText });

    const rows = rowsFor(cand ?? compareTo ?? {});
    const rowsHTML = rows.map(({ label, icon: ic, get, kind }) => {
      const raw = cand ? get(cand) : null;
      const labelHTML =
        `<span class="tr-eq-label"><i class="fa-solid ${esc(ic ?? "fa-circle")}"></i>${esc(label)}</span>`;

      if (raw === null || raw === undefined || raw === "") {
        return `<div class="tr-eq-row">${labelHTML}<span class="tr-eq-val" style="opacity:.35">—</span></div>`;
      }

      let valHTML;
      if (kind === "attr")         valHTML = attrPairHTML(raw, 26);
      else if (kind === "element") valHTML = damageTypeHTML(raw);
      else if (kind === "num") {
        const n = Number(raw) || 0;
        valHTML = `${n >= 0 ? "+" : ""}${n}`;
        if (compareTo) {
          const prev = Number(get(compareTo) ?? 0) || 0;
          const d = n - prev;
          if (d !== 0) {
            const c = d > 0 ? DELTA_UP : DELTA_DOWN;
            valHTML += `<span class="tr-eq-delta" style="color:${c}">(${d > 0 ? "+" : ""}${d})</span>`;
          }
        }
      } else valHTML = esc(raw);

      return `<div class="tr-eq-row">${labelHTML}<span class="tr-eq-val">${valHTML}</span></div>`;
    }).join("");

    const desc = isEmpty ? "" : await describeHTML(cand.description);
    const descBlock = desc
      ? `<div class="tr-eq-desc tr-desc-scroll">${desc}</div>`
      : `<div class="tr-eq-desc" style="opacity:.4;font-size:12px;font-style:italic;">No effect</div>`;

    return `
      <div class="tr-eq-card" data-side="${esc(side)}">
        <div class="tr-eq-head">
          ${icon}
          <div class="tr-eq-name" style="color:${nameColor};text-shadow:${nameGlow};">${esc(nameText)}</div>
        </div>
        <div class="tr-eq-sub">${esc(subtitleFor(cand)) || "&nbsp;"}</div>
        <div class="tr-eq-rows">${rowsHTML}</div>
        ${descBlock}
        ${stamp && !isEmpty ? `<div class="tr-eq-stamp">Equipped</div>` : ""}
      </div>`;
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
  const DIM_ID = "oni-tr-dim";
  const PARK_LEFT_VW = 22;   // where the reward panel comes to rest (mockup: left)

  // A backdrop that belongs to the SEQUENCE, not to any one screen.
  //
  // Each screen used to paint its own dim, so the handoff had a gap: the spin
  // overlay faded out (dim gone), then the recipient overlay faded in (dim
  // back) — the scene flashed bright between two screens that are meant to read
  // as one continuous moment. This layer goes up when the reward parks and
  // stays until the sequence ends; the screens make their own background
  // transparent while it exists, so the dim never blinks and never doubles.
  //
  // Sits BELOW the screens (9999998) and below the parked panel (9999999).
  function showDim() {
    let d = document.getElementById(DIM_ID);
    if (d) return d;
    d = document.createElement("div");
    d.id = DIM_ID;
    d.style.cssText =
      "position:fixed;inset:0;z-index:9999996;pointer-events:none;" +
      "background:rgba(10,7,4,0.72);";
    document.body.appendChild(d);
    return d;
  }
  const hasDim = () => !!document.getElementById(DIM_ID);
  function clearDim({ immediate = false } = {}) {
    const d = document.getElementById(DIM_ID);
    if (!d) return;
    if (immediate) { d.remove(); return; }
    d.style.transition = "opacity 260ms ease";
    d.style.opacity = "0";
    setTimeout(() => d.remove(), 280);
  }

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
    showDim();                 // take over the backdrop before the spin fades out
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

  /**
   * @param {boolean} [immediate] remove the node synchronously instead of
   *   fading it. The fade path depends on a setTimeout, and a throttled tab
   *   (Foundry in the background) can stretch that to seconds — long enough for
   *   the parked reward to still be sitting there while the next screen draws
   *   over it. Hand-offs use immediate; end-of-sequence teardown can fade.
   */
  function clearStage({ immediate = false, keepDim = false } = {}) {
    // keepDim: a hand-off between screens drops the parked panel but must NOT
    // drop the backdrop, or the scene flashes bright mid-sequence.
    if (!keepDim) clearDim({ immediate });

    const st = document.getElementById(STAGE_ID);
    if (!st) return;
    if (immediate) { st.remove(); return; }
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

  // ── Item type labels ──────────────────────────────────────────────────────
  // Mirrors the CSB item template's Type select, so a tooltip names a type the
  // way the item sheet does.
  const ITEM_TYPE_LABEL = Object.freeze({
    weapon: "Weapon", armor: "Armor", shield: "Shield", accessory: "Accessory",
    consumable: "Consumable", key: "Key Item", material: "Material",
    recipe: "Recipe", misc: "Misc.",
  });

  // ── Loot tooltip ──────────────────────────────────────────────────────────
  // What a roulette panel IS, shown on hover in the Skeletal Key picker. Gear
  // reuses the stat card screens 2 and 3 draw, so an item reads the same before
  // and after it is picked; anything else gets a compact card on the same
  // parchment.
  //
  // detail shapes — built GM-side by TR.Flow, because a player client may not be
  // allowed to read the world items themselves:
  //   { kind: "gear", cand }                                     equipment
  //   { kind: "item", name, img, rarity, itemType, description } other items
  //   { kind: "text", name, img }                                Zenit / IP rows
  const TIP_ID = "oni-tr-tooltip";
  const TIP_GAP_PX = 14;
  const TIP_MARGIN_PX = 12;
  let _tipSeq = 0;

  async function lootTooltipHTML(detail) {
    if (!detail) return "";
    if (detail.kind === "gear" && detail.cand) {
      return `<div class="tr-tip-gear">${await renderItemCard(detail.cand, { side: "solo" })}</div>`;
    }

    const name = detail.name ?? "Reward";
    const isItem = detail.kind === "item";
    const color = isItem ? rarityColor(detail.rarity) : "#3b2314";
    const glow = isItem ? rarityGlow(detail.rarity) : "none";
    const typeLabel = ITEM_TYPE_LABEL[String(detail.itemType ?? "").toLowerCase()] ?? "";
    const sub = isItem ? [typeLabel, detail.rarity].filter(Boolean).join(" · ") : "Reward";
    const desc = isItem ? await describeHTML(detail.description) : "";

    return `
      <div class="tr-tip-card">
        <div class="tr-tip-head">
          ${imgHTML(detail.img, { size: 34, alt: name })}
          <div class="tr-tip-name" style="color:${color};text-shadow:${glow};">${esc(name)}</div>
        </div>
        <div class="tr-tip-sub">${esc(sub) || "&nbsp;"}</div>
        ${desc ? `<div class="tr-tip-desc">${desc}</div>` : ""}
      </div>`;
  }

  /** Show the tooltip beside a panel. Later hovers win over slower renders. */
  async function showTooltip(anchorEl, detail) {
    const seq = ++_tipSeq;
    const html = await lootTooltipHTML(detail);
    if (seq !== _tipSeq || !html || !anchorEl?.isConnected) return;

    ensureKitStyles();
    let tip = document.getElementById(TIP_ID);
    if (!tip) {
      tip = document.createElement("div");
      tip.id = TIP_ID;
      document.body.appendChild(tip);
    }
    tip.innerHTML = html;
    tip.classList.remove("tr-tip-in");

    // Right of the panel when it fits, otherwise left; vertically centred on it
    // and kept inside the viewport either way.
    const r = anchorEl.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = r.right + TIP_GAP_PX;
    if (left + w > window.innerWidth - TIP_MARGIN_PX) left = r.left - TIP_GAP_PX - w;
    left = Math.max(TIP_MARGIN_PX, left);
    let top = r.top + r.height / 2 - h / 2;
    top = Math.max(TIP_MARGIN_PX, Math.min(top, window.innerHeight - h - TIP_MARGIN_PX));

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    requestAnimationFrame(() => tip.classList.add("tr-tip-in"));
  }

  function hideTooltip() {
    _tipSeq++;
    document.getElementById(TIP_ID)?.remove();
  }

  // ── In-game confirmation ──────────────────────────────────────────────────
  // A parchment Yes/No that belongs to these screens, not Foundry's grey Dialog
  // frame. The Skeletal Key prompt uses it broadcast (so it has a spectator
  // form); the picker's "take this one?" check uses it locally.
  const CONFIRM_ID = "oni-tr-confirm";
  let _confirm = null;

  /**
   * @param {object}  opts
   * @param {boolean} [opts.defaultYes]  Enter answers Yes (and Yes is outlined).
   *   Off by default: a prompt that SPENDS something must not be one stray
   *   Enter away from doing it. Escape always answers No.
   * @returns {{ result: Promise<boolean|null>, close: (value?: boolean|null) => void }}
   *   result is true (Yes), false (No) or null (closed from outside).
   */
  function confirm({
    title = "", bodyHTML = "", yes = "Yes", no = "No",
    interactive = true, waitingText = "", defaultYes = false,
    yesSound = "CONFIRM", noSound = "EQUIP_NO",
  } = {}) {
    ensureKitStyles();
    _confirm?.close(null);

    const el = document.createElement("div");
    el.id = CONFIRM_ID;
    if (!interactive) el.classList.add("tr-cf-spectator");
    el.innerHTML = `
      <div class="tr-cf-frame">
        <div class="tr-cf-title">${esc(title)}</div>
        <div class="tr-cf-body">${bodyHTML}</div>
        ${interactive
          ? `<div class="tr-cf-btns">
               <div class="tr-cf-btn tr-cf-no${defaultYes ? "" : " tr-cf-default"}">${esc(no)}</div>
               <div class="tr-cf-btn tr-cf-yes${defaultYes ? " tr-cf-default" : ""}">${esc(yes)}</div>
             </div>`
          : `<div class="tr-cf-wait">${esc(waitingText || "Waiting…")}</div>`}
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("tr-cf-in"));

    let settle;
    const result = new Promise((r) => { settle = r; });
    let done = false;

    const close = (value = null) => {
      if (done) return;
      done = true;
      window.removeEventListener("keydown", onKey, true);
      if (_confirm?.el === el) _confirm = null;
      el.classList.remove("tr-cf-in");
      el.style.pointerEvents = "none";
      setTimeout(() => el.remove(), 220);
      settle(value);
    };

    const answer = (value) => {
      if (done) return;
      play(value ? yesSound : noSound);
      close(value);
    };

    function onKey(ev) {
      if (ev.key !== "Enter" && ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      answer(ev.key === "Enter" ? defaultYes : false);
    }

    if (interactive) {
      el.querySelector(".tr-cf-yes").addEventListener("click", () => answer(true));
      el.querySelector(".tr-cf-no").addEventListener("click", () => answer(false));
      el.querySelectorAll(".tr-cf-btn").forEach((b) =>
        b.addEventListener("mouseenter", () => play("HOVER")));
      window.addEventListener("keydown", onKey, true);
    }

    _confirm = { el, close };
    return { result, close };
  }

  const isConfirmOpen = () => !!_confirm;

  // ── Install ───────────────────────────────────────────────────────────────
  const API = {
    // colour
    rarityColor, rarityGlow, RARITY_COLOR,
    DELTA_UP, DELTA_DOWN,
    elementColor, elementGlow, damageTypeHTML,
    // media
    imgHTML, attrIconHTML, attrPairHTML, IMG_RESET, ATTR_ICON,
    // content
    describeHTML, renderItemCard, rowsFor, defParts, subtitleFor, LABEL_ICON,
    // motion
    staggerIn, staggerOut, ensureKitStyles, STAGGER_MS, ENTER_MS, EXIT_MS,
    // the travelling reward panel
    stage: {
      ensure: ensureStage, park, clear: clearStage, hasParked, PARK_LEFT_VW,
      showDim, hasDim, clearDim,
    },
    // sound
    Sound: { play, preloadAll, SOUNDS, VOLUME },
    // Skeletal Key picker: hover card + in-game Yes/No
    ITEM_TYPE_LABEL,
    tooltip: { show: showTooltip, hide: hideTooltip, html: lootTooltipHTML },
    confirm, isConfirmOpen,
    esc,
  };

  globalThis.ONI ??= {};
  globalThis.ONI.TreasureRoulette ??= {};
  globalThis.ONI.TreasureRoulette.UIKit = API;
  window["oni.TreasureRoulette.UIKit"] = API;

  Hooks.once("ready", () => { ensureKitStyles(); preloadAll(); });

  console.debug(TAG, "installed.");
})();
