/**
 * Character Creation — the window.
 *
 *     FUCompanion.api.characterCreation.open()
 *
 * Six steps, walked in order. The rail on the left is a PROGRESS INDICATOR and
 * nothing else — the only way through is Back and Next. Letting the rail jump
 * meant a player could land on a step whose inputs depended on answers they had
 * not given yet, and it was the source of a navigation bug where returning from
 * a jump left Back inert.
 *
 * Styling follows the Status and Level-Up windows rather than inventing a third
 * look: light parchment body, dark brown header bar, the shared `levelup-fx`
 * sounds and animations. Anything a player sees here should feel like the rest
 * of the game, because it is the rest of the game.
 *
 * Step modules register themselves into STEP_RENDERERS. Each exports
 * `render(draft, ctx)` returning HTML and `bind(root, draft, ctx)` wiring its
 * own controls; the shell owns the frame, the rail, validation display and
 * navigation, and knows nothing about any individual step's content.
 */

import { CC, esc, log, warn } from "./cc-const.js";
import {
  createDraft, validateStep, validateAll, reconcile,
  nextStep, prevStep, stepIndex, goTo,
} from "./cc-draft.js";
import { previewFolder } from "./cc-folder.js";
import { sfx, windowAnim, staggerRows } from "../levelup-system/levelup-fx.js";

const ROOT_ID = "oni-cc";
const STYLE_ID = "oni-cc-styles";

/** Step id -> { render(draft, ctx) => html, bind(root, draft, ctx), reset?() } */
export const STEP_RENDERERS = new Map();

/**
 * Palette lifted from attribute-app / levelup-app so the three windows read as
 * one family. Kept as a comment rather than variables because the other two
 * spell the values out too, and a shared token file that only three files use
 * is indirection without a payoff:
 *
 *   panel #efe4cd   header #5d4630→#4a371f   rows #f7f0df on #cbb890
 *   side/foot #e6dabd   rule #b79c72   ink #2f2618   accent #8a6c45
 */
