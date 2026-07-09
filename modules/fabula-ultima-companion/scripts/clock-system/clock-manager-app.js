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
  s.textContent = `
#${ROOT_ID} {
  --cm-players: #47b7e8; --cm-gm: #d1443c; --cm-neutral: #6c6c78; --cm-track: #2a2a30;
  --cm-plate: #16151b; --cm-plate-2: #1f1e26; --cm-ink: #f2ece1; --cm-edge: rgba(255,255,255,.10);
  position: fixed; inset: 0; z-index: 130;
  display: flex; align-items: center; justify-content: center;
  background: rgba(8,7,11,.62);
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif; color: var(--cm-ink);
  opacity: 0; transition: opacity .16s ease;
}
#${ROOT_ID}.visible { opacity: 1; }

.cm-frame {
  width: min(760px, 94vw); max-height: 88vh; display: flex; flex-direction: column;
  background: var(--cm-plate); border: 1px solid var(--cm-edge); border-radius: 12px;
  box-shadow: 0 24px 70px rgba(0,0,0,.6);
  transform: translateY(16px); transition: transform .2s cubic-bezier(.22,.8,.3,1);
}
#${ROOT_ID}.visible .cm-frame { transform: translateY(0); }

.cm-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--cm-edge); }
.cm-title { font-size: 16px; font-weight: 700; letter-spacing: .3px; }
.cm-close { margin-left: auto; cursor: pointer; opacity: .6; font-size: 18px; line-height: 1; padding: 2px 6px; }
.cm-close:hover { opacity: 1; }

.cm-body { overflow-y: auto; padding: 12px 16px 16px; }

.cm-row {
  background: var(--cm-plate-2); border: 1px solid var(--cm-edge); border-radius: 8px;
  padding: 9px 11px; margin-bottom: 9px;
}
.cm-row.resolved { opacity: .62; }
.cm-row.discarded { opacity: .38; }

.cm-row-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.cm-row-name { font-weight: 600; }
.cm-tag {
  font-size: 10px; letter-spacing: .4px; text-transform: uppercase;
  padding: 1px 5px; border-radius: 3px; background: rgba(255,255,255,.08); opacity: .8;
}
.cm-row-count { margin-left: auto; font-size: 12px; opacity: .6; font-variant-numeric: tabular-nums; }

.cm-mini { display: flex; gap: 2px; height: 10px; margin-bottom: 7px; }
.cm-mini div { flex: 1 1 0; border-radius: 2px; background: var(--cm-track); }
.cm-mini div.players { background: var(--cm-players); }
.cm-mini div.gm { background: var(--cm-gm); }
.cm-mini div.neutral { background: var(--cm-neutral); }

.cm-controls { display: flex; flex-wrap: wrap; gap: 6px; }
.cm-btn {
  cursor: pointer; user-select: none;
  font-size: 11px; padding: 3px 9px; border-radius: 5px;
  border: 1px solid var(--cm-edge); background: rgba(255,255,255,.05);
}
.cm-btn:hover { background: rgba(255,255,255,.12); }
.cm-btn.danger:hover { background: rgba(209,68,60,.32); }
.cm-btn.good:hover { background: rgba(71,183,232,.28); }
.cm-btn[disabled] { opacity: .35; pointer-events: none; }

.cm-new { border-top: 1px solid var(--cm-edge); margin-top: 4px; padding-top: 12px; }
.cm-new h3 { font-size: 12px; letter-spacing: .6px; text-transform: uppercase; opacity: .65; margin: 0 0 8px; }
.cm-fields { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 7px; align-items: center; }
.cm-fields input, .cm-fields select {
  width: 100%; box-sizing: border-box;
  background: var(--cm-plate); color: var(--cm-ink);
  border: 1px solid var(--cm-edge); border-radius: 5px; padding: 4px 7px; font-size: 12px;
}
.cm-foot { display: flex; gap: 7px; margin-top: 9px; }
.cm-empty { opacity: .5; font-size: 12px; padding: 14px 0; text-align: center; }
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
    // `preset.*` validates and would throw on a bad spec; `id` is filled in by
    // the store, so hand it a placeholder to satisfy makeClock's check.
    let spec;
    try { spec = build({ id: "pending", name, sections, lifecycle }); }
    catch (e) { ui.notifications?.error(`Clocks: ${e.message}`); return; }

    delete spec.id;
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
