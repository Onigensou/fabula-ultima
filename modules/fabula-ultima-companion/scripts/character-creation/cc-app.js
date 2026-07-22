/**
 * Character Creation — the window.
 *
 *     FUCompanion.api.characterCreation.open()
 *
 * A full-screen parchment panel over the title scene, matching the save/load
 * UI's visual language. Six steps down a rail on the left, the active step's
 * body on the right, navigation along the bottom.
 *
 * Step modules register themselves into STEP_RENDERERS. Each one exports
 * `render(draft, ctx)` returning HTML and `bind(root, draft, ctx)` wiring its
 * own controls; the shell owns the frame, the rail, validation display and
 * navigation, and knows nothing about any individual step's content. Phase 1
 * ships the shell with placeholder bodies.
 */

import {
  CC, esc, log, warn,
} from "./cc-const.js";
import {
  createDraft, validateStep, validateAll, reconcile,
  goTo, nextStep, prevStep, stepIndex, reachableSteps,
} from "./cc-draft.js";
import { previewFolder } from "./cc-folder.js";

const ROOT_ID = "oni-cc";
const STYLE_ID = "oni-cc-styles";

/** Step id -> { render(draft, ctx) => html, bind(root, draft, ctx) } */
export const STEP_RENDERERS = new Map();

const BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound";
const SFX = {
  step: `${BASE}/BattleCursor_4.wav`,
  forward: `${BASE}/file_selector_screen.wav`,
  back: `${BASE}/bond_cleared.wav`,
  done: `${BASE}/emotion_up.wav`,
  fail: `${BASE}/Soundboard/Buzzer2.ogg`,
};
const sfx = (k) => { try { AudioHelper?.play({ src: SFX[k], volume: 0.4, loop: false }); } catch {} };

