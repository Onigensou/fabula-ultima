// scripts/inner-wellspring/wellspring-window.js
//
// The Inner Wellspring picker and its camp button. Design approved 2026-11-01
// (mockup: tools/inner-wellspring-mockup/, local only).
//   • Stage: the holder's sprite in the middle, the five element buttons on a
//     perfect pentagon over a rune circle. The chosen button gets its element's
//     pixel effect (wellspring-aura.js, pixelfx), one layer behind the button and
//     one in front, 2 screen px per effect px, 30 fps.
//   • Right column: what the wellspring gives, and the Invocations it unlocks
//     (read from the holder's own Invocation skill, with SL locks).
//   • Camp mode: the button sits beside the camp button in Free Roam / Sleep
//     lobby; picks are queued for tonight (applied at rest).
//   • First-pick mode: opens on its own once the skill is held and nothing has
//     been chosen; it can't be closed until a pick, and the pick applies at once.
// The pixel effects ignore prefers-reduced-motion ON PURPOSE (user, 2026-11-01:
// the user's PC has OS animations off and wants to see the effects here).

import { createFrame, clearFrame, painterFor, composite } from "../battle-director/pixel-entrance/pixelfx/core/fx.js";
import { create as createAura, meta as AURA } from "./wellspring-aura.js";
import { spriteSrc, spriteHTML } from "../orbment/alchemist-window.js";
import { interpolateMenuText } from "../battle-director/skill-effects.js";
import { buildSkillResolver, evaluateFormula } from "../battle-director/skill-formulas.js";
import {
  IW_ELEMENTS, elementOf, hasInnerWellspring, iwState, needsFirstPick, iwCampOpen, iwFailText, requestIw,
} from "./inner-wellspring.js";

