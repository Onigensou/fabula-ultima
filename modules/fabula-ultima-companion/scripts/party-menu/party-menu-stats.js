// Party Menu — Status page subtabs: Battle, Resistance, Weapons, Social.
//
// A read-only stat sheet ported from the approved mockup (2026-11-26, round 9:
// https://claude.ai/artifact/LsfLLeFfwq4YJnB3jvAG7G). Every section is one
// full-width header with its rows flowing into two columns (Resistance: three).
// Static: every row always shows; zeros are a faint dash.
//
// Numbers: totals are read from the sheet (CSB has already aggregated every
// effect — formulas, equip gates, aeWhen); the hover card lists WHERE they come
// from, using the Effects tab's own per-effect amounts (party-menu-effects.js),
// plus a "Character sheet" line for any part no effect explains. Element / range
// rows are TOTALS (they include All). Damage reduction reads Genshin-style: a
// positive number; a net vulnerability is a red minus. The reduction curve is
// QUIET (shared/stat-rules.js) — the row shows the final number and nothing on
// screen explains it.

import { esc } from "./party-menu-ui.js";
import { effectRowsOf } from "./party-menu-effects.js";
import { effectiveReductionPct, ELEMENTS } from "../shared/stat-rules.js";
import { orbmentReduction } from "../orbment/orbment-dr.js";
import { lookupTerm } from "../battle-director/keyword-registry.js";
import { sumEquippedCheckBuffs } from "../battle-director/skill-effects.js";
import { wornItem } from "../shared/equipped-gear.js";

export const STAT_TABS = [
  { id: "eff", label: "Effects", icon: "fa-layer-group" },
  { id: "bt", label: "Battle", icon: "fa-burst" },
  { id: "res", label: "Resistance", icon: "fa-shield-virus" },
  { id: "wpn", label: "Weapons", icon: "fa-khanda" },
  { id: "soc", label: "Social", icon: "fa-comments" },
];

const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : "");
const num = (v, d = 0) => { const n = parseFloat(String(v ?? "").replace("%", "")); return Number.isFinite(n) ? n : d; };
const round1 = (x) => Math.round(x * 10) / 10;
const EL_ICON = {
  physical: "fa-hand-fist", air: "fa-wind", bolt: "fa-bolt", dark: "fa-moon", earth: "fa-mountain",
  fire: "fa-fire", ice: "fa-snowflake", light: "fa-sun", poison: "fa-skull-crossbones",
};

