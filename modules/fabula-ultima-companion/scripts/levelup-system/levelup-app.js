// ============================================================================
// Character Level-Up System — the window.
//
//     FUCompanion.api.levelUp.open(actorUuid)
//
// A pure consumer of FUCompanion.api.levelUp: every control here calls the same
// spend/refund/pickHeroic a macro would, so nothing this window can do is
// something a script cannot. All authority lives GM-side; this only renders
// what getState() reports and relays clicks.
//
// It opens ANYWHERE so a player can plan a build mid-session, but it is
// read-only unless the gate is open (camp lobbies, or the title screen). The
// gate is re-checked GM-side on arrival, so a window left open when the party
// sets out cannot slip a write through — the read-only styling here is a
// courtesy, not the enforcement.
// ============================================================================

import {
  LEVELUP, LEVELUP_KEYS as KEYS, LEVELUP_CURSOR_SRC, keyMatch,
  classIcon, CLASS_META_DEFAULT,
} from "./levelup-const.js";
import { renderDescription, keywordRowHTML, RICHTEXT_CSS } from "./levelup-richtext.js";
import {
  sfx, hoverSfx, resetHover, preloadLevelUpSfx,
  staggerRows, windowAnim, previewIntro, burst, FX_CSS,
} from "./levelup-fx.js";

const STYLE_ID = "oni-levelup-styles";
const ROOT_ID = "oni-levelup";

const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// Strip authored HTML down to readable text, for titles and tooltips where
// markup would be noise.
const plain = (html) => {
  const d = document.createElement("div");
  d.innerHTML = String(html ?? "");
  return (d.textContent ?? "").replace(/\s+/g, " ").trim();
};

// Authored description → keyword row + formatted prose. Clamping is left to
// CSS so the markup survives; slicing an HTML string would cut mid-tag.
function describe(html, { clamp = true } = {}) {
  const { keywords, bodyHtml } = renderDescription(html);
  if (!keywords.length && !bodyHtml) return "";
  return keywordRowHTML(keywords) +
    (bodyHtml ? `<div class="lu-rt${clamp ? " is-clamped" : ""}">${bodyHtml}</div>` : "");
}

const api = () => globalThis.FUCompanion?.api?.levelUp ?? null;

// Failure codes → something a player can act on.
const REASON = {
  no_points: "No Skill Points to spend.",
  class_maxed: "That class is already at level 10.",
  skill_maxed: "That skill is already at its maximum level.",
  skill_not_in_class: "That skill doesn't belong to this class.",
  too_many_unmastered: "You already have three unmastered classes — master one before starting another.",
  char_level_cap: "Character level cap reached.",
  benefit_required: "Choose a bonus for this class first.",
  gate_closed: "Skill Points can only be spent while resting at camp, or from the title screen.",
  class_not_held: "You don't have any levels in that class.",
  skill_not_held: "You don't have that skill.",
  no_heroic_slot: "No Heroic Skill slots — master another class first.",
  requirement_not_met: "You don't meet that Heroic Skill's requirements yet.",
  requirement_unevaluable: "That requirement needs a GM to adjudicate.",
  heroic_not_available: "That Heroic Skill isn't available to you.",
  actor_not_found: "Character not found.",
  timeout: "The GM didn't respond — are they connected?",
  gm_only: "Only the GM can do that.",
};

function explain(res) {
  if (res?.reason === "would_orphan_heroic") {
    const names = (res.broken ?? []).map((b) => b.name).join(", ");
    return `Unlearn ${names} first — it depends on this class.`;
  }
  return REASON[res?.reason] ?? res?.message ?? "That didn't work.";
}

// ── styles ────────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${ROOT_ID} { position: fixed; inset: 0; z-index: 70; display: flex;
  align-items: center; justify-content: center; background: rgba(0,0,0,.62); }
#${ROOT_ID} * { box-sizing: border-box; }
#${ROOT_ID} .lu-panel { width: min(1120px, 94vw); height: min(760px, 92vh);
  display: flex; flex-direction: column; border-radius: 10px; overflow: hidden;
  background: #efe4cd; border: 2px solid #6b543a;
  box-shadow: 0 18px 60px rgba(0,0,0,.55); font-family: Signika, sans-serif; color: #2f2618; }

#${ROOT_ID} .lu-head { display: flex; align-items: center; gap: 14px; padding: 10px 14px;
  background: linear-gradient(180deg,#5d4630,#4a371f); color: #f6ecd8; flex: 0 0 auto; }
#${ROOT_ID} .lu-head > img { width: 46px; height: 46px; border-radius: 6px; object-fit: cover;
  border: 1px solid #29200f; background: #1c1509; }
#${ROOT_ID} .lu-name { font-size: 19px; font-weight: 700; line-height: 1.1; }
#${ROOT_ID} .lu-sub { font-size: 12px; opacity: .8; }
#${ROOT_ID} .lu-sp { margin-left: auto; text-align: center; padding: 4px 14px; border-radius: 8px;
  background: #2b2110; border: 1px solid #8a6c45; min-width: 96px; }
#${ROOT_ID} .lu-sp b { display: block; font-size: 26px; line-height: 1; color: #ffd479; }
#${ROOT_ID} .lu-sp span { font-size: 10px; letter-spacing: .09em; text-transform: uppercase; opacity: .85; }
/* Square, top-right, the way a close button is expected to look. */
#${ROOT_ID} .lu-x { flex: 0 0 auto; width: 28px; height: 28px; padding: 0; align-self: flex-start;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  font-size: 16px; line-height: 1; border-radius: 5px;
  border: 1px solid #8a6c45; background: #3a2b18; color: #e8dcc4; }
#${ROOT_ID} .lu-x:hover { background: #7a3226; border-color: #b0553f; color: #fff; }

/* Skill / Facet tabs — file-tab shapes rising out of the header */
#${ROOT_ID} .lu-tabs { display: flex; align-items: flex-end; gap: 3px; align-self: stretch;
  margin: 0 2px -10px; }
#${ROOT_ID} .lu-tab { font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
  padding: 7px 18px 9px; border: 1px solid #2f2313; border-bottom: 0;
  border-radius: 9px 9px 0 0; background: #4a3722; color: #cbb894; }
#${ROOT_ID} .lu-tab:hover { background: #57422a; color: #f2e6cf; }
#${ROOT_ID} .lu-tab.on { background: #efe4cd; color: #2f2618; border-color: #6b543a; }

#${ROOT_ID} .lu-tabdot { display: inline-block; min-width: 16px; padding: 0 4px; margin-left: 4px;
  border-radius: 8px; background: #d9a326; color: #2b2110; font-size: 11px; font-weight: 800; }

#${ROOT_ID} .lu-note { padding: 7px 14px; font-size: 12.5px; flex: 0 0 auto; }
#${ROOT_ID} .lu-note.warn { background: #f6e2b8; border-bottom: 1px solid #c9a768; color: #4a3306; }
#${ROOT_ID} .lu-note.drift { background: #f3d3d3; border-bottom: 1px solid #c08585; color: #5c1f1f;
  display: flex; align-items: center; gap: 10px; }
#${ROOT_ID} .lu-note button { margin-left: auto; }

#${ROOT_ID} .lu-body { flex: 1 1 auto; display: flex; min-height: 0; }
#${ROOT_ID} .lu-rail { width: 232px; flex: 0 0 auto; overflow-y: auto; padding: 8px;
  background: #e2d3b6; border-right: 1px solid #b79c72; }
#${ROOT_ID} .lu-cls { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 7px 9px; margin-bottom: 4px; border-radius: 7px; cursor: pointer;
  background: #f2e8d3; border: 1px solid #bda57e; font: inherit; color: inherit; }
#${ROOT_ID} .lu-cls:hover { background: #fbf4e4; }
#${ROOT_ID} .lu-cls.on { background: #5d4630; color: #f6ecd8; border-color: #3a2b17; }
#${ROOT_ID} .lu-cls > img { width: 26px; height: 26px; border-radius: 4px; object-fit: cover; flex: 0 0 auto; }
#${ROOT_ID} .lu-cls .n { flex: 1 1 auto; font-size: 13px; font-weight: 600; }
#${ROOT_ID} .lu-cls .l { font-size: 12px; font-variant-numeric: tabular-nums; opacity: .85; }
#${ROOT_ID} .lu-cls .star { color: #d9a326; }
#${ROOT_ID} .lu-cls.new { justify-content: center; background: #d9c9a6; border-style: dashed; font-weight: 600; }
#${ROOT_ID} .lu-railhead { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase;
  opacity: .65; margin: 8px 4px 4px; }

/* Mode switches — inline in the header, sized to their labels */
#${ROOT_ID} .lu-idblock { min-width: 0; }
#${ROOT_ID} .lu-switches { display: flex; align-items: center; gap: 7px; flex: 0 0 auto; margin-left: 6px; }
#${ROOT_ID} .lu-sw { display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  font: inherit; font-size: 11.5px; font-weight: 600; color: #4a3a22; white-space: nowrap;
  padding: 3px 10px 3px 4px; border-radius: 12px; border: 1px solid #b79c72; background: #f2e8d3; }
#${ROOT_ID} .lu-sw:hover { background: #fbf4e4; }

/* Forget me Nut purse — icon then count, on one line */
#${ROOT_ID} .lu-purse { display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto;
  padding: 3px 13px 3px 7px; border-radius: 7px;
  background: #2b2110; border: 1px solid #8a6c45; }
#${ROOT_ID} .lu-purse > img { width: 26px; height: 26px; object-fit: contain; flex: 0 0 auto;
  border: 0 !important; outline: 0 !important; background: none; }
#${ROOT_ID} .lu-purse b { font-size: 19px; line-height: 1; color: #f6ecd8; }
#${ROOT_ID} .lu-purse em { font-size: 10px; font-style: normal; opacity: .65; color: #e8dcc4; }
#${ROOT_ID} .lu-purse.empty { border-color: #b0553f; }
#${ROOT_ID} .lu-purse.empty b { color: #ff9c85; }
#${ROOT_ID} .lu-swtrack { width: 26px; height: 14px; border-radius: 8px; background: #c3ae8b;
  border: 1px solid #9c845f; position: relative; transition: background 120ms; }
#${ROOT_ID} .lu-swknob { position: absolute; top: 1px; left: 1px; width: 10px; height: 10px;
  border-radius: 50%; background: #f7f0df; transition: left 120ms; }
#${ROOT_ID} .lu-sw.on { background: #dceccb; border-color: #5f8b3c; color: #2c5216; }
#${ROOT_ID} .lu-sw.on .lu-swtrack { background: #5f8b3c; border-color: #47692c; }
#${ROOT_ID} .lu-sw.on .lu-swknob { left: 13px; }
/* Reset mode tints the working area, so it is never ambiguous which mode is on. */
#${ROOT_ID} .lu-body.is-reset .lu-main { background: #f7ece9; }

#${ROOT_ID} .lu-mainwrap { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
#${ROOT_ID} .lu-main { flex: 1 1 auto; overflow-y: auto; padding: 12px 14px; }

/* Detail panel — one description for the whole list, under it. */
#${ROOT_ID} .lu-detail { flex: 0 0 auto; height: 150px; overflow-y: auto; padding: 9px 14px;
  background: #e6dabd; border-top: 2px solid #b79c72; }
#${ROOT_ID} .lu-dempty { font-size: 12px; opacity: .55; font-style: italic; padding: 6px 2px; }
#${ROOT_ID} .lu-dhead { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
#${ROOT_ID} .lu-dhead > img { width: 30px; height: 30px; border-radius: 5px; object-fit: cover;
  flex: 0 0 auto; border: 0 !important; outline: 0 !important; }
#${ROOT_ID} .lu-dhead b { font-size: 14px; }
#${ROOT_ID} .lu-dbody { font-size: 12px; }
#${ROOT_ID} .lu-gap { flex: 1 1 auto; }

/* Compact list row: icon, name, control. Description lives in the panel. */
#${ROOT_ID} .lu-row { display: flex; align-items: center; gap: 9px; padding: 6px 10px;
  border-radius: 8px; margin-bottom: 4px; cursor: pointer;
  background: #f7f0df; border: 1px solid #c6ae87; }
#${ROOT_ID} .lu-row:hover { background: #fffaec; border-color: #a98a4e; }
#${ROOT_ID} .lu-row > img { width: 30px; height: 30px; border-radius: 5px; object-fit: cover;
  flex: 0 0 auto; border: 0 !important; outline: 0 !important; }
