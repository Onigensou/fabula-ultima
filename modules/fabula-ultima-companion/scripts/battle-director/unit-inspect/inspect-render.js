// Battle Inspect — markup + styles (approved mockup claude.ai/artifact/52umGqFkM3KBB3AJvVWRBZ,
// 2026-10-14; the unit is spotlit in the world instead of on a pedestal box).
//
// The card is designed at 1080p and scaled as a whole by --fui-k (hudScale), the
// same rule as the plate, so positions computed by the controller stay in
// screen px. Every interactive element carries data-action; the controller
// delegates. Pure string building: no state here.

export const ROOT_ID = "fu-inspect-root";
export const WORLD_ID = "fu-inspect-world";   // the spotlight + the unit, just above #board
const STYLE_ID = "fu-inspect-style";

import { renderLinkedText, safeHtml } from "../../linked-text/lt-render.js";
import { crestSVG, defenseSVG } from "./study-visuals.js";

export const CARD_W = 820;
// Never taller than this (user, 2026-11-02): new content fits by tightening.
export const FRAME_H = 572;

const esc =(s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Sanitized rich text from the Encyclopedia (already sanitizeRichHtml'd there);
// stripped to plain text here anyway — the hint box is a paragraph, not a page.
const plain = (html) => String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const kbd = (k) => `<kbd class="fui-kbd">${esc(k)}</kbd>`;

function vitalRow(r, cls = "fui-vrow") {
  const body = r.kind === "pips"
    ? `<div class="fui-pips">${r.pips.map((on) => `<span class="fui-pip${on ? " on" : ""}"></span>`).join("")}</div>`
    : `<div class="fui-bar"><i class="${esc(r.cls)}" style="width:${r.pct.toFixed(1)}%"></i></div>`;
  return `<div class="${cls}"><span class="fui-vk">${esc(r.k)}</span>${body}<span class="fui-vv">${esc(r.text)}</span></div>`
    + (r.sub && cls === "fui-vrow" ? `<div class="fui-zpn">${esc(r.sub)}</div>` : "");
}

function crisisBadge(m) {
  if (!m.crisisOnly) return "";
  return `<div class="fui-crisis ${m.crisis ? "on" : "off"}">${m.crisis ? "In Crisis" : "Not in Crisis"}</div>`;
}

function effRow(e) {
  const chip = e.chip ? `<span class="fui-chip tone-${esc(e.tone)}">${e.chipEl ? `<i class="fas ${esc(e.chipEl)}"></i>` : ""}${esc(e.chip)}</span>` : "";
  return `<div class="fui-eff${e.gmOnly ? " is-gmonly" : ""}${e.inactive ? " is-inactive" : ""}" title="${esc(e.title)}">
    <img class="fui-ico" src="${esc(e.img)}" alt="" onerror="this.style.visibility='hidden'">
    <div class="fui-effbody"><div class="fui-en"><b>${esc(e.name)}${e.count ? ` ×${e.count}` : ""}</b>${chip}</div><div class="fui-el">${esc(e.life)}</div></div>
  </div>`;
}

const GROUPS = [["buffs", "Buffs", "g-good"], ["debuffs", "Debuffs", "g-bad"], ["other", "Counters", ""]];

function effectsPane(m, ui) {
  const present = GROUPS.filter(([k]) => m.groups[k].length);
  // An enemy's visible passives (witnessed / Details) sit on the Effects tab too.
  if (m.enemy && m.groups.passive.length) present.push(["passive", "Passive", ""]);
  const filter = present.some(([k]) => k === ui.filter) ? ui.filter : "all";
  const chips = [["all", "All", m.enemy ? null : null], ...present.map(([k, t]) => [k, `${t} ${m.groups[k].length}`])]
    .map(([k, label]) => `<button type="button" class="fui-fchip${filter === k ? " on" : ""}" data-action="filter" data-key="${k}" aria-pressed="${filter === k}">${esc(label)}</button>`).join("");
  const body = present.filter(([k]) => filter === "all" || filter === k)
    .map(([k, t, cls]) => `<div class="fui-grp ${cls}">${esc(t)} · ${m.groups[k].length}</div>${m.groups[k].map(effRow).join("")}`).join("");
  const empty = present.length ? "" : `<div class="fui-note">${m.enemy
    ? "No effects showing." + (m.tierN >= 3 || m.gm ? "" : " Its passives show once seen in battle, or at Study 13+.")
    : "No timed effects or counters. Always-on effects are under Passive & gear."}</div>`;
  return `${present.length ? `<div class="fui-filters">${chips}</div>` : ""}${empty}<div class="fui-grid">${body}</div>`;
}

function passivePane(m) {
  const rows = m.groups.passive;
  return `<div class="fui-note fui-note-top">Always on: from skills and equipped gear.</div>
    ${rows.length ? `<div class="fui-grid">${rows.map(effRow).join("")}</div>` : `<div class="fui-note">Nothing always-on.</div>`}
    ${m.conds ? `<div class="fui-note"><b>Status immunities:</b> ${esc(m.conds)}</div>` : ""}`;
}

const COST_TIP = (c) => (c.tip ? ` data-tooltip="${esc(c.tip)}" data-tooltip-direction="UP"` : "");

function actionRow(a) {
  if (!a.readable) {
    return `<div class="fui-act is-unk"><div class="fui-actq"><i class="fas fa-question"></i></div><div class="fui-actb"><div class="fui-acttop"><span class="fui-actn">???</span><span class="fui-kind">${esc(a.kind)}</span></div><div class="fui-actd is-none">Not seen in battle yet.</div></div></div>`;
  }
  const cost = a.cost ? `<span class="fui-cost c-${esc(a.cost.cls)}"${COST_TIP(a.cost)}>${esc(a.cost.text)}</span>` : "";
  const text = plain(a.desc) ? `<div class="fui-actd">${safeHtml(renderLinkedText(a.desc))}</div>` : `<div class="fui-actd is-none">No description written.</div>`;
  return `<div class="fui-act${a.gmOnly ? " is-gmonly" : ""}"><img class="fui-acti" src="${esc(a.img)}" alt="" onerror="this.style.visibility='hidden'"><div class="fui-actb">
    <div class="fui-acttop"><span class="fui-actn">${esc(a.name)}</span>${cost}${a.dice ? `<span class="fui-dice">${esc(a.dice)}</span>` : ""}${a.gmOnly ? `<span class="fui-gm">not seen by players</span>` : ""}<span class="fui-kind">${esc(a.kind)}</span></div>
    ${text}</div></div>`;
}

function actionsPane(m, ui) {
  if (!m.actions.length) return `<div class="fui-note">${m.hasEntry ? "No actions recorded for this creature." : "Nothing recorded yet."}</div>`;
  const kinds = ["Attack", "Skill", "Spell", "Passive"].filter((k) => m.actions.some((a) => a.kind === k));
  const filter = kinds.includes(ui.filter) ? ui.filter : "all";
  const chips = [["all", `All ${m.actions.length}`], ...kinds.map((k) => [k, `${k}s ${m.actions.filter((a) => a.kind === k).length}`])]
    .map(([k, label]) => `<button type="button" class="fui-fchip${filter === k ? " on" : ""}" data-action="filter" data-key="${esc(k)}" aria-pressed="${filter === k}">${esc(label)}</button>`).join("");
  return `<div class="fui-filters">${chips}<span class="fui-seen">${esc(m.seenText)} seen</span></div>`
    + m.actions.filter((a) => filter === "all" || a.kind === filter).map(actionRow).join("");
}

function notesPane(m) {
  const hint = safeHtml(m.hint);
  return `${plain(hint) ? `<div class="fui-label fui-label-first">Description</div><div class="fui-hint">${hint}</div>` : `<div class="fui-note fui-note-top">Study 7+ to read what the party knows about this creature.</div>`}
    <div class="fui-label">Study progress</div>
    <div class="fui-steps">${m.steps.map((s) => `<div class="fui-step${s.done ? " done" : ""}"><b>${esc(s.n)}</b><span>${esc(s.text)}</span><em>${s.done ? "Known" : "—"}</em></div>`).join("")}</div>`;
}

// ── the enemy's left column ─────────────────────────────────────────────────
// `flash` = the Study tier lighting up right now (1 Identity, 2 Stats, 3 Details).

const TIP = (t) => `data-tooltip="${esc(t)}" data-tooltip-direction="UP"`;
const newTag = (on) => (on ? `<span class="fui-new">NEW</span>` : "");

function defenseBadge(kind, k, stat, name) {
  const known = !!stat;
  const tip = known ? `${name}: ${stat.v}${kind === "mdef" ? ". Magic attacks have to beat this." : ". Physical attacks have to beat this."}` : `${name}: Study 7+ reveals it`;
  return `<div class="fui-sb ${known ? (kind === "mdef" ? "is-mag" : "") : "is-unk"} ${esc(stat?.cls ?? "")}" ${TIP(tip)}>${defenseSVG(kind)}<b>${known ? esc(stat.v) : "?"}</b><em>${esc(k)}</em></div>`;
}

function enemyVitals(m, flash) {
  const def = m.stats.find((s) => s.k === "DEF"), mdef = m.stats.find((s) => s.k === "M.DEF");
  return `<div class="fui-vw"><div class="fui-vwrows">${m.vitals.map((r) => vitalRow(r)).join("")}${crisisBadge(m)}</div>
    <div class="fui-sbs${flash === 1 ? " fui-flash" : ""}">${defenseBadge("def", "DEF", def, "Defense")}${defenseBadge("mdef", "M.DEF", mdef, "Magic Defense")}</div></div>
    ${m.vitalsNote ? `<div class="fui-note">${esc(m.vitalsNote)}</div>` : ""}`;
}

function enemyDice(m, flash) {
  const dice = m.stats.filter((s) => s.kind === "attr");
  if (!dice.length) return `<div class="fui-lock"><i class="fas fa-lock"></i><span>Study 8+ reveals the attribute dice.</span></div>`;
  return `<div class="fui-dcs">${dice.map((s) => `<div class="fui-dc ${esc(s.cls)}${flash === 2 ? " fui-flash" : ""}" ${TIP(s.tip)}><img src="${esc(s.icon)}" alt="${esc(s.k)}"><b>${esc(s.v)}</b></div>`).join("")}</div>`;
}

function weaponGauges(m, flash) {
  const fx = flash === 3 ? " fui-flash" : "";
  return `<div class="fui-wgs${m.detGmOnly ? " is-gmonly" : ""}">${m.weapons.map((w) => {
    const width = Math.min(50, Math.abs(w.pct - 100) / 2);
    const bar = w.pct === 100 ? "" : `<i style="${w.pct > 100 ? "left" : "right"}:50%;width:${width}%"></i>`;
    return `<div class="fui-wg ${esc(w.cls)}${fx}" ${TIP(w.tip)}><span class="fui-wgi"><i class="fas ${esc(w.icon)}"></i></span><div class="fui-wgb">${bar}</div><b>${w.pct}%</b></div>`;
  }).join("")}</div>`;
}

const STATUS_LABEL = { im: "Immune", rs: "Resist", ab: "Absorb", vu: "Weak" };

function statusRows(m, flash) {
  const fx = flash === 3 ? " fui-flash" : "";
  if (!m.statuses.length) return `<div class="fui-note">No special status resistances.</div>`;
  const outline = m.detGmOnly ? " is-gmonly" : "";
  if (m.immuneAll) return `<div class="fui-strow${outline}"><span class="fui-sttag im">Immune</span><span class="fui-stall">Every status</span></div>`;
  return Object.keys(STATUS_LABEL).map((code) => {
    const row = m.statuses.filter((s) => s.cls === code);
    if (!row.length) return "";
    return `<div class="fui-strow${outline}"><span class="fui-sttag ${code}">${STATUS_LABEL[code]}</span><div class="fui-sts">${row.map((s) => `<span class="fui-stp${fx}" ${TIP(s.tip)}>${s.img ? `<img src="${esc(s.img)}" alt="${esc(s.name)}">` : `<i class="fas fa-circle-question"></i>`}</span>`).join("")}</div></div>`;
  }).join("");
}

function enemyLeft(m, affs, flash) {
  const details = m.weapons
    ? `<div class="fui-label">Weapon efficiency${newTag(flash === 3)}</div>${weaponGauges(m, flash)}
       <div class="fui-label">Status${newTag(flash === 3)}</div>${statusRows(m, flash)}`
    : `<div class="fui-label">Weapons &amp; status</div><div class="fui-lock"><i class="fas fa-lock"></i><span>Study 13+ reveals weapon efficiency and status resistances.</span></div>`;
  return `<div class="fui-label">Vitals${newTag(flash === 1)}</div>${enemyVitals(m, flash)}
    <div class="fui-label">Attributes${newTag(flash === 2)}</div>${enemyDice(m, flash)}
    <div class="fui-label">Affinities${newTag(flash === 3)}</div><div class="fui-affs${flash === 3 ? " fui-flash" : ""}">${affs}</div>
    ${m.affNote ? `<div class="fui-note">${esc(m.affNote)}</div>` : ""}
    ${details}`;
}

function enemyHeadParts(m, flash) {
  const rank = m.rank;
  const crest = `<div class="fui-crestbox${flash === 1 ? " fui-stamp" : ""}" ${TIP(rank ? rank.tip : "Rank unknown. Study 7+ reveals it.")}>${crestSVG(rank?.key ?? "", 60)}</div>`;
  const word = rank ? `<div class="fui-rankword">${esc(rank.label)}</div>` : "";
  const n = m.turns;
  const turns = rank && n >= 1 ? `<div class="fui-turns${n > 1 ? " many" : ""}" ${TIP(`Takes ${n} turn${n > 1 ? "s" : ""} every round`)}><div class="fui-tpips">${Array.from({ length: Math.min(n, 8) }, () => `<span class="fui-tpip"></span>`).join("")}</div><span><b>${n}</b> turn${n > 1 ? "s" : ""}/round</span></div>` : "";
  return { crest, word, turns };
}

function studyFoot(s) {
  const end = s.canContinue
    ? `<button type="button" class="fui-btn fui-go" data-action="continue">Continue ${kbd("Z")}</button>`
    : `<span class="fui-foothint">Waiting for ${esc(s.who)}</span><button type="button" class="fui-btn" data-action="close">Close ${kbd("Esc")}</button>`;
  return `<span class="fui-foothint fui-studyline">${s.line}</span><span class="fui-sp"></span>${end}`;
}

export function tabsOf(m) {
  const nEff = m.groups.buffs.length + m.groups.debuffs.length + m.groups.other.length + (m.enemy ? m.groups.passive.length : 0);
  return m.enemy
    ? [{ key: "effects", label: "Effects", count: String(nEff), bad: m.groups.debuffs.length > 0 }, { key: "actions", label: "Actions", count: m.actions.length ? m.seenText.replace(" of ", "/") : "" }, { key: "notes", label: "Notes", count: "" }]
    : [{ key: "effects", label: "Effects", count: String(nEff), bad: m.groups.debuffs.length > 0 }, { key: "passive", label: "Passive & gear", count: String(m.groups.passive.length) }];
}

/** The card. `ui` = { tab, filter, alt, study }. */
export function renderFrame(m, ui) {
  const tabs = tabsOf(m);
  const tab = tabs.some((t) => t.key === ui.tab) ? ui.tab : "effects";
  const flash = ui.study?.flash ?? 0;
  const pane = tab === "effects" ? effectsPane(m, ui) : tab === "passive" ? passivePane(m) : tab === "actions" ? actionsPane(m, ui) : notesPane(m);
  const vit = m.vitals.map((r) => vitalRow(r)).join("") + crisisBadge(m);
  const stats = m.stats.length ? `<div class="fui-stats">${m.stats.map((s) => `<div class="fui-stat ${esc(s.cls)}"><span>${esc(s.k)}</span><b>${esc(s.v)}</b><i>${esc(s.was)}</i></div>`).join("")}</div>` : "";
  const lock = m.statsLock ? `<div class="fui-lock"><i class="fas fa-lock"></i><span>${esc(m.statsLock)}</span></div>` : "";
  const affs = m.affs.map((a) => `<div class="fui-aff ${esc(a.cls)}${a.gmOnly ? " is-gmonly" : ""}" title="${esc(a.title)}"><i class="fas ${esc(a.icon)}"></i><b>${esc(a.text)}</b>${a.learned ? `<span class="fui-learn"></span>` : ""}</div>`).join("");
  const tier = m.enemy ? `<div class="fui-tier" title="${esc(m.tierTitle)}">${[1, 2, 3].map((k) => `<span class="fui-dia${k <= m.tierN ? " on" : ""}"></span>`).join("")}<span>${esc(m.tierShort)}</span></div>` : "";
  const parts = m.enemy ? enemyHeadParts(m, flash) : { crest: "", word: "", turns: "" };
  const rankCls = m.rank ? `rf-${m.rank.key}` : "";
  const foot = ui.study ? studyFoot(ui.study) : `
        <button type="button" class="fui-btn" data-action="prev" aria-label="Previous unit"><i class="fas fa-chevron-left"></i></button>
        <button type="button" class="fui-btn" data-action="next" aria-label="Next unit"><i class="fas fa-chevron-right"></i></button>
        ${ui.alt ? `<span class="fui-foothint">Release ${kbd("Alt")} to go back</span>` : `${kbd("Tab")}<span class="fui-foothint">next unit</span>`}
        <span class="fui-sp"></span>
        ${m.enemy ? `<button type="button" class="fui-btn" data-action="bestiary"><i class="fas fa-book"></i>Bestiary</button>` : ""}
        <button type="button" class="fui-btn" data-action="close">Close ${kbd("Esc")}</button>`;
  return `
  <div class="fui-frame">
    <div class="fui-card ${m.enemy ? "is-enemy" : ""} ${rankCls}">
      <span class="fui-corner a"></span><span class="fui-corner b"></span><span class="fui-corner c"></span><span class="fui-corner d"></span>
      <div class="fui-head">
        ${parts.crest}
        <div class="fui-headtext">
          ${parts.word}
          <div class="fui-titleline"><div class="fui-name">${esc(m.name)}</div><span class="fui-side ${esc(m.sideCls)}">${esc(m.sideLabel)}</span></div>
          <div class="fui-sub">${esc(m.sub)}</div>
        </div>
        ${parts.turns}
        ${tier}
        ${m.gm ? `<span class="fui-gm" title="Items players can't see yet have a dashed purple outline">GM view</span>` : ""}
        <button type="button" class="fui-x" data-action="close" aria-label="Close inspect"><i class="fas fa-xmark"></i></button>
      </div>
      <div class="fui-body">
        <div class="fui-left">
          ${m.enemy ? enemyLeft(m, affs, flash) : `<div class="fui-label">Vitals</div>${vit}
          ${m.vitalsNote ? `<div class="fui-note">${esc(m.vitalsNote)}</div>` : ""}
          <div class="fui-label">Defense &amp; dice</div>${stats}${lock}
          <div class="fui-label">Affinities</div><div class="fui-affs">${affs}</div>
          ${m.affNote ? `<div class="fui-note">${esc(m.affNote)}</div>` : ""}`}
        </div>
        <div class="fui-right">
          <div class="fui-tabs" role="tablist">
            ${tabs.map((t) => `<button type="button" role="tab" class="fui-tab${t.key === tab ? " on" : ""}" aria-selected="${t.key === tab}" data-action="tab" data-key="${t.key}">${esc(t.label)}${t.count ? `<span class="fui-count${t.bad ? " bad" : ""}">${esc(t.count)}</span>` : ""}</button>`).join("")}
            <span class="fui-tabkeys">${kbd("Q")}${kbd("E")}</span>
          </div>
          <div class="fui-pane">${pane}</div>
        </div>
      </div>
      <div class="fui-foot">${foot}</div>
    </div>
  </div>`;
}

/** Small hover card. `hint` = { key, text }. */
export function renderPeek(m, hint) {
  const shown = m.affs.filter((a) => a.known && a.code !== "NA");
  const unknown = m.affs.filter((a) => !a.known).length;
  return `<div class="fui-peek">
    <div class="fui-titleline">${m.rank ? `<span class="fui-pcrest" title="${esc(m.rank.label)}">${crestSVG(m.rank.key, 30)}</span>` : ""}<div class="fui-pn">${esc(m.name)}</div><span class="fui-side ${esc(m.sideCls)}">${esc(m.sideLabel)}</span></div>
    ${m.vitals.map((r) => vitalRow(r, "fui-prow")).join("")}${crisisBadge(m)}
    <div class="fui-pmini">${shown.map((a) => `<span class="fui-pa ${esc(a.cls)}"><i class="fas ${esc(a.icon)}"></i>${esc(a.text)}</span>`).join("")}${unknown ? `<span class="fui-pa aff-unk">${unknown} unknown</span>` : ""}</div>
    ${m.peekIcons.length ? `<div class="fui-picons">${m.peekIcons.map((i) => `<img src="${esc(i.img)}" alt="${esc(i.name)}" title="${esc(i.name)}" onerror="this.style.visibility='hidden'">`).join("")}</div>` : ""}
    <div class="fui-phint">${kbd(hint.key)}${esc(hint.text)}</div>
  </div>`;
}

export function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.appendChild(st);
}

const CSS = `
/* Above Foundry app windows (sheets, journals, dialogs climb past 100), below #tooltip. */
#${ROOT_ID}{position:fixed;inset:0;pointer-events:none;z-index:9000;
  --parch-a:#f6f1e6;--parch-b:#ebe3d0;--ink:#3a3228;--ink-soft:#6a5d4c;--gold-1:#d5b67a;--gold-2:#b7935a;--stroke:#7a6a55;
  font-family:"Inter","Signika","Segoe UI",system-ui,sans-serif;color:var(--ink)}
#${ROOT_ID} *{box-sizing:border-box}
#${ROOT_ID} button{width:auto;flex:none;margin:0;box-shadow:none}
#${ROOT_ID} button:focus{outline:none;box-shadow:none}
#${ROOT_ID} button:focus-visible{outline:2px solid #7a5a2a;outline-offset:1px}
/* The battlefield behind an inspected unit: dimmed and desaturated. The HUD is
   darkened to about the field's level but stays SOLID, so the card and the unit
   read first (user, 2026-10-14). It used to fade to half opacity, which let the
   battlefield show through the panels' text and cluttered the screen. Opacity is
   never touched: some overlays sit at an inline opacity 0, and forcing it would
   show them. No blur: a blur on the full-screen WebGL canvas is GPU work every
   frame, and heavy GPU load can take the user's machine down (user, 2026-10-14);
   brightness/saturate is a cheap colour matrix, and canvases are left out.
   WHICH elements get .fu-inspect-dim is decided in unit-inspect.js (dimHud):
   a filter re-parents fixed children, so wrappers are dimmed one level down. */
body.fu-inspecting #board{filter:brightness(.4) saturate(.45);transition:filter 420ms ease}
body.fu-inspect-leaving #board{transition:filter 420ms ease}
body.fu-inspecting .fu-inspect-dim{filter:brightness(.42) saturate(.5);transition:filter 420ms ease}
/* The unit IN the world: a layer right after #board, under the HUD. No z-index
   (no stacking context), so the light's screen blend reaches the dimmed canvas.
   Light is static; it fades in once the camera has arrived. */
#${WORLD_ID}{position:absolute;inset:0;pointer-events:none;overflow:hidden}
#${WORLD_ID} > *{position:absolute;left:0;top:0;pointer-events:none;transform-origin:0 0}
#${WORLD_ID} .fuw-light{mix-blend-mode:screen;opacity:0;transition:opacity 380ms ease;overflow:visible}
#${WORLD_ID} .fuw-light.on{opacity:1}
#${WORLD_ID} .fui-sprite{image-rendering:pixelated;filter:drop-shadow(0 0 2px rgba(255,232,180,.45));animation:fui-cutin 260ms ease-out}
@keyframes fui-cutin{from{opacity:0}to{opacity:1}}
#${ROOT_ID} .fui-place{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:auto}
#${ROOT_ID} .fui-frame{display:flex;align-items:stretch;height:${FRAME_H}px;animation:fui-cutin 200ms ease-out}
#${ROOT_ID} .fui-card{position:relative;width:${CARD_W}px;display:flex;flex-direction:column;background:linear-gradient(180deg,var(--parch-a),var(--parch-b));
  border:2px solid var(--stroke);border-radius:12px;box-shadow:0 0 0 1px rgba(255,255,255,.7) inset,0 10px 28px rgba(0,0,0,.5)}
#${ROOT_ID} .fui-card::before,#${ROOT_ID} .fui-peek::before{content:"";position:absolute;inset:4px;border:1px solid var(--gold-1);border-radius:8px;pointer-events:none}
#${ROOT_ID} .fui-head{position:relative;display:flex;align-items:center;gap:14px;padding:14px 18px 12px;border-bottom:1px solid rgba(122,106,85,.3)}
#${ROOT_ID} .fui-headtext{min-width:0;flex:1}
#${ROOT_ID} .fui-titleline{display:flex;align-items:center;gap:10px}
#${ROOT_ID} .fui-name{font-size:26px;font-weight:800;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${ROOT_ID} .fui-sub{font-size:13px;color:var(--ink-soft);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${ROOT_ID} .fui-side{flex:none;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;padding:3px 8px;border-radius:6px}
#${ROOT_ID} .side-enemy{background:#f3d8d2;color:#8e1f17}#${ROOT_ID} .side-party{background:#dbe9d6;color:#24572a}#${ROOT_ID} .side-ally{background:#e4dcf0;color:#4b3478}
#${ROOT_ID} .fui-tier{display:flex;align-items:center;gap:5px;font-size:12px;color:#4f4537;white-space:nowrap}
#${ROOT_ID} .fui-tier>span:last-child{margin-left:4px}
#${ROOT_ID} .fui-dia{width:10px;height:10px;transform:rotate(45deg);border:1.5px solid var(--gold-2)}
#${ROOT_ID} .fui-dia.on{background:#d39b2a;border-color:#a8781c}
#${ROOT_ID} .fui-gm{font-size:10.5px;font-weight:700;color:#5b3b8c}
#${ROOT_ID} .fui-x{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--gold-2);border-radius:8px;
  background:linear-gradient(180deg,#fbf7ee,#efe6d2);color:var(--ink);cursor:pointer;font-size:15px;padding:0;line-height:1}
#${ROOT_ID} .fui-body{display:grid;grid-template-columns:300px minmax(0,1fr);flex:1;min-height:0}
#${ROOT_ID} .fui-left{padding:4px 16px 12px 18px;border-right:1px solid rgba(122,106,85,.25);overflow:hidden}
#${ROOT_ID} .fui-right{display:flex;flex-direction:column;min-width:0;min-height:0}
#${ROOT_ID} .fui-label{font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-soft);margin:12px 0 6px;display:flex;align-items:center;gap:8px}
#${ROOT_ID} .fui-label::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--gold-1),rgba(213,182,122,0))}
#${ROOT_ID} .fui-bar{position:relative;height:9px;border-radius:5px;background:rgba(58,50,40,.14);overflow:hidden}
#${ROOT_ID} .fui-bar>i{position:absolute;left:0;top:0;bottom:0;border-radius:5px}
#${ROOT_ID} .is-hp{background:linear-gradient(90deg,#2fbf71,#6bd66b)}#${ROOT_ID} .is-crisis{background:linear-gradient(90deg,#d9822b,#ffb84a)}
#${ROOT_ID} .is-ko{background:#8a7d6a}#${ROOT_ID} .is-mp{background:linear-gradient(90deg,#2e7bd6,#5aa8ff)}#${ROOT_ID} .is-zp{background:linear-gradient(90deg,#ff9c2e,#ffd95a)}
#${ROOT_ID} .fui-vrow{display:grid;grid-template-columns:28px minmax(0,1fr) 84px;align-items:center;gap:8px;margin:5px 0}
#${ROOT_ID} .fui-vk{font-size:11px;font-weight:800;letter-spacing:.1em;color:var(--ink-soft)}
#${ROOT_ID} .fui-vv{font-size:16px;font-weight:800;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
#${ROOT_ID} .fui-pips{display:flex;gap:3px;align-items:center;flex-wrap:wrap}
#${ROOT_ID} .fui-pip{width:9px;height:9px;border-radius:50%;background:rgba(58,50,40,.18)}
#${ROOT_ID} .fui-pip.on{background:#e8a43a;box-shadow:0 0 0 1px rgba(122,90,42,.35) inset}
#${ROOT_ID} .fui-zpn{font-size:11px;color:var(--ink-soft);margin:-2px 0 2px 36px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${ROOT_ID} .fui-crisis{display:inline-block;font-size:12px;font-weight:800;padding:4px 9px;border-radius:6px;margin:4px 0}
#${ROOT_ID} .fui-crisis.on{background:#fbe2c4;color:#9a4b05}#${ROOT_ID} .fui-crisis.off{background:#dcebd7;color:#24692c}
#${ROOT_ID} .fui-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:4px}
#${ROOT_ID} .fui-stat{background:rgba(59,42,25,.06);border-radius:7px;padding:5px 2px 4px;text-align:center;min-width:0}
#${ROOT_ID} .fui-stat b{display:block;font-size:15px;font-weight:800}
#${ROOT_ID} .fui-stat span{font-size:9.5px;font-weight:800;letter-spacing:.03em;color:var(--ink-soft);white-space:nowrap}
#${ROOT_ID} .fui-stat i{display:block;font-style:normal;font-size:9px;color:var(--ink-soft);min-height:11px;white-space:nowrap}
#${ROOT_ID} .fui-stat.is-down b{color:#a3261b}#${ROOT_ID} .fui-stat.is-up b{color:#24692c}
#${ROOT_ID} .fui-lock{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-soft);background:rgba(59,42,25,.06);border:1px dashed rgba(122,106,85,.5);border-radius:8px;padding:7px 9px;margin-top:5px}
#${ROOT_ID} .fui-affs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}
#${ROOT_ID} .fui-aff{position:relative;display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:7px;background:rgba(59,42,25,.06)}
#${ROOT_ID} .fui-aff i{width:16px;text-align:center;font-size:13px;color:var(--ink-soft)}
#${ROOT_ID} .fui-aff b{font-size:10.5px;font-weight:800;letter-spacing:.03em;text-transform:uppercase}
#${ROOT_ID} .aff-vu{background:#f6d9d3}#${ROOT_ID} .aff-vu b,#${ROOT_ID} .aff-vu i{color:#a3261b}
#${ROOT_ID} .aff-rs b{color:#2e64a8}#${ROOT_ID} .aff-im b{color:#4b3517}#${ROOT_ID} .aff-ab b{color:#24692c}#${ROOT_ID} .aff-na b{color:#8a7d6a}
#${ROOT_ID} .aff-unk{background:repeating-linear-gradient(135deg,rgba(58,50,40,.07) 0 5px,rgba(58,50,40,.03) 5px 10px)}
#${ROOT_ID} .aff-unk i{opacity:.35}#${ROOT_ID} .aff-unk b{color:#8a7d6a;font-size:12px}
#${ROOT_ID} .fui-learn{position:absolute;top:3px;right:4px;width:6px;height:6px;border-radius:50%;background:#d39b2a;box-shadow:0 0 0 1px var(--parch-a)}
#${ROOT_ID} .is-gmonly{outline:1px dashed rgba(91,59,140,.6);outline-offset:-1px}
#${ROOT_ID} .fui-note{font-size:11.5px;color:var(--ink-soft);margin-top:6px;line-height:1.4}
#${ROOT_ID} .fui-note b{color:var(--ink)}
#${ROOT_ID} .fui-note-top{margin:0 0 8px}
#${ROOT_ID} .fui-tabs{display:flex;gap:2px;padding:10px 14px 0;border-bottom:1px solid rgba(122,106,85,.35)}
#${ROOT_ID} .fui-tab{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 13px;font:inherit;font-size:12.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  color:var(--ink-soft);background:transparent;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;cursor:pointer;margin-bottom:-1px;line-height:1}
#${ROOT_ID} .fui-tab:hover{color:var(--ink);background:rgba(213,182,122,.18)}
#${ROOT_ID} .fui-tab.on{color:var(--ink);background:#f7f2e7;border-color:rgba(122,106,85,.45)}
#${ROOT_ID} .fui-count{font-size:11px;font-weight:800;padding:1px 6px;border-radius:9px;background:rgba(59,42,25,.1);color:#4f4537;letter-spacing:0}
#${ROOT_ID} .fui-count.bad{background:#f6d9d3;color:#a3261b}
#${ROOT_ID} .fui-tabkeys{margin-left:auto;display:flex;align-items:center;gap:4px;padding-bottom:8px}
#${ROOT_ID} .fui-pane{flex:1;min-height:0;overflow-y:auto;padding:10px 14px 12px;scrollbar-width:thin;scrollbar-color:rgba(58,50,40,.35) transparent}
#${ROOT_ID} .fui-pane.is-in{animation:fui-cutin 160ms ease-out}
#${ROOT_ID} .fui-pane.is-in-r{animation:fui-pane-r 200ms ease-out}
#${ROOT_ID} .fui-pane.is-in-l{animation:fui-pane-l 200ms ease-out}
@keyframes fui-pane-r{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
@keyframes fui-pane-l{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){#${ROOT_ID} .fui-pane.is-in-r,#${ROOT_ID} .fui-pane.is-in-l{animation:fui-cutin 160ms ease-out}}
#${ROOT_ID} .fui-filters{display:flex;gap:5px;margin-bottom:8px;flex-wrap:wrap}
#${ROOT_ID} .fui-fchip{display:inline-flex;align-items:center;height:26px;padding:0 10px;font:inherit;font-size:11.5px;font-weight:700;color:#4f4537;
  background:rgba(59,42,25,.06);border:1px solid rgba(122,106,85,.3);border-radius:13px;cursor:pointer;line-height:1}
#${ROOT_ID} .fui-fchip.on{background:#3b2f24;color:#f3e6c8;border-color:#3b2f24}
#${ROOT_ID} .fui-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 10px}
#${ROOT_ID} .fui-grp{grid-column:1 / -1;font-size:11px;font-weight:800;color:var(--ink-soft);margin:6px 0 1px;letter-spacing:.06em;text-transform:uppercase}
#${ROOT_ID} .fui-grp.g-bad{color:#a3261b}#${ROOT_ID} .fui-grp.g-good{color:#24692c}
#${ROOT_ID} .fui-eff{display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;align-items:center;padding:4px 6px;border-radius:8px;background:rgba(59,42,25,.04);min-width:0}
#${ROOT_ID} .fui-eff.is-inactive{opacity:.55}
#${ROOT_ID} .fui-ico{width:28px;height:28px;border-radius:6px;background:#2a2118;object-fit:cover;box-shadow:0 0 0 1px rgba(122,106,85,.6)}
#${ROOT_ID} .fui-effbody{min-width:0}
#${ROOT_ID} .fui-en{display:flex;align-items:center;gap:6px;min-width:0}
#${ROOT_ID} .fui-en b{font-size:12.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#${ROOT_ID} .fui-el{font-size:11px;color:var(--ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${ROOT_ID} .fui-chip i{margin-right:3px}
#${ROOT_ID} .fui-chip{display:inline-block;font-size:11px;font-weight:800;padding:1px 6px;border-radius:5px;white-space:nowrap;margin-left:auto;flex:none;max-width:55%;overflow:hidden;text-overflow:ellipsis}
#${ROOT_ID} .tone-good{color:#24692c;background:#dcebd7}#${ROOT_ID} .tone-bad{color:#a3261b;background:#f6d9d3}#${ROOT_ID} .tone-neutral{color:#4b3517;background:rgba(59,42,25,.08)}
#${ROOT_ID} .fui-act{display:grid;grid-template-columns:36px minmax(0,1fr);gap:9px;padding:7px 8px;border-radius:8px;background:rgba(59,42,25,.045);margin-bottom:5px}
#${ROOT_ID} .fui-acti{width:36px;height:36px;border-radius:7px;background:#2a2118;object-fit:cover;box-shadow:0 0 0 1px rgba(122,106,85,.6);border:0}
#${ROOT_ID} .fui-actq{width:36px;height:36px;border-radius:7px;display:flex;align-items:center;justify-content:center;color:#8a7d6a;background:rgba(59,42,25,.08)}
#${ROOT_ID} .fui-actb{min-width:0}
#${ROOT_ID} .fui-acttop{display:flex;align-items:center;flex-wrap:wrap;gap:5px 7px}
#${ROOT_ID} .fui-actn{font-size:14px;font-weight:700;line-height:1.2}
#${ROOT_ID} .fui-act.is-unk .fui-actn{color:#8a7d6a}
#${ROOT_ID} .fui-dice{font-size:11px;font-weight:600;color:var(--ink-soft)}
#${ROOT_ID} .fui-kind{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft);margin-left:auto}
#${ROOT_ID} .fui-cost{display:inline-flex;align-items:center;font-size:12px;font-weight:800;color:#fff;padding:1px 7px;border-radius:5px;line-height:1.45;white-space:nowrap}
#${ROOT_ID} .c-mp{background:#2e7bd6}#${ROOT_ID} .c-ip{background:#b9770f}#${ROOT_ID} .c-zp{background:linear-gradient(90deg,#c9500a,#e88a12)}#${ROOT_ID} .c-hp{background:#a3261b}
#${ROOT_ID} .c-free{background:rgba(59,42,25,.1);color:#6a5d4c;font-weight:600}
#${ROOT_ID} .c-short{background:#cfc6b4;color:#6a5d4c}
#${ROOT_ID} .fui-actd{font-size:12.5px;line-height:1.42;color:#4a4032;margin-top:3px}
#${ROOT_ID} .fui-actd p{margin:0 0 2px}
#${ROOT_ID} .fui-actd ul{margin:0 0 2px;padding:0;list-style:none}
#${ROOT_ID} .fui-actd.is-none{font-style:italic;color:#8a7d6a}
#${ROOT_ID} .fui-seen{margin-left:auto;align-self:center;font-size:11.5px;color:var(--ink-soft)}
#${ROOT_ID} .fui-hint{font-size:14px;color:#4f4537;line-height:1.5;padding:10px 12px;border-radius:8px;background:rgba(213,182,122,.16)}
#${ROOT_ID} .fui-hint p{margin:0}
#${ROOT_ID} .fui-label-first{margin-top:0}
/* The enemy card: a tighter left column, because the card never grows. */
#${ROOT_ID} .is-enemy .fui-head{gap:13px;padding:13px 18px 11px;border-radius:10px 10px 0 0}
#${ROOT_ID} .is-enemy .fui-left{padding:0 16px 4px 18px;overflow-y:auto;scrollbar-width:none}
#${ROOT_ID} .is-enemy .fui-left .fui-label{margin:6px 0 3px;line-height:14px}
#${ROOT_ID} .is-enemy .fui-left .fui-note{margin-top:2px;line-height:1.25}
#${ROOT_ID} .is-enemy .fui-left .fui-lock{margin-top:2px;padding:3px 8px}
#${ROOT_ID} .is-enemy .fui-aff{height:23px;padding:3px 7px}
#${ROOT_ID} .is-enemy .aff-im{background:rgba(224,168,30,.28)}
#${ROOT_ID} .is-enemy .aff-rs{background:#dbe5f2}
#${ROOT_ID} .fui-crestbox{flex:none;line-height:0}
#${ROOT_ID} .fui-rankword{font-size:11.5px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;line-height:1;margin-bottom:3px}
#${ROOT_ID} .rf-soldier .fui-rankword{color:#5e6468}
#${ROOT_ID} .fui-turns{display:grid;justify-items:center;gap:2px;font-size:10.5px;color:#4f4537;line-height:1.1;white-space:nowrap}
#${ROOT_ID} .fui-tpips{display:flex;gap:3px}
#${ROOT_ID} .fui-tpip{width:9px;height:14px;background:#6a5d4c;clip-path:polygon(50% 0,100% 28%,100% 100%,0 100%,0 28%)}
#${ROOT_ID} .fui-turns.many .fui-tpip{background:#b3261b}#${ROOT_ID} .fui-turns.many b{color:#a3261b}
/* Rank escalates the whole card: plain, blue band, crimson band with gold corners. */
#${ROOT_ID} .fui-corner{display:none;position:absolute;width:22px;height:22px;border:3px solid #ffd76a;z-index:4;pointer-events:none}
#${ROOT_ID} .fui-corner.a{left:-6px;top:-6px;border-right:0;border-bottom:0}#${ROOT_ID} .fui-corner.b{right:-6px;top:-6px;border-left:0;border-bottom:0}
#${ROOT_ID} .fui-corner.c{left:-6px;bottom:-6px;border-right:0;border-top:0}#${ROOT_ID} .fui-corner.d{right:-6px;bottom:-6px;border-left:0;border-top:0}
#${ROOT_ID} .rf-champion .fui-corner,#${ROOT_ID} .rf-villain .fui-corner{display:block}
#${ROOT_ID} .rf-elite{border-color:#2c4672;box-shadow:0 0 0 1px rgba(255,255,255,.7) inset,0 0 0 2px #c9a44a,0 10px 28px rgba(0,0,0,.5)}
#${ROOT_ID} .rf-elite .fui-head{background:linear-gradient(180deg,#34568f,#233c68);border-bottom:2px solid #c9a44a}
#${ROOT_ID} .rf-champion,#${ROOT_ID} .rf-villain{border-color:#6e4b10;box-shadow:0 0 0 1px rgba(255,255,255,.6) inset,0 0 0 3px #d7ad45,0 0 0 5px #5a1712,0 0 30px rgba(226,120,50,.45),0 10px 28px rgba(0,0,0,.5)}
#${ROOT_ID} .rf-champion .fui-head,#${ROOT_ID} .rf-villain .fui-head{background:linear-gradient(180deg,#71190f,#3a0d09);border-bottom:2px solid #e2b64a}
#${ROOT_ID} .rf-elite .fui-name,#${ROOT_ID} .rf-champion .fui-name,#${ROOT_ID} .rf-villain .fui-name{color:#fbf1d8}
#${ROOT_ID} .rf-elite .fui-sub,#${ROOT_ID} .rf-champion .fui-sub,#${ROOT_ID} .rf-villain .fui-sub{color:#e0d3b4}
#${ROOT_ID} .rf-elite .fui-rankword{color:#f0d890}#${ROOT_ID} .rf-champion .fui-rankword,#${ROOT_ID} .rf-villain .fui-rankword{color:#ffd76a}
#${ROOT_ID} .rf-elite .fui-tier,#${ROOT_ID} .rf-champion .fui-tier,#${ROOT_ID} .rf-villain .fui-tier,#${ROOT_ID} .rf-elite .fui-turns,#${ROOT_ID} .rf-champion .fui-turns,#${ROOT_ID} .rf-villain .fui-turns{color:#f1e5c8}
#${ROOT_ID} .rf-elite .fui-dia,#${ROOT_ID} .rf-champion .fui-dia,#${ROOT_ID} .rf-villain .fui-dia{border-color:#e6c977}
#${ROOT_ID} .rf-elite .fui-tpip{background:#e7ddc4}
#${ROOT_ID} .rf-elite .fui-turns.many .fui-tpip,#${ROOT_ID} .rf-champion .fui-tpip,#${ROOT_ID} .rf-villain .fui-tpip{background:#ffb347}
#${ROOT_ID} .rf-elite .fui-turns.many b,#${ROOT_ID} .rf-champion .fui-turns.many b,#${ROOT_ID} .rf-villain .fui-turns.many b{color:#ffd76a}
#${ROOT_ID} .rf-elite .fui-side,#${ROOT_ID} .rf-champion .fui-side,#${ROOT_ID} .rf-villain .fui-side{background:rgba(255,255,255,.14);color:#fbe8c8}
/* DEF orange (mostly physical), M.DEF blue (mostly magical). */
#${ROOT_ID} .fui-vw{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
#${ROOT_ID} .fui-vw .fui-vrow{grid-template-columns:20px minmax(0,1fr) 66px;gap:5px;margin:4px 0}
#${ROOT_ID} .fui-vw .fui-vv{font-size:14.5px}
#${ROOT_ID} .fui-sbs{display:flex;gap:3px;border-radius:7px}
#${ROOT_ID} .fui-sb{position:relative;width:38px;display:grid;justify-items:center;--sh-rim:#ffe6c9;--sh-top:#ee9440;--sh-bot:#a34c10}
#${ROOT_ID} .fui-sb.is-mag{--sh-rim:#dcecff;--sh-top:#5a94ea;--sh-bot:#1c4a9c}
#${ROOT_ID} .fui-sb.is-unk{--sh-rim:#cfc6b4;--sh-top:#a89a84;--sh-bot:#8a7d6a}
#${ROOT_ID} .fui-sb svg{display:block;width:34px;height:40px;filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))}
#${ROOT_ID} .fui-sb b{position:absolute;left:0;right:0;top:10px;text-align:center;font-size:15px;font-weight:800;line-height:17px;color:#fff;text-shadow:0 1px 1px rgba(0,0,0,.7)}
#${ROOT_ID} .fui-sb em{font-style:normal;font-size:9.5px;font-weight:800;letter-spacing:.03em;color:var(--ink-soft);line-height:1.1;white-space:nowrap}
#${ROOT_ID} .fui-dcs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px}
#${ROOT_ID} .fui-dc{display:flex;align-items:center;justify-content:center;gap:5px;height:24px;border-radius:7px;background:rgba(59,42,25,.06)}
#${ROOT_ID} .fui-dc img{width:18px;height:18px;display:block;object-fit:contain;border:0}
#${ROOT_ID} .fui-dc b{font-size:14px;font-weight:800}
#${ROOT_ID} .fui-dc.is-down b{color:#a3261b}#${ROOT_ID} .fui-dc.is-up b{color:#24692c}
#${ROOT_ID} .fui-wgs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px 10px}
#${ROOT_ID} .fui-wg{display:grid;grid-template-columns:15px minmax(0,1fr) 31px;align-items:center;gap:4px;height:17px;border-radius:3px}
#${ROOT_ID} .fui-wgi{display:flex;align-items:center;justify-content:center;font-size:11.5px;color:var(--ink-soft)}
#${ROOT_ID} .fui-wgb{position:relative;height:6px;border-radius:3px;background:rgba(59,42,25,.1)}
#${ROOT_ID} .fui-wgb::after{content:"";position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:rgba(59,42,25,.35)}
#${ROOT_ID} .fui-wgb>i{position:absolute;top:0;bottom:0;border-radius:3px}
#${ROOT_ID} .fui-wg b{font-size:11.5px;font-weight:800;text-align:right;font-variant-numeric:tabular-nums;color:#a89a84}
#${ROOT_ID} .fui-wg.up .fui-wgb>i{background:linear-gradient(90deg,#f26b5b,#c0261c)}#${ROOT_ID} .fui-wg.up b,#${ROOT_ID} .fui-wg.up .fui-wgi{color:#a3261b}
#${ROOT_ID} .fui-wg.down .fui-wgb>i{background:linear-gradient(270deg,#5aa8ff,#2e64a8)}#${ROOT_ID} .fui-wg.down b,#${ROOT_ID} .fui-wg.down .fui-wgi{color:#2e64a8}
/* Status: one labelled row per grade, listing only what this creature resists. */
#${ROOT_ID} .fui-strow{display:grid;grid-template-columns:40px minmax(0,1fr);gap:3px;align-items:start}
#${ROOT_ID} .fui-strow+.fui-strow{margin-top:2px}
#${ROOT_ID} .fui-sts{display:flex;flex-wrap:wrap;gap:1px}
#${ROOT_ID} .fui-sttag{height:19px;line-height:19px;border-radius:4px;text-align:center;font-size:9.5px;font-weight:800;letter-spacing:.02em}
#${ROOT_ID} .fui-sttag.im{background:#e0a81e;color:#2a1d08}#${ROOT_ID} .fui-sttag.rs{background:#2f7fe8;color:#fff}
#${ROOT_ID} .fui-sttag.ab{background:#24692c;color:#fff}#${ROOT_ID} .fui-sttag.vu{background:#a3261b;color:#fff}
#${ROOT_ID} .fui-stp{width:19px;height:19px;display:block;border-radius:4px;text-align:center;line-height:19px;color:var(--ink-soft)}
#${ROOT_ID} .fui-stp img{width:19px;height:19px;display:block;border-radius:4px;object-fit:cover;border:0}
#${ROOT_ID} .fui-stall{font-size:12px;line-height:19px;font-weight:600}
/* The Study reveal: each newly learned tier lights up once. */
#${ROOT_ID} .fui-new{order:2;font-size:9.5px;letter-spacing:.08em;background:#d39b2a;color:#fff8e6;padding:0 5px;border-radius:4px}
#${ROOT_ID} .fui-flash{animation:fui-unlock 1000ms ease-out}
@keyframes fui-unlock{0%{background-color:rgba(255,206,92,.85);box-shadow:0 0 0 2px #d39b2a}100%{box-shadow:0 0 0 0 rgba(211,155,42,0)}}
#${ROOT_ID} .fui-stamp{animation:fui-stamp 420ms steps(5) both}
@keyframes fui-stamp{from{transform:scale(1.9);opacity:.2}to{transform:scale(1);opacity:1}}
#${ROOT_ID} .fui-btn.fui-go{height:32px;padding:0 14px;background:linear-gradient(180deg,#7a5230,#5c3818);color:#f3e6c8;border-color:#3a2410}
#${ROOT_ID} .fui-studyline b{color:var(--ink)}
#${ROOT_ID} .fui-pcrest{flex:none;line-height:0}
@media (prefers-reduced-motion: reduce){#${ROOT_ID} .fui-flash,#${ROOT_ID} .fui-stamp{animation-duration:1ms}}
#${ROOT_ID} .fui-steps{display:grid;gap:5px}
#${ROOT_ID} .fui-step{display:flex;align-items:center;gap:9px;font-size:12.5px;padding:6px 9px;border-radius:7px;background:rgba(59,42,25,.05)}
#${ROOT_ID} .fui-step.done{color:#24692c}
#${ROOT_ID} .fui-step b{width:34px;font-variant-numeric:tabular-nums}
#${ROOT_ID} .fui-step em{margin-left:auto;font-style:normal;font-weight:800}
#${ROOT_ID} .fui-foot{display:flex;align-items:center;gap:6px;padding:8px 14px 11px;border-top:1px solid rgba(122,106,85,.3)}
#${ROOT_ID} .fui-foothint{font-size:11.5px;color:var(--ink-soft)}
#${ROOT_ID} .fui-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;font:inherit;font-size:11.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  color:var(--ink);background:linear-gradient(180deg,#fbf7ee,#efe6d2);border:1px solid var(--gold-2);border-radius:7px;cursor:pointer;width:auto;line-height:1;margin:0}
#${ROOT_ID} .fui-btn:hover,#${ROOT_ID} .fui-x:hover{box-shadow:0 0 0 2px rgba(213,182,122,.6)}
#${ROOT_ID} .fui-kbd{font-size:10px;font-weight:800;padding:1px 5px;border-radius:4px;border:1px solid rgba(122,106,85,.6);color:var(--ink-soft);background:#fff8ea;font-family:inherit;box-shadow:none}
#${ROOT_ID} .fui-sp{flex:1}
#${ROOT_ID} .fui-peekwrap{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none}
#${ROOT_ID} .fui-peek{position:relative;width:276px;padding:11px 13px 10px;background:linear-gradient(180deg,var(--parch-a),var(--parch-b));border:2px solid var(--stroke);border-radius:12px;
  box-shadow:0 0 0 1px rgba(255,255,255,.7) inset,0 10px 28px rgba(0,0,0,.5);animation:fui-cutin 160ms ease-out}
#${ROOT_ID} .fui-pn{font-size:16px;font-weight:800;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${ROOT_ID} .fui-prow{display:grid;grid-template-columns:22px minmax(0,1fr) auto;align-items:center;gap:7px;margin-top:6px}
#${ROOT_ID} .fui-prow .fui-vk{font-size:10px}#${ROOT_ID} .fui-prow .fui-vv{font-size:12px}
#${ROOT_ID} .fui-pmini{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
#${ROOT_ID} .fui-pa{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:800;padding:2px 6px 2px 5px;border-radius:5px;background:rgba(59,42,25,.07);text-transform:uppercase}
#${ROOT_ID} .fui-pa i{font-size:10px}
#${ROOT_ID} .fui-picons{display:flex;gap:4px;margin-top:7px}
#${ROOT_ID} .fui-picons img{width:24px;height:24px;border-radius:5px;background:#2a2118;box-shadow:0 0 0 1px rgba(122,106,85,.6);border:0}
#${ROOT_ID} .fui-phint{display:flex;align-items:center;gap:6px;margin-top:8px;padding-top:7px;border-top:1px solid rgba(122,106,85,.25);font-size:11.5px;color:var(--ink-soft);font-weight:600}
`;
