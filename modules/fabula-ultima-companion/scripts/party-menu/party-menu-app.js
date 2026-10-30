// Party Menu — the FF9-style surface.
//
// A full-screen overlay modelled on Final Fantasy IX's field menu: party
// windows on the left, a command column on the right, location + Zenit below
// it, and a gloved-hand cursor. Driven by keyboard (arrows / Enter / Esc, Q-E
// to change character, Tab to change filter) AND mouse (hover moves the hand,
// click confirms), the way a console menu ported to a mouse UI should be.
//
// Built as a plain DOM overlay rather than a Foundry Application: the menu is
// meant to take over the screen like FF9's does, and an overlay gives full
// control of the frame. The CSB party sheet is NOT touched — this sits beside
// it until it earns the swap.
//
// Below the party sits a row of the guests and summons travelling with it
// (party-menu-companions.js). Ability and Status open on them too: their Ability
// page sections their actions by type and adds their AI in words.
//
// Commands: Item (own + shared Party Bag), Ability (skills, summon binding),
// Equip (with a before → after comparison), Status, Bonds, Bestiary, Config
// (each user's own display options), and the GM-only Setup (roster, player access). The command
// column shows only what this user may open — see party-menu-access.js.
// Main + Ability live in this file; the others are VIEWS modules.

import {
  getPartyRoster, vitalsOf, skillsOf, skillSummary, resolvedSlotsOf, summonSkillIds,
  candidateActors, setFixedBinding, setPersistentBinding, canBindSummons, folderPath,
  skillSource, sourceRanker, SOURCE_KINDS, skillAccess,
} from "./party-menu-core.js";
import { COMMAND_DEFS, canUseCommand } from "./party-menu-access.js";
import { conflictLive } from "./party-menu-core.js";
import { SND, play, STAT, esc, safeHtml, bar, gridStep as gridStepIn, navBar, overlayFoot, kbd } from "./party-menu-ui.js";
import { itemView } from "./party-menu-view-item.js";
import { equipView, statusView, who } from "./party-menu-view-gear.js";
import { setupView } from "./party-menu-view-setup.js";
import { bondsView, BONDS_CSS } from "./party-menu-view-bonds.js";
import { bestiaryView, BESTIARY_CSS } from "./party-menu-view-bestiary.js";
import { configView, CONFIG_CSS } from "./party-menu-view-config.js";
import { attachScrollbars } from "./party-menu-scrollbar.js";
import { wireLinkTips, hideLinkTip, removeLinkTip } from "./party-menu-linktip.js";
import { companionsOf, typeSection, aiPanel } from "./party-menu-companions.js";
import { gateState } from "../levelup-system/levelup-gate.js";

const TAG = "[PartyMenu]";
const ROOT_ID = "fud-party-menu";
const STYLE_ID = "fud-party-menu-style";

// Commands that first ask "whose?" by moving the hand onto the party list.
const NEEDS_MEMBER = new Set(["item", "ability", "equip", "status", "bonds"]);
// The ones that also reach the guests and summons in the row below it.
const FOR_COMPANIONS = new Set(["ability", "status"]);

// Views other than main/ability live in their own modules behind one interface:
// enter(ctx, actor) · render(ctx) · key(ctx, k, ev) · click(ctx, action, el)
// · hover(ctx, action, index) → bool · input?(ctx, ev).
const VIEWS = {
  item: itemView, equip: equipView, status: statusView, bonds: bondsView, bestiary: bestiaryView, config: configView, setup: setupView,
};

/** The command column for THIS user: what Setup granted them, plus Close. */
function visibleCommands() {
  return [...COMMAND_DEFS.filter((c) => canUseCommand(c.id)), { id: "close", label: "Close" }];
}

const FILTERS = [
  { id: "all", label: "All", icon: "fa-layer-group" },
  { id: "active", label: "Skill", icon: "fa-burst" },
  { id: "spell", label: "Spell", icon: "fa-wand-sparkles" },
  { id: "passive", label: "Passive", icon: "fa-shield-halved" },
  { id: "other", label: "Other", icon: "fa-ellipsis" },
  { id: "summon", label: "Summon", icon: "fa-paw" },
];

const REASONS = {
  "not-owner": "Only this character's player or the GM can change that.",
  "gm-only": "Only the GM can change a summon.",
  "target-in-party": "That actor is in the party.",
  "target-held-elsewhere": "That actor is already someone else's summon.",
  "kind-not-on-owner": "This character no longer has a skill that uses it.",
  timeout: "No GM answered. A GM must be online to change a companion.",
  unregistered_request: "The Party Menu is not loaded on this client.",
  "not-a-candidate": "That actor isn't one you can pick.",
  "not-granted": "The GM hasn't opened that to players.",
  "bad-target": "That actor can't be used as a summon.",
  "in-combat": "Summons can't be changed during a conflict.",
};

// ── state ─────────────────────────────────────────────────────────────────────

const S = {
  open: false,
  view: "main",          // main | ability | a VIEWS key
  focus: "cmd",          // cmd | member | comp | skills | slots | picker
  cmd: 0,                // index into visibleCommands()
  pendingCmd: null,      // command waiting for a character pick
  member: 0,             // index into roster.active
  comp: 0,               // index into roster.companions (guests + summons)
  pinned: null,          // id of the list entry whose detail is pinned (Ability skill / Status effect), or null
  actorId: null,         // character shown in the Ability / Equip / Status view
  v: null,               // view-local state of a VIEWS view
  focusSearch: false,    // focus a view's search box on the next render
  filter: "all",
  skill: 0,              // index into the filtered skill list
  slot: 0,               // index into the highlighted skill's summon slots
  picker: null,          // { slotIndex, query, showAll, index, list }
  roster: null,
  busy: false,
  toast: "",
};

let _root = null;
let _renderQueued = false;
let _listScroll = 0;

// ── transitions ───────────────────────────────────────────────────────────────
// Every render rebuilds the menu's DOM, so an entrance animation in plain CSS
// would replay on each key press. Instead a change of SCREEN (open, enter a
// view, back, another character, a swapped window, a new tab, an overlay)
// stamps a one-shot transition; the renders that follow inside its window carry
// the same class with a negative delay, so a re-render mid-animation (a preview
// arriving) continues it instead of restarting or cutting it. Moving the hand
// never animates. Durations here must match the CSS below.
const ANIM_MS = { open: 170, enter: 150, back: 150, switch: 120, tab: 120, page: 120, swap: 150, unswap: 130, pop: 120 };
const ANIM_STAGGER = 60;   // the longest per-window delay in the CSS
let _anim = null;      // { kind, t0 }
let _pop = null;       // t0 of the overlay that just opened
let _hadOverlay = false;

function animate(kind) { _anim = { kind, t0: performance.now() }; }

function applyTransition(stage) {
  const now = performance.now();
  if (_anim) {
    const dt = now - _anim.t0;
    if (dt < ANIM_MS[_anim.kind] + ANIM_STAGGER) {
      stage.classList.add(`pm-anim-${_anim.kind}`);
      stage.style.setProperty("--pm-t", `${-Math.round(dt)}ms`);
    } else _anim = null;
  }
  const has = !!(S.picker || viewOverlay());
  if (has && !_hadOverlay) _pop = now;
  _hadOverlay = has;
  if (has && _pop !== null && now - _pop < ANIM_MS.pop) {
    stage.classList.add("pm-anim-pop");
    stage.style.setProperty("--pm-tp", `${-Math.round(now - _pop)}ms`);
  }
}

// ── pinned detail ─────────────────────────────────────────────────────────────
// Hovering a row shows its detail; clicking pins it, so the pointer can cross
// other rows on its way to the detail (to scroll it, or hover a linked term).
// Right-click, Esc or the pin itself releases it before stepping back.
// Nothing here may move the layout: the row's pin sits under the hand, in the
// gutter the hand already owns, and the detail's pin sits in a corner every
// detail header keeps clear whether or not anything is pinned.
const PIN_MARK = `<i class="fas fa-thumbtack pm-pinmark" title="Pinned"></i>`;
const pinCorner = () => `<span class="pm-pincorner pm-hit" data-action="unpin" title="Pinned · click, right-click or Esc to release"><i class="fas fa-thumbtack"></i></span>`;

// ── data for the current view ─────────────────────────────────────────────────

function currentActor() {
  return S.actorId ? game.actors?.get(S.actorId) ?? null : null;
}

// Memoised per (actor, filter); any document hook drops it (see scheduleRender).
// Detecting summon slots stringifies every skill's tables, so recomputing it on
// each keypress would be the slowest thing in the menu.
let _memo = null;

function summonIdsOf(actor) {
  if (_memo?.summonFor !== actor.id) _memo = { summonFor: actor.id, summon: summonSkillIds(actor), lists: new Map() };
  return _memo.summon;
}

function filteredSkills(actor) {
  if (!actor) return [];
  const ids = summonIdsOf(actor);
  const hit = _memo.lists.get(S.filter);
  if (hit) return hit;
  const all = skillsOf(actor);
  if (companionOf(actor)) {
    // A guest or summon: every action, sectioned by type rather than by source.
    const sorted = [...all].sort((a, b) => typeSection(a).order - typeSection(b).order || a.name.localeCompare(b.name));
    _memo.lists.set(S.filter, sorted);
    return sorted;
  }
  const list = S.filter === "all" ? all
    : S.filter === "summon" ? all.filter((it) => ids.has(it.id))
    : all.filter((it) => skillSummary(it).bucket === S.filter);
  // Sectioned by source (class → Personal → Zero Power → Equipment → Items);
  // gear skills sort by their gear so one item's skills sit together.
  const rank = sourceRanker(actor);
  const keyed = list.map((it) => {
    const src = skillSource(actor, it);
    return { it, src, r: rank(src), sub: src.from ?? "" };
  });
  keyed.sort((a, b) => a.r - b.r || a.sub.localeCompare(b.sub) || a.it.name.localeCompare(b.it.name));
  const sorted = keyed.map((k) => k.it);
  _memo.sources ??= new Map();
  for (const k of keyed) _memo.sources.set(k.it.id, k.src);
  _memo.lists.set(S.filter, sorted);
  return sorted;
}

function sourceOf(actor, item) {
  return _memo?.sources?.get(item.id) ?? skillSource(actor, item);
}

function currentSkill(actor) {
  const list = filteredSkills(actor);
  if (!list.length) return null;
  // A pinned skill stays the one shown even if a document hook re-sorts the list.
  const at = S.pinned ? list.findIndex((it) => it.id === S.pinned) : -1;
  if (at >= 0) S.skill = at;
  S.skill = Math.max(0, Math.min(S.skill, list.length - 1));
  return list[S.skill];
}

// ── open / close ──────────────────────────────────────────────────────────────

/** The party, plus the guests and summons with it (a failure there never costs the menu). */
async function loadRoster() {
  const r = await getPartyRoster();
  r.companions = [];
  if (r.db) {
    try { r.companions = await companionsOf(r); }
    catch (e) { console.warn(TAG, "guests / summons unavailable", e); }
  }
  S.roster = r;
}

const companions = () => S.roster?.companions ?? [];
const companionOf = (actor) => (actor ? companions().find((c) => c.actor.id === actor.id) ?? null : null);

/** Who Q/E and the portrait row step through: Ability and Status reach the guests and summons too. */
function characterList() {
  const list = [...S.roster.active, ...S.roster.reserve];
  return FOR_COMPANIONS.has(S.view) ? [...list, ...companions().map((c) => c.actor)] : list;
}

export async function openPartyMenu({ actorId = null, view = null } = {}) {
  if (S.open && S.busy) return;   // a write is in flight; its view still owns S.v
  ensureStyles();
  await loadRoster();
  if (!S.roster.db) {
    ui.notifications?.warn("Party Menu: no party database is set for the current game.");
    return;
  }
  S.open = true;
  S.picker = null;
  S.modal = false;
  _memo = null;
  S.toast = "";
  S.v = null;
  S.pendingCmd = null;
  S.pinned = null;
  if (actorId && game.actors?.get(actorId) && canUseCommand("ability")) {
    S.actorId = actorId;
    S.view = "ability"; S.focus = "skills"; S.skill = 0; S.filter = "all";
  } else {
    S.view = "main"; S.focus = "cmd"; S.cmd = 0;
    const mine = game.user?.character?.id;
    const idx = S.roster.active.findIndex((a) => a.id === mine);
    S.member = idx >= 0 ? idx : 0;
  }
  if (!_root) {
    _root = document.createElement("div");
    _root.id = ROOT_ID;
    _root.addEventListener("click", onClick);
    // mousemove, not mouseover: when the KEYBOARD scrolls the skill list, rows
    // slide under a resting pointer and fire mouseover, which yanked the hand
    // back to whatever row happened to be under the mouse.
    _root.addEventListener("mousemove", onHover);
    _root.addEventListener("input", onInput);
    // Right-click and the mouse's Back button step back, so the menu works with a mouse alone.
    _root.addEventListener("contextmenu", onContext);
    _root.addEventListener("mousedown", onMouseBack);
    _root.addEventListener("mouseup", onMouseBack);
    // Hovering a linked term in a description shows what it means.
    wireLinkTips(_root);
    document.body.appendChild(_root);
    window.addEventListener("keydown", onKey, true);
  }
  _hadOverlay = false;
  animate("open");
  play(SND.ok);
  render();
  // Straight into a view (the chat "Character" button opens Equip for the
  // player's own character instead of the Foundry character sheet).
  if (view && VIEWS[view]) enterView(view, (actorId && game.actors?.get(actorId)) || game.user?.character || null);
}

export function closePartyMenu() {
  if (!_root) return;
  window.removeEventListener("keydown", onKey, true);
  attachScrollbars(null);
  removeLinkTip();
  _root.remove();
  _root = null;
  S.open = false;
  play(SND.back);
}

export function isPartyMenuOpen() { return S.open; }

// ── render ────────────────────────────────────────────────────────────────────

