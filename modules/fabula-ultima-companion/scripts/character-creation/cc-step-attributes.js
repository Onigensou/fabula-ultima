/**
 * Character Creation — step 2: Attributes.
 *
 * Level, one of the three starting arrays (p.162), assignment of that array's
 * dice to MIG/DEX/INS/WLP, and — for characters created at level 20 or 40 — the
 * permanent die steps those milestones grant (p.227).
 *
 * ASSIGNMENT IS DRAG AND DROP
 * ---------------------------
 * The array is a tray of four dice; each attribute is an empty socket. You drag
 * a die into a socket. Because a die physically leaves the tray when it is
 * placed, the pool cannot be duplicated — the invalid spread is unreachable
 * rather than merely rejected, and there is no dropdown whose selected value
 * can disagree with the draft.
 *
 * (It replaced exactly that: a set of dropdowns whose selection did not survive
 * the re-render, so choosing a die appeared to do nothing and the step then
 * complained that no die had been chosen.)
 *
 * Dropping onto an occupied socket swaps the two dice. Dropping a socket's die
 * back on the tray returns it. Clicking a socket also returns its die, because
 * dragging something to nowhere in particular is a poor way to say "undo".
 *
 * Switching array resets every socket: the dice on offer have changed, so any
 * previous placement refers to a pool that no longer exists.
 *
 * MILESTONES
 * ----------
 * A character created above level 20 has already earned those advances and is
 * entitled to them at creation — an explicit table ruling. They are picked here
 * and written to the attribute system's own ledger at finalize, so the badge
 * does not later offer them a second time.
 *
 * The derived panel shows BASE values only. Class benefits and equipment are
 * added in later steps and are totalled on the summary.
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

/**
 * The class free benefits, counted ONCE per class.
 *
 * A class grants its benefit when it is first taken, not at every level in it —
 * which is why `class_list` carries one benefit column per class row. Counting
 * per level would inflate a level-10 mono-class build by 45 HP.
 */
export function benefitTally(d) {
  const perClass = new Map();
  for (const c of d?.classes ?? []) if (!perClass.has(c.classKey)) perClass.set(c.classKey, c.benefit);
  const out = { hp: 0, mp: 0, ip: 0, classes: perClass.size };
  for (const b of perClass.values()) {
    if (b === "hp") out.hp += 5;
    else if (b === "mp") out.mp += 5;
    else if (b === "ip") out.ip += 2;
  }
  return out;
}

/**
 * Everything the character actually starts with.
 *
 * `equip` is the gear contribution, from `equipBonuses` in the equipment step.
 * It is passed in rather than imported so this stays the one place derived
 * numbers are worked out, without this module needing to know what an item is.
 *
 * Martial armour REPLACES the DEX die with a flat value; ordinary armour adds
 * to it. That is the rule the equipment macro implements, and it is why `def`
 * cannot simply be a sum.
 */
export function finalDerived(d, equip = null) {
  const base = previewDerived(d);
  const t = benefitTally(d);
  const e = equip ?? { defBase: null, defBonus: 0, mdefBase: null, mdefBonus: 0, initPenalty: 0 };

  const maxHp = base.maxHp + t.hp;
  const maxMp = base.maxMp + t.mp;
  const maxIp = base.maxIp + t.ip;

  const def = (e.defBase == null ? base.def : e.defBase) + num(e.defBonus, 0);
  const mdef = (e.mdefBase == null ? base.mdef : e.mdefBase) + num(e.mdefBonus, 0);

  return {
    maxHp, maxMp, maxIp,
    crisis: Math.floor(maxHp / 2),
    def, mdef,
    init: base.init - num(e.initPenalty, 0),
    base, bonus: t, equip: e,
  };
}

// ── view ───────────────────────────────────────────────────────────────────

/** The three arrays in a fixed order, so the arrows and the wheel agree. */
const ARRAY_ORDER = Object.freeze(["jack", "average", "specialized"]);

