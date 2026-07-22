/**
 * Character Creation — step 3: Class & Skills.
 *
 * One Skill Point buys ONE class level and ONE skill level in that class — the
 * same bargain the level-up system makes, because at finalize these picks are
 * replayed through its `spendPoint` rather than written directly. Everything
 * that follows from a spend (the class row, the benefit column, facet grants,
 * the martial-armor flag, heroic slots) therefore happens exactly as it does
 * mid-campaign, and there is no second implementation to drift.
 *
 * The rules checked here are a courtesy so the player is not told "no" only at
 * the very end. The GM re-validates all of them on arrival — `validateSpend`
 * enforces the class cap, the skill cap and the three-unmastered-classes limit
 * regardless of what this window believes.
 *
 * FACETS AND BENEFITS
 * -------------------
 * Some skills award a spell/dance/symbol per level ("learn one Elementalist
 * spell"); the class's `facetGrant` says how many. Some classes let the player
 * choose whether the class's free benefit is +5 HP, +5 MP or +2 IP, and that
 * choice is made ONCE, when the class is first opened — CSB stores one benefit
 * column per class row, not one per level. Both are collected in a single
 * confirmation panel rather than a chain of dialogs.
 */

import { CC, esc, num } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";
import {
  draftLevel, draftPointPool, draftPointsLeft,
  draftClassKeys, draftClassLevels,
} from "./cc-draft.js";

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

// ── registry access ────────────────────────────────────────────────────────
//
// The playable-class catalogue is the level-up system's, imported directly
// rather than reimplemented: it already resolves the Classes/ folders, splits
// skills from heroics from facets, and handles this world's duplicate class
// actors. `getRegistry` caches internally and touches no Foundry global until
// it is called, so importing it here is safe outside a live game.

import { getRegistry } from "../levelup-system/class-registry.js";

function allClasses() {
  try {
    return getRegistry().list ?? [];
  } catch (e) {
    console.error("[ONI][CharCreate] class registry unavailable:", e);
    return [];
  }
}

// ── transient UI state ─────────────────────────────────────────────────────

let _selected = null;   // class key currently open in the right pane
let _filter = "";
let _pending = null;    // { cls, skill, benefit, facets:[] } awaiting confirmation

export const resetUiState = () => { _selected = null; _filter = ""; _pending = null; };