function scheduleRender() {
  _memo = null;
  if (!S.open || _renderQueued) return;
  _renderQueued = true;
  setTimeout(async () => {
    _renderQueued = false;
    if (!S.open) return;
    await loadRoster();
    render();
  }, 80);
}

function render() {
  if (!_root) return;
  hideLinkTip();   // its link is about to be rebuilt
  const list = _root.querySelector(".pm-skill-list");
  if (list) _listScroll = list.scrollTop;
  // Keep the detail pane where the reader left it while the same skill is shown
  // (hovering its buttons re-renders the whole menu).
  const detail = _root.querySelector(".pm-detail > .pm-scroll");
  const detailKey = detail ? `${S.view}|${detail.dataset.key ?? ""}` : null;
  const detailScroll = detail?.scrollTop ?? 0;
  const searchHadFocus = document.activeElement?.classList?.contains("pm-search");
  // Any other pane that should keep its scroll across a re-render while it shows the same thing.
  const kept = [..._root.querySelectorAll("[data-keep-scroll]")].map((el) => [el.dataset.keepScroll, el.scrollTop]);
  // A companion's video sprite rebuilt by innerHTML starts empty and blinks while
  // it reloads (every hover re-renders), so the playing elements are carried over.
  const videos = new Map([..._root.querySelectorAll(".pm-comp video")].map((v) => [v.getAttribute("src"), v]));

  _root.innerHTML = `
    <div class="pm-backdrop"></div>
    <div class="pm-stage ${S.picker || viewOverlay() ? "has-picker" : ""}">
      ${S.view === "main" ? renderMain() : VIEWS[S.view] ? VIEWS[S.view].render(ctx) : renderAbility()}
      ${S.picker ? renderPicker() : ""}
      ${S.toast ? `<div class="pm-toast pm-pill">${esc(S.toast)}</div>` : ""}
    </div>`;

  // Swapped back in the same task, so the moved element is never paused.
  for (const fresh of _root.querySelectorAll(".pm-comp video")) {
    const old = videos.get(fresh.getAttribute("src"));
    if (old) { fresh.replaceWith(old); videos.delete(fresh.getAttribute("src")); }
  }

  applyTransition(_root.querySelector(".pm-stage"));

  const newList = _root.querySelector(".pm-skill-list");
  if (newList) {
    newList.scrollTop = _listScroll;
    const cur = newList.querySelector(".is-cursor");
    // The first row of a section brings its header along, or wrapping to the top hides it.
    const head = cur?.previousElementSibling;
    if (head?.classList.contains("pm-section")) head.scrollIntoView({ block: "nearest" });
    cur?.scrollIntoView({ block: "nearest" });
  }
  const newDetail = _root.querySelector(".pm-detail > .pm-scroll");
  if (newDetail && detailKey && `${S.view}|${newDetail.dataset.key ?? ""}` === detailKey) newDetail.scrollTop = detailScroll;
  for (const [k, top] of kept) {
    const el = _root.querySelector(`[data-keep-scroll="${CSS.escape(k)}"]`);
    if (el) el.scrollTop = top;
  }
  attachScrollbars(_root);
  _root.querySelector(".pm-picker-list .is-cursor")?.scrollIntoView({ block: "nearest" });
  if (searchHadFocus || S.picker?.focusSearch || S.focusSearch) {
    const inp = _root.querySelector(".pm-search");
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    if (S.picker) S.picker.focusSearch = false;
    S.focusSearch = false;
  }
}

/** Does the current VIEWS view have a modal list open over it (dims the rest)? */
function viewOverlay() {
  const v = S.v;
  return !!(VIEWS[S.view] && v && (v.picker || v.focus === "dest" || v.focus === "qty"));
}


function memberCard(actor, i) {
  const v = vitalsOf(actor);
  const cursor = S.focus === "member" && S.member === i;
  const low = v.maxHp > 0 && v.hp <= Math.floor(v.maxHp / 2);
  return `
    <div class="pm-member pm-hit ${cursor ? "is-cursor" : ""} ${S.focus === "member" ? "is-pickable" : ""}"
         data-action="member" data-index="${i}">
      <div class="pm-portrait"><img src="${esc(actor.img)}" alt="" onerror="this.style.visibility='hidden'"></div>
      <div class="pm-member-body">
        <div class="pm-member-top">
          <span class="pm-name">${esc(actor.name)}</span>
          <span class="pm-lv"><em>LV</em>${v.level}</span>
        </div>
        <div class="pm-sub">${esc(v.classes.slice(0, 3).join(" · ") || v.identity)}</div>
        <div class="pm-stat">${STAT.hp}<b class="${low ? "is-low" : ""}">${v.hp}</b><span>/</span><b>${v.maxHp}</b>${bar(v.hp, v.maxHp, "hp")}</div>
        <div class="pm-stat">${STAT.mp}<b>${v.mp}</b><span>/</span><b>${v.maxMp}</b>${bar(v.mp, v.maxMp, "mp")}</div>
        <div class="pm-stat">${STAT.ip}<b>${v.ip}</b><span>/</span><b>${v.maxIp}</b>${bar(v.ip, v.maxIp, "ip")}</div>
      </div>
    </div>`;
}

// A guest or summon: just its token sprite (a video for animated battlers); the
// name and role are on the tooltip and on its pages. Only Ability and Status open
// on them, so while another command waits for a character they sit dimmed.
function companionCard(c, i) {
  const pickable = S.focus === "comp" || (S.focus === "member" && FOR_COMPANIONS.has(S.pendingCmd));
  const off = S.focus === "member" && !FOR_COMPANIONS.has(S.pendingCmd);
  const src = c.actor.prototypeToken?.texture?.src || c.actor.img;
  const sprite = /\.(webm|mp4|m4v|ogv)(\?|#|$)/i.test(src)
    ? `<video src="${esc(src)}" autoplay loop muted playsinline></video>`
    : `<img src="${esc(src)}" alt="" onerror="this.style.visibility='hidden'">`;
  return `
    <div class="pm-comp pm-hit ${S.focus === "comp" && S.comp === i ? "is-cursor" : ""} ${pickable ? "is-pickable" : ""} ${off ? "is-off" : ""}"
         data-action="comp" data-index="${i}" title="${esc(`${c.actor.name} — ${c.role}`)}">${sprite}</div>`;
}

function renderMain() {
  const r = S.roster;
  const members = r.active.length
    ? r.active.map(memberCard).join("")
    : `<div class="pm-empty">No party members are set on ${esc(r.db?.name ?? "the party sheet")}.</div>`;
  const reserve = r.reserve.length
    ? `<div class="pm-reserve"><span class="pm-label">Reserve</span>${r.reserve.map((a) =>
        `<img class="pm-chip" src="${esc(a.img)}" title="${esc(a.name)}" alt="" onerror="this.style.visibility='hidden'">`).join("")}</div>`
    : "";
  const visible = visibleCommands();
  S.cmd = Math.max(0, Math.min(S.cmd, visible.length - 1));
  const cmds = visible.map((c, i) => `
    <div class="pm-cmd pm-hit ${S.focus === "cmd" && S.cmd === i ? "is-cursor" : ""}
         ${(S.focus === "member" || S.focus === "comp") && S.cmd === i ? "is-held" : ""} ${c.gmOnly ? "is-gm" : ""}"
         data-action="cmd" data-index="${i}" title="${esc(c.hint ?? "")}">${esc(c.label)}${c.gmOnly ? `<i class="fas fa-crown pm-gmmark" title="GM only"></i>` : ""}</div>`).join("");
  const comps = companions();
  const compRow = `
    <div class="pm-win pm-comps">
      <div class="pm-comps-head"><span class="pm-label">Guests &amp; Summons</span>${comps.length ? `<b class="pm-count">${comps.length}</b>` : ""}</div>
      <div class="pm-comp-list">${comps.length ? comps.map(companionCard).join("")
        : `<div class="pm-empty">No guests or summons are travelling with the party.</div>`}</div>
    </div>`;
  const hint = S.focus === "comp" ? "←→ choose · ↑ party · Z/Enter confirm · X/Esc back"
    : S.focus === "member" ? "Choose a character · X/Esc or right-click: back" : "↑↓ choose · Z/Enter confirm · X/Esc close";
  return `
    <div class="pm-main">
      <div class="pm-win pm-party"><div class="pm-scroll pm-party-list">${members}${reserve}</div></div>
      <div class="pm-side">
        <div class="pm-win pm-cmds">${cmds}</div>
        <div class="pm-win pm-info">
          <div class="pm-info-row"><span class="pm-label">${esc(r.gameName || "Party")}</span></div>
          <div class="pm-info-row pm-loc">${esc(r.location || "—")}</div>
          <div class="pm-info-row"><span class="pm-zenit"><i class="fas fa-coins"></i> ${Number(r.zenit || 0).toLocaleString()}</span><em>z</em></div>
        </div>
      </div>
      ${compRow}
      <div class="pm-hint">${hint}</div>
    </div>`;
}

function renderAbility() {
  const actor = currentActor();
  if (!actor) return `<div class="pm-win pm-empty">That character is gone.</div>`;
  const skills = filteredSkills(actor);
  const sel = currentSkill(actor);

  const comp = companionOf(actor);
  const tabs = FILTERS.map((f) => `
    <span class="pm-tab pm-hit ${S.filter === f.id ? "is-on" : ""}" data-action="filter" data-id="${f.id}"><i class="fas ${f.icon}"></i>${esc(f.label)}</span>`).join("");
  // Section heads: where a member's skill comes from; what a guest's or summon's action is.
  const sectionOf = (it) => (comp ? typeSection(it) : sourceOf(actor, it));

  let lastSection = null;
  const counts = new Map();
  for (const it of skills) { const k = sectionOf(it).key; counts.set(k, (counts.get(k) ?? 0) + 1); }
  const rows = skills.map((it, i) => {
    const s = skillSummary(it);
    const src = sectionOf(it);
    const access = skillAccess(actor, it);
    const summon = summonIdsOf(actor).has(it.id);
    const cursor = S.focus === "skills" && S.skill === i;
    const held = S.focus !== "skills" && S.skill === i;
    const pinned = S.pinned === it.id;
    const head = src.key === lastSection ? "" : `
      <div class="pm-section"><i class="fas ${src.icon ?? SOURCE_KINDS[src.kind].icon}"></i><span>${esc(src.label)}</span><b>${counts.get(src.key)}</b></div>`;
    lastSection = src.key;
    return `${head}
      <div class="pm-skill pm-hit ${cursor ? "is-cursor" : ""} ${held ? "is-held" : ""} ${pinned ? "is-pinned" : ""} ${s.bucket === "passive" ? "is-passive" : ""} ${access.ok ? "" : "is-locked"}"
           data-action="skill" data-index="${i}">
        <img src="${esc(s.img)}" alt="" onerror="this.style.visibility='hidden'">
        <span class="pm-skill-name" title="${esc(access.ok ? (src.from ? `From ${src.from}` : "") : access.reason)}">${esc(s.name)}${summon ? `<i class="pm-badge" title="Has a summon you can set">✦</i>` : ""}</span>
        <span class="pm-skill-cost">${esc(s.cost)}</span>${pinned ? PIN_MARK : ""}
      </div>`;
  }).join("") || `<div class="pm-empty">${comp ? `${esc(actor.name)} has no actions.` : "Nothing under this filter."}</div>`;

  return `
    <div class="pm-ability">
      ${renderNav()}
      ${who(ctx, actor, "Ability", { withCompanions: true })}
      <div class="pm-ability-body">
        <div class="pm-win pm-skills ${comp ? "has-ai" : ""}">
          ${comp ? "" : `<div class="pm-tabs">${tabs}${kbd("Tab")}</div>`}
          <div class="pm-skill-list">${rows}</div>
          ${comp ? aiPanel(comp) : ""}
        </div>
        <div class="pm-win pm-detail"><div class="pm-scroll" data-key="${esc(sel?.uuid ?? "")}">${sel ? `${S.pinned === sel.id ? pinCorner() : ""}${renderDetail(actor, sel)}` : ""}</div></div>
      </div>
    </div>`;
}

/** The Ability view's place and actions, for the nav bar. */
function abilityNav() {
  const actor = currentActor();
  const sel = actor ? currentSkill(actor) : null;
  const slots = sel ? resolvedSlotsOf(actor, sel) : [];
  const crumbs = [`Ability · ${actor?.name ?? ""}`];
  const actions = [];
  if (S.focus === "slots" && sel) {
    crumbs.push(`Summon (${sel.name})`);
    const slot = slots[S.slot];
    if (slot && canBindSummons()) {
      actions.push({ key: "Enter", label: "Change", icon: "fa-right-left" });
      if (slotView(slot).canReset) actions.push({ key: "Delete", label: slot.type === "fixed" ? "Default" : "Clear", icon: "fa-rotate-left" });
    }
  } else {
    if (slots.length) actions.push({ key: "Enter", label: "Summon", icon: "fa-paw" });
    const tree = skillTreeAccess(actor);
    if (tree) actions.push({ key: "T", label: "Skill Tree", icon: "fa-sitemap", disabled: !tree.ok, title: tree.ok ? "Open the level-up window" : tree.reason });
  }
  return { crumbs, actions };
}

// ── Skill Tree (the level-up window) ──────────────────────────────────────────
//
// The one manual way into levelling: Ability → Skill Tree. It is offered for a
// party member you own (any of them, for a GM), never for a guest or summon.
// Outside camp lobbies and the title screen it stays on show but greyed, because
// fiddling with a build mid-dungeon stalls the table. The spend gate is also
// re-checked GM-side on every write, so this is the advisory half of the rule.

/** null when the action does not apply to this character; else { ok, reason }. */
function skillTreeAccess(actor) {
  if (!actor || companionOf(actor) || !actor.isOwner) return null;
  if (!globalThis.FUCompanion?.api?.levelUp?.open) return null;
  const gate = gateState();
  return { ok: gate.open, reason: gate.reason };
}

function openSkillTree(actor) {
  const access = skillTreeAccess(actor);
  if (!access) return;
  if (!access.ok) { play(SND.buzz, 0.5); toast(access.reason); return; }
  const lu = globalThis.FUCompanion.api.levelUp;
  const back = () => openPartyMenu({ actorId: actor.id });
  // The level-up window sits below this menu, so step out of the way and come
  // back to this character's Ability page when it closes.
  closePartyMenu();
  lu.open(actor.uuid, { onClose: back });
  if (!lu.app?.isOpen) back();   // refused (not a player character): don't strand the player
}

/** Where the open view is ({ crumbs: [labels], actions }), "Party" excluded. */
function navSpec() {
  if (S.view === "ability") return abilityNav();
  const view = VIEWS[S.view];
  return view?.nav?.(ctx) ?? { crumbs: [view?.title ?? ""], actions: [] };
}

function renderNav() {
  const { crumbs, actions } = navSpec();
  const all = ["Party", ...crumbs];
  return navBar(all.map((label, i) => ({ label, up: i === 0 ? "main" : all.length - 1 - i })), actions);
}

/** One step back, the way a mouse asks for it (Back button, right-click, mouse Back). */
function navBack() {
  if (S.busy) return;
  if (S.picker || viewOverlay()) return handleKey("Escape");          // close the overlay first
  if (S.pinned) return handleKey("Escape");                           // then release a pinned detail
  if (S.view === "main") { if (S.focus === "member" || S.focus === "comp") handleKey("Escape"); return; }   // never closes the menu
  if (navSpec().crumbs.length > 1) return handleKey("Escape");        // up one level inside the view
  backToMain();
}

/** A crumb: "main", or that many steps back. */
function navTo(up) {
  if (up === "main") { S.picker = null; return backToMain(); }
  for (let i = 0; i < Number(up); i++) handleKey("Escape");
}

function renderDetail(actor, item) {
  const s = skillSummary(item);
  const src = sourceOf(actor, item);
  const typeWord = (t) => t ? t[0].toUpperCase() + t.slice(1) : "";
  const facts = [
    ["Source", companionOf(actor) ? "" : src.from ? `${src.from} (${typeWord(src.fromType)})` : (src.kind === "class" ? "" : src.label)],
    ["Class", s.cls], ["Type", s.type], ["Cost", s.cost],
    ["Level", s.maxLevel ? `${s.level} / ${s.maxLevel}` : (s.level || "")],
    ["Target", s.target], ["Range", s.range], ["Duration", s.duration],
  ].filter(([, v]) => v !== "" && v !== "-" && v != null);
  const flags = [s.isHeroic ? "Heroic" : "", s.isZeroPower ? "Zero Power" : ""].filter(Boolean);
  const access = skillAccess(actor, item);
  const slots = resolvedSlotsOf(actor, item);
  return `
    <div class="pm-detail-head">
      <img src="${esc(s.img)}" alt="" onerror="this.style.visibility='hidden'">
      <div><div class="pm-detail-name">${esc(s.name)}</div>
      ${flags.length ? `<div class="pm-sub">${esc(flags.join(" · "))}</div>` : ""}</div>
    </div>
    ${access.ok ? "" : `<div class="pm-locked"><i class="fas fa-lock"></i> Unavailable — ${esc(access.reason)}</div>`}
    <dl class="pm-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${slots.length ? renderSlots(actor, slots) : ""}
    <div class="pm-desc">${safeHtml(s.description) || "<p><em>No description.</em></p>"}</div>`;
}

function slotView(slot) {
  if (slot.type === "fixed") {
    const actor = slot.boundActor ?? slot.defaultActors?.[0] ?? null;
    const kindName = slot.summonType ? slot.summonType[0].toUpperCase() + slot.summonType.slice(1) : "Summon";
    return {
      title: kindName,
      actor,
      name: slot.boundActor?.name ?? (slot.defaultActors?.map((a) => a.name).join(", ") || slot.defaultRef || "—"),
      note: slot.dangling ? "Bound actor is missing — using the default."
        : slot.boundActor ? "Set for this character" : "Skill default",
      canReset: !!slot.boundRef,
    };
  }
  const h = slot.holders?.[0] ?? null;
  return {
    title: slot.kind[0].toUpperCase() + slot.kind.slice(1),
    actor: h,
    name: h?.name ?? "None",
    note: h ? (slot.holders.length > 1 ? `+${slot.holders.length - 1} more standing` : "Standing companion") : "Not set",
    canReset: !!h,
  };
}

function renderSlots(actor, slots) {
  const editable = canBindSummons();
  const rows = slots.map((slot, i) => {
    const v = slotView(slot);
    const cursor = S.focus === "slots" && S.slot === i;
    return `
      <div class="pm-slot pm-hit ${cursor ? "is-cursor" : ""}" data-action="slot" data-index="${i}">
        <div class="pm-portrait xs">${v.actor ? `<img src="${esc(v.actor.img)}" alt="" onerror="this.style.visibility='hidden'">` : ""}</div>
        <div class="pm-slot-body">
          <div class="pm-slot-title">${esc(v.title)}</div>
          <div class="pm-slot-name">${esc(v.name)}</div>
          <div class="pm-sub">${esc(v.note)}</div>
        </div>
        ${editable ? `<div class="pm-slot-actions">
          <button type="button" class="pm-btn pm-hit" data-action="slot-change" data-index="${i}">Change</button>
          ${v.canReset ? `<button type="button" class="pm-btn pm-hit" data-action="slot-reset" data-index="${i}">${slot.type === "fixed" ? "Default" : "Clear"}</button>` : ""}
        </div>` : ""}
      </div>`;
  }).join("");
  return `<div class="pm-slots"><div class="pm-label">Summon</div>${rows}
    ${editable ? "" : `<div class="pm-sub">Only the GM can change a summon.</div>`}</div>`;
}

function renderPicker() {
  const p = S.picker;
  const q = p.query.trim().toLowerCase();
  const list = q ? p.list.filter((a) => a.name.toLowerCase().includes(q) || folderPath(a).toLowerCase().includes(q)) : p.list;
  p.visible = list;
  p.index = Math.max(0, Math.min(p.index, list.length));   // index 0 = "Default/Clear" row
  const groups = new Map();
  list.forEach((a, i) => {
    const g = folderPath(a) || "(no folder)";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ a, i: i + 1 });
  });
  const reset = `<div class="pm-pick pm-hit ${p.index === 0 ? "is-cursor" : ""}" data-action="pick" data-index="0">
      <div class="pm-portrait xs"></div><span>${p.slot.type === "fixed" ? "Use the skill's default" : "No companion"}</span></div>`;
  const body = [...groups.entries()].map(([g, rows]) => `
      <div class="pm-pick-group">${esc(g)}</div>
      ${rows.map(({ a, i }) => `<div class="pm-pick pm-hit ${p.index === i ? "is-cursor" : ""}" data-action="pick" data-index="${i}">
        <div class="pm-portrait xs"><img src="${esc(a.img)}" alt="" onerror="this.style.visibility='hidden'"></div><span>${esc(a.name)}</span></div>`).join("")}`).join("");
  return `
    <div class="pm-picker-veil"></div>
    <div class="pm-win pm-picker">
      <div class="pm-picker-head">
        <span class="pm-label">Choose ${esc(slotView(p.slot).title)} for ${esc(p.ownerName)}</span>
        ${game.user?.isGM ? `<label class="pm-showall"><input type="checkbox" data-action="showall" ${p.showAll ? "checked" : ""}> All actors</label>` : ""}
      </div>
      <input type="text" class="pm-search" placeholder="Search…" value="${esc(p.query)}">
      <div class="pm-picker-list">${reset}${body || `<div class="pm-empty">No matching actors.</div>`}</div>
      ${overlayFoot(`↑↓ choose · Z/Enter confirm · X/Esc cancel${game.user?.isGM ? "" : " · Showing your actors and the summon's own folder"}`)}
    </div>`;
}

