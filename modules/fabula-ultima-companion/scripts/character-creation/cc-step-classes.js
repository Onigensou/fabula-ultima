/**
 * Character Creation — step 3: Class & Skills.
 *
 * THE LEVEL-UP WINDOW, RAISED AS A SUB-WINDOW.
 *
 * Not a copy of it, not a lookalike, and NOT squeezed into a pane — that
 * window is built for a full screen and reads badly at wizard size. It is
 * raised over the wizard at its own dimensions, exactly as it appears
 * mid-campaign, with its class browser and facet picker layering inside it as
 * designed. levelup-app scopes every rule under `#oni-levelup`, so the host
 * simply carries that id and needs no override at all.
 *
 * The wizard remains the manager: it owns the draft, it decides when the
 * sub-window opens, and it will not let the step be passed until the pool is
 * spent. The step body is a standing summary of what has been chosen and the
 * way back in.
 *
 * The seam is one method. `LevelUpApp._readState()` returns either
 * `getState(actorUuid)` or, when `_stateSource` is set, whatever that returns —
 * here a `getState`-shaped view of the draft (`cc-class-state.js`).
 *
 * WHAT DIFFERS IS ONLY WHAT A CLICK MEANS
 * ---------------------------------------
 * There is no actor to stage against, so spends and refunds edit the draft
 * directly and the Confirm bar never appears (`_footer` returns nothing while
 * `_pending` is empty). Refunds are free, and a class can be dropped outright —
 * mid-campaign a class is given back a level at a time at a Forget me Nut each,
 * because it has been played; a class picked two minutes ago and not yet
 * written is just a decision, and changing your mind should not be a chore.
 *
 * Arriving with no class raises the window on its class browser, because
 * choosing one is the first decision.
 *
 * One point buys one class level and one skill level, the same bargain the
 * level-up system makes — at finalize these picks replay through its
 * `spendPoint`, so class rows, benefit columns, facet grants and the martial
 * flags all land exactly as they do mid-campaign.
 */

import { CC, esc, num } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";
import { draftLevel, draftPointsLeft, draftPointPool, draftClassKeys } from "./cc-draft.js";
import { draftState, benefitFor } from "./cc-class-state.js";
import { LevelUpApp, injectLevelUpStyles, LEVELUP_ROOT_ID } from "../levelup-system/levelup-app.js";
import { sfx, windowAnim } from "../levelup-system/levelup-fx.js";

const MAX_CLASS_LEVEL = 10;
const MAX_UNMASTERED = 3;

// ── pure model (exported for tests) ────────────────────────────────────────

export const classLevelIn = (d, classKey) =>
  (d.classes ?? []).filter((c) => c.classKey === classKey).length;

export const skillLevelIn = (d, skillUuid) =>
  (d.classes ?? []).filter((c) => c.skillUuid === skillUuid).length;

/** Classes held that are not yet at level 10. */
export const unmasteredCount = (d) =>
  draftClassKeys(d).filter((k) => classLevelIn(d, k) < MAX_CLASS_LEVEL).length;

/**
 * May this skill take another level right now?
 * Mirrors levelup-api `validateSpend`, plus the creation-only class-count rule.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function canSpend(d, cls, skill) {
  if (draftPointsLeft(d) <= 0) return { ok: false, reason: "No Skill Points left." };

  const clsLvl = classLevelIn(d, cls.key);
  if (clsLvl >= MAX_CLASS_LEVEL) return { ok: false, reason: `${cls.name} is already mastered.` };

  const sklLvl = skillLevelIn(d, skill.uuid);
  if (sklLvl >= skill.maxLevel) {
    return { ok: false, reason: `${skill.name} is at its maximum (SL ${skill.maxLevel}).` };
  }

  const isNew = clsLvl === 0;
  if (isNew && unmasteredCount(d) >= MAX_UNMASTERED) {
    return { ok: false, reason: `No more than ${MAX_UNMASTERED} unmastered classes at once.` };
  }
  // The starting 2-3 rule only caps the TOP end here; the minimum is checked at
  // validation time, since a build in progress is legitimately below it.
  if (isNew &&
      draftLevel(d) < CC.RULE.STARTING_CLASS_RULE_BELOW_LEVEL &&
      draftClassKeys(d).length >= CC.RULE.MAX_STARTING_CLASSES) {
    return {
      ok: false,
      reason: `A character below level ${CC.RULE.STARTING_CLASS_RULE_BELOW_LEVEL} may take at most ` +
              `${CC.RULE.MAX_STARTING_CLASSES} classes.`,
    };
  }
  return { ok: true };
}

/** Does opening this class require the player to choose its benefit? */
export const needsBenefit = (d, cls) => classLevelIn(d, cls.key) === 0 && !cls.benefit;

