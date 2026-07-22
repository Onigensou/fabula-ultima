/**
 * Attribute system — the Status window.
 *
 * A character sheet's attribute row is an editable number field. This window is
 * the opposite: a read-only summary that only ever becomes interactive when the
 * character has actually earned an advance, and even then only through an arrow
 * that steps one die. Nobody is expected to type a value into an attribute
 * again, so the window never offers a way to.
 *
 * Staging mirrors the skill window: arrows edit live, nothing is written until
 * Confirm, and Discard throws the staging away.
 */

import {
  ATTR, ATTR_KEYS, ATTR_META, num, nextDie, log, warn,
} from "./attribute-const.js";
import { readStatus, previewDerived, advance } from "./attribute-api.js";
import { sfx, windowAnim, staggerRows } from "../levelup-system/levelup-fx.js";

const ROOT_ID = "oni-attributes";
const STYLE_ID = "oni-attributes-css";

const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const api = () => globalThis.FUCompanion?.api?.attributes ?? null;

export const AttributeApp = {
  _root: null,
  _actorUuid: null,
  _staged: {},        // { mig: 1, dex: 0, ... }
  _applying: false,
  _hook: null,

  get isOpen() { return !!this._root; },
  get stagedTotal() { return ATTR_KEYS.reduce((n, k) => n + num(this._staged[k], 0), 0); },

  open(actorUuid) {
    const uuid = actorUuid ?? this._guessActor();
    if (!uuid) return ui.notifications?.warn?.("No character selected.");
    injectStyles();

    this._actorUuid = uuid;
    if (this.isOpen) return this.render();

    this._staged = {};
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `<div class="at-panel"></div>`;
    document.body.appendChild(root);
    this._root = root;

    root.addEventListener("mousedown", (ev) => { if (ev.target === root) this.close(); });
    root.addEventListener("click", (ev) => this._onClick(ev));

    // The sheet is authoritative; if something else moves an attribute while
    // this is open, redraw rather than showing a stale die.
    this._hook = Hooks.on("updateActor", (doc) => {
      if (doc?.uuid === this._actorUuid && !this._applying) this.render();
    });

    this.render();
    windowAnim(root.querySelector(".at-panel"), "in");
    sfx("open");
  },

  async close() {
    if (this._closing) return;
    this._closing = true;
    sfx("close");
    await windowAnim(this._root?.querySelector(".at-panel"), "out");
    this._closing = false;
    if (this._hook) { Hooks.off("updateActor", this._hook); this._hook = null; }
    this._staged = {};
    this._root?.remove();
    this._root = null;
  },

  toggle(uuid) { this.isOpen ? this.close() : this.open(uuid); },

  _guessActor() {
    const t = canvas?.tokens?.controlled?.[0]?.actor;
    if (t) return t.uuid;
    return game.user?.character?.uuid ?? null;
  },

  render() {
    if (!this.isOpen || this._applying) return;
    const s = readStatus(this._actorUuid);
    const panel = this._root.querySelector(".at-panel");
    if (!s?.ok) {
      panel.innerHTML = `<div class="at-head"><div class="at-title">Status</div>
        <button class="at-x" data-act="close">×</button></div>
        <div class="at-empty">Could not read this character.</div>`;
      return;
    }

    // Staging can outlive its permission — a level edit or another client's
    // spend can drop the allowance out from under it.
    if (this.stagedTotal > s.advances.available) this._staged = {};

    const preview = this.stagedTotal ? previewDerived(s, this._staged) : null;

    panel.innerHTML =
      this._head(s) +
      `<div class="at-body">
         <div class="at-left">${this._attrList(s)}</div>
         <div class="at-right">${this._derived(s, preview)}</div>
       </div>` +
      this._footer(s);

    staggerRows(panel.querySelectorAll(".at-row"), "in");
  },

  _head(s) {
    const avail = s.advances.available;
    return `<div class="at-head">
      <img class="at-portrait" src="${esc(s.actor.img)}" alt="">
      <div class="at-idblock">
        <div class="at-title">${esc(s.actor.name)}</div>
        <div class="at-sub">Level ${s.derived.level}</div>
      </div>
      ${avail > 0
        ? `<div class="at-points" title="Earned at level ${ATTR.MILESTONES.join(" and ")}">
             <span class="n">${avail}</span> Attribute Point${avail === 1 ? "" : "s"}</div>`
        : ""}
      <button class="at-x" data-act="close" title="Close">×</button>
    </div>`;
  },

  /**
   * One row per attribute.
   *
   * The die shown is BASE — the permanent value, and the only thing an advance
   * moves. `current` appears beside it only when an effect has shifted it, in
   * blue when raised and red when lowered; when the two agree the number would
   * just be the die repeated.
   */
  _attrList(s) {
    const canSpend = s.advances.available > 0 && s.gate.open;

    return s.attributes.map((a) => {
      const staged = num(this._staged[a.key], 0);
      const shown = staged ? this._afterStaging(a, staged) : a.base;
      const capped = shown >= ATTR.DIE.MAX;

      const shift = a.shift === 0 ? ""
        : `<span class="at-cur ${a.shift > 0 ? "up" : "down"}"
             title="Currently rolling d${a.current}">(${a.current})</span>`;

      const arrows = !canSpend ? "" : `
        <span class="at-arrows">
          ${staged ? `<button class="at-arrow down" data-act="unstage" data-key="${a.key}"
                        title="Take this back">▼</button>` : ""}
          <button class="at-arrow up" data-act="stage" data-key="${a.key}"
            ${capped || this.stagedTotal >= s.advances.available ? "disabled" : ""}
            title="${capped ? `Already at d${ATTR.DIE.MAX}` : `Raise to d${nextDie(shown)}`}">▲</button>
        </span>`;

      return `<div class="at-row ${staged ? "is-staged" : ""}">
        <img class="at-icon" src="${esc(a.icon)}" alt="">
        <span class="at-label" title="${esc(a.full)}">${esc(a.label)}</span>
        <span class="at-die">
          ${staged ? `<s class="was">d${a.base}</s> <b class="now">d${shown}</b>` : `<b>d${a.base}</b>`}
        </span>
        ${shift}
        ${arrows}
      </div>`;
    }).join("");
  },

  /** Where a die lands after N staged steps, respecting the ceiling. */
  _afterStaging(attr, steps) {
    let die = attr.base;
    for (let i = 0; i < steps; i++) {
      const n = nextDie(die);
      if (n == null) break;
      die = n;
    }
    return die;
  },

  _derived(s, preview) {
    const d = s.derived;
    const p = preview ?? d;
    // A previewed value is shown as "was → now" so the consequence of the step
    // is visible before it is committed.
    const cell = (label, now, then, fmt = (v) => v) =>
      `<div class="at-stat ${then !== undefined && then !== now ? "changed" : ""}">
         <span class="k">${esc(label)}</span>
         <span class="v">${fmt(now)}${then !== undefined && then !== now
            ? ` <i class="arrow">→</i> <b>${fmt(then)}</b>` : ""}</span>
       </div>`;

    const pair = (cur, max) => `${cur} / ${max}`;

    return `
      ${cell("HP", pair(d.hp.cur, d.hp.max), preview ? pair(d.hp.cur, p.hp.max) : undefined)}
      ${cell("MP", pair(d.mp.cur, d.mp.max), preview ? pair(d.mp.cur, p.mp.max) : undefined)}
      ${cell("IP", pair(d.ip.cur, d.ip.max))}
      <div class="at-sep"></div>
      ${cell("DEF", d.def, preview ? p.def : undefined)}
      ${cell("MDEF", d.mdef, preview ? p.mdef : undefined)}
      ${cell("Initiative", fmtInit(d.init.value), preview ? fmtInit(p.init.value) : undefined)}
      <div class="at-sep"></div>
      ${cell("Crisis", d.crisis, preview ? p.crisis : undefined)}
      ${cell("Fabula", d.fabula)}
      ${cell("Zenit", d.zenit.toLocaleString())}
    `;
  },

  _footer(s) {
    if (!this.stagedTotal) {
      const why = !s.gate.open && s.advances.available > 0
        ? `<span class="at-note">Attribute points can be spent while resting at camp, or on the title screen.</span>`
        : "";
      return `<div class="at-foot">${why}</div>`;
    }
    const summary = ATTR_KEYS.filter((k) => this._staged[k])
      .map((k) => `${ATTR_META[k].label} +${this._staged[k]}`).join(", ");
    return `<div class="at-foot staged">
      <span class="at-note">${esc(summary)}</span>
      <span class="at-spacer"></span>
      <button class="at-cta" data-act="discard">Discard</button>
      <button class="at-cta go" data-act="confirm">Confirm</button>
    </div>`;
  },

  async _onClick(ev) {
    const btn = ev.target?.closest?.("[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;

    if (act === "close") return this.close();

    if (act === "stage") {
      const key = btn.dataset.key;
      this._staged[key] = num(this._staged[key], 0) + 1;
      sfx("stageUp");
      return this.render();
    }
    if (act === "unstage") {
      const key = btn.dataset.key;
      const n = num(this._staged[key], 0) - 1;
      if (n > 0) this._staged[key] = n; else delete this._staged[key];
      sfx("stageDown");
      return this.render();
    }
    if (act === "discard") {
      this._staged = {};
      sfx("deselect");
      return this.render();
    }
    if (act === "confirm") return this._confirm();
  },

  async _confirm() {
    if (!this.stagedTotal || this._applying) return;
    // Flatten to a pick list; several steps on one attribute repeat its key so
    // the GM applies and logs them one at a time.
    const picks = [];
    for (const k of ATTR_KEYS) for (let i = 0; i < num(this._staged[k], 0); i++) picks.push(k);

    this._applying = true;
    const res = await advance({ actorUuid: this._actorUuid, picks });
    this._applying = false;

    if (!res?.ok) {
      warn("advance failed", res);
      ui.notifications?.warn?.(`Could not raise attributes: ${res?.reason ?? "unknown"}`);
      return this.render();
    }
    this._staged = {};
    sfx("levelUp");
    this.render();
  },
};

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${ROOT_ID} { position: fixed; inset: 0; z-index: 70; display: flex;
  align-items: center; justify-content: center; background: rgba(0,0,0,.55); }
#${ROOT_ID} * { box-sizing: border-box; }
#${ROOT_ID} .at-panel { width: min(660px, 94vw); max-height: 90vh; display: flex;
  flex-direction: column; border-radius: 10px; overflow: hidden;
  background: #efe4cd; border: 2px solid #6b543a;
  box-shadow: 0 18px 60px rgba(0,0,0,.55); font-family: Signika, sans-serif; color: #2f2618; }

#${ROOT_ID} .at-head { display: flex; align-items: center; gap: 12px; padding: 10px 14px;
  background: linear-gradient(180deg,#5d4630,#4a371f); color: #f6ecd8; flex: 0 0 auto; }
#${ROOT_ID} .at-portrait { width: 38px; height: 38px; border-radius: 6px; object-fit: cover;
  border: 0 !important; outline: 0 !important; }
#${ROOT_ID} .at-idblock { flex: 1 1 auto; min-width: 0; }
#${ROOT_ID} .at-title { font-size: 17px; font-weight: 800; }
#${ROOT_ID} .at-sub { font-size: 11.5px; opacity: .8; }
#${ROOT_ID} .at-points { padding: 3px 11px; border-radius: 12px; font-size: 12px; font-weight: 700;
  background: linear-gradient(180deg,#f0d99a,#e0c179); color: #4b3517; border: 1px solid #8a6c45; }
#${ROOT_ID} .at-points .n { font-size: 14px; font-weight: 800; }
#${ROOT_ID} .at-x { background: none; border: 0; color: #f6ecd8; font-size: 20px; line-height: 1;
  cursor: pointer; padding: 0 4px; width: auto; }

#${ROOT_ID} .at-body { display: flex; gap: 0; flex: 1 1 auto; min-height: 0; }
#${ROOT_ID} .at-left { flex: 0 0 auto; width: 300px; padding: 12px; display: flex;
  flex-direction: column; gap: 7px; }
