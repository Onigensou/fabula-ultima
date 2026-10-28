// scripts/orbment/upgrade-window.js
//
// The Upgrade window (Tinkerer heroic skill) and its 🔧 camp button.
//   • The button sits beside the camp button while the party can still change
//     tonight's plan (camp Free Roam / Sleep lobby), for whoever plays an actor
//     holding Upgrade (a GM stands in when that player is offline).
//   • The window: whose gear (any party member) → item → socket → a rulebook
//     Quality ≤ 1000 z at double price → "Queue for tonight". Queued shows the
//     plan locked in with "Cancel · refund". Installed at dawn (orbment-upgrade).

import { readOrbment, itemKindOf } from "./orbment-const.js";
import { upgradeAugments, resolveAugment, topValue, paramPickCount } from "./augment-registry.js";
import { rarityKey } from "./orbment-roll-tables.js";
import { injectAttuneStyles } from "./alchemist-window.js";
import { hasUpgradeHeroic, queuedUpgrade, upgradeOpen, planUpgrade, upgradeFailText, requestUpgrade } from "./orbment-upgrade.js";

const TAG = "[Orbment][UpgradeUI]";
const MOD = "fabula-ultima-companion";
const WIN_ID = "fu-upgrade-window";
const BTN_ID = "fu-upgrade-campbtn";
const STYLE_ID = "fu-upgrade-style";
const ASSET = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const ORB_IMG = { offensive: `${ASSET}Item%20Icon/rorb.png`, defensive: `${ASSET}Item%20Icon/borb.png`, enhancement: `${ASSET}Item%20Icon/yorb.png` };
const PIP = { offensive: "#b8432c", defensive: "#3d5fb0", enhancement: "#d39a1e" };
const GROUPS = [["offensive", "Offensive", "#a3321c"], ["defensive", "Defensive", "#2f6fa8"], ["enhancement", "Enhancement", "#9a6a10"]];
const RARITY_COLOR = { common: "#1b1b1b", uncommon: "#1f6fb2", rare: "#b8860b", legendary: "#a3321c" };
const ZICON = `<img class="fu-up-z" src="${ASSET}Item%20Icon/GP.png" alt="Zenit">`;
const WRENCH_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffd27a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg>`;
const CHECK_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2f7a2a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
const SFX = {
  open:   [`${ASSET}Sound/Shop_Open.wav`, 0.6],
  select: [`${ASSET}Sound/BattleCursor_4.wav`, 0.45],
  queue:  [`${ASSET}Sound/BattleCursor_1.wav`, 0.6],
  back:   [`${ASSET}Sound/cursor_back2.wav`, 0.5],
};
const KINDS = ["weapon", "armor", "shield"];

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const zen = (n) => Number(n ?? 0).toLocaleString();
const readZenit = (actor) => Math.max(0, Number(actor?.system?.props?.zenit ?? 0) || 0);
function sfx(key) {
  const [src, volume] = SFX[key] ?? [];
  if (!src) return;
  try { (foundry.audio?.AudioHelper ?? AudioHelper).play({ src, volume, autoplay: true, loop: false }, false); } catch {}
}
const isCampScene = () => canvas?.scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode === "camp";
const partyEntries = async () => (await globalThis.CampSystem?.Party?.resolve?.().catch(() => [])) ?? [];
// A row's label at full value: "Hunter +5", "Resistance", "Initiative Up +2".
const fullLabel = (a) => { const top = topValue(a); return top == null ? a.label : `${a.label} +${top}${a.unit ?? ""}`; };

// The Upgrade holder this client acts for: the user's own party actor; a GM
// stands in for a holder whose player is offline (or who has none).
async function myHolder() {
  for (const e of await partyEntries()) {
    if (!hasUpgradeHeroic(e.actor)) continue;
    if (e.userId && e.userId === game.user?.id) return e.actor;
    if (game.user?.isGM && !(e.userId && game.users.get(e.userId)?.active)) return e.actor;
  }
  return null;
}

// ── Window ───────────────────────────────────────────────────────────────────
export class UpgradeWindow {
  static _cur = null;
  static async open(holderOrUuid = null) {
    const holder = typeof holderOrUuid === "string" ? await fromUuid(holderOrUuid).catch(() => null) : (holderOrUuid ?? await myHolder());
    if (!holder || !hasUpgradeHeroic(holder)) { ui.notifications?.warn("No one here has the Upgrade heroic skill."); return null; }
    if (this._cur) { this._cur.close(true); }
    const w = new UpgradeWindow(holder);
    this._cur = w;
    await w.build();
    return w;
  }
  static close() { this._cur?.close(); }

  constructor(holder) {
    this.holder = holder;
    this.party = [];
    this.ownerId = holder.id;
    this.itemId = null;
    this.slot = 0;
    this.qid = null;
    this.picks = [];
    this.busy = false;
  }

  // ── data ──
  owner() { return this.party.find((a) => a.id === this.ownerId) ?? this.holder; }
  gear(actor = this.owner()) {
    const items = actor?.items?.contents ?? [];
    return KINDS.flatMap((k) => items.filter((i) => itemKindOf(i) === k));
  }
  item() { return this.owner()?.items?.get(this.itemId) ?? null; }
  queued() { return queuedUpgrade(game.actors.get(this.holder.id) ?? this.holder); }
  defs() { const it = this.item(); return it ? upgradeAugments(itemKindOf(it)) : []; }
  def() { return this.defs().find((a) => a.id === this.qid) ?? null; }
  param() { return this.picks.length ? this.picks.join("+") : null; }

  selectItem(id) {
    this.itemId = id;
    const it = this.item();
    const slots = it ? readOrbment(it).slots : [];
    this.slot = Math.max(0, slots.findIndex((s) => !s));
    if (!this.defs().some((a) => a.id === this.qid)) { this.qid = this.defs()[0]?.id ?? null; this.picks = []; }
  }

  // A queued plan pins the whole window to it.
  syncToQueue() {
    const q = this.queued();
    if (!q) return false;
    const parts = String(q.itemUuid ?? "").split(".");
    const ownerId = parts[1], itemId = parts[3];
    if (this.party.some((a) => a.id === ownerId)) this.ownerId = ownerId;
    this.itemId = itemId;
    this.slot = Number(q.slot) || 0;
    this.qid = q.id;
    this.picks = q.param ? String(q.param).split("+") : [];
    return true;
  }

  async build() {
    injectAttuneStyles();
    injectUpgradeStyles();
    this.party = (await partyEntries()).map((e) => e.actor);
    if (!this.party.some((a) => a.id === this.holder.id)) this.party.unshift(this.holder);
    if (!this.syncToQueue()) this.selectItem(this.gear()[0]?.id ?? null);

    const el = document.createElement("div");
    el.id = WIN_ID;
    el.innerHTML = `
      <div class="fu-up-titlebar">
        <img class="fu-up-tb-sprite" src="${esc(this.sprite())}" alt="">
        <div class="fu-up-tb-text"><span class="fu-up-title">Upgrade</span>
          <span class="fu-up-sub">${esc(this.holder.name)} · Tinkerer heroic skill · once per rest · ready when the party wakes</span></div>
        <span class="fu-up-zenit"></span>
        <button type="button" class="fu-up-close" aria-label="Close">×</button>
      </div>
      <div class="fu-up-body"><div class="fu-up-left"></div><div class="fu-up-center"></div><div class="fu-up-right"></div></div>`;
    document.body.appendChild(el);
    this.el = el;
    el.querySelector(".fu-up-close").addEventListener("click", () => { sfx("back"); this.close(); });
    this._onDoc = (doc) => {
      const actor = doc?.documentName === "Item" ? doc.parent : doc;
      if (!this.busy && (actor?.id === this.holder.id || actor?.id === this.ownerId)) this.render();
    };
    Hooks.on("updateActor", this._onDoc);
    Hooks.on("updateItem", this._onDoc);
    this.render();
    requestAnimationFrame(() => el.classList.add("is-open"));
    sfx("open");
  }

  sprite() { return this.holder?.prototypeToken?.texture?.src ?? this.holder?.img ?? "icons/svg/mystery-man.svg"; }

  render() {
    if (!this.el) return;
    this.holder = game.actors.get(this.holder.id) ?? this.holder;
    this.party = this.party.map((a) => game.actors.get(a.id) ?? a);
    if (this.queued()) this.syncToQueue();
    this.el.querySelector(".fu-up-zenit").innerHTML = `${ZICON}<span>${zen(readZenit(this.holder))}</span>`;
    this.renderLeft(this.el.querySelector(".fu-up-left"));
    this.renderCenter(this.el.querySelector(".fu-up-center"));
    this.renderRight(this.el.querySelector(".fu-up-right"));
  }

  renderLeft(root) {
    const lock = !!this.queued();
    const chips = this.party.map((a) => `<button type="button" class="fu-up-chip${a.id === this.ownerId ? " is-on" : ""}" data-owner="${a.id}" ${lock ? "disabled" : ""}>${esc(a.name)}</button>`).join("");
    const gear = this.gear();
    const tiles = gear.map((it) => {
      const pips = readOrbment(it).slots.map((s) => {
        const cat = s ? resolveAugment(s.id, s.param, s.value)?.category : null;
        return `<span class="fu-aw-pip" style="${cat ? `background:${PIP[cat] ?? "#888"}` : "background:#2b1d10;box-shadow:inset 0 0 0 1px #b5a07a"}"></span>`;
      }).join("");
      return `<button type="button" class="fu-aw-tile${it.id === this.itemId ? " is-on" : ""}" data-item="${it.id}" ${lock && it.id !== this.itemId ? "disabled" : ""}
        data-tooltip="${esc(it.name)}" aria-label="${esc(it.name)}"><img src="${esc(it.img)}" alt=""><span class="fu-aw-pips">${pips}</span></button>`;
    }).join("") || `<div class="fu-aw-empty">${esc(this.owner()?.name ?? "")} has no weapon, armor or shield.</div>`;
    root.innerHTML = `
      <span class="fu-aw-label">Whose gear</span>
      <div class="fu-up-chips">${chips}</div>
      <div class="fu-aw-grid fu-up-grid">${tiles}</div>`;
    if (lock) return;
    root.querySelectorAll(".fu-up-chip").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.owner === this.ownerId) return;
      this.ownerId = b.dataset.owner;
      this.selectItem(this.gear()[0]?.id ?? null);
      sfx("select"); this.render();
    }));
    root.querySelectorAll(".fu-aw-tile").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.item === this.itemId) return;
      this.selectItem(b.dataset.item);
      sfx("select"); this.render();
    }));
  }

  renderCenter(root) {
    const it = this.item();
    if (!it) { root.innerHTML = `<div class="fu-aw-hint fu-up-pad">Choose a piece of gear.</div>`; return; }
    const q = this.queued();
    const lock = !!q;
    const orb = readOrbment(it);
    const rk = rarityKey(it.system?.props?.item_rarity);
    const socks = orb.slots.map((s, i) => {
      const v = s ? resolveAugment(s.id, s.param, s.value) : null;
      const on = i === this.slot;
      return `<div class="fu-aw-sock-wrap">
        <button type="button" class="fu-aw-sock${on ? " is-sel" : ""}" data-i="${i}" ${lock ? "disabled" : ""}
          data-tooltip="${esc(v ? `${v.label}: ${v.summary}` : "Empty slot")}" aria-label="Slot ${i + 1}: ${esc(v?.label ?? "empty")}">
          ${v ? `<img class="fu-aw-orb" src="${ORB_IMG[v.category] ?? ORB_IMG.enhancement}" alt="">` : ""}
        </button>
        <span class="fu-aw-cap${on ? " is-sel" : ""}">Slot ${i + 1}</span>
      </div>`;
    }).join("");

    const def = this.def();
    const was = orb.slots[this.slot] ? resolveAugment(orb.slots[this.slot].id, orb.slots[this.slot].param, orb.slots[this.slot].value) : null;
    const full = def && (!def.param || this.picks.length === paramPickCount(def)) ? resolveAugment(def.id, this.param(), null) : null;
    const plan = def ? `
      <div class="fu-up-plan">
        <span class="fu-aw-label">Tonight's upgrade</span>
        <div class="fu-up-plan-line">
          <span class="fu-up-old${was ? " is-strike" : ""}">${esc(was?.label ?? "Empty slot")}</span><span class="fu-up-arrow" aria-hidden="true">→</span>
          <img src="${ORB_IMG[def.category] ?? ORB_IMG.enhancement}" alt=""><b>${esc(full?.label ?? fullLabel(def))}</b>
        </div>
        <span class="fu-up-plan-text">${esc(full?.summary ?? def.param?.prompt ?? "")}</span>
        <span class="fu-up-plan-note">Always the full value. No roll.</span>
      </div>` : "";
    const queuedBox = q ? `
      <div class="fu-up-queued">${CHECK_SVG}
        <span><b>Queued.</b> ${esc(this.holder.name)} works on it through the night. It's installed when the party wakes, and everyone sees it.</span>
        <button type="button" class="fu-up-cancel" ${this.busy ? "disabled" : ""}>Cancel · refund</button>
      </div>` : "";

    root.innerHTML = `
      <div class="fu-aw-item-name" style="color:${RARITY_COLOR[rk]}">${esc(it.name)}</div>
      <div class="fu-aw-item-sub">${esc(rk[0].toUpperCase() + rk.slice(1))} · ${esc(itemKindOf(it))}</div>
      <div class="fu-aw-item-icon"><img src="${esc(it.img)}" alt=""></div>
      <div class="fu-aw-socks">${socks}</div>
      ${plan}${queuedBox}`;
    root.querySelector(".fu-up-cancel")?.addEventListener("click", () => this.cancel());
    if (lock) return;
    root.querySelectorAll(".fu-aw-sock").forEach((b) => b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      if (i === this.slot) return;
      this.slot = i; sfx("select"); this.render();
    }));
  }

  renderRight(root) {
    const it = this.item();
    const q = this.queued();
    const lock = !!q || this.busy;
    const defs = this.defs();
    const groups = GROUPS.map(([cat, label, color]) => {
      const rows = defs.filter((a) => a.category === cat).map((a) => `
        <button type="button" class="fu-up-q${a.id === this.qid ? " is-on" : ""}" data-q="${a.id}" ${q ? "disabled" : ""} data-tooltip="${esc(a.summary ?? "")}">
          <img src="${ORB_IMG[cat]}" alt=""><span>${esc(fullLabel(a))}</span><span class="fu-up-cost">${ZICON}${zen(2 * Number(a.cost))}</span>
        </button>`).join("");
      return rows ? `<div class="fu-up-group"><span class="fu-up-group-name" style="color:${color}">${label}</span>${rows}</div>` : "";
    }).join("");

    const def = this.def();
    let opts = "";
    if (def?.param) {
      const need = paramPickCount(def);
      opts = `<div class="fu-up-opts"><span class="fu-up-prompt">${esc(def.param.prompt ?? "Choose")}</span><div class="fu-up-optrow">${def.param.options.map((o) =>
        `<button type="button" class="fu-up-opt${this.picks.includes(o.value) ? " is-on" : ""}" data-v="${esc(o.value)}" ${q ? "disabled" : ""}>${esc(o.label ?? o.value)}</button>`).join("")}</div>
        ${need > 1 ? `<span class="fu-up-hint">${this.picks.length}/${need} chosen</span>` : ""}</div>`;
    }

    // Button state: a full plan, no clash, enough Zenit.
    const plan = it && def ? planUpgrade({ item: it, slot: this.slot, id: def.id, param: this.param() }) : null;
    const cost = def ? 2 * Number(def.cost) : 0;
    const have = readZenit(this.holder);
    let note = "";
    if (plan && !plan.ok && plan.reason !== "needs_choice") note = upgradeFailText(plan);
    else if (plan?.ok && have < cost) note = upgradeFailText({ reason: "not_enough_zenit", cost, have });
    const ready = !!plan?.ok && have >= cost && !lock;
    const label = q ? "Queued for tonight" : `Queue for tonight · ${zen(cost)} z`;

    root.innerHTML = `
      <span class="fu-aw-label">Qualities up to 1,000 z · you pay double</span>
      <div class="fu-up-list">${groups || `<div class="fu-aw-empty">Choose a piece of gear.</div>`}</div>
      ${opts}
      ${note ? `<div class="fu-aw-warn">${esc(note)}</div>` : ""}
      <button type="button" class="fu-aw-attune fu-up-go" ${ready ? "" : "disabled"}>${esc(label)}</button>`;

    if (q) return;
    root.querySelectorAll(".fu-up-q").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.q === this.qid) return;
      this.qid = b.dataset.q; this.picks = [];
      sfx("select"); this.render();
    }));
    root.querySelectorAll(".fu-up-opt").forEach((b) => b.addEventListener("click", () => {
      const v = b.dataset.v;
      const need = paramPickCount(this.def());
      if (this.picks.includes(v)) this.picks = this.picks.filter((x) => x !== v);
      else if (need === 1) this.picks = [v];
      else this.picks = [...this.picks, v].slice(-need);
      sfx("select"); this.render();
    }));
    root.querySelector(".fu-up-go")?.addEventListener("click", () => this.queue());
  }

  async queue() {
    const it = this.item();
    const def = this.def();
    if (this.busy || !it || !def) return;
    this.busy = true; this.render();
    const r = await requestUpgrade("queue", { holderUuid: this.holder.uuid, itemUuid: it.uuid, slot: this.slot, id: def.id, param: this.param() });
    this.busy = false;
    if (r?.ok) sfx("queue");
    else ui.notifications?.warn(upgradeFailText(r));
    this.render();
  }

  async cancel() {
    if (this.busy || !this.queued()) return;
    this.busy = true; this.render();
    const r = await requestUpgrade("cancel", { holderUuid: this.holder.uuid });
    this.busy = false;
    if (r?.ok) sfx("back");
    else ui.notifications?.warn(upgradeFailText(r));
    this.render();
  }

  close(instant = false) {
    if (this._onDoc) { Hooks.off("updateActor", this._onDoc); Hooks.off("updateItem", this._onDoc); this._onDoc = null; }
    const el = this.el;
    this.el = null;
    if (UpgradeWindow._cur === this) UpgradeWindow._cur = null;
    if (!el) return;
    if (instant) { el.remove(); return; }
    el.classList.remove("is-open");
    setTimeout(() => el.remove(), 260);
  }
}

