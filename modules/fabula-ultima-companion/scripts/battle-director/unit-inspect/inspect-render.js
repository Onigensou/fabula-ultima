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

export const CARD_W = 820;
export const FRAME_H = 528;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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

function actionsPane(m) {
  if (!m.actions.length) return `<div class="fui-note">${m.hasEntry ? "No actions recorded for this creature." : "Nothing recorded yet."}</div>`;
  return `<div class="fui-note fui-note-top">${esc(m.seenText)} seen. Each one is added when the party watches it used.</div>`
    + m.actions.map((a) => `<div class="fui-act${a.known ? "" : " is-unk"}${a.gmOnly ? " is-gmonly" : ""}"><b>${esc(a.name)}</b>${a.gmOnly ? `<span class="fui-gm">not seen by players</span>` : ""}<span class="fui-kind">${esc(a.kind)}</span></div>`).join("");
}

function notesPane(m) {
  const hint = plain(m.hint);
  return `${hint ? `<div class="fui-hint">${esc(hint)}</div>` : `<div class="fui-note fui-note-top">Study 7+ to read what the party knows about this creature.</div>`}
    ${m.conds ? `<div class="fui-note"><b>Status immunities:</b> ${esc(m.conds)}</div>` : ""}
    <div class="fui-label">Study progress</div>
    <div class="fui-steps">${m.steps.map((s) => `<div class="fui-step${s.done ? " done" : ""}"><b>${esc(s.n)}</b><span>${esc(s.text)}</span><em>${s.done ? "Known" : "—"}</em></div>`).join("")}</div>`;
}

export function tabsOf(m) {
  const nEff = m.groups.buffs.length + m.groups.debuffs.length + m.groups.other.length + (m.enemy ? m.groups.passive.length : 0);
  return m.enemy
    ? [{ key: "effects", label: "Effects", count: String(nEff), bad: m.groups.debuffs.length > 0 }, { key: "actions", label: "Actions", count: m.actions.length ? m.seenText.replace(" of ", "/") : "" }, { key: "notes", label: "Notes", count: "" }]
    : [{ key: "effects", label: "Effects", count: String(nEff), bad: m.groups.debuffs.length > 0 }, { key: "passive", label: "Passive & gear", count: String(m.groups.passive.length) }];
}

/** The card. `ui` = { tab, filter, alt }. */
export function renderFrame(m, ui) {
  const tabs = tabsOf(m);
  const tab = tabs.some((t) => t.key === ui.tab) ? ui.tab : "effects";
  const pane = tab === "effects" ? effectsPane(m, ui) : tab === "passive" ? passivePane(m) : tab === "actions" ? actionsPane(m) : notesPane(m);
  const vit = m.vitals.map((r) => vitalRow(r)).join("") + crisisBadge(m);
  const stats = m.stats.length ? `<div class="fui-stats">${m.stats.map((s) => `<div class="fui-stat ${esc(s.cls)}"><span>${esc(s.k)}</span><b>${esc(s.v)}</b><i>${esc(s.was)}</i></div>`).join("")}</div>` : "";
  const lock = m.statsLock ? `<div class="fui-lock"><i class="fas fa-lock"></i><span>${esc(m.statsLock)}</span></div>` : "";
  const affs = m.affs.map((a) => `<div class="fui-aff ${esc(a.cls)}${a.gmOnly ? " is-gmonly" : ""}" title="${esc(a.title)}"><i class="fas ${esc(a.icon)}"></i><b>${esc(a.text)}</b>${a.learned ? `<span class="fui-learn"></span>` : ""}</div>`).join("");
  const tier = m.enemy ? `<div class="fui-tier" title="${esc(m.tierTitle)}">${[1, 2, 3].map((k) => `<span class="fui-dia${k <= m.tierN ? " on" : ""}"></span>`).join("")}<span>${esc(m.tierShort)}</span></div>` : "";
  return `
  <div class="fui-frame">
    <div class="fui-card">
      <div class="fui-head">
        <div class="fui-headtext">
          <div class="fui-titleline"><div class="fui-name">${esc(m.name)}</div><span class="fui-side ${esc(m.sideCls)}">${esc(m.sideLabel)}</span></div>
          <div class="fui-sub">${esc(m.sub)}</div>
        </div>
        ${tier}
        ${m.gm ? `<span class="fui-gm" title="Items players can't see yet have a dashed purple outline">GM view</span>` : ""}
        <button type="button" class="fui-x" data-action="close" aria-label="Close inspect"><i class="fas fa-xmark"></i></button>
      </div>
      <div class="fui-body">
        <div class="fui-left">
          <div class="fui-label">Vitals</div>${vit}
          ${m.vitalsNote ? `<div class="fui-note">${esc(m.vitalsNote)}</div>` : ""}
          <div class="fui-label">Defense &amp; dice</div>${stats}${lock}
          <div class="fui-label">Affinities</div><div class="fui-affs">${affs}</div>
          ${m.affNote ? `<div class="fui-note">${esc(m.affNote)}</div>` : ""}
        </div>
        <div class="fui-right">
          <div class="fui-tabs" role="tablist">
            ${tabs.map((t) => `<button type="button" role="tab" class="fui-tab${t.key === tab ? " on" : ""}" aria-selected="${t.key === tab}" data-action="tab" data-key="${t.key}">${esc(t.label)}${t.count ? `<span class="fui-count${t.bad ? " bad" : ""}">${esc(t.count)}</span>` : ""}</button>`).join("")}
            <span class="fui-tabkeys">${kbd("Q")}${kbd("E")}</span>
          </div>
          <div class="fui-pane">${pane}</div>
        </div>
      </div>
      <div class="fui-foot">
        <button type="button" class="fui-btn" data-action="prev" aria-label="Previous unit"><i class="fas fa-chevron-left"></i></button>
        <button type="button" class="fui-btn" data-action="next" aria-label="Next unit"><i class="fas fa-chevron-right"></i></button>
        ${ui.alt ? `<span class="fui-foothint">Release ${kbd("Alt")} to go back</span>` : `${kbd("Tab")}<span class="fui-foothint">next unit</span>`}
        <span class="fui-sp"></span>
        ${m.enemy ? `<button type="button" class="fui-btn" data-action="bestiary"><i class="fas fa-book"></i>Bestiary</button>` : ""}
        <button type="button" class="fui-btn" data-action="close">Close ${kbd("Esc")}</button>
      </div>
    </div>
  </div>`;
}

/** Small hover card. `hint` = { key, text }. */
export function renderPeek(m, hint) {
  const shown = m.affs.filter((a) => a.known && a.code !== "NA");
  const unknown = m.affs.filter((a) => !a.known).length;
  return `<div class="fui-peek">
    <div class="fui-titleline"><div class="fui-pn">${esc(m.name)}</div><span class="fui-side ${esc(m.sideCls)}">${esc(m.sideLabel)}</span></div>
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
#${ROOT_ID} .fui-act{display:flex;align-items:center;gap:8px;font-size:13px;padding:7px 8px;border-radius:7px;background:rgba(59,42,25,.04);margin-bottom:4px}
#${ROOT_ID} .fui-act.is-unk{color:#8a7d6a}
#${ROOT_ID} .fui-kind{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft);background:rgba(59,42,25,.07);padding:2px 6px;border-radius:5px;margin-left:auto}
#${ROOT_ID} .fui-hint{font-size:13px;font-style:italic;color:#4f4537;line-height:1.5;padding:10px 12px;border-radius:8px;background:rgba(213,182,122,.16)}
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
