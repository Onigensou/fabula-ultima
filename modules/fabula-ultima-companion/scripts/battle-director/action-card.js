// Battlefield Action Card — director-native overlay.
//
// In-viewport DOM overlay drawn at TRUE center of the viewport; replaces the
// legacy chat-message action card per [[director-battlefield-action-card]].
// One overlay per director.combatId. Despawned by Stopped state +
// director-boot stop() / preflightCleanup().
//
// Aesthetic: legacy CreateActionCard layout ported into the director's
// blue-tinted gold theme (`--fud-gold-1/2`, `--fud-stroke`) from turn-ui.js.
// Card is narrower than legacy (~320px) per user request — emphasize vertical
// reading order over horizontal sprawl.
//
// Features present (Phase A.3):
//   - Subtitle row: range • weapon type • "Normal Attack" (mirrors legacy)
//   - Attacker box w/ disposition-colored target names
//   - Accuracy widget: attribute icons + die results + Strike/Magic icon
//   - Crit/Fumble float banner (👑 / 💀, animated)
//   - Damage preview: element-tinted big italic number, +HR pill
//   - Per-target Result list (hit/crit/miss + damage)
//   - Buttons: Confirm + Invoke Trait + Invoke Bond + Cancel
//     (Invoke Trait/Bond are present-but-locked stubs until Phase E)
//
// Deferred to later slices: tooltip hover system, effect collapsible,
// Edit/Undo, action-cost pill, critical cut-in, content-link delegation,
// reaction-window integration, animated roll-up, weapon icon image,
// action-card identity flags, chat-log persistence.

import { log, warn } from "./logger.js";
import { INTENTS } from "./intents.js";
import { gatherEquipmentSlots } from "./equipment-swap.js";
import { describeCandidateForTooltip } from "./item-resource.js";

