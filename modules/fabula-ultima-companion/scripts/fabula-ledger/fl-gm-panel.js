/**
 * Fabula Ledger — GM ledger panel (step 3)
 *
 * File: scripts/fabula-ledger/fl-gm-panel.js
 *
 * One parchment window for everything the automation can't guess:
 *   header     session open/closed + Open / Close session, Auto-pay toggle
 *   Party      each member's Fabula Points with − / + (a manual change; the
 *              cap does not apply to these: they are the GM's own call) and
 *              the flag = Surrender (+2, capped; nothing in the game detects it)
 *   Villains   status per actor (Auto / Villain / Hidden / Never) and
 *              Cameo (the GM voices them, no token) · Reveal · Escalate
 *   Awards     the recent awards, each with Undo
 *   Log        what the ledger decided and why; a quiet or skipped sighting
 *              has Pay (a Cameo: still once per visit, still ≤3 per visit)
 *
 * Opens from the dev-tools stack (🛠, "Fabula Ledger") or Shift+F. GM only.
 * Every button goes through FUCompanion.api.fabula, so a second GM's clicks
 * are forwarded to the primary GM like everything else.
 */
(() => {
  const TAG = "[FabulaLedger][Panel]";
  const MODULE_ID = "fabula-ultima-companion";
  const ROOT_ID = "fl-gm-panel";
  const STYLE_ID = "fl-gm-panel-style";
  const LIST_ID = "fl-gm-panel-actors";
  const FL = globalThis.FabulaLedger = globalThis.FabulaLedger || {};
  const I = () => FL._internal;
  const api = () => FL.api;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const FP_PROP = "fabula_point";

  const STATUS_LABEL = { auto: "Auto", villain: "Villain", hidden: "Hidden", never: "Never" };
  const AWARD_LABEL = { villain: "villain", escalation: "escalated", boss: "boss fight", session: "session start", gm: "GM", change: "event", fumble: "fumble", surrender: "surrender" };
  const WHY = {
    villain: "paid", "auto-pay": "paid (Auto-pay)", event: "paid (event)", cameo: "paid (cameo)", reveal: "paid (reveal)",
    escalation: "paid (escalated)", "paid-this-visit": "already paid here", "visit-cap": "3 already paid here",
    muted: "skipped loop", "status-hidden": "hidden", unset: "asked: first sighting", loop: "asked: loop",
    "battle-followed": "boss point covers it"
  };

  const _extra = new Set();   // actors the GM added to the list by hand (this page load)
  let _open = false;

  // ── style ──────────────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#${ROOT_ID} {
  position: fixed; z-index: 8000; left: 16px; bottom: 120px; width: 400px; max-height: 72vh;
  display: flex; flex-direction: column; box-sizing: border-box;
  color: #3a1e06; font: 13px/1.35 "Signika","Noto Sans","Segoe UI",sans-serif;
  background:
    repeating-linear-gradient(0deg, transparent 0 11px, rgba(140,90,30,0.05) 11px 12px),
    linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
  border: 1px solid #c9a44a; border-radius: 10px;
  box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 10px 22px rgba(0,0,0,0.5);
  opacity: 0; transform: translateY(10px); transition: opacity 200ms ease-out, transform 240ms cubic-bezier(.2,.8,.25,1);
}
#${ROOT_ID}.in { opacity: 1; transform: none; }
#${ROOT_ID} .flg-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px 6px 12px; cursor: move; border-bottom: 1px solid rgba(122,78,32,0.35); }
#${ROOT_ID} .flg-title { font-size: 15px; font-weight: 600; }
#${ROOT_ID} .flg-title i { color: #14b8a6; margin-right: 5px; }
#${ROOT_ID} .flg-pill { font-size: 11px; padding: 1px 7px; border-radius: 9px; background: rgba(122,78,32,0.15); color: #6a4a22; }
#${ROOT_ID} .flg-pill.on { background: rgba(20,184,166,0.18); color: #0f766e; }
#${ROOT_ID} .flg-sp { flex: 1; }
#${ROOT_ID} .flg-x { all: unset; cursor: pointer; padding: 0 4px; font-size: 16px; color: #7a5a2e; }
#${ROOT_ID} .flg-body { overflow-y: auto; padding: 4px 12px 10px; }
#${ROOT_ID} h4 { margin: 9px 0 4px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #8a6a3a; border: 0; }
#${ROOT_ID} .flg-row { display: flex; align-items: center; gap: 6px; min-height: 26px; }
#${ROOT_ID} .flg-row + .flg-row { border-top: 1px dashed rgba(122,78,32,0.18); }
#${ROOT_ID} .flg-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .flg-dim { color: #8a6a3a; font-size: 11.5px; }
#${ROOT_ID} .flg-note { font-style: italic; color: #8a6a3a; }
#${ROOT_ID} img.flg-ico { width: 24px; height: 24px; object-fit: contain; object-position: bottom; image-rendering: pixelated; border: 0 !important; flex: none; }
#${ROOT_ID} .flg-party { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 14px; }
#${ROOT_ID} .flg-fp { min-width: 22px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
#${ROOT_ID} button.b {
  all: unset; box-sizing: border-box; cursor: pointer; padding: 1px 8px; border-radius: 5px; font-size: 12px; line-height: 18px;
  color: #f6ead0; background: linear-gradient(180deg, #7a5230, #5c3818); flex: none;
}
#${ROOT_ID} button.b.sm { padding: 0 6px; min-width: 18px; text-align: center; }
#${ROOT_ID} button.b:hover, #${ROOT_ID} button.b:focus-visible { box-shadow: 0 0 0 2px #c9a44a; }
#${ROOT_ID} select, #${ROOT_ID} input[type=text] {
  height: 22px; font-size: 12px; color: #3a1e06; background: rgba(255,250,235,0.8); border: 1px solid #c9a44a; border-radius: 4px; padding: 0 4px;
}
#${ROOT_ID} label.flg-auto { display: flex; align-items: center; gap: 4px; font-size: 12px; }
#${ROOT_ID} label.flg-auto input { margin: 0; }
#${ROOT_ID} .flg-add { display: flex; gap: 6px; margin-top: 5px; }
#${ROOT_ID} .flg-add input { flex: 1; }
#${ROOT_ID} .flg-empty { color: #8a6a3a; font-style: italic; padding: 2px 0; }`;
    document.head.appendChild(s);
  }

  // ── data ───────────────────────────────────────────────────────────────────
  const fpOf = (a) => Number(a?.system?.props?.[FP_PROP] ?? 0) || 0;
  const sprite = (a) => I()?.spriteOf?.(a) ?? "";
  const ago = (t) => {
    const m = Math.round((Date.now() - (t ?? 0)) / 60000);
    return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
  };

  function villainActors(state) {
    const ids = new Set(_extra);
    for (const a of game.actors ?? []) if (a.getFlag(MODULE_ID, "fabulaVillain")) ids.add(a.id);
    for (const e of state.log ?? []) if (e.actorId) ids.add(e.actorId);
    return [...ids].map(id => game.actors.get(id)).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── render ─────────────────────────────────────────────────────────────────
  async function render() {
    const el = document.getElementById(ROOT_ID);
    if (!el || !I()) return;
    const st = I().readState();
    const party = await I().partyActors();
    const autoPay = (() => { try { return game.settings.get(MODULE_ID, "fabulaAutoPay") === true; } catch { return false; } })();
    const sess = st.session ?? {};

    const partyHtml = party.length ? party.map(a => `
      <div class="flg-row"><span class="flg-name">${esc(a.name)}</span>
        <button class="b sm" data-act="fp" data-id="${a.id}" data-d="-1" title="−1 (spend)">−</button>
        <span class="flg-fp">${fpOf(a)}</span>
        <button class="b sm" data-act="fp" data-id="${a.id}" data-d="1" title="+1 (GM award, uncapped)">+</button>
        <button class="b sm" data-act="surrender" data-id="${a.id}" title="Surrendered: +2 (Undo below if misclicked)"><i class="fa-solid fa-flag"></i></button></div>`).join("")
      : `<div class="flg-empty">No party found.</div>`;

    const villains = villainActors(st);
    const statusSel = (a) => {
      const cur = api().getStatus(a);
      return `<select data-act="status" data-id="${a.id}" title="Villain status">${
        Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${v}</option>`).join("")}</select>`;
    };
    const villainHtml = villains.length ? villains.map(a => {
      const status = api().getStatus(a);
      const rank = I().rankOf(a);
      return `<div class="flg-row">
        ${sprite(a) ? `<img class="flg-ico" src="${esc(sprite(a))}" alt="">` : ""}
        <span class="flg-name" title="${esc(rank)}">${esc(a.name)}</span>
        ${statusSel(a)}
        ${status === "never" ? "" : `<button class="b" data-act="cameo" data-id="${a.id}" title="They speak or act with no token: +1 (once per visit)">Cameo</button>`}
        ${status === "hidden" || status === "auto" ? `<button class="b" data-act="reveal" data-id="${a.id}" title="Mark as Villain and pay +1">Reveal</button>` : ""}
        ${status === "villain" ? `<button class="b" data-act="escalate" data-id="${a.id}" title="Boss phase / escalation: +1 even if paid here">Escalate</button>` : ""}
      </div>`;
    }).join("") : `<div class="flg-empty">No villains yet.</div>`;

    const awards = (st.undo ?? []).slice(0, 8);
    const awardHtml = awards.length ? awards.map(u => {
      const who = (u.changes ?? []).filter(c => c.after !== c.before).length;
      // Show what landed: the cap can trim a +2 surrender to +1.
      const moved = (u.changes ?? []).map(c => (c.after ?? 0) - (c.before ?? 0));
      const shown = u.delta > 0 ? Math.max(0, ...moved) : Math.min(0, ...moved);
      return `<div class="flg-row"><span class="flg-name">${shown > 0 ? "+" : ""}${shown} ·${esc(u.label || AWARD_LABEL[u.reason] || u.reason)}
        <span class="flg-dim">${esc(AWARD_LABEL[u.reason] ?? u.reason)} · ${who} changed · ${ago(u.at)}</span></span>
        <button class="b" data-act="undo" data-award="${u.id}">Undo</button></div>`;
    }).join("") : `<div class="flg-empty">Nothing awarded this session.</div>`;

    const logHtml = (st.log ?? []).slice(0, 14).map(e => {
      if (e.note) return `<div class="flg-row flg-note">${esc(e.note)} <span class="flg-dim">· ${ago(e.at)}</span></div>`;
      const paid = e.action === "pay";
      const why = WHY[e.reason] ?? e.reason;
      const a = game.actors.get(e.actorId);
      const canPay = !paid && a && api().getStatus(a) !== "never" && !["paid-this-visit", "visit-cap"].includes(e.reason);
      return `<div class="flg-row"><span class="flg-name">${esc(e.name)} <span class="flg-dim">${esc(e.source)} · ${esc(why)} · ${ago(e.at)}</span></span>
        ${canPay ? `<button class="b" data-act="cameo" data-id="${e.actorId}" title="Pay +1 now (counts as a cameo)">Pay</button>` : ""}</div>`;
    }).join("") || `<div class="flg-empty">Nothing yet.</div>`;

    const opts = [...game.actors].filter(a => a.type !== "character").map(a => `<option value="${esc(a.name)}"></option>`).join("");

    el.innerHTML = `
      <div class="flg-head">
        <span class="flg-title"><i class="fa-solid fa-star"></i>Fabula Ledger</span>
        <span class="flg-pill ${sess.open ? "on" : ""}">${sess.open ? `session · ${ago(sess.openedAt)}` : "no session"}</span>
        <span class="flg-sp"></span>
        <button class="b" data-act="${sess.open ? "close-session" : "open-session"}">${sess.open ? "Close session" : "Open session"}</button>
        <button class="flg-x" data-act="hide" title="Close">×</button>
      </div>
      <div class="flg-body">
        <label class="flg-auto" title="On: unset Champions pay without asking. Loops always ask."><input type="checkbox" data-act="autopay" ${autoPay ? "checked" : ""}> Auto-pay unset Champions</label>
        <h4>Party</h4><div class="flg-party">${partyHtml}</div>
        <h4>Villains</h4>${villainHtml}
        <div class="flg-add"><input type="text" list="${LIST_ID}" placeholder="Add an actor…" data-act="add-name"><button class="b" data-act="add">Add</button></div>
        <datalist id="${LIST_ID}">${opts}</datalist>
        <h4>Awards</h4>${awardHtml}
        <h4>Log</h4>${logHtml}
      </div>`;
  }

  let _rt = null;
  const refresh = () => { if (!_open || _rt) return; _rt = setTimeout(() => { _rt = null; render(); }, 120); };

  // ── actions ────────────────────────────────────────────────────────────────
  async function onClick(ev) {
    const b = ev.target?.closest?.("[data-act]");
    if (!b || b.tagName === "SELECT" || b.type === "checkbox" || b.tagName === "INPUT") return;
    const act = b.dataset.act;
    const actor = b.dataset.id ? game.actors.get(b.dataset.id) : null;
    try {
      if (act === "hide") return hide();
      if (act === "fp") return api().change([actor], Number(b.dataset.d), { reason: "gm", label: actor?.name, uncapped: true, silent: Number(b.dataset.d) < 0 });
      if (act === "surrender") return api().surrender([actor]);
      if (act === "cameo") return report(await api().cameo(actor), actor);
      if (act === "reveal") return report(await api().reveal(actor), actor);
      if (act === "escalate") return report(await api().escalate(actor), actor);
      if (act === "undo") { const r = await api().undo(b.dataset.award); if (!r?.ok && !r?.forwarded) ui.notifications.warn("Fabula Ledger: nothing to undo."); return; }
      if (act === "open-session") return api().session?.open("GM panel");
      if (act === "close-session") return api().session?.close("GM panel");
      if (act === "add") {
        const input = b.parentElement.querySelector("input");
        const a = game.actors.getName(input.value.trim());
        if (!a) return ui.notifications.warn("Fabula Ledger: no actor by that name.");
        _extra.add(a.id); input.value = ""; return render();
      }
    } finally { refresh(); }
  }

  // A button that paid nothing should say why, not look broken.
  function report(res, actor) {
    const d = res?.decision;
    if (!d || res?.forwarded || d.action === "pay") return;
    ui.notifications.info(`Fabula Ledger: ${actor?.name ?? "?"}: ${WHY[d.reason] ?? d.reason}.`);
  }

  async function onChange(ev) {
    const t = ev.target;
    if (t?.dataset?.act === "status") {
      const a = game.actors.get(t.dataset.id);
      await api().setStatus(a, t.value);
      await I().note(`${a?.name}: ${STATUS_LABEL[t.value] ?? t.value}`);
    } else if (t?.dataset?.act === "autopay") {
      await game.settings.set(MODULE_ID, "fabulaAutoPay", !!t.checked);
    }
    refresh();
  }

  // ── window ─────────────────────────────────────────────────────────────────
  function makeDraggable(el) {
    el.addEventListener("pointerdown", (ev) => {
      if (!ev.target.closest(".flg-head") || ev.target.closest("button")) return;
      const r = el.getBoundingClientRect();
      const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
      const move = (e) => {
        el.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, e.clientX - dx))}px`;
        el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy))}px`;
        el.style.bottom = "auto";
      };
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  async function show() {
    if (!game.user?.isGM) return;
    ensureStyle();
    let el = document.getElementById(ROOT_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = ROOT_ID;
      el.addEventListener("click", onClick);
      el.addEventListener("change", onChange);
      el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.dataset?.act === "add-name") el.querySelector("[data-act=add]")?.click(); });
      makeDraggable(el);
      document.body.appendChild(el);
      try {
        const { devToolsAnchorBottom } = await import(`/modules/${MODULE_ID}/scripts/battle-director/dev-tools-menu.js`);
        el.style.bottom = `${devToolsAnchorBottom()}px`;
      } catch { /* default position */ }
    }
    _open = true;
    await render();
    requestAnimationFrame(() => el.classList.add("in"));
  }

  function hide() {
    _open = false;
    const el = document.getElementById(ROOT_ID);
    if (!el) return;
    el.classList.remove("in");
    setTimeout(() => { if (!_open) el.remove(); }, 260);
  }

  const toggle = () => (_open ? hide() : show());

  // ── wiring ─────────────────────────────────────────────────────────────────
  Hooks.on("updateSetting", (setting) => {
    if (setting?.key === `${MODULE_ID}.fabulaLedgerState` || setting?.key === `${MODULE_ID}.fabulaAutoPay`) refresh();
  });
  Hooks.on("updateActor", (actor, changes) => {
    if (foundry.utils.hasProperty(changes, `system.props.${FP_PROP}`) || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) refresh();
  });

  Hooks.once("init", () => {
    game.keybindings.register(MODULE_ID, "fabulaLedgerPanel", {
      name: "Fabula Ledger: open the GM panel",
      editable: [{ key: "KeyF", modifiers: ["Shift"] }],
      restricted: true,
      onDown: () => { toggle(); return true; }
    });
  });

  Hooks.once("ready", async () => {
    if (!game.user?.isGM) return;
    try {
      const { registerDevTool } = await import(`/modules/${MODULE_ID}/scripts/battle-director/dev-tools-menu.js`);
      registerDevTool({ id: "fabula-ledger", icon: "⭐", label: "Fabula Ledger", onClick: toggle });
    } catch (e) { console.warn(TAG, "dev-tools entry not registered (Shift+F still opens it)", e); }
  });

  FL.Panel = { show, hide, toggle, render };
  console.debug(TAG, "installed");
})();
