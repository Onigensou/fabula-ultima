/**
 * Character Creation — step 2: Attributes.
 *
 * Level, one of the three starting arrays (p.162), assignment of that array's
 * dice to MIG/DEX/INS/WLP, and — for characters created at level 20 or 40 — the
 * permanent die steps those milestones grant (p.227).
 *
 * Laid out like the Status window, with the same attribute icons and the same
 * row shape, because it is the same information: a player who has seen one
 * should recognise the other instantly.
 *
 * ONE ARRAY AT A TIME
 * -------------------
 * The three spreads are fixed by the rulebook, so they are a carousel rather
 * than three cards competing for space — arrows or the mouse wheel step
 * between them. Switching clears the assignment, since the dice on offer have
 * changed and any previous pick refers to a pool that no longer exists.
 *
 * ASSIGNMENT IS A PERMUTATION, NOT FOUR FREE CHOICES
 * --------------------------------------------------
 * The array is a fixed pool. Picking d10 for MIG when DEX holds it must MOVE
 * it, not clone it, or a player can quietly hand themselves four d10s. Every
 * change is therefore a swap, which makes an invalid spread unreachable rather
 * than merely rejected.
 *
 * MILESTONES
 * ----------
 * A character created above level 20 has already earned those advances and is
 * entitled to them at creation — an explicit table ruling. They are picked here
 * and written to the attribute system's own ledger at finalize, so the badge
 * does not later offer them a second time.
 *
 * The derived preview shows BASE values only. Class benefits (+5 HP / +5 MP /
 * +2 IP per class) are chosen in the next step and are called out as pending
 * rather than guessed at.
 */

import { CC, CC_ATTR_KEYS, CC_ATTR_LABEL, esc, num } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";
import { draftLevel, draftMilestones, draftPointPool, draftBudget } from "./cc-draft.js";
import { ATTR_META } from "../attribute-system/attribute-const.js";

const DIE_STEPS = [6, 8, 10, 12];
const nextDie = (die) => {
  const i = DIE_STEPS.indexOf(num(die, 0));
  return i >= 0 && i < DIE_STEPS.length - 1 ? DIE_STEPS[i + 1] : null;
};

/**
 * Base dice after milestone advances are applied on top of the array.
 * Steps that would push past d12 are dropped — the cap is real (p.227).
 */
export function effectiveBases(d) {
  return applyMilestones(d).bases;
}

/**
 * Apply the milestone advances to the assigned array, recording each step.
 *
 * The entries are shaped like the attribute system's own ledger rows
 * ({ milestone, attr, from, to }) because finalize has to WRITE that ledger: a
 * character created at level 20 or 40 already has its advances baked into the
 * bases, and without a matching ledger the attribute window would cheerfully
 * offer them a second time.
 *
 * Kept in one place, and `effectiveBases` delegates to it, so the dice the
 * player is shown and the ledger that justifies them cannot drift apart.
 */
export function applyMilestones(d) {
  const bases = {};
  for (const k of CC_ATTR_KEYS) bases[k] = num(d.attributes.assign[k], 0);

  const entries = [];
  for (const pick of d.attributes.milestonePicks ?? []) {
    if (!CC_ATTR_KEYS.includes(pick)) continue;
    const from = bases[pick];
    const to = nextDie(from);
    if (to == null) continue;                 // already at d12; the pick is void
    bases[pick] = to;
    entries.push({ milestone: CC.MILESTONES[entries.length] ?? 0, attr: pick, from, to });
  }
  return { bases, entries };
}

/** Base derived stats. Excludes class benefits and equipment, deliberately. */
export function previewDerived(d) {
  const b = effectiveBases(d);
  const lvl = draftLevel(d);
  const maxHp = lvl + 5 * num(b.mig, 0);
  const maxMp = lvl + 5 * num(b.wlp, 0);
  const avg = (die) => (num(die, 0) + 1) / 2;
  return {
    maxHp, maxMp,
    crisis: Math.floor(maxHp / 2),
    maxIp: CC.RULE.BASE_IP,
    def: num(b.dex, 0),
    mdef: num(b.ins, 0),
    init: avg(b.dex) + avg(b.ins),
  };
}

// ── view ───────────────────────────────────────────────────────────────────