// ── sources: every active effect amount, by sheet key ────────────────────────
// { name, kind, img, icon, add, n, mode, raw, cond }. `cond` = an effect whose
// formula resolves to nothing right now (Adversity "+2 per status") — the row
// gets an "if" chip and the card lists it as "when active".
function sourcesByKey(actor) {
  const out = new Map();
  const push = (k, s) => { if (!out.has(k)) out.set(k, []); out.get(k).push(s); };
  for (const row of effectRowsOf(actor)) {
    for (const entry of row.sources ?? []) {
      const src = entry.source;
      const base = { name: src?.name ?? row.name, kind: src?.kind ?? "effect", img: src?.img || row.img || "" };
      for (const a of entry.amounts ?? []) {
        const key = String(a.key ?? "").replace(/^system\.props\./, "").replace(/^target\./, "");
        if (a.active) push(key, { ...base, add: typeof a.add === "number" ? a.add : null, n: a.n, mode: a.mode, raw: a.raw });
        else if (a.mode === 2) {
          const ch = (entry.eff?.changes ?? []).find((c) => String(c.key).replace(/^system\.props\./, "") === key);
          if (/\$\{|ae\w*When\s*\(/i.test(String(ch?.value ?? ""))) push(key, { ...base, add: 0, cond: true });
        }
      }
    }
  }
  return out;
}

// A row: { label, icon, kind ("up" | "guard"), flat, pct, srcs[], noFlat?, noPct?, span?, ... }.
// `srcs` lines carry { name, kind, img, icon, flat, pct, ef, grade, cond, off, viaAll }.
function linesFor(S, keys, field, { viaAllKeys = [], scale = 1 } = {}) {
  const lines = [];
  for (const k of keys) for (const s of S.get(k) ?? []) {
    const v = s.cond ? 0 : (typeof s.add === "number" ? s.add : num(s.n)) * scale;
    lines.push({ name: s.name, kind: s.kind, img: s.img, [field]: v, cond: !!s.cond, viaAll: viaAllKeys.includes(k) });
  }
  return lines;
}
// Adds a "Character sheet" line for any part of the total no effect explains.
function withRemainder(lines, field, total) {
  const explained = lines.reduce((t, l) => t + (Number(l[field]) || 0), 0);
  const rest = round1(total - explained);
  if (rest !== 0) lines.push({ name: "Character sheet", kind: "base", icon: "fa-scroll", [field]: rest });
  return lines;
}
function mergeLines(...lists) {
  const out = [];
  for (const l of lists.flat()) {
    const hit = out.find((o) => o.name === l.name && o.viaAll === l.viaAll && o.kind === l.kind);
    if (hit) { for (const f of ["flat", "pct", "ef"]) if (l[f] != null) hit[f] = (hit[f] ?? 0) + l[f]; hit.cond ||= l.cond; }
    else out.push({ ...l });
  }
  return out;
}

// ── model ─────────────────────────────────────────────────────────────────────
const DEAL_CATS = [["all", "All damage", "fa-burst"], ["melee", "Melee", "fa-hand-back-fist"], ["ranged", "Ranged", "fa-crosshairs"],
  ["spell", "Spell", "fa-wand-sparkles"], ...ELEMENTS.map((e) => [e, cap(e), EL_ICON[e]])];
const TAKE_CATS = DEAL_CATS.filter(([c]) => c !== "spell");

function dealRow(p, S, [cat, label, icon]) {
  const fk = ["extra_damage_mod_all", ...(cat === "all" ? [] : [`extra_damage_mod_${cat}`])];
  const pk = ["damage_outgoing_percentage_all", ...(cat === "all" ? [] : [`damage_outgoing_percentage_${cat}`])];
  const flat = fk.reduce((t, k) => t + num(p[k]), 0), pct = pk.reduce((t, k) => t + num(p[k]), 0);
  const fl = withRemainder(linesFor(S, fk, "flat", { viaAllKeys: cat === "all" ? [] : ["extra_damage_mod_all"] }), "flat", flat);
  const pl = withRemainder(linesFor(S, pk, "pct", { viaAllKeys: cat === "all" ? [] : ["damage_outgoing_percentage_all"] }), "pct", pct);
  return { label, icon, kind: "up", flat, pct, isAll: cat === "all", srcs: mergeLines(fl, pl), title: `${label} dealt` };
}

function takeRow(actor, p, S, [cat, label, icon]) {
  const rk = cat === "ranged" ? "range" : cat;   // the sheet's ranged reduction keys are `_range`
  const fk = ["damage_receiving_mod_all", ...(cat === "all" ? [] : [`damage_receiving_mod_${rk}`])];
  const pk = ["damage_receiving_percentage_all", ...(cat === "all" ? [] : [`damage_receiving_percentage_${rk}`])];
  const orb = orbmentReduction(actor, ELEMENTS.includes(cat) ? cat : null) ?? { flat: 0, pct: 0 };
  const flatSheet = fk.reduce((t, k) => t + num(p[k]), 0), pctSheet = pk.reduce((t, k) => t + num(p[k]), 0);
  const fl = withRemainder(linesFor(S, fk, "flat", { viaAllKeys: cat === "all" ? [] : ["damage_receiving_mod_all"] }), "flat", flatSheet);
  const pl = withRemainder(linesFor(S, pk, "pct", { viaAllKeys: cat === "all" ? [] : ["damage_receiving_percentage_all"] }), "pct", pctSheet);
  const orbLine = orb.flat || orb.pct ? [{ name: "Orbment", kind: "orbment", icon: "fa-gem", flat: orb.flat || null, pct: orb.pct || null }] : [];
  const flat = flatSheet + (orb.flat || 0);
  const pct = effectiveReductionPct(pctSheet + (orb.pct || 0));   // the QUIET curve: final number only
  return { label, icon, kind: "guard", flat, pct, isAll: cat === "all", srcs: mergeLines(fl, pl, orbLine), title: `${label} reduction` };
}

// Crit chance on the character's main check: the main-hand weapon's two attributes,
// or Improvised (Melee) — DEX + MIG — with nothing in hand.
function critCheck(actor, p) {
  const w = wornItem(actor, "main");
  const wp = w?.system?.props ?? null;
  const isWeapon = wp && String(wp.item_type ?? "").toLowerCase() === "weapon" && wp.rolled_atr1;
  const a = isWeapon ? String(wp.rolled_atr1).toUpperCase() : "DEX";
  const b = isWeapon ? String(wp.rolled_atr2 || wp.rolled_atr1).toUpperCase() : "MIG";
  const die = (x) => num(p[`${x.toLowerCase()}_current`], num(p[`${x.toLowerCase()}_base`], 8)) || 8;
  return { label: isWeapon ? w.name : "Improvised weapon", a: [a, die(a)], b: [b, die(b)] };
}
function critChance(chk, range, min) {
  let hit = 0;
  for (let x = 1; x <= chk.a[1]; x++) for (let y = 1; y <= chk.b[1]; y++) if (Math.abs(x - y) <= range && (x >= min || y >= min)) hit++;
  return Math.round(hit / (chk.a[1] * chk.b[1]) * 1000) / 10;
}

function battleModel(actor) {
  const p = actor.system?.props ?? {};
  const S = sourcesByKey(actor);
  const deal = DEAL_CATS.map((c) => dealRow(p, S, c));
  const take = TAKE_CATS.map((c) => takeRow(actor, p, S, c));

  const checkRow = (cat, label, icon) => {
    const keys = ["check_mod_all", ...(cat === "all" ? [] : [`check_mod_${cat}`])];
    const flat = keys.reduce((t, k) => t + num(p[k]), 0);
    return { label, icon, kind: "up", flat, noPct: true, isAll: cat === "all", title: label,
      srcs: withRemainder(linesFor(S, keys, "flat", { viaAllKeys: cat === "all" ? [] : ["check_mod_all"] }), "flat", flat) };
  };
  const initFlat = num(p.check_mod_init) + num(p.init_penalty);
  const checks = [
    checkRow("all", "All checks", "fa-dice-d20"), checkRow("accuracy", "Accuracy", "fa-bullseye"), checkRow("magic", "Magic", "fa-wand-sparkles"),
    checkRow("melee", "Melee", "fa-hand-back-fist"), checkRow("ranged", "Ranged", "fa-crosshairs"),
    { label: "Initiative", icon: "fa-forward-fast", kind: "up", flat: initFlat, noPct: true, title: "Initiative",
      tipNote: "Added to your Initiative roll. The same number as INIT on the left.",
      srcs: withRemainder(linesFor(S, ["check_mod_init", "init_penalty"], "flat"), "flat", initFlat) },
  ];

  const range = num(p.critical_dice_range), min = num(p.minimum_critical_dice, 6) || 6;
  const chk = critCheck(actor, p), chance = critChance(chk, range, min);
  const cmult = num(p.critical_damage_multiplier, 1) || 1, cflat = num(p.critical_damage_bonus);
  const crit = [
    { label: "Crit chance", icon: "fa-percent", kind: "up", span: `${chance}%`, spanCls: range ? "is-up" : "is-rule", title: "Crit chance", srcs: [],
      tipNote: `Your ${esc(chk.label)} check (${chk.a[0]} d${chk.a[1]} + ${chk.b[0]} d${chk.b[1]}), Crit range ${range}, lowest crit die ${min}.` },
    { label: "Crit range", icon: "fa-arrows-left-right", kind: "up", flat: range, noPct: true, title: "Crit range",
      tipNote: range ? `The two dice can be up to ${range} apart and still crit.` : "0 = the two dice must match.",
      srcs: withRemainder(linesFor(S, ["critical_dice_range"], "flat"), "flat", range) },
    { label: "Lowest crit die", icon: "fa-dice", kind: "up", span: `${min}+`, spanCls: "is-rule", title: "Lowest crit die", srcs: [],
      tipNote: `At least one die must show ${min} or higher.` },
    { label: "Crit damage", icon: "fa-bolt-lightning", kind: "up", flat: cflat, pct: round1((cmult - 1) * 100), title: "Crit damage",
      tipNote: "A crit gives an Opportunity. It only adds damage when an effect grants Crit damage.",
      srcs: mergeLines(withRemainder(linesFor(S, ["critical_damage_bonus"], "flat"), "flat", cflat),
        linesFor(S, ["critical_damage_multiplier"], "pct").map((l) => ({ ...l, pct: round1((l.pct - 1) * 100) }))) },
  ];

  // Max HP / MP: Flat = ADD effects on the stat + Bonus HP/MP; % = MULTIPLY effects read as
  // (×n − 1), added together — exactly what shared/stat-rules.js rule 1 applies.
  const vital = (key, label, icon, bonusKey) => {
    const own = S.get(key) ?? [];
    const flatLines = [
      ...own.filter((s) => s.mode === 2).map((s) => ({ name: s.name, kind: s.kind, img: s.img, flat: s.cond ? 0 : num(s.add ?? s.n), cond: !!s.cond })),
      ...linesFor(S, [bonusKey], "flat"),
    ];
    const pctLines = own.filter((s) => s.mode === 1 && !s.cond)
      .map((s) => ({ name: s.name, kind: s.kind, img: s.img, pct: round1((num(s.n, 1) - 1) * 100) }));
    const flat = flatLines.reduce((t, l) => t + (l.flat || 0), 0);
    const pct = round1(pctLines.reduce((t, l) => t + l.pct, 0));
    return { label, icon, kind: "up", flat, pct, title: label, srcs: mergeLines(flatLines, pctLines) };
  };
  const vit = [vital("max_hp", "Max HP", "fa-heart", "bonus_hp"), vital("max_mp", "Max MP", "fa-star", "bonus_mp")];

  // heal_receiving_* are effect-only keys (never sheet columns): sum the effects.
  const healFlatL = linesFor(S, ["heal_receiving_flat_all"], "flat");
  const healPctL = linesFor(S, ["heal_receiving_mod_all"], "pct", { scale: 100 });
  const ls = (flatKey, pctKey) => ({
    flat: num(p[flatKey]), pct: num(p[pctKey]),
    srcs: mergeLines(withRemainder(linesFor(S, [flatKey], "flat"), "flat", num(p[flatKey])), withRemainder(linesFor(S, [pctKey], "pct"), "pct", num(p[pctKey]))),
  });
  const rec = [
    { label: "Healing received", icon: "fa-hand-holding-heart", kind: "up", title: "Healing received",
      flat: healFlatL.reduce((t, l) => t + l.flat, 0), pct: round1(healPctL.reduce((t, l) => t + l.pct, 0)), srcs: mergeLines(healFlatL, healPctL) },
    { label: "Life steal", icon: "fa-droplet", kind: "up", title: "Life steal", tipNote: "Heals you for part of the damage you deal.",
      ...ls("lifesteal_value", "lifesteal_percentage") },
    { label: "Item healing", icon: "fa-flask", kind: "up", title: "Item healing", noPct: true, flat: num(p.item_restore_mod),
      srcs: withRemainder(linesFor(S, ["item_restore_mod"], "flat"), "flat", num(p.item_restore_mod)) },
    { label: "MP drain", icon: "fa-star-half-stroke", kind: "up", title: "MP drain", tipNote: "Restores MP from the damage you deal.",
      ...ls("manadrain_value", "manadrain_percentage") },
  ];

  const enmity = num(p.enmity, 100);
  const other = [
    { label: "Enmity", icon: "fa-bullhorn", kind: "up", span: String(enmity), spanCls: enmity !== 100 ? "is-up" : "is-rule", title: "Enmity",
      tipNote: "How much enemies want to attack you. 100 is normal.",
      srcs: enmity !== 100 ? withRemainder(linesFor(S, ["enmity"], "flat"), "flat", enmity - 100) : [] },
    { label: "IP cost", icon: "fa-briefcase", kind: "up", sign: "−", flat: num(p.ip_reduction_value), noPct: true, title: "IP cost",
      tipNote: "Taken off the IP cost of each item you use.",
      srcs: withRemainder(linesFor(S, ["ip_reduction_value"], "flat"), "flat", num(p.ip_reduction_value)) },
  ];

  return [
    { title: "Damage dealt", icon: "fa-burst", rows: deal },
    { title: "Checks", icon: "fa-dice-d20", rows: checks },
    { title: "Critical", icon: "fa-star", rows: crit },
    { title: "Damage reduction", icon: "fa-shield-halved", rows: take },
    { title: "Max HP / MP", icon: "fa-heart", rows: vit },
    { title: "Recovery", icon: "fa-hand-holding-heart", rows: rec },
    { title: "Other", icon: "fa-ellipsis", rows: other },
  ];
}

// ── render helpers (markup = the mockup's) ───────────────────────────────────
let TIPS = [];
const tipRef = (entry) => { TIPS.push(entry); return TIPS.length - 1; };
const FP = `<span class="pm-btcol">Flat</span><span class="pm-btcol">%</span>`;
const head = (title, icon, cols) => `<div class="pm-bthead"><span class="pm-btttl"><i class="fas ${icon}"></i>${esc(title)}</span>${cols}</div>`;

const ifChip = (r) => (r.srcs ?? []).some((s) => s.cond && !s.viaAll) ? `<span class="pm-if">if</span>` : "";
function flatCell(r) {
  if (!r || r.noFlat) return `<span class="pm-btv is-na">·</span>`;
  if (!r.flat) return `<span class="pm-btv is-zero">—${ifChip(r)}</span>`;
  // Damage reduction reads Genshin-style: positive; only a net vulnerability gets a (red) minus.
  if (r.kind === "guard") return `<span class="pm-btv ${r.flat > 0 ? "is-guard" : "is-bad"}">${r.flat > 0 ? "" : "−"}${Math.abs(r.flat)}${ifChip(r)}</span>`;
  const sign = r.sign ?? (r.flat > 0 ? "+" : "−");
  return `<span class="pm-btv ${r.flat < 0 && !r.sign ? "is-bad" : "is-up"}">${sign}${Math.abs(r.flat)}${ifChip(r)}</span>`;
}
function pctCell(r) {
  if (!r || r.noPct) return `<span class="pm-btv is-na">·</span>`;
  if (!r.pct) return `<span class="pm-btv is-zero">—</span>`;
  if (r.kind === "guard") return `<span class="pm-btv ${r.pct > 0 ? "is-guard" : "is-bad"}">${r.pct > 0 ? "" : "−"}${Math.abs(r.pct)}%</span>`;
  return `<span class="pm-btv ${r.pct > 0 ? "is-up" : "is-bad"}">${r.pct > 0 ? "+" : "−"}${Math.abs(r.pct)}%</span>`;
}
const rowHTML = (r) => `<div class="pm-btrow ${r.isAll ? "is-all" : ""}" data-bt-tip="${tipRef({ title: r.title ?? r.label, r })}">
  <span class="pm-btlabel"><i class="fas ${r.icon}"></i>${esc(r.label)}</span>${r.span != null
    ? `<span class="pm-btv is-span ${r.spanCls ?? ""}">${esc(r.span)}</span>` : flatCell(r) + pctCell(r)}</div>`;

function split(title, icon, rows, opt = {}) {
  const n = opt.n ?? 2, per = Math.max(1, Math.ceil(rows.length / n));
  const cols = opt.cols ?? FP;
  const hc = n === 2 ? `${cols}<span></span><span></span>${cols}` : "";
  return `<div class="pm-btblock pm-btsplit ${opt.cls ?? ""}">${head(title, icon, hc)}
    <div class="pm-btsplitrows" style="grid-template-rows: repeat(${per}, auto)">${rows.map(opt.row ?? rowHTML).join("")}</div></div>`;
}
const scroller = (inner) => `<div class="pm-btwrap-host"><div class="pm-btwrap">${inner}</div></div>`;

// ── hover card ───────────────────────────────────────────────────────────────
function tipHTML({ title, r }) {
  const sign = r.sign ?? (r.kind === "guard" ? "" : "+");
  const fmt = (v, pct) => {
    if (r.kind === "guard") return `${v < 0 ? "−" : ""}${Math.abs(v)}${pct ? "%" : ""}`;
    return `${v < 0 ? "−" : sign}${Math.abs(v)}${pct ? "%" : ""}`;
  };
  const amt = (s) => [
    s.flat ? fmt(s.flat, false) : "", s.pct ? fmt(s.pct, true) : "",
    s.ef ? `${s.ef > 0 ? "+" : "−"}${Math.abs(s.ef)}% eff.` : "",
    s.grade ? ({ IM: "Immune", RS: "Resistant", VU: "Vulnerable", AB: "Absorbs" }[s.grade] ?? s.grade) : "",
    s.cond ? `<span class="pm-tipdim">when active</span>` : "", s.off ? `<span class="pm-tipdim">${esc(s.off)}</span>` : "",
  ].filter(Boolean).map((x) => `<b>${x}</b>`).join("");
  const ico = (s) => s.img ? `<img class="pm-srcico" src="${esc(s.img)}" alt="">` : `<span class="pm-srcico is-blank"><i class="fas ${s.icon ?? "fa-circle"}"></i></span>`;
  const kindWord = (s) => s.viaAll ? " (All)" : s.kind === "base" || s.kind === "orbment" ? "" : ` (${esc(s.kind)})`;
  const srcs = r.srcs ?? [];
  const lines = srcs.map((s) => `<li class="${s.cond || s.off ? "is-off" : ""}"><span class="pm-srcname">${ico(s)}${esc(s.name)}${kindWord(s)}</span><span class="pm-effamts">${amt(s)}</span></li>`).join("");
  const live = srcs.filter((s) => s.flat || s.pct);
  let total = "";
  if (live.length > 1 && (r.flat || r.pct)) {
    const t = [r.flat ? fmt(r.flat, false) : "", r.pct ? fmt(r.pct, true) : ""].filter(Boolean).map((x) => `<b>${x}</b>`).join("");
    total = `<li class="is-total"><span>Total</span><span class="pm-effamts">${t}</span></li>`;
  }
  const body = lines || total ? `<ul class="pm-effsrc">${lines}${total}</ul>` : r.tipNote ? "" : `<p>Nothing changes this right now.</p>`;
  return `<div class="pm-tipname">${esc(title)}</div>${r.tipNote ? `<p>${r.tipNote}</p>` : ""}${body}`;
}

/** Wire the hover card on the menu root (once per root; the root survives re-renders). */
const _wired = new WeakSet();
export function wireStatTips(root) {
  if (!root || _wired.has(root)) return;
  _wired.add(root);
  let tip = null, shownFor = null;
  const hide = () => { if (tip) tip.hidden = true; shownFor = null; };
  root.addEventListener("mousemove", (ev) => {
    const t = ev.target.closest?.("[data-bt-tip]");
    if (!t) return hide();
    if (!tip || !root.contains(tip)) { tip = document.createElement("div"); tip.className = "pm-win pm-bttip"; tip.hidden = true; root.appendChild(tip); }
    if (shownFor !== t) {
      const entry = TIPS[Number(t.dataset.btTip)];
      if (!entry) return hide();
      tip.innerHTML = tipHTML(entry);
      shownFor = t;
    }
    tip.hidden = false;
    const box = root.getBoundingClientRect(), rb = t.getBoundingClientRect();
    let left = rb.left - box.left - tip.offsetWidth - 14, top = rb.top - box.top - 6;
    if (left < 8) left = rb.right - box.left + 12;
    top = Math.max(8, Math.min(top, box.height - tip.offsetHeight - 8));
    tip.style.left = `${left}px`; tip.style.top = `${top}px`;
  });
  root.addEventListener("mouseleave", hide);
}

// ── tabs ──────────────────────────────────────────────────────────────────────
export function battleTab(actor) {
  TIPS = [];
  return scroller(battleModel(actor).map((b) => split(b.title, b.icon, b.rows)).join(""));
}

const CORE = ["dazed", "enraged", "poisoned", "shaken", "slow", "weak"];
const OTHER = ["anomaly", "bane", "berserk", "bleed", "blind", "burn", "charm", "confused", "curse", "delayed", "despair", "disarmed", "doom",
  "envenomed", "fatigue", "frightened", "grappled", "hypothermia", "isolate", "obscure", "oil", "panic", "paralyzed", "petrify",
  "silence", "sleep", "stagger", "stunned", "suppress", "turbulence", "wet", "wither", "zombie"];
const STATUS_TERM = { delayed: "Delay" };   // sheet key → keyword-registry name
const GRADE = { RS: "Resistant", IM: "Immune", VU: "Vulnerable", AB: "Absorbs" };
const resRow = (r) => `<div class="pm-btrow" data-bt-tip="${tipRef({ title: r.label, r })}"><span class="pm-btlabel">`
  + `${r.img ? `<img class="pm-sticon" src="${esc(r.img)}" alt="">` : `<span class="pm-sticon is-blank"></span>`}${esc(r.label)}</span>`
  + (r.grade ? `<b class="pm-btv pm-grade aff-${r.grade.toLowerCase()}">${r.grade}</b>` : `<span class="pm-btv is-zero">—</span>`) + `</div>`;

export function resTab(actor) {
  TIPS = [];
  const p = actor.system?.props ?? {};
  const S = sourcesByKey(actor);
  const row = (c) => {
    const g = String(p[`condition_${c}`] ?? "").trim().toUpperCase();
    const grade = GRADE[g] ? g : null;
    const label = cap(c);
    const srcs = (S.get(`condition_${c}`) ?? []).filter((s) => !s.cond).map((s) => ({ name: s.name, kind: s.kind, img: s.img, grade: String(s.raw ?? "").toUpperCase() }));
    return { label, img: lookupTerm(STATUS_TERM[c] ?? cap(c))?.icon ?? "", grade, srcs,
      tipNote: grade ? `${GRADE[grade]} to ${label}.` : `No resistance to ${label}.` };
  };
  const o = { n: 3, cls: "is-res", row: resRow };
  return scroller(`${split("Core statuses", "fa-circle-half-stroke", CORE.map(row), o)}${split("Other statuses", "fa-circle-nodes", OTHER.map(row), o)}
    <div class="pm-btnote"><b class="pm-grade aff-rs">RS</b> Resistant · <b class="pm-grade aff-im">IM</b> Immune. Hover a status to see where it comes from.</div>`);
}

// Weapon types + icons = the monster study card's (unit-inspect study-visuals.js WEAPON_ICON).
const WPN = [["arcane", "fa-book"], ["bow", "fa-bullseye"], ["brawling", "fa-hand-fist"], ["dagger", "fa-dagger"], ["firearm", "fa-gun"],
  ["flail", "fa-gavel"], ["heavy", "fa-hammer"], ["spear", "fa-location-arrow"], ["sword", "fa-sword"], ["thrown", "fa-bomb"]];
// inspect-render.js weaponGauges(): centre line = 100%; above grows right (red "up"), below grows left (blue "down").
const gauge = (r) => {
  const w = Math.min(50, Math.abs(r.ef - 100) / 2), cls = r.ef > 100 ? "up" : r.ef < 100 ? "down" : "";
  const bar = r.ef === 100 ? "" : `<i style="${r.ef > 100 ? "left" : "right"}:50%;width:${w}%"></i>`;
  return `<div class="fui-wg ${cls}" data-bt-tip="${tipRef({ title: `${r.label} efficiency`, r })}"><span class="fui-wgi"><i class="fas ${r.icon}"></i></span>`
    + `<span class="fui-wgn">${esc(r.label)}</span><div class="fui-wgb">${bar}</div><b>${r.ef}%</b></div>`;
};

export function wpnTab(actor) {
  TIPS = [];
  const p = actor.system?.props ?? {};
  const S = sourcesByKey(actor);
  const eff = WPN.map(([w, icon]) => {
    const ef = num(p[`${w}_ef`], 100) || 100;
    const srcs = withRemainder(linesFor(S, [`${w}_ef`], "ef"), "ef", ef - 100).map((l) => l.name === "Character sheet" ? { ...l, icon: "fa-scroll" } : l);
    return { label: cap(w), icon, kind: "up", ef, srcs, tipNote: "How hard this weapon type hits. 100% is normal." };
  });
  const dmg = WPN.map(([w, icon]) => {
    const flat = num(p[`extra_damage_mod_${w}`]);
    return { label: cap(w), icon, kind: "up", flat, noPct: true, title: `${cap(w)} damage`,
      tipNote: "Extra flat damage when attacking with this weapon type.",
      srcs: withRemainder(linesFor(S, [`extra_damage_mod_${w}`], "flat"), "flat", flat) };
  });
  return scroller(`<div class="pm-btblock">${head("Efficiency", "fa-gauge-high", "")}<div class="fui-wgs">${eff.map(gauge).join("")}</div></div>
    ${split("Damage bonus", "fa-burst", dmg)}
    <div class="pm-btnote">Efficiency: the line in the middle is 100%. A red bar to the right hits harder, a blue bar to the left hits softer.</div>`);
}

// Social = the Request Check tags (cr-sidebar-button.js CHECK_BUFF_OPTIONS); bonuses = check_buff rows on
// equipped gear / passives / live effects (sumEquippedCheckBuffs). "Any" counts toward every row.
const TAGS = [["any", "Any check", "fa-asterisk"], ["study", "Study", "fa-book-open"], ["stealth", "Stealth", "fa-user-secret"],
  ["strength", "Strength", "fa-dumbbell"], ["mobility", "Mobility", "fa-person-running"], ["intimidation", "Intimidation", "fa-face-angry"],
  ["persuade", "Persuading", "fa-comments"], ["tracking", "Tracking", "fa-paw"], ["lockpick", "Lockpicking", "fa-key"],
  ["stealing", "Stealing", "fa-hand-holding"], ["dancing", "Dancing", "fa-music"], ["cooking", "Cooking", "fa-utensils"],
  ["repair", "Repairing", "fa-screwdriver-wrench"], ["digging", "Digging", "fa-trowel"]];

// Gear the character CARRIES but hasn't equipped, whose passive would add to a tag: shown "+N if equipped".
function unequippedHints(actor) {
  const out = [];
  const items = [...(actor.items ?? [])];
  for (const gear of items) {
    const gp = gear.system?.props ?? {};
    if (gear.type !== "equippableItem" || gp.isEquipped || !gp.item_type) continue;
    for (const sk of items) {
      if (String(sk.system?.container ?? "") !== gear.id || String(sk.system?.props?.skill_type ?? "") !== "Passive") continue;
      for (const row of Object.values(sk.system?.props?.effect_table ?? {})) {
        if (row?.effect_kind !== "check_buff") continue;
        const tags = String(row.check_buff_action ?? "").toLowerCase().split(/[,;|]+/).map((s) => s.trim()).filter(Boolean);
        out.push({ tags, name: gear.name, img: gear.img, amount: String(row.check_buff_amount ?? row.check_buff_value ?? "") });
      }
    }
  }
  return out;
}

const socRow = (r) => `<div class="pm-btrow ${r.isAll ? "is-all" : ""}" data-bt-tip="${tipRef({ title: r.label, r })}"><span class="pm-btlabel"><i class="fas ${r.icon}"></i>${esc(r.label)}</span>`
  + `<span class="pm-btv is-na"></span>${flatCell(r)}</div>`;

export function socTab(actor) {
  TIPS = [];
  const imgOf = (name) => [...(actor.items ?? [])].find((i) => i.name === name)?.img ?? "";
  const anyParts = sumEquippedCheckBuffs(actor, "__any_only__").parts ?? [];
  const hints = unequippedHints(actor);
  const rows = TAGS.map(([t, label, icon]) => {
    const res = t === "any" ? { total: anyParts.reduce((s, x) => s + x.amount, 0), parts: anyParts } : sumEquippedCheckBuffs(actor, t);
    const anyNames = new Set(anyParts.map((x) => x.source));
    const srcs = (res.parts ?? []).map((x) => ({ name: x.source, kind: "gear", img: imgOf(x.source), flat: x.amount, viaAll: t !== "any" && anyNames.has(x.source) }));
    for (const h of hints) if (h.tags.includes(t) || (t === "any" && (h.tags.includes("any") || h.tags.includes("*")))) {
      srcs.push({ name: h.name, kind: "gear", img: h.img, off: `${/^-?\d/.test(h.amount) ? `+${h.amount}` : h.amount} if equipped` });
    }
    return { label, icon, kind: "up", flat: res.total ?? 0, noPct: true, isAll: t === "any", srcs,
      tipNote: t === "any" ? "Added to every tagged check." : `Added when the GM tags a check as ${label}.` };
  });
  return scroller(`${split("Check bonuses", "fa-comments", rows, { row: socRow, cols: `<span></span><span class="pm-btcol">Bonus</span>` })}
    <div class="pm-btnote">Bonuses from equipped gear, added when the GM tags a check (Request Check). Rows include Any. Hover a row to see where it comes from.</div>`);
}