const TAG = "[InnerWellspring][UI]";
const MOD = "fabula-ultima-companion";
const WIN_ID = "fu-iw-window";
const BTN_ID = "fu-iw-campbtn";
const STYLE_ID = "fu-iw-style";
const UPGRADE_BTN_ID = "fu-upgrade-campbtn";
const ASSET = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const SFX = {
  open:   [`${ASSET}Sound/Shop_Open.wav`, 0.6],
  select: [`${ASSET}Sound/BattleCursor_4.wav`, 0.45],
  queue:  [`${ASSET}Sound/BattleCursor_1.wav`, 0.6],
  back:   [`${ASSET}Sound/cursor_back2.wav`, 0.5],
};
const ICON = {
  air:   '<path d="M3 8h10.5a2.75 2.75 0 1 0-2.6-3.6"/><path d="M3 12h15a3 3 0 1 1-2.8 4"/><path d="M3 16h6.5"/>',
  earth: '<path d="M2.5 20 9 8.5l3.6 6.2L15.2 11 21.5 20z"/><path d="M9 8.5 10.7 12"/>',
  fire:  '<path d="M12 2.8c.9 3.4 5.2 5.3 5.2 10.3a5.2 5.2 0 0 1-10.4 0c0-2.6 1.4-4.1 2.5-5.1.2 1.7.9 2.7 2 3.1-.1-3.1-.9-5.6.7-8.3z"/>',
  bolt:  '<path d="M13.2 2.5 4.8 13.6h6.4l-.9 7.9 8.4-11.1h-6.4z"/>',
  ice:   '<path d="M12 2.5v19M3.8 7.25l16.4 9.5M3.8 16.75l16.4-9.5"/><path d="m9.6 4.2 2.4 2.1 2.4-2.1M9.6 19.8l2.4-2.1 2.4 2.1M4.3 10.4l3 .9-.7 3M19.7 13.6l-3-.9.7-3M4.3 13.6l3-.9-.7-3M19.7 10.4l-3 .9.7 3"/>',
};
const SHIELD = '<path d="M12 2.8 4.5 5.6v5.6c0 4.6 3.2 8.3 7.5 10 4.3-1.7 7.5-5.4 7.5-10V5.6z"/>';
const SWAP = '<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>';
const SPRING = '<path d="M12 21c-4 0-7-2.2-7-5 0-2.3 2-4 4.5-4.7M12 21c4 0 7-2.2 7-5 0-2.3-2-4-4.5-4.7"/><path d="M12 15V3M8.5 6.5 12 3l3.5 3.5"/>';
const PENTA_SVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ffd27a" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 21 9l-3.4 10.5H6.4L3 9z"/><path d="M12 2.5 17.6 19.5 3 9h18L6.4 19.5z" opacity=".55"/></svg>`;
const KIND_BY_TIER = { 1: "Blast", 2: "Hex", 3: "Utility" };

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const svg = (inner, cls = "", sw = 1.8) => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
const isCampScene = () => canvas?.scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode === "camp";
const partyEntries = async () => (await globalThis.CampSystem?.Party?.resolve?.().catch(() => [])) ?? [];
function sfx(key) {
  const [src, volume] = SFX[key] ?? [];
  if (!src) return;
  try { (foundry.audio?.AudioHelper ?? AudioHelper).play({ src, volume, autoplay: true, loop: false }, false); } catch {}
}

// The holder this client acts for: the user's own party actor; a GM stands in
// for a holder whose player is offline (or who has none). `primaryOnly` keeps
// two GMs from both answering the same holder (the first-pick auto-open).
async function myHolder({ filter = hasInnerWellspring, primaryOnly = false } = {}) {
  for (const e of await partyEntries()) {
    if (!filter(e.actor)) continue;
    if (e.userId && e.userId === game.user?.id) return e.actor;
    const offline = !(e.userId && game.users.get(e.userId)?.active);
    if (game.user?.isGM && offline && (!primaryOnly || isPrimaryGM())) return e.actor;
  }
  return null;
}

// The Invocations each wellspring unlocks, read from the holder's own Invocation
// skill: its open_action_menu option rows, each gated `SL >= N && WELLSPRING_<X>_AVAILABLE`.
function invocationCards(holder) {
  const skill = holder?.items?.find?.((i) => String(i.name ?? "").trim().toLowerCase() === "invocation");
  const rows = Object.values(skill?.system?.props?.effect_table ?? {});
  if (!skill || !rows.length) return null;
  let sl = 1;
  try { sl = Number(evaluateFormula("SL", buildSkillResolver({ actor: holder, skill }), 1)) || 1; } catch {}
  const menu = rows.find((r) => r?.effect_kind === "open_action_menu");
  const refs = String(menu?.menu_option_refs ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ctx = { reactorActor: holder, skill, payload: {} };
  const byElem = {};
  for (const ref of refs) {
    const row = rows.find((r) => String(r?.effect_label ?? "").trim() === ref);
    const cond = String(row?.condition_formula ?? "");
    const elem = cond.match(/WELLSPRING_([A-Z]+)_AVAILABLE/)?.[1]?.toLowerCase();
    if (!row || !elem) continue;
    const tier = Number(cond.match(/\bSL\s*>=\s*(\d+)/)?.[1] ?? 1);
    let text = "";
    try { text = interpolateMenuText(row.menu_description ?? "", ctx); } catch { text = String(row.menu_description ?? ""); }
    (byElem[elem] ??= []).push({ tier, kind: KIND_BY_TIER[tier] ?? "Invocation", name: String(row.menu_label ?? ref), text });
  }
  return { sl, byElem };
}

// ── Window ───────────────────────────────────────────────────────────────────
export class WellspringWindow {
  static _cur = null;
  static async open(holderOrUuid = null, { mode = null } = {}) {
    const holder = typeof holderOrUuid === "string" ? await fromUuid(holderOrUuid).catch(() => null) : (holderOrUuid ?? await myHolder());
    if (!holder || !hasInnerWellspring(holder)) { ui.notifications?.warn("No one here has the Inner Wellspring heroic skill."); return null; }
    const m = mode ?? (needsFirstPick(holder) ? "first" : "rest");
    if (this._cur) {
      if (this._cur.holder.id === holder.id && this._cur.mode === m) return this._cur;
      if (this._cur.locked()) return this._cur;         // a first pick holds the screen
      this._cur.close(true);
    }
    const w = new WellspringWindow(holder, m);
    this._cur = w;
    w.build();
    return w;
  }
  static close() { if (!this._cur?.locked()) this._cur?.close(); }

  constructor(holder, mode) {
    this.holder = holder;
    this.mode = mode;
    const st = iwState(holder);
    this.sel = mode === "first" ? null : (st.tonight ?? st.current);
    this.done = false;
    this.busy = false;
    this.warn = "";
    this.G = { cx: 0, cy: 0, R: 0, nodes: {} };
  }

  live() { return game.actors.get(this.holder.id) ?? this.holder; }
  state() { return iwState(this.live()); }
  locked() { return this.mode === "first" && !this.done; }

  build() {
    injectStyles();
    const el = document.createElement("div");
    el.id = WIN_ID;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "fu-iw-title");
    el.innerHTML = `
      <div class="iw-tb">
        ${spriteHTML(spriteSrc(this.holder), "iw-tb-sprite")}
        <div class="iw-tb-text"><span class="iw-tb-title" id="fu-iw-title">Inner Wellspring</span><span class="iw-tb-sub"></span></div>
        <span class="iw-tb-chip"></span>
        <button type="button" class="iw-tb-close" aria-label="Close">✕</button>
      </div>
      <div class="iw-body">
        <div class="iw-stage">
          <svg class="iw-rune" aria-hidden="true"></svg>
          <div class="iw-center">${spriteHTML(spriteSrc(this.holder), "iw-sprite", this.holder.name)}</div>
          <canvas class="iw-fxl iw-fx-back" aria-hidden="true" hidden></canvas>
          <canvas class="iw-fxl iw-fx-front" aria-hidden="true" hidden></canvas>
          <div class="iw-stage-hint"></div>
        </div>
        <div class="iw-right">
          <section class="iw-panel iw-gives" aria-live="polite"></section>
          <section class="iw-panel iw-inv"></section>
        </div>
      </div>
      <div class="iw-ft">
        <div class="iw-status" aria-live="polite"></div>
        <button type="button" class="iw-btn iw-secondary iw-keep"></button>
        <button type="button" class="iw-btn iw-secondary iw-close">Close</button>
        <button type="button" class="iw-btn iw-primary iw-go"></button>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.stage = el.querySelector(".iw-stage");

    for (const e of IW_ELEMENTS) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "iw-node"; b.dataset.el = e.id;
      b.style.setProperty("--rgb", e.rgb); b.style.setProperty("--ink-el", e.ink);
      b.setAttribute("aria-label", `${e.label} wellspring`);
      b.innerHTML = `${svg(ICON[e.id], "iw-ico", 1.7)}<span class="iw-nlabel">${e.label}<small>${e.id} damage</small></span><span class="iw-tag" hidden></span>`;
      b.addEventListener("click", () => this.pick(e.id));
      b.addEventListener("keydown", (ev) => {
        const i = IW_ELEMENTS.findIndex((x) => x.id === e.id);
        const to = (k) => { ev.preventDefault(); const id = IW_ELEMENTS[k % 5].id; this.stage.querySelector(`.iw-node[data-el="${id}"]`)?.focus(); this.pick(id); };
        if (ev.key === "ArrowRight" || ev.key === "ArrowDown") to(i + 1);
        if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") to(i + 4);
      });
      this.stage.appendChild(b);
    }

    el.querySelector(".iw-go").addEventListener("click", () => this.go());
    el.querySelector(".iw-keep").addEventListener("click", () => this.keepCurrent());
    el.querySelector(".iw-close").addEventListener("click", () => this.tryClose());
    el.querySelector(".iw-tb-close").addEventListener("click", () => this.tryClose());
    el.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation(); ev.preventDefault();
      this.tryClose();
    });

    this._onActor = (actor) => { if (actor?.id === this.holder.id && !this.busy) this.onExternalChange(); };
    Hooks.on("updateActor", this._onActor);
    this._onEffect = (eff) => { if (eff?.parent?.id === this.holder.id && !this.busy) this.onExternalChange(); };
    Hooks.on("createActiveEffect", this._onEffect);
    Hooks.on("deleteActiveEffect", this._onEffect);
    this._ro = new ResizeObserver(() => this.layout());
    this._ro.observe(this.stage);
    this.initFx();

    this.render();
    this.layout();
    requestAnimationFrame(() => {
      el.classList.add("is-open");
      (this.stage.querySelector(`.iw-node[data-el="${this.sel ?? IW_ELEMENTS[0].id}"]`))?.focus({ preventScroll: true });
    });
    sfx("open");
  }

  // Someone else (the GM standing in, another tab) changed the holder.
  onExternalChange() {
    if (this.mode === "first" && !this.done && this.state().current) { this.done = true; this.sel = this.state().current; }
    this.render();
  }

  pick(id) {
    if (this.busy || this.sel === id) return;
    if (this.mode === "first" && this.done) return;
    this.sel = id; this.warn = "";
    sfx("select");
    this.render();
  }

  // ── layout ──
  layout() {
    if (!this.el) return;
    const r = this.stage.getBoundingClientRect();
    const w = r.width, h = r.height;
    if (!w || !h) return;
    const R = Math.max(110, Math.min(230, Math.min(w * 0.36, (h - 70) * 0.5)));
    const cx = w / 2, cy = h / 2 + R * 0.06 - 8;
    this.G = { w, h, cx, cy, R, nodes: {} };
    IW_ELEMENTS.forEach((e, i) => {
      const a = (-90 + i * 72) * Math.PI / 180;
      const p = this.G.nodes[e.id] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
      const b = this.stage.querySelector(`.iw-node[data-el="${e.id}"]`);
      b.style.left = `${p.x}px`; b.style.top = `${p.y}px`;
    });
    const center = this.el.querySelector(".iw-center");
    center.style.left = `${cx}px`; center.style.top = `${cy}px`;
    const art = center.querySelector(".iw-sprite");
    if (art) art.style.height = `${Math.round(R * 1.18)}px`;
    this.drawRune();
  }

  drawRune() {
    const { cx, cy, R, nodes, w, h } = this.G;
    if (!R) return;
    const rune = this.el.querySelector(".iw-rune");
    rune.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const pts = IW_ELEMENTS.map((e) => nodes[e.id]);
    const poly = pts.map((p) => `${p.x},${p.y}`).join(" ");
    const star = [0, 2, 4, 1, 3].map((i) => `${pts[i].x},${pts[i].y}`).join(" ");
    rune.innerHTML = `
      <circle class="iw-ring" cx="${cx}" cy="${cy}" r="${R}"/>
      <circle class="iw-ring iw-thin" cx="${cx}" cy="${cy}" r="${R * 1.16}"/>
      <circle class="iw-ring iw-thin" cx="${cx}" cy="${cy}" r="${R * 0.66}"/>
      <polygon class="iw-pent" points="${poly}"/>
      <polygon class="iw-star" points="${star}"/>`;
  }

  // ── render ──
  render() {
    if (!this.el) return;
    this.holder = this.live();
    const st = this.state();
    const now = st.current, plan = st.tonight ?? st.current;
    const sel = this.sel ? elementOf(this.sel) : null;
    if (sel) { this.el.style.setProperty("--el-rgb", sel.rgb); this.el.style.setProperty("--ink-el", sel.ink); }

    this.stage.querySelectorAll(".iw-node").forEach((b) => {
      const id = b.dataset.el;
      b.classList.toggle("is-sel", id === this.sel);
      b.setAttribute("aria-pressed", id === this.sel ? "true" : "false");
      b.disabled = this.busy || (this.mode === "first" && this.done);
      const tag = b.querySelector(".iw-tag");
      let t = "";
      if (now === id) t = "now";
      if (plan && plan !== now && plan === id) t = "tonight";
      tag.hidden = !t; tag.className = `iw-tag ${t}`; tag.textContent = t === "now" ? "Active" : "Tonight";
    });

    const name = this.holder.name;
    this.el.querySelector(".iw-tb-sub").textContent = this.mode === "first"
      ? `${name} · new Invoker heroic skill · choose the wellspring you carry within`
      : `${name} · Invoker heroic skill · changes when the party rests`;
    this.el.querySelector(".iw-tb-close").hidden = this.locked();
    const nowEl = now ? elementOf(now) : null;
    this.el.querySelector(".iw-tb-chip").innerHTML = nowEl ? `<i style="background:rgb(${nowEl.rgb})"></i>Active: ${nowEl.label}` : "Nothing chosen yet";
    this.el.querySelector(".iw-stage-hint").textContent = sel ? "" : "Choose one of the five wellsprings.";

    this.renderGives(sel);
    this.renderInv(sel);
    this.renderFooter(sel, now, plan);
  }

  renderGives(sel) {
    const root = this.el.querySelector(".iw-gives");
    if (!sel) { root.innerHTML = `<h3>What it gives</h3><p class="iw-empty">Pick a wellspring on the left to see what it gives you.</p>`; return; }
    const d = `<em class="iw-dmg">${sel.id}</em>`;
    root.innerHTML = `<header><span class="iw-swatch">${svg(ICON[sel.id], "", 2)}</span>
        <div><h3>${sel.label} wellspring</h3><p class="iw-sub">Yours until your next rest, and kept after it unless you change it</p></div></header>
      <ul>
        <li>${svg(SPRING)}<div><b>Always available to you</b><span>${sel.label} counts as an available wellspring in every scene, on top of the scene's own.</span></div></li>
        <li>${svg(SHIELD)}<div><b>Resistance: ${d}</b><span>You take half damage from ${d}.</span></div></li>
        <li>${svg(SWAP)}<div><b>Element override</b><span>When you deal damage, you may change its type to ${d}. That damage ignores Resistances.</span>
          <span class="iw-manual">Offered on your action card whenever you deal damage.</span></div></li>
      </ul>`;
  }

  renderInv(sel) {
    const root = this.el.querySelector(".iw-inv");
    if (!sel) { root.innerHTML = `<header><h3>Invocations you can access</h3></header><p class="iw-empty">Your Invocation options for the chosen wellspring will appear here.</p>`; return; }
    const inv = invocationCards(this.holder);
    if (!inv) { root.innerHTML = `<header><h3>Invocations you can access</h3></header><p class="iw-empty">${esc(this.holder.name)} has no Invocation skill yet.</p>`; return; }
    const cards = (inv.byElem[sel.id] ?? []).map((c) => {
      const locked = inv.sl < c.tier;
      return `<div class="iw-card${locked ? " locked" : ""}"><span class="iw-bar"></span><div>
        <div class="iw-eyebrow">${esc(c.kind)} · SL ${c.tier}</div><div class="iw-nm">${esc(c.name)}</div><div class="iw-ds">${esc(c.text)}</div>
        ${locked ? `<div class="iw-lock">Needs Invocation SL ${c.tier}</div>` : ""}</div></div>`;
    }).join("") || `<p class="iw-empty">No ${sel.label} invocations found on the Invocation skill.</p>`;
    root.innerHTML = `<header><h3>Invocations you can access</h3><p class="iw-sub">From the ${sel.label} wellspring · your Invocation is SL ${inv.sl}</p></header>
      <div class="iw-inv-list">${cards}</div>
      <p class="iw-foot">Works even where the scene has no ${sel.label} wellspring.</p>`;
  }

  renderFooter(sel, now, plan) {
    const st = this.el.querySelector(".iw-status"), go = this.el.querySelector(".iw-go");
    const keep = this.el.querySelector(".iw-keep"), close = this.el.querySelector(".iw-close");
    st.className = "iw-status"; keep.hidden = true; close.hidden = false; go.hidden = false; go.disabled = this.busy;
    if (this.mode === "first") {
      if (this.done) {
        st.innerHTML = `Attuned to <b>${esc(elementOf(now ?? this.sel)?.label ?? "")}</b>. It lasts until your next rest and carries over unless you change it at camp.`;
        go.hidden = true;
      } else {
        close.hidden = true;
        go.disabled = !sel || this.busy;
        go.textContent = sel ? `Attune to ${sel.label}` : "Choose a wellspring";
        st.innerHTML = this.warn || (sel ? "Takes effect now." : "You need to choose before you continue.");
        if (this.warn) st.className = "iw-status warn";
      }
      return;
    }
    const nowL = elementOf(now)?.label ?? "", planL = elementOf(plan)?.label ?? "";
    if (!sel || this.sel === plan) {
      go.hidden = true;
      if (plan === now) st.innerHTML = `Tonight: <b>${esc(nowL)}</b>, kept from last night.`;
      else {
        st.innerHTML = `Tonight: <b>${esc(planL)}</b>. ${esc(nowL)} stays active until the party rests.`;
        keep.hidden = false; keep.disabled = this.busy; keep.textContent = `Keep ${nowL} instead`;
      }
    } else {
      go.textContent = this.sel === now ? `Keep ${nowL}` : `Attune to ${sel.label} tonight`;
      st.innerHTML = this.sel === now ? `Cancels the change to ${esc(planL)}.` : `Changes when the party rests. ${esc(nowL)} stays active until then.`;
    }
    if (this.warn) { st.innerHTML = esc(this.warn); st.className = "iw-status warn"; }
  }

  // ── actions ──
  async go() {
    if (this.busy || !this.sel) return;
    const op = this.mode === "first" ? "attune" : "queue";
    this.busy = true; this.warn = ""; this.render();
    const r = await requestIw(op, { holderUuid: this.holder.uuid, elem: this.sel });
    this.busy = false;
    if (r?.ok) {
      sfx("queue");
      if (op === "attune") this.done = true;
    } else if (r?.reason === "already_chosen" && this.mode === "first") {
      this.done = true; this.sel = this.state().current;     // someone else picked first
    } else this.warn = iwFailText(r);
    if (!this.el) return;
    this.render();
    if (this.mode === "first" && this.done) this.el.querySelector(".iw-close")?.focus();
  }

  async keepCurrent() {
    const now = this.state().current;
    if (this.busy || !now) return;
    this.busy = true; this.warn = ""; this.render();
    const r = await requestIw("queue", { holderUuid: this.holder.uuid, elem: now });
    this.busy = false;
    if (r?.ok) { this.sel = now; sfx("back"); } else this.warn = iwFailText(r);
    this.render();
  }

  tryClose() {
    if (this.locked()) {
      this.warn = "Choose a wellspring first. Inner Wellspring needs one to work.";
      this.render();
      return;
    }
    sfx("back");
    this.close();
    document.getElementById(BTN_ID)?.focus?.();
  }

  // ── pixel effects round the chosen button ──
  initFx() {
    const PX = 2, [FW, FH] = AURA.size;
    this._fx = { PX, FW, FH, OX: 70, OY: 96, LOOP: AURA.duration, aura: null, auraEl: null, t0: 0, last: 0 };
    this._layers = [".iw-fx-back", ".iw-fx-front"].map((sel) => {
      const cv = this.el.querySelector(sel);
      cv.width = FW; cv.height = FH; cv.style.width = `${FW * PX}px`; cv.style.height = `${FH * PX}px`;
      const c2 = cv.getContext("2d");
      return { cv, c2, img: c2.createImageData(FW, FH), frame: createFrame(FW, FH) };
    });
    const tick = (now) => {
      if (!this.el) return;
      this._raf = requestAnimationFrame(tick);
      const F = this._fx, n = this.G.nodes[this.sel];
      const on = !!this.sel && !!this.G.R && !!n;
      for (const L of this._layers) L.cv.hidden = !on;
      if (!on) { F.auraEl = null; return; }
      if (now - F.last < 1000 / 30 - 2) return;
      F.last = now;
      if (F.auraEl !== this.sel) { F.aura = createAura({ ...AURA.options, el: this.sel, r: 21, button: false, lift: 0 }); F.auraEl = this.sel; F.t0 = now; }
      const t = ((now - F.t0) / 1000) % F.LOOP;
      this._layers.forEach((L, i) => {
        clearFrame(L.frame);
        const p = painterFor(L.frame);
        p.place(F.OX, F.OY);
        i ? F.aura.draw(p, t) : F.aura.drawBack(p, t);
        composite(L.frame, L.img.data);
        L.c2.putImageData(L.img, 0, 0);
        L.cv.style.left = `${Math.round(n.x - F.OX * F.PX)}px`;
        L.cv.style.top = `${Math.round(n.y - F.OY * F.PX)}px`;
      });
    };
    this._raf = requestAnimationFrame(tick);
  }

  close(instant = false) {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    if (this._onActor) Hooks.off("updateActor", this._onActor);
    if (this._onEffect) { Hooks.off("createActiveEffect", this._onEffect); Hooks.off("deleteActiveEffect", this._onEffect); }
    this._onActor = this._onEffect = null;
    const el = this.el;
    this.el = null;
    if (WellspringWindow._cur === this) WellspringWindow._cur = null;
    if (!el) return;
    if (instant) { el.remove(); return; }
    el.classList.remove("is-open");
    setTimeout(() => el.remove(), 260);
  }
}