#${ROOT_ID} .lu-row > b { font-size: 13.5px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; max-width: 46%; }
#${ROOT_ID} .lu-row.pinned { border-color: #6b543a; box-shadow: 0 0 0 2px rgba(107,84,58,.4) inset; }
#${ROOT_ID} .lu-row.max { background: #f1e6c6; border-color: #a98a4e; }
#${ROOT_ID} .lu-row.have { border-color: #5f8b3c; background: #eef6e5; }
#${ROOT_ID} .lu-row.away { border-color: #a3706f; background: #f6e9e9; }
/* Only the identity dims — a live + or − must stay legible. */
#${ROOT_ID} .lu-row.miss > img, #${ROOT_ID} .lu-row.miss > b,
#${ROOT_ID} .lu-row.miss > .lu-tag { opacity: .45; filter: saturate(.3); }
#${ROOT_ID} .lu-row.miss:hover > img, #${ROOT_ID} .lu-row.miss:hover > b,
#${ROOT_ID} .lu-row.miss:hover > .lu-tag { opacity: .85; filter: saturate(.8); }

/* Detail mode: the same row, grown to carry its description. */
#${ROOT_ID} .lu-row.wide { align-items: flex-start; padding: 8px 10px; }
#${ROOT_ID} .lu-row.wide > img { width: 34px; height: 34px; }
#${ROOT_ID} .lu-rtext { flex: 1 1 auto; min-width: 0; }
#${ROOT_ID} .lu-rtitle { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
#${ROOT_ID} .lu-rtitle b { font-size: 13.5px; }
#${ROOT_ID} .lu-row.wide .lu-rt { margin-top: 3px; font-size: 11.5px; opacity: .78; }
#${ROOT_ID} .lu-row.wide.miss > img, #${ROOT_ID} .lu-row.wide.miss > .lu-rtext { opacity: .45; filter: saturate(.3); }
#${ROOT_ID} .lu-row.wide.miss:hover > img, #${ROOT_ID} .lu-row.wide.miss:hover > .lu-rtext { opacity: .85; filter: saturate(.8); }
/* With text on every row the panel is redundant, so it collapses away. */
#${ROOT_ID} .lu-body.is-detail .lu-detail { display: none; }
#${ROOT_ID} .lu-h2 { display: flex; align-items: baseline; gap: 10px; margin: 0 0 4px; }
#${ROOT_ID} .lu-h2 b { font-size: 18px; }
#${ROOT_ID} .lu-h2 span { font-size: 12px; opacity: .7; }
#${ROOT_ID} .lu-lore { font-size: 12px; opacity: .75; margin-bottom: 10px; }

#${ROOT_ID} .lu-skill { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: 8px; margin-bottom: 6px; background: #f7f0df; border: 1px solid #c6ae87; }
#${ROOT_ID} .lu-learned { font-size: 11.5px; font-weight: 700; font-style: italic;
  opacity: .5; white-space: nowrap; letter-spacing: .02em; }
/* Direct child ONLY. As a descendant selector this also matched the inline
   keyword glyphs inside the description and blew them up to 34px — and at
   (1,1,1) it outranked the (1,1,0) rule meant to size them. */
#${ROOT_ID} .lu-skill > img { width: 34px; height: 34px; border-radius: 5px; object-fit: cover; flex: 0 0 auto; }
#${ROOT_ID} .lu-skill .t { flex: 1 1 auto; min-width: 0; }
#${ROOT_ID} .lu-skill .t b { font-size: 13.5px; }
#${ROOT_ID} .lu-skill .t .lu-rt { margin-top: 2px; font-size: 11.5px; opacity: .78; }
/* Clamp by line box rather than by slicing the HTML — cutting a markup string
   at N characters lands mid-tag and mangles the formatting. */
#${ROOT_ID} .lu-rt.is-clamped { display: -webkit-box; -webkit-line-clamp: 3;
  -webkit-box-orient: vertical; overflow: hidden; }
#${ROOT_ID} .lu-pips { font-size: 12.5px; font-variant-numeric: tabular-nums; white-space: nowrap; opacity: .8; }
#${ROOT_ID} .lu-btn { width: 28px; height: 28px; border-radius: 6px; cursor: pointer; font-size: 16px;
  line-height: 1; border: 1px solid #8a6c45; background: #e8d9b8; color: #2f2618; flex: 0 0 auto; }
#${ROOT_ID} .lu-btn:hover:not(:disabled) { background: #fff6e2; }
#${ROOT_ID} .lu-btn:disabled { opacity: .3; cursor: not-allowed; }
#${ROOT_ID} .lu-btn.buy { background: #d8e8c8; border-color: #6f8a52; }
#${ROOT_ID} .lu-btn.sell { background: #eedada; border-color: #a3706f; }

#${ROOT_ID} .lu-heroic { margin-top: 16px; padding-top: 10px; border-top: 2px solid #c0a67c; }
#${ROOT_ID} .lu-heroic h3 { margin: 0 0 6px; font-size: 14px; }
#${ROOT_ID} .lu-req { margin: 3px 0 0; font-size: 11px; color: #7a3d10; }
#${ROOT_ID} .lu-req.ok { color: #3f6b23; }
#${ROOT_ID} .lu-empty { font-size: 12.5px; opacity: .7; padding: 10px 2px; }
#${ROOT_ID} .lu-tag { font-size: 10px; padding: 1px 6px; border-radius: 9px; background: #d9c9a6;
  border: 1px solid #b79c72; }

/* staged, unwritten values */
#${ROOT_ID} .moved { color: #1f6f3f; font-weight: 700; }
#${ROOT_ID} .lu-sp.staged { border-color: #6f9c55; box-shadow: 0 0 0 1px #6f9c55 inset; }
#${ROOT_ID} .lu-sp.staged b { color: #b6f08a; }
#${ROOT_ID} .lu-tag.moved { background: #cfe6bd; border-color: #6f9c55; color: #234f14; }

#${ROOT_ID} .lu-foot { flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  padding: 9px 14px; background: #ded0b1; border-top: 2px solid #b79c72; }
#${ROOT_ID} .lu-foottext { flex: 1 1 auto; font-size: 12px; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
#${ROOT_ID} .lu-cta { padding: 6px 16px; border-radius: 7px; cursor: pointer; font: inherit;
  font-size: 13px; font-weight: 600; border: 1px solid #8a6c45; }
#${ROOT_ID} .lu-cta.go { background: #3f6b23; border-color: #2b4a15; color: #f2ffe6; }
#${ROOT_ID} .lu-cta.go:hover { background: #4d8029; }
#${ROOT_ID} .lu-cta.ghost { background: #efe4cd; color: #4a3a22; }
#${ROOT_ID} .lu-cta.ghost:hover { background: #fbf4e4; }

#${ROOT_ID} .lu-picker { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; background: rgba(0,0,0,.45); }
#${ROOT_ID} .lu-pickpanel { width: min(1000px, 94vw); height: min(700px, 90vh); }
#${ROOT_ID} .lu-pickpanel .lu-head { gap: 10px; align-items: flex-start; }
#${ROOT_ID} .lu-picktabs { margin-left: auto; }

/* Two panes: preview left, class list right. */
#${ROOT_ID} .lu-pickbody { flex: 1 1 auto; display: flex; min-height: 0; }
/* min-height:0 is load-bearing: without it this flex column refuses to shrink
   below its content, so .lu-pvscroll never gets a bounded height and a long
   Unique Mechanic overflows instead of scrolling. */
#${ROOT_ID} .lu-preview { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: hidden;
  display: flex; flex-direction: column; padding: 12px 14px; gap: 8px; }
/* Give the long-form tabs a visible, in-theme scrollbar. */
#${ROOT_ID} .lu-pvscroll { scrollbar-width: thin; scrollbar-color: #a9855a #e6dabd; }
#${ROOT_ID} .lu-pvscroll::-webkit-scrollbar { width: 10px; }
#${ROOT_ID} .lu-pvscroll::-webkit-scrollbar-track { background: #e6dabd; border-radius: 6px; }
#${ROOT_ID} .lu-pvscroll::-webkit-scrollbar-thumb { background: #a9855a; border-radius: 6px;
  border: 2px solid #e6dabd; }
#${ROOT_ID} .lu-pvscroll::-webkit-scrollbar-thumb:hover { background: #8a6c45; }
#${ROOT_ID} .lu-picklist { width: 288px; flex: 0 0 auto; overflow-y: auto; padding: 8px;
  background: #e2d3b6; border-left: 1px solid #b79c72; }

#${ROOT_ID} .lu-pickrow { display: flex; align-items: center; gap: 10px; width: 100%;
  text-align: left; font: inherit; font-size: 14px; font-weight: 600; color: #2f2618;
  padding: 9px 12px; margin-bottom: 5px; border-radius: 8px; cursor: pointer;
  background: #f7f0df; border: 1px solid #c6ae87; }
#${ROOT_ID} .lu-pickrow:hover { background: #fffaec; border-color: #a98a4e; }
#${ROOT_ID} .lu-pickrow.on { background: #5d4630; color: #f6ecd8; border-color: #3a2b17; }
#${ROOT_ID} .lu-pickrow i { width: 22px; text-align: center; font-size: 16px; opacity: .85; flex: 0 0 auto; }

/* Overview — the art fills the pane; text floats over it.
   Every overlay carries a glow + stroke so it survives whatever is behind it:
   the art is different per class and cannot be designed around. */
#${ROOT_ID} .lu-previewwrap { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
#${ROOT_ID} .lu-pvart { position: relative; flex: 1 1 auto; min-height: 0; }
#${ROOT_ID} .lu-pvartimg { position: absolute; inset: 0; z-index: 0;
  background-size: contain; background-position: center top; background-repeat: no-repeat; }
/* Scrim between art and text, so the overlays read over busy artwork. */
#${ROOT_ID} .lu-pvart::after { content: ""; position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background: radial-gradient(ellipse at 30% 40%, rgba(247,240,223,0) 40%, rgba(247,240,223,.55) 100%); }
#${ROOT_ID} .lu-pvtext { position: absolute; inset: 0; z-index: 2; }

#${ROOT_ID} .lu-glow, #${ROOT_ID} .lu-pvname, #${ROOT_ID} .lu-pvflavor,
#${ROOT_ID} .lu-pvalso, #${ROOT_ID} .lu-pvlore, #${ROOT_ID} .lu-pvmeta {
  paint-order: stroke fill;
  -webkit-text-stroke: 3px rgba(247,240,223,.92);
  text-shadow: 0 0 8px #f7f0df, 0 0 16px #f7f0df, 0 1px 0 rgba(247,240,223,.9); }

#${ROOT_ID} .lu-pvname { position: absolute; top: 2px; left: 2px; right: 2px;
  font-size: 30px; font-weight: 800; font-style: italic; color: #5c1f2e; }
/* Sits just under the class name, nudged in from the left edge. */
#${ROOT_ID} .lu-pvalso { position: absolute; top: 42px; left: 22px; width: 60%;
  font-size: 11.5px; color: #5a4a30; }
#${ROOT_ID} .lu-pvalso i { opacity: .7; }
#${ROOT_ID} .lu-pvflavor { position: absolute; top: 74px; right: 6px; width: 44%;
  font-size: 13px; font-style: italic; color: #4a3a22; text-align: center; }
#${ROOT_ID} .lu-pvflavor.lu-rt p { margin: 0; }
#${ROOT_ID} .lu-pvlore { position: absolute; right: 6px; bottom: 6px; width: 46%;
  max-height: 52%; overflow-y: auto; font-size: 11.5px; color: #3a2f1e; }
#${ROOT_ID} .lu-pvmeta { position: absolute; left: 4px; bottom: 6px; display: flex;
  flex-direction: column; gap: 5px; font-size: 12.5px; font-weight: 800; color: #3b2a17; }
#${ROOT_ID} .lu-pvmeta > div { display: flex; align-items: center; gap: 7px; }
#${ROOT_ID} .lu-stars i { color: #a99a7c; font-size: 14px; -webkit-text-stroke: 0; }
#${ROOT_ID} .lu-stars i.on { color: #3b2a17; }
#${ROOT_ID} .lu-role { padding: 1px 10px; border-radius: 10px; font-size: 11px;
  background: #f2e8d3; border: 1px solid #8a6c45; -webkit-text-stroke: 0; text-shadow: none; }

/* The commit button is docked, not flowed — it must not wander with the text. */
#${ROOT_ID} .lu-pickfoot { flex: 0 0 auto; padding: 9px 14px;
  background: #e6dabd; border-top: 2px solid #b79c72; }