const CSS = `
  .cc-at { display: flex; gap: 0; min-height: 0; margin: 0 -16px -14px; }
  .cc-at-left { flex: 1 1 auto; min-width: 0; padding: 0 14px 12px; display: flex;
    flex-direction: column; gap: 10px; }
  .cc-at-right { flex: 0 0 auto; width: 268px; padding: 12px 14px;
    background: #e6dabd; border-left: 1px solid #b79c72;
    display: flex; flex-direction: column; gap: 3px; }

  .cc-at-lvl { display: flex; align-items: center; gap: 9px; padding: 7px 10px;
    border-radius: 8px; background: #f7f0df; border: 1px solid #cbb890; }
  .cc-at-lvl label { font-weight: 800; font-size: 13px; }
  .cc-at-lvl input { width: 58px; text-align: center; font-family: inherit; font-size: 15px;
    font-weight: 700; color: #2f2618; padding: 4px 6px; border-radius: 6px;
    background: #fdf6e4; border: 1px solid #cbb890; }
  .cc-at-lvl input:focus { outline: none; border-color: #8a6c45; }
  .cc-at-step { width: 24px; height: 24px; border-radius: 6px; cursor: pointer; padding: 0;
    border: 1px solid #8a6c45; background: linear-gradient(180deg,#f7edd5,#e6d6b0);
    font-family: inherit; font-size: 12px; line-height: 1; color: #4b3517; }
  .cc-at-step:hover { background: linear-gradient(180deg,#f0d99a,#e0c179); }

  /* ── the tray: one array at a time ── */
  .cc-at-tray { border-radius: 8px; background: #f7f0df; border: 1px solid #cbb890; padding: 9px 10px; }
  .cc-at-trayhead { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .cc-at-nav { width: 26px; height: 24px; border-radius: 6px; cursor: pointer; padding: 0;
    border: 1px solid #8a6c45; background: linear-gradient(180deg,#f7edd5,#e6d6b0);
    font-size: 12px; line-height: 1; color: #4b3517; font-family: inherit; }
  .cc-at-nav:hover { background: linear-gradient(180deg,#f0d99a,#e0c179); }
  .cc-at-trayname { flex: 1 1 auto; text-align: center; font-weight: 800; font-size: 13.5px; }
  .cc-at-dots { display: flex; gap: 5px; }
  .cc-at-dot { width: 6px; height: 6px; border-radius: 50%; background: #e6dabd; border: 1px solid #b79c72; }
  .cc-at-dot.on { background: #8a6c45; border-color: #6b543a; }
  .cc-at-trayblurb { font-size: 11px; opacity: .65; text-align: center; margin-bottom: 8px; }

  .cc-at-dice { display: flex; gap: 9px; justify-content: center; min-height: 52px;
    padding: 6px; border-radius: 8px; background: #efe4cd; border: 1px dashed #cbb890; }
  .cc-at-dice.drop-on { border-color: #8a6c45; background: #fdf6e4; }
  .cc-at-trayempty { font-size: 11.5px; opacity: .55; align-self: center; }

  /* A die is the draggable object, in the tray and in a socket alike. */
  .cc-at-die { width: 44px; height: 40px; border-radius: 8px; cursor: grab;
    display: grid; place-items: center; font-weight: 800; font-size: 15px;
    color: #4b3517; background: linear-gradient(180deg,#f0d99a,#e0c179);
    border: 1px solid #8a6c45; user-select: none; font-variant-numeric: tabular-nums;
    transition: transform .1s, box-shadow .1s; }
  .cc-at-die:hover { transform: translateY(-1px); box-shadow: 0 3px 8px rgba(90,56,0,.25); }
  .cc-at-die.dragging { opacity: .35; cursor: grabbing; }
  .cc-at-die.raised { background: linear-gradient(180deg,#8fd07a,#5f9e4a); border-color: #2f6b2f;
    color: #163d13; }

  /* ── sockets ── */
  .cc-at-rows { display: flex; flex-direction: column; gap: 7px; }
  .cc-at-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px;
    border-radius: 8px; background: #f7f0df; border: 1px solid #cbb890; }
  .cc-at-row.drop-on { border-color: #8a6c45; background: #fdf6e4;
    box-shadow: inset 0 0 0 1px rgba(240,217,154,.9); }
  .cc-at-icon { width: 28px; height: 28px; object-fit: contain; flex: 0 0 auto;
    border: 0 !important; outline: 0 !important; background: none; }
  .cc-at-label { font-weight: 800; letter-spacing: .04em; width: 44px; flex: 0 0 auto; }
  .cc-at-full { flex: 1 1 auto; font-size: 11.5px; opacity: .55; }
  .cc-at-socket { width: 48px; height: 44px; border-radius: 9px; flex: 0 0 auto;
    display: grid; place-items: center; background: #efe4cd;
    border: 2px dashed #c0a67c; }
  .cc-at-socket.filled { border-style: solid; border-color: #8a6c45; background: transparent;
    cursor: pointer; }
  .cc-at-was { font-size: 11px; opacity: .5; flex: 0 0 auto; width: 34px; text-align: right; }

  /* ── milestones ── */
  .cc-at-ms { border-radius: 8px; background: #f7f0df; border: 1px solid #cbb890; padding: 8px 10px; }
  .cc-at-mshead { font-size: 11px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; opacity: .65; margin-bottom: 6px; }
  .cc-at-msrow { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; font-size: 12px; }
  .cc-at-msrow:last-child { margin-bottom: 0; }
  .cc-at-msrow .k { opacity: .7; flex: 0 0 auto; }
  .cc-at-mssel { flex: 1 1 auto; font-family: inherit; font-size: 12px; padding: 4px 6px;
    border-radius: 6px; background: #fdf6e4; border: 1px solid #cbb890; color: #2f2618; }
  .cc-at-mssel:focus { outline: none; border-color: #8a6c45; }

  /* ── derived ── */
  .cc-at-h { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    opacity: .65; margin-bottom: 4px; }
  .cc-at-stat { display: flex; align-items: center; justify-content: space-between;
    gap: 10px; font-size: 13px; padding: 2px 0; }
  .cc-at-stat .k { display: flex; align-items: center; gap: 7px; opacity: .85; }
  /* A fixed icon column keeps the labels on one left edge regardless of how
     wide each glyph happens to be. */
  .cc-at-stat .k i, .cc-at-res i { width: 15px; text-align: center; opacity: .65; }
  .cc-at-stat .k i.is-hp { color: #a3453a; opacity: .85; }
  .cc-at-stat .k i.is-mp { color: #3a6ea3; opacity: .85; }
  .cc-at-stat .k i.is-ip { color: #3f7a30; opacity: .85; }
  .cc-at-stat .v { font-weight: 700; font-variant-numeric: tabular-nums; }
  .cc-at-sep { height: 1px; background: #c0a67c; margin: 5px 0; }
  .cc-at-res { display: flex; align-items: center; justify-content: space-between;
    padding: 5px 8px; border-radius: 7px; background: #f7f0df; border: 1px solid #cbb890;
    font-size: 12.5px; margin-top: 4px; }
  .cc-at-res span:first-child { display: flex; align-items: center; gap: 7px; }
  .cc-at-res .v { font-weight: 800; font-variant-numeric: tabular-nums; }
  .cc-at-pending { margin-top: auto; padding-top: 10px; font-size: 11px; opacity: .65; line-height: 1.45; }
`;