#${ROOT_ID} .at-right { flex: 1 1 auto; min-width: 0; padding: 12px 14px;
  background: #e6dabd; border-left: 1px solid #b79c72;
  display: flex; flex-direction: column; gap: 3px; overflow-y: auto; }

#${ROOT_ID} .at-row { display: flex; align-items: center; gap: 9px; padding: 7px 9px;
  border-radius: 8px; background: #f7f0df; border: 1px solid #cbb890; }
#${ROOT_ID} .at-row.is-staged { border-color: #8a6c45; background: #fdf6e4;
  box-shadow: inset 0 0 0 1px rgba(240,217,154,.7); }
#${ROOT_ID} .at-icon { width: 26px; height: 26px; object-fit: contain; flex: 0 0 auto;
  border: 0 !important; outline: 0 !important; background: none; }
#${ROOT_ID} .at-label { font-weight: 800; letter-spacing: .04em; width: 42px; flex: 0 0 auto; }
#${ROOT_ID} .at-die { font-size: 15px; flex: 1 1 auto; }
#${ROOT_ID} .at-die .was { opacity: .45; font-size: 13px; }
#${ROOT_ID} .at-die .now { color: #2f6b2f; }

/* Current value, shown only when an effect has moved it off base. */
#${ROOT_ID} .at-cur { font-size: 13px; font-weight: 700; flex: 0 0 auto; }
#${ROOT_ID} .at-cur.up { color: #1f5fa8; }
#${ROOT_ID} .at-cur.down { color: #a52a2a; }