// ── The camp button ─────────────────────────────────────────────────────────
// Beside the Upgrade button when this client shows it, else in its slot.
function placeButton(btn) {
  const up = document.getElementById(UPGRADE_BTN_ID);
  btn.style.left = up?.classList.contains("is-shown") ? "172px" : "98px";
}
let _btnHolder = null;
async function refreshButton() {
  const holder = isCampScene() && iwCampOpen() ? await myHolder() : null;
  _btnHolder = holder;
  let btn = document.getElementById(BTN_ID);
  if (!holder) {
    btn?.classList.remove("is-shown");
    if (!iwCampOpen() && WellspringWindow._cur?.mode === "rest") WellspringWindow.close();
    return;
  }
  injectStyles();
  if (!btn) {
    btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.innerHTML = `${PENTA_SVG}<span class="iw-btn-label">Wellspring</span><span class="iw-btn-badge" aria-hidden="true"></span>`;
    btn.addEventListener("click", () => {
      if (WellspringWindow._cur && !WellspringWindow._cur.locked()) { sfx("back"); WellspringWindow.close(); }
      else WellspringWindow.open(_btnHolder);
    });
    document.body.appendChild(btn);
  }
  placeButton(btn);
  setTimeout(() => placeButton(btn), 450);     // Upgrade's own refresh may land after ours
  const st = iwState(holder);
  const badge = elementOf(st.tonight ?? st.current);
  const b = btn.querySelector(".iw-btn-badge");
  b.style.background = badge ? `rgb(${badge.rgb})` : "transparent";
  b.innerHTML = badge ? svg(ICON[badge.id], "", 2.4).replace('stroke="currentColor"', 'stroke="#2b1d10"') : "";
  b.hidden = !badge;
  const label = badge ? `Inner Wellspring: ${badge.label}${st.tonight ? " tonight" : ""} (${holder.name})` : `Inner Wellspring (${holder.name})`;
  btn.dataset.tooltip = label;
  btn.setAttribute("aria-label", label);
  requestAnimationFrame(() => btn.classList.add("is-shown"));
}

