// ============================================================================
// Clock System — GM manager window.
//
//     FUCompanion.api.clocks.manager.open()
//
// Everything the GM needs to run clocks by hand: create from a shape preset,
// nudge a section either way, apply RAW "Other Events", force a resolution,
// reopen, discard, and sweep the graveyard.
//
// Another pure consumer of the API — it drives the same `FUCompanion.api.clocks`
// surface a macro would, so nothing here can do something a script cannot.
// It re-renders off the `fu-clock-*` hooks, which means a clock advanced by a
// player, by automation, or by another GM updates this window with no wiring.
//
// GM-only: the window refuses to open for a player, and every control it
// exposes is a GM-only op that the socket layer would reject anyway.
// ============================================================================

import {
  CLOCK_TAG, CLOCK_HOOK, CLOCK_STATE, LIFECYCLE, VISIBILITY, POLE,
  CLOCK_SECTIONS_MIN, CLOCK_SECTIONS_MAX,
} from "./clock-const.js";
import { preset, notchOwnerAt } from "./clock-model.js";
import * as store from "./clock-store.js";

const STYLE_ID = "oni-clock-manager-styles";
const ROOT_ID = "oni-clock-manager";

const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function api() {
  return globalThis.FUCompanion?.api?.clocks ?? null;
}

// ── Styles ──────────────────────────────────────────────────────────────────

function injectManagerStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  // Parchment theme, palette shared with the camp / shop / healing UIs so the
  // manager reads as part of the same game rather than a dev tool.
  s.textContent = `
#${ROOT_ID} {
  --cm-parch-1: #f6ebd3; --cm-parch-2: #efdfc3; --cm-parch-3: #e7d3b1;
  --cm-wood-1: #a87649;  --cm-wood-2: #8d5f38;  --cm-wood-3: #6f4526;
  --cm-gold-1: #f4d488;  --cm-gold-2: #caa44d;
  --cm-ink: #3b2a19;
  --cm-blue: #3f9fd6; --cm-red: #cf4034; --cm-neutral: #a58a68;
  --cm-track: rgba(78,47,25,.22);

  position: fixed; inset: 0; z-index: 130;
  display: flex; align-items: center; justify-content: center;
  background: rgba(18,10,5,.62);
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif; color: var(--cm-ink);
  opacity: 0; transition: opacity .16s ease;
}
#${ROOT_ID}.visible { opacity: 1; }

.cm-frame {
  width: min(760px, 94vw); max-height: 88vh; display: flex; flex-direction: column;
  background: var(--cm-parch-1);
  border: 2.5px solid var(--cm-wood-2); border-radius: 14px;
  box-shadow: 0 0 0 1px var(--cm-wood-3), 0 18px 60px rgba(0,0,0,.55),
              inset 0 0 26px rgba(160,118,73,.18);
  overflow: hidden;
  transform: translateY(16px); transition: transform .2s cubic-bezier(.22,.8,.3,1);
}
#${ROOT_ID}.visible .cm-frame { transform: translateY(0); }

.cm-head {
  display: flex; align-items: center; gap: 10px; padding: 11px 16px;
  background: linear-gradient(180deg, var(--cm-wood-1), var(--cm-wood-2));
  border-bottom: 2px solid var(--cm-wood-3);
  color: var(--cm-parch-1);
}
.cm-title { font-size: 16px; font-weight: 700; letter-spacing: .4px; text-shadow: 0 1px 2px rgba(0,0,0,.45); }
.cm-close { margin-left: auto; cursor: pointer; opacity: .8; font-size: 20px; line-height: 1; padding: 0 4px; }
.cm-close:hover { opacity: 1; }

.cm-body { overflow-y: auto; padding: 13px 16px 16px; background: var(--cm-parch-2); }

.cm-row {
  background: var(--cm-parch-1);
  border: 1.5px solid var(--cm-wood-2); border-radius: 8px;
  box-shadow: 0 2px 6px rgba(78,47,25,.18);
  padding: 9px 11px; margin-bottom: 10px;
}
.cm-row.resolved { opacity: .72; }
.cm-row.discarded { opacity: .45; }

.cm-row-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
.cm-row-name { font-weight: 700; color: var(--cm-wood-3); }
.cm-tag {
  font-size: 10px; letter-spacing: .4px; text-transform: uppercase;
  padding: 1px 6px; border-radius: 3px;
  background: var(--cm-parch-3); border: 1px solid var(--cm-wood-1);
  color: var(--cm-wood-3);
}
.cm-row-count { margin-left: auto; font-size: 12px; opacity: .75; font-variant-numeric: tabular-nums; }

.cm-mini {
  display: flex; gap: 2px; height: 11px; margin-bottom: 9px;
  padding: 1px; border-radius: 3px;
  background: var(--cm-track); border: 1px solid var(--cm-wood-2);
}
.cm-mini div { flex: 1 1 0; border-radius: 1px; }
.cm-mini div.players { background: var(--cm-blue); }
.cm-mini div.gm { background: var(--cm-red); }
.cm-mini div.neutral { background: var(--cm-neutral); }

.cm-controls { display: flex; flex-wrap: wrap; gap: 6px; }
.cm-btn {
  /* Foundry's core stylesheet sets button { width: 100% }, which stacked every
     control on its own full-width row. Size to content instead. */
  width: auto; flex: 0 0 auto; line-height: normal; height: auto;
  cursor: pointer; user-select: none;
  font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 5px;
  color: var(--cm-wood-3);
  border: 1px solid var(--cm-wood-2);
  background: linear-gradient(180deg, var(--cm-parch-1), var(--cm-parch-3));
  box-shadow: 0 1px 2px rgba(78,47,25,.22);
  transition: background .12s ease, transform .08s ease;
}
.cm-btn:hover { background: linear-gradient(180deg, #fff7e4, var(--cm-parch-2)); }
.cm-btn:active { transform: translateY(1px); }
.cm-btn.danger { border-color: #8d2c24; color: #8d2c24; }
.cm-btn.danger:hover { background: linear-gradient(180deg, #f7d9d5, #eec3bd); }
.cm-btn.good { border-color: #2f6f96; color: #235a7c; }
.cm-btn.good:hover { background: linear-gradient(180deg, #d9edf9, #c2dcee); }
.cm-btn[disabled] { opacity: .4; pointer-events: none; }

.cm-new {
  border-top: 2px solid var(--cm-wood-2); margin-top: 6px; padding-top: 13px;
}
.cm-new h3 {
  font-size: 12px; letter-spacing: .7px; text-transform: uppercase;
  color: var(--cm-wood-2); margin: 0 0 9px;
}
.cm-fields { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 7px; align-items: center; }
.cm-fields input, .cm-fields select {
  width: 100%; box-sizing: border-box;
  background: #fffaf0; color: var(--cm-ink);
  border: 1px solid var(--cm-wood-2); border-radius: 5px;
  padding: 5px 7px; font-size: 12px;
}
.cm-fields input:focus, .cm-fields select:focus {
  outline: none; border-color: var(--cm-gold-2);
  box-shadow: 0 0 0 2px rgba(244,212,136,.5);
}
.cm-foot { display: flex; gap: 7px; margin-top: 10px; }
.cm-empty { opacity: .6; font-size: 12px; padding: 16px 0; text-align: center; }
`;
  document.head.appendChild(s);
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** A tiny read-only echo of the real gauge, using the same colour rule. */
function miniBar(clock) {
  const cells = Array.from({ length: clock.sections }, (_, i) => {
    const owner = notchOwnerAt(clock, i, clock.value);
    return `<div class="${owner === "empty" ? "" : owner}"></div>`;
  }).join("");
  return `<div class="cm-mini">${cells}</div>`;
}

