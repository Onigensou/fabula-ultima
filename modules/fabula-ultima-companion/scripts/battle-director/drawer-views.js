// drawer-views.js — the steps that follow a command, drawn INSIDE the plate's
// drawer instead of as centre-screen overlays (players), plus the skill card
// the portrait card flips into while a list is open.
//
// Built from the approved mockup v2 (claude.ai/artifact/45Yu2keCsGrAuupbJkuAgV,
// 2026-10-13): every step keeps the command window's size (a 117 px working
// area + a 38 px footer), lists are two columns of 27 px rows, 1-3 plain
// choices become tiles, the footer carries a one-line summary, faint key hints,
// a small parchment Back and a big garnet Confirm. The portrait card flips
// (0.26 s, ungated: asked for on a machine with animations off) into a 324 x
// 380 card holding the highlighted entry's full description.
//
// The drawer itself (where it is, who holds it open) lives in
// director-player-hud.js (plateDrawerHost). This module only draws into it, so
// a future GM plate can host the same steps.

import { log, warn } from "./logger.js";
import { playUiHoverSfx, playUiClickSfx } from "./director-ui-sfx.js";

const STYLE_ID = "fud-drawer-views-styles";

// ── text helpers ──────────────────────────────────────────────────────────────
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
// The GM Battle Desk (gm-desk.js) hosts these views in its console. A view in
// a desk layer that is hidden (something newer is on top), stashed (detached
// under a reaction), or locked (Watch: a player is deciding) must not take
// keys, and none of them may while an action card is open (its Enter/Esc).
export function keysBlockedFor(node) {
  if (!node) return false;
  if (node.dataset?.gmd === "1" && !node.isConnected) return true;
  const layer = node.closest?.(".gmd-layer");
  if (!layer) return false;
  if (layer.classList.contains("is-off") || layer.classList.contains("is-locked")) return true;
  return !!layer.closest(".gmd")?.classList.contains("is-card");
}
const stripTags = (html) => String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
// Rich text → plain text that keeps its paragraphs and list items as lines.
export function htmlToCardText(html) {
  const s = String(html ?? "");
  if (!s.trim()) return "";
  const div = document.createElement("div");
  div.innerHTML = s
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h\d|tr|ul|ol)(\s[^>]*)?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/li>/gi, "");
  // @UUID[...]{Label} links keep their label.
  const text = (div.textContent ?? "").replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, "$1");
  return text.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
}
// "Fire • Range • One enemy" + the dice pill → ["Fire", "Range", "One enemy", "DEX + WLP"].
function secondaryParts(html) {
  const s = String(html ?? "");
  if (!s.trim()) return [];
  const div = document.createElement("div");
  div.innerHTML = s;
  const bullets = [...div.querySelectorAll(".bullet")].map((b) => b.textContent.trim()).filter(Boolean);
  const pills = [...div.querySelectorAll(".check-attr")].map((b) => b.textContent.trim()).filter(Boolean);
  if (bullets.length || pills.length) return [...bullets, ...pills];
  return (div.textContent ?? "").split("•").map((t) => t.trim()).filter(Boolean);
}