/**
 * Font Awesome ships with Foundry, so these need no asset fetch and inherit the
 * text colour — which the PNG stat icons could not.
 */
const STAT_ICON = Object.freeze({
  hp: "fa-heart",
  mp: "fa-droplet",
  ip: "fa-flask",
  def: "fa-shield-halved",
  mdef: "fa-hat-wizard",
  init: "fa-bolt",
  crisis: "fa-heart-crack",
  sp: "fa-star",
  zenit: "fa-coins",
});

const fmtInit = (v) => (Number.isInteger(v) ? String(v) : Number(v).toFixed(1));
const arrayKeyOf = (d) =>
  ARRAY_ORDER.includes(d.attributes.arrayKey) ? d.attributes.arrayKey : "average";

/**
 * Which dice are still in the tray.
 *
 * The array is a multiset — "Average" is d10 d8 d8 d6, two of them the same —
 * so this removes one instance per placement rather than filtering by value,
 * which would empty both d8 slots the moment either was placed.
 */
export function trayDice(d) {
  const pool = [...(CC.ARRAYS[arrayKeyOf(d)]?.dice ?? [])].sort((a, b) => b - a);
  for (const k of CC_ATTR_KEYS) {
    const placed = num(d.attributes.assign[k], 0);
    if (!placed) continue;
    const i = pool.indexOf(placed);
    if (i >= 0) pool.splice(i, 1);
  }
  return pool;
}

/**
 * Move a die from `from` to `target`, mutating the assignment in place.
 *
 * `from` and `target` are each an attribute key or the string "tray".
 * Socket → socket swaps; tray → socket displaces whatever was there back to the
 * tray; anything → tray just removes it.
 *
 * The pool cannot inflate here because a die is only ever moved, never copied:
 * every path either deletes the source key or writes the displaced value into
 * it. That is the property the old dropdown version could not guarantee.
 *
 * @returns {boolean} whether anything changed
 */
export function placeDie(assign, { die, from }, target) {
  if (!from || !target || from === target) return false;

  if (target === "tray") {
    if (!(from in assign)) return false;
    delete assign[from];
    return true;
  }

  const displaced = num(assign[target], 0);
  assign[target] = num(die, 0);
  if (from !== "tray") {
    if (displaced) assign[from] = displaced;
    else delete assign[from];
  }
  return true;
}

