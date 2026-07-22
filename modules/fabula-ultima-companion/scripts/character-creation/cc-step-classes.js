/**
 * Character Creation — step 3: Class & Skills.
 *
 * This step does NOT draw its own class rail, skill rows or facet grid. It
 * borrows the level-up window's, by making a derived object off `LevelUpApp`
 * whose state comes from the draft (`cc-class-state.js`) instead of an actor.
 * Those renderers are already tuned and already know the rules; a second
 * implementation would only be a second thing to keep in step with CSB.
 *
 * The seam is one method. `LevelUpApp._readState()` returns either
 * `getState(actorUuid)` or, when `_stateSource` is set, whatever that returns.
 * Everything below it — `_rail`, `_main`, `_facetGrid`, `_row` — is untouched
 * and cannot tell the difference.
 *
 * STAGING COLLAPSES INTO THE DRAFT
 * --------------------------------
 * The real window stages changes in `_pending` and writes them on Confirm.
 * Here the draft IS the staging area: `_pending` stays empty, so `_project`
 * returns zero deltas and every level the renderers show comes straight out of
 * `draftState`. A click mutates the draft and re-renders. There is nothing to
 * confirm because nothing has been written.
 *
 * One point buys one class level and one skill level, the same bargain the
 * level-up system makes — at finalize these picks replay through its
 * `spendPoint`, so class rows, benefit columns, facet grants and the martial
 * flags all land exactly as they do mid-campaign.
 */

import { CC, esc, num } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";
import { draftLevel, draftPointPool, draftPointsLeft, draftClassKeys } from "./cc-draft.js";
import { draftState, takenClasses } from "./cc-class-state.js";
import { LevelUpApp } from "../levelup-system/levelup-app.js";

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

// ── the borrowed renderer ──────────────────────────────────────────────────

/**
 * A LevelUpApp that reads the draft.
 *
 * Object.create rather than a copy, so it stays in step with the real thing:
 * anything added to LevelUpApp's prototype chain is inherited here, and the
 * only overrides are the state source and the flags that describe creation.
 */
let _view = null;
let _draftRef = null;

function view() {
  if (_view) return _view;
  _view = Object.create(LevelUpApp);
  Object.assign(_view, {
    _creation: true,
    _stateSource: () => draftState(_draftRef),
    _pending: [],          // the draft is the staging area; nothing queues here
    _selected: null,
    _tab: "skill",
    _resetMode: false,
    _actorUuid: null,
    _root: null,
    // The real window animates the cursor against its own root. Creation has
    // no such root, and the cursor is decoration, so it is a no-op here.
    _updateCursor: () => {},
  });
  // `isOpen` is an accessor on LevelUpApp, so Object.assign would try to write
  // through a getter with no setter and throw. It has to be redefined on the
  // derived object instead. It reports true because the guards that consult it
  // are asking "is there something to draw into", and here there always is.
  Object.defineProperty(_view, "isOpen", { get: () => true, configurable: true });
  return _view;
}

/** Transient view state, cleared between characters. */
export const resetUiState = () => {
  _view = null;
  _browsing = false;
  _filter = "";
  _pending = null;
};

let _browsing = false;   // the "add a class" list is showing
let _filter = "";
let _pending = null;     // { clsKey, skillUuid, benefit, facets[] } awaiting answers