#${ROOT_ID} .lu-pvgo { width: 100%; }

#${ROOT_ID} .lu-pvhead { display: flex; align-items: baseline; gap: 10px; }
#${ROOT_ID} .lu-pvhead b { font-size: 18px; }
#${ROOT_ID} .lu-pvhead span { font-size: 12px; opacity: .7; }
#${ROOT_ID} .lu-pvfree { font-size: 12px; padding: 6px 9px; border-radius: 7px;
  background: #f1e6c6; border: 1px solid #c6ae87; }
#${ROOT_ID} .lu-pvscroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; font-size: 12px; }
#${ROOT_ID} .lu-pvscroll.lore { opacity: .8; }
#${ROOT_ID} .lu-pvrow { display: flex; gap: 9px; padding: 7px 8px; margin-bottom: 5px;
  border-radius: 7px; background: #f7f0df; border: 1px solid #c6ae87; }
#${ROOT_ID} .lu-pvrow > img { width: 28px; height: 28px; border-radius: 5px; object-fit: cover;
  flex: 0 0 auto; border: 0 !important; outline: 0 !important; }
#${ROOT_ID} .lu-pvrow .t { min-width: 0; flex: 1 1 auto; }
/* Name outranks its description — same-size text gives the eye nowhere to land. */
#${ROOT_ID} .lu-pvtitle { display: flex; align-items: center; gap: 7px; }
#${ROOT_ID} .lu-pvtitle b { font-size: 14px; }
#${ROOT_ID} .lu-pvrow .lu-rt { font-size: 11px; opacity: .8; margin-top: 2px; }
/* Max Skill Level, in the rulebook's own shorthand. */
#${ROOT_ID} .lu-maxlv { flex: 0 0 auto; font-size: 11.5px; font-weight: 800; color: #4b3517;
  padding: 1px 8px; border-radius: 10px;
  background: linear-gradient(180deg,#f0d99a,#e0c179); border: 1px solid #8a6c45; }
#${ROOT_ID} .lu-pvgo { flex: 0 0 auto; align-self: flex-start; }

#${ROOT_ID} .lu-subtabs { display: flex; gap: 5px; }
#${ROOT_ID} .lu-subtab { font: inherit; font-size: 11.5px; font-weight: 700; cursor: pointer;
  padding: 3px 12px; border-radius: 11px; border: 1px solid #b79c72;
  background: #f2e8d3; color: #4a3a22; }
#${ROOT_ID} .lu-subtab.on { background: #5d4630; color: #f6ecd8; border-color: #3a2b17; }
#${ROOT_ID} .lu-tab:disabled { opacity: .35; cursor: not-allowed; }

/* Facet picker — layered above the class browser */
#${ROOT_ID} .lu-facet { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; background: rgba(0,0,0,.55); }
#${ROOT_ID} .lu-facetpanel { width: min(660px, 90vw); height: min(680px, 86vh); }
#${ROOT_ID} .lu-confirmpanel { height: auto; max-height: min(560px, 82vh); }
#${ROOT_ID} .lu-facetpanel .lu-main { flex: 1 1 auto; min-height: 0; }
#${ROOT_ID} .lu-fbtn { display: block; width: 100%; text-align: left; font: inherit; color: inherit;
  padding: 9px 12px; margin-bottom: 7px; border-radius: 8px; cursor: pointer;
  background: #f7f0df; border: 1px solid #c6ae87; }
#${ROOT_ID} .lu-fbtn:hover { background: #fffaec; border-color: #a98a4e; }
#${ROOT_ID} .lu-fbtn b { font-size: 13.5px; }
#${ROOT_ID} .lu-fbtn .lu-rt { margin-top: 3px; font-size: 11.5px; opacity: .78; }
#${ROOT_ID} .lu-fhead { display: flex; align-items: center; gap: 8px; }
/* The global sheet stylesheet puts a border on every img; these are inline
   glyphs and must not inherit it. */
#${ROOT_ID} .lu-fhead > img { width: 26px; height: 26px; object-fit: contain; flex: 0 0 auto;
  border: 0 !important; outline: 0 !important; background: none; border-radius: 4px; }
#${ROOT_ID} .lu-fbtn.is-on { background: #dceccb; border-color: #5f8b3c; box-shadow: 0 0 0 1px #5f8b3c inset; }
#${ROOT_ID} .lu-fbtn.is-on b { color: #2c5216; }
#${ROOT_ID} .lu-btn.edit { background: #e3dcf1; border-color: #7a6aa3; }
${RICHTEXT_CSS(`#${ROOT_ID}`)}
${FX_CSS}

/* Feather cursor — same asset, placement and float as the Healing / Ritual
   HUDs, so the three read as one interface. Lives on <body> because the window
   clips its own overflow. */