/** The three arrays in a fixed order, so the arrows and the wheel agree. */
const ARRAY_ORDER = Object.freeze(["jack", "average", "specialized"]);

const CSS = `
  .cc-at { display: flex; gap: 0; min-height: 0; margin: 0 -16px -14px; }
  .cc-at-left { flex: 0 0 auto; width: 350px; padding: 0 12px 12px; display: flex;
    flex-direction: column; gap: 9px; }
  .cc-at-right { flex: 1 1 auto; min-width: 0; padding: 12px 14px;
    background: #e6dabd; border-left: 1px solid #b79c72;
    display: flex; flex-direction: column; gap: 3px; }

  .cc-at-lvl { display: flex; align-items: center; gap: 9px; padding: 7px 9px;
    border-radius: 8px; background: #f7f0df; border: 1px solid #cbb890; }
  .cc-at-lvl label { font-weight: 800; letter-spacing: .04em; font-size: 13px; }
  .cc-at-lvl input { width: 64px; text-align: center; font-family: inherit; font-size: 14px;
    font-weight: 700; color: #2f2618; padding: 4px 6px; border-radius: 6px;
    background: #fdf6e4; border: 1px solid #cbb890; }
  .cc-at-lvl input:focus { outline: none; border-color: #8a6c45; }
  .cc-at-lvlnote { margin-left: auto; font-size: 11px; opacity: .7; text-align: right; line-height: 1.35; }

  /* The array carousel: one spread at a time, arrows or wheel to change. */
  .cc-at-arr { border-radius: 8px; background: #f7f0df; border: 1px solid #cbb890; padding: 8px 9px; }
  .cc-at-arrhead { display: flex; align-items: center; gap: 8px; }
  .cc-at-nav { width: 26px; height: 24px; border-radius: 6px; cursor: pointer; padding: 0;
    border: 1px solid #8a6c45; background: linear-gradient(180deg,#f7edd5,#e6d6b0);
    font-size: 12px; line-height: 1; color: #4b3517; font-family: inherit; }
  .cc-at-nav:hover { background: linear-gradient(180deg,#f0d99a,#e0c179); }
  .cc-at-arrname { flex: 1 1 auto; text-align: center; font-weight: 800; font-size: 13.5px; }
  .cc-at-arrdice { text-align: center; font-size: 15px; font-weight: 700; color: #4b3517;
    font-variant-numeric: tabular-nums; margin: 5px 0 3px; letter-spacing: .08em; }
  .cc-at-arrblurb { font-size: 11px; opacity: .7; line-height: 1.4; text-align: center; min-height: 31px; }
  .cc-at-dots { display: flex; justify-content: center; gap: 5px; margin-top: 4px; }
  .cc-at-dot { width: 6px; height: 6px; border-radius: 50%; background: #e6dabd; border: 1px solid #b79c72; }
  .cc-at-dot.on { background: #8a6c45; border-color: #6b543a; }

  /* Rows mirror the Status window: icon, label, die at the right edge. */
  .cc-at-rows { display: flex; flex-direction: column; gap: 7px; }
  .cc-at-row { display: flex; align-items: center; gap: 9px; padding: 7px 9px;
    border-radius: 8px; background: #f7f0df; border: 1px solid #cbb890; }
  .cc-at-row.is-raised { border-color: #8a6c45; background: #fdf6e4;
    box-shadow: inset 0 0 0 1px rgba(240,217,154,.7); }
  .cc-at-icon { width: 26px; height: 26px; object-fit: contain; flex: 0 0 auto;
    border: 0 !important; outline: 0 !important; background: none; }
  .cc-at-label { font-weight: 800; letter-spacing: .04em; width: 42px; flex: 0 0 auto; }
  .cc-at-die { font-size: 15px; flex: 1 1 auto; text-align: right; font-variant-numeric: tabular-nums; }
  .cc-at-die .was { opacity: .45; font-size: 13px; }
  .cc-at-die .now { color: #2f6b2f; }
  .cc-at-sel { font-family: inherit; font-size: 12px; padding: 3px 5px; border-radius: 6px;
    background: #fdf6e4; border: 1px solid #cbb890; color: #2f2618; flex: 0 0 auto; }
  .cc-at-sel:focus { outline: none; border-color: #8a6c45; }

  .cc-at-ms { border-radius: 8px; background: #f7f0df; border: 1px solid #cbb890; padding: 8px 9px; }
  .cc-at-mshead { font-size: 11px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; opacity: .65; margin-bottom: 6px; }
  .cc-at-msrow { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; font-size: 12px; }
  .cc-at-msrow:last-child { margin-bottom: 0; }
  .cc-at-msrow .k { opacity: .7; flex: 0 0 auto; }

  .cc-at-h { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    opacity: .65; margin-bottom: 4px; }
  .cc-at-stat { display: flex; align-items: baseline; justify-content: space-between;
    gap: 10px; font-size: 13px; padding: 2px 0; }
  .cc-at-stat .k { opacity: .75; }
  .cc-at-stat .v { font-weight: 700; font-variant-numeric: tabular-nums; }
  .cc-at-sep { height: 1px; background: #c0a67c; margin: 5px 0; }
  .cc-at-pending { margin-top: auto; padding-top: 10px; font-size: 11px; opacity: .7; line-height: 1.45; }
`;

