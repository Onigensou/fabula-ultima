/**
 * [CheckRoller] CreateCard — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * UPDATED (UI Integration):
 * - Mirrors ONI CheckRoller UI Tester card layout + behavior styling.
 * - Uses real payload data (attrs, dice sizes, results, modifiers, DL visibility).
 * - Provides Invoke buttons compatible with CardHydrate.
 *
 * Install order:
 * 1) [CheckRoller] Manager
 * 2) [CheckRoller] CreateCard
 * 3) [CheckRoller] CardHydrate
 */

(() => {
  const TAG = "[ONI][CheckRoller:CreateCard]";
  const MANAGER = globalThis.ONI?.CheckRoller;

  if (!MANAGER || !MANAGER.__isCheckRollerManager) {
    ui?.notifications?.error("Check Roller: Manager not found. Run [CheckRoller] Manager first.");
    console.error(`${TAG} Manager not found at ONI.CheckRoller`);
    return;
  }

  const { CONST } = MANAGER;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const safeStr = (v, fb = "") => (typeof v === "string" ? v : (v == null ? fb : String(v)));
  const safeInt = (v, fb = 0) => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : fb;
  };

  const esc = (s) => {
    const str = safeStr(s, "");
    return str
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  };

  const fmtSigned = (n) => {
    const v = safeInt(n, 0);
    return v >= 0 ? `+${v}` : `${v}`;
  };

  const sumParts = (parts) => {
    if (!Array.isArray(parts)) return 0;
    return parts.reduce((a, p) => a + safeInt(p?.value, 0), 0);
  };

  const encTip = (html) => encodeURIComponent(String(html ?? ""));

  const pickIconForAttr = (attr) => {
    const a = safeStr(attr, "").toUpperCase();
    const icons = CONST?.ICONS || {};
    return icons[a] || icons.WLP || icons.DEX || "";
  };

  // ---------------------------------------------------------------------------
  // UI defaults (mirrors Tester script)
  // ---------------------------------------------------------------------------
  const UI_DEFAULT = CONST?.DEFAULTS?.UI_TUNING || {
    portraitUrl: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Character/Cherry/Cherry_Portrait.png",
    portraitSize: 76,
    portraitX: 0,
    portraitY: 0,

    checkText: "Check",
    checkSize: 20,
    checkX: 70,
    checkY: -14,

    checkStrokeSize: 5,
    checkStrokeColor: "#f7ecd9",

    dieIconSize: 24,
    dieValueSize: 14,

    totalRollMs: 1500,
    totalFontSize: 21,

    rollSfxUrl: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dice.wav",
    rollSfxVolume: 0.8,
    rollSfxEnabled: true
  };

  const mergeTuning = (t) => {
    const o = (t && typeof t === "object") ? t : {};
    return {
      portraitUrl: safeStr(o.portraitUrl, UI_DEFAULT.portraitUrl),
      portraitSize: safeInt(o.portraitSize, UI_DEFAULT.portraitSize),
      portraitX: safeInt(o.portraitX, UI_DEFAULT.portraitX),
      portraitY: safeInt(o.portraitY, UI_DEFAULT.portraitY),

      checkText: safeStr(o.checkText, UI_DEFAULT.checkText),
      checkSize: safeInt(o.checkSize, UI_DEFAULT.checkSize),
      checkX: safeInt(o.checkX, UI_DEFAULT.checkX),
      checkY: safeInt(o.checkY, UI_DEFAULT.checkY),

      checkStrokeSize: safeInt(o.checkStrokeSize, UI_DEFAULT.checkStrokeSize),
      checkStrokeColor: safeStr(o.checkStrokeColor, UI_DEFAULT.checkStrokeColor),

      dieIconSize: safeInt(o.dieIconSize, UI_DEFAULT.dieIconSize),
      dieValueSize: safeInt(o.dieValueSize, UI_DEFAULT.dieValueSize),

      totalRollMs: safeInt(o.totalRollMs, UI_DEFAULT.totalRollMs),
      totalFontSize: safeInt(o.totalFontSize, UI_DEFAULT.totalFontSize),

      rollSfxUrl: safeStr(o.rollSfxUrl, UI_DEFAULT.rollSfxUrl),
      rollSfxVolume: Math.max(0, Math.min(1, Number(o.rollSfxVolume ?? UI_DEFAULT.rollSfxVolume))),
      rollSfxEnabled: (typeof o.rollSfxEnabled === "boolean") ? o.rollSfxEnabled : UI_DEFAULT.rollSfxEnabled
    };
  };

  // ---------------------------------------------------------------------------
  // Style injection (idempotent) — mirrors UI TESTER CSS
  // ---------------------------------------------------------------------------
  const STYLE_ID = "oni-cr-chatcard-style-v2";
  const ensureStyle = () => {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }

    style.textContent = `
      .oni-cr-card { font-family: Signika, sans-serif; letter-spacing: .2px; }

      .oni-cr-shell{
        border:1px solid #cfa057; background:#faf3e4; border-radius:10px;
        padding:.55rem .65rem; position:relative; overflow:visible; cursor:pointer;
        container-type:inline-size;
      }

      .oni-cr-portrait{
        position:absolute;
        left: calc(var(--cr-portrait-x) * 1px);
        top:  calc(var(--cr-portrait-y) * 1px);
        width: calc(var(--cr-portrait-size) * 1px);
        height: calc(var(--cr-portrait-size) * 1px);
        object-fit: contain;
        background: transparent !important;
        border: none !important;
        outline: none !important;
        box-shadow: none !important;
        pointer-events:none;
        z-index: 10;
      }

      .oni-cr-panel{
        position: relative;
        border:1px solid #cfa057; border-radius:10px;
        padding:.45rem .5rem;
        background:rgba(255,255,255,.18);
        overflow: visible;
        padding-left: calc(.5rem + (var(--cr-portrait-size) * 1px) - 28px);
      }

      .oni-cr-row{
        display:grid;
        grid-template-columns: 1fr auto;
        align-items:center;
        gap:.6rem;
        min-height:44px;
        position: relative;
        z-index: 2;
      }

      .oni-cr-left{
        display:flex; align-items:center; gap:.45rem;
        min-width:0; overflow:hidden;
        justify-content:center;
      }

      .oni-cr-plus{ font-weight:900; color:#8a4b22; opacity:.9; }

      .oni-cr-die{
        display:inline-flex; align-items:center; gap:.35rem;
        padding:0; border:none; background:transparent;
      }

      .oni-cr-attrImg{
        width: calc(var(--cr-die-icon, 24) * 1px);
        height: calc(var(--cr-die-icon, 24) * 1px);
        display:block;
        border:none !important; outline:none !important; box-shadow:none !important;
        background:transparent !important; border-radius:0 !important;
        object-fit:contain;
      }

      .oni-cr-rollVal{
        font-weight:900;
        font-size: calc(var(--cr-die-val, 14) * 1px);
        color:#2a2a2a;
        min-width:16px;
        text-align:right;
      }

      .oni-cr-right{
        border-left:1px solid rgba(207,160,87,.65);
        padding-left:.6rem;
        min-width:54px;
        display:grid; place-items:center;
      }

      .oni-cr-totalBig{
        font-weight:900;
        font-size: calc(var(--cr-total-font, 18) * 1px);
        color:#8a4b22;
        line-height:1;
      }

      .oni-cr-dl-float{
        position:absolute;
        right:-6px;
        bottom:-10px;
        z-index:6;
        display:inline-flex; align-items:baseline; gap:.3rem;
        padding:.1rem .45rem;
        font-weight:800;
        font-size:11px;
        letter-spacing:.2px;
        border-radius:999px;
        background:#f7ecd9;
        color:#8a4b22;
        border:1px solid #cfa057;
        box-shadow:0 2px 6px rgba(0,0,0,.14),0 1px 0 rgba(255,255,255,.6) inset;
        white-space:nowrap;
        pointer-events:auto;
      }

      .oni-cr-checkLabel{
        position:absolute;
        left: calc(var(--cr-check-x) * 1px);
        top:  calc(var(--cr-check-y) * 1px);
        z-index:7;
        background:transparent !important;
        border:none !important;
        box-shadow:none !important;
        padding:0 !important;
        font-size: calc(var(--cr-check-size) * 1px);
        font-weight: 900;
        font-style: italic;
        letter-spacing:.4px;
        color:#8a4b22;
        -webkit-text-stroke: calc(var(--cr-check-stroke, 2) * 1px) var(--cr-check-stroke-color, #f7ecd9);
        paint-order: stroke fill;
        text-shadow: 0 1px 0 rgba(0,0,0,.25);
        pointer-events:none;
      }

            .oni-cr-critBadge{
        position:absolute;
        top:-10px;
        right:14px;
        padding:2px 10px;
        border-radius:999px;
        font-size:11px;
        font-weight:900;
        letter-spacing:.10em;
        text-transform:uppercase;
        border:1px solid rgba(0,0,0,.25);
        box-shadow:0 2px 10px rgba(0,0,0,.35);
        z-index:60;
        pointer-events:none;
        user-select:none;
      }
      .oni-cr-critBadge--crit{
        background:#f2d36b;
        color:#2b1f0a;
      }
      .oni-cr-critBadge--fumble{
        background:#d05050;
        color:#ffffff;
      }

      .oni-cr-buttons{
        margin-top: .85rem;
        display:grid; grid-template-columns:1fr; gap:.5rem;
      }
      .oni-cr-btn{
        border:1px solid #cfa057 !important;
        border-radius:10px !important;
        background:rgba(247,236,217,0.9) !important;
        color:#8a4b22 !important;
        font-weight:800 !important;
        cursor:pointer !important;
        position:relative !important;
        overflow:hidden !important;
        min-height:38px;
      }

      .oni-cr-btn-label{
        position:relative;
        z-index:1;
      }

      .oni-cr-btn-locked{
        cursor:not-allowed !important;
        border-color:#080808 !important;
        background:linear-gradient(180deg, #2a2a2a 0%, #141414 100%) !important;
        color:#d8d8d8 !important;
        filter:grayscale(1) saturate(.15) !important;
        box-shadow:
          inset 0 0 0 1px rgba(255,255,255,.06),
          inset 0 2px 4px rgba(255,255,255,.04),
          inset 0 -3px 8px rgba(0,0,0,.55),
          0 1px 2px rgba(0,0,0,.35) !important;
      }

      .oni-cr-btn-locked .oni-cr-btn-label{
        visibility:hidden;
      }

      .oni-cr-lock-overlay{
        position:absolute;
        inset:0;
        display:flex;
        align-items:center;
        justify-content:center;
        background:rgba(0,0,0,.48);
        color:#f2f2f2;
        font-size:16px;
        text-shadow:0 1px 3px rgba(0,0,0,.75);
        pointer-events:none;
        z-index:2;
      }

      .oni-cr-details{
        max-height:0;
        overflow:hidden;
        transition:max-height .22s ease, padding .22s ease;
        padding:0 .25rem;
        cursor:default;
      }
      .oni-cr-sep{
        border-top:1px dashed #cfa057;
        opacity:.6;
        margin:.55rem 0 .45rem;
      }
      .oni-cr-details-title{
        display:flex;
        justify-content:center;
        margin:.05rem 0 .35rem;
      }
      .oni-cr-details-title span{
        font-weight:900;
        font-size:18px;
        color:#8a4b22;
        letter-spacing:.4px;
        padding-bottom:.1rem;
        border-bottom:2px solid #cfa057;
      }
      .oni-cr-details-sub{
        text-align:center;
        font-size:12px;
        color:#6b3e1e;
        opacity:.92;
        margin-bottom:.35rem;
      }
      .oni-cr-grid{
        display:grid;
        grid-template-columns:140px 1fr;
        gap:.25rem .6rem;
        font-size:13px;
      }
      .oni-cr-k{ opacity:.8; }
      .oni-cr-v b{ font-weight:900; }
    `;
  };

  // ---------------------------------------------------------------------------
  // IMPORTANT (Multi-client parity)
  // - The card is posted as HTML, but the CSS lives in the client <head>.
  // - Without injecting this CSS on EVERY client, non-rollers (and often GM)
  //   will see an "unstyled" / wrong-looking card until they roll once.
  // - We expose + eagerly inject the style at install time to fix that.
  // ---------------------------------------------------------------------------
  MANAGER.__ensureCheckRollerCardStyle = ensureStyle;
  try { ensureStyle(); } catch (e) { console.warn(`${TAG} ensureStyle (startup) failed:`, e); }

  // ---------------------------------------------------------------------------
  // Build Card HTML (mirrors UI TESTER structure, but with real payload data)
  // ---------------------------------------------------------------------------
  const buildCardHtml = (payload) => {
    payload.meta = payload.meta || {};

    const meta = payload.meta;
    const check = payload?.check || {};
    const res = payload?.result || {};

    const tuning = mergeTuning(meta?.ui?.tuning);

    const rollerName = esc(meta.userName || "Unknown");
    const actorName = esc(meta.actorName || "Unknown");
    const typeLabel = esc(check.type || "Attribute");

    const attrs = Array.isArray(check.attrs) ? check.attrs : [];
    const attrA = esc(attrs[0] || "?");
    const attrB = esc(attrs[1] || "?");

    const dieA = safeInt(check?.dice?.A, 0);
    const dieB = safeInt(check?.dice?.B, 0);

    const rollA = safeInt((res.rollA ?? res.dieA), 0);
    const rollB = safeInt((res.rollB ?? res.dieB), 0);
    const hr = safeInt(res.hr, Math.max(rollA, rollB));
    const base = safeInt(res.base, rollA + rollB);

    const parts = check?.modifier?.parts || [];
    const modPartsTotal = sumParts(parts);
    const modTotal = Number.isFinite(Number(res.modifierTotal)) ? safeInt(res.modifierTotal, modPartsTotal) : modPartsTotal;
    const total = Number.isFinite(Number(res.total)) ? safeInt(res.total, base + modTotal) : (base + modTotal);

    const hasDL = Number.isFinite(Number(check.dl));
    const dlVal = safeInt(check.dl, 0);
    const dlVisibility = safeStr(meta.dlVisibility, "hidden");
    const dlShown = (dlVisibility === "shown");
       const pass = (res.pass === true);
    const fail = (res.pass === false);
    const verdict = pass ? "PASS" : (fail ? "FAIL" : "—");

    // Crit/Fumble badge (visual only)
    const isFumble = Boolean(res.isFumble);
    const isCrit = (!isFumble && Boolean(res.isCrit)); // fumble always wins

    // Fumble lock:
    // Check Roller Invoke Trait / Invoke Bond cannot be used on a Fumble.
    // Store this on meta so CardHydrate + InvokeButtons can also respect it.
    meta.invokeLockedByFumble = isFumble;

    const critBadgeHtml = isFumble
      ? `<div class="oni-cr-critBadge oni-cr-critBadge--fumble">FUMBLE</div>`
      : (isCrit
        ? `<div class="oni-cr-critBadge oni-cr-critBadge--crit">CRITICAL</div>`
        : ``);

    const tipA = `<b>Die A</b> <span style="opacity:.85;">(${attrA})</span><br>Die: d${dieA}<br>Rolled: ${rollA}`;
    const tipB = `<b>Die B</b> <span style="opacity:.85;">(${attrB})</span><br>Die: d${dieB}<br>Rolled: ${rollB}`;
    const tipTotal = `<b>Total</b><br>Base: ${base} <span style="opacity:.75;">(${rollA} + ${rollB})</span><br>Modifiers: <b>${fmtSigned(modTotal)}</b><br>Total: <b>${total}</b>`;
    const tipDL = hasDL
      ? (dlShown
        ? `<b>Difficulty</b><br>DL: <b>${dlVal}</b><br>Verdict: <b>${verdict}</b>`
        : `<b>Difficulty</b><br>Recorded DL: <b>${dlVal}</b><br>(hidden)`)
      : `<b>Difficulty</b><br>(none)`;

    const modLines = Array.isArray(parts) && parts.length
      ? parts
        .filter(p => safeStr(p?.label, "").trim().length || safeInt(p?.value, 0) !== 0)
        .map(p => `<div class="oni-cr-k">${esc(safeStr(p.label, "Modifier"))}</div><div class="oni-cr-v"><b>${fmtSigned(safeInt(p.value, 0))}</b></div>`)
        .join("")
      : "";

    const dlDetailsLine = hasDL
      ? (dlShown
        ? `<div class="oni-cr-k">DL</div><div class="oni-cr-v"><b>${dlVal}</b> • <b>${verdict}</b></div>`
        : `<div class="oni-cr-k">DL</div><div class="oni-cr-v"><b>(hidden)</b> • Recorded: <b>${dlVal}</b></div>`)
      : `<div class="oni-cr-k">DL</div><div class="oni-cr-v">—</div>`;

    const detailsHtml = `
      <div class="oni-cr-sep"></div>
      <div class="oni-cr-details-title"><span>Check Roll</span></div>
      <div class="oni-cr-details-sub">
        ${typeLabel} • Roller: <b>${rollerName}</b> • Actor: <b>${actorName}</b>
      </div>

      <div class="oni-cr-grid">
        <div class="oni-cr-k">Die A</div><div class="oni-cr-v"><b>${attrA}</b> d${dieA} → ${rollA}</div>
        <div class="oni-cr-k">Die B</div><div class="oni-cr-v"><b>${attrB}</b> d${dieB} → ${rollB}</div>
        <div class="oni-cr-k">Highest Roll</div><div class="oni-cr-v"><b>${hr}</b></div>
        <div class="oni-cr-k">Base</div><div class="oni-cr-v">${base} <span style="opacity:.75;">(${rollA} + ${rollB})</span></div>
        <div class="oni-cr-k">Modifiers</div><div class="oni-cr-v"><b>${fmtSigned(modTotal)}</b></div>
        <div class="oni-cr-k">Total</div><div class="oni-cr-v"><b>${total}</b></div>
        ${dlDetailsLine}
        ${modLines}
      </div>
    `;

    const attrAIconUrl = pickIconForAttr(attrs[0] || "");
    const attrBIconUrl = pickIconForAttr(attrs[1] || "");

    let dlBadgeHtml = "";
    if (hasDL) {
      const shownNum = dlShown ? String(dlVal) : "?";
      const tail = dlShown ? "" : `<span style="margin-left:.25rem;opacity:.9;">(hidden)</span>`;
      dlBadgeHtml = `
        <span class="oni-cr-dl-float fu-tip-host" data-tip="${encTip(tipDL)}">
          <span style="opacity:.8;font-weight:900;">vs</span>
          <span style="font-size:12px;color:#8a4b22;">${esc(shownNum)}</span>
          <span style="opacity:.85;">DL</span>
          ${tail}
        </span>
      `;
    }

    const CARD_MARKER = "oni-checkroll-card";

    return `
      <div class="fu-card oni-cr-card" data-fu-card="${CARD_MARKER}">
        <div class="oni-cr-shell"
          style="
            --cr-portrait-size:${safeInt(tuning.portraitSize, UI_DEFAULT.portraitSize)};
            --cr-portrait-x:${safeInt(tuning.portraitX, UI_DEFAULT.portraitX)};
            --cr-portrait-y:${safeInt(tuning.portraitY, UI_DEFAULT.portraitY)};
            --cr-check-x:${safeInt(tuning.checkX, UI_DEFAULT.checkX)};
            --cr-check-y:${safeInt(tuning.checkY, UI_DEFAULT.checkY)};
            --cr-check-size:${safeInt(tuning.checkSize, UI_DEFAULT.checkSize)};
            --cr-check-stroke:${safeInt(tuning.checkStrokeSize, UI_DEFAULT.checkStrokeSize)};
            --cr-check-stroke-color:${esc(safeStr(tuning.checkStrokeColor, UI_DEFAULT.checkStrokeColor))};
            --cr-total-font:${safeInt(tuning.totalFontSize, UI_DEFAULT.totalFontSize)};
            --cr-die-icon:${safeInt(tuning.dieIconSize, UI_DEFAULT.dieIconSize)};
            --cr-die-val:${safeInt(tuning.dieValueSize, UI_DEFAULT.dieValueSize)};
          "
          data-open="false"
        >

          <img class="oni-cr-portrait" src="${esc(tuning.portraitUrl)}" alt="Actor Portrait">

          <div class="oni-cr-panel">
            <div class="oni-cr-checkLabel">${esc(tuning.checkText || "Check")}</div>

            <div class="oni-cr-row">
              <div class="oni-cr-left">
                <span class="oni-cr-die fu-tip-host" data-tip="${encTip(tipA)}">
                  <img class="oni-cr-attrImg" src="${esc(attrAIconUrl)}" alt="DieA">
                  <span class="oni-cr-rollVal">${rollA}</span>
                </span>

                <span class="oni-cr-plus">+</span>

                <span class="oni-cr-die fu-tip-host" data-tip="${encTip(tipB)}">
                  <img class="oni-cr-attrImg" src="${esc(attrBIconUrl)}" alt="DieB">
                  <span class="oni-cr-rollVal">${rollB}</span>
                </span>
              </div>

              <span class="oni-cr-right fu-tip-host" data-tip="${encTip(tipTotal)}">
                <span class="oni-cr-totalBig oni-cr-rollnum"
                      data-final="${total}"
                      data-rollms="${safeInt(tuning.totalRollMs, UI_DEFAULT.totalRollMs)}">${total}</span>
              </span>
            </div>

            ${dlBadgeHtml}
            ${critBadgeHtml}
          </div>

          <div class="oni-cr-buttons oni-cr-invoke">
            ${(() => {
              const locked = isFumble;
              const lockedAttrs = locked
                ? `data-oni-cr-invoke-locked="fumble" aria-disabled="true"`
                : `data-oni-cr-invoke-locked="0" aria-disabled="false"`;

              const overlay = locked
                ? `<span class="oni-cr-lock-overlay" aria-hidden="true"><i class="fa-solid fa-lock"></i></span>`
                : "";

              return `
                <button type="button"
                        class="fu-btn oni-cr-btn ${locked ? "oni-cr-btn-locked" : ""}"
                        data-oni-cr-trait
                        ${lockedAttrs}
                        title="${locked ? "Locked: Invoke Trait cannot be used on a Fumble." : "Invoke Trait"}">
                  <span class="oni-cr-btn-label">🎭 Invoke Trait</span>
                  ${overlay}
                </button>

                <button type="button"
                        class="fu-btn oni-cr-btn ${locked ? "oni-cr-btn-locked" : ""}"
                        data-oni-cr-bond
                        ${lockedAttrs}
                        title="${locked ? "Locked: Invoke Bond cannot be used on a Fumble." : "Invoke Bond"}">
                  <span class="oni-cr-btn-label">🤝 Invoke Bond</span>
                  ${overlay}
                </button>
              `;
            })()}
          </div>

          <div class="oni-cr-details">
            ${detailsHtml}
          </div>
        </div>
      </div>
    `;
  };

   // ---------------------------------------------------------------------------
  // Adapter: renderCard
  // ---------------------------------------------------------------------------
  MANAGER.registerAdapter("renderCard", async (payload, ctx) => {
    ensureStyle();

    payload.meta = payload.meta || {};
    payload.meta.ui = payload.meta.ui || {};
    payload.meta.ui.tuning = mergeTuning(payload?.meta?.ui?.tuning);

    // If portraitUrl wasn't provided, try to use the actor image automatically.
    try {
      const given = safeStr(payload.meta.ui.tuning.portraitUrl, "");
      if (!given || given === UI_DEFAULT.portraitUrl) {
        const actorUuid = safeStr(payload?.meta?.actorUuid, "");
        if (actorUuid) {
          const doc = await fromUuid(actorUuid).catch(() => null);
          const img = safeStr(doc?.img, "");
          if (img) payload.meta.ui.tuning.portraitUrl = img;
        }
      }
    } catch (e) {
      console.warn(`${TAG} Portrait resolve skipped:`, e);
    }

    const html = buildCardHtml(payload);

    const flags = {
      [CONST.FLAG_SCOPE]: {
        [CONST.FLAG_KEY_CARD]: payload
      }
    };

    if (CONST.LEGACY_FLAG_SCOPE && CONST.LEGACY_FLAG_SCOPE !== CONST.FLAG_SCOPE) {
      flags[CONST.LEGACY_FLAG_SCOPE] = {
        [CONST.FLAG_KEY_CARD]: payload
      };
    }

    const msgData = {
      user: game.user.id,
      speaker: { alias: "" },
      content: html,
      flags
    };

    const vis = safeStr(payload?.meta?.visibility, "all");
    if (vis === "gm") {
      const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
      msgData.whisper = gmIds;
    } else if (vis === "self") {
      msgData.whisper = [game.user.id];
    }

    const message = await ChatMessage.create(msgData);

    console.log(`${TAG} Card posted`, { messageId: message?.id, actor: payload?.meta?.actorName });
    return { message, messageId: message?.id };
  });

  // ---------------------------------------------------------------------------
  // Adapter: updateMessage
  // - Rebuilds the SAME UI as buildCardHtml(payload)
  // - Used by InvokeButtons so reroll updates don't switch layouts
  // ---------------------------------------------------------------------------
  MANAGER.registerAdapter("updateMessage", async (message, { payload } = {}) => {
    ensureStyle();

    if (!message) throw new Error(`${TAG} updateMessage: message is required`);

    // If caller didn't pass payload, try reading from message flags.
    let p = payload;
    if (!p) {
      try { p = message.getFlag(CONST.FLAG_SCOPE, CONST.FLAG_KEY_CARD) || null; } catch (_) {}
      if (!p) {
        try { p = message.getFlag(CONST.LEGACY_FLAG_SCOPE, CONST.FLAG_KEY_CARD) || null; } catch (_) {}
      }
    }

    if (!p) throw new Error(`${TAG} updateMessage: no payload provided and no payload found on message flags`);

    // Work on a safe clone.
    p = foundry.utils.deepClone(p);

    p.meta = p.meta || {};
    p.meta.ui = p.meta.ui || {};
    p.meta.ui.tuning = mergeTuning(p?.meta?.ui?.tuning);

    // Same portrait resolve behavior as renderCard.
    try {
      const given = safeStr(p.meta.ui.tuning.portraitUrl, "");
      if (!given || given === UI_DEFAULT.portraitUrl) {
        const actorUuid = safeStr(p?.meta?.actorUuid, "");
        if (actorUuid) {
          const doc = await fromUuid(actorUuid).catch(() => null);
          const img = safeStr(doc?.img, "");
          if (img) p.meta.ui.tuning.portraitUrl = img;
        }
      }
    } catch (e) {
      console.warn(`${TAG} Portrait resolve skipped (updateMessage):`, e);
    }

    const html = buildCardHtml(p);

    // Keep speaker alias silent (Hydrate also removes header, but this keeps it clean even before hydrate runs).
    await message.update({
      content: html,
      speaker: { alias: "" }
    });

    return message;
  });
  console.log(`${TAG} Adapter installed: renderCard + updateMessage`);
})();