const CSS = `
  #${ROOT_ID} {
    position: fixed; inset: 0; z-index: 1010;
    background: rgba(18, 8, 1, 0.78);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    display: flex; align-items: center; justify-content: center;
    font-family: 'Lucida Console', 'Courier New', monospace;
    user-select: none;
  }
  .cc-panel {
    position: relative;
    width: min(1180px, 94vw); height: min(780px, 92vh);
    background: linear-gradient(168deg, #f8f0d4 0%, #f0e3b8 45%, #e8d8a4 100%);
    border: 2px solid #c9a44a;
    box-shadow:
      0 0 0 3px #7a4e20, 0 0 0 6px #b8865a, 0 0 0 8px #5c3210,
      0 0 80px rgba(0,0,0,0.70), inset 0 1px 0 rgba(255,245,200,0.70);
    border-radius: 4px;
    display: grid; grid-template-rows: auto 1fr auto;
    animation: cc-in 0.22s cubic-bezier(0.22, 1, 0.36, 1) both;
    overflow: hidden;
  }
  .cc-panel::before {
    content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 0;
    background: repeating-linear-gradient(0deg, transparent, transparent 23px,
      rgba(140,90,30,0.04) 23px, rgba(140,90,30,0.04) 24px);
  }
  .cc-panel > * { position: relative; z-index: 1; }
  @keyframes cc-in { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: none; } }

  /* header */
  .cc-head {
    padding: 18px 28px 14px; border-bottom: 1px solid rgba(140,90,30,0.28);
    display: flex; align-items: baseline; justify-content: space-between;
  }
  .cc-title { font-size: 19px; letter-spacing: 7px; color: #3a1e06; text-transform: uppercase; }
  .cc-sub   { font-size: 10px; letter-spacing: 2px; color: #8a6432; }

  /* body: rail + content */
  .cc-body { display: grid; grid-template-columns: 232px 1fr; min-height: 0; }
  .cc-rail {
    border-right: 1px solid rgba(140,90,30,0.28);
    padding: 16px 12px; display: flex; flex-direction: column; gap: 4px;
    overflow-y: auto;
  }
  .cc-rail-item {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 12px; border-radius: 3px; cursor: pointer;
    font-size: 11px; letter-spacing: 2px; color: #7a5428;
    border: 1px solid transparent; background: transparent;
    text-align: left; width: 100%;
    transition: background .12s, color .12s, border-color .12s;
  }
  .cc-rail-item:hover:not(.is-locked) { background: rgba(201,164,74,0.16); color: #3a1e06; }
  .cc-rail-item.is-active {
    background: rgba(201,164,74,0.30); color: #3a1e06;
    border-color: rgba(140,90,30,0.45);
  }
  .cc-rail-item.is-locked { opacity: 0.35; cursor: default; }
  .cc-rail-n {
    flex: 0 0 22px; height: 22px; border-radius: 50%;
    border: 1px solid #c4a260; display: grid; place-items: center;
    font-size: 10px; background: rgba(255,250,230,0.55);
  }
  .cc-rail-item.is-done .cc-rail-n { background: #c9a22a; border-color: #a07818; color: #fff; }
  .cc-rail-item.is-invalid .cc-rail-n { border-color: #a33; color: #a33; }

  .cc-content { padding: 20px 26px; overflow-y: auto; min-height: 0; }
  .cc-step-title { font-size: 15px; letter-spacing: 4px; color: #3a1e06; margin-bottom: 4px; }
  .cc-step-hint  { font-size: 10px; letter-spacing: 1px; color: #8a6432; margin-bottom: 18px; }
  .cc-placeholder {
    border: 1px dashed rgba(140,90,30,0.45); border-radius: 3px;
    padding: 40px; text-align: center; color: #9b7040;
    font-size: 11px; letter-spacing: 2px;
  }

  /* issues */
  .cc-issues { margin-top: 16px; display: flex; flex-direction: column; gap: 5px; }
  .cc-issue {
    font-size: 10px; letter-spacing: 1px; color: #8c2f2f;
    background: rgba(160,50,50,0.09); border-left: 2px solid #a33;
    padding: 6px 10px; border-radius: 2px;
  }
  .cc-note {
    font-size: 10px; letter-spacing: 1px; color: #7a5428;
    background: rgba(201,164,74,0.16); border-left: 2px solid #c9a44a;
    padding: 6px 10px; border-radius: 2px;
  }

  /* footer */
  .cc-foot {
    padding: 14px 28px; border-top: 1px solid rgba(140,90,30,0.28);
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .cc-foot-info { font-size: 10px; letter-spacing: 1px; color: #8a6432; }
  .cc-btns { display: flex; gap: 10px; }
  .cc-btn {
    font-family: inherit; font-size: 11px; letter-spacing: 3px; text-transform: uppercase;
    padding: 9px 22px; border-radius: 2px; cursor: pointer;
    color: #3a1e06; background: linear-gradient(155deg, #fdf6e0 0%, #e8d8a4 100%);
    border: 1px solid #c4a260;
    transition: background .12s, box-shadow .12s, opacity .12s;
  }
  .cc-btn:hover:not(:disabled) { background: linear-gradient(155deg, #fffbe8 0%, #f0e3b8 100%);
    box-shadow: 0 0 12px rgba(201,164,74,0.45); }
  .cc-btn:disabled { opacity: 0.4; cursor: default; }
  .cc-btn.is-primary { background: linear-gradient(155deg, #d8b34a 0%, #b8912c 100%); color: #2a1500; }
  .cc-btn.is-ghost   { background: transparent; border-color: rgba(140,90,30,0.4); }

  /* Shared atoms. These live in the app sheet rather than a step's inline
     <style> because the step body is re-rendered wholesale on every nav, which
     would take any step-local rules with it the moment another step used them. */
  .cc-tag {
    font-size: 8px; letter-spacing: 1px; text-transform: uppercase;
    padding: 2px 7px; border-radius: 8px; color: #6b4a1c;
    background: rgba(201,164,74,0.24); border: 1px solid rgba(140,90,30,0.3);
  }
  .cc-search {
    font-family: inherit; font-size: 11px; color: #2e1c08; padding: 6px 9px;
    background: rgba(255,252,240,0.72); border: 1px solid rgba(140,90,30,0.38); border-radius: 2px;
  }
  .cc-search:focus { outline: none; border-color: #c9a44a; }
`;

class CharacterCreationApp {
  constructor() {
    this._el = null;
    this._draft = null;
    this._notes = [];       // transient reconcile output, cleared on next nav
    this._keyFn = this._onKey.bind(this);
  }

  get draft() { return this._draft; }

  // ── lifecycle ────────────────────────────────────────────────────────────