/** Initiative is an average, so it can land on a half. */
const fmtInit = (v) => (Number.isInteger(v) ? String(v) : Number(v).toFixed(1));

/** The array's dice, high to low, so the dropdowns always read the same way. */
const diceOf = (key) => [...(CC.ARRAYS[key]?.dice ?? [])].sort((a, b) => b - a);

const arrayKeyOf = (d) =>
  ARRAY_ORDER.includes(d.attributes.arrayKey) ? d.attributes.arrayKey : "average";

function arrayCard(d) {
  const key = arrayKeyOf(d);
  const arr = CC.ARRAYS[key];
  return `
    <div class="cc-at-arr" data-wheel title="Scroll to change spread">
      <div class="cc-at-arrhead">
        <button class="cc-at-nav" data-cycle="-1" title="Previous spread">◀</button>
        <span class="cc-at-arrname">${esc(arr.label)}</span>
        <button class="cc-at-nav" data-cycle="1" title="Next spread">▶</button>
      </div>
      <div class="cc-at-arrdice">${diceOf(key).map((n) => `d${n}`).join("  ")}</div>
      <div class="cc-at-arrblurb">${esc(arr.blurb ?? "")}</div>
      <div class="cc-at-dots">
        ${ARRAY_ORDER.map((k) => `<span class="cc-at-dot ${k === key ? "on" : ""}"></span>`).join("")}
      </div>
    </div>`;
}

function attrRows(d) {
  const assign = d.attributes.assign ?? {};
  const dice = diceOf(arrayKeyOf(d));
  const final = effectiveBases(d);

  return CC_ATTR_KEYS.map((k) => {
    const chosen = num(assign[k], 0);
    const raised = chosen > 0 && num(final[k], 0) > chosen;
    const meta = ATTR_META[k];
    return `
      <div class="cc-at-row ${raised ? "is-raised" : ""}">
        <img class="cc-at-icon" src="${esc(meta.icon)}" alt="">
        <span class="cc-at-label" title="${esc(meta.full)}">${esc(meta.label)}</span>
        <span class="cc-at-die">${
          !chosen ? `<b style="opacity:.35">—</b>`
          : raised ? `<s class="was">d${chosen}</s> <b class="now">d${num(final[k], 0)}</b>`
          : `<b>d${chosen}</b>`
        }</span>
        <select class="cc-at-sel" data-assign="${k}" title="Assign a die from the spread">
          <option value="">—</option>
          ${dice.map((n) => `<option value="${n}" ${chosen === n ? "selected" : ""}>d${n}</option>`).join("")}
        </select>
      </div>`;
  }).join("");
}

function milestoneCard(d) {
  const need = draftMilestones(d);
  if (!need) return "";
  const picks = d.attributes.milestonePicks ?? [];
  return `
    <div class="cc-at-ms">
      <div class="cc-at-mshead">Milestone advances — ${need} earned</div>
      ${Array.from({ length: need }, (_, i) => `
        <div class="cc-at-msrow">
          <span class="k">Level ${CC.MILESTONES[i] ?? "?"}</span>
          <select class="cc-at-sel" data-ms="${i}" style="flex:1 1 auto">
            <option value="">— choose an attribute —</option>
            ${CC_ATTR_KEYS.map((k) =>
              `<option value="${k}" ${picks[i] === k ? "selected" : ""}>${esc(CC_ATTR_LABEL[k])}</option>`).join("")}
          </select>
        </div>`).join("")}
    </div>`;
}