// ── The 🔧 camp button ──────────────────────────────────────────────────────
let _btnHolder = null;
async function refreshButton() {
  const holder = isCampScene() && upgradeOpen() ? await myHolder() : null;
  _btnHolder = holder;
  let btn = document.getElementById(BTN_ID);
  if (!holder) {
    btn?.classList.remove("is-shown");
    if (!upgradeOpen()) UpgradeWindow.close();
    return;
  }
  injectUpgradeStyles();
  if (!btn) {
    btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.innerHTML = `${WRENCH_SVG}<span class="fu-up-btn-label">Upgrade</span><span class="fu-up-btn-badge" aria-hidden="true">✓</span>`;
    btn.addEventListener("click", () => {
      if (UpgradeWindow._cur) { sfx("back"); UpgradeWindow.close(); }
      else UpgradeWindow.open(_btnHolder);
    });
    document.body.appendChild(btn);
  }
  const q = queuedUpgrade(holder);
  btn.classList.toggle("is-queued", !!q);
  btn.dataset.tooltip = q ? `Upgrade queued for tonight (${holder.name})` : `Upgrade — ${holder.name}'s heroic skill`;
  btn.setAttribute("aria-label", btn.dataset.tooltip);
  requestAnimationFrame(() => btn.classList.add("is-shown"));
}