// ── actions ───────────────────────────────────────────────────────────────────

function toast(msg) {
  S.toast = msg;
  render();
  setTimeout(() => { if (S.toast === msg) { S.toast = ""; render(); } }, 2600);
}

function moveCursor(key, delta) {
  play(SND.move, 0.45);
  S[key] += delta;
}

function enterAbility(actor) {
  if (!actor) return;
  if (!canUseCommand("ability")) { play(SND.buzz, 0.5); return; }
  S.actorId = actor.id;
  S.view = "ability"; S.focus = "skills"; S.skill = 0; S.slot = 0; S.filter = "all"; S.pinned = null;
  _listScroll = 0;
  animate("enter");
  play(SND.ok);
  render();
}

function cycleCharacter(delta) {
  const list = characterList();
  if (list.length < 2) return;
  const i = list.findIndex((a) => a.id === S.actorId);
  selectCharacter(list[(i + delta + list.length) % list.length]);
}

/** Show `next` in the current per-character view (Q/E or a click on its portrait). */
function selectCharacter(next) {
  if (!next || next.id === S.actorId) return;
  S.actorId = next.id; S.skill = 0; S.slot = 0; S.focus = "skills"; S.pinned = null; _listScroll = 0;
  if (VIEWS[S.view]) VIEWS[S.view].enter(ctx, next);
  animate("switch");
  play(SND.move, 0.45);
  render();
}

/** Open a VIEWS view, for `actor` when it is about one character. */
function enterView(id, actor = null) {
  const view = VIEWS[id];
  if (!view || !canUseCommand(id)) { play(SND.buzz, 0.5); return; }
  if (actor) S.actorId = actor.id;
  S.view = id; S.pendingCmd = null; S.pinned = null; _listScroll = 0;
  view.enter(ctx, actor);
  animate("enter");
  play(SND.ok);
  render();
}

/** Back from a view to the party list, hand on the character it was about. */
function backToMain() {
  const id = S.view;
  S.view = "main"; S.v = null; S.pinned = null;
  const i = S.roster.active.findIndex((a) => a.id === S.actorId);
  const c = companions().findIndex((x) => x.actor.id === S.actorId);
  if (NEEDS_MEMBER.has(id) && i >= 0) { S.focus = "member"; S.member = i; S.pendingCmd = id; }
  else if (FOR_COMPANIONS.has(id) && c >= 0) { S.focus = "comp"; S.comp = c; S.pendingCmd = id; }
  else { S.focus = "cmd"; S.pendingCmd = null; }
  const at = visibleCommands().findIndex((c) => c.id === id);
  if (at >= 0) S.cmd = at;
  animate("back");
  play(SND.back);
  render();
}

/** A character was picked on the main screen for the waiting command. */
function pickMember(actor) {
  if (!actor) return;
  // Clicking a portrait straight from the command column picks for the command
  // under the hand (FF9 lets the mouse skip the "whose?" step).
  const held = visibleCommands()[S.cmd]?.id;
  const id = S.pendingCmd ?? (NEEDS_MEMBER.has(held) ? held : "ability");
  if (!canUseCommand(id)) { play(SND.buzz, 0.5); return; }
  if (id === "ability") enterAbility(actor);
  else enterView(id, actor);
}

/** A guest or summon was picked: they have an Ability and a Status page. */
function pickCompanion(i) {
  const c = companions()[i];
  if (!c) return;
  if (S.pendingCmd && !FOR_COMPANIONS.has(S.pendingCmd)) { play(SND.buzz, 0.5); toast("Guests and summons only have Ability and Status pages."); return; }
  // Clicked straight from the command column: the command under the hand if it fits, else Status.
  const held = visibleCommands()[S.cmd]?.id;
  const id = S.pendingCmd ?? (FOR_COMPANIONS.has(held) ? held : "status");
  if (!canUseCommand(id)) { play(SND.buzz, 0.5); toast(REASONS["not-granted"]); return; }
  S.comp = i;
  if (id === "ability") enterAbility(c.actor);
  else enterView(id, c.actor);
}

// What the VIEWS views get to drive the menu with.
const ctx = {
  S,
  render: () => render(),
  toast: (msg) => toast(msg),
  root: () => _root,
  roster: () => S.roster,
  actor: () => currentActor(),
  back: () => backToMain(),
  cycleCharacter: (d) => cycleCharacter(d),
  setBusy: (b) => { S.busy = !!b; },
  resetScroll: () => { _listScroll = 0; },
  focusSearch: () => { S.focusSearch = true; },
  animate: (kind) => animate(kind),
  nav: () => renderNav(),
  refreshRoster: async () => { await loadRoster(); },
  companion: (actor) => companionOf(actor),
  pinCorner: () => pinCorner(),
  pinMark: PIN_MARK,
  close: () => closePartyMenu(),
  isOpen: () => S.open,
};

function setFilter(id) {
  S.filter = id; S.skill = 0; S.slot = 0; S.focus = "skills"; S.pinned = null; _listScroll = 0;
  play(SND.move, 0.45);
  render();
}

function confirmCmd() {
  const c = visibleCommands()[S.cmd];
  if (!c) return;
  if (c.id === "close") { closePartyMenu(); return; }
  if (!canUseCommand(c.id)) { play(SND.buzz, 0.5); return; }
  if (NEEDS_MEMBER.has(c.id)) {
    if (!S.roster.active.length) {
      // No one in the party, but Status can still look at a guest or summon.
      if (FOR_COMPANIONS.has(c.id) && companions().length) { S.pendingCmd = c.id; S.focus = "comp"; S.comp = 0; play(SND.ok); render(); return; }
      play(SND.buzz, 0.5); return;
    }
    // Start on the user's own character when they have one in the party.
    const mine = S.roster.active.findIndex((a) => a.id === game.user?.character?.id || (!game.user?.isGM && a.isOwner));
    if (S.focus !== "member" && mine >= 0) S.member = mine;
    S.pendingCmd = c.id; S.focus = "member"; play(SND.ok); render();
    return;
  }
  enterView(c.id);
}