const CSS = `
  .cc-cl { display: flex; gap: 0; min-height: 0; margin: 0 -16px -14px; }
  .cc-cl-rail { flex: 0 0 auto; width: 210px; padding: 10px; background: #e6dabd;
    border-right: 1px solid #b79c72; overflow-y: auto; display: flex;
    flex-direction: column; gap: 4px; }
  .cc-cl-main { flex: 1 1 auto; min-width: 0; padding: 10px 12px; overflow-y: auto; }
  .cc-cl-pts { display: flex; align-items: baseline; gap: 6px; padding: 6px 9px; margin-bottom: 4px;
    border-radius: 8px; background: linear-gradient(180deg,#f0d99a,#e0c179); border: 1px solid #8a6c45; }
  .cc-cl-pts .n { font-size: 17px; font-weight: 800; color: #4b3517; }
  .cc-cl-pts .k { font-size: 11px; font-weight: 700; color: #4b3517; opacity: .8; }

  /* The rail and skill rows come from levelup-app's own markup, so they carry
     lu-* classes. Those styles live under #oni-levelup, which does not wrap us,
     so the handful actually used are restated here in the wizard's palette. */
  .cc-cl .lu-cls { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
    padding: 6px 8px; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 12.5px;
    color: #3b2a17; background: #f7f0df; border: 1px solid #cbb890; }
  .cc-cl .lu-cls:hover { background: #fdf6e4; border-color: #8a6c45; }
  .cc-cl .lu-cls.on { background: linear-gradient(180deg,#f0d99a,#e0c179); border-color: #8a6c45;
    font-weight: 700; }
  .cc-cl .lu-cls img { width: 24px; height: 24px; border-radius: 5px; object-fit: cover;
    flex: 0 0 auto; border: 0 !important; }
  .cc-cl .lu-cls .n { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cc-cl .lu-cls .l { flex: 0 0 auto; font-size: 11px; font-weight: 700; color: #6b4a1c;
    background: #efe4cd; border: 1px solid #b79c72; border-radius: 9px; padding: 0 6px; }
  .cc-cl .lu-cls .l.moved { background: #5f9e4a; border-color: #2f6b2f; color: #fff; }
  .cc-cl .lu-cls.new { justify-content: center; font-weight: 700; color: #4b3517;
    background: linear-gradient(180deg,#f7edd5,#e6d6b0); }
  .cc-cl .lu-railhead { font-size: 10.5px; font-weight: 800; letter-spacing: .05em;
    text-transform: uppercase; opacity: .6; padding: 6px 2px 2px; }

  .cc-cl .lu-h2 { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px;
    font-size: 15px; font-weight: 800; }
  .cc-cl .lu-h2 span { font-size: 11.5px; font-weight: 400; opacity: .7; }
  .cc-cl .lu-row { display: grid; grid-template-columns: 32px 1fr auto; align-items: center;
    gap: 9px; padding: 6px 9px; border-radius: 8px; margin-bottom: 4px;
    background: #f7f0df; border: 1px solid #cbb890; }
  .cc-cl .lu-row.miss { opacity: .78; }
  .cc-cl .lu-row.max { border-color: #8a6c45; background: #fdf6e4; }
  .cc-cl .lu-row img { width: 30px; height: 30px; border-radius: 6px; object-fit: contain;
    border: 0 !important; }
  .cc-cl .lu-rowname { font-size: 13px; font-weight: 700; }
  .cc-cl .lu-rowmeta { font-size: 11px; opacity: .7; line-height: 1.35; }
  .cc-cl .lu-rowright { display: flex; align-items: center; gap: 5px; }
  .cc-cl .lu-pips { font-size: 11.5px; font-weight: 700; color: #6b4a1c; white-space: nowrap; }
  .cc-cl .lu-pips.moved { color: #2f6b2f; }
  .cc-cl .lu-btn { width: 25px; height: 24px; border-radius: 6px; cursor: pointer; padding: 0;
    font-family: inherit; font-size: 13px; line-height: 1; border: 1px solid #8a6c45;
    background: linear-gradient(180deg,#f7edd5,#e6d6b0); color: #4b3517; }
  .cc-cl .lu-btn:hover:not(:disabled) { background: linear-gradient(180deg,#f0d99a,#e0c179); }
  .cc-cl .lu-btn:disabled { opacity: .3; cursor: default; }
  .cc-cl .lu-btn.buy { border-color: #2f6b2f; background: linear-gradient(180deg,#7ab87a,#5a9a5a);
    color: #fff; }
  .cc-cl .lu-btn.buy:disabled { background: #c8b89a; border-color: #a89870; color: #6b4c2a; }
  .cc-cl .lu-btn.sell { border-color: #a3453a; background: linear-gradient(180deg,#d99a92,#c9736a);
    color: #fff; }
  .cc-cl .lu-btn.edit { width: auto; padding: 0 8px; font-size: 11px; }
  .cc-cl .lu-empty { padding: 20px; text-align: center; opacity: .6; font-size: 12.5px; }
  .cc-cl .lu-lore { font-size: 12px; opacity: .7; line-height: 1.45; margin-bottom: 9px; }
  .cc-cl .lu-note.warn { font-size: 12px; color: #8c3a24; padding: 7px 10px; border-radius: 8px;
    background: rgba(165,42,26,.09); border: 1px solid rgba(165,42,26,.35); }
  .cc-cl .lu-tag { font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 9px;
    color: #6b4a1c; background: rgba(240,217,154,.55); border: 1px solid #cbb890; }

  /* class browser */
  .cc-cl-browse { display: flex; flex-direction: column; gap: 4px; }
  .cc-cl-brow { display: grid; grid-template-columns: 34px 1fr auto; align-items: center; gap: 9px;
    padding: 6px 9px; border-radius: 8px; cursor: pointer; text-align: left; width: 100%;
    font-family: inherit; background: #f7f0df; border: 1px solid #cbb890; color: #3b2a17; }
  .cc-cl-brow:hover { background: #fdf6e4; border-color: #8a6c45; }
  .cc-cl-brow img { width: 32px; height: 32px; border-radius: 6px; object-fit: cover; border: 0 !important; }
  .cc-cl-brow .nm { font-size: 13px; font-weight: 700; }
  .cc-cl-brow .fl { font-size: 11px; opacity: .65; }

  /* benefit / facet prompt */
  .cc-cl-ask { margin-top: 10px; padding: 11px 13px; border-radius: 8px;
    border: 1px solid #8a6c45; background: #fdf6e4; }
  .cc-cl-ask h4 { margin: 0 0 8px; font-size: 13px; font-weight: 800; }
  .cc-cl-askq { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    opacity: .65; margin: 8px 0 5px; }
  .cc-cl-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .cc-cl-chip { font-family: inherit; font-size: 12px; padding: 4px 11px; border-radius: 7px;
    cursor: pointer; color: #3b2a17; background: #f7f0df; border: 1px solid #cbb890; }
  .cc-cl-chip:hover { background: #f0d99a; }
  .cc-cl-chip.on { background: linear-gradient(180deg,#5f9e4a,#3f7a30); border-color: #2f6b2f; color: #fff; }
  .cc-cl-askbtns { display: flex; gap: 7px; margin-top: 11px; }
`;

