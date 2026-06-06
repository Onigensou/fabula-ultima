// pickItem — the Item action's source-selection step (Item's "pickSkill").
//
// Renders the REAL item menu (buildItemCard — the same Use/Create tabbed list
// the action card used) as a pre-card picker overlay, and resolves with the
// chosen source. After this, composeItem runs the SHARED targeting and the
// action flows through the one pipeline exactly like a Skill — no Item-specific
// path downstream. Client-local (GM for NPCs, owner for PCs), like pickSkill.
//
// Returns: { mode:"use"|"create", key, cost, uuid, name } | null (cancelled).

import { gatherConsumables, gatherCreatables, readActorIp } from "./item-resource.js";
import { buildItemCard, ensureStyles as ensureCardStyles } from "./action-card.js";
import { log, warn } from "./logger.js";

let _chromeInjected = false;
function ensureChrome() {
  if (_chromeInjected) return;
  _chromeInjected = true;
  const css = `
  .fud-itempick-backdrop { position:fixed; inset:0; z-index:120000; display:flex;
    align-items:center; justify-content:center; background:rgba(0,0,0,.45); }
  .fud-itempick-wrap { width:min(440px,94vw); max-height:84vh; overflow:auto;
    border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,.5); }
  .fud-itempick-wrap .fud-bf-card { margin:0; }
  .fud-itempick-actions { display:flex; justify-content:flex-end; gap:8px;
    padding:10px 14px; background:var(--fud-paper,#efe7d6); border-top:1px solid rgba(0,0,0,.15);
    border-bottom-left-radius:12px; border-bottom-right-radius:12px; }
  .fud-itempick-btn { cursor:pointer; padding:6px 16px; border-radius:7px;
    border:1px solid rgba(0,0,0,.25); font-size:13px; font-weight:600; background:#fff; }
  .fud-itempick-btn.confirm { background:var(--fud-accent,#c9a24b); color:#1d1a16; }
  .fud-itempick-btn.is-disabled { opacity:.4; cursor:not-allowed; }
  `;
  const el = document.createElement("style");
  el.id = "fud-item-picker-chrome";
  el.textContent = css;
  document.head.appendChild(el);
}

export function pickItem({ director, actor, externalCancel = null } = {}) {
  return new Promise(async (resolve) => {
    if (!actor) { resolve(null); return; }
    try { ensureCardStyles(); } catch (e) { warn("pickItem: ensureCardStyles threw", e); }
    ensureChrome();

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
    const itemCandidates = { use: useList, create: createList };

    // Build the REAL item-menu card body (the UI the player is used to).
    let card;
    try {
      card = buildItemCard({ attacker: { name: actor.name }, attackerActor: actor, itemCandidates, ip });
    } catch (e) {
      warn("pickItem: buildItemCard threw", e);
      resolve(null);
      return;
    }

    const backdrop = document.createElement("div");
    backdrop.className = "fud-itempick-backdrop";
    backdrop.innerHTML = `
      <div class="fud-itempick-wrap">
        <div class="fud-bf-card">
          <div class="fud-bf-title-row">
            <div class="fud-bf-title">${card.titleIcon ?? ""}<span>${card.titleText ?? "Item"}</span></div>
          </div>
          ${card.subtitle ?? ""}
          ${card.body ?? ""}
        </div>
        <div class="fud-itempick-actions">
          <div class="fud-itempick-btn cancel">Cancel</div>
          <div class="fud-itempick-btn confirm is-disabled">Use</div>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const cardRoot = backdrop.querySelector(".fud-bf-card");
    const confirmBtn = backdrop.querySelector(".fud-itempick-btn.confirm");

    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      try { backdrop.remove(); } catch {}
      resolve(val);
    };
    if (externalCancel?.then) externalCancel.then(() => finish(null));

    backdrop.addEventListener("click", (ev) => {
      // Tab switch (mirrors postActionCard's item-tab handler).
      const tab = ev.target.closest?.(".fud-bf-item-tab");
      if (tab) {
        for (const t of cardRoot.querySelectorAll(".fud-bf-item-tab")) t.classList.toggle("is-active", t === tab);
        for (const p of cardRoot.querySelectorAll(".fud-bf-item-panel")) p.classList.toggle("is-active", p.dataset.fudItemPanel === tab.dataset.fudItemTab);
        return;
      }
      // Row select (mirrors postActionCard: store on the card root dataset).
      const row = ev.target.closest?.(".fud-bf-item-row");
      if (row) {
        if (row.dataset.fudItemDisabled === "1") return;
        for (const r of cardRoot.querySelectorAll(".fud-bf-item-row")) r.classList.toggle("is-selected", r === row);
        cardRoot.dataset.fudItemMode = row.dataset.fudItemMode || "";
        cardRoot.dataset.fudItemKey  = row.dataset.fudItemKey  || "";
        cardRoot.dataset.fudItemCost = row.dataset.fudItemCost || "0";
        confirmBtn.textContent = row.dataset.fudItemMode === "create" ? "Create" : "Use";
        confirmBtn.classList.remove("is-disabled");
        return;
      }
      if (ev.target.closest?.(".fud-itempick-btn.cancel")) { finish(null); return; }
      if (ev.target.closest?.(".fud-itempick-btn.confirm")) {
        const mode = cardRoot.dataset.fudItemMode;
        const key  = cardRoot.dataset.fudItemKey;
        if (!mode || !key) return;
        const cost = Number(cardRoot.dataset.fudItemCost) || 0;
        // Map the selection back to the candidate to recover the source uuid.
        let uuid = null, name = "";
        if (mode === "use") {
          const c = useList.find((x) => String(x.id) === String(key));
          uuid = c?.uuid ?? null; name = c?.name ?? "";
        } else {
          const c = createList.find((x) => String(x.key) === String(key));
          uuid = c?.itemUuid ?? null; name = c?.name ?? "";
        }
        if (!uuid) { warn("pickItem: selected item not resolvable", mode, key); return; }
        log(`pickItem: chose ${mode} ${name}`);
        finish({ mode, key, cost, uuid, name });
        return;
      }
      if (ev.target === backdrop) finish(null);
    });
  });
}
