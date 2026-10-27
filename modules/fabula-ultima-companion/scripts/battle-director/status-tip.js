// status-tip.js — tooltip and pip helpers shared by the player HUD and the
// NPC status strip (token status plan "G + E", 2026-10-27).
//
// Input is a Party Menu effect row (party-menu-effects.js effectRowsOf), so the
// hover text is the same everywhere: icon header tinted by tier, how long it
// lasts, the value chips, then the rules text with Genshin-style highlights
// (attributes, actions, values, elements, rules terms).
//
// The markup goes into Foundry's data-tooltip, so it is display only.

import { classifyEffect, TIER, TIER_ORDER } from "./status-classifier.js";

const STYLE_ID = "fu-status-tip-style";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const stripTags = (s) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const KIND = { debuff: "Debuff", buff: "Buff", ready: "Ready", marker: "Marker" };

/** Tier of a Party Menu row (its first live source decides). */
export function rowTier(r) { return classifyEffect(r?.sources?.[0]?.eff ?? null); }

/** Turns or uses left as a number for the pip's corner numeral, else null. */
export function rowTurns(r) {
  const k = r?.lifetime?.kind;
  if (k !== "turns" && k !== "uses") return null;
  const n = parseInt(String(r.short ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A Ready row whose charges are spent ("0/1") stays visible but greyed. */
export function rowSpent(r) {
  const c = String(r?.lifetime?.counter ?? r?.sources?.[0]?.lifetime?.counter ?? "");
  return /^0(\/|$)/.test(c);
}

/** Debuffs, then buffs, then Ready, then markers; stable within a tier. */
export function sortRows(list) {
  return list.map((r, i) => ({ r, i, t: r.tier ?? rowTier(r) }))
    .sort((a, b) => (TIER_ORDER[a.t] - TIER_ORDER[b.t]) || (a.i - b.i))
    .map((x) => x.r);
}

const ELEMENTS = /\b(Fire|Ice|Bolt|Air|Earth|Light|Dark|Poison|Physical)\b/g;
const TERMS = /\b(one stage|Accuracy|Healing(?: effects)?|Maximum Hit Points|Max HP|Hit Points|Mind Points|Resistance|Immunity|vulnerability|Vulnerability|Opposed Checks?|Travel Roll|start of (?:your|each) turn|end of (?:your|the) turn|[Oo]nce per (?:conflict|turn|round|scene)|next rest|reroll|Defense|Magic Defense|Free Attack|Crisis|Drain)\b/g;

/** Plain rules text → HTML with highlights. Escapes first, so it is safe. */
export function formatRulesText(text) {
  let s = esc(stripTags(String(text ?? "").replace(/@UUID\[[^\]]+\]\{([^}]*)\}/g, "$1").replace(/@\w+\[([^\]]+)\](?:\{([^}]*)\})?/g, (m, a, b) => b || a)));
  s = s.replace(/【(MIG|DEX|INS|WLP)】/g, '<span class="fu-st-k stat">$1</span>');
  s = s.replace(/【([^】]+)】/g, '<span class="fu-st-k act">$1</span>');
  s = s.replace(/(^|[\s(\[])([+\-−] ?\d+%?)/g, (m, p, v) => `${p}<span class="fu-st-k ${v.charAt(0) === "+" ? "pos" : "neg"}">${v}</span>`);
  s = s.replace(ELEMENTS, (m) => `<span class="fu-st-e e-${m.toLowerCase()}">${m}</span>`);
  s = s.replace(TERMS, '<span class="fu-st-k kw">$1</span>');
  return s;
}

function amountsOf(r) {
  return [...new Set([
    ...(r.totals ?? []).map((t) => t.text),
    ...(r.sources ?? []).flatMap((s) => (s.amounts ?? []).filter((a) => a.active && typeof a.add !== "number").map((a) => a.text)),
  ])].filter(Boolean);
}

function descOf(r) {
  return clip(stripTags(r.description || r.sources?.find((s) => s.source?.description)?.source?.description || ""), 260);
}

/** Tooltip for one row. `extra` is appended HTML (already safe). */
export function statusTipHTML(r, { tier = rowTier(r), extra = "" } = {}) {
  ensureTipStyles();
  const amounts = amountsOf(r);
  const desc = descOf(r);
  const spent = tier === TIER.READY && rowSpent(r);
  const sub = [KIND[tier] ?? "", r.short ? esc(r.short) : ""].filter(Boolean).join(" · ");
  return `<div class="fu-st-tip t-${tier}">`
    + `<div class="th"><img src="${esc(r.img)}" alt=""><div><strong>${esc(r.name)}</strong><small>${sub}</small></div></div>`
    + `<div class="tb">`
    + (r.lifetime?.label ? `<div class="life">${esc(r.lifetime.label)}</div>` : "")
    + (amounts.length ? `<div class="amt">${amounts.map((a) => `<span>${formatRulesText(a)}</span>`).join("")}</div>` : "")
    + (desc ? `<div class="desc">${formatRulesText(desc)}</div>` : "")
    + (tier === TIER.READY ? `<div class="when">${spent ? "Spent. It comes back when its uses refresh." : "Available now."}</div>` : "")
    + extra
    + `</div></div>`;
}

/** Tooltip for a fold pip: every folded row with its icon, lifetime and text. */
export function foldTipHTML(rows, { title } = {}) {
  ensureTipStyles();
  const allMarkers = rows.every((r) => (r.tier ?? rowTier(r)) === TIER.MARKER);
  const head = title ?? (allMarkers ? `${rows.length} standing effect${rows.length === 1 ? "" : "s"}` : `${rows.length} more`);
  const sub = allMarkers ? "Markers · never on the token" : "Folded to save room";
  return `<div class="fu-st-tip t-${allMarkers ? "marker" : "debuff"}">`
    + `<div class="th fold"><div><strong>${esc(head)}</strong><small>${sub}</small></div></div><div class="tb">`
    + rows.map((r) => {
      const t = r.tier ?? rowTier(r);
      const desc = descOf(r);
      return `<div class="fr t-${t}"><img src="${esc(r.img)}" alt=""><div><b>${esc(r.name)}</b>`
        + (r.lifetime?.label ? ` <em>· ${esc(r.lifetime.label)}</em>` : "")
        + (desc ? `<p>${formatRulesText(desc)}</p>` : "") + `</div></div>`;
    }).join("")
    + `</div></div>`;
}

/** Inject the tooltip CSS once. Foundry's #tooltip hosts the markup. */
export function ensureTipStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
#tooltip:has(.fu-st-tip), .locked-tooltip:has(.fu-st-tip) {
  padding: 0; max-width: 330px; background: rgba(18,15,12,.96); border: 1px solid #b7935a;
  border-radius: 6px; box-shadow: 0 6px 18px rgba(0,0,0,.45); text-align: left;
}
.fu-st-tip { --tc: rgba(122,106,85,.5); --tc2: #a8987e; color: #f3eee4; font: 13px/1.45 "Signika", sans-serif; overflow: hidden; border-radius: 6px; }
.fu-st-tip.t-debuff { --tc: rgba(196,71,58,.5); --tc2: #e0675a; }
.fu-st-tip.t-buff   { --tc: rgba(47,158,107,.5); --tc2: #4fc08d; }
.fu-st-tip.t-ready  { --tc: rgba(226,179,74,.5); --tc2: #e2b34a; }
.fu-st-tip .th { display: grid; grid-template-columns: 38px 1fr; gap: 10px; align-items: center; padding: 8px 11px;
  background: linear-gradient(90deg, var(--tc), rgba(18,15,12,0) 85%); border-bottom: 1px solid rgba(213,182,122,.35); }
.fu-st-tip .th.fold { grid-template-columns: 1fr; }
.fu-st-tip .th img { width: 38px; height: 38px; border-radius: 7px; border: 2px solid var(--tc2); background: #3a3228; object-fit: cover; }
.fu-st-tip .th strong { display: block; font-size: 14.5px; color: #fff3d6; line-height: 1.2; }
.fu-st-tip .th small { display: block; margin-top: 2px; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #d8c9ad; }
.fu-st-tip .tb { padding: 8px 11px 9px; display: grid; gap: 6px; }
.fu-st-tip .life { font-size: 11.5px; color: #c9bca6; }
.fu-st-tip .amt { display: flex; flex-wrap: wrap; gap: 4px; }
.fu-st-tip .amt span { font-weight: 700; font-size: 11.5px; padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,.08); }
.fu-st-tip .when { font-size: 12px; color: #ffe2a8; border-left: 2px solid #d5b67a; padding-left: 7px; }
.fu-st-tip .fr { display: grid; grid-template-columns: 26px 1fr; gap: 9px; align-items: start; --rc: #a8987e; }
.fu-st-tip .fr.t-debuff { --rc: #e0675a; } .fu-st-tip .fr.t-buff { --rc: #4fc08d; } .fu-st-tip .fr.t-ready { --rc: #e2b34a; }
.fu-st-tip .fr + .fr { padding-top: 6px; border-top: 1px solid rgba(255,255,255,.1); }
.fu-st-tip .fr img { width: 26px; height: 26px; border-radius: 5px; border: 1.5px solid var(--rc); background: #3a3228; object-fit: cover; }
.fu-st-tip .fr b { color: #fff3d6; }
.fu-st-tip .fr em { color: #c9bca6; font-style: normal; font-size: 12px; }
.fu-st-tip .fr p { margin: 2px 0 0; font-size: 12px; }
.fu-st-k.stat { color: #fff; font-weight: 700; background: rgba(255,215,128,.16); border-radius: 3px; padding: 0 4px; }
.fu-st-k.act, .fu-st-k.pos { color: #ffd780; font-weight: 700; }
.fu-st-k.neg { color: #ff9a8a; font-weight: 700; }
.fu-st-k.kw { color: #9fd0ff; font-weight: 600; }
.fu-st-e { font-weight: 700; }
.fu-st-e.e-fire { color: #ff9a5c; } .fu-st-e.e-ice { color: #9fe3ff; } .fu-st-e.e-bolt { color: #d7a6ff; }
.fu-st-e.e-air { color: #7fe0c0; } .fu-st-e.e-earth { color: #f5c461; } .fu-st-e.e-light { color: #fff2a8; }
.fu-st-e.e-dark { color: #c49cff; } .fu-st-e.e-poison { color: #a6e06a; } .fu-st-e.e-physical { color: #e8dcc6; }
`;
  document.head.appendChild(st);
}