const CSS = `
  .cc-cls-wrap { display: grid; grid-template-columns: 260px 1fr; gap: 18px; min-height: 0; }
  .cc-cls-left { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
  .cc-pts {
    display: flex; align-items: baseline; justify-content: space-between;
    padding: 9px 12px; border-radius: 3px;
    border: 1px solid rgba(140,90,30,0.35); background: rgba(201,164,74,0.16);
  }
  .cc-pts-n { font-size: 21px; color: #3a1e06; }
  .cc-pts-k { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: #8a6432; }
  .cc-cls-list { overflow-y: auto; display: flex; flex-direction: column; gap: 3px; max-height: 380px; }
  .cc-cls-item {
    display: flex; align-items: center; gap: 8px; padding: 6px 9px; border-radius: 2px;
    cursor: pointer; font-family: inherit; text-align: left; width: 100%;
    border: 1px solid transparent; background: transparent; color: #5c3a12; font-size: 11px;
  }
  .cc-cls-item:hover { background: rgba(201,164,74,0.16); }
  .cc-cls-item.is-on { background: rgba(201,164,74,0.30); border-color: rgba(140,90,30,0.45); color: #3a1e06; }
  .cc-cls-item img { width: 22px; height: 22px; border-radius: 2px; object-fit: cover; flex: 0 0 22px; }
  .cc-cls-lv {
    margin-left: auto; font-size: 10px; color: #7a5428;
    background: rgba(255,250,230,0.8); border: 1px solid #c4a260;
    border-radius: 9px; padding: 1px 7px;
  }
  .cc-cls-lv.is-master { background: #c9a22a; border-color: #a07818; color: #fff; }

  .cc-cls-right { min-width: 0; }
  .cc-cls-head { display: flex; align-items: center; gap: 11px; margin-bottom: 4px; }
  .cc-cls-head img { width: 36px; height: 36px; border-radius: 3px; object-fit: cover; }
  .cc-cls-title { font-size: 14px; letter-spacing: 3px; color: #3a1e06; }
  .cc-cls-meta { font-size: 9px; color: #8a6432; letter-spacing: 1px; }
  .cc-cls-free { display: flex; flex-wrap: wrap; gap: 5px; margin: 9px 0 12px; }

  .cc-skills { display: flex; flex-direction: column; gap: 5px; max-height: 330px; overflow-y: auto; }
  .cc-skill {
    display: grid; grid-template-columns: 26px 1fr auto auto; gap: 9px; align-items: center;
    padding: 7px 10px; border-radius: 3px;
    border: 1px solid rgba(140,90,30,0.24); background: rgba(255,252,240,0.5);
  }
  .cc-skill img { width: 26px; height: 26px; border-radius: 2px; object-fit: cover; }
  .cc-skill-n { font-size: 11px; color: #3a1e06; }
  .cc-skill-d { font-size: 9px; color: #9b7040; line-height: 1.35;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .cc-skill-lv { font-size: 10px; color: #7a5428; letter-spacing: 1px; white-space: nowrap; }
  .cc-pm { display: flex; gap: 3px; }
  .cc-pm button {
    font-family: inherit; width: 22px; height: 22px; line-height: 1; font-size: 13px;
    border-radius: 2px; cursor: pointer; color: #3a1e06;
    background: linear-gradient(155deg, #fdf6e0 0%, #e8d8a4 100%); border: 1px solid #c4a260;
  }
  .cc-pm button:disabled { opacity: 0.3; cursor: default; }
  .cc-pm button:hover:not(:disabled) { background: linear-gradient(155deg, #fffbe8 0%, #f0e3b8 100%); }

  .cc-pend {
    margin-top: 12px; padding: 13px 15px; border-radius: 3px;
    border: 1px solid #c9a44a; background: rgba(201,164,74,0.2);
  }
  .cc-pend-t { font-size: 11px; letter-spacing: 2px; color: #3a1e06; margin-bottom: 8px; }
  .cc-pend-q { font-size: 9px; letter-spacing: 1px; color: #8a6432; margin: 8px 0 5px; text-transform: uppercase; }
  .cc-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .cc-chip {
    font-family: inherit; font-size: 10px; padding: 4px 11px; border-radius: 2px; cursor: pointer;
    color: #5c3a12; background: rgba(255,252,240,0.8); border: 1px solid rgba(140,90,30,0.35);
  }
  .cc-chip.is-on { background: #c9a22a; border-color: #a07818; color: #fff; }
  .cc-pend-btns { display: flex; gap: 7px; margin-top: 11px; }
  .cc-empty { padding: 34px; text-align: center; color: #9b7040; font-size: 11px; letter-spacing: 1px; }
`;

function freeTags(cls) {
  const t = [];
  if (cls.benefit) t.push(`benefit: +${cls.benefit === "ip" ? "2 IP" : "5 " + cls.benefit.toUpperCase()}`);
  else t.push("benefit: your choice");
  if (cls.free.martialMelee) t.push("martial melee");
  if (cls.free.martialRanged) t.push("martial ranged");
  if (cls.free.martialArmor) t.push("martial armor");
  if (cls.free.martialShield) t.push("martial shields");
  if (cls.free.ritual) t.push("rituals");
  if (cls.free.project) t.push("projects");
  return t.map((x) => `<span class="cc-tag">${esc(x)}</span>`).join("");
}

