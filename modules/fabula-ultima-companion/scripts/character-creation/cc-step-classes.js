/**
 * Character Creation — step 3: Class & Skills.
 *
 * THE STEP BODY IS THE LEVEL-UP WINDOW.
 *
 * Not a copy of it, not a lookalike — levelup-app's own `render()`, drawing its
 * own head, class rail, skill list, detail panel, class browser and facet
 * picker. Every rule in its stylesheet is scoped under `#oni-levelup`, so the
 * host carries that id and a single override puts it back into normal flow
 * instead of `position:fixed; inset:0`. Everything else applies untouched,
 * which is the whole point.
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
 * Arriving with no class raises the browser, because choosing one is the first
 * decision and an empty rail is a poor place to discover that.
 *
 * One point buys one class level and one skill level, the same bargain the
 * level-up system makes — at finalize these picks replay through its
 * `spendPoint`, so class rows, benefit columns, facet grants and the martial
 * flags all land exactly as they do mid-campaign.
 */

import { CC, esc, num } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";
import { draftLevel, draftPointsLeft, draftClassKeys } from "./cc-draft.js";
import { draftState } from "./cc-class-state.js";
import { LevelUpApp, injectLevelUpStyles, LEVELUP_ROOT_ID } from "../levelup-system/levelup-app.js";
import { sfx } from "../levelup-system/levelup-fx.js";

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

// ── the embedded window ────────────────────────────────────────────────────

let _view = null;
let _draftRef = null;
let _ctxRef = null;
let _host = null;         // the embedded #oni-levelup element
let _autoOpened = false;  // the class browser raises itself once, on arrival

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
    _details: new Map(),
    _pinned: null,
    _hover: null,
    _rowIdx: 0, _railIdx: 0, _headIdx: 0, _zone: "list",
    // Keyboard navigation draws a cursor against the real window's chrome.
    // There is none here, so it is a no-op rather than a source of exceptions.
    _updateCursor: () => {},
  });
  // `isOpen` is an accessor on LevelUpApp, so Object.assign would try to write
  // through a getter with no setter and throw. Redefine it on the derived
  // object instead. It reports true because the guards that consult it ask
  // "is there something to draw into", and here there always is.
  Object.defineProperty(_view, "isOpen", { get: () => true, configurable: true });
  return _view;
}

/** Transient view state, cleared between characters. */
export const resetUiState = () => {
  _view = null;
  _host = null;
  _autoOpened = false;
};

/** Nothing to tear down — the panel lives inside the step body. */
export const leaveStep = () => {
  if (_view) { _view._facet = null; _view._pickerOpen = false; }
};

/** Escape backs out of whichever overlay is up, rather than the whole wizard. */
export function escapeStep() {
  const v = _view;
  if (!v || !_host) return false;
  if (v._facet) { sfx("deselect"); v._facet = null; v.render(); return true; }
  if (v._pickerOpen) { sfx("deselect"); v._pickerOpen = false; v.render(); return true; }
  return false;
}

/**
 * One override, so the window sits in the page rather than over it.
 *
 * Higher specificity than levelup-app's own `#oni-levelup` rule (id + class)
 * and injected after it, so it wins on both counts. Nothing else in that
 * stylesheet is touched.
 */
const EMBED_STYLE_ID = "oni-cc-levelup-embed";
const EMBED_CSS = `
  #${LEVELUP_ROOT_ID}.cc-embed {
    position: relative; inset: auto; z-index: auto; background: none;
    display: block; width: 100%; height: 100%; }
  #${LEVELUP_ROOT_ID}.cc-embed .lu-panel {
    width: 100%; height: 100%; border: 0; border-radius: 0; box-shadow: none;
    background: transparent; }
  /* The browser and the facet picker cover the step body, and nothing else. */
  #${LEVELUP_ROOT_ID}.cc-embed .lu-picker,
  #${LEVELUP_ROOT_ID}.cc-embed .lu-facet { position: absolute; inset: 0; }

  /* Creation-only: the drop-class affordance the rail grows in this mode. */
  #${LEVELUP_ROOT_ID}.cc-embed .lu-clsdrop {
    margin-left: 4px; padding: 0 5px; border-radius: 6px; font-size: 13px;
    line-height: 1.2; color: #8a6c45; opacity: 0;
    transition: opacity .12s, background .12s, color .12s; }
  #${LEVELUP_ROOT_ID}.cc-embed .lu-cls:hover .lu-clsdrop { opacity: .7; }
  #${LEVELUP_ROOT_ID}.cc-embed .lu-clsdrop:hover { opacity: 1; background: #c9736a; color: #fff; }
`;