const CSS = `
#${ROOT_ID} { position: fixed; inset: 0; z-index: 70; display: flex;
  align-items: center; justify-content: center; background: rgba(0,0,0,.55); }
#${ROOT_ID} * { box-sizing: border-box; }
#${ROOT_ID} .cc-panel { width: min(1080px, 95vw); height: min(760px, 92vh);
  display: flex; flex-direction: column; border-radius: 10px; overflow: hidden;
  background: #efe4cd; border: 2px solid #6b543a;
  box-shadow: 0 18px 60px rgba(0,0,0,.55);
  font-family: Signika, sans-serif; color: #2f2618; }

/* ── header ── */
#${ROOT_ID} .cc-head { display: flex; align-items: center; gap: 12px; padding: 10px 14px;
  background: linear-gradient(180deg,#5d4630,#4a371f); color: #f6ecd8; flex: 0 0 auto; }
#${ROOT_ID} .cc-idblock { flex: 1 1 auto; min-width: 0; }
#${ROOT_ID} .cc-title { font-size: 17px; font-weight: 800; }
#${ROOT_ID} .cc-sub { font-size: 11.5px; opacity: .8; }
#${ROOT_ID} .cc-stepchip { padding: 3px 11px; border-radius: 12px; font-size: 12px; font-weight: 700;
  background: linear-gradient(180deg,#f0d99a,#e0c179); color: #4b3517; border: 1px solid #8a6c45;
  white-space: nowrap; }
#${ROOT_ID} .cc-x { background: none; border: 0; color: #f6ecd8; font-size: 20px; line-height: 1;
  cursor: pointer; padding: 0 4px; width: auto; }

/* ── body ── */
#${ROOT_ID} .cc-body { display: flex; flex: 1 1 auto; min-height: 0; }
#${ROOT_ID} .cc-rail { flex: 0 0 auto; width: 208px; padding: 12px; display: flex;
  flex-direction: column; gap: 6px; background: #e6dabd; border-right: 1px solid #b79c72;
  overflow-y: auto; }
#${ROOT_ID} .cc-content { flex: 1 1 auto; min-width: 0; padding: 14px 16px;
  overflow-y: auto; display: flex; flex-direction: column; }

/* The rail goes BACKWARDS only. A passed step is a link; anything ahead is
   dimmed and inert, because a later step is built on answers the earlier ones
   have not given yet. */
#${ROOT_ID} .cc-rail-item { display: flex; align-items: center; gap: 9px; padding: 7px 9px;
  border-radius: 8px; background: #f7f0df; border: 1px solid #cbb890;
  font-size: 12.5px; color: #6b5a3e; cursor: default; }
#${ROOT_ID} .cc-rail-item.is-link { cursor: pointer; }
#${ROOT_ID} .cc-rail-item.is-link:hover { background: #fdf6e4; border-color: #8a6c45; color: #2f2618; }
#${ROOT_ID} .cc-rail-item.is-active { border-color: #8a6c45; background: #fdf6e4;
  color: #2f2618; font-weight: 700; box-shadow: inset 0 0 0 1px rgba(240,217,154,.7); }
#${ROOT_ID} .cc-rail-item.is-ahead { opacity: .45; }
#${ROOT_ID} .cc-rail-n { flex: 0 0 22px; height: 22px; border-radius: 50%;
  border: 1px solid #b79c72; display: grid; place-items: center;
  font-size: 11px; font-weight: 700; background: #efe4cd; }
#${ROOT_ID} .cc-rail-item.is-done .cc-rail-n { background: linear-gradient(180deg,#5f9e4a,#3f7a30);
  border-color: #2f6b2f; color: #fff; }
#${ROOT_ID} .cc-rail-item.is-active .cc-rail-n { background: linear-gradient(180deg,#f0d99a,#e0c179);
  border-color: #8a6c45; color: #4b3517; }
#${ROOT_ID} .cc-rail-item.is-invalid .cc-rail-n { background: #c9736a; border-color: #a3453a; color: #fff; }

#${ROOT_ID} .cc-step-title { font-size: 15px; font-weight: 800; margin-bottom: 2px; }
#${ROOT_ID} .cc-step-hint { font-size: 12px; opacity: .7; margin-bottom: 12px; }
#${ROOT_ID} .cc-stepbody { flex: 1 1 auto; min-height: 0; }
#${ROOT_ID} .cc-placeholder { padding: 40px; text-align: center; opacity: .6; font-size: 13px; }

/* ── notes and issues ── */
#${ROOT_ID} .cc-issues { margin-top: 12px; display: flex; flex-direction: column; gap: 5px;
  flex: 0 0 auto; }
#${ROOT_ID} .cc-issue { font-size: 12px; color: #8c3a24; padding: 6px 10px; border-radius: 7px;
  background: rgba(165,42,26,.09); border: 1px solid rgba(165,42,26,.35); }
#${ROOT_ID} .cc-note { font-size: 12px; color: #6b4a1c; padding: 6px 10px; border-radius: 7px;
  background: rgba(240,217,154,.35); border: 1px solid #cbb890; }

/* ── footer ── */
#${ROOT_ID} .cc-foot { display: flex; align-items: center; gap: 9px; padding: 9px 14px;
  background: #e6dabd; border-top: 2px solid #b79c72; flex: 0 0 auto; min-height: 46px; }
#${ROOT_ID} .cc-foot-info { font-size: 12px; opacity: .8; }
#${ROOT_ID} .cc-spacer { flex: 1 1 auto; }
#${ROOT_ID} .cc-btn { padding: 6px 16px; border-radius: 7px; cursor: pointer; font-weight: 700;
  font-family: inherit; font-size: 13px;
  border: 1px solid #8a6c45; background: linear-gradient(180deg,#f7edd5,#e6d6b0); color: #3b2a17; }
#${ROOT_ID} .cc-btn:hover:not(:disabled) { background: linear-gradient(180deg,#f0d99a,#e0c179); }
#${ROOT_ID} .cc-btn:disabled { opacity: .35; cursor: default; }
#${ROOT_ID} .cc-btn.is-primary { background: linear-gradient(180deg,#5f9e4a,#3f7a30); color: #fff;
  border-color: #2f6b2f; }
#${ROOT_ID} .cc-btn.is-primary:hover:not(:disabled) { background: linear-gradient(180deg,#6cb154,#478a37); }
#${ROOT_ID} .cc-btn.is-ghost { background: none; border-color: #b79c72; }

/* ── shared atoms ──
   These live in the app sheet rather than a step's inline <style> because the
   step body is re-rendered wholesale on every nav, which would take any
   step-local rules with it the moment another step used them. */
#${ROOT_ID} .cc-tag { font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 9px;
  color: #6b4a1c; background: rgba(240,217,154,.55); border: 1px solid #cbb890; }
#${ROOT_ID} .cc-input, #${ROOT_ID} .cc-search { font-family: inherit; font-size: 13px;
  color: #2f2618; padding: 6px 9px; border-radius: 7px;
  background: #f7f0df; border: 1px solid #cbb890; }
#${ROOT_ID} .cc-input:focus, #${ROOT_ID} .cc-search:focus { outline: none; border-color: #8a6c45;
  background: #fdf6e4; }
/* Placeholders must read as EXAMPLES, not as answers already given. */
#${ROOT_ID} .cc-input::placeholder, #${ROOT_ID} .cc-search::placeholder { color: #2f2618; opacity: .32; }
#${ROOT_ID} .cc-label { display: block; font-size: 11px; font-weight: 700; letter-spacing: .04em;
  text-transform: uppercase; opacity: .65; margin-bottom: 4px; }
#${ROOT_ID} .cc-empty { padding: 24px; text-align: center; opacity: .7; font-size: 13px; }
`;