  open({ draft = null } = {}) {
    if (this._el) return;
    this._injectCSS();
    this._draft = draft ?? createDraft();
    this._notes = [];

    // Steps may keep transient view state outside the draft (which class pane
    // is open, a search box, a half-answered prompt). None of it should survive
    // into the next character, so every step gets a chance to clear it here.
    for (const r of STEP_RENDERERS.values()) { try { r.reset?.(); } catch (e) { warn("step reset failed:", e); } }

    this._el = document.createElement("div");
    this._el.id = ROOT_ID;
    document.body.appendChild(this._el);
    document.addEventListener("keydown", this._keyFn, { capture: true });
    this._render();
    log("opened");
  }

  close() {
    if (!this._el) return;
    this._el.remove();
    this._el = null;
    document.removeEventListener("keydown", this._keyFn, { capture: true });
    log("closed");
  }

  _injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /**
   * Context handed to every step renderer.
   *
   * `edit` vs `touch` matters. The shell re-renders by replacing innerHTML, so
   * calling `edit` from an input's `input` event destroys the node the player is
   * typing into and drops the caret after one character. Text fields therefore
   * use `touch` (mutate, no render) while typing and `edit` on `change`/blur,
   * where a re-render is both safe and needed to re-run reconciliation.
   */
  _ctx() {
    return {
      app: this,
      refresh: () => this._render(),

      /** Mutate + reconcile + re-render. For structural changes. */
      edit: (fn) => {
        fn(this._draft);
        const { trimmed, warnings } = reconcile(this._draft);
        this._notes = [
          ...trimmed.map((t) => `Cleared: ${t}.`),
          ...warnings,
        ];
        this._render();
      },

      /** Mutate only — no reconcile, no re-render. For live typing. */
      touch: (fn) => { fn(this._draft); },

      /** Refresh just the footer, so `touch` edits can still show up there. */
      syncFoot: () => {
        const el = this._el?.querySelector(".cc-foot-info");
        if (el) el.textContent = this._footInfo();
      },
    };
  }

  // ── render ───────────────────────────────────────────────────────────────

  _render() {
    if (!this._el) return;
    const d = this._draft;
    const step = CC.STEPS.find((s) => s.id === d.step) ?? CC.STEPS[0];

    this._el.innerHTML = `
      <div class="cc-panel">
        <div class="cc-head">
          <div class="cc-title">Create Character</div>
          <div class="cc-sub">${esc(this._destinationLabel())}</div>
        </div>
        <div class="cc-body">
          <div class="cc-rail">${this._railHTML()}</div>
          <div class="cc-content">
            <div class="cc-step-title">${esc(step.label)}</div>
            <div class="cc-step-hint">Step ${step.n} of ${CC.STEPS.length}</div>
            ${this._stepBodyHTML(step)}
            ${this._issuesHTML(step)}
          </div>
        </div>
        <div class="cc-foot">
          <div class="cc-foot-info">${esc(this._footInfo())}</div>
          <div class="cc-btns">
            <button class="cc-btn is-ghost" data-act="cancel">Cancel</button>
            <button class="cc-btn" data-act="back" ${stepIndex(d.step) === 0 ? "disabled" : ""}>Back</button>
            ${this._forwardBtnHTML(step)}
          </div>
        </div>
      </div>`;

    this._bind(step);
  }

  _railHTML() {
    const d = this._draft;
    const reachable = reachableSteps(d);
    return CC.STEPS.map((s) => {
      const active = s.id === d.step;
      const locked = !reachable.includes(s.id);
      const seen = d.seen.includes(s.id);
      // Only judge a step the player has actually visited — flagging step 5 red
      // while they are still on step 1 is noise, not information.
      const invalid = seen && !active && s.id !== "summary" && !validateStep(d, s.id).ok;
      const cls = [
        "cc-rail-item",
        active ? "is-active" : "",
        locked ? "is-locked" : "",
        seen && !invalid && !active ? "is-done" : "",
        invalid ? "is-invalid" : "",
      ].filter(Boolean).join(" ");
      return `<button class="${cls}" data-act="goto" data-step="${s.id}" ${locked ? "disabled" : ""}>
        <span class="cc-rail-n">${invalid ? "!" : s.n}</span>
        <span>${esc(s.label)}</span>
      </button>`;
    }).join("");
  }

