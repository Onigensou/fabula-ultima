/**
 * [CheckRoller] Dialog — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * Purpose:
 * - Provides the "openDialog" adapter for ONI.CheckRoller Manager.
 * - Uses the finalized UI from CheckRoller_Dialog_UIDESIGNER (mirrored layout/feel).
 * - Builds a payload for a Fabula Ultima check (A+B), with modifiers and optional DL preset.
 *
 * Notes:
 * - DL is shown as a non-editable label (mirrors UI designer). If you want DL in payload,
 *   pass it via openDialog(context) as context.dl (number) and optionally:
 *   - context.dlVisibility: "shown" | "hidden"
 *   - context.visibility: "all" | "gm" | "self"
 *
 * Local-only SFX (mirrors UI designer):
 * - Dialog open: BattleCursor_4.wav
 * - Attribute scroll/cycle: BattleCursor_1.wav
 */

(() => {
  const TAG = "[ONI][CheckRoller:Dialog]";
  const MANAGER = globalThis.ONI?.CheckRoller;

  if (!MANAGER || !MANAGER.__isCheckRollerManager) {
    ui?.notifications?.error("Check Roller: Manager not found. Run [CheckRoller] Manager first.");
    console.error(`${TAG} Manager not found at ONI.CheckRoller`);
    return;
  }

  // ---------------------------------------------------------------------------
  // SFX (LOCAL ONLY) — mirrors UI designer
  // ---------------------------------------------------------------------------
  const SFX = {
    open:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    scroll:"https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_1.wav",
    volumeOpen: 0.85,
    volumeScroll: 0.75
  };

  function playLocalSfx(src, volume = 0.8) {
    if (!src) return;

    try {
      if (game?.audio?.play) return game.audio.play(src, { volume });
    } catch (_) {}

    try {
      if (globalThis.AudioHelper?.play) {
        try { return AudioHelper.play({ src, volume, autoplay: true, loop: false }, false); } catch (_) {}
        try { return AudioHelper.play({ src, volume, autoplay: true, loop: false }, { broadcast: false }); } catch (_) {}
        try { return AudioHelper.play({ src, volume, autoplay: true, loop: false }); } catch (_) {}
      }
    } catch (_) {}

    try {
      const a = new Audio(src);
      a.volume = volume;
      a.play();
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const safeStr = (v, fb = "") => (typeof v === "string" ? v : (v == null ? fb : String(v)));
  const safeInt = (v, fb = 0) => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : fb;
  };
  const safeNum = (v, fb = 0) => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : fb;
  };
  const clamp = (n, a, b) => Math.max(a, Math.min(b, safeNum(n, a)));
  const clampInt = (n, a, b) => Math.max(a, Math.min(b, safeInt(n, a)));

      const getDefaultRollerTarget = () => {
    const tok = canvas?.tokens?.controlled?.[0];
    const tokenDoc = tok?.document ?? null;
    const tokenUuid = tokenDoc?.uuid ?? null;
    const tokenActor = tok?.actor ?? null;

    // Prefer Actor portrait (portrait-style), fallback to token texture if needed
    const tokenPortraitUrl =
      tokenActor?.img ??
      tokenDoc?.texture?.src ??
      tok?.texture?.src ??
      "";

    // ✅ GM: MUST use the currently controlled token (no fallback)
    if (game.user.isGM) {
      if (tokenActor && tokenUuid) {
        return {
          actor: tokenActor,
          actorUuid: tokenUuid, // TokenDocument UUID
          actorName: tok?.name ?? tokenActor.name ?? "Token",
          portraitUrl: tokenPortraitUrl
        };
      }
      return null;
    }

    // Player: prefer linked character first
    if (game.user.character) {
      const a = game.user.character;
      return {
        actor: a,
        actorUuid: a.uuid,
        actorName: a.name,
        portraitUrl: a.img ?? ""
      };
    }

    // (Optional) keep your old fallback if you still want it
    if (tokenActor && tokenUuid) {
      return {
        actor: tokenActor,
        actorUuid: tokenUuid,
        actorName: tok?.name ?? tokenActor.name ?? "Token",
        portraitUrl: tokenPortraitUrl
      };
    }

    return null;
  };

  // Try to read die sizes from actor system data in a tolerant way.
  const detectDieSize = (actor, attrKeyUpper) => {
    const fallback = 8;
    if (!actor) return fallback;

    const attrUpper = String(attrKeyUpper || "").toUpperCase();
    const keyLower = attrUpper.toLowerCase();

    const sys = actor.system || actor.data?.data || {};

    // 0) ✅ Your Fabula Ultima keys (highest priority)
    const propsKeyByAttr = {
      DEX: "dex_current",
      MIG: "mig_current",
      INS: "ins_current",
      WLP: "wlp_current"
    };

    const parseDie = (v) => {
      if (v == null) return null;
      if (typeof v === "number") return v;
      const s = String(v).trim().toLowerCase();
      const m = s.match(/d(\d+)/);
      if (m) return parseInt(m[1], 10);
      const n = parseInt(s.replace(/[^\d]/g, ""), 10);
      return Number.isFinite(n) ? n : null;
    };

    const propsKey = propsKeyByAttr[attrUpper];
    if (propsKey) {
      const n = parseDie(sys?.props?.[propsKey]);
      if (Number.isFinite(n) && n >= 4 && n <= 20) return n;
    }

    // Fallback: other possible system layouts (kept for safety)
    const candidates = [];

    // 1) system.attributes.dex.die
    candidates.push(sys?.attributes?.[keyLower]?.die);
    candidates.push(sys?.attributes?.[keyLower]?.dice);
    candidates.push(sys?.attributes?.[keyLower]?.dieSize);
    candidates.push(sys?.attributes?.[keyLower]?.size);

    // 2) system.stats.dex.die
    candidates.push(sys?.stats?.[keyLower]?.die);
    candidates.push(sys?.stats?.[keyLower]?.dice);
    candidates.push(sys?.stats?.[keyLower]?.dieSize);

    // 3) system.characteristics.dex.die
    candidates.push(sys?.characteristics?.[keyLower]?.die);
    candidates.push(sys?.characteristics?.[keyLower]?.dice);

    for (const c of candidates) {
      const n = parseDie(c);
      if (Number.isFinite(n) && n >= 4 && n <= 20) return n;
    }

    return fallback;
  };

  // ---------------------------------------------------------------------------
  // UI (mirrors UIDESIGNER)
  // ---------------------------------------------------------------------------
  const ATTR_ORDER = ["MIG", "DEX", "INS", "WLP"];

  const ATTR_META = {
    DEX: { name: "DEX", icon: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png" },
    MIG: { name: "MIG", icon: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png" },
    INS: { name: "INS", icon: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png" },
    WLP: { name: "WLP", icon: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png" }
  };

  const CHECK_TYPES = [
    { value: "Attribute", label: "Attribute Check" },
    { value: "Accuracy", label: "Accuracy Check" },
    { value: "Magic", label: "Magic Check" },
    { value: "Opposed", label: "Opposed Check" },
    { value: "Open", label: "Open Check (DL Hidden)" }
  ];

  const DEFAULT_TUNING = {
    dialogWidth: 820,
    dialogHeight: 520,

    rootGap: 12,
    rootPadding: 12,

    pickerHeight: 56,
    pickerRadius: 14,
    pickerGap: 12,
    pickerBorderW: 3,

    pickerIconSize: 30,
    pickerNameSize: 14,
    pickerNameWeight: 900,

    pickerDieSize: 13,
    pickerDieOpacity: 0.55,

    arrowSize: 16,
    arrowOpacity: 0.75,
    arrowHitW: 34,

    slidePx: 22,
    animMs: 180,

    // Typography restore (for Modifiers + general)
    baseFontSize: 13,
    inputFontSize: 13,
    modRowInputH: 32,
    modRowPadX: 10
  };

  // Keep tuning local to dialog instance (no shared mutable global)
  const makeTuning = () => {
    try {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(DEFAULT_TUNING);
    } catch (_) {}
    return JSON.parse(JSON.stringify(DEFAULT_TUNING));
  };

  const renderTypeOptions = (selected) =>
    CHECK_TYPES.map(t => `<option value="${t.value}" ${t.value === selected ? "selected" : ""}>${t.label}</option>`).join("");

  const indexOfAttr = (attr) => {
    const a = String(attr || "").toUpperCase();
    const i = ATTR_ORDER.indexOf(a);
    return i >= 0 ? i : 0;
  };

  const cycleAttrBySteps = (attr, steps) => {
    const i = indexOfAttr(attr);
    const len = ATTR_ORDER.length;
    const next = (i + (steps % len) + len) % len;
    return ATTR_ORDER[next];
  };

  function buildContentLayer(attr) {
    const meta = ATTR_META[attr] || { name: String(attr), icon: "" };
    const el = document.createElement("div");
    el.className = "oni-crd-layer";
    el.dataset.layer = "content";
    el.innerHTML = `
      <img class="oni-crd-attrIcon" src="${meta.icon}" alt="${meta.name}">
      <div class="oni-crd-attrName">${meta.name}</div>
    `;
    return el;
  }

  function buildDieLayer(actor, attr) {
    const die = detectDieSize(actor, attr);
    const el = document.createElement("div");
    el.className = "oni-crd-layer oni-crd-dieLayer";
    el.dataset.layer = "die";
    el.textContent = `d${die}`;
    return el;
  }

  function ensureHostHasOneLayer(hostEl, makeLayerFn, arg1, arg2, label) {
    if (!hostEl) return;
    const layers = Array.from(hostEl.querySelectorAll(".oni-crd-layer"));
    if (layers.length === 1) return;

    hostEl.innerHTML = "";
    hostEl.appendChild(makeLayerFn(arg1, arg2));
    console.log(TAG, `[SafetyRebuild] ${label} host reset -> 1 layer`);
  }

  function animateSwap(hostEl, oldLayer, newLayer, dir, tuning) {
    const enterFrom = dir < 0 ? "oni-crd-enter-from-left" : "oni-crd-enter-from-right";
    const exitTo    = dir < 0 ? "oni-crd-exit-to-right"   : "oni-crd-exit-to-left";

    return new Promise((resolve) => {
      newLayer.classList.add(enterFrom);
      hostEl.appendChild(newLayer);

      // Force reflow
      newLayer.offsetHeight;

      requestAnimationFrame(() => {
        newLayer.classList.remove(enterFrom);
        oldLayer.classList.add(exitTo);
      });

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;

        const layers = Array.from(hostEl.querySelectorAll(".oni-crd-layer"));
        for (const el of layers) {
          if (el !== newLayer) el.remove();
        }

        newLayer.classList.remove(
          "oni-crd-enter-from-left",
          "oni-crd-enter-from-right",
          "oni-crd-exit-to-left",
          "oni-crd-exit-to-right"
        );

        resolve();
      };

      const onEnd = (ev) => {
        if (ev.propertyName !== "transform" && ev.propertyName !== "opacity") return;
        newLayer.removeEventListener("transitionend", onEnd);
        finish();
      };
      newLayer.addEventListener("transitionend", onEnd);

      setTimeout(finish, Math.max(60, Number(tuning.animMs) + 120));
    });
  }

  function renderAttrPicker(slot, state, actor) {
    const attr = slot === "A" ? state.attrA : state.attrB;
    const meta = ATTR_META[attr] || { name: String(attr), icon: "" };
    const die = detectDieSize(actor, attr);

    return `
      <div class="oni-crd-picker" data-slot="${slot}" data-attr="${attr}">
        <button type="button" class="oni-crd-arrow" data-dir="-1" aria-label="Previous Attribute">
          <span class="oni-crd-arrowGlyph">◀</span>
        </button>

        <button type="button" class="oni-crd-midBtn" aria-label="Cycle Attribute">
          <div class="oni-crd-midGrid">
            <div class="oni-crd-contentHost" data-host="content">
              <div class="oni-crd-layer" data-layer="content">
                <img class="oni-crd-attrIcon" src="${meta.icon}" alt="${meta.name}">
                <div class="oni-crd-attrName">${meta.name}</div>
              </div>
            </div>

            <div class="oni-crd-dieHost" data-host="die">
              <div class="oni-crd-layer oni-crd-dieLayer" data-layer="die">d${die}</div>
            </div>
          </div>
        </button>

        <button type="button" class="oni-crd-arrow" data-dir="1" aria-label="Next Attribute">
          <span class="oni-crd-arrowGlyph">▶</span>
        </button>
      </div>
    `;
  }

  function renderModRowHtml(idx, label, value) {
    const safeLabel = String(label ?? "");
    const safeValue = Number.isFinite(+value) ? +value : 0;
    return `
      <div class="oni-crd-modRow" data-idx="${idx}">
        <input type="text" class="oni-crd-input oni-crd-modLabel" name="modLabel_${idx}" value="${safeLabel}" placeholder="Source (e.g., Buff: Inspired)" />
        <input type="number" class="oni-crd-input oni-crd-modValue" name="modValue_${idx}" value="${safeValue}" />
        <button type="button" class="oni-crd-smallBtn oni-crd-mod-remove" data-idx="${idx}" title="Remove">✕</button>
      </div>
    `;
  }

function getCss(tuning) {
  return `
    .oni-crd-root{
      --crd-dialogW: ${tuning.dialogWidth}px;
      --crd-gap: ${tuning.rootGap}px;
      --crd-pad: ${tuning.rootPadding}px;

      --crd-pickerH: ${tuning.pickerHeight}px;
      --crd-pickerR: ${tuning.pickerRadius}px;
      --crd-pickerGap: ${tuning.pickerGap}px;
      --crd-pickerBW: ${tuning.pickerBorderW}px;

      --crd-icon: ${tuning.pickerIconSize}px;
      --crd-nameFS: ${tuning.pickerNameSize}px;
      --crd-nameW: ${tuning.pickerNameWeight};
      --crd-dieFS: ${tuning.pickerDieSize}px;
      --crd-dieOp: ${tuning.pickerDieOpacity};

      --crd-arrowFS: ${tuning.arrowSize}px;
      --crd-arrowOp: ${tuning.arrowOpacity};
      --crd-arrowHitW: ${tuning.arrowHitW}px;

      --crd-slide: ${tuning.slidePx}px;
      --crd-animMs: ${tuning.animMs}ms;

      --crd-baseFS: ${tuning.baseFontSize}px;
      --crd-inputFS: ${tuning.inputFontSize}px;
      --crd-modH: ${tuning.modRowInputH}px;
      --crd-modPX: ${tuning.modRowPadX}px;

      --parch-1: #fff3dc;
      --parch-2: #f3e2bd;
      --parch-3: #e8cea0;
      --ink: #2b1f17;
      --edge: rgba(87,58,33,.95);
      --gold: #FFBB55;
      --gold-soft: rgba(255,187,85,.25);
    }

    .oni-crd-root{ font-size: var(--crd-baseFS); }

    .oni-crd-shell{
      display:flex; gap: var(--crd-gap); padding: var(--crd-pad);
      box-sizing: border-box;
      align-items:flex-start;
    }

    /* Let content define height (no reserved empty area) */
    .oni-crd-preview{ flex: 1; min-width: 320px; }

    .oni-crd-pickersRow{ display:grid; grid-template-columns: 1fr 1fr; gap: var(--crd-pickerGap); margin-bottom: 10px; }

    .oni-crd-picker{
      display:grid;
      grid-template-columns: var(--crd-arrowHitW) 1fr var(--crd-arrowHitW);
      align-items:center;
      height: var(--crd-pickerH);
      border-radius: var(--crd-pickerR);
      border: var(--crd-pickerBW) solid var(--edge);
      background:
        radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.55) 0%, rgba(255,255,255,.20) 22%, transparent 40%),
        linear-gradient(180deg, var(--parch-1) 0%, var(--parch-2) 55%, var(--parch-3) 100%);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,.70),
        inset 0 0 0 2px rgba(255,255,255,.10),
        0 6px 14px rgba(0,0,0,.10);
      overflow:hidden; user-select:none;
    }

    .oni-crd-picker:focus-within{
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,.70),
        inset 0 0 0 2px rgba(255,255,255,.12),
        0 6px 14px rgba(0,0,0,.12),
        0 0 0 3px var(--gold-soft);
      border-color: var(--gold);
    }

    .oni-crd-arrow{
      height:100%; width:100%; border:none; background:transparent; cursor:pointer;
      opacity: var(--crd-arrowOp); display:flex; align-items:center; justify-content:center;
      padding:0;
    }
    .oni-crd-arrowGlyph{ font-size: var(--crd-arrowFS); line-height:1; color: var(--ink); }

    .oni-crd-midBtn{
      height:100%; width:100%;
      border:none; background:transparent; cursor:pointer;
      padding: 6px 10px; box-sizing:border-box;
    }

    .oni-crd-midGrid{
      height:100%;
      display:grid;
      grid-template-columns: 1fr auto;
      align-items:center;
      column-gap: 10px;
      min-width:0;
    }

    .oni-crd-contentHost{
  position:relative;
  height:100%;
  overflow:hidden;
  min-width:0;
  display:flex;
  align-items:center;
  justify-content:center;
}

.oni-crd-dieHost{
  position:relative;
  height:100%;
  overflow:hidden;

  /* ✅ reserve space so the "auto" column doesn't collapse */
  min-width: 52px;

  display:flex;
  align-items:center;
  justify-content:flex-end;
}

    .oni-crd-layer{
      position:absolute; inset:0;
      display:flex; align-items:center; justify-content:center;
      gap: 10px;
      opacity: 1;
      transform: translateX(0);
      will-change: transform, opacity;
      transition:
        transform var(--crd-animMs) cubic-bezier(.22,.90,.25,1.00),
        opacity   var(--crd-animMs) cubic-bezier(.22,.90,.25,1.00);
    }

    .oni-crd-attrIcon{
      width: var(--crd-icon); height: var(--crd-icon);
      object-fit: contain;
      border:0 !important; outline:none !important; box-shadow:none !important;
      background:transparent !important;
      flex: 0 0 auto;
    }

    .oni-crd-attrName{
      font-size: var(--crd-nameFS);
      font-weight: var(--crd-nameW);
      color: var(--ink);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 2.5em;
    }

    .oni-crd-dieLayer{
      justify-content:flex-end;
      padding-right: 2px;
      font-size: var(--crd-dieFS);
      font-style: italic;
      opacity: var(--crd-dieOp);
      color: var(--ink);
    }

    .oni-crd-enter-from-left { transform: translateX(calc(var(--crd-slide) * -1)); opacity: 0; }
    .oni-crd-enter-from-right{ transform: translateX(var(--crd-slide)); opacity: 0; }
    .oni-crd-exit-to-left { transform: translateX(calc(var(--crd-slide) * -1)); opacity: 0; }
    .oni-crd-exit-to-right{ transform: translateX(var(--crd-slide)); opacity: 0; }

    /* Advanced minimal */
    .oni-crd-adv{ margin-top: 6px; border-radius: 12px; overflow:hidden; background: rgba(0,0,0,0.06); }
    .oni-crd-advSummary{
      height: 32px; display:flex; align-items:center; justify-content:space-between;
      cursor:pointer; padding: 0 10px; user-select:none; font-weight: 900;
    }
    .oni-crd-advSummary::-webkit-details-marker{ display:none; }
    .oni-crd-advHint{ opacity:.65; font-weight:700; }
    .oni-crd-advBody{ padding: 10px; display:flex; flex-direction:column; gap: 10px; }
    .oni-crd-uuid{ opacity:.65; margin-left: 6px; font-size: 12px; }

    .oni-crd-kv{ margin: 2px 0; }
    .oni-crd-dim{ opacity: .7; }

    .oni-crd-advGrid{ display:grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .oni-crd-field{ display:flex; flex-direction:column; gap: 6px; }

    /* Inputs font restored */
    .oni-crd-input{
      height: 30px;
      padding: 0 8px;
      box-sizing: border-box;
      font-size: var(--crd-inputFS);
    }

    .oni-crd-dlLabel{
      height:30px; display:flex; align-items:center; padding: 0 10px;
      border-radius:8px; background: rgba(255,255,255,.55);
      border: 1px solid rgba(90,70,55,.45);
      font-weight: 800;
      font-size: var(--crd-inputFS);
    }
    .oni-crd-helpText{ opacity: 0.7; font-size: 12px; }

    /* Modifiers restored look + anti-squash fix */
    .oni-crd-modHeader{ display:flex; justify-content:space-between; align-items:center; gap: 10px; }

    .oni-crd-modRow{
      display:flex;
      gap: 8px;
      align-items:center;
      margin: 6px 0;
      flex-wrap: nowrap;
    }

    .oni-crd-modLabel{
      flex: 1 1 auto;
      min-width: 240px;
      height: var(--crd-modH);
      padding: 0 var(--crd-modPX);
      font-size: var(--crd-inputFS);
      box-sizing: border-box;
    }

    .oni-crd-modValue{
      flex: 0 0 90px;
      width: 90px;
      min-width: 90px;
      height: var(--crd-modH);
      padding: 0 var(--crd-modPX);
      font-size: var(--crd-inputFS);
      box-sizing: border-box;
    }

    .oni-crd-mod-remove{
      flex: 0 0 44px;
      width: 44px;
      min-width: 44px;
    }

        .oni-crd-smallBtn{
      height: 28px;
      padding: 0 10px;
      border-radius: 8px;
      cursor:pointer;
      font-weight: 800;
      font-size: var(--crd-inputFS);
    }

    /* ---------------------------
     * Dialog footer safeguard:
     * prevent Roll/Cancel from stretching
     * --------------------------- */
    .oni-crd-dialog .dialog-buttons{
      flex: 0 0 auto !important;
      align-items: center !important;
    }

    .oni-crd-dialog .dialog-buttons button{
      height: 52px !important;
    }
    `;
  }

  // Mod list helpers (mirrors designer)
  const reindexModRows = (html) => {
    const rows = html.find(".oni-crd-modRow");
    rows.each((i, el) => {
      el.dataset.idx = String(i);
      const $el = $(el);
      $el.find(".oni-crd-mod-remove").attr("data-idx", String(i));
      $el.find(".oni-crd-modLabel").attr("name", `modLabel_${i}`);
      $el.find(".oni-crd-modValue").attr("name", `modValue_${i}`);
    });
  };

  const addModRow = (html) => {
    const list = html.find(".oni-crd-modList");
    const idx = list.find(".oni-crd-modRow").length;
    list.append(renderModRowHtml(idx, "", 0));
    reindexModRows(html);
  };

  const removeModRow = (html, idx) => {
    const row = html.find(`.oni-crd-modRow[data-idx="${idx}"]`);
    row.remove();
    if (html.find(".oni-crd-modRow").length < 1) addModRow(html);
    reindexModRows(html);
  };

  // ---------------------------------------------------------------------------
  // Register Adapter: openDialog
  // ---------------------------------------------------------------------------
  MANAGER.registerAdapter("openDialog", async (context = {}) => {
    if (MANAGER.isRunning()) {
      ui?.notifications?.warn("Check Roller is already running. Finish the current check first.");
      return null;
    }

        const target = getDefaultRollerTarget();
    const actor = target?.actor || null;

    if (!actor) {
      if (game.user.isGM) {
        ui?.notifications?.warn("Check Roller (GM): Please select a token first.");
      } else {
        ui?.notifications?.warn("Check Roller: No linked actor (and no controlled token).");
      }
      return null;
    }

    const ACTOR_UUID = target.actorUuid;
    const ACTOR_NAME = target.actorName;
    const PORTRAIT_URL = safeStr(target.portraitUrl, "");

    // Presets (optional)
    const presetVisibility = safeStr(context?.visibility, "all");
    const presetDlVisibility = safeStr(context?.dlVisibility, "hidden");

    const presetDlRaw = context?.dl;
    const presetDl = Number.isFinite(Number(presetDlRaw)) ? safeInt(presetDlRaw, 0) : null;
    const dlLabelText = (presetDl == null) ? "—" : String(presetDl);

    // State
    const state = {
      attrA: "DEX",
      attrB: "MIG",
      checkType: "Attribute"
    };

    // Attribute change queues (mirrors designer)
    const slotCtl = {
      A: { busy: false, pendingSteps: 0 },
      B: { busy: false, pendingSteps: 0 }
    };

    // Dialog open SFX guard (per dialog)
    let openSfxPlayed = false;

    const tuning = makeTuning();

    const renderHtml = () => `
      <div class="oni-crd-root">
        <style id="oni-crd-style">${getCss(tuning)}</style>

        <div class="oni-crd-shell">
          <div class="oni-crd-preview">
            <div class="oni-crd-previewFrame">

              <div class="oni-crd-pickersRow">
                ${renderAttrPicker("A", state, actor)}
                ${renderAttrPicker("B", state, actor)}
              </div>

              <details class="oni-crd-adv" data-adv>
                <summary class="oni-crd-advSummary">
                  <span class="oni-crd-advTitle">Advanced</span>
                  <span class="oni-crd-advHint">(click to expand)</span>
                </summary>

                <div class="oni-crd-advBody">

                  <div class="oni-crd-advBlock">
                    <div class="oni-crd-kv"><b>Roller</b>: <span>${safeStr(game.user.name)}</span></div>
                                        <div class="oni-crd-kv">
                      <b>Actor</b>: <span>${safeStr(ACTOR_NAME)}</span>
                      <span class="oni-crd-uuid">(${safeStr(ACTOR_UUID)})</span>
                    </div>
                  </div>

                  <div class="oni-crd-advGrid">
                    <div class="oni-crd-field">
                      <label class="oni-crd-label"><b>Check Type</b></label>
                      <select name="checkType" class="oni-crd-input">
                        ${renderTypeOptions(state.checkType)}
                      </select>
                    </div>

                    <div class="oni-crd-field">
                      <label class="oni-crd-label"><b>DL (GM-set)</b></label>
                      <div class="oni-crd-dlLabel" data-dlLabel>${dlLabelText}</div>
                      <div class="oni-crd-helpText">This is a label (not editable). A GM tool/script sets it.</div>
                      <input type="hidden" name="dl" value="${presetDl == null ? "" : presetDl}">
                      <input type="hidden" name="dlHidden" value="${presetDlVisibility === "shown" ? "0" : "1"}">
                    </div>
                  </div>

                  <div class="oni-crd-modWrap">
                    <div class="oni-crd-modHeader">
                      <label class="oni-crd-label"><b>Modifiers</b> <span class="oni-crd-dim">(sources)</span></label>
                      <button type="button" class="oni-crd-smallBtn oni-crd-mod-add">+ Add</button>
                    </div>

                    <div class="oni-crd-modList">
                      ${renderModRowHtml(0, "", 0)}
                      ${renderModRowHtml(1, "", 0)}
                    </div>

                    <div class="oni-crd-helpText">Tip: Use short labels. These are additive modifiers.</div>
                  </div>

                </div>
              </details>

            </div>
          </div>
        </div>
      </div>
    `;

    // Queued attribute change (mirrors designer)
    async function runAttrChangeQueued(html, slot, steps) {
      const ctl = slotCtl[slot];
      if (!ctl) return;

      const picker = html.find(`.oni-crd-picker[data-slot="${slot}"]`)[0];
      if (!picker) return;

      if (ctl.busy) {
        ctl.pendingSteps += steps;
        ctl.pendingSteps = Math.max(-20, Math.min(20, ctl.pendingSteps));
        return;
      }

      if (steps !== 0) playLocalSfx(SFX.scroll, SFX.volumeScroll);

      ctl.busy = true;
      const dir = steps === 0 ? 0 : Math.sign(steps);

      const curAttr = String(picker.dataset.attr || "").toUpperCase() || (slot === "A" ? state.attrA : state.attrB);
      const ch = picker.querySelector('[data-host="content"]');
      const dh = picker.querySelector('[data-host="die"]');

      ensureHostHasOneLayer(ch, (a) => buildContentLayer(a), curAttr, null, `slot=${slot} content (pre)`);
      ensureHostHasOneLayer(dh, (a) => buildDieLayer(actor, a), curAttr, null, `slot=${slot} die (pre)`);

      const nextAttr = cycleAttrBySteps(curAttr, steps);

      if (slot === "A") state.attrA = nextAttr;
      else state.attrB = nextAttr;
      picker.dataset.attr = nextAttr;

      const oldContent = ch.querySelector(".oni-crd-layer");
      const oldDie = dh.querySelector(".oni-crd-layer");
      const newContent = buildContentLayer(nextAttr);
      const newDie = buildDieLayer(actor, nextAttr);

      try {
        await Promise.all([
          animateSwap(ch, oldContent, newContent, dir, tuning),
          animateSwap(dh, oldDie, newDie, dir, tuning)
        ]);
      } catch (e) {
        console.warn(`${TAG} [AnimError] slot=${slot}`, e);
      }

      ensureHostHasOneLayer(ch, (a) => buildContentLayer(a), nextAttr, null, `slot=${slot} content (post)`);
      ensureHostHasOneLayer(dh, (a) => buildDieLayer(actor, a), nextAttr, null, `slot=${slot} die (post)`);

      ctl.busy = false;

      const pending = ctl.pendingSteps;
      ctl.pendingSteps = 0;

      if (pending !== 0) runAttrChangeQueued(html, slot, pending);
    }

    // Build Dialog
    return await new Promise((resolve) => {
      const d = new Dialog({
        title: "Check Roller",
        content: renderHtml(),
        buttons: {
          roll: {
            icon: '<i class="fas fa-dice"></i>',
            label: "Roll",
            callback: (html) => {
              // Read check type (in Advanced)
              const checkType = safeStr(html.find(`[name="checkType"]`).val(), state.checkType);

              // Attributes chosen by picker state
              const attrA = safeStr(state.attrA, "DEX").toUpperCase();
              const attrB = safeStr(state.attrB, "MIG").toUpperCase();

              // Dice are derived from actor stats (consistent with attribute picker)
              const dieA = clampInt(detectDieSize(actor, attrA), 4, 20);
              const dieB = clampInt(detectDieSize(actor, attrB), 4, 20);

              // (optional but nice) keep the UI fields in sync at the moment of roll
              html.find(`[name="dieA"]`).val(dieA);
              html.find(`[name="dieB"]`).val(dieB);

              // DL (optional preset)
              const dlRaw = html.find(`[name="dl"]`).val();
              const dl = (dlRaw === "" || dlRaw == null) ? null : safeInt(dlRaw, 0);

              // dlHidden is represented by dlVisibility; default hidden unless context says shown
              const dlHidden = (checkType === "Open") ? true : (presetDlVisibility !== "shown");

              // Modifiers
              const parts = [];
              const rows = html.find(".oni-crd-modRow");
              rows.each((i, el) => {
                const $row = $(el);
                const label = safeStr($row.find(".oni-crd-modLabel").val(), "").trim();
                const value = safeInt($row.find(".oni-crd-modValue").val(), 0);
                if (label.length || value !== 0) {
                  parts.push({ label: label.length ? label : "Modifier", value });
                }
              });
              const total = parts.reduce((a, b) => a + safeInt(b.value, 0), 0);

              // Build payload (same structure as old dialog)
                const payload = {
                kind: "fu_check",
                meta: {
                  userId: game.user.id,
                  userName: game.user.name,
                  actorUuid: ACTOR_UUID,
                  actorName: ACTOR_NAME,
                  visibility: presetVisibility,
                  dlVisibility: dlHidden ? "hidden" : "shown",
                  invoked: { trait: false, bond: false },

                  // ✅ Override the Manager default (Cherry) with the real roller portrait
                  ui: {
                    tuning: {
                      portraitUrl: PORTRAIT_URL
                    }
                  }
                },
                check: {
                  type: checkType,
                  attrs: [attrA, attrB],
                  dice: { A: dieA, B: dieB },
                  modifier: { total, parts }
                }
              };

              if (dl != null) payload.check.dl = dl;

              console.log(`${TAG} Payload built:`, payload);
              resolve(payload);
            }
          },
          cancel: {
            icon: '<i class="fas fa-times"></i>',
            label: "Cancel",
            callback: () => resolve(null)
          }
        },
        default: "roll",
        close: () => resolve(null),
        render: (html) => {
         // Width only (height will auto-fit)
const w = clamp(tuning.dialogWidth, 520, 1400);
d.setPosition({ width: w });

try { d.element?.addClass?.("oni-crd-dialog"); } catch (_) {}

// Advanced starts collapsed
const adv = html.find("[data-adv]")[0];
if (adv) adv.open = false;

// Auto-fit height to content, and refit when Advanced expands/collapses
const fitHeight = () => {
  const $win = d.element;
  if (!$win?.length) return;

  const headerH = $win.find(".window-header").outerHeight(true) ?? 0;

  // Measure OUR content (not Foundry's ".window-content")
  const rootEl = html.find(".oni-crd-root")[0];
  const bodyH = rootEl ? (rootEl.scrollHeight ?? rootEl.offsetHeight ?? 0) : 0;

  // Footer (Roll / Cancel row)
  const footerH = $win.find(".dialog-buttons").outerHeight(true) ?? 0;

  const paddingFudge = 18;
  const minH = 220;
  const maxH = clamp(tuning.dialogHeight, 380, 1100);

  const targetH = headerH + bodyH + footerH + paddingFudge;
  d.setPosition({ height: clamp(targetH, minH, maxH) });
};

// Fit once after the dialog finishes rendering layout
setTimeout(() => {
  fitHeight();
  setTimeout(fitHeight, 60);
  setTimeout(fitHeight, 180);
}, 0);

if (adv) {
  adv.addEventListener("toggle", () => {
    setTimeout(fitHeight, 0);
    setTimeout(fitHeight, 60);
    setTimeout(fitHeight, 180);
  });
}

          // Play open SFX once (local only)
          if (!openSfxPlayed) {
            openSfxPlayed = true;
            playLocalSfx(SFX.open, SFX.volumeOpen);
          }

          // Modifiers add/remove
          html.on("click", ".oni-crd-mod-add", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            addModRow(html);
          });

          html.on("click", ".oni-crd-mod-remove", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const idx = Number(ev.currentTarget?.dataset?.idx ?? -1);
            if (!Number.isFinite(idx) || idx < 0) return;
            removeModRow(html, idx);
          });

          // Check type change updates state (so we can default even if Advanced collapsed)
          html.on("change", `[name="checkType"]`, () => {
            state.checkType = safeStr(html.find(`[name="checkType"]`).val(), state.checkType);
          });

          // Arrow click
          html.on("click", ".oni-crd-picker .oni-crd-arrow", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const picker = ev.currentTarget.closest(".oni-crd-picker");
            const slot = picker?.dataset?.slot;
            const dir = Number(ev.currentTarget?.dataset?.dir ?? 0);
            if (!slot || !Number.isFinite(dir) || !dir) return;
            runAttrChangeQueued(html, slot, dir);
          });

          // Mid click cycles forward (+1)
          html.on("click", ".oni-crd-picker .oni-crd-midBtn", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const picker = ev.currentTarget.closest(".oni-crd-picker");
            const slot = picker?.dataset?.slot;
            if (!slot) return;
            runAttrChangeQueued(html, slot, 1);
          });

          // Wheel: native event with passive:false
          const pickers = html.find(".oni-crd-picker").toArray();
          for (const el of pickers) {
            el.addEventListener("wheel", (e) => {
              e.preventDefault();
              e.stopPropagation();

              const slot = el?.dataset?.slot;
              const dy = e.deltaY ?? 0;
              const dir = dy > 0 ? 1 : -1;

              if (!slot) return;
              runAttrChangeQueued(html, slot, dir);
            }, { passive: false });
          }

          // Initial reindex for mod rows
          reindexModRows(html);
        }
     }, {
  width: tuning.dialogWidth,
  resizable: true
});

      d.render(true);
    });
  });
  console.log(`${TAG} Adapter installed: openDialog (New UI integrated)`);
})();
