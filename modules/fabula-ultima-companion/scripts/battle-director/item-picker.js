// pickItem — the Item action's source-selection step (Item's "pickSkill").
//
// Shows the player's consumables (Use) + IP-affordable recipes (Create) as a
// pre-card picker overlay, and resolves with the chosen source. After this,
// composeItem runs the SHARED targeting (resolveTargetsForSource) and the action
// flows through the one pipeline exactly like a Skill — no Item-specific path
// downstream. Reuses the action-card's `fud-bf-item-*` styling so it reads as
// the familiar item menu.
//
// Returns: { mode:"use"|"create", key, cost, uuid, name, sourceItemUuid } | null
// (null = cancelled). Client-local (GM for NPCs, owner for PCs), like pickSkill.

import { gatherConsumables, gatherCreatables, readActorIp } from "./item-resource.js";
import { log, warn } from "./logger.js";

let _stylesInjected = false;
function ensureStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const css = `
  .fud-itempick-backdrop { position:fixed; inset:0; z-index:120000; display:flex;
    align-items:center; justify-content:center; background:rgba(0,0,0,.45); }
  .fud-itempick { width:min(460px,92vw); max-height:80vh; overflow:auto;
    background:var(--fud-bg,#1d1a16); color:var(--fud-fg,#e9e2d4);
    border:1px solid var(--fud-stroke,#7a6a55); border-radius:10px;
    box-shadow:0 12px 40px rgba(0,0,0,.5); padding:14px 16px; }
  .fud-itempick h3 { margin:0 0 8px; font-size:16px; display:flex; gap:8px; align-items:center; }
  .fud-itempick .fud-itempick-tabs { display:flex; gap:6px; margin-bottom:8px; }
  .fud-itempick .fud-itempick-tab { cursor:pointer; padding:4px 10px; border-radius:6px;
    border:1px solid var(--fud-stroke,#7a6a55); opacity:.65; font-size:13px; }
  .fud-itempick .fud-itempick-tab.is-active { opacity:1; background:rgba(255,255,255,.06); }
  .fud-itempick .fud-itempick-panel { display:none; }
  .fud-itempick .fud-itempick-panel.is-active { display:block; }
  .fud-itempick .fud-bf-item-row { display:flex; align-items:center; gap:10px; padding:7px 8px;
    border-radius:7px; cursor:pointer; border:1px solid transparent; }
  .fud-itempick .fud-bf-item-row:hover { background:rgba(255,255,255,.05); }
  .fud-itempick .fud-bf-item-row.is-selected { border-color:var(--fud-accent,#c9a24b); background:rgba(201,162,75,.12); }
  .fud-itempick .fud-bf-item-row.is-disabled { opacity:.4; cursor:not-allowed; }
  .fud-itempick .fud-bf-item-icon { width:30px; height:30px; border-radius:5px; background-size:cover;
    background-position:center; background-color:rgba(255,255,255,.06); flex:0 0 auto; }
  .fud-itempick .fud-bf-item-text { flex:1 1 auto; min-width:0; }
  .fud-itempick .fud-bf-item-name { font-size:13px; font-weight:600; }
  .fud-itempick .fud-bf-item-meta { font-size:11px; opacity:.7; }
  .fud-itempick .fud-bf-item-cost { font-size:12px; opacity:.85; flex:0 0 auto; }
  .fud-itempick .fud-itempick-empty { opacity:.6; font-size:12px; padding:8px; }
  .fud-itempick .fud-itempick-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:10px; }
  .fud-itempick .fud-itempick-btn { cursor:pointer; padding:6px 14px; border-radius:7px;
    border:1px solid var(--fud-stroke,#7a6a55); font-size:13px; }
  .fud-itempick .fud-itempick-btn.confirm { background:var(--fud-accent,#c9a24b); color:#1d1a16; font-weight:600; }
  .fud-itempick .fud-itempick-btn.is-disabled { opacity:.4; cursor:not-allowed; }
  `;
  const el = document.createElement("style");
  el.id = "fud-item-picker-styles";
  el.textContent = css;
  document.head.appendChild(el);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function rowHTML(c, curIp) {
  const isCreate = c.mode === "create";
  const cost = isCreate ? Number(c.ipCost ?? 0) || 0 : null;
  const qty = !isCreate ? (c.isUnique ? "∞" : (c.quantity ?? 0)) : null;
  const disabled = isCreate && cost > curIp;
  const key = isCreate ? c.key : c.id;
  const icon = c.img
    ? `<div class="fud-bf-item-icon" style="background-image:url('${esc(c.img)}')"></div>`
    : `<div class="fud-bf-item-icon"></div>`;
  const meta = (c.skillNames?.length ? c.skillNames.map(esc).join(", ") : "");
  return `<div class="fud-bf-item-row${disabled ? " is-disabled" : ""}"
      data-mode="${esc(c.mode)}" data-key="${esc(key)}" data-cost="${isCreate ? cost : 0}"
      data-uuid="${esc(isCreate ? (c.itemUuid ?? "") : c.uuid)}" data-name="${esc(c.name)}"
      ${disabled ? 'data-disabled="1"' : ""}>
      ${icon}
      <div class="fud-bf-item-text">
        <div class="fud-bf-item-name">${esc(c.name)}</div>
        <div class="fud-bf-item-meta">${meta}</div>
      </div>
      <div class="fud-bf-item-cost">${isCreate ? `${cost} IP` : `x${qty}`}</div>
    </div>`;
}