const BENEFIT_LABEL = { hp: "+5 Max HP", mp: "+5 Max MP", ip: "+2 Max IP" };

function browseHTML(s, d) {
  const list = s.classes
    .filter((c) => !c.taken)
    .filter((c) => !_filter || c.name.toLowerCase().includes(_filter.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  return `
    <div class="lu-h2"><b>Choose a class</b><span>${list.length} available</span></div>
    <input class="cc-search" data-browse-search placeholder="Search classes…"
           value="${esc(_filter)}" style="width:100%;margin-bottom:8px">
    <div class="cc-cl-browse">
      ${list.length ? list.map((c) => `
        <button class="cc-cl-brow" data-open="${esc(c.key)}">
          <img src="${esc(c.img || CC.DEFAULT_IMG)}" alt="">
          <span>
            <span class="nm">${esc(c.name)}</span><br>
            <span class="fl">${esc(String(c.flavor ?? c.folder ?? "").replace(/<[^>]*>/g, " ").slice(0, 90))}</span>
          </span>
          <span class="lu-tag">${esc(c.benefit ? BENEFIT_LABEL[c.benefit] ?? c.benefit : "choose benefit")}</span>
        </button>`).join("")
      : `<div class="lu-empty">No class matches.</div>`}
    </div>`;
}

function askHTML(s, d) {
  if (!_pending) return "";
  const cls = s.classes.find((c) => c.key === _pending.clsKey);
  const skill = cls?.skills.find((x) => x.uuid === _pending.skillUuid);
  if (!cls || !skill) return "";

  const wantBenefit = needsBenefit(d, cls);
  const { need, available } = facetNeed(d, cls, skill);

  const benefitBlock = wantBenefit ? `
    <div class="cc-cl-askq">Free benefit for ${esc(cls.name)} — chosen once, when the class opens</div>
    <div class="cc-cl-chips">
      ${Object.entries(BENEFIT_LABEL).map(([k, label]) =>
        `<button class="cc-cl-chip ${_pending.benefit === k ? "on" : ""}" data-benefit="${k}">${esc(label)}</button>`).join("")}
    </div>` : "";

  const facetBlock = need ? `
    <div class="cc-cl-askq">Choose ${need} — ${esc(skill.name)} grants ${need === 1 ? "one" : need}</div>
    <div class="cc-cl-chips">
      ${available.length
        ? available.map((f) =>
            `<button class="cc-cl-chip ${_pending.facets.includes(f.uuid) ? "on" : ""}"
                     data-facet="${esc(f.uuid)}">${esc(f.name)}</button>`).join("")
        : `<span class="lu-tag">nothing left to learn</span>`}
    </div>` : "";

  const ready = (!wantBenefit || !!_pending.benefit) &&
                (!need || _pending.facets.length === Math.min(need, available.length));

  return `
    <div class="cc-cl-ask">
      <h4>${esc(cls.name)} — ${esc(skill.name)}</h4>
      ${benefitBlock}${facetBlock}
      <div class="cc-cl-askbtns">
        <button class="cc-btn is-primary" data-ask-ok ${ready ? "" : "disabled"}>Confirm</button>
        <button class="cc-btn is-ghost" data-ask-cancel>Cancel</button>
      </div>
    </div>`;
}

function render(d) {
  _draftRef = d;
  const v = view();
  const s = v._stateSource();

  // A class the player has taken stays selected; otherwise fall back to the
  // first one they have, so the main pane is never blank when it need not be.
  const taken = takenClasses(s, d);
  if (_selectedMissing(s, taken)) v._selected = taken[0]?.key ?? null;

  const proj = v._project(s);
  const main = _browsing || !v._selected
    ? browseHTML(s, d)
    : v._main(s, proj) + askHTML(s, d);

  return `
    <style>${CSS}</style>
    <div class="cc-cl">
      <div class="cc-cl-rail">
        <div class="cc-cl-pts">
          <span class="n">${draftPointsLeft(d)}</span>
          <span class="k">of ${draftPointPool(d)} points left</span>
        </div>
        ${v._rail(s, taken, proj)}
      </div>
      <div class="cc-cl-main">${main}</div>
    </div>`;
}

function _selectedMissing(s, taken) {
  const v = view();
  if (!v._selected) return true;
  return !s.classes.some((c) => c.key === v._selected);
}

function bind(root, d, ctx) {
  _draftRef = d;
  const v = view();
  const s = v._stateSource();

  // ── rail ──
  root.querySelectorAll("[data-act='pick']").forEach((b) => {
    b.addEventListener("click", () => {
      v._selected = b.dataset.key;
      _browsing = false;
      _pending = null;
      ctx.refresh();
    });
  });
  root.querySelector("[data-act='openpicker']")?.addEventListener("click", () => {
    _browsing = true; _pending = null; _filter = ""; ctx.refresh();
  });

  // ── class browser ──
  const search = root.querySelector("[data-browse-search]");
  search?.addEventListener("input", () => {
    _filter = search.value;
    const main = root.querySelector(".cc-cl-main");
    if (!main) return;
    main.innerHTML = browseHTML(s, d);
    bind(root, d, ctx);                 // re-wire the redrawn list
    main.querySelector("[data-browse-search]")?.focus();
  });
  root.querySelectorAll("[data-open]").forEach((b) => {
    b.addEventListener("click", () => {
      v._selected = b.dataset.open;
      _browsing = false;
      ctx.refresh();
    });
  });

  // ── spend / refund, emitted by levelup-app's own row markup ──
  root.querySelectorAll("[data-act='spend']").forEach((b) => {
    b.addEventListener("click", () => {
      const cls = s.classes.find((c) => c.key === b.dataset.key);
      const skill = cls?.skills.find((x) => x.uuid === b.dataset.uuid);
      if (!cls || !skill) return;

      const gate = canSpend(d, cls, skill);
      if (!gate.ok) { ui.notifications?.warn(gate.reason); return; }

      // Straight through when there is nothing to ask. When the skill grants
      // facets but none are left unlearned the prompt still appears — it is
      // worth telling the player the grant went nowhere.
      const { need } = facetNeed(d, cls, skill);
      if (!needsBenefit(d, cls) && !need) {
        ctx.edit((dd) => applySpend(dd, cls, skill));
        return;
      }
      _pending = { clsKey: cls.key, skillUuid: skill.uuid, benefit: cls.benefit ?? "", facets: [] };
      ctx.refresh();
    });
  });

  root.querySelectorAll("[data-act='refund']").forEach((b) => {
    b.addEventListener("click", () => ctx.edit((dd) => removeLast(dd, b.dataset.uuid)));
  });

  // ── the benefit / facet prompt ──
  root.querySelectorAll("[data-benefit]").forEach((b) => {
    b.addEventListener("click", () => { if (_pending) { _pending.benefit = b.dataset.benefit; ctx.refresh(); } });
  });
  root.querySelectorAll("[data-facet]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!_pending) return;
      const cls = s.classes.find((c) => c.key === _pending.clsKey);
      const skill = cls?.skills.find((x) => x.uuid === _pending.skillUuid);
      const { need, available } = facetNeed(d, cls, skill);
      const uuid = b.dataset.facet;
      const i = _pending.facets.indexOf(uuid);
      if (i >= 0) _pending.facets.splice(i, 1);
      else if (_pending.facets.length < Math.min(need, available.length)) _pending.facets.push(uuid);
      ctx.refresh();
    });
  });
  root.querySelector("[data-ask-ok]")?.addEventListener("click", () => {
    if (!_pending) return;
    const cls = s.classes.find((c) => c.key === _pending.clsKey);
    const skill = cls?.skills.find((x) => x.uuid === _pending.skillUuid);
    const { benefit, facets } = _pending;
    _pending = null;
    if (cls && skill) ctx.edit((dd) => applySpend(dd, cls, skill, { benefit, facetUuids: facets }));
    else ctx.refresh();
  });
  root.querySelector("[data-ask-cancel]")?.addEventListener("click", () => {
    _pending = null; ctx.refresh();
  });
}

STEP_RENDERERS.set("classes", { render, bind, reset: resetUiState });
