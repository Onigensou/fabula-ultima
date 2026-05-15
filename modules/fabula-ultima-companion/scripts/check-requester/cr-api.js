// ============================================================================
// Check Requester — Global Attribute Check API
//
// Public API:  globalThis.ONI.CheckRequester
//   .request(actors, options)   → Promise<CheckResult[]>
//   .requestOne(actor, options) → Promise<CheckResult | null>
//
// Options:
//   attrA        {string}   "DEX"|"MIG"|"INS"|"WLP"        default "DEX"
//   attrB        {string}   "DEX"|"MIG"|"INS"|"WLP"        default "MIG"
//   dl           {number}   Difficulty Level                default 10
//   label        {string}   Title shown in UI and chat      default ""
//   mode         {string}   "interactive" | "silent"        default "interactive"
//   allowInvokes {boolean}  Allow Trait/Bond/Divination     default true
//   postChat     {boolean}  Post grouped chat card          default true
//   modifiers    {Array}    [{label,value}] pre-applied     default []
//   timeout      {number}   ms before auto-confirm (UI)     default null
//   context      {object}   Caller metadata, echoed in results default {}
//
// CheckResult fields:
//   actorUuid, actorName, tokenImg
//   attrA, attrB, dieA, dieB
//   rollA, rollB, hr, base, modifierParts, modTotal, total
//   dl, pass, isCrit, isFumble
//   usedTrait, usedBond, usedDivination
//   context   (echoed from options.context)
// ============================================================================