#${ROOT_ID} .at-arrows { display: flex; align-items: center; gap: 3px; flex: 0 0 auto; }
#${ROOT_ID} .at-arrow { width: 26px; height: 24px; border-radius: 6px; cursor: pointer;
  border: 1px solid #8a6c45; background: linear-gradient(180deg,#f7edd5,#e6d6b0);
  font-size: 12px; line-height: 1; color: #4b3517; padding: 0; }
#${ROOT_ID} .at-arrow.up:hover:not([disabled]) { background: linear-gradient(180deg,#f0d99a,#e0c179); }
#${ROOT_ID} .at-arrow[disabled] { opacity: .35; cursor: default; }

#${ROOT_ID} .at-stat { display: flex; align-items: baseline; justify-content: space-between;
  gap: 10px; font-size: 13px; padding: 2px 0; }
#${ROOT_ID} .at-stat .k { opacity: .75; }
#${ROOT_ID} .at-stat .v { font-weight: 700; font-variant-numeric: tabular-nums; }
#${ROOT_ID} .at-stat.changed .v { color: #2f6b2f; }
#${ROOT_ID} .at-stat .arrow { font-style: normal; opacity: .6; }
#${ROOT_ID} .at-sep { height: 1px; background: #c0a67c; margin: 5px 0; }