export function pickItem({ director, actor, externalCancel = null } = {}) {
  return new Promise(async (resolve) => {
    if (!actor) { resolve(null); return; }
    ensureStyles();
    const [useList, createList] = await Promise.all([
      gatherConsumables(actor).catch((e) => { warn("pickItem: gatherConsumables threw", e); return []; }),
      gatherCreatables(actor).catch((e) => { warn("pickItem: gatherCreatables threw", e); return []; }),
    ]);
    if (!useList.length && !createList.length) {
      ui.notifications?.warn("No consumables to use and no recipes to create.");
      resolve(null);
      return;
    }
    const ip = readActorIp(actor);
    const curIp = Number(ip?.current ?? 0) || 0;
    const initialTab = useList.length ? "use" : "create";

    const backdrop = document.createElement("div");
    backdrop.className = "fud-itempick-backdrop";
    backdrop.innerHTML = `
      <div class="fud-itempick" role="dialog" aria-label="Use an Item">
        <h3><i class="fa-solid fa-flask"></i> Use an Item</h3>
        <div class="fud-itempick-tabs">
          <div class="fud-itempick-tab ${initialTab === "use" ? "is-active" : ""}" data-tab="use">Use (${useList.length})</div>
          <div class="fud-itempick-tab ${initialTab === "create" ? "is-active" : ""}" data-tab="create">Create (${createList.length})</div>
        </div>
        <div class="fud-itempick-panel ${initialTab === "use" ? "is-active" : ""}" data-panel="use">
          ${useList.length ? useList.map((c) => rowHTML(c, curIp)).join("") : `<div class="fud-itempick-empty">No owned consumables.</div>`}
        </div>
        <div class="fud-itempick-panel ${initialTab === "create" ? "is-active" : ""}" data-panel="create">
          ${createList.length ? createList.map((c) => rowHTML(c, curIp)).join("") : `<div class="fud-itempick-empty">No creatable recipes.</div>`}
        </div>
        <div class="fud-itempick-actions">
          <div class="fud-itempick-btn cancel">Cancel</div>
          <div class="fud-itempick-btn confirm is-disabled">Use</div>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    let selected = null; // { mode, key, cost, uuid, name }
    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      try { backdrop.remove(); } catch {}
      if (cancelOff) { try { cancelOff(); } catch {} }
      resolve(val);
    };
    // External cancel (e.g. GM won the race / battle ended).
    let cancelOff = null;
    if (externalCancel?.then) externalCancel.then(() => finish(null));

    const confirmBtn = backdrop.querySelector(".fud-itempick-btn.confirm");
    backdrop.addEventListener("click", (ev) => {
      const tab = ev.target.closest?.(".fud-itempick-tab");
      if (tab) {
        for (const t of backdrop.querySelectorAll(".fud-itempick-tab")) t.classList.toggle("is-active", t === tab);
        for (const p of backdrop.querySelectorAll(".fud-itempick-panel")) p.classList.toggle("is-active", p.dataset.panel === tab.dataset.tab);
        return;
      }
      const row = ev.target.closest?.(".fud-bf-item-row");
      if (row) {
        if (row.dataset.disabled === "1") return;
        for (const r of backdrop.querySelectorAll(".fud-bf-item-row")) r.classList.toggle("is-selected", r === row);
        selected = { mode: row.dataset.mode, key: row.dataset.key, cost: Number(row.dataset.cost) || 0, uuid: row.dataset.uuid || null, name: row.dataset.name || "" };
        confirmBtn.textContent = selected.mode === "create" ? "Create" : "Use";
        confirmBtn.classList.remove("is-disabled");
        return;
      }
      if (ev.target.closest?.(".fud-itempick-btn.cancel")) { finish(null); return; }
      if (ev.target.closest?.(".fud-itempick-btn.confirm")) {
        if (!selected) return;
        log(`pickItem: chose ${selected.mode} ${selected.name}`);
        finish(selected);
        return;
      }
      // Click on the backdrop (outside the dialog) cancels.
      if (ev.target === backdrop) finish(null);
    });
  });
}