// Resolve which active non-GM user owns the actor at `actorUuid`.
// Returns userId or null. Used to gate which player's mirror card
// has interactive Confirm/Cancel buttons. Deterministic on
// multi-owner actors (sort by id).
async function resolveCardOwnerUserId(actorUuid) {
  try {
    const actor = await fromUuid(actorUuid);
    if (!actor) return null;
    const candidates = (game.users?.contents ?? []).filter((u) => {
      if (u.isGM) return false;
      if (!u.active) return false;
      try { return actor.testUserPermission?.(u, "OWNER"); }
      catch { return false; }
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.id.localeCompare(b.id));
    return candidates[0].id;
  } catch { return null; }
}

const CSS_ID  = "fud-battlefield-card-style";
const ROOT_ID = "fud-battlefield-card-root";

const _overlays = new Map();

// ─────────────────────────────────────────────────────────────────────
// Visual tokens — borrowed from legacy CreateActionCard for parity.
// ─────────────────────────────────────────────────────────────────────
const STRIKE_ICON_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/UI/fu-icon/physical_icon.png";
const MAGIC_ICON_URL  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/UI/fu-icon/magical_icon.png";

const ATTR_ICON = {
  DEX: "fa-person-running",
  INS: "fa-book",
  MIG: "fa-dumbbell",
  WLP: "fa-comment-dots",
};
const WEAPON_ICON = {
  arcane: "fa-book",
  bow: "fa-bow-arrow",
  brawling: "fa-hand-fist",
  dagger: "fa-dagger",
  firearm: "fa-gun",
  flail: "fa-mace",
  heavy: "fa-hammer",
  spear: "fa-location-arrow",
  sword: "fa-sword",
  thrown: "fa-bomb",
  swords: "fa-swords",
};
const ELEMENT_COLOR = {
  physical: "#1b1b1b",
  fire:     "#e25822",
  ice:      "#5ab3d4",
  air:      "#48c774",
  earth:    "#8b5e3c",
  bolt:     "#9b59b6",
  light:    "#a38b50",
  dark:     "#4b0082",
  poison:   "#2e8b57",
};
const ELEMENT_GLOW = {
  physical: "rgba(0,0,0,0.28)",
  fire:     "rgba(226,88,34,0.45)",
  ice:      "rgba(90,179,212,0.45)",
  air:      "rgba(72,199,116,0.45)",
  earth:    "rgba(139,94,60,0.45)",
  bolt:     "rgba(155,89,182,0.45)",
  light:    "rgba(163,139,80,0.45)",
  dark:     "rgba(75,0,130,0.45)",
  poison:   "rgba(46,139,87,0.45)",
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

function cap(s) { s = String(s ?? ""); return s ? s[0].toUpperCase() + s.slice(1) : ""; }

// Validate an image URL for safe inline-CSS / src injection. Returns the
// trimmed URL or null. We deliberately filter `'` / `"` / `\n` / `<` which
// could break out of an inline-style url() — the URL itself is escaped
// downstream by escapeHtml but inline CSS injection is the weaker path,
// so we reject anything suspicious here.
function safeImgUrl(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/['"<>\n\r]/.test(s)) return null;
  return s;
}

// True if the URL is a video source (token battle sprites are animated .webm
// after the battle-ready sprite swap). Those must render in a <video>, not an
// <img>/background-image, which silently fail on video files.
function isVideoUrl(url) {
  return /\.(webm|mp4|m4v|ogv|ogg)(\?|#|$)/i.test(String(url ?? ""));
}

// Defensive builder wrapper: any section that throws falls back to ""
// instead of taking down the whole card. Single missing fields shouldn't
// abort the action.
function tryBuild(label, fn) {
  try { return fn() ?? ""; }
  catch (e) { warn(`action-card section "${label}" threw`, e); return ""; }
}

function dispositionColor(d) {
  // Foundry V12: 1 = friendly, 0 = neutral, -1 = hostile, -2 = secret.
  if (d === 1) return "#3aa0ff";
  if (d === -1) return "#e36a6a";
  return "#c9a86a";
}

function attrIconHTML(attr) {
  const cls = ATTR_ICON[String(attr).toUpperCase()] ?? "fa-circle-question";
  return `<i class="fa-solid ${cls}" aria-hidden="true"></i>`;
}

function weaponIconHTML(weaponType) {
  const cls = WEAPON_ICON[String(weaponType || "").toLowerCase()] ?? "fa-sword";
  return `<i class="fa-solid ${cls}" aria-hidden="true"></i>`;
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById(CSS_ID)) return;
  const css = document.createElement("style");
  css.id = CSS_ID;
  css.textContent = `
    #${ROOT_ID} {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) scale(0.92);
      opacity: 0;
      z-index: 95;
      pointer-events: none;
      transition: transform 220ms cubic-bezier(.2,.7,.2,1), opacity 220ms ease-out;
    }
    #${ROOT_ID}.is-visible {
      transform: translate(-50%, -50%) scale(1);
      opacity: 1;
    }
    #${ROOT_ID}.is-resolving {
      transform: translate(-50%, -50%) scale(1.04);
      opacity: 0;
      transition: transform 350ms ease-out, opacity 350ms ease-out 80ms;
    }

    .fud-bf-card {
      position: relative;
      pointer-events: auto;
      width: 320px;
      max-width: 92vw;
      padding: 12px 14px 11px;
      border: 2px solid var(--fud-stroke, #5a6a85);
      border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top, #f6f1e6), var(--fud-parchment-bot, #ebe3d0));
      box-shadow:
        0 16px 48px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(255, 255, 255, 0.5) inset;
      color: var(--fud-ink, #3a3228);
      font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif;
      letter-spacing: 0.2px;
    }

    /* Strip Foundry's default img border/background from anything we render. */
    .fud-bf-card img {
      border: 0 !important;
      outline: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
    }

    /* Header sprites — flank the action name:  [left] Name [right]. Sides are
       anchored by DISPOSITION (player/friendly → right, enemy → left); a
       same-side caster+target flips the target to the opposite slot.

       SINGLE target/attacker → FULL token art (bottom-aligned, mirrored toward
       the centre on the left side). MULTIPLE targets → a compact MASKED
       circular grid (head-biased crop), the look from before the full-sprite
       experiment. Both paths use <img>/<video> so animated .webm tokens render
       (background-image would silently fail on video). */
    .fud-bf-card .fud-bf-portrait-slot {
      display: flex;
      align-items: flex-end;        /* full sprite sits on the bottom line */
      justify-content: center;
      flex: 0 0 auto;
      height: 56px;
      min-width: 50px;              /* keep the title roughly centred */
    }
    .fud-bf-card .fud-bf-portrait-slot:empty { min-width: 0; width: 0; }

    /* Single full sprite */
    .fud-bf-card .fud-bf-portrait-sprite {
      height: 56px; width: auto;    /* full sprite — keep aspect ratio, no crop */
      object-fit: contain;
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.45));
    }
    .fud-bf-card .fud-bf-portrait-slot.left .fud-bf-portrait-sprite {
      transform: scaleX(-1);        /* sprites are left-facing; mirror to face centre */
    }

    /* Multi-target masked circular grid (cell size scales with count) */
    .fud-bf-card .fud-bf-portrait-grid {
      display: flex; flex-wrap: wrap; gap: 2px;
      width: 48px; height: 48px;
      align-self: center;           /* centre the grid in the slot */
      justify-content: center; align-content: center;
    }
    .fud-bf-card .fud-bf-portrait-cell {
      flex: 0 0 auto;
      border-radius: 50%;
      overflow: hidden;
      background-color: rgba(0, 0, 0, 0.05);
      box-shadow: 0 2px 5px rgba(0, 0, 0, 0.40);
    }
    .fud-bf-card .fud-bf-portrait-cell img,
    .fud-bf-card .fud-bf-portrait-cell video {
      width: 100%; height: 100%;
      object-fit: cover;
      object-position: center 22%;  /* bias toward the head */
      display: block;
    }
    /* Left-side grid cells mirror to face the centre (same as full sprites;
       cells are authored left-facing). */
    .fud-bf-card .fud-bf-portrait-slot.left .fud-bf-portrait-cell img,
    .fud-bf-card .fud-bf-portrait-slot.left .fud-bf-portrait-cell video {
      transform: scaleX(-1);
    }

    .fud-bf-card .fud-bf-header {
      display: flex; align-items: center; justify-content: space-between; gap: 6px;
      padding: 4px 8px 7px;
      border-bottom: 2px solid var(--fud-stroke, #5a6a85);
      margin-bottom: 8px;
    }
    .fud-bf-card .fud-bf-title-row {
      display: flex; align-items: center; justify-content: center; gap: 7px;
      flex: 1 1 auto;          /* take the middle; keep the name centred */
      min-height: 28px;
    }
    .fud-bf-card .fud-bf-title-icon {
      width: 26px; height: 26px;
      object-fit: cover;
      border-radius: 5px;
      flex: 0 0 auto;
    }
    .fud-bf-card .fud-bf-title {
      font-weight: 900; letter-spacing: 0.32px; text-transform: uppercase;
      font-size: 16px;
      color: var(--fud-ink, #3a3228);
    }
    .fud-bf-card .fud-bf-subtitle {
      font-size: 11.5px;
      color: #6b3e1e;
      text-align: center;
      opacity: 0.92;
      /* Lives BELOW the header divider (header = sprites + name only). Sprites
         no longer cross the divider, so the subtitle uses the full width. */
      padding: 0 8px;
      margin: 0 0 8px;
    }
    .fud-bf-card .fud-bf-subtitle .dot {
      margin: 0 6px;
      opacity: 0.5;
    }
    .fud-bf-card .fud-bf-subtitle .bullet {
      white-space: nowrap;
    }
    .fud-bf-card .fud-bf-subtitle i.fa-solid { margin-right: 4px; }

    .fud-bf-card fieldset.fud-bf-section {
      border: 1px solid var(--fud-stroke, #5a6a85);
      border-radius: 8px;
      padding: 4px 9px 7px;
      margin: 0 0 7px 0;
      background: rgba(255, 255, 255, 0.20);
    }
    .fud-bf-card fieldset.fud-bf-section legend {
      padding: 0 5px;
      font-size: 10.5px; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase;
      color: var(--fud-ink-soft, #4b4338);
    }

    .fud-bf-card .fud-bf-attacker-row {
      display: grid; grid-template-columns: 1fr auto 1fr;
      align-items: center; gap: 6px;
      font-size: 13px;
    }
    /* Default cell (used by all attacker-row cells): single-line, bold,
       ellipsis on overflow. Other cards (Guard / Study / Hinder /
       Equipment / Item) inline div.left / div.right expecting these
       defaults — don't change them. */
    .fud-bf-card .fud-bf-attacker-row .left,
    .fud-bf-card .fud-bf-attacker-row .right {
      font-weight: 700;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fud-bf-card .fud-bf-attacker-row .left  { justify-self: start; text-align: left;  }
    .fud-bf-card .fud-bf-attacker-row .right { justify-self: end;   text-align: right; }
    .fud-bf-card .fud-bf-attacker-row .mid   { justify-self: center; opacity: 0.6; font-size: 14px; }

    /* Multi-name target list — relaxes wrap so 3+ named targets break
       across lines instead of ellipsing. Vertically centered against
       the single-line attacker name on the other side. Each .t-name
       inside stays nowrap so individual names don't break mid-word; the
       commas between names provide wrap points. Used by the
       Attacker panel only (Attack / Skill cards); ignored elsewhere. */
    .fud-bf-card .fud-bf-attacker-row .is-targets {
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
      line-height: 1.3;
      align-self: center;
    }
    .fud-bf-card .fud-bf-attacker-row .is-targets .t-name {
      white-space: nowrap;
    }

    /* Accuracy widget */
    .fud-bf-card .fud-bf-acc {
      position: relative;
    }
    .fud-bf-card .fud-bf-acc-row {
      display: flex; align-items: center; gap: 6px;
      font-size: 13px;
    }
    .fud-bf-card .fud-bf-acc-row .die-block {
      display: inline-flex; align-items: center; gap: 4px;
      font-weight: 700;
    }
    .fud-bf-card .fud-bf-acc-row .die-block i.fa-solid { font-size: 11px; opacity: 0.78; }
    .fud-bf-card .fud-bf-acc-row .die-block .attr { font-weight: 900; font-size: 11.5px; }
    /* Die size (e.g. "d8") — secondary metadata, kept subtle so the
       eye lands on the rolled value next to it. */
    .fud-bf-card .fud-bf-acc-row .die-block .die-size {
      font-size: 10.5px;
      font-weight: 700;
      opacity: 0.55;
    }
    /* Individual roll result (the rA / rB die value). Made prominent
       so the player can read the actual dice outcome at a glance —
       second only in size to the final total on the right. */
    .fud-bf-card .fud-bf-acc-row .die-block .die-result {
      font-weight: 900;
      font-size: 18px;
      min-width: 18px;
      text-align: right;
      color: var(--fud-ink, #3a3228);
      text-shadow: 0 0 5px rgba(0, 0, 0, 0.12);
      line-height: 1;
    }
    .fud-bf-card .fud-bf-acc-row .plus { font-weight: 900; opacity: 0.45; }
    .fud-bf-card .fud-bf-acc-row .bonus {
      font-size: 11px; font-weight: 700; padding: 1px 6px;
      border-radius: 999px; border: 1px solid #cfa057;
      color: #8a4b22; background: #f7ecd9;
      margin-left: 2px;
    }
    .fud-bf-card .fud-bf-acc-row .spacer { flex: 1; }
    .fud-bf-card .fud-bf-acc-row .total-wrap {
      display: inline-flex; align-items: center; gap: 5px;
      font-weight: 900;
    }
    .fud-bf-card .fud-bf-acc-row .strike-icon { width: 22px; height: 22px; object-fit: contain; }
    .fud-bf-card .fud-bf-acc-row .total {
      font-size: 22px;
      text-shadow: 0 0 6px rgba(0, 0, 0, 0.22);
      color: #111;
    }
    .fud-bf-card .fud-bf-acc.is-crit .total {
      color: #b40000;
      text-shadow: 0 0 9px rgba(180, 0, 0, 0.35);
    }
    .fud-bf-card .fud-bf-acc.is-fumble .total {
      color: #1f1f1f;
      text-shadow: 0 0 9px rgba(0, 0, 0, 0.45);
    }

    /* Crit / Fumble float banner */
    .fud-bf-card .fud-bf-acc .float-banner {
      position: absolute; right: -2px; bottom: -22px;
      z-index: 5; pointer-events: none;
      font-size: 16px; font-weight: 900; font-style: italic;
      letter-spacing: 0.6px; text-transform: uppercase;
      padding: 3px 9px; border-radius: 10px;
      animation: fudCritPop 0.32s ease-out both;
    }
    .fud-bf-card .fud-bf-acc .float-banner.crit {
      color: #ffd34d;
      -webkit-text-stroke: 1.4px rgba(90, 58, 18, 0.72);
      text-shadow:
        0 0 22px rgba(255, 207, 64, 0.7),
        0 0 10px rgba(255, 207, 64, 0.85),
        0 2px 0 #5a3a12, 0 3px 0 #5a3a12;
    }
    .fud-bf-card .fud-bf-acc .float-banner.fumble {
      color: #e6e6e6;
      -webkit-text-stroke: 1.4px rgba(38, 38, 38, 0.72);
      text-shadow:
        0 0 22px rgba(255, 255, 255, 0.55),
        0 0 10px rgba(240, 240, 240, 0.85),
        0 2px 0 #1f1f1f, 0 3px 0 #1f1f1f;
    }
    .fud-bf-card .fud-bf-acc .float-banner i.fa-solid { margin-right: 5px; }
    @keyframes fudCritPop {
      0%   { transform: scale(0.80); opacity: 0; }
      60%  { transform: scale(1.18); opacity: 1; }
      100% { transform: scale(1.00); opacity: 1; }
    }

    /* "Opportunity!" note shown below the accuracy row on a crit
       (RAW Core p.68 — crits generate opportunities). Static + small;
       deliberately calmer than the crit float-banner above. */
    .fud-bf-card .fud-bf-opportunity {
      margin-top: 6px;
      padding: 3px 8px;
      border-radius: 6px;
      border: 1px solid #b87b1f;
      background: linear-gradient(180deg, #fff2c8, #ffdd7a);
      color: #5a3a12;
      font-size: 10.5px;
      font-weight: 900; letter-spacing: 0.5px; text-transform: uppercase;
      text-align: center;
      box-shadow: 0 0 8px rgba(255, 207, 64, 0.4);
      animation: fudOpportunityFade 0.6s ease-out both;
    }
    .fud-bf-card .fud-bf-opportunity i.fa-solid { margin-right: 5px; color: #c47b1f; }
    @keyframes fudOpportunityFade {
      0%   { transform: translateY(-3px); opacity: 0; }
      100% { transform: translateY(0); opacity: 1; }
    }

    /* Damage preview */
    .fud-bf-card fieldset.fud-bf-section.fud-bf-dmg {
      /* extra top padding so the float-banner from the accuracy widget
         above doesn't crowd against the damage preview's border */
      padding-top: 8px;
      margin-top: 14px;
    }
    .fud-bf-card .fud-bf-dmg-row {
      /* The bare number is the centred anchor; the +HR pill and element
         label are absolutely positioned off it, so neither add-on shifts
         the number away from dead-centre. */
      position: relative;
      display: flex; align-items: center; justify-content: center;
      padding: 2px 2px;
      min-height: 30px;
    }
    .fud-bf-card .fud-bf-dmg-number {
      position: relative;
      font-size: 30px; font-weight: 900; font-style: italic;
      line-height: 1; text-align: center;
    }
    .fud-bf-card .fud-bf-dmg-number .hr-pill {
      /* hang immediately to the right of the centred number */
      position: absolute; left: 100%; top: 50%; transform: translateY(-50%);
      margin-left: 8px; white-space: nowrap;
      font-size: 10.5px; font-weight: 800; font-style: normal;
      padding: 2px 6px; border-radius: 999px;
      border: 1px solid #cfa057;
      color: #8a4b22; background: #f7ecd9;
    }
    .fud-bf-card .fud-bf-dmg-element {
      /* pinned to the row's right edge, clear of the centred number */
      position: absolute; right: 2px; top: 50%; transform: translateY(-50%);
      font-size: 14px; font-weight: 900;
      text-align: right;
    }

    /* Per-target result list */
    .fud-bf-card .fud-bf-target-list {
      display: flex; flex-direction: column; gap: 1px;
    }
    .fud-bf-card .fud-bf-target-row {
      display: grid; grid-template-columns: 1fr auto auto;
      gap: 8px;
      padding: 3px 0;
      border-bottom: 1px dashed rgba(90, 106, 133, 0.28);
      font-size: 12px;
    }
    .fud-bf-card .fud-bf-target-row:last-child { border-bottom: none; }
    .fud-bf-card .fud-bf-target-row .t-name { font-weight: 700; }
    .fud-bf-card .fud-bf-target-row .t-def  { opacity: 0.6; }
    .fud-bf-card .fud-bf-target-row .t-result.hit    { color: #2a6e3d; font-weight: 800; }
    .fud-bf-card .fud-bf-target-row .t-result.crit   { color: #b40000; font-weight: 900; }
    .fud-bf-card .fud-bf-target-row .t-result.miss   { color: #9a4a4a; }
    .fud-bf-card .fud-bf-target-row .t-result.absorb { color: #2a8a3a; font-weight: 800; }
    /* Healing / resource-restore / shield rows — recipe-grant skills.
       Distinct hues from damage so a Heal vs an Attack reads at a glance. */
    .fud-bf-card .fud-bf-target-row .t-result.heal       { color: #2a8a3a; font-weight: 800; text-shadow: 0 0 6px rgba(42,138,58,0.25); }
    .fud-bf-card .fud-bf-target-row .t-result.restore-mp { color: #1e6cff; font-weight: 800; text-shadow: 0 0 6px rgba(30,108,255,0.25); }
    .fud-bf-card .fud-bf-target-row .t-result.shield     { color: #1f8a9e; font-weight: 800; text-shadow: 0 0 6px rgba(31,138,158,0.25); }
    .fud-bf-card .fud-bf-target-row .t-affinity {
      display: inline-flex; align-items: center;
      margin-left: 6px;
      font-size: 9.5px; font-weight: 800; letter-spacing: 0.3px; text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 999px;
      border: 1px solid currentColor;
      opacity: 0.85;
      vertical-align: 2px;
    }
    .fud-bf-card .fud-bf-target-row .t-affinity .affinity-icon { margin-right: 3px; font-size: 9.5px; }

    /* Pre-resolve reaction pill row (Healing Power / Support Magic /
       future "during action card" passives). Sits BETWEEN the body and
       the Confirm/Cancel buttons; locks Confirm while any ask pill is
       undecided. */
    .fud-bf-card .fud-bf-reactions-row {
      display: flex; flex-direction: column; gap: 5px;
      margin: 8px 0 4px;
      padding: 6px 8px 7px;
      background: linear-gradient(180deg, rgba(120, 80, 200, 0.10), rgba(120, 80, 200, 0.04));
      border: 1px solid rgba(120, 80, 200, 0.45);
      border-radius: 8px;
    }
    .fud-bf-card .fud-bf-reactions-label {
      font-size: 9.5px; font-weight: 800; letter-spacing: 0.6px;
      text-transform: uppercase; color: #4a2f87;
      padding: 0 2px;
    }
    .fud-bf-card .fud-bf-reactions-list {
      display: flex; flex-direction: column; gap: 4px;
    }
    .fud-bf-card .fud-bf-reaction-pill {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.55);
      border-radius: 6px;
      border: 1px solid rgba(120, 80, 200, 0.25);
    }
    .fud-bf-card .fud-bf-reaction-pill.is-resolved {
      opacity: 0.55;
    }
    .fud-bf-card .fud-bf-reaction-pill.is-applied {
      background: rgba(140, 220, 130, 0.30);
      border-color: rgba(60, 140, 60, 0.55);
    }
    .fud-bf-card .fud-bf-reaction-pill.is-skipped {
      background: rgba(220, 220, 220, 0.40);
      border-color: rgba(140, 140, 140, 0.45);
    }
    .fud-bf-card .fud-bf-reaction-icon {
      width: 18px; height: 18px;
      flex: 0 0 auto;
      border-radius: 4px;
      object-fit: cover;
      font-size: 14px; line-height: 18px; text-align: center;
    }
    .fud-bf-card .fud-bf-reaction-name {
      flex: 1 1 auto;
      font-size: 11px; font-weight: 700;
      color: #2c1c5c;
    }
    .fud-bf-card .fud-bf-reaction-status {
      flex: 0 0 auto;
      font-size: 9.5px; font-weight: 700; text-transform: uppercase;
      color: #4a2f87; opacity: 0.75;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(120, 80, 200, 0.15);
    }
    .fud-bf-card .fud-bf-reaction-actions {
      display: flex; gap: 4px;
      flex: 0 0 auto;
    }
    .fud-bf-card .fud-btn-reaction {
      flex: 0 0 auto;
      padding: 3px 9px;
      font-size: 9.5px;
      border-radius: 5px;
      border-width: 1.5px;
      box-shadow: 0 2px 0 rgba(0, 0, 0, 0.35);
    }
    .fud-bf-card .fud-btn-reaction-apply {
      background: linear-gradient(180deg, #c5e8c5, #9fce9f);
      color: #1a3a1a;
      border-color: #5a8a5a;
    }
    .fud-bf-card .fud-btn-reaction-skip {
      background: linear-gradient(180deg, #e5d6c5, #c9b294);
      color: #3a2818;
      border-color: #8a7560;
    }
    /* Lock Confirm while any ask-mode pill is still pending. The data
       attribute holds the count; CSS only needs to know "is there one". */
    .fud-bf-card[data-fud-reactions-pending] .fud-btn-confirm {
      opacity: 0.45 !important;
      pointer-events: none !important;
      cursor: not-allowed !important;
      filter: grayscale(0.4);
    }
    .fud-bf-card[data-fud-reactions-pending]::after {
      content: "⏳ Resolve reactions first";
      display: block;
      margin-top: 6px;
      font-size: 10px; font-style: italic; font-weight: 700;
      color: #4a2f87;
      text-align: center;
      letter-spacing: 0.3px;
    }
    /* Mode footer inside the reaction tooltip body — small chip-like
       hint so the player sees whether the pill is auto / ask / off. */
    .fud-bf-desc-tip .fud-bf-reaction-tip-foot {
      margin-top: 6px;
      padding: 3px 8px;
      border-top: 1px solid rgba(120, 80, 200, 0.35);
      font-size: 10.5px;
      font-weight: 700;
      font-style: italic;
      color: #4a2f87;
      letter-spacing: 0.3px;
    }
    /* Cursor hint — the pill is hoverable for info. */
    .fud-bf-card .fud-bf-reaction-pill {
      cursor: help;
    }
    .fud-bf-card .fud-bf-reaction-pill .fud-btn-reaction {
      cursor: pointer;
    }

    /* Buttons row */
    .fud-bf-card .fud-bf-btn-row {
      display: flex; align-items: center; gap: 6px;
      margin-top: 10px; flex-wrap: wrap;
    }
    .fud-bf-card .fud-btn {
      flex: 1 1 auto; min-width: 0;
      padding: 8px 10px;
      border-radius: 8px;
      border: 2px solid var(--fud-stroke, #5a6a85);
      font-weight: 800; letter-spacing: 0.32px; text-transform: uppercase;
      font-size: 11px;
      cursor: pointer;
      user-select: none;
      text-align: center;
      box-shadow:
        0 3px 0 var(--fud-shadow, rgba(24, 28, 41, 0.55)),
        0 0 0 1px var(--fud-highlight, rgba(255, 255, 255, 0.7)) inset;
      transition: transform 100ms ease, filter 100ms ease, box-shadow 100ms ease;
    }
    .fud-bf-card .fud-btn-confirm {
      flex: 1 1 100%;
      background: linear-gradient(180deg, var(--fud-gold-1, #a8c4d8), var(--fud-gold-2, #7a9bb6));
      color: #221b14;
      font-size: 12.5px;
      padding: 10px 12px;
    }
    .fud-bf-card .fud-btn-invoke {
      background: #f7ecd9;
      color: #8a4b22;
      border-color: #cfa057;
      font-size: 10.5px;
    }
    .fud-bf-card .fud-btn-invoke .icon { margin-right: 3px; }
    .fud-bf-card .fud-btn-cancel {
      flex: 1 1 100%;
      background: linear-gradient(180deg, #e5d6c5, #c9b294);
      color: var(--fud-ink, #3a3228);
      font-size: 11px;
      padding: 7px 10px;
      margin-top: 2px;
    }
    .fud-bf-card .fud-btn:hover  { filter: brightness(1.05); transform: translateY(-1px); }
    .fud-bf-card .fud-btn:active { transform: translateY(0); }

    /* Locked invoke (fumble OR not-yet-implemented stub) */
    .fud-bf-card .fud-btn.is-locked {
      position: relative; overflow: hidden;
      cursor: not-allowed;
      color: #d8d8d8 !important;
      border-color: #080808 !important;
      background: linear-gradient(180deg, #2a2a2a, #141414) !important;
      filter: grayscale(1) saturate(0.15);
      box-shadow:
        inset 0 0 0 1px rgba(255,255,255,.06),
        inset 0 -3px 8px rgba(0,0,0,.55),
        0 1px 2px rgba(0,0,0,.35);
    }
    .fud-bf-card .fud-btn.is-locked:hover { transform: none; filter: grayscale(1) saturate(0.15); }
    .fud-bf-card .fud-btn.is-locked > span.btn-label { visibility: hidden; }
    .fud-bf-card .fud-btn.is-locked::after {
      content: ""; position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.48);
      display: flex; align-items: center; justify-content: center;
      pointer-events: none;
    }
    .fud-bf-card .fud-btn.is-locked > .lock-icon {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: #f2f2f2;
      font-size: 13px;
      text-shadow: 0 1px 3px rgba(0,0,0,0.75);
      pointer-events: none;
      z-index: 1;
    }

    .fud-bf-card .fud-btn.is-resolved {
      pointer-events: none;
      opacity: 0.55;
      filter: grayscale(0.3);
    }

    /* Hinder status picker: 2×2 grid of buttons (dazed/shaken/slow/weak).
       Each button forwards its statusValue via data-fud-status-value. */
    .fud-bf-card .fud-bf-status-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .fud-bf-card .fud-btn-hinder-status {
      background: linear-gradient(180deg, #f7ecd9, #e7d8b6);
      flex: unset;
      border-width: 2px;
      padding: 9px 8px;
      font-size: 11px;
    }
    .fud-bf-card .fud-btn-hinder-status:hover {
      background: linear-gradient(180deg, #fff5e0, #efe0c0);
    }

    /* Equipment card — "Open Character Sheet" affordance. Visual cousin of
       the cancel button (neutral parchment), since clicking it doesn't
       commit the action — it just launches the sheet. */
    .fud-bf-card .fud-btn-open-sheet {
      display: inline-flex;
      align-items: center;
      padding: 8px 14px;
      border-radius: 8px;
      border: 2px solid var(--fud-stroke, #5a6a85);
      background: linear-gradient(180deg, #e5d6c5, #c9b294);
      color: var(--fud-ink, #3a3228);
      font-weight: 800; letter-spacing: 0.32px; text-transform: uppercase;
      font-size: 11px;
      cursor: pointer; user-select: none;
      box-shadow:
        0 3px 0 var(--fud-shadow, rgba(24, 28, 41, 0.55)),
        0 0 0 1px var(--fud-highlight, rgba(255, 255, 255, 0.7)) inset;
      transition: transform 100ms ease, filter 100ms ease;
    }
    .fud-bf-card .fud-btn-open-sheet:hover { filter: brightness(1.05); transform: translateY(-1px); }
    .fud-bf-card .fud-btn-open-sheet:active { transform: translateY(0); }

    /* Equipment card — per-slot custom dropdown (icon + name + subtitle).
       Trigger is a card-sized button; clicking it opens an absolutely-
       positioned popover with the same layout per option. Selection state
       lives on data-fud-equip-current on the row; the Done handler scans
       all rows and ships {slotKey: itemId} via finish() extras. */
    .fud-bf-card .fud-bf-equip-row {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 0;
      border-bottom: 1px dashed rgba(90, 106, 133, 0.25);
    }
    .fud-bf-card .fud-bf-equip-row:last-child { border-bottom: none; }
    .fud-bf-card .fud-bf-equip-label {
      font-size: 10.5px; font-weight: 800; letter-spacing: 0.32px; text-transform: uppercase;
      color: var(--fud-ink-soft, #4b4338);
    }
    .fud-bf-card .fud-bf-equip-trigger {
      display: grid;
      grid-template-columns: 44px 1fr 18px;
      align-items: center;
      gap: 10px;
      width: 100%;
      min-height: 56px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1.5px solid var(--fud-stroke, #5a6a85);
      background: rgba(255, 255, 255, 0.65);
      color: var(--fud-ink, #3a3228);
      cursor: pointer;
      user-select: none;
      transition: background-color 100ms ease, border-color 100ms ease;
    }
    .fud-bf-card .fud-bf-equip-trigger:hover { background: rgba(255, 255, 255, 0.85); }
    .fud-bf-card .fud-bf-equip-trigger:focus,
    .fud-bf-card .fud-bf-equip-row.is-open .fud-bf-equip-trigger {
      outline: 2px solid var(--fud-gold-2, #7a9bb6);
      outline-offset: -1px;
      border-color: var(--fud-gold-2, #7a9bb6);
    }
    /* Slot has changed from its initial value — bright gold ring +
       leading dot in the label, so the GM/player can see at a glance
       what's about to commit when they hit Done. */
    .fud-bf-card .fud-bf-equip-row.is-modified .fud-bf-equip-trigger {
      border-color: #d8a73a;
      box-shadow:
        0 0 0 1px rgba(216, 167, 58, 0.55),
        0 0 8px rgba(216, 167, 58, 0.25);
    }
    .fud-bf-card .fud-bf-equip-row.is-modified .fud-bf-equip-label::before {
      content: "● ";
      color: #d8a73a;
      font-size: 9px;
      vertical-align: middle;
    }
    /* 2H ghost slot — visually shows the 2H weapon faded so the player
       can see at a glance that the weapon occupies both slots. The
       row's data-fud-equip-current stays "" (the underlying data is
       still "off-hand empty" per the Fabula convention); the visible
       icon + name + meta are mirrored from the peer's real 2H pick. */
    .fud-bf-card .fud-bf-equip-row.is-ghost .fud-bf-equip-trigger {
      opacity: 0.42;
      border-style: dashed;
      filter: saturate(0.6);
    }
    .fud-bf-card .fud-bf-equip-row.is-ghost .fud-bf-equip-trigger::after {
      content: "linked";
      position: absolute;
      right: 28px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: var(--fud-ink-soft, #4b4338);
      background: rgba(255, 255, 255, 0.75);
      padding: 1px 5px;
      border-radius: 4px;
      pointer-events: none;
    }
    .fud-bf-card .fud-bf-equip-row.is-ghost .fud-bf-equip-trigger {
      position: relative;
    }
    .fud-bf-card .fud-bf-equip-icon {
      width: 44px; height: 44px;
      border-radius: 6px;
      background-color: rgba(90, 106, 133, 0.10);
      background-size: cover;
      background-position: center;
      border: 1px solid rgba(90, 106, 133, 0.30);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px;
    }
    .fud-bf-card .fud-bf-equip-icon-empty {
      background-color: rgba(90, 106, 133, 0.05);
      color: var(--fud-ink-soft, #4b4338);
    }
    .fud-bf-card .fud-bf-equip-text {
      display: flex; flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .fud-bf-card .fud-bf-equip-name {
      font-size: 13.5px;
      font-weight: 800;
      line-height: 1.1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--fud-ink, #3a3228);
    }
    .fud-bf-card .fud-bf-equip-meta {
      font-size: 10.5px;
      font-weight: 600;
      opacity: 0.78;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--fud-ink-soft, #4b4338);
    }
    .fud-bf-card .fud-bf-equip-meta .dot {
      display: inline-block;
      margin: 0 4px;
      opacity: 0.5;
    }
    .fud-bf-card .fud-bf-equip-caret {
      text-align: right;
      font-size: 11px;
      opacity: 0.6;
      transition: transform 120ms ease;
    }
    .fud-bf-card .fud-bf-equip-row.is-open .fud-bf-equip-caret {
      transform: rotate(180deg);
    }
    .fud-bf-card .fud-bf-equip-popover {
      position: absolute;
      left: 0; right: 0;
      top: calc(100% - 4px);
      z-index: 20;
      max-height: 260px;
      overflow-y: auto;
      padding: 4px;
      border-radius: 8px;
      border: 1.5px solid var(--fud-stroke, #5a6a85);
      background: var(--fud-parchment, #f1e6c4);
      box-shadow: 0 6px 18px rgba(24, 28, 41, 0.40);
      display: none;
    }
    .fud-bf-card .fud-bf-equip-row.is-open .fud-bf-equip-popover { display: block; }
    .fud-bf-card .fud-bf-equip-option {
      display: grid;
      grid-template-columns: 36px 1fr;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      border-radius: 6px;
      cursor: pointer;
    }
    .fud-bf-card .fud-bf-equip-option:hover {
      background: rgba(122, 155, 182, 0.18);
    }
    .fud-bf-card .fud-bf-equip-option.is-selected {
      background: rgba(122, 155, 182, 0.28);
      box-shadow: inset 0 0 0 1px var(--fud-gold-2, #7a9bb6);
    }
    .fud-bf-card .fud-bf-equip-option .fud-bf-equip-icon {
      width: 36px; height: 36px; font-size: 18px;
    }
    .fud-bf-card .fud-bf-equip-option .fud-bf-equip-name { font-size: 12.5px; }
    .fud-bf-card .fud-bf-equip-option .fud-bf-equip-meta { font-size: 10px; }

    /* Item card — tabs + scrollable item list + IP bar. Same visual
       language as the equipment dropdown (parchment, blue-tinted gold)
       so the two D-phase menu cards feel like siblings. */
    .fud-bf-card .fud-bf-item-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 6px;
    }
    .fud-bf-card .fud-bf-item-tab {
      flex: 1;
      padding: 6px 10px;
      text-align: center;
      font-size: 11.5px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      border-radius: 8px;
      border: 1.5px solid var(--fud-stroke, #5a6a85);
      background: rgba(255, 255, 255, 0.55);
      color: var(--fud-ink-soft, #4b4338);
      cursor: pointer;
      user-select: none;
      transition: background-color 100ms ease;
    }
    .fud-bf-card .fud-bf-item-tab:hover { background: rgba(255, 255, 255, 0.85); }
    .fud-bf-card .fud-bf-item-tab.is-active {
      background: linear-gradient(180deg, #fff0bd, #e4bf78);
      color: var(--fud-ink, #3a3228);
      border-color: var(--fud-gold-2, #7a9bb6);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.4), 0 2px 0 rgba(24,28,41,.25);
    }
    .fud-bf-card .fud-bf-item-tab .fud-bf-item-tab-count {
      margin-left: 4px;
      font-size: 10px;
      opacity: 0.7;
    }
    .fud-bf-card .fud-bf-item-panel { display: none; }
    .fud-bf-card .fud-bf-item-panel.is-active { display: block; }
    .fud-bf-card .fud-bf-item-list {
      max-height: 260px;
      overflow-y: auto;
      padding: 2px;
    }
    .fud-bf-card .fud-bf-item-empty {
      padding: 12px;
      text-align: center;
      font-size: 11.5px;
      opacity: 0.7;
      border: 1.5px dashed rgba(90, 106, 133, 0.30);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.20);
    }
    .fud-bf-card .fud-bf-item-row {
      display: grid;
      grid-template-columns: 40px 1fr auto;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      margin: 3px 0;
      border-radius: 8px;
      border: 1.5px solid var(--fud-stroke, #5a6a85);
      background: rgba(255, 255, 255, 0.55);
      cursor: pointer;
      transition: background-color 100ms ease, transform 80ms ease;
    }
    .fud-bf-card .fud-bf-item-row:hover { background: rgba(255, 255, 255, 0.85); }
    .fud-bf-card .fud-bf-item-row.is-selected {
      background: linear-gradient(180deg, #fff0bd, #e4bf78);
      border-color: var(--fud-gold-2, #7a9bb6);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.4);
    }
    .fud-bf-card .fud-bf-item-row.is-disabled {
      cursor: not-allowed;
      opacity: 0.45;
      filter: grayscale(0.6);
    }
    .fud-bf-card .fud-bf-item-row.is-disabled:hover { background: rgba(255, 255, 255, 0.55); }
    .fud-bf-card .fud-bf-item-icon {
      width: 40px; height: 40px;
      border-radius: 6px;
      background-color: rgba(90, 106, 133, 0.10);
      background-size: cover;
      background-position: center;
      border: 1px solid rgba(90, 106, 133, 0.30);
    }
    .fud-bf-card .fud-bf-item-text {
      display: flex; flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .fud-bf-card .fud-bf-item-name {
      font-size: 13px;
      font-weight: 800;
      line-height: 1.1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--fud-ink, #3a3228);
    }
    .fud-bf-card .fud-bf-item-meta {
      font-size: 10.5px;
      font-weight: 600;
      opacity: 0.75;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--fud-ink-soft, #4b4338);
    }
    .fud-bf-card .fud-bf-item-cost {
      font-size: 13px;
      font-weight: 900;
      padding: 4px 8px;
      border-radius: 6px;
      background: rgba(90, 106, 133, 0.15);
      color: var(--fud-ink, #3a3228);
      min-width: 36px;
      text-align: center;
    }
    .fud-bf-card .fud-bf-item-cost.is-ip {
      background: rgba(154, 75, 34, 0.18);
      color: #8a4b22;
    }
    .fud-bf-card .fud-bf-ip-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 6px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      border-radius: 6px;
      background: rgba(154, 75, 34, 0.10);
      color: #8a4b22;
    }
    .fud-bf-card .fud-bf-ip-bar .fud-bf-ip-val { font-size: 13px; }
    .fud-bf-card .fud-btn-confirm.is-disabled {
      cursor: not-allowed;
      opacity: 0.45;
      filter: grayscale(0.6);
    }

    /* Description tooltip — shared singleton, body-mounted so it can
       escape the popover's overflow:auto clip. Reveal is delayed by JS
       (~600ms hover dwell) to match Foundry's native tooltip cadence. */
    .fud-bf-desc-tip {
      position: fixed;
      z-index: 2147483646;
      max-width: 340px;
      min-width: 200px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1.5px solid var(--fud-stroke, #5a6a85);
      background: var(--fud-parchment, #f1e6c4);
      color: var(--fud-ink, #3a3228);
      font-family: "Signika", "Roboto", sans-serif;
      font-size: 11.5px;
      line-height: 1.45;
      box-shadow: 0 6px 20px rgba(24, 28, 41, 0.45);
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
    }
    .fud-bf-desc-tip.is-visible { opacity: 1; }
    .fud-bf-desc-tip .fud-bf-desc-tip-name {
      font-size: 12.5px;
      font-weight: 800;
      margin-bottom: 4px;
      color: var(--fud-ink, #3a3228);
      border-bottom: 1px dashed rgba(90, 106, 133, 0.35);
      padding-bottom: 3px;
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0 0 6px;
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stats:empty { display: none; }
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-acc,
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-dmg,
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-def {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 5px;
      font-size: 10.5px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-acc {
      background: rgba(90, 106, 133, 0.18);
      color: var(--fud-stroke, #5a6a85);
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-dmg {
      background: rgba(154, 75, 34, 0.18);
      color: #8a4b22;
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-def {
      background: rgba(42, 110, 61, 0.18);
      color: #2a6e3d;
    }
    /* Weapon/shield/accessory trait chips — lighter, secondary tone. Used
       for type, range, hand-slots, attack stat, martial flag, rarity. */
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-trait {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 5px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.4px;
      background: rgba(58, 50, 40, 0.10);
      color: var(--fud-ink, #3a3228);
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-stat-trait.is-flag {
      background: rgba(154, 75, 34, 0.16);
      color: #8a4b22;
      text-transform: uppercase;
    }
    .fud-bf-desc-tip .fud-bf-desc-tip-body { font-weight: 400; }
    .fud-bf-desc-tip .fud-bf-desc-tip-body p { margin: 0 0 6px; }
    .fud-bf-desc-tip .fud-bf-desc-tip-body p:last-child { margin-bottom: 0; }
  `;
  document.head.appendChild(css);
}

// ─────────────────────────────────────────────────────────────────────
// Section builders
// ─────────────────────────────────────────────────────────────────────
function buildSubtitleHTML({ weapon, attackMode = "main", passIndex = 0, totalPasses = 0 }) {
  if (!weapon) return "";
  const bullets = [];
  if (weapon.range) bullets.push(escapeHtml(weapon.range));
  if (weapon.weaponType) bullets.push(`${weaponIconHTML(weapon.weaponType)}${escapeHtml(cap(weapon.weaponType))}`);
  // Hand label inferred from the weapon, not from passIndex — passIndex
  // doesn't map to Main/Off when the player chose the off-first order.
  const isTwoWeapon = String(attackMode).startsWith("two-weapon");
  if (isTwoWeapon) {
    const hand = weapon.hand === "off" ? "Off-Hand" : "Main Hand";
    const idx = (passIndex && totalPasses) ? ` ${passIndex}/${totalPasses}` : "";
    bullets.push(`<i class="fa-solid fa-swords" aria-hidden="true"></i>${hand}${idx}`);
  } else if (attackMode === "off") {
    bullets.push("Off-Hand");
  } else {
    bullets.push("Normal Attack");
  }
  const wrapped = bullets.map((b) => `<span class="bullet">${b}</span>`);
  return `<div class="fud-bf-subtitle">${wrapped.join(`<span class="dot">•</span>`)}</div>`;
}

function buildAttackerHTML({ attacker, targets }) {
  // Each target name is its own `<span class="t-name">` so CSS can wrap
  // the list across multiple rows when the comma-joined text overflows
  // (3+ named targets blow past the column otherwise). The span itself
  // stays nowrap so a single name doesn't break mid-word.
  const targetParts = (Array.isArray(targets) && targets.length)
    ? targets.map((t, i) => {
        const c = dispositionColor(t.disposition ?? 0);
        const sep = i > 0 ? `<span class="t-sep">, </span>` : "";
        return `${sep}<span class="t-name" style="color:${c}">${escapeHtml(t.name)}</span>`;
      }).join("")
    : `<span style="opacity:0.6;">—</span>`;

  const attackerName = `<span class="t-name">${escapeHtml(attacker.name)}</span>`;

  // Pick which side of the row holds the attacker vs. the targets — same
  // rule as the corner portraits (player/neutral → right, enemy → left,
  // with the same-side flip for ally-targeting). Without this, a player
  // casting an enemy-targeting spell shows attacker on left + enemies on
  // right which conflicts with the portrait corners — visually jarring.
  const { attackerSide } = pickActionSides({ attacker, targets });
  const attackerOnRight = attackerSide === "right";

  // CSS class flavors:
  //   .is-attacker  — single nowrap name (ellipsis if it'd overflow)
  //   .is-targets   — wraps multi-row, vertically centered
  const attackerCell = `<div class="${attackerOnRight ? "right" : "left"} is-attacker">${attackerName}</div>`;
  const targetsCell  = `<div class="${attackerOnRight ? "left"  : "right"} is-targets">${targetParts}</div>`;

  return `
    <fieldset class="fud-bf-section">
      <legend>Attacker</legend>
      <div class="fud-bf-attacker-row">
        ${attackerOnRight ? targetsCell : attackerCell}
        <div class="mid"><i class="fa-solid fa-swords"></i></div>
        ${attackerOnRight ? attackerCell : targetsCell}
      </div>
    </fieldset>
  `;
}

function buildAccuracyHTML({ roll, isSpellish = false, legendSuffix = "", hideDefenseIcon = false, legendOverride = null }) {
  if (!roll) return "";
  const { A1, A2, dA, dB, rA, rB, total, hr, checkBonus, checkBonusParts, isCrit, isFumble, opportunities } = roll;
  const accCls = isFumble ? "is-fumble" : isCrit ? "is-crit" : "";

  const dieA = `<span class="die-block">${attrIconHTML(A1)} <span class="attr">${escapeHtml(A1)}</span> <span class="die-size">d${dA}</span> <span class="die-result">${rA}</span></span>`;
  const dieB = `<span class="die-block">${attrIconHTML(A2)} <span class="attr">${escapeHtml(A2)}</span> <span class="die-size">d${dB}</span> <span class="die-result">${rB}</span></span>`;
  const bonusPart = (Number(checkBonus) || 0) !== 0
    ? `<span class="bonus">${checkBonus >= 0 ? "+" : ""}${checkBonus}</span>`
    : "";

  // Open Checks (Study, etc.) have no defense bar — skip the icon entirely.
  // Otherwise pick Strike (PEF) or Magic (MDEF) based on isSpellish.
  const iconUrl = isSpellish ? MAGIC_ICON_URL : STRIKE_ICON_URL;
  const iconAlt = isSpellish ? "Magic" : "Strike";
  const defenseIconHTML = hideDefenseIcon
    ? ""
    : `<img class="strike-icon" src="${iconUrl}" alt="${iconAlt}" title="${iconAlt}">`;

  // Float banner + per-RAW Opportunity note when crit (Core p.68: a crit
  // generates opportunities for the attacker).
  const banner = isCrit
    ? `<div class="float-banner crit"><i class="fa-solid fa-crown"></i>Critical!</div>`
    : isFumble
      ? `<div class="float-banner fumble"><i class="fa-solid fa-skull"></i>Fumble!</div>`
      : "";
  const opportunityNote = opportunities
    ? `<div class="fud-bf-opportunity"><i class="fa-solid fa-bolt"></i> Opportunity!</div>`
    : "";

  const baseLegend = legendOverride ?? "Accuracy Check";
  const suffix = legendSuffix ? ` <span style="opacity:0.7; font-weight: 700;">— ${escapeHtml(legendSuffix)}</span>` : "";

  // Calculation tooltip — surfaces the per-die rolls + bonus + HR + the
  // crit/fumble verdict on hover. Uses the same body-mounted tooltip
  // infrastructure as equipment-option descriptions (data-fud-equip-desc).
  const cbVal = Number(checkBonus) || 0;
  const cbStr = cbVal === 0 ? "—" : (cbVal >= 0 ? `+${cbVal}` : `${cbVal}`);

  // Per-source breakdown of where the check bonus came from. The roll
  // object's `checkBonusParts` is set by each COMPUTE handler when
  // multiple contributors stack (weapon + free-action grant + skill
  // bonus + future AE-driven bonuses). Renders as a nested list under
  // the total. Falls back to just the total when parts are absent
  // (legacy rolls without the breakdown).
  const parts = Array.isArray(checkBonusParts)
    ? checkBonusParts.filter((p) => p && Number(p.amount) !== 0)
    : [];
  const breakdownHTML = parts.length
    ? `<ul style="margin:2px 0 0 14px; padding:0; opacity:0.85; font-size:11.5px;">`
      + parts.map((p) => {
          const a = Number(p.amount) || 0;
          const sign = a >= 0 ? "+" : "−";
          return `<li><b>${escapeHtml(String(p.source ?? "Unknown"))}:</b> ${sign}${Math.abs(a)}</li>`;
        }).join("")
      + `</ul>`
    : "";

  const tipBody = [
    `<p><b>${escapeHtml(A1)}:</b> 1d${dA} → <b>${rA}</b></p>`,
    `<p><b>${escapeHtml(A2)}:</b> 1d${dB} → <b>${rB}</b></p>`,
    `<p style="margin-bottom:0;"><b>Check Bonus:</b> ${cbStr}</p>${breakdownHTML}`,
    `<p style="margin-top:6px;"><b>Total:</b> ${rA} + ${rB}${cbVal !== 0 ? ` ${cbVal >= 0 ? "+" : "-"} ${Math.abs(cbVal)}` : ""} = <b>${total}</b></p>`,
    `<p><b>HR (High Roll):</b> max(${rA}, ${rB}) = <b>${hr ?? Math.max(rA, rB)}</b></p>`,
    isCrit ? `<p style="color:#b40000;"><b>Critical!</b> Both dice matched (≥6) — auto-hit, Opportunity granted.</p>` : "",
    isFumble ? `<p><b>Fumble.</b> Both dice ≤ fumble threshold — auto-miss.</p>` : "",
    hideDefenseIcon
      ? `<p style="opacity:0.75;">Open Check — no defense compared.</p>`
      : `<p style="opacity:0.75;">Compares vs target's <b>${isSpellish ? "Magic Defense" : "Defense"}</b>.</p>`,
  ].filter(Boolean).join("");
  const tipAttrs = ` data-fud-equip-desc="${escapeHtml(tipBody)}" data-fud-equip-desc-name="${escapeHtml(baseLegend)}"`;

  return `
    <fieldset class="fud-bf-section"${tipAttrs}>
      <legend>${escapeHtml(baseLegend)}${suffix}</legend>
      <div class="fud-bf-acc ${accCls}">
        <div class="fud-bf-acc-row">
          ${dieA}
          <span class="plus">+</span>
          ${dieB}
          ${bonusPart}
          <span class="spacer"></span>
          <span class="total-wrap">
            ${defenseIconHTML}
            <span class="total">${total}</span>
          </span>
        </div>
        ${banner}
        ${opportunityNote}
      </div>
    </fieldset>
  `;
}

function buildDamagePreviewHTML({ damage, roll, legendSuffix = "" }) {
  if (!damage) return "";
  // MP-burn skills (Drain Spirit etc.) — element label reads "MP"
  // instead of an elemental name, and the colour uses a magic-blue
  // palette so it visually reads as resource damage. Drives the
  // tooltip's affinity note too (MP damage is always NE — no sheet
  // supports MP affinity).
  const isMpDamage = String(damage.resource ?? "").toLowerCase() === "mp";
  const isHealing  = !!damage.isHealing || !!damage.declaresHealing;
  const isHpHeal   = isHealing && !isMpDamage;
  const isMpHeal   = isHealing && isMpDamage;
  const elemKey = String(damage.element ?? "physical").toLowerCase();
  const color = isHpHeal
    ? "#2a8a3a"   // healing green
    : (isMpHeal || isMpDamage)
      ? "#1e6cff" // mp blue (damage or restore — context distinguishes)
      : (ELEMENT_COLOR[elemKey] ?? ELEMENT_COLOR.physical);
  const glow  = isHpHeal
    ? "rgba(42,138,58,0.45)"
    : (isMpHeal || isMpDamage)
      ? "rgba(30,108,255,0.45)"
      : (ELEMENT_GLOW[elemKey]  ?? ELEMENT_GLOW.physical);

  // Final shown is HR + base. If the roll is a fumble, show "—".
  const shown = roll?.isFumble ? "—" : (damage.finalIfHit ?? 0);
  const hrPill = (damage.ignoreHR || roll?.isFumble) ? "" : `<span class="hr-pill">+HR</span>`;
  const label = isHpHeal
    ? "Heal"
    : isMpHeal
      ? "Restore"
      : (isMpDamage ? "MP Damage" : "Damage");
  const elementLabel = isHpHeal
    ? "HP"
    : isMpHeal
      ? "MP"
      : (isMpDamage ? "MP" : escapeHtml(cap(elemKey)));
  const suffix = legendSuffix ? ` <span style="opacity:0.7; font-weight: 700;">— ${escapeHtml(legendSuffix)}</span>` : "";

  // Calculation tooltip — surfaces base damage + HR contribution + how
  // affinity will mutate the final number per target.
  const baseVal = Number(damage.base ?? 0) || 0;
  const baseStr = baseVal >= 0 ? `+${baseVal}` : `${baseVal}`;
  const hrVal = roll?.isFumble ? 0 : (roll?.hr ?? 0);
  const hrLine = damage.ignoreHR
    ? `<p><b>HR:</b> — (Two-Weapon Fighting forces HR=0)</p>`
    : (roll
        ? `<p><b>HR:</b> ${hrVal} (from accuracy roll)</p>`
        : `<p><b>HR:</b> — (no Check rolled)</p>`);
  const prePassiveBonus = Number(damage.prePassiveBonus ?? 0) || 0;
  const formula = roll?.isFumble
    ? `<p><b>Final:</b> — (fumble auto-misses)</p>`
    : prePassiveBonus > 0
      ? `<p style="margin-top:6px;"><b>Final on hit:</b> ${hrVal} + ${baseVal} + ${prePassiveBonus} (passive) = <b>${damage.finalIfHit ?? 0}</b></p>`
      : `<p style="margin-top:6px;"><b>Final on hit:</b> ${hrVal} + ${baseVal} = <b>${damage.finalIfHit ?? 0}</b></p>`;
  const tipBody = [
    isMpDamage
      ? `<p><b>Element:</b> MP damage (resource burn, no element)</p>`
      : `<p><b>Element:</b> ${escapeHtml(cap(elemKey))}${damage.declaresHealing ? " (healing)" : ""}</p>`,
    `<p><b>Base bonus:</b> ${baseStr}</p>`,
    hrLine,
    formula,
    isMpDamage
      ? `<p style="margin-top:6px; opacity:0.85;">MP damage skips elemental affinity — final number lands on each target's current MP unchanged.</p>`
      : `<p style="margin-top:6px; opacity:0.85;"><b>Per-target affinity:</b></p>`,
    isMpDamage ? "" : `<p style="opacity:0.85;">VU = ×2 &nbsp;•&nbsp; RS = ×0.5 (round up)</p>`,
    isMpDamage ? "" : `<p style="opacity:0.85;">IM = 0 &nbsp;•&nbsp; AB = heals target</p>`,
  ].filter(Boolean).join("");
  const tipName = damage.declaresHealing
    ? "Healing"
    : (isMpDamage ? "MP Damage Preview" : `${label} Preview`);
  const tipAttrs = ` data-fud-equip-desc="${escapeHtml(tipBody)}" data-fud-equip-desc-name="${escapeHtml(tipName)}"`;

  return `
    <fieldset class="fud-bf-section fud-bf-dmg"${tipAttrs}>
      <legend>${label}${suffix}</legend>
      <div class="fud-bf-dmg-row">
        <div class="fud-bf-dmg-number" style="color:${color}; text-shadow: 0 0 15px ${glow};">
          ${shown}${hrPill}
        </div>
        <div class="fud-bf-dmg-element" style="color:${color};">${elementLabel}</div>
      </div>
    </fieldset>
  `;
}

// Affinity-tag formatting. Player-side affinity is hidden behind Study
// (Tier 13 = Details, encyclopedia spec line 12) — but for v1 we use the
// SAME gate as DEF (Identity tier ≥ 7) so the GM doesn't have to think
// about two separate visibility checks. Affinities are only shown for hits
// (a miss reveals nothing about the target's reaction).
function buildAffinityTagHTML({ affinity, hit, studied }) {
  if (!hit) return "";
  if (affinity === "NE" || !affinity) return "";
  if (studied === false) return "";  // hide from player perspective
  const meta = {
    VU: { icon: "💥", label: "Vulnerable", color: "#c44a2a" },
    RS: { icon: "🛡️", label: "Resistant",  color: "#5a6a85" },
    IM: { icon: "❌", label: "Immune",     color: "#1f1f1f" },
    AB: { icon: "❤️", label: "Absorbing",  color: "#2a8a3a" },
  }[affinity];
  if (!meta) return "";
  return `<span class="t-affinity" style="color:${meta.color};" title="${meta.label}"><span class="affinity-icon" aria-hidden="true">${meta.icon}</span>${meta.label}</span>`;
}

// Result label for a per-target row. Honors hit/crit/miss + affinity:
//   AB hit → "HEALS N"  (the attacker just healed their target)
//   IM hit → "NO EFFECT" (technically a hit per the dice, but 0 damage)
//   else hit → "HIT — N dmg" (or "N MP" for MP-burn skills)
//
// `r.resource === "mp"` (set on each row from the parent damage's
// resource field) flips the unit label so MP-damage skills read
// naturally on the card. Affinity rows are still gated NE for MP
// damage, so AB / IM never appear there in practice.
function resultLabelFor(r, { hasDamage = true } = {}) {
  // Recipe-grant rows (Heal, MP restore, future shield) — show what
  // the target will recover. `grantResource` picks the unit/verb. These
  // always succeed (no Check), so check the grant before hit semantics.
  if (typeof r.grantAmount === "number") {
    // Vismagus self-heal suppression — the caster paid HP for this
    // spell so they recover none of the HP it would otherwise grant.
    // Render an explicit "no heal" label so the card doesn't show a
    // green number that contradicts what actually happens.
    if (r.vismagusSuppressed) return "NO HEAL · VISMAGUS";
    const amt = Math.max(0, r.grantAmount);
    if (r.grantResource === "mp")     return `RESTORED ${amt} MP`;
    if (r.grantResource === "shield") return `SHIELDED ${amt}`;
    return `HEALED ${amt} HP`;
  }
  // Non-damage Check (Soul Steal/Pillage, Torpor, Hallucination,
  // Enrage, future opposed-Check skills): the Check outcome IS the
  // effect, the mechanical payoff lands in the effect_table chain
  // (IP grant, status apply, etc.) — not as a number on the row.
  // Use SUCCESS/FAILED so the card doesn't read as "NO EFFECT" (which
  // would only be correct for IM-affinity damage skills).
  if (!hasDamage) return r.hit ? "SUCCESS" : "FAILED";
  // Damage skill — existing HIT/MISS/AB/IM/NO-EFFECT logic.
  if (!r.hit) return "MISS";
  const unit = r.resource === "mp" ? "MP" : "dmg";
  if (r.affinity === "AB") return `HEALS ${Math.max(0, r.damage)}`;
  if (r.affinity === "IM" || r.damage <= 0) return "NO EFFECT";
  return `HIT — ${r.damage} ${unit}`;
}

function resultClsFor(r) {
  if (!r.hit) return "miss";
  if (r.crit) return "crit";
  if (typeof r.grantAmount === "number") {
    if (r.vismagusSuppressed) return "miss"; // visually muted — no heal landed
    if (r.grantResource === "mp")     return "restore-mp";
    if (r.grantResource === "shield") return "shield";
    return "heal";
  }
  if (r.affinity === "AB") return "absorb";
  if (r.affinity === "IM") return "miss";  // visually muted
  return "hit";
}

// Per-target affinity description sentence used in the row tooltip.
// Pairs the affinity code with the element so the hover reads naturally
// ("Vulnerable to Fire ×2") instead of just the abstract label.
function affinityLineHTML(affinity, elemLabel) {
  const meta = {
    NE: { word: "Neutral",     mult: "×1",   color: "#5a5a5a" },
    VU: { word: "Vulnerable",  mult: "×2",   color: "#c44a2a" },
    RS: { word: "Resistant",   mult: "×0.5", color: "#5a6a85" },
    IM: { word: "Immune",      mult: "0",    color: "#1f1f1f" },
    AB: { word: "Absorbing",   mult: "heal", color: "#2a8a3a" },
  }[affinity] ?? null;
  if (!meta) return `<p><b>Affinity:</b> Unknown</p>`;
  if (affinity === "NE") {
    return `<p><b>Affinity:</b> Neutral to ${escapeHtml(elemLabel)} (×1)</p>`;
  }
  return `<p><b>Affinity:</b> <span style="color:${meta.color}; font-weight:800;">${meta.word}</span> to ${escapeHtml(elemLabel)} (${meta.mult})</p>`;
}

function buildPerTargetHTML({ perTargetResults, legendSuffix = "", weapon = null, element = null, roll = null, isSpellish = false, hasDamage = true }) {
  // Element label for tooltips. Prefer the explicit element passed by
  // the card (the action's damage element), fall back to the weapon's
  // damageType (Attack), and finally to a literal "—" so the tooltip
  // never reads as "undefined".
  const elemRaw = String(
    element ?? weapon?.damageType ?? ""
  ).toLowerCase();
  const elemLabel = elemRaw ? cap(elemRaw) : "—";
  // Defense label varies by action kind. Spellish actions (Skill/Spell
  // with skill_type='Spell') compare vs the target's Magic Defense in
  // COMPUTE — show "MDEF" instead of "DEF" so the per-target row
  // matches what's actually being checked.
  const defLabelTag = isSpellish ? "MDEF" : "DEF";
  const rows = (perTargetResults ?? []).map((r) => {
    // Player attacker hasn't Studied this enemy → mask EVERYTHING that
    // requires Identity-tier knowledge to compute:
    //   - DEF (need DEF number to decide hit)
    //   - hit/miss + damage (player can't know the outcome without DEF)
    //   - affinity (Identity-tier reveal)
    // The row still shows the target's name so the player knows whom
    // they were targeting; everything else becomes "???".
    if (r.studied === false) {
      const maskedTip = `<p>Study this target to identity tier (≥7) to reveal defense, damage, and affinity.</p>`;
      const maskedAttrs = ` data-fud-equip-desc="${escapeHtml(maskedTip)}" data-fud-equip-desc-name="${escapeHtml(r.name)}"`;
      return `<div class="fud-bf-target-row"${maskedAttrs}>
        <span class="t-name">${escapeHtml(r.name)}</span>
        <span class="t-def">${defLabelTag} ???</span>
        <span class="t-result">???</span>
      </div>`;
    }
    const cls = resultClsFor(r);
    const label = resultLabelFor(r, { hasDamage });
    // Grant rows (Heal etc.) don't have a defense check — show the
    // target's current resource value instead so the player sees
    // "HP 18/24" → "HEALED 40 HP" at a glance.
    let defLabel;
    if (typeof r.grantAmount === "number") {
      const unit = r.grantResource === "mp" ? "MP" : "HP";
      defLabel = (r.resourceCur != null && r.resourceMax != null)
        ? `${unit} ${r.resourceCur}/${r.resourceMax}`
        : unit;
    } else {
      defLabel = `${defLabelTag} ${r.defense}`;
    }
    const aff = buildAffinityTagHTML({ affinity: r.affinity, hit: r.hit, studied: r.studied });

    // Per-target tooltip — surfaces weapon/element/affinity context for
    // this specific target. Deliberately does NOT repeat the damage
    // formula (the Damage panel's own tooltip already covers that);
    // this hover focuses on what's TARGET-specific so the GM can see
    // at a glance why this enemy took 12 dmg vs another's 24.
    const tipLines = [];
    if (weapon?.name) {
      const wt = weapon.weaponType ? ` (${escapeHtml(cap(weapon.weaponType))})` : "";
      tipLines.push(`<p><b>Weapon:</b> ${escapeHtml(weapon.name)}${wt}</p>`);
    }
    // Element + affinity only make sense when the skill deals damage —
    // status-only Checks (Torpor / Hallucination / Enrage) have no
    // element to route through affinity, so skip those tooltip lines.
    if (hasDamage) {
      tipLines.push(`<p><b>Element:</b> ${escapeHtml(elemLabel)}</p>`);
      tipLines.push(affinityLineHTML(r.affinity, elemLabel));
    }
    if (roll?.isFumble) {
      tipLines.push(`<p><b>Hit Check:</b> Fumble — auto-miss</p>`);
    } else if (r.crit) {
      tipLines.push(`<p><b>Hit Check:</b> Critical — auto-hit</p>`);
    } else if (roll) {
      const cmp = r.hit ? "≥" : "&lt;";
      const verdict = r.hit ? "hit" : "missed";
      tipLines.push(`<p><b>Hit Check:</b> Total ${roll.total} ${cmp} ${defLabelTag} ${r.defense} — ${verdict}</p>`);
    } else {
      // No-Check skill (rare) — no hit roll, defaults to hit on damage.
      tipLines.push(`<p><b>Hit Check:</b> Auto-hit (no Check)</p>`);
    }
    if (hasDamage && r.hit && r.affinity === "AB") {
      tipLines.push(`<p style="opacity:0.85;">Damage is reversed into healing.</p>`);
    } else if (hasDamage && r.hit && r.affinity === "IM") {
      tipLines.push(`<p style="opacity:0.85;">Target negates all damage of this element.</p>`);
    }
    const tipBody = tipLines.join("");
    const tipAttrs = ` data-fud-equip-desc="${escapeHtml(tipBody)}" data-fud-equip-desc-name="${escapeHtml(r.name)}"`;

    // Stable hooks for the live preview update (Phase 3 of Cheap Shot):
    // the recompute helper finds the row by actor uuid and patches the
    // result span's text + class when an add_damage pill toggles.
    const rowDataAttrs =
      ` data-fud-target-actor-uuid="${escapeHtml(String(r.actorUuid ?? ""))}"`;
    return `<div class="fud-bf-target-row"${rowDataAttrs}${tipAttrs}>
      <span class="t-name">${escapeHtml(r.name)}${aff ? ` ${aff}` : ""}</span>
      <span class="t-def">${defLabel}</span>
      <span class="t-result ${cls}">${label}</span>
    </div>`;
  }).join("");
  const suffix = legendSuffix ? ` <span style="opacity:0.7; font-weight: 700;">— ${escapeHtml(legendSuffix)}</span>` : "";

  return `
    <fieldset class="fud-bf-section">
      <legend>Result${suffix}</legend>
      <div class="fud-bf-target-list">${rows || `<div style="opacity:0.6;font-size:12px;">No targets.</div>`}</div>
    </fieldset>
  `;
}

function buildButtonsHTML({ isFumble = false, hasRoll = true }) {
  const lockedAttrs = isFumble
    ? `class="fud-btn fud-btn-invoke is-locked" title="Locked: Invoke cannot be used on a Fumble."`
    : `class="fud-btn fud-btn-invoke is-locked" title="Invoke Trait / Bond — coming in Phase E"`;

  // Invoke Trait + Invoke Bond are visually present but locked: legacy
  // mirrors this on Fumble; we use the same lock for "not yet implemented"
  // so they're easy to enable once Phase E lands.
  //
  // For no-Check skills (Heal, Reinforce, etc.) the Invoke row is hidden
  // entirely — there's no roll to reroll, so the buttons are nonsense
  // here, not just disabled.
  //
  // No Cancel button: once the dice are rolled the player can't normally
  // backtrack. GM-side rewind belongs on a future Undo button.
  const invokeRow = hasRoll
    ? `
      <div class="fud-bf-btn-row">
        <div ${lockedAttrs} data-fud-invoke="trait" aria-disabled="true">
          <span class="btn-label"><span class="icon">🎭</span>Invoke Trait</span>
          <span class="lock-icon"><i class="fa-solid fa-lock"></i></span>
        </div>
        <div ${lockedAttrs} data-fud-invoke="bond" aria-disabled="true">
          <span class="btn-label"><span class="icon">🤝</span>Invoke Bond</span>
          <span class="lock-icon"><i class="fa-solid fa-lock"></i></span>
        </div>
      </div>`
    : "";
  return `
    ${invokeRow}
    <div class="fud-bf-btn-row">
      <div class="fud-btn fud-btn-confirm" data-fud-action="confirm" role="button" tabindex="0">Confirm</div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
// Top-level body composers per `kind`
// ─────────────────────────────────────────────────────────────────────
// Decide which side of the card holds the attacker vs. the targets.
// Used both for the corner portrait grids AND for the Attacker panel's
// left/right name placement, so both stay in lockstep.
//
// Sides are anchored by DISPOSITION, not by who's currently acting:
//   player/neutral (disposition >= 0) → right
//   enemy/hostile  (disposition === -1) → left
//
// Exception: when the targets share the attacker's side (heal-on-ally,
// enemy-buffs-enemy), the target slot flips to the OPPOSITE corner so
// the caster + targets read as distinct. Without this, casting Heal on
// Hina would render Hina-attacker AND Hina-target both top-right,
// stacked behind each other.
function pickActionSides({ attacker, targets }) {
  const targetsList = Array.isArray(targets) ? targets : [];
  const attackerDisp = attacker?.disposition ?? 0;
  // disposition === -1 (hostile) → left. 0 (neutral) and 1 (friendly) → right.
  const attackerSide = attackerDisp === -1 ? "left" : "right";

  // Target side. Empty target list → no target portraits / no flip.
  let targetSide = null;
  if (targetsList.length) {
    const targetDisps = targetsList.map((t) => t.disposition ?? 0);
    const allSameAsAttacker = targetDisps.every((d) => d === attackerDisp);
    if (allSameAsAttacker) {
      // Same disposition as the attacker — push them to the opposite
      // corner so the two slots don't overlap.
      targetSide = attackerSide === "right" ? "left" : "right";
    } else {
      // Mixed or opposite-disposition targets — anchor by the targets'
      // dominant disposition. Enemy majority → left, friendly majority
      // → right. If majority somehow lands on attacker's side anyway,
      // fall back to opposite (the same-side guard above).
      const enemyCount  = targetDisps.filter((d) => d === -1).length;
      const friendCount = targetDisps.filter((d) => d  >=  0).length;
      const dominantSide = enemyCount > friendCount ? "left" : "right";
      targetSide = dominantSide === attackerSide
        ? (attackerSide === "right" ? "left" : "right")
        : dominantSide;
    }
  }

  return { attackerSide, targetSide };
}

// Multi-target: each side's slot can hold N portraits in a flex-wrapped
// grid inside the same 48×48 anchor box, so the layout footprint is
// constant. Cell size scales with count so cells stay close to square.
function pickPortraitLayout({ attacker, perTargetResults }) {
  const targets = Array.isArray(perTargetResults) ? perTargetResults : [];
  const { attackerSide, targetSide } = pickActionSides({ attacker, targets });

  const attackerSlot = attacker?.tokenImg
    ? { img: attacker.tokenImg, name: attacker.name }
    : null;
  const targetSlots = targets
    .map((t) => (t?.tokenImg ? { img: t.tokenImg, name: t.name } : null))
    .filter(Boolean);

  return {
    attackerSide,
    targetSide,
    attackerSlots: attackerSlot ? [attackerSlot] : [],
    targetSlots,
  };
}

// ONE full token sprite for a single-target / attacker side. Full art (no
// mask), kept at its native aspect ratio. Centred + bottom-aligned by the slot
// CSS; the left-side mirror (face centre) is applied via the slot's `.left`
// class. Animated .webm tokens render in a <video>; static art in an <img>.
function fullSpriteHTML(slot) {
  const url = safeImgUrl(slot?.img);
  if (!url) return "";
  const safe = escapeHtml(url);
  const name = escapeHtml(slot.name ?? "");
  if (isVideoUrl(url)) {
    return `<video class="fud-bf-portrait-sprite" src="${safe}"
                   autoplay loop muted playsinline disablepictureinpicture
                   title="${name}" aria-label="${name}"></video>`;
  }
  return `<img class="fud-bf-portrait-sprite" src="${safe}" title="${name}" alt="${name}">`;
}

// MULTIPLE targets → the compact masked circular grid (the look from before the
// full-sprite experiment): 1→full, 2→2-up, 3-4→2×2, 5-9→3×3, cells scaled to
// stay ~square. Uses <img>/<video> + CSS circular crop (border-radius +
// object-fit:cover) so animated .webm tokens render — the old version used
// background-image, which silently failed on video.
function maskedGridHTML(slots) {
  const valid = (slots ?? []).filter((s) => safeImgUrl(s?.img));
  if (!valid.length) return "";
  const n = valid.length;
  const BOX = 48, GAP = 2;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cell = Math.floor((BOX - GAP * (cols - 1)) / cols);
  const cells = valid.map((slot) => {
    const url = safeImgUrl(slot.img);
    const safe = escapeHtml(url);
    const name = escapeHtml(slot.name ?? "");
    const media = isVideoUrl(url)
      ? `<video src="${safe}" autoplay loop muted playsinline disablepictureinpicture></video>`
      : `<img src="${safe}" alt="${name}">`;
    return `<div class="fud-bf-portrait-cell" style="width:${cell}px; height:${cell}px;"
                 title="${name}" aria-label="${name}" role="img">${media}</div>`;
  }).join("");
  return `<div class="fud-bf-portrait-grid">${cells}</div>`;
}

// Build the two header sprite slots ({ left, right }) for an action. Attacker
// and target land on opposite sides (by disposition), so one populates `left`
// and the other `right`; a side with no sprite stays "". A side with a single
// sprite renders the full sprite; multiple targets render the masked grid.
function buildPortraitsHTML({ attacker, perTargetResults }) {
  const layout = pickPortraitLayout({ attacker, perTargetResults });
  const slots = { left: "", right: "" };
  const render = (arr) => (arr.length === 1 ? fullSpriteHTML(arr[0]) : maskedGridHTML(arr));
  if (layout.attackerSlots?.length && (layout.attackerSide === "left" || layout.attackerSide === "right")) {
    slots[layout.attackerSide] = render(layout.attackerSlots);
  }
  if (layout.targetSlots?.length && (layout.targetSide === "left" || layout.targetSide === "right")) {
    slots[layout.targetSide] = render(layout.targetSlots);
  }
  return slots;
}

function buildAttackCard({ attacker, weapon, targets, roll, damage, perTargetResults, attackMode, passIndex, totalPasses }) {
  // Each pass is rendered as a SEPARATE card — Compute fills the top-level
  // roll/damage/perTargetResults for the current weapon only, and CLEANUP
  // loops back to COMPUTE for the next pass.
  const titleText = weapon?.name ?? "Attack";
  // Title icon — tolerate missing/invalid weapon image silently.
  const safeWeaponUrl = safeImgUrl(weapon?.imageUrl);
  const titleIcon = safeWeaponUrl
    ? `<img class="fud-bf-title-icon" src="${escapeHtml(safeWeaponUrl)}" alt="">`
    : "";
  const subtitle = tryBuild("subtitle", () => buildSubtitleHTML({
    weapon,
    attackMode: attackMode ?? "main",
    passIndex: passIndex ?? 0,
    totalPasses: totalPasses ?? 0,
  }));

  return {
    titleIcon,
    titleText,
    subtitle,
    portraits: tryBuild("portraits", () => buildPortraitsHTML({ attacker, perTargetResults })),
    body: `
      ${tryBuild("attacker", () => buildAttackerHTML({ attacker, targets }))}
      ${tryBuild("accuracy", () => buildAccuracyHTML({ roll, isSpellish: false }))}
      ${tryBuild("damage", () => buildDamagePreviewHTML({ damage, roll }))}
      ${tryBuild("perTarget", () => buildPerTargetHTML({ perTargetResults, weapon, element: damage?.element, roll }))}
    `,
    buttons: buildButtonsHTML({ isFumble: !!roll?.isFumble }),
  };
}

function buildGuardCard({ attacker, coverTarget }) {
  // Portrait slots for Guard:
  //   - Defender (the guarder, always friendly on player turns) → right
  //   - Cover target (if any) → left (the protected ally)
  // The portrait picker normally infers slots from attacker disposition;
  // here we hand it a synthetic perTargetResults so the cover ally lands
  // on the left where targets normally go.
  const portraitsInput = coverTarget
    ? [{
        tokenImg: coverTarget.tokenImg,
        name: coverTarget.name,
        // Force the cover target into the "left" slot regardless of
        // disposition (it's an ally, but visually we want it apart from
        // the guarder portrait).
        disposition: (attacker.disposition === 1) ? -1 : 1,
      }]
    : [];

  const coverLine = coverTarget
    ? `<div style="margin-top:4px;">Covers <strong style="color:#3aa0ff">${escapeHtml(coverTarget.name)}</strong> — they cannot be targeted by melee attacks.</div>`
    : "";

  return {
    titleIcon: `<i class="fa-solid fa-shield-halved" style="font-size:20px; color:var(--fud-stroke,#5a6a85);"></i>`,
    titleText: "Guard",
    subtitle: `<div class="fud-bf-subtitle">Defensive Stance<span class="dot">•</span>${coverTarget ? "With Cover" : "Self only"}<span class="dot">•</span>Until next turn</div>`,
    portraits: tryBuild("portraits", () => buildPortraitsHTML({ attacker, perTargetResults: portraitsInput })),
    body: `
      <fieldset class="fud-bf-section">
        <legend>Defender</legend>
        <div class="fud-bf-attacker-row">
          <div class="left">${escapeHtml(attacker.name)}</div>
          <div class="mid"><i class="fa-solid fa-shield-halved"></i></div>
          <div class="right">${coverTarget ? `Covering <span style="color:#3aa0ff">${escapeHtml(coverTarget.name)}</span>` : "Guarding"}</div>
        </div>
      </fieldset>
      <fieldset class="fud-bf-section" style="font-size:12.5px; line-height:1.5;">
        <legend>Effect</legend>
        Gains <strong>Resistance to all damage types</strong>, plus <strong>+2 to Opposed Checks</strong>, until the start of their next turn.
        ${coverLine}
      </fieldset>
    `,
    buttons: `
      <div class="fud-bf-btn-row">
        <div class="fud-btn fud-btn-confirm" data-fud-action="confirm" role="button" tabindex="0">Confirm</div>
      </div>
    `,
  };
}

// Tier color/label mapping for the Study card. Mirrors the thresholds
// in `scripts/encyclopedia/encyclopedia-core.js` (Identity ≥7, Stats ≥8,
// Details ≥13). The legend "None" covers totals < 7 (sub-Identity).
const STUDY_TIER_COLOR = {
  Details: "#9b59b6",
  Stats:   "#48c774",
  Identity: "#5ab3d4",
  None:    "#888",
};

function tierNameForBest(best) {
  if (best >= 13) return "Details";
  if (best >= 8)  return "Stats";
  if (best >= 7)  return "Identity";
  return "None";
}

function buildStudyCard({ attacker, target, roll, tier, previousBest, improved }) {
  // Portrait slots: studier on the player side, target on the enemy side.
  // Reuse pickPortraitSlots by handing it a synthetic per-target list.
  const targetForPortraits = target
    ? [{ tokenImg: target.tokenImg, name: target.name, disposition: target.disposition }]
    : [];

  const tierName = tier?.name ?? "None";
  const tierColor = STUDY_TIER_COLOR[tierName] ?? STUDY_TIER_COLOR.None;
  const previousTierName = tierNameForBest(previousBest ?? 0);
  // "New tier unlocked" should only celebrate an actual tier crossing —
  // e.g. None → Identity, Identity → Stats, Stats → Details. A roll that
  // improved the best-result number but stayed inside the same tier
  // reveals no new info to the player, so we treat it as "no new info."
  const tierAdvanced = !roll?.isFumble && tierName !== previousTierName && tierName !== "None";
  const tierLine = roll?.isFumble
    ? `<span style="color:#9a4a4a;">Fumble — no information gained.</span>`
    : tierAdvanced
      ? (previousTierName === "None"
          ? `First tier unlocked: <em>${escapeHtml(tierName)}</em>.`
          : `New tier unlocked: <em>${escapeHtml(tierName)}</em> (was <em>${escapeHtml(previousTierName)}</em>).`)
      : `Already known to <em>${escapeHtml(previousTierName)}</em> tier — no new info.`;

  return {
    titleIcon: target?.tokenImg && safeImgUrl(target.tokenImg)
      ? `<img class="fud-bf-title-icon" src="${escapeHtml(safeImgUrl(target.tokenImg))}" alt="">`
      : `<i class="fa-solid fa-magnifying-glass" style="font-size:18px; color:#5ab3d4;"></i>`,
    titleText: target?.name ?? "Study",
    subtitle: `<div class="fud-bf-subtitle">Open Check<span class="dot">•</span>${escapeHtml(roll?.A1 ?? "INS")} + ${escapeHtml(roll?.A2 ?? "INS")}<span class="dot">•</span>Study</div>`,
    portraits: tryBuild("portraits", () => buildPortraitsHTML({ attacker, perTargetResults: targetForPortraits })),
    body: `
      <fieldset class="fud-bf-section">
        <legend>Studier</legend>
        <div class="fud-bf-attacker-row">
          <div class="left">${escapeHtml(attacker.name)}</div>
          <div class="mid"><i class="fa-solid fa-magnifying-glass"></i></div>
          <div class="right">${escapeHtml(target?.name ?? "—")}</div>
        </div>
      </fieldset>
      ${tryBuild("studyAccuracy", () => buildAccuracyHTML({ roll, hideDefenseIcon: true, legendOverride: "Open Check" }))}
      <fieldset class="fud-bf-section">
        <legend>Tier Reached</legend>
        <div style="font-size:18px; font-weight:900; color:${tierColor}; text-align:center; letter-spacing:0.5px;">
          ${escapeHtml(tierName)}${tier?.threshold ? ` <span style="font-size:12px; opacity:0.7; font-weight:700;">(≥ ${tier.threshold})</span>` : ""}
        </div>
        <div style="font-size:12px; text-align:center; opacity:0.85; margin-top:4px;">
          ${tierLine}
        </div>
      </fieldset>
    `,
    buttons: `
      <div class="fud-bf-btn-row">
        <div class="fud-btn fud-btn-confirm" data-fud-action="confirm" role="button" tabindex="0">${improved && !roll?.isFumble ? "Record Study" : "Confirm"}</div>
      </div>
    `,
  };
}

// The four Hinder statuses (RAW Core p.71). Visual definition for the
// card buttons + the AE icon used at RESOLVE time. Statuses correspond
// to attribute penalties (RAW p.94) — handled by the affected mechanic,
// not by the card.
const HINDER_STATUSES = [
  { key: "dazed",  label: "Dazed",  icon: "🌀", attrShort: "INS", color: "#9b59b6", iconUrl: "icons/svg/daze.svg" },
  { key: "shaken", label: "Shaken", icon: "😱", attrShort: "WLP", color: "#5a6a85", iconUrl: "icons/svg/terror.svg" },
  { key: "slow",   label: "Slow",   icon: "🐢", attrShort: "DEX", color: "#8b5e3c", iconUrl: "icons/svg/clockwork.svg" },
  { key: "weak",   label: "Weak",   icon: "💔", attrShort: "MIG", color: "#c44a2a", iconUrl: "icons/svg/degen.svg" },
];

function buildEquipmentCard({ attacker, attackerActor }) {
  // Integrated swap UI — one custom dropdown per slot (Main / Off / Acc 1
  // / Acc 2). Each lists the current selection + every eligible item from
  // the actor's inventory, with icon + name + subtitle (element • type •
  // attack stat for weapons; DEF/MDEF for shields). The player changes
  // whichever slots they want, then clicks Done. The card's click
  // handler collects the selected ids when Done is pressed and forwards
  // them via finish() extras; Confirm merges them into actionResult and
  // RESOLVE calls applyEquipmentSwap() to commit. Armor is intentionally
  // NOT a slot here — RAW Core p.70 forbids armor swap mid-combat.
  //
  // Duplicate prevention: hand slots share group "hand"; accessory slots
  // share group "acc". The click handler in postActionCard scans the
  // peer row in the same group when an option is picked and clears it if
  // it points at the same itemId — no double-equipping the same physical
  // item in both hands / both accessory slots.
  const slotInfo = attackerActor
    ? tryBuild("equipment-slots", () => gatherEquipmentSlots(attackerActor))
    : { slots: [] };

  const groupOf = (key) =>
    (key === "main" || key === "off") ? "hand" : "acc";

  const emptyLabelOf = (key) =>
    (key === "main" || key === "off") ? "Empty Hand" : "No Accessory";
  const emptySubtitleOf = (key) =>
    (key === "main" || key === "off") ? "No weapon equipped" : "Slot is open";
  const emptyIconOf = (key) =>
    (key === "main" || key === "off") ? "✋" : "—";

  const metaHTML = (cand) => {
    const parts = [];
    // Order for weapons: element → weapon type → attack stat → 2H badge.
    // Shields/accessories don't have an element so the category label
    // leads instead.
    if (cand.element && cand.element !== "-") {
      parts.push(escapeHtml(cand.element));
    }
    if (cand.weaponType) {
      parts.push(`${cand.typeIcon} ${escapeHtml(cap(cand.weaponType))}`);
    } else if (cand.category === "shield") {
      parts.push(`${cand.typeIcon} Shield`);
    } else if (cand.category === "accessory") {
      parts.push(`${cand.typeIcon} Accessory`);
    }
    if (cand.attackStat) parts.push(escapeHtml(cand.attackStat));
    if (cand.defenseLine) parts.push(escapeHtml(cand.defenseLine));
    if (cand.isTwoHanded) parts.push(`<span style="color:#8a4b22; font-weight:800;">2H</span>`);
    if (!parts.length) return "";
    return parts.join(`<span class="dot">•</span>`);
  };

  const triggerForCurrent = (cand, key) => {
    if (!cand) {
      return `
        <div class="fud-bf-equip-icon fud-bf-equip-icon-empty">${emptyIconOf(key)}</div>
        <div class="fud-bf-equip-text">
          <div class="fud-bf-equip-name">${emptyLabelOf(key)}</div>
          <div class="fud-bf-equip-meta">${emptySubtitleOf(key)}</div>
        </div>
        <div class="fud-bf-equip-caret"><i class="fa-solid fa-chevron-down"></i></div>
      `;
    }
    const iconHTML = cand.img
      ? `<div class="fud-bf-equip-icon" style="background-image:url('${escapeHtml(safeImgUrl(cand.img))}')"></div>`
      : `<div class="fud-bf-equip-icon">${cand.typeIcon}</div>`;
    return `
      ${iconHTML}
      <div class="fud-bf-equip-text">
        <div class="fud-bf-equip-name">${escapeHtml(cand.name)}</div>
        <div class="fud-bf-equip-meta">${metaHTML(cand)}</div>
      </div>
      <div class="fud-bf-equip-caret"><i class="fa-solid fa-chevron-down"></i></div>
    `;
  };

  const optionHTML = (cand, isSelected, key) => {
    if (!cand) {
      return `
        <div class="fud-bf-equip-option ${isSelected ? "is-selected" : ""}"
             data-fud-equip-value="" role="option">
          <div class="fud-bf-equip-icon fud-bf-equip-icon-empty">${emptyIconOf(key)}</div>
          <div class="fud-bf-equip-text">
            <div class="fud-bf-equip-name">${emptyLabelOf(key)}</div>
            <div class="fud-bf-equip-meta">${emptySubtitleOf(key)}</div>
          </div>
        </div>
      `;
    }
    const iconHTML = cand.img
      ? `<div class="fud-bf-equip-icon" style="background-image:url('${escapeHtml(safeImgUrl(cand.img))}')"></div>`
      : `<div class="fud-bf-equip-icon">${cand.typeIcon}</div>`;
    // Description carried in a data attribute and revealed on a delayed
    // hover via a single shared tooltip element (see fud-bf-desc-tip CSS
    // + the mouseover/leave handler in postActionCard). HTML is allowed
    // since CSB descriptions ship with rich formatting; we trust the
    // local actor's item data. The tooltip ALSO surfaces the weapon's
    // stat line (Acc + Damage bonuses) above the description so the
    // player doesn't have to flip to the sheet to compare.
    const descAttr = cand.description
      ? ` data-fud-equip-desc="${escapeHtml(cand.description)}" data-fud-equip-desc-name="${escapeHtml(cand.name)}"`
      : "";
    const statBits = [];
    if (typeof cand.checkBonus === "number") {
      const sign = cand.checkBonus >= 0 ? "+" : "";
      statBits.push(`<span class="fud-bf-desc-tip-stat-acc">ACC ${sign}${cand.checkBonus}</span>`);
    }
    if (typeof cand.damageBonus === "number") {
      const sign = cand.damageBonus >= 0 ? "+" : "";
      statBits.push(`<span class="fud-bf-desc-tip-stat-dmg">DMG ${sign}${cand.damageBonus}</span>`);
    }
    if (cand.defenseLine) {
      statBits.push(`<span class="fud-bf-desc-tip-stat-def">${escapeHtml(cand.defenseLine)}</span>`);
    }
    // Trait chips — element, weapon type, range, hand slots, attack stat,
    // martial flag, rarity. These give the player the full weapon profile
    // in the hover without having to open the sheet.
    const trait = (text) => `<span class="fud-bf-desc-tip-stat-trait">${escapeHtml(text)}</span>`;
    const flag  = (text) => `<span class="fud-bf-desc-tip-stat-trait is-flag">${escapeHtml(text)}</span>`;
    if (cand.element && cand.element !== "-") statBits.push(trait(cand.element));
    if (cand.weaponType) statBits.push(trait(cap(cand.weaponType)));
    else if (cand.category === "shield") statBits.push(trait("Shield"));
    else if (cand.category === "accessory") statBits.push(trait("Accessory"));
    if (cand.weaponRange) statBits.push(trait(cand.weaponRange));
    if (cand.handSlots && cand.category !== "accessory") statBits.push(trait(cand.handSlots));
    if (cand.attackStat) statBits.push(trait(cand.attackStat));
    if (cand.isMartial) statBits.push(flag("Martial"));
    if (cand.rarity && cand.rarity !== "Common") statBits.push(flag(cand.rarity));
    const statsAttr = statBits.length
      ? ` data-fud-equip-stats="${escapeHtml(statBits.join(""))}"`
      : "";
    return `
      <div class="fud-bf-equip-option ${isSelected ? "is-selected" : ""}"
           data-fud-equip-value="${escapeHtml(cand.id)}"
           data-fud-equip-twohanded="${cand.isTwoHanded ? "1" : "0"}"${descAttr}${statsAttr}
           role="option">
        ${iconHTML}
        <div class="fud-bf-equip-text">
          <div class="fud-bf-equip-name">${escapeHtml(cand.name)}</div>
          <div class="fud-bf-equip-meta">${metaHTML(cand)}</div>
        </div>
      </div>
    `;
  };

  // Pre-resolve the initial 2H ghost pairing across hand slots. If the
  // actor already has a 2H weapon equipped in one hand (and the other
  // is empty per the Fabula data convention), render the empty side as
  // a ghost mirror of the 2H weapon so the player sees both slots in
  // use from the first render.
  const slots = slotInfo?.slots ?? [];
  const mainSlot = slots.find((s) => s.key === "main");
  const offSlot  = slots.find((s) => s.key === "off");
  const findCand = (slot, id) => (slot?.candidates ?? []).find((c) => c.id === id) ?? null;
  let initialGhost = { main: "", off: "" };
  if (mainSlot?.currentItemId && !offSlot?.currentItemId) {
    const mc = findCand(mainSlot, mainSlot.currentItemId);
    if (mc?.isTwoHanded) initialGhost.off = mainSlot.currentItemId;
  } else if (offSlot?.currentItemId && !mainSlot?.currentItemId) {
    const oc = findCand(offSlot, offSlot.currentItemId);
    if (oc?.isTwoHanded) initialGhost.main = offSlot.currentItemId;
  }

  const slotRows = slots.map((slot) => {
    const cands = slot.candidates ?? [];
    const current = slot.currentItemId
      ? cands.find((c) => c.id === slot.currentItemId) ?? null
      : null;
    const ghostId = (slot.key === "main" || slot.key === "off") ? initialGhost[slot.key] : "";
    const ghostCand = ghostId ? findCand(slot, ghostId) : null;
    // What the trigger displays: ghost weapon if ghosted, else current.
    const displayCand = ghostCand ?? current;
    const optionsHTML = [
      optionHTML(null, !slot.currentItemId && !ghostId, slot.key),
      ...cands.map((c) => optionHTML(c, c.id === slot.currentItemId, slot.key)),
    ].join("");
    const ghostAttrs = ghostId
      ? ` data-fud-equip-ghost-of="${escapeHtml(ghostId)}"`
      : "";
    const ghostClass = ghostId ? " is-ghost" : "";
    // data-fud-equip-twohanded reflects whether THIS row holds a real
    // 2H weapon (current=2H, not a ghost). For ghost rows it's "0".
    // NB: the attribute name MUST NOT contain "-<digit>" — DOMStringMap's
    // attribute-to-property conversion only uppercases a letter after a
    // dash, so `data-fud-equip-2h` would map to `dataset["fudEquip-2h"]`
    // (literal dash kept), making `dataset.fudEquip2h` undefined and any
    // `=== "1"` check silently false. See feedback memory.
    const realIsTwoHanded = !ghostId && current?.isTwoHanded ? "1" : "0";
    return `
      <div class="fud-bf-equip-row${ghostClass}"
           data-fud-equip-slot="${escapeHtml(slot.key)}"
           data-fud-equip-group="${escapeHtml(groupOf(slot.key))}"
           data-fud-equip-current="${escapeHtml(slot.currentItemId ?? "")}"
           data-fud-equip-initial="${escapeHtml(slot.currentItemId ?? "")}"
           data-fud-equip-twohanded="${realIsTwoHanded}"${ghostAttrs}>
        <div class="fud-bf-equip-label">${escapeHtml(slot.label)}</div>
        <div class="fud-bf-equip-trigger" role="combobox" aria-expanded="false" tabindex="0">
          ${triggerForCurrent(displayCand, slot.key)}
        </div>
        <div class="fud-bf-equip-popover" role="listbox">
          ${optionsHTML}
        </div>
      </div>
    `;
  }).join("");

  const slotsHTML = slotRows
    ? `<fieldset class="fud-bf-section">
        <legend>Slots</legend>
        ${slotRows}
      </fieldset>`
    : `<fieldset class="fud-bf-section">
        <legend>Slots</legend>
        <div style="font-size:12px; opacity:0.7;">Couldn't read the actor's inventory.</div>
      </fieldset>`;

  // Keep an "Open Sheet" fallback for armor / weight management / anything
  // the inline UI doesn't surface.
  const sheetUrl = attackerActor?.uuid ? String(attackerActor.uuid) : null;
  const openSheetHTML = sheetUrl ? `
    <div style="text-align:center; margin-top:6px;">
      <div class="fud-btn fud-btn-open-sheet" style="display:inline-flex; padding:6px 12px; font-size:10.5px;"
           data-fud-open-sheet="${escapeHtml(sheetUrl)}"
           role="button" tabindex="0">
        <i class="fa-solid fa-id-card" style="margin-right:6px;"></i>Full Sheet
      </div>
    </div>
  ` : "";

  return {
    titleIcon: `<i class="fa-solid fa-toolbox" style="font-size:20px; color:var(--fud-stroke,#5a6a85);"></i>`,
    titleText: "Equipment",
    subtitle: `<div class="fud-bf-subtitle">Swap any items<span class="dot">•</span>No armor mid-combat</div>`,
    portraits: tryBuild("portraits", () => buildPortraitsHTML({ attacker, perTargetResults: [] })),
    body: `
      <fieldset class="fud-bf-section">
        <legend>Action</legend>
        <div class="fud-bf-attacker-row">
          <div class="left">${escapeHtml(attacker.name)}</div>
          <div class="mid"><i class="fa-solid fa-toolbox"></i></div>
          <div class="right">Rearranges gear</div>
        </div>
      </fieldset>
      ${slotsHTML}
      ${openSheetHTML}
    `,
    buttons: `
      <div class="fud-bf-btn-row">
        <div class="fud-btn fud-btn-confirm" data-fud-action="confirm" role="button" tabindex="0">Done</div>
        <div class="fud-btn fud-btn-cancel" data-fud-action="cancel" role="button" tabindex="0">Cancel</div>
      </div>
    `,
  };
}

// Update an equipment-row's selection in place. Sources the new display
// (icon / name / meta) from the matching popover option so we don't have
// to re-render the row HTML or keep a JS-side candidate cache — the
// popover IS the source of truth for what each option looks like.
function setEquipRowSelection(row, newValue) {
  if (!row) return;
  row.dataset.fudEquipCurrent = newValue || "";
  // Any "real" selection clears the ghost state — the slot no longer
  // mirrors a 2H from the peer once the player commits an own value.
  row.classList.remove("is-ghost");
  delete row.dataset.fudEquipGhostOf;
  // is-modified tracks the diff between initial and current. Whenever
  // current changes we re-evaluate; ghosts never count as modified
  // because they have `current = ""` same as a freshly-empty slot.
  const initial = row.dataset.fudEquipInitial || "";
  row.classList.toggle("is-modified", (newValue || "") !== initial);
  const popover = row.querySelector(".fud-bf-equip-popover");
  if (!popover) return;
  // Selected highlight
  for (const opt of popover.querySelectorAll(".fud-bf-equip-option")) {
    const v = opt.dataset.fudEquipValue || "";
    opt.classList.toggle("is-selected", v === (newValue || ""));
  }
  const matchSel = newValue
    ? `.fud-bf-equip-option[data-fud-equip-value="${CSS.escape(newValue)}"]`
    : `.fud-bf-equip-option[data-fud-equip-value=""]`;
  const optEl = popover.querySelector(matchSel);
  if (!optEl) return;
  // Keep the row's 2H flag in sync — the click handler reads this when
  // deciding peer behaviour (clear vs. swap).
  row.dataset.fudEquipTwohanded = optEl.dataset.fudEquipTwohanded === "1" ? "1" : "0";
  applyTriggerVisualFromOption(row, optEl);
}

// Set a hand row into "ghost" state — visually mirrors `ghostItemId`
// (which is a 2H weapon currently equipped in the peer slot) so the
// player can see at a glance that the weapon occupies both slots.
// The row's `data-fud-equip-current` stays "" — the underlying data is
// still "this slot is empty" per the Fabula convention (main_hand
// carries the 2H name, off_hand is "").
function setEquipRowGhost(row, ghostItemId) {
  if (!row || !ghostItemId) return;
  row.dataset.fudEquipCurrent = "";
  row.dataset.fudEquipGhostOf = ghostItemId;
  row.dataset.fudEquipTwohanded = "0"; // not a real 2H — peer is
  row.classList.add("is-ghost");
  // A ghost never registers as "modified" — its data value (empty)
  // already matches whatever initial was empty.
  const initial = row.dataset.fudEquipInitial || "";
  row.classList.toggle("is-modified", initial !== "");
  const popover = row.querySelector(".fud-bf-equip-popover");
  if (!popover) return;
  // Pulse the popover selection to the empty option (since the actual
  // value is empty), but render the trigger from the 2H option.
  for (const opt of popover.querySelectorAll(".fud-bf-equip-option")) {
    opt.classList.toggle("is-selected", (opt.dataset.fudEquipValue || "") === "");
  }
  const optEl = popover.querySelector(
    `.fud-bf-equip-option[data-fud-equip-value="${CSS.escape(ghostItemId)}"]`
  );
  if (!optEl) return;
  applyTriggerVisualFromOption(row, optEl);
}

function clearEquipRowGhost(row) {
  if (!row) return;
  delete row.dataset.fudEquipGhostOf;
  row.classList.remove("is-ghost");
}

// Hand-group selection — single source of truth for 2H ghost behaviour.
//
// State per row:
//   • currentValue (data-fud-equip-current)  — the actual item id, "" if empty
//   • ghostOf      (data-fud-equip-ghost-of) — set on the peer row when a 2H
//                                              weapon is equipped on the other side
// Exactly one row in a pair can be the "real 2H" holder and the other can
// be the ghost; never both (and never two reals).
//
// "Real 2H weapon currently worn" is detected by walking both rows and
// looking for either:
//   • this row has current=X and that X is 2H, peer is ghost-of-X
//   • peer has current=X (X is 2H), this row is ghost-of-X
//
// User picking V in `row` (peer = `peer`):
//   • If V is the SAME 2H currently worn → no-op (or swap primary side).
//     We treat as "ensure 2H lives on this row" — `row` becomes the real,
//     peer becomes the ghost. Useful if the user clicked on the ghost slot
//     because they think of that hand as primary.
//   • If V is DIFFERENT and a 2H is currently worn → strip both slots
//     (removing a 2H from either side clears the other per user spec),
//     then proceed to apply V.
//   • If V is a 2H (no 2H currently worn, or just stripped) → row becomes
//     real, peer becomes ghost-of-V. Any 1H previously in peer is
//     unequipped.
//   • If V is 1H or empty (no 2H involved) → swap-aware dedupe.
function applyHandPick(row, peer, newValue, newIsTwoHanded) {
  const oldValue   = row.dataset.fudEquipCurrent  || "";
  const peerValue  = peer ? (peer.dataset.fudEquipCurrent || "") : "";
  const rowGhost   = row.dataset.fudEquipGhostOf  || "";
  const peerGhost  = peer ? (peer.dataset.fudEquipGhostOf || "") : "";
  const rowIs2h    = row.dataset.fudEquipTwohanded === "1";
  const peerIs2h   = peer?.dataset.fudEquipTwohanded === "1";

  // Currently-worn 2H weapon id (from either side). Empty if no 2H worn.
  let worn2hId = "";
  if (oldValue && rowIs2h && !rowGhost) worn2hId = oldValue;
  else if (peerValue && peerIs2h && !peerGhost) worn2hId = peerValue;
  else if (rowGhost) worn2hId = rowGhost;
  else if (peerGhost) worn2hId = peerGhost;

  // Case: user picks the SAME 2H that's already worn. Snap roles so
  // `row` is the real holder and `peer` becomes the ghost. (Useful when
  // the user clicked on the ghost side.)
  if (newValue && worn2hId && newValue === worn2hId) {
    if (peer) {
      setEquipRowSelection(peer, "");
      setEquipRowGhost(peer, newValue);
    }
    setEquipRowSelection(row, newValue);
    return;
  }

  // Case: any 2H is currently worn and the user is changing AWAY from
  // it (picking something different, or empty). Per spec the OTHER slot
  // becomes empty too. Strip both before applying the new value.
  if (worn2hId && newValue !== worn2hId) {
    if (peer) {
      clearEquipRowGhost(peer);
      setEquipRowSelection(peer, "");
    }
    clearEquipRowGhost(row);
    // setEquipRowSelection below will write the new value.
  }

  // Case: user picks a NEW 2H weapon. Row becomes real; peer ghosts it.
  // Any 1H item previously in the peer is just unequipped (returned to
  // inventory) — there's nowhere for it to go.
  if (newValue && newIsTwoHanded) {
    setEquipRowSelection(row, newValue);
    if (peer) {
      setEquipRowSelection(peer, "");
      setEquipRowGhost(peer, newValue);
    }
    return;
  }

  // Case: 1H pick or empty pick (no 2H involved at this point).
  // Swap-aware dedupe: if the peer already holds this exact item, move
  // its value to where the new item came from instead of clearing it.
  if (newValue && peer && peerValue === newValue && !peerGhost) {
    setEquipRowSelection(peer, oldValue);
  }
  setEquipRowSelection(row, newValue);
}

// Shared helper used by both setEquipRowSelection and setEquipRowGhost.
// Copies the icon background + name + meta from the source option into
// the row's trigger — keeping the trigger's larger sizing context (the
// CSS scopes icon size differently inside .trigger vs .option).
function applyTriggerVisualFromOption(row, optEl) {
  const trigger = row.querySelector(".fud-bf-equip-trigger");
  if (!trigger || !optEl) return;
  const srcIcon = optEl.querySelector(".fud-bf-equip-icon");
  const srcName = optEl.querySelector(".fud-bf-equip-name");
  const srcMeta = optEl.querySelector(".fud-bf-equip-meta");
  const dstIcon = trigger.querySelector(".fud-bf-equip-icon");
  const dstName = trigger.querySelector(".fud-bf-equip-name");
  const dstMeta = trigger.querySelector(".fud-bf-equip-meta");
  if (srcIcon && dstIcon) {
    dstIcon.className = srcIcon.className;
    dstIcon.style.cssText = srcIcon.style.cssText;
    dstIcon.textContent = srcIcon.textContent;
  }
  if (srcName && dstName) dstName.textContent = srcName.textContent;
  if (srcMeta && dstMeta) dstMeta.innerHTML = srcMeta.innerHTML;
}

function buildItemCard({ attacker, attackerActor, itemCandidates, ip }) {
  // Use/Create tabs on the card body — picker UX from legacy [Macro]
  // Item.js, rebuilt director-native. The card itself is the picker;
  // selection state lives on the card root as data-fud-item-mode +
  // data-fud-item-key, written by the click handler in postActionCard.
  //
  // v1 scope (Phase D.5): resource accounting only. We surface owned
  // consumables (with live quantities) and IP-affordable recipes, debit
  // the right resource on commit, and end the turn. Actually invoking
  // the item's active skill is deferred to Phase B (Skills) — the card
  // shows the linked skill names in each row's meta so the player knows
  // what *would* happen, and the toast on commit makes the deferred
  // status explicit ("(skill effect pending Phase B)").
  const useList    = itemCandidates?.use    ?? [];
  const createList = itemCandidates?.create ?? [];
  const curIp      = Number(ip?.current ?? 0) || 0;
  const maxIp      = Number(ip?.max ?? 0) || 0;

  const formatMeta = (c) => {
    const parts = [];
    if (c.skillNames?.length) {
      parts.push(c.skillNames.map(escapeHtml).join(", "));
    }
    if (c.mode === "create" && c.recipeName) {
      parts.push(`Recipe: ${escapeHtml(c.recipeName)}`);
    }
    return parts.join(`<span class="dot">•</span>`);
  };

  const rowHTML = (c) => {
    const isCreate = c.mode === "create";
    const cost = isCreate ? c.ipCost : null;
    const qty  = !isCreate ? (c.isUnique ? "∞" : (c.quantity ?? 0)) : null;
    const disabled = isCreate && cost > curIp;
    const key = isCreate ? c.key : c.id;
    const desc = describeCandidateForTooltip(c);
    const descAttr = desc
      ? ` data-fud-equip-desc="${escapeHtml(desc)}" data-fud-equip-desc-name="${escapeHtml(c.name)}"`
      : "";
    const iconHTML = c.img
      ? `<div class="fud-bf-item-icon" style="background-image:url('${escapeHtml(safeImgUrl(c.img))}')"></div>`
      : `<div class="fud-bf-item-icon"></div>`;
    return `
      <div class="fud-bf-item-row${disabled ? " is-disabled" : ""}"
           data-fud-item-mode="${escapeHtml(c.mode)}"
           data-fud-item-key="${escapeHtml(key)}"
           data-fud-item-cost="${isCreate ? Number(cost) : 0}"
           ${disabled ? `data-fud-item-disabled="1"` : ""}${descAttr}>
        ${iconHTML}
        <div class="fud-bf-item-text">
          <div class="fud-bf-item-name">${escapeHtml(c.name)}</div>
          <div class="fud-bf-item-meta">${formatMeta(c)}</div>
        </div>
        <div class="fud-bf-item-cost${isCreate ? " is-ip" : ""}">${
          isCreate ? `${cost} IP` : `x${qty}`
        }</div>
      </div>
    `;
  };

  const emptyUseHTML = useList.length
    ? useList.map(rowHTML).join("")
    : `<div class="fud-bf-item-empty">No owned consumables.</div>`;
  const emptyCreateHTML = createList.length
    ? createList.map(rowHTML).join("")
    : `<div class="fud-bf-item-empty">No creatable recipes unlocked.</div>`;

  const initialTab = useList.length ? "use" : (createList.length ? "create" : "use");

  return {
    titleIcon: `<i class="fa-solid fa-flask" style="font-size:20px; color:var(--fud-stroke,#5a6a85);"></i>`,
    titleText: "Item",
    subtitle: `<div class="fud-bf-subtitle">Use a consumable<span class="dot">•</span>Spend IP to craft</div>`,
    portraits: tryBuild("portraits", () => buildPortraitsHTML({ attacker, perTargetResults: [] })),
    body: `
      <fieldset class="fud-bf-section">
        <legend>Action</legend>
        <div class="fud-bf-attacker-row">
          <div class="left">${escapeHtml(attacker.name)}</div>
          <div class="mid"><i class="fa-solid fa-flask"></i></div>
          <div class="right">Rummages inventory</div>
        </div>
      </fieldset>
      <fieldset class="fud-bf-section">
        <legend>Items</legend>
        <div class="fud-bf-item-tabs">
          <div class="fud-bf-item-tab ${initialTab === "use" ? "is-active" : ""}"
               data-fud-item-tab="use" role="tab">
            Use<span class="fud-bf-item-tab-count">(${useList.length})</span>
          </div>
          <div class="fud-bf-item-tab ${initialTab === "create" ? "is-active" : ""}"
               data-fud-item-tab="create" role="tab">
            Create<span class="fud-bf-item-tab-count">(${createList.length})</span>
          </div>
        </div>
        <div class="fud-bf-item-panel ${initialTab === "use" ? "is-active" : ""}" data-fud-item-panel="use">
          <div class="fud-bf-item-list">${emptyUseHTML}</div>
        </div>
        <div class="fud-bf-item-panel ${initialTab === "create" ? "is-active" : ""}" data-fud-item-panel="create">
          <div class="fud-bf-item-list">${emptyCreateHTML}</div>
          ${maxIp > 0 ? `
            <div class="fud-bf-ip-bar">
              <span>Inventory Points</span>
              <span class="fud-bf-ip-val">${curIp} / ${maxIp}</span>
            </div>
          ` : ""}
        </div>
      </fieldset>
    `,
    buttons: `
      <div class="fud-bf-btn-row">
        <div class="fud-btn fud-btn-confirm is-disabled" data-fud-action="confirm" role="button" tabindex="0">Done</div>
        <div class="fud-btn fud-btn-cancel" data-fud-action="cancel" role="button" tabindex="0">Cancel</div>
      </div>
    `,
  };
}

function buildHinderCard({ attacker, target, roll, dl, success }) {
  const targetForPortraits = target
    ? [{ tokenImg: target.tokenImg, name: target.name, disposition: target.disposition }]
    : [];

  // Status picker (4 buttons in a 2×2 grid) — clicking ANY button is the
  // commit on success. Buttons forward `statusValue` to Confirm via the
  // card's finish() extras → Confirm merges it into actionResult before
  // dispatching CONFIRM_ACTION so RESOLVE knows which AE to apply.
  const successButtonsHTML = HINDER_STATUSES.map((s) => `
    <div class="fud-btn fud-btn-hinder-status"
         data-fud-action="confirm"
         data-fud-status-value="${escapeHtml(s.key)}"
         style="border-color:${s.color}; color:${s.color};"
         role="button" tabindex="0"
         title="${escapeHtml(s.label)} (penalises ${s.attrShort} Opposed Checks)">
      <span style="margin-right:4px;">${s.icon}</span>${escapeHtml(s.label)}
    </div>
  `).join("");

  // RAW: the GM tells the player whether they succeeded — they DO NOT
  // reveal the Difficulty Level. Hide `dl` from the result text so the
  // player can't trivially deduce the DL by comparing their roll total to
  // the threshold (the roll total is still visible in the accuracy
  // widget, which is intentional — they know what they rolled, just not
  // what they needed to beat).
  const resultBox = success
    ? `<fieldset class="fud-bf-section">
        <legend>Result</legend>
        <div style="font-size:16px; font-weight:900; color:#2a6e3d; text-align:center; letter-spacing:0.5px;">
          Success!
        </div>
        <div style="font-size:12px; text-align:center; opacity:0.85; margin-top:4px;">
          Pick a status to inflict on <strong>${escapeHtml(target?.name ?? "target")}</strong>:
        </div>
      </fieldset>`
    : `<fieldset class="fud-bf-section">
        <legend>Result</legend>
        <div style="font-size:16px; font-weight:900; color:#9a4a4a; text-align:center; letter-spacing:0.5px;">
          ${roll?.isFumble ? "Fumble!" : "Failed"}
        </div>
        <div style="font-size:12px; text-align:center; opacity:0.85; margin-top:4px;">
          No status inflicted.
        </div>
      </fieldset>`;

  const buttonsHTML = success
    ? `<div class="fud-bf-btn-row fud-bf-status-grid">
         ${successButtonsHTML}
       </div>`
    : `<div class="fud-bf-btn-row">
         <div class="fud-btn fud-btn-confirm" data-fud-action="confirm" role="button" tabindex="0">Confirm</div>
       </div>`;

  return {
    titleIcon: `<i class="fa-solid fa-hand" style="font-size:18px; color:#c44a2a;"></i>`,
    titleText: "Hinder",
    // No DL in the subtitle — see resultBox comment. Player gets the
    // attribute pair (which is public — they described the approach) and
    // that's it.
    subtitle: `<div class="fud-bf-subtitle">Hinder<span class="dot">•</span>${escapeHtml(roll?.A1 ?? "DEX")} + ${escapeHtml(roll?.A2 ?? "INS")}</div>`,
    portraits: tryBuild("portraits", () => buildPortraitsHTML({ attacker, perTargetResults: targetForPortraits })),
    body: `
      <fieldset class="fud-bf-section">
        <legend>Attacker</legend>
        <div class="fud-bf-attacker-row">
          <div class="left">${escapeHtml(attacker.name)}</div>
          <div class="mid"><i class="fa-solid fa-hand"></i></div>
          <div class="right">${escapeHtml(target?.name ?? "—")}</div>
        </div>
      </fieldset>
      ${tryBuild("hinderAccuracy", () => buildAccuracyHTML({ roll, hideDefenseIcon: true, legendOverride: "Check" }))}
      ${resultBox}
    `,
    buttons: buttonsHTML,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Skill card (Phase B.1) — same setup as the Attack card.
// ─────────────────────────────────────────────────────────────────────
//
// Mirrors buildAttackCard's section layout (Attacker → Accuracy →
// Damage → Per-target → Effect) and uses the same buildButtonsHTML
// (Invoke Trait / Invoke Bond + Confirm). Subtitle layout follows the
// legacy CreateActionCard pattern for skills/spells: range • (weapon
// type | "Arcane" for spells) • "Skill"/"Spell" • sub-type • cost.

function buildSkillSubtitleHTML({ skillType, skillRange, rawCost, isSpellish }) {
  const bullets = [];
  if (skillRange) bullets.push(escapeHtml(skillRange));
  // Spells get an "Arcane" weapon-type bullet (per legacy). Skills don't
  // currently surface a weapon-type field in actionResult, so we skip
  // that bullet for non-spell skills.
  if (isSpellish) {
    bullets.push(`${weaponIconHTML("arcane")}Arcane`);
  }
  bullets.push(isSpellish ? "Spell" : "Skill");
  // Sub-type for Skills only (Active / Passive / Other). For Spells the
  // primary bullet already says "Spell".
  const stRaw = String(skillType ?? "").toLowerCase();
  if (!isSpellish && stRaw && stRaw !== "active") {
    // Treat "Active" as the default and avoid the redundant bullet.
    bullets.push(escapeHtml(cap(stRaw)));
  }
  if (rawCost) bullets.push(escapeHtml(rawCost));
  if (!bullets.length) return "";
  // Wrap each bullet so the cost line ("5 x T MP") + element pills don't
  // line-break mid-token when the card is narrower than the joined text.
  const wrapped = bullets.map((b) => `<span class="bullet">${b}</span>`);
  return `<div class="fud-bf-subtitle">${wrapped.join(`<span class="dot">•</span>`)}</div>`;
}

// Pre-resolve reaction pill row. Each entry shape:
//   { carrierKind, carrierUuid, carrierName, carrierImg, carrierDescription,
//     mode: "on"|"ask"|"off", rowKey, ref }
// "off" entries are not rendered (auto-rejected upstream); "on" entries
// render as an auto-applied chip (no buttons); "ask" entries render with
// Apply/Skip buttons. The row carries data-fud-reactions-pending=<count>
// on the card root so CSS can disable Confirm while any ask remains.
//
// Each pill carries data-fud-equip-desc + data-fud-equip-desc-name so
// the existing dwell-tooltip (used by equipment options and target
// rows) surfaces the skill's description on hover. The body bundles a
// "Mode" footer chip so the player can see whether the pill is acting
// automatically vs. waiting on their click vs. disabled.
function buildReactionPillRow(prePassives) {
  // Hide "off" (auto-rejected) and "force" (engine-mandatory, no
  // player choice) rows from the visible list. "force" is recorded as
  // auto-applied in the decision map below so RESOLVE still fires it.
  const visible = prePassives.filter((p) => p?.mode !== "off" && p?.mode !== "force");
  if (!visible.length) return "";
  const pillsHtml = visible.map((p) => {
    const safeName = escapeHtml(p.carrierName ?? "Reaction");
    const safeKey  = escapeHtml(String(p.rowKey ?? ""));
    const safeCarrier = escapeHtml(String(p.carrierUuid ?? ""));
    const iconHtml = p.carrierImg
      ? `<img class="fud-bf-reaction-icon" src="${escapeHtml(p.carrierImg)}" alt="" />`
      : `<span class="fud-bf-reaction-icon" aria-hidden="true">⚡</span>`;
    const modeLabel =
      p.mode === "on"  ? "Auto-apply (On)"  :
      p.mode === "off" ? "Disabled (Off)"   :
                         "Asks (You choose)";
    // Skill descriptions in CSB are rich HTML; trusted (local actor
    // data, not user input). Bundle a mode footer chip so the player
    // sees the dispatch behavior without leaving the card.
    const descBody =
      (p.carrierDescription ?? "") +
      `<div class="fud-bf-reaction-tip-foot">Mode: ${escapeHtml(modeLabel)}</div>`;
    const tipAttrs =
      ` data-fud-equip-desc="${escapeHtml(descBody)}" data-fud-equip-desc-name="${safeName}"`;
    if (p.mode === "on") {
      return `
        <div class="fud-bf-reaction-pill is-auto" data-fud-reaction-key="${safeKey}" data-fud-reaction-carrier="${safeCarrier}"${tipAttrs}>
          ${iconHtml}
          <span class="fud-bf-reaction-name">${safeName}</span>
          <span class="fud-bf-reaction-status">Auto-applied</span>
        </div>`;
    }
    return `
      <div class="fud-bf-reaction-pill is-ask" data-fud-reaction-key="${safeKey}" data-fud-reaction-carrier="${safeCarrier}" data-fud-reaction-pending="1"${tipAttrs}>
        ${iconHtml}
        <span class="fud-bf-reaction-name">${safeName}</span>
        <div class="fud-bf-reaction-actions">
          <div class="fud-btn fud-btn-reaction fud-btn-reaction-apply" data-fud-reaction-action="apply" role="button" tabindex="0">Apply</div>
          <div class="fud-btn fud-btn-reaction fud-btn-reaction-skip" data-fud-reaction-action="skip" role="button" tabindex="0">Skip</div>
        </div>
      </div>`;
  }).join("");
  return `
    <div class="fud-bf-reactions-row">
      <div class="fud-bf-reactions-label">Reactions</div>
      <div class="fud-bf-reactions-list">${pillsHtml}</div>
    </div>
  `;
}

function buildSkillCard(payload) {
  const {
    attacker, skillName, skillImg, skillType, skillRange,
    damageType, hasDamage, hasHealing, rawCost, targets, roll, damage,
    perTargetResults, descriptionHtml, defenseTargetType,
  } = payload ?? {};

  // Visual identity (title icon, subtitle, "Spell" label) — driven by
  // skill_type. Defense resolution (DEF vs MDEF labels + Strike/Magic
  // accuracy icon) is independent: Spells always vs MDEF (RAW); non-Spell
  // skills opt in via `defense_target_type: "mdef"` (Soul Steal / Pillage
  // route vs MDEF without pretending to be a Spell for naming purposes).
  // Mirror of the COMPUTE-side derivation in state-handlers.js.
  const isSpellish = String(skillType ?? "").toLowerCase() === "spell";
  const dtt = String(defenseTargetType ?? "").toLowerCase();
  const vsMDef = isSpellish || dtt === "mdef";

  // Title icon — skill image if provided, else a themed fallback icon.
  // Uses the same `fud-bf-title-icon` class as buildAttackCard so the
  // header visual is identical.
  const safeImg = safeImgUrl(skillImg);
  const fallbackIcon = isSpellish
    ? `<i class="fa-solid fa-wand-sparkles" style="font-size:20px; color:#a04acb;"></i>`
    : `<i class="fa-solid fa-sparkles" style="font-size:20px; color:#5ab3d4;"></i>`;
  const titleIcon = safeImg
    ? `<img class="fud-bf-title-icon" src="${escapeHtml(safeImg)}" alt="">`
    : fallbackIcon;

  const titleText = skillName ?? (isSpellish ? "Spell" : "Skill");
  const subtitle = buildSkillSubtitleHTML({ skillType, skillRange, rawCost, isSpellish });

  // Damage / Heal preview — fires for both elemental damage AND
  // recipe-grant skills (Heal, MP-restore). `damage` carries the
  // shape, `damage.declaresHealing` flips wording + colors via
  // buildDamagePreviewHTML. Status-only buff/debuff spells skip the
  // panel — the Effect section narrates them.
  const damageHTML = (hasDamage || hasHealing) && damage
    ? tryBuild("skillDamage", () => buildDamagePreviewHTML({ damage, roll }))
    : "";

  // Per-target rows reuse Attack's helper so the layout is identical
  // (name + DEF/MDEF + hit/crit/miss + affinity tag). Pass element so the
  // per-row hover tooltip can name "Vulnerable to Fire ×2" etc. No
  // weapon for skills — the tooltip just skips that bullet.
  // `isSpellish: true` for skill_type='Spell' so the row + tooltip say
  // MDEF (which COMPUTE actually compared against) instead of DEF.
  //
  // Show whenever we have rows — that includes status-only offensive
  // Checks (Torpor / Hallucination / Enrage) where the per-target rows
  // exist for hit/miss visibility but carry zero damage.
  const hasPerTargetRows = Array.isArray(perTargetResults) && perTargetResults.length > 0;
  const perTargetHTML = hasPerTargetRows
    ? tryBuild("skillPerTarget", () => buildPerTargetHTML({
        perTargetResults,
        weapon: null,
        element: damage?.element ?? damageType,
        roll,
        isSpellish: vsMDef,
        hasDamage,
      }))
    : "";

  // The accuracy panel's vs-DEF/vs-MDEF icon is meaningful for any Check
  // (offensive status spells route vs MDEF too). Hide it only when there's
  // no Check at all — no-Check skills like Heal show the dice for SL but
  // don't compare vs anything.
  const accuracyHTML = roll
    ? tryBuild("skillAccuracy", () => buildAccuracyHTML({
        roll,
        isSpellish: vsMDef,
        hideDefenseIcon: false,
      }))
    : "";

  // Effect text — surfaced as a fieldset like legacy's collapsible
  // Effect section, but flat (no collapse) and length-clamped for the
  // overlay's compact width. Keeps the GM / players reminded of the
  // skill's prose without flipping back to the sheet.
  const descText = stripHtmlForDesc(descriptionHtml);
  const descHTML = descText
    ? `<fieldset class="fud-bf-section">
        <legend>Effect</legend>
        <div style="font-size:11.5px; line-height:1.4; opacity:0.9;">${escapeHtml(descText)}</div>
      </fieldset>`
    : "";

  // Portrait slots: use perTargetResults if we have damage rows,
  // otherwise synthesise from targets so a no-damage skill still gets
  // a representative target portrait.
  const portraitInput = (Array.isArray(perTargetResults) && perTargetResults.length)
    ? perTargetResults
    : (Array.isArray(targets) ? targets.map((t) => ({
        tokenImg: t.tokenImg, name: t.name, disposition: t.disposition,
      })) : []);

  return {
    titleIcon,
    titleText,
    subtitle,
    portraits: tryBuild("skillPortraits", () => buildPortraitsHTML({
      attacker, perTargetResults: portraitInput,
    })),
    body: `
      ${tryBuild("skillAttacker", () => buildAttackerHTML({ attacker, targets }))}
      ${accuracyHTML}
      ${damageHTML}
      ${perTargetHTML}
      ${descHTML}
    `,
    // Same Confirm + Invoke Trait + Invoke Bond row as Attack. Invokes
    // stay locked (Phase E). For no-Check skills (Heal / Reinforce /
    // most buff-spells) the Invoke row vanishes entirely — there's no
    // roll to reroll, the buttons are noise. No Cancel — the Skill /
    // Spell card is a reactable trigger; allowing cancel would silently
    // undo passive reactions that have already fired. GM uses the
    // rewind tool to back out the whole turn.
    buttons: buildButtonsHTML({ isFumble: !!roll?.isFumble, hasRoll: !!roll }),
  };
}

function stripHtmlForDesc(html) {
  if (!html) return "";
  try {
    const tmp = document.createElement("div");
    tmp.innerHTML = String(html);
    return (tmp.textContent ?? tmp.innerText ?? "").trim().slice(0, 320);
  } catch {
    return String(html).replace(/<[^>]*>/g, "").trim().slice(0, 320);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────
export async function postActionCard({ director, kind, payload }) {
  // GM-only entry — this builds the authoritative card + manages the
  // resolve Promise that the state-handler awaits. Player clients see
  // the card via the broadcast mirror (spawnActionCardMirror below),
  // not via this function.
  if (!game.user?.isGM) {
    log("Action card spawn skipped — non-GM client (state-handlers run GM-side)");
    return { confirmed: false };
  }

  // ensureStyles only injects on first call; a throw inside it would
  // bubble out and abort the FSM. Wrap it so a CSS-template typo never
  // takes down the action.
  try { ensureStyles(); }
  catch (e) { warn("ensureStyles threw — card will render unstyled", e); }

  // Despawn any prior overlay for this director.
  const prior = _overlays.get(director.combatId);
  if (prior) { try { prior.cleanup(); } catch {} _overlays.delete(director.combatId); }

  // Pre-compute bonus from auto-accepted ("on"-mode) pre-passives so the
  // damage header reflects passive bonuses before the player confirms.
  // "ask"-mode passives are uncertain — we don't pre-apply them to the header.
  // Fire-and-forget: any throw leaves effectivePayload = payload (no bonus shown).
  let effectivePayload = payload;
  {
    const autoPassives = (Array.isArray(payload?.prePassives) ? payload.prePassives : [])
      .filter((p) => p?.mode === "on");
    if (autoPassives.length && payload?.attackerActor && Array.isArray(payload?.perTargetResults)) {
      try {
        const { computeSenderDamageBonuses } = await import("./skill-effects.js");
        const bonusMap = await computeSenderDamageBonuses({
          casterActor: payload.attackerActor,
          acceptedPrePassives: autoPassives,
          dCombat: director.dCombat,
        });
        if (bonusMap.size > 0) {
          const maxBonus = Math.max(...bonusMap.values());
          if (maxBonus > 0 && payload.damage) {
            effectivePayload = {
              ...payload,
              damage: {
                ...payload.damage,
                finalIfHit: (payload.damage.finalIfHit ?? 0) + maxBonus,
                prePassiveBonus: maxBonus,
              },
            };
          }
        }
      } catch (e) { warn("postActionCard: pre-passive bonus preview threw", e); }
    }
  }

  // Build the card defensively. If the whole composition throws, we
  // still produce a minimal "something went wrong but proceed" card so
  // the FSM doesn't abort — the player can confirm and the dice that
  // were already rolled get applied. Sub-section failures are absorbed
  // by tryBuild() inside the builders.
  let card = null;
  try {
    if (kind === "Attack") {
      card = buildAttackCard(effectivePayload);
    } else if (kind === "Guard") {
      card = buildGuardCard(effectivePayload);
    } else if (kind === "Study") {
      card = buildStudyCard(effectivePayload);
    } else if (kind === "Hinder") {
      card = buildHinderCard(effectivePayload);
    } else if (kind === "Equipment") {
      card = buildEquipmentCard(effectivePayload);
    } else if (kind === "Item") {
      card = buildItemCard(effectivePayload);
    } else if (kind === "Skill") {
      card = buildSkillCard(effectivePayload);
    } else {
      card = {
        titleIcon: "",
        titleText: kind,
        subtitle: "",
        portraits: tryBuild("portraits-fallback", () => buildPortraitsHTML({ attacker: payload?.attacker, perTargetResults: [] })),
        body: `<fieldset class="fud-bf-section"><legend>${escapeHtml(kind)}</legend>
          <div style="font-size:12px; opacity:0.7;">Body for "${escapeHtml(kind)}" not implemented in this slice.</div>
        </fieldset>`,
        buttons: `
          <div class="fud-bf-btn-row">
            <div class="fud-btn fud-btn-confirm" data-fud-action="confirm" role="button" tabindex="0">Confirm</div>
          </div>
        `,
      };
    }
  } catch (e) {
    warn("postActionCard: card composition threw — falling back to minimal card", e);
    card = {
      titleIcon: "",
      titleText: kind ?? "Action",
      subtitle: "",
      portraits: "",
      body: `<fieldset class="fud-bf-section">
        <legend>Notice</legend>
        <div style="font-size:12px; line-height:1.5;">
          Card render hit a snag (see console for details), but the action's already been rolled.
          Click <strong>Confirm</strong> to apply the result.
        </div>
      </fieldset>`,
      buttons: `
        <div class="fud-bf-btn-row">
          <div class="fud-btn fud-btn-confirm" data-fud-action="confirm" role="button" tabindex="0">Confirm</div>
        </div>
      `,
    };
  }

  // Pre-resolve reaction pills (Healing Power / Support Magic /
  // future "during action card" passives). Each ask-mode candidate gets
  // a pill row with Apply/Skip buttons; on-mode is auto-accepted and
  // shown as a chip without buttons; off-mode is skipped (no pill).
  // Confirm is locked while any ask pill is undecided.
  const prePassives = Array.isArray(payload?.prePassives) ? payload.prePassives : [];
  const askPassives = prePassives.filter((p) => p?.mode === "ask");
  const reactionRowHtml = prePassives.length ? buildReactionPillRow(prePassives) : "";
  const initialPending = askPassives.length;

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="fud-bf-card" role="dialog" aria-label="${escapeHtml(card.titleText)}"${initialPending > 0 ? ` data-fud-reactions-pending="${initialPending}"` : ""}>
      <div class="fud-bf-header">
        <div class="fud-bf-portrait-slot left">${card.portraits?.left ?? ""}</div>
        <div class="fud-bf-title-row">
          ${card.titleIcon ?? ""}
          <span class="fud-bf-title">${escapeHtml(card.titleText)}</span>
        </div>
        <div class="fud-bf-portrait-slot right">${card.portraits?.right ?? ""}</div>
      </div>
      ${card.subtitle ?? ""}
      ${card.body}
      ${reactionRowHtml}
      ${card.buttons}
    </div>
  `;
  document.body.appendChild(root);

  requestAnimationFrame(() => root.classList.add("is-visible"));

  log("Battlefield action card spawned", card.titleText);

  // Broadcast the rendered card to all active non-GM clients so they
  // see the same card as the GM. Owner gets interactive buttons; other
  // observers get a read-only mirror. See [[director-player-driven-input]].
  //
  // We send the rendered outerHTML (simplest portable representation —
  // re-deriving the card on each client requires importing the whole
  // builder graph). Owner detection uses the attacker actor UUID
  // embedded in the payload.
  try {
    const attackerActorUuid = payload?.attacker?.actorUuid
      ?? payload?.attackerActorRef
      ?? null;
    const ownerUserId = attackerActorUuid
      ? (await resolveCardOwnerUserId(attackerActorUuid))
      : null;
    const cardHTML = root.outerHTML;
    const onlinePlayers = (game.users?.contents ?? []).filter((u) => u.active && !u.isGM);
    for (const u of onlinePlayers) {
      try {
        director.intentChannel?.broadcastMenuOpen({
          targetUserId: u.id,
          menuSpec: {
            kind: "action-card",
            combatId: director.combatId,
            cardKind: kind,
            ownerUserId,
            attackerActorUuid,
            html: cardHTML,
          },
        });
      } catch (e) { warn(`postActionCard: broadcast to ${u.name} threw`, e); }
    }
  } catch (e) { warn("postActionCard: broadcast setup threw", e); }

  return new Promise((resolve) => {
    let resolved = false;
    let despawnTid = null;
    let keyListener = null;

    const finish = (outcome, extras = {}) => {
      if (resolved) return;
      resolved = true;
      // Abort the unused remote awaits so they don't linger and steal
      // the next turn's matching intent. Defined below in this Promise
      // constructor; safe to reference via closure hoisting.
      try { abortPendingAwaits?.(); } catch {}
      // Tell all player clients to close their mirror cards. The GM-side
      // DOM is despawned by the timeout below; this just keeps the
      // player's view in sync.
      try {
        const onlinePlayers = (game.users?.contents ?? []).filter((u) => u.active && !u.isGM);
        for (const u of onlinePlayers) {
          try {
            director.intentChannel?.broadcastMenuClose({
              targetUserId: u.id,
              kind: "action-card",
              reason: `card-${outcome}`,
            });
          } catch {}
        }
      } catch {}

      for (const b of root.querySelectorAll(".fud-btn")) b.classList.add("is-resolved");

      root.classList.remove("is-visible");
      root.classList.add("is-resolving");
      const fadeMs = outcome === "confirm" ? 480 : 240;
      despawnTid = setTimeout(() => {
        try { root.remove(); } catch {}
        try { descTip?.remove(); } catch {}
        descTip = null;
        _overlays.delete(director.combatId);
      }, fadeMs);

      if (keyListener) {
        try { window.removeEventListener("keydown", keyListener, true); } catch {}
        keyListener = null;
      }

      // Defensive: kill any pending tooltip work so a dwell timer or rAF
      // that hasn't fired yet doesn't surface a ghost tooltip on top of
      // the (already dismissed) card.
      try { hideDescTip(); } catch {}

      // Pass any caller-supplied button data (e.g. status pick on Hinder)
      // back to Confirm. Currently used for `statusValue`. Also tack on
      // reaction-pill decisions so resolve can apply pre-accepted passives.
      resolve({
        confirmed: outcome === "confirm",
        reactionDecisions: snapshotReactionDecisions(),
        ...extras,
      });
    };

    // Reaction-pill decision tracking. Each ask-mode pill starts
    // undecided. Click "Apply" / "Skip" → record + visually mark the
    // pill resolved + decrement the pending counter on .fud-bf-card.
    // When counter hits 0, the data attribute is removed and Confirm
    // unlocks (CSS handles the visual).
    //
    // `on`-mode pills are auto-accepted at start; `off`-mode pills are
    // auto-rejected and not rendered. Both decisions are recorded
    // immediately so the resolve path sees the full picture.
    const reactionDecisionMap = new Map(); // rowKey:carrierUuid → "apply"|"skip"
    for (const p of prePassives) {
      const key = `${p.rowKey}:${p.carrierUuid}`;
      // "on" + "force" both auto-apply (force is engine-mandatory, on
      // is player-set auto-apply; same effect on the decision map).
      if (p.mode === "on" || p.mode === "force") reactionDecisionMap.set(key, "apply");
      if (p.mode === "off") reactionDecisionMap.set(key, "skip");
    }

    function snapshotReactionDecisions() {
      const out = [];
      for (const p of prePassives) {
        const key = `${p.rowKey}:${p.carrierUuid}`;
        const decision = reactionDecisionMap.get(key) ?? "skip";
        out.push({
          // carrierKind must round-trip: RESOLVE uses it to route between
          // the item-runtime-view branch (item-bound passives like
          // Healing Power) and the AE-flag branch (AE-bound reactions
          // like Support Magic's check-bonus AE). Without it the
          // dispatch silently no-ops because the wrong effect_table is
          // looked up.
          carrierKind: p.carrierKind,
          carrierUuid: p.carrierUuid,
          carrierName: p.carrierName,
          rowKey: p.rowKey,
          mode: p.mode,
          ref: p.ref,
          decision,
          // Per-action dispatch tags (added by state-handlers' CONFIRM
          // creature_will_deal_damage aggregation). The sender-side
          // accumulator — computeSenderDamageBonuses — reads these to
          // distribute base-damage bonuses across every qualifying
          // target. Modern aggregated shape uses `appliesToTargetUuids`;
          // older per-target dispatches set `subjectActorUuid` as a
          // single value. Pass both through so the accumulator can
          // accept either; pass-through is harmless for non-add_damage
          // decisions (the accumulator filters by effect_kind anyway).
          appliesToTargetUuids: Array.isArray(p.appliesToTargetUuids) ? p.appliesToTargetUuids : null,
          appliesToTokenUuids:  Array.isArray(p.appliesToTokenUuids)  ? p.appliesToTokenUuids  : null,
          subjectActorUuid: p.subjectActorUuid ?? null,
          subjectTokenUuid: p.subjectTokenUuid ?? null,
          payloadAtFire: p.payloadAtFire ?? null,
        });
      }
      return out;
    }
    function recordPillDecision(rowKey, carrierUuid, decision) {
      const cardEl = root.querySelector(".fud-bf-card");
      const pillEl = root.querySelector(
        `.fud-bf-reaction-pill[data-fud-reaction-key="${CSS.escape(rowKey)}"][data-fud-reaction-carrier="${CSS.escape(carrierUuid)}"]`
      );
      if (!pillEl) return;
      if (pillEl.dataset.fudReactionPending !== "1") return;
      reactionDecisionMap.set(`${rowKey}:${carrierUuid}`, decision);
      pillEl.dataset.fudReactionPending = "0";
      pillEl.classList.add("is-resolved", decision === "apply" ? "is-applied" : "is-skipped");
      // Replace the Apply/Skip buttons with a status chip showing the
      // player's choice. Keeps the visual record on the card.
      const actions = pillEl.querySelector(".fud-bf-reaction-actions");
      if (actions) {
        actions.outerHTML = `<span class="fud-bf-reaction-status">${decision === "apply" ? "Applied" : "Skipped"}</span>`;
      }
      // Decrement the card-level pending count; remove attribute at 0.
      const current = Number(cardEl?.dataset?.fudReactionsPending ?? 0);
      const next = Math.max(0, current - 1);
      if (cardEl) {
        if (next > 0) cardEl.dataset.fudReactionsPending = String(next);
        else delete cardEl.dataset.fudReactionsPending;
      }
      // Broadcast pill state change to every mirror so observers see the
      // decision flip from "Waiting…" to "Applied"/"Skipped" in real time.
      // Without this, non-owners stay frozen on the initial card render
      // until MENU_CLOSE wipes everything.
      try {
        const onlinePlayers = (game.users?.contents ?? []).filter((u) => u.active && !u.isGM);
        for (const u of onlinePlayers) {
          director?.intentChannel?.broadcastMenuOpen({
            targetUserId: u.id,
            menuSpec: {
              kind: "action-card-pill-update",
              combatId: director.combatId,
              rowKey,
              carrierUuid,
              decision,
              pendingCount: next,
            },
          });
        }
      } catch (e) { warn("recordPillDecision: pill-update broadcast threw", e); }
      // Phase 3: live preview update — recompute per-target damage and
      // patch the result spans whenever an add_damage decision toggles.
      // Fire-and-forget — serialization inside the helper prevents races.
      try { recomputeTargetPreviews().catch(() => {}); } catch {}
    }

    // Phase 3 of the Cheap Shot integration: live damage preview update.
    // Re-runs the sender-side accumulator over currently-accepted
    // add_damage candidates and patches each per-target row's result
    // span to reflect the new damage value. Pill mode "on" / "force"
    // pre-records as "apply" at card spawn, so this helper also runs
    // once after the initial render to surface those bonuses.
    //
    // Serialised via a single in-flight Promise — fast clicks queue
    // behind the previous recompute instead of racing the DOM.
    let _previewInFlight = null;
    async function recomputeTargetPreviews() {
      // Non-damage skills (Soul Steal, Torpor, Hallucination, …) have no
      // base damage for add_damage to recompute against. Skipping here
      // also preserves the initial-render SUCCESS/FAILED labels, which
      // the damage-row re-derive below would otherwise overwrite with
      // "NO EFFECT" (entry.damage <= 0 branch).
      if (!payload?.hasDamage) return;
      if (_previewInFlight) { try { await _previewInFlight; } catch {} }
      _previewInFlight = (async () => {
        try {
          const accepted = [];
          for (const p of prePassives) {
            const k = `${p.rowKey}:${p.carrierUuid}`;
            if (reactionDecisionMap.get(k) === "apply") accepted.push(p);
          }
          // Lazy-import — cross-module cache-bust pattern.
          const sk = await import("./skill-effects.js?cb=" + Date.now());
          const sn = await import("./snapshot.js?cb=" + Date.now());
          const bonusMap = await sk.computeSenderDamageBonuses({
            casterActor: payload.attackerActor,
            acceptedPrePassives: accepted,
            dCombat: director?.dCombat,
          });
          const original = Array.isArray(payload.perTargetResults) ? payload.perTargetResults : [];
          const recomputed = sk.recomputePerTargetDamages(original, bonusMap, sn.applyAffinityToDamage);
          // Patch each row's t-result label + class.
          for (const entry of recomputed) {
            if (!entry?.actorUuid) continue;
            const rowEl = root.querySelector(
              `.fud-bf-target-row[data-fud-target-actor-uuid="${CSS.escape(String(entry.actorUuid))}"]`
            );
            if (!rowEl) continue;
            const resultSpan = rowEl.querySelector(".t-result");
            if (!resultSpan) continue;
            // Re-derive class + label, mirroring resultLabelFor /
            // resultClsFor for the damage-row case (the only case
            // add_damage can apply to — grant rows have no rawDamage).
            const unit = entry.resource === "mp" ? "MP" : "dmg";
            let label = "MISS";
            let cls   = "miss";
            if (entry.hit) {
              if (typeof entry.grantAmount === "number") {
                // Recipe-grant rows aren't damage rows — leave as-is.
                continue;
              }
              if (entry.affinity === "AB") {
                label = `HEALS ${Math.max(0, entry.damage)}`;
                cls   = "absorb";
              } else if (entry.affinity === "IM" || entry.damage <= 0) {
                label = "NO EFFECT";
                cls   = "miss";
              } else {
                label = `HIT — ${entry.damage} ${unit}`;
                cls   = entry.crit ? "crit" : "hit";
              }
            }
            resultSpan.className = `t-result ${cls}`;
            resultSpan.textContent = label;
          }
        } catch (e) {
          warn("action-card: recomputeTargetPreviews threw", e);
        }
      })();
      await _previewInFlight;
      _previewInFlight = null;
    }

    // Initial pass — surfaces "on" / "force" mode bonuses immediately
    // on card spawn (they pre-record as "apply" above). Without this,
    // the card would briefly show pre-bonus values until the first
    // ask-mode click. Fire-and-forget.
    try { recomputeTargetPreviews().catch(() => {}); } catch {}

    // Player-driven confirm/cancel via IntentChannel. The acting actor's
    // owner sees their own copy of the card; clicking Confirm/Cancel
    // there emits an intent which lands here via awaitIntent. Either
    // side (GM-local button OR player-side intent) resolves the same
    // `finish` — whichever wins first.
    //
    // CRITICAL: we abort the unused side's await as soon as ANY path
    // resolves. Without this, e.g. a CONFIRM-fired finish() leaves the
    // CANCEL_ACTION await dangling in _pendingAwaits. On the NEXT turn,
    // an emitted CANCEL_ACTION would match the stale entry first
    // (Map insertion order) and the new turn's await would never fire.
    let confirmAwait = null;
    let cancelAwait = null;
    let reactionAwait = null;
    const abortPendingAwaits = () => {
      try { confirmAwait?.abort?.("postActionCard-finish"); } catch {}
      try { cancelAwait?.abort?.("postActionCard-finish"); } catch {}
      try { reactionAwait?.abort?.("postActionCard-finish"); } catch {}
    };
    if (director?.intentChannel) {
      try {
        confirmAwait = director.intentChannel.awaitIntent(INTENTS.CONFIRM_ACTION, {
          timeoutMs: 30 * 60 * 1000,
        });
        cancelAwait = director.intentChannel.awaitIntent(INTENTS.CANCEL_ACTION, {
          timeoutMs: 30 * 60 * 1000,
        });
        confirmAwait.then((intent) => {
          log("postActionCard: remote CONFIRM_ACTION received");
          const extras = intent?.body ?? {};
          finish("confirm", extras);
        }).catch((e) => {
          if (!resolved) warn("postActionCard: CONFIRM_ACTION await failed", e?.message);
        });
        cancelAwait.then(() => {
          log("postActionCard: remote CANCEL_ACTION received");
          finish("cancel");
        }).catch((e) => {
          if (!resolved) warn("postActionCard: CANCEL_ACTION await failed", e?.message);
        });
        // Reaction-pill choice loop — keep re-arming awaitIntent for
        // REACTION_CHOICE so a player can click multiple pills. Each
        // landing intent updates the GM-side card; loop exits when the
        // card resolves (resolved=true) or rearm-await is aborted.
        const armReactionAwait = () => {
          if (resolved) return;
          if (initialPending === 0) return;
          reactionAwait = director.intentChannel.awaitIntent(INTENTS.REACTION_CHOICE, {
            timeoutMs: 30 * 60 * 1000,
          });
          reactionAwait.then((intent) => {
            const body = intent?.body ?? {};
            log(`postActionCard: remote REACTION_CHOICE received (${body.rowKey ?? "?"}/${body.decision ?? "?"})`);
            const decision = body.decision === "apply" ? "apply" : "skip";
            recordPillDecision(String(body.rowKey ?? ""), String(body.carrierUuid ?? ""), decision);
            // Re-arm for the next pill click (or no-op if none left).
            armReactionAwait();
          }).catch((e) => {
            if (!resolved) log(`postActionCard: REACTION_CHOICE await aborted (${e?.message})`);
          });
        };
        armReactionAwait();
      } catch (e) { warn("postActionCard: remote intent setup threw", e); }
    }

    const onClick = (ev) => {
      const lockedInvoke = ev.target?.closest?.(".fud-btn-invoke.is-locked");
      if (lockedInvoke) {
        ev.stopPropagation();
        ui.notifications?.info("Invoke Trait / Bond arrive in Phase E.");
        return;
      }
      // Reaction-pill click handling — Apply / Skip on a pre-resolve
      // passive (Healing Power, Support Magic etc.). Updates the pill
      // visually + decrements the card-level pending counter so Confirm
      // unlocks when all asks are decided.
      const reactionBtn = ev.target?.closest?.("[data-fud-reaction-action]");
      if (reactionBtn) {
        ev.stopPropagation();
        const pill = reactionBtn.closest(".fud-bf-reaction-pill");
        if (!pill) return;
        const rowKey = pill.dataset.fudReactionKey ?? "";
        const carrier = pill.dataset.fudReactionCarrier ?? "";
        const decision = reactionBtn.dataset.fudReactionAction === "apply" ? "apply" : "skip";
        recordPillDecision(rowKey, carrier, decision);
        return;
      }
      // "Open Character Sheet" (Equipment card) — fire-and-forget; the
      // card stays open so the player can flip back and click Done after
      // they're finished rearranging gear on the sheet.
      const openSheet = ev.target?.closest?.("[data-fud-open-sheet]");
      if (openSheet) {
        ev.stopPropagation();
        const uuid = openSheet.dataset.fudOpenSheet;
        (async () => {
          try {
            const doc = await fromUuid(uuid);
            const sheet = doc?.sheet ?? doc?.actor?.sheet;
            if (sheet?.render) sheet.render(true);
            else ui.notifications?.warn("Could not open the character sheet.");
          } catch (e) {
            warn("Open sheet failed", e);
            ui.notifications?.error("Failed to open the character sheet.");
          }
        })();
        return;
      }
      // Equipment custom-dropdown handling — these happen before the
      // generic [data-fud-action] check because the dropdown rows live
      // inside the body of the Equipment card (not on action buttons).
      const equipOption = ev.target?.closest?.(".fud-bf-equip-option");
      const equipTrigger = ev.target?.closest?.(".fud-bf-equip-trigger");
      if (equipOption || equipTrigger) {
        ev.stopPropagation();
        const row = (equipOption ?? equipTrigger).closest(".fud-bf-equip-row");
        if (!row) return;
        if (equipOption) {
          // Commit selection. Hand-group rules (group="hand"):
          //   1. 2H ghost mirror — a 2H weapon equipped in either slot
          //      makes the peer show the SAME weapon faded (`is-ghost`)
          //      to communicate that it occupies both slots. The peer's
          //      data value stays "" (matching the Fabula data
          //      convention: main_hand holds the 2H name, off_hand is "").
          //   2. Removing a 2H from EITHER slot (changing the real OR
          //      the ghosted slot to anything else) clears both rows —
          //      the 2H is no longer worn.
          //   3. Non-2H swap-not-clear: when picking a 1H item that's
          //      already in the peer slot, move the peer's value to
          //      where the new item came from (preserves the
          //      displaced item, no orphan unequip).
          // For accessory rows ("acc"): only rule 3 applies.
          const newValue = equipOption.dataset.fudEquipValue || "";
          const newIsTwoHanded = equipOption.dataset.fudEquipTwohanded === "1";
          const isHandGroup = row.dataset.fudEquipGroup === "hand";
          if (isHandGroup) {
            const group = row.dataset.fudEquipGroup;
            const peer = Array.from(root.querySelectorAll(
              `.fud-bf-equip-row[data-fud-equip-group="${group}"]`
            )).find((p) => p !== row) ?? null;
            applyHandPick(row, peer, newValue, newIsTwoHanded);
          } else {
            // Accessory rows — swap-not-clear dedupe only.
            const oldValue = row.dataset.fudEquipCurrent || "";
            const group = row.dataset.fudEquipGroup;
            const peers = root.querySelectorAll(
              `.fud-bf-equip-row[data-fud-equip-group="${group}"]`
            );
            for (const peer of peers) {
              if (peer === row) continue;
              if (newValue && (peer.dataset.fudEquipCurrent || "") === newValue) {
                setEquipRowSelection(peer, oldValue);
              }
            }
            setEquipRowSelection(row, newValue);
          }
          // Close the popover after a selection.
          row.classList.remove("is-open");
          const trig = row.querySelector(".fud-bf-equip-trigger");
          if (trig) trig.setAttribute("aria-expanded", "false");
          try { hideDescTip(); } catch {}
          return;
        }
        // Trigger clicked — toggle this row's popover, close any others.
        const isOpen = row.classList.contains("is-open");
        for (const other of root.querySelectorAll(".fud-bf-equip-row.is-open")) {
          if (other === row) continue;
          other.classList.remove("is-open");
          const t = other.querySelector(".fud-bf-equip-trigger");
          if (t) t.setAttribute("aria-expanded", "false");
        }
        row.classList.toggle("is-open", !isOpen);
        equipTrigger.setAttribute("aria-expanded", String(!isOpen));
        try { hideDescTip(); } catch {}
        return;
      }
      // Click anywhere else inside the card while a popover is open
      // closes the popover (without consuming the click — buttons still
      // work normally on the same click).
      const anyOpen = root.querySelectorAll(".fud-bf-equip-row.is-open");
      if (anyOpen.length) {
        try { hideDescTip(); } catch {}
        for (const r of anyOpen) {
          r.classList.remove("is-open");
          const t = r.querySelector(".fud-bf-equip-trigger");
          if (t) t.setAttribute("aria-expanded", "false");
        }
      }

      // Item-card tab clicks — swap which panel is active. Tabs are
      // mutually exclusive; the inactive panel keeps its DOM (selection
      // state preserved across tab toggles).
      const itemTab = ev.target?.closest?.(".fud-bf-item-tab");
      if (itemTab) {
        ev.stopPropagation();
        const tabKey = itemTab.dataset.fudItemTab;
        for (const t of root.querySelectorAll(".fud-bf-item-tab")) {
          t.classList.toggle("is-active", t === itemTab);
        }
        for (const p of root.querySelectorAll(".fud-bf-item-panel")) {
          p.classList.toggle("is-active", p.dataset.fudItemPanel === tabKey);
        }
        return;
      }
      // Item-card row clicks — select the item (or ignore if disabled
      // for IP-affordability). Card root carries the active selection;
      // Done button enables/disables based on it.
      const itemRow = ev.target?.closest?.(".fud-bf-item-row");
      if (itemRow) {
        ev.stopPropagation();
        if (itemRow.dataset.fudItemDisabled === "1") return;
        for (const r of root.querySelectorAll(".fud-bf-item-row")) {
          r.classList.toggle("is-selected", r === itemRow);
        }
        root.dataset.fudItemMode = itemRow.dataset.fudItemMode || "";
        root.dataset.fudItemKey  = itemRow.dataset.fudItemKey  || "";
        root.dataset.fudItemCost = itemRow.dataset.fudItemCost || "0";
        const confirmBtn = root.querySelector(".fud-btn-confirm");
        if (confirmBtn) confirmBtn.classList.remove("is-disabled");
        return;
      }

      const btn = ev.target?.closest?.("[data-fud-action]");
      if (!btn) return;
      // Block Done clicks while disabled (Item card with nothing picked).
      if (btn.classList.contains("is-disabled")) {
        ev.stopPropagation();
        return;
      }
      ev.stopPropagation();
      // Buttons can optionally carry a `data-fud-status-value` attribute
      // (Hinder's status picker). Forward it to Confirm.
      const extras = {};
      if (btn.dataset.fudStatusValue) extras.statusValue = btn.dataset.fudStatusValue;
      // Equipment card has one custom dropdown per slot — current value
      // is stored on the row via data-fud-equip-current. Collect them
      // all and ship as a map { slotKey: itemIdOrNull }. Confirm merges
      // this into actionResult for RESOLVE to commit.
      const equipRows = root.querySelectorAll(".fud-bf-equip-row[data-fud-equip-slot]");
      if (equipRows.length) {
        const map = {};
        for (const r of equipRows) {
          const slot = r.dataset.fudEquipSlot;
          if (slot) map[slot] = r.dataset.fudEquipCurrent || null;
        }
        extras.equipmentSelections = map;
      }
      // Item card — current pick lives on the card root.
      if (root.dataset.fudItemMode && root.dataset.fudItemKey) {
        extras.itemSelection = {
          mode: root.dataset.fudItemMode,
          key:  root.dataset.fudItemKey,
          cost: Number(root.dataset.fudItemCost || 0) || 0,
        };
      }
      finish(btn.dataset.fudAction, extras);
    };
    root.addEventListener("click", onClick);

    // Description tooltip — body-mounted singleton so it can escape the
    // popover's overflow:auto clip and overflow the card itself. Shown
    // after ~600ms hover dwell on any [data-fud-equip-desc] element,
    // hidden on leave / scroll / popover close.
    let descTip = null;
    let descShowTid = null;
    let descShowRaf = null;
    let descTarget = null;
    const ensureDescTip = () => {
      if (descTip) return descTip;
      descTip = document.createElement("div");
      descTip.className = "fud-bf-desc-tip";
      descTip.innerHTML = `
        <div class="fud-bf-desc-tip-name"></div>
        <div class="fud-bf-desc-tip-stats"></div>
        <div class="fud-bf-desc-tip-body"></div>
      `;
      document.body.appendChild(descTip);
      return descTip;
    };
    const positionDescTip = (anchor) => {
      if (!descTip || !anchor) return;
      const a = anchor.getBoundingClientRect();
      const tip = descTip.getBoundingClientRect();
      const margin = 8;
      // Prefer right side; fall back to left if it'd clip the viewport.
      let left = a.right + margin;
      if (left + tip.width > window.innerWidth - 4) {
        left = Math.max(4, a.left - tip.width - margin);
      }
      let top = a.top;
      if (top + tip.height > window.innerHeight - 4) {
        top = Math.max(4, window.innerHeight - tip.height - 4);
      }
      descTip.style.left = `${left}px`;
      descTip.style.top  = `${top}px`;
    };
    const showDescTip = (target) => {
      // Resolve guard — if the card already finished while the dwell
      // was pending, don't surface a ghost tooltip on top of nothing.
      if (resolved) return;
      const desc = target.dataset.fudEquipDesc;
      const stats = target.dataset.fudEquipStats || "";
      if (!desc && !stats) return;
      const name = target.dataset.fudEquipDescName || "";
      const tip = ensureDescTip();
      tip.querySelector(".fud-bf-desc-tip-name").textContent = name;
      tip.querySelector(".fud-bf-desc-tip-stats").innerHTML = stats;
      // Description from CSB items is rich HTML — trust it (it's local
      // actor data, not user input). The body is rendered as-is.
      tip.querySelector(".fud-bf-desc-tip-body").innerHTML = desc ?? "";
      positionDescTip(target);
      // Cancel any prior pending rAF so we don't get stacked "add visible"
      // callbacks racing a hideDescTip() that just removed the class.
      if (descShowRaf != null) {
        try { cancelAnimationFrame(descShowRaf); } catch {}
      }
      descShowRaf = requestAnimationFrame(() => {
        descShowRaf = null;
        // Re-check resolved on the next frame — the user may have
        // clicked an option in the gap between sync show and rAF tick.
        if (resolved) return;
        tip.classList.add("is-visible");
      });
    };
    const hideDescTip = () => {
      try { clearTimeout(descShowTid); } catch {}
      descShowTid = null;
      // Cancel the pending "add visible" rAF too — otherwise a click
      // that closes the menu mid-fade-in lets the tooltip appear after
      // the menu's gone.
      if (descShowRaf != null) {
        try { cancelAnimationFrame(descShowRaf); } catch {}
        descShowRaf = null;
      }
      descTarget = null;
      if (!descTip) return;
      descTip.classList.remove("is-visible");
    };
    const tipTargetSelector = "[data-fud-equip-desc], [data-fud-equip-stats]";
    const onOver = (ev) => {
      const opt = ev.target?.closest?.(tipTargetSelector);
      if (!opt) return;
      if (opt === descTarget) return;
      hideDescTip();
      descTarget = opt;
      descShowTid = setTimeout(() => {
        if (descTarget === opt && document.body.contains(opt)) showDescTip(opt);
      }, 600);
    };
    const onOut = (ev) => {
      const opt = ev.target?.closest?.(tipTargetSelector);
      if (!opt) return;
      const next = ev.relatedTarget?.closest?.(tipTargetSelector);
      if (next === opt) return;
      hideDescTip();
    };
    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut);
    // Hide if the user scrolls the popover so the tooltip doesn't drift
    // past stale option positions.
    root.addEventListener("scroll", hideDescTip, true);

    // Enter to confirm. Esc deliberately does nothing — once the dice
    // are rolled the player can't backtrack; GM-side undo lives elsewhere.
    keyListener = (ev) => {
      if (resolved) return;
      if (ev.key === "Enter") { ev.preventDefault(); finish("confirm"); }
    };
    window.addEventListener("keydown", keyListener, true);

    const cleanup = () => {
      try { clearTimeout(despawnTid); } catch {}
      try { window.removeEventListener("keydown", keyListener, true); } catch {}
      try { hideDescTip(); } catch {}
      try { descTip?.remove(); } catch {}
      try { root.remove(); } catch {}
      _overlays.delete(director.combatId);
      if (!resolved) {
        resolved = true;
        resolve({ confirmed: false, cancelled: true });
      }
    };

    _overlays.set(director.combatId, { cleanup, root });
  });
}

export const BattlefieldActionCard = {
  despawn({ director }) {
    const rec = _overlays.get(director.combatId);
    if (!rec) return;
    try { rec.cleanup(); } catch {}
    _overlays.delete(director.combatId);
  },

  despawnAll() {
    for (const rec of _overlays.values()) {
      try { rec.cleanup(); } catch {}
    }
    _overlays.clear();
  },
};

// ─── Player-side mirror ───────────────────────────────────────────────
//
// Player clients receive the GM's rendered action card via MENU_OPEN
// { kind: "action-card", html, ownerUserId, ... } and inject the HTML
// into their own document body. Interactive buttons (Confirm/Cancel)
// are gated: only the acting actor's owner can click. Everyone else
// gets a read-only render.
//
// On owner-click → emit CONFIRM_ACTION or CANCEL_ACTION over the
// IntentChannel. GM's awaitIntent in postActionCard resolves on
// receipt, finishing the local Promise and broadcasting MENU_CLOSE
// to all clients (closing the mirror DOM).
//
// State: only one mirror card lives at a time per client. A second
// MENU_OPEN supersedes the prior.
const MIRROR_ROOT_ID = "fud-bf-mirror-root";
let _mirrorCleanup = null;

function cleanupMirror() {
  if (_mirrorCleanup) {
    try { _mirrorCleanup(); } catch {}
    _mirrorCleanup = null;
  }
  const existing = document.getElementById(MIRROR_ROOT_ID);
  if (existing) try { existing.remove(); } catch {}
}

export function registerPlayerActionCardHandler(channel) {
  // Lightweight patch handler for pill state changes broadcast from
  // recordPillDecision (GM side). Applies the same DOM transformation
  // — pending → resolved + status chip — to the local mirror so the
  // observer sees Applied/Skipped flip in real time instead of staying
  // frozen on initial render.
  const offPillUpdate = channel.onMenuOpen((menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "action-card-pill-update") return;
    const wrapper = document.getElementById(MIRROR_ROOT_ID);
    if (!wrapper) return;
    const cardEl = wrapper.querySelector(".fud-bf-card");
    const pillEl = wrapper.querySelector(
      `.fud-bf-reaction-pill[data-fud-reaction-key="${CSS.escape(String(menuSpec.rowKey ?? ""))}"][data-fud-reaction-carrier="${CSS.escape(String(menuSpec.carrierUuid ?? ""))}"]`
    );
    if (!pillEl) return;
    const decision = menuSpec.decision === "apply" ? "apply" : "skip";
    pillEl.dataset.fudReactionPending = "0";
    pillEl.classList.add("is-resolved", decision === "apply" ? "is-applied" : "is-skipped");
    // Replace whatever's in the actions slot ("Waiting for…" chip on
    // non-owner mirror; Apply/Skip buttons on owner mirror that
    // somehow missed the local click) with the final status chip.
    const actions = pillEl.querySelector(".fud-bf-reaction-actions, .fud-bf-reaction-status.is-waiting");
    if (actions) {
      actions.outerHTML = `<span class="fud-bf-reaction-status">${decision === "apply" ? "Applied" : "Skipped"}</span>`;
    }
    if (cardEl) {
      const next = Math.max(0, Number(menuSpec.pendingCount ?? 0));
      if (next > 0) cardEl.dataset.fudReactionsPending = String(next);
      else delete cardEl.dataset.fudReactionsPending;
    }
  });

  const offOpen = channel.onMenuOpen((menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "action-card") return;
    if (!menuSpec.html) {
      warn("action-card MENU_OPEN: missing html");
      return;
    }

    // Inject the card's stylesheet on this client. The CSS rules are
    // GM-injected on first postActionCard() call there; player clients
    // never reach that code path, so without this call the imported
    // HTML renders unstyled and shoves document layout (the original
    // bug: card pushed the player's sidebar around). ensureStyles is
    // idempotent — checks for the existing <style id="..."> before
    // injecting.
    try { ensureStyles(); }
    catch (e) { warn("mirror ensureStyles threw — card will render unstyled", e); }

    // Replace any prior mirror — only one card on screen at a time.
    cleanupMirror();

    // Build a wrapper so we can hold both the imported HTML and the
    // event handlers. The imported HTML preserves the original DOM ids
    // (e.g. "fud-bf-action-card-root") so styles attach correctly.
    const wrapper = document.createElement("div");
    wrapper.id = MIRROR_ROOT_ID;
    wrapper.innerHTML = menuSpec.html;
    document.body.appendChild(wrapper);

    // Permission gate. Owner of the acting actor gets interactive
    // buttons; non-owners see them but clicks are no-ops with a hint.
    const isOwner = menuSpec.ownerUserId && menuSpec.ownerUserId === game.user?.id;
    const card = wrapper.querySelector(".fud-bf-card");

    if (!isOwner && card) {
      // Visually mark the card as read-only — also disables click via
      // event guard below. The class is purely informational; the real
      // gate is the event listener.
      card.classList.add("is-readonly-mirror");
      // No "Observing" banner — non-owners may soon have a role to play
      // (reaction skills etc.), so we don't pre-label the card as passive.

      // Hide the action buttons (Confirm / Cancel / Invoke / status grid)
      // entirely for non-owner observers — they can't act, so the buttons
      // shouldn't show at all. The acting owner (interactive branch) and the
      // GM (renders its own card, never this mirror) keep theirs.
      for (const row of wrapper.querySelectorAll(".fud-bf-btn-row")) {
        row.style.display = "none";
      }

      // Hide reaction Apply/Skip buttons on non-owner mirror — they're
      // not actionable from this client, so they shouldn't look like
      // they are. Replace each pending pill's button row with a
      // "Waiting for [Owner]…" status chip. Already-resolved pills
      // (post-decision) carry .is-resolved + a status chip from the
      // GM-side recordPillDecision DOM patch — leave those alone.
      const ownerName = game.users.get(menuSpec.ownerUserId)?.name ?? "Player";
      for (const pill of wrapper.querySelectorAll(".fud-bf-reaction-pill.is-ask")) {
        if (pill.dataset.fudReactionPending !== "1") continue;
        const actions = pill.querySelector(".fud-bf-reaction-actions");
        if (actions) {
          actions.outerHTML = `<span class="fud-bf-reaction-status is-waiting">Waiting for ${escapeHtml(ownerName)}…</span>`;
        }
      }
    }

    // Click logic — replicates the GM-side onClick for interactive card
    // UI (Equipment dropdowns, Item tabs+rows, "Open Sheet" button,
    // Confirm/Cancel buttons). Non-owner observers get no bindings at
    // all (.is-readonly-mirror set above visually disables hover/focus).
    let onClick = null;
    if (isOwner) {
      onClick = (ev) => {
        // "Open Character Sheet" — fire-and-forget; opens the actor's
        // sheet for the player to rearrange equipment manually.
        const openSheet = ev.target?.closest?.("[data-fud-open-sheet]");
        if (openSheet) {
          ev.stopPropagation();
          const uuid = openSheet.dataset.fudOpenSheet;
          (async () => {
            try {
              const doc = await fromUuid(uuid);
              const sheet = doc?.sheet ?? doc?.actor?.sheet;
              if (sheet?.render) sheet.render(true);
              else ui.notifications?.warn("Could not open the character sheet.");
            } catch (e) {
              warn("Open sheet (mirror) failed", e);
              ui.notifications?.error("Failed to open the character sheet.");
            }
          })();
          return;
        }
        // Equipment dropdown handling — mirrors GM-side logic. The
        // helpers setEquipRowSelection / applyHandPick are module-level
        // so they work against any DOM tree.
        const equipOption = ev.target?.closest?.(".fud-bf-equip-option");
        const equipTrigger = ev.target?.closest?.(".fud-bf-equip-trigger");
        if (equipOption || equipTrigger) {
          ev.stopPropagation();
          const row = (equipOption ?? equipTrigger).closest(".fud-bf-equip-row");
          if (!row) return;
          if (equipOption) {
            const newValue = equipOption.dataset.fudEquipValue || "";
            const newIsTwoHanded = equipOption.dataset.fudEquipTwohanded === "1";
            const isHandGroup = row.dataset.fudEquipGroup === "hand";
            if (isHandGroup) {
              const group = row.dataset.fudEquipGroup;
              const peer = Array.from(wrapper.querySelectorAll(
                `.fud-bf-equip-row[data-fud-equip-group="${group}"]`
              )).find((p) => p !== row) ?? null;
              applyHandPick(row, peer, newValue, newIsTwoHanded);
            } else {
              const oldValue = row.dataset.fudEquipCurrent || "";
              const group = row.dataset.fudEquipGroup;
              const peers = wrapper.querySelectorAll(
                `.fud-bf-equip-row[data-fud-equip-group="${group}"]`
              );
              for (const peer of peers) {
                if (peer === row) continue;
                if (newValue && (peer.dataset.fudEquipCurrent || "") === newValue) {
                  setEquipRowSelection(peer, oldValue);
                }
              }
              setEquipRowSelection(row, newValue);
            }
            row.classList.remove("is-open");
            const trig = row.querySelector(".fud-bf-equip-trigger");
            if (trig) trig.setAttribute("aria-expanded", "false");
            return;
          }
          // Trigger clicked — toggle popover, close others.
          const isOpen = row.classList.contains("is-open");
          for (const other of wrapper.querySelectorAll(".fud-bf-equip-row.is-open")) {
            if (other === row) continue;
            other.classList.remove("is-open");
            const t = other.querySelector(".fud-bf-equip-trigger");
            if (t) t.setAttribute("aria-expanded", "false");
          }
          row.classList.toggle("is-open", !isOpen);
          equipTrigger.setAttribute("aria-expanded", String(!isOpen));
          return;
        }
        // Click outside an open popover closes it.
        const anyOpen = wrapper.querySelectorAll(".fud-bf-equip-row.is-open");
        if (anyOpen.length) {
          for (const r of anyOpen) {
            r.classList.remove("is-open");
            const t = r.querySelector(".fud-bf-equip-trigger");
            if (t) t.setAttribute("aria-expanded", "false");
          }
        }
        // Item-card tab switch.
        const itemTab = ev.target?.closest?.(".fud-bf-item-tab");
        if (itemTab) {
          ev.stopPropagation();
          const tabKey = itemTab.dataset.fudItemTab;
          for (const t of wrapper.querySelectorAll(".fud-bf-item-tab")) {
            t.classList.toggle("is-active", t === itemTab);
          }
          for (const p of wrapper.querySelectorAll(".fud-bf-item-panel")) {
            p.classList.toggle("is-active", p.dataset.fudItemPanel === tabKey);
          }
          return;
        }
        // Item-card row select.
        const itemRow = ev.target?.closest?.(".fud-bf-item-row");
        if (itemRow) {
          ev.stopPropagation();
          if (itemRow.dataset.fudItemDisabled === "1") return;
          for (const r of wrapper.querySelectorAll(".fud-bf-item-row")) {
            r.classList.toggle("is-selected", r === itemRow);
          }
          // Item-card root is the .fud-bf-card child (NOT our wrapper).
          // GM's path stores selection on root.dataset; we do the same on
          // the imported card div so the data lookup at Confirm finds it.
          const cardEl = wrapper.querySelector(".fud-bf-card");
          if (cardEl) {
            cardEl.dataset.fudItemMode = itemRow.dataset.fudItemMode || "";
            cardEl.dataset.fudItemKey  = itemRow.dataset.fudItemKey  || "";
            cardEl.dataset.fudItemCost = itemRow.dataset.fudItemCost || "0";
          }
          const confirmBtn = wrapper.querySelector(".fud-btn-confirm");
          if (confirmBtn) confirmBtn.classList.remove("is-disabled");
          return;
        }
        // Reaction-pill click on the mirror — emit REACTION_CHOICE so
        // the GM-side card updates the pill state + unlocks Confirm
        // when all asks are decided. The pill also updates locally so
        // the player sees the immediate visual change.
        const reactionBtn = ev.target?.closest?.("[data-fud-reaction-action]");
        if (reactionBtn) {
          ev.stopPropagation();
          const pill = reactionBtn.closest(".fud-bf-reaction-pill");
          if (!pill) return;
          if (pill.dataset.fudReactionPending !== "1") return;
          const rowKey  = pill.dataset.fudReactionKey ?? "";
          const carrier = pill.dataset.fudReactionCarrier ?? "";
          const decision = reactionBtn.dataset.fudReactionAction === "apply" ? "apply" : "skip";
          // Mirror-side visual update: flip the pill to its resolved
          // state immediately so the player sees instant feedback. The
          // GM-side card handles its own visual update via the intent
          // listener.
          pill.dataset.fudReactionPending = "0";
          pill.classList.add("is-resolved", decision === "apply" ? "is-applied" : "is-skipped");
          const actions = pill.querySelector(".fud-bf-reaction-actions");
          if (actions) {
            actions.outerHTML = `<span class="fud-bf-reaction-status">${decision === "apply" ? "Applied" : "Skipped"}</span>`;
          }
          const mirrorCardEl = wrapper.querySelector(".fud-bf-card");
          if (mirrorCardEl) {
            const cur = Number(mirrorCardEl.dataset?.fudReactionsPending ?? 0);
            const next = Math.max(0, cur - 1);
            if (next > 0) mirrorCardEl.dataset.fudReactionsPending = String(next);
            else delete mirrorCardEl.dataset.fudReactionsPending;
          }
          channel.emit({
            type: INTENTS.REACTION_CHOICE,
            body: { rowKey, carrierUuid: carrier, decision },
            combatId: menuSpec.combatId,
          });
          return;
        }
        // Final Confirm / Cancel button — collect extras + emit intent.
        const btn = ev.target?.closest?.("[data-fud-action]");
        if (!btn) return;
        if (btn.classList.contains("is-disabled")) {
          ev.stopPropagation();
          return;
        }
        ev.stopPropagation();
        const action = btn.dataset.fudAction;
        const extras = {};
        // Status pick (Hinder)
        if (btn.dataset.fudStatusValue) extras.statusValue = btn.dataset.fudStatusValue;
        // Equipment selections (one entry per slot)
        const equipRows = wrapper.querySelectorAll(".fud-bf-equip-row[data-fud-equip-slot]");
        if (equipRows.length) {
          const map = {};
          for (const r of equipRows) {
            const slot = r.dataset.fudEquipSlot;
            if (slot) map[slot] = r.dataset.fudEquipCurrent || null;
          }
          extras.equipmentSelections = map;
        }
        // Item selection (mode/key/cost stamped on .fud-bf-card root)
        const cardEl = wrapper.querySelector(".fud-bf-card");
        if (cardEl?.dataset.fudItemMode && cardEl?.dataset.fudItemKey) {
          extras.itemSelection = {
            mode: cardEl.dataset.fudItemMode,
            key:  cardEl.dataset.fudItemKey,
            cost: Number(cardEl.dataset.fudItemCost || 0) || 0,
          };
        }
        if (action === "confirm") {
          channel.emit({
            type: INTENTS.CONFIRM_ACTION,
            body: extras,
            combatId: menuSpec.combatId,
          });
          for (const b of wrapper.querySelectorAll(".fud-btn")) b.classList.add("is-resolved");
        } else if (action === "cancel") {
          channel.emit({
            type: INTENTS.CANCEL_ACTION,
            body: {},
            combatId: menuSpec.combatId,
          });
          for (const b of wrapper.querySelectorAll(".fud-btn")) b.classList.add("is-resolved");
        }
      };
      wrapper.addEventListener("click", onClick);
    } else {
      // Non-owner observer — soft block: log a hint but consume the
      // click so it doesn't fall through to anything below.
      onClick = (ev) => {
        const btn = ev.target?.closest?.("[data-fud-action]");
        if (btn) {
          ev.stopPropagation();
          ui.notifications?.info("Only the acting player or GM can confirm this action.");
        }
      };
      wrapper.addEventListener("click", onClick);
    }

    // Dwell tooltip — wires the same data-fud-equip-desc /
    // data-fud-equip-desc-name attributes the GM-side card uses
    // (equipment options, target rows, reaction pills). Mirrors the
    // singleton tooltip pattern from postActionCard, scoped to this
    // mirror wrapper. Both owners and observers get hover-info on the
    // reaction pills so the player can read what each reaction does
    // without taking action on it.
    let mirrorTipCleanup = null;
    {
      let mirrorTip = null;
      let mirrorTarget = null;
      let mirrorShowTid = null;
      let mirrorShowRaf = null;
      const ensureMirrorTip = () => {
        if (mirrorTip) return mirrorTip;
        mirrorTip = document.createElement("div");
        mirrorTip.className = "fud-bf-desc-tip";
        mirrorTip.innerHTML = `
          <div class="fud-bf-desc-tip-name"></div>
          <div class="fud-bf-desc-tip-stats"></div>
          <div class="fud-bf-desc-tip-body"></div>`;
        document.body.appendChild(mirrorTip);
        return mirrorTip;
      };
      const positionMirrorTip = (anchor) => {
        if (!mirrorTip || !anchor) return;
        const r = anchor.getBoundingClientRect();
        const tip = mirrorTip.getBoundingClientRect();
        let left = r.right + 12;
        let top  = r.top;
        const margin = 8;
        if (left + tip.width > window.innerWidth - margin) {
          left = r.left - tip.width - 12;
        }
        if (top + tip.height > window.innerHeight - margin) {
          top = window.innerHeight - tip.height - margin;
        }
        if (top < margin) top = margin;
        mirrorTip.style.left = `${Math.max(margin, left)}px`;
        mirrorTip.style.top  = `${top}px`;
      };
      const showMirrorTip = (target) => {
        const desc  = target.dataset.fudEquipDesc;
        const stats = target.dataset.fudEquipStats || "";
        if (!desc && !stats) return;
        const name = target.dataset.fudEquipDescName || "";
        const tip = ensureMirrorTip();
        tip.querySelector(".fud-bf-desc-tip-name").textContent = name;
        tip.querySelector(".fud-bf-desc-tip-stats").innerHTML = stats;
        tip.querySelector(".fud-bf-desc-tip-body").innerHTML  = desc ?? "";
        positionMirrorTip(target);
        if (mirrorShowRaf != null) {
          try { cancelAnimationFrame(mirrorShowRaf); } catch {}
        }
        mirrorShowRaf = requestAnimationFrame(() => {
          mirrorShowRaf = null;
          tip.classList.add("is-visible");
        });
      };
      const hideMirrorTip = () => {
        if (mirrorShowTid != null) { try { clearTimeout(mirrorShowTid); } catch {} mirrorShowTid = null; }
        if (mirrorShowRaf != null) { try { cancelAnimationFrame(mirrorShowRaf); } catch {} mirrorShowRaf = null; }
        mirrorTarget = null;
        if (!mirrorTip) return;
        mirrorTip.classList.remove("is-visible");
      };
      const mirrorTipSelector = "[data-fud-equip-desc], [data-fud-equip-stats]";
      wrapper.addEventListener("mouseover", (ev) => {
        const opt = ev.target?.closest?.(mirrorTipSelector);
        if (!opt) return;
        if (opt === mirrorTarget) return;
        hideMirrorTip();
        mirrorTarget = opt;
        mirrorShowTid = setTimeout(() => {
          if (mirrorTarget === opt && document.body.contains(opt)) showMirrorTip(opt);
        }, 600);
      });
      wrapper.addEventListener("mouseout", (ev) => {
        const opt = ev.target?.closest?.(mirrorTipSelector);
        if (!opt) return;
        const next = ev.relatedTarget?.closest?.(mirrorTipSelector);
        if (next === opt) return;
        hideMirrorTip();
      });
      // Expose the tooltip cleanup so the mirror's final cleanup
      // assignment below can chain to it. Without this the tooltip DOM
      // node stays in document.body after the mirror is dismantled,
      // and a leftover dwell could surface a stale tooltip.
      mirrorTipCleanup = () => {
        try { hideMirrorTip(); } catch {}
        try { mirrorTip?.remove(); } catch {}
        mirrorTip = null;
      };
    }

    // Make the card visible. The CSS animation rule is keyed on
    // `#${ROOT_ID}.is-visible` (NOT .fud-bf-card.is-visible), so we
    // have to add the class to the root element (the imported div with
    // id="fud-bf-action-card-root"), not the card child. Without this,
    // the root stays at opacity:0 and the player sees nothing.
    //
    // The GM-side broadcast captures outerHTML before its own RAF
    // adds is-visible (RAF fires after the synchronous broadcast),
    // so the class is essentially never in the incoming HTML.
    const importedRoot = wrapper.querySelector(`#${ROOT_ID}`);
    if (importedRoot && !importedRoot.classList.contains("is-visible")) {
      requestAnimationFrame(() => importedRoot.classList.add("is-visible"));
    }

    _mirrorCleanup = () => {
      try { wrapper.removeEventListener("click", onClick); } catch {}
      try { mirrorTipCleanup?.(); } catch {}
    };

    log(`action-card mirror rendered (owner=${isOwner ? "yes" : "observer"})`);
  });

  const offClose = channel.onMenuClose((payload) => {
    if (payload?.kind && payload.kind !== "action-card") return;
    cleanupMirror();
  });

  return () => { try { offOpen?.(); } catch {} try { offClose?.(); } catch {} try { offPillUpdate?.(); } catch {} };
}
