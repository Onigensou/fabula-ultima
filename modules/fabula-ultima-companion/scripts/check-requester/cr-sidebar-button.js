// ============================================================================
// Check Requester — Sidebar Button
//
// GM-only floating button (🎯). Opens a dialog to request either a
// normal Skill Check or a Group Check (leader + helpers).
// Actors from db-resolver (active party). Attr pickers scroll ◀▶.
// Attr B supports "—" (None) = single-die mode.
// ============================================================================

Hooks.once("ready", () => {
  (() => {
    const TAG       = "[ONI][CheckRequester:Button]";
    const STATE_KEY = "__ONI_CR_BUTTON_STATE__";

    // ── Config ────────────────────────────────────────────────────────────
    const CFG = {
      gmOnly:         true,
      offsetRightPx:  313,
      offsetBottomPx: 322,
      sizePx:         60,
      zIndex:         83,
      iconText:       "🎯",
      label:          "Request Check",
    };

    const DOM = {
      ROOT_ID:  "oni-creq-button-root",
      BTN_ID:   "oni-creq-button",
      STYLE_ID: "oni-creq-button-style",
    };

    const STATE = (globalThis[STATE_KEY] ??= { installed: false });

    const cleanupUI = () => {
      try { document.getElementById(DOM.ROOT_ID)?.remove();  } catch (_) {}
      try { document.getElementById(DOM.STYLE_ID)?.remove(); } catch (_) {}
    };

    if (CFG.gmOnly && !game.user?.isGM) { cleanupUI(); return; }

    // ── Attribute definitions ─────────────────────────────────────────────
    const ATTR_ICONS = {
      DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
      INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
      MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
      WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png",
    };
    const ATTRS_A = ["DEX", "INS", "MIG", "WLP"];
    const ATTRS_B = ["—",   "DEX", "INS", "MIG", "WLP"]; // "—" = 1-die

    // ── Check-buff actions (multi-select) ─────────────────────────────────
    // The GM may tag a requested Check with one or more named actions. At roll
    // time each tagged action is matched — purely BY STRING — against every
    // selected actor's equipped-gear passive `check_buff` rows (check_buff_action
    // csv), and any matching +N is folded into the roll as a modifier. This is
    // the SAME engine the Study action already uses (sumEquippedCheckBuffs); the
    // dropdown just exposes it for arbitrary checks. `value` is the lowercase
    // token compared to check_buff_action (e.g. Encyclopedia carries "study").
    const CHECK_BUFF_OPTIONS = [
      { label: "Study",    value: "study" },
      { label: "Stealth",  value: "stealth" },
      { label: "Strength", value: "strength" },
      { label: "Mobility", value: "mobility" },
    ];

    // ── DB resolver ───────────────────────────────────────────────────────
    const loadPartyActors = async () => {
      try {
        const api = globalThis.FUCompanion?.api;
        if (typeof api?.getCurrentGameDb !== "function") return null;
        const resolved = await api.getCurrentGameDb();
        const db = resolved?.db;
        if (!db) return null;
        const props  = db.system?.props ?? {};
        const actors = [];
        for (let i = 1; i <= 4; i++) {
          const raw  = String(props[`member_id_${i}`] ?? "").trim();
          if (!raw) continue;
          const uuid  = raw.startsWith("Actor.") ? raw : `Actor.${raw}`;
          const actor = await fromUuid(uuid).catch(() => null);
          if (actor) actors.push(actor);
        }
        return actors.length > 0 ? actors : null;
      } catch (e) {
        console.warn(TAG, "loadPartyActors failed:", e);
        return null;
      }
    };

    const getSpriteImg = actor => {
      const std   = String(actor?.system?.props?.sprite_standard ?? "").trim();
      const proto = String(actor?.prototypeToken?.texture?.src    ?? "").trim();
      return std || proto || actor.img || "icons/svg/mystery-man.svg";
    };

    // ── Picker CSS + HTML (shared) ────────────────────────────────────────
    const PICKER_CSS = `
      .oni-creq-pickers-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
      .oni-creq-picker {
        display:grid; grid-template-columns:32px 1fr 32px;
        align-items:center; height:52px; border-radius:12px;
        border:2.5px solid rgba(87,58,33,.90);
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.55) 0%, rgba(255,255,255,.20) 22%, transparent 40%),
          linear-gradient(180deg,#fff3dc 0%,#f3e2bd 55%,#e8cea0 100%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.70), 0 4px 10px rgba(0,0,0,.10);
        overflow:hidden; user-select:none;
      }
      .oni-creq-picker.is-none { opacity:.55; border-style:dashed; }
      .oni-creq-picker-arrow {
        height:100%; width:100%; border:none; background:transparent;
        cursor:pointer; display:flex; align-items:center; justify-content:center;
        font-size:13px; opacity:.70; color:#2b1f17; padding:0;
      }
      .oni-creq-picker-arrow:hover { opacity:1; }
      .oni-creq-picker-center {
        display:flex; align-items:center; justify-content:center;
        gap:6px; overflow:hidden; height:100%;
      }
      .oni-creq-picker-icon {
        width:24px; height:24px; object-fit:contain; flex-shrink:0;
        border:none!important; background:transparent!important;
        box-shadow:none!important; outline:none!important;
      }
      .oni-creq-picker-name {
        font-size:13px; font-weight:900; color:#2b1f17;
        white-space:nowrap; min-width:2em; text-align:center;
      }
    `;

    const buildPickerHtml = (slot, attr) => {
      const isNone  = attr === "—";
      const icon    = isNone ? "" : ATTR_ICONS[attr] ?? "";
      const imgHtml = isNone
        ? `<span class="oni-creq-picker-name" style="font-size:18px;opacity:.4;">—</span>`
        : `<img class="oni-creq-picker-icon" src="${icon}" alt="${attr}">
           <div class="oni-creq-picker-name">${attr}</div>`;
      return `
        <div class="oni-creq-picker${isNone ? " is-none" : ""}" data-slot="${slot}" data-attr="${attr}">
          <button type="button" class="oni-creq-picker-arrow" data-dir="-1">◀</button>
          <div class="oni-creq-picker-center">${imgHtml}</div>
          <button type="button" class="oni-creq-picker-arrow" data-dir="1">▶</button>
        </div>`;
    };

    // ── Skill-Check actor card ────────────────────────────────────────────
    const buildScActorCard = (actor, selected) => {
      const img  = getSpriteImg(actor);
      const id   = `oni-creq-sc-${actor.id}`;
      return `
        <label class="oni-creq-actor-card${selected ? " sel" : ""}" for="${id}" title="${actor.name}">
          <input type="checkbox" id="${id}" name="actor" value="${actor.uuid}"${selected ? " checked" : ""}>
          <div class="oni-creq-actor-img-wrap">
            <img src="${img}" alt="" onerror="this.src='icons/svg/mystery-man.svg'">
          </div>
          <div class="oni-creq-actor-lbl">${actor.name}</div>
        </label>`;
    };

    // ── Group-Check participant card (role buttons, no form inputs) ───────
    const buildGcActorCard = (actor) => {
      const img = getSpriteImg(actor);
      return `
        <div class="oni-gc-card" data-uuid="${actor.uuid}" data-role="">
          <div class="oni-gc-card-img">
            <img src="${img}" alt="" onerror="this.src='icons/svg/mystery-man.svg'">
          </div>
          <div class="oni-gc-card-name">${actor.name}</div>
          <div class="oni-gc-card-btns">
            <button type="button" class="oni-gc-role-btn" data-btn="leader" title="Set as Leader">👑 Lead</button>
            <button type="button" class="oni-gc-role-btn" data-btn="helper" title="Set as Helper">⚔ Help</button>
          </div>
        </div>`;
    };

    // ── Dialog HTML ───────────────────────────────────────────────────────
    const buildDialogContent = (partyActors, preSelectedUuids, stateA, stateB) => {
      const scCards    = partyActors.map(a => buildScActorCard(a, preSelectedUuids.has(a.uuid))).join("");
      const gcCards    = partyActors.map(buildGcActorCard).join("");
      const emptyNote  = `<div class="oni-creq-empty">No active party members found in Database Actor.</div>`;

      return `
        <style>
          /* ── Dialog base ──────────────────────────────────────────────── */
          .oni-creq-body { display:flex; flex-direction:column; padding:0; font-family:inherit; }

          /* ── Mode tabs ────────────────────────────────────────────────── */
          .oni-creq-mode-row {
            display:flex; border-bottom:1px solid rgba(0,0,0,.12);
          }
          .oni-creq-mode-tab {
            flex:1; padding:9px 6px; font-size:11px; font-weight:800;
            border:none; border-bottom:2.5px solid transparent;
            background:transparent; color:inherit; cursor:pointer;
            letter-spacing:.04em; text-transform:uppercase;
            transition:background .1s, border-color .1s;
          }
          .oni-creq-mode-tab:hover { background:rgba(0,0,0,.04); }
          .oni-creq-mode-tab.active {
            border-bottom-color:rgba(87,58,33,.8);
            background:rgba(87,58,33,.06);
          }

          /* ── Section layout ───────────────────────────────────────────── */
          .oni-creq-sec { padding:8px 14px 10px; border-bottom:1px solid rgba(0,0,0,.1); }
          .oni-creq-sec:last-child { border-bottom:none; }
          .oni-creq-sec-title {
            font-size:10px; font-weight:700; text-transform:uppercase;
            letter-spacing:.08em; opacity:.45; margin-bottom:8px; display:block;
          }

          /* ── Skill-Check actor cards (multi-select labels) ────────────── */
          .oni-creq-actor-grid {
            display:grid; grid-template-columns:repeat(4,1fr); gap:6px; padding:4px 2px;
          }
          .oni-creq-actor-card {
            display:flex; flex-direction:column; align-items:center; gap:3px;
            padding:5px 2px; border-radius:8px; cursor:pointer;
            border:1.5px solid rgba(0,0,0,.10); user-select:none;
            filter:grayscale(55%) brightness(0.82); opacity:0.60; transform:scale(1);
            transition:filter 150ms, opacity 150ms, transform 150ms, border-color 150ms, box-shadow 150ms, background 150ms;
          }
          .oni-creq-actor-card:hover { filter:grayscale(20%) brightness(.95); opacity:.85; border-color:rgba(87,58,33,.4); }
          .oni-creq-actor-card.sel {
            filter:none; opacity:1; transform:scale(1.06);
            border-color:rgba(185,125,38,.95); background:rgba(87,58,33,.08);
            box-shadow:0 0 0 2px rgba(210,148,42,.75), 0 0 14px rgba(210,148,42,.30);
          }
          .oni-creq-actor-card input { position:absolute; opacity:0; pointer-events:none; width:0; height:0; }
          .oni-creq-actor-img-wrap {
            width:68px; height:80px; display:flex; align-items:flex-end; justify-content:center;
            overflow:hidden; flex-shrink:0;
          }
          .oni-creq-actor-img-wrap img {
            max-width:100%; max-height:100%; object-fit:contain; display:block;
            background:transparent!important; border:none!important; box-shadow:none!important;
          }
          .oni-creq-actor-lbl {
            font-size:10px; font-weight:700; text-align:center;
            max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.75;
          }

          /* ── Group-Check participant cards ────────────────────────────── */
          .oni-gc-grid { display:flex; gap:6px; flex-wrap:nowrap; justify-content:flex-start; }
          .oni-gc-card {
            display:flex; flex-direction:column; align-items:center; gap:5px;
            padding:6px 4px 8px; border-radius:10px;
            border:2px solid rgba(0,0,0,.10);
            flex:1; min-width:0;
            background:rgba(0,0,0,.03);
            opacity:0.58; filter:grayscale(40%);
            transition:border-color .15s, box-shadow .15s, background .15s, opacity .15s, filter .15s;
          }
          .oni-gc-card[data-role="leader"] {
            opacity:1; filter:none;
            border-color:rgba(210,168,42,.9);
            background:rgba(210,168,42,.07);
            box-shadow:0 0 0 2px rgba(210,168,42,.4);
          }
          .oni-gc-card[data-role="helper"] {
            opacity:1; filter:none;
            border-color:rgba(46,125,50,.8);
            background:rgba(46,125,50,.06);
            box-shadow:0 0 0 2px rgba(46,125,50,.3);
          }
          .oni-gc-card-img {
            width:56px; height:70px;
            display:flex; align-items:flex-end; justify-content:center;
            overflow:hidden; flex-shrink:0;
          }
          .oni-gc-card-img img {
            max-width:100%; max-height:100%; object-fit:contain;
            background:transparent!important; border:none!important; box-shadow:none!important;
          }
          .oni-gc-card-name {
            font-size:9px; font-weight:700; text-align:center;
            width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.7;
          }
          .oni-gc-card-btns { display:flex; gap:3px; }
          .oni-gc-role-btn {
            font-size:9.5px; font-weight:700; padding:3px 5px;
            border:1.5px solid rgba(0,0,0,.16); border-radius:6px;
            background:rgba(0,0,0,.05); cursor:pointer; line-height:1.3;
            color:#3b2a19; transition:background .1s, border-color .1s, opacity .1s;
            opacity:0.6;
          }
          .oni-gc-role-btn:hover { opacity:1; background:rgba(0,0,0,.10); }
          .oni-gc-card[data-role="leader"] .oni-gc-role-btn[data-btn="leader"] {
            background:rgba(210,168,42,.3); border-color:rgba(210,168,42,.8); opacity:1; font-weight:900;
          }
          .oni-gc-card[data-role="helper"] .oni-gc-role-btn[data-btn="helper"] {
            background:rgba(46,125,50,.25); border-color:rgba(46,125,50,.7); opacity:1; font-weight:900;
          }
          /* In open-participation mode: hide helper buttons (players choose in lobby) */
          .oni-gc-grid[data-part-mode="open"] .oni-gc-role-btn[data-btn="helper"] { display:none; }

          /* ── Pickers ──────────────────────────────────────────────────── */
          ${PICKER_CSS}

          /* ── Config row ───────────────────────────────────────────────── */
          .oni-creq-config-row { display:flex; gap:10px; align-items:flex-start; }
          .oni-creq-field { display:flex; flex-direction:column; gap:3px; flex:1; }
          .oni-creq-field-lbl { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; opacity:.45; }
          .oni-creq-field input[type=number], .oni-creq-field input[type=text] {
            padding:5px 8px; border-radius:6px; font-size:12px; font-family:inherit;
            border:1px solid rgba(0,0,0,.2); background:rgba(0,0,0,.04); color:inherit; width:100%;
          }
          .oni-creq-dl-wrap { max-width:64px; }

          /* ── Attr labels ──────────────────────────────────────────────── */
          .oni-creq-attr-labels {
            display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:4px;
          }
          .oni-creq-attr-label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; opacity:.45; }

          /* ── GC participation mode row ────────────────────────────────── */
          .oni-gc-part-row {
            display:flex; gap:14px; align-items:center; margin-top:8px;
          }
          .oni-gc-part-row label {
            display:flex; align-items:center; gap:5px;
            font-size:11px; font-weight:700; cursor:pointer;
          }
          .oni-gc-hint {
            font-size:10px; opacity:.45; font-style:italic; margin-top:5px;
          }
          .oni-gc-gc-config-row { display:flex; gap:10px; align-items:flex-start; margin-top:6px; }

          /* ── Hidden DL toggle ────────────────────────────────────────── */
          .oni-creq-hidden-dl-row {
            display:flex; align-items:center; gap:4px; margin-top:5px;
            font-size:10px; font-weight:700; cursor:pointer; user-select:none;
            opacity:.65; white-space:nowrap;
          }
          .oni-creq-hidden-dl-row input[type=checkbox] { width:auto; padding:0; margin:0; }

          /* ── Check-buff multi-select dropdown ─────────────────────────── */
          .oni-creq-msel { position:relative; }
          .oni-creq-msel-toggle {
            width:100%; display:flex; align-items:center; justify-content:space-between;
            padding:5px 8px; border-radius:6px; font-size:12px; font-family:inherit;
            border:1px solid rgba(0,0,0,.2); background:rgba(0,0,0,.04);
            color:inherit; cursor:pointer; line-height:1.3;
          }
          .oni-creq-msel-toggle:hover { background:rgba(0,0,0,.07); }
          .oni-creq-msel-summary { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.85; }
          .oni-creq-msel-caret { opacity:.5; font-size:10px; margin-left:6px; flex-shrink:0; }
          .oni-creq-msel-menu {
            display:none; position:absolute; left:0; right:0; top:calc(100% + 3px); z-index:6;
            background:#f6ebd3; border:1px solid rgba(87,58,33,.55); border-radius:8px;
            box-shadow:0 8px 20px rgba(0,0,0,.28); padding:4px; flex-direction:column; gap:1px;
          }
          .oni-creq-msel-menu.open { display:flex; }
          .oni-creq-msel-opt {
            display:flex; align-items:center; gap:7px; padding:5px 8px; border-radius:5px;
            font-size:12px; font-weight:700; color:#2b1f17; cursor:pointer; user-select:none;
          }
          .oni-creq-msel-opt:hover { background:rgba(87,58,33,.10); }
          .oni-creq-msel-opt input[type=checkbox] { width:auto; padding:0; margin:0; cursor:pointer; }

          /* ── Empty state ──────────────────────────────────────────────── */
          .oni-creq-empty { font-size:12px; opacity:.5; font-style:italic; padding:4px 0; }
        </style>

        <div class="oni-creq-body" id="oni-creq-body">

          <!-- Mode selector -->
          <div class="oni-creq-mode-row">
            <button type="button" class="oni-creq-mode-tab active" data-mode="skill-check">🎯 Skill Check</button>
            <button type="button" class="oni-creq-mode-tab"        data-mode="group-check">👥 Group Check</button>
          </div>

          <!-- ══ SKILL CHECK ═══════════════════════════════════════════════ -->
          <div class="oni-creq-sec" data-mode-sec="skill-check">
            <span class="oni-creq-sec-title">Target Actors</span>
            ${partyActors.length > 0
              ? `<div class="oni-creq-actor-grid" id="oni-sc-actor-grid">${scCards}</div>`
              : emptyNote}
          </div>

          <!-- ══ GROUP CHECK ════════════════════════════════════════════════ -->

          <!-- Single participant grid: each actor has 👑 Lead + ⚔ Help buttons -->
          <div class="oni-creq-sec" data-mode-sec="group-check" style="display:none">
            <span class="oni-creq-sec-title">Participants</span>
            ${partyActors.length > 0
              ? `<div class="oni-gc-grid" id="oni-gc-grid" data-part-mode="designated">${gcCards}</div>
                 <div class="oni-gc-hint">👑 = Leader (only one) &nbsp;·&nbsp; ⚔ = Helper &nbsp;·&nbsp; No role = not participating</div>`
              : emptyNote}
            <div class="oni-gc-part-row">
              <label>
                <input type="radio" name="gc-part-mode" value="designated" checked>
                Designated
              </label>
              <label>
                <input type="radio" name="gc-part-mode" value="open">
                Open — players join in lobby
              </label>
            </div>
          </div>

          <!-- Group Check numerical settings -->
          <div class="oni-creq-sec" data-mode-sec="group-check" style="display:none">
            <span class="oni-creq-sec-title">Group Settings</span>
            <div class="oni-gc-gc-config-row">
              <div class="oni-creq-field oni-creq-dl-wrap">
                <div class="oni-creq-field-lbl">Helper DL</div>
                <input type="number" id="oni-gc-helper-dl" value="10" min="1" max="40" step="1">
              </div>
              <div class="oni-creq-field oni-creq-dl-wrap">
                <div class="oni-creq-field-lbl">+Bonus</div>
                <input type="number" id="oni-gc-helper-bonus" value="1" min="0" max="10" step="1">
              </div>
            </div>
          </div>

          <!-- ══ SHARED ════════════════════════════════════════════════════ -->

          <!-- Attribute pickers (shared) -->
          <div class="oni-creq-sec">
            <div class="oni-creq-attr-labels">
              <div class="oni-creq-attr-label">Attribute A</div>
              <div class="oni-creq-attr-label">Attribute B &nbsp;<span style="opacity:.55;font-style:italic;font-weight:400;text-transform:none;letter-spacing:0">(— = 1 die)</span></div>
            </div>
            <div class="oni-creq-pickers-row" id="oni-creq-pickers">
              ${buildPickerHtml("A", stateA)}
              ${buildPickerHtml("B", stateB)}
            </div>
          </div>

          <!-- DL + Context (DL label changes per mode) -->
          <div class="oni-creq-sec">
            <div class="oni-creq-config-row">
              <div class="oni-creq-field oni-creq-dl-wrap">
                <div class="oni-creq-field-lbl" id="oni-creq-dl-lbl">DL</div>
                <input type="number" id="oni-creq-dl" name="dl" value="10" min="1" max="40" step="1">
              </div>
              <div class="oni-creq-field">
                <div class="oni-creq-field-lbl">Context (optional)</div>
                <input type="text" id="oni-creq-ctx" name="context" placeholder="e.g. Escape the collapsing bridge…">
              </div>
            </div>

            <!-- Check Buff (multi) — folds equipped check_buff +N for matching action(s) -->
            <div class="oni-creq-field" style="margin-top:9px;">
              <div class="oni-creq-field-lbl">Check Buff (applies equipped bonus)</div>
              <div class="oni-creq-msel" id="oni-creq-buff-msel">
                <button type="button" class="oni-creq-msel-toggle" id="oni-creq-buff-toggle" aria-expanded="false">
                  <span class="oni-creq-msel-summary" id="oni-creq-buff-summary">None</span>
                  <span class="oni-creq-msel-caret">▾</span>
                </button>
                <div class="oni-creq-msel-menu" id="oni-creq-buff-menu">
                  ${CHECK_BUFF_OPTIONS.map(o => `
                    <label class="oni-creq-msel-opt">
                      <input type="checkbox" class="oni-creq-buff-cb" value="${o.value}">
                      <span>${o.label}</span>
                    </label>`).join("")}
                </div>
              </div>
            </div>

            <!-- Hidden DL toggle -->
            <label class="oni-creq-hidden-dl-row" style="margin-top:9px;">
              <input type="checkbox" id="oni-creq-hidden-dl" name="hidden-dl" checked>
              <span>Hidden (DL ?)</span>
            </label>
          </div>

        </div>

        <script>
        (function() {
          const ATTRS_A    = ${JSON.stringify(ATTRS_A)};
          const ATTRS_B    = ${JSON.stringify(ATTRS_B)};
          const ATTR_ICONS = ${JSON.stringify(ATTR_ICONS)};

          // ── Mode tabs ───────────────────────────────────────────────────
          let currentMode = "skill-check";

          function setMode(mode) {
            currentMode = mode;
            document.querySelectorAll(".oni-creq-mode-tab").forEach(btn =>
              btn.classList.toggle("active", btn.dataset.mode === mode));
            document.querySelectorAll("[data-mode-sec]").forEach(sec =>
              sec.style.display = sec.dataset.modeSec === mode ? "" : "none");
            const dlLbl = document.getElementById("oni-creq-dl-lbl");
            if (dlLbl) dlLbl.textContent = mode === "group-check" ? "Leader DL" : "DL";
          }

          document.querySelectorAll(".oni-creq-mode-tab").forEach(btn =>
            btn.addEventListener("click", () => setMode(btn.dataset.mode)));

          // ── Skill-Check actor card toggle ───────────────────────────────
          const scGrid = document.getElementById("oni-sc-actor-grid");
          if (scGrid) {
            scGrid.addEventListener("click", e => {
              const card = e.target.closest(".oni-creq-actor-card");
              if (!card) return;
              const cb = card.querySelector("input[type=checkbox]");
              if (!cb) return;
              cb.checked = !cb.checked;
              card.classList.toggle("sel", cb.checked);
            });
          }

          // ── Group-Check role buttons ────────────────────────────────────
          const gcGrid = document.getElementById("oni-gc-grid");
          if (gcGrid) {
            gcGrid.addEventListener("click", e => {
              const btn = e.target.closest(".oni-gc-role-btn");
              if (!btn) return;
              e.preventDefault();
              e.stopPropagation();

              const card       = btn.closest(".oni-gc-card");
              if (!card) return;
              const roleToSet  = btn.dataset.btn;   // "leader" or "helper"
              const curRole    = card.dataset.role;
              const allCards   = [...gcGrid.querySelectorAll(".oni-gc-card")];

              if (roleToSet === "leader") {
                if (curRole === "leader") {
                  // Deselect — click again to remove leader
                  card.dataset.role = "";
                } else {
                  // Transfer leadership: clear old leader first
                  allCards.forEach(c => { if (c.dataset.role === "leader") c.dataset.role = ""; });
                  card.dataset.role = "leader";
                }
              } else if (roleToSet === "helper") {
                if (curRole === "helper") {
                  card.dataset.role = "";
                } else if (curRole !== "leader") {
                  // Can't assign helper to the current leader
                  card.dataset.role = "helper";
                }
              }
            });
          }

          // ── Participation mode radio ────────────────────────────────────
          document.querySelectorAll('[name="gc-part-mode"]').forEach(rb => {
            rb.addEventListener("change", () => {
              if (!gcGrid) return;
              gcGrid.dataset.partMode = rb.value;
              // Clear helper assignments when switching to open (players choose)
              if (rb.value === "open") {
                gcGrid.querySelectorAll(".oni-gc-card[data-role='helper']")
                  .forEach(c => { c.dataset.role = ""; });
              }
            });
          });

          // ── Picker cycling ──────────────────────────────────────────────
          function updatePicker(pickerEl, attr) {
            const isNone = attr === "—";
            const icon   = ATTR_ICONS[attr] ?? "";
            const center = pickerEl.querySelector(".oni-creq-picker-center");
            if (!center) return;
            pickerEl.dataset.attr = attr;
            pickerEl.classList.toggle("is-none", isNone);
            if (isNone) {
              center.innerHTML = '<span class="oni-creq-picker-name" style="font-size:18px;opacity:.4;">—</span>';
            } else {
              center.innerHTML =
                '<img class="oni-creq-picker-icon" src="' + icon + '" alt="' + attr + '">'
                + '<div class="oni-creq-picker-name">' + attr + '</div>';
            }
          }

          function cyclePicker(slot, dir) {
            const picker = document.querySelector('.oni-creq-picker[data-slot="' + slot + '"]');
            if (!picker) return;
            const cur  = picker.dataset.attr || (slot === "A" ? "DEX" : "MIG");
            const list = slot === "A" ? ATTRS_A : ATTRS_B;
            const i    = list.indexOf(cur);
            updatePicker(picker, list[((i < 0 ? 0 : i) + dir + list.length) % list.length]);
          }

          document.getElementById("oni-creq-pickers")?.addEventListener("click", e => {
            const btn = e.target.closest(".oni-creq-picker-arrow");
            if (!btn) return;
            const picker = btn.closest(".oni-creq-picker");
            const slot   = picker?.dataset?.slot;
            const dir    = parseInt(btn.dataset.dir, 10) || 1;
            if (slot) cyclePicker(slot, dir);
          });

          document.querySelectorAll(".oni-creq-picker").forEach(el => {
            el.addEventListener("wheel", e => {
              e.preventDefault();
              const slot = el.dataset.slot;
              if (slot) cyclePicker(slot, e.deltaY > 0 ? 1 : -1);
            }, { passive: false });
          });

          // ── Check-buff multi-select dropdown ────────────────────────────
          const buffMsel    = document.getElementById("oni-creq-buff-msel");
          const buffToggle  = document.getElementById("oni-creq-buff-toggle");
          const buffMenu    = document.getElementById("oni-creq-buff-menu");
          const buffSummary = document.getElementById("oni-creq-buff-summary");
          function updateBuffSummary() {
            const on = [...document.querySelectorAll(".oni-creq-buff-cb:checked")]
              .map(c => c.parentElement.querySelector("span")?.textContent ?? c.value);
            if (buffSummary) buffSummary.textContent = on.length ? on.join(", ") : "None";
          }
          if (buffToggle && buffMenu) {
            buffToggle.addEventListener("click", e => {
              e.stopPropagation();
              const open = buffMenu.classList.toggle("open");
              buffToggle.setAttribute("aria-expanded", open ? "true" : "false");
            });
            buffMenu.addEventListener("change", updateBuffSummary);
            // Close on click outside (scoped to the dialog body so the listener
            // dies with the dialog — no global leak).
            document.getElementById("oni-creq-body")?.addEventListener("click", e => {
              if (buffMsel && !buffMsel.contains(e.target)) {
                buffMenu.classList.remove("open");
                buffToggle.setAttribute("aria-expanded", "false");
              }
            });
          }

          // Expose mode getter for the dialog callback
          window.__oni_creq_getMode = () => currentMode;
        })();
        </script>`;
    };

    // ── Open dialog ───────────────────────────────────────────────────────
    const openDialog = async () => {
      const partyActors = await loadPartyActors()
        ?? (game.actors?.contents ?? []).filter(a => a.type === "character");

      const preSelectedUuids = new Set(
        (canvas?.tokens?.controlled ?? [])
          .map(t => t.actor?.uuid)
          .filter(Boolean)
      );

      return new Promise(resolve => {
        const d = new Dialog({
          title:   "🎯 Request Check",
          content: buildDialogContent(partyActors, preSelectedUuids, "DEX", "MIG"),
          buttons: {
            confirm: {
              icon:  '<i class="fas fa-check"></i>',
              label: "Request",
              callback: async html => {
                const root = html[0] ?? html;
                const mode = window.__oni_creq_getMode?.() ?? "skill-check";

                // ── Shared: attr pickers ─────────────────────────────────
                const pickA     = root.querySelector('.oni-creq-picker[data-slot="A"]');
                const pickB     = root.querySelector('.oni-creq-picker[data-slot="B"]');
                const attrA     = pickA?.dataset?.attr ?? "DEX";
                const rawB      = pickB?.dataset?.attr ?? "MIG";
                const singleDie = rawB === "—";
                const attrB     = singleDie ? attrA : rawB;
                const leaderDl  = parseInt(root.querySelector('[name="dl"]')?.value   ?? "10", 10) || 10;
                const context   = root.querySelector('[name="context"]')?.value?.trim() ?? "";
                const hiddenDl  = !!root.querySelector('[name="hidden-dl"]')?.checked;

                // Check-buff actions (multi) — tags this Check with named actions
                // whose equipped check_buff +N gets folded into each roll.
                const checkBuffActions = [...root.querySelectorAll('.oni-creq-buff-cb:checked')]
                  .map(el => el.value);

                // ── SKILL CHECK ──────────────────────────────────────────
                if (mode === "skill-check") {
                  const checkedUuids = [...root.querySelectorAll('input[name="actor"]:checked')]
                    .map(el => el.value);
                  if (!checkedUuids.length) {
                    ui?.notifications?.warn?.("Request Check: No actors selected.");
                    resolve(null); return;
                  }
                  const actors = (await Promise.all(
                    checkedUuids.map(u => fromUuid(u).catch(() => null))
                  )).filter(Boolean);
                  if (!actors.length) {
                    ui?.notifications?.warn?.("Request Check: Could not resolve actors.");
                    resolve(null); return;
                  }
                  const CR = globalThis.ONI?.CheckRequester;
                  if (!CR?.request) {
                    ui?.notifications?.error?.("ONI.CheckRequester is not loaded.");
                    resolve(null); return;
                  }
                  try {
                    resolve(await CR.request(actors, {
                      attrA, attrB, singleDie,
                      dl:           leaderDl,
                      label:        context || "Skill Check",
                      mode:         "interactive",
                      allowInvokes: true,
                      postChat:     true,
                      context,
                      hiddenDl,
                      checkBuffActions,
                    }));
                  } catch (e) {
                    console.error(TAG, e);
                    ui?.notifications?.error?.("Request Check: An error occurred.");
                    resolve(null);
                  }
                  return;
                }

                // ── GROUP CHECK ──────────────────────────────────────────
                const GC = globalThis.ONI?.GroupCheck;
                if (!GC?.request) {
                  ui?.notifications?.error?.("ONI.GroupCheck is not loaded.");
                  resolve(null); return;
                }

                // Read roles from the GC participant grid
                const allGcCards  = [...root.querySelectorAll(".oni-gc-card")];
                const leaderCard  = allGcCards.find(c => c.dataset.role === "leader");
                const leaderUuid  = leaderCard?.dataset?.uuid ?? null;

                const partModeEl  = root.querySelector('[name="gc-part-mode"]:checked');
                const partMode    = partModeEl?.value ?? "open";

                // In designated mode a leader must be assigned before requesting
                if (partMode === "designated" && !leaderUuid) {
                  ui?.notifications?.warn?.("Group Check: assign a Leader (👑) before requesting.");
                  resolve(null); return;
                }

                const helperUuids = partMode === "designated"
                  ? allGcCards.filter(c => c.dataset.role === "helper").map(c => c.dataset.uuid)
                  : [];

                const allUuids    = partyActors.map(a => a.uuid);

                const helperDl    = parseInt(root.querySelector("#oni-gc-helper-dl")?.value    ?? "10", 10) || 10;
                const helperBonus = parseInt(root.querySelector("#oni-gc-helper-bonus")?.value ?? "1",  10) || 1;

                try {
                  resolve(await GC.request({
                    leaderUuid,
                    participantMode:  partMode,
                    helperActorUuids: helperUuids,
                    allActorUuids:    allUuids,
                    helperDl,
                    leaderDl,
                    helperBonus,
                    attrA, attrB, singleDie,
                    label:        context || "Group Check",
                    allowInvokes: true,
                    postChat:     true,
                    hiddenDl,
                    checkBuffActions,
                  }));
                } catch (e) {
                  if (e?.message?.includes("cancelled")) { resolve(null); return; }
                  console.error(TAG, e);
                  ui?.notifications?.error?.("Group Check: An error occurred.");
                  resolve(null);
                }
              },
            },
            cancel: {
              icon:     '<i class="fas fa-times"></i>',
              label:    "Cancel",
              callback: () => resolve(null),
            },
          },
          default: "confirm",
          close:   () => resolve(null),
        }, {
          width:   460,
          classes: ["oni-creq-dialog"],
        });

        d.render(true);
      });
    };

    // ── Floating button CSS ───────────────────────────────────────────────
    const ensureStyle = () => {
      if (document.getElementById(DOM.STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = DOM.STYLE_ID;
      style.textContent = `
        #${DOM.ROOT_ID} {
          position: fixed;
          /* Live anchor — slides right when the GM collapses the sidebar.
             Falls back to the legacy 313px when [SidebarAnchor] hasn't
             published the var yet (cold boot). */
          right: var(--fu-sidebar-anchor-right, ${CFG.offsetRightPx}px);
          bottom: ${CFG.offsetBottomPx}px;
          z-index: ${CFG.zIndex};
          pointer-events: none;
        }
        #${DOM.BTN_ID} {
          pointer-events: auto;
          width: ${CFG.sizePx}px; height: ${CFG.sizePx}px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.22);
          background: rgba(18,18,22,0.86);
          box-shadow: 0 10px 24px rgba(0,0,0,.35), 0 2px 0 rgba(255,255,255,.06) inset;
          display: grid; place-items: center;
          cursor: pointer; user-select: none; -webkit-user-select: none;
          transform: translateZ(0);
          transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
          position: relative;
        }
        #${DOM.BTN_ID}:hover  { transform: translateY(-1px) scale(1.02); background: rgba(28,28,34,.92); border-color: rgba(255,255,255,.32); }
        #${DOM.BTN_ID}:active { transform: translateY(0) scale(.99); }
        #${DOM.BTN_ID} .oni-creq-icon { font-size:22px; line-height:1; filter:drop-shadow(0 2px 2px rgba(0,0,0,.45)); }
        #${DOM.BTN_ID} .oni-creq-tip {
          position:absolute; right:0; bottom:calc(100% + 10px);
          background:rgba(10,10,12,.92); border:1px solid rgba(255,255,255,.18);
          border-radius:10px; padding:8px 10px; font-size:12px;
          color:rgba(255,255,255,.9); white-space:nowrap;
          opacity:0; transform:translateY(4px);
          transition:opacity 120ms ease, transform 120ms ease;
          pointer-events:none; box-shadow:0 10px 24px rgba(0,0,0,.35);
        }
        #${DOM.BTN_ID}:hover .oni-creq-tip { opacity:1; transform:translateY(0); }

        /* Dialog layout overrides */
        .oni-creq-dialog .window-content { padding:0 !important; overflow:visible !important; }
        .oni-creq-dialog .dialog-content  { padding:0 !important; }
        .oni-creq-dialog .dialog-buttons  {
          display:grid !important; grid-template-columns:1fr 1fr !important;
          gap:8px !important; padding:8px 14px !important;
          border-top:1px solid rgba(0,0,0,.1);
        }
        .oni-creq-dialog .dialog-buttons button { margin:0 !important; }
      `;
      document.head.appendChild(style);
    };

    // ── Floating button DOM ───────────────────────────────────────────────
    const buildButton = () => {
      let root = document.getElementById(DOM.ROOT_ID);
      if (!root) {
        root = document.createElement("div");
        root.id = DOM.ROOT_ID;
        document.body.appendChild(root);
      }
      root.innerHTML = "";

      const btn = document.createElement("div");
      btn.id = DOM.BTN_ID;
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");
      btn.setAttribute("aria-label", CFG.label);
      btn.innerHTML = `<div class="oni-creq-tip">${CFG.label}</div><div class="oni-creq-icon">${CFG.iconText}</div>`;

      let busy = false;
      const onClick = async ev => {
        ev?.preventDefault?.(); ev?.stopPropagation?.();
        if (busy) return;
        busy = true;
        try { await openDialog(); }
        catch (e) { console.error(TAG, e); }
        finally { busy = false; }
      };
      btn.addEventListener("click", onClick);
      btn.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") onClick(ev); });
      root.appendChild(btn);
    };

    // ── Boot ──────────────────────────────────────────────────────────────
    cleanupUI();
    ensureStyle();
    buildButton();
    STATE.installed = true;
    console.debug(TAG, "Request Check button installed.");
  })();
});