  _stepBodyHTML(step) {
    const r = STEP_RENDERERS.get(step.id);
    if (!r?.render) {
      return `<div class="cc-placeholder">— ${esc(step.label)} —<br><br>Not built yet.</div>`;
    }
    try {
      return r.render(this._draft, this._ctx());
    } catch (e) {
      console.error("[ONI][CharCreate] step render failed:", step.id, e);
      return `<div class="cc-placeholder">This step failed to draw.<br><br>${esc(e?.message ?? e)}</div>`;
    }
  }

  _issuesHTML(step) {
    const parts = [];
    for (const n of this._notes) parts.push(`<div class="cc-note">${esc(n)}</div>`);
    if (step.id === "summary") {
      for (const i of validateAll(this._draft).issues) {
        parts.push(`<div class="cc-issue">${esc(i.message)}</div>`);
      }
    } else if (this._draft.seen.includes(step.id)) {
      for (const i of validateStep(this._draft, step.id).issues) {
        parts.push(`<div class="cc-issue">${esc(i.message)}</div>`);
      }
    }
    return parts.length ? `<div class="cc-issues">${parts.join("")}</div>` : "";
  }

  _forwardBtnHTML(step) {
    if (step.id === "summary") {
      const ok = validateAll(this._draft).ok;
      return `<button class="cc-btn is-primary" data-act="finalize" ${ok ? "" : "disabled"}>Create</button>`;
    }
    // Forward is never blocked. A player is allowed to walk the whole wizard
    // and come back; only Finalize enforces completeness.
    return `<button class="cc-btn is-primary" data-act="next">Next</button>`;
  }

  _footInfo() {
    const d = this._draft;
    return `Level ${d.attributes.level}  ·  ${d.profile.name || "unnamed"}`;
  }

  _destinationLabel() {
    const { name, exists } = previewFolder(game.user);
    return `${game.user?.name ?? "?"} → ${name}${exists ? "" : " (will be created)"}`;
  }

  // ── navigation ───────────────────────────────────────────────────────────

  /**
   * Jump to a step by id. Exposed on the step context so a step can offer its
   * own route back — the summary's per-panel "edit" links use this rather than
   * making the player find the right stop on the rail.
   */
  goToStep(stepId) {
    if (!this._draft) return false;
    sfx("step");
    this._notes = [];
    const moved = goTo(this._draft, stepId);
    this._render();
    return moved;
  }

  // ── events ───────────────────────────────────────────────────────────────

  _bind(step) {
    const root = this._el;
    if (!root) return;

    root.querySelectorAll("[data-act='goto']").forEach((el) => {
      el.addEventListener("click", () => {
        if (el.disabled) return;
        this.goToStep(el.dataset.step);
      });
    });

    root.querySelector("[data-act='back']")?.addEventListener("click", () => {
      sfx("back"); this._notes = []; prevStep(this._draft); this._render();
    });
    root.querySelector("[data-act='next']")?.addEventListener("click", () => {
      sfx("forward"); this._notes = []; nextStep(this._draft); this._render();
    });
    root.querySelector("[data-act='cancel']")?.addEventListener("click", () => this._confirmCancel());
    root.querySelector("[data-act='finalize']")?.addEventListener("click", () => this._finalize());

    const r = STEP_RENDERERS.get(step.id);
    try { r?.bind?.(root, this._draft, this._ctx()); }
    catch (e) { console.error("[ONI][CharCreate] step bind failed:", step.id, e); }
  }

  _onKey(e) {
    if (!this._el) return;
    if (e.key === "Escape") {
      e.stopImmediatePropagation();
      e.preventDefault();
      this._confirmCancel();
    }
  }

  async _confirmCancel() {
    // Anything typed is worth one confirmation; a pristine draft is not.
    const touched = this._draft.seen.length > 1 || !!this._draft.profile.name;
    if (touched) {
      const ok = await Dialog.confirm({
        title: "Discard this character?",
        content: "<p>Nothing has been created yet. Everything entered will be lost.</p>",
        defaultYes: false,
      });
      if (!ok) return;
    }
    sfx("back");
    this.close();
  }

  async _finalize() {
    // Wired in phase 6.
    sfx("fail");
    ui.notifications?.warn("Character creation is not finished yet — finalize lands in a later phase.");
  }
}

export const app = new CharacterCreationApp();