function rowControls(clock) {
  if (clock.state === CLOCK_STATE.DISCARDED) {
    return `<div class="cm-controls"><button class="cm-btn danger" data-act="destroy">Delete forever</button></div>`;
  }
  if (clock.state === CLOCK_STATE.RESOLVED) {
    return `<div class="cm-controls">
      <button class="cm-btn" data-act="reopen">Reopen</button>
      <button class="cm-btn danger" data-act="discard">Discard</button>
    </div>`;
  }

  const hi = clock.poles.high, lo = clock.poles.low;
  return `<div class="cm-controls">
    <button class="cm-btn" data-act="down" title="Move one section toward the low pole">&minus;1</button>
    <button class="cm-btn" data-act="up" title="Move one section toward the high pole">+1</button>
    <button class="cm-btn" data-act="down2" title="Major event, toward the low pole">&minus;2</button>
    <button class="cm-btn" data-act="up2" title="Major event, toward the high pole">+2</button>
    ${hi ? `<button class="cm-btn good" data-act="resolve-high">Resolve: ${esc(hi.label ?? hi.side)}</button>` : ""}
    ${lo ? `<button class="cm-btn good" data-act="resolve-low">Resolve: ${esc(lo.label ?? lo.side)}</button>` : ""}
    <button class="cm-btn danger" data-act="discard">Discard</button>
  </div>`;
}

function rowHtml(clock) {
  const tags = [];
  if (clock.lifecycle !== LIFECYCLE.MANUAL) tags.push(clock.lifecycle);
  if (clock.visibility === VISIBILITY.GM) tags.push("gm-only");
  if (clock.group) tags.push(`${clock.group.mode}:${clock.group.id}`);
  if (clock.state !== CLOCK_STATE.ACTIVE) tags.push(clock.state);

  return `
<div class="cm-row ${clock.state}" data-id="${esc(clock.id)}">
  <div class="cm-row-head">
    <div class="cm-row-name">${esc(clock.name)}</div>
    ${tags.map((t) => `<div class="cm-tag">${esc(t)}</div>`).join("")}
    <div class="cm-row-count">${clock.value} / ${clock.sections}</div>
  </div>
  ${miniBar(clock)}
  ${rowControls(clock)}
</div>`;
}

function newClockHtml() {
  const shapes = [
    ["progress", "Progress — players fill it to win"],
    ["threat", "Threat — fills as players fail"],
    ["teardown", "Teardown — starts full, players empty it"],
    ["struggle", "Struggle — both sides push one axis"],
  ];
  return `
<div class="cm-new">
  <h3>New clock</h3>
  <div class="cm-fields">
    <input id="cm-name" type="text" placeholder="Clock name" />
    <input id="cm-sections" type="number" min="${CLOCK_SECTIONS_MIN}" max="${CLOCK_SECTIONS_MAX}" value="6" title="Sections" />
    <select id="cm-shape">${shapes.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select>
    <select id="cm-lifecycle">
      <option value="${LIFECYCLE.MANUAL}">Manual</option>
      <option value="${LIFECYCLE.COMBAT}">Combat</option>
      <option value="${LIFECYCLE.SCENE}">Scene</option>
    </select>
  </div>
  <div class="cm-foot">
    <button class="cm-btn good" id="cm-create">Create</button>
    <button class="cm-btn" id="cm-toggle-discarded">Show discarded</button>
    <button class="cm-btn danger" id="cm-purge" style="margin-left:auto">Purge discarded</button>
  </div>
</div>`;
}

// ── The window ──────────────────────────────────────────────────────────────