/** Facets this pick awards, and which are still unclaimed. */
export function facetNeed(d, cls, skill) {
  const n = num(skill.facetGrant, 0);
  if (!n) return { need: 0, available: [] };
  const held = new Set((d.classes ?? []).flatMap((c) => c.facetUuids ?? []));
  return { need: n, available: (cls.facets ?? []).filter((f) => !held.has(f.uuid)) };
}

/** Append one spend. Assumes canSpend already said yes. */
export function applySpend(d, cls, skill, { benefit = null, facetUuids = [] } = {}) {
  d.classes.push({
    classKey: cls.key,
    className: cls.name,
    classImg: cls.img ?? "",
    skillUuid: skill.uuid,
    skillName: skill.name,
    // Carried on every row so finalize never has to re-derive it; the levelup
    // API ignores it on rows after the first in a class.
    benefit: benefit ?? cls.benefit ?? null,
    facetUuids: [...facetUuids],
  });
}

/**
 * Remove the most recent level of a skill.
 *
 * Last-in-first-out, because an earlier pick may be what made a later one
 * legal — unwinding out of order could leave a state the player could not have
 * built.
 */
export function removeLast(d, skillUuid) {
  for (let i = d.classes.length - 1; i >= 0; i--) {
    if (d.classes[i].skillUuid === skillUuid) { d.classes.splice(i, 1); return true; }
  }
  return false;
}

/** Give back every level taken in a class. */
export function dropClass(d, classKey) {
  const before = d.classes.length;
  d.classes = d.classes.filter((c) => c.classKey !== classKey);
  return d.classes.length !== before;
}

// ── the sub-window ─────────────────────────────────────────────────────────

let _view = null;
let _draftRef = null;
let _ctxRef = null;
let _host = null;         // the raised #oni-levelup element, while it is up
let _autoOpened = false;  // it raises itself once, on first arrival

function viewFor(d) {
  _draftRef = d;
  if (_view) return _view;

  _view = Object.create(LevelUpApp);
  Object.assign(_view, {
    _creation: true,
    _stateSource: () => draftState(_draftRef),
    _pending: [],          // the draft is the staging area; nothing queues here
    _selected: null,
    _tab: "skill",
    _resetMode: false,
    _detailMode: false,
    _actorUuid: null,
    _root: null,
    _pickerOpen: false,
    _pickSel: null,
    _pickTab: "overview",
    _facet: null,
    _benefit: null,
    _benefitChoice: new Map(),
    _details: new Map(),
    _pinned: null,
    _hover: null,
    _rowIdx: 0, _railIdx: 0, _headIdx: 0, _zone: "list",
    // Keyboard navigation draws a cursor against chrome this copy does not
    // have, so it is a no-op rather than a source of exceptions.
    _updateCursor: () => {},
  });
  // `isOpen` is an accessor on LevelUpApp, so Object.assign would try to write
  // through a getter with no setter and throw. Redefine it on the derived
  // object instead — it reports whether the sub-window is actually up.
  Object.defineProperty(_view, "isOpen", { get: () => !!_host, configurable: true });
  return _view;
}

/** Transient view state, cleared between characters. */
export const resetUiState = () => {
  closeWindow();
  _view = null;
  _autoOpened = false;
};

/** Leaving the step takes the sub-window with it. */
export const leaveStep = () => closeWindow();

export const windowIsOpen = () => !!_host;

/**
 * Escape backs out one layer at a time, never the whole wizard.
 *
 * Returning true tells the shell it was handled — the shell then re-renders,
 * which is what brings the step summary up to date after the window closes.
 */
export function escapeStep() {
  const v = _view;
  if (!v || !_host) return false;
  // Outermost first: the benefit window gates starting a class, so backing out
  // of it leaves the class unstarted rather than closing anything behind it.
  if (v._benefit) { sfx("deselect"); v._benefit = null; v.render(); return true; }
  if (v._facet) { sfx("deselect"); v._facet = null; v.render(); return true; }
  if (v._pickerOpen) { sfx("deselect"); v._pickerOpen = false; v.render(); return true; }
  sfx("close");
  closeWindow();
  return true;
}