function trayHTML(d) {
  const key = arrayKeyOf(d);
  const arr = CC.ARRAYS[key];
  const left = trayDice(d);
  return `
    <div class="cc-at-tray" data-wheel>
      <div class="cc-at-trayhead">
        <button class="cc-at-nav" data-cycle="-1" title="Previous spread">◀</button>
        <span class="cc-at-trayname">${esc(arr.label)}</span>
        <span class="cc-at-dots">
          ${ARRAY_ORDER.map((k) => `<span class="cc-at-dot ${k === key ? "on" : ""}"></span>`).join("")}
        </span>
        <button class="cc-at-nav" data-cycle="1" title="Next spread">▶</button>
      </div>
      <div class="cc-at-trayblurb">${esc(arr.blurb ?? "")}</div>
      <div class="cc-at-dice" data-tray>
        ${left.length
          ? left.map((n) => `<div class="cc-at-die" draggable="true" data-die="${n}" data-from="tray">d${n}</div>`).join("")
          : `<span class="cc-at-trayempty">All four placed.</span>`}
      </div>
    </div>`;
}

function rowsHTML(d) {
  const assign = d.attributes.assign ?? {};
  const final = effectiveBases(d);

  return CC_ATTR_KEYS.map((k) => {
    const placed = num(assign[k], 0);
    const raised = placed > 0 && num(final[k], 0) > placed;
    const shown = raised ? num(final[k], 0) : placed;
    const meta = ATTR_META[k];
    return `
      <div class="cc-at-row" data-slot="${k}">
        <img class="cc-at-icon" src="${esc(meta.icon)}" alt="">
        <span class="cc-at-label">${esc(meta.label)}</span>
        <span class="cc-at-full">${esc(meta.full)}</span>
        <span class="cc-at-was">${raised ? `d${placed} →` : ""}</span>
        <div class="cc-at-socket ${placed ? "filled" : ""}" data-slot="${k}"
             title="${placed ? "Drag out, or click to return it to the tray" : "Drop a die here"}">
          ${placed
            ? `<div class="cc-at-die ${raised ? "raised" : ""}" draggable="true"
                    data-die="${placed}" data-from="${k}">d${shown}</div>`
            : ""}
        </div>
      </div>`;
  }).join("");
}

function milestoneHTML(d) {
  const need = draftMilestones(d);
  if (!need) return "";
  const picks = d.attributes.milestonePicks ?? [];
  return `
    <div class="cc-at-ms">
      <div class="cc-at-mshead">Milestone advances — ${need} earned</div>
      ${Array.from({ length: need }, (_, i) => `
        <div class="cc-at-msrow">
          <span class="k">Level ${CC.MILESTONES[i] ?? "?"}</span>
          <select class="cc-at-mssel" data-ms="${i}">
            <option value="">— choose an attribute —</option>
            ${CC_ATTR_KEYS.map((k) =>
              `<option value="${k}" ${picks[i] === k ? "selected" : ""}>${esc(CC_ATTR_LABEL[k])}</option>`).join("")}
          </select>
        </div>`).join("")}
    </div>`;
}

function derivedHTML(d) {
  const p = previewDerived(d);
  const stat = (label, value, icon, cls = "") => `
    <div class="cc-at-stat">
      <span class="k"><i class="fas ${icon} ${cls}"></i>${esc(label)}</span>
      <span class="v">${value}</span>
    </div>`;
  return `
    <div class="cc-at-h">Starting values</div>
    ${stat("HP", p.maxHp, STAT_ICON.hp, "is-hp")}
    ${stat("MP", p.maxMp, STAT_ICON.mp, "is-mp")}
    ${stat("IP", p.maxIp, STAT_ICON.ip, "is-ip")}
    <div class="cc-at-sep"></div>
    ${stat("DEF", p.def, STAT_ICON.def)}
    ${stat("MDEF", p.mdef, STAT_ICON.mdef)}
    ${stat("Initiative", fmtInit(p.init), STAT_ICON.init)}
    <div class="cc-at-sep"></div>
    ${stat("Crisis", p.crisis, STAT_ICON.crisis, "is-hp")}

    <div class="cc-at-res">
      <span><i class="fas ${STAT_ICON.sp}"></i> Skill Points</span>
      <span class="v">${draftPointPool(d)}</span>
    </div>
    <div class="cc-at-res">
      <span><i class="fas ${STAT_ICON.zenit}" style="color:#b8862a"></i> Zenit</span>
      <span class="v">${draftBudget(d)}</span>
    </div>

    <div class="cc-at-pending">
      Base values. Class benefits and equipment are added in the next steps,
      and totalled on the summary.
    </div>`;
}