#${ROOT_ID} .at-foot { display: flex; align-items: center; gap: 9px; padding: 9px 14px;
  background: #e6dabd; border-top: 2px solid #b79c72; flex: 0 0 auto; min-height: 44px; }
#${ROOT_ID} .at-spacer { flex: 1 1 auto; }
#${ROOT_ID} .at-note { font-size: 12px; opacity: .8; }
#${ROOT_ID} .at-cta { padding: 6px 16px; border-radius: 7px; cursor: pointer; font-weight: 700;
  border: 1px solid #8a6c45; background: linear-gradient(180deg,#f7edd5,#e6d6b0); color: #3b2a17; }
#${ROOT_ID} .at-cta.go { background: linear-gradient(180deg,#5f9e4a,#3f7a30); color: #fff;
  border-color: #2f6b2f; }
#${ROOT_ID} .at-empty { padding: 24px; text-align: center; opacity: .7; }
`;
  document.head.appendChild(s);
}

/** Initiative is an average, so it can land on a half. */
const fmtInit = (v) => {
  const n = Number(v) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
};

function registerApi() {
  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.attributes = globalThis.FUCompanion.api.attributes ?? {};
  Object.assign(globalThis.FUCompanion.api.attributes, {
    app: AttributeApp,
    openStatus: (uuid) => AttributeApp.open(uuid),
    toggleStatus: (uuid) => AttributeApp.toggle(uuid),
  });
}

Hooks.once("init", registerApi);
Hooks.once("ready", () => { registerApi(); log("status window ready"); });
