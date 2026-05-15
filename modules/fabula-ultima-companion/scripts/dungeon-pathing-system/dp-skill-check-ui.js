// ============================================================================
// Dungeon Pathing — Tile Skill Check UI
//
// Provides an in-game canvas-layer overlay (not a pop-up window) that
// coordinates party skill checks before a tile's effects are applied.
//
// Always GM-orchestrated:
//   • Player trigger → MSG_SKILL_CHECK socket → GM runs request()
//   • GM trigger     → direct call to request()
//
// Overlay is broadcast to ALL clients via DP_SC_OPEN.
// Interactivity is gated to the actor's owner or the GM.
//
// Socket messages (piggyback on module.fabula-ultima-companion channel):
//   DP_SC_OPEN     GM → all    open overlay with session data
//   DP_SC_ROLL     owner→all   broadcast a single die result
//   DP_SC_UPDATE   owner→all   broadcast post-invoke full state
//   DP_SC_CONFIRM  owner→GM    actor is done; carries final result
//   DP_SC_CLOSE    GM → all    tear down overlay
// ============================================================================

(() => {
  const DP        = globalThis.DungeonPathing ??= {};
  const TAG       = "[DungeonPathing][TileSkillCheck]";
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CH = `module.${MODULE_ID}`;
  const GUARD     = "__ONI_DP_SKILL_CHECK_UI__";

  if (window[GUARD]) { console.debug(TAG, "Already installed."); return; }
  window[GUARD] = true;

  // ── Socket message types ──────────────────────────────────────────────────
  const MSG_OPEN    = "DP_SC_OPEN";
  const MSG_ROLL    = "DP_SC_ROLL";
  const MSG_UPDATE  = "DP_SC_UPDATE";
  const MSG_CONFIRM = "DP_SC_CONFIRM";
  const MSG_CLOSE   = "DP_SC_CLOSE";

  // ── Attribute icons (mirrors CheckRoller CONST.ICONS) ────────────────────
  const ATTR_ICONS = {
    MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
    DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
    WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png",
    INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
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

  const canOwnerAct = (actorUuid) => {
    if (game.user?.isGM) return true;
    // Search world actors and canvas tokens
    const byWorld = game.actors.find(a => a.uuid === actorUuid);
    if (byWorld) return byWorld.testUserPermission(game.user, "OWNER");
    for (const t of (canvas.tokens?.placeables ?? [])) {
      if (t.actor?.uuid === actorUuid) return t.actor.testUserPermission(game.user, "OWNER");
    }
    return false;
  };

  const resolveActor = async (uuid) => {
    try {
      const doc = await fromUuid(uuid);
      if (doc?.actor) return doc.actor;
      if (doc?.documentName === "Actor") return doc;
      return null;
    } catch { return null; }
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

  // ── Dice rolling ──────────────────────────────────────────────────────────
  const rollDie = async (faces) => {
    const f    = Math.max(4, Math.min(20, safeInt(faces, 8)));
    const roll = new Roll(`1d${f}`);
    await roll.evaluate();
    return safeInt(roll.total, 1);
  };

  // ── Check computation (mirrors CheckRoller core) ─────────────────────────
  const computeCheck = (rollA, rollB, modParts, dl) => {
    const modTotal = (modParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0);
    const hr       = Math.max(rollA, rollB);
    const base     = rollA + rollB;
    const total    = base + modTotal;
    const isFumble = rollA === 1 && rollB === 1;
    const isCrit   = !isFumble && rollA === rollB && hr >= 6;
    const pass     = dl != null && Number.isFinite(Number(dl)) ? total >= Number(dl) : null;
    return { rollA, rollB, hr, base, modTotal, total, isFumble, isCrit, pass };
  };

  // =========================================================================
  // CSS
  // =========================================================================
  const STYLE_ID = "oni-dpsc-style";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .dpsc-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,.60);
        z-index: 100010;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 14px;
        pointer-events: auto;
      }
      .dpsc-title {
        font-size: 1.05rem; font-weight: 800; color: #f6ebd3;
        text-shadow: 0 1px 5px rgba(0,0,0,.8);
        letter-spacing: .04em; text-align: center;
      }
      .dpsc-panels {
        display: flex; flex-wrap: wrap; justify-content: center; gap: 14px;
        max-width: 860px;
      }

      /* ── Panel card ── */
      .dpsc-panel {
        width: 186px;
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.45) 0%,
            rgba(255,255,255,.15) 22%, transparent 40%),
          linear-gradient(180deg, #f6ebd3 0%, #eddecb 55%, #e4d0b5 100%);
        border: 2.5px solid rgba(91,63,38,.95);
        border-radius: 16px;
        box-shadow: 0 10px 26px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,248,232,.7);
        color: #3b2a19;
        display: flex; flex-direction: column; align-items: center;
        padding: 12px 10px 10px; gap: 8px;
        transition: opacity .3s;
      }
      .dpsc-panel.is-confirmed { opacity: .5; }

      /* Portrait */
      .dpsc-portrait {
        width: 68px; height: 68px; border-radius: 50%;
        border: 2px solid rgba(91,63,38,.85);
        overflow: hidden; flex-shrink: 0;
        box-shadow: 0 3px 8px rgba(0,0,0,.3);
      }
      .dpsc-portrait img {
        width: 100%; height: 100%; object-fit: cover;
        background: none; border: none; box-shadow: none;
      }
      .dpsc-actor-name {
        font-size: .84rem; font-weight: 800; text-align: center;
        max-width: 100%; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }

      /* Roll row */
      .dpsc-roll-row { display: flex; align-items: center; gap: 5px; width: 100%; }
      .dpsc-attr-block {
        flex: 1; display: flex; flex-direction: column;
        align-items: center; gap: 2px;
      }
      .dpsc-attr-icon {
        width: 30px; height: 30px; object-fit: contain;
        background: none; border: none; box-shadow: none;
      }
      .dpsc-attr-label { font-size: .7rem; font-weight: 700; opacity: .7; }
      .dpsc-roll-btn {
        font-size: .75rem; font-weight: 800;
        padding: 3px 8px; border-radius: 8px;
        border: 2px solid rgba(91,63,38,.85);
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        color: #3b2a19; cursor: pointer;
        transition: filter .1s, transform .1s;
        white-space: nowrap;
        line-height: 1.3;
      }
      .dpsc-roll-btn:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
      .dpsc-roll-btn:disabled { opacity: .35; cursor: not-allowed; transform: none; filter: none; }
      .dpsc-roll-btn.is-done {
        background: linear-gradient(180deg, #c8e6c9, #a5d6a7);
        border-color: #2e7d32;
      }
      .dpsc-plus-sep { font-weight: 900; opacity: .55; flex-shrink: 0; }

      /* Die value chips */
      .dpsc-die-row {
        display: flex; align-items: center; justify-content: center; gap: 5px;
        width: 100%;
      }
      .dpsc-die-chip {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 34px; height: 34px; border-radius: 8px;
        background: rgba(0,0,0,.08); border: 1.5px solid rgba(0,0,0,.18);
        font-weight: 900; font-size: 1.05rem; color: #3b2a19;
        transition: transform .15s;
      }
      .dpsc-die-chip.pop { animation: dpsc-pop .25s cubic-bezier(.22,1,.36,1); }
      @keyframes dpsc-pop {
        0%  { transform: scale(1); }
        45% { transform: scale(1.3); }
        100%{ transform: scale(1); }
      }

      /* Total + verdict */
      .dpsc-result-block { display: flex; flex-direction: column; align-items: center; gap: 3px; }
      .dpsc-total { font-size: 1.5rem; font-weight: 900; line-height: 1; }
      .dpsc-verdict {
        font-size: .75rem; font-weight: 800; padding: 2px 9px; border-radius: 6px;
        text-transform: uppercase; letter-spacing: .05em;
      }
      .dpsc-verdict.pass   { background: rgba(46,125,50,.18);  color: #2f8a3a; }
      .dpsc-verdict.fail   { background: rgba(179,58,47,.18);  color: #b33a2f; }
      .dpsc-verdict.crit   { background: rgba(181,124,0,.2);   color: #7a5000; }
      .dpsc-verdict.fumble { background: rgba(100,0,0,.18);    color: #7a0000; }

      /* Sep */
      .dpsc-sep { width: 80%; height: 1px; background: rgba(0,0,0,.14); flex-shrink: 0; }

      /* Invoke area */
      .dpsc-invoke-area { display: flex; flex-direction: column; gap: 4px; width: 100%; }
      .dpsc-invoke-btn {
        font-size: .73rem; font-weight: 700; padding: 4px 7px;
        border-radius: 8px; border: 1.5px solid rgba(91,63,38,.8);
        background: linear-gradient(180deg, #f6ebd3, #d9c4a4);
        color: #3b2a19; cursor: pointer; text-align: left;
        transition: filter .1s;
      }
      .dpsc-invoke-btn:hover:not(:disabled) { filter: brightness(1.07); }
      .dpsc-invoke-btn:disabled { opacity: .35; cursor: not-allowed; }
      .dpsc-invoke-btn.used { opacity: .35; text-decoration: line-through; cursor: not-allowed; }

      /* Confirm */
      .dpsc-confirm-btn {
        width: 100%; padding: 6px; font-size: .82rem; font-weight: 800;
        border-radius: 10px; border: 2px solid #2e7d32;
        background: linear-gradient(180deg, #4caf50, #2e7d32);
        color: #fff; cursor: pointer; letter-spacing: .03em;
        box-shadow: 0 3px 8px rgba(0,0,0,.2);
        transition: filter .1s, transform .1s;
      }
      .dpsc-confirm-btn:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
      .dpsc-confirm-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; }

      .dpsc-waiting    { font-size: .78rem; opacity: .55; font-style: italic; text-align: center; }
      .dpsc-confirmed  { font-size: .78rem; color: #2f8a3a; font-weight: 700; text-align: center; }
    `;
    document.head.appendChild(s);
  }

  // =========================================================================
  // Session state
  // =========================================================================
  let _session = null; // { sessionId, panelStates: Map<uuid,st>, backdropEl, dl }

  // =========================================================================
  // Panel HTML builder
  // =========================================================================
  function buildPanelHtml(pd) {
    const isSingle = pd.attrA === pd.attrB;
    const iconA    = ATTR_ICONS[pd.attrA] ?? ATTR_ICONS.DEX;
    const iconB    = ATTR_ICONS[pd.attrB] ?? ATTR_ICONS.MIG;

    const attrBtnA = `
      <div class="dpsc-attr-block">
        <img class="dpsc-attr-icon" src="${iconA}" title="${pd.attrA}">
        <div class="dpsc-attr-label">${pd.attrA}</div>
        <button class="dpsc-roll-btn" data-die="A" data-uuid="${pd.actorUuid}">d${pd.dieA}</button>
      </div>`;

    const attrBtnB = `
      <div class="dpsc-attr-block">
        <img class="dpsc-attr-icon" src="${iconB}" title="${pd.attrB}">
        <div class="dpsc-attr-label">${pd.attrB}</div>
        <button class="dpsc-roll-btn" data-die="B" data-uuid="${pd.actorUuid}">d${pd.dieB}</button>
      </div>`;

    const rollRow = isSingle
      ? attrBtnA
      : `${attrBtnA}<div class="dpsc-plus-sep">+</div>${attrBtnB}`;

    return `
      <div class="dpsc-panel" data-uuid="${pd.actorUuid}">
        <div class="dpsc-portrait">
          <img src="${esc(pd.tokenImg)}" onerror="this.src='icons/svg/mystery-man.svg'">
        </div>
        <div class="dpsc-actor-name" title="${esc(pd.actorName)}">${esc(pd.actorName)}</div>

        <!-- roll buttons -->
        <div class="dpsc-roll-row" data-zone="roll">${rollRow}</div>

        <!-- die chips (hidden until rolled) -->
        <div class="dpsc-die-row" data-zone="dice" style="display:none">
          <div class="dpsc-die-chip" data-chip="A">—</div>
          ${!isSingle ? `<div class="dpsc-plus-sep">+</div><div class="dpsc-die-chip" data-chip="B">—</div>` : ""}
        </div>

        <!-- total + verdict -->
        <div class="dpsc-result-block" data-zone="result" style="display:none">
          <div class="dpsc-total" data-field="total">—</div>
          <div class="dpsc-verdict" data-field="verdict"></div>
        </div>

        <div class="dpsc-sep" data-zone="sep1" style="display:none"></div>

        <!-- invoke buttons -->
        <div class="dpsc-invoke-area" data-zone="invoke" style="display:none">
          <button class="dpsc-invoke-btn" data-action="trait"     data-uuid="${pd.actorUuid}">🎭 Invoke Trait</button>
          <button class="dpsc-invoke-btn" data-action="bond"      data-uuid="${pd.actorUuid}">🤝 Invoke Bond</button>
          <button class="dpsc-invoke-btn" data-action="divination" data-uuid="${pd.actorUuid}">🔮 Divination</button>
        </div>

        <div class="dpsc-sep" data-zone="sep2" style="display:none"></div>

        <!-- confirm / waiting / done -->
        <button class="dpsc-confirm-btn" data-uuid="${pd.actorUuid}" data-zone="confirm" style="display:none">✓ Confirm</button>
        <div class="dpsc-confirmed" data-zone="confirmed" style="display:none">Confirmed ✓</div>
        <div class="dpsc-waiting"   data-zone="waiting">Waiting…</div>
      </div>`;
  }

  // =========================================================================
  // DOM helpers
  // =========================================================================
  const getPanelEl = (uuid) =>
    _session?.backdropEl?.querySelector(`.dpsc-panel[data-uuid="${CSS.escape(uuid)}"]`);

  const zone = (panelEl, name) => panelEl?.querySelector(`[data-zone="${name}"]`);
  const showZone = (panelEl, name, visible) => {
    const el = zone(panelEl, name);
    if (el) el.style.display = visible ? "" : "none";
  };

  // =========================================================================
  // Sync panel DOM from its state object
  // =========================================================================
  function syncPanel(uuid) {
    const ses = _session;
    if (!ses) return;
    const st  = ses.panelStates.get(uuid);
    const el  = getPanelEl(uuid);
    if (!st || !el) return;

    const isOwner  = canOwnerAct(uuid);
    const isSingle = st.attrA === st.attrB;
    const hasA     = st.rollA !== null;
    const hasB     = st.rollB !== null;
    const allRolled = hasA && (isSingle || hasB);

    // ── Roll buttons ──────────────────────────────────────────────────────
    showZone(el, "roll", !allRolled);
    if (!allRolled) {
      const btnA = el.querySelector(`[data-die="A"][data-uuid="${uuid}"]`);
      const btnB = el.querySelector(`[data-die="B"][data-uuid="${uuid}"]`);
      if (btnA) { btnA.disabled = !isOwner || st.confirmed || hasA; if (hasA) btnA.classList.add("is-done"); }
      if (btnB && !isSingle) { btnB.disabled = !isOwner || st.confirmed || hasB; if (hasB) btnB.classList.add("is-done"); }
    }

    // ── Die chips ─────────────────────────────────────────────────────────
    if (allRolled) {
      showZone(el, "dice", true);
      const chipA = el.querySelector("[data-chip='A']");
      const chipB = el.querySelector("[data-chip='B']");
      if (chipA) chipA.textContent = String(st.rollA);
      if (chipB) chipB.textContent = String(isSingle ? st.rollA : (st.rollB ?? st.rollA));
    } else {
      showZone(el, "dice", false);
    }

    // ── Total + verdict ───────────────────────────────────────────────────
    if (allRolled && st.result) {
      showZone(el, "result", true);
      showZone(el, "sep1",   true);
      const totalEl   = el.querySelector("[data-field='total']");
      const verdictEl = el.querySelector("[data-field='verdict']");
      if (totalEl) totalEl.textContent = String(st.result.total);
      if (verdictEl) {
        verdictEl.className = "dpsc-verdict";
        if (st.result.isFumble)     { verdictEl.textContent = "FUMBLE";    verdictEl.classList.add("fumble"); }
        else if (st.result.isCrit)  { verdictEl.textContent = "CRITICAL!"; verdictEl.classList.add("crit");   }
        else if (st.result.pass === true)  { verdictEl.textContent = `✓ DL ${ses.dl}`; verdictEl.classList.add("pass"); }
        else if (st.result.pass === false) { verdictEl.textContent = `✗ DL ${ses.dl}`; verdictEl.classList.add("fail"); }
        else { verdictEl.textContent = `Total ${st.result.total}`; }
      }
    } else {
      showZone(el, "result", false);
      showZone(el, "sep1",   false);
    }

    // ── Invoke area ───────────────────────────────────────────────────────
    const canInvoke  = isOwner && allRolled && !st.confirmed && !st.result?.isFumble;
    const anyInvoke  = st.canTrait || st.canBond || st.canDivination;
    showZone(el, "invoke", canInvoke && anyInvoke);
    if (canInvoke && anyInvoke) {
      const trBtn  = el.querySelector("[data-action='trait']");
      const bnBtn  = el.querySelector("[data-action='bond']");
      const divBtn = el.querySelector("[data-action='divination']");
      const applyBtn = (btn, used, can) => {
        if (!btn) return;
        btn.disabled = used || !can;
        btn.classList.toggle("used", used);
      };
      applyBtn(trBtn,  st.usedTrait,      st.canTrait);
      applyBtn(bnBtn,  st.usedBond,       st.canBond);
      applyBtn(divBtn, st.usedDivination, st.canDivination);
    }

    // ── Confirm / waiting / done ──────────────────────────────────────────
    showZone(el, "sep2",      !st.confirmed);
    showZone(el, "confirm",   isOwner && allRolled && !st.confirmed);
    showZone(el, "confirmed", st.confirmed);
    showZone(el, "waiting",   !isOwner && !st.confirmed);

    if (st.confirmed) el.classList.add("is-confirmed");
    else              el.classList.remove("is-confirmed");
  }

  // =========================================================================
  // Rolling animation (local, plays on the client doing the roll or receiving
  // the broadcast for non-owners)
  // =========================================================================
  async function animateDie(panelEl, chipSel, finalValue, faces) {
    const chip = panelEl?.querySelector(`[data-chip="${chipSel}"]`);
    if (!chip) return;

    // Make dice row visible during animation
    const diceRow = panelEl.querySelector("[data-zone='dice']");
    if (diceRow) diceRow.style.display = "";

    const TICK = 55;
    const STEPS = Math.ceil(700 / TICK);
    for (let i = 0; i < STEPS; i++) {
      chip.textContent = String(Math.floor(Math.random() * faces) + 1);
      await wait(TICK);
    }
    chip.textContent = String(finalValue);
    chip.classList.remove("pop");
    void chip.offsetWidth; // reflow to restart animation
    chip.classList.add("pop");

    try {
      const sfx = globalThis.ONI?.CheckRoller?.CONST?.DEFAULTS?.UI_TUNING?.rollSfxUrl;
      if (sfx) AudioHelper.play({ src: sfx, volume: 0.55, autoplay: true }, false);
    } catch (_) {}
  }

  // =========================================================================
  // Open overlay (all clients)
  // =========================================================================
  function openOverlay(data) {
    closeOverlay();
    ensureStyles();

    const { sessionId, panels, dl, tileLabel } = data;

    const backdrop = document.createElement("div");
    backdrop.className = "dpsc-backdrop";
    backdrop.id = "dpsc-backdrop";

    // Title bar
    const titleEl = document.createElement("div");
    titleEl.className = "dpsc-title";
    titleEl.textContent = [
      tileLabel ? `Skill Check — ${tileLabel}` : "Skill Check",
      dl != null ? `(DL ${dl})` : "",
    ].filter(Boolean).join(" ");
    backdrop.appendChild(titleEl);

    // Panels row
    const row = document.createElement("div");
    row.className = "dpsc-panels";
    row.innerHTML  = panels.map(buildPanelHtml).join("");
    backdrop.appendChild(row);

    document.body.appendChild(backdrop);

    // Build panel state map
    const panelStates = new Map();
    for (const pd of panels) {
      panelStates.set(pd.actorUuid, {
        ...pd,
        rollA: null, rollB: null,
        result: null, modifierParts: [],
        canTrait: false, usedTrait: false,
        canBond: false,  usedBond: false,
        canDivination: false, usedDivination: false,
        confirmed: false,
        _actor: null, _bonds: null,
      });
    }

    _session = { sessionId, panelStates, backdropEl: backdrop, dl };

    // Wire click handler (single delegated listener)
    backdrop.addEventListener("click", async (ev) => {
      const rollBtn    = ev.target.closest(".dpsc-roll-btn");
      const invokeBtn  = ev.target.closest(".dpsc-invoke-btn");
      const confirmBtn = ev.target.closest(".dpsc-confirm-btn");
      if (rollBtn)    await onRollClick(rollBtn).catch(e => console.error(TAG, e));
      if (invokeBtn)  await onInvokeClick(invokeBtn).catch(e => console.error(TAG, e));
      if (confirmBtn) await onConfirmClick(confirmBtn).catch(e => console.error(TAG, e));
    });

    // Initial sync
    for (const [uuid] of panelStates) {
      syncPanel(uuid);
      if (canOwnerAct(uuid)) loadInvokeAvailability(uuid);
    }

    console.debug(TAG, "Overlay opened", { sessionId });
  }

  // =========================================================================
  // Load invoke availability for an owned actor (async)
  // =========================================================================
  async function loadInvokeAvailability(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    if (!st) return;

    const actor = await resolveActor(uuid);
    if (!actor || !ses || _session?.sessionId !== ses.sessionId) return;

    const fp    = getFP(actor);
    const bonds = collectBonds(actor);

    st._actor  = actor;
    st._bonds  = bonds;
    st.canTrait = fp >= 1;
    st.canBond  = fp >= 1 && bonds.length > 0;
    st.canDivination = !!findDivinationAe(actor);

    syncPanel(uuid);
  }

  // =========================================================================
  // Close overlay (all clients)
  // =========================================================================
  function closeOverlay() {
    _session?.backdropEl?.remove();
    _session = null;
  }

  // =========================================================================
  // Roll button handler
  // =========================================================================
  async function onRollClick(btn) {
    const ses  = _session;
    if (!ses) return;
    const uuid = btn.dataset.uuid;
    const die  = btn.dataset.die; // "A" or "B"
    if (!canOwnerAct(uuid)) return;

    const st = ses.panelStates.get(uuid);
    if (!st || st.confirmed) return;

    const isSingle = st.attrA === st.attrB;

    // Guard against duplicate rolls
    if (die === "A" && st.rollA !== null) return;
    if (die === "B" && (st.rollB !== null || isSingle)) return;

    btn.disabled = true;

    const faces = die === "A" ? st.dieA : st.dieB;

    // For single-attribute, rolling "A" also gives us dieB in one shot
    if (isSingle && die === "A") {
      const valA = await rollDie(st.dieA);
      const valB = await rollDie(st.dieA); // second independent roll
      // Mark locally before broadcast (so echo is ignored)
      st.rollA = valA;
      st.rollB = valB;
      // Broadcast
      game.socket.emit(SOCKET_CH, {
        type: MSG_ROLL,
        payload: { sessionId: ses.sessionId, uuid, die: "BOTH", rollA: valA, rollB: valB },
      });
      // Animate locally (show chip A only for single-attr)
      const panelEl = getPanelEl(uuid);
      if (panelEl) await animateDie(panelEl, "A", valA, st.dieA);
      afterAllRolled(uuid);
      return;
    }

    // Normal two-attribute case
    const value = await rollDie(faces);
    // Mark locally
    if (die === "A") st.rollA = value;
    else             st.rollB = value;
    // Broadcast
    game.socket.emit(SOCKET_CH, {
      type: MSG_ROLL,
      payload: { sessionId: ses.sessionId, uuid, die, value },
    });
    // Animate locally
    const panelEl = getPanelEl(uuid);
    if (panelEl) await animateDie(panelEl, die, value, faces);
    afterAllRolled(uuid);
  }

  // ── Called after any die is set; computes result if complete ─────────────
  function afterAllRolled(uuid) {
    const ses = _session;
    if (!ses) return;
    const st  = ses.panelStates.get(uuid);
    if (!st) return;

    const isSingle = st.attrA === st.attrB;
    const allDone  = st.rollA !== null && (isSingle || st.rollB !== null);
    if (!allDone) { syncPanel(uuid); return; }

    const rA = st.rollA;
    const rB = isSingle ? st.rollA : (st.rollB ?? st.rollA);
    st.result = computeCheck(rA, rB, st.modifierParts, ses.dl);

    syncPanel(uuid);

    if (canOwnerAct(uuid)) scheduleAutoConfirm(uuid);
  }

  // =========================================================================
  // Auto-confirm when no invoke options exist or result is fumble
  // =========================================================================
  async function scheduleAutoConfirm(uuid) {
    const ses = _session;
    if (!ses) return;

    // Brief wait for loadInvokeAvailability to resolve
    await wait(400);
    if (!_session || _session.sessionId !== ses.sessionId) return;

    const st = ses.panelStates.get(uuid);
    if (!st || st.confirmed) return;

    const isFumble  = st.result?.isFumble;
    const noOptions = !st.canTrait && !st.canBond && !st.canDivination;

    if (isFumble || noOptions) {
      await wait(900); // show result briefly before auto-confirm
      if (_session?.sessionId === ses.sessionId && !st.confirmed) {
        await doConfirm(uuid);
      }
    }
  }

  // =========================================================================
  // Invoke: Trait
  // =========================================================================
  async function onInvokeClick(btn) {
    const action = btn.dataset.action;
    const uuid   = btn.dataset.uuid;
    if (!canOwnerAct(uuid)) return;
    if (action === "trait")     await invokeTrait(uuid);
    else if (action === "bond") await invokeBond(uuid);
    else if (action === "divination") await invokeDivination(uuid);
  }

  async function invokeTrait(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    if (!st || st.usedTrait || st.result?.isFumble) return;

    const actor = st._actor ?? await resolveActor(uuid);
    if (!actor || getFP(actor) < 1) {
      ui.notifications?.warn("Not enough Fabula Points (need 1).");
      return;
    }

    const isSingle = st.attrA === st.attrB;
    const iconA    = ATTR_ICONS[st.attrA] ?? "";
    const iconB    = ATTR_ICONS[st.attrB] ?? "";
    const rA = st.rollA;
    const rB = isSingle ? st.rollA : (st.rollB ?? st.rollA);

    const choice = await new Promise(resolve => {
      const rowA = `<div class="dpsc-tr-row" data-c="A">
        <img src="${iconA}"><div class="lbl">${st.attrA} (d${st.dieA})</div><div class="val">${rA}</div></div>`;
      const rowB = !isSingle
        ? `<div class="dpsc-tr-row" data-c="B">
            <img src="${iconB}"><div class="lbl">${st.attrB} (d${st.dieB})</div><div class="val">${rB}</div></div>
           <div class="dpsc-tr-row" data-c="AB"><div class="lbl" style="text-align:center">Both dice</div></div>`
        : "";

      new Dialog({
        title: "Invoke Trait — Choose dice to reroll",
        content: `
          <style>
            .dpsc-tr-row{display:flex;align-items:center;gap:8px;padding:8px 12px;
              border-radius:10px;border:2px solid rgba(91,63,38,.7);
              background:linear-gradient(180deg,#f6ebd3,#e4d0b5);
              cursor:pointer;transition:filter .1s;margin-bottom:5px;}
            .dpsc-tr-row:hover{filter:brightness(1.05);}
            .dpsc-tr-row.on{outline:2px solid #e35151;}
            .dpsc-tr-row img{width:24px;height:24px;object-fit:contain;background:none;border:none;}
            .dpsc-tr-row .lbl{flex:1;font-weight:800;}
            .dpsc-tr-row .val{font-size:1.1rem;font-weight:900;}
          </style>
          ${rowA}${rowB}`,
        buttons: {
          ok:     { label: "Reroll",  callback: html => { const on = html[0].querySelector(".dpsc-tr-row.on"); resolve(on?.dataset.c ?? null); } },
          cancel: { label: "Cancel",  callback: () => resolve(null) },
        },
        default: "ok",
        close:   () => resolve(null),
        render: html => {
          html[0].querySelectorAll(".dpsc-tr-row").forEach(r =>
            r.addEventListener("click", () => {
              html[0].querySelectorAll(".dpsc-tr-row").forEach(x => x.classList.remove("on"));
              r.classList.add("on");
            })
          );
        },
      }).render(true);
    });

    if (!choice) return;

    // Spend FP
    await actor.update({ "system.props.fabula_point": getFP(actor) - 1 });

    // Reroll chosen dice
    let newA = rA, newB = rB;
    if (choice === "A" || choice === "AB") newA = await rollDie(st.dieA);
    if ((choice === "B" || choice === "AB") && !isSingle) newB = await rollDie(st.dieB);

    st.usedTrait = true;
    st.canTrait  = false;
    st.rollA     = newA;
    if (!isSingle) st.rollB = newB;
    st.result = computeCheck(newA, isSingle ? newA : newB, st.modifierParts, ses.dl);

    broadcastUpdate(uuid);
    syncPanel(uuid);
  }

  // =========================================================================
  // Invoke: Bond
  // =========================================================================
  async function invokeBond(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    if (!st || st.usedBond || st.result?.isFumble) return;

    const actor = st._actor ?? await resolveActor(uuid);
    if (!actor || getFP(actor) < 1) {
      ui.notifications?.warn("Not enough Fabula Points (need 1).");
      return;
    }

    const bonds = st._bonds ?? collectBonds(actor);
    if (!bonds.length) { ui.notifications?.warn("No bonds found on this actor."); return; }

    const bond = await new Promise(resolve => {
      const HEART_POS = "❤";
      const HEART_NEG = "💜";
      const rowHtml = b => `
        <div class="oni-bond-row" tabindex="0" data-idx="${b.idx}">
          <div class="oni-bond-name">${esc(b.name)}</div>
          <div class="oni-bond-hearts">${HEART_POS.repeat(b.filledPos)}${HEART_NEG.repeat(b.filledNeg)}</div>
          <div class="oni-bond-bonus">+${b.bonus}</div>
        </div>`;

      new Dialog({
        title: "Invoke Bond — Choose a Bond",
        content: `<form>
          <style>
            .oni-bond-list{display:flex;flex-direction:column;gap:.4rem;margin:.2rem 0;}
            .oni-bond-row{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;
              padding:.5rem .7rem;border-radius:12px;cursor:pointer;
              border:2.5px solid rgba(87,58,33,.9);
              background:linear-gradient(180deg,#f6ebd3,#e8d3b1);
              transition:filter .1s;}
            .oni-bond-row:hover{filter:brightness(1.04);}
            .oni-bond-row.on{outline:3px solid #e35151;}
            .oni-bond-name{font-weight:800;}
            .oni-bond-bonus{font-weight:900;min-width:3ch;text-align:right;}
          </style>
          <div class="oni-bond-list">${bonds.map(rowHtml).join("")}</div>
        </form>`,
        buttons: {
          ok:     { label: "Invoke", callback: html => {
            const on = html[0].querySelector(".oni-bond-row.on");
            if (!on) return resolve(null);
            resolve(bonds.find(b => b.idx === parseInt(on.dataset.idx, 10)) ?? null);
          }},
          cancel: { label: "Cancel", callback: () => resolve(null) },
        },
        default: "ok",
        close:   () => resolve(null),
        render: html => {
          html[0].querySelectorAll(".oni-bond-row").forEach(r =>
            r.addEventListener("click", () => {
              html[0].querySelectorAll(".oni-bond-row").forEach(x => x.classList.remove("on"));
              r.classList.add("on");
            })
          );
        },
      }).render(true);
    });

    if (!bond) return;

    // Spend FP + apply bonus
    await actor.update({ "system.props.fabula_point": getFP(actor) - 1 });

    st.modifierParts = [...(st.modifierParts ?? []), { label: `Bond: ${bond.name}`, value: bond.bonus }];
    const isSingle = st.attrA === st.attrB;
    const rA = st.rollA;
    const rB = isSingle ? rA : (st.rollB ?? rA);
    st.result = computeCheck(rA, rB, st.modifierParts, ses.dl);
    st.usedBond = true;
    st.canBond  = false;

    broadcastUpdate(uuid);
    syncPanel(uuid);
  }

  // =========================================================================
  // Invoke: Divination
  // =========================================================================
  async function invokeDivination(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    if (!st || st.usedDivination) return;

    if (st.result?.isCrit || st.result?.isFumble) {
      ui.notifications?.warn("Critical and Fumble outcomes cannot be rerolled.");
      return;
    }

    const actor = st._actor ?? await resolveActor(uuid);
    if (!actor) return;

    const ae = findDivinationAe(actor);
    if (!ae) { ui.notifications?.warn("No Divination charges remaining."); return; }

    // Reroll both dice regardless of single/dual attr
    const newA = await rollDie(st.dieA);
    const newB = await rollDie(st.dieB);

    const consumeRes = await consumeDivinationCharge(actor);
    if (!consumeRes.ok) { ui.notifications?.error("Failed to consume Divination charge."); return; }

    const isSingle = st.attrA === st.attrB;
    st.rollA = newA;
    if (!isSingle) st.rollB = newB;
    st.result = computeCheck(newA, isSingle ? newA : newB, st.modifierParts, ses.dl);
    st.usedDivination = true;
    st.canDivination  = false;

    broadcastUpdate(uuid);
    syncPanel(uuid);

    ui.notifications?.info(
      consumeRes.remaining > 0
        ? `Divination used. ${consumeRes.remaining} charge${consumeRes.remaining === 1 ? "" : "s"} remaining.`
        : "Divination used. Active Effect ended."
    );
  }

  // =========================================================================
  // Broadcast post-invoke state to all clients
  // =========================================================================
  function broadcastUpdate(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    if (!st) return;
    game.socket.emit(SOCKET_CH, {
      type: MSG_UPDATE,
      payload: {
        sessionId:     ses.sessionId,
        uuid,
        rollA:         st.rollA,
        rollB:         st.rollB,
        modifierParts: st.modifierParts,
        usedTrait:     st.usedTrait,
        usedBond:      st.usedBond,
        usedDivination:st.usedDivination,
      },
    });
  }

  // =========================================================================
  // Confirm button
  // =========================================================================
  async function onConfirmClick(btn) {
    const uuid = btn.dataset.uuid;
    if (!canOwnerAct(uuid)) return;
    await doConfirm(uuid);
  }

  async function doConfirm(uuid) {
    const ses = _session;
    if (!ses) return;
    const st = ses.panelStates.get(uuid);
    if (!st || st.confirmed) return;
    if (!canOwnerAct(uuid)) return;

    const isSingle = st.attrA === st.attrB;
    const rA  = st.rollA ?? 0;
    const rB  = isSingle ? rA : (st.rollB ?? rA);
    const res = st.result ?? computeCheck(rA, rB, st.modifierParts, ses.dl);

    st.confirmed = true;
    syncPanel(uuid);

    game.socket.emit(SOCKET_CH, {
      type: MSG_CONFIRM,
      payload: {
        sessionId:     ses.sessionId,
        actorUuid:     uuid,
        actorName:     st.actorName,
        attrA:         st.attrA,
        attrB:         st.attrB,
        dieA:          st.dieA,
        dieB:          st.dieB,
        rollA:         rA,
        rollB:         rB,
        modifierParts: st.modifierParts,
        total:         res.total,
        pass:          res.pass,
        isCrit:        res.isCrit,
        isFumble:      res.isFumble,
      },
    });
  }

  // =========================================================================
  // Post-check chat card (GM side, called for each confirmed actor)
  // =========================================================================
  async function postChatCard(cp, tileLabel, dl) {
    const { actorName, attrA, attrB, dieA, dieB,
            rollA, rollB, total, pass, isCrit, isFumble, modifierParts } = cp;
    const modTotal = (modifierParts ?? []).reduce((a, p) => a + safeInt(p?.value, 0), 0);
    const hr   = Math.max(rollA, rollB);
    const base = rollA + rollB;

    let badge = "";
    if (isFumble) badge = `<span style="display:inline-block;padding:1px 7px;border-radius:4px;background:#7a0000;color:#fff;font-size:.73rem;font-weight:800;margin-left:6px;">FUMBLE</span>`;
    else if (isCrit) badge = `<span style="display:inline-block;padding:1px 7px;border-radius:4px;background:#7a5000;color:#fff;font-size:.73rem;font-weight:800;margin-left:6px;">CRITICAL</span>`;

    let verdictHtml = "";
    if (dl != null) {
      const v  = pass ? "PASS" : "FAIL";
      const vc = pass ? "#2f8a3a" : "#b33a2f";
      verdictHtml = `<div style="margin-top:5px;font-weight:800;font-size:.92rem;color:${vc};">DL ${dl}: ${v}</div>`;
    }

    const modLines = (modifierParts ?? [])
      .filter(p => p?.label && safeInt(p.value, 0) !== 0)
      .map(p => `<div>${esc(p.label)}: <b>${p.value >= 0 ? "+" : ""}${p.value}</b></div>`)
      .join("");

    await ChatMessage.create({
      speaker: { alias: actorName },
      content: `
        <div style="font-family:inherit;padding:8px 10px;border-radius:8px;
          background:linear-gradient(180deg,#f6ebd3,#e4d0b5);
          border:2px solid rgba(91,63,38,.8);color:#3b2a19;">
          <div style="font-weight:800;font-size:1rem;margin-bottom:5px;
            border-bottom:1px solid rgba(0,0,0,.15);padding-bottom:3px;">
            ${esc(actorName)} — Check Roll ${badge}
            ${tileLabel ? `<span style="opacity:.6;font-size:.8rem;margin-left:4px;">[${esc(tileLabel)}]</span>` : ""}
          </div>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:.88rem;">
            <span style="opacity:.6;">Formula</span><span>${esc(attrA)} + ${esc(attrB)}</span>
            <span style="opacity:.6;">Dice</span><span>d${dieA} + d${dieB}</span>
            <span style="opacity:.6;">Rolls</span><span>${rollA}, ${rollB} <span style="opacity:.55;">(HR ${hr})</span></span>
            <span style="opacity:.6;">Base</span><span>${base}</span>
            ${modTotal !== 0 ? `<span style="opacity:.6;">Modifier</span><span>${modTotal >= 0 ? "+" : ""}${modTotal}</span>` : ""}
            <span style="opacity:.6;font-weight:800;">Total</span><span style="font-weight:800;font-size:1rem;">${total}</span>
          </div>
          ${modLines ? `<div style="margin-top:4px;font-size:.78rem;opacity:.65;">${modLines}</div>` : ""}
          ${verdictHtml}
        </div>`,
    }).catch(e => console.warn(TAG, "ChatMessage.create failed:", e));
  }

  // =========================================================================
  // Socket listener
  // =========================================================================
  const _pendingSessions = new Map(); // sessionId → { confirms, checkComplete }
  const SL_GUARD = "__ONI_DP_SC_SOCKET__";

  function setupSocket() {
    if (window[SL_GUARD]) return;
    window[SL_GUARD] = true;

    game.socket.on(SOCKET_CH, async (msg) => {
      if (!msg?.type?.startsWith("DP_SC_")) return;

      // ── Open overlay ────────────────────────────────────────────────────
      if (msg.type === MSG_OPEN) {
        openOverlay(msg.payload);
        return;
      }

      // ── Die result ──────────────────────────────────────────────────────
      if (msg.type === MSG_ROLL) {
        const { sessionId, uuid, die, value, rollA, rollB } = msg.payload ?? {};
        const ses = _session;
        if (!ses || ses.sessionId !== sessionId) return;
        const st = ses.panelStates.get(uuid);
        if (!st) return;

        if (die === "BOTH") {
          // Skip if already applied locally (sender)
          if (st.rollA !== null) return;
          st.rollA = rollA; st.rollB = rollB;
          const panelEl = getPanelEl(uuid);
          if (panelEl) await animateDie(panelEl, "A", rollA, st.dieA);
          afterAllRolled(uuid);
        } else {
          // Skip if already applied
          if (die === "A" && st.rollA !== null) return;
          if (die === "B" && st.rollB !== null) return;
          if (die === "A") st.rollA = value;
          else             st.rollB = value;
          const panelEl = getPanelEl(uuid);
          const faces   = die === "A" ? st.dieA : st.dieB;
          if (panelEl) await animateDie(panelEl, die, value, faces);
          afterAllRolled(uuid);
        }
        return;
      }

      // ── Post-invoke update ───────────────────────────────────────────────
      if (msg.type === MSG_UPDATE) {
        const { sessionId, uuid, rollA, rollB, modifierParts,
                usedTrait, usedBond, usedDivination } = msg.payload ?? {};
        const ses = _session;
        if (!ses || ses.sessionId !== sessionId) return;
        const st = ses.panelStates.get(uuid);
        if (!st) return;

        st.rollA          = rollA;
        st.rollB          = rollB;
        st.modifierParts  = modifierParts ?? [];
        st.usedTrait      = usedTrait;
        st.usedBond       = usedBond;
        st.usedDivination = usedDivination;

        const isSingle = st.attrA === st.attrB;
        const rA = st.rollA;
        const rB = isSingle ? rA : (st.rollB ?? rA);
        if (rA !== null) st.result = computeCheck(rA, rB, st.modifierParts, ses.dl);

        syncPanel(uuid);
        return;
      }

      // ── Actor confirmed ──────────────────────────────────────────────────
      if (msg.type === MSG_CONFIRM) {
        const { sessionId, actorUuid } = msg.payload ?? {};
        // All clients: mark panel confirmed
        const ses = _session;
        if (ses && ses.sessionId === sessionId) {
          const st = ses.panelStates.get(actorUuid);
          if (st) { st.confirmed = true; syncPanel(actorUuid); }
        }
        // GM collects
        if (game.user?.isGM) {
          const pending = _pendingSessions.get(sessionId);
          if (pending) {
            pending.confirms.set(actorUuid, msg.payload);
            pending.checkComplete();
          }
        }
        return;
      }

      // ── Close ────────────────────────────────────────────────────────────
      if (msg.type === MSG_CLOSE) {
        if (_session?.sessionId === msg.payload?.sessionId) closeOverlay();
        return;
      }
    });

    console.debug(TAG, "Socket listener installed.");
  }

  // =========================================================================
  // Public: request()  — GM-only entry point called by the effect engine
  // =========================================================================
  async function request(actors, cfg, context = {}) {
    if (!game.user?.isGM) throw new Error(`${TAG} request() must be called on the GM.`);
    if (!actors.length) return [];

    const { tileLabel = "" } = context;
    const sessionId = foundry.utils.randomID();
    const dl        = cfg.checkDl ?? 10;
    const attrA     = cfg.checkAttrA ?? "DEX";
    const attrB     = cfg.checkAttrB ?? "MIG";

    // Build panel descriptors
    const panels = actors.map(actor => {
      const dieA = getDieSize(actor, attrA);
      const dieB = getDieSize(actor, attrB);

      let tokenImg = actor.img ?? "icons/svg/mystery-man.svg";
      const tokens = actor.getActiveTokens?.(true, true) ?? [];
      if (tokens[0]?.document?.texture?.src) tokenImg = tokens[0].document.texture.src;

      return { actorUuid: actor.uuid, actorName: actor.name, tokenImg, attrA, attrB, dieA, dieB };
    });

    // GM-side promise: resolves when all actors have confirmed
    let _resolve;
    const done = new Promise(res => { _resolve = res; });
    const confirms = new Map();

    _pendingSessions.set(sessionId, {
      confirms,
      checkComplete() {
        if (confirms.size >= actors.length) _resolve(Array.from(confirms.values()));
      },
    });

    // Broadcast open (to players; GM opens locally below)
    game.socket.emit(SOCKET_CH, { type: MSG_OPEN, payload: { sessionId, panels, dl, tileLabel } });
    openOverlay({ sessionId, panels, dl, tileLabel });

    // Wait for all confirmations
    const confirmPayloads = await done;
    _pendingSessions.delete(sessionId);

    // Post chat cards
    for (const cp of confirmPayloads) {
      await postChatCard(cp, tileLabel, dl);
    }

    // Close overlay on all clients
    game.socket.emit(SOCKET_CH, { type: MSG_CLOSE, payload: { sessionId } });
    closeOverlay();

    // Return pass/fail per actor
    return confirmPayloads.map(cp => ({ actorUuid: cp.actorUuid, pass: cp.pass === true }));
  }

  // =========================================================================
  // Boot
  // =========================================================================
  DP.TileSkillCheck = { request };

  Hooks.once("ready", () => {
    setupSocket();
    console.debug(TAG, "Ready.");
  });
})();