function render(d) {
  return `
    <style>${CSS}</style>
    <div class="cc-at">
      <div class="cc-at-left">
        <div class="cc-at-lvl">
          <label for="cc-level">Level</label>
          <button class="cc-at-step" data-lvl="-1" title="Lower">−</button>
          <input id="cc-level" type="number" data-level
                 min="${CC.RULE.MIN_LEVEL}" max="${CC.RULE.MAX_LEVEL}" value="${num(d.attributes.level, 5)}">
          <button class="cc-at-step" data-lvl="1" title="Raise">+</button>
        </div>
        ${trayHTML(d)}
        <div class="cc-at-rows">${rowsHTML(d)}</div>
        ${milestoneHTML(d)}
      </div>
      <div class="cc-at-right">${derivedHTML(d)}</div>
    </div>`;
}

// ── drag and drop ──────────────────────────────────────────────────────────

/**
 * A drag carries "where the die came from": a slot key, or "tray".
 *
 * Held in a module variable as well as the DataTransfer because Foundry's
 * canvas drag handlers can swallow `dragover`/`drop` payloads, and reading our
 * own copy is more reliable than trusting the event to survive the trip.
 */
let _drag = null;   // { die: number, from: "tray" | attrKey }

function bind(root, d, ctx) {
  // ── level ──
  const lvlInput = root.querySelector("[data-level]");
  const setLevel = (n) => {
    const lvl = Math.max(CC.RULE.MIN_LEVEL, Math.min(CC.RULE.MAX_LEVEL, Math.round(n)));
    ctx.edit((dd) => { dd.attributes.level = lvl; });
  };
  lvlInput?.addEventListener("change", () => {
    const raw = Number(lvlInput.value);
    setLevel(Number.isFinite(raw) ? raw : CC.RULE.START_LEVEL);
  });
  root.querySelectorAll("[data-lvl]").forEach((b) =>
    b.addEventListener("click", () => setLevel(draftLevel(d) + Number(b.dataset.lvl))));

  // ── array cycling ──
  const cycle = (dir) => ctx.edit((dd) => {
    const at = ARRAY_ORDER.indexOf(dd.attributes.arrayKey);
    const from = at < 0 ? ARRAY_ORDER.indexOf("average") : at;
    dd.attributes.arrayKey = ARRAY_ORDER[(from + dir + ARRAY_ORDER.length) % ARRAY_ORDER.length];
    // A full reset, as agreed: the dice on offer have changed, so every
    // placement now refers to a pool that no longer exists.
    dd.attributes.assign = {};
  });
  root.querySelectorAll("[data-cycle]").forEach((b) =>
    b.addEventListener("click", () => cycle(Number(b.dataset.cycle))));
  root.querySelector("[data-wheel]")?.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    cycle(ev.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  // ── dragging a die ──
  root.querySelectorAll("[data-die]").forEach((die) => {
    die.addEventListener("dragstart", (ev) => {
      _drag = { die: num(die.dataset.die, 0), from: die.dataset.from };
      die.classList.add("dragging");
      try {
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", JSON.stringify(_drag));
      } catch { /* the module copy is the one we actually read */ }
    });
    die.addEventListener("dragend", () => { die.classList.remove("dragging"); _drag = null; });
  });

  const drop = (target) => {
    const drag = _drag;
    _drag = null;
    if (!drag) return;
    ctx.edit((dd) => placeDie(dd.attributes.assign, drag, target));
  };

  const wireZone = (el, target) => {
    if (!el) return;
    el.addEventListener("dragover", (ev) => {
      if (!_drag) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      el.classList.add("drop-on");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-on"));
    el.addEventListener("drop", (ev) => {
      ev.preventDefault();
      el.classList.remove("drop-on");
      drop(target);
    });
  };

  wireZone(root.querySelector("[data-tray]"), "tray");
  root.querySelectorAll(".cc-at-row[data-slot]").forEach((row) => wireZone(row, row.dataset.slot));

  // Clicking a filled socket returns its die. Dragging to nowhere in particular
  // is a poor way to say "undo".
  root.querySelectorAll(".cc-at-socket.filled").forEach((sock) => {
    sock.addEventListener("click", () => {
      ctx.edit((dd) => { delete dd.attributes.assign[sock.dataset.slot]; });
    });
  });

  // ── milestones ──
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