function classListHTML(d) {
  const levels = draftClassLevels(d);
  const list = allClasses()
    .filter((c) => !_filter || c.name.toLowerCase().includes(_filter.toLowerCase()))
    .slice()
    .sort((a, b) => (num(levels[b.key], 0) - num(levels[a.key], 0)) || a.name.localeCompare(b.name));

  if (!list.length) {
    return `<div class="cc-empty">${_filter ? "No class matches." : "No playable classes found."}</div>`;
  }
  return list.map((c) => {
    const lv = num(levels[c.key], 0);
    return `<button class="cc-cls-item ${_selected === c.key ? "is-on" : ""}" data-cls="${esc(c.key)}">
      <img src="${esc(c.img || CC.DEFAULT_IMG)}" alt="">
      <span>${esc(c.name)}</span>
      ${lv ? `<span class="cc-cls-lv ${lv >= MAX_CLASS_LEVEL ? "is-master" : ""}">${lv}</span>` : ""}
    </button>`;
  }).join("");
}

function skillsHTML(d, cls) {
  return (cls.skills ?? []).map((s) => {
    const lv = skillLevelIn(d, s.uuid);
    const gate = canSpend(d, cls, s);
    const plain = String(s.description ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return `
      <div class="cc-skill">
        <img src="${esc(s.img || CC.DEFAULT_IMG)}" alt="">
        <div>
          <div class="cc-skill-n">${esc(s.name)}${num(s.facetGrant, 0) ? ` <span class="cc-tag">+${s.facetGrant} facet</span>` : ""}</div>
          <div class="cc-skill-d">${esc(plain)}</div>
        </div>
        <div class="cc-skill-lv">SL ${lv} / ${s.maxLevel}</div>
        <div class="cc-pm">
          <button data-minus="${esc(s.uuid)}" ${lv ? "" : "disabled"} title="Give back a level">−</button>
          <button data-plus="${esc(s.uuid)}" ${gate.ok ? "" : "disabled"}
                  title="${esc(gate.ok ? "Spend a Skill Point" : gate.reason)}">+</button>
        </div>
      </div>`;
  }).join("");
}

function pendingHTML(d) {
  if (!_pending) return "";
  const { cls, skill, benefit, facets } = _pending;
  const { need, available } = facetNeed(d, cls, skill);
  const wantBenefit = needsBenefit(d, cls);

  const benefitBlock = wantBenefit ? `
    <div class="cc-pend-q">Free benefit for ${esc(cls.name)} — chosen once, when the class is opened</div>
    <div class="cc-chips">
      ${[["hp", "+5 Max HP"], ["mp", "+5 Max MP"], ["ip", "+2 Max IP"]].map(([k, label]) =>
        `<button class="cc-chip ${benefit === k ? "is-on" : ""}" data-benefit="${k}">${esc(label)}</button>`).join("")}
    </div>` : "";

  const facetBlock = need ? `
    <div class="cc-pend-q">Choose ${need} — ${esc(skill.name)} grants ${need === 1 ? "one" : need}</div>
    <div class="cc-chips">
      ${available.length
        ? available.map((f) =>
            `<button class="cc-chip ${facets.includes(f.uuid) ? "is-on" : ""}" data-facet="${esc(f.uuid)}">${esc(f.name)}</button>`).join("")
        : `<span class="cc-tag">nothing left to learn</span>`}
    </div>` : "";

  const ready = (!wantBenefit || !!benefit) &&
                (!need || facets.length === Math.min(need, available.length));

  return `
    <div class="cc-pend">
      <div class="cc-pend-t">${esc(cls.name)} — ${esc(skill.name)}</div>
      ${benefitBlock}
      ${facetBlock}
      <div class="cc-pend-btns">
        <button class="cc-btn is-primary" data-confirm ${ready ? "" : "disabled"}>Confirm</button>
        <button class="cc-btn is-ghost" data-cancel-pend>Cancel</button>
      </div>
    </div>`;
}

function rightHTML(d) {
  const cls = allClasses().find((c) => c.key === _selected) ?? null;
  if (!cls) return `<div class="cc-empty">Pick a class to see its skills.</div>`;
  const lv = classLevelIn(d, cls.key);
  return `
    <div class="cc-cls-head">
      <img src="${esc(cls.img || CC.DEFAULT_IMG)}" alt="">
      <div>
        <div class="cc-cls-title">${esc(cls.name)}</div>
        <div class="cc-cls-meta">${esc(cls.folder)} · level ${lv} / ${MAX_CLASS_LEVEL}</div>
      </div>
    </div>
    <div class="cc-cls-free">${freeTags(cls)}</div>
    <div class="cc-skills">${skillsHTML(d, cls)}</div>
    ${pendingHTML(d)}`;
}

function render(d) {
  const left = draftPointsLeft(d);
  return `
    <style>${CSS}</style>
    <div class="cc-cls-wrap">
      <div class="cc-cls-left">
        <div class="cc-pts">
          <span class="cc-pts-n">${left}</span>
          <span class="cc-pts-k">of ${draftPointPool(d)} points left</span>
        </div>
        <input class="cc-search" data-search placeholder="Search classes…" value="${esc(_filter)}">
        <div class="cc-cls-list">${classListHTML(d)}</div>
      </div>
      <div class="cc-cls-right">${rightHTML(d)}</div>
    </div>`;
}

function bind(root, d, ctx) {
  const search = root.querySelector("[data-search]");
  search?.addEventListener("input", () => {
    _filter = search.value;
    // Redraw only the list, so the search box keeps focus and the caret.
    const list = root.querySelector(".cc-cls-list");
    if (list) list.innerHTML = classListHTML(d);
    bindClassItems(root, d, ctx);
  });

  bindClassItems(root, d, ctx);

  root.querySelectorAll("[data-plus]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cls = allClasses().find((c) => c.key === _selected);
      const skill = cls?.skills.find((s) => s.uuid === btn.dataset.plus);
      if (!cls || !skill) return;
      const gate = canSpend(d, cls, skill);
      if (!gate.ok) { ui.notifications?.warn(gate.reason); return; }

      // Straight through when there is nothing to ask about. When the skill
      // grants facets but none are left unlearned, the panel still appears —
      // it is worth telling the player the grant went nowhere.
      const { need } = facetNeed(d, cls, skill);
      if (!needsBenefit(d, cls) && !need) {
        ctx.edit((dd) => applySpend(dd, cls, skill));
        return;
      }
      _pending = { cls, skill, benefit: cls.benefit ?? "", facets: [] };
      ctx.refresh();
    });
  });

  root.querySelectorAll("[data-minus]").forEach((btn) => {
    btn.addEventListener("click", () => {
      ctx.edit((dd) => removeLast(dd, btn.dataset.minus));
    });
  });

  root.querySelectorAll("[data-benefit]").forEach((b) => {
    b.addEventListener("click", () => { if (_pending) { _pending.benefit = b.dataset.benefit; ctx.refresh(); } });
  });

  root.querySelectorAll("[data-facet]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!_pending) return;
      const uuid = b.dataset.facet;
      const { need, available } = facetNeed(d, _pending.cls, _pending.skill);
      const i = _pending.facets.indexOf(uuid);
      if (i >= 0) _pending.facets.splice(i, 1);
      else if (_pending.facets.length < Math.min(need, available.length)) _pending.facets.push(uuid);
      ctx.refresh();
    });
  });

  root.querySelector("[data-confirm]")?.addEventListener("click", () => {
    if (!_pending) return;
    const { cls, skill, benefit, facets } = _pending;
    _pending = null;
    ctx.edit((dd) => applySpend(dd, cls, skill, { benefit, facetUuids: facets }));
  });

  root.querySelector("[data-cancel-pend]")?.addEventListener("click", () => {
    _pending = null;
    ctx.refresh();
  });
}

function bindClassItems(root, d, ctx) {
  root.querySelectorAll("[data-cls]").forEach((el) => {
    el.addEventListener("click", () => {
      _selected = el.dataset.cls;
      _pending = null;
      ctx.refresh();
    });
  });
}

STEP_RENDERERS.set("classes", { render, bind, reset: resetUiState });