// ── styles ────────────────────────────────────────────────────────────────────
export function ensureDrawerStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
/* Garnet call-to-action family (Take Turn). */
.dhv-view, .fud-octopath.is-docked {
  --dhv-cta-a:#c4473a; --dhv-cta-b:#8e2219; --dhv-cta-c:#741a14; --dhv-cta-ink:#fff3e6; --dhv-cta-rim:#e2c27e;
}
.dhv-view {
  box-sizing: border-box; height: 175px; padding: 14px 18px 6px;
  display: grid; grid-template-rows: 117px 38px;
  font-family: var(--dhud-ui, "Signika", "Segoe UI", system-ui, sans-serif); color: var(--dhud-ink, #3a3228);
}
.dhv-view.is-in .dhv-main { animation: dhvIn 150ms ease-out; }
@keyframes dhvIn { from { opacity: 0; } to { opacity: 1; } }
.dhv-view[inert] { pointer-events: none; }
.dhv-main { min-height: 0; display: flex; gap: 14px; }
.dhv-sep { align-self: stretch; width: 1px; flex: none; background: linear-gradient(180deg, transparent, #b7935a 15%, #b7935a 85%, transparent); }

/* Footer */
.dhv-foot, .fud-octopath.is-docked .cmd-foot {
  box-sizing: border-box; height: 38px; padding: 4px 0 0 4px; border-top: 1px solid rgba(122,106,85,.35);
  display: flex; align-items: center; gap: 10px; min-width: 0;
}
.dhv-ftxt { flex: 1 1 auto; min-width: 0; font: italic 600 13px/18px var(--dhud-ui, "Signika", sans-serif); color: #4b4338; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dhv-ftxt .bad { color: #b3261e; font-style: normal; font-weight: 700; }
.dhv-ftxt .cnt { font-style: normal; font-weight: 800; color: #3a3228; }
.dhv-hints { flex: none; font: 600 10.5px var(--dhud-ui, "Signika", sans-serif); color: #a3967f; white-space: nowrap; letter-spacing: .02em; }
.dhv-tabs { flex: none; display: flex; gap: 4px; }
.dhv-tabs .dhv-tab { font: 800 11px var(--dhud-ui, "Signika", sans-serif); letter-spacing: .08em; text-transform: uppercase; padding: 0 8px; height: 22px; line-height: 20px; box-sizing: border-box;
  border-radius: 6px; border: 1px solid rgba(122,106,85,.5); background: linear-gradient(180deg, #fbf6ea, #e9dfc8); color: #6a5d4c; cursor: pointer; box-shadow: 0 1px 0 rgba(255,255,255,.7) inset; }
.dhv-tabs .dhv-tab.is-on { background: linear-gradient(180deg, #4a4034, #3a3228); color: #f6f1e6; border-color: #3a3228; }
.dhv-tabs .dhv-tab .n { opacity: .7; margin-left: 4px; }

.dhv-btn { flex: none; position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box; cursor: pointer;
  font-family: var(--dhud-ui, "Signika", sans-serif); white-space: nowrap; user-select: none; pointer-events: auto; }
.dhv-btn .k { font: 700 9.5px var(--dhud-ui, "Signika", sans-serif); letter-spacing: .04em; text-transform: none; padding: 1px 4px; border-radius: 3px; }
/* Back: a small parchment plaque. */
.dhv-btn.back { height: 24px; padding: 0 9px 0 7px; border-radius: 6px; font-size: 11.5px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: #6a5d4c;
  background: linear-gradient(180deg, #fbf6ea, #e6dbc2); border: 1.5px solid rgba(122,106,85,.7); box-shadow: 0 1px 0 rgba(255,255,255,.8) inset, 0 1px 2px rgba(58,50,40,.18); }
.dhv-btn.back::before { content: "‹"; font-size: 16px; line-height: 1; margin-top: -2px; color: #7a6a55; }
.dhv-btn.back .k { color: #9a8d76; background: rgba(58,50,40,.07); }
.dhv-btn.back:hover { color: #3a3228; border-color: #7a6a55; }
/* Confirm: garnet; it breathes only when pressing it will work. */
.dhv-btn.go { height: 32px; min-width: 132px; padding: 0 8px 0 16px; border-radius: 8px; font-size: 15px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: var(--dhv-cta-ink);
  background: linear-gradient(180deg, var(--dhv-cta-a), var(--dhv-cta-b) 60%, var(--dhv-cta-c)); border: 2px solid var(--dhv-cta-rim);
  box-shadow: 0 0 0 1px rgba(255,220,180,.35) inset, 0 2px 0 rgba(255,255,255,.18) inset, 0 0 14px 2px rgba(222,66,46,.5);
  text-shadow: 0 1px 0 rgba(60,8,4,.6); animation: dhvGoBreath 3.4s ease-in-out infinite alternate; }
.dhv-btn.go::after { content: ""; position: absolute; left: 6px; right: 6px; top: 3px; height: 40%; border-radius: 5px 5px 10px 10px; background: linear-gradient(180deg, rgba(255,255,255,.22), transparent); pointer-events: none; }
.dhv-btn.go .gl { flex: 1; text-align: center; }
.dhv-btn.go .k { background: var(--dhv-cta-ink); color: var(--dhv-cta-c); font-size: 10px; padding: 2px 5px; text-shadow: none; }
.dhv-btn.go:hover { filter: brightness(1.07); }
.dhv-btn.go:active { transform: translateY(1px); }
.dhv-btn.go.is-off { color: #8a7d68; background: linear-gradient(180deg, #ece5d5, #ddd3bf); border-color: rgba(122,106,85,.6); box-shadow: 0 0 0 1px rgba(255,255,255,.55) inset;
  text-shadow: none; animation: none; cursor: not-allowed; filter: none; transform: none; }
.dhv-btn.go.is-off::after { display: none; }
.dhv-btn.go.is-off .k { background: rgba(58,50,40,.12); color: #8a7d68; }
@keyframes dhvGoBreath {
  from { box-shadow: 0 0 0 1px rgba(255,220,180,.35) inset, 0 2px 0 rgba(255,255,255,.18) inset, 0 0 10px 1px rgba(222,66,46,.45); }
  to   { box-shadow: 0 0 0 1px rgba(255,220,180,.35) inset, 0 2px 0 rgba(255,255,255,.18) inset, 0 0 18px 4px rgba(232,72,50,.66); }
}

/* Lists: two columns, 27 px rows (the secondary commands' height). */
.dhv-list { position: relative; flex: 1 1 auto; min-width: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #b7935a transparent; padding-right: 4px;
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 14px; row-gap: 3px; align-content: start; }
.dhv-list.is-one { grid-template-columns: minmax(0, 1fr); max-width: 330px; }
.dhv-list.is-more { mask-image: linear-gradient(180deg, #000 78%, rgba(0,0,0,.25)); -webkit-mask-image: linear-gradient(180deg, #000 78%, rgba(0,0,0,.25)); }
.dhv-sec { grid-column: 1 / -1; height: 14px; display: flex; align-items: flex-end; gap: 6px; font: 800 9.5px var(--dhud-ui, "Signika", sans-serif); letter-spacing: .1em; text-transform: uppercase; color: #7a6a55; padding-left: 4px; }
.dhv-sec .h { font-weight: 600; letter-spacing: .02em; text-transform: none; color: #8a7d68; }
.dhv-empty { grid-column: 1 / -1; font: italic 600 12.5px var(--dhud-ui, "Signika", sans-serif); color: #8a7d68; padding: 6px 4px; }
.dhv-row { position: relative; cursor: pointer; display: grid; grid-template-columns: 12px 20px minmax(0, 1fr) auto; align-items: center; column-gap: 7px; height: 27px; padding: 0 6px 0 3px;
  border-radius: 7px; font: 700 14px var(--dhud-ui, "Signika", sans-serif); white-space: nowrap; }
.dhv-row.no-icon { grid-template-columns: 12px minmax(0, 1fr) auto; }
.dhv-row .cur, .dhv-tile .cur, .dhv-trow .cur { color: #b7935a; font-size: 11px; visibility: hidden; }
.dhv-row .nm { overflow: hidden; text-overflow: ellipsis; }
.dhv-row .nm .source-tag { font-size: 11px; }
.dhv-row.is-dis { color: rgba(58,50,40,.48); }
.dhv-row.is-dis .dhv-ic { filter: grayscale(1) opacity(.6); }
.dhv-row.is-cur, .dhv-tile.is-cur, .dhv-trow.is-cur { background: linear-gradient(180deg,#fef5dc,#ebd9a6); box-shadow: 0 0 0 1px rgba(90,62,28,.55) inset, inset 3px 0 0 #b7935a; }
.dhv-row.is-cur .cur, .dhv-tile.is-cur .cur, .dhv-trow.is-cur .cur { visibility: visible; }
.dhv-list > .dhv-row + .dhv-row::before { content: ""; position: absolute; left: 6px; right: 6px; top: -2px; height: 1px; pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(122,106,85,.42) 10%, rgba(122,106,85,.42) 90%, transparent); }
.dhv-row.is-cur::before, .dhv-row.is-cur + .dhv-row::before { display: none; }
.dhv-row .chk { position: absolute; right: 4px; top: 50%; width: 10px; height: 10px; margin-top: -5px; transform: rotate(45deg); border: 1.5px solid #7a6a55; border-radius: 2px; box-sizing: border-box; }
.dhv-row.is-multi { padding-right: 22px; }
.dhv-row.is-picked .chk { background: #e0a526; border-color: #8a5a18; box-shadow: 0 0 6px rgba(224,165,38,.8); }
.dhv-ic { width: 20px; height: 20px; border-radius: 4px; display: grid; place-items: center; overflow: hidden; box-shadow: 0 0 0 1px rgba(58,50,40,.35); flex: none; background: #3a3228; color: #f6f1e6; font-size: 11px; }
.dhv-ic img { width: 100%; height: 100%; display: block; object-fit: cover; border: none !important; }
.dhv-chips { display: flex; gap: 4px; min-width: 0; }
.dhv-chip { font: 800 10.5px/16px var(--dhud-ui, "Signika", sans-serif); padding: 0 6px; border-radius: 4px; background: rgba(58,50,40,.09); color: #3a3228; letter-spacing: .02em; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.dhv-chip.t-free { background: rgba(47,125,79,.14); color: #2f7d4f; }
.dhv-chip.t-danger { background: rgba(179,38,30,.12); color: #b3261e; }
.dhv-chip.t-warning { background: rgba(232,164,58,.2); color: #8a5512; }
.dhv-chip.t-swap { background: rgba(179,38,30,.2); color: #8e2219; }
.dhv-chip.t-tag { background: transparent; box-shadow: inset 0 0 0 1px rgba(122,106,85,.5); color: #6a5d4c; }
.dhv-chip.t-mp { background: rgba(46,123,214,.14); color: #1f5aa0; }
.dhv-chip.t-ip { background: rgba(232,164,58,.2); color: #8a5512; }

/* Tiles: one to three plain choices. */
.dhv-tiles { flex: 1 1 auto; display: grid; grid-template-columns: repeat(var(--n, 2), minmax(0, 1fr)); gap: 10px; align-content: center; }
.dhv-tile { position: relative; cursor: pointer; display: grid; grid-template-columns: 12px 30px minmax(0,1fr); column-gap: 8px; align-items: center; padding: 9px 10px 9px 4px; border-radius: 8px; box-shadow: inset 0 0 0 1px rgba(122,106,85,.35); min-width: 0; }
.dhv-tile.no-icon { grid-template-columns: 12px minmax(0,1fr); }
.dhv-tile .dhv-ic { width: 30px; height: 30px; border-radius: 50%; }
.dhv-tile .t { font: 800 14.5px var(--dhud-ui, "Signika", sans-serif); letter-spacing: .05em; text-transform: uppercase; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dhv-tile .s { font: 600 11.5px/1.3 var(--dhud-ui, "Signika", sans-serif); color: #6a5d4c; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dhv-tile .n { position: absolute; right: 9px; top: 6px; font: 800 10px var(--dhud-ui, "Signika", sans-serif); color: #a3967f; }
.dhv-tile.is-dis { opacity: .55; cursor: not-allowed; }

/* Targets: Enemies | Allies columns. */
.dhv-tcols { flex: 1 1 auto; display: flex; gap: 14px; min-width: 0; }
.dhv-tcol { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #b7935a transparent; }
.dhv-tcol .dhv-sec { flex: none; height: 13px; }
.dhv-tcol .none { font: italic 600 12.5px/1.35 var(--dhud-ui, "Signika", sans-serif); color: #8a7d68; padding: 6px; }
.dhv-trow { position: relative; flex: none; cursor: pointer; display: grid; grid-template-columns: 14px 22px minmax(0,1fr) 92px; align-items: center; column-gap: 7px; height: 25px; padding: 0 6px 0 4px;
  border-radius: 7px; font: 700 13.5px var(--dhud-ui, "Signika", sans-serif); white-space: nowrap; }
.dhv-trow .nm { overflow: hidden; text-overflow: ellipsis; }
.dhv-dia { width: 10px; height: 10px; transform: rotate(45deg); border: 1.5px solid #7a6a55; border-radius: 2px; box-sizing: border-box; justify-self: center; }
.dhv-trow.is-sel .dhv-dia { background: #e0a526; border-color: #8a5a18; box-shadow: 0 0 6px rgba(224,165,38,.8); }
.dhv-trow.is-lock .dhv-dia { background: #b7935a; border-color: #7a6a55; }
.dhv-face { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; object-position: 50% 18%; box-shadow: 0 0 0 1.5px rgba(58,50,40,.55); background: #d9c9a8; border: none !important; }
.dhv-thp { display: grid; gap: 1px; font: 700 10.5px/1 var(--dhud-ui, "Signika", sans-serif); font-variant-numeric: tabular-nums; color: #6a5d4c; text-align: right; }
.dhv-thp i { display: block; height: 5px; border-radius: 3px; background: rgba(58,50,40,.2); overflow: hidden; }
.dhv-thp i b { display: block; height: 100%; background: linear-gradient(90deg, #6bd66b, #2fbf71); }
.dhv-trow.is-excl { color: rgba(58,50,40,.45); cursor: not-allowed; }
.dhv-trow.is-excl .dhv-face { filter: grayscale(1) opacity(.6); }
.dhv-trow .why { font: 700 10.5px var(--dhud-ui, "Signika", sans-serif); color: #b3261e; text-align: right; overflow: hidden; text-overflow: ellipsis; }

/* Replace a die: one line per die, its choices as buttons. */
.dhv-dice { flex: 1 1 auto; display: grid; gap: 8px; align-content: center; }
.dhv-dline { display: grid; grid-template-columns: 104px minmax(0,1fr); align-items: center; column-gap: 10px; }
.dhv-dline .dl { font: 800 10px var(--dhud-ui, "Signika", sans-serif); letter-spacing: .08em; text-transform: uppercase; color: #7a6a55; line-height: 1.2; }
.dhv-dline .dl b { display: block; font-size: 15px; letter-spacing: .04em; color: #3a3228; }
.dhv-dchoices { display: flex; gap: 6px; flex-wrap: wrap; min-width: 0; }
.dhv-dch { cursor: pointer; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border-radius: 7px; box-shadow: inset 0 0 0 1px rgba(122,106,85,.4); font: 800 13px var(--dhud-ui, "Signika", sans-serif); white-space: nowrap; }
.dhv-dch small { font: 600 11px var(--dhud-ui, "Signika", sans-serif); color: #6a5d4c; }
.dhv-dch.is-pick { background: #3a3228; color: #f6f1e6; box-shadow: none; }
.dhv-dch.is-pick small { color: #d5b67a; }
.dhv-dch.is-cur:not(.is-pick) { background: linear-gradient(180deg,#fef5dc,#ebd9a6); box-shadow: 0 0 0 1px rgba(90,62,28,.55) inset; }
.dhv-dch.is-cur.is-pick { box-shadow: 0 0 0 2px #d5b67a; }
.dhv-dch.is-dis { opacity: .45; cursor: not-allowed; }

/* A number: the value big on the left, a strip of values with - / +. */
.dhv-num { flex: 1 1 auto; display: grid; grid-template-columns: auto minmax(0,1fr); align-items: center; column-gap: 18px; }
.dhv-nlab { font: 800 10px var(--dhud-ui, "Signika", sans-serif); letter-spacing: .08em; text-transform: uppercase; color: #7a6a55; line-height: 1.3; max-width: 180px; }
.dhv-nlab b { display: block; font-size: 30px; line-height: 1.1; letter-spacing: 0; color: #3a3228; font-variant-numeric: tabular-nums; }
.dhv-strip { display: flex; align-items: center; gap: 6px; }
.dhv-step { width: 30px; height: 30px; border-radius: 7px; border: 1px solid rgba(122,106,85,.5); background: rgba(58,50,40,.06); font: 800 16px/28px var(--dhud-ui, "Signika", sans-serif); text-align: center; color: #3a3228; cursor: pointer; box-sizing: border-box; }
.dhv-nums { flex: 1; display: flex; justify-content: space-between; align-items: center; height: 46px; padding: 0 8px; border-radius: 8px; background: rgba(58,50,40,.07); box-shadow: inset 0 0 0 1px rgba(122,106,85,.3); }
.dhv-nums span { font: 800 15px var(--dhud-ui, "Signika", sans-serif); color: #8a7d68; font-variant-numeric: tabular-nums; cursor: pointer; min-width: 26px; text-align: center; }
.dhv-typed { display: block; width: max-content; margin-top: 3px; padding: 1px 6px; border-radius: 4px; font: 700 10.5px var(--dhud-ui, "Signika", sans-serif); letter-spacing: .06em; text-transform: none; color: #8e2219; background: rgba(196,71,58,.12); }
.dhv-nums span.is-on { color: #f6f1e6; background: linear-gradient(180deg, #5aa8ff, #2e7bd6); border-radius: 6px; padding: 5px 7px; font-size: 19px; }

/* ── Skill card: the plate's portrait card, turned over ── */
.dhud-unit .dhud-pcard.dhud-pcard.is-skill { left: -268px; width: 324px; height: 380px; transform: none; animation: none; transform-origin: bottom right; }
.dhud-pcard .dhv-sface { display: none; }
.dhud-pcard.is-skill > .art { display: none; }
.dhud-pcard.is-skill .dhv-sface {
  position: relative; display: flex; flex-direction: column; box-sizing: border-box; width: 100%; height: 100%; overflow: hidden;
  border: 2px solid #b7935a; border-radius: 7px; padding: 10px 12px 18px;
  background: radial-gradient(120% 60% at 50% 0%, #fffaf0, transparent 70%), linear-gradient(180deg, #fbf6ea, #efe5cf);
  font-family: var(--dhud-ui, "Signika", sans-serif); color: #3a3228; pointer-events: auto;
}
.dhud-pcard.is-skill .dhv-sface::after { content: ""; position: absolute; inset: 3px; border: 1px solid rgba(183,147,90,.45); border-radius: 5px; pointer-events: none; }
.dhv-shead { display: grid; grid-template-columns: 46px minmax(0,1fr); column-gap: 10px; align-items: center; }
.dhv-shead .dhv-ic { width: 46px; height: 46px; border-radius: 9px; box-shadow: 0 0 0 2px #b7935a, 0 2px 6px rgba(0,0,0,.25); font-size: 20px; }
.dhv-sname { font: 800 18px/1.15 var(--dhud-ui, "Signika", sans-serif); letter-spacing: .01em; text-wrap: balance; overflow-wrap: anywhere; }
.dhv-sfrom { font: 800 9.5px/1.3 var(--dhud-ui, "Signika", sans-serif); letter-spacing: .12em; text-transform: uppercase; color: #9a8d76; }
.dhv-schips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 9px; }
.dhv-schips .dhv-chip { font-size: 11px; line-height: 18px; padding: 0 7px; max-width: none; }
.dhv-srule { flex: none; height: 1px; margin: 9px 0 7px; background: linear-gradient(90deg, transparent, #b7935a 12%, #b7935a 88%, transparent); }
.dhv-swhy { flex: none; margin-bottom: 6px; padding: 4px 8px; border-radius: 6px; background: rgba(179,38,30,.1); box-shadow: inset 0 0 0 1px rgba(179,38,30,.35); font: 700 12.5px/1.3 var(--dhud-ui, "Signika", sans-serif); color: #b3261e; }
.dhv-sbody { flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #b7935a transparent; padding-right: 4px; font: 400 13.5px/19px var(--dhud-ui, "Signika", sans-serif); color: #3a3228; }
.dhv-sbody.is-more { mask-image: linear-gradient(180deg, #000 82%, transparent); -webkit-mask-image: linear-gradient(180deg, #000 82%, transparent); }
.dhv-sbody p { margin: 0 0 6px; }
.dhv-sbody .enh { font-size: 12px; line-height: 17px; color: #6a5d4c; font-style: italic; }
.dhv-sbody .in { animation: dhvText 120ms ease-out; }
@keyframes dhvText { from { opacity: .35; } to { opacity: 1; } }
.dhud-pcard.is-skill .dhud-pname { font-size: 11.5px; padding: 3px 14px; }
.dhud-take .face-tab .dhv-dimc { color: rgba(213,182,122,.62); }
/* A reaction has the drawer: the tab turns garnet and breathes, because it waits for you. */
.dhud-unit.is-open.is-react .dhud-take {
  color: #fff3e6; background: linear-gradient(180deg, #c4473a, #8e2219 60%, #741a14); border-color: #e2c27e;
  clip-path: polygon(-40px -40px, calc(100% + 40px) -40px, calc(100% + 40px) calc(100% - 4px), 100% calc(100% - 4px), 100% 100%, 0 100%, 0 calc(100% - 4px), -40px calc(100% - 4px));
  animation: dhudTakeGlow 3.4s ease-in-out infinite alternate;
}
.dhud-unit.is-open.is-react .dhud-take::before { opacity: 0; }
.dhud-unit.is-open.is-react .dhud-take .face-tab { color: #fff3e6; }
@media (prefers-reduced-motion: reduce) { .dhv-view.is-in .dhv-main, .dhv-sbody .in { animation: none; } }

/* The command window docked: its help line becomes the same footer. */
.fud-octopath.is-docked .cmd-window { padding: 14px 18px 6px; }
.fud-octopath.is-docked .cmd-body { height: 117px; }
.fud-octopath.is-docked .cmd-foot .cmd-help { flex: 1 1 auto; min-width: 0; height: auto; margin: 0; padding: 0; border: 0; }
.fud-octopath .cmd-foot .dhv-btn { display: none; }
.fud-octopath.is-docked .cmd-foot .dhv-btn { display: inline-flex; }
.fud-octopath:not(.is-docked) .cmd-foot { display: contents; }
`;
  document.head.appendChild(st);
}

// ── footer ───────────────────────────────────────────────────────────────────
export function footerHTML({ text = "", hints = "", tabs = "", back = "Back", backKey = "Esc", go = "Confirm", goOk = true }) {
  return `<div class="dhv-foot">${tabs}<span class="dhv-ftxt">${text}</span>${hints ? `<span class="dhv-hints">${escapeHtml(hints)}</span>` : ""}`
    + (back ? `<span class="dhv-btn back" role="button" data-dhv="back">${escapeHtml(back)}<span class="k">${escapeHtml(backKey)}</span></span>` : "")
    + `<span class="dhv-btn go${goOk ? "" : " is-off"}" role="button" data-dhv="go" aria-disabled="${!goOk}"><span class="gl">${escapeHtml(go)}</span><span class="k">Enter</span></span></div>`;
}
export function goButtonHTML(label = "Select") {
  return `<span class="dhv-btn go" role="button" data-dhv="go"><span class="gl">${escapeHtml(label)}</span><span class="k">Enter</span></span>`;
}

// ── skill card (portrait card flip) ──────────────────────────────────────────
// entry: { key, name, kind, img, iconHTML, chips:[{text,tone}], body, reason } | null
// Portrait <-> description always FLIPS. `quiet` decides a description ->
// description swap: a short cross-fade (the reaction hand's hover, where the
// pointer runs across several cards) instead of the instant text swap.
const FLIP_OUT_MS = 100, FLIP_IN_MS = 160, GLINT_MS = 420, QUIET_MS = 140;
// The parts of a description face that carry its words (cardFaceHTML).
const FACE_PARTS = [".dhv-shead", ".dhv-schips", ".dhv-swhy", ".dhv-sbody .in"];
export function setPlateCard(host, entry, { quiet = false } = {}) {
  const pcard = host?.pcard;
  if (!pcard?.isConnected) return;
  ensureDrawerStyles();
  const want = entry ? "skill" : "portrait";
  const key = entry ? String(entry.key ?? entry.name ?? "") : null;
  const pname = pcard.querySelector(".dhud-pname");
  if (pname && pcard._pnameHTML == null) pcard._pnameHTML = pname.innerHTML;
  let face = pcard.querySelector(".dhv-sface");
  if (!face) { face = document.createElement("div"); face.className = "dhv-sface"; pcard.appendChild(face); }

  // The LATEST request wins. A second call that lands during the flip-out (two
  // quick hovers) must not be overwritten when that flip finishes: onfinish
  // reads pcard._entry / pcard._mode, never this call's closure.
  pcard._entry = entry;
  const fill = (entry) => {
    if (entry) {
      face.innerHTML = cardFaceHTML(entry);
      const body = face.querySelector(".dhv-sbody");
      const upd = () => body?.classList.toggle("is-more", body.scrollTop + body.clientHeight < body.scrollHeight - 2);
      body?.addEventListener("scroll", upd);
      requestAnimationFrame(upd);
      if (pname) pname.textContent = entry.kind || "";
    } else if (pname && pcard._pnameHTML != null) {
      pname.innerHTML = pcard._pnameHTML;
    }
  };
  if (pcard._mode === want || (!pcard._mode && want === "portrait")) {
    if (key !== pcard._key) {
      // The card stays; only what differs between the two descriptions fades in
      // (name, chips, reason, rules text) — the rule line and frame are the card.
      const fadeIn = quiet && want === "skill" && !pcard._flip?.playState?.match?.(/running/);
      const before = fadeIn ? FACE_PARTS.map((sel) => face.querySelector(sel)?.innerHTML ?? null) : null;
      fill(entry); pcard._key = key;
      if (fadeIn) {
        FACE_PARTS.forEach((sel, i) => {
          const el = face.querySelector(sel);
          if (el && el.innerHTML !== before[i]) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: QUIET_MS, easing: "ease-out" });
        });
      }
    }
    pcard._mode = want;
    return;
  }
  pcard._mode = want; pcard._key = key;
  try { pcard._flip?.cancel(); } catch {}
  const out = pcard.animate(
    [{ transform: "perspective(900px) rotateY(0deg)" }, { transform: "perspective(900px) rotateY(90deg)" }],
    { duration: FLIP_OUT_MS, easing: "cubic-bezier(.55,0,1,.45)", fill: "forwards", composite: "add" });
  pcard._flip = out;
  out.onfinish = () => {
    if (pcard._flip !== out) return;
    pcard.classList.toggle("is-skill", pcard._mode === "skill");
    fill(pcard._entry);
    const inn = pcard.animate([
      { transform: "perspective(1200px) rotateY(-90deg)", offset: 0 },
      { transform: "perspective(1200px) rotateY(9deg)", offset: 0.68 },
      { transform: "perspective(1200px) rotateY(0deg)", offset: 1 },
    ], { duration: FLIP_IN_MS, easing: "cubic-bezier(.2,.75,.35,1)", composite: "add" });
    pcard._flip = inn;
    out.cancel();
    try {
      // Same shadow COUNT at both ends, or box-shadow can't interpolate and the
      // glow snaps off halfway instead of fading. The glow layers fade to clear
      // on top of the card's own shadow, which stays put.
      const own = getComputedStyle(pcard).boxShadow;
      const base = own && own !== "none" ? own : "0 0 0 0 rgba(0,0,0,0)";
      pcard.animate([
        { boxShadow: `0 0 0 2px rgba(255,243,196,1), 0 0 26px 8px rgba(255,214,120,.9), ${base}` },
        { boxShadow: `0 0 0 2px rgba(255,243,196,0), 0 0 26px 8px rgba(255,214,120,0), ${base}` },
      ], { duration: GLINT_MS, delay: 110, easing: "ease-out", fill: "backwards" });
    } catch { /* cosmetic */ }
  };
}
function cardFaceHTML(e) {
  const ic = e.img ? `<span class="dhv-ic"><img src="${escapeHtml(e.img)}" alt=""></span>` : `<span class="dhv-ic">${e.iconHTML ?? ""}</span>`;
  const seen = new Set();
  const chips = (e.chips ?? []).filter((c) => c?.text && !seen.has(c.text) && seen.add(c.text))
    .map((c) => `<span class="dhv-chip t-${escapeHtml(c.tone || "tag")}">${escapeHtml(c.text)}</span>`).join("");
  const paras = String(e.body || "").split("\n").filter(Boolean)
    .map((l) => `<p${/^Skill Enhancement/i.test(l) ? ' class="enh"' : ""}>${escapeHtml(l)}</p>`).join("");
  return `<div class="dhv-shead">${ic}<div style="min-width:0">${e.from ? `<div class="dhv-sfrom">From ${escapeHtml(e.from)}</div>` : ""}<div class="dhv-sname">${escapeHtml(e.name)}</div></div></div>
    ${chips ? `<div class="dhv-schips">${chips}</div>` : ""}<div class="dhv-srule"></div>
    ${e.reason ? `<div class="dhv-swhy">${escapeHtml(e.reason)}</div>` : ""}
    <div class="dhv-sbody"><div class="in">${paras || `<p class="enh">No description.</p>`}</div></div>`;
}
export function scrollPlateCard(host, dir) {
  const body = host?.pcard?.querySelector(".dhv-sbody");
  if (!body || !host.pcard.classList.contains("is-skill")) return false;
  body.scrollTop += dir * Math.max(40, body.clientHeight - 30);
  return true;
}

// ── list rows → view model ───────────────────────────────────────────────────
const TONE = { free: "free", danger: "danger", warning: "warning", swap: "swap" };
function rowChips(r) {
  return [
    ...(Array.isArray(r.badges) ? r.badges : []).filter((b) => b && b.text).map((b) => ({ html: b.text, tone: TONE[b.tone] ?? "" })),
    ...(r.badge ? [{ html: r.badge, tone: TONE[r.badgeTone] ?? "" }] : []),
  ];
}
function rowReason(r) {
  if (!r.disabled) return null;
  if (r.stamp) return stripTags(r.stamp);
  const danger = rowChips(r).filter((c) => c.tone === "danger").map((c) => stripTags(c.html));
  if (danger.length) return danger[danger.length - 1];
  const m = /—\s*([^<]+)<\/span>\s*$/.exec(String(r.secondary ?? ""));
  return m ? m[1].trim() : "Not available right now.";
}
function rowCardEntry(r, kind) {
  const tip = r.tooltip;
  const tipObj = tip && typeof tip === "object" ? tip : null;
  const name = tipObj?.name ?? stripTags(r.primary);
  const body = htmlToCardText(r.cardHtml ?? "")
    || (tipObj?.body ? String(tipObj.body) : "")
    || (typeof tip === "string" ? htmlToCardText(tip) : "")
    || stripTags(r.secondary);
  const chips = [
    ...secondaryParts(r.secondary).map((t) => ({ text: t, tone: "tag" })),
    ...rowChips(r).map((c) => ({ text: stripTags(c.html), tone: c.tone || (/\bMP\b/.test(c.html) ? "mp" : /\bIP\b/.test(c.html) ? "ip" : "") })),
  ];
  if (tipObj?.cost && !chips.some((c) => c.text === tipObj.cost)) chips.push({ text: String(tipObj.cost), tone: /\bMP\b/.test(tipObj.cost) ? "mp" : "" });
  let reason = rowReason(r);
  if (tipObj?.missing) reason = `${reason ? `${reason}. ` : ""}Missing ${tipObj.missing}`;
  return { key: `${kind}|${name}|${JSON.stringify(r.value ?? null).slice(0, 80)}`, name, kind, img: r.imageUrl ?? null, iconHTML: r.fallbackIcon ?? "", chips, body, reason };
}
function rowSummary(r) {
  if (r.disabled) return `<span class="bad">${escapeHtml(rowReason(r))}</span>`;
  const parts = secondaryParts(r.secondary);
  if (parts.length) return escapeHtml(parts.join(" · "));
  const tip = r.tooltip;
  return escapeHtml(stripTags(typeof tip === "string" ? tip : tip?.body ?? "").slice(0, 160));
}
function sameValue(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

// ── docked list ──────────────────────────────────────────────────────────────
/**
 * Draw a list picker inside the held drawer. Same contract as pickFromList:
 * resolves with the row's value (an array when multiSelect), or null on Back.
 * Returns { promise, cleanup }.
 */
export function pickDocked(host, {
  title = "Choose", crumb = null, groups, tabbed = false, multiSelect = false, maxSelect = 0,
  preselectAll = false, preselect = null, confirmLabel = null, cancelLabel = "Cancel", verb = null,
  onFocusRow = null, focusValue = null, numberShortcuts = true, externalCancel = null, onDone = null,
  contextCard = null,
} = {}) {
  ensureDrawerStyles();
  const flat = [], secOf = [];
  // A choice inside a skill (Fire or Ice, an element, a menu option) usually
  // has no text of its own: the card then shows the skill it belongs to.
  const ctxEntry = contextCard?.name ? {
    key: `ctx|${contextCard.name}`, kind: "context", name: String(contextCard.name), from: String(contextCard.name),
    img: contextCard.img ?? null, iconHTML: "", chips: [], body: htmlToCardText(String(contextCard.body ?? "")) || "", reason: "",
  } : null;
  groups.forEach((g, si) => (g.items ?? []).forEach((r) => { flat.push(r); secOf.push(si); }));
  const useTabs = tabbed && groups.length >= 2;
  const tiles = !useTabs && !multiSelect && groups.length === 1 && flat.length >= 1 && flat.length <= 3 && !groups[0].label;
  const goLabel = verb ?? (multiSelect ? (confirmLabel ?? "Confirm") : "Confirm");
  const backLabel = cancelLabel && !/^cancel$/i.test(cancelLabel) ? cancelLabel : "Back";
  const tab = crumb ?? String(title ?? "").replace(/^choose\s+(an?\s+)?/i, "").replace(/['’]s attack$/i, " · Attack");
  host.setCrumb?.(tab);

  let activeTab = useTabs ? Math.max(0, groups.findIndex((g) => (g.items ?? []).length > 0)) : 0;
  const inTab = (i) => !useTabs || secOf[i] === activeTab;
  let cur = flat.findIndex((r, i) => inTab(i) && focusValue != null && sameValue(r.value, focusValue));
  if (cur < 0) cur = flat.findIndex((r, i) => inTab(i) && !r.disabled);
  if (cur < 0) cur = flat.findIndex((_, i) => inTab(i));
  const picked = new Set();
  if (multiSelect) {
    const want = flat.map((r, i) => i).filter((i) => !flat[i].disabled && (preselectAll || (Array.isArray(preselect) && preselect.some((v) => sameValue(v, flat[i].value)))));
    for (const i of want) { if (maxSelect > 0 && picked.size >= maxSelect) break; picked.add(i); }
  }

  const view = document.createElement("div");
  view.className = "dhv-view is-in";
  let resolved = false, resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  try { Hooks.callAll("fud.actionPickerOpen"); } catch {}

  const rowHTML = (r, i) => {
    const icon = r.imageUrl ? `<span class="dhv-ic"><img src="${escapeHtml(r.imageUrl)}" alt=""></span>` : (r.fallbackIcon ? `<span class="dhv-ic">${r.fallbackIcon}</span>` : "");
    const chips = r.disabled ? [{ html: escapeHtml(shortReason(rowReason(r))), tone: "danger" }] : rowChips(r);
    return `<div class="dhv-row${icon ? "" : " no-icon"}${i === cur ? " is-cur" : ""}${r.disabled ? " is-dis" : ""}${multiSelect ? " is-multi" : ""}${picked.has(i) ? " is-picked" : ""}" data-i="${i}">`
      + `<span class="cur">▶</span>${icon}<span class="nm">${r.primary ?? ""}</span>`
      + `<span class="dhv-chips">${chips.map((c) => `<span class="dhv-chip t-${c.tone || "x"}">${c.html}</span>`).join("")}</span>`
      + (multiSelect ? `<span class="chk"></span>` : "") + `</div>`;
  };
  const tileHTML = (r, i) => {
    const icon = r.imageUrl ? `<span class="dhv-ic"><img src="${escapeHtml(r.imageUrl)}" alt=""></span>` : (r.fallbackIcon ? `<span class="dhv-ic">${r.fallbackIcon}</span>` : "");
    return `<div class="dhv-tile${icon ? "" : " no-icon"}${i === cur ? " is-cur" : ""}${r.disabled ? " is-dis" : ""}" data-i="${i}"><span class="cur">▶</span>${icon}`
      + `<div style="min-width:0"><div class="t">${r.primary ?? ""}</div>${r.secondary ? `<div class="s">${r.secondary}</div>` : ""}</div><span class="n">${i + 1}</span></div>`;
  };
  function mainHTML() {
    if (tiles) return `<div class="dhv-tiles" style="--n:${flat.length}">${flat.map(tileHTML).join("")}</div>`;
    let html = "";
    groups.forEach((g, si) => {
      if (useTabs && si !== activeTab) return;
      const idxs = flat.map((_, i) => i).filter((i) => secOf[i] === si);
      if (g.label && !useTabs) html += `<div class="dhv-sec">${g.label}${g.hint ? `<span class="h">${g.hint}</span>` : ""}</div>`;
      if (!idxs.length) html += `<div class="dhv-empty">${escapeHtml(g.emptyText ?? "Nothing here.")}</div>`;
      for (const i of idxs) html += rowHTML(flat[i], i);
    });
    const one = flat.length <= 3 && !useTabs;
    return `<div class="dhv-list${one ? " is-one" : ""}" data-dhv-list>${html}</div>`;
  }
  function footHTML() {
    const r = flat[cur];
    const tabsHTML = useTabs ? `<span class="dhv-tabs">${groups.map((g, si) => `<span class="dhv-tab${si === activeTab ? " is-on" : ""}" role="button" data-tab="${si}">${g.label ?? `Tab ${si + 1}`}${g.hint ? `<span class="n">${g.hint}</span>` : ""}</span>`).join("")}</span>` : "";
    const goOk = multiSelect ? true : !!r && !r.disabled;
    const text = multiSelect
      ? `<span class="cnt">${picked.size}${maxSelect > 0 ? ` / ${maxSelect}` : ""}</span> picked${r ? ` · ${rowSummary(r)}` : ""}`
      : (r ? rowSummary(r) : "");
    const hints = multiSelect ? "Space picks" : useTabs ? "Tab switches" : "";
    return footerHTML({ text: useTabs && !multiSelect ? "" : text, hints, tabs: tabsHTML, back: backLabel, go: goLabel, goOk });
  }
  function paint({ fresh = false } = {}) {
    if (resolved) return;
    const prev = view.querySelector("[data-dhv-list]")?.scrollTop ?? 0;
    view.innerHTML = `<div class="dhv-main">${mainHTML()}</div>${footHTML()}`;
    const list = view.querySelector("[data-dhv-list]");
    if (list) {
      list.scrollTop = fresh ? 0 : prev;
      const more = () => list.classList.toggle("is-more", list.scrollTop + list.clientHeight < list.scrollHeight - 2);
      list.addEventListener("scroll", more);
      if (fresh || true) ensureVisible(list);
      more();
    }
    const r = flat[cur];
    // A plain option with no picture and no text (a menu's "Create a new
    // Phantasm") gets the card of the skill it belongs to when there is one,
    // else no card. Never the previous row's: that described another option.
    const entry = r ? rowCardEntry(r, (useTabs ? groups[activeTab]?.label : groups[secOf[cur]]?.label) || tab) : null;
    const worthACard = entry && (entry.img || (entry.body && entry.body !== entry.name && entry.body.length > 24));
    host.setCard?.(worthACard ? entry : ctxEntry && r ? { ...ctxEntry, key: `${ctxEntry.key}|${cur}`, name: stripTags(r.primary) || ctxEntry.from } : ctxEntry);
    try { onFocusRow?.(r ?? null); } catch (e) { warn("drawer list: onFocusRow threw", e); }
  }
  function ensureVisible(list) {
    const el = list.querySelector(".dhv-row.is-cur");
    if (!el) return;
    if (el.offsetTop - 16 < list.scrollTop) list.scrollTop = Math.max(0, el.offsetTop - 16);
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
  }
  function setCur(i, { sfx = true } = {}) {
    if (i == null || i < 0 || i >= flat.length || i === cur) return;
    cur = i;
    if (sfx) playUiHoverSfx();
    paint();
  }
  // Geometric arrow navigation over the rendered rows/tiles.
  function move(dx, dy) {
    const els = [...view.querySelectorAll("[data-i]")];
    const me = els.find((e) => Number(e.dataset.i) === cur);
    if (!me) { if (els[0]) setCur(Number(els[0].dataset.i)); return; }
    const a = me.getBoundingClientRect();
    let best = null, bestD = Infinity;
    for (const e of els) {
      if (e === me) continue;
      const b = e.getBoundingClientRect();
      const ddx = (b.left + b.width / 2) - (a.left + a.width / 2), ddy = (b.top + b.height / 2) - (a.top + a.height / 2);
      if (dy && Math.sign(ddy) !== dy) continue;
      if (dy && Math.abs(ddy) < 4) continue;
      if (dx && (Math.sign(ddx) !== dx || Math.abs(ddy) > 4)) continue;
      const d = dy ? Math.abs(ddy) * 4 + Math.abs(ddx) : Math.abs(ddx);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best) setCur(Number(best.dataset.i));
  }
  function finish(value, cancelled = false) {
    if (resolved) return;
    resolved = true;
    try { window.removeEventListener("keydown", onKey, true); } catch {}
    view.inert = true;
    try { onFocusRow?.(null); } catch {}
    try { Hooks.callAll("fud.actionPickerClose"); } catch {}
    try { onDone?.(cancelled); } catch {}
    resolveFn(cancelled ? null : value);
  }
  function choose() {
    if (multiSelect) { playUiClickSfx(); finish([...picked].sort((a, b) => a - b).map((i) => flat[i].value)); return; }
    const r = flat[cur];
    if (!r || r.disabled) return;
    playUiClickSfx();
    finish(r.value);
  }
  function toggle(i) {
    const r = flat[i];
    if (!r || r.disabled) return;
    if (picked.has(i)) picked.delete(i);
    else { if (maxSelect > 0 && picked.size >= maxSelect) return; picked.add(i); }
    paint();
  }
  function switchTab(si) {
    if (!useTabs || si === activeTab) return;
    activeTab = si;
    cur = flat.findIndex((r, i) => secOf[i] === si && !r.disabled);
    if (cur < 0) cur = flat.findIndex((_, i) => secOf[i] === si);
    paint({ fresh: true });
  }
  view.addEventListener("pointerover", (e) => {
    const el = e.target.closest?.("[data-i]");
    if (el && view.contains(el)) setCur(Number(el.dataset.i));
  });
  view.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-dhv]");
    if (btn) { e.stopPropagation(); if (btn.dataset.dhv === "back") { playUiClickSfx(); finish(null, true); } else if (!btn.classList.contains("is-off")) choose(); return; }
    const t = e.target.closest?.("[data-tab]");
    if (t) { e.stopPropagation(); switchTab(Number(t.dataset.tab)); return; }
    const el = e.target.closest?.("[data-i]");
    if (!el) return;
    e.stopPropagation();
    const i = Number(el.dataset.i);
    if (multiSelect) { cur = i; toggle(i); return; }
    cur = i; choose();
  });
  view.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); finish(null, true); });
  const onKey = (e) => {
    if (resolved) return;
    if (keysBlockedFor(view)) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key;
    const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (k === "Escape" || k === "x" || k === "X") { swallow(); playUiClickSfx(); finish(null, true); return; }
    if (k === "Enter" || k === "z" || k === "Z") { swallow(); choose(); return; }
    if (k === " ") { swallow(); if (multiSelect) toggle(cur); else choose(); return; }
    if (k === "ArrowUp") { swallow(); move(0, -1); return; }
    if (k === "ArrowDown") { swallow(); move(0, 1); return; }
    if (k === "ArrowLeft") { swallow(); move(-1, 0); return; }
    if (k === "ArrowRight") { swallow(); move(1, 0); return; }
    if (k === "Tab" && useTabs) { swallow(); switchTab((activeTab + 1) % groups.length); return; }
    if (k === "PageDown" || k === "PageUp") { if (scrollPlateCard(host, k === "PageDown" ? 1 : -1)) swallow(); return; }
    if ((tiles || numberShortcuts) && /^[1-9]$/.test(k)) {
      const order = [...view.querySelectorAll("[data-i]")].map((el) => Number(el.dataset.i));
      const i = order[Number(k) - 1];
      if (i != null && !flat[i].disabled) { swallow(); cur = i; if (multiSelect) toggle(i); else choose(); }
    }
  };
  window.addEventListener("keydown", onKey, true);
  if (externalCancel && typeof externalCancel.then === "function") externalCancel.then(() => finish(null, true));

  host.mount(view);
  paint({ fresh: true });
  requestAnimationFrame(() => view.classList.remove("is-in"));
  log(`drawer list: "${tab}" with ${flat.length} rows${tiles ? " (tiles)" : ""}`);
  return { promise, cleanup: () => finish(null, true) };
}
// A row's chip has ~140 px; the card says the whole reason.
function shortReason(s) {
  const t = String(s ?? "").trim();
  return t.length > 22 ? `${t.slice(0, 21).trimEnd()}…` : t;
}

// ── docked targets ───────────────────────────────────────────────────────────
/**
 * The target picker's panel inside the drawer. target-picker.js keeps owning
 * the rings, selection rules and keyboard; this only draws and reports clicks.
 * cols: [{ label, rows:[{ uuid, name, img, hp:{v,m}|null, status, excluded:reason|null }], none }]
 */
export function mountDockedTargets(host, { action = "Targets", onHover, onToggle, onConfirm, onBack, backLabel = "Back", secondary = null, onSecondary = null }) {
  ensureDrawerStyles();
  const view = document.createElement("div");
  view.className = "dhv-view is-in";
  let state = null;
  const rowHTML = (r, s) => `<div class="dhv-trow${s.focus === r.uuid ? " is-cur" : ""}${s.selected.has(r.uuid) ? " is-sel" : ""}${r.excluded ? " is-excl" : ""}${s.locked ? " is-lock" : ""}" data-uuid="${escapeHtml(r.uuid)}">`
    + `<span class="dhv-dia"></span>${r.img ? `<img class="dhv-face" src="${escapeHtml(r.img)}" alt="">` : `<span class="dhv-face"></span>`}`
    + `<span class="nm">${escapeHtml(r.name)}${r.you ? " (you)" : ""}${r.status ? ` <span class="dhv-chip t-tag">${escapeHtml(r.status)}</span>` : ""}</span>`
    + (r.excluded ? `<span class="why">${escapeHtml(r.excluded)}</span>`
      : r.hp ? `<span class="dhv-thp"><span>${r.hp.v} / ${r.hp.m}</span><i><b style="width:${Math.max(0, Math.min(100, (100 * r.hp.v) / (r.hp.m || 1)))}%"></b></i></span>` : `<span></span>`)
    + `</div>`;
  function paint() {
    const s = state;
    if (!s) return;
    const cols = s.cols.map((c) => `<div class="dhv-tcol"><div class="dhv-sec">${escapeHtml(c.label)}</div>`
      + (c.rows.length ? c.rows.map((r) => rowHTML(r, s)).join("") : `<div class="none">${escapeHtml(c.none ?? `None can be chosen for ${action}.`)}</div>`) + `</div>`);
    const text = s.locked ? `<span class="cnt">${escapeHtml(action)}</span> · targets are set` : `<span class="cnt">${s.count}</span> · ${escapeHtml(s.label ?? action)}`;
    const sec = secondary ? `<span class="dhv-btn back" role="button" data-dhv="secondary" style="text-transform:uppercase">${escapeHtml(secondary)}</span>` : "";
    view.innerHTML = `<div class="dhv-main"><div class="dhv-tcols">${cols.join('<div class="dhv-sep"></div>')}</div></div>`
      + footerHTML({ text, hints: s.locked || s.random || secondary ? "" : "Space picks · ←→ sides", back: backLabel, go: s.random ? "Roll" : "Confirm", goOk: s.valid })
        .replace(`<span class="dhv-btn back"`, `${sec}<span class="dhv-btn back"`);
    const cur = view.querySelector(".dhv-trow.is-cur");
    if (cur) { const col = cur.parentElement; if (cur.offsetTop < col.scrollTop || cur.offsetTop + cur.offsetHeight > col.scrollTop + col.clientHeight) col.scrollTop = Math.max(0, cur.offsetTop - 20); }
  }
  view.addEventListener("pointerover", (e) => {
    const el = e.target.closest?.("[data-uuid]");
    if (el && state && state.focus !== el.dataset.uuid) onHover?.(el.dataset.uuid);
  });
  view.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-dhv]");
    if (b) { e.stopPropagation(); playUiClickSfx(); if (b.dataset.dhv === "back") onBack?.(); else if (b.dataset.dhv === "secondary") onSecondary?.(); else if (!b.classList.contains("is-off")) onConfirm?.(); return; }
    const el = e.target.closest?.("[data-uuid]");
    if (el) { e.stopPropagation(); onToggle?.(el.dataset.uuid); }
  });
  view.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); onBack?.(); });
  host.mount(view);
  requestAnimationFrame(() => view.classList.remove("is-in"));
  return {
    root: view,
    update(next) { state = next; paint(); },
    destroy() { view.inert = true; },
  };
}

// ── docked reaction ──────────────────────────────────────────────────────────
/**
 * A reaction menu for this client's own character, inside the drawer: it opens
 * the drawer by itself (even on another turn), the tab turns garnet and names
 * the moment, rows show each option with its mode, Back becomes Pass (P).
 * Same record shape as ReactionMenu's token blades: { cleanup, updateDisabledLabels, root }.
 */
export function mountDockedReaction(host, { candidates, onPick, onPass, label = "Reaction", passLabel = "Pass", disabledLabels = null, goLabel = "Use" }) {
  ensureDrawerStyles();
  let disabled = new Map(Object.entries(disabledLabels ?? {}));
  const reasonOf = (c) => disabled.get(`${c?.carrierUuid}::${c?.rowKey}`) ?? null;
  const rows = candidates ?? [];
  let cur = Math.max(0, rows.findIndex((c) => c?.mode !== "on" && !reasonOf(c)));
  let done = false;
  const view = document.createElement("div");
  view.className = "dhv-view is-in";
  const modeChip = (c) => c?.mode === "on" ? { text: "Auto", tone: "tag" } : c?.kind === "manual" ? { text: "Manual", tone: "tag" } : { text: "Asks", tone: "tag" };
  const entry = (c) => ({
    key: `react|${c?.carrierUuid}|${c?.rowKey}`, name: c?.carrierName ?? "Reaction", kind: label, img: c?.carrierImg ?? null,
    chips: [modeChip(c)], body: htmlToCardText(c?.carrierDescription ?? ""),
    reason: reasonOf(c) ?? (c?.mode === "on" ? "This one happens on its own; it is listed so you can see it." : null),
  });
  function paint() {
    if (done) return;
    const list = rows.map((c, i) => {
      const why = reasonOf(c), auto = c?.mode === "on";
      const chip = why ? `<span class="dhv-chip t-danger">${escapeHtml(shortReason(why))}</span>` : `<span class="dhv-chip t-tag">${escapeHtml(modeChip(c).text)}</span>`;
      const icon = c?.carrierImg ? `<span class="dhv-ic"><img src="${escapeHtml(c.carrierImg)}" alt=""></span>` : "";
      return `<div class="dhv-row${icon ? "" : " no-icon"}${i === cur ? " is-cur" : ""}${why || auto ? " is-dis" : ""}" data-i="${i}"><span class="cur">▶</span>${icon}<span class="nm">${escapeHtml(c?.carrierName ?? "Reaction")}</span><span class="dhv-chips">${chip}</span></div>`;
    }).join("");
    const c = rows[cur];
    const ok = !!c && c.mode !== "on" && !reasonOf(c);
    view.innerHTML = `<div class="dhv-main"><div class="dhv-list is-one">${list}</div></div>`
      + footerHTML({ text: `<span class="cnt">${escapeHtml(label)}</span> · choose one${typeof onPass === "function" ? `, or ${escapeHtml(String(passLabel || "Pass").toLowerCase())}` : ""}`,
        back: typeof onPass === "function" ? passLabel : "", backKey: "P", go: typeof goLabel === "function" ? goLabel() : goLabel, goOk: ok });
    host.setCard?.(c ? entry(c) : null);
  }
  function pick() {
    const c = rows[cur];
    if (done || !c || c.mode === "on" || reasonOf(c)) return;
    playUiClickSfx();
    try { onPick?.(c); } catch (e) { warn("drawer reaction: onPick threw", e); }
  }
  function pass() {
    if (done || typeof onPass !== "function") return;
    playUiClickSfx();
    try { onPass(); } catch (e) { warn("drawer reaction: onPass threw", e); }
  }
  view.addEventListener("pointerover", (e) => {
    const el = e.target.closest?.("[data-i]");
    if (el && Number(el.dataset.i) !== cur) { cur = Number(el.dataset.i); playUiHoverSfx(); paint(); }
  });
  view.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-dhv]");
    if (b) { e.stopPropagation(); if (b.dataset.dhv === "back") pass(); else if (!b.classList.contains("is-off")) pick(); return; }
    const el = e.target.closest?.("[data-i]");
    if (el) { e.stopPropagation(); cur = Number(el.dataset.i); pick(); }
  });
  const onKey = (e) => {
    if (done) return;
    if (keysBlockedFor(view)) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // A step that follows (its target pick) owns the keys while it is up.
    if (!view.isConnected) return;
    const k = e.key, swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (k === "ArrowDown" || k === "ArrowUp") { swallow(); const n = rows.length; cur = (cur + (k === "ArrowDown" ? 1 : -1) + n) % n; playUiHoverSfx(); paint(); return; }
    if (k === "Enter" || k === "z" || k === "Z" || k === " ") { swallow(); pick(); return; }
    if (k === "p" || k === "P") { swallow(); pass(); return; }
    if (k === "PageDown" || k === "PageUp") { if (scrollPlateCard(host, k === "PageDown" ? 1 : -1)) swallow(); return; }
    if (/^[1-9]$/.test(k) && rows[Number(k) - 1]) { swallow(); cur = Number(k) - 1; paint(); pick(); }
  };
  window.addEventListener("keydown", onKey, true);
  const unmount = host.mountOverlay(view);
  host.setCrumb?.(label);
  paint();
  requestAnimationFrame(() => view.classList.remove("is-in"));
  log(`drawer reaction: "${label}" with ${rows.length} option(s)`);
  return {
    root: view,
    cleanup() {
      if (done) return;
      done = true;
      try { window.removeEventListener("keydown", onKey, true); } catch {}
      view.inert = true;
      try { unmount(); } catch (e) { warn("drawer reaction: unmount threw", e); }
    },
    updateDisabledLabels(next) {
      disabled = new Map(Object.entries(next ?? {}));
      paint();
    },
  };
}

// ── docked die swap ("Replace a die?") ───────────────────────────────────────
// slots: [{ slot, attr, die, options:[{ to, dTo, gain, source }] }]; budget:
// { [to]: maxUses }. Resolves { cancelled:false, swaps:[{ slot, from, to }] };
// Keep roll (Esc) resolves with no swaps, as the overlay's Cancel does.
export function pickDockedDieSwap(host, { label = "Die Swap", A1, A2, dA, dB, slots = [], budget = {}, onDone = null }) {
  ensureDrawerStyles();
  const pick = slots.map(() => "");          // "" = keep
  let curLine = 0, curCol = 0, done = false, resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  const view = document.createElement("div");
  view.className = "dhv-view is-in";
  const choicesOf = (s) => [{ to: "", text: `Keep ${s.attr} d${s.die}`, sub: "" }, ...(s.options ?? []).map((o) => {
    const d = Number(o.dTo) || 0, g = Number(o.gain) || 0;
    return { to: o.to, text: `${o.to} d${d}`, sub: `${o.source || "Swap"} ${g > 0 ? `▲ +${g}` : g < 0 ? `▼ ${g}` : "="}` };
  })];
  const usedElsewhere = (li, to) => pick.filter((p, i) => i !== li && p === to).length;
  const blocked = (li, to) => !!to && usedElsewhere(li, to) >= (budget[to] ?? 0);
  function paint() {
    const lines = slots.map((s, li) => `<div class="dhv-dline"><div class="dl">${li === 0 ? "First die" : "Second die"}<b>${escapeHtml(s.attr)} d${s.die}</b></div><div class="dhv-dchoices">`
      + choicesOf(s).map((c, ci) => `<span class="dhv-dch${pick[li] === c.to ? " is-pick" : ""}${li === curLine && ci === curCol ? " is-cur" : ""}${blocked(li, c.to) ? " is-dis" : ""}" data-line="${li}" data-c="${ci}">${escapeHtml(c.text)}${c.sub ? `<small>${escapeHtml(c.sub)}</small>` : ""}</span>`).join("")
      + `</div></div>`).join("");
    view.innerHTML = `<div class="dhv-main"><div class="dhv-dice">${lines}</div></div>`
      + footerHTML({ text: `<span class="cnt">${escapeHtml(label)}</span> · ${escapeHtml(A1)} d${dA} + ${escapeHtml(A2)} d${dB}`, hints: "Space picks", back: "Keep roll", go: "Roll" });
  }
  function choose(li, ci) {
    const c = choicesOf(slots[li])[ci];
    if (!c || blocked(li, c.to)) return;
    pick[li] = c.to;
    playUiHoverSfx();
    paint();
  }
  function finish(keep) {
    if (done) return;
    done = true;
    try { window.removeEventListener("keydown", onKey, true); } catch {}
    view.inert = true;
    playUiClickSfx();
    const swaps = keep ? [] : slots.map((s, i) => pick[i] ? { slot: s.slot, from: s.attr, to: pick[i] } : null).filter(Boolean);
    try { onDone?.(); } catch {}
    resolveFn({ cancelled: false, swaps });
  }
  view.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-dhv]");
    if (b) { e.stopPropagation(); finish(b.dataset.dhv === "back"); return; }
    const c = e.target.closest?.("[data-line]");
    if (c) { e.stopPropagation(); curLine = Number(c.dataset.line); curCol = Number(c.dataset.c); choose(curLine, curCol); }
  });
  view.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); finish(true); });
  const onKey = (e) => {
    if (done) return;
    if (keysBlockedFor(view)) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key, swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    const n = choicesOf(slots[curLine] ?? { options: [] }).length;
    if (k === "Escape") { swallow(); finish(true); }
    else if (k === "Enter") { swallow(); finish(false); }
    else if (k === " ") { swallow(); choose(curLine, curCol); }
    else if (k === "ArrowLeft" || k === "ArrowRight") { swallow(); curCol = Math.max(0, Math.min(n - 1, curCol + (k === "ArrowRight" ? 1 : -1))); playUiHoverSfx(); paint(); }
    else if (k === "ArrowUp" || k === "ArrowDown") { swallow(); curLine = Math.max(0, Math.min(slots.length - 1, curLine + (k === "ArrowDown" ? 1 : -1))); curCol = Math.min(curCol, choicesOf(slots[curLine]).length - 1); playUiHoverSfx(); paint(); }
  };
  window.addEventListener("keydown", onKey, true);
  host.mount(view);
  host.pushCrumb?.("Replace a Die");
  paint();
  requestAnimationFrame(() => view.classList.remove("is-in"));
  const cleanup = () => {
    if (done) return;
    done = true;
    try { window.removeEventListener("keydown", onKey, true); } catch {}
    view.inert = true;
    try { onDone?.(); } catch {}
    resolveFn({ cancelled: true, swaps: [] });
  };
  return { promise, cleanup };
}

// ── docked number prompt ─────────────────────────────────────────────────────
// Resolves the chosen value, or null on Back. opts: the allowed values in order.
export function pickDockedNumber(host, { label = "Amount", title = null, opts = [], initial = null, externalCancel = null, onDone = null }) {
  ensureDrawerStyles();
  let i = opts.indexOf(initial);
  if (i < 0) i = opts.length - 1;
  let done = false, resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  const view = document.createElement("div");
  view.className = "dhv-view is-in";
  // Typed digits jump straight to a value ("2", "7" → 27); the chip says what
  // was read and clears after a pause without typing.
  let typed = "", typedNote = "", typedT = null;
  function paint() {
    const lo = Math.max(0, Math.min(i - 4, opts.length - 9)), win = opts.slice(lo, lo + 9);
    const chip = typed ? `<span class="dhv-typed">typed ${escapeHtml(typed)}${typedNote ? ` · ${escapeHtml(typedNote)}` : ""}</span>` : "";
    view.innerHTML = `<div class="dhv-main"><div class="dhv-num"><div class="dhv-nlab">${escapeHtml(label)}<b>${escapeHtml(opts[i])}</b>${chip}</div>`
      + `<div class="dhv-strip"><span class="dhv-step" role="button" data-step="-1">−</span><div class="dhv-nums">`
      + win.map((v, k) => `<span class="${lo + k === i ? "is-on" : ""}" data-idx="${lo + k}">${escapeHtml(v)}</span>`).join("")
      + `</div><span class="dhv-step" role="button" data-step="1">+</span></div></div></div>`
      + footerHTML({ text: `<span class="cnt">${escapeHtml(title ?? label)}</span> · ${escapeHtml(opts[0])}–${escapeHtml(opts[opts.length - 1])}`, hints: "0–9 type · ←→ ±1 · PgUp/PgDn ±10", back: "Back", go: "Confirm" });
  }
  function set(n) { const j = Math.max(0, Math.min(opts.length - 1, n)); if (j !== i) { i = j; playUiHoverSfx(); paint(); } }
  function clearTyped() { clearTimeout(typedT); if (typed) { typed = ""; typedNote = ""; paint(); } }
  // The option nearest the typed number; past either end it stops there.
  function applyTyped() {
    clearTimeout(typedT);
    typedT = setTimeout(clearTyped, 1200);
    typedNote = "";
    const want = Number(typed);
    const nums = opts.map(Number);
    const lo = nums[0], hi = nums[nums.length - 1];
    let j = nums.indexOf(want);
    if (j < 0) {
      if (want >= Math.max(lo, hi)) { j = hi >= lo ? nums.length - 1 : 0; typedNote = `max ${Math.max(lo, hi)}`; }
      else if (want <= Math.min(lo, hi)) { j = hi >= lo ? 0 : nums.length - 1; typedNote = `min ${Math.min(lo, hi)}`; }
      else { let best = 0; for (let k = 1; k < nums.length; k++) if (Math.abs(nums[k] - want) < Math.abs(nums[best] - want)) best = k; j = best; }
    }
    if (j !== i) { i = j; playUiHoverSfx(); }
    paint();
  }
  function finish(value) {
    if (done) return;
    done = true;
    clearTimeout(typedT);
    try { window.removeEventListener("keydown", onKey, true); } catch {}
    view.inert = true;
    try { onDone?.(); } catch {}
    resolveFn(value);
  }
  view.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-dhv]");
    if (b) { e.stopPropagation(); playUiClickSfx(); finish(b.dataset.dhv === "back" ? null : opts[i]); return; }
    const s = e.target.closest?.("[data-step]");
    if (s) { e.stopPropagation(); set(i + Number(s.dataset.step)); return; }
    const v = e.target.closest?.("[data-idx]");
    if (v) { e.stopPropagation(); set(Number(v.dataset.idx)); }
  });
  view.addEventListener("wheel", (e) => { e.preventDefault(); set(i + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1)); }, { passive: false });
  view.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); finish(null); });
  const onKey = (e) => {
    if (done) return;
    if (keysBlockedFor(view)) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key, swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (k === "Escape") { swallow(); playUiClickSfx(); finish(null); }
    else if (k === "Enter") { swallow(); playUiClickSfx(); finish(opts[i]); }
    else if (k.length === 1 && k >= "0" && k <= "9" && opts.every((v) => Number.isFinite(Number(v)))) {
      swallow();
      // A digit after the number is already as long as the range allows starts a new one.
      const maxLen = String(Math.max(...opts.map((v) => Math.abs(Number(v))))).length;
      typed = typed.length >= maxLen ? k : (typed === "0" ? k : typed + k);
      applyTyped();
    }
    else if (k === "Backspace" && typed) { swallow(); typed = typed.slice(0, -1); if (typed) applyTyped(); else clearTyped(); }
    else if (k === "PageUp" || k === "PageDown") { swallow(); clearTyped(); set(i + (k === "PageUp" ? 10 : -10)); }
    else if (k === "ArrowLeft" || k === "ArrowDown") { swallow(); clearTyped(); set(i - 1); }
    else if (k === "ArrowRight" || k === "ArrowUp") { swallow(); clearTyped(); set(i + 1); }
    else if (k === "Home") { swallow(); clearTyped(); set(0); }
    else if (k === "End") { swallow(); clearTyped(); set(opts.length - 1); }
  };
  window.addEventListener("keydown", onKey, true);
  if (externalCancel && typeof externalCancel.then === "function") externalCancel.then(() => finish(null));
  host.mount(view);
  host.pushCrumb?.(title ?? "Choose an Amount");
  paint();
  requestAnimationFrame(() => view.classList.remove("is-in"));
  return promise;
}