class CharacterCreationApp {
  constructor() {
    this._el = null;
    this._draft = null;
    this._notes = [];       // transient reconcile output, cleared on next nav
    this._creating = false; // finalize in flight — survives re-render, unlike `disabled`
    this._closing = false;
    this._keyFn = this._onKey.bind(this);
  }

  get draft() { return this._draft; }
  get isOpen() { return !!this._el; }

  // ── lifecycle ────────────────────────────────────────────────────────────

  open({ draft = null } = {}) {
    // Re-opening while already open is a no-op rather than a second window.
    if (this._el) return;
    this._injectCSS();
    this._draft = draft ?? createDraft();
    this._notes = [];
    this._creating = false;

    // Steps may keep transient view state outside the draft (which class pane
    // is open, a search box, a half-answered prompt). None of it should survive
    // into the next character, so every step gets a chance to clear it here.
    for (const r of STEP_RENDERERS.values()) {
      try { r.reset?.(); } catch (e) { warn("step reset failed:", e); }
    }

    this._el = document.createElement("div");
    this._el.id = ROOT_ID;
    document.body.appendChild(this._el);
    this._el.addEventListener("mousedown", (ev) => {
      // Clicking the backdrop is a cancel, and cancel always confirms.
      if (ev.target === this._el) this._confirmCancel();
    });
    document.addEventListener("keydown", this._keyFn, { capture: true });
    this._render();
    windowAnim(this._el.querySelector(".cc-panel"), "in");
    sfx("open");
    log("opened");
  }

  async close() {
    if (!this._el || this._closing) return;
    this._closing = true;
    sfx("close");
    await windowAnim(this._el?.querySelector(".cc-panel"), "out");
    this._closing = false;
    this._el?.remove();
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
        this._notes = [...trimmed.map((t) => `Cleared: ${t}.`), ...warnings];
        this._render();
      },

      /** Mutate only — no reconcile, no re-render. For live typing. */
      touch: (fn) => { fn(this._draft); },

      /** Refresh just the footer text, so `touch` edits can still show up there. */
      syncFoot: () => {
        const el = this._el?.querySelector(".cc-foot-info");
        if (el) el.textContent = this._footInfo();
      },