export const ClockManager = {
  _root: null,
  _showDiscarded: false,

  get isOpen() { return Boolean(this._root?.isConnected); },

  open() {
    if (!game.user.isGM) {
      ui.notifications?.warn("Clocks: the manager is GM-only.");
      return null;
    }
    if (this.isOpen) return this;

    injectManagerStyles();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="cm-frame">
        <div class="cm-head">
          <div class="cm-title">Clocks</div>
          <div class="cm-close" data-act="close">&times;</div>
        </div>
        <div class="cm-body"></div>
      </div>`;
    document.body.appendChild(root);
    this._root = root;

    root.addEventListener("click", (ev) => this._onClick(ev));
    root.addEventListener("mousedown", (ev) => { if (ev.target === root) this.close(); });
    this._onKey = (ev) => { if (ev.key === "Escape") this.close(); };
    window.addEventListener("keydown", this._onKey);

    this.render();
    requestAnimationFrame(() => root.classList.add("visible"));
    return this;
  },

  close() {
    if (!this.isOpen) return;
    window.removeEventListener("keydown", this._onKey);
    const root = this._root;
    this._root = null;
    root.classList.remove("visible");
    setTimeout(() => root.remove(), 180);
  },

  toggle() { this.isOpen ? this.close() : this.open(); },

  render() {
    if (!this.isOpen) return;
    const clocks = store.list({ includeDiscarded: this._showDiscarded });
    const body = this._root.querySelector(".cm-body");
    body.innerHTML =
      (clocks.length ? clocks.map(rowHtml).join("") : `<div class="cm-empty">No clocks. Create one below.</div>`)
      + newClockHtml();

    const toggle = body.querySelector("#cm-toggle-discarded");
    if (toggle) toggle.textContent = this._showDiscarded ? "Hide discarded" : "Show discarded";
  },

  // ── Actions ───────────────────────────────────────────────────────────────

  async _onClick(ev) {
    const btn = ev.target.closest("[data-act], #cm-create, #cm-purge, #cm-toggle-discarded");
    if (!btn) return;

    if (btn.id === "cm-create") return this._create();
    if (btn.id === "cm-purge") return this._guard(api().purgeDiscarded());
    if (btn.id === "cm-toggle-discarded") {
      this._showDiscarded = !this._showDiscarded;
      return this.render();
    }

    const act = btn.dataset.act;
    if (act === "close") return this.close();

    const id = btn.closest("[data-id]")?.dataset.id;
    if (!id) return;
    const a = api();

    switch (act) {
      // The GM nudges the AXIS, not a side's pole, so these work even on a
      // clock whose pole in that direction is unclaimed.
      case "up":    return this._guard(a.advance(id, { direction: POLE.HIGH, sections: 1, cause: "GM" }));
      case "down":  return this._guard(a.advance(id, { direction: POLE.LOW, sections: 1, cause: "GM" }));
      case "up2":   return this._guard(a.advance(id, { direction: POLE.HIGH, sections: 2, cause: "GM: major event" }));
      case "down2": return this._guard(a.advance(id, { direction: POLE.LOW, sections: 2, cause: "GM: major event" }));
      case "resolve-high": return this._guard(a.resolve(id, POLE.HIGH, { cause: "GM called it" }));
      case "resolve-low":  return this._guard(a.resolve(id, POLE.LOW, { cause: "GM called it" }));
      case "reopen":  return this._guard(a.reopen(id));
      case "discard": return this._guard(a.discard(id, { cause: "GM discarded" }));
      case "destroy": return this._guard(a.destroy(id));
    }
  },

  async _create() {
    const root = this._root;
    const name = root.querySelector("#cm-name").value.trim();
    if (!name) { ui.notifications?.warn("Clocks: a clock needs a name."); return; }

    const sections = Number(root.querySelector("#cm-sections").value) || 6;
    const shape = root.querySelector("#cm-shape").value;
    const lifecycle = root.querySelector("#cm-lifecycle").value;

    const build = preset[shape] ?? preset.progress;
    // `preset.*` validates and throws on a bad spec; the store assigns the id.
    let spec;
    try { spec = build({ name, sections, lifecycle }); }
    catch (e) { ui.notifications?.error(`Clocks: ${e.message}`); return; }

    await this._guard(api().create(spec));
    root.querySelector("#cm-name").value = "";
  },

  /** Every write returns null when refused or a no-op; say so rather than silently doing nothing. */
  async _guard(promise) {
    const result = await promise;
    if (result === null) ui.notifications?.warn("Clocks: that change was refused or did nothing.");
    this.render();
    return result;
  },
};

// ── Wiring ──────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  try {
    const a = api();
    if (a) a.manager = { open: () => ClockManager.open(), close: () => ClockManager.close(), toggle: () => ClockManager.toggle() };

    // Re-render off the same hooks the bar uses, so a clock changed by a
    // player, by automation, or by the other GM refreshes this window for free.
    for (const hook of [CLOCK_HOOK.CREATED, CLOCK_HOOK.CHANGED, CLOCK_HOOK.RESOLVED, CLOCK_HOOK.DISCARDED]) {
      Hooks.on(hook, () => ClockManager.render());
    }
    console.debug(CLOCK_TAG, "manager ready — FUCompanion.api.clocks.manager.open()");
  } catch (e) {
    console.warn(CLOCK_TAG, "manager bootstrap failed", e);
  }
});
