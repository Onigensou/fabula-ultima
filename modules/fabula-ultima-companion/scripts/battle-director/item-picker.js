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
  /* The card styles itself (320px parchment panel w/ its own border+shadow).
     The footer lives INSIDE it so it matches the card's width + background. */
  .fud-itempick-card { max-height:86vh; overflow:hidden auto; }
  .fud-itempick-card .fud-itempick-hint { display:flex; align-items:center;
    justify-content:space-between; gap:10px; margin:11px -14px -11px; padding:9px 14px;
    border-top:1px solid rgba(0,0,0,.18); background:rgba(0,0,0,.05);
    border-bottom-left-radius:12px; border-bottom-right-radius:12px;
    font-size:12px; color:var(--fud-ink,#3a3228); }
  .fud-itempick-card .fud-itempick-btn { cursor:pointer; padding:5px 16px; border-radius:7px;
    border:1px solid rgba(0,0,0,.3); font-size:12px; font-weight:600;
    background:#fff; color:var(--fud-ink,#3a3228); }
  .fud-itempick-card .fud-itempick-btn:hover { background:rgba(0,0,0,.08); }
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
      <div class="fud-bf-card fud-itempick-card" role="dialog" aria-label="Use an Item">
        <div class="fud-bf-title-row">
          <div class="fud-bf-title">${card.titleIcon ?? ""}<span>${card.titleText ?? "Item"}</span></div>
        </div>
        ${card.subtitle ?? ""}
        ${card.body ?? ""}
        <div class="fud-itempick-hint">
          <span>Click an item to choose its target</span>
          <div class="fud-itempick-btn cancel">Cancel</div>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const cardRoot = backdrop.querySelector(".fud-bf-card");

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
      // Row click → choose immediately and proceed to targeting (no separate
      // Confirm — the player confirms the TARGET next anyway).
      const row = ev.target.closest?.(".fud-bf-item-row");
      if (row) {
        if (row.dataset.fudItemDisabled === "1") return;
        const mode = row.dataset.fudItemMode;
        const key  = row.dataset.fudItemKey;
        if (!mode || !key) return;
        const cost = Number(row.dataset.fudItemCost) || 0;
        // Map the row back to the candidate to recover the source uuid.
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
      if (ev.target.closest?.(".fud-itempick-btn.cancel")) { finish(null); return; }
      if (ev.target === backdrop) finish(null);
    });
  });
}