function openSlots(actor) {
  const sel = currentSkill(actor);
  if (!sel || !resolvedSlotsOf(actor, sel).length) { play(SND.buzz, 0.5); return; }
  S.focus = "slots"; S.slot = 0; play(SND.ok); render();
}

async function openPicker(actor, slotIndex) {
  const sel = currentSkill(actor);
  const slot = sel ? resolvedSlotsOf(actor, sel)[slotIndex] : null;
  if (!slot) return;
  if (!canBindSummons()) { play(SND.buzz, 0.5); toast(REASONS["gm-only"]); return; }
  // Refused up front, so the picker does not open on a write that would fail.
  if (conflictLive()) { play(SND.buzz, 0.5); toast(REASONS["in-combat"]); return; }
  // The skill is pinned by id: a document hook can re-sort the list while the
  // picker is open, and the write must land on the skill the picker was opened for.
  S.picker = { slotIndex, slot, itemId: sel.id, ownerName: actor.name, query: "", showAll: false, index: 0, list: [], focusSearch: true };
  await refreshPickerList(actor);
  play(SND.ok);
  render();
}

async function refreshPickerList(actor) {
  const p = S.picker;
  const list = await candidateActors(actor, p.slot, { showAll: p.showAll });
  p.list = list.sort((a, b) => folderPath(a).localeCompare(folderPath(b)) || a.name.localeCompare(b.name));
  const current = p.slot.type === "fixed" ? p.slot.boundActor : p.slot.holders?.[0];
  const at = current ? p.list.indexOf(current) : -1;
  p.index = at >= 0 ? at + 1 : 0;
}

async function applyPick(actor, pickIndex) {
  const p = S.picker;
  if (!p || S.busy) return;
  let chosen = null;
  if (pickIndex !== 0) {
    chosen = (p.visible ?? p.list)[pickIndex - 1] ?? null;
    if (!chosen) return;   // stale index — never let it read as "reset"
  }
  const item = actor?.items?.get(p.itemId) ?? null;
  if (!item) { S.picker = null; render(); return; }
  if (!(await applyBinding(actor, p.slot, chosen, item))) return;
  S.picker = null;
  render();
}

/** Resolve a slot change; a persistent RELEASE asks first. Returns false if cancelled. */
async function applyBinding(actor, slot, chosen, item = currentSkill(actor)) {
  const sel = item;
  if (!sel) return false;
  if (!chosen && slot.type === "persistent" && slot.holders?.length) {
    // The overlay sits above Foundry's window stack, so lift the dialog over it,
    // and stand the menu's key handler down while the dialog owns the keyboard.
    Hooks.once("renderDialog", (app) => { const el = app.element?.[0] ?? app.element; if (el?.style) el.style.zIndex = "10050"; });
    S.modal = true;
    const ok = await Dialog.confirm({
      title: "Release companion",
      content: `<p>Release <strong>${esc(slot.holders.map((h) => h.name).join(", "))}</strong> as ${esc(actor.name)}'s ${esc(slot.kind)}? `
        + "The actor is kept; it just stops following them into battle.</p>",
    }).catch(() => false).finally(() => { S.modal = false; });
    if (!ok) return false;
  }
  S.busy = true;
  let res;
  try {
    res = slot.type === "fixed"
      ? await setFixedBinding(actor, sel, slot.label, chosen)
      : await setPersistentBinding(actor, slot.kind, chosen);
  } catch (e) {
    console.error(TAG, "binding failed", e);
    res = { ok: false, reason: e?.message ?? "error" };
  } finally { S.busy = false; }
  if (res?.ok) {
    play(SND.done, 0.5);
    toast(chosen ? `${actor.name}'s ${slotView(slot).title}: ${chosen.name}` : `${actor.name}'s ${slotView(slot).title} reset`);
  } else {
    play(SND.buzz, 0.5);
    toast(REASONS[res?.reason] ?? `Could not change it (${res?.reason ?? "unknown"}).`);
  }
  return true;
}

// ── input ─────────────────────────────────────────────────────────────────────

function onHover(ev) {
  const el = ev.target.closest?.(".pm-hit[data-action]");
  if (!el || S.busy) return;
  const i = Number(el.dataset.index);
  const a = el.dataset.action;
  let changed = false;
  if (a === "cmd" && S.focus === "cmd" && S.cmd !== i) { S.cmd = i; changed = true; }
  else if (a === "member" && S.focus === "member" && S.member !== i) { S.member = i; changed = true; }
  else if (a === "comp" && FOR_COMPANIONS.has(S.pendingCmd) && (S.focus === "member" || S.focus === "comp") && (S.focus !== "comp" || S.comp !== i)) {
    S.focus = "comp"; S.comp = i; changed = true;
  } else if (a === "member" && S.focus === "comp" && S.roster.active[i]) { S.focus = "member"; S.member = i; changed = true; }
  else if (a === "skill" && S.focus === "skills" && S.skill !== i && !S.pinned) { S.skill = i; changed = true; }
  else if (a === "slot" && S.focus === "slots" && S.slot !== i) { S.slot = i; changed = true; }
  else if (a === "pick" && S.picker && S.picker.index !== i) { S.picker.index = i; changed = true; }
  else if (VIEWS[S.view]) changed = !!VIEWS[S.view].hover(ctx, a, i);
  if (changed) { play(SND.move, 0.3); render(); }
}

async function onClick(ev) {
  const el = ev.target.closest?.("[data-action]");
  if (!el || S.busy) return;
  const a = el.dataset.action;
  const i = Number(el.dataset.index);
  const actor = currentActor();
  switch (a) {
    case "cmd": S.focus = "cmd"; S.cmd = i; confirmCmd(); break;
    case "member": pickMember(S.roster.active[i]); break;
    case "comp": pickCompanion(i); break;
    case "filter": if (!S.picker) setFilter(el.dataset.id); break;
    case "nav-back": navBack(); break;
    case "unpin": if (S.pinned) { S.pinned = null; play(SND.back, 0.4); render(); } break;
    case "nav-crumb": navTo(el.dataset.up); break;
    case "nav-key": handleKey(el.dataset.key); break;
    case "pick-char":
      if (!S.picker) selectCharacter(characterList().find((a) => a.id === el.dataset.id));
      break;
    case "skill": {
      // A click pins the skill's detail so the pointer can travel to it without
      // hovering a different row on the way; clicking the pinned row releases it.
      // Its summon slots open with Enter or the nav bar's Summon button.
      if (S.picker) break;
      const it = filteredSkills(actor)[i];
      if (!it) break;
      S.focus = "skills"; S.skill = i; S.slot = 0;
      if (S.pinned === it.id) { S.pinned = null; play(SND.back, 0.4); }
      else { S.pinned = it.id; play(SND.ok, 0.4); }
      render();
      break;
    }
    case "slot": if (!S.picker) { S.focus = "slots"; S.slot = i; render(); } break;
    case "slot-change": if (!S.picker) { S.focus = "slots"; S.slot = i; await openPicker(actor, i); } break;
    case "slot-reset": {
      if (S.picker) break;
      const slot = resolvedSlotsOf(actor, currentSkill(actor))[i];
      if (slot) await applyBinding(actor, slot, null);
      break;
    }
    case "pick": await applyPick(actor, i); break;
    case "showall":
      if (S.picker) { S.picker.showAll = el.checked; await refreshPickerList(actor); render(); }
      break;
    default:
      if (VIEWS[S.view]) await VIEWS[S.view].click(ctx, a, el, ev);
      break;
  }
}

function onInput(ev) {
  if (VIEWS[S.view]) { VIEWS[S.view].input?.(ctx, ev); return; }
  if (!ev.target.classList?.contains("pm-search") || !S.picker) return;
  S.picker.query = ev.target.value;
  S.picker.index = S.picker.query ? 1 : 0;
  render();
}

const gridStep = (k) => gridStepIn(_root, ".pm-skill-list .pm-skill", S.skill, k);

// The "Open Party Menu" keybinding must also CLOSE it, but this capture-phase
// handler stops the event before Foundry's keybinding manager would see it.
function isToggleKey(ev) {
  let binds = [];
  try { binds = game.keybindings.get("fabula-ultima-companion", "openPartyMenu") ?? []; } catch { return false; }
  const MOD = { Control: ev.ctrlKey || ev.metaKey, Shift: ev.shiftKey, Alt: ev.altKey };
  return binds.some((b) => b.key === ev.code
    && ["Control", "Shift", "Alt"].every((m) => (b.modifiers ?? []).includes(m) === MOD[m]));
}