(() => {
  const ONI       = globalThis.ONI ??= {};
  const TAG       = "[ONI][CheckRequester]";
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const GUARD     = "__ONI_CHECK_REQUESTER__";

  if (window[GUARD]) { console.debug(TAG, "Already installed."); return; }
  window[GUARD] = true;

  // ── Socket message types (CR_ prefix, won't clash with DP_SC_ messages) ──
  const MSG_OPEN    = "CR_OPEN";
  const MSG_ROLL    = "CR_ROLL";
  const MSG_UPDATE  = "CR_UPDATE";
  const MSG_CONFIRM = "CR_CONFIRM";
  const MSG_CLOSE   = "CR_CLOSE";

  // ── Attribute icons ───────────────────────────────────────────────────────
  const ATTR_ICONS = {
    MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
    DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
    WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png",
    INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
  };

  // ── Defaults ──────────────────────────────────────────────────────────────
  const DEFAULTS = {
    attrA: "DEX", attrB: "MIG",
    dl: 10, label: "",
    mode: "interactive",
    allowInvokes: true,
    postChat: true,
    modifiers: [],
    timeout: null,
    context: {},
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const safeInt = (v, fb = 0) => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : fb;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const esc  = s  => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  // ── Actor utilities ───────────────────────────────────────────────────────
  const getDieSize = (actor, attr) =>
    safeInt(actor?.system?.props?.[`${attr.toLowerCase()}_current`], 8);

  const getFP = actor => safeInt(actor?.system?.props?.fabula_point, 0);

  const getTokenImg = actor => {
    const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
    const token = String(actor.getActiveTokens?.(true, true)?.[0]?.document?.texture?.src ?? "").trim();
    const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    return std || token || proto || actor.img || "icons/svg/mystery-man.svg";
  };

  // Resolve an actor or actor UUID → Actor document
  const resolveActorInput = async (input) => {
    if (typeof input === "string") {
      try {
        const doc = await fromUuid(input);
        if (doc?.documentName === "Actor") return doc;
        if (doc?.actor) return doc.actor;
      } catch { return null; }
    }
    return input ?? null;
  };

  const canOwnerAct = (actorUuid) => {
    if (game.user?.isGM) return true;
    const byWorld = game.actors.find(a => a.uuid === actorUuid);
    if (byWorld) return byWorld.testUserPermission(game.user, "OWNER");
    for (const t of (canvas.tokens?.placeables ?? []))
      if (t.actor?.uuid === actorUuid) return t.actor.testUserPermission(game.user, "OWNER");
    return false;
  };

  const resolveActor = async (uuid) => {
    try {
      const doc = await fromUuid(uuid);
      if (doc?.actor) return doc.actor;
      if (doc?.documentName === "Actor") return doc;
    } catch {}
    return null;
  };

  const collectBonds = (actor) => {
    const P   = actor?.system?.props ?? {};
    const POS = new Set(["admiration", "loyalty", "affection"]);
    const NEG = new Set(["inferiority", "mistrust", "hatred"]);
    const bonds = [];
    for (let i = 1; i <= 6; i++) {
      const name = String(P[`bond_${i}`] ?? "").trim();
      if (!name) continue;
      const emotions = [1, 2, 3]
        .map(j => String(P[`emotion_${i}_${j}`] ?? "").trim().toLowerCase())
        .filter(Boolean);
      let filledPos = 0, filledNeg = 0;
      for (const e of emotions) {
        if (POS.has(e)) filledPos++;
        else if (NEG.has(e)) filledNeg++;
      }
      bonds.push({ idx: i, name, bonus: Math.min(3, emotions.length), filledPos, filledNeg });
    }
    return bonds;
  };

  const findDivinationAe = (actor) => {
    for (const ae of (actor?.effects ?? [])) {
      const fl = ae.flags?.[MODULE_ID] ?? {};
      if (fl.chargeKey === "divination" && safeInt(fl.charges, 0) > 0) return ae;
    }
    return null;
  };

  const consumeDivinationCharge = async (actor) => {
    const ae = findDivinationAe(actor);
    if (!ae) return { ok: false };
    const newCharges = safeInt(ae.flags?.[MODULE_ID]?.charges, 1) - 1;
    try {
      if (newCharges <= 0) await ae.delete();
      else await ae.update({ [`flags.${MODULE_ID}.charges`]: newCharges });
      return { ok: true, remaining: newCharges };
    } catch (e) { console.error(TAG, "consumeDivinationCharge:", e); return { ok: false }; }
  };

  // ── Dice & math ───────────────────────────────────────────────────────────
  const rollDie = async (faces) => {
    const f    = Math.max(4, Math.min(20, safeInt(faces, 8)));
    const roll = new Roll(`1d${f}`);
    await roll.evaluate();
    return safeInt(roll.total, 1);
  };

  const computeCheck = (rollA, rollB, modParts, dl) => {
    const modTotal = (modParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0);
    const hr       = Math.max(rollA, rollB);
    const base     = rollA + rollB;
    const total    = base + modTotal;
    const isFumble = rollA === 1 && rollB === 1;
    const isCrit   = !isFumble && rollA === rollB && hr >= 6;
    const pass     = dl != null && Number.isFinite(Number(dl)) ? total >= Number(dl) : null;
    return { hr, base, modTotal, total, isFumble, isCrit, pass };
  };

  // ── Silent mode ───────────────────────────────────────────────────────────
  async function silentRequest(actors, opts) {
    const { attrA, attrB, dl, modifiers, context } = opts;
    const results = [];
    for (const actor of actors) {
      const dieA     = getDieSize(actor, attrA);
      const dieB     = getDieSize(actor, attrB);
      const rollA    = await rollDie(dieA);
      const rollB    = await rollDie(dieB);
      const modParts = [...(modifiers ?? [])];
      const computed = computeCheck(rollA, rollB, modParts, dl);
      results.push({
        actorUuid: actor.uuid, actorName: actor.name, tokenImg: getTokenImg(actor),
        attrA, attrB, dieA, dieB, rollA, rollB,
        modifierParts: modParts, ...computed,
        usedTrait: false, usedBond: false, usedDivination: false,
        context: context ?? {},
      });
    }
    if (opts.postChat) await postGroupedChatCard(results, opts.label, dl);
    return results;
  }

  // =========================================================================
  // CSS
  // =========================================================================
  const STYLE_ID = "oni-cr-style";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .oni-cr-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,.60);
        z-index: 100010;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 14px; pointer-events: auto;
      }
      .oni-cr-title {
        font-size: 1.05rem; font-weight: 800; color: #f6ebd3;
        text-shadow: 0 1px 5px rgba(0,0,0,.8);
        letter-spacing: .04em; text-align: center;
      }
      .oni-cr-panels { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; max-width: 880px; }

      /* Panel */
      .oni-cr-panel {
        width: 186px;
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.45) 0%,
            rgba(255,255,255,.15) 22%, transparent 40%),
          linear-gradient(180deg, #f6ebd3 0%, #eddecb 55%, #e4d0b5 100%);
        border: 2.5px solid rgba(91,63,38,.95); border-radius: 16px;
        box-shadow: 0 10px 26px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,248,232,.7);
        color: #3b2a19;
        display: flex; flex-direction: column; align-items: center;
        padding: 12px 10px 10px; gap: 8px; transition: opacity .3s;
      }
      .oni-cr-panel.is-confirmed { opacity: .5; }

      /* Token sprite */
      .oni-cr-portrait {
        width: 86px; height: 86px; flex-shrink: 0;
        background: transparent !important; border: none !important; box-shadow: none !important;
      }
      .oni-cr-portrait img, .oni-cr-portrait video {
        width: 100%; height: 100%; display: block; object-fit: contain;
        background: transparent !important; border: none !important;
        outline: none !important; box-shadow: none !important; filter: none !important;
      }
      .oni-cr-actor-name {
        font-size: .84rem; font-weight: 800; text-align: center;
        max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }

      /* Roll row */
      .oni-cr-roll-row { display: flex; align-items: center; gap: 5px; width: 100%; }
      .oni-cr-attr-block { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; }
      .oni-cr-attr-icon {
        width: 30px; height: 30px; object-fit: contain;
        background: none !important; border: none !important; box-shadow: none !important;
      }
      .oni-cr-attr-label { font-size: .7rem; font-weight: 700; opacity: .7; }
      .oni-cr-roll-btn {
        font-size: .75rem; font-weight: 800; padding: 3px 8px; border-radius: 8px;
        border: 2px solid rgba(91,63,38,.85);
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        color: #3b2a19; cursor: pointer; transition: filter .1s, transform .1s; white-space: nowrap; line-height: 1.3;
      }
      .oni-cr-roll-btn:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
      .oni-cr-roll-btn:disabled { opacity: .35; cursor: not-allowed; transform: none; filter: none; }
      .oni-cr-roll-btn.is-done { background: linear-gradient(180deg, #c8e6c9, #a5d6a7); border-color: #2e7d32; }
      .oni-cr-plus-sep { font-weight: 900; opacity: .55; flex-shrink: 0; }

      /* Die chips */
      .oni-cr-die-row { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; }
      .oni-cr-die-chip {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 34px; height: 34px; border-radius: 8px;
        background: rgba(0,0,0,.08); border: 1.5px solid rgba(0,0,0,.18);
        font-weight: 900; font-size: 1.05rem; color: #3b2a19; transition: transform .15s;
      }
      .oni-cr-die-chip.pop { animation: oni-cr-pop .25s cubic-bezier(.22,1,.36,1); }
      @keyframes oni-cr-pop {
        0%  { transform: scale(1); } 45% { transform: scale(1.3); } 100% { transform: scale(1); }
      }

      /* Result */
      .oni-cr-result-block { display: flex; flex-direction: column; align-items: center; gap: 3px; }
      .oni-cr-total { font-size: 1.5rem; font-weight: 900; line-height: 1; }
      .oni-cr-verdict {
        font-size: .75rem; font-weight: 800; padding: 2px 9px; border-radius: 6px;
        text-transform: uppercase; letter-spacing: .05em;
      }
      .oni-cr-verdict.pass   { background: rgba(46,125,50,.18);  color: #2f8a3a; }
      .oni-cr-verdict.fail   { background: rgba(179,58,47,.18);  color: #b33a2f; }
      .oni-cr-verdict.crit   { background: rgba(181,124,0,.2);   color: #7a5000; }
      .oni-cr-verdict.fumble { background: rgba(100,0,0,.18);    color: #7a0000; }

      .oni-cr-sep { width: 80%; height: 1px; background: rgba(0,0,0,.14); flex-shrink: 0; }

      /* Invoke area */
      .oni-cr-invoke-area { display: flex; flex-direction: column; gap: 4px; width: 100%; }
      .oni-cr-invoke-btn {
        font-size: .73rem; font-weight: 700; padding: 4px 7px;
        border-radius: 8px; border: 1.5px solid rgba(91,63,38,.8);
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        color: #3b2a19; cursor: pointer; text-align: left; transition: filter .1s;
      }
      .oni-cr-invoke-btn:hover:not(:disabled) { filter: brightness(1.07); }
      .oni-cr-invoke-btn:disabled { opacity: .35; cursor: not-allowed; }
      .oni-cr-invoke-btn.used { opacity: .35; text-decoration: line-through; cursor: not-allowed; }

      /* Confirm */
      .oni-cr-confirm-btn {
        width: 100%; padding: 6px; font-size: .82rem; font-weight: 800;
        border-radius: 10px; border: 2px solid #2e7d32;
        background: linear-gradient(180deg, #4caf50, #2e7d32);
        color: #fff; cursor: pointer; letter-spacing: .03em;
        box-shadow: 0 3px 8px rgba(0,0,0,.2); transition: filter .1s, transform .1s;
      }
      .oni-cr-confirm-btn:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
      .oni-cr-confirm-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; }

      .oni-cr-waiting   { font-size: .78rem; opacity: .55; font-style: italic; text-align: center; }
      .oni-cr-confirmed { font-size: .78rem; color: #2f8a3a; font-weight: 700; text-align: center; }

      /* Sub-panel (inline Invoke selection) */
      .oni-cr-subpanel-overlay {
        position: absolute; inset: 0;
        background: rgba(0,0,0,.42);
        display: flex; align-items: center; justify-content: center; z-index: 10;
      }
      .oni-cr-subpanel {
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.45) 0%,
            rgba(255,255,255,.15) 22%, transparent 40%),
          linear-gradient(180deg, #f6ebd3 0%, #eddecb 55%, #e4d0b5 100%);
        border: 2.5px solid rgba(91,63,38,.95); border-radius: 16px;
        box-shadow: 0 12px 32px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,248,232,.7);
        padding: 14px 14px 12px; min-width: 220px; max-width: 300px; color: #3b2a19;
      }
      .oni-cr-subpanel-title {
        font-size: .88rem; font-weight: 900; margin-bottom: 10px;
        border-bottom: 1px solid rgba(0,0,0,.15); padding-bottom: 6px;
      }
      .oni-cr-subpanel-rows { display: flex; flex-direction: column; gap: 5px; }
      .oni-cr-subpanel-row {
        display: flex; align-items: center; gap: 8px; padding: 7px 10px;
        border-radius: 10px; border: 2px solid rgba(91,63,38,.6);
        background: linear-gradient(180deg, #f6ebd3, #e4d0b5);
        cursor: pointer; transition: filter .1s;
      }
      .oni-cr-subpanel-row:hover { filter: brightness(1.06); }
      .oni-cr-subpanel-row.on { outline: 2.5px solid #e35151; }
      .oni-cr-subpanel-row img {
        width: 22px; height: 22px; object-fit: contain;
        background: none !important; border: none !important; box-shadow: none !important;
      }
      .oni-cr-subpanel-lbl { flex: 1; font-weight: 800; font-size: .82rem; }
      .oni-cr-subpanel-val { font-weight: 900; font-size: 1rem; }
      .oni-cr-subpanel-footer { display: flex; gap: 7px; margin-top: 10px; }
      .oni-cr-subpanel-btn {
        flex: 1; padding: 6px 4px; border-radius: 10px;
        border: 2px solid rgba(91,63,38,.8);
        font-size: .78rem; font-weight: 800; cursor: pointer;
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        color: #3b2a19; transition: filter .1s, transform .1s;
      }
      .oni-cr-subpanel-btn:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
      .oni-cr-subpanel-btn.primary {
        background: linear-gradient(180deg, #4caf50, #2e7d32); border-color: #2e7d32; color: #fff;
      }
      .oni-cr-subpanel-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; filter: none; }
    `;
    document.head.appendChild(s);
  }

  // =========================================================================
  // Session state
  // =========================================================================
  let _session = null; // { sessionId, panelStates: Map, backdropEl, dl, opts }

  // =========================================================================
  // Panel HTML
  // =========================================================================
  function buildPanelHtml(pd) {
    const isSingle  = pd.attrA === pd.attrB;
    const iconA     = ATTR_ICONS[pd.attrA] ?? ATTR_ICONS.DEX;
    const iconB     = ATTR_ICONS[pd.attrB] ?? ATTR_ICONS.MIG;
    const isVideo   = /\.(webm|mp4|ogg)(\?|$)/i.test(pd.tokenImg ?? "");
    const tokenMedia = isVideo
      ? `<video src="${esc(pd.tokenImg)}" autoplay loop muted playsinline preload="auto"></video>`
      : `<img src="${esc(pd.tokenImg)}" alt="" onerror="this.src='icons/svg/mystery-man.svg'">`;

    const btnA = `
      <div class="oni-cr-attr-block">
        <img class="oni-cr-attr-icon" src="${iconA}" title="${pd.attrA}">
        <div class="oni-cr-attr-label">${pd.attrA}</div>
        <button class="oni-cr-roll-btn" data-die="A" data-uuid="${pd.actorUuid}">d${pd.dieA}</button>
      </div>`;
    const btnB = `
      <div class="oni-cr-attr-block">
        <img class="oni-cr-attr-icon" src="${iconB}" title="${pd.attrB}">
        <div class="oni-cr-attr-label">${pd.attrB}</div>
        <button class="oni-cr-roll-btn" data-die="B" data-uuid="${pd.actorUuid}">d${pd.dieB}</button>
      </div>`;

    const rollRow = isSingle ? btnA : `${btnA}<div class="oni-cr-plus-sep">+</div>${btnB}`;

    return `
      <div class="oni-cr-panel" data-uuid="${pd.actorUuid}">
        <div class="oni-cr-portrait">${tokenMedia}</div>
        <div class="oni-cr-actor-name" title="${esc(pd.actorName)}">${esc(pd.actorName)}</div>

        <div class="oni-cr-roll-row" data-zone="roll">${rollRow}</div>

        <div class="oni-cr-die-row" data-zone="dice" style="display:none">
          <div class="oni-cr-die-chip" data-chip="A">—</div>
          ${!isSingle ? `<div class="oni-cr-plus-sep">+</div><div class="oni-cr-die-chip" data-chip="B">—</div>` : ""}
        </div>

        <div class="oni-cr-result-block" data-zone="result" style="display:none">
          <div class="oni-cr-total" data-field="total">—</div>
          <div class="oni-cr-verdict" data-field="verdict"></div>
        </div>

        <div class="oni-cr-sep" data-zone="sep1" style="display:none"></div>

        <div class="oni-cr-invoke-area" data-zone="invoke" style="display:none">
          <button class="oni-cr-invoke-btn" data-action="trait"      data-uuid="${pd.actorUuid}">🎭 Invoke Trait</button>
          <button class="oni-cr-invoke-btn" data-action="bond"       data-uuid="${pd.actorUuid}">🤝 Invoke Bond</button>
          <button class="oni-cr-invoke-btn" data-action="divination" data-uuid="${pd.actorUuid}">🔮 Divination</button>
        </div>

        <div class="oni-cr-sep" data-zone="sep2" style="display:none"></div>

        <button class="oni-cr-confirm-btn" data-uuid="${pd.actorUuid}" data-zone="confirm" style="display:none">✓ Confirm</button>
        <div class="oni-cr-confirmed" data-zone="confirmed" style="display:none">Confirmed ✓</div>
        <div class="oni-cr-waiting"   data-zone="waiting">Waiting…</div>
      </div>`;
  }

  // =========================================================================
  // DOM helpers
  // =========================================================================
  const getPanelEl = uuid =>
    _session?.backdropEl?.querySelector(`.oni-cr-panel[data-uuid="${CSS.escape(uuid)}"]`);

  const zone     = (el, name) => el?.querySelector(`[data-zone="${name}"]`);
  const showZone = (el, name, visible) => { const z = zone(el, name); if (z) z.style.display = visible ? "" : "none"; };

  // =========================================================================
  // Sync panel DOM
  // =========================================================================
  function syncPanel(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    const el = getPanelEl(uuid);
    if (!st || !el) return;

    const isOwner   = canOwnerAct(uuid);
    const isSingle  = st.attrA === st.attrB;
    const hasA      = st.rollA !== null;
    const hasB      = st.rollB !== null;
    const allRolled = hasA && (isSingle || hasB);

    // Roll buttons
    showZone(el, "roll", !allRolled);
    {
      const bA = el.querySelector(`[data-die="A"][data-uuid="${uuid}"]`);
      const bB = el.querySelector(`[data-die="B"][data-uuid="${uuid}"]`);
      if (bA) { bA.disabled = !isOwner || st.confirmed || hasA; if (hasA) bA.classList.add("is-done"); }
      if (bB && !isSingle) { bB.disabled = !isOwner || st.confirmed || hasB; if (hasB) bB.classList.add("is-done"); }
    }

    // Die chips — show as soon as any die lands
    if (hasA || hasB) {
      showZone(el, "dice", true);
      const cA = el.querySelector("[data-chip='A']");
      const cB = el.querySelector("[data-chip='B']");
      if (cA) cA.textContent = hasA ? String(st.rollA) : "—";
      if (cB && !isSingle) cB.textContent = hasB ? String(st.rollB) : "—";
    } else {
      showZone(el, "dice", false);
    }

    // Total + verdict (only when both dice done)
    if (allRolled && st.result) {
      showZone(el, "result", true);
      showZone(el, "sep1",   true);
      const totalEl   = el.querySelector("[data-field='total']");
      const verdictEl = el.querySelector("[data-field='verdict']");
      if (totalEl) totalEl.textContent = String(st.result.total);
      if (verdictEl) {
        verdictEl.className = "oni-cr-verdict";
        if (st.result.isFumble)          { verdictEl.textContent = "FUMBLE";    verdictEl.classList.add("fumble"); }
        else if (st.result.isCrit)       { verdictEl.textContent = "CRITICAL!"; verdictEl.classList.add("crit");   }
        else if (st.result.pass === true)  { verdictEl.textContent = `✓ DL ${ses.dl}`; verdictEl.classList.add("pass"); }
        else if (st.result.pass === false) { verdictEl.textContent = `✗ DL ${ses.dl}`; verdictEl.classList.add("fail"); }
        else                             { verdictEl.textContent = `Total ${st.result.total}`; }
      }
    } else {
      showZone(el, "result", false);
      showZone(el, "sep1",   false);
    }

    // Invoke area
    const allowInvokes = ses.opts?.allowInvokes !== false;
    const canInvoke    = allowInvokes && isOwner && allRolled && !st.confirmed && !st.result?.isFumble;
    const anyInvoke    = st.canTrait || st.canBond || st.canDivination;
    showZone(el, "invoke", canInvoke && anyInvoke);
    if (canInvoke && anyInvoke) {
      const applyBtn = (sel, used, can) => {
        const btn = el.querySelector(sel);
        if (!btn) return;
        btn.disabled = used || !can;
        btn.classList.toggle("used", used);
      };
      applyBtn("[data-action='trait']",      st.usedTrait,      st.canTrait);
      applyBtn("[data-action='bond']",       st.usedBond,       st.canBond);
      applyBtn("[data-action='divination']", st.usedDivination, st.canDivination);
    }

    // Confirm / waiting / done
    showZone(el, "sep2",      !st.confirmed);
    showZone(el, "confirm",   isOwner && allRolled && !st.confirmed);
    showZone(el, "confirmed", st.confirmed);
    showZone(el, "waiting",   !isOwner && !st.confirmed);

    if (st.confirmed) el.classList.add("is-confirmed");
    else              el.classList.remove("is-confirmed");
  }

  // =========================================================================
  // Rolling animation
  // =========================================================================
  async function animateDie(panelEl, chipSel, finalValue, faces) {
    const chip = panelEl?.querySelector(`[data-chip="${chipSel}"]`);
    if (!chip) return;
    const diceRow = panelEl.querySelector("[data-zone='dice']");
    if (diceRow) diceRow.style.display = "";
    const TICK = 55, STEPS = Math.ceil(700 / TICK);
    for (let i = 0; i < STEPS; i++) {
      chip.textContent = String(Math.floor(Math.random() * faces) + 1);
      await wait(TICK);
    }
    chip.textContent = String(finalValue);
    chip.classList.remove("pop");
    void chip.offsetWidth;
    chip.classList.add("pop");
    try {
      const sfx = globalThis.ONI?.CheckRoller?.CONST?.DEFAULTS?.UI_TUNING?.rollSfxUrl;
      if (sfx) AudioHelper.play({ src: sfx, volume: 0.55, autoplay: true }, false);
    } catch (_) {}
  }

  // =========================================================================
  // Inline sub-panel
  // =========================================================================
  function showSubPanel(titleText, rowsHtml, confirmLabel, cancelLabel = "Cancel") {
    return new Promise(resolve => {
      const backdrop = _session?.backdropEl;
      if (!backdrop) { resolve(null); return; }

      const overlay = document.createElement("div");
      overlay.className = "oni-cr-subpanel-overlay";

      const panel = document.createElement("div");
      panel.className = "oni-cr-subpanel";
      panel.innerHTML = `
        <div class="oni-cr-subpanel-title">${titleText}</div>
        <div class="oni-cr-subpanel-rows">${rowsHtml}</div>
        <div class="oni-cr-subpanel-footer">
          <button class="oni-cr-subpanel-btn" data-sp="cancel">${cancelLabel}</button>
          <button class="oni-cr-subpanel-btn primary" data-sp="confirm" disabled>${confirmLabel}</button>
        </div>`;
      overlay.appendChild(panel);
      backdrop.appendChild(overlay);

      let selected = null;
      panel.querySelectorAll(".oni-cr-subpanel-row").forEach(r =>
        r.addEventListener("click", () => {
          panel.querySelectorAll(".oni-cr-subpanel-row").forEach(x => x.classList.remove("on"));
          r.classList.add("on");
          selected = r.dataset.value ?? null;
          const cb = panel.querySelector("[data-sp='confirm']");
          if (cb) cb.disabled = false;
        })
      );
      panel.addEventListener("click", e => {
        const btn = e.target.closest("[data-sp]");
        if (!btn || btn.disabled) return;
        overlay.remove();
        resolve(btn.dataset.sp === "confirm" ? selected : null);
      });
      overlay.addEventListener("click", e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
    });
  }

  // =========================================================================
  // Open overlay
  // =========================================================================
  function openOverlay(data, opts) {
    closeOverlay();
    ensureStyles();
    const { sessionId, panels, dl, tileLabel } = data;

    const backdrop = document.createElement("div");
    backdrop.className = "oni-cr-backdrop";
    backdrop.id = "oni-cr-backdrop";

    const titleEl = document.createElement("div");
    titleEl.className = "oni-cr-title";
    titleEl.textContent = [tileLabel ? `Skill Check — ${tileLabel}` : "Skill Check", dl != null ? `(DL ${dl})` : ""].filter(Boolean).join(" ");
    backdrop.appendChild(titleEl);

    const row = document.createElement("div");
    row.className = "oni-cr-panels";
    row.innerHTML = panels.map(buildPanelHtml).join("");
    backdrop.appendChild(row);
    document.body.appendChild(backdrop);

    const panelStates = new Map();
    for (const pd of panels) {
      panelStates.set(pd.actorUuid, {
        ...pd,
        rollA: null, rollB: null,
        result: null, modifierParts: [...(opts?.modifiers ?? [])],
        canTrait: false, usedTrait: false,
        canBond: false,  usedBond: false,
        canDivination: false, usedDivination: false,
        confirmed: false, _actor: null, _bonds: null,
      });
    }

    _session = { sessionId, panelStates, backdropEl: backdrop, dl, opts };

    backdrop.addEventListener("click", async ev => {
      const rollBtn    = ev.target.closest(".oni-cr-roll-btn");
      const invokeBtn  = ev.target.closest(".oni-cr-invoke-btn");
      const confirmBtn = ev.target.closest(".oni-cr-confirm-btn");
      if (rollBtn)    await onRollClick(rollBtn).catch(e => console.error(TAG, e));
      if (invokeBtn)  await onInvokeClick(invokeBtn).catch(e => console.error(TAG, e));
      if (confirmBtn) await onConfirmClick(confirmBtn).catch(e => console.error(TAG, e));
    });

    for (const [uuid] of panelStates) {
      syncPanel(uuid);
      if (canOwnerAct(uuid) && opts?.allowInvokes !== false) loadInvokeAvailability(uuid);
    }
  }

  // =========================================================================
  // Load invoke availability
  // =========================================================================
  async function loadInvokeAvailability(uuid) {
    const ses = _session;
    if (!ses || ses.opts?.allowInvokes === false) return;
    const st = ses.panelStates.get(uuid);
    if (!st) return;
    const actor = await resolveActor(uuid);
    if (!actor || !_session || _session.sessionId !== ses.sessionId) return;
    const fp = getFP(actor), bonds = collectBonds(actor);
    st._actor = actor; st._bonds = bonds;
    st.canTrait = fp >= 1;
    st.canBond  = fp >= 1 && bonds.length > 0;
    st.canDivination = !!findDivinationAe(actor);
    syncPanel(uuid);
  }

  // =========================================================================
  // Close overlay
  // =========================================================================
  function closeOverlay() {
    _session?.backdropEl?.remove();
    _session = null;
  }

  // =========================================================================
  // Roll button
  // =========================================================================
  async function onRollClick(btn) {
    const ses  = _session;
    if (!ses) return;
    const uuid = btn.dataset.uuid;
    const die  = btn.dataset.die;
    if (!canOwnerAct(uuid)) return;
    const st = ses.panelStates.get(uuid);
    if (!st || st.confirmed) return;
    const isSingle = st.attrA === st.attrB;
    if (die === "A" && st.rollA !== null) return;
    if (die === "B" && (st.rollB !== null || isSingle)) return;
    btn.disabled = true;

    if (isSingle && die === "A") {
      const vA = await rollDie(st.dieA), vB = await rollDie(st.dieA);
      st.rollA = vA; st.rollB = vB;
      game.socket.emit(SOCKET_CH, { type: MSG_ROLL, payload: { sessionId: ses.sessionId, uuid, die: "BOTH", rollA: vA, rollB: vB } });
      const panelEl = getPanelEl(uuid);
      if (panelEl) await animateDie(panelEl, "A", vA, st.dieA);
      afterAllRolled(uuid);
      return;
    }

    const faces = die === "A" ? st.dieA : st.dieB;
    const value = await rollDie(faces);
    if (die === "A") st.rollA = value; else st.rollB = value;
    game.socket.emit(SOCKET_CH, { type: MSG_ROLL, payload: { sessionId: ses.sessionId, uuid, die, value } });
    const panelEl = getPanelEl(uuid);
    if (panelEl) await animateDie(panelEl, die, value, faces);
    afterAllRolled(uuid);
  }

  function afterAllRolled(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    if (!st) return;
    const isSingle = st.attrA === st.attrB;
    const allDone  = st.rollA !== null && (isSingle || st.rollB !== null);
    if (!allDone) { syncPanel(uuid); return; }
    const rB = isSingle ? st.rollA : (st.rollB ?? st.rollA);
    st.result = computeCheck(st.rollA, rB, st.modifierParts, ses.dl);
    syncPanel(uuid);
    if (canOwnerAct(uuid)) scheduleAutoConfirm(uuid);
  }

  // =========================================================================
  // Auto-confirm
  // =========================================================================
  async function scheduleAutoConfirm(uuid) {
    const ses = _session;
    if (!ses) return;
    await wait(400);
    if (!_session || _session.sessionId !== ses.sessionId) return;
    const st = ses.panelStates.get(uuid);
    if (!st || st.confirmed) return;

    const isFumble  = st.result?.isFumble;
    const noOptions = !st.canTrait && !st.canBond && !st.canDivination;
    // Also auto-confirm if caller passed a timeout
    const timedOut  = ses.opts?.timeout != null;

    if (isFumble || noOptions) {
      const delay = timedOut ? Math.min(ses.opts.timeout, 900) : 900;
      await wait(delay);
      if (_session?.sessionId === ses.sessionId && !st.confirmed) await doConfirm(uuid);
    } else if (timedOut) {
      await wait(ses.opts.timeout);
      if (_session?.sessionId === ses.sessionId && !st.confirmed) await doConfirm(uuid);
    }
  }

  // =========================================================================
  // Invoke handlers
  // =========================================================================
  async function onInvokeClick(btn) {
    const { action, uuid } = btn.dataset;
    if (!canOwnerAct(uuid)) return;
    if (action === "trait")      await invokeTrait(uuid);
    else if (action === "bond")  await invokeBond(uuid);
    else if (action === "divination") await invokeDivination(uuid);
  }

  async function invokeTrait(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    if (!st || st.usedTrait || st.result?.isFumble) return;
    const actor = st._actor ?? await resolveActor(uuid);
    if (!actor || getFP(actor) < 1) { ui.notifications?.warn("Not enough Fabula Points (need 1)."); return; }

    const isSingle = st.attrA === st.attrB;
    const iconA = ATTR_ICONS[st.attrA] ?? "", iconB = ATTR_ICONS[st.attrB] ?? "";
    const rA = st.rollA, rB = isSingle ? st.rollA : (st.rollB ?? st.rollA);

    const rowA = `<div class="oni-cr-subpanel-row" data-value="A">
      <img src="${iconA}" title="${st.attrA}">
      <div class="oni-cr-subpanel-lbl">${st.attrA} (d${st.dieA})</div>
      <div class="oni-cr-subpanel-val">${rA}</div></div>`;
    const rowsHtml = isSingle ? rowA : rowA
      + `<div class="oni-cr-subpanel-row" data-value="B">
           <img src="${iconB}" title="${st.attrB}">
           <div class="oni-cr-subpanel-lbl">${st.attrB} (d${st.dieB})</div>
           <div class="oni-cr-subpanel-val">${rB}</div></div>
         <div class="oni-cr-subpanel-row" data-value="AB">
           <div class="oni-cr-subpanel-lbl" style="text-align:center;width:100%">Both dice</div></div>`;

    const choice = await showSubPanel("🎭 Invoke Trait — Choose dice to reroll", rowsHtml, "Reroll");
    if (!choice) return;

    await actor.update({ "system.props.fabula_point": getFP(actor) - 1 });

    let newA = rA, newB = rB;
    if (choice === "A" || choice === "AB") newA = await rollDie(st.dieA);
    if ((choice === "B" || choice === "AB") && !isSingle) newB = await rollDie(st.dieB);

    st.usedTrait = true; st.canTrait = false;
    st.rollA = newA;
    if (!isSingle) st.rollB = newB;
    st.result = computeCheck(newA, isSingle ? newA : newB, st.modifierParts, ses.dl);
    broadcastUpdate(uuid); syncPanel(uuid);
  }

  async function invokeBond(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    if (!st || st.usedBond || st.result?.isFumble) return;
    const actor = st._actor ?? await resolveActor(uuid);
    if (!actor || getFP(actor) < 1) { ui.notifications?.warn("Not enough Fabula Points (need 1)."); return; }
    const bonds = st._bonds ?? collectBonds(actor);
    if (!bonds.length) { ui.notifications?.warn("No bonds found."); return; }

    const bondRowsHtml = bonds.map(b => `
      <div class="oni-cr-subpanel-row" data-value="${b.idx}">
        <div class="oni-cr-subpanel-lbl">${esc(b.name)}<span style="opacity:.6;font-size:.75rem;margin-left:5px;">${"❤".repeat(b.filledPos)}${"💜".repeat(b.filledNeg)}</span></div>
        <div class="oni-cr-subpanel-val">+${b.bonus}</div>
      </div>`).join("");

    const bondChoice = await showSubPanel("🤝 Invoke Bond — Choose a Bond", bondRowsHtml, "Invoke");
    if (!bondChoice) return;
    const bond = bonds.find(b => b.idx === parseInt(bondChoice, 10));
    if (!bond) return;

    await actor.update({ "system.props.fabula_point": getFP(actor) - 1 });
    st.modifierParts = [...(st.modifierParts ?? []), { label: `Bond: ${bond.name}`, value: bond.bonus }];
    const isSingle = st.attrA === st.attrB;
    st.result = computeCheck(st.rollA, isSingle ? st.rollA : (st.rollB ?? st.rollA), st.modifierParts, ses.dl);
    st.usedBond = true; st.canBond = false;
    broadcastUpdate(uuid); syncPanel(uuid);
  }

  async function invokeDivination(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    if (!st || st.usedDivination) return;
    if (st.result?.isCrit || st.result?.isFumble) { ui.notifications?.warn("Cannot reroll Critical or Fumble."); return; }
    const actor = st._actor ?? await resolveActor(uuid);
    if (!actor) return;
    if (!findDivinationAe(actor)) { ui.notifications?.warn("No Divination charges remaining."); return; }

    const newA = await rollDie(st.dieA), newB = await rollDie(st.dieB);
    const res  = await consumeDivinationCharge(actor);
    if (!res.ok) { ui.notifications?.error("Failed to consume Divination charge."); return; }

    const isSingle = st.attrA === st.attrB;
    st.rollA = newA;
    if (!isSingle) st.rollB = newB;
    st.result = computeCheck(newA, isSingle ? newA : newB, st.modifierParts, ses.dl);
    st.usedDivination = true; st.canDivination = false;
    broadcastUpdate(uuid); syncPanel(uuid);
    ui.notifications?.info(res.remaining > 0 ? `Divination used. ${res.remaining} charge${res.remaining === 1 ? "" : "s"} remaining.` : "Divination used. Active Effect ended.");
  }

  function broadcastUpdate(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    if (!st) return;
    game.socket.emit(SOCKET_CH, {
      type: MSG_UPDATE,
      payload: { sessionId: ses.sessionId, uuid, rollA: st.rollA, rollB: st.rollB,
        modifierParts: st.modifierParts, usedTrait: st.usedTrait, usedBond: st.usedBond, usedDivination: st.usedDivination },
    });
  }

  // =========================================================================
  // Confirm
  // =========================================================================
  async function onConfirmClick(btn) {
    if (!canOwnerAct(btn.dataset.uuid)) return;
    await doConfirm(btn.dataset.uuid);
  }

  async function doConfirm(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    if (!st || st.confirmed || !canOwnerAct(uuid)) return;

    const isSingle = st.attrA === st.attrB;
    const rA  = st.rollA ?? 0;
    const rB  = isSingle ? rA : (st.rollB ?? rA);
    const res = st.result ?? computeCheck(rA, rB, st.modifierParts, ses.dl);

    st.confirmed = true;
    syncPanel(uuid);

    const cp = {
      sessionId: ses.sessionId, actorUuid: uuid,
      actorName: st.actorName, tokenImg: st.tokenImg ?? "",
      attrA: st.attrA, attrB: st.attrB, dieA: st.dieA, dieB: st.dieB,
      rollA: rA, rollB: rB, modifierParts: st.modifierParts,
      total: res.total, pass: res.pass, isCrit: res.isCrit, isFumble: res.isFumble,
      usedTrait: st.usedTrait, usedBond: st.usedBond, usedDivination: st.usedDivination,
      context: ses.opts?.context ?? {},
    };

    game.socket.emit(SOCKET_CH, { type: MSG_CONFIRM, payload: cp });

    // socket.emit doesn't echo to the sender; collect directly on GM
    if (game.user?.isGM) {
      const pending = _pendingSessions.get(ses.sessionId);
      if (pending) { pending.confirms.set(uuid, cp); pending.checkComplete(); }
    }
  }

  // =========================================================================
  // Grouped chat card
  // =========================================================================
  async function postGroupedChatCard(confirmPayloads, label, dl) {
    if (!confirmPayloads.length) return;
    const titleText = [label ? `Skill Check — ${label}` : "Skill Check", dl != null ? `(DL ${dl})` : ""].filter(Boolean).join(" ");

    const actorRows = confirmPayloads.map(cp => {
      const { actorName, tokenImg, attrA, attrB, dieA, dieB,
              rollA, rollB, total, pass, isCrit, isFumble, modifierParts } = cp;
      const modTotal = (modifierParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0);
      const hr = Math.max(rollA, rollB), base = rollA + rollB;

      let verdictText, verdictColor, summaryBg;
      if (isFumble)            { verdictText = "FUMBLE";   verdictColor = "#7a0000"; summaryBg = "rgba(122,0,0,.06)"; }
      else if (isCrit)         { verdictText = "CRITICAL"; verdictColor = "#7a5000"; summaryBg = "rgba(122,80,0,.06)"; }
      else if (pass === true)  { verdictText = "✓ PASS";   verdictColor = "#2f8a3a"; summaryBg = "rgba(46,125,50,.06)"; }
      else if (pass === false) { verdictText = "✗ FAIL";   verdictColor = "#b33a2f"; summaryBg = "rgba(179,58,47,.06)"; }
      else                     { verdictText = String(total); verdictColor = "#3b2a19"; summaryBg = "transparent"; }

      const modRows = (modifierParts ?? [])
        .filter(p => p?.label && safeInt(p.value, 0) !== 0)
        .map(p => `<tr><td style="opacity:.55;padding-right:10px;padding-bottom:2px;">${esc(p.label)}</td>
                       <td style="padding-bottom:2px;">${p.value >= 0 ? "+" : ""}${p.value}</td></tr>`)
        .join("");

      const imgSrc = tokenImg || "icons/svg/mystery-man.svg";
      return `
        <details style="margin-bottom:4px;border-radius:8px;overflow:hidden;border:1.5px solid rgba(91,63,38,.25);">
          <summary style="list-style:none;display:flex;align-items:center;gap:8px;
            cursor:pointer;padding:5px 8px;background:${summaryBg};user-select:none;">
            <img src="${esc(imgSrc)}" alt=""
              style="width:34px;height:34px;flex-shrink:0;object-fit:contain;
                background:transparent!important;border:none!important;
                box-shadow:none!important;filter:none!important;border-radius:0!important;">
            <span style="flex:1;font-weight:800;font-size:.86rem;">${esc(actorName)}</span>
            <span style="font-weight:800;font-size:.82rem;color:${verdictColor};">${verdictText}</span>
          </summary>
          <div style="padding:7px 10px 5px;background:rgba(0,0,0,.03);border-top:1px solid rgba(91,63,38,.18);">
            <table style="width:100%;border-collapse:collapse;font-size:.8rem;color:#3b2a19;">
              <tr><td style="opacity:.55;padding-right:10px;padding-bottom:2px;">Formula</td>
                  <td style="padding-bottom:2px;">${esc(attrA)} + ${esc(attrB)}</td></tr>
              <tr><td style="opacity:.55;padding-bottom:2px;">Dice</td>
                  <td style="padding-bottom:2px;">d${dieA} + d${dieB}</td></tr>
              <tr><td style="opacity:.55;padding-bottom:2px;">Rolls</td>
                  <td style="padding-bottom:2px;">${rollA}, ${rollB}<span style="opacity:.5;"> (HR ${hr})</span></td></tr>
              <tr><td style="opacity:.55;padding-bottom:2px;">Base</td>
                  <td style="padding-bottom:2px;">${base}</td></tr>
              ${modTotal !== 0 ? `<tr><td style="opacity:.55;padding-bottom:2px;">Modifier</td>
                  <td style="padding-bottom:2px;">${modTotal >= 0 ? "+" : ""}${modTotal}</td></tr>` : ""}
              ${modRows}
              <tr><td style="opacity:.55;font-weight:800;padding-top:3px;">Total</td>
                  <td style="font-weight:900;font-size:.95rem;padding-top:3px;">${total}</td></tr>
            </table>
          </div>
        </details>`;
    }).join("");

    await ChatMessage.create({
      content: `
        <div style="font-family:inherit;padding:9px 11px 7px;border-radius:10px;
          background:linear-gradient(180deg,#f6ebd3,#e4d0b5);
          border:2px solid rgba(91,63,38,.8);color:#3b2a19;">
          <div style="font-weight:900;font-size:.92rem;margin-bottom:8px;
            border-bottom:1px solid rgba(0,0,0,.15);padding-bottom:5px;">${esc(titleText)}</div>
          ${actorRows}
        </div>`,
    }).catch(e => console.warn(TAG, "postGroupedChatCard failed:", e));
  }

  // =========================================================================
  // Socket listener
  // =========================================================================
  const _pendingSessions = new Map();

  function setupSocket() {
    if (window["__ONI_CR_SOCKET__"]) return;
    window["__ONI_CR_SOCKET__"] = true;

    game.socket.on(SOCKET_CH, async msg => {
      if (!msg?.type?.startsWith("CR_")) return;

      if (msg.type === MSG_OPEN) {
        openOverlay(msg.payload, msg.opts ?? {});
        return;
      }

      if (msg.type === MSG_ROLL) {
        const { sessionId, uuid, die, value, rollA, rollB } = msg.payload ?? {};
        const ses = _session;
        if (!ses || ses.sessionId !== sessionId) return;
        const st = ses.panelStates.get(uuid);
        if (!st) return;
        if (die === "BOTH") {
          if (st.rollA !== null) return;
          st.rollA = rollA; st.rollB = rollB;
          const el = getPanelEl(uuid);
          if (el) await animateDie(el, "A", rollA, st.dieA);
          afterAllRolled(uuid);
        } else {
          if (die === "A" && st.rollA !== null) return;
          if (die === "B" && st.rollB !== null) return;
          if (die === "A") st.rollA = value; else st.rollB = value;
          const el = getPanelEl(uuid);
          if (el) await animateDie(el, die, value, die === "A" ? st.dieA : st.dieB);
          afterAllRolled(uuid);
        }
        return;
      }

      if (msg.type === MSG_UPDATE) {
        const { sessionId, uuid, rollA, rollB, modifierParts, usedTrait, usedBond, usedDivination } = msg.payload ?? {};
        const ses = _session;
        if (!ses || ses.sessionId !== sessionId) return;
        const st = ses.panelStates.get(uuid);
        if (!st) return;
        Object.assign(st, { rollA, rollB, modifierParts: modifierParts ?? [], usedTrait, usedBond, usedDivination });
        const isSingle = st.attrA === st.attrB;
        if (rollA !== null) st.result = computeCheck(rollA, isSingle ? rollA : (rollB ?? rollA), st.modifierParts, ses.dl);
        syncPanel(uuid);
        return;
      }

      if (msg.type === MSG_CONFIRM) {
        const { sessionId, actorUuid } = msg.payload ?? {};
        const ses = _session;
        if (ses && ses.sessionId === sessionId) {
          const st = ses.panelStates.get(actorUuid);
          if (st) { st.confirmed = true; syncPanel(actorUuid); }
        }
        if (game.user?.isGM) {
          const pending = _pendingSessions.get(sessionId);
          if (pending) { pending.confirms.set(actorUuid, msg.payload); pending.checkComplete(); }
        }
        return;
      }

      if (msg.type === MSG_CLOSE) {
        if (_session?.sessionId === msg.payload?.sessionId) closeOverlay();
      }
    });

    console.debug(TAG, "Socket listener installed.");
  }

  // =========================================================================
  // Interactive mode
  // =========================================================================
  async function interactiveRequest(actors, opts) {
    if (!game.user?.isGM) throw new Error(`${TAG} interactive mode must run on the GM client.`);
    const { attrA, attrB, dl, label, context } = opts;
    const sessionId = foundry.utils.randomID();

    const panels = actors.map(actor => ({
      actorUuid: actor.uuid, actorName: actor.name, tokenImg: getTokenImg(actor),
      attrA, attrB,
      dieA: getDieSize(actor, attrA),
      dieB: getDieSize(actor, attrB),
    }));

    let _resolve;
    const done = new Promise(res => { _resolve = res; });
    const confirms = new Map();
    _pendingSessions.set(sessionId, {
      confirms,
      checkComplete() { if (confirms.size >= actors.length) _resolve(Array.from(confirms.values())); },
    });

    const overlayData = { sessionId, panels, dl, tileLabel: label };
    game.socket.emit(SOCKET_CH, { type: MSG_OPEN, payload: overlayData, opts });
    openOverlay(overlayData, opts);

    const confirmPayloads = await done;
    _pendingSessions.delete(sessionId);

    if (opts.postChat) await postGroupedChatCard(confirmPayloads, label, dl);

    game.socket.emit(SOCKET_CH, { type: MSG_CLOSE, payload: { sessionId } });
    closeOverlay();

    return confirmPayloads.map(cp => ({
      actorUuid:    cp.actorUuid,
      actorName:    cp.actorName,
      tokenImg:     cp.tokenImg,
      attrA:        cp.attrA,   attrB:  cp.attrB,
      dieA:         cp.dieA,    dieB:   cp.dieB,
      rollA:        cp.rollA,   rollB:  cp.rollB,
      hr:           Math.max(cp.rollA, cp.rollB),
      base:         cp.rollA + cp.rollB,
      modifierParts: cp.modifierParts ?? [],
      modTotal:     (cp.modifierParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0),
      total:        cp.total,
      dl,
      pass:         cp.pass,
      isCrit:       cp.isCrit,
      isFumble:     cp.isFumble,
      usedTrait:    cp.usedTrait,
      usedBond:     cp.usedBond,
      usedDivination: cp.usedDivination,
      context:      context ?? {},
    }));
  }

  // =========================================================================
  // Public API
  // =========================================================================
  async function request(actorsInput, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    opts.attrA = String(opts.attrA ?? "DEX").toUpperCase();
    opts.attrB = String(opts.attrB ?? "MIG").toUpperCase();
    opts.dl    = safeInt(opts.dl, 10);
    opts.modifiers = Array.isArray(opts.modifiers) ? opts.modifiers : [];

    // Accept actor objects or UUID strings
    const rawActors = Array.isArray(actorsInput) ? actorsInput : [actorsInput];
    const actors = (await Promise.all(rawActors.map(resolveActorInput))).filter(Boolean);
    if (!actors.length) return [];

    if (opts.mode === "silent") return silentRequest(actors, opts);
    return interactiveRequest(actors, opts);
  }

  async function requestOne(actorInput, options = {}) {
    const results = await request([actorInput], options);
    return results[0] ?? null;
  }

  // =========================================================================
  // Boot
  // =========================================================================
  ONI.CheckRequester = { request, requestOne };

  Hooks.once("ready", () => {
    setupSocket();
    console.debug(TAG, "Ready. ONI.CheckRequester available.");
  });
})();