.lu-cursor {
  position: fixed; z-index: 2147483647; width: 46px; height: 46px; pointer-events: none;
  transform: translate(-38%, -92%) rotate(20deg) translateY(0px);
  transition: left .18s cubic-bezier(0.22,1,0.36,1), top .18s cubic-bezier(0.22,1,0.36,1), opacity .12s ease;
  opacity: 0;
  border: none !important; outline: none !important; box-shadow: none !important;
  background: transparent !important;
  filter: drop-shadow(0 2px 3px rgba(0,0,0,.5));
}
.lu-cursor.is-visible { opacity: 1; animation: oniLevelUpCursorFloat 2.2s ease-in-out infinite; }
.lu-cursor.no-anim { transition: none !important; }
@keyframes oniLevelUpCursorFloat {
  0%, 100% { transform: translate(-38%, -92%) rotate(20deg) translateY(0px); }
  50%      { transform: translate(-38%, -92%) rotate(20deg) translateY(-7px); }
}
@media (prefers-reduced-motion: reduce) {
  .lu-cursor { transition: none; }
  .lu-cursor.is-visible { animation: none; }
}
`;
  document.head.appendChild(s);
}

// ── window ────────────────────────────────────────────────────────────────

const LevelUpApp = {
  _root: null,
  _actorUuid: null,
  _selected: null,      // class key — may be a class not yet taken
  _pickerOpen: false,   // the new-class browser, layered over the main window
  _pickSel: null,       // class being previewed in the browser (not yet chosen)
  _pickTab: "overview", // "overview" | "skill" | "unique"
  _pickSub: "skill",    // Facets are a sub-tab of Skill, not a peer
  _pickFocusEl: null,   // last browser control the pointer touched, for the feather
  _facet: null,         // the Facet picker, layered above everything
  _tab: "skill",        // "skill" | "facet" | "heroic" — what the main pane shows
  _busy: false,

  // Detail panel. Rows carry only icon, name and their control; the effect text
  // lives in one panel below the list and follows the cursor. Clicking a row
  // pins it, so the text stays put while the mouse travels to a button or off
  // the list entirely.
  _pinned: null,        // uuid of the pinned row, or null
  _hover: null,         // uuid under the cursor
  _details: new Map(),  // uuid → { name, img, cost, meta, description, note }

  // Keyboard focus. Zones mirror the layout: the class rail, the list, and the
  // footer's Discard/Confirm pair when a batch is staged.
  _zone: "list",        // "head" | "rail" | "list" | "foot"
  _headIdx: 2,          // lands on the first tab, past the two mode switches
  _railIdx: 0,
  _rowIdx: 0,
  _footIdx: 1,          // default to Confirm, the likely intent
  _cursorEl: null,
  _cursorReady: false,

  _detailMode: false,   // false = compact rows + panel; true = descriptions inline
  // Spending and refunding are separate modes rather than adjacent buttons.
  // A misclick on − beside + costs a skill AND a point, and in a batch that
  // reads as the window doing something the player never asked for.
  _resetMode: false,

  // Staged, unwritten changes. Nothing touches the actor until Confirm.
  //
  // Besides being what a player wants (try a build, back out of it), this is
  // what keeps the sheet consistent: a spend writes the class row, the skill
  // and the point counter as three updates, and re-rendering between them
  // showed a drift warning for the instant the books didn't balance. Batching
  // means the window never observes a half-applied spend.
  _pending: [],         // [{ op:"spend"|"refund"|"heroic", classKey, skillUuid, benefit }]
  _applying: false,

  get isOpen() { return Boolean(this._root?.isConnected); },

  open(actorUuid) {
    const uuid = actorUuid ?? this._guessActor();
    if (!uuid) return ui.notifications?.warn?.("No character selected.");
    injectStyles();

    this._actorUuid = uuid;
    if (this.isOpen) return this.render();

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `<div class="lu-panel"></div>`;
    document.body.appendChild(root);
    this._root = root;

    root.addEventListener("mousedown", (ev) => { if (ev.target === root) this.close(); });
    root.addEventListener("click", (ev) => this._onClick(ev));

    // One cursor blip per interactive element entered, not per mousemove.
    root.addEventListener("pointerover", (ev) => {
      const el = ev.target?.closest?.("[data-act]");
      if (el && !el.disabled) hoverSfx(el);
      // The feather is one cursor shared by both input methods: the mouse
      // moves it, and the keyboard picks up from wherever the mouse left it.
      // Without this they drift apart and arrowing after a click teleports the
      // selection back to some stale index.
      this._syncFocusToPointer(ev.target);
    });
    this._installKeyboard();

    this._cursorEl = document.createElement("img");
    this._cursorEl.className = "lu-cursor";
    this._cursorEl.src = LEVELUP_CURSOR_SRC;
    this._cursorEl.alt = "";
    document.body.appendChild(this._cursorEl);
    this._cursorReady = false;

    // Any change to the actor (a GM edit, another client's spend) re-renders.
    this._hook = Hooks.on("updateActor", (doc) => {
      if (doc?.uuid === this._actorUuid) this.render();
    });
    this._itemHook = Hooks.on("createItem", (i) => { if (i?.parent?.uuid === this._actorUuid) this.render(); });
    this._itemHook2 = Hooks.on("deleteItem", (i) => { if (i?.parent?.uuid === this._actorUuid) this.render(); });

    this.render();
    preloadLevelUpSfx();
    sfx("open");
    windowAnim(this._root.querySelector(".lu-panel"), "in");
  },

  async close() {
    if (this._closing) return;
    this._closing = true;
    sfx("close");
    await windowAnim(this._root?.querySelector(".lu-panel"), "out");
    this._closing = false;

    // Staged changes were never written; dropping them is the same as Discard.
    this._pending = [];
    this._facet = null;
    resetHover();
    this._cursorEl?.remove();
    this._cursorEl = null;
    this._cursorReady = false;
    if (this._onKey) { window.removeEventListener("keydown", this._onKey, true); this._onKey = null; }
    if (this._hook) Hooks.off("updateActor", this._hook);
    if (this._itemHook) Hooks.off("createItem", this._itemHook);
    if (this._itemHook2) Hooks.off("deleteItem", this._itemHook2);
    this._root?.remove();
    this._root = null;
  },

  toggle(uuid) { this.isOpen ? this.close() : this.open(uuid); },

  // The character this user is here to level: their assigned actor, else a
  // selected token, else nothing.
  _guessActor() {
    const owned = game.user?.character?.uuid;
    if (owned) return owned;
    const tok = canvas?.tokens?.controlled?.[0]?.actor?.uuid;
    return tok ?? null;
  },

  // ── projection ──────────────────────────────────────────────────────────

  /**
   * Fold the staged operations over the real state so the window can show what
   * the character WOULD look like. Returns deltas keyed by class and skill,
   * plus the resulting Skill Point balance.
   */
  _project(s) {
    const classDelta = new Map();
    const skillDelta = new Map();
    let points = s.points.stored;
    const bump = (m, k, d) => m.set(k, (m.get(k) ?? 0) + d);

    for (const p of this._pending) {
      if (p.op === "heroic") continue;           // heroics are free
      const d = p.op === "spend" ? 1 : -1;
      bump(classDelta, p.classKey, d);
      bump(skillDelta, p.skillUuid, d);
      points -= d;
    }
    return {
      classDelta, skillDelta, points,
      heroics: this._pending.filter((p) => p.op === "heroic"),
      // Nuts owed by the staged batch — one per level being given back.
      refundCount: this._pending.filter((p) => p.op === "refund").length,
    };
  },

  _classLevel(s, cls, proj) { return cls.level + (proj.classDelta.get(cls.key) ?? 0); },
  _skillLevel(sk, proj) { return sk.level + (proj.skillDelta.get(sk.uuid) ?? 0); },

  /** Non-mastered classes after staging — for the p.227 three-class limit. */
  _projectedUnmastered(s, proj) {
    let n = 0;
    for (const c of s.classes) {
      const lvl = this._classLevel(s, c, proj);
      if (lvl > 0 && lvl < s.rules.maxClassLevel) n += 1;
    }
    return n;
  },

  // ── render ──────────────────────────────────────────────────────────────

  render() {
    if (!this.isOpen || this._applying) return;
    const s = api()?.getState(this._actorUuid);
    const panel = this._root.querySelector(".lu-panel");
    if (!s?.ok) {
      panel.innerHTML = `<div class="lu-empty" style="padding:24px">Could not read that character.</div>`;
      return;
    }

    const proj = this._project(s);
    // A class with staged levels counts as "taken" for the rail, so a class
    // opened this session appears immediately rather than after Confirm.
    const taken = s.classes
      .filter((c) => c.taken || this._classLevel(s, c, proj) > 0)
      .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
    if (!this._selected || !s.classes.some((c) => c.key === this._selected)) {
      this._selected = taken[0]?.key ?? null;
    }

    // Rebuilding innerHTML throws the list back to the top. Anything that
    // re-renders — pinning a row, spending a point — would otherwise yank a
    // player who was reading halfway down a 17-entry list.
    const keepScroll = this._root.querySelector(".lu-main")?.scrollTop ?? 0;

    this._details = new Map();   // rebuilt by whichever tab renders below
    const main = this._main(s, proj);
    if (this._pinned && !this._details.has(this._pinned)) this._pinned = null;

    panel.innerHTML =
      this._head(s, proj) + this._notes(s) +
      `<div class="lu-body ${this._resetMode ? "is-reset" : ""} ${this._detailMode ? "is-detail" : ""}">
         <div class="lu-rail">${this._rail(s, taken, proj)}</div>
         <div class="lu-mainwrap">
           <div class="lu-main">${main}</div>
           <div class="lu-detail">${this._detailHTML()}</div>
         </div>
       </div>` +
      this._footer(s, proj);

    const list = panel.querySelector(".lu-main");
    if (list) list.scrollTop = keepScroll;

    // Stagger only when the LIST ITSELF changed — a different tab or class.
    // Re-animating on every render would make each + click flutter the whole
    // list, which is noise rather than feedback.
    const listKey = `${this._tab}:${this._selected}:${this._detailMode}`;
    if (list && listKey !== this._listKey) {
      this._listKey = listKey;
      staggerRows(list.querySelectorAll(".lu-row"), "in");
    }

    // Keep keyboard focus inside the list that now exists — a Confirm can
    // shorten it, and the footer disappears entirely once the batch is written.
    const rowCount = this._rows().length;
    if (this._rowIdx >= rowCount) this._rowIdx = Math.max(0, rowCount - 1);
    if (this._zone === "foot" && !this._footBtns().length) this._zone = "list";
    if (this._zone === "rail" && this._railIdx >= this._railBtns().length) this._railIdx = 0;
    if (this._zone === "head") this._headIdx = Math.min(this._headIdx, Math.max(0, this._headBtns().length - 1));
    this._updateCursor();

    // Hover updates only the detail panel — re-rendering the whole window on
    // every mouseover would fight the scroll position and feel awful.
    list?.addEventListener("mouseover", (ev) => {
      const row = ev.target.closest?.("[data-detail]");
      const uuid = row?.dataset.detail ?? null;
      if (uuid === this._hover) return;
      this._hover = uuid;
      this._paintDetail();
    });
    list?.addEventListener("mouseleave", () => { this._hover = null; this._paintDetail(); });

    // The new-class browser is its own window layered over this one, so the
    // rail stays a short list of what you actually play.
    this._paintPicker(s);

    // Facet picker sits above everything, including the class browser — it is
    // a decision the player is mid-way through and must resolve or dismiss.
    this._root.querySelector(`#${ROOT_ID}-facet`)?.remove();
    if (this._facet) {
      const wrap = document.createElement("div");
      wrap.innerHTML = this._facetOverlay();
      const el = wrap.firstElementChild;
      if (el) {
        // The id must land on the element actually appended, or the next
        // render cannot find it to remove and overlays stack up.
        el.id = `${ROOT_ID}-facet`;
        this._root.appendChild(el);
      }
    }
  },

  /**
   * Rebuild ONLY the class-browser overlay.
   *
   * Picking a class or switching a preview tab changes nothing in the main
   * window behind it, and rebuilding that whole window per click cost ~15ms —
   * enough to blow the frame budget once real events (sound, transitions) piled
   * on, which is the lag and the cursor desync. This touches just the overlay,
   * so the browser stays responsive no matter how fast you scroll it.
   */
  _paintPicker(s = null, { chase = false } = {}) {
    if (!this.isOpen) return;

    // Rebuilding the overlay resets the list's scroll to the top, which threw
    // you back to the top of the alphabet every time you picked a class further
    // down. Carry the position across the repaint.
    const keepScroll = this._root.querySelector(".lu-picklist")?.scrollTop ?? 0;

    // Animate only when the browser is genuinely arriving, not when an
    // unrelated full render happens to repaint it while it is already up.
    const wasUp = !!this._root.querySelector(`#${ROOT_ID}-picker`);
    this._root.querySelector(`#${ROOT_ID}-picker`)?.remove();
    if (!this._pickerOpen) { this._updateCursor(); return; }

    s = s ?? api()?.getState(this._actorUuid);
    if (!s?.ok) return;

    const p = document.createElement("div");
    p.id = `${ROOT_ID}-picker`;
    p.className = "lu-picker";
    p.innerHTML = `<div class="lu-panel lu-pickpanel">${this._picker(s)}</div>`;
    p.addEventListener("mousedown", (ev) => {
      if (ev.target === p) { sfx("deselect"); this._pickerOpen = false; this._paintPicker(); }
    });
    this._root.appendChild(p);

    const list = p.querySelector(".lu-picklist");
    if (list) list.scrollTop = keepScroll;
    if (!wasUp) {
      windowAnim(p.querySelector(".lu-pickpanel"), "in");
      // Opening the browser is itself a class page arriving.
      if (this._pickTab === "overview") {
        previewIntro(p.querySelector(".lu-pvartimg"), p.querySelector(".lu-pvtext"));
      }
    }
    // Only chase the selection when the KEYBOARD moved it. On a click the row
    // is already under the pointer, and scrolling it would slide the list out
    // from under you.
    if (chase) p.querySelector(".lu-pickrow.on")?.scrollIntoView({ block: "nearest" });
    this._updateCursor();
  },

  _head(s, proj) {
    const gate = s.gate.open
      ? `<span class="lu-tag">Spending open — ${esc(s.gate.where)}</span>`
      : `<span class="lu-tag">Viewing only</span>`;
    const staged = proj.points !== s.points.stored;
    return `<div class="lu-head">
      <img src="${esc(s.actor.img)}" alt="">
      <div class="lu-idblock">
        <div class="lu-name">${esc(s.actor.name)}</div>
        <div class="lu-sub">Level ${esc(s.level)} · ${s.classLevelTotal} class levels · ${gate}</div>
      </div>
      ${this._switches(s, proj)}
      <span class="lu-gap"></span>
      <div class="lu-sp ${staged ? "staged" : ""}"><b>${proj.points}</b>
        <span>${staged ? `Skill Points (was ${s.points.stored})` : "Skill Points"}</span></div>
      <div class="lu-tabs">
        <button class="lu-tab ${this._tab === "skill" ? "on" : ""}" data-act="tab" data-tab="skill">Skill</button>
        <button class="lu-tab ${this._tab === "facet" ? "on" : ""}" data-act="tab" data-tab="facet">Facet</button>
        <button class="lu-tab ${this._tab === "heroic" ? "on" : ""}" data-act="tab" data-tab="heroic">Heroic${
          s.heroic.open ? ` <span class="lu-tabdot">${s.heroic.open}</span>` : ""}</button>
      </div>
      <button class="lu-x" data-act="close" title="Close">×</button>
    </div>`;
  },

  _switches(s, proj) {
    const sw = (act, on, label, title) =>
      `<button class="lu-sw ${on ? "on" : ""}" data-act="${act}" title="${esc(title)}">
        <span class="lu-swtrack"><span class="lu-swknob"></span></span>${esc(label)}</button>`;

    // Nut purse, shown only in Reset mode — it is the price of that mode and
    // means nothing outside it. Counts down live as levels are staged back.
    const nuts = s.nuts ?? { count: 0 };
    const left = nuts.count - proj.refundCount;
    // Icon then count, side by side — the item is the label, so it leads.
    const purse = this._resetMode
      ? `<div class="lu-purse ${left <= 0 ? "empty" : ""}" title="${esc(nuts.name ?? "Forget me Nut")} — one per level given back">
          <img src="${esc(nuts.img ?? "")}" alt="${esc(nuts.name ?? "")}">
          <b>${left}</b>${proj.refundCount ? `<em>of ${nuts.count}</em>` : ""}
        </div>`
      : "";

    return `<div class="lu-switches">
      ${sw("toggledetail", this._detailMode, "Detail", "Show effect text on every row instead of in the panel below")}
      ${sw("togglereset", this._resetMode, "Reset", "Give skill levels back, one Forget me Nut each")}
      ${purse}
    </div>`;
  },

  _notes(s) {
    let html = "";
    if (!s.gate.open) {
      html += `<div class="lu-note warn">${esc(s.gate.reason)} You can still browse and plan.</div>`;
    }
    // Drift is a GM concern — a player can neither cause nor fix one. Hidden
    // while changes are staged: mid-edit the books legitimately don't balance,
    // and flashing a corruption warning during normal use is just noise.
    if (s.points.drift && game.user?.isGM && !this._pending.length) {
      html += `<div class="lu-note drift">
        <span>Skill Points read <b>${s.points.stored}</b> but level minus class levels gives <b>${s.points.expected}</b>.</span>
        <button class="lu-btn" style="width:auto;padding:2px 10px" data-act="heal">Fix</button>
      </div>`;
    }
    return html;
  },

  _rail(s, taken, proj) {
    const row = (c) => {
      const lvl = this._classLevel(s, c, proj);
      const moved = lvl !== c.level;
      return `<button class="lu-cls ${this._selected === c.key ? "on" : ""}" data-act="pick" data-key="${esc(c.key)}">
        <img src="${esc(c.img)}" alt="">
        <span class="n">${lvl >= s.rules.maxClassLevel ? "⭐ " : ""}${esc(c.name)}</span>
        <span class="l ${moved ? "moved" : ""}">${lvl}/${s.rules.maxClassLevel}</span>
      </button>`;
    };

    // A class chosen from the browser but not yet paid for shows here as
    // pending, so the rail still explains where the main pane came from.
    const pending = this._selected && !taken.some((c) => c.key === this._selected)
      ? s.classes.find((c) => c.key === this._selected)
      : null;

    return `<div class="lu-railhead">Classes</div>` +
      (taken.length ? taken.map(row).join("") : `<div class="lu-empty">No classes yet.</div>`) +
      (pending ? `<div class="lu-railhead">Starting</div>${row(pending)}` : "") +
      `<button class="lu-cls new" data-act="openpicker">＋ New Class</button>`;
  },

  _main(s, proj) {
    // Heroic Skills are not a property of the selected class — the pick is
    // free across every class — so that tab renders without one.
    if (this._tab === "heroic") return this._heroicTab(s);

    const cls = s.classes.find((c) => c.key === this._selected);
    if (!cls) {
      return `<div class="lu-empty">No classes yet — use <b>＋ New Class</b> to start one.</div>`;
    }

    if (this._tab === "facet") return this._facetGrid(s, cls);

    const clsLevel = this._classLevel(s, cls, proj);
    const opening = clsLevel === 0;   // staging the first level would open it
    const wouldExceedLimit =
      opening && this._projectedUnmastered(s, proj) >= s.rules.maxUnmastered;

    const skills = cls.skills.map((sk) => {
      const lvl = this._skillLevel(sk, proj);
      const moved = lvl !== sk.level;
      const atMax = lvl >= sk.maxLevel;
      const canBuy = s.gate.open && proj.points > 0 && !atMax
        && clsLevel < s.rules.maxClassLevel && !wouldExceedLimit;

      // Each level given back costs one Forget me Nut, from this character's
      // own bag. Staged refunds already count against the purse, so the button
      // stops at the point the batch would outspend it rather than failing at
      // Confirm.
      const nutsLeft = (s.nuts?.count ?? 0) - proj.refundCount;
      const outOfNuts = nutsLeft <= 0;
      const canRefund = s.gate.open && lvl > 0 && !outOfNuts;
      const refundTitle = lvl <= 0 ? "Nothing to give back"
        : outOfNuts ? `No ${s.nuts?.name ?? "Forget me Nut"} left — one is needed per level`
        : `Give back a level — costs 1 ${s.nuts?.name ?? "Forget me Nut"}`;
      return this._row({
        uuid: sk.uuid, img: sk.img, name: sk.name,
        cls: `${atMax ? "max" : ""} ${lvl === 0 ? "miss" : ""}`,
        detail: {
          name: sk.name, img: sk.img, cost: sk.cost,
          meta: `${lvl} / ${sk.maxLevel}${sk.facetGrant ? ` · grants ${sk.facetGrant} Facet${sk.facetGrant === 1 ? "" : "s"} per level` : ""}`,
          description: sk.description,
        },
        // The − only exists in Reset mode; the + stays put but goes inert, so
        // the row keeps its shape instead of reflowing when the mode flips.
        right:
          (this._resetMode
            ? `<button class="lu-btn sell" data-act="refund" data-key="${esc(cls.key)}" data-uuid="${esc(sk.uuid)}"
                ${canRefund ? "" : "disabled"} title="${esc(refundTitle)}">−</button>`
            : "") +
          `<span class="lu-pips ${moved ? "moved" : ""}">${lvl} / ${sk.maxLevel}</span>` +
          this._facetEditBtn(sk) +
          `<button class="lu-btn buy" data-act="spend" data-key="${esc(cls.key)}" data-uuid="${esc(sk.uuid)}"
            ${canBuy && !this._resetMode ? "" : "disabled"} title="Spend a Skill Point">+</button>`,
      });
    }).join("");

    const mastered = clsLevel >= s.rules.maxClassLevel;
    const note = wouldExceedLimit
      ? `<div class="lu-note warn" style="border-radius:7px;margin-bottom:10px">You already have ${s.rules.maxUnmastered} unmastered classes — take one to level 10 before starting another.</div>`
      : opening
        ? `<div class="lu-lore">You don't have this class yet — buying any skill below starts it at level 1.</div>`
        : "";

    return `<div class="lu-h2"><b>${mastered ? "⭐ " : ""}${esc(cls.name)}</b>
        <span>${clsLevel}/${s.rules.maxClassLevel}${mastered ? " · mastered" : ""}${cls.benefit ? ` · ${esc(LEVELUP.BENEFIT_LABEL[cls.benefit] ?? cls.benefit)}` : ""}</span></div>
      ${note}
      ${skills || `<div class="lu-empty">This class has no skills authored.</div>`}`;
  },

  // Revisit a Facet choice that is staged but not yet written. Only offered
  // while the batch is unconfirmed — afterwards the items exist on the sheet
  // and are the GM's to manage.
  _facetEditBtn(sk) {
    const idx = this._pending.findIndex(
      (p) => p.skillUuid === sk.uuid && Array.isArray(p.facetUuids) && p.facetUuids.length
    );
    if (idx < 0) return "";
    const n = this._pending[idx].facetUuids.length;
    return `<button class="lu-btn edit" data-act="facetedit" data-idx="${idx}"
      title="Change the ${n === 1 ? "chosen one" : `${n} chosen`}">✎</button>`;
  },

  _footer(s, proj) {
    const n = this._pending.length;
    if (!n) return "";
    const summary = this._summarise(s, proj);
    return `<div class="lu-foot">
      <span class="lu-foottext">${esc(summary)}</span>
      <button class="lu-cta ghost" data-act="cancel" title="Throw away the staged changes and keep the window open">Discard</button>
      <button class="lu-cta go" data-act="confirm">Confirm ${n} change${n === 1 ? "" : "s"}</button>
    </div>`;
  },

  _summarise(s, proj) {
    const bits = [];
    for (const [key, d] of proj.classDelta) {
      if (!d) continue;
      const c = s.classes.find((x) => x.key === key);
      bits.push(`${c?.name ?? key} ${c ? c.level : 0} → ${this._classLevel(s, c ?? { key, level: 0 }, proj)}`);
    }
    for (const p of proj.heroics) bits.push(`Heroic: ${p.name ?? "skill"}`);
    const facetsIn = this._pending.filter((p) => p.op === "spend").flatMap((p) => p.facetUuids ?? []).length;
    const facetsOut = this._pending.filter((p) => p.op === "refund").flatMap((p) => p.facetUuids ?? []).length;
    if (facetsIn) bits.push(`+${facetsIn} facet${facetsIn === 1 ? "" : "s"}`);
    if (facetsOut) bits.push(`−${facetsOut} facet${facetsOut === 1 ? "" : "s"}`);
    const spent = s.points.stored - proj.points;
    const cost = spent > 0 ? `${spent} point${spent === 1 ? "" : "s"} spent` : `${-spent} point${spent === -1 ? "" : "s"} returned`;
    return `${bits.join(" · ")}  —  ${cost}`;
  },

  /**
   * Every Facet the class offers, learned ones first and at full strength,
   * the rest dimmed underneath — a collection board rather than a list, so a
   * player can see at a glance how much of a class they have collected.
   *
   * Read-only. Facets are acquired by taking a level in the skill that grants
   * them, never picked directly, so there is nothing to click here.
   */
  _facetGrid(s, cls) {
    const staged = new Set(
      this._pending.filter((p) => p.op === "spend").flatMap((p) => p.facetUuids ?? [])
    );
    const givingBack = new Set(
      this._pending.filter((p) => p.op === "refund").flatMap((p) => p.facetUuids ?? [])
    );

    if (!cls.facets.length) {
      return `<div class="lu-h2"><b>${esc(cls.name)}</b><span>Facets</span></div>
        <div class="lu-empty">This class has no Facets.</div>`;
    }

    const rank = (f) => {
      if (staged.has(f.uuid)) return 0;                      // about to be learned
      if (f.held) return givingBack.has(f.uuid) ? 2 : 1;     // held, or handing back
      return 3;                                              // not learned
    };
    const sorted = [...cls.facets].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const have = cls.facets.filter((f) => (f.held && !givingBack.has(f.uuid)) || staged.has(f.uuid)).length;

    // Same one-column row as the skill list — this is the same kind of thing
    // being read, and two layouts for one class would just look like two pages.
    const row = (f) => {
      const r = rank(f);
      const tag = r === 0 ? "staged" : r === 2 ? "giving back" : "";
      return this._row({
        uuid: f.uuid, img: f.img, name: f.name, tag,
        cls: r <= 1 ? "have" : r === 2 ? "away" : "miss",
        detail: { name: f.name, img: f.img, cost: f.cost, description: f.description,
          meta: r <= 1 ? "Learned" : "Not learned" },
        right: r <= 1 ? `<span class="lu-learned">Learned</span>` : "",
      });
    };

    const learned = sorted.filter((f) => rank(f) <= 1);
    const rest = sorted.filter((f) => rank(f) > 1);

    // The grant is what a player needs to know to collect more of these.
    const granter = cls.skills.find((k) => k.facetGrant > 0);
    const hint = granter
      ? `<div class="lu-lore">Learned by taking levels in <b>${esc(granter.name)}</b> — ${granter.facetGrant} per level.</div>`
      : `<div class="lu-lore">This class has no skill that grants Facets; these are acquired elsewhere.</div>`;

    return `<div class="lu-h2"><b>${esc(cls.name)}</b><span>${have} of ${cls.facets.length} learned</span></div>
      ${hint}
      ${learned.map(row).join("")}
      ${rest.length && learned.length ? `<div class="lu-railhead" style="margin:10px 2px 5px">Not yet learned</div>` : ""}
      ${rest.map(row).join("")}`;
  },

  /**
   * The Heroic tab: what the character has, then what they could take, then
   * what is out of reach — the same unlockable shape as the Facet board.
   *
   * Not scoped to the selected class. Mastering a class earns the pick but does
   * not limit it (§4 of the design doc), so this is a character-wide view.
   */
  _heroicTab(s) {
    const { open, earned, used, available, owned } = s.heroic;

    const head = `<div class="lu-h2"><b>Heroic Skills</b>
      <span>${earned ? `${open} of ${earned} slot${earned === 1 ? "" : "s"} open · ${used} taken`
                     : "master a class to earn one"}</span></div>`;

    const learnedRows = (owned ?? []).map((h) => this._row({
      uuid: h.uuid, img: h.img, name: h.name, tag: h.from, cls: "have",
      detail: { name: h.name, img: h.img, cost: h.cost, meta: "Learned", description: h.description },
      right: `<span class="lu-learned">Learned</span>`,
    })).join("");

    const met = available.filter((h) => h.relevance === "met");
    const close = available.filter((h) => h.relevance === "close");
    const distant = available.filter((h) => h.relevance === "distant");

    const takeable = open
      ? this._heroicRows(s, met)
      : met.length
        ? `<div class="lu-empty">${met.length} would be available — master another class to earn a slot.</div>`
        : "";

    const noneMet = open && !met.length
      ? `<div class="lu-empty">A slot is open, but you don't yet meet the requirements for any Heroic Skill.</div>`
      : "";

    return head +
      (learnedRows || `<div class="lu-empty">No Heroic Skills yet.</div>`) +
      (met.length && open ? `<div class="lu-railhead" style="margin:12px 2px 5px">Available now</div>` : "") +
      noneMet + takeable +
      (close.length ? `<div class="lu-railhead" style="margin:12px 2px 5px">Not yet available</div>` : "") +
      this._heroicRows(s, close) +
      (distant.length ? `<div class="lu-empty">${distant.length} more need classes you haven't taken.</div>` : "");
  },

  _heroicRows(s, list) {
    return list.map((h) => {
      const from = h.from.map((f) => f.name).join(" / ");
      const req = !h.evaluable
        ? `<p class="lu-req">Requirement needs a GM: “${esc(h.prose)}”</p>`
        : h.met ? "" : `<p class="lu-req">Needs: ${h.clauses.filter((c) => !c.met).map((c) => esc(c.label)).join(" · ")}</p>`;
      const staged = this._pending.some((p) => p.op === "heroic" && p.skillUuid === h.skill.uuid);
      // Taking a Heroic is an increase, so Reset mode has nothing to offer here.
      const canTake = s.gate.open && !this._resetMode && h.met && (s.heroic.open > 0 || staged);
      return this._row({
        uuid: h.skill.uuid, img: h.skill.img, name: h.skill.name, tag: from,
        cls: staged ? "have" : h.met ? "" : "miss",
        detail: {
          name: h.skill.name, img: h.skill.img, cost: h.skill.cost,
          meta: staged ? "staged" : h.met ? "Available" : "Not yet available",
          description: h.skill.description,
          note: req,   // the unmet-requirement lines belong with the full text
        },
        right: `<button class="lu-btn buy" data-act="heroic" data-uuid="${esc(h.skill.uuid)}" data-name="${esc(h.skill.name)}"
          ${canTake ? "" : "disabled"} title="${staged ? "Un-stage" : "Take this Heroic Skill (free)"}">${staged ? "✓" : "★"}</button>`,
      });
    }).join("");
  },

  // Secondary window. Kept out of the rail on purpose — 42 classes would bury
  // the four or five a character actually plays.
  //
  // Browse on the right, preview on the left, commit with the button. Picking a
  // class is a real decision (it costs a point and counts against the
  // three-unmastered limit), so it gets a look before it gets a click.
  _picker(s) {
    const untaken = s.classes.filter((c) => !c.taken).sort((a, b) => a.name.localeCompare(b.name));
    const atLimit = s.unmastered >= s.rules.maxUnmastered;

    if (!this._pickSel || !untaken.some((c) => c.key === this._pickSel)) {
      this._pickSel = untaken[0]?.key ?? null;
    }
    const sel = untaken.find((c) => c.key === this._pickSel) ?? null;
    const hasUnique = !!plain(sel?.mechanic).length;
    if (this._pickTab === "unique" && !hasUnique) this._pickTab = "overview";

    const tab = (id, label, on = true) =>
      `<button class="lu-tab ${this._pickTab === id ? "on" : ""}" data-act="picktab" data-tab="${id}"
        ${on ? "" : "disabled"}>${esc(label)}</button>`;

    const list = ["Classic Classes", "Custom Classes"].map((folder) => {
      const rows = untaken.filter((c) => c.folder === folder).map((c) => `
        <button class="lu-pickrow ${this._pickSel === c.key ? "on" : ""}" data-act="pickselect" data-key="${esc(c.key)}">
          <i class="fa-solid ${esc(classIcon(c.key))}"></i><span>${esc(c.name)}</span>
        </button>`).join("");
      return rows ? `<div class="lu-railhead">${esc(folder)}</div>${rows}` : "";
    }).join("");

    return `<div class="lu-head">
        <div class="lu-idblock">
          <div class="lu-name">Start a New Class</div>
          <div class="lu-sub">${untaken.length} available · your first level in a class grants one of its skills</div>
        </div>
        <button class="lu-x" data-act="closepicker" title="Back">×</button>
        <div class="lu-tabs lu-picktabs">
          ${tab("overview", "Overview")}
          ${tab("skill", "Skill")}
          ${tab("unique", "Unique", hasUnique)}
        </div>
      </div>
      ${atLimit ? `<div class="lu-note warn">You have ${s.unmastered} unmastered classes and the limit is
         ${s.rules.maxUnmastered}. Take one of them to level 10 before starting another.</div>` : ""}
      <div class="lu-pickbody">
        <div class="lu-previewwrap">${this._previewWrap(sel, atLimit)}</div>
        <div class="lu-picklist">${list || `<div class="lu-empty">You already have every class.</div>`}</div>
      </div>`;
  },

  /** Preview pane + its docked button — the only part that changes on select. */
  _previewWrap(sel, atLimit) {
    return `<div class="lu-preview">${this._pickPreview(sel, atLimit)}</div>
      ${sel ? `<div class="lu-pickfoot">
        <button class="lu-cta go lu-pvgo" data-act="pick" data-key="${esc(sel.key)}" ${atLimit ? "disabled" : ""}>
          Start ${esc(sel.name)}</button>
      </div>` : ""}`;
  },

  /**
   * Repaint ONLY the preview pane, leaving the 42-row class list in place.
   *
   * Selecting a class changes which row is highlighted and what the preview
   * shows — the list itself is identical. Rebuilding it was both the bulk of
   * the remaining ~13ms per click AND the reason the list snapped back to the
   * top: a fresh list starts at scrollTop 0. Not touching it fixes both.
   */
  _paintPreview({ chase = false, intro = false } = {}) {
    const p = this._root?.querySelector(`#${ROOT_ID}-picker`);
    if (!p) return;
    const s = api()?.getState(this._actorUuid);
    if (!s?.ok) return;

    const untaken = s.classes.filter((c) => !c.taken).sort((a, b) => a.name.localeCompare(b.name));
    const sel = untaken.find((c) => c.key === this._pickSel) ?? null;
    const atLimit = s.unmastered >= s.rules.maxUnmastered;

    // A class with no Unique Mechanic must not leave that tab selected.
    if (this._pickTab === "unique" && !plain(sel?.mechanic).length) this._pickTab = "overview";

    for (const row of p.querySelectorAll(".lu-pickrow")) {
      row.classList.toggle("on", row.dataset.key === this._pickSel);
    }
    for (const t of p.querySelectorAll(".lu-picktabs [data-act='picktab']")) {
      t.classList.toggle("on", t.dataset.tab === this._pickTab);
      if (t.dataset.tab === "unique") t.disabled = !plain(sel?.mechanic).length;
    }
    const wrap = p.querySelector(".lu-previewwrap");
    if (wrap) {
      wrap.innerHTML = this._previewWrap(sel, atLimit);
      // Only the Overview is a "class page" — the Skill and Unique tabs are
      // reference material you flip to, and re-animating them would put a
      // 700ms wait in front of text you are trying to read.
      if (intro && this._pickTab === "overview") {
        previewIntro(wrap.querySelector(".lu-pvartimg"), wrap.querySelector(".lu-pvtext"));
      }
    }

    if (chase) p.querySelector(".lu-pickrow.on")?.scrollIntoView({ block: "nearest" });
    this._updateCursor();
  },

  _pickPreview(c, atLimit) {
    if (!c) return `<div class="lu-empty">No classes left to start.</div>`;

    if (this._pickTab === "unique") {
      return `<div class="lu-pvhead"><b>${esc(c.name)}</b><span>Unique Mechanic</span></div>
        <div class="lu-pvscroll">${describe(c.mechanic, { clamp: false })}</div>`;
    }

    if (this._pickTab === "skill") {
      // Facets stay a visible sub-tab even with none authored — disabled says
      // "this class has none", a missing tab says nothing at all.
      const hasFacets = c.facets.length > 0;
      const sub = (this._pickSub === "facet" && hasFacets) ? "facet" : "skill";

      const rows = (sub === "facet" ? c.facets : c.skills).map((k) => `
        <div class="lu-pvrow">
          <img src="${esc(k.img)}" alt="">
          <div class="t">
            <span class="lu-pvtitle">
              <b>${esc(k.name)}</b>
              <span class="lu-gap"></span>
              ${k.cost ? `<span class="lu-tag">${esc(k.cost)}</span>` : ""}
              ${sub === "skill" ? `<span class="lu-maxlv" title="Maximum Skill Level">◆${k.maxLevel}</span>` : ""}
            </span>
            ${describe(k.description)}
          </div>
        </div>`).join("");

      const free = [
        c.free?.martialMelee && "martial melee", c.free?.martialRanged && "martial ranged",
        c.free?.martialArmor && "martial armor", c.free?.martialShield && "martial shields",
        c.free?.ritual && "rituals", c.free?.project && "projects",
      ].filter(Boolean);

      return `<div class="lu-pvhead"><b>${esc(c.name)}</b>
          <span>${c.skills.length} skills · ${c.facets.length} facets</span></div>
        <div class="lu-pvfree">
          <b>Free benefit:</b> ${esc(c.benefit ? (LEVELUP.BENEFIT_LABEL[c.benefit] ?? c.benefit) : "you choose HP / MP / IP")}
          ${free.length ? ` · equips ${esc(free.join(", "))}` : ""}
        </div>
        <div class="lu-subtabs">
          <button class="lu-subtab ${sub === "skill" ? "on" : ""}" data-act="picksub" data-sub="skill">Skills</button>
          <button class="lu-subtab ${sub === "facet" ? "on" : ""}" data-act="picksub" data-sub="facet"
            ${hasFacets ? "" : "disabled"} title="${hasFacets ? "" : "This class has no Facets"}">Facets</button>
        </div>
        <div class="lu-pvscroll">${rows || `<div class="lu-empty">Nothing authored for this class.</div>`}</div>`;
    }

    // Overview — the art IS the page. Everything else floats over it, which is
    // why each overlay carries its own glow/stroke rather than a flat colour.
    const meta = CLASS_META_DEFAULT;
    const stars = Array.from({ length: meta.difficultyMax }, (_, i) =>
      `<i class="fa-solid fa-star ${i < meta.difficulty ? "on" : ""}"></i>`).join("");

    // Art and text are separate layers so the entrance can bring the portrait
    // in first and the prose in after it — they cannot animate apart while the
    // text sits inside the element carrying the image.
    return `<div class="lu-pvart">
        <div class="lu-pvartimg" style="background-image:url('${esc(c.img)}')"></div>
        <div class="lu-pvtext">
          <div class="lu-pvname">${esc(c.name)}</div>
          ${c.also ? `<div class="lu-pvalso"><i>Also known as</i> ${esc(c.also)}</div>` : ""}
          ${plain(c.flavor).length ? `<div class="lu-pvflavor lu-rt">${renderDescription(c.flavor).bodyHtml}</div>` : ""}
          ${plain(c.lore).length ? `<div class="lu-pvlore">${describe(c.lore, { clamp: false })}</div>` : ""}
          <div class="lu-pvmeta">
            <div><span>Difficulty:</span> <span class="lu-stars">${stars}</span></div>
            <div><span>Role:</span> ${meta.roles.map((r) => `<span class="lu-role">${esc(r)}</span>`).join("")}</div>
          </div>
        </div>
      </div>`;
  },

  // ── interaction ─────────────────────────────────────────────────────────

  async _onClick(ev) {
    const btn = ev.target.closest("[data-act]");
    if (!btn || this._busy) return;
    const act = btn.dataset.act;

    if (act === "close") return this.close();
    if (act === "tab") {
      if (btn.dataset.tab === this._tab) return;
      sfx("tab");
      this._tab = btn.dataset.tab;
      this._pinned = null; this._hover = null;   // details belong to the old list
      return this._swapList();
    }
    if (act === "pin" || act === "unpin") {
      const u = act === "unpin" ? null : btn.dataset.detail;
      const next = (act === "pin" && this._pinned === u) ? null : u;   // click again to release
      // Selecting and deselecting are different actions and get different
      // cues — decided from the RESULT, since clicking a pinned row unpins it.
      sfx(next ? "toggle" : "deselect");
      this._pinned = next;
      // Repaint in place rather than re-rendering: pinning changes one border
      // and one panel, and a full rebuild would drop the reader back to the
      // top of the list they were half-way down.
      for (const row of this._root.querySelectorAll(".lu-row")) {
        row.classList.toggle("pinned", row.dataset.detail === this._pinned);
      }
      this._paintDetail();
      return;
    }
    if (act === "toggledetail") {
      sfx("toggle");
      this._detailMode = !this._detailMode;
      return this._swapList();
    }
    if (act === "togglereset") {
      sfx("toggle");
      this._resetMode = !this._resetMode;
      return this.render();
    }
    // Opening/closing the browser toggles what covers the main window, so those
    // need a full render. Everything WITHIN the browser repaints only the
    // overlay — cheap, and it keeps the window behind untouched.
    if (act === "openpicker") { sfx("open"); this._pickerOpen = true; return this.render(); }
    if (act === "closepicker") { sfx("deselect"); this._pickerOpen = false; return this.render(); }
    if (act === "picktab") { sfx("tab"); this._pickTab = btn.dataset.tab; return this._paintPreview(); }
    if (act === "picksub") { sfx("toggle"); this._pickSub = btn.dataset.sub; return this._paintPreview(); }
    if (act === "pickselect") {
      if (this._pickSel === btn.dataset.key) return;
      sfx("classPage");
      this._pickSel = btn.dataset.key;
      return this._paintPreview({ intro: true });
    }
    if (act === "pick") {
      const changed = this._selected !== btn.dataset.key;
      // Changing class re-frames the whole window, so it gets the heavier
      // window-open cue rather than the lighter tab blip.
      if (changed) sfx("open");
      this._selected = btn.dataset.key;
      this._pickerOpen = false;   // choosing from the browser returns to the main pane
      return changed ? this._swapList() : this.render();
    }

    // Staging — no writes. A spend and a refund of the same skill annihilate,
    // so clicking + then − leaves nothing queued rather than two no-ops that
    // would both hit the actor on Confirm.
    if (act === "spend" || act === "refund") {
      // Cue the button that was pressed, including when it cancels an opposing
      // staged op — the sound should follow the click, not the net result.
      sfx(act === "spend" ? "stageUp" : "stageDown");
      const opposite = act === "spend" ? "refund" : "spend";
      const i = this._pending.findIndex(
        (p) => p.op === opposite && p.skillUuid === btn.dataset.uuid && p.classKey === btn.dataset.key
      );
      if (i >= 0) { this._pending.splice(i, 1); return this.render(); }

      // Skills that award Facets ask which, at stage time rather than during
      // Confirm — a batch that stops to ask questions halfway through is worse
      // than one that asked up front. The picker stages the operation itself.
      if (this._openFacetPicker(act, btn.dataset.key, btn.dataset.uuid)) return;

      this._pending.push({ op: act, classKey: btn.dataset.key, skillUuid: btn.dataset.uuid });
      return this.render();
    }

    // ── facet picker ──────────────────────────────────────────────────────
    if (act === "facettoggle") {
      const f = this._facet;
      if (!f) return;
      const u = btn.dataset.uuid;
      const at = f.selected.indexOf(u);
      if (at >= 0) f.selected.splice(at, 1);           // re-click deselects
      else if (f.selected.length < f.need) f.selected.push(u);
      else { f.selected.shift(); f.selected.push(u); } // full: oldest drops out
      // Advance only once the player has nothing left to decide.
      if (f.selected.length === f.need) f.stage = "confirm";
      return this.render();
    }
    if (act === "facetback") {
      // Back clears the selection and starts the choice over, rather than
      // returning to a full basket the player has already second-guessed.
      this._facet.selected = [];
      this._facet.stage = "pick";
      return this.render();
    }
    if (act === "facetcancel") {
      // A Facet grant cannot be left unresolved: either the player chooses, or
      // the level is not taken at all. Half-taking it — a level with the grant
      // skipped — is precisely the drift the picker exists to prevent.
      // Editing is different: a complete choice already exists, so backing out
      // simply keeps it.
      this._facet = null;
      return this.render();
    }
    if (act === "facetok") {
      const f = this._facet;
      this._facet = null;
      if (f) {
        if (f.editIndex >= 0) this._pending[f.editIndex].facetUuids = f.selected;
        else this._pending.push({
          op: f.act, classKey: f.classKey, skillUuid: f.skillUuid, facetUuids: f.selected,
        });
      }
      return this.render();
    }
    if (act === "facetedit") {
      const idx = Number(btn.dataset.idx);
      const p = this._pending[idx];
      if (p) this._openFacetPicker(p.op, p.classKey, p.skillUuid, idx);
      return;
    }

    if (act === "heroic") {
      const i = this._pending.findIndex((p) => p.op === "heroic" && p.skillUuid === btn.dataset.uuid);
      if (i >= 0) this._pending.splice(i, 1);
      else this._pending.push({ op: "heroic", skillUuid: btn.dataset.uuid, name: btn.dataset.name });
      return this.render();
    }

    if (act === "cancel") { this._pending = []; return this.render(); }
    if (act === "confirm") return this._commit();

    const A = api();
    if (!A) return;
    this._busy = true;
    btn.disabled = true;
    try {
      if (act === "heal") {
        const res = await A.healPoints(this._actorUuid);
        if (res && !res.ok) ui.notifications?.warn?.(explain(res));
      }
    } finally {
      this._busy = false;
      this.render();
    }
  },

  /**
   * Write the staged operations, in order.
   *
   * Refunds go first: they free Skill Points that later spends may rely on, and
   * they relax the three-unmastered-class limit. Staging "drop Dancer, start
   * Guardian" with only one point has to work.
   *
   * On the first failure the rest are abandoned and left staged, so the window
   * shows exactly what did not go through. Each operation is individually
   * atomic GM-side, so a partial apply is a coherent state, not a corrupt one.
   */
  async _commit() {
    const A = api();
    if (!A || !this._pending.length) return;

    const ordered = [
      ...this._pending.filter((p) => p.op === "refund"),
      ...this._pending.filter((p) => p.op === "spend"),
      ...this._pending.filter((p) => p.op === "heroic"),
    ];

    this._applying = true;   // suppress re-render while the books are unbalanced
    this._busy = true;
    let mastered = false;
    const gained = [], lost = [];   // skill uuids, for the celebration afterwards

    try {
      for (let i = 0; i < ordered.length; i++) {
        const p = ordered[i];
        let res;
        if (p.op === "refund") {
          res = await A.refundPoint({
            actorUuid: this._actorUuid, classKey: p.classKey, skillUuid: p.skillUuid,
            facetUuids: p.facetUuids,
          });
          if (res?.ok) lost.push(p.skillUuid);
        } else if (p.op === "spend") {
          res = await A.spendPoint({
            actorUuid: this._actorUuid, classKey: p.classKey, skillUuid: p.skillUuid,
            benefit: p.benefit ?? await this._benefitFor(p.classKey),
            facetUuids: p.facetUuids,
          });
          if (res?.ok && res.mastered) mastered = true;
          if (res?.ok) gained.push(p.skillUuid);
        } else {
          res = await A.pickHeroic({ actorUuid: this._actorUuid, skillUuid: p.skillUuid });
        }

        if (!res?.ok) {
          this._pending = ordered.slice(i);   // keep what didn't apply
          ui.notifications?.warn?.(explain(res));
          return;
        }
      }
      this._pending = [];
      if (mastered) ui.notifications?.info?.("Class mastered — a Heroic Skill slot is open.");
    } catch (e) {
      console.error(LEVELUP.TAG, e);
      ui.notifications?.error?.("Level-up failed — see console.");
    } finally {
      this._applying = false;
      this._busy = false;
      this.render();
      this._celebrate(gained, lost);
    }
  },

  /**
   * The payoff. Bursts on every row that moved, and one cue for the batch.
   *
   * A batch can both spend and refund — trading a level from one skill into
   * another — and playing both cues over each other sounds like a mistake. The
   * gain wins: it is the outcome the player was after.
   */
  _celebrate(gained, lost) {
    if (!this.isOpen) return;
    // Wait a frame so the re-rendered rows have their final positions; the
    // particles are placed against the viewport and would otherwise aim at
    // where a row used to be.
    requestAnimationFrame(() => {
      const find = (uuid) => this._root?.querySelector(`.lu-row[data-detail="${CSS.escape(uuid)}"]`);
      for (const u of gained) burst(find(u), { kind: "up" });
      for (const u of lost) burst(find(u), { kind: "down" });
      if (gained.length) sfx("levelUp");
      else if (lost.length) sfx("levelDown");
    });
  },

  /**
   * Open the Facet picker for a spend/refund, or to edit an already-staged
   * choice. Returns false when the skill grants no Facets, so the caller stages
   * the operation immediately as normal.
   *
   * `editIndex` points at an entry in `_pending` whose choice is being revised;
   * otherwise the picker stages a NEW operation on confirm.
   */
  _openFacetPicker(act, classKey, skillUuid, editIndex = -1) {
    const s = api()?.getState(this._actorUuid);
    const cls = s?.classes?.find((c) => c.key === classKey);
    const skill = cls?.skills?.find((k) => k.uuid === skillUuid);
    if (!cls || !skill || !skill.facetGrant) return false;

    // Facets spoken for by OTHER staged operations are unavailable, so taking
    // Dance twice in one batch cannot offer the same dance both times. The
    // entry being edited is excluded from that set — its own picks stay
    // selectable.
    const spoken = new Set(
      this._pending
        .filter((p, i) => i !== editIndex && p.op === act)
        .flatMap((p) => p.facetUuids ?? [])
    );
    const pool = cls.facets.filter((f) =>
      (act === "spend" ? !f.held : f.held) && !spoken.has(f.uuid)
    );
    if (!pool.length) return false;

    const need = Math.min(act === "spend" ? skill.facetGrant : 1, pool.length);
    this._facet = {
      act, classKey, skillUuid, editIndex,
      className: cls.name, skillName: skill.name,
      need,
      pool: pool.map((f) => ({
        uuid: f.uuid, name: f.name, cost: f.cost, description: f.description, img: f.img,
      })),
      selected: editIndex >= 0 ? [...(this._pending[editIndex].facetUuids ?? [])] : [],
      // Auto-advance to the confirmation only ever fires from a toggle, so
      // opening the editor on an already-complete choice stays on the picker.
      stage: "pick",
    };
    this.render();
    return true;
  },

  /**
   * One list row: icon, name, and whatever control belongs on the right.
   *
   * Registers the row's detail so the panel below can show it, and marks the
   * row as a pin target. Nested buttons carry their own `data-act`, and
   * `closest()` finds the nearest one, so clicking + or − never pins by
   * accident.
   */
  _row({ uuid, img, name, tag, right, cls = "", detail }) {
    if (detail) this._details.set(uuid, detail);
    const pinned = this._pinned === uuid;

    // Detail mode puts the effect text back on every row. Same row, same
    // controls — the description simply moves from the panel into the row, so
    // both layouts stay one code path rather than two that drift apart.
    if (this._detailMode) {
      return `<div class="lu-row wide ${cls} ${pinned ? "pinned" : ""}" data-act="pin" data-detail="${esc(uuid)}">
        <img src="${esc(img)}" alt="">
        <div class="lu-rtext">
          <span class="lu-rtitle"><b>${esc(name)}</b>
            ${tag ? `<span class="lu-tag">${esc(tag)}</span>` : ""}
            ${detail?.cost ? `<span class="lu-tag">${esc(detail.cost)}</span>` : ""}</span>
          ${describe(detail?.description)}${detail?.note ?? ""}
        </div>
        ${right ?? ""}
      </div>`;
    }

    return `<div class="lu-row ${cls} ${pinned ? "pinned" : ""}" data-act="pin" data-detail="${esc(uuid)}">
      <img src="${esc(img)}" alt="">
      <b>${esc(name)}</b>
      ${tag ? `<span class="lu-tag">${esc(tag)}</span>` : ""}
      <span class="lu-gap"></span>
      ${right ?? ""}
    </div>`;
  },

  _detailHTML() {
    const d = this._details.get(this._pinned ?? this._hover);
    if (!d) {
      return `<div class="lu-dempty">Hover a row for its details — click to keep it here.</div>`;
    }
    const pinned = !!this._pinned;
    return `<div class="lu-dhead">
        <img src="${esc(d.img)}" alt="">
        <b>${esc(d.name)}</b>
        ${d.cost ? `<span class="lu-tag">${esc(d.cost)}</span>` : ""}
        ${d.meta ? `<span class="lu-tag">${esc(d.meta)}</span>` : ""}
        <span class="lu-gap"></span>
        ${pinned ? `<button class="lu-btn" data-act="unpin" title="Unpin">📌</button>` : ""}
      </div>
      <div class="lu-dbody">${describe(d.description, { clamp: false })}${d.note ?? ""}</div>`;
  },

  // ── keyboard ────────────────────────────────────────────────────────────

  _installKeyboard() {
    this._onKey = (ev) => {
      if (!this.isOpen || this._busy) return;

      const all = [...KEYS.UP, ...KEYS.DOWN, ...KEYS.LEFT, ...KEYS.RIGHT,
                   ...KEYS.CONFIRM, ...KEYS.CANCEL, ...KEYS.TAB_NEXT, ...KEYS.TAB_PREV];
      if (!all.includes(ev.key)) return;
      // Swallow while the window owns the screen, so arrows don't also pan the
      // canvas and Tab doesn't walk Foundry's own focus ring.
      ev.preventDefault();
      ev.stopPropagation();

      // A layered picker gets the keys first — it is the question in front of
      // the player, and the list behind it is not what they are answering.
      if (this._facet) {
        if (keyMatch(ev, KEYS.CANCEL)) {
          sfx("deselect");
          this._facet = null;   // same as its Cancel: stage nothing
          this.render();
        }
        return;
      }
      if (this._pickerOpen) return void this._pickerKey(ev);

      if (keyMatch(ev, KEYS.CANCEL)) return void this.close();
      if (keyMatch(ev, KEYS.TAB_NEXT)) return void this._cycleTab(1);
      if (keyMatch(ev, KEYS.TAB_PREV)) return void this._cycleTab(-1);
      if (keyMatch(ev, KEYS.CONFIRM)) return void this._activate();

      const dy = keyMatch(ev, KEYS.DOWN) ? 1 : keyMatch(ev, KEYS.UP) ? -1 : 0;
      const dx = keyMatch(ev, KEYS.RIGHT) ? 1 : keyMatch(ev, KEYS.LEFT) ? -1 : 0;
      this._move(dx, dy);
    };
    window.addEventListener("keydown", this._onKey, true);
  },

  /**
   * Keyboard inside the class browser. Same vocabulary as the main window:
   * arrows move, Z commits, X backs out, Q/E cycle the preview tabs.
   *
   * The class list is the only navigable column, so up/down walk it and the
   * preview follows — the preview is a consequence of the selection, never a
   * separate place to be.
   */
  _pickerKey(ev) {
    if (keyMatch(ev, KEYS.CANCEL)) {
      sfx("deselect");
      this._pickerOpen = false;
      return this.render();
    }
    if (keyMatch(ev, KEYS.CONFIRM)) {
      const go = this._root?.querySelector(".lu-pvgo:not([disabled])");
      if (go) go.click();
      return;
    }

    // Q/E and left/right both cycle the preview tabs; a disabled Unique tab is
    // skipped rather than landed on.
    const tabs = ["overview", "skill", "unique"];
    const usable = tabs.filter((t) => !this._root?.querySelector(`[data-act="picktab"][data-tab="${t}"][disabled]`));
    const cycle = (dir) => {
      const i = usable.indexOf(this._pickTab);
      const next = usable[(Math.max(0, i) + dir + usable.length) % usable.length];
      if (next === this._pickTab) return;
      sfx("tab"); this._pickTab = next; this._paintPreview();
    };
    if (keyMatch(ev, KEYS.TAB_NEXT) || keyMatch(ev, KEYS.RIGHT)) return cycle(1);
    if (keyMatch(ev, KEYS.TAB_PREV) || keyMatch(ev, KEYS.LEFT)) return cycle(-1);

    const dy = keyMatch(ev, KEYS.DOWN) ? 1 : keyMatch(ev, KEYS.UP) ? -1 : 0;
    if (!dy) return;
    const rows = Array.from(this._root?.querySelectorAll(".lu-pickrow") ?? []);
    const at = rows.findIndex((r) => r.dataset.key === this._pickSel);
    const next = rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + dy))];
    if (!next || next.dataset.key === this._pickSel) return;   // silent at the ends
    sfx("classPage");
    this._pickSel = next.dataset.key;
    this._paintPreview({ chase: true, intro: true });
  },

  _cycleTab(dir) {
    const tabs = ["skill", "facet", "heroic"];
    const i = (tabs.indexOf(this._tab) + dir + tabs.length) % tabs.length;
    sfx("tab");
    this._tab = tabs[i];
    this._pinned = null; this._rowIdx = 0;
    this._swapList();
  },

  _rows() { return Array.from(this._root?.querySelectorAll(".lu-main .lu-row") ?? []); },
  _railBtns() { return Array.from(this._root?.querySelectorAll(".lu-rail [data-act]") ?? []); },
  _footBtns() { return Array.from(this._root?.querySelectorAll(".lu-foot [data-act]") ?? []); },
  // Header controls, in reading order: the two mode switches then the tabs.
  // Close is deliberately excluded — X already closes, and putting it one
  // arrow-press past the Heroic tab invites losing a staged batch by accident.
  _headBtns() {
    return Array.from(this._root?.querySelectorAll(".lu-switches [data-act], .lu-tabs [data-act]") ?? []);
  },

  _move(dx, dy) {
    const clamp = (n, len) => (len ? Math.max(0, Math.min(len - 1, n)) : 0);
    const before = this._focusEl();

    if (this._zone === "head") {
      if (dx) this._headIdx = clamp(this._headIdx + dx, this._headBtns().length);
      // Down from the header goes to the list, or the rail if there is no list.
      if (dy > 0) this._zone = this._rows().length ? "list" : "rail";
    } else if (dx < 0 && this._zone === "list") {
      this._zone = "rail";
    } else if (dx > 0 && this._zone === "rail") {
      this._zone = "list";
    } else if (this._zone === "rail") {
      // Up off the top of the rail reaches the switches and tabs.
      if (dy < 0 && this._railIdx === 0) this._zone = "head";
      else this._railIdx = clamp(this._railIdx + dy, this._railBtns().length);
    } else if (this._zone === "foot") {
      if (dx) this._footIdx = clamp(this._footIdx + dx, this._footBtns().length);
      if (dy < 0) this._zone = "list";
    } else {
      const rows = this._rows();
      const next = this._rowIdx + dy;
      // Up off the top reaches the header; down off the bottom lands on
      // Confirm when a batch is waiting, which is where the player is heading.
      if (next < 0) this._zone = "head";
      else if (next >= rows.length && this._footBtns().length) this._zone = "foot";
      else this._rowIdx = clamp(next, rows.length);
    }

    // Silence at the edges. Holding an arrow against the end of a list used to
    // fire the cursor cue on every repeat while nothing moved.
    this._focusChanged(this._focusEl() !== before);
  },

  /**
   * Move keyboard focus to whatever the pointer is over, so the feather tracks
   * the mouse and the two input methods never disagree about "here".
   *
   * A row wins over the buttons inside it: hovering its + still means the row
   * is the thing selected, which is what Z would act on anyway.
   */
  _syncFocusToPointer(target) {
    if (!target?.closest || this._facet) return;

    // Inside the class browser the feather tracks its own controls, so it
    // never sits over the main window the browser is covering.
    if (this._pickerOpen) {
      const el = target.closest(".lu-pickrow, .lu-picktabs [data-act], .lu-subtab, .lu-pvgo, [data-act='closepicker']");
      if (el) { this._pickFocusEl = el; this._updateCursor(); }
      return;
    }
    this._pickFocusEl = null;

    const row = target.closest(".lu-main .lu-row");
    if (row) {
      const i = this._rows().indexOf(row);
      if (i < 0) return;
      this._zone = "list"; this._rowIdx = i;
      return this._focusChanged(false);   // hover already made its own sound
    }

    const zones = [
      ["head", ".lu-switches [data-act], .lu-tabs [data-act]", this._headBtns()],
      ["rail", ".lu-rail [data-act]", this._railBtns()],
      ["foot", ".lu-foot [data-act]", this._footBtns()],
    ];
    for (const [zone, sel, list] of zones) {
      const el = target.closest(sel);
      if (!el) continue;
      const i = list.indexOf(el);
      if (i < 0) continue;
      this._zone = zone;
      if (zone === "head") this._headIdx = i;
      else if (zone === "rail") this._railIdx = i;
      else this._footIdx = i;
      return this._focusChanged(false);
    }
  },

  /** The element the cursor points at right now. */
  _focusEl() {
    // While the browser is open it owns the cursor: the selected class row,
    // or whatever the pointer last touched inside it.
    if (this._pickerOpen) {
      return this._root?.querySelector(".lu-pickrow.on")
        ?? this._pickFocusEl
        ?? this._root?.querySelector(".lu-pvgo") ?? null;
    }
    if (this._zone === "head") return this._headBtns()[this._headIdx] ?? null;
    if (this._zone === "rail") return this._railBtns()[this._railIdx] ?? null;
    if (this._zone === "foot") return this._footBtns()[this._footIdx] ?? null;
    return this._rows()[this._rowIdx] ?? null;
  },

  _focusChanged(moved = true) {
    if (moved) sfx("cursor");
    const el = this._focusEl();
    // Keyboard focus drives the detail panel exactly as hover does, so both
    // input methods show the same thing.
    if (this._zone === "list") {
      this._hover = el?.dataset.detail ?? null;
      this._paintDetail();
      // Only chase the focused row when the KEYBOARD moved it. Scrolling on
      // hover would slide the list out from under the pointer, which then
      // hovers a different row, which scrolls again.
      if (moved) el?.scrollIntoView({ block: "nearest" });
    }
    this._updateCursor();
  },

  /** Z / Enter — press whatever the cursor is on. */
  _activate() {
    const el = this._focusEl();
    if (!el) return;

    if (this._zone === "list") {
      // The row's own action, not the row: + normally, − in Reset mode, ★ on a
      // heroic. A disabled control means the rules say no, so stay quiet.
      const btn = el.querySelector("button[data-act]:not([disabled])");
      if (btn) return void btn.click();
      return;
    }
    el.click();
  },

  _updateCursor() {
    const el = this._cursorEl;
    if (!el) return;
    const target = this._focusEl();
    if (!target) { el.classList.remove("is-visible"); return; }
    const r = target.getBoundingClientRect();
    if (!r.width) { el.classList.remove("is-visible"); return; }

    // First placement jumps; later ones glide. Without this the feather flies
    // in from the top-left corner the first time it appears.
    if (!this._cursorReady) {
      el.classList.add("no-anim");
      el.style.left = `${r.right}px`;
      el.style.top = `${r.bottom}px`;
      el.classList.add("is-visible");
      requestAnimationFrame(() => el?.classList.remove("no-anim"));
      this._cursorReady = true;
      return;
    }
    el.style.left = `${r.right}px`;
    el.style.top = `${r.bottom}px`;
    el.classList.add("is-visible");
  },

  /** Slide the current rows out, then render the new list in. */
  async _swapList() {
    const rows = this._root?.querySelectorAll(".lu-main .lu-row");
    const wait = staggerRows(rows, "out");
    if (wait) await new Promise((r) => setTimeout(r, Math.min(wait, 260)));
    this._listKey = null;   // force the incoming list to stagger in
    this.render();
  },

  _paintDetail() {
    const el = this._root?.querySelector(".lu-detail");
    if (el) el.innerHTML = this._detailHTML();
  },

  _facetNoun(className) {
    if (className === "Dancer") return "dance";
    if (className === "Symbolist") return "symbol";
    if (className === "Mutant") return "therioform";
    if (className === "Hunter") return "trap";
    return "facet";
  },

  _facetOverlay() {
    const f = this._facet;
    if (!f) return "";
    const noun = this._facetNoun(f.className);
    const plural = (n) => `${noun}${n === 1 ? "" : "s"}`;

    if (f.stage === "confirm") {
      const chosen = f.selected
        .map((u) => f.pool.find((p) => p.uuid === u))
        .filter(Boolean);
      return `<div class="lu-facet"><div class="lu-panel lu-facetpanel lu-confirmpanel">
        <div class="lu-head"><div>
          <div class="lu-name">${f.act === "spend" ? "Confirm your choice" : "Confirm what you give back"}</div>
          <div class="lu-sub">${esc(f.skillName)}</div></div></div>
        <div class="lu-main">
          <p class="lu-lore">${f.act === "spend"
            ? `You will learn ${chosen.length === 1 ? "this" : "these"} ${plural(chosen.length)}:`
            : `You will unlearn ${chosen.length === 1 ? "this" : "these"} ${plural(chosen.length)}:`}</p>
          ${chosen.map((c) => `<div class="lu-fbtn is-on" style="cursor:default">
            <span class="lu-fhead">${c.img ? `<img src="${esc(c.img)}" alt="">` : ""}
              <b>${esc(c.name)}</b>${c.cost ? ` <span class="lu-tag">${esc(c.cost)}</span>` : ""}</span>
            ${describe(c.description, { clamp: false })}</div>`).join("")}
        </div>
        <div class="lu-foot">
          <span class="lu-foottext">Nothing is written until you Confirm the whole batch.</span>
          <button class="lu-cta ghost" data-act="facetback">Back</button>
          <button class="lu-cta go" data-act="facetok">Confirm</button>
        </div>
      </div></div>`;
    }

    const left = f.need - f.selected.length;
    return `<div class="lu-facet"><div class="lu-panel lu-facetpanel">
      <div class="lu-head"><div>
        <div class="lu-name">${esc(f.skillName)}</div>
        <div class="lu-sub">${f.act === "spend"
          ? `Choose ${f.need} ${plural(f.need)}`
          : `Choose 1 ${noun} to give back`} — ${left > 0 ? `${left} to go` : "ready"}</div></div>
        <button class="lu-x" data-act="facetcancel" title="Back to the skill tree">×</button>
      </div>
      <div class="lu-main">
        ${f.pool.map((p) => {
          const on = f.selected.includes(p.uuid);
          return `<button class="lu-fbtn ${on ? "is-on" : ""}" data-act="facettoggle" data-uuid="${esc(p.uuid)}">
            <span class="lu-fhead">${p.img ? `<img src="${esc(p.img)}" alt="">` : ""}
              <b>${on ? "✓ " : ""}${esc(p.name)}</b>${p.cost ? ` <span class="lu-tag">${esc(p.cost)}</span>` : ""}</span>
            ${describe(p.description, { clamp: false })}
          </button>`;
        }).join("")}
      </div>
      <div class="lu-foot">
        <span class="lu-foottext">${f.selected.length} of ${f.need} chosen${
          f.editIndex >= 0 ? "" : " — the level is not taken unless you choose"}</span>
        <button class="lu-cta ghost" data-act="facetcancel">${
          f.editIndex >= 0 ? "Keep as is" : "Cancel"}</button>
      </div>
    </div></div>`;
  },

  // Only asked when a class is opened for the first time, and only when the
  // class doesn't fix its own benefit — class_list stores one benefit per
  // class row, so there is nowhere to record a per-level answer.
  async _benefitFor(classKey) {
    const s = api()?.getState(this._actorUuid);
    const cls = s?.classes?.find((c) => c.key === classKey);
    if (!cls || cls.taken || cls.benefit) return cls?.benefit ?? undefined;

    return await new Promise((resolve) => {
      new Dialog({
        title: `${cls.name} — permanent bonus`,
        content: `<p style="margin:6px 0 10px">Every level in <b>${esc(cls.name)}</b> grants this bonus. It cannot be changed later.</p>`,
        buttons: {
          hp: { label: "Max HP +5", callback: () => resolve("hp") },
          mp: { label: "Max MP +5", callback: () => resolve("mp") },
          ip: { label: "Max IP +2", callback: () => resolve("ip") },
        },
        default: "hp",
        close: () => resolve(undefined),
      }).render(true);
    });
  },
};

// ── registration ──────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  const a = globalThis.FUCompanion?.api?.levelUp;
  if (!a) return;
  a.open = (uuid) => LevelUpApp.open(uuid);
  a.close = () => LevelUpApp.close();
  a.toggle = (uuid) => LevelUpApp.toggle(uuid);
  a.app = LevelUpApp;
});

export { LevelUpApp };