function onKey(ev) {
  if (!S.open || S.modal) return;
  const typing = ev.target?.classList?.contains("pm-search");
  if (!typing && isToggleKey(ev)) {
    ev.preventDefault(); ev.stopPropagation();
    if (!S.busy) closePartyMenu();   // never mid-write: the view still owns S.v
    return;
  }
  // Z / X are the game's Confirm / Cancel everywhere else (event-input.js), so
  // they are Enter / Escape here too. By physical key, like those bindings.
  const k = typing ? ev.key
    : ev.code === "KeyZ" ? "Enter"
    : ev.code === "KeyX" ? "Escape"
    : ev.key;
  const nav = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Tab", "Backspace", "Delete"];
  if (typing && !["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(k)) return;
  if (!nav.includes(k) && !["q", "e", "Q", "E", "u", "U", "t", "T", "o", "O", "PageUp", "PageDown"].includes(k)) {
    // Swallow everything else too while the menu is up, so WASD / hotkeys do
    // not drive the canvas behind it. Typing in the search box returned above.
    ev.stopPropagation();
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  if (S.busy) return;
  handleKey(k, ev);
}

function onContext(ev) {
  if (ev.target?.closest?.("input, textarea")) return;   // keep the text box's own menu
  ev.preventDefault();
  navBack();
}

// Mouse button 3 = Back. Swallow the press too, or the browser would navigate.
function onMouseBack(ev) {
  if (ev.button !== 3) return;
  ev.preventDefault();
  if (ev.type === "mouseup") navBack();
}

/** One key's worth of menu behaviour: real key presses and the nav bar's buttons both land here. */
function handleKey(k, ev = { key: k, shiftKey: false, target: null }) {
  if (S.busy) return;
  const actor = currentActor();

  if (S.picker) {
    const max = (S.picker.visible ?? S.picker.list).length;
    if (k === "ArrowUp") { S.picker.index = (S.picker.index + max) % (max + 1); play(SND.move, 0.4); render(); }
    else if (k === "ArrowDown") { S.picker.index = (S.picker.index + 1) % (max + 1); play(SND.move, 0.4); render(); }
    else if (k === "Enter") applyPick(actor, S.picker.index);
    else if (k === "Escape") { S.picker = null; play(SND.back); render(); }
    return;
  }

  if (S.view === "main") {
    if (S.focus === "cmd") {
      const n = visibleCommands().length;
      if (k === "ArrowUp") { moveCursor("cmd", -1); S.cmd = (S.cmd + n) % n; render(); }
      else if (k === "ArrowDown") { moveCursor("cmd", 1); S.cmd %= n; render(); }
      else if (k === "Enter") confirmCmd();
      else if (k === "Escape") closePartyMenu();
    } else if (S.focus === "member") {
      const n = S.roster.active.length || 1;
      // Status reaches on past the last member, into the guests and summons below.
      const intoComps = FOR_COMPANIONS.has(S.pendingCmd) && companions().length;
      if (k === "ArrowUp") { moveCursor("member", -1); S.member = (S.member + n) % n; render(); }
      else if (k === "ArrowDown" && intoComps && S.member === n - 1) { play(SND.move, 0.45); S.focus = "comp"; S.comp = 0; render(); }
      else if (k === "ArrowDown") { moveCursor("member", 1); S.member %= n; render(); }
      else if (k === "Enter") pickMember(S.roster.active[S.member]);
      else if (k === "Escape") { S.focus = "cmd"; S.pendingCmd = null; play(SND.back); render(); }
    } else if (S.focus === "comp") {
      const n = companions().length;
      if (!n) { S.focus = S.roster.active.length ? "member" : "cmd"; render(); return; }
      if (k === "ArrowLeft") { moveCursor("comp", -1); S.comp = (S.comp + n) % n; render(); }
      else if (k === "ArrowRight") { moveCursor("comp", 1); S.comp %= n; render(); }
      else if (k === "ArrowUp" && S.roster.active.length) { play(SND.move, 0.45); S.focus = "member"; S.member = S.roster.active.length - 1; render(); }
      else if (k === "Enter") pickCompanion(S.comp);
      else if (k === "Escape") { S.focus = "cmd"; S.pendingCmd = null; play(SND.back); render(); }
    }
    return;
  }

  if (VIEWS[S.view]) { VIEWS[S.view].key(ctx, k, ev); return; }

  // Ability view
  if (k === "q" || k === "Q" || k === "PageUp") return cycleCharacter(-1);
  if (k === "e" || k === "E" || k === "PageDown") return cycleCharacter(1);
  if (k === "Tab" && !companionOf(actor)) {   // a guest or summon has sections, not filters
    const i = FILTERS.findIndex((f) => f.id === S.filter);
    return setFilter(FILTERS[(i + (ev.shiftKey ? -1 : 1) + FILTERS.length) % FILTERS.length].id);
  }
  if (S.focus === "skills") {
    if (k === "t" || k === "T") return openSkillTree(actor);
    const n = filteredSkills(actor).length;
    if (k === "Escape" && S.pinned) { S.pinned = null; play(SND.back); render(); return; }
    if (!n) { if (k === "Escape") backToMain(); return; }
    if (k.startsWith("Arrow")) {
      const next = gridStep(k);
      if (next !== null && next >= 0 && next < n) {
        moveCursor("skill", next - S.skill);
        if (S.pinned) S.pinned = filteredSkills(actor)[S.skill]?.id ?? null;   // the pin travels with the keys
        render();
      }
    } else if (k === "Enter") openSlots(actor);
    else if (k === "Escape") backToMain();
  } else if (S.focus === "slots") {
    const slots = resolvedSlotsOf(actor, currentSkill(actor));
    if (k === "ArrowUp" && S.slot > 0) { moveCursor("slot", -1); render(); }
    else if (k === "ArrowDown" && S.slot < slots.length - 1) { moveCursor("slot", 1); render(); }
    else if (k === "Enter") openPicker(actor, S.slot);
    else if ((k === "Delete" || k === "Backspace") && slots[S.slot] && canBindSummons()) applyBinding(actor, slots[S.slot], null);
    else if (k === "Escape") { S.focus = "skills"; play(SND.back); render(); }
  }
}

// ── live refresh ──────────────────────────────────────────────────────────────

// Only documents the menu can show: in combat every HP tick on every token is an
// updateActor, and re-reading the roster for each would make the menu stutter.
function isRelevantActor(actor) {
  if (!S.open || !actor) return false;
  const r = S.roster;
  if (actor.id === r?.db?.id || actor.id === S.actorId) return true;
  if ([...(r?.active ?? []), ...(r?.reserve ?? []), ...companions().map((c) => c.actor)].some((a) => a.id === actor.id)) return true;
  // A summon slot shows its holder / bound actor.
  return !!actor.flags?.["fabula-ultima-companion"]?.isPersistentSummon || !!S.picker;
}
Hooks.on("updateActor", (actor, change) => {
  const ns = change?.flags?.["fabula-ultima-companion"];
  if (isRelevantActor(actor) || (ns && ("isPersistentSummon" in ns || "-=isPersistentSummon" in ns))) scheduleRender();
});
for (const hook of ["updateItem", "createItem", "deleteItem"]) {
  Hooks.on(hook, (item) => { if (item?.parent && isRelevantActor(item.parent)) scheduleRender(); });
}
// Status lists applied effects: an AE on the character, or on an item they carry.
for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
  Hooks.on(hook, (fx) => {
    const owner = fx?.parent?.documentName === "Item" ? fx.parent.parent : fx?.parent;
    if (owner?.documentName === "Actor" && isRelevantActor(owner)) scheduleRender();
  });
}
Hooks.on("canvasReady", () => scheduleRender());
// The GM changed what players may open: leave a view that is no longer granted.
Hooks.on("fuPartyMenuAccessChanged", () => {
  if (!S.open) return;
  const stale = (S.view !== "main" && !canUseCommand(S.view)) || (S.pendingCmd && !canUseCommand(S.pendingCmd));
  // A write in flight still holds S.v; it is reset when that write returns.
  if (stale && !S.busy) {
    S.view = "main"; S.focus = "cmd"; S.v = null; S.picker = null; S.pendingCmd = null;
  }
  scheduleRender();
});

// ── styles ────────────────────────────────────────────────────────────────────

// The FF9 hand: white glove, dark outline, pointing right.
const HAND_SVG = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 24">
<path d="M2 9.5c0-1.6 1.2-2.6 2.8-2.6h9.6l-1.6-2.4c-.8-1.3.3-3 1.9-2.6.6.1 1 .5 1.4 1l3.6 4h16.1c1.5 0 2.6 1.1 2.6 2.4s-1.1 2.4-2.6 2.4H26.5
c1.3 0 2.2 1 2.2 2.2s-.9 2.1-2.2 2.1h-1c1.2 0 2.1.9 2.1 2.1 0 1.1-.9 2-2.1 2h-1.3c1.1 0 1.9.8 1.9 1.9 0 1-.8 1.9-1.9 1.9H11.6
C6 22 2 18.4 2 13.6z" fill="#fff" stroke="#22242e" stroke-width="1.6" stroke-linejoin="round"/>
<path d="M25.6 14.5h-6M24.6 18.6h-5.6M23.4 11.1h-6.1" stroke="#9aa0b4" stroke-width="1.2" stroke-linecap="round"/></svg>`);

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
/* Skin = the CSB sheets' own "item-type-css" JRPG parchment card (parchment
   fill, gold rivet, pill titles, gold buttons) so the menu reads as part of the
   same game. Layout + hand cursor stay FF9.
   The frame is what that card ACTUALLY renders on a sheet, sampled from a live
   screenshot: a 2px #6f5a46 border inside a 4px #82715f ring with a 1px light
   inner top edge. The card's CSS also declares a 10px carved-wood ::before, but
   on a sheet it sits behind the window's parchment and never shows — painting
   it here made the border far heavier than the standard. */
#${ROOT_ID} {
  --parchment-1: #f6ebd3; --parchment-2: #efdfc3; --parchment-3: #e7d3b1;
  --gold-1: #f4d488; --gold-2: #caa44d; --gold-3: #9a7a2b;
  --ink: #3b2a19; --ink-soft: #704a1d; --ink-dim: rgba(59, 42, 25, .38); --accent: #8b0000;
  --edge: #6f5a46; --ring: #82715f; --glow: rgba(250, 230, 160, .55);
  --hp: #d81e1e; --mp: #1f3fd1; --ip: #d16a41; --low: #c0392b;
  position: fixed; inset: 0; z-index: 10000; color: var(--ink);
  font-family: Signika, "Noto Sans", Inter, "Segoe UI", system-ui, -apple-system, sans-serif;
  user-select: none;
}
#${ROOT_ID} .pm-backdrop { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 40%, rgba(40, 24, 10, .62), rgba(8, 4, 0, .86)); }
#${ROOT_ID} .pm-stage { position: absolute; inset: 0; z-index: 0; display: flex; align-items: center; justify-content: center; padding: 20px; }
#${ROOT_ID} .pm-win {
  position: relative; padding: 14px 18px; border-radius: 14px; color: var(--ink);
  background:
    radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.45) 0%, rgba(255,255,255,.15) 22%, rgba(0,0,0,0) 40%),
    linear-gradient(180deg, var(--parchment-1) 0%, var(--parchment-2) 55%, var(--parchment-3) 100%);
  border: 2px solid var(--edge); background-clip: padding-box;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.6), inset 0 0 0 2px rgba(255,255,255,.08),
    0 0 0 4px var(--ring), 0 14px 28px rgba(0,0,0,.35);
}
#${ROOT_ID} .pm-win::after {
  content: ""; position: absolute; width: 9px; height: 9px; border-radius: 50%; top: 8px; left: 8px; pointer-events: none;
  background: radial-gradient(circle at 35% 35%, #fff8, #fff0 55%), radial-gradient(circle at 60% 65%, #0003, #0000 60%),
    linear-gradient(180deg, var(--gold-1), var(--gold-2) 60%, var(--gold-3));
  box-shadow: 0 0 12px var(--glow);
}
#${ROOT_ID} em { font-style: normal; font-weight: 700; color: var(--ink-soft); font-size: .8em; letter-spacing: .04em; margin-right: 6px; white-space: nowrap; }
#${ROOT_ID} em i { margin-right: 3px; }
#${ROOT_ID} em.hp { color: var(--hp); } #${ROOT_ID} em.mp { color: var(--mp); } #${ROOT_ID} em.ip { color: var(--ip); }
#${ROOT_ID} .pm-label { color: var(--ink-soft); font-size: 13px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
#${ROOT_ID} .pm-pill {
  display: inline-block; padding: 5px 14px; border-radius: 999px; border: 1px solid rgba(120,86,40,.5);
  background: linear-gradient(#fff7d5 0%, #f1dca2 60%, #e2c46e 100%); color: #5c421e; font-weight: 700; letter-spacing: .4px;
  text-shadow: 0 1px 0 rgba(255,255,255,.6);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.65), 0 0 0 3px rgba(90,60,34,.25), 0 6px 14px rgba(0,0,0,.18);
}
#${ROOT_ID} .pm-sub { color: var(--ink-soft); font-size: 12px; opacity: .9; }
#${ROOT_ID} .pm-empty { padding: 18px; color: var(--ink-dim); font-style: italic; }
#${ROOT_ID} .pm-hint { position: absolute; bottom: -34px; right: 4px; font-size: 12px; color: #f1e3c4; text-shadow: 0 1px 2px #000; }
#${ROOT_ID} .pm-rule { height: 1px; margin: 10px 0; border: 0; background: linear-gradient(90deg, transparent, rgba(92,66,30,.55), transparent); opacity: .6; }

/* hand cursor (FF9) */
#${ROOT_ID} .is-cursor, #${ROOT_ID} .is-held { position: relative; }
#${ROOT_ID} .is-cursor::before, #${ROOT_ID} .is-held::before {
  content: ""; position: absolute; left: -34px; top: 50%; width: 34px; height: 21px; margin-top: -10px;
  background: url("data:image/svg+xml,${HAND_SVG}") no-repeat center / contain;
  filter: drop-shadow(1px 2px 0 rgba(59,42,25,.55)); pointer-events: none; z-index: 3;
}
#${ROOT_ID} .is-cursor::before { animation: pm-bob .7s ease-in-out infinite; }
#${ROOT_ID} .is-held::before { opacity: .5; }
#${ROOT_ID} .pm-stage.has-picker > :not(.pm-picker) .is-cursor::before,
#${ROOT_ID} .pm-stage.has-picker > :not(.pm-picker) .is-held::before { display: none; }
@keyframes pm-bob { 0%,100% { transform: translateX(0); } 50% { transform: translateX(-4px); } }
/* the row under the hand: the CSB jrpg-list highlight */
#${ROOT_ID} .pm-member.is-cursor, #${ROOT_ID} .pm-skill.is-cursor, #${ROOT_ID} .pm-slot.is-cursor, #${ROOT_ID} .pm-pick.is-cursor {
  background: linear-gradient(rgba(255,255,255,.55), rgba(255,255,255,.12) 70%);
  box-shadow: inset 0 0 0 1px rgba(154,122,43,.45), 0 0 10px var(--glow);
}

/* main menu */
#${ROOT_ID} .pm-main { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 210px; grid-template-rows: minmax(0, 1fr) auto;
  gap: 18px; width: min(1040px, 100%); height: min(790px, calc(100vh - 90px)); }
/* Scrolling lives on an inner .pm-scroll so the hand cursor's 34px left gutter
   is inside the scroller rather than clipped by the window. */
#${ROOT_ID} .pm-scroll { overflow-y: auto; min-height: 0; height: 100%; padding-right: 16px; }
#${ROOT_ID} .pm-party { display: flex; flex-direction: column; min-height: 0; padding: 16px 20px 16px 8px; }
/* the hand sits 34px left of a row, so that gutter is INSIDE the scroller */
#${ROOT_ID} .pm-party-list { display: flex; flex-direction: column; gap: 10px; padding-left: 38px; }
#${ROOT_ID} .pm-member { display: flex; gap: 16px; align-items: center; padding: 8px 10px; border-radius: 10px; }
#${ROOT_ID} .pm-member.is-pickable { cursor: pointer; }
#${ROOT_ID} .pm-portrait { flex: 0 0 auto; width: 96px; height: 96px; border-radius: 8px; overflow: hidden; background: var(--parchment-3);
  border: 2px solid var(--edge); box-shadow: 0 0 0 2px rgba(202,164,77,.55), 0 3px 8px rgba(0,0,0,.3); }
#${ROOT_ID} .pm-portrait.sm { width: 58px; height: 58px; }
#${ROOT_ID} .pm-portrait.xs { width: 40px; height: 40px; border-width: 1px; box-shadow: 0 0 0 1px rgba(202,164,77,.5); }
#${ROOT_ID} .pm-portrait img { width: 100%; height: 100%; object-fit: cover; object-position: top; border: 0; display: block; }
#${ROOT_ID} .pm-member-body { flex: 1 1 auto; min-width: 0; }
#${ROOT_ID} .pm-member-top { display: flex; align-items: baseline; gap: 14px; }
#${ROOT_ID} .pm-name { font-size: 22px; font-weight: 700; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .pm-lv { font-size: 18px; margin-left: auto; font-weight: 700; }
#${ROOT_ID} .pm-stat { display: grid; grid-template-columns: 46px 48px 12px 48px minmax(60px, 1fr); align-items: center;
  font-size: 17px; font-variant-numeric: tabular-nums; line-height: 1.4; }
#${ROOT_ID} .pm-stat b { font-weight: 600; text-align: right; }
#${ROOT_ID} .pm-stat b.is-low { color: var(--low); }
#${ROOT_ID} .pm-stat span { text-align: center; color: var(--ink-soft); }
#${ROOT_ID} .pm-bar { height: 7px; margin-left: 12px; background: rgba(59,42,25,.14); border-radius: 4px; overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(0,0,0,.25), 0 0 0 1px rgba(80,52,30,.35); }
#${ROOT_ID} .pm-bar i { display: block; height: 100%; }
#${ROOT_ID} .pm-bar.hp i { background: linear-gradient(180deg, #f26b5b, #c0261c); }
#${ROOT_ID} .pm-bar.mp i { background: linear-gradient(180deg, #6b8cff, #2443c8); }
#${ROOT_ID} .pm-bar.ip i { background: linear-gradient(180deg, #f4a172, #c45a2f); }
#${ROOT_ID} .pm-reserve { margin-top: auto; display: flex; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid rgba(92,66,30,.3); }
#${ROOT_ID} .pm-chip { width: 34px; height: 34px; object-fit: cover; object-position: top; border-radius: 6px; border: 1px solid var(--edge); }
#${ROOT_ID} .pm-side { display: flex; flex-direction: column; gap: 18px; }
#${ROOT_ID} .pm-cmds { padding: 16px 14px 16px 48px; display: flex; flex-direction: column; gap: 4px; }
#${ROOT_ID} .pm-cmd { font-size: 21px; font-weight: 700; padding: 3px 8px; border-radius: 8px; cursor: pointer; color: var(--ink); }
#${ROOT_ID} .pm-cmd.is-cursor { color: var(--ink-soft); text-shadow: 0 0 8px rgba(255,0,0,.45); }
#${ROOT_ID} .pm-cmd.is-off { color: var(--ink-dim); cursor: default; }
#${ROOT_ID} .pm-info { margin-top: auto; display: flex; flex-direction: column; gap: 6px; }
#${ROOT_ID} .pm-info-row { display: flex; align-items: baseline; justify-content: flex-end; }
#${ROOT_ID} .pm-info-row:first-child { justify-content: flex-start; }
#${ROOT_ID} .pm-loc { font-size: 15px; justify-content: flex-start; font-weight: 600; }
/* guests & summons: one row under the party, the hand's 34px gutter left of every card */
#${ROOT_ID} .pm-comps { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 10px 18px 10px 20px; }
#${ROOT_ID} .pm-comps-head { display: flex; align-items: center; gap: 8px; padding-left: 12px; }
#${ROOT_ID} .pm-count { padding: 0 7px; border-radius: 999px; font-size: 11px; color: #5c421e; background: linear-gradient(#fff7d5, #e2c46e);
  border: 1px solid rgba(120,86,40,.45); }
#${ROOT_ID} .pm-comp-list { display: flex; gap: 38px; overflow-x: auto; overflow-y: hidden; padding: 2px 4px 4px 38px; scrollbar-width: thin; }
#${ROOT_ID} .pm-comps .pm-empty { padding: 8px 0 10px; }
#${ROOT_ID} .pm-comp { flex: 0 0 auto; width: 92px; height: 92px; display: flex; align-items: flex-end; justify-content: center; cursor: pointer; }
#${ROOT_ID} .pm-comp :is(img, video) { max-width: 100%; max-height: 100%; object-fit: contain; border: 0; display: block;
  filter: drop-shadow(0 3px 3px rgba(59,42,25,.35)); transition: transform .12s ease, filter .12s ease; }
#${ROOT_ID} .pm-comp.is-cursor :is(img, video) { transform: translateY(-3px); filter: drop-shadow(0 0 8px var(--glow)) drop-shadow(0 3px 3px rgba(59,42,25,.35)); }
#${ROOT_ID} .pm-comp.is-off { opacity: .45; filter: saturate(.6); cursor: default; }
@media (prefers-reduced-motion: reduce) { #${ROOT_ID} .pm-comp :is(img, video) { transition: none; } }
#${ROOT_ID} .pm-zenit { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; margin-right: 4px; color: var(--ink-soft); }

/* ability view */
#${ROOT_ID} .pm-ability { position: relative; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 18px;
  width: min(1100px, 100%); height: min(700px, calc(100vh - 90px)); }
/* nav bar (navBar): Back · the path here · this screen's actions, each with its key */
#${ROOT_ID} .pm-nav { display: flex; align-items: center; gap: 14px; box-sizing: border-box; min-height: 50px; padding: 8px 12px 8px 26px; }
#${ROOT_ID} .pm-navback, #${ROOT_ID} .pm-navact { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; }
#${ROOT_ID} .pm-crumbs { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; white-space: nowrap; overflow: hidden; font-size: 15px; }
#${ROOT_ID} .pm-crumb { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ink-soft); cursor: pointer;
  border-bottom: 1px dashed rgba(112,74,29,.45); }
#${ROOT_ID} .pm-crumb:hover { color: var(--accent); }
#${ROOT_ID} .pm-crumb.is-here { color: var(--ink); font-weight: 700; cursor: default; border-bottom: 0; }
#${ROOT_ID} .pm-crumbsep { flex: 0 0 auto; font-size: 9px; color: var(--ink-dim); }
#${ROOT_ID} .pm-navacts { flex: 0 0 auto; display: flex; gap: 8px; }
#${ROOT_ID} .pm-kbd { display: inline-block; font-family: inherit; font-size: 10px; font-weight: 700; line-height: 1; padding: 2px 5px; border-radius: 4px;
  color: #5c421e; background: rgba(255,255,255,.5); border: 1px solid rgba(90,60,34,.45); box-shadow: inset 0 -1px 0 rgba(90,60,34,.25); text-shadow: none; }
#${ROOT_ID} .pm-chips > .pm-kbd { flex: 0 0 auto; opacity: .65; }
#${ROOT_ID} .pm-tabs > .pm-kbd { margin-left: auto; align-self: center; opacity: .65; }
#${ROOT_ID} .pm-pickfoot { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
#${ROOT_ID} .pm-ability-top { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 18px; }
#${ROOT_ID} .pm-title { display: flex; align-items: center; justify-content: center; }
#${ROOT_ID} .pm-title .pm-pill { font-size: 20px; }
#${ROOT_ID} .pm-who { display: flex; align-items: center; gap: 14px; padding: 8px 14px; }
#${ROOT_ID} .pm-who-body { flex: 1 1 auto; min-width: 0; }
/* portrait row (portraitStrip): every character as a chip; the shown one is lifted and ringed */
#${ROOT_ID} .pm-strip { padding: 8px 18px 8px 26px; gap: 18px; }
#${ROOT_ID} .pm-chips { flex: 0 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; overflow: hidden; }
#${ROOT_ID} .pm-pchip { flex: 0 1 50px; min-width: 34px; aspect-ratio: 1; border-radius: 8px; overflow: hidden; cursor: pointer;
  background: var(--parchment-3); border: 2px solid var(--edge); box-shadow: 0 0 0 1px rgba(202,164,77,.45), 0 2px 5px rgba(0,0,0,.25);
  opacity: .62; filter: saturate(.7); transition: opacity .12s ease, transform .12s ease, filter .12s ease; }
#${ROOT_ID} .pm-pchip img { width: 100%; height: 100%; object-fit: cover; object-position: top; border: 0; display: block; }
#${ROOT_ID} .pm-pchip:hover { opacity: .92; filter: none; }
#${ROOT_ID} .pm-pchip.is-on { flex-basis: 58px; opacity: 1; filter: none; transform: translateY(-1px);
  box-shadow: 0 0 0 2px var(--gold-2), 0 0 12px var(--glow), 0 3px 8px rgba(0,0,0,.3); }
#${ROOT_ID} .pm-pchip.is-reserve:not(.is-on) { opacity: .45; }
#${ROOT_ID} .pm-pchip .pm-bagicon { font-size: 22px; }
#${ROOT_ID} .pm-chipsep { flex: 0 0 1px; align-self: stretch; margin: 6px 4px; background: rgba(92,66,30,.35); }
#${ROOT_ID} .pm-stripinfo { border-left: 1px solid rgba(92,66,30,.25); padding-left: 16px; }
#${ROOT_ID} .pm-stripinfo .pm-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (prefers-reduced-motion: reduce) { #${ROOT_ID} .pm-pchip { transition: none; } }
#${ROOT_ID} .pm-stvitals { margin: 0 0 10px; padding: 0 0 8px; border-bottom: 1px solid rgba(92,66,30,.3); }
#${ROOT_ID} .pm-ability-body { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 18px; min-height: 0; }
#${ROOT_ID} .pm-skills { display: flex; flex-direction: column; min-height: 0; padding: 12px 12px 10px 14px; }
#${ROOT_ID} .pm-tabs { display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 0 0 8px 24px; margin-bottom: 8px;
  border-bottom: 1px solid rgba(92,66,30,.3); }
#${ROOT_ID} .pm-tab { font-size: 14px; color: var(--ink); cursor: pointer; border-bottom: 1px dashed rgba(112,74,29,.45); }
#${ROOT_ID} .pm-tab i { margin-right: 4px; }
#${ROOT_ID} .pm-tab.is-on { color: var(--ink-soft); font-weight: 700; text-shadow: 0 0 8px rgba(255,0,0,.55); border-bottom-style: solid; }
#${ROOT_ID} .pm-skill-list { overflow-y: auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 30px;
  align-content: start; padding: 2px 18px 2px 36px; }
/* source section header: spans both columns, CSB panel-title ink with the card's hr rule */
#${ROOT_ID} .pm-section { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; margin: 10px 0 2px -28px;
  padding: 2px 0 4px; color: var(--ink-soft); font-weight: 700; font-size: 13px; letter-spacing: .08em; text-transform: uppercase;
  background: linear-gradient(90deg, rgba(92,66,30,.55), rgba(92,66,30,.15) 70%, transparent) bottom / 100% 1px no-repeat; }
#${ROOT_ID} .pm-section:first-child { margin-top: 0; }
#${ROOT_ID} .pm-section i { width: 16px; text-align: center; color: var(--gold-3); }
#${ROOT_ID} .pm-section b { margin-left: 2px; padding: 0 7px; border-radius: 999px; font-size: 11px; letter-spacing: 0;
  color: #5c421e; background: linear-gradient(#fff7d5, #e2c46e); border: 1px solid rgba(120,86,40,.45); }
#${ROOT_ID} .pm-skill { display: flex; align-items: center; gap: 8px; padding: 3px 6px; border-radius: 8px; cursor: pointer; min-width: 0; }
#${ROOT_ID} .pm-skill img { width: 24px; height: 24px; border: 0; border-radius: 4px; flex: 0 0 auto; }
#${ROOT_ID} .pm-skill-name { flex: 1 1 auto; min-width: 0; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .pm-skill.is-passive .pm-skill-name { color: var(--ink-soft); font-style: italic; }
/* not usable right now (unequipped gear, unsummoned Arcanum, empty stack) */
#${ROOT_ID} .pm-skill.is-locked { opacity: .5; }
#${ROOT_ID} .pm-skill.is-locked img { filter: grayscale(1); }
#${ROOT_ID} .pm-skill.is-locked .pm-skill-name, #${ROOT_ID} .pm-skill.is-locked .pm-skill-cost { color: rgba(59,42,25,.75); }
#${ROOT_ID} .pm-skill.is-locked.is-cursor { opacity: .8; }
#${ROOT_ID} .pm-locked { margin: 0 0 8px; padding: 4px 10px; border-radius: 8px; font-size: 13px; font-weight: 700; color: #6b4a2a;
  background: rgba(59,42,25,.08); box-shadow: inset 0 0 0 1px rgba(80,52,30,.3); }
#${ROOT_ID} .pm-skill-cost { flex: 0 0 auto; font-size: 13px; font-weight: 700; color: var(--mp); font-variant-numeric: tabular-nums; }
/* pinned detail: the row keeps a quiet mark, the detail says how to let go */
#${ROOT_ID} .pm-skill.is-pinned { position: relative; }
#${ROOT_ID} .pm-pinmark { position: absolute; left: -15px; top: 50%; margin-top: 1px; font-size: 13px; color: var(--accent);
  transform: rotate(30deg); filter: drop-shadow(0 1px 0 rgba(255,255,255,.7)); pointer-events: none; z-index: 4; }
#${ROOT_ID} :is(.pm-detail > .pm-scroll, .pm-effcard) { position: relative; }
#${ROOT_ID} :is(.pm-detail-head, .pm-effcard-head) { padding-right: 26px; }
#${ROOT_ID} .pm-pincorner { position: absolute; top: 2px; right: 2px; z-index: 2; width: 22px; height: 22px; display: flex; align-items: center;
  justify-content: center; border-radius: 50%; cursor: pointer; color: var(--accent); font-size: 13px; }
#${ROOT_ID} .pm-pincorner i { transform: rotate(30deg); }
#${ROOT_ID} .pm-pincorner:hover { background: rgba(139,0,0,.1); }
#${ROOT_ID} .pm-badge { font-style: normal; color: var(--gold-2); margin-left: 6px; font-size: 13px; text-shadow: 0 0 6px var(--glow); }
#${ROOT_ID} .pm-detail { min-height: 0; padding: 16px 18px; display: flex; flex-direction: column; }#${ROOT_ID} .pm-detail-head { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
#${ROOT_ID} .pm-detail-head img { width: 42px; height: 42px; border: 1px solid var(--edge); border-radius: 6px; }
#${ROOT_ID} .pm-detail-name { font-size: 20px; font-weight: 700; color: var(--accent); }
#${ROOT_ID} .pm-facts { display: grid; grid-template-columns: auto 1fr; gap: 2px 14px; margin: 0 0 10px; font-size: 14px; }
#${ROOT_ID} .pm-facts dt { color: var(--ink-soft); font-weight: 700; }
#${ROOT_ID} .pm-facts dd { margin: 0; }
#${ROOT_ID} .pm-desc { font-size: 14px; line-height: 1.45; border-top: 1px solid rgba(92,66,30,.3); padding-top: 8px; }
#${ROOT_ID} .pm-desc p { margin: 0 0 6px; }
#${ROOT_ID} .pm-desc img { max-width: 100%; height: auto; vertical-align: middle; border: 0; }
#${ROOT_ID} .pm-desc a { color: var(--ink-soft); font-weight: 700; text-decoration: none; border-bottom: 1px dashed rgba(112,74,29,.45); }
#${ROOT_ID} .pm-slots { margin: 4px 0 12px; padding: 8px 10px 8px 36px; border-radius: 10px;
  background: linear-gradient(rgba(255,247,213,.7), rgba(241,220,162,.45)); box-shadow: inset 0 0 0 1px rgba(154,122,43,.55); }
#${ROOT_ID} .pm-slots > .pm-label { color: var(--accent); margin-bottom: 4px; }
#${ROOT_ID} .pm-slot { display: flex; align-items: center; gap: 10px; padding: 6px 6px; border-radius: 8px; }
#${ROOT_ID} .pm-slot-body { flex: 1 1 auto; min-width: 0; }
#${ROOT_ID} .pm-slot-title { font-size: 12px; color: var(--ink-soft); font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
#${ROOT_ID} .pm-slot-name { font-size: 17px; font-weight: 700; }
#${ROOT_ID} .pm-slot-actions { display: flex; flex-direction: column; gap: 6px; }
#${ROOT_ID} .pm-btn {
  width: auto; line-height: 1.4; padding: 3px 12px; font-size: 13px; font-weight: 700; font-family: inherit; cursor: pointer;
  border: 1px solid rgba(90,60,34,.65); border-radius: 10px; color: #4b3517; text-shadow: 0 1px 0 rgba(255,255,255,.6);
  background: linear-gradient(180deg, #e9d39d 0%, #caa44d 60%, #8d6b2a 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.6), 0 0 0 2px rgba(90,60,34,.28), 0 4px 10px rgba(0,0,0,.2);
}
#${ROOT_ID} .pm-btn:hover { filter: brightness(1.05) saturate(1.05); }
#${ROOT_ID} .pm-btn:active { transform: translateY(1px); }
#${ROOT_ID} .pm-btn:disabled { cursor: not-allowed; opacity: .45; filter: grayscale(.7); transform: none; }

/* picker */
/* overlays sit in their own layer: the drawn scrollbars and the hand use z-index 3 inside the windows below */
#${ROOT_ID} .pm-picker-veil { position: absolute; inset: 0; z-index: 20; background: rgba(20, 12, 4, .45); }
#${ROOT_ID} .pm-picker { position: absolute; z-index: 21; width: min(460px, calc(100% - 48px)); max-height: min(560px, calc(100vh - 100px));
  display: flex; flex-direction: column; gap: 8px; padding: 16px 18px; }
#${ROOT_ID} .pm-picker .pm-hint { position: static; text-align: right; color: var(--ink-soft); text-shadow: none; }
#${ROOT_ID} .pm-picker-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
#${ROOT_ID} .pm-showall { font-size: 12px; display: flex; align-items: center; gap: 4px; color: var(--ink-soft); white-space: nowrap; }
#${ROOT_ID} .pm-search { background: rgba(0,0,0,.05); color: var(--ink); border: 1px solid #7a7971; border-radius: 3px;
  padding: 4px 8px; font-family: inherit; font-size: 14px; }
#${ROOT_ID} .pm-search::placeholder { color: rgba(59,42,25,.5); }
#${ROOT_ID} .pm-picker-list { overflow-y: auto; min-height: 120px; padding-left: 36px; padding-right: 18px; }
#${ROOT_ID} .pm-pick-group { color: var(--accent); font-size: 12px; font-weight: 700; letter-spacing: .06em; margin: 8px 0 2px; text-transform: uppercase; }
#${ROOT_ID} .pm-pick { display: flex; align-items: center; gap: 10px; padding: 3px 6px; border-radius: 8px; cursor: pointer; font-size: 16px; }

#${ROOT_ID} .pm-toast { z-index: 22; position: absolute; bottom: 44px; left: 50%; transform: translateX(-50%); font-size: 16px; font-weight: 700; padding: 8px 20px; }

/* a label that opens a window would sit on the gold rivet */
#${ROOT_ID} .pm-win > .pm-label:first-child, #${ROOT_ID} .pm-win > .pm-scroll > .pm-label:first-child { padding-left: 12px; }
#${ROOT_ID} .pm-who.pm-who-plain { padding-left: 26px; }

/* command column: GM-only mark */
#${ROOT_ID} .pm-gmmark { font-size: 11px; margin-left: 8px; color: var(--gold-3); vertical-align: middle; }

/* shared list bits for the Item / Equip / Status / Setup views */
#${ROOT_ID} .pm-skill-list.pm-onecol { grid-template-columns: minmax(0, 1fr); }
#${ROOT_ID} .pm-qty { color: var(--ink-soft); }
#${ROOT_ID} .pm-worn { font-weight: 700; font-size: 11px; padding: 0 5px; border-radius: 4px; color: #fff; background: var(--accent); text-shadow: none; }
/* Orbment sockets: gems in the orb icons' colours (red / blue / gold), outlined = empty. */
#${ROOT_ID} .pm-orbpips { display: inline-flex; gap: 5px; margin-left: 8px; vertical-align: middle; }
#${ROOT_ID} .pm-gem { display: inline-block; width: 8px; height: 8px; transform: rotate(45deg); border-radius: 2px; font-style: normal;
  background: radial-gradient(circle at 30% 30%, rgba(255,255,255,.85), transparent 45%), var(--pm-gem, #888); box-shadow: 0 0 0 1.5px #3a2410, 0 0 5px var(--pm-gem, #888); }
#${ROOT_ID} .pm-gem.is-offensive { --pm-gem: #b8432c; }
#${ROOT_ID} .pm-gem.is-defensive { --pm-gem: #3d5fb0; }
#${ROOT_ID} .pm-gem.is-enhancement { --pm-gem: #d39a1e; }
#${ROOT_ID} .pm-gem.is-empty { background: rgba(255,255,255,.06); box-shadow: inset 0 0 0 1.5px rgba(200,160,80,.55); }
#${ROOT_ID} .pm-orbs { display: grid; gap: 6px; }
#${ROOT_ID} .pm-orb { display: flex; align-items: flex-start; gap: 10px; }
#${ROOT_ID} .pm-orb .pm-gem { margin: 5px 2px 0; flex-shrink: 0; }
#${ROOT_ID} .pm-orb-txt { display: flex; flex-direction: column; line-height: 1.3; }
#${ROOT_ID} .pm-orb-txt small { font-size: .85em; color: var(--ink-soft); }
#${ROOT_ID} .pm-bagicon { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: 26px; color: var(--gold-3); }
#${ROOT_ID} .pm-portrait.xs .pm-bagicon { font-size: 18px; }
#${ROOT_ID} .pm-actions { display: flex; gap: 8px; margin: 0 0 10px; }
#${ROOT_ID} .pm-why { margin-left: auto; font-size: 11px; font-weight: 600; color: var(--ink-soft); opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
#${ROOT_ID} .pm-pick.is-locked, #${ROOT_ID} .pm-surow.is-locked { opacity: .5; }
#${ROOT_ID} .pm-pick.is-locked img { filter: grayscale(1); }
#${ROOT_ID} .pm-qtybox { width: min(380px, calc(100% - 48px)); }
#${ROOT_ID} .pm-qtyrow { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 10px 0; }
#${ROOT_ID} .pm-qtyval { font-size: 32px; font-weight: 700; min-width: 2.2em; text-align: center; font-variant-numeric: tabular-nums; }

/* equip */
#${ROOT_ID} .pm-eqwin { padding-left: 46px; }
#${ROOT_ID} .pm-eqlist { display: flex; flex-direction: column; gap: 4px; }
#${ROOT_ID} .pm-eqslot { display: grid; grid-template-columns: 130px 30px minmax(0, 1fr); align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
#${ROOT_ID} .pm-eqslot img, #${ROOT_ID} .pm-eqnone { width: 30px; height: 30px; border: 0; border-radius: 4px; }
#${ROOT_ID} .pm-eqnone { background: rgba(59,42,25,.08); box-shadow: inset 0 0 0 1px rgba(80,52,30,.2); }
#${ROOT_ID} .pm-eqlabel { font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-soft); }
#${ROOT_ID} .pm-eqlabel i { width: 18px; margin-right: 6px; text-align: center; color: var(--gold-3); }
#${ROOT_ID} .pm-eqname { font-size: 17px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .pm-eqname.is-empty, #${ROOT_ID} .pm-suname.is-empty { color: var(--ink-dim); font-style: italic; }
#${ROOT_ID} .pm-eqslot.is-cursor, #${ROOT_ID} .pm-surow.is-cursor {
  background: linear-gradient(rgba(255,255,255,.55), rgba(255,255,255,.12) 70%);
  box-shadow: inset 0 0 0 1px rgba(154,122,43,.45), 0 0 10px var(--glow);
}
/* choosing gear: the left window holds the candidates (two columns) over the comparison */
#${ROOT_ID} .pm-eqwin.is-choosing { padding-left: 14px; }
#${ROOT_ID} .pm-eqpickhead { display: flex; align-items: baseline; gap: 12px; padding: 0 0 8px 24px; margin-bottom: 6px;
  border-bottom: 1px solid rgba(92,66,30,.3); }
#${ROOT_ID} .pm-eqcands { flex: 0 1 auto; min-height: 64px; }
#${ROOT_ID} .pm-eqcands .pm-eqnone { width: 24px; height: 24px; flex: 0 0 auto; }
#${ROOT_ID} .pm-eqcands .pm-skill-name.is-empty { color: var(--ink-dim); font-style: italic; }
#${ROOT_ID} .pm-eqcands .pm-why { max-width: 45%; }
#${ROOT_ID} .pm-eqlock { flex: 0 0 auto; margin-left: auto; font-size: 11px; color: var(--ink-soft); }
#${ROOT_ID} .pm-defline { display: flex; gap: 22px; margin-top: auto; padding-top: 10px; border-top: 1px solid rgba(92,66,30,.3); font-size: 18px; font-variant-numeric: tabular-nums; }
#${ROOT_ID} .pm-defline b { font-weight: 700; }

/* status */
#${ROOT_ID} .pm-attrs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 4px 0 6px; }
#${ROOT_ID} .pm-attr { display: flex; flex-direction: column; align-items: center; padding: 6px 4px; border-radius: 8px; background: rgba(255,247,213,.55); box-shadow: inset 0 0 0 1px rgba(154,122,43,.45); }
#${ROOT_ID} .pm-attr b { font-size: 22px; }
#${ROOT_ID} .pm-attr em { margin: 0; }
#${ROOT_ID} .pm-detail .pm-defline { margin: 6px 0 10px; }
#${ROOT_ID} .pm-affs { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 4px; margin: 4px 0 10px; }
#${ROOT_ID} .pm-aff { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 0; border-radius: 6px; font-size: 12px; background: rgba(59,42,25,.06); }
#${ROOT_ID} .pm-aff i { font-size: 15px; color: var(--ink-soft); }
#${ROOT_ID} .pm-aff.aff-vu b { color: var(--low); } #${ROOT_ID} .pm-aff.aff-rs b { color: var(--mp); }
#${ROOT_ID} .pm-aff.aff-im b { color: #4b3517; } #${ROOT_ID} .pm-aff.aff-ab b { color: #2e7d32; }
/* screen transitions (applyTransition): short, small, and only on a change of screen.
   --pm-t is the time already elapsed when a re-render lands mid-animation.
   The bright parchment WINDOWS never fade — only move. Fading a window over the
   dark backdrop dips the screen's brightness by ~45% and back within 150 ms,
   which reads as a flash. Only what is written ON the parchment fades, and
   never below 35%, so the screen's brightness stays level. */
@keyframes pm-rise { from { opacity: 0; transform: translateY(8px); } }
@keyframes pm-lift { from { transform: translateY(8px); } }
@keyframes pm-settle { from { transform: translateY(-6px); } }
@keyframes pm-ink { from { opacity: .35; } }
@keyframes pm-ink-nudge { from { opacity: .55; transform: translateY(3px); } }
@keyframes pm-ink-right { from { opacity: .35; transform: translateX(12px); } }
@keyframes pm-ink-left { from { opacity: .35; transform: translateX(-12px); } }
@keyframes pm-pop { from { opacity: .6; transform: scale(.97); } }
@keyframes pm-fade { from { opacity: 0; } }
#${ROOT_ID} .pm-stage[class*="pm-anim-"] { --pm-ease: cubic-bezier(.2, .8, .2, 1); }
/* opening over the game: the one fade from nothing, once */
#${ROOT_ID} .pm-anim-open > :is(.pm-main, .pm-ability) { animation: pm-rise 170ms var(--pm-ease) var(--pm-t, 0ms) both; }
/* into a command: windows lift into place in turn, their text inks in */
#${ROOT_ID} .pm-anim-enter :is(.pm-ability > .pm-nav, .pm-ability-top > .pm-win, .pm-ability-body > .pm-win) {
  animation: pm-lift 150ms var(--pm-ease) var(--pm-t, 0ms) both; }
#${ROOT_ID} .pm-anim-enter :is(.pm-ability > .pm-nav, .pm-ability-top > .pm-win, .pm-ability-body > .pm-win) > * {
  animation: pm-ink 150ms var(--pm-ease) var(--pm-t, 0ms) both; }
#${ROOT_ID} .pm-anim-enter :is(.pm-ability-top > .pm-win, .pm-ability-top > .pm-win > *) { animation-delay: calc(var(--pm-t, 0ms) + 20ms); }
#${ROOT_ID} .pm-anim-enter :is(.pm-ability-body > .pm-win, .pm-ability-body > .pm-win > *) { animation-delay: calc(var(--pm-t, 0ms) + 40ms); }
#${ROOT_ID} .pm-anim-enter :is(.pm-ability-body > .pm-win + .pm-win, .pm-ability-body > .pm-win + .pm-win > *) { animation-delay: calc(var(--pm-t, 0ms) + 55ms); }
/* back to the main menu: windows settle from just above */
#${ROOT_ID} .pm-anim-back :is(.pm-party, .pm-comps, .pm-side > .pm-win) { animation: pm-settle 150ms var(--pm-ease) var(--pm-t, 0ms) both; }
#${ROOT_ID} .pm-anim-back :is(.pm-party, .pm-comps, .pm-side > .pm-win) > * { animation: pm-ink 150ms var(--pm-ease) var(--pm-t, 0ms) both; }
#${ROOT_ID} .pm-anim-back :is(.pm-side > .pm-win, .pm-side > .pm-win > *) { animation-delay: calc(var(--pm-t, 0ms) + 20ms); }
/* another character / bag / tab: only the content changes, so only the content moves */
#${ROOT_ID} :is(.pm-anim-switch, .pm-anim-tab) :is(.pm-ability-body > .pm-win > *, .pm-stripinfo, .pm-crumb.is-here) {
  animation: pm-ink-nudge 120ms var(--pm-ease) var(--pm-t, 0ms) both; }
#${ROOT_ID} .pm-anim-page .pm-detail > .pm-scroll { animation: pm-ink-nudge 120ms var(--pm-ease) var(--pm-t, 0ms) both; }
#${ROOT_ID} .pm-anim-swap .pm-eqwin > * { animation: pm-ink-right 150ms var(--pm-ease) var(--pm-t, 0ms) both; }
#${ROOT_ID} .pm-anim-unswap .pm-eqwin > * { animation: pm-ink-left 130ms var(--pm-ease) var(--pm-t, 0ms) both; }
#${ROOT_ID} :is(.pm-anim-swap, .pm-anim-unswap) .pm-detail > .pm-scroll { animation: pm-ink 130ms var(--pm-ease) var(--pm-t, 0ms) both; }
/* an overlay: the dimming eases in (that darkens, it never flashes); the window grows from 97% */
#${ROOT_ID} .pm-anim-pop .pm-picker { animation: pm-pop 120ms var(--pm-ease) var(--pm-tp, 0ms) both; }
#${ROOT_ID} .pm-anim-pop .pm-picker-veil { animation: pm-fade 120ms linear var(--pm-tp, 0ms) both; }
@media (prefers-reduced-motion: reduce) { #${ROOT_ID} .pm-stage[class*="pm-anim-"] * { animation: none !important; } }
/* drawn scrollbar (party-menu-scrollbar.js): the native one is hidden on these boxes */
#${ROOT_ID} :is(.pm-skill-list, .pm-scroll, .pm-picker-list, .pm-effcard, .pm-cmpbody, .pm-aiwin) { scrollbar-width: none; }
#${ROOT_ID} :is(.pm-skill-list, .pm-scroll, .pm-picker-list, .pm-effcard, .pm-cmpbody, .pm-aiwin)::-webkit-scrollbar { width: 0; height: 0; }
/* quiet at rest (thin ink thumb, no track); widens and warms to gold under the pointer */
#${ROOT_ID} .pm-sbar { position: absolute; z-index: 3; width: 5px; border-radius: 3px; cursor: pointer;
  background: transparent; transition: width .15s ease, background-color .15s ease; }
#${ROOT_ID} .pm-sbar-thumb { display: block; width: 100%; border-radius: 3px; cursor: grab;
  background: rgba(92, 66, 30, .26); transition: background-color .15s ease; }
#${ROOT_ID} .pm-sbar:hover, #${ROOT_ID} .pm-sbar.is-drag { width: 8px; background: rgba(59, 42, 25, .07); }
#${ROOT_ID} .pm-sbar:hover .pm-sbar-thumb { background: rgba(154, 122, 43, .62); }
#${ROOT_ID} .pm-sbar.is-drag .pm-sbar-thumb { background: rgba(154, 122, 43, .8); cursor: grabbing; }
@media (prefers-reduced-motion: reduce) { #${ROOT_ID} .pm-sbar, #${ROOT_ID} .pm-sbar-thumb { transition: none; } }

/* status: effect list (scrolls) over a detail card with a guaranteed share of the column */
#${ROOT_ID} .pm-status-body { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); }
#${ROOT_ID} .pm-efflist { flex: 1 1 0; min-height: 96px; margin-top: 4px; }
#${ROOT_ID} .pm-eff .pm-skill-name .pm-qty { font-size: 13px; font-weight: 700; }
#${ROOT_ID} .pm-effchip { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 700;
  color: var(--ink-soft); font-variant-numeric: tabular-nums; white-space: nowrap; }
#${ROOT_ID} .pm-effchip.is-temp { color: #9a4d00; padding: 0 7px; border-radius: 999px;
  background: rgba(240,170,70,.18); box-shadow: inset 0 0 0 1px rgba(170,95,20,.35); }
#${ROOT_ID} .pm-effchip i { font-size: 10px; }
/* stat chips: plain text, stat in small muted caps, change in bold; the name truncates first */
#${ROOT_ID} .pm-effstats { flex: 0 1 auto; min-width: 0; max-width: 58%; display: inline-flex; align-items: baseline; justify-content: flex-end;
  gap: 14px; white-space: nowrap; overflow: hidden; }
#${ROOT_ID} .pm-stat-chip { display: inline-flex; align-items: baseline; gap: 5px; min-width: 0; color: var(--ink); }
#${ROOT_ID} .pm-stat-chip em { font-style: normal; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  color: var(--ink-soft); opacity: .85; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .pm-stat-chip b { font-size: 13.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
#${ROOT_ID} .pm-stat-chip i { font-size: 11px; color: var(--ink-soft); align-self: center; }
#${ROOT_ID} .pm-stat-chip.is-bad b, #${ROOT_ID} .pm-effamts b.is-bad { color: var(--low); }
#${ROOT_ID} .pm-grade { font-size: 12px !important; letter-spacing: .03em; }
#${ROOT_ID} .pm-grade.aff-vu { color: var(--low); } #${ROOT_ID} .pm-grade.aff-rs { color: var(--mp); }
#${ROOT_ID} .pm-grade.aff-im { color: #4b3517; } #${ROOT_ID} .pm-grade.aff-ab { color: #2e7d32; }
#${ROOT_ID} .pm-effmore { font-size: 11px; font-weight: 700; color: var(--ink-soft); opacity: .75; }
/* One fixed share of the column whatever the effect says: a card that sized itself to its text made the list above it jump on every move. Long text scrolls inside. */
#${ROOT_ID} .pm-effcard { flex: 0 0 auto; height: 42%; overflow-y: auto; margin-top: 8px; padding: 10px 18px 2px 4px;
  border-top: 1px solid rgba(92,66,30,.35); }
#${ROOT_ID} .pm-effcard-head { display: flex; gap: 10px; align-items: center; margin-bottom: 6px; }
#${ROOT_ID} .pm-effcard-head img { width: 36px; height: 36px; border: 1px solid var(--edge); border-radius: 6px; flex: 0 0 auto; }
#${ROOT_ID} .pm-effcard-name { font-size: 18px; font-weight: 700; color: var(--accent); line-height: 1.2; }
#${ROOT_ID} .pm-efflife { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--ink-soft); }
#${ROOT_ID} .pm-efflife.is-temp { color: #9a4d00; }
#${ROOT_ID} .pm-efflife.is-off { color: var(--ink-dim); }
#${ROOT_ID} .pm-effsrc { list-style: none; margin: 0 0 6px; padding: 0; font-size: 13px; }
#${ROOT_ID} .pm-effsrc li { display: flex; gap: 10px; justify-content: space-between; padding: 2px 0; border-bottom: 1px dotted rgba(92,66,30,.25); }
#${ROOT_ID} .pm-effsrc li span { min-width: 0; }
#${ROOT_ID} .pm-effsrc li em { color: #9a4d00; font-style: normal; }
#${ROOT_ID} .pm-effamts { flex: 0 0 auto; max-width: 60%; display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
#${ROOT_ID} .pm-effamts b { text-align: right; font-variant-numeric: tabular-nums; }
#${ROOT_ID} .pm-effsrc li.is-total { border-bottom: 0; font-weight: 700; color: var(--accent); }
#${ROOT_ID} .pm-effcard .pm-desc { font-size: 13px; }
/* a guest's / summon's AI, under its action list on the Ability page */
#${ROOT_ID} .pm-aiwin { flex: 0 1 auto; min-height: 0; max-height: 48%; overflow-y: auto; margin-bottom: 8px; padding: 0 16px 8px 0;
  border-bottom: 1px solid rgba(92,66,30,.35); }
#${ROOT_ID} .pm-aiwin > .pm-label:first-child { padding-left: 12px; }
#${ROOT_ID} .pm-aiwin .pm-locked { margin: 4px 0 6px; font-weight: 600; }
#${ROOT_ID} .pm-airules { list-style: none; margin: 4px 0 6px; padding: 0; display: flex; flex-direction: column; gap: 7px; }
#${ROOT_ID} .pm-airules li { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; border-bottom: 1px dotted rgba(92,66,30,.25); }
#${ROOT_ID} .pm-airules li:last-child { border-bottom: 0; }
#${ROOT_ID} .pm-airules li img, #${ROOT_ID} .pm-airules li .pm-eqnone { width: 26px; height: 26px; flex: 0 0 auto; border: 0; border-radius: 4px; margin-top: 1px; }
#${ROOT_ID} .pm-airule { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
#${ROOT_ID} .pm-aiact { font-size: 15px; font-weight: 700; color: var(--accent); }
#${ROOT_ID} .pm-aiwhen { font-size: 14px; line-height: 1.35; }
#${ROOT_ID} .pm-aitags { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 2px; }
#${ROOT_ID} .pm-aitag { font-size: 11.5px; font-weight: 600; line-height: 1.5; padding: 0 8px; border-radius: 999px; color: var(--ink-soft);
  background: rgba(59,42,25,.06); box-shadow: inset 0 0 0 1px rgba(80,52,30,.25); }
#${ROOT_ID} .pm-aitag b { color: var(--ink); }
#${ROOT_ID} .pm-aitag.is-rank { color: #5c421e; background: linear-gradient(#fff7d5, #f1dca2); box-shadow: inset 0 0 0 1px rgba(120,86,40,.45); }
#${ROOT_ID} .pm-aitag.is-limit { color: #9a4d00; background: rgba(240,170,70,.15); box-shadow: inset 0 0 0 1px rgba(170,95,20,.35); }
#${ROOT_ID} .pm-airules .pm-aik { font-size: 1em; font-weight: 700; letter-spacing: 0; margin: 0; white-space: normal; color: var(--ink-soft); }
#${ROOT_ID} .pm-skills.has-ai .pm-skill-list { flex: 0 1 auto; }
#${ROOT_ID} .pm-skills.has-ai .pm-aiwin { flex: 0 1 auto; max-height: 60%; margin: 8px 0 0; padding: 10px 16px 0 10px; border-bottom: 0;
  border-top: 1px solid rgba(92,66,30,.35); }
#${ROOT_ID} .pm-skills.has-ai .pm-aiwin > .pm-label:first-child { padding-left: 0; }
#${ROOT_ID} .pm-aifoot { font-size: 12px; font-style: italic; line-height: 1.35; }
#${ROOT_ID} .pm-from { font-weight: 700; color: var(--ink-soft); }

/* setup */
#${ROOT_ID} .pm-sulist { padding-left: 36px; }
#${ROOT_ID} .pm-surow { display: flex; align-items: center; gap: 10px; padding: 4px 6px; border-radius: 8px; cursor: pointer; min-height: 34px; }
#${ROOT_ID} .pm-surow .pm-portrait.xs { width: 30px; height: 30px; }
#${ROOT_ID} .pm-sunum { width: 14px; text-align: right; font-weight: 700; color: var(--ink-soft); font-size: 13px; }
#${ROOT_ID} .pm-suname { flex: 0 1 auto; font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .pm-surow .pm-sub { margin-left: auto; text-align: right; }
#${ROOT_ID} .pm-check { width: 18px; text-align: center; color: var(--gold-3); font-size: 16px; }
#${ROOT_ID} .pm-btn.pm-mini { margin-left: auto; padding: 0 8px; font-size: 11px; line-height: 1.6; }
#${ROOT_ID} .pm-sunote { margin-top: 12px; }

/* equip: before → after comparison (party-menu-gear-preview.js) */
#${ROOT_ID} .pm-cmp { margin-top: auto; padding-top: 8px; border-top: 1px solid rgba(92,66,30,.3); display: flex; flex-direction: column; min-height: 0; }
#${ROOT_ID} .pm-cmphead { margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .pm-cmpbody { overflow-y: auto; max-height: 220px; padding-right: 14px; }
#${ROOT_ID} .pm-cmprow { display: grid; grid-template-columns: minmax(70px, 1fr) 54px 18px 54px 22px; align-items: center; gap: 4px;
  font-size: 16px; font-variant-numeric: tabular-nums; line-height: 1.5; }
#${ROOT_ID} .pm-cmprow em { margin: 0; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .pm-cmprow b { text-align: right; font-weight: 600; }
#${ROOT_ID} .pm-cmprow > i { font-size: 10px; color: var(--ink-dim); text-align: center; }
#${ROOT_ID} .pm-cmprow.is-same { opacity: .55; }
#${ROOT_ID} .pm-cmprow.is-up .pm-cmpafter, #${ROOT_ID} .pm-cmprow.is-up .pm-cmparrow { color: #2e7d32; font-weight: 700; }
#${ROOT_ID} .pm-cmprow.is-down .pm-cmpafter, #${ROOT_ID} .pm-cmprow.is-down .pm-cmparrow { color: var(--low); font-weight: 700; }
#${ROOT_ID} .pm-cmparrow { font-size: 12px; }
#${ROOT_ID} .pm-cmpnote { font-size: 13px; color: var(--ink-soft); padding: 1px 0; }
#${ROOT_ID} .pm-cmpnote i { width: 16px; margin-right: 4px; text-align: center; font-size: 11px; }
#${ROOT_ID} .pm-cmpnote em { margin-right: 6px; }
#${ROOT_ID} .pm-cmpnote.is-up { color: #2e7d32; } #${ROOT_ID} .pm-cmpnote.is-down { color: var(--low); }
#${ROOT_ID} .pm-net { flex: 0 0 auto; margin-left: auto; font-size: 12px; font-weight: 700; letter-spacing: -1px; }
#${ROOT_ID} .pm-why + .pm-net { margin-left: 8px; }
#${ROOT_ID} .pm-net.is-up { color: #2e7d32; } #${ROOT_ID} .pm-net.is-down { color: var(--low); } #${ROOT_ID} .pm-net.is-mixed { color: #7a3fb4; }
${BONDS_CSS}
${BESTIARY_CSS}
${CONFIG_CSS(ROOT_ID)}
@media (max-width: 760px) {
  #${ROOT_ID} .pm-main { grid-template-columns: 1fr; height: auto; max-height: calc(100vh - 90px); }
  #${ROOT_ID} .pm-ability-body { grid-template-columns: 1fr; }
  #${ROOT_ID} .pm-skill-list { grid-template-columns: 1fr; }
}
`;
  document.head.appendChild(el);
}

Hooks.once("ready", () => {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.partyMenu = { open: openPartyMenu, close: closePartyMenu, isOpen: isPartyMenuOpen };
});