function injectEmbedCSS() {
  if (document.getElementById(EMBED_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = EMBED_STYLE_ID;
  s.textContent = EMBED_CSS;
  document.head.appendChild(s);
}

/**
 * Commit a draft change and repaint.
 *
 * NOT via `ctx.edit`: that replaces the step body wholesale, which would
 * destroy the panel and throw its skill list back to the top on every point
 * spent. The panel repaints itself; the shell's chrome is refreshed separately,
 * since whether Next is live depends on the pool.
 */
function commit(fn) {
  fn(_draftRef);
  _view?.render();
  _ctxRef?.syncNav();
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
 * Ask which free benefit a newly opened class grants, when it does not fix one.
 *
 * `class_list` stores one benefit per class row, so the question is asked once,
 * as the class opens — the same moment the level-up window asks it.
 */
async function askBenefit(cls) {
  return await Dialog.wait({
    title: `${cls.name} — free benefit`,
    content: `<p style="margin:0 0 8px">Choose what taking <b>${esc(cls.name)}</b> permanently grants.</p>`,
    buttons: {
      hp: { label: "+5 Max HP", callback: () => "hp" },
      mp: { label: "+5 Max MP", callback: () => "mp" },
      ip: { label: "+2 Max IP", callback: () => "ip" },
    },
    default: "hp",
    close: () => null,
  }).catch(() => null);
}

// ── the step ───────────────────────────────────────────────────────────────

function render(d) {
  viewFor(d);
  return `<div id="${LEVELUP_ROOT_ID}" class="cc-embed"><div class="lu-panel"></div></div>`;
}

function bind(root, d, ctx) {
  injectLevelUpStyles();
  injectEmbedCSS();

  _ctxRef = ctx;
  const v = viewFor(d);
  _host = root.querySelector(`#${LEVELUP_ROOT_ID}.cc-embed`);
  if (!_host) return;
  v._root = _host;

  if (!_autoOpened && !d.classes.length) {
    _autoOpened = true;
    v._pickerOpen = true;
    v._pickSel = null;
  }

  v.render();

  // One delegated handler on the host, so it survives every internal repaint.
  _host.addEventListener("click", (ev) => { void onPanelClick(ev, v, d, ctx); });
  _host.addEventListener("mousedown", (ev) => {
    // The picker's dim backdrop closes it, as in the real window.
    if (ev.target?.classList?.contains("lu-picker")) {
      sfx("deselect"); v._pickerOpen = false; v.render();
    }
  });
}

async function onPanelClick(ev, v, d, ctx) {
  const btn = ev.target?.closest?.("[data-act]");
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  const s = v._stateSource();

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
    if (v._selected !== btn.dataset.key) sfx("open");
    v._selected = btn.dataset.key;
    v._pickerOpen = false;
    v.render();
    return;
  }
  if (act === "tab") { sfx("tab"); v._tab = btn.dataset.tab; v.render(); return; }
  if (act === "toggledetail") { sfx("toggle"); v._detailMode = !v._detailMode; v.render(); return; }
  if (act === "pin") { sfx("cursor"); v._pinned = v._pinned === btn.dataset.uuid ? null : btn.dataset.uuid; v.render(); return; }

  // ── spend / refund ──
  if (act === "spend") {
    const cls = s.classes.find((c) => c.key === btn.dataset.key);
    const skill = cls?.skills.find((x) => x.uuid === btn.dataset.uuid);
    if (!cls || !skill) return;

    const gate = canSpend(d, cls, skill);
    if (!gate.ok) { ui.notifications?.warn(gate.reason); return; }

    // A class opening for the first time may owe a benefit choice.
    let benefit = cls.benefit ?? null;
    if (needsBenefit(d, cls)) {
      benefit = await askBenefit(cls);
      if (!benefit) return;                       // dismissed: take nothing
    }

    // A grant that cannot be satisfied still takes the level — the skill is
    // worth having even when there is nothing left of its list to learn.
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