export function closeWindow() {
  if (_view) {
    _view._root = null;
    _view._facet = null;
    _view._benefit = null;
    _view._pickerOpen = false;
    // Closing ends the session that owned the benefit choices. They are already
    // recorded on every pick, so nothing is lost — what goes is the ability to
    // change them, which is the agreed rule: editable only while still in the
    // instance that made them.
    _view._benefitChoice.clear();
  }
  _host?.remove();
  _host = null;
}

/**
 * Raise the level-up window over the wizard.
 *
 * `#oni-levelup` is `position:fixed; inset:0` with its own dim backdrop, which
 * is exactly right: this is a whole-attention screen, and covering the wizard
 * is also what stops the player stepping past it while it is open.
 */
function openWindow(ctx, { browser = false } = {}) {
  if (_host) return;
  // The real level-up window owns that id and those styles when it is open.
  if (LevelUpApp.isOpen) {
    ui.notifications?.warn("Close the Level Up window first.");
    return;
  }
  injectLevelUpStyles();
  injectCreationCSS();

  _host = document.createElement("div");
  _host.id = LEVELUP_ROOT_ID;
  _host.classList.add("cc-levelup");
  _host.style.zIndex = "71";               // above the wizard, which shares the layer
  _host.innerHTML = `<div class="lu-panel"></div>`;
  document.body.appendChild(_host);

  const v = viewFor(_draftRef);
  v._root = _host;
  if (browser) { v._pickerOpen = true; v._pickSel = null; }

  v.render();
  windowAnim(_host.querySelector(".lu-panel"), "in");
  sfx("open");

  // One delegated handler, so it survives every internal repaint.
  _host.addEventListener("click", (ev) => { void onPanelClick(ev, v, _draftRef, ctx); });
  _host.addEventListener("mousedown", (ev) => {
    // The picker's own dim backdrop closes just the picker; the window's
    // backdrop closes the window.
    if (ev.target?.classList?.contains("lu-picker")) {
      sfx("deselect"); v._pickerOpen = false; v.render();
      return;
    }
    if (ev.target === _host) { closeWindow(); ctx.refresh(); }
  });
}

/**
 * The one thing creation adds to that window's look: the drop-class ×.
 *
 * Kept here rather than in levelup-app's sheet because the affordance only
 * exists in this mode, and the rule that draws it is already guarded there.
 */
const CREATION_STYLE_ID = "oni-cc-levelup-creation";
const CREATION_CSS = `
  #${LEVELUP_ROOT_ID}.cc-levelup .lu-clsdrop {
    margin-left: 4px; padding: 0 5px; border-radius: 6px; font-size: 13px;
    line-height: 1.2; color: #8a6c45; opacity: 0;
    transition: opacity .12s, background .12s, color .12s; }
  #${LEVELUP_ROOT_ID}.cc-levelup .lu-cls:hover .lu-clsdrop { opacity: .7; }
  #${LEVELUP_ROOT_ID}.cc-levelup .lu-clsdrop:hover { opacity: 1; background: #c9736a; color: #fff; }
`;

