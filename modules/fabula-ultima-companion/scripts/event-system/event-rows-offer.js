/**
 * [ONI] Event System — Offer Item
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-offer.js
 *
 * What this does:
 * - Registers the "Offer Item" event action. An offer box opens on every
 *   screen: on the left the slots ("Upon the stone"), on the right the party
 *   bag as a grid of icons sorted by type, with the item's text on hover.
 *   The main controller drags (or clicks) items into the slots and presses
 *   Offer; everyone else watches the same box, read-only.
 * - Who judges, set on the row:
 *     Automatic  the row checks the offering against its rule
 *                (free choice / these item names / one item type)
 *                and runs Accepted or Refused.
 *     GM Prompt  the main GM gets the offering in the event's status chip,
 *                with one button per preset the writer gave the row; each
 *                preset is its own branch. "Hand back" reopens the box.
 * - Withdrawn runs when the controller takes the items back.
 * - The row never takes the items away. Consuming them is a separate action
 *   (Change Items: "the offered items"), so a writer can keep them.
 * - The offering and its verdict are kept in the event's memory on the party
 *   database ("Last offering"), so a later Condition can read them.
 *
 * Multi-GM (the main GM + GM II/III as assistants):
 * - Only the main GM (FUCompanion.isPrimaryGM: core's activeGM, which ranks a
 *   Gamemaster above an Assistant) gets the verdict buttons. Other GM clients
 *   see the offering read-only. The GM running the event accepts a verdict
 *   only from the main GM; with no main GM connected, core hands the role to
 *   the next GM, so the prompt cannot strand the event.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js,
 *   event-gameState.js, event-gmChip.js, event-rows-check.js (controller)
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsOffer]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsOffer?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Client = window.oni.EventSystem.Client;
  if (!Logic || !EventRegistry || !Client) {
    console.error(INSTALL_TAG, "Missing Logic, EventRegistry or Client. Check load order.");
    return;
  }

  const KIND_OPEN = "offer.open";
  const KIND_SLOTS = "offer.slots";
  const KIND_JUDGING = "offer.judging";
  const KIND_REOPEN = "offer.reopen";
  const KIND_CLOSE = "offer.close";
  const REQUEST = "offerItem";

  const STYLE_ID = "oni-event-offer-style";
  const BOX_ID = "oni-event-offer";
  const TIP_ID = "oni-event-offer-tip";

  const MIN_COUNT = 1;
  const MAX_COUNT = 5;
  const MAX_PRESETS = 4;
  const RETRY = "__handBack";
  const BOX_OUT_MS = 260;

  // Order of the type groups in the bag.
  const TYPE_ORDER = ["key", "material", "consumable", "weapon", "armor", "shield", "accessory"];

  const flow = () => window.oni.EventSystem.Flow;
  const chip = () => window.oni.EventSystem.GmChip;
  const gameState = () => window.oni.EventSystem.GameState;
  const isMainGM = () => (typeof globalThis.FUCompanion?.isPrimaryGM === "function" ? globalThis.FUCompanion.isPrimaryGM() : !!game.user?.isGM);
  const mainGM = () => globalThis.FUCompanion?.primaryGM?.() ?? game.users?.activeGM ?? null;

  const esc = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // On the GM running the event: sourceId -> the open offering.
  const pending = new Map();
  // On every client: sourceId -> what this screen shows.
  const shown = new Map();

  // ------------------------------------------------------------
  // The bag, as sent to every screen (built on the GM running the event)
  // ------------------------------------------------------------
  function textLines(html) {
    const raw = String(html ?? "");
    if (!raw.trim()) return [];
    const div = document.createElement("div");
    div.innerHTML = raw;
    const clean = (el) => el.textContent.replace(/\s+/g, " ").trim();
    const items = [...div.querySelectorAll("li")].map(clean).filter(Boolean);
    if (items.length) return items.slice(0, 6);
    const paras = [...div.querySelectorAll("p")].map(clean).filter(Boolean);
    if (paras.length) return paras.slice(0, 4);
    const whole = clean(div);
    return whole ? [whole] : [];
  }

  function bagForBox() {
    const list = gameState()?.bagItems?.() ?? [];
    return list.map(i => ({
      id: i.id,
      name: i.name,
      type: i.type,
      qty: i.qty,
      img: i.img || "icons/svg/item-bag.svg",
      fx: textLines(i.item?.system?.props?.description),
      fv: textLines(i.item?.system?.props?.flavor_text).join(" ").slice(0, 260)
    })).sort((a, b) => (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)) || a.name.localeCompare(b.name));
  }

  // Slots hold item ids; a stack can fill as many slots as it has units.
  function cleanSlots(slots, bag, rule, count) {
    const byId = new Map(bag.map(i => [i.id, i]));
    const used = new Map();
    const out = [];
    for (let k = 0; k < count; k += 1) {
      const id = Array.isArray(slots) ? slots[k] : null;
      const item = id ? byId.get(id) : null;
      if (!item || !Logic.offerAllows(rule, item) || (used.get(id) ?? 0) >= item.qty) { out.push(null); continue; }
      used.set(id, (used.get(id) ?? 0) + 1);
      out.push(id);
    }
    return out;
  }

  // ------------------------------------------------------------
  // Look
  // ------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = document.createElement("style");
    css.id = STYLE_ID;
    css.textContent = `
#${BOX_ID} { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 75;
  width: min(720px, 94vw); max-height: 88vh; box-sizing: border-box; padding: 14px 14px 12px;
  display: flex; flex-direction: column; gap: 10px;
  border: 2px solid #c9a44a; border-radius: 14px; background: linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%);
  box-shadow: 0 10px 30px rgba(0,0,0,.55); font-family: "Signika","Noto Sans","Segoe UI",sans-serif; color: #3a1e06;
  opacity: 0; transition: opacity .22s ease-out; pointer-events: auto; }
#${BOX_ID}.is-in { opacity: 1; }
#${BOX_ID}.is-leaving { opacity: 0; transition: opacity ${BOX_OUT_MS}ms ease-in; }
#${BOX_ID}::before { content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: 12px;
  background: repeating-linear-gradient(0deg, transparent, transparent 23px, rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px); }
#${BOX_ID} > * { position: relative; }
#${BOX_ID} .ofr-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
#${BOX_ID} .ofr-title { font-family: "Cinzel","Signika",serif; font-weight: 700; font-size: 18px; color: #2a1c0f; }
#${BOX_ID} .ofr-ask { font-size: 13px; color: #6a4a26; }
#${BOX_ID} .ofr-banner { font-size: 12px; background: rgba(58,30,6,.85); color: #f4e8c0; border-radius: 7px; padding: 4px 10px; text-align: center; }
#${BOX_ID} .ofr-body { display: grid; grid-template-columns: minmax(0, 190px) minmax(0, 1fr); gap: 12px; min-height: 0; }
#${BOX_ID} .ofr-box { display: flex; flex-direction: column; gap: 8px; border: 1px dashed rgba(122,78,32,.55); border-radius: 10px;
  padding: 10px; background: rgba(255,250,230,.45); min-height: 0; }
#${BOX_ID} .ofr-lbl { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #7a5230; font-weight: 700; }
#${BOX_ID} .ofr-slots { display: flex; flex-wrap: wrap; gap: 8px; }
#${BOX_ID} .ofr-slot { width: 54px; height: 54px; border-radius: 9px; border: 2px dashed rgba(122,78,32,.5); background: rgba(122,78,32,.08);
  display: grid; place-items: center; position: relative; box-sizing: border-box; }
#${BOX_ID} .ofr-slot.is-over { border-color: #c9a44a; background: rgba(201,164,74,.25); }
#${BOX_ID} .ofr-slot .n { position: absolute; bottom: -1px; right: 3px; font-size: 10px; color: #9b7040; }
#${BOX_ID} .ofr-bag { display: flex; flex-direction: column; gap: 8px; overflow: auto; max-height: min(46vh, 380px); padding-right: 4px; }
#${BOX_ID} .ofr-cat { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #7a5230; font-weight: 700;
  display: flex; justify-content: space-between; }
#${BOX_ID} .ofr-grid { display: grid; grid-template-columns: repeat(auto-fill, 44px); gap: 6px; }
#${BOX_ID} .ofr-ic { width: 44px; height: 44px; border-radius: 8px; display: grid; place-items: center; position: relative; cursor: grab; box-sizing: border-box;
  background: radial-gradient(circle at 50% 40%, #fff8e6 0%, #e2d0a8 100%); border: 1px solid rgba(91,63,38,.7); box-shadow: inset 0 1px 0 rgba(255,255,255,.6); }
#${BOX_ID} .ofr-ic img { width: 36px; height: 36px; object-fit: contain; pointer-events: none; border: 0; }
#${BOX_ID} .ofr-ic .q { position: absolute; right: 2px; bottom: 0; font-size: 10px; font-weight: 700; color: #fff; text-shadow: 0 0 2px #000, 0 0 2px #000; }
#${BOX_ID} .ofr-ic.is-used { opacity: .3; cursor: default; }
#${BOX_ID} .ofr-ic:not(.is-used):hover { outline: 2px solid #c9a44a; }
#${BOX_ID}.is-readonly .ofr-ic { cursor: default; }
#${BOX_ID} .ofr-slot .ofr-ic { cursor: pointer; }
#${BOX_ID} .ofr-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
#${BOX_ID} .ofr-hint { font-size: 12px; color: #6a4a26; flex: 1 1 220px; }
#${BOX_ID} .ofr-btns { display: flex; gap: 8px; }
#${BOX_ID} .ofr-btn { border: 1px solid #9b7040; border-radius: 8px; background: linear-gradient(180deg, #7a5230 0%, #5c3818 100%); color: #f4e8c0;
  padding: 7px 14px; font-family: inherit; font-size: 14px; cursor: pointer; line-height: 1.2; }
#${BOX_ID} .ofr-btn:hover:not(:disabled) { border-color: #f4d488; color: #fff8e0; background: linear-gradient(180deg, #9b6840 0%, #7a4a22 100%); }
#${BOX_ID} .ofr-btn:disabled { background: linear-gradient(180deg, #6a5a44 0%, #4c3e2c 100%); color: #c9bda4; cursor: not-allowed; opacity: .8; }
#${BOX_ID} .ofr-btn.is-danger { background: linear-gradient(180deg, #7a2e18 0%, #5a1c08 100%); }
#${TIP_ID} { position: fixed; z-index: 100; width: 270px; pointer-events: none; padding: 10px 12px; box-sizing: border-box;
  border: 2px solid #c9a44a; border-radius: 12px; background: linear-gradient(168deg, #f8f0d4 0%, #ede0b0 100%); color: #3a1e06;
  box-shadow: 0 8px 22px rgba(0,0,0,.5); font: 13px/1.4 "Signika","Noto Sans","Segoe UI",sans-serif; }
#${TIP_ID} .nm { font-family: "Cinzel","Signika",serif; font-weight: 700; font-size: 14px; color: #2a1c0f; }
#${TIP_ID} .ty { font-size: 11px; color: #7a5230; letter-spacing: .08em; text-transform: uppercase; }
#${TIP_ID} ul { margin: 6px 0 0; padding-left: 16px; }
#${TIP_ID} .fv { margin-top: 6px; font-style: italic; color: #5a3a1a; }
.oni-offer-chip-items { display: flex; flex-direction: column; gap: 4px; margin: 4px 0; }
.oni-offer-chip-item { display: flex; gap: 6px; align-items: center; font-size: 12px; }
.oni-offer-chip-item img { width: 26px; height: 26px; object-fit: contain; border: 0; }
.oni-offer-chip-note { font-size: 11px; opacity: .85; margin: 2px 0 4px; }
@media (max-width: 640px) { #${BOX_ID} .ofr-body { grid-template-columns: minmax(0, 1fr); } }
`;
    document.head.appendChild(css);
  }

  // ------------------------------------------------------------
  // The box (every client that presents)
  // ------------------------------------------------------------
  // inSlot: a slot holds one unit, so no stack count there.
  function iconHtml(item, extra = "", inSlot = false) {
    if (!item) return "";
    return `<div class="ofr-ic ${extra}" data-id="${esc(item.id)}" tabindex="0" aria-label="${esc(item.name)}">
      <img src="${esc(item.img)}" alt="">${!inSlot && item.qty > 1 ? `<span class="q">${item.qty}</span>` : ""}</div>`;
  }

  function tipEl() {
    let el = document.getElementById(TIP_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = TIP_ID;
      el.hidden = true;
      document.body.appendChild(el);
    }
    return el;
  }

  function showTip(item, x, y) {
    if (!item) return;
    const el = tipEl();
    el.innerHTML = `<div class="nm">${esc(item.name)}</div>
      <div class="ty">${esc(Logic.ITEM_TYPES[item.type] ?? item.type)}${item.qty > 1 ? ` · ×${item.qty}` : ""}</div>
      ${item.fx?.length ? `<ul>${item.fx.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
      ${item.fv ? `<div class="fv">${esc(item.fv)}</div>` : ""}`;
    el.hidden = false;
    moveTip(x, y);
  }

  function moveTip(x, y) {
    const el = document.getElementById(TIP_ID);
    if (!el || el.hidden) return;
    const w = 280, h = el.offsetHeight || 120;
    let left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 10;
    if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }

  function hideTip() {
    const el = document.getElementById(TIP_ID);
    if (el) el.hidden = true;
  }

  function sendSlots(sourceId, slots) {
    flow()?.request?.(REQUEST, { sourceId, op: "slots", slots });
  }

  function render(sourceId) {
    const view = shown.get(sourceId);
    if (!view) return;
    ensureStyle();

    let el = document.getElementById(BOX_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = BOX_ID;
      document.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add("is-in"));
    }

    const { box, bag } = view;
    const byId = new Map(bag.map(i => [i.id, i]));
    const live = view.canAct && view.phase === "choosing";
    const usedCount = new Map();
    for (const id of view.slots) if (id) usedCount.set(id, (usedCount.get(id) ?? 0) + 1);
    const full = view.slots.length > 0 && view.slots.every(Boolean);

    const groups = TYPE_ORDER.map((type) => {
      const list = bag.filter(i => i.type === type);
      if (!list.length) return "";
      return `<div><div class="ofr-cat"><span>${esc(Logic.ITEM_TYPES[type])}</span><span>${list.length}</span></div>
        <div class="ofr-grid">${list.map(i => iconHtml(i, ((usedCount.get(i.id) ?? 0) >= i.qty || !Logic.offerAllows(box.rule, i)) ? "is-used" : "")).join("")}</div></div>`;
    }).join("") || `<div class="ofr-hint">The party bag is empty.</div>`;

    let banner = "";
    if (view.phase === "judging") banner = "The offering is being weighed…";
    else if (!view.canAct) banner = `${box.who || "The controller"} is making an offering.`;

    const hint = !view.canAct
      ? "Only the main controller can move items."
      : view.phase === "judging"
        ? "Waiting for the verdict."
        : "Drag an item onto a slot, or click it. Click an item on a slot to take it back. Hover an item to read it.";

    el.className = `${el.classList.contains("is-in") ? "is-in" : ""} ${live ? "" : "is-readonly"}`.trim();
    el.innerHTML = `
      ${banner ? `<div class="ofr-banner">${esc(banner)}</div>` : ""}
      <div class="ofr-head"><span class="ofr-title">${esc(box.title)}</span><span class="ofr-ask">${esc(box.ask)}</span></div>
      <div class="ofr-body">
        <div class="ofr-box"><span class="ofr-lbl">${esc(box.slotLabel)}</span>
          <div class="ofr-slots">${view.slots.map((id, k) => `<div class="ofr-slot" data-slot="${k}">${id ? iconHtml(byId.get(id), "", true) : ""}<span class="n">${k + 1}</span></div>`).join("")}</div>
        </div>
        <div class="ofr-box"><span class="ofr-lbl">Party bag</span><div class="ofr-bag">${groups}</div></div>
      </div>
      <div class="ofr-foot"><span class="ofr-hint">${esc(hint)}</span>
        <div class="ofr-btns">
          <button type="button" class="ofr-btn is-danger" data-op="withdraw" ${live ? "" : "disabled"}>Take back</button>
          <button type="button" class="ofr-btn" data-op="confirm" ${live && full ? "" : "disabled"}>Offer</button>
        </div>
      </div>`;

    // Hover text for every icon, on every screen.
    for (const ic of el.querySelectorAll(".ofr-ic")) {
      const item = byId.get(ic.dataset.id);
      ic.addEventListener("pointerenter", (e) => showTip(item, e.clientX, e.clientY));
      ic.addEventListener("pointermove", (e) => moveTip(e.clientX, e.clientY));
      ic.addEventListener("pointerleave", hideTip);
      ic.addEventListener("focus", () => { const r = ic.getBoundingClientRect(); showTip(item, r.right, r.top); });
      ic.addEventListener("blur", hideTip);
    }
    if (!live) return;

    const place = (id, at) => {
      const item = byId.get(id);
      if (!item || !Logic.offerAllows(box.rule, item) || (usedCount.get(id) ?? 0) >= item.qty) return;
      const slot = Number.isInteger(at) ? at : view.slots.indexOf(null);
      if (slot < 0 || slot >= view.slots.length) return;
      const next = view.slots.slice();
      next[slot] = id;
      view.slots = next;
      hideTip();
      render(sourceId);
      sendSlots(sourceId, next);
    };

    for (const ic of el.querySelectorAll(".ofr-bag .ofr-ic:not(.is-used)")) {
      ic.draggable = true;
      ic.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", ic.dataset.id); hideTip(); });
      ic.addEventListener("click", () => place(ic.dataset.id));
      ic.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); place(ic.dataset.id); } });
    }
    for (const slot of el.querySelectorAll(".ofr-slot")) {
      const k = Number(slot.dataset.slot);
      slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.classList.add("is-over"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("is-over"));
      slot.addEventListener("drop", (e) => { e.preventDefault(); place(e.dataTransfer.getData("text/plain"), k); });
      slot.querySelector(".ofr-ic")?.addEventListener("click", () => {
        const next = view.slots.slice();
        next[k] = null;
        view.slots = next;
        hideTip();
        render(sourceId);
        sendSlots(sourceId, next);
      });
    }
    for (const btn of el.querySelectorAll("[data-op]")) {
      btn.addEventListener("click", () => {
        hideTip();
        flow()?.request?.(REQUEST, { sourceId, op: btn.dataset.op, slots: view.slots });
      });
    }
  }

  function closeBox(sourceId, { immediate = false } = {}) {
    shown.delete(sourceId);
    hideTip();
    const el = document.getElementById(BOX_ID);
    if (!el || shown.size) return;
    if (immediate) { el.remove(); return; }
    el.classList.add("is-leaving");
    setTimeout(() => { if (!shown.size) el.remove(); }, BOX_OUT_MS + 40);
  }

  // ------------------------------------------------------------
  // The GM side, in the status chip
  // ------------------------------------------------------------
  function chipItems(view) {
    const byId = new Map(view.bag.map(i => [i.id, i]));
    return `<div class="oni-offer-chip-items">${view.slots.filter(Boolean).map((id) => {
      const it = byId.get(id);
      return it ? `<div class="oni-offer-chip-item" title="${esc(it.fx?.join(" · ") ?? "")}"><img src="${esc(it.img)}" alt=""><span><b>${esc(it.name)}</b> · ${esc(Logic.ITEM_TYPES[it.type] ?? it.type)}</span></div>` : "";
    }).join("")}</div>`;
  }

  function buildGmPanel(sourceId) {
    const view = shown.get(sourceId);
    if (!view) return null;
    const wrap = document.createElement("div");
    const main = isMainGM();
    const { box } = view;

    if (view.phase === "choosing") {
      wrap.innerHTML = `<div class="oni-chip-panel-title">Offering: ${esc(box.who || "the controller")} is choosing ${box.count} item${box.count > 1 ? "s" : ""}.</div>`;
      if (main) {
        const row = document.createElement("div");
        row.className = "oni-chip-panel-buttons";
        row.innerHTML = `<button type="button" class="oni-chip-btn" title="Close the box as if they took the items back">Withdraw for them</button>`;
        row.querySelector("button").addEventListener("click", () => flow()?.request?.(REQUEST, { sourceId, op: "withdraw" }));
        wrap.appendChild(row);
      }
      return wrap;
    }

    // Judging (GM Prompt only reaches here with buttons).
    wrap.innerHTML = `<div class="oni-chip-panel-title">Offering from ${esc(box.who || "the controller")}${main ? ": your verdict" : ""}</div>
      ${box.gmNote ? `<div class="oni-offer-chip-note">${esc(box.gmNote)}</div>` : ""}
      ${chipItems(view)}`;

    if (!main) {
      const who = mainGM()?.name ?? "the main GM";
      wrap.insertAdjacentHTML("beforeend", `<div class="oni-offer-chip-note">Waiting for ${esc(who)}'s verdict.</div>`);
      return wrap;
    }

    const row = document.createElement("div");
    row.className = "oni-chip-panel-buttons";
    for (const preset of box.presets ?? []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "oni-chip-btn";
      btn.textContent = preset.label || "…";
      btn.addEventListener("click", () => flow()?.request?.(REQUEST, { sourceId, op: "verdict", presetId: preset.id }));
      row.appendChild(btn);
    }
    const back = document.createElement("button");
    back.type = "button";
    back.className = "oni-chip-btn";
    back.textContent = "Hand back, let them try again";
    back.addEventListener("click", () => flow()?.request?.(REQUEST, { sourceId, op: "verdict", presetId: RETRY }));
    row.appendChild(back);
    wrap.appendChild(row);
    return wrap;
  }

  function refreshChip(sourceId) {
    if (!game.user?.isGM) return;
    chip()?.setPanel?.(sourceId, buildGmPanel(sourceId));
  }

  // ------------------------------------------------------------
  // On every client
  // ------------------------------------------------------------
  Client.register(KIND_OPEN, (data, info) => {
    const box = data.box;
    if (!box) return;
    const view = {
      box,
      bag: Array.isArray(data.bag) ? data.bag : [],
      slots: Array.isArray(data.slots) ? data.slots : Array(box.count).fill(null),
      phase: "choosing",
      canAct: false
    };
    shown.set(info.sourceId, view);
    Client.setMarker(info.sourceId, "offer", "making an offering");
    Client.addCleanup(info.sourceId, "offer", () => {
      closeBox(info.sourceId, { immediate: true });
      chip()?.setPanel?.(info.sourceId, null);
    });

    refreshChip(info.sourceId);

    if (!info.presents) return;
    render(info.sourceId);
    // Only the main controller moves items; GMs act from the chip.
    if (!game.user?.isGM) {
      Promise.resolve(flow()?.isUserInteractor?.(game.user?.id)).then((ok) => {
        const v = shown.get(info.sourceId);
        if (!v) return;
        v.canAct = !!ok;
        render(info.sourceId);
      });
    }
  });

  Client.register(KIND_SLOTS, (data, info) => {
    const view = shown.get(info.sourceId);
    if (!view || !Array.isArray(data.slots)) return;
    view.slots = data.slots;
    if (data.bag) view.bag = data.bag;
    if (info.presents) render(info.sourceId);
    refreshChip(info.sourceId);
  });

  Client.register(KIND_JUDGING, (data, info) => {
    const view = shown.get(info.sourceId);
    if (!view) return;
    view.phase = "judging";
    if (Array.isArray(data.slots)) view.slots = data.slots;
    Client.setMarker(info.sourceId, "offer", "waiting for the verdict");
    if (info.presents) render(info.sourceId);
    refreshChip(info.sourceId);
  });

  Client.register(KIND_REOPEN, (data, info) => {
    const view = shown.get(info.sourceId);
    if (!view) return;
    view.phase = "choosing";
    if (Array.isArray(data.slots)) view.slots = data.slots;
    if (Array.isArray(data.bag)) view.bag = data.bag;
    Client.setMarker(info.sourceId, "offer", "making an offering");
    if (info.presents) render(info.sourceId);
    refreshChip(info.sourceId);
  });

  Client.register(KIND_CLOSE, (_data, info) => {
    closeBox(info.sourceId);
    chip()?.setPanel?.(info.sourceId, null);
    Client.setMarker(info.sourceId, "offer", null);
  });

  // ------------------------------------------------------------
  // On the GM running the event
  // ------------------------------------------------------------
  async function onRequest(data, userId) {
    const sourceId = String(data?.sourceId || "");
    const wait = pending.get(sourceId);
    if (!wait) return;
    const user = game.users?.get(userId);

    if (data.op === "verdict") {
      // Only the main GM judges. (The runner reads who that is now, so a
      // main GM who drops out hands the role to the next GM.)
      const main = mainGM();
      if (!user?.isGM || (main && main.id !== userId)) return;
      if (wait.phase !== "judging") return;
      if (data.presetId === RETRY) {
        wait.phase = "choosing";
        wait.bag = bagForBox();
        wait.slots = cleanSlots(wait.slots, wait.bag, wait.rule, wait.count);
        Client.run(sourceId, KIND_REOPEN, { slots: wait.slots, bag: wait.bag });
        return;
      }
      const preset = wait.presets.find(p => p.id === data.presetId);
      if (preset) wait.resolve({ kind: "verdict", preset });
      return;
    }

    // Withdraw: the controller, or the main GM from the chip.
    const mayAct = user?.isGM ? (!mainGM() || mainGM().id === userId) : !!(await flow()?.isUserInteractor?.(userId));
    if (!mayAct || !pending.has(sourceId) || wait.phase !== "choosing") return;

    if (data.op === "withdraw") {
      wait.resolve({ kind: "withdrawn" });
      return;
    }

    if (user?.isGM) return; // the GM does not move items for the table

    if (data.op === "slots") {
      wait.slots = cleanSlots(data.slots, wait.bag, wait.rule, wait.count);
      Client.run(sourceId, KIND_SLOTS, { slots: wait.slots });
      return;
    }

    if (data.op === "confirm") {
      // The bag may have changed since the box opened (an item used or traded).
      const freshBag = bagForBox();
      const slots = cleanSlots(data.slots, freshBag, wait.rule, wait.count);
      wait.bag = freshBag;
      if (!slots.every(Boolean)) {
        wait.slots = slots;
        Client.run(sourceId, KIND_SLOTS, { slots, bag: freshBag });
        return;
      }
      wait.slots = slots;
      const byId = new Map(freshBag.map(i => [i.id, i]));
      const items = slots.map(id => ({ name: byId.get(id)?.name ?? "", type: byId.get(id)?.type ?? "" }));

      if (wait.judge === "auto") {
        wait.resolve({ kind: Logic.judgeOffering(wait.rule, items) ? "accepted" : "refused", items });
        return;
      }
      wait.phase = "judging";
      wait.items = items;
      Client.run(sourceId, KIND_JUDGING, { slots });
    }
  }

  Hooks.once("ready", () => flow()?.onRequest?.(REQUEST, onRequest));

  // ------------------------------------------------------------
  // The action
  // ------------------------------------------------------------
  function prepare(row) {
    row.count = Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(Logic.toNumber(row.count, 3))));
    row.mode = ["free", "specific", "type"].includes(row.mode) ? row.mode : "free";
    row.names = Logic.nameList(row.names).join(", ");
    row.itemType = Logic.ITEM_TYPES[row.itemType] ? row.itemType : "key";
    row.judge = row.judge === "auto" ? "auto" : "gm";
    row.title = String(row.title ?? "").trim();
    row.ask = String(row.ask ?? "").trim();
    row.gmNote = String(row.gmNote ?? "");
    let presets = Array.isArray(row.presets) ? row.presets : [];
    presets = presets.slice(0, MAX_PRESETS).map(p => ({
      id: String(p?.id || Logic.makeId()),
      label: String(p?.label ?? ""),
      rows: Array.isArray(p?.rows) ? p.rows : []
    }));
    if (!presets.length) presets = [{ id: Logic.makeId(), label: "Accept", rows: [] }, { id: Logic.makeId(), label: "Refuse", rows: [] }];
    row.presets = presets;
    for (const key of ["acceptedRows", "refusedRows", "withdrawnRows"]) {
      if (!Array.isArray(row[key])) row[key] = [];
    }
  }

  function defaultAsk(row) {
    const n = row.count;
    if (row.mode === "type") return `Offer ${n} ${Logic.ITEM_TYPES[row.itemType]} item${n > 1 ? "s" : ""}.`;
    return `Offer ${n} item${n > 1 ? "s" : ""}.`;
  }

  async function controllerName(context) {
    try {
      const found = await window.oni.EventSystem.RowsCheck?.resolveTargets?.({ targets: [{ kind: "controller", slot: 1, name: "" }] }, context);
      return found?.actors?.[0]?.name ?? "";
    } catch (_) {
      return "";
    }
  }

  async function execute(row, context) {
    const sourceId = String(context?.tileId || "");
    const f = flow();
    if (!sourceId || !f) return { ok: false, reason: "noFlow" };

    const withVars = (t) => Logic.substituteVars(t, (n) => (gameState()?.getVariableText ?? gameState()?.getVariable)?.(n));
    const bag = bagForBox();
    const rule = { mode: row.mode, names: row.names, itemType: row.itemType };
    const box = {
      title: withVars(row.title) || "Offering",
      ask: withVars(row.ask) || defaultAsk(row),
      slotLabel: "Offering",
      count: row.count,
      rule,
      who: await controllerName(context),
      gmNote: row.judge === "gm" ? withVars(row.gmNote) : "",
      presets: row.judge === "gm" ? row.presets.map(p => ({ id: p.id, label: withVars(p.label) })) : []
    };

    let resolveAnswer;
    const answered = new Promise((resolve) => { resolveAnswer = resolve; });
    const wait = {
      phase: "choosing",
      count: row.count,
      rule,
      judge: row.judge,
      presets: row.presets,
      bag,
      slots: Array(row.count).fill(null),
      items: [],
      resolve: (answer) => resolveAnswer(answer)
    };
    pending.set(sourceId, wait);

    f.hold(sourceId);
    const offAbort = f.onAbort(sourceId, () => resolveAnswer({ kind: "abort" }));
    Client.run(sourceId, KIND_OPEN, { box, bag, slots: wait.slots });

    const answer = await answered;

    offAbort();
    pending.delete(sourceId);
    f.release(sourceId);
    Client.run(sourceId, KIND_CLOSE, {});

    if (answer.kind === "abort") return { ok: true, type: "offerItem", aborted: true };
    await f.wait(sourceId, BOX_OUT_MS + 80);

    let verdict, rows;
    if (answer.kind === "withdrawn") { verdict = "Withdrawn"; rows = row.withdrawnRows; }
    else if (answer.kind === "accepted") { verdict = "Accepted"; rows = row.acceptedRows; }
    else if (answer.kind === "refused") { verdict = "Refused"; rows = row.refusedRows; }
    else { verdict = answer.preset?.label || "Verdict"; rows = answer.preset?.rows ?? []; }

    const items = answer.kind === "withdrawn" ? [] : (answer.items ?? wait.items ?? []);
    // Remembered for later checks, and for Change Items' "the offered items".
    const offeredIds = answer.kind === "withdrawn" ? [] : wait.slots.filter(Boolean);
    lastOffered.set(sourceId, offeredIds);
    try {
      await gameState()?.setOffering?.(context?.sceneId, sourceId, { items, verdict });
    } catch (e) {
      console.warn(INSTALL_TAG, "Could not remember the offering.", e);
    }

    const result = await context.runRows(rows);
    return { ...result, type: "offerItem", verdict };
  }

  // sourceId -> the item ids of this run's last offering (one entry per slot),
  // for Change Items. Only on the GM running the event.
  const lastOffered = new Map();

  // ------------------------------------------------------------
  // Config window
  // ------------------------------------------------------------
  function buildPresetElement(preset, kit, onChange) {
    const el = document.createElement("div");
    el.className = "oni-event-option oni-offer-preset";
    el.dataset.presetId = preset.id;
    el.innerHTML = `
      <div class="oni-event-inline-row">
        <input type="text" class="oni-offer-preset-label oni-grow" value="${kit.escapeHTML(preset.label)}" placeholder="Verdict button, e.g. Unsealed" />
        <button type="button" class="oni-offer-preset-remove" title="Remove this verdict"><i class="fas fa-trash"></i></button>
      </div>`;
    el.appendChild(kit.subList(`preset:${preset.id}`, "", preset.rows));
    el.querySelector(".oni-offer-preset-remove").addEventListener("click", () => {
      const host = el.parentElement;
      if (host && host.children.length <= 1) return;
      el.remove();
      onChange(host);
    });
    return el;
  }

  EventRegistry.register({
    type: "offerItem",
    label: "Offer Item",
    category: "Dialogue",
    defaultData: {
      type: "offerItem",
      count: 3,
      mode: "free",
      names: "",
      itemType: "key",
      judge: "gm",
      title: "",
      ask: "",
      gmNote: "",
      presets: [{ label: "Accept", rows: [] }, { label: "Refuse", rows: [] }],
      acceptedRows: [],
      refusedRows: [],
      withdrawnRows: []
    },
    prepare,
    childLists: (row) => [
      ...(row.judge === "auto"
        ? [{ label: "Accepted", rows: row.acceptedRows }, { label: "Refused", rows: row.refusedRows }]
        : (row.presets ?? []).map(p => ({ label: p.label, rows: p.rows }))),
      { label: "Withdrawn", rows: row.withdrawnRows }
    ],
    summary: (row) => `${row?.count ?? 3} item(s), ${row?.mode === "specific" ? "specific" : row?.mode === "type" ? "one type" : "free choice"}, ${row?.judge === "auto" ? "automatic" : "GM prompt"}`,
    execute,
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field("Items to ask for", kit.numberInput("oni-offer-count", row.count, { min: MIN_COUNT, max: MAX_COUNT, step: 1 }),
          "How many slots the box has. The offering can only be made with every slot filled."),
        kit.field("What can be offered",
          `<div class="oni-event-inline-row">
             <select class="oni-offer-mode">${kit.options([["free", "Free choice (anything)"], ["specific", "Specific items"], ["type", "Only one item type"]], row.mode)}</select>
             <input type="text" class="oni-offer-names oni-grow" value="${kit.escapeHTML(row.names)}" placeholder="Item names, comma separated (any order)" />
             <select class="oni-offer-type">${kit.options(Object.entries(Logic.ITEM_TYPES), row.itemType)}</select>
           </div>`,
          "Specific: the offering must be exactly these names (players don't see the list). One type: only that type can be dragged in."),
        kit.field("Who judges",
          `<select class="oni-offer-judge">${kit.options([["gm", "GM Prompt (the main GM picks a verdict)"], ["auto", "Automatic (check the rule above)"]], row.judge)}</select>`,
          "The items are never taken here. Use Change Items with 'the offered items' to consume them."),
        kit.field("Box title", `<input type="text" class="oni-offer-title" value="${kit.escapeHTML(row.title)}" placeholder="Offering" />`),
        kit.field("Ask line", `<input type="text" class="oni-offer-ask" value="${kit.escapeHTML(row.ask)}" placeholder="Offer 3 items." />`, "{var:name} prints a variable."),
        kit.field("GM note", `<textarea class="oni-offer-note" rows="2" placeholder="Shown to the GMs with the offering">${kit.escapeHTML(row.gmNote)}</textarea>`),
        kit.field("Verdicts",
          `<div class="oni-offer-presets oni-event-row-body"></div>
           <div class="oni-event-list-actions"><button type="button" class="oni-offer-preset-add"><i class="fas fa-plus"></i> Add verdict</button></div>`,
          `GM Prompt: one button per verdict for the main GM; the events under it run when it is picked.
           "Hand back, let them try again" is always there too.`)
      );

      const presetHost = body.querySelector(".oni-offer-presets");
      const addBtn = body.querySelector(".oni-offer-preset-add");
      const onChange = (el) => {
        addBtn.disabled = presetHost.children.length >= MAX_PRESETS;
        kit.notify(el ?? presetHost);
      };
      for (const preset of row.presets ?? []) presetHost.appendChild(buildPresetElement(preset, kit, onChange));
      addBtn.disabled = presetHost.children.length >= MAX_PRESETS;
      addBtn.addEventListener("click", () => {
        if (presetHost.children.length >= MAX_PRESETS) return;
        presetHost.appendChild(buildPresetElement({ id: Logic.makeId(), label: "", rows: [] }, kit, onChange));
        onChange(presetHost);
      });

      const accepted = kit.subList("accepted", "Accepted", row.acceptedRows);
      const refused = kit.subList("refused", "Refused", row.refusedRows);
      body.append(accepted, refused, kit.subList("withdrawn", "Withdrawn (the items were taken back)", row.withdrawnRows));

      const modeEl = body.querySelector(".oni-offer-mode");
      const judgeEl = body.querySelector(".oni-offer-judge");
      const verdictField = presetHost.closest(".oni-event-inline-grid");
      const noteField = body.querySelector(".oni-offer-note").closest(".oni-event-inline-grid");
      const sync = () => {
        body.querySelector(".oni-offer-names").hidden = modeEl.value !== "specific";
        body.querySelector(".oni-offer-type").hidden = modeEl.value !== "type";
        const gm = judgeEl.value === "gm";
        if (verdictField) verdictField.hidden = !gm;
        if (noteField) noteField.hidden = !gm;
        accepted.hidden = gm;
        refused.hidden = gm;
      };
      modeEl.addEventListener("change", sync);
      judgeEl.addEventListener("change", sync);
      sync();
      return body;
    },
    collectFields: (rowEl, kit) => ({
      count: Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(kit.readNumber(rowEl, ".oni-offer-count", 3)))),
      mode: kit.readText(rowEl, ".oni-offer-mode", "free"),
      names: kit.readText(rowEl, ".oni-offer-names", "").trim(),
      itemType: kit.readText(rowEl, ".oni-offer-type", "key"),
      judge: kit.readText(rowEl, ".oni-offer-judge", "gm"),
      title: kit.readText(rowEl, ".oni-offer-title", "").trim(),
      ask: kit.readText(rowEl, ".oni-offer-ask", "").trim(),
      gmNote: kit.readText(rowEl, ".oni-offer-note", ""),
      presets: kit.ownAll(rowEl, ".oni-offer-preset").map((el) => {
        const id = String(el.dataset.presetId || Logic.makeId());
        return {
          id,
          label: String(el.querySelector(":scope > .oni-event-inline-row .oni-offer-preset-label")?.value ?? "").trim(),
          rows: kit.readSubList(rowEl, `preset:${id}`)
        };
      }),
      // Kept while hidden, so switching the judge back loses nothing.
      acceptedRows: kit.readSubList(rowEl, "accepted"),
      refusedRows: kit.readSubList(rowEl, "refused"),
      withdrawnRows: kit.readSubList(rowEl, "withdrawn")
    })
  });

  window.oni.EventSystem.RowsOffer = {
    installed: true,
    // For Change Items: the item ids of this event's last offering.
    lastOfferedIds: (sourceId) => (lastOffered.get(String(sourceId || "")) ?? []).slice(),
    // For tests and the console.
    cleanSlots,
    bagForBox,
    pending
  };

  console.debug(INSTALL_TAG, "Installed.");
})();