// ── First pick: open as soon as the skill is held and nothing is chosen ─────
// Waits out a running conflict (re-checked when the combat ends) and the title
// screen (re-checked on the next canvasReady).
async function checkFirstPick() {
  if (WellspringWindow._cur?.locked()) return;
  if (game.combat?.started) return;
  if (!canvas?.scene || canvas.scene.flags?.[MOD]?.oniFabula?.general?.sceneMode === "title") return;
  const holder = await myHolder({ filter: needsFirstPick, primaryOnly: true });
  if (holder) WellspringWindow.open(holder, { mode: "first" });
}

let _installed = false;
export function initWellspringUI() {
  if (_installed) return;
  _installed = true;
  const refresh = foundry.utils.debounce(() => refreshButton().catch((e) => console.warn(TAG, "refresh", e)), 200);
  const first = foundry.utils.debounce(() => checkFirstPick().catch((e) => console.warn(TAG, "first pick", e)), 600);
  Hooks.on("updateSetting", (s) => { if (String(s?.key ?? "").startsWith(`${MOD}.`)) refresh(); });
  Hooks.on("canvasReady", () => { refresh(); first(); });
  Hooks.on("updateActor", (actor, diff) => { if (isCampScene() && diff?.flags?.[MOD]) refresh(); });
  const isIwItem = (item) => item?.parent?.documentName === "Actor" && String(item.name ?? "").trim().toLowerCase() === "inner wellspring";
  Hooks.on("createItem", (item) => { if (isIwItem(item)) { first(); refresh(); } });
  Hooks.on("updateItem", (item) => { if (isIwItem(item)) { first(); refresh(); } });
  Hooks.on("deleteCombat", first);
  Hooks.on("userConnected", () => { first(); refresh(); });
  refresh();
  first();
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  const W = `#${WIN_ID}`;
  s.textContent = `
${W} { --parchment-top: #efe3c6; --parchment-bot: #e4d3ac; --ink: #3a1e06; --ink-soft: #6b4a26; --gold: #c9a44a; --bark: #7a4e20;
  --bark-deep: #5c3818; --garnet: #9c2f2a; --floor-mid: #3a2814; --floor-edge: #140d07; --el-rgb: 201,164,74; --ink-el: #6b4a26;
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, calc(-50% + 18px)); opacity: 0; z-index: 9999;
  transition: opacity .28s cubic-bezier(.2,.9,.2,1), transform .28s cubic-bezier(.2,.9,.2,1);
  width: min(1080px, 96vw); height: min(720px, 92vh); display: grid; grid-template-rows: auto minmax(0,1fr) auto; overflow: hidden;
  border-radius: 16px; border: 2px solid var(--gold); box-shadow: 0 0 0 2px var(--bark), 0 0 0 4px #b8865a, 0 22px 64px rgba(0,0,0,.55);
  background: linear-gradient(180deg, var(--parchment-top), var(--parchment-bot)); color: var(--ink);
  font-family: "Signika", "Noto Sans", system-ui, sans-serif; box-sizing: border-box; }
${W} *, ${W} *::before, ${W} *::after { box-sizing: border-box; }
${W}.is-open { opacity: 1; transform: translate(-50%, -50%); }
${W} img, ${W} video { border: none !important; box-shadow: none; background: transparent; max-width: none; }
${W} h3 { margin: 0; padding: 0; border: none; font-family: inherit; font-size: 16px; font-weight: 700; line-height: 1.2; color: var(--ink); text-wrap: balance; }
${W} p { margin: 0; }
${W} button { font: inherit; margin: 0; line-height: normal; width: auto; height: auto; }
${W} button:hover, ${W} button:focus { box-shadow: none; }
${W} [hidden] { display: none !important; }
${W} .iw-tb { display: flex; align-items: center; gap: 12px; padding: 8px 16px; color: #fff6dd; background: linear-gradient(180deg, var(--bark), var(--bark-deep)); }
${W} .iw-tb-sprite { width: 30px; height: 42px; object-fit: contain; image-rendering: pixelated; flex: none; }
${W} .iw-tb-text { display: flex; flex-direction: column; line-height: 1.15; flex: 1; min-width: 0; }
${W} .iw-tb-title { font-size: 18px; font-weight: 700; }
${W} .iw-tb-sub { font-size: 12px; color: #e9d3a6; }
${W} .iw-tb-chip { display: flex; align-items: center; gap: 7px; padding: 4px 12px; border-radius: 999px; background: rgba(0,0,0,.25); font-size: 13px; font-weight: 600; white-space: nowrap; }
${W} .iw-tb-chip i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
${W} .iw-tb-close { width: 36px; height: 36px; border-radius: 8px; border: 1px solid rgba(255,246,221,.4); background: transparent; color: #fff6dd; cursor: pointer; font-size: 18px; line-height: 1; padding: 0; flex: none; }
${W} .iw-tb-close:hover { background: rgba(160,48,32,.75); }
${W} .iw-tb-close:focus-visible { outline: 2px solid #ffd27a; }
${W} .iw-body { display: grid; grid-template-columns: minmax(0,1fr) 380px; min-height: 0; }
${W} .iw-stage { position: relative; min-height: 0; overflow: hidden;
  background: radial-gradient(ellipse at 50% 50%, var(--floor-mid) 0%, #241709 55%, var(--floor-edge) 100%);
  box-shadow: inset 0 0 0 1px rgba(201,164,74,.35), inset 0 0 60px rgba(0,0,0,.6); }
${W} .iw-rune { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
${W} .iw-rune .iw-ring { fill: none; stroke: rgba(201,164,74,.38); }
${W} .iw-rune .iw-ring.iw-thin { stroke: rgba(201,164,74,.18); stroke-dasharray: 2 6; }
${W} .iw-rune .iw-pent { fill: none; stroke: rgba(201,164,74,.42); stroke-width: 1.2; }
${W} .iw-rune .iw-star { fill: none; stroke: rgba(201,164,74,.16); stroke-width: 1; }
${W} .iw-fxl { position: absolute; pointer-events: none; image-rendering: pixelated; }
${W} .iw-fx-back { z-index: 3; } ${W} .iw-fx-front { z-index: 5; }
${W} .iw-center { position: absolute; z-index: 2; transform: translate(-50%, -50%); display: grid; place-items: center; pointer-events: none; }
${W} .iw-center .iw-sprite { position: relative; width: auto; image-rendering: pixelated; object-fit: contain; }
${W} .iw-node { position: absolute; z-index: 4; transform: translate(-50%, -50%); width: 86px; height: 86px; border-radius: 50%;
  padding: 0; cursor: pointer; display: grid; place-items: center; border: 2px solid rgba(201,164,74,.75);
  background: radial-gradient(circle at 40% 35%, #f4e9cf 0%, #d9c49a 100%);
  box-shadow: 0 0 0 3px rgba(20,13,7,.6), 0 4px 10px rgba(0,0,0,.5);
  transition: border-color .2s ease, background .3s ease, box-shadow .3s ease; }
${W} .iw-node .iw-ico { width: 36px; height: 36px; color: var(--ink-el); transition: color .3s ease; }
${W} .iw-node:hover:not(:disabled), ${W} .iw-node:focus:not(.is-sel) { box-shadow: 0 0 0 3px rgba(20,13,7,.6), 0 0 18px rgba(var(--rgb), .7); }
${W} .iw-node:disabled { cursor: default; }
${W} .iw-node:focus-visible { outline: 3px solid #ffd27a; outline-offset: 4px; }
${W} .iw-nlabel { position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%); white-space: nowrap;
  font-size: 14px; font-weight: 700; color: #e9d3a6; text-shadow: 0 1px 2px #000; letter-spacing: .3px; line-height: 1.2; }
${W} .iw-nlabel small { display: block; text-align: center; font-size: 10.5px; font-weight: 600; opacity: .7; letter-spacing: .5px; text-transform: uppercase; }
${W} .iw-tag { position: absolute; top: calc(100% + 42px); left: 50%; transform: translateX(-50%); font-size: 9.5px; font-weight: 700; letter-spacing: .6px;
  padding: 2px 7px; border-radius: 999px; text-transform: uppercase; white-space: nowrap; line-height: 1.3; }
${W} .iw-tag.now { background: #2b1d10; color: #e9d3a6; border: 1px solid rgba(201,164,74,.7); }
${W} .iw-tag.tonight { background: var(--garnet); color: #fff6dd; border: 1px solid #ffb8a8; }
${W} .iw-node.is-sel { border-color: rgb(var(--rgb));
  background: radial-gradient(circle at 50% 45%, rgba(var(--rgb), .95) 0%, rgba(var(--rgb), .55) 38%, #1c1209 80%);
  animation: fu-iw-nodeglow 3.4s ease-in-out infinite alternate; }
${W} .iw-node.is-sel .iw-ico { color: #fffaf0; filter: drop-shadow(0 0 4px rgba(var(--rgb), 1)); }
${W} .iw-node.is-sel .iw-nlabel { color: rgb(var(--rgb)); }
@keyframes fu-iw-nodeglow {
  from { box-shadow: 0 0 0 3px rgba(20,13,7,.6), 0 0 14px 2px rgba(var(--rgb), .55); }
  to   { box-shadow: 0 0 0 3px rgba(20,13,7,.6), 0 0 34px 10px rgba(var(--rgb), .8); }
}
${W} .iw-stage-hint { position: absolute; left: 0; right: 0; bottom: 14px; text-align: center; z-index: 4; color: rgba(233,211,166,.7); font-size: 12.5px; pointer-events: none; }
${W} .iw-right { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; min-height: 0; border-left: 1px solid rgba(122,78,32,.25); }
${W} .iw-panel { border-radius: 12px; border: 1px solid rgba(122,78,32,.3); background: rgba(255,255,255,.55); padding: 12px 14px; }
${W} .iw-sub { margin: 2px 0 0; font-size: 12px; color: var(--ink-soft); }
${W} .iw-gives header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
${W} .iw-swatch { width: 36px; height: 36px; border-radius: 50%; flex: none; display: grid; place-items: center;
  background: radial-gradient(circle at 50% 45%, rgba(var(--el-rgb), .95), rgba(var(--el-rgb), .45) 55%, #1c1209 90%); border: 2px solid rgb(var(--el-rgb)); }
${W} .iw-swatch svg { width: 20px; height: 20px; color: #fffaf0; }
${W} .iw-gives ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
${W} .iw-gives li { display: grid; grid-template-columns: 26px 1fr; gap: 8px; align-items: start; margin: 0; }
${W} .iw-gives li > svg { width: 22px; height: 22px; color: var(--ink-el); margin-top: 1px; }
${W} .iw-gives li b { display: block; font-size: 13.5px; }
${W} .iw-gives li span { display: block; font-size: 12.5px; color: var(--ink-soft); line-height: 1.35; }
${W} .iw-gives li span.iw-manual { margin-top: 2px; font-size: 11.5px; font-style: italic; }
${W} .iw-dmg { font-style: normal; font-weight: 700; color: var(--ink-el); }
${W} .iw-inv { flex: 1; min-height: 0; display: flex; flex-direction: column; }
${W} .iw-inv header { margin-bottom: 8px; }
${W} .iw-inv-list { display: flex; flex-direction: column; gap: 7px; overflow-y: auto; min-height: 0; padding-right: 2px; }
${W} .iw-card { flex: none; display: grid; grid-template-columns: 4px 1fr; gap: 10px; padding: 8px 10px 8px 0; border-radius: 9px;
  background: rgba(255,255,255,.7); border: 1px solid rgba(122,78,32,.18); overflow: hidden; }
${W} .iw-card .iw-bar { background: rgb(var(--el-rgb)); border-radius: 0 3px 3px 0; }
${W} .iw-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .7px; text-transform: uppercase; color: var(--ink-soft); }
${W} .iw-nm { font-size: 14px; font-weight: 700; }
${W} .iw-ds { font-size: 12.5px; color: var(--ink-soft); line-height: 1.35; }
${W} .iw-card.locked { opacity: .5; }
${W} .iw-card.locked .iw-bar { background: #b9a684; }
${W} .iw-lock { font-size: 11px; font-weight: 600; color: var(--garnet); }
${W} .iw-foot { margin: 8px 0 0; font-size: 11.5px; color: var(--ink-soft); }
${W} .iw-empty { color: var(--ink-soft); font-size: 13px; line-height: 1.4; padding: 6px 0; }
${W} .iw-ft { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-top: 1px solid rgba(122,78,32,.3); background: rgba(122,78,32,.08); }
${W} .iw-status { flex: 1; font-size: 13px; color: var(--ink-soft); min-width: 0; }
${W} .iw-status b { color: var(--ink); }
${W} .iw-status.warn { color: var(--garnet); font-weight: 600; }
${W} .iw-btn { font-size: 14px; font-weight: 700; padding: 9px 18px; border-radius: 10px; cursor: pointer; white-space: nowrap; flex: none; }
${W} .iw-btn:focus-visible { outline: 2px solid #ffd27a; outline-offset: 2px; }
${W} .iw-secondary { background: #faf6ee; color: var(--ink); border: 1px solid #b8865a; }
${W} .iw-secondary:hover:not(:disabled) { background: #fff; }
${W} .iw-primary { color: #fff6dd; border: 1px solid #5e1612; background: linear-gradient(180deg, #b23a33, #8a2622); animation: fu-iw-ctaglow 3.4s ease-in-out infinite alternate; }
${W} .iw-primary:hover:not(:disabled) { filter: brightness(1.1); }
@keyframes fu-iw-ctaglow { from { box-shadow: 0 0 4px 0 rgba(178,58,51,.45); } to { box-shadow: 0 0 16px 4px rgba(178,58,51,.6); } }
${W} .iw-primary:disabled { animation: none; cursor: not-allowed; background: #c9b89a; border-color: #b0a07f; color: #fbf5e6; box-shadow: none; }
${W} .iw-btn:disabled { cursor: not-allowed; }
@media (max-width: 820px) {
  ${W} .iw-body { grid-template-columns: 1fr; grid-template-rows: minmax(330px, 1fr) auto; overflow-y: auto; }
  ${W} .iw-right { border-left: none; border-top: 1px solid rgba(122,78,32,.25); }
  ${W} .iw-inv-list { overflow: visible; }
}
/* The camp button (camp-ui-button.js: left 20, bottom 80, 64px; Upgrade sits at 98). */
#${BTN_ID} { position: fixed; z-index: 99998; left: 98px; bottom: 80px; width: 64px; height: 64px; border-radius: 50%; margin: 0; line-height: normal;
  border: 2px solid rgba(200,160,80,0.65); background: radial-gradient(circle at 40% 35%, rgba(92,56,24,0.94) 0%, rgba(43,29,16,0.97) 100%);
  box-shadow: 0 0 14px rgba(255,190,90,.45), 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 0; cursor: pointer;
  opacity: 0; transform: scale(.6) translateY(10px); pointer-events: none;
  transition: opacity 250ms cubic-bezier(.4,0,.2,1), transform 250ms cubic-bezier(.4,0,.2,1), filter 180ms ease; }
#${BTN_ID}.is-shown { opacity: 1; transform: none; pointer-events: auto; }
#${BTN_ID}:hover { filter: brightness(1.18); box-shadow: 0 0 14px rgba(255,190,90,.45), 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12); }
#${BTN_ID}:focus-visible { outline: 2px solid #ffd27a; outline-offset: 3px; }
#${BTN_ID} .iw-btn-label { font-size: 7.4px; font-weight: 700; letter-spacing: .15px; text-transform: uppercase; color: #e8c870; opacity: .8; white-space: nowrap; font-family: "Signika","Noto Sans",system-ui,sans-serif; }
#${BTN_ID} .iw-btn-badge { position: absolute; top: -3px; right: -3px; width: 20px; height: 20px; border-radius: 50%; border: 2px solid #2b1d10; display: grid; place-items: center; }
#${BTN_ID} .iw-btn-badge[hidden] { display: none; }
#${BTN_ID} .iw-btn-badge svg { width: 12px; height: 12px; }
`;
  document.head.appendChild(s);
}