let _btnInstalled = false;
export function initUpgradeButton() {
  if (_btnInstalled) return;
  _btnInstalled = true;
  const refresh = foundry.utils.debounce(() => refreshButton().catch((e) => console.warn(TAG, "refresh", e)), 150);
  Hooks.on("updateSetting", (s) => { if (String(s?.key ?? "").startsWith(`${MOD}.`)) refresh(); });
  Hooks.on("canvasReady", refresh);
  // The queued badge follows the holder's flag; skip the party resolve off camp.
  Hooks.on("updateActor", (actor, diff) => { if (isCampScene() && diff?.flags?.[MOD]) refresh(); });
  refresh();
}

function injectUpgradeStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${WIN_ID} { position: fixed; top: 50%; left: 50%; transform: translate(-50%, calc(-50% + 18px)); opacity: 0;
  transition: opacity .28s cubic-bezier(.2,.9,.2,1), transform .28s cubic-bezier(.2,.9,.2,1);
  width: min(1080px, 96vw); height: min(720px, 92vh); z-index: 9999; display: flex; flex-direction: column; overflow: hidden;
  border-radius: 16px; border: 2px solid #c9a44a; box-shadow: 0 0 0 2px #7a4e20, 0 0 0 4px #b8865a, 0 22px 64px rgba(0,0,0,.55);
  background: linear-gradient(180deg, #efe3c6, #e4d3ac); color: #3a1e06; font-family: inherit; }
#${WIN_ID}.is-open { opacity: 1; transform: translate(-50%, -50%); }
#${WIN_ID} img { border: none !important; box-shadow: none; background: transparent; }
.fu-up-titlebar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; background: linear-gradient(180deg, #7a4e20, #5c3818); color: #fff6dd; flex-shrink: 0; }
.fu-up-tb-sprite { width: 34px; height: 42px; object-fit: contain; image-rendering: pixelated; }
.fu-up-tb-text { display: flex; flex-direction: column; line-height: 1.15; flex: 1; }
.fu-up-title { font-size: 18px; font-weight: 700; }
.fu-up-sub { font-size: 12px; color: #e9d3a6; }
.fu-up-zenit { display: flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; background: rgba(0,0,0,.25); font-weight: 700; font-variant-numeric: tabular-nums; }
.fu-up-zenit .fu-up-z { width: 20px; height: 20px; }
.fu-up-z { width: 14px; height: 14px; object-fit: contain; vertical-align: middle; }
.fu-up-close { font: inherit; width: 36px; height: 36px; border-radius: 8px; border: 1px solid rgba(255,246,221,.4); background: transparent; color: #fff6dd; cursor: pointer; font-size: 18px; line-height: 1; }
.fu-up-close:hover { background: rgba(160,48,32,.75); }
.fu-up-body { flex: 1; display: grid; grid-template-columns: 250px minmax(0,1fr) 360px; min-height: 0; }
.fu-up-left { display: flex; flex-direction: column; gap: 10px; padding: 14px 12px 14px 16px; border-right: 1px solid rgba(122,78,32,.25); min-height: 0; overflow-y: auto; }
.fu-up-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.fu-up-chip { font: inherit; font-size: 13px; font-weight: 600; padding: 6px 12px; min-height: 36px; border-radius: 999px; border: 1px solid #b8865a; background: #faf6ee; color: #3a1e06; cursor: pointer; }
.fu-up-chip.is-on { background: #7a4e20; color: #fff6dd; border-color: #5c3818; }
.fu-up-chip:disabled:not(.is-on) { opacity: .5; cursor: not-allowed; }
.fu-up-grid { border-radius: 10px; max-height: none; }
.fu-up-grid .fu-aw-tile:disabled { cursor: not-allowed; opacity: .5; }
.fu-up-center { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 18px 22px; min-height: 0; overflow-y: auto; }
.fu-up-center .fu-aw-sock { width: 72px; height: 72px; }
.fu-up-center .fu-aw-orb { width: 52px; height: 52px; }
.fu-up-center .fu-aw-sock:disabled { cursor: default; }
.fu-up-center .fu-aw-sock:disabled:hover { transform: none; }
.fu-up-pad { padding-top: 40px; }
.fu-up-plan { width: 100%; box-sizing: border-box; border-radius: 12px; border: 1px solid rgba(122,78,32,.3); background: rgba(255,255,255,.6); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.fu-up-plan-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.fu-up-plan-line img { width: 28px; height: 28px; image-rendering: pixelated; }
.fu-up-plan-line b { font-size: 18px; }
.fu-up-old { font-size: 14px; color: #6b4a26; }
.fu-up-old.is-strike { text-decoration: line-through; }
.fu-up-arrow { color: #7a4e20; }
.fu-up-plan-text { font-size: 13.5px; line-height: 1.4; }
.fu-up-plan-note { font-size: 12px; color: #6b4a26; }
.fu-up-queued { width: 100%; box-sizing: border-box; border-radius: 12px; border: 2px solid #2f7a2a; background: #f0f7e6; padding: 12px 14px; display: flex; align-items: center; gap: 12px; }
.fu-up-queued > span { flex: 1; font-size: 14px; line-height: 1.35; }
.fu-up-cancel { font: inherit; font-size: 13px; min-height: 40px; padding: 0 14px; border-radius: 10px; border: 1px solid #a3321c; background: transparent; color: #7d2412; cursor: pointer; white-space: nowrap; }
.fu-up-cancel:hover:not(:disabled) { background: rgba(163,50,28,.08); }
.fu-up-cancel:disabled { opacity: .5; cursor: wait; }
.fu-up-right { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px 16px; border-left: 1px solid rgba(122,78,32,.25); min-height: 0; }
.fu-up-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }
.fu-up-group { display: flex; flex-direction: column; gap: 4px; }
.fu-up-group-name { font-size: 11.5px; font-weight: 700; }
.fu-up-q { font: inherit; text-align: left; display: grid; grid-template-columns: 20px minmax(0,1fr) auto; gap: 8px; align-items: center; padding: 6px 9px; min-height: 36px;
  border-radius: 8px; border: 1px solid transparent; background: rgba(255,255,255,.45); cursor: pointer; color: #3a1e06; width: 100%; }
.fu-up-q img { width: 18px; height: 18px; image-rendering: pixelated; }
.fu-up-q span:nth-child(2) { font-size: 13px; font-weight: 600; }
.fu-up-q:hover:not(:disabled) { border-color: #c9a44a; }
.fu-up-q.is-on { border-color: #7a4e20; background: #fff8e4; box-shadow: 0 0 0 1px #7a4e20; }
.fu-up-q:disabled:not(.is-on) { opacity: .55; cursor: not-allowed; }
.fu-up-cost { display: flex; align-items: center; gap: 3px; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.fu-up-opts { display: flex; flex-direction: column; gap: 5px; border-top: 1px solid rgba(122,78,32,.25); padding-top: 8px; }
.fu-up-prompt { font-size: 12px; font-weight: 600; color: #6b4a26; }
.fu-up-optrow { display: flex; flex-wrap: wrap; gap: 5px; }
.fu-up-opt { font: inherit; font-size: 12.5px; padding: 4px 10px; min-height: 32px; border-radius: 999px; border: 1px solid #b8865a; background: #faf6ee; color: #3a1e06; cursor: pointer; }
.fu-up-opt.is-on { background: #2f6fa8; color: #fff; border-color: #1f4f7a; }
.fu-up-opt:disabled:not(.is-on) { opacity: .5; cursor: not-allowed; }
.fu-up-hint { font-size: 11.5px; color: #6b4a26; }
/* The 🔧 button beside the camp button (camp-ui-button.js: left 20, bottom 80, 64px). */
#${BTN_ID} { position: fixed; z-index: 99998; left: 98px; bottom: 80px; width: 64px; height: 64px; border-radius: 50%;
  border: 2px solid rgba(200,160,80,0.65); background: radial-gradient(circle at 40% 35%, rgba(92,56,24,0.94) 0%, rgba(43,29,16,0.97) 100%);
  box-shadow: 0 0 14px rgba(255,190,90,.45), 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 0; cursor: pointer;
  opacity: 0; transform: scale(.6) translateY(10px); pointer-events: none;
  transition: opacity 250ms cubic-bezier(.4,0,.2,1), transform 250ms cubic-bezier(.4,0,.2,1), filter 180ms ease; }
#${BTN_ID}.is-shown { opacity: 1; transform: none; pointer-events: auto; }
#${BTN_ID}:hover { filter: brightness(1.18); }
.fu-up-btn-label { font-size: 8.5px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: #e8c870; opacity: .8; font-family: "Signika","Noto Sans",system-ui,sans-serif; }
.fu-up-btn-badge { position: absolute; top: -3px; right: -3px; width: 20px; height: 20px; border-radius: 50%; background: #2f7a2a; color: #fff; font-size: 12px; font-weight: 700;
  display: none; place-items: center; box-shadow: 0 0 0 2px #1b120a; }
#${BTN_ID}.is-queued .fu-up-btn-badge { display: grid; }
@media (prefers-reduced-motion: reduce) { #${WIN_ID}, #${BTN_ID} { transition: none !important; } }
`;
  document.head.appendChild(s);
}