function injectCreationCSS() {
  if (document.getElementById(CREATION_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = CREATION_STYLE_ID;
  s.textContent = CREATION_CSS;
  document.head.appendChild(s);
}

/**
 * Commit a draft change and repaint.
 *
 * NOT via `ctx.edit`: the wizard's step body is behind the sub-window, and
 * re-rendering it would be both invisible and wasteful. The sub-window
 * repaints itself; the wizard catches up when it closes.
 */
function commit(fn) {
  fn(_draftRef);
  _view?.render();
}

/**
 * Open the real facet picker for a spend that grants facets.
 *
 * Reuses levelup-app's own `_facet` shape and overlay. `editIndex` is always
 * -1: there is no `_pending` queue to edit into, and revising a choice here
 * means giving the level back and retaking it, which costs nothing before
 * anything is written.
 */
function openFacetPicker(v, d, cls, skill, benefit) {
  const { need, available } = facetNeed(d, cls, skill);
  if (!need || !available.length) return false;

  v._facet = {
    act: "spend", classKey: cls.key, skillUuid: skill.uuid, editIndex: -1,
    className: cls.name, skillName: skill.name,
    need: Math.min(need, available.length),
    pool: available.map((f) => ({
      uuid: f.uuid, name: f.name, cost: f.cost, description: f.description, img: f.img,
    })),
    selected: [],
    stage: "pick",
    ccBenefit: benefit,     // carried so the commit knows what the spend answered
  };
  v.render();
  return true;
}

/**
 * Which benefit a spend on this class should be written with.
 *
 * In order: what the class fixes, then what the draft already recorded for it
 * (later levels inherit the first level's answer), then this session's choice
 * from the benefit window. The window asks when the class is STARTED, so by
 * the time a skill is bought the answer already exists.
 */
function benefitToUse(v, d, cls) {
  return cls.benefit ?? benefitFor(d, cls.key) ?? v._benefitChoice.get(cls.key) ?? null;
}

// ── the step body ──────────────────────────────────────────────────────────
//
// A standing summary of what has been chosen, and the way back into the
// window. Deliberately plain: the interesting screen is the one it opens.

const CSS = `
  .cc-cl { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; }
  .cc-cl-top { display: flex; align-items: center; gap: 12px; padding: 11px 14px;
    border-radius: 10px; border: 1px solid #cbb890;
    background: linear-gradient(180deg,#f7f0df,#efe4cd); }
  .cc-cl-pts { display: flex; align-items: baseline; gap: 6px; }
  .cc-cl-pts .n { font-size: 22px; font-weight: 800; color: #4b3517; }
  .cc-cl-pts .n.is-done { color: #2f6b2f; }
  .cc-cl-pts .k { font-size: 12px; font-weight: 700; opacity: .7; }
  .cc-cl-open { margin-left: auto; font-family: inherit; font-size: 13px; font-weight: 700;
    padding: 8px 18px; border-radius: 8px; cursor: pointer;
    border: 1px solid #2f6b2f; background: linear-gradient(180deg,#5f9e4a,#3f7a30); color: #fff; }
  .cc-cl-open:hover { background: linear-gradient(180deg,#6cb154,#478a37); }

  .cc-cl-list { flex: 1 1 auto; min-height: 0; overflow-y: auto;
    display: flex; flex-direction: column; gap: 7px; }
  .cc-cl-class { border-radius: 9px; border: 1px solid #cbb890; background: #f7f0df; padding: 9px 11px; }
  .cc-cl-chead { display: flex; align-items: center; gap: 9px; }
  .cc-cl-chead img { width: 30px; height: 30px; border-radius: 6px; object-fit: cover;
    border: 0 !important; }
  .cc-cl-cname { font-size: 14px; font-weight: 800; }
  .cc-cl-clvl { margin-left: auto; font-size: 11.5px; font-weight: 700; color: #6b4a1c;
    background: #efe4cd; border: 1px solid #b79c72; border-radius: 9px; padding: 1px 8px; }
  .cc-cl-clvl.is-master { background: linear-gradient(180deg,#f0d99a,#e0c179); border-color: #8a6c45; }
  .cc-cl-cben { font-size: 11px; opacity: .6; }
  .cc-cl-skills { margin-top: 7px; display: flex; flex-wrap: wrap; gap: 5px; }
  .cc-cl-skill { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: #3b2a17;
    background: #efe4cd; border: 1px solid #cbb890; border-radius: 7px; padding: 2px 8px; }
  .cc-cl-skill b { font-variant-numeric: tabular-nums; opacity: .7; }
  .cc-cl-facets { margin-top: 5px; font-size: 11px; opacity: .6; }

  .cc-cl-empty { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 12px; text-align: center; }
  .cc-cl-empty p { margin: 0; font-size: 13px; opacity: .7; }
`;

const BENEFIT_LABEL = { hp: "+5 Max HP", mp: "+5 Max MP", ip: "+2 Max IP" };

/**
 * The standing summary, built from the DRAFT alone.
 *
 * Every pick already carries its class name and image, so this needs no
 * registry lookup — which means it still reads correctly if the class
 * catalogue is unavailable, and it does not go blank the moment something
 * upstream cannot resolve a class.
 */
function summaryHTML(d) {
  const keys = draftClassKeys(d);
  if (!keys.length) {
    return `<div class="cc-cl-empty">
      <p>Every character begins with a class.</p>
      <button class="cc-cl-open" data-open>Choose a class</button>
    </div>`;
  }

  return `<div class="cc-cl-list">${keys.map((key) => {
    const rows = d.classes.filter((x) => x.classKey === key);
    const name = rows[0]?.className ?? key;
    const img = rows[0]?.classImg ?? "";
    const benefit = rows[0]?.benefit;

    // Skill levels within the class, in the order they were first taken.
    const skills = [];
    for (const r of rows) {
      const hit = skills.find((x) => x.uuid === r.skillUuid);
      if (hit) hit.n++;
      else skills.push({ uuid: r.skillUuid, name: r.skillName, n: 1 });
    }
    const facets = rows.flatMap((r) => r.facetUuids ?? []).length;
    const mastered = rows.length >= MAX_CLASS_LEVEL;

    return `
      <div class="cc-cl-class">
        <div class="cc-cl-chead">
          <img src="${esc(img || CC.DEFAULT_IMG)}" alt="">
          <span>
            <span class="cc-cl-cname">${mastered ? "⭐ " : ""}${esc(name)}</span><br>
            <span class="cc-cl-cben">${esc(BENEFIT_LABEL[benefit] ?? "")}</span>
          </span>
          <span class="cc-cl-clvl ${mastered ? "is-master" : ""}">level ${rows.length}</span>
        </div>
        <div class="cc-cl-skills">
          ${skills.map((sk) =>
            `<span class="cc-cl-skill">${esc(sk.name)} <b>${sk.n}</b></span>`).join("")}
        </div>
        ${facets ? `<div class="cc-cl-facets">${facets} learned from its list</div>` : ""}
      </div>`;
  }).join("")}</div>`;
}

function render(d) {
  viewFor(d);
  const left = draftPointsLeft(d);
  const pool = draftPointPool(d);

  return `
    <style>${CSS}</style>
    <div class="cc-cl">
      <div class="cc-cl-top">
        <span class="cc-cl-pts">
          <span class="n ${left === 0 ? "is-done" : ""}">${left}</span>
          <span class="k">of ${pool} Skill Points left</span>
        </span>
        <button class="cc-cl-open" data-open>${
          d.classes.length ? "Class &amp; Skills" : "Choose a class"}</button>
      </div>
      ${summaryHTML(d)}
    </div>`;
}

function bind(root, d, ctx) {
  _ctxRef = ctx;
  viewFor(d);

  root.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => openWindow(ctx, { browser: !d.classes.length })));

  // Arriving with no class raises the window on its class browser: choosing
  // one is the first decision, and a bare summary is a poor place to learn it.
  if (!_autoOpened && !d.classes.length && !_host) {
    _autoOpened = true;
    openWindow(ctx, { browser: true });
  }
}