      /**
       * Redraw the footer and rail WITHOUT touching the step body.
       *
       * A step that hosts something expensive — the class panel mounts the
       * whole level-up window and owns its own scroll position — cannot afford
       * a full re-render every time a point is spent. This updates the parts
       * the shell owns (whether Next is live, what the rail shows) and leaves
       * the body exactly where it is.
       */
      syncNav: () => {
        if (!this._el) return;
        const foot = this._el.querySelector(".cc-foot");
        const rail = this._el.querySelector(".cc-rail");
        const step = CC.STEPS.find((s) => s.id === this._draft.step) ?? CC.STEPS[0];
        if (foot) {
          foot.innerHTML = `
            <div class="cc-foot-info">${esc(this._footInfo())}</div>
            <div class="cc-spacer"></div>
            <button class="cc-btn is-ghost" data-act="cancel">Cancel</button>
            ${this._backBtnHTML()}
            ${this._forwardBtnHTML(step)}`;
        }
        if (rail) rail.innerHTML = this._railHTML();
        this._bindChrome();
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
          <div class="cc-idblock">
            <div class="cc-title">Create Character</div>
            <div class="cc-sub">${esc(this._destinationLabel())}</div>
          </div>
          <div class="cc-stepchip">Step ${step.n} of ${CC.STEPS.length}</div>
          <button class="cc-x" data-act="cancel" title="Close">×</button>
        </div>
        <div class="cc-body">
          <div class="cc-rail">${this._railHTML()}</div>
          <div class="cc-content">
            <div class="cc-step-title">${esc(step.label)}</div>
            <div class="cc-step-hint">${esc(STEP_HINT[step.id] ?? "")}</div>
            <div class="cc-stepbody">${this._stepBodyHTML(step)}</div>
            ${this._issuesHTML(step)}
          </div>
        </div>
        <div class="cc-foot">
          <div class="cc-foot-info">${esc(this._footInfo())}</div>
          <div class="cc-spacer"></div>
          <button class="cc-btn is-ghost" data-act="cancel">Cancel</button>
          ${this._backBtnHTML()}
          ${this._forwardBtnHTML(step)}
        </div>
      </div>`;

    staggerRows(this._el.querySelectorAll(".cc-rail-item"), "in");
    this._bind(step);
  }

  /** How far along the player has been. Steps up to here have all been passed. */
  _furthest() {
    return Math.max(...this._draft.seen.map(stepIndex), 0);
  }

  /**
   * May the player leave the step they are on?
   *
   * Only a step they have ALREADY PASSED can trap them, and only by being
   * broken now: going back to fix your level and deleting the name on the way
   * would otherwise let you wander off leaving the character unnamed and the
   * problem five pages behind you. A step never yet passed is simply
   * unfinished, and Back stays free so an early mistake is still escapable.
   */
  _exitBlock() {
    const d = this._draft;
    const step = d.step;
    if (step === "summary") return null;
    if (stepIndex(step) >= this._furthest()) return null;   // never passed it
    const { ok, issues } = validateStep(d, step);
    return ok ? null : (issues[0]?.message ?? "Finish this step before leaving it.");
  }

  /**
   * The rail.
   *
   * Clickable for steps already passed, so a player can jump back to fix
   * something rather than walking the whole road. It is NOT a way forward —
   * anything ahead stays dimmed and inert, because a later step is built on
   * answers the earlier ones have not given yet.
   */
  _railHTML() {
    const d = this._draft;
    const here = stepIndex(d.step);
    const furthest = this._furthest();
    const stuck = this._exitBlock();

    return CC.STEPS.map((s, i) => {
      const active = i === here;
      const passed = i <= furthest;
      // Only judge a step the player has actually left — flagging step 5 red
      // while they are still on step 1 is noise, not information.
      const invalid = i < here && s.id !== "summary" && !validateStep(d, s.id).ok;
      // While the current step is broken, every other stop is out of reach.
      const reachable = passed && !active && !stuck;

      const cls = [
        "cc-rail-item",
        active ? "is-active" : "",
        i > furthest ? "is-ahead" : "",
        i < here && !invalid ? "is-done" : "",
        invalid ? "is-invalid" : "",
        reachable ? "is-link" : "",
      ].filter(Boolean).join(" ");

      const title = reachable ? `Back to ${s.label}`
        : active ? (stuck ?? "")
        : i > furthest ? "Not reached yet"
        : stuck ?? "";

      return `<div class="${cls}" ${reachable ? `data-act="rail" data-step="${s.id}"` : ""}
                   title="${esc(title)}">
        <span class="cc-rail-n">${i < here && !invalid ? "✓" : invalid ? "!" : s.n}</span>
        <span>${esc(s.label)}</span>
      </div>`;
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

  /**
   * Notes and outstanding problems.
   *
   * A step is only criticised once the player has been PAST it. On a first
   * visit an empty form is not a mistake, it is a form — telling someone their
   * unnamed character needs a name before they have had a chance to type is
   * noise, and the disabled Next already says so on hover. Coming back to a
   * step means something needs fixing, and then the reason is worth spelling
   * out.
   */
  _issuesHTML(step) {
    const parts = [];
    for (const n of this._notes) parts.push(`<div class="cc-note">${esc(n)}</div>`);

    const furthest = Math.max(...this._draft.seen.map(stepIndex), 0);
    const beenPast = stepIndex(step.id) < furthest;

    if (step.id === "summary") {
      for (const i of validateAll(this._draft).issues) {
        parts.push(`<div class="cc-issue">${esc(i.message)}</div>`);
      }
    } else if (beenPast) {
      for (const i of validateStep(this._draft, step.id).issues) {
        parts.push(`<div class="cc-issue">${esc(i.message)}</div>`);
      }
    }
    return parts.length ? `<div class="cc-issues">${parts.join("")}</div>` : "";
  }

  /**
   * Forward is BLOCKED until the current step is complete.
   *
   * A later step is usually built on an earlier one's answers — the point pool
   * comes from the level, the martial rules come from the classes — so walking
   * past an unfinished step produces a page that cannot be filled in correctly
   * and an error message with no obvious cause. The button carries the reason
   * as its tooltip, and the issue itself is already listed under the step.
   */
  /**
   * Back is free EXCEPT out of a step the player has already passed and has
   * since broken — see `_exitBlock`. On a step never yet passed it always
   * works, so an early mistake is still escapable.
   */
  _backBtnHTML() {
    const first = stepIndex(this._draft.step) === 0;
    const stuck = this._exitBlock();
    const off = first || !!stuck;
    return `<button class="cc-btn" data-act="back" ${off ? "disabled" : ""}
      title="${esc(first ? "This is the first step" : stuck ?? "Back")}">Back</button>`;
  }

  _forwardBtnHTML(step) {
    if (step.id === "summary") {
      if (this._creating) return `<button class="cc-btn is-primary" disabled>Creating…</button>`;
      const { ok, issues } = validateAll(this._draft);
      return `<button class="cc-btn is-primary" data-act="finalize" ${ok ? "" : "disabled"}
        title="${esc(ok ? "Create this character" : issues[0]?.message ?? "Not finished yet")}">Create</button>`;
    }
    const { ok, issues } = validateStep(this._draft, step.id);
    return `<button class="cc-btn is-primary" data-act="next" ${ok ? "" : "disabled"}
      title="${esc(ok ? "Continue" : issues[0]?.message ?? "Finish this step first")}">Next</button>`;
  }

  _footInfo() {
    const d = this._draft;
    return `Level ${d.attributes.level}  ·  ${d.profile.name || "unnamed"}`;
  }

  _destinationLabel() {
    const { name, exists } = previewFolder(game.user);
    return `${game.user?.name ?? "?"} → ${name}${exists ? "" : " (will be created)"}`;
  }

  // ── events ───────────────────────────────────────────────────────────────

  /**
   * Leave the current step.
   *
   * A step may have raised something outside the wizard's own DOM — the class
   * browser mounts its own full-screen host — and that must come down before
   * the player is somewhere else looking at it.
   */
  _leaveCurrent() {
    const r = STEP_RENDERERS.get(this._draft?.step);
    try { r?.leave?.(); } catch (e) { warn("step leave failed:", e); }
  }

  /**
   * Wire the frame — rail and footer.
   *
   * Split out from `_bind` because `syncNav` redraws exactly these two and has
   * to reattach their handlers without disturbing the step body.
   */
  _bindChrome() {
    const root = this._el;
    if (!root) return;

    root.querySelector("[data-act='back']")?.addEventListener("click", (ev) => {
      if (ev.currentTarget.disabled) return;
      sfx("stageDown");
      this._leaveCurrent();
      this._notes = []; prevStep(this._draft); this._render();
    });
    root.querySelector("[data-act='next']")?.addEventListener("click", (ev) => {
      if (ev.currentTarget.disabled) return;
      sfx("tab");
      this._leaveCurrent();
      this._notes = []; nextStep(this._draft); this._render();
    });
    root.querySelectorAll("[data-act='rail']").forEach((el) => {
      el.addEventListener("click", () => {
        sfx("cursor");
        this._leaveCurrent();
        this._notes = [];
        goTo(this._draft, el.dataset.step);
        this._render();
      });
    });

    root.querySelectorAll("[data-act='cancel']").forEach((el) =>
      el.addEventListener("click", () => this._confirmCancel()));
    root.querySelector("[data-act='finalize']")?.addEventListener("click", () => this._finalize());
  }

  _bind(step) {
    const root = this._el;
    if (!root) return;

    this._bindChrome();

    const r = STEP_RENDERERS.get(step.id);
    try { r?.bind?.(root, this._draft, this._ctx()); }
    catch (e) { console.error("[ONI][CharCreate] step bind failed:", step.id, e); }
  }

  _onKey(e) {
    if (!this._el) return;
    if (e.key !== "Escape") return;
    // A step may have raised something over the wizard (the class browser).
    // Escape closes that first — cancelling the whole character because a
    // sub-window was open would be a nasty surprise.
    const r = STEP_RENDERERS.get(this._draft?.step);
    if (r?.escape?.()) {
      e.stopImmediatePropagation();
      e.preventDefault();
      this._render();
      return;
    }
    e.stopImmediatePropagation();
    e.preventDefault();
    this._confirmCancel();
  }

  async _confirmCancel() {
    if (this._creating) return;   // a write is in flight; closing now proves nothing
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
    this.close();
  }

  /**
   * Create the character.
   *
   * Guarded against a double submit: the request goes to the GM and takes as
   * long as the spends take, and a second click would build a second character
   * from the same draft. The button is disabled for the duration and the
   * in-flight flag survives a re-render, which the disabled attribute would not.
   */
  async _finalize() {
    if (this._creating) return;

    const check = validateAll(this._draft);
    if (!check.ok) {
      ui.notifications?.warn(check.issues[0]?.message ?? "This character is not finished yet.");
      return;
    }

    this._creating = true;
    this._render();

    let res;
    try {
      // Imported here rather than at the top so the shell does not depend on
      // the write path: cc-api pulls in the level-up system, and a step module
      // importing the shell must not drag all of that in with it.
      const { createCharacter } = await import("./cc-api.js");
      res = await createCharacter(this._draft);
    } catch (e) {
      console.error("[ONI][CharCreate] finalize threw:", e);
      res = { ok: false, reason: "error", message: String(e?.message ?? e) };
    } finally {
      this._creating = false;
    }

    if (res?.ok) {
      sfx("levelUp");
      ui.notifications?.info(`${res.name} created in ${res.folder ?? "your folder"}.`);
      await this.close();
      // Open the new sheet so the player lands on the character they just made.
      try { (await fromUuid(res.actorUuid))?.sheet?.render(true); }
      catch (e) { console.warn("[ONI][CharCreate] could not open the new sheet:", e); }
      return;
    }

    sfx("levelDown");
    this._notes = [describeFailure(res)];
    this._render();
    ui.notifications?.error(this._notes[0]);
  }
}

/** One line under each step title, so the step explains itself. */
const STEP_HINT = Object.freeze({
  profile: "Who is this character?",
  attributes: "Pick a starting spread, then set the level.",
  classes: "Spend your Skill Points on classes and their skills.",
  equipment: "Buy starting gear against your zenit.",
  bond: "Optional — one Bond your character already carries.",
  summary: "Check everything, then create.",
});

/** Turn a finalize failure into something a player can act on. */
export function describeFailure(res) {
  const reason = res?.reason ?? "unknown";
  switch (reason) {
    case "gate_closed":
      return "Characters can only be created from the title screen or at camp.";
    case "missing_seed":
      return `This world is missing the blank character template ("${CC.BLANK_PC_NAME}"). Ask your GM.`;
    case "timeout":
      return "The GM did not answer in time. Nothing was created — try again.";
    case "invalid_draft":
      return res.issues?.[0]?.message ?? "Something about this character is not valid.";
    case "finalize_failed":
      // The half-built actor is normally deleted; say so, because "it failed"
      // and "it failed and left a broken character behind" need different
      // responses from the player.
      return res.rolledBack === false
        ? `Creation failed and the partial character (${res.orphanId}) could not be removed — tell your GM. (${res.message})`
        : `Creation failed and was rolled back — nothing was kept. (${res.message})`;
    default:
      return `Creation failed: ${reason}${res?.message ? ` — ${res.message}` : ""}`;
  }
}

export const app = new CharacterCreationApp();