function derivedPanel(d) {
  const p = previewDerived(d);
  const cell = (k, v) =>
    `<div class="cc-at-stat"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
  return `
    <div class="cc-at-h">Starting values</div>
    ${cell("HP", p.maxHp)}
    ${cell("MP", p.maxMp)}
    ${cell("IP", p.maxIp)}
    <div class="cc-at-sep"></div>
    ${cell("DEF", p.def)}
    ${cell("MDEF", p.mdef)}
    ${cell("Initiative", fmtInit(p.init))}
    <div class="cc-at-sep"></div>
    ${cell("Crisis", p.crisis)}
    <div class="cc-at-pending">
      Base values only. Class benefits (+5 HP, +5 MP or +2 IP each) and equipment
      are added in the steps after this one.
    </div>`;
}

function render(d) {
  return `
    <style>${CSS}</style>
    <div class="cc-at">
      <div class="cc-at-left">
        <div class="cc-at-lvl">
          <label for="cc-level">Level</label>
          <input id="cc-level" type="number" data-level
                 min="${CC.RULE.MIN_LEVEL}" max="${CC.RULE.MAX_LEVEL}" value="${num(d.attributes.level, 5)}">
          <span class="cc-at-lvlnote">${draftPointPool(d)} Skill Points<br>${draftBudget(d)} zenit to spend</span>
        </div>
        ${arrayCard(d)}
        <div class="cc-at-rows">${attrRows(d)}</div>
        ${milestoneCard(d)}
      </div>
      <div class="cc-at-right">${derivedPanel(d)}</div>
    </div>`;
}

function bind(root, d, ctx) {
  root.querySelector("[data-level]")?.addEventListener("change", (ev) => {
    const raw = Math.round(Number(ev.target.value));
    const lvl = Math.max(CC.RULE.MIN_LEVEL,
      Math.min(CC.RULE.MAX_LEVEL, Number.isFinite(raw) ? raw : CC.RULE.START_LEVEL));
    ctx.edit((dd) => { dd.attributes.level = lvl; });
  });

  // Arrows and the wheel do the same thing, so they share one path.
  const cycle = (dir) => ctx.edit((dd) => {
    const at = ARRAY_ORDER.indexOf(dd.attributes.arrayKey);
    const from = at < 0 ? ARRAY_ORDER.indexOf("average") : at;
    dd.attributes.arrayKey = ARRAY_ORDER[(from + dir + ARRAY_ORDER.length) % ARRAY_ORDER.length];
    // The previous spread's dice are gone, so an assignment made from it now
    // refers to a pool that does not exist. Reconcile would clear it anyway;
    // doing it here stops a row flashing a die that is no longer on offer.
    dd.attributes.assign = {};
  });

  root.querySelectorAll("[data-cycle]").forEach((b) =>
    b.addEventListener("click", () => cycle(Number(b.dataset.cycle))));

  root.querySelector("[data-wheel]")?.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    cycle(ev.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  /**
   * Assignment is a SWAP, so the array stays a permutation of itself.
   *
   * Giving MIG the d10 that DEX holds must move it rather than copy it — the
   * alternative is a player quietly handing themselves four d10s. Doing it as a
   * swap makes the invalid spread unreachable instead of merely rejected.
   */
  root.querySelectorAll("[data-assign]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const key = sel.dataset.assign;
      const want = num(sel.value, 0);
      ctx.edit((dd) => {
        const a = dd.attributes.assign;
        if (!want) { delete a[key]; return; }
        const holder = CC_ATTR_KEYS.find((k) => k !== key && num(a[k], 0) === want);
        const had = num(a[key], 0);
        a[key] = want;
        if (holder) { if (had) a[holder] = had; else delete a[holder]; }
      });
    });
  });

  root.querySelectorAll("[data-ms]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const i = num(sel.dataset.ms, 0);
      ctx.edit((dd) => {
        const picks = dd.attributes.milestonePicks ?? (dd.attributes.milestonePicks = []);
        picks[i] = sel.value;
      });
    });
  });
}

STEP_RENDERERS.set("attributes", { render, bind });