async function onPanelClick(ev, v, d, ctx) {
  const btn = ev.target?.closest?.("[data-act]");
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  const s = v._stateSource();

  // ── the sub-window itself ──
  if (act === "close") {
    sfx("close");
    closeWindow();
    ctx.refresh();
    return;
  }

  // ── benefit window ──
  // Reuses levelup-app's own overlay and its own state fields, so the flow is
  // identical: starting a class that lets you choose asks before the class is
  // anywhere near the rail, and Back leaves it unstarted.
  if (act === "benefitedit") {
    const cls = s.classes.find((c) => c.key === btn.dataset.key);
    if (!v._benefitEditable(cls)) return;
    sfx("open");
    v._benefit = {
      classKey: cls.key, className: cls.name,
      current: v._benefitChoice.get(cls.key) ?? null,
      then: "stay",
    };
    v.render();
    return;
  }
  if (act === "benefitpick") {
    const b = v._benefit;
    if (!b) return;
    v._benefit = null;
    v._benefitChoice.set(b.classKey, btn.dataset.benefit);
    sfx("stageUp");
    if (b.then === "start") {
      v._selected = b.classKey;
      v._pickerOpen = false;
      v.render();
      return;
    }
    // Editing after levels are taken has to rewrite them: the benefit lives on
    // every pick so finalize never has to re-derive it.
    commit((dd) => {
      for (const row of dd.classes) {
        if (row.classKey === b.classKey) row.benefit = btn.dataset.benefit;
      }
    });
    return;
  }
  if (act === "benefitback") {
    sfx("deselect");
    v._benefit = null;
    v.render();
    return;
  }

  // ── class browser ──
  if (act === "openpicker") { sfx("open"); v._pickerOpen = true; v.render(); return; }
  if (act === "closepicker") { sfx("deselect"); v._pickerOpen = false; v.render(); return; }
  if (act === "picktab") { sfx("tab"); v._pickTab = btn.dataset.tab; v._paintPreview(); return; }
  if (act === "pickselect") {
    if (v._pickSel === btn.dataset.key) return;
    sfx("classPage");
    v._pickSel = btn.dataset.key;
    v._paintPreview({ intro: true });
    return;
  }

  // ── rail ──
  if (act === "dropclass") {
    // The × sits inside the rail's own button; without this the click would
    // also select the class it is removing.
    ev.stopPropagation();
    const cls = s.classes.find((c) => c.key === btn.dataset.key);
    const ok = await Dialog.confirm({
      title: `Remove ${cls?.name ?? "this class"}?`,
      content: `<p>Every level taken in it comes back as Skill Points. Nothing has been written yet.</p>`,
      defaultYes: false,
    });
    if (!ok) return;
    sfx("levelDown");
    commit((dd) => {
      dropClass(dd, btn.dataset.key);
      if (v._selected === btn.dataset.key) v._selected = null;
    });
    return;
  }
  if (act === "pick") {
    const key = btn.dataset.key;
    const cls = s.classes.find((c) => c.key === key);
    // Starting a class that lets you choose its bonus asks NOW, as part of
    // starting it — not later, during the first skill purchase, where it read
    // as an unrelated interruption.
    if (cls && !classLevelIn(d, key) && !cls.benefit && !v._benefitChoice.has(key)) {
      sfx("open");
      v._benefit = { classKey: key, className: cls.name, current: null, then: "start" };
      v.render();
      return;
    }
    if (v._selected !== key) sfx("open");
    v._selected = key;
    v._pickerOpen = false;
    v.render();
    return;
  }
  if (act === "tab") { sfx("tab"); v._tab = btn.dataset.tab; v.render(); return; }
  if (act === "toggledetail") { sfx("toggle"); v._detailMode = !v._detailMode; v.render(); return; }
  if (act === "pin") {
    sfx("cursor");
    v._pinned = v._pinned === btn.dataset.uuid ? null : btn.dataset.uuid;
    v.render();
    return;
  }

  // ── spend / refund ──
  if (act === "spend") {
    const cls = s.classes.find((c) => c.key === btn.dataset.key);
    const skill = cls?.skills.find((x) => x.uuid === btn.dataset.uuid);
    if (!cls || !skill) return;

    const gate = canSpend(d, cls, skill);
    if (!gate.ok) { ui.notifications?.warn(gate.reason); return; }

    // The benefit was settled when the class was started. If it somehow was
    // not — a class reached without going through the browser — ask now rather
    // than write a class row with no bonus on it.
    const benefit = benefitToUse(v, d, cls);
    if (!benefit && needsBenefit(d, cls)) {
      v._benefit = { classKey: cls.key, className: cls.name, current: null, then: "stay" };
      v.render();
      return;
    }

    // A grant with nothing left to learn still takes the level — the skill is
    // worth having even when its list is exhausted.
    if (openFacetPicker(v, d, cls, skill, benefit)) return;

    sfx("stageUp");
    commit((dd) => applySpend(dd, cls, skill, { benefit }));
    return;
  }

  if (act === "refund") {
    sfx("stageDown");
    commit((dd) => removeLast(dd, btn.dataset.uuid));
    return;
  }

  // ── facet picker ──
  if (act === "facettoggle") {
    const f = v._facet;
    if (!f) return;
    const u = btn.dataset.uuid;
    const at = f.selected.indexOf(u);
    if (at >= 0) f.selected.splice(at, 1);            // re-click deselects
    else if (f.selected.length < f.need) f.selected.push(u);
    else { f.selected.shift(); f.selected.push(u); }  // full: oldest drops out
    if (f.selected.length === f.need) f.stage = "confirm";
    sfx("toggle");
    v.render();
    return;
  }
  if (act === "facetback") {
    v._facet.selected = [];
    v._facet.stage = "pick";
    v.render();
    return;
  }
  if (act === "facetcancel") {
    // A facet grant cannot be left unresolved: either the player chooses, or
    // the level is not taken at all.
    sfx("deselect");
    v._facet = null;
    v.render();
    return;
  }
  if (act === "facetok") {
    const f = v._facet;
    v._facet = null;
    if (!f) { v.render(); return; }
    const cls = s.classes.find((c) => c.key === f.classKey);
    const skill = cls?.skills.find((x) => x.uuid === f.skillUuid);
    if (!cls || !skill) { v.render(); return; }
    sfx("stageUp");
    commit((dd) => applySpend(dd, cls, skill, { benefit: f.ccBenefit, facetUuids: f.selected }));
  }
}

STEP_RENDERERS.set("classes", {
  render, bind,
  reset: resetUiState,
  leave: leaveStep,
  escape: escapeStep,
});
