// Battlefield Action Card — director-native overlay.
//
// In-viewport DOM overlay drawn at TRUE center of the viewport; replaces the
// legacy chat-message action card per [[director-battlefield-action-card]].
// One overlay per director.combatId. Despawned by Stopped state +
// director-boot stop() / preflightCleanup().
//
// Aesthetic: legacy CreateActionCard layout ported into the director's
// parchment/earth-tone theme (`--fud-gold-1/2`, `--fud-stroke`) from turn-ui.js.
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
import { resourceLabel } from "./resources.js";
import { computeEffectiveCost, formatCostMap } from "./skill-cost.js";
import { displayElement } from "./skill-formulas.js";
import { lookupTerm } from "./keyword-registry.js";
import { toggleKeywordTooltip, dismissKeywordTooltip } from "./keyword-tooltip.js";
import { isAutoFireReactionMode } from "./reaction-modes.js";
import { resolvesVsMagicDefense, freezeActionResult, hasUnconditionalTargetBlock } from "./snapshot.js";
import { mergeGmOverride, normalizeGmOverride, describeGmEditors, isGmEditableRow,
         summarizeGmOverride, isGmOverrideEmpty, GM_DIE_SIZES,
         GM_DAMAGE_TYPES, GM_WEAPON_TYPES, gmReactionKey, isGmEditableReaction,
         gmReactionDecisionChanges, gmReactionDecision, readGmReopenKeys,
         gmReactionBlocksAutoFire, reduceGmTargetRows, gmEditCount } from "./gm-card-override.js";
import { SimMode } from "./sim/sim-mode.js";
import { decideReactions, bestElementForCard } from "./sim/reaction-brain.js";
import { simInvoke } from "./sim/invoke-brain.js";

// Resolve which active non-GM user owns the given actor doc. Returns
// userId or null. Deterministic on multi-owner actors (sort by id).
function ownerUserIdForActor(actor) {
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
}

// Resolve which active non-GM user owns the actor at `actorUuid`.
// Returns userId or null. Used to gate which player's mirror card
// has interactive Confirm/Cancel buttons (card-level, attacker actor)
// AND which player may apply each reaction pill (per-pill, reactor actor).
async function resolveCardOwnerUserId(actorUuid) {
  try {
    if (!actorUuid) return null;
    const actor = await fromUuid(actorUuid);
    return ownerUserIdForActor(actor);
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
export function ensureStyles() {
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
    /* Hide the card while a card-mutation picker (Protect target pick,
       future change-target prompts, etc.) is on-screen — the floating
       BD picker banner needs the focus, and overlapping cards confuse
       the player. Pointer events stop so the player can't click through
       to pill buttons during the pick. Quick 120ms fade keeps the
       transition snappy. */
    #${ROOT_ID}.is-hidden-during-pick {
      opacity: 0 !important;
      pointer-events: none !important;
      transition: opacity 120ms ease-out;
    }

    .fud-bf-card {
      position: relative;
      pointer-events: auto;
      width: 320px;
      max-width: 92vw;
      padding: 12px 14px 11px;
      border: 2px solid var(--fud-stroke, #7a6a55);
      border-radius: 14px;
      background: linear-gradient(180deg, var(--fud-parchment-top, #f6f1e6), var(--fud-parchment-bot, #ebe3d0));
      box-shadow:
        0 16px 48px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(255, 255, 255, 0.5) inset;
      color: var(--fud-ink, #3a3228);
      font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif;
      letter-spacing: 0.2px;
      /* ── Fitting the card to the screen ──────────────────────────────────
         The root is position:fixed and centred, the card had no max-height,
         and nothing above it scrolls — so any overflow was simply
         UNREACHABLE. Measured on a 3-target card with 7 reaction pills: 978px
         tall, overflowing by 39px at 1280x900 and 249px at 800x480, with
         CONFIRM off-screen and no way to scroll to it. That is a desktop bug,
         not only a small-screen one.

         The answer is NOT to scroll the card. The panels are the readout the
         GM is deciding from, so every panel stays on screen; what scrolls is
         the content inside the three regions that grow without bound — the
         target list, the reaction list and the effect prose. Everything else
         keeps its natural height. */
      max-height: calc(100vh - 16px);
      max-height: calc(100dvh - 16px);
      display: flex; flex-direction: column;
    }
    /* Fixed furniture: never shrinks, never scrolls. */
    .fud-bf-card > .fud-bf-header,
    .fud-bf-card > .fud-bf-subtitle,
    .fud-bf-card > .fud-bf-btn-row { flex: 0 0 auto; }
    .fud-bf-card > .fud-bf-body {
      flex: 1 1 auto; min-height: 0;
      /* Last resort only. fitActionCardToViewport() caps the three growing
         regions first, so this engages only on a viewport too short for the
         FIXED panels — at which point a scrollbar beats an unreachable button. */
      overflow-y: auto;
    }
    /* NOT shrinkable by flex. Its list is capped by the same JS pass as the
       other two, and letting flex squeeze the row as well meant two mechanisms
       fighting over one panel — the row lost height the cap had not accounted
       for, and the reaction pills ended up thinner than the target rows. */
    .fud-bf-card > .fud-bf-reactions-row { flex: 0 0 auto; }
    /* The three regions that grow without bound. Their CAP is set in JS, not
       here: it depends on how much room the fixed panels leave, which CSS
       cannot know. Two pure-CSS attempts are worth recording as dead ends —
       a flex chain through the fieldsets left the list at its full natural
       height spilling out of a squeezed panel (an auto flex-basis is the
       content height, and a flex item will not shrink below it), and switching
       to a zero basis collapsed the lists to 0px, because a fieldset's
       anonymous content box has no definite height to distribute. */
    .fud-bf-card .fud-bf-target-list,
    .fud-bf-card .fud-bf-effect-body,
    .fud-bf-card .fud-bf-reactions-list { overflow-y: auto; }
    /* A capped list has to SAY it is capped. A thin scrollbar is not enough on
       Windows, where it only paints on hover — a GM would see one target row on
       a three-target attack with nothing at all to suggest the other two. The
       bottom edge fades wherever there is more below it. */
    .fud-bf-card .is-clipped {
      -webkit-mask-image: linear-gradient(180deg, #000 calc(100% - 16px), transparent);
      mask-image: linear-gradient(180deg, #000 calc(100% - 16px), transparent);
    }
    /* A default scrollbar inside a parchment card is jarring, and on a list
       that only sometimes scrolls it is also the only cue that there is more —
       so it is styled to read as part of the card rather than hidden. */
    .fud-bf-card .fud-bf-target-list,
    .fud-bf-card .fud-bf-effect-body,
    .fud-bf-card .fud-bf-reactions-list {
      scrollbar-width: thin;
      scrollbar-color: rgba(122, 106, 85, 0.55) transparent;
      overscroll-behavior: contain;
    }
    .fud-bf-card .fud-bf-target-list::-webkit-scrollbar,
    .fud-bf-card .fud-bf-effect-body::-webkit-scrollbar,
    .fud-bf-card .fud-bf-reactions-list::-webkit-scrollbar { width: 7px; }
    .fud-bf-card .fud-bf-target-list::-webkit-scrollbar-thumb,
    .fud-bf-card .fud-bf-effect-body::-webkit-scrollbar-thumb,
    .fud-bf-card .fud-bf-reactions-list::-webkit-scrollbar-thumb {
      background: rgba(122, 106, 85, 0.55); border-radius: 99px;
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
      border-bottom: 2px solid var(--fud-stroke, #7a6a55);
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
      border: 1px solid var(--fud-stroke, #7a6a55);
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

    /* Per-cell role mini-tag — disambiguates "which name is the
       attacker, which is the target" since the disposition-based layout
       can put the attacker on either side. Renders as a small uppercase
       label above the name. Attacker tag has a subtle accent color;
       Target tag is muted. */
    .fud-bf-card .fud-bf-attacker-row .fud-bf-role-tag {
      display: block;
      font-size: 8.5px;
      font-weight: 800;
      letter-spacing: 0.7px;
      text-transform: uppercase;
      opacity: 0.65;
      margin-bottom: 1px;
    }
    .fud-bf-card .fud-bf-attacker-row .is-attacker .fud-bf-role-tag {
      color: var(--fud-stroke, #7a6a55);
    }
    .fud-bf-card .fud-bf-attacker-row .is-targets .fud-bf-role-tag {
      color: var(--fud-ink-soft, #4b4338);
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
    /* Accuracy overridden by a reaction (Crossfire) — the attack is blocked.
       Shrink the word to fit the slot + tint it so it reads as a negation of
       the roll, not a number. */
    .fud-bf-card .fud-bf-acc.is-blocked .total {
      font-size: 15px;
      font-weight: 900;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: #1e6cff;
      text-shadow: 0 0 9px rgba(30, 108, 255, 0.4);
      white-space: nowrap;
    }
    /* "Blocked" is wider than the numeric total it replaces; reclaim the
       strike-icon's width so the word stays inside the card. */
    .fud-bf-card .fud-bf-acc.is-blocked .strike-icon { display: none; }
    /* Damage zeroed by a reaction ("deal no damage" — Warning Shot): strike the
       number, dim it, and surface a "No damage" note in the legend. */
    .fud-bf-card .fud-bf-dmg.is-nullified .fud-bf-dmg-number {
      text-decoration: line-through;
      opacity: 0.4;
      filter: grayscale(1);
    }
    .fud-bf-card .fud-bf-dmg.is-nullified > legend::after {
      content: " — No damage";
      color: #1e6cff;
      font-weight: 800;
      font-size: 11px;
    }
    /* Damage struck because the whole attack was blocked (Crossfire accuracy
       override). Same visual as Warning Shot's strike but a distinct class so
       the post-roll mutation path and the apply-click menu path don't clobber
       each other's toggle. Legend reads "Blocked", not "No damage". */
    .fud-bf-card .fud-bf-dmg.is-blocked-dmg .fud-bf-dmg-number {
      text-decoration: line-through;
      opacity: 0.4;
      filter: grayscale(1);
    }
    .fud-bf-card .fud-bf-dmg.is-blocked-dmg > legend::after {
      content: " — Blocked";
      color: #1e6cff;
      font-weight: 800;
      font-size: 11px;
    }
    /* Negated (Shadow Possession / Crossfire) — the action's accuracy / damage /
       result panels keep their REAL numbers but are DIMMED (desaturated + darkened,
       kept fully opaque — NOT transparent), and each panel's OWN fieldset box is
       recoloured red (border + wash) so the red box lines up exactly with the panel
       it covers — no floating inner rectangle. A solid white-on-red "Negated" pill
       is centred over each. Distinct from "Blocked" (which replaces/zeroes the
       value). The action still produces no actual outcome (RESOLVE skips it).
       NB: acc + result are <div>s inside a .fud-bf-section fieldset, while dmg IS
       the fieldset — so :has() pins all three at the fieldset level uniformly. */
    .fud-bf-card.is-negated fieldset.fud-bf-section:has(> .fud-bf-acc),
    .fud-bf-card.is-negated fieldset.fud-bf-section.fud-bf-dmg,
    .fud-bf-card.is-negated fieldset.fud-bf-section:has(> .fud-bf-target-list) {
      position: relative;
      border-color: rgba(214, 40, 45, 0.85);
      background: rgba(190, 26, 30, 0.12);
    }
    /* dim only the real readout — keep each panel's legend label crisp. Filter
       (not opacity) so the numbers stay solid/opaque, just muted + greyed. */
    .fud-bf-card.is-negated fieldset.fud-bf-section:has(> .fud-bf-acc) > *:not(legend),
    .fud-bf-card.is-negated fieldset.fud-bf-section.fud-bf-dmg > *:not(legend),
    .fud-bf-card.is-negated fieldset.fud-bf-section:has(> .fud-bf-target-list) > *:not(legend) {
      filter: grayscale(0.85) brightness(0.8);
    }
    .fud-bf-card.is-negated fieldset.fud-bf-section:has(> .fud-bf-acc)::after,
    .fud-bf-card.is-negated fieldset.fud-bf-section.fud-bf-dmg::after,
    .fud-bf-card.is-negated fieldset.fud-bf-section:has(> .fud-bf-target-list)::after {
      content: "Negated";
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%); z-index: 4;
      padding: 3px 13px; border-radius: 999px;
      background: #c0181d; color: #fff;
      font-weight: 900; font-size: 12px;
      letter-spacing: 2px; text-transform: uppercase;
      border: 1px solid rgba(255, 255, 255, 0.55);
      box-shadow: 0 1px 5px rgba(0, 0, 0, 0.5);
      pointer-events: none;
    }
    /* ONE-SHOT entrance. 'is-negated-stamp' is added ONCE when the action is
       first negated and removed after ~900ms. Keeping the transition + stamp
       animation here (not on the persistent .is-negated) stops them replaying
       when a LATER reaction is clicked and the card recomputes (is-negated
       stays put, so it would otherwise re-fire). STAMP: arrives oversized then
       snaps to size and hard-stops (55%→100% hold) — like a stamp slamming. */
    .fud-bf-card.is-negated-stamp fieldset.fud-bf-section:has(> .fud-bf-acc),
    .fud-bf-card.is-negated-stamp fieldset.fud-bf-section.fud-bf-dmg,
    .fud-bf-card.is-negated-stamp fieldset.fud-bf-section:has(> .fud-bf-target-list) {
      transition: border-color 240ms ease-out, background-color 240ms ease-out;
    }
    .fud-bf-card.is-negated-stamp fieldset.fud-bf-section:has(> .fud-bf-acc) > *:not(legend),
    .fud-bf-card.is-negated-stamp fieldset.fud-bf-section.fud-bf-dmg > *:not(legend),
    .fud-bf-card.is-negated-stamp fieldset.fud-bf-section:has(> .fud-bf-target-list) > *:not(legend) {
      transition: filter 240ms ease-out;
    }
    .fud-bf-card.is-negated-stamp fieldset.fud-bf-section:has(> .fud-bf-acc)::after,
    .fud-bf-card.is-negated-stamp fieldset.fud-bf-section.fud-bf-dmg::after,
    .fud-bf-card.is-negated-stamp fieldset.fud-bf-section:has(> .fud-bf-target-list)::after {
      animation: fudNegatedStamp 200ms cubic-bezier(.3,.7,.4,1) both;
    }
    /* Stagger the three stamps top→bottom (accuracy → damage → result). */
    .fud-bf-card.is-negated-stamp fieldset.fud-bf-section.fud-bf-dmg::after {
      animation-delay: 110ms;
    }
    .fud-bf-card.is-negated-stamp fieldset.fud-bf-section:has(> .fud-bf-target-list)::after {
      animation-delay: 220ms;
    }
    @keyframes fudNegatedStamp {
      0%   { opacity: 0; transform: translate(-50%, -50%) scale(1.8); }
      55%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
    /* Reaction Effect panel — chips listing the statuses/costs an applied
       reaction (Warning Shot, etc.) will inflict. */
    .fud-bf-card .fud-bf-reaction-effects .fud-bf-effect-chips {
      display: flex; flex-wrap: wrap; gap: 5px;
    }
    .fud-bf-card .fud-bf-effect-chip {
      display: inline-flex; align-items: center;
      padding: 2px 9px;
      border-radius: 11px;
      font-size: 11.5px; font-weight: 800;
      border: 1.5px solid var(--fud-stroke, #7a6a55);
      background: rgba(123, 90, 60, 0.12);
      color: var(--fud-ink, #3a3228);
    }
    .fud-bf-card .fud-bf-effect-chip.is-status {
      border-color: #9a3b8f;
      background: rgba(154, 59, 143, 0.16);
      color: #6e1f66;
    }
    .fud-bf-card .fud-bf-effect-chip.is-cost {
      border-color: #1e6cff;
      background: rgba(30, 108, 255, 0.14);
      color: #15489c;
    }

    /* ── Effect section: Action Keyword + status terms ──
       No pill badges — inline bold+underline text with a small icon prefix, so
       the terms read as part of the prose without eating its focus. Keywords
       sit in their own row at the top of the Effect section and add a stylized
       diamond bullet + accent tint to mark them as the card's headline rule.
       Both are clickable → open the explanation tooltip. */
    .fud-bf-card .fud-bf-keyword-row {
      display: flex; flex-wrap: wrap; gap: 3px 14px; margin-bottom: 7px;
    }
    .fud-bf-card .fud-kw-term {
      display: inline-flex; align-items: center; gap: 4px;
      cursor: pointer; user-select: none; vertical-align: text-bottom;
      transition: filter .1s ease, opacity .1s ease, transform .06s ease;
    }
    .fud-bf-card .fud-kw-term:active { transform: translateY(1px); }
    .fud-bf-card .fud-kw-term .fud-kw-term-icon {
      width: 15px; height: 15px; object-fit: contain;
      border: none; background: transparent; border-radius: 0; box-shadow: none;
      flex-shrink: 0;
    }
    .fud-bf-card .fud-kw-term .fud-kw-label {
      font-weight: 800; text-decoration: underline; text-underline-offset: 2px;
    }
    .fud-bf-card .fud-kw-term:hover .fud-kw-label { filter: brightness(1.18); opacity: .82; }
    /* Status term — reads in the prose ink color. */
    .fud-bf-card .fud-kw-term.is-status { color: var(--fud-ink, #3a3228); }
    /* Action keyword — uppercase accent text + diamond bullet prefix. */
    .fud-bf-card .fud-kw-term.is-keyword { color: #8a5a12; }
    .fud-bf-card .fud-kw-term.is-keyword .fud-kw-label {
      text-transform: uppercase; letter-spacing: .3px; font-size: 12px;
    }
    .fud-bf-card .fud-kw-term .fud-kw-bullet {
      color: #c98a2a; font-size: 9px; line-height: 1;
      transform: translateY(-1px); flex-shrink: 0;
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

    /* Running-number direction cues — set by animateCardNumber() after a
       reaction bumps/reduces Accuracy or Damage. An INCREASE rises into place
       with a bright over-shoot; a DECREASE drops in desaturated and settles
       smaller-first, so the two read apart at a glance without reading the
       value. Purely cosmetic + per-client (never baked into the broadcast). */
    .fud-bf-card .fud-bf-dmg-number.fud-num-up,
    .fud-bf-card .fud-bf-acc .total.fud-num-up,
    .fud-bf-card .fud-bf-target-row .t-result .t-num.fud-num-up {
      display: inline-block;
      animation: fud-num-up 0.42s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .fud-bf-card .fud-bf-dmg-number.fud-num-down,
    .fud-bf-card .fud-bf-acc .total.fud-num-down,
    .fud-bf-card .fud-bf-target-row .t-result .t-num.fud-num-down {
      display: inline-block;
      animation: fud-num-down 0.42s cubic-bezier(0.22, 1, 0.36, 1);
    }
    @keyframes fud-num-up {
      0%   { transform: translateY(6px)  scale(0.84); filter: brightness(1.75) saturate(1.4); }
      55%  { transform: translateY(-3px) scale(1.14); filter: brightness(1.2); }
      100% { transform: translateY(0)    scale(1);    filter: none; }
    }
    @keyframes fud-num-down {
      0%   { transform: translateY(-6px) scale(1.16); filter: saturate(0.3) brightness(0.82); }
      55%  { transform: translateY(3px)  scale(0.9);  filter: saturate(0.6); }
      100% { transform: translateY(0)    scale(1);    filter: none; }
    }

    /* Per-target result list */
    .fud-bf-card .fud-bf-target-list {
      display: flex; flex-direction: column; gap: 1px;
    }
    /* Two-row layout: name (row 1) + DEF (row 2) share the left column, and
       the result spans BOTH rows on the right so its number can run large. */
    .fud-bf-card .fud-bf-target-row {
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto;
      column-gap: 8px; row-gap: 0;
      align-items: center;
      padding: 4px 0;
      border-bottom: 1px dashed rgba(90, 106, 133, 0.28);
      font-size: 12px;
    }
    .fud-bf-card .fud-bf-target-row:last-child { border-bottom: none; }
    .fud-bf-card .fud-bf-target-row .t-name { grid-column: 1; grid-row: 1; font-weight: 700; align-self: end; }
    .fud-bf-card .fud-bf-target-row .t-def  { grid-column: 1; grid-row: 2; opacity: 0.6; font-size: 11px; align-self: start; }
    .fud-bf-card .fud-bf-target-row .t-result {
      grid-column: 2; grid-row: 1 / span 2;
      align-self: center; text-align: right;
      font-size: 12px; line-height: 1.05; white-space: nowrap;
    }
    /* The damage number is the headline — runs large; the verb (HIT/WEAK/…) and
       the optional MP unit sit smaller beside it. */
    .fud-bf-card .fud-bf-target-row .t-result .t-num  { font-size: 22px; font-weight: 900; vertical-align: -2px; margin-left: 2px; }
    .fud-bf-card .fud-bf-target-row .t-result .t-unit { font-size: 11px; opacity: 0.8; }
    .fud-bf-card .fud-bf-target-row .t-result.hit    { color: #2a6e3d; font-weight: 800; }
    .fud-bf-card .fud-bf-target-row .t-result.crit   { color: #b40000; font-weight: 900; }
    .fud-bf-card .fud-bf-target-row .t-result.miss   { color: #9a4a4a; }
    .fud-bf-card .fud-bf-target-row .t-result.absorb { color: #2a8a3a; font-weight: 800; }
    /* Vulnerable hit — glowing gold "WEAK", mirroring the Critical! float-banner
       (gold fill + dark stroke + bloom). Resisted hit — muted slate "RESIST". */
    .fud-bf-card .fud-bf-target-row .t-result.weak {
      color: #ffd34d; font-weight: 900; font-style: italic;
      -webkit-text-stroke: 0.9px rgba(90, 58, 18, 0.72);
      text-shadow:
        0 0 12px rgba(255, 207, 64, 0.7),
        0 0 6px rgba(255, 207, 64, 0.85),
        0 1px 0 #5a3a12;
    }
    .fud-bf-card .fud-bf-target-row .t-result.resist { color: #5a6a85; font-weight: 800; }
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

    /* Redirected target row — applied when a third-party reaction
       (Protect, Cover) moves the action's target slot to the reactor.
       Side-tint signals "this row was changed mid-card"; the small swap
       icon (🔄) marks the redirected target, with the original name on
       hover. Visual continuity with the third-party pill row (PC-blue
       accent). */
    .fud-bf-card .fud-bf-target-row.is-redirected {
      background: rgba(180, 215, 255, 0.18);
      border-left: 2px solid rgba(70, 120, 200, 0.65);
      padding-left: 6px;
      margin-left: -6px;
    }
    .fud-bf-card .fud-bf-target-row.is-redirected .t-redirect-from {
      font-size: 11px;
      opacity: 0.75;
      margin-left: 3px;
      cursor: help;
    }

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
      box-sizing: border-box;
      /* Consistent pill height across pending↔resolved: the Apply/Skip buttons
         make a pending pill the tallest, and swapping them for the short status
         chip would otherwise shrink the pill (and the whole card). min-height
         floors every pill at that button-state height so applying a reaction
         doesn't change the card size. */
      min-height: 34px;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.55);
      border-radius: 6px;
      border: 1px solid rgba(120, 80, 200, 0.25);
    }
    /* Applied stays at full opacity — the reaction is in effect, so it
       should read as live information on the card. Skipped fades to
       0.55 so the player can quickly scan resolved-but-irrelevant
       pills. */
    .fud-bf-card .fud-bf-reaction-pill.is-applied {
      background: rgba(140, 220, 130, 0.30);
      border-color: rgba(60, 140, 60, 0.55);
    }
    .fud-bf-card .fud-bf-reaction-pill.is-skipped {
      background: rgba(220, 220, 220, 0.40);
      border-color: rgba(140, 140, 140, 0.45);
      opacity: 0.55;
    }
    /* A verdict the GM set by hand, forced or suppressed. Marked with the gold
       stroke the editor's own surfaces use, and — because a suppressed reaction
       must stay legible as a deliberate call — WITHOUT the skipped fade. The
       chip beside it already says Forced / Suppressed; this is what makes the
       pill scannable as "someone overruled the card" at a glance. */
    .fud-bf-card .fud-bf-reaction-pill.is-gm-set {
      opacity: 1;
      border-color: var(--fud-gold-2, #b7935a);
      box-shadow: inset 0 0 0 1px rgba(183, 147, 90, 0.55);
    }
    /* Suppressed keeps the neutral grey ground of a skipped pill but not its
       fade, so force (green) and suppress (grey) still read apart. */
    .fud-bf-card .fud-bf-reaction-pill.is-gm-set.is-skipped {
      background: rgba(220, 220, 220, 0.40);
    }
    /* A forced candidate may be one the engine dimmed as unaffordable — the GM
       has overruled that, so it must stop rendering as non-interactive. */
    .fud-bf-card .fud-bf-reaction-pill.is-unavailable.is-gm-set {
      opacity: 1; filter: none;
    }
    /* Submitting — the owner clicked Apply/Skip and the GM is resolving it
       (possibly awaiting a secondary pick on this client). Dim + block the
       Apply/Skip buttons until the GM broadcasts the final state or a revert. */
    .fud-bf-card .fud-bf-reaction-pill.is-submitting .fud-bf-reaction-actions {
      opacity: 0.5;
      pointer-events: none;
    }
    /* Cost-unavailable reaction — surfaced but dimmed, non-interactive, with a
       reason badge ("Low IP") so the player sees why it can't be used. */
    /* Made moot by a GM target removal — it will not fire and will not bill.
       Struck through rather than merely greyed: "Skipped" is a decision somebody
       made, and this was not one. */
    .fud-bf-card .fud-bf-reaction-pill.is-moot {
      opacity: 0.55;
      filter: grayscale(0.6);
      border-style: dashed;
    }
    .fud-bf-card .fud-bf-reaction-pill.is-moot .fud-bf-reaction-carrier,
    .fud-bf-card .fud-bf-reaction-pill.is-moot .fud-bf-reaction-reactor {
      text-decoration: line-through;
    }
    .fud-bf-card .fud-bf-reaction-pill.is-unavailable {
      opacity: 0.5;
      filter: grayscale(0.6);
      pointer-events: none;
    }
    .fud-bf-card .fud-bf-reaction-pill.is-unavailable .fud-bf-reaction-reason {
      color: #9a4a4a;
      font-weight: 700;
      font-size: 11px;
      white-space: nowrap;
    }
    /* Third-party reactor pills — a reaction owned by someone other than
       the action-taker (Protect on Attack(ally) card). Reactor name
       prefix is rendered before the carrier name; pill border picks up
       a side-color so monster-side reactions are visually distinct from
       party-side reactions. is-applied / is-skipped overrides still
       win on resolution. */
    .fud-bf-card .fud-bf-reaction-pill.is-third-party.is-side-pc {
      background: rgba(180, 215, 255, 0.40);
      border-color: rgba(70, 120, 200, 0.55);
    }
    .fud-bf-card .fud-bf-reaction-pill.is-third-party.is-side-npc {
      background: rgba(255, 200, 175, 0.42);
      border-color: rgba(190, 90, 60, 0.65);
    }
    .fud-bf-card .fud-bf-reaction-pill.is-third-party .fud-bf-reaction-reactor {
      font-size: 9.5px;
      font-weight: 800;
      color: #2c1c5c;
      opacity: 0.85;
    }
    .fud-bf-card .fud-bf-reaction-pill.is-side-npc .fud-bf-reaction-reactor {
      color: #7a2c1c;
    }
    /* Cascade entrance — a reaction injected by the reactive re-derive (e.g.
       Bullet Break after Crossfire). Played as DISTINCT, separated stages
       (card grows → pill fades+moves in → glow), sequenced by JS with gaps so
       each piece reads on its own. Each stage is its own class/animation. */
    .fud-bf-card .fud-bf-reaction-pill.is-cascade-glow {
      animation: fudReactionCascadeGlow 1500ms ease-out both;
    }
    @keyframes fudReactionCascadeGlow {
      0%   { box-shadow: 0 0 0 0 rgba(255, 224, 60, 0); }
      22%  { box-shadow: 0 0 6px 1px rgba(255, 224, 60, 1); }
      100% { box-shadow: 0 0 0 0 rgba(255, 224, 60, 0); }
    }
    .fud-bf-card .fud-bf-reaction-icon {
      width: 18px; height: 18px;
      flex: 0 0 auto;
      border-radius: 4px;
      object-fit: cover;
      font-size: 14px; line-height: 18px; text-align: center;
    }
    /* Two-line name block: reactor on line 1, skill name on line 2. */
    .fud-bf-card .fud-bf-reaction-namewrap {
      display: flex; flex-direction: column; justify-content: center;
      flex: 1 1 auto; min-width: 0; gap: 1px; line-height: 1.15;
    }
    .fud-bf-card .fud-bf-reaction-name {
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
    /* Keep the reaction buttons COMPACT (shorter than the two-line name) so a
       pending pill (with Apply/Skip) and a resolved pill (status chip) are the
       same height — otherwise the base .fud-btn padding (defined later, so it
       wins at equal specificity) makes the buttons ~33px and the pill taller
       when pending, changing the card size on apply. Higher specificity wins. */
    .fud-bf-card .fud-bf-reaction-actions .fud-btn-reaction {
      padding: 2px 9px;
      font-size: 9.5px;
      line-height: 1.25;
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
       attribute holds the count; CSS only needs to know "is there one".
       The "resolve reactions first" hint is OVERLAID on the Confirm button
       (its label hidden) rather than appended below the card, so the card
       height stays constant when the hint appears/disappears. */
    .fud-bf-card[data-fud-reactions-pending] .fud-btn-confirm {
      opacity: 0.45 !important;          /* previous faded look */
      pointer-events: none !important;
      cursor: not-allowed !important;
      filter: grayscale(0.4);
      color: transparent !important;     /* hide "Confirm"; hint overlays the row */
    }
    /* Hint is overlaid on the Confirm BUTTON'S ROW (not the button) so it renders
       at full opacity (the button itself is faded) and adds no card height. */
    .fud-bf-card .fud-bf-btn-row:has(> .fud-btn-confirm) { position: relative; }
    .fud-bf-card[data-fud-reactions-pending] .fud-bf-btn-row:has(> .fud-btn-confirm)::after {
      content: "Resolve reactions first";
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 800; font-style: italic;
      letter-spacing: 0.3px; text-transform: none;
      color: #4a2f87;
      pointer-events: none;
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

    /* ── Auto-confirm veto strip (Summon Autopilot) ─────────────────────────
       Sits directly above the button row: a thin draining bar plus a one-line
       explanation of why nobody has to click. The bar is a CSS animation so it
       runs on the player mirror too; it PAUSES while any reaction pill is
       undecided (same attribute that locks Confirm), which is exactly when the
       GM-side timer pauses. The is-vetoed class is stamped the moment a human
       touches the card — bar frozen, wording flipped to "held".
       (NO BACKTICKS IN HERE — this comment lives inside a template literal, so a
       backticked identifier ends the string and the rest parses as arbitrary
       JS. It cost a silent throw out of ensureStyles, which left EVERY action
       card unstyled while every behavioural test still passed.) */
    .fud-bf-card .fud-bf-veto {
      position: relative;
      margin-top: 8px;
      padding: 5px 8px 6px;
      border: 1px solid rgba(120, 80, 200, 0.45);
      border-radius: 5px;
      background: rgba(120, 80, 200, 0.10);
      overflow: hidden;
    }
    .fud-bf-card .fud-bf-veto-bar {
      position: absolute; left: 0; top: 0; bottom: 0;
      width: 100%;
      background: rgba(120, 80, 200, 0.22);
      transform-origin: left center;
      animation-name: fud-bf-veto-drain;
      animation-timing-function: linear;
      animation-fill-mode: forwards;
      pointer-events: none;
    }
    @keyframes fud-bf-veto-drain {
      from { transform: scaleX(1); }
      to   { transform: scaleX(0); }
    }
    /* Undecided reaction pill → Confirm is locked, so the countdown must not
       run down behind the lock. Same attribute, same pause, every client. */
    .fud-bf-card[data-fud-reactions-pending] .fud-bf-veto-bar {
      animation-play-state: paused;
    }
    .fud-bf-card .fud-bf-veto-text {
      position: relative;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      font-size: 11px; font-weight: 700; font-style: italic;
      letter-spacing: 0.2px;
      color: #4a2f87;
    }
    .fud-bf-card .fud-bf-veto-count { opacity: 0.85; white-space: nowrap; }
    .fud-bf-card .fud-bf-veto.is-vetoed { border-color: rgba(90, 90, 90, 0.45); background: rgba(0, 0, 0, 0.06); }
    .fud-bf-card .fud-bf-veto.is-vetoed .fud-bf-veto-bar { animation-play-state: paused; opacity: 0.25; }
    .fud-bf-card .fud-bf-veto.is-vetoed .fud-bf-veto-text { color: #4a4a4a; }

    /* Buttons row */
    .fud-bf-card .fud-bf-btn-row {
      display: flex; align-items: center; gap: 6px;
      margin-top: 10px; flex-wrap: wrap;
    }
    .fud-bf-card .fud-btn {
      flex: 1 1 auto; min-width: 0;
      padding: 8px 10px;
      border-radius: 8px;
      border: 2px solid var(--fud-stroke, #7a6a55);
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
      background: linear-gradient(180deg, var(--fud-gold-1, #d5b67a), var(--fud-gold-2, #b7935a));
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

    /* Equipment card — "Open Character Sheet" affordance. Visual cousin of
       the cancel button (neutral parchment), since clicking it doesn't
       commit the action — it just launches the sheet. */
    .fud-bf-card .fud-btn-open-sheet {
      display: inline-flex;
      align-items: center;
      padding: 8px 14px;
      border-radius: 8px;
      border: 2px solid var(--fud-stroke, #7a6a55);
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
    /* Transform — weapon-form chip row. Same parchment/gold language as the
       equip dropdowns; the active form is filled gold, others outlined. */
    .fud-bf-card .fud-bf-form-row {
      display: flex; flex-direction: column; gap: 5px;
      padding: 6px 0;
      border-bottom: 1px dashed rgba(90, 106, 133, 0.25);
    }
    .fud-bf-card .fud-bf-form-row:last-child { border-bottom: none; }
    /* Full-width segmented control: each form takes an equal share of the row. */
    .fud-bf-card .fud-bf-form-chips { display: flex; gap: 6px; width: 100%; }
    .fud-bf-card .fud-bf-form-chip {
      flex: 1 1 0; min-width: 0;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1.5px solid var(--fud-stroke, #7a6a55);
      background: rgba(255, 255, 255, 0.65);
      color: var(--fud-ink, #3a3228);
      font-size: 12px; font-weight: 700; text-align: center;
      cursor: pointer; user-select: none;
      transition: background-color 100ms ease, border-color 100ms ease, color 100ms ease;
    }
    .fud-bf-card .fud-bf-form-chip .fud-bf-form-label {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fud-bf-card .fud-bf-form-chip:hover { background: rgba(255, 255, 255, 0.9); border-color: var(--fud-gold-2, #b7935a); }
    .fud-bf-card .fud-bf-form-chip.is-active {
      background: var(--fud-gold-2, #b7935a);
      border-color: var(--fud-gold-2, #b7935a);
      color: #2b2114;
      box-shadow: 0 0 6px rgba(183, 147, 90, 0.4);
    }
    /* Equipment Done-button economy indicator — tells the player whether the
       current selection is a FREE action (returns to menu) or costs the turn. */
    .fud-bf-card .fud-bf-equip-econ {
      display: flex; justify-content: center; margin: 2px 0 6px;
    }
    .fud-bf-card .fud-bf-equip-free-ind {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 11px;
      border-radius: 999px;
      font-size: 11px; font-weight: 800; letter-spacing: 0.2px;
      border: 1.5px solid transparent;
    }
    .fud-bf-card .fud-bf-equip-free-ind.is-free {
      color: #1f6b32; background: rgba(64, 168, 88, 0.16); border-color: rgba(64, 168, 88, 0.55);
    }
    .fud-bf-card .fud-bf-equip-free-ind.is-paid {
      color: #8a4b22; background: rgba(216, 167, 58, 0.16); border-color: rgba(216, 167, 58, 0.55);
    }
    .fud-bf-card .fud-bf-equip-free-ind.is-none {
      color: var(--fud-ink-soft, #6b6253); background: rgba(120, 110, 90, 0.1); border-color: rgba(120, 110, 90, 0.3);
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
      border: 1.5px solid var(--fud-stroke, #7a6a55);
      background: rgba(255, 255, 255, 0.65);
      color: var(--fud-ink, #3a3228);
      cursor: pointer;
      user-select: none;
      transition: background-color 100ms ease, border-color 100ms ease;
    }
    .fud-bf-card .fud-bf-equip-trigger:hover { background: rgba(255, 255, 255, 0.85); }
    .fud-bf-card .fud-bf-equip-trigger:focus,
    .fud-bf-card .fud-bf-equip-row.is-open .fud-bf-equip-trigger {
      outline: 2px solid var(--fud-gold-2, #b7935a);
      outline-offset: -1px;
      border-color: var(--fud-gold-2, #b7935a);
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
      border: 1.5px solid var(--fud-stroke, #7a6a55);
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
      background: rgba(213, 182, 122, 0.28);
      box-shadow: inset 0 0 0 1px var(--fud-gold-2, #b7935a);
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
      border: 1.5px solid var(--fud-stroke, #7a6a55);
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
      border-color: var(--fud-gold-2, #b7935a);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.4), 0 2px 0 rgba(41,33,24,.25);
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
      border: 1.5px solid var(--fud-stroke, #7a6a55);
      background: rgba(255, 255, 255, 0.55);
      cursor: pointer;
      transition: background-color 100ms ease, transform 80ms ease;
    }
    .fud-bf-card .fud-bf-item-row:hover { background: rgba(255, 255, 255, 0.85); }
    .fud-bf-card .fud-bf-item-row.is-selected {
      background: linear-gradient(180deg, #fff0bd, #e4bf78);
      border-color: var(--fud-gold-2, #b7935a);
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
      border: 1.5px solid var(--fud-stroke, #7a6a55);
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
      background: rgba(122, 106, 85, 0.18);
      color: var(--fud-stroke, #7a6a55);
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

    /* ── GM edit surface (gm-card-override.js) ─────────────────────────────
       Emitted LAST on purpose. These rules override established card styling
       (target rows, buttons), and the sheet is one string: at equal specificity
       source order decides. Sitting first, .fud-gm-edit-card's width lost to
       .fud-bf-card and the hand-set row tint lost to .t-result.hit|miss|…,
       so both silently did nothing.

       Colours come from the card's own tokens (--fud-gold-1/2, --fud-stroke,
       --fud-ink-soft) and its white-over-parchment surface idiom, rather than a
       parallel amber set. */

    /* Launch button — a pill DOCKED on the header's bottom rule, right-aligned
       to the same 16px gutter the fieldsets use. It sits ON a real structural
       edge instead of floating in the gap between the subtitle and the first
       panel, which is what made the old placement read as a sticker.
       GM cards RESERVE the band it occupies (below), so it overlaps nothing. */
    .fud-bf-card .fud-bf-header { position: relative; }
    /* It sits BELOW the rule, never across it, and moves nothing.
       Measured on a live card: the rule ends 85px down and the first fieldset
       starts at 113px, so the subtitle band is 28px of clear space — enough for
       the pill with 2px top and bottom. An earlier attempt straddled the rule
       and bought room by growing the header's bottom margin; both were wrong.
       The rule is a structural edge, not a shelf, and a utility control has no
       business moving the card's layout to make space for itself. */
    .fud-bf-card .fud-gm-launch {
      /* right:0 is the HEADER's padding edge, which lands the pill's right edge
         on exactly the same 16px gutter every fieldset uses — measured, not
         guessed. At right:9px it sat further in than the panels below it, which
         is what made an otherwise tidy control read as applied rather than
         attached. bottom:-30px clears the 2px rule by 2px and leaves 2px above
         the first fieldset: entirely inside the subtitle band, touching neither. */
      position: absolute; right: 0; bottom: -30px;
      width: auto; height: 24px; padding: 0 5px; margin: 0; gap: 5px;
      display: flex; align-items: center; justify-content: center;
      /* Translucent white over the parchment — the card's own raised-chip idiom
         (the same wash the launch button always used), NOT a flat fill. A flat
         parchment would match the card body and the pill would vanish into it;
         a named token would be worse still, since the only parchment tokens
         here are --fud-parchment / -top / -bot and this is not one of them. */
      background: rgba(255, 255, 255, 0.62);
      border: 1px solid var(--fud-stroke, #7a6a55);
      border-radius: 999px; cursor: pointer; z-index: 3;
      color: var(--fud-ink-soft, #4b4338); line-height: 1; font-size: 12px;
      box-sizing: border-box;
      /* Lifts it off the rule it straddles, so the pill reads as sitting on
         the card rather than being cut out of it. */
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.10);
      transition: background 120ms ease, color 120ms ease, filter 120ms ease;
    }
    /* The glyph carries Font Awesome's own line-height and a trailing advance,
       which pushed it up-left of the button's centre. Neutralise both and let
       flex centring do the work. */
    .fud-bf-card .fud-gm-launch > i {
      display: block; line-height: 1; width: auto; margin: 0; font-size: 12px;
    }
    /* Hover deepens what is already there rather than switching palette — the
       old hover painted the gold gradient, so an ALREADY-edited pill changed
       identity under the cursor instead of merely responding.
       The CLEAN hover is deliberately NEUTRAL (whiter, not warmer): the first
       attempt at this used a warm parchment that measured within 4/255 of the
       active fill, so hovering an unedited pill made it look edited — the same
       bug the other way round. */
    .fud-bf-card .fud-gm-launch:hover {
      background: rgba(255, 255, 255, 0.92);
      color: #2f2716;
      border-color: #5f5342;
    }
    .fud-bf-card .fud-gm-launch.is-active:hover {
      background: linear-gradient(180deg, #f6e9c2, #ddc48e);
    }
    /* --fud-gold-2 measures 2.50:1 on this parchment — under WCAG 1.4.11's 3:1
       for a non-text indicator, and with outline-offset the ring lands on
       parchment on three sides. The card's own stroke is 4.63:1 and is already
       this pill's border colour. */
    .fud-bf-card .fud-gm-launch:focus-visible {
      outline: 2px solid var(--fud-stroke, #7a6a55); outline-offset: 2px;
    }
    /* Carries an override — the card's OWN amber rail, the same marker already
       used on an edited fieldset (.fud-bf-section.is-gm-edited) and an edited
       target row, so the button and the things it changed read as one family.
       It used to be a full gold gradient: identical weight to CONFIRM, on a
       control that is not the card's decision. The count stays as a second,
       non-hue signal for a greyscale or colour-blind read. */
    .fud-bf-card .fud-gm-launch.is-active {
      background: linear-gradient(180deg, #f2e5c6, #e4d1a3);
      color: #8a4b22;
      /* A BORDER, not an inset rail. The fieldset/target-row rails this wanted
         kinship with are inset 3px 0 0 on a square edge; on a 999px radius
         the same shadow survives only as a ~2px crescent that reads as a dark
         left edge, not a rail — so it was claiming a relationship it could not
         actually draw. The hue (#8a4b22, the "GM SET" legend colour) carries
         the kinship instead, and the fill and the count do the real work. */
      border-color: #8a4b22;
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.10);
    }
    /* INSIDE the pill. As a corner badge on a control sitting 9px from the card
       edge it was clipped by the card's own border — the count was the half of
       the state that does not depend on hue, and it was the half being cut off. */
    .fud-bf-card .fud-gm-launch-dot {
      font-size: 10px; font-weight: 800; line-height: 1;
      color: #8a4b22; font-variant-numeric: tabular-nums;
    }
    /* The pill shares the subtitle's band, so long text needs keeping out from
       under it — on BOTH sides, or the text stops being centred on the card.
       Gated on the button actually being present: the rule used to be
       unconditional, so every player paid 2×38px of a 288px line to reserve
       space for a control their DOM does not contain (the mirror strips it).
       38px is the value that shipped, kept exactly: the pill's padding was
       trimmed to 5px so the widest it gets — icon, gap, two-digit count — still
       clears the text, rather than widening the gutter to fit the pill. */
    .fud-bf-card:has(.fud-gm-launch) .fud-bf-subtitle {
      padding-left: 38px; padding-right: 38px;
    }
    /* THE ONE EXCEPTION, and it is stated rather than hidden: a card with no
       subtitle at all (unknown-kind, composition-failure — buildSubtitleHTML
       returns "" when there is no weapon) has only the header's 8px margin
       between the rule and the first fieldset, so there is no band to sit in
       and the pill would draw straight through that fieldset's rounded corner.
       Those cards, and only those, get the room made for them. Every card that
       HAS a subtitle is untouched. */
    .fud-bf-card:has(.fud-gm-launch):not(:has(> .fud-bf-subtitle)) .fud-bf-header {
      margin-bottom: 30px;
    }

    /* Editor card — its own overlay, above the action card it edits. */
    #fud-gm-edit-card-root {
      position: fixed; inset: 0; z-index: 120;
      display: flex; align-items: center; justify-content: center;
      background: rgba(24, 28, 41, 0.32);
      opacity: 0; pointer-events: none;
      transition: opacity 160ms ease-out;
    }
    #fud-gm-edit-card-root.is-visible { opacity: 1; pointer-events: auto; }
    .fud-bf-card.fud-gm-edit-card {
      width: min(384px, calc(100vw - 20px));
      /* dvh, with vh kept above it as the fallback for engines without it:
         100vh is the WRONG viewport on a phone, where browser chrome overlays
         it and the footer — Save and Cancel — sits below the fold. */
      max-height: calc(100vh - 24px);
      max-height: calc(100dvh - 24px);
      display: flex; flex-direction: column;
      transform: scale(0.96);
      transition: transform 160ms cubic-bezier(.2,.7,.2,1);
    }
    #fud-gm-edit-card-root.is-visible .fud-gm-edit-card { transform: scale(1); }
    .fud-gm-edit-head {
      padding: 11px 14px 9px;
      border-bottom: 2px solid var(--fud-stroke, #7a6a55);
      display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    }
    .fud-gm-edit-title {
      flex: 1 1 100%; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase;
      font-size: 9.5px; color: #5c5344;
    }
    .fud-gm-edit-sub { font-size: 13px; font-weight: 800; color: var(--fud-ink, #3a3228); }
    .fud-gm-edit-body { padding: 9px 12px; overflow-y: auto; flex: 1 1 auto; }

    /* Sections mirror fieldset.fud-bf-section exactly — same border, radius,
       wash and legend weight — so the editor reads as the same furniture as the
       card it edits. */
    .fud-gm-edit-card fieldset.fud-gm-sec {
      border: 1px solid var(--fud-stroke, #7a6a55);
      border-radius: 8px;
      padding: 4px 9px 8px;
      margin: 0 0 7px 0;
      background: rgba(255, 255, 255, 0.20);
    }
    .fud-gm-edit-card fieldset.fud-gm-sec legend {
      padding: 0 5px;
      font-size: 10.5px; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase;
      color: var(--fud-ink-soft, #4b4338);
    }
    /* ROW layout. Each line reads "<what> <is now> adjust by [ ]", so the eye
       runs down a single column of inputs. The previous uniform 2-column grid
       gave twelve controls the same weight and the same shouty uppercase label,
       which is what made the panel hard to read at a glance. */
    .fud-gm-row { display: flex; align-items: center; gap: 7px; padding: 3px 0; min-width: 0; }
    /* THREE typographic levels, which is what the panel was missing. Legends
       stay uppercase/800 (group). Field names are sentence case at reading
       weight (which field) — as uppercase 800 they were indistinguishable from
       the legends and eleven of them stacked down the left edge was the actual
       clutter. Connectors (below) carry the semantics and get real weight. */
    .fud-gm-rl {
      flex: 0 0 44px; font-size: 11px; font-weight: 600; letter-spacing: 0;
      color: var(--fud-ink-soft, #4b4338);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* The action's current value — a fact to read, so it is plain text rather
       than a boxed field that would invite a click. */
    .fud-gm-now {
      flex: 0 0 auto; min-width: 26px; text-align: right;
      font-weight: 800; font-size: 12.5px; font-variant-numeric: tabular-nums;
      color: var(--fud-ink, #3a3228);
    }
    /* The CONNECTOR is the only thing on the row telling the GM whether their
       number replaces ("shows") or adds ("adjust by"). It was 9.5px at 60%
       opacity — the faintest text in the dialog carrying the whole semantic.
       Colour is set directly rather than via opacity, which drags foreground
       and background together and is why every de-emphasised string here fell
       under AA. */
    .fud-gm-sep {
      flex: 1 1 auto; text-align: right; font-size: 10.5px;
      color: #5c5344; white-space: nowrap;
    }
    .fud-gm-sep.is-verb { font-weight: 700; color: #4b4338; }
    .fud-gm-edit-card .fud-gm-row .fud-gm-num { flex: 0 0 58px; width: 58px; min-width: 58px; }
    .fud-gm-edit-card .fud-gm-row .fud-gm-die { flex: 0 0 88px; width: 88px; min-width: 88px; }
    .fud-gm-types { padding-top: 6px; margin-top: 2px; border-top: 1px dashed var(--fud-stroke, #7a6a55); }
    .fud-gm-edit-card .fud-gm-types .fud-gm-sel { flex: 1 1 0; width: auto; min-width: 0; }
    .fud-gm-check { gap: 8px; }
    .fud-gm-check > span { font-size: 11px; color: var(--fud-ink, #3a3228); }
    /* Target rows keep a small grid — three genuinely parallel fields. */
    .fud-gm-grid { display: grid; grid-template-columns: 1.35fr 1fr 1fr; gap: 6px; }
    .fud-gm-f { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .fud-gm-f > span {
      font-size: 11px; font-weight: 600; color: var(--fud-ink-soft, #4b4338);
    }

    /* Controls. Scoped + pinned: Foundry's own input/select styling outranks a
       bare single-class selector, so an unscoped width loses and every control
       stretches full-width. White-over-parchment wells to match the card. */
    .fud-gm-edit-card .fud-gm-num,
    .fud-gm-edit-card .fud-gm-sel {
      width: 100%; min-width: 0; height: 25px; margin: 0;
      padding: 1px 6px; font-size: 12px; line-height: 21px;
      font-family: inherit;
      background: rgba(255, 255, 255, 0.55);
      color: var(--fud-ink, #3a3228);
      border: 1px solid var(--fud-stroke, #7a6a55); border-radius: 6px;
    }
    .fud-gm-edit-card .fud-gm-num {
      text-align: right; font-variant-numeric: tabular-nums;
      appearance: textfield; -moz-appearance: textfield;
    }
    .fud-gm-edit-card .fud-gm-num::-webkit-outer-spin-button,
    .fud-gm-edit-card .fud-gm-num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    /* The placeholder is NOT decorative hint text — it is the engine's own
       number, which the footnote tells the GM to read. It has to clear contrast
       like body text, not sit at a hint's 2:1. */
    .fud-gm-edit-card .fud-gm-num::placeholder {
      color: #5a5145; opacity: 1; font-style: italic;
    }
    .fud-gm-edit-card .fud-gm-num:focus-visible,
    .fud-gm-edit-card .fud-gm-sel:focus-visible {
      outline: 2px solid var(--fud-gold-2, #b7935a); outline-offset: 1px;
    }
    /* Authored — driven by an explicit class, NOT :placeholder-shown. The
       pseudo-class marks a field amber whenever its placeholder is empty (a
       target with no known DEF), and can never mark a <select>, so a changed
       die size looked untouched. */
    .fud-gm-edit-card .fud-gm-num.is-edited,
    .fud-gm-edit-card .fud-gm-sel.is-edited {
      border-color: var(--fud-gold-2, #b7935a);
      background: rgba(213, 182, 122, 0.30);
      font-weight: 700;
    }
    /* Foundry core styles select:focus with an orange-red glow, which made the
       auto-focused first field look like an error in a gold/parchment dialog.
       Keyed on :focus (not :focus-visible) because core is. */
    .fud-gm-edit-card .fud-gm-num:focus,
    .fud-gm-edit-card .fud-gm-sel:focus { box-shadow: none; }
    /* The HR toggle is the one override with no typed value to look at, so it
       needs its own authored marker — the class was toggled but nothing matched. */
    .fud-gm-edit-card .fud-gm-check.is-edited > span {
      font-weight: 800; color: #6b5314;
    }
    .fud-gm-edit-card .fud-gm-check.is-edited > span::after {
      content: " · changed"; font-size: 9.5px; font-weight: 700; color: #8a4b22;
    }
    /* A changed <select> is otherwise signalled by fill alone — lost in
       greyscale or a deuteranopic read. */
    .fud-gm-edit-card .fud-gm-sel.is-edited {
      box-shadow: inset 3px 0 0 #8a4b22;
    }
    .fud-gm-edit-card input[type="checkbox"] {
      width: 16px; height: 16px; margin: 0; flex: 0 0 auto;
      accent-color: var(--fud-gold-2, #b7935a);
    }
    /* The ANSWER — what the typed inputs actually produce. Given a box and real
       weight because it is the one line the GM is working towards; as plain
       small grey text it disappeared under the controls that feed it. */
    .fud-gm-derived {
      margin: 7px 0 0; padding: 5px 8px;
      font-size: 11.5px; font-weight: 700; text-align: center;
      font-variant-numeric: tabular-nums;
      color: var(--fud-ink, #3a3228);
      background: rgba(0, 0, 0, 0.05);
      box-shadow: inset 0 1px 0 rgba(0, 0, 0, 0.07); border-radius: 6px;
    }
    /* Crit / fumble use the CARD's own verdict colour, so the same event does
       not read as two different things one screen apart. */
    .fud-gm-derived.is-crit   { color: #b40000; background: rgba(180, 0, 0, 0.08); }
    .fud-gm-derived.is-fumble { color: #1f1f1f; background: rgba(31, 31, 31, 0.08); }
    /* ── Target list ────────────────────────────────────────────────────────
       ONE list showing the RESULTING target set — the action's own targets and
       anything the GM added, in the same idiom, each removable the same way,
       with the picker at the foot of the list it feeds. */
    .fud-gm-trow { padding: 6px 0 2px; }
    .fud-gm-trow + .fud-gm-trow { border-top: 1px solid var(--fud-stroke, #7a6a55); }
    .fud-gm-thead {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      margin-bottom: 5px;
    }
    .fud-gm-tname {
      flex: 1 1 auto; min-width: 0;
      font-size: 11px; font-weight: 800;
      color: var(--fud-ink, #3a3228);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* Provenance. The editor previously gave no sign at all which targets it had
       put there — after Save a GM-added creature was indistinguishable from one
       the action had always carried. */
    .fud-gm-tbadge {
      flex: 0 0 auto;
      font-size: 8.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase;
      padding: 1px 5px; border-radius: 999px;
      background: rgba(213, 182, 122, 0.5);
      border: 1px solid var(--fud-gold-2, #b7935a); color: #5c4514;
    }
    /* Says in words what the strike-through says in styling. text-decoration
       alone survives neither a greyscale read nor a screen reader. */
    .fud-gm-tcut {
      flex: 0 0 auto; font-size: 9.5px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .03em; color: #8a2b1e;
    }
    .fud-gm-tcut:empty { display: none; }
    /* One-click Remove, not a checkbox with a label beside it. Two kinds of row
       now sit in ONE list, and a checkbox cannot express "discard this pending
       add" and "stage a deletion" as the same gesture. The row carries the
       state; the button says what pressing it does NEXT. */
    .fud-gm-edit-card .fud-gm-tdrop {
      flex: 0 0 auto; width: auto; margin: 0;
      padding: 2px 8px; height: 22px; line-height: 1;
      font-size: 10px; font-weight: 700; font-family: inherit;
      text-transform: uppercase; letter-spacing: .03em;
      background: rgba(255, 255, 255, 0.5); color: #8a2b1e;
      border: 1px solid #a8503f; border-radius: 6px; cursor: pointer;
    }
    .fud-gm-edit-card .fud-gm-tdrop:hover { background: #f3e3de; }
    .fud-gm-edit-card .fud-gm-tdrop:focus-visible {
      outline: 2px solid var(--fud-gold-2, #b7935a); outline-offset: 1px;
    }
    /* Restore is not destructive, so it stops wearing destructive colour. */
    .fud-gm-trow.is-cut .fud-gm-tdrop { color: #4b4338; border-color: var(--fud-stroke, #7a6a55); }
    /* The last surviving target cannot be removed — an action with no targets
       leaves the card painted with rows it is no longer resolving. Shown as
       muted-but-LIVE, never truly disabled: the click is what delivers the reason,
       and a dead button delivered nothing. */
    .fud-gm-edit-card .fud-gm-tdrop[disabled],
    .fud-gm-edit-card .fud-gm-tdrop[data-fud-gm-blocked="1"] {
      opacity: .45; color: #4b4338; border-color: var(--fud-stroke, #7a6a55);
    }
    .fud-gm-edit-card .fud-gm-tdrop[disabled]:hover { background: rgba(255, 255, 255, 0.5); }
    .fud-gm-edit-card .fud-gm-tdrop[data-fud-gm-blocked="1"]:hover { background: #f6efe4; }
    /* A staged add has no engine numbers yet, so it says what will happen rather
       than showing three empty boxes that look editable. */
    .fud-gm-tnote {
      margin: 0 0 4px; font-size: 10px; line-height: 1.4;
      color: var(--fud-ink-soft, #4b4338);
    }
    /* The empty-action warning, standing in the section rather than hiding in a
       tooltip. Turns emphatic once the action actually has no targets. */
    .fud-gm-tblock.is-empty-now {
      border-color: #a8503f; background: #f7e9e4;
    }
    .fud-gm-tblock {
      padding: 4px 6px; border-radius: 5px;
      border: 1px solid var(--fud-stroke, #7a6a55);
      background: rgba(255, 255, 255, 0.45);
    }
    .fud-gm-tblock[hidden] { display: none; }
    .fud-gm-tblock.is-flash { animation: fud-gm-tblock-flash 900ms ease-out 1; }
    @keyframes fud-gm-tblock-flash {
      0%   { background: #f3e3de; border-color: #a8503f; }
      100% { background: rgba(255, 255, 255, 0.45); border-color: var(--fud-stroke, #7a6a55); }
    }
    @media (prefers-reduced-motion: reduce) {
      .fud-gm-tblock.is-flash { animation: none; border-color: #a8503f; }
    }
    /* The picker is part of the list, not a neighbouring section — it sits under
       the rows it appends to, behind a dashed rule. */
    .fud-gm-addrow {
      display: flex; align-items: center; gap: 7px;
      margin-top: 6px; padding-top: 7px;
      border-top: 1px dashed var(--fud-stroke, #7a6a55);
    }
    .fud-gm-addrow.is-empty { display: none; }
    .fud-gm-edit-card .fud-gm-addrow .fud-gm-sel { flex: 1 1 0; width: auto; min-width: 0; }
    .fud-gm-edit-card .fud-gm-addbtn {
      flex: 0 0 auto; width: auto; margin: 0;
      padding: 4px 11px; font-size: 10px; min-height: 25px;
      background: linear-gradient(180deg, #e5d6c5, #c9b294);
      color: var(--fud-ink, #3a3228);
    }
    .fud-gm-edit-card .fud-gm-addbtn[disabled] {
      opacity: .4; cursor: not-allowed; filter: grayscale(0.5);
    }
    .fud-gm-edit-card .fud-gm-addbtn[disabled]:hover { transform: none; filter: grayscale(0.5); }
    /* Membership changes announce here, with the resulting COUNT — the number
       the GM is actually deciding, and the one thing a list of rows never says
       out loud. Also the screen-reader channel for a row that appears or
       vanishes without focus moving to it. */
    .fud-gm-tlive {
      margin: 5px 0 0; font-size: 10px; font-weight: 700;
      color: var(--fud-ink-soft, #4b4338);
    }
    .fud-gm-tlive:empty { display: none; }
    /* Result needs more room than the two numeric fields — at even thirds
       "Auto (engine)" truncated inside its select. */
    .fud-gm-trow .fud-gm-grid { grid-template-columns: 1.35fr 1fr 1fr; }
    /* Reaction rows: name on the left, one verdict select on the right. Laid out
       like the accuracy rows (name → control) rather than the target grid — there
       is a single control, so a grid would leave two empty columns. */
    /* 132px, not 108: "Keep — applied" is the label that tells the GM what the
       card is CURRENTLY doing, and at 108 it truncated to "Keep — appl…" — the
       exact failure the target-row grid above already carries a note about. The
       name column absorbs it because reaction names wrap. */
    .fud-gm-rxrow {
      display: grid; grid-template-columns: 1fr 132px; gap: 8px;
      align-items: center; padding: 5px 0;
    }
    .fud-gm-rxrow + .fud-gm-rxrow { border-top: 1px solid var(--fud-stroke, #7a6a55); }
    /* A target staged for removal is struck through and dimmed — its numeric
       fields stay editable but plainly no longer matter. */
    .fud-gm-trow.is-cut .fud-gm-tname { text-decoration: line-through; }
    .fud-gm-trow.is-cut .fud-gm-grid { opacity: .45; }
    .fud-gm-rxrow .fud-gm-tname { white-space: normal; }
    /* Reactor name above the skill, matching the pill's own two-line name block
       so a third-party reaction is identified the same way in both places. */
    .fud-gm-rx-who {
      display: block; font-size: 9px; font-weight: 700; letter-spacing: .04em;
      text-transform: uppercase; opacity: .75;
    }
    /* The reason a candidate is unaffordable. Kept quiet — it is a caveat on a
       choice the GM is still allowed to make, not a warning against making it. */
    .fud-gm-rx-why {
      display: block; font-size: 10px; font-weight: 600;
      color: var(--fud-ink-soft, #4b4338); opacity: .8;
    }
    .fud-gm-note {
      margin: 6px 0 0; font-size: 11px; line-height: 1.5;
      color: var(--fud-ink-soft, #4b4338);
    }
    .fud-gm-note em { font-style: normal; font-weight: 800; opacity: 1; }
    .fud-gm-edit-foot {
      display: flex; flex-wrap: wrap; gap: 7px; padding: 9px 12px 11px;
      border-top: 2px solid var(--fud-stroke, #7a6a55);
    }
    /* Footer reuses the card's own .fud-btn idiom (see .fud-bf-card .fud-btn) —
       same radius, stroke, lift and uppercase weight — instead of a parallel
       button style. Only the flex split is local. */
    /* Explicit percentage bases rather than auto: with an auto basis the two
       shared a row only until a label grew, then each claimed a full row.
       Percentages keep the Cancel/Save pair side by side at every width. Save
       leads (order 0) so the primary sits where the card's own CONFIRM does. */
    /* Shorter than the action card's own buttons: those are the turn's decision
       and earn the height, while these close a utility dialog. */
    .fud-gm-edit-card .fud-btn { padding: 6px 10px; font-size: 11px; }
    .fud-gm-edit-card .fud-btn-save {
      order: 0; flex: 1 1 56%;
      background: linear-gradient(180deg, var(--fud-gold-1, #d5b67a), var(--fud-gold-2, #b7935a));
      color: #221b14;
    }
    .fud-gm-edit-card .fud-btn-back {
      order: 1; flex: 1 1 34%;
      background: linear-gradient(180deg, #e5d6c5, #c9b294);
      color: var(--fud-ink, #3a3228);
    }
    /* Destructive, and it COMMITS (wipes every override for the table). Given
       its OWN ROW below the Cancel/Save pair — sharing a row put it directly in
       the path of a mis-aimed click at Save, and squeezed all three past the
       card's width. Disabled outright when there is nothing to remove. */
    .fud-gm-edit-card .fud-btn-clear {
      order: 2; flex: 1 1 100%; padding: 5px 9px; font-size: 10px;
      background: #f3e3de; color: #8a2b1e; border-color: #a8503f;
    }
    .fud-gm-edit-card .fud-btn-clear[disabled] {
      opacity: 0.4; cursor: not-allowed; filter: grayscale(0.5);
    }
    .fud-gm-edit-card .fud-btn-clear[disabled]:hover { transform: none; filter: grayscale(0.5); }

    /* ── Small screens ──────────────────────────────────────────────────────
       The dialog is min(384px, 100vw - 20px), so below ~404px of viewport its
       width tracks the viewport and the fixed tracks below stop fitting: the
       accuracy row alone reserves 44 + 88 + 58 plus gaps, and the reaction grid
       pins 132px for its select. Both are made shrinkable rather than being
       given a second layout, so nothing reflows into an unfamiliar shape — the
       columns just narrow, and only the reaction row (which has the least room
       to give) actually stacks. */
    @media (max-width: 420px) {
      .fud-gm-edit-body { padding: 8px 9px; }
      .fud-gm-edit-card fieldset.fud-gm-sec { padding: 4px 7px 7px; }
      .fud-gm-edit-card .fud-gm-row .fud-gm-die { flex: 0 1 88px; min-width: 62px; }
      .fud-gm-edit-card .fud-gm-row .fud-gm-num { flex: 0 1 58px; min-width: 46px; }
      .fud-gm-rl { flex: 0 1 44px; min-width: 30px; }
      /* Name over control: at this width the 132px select leaves the carrier
         name four characters, and a reaction the GM cannot identify is worse
         than one that costs a line. */
      .fud-gm-rxrow { grid-template-columns: 1fr; gap: 4px; }
      .fud-gm-edit-card .fud-gm-rxrow .fud-gm-sel { width: 100%; }
      /* Three numeric columns become two, Outcome taking the full first row —
         it is the widest label and the one that truncates first. */
      .fud-gm-grid, .fud-gm-trow .fud-gm-grid { grid-template-columns: 1fr 1fr; }
      .fud-gm-grid > .fud-gm-f:first-child { grid-column: 1 / -1; }
    }
    /* A short viewport (a laptop with the board open, or a phone in landscape)
       is the case where the footer gets pushed off. Give the scrolling body the
       height back rather than the chrome. */
    @media (max-height: 560px) {
      .fud-gm-edit-head { padding: 7px 12px 6px; }
      .fud-gm-edit-title { font-size: 9px; }
      .fud-gm-edit-body { padding: 7px 10px; }
      .fud-gm-edit-card fieldset.fud-gm-sec { margin-bottom: 5px; }
      .fud-gm-edit-foot { padding: 7px 12px 8px; }
      /* Kept, not hidden — it carries the "who edited this card" credit, which
         is the only place a second GM's involvement is stated. */
      .fud-gm-note { font-size: 10px; line-height: 1.4; }
    }

    /* Rows carrying a hand-set value — an amber rail, deliberately distinct from
       the redirect tint so the two never read as the same thing on a card where
       both are present. Scoped to beat the result-state colours, which are
       themselves scoped and would otherwise win. */
    .fud-bf-card .fud-bf-target-row.is-gm-edited { box-shadow: inset 3px 0 0 var(--fud-gold-2, #b7935a); }
    .fud-bf-card .fud-bf-target-row .t-def.is-gm-edited,
    .fud-bf-card .fud-bf-target-row .t-result.is-gm-edited { color: #8a4b22; }
    /* An accuracy / damage edit has no per-target row to mark, so the panel
       itself carries the rail — otherwise a hand-set 16 is indistinguishable
       from a rolled one. */
    .fud-bf-card fieldset.fud-bf-section.is-gm-edited {
      box-shadow: inset 3px 0 0 var(--fud-gold-2, #b7935a);
    }
    .fud-bf-card fieldset.fud-bf-section.is-gm-edited legend::after {
      content: " · GM SET"; color: #8a4b22; font-size: 9px;
    }
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
  //
  // `data-fud-target-actor-uuid` is the stable hook the card-mutation
  // recompute sweeps across every target-displaying surface (this row,
  // portraits, per-target tooltips) so a redirect (Protect, future
  // change-target effects) propagates consistently. See
  // `applyTargetMutationToDom` in recomputeTargetPreviews.
  const targetParts = (Array.isArray(targets) && targets.length)
    ? targets.map((t, i) => {
        const c = dispositionColor(t.disposition ?? 0);
        const sep = i > 0 ? `<span class="t-sep">, </span>` : "";
        const uuidAttr = ` data-fud-target-actor-uuid="${escapeHtml(String(t.actorUuid ?? ""))}"`;
        // Redirected target (Protect / Prophetic Defender) — name reads as the
        // reactor with a 🔄 naming whom it took the place of. Rendered here so a
        // rebuild from the post-mutation target list shows the right names on the
        // Engagement line without any per-surface DOM patching.
        const rf = t.redirectedFrom;
        const marker = rf
          ? ` <small class="t-redirect-from" title="Redirected from ${escapeHtml(String(rf.name ?? "?"))}">🔄</small>`
          : "";
        const rcls = rf ? " is-redirected" : "";
        return `${sep}<span class="t-name${rcls}"${uuidAttr} style="color:${c}">${escapeHtml(t.name)}${marker}</span>`;
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

  // Per-cell role mini-tag — the disposition layout can swap which side
  // holds the attacker, so the legend "Attacker" alone is ambiguous to
  // a reader scanning left-to-right. Tag each cell explicitly to remove
  // any doubt. Targets get plural form when N > 1.
  const targetCount = Array.isArray(targets) ? targets.length : 0;
  const targetTagText = targetCount > 1 ? "Targets" : "Target";
  const attackerCell = `<div class="${attackerOnRight ? "right" : "left"} is-attacker"><span class="fud-bf-role-tag">Attacker</span>${attackerName}</div>`;
  const targetsCell  = `<div class="${attackerOnRight ? "left"  : "right"} is-targets"><span class="fud-bf-role-tag">${targetTagText}</span>${targetParts}</div>`;

  return `
    <fieldset class="fud-bf-section">
      <legend>Engagement</legend>
      <div class="fud-bf-attacker-row">
        ${attackerOnRight ? targetsCell : attackerCell}
        <div class="mid"><i class="fa-solid fa-swords"></i></div>
        ${attackerOnRight ? attackerCell : targetsCell}
      </div>
    </fieldset>
  `;
}

// Write `v` into `el`'s leading numeric text node WITHOUT disturbing sibling
// nodes (e.g. the +HR pill in the damage headline, which follows the number as
// a separate <span>). Falls back to inserting a fresh text node if the element
// has no leading text node.
function setLeadingNumberText(el, v) {
  const node = el.firstChild;
  if (node && node.nodeType === Node.TEXT_NODE) node.textContent = String(v);
  else el.insertBefore(document.createTextNode(String(v)), el.firstChild ?? null);
}

// Running-number tween for an Action-Card headline figure (Accuracy total or
// Damage / Heal number). Animates `el`'s value from `from` → `to` over ~360ms
// and tags it with a direction class (fud-num-up / fud-num-down) so increases
// and decreases read differently (see the card <style> block). `setText` writes
// each interpolated frame back. COSMETIC + PER-CLIENT — callers run this after
// applying the value swap locally; tween state is never baked into the
// broadcast HTML, so a late-joining mirror just sees the final value. No-ops on
// non-numeric values (e.g. a fumble's "—") or when the value is unchanged. Uses
// the rAF timestamp as its clock (no Date.now()/performance.now()).
function animateCardNumber(el, from, to, setText) {
  if (!el || typeof setText !== "function") return;
  const a = Number(from), b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) { if (Number.isFinite(b)) setText(b); return; }
  const up = b > a;
  el.classList.remove("fud-num-up", "fud-num-down");
  void el.offsetWidth; // force reflow so re-triggering the same direction replays the keyframes
  el.classList.add(up ? "fud-num-up" : "fud-num-down");
  const dur = 360;
  let t0 = null;
  const tick = (now) => {
    if (t0 == null) t0 = now;
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
    setText(Math.round(a + (b - a) * e));
    if (k < 1) {
      requestAnimationFrame(tick);
    } else {
      setText(b);
      el.classList.remove("fud-num-up", "fud-num-down");
    }
  };
  requestAnimationFrame(tick);
}

function buildAccuracyHTML({ roll, isSpellish = false, legendSuffix = "", hideDefenseIcon = false, legendOverride = null }) {
  if (!roll) return "";
  const { A1, A2, dA, dB, rA, rB, total, hr, checkBonus, checkBonusParts, isCrit, isFumble, opportunities, dieSwap } = roll;
  const accCls = isFumble ? "is-fumble" : isCrit ? "is-crit" : "";
  // Pre-roll Attribute-die swap (Psychokinesis): a small note under the dice
  // showing what was replaced (e.g. "Psychokinesis: DEX → WLP"), so the auto-swap
  // is transparent rather than a silent change.
  const dieSwapList = Array.isArray(dieSwap) ? dieSwap : (dieSwap ? [dieSwap] : []);
  const dieSwapNote = dieSwapList.length
    ? `<div class="fud-bf-die-swap" style="font-size:11px; opacity:0.82; margin-top:3px;"><i class="fa-solid fa-arrow-right-arrow-left" style="font-size:10px;"></i> ${dieSwapList.map((d) => `${escapeHtml(d.label || "Die swap")}: ${escapeHtml(d.from)} → ${escapeHtml(d.to)}`).join("; ")}</div>`
    : "";

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
        ${dieSwapNote}
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
  const resourceKey = String(damage.resource ?? "").toLowerCase();
  const isHealing  = !!damage.isHealing || !!damage.declaresHealing;
  const isMpDamage = resourceKey === "mp" && !isHealing;
  const elemKey = String(damage.element ?? "physical").toLowerCase();
  // Restore (ANY resource) takes its label + tint from the resource registry,
  // passed on the healingObj as resourceLabel / resourceColour. Damage uses the
  // element palette. So HP→green, MP→blue, IP/Shield/Zero Power/…→their colour.
  const restoreLabel  = damage.resourceLabel || (resourceKey ? resourceKey.toUpperCase() : "HP");
  const restoreColour = damage.resourceColour || "#2a8a3a";
  const _hexGlow = (hex, a = 0.45) => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ""));
    if (!m) return "rgba(42,138,58,0.45)";
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };
  const color = isHealing
    ? restoreColour
    : (isMpDamage ? "#1e6cff" : (ELEMENT_COLOR[elemKey] ?? ELEMENT_COLOR.physical));
  const glow  = isHealing
    ? _hexGlow(restoreColour)
    : (isMpDamage ? "rgba(30,108,255,0.45)" : (ELEMENT_GLOW[elemKey] ?? ELEMENT_GLOW.physical));

  // Final shown is HR + base. If the roll is a fumble, show "—".
  const shown = roll?.isFumble ? "—" : (damage.finalIfHit ?? 0);
  const hrPill = (damage.ignoreHR || roll?.isFumble) ? "" : `<span class="hr-pill">+HR</span>`;
  const label = isHealing
    ? (resourceKey === "hp" ? "Heal" : "Restore")
    : (isMpDamage ? "MP Damage" : "Damage");
  const elementLabel = isHealing ? restoreLabel : (isMpDamage ? "MP" : escapeHtml(displayElement(elemKey)));
  const suffix = legendSuffix ? ` <span style="opacity:0.7; font-weight: 700;">— ${escapeHtml(legendSuffix)}</span>` : "";

  // Calculation tooltip — surfaces base damage + HR contribution + how
  // affinity will mutate the final number per target.
  const baseVal = Number(damage.base ?? 0) || 0;
  const baseStr = baseVal >= 0 ? `+${baseVal}` : `${baseVal}`;
  const hrVal = roll?.isFumble ? 0 : (roll?.hr ?? 0);
  // HR line — when HR is forced to 0, name the ACTUAL source (Two-Weapon vs a
  // free-action grant like Hawkeye take-aim / Soaring Strike) via
  // damage.hrZeroReason; fall back to "no Check rolled" for a no-Check action.
  const hrLine = (!damage.ignoreHR && roll)
    ? `<p><b>HR:</b> ${hrVal} (from accuracy roll)</p>`
    : damage.hrZeroReason
      ? `<p><b>HR:</b> — (${escapeHtml(damage.hrZeroReason)})</p>`
      : roll
        ? `<p><b>HR:</b> — (HR treated as 0)</p>`
        : `<p><b>HR:</b> — (no Check rolled)</p>`;
  const cardReactionBonus = Number(damage.cardReactionBonus ?? 0) || 0;
  const formula = roll?.isFumble
    ? `<p><b>Final:</b> — (fumble auto-misses)</p>`
    : cardReactionBonus > 0
      ? `<p style="margin-top:6px;"><b>Final on hit:</b> ${hrVal} + ${baseVal} + ${cardReactionBonus} (passive) = <b>${damage.finalIfHit ?? 0}</b></p>`
      : `<p style="margin-top:6px;"><b>Final on hit:</b> ${hrVal} + ${baseVal} = <b>${damage.finalIfHit ?? 0}</b></p>`;

  // Per-source breakdown of where the base damage bonus came from. Same
  // shape as the Accuracy panel's checkBonusParts breakdown — set by
  // COMPUTE Attack via buildDamageBonusParts (walks AEs contributing to
  // weapon1_damage / off_mod_2 + free-action grants). Renders as an
  // indented list under "Base bonus" when ≥1 part has a non-zero amount.
  const baseParts = Array.isArray(damage.baseParts)
    ? damage.baseParts.filter((p) => p && Number(p.amount) !== 0)
    : [];
  const baseBreakdownHTML = baseParts.length
    ? `<ul style="margin:2px 0 0 14px; padding:0; opacity:0.85; font-size:11.5px;">`
      + baseParts.map((p) => {
          const a = Number(p.amount) || 0;
          const sign = a >= 0 ? "+" : "−";
          return `<li><b>${escapeHtml(String(p.source ?? "Unknown"))}:</b> ${sign}${Math.abs(a)}</li>`;
        }).join("")
      + `</ul>`
    : "";

  // Per-target affinity (VU/RS/IM/AB) applies ONLY to elemental damage — never to
  // a restore (any resource) or MP damage.
  const showAffinity = !isHealing && !isMpDamage;
  const tipBody = [
    isHealing
      ? `<p><b>Restores:</b> ${escapeHtml(restoreLabel)}</p>`
      : isMpDamage
        ? `<p><b>Element:</b> MP damage (resource burn, no element)</p>`
        : `<p><b>Element:</b> ${escapeHtml(cap(elemKey))}</p>`,
    `<p style="margin-bottom:0;"><b>Base bonus:</b> ${baseStr}</p>${baseBreakdownHTML}`,
    hrLine,
    formula,
    isHealing
      ? `<p style="margin-top:6px; opacity:0.85;">Restores ${escapeHtml(restoreLabel)} — no defense or affinity check.</p>`
      : isMpDamage
        ? `<p style="margin-top:6px; opacity:0.85;">MP damage skips elemental affinity — final number lands on each target's current MP unchanged.</p>`
        : `<p style="margin-top:6px; opacity:0.85;"><b>Per-target affinity:</b></p>`,
    showAffinity ? `<p style="opacity:0.85;">VU = ×2 &nbsp;•&nbsp; RS = ×0.5 (round up)</p>` : "",
    showAffinity ? `<p style="opacity:0.85;">IM = 0 &nbsp;•&nbsp; AB = heals target</p>` : "",
  ].filter(Boolean).join("");
  const tipName = isMpDamage ? "MP Damage Preview" : `${label} Preview`;
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
export function resultLabelFor(r, { hasDamage = true } = {}) {
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
    // Target already at cap → the restore lands nothing. Say so explicitly
    // instead of a green number that contradicts what happens (shields have no
    // cap, so they always show the amount).
    if (r.grantResource !== "shield"
        && r.resourceCur != null && r.resourceMax != null
        && r.resourceCur >= r.resourceMax) {
      return "FULL · NO EFFECT";
    }
    if (r.grantResource === "hp")     return `HEALED ${amt} HP`;
    if (r.grantResource === "shield") return `SHIELDED ${amt}`;
    return `RESTORED ${amt} ${resourceLabel(r.grantResource)}`;
  }
  // Non-damage Check (Soul Steal/Pillage, Torpor, Hallucination,
  // Enrage, future opposed-Check skills): the Check outcome IS the
  // effect, the mechanical payoff lands in the effect_table chain
  // (IP grant, status apply, etc.) — not as a number on the row.
  // Use SUCCESS/FAILED so the card doesn't read as "NO EFFECT" (which
  // would only be correct for IM-affinity damage skills).
  if (!hasDamage) return r.hit ? "SUCCESS" : "FAILED";
  // Damage skill — HIT/MISS/AB/IM/NO-EFFECT logic, with affinity baked into
  // the verb so the result line reads the outcome on its own (VU → "WEAK",
  // RS → "RESIST") without relying on the separate affinity pill.
  if (!r.hit) return "MISS";
  // Incoming damage NULLIFIED by a defender reaction (Ninja Log's adjust_damage
  // → 0). This is a HIT that deals 0 — NOT a miss (on-hit riders still apply) —
  // so credit the soak instead of the generic "NO EFFECT" / affinity verb, and
  // take precedence over the affinity branches below (a soaked hit reads the same
  // whether the victim was VU/RS/NE). Partial reductions (to > 0) fall through to
  // the normal HIT <n> verb. Mirrors the defenseOverride badge in the row tooltip.
  if (r.damageOverride && Number(r.damageOverride.to) <= 0 && Number(r.damageOverride.from) > 0) {
    return "NULLIFIED";
  }
  // The damage number is the headline — wrap it in `.t-num` so CSS can size it
  // large. "dmg" is dropped (the panel is already labelled DAMAGE); the MP unit
  // stays so MP-burn skills don't read as HP loss.
  const unit = r.resource === "mp" ? ` <span class="t-unit">MP</span>` : "";
  const big  = (v) => `<span class="t-num">${v}</span>`;
  if (r.affinity === "AB") return `ABSORB ${big(Math.max(0, r.damage))}`;
  if (r.affinity === "IM") return "IMMUNED";
  if (r.damage <= 0) return "NO EFFECT";
  if (r.affinity === "VU") return `WEAK ${big(r.damage)}${unit}`;
  if (r.affinity === "RS") return `RESIST ${big(r.damage)}${unit}`;
  return `HIT ${big(r.damage)}${unit}`;
}

export function resultClsFor(r) {
  if (!r.hit) return "miss";
  // Nullified hit (Ninja Log) — muted, same as IM/miss, since 0 landed.
  if (r.damageOverride && Number(r.damageOverride.to) <= 0 && Number(r.damageOverride.from) > 0) return "miss";
  if (typeof r.grantAmount === "number") {
    if (r.vismagusSuppressed) return "miss"; // visually muted — no heal landed
    if (r.grantResource === "mp")     return "restore-mp";
    if (r.grantResource === "shield") return "shield";
    return "heal";
  }
  if (r.affinity === "AB") return "absorb";
  if (r.affinity === "IM") return "miss";  // visually muted
  // Affinity hue takes precedence over crit so vulnerable (gold) / resist read
  // at a glance — the crit's extra damage still shows in the number.
  if (r.affinity === "VU") return "weak";
  if (r.affinity === "RS") return "resist";
  if (r.crit) return "crit";
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
  const elemLabel = elemRaw ? displayElement(elemRaw) : "—";
  // Defense label varies by action kind. Spellish actions (Skill/Spell
  // with skill_type='Spell') compare vs the target's Magic Defense in
  // COMPUTE — show "MDEF" instead of "DEF" so the per-target row
  // matches what's actually being checked.
  const defLabelTag = isSpellish ? "MDEF" : "DEF";
  const rows = (perTargetResults ?? []).map((r, _slotIdx) => {
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
      // Identity hooks are carried on the MASKED row too. They expose only which
      // token the row is (its name is already printed right here) — never the
      // masked DEF/damage/affinity — and without them every per-uuid patcher
      // (redirect, defense override, GM edit) silently cannot find the row, so a
      // mutation would apply in the data and never repaint for an unidentified
      // target. That is the common case: an enemy nobody has Studied yet.
      const maskedIdAttrs =
        ` data-fud-target-token-uuid="${escapeHtml(String(r.tokenUuid ?? ""))}"`
        + ` data-fud-target-actor-uuid="${escapeHtml(String(r.actorUuid ?? ""))}"`
        + ` data-fud-target-slot-index="${_slotIdx}"`;
      return `<div class="fud-bf-target-row is-unstudied"${maskedIdAttrs}${maskedAttrs}>
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
      // Target-specific damage modifiers (incoming reduction + crit
      // bonus/multiplier) so the GM sees why this target's number differs
      // from the headline. Source/amount shape matches the Accuracy /
      // Damage panel breakdowns. Negative amounts (reductions) render with
      // a minus sign.
      const modParts = Array.isArray(r.damageModParts)
        ? r.damageModParts.filter((p) => p && Number(p.amount) !== 0)
        : [];
      if (modParts.length) {
        const modLines = modParts.map((p) => {
          const amt = Number(p.amount);
          const sign = amt > 0 ? "+" : "−";
          return `<div style="display:flex;justify-content:space-between;gap:10px;opacity:0.9;"><span>${escapeHtml(p.source)}</span><span>${sign}${Math.abs(amt)}</span></div>`;
        }).join("");
        tipLines.push(`<p style="margin:4px 0 0;"><b>Damage Mods:</b></p>${modLines}`);
      }
    }
    // Defense override (adjust_defense reaction, e.g. Verónica "+2 DEF when
    // targeted") — itemize WHY this target's DEF differs from its base, same
    // shape as the Damage Mods breakdown above, just before the Hit Check.
    if (r.defenseOverride && Number(r.defenseOverride.from) !== Number(r.defenseOverride.to)) {
      const dov = r.defenseOverride;
      const d = Number(dov.to) - Number(dov.from);
      const sign = d > 0 ? "+" : "−";
      tipLines.push(`<p style="margin:4px 0 0;"><b>${defLabelTag} Mods:</b></p><div style="display:flex;justify-content:space-between;gap:10px;opacity:0.9;"><span>${escapeHtml(dov.via ?? "Reaction")}</span><span>${sign}${Math.abs(d)}</span></div>`);
    }
    // Incoming-damage override (adjust_damage reaction, e.g. Ninja Log) — itemize
    // WHY this target's damage differs from the rolled amount, same shape as the
    // Damage Mods / Defense Mods breakdowns. Explains the "NULLIFIED" result span.
    if (r.damageOverride && Number(r.damageOverride.from) !== Number(r.damageOverride.to)) {
      const dmo = r.damageOverride;
      const d = Number(dmo.to) - Number(dmo.from);
      const sign = d > 0 ? "+" : "−";
      tipLines.push(`<p style="margin:4px 0 0;"><b>Damage Mods:</b></p><div style="display:flex;justify-content:space-between;gap:10px;opacity:0.9;"><span>${escapeHtml(dmo.via ?? "Reaction")}</span><span>${sign}${Math.abs(d)}</span></div>`);
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

    // Stable hooks for the live preview update (Phase 3 of Cheap Shot): the
    // recompute helper finds the row to patch its result span. tokenUuid is the
    // primary hook (unique per token — disambiguates linked tokens sharing one
    // actor); actorUuid stays for back-compat / older queries. slot-index
    // disambiguates DUPLICATE rows that share a token — e.g. Prophetic Defender
    // redirects N threatened allies onto one reactor (Hina), so N rows carry the
    // SAME tokenUuid; without a per-slot key the patcher/dedup collapse them.
    const rowDataAttrs =
      ` data-fud-target-token-uuid="${escapeHtml(String(r.tokenUuid ?? ""))}"`
      + ` data-fud-target-actor-uuid="${escapeHtml(String(r.actorUuid ?? ""))}"`
      + ` data-fud-target-slot-index="${_slotIdx}"`;
    // Redirected slot (Protect / Prophetic Defender) — tint the row + append the
    // 🔄 marker naming the creature whose place this row now takes. Rendered
    // through this same pipeline so a multi-target redirect shows one row per
    // covered ally, all reading as the reactor.
    const rf = r.redirectedFrom;
    const rowClass = rf ? "fud-bf-target-row is-redirected" : "fud-bf-target-row";
    const redirectMarker = rf
      ? ` <small class="t-redirect-from" title="Redirected from ${escapeHtml(String(rf.name ?? "?"))}">🔄</small>`
      : "";
    return `<div class="${rowClass}"${rowDataAttrs}${tipAttrs}>
      <span class="t-name">${escapeHtml(r.name)}${redirectMarker}${aff ? ` ${aff}` : ""}</span>
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

// Append ONE per-target result row to a live (already-rendered) Action Card —
// used by the Barrage (_addTarget) pill on the post-roll card. `r` is a
// projected perTargetResults row sharing the action's accuracy roll. Mirrors
// the single-row markup of buildPerTargetHTML (studied-mask + affinity + result
// class/label) and keeps payload.perTargetResults / payload.targets consistent
// so a later recomputeTargetPreviews toggle sees the new row.
function appendTargetRow(root, r, kind, payload) {
  try {
    const list = root.querySelector(".fud-bf-target-list");
    if (!list || !r) return;
    const hasDamage = !!payload?.hasDamage || kind === "Attack";
    const isSpellish = String(payload?.skillType ?? "").toLowerCase() === "spell";
    const defLabelTag = isSpellish ? "MDEF" : "DEF";
    const div = document.createElement("div");
    div.className = "fud-bf-target-row is-added";
    div.setAttribute("data-fud-target-token-uuid", String(r.tokenUuid ?? ""));
    div.setAttribute("data-fud-target-actor-uuid", String(r.actorUuid ?? ""));
    if (r.studied === false) {
      // Match buildPerTargetHTML's masked row — same "study to reveal" tooltip
      // so an added (Barrage) masked row has the same hover detail as a normal
      // masked row (no popup on the added row was a reported inconsistency).
      div.setAttribute("data-fud-equip-desc", `<p>Study this target to identity tier (≥7) to reveal defense, damage, and affinity.</p>`);
      div.setAttribute("data-fud-equip-desc-name", String(r.name ?? "?"));
      div.innerHTML =
        `<span class="t-name">${escapeHtml(r.name ?? "?")}</span>`
        + `<span class="t-def">${defLabelTag} ???</span>`
        + `<span class="t-result">???</span>`;
    } else {
      const cls = resultClsFor(r);
      const label = resultLabelFor(r, { hasDamage });
      const aff = buildAffinityTagHTML({ affinity: r.affinity, hit: r.hit, studied: r.studied });
      div.innerHTML =
        `<span class="t-name">${escapeHtml(r.name ?? "?")}${aff ? ` ${aff}` : ""}</span>`
        + `<span class="t-def">${defLabelTag} ${r.defense}</span>`
        + `<span class="t-result ${cls}">${label}</span>`;
    }
    list.appendChild(div);
    // REPLACE these arrays; never push into them. They come straight off the
    // action result, which `freezeActionResult` deep-freezes — so `push` throws
    // in strict mode. The throw was swallowed by the catch below, AFTER the DOM
    // row had already been appended: the added target (Barrage splash /
    // add_target) was visible on the card but absent from the data, so the
    // recompute and CONFIRM resolved without it. Assigning a NEW array onto
    // `payload` is fine — the frozen thing is the array, not the payload.
    if (Array.isArray(payload?.perTargetResults)) {
      payload.perTargetResults = [...payload.perTargetResults, r];
    }
    if (Array.isArray(payload?.targets)) {
      payload.targets = [...payload.targets, {
        name: r.name, actorUuid: r.actorUuid, tokenImg: r.tokenImg,
        disposition: r.disposition, defense: r.defense, studied: r.studied,
      }];
    }
  } catch (e) { warn("appendTargetRow threw", e); }
}

function buildButtonsHTML({ isFumble = false, hasRoll = true, invokeCapability = "full", invokePointCount = null, confirmLabel = "Confirm" }) {
  // Invoke buttons: locked on Fumble, locked by actor rank (none/trait-only), or active.
  // For no-Check skills the row is hidden — no roll = nothing to invoke.
  const mkInvokeBtn = (type, icon, label) => {
    const lockedByFumble      = isFumble;
    const lockedByCapability  = invokeCapability === "none" || (invokeCapability === "trait-only" && type === "bond");
    const isLocked = lockedByFumble || lockedByCapability;
    const lockTitle = lockedByFumble
      ? "Locked: Invoke cannot be used on a Fumble."
      : invokeCapability === "none"
        ? "Locked: Monsters cannot Invoke."
        : "Locked: Only Villain/Champion/Boss-rank monsters can Invoke Bond.";
    return isLocked
      ? `<div class="fud-btn fud-btn-invoke is-locked" data-fud-invoke="${type}"
             title="${lockTitle}" aria-disabled="true">
           <span class="btn-label"><span class="icon">${icon}</span>${label}</span>
           <span class="lock-icon"><i class="fa-solid fa-lock"></i></span>
         </div>`
      : `<div class="fud-btn fud-btn-invoke" data-fud-invoke="${type}"
             role="button" tabindex="0">
           <span class="btn-label"><span class="icon">${icon}</span>${label}</span>
         </div>`;
  };

  const showCounter = hasRoll && invokeCapability !== "none" && invokePointCount !== null;
  const counterHtml = showCounter
    ? `<span data-fud-invoke-counter style="margin-left:auto;font-size:11px;opacity:0.6;letter-spacing:0.04em;white-space:nowrap;align-self:center;">
         <i class="fa-solid ${invokeCapability === "trait-only" ? "fa-eye" : "fa-star"}"
            style="color:${invokeCapability === "trait-only" ? "#a855f7" : "#14b8a6"};margin-right:3px;"></i><span class="fud-invoke-count">${invokePointCount}</span>
       </span>`
    : "";

  const invokeRow = hasRoll
    ? `
      <div class="fud-bf-btn-row">
        ${mkInvokeBtn("trait", "🎭", "Invoke Trait")}
        ${mkInvokeBtn("bond",  "🤝", "Invoke Bond")}
        ${counterHtml}
      </div>`
    : "";
  return `
    ${invokeRow}
    <div class="fud-bf-btn-row">
      <div class="fud-btn fud-btn-confirm" data-fud-action="confirm" role="button" tabindex="0">${escapeHtml(confirmLabel)}</div>
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
    .map((t) => (t?.tokenImg ? { img: t.tokenImg, name: t.name, actorUuid: t.actorUuid ?? null } : null))
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
  // `data-fud-target-actor-uuid` is the stable hook the recompute
  // sweeps across when a card mutation (Protect redirect, future
  // change-target effects) needs to refresh every target surface
  // consistently.
  const uuidAttr = slot.actorUuid
    ? ` data-fud-target-actor-uuid="${escapeHtml(String(slot.actorUuid))}"`
    : "";
  if (isVideoUrl(url)) {
    return `<video class="fud-bf-portrait-sprite" src="${safe}"
                   autoplay loop muted playsinline disablepictureinpicture
                   title="${name}" aria-label="${name}"${uuidAttr}></video>`;
  }
  return `<img class="fud-bf-portrait-sprite" src="${safe}" title="${name}" alt="${name}"${uuidAttr}>`;
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
    const uuidAttr = slot.actorUuid
      ? ` data-fud-target-actor-uuid="${escapeHtml(String(slot.actorUuid))}"`
      : "";
    return `<div class="fud-bf-portrait-cell" style="width:${cell}px; height:${cell}px;"
                 title="${name}" aria-label="${name}" role="img"${uuidAttr}>${media}</div>`;
  }).join("");
  return `<div class="fud-bf-portrait-grid">${cells}</div>`;
}

// ─────────────────────────────────────────────────────────────────────
// Card target-mutation DOM patcher — shared between GM and player paths
// ─────────────────────────────────────────────────────────────────────
//
// Given a `rootEl` (the GM card root OR the player mirror wrapper) and
// a `delta` describing target mutations + result-row updates, patches
// every target-displaying surface inside the root. Identical logic on
// both sides — GM calls it after computing mutations; player handler
// calls it after receiving the broadcast.
//
// delta shape:
//   {
//     redirects: [{
//       origUuid,         // pre-mutation actor uuid (DOM hook)
//       newName,          // post-mutation target name
//       newImg,           // post-mutation portrait sprite src (raw)
//       newDefense,       // recomputed defense vs the action's roll
//       newAffinity,      // recomputed affinity code ("RS"/"IM"/...)
//       newHit, newCrit,  // recomputed hit / crit flags
//       newDamage,        // post-mutation damage value
//       fromName,         // original target name (for "← OriginalName")
//       via,              // skill name that caused the redirect
//     }],
//     hasDamageRows,      // gates the t-result re-derive
//     vsMDef,             // true → label rows/tooltip "MDEF" (Spell / mdef-tagged); else "DEF"
//     rollTotal,          // for the tooltip "Total N ≥/< DEF X" line
//     element,            // for the tooltip Element + Affinity lines
//   }
//
// Future card-mutation kinds (change_element, replace_damage, etc.)
// extend this delta with additional fields; the patcher gains a new
// surface-update block for each surface that needs to reflect the
// change.
// ── Future-proof target-surface rerender ─────────────────────────────────────
// When a card mutation CHANGES THE TARGET SET (redirect today; add_target /
// change_target / split tomorrow), regenerate EVERY target-displaying surface —
// the Engagement row, the corner portraits, and the per-target Result list —
// from the post-mutation target list using the SAME canonical builders the
// initial card render uses (buildAttackerHTML / buildPortraitsHTML /
// buildPerTargetHTML).
//
// This replaces per-surface, per-original-uuid DOM patching, which silently
// breaks whenever the set changes in a non-1:1 way: a multi-target redirect
// collapses N covered allies onto ONE reactor (N slots share a token), so a
// patch keyed by original uuid half-updates names and leaves portraits/headers
// stale (the PDS "take the place of ALL allies" bug). Rendering from the data
// keeps all surfaces correct BY CONSTRUCTION — a new target-mutation kind needs
// zero new surface-patch code, just a correct post-mutation target list.
//
// `targets` rows carry { name, actorUuid, disposition, redirectedFrom? };
// `perTargetResults` rows carry the flattened outcome (+ redirectedFrom merged
// in by the caller, since projectProfileToActionResult drops it from flat rows).
export function rerenderCardTargetSurfaces(rootEl, { attacker, targets, perTargetResults, element = null, roll = null, vsMDef = false, hasDamage = true }) {
  if (!rootEl) return;
  // 1. Engagement row (Attacker ⚔ Targets).
  try {
    const row = rootEl.querySelector(".fud-bf-attacker-row");
    if (row && attacker) {
      const tmp = document.createElement("div");
      tmp.innerHTML = buildAttackerHTML({ attacker, targets });
      const fresh = tmp.querySelector(".fud-bf-attacker-row");
      if (fresh) row.replaceWith(fresh);
    }
  } catch (e) { warn("rerenderCardTargetSurfaces: engagement row threw", e); }
  // 2. Corner portraits (left/right slots).
  try {
    if (attacker) {
      const portraits = buildPortraitsHTML({ attacker, perTargetResults });
      const leftSlot = rootEl.querySelector(".fud-bf-portrait-slot.left");
      const rightSlot = rootEl.querySelector(".fud-bf-portrait-slot.right");
      if (leftSlot) leftSlot.innerHTML = portraits.left ?? "";
      if (rightSlot) rightSlot.innerHTML = portraits.right ?? "";
    }
  } catch (e) { warn("rerenderCardTargetSurfaces: portraits threw", e); }
  // 3. Per-target Result list.
  try {
    const listEl = rootEl.querySelector(".fud-bf-target-list");
    if (listEl && Array.isArray(perTargetResults) && perTargetResults.length) {
      const tmp = document.createElement("div");
      tmp.innerHTML = buildPerTargetHTML({ perTargetResults, weapon: null, element, roll, isSpellish: vsMDef, hasDamage });
      const newList = tmp.querySelector(".fud-bf-target-list");
      if (newList) listEl.innerHTML = newList.innerHTML;
    } else if (listEl && !(targets ?? []).length) {
      // A GM emptied the target set. Say so — the alternative is leaving the
      // pre-edit rows standing, each still reading "HIT 27" for a creature this
      // action is no longer touching. That stale surface is the entire reason
      // emptying used to be refused.
      listEl.innerHTML = `<div class="fud-bf-target-row is-none">`
        + `<span class="t-name" style="opacity:.7">No targets — this action hits nobody</span></div>`;
    }
  } catch (e) { warn("rerenderCardTargetSurfaces: target list threw", e); }
}

// Effective action cost for the card preview — the SAME computeEffectiveCost the
// RESOLVE debit uses (skill-cost.js is a leaf module, so importing it here costs no
// cycle). The card bullet and the amount actually paid therefore cannot drift; the
// previous local copy was a deliberate near-duplicate and drifted the moment
// surcharge-seeding landed on one side only.
// Format a resolved cost map like the CSB cost string ("6 MP", "3 HP · 2 MP", "Free").
// Delegates to skill-cost.formatCostMap — the cost bullet, the COMPUTE-side
// repaint and any future readout must render a cost map the same way, and this
// was a second copy of that rule.
const formatCardCost = formatCostMap;

// ── Wire-safety for the structured card delta ────────────────────────────────
// The delta now carries ROW DATA to player mirrors instead of a rendered
// `.fud-bf-body` innerHTML dump. Rows come straight off the recompute, so they
// can carry live Documents (Actor/Token) and heavy internals
// (`bonusBreakdown.ops`). The first would THROW on `socket.emit` (structured
// clone can't take a class instance); the second would undo the size win.
//
// `toWireSafe` keeps primitives, arrays and PLAIN objects and drops everything
// else, so a Document can never reach the wire even if a new field starts
// carrying one. Deliberately a DROP-LIST plus a plain-object rule rather than a
// field whitelist: an over-pruned whitelist fails SILENTLY (a rendered field
// goes blank on the mirror only), whereas shipping one extra scalar is merely
// slightly larger. The render-critical field set is owned by buildPerTargetHTML
// and would have to be mirrored by hand here otherwise.
const WIRE_DROP_KEYS = new Set([
  // Heavy recompute internals — the mirror re-renders from FINAL values, never
  // from the op ledger that produced them.
  "bonusBreakdown", "profile", "_profile", "ops", "raw",
  // Live document handles. The plain-object rule below already drops these;
  // named explicitly so a `toJSON()`-able wrapper can't serialise itself in.
  "actor", "token", "tokenDoc", "actorDoc", "item", "skill", "weapon",
]);

function toWireSafe(v, depth = 0) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (t !== "object") return undefined;          // function / symbol / bigint
  if (depth > 8) return undefined;               // runaway-nesting backstop
  if (Array.isArray(v)) return v.map((x) => toWireSafe(x, depth + 1) ?? null);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (WIRE_DROP_KEYS.has(k)) continue;
    const sv = toWireSafe(val, depth + 1);
    if (sv !== undefined) out[k] = sv;
  }
  return out;
}

// The GM editor's view of the post-mutation membership — a NARROW projection,
// not the wire-safe snapshot arrays.
//
// It rides EVERY recompute (each pill click) out to every connected client,
// including the players, none of whom can open the editor. A full target
// snapshot carries affinities, conditions, targeting blocks and per-target
// resource state; shipping two of those per recompute would undo most of the
// bandwidth win the structured delta exists for. The editor reads exactly these
// fields — membership, provenance, and the engine's own numbers for the
// placeholders — so anything else is pure freight.
//
// `addedVia` is load-bearing, not decoration: it is how the editor tells an
// ENGINE-added slot (add_target splash, a shield phantasm, a Protect redirect)
// from the GM's own addition, which decides whether Remove means "remove" or
// "un-add". Dropping it would recreate the bug this projection was written for.
function projectTargetSurfaceForEditor(targets, rows) {
  // Deliberately no `actorUuid`, `hit` or `crit`: nothing in the editor reads
  // them (the outcome select is driven by the BAG, not by the row), and this
  // rides out to every connected client on every pill click.
  const slim = (t) => (t ? {
    tokenUuid: t.tokenUuid ?? null,
    name: t.name ?? null,
    addedVia: t.addedVia ? { via: t.addedVia.via ?? null, gm: !!t.addedVia.gm } : null,
  } : null);
  return {
    targets: (Array.isArray(targets) ? targets : []).map(slim).filter(Boolean),
    perTargetResults: (Array.isArray(rows) ? rows : []).map((r) => (r ? {
      ...slim(r),
      damage: typeof r.damage === "number" ? r.damage : null,
      defense: typeof r.defense === "number" ? r.defense : null,
      // Present ONLY on a grant/heal row, and its presence is what
      // isGmEditableRow excludes on — so the type has to survive the projection.
      ...(typeof r.grantAmount === "number" ? { grantAmount: r.grantAmount } : {}),
      // The pre-override defence, the only honest placeholder for a slot whose
      // defence the GM has already set.
      defenseOverride: r.defenseOverride ? { from: r.defenseOverride.from ?? null } : null,
    } : null)).filter(Boolean),
  };
}

// MAP, never filter — per-target rows are matched to `.fud-bf-target-row` by
// INDEX, so dropping a row would repaint the wrong target.
function projectRowsForWire(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => (r ? toWireSafe(r) ?? null : null));
}

// Reaction Effects panel + damage-nullify strike. Extracted from the GM-side
// `applyReactionEffectPreview` closure so the player mirror renders the panel
// from the SAME code — previously it only ever arrived inside the innerHTML
// dump. The caller resolves which effects are accepted; this is the pure
// render half, driven by serialisable data.
function renderReactionEffectPreview(cardEl, { effects = [], damageNullified = false } = {}) {
  if (!cardEl) return;
  // Damage panel strike — CSS strikes the number + shows a "No damage" note.
  const dmgSection = cardEl.querySelector(".fud-bf-dmg");
  if (dmgSection) dmgSection.classList.toggle("is-nullified", !!damageNullified);

  let panel = cardEl.querySelector(".fud-bf-reaction-effects");
  if (!effects.length) { if (panel) panel.remove(); return; }
  if (!panel) {
    panel = document.createElement("fieldset");
    panel.className = "fud-bf-section fud-bf-reaction-effects";
    // Place after the target list when present; otherwise insert just BEFORE
    // the button row(s) so the panel never lands below CONFIRM. (Guard /
    // no-target cards have no `.fud-bf-target-list`, which used to fall
    // through to appendChild → panel rendered under the buttons.)
    const afterTargets = cardEl.querySelector(".fud-bf-target-list")?.closest(".fud-bf-section")
      ?? cardEl.querySelector(".fud-bf-target-list");
    const firstBtnRow = cardEl.querySelector(".fud-bf-btn-row");
    if (afterTargets && afterTargets.parentNode) {
      afterTargets.parentNode.insertBefore(panel, afterTargets.nextSibling);
    } else if (firstBtnRow && firstBtnRow.parentNode) {
      firstBtnRow.parentNode.insertBefore(panel, firstBtnRow);
    } else {
      cardEl.appendChild(panel);
    }
  }
  const chips = effects.map((e) => {
    if (e.kind === "apply_ae") {
      return `<span class="fud-bf-effect-chip is-status">${escapeHtml(e.statusName ?? e.label)}</span>`;
    }
    // Special keyword riders (Drain → self-heal note). Rendered as a status-
    // style chip so it reads as a gameplay effect.
    if (e.kind === "keyword") {
      return `<span class="fud-bf-effect-chip is-status">${escapeHtml(e.label ?? e.keyword ?? "Effect")}</span>`;
    }
    return `<span class="fud-bf-effect-chip">${escapeHtml(e.label ?? "Effect")}</span>`;
  }).join("");
  // Uniform "Effects" legend (the reaction pill above already names the skill;
  // repeating the carrier name here was redundant).
  panel.innerHTML = `<legend>Effects</legend><div class="fud-bf-effect-chips">${chips}</div>`;
}

export function applyCardTargetMutationDelta(rootEl, delta) {
  if (!rootEl || !delta || !Array.isArray(delta.redirects)) return;
  const { redirects, hasDamageRows, rollTotal, element } = delta;
  // DEF for Attacks / physical Skills; MDEF for Spell-kind or mdef-tagged
  // actions. Mirrors buildPerTargetHTML's label so a redirect (Protect) onto a
  // magic action keeps the MDEF wording instead of reverting to DEF.
  const defLabelTag = delta.vsMDef ? "MDEF" : "DEF";
  for (const r of redirects) {
    if (!r?.origUuid) continue;
    const safeOrig = CSS.escape(String(r.origUuid));
    const newName = r.newName ?? "";
    const fromName = r.fromName ?? "";

    // 1. Attacker-line name span — swaps the "Target" side of the
    //    "Attacker ⚔ Target" header line + appends a redirect arrow.
    for (const span of rootEl.querySelectorAll(
      `.fud-bf-attacker-row .t-name[data-fud-target-actor-uuid="${safeOrig}"]`
    )) {
      span.innerHTML =
        `${escapeHtml(newName)} ` +
        `<small class="t-redirect-from" title="Redirected from ${escapeHtml(fromName)}">🔄</small>`;
      span.classList.add("is-redirected");
    }

    // 2. Portrait sprites + cells — replace src + title with the
    //    redirected target's data.
    const safeNewImg = r.newImg ? escapeHtml(safeImgUrl(r.newImg) ?? r.newImg) : null;
    for (const sprite of rootEl.querySelectorAll(
      `[data-fud-target-actor-uuid="${safeOrig}"].fud-bf-portrait-sprite,` +
      `[data-fud-target-actor-uuid="${safeOrig}"] img,` +
      `[data-fud-target-actor-uuid="${safeOrig}"] video`
    )) {
      if (safeNewImg && (sprite.tagName === "IMG" || sprite.tagName === "VIDEO")) {
        sprite.setAttribute("src", safeNewImg);
      }
      if (sprite.hasAttribute("title")) sprite.setAttribute("title", newName);
      if (sprite.hasAttribute("alt"))   sprite.setAttribute("alt", newName);
      if (sprite.hasAttribute("aria-label")) sprite.setAttribute("aria-label", newName);
    }
    for (const cell of rootEl.querySelectorAll(
      `.fud-bf-portrait-cell[data-fud-target-actor-uuid="${safeOrig}"]`
    )) {
      if (cell.hasAttribute("title")) cell.setAttribute("title", newName);
      if (cell.hasAttribute("aria-label")) cell.setAttribute("aria-label", newName);
    }

    // 3. Result row — name swap + def update + redirect tint + result
    //    label re-derive (gated on hasDamageRows for non-damage Skills).
    const rowEl = rootEl.querySelector(
      `.fud-bf-target-row[data-fud-target-actor-uuid="${safeOrig}"]`
    );
    if (rowEl) {
      const nameSpan = rowEl.querySelector(".t-name");
      if (nameSpan) {
        nameSpan.innerHTML =
          `${escapeHtml(newName)} ` +
          `<small class="t-redirect-from" title="Redirected from ${escapeHtml(fromName)}">🔄</small>`;
      }
      const defSpan = rowEl.querySelector(".t-def");
      if (defSpan) defSpan.textContent = `${defLabelTag} ${r.newDefense}`;
      rowEl.classList.add("is-redirected");

      // Tooltip — rebuild the per-target hover body to reflect the
      // redirect target's stats so it no longer shows the original.
      rowEl.setAttribute("data-fud-equip-desc-name", `${newName} ← ${fromName}`);
      const verdict = r.newHit
        ? (r.newCrit ? "Critical — auto-hit" : "hit")
        : "missed";
      const total = rollTotal ?? "?";
      const cmp = r.newHit ? "≥" : "<";
      const elemLabel = element ?? "Physical";
      const tipBody =
        `<p><b>Redirected from:</b> ${escapeHtml(fromName)} ` +
        `<small>(via ${escapeHtml(r.via ?? "reaction")})</small></p>` +
        `<p><b>Element:</b> ${escapeHtml(elemLabel)}</p>` +
        `<p><b>Affinity:</b> ${escapeHtml(r.newAffinity ?? "NE")}</p>` +
        `<p><b>Hit Check:</b> Total ${total} ${cmp} ${defLabelTag} ${r.newDefense} — ${verdict}</p>`;
      rowEl.setAttribute("data-fud-equip-desc", tipBody);

      if (hasDamageRows) {
        const resultSpan = rowEl.querySelector(".t-result");
        if (resultSpan) {
          // Reuse the canonical label/class logic so the affinity verbs
          // (WEAK / RESIST / NO EFFECT / HEALS) stay in sync everywhere.
          const shim = {
            hit: r.newHit, crit: r.newCrit, affinity: r.newAffinity,
            damage: r.newDamage, resource: r.resource,
          };
          const oldTNum = parseInt(resultSpan.querySelector(".t-num")?.textContent ?? "", 10);
          resultSpan.className = `t-result ${resultClsFor(shim)}`;
          resultSpan.innerHTML = resultLabelFor(shim);
          const tNum = resultSpan.querySelector(".t-num");
          if (tNum) animateCardNumber(tNum, oldTNum, Number(tNum.textContent), (v) => { tNum.textContent = String(v); });
        }
      }
    }
  }

  // Per-target DEFENSE override (adjust_defense / Verónica "+2 DEF when targeted"):
  // the recompute bumped a target's OWN DEF and re-derived its hit. The redirect
  // loop above only touches redirected slots and a self +DEF has none, so patch
  // those rows here — the DEF number, the Hit Check + DEF-Mods hover, and the
  // verdict — mirroring the redirect row patch. Serializable delta → player mirror too.
  for (const d of (Array.isArray(delta.defenseOverrides) ? delta.defenseOverrides : [])) {
    const rowEl = (d.tokenUuid && rootEl.querySelector(
      `.fud-bf-target-row[data-fud-target-token-uuid="${CSS.escape(String(d.tokenUuid))}"]`
    )) || (d.actorUuid && rootEl.querySelector(
      `.fud-bf-target-row[data-fud-target-actor-uuid="${CSS.escape(String(d.actorUuid))}"]`
    ));
    if (!rowEl) continue;
    // A row masked as unstudied stays masked for non-GMs. This delta is the SAME
    // payload every mirror receives, and a defence override — whether a
    // reaction's +DEF or a GM's hand-set value — would otherwise print the exact
    // number the Study gate exists to withhold, straight onto the player's card.
    if (rowEl.classList.contains("is-unstudied") && !game.user?.isGM) continue;
    const defSpan = rowEl.querySelector(".t-def");
    if (defSpan) defSpan.textContent = `${defLabelTag} ${d.to}`;
    // Hover — re-derive the Hit Check vs the NEW DEF + itemize the +DEF source.
    const verdict = d.hit ? (d.crit ? "Critical — auto-hit" : "hit") : "missed";
    const cmp = d.hit ? "≥" : "&lt;";
    const total = rollTotal ?? "?";
    const dd = Number(d.to) - Number(d.from);
    const sign = dd > 0 ? "+" : "−";
    const elemLabel = element ?? "Physical";
    rowEl.setAttribute("data-fud-equip-desc",
      `<p><b>Element:</b> ${escapeHtml(elemLabel)}</p>` +
      `<p><b>Affinity:</b> ${escapeHtml(d.affinity ?? "NE")}</p>` +
      `<p style="margin:4px 0 0;"><b>${defLabelTag} Mods:</b></p>` +
      `<div style="display:flex;justify-content:space-between;gap:10px;opacity:0.9;"><span>${escapeHtml(d.via ?? "Reaction")}</span><span>${sign}${Math.abs(dd)}</span></div>` +
      `<p><b>Hit Check:</b> Total ${total} ${cmp} ${defLabelTag} ${d.to} — ${verdict}</p>`);
    // Verdict — re-derive (keep it authoritative alongside the DEF/hover).
    const resultSpan = rowEl.querySelector(".t-result");
    if (resultSpan) {
      const shim = { hit: d.hit, crit: d.crit, affinity: d.affinity, damage: d.damage };
      resultSpan.className = `t-result ${resultClsFor(shim)}`;
      resultSpan.innerHTML = resultLabelFor(shim);
    }
  }

  // Manual GM overrides — repaint the hand-set DEF / verdict / damage on each
  // edited row and mark WHICH fields the table set, so nobody reads a GM figure
  // as an engine result. Runs AFTER the reaction loops above: the GM layer is
  // applied last in the engine too, so the DOM order matches the data order.
  // Purely delta-driven, so the player/support-GM mirrors get it identically.
  for (const g of (Array.isArray(delta.gmOverrides) ? delta.gmOverrides : [])) {
    const rowEl = (g.tokenUuid && rootEl.querySelector(
      `.fud-bf-target-row[data-fud-target-token-uuid="${CSS.escape(String(g.tokenUuid))}"]`
    )) || (g.actorUuid && rootEl.querySelector(
      `.fud-bf-target-row[data-fud-target-actor-uuid="${CSS.escape(String(g.actorUuid))}"]`
    ));
    if (!rowEl) continue;
    // A row masked as unstudied stays masked for non-GMs. This delta is the SAME
    // serializable payload every mirror receives, so painting a GM-set damage or
    // DEF into a masked row would hand players the very numbers the Study gate
    // exists to withhold. GMs (host and support alike) see the edit painted.
    if (rowEl.classList.contains("is-unstudied") && !game.user?.isGM) continue;
    rowEl.classList.add("is-gm-edited");
    if (g.fields?.defense) {
      const defSpan = rowEl.querySelector(".t-def");
      if (defSpan) {
        defSpan.textContent = `${defLabelTag} ${g.defense}`;
        defSpan.classList.add("is-gm-edited");
      }
    }
    const resultSpan = rowEl.querySelector(".t-result");
    if (resultSpan && (g.fields?.hit || g.fields?.damage)) {
      const shim = { hit: g.hit, crit: g.crit, affinity: g.affinity, damage: g.damage };
      const oldTNum = parseInt(resultSpan.querySelector(".t-num")?.textContent ?? "", 10);
      resultSpan.className = `t-result ${resultClsFor(shim)} is-gm-edited`;
      resultSpan.innerHTML = resultLabelFor(shim);
      const tNum = resultSpan.querySelector(".t-num");
      if (tNum) animateCardNumber(tNum, oldTNum, Number(tNum.textContent), (v) => { tNum.textContent = String(v); });
    }
    // Hover — say plainly that these numbers were set by hand, and which ones.
    const edited = [
      g.fields?.hit ? "hit/miss" : null,
      g.fields?.damage ? "damage" : null,
      g.fields?.defense ? defLabelTag : null,
    ].filter(Boolean);
    rowEl.setAttribute("data-fud-equip-desc",
      `<p><b>GM override</b> — set by hand: ${escapeHtml(edited.join(", "))}</p>` +
      `<p><b>Affinity:</b> ${escapeHtml(g.affinity ?? "NE")}</p>` +
      `<p>${g.hit ? "Hits" : "Misses"}${g.fields?.damage ? ` for ${g.damage}` : ""} — this figure overrides the engine's.</p>`);
  }
  // Reaction pills a GM target removal has made moot. Marked here rather than at
  // the decision site because the prune happens in the mutation pass, which runs
  // on the PREVIEW too — so the pill tells the truth for the whole window
  // between the GM's Save and Confirm, not only after the commit.
  //
  // Idempotent in both directions: the delta carries the CURRENT dropped set, so
  // restoring the removed creature clears the mark on the next recompute.
  if (Array.isArray(delta.gmDroppedReactions)) {
    const mootKeys = new Set(delta.gmDroppedReactions
      .map((c) => `${c?.rowKey ?? ""}:${c?.carrierUuid ?? ""}`));
    for (const pill of rootEl.querySelectorAll(".fud-bf-reaction-pill")) {
      const key = `${pill.dataset.fudReactionKey ?? ""}:${pill.dataset.fudReactionCarrier ?? ""}`;
      const moot = mootKeys.has(key);
      const wasMoot = pill.dataset.fudReactionMoot === "1";
      const chipPresent = !!pill.querySelector('[data-fud-reaction-moot-chip="1"]');
      // "Already right" is not the same as "the flag matches". Another path can
      // repaint this slot while the pill is marked (a GM verdict, an Ask-again
      // rebuild), which removes OUR chip but leaves the flag — and the flag
      // alone would then short-circuit every later pass, so the pill would show
      // live Apply/Skip for a reaction the prune still drops. Re-mark when the
      // chip is missing, and refresh the stash to what that repaint left: the
      // old stash describes a state two verdicts back.
      const needsRemark = moot && !chipPresent;
      if (moot === wasMoot && !needsRemark) continue;
      if (moot) {
        pill.dataset.fudReactionMoot = "1";
        pill.classList.add("is-moot");
        const st = pill.querySelector(".fud-bf-reaction-status, .fud-bf-reaction-actions");
        if (st) {
          // Remember what it said, so lifting the removal restores the player's
          // own verdict rather than guessing at one.
          if (needsRemark || pill.dataset.fudReactionMootPrev == null) {
            pill.dataset.fudReactionMootPrev = st.outerHTML;
          }
          // The chip is TAGGED, and the un-mark below restores only when the tag
          // is still there. Between these two passes something else can repaint
          // this slot — a cascade injection, a re-post, restoreReactionPillToActionable
          // — and blindly writing the stash back would resurrect the buttons
          // that repaint had just replaced, wired to nothing.
          st.outerHTML = `<span class="fud-bf-reaction-status" data-fud-reaction-moot-chip="1">Target removed</span>`;
        }
      } else {
        delete pill.dataset.fudReactionMoot;
        pill.classList.remove("is-moot");
        const st = pill.querySelector(".fud-bf-reaction-status, .fud-bf-reaction-actions");
        const mine = st?.dataset?.fudReactionMootChip === "1";
        if (st && mine && pill.dataset.fudReactionMootPrev != null) {
          st.outerHTML = pill.dataset.fudReactionMootPrev;
        }
        // Dropped either way: a stash nobody restored is stale by definition,
        // and keeping it would let a LATER un-mark write a verdict from two
        // states ago over whatever is current.
        delete pill.dataset.fudReactionMootPrev;
      }
    }
  }
  // Launch button state — marked active while this card carries any override,
  // with the summary in its tooltip. Rebuilt on every delta so it stays true
  // when the OTHER GM edits or clears, and so a GM arriving at a card mid-action
  // can see at a glance that its numbers were touched.
  {
    const btn = rootEl.querySelector("[data-fud-gm-launch]");
    if (btn) {
      const active = !!delta.gmEditSummary;
      btn.classList.toggle("is-active", active);
      // TITLE and ARIA-LABEL are not the same string. The accessible name must
      // stay a VERB — this repaint used to overwrite it with the summary, so
      // after the first recompute the button announced "Edited: accuracy ·
      // fire · damage — Edited by Bob, button": no verb, and no count either,
      // since the count span is aria-hidden. It silently undid what
      // buildGmEditLaunchHTML had just composed.
      const title = active
        ? `Edit this action — Edited: ${delta.gmEditSummary}${delta.gmEditors ? ` — ${delta.gmEditors}` : ""}`
        : "Edit this action";
      const n = Number(delta.gmEditCount) || 0;
      btn.setAttribute("title", title);
      btn.setAttribute("aria-label",
        n ? `Edit this action — ${n} change${n === 1 ? "" : "s"} made` : "Edit this action");
      let dot = btn.querySelector(".fud-gm-launch-dot");
      if (active && !dot) {
        dot = document.createElement("span");
        dot.className = "fud-gm-launch-dot";
        dot.setAttribute("aria-hidden", "true");
        btn.appendChild(dot);
      } else if (!active && dot) dot.remove();
      if (dot) dot.textContent = String(delta.gmEditCount ?? "");
    }
  }

  // Per-target HEAL/RESTORE chips + headline — a performer-side grant reaction
  // (Cognitive Focus adjust_grant "+SL×2 to my focus") boosts the per-target
  // grantAmount. Repaint here (NOT inside the redirect loop, which only touches
  // redirected slots) so the GM card AND the broadcast player mirror stay in
  // sync. Driven purely by the serializable delta (works on the player side too).
  if (Array.isArray(delta.grantRows) && delta.grantRows.length) {
    for (const g of delta.grantRows) {
      if (!g || g.studied === false) continue;
      const rowEl = (g.tokenUuid && rootEl.querySelector(
        `.fud-bf-target-row[data-fud-target-token-uuid="${CSS.escape(String(g.tokenUuid))}"]`
      )) || (g.actorUuid && rootEl.querySelector(
        `.fud-bf-target-row[data-fud-target-actor-uuid="${CSS.escape(String(g.actorUuid))}"]`
      ));
      if (!rowEl) continue;
      const resultSpan = rowEl.querySelector(".t-result");
      if (!resultSpan) continue;
      resultSpan.className = `t-result ${resultClsFor(g)}`;
      resultSpan.innerHTML = resultLabelFor(g);
    }
    // Headline heal number (the `.fud-bf-dmg` fieldset is reused for heals) —
    // re-pin to the representative boosted target so it agrees with the chip.
    if (delta.grantHeadline != null && delta.healHeadlineObj
        && (delta.healHeadlineObj.isHealing || delta.healHeadlineObj.declaresHealing)) {
      const healFieldset = rootEl.querySelector(".fud-bf-dmg");
      if (healFieldset) {
        const oldShown = parseInt(healFieldset.querySelector(".fud-bf-dmg-number")?.textContent ?? "", 10);
        const patchedHeal = { ...delta.healHeadlineObj, base: delta.grantHeadline, finalIfHit: delta.grantHeadline };
        const newHTML = buildDamagePreviewHTML({ damage: patchedHeal, roll: delta.healHeadlineRoll ?? null });
        if (newHTML) {
          healFieldset.outerHTML = newHTML;
          const numEl = rootEl.querySelector(".fud-bf-dmg .fud-bf-dmg-number");
          if (numEl) animateCardNumber(numEl, oldShown, Number(delta.grantHeadline), (v) => setLeadingNumberText(numEl, v));
        }
      }
    }
  }

  // Negated — UNIFIED treatment for both Shadow Possession (negate_action) and
  // Crossfire (adjust_accuracy → accuracyOverride.blocked). Both fully nullify the
  // action; we keep the REAL accuracy/damage/result numbers, dim them, and plaster
  // a red "Negated" overlay over each panel (CSS: .fud-bf-card.is-negated) — instead
  // of the old "Blocked" replace-text + MISS-flip + damage-strike style. Accuracy
  // always shows the real roll total (reverts cleanly when no reaction is active).
  // The outcome is still nullified — negate via RESOLVE's ar.negated, Crossfire via
  // its accuracy=0 per-target recompute. Player mirrors get this via the broadcast.
  // Accuracy override display. A BLOCKING override (Crossfire, to≤0) flows into
  // the "Negated" treatment below — accuracy shows the real roll total, dimmed.
  // A NON-blocking ADDITIVE/SUBTRACTIVE override (e.g. Cognitive Focus "+SL vs
  // my focus") arrives as `delta.accuracyRoll` (the base check with the override
  // folded into checkBonus + checkBonusParts + total). Re-render the whole
  // accuracy fieldset from it via the SAME builder the initial card uses — so
  // the row "+N", the hover Check-Bonus breakdown (itemized per source, like the
  // damage bonus), AND the total all stay consistent and COMPOSE across sources.
  const accFieldset = rootEl.querySelector(".fud-bf-acc")?.closest("fieldset");
  if (delta.accuracyRoll && accFieldset) {
    const legendEl = accFieldset.querySelector("legend");
    const legendText = legendEl ? legendEl.textContent.trim() : null;
    const oldTotal = parseInt(accFieldset.querySelector(".fud-bf-acc .total")?.textContent ?? "", 10);
    accFieldset.outerHTML = buildAccuracyHTML({
      roll: delta.accuracyRoll,
      isSpellish: !!delta.accuracyIsSpellish,
      legendOverride: legendText || null,
    });
    const totalEl = rootEl.querySelector(".fud-bf-acc .total");
    if (totalEl) animateCardNumber(totalEl, oldTotal, Number(delta.accuracyRoll.total), (v) => { totalEl.textContent = String(v); });
  } else {
    const accTotal = rootEl.querySelector(".fud-bf-acc .total");
    if (accTotal && rollTotal != null) accTotal.textContent = String(rollTotal);
  }
  // Cost adjustment (adjust_cost reaction: Hypercognition discount / Cataclysm
  // overcharge) — repaint the subtitle's cost bullet to the EFFECTIVE cost so the
  // card matches the debit RESOLVE will apply (previously the card kept the printed
  // base cost). Both the GM card and the player mirror route through here → the
  // displayed cost stays in sync. Idempotent: with no override this pass (pill
  // toggled off) revert to the printed base cost, mirroring the accuracy reset above.
  const costBullet = rootEl.querySelector(".fud-bf-cost-bullet");
  if (costBullet) {
    const baseText = costBullet.getAttribute("data-fud-base-cost");
    if (delta.cost && delta.cost.effectiveText) {
      const srcs = Array.isArray(delta.cost.parts)
        ? [...new Set(delta.cost.parts.map((p) => p?.source).filter(Boolean))] : [];
      const changed = baseText != null && baseText !== delta.cost.effectiveText;
      costBullet.innerHTML = changed
        ? `<s style="opacity:0.55;">${escapeHtml(baseText)}</s> ${escapeHtml(delta.cost.effectiveText)}`
        : escapeHtml(delta.cost.effectiveText);
      costBullet.setAttribute("title",
        srcs.length ? `Base ${baseText ?? "?"} — adjusted by ${srcs.join(", ")}` : `Base ${baseText ?? "?"}`);
    } else if (baseText != null) {
      costBullet.innerHTML = escapeHtml(baseText);
      costBullet.removeAttribute("title");
    }
  }
  // Study cards have no per-target/damage surfaces — a check-adjusting reaction
  // (Divination reroll / Lucky Seven die-set) changes the total, which changes the
  // encyclopedia tier reached. Repaint the Tier Reached fieldset from the new roll.
  if (delta.study && delta.accuracyRoll) {
    const newRoll = delta.accuracyRoll;
    const tier = classifyStudyTierDisplay(newRoll.total, { isCrit: !!newRoll.isCrit, isFumble: !!newRoll.isFumble });
    const improved = !newRoll.isFumble && (tier.effective ?? newRoll.total) > (Number(delta.study.previousBest) || 0);
    patchStudyTierFieldset(rootEl, { roll: newRoll, tier, previousBest: delta.study.previousBest ?? 0, improved });
  }
  rootEl.querySelector(".fud-bf-acc")?.classList.remove("is-blocked");
  rootEl.querySelector(".fud-bf-dmg")?.classList.remove("is-blocked-dmg");
  const negated = !!delta.negated || !!delta.accuracyOverride?.blocked;
  const cardEl = rootEl.classList?.contains("fud-bf-card") ? rootEl : rootEl.querySelector(".fud-bf-card");
  if (cardEl) {
    const wasNegated = cardEl.classList.contains("is-negated");
    cardEl.classList.toggle("is-negated", negated);
    // Play the one-shot stamp/fade ONLY on the first transition to negated, so
    // it doesn't replay when a later reaction is clicked and this recomputes.
    if (negated && !wasNegated) {
      cardEl.classList.add("is-negated-stamp");
      setTimeout(() => cardEl.classList.remove("is-negated-stamp"), 900);
    } else if (!negated) {
      cardEl.classList.remove("is-negated-stamp");
    }
  }

  // ── Sections below were GM-ONLY in-place patches until the innerHTML mirror
  //    was retired (they were the reason a `.fud-bf-body` dump had to be
  //    broadcast at all). They now travel ON the delta so the player mirror
  //    renders them through this SAME function.
  //
  //    ORDER IS LOAD-BEARING and matches the GM sequence these replaced:
  //    surfaces → result rows → headline → effects. In particular the effects
  //    panel runs LAST because the headline rebuild REPLACES the `.fud-bf-dmg`
  //    element, which would otherwise drop its `is-nullified` strike.

  // 1. Full target-surface rebuild (engagement row / portraits / Result list).
  //    Present only when the target SET changed (redirect, add_target splash,
  //    shield) or a no-damage verdict flipped — not on every recompute, so the
  //    common bonus-toggle delta stays tiny.
  if (delta.surfaces) {
    try {
      rerenderCardTargetSurfaces(rootEl, {
        attacker: delta.surfaces.attacker ?? null,
        targets: delta.surfaces.targets ?? [],
        perTargetResults: delta.surfaces.perTargetResults ?? [],
        element: delta.surfaces.element ?? null,
        roll: delta.surfaces.roll ?? null,
        vsMDef: !!delta.surfaces.vsMDef,
        hasDamage: !!delta.surfaces.hasDamage,
      });
    } catch (e) { warn("applyCardTargetMutationDelta: surface rebuild threw", e); }
  }

  // 2. Non-redirect per-target result spans — the add_damage path (Cheap Shot
  //    bonus toggles, Thermokinesis element overrides). The sender has already
  //    excluded redirected slots (handled by the redirect loop above), grant
  //    rows (not damage) and unstudied rows (masked "???" — painting a result
  //    would leak "HIT N" onto a row whose DEF still reads "???").
  //    Token uuid is tried first: it disambiguates two linked tokens of one actor.
  for (const entry of (Array.isArray(delta.resultRows) ? delta.resultRows : [])) {
    if (!entry) continue;
    const rowEl = (entry.tokenUuid && rootEl.querySelector(
      `.fud-bf-target-row[data-fud-target-token-uuid="${CSS.escape(String(entry.tokenUuid))}"]`
    )) || (entry.actorUuid && rootEl.querySelector(
      `.fud-bf-target-row[data-fud-target-actor-uuid="${CSS.escape(String(entry.actorUuid))}"]`
    ));
    if (!rowEl) continue;
    const resultSpan = rowEl.querySelector(".t-result");
    if (!resultSpan) continue;
    // Reuse the canonical label/class logic so affinity verbs (WEAK / RESIST /
    // NO EFFECT / HEALS) stay in sync everywhere.
    const oldTNum = parseInt(resultSpan.querySelector(".t-num")?.textContent ?? "", 10);
    resultSpan.className = `t-result ${resultClsFor(entry)}`;
    resultSpan.innerHTML = resultLabelFor(entry);
    // Running-number tween on this row's damage figure. No-ops when the row had
    // no number (e.g. was MISS) or the value is unchanged.
    const tNum = resultSpan.querySelector(".t-num");
    if (tNum) animateCardNumber(tNum, oldTNum, Number(tNum.textContent), (v) => { tNum.textContent = String(v); });
    // Sync the affinity badge too — it lives inside `.t-name` (name + badge),
    // is NOT part of `.t-result`, and is built once at render. A reaction
    // element override recomputes each target's affinity, so without this the
    // badge would go stale against the new element while the verb updated.
    const nameSpan = rowEl.querySelector(".t-name");
    if (nameSpan) {
      const aff = buildAffinityTagHTML({ affinity: entry.affinity, hit: entry.hit, studied: entry.studied });
      nameSpan.innerHTML = `${escapeHtml(entry.name ?? "")}${aff ? ` ${aff}` : ""}`;
    }
  }

  // 3. Headline damage fieldset. The sender ships the FINAL damage object (it
  //    needs skill-effects' applyDamageOp to fold the reaction ops into an
  //    itemised breakdown), so this side only renders it.
  if (delta.damageHeadline?.damage) {
    const dmgFieldset = rootEl.querySelector(".fud-bf-dmg");
    if (dmgFieldset) {
      const headlineRoll = delta.damageHeadline.roll ?? null;
      const wasBlocked = dmgFieldset.classList.contains("is-blocked-dmg");
      // Tween FROM what this client currently shows (not from the action's base
      // value): on a second toggle of the same reaction the base would restart
      // the animation from the wrong end. Matches the per-target spans above.
      const oldShown = parseInt(dmgFieldset.querySelector(".fud-bf-dmg-number")?.textContent ?? "", 10);
      const newHTML = buildDamagePreviewHTML({ damage: delta.damageHeadline.damage, roll: headlineRoll });
      if (newHTML) {
        dmgFieldset.outerHTML = newHTML;
        const refreshed = rootEl.querySelector(".fud-bf-dmg");
        if (refreshed && wasBlocked) refreshed.classList.add("is-blocked-dmg");
        // Skip fumbles — they show "—", not a number.
        if (refreshed && !headlineRoll?.isFumble) {
          const numEl = refreshed.querySelector(".fud-bf-dmg-number");
          if (numEl) animateCardNumber(numEl, oldShown, Number(delta.damageHeadline.damage?.finalIfHit), (v) => setLeadingNumberText(numEl, v));
        }
      }
    }
  }

  // 4. Reaction Effects panel + damage-nullify strike. Always present on the
  //    delta (it is a few bytes) so it re-asserts `is-nullified` after the
  //    headline rebuild above replaced the element.
  if (delta.effectPreview && cardEl) {
    try { renderReactionEffectPreview(cardEl, delta.effectPreview); }
    catch (e) { warn("applyCardTargetMutationDelta: effect preview threw", e); }
  }

  // Panel rails go LAST: the accuracy and damage fieldsets are REBUILT from
  // HTML further up this same function when a mutation changes the roll, which
  // discards any class set on them beforehand. Marking them after every rebuild
  // is the only placement that survives.
  // Accuracy / damage edits have no per-target row to mark, so rail the PANEL
  // instead. Without this a hand-set accuracy total looked exactly like a rolled
  // one — the only tell was a 26px icon in the card's corner.
  {
    // `.fud-bf-acc` is a DIV *inside* the accuracy fieldset (only the damage
    // fieldset carries its own class), so climb to the enclosing fieldset —
    // marking the inner div left the rail with nothing to draw on.
    const acc = rootEl.querySelector(".fud-bf-acc")?.closest("fieldset.fud-bf-section");
    const dmg = rootEl.querySelector("fieldset.fud-bf-dmg")
      ?? rootEl.querySelector(".fud-bf-dmg")?.closest("fieldset.fud-bf-section");
    acc?.classList?.toggle("is-gm-edited", !!delta.gmRollEdited);
    dmg?.classList?.toggle("is-gm-edited", !!delta.gmDamageEdited);
  }
  // Re-fit last: a delta can add a target row, inject a reaction pill or rebuild
  // the whole target surface, any of which changes what the growing regions need.
  // Runs on the GM card and on every mirror, since both come through here.
  fitActionCardToViewport(rootEl.closest?.(`#${ROOT_ID}, #${MIRROR_ROOT_ID}`) ?? rootEl);
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

  // A magic-damage weapon (Arc Wand: `defense_target_type: "mdef"`) resolves its
  // Attack vs Magic Defense — surface that on the card (Magic accuracy icon + MDEF
  // labels) so the display matches what COMPUTE actually compared against. `isSpell`
  // is false for an Attack, so the weapon tag is the only thing that flips it.
  const vsMDef = resolvesVsMagicDefense({ defenseTargetType: weapon?.defenseTargetType, isSpell: false });

  return {
    titleIcon,
    titleText,
    subtitle,
    portraits: tryBuild("portraits", () => buildPortraitsHTML({ attacker, perTargetResults })),
    body: `
      ${tryBuild("attacker", () => buildAttackerHTML({ attacker, targets }))}
      ${tryBuild("accuracy", () => buildAccuracyHTML({ roll, isSpellish: vsMDef }))}
      ${tryBuild("damage", () => buildDamagePreviewHTML({ damage, roll }))}
      ${tryBuild("perTarget", () => buildPerTargetHTML({ perTargetResults, weapon, element: damage?.element, roll, isSpellish: vsMDef }))}
      ${tryBuild("attackEffect", () => buildEffectSectionHTML({ descriptionHtml: weapon?.descriptionHtml }))}
    `,
    buttons: buildButtonsHTML({ isFumble: !!roll?.isFumble, invokeCapability: attacker?.invokeCapability ?? "full", invokePointCount: attacker?.invokePointCount ?? null }),
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

  // Reaction surface is rendered uniformly by the central card spawner
  // (via `payload.cardReactions` → `buildReactionPillRow`). State-handlers
  // CONFIRM populates `cardReactions` for Guard via findPassiveCandidates
  // with trigger `creature_guards`. No per-card duplication needed.

  return {
    titleIcon: `<i class="fa-solid fa-shield-halved" style="font-size:20px; color:var(--fud-stroke,#7a6a55);"></i>`,
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

// ─── Ultima action cards (Boss/Villain — Domination / Escape / Recovery) ───
// Simple no-roll declaration cards, one builder for all three. Cost chips
// come from ar.ultimaCost / ar.dominanceCost (stamped in TARGET); the debit
// happens at RESOLVE. Rulebook p.101 + the homebrew Domination action.
const ULTIMA_CARD_DEFS = {
  Domination: {
    icon: `<i class="fa-solid fa-fire-flame-curved" style="font-size:20px; color:#c81010;"></i>`,
    subtitle: "Ultima Action<span class=\"dot\">•</span>Free Action<span class=\"dot\">•</span>Until end of round",
    effect: `Enters <strong style="color:#c81010">Domination State</strong> for the rest of the round:
      debuffs that prevent or restrict actions <strong>stay applied but have no effect</strong>
      (Frightened, Silence, Berserk, Fatigue, Charmed, Provoked, Grappled, ...).
      <div style="margin-top:4px;">This is a <strong>free action</strong> — the turn action is not spent.</div>`,
  },
  Escape: {
    icon: `<i class="fa-solid fa-person-running" style="font-size:20px; color:#7a6a55;"></i>`,
    subtitle: "Ultima Action<span class=\"dot\">•</span>Leaves the battle",
    effect: `Safely <strong>leaves the scene</strong> — the Game Master describes how.
      Any remaining henchmen keep the heroes company.`,
  },
  Recovery: {
    icon: `<i class="fa-solid fa-heart-pulse" style="font-size:20px; color:#48c774;"></i>`,
    subtitle: "Ultima Action<span class=\"dot\">•</span>Costs the Action",
    effect: `Recovers from <strong>all status effects</strong> and recovers <strong>50 Mind Points</strong>.`,
  },
};

function buildUltimaCard(kind, { attacker, ultimaCost = 1, dominanceCost = 0 }) {
  const def = ULTIMA_CARD_DEFS[kind];
  if (!def) return null;
  const costChips = [
    `<span style="display:inline-block; padding:2px 8px; border:1px solid #7a2020; border-radius:8px; color:#c81010; font-weight:800;">${ultimaCost} Ultima Point</span>`,
    ...(dominanceCost > 0
      ? [`<span style="display:inline-block; padding:2px 8px; border:1px solid #7a5220; border-radius:8px; color:#b06a10; font-weight:800;">${dominanceCost} Dominance Point</span>`]
      : []),
  ].join(" ");
  return {
    titleIcon: def.icon,
    titleText: kind,
    subtitle: `<div class="fud-bf-subtitle">${def.subtitle}</div>`,
    portraits: tryBuild("portraits", () => buildPortraitsHTML({ attacker, perTargetResults: [] })),
    body: `
      <fieldset class="fud-bf-section">
        <legend>Villain</legend>
        <div class="fud-bf-attacker-row">
          <div class="left">${escapeHtml(attacker?.name ?? "?")}</div>
          <div class="mid">${def.icon}</div>
          <div class="right">${escapeHtml(kind)}</div>
        </div>
      </fieldset>
      <fieldset class="fud-bf-section" style="font-size:12.5px; line-height:1.5;">
        <legend>Effect</legend>
        ${def.effect}
      </fieldset>
      <fieldset class="fud-bf-section" style="font-size:12.5px;">
        <legend>Cost</legend>
        ${costChips}
      </fieldset>
    `,
    buttons: `
      <div class="fud-bf-btn-row">
        <div class="fud-btn fud-btn-confirm" data-fud-action="confirm" role="button" tabindex="0">Confirm</div>
        <div class="fud-btn fud-btn-cancel" data-fud-action="cancel" role="button" tabindex="0">Cancel</div>
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

// Re-derive the Study tier from a (possibly modified) check total. The encyclopedia
// module owns the authoritative ladder (crit-aware floor to Details); this mirrors
// computeStudy's own resolution so an Invoke/Divination/Lucky-Seven roll change can
// repaint the tier without a full card rebuild. Falls back to the inline ladder if
// the API isn't reachable (defensive — it always is at runtime).
export function classifyStudyTierDisplay(total, { isCrit = false, isFumble = false } = {}) {
  const t = Number(total) || 0;
  const enc = globalThis.FUCompanion?.api?.encyclopedia;
  if (enc?.classifyStudyTotal) {
    try { return enc.classifyStudyTotal(t, { isCrit, isFumble }); } catch { /* fall through */ }
  }
  if (isFumble) return { name: "None", threshold: 0, fumbled: true, effective: t };
  const eff = isCrit ? Math.max(t, 13) : t;
  if (eff >= 13) return { name: "Details",  threshold: 13, fumbled: false, effective: eff };
  if (eff >= 8)  return { name: "Stats",    threshold: 8,  fumbled: false, effective: eff };
  if (eff >= 7)  return { name: "Identity", threshold: 7,  fumbled: false, effective: eff };
  return { name: "None", threshold: 0, fumbled: false, effective: eff };
}

// The "Tier Reached" fieldset — factored out of buildStudyCard so a post-roll
// intervention (Invoke Trait/Bond, Divination reroll, Lucky Seven die-set) can
// repaint just this section from the new total via patchStudyTierFieldset.
function buildStudyTierFieldsetHTML({ roll, tier, previousBest }) {
  const tierName = tier?.name ?? "None";
  const tierColor = STUDY_TIER_COLOR[tierName] ?? STUDY_TIER_COLOR.None;
  const previousTierName = tierNameForBest(previousBest ?? 0);
  // "New tier unlocked" celebrates only an actual tier crossing — a roll that
  // bumped the best number but stayed in the same tier reveals no new info.
  const tierAdvanced = !roll?.isFumble && tierName !== previousTierName && tierName !== "None";
  const tierLine = roll?.isFumble
    ? `<span style="color:#9a4a4a;">Fumble — no information gained.</span>`
    : tierAdvanced
      ? (previousTierName === "None"
          ? `First tier unlocked: <em>${escapeHtml(tierName)}</em>.`
          : `New tier unlocked: <em>${escapeHtml(tierName)}</em> (was <em>${escapeHtml(previousTierName)}</em>).`)
      : `Already known to <em>${escapeHtml(previousTierName)}</em> tier — no new info.`;
  return `
      <fieldset class="fud-bf-section fud-bf-study-tier">
        <legend>Tier Reached</legend>
        <div style="font-size:18px; font-weight:900; color:${tierColor}; text-align:center; letter-spacing:0.5px;">
          ${escapeHtml(tierName)}${tier?.threshold ? ` <span style="font-size:12px; opacity:0.7; font-weight:700;">(≥ ${tier.threshold})</span>` : ""}
        </div>
        <div style="font-size:12px; text-align:center; opacity:0.85; margin-top:4px;">
          ${tierLine}
        </div>
      </fieldset>
    `;
}

// Repaint the live Study card's Tier Reached fieldset (and the Confirm/Record
// label) after a roll-changing intervention. Runs on the GM card AND every mirror
// (invoke's patchCardDom broadcast + the mutation delta broadcast both reach here).
export function patchStudyTierFieldset(rootEl, { roll, tier, previousBest, improved }) {
  if (!rootEl) return;
  try {
    const fieldset = rootEl.querySelector(".fud-bf-study-tier");
    if (fieldset) fieldset.outerHTML = buildStudyTierFieldsetHTML({ roll, tier, previousBest });
    // The Confirm button reads "Record Study" only when this Study improved on the
    // target's best-known tier; a reroll that changes that must relabel it.
    const confirmBtn = rootEl.querySelector(".fud-btn-confirm");
    if (confirmBtn) confirmBtn.textContent = (improved && !roll?.isFumble) ? "Record Study" : "Confirm";
  } catch (e) { warn("patchStudyTierFieldset threw", e); }
}

function buildStudyCard({ attacker, target, roll, tier, previousBest, improved }) {
  // Portrait slots: studier on the player side, target on the enemy side.
  // Reuse pickPortraitSlots by handing it a synthetic per-target list.
  const targetForPortraits = target
    ? [{ tokenImg: target.tokenImg, name: target.name, disposition: target.disposition }]
    : [];

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
      ${tryBuild("studyTier", () => buildStudyTierFieldsetHTML({ roll, tier, previousBest }))}
    `,
    // Invoke Trait/Bond apply to the Study's open Check the same way they apply to
    // an attack roll — a reroll or flat bond bonus raises the total, which raises
    // the encyclopedia tier reached. Locked on a Fumble (RAW) and by actor rank.
    buttons: buildButtonsHTML({
      isFumble: !!roll?.isFumble,
      hasRoll: !!roll,
      invokeCapability: attacker?.invokeCapability ?? "full",
      invokePointCount: attacker?.invokePointCount ?? null,
      confirmLabel: (improved && !roll?.isFumble) ? "Record Study" : "Confirm",
    }),
  };
}

function buildEquipmentCard({ attacker, attackerActor, round, allowArmor = false }) {
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
    ? tryBuild("equipment-slots", () => gatherEquipmentSlots(attackerActor, { round: round ?? null, includeArmor: !!allowArmor }))
    : { slots: [] };

  const groupOf = (key) =>
    (key === "main" || key === "off") ? "hand"
    : (key === "armor") ? "armor"   // its own group — never dedups vs accessories
    : "acc";

  const emptyLabelOf = (key) =>
    (key === "main" || key === "off") ? "Empty Hand"
    : (key === "armor") ? "No Armor"
    : "No Accessory";
  const emptySubtitleOf = (key) =>
    (key === "main" || key === "off") ? "No weapon equipped"
    : (key === "armor") ? "Unarmored"
    : "Slot is open";
  const emptyIconOf = (key) =>
    (key === "main" || key === "off") ? "✋"
    : (key === "armor") ? "🛡️"
    : "—";

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

  // ── Transform section ──────────────────────────────────────────────────
  // A worn weapon that defines ≥2 FORMS (e.g. Zarg's Bow: Physical ⇄ Light)
  // gets a chip row to pick its active form. The form keeps the SAME weapon
  // (its skills are retained); only its projected stats change. Picks are
  // collected on Done as { main, off } → formIndex and applied in RESOLVE.
  const formRows = slots
    .filter((s) => (s.key === "main" || s.key === "off") && Array.isArray(s.forms) && s.forms.length > 1)
    .map((slot) => {
      // Weapon icon (same for every form of the slot) — shown in the hover.
      const wepImg = (slot.candidates ?? []).find((c) => c.id === slot.currentItemId)?.img ?? null;
      const chips = slot.forms.map((f) => {
        // Hover-only detail: element / weapon type / accuracy + damage bonus,
        // reusing the equip dwell-tooltip (data-fud-equip-stats / -desc), so the
        // chip itself shows ONLY the form name. The same selector is wired on
        // both the GM card and the player mirror.
        const traits = [];
        if (f.element) traits.push(`<span class="fud-bf-desc-tip-stat-trait">${escapeHtml(f.element)}</span>`);
        if (f.weaponType) traits.push(`<span class="fud-bf-desc-tip-stat-trait">${escapeHtml(cap(f.weaponType))}</span>`);
        traits.push(`<span class="fud-bf-desc-tip-stat-acc">ACC ${f.checkBonus >= 0 ? "+" : ""}${f.checkBonus}</span>`);
        traits.push(`<span class="fud-bf-desc-tip-stat-dmg">DMG ${f.damageBonus >= 0 ? "+" : ""}${f.damageBonus}</span>`);
        const iconHTML = wepImg
          ? `<div style="width:34px;height:34px;flex:0 0 auto;border-radius:6px;border:1px solid var(--fud-stroke,#7a6a55);background-size:cover;background-position:center;background-image:url('${escapeHtml(safeImgUrl(wepImg))}')"></div>`
          : "";
        const descBody = `<div style="display:flex;align-items:center;gap:8px;">${iconHTML}<span>${escapeHtml(slot.currentName)} · ${escapeHtml(f.label)} form</span></div>`;
        return `
        <div class="fud-bf-form-chip ${f.idx === slot.activeForm ? "is-active" : ""}"
             data-fud-form-idx="${f.idx}" role="button" tabindex="0"
             data-fud-equip-desc-name="${escapeHtml(f.label)}"
             data-fud-equip-stats="${escapeHtml(traits.join(""))}"
             data-fud-equip-desc="${escapeHtml(descBody)}">
          <span class="fud-bf-form-label">${escapeHtml(f.label)}</span>
        </div>`;
      }).join("");
      const slotName = slot.label === "Off Hand" ? "Off-Hand Form" : "Main-Hand Form";
      return `
        <div class="fud-bf-form-row"
             data-fud-form-slot="${escapeHtml(slot.key)}"
             data-fud-form-current="${slot.activeForm}"
             data-fud-form-initial="${slot.activeForm}"
             data-fud-form-free-avail="${slot.freeAvail ? "1" : "0"}">
          <div class="fud-bf-equip-label">${escapeHtml(slotName)}<span class="dot">•</span><span style="opacity:.65; font-weight:600;">${escapeHtml(slot.currentName)}</span></div>
          <div class="fud-bf-form-chips">${chips}</div>
        </div>`;
    }).join("");
  const formHTML = formRows
    ? `<fieldset class="fud-bf-section">
        <legend>Transform</legend>
        ${formRows}
      </fieldset>`
    : "";

  return {
    titleIcon: `<i class="fa-solid fa-toolbox" style="font-size:20px; color:var(--fud-stroke,#7a6a55);"></i>`,
    titleText: "Equipment",
    subtitle: `<div class="fud-bf-subtitle">Swap any items<span class="dot">•</span>${allowArmor ? "Armor swap enabled (debug)" : "No armor mid-combat"}</div>`,
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
      ${formHTML}
    `,
    buttons: `
      <div class="fud-bf-equip-econ">
        <span class="fud-bf-equip-free-ind is-none">No changes — returns to menu</span>
      </div>
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

export function buildItemCard({ attacker, attackerActor, itemCandidates, ip }) {
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
    titleIcon: `<i class="fa-solid fa-flask" style="font-size:20px; color:var(--fud-stroke,#7a6a55);"></i>`,
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

  // RAW: the GM tells the player whether they succeeded — they DO NOT
  // reveal the Difficulty Level. Hide `dl` from the result text so the
  // player can't trivially deduce the DL by comparing their roll total to
  // the threshold (the roll total is still visible in the accuracy
  // widget, which is intentional — they know what they rolled, just not
  // what they needed to beat).
  //
  // The status CHOICE is no longer a bespoke card grid: on Confirm, RESOLVE
  // fires Common/Hinder's open_action_menu (rendered by the shared option
  // picker with per-status icons + colors), exactly like any menu skill.
  const resultBox = success
    ? `<fieldset class="fud-bf-section">
        <legend>Result</legend>
        <div style="font-size:16px; font-weight:900; color:#2a6e3d; text-align:center; letter-spacing:0.5px;">
          Success!
        </div>
        <div style="font-size:12px; text-align:center; opacity:0.85; margin-top:4px;">
          Confirm to choose a status for <strong>${escapeHtml(target?.name ?? "target")}</strong>.
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

  const buttonsHTML = `<div class="fud-bf-btn-row">
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
  const costIdx = rawCost ? bullets.push(escapeHtml(rawCost)) - 1 : -1;
  if (!bullets.length) return "";
  // Wrap each bullet so the cost line ("5 x T MP") + element pills don't
  // line-break mid-token when the card is narrower than the joined text. The
  // cost bullet gets a stable hook (`fud-bf-cost-bullet`) + its printed base
  // string so a live adjust_cost reaction (Hypercognition discount / Cataclysm
  // overcharge) can repaint it to the EFFECTIVE cost — see the cost block in
  // applyCardTargetMutationDelta — and cleanly revert when the pill is toggled off.
  const wrapped = bullets.map((b, i) => {
    const isCost = i === costIdx;
    return `<span class="bullet${isCost ? " fud-bf-cost-bullet" : ""}"${isCost ? ` data-fud-base-cost="${escapeHtml(rawCost)}"` : ""}>${b}</span>`;
  });
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
// Build just the pill elements (no row wrapper) for a candidate list. Shared by
// the initial row render and the cascade-injection append path so dynamically
// added reactions (Bullet Break after Crossfire) render identically.
function buildReactionPills(cardReactions) {
  // Hide "off" (auto-rejected). Show "on" + "force" + "ask" — Force-mode
  // is engine-mandatory, no player decision, but the effect is often
  // player-meaningful (Bodyguard grants RS to all damage, etc.) so it
  // surfaces informationally with the same "Active" label as On. RESOLVE
  // still fires Force from the decision map regardless of UI state.
  // Hide "off" (auto-rejected) and CONDITION-unavailable rows (their trigger
  // doesn't apply — surfacing them is noise / can leak state). COST-unavailable
  // rows DO surface, rendered dimmed with the cost reason ("Low IP") so the
  // player sees the reaction exists and why they can't use it (vs it silently
  // vanishing).
  const visible = cardReactions.filter((p) =>
    p?.mode !== "off" && !(p?.available === false && p?.unavailableKind === "condition")
  );
  if (!visible.length) return "";
  // Collapse duplicate AUTO (on/force) pills from the SAME carrier+reactor into
  // one informational chip. A skill with multiple force rows (e.g. Adversity's
  // creature_performs_action accuracy row + creature_will_deal_damage damage row)
  // otherwise renders one "Active" pill per row. RESOLVE still fires every row
  // from the decision map — this is display-only. Ask / cost-unavailable pills
  // are NOT collapsed (each carries a distinct per-row decision or reason badge).
  const seenAuto = new Set();
  const deduped = visible.filter((p) => {
    const isAuto = isAutoFireReactionMode(p.mode) && p.available !== false;
    if (!isAuto) return true;
    const key = `${p.carrierUuid ?? p.carrierName ?? ""}::${p.reactorActorUuid ?? "self"}`;
    if (seenAuto.has(key)) return false;
    seenAuto.add(key);
    return true;
  });
  return deduped.map((p) => {
    const safeName = escapeHtml(p.carrierName ?? "Reaction");
    const safeKey  = escapeHtml(String(p.rowKey ?? ""));
    const safeCarrier = escapeHtml(String(p.carrierUuid ?? ""));
    const iconHtml = p.carrierImg
      ? `<img class="fud-bf-reaction-icon" src="${escapeHtml(p.carrierImg)}" alt="" />`
      : `<span class="fud-bf-reaction-icon" aria-hidden="true">⚡</span>`;
    const modeLabel =
      p.mode === "on"    ? "Active"            :
      p.mode === "force" ? "Active"            :
      p.mode === "off"   ? "Disabled"          :
                           "Asks (You choose)";

    // Third-party reaction (Protect on an Attack(ally) card) — the
    // reactor is NOT the action-taker. Render the reactor's name on its
    // OWN line above the skill name (two-line name block), and stamp a
    // side-color class (pc-side vs npc-side per `reactorIsPlayer`) so
    // monster-side reactions are visually distinct from party-side ones.
    const isThirdParty = !!p.reactorActorUuid;
    const reactorLine = isThirdParty
      ? `<span class="fud-bf-reaction-reactor">${escapeHtml(String(p.reactorActorName ?? "Reactor"))}</span>`
      : "";
    // Reactor on line 1 (when present), skill name on line 2.
    const nameBlock =
      `<div class="fud-bf-reaction-namewrap">${reactorLine}<span class="fud-bf-reaction-name">${safeName}</span></div>`;
    const sideClass = isThirdParty
      ? (p.reactorIsPlayer ? "is-third-party is-side-pc" : "is-third-party is-side-npc")
      : "";
    const reactorAttr = isThirdParty
      ? ` data-fud-reactor-uuid="${escapeHtml(String(p.reactorActorUuid))}"`
      : "";
    // Per-pill owner — the active non-GM user who owns the REACTOR (not
    // the action-taker). Drives mirror-side interactivity: a player may
    // apply ONLY the reaction pills carried by a creature they own, even
    // when the GM or another player owns the action being reacted to.
    // Empty when no player owns the reactor (GM creature) — then only the
    // GM's real card can apply it. See [[director-player-driven-input]].
    const ownerAttr = p.reactorOwnerUserId
      ? ` data-fud-reaction-owner="${escapeHtml(String(p.reactorOwnerUserId))}"`
      : "";

    // Skill descriptions in CSB are rich HTML; trusted (local actor
    // data, not user input). Bundle a mode footer chip so the player
    // sees the dispatch behavior without leaving the card.
    const descBody =
      (p.carrierDescription ?? "") +
      `<div class="fud-bf-reaction-tip-foot">Mode: ${escapeHtml(modeLabel)}</div>`;
    const tipAttrs =
      ` data-fud-equip-desc="${escapeHtml(descBody)}" data-fud-equip-desc-name="${safeName}"`;
    // Cost-unavailable → dimmed, non-interactive pill showing the reason badge
    // ("Low IP"). No Apply/Skip (nothing to do) and not auto-applied (the
    // on/force auto-accept skips available===false). Condition-unavailable was
    // already filtered out above.
    if (p.available === false) {
      const reason = escapeHtml(p.unavailableReason ?? "Unavailable");
      return `
        <div class="fud-bf-reaction-pill is-unavailable ${sideClass}" data-fud-reaction-key="${safeKey}" data-fud-reaction-carrier="${safeCarrier}"${reactorAttr}${ownerAttr}${tipAttrs} aria-disabled="true">
          ${iconHtml}
          ${nameBlock}
          <span class="fud-bf-reaction-status fud-bf-reaction-reason">${reason}</span>
        </div>`;
    }
    if (isAutoFireReactionMode(p.mode)) {
      return `
        <div class="fud-bf-reaction-pill is-auto ${sideClass}" data-fud-reaction-key="${safeKey}" data-fud-reaction-carrier="${safeCarrier}"${reactorAttr}${ownerAttr}${tipAttrs}>
          ${iconHtml}
          ${nameBlock}
          <span class="fud-bf-reaction-status">Active</span>
        </div>`;
    }
    // Only THIRD-PARTY ask pills (reactor ≠ action-taker: a monster/ally
    // reacting) gate the action-taker's Confirm. The owner's OWN performer/self
    // ask pills stay applicable but must NOT lock their Confirm — flagged here so
    // the pending-counter paths (assemble/commit/cascade/resolve/restore) can
    // count only the gating ones. See [[director-player-driven-input]].
    const gatingAttr = isThirdParty ? ` data-fud-reaction-gating="1"` : "";
    return `
      <div class="fud-bf-reaction-pill is-ask ${sideClass}" data-fud-reaction-key="${safeKey}" data-fud-reaction-carrier="${safeCarrier}"${reactorAttr}${ownerAttr}${gatingAttr} data-fud-reaction-pending="1"${tipAttrs}>
        ${iconHtml}
        ${nameBlock}
        <div class="fud-bf-reaction-actions">
          <div class="fud-btn fud-btn-reaction fud-btn-reaction-apply" data-fud-reaction-action="apply" role="button" tabindex="0">Apply</div>
          <div class="fud-btn fud-btn-reaction fud-btn-reaction-skip" data-fud-reaction-action="skip" role="button" tabindex="0">Skip</div>
        </div>
      </div>`;
  }).join("");
}

function buildReactionPillRow(cardReactions) {
  const pillsHtml = buildReactionPills(cardReactions);
  if (!pillsHtml) return "";
  return `
    <div class="fud-bf-reactions-row">
      <div class="fud-bf-reactions-label">Reactions</div>
      <div class="fud-bf-reactions-list">${pillsHtml}</div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
// Effect section — Action Keyword headline + status chips + prose
// ─────────────────────────────────────────────────────────────────────
//
// A skill/attack description is authored prose with embedded content-links
// (e.g. <a data-uuid="JournalEntry.…">Unleash</a>). We classify each link via
// the static keyword-registry:
//   - keyword → promoted to a prominent badge in a row above the prose (the
//     card-game keyword headline) and removed from the body.
//   - status  → swapped inline for a small clickable chip (icon + name).
//   - unknown → flattened to plain text (no dead Foundry link in the overlay).
// Every chip carries `data-fud-kw="<registry-key>"` so the card click handler
// can open the explanation tooltip (and director-ui-sfx plays the click cue).

// Build the small icon prefix for a term from a registry entry. Returns ""
// when the icon URL is missing or unsafe for inline src injection.
function chipIconHTML(icon) {
  const safe = safeImgUrl(icon);
  return safe ? `<img class="fud-kw-term-icon" src="${escapeHtml(safe)}" alt="">` : "";
}

// Action Keyword — diamond bullet + icon + bold/underline uppercase label.
// Exported so other surfaces (Treasure Roulette's equip comparison) can render
// the SAME keyword chips this card does — they carry the shared `fud-kw-term`
// styling and tooltip wiring, so a chip looks and behaves identically wherever
// it appears. Pure render, no behaviour change for BD.
export function keywordChipHTML({ key, label, icon }) {
  return `<span class="fud-kw-term is-keyword" role="button" tabindex="0" data-fud-kw="${escapeHtml(key)}">`
    + `<span class="fud-kw-bullet" aria-hidden="true">◆</span>`
    + `${chipIconHTML(icon)}`
    + `<span class="fud-kw-label">${escapeHtml(label)}</span></span>`;
}

// Status term — icon + bold/underline label, inline in the prose.
function statusChipHTML({ key, label, icon }) {
  return `<span class="fud-kw-term is-status" role="button" tabindex="0" data-fud-kw="${escapeHtml(key)}">`
    + `${chipIconHTML(icon)}`
    + `<span class="fud-kw-label">${escapeHtml(label)}</span></span>`;
}

// Parse a description HTML string: extract Action Keywords, swap status links
// for chips, flatten unknown links. Returns { keywords:[{key,label,icon}],
// bodyHtml:string }. Never throws — on any failure falls back to the old
// plain-text strip so the Effect section still renders something.
// Exported alongside keywordChipHTML — the roulette's equip panel renders the
// parsed pieces in its own parchment layout rather than BD's <fieldset>, so it
// takes the PARSER and not buildEffectSectionHTML. One description pipeline,
// two presentations.
export function parseEffectDescription(html) {
  const empty = { keywords: [], bodyHtml: "" };
  if (!html) return empty;
  try {
    const root = document.createElement("div");
    root.innerHTML = String(html);

    const keywords = [];
    const seenKw = new Set();

    for (const a of Array.from(root.querySelectorAll("a.content-link[data-uuid], a[data-uuid]"))) {
      const uuid = a.getAttribute("data-uuid") || "";
      const text = (a.textContent || "").trim();
      const entry = lookupTerm(uuid) || lookupTerm(text);

      // Prefer the link's own text for the displayed label (e.g. "Ice Shield"
      // when the variant shares the base "Shield" journal uuid); fall back to
      // the registry label for plain-text matches.
      const label = text || entry?.label || "";

      if (entry?.kind === "keyword") {
        const key = entry.key ?? uuid;
        const dedup = `${key}|${label}`;
        if (!seenKw.has(dedup)) {
          seenKw.add(dedup);
          keywords.push({ key, label, icon: entry.icon ?? null });
        }
        a.remove();
        continue;
      }
      if (entry?.kind === "status") {
        const span = document.createElement("span");
        span.innerHTML = statusChipHTML({ key: entry.key ?? uuid, label, icon: entry.icon ?? null });
        a.replaceWith(span.firstElementChild ?? document.createTextNode(text));
        continue;
      }
      // Unknown link — drop the anchor, keep its text.
      a.replaceWith(document.createTextNode(text));
    }

    // Tidy up: a leading keyword list (<ul><li><a>Unleash</a></li></ul>) is now
    // empty after keyword extraction — strip empty list items / lists so the
    // prose doesn't start with a stray bullet.
    for (const li of Array.from(root.querySelectorAll("li"))) {
      if (!li.textContent.trim() && !li.querySelector("img, .fud-bf-effect-chip")) li.remove();
    }
    for (const ul of Array.from(root.querySelectorAll("ul, ol"))) {
      if (!ul.querySelector("li")) ul.remove();
    }

    const bodyHtml = root.innerHTML.trim();
    return { keywords, bodyHtml };
  } catch (e) {
    warn("parseEffectDescription threw — falling back to plain text", e);
    return { keywords: [], bodyHtml: escapeHtml(stripHtmlForDesc(html)) };
  }
}

// Build the full Effect <fieldset> (keyword headline row + status-chip prose)
// shared by buildSkillCard and buildAttackCard. Returns "" when there is no
// keyword and no body content.
function buildEffectSectionHTML({ descriptionHtml }) {
  const { keywords, bodyHtml } = parseEffectDescription(descriptionHtml);
  const hasBody = !!bodyHtml && !!stripHtmlForDesc(bodyHtml);
  if (!keywords.length && !hasBody) return "";

  const keywordRow = keywords.length
    ? `<div class="fud-bf-keyword-row">${keywords.map(keywordChipHTML).join("")}</div>`
    : "";
  // Classed, not just inline-styled: this is the one Effect panel whose height
  // is unbounded (authored prose), so it is one of the three regions that
  // scrolls internally rather than pushing the card off the screen.
  const bodyBlock = hasBody
    ? `<div class="fud-bf-effect-body" style="font-size:11.5px; line-height:1.5; opacity:0.92;">${bodyHtml}</div>`
    : "";
  return `<fieldset class="fud-bf-section fud-bf-effect">
        <legend>Effect</legend>
        ${keywordRow}${bodyBlock}
      </fieldset>`;
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
  const vsMDef = resolvesVsMagicDefense({ defenseTargetType, isSpell: isSpellish });

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

  // Effect section — Action Keyword headline + status chips + prose. Shared
  // with buildAttackCard via buildEffectSectionHTML so keywords/statuses render
  // identically wherever a description appears.
  const descHTML = tryBuild("skillEffect", () => buildEffectSectionHTML({ descriptionHtml }));

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
    buttons: buildButtonsHTML({ isFumble: !!roll?.isFumble, hasRoll: !!roll, invokeCapability: attacker?.invokeCapability ?? "full", invokePointCount: attacker?.invokePointCount ?? null }),
  };
}

// Re-render the card BODY in place from the (mutated) payload, using the SAME
// kind-dispatched builder the spawn path uses. This is the single source of
// truth for post-spawn result changes (Potion Rain heal-spread, and any future
// add_target / Crossfire / recompute): a mutation updates `payload` + the
// director's actionResult, then calls this — instead of hand-patching individual
// panels (which is how the RESTORE headline drifted from the per-target rows).
// Header (portraits/title), reaction pills, and buttons are siblings of
// `.fud-bf-body` and are deliberately left untouched so pill/decision state
// survives the re-render. Returns the rebuilt body HTML (for mirror broadcast)
// or null on failure.
function rerenderActionCardBody(root, kind, payload) {
  const bodyEl = root?.querySelector?.(".fud-bf-body");
  if (!bodyEl) return null;
  let card = null;
  try {
    // Shared composer; unknown kinds fall back to the Skill card (legacy behavior).
    card = composeActionCardObject({ kind, payload }) ?? buildSkillCard(payload);
  } catch (e) {
    warn("rerenderActionCardBody: builder threw", e);
    return null;
  }
  if (!card?.body) return null;
  bodyEl.innerHTML = card.body;
  return card.body;
}

// Single source of truth for the kind→builder dispatch. Shared by the spawn
// path (postActionCard), the in-place re-render (rerenderActionCardBody), and
// the test harness's render-capture — so the HTML the harness asserts on is
// byte-for-byte what production renders. Returns null for unknown kinds; the
// caller supplies its own fallback.
export function composeActionCardObject({ kind, payload }) {
  switch (kind) {
    case "Attack":    return buildAttackCard(payload);
    case "Guard":     return buildGuardCard(payload);
    case "Study":     return buildStudyCard(payload);
    case "Hinder":    return buildHinderCard(payload);
    case "Equipment": return buildEquipmentCard(payload);
    case "Skill":
    case "Objective": // skill-shaped: backing Item, optional Check, effect_table
    case "Item":      return buildSkillCard(payload);
    case "Domination":
    case "Escape":
    case "Recovery":  return buildUltimaCard(kind, payload);
    default:          return null;
  }
}

// Single source of truth for the SET of fields the card builders read off the
// frozen actionResult. Both production CONFIRM (state-handlers.js) and the test
// harness derive their postActionCard payload from this, so a builder that
// starts reading a new `ar.*` field can't silently degrade in one path but not
// the other — that exact drift mislabeled a captured spell card's MDEF row as
// "DEF" (skillType was missing from the harness payload). Callers override the
// few fields they own/derive: CONFIRM swaps in the invoke-stamped attacker,
// post-splice targets/perTargetResults, the live cardReactions, and the
// onAddTargetApply callback; the harness uses these defaults as-is.
// The exact set of (serializable, snapshot-only) fields the card builders read.
// `cardReactions` is handled separately (acceptedCardReactions fallback) and the live
// `attackerActor` doc is deliberately NOT here — only buildEquipmentCard reads it,
// and Equipment stays on the HTML-broadcast path (see projectActionCardRenderPayload
// + ACTION_CARD_LOCAL_RENDER_KINDS). Keep this list and the builders' destructures
// in lockstep: a builder that starts reading a new `ar.*` field must add it here.
const ACTION_CARD_RENDER_KEYS = [
  "attacker", "weapon", "targets", "roll", "damage", "perTargetResults",
  "attackMode", "passIndex", "totalPasses",
  // Guard / Study / Hinder / Item:
  "coverTarget", "target", "tier", "previousBest", "improved", "dl", "success",
  "itemCandidates", "ip",
  // Does this action roll accuracy at all? The canonical capability flag — never
  // re-derive it as kind==="Attack"||isCheck. Needed by the mid-card targeted
  // re-derive to compute `defenseResolved` the same way CONFIRM does.
  "canMiss",
  // Skill / Spell:
  "skillName", "skillImg", "skillType", "defenseTargetType", "skillRange",
  "skillTarget", "damageType", "hasDamage", "hasHealing", "rawCost",
  "costSerialized", "descriptionHtml",
  // Ultima actions (Domination / Escape / Recovery):
  "ultimaCost", "dominanceCost",
  // Manual GM overrides — the edit panel renders each field's CURRENT override
  // from this, so a support GM's mirror shows the same typed values as the host
  // instead of blank boxes over already-overridden numbers.
  "gmOverride",
  // Summon Autopilot veto window ({ ms }), so a locally-rendered mirror draws
  // the same draining countdown strip the host does. Display only — the GM's
  // timer is the only thing that can actually confirm.
  "autoConfirm",
];

export function composeActionCardRenderPayload(ar) {
  const out = {};
  for (const k of ACTION_CARD_RENDER_KEYS) out[k] = ar[k];
  out.cardReactions = Array.isArray(ar.acceptedCardReactions) ? ar.acceptedCardReactions
    : (Array.isArray(ar.cardReactions) ? ar.cardReactions : []);
  return out;
}

// Kinds whose cards are pure functions of serializable snapshot data, so a mirror
// client can re-render them LOCALLY from a compact payload instead of receiving the
// full rendered HTML over the socket (a big bandwidth cut on slow links — the same
// spec-not-HTML pattern reaction menus + the HUD already use). Equipment (needs the
// live actor for its swap dropdowns) and Item (interactive tabs/rows) + any unknown
// kind stay on the HTML path.
// "Objective" is included: it renders through buildSkillCard from the same
// serializable snapshot fields a Skill does (backing Item resolved GM-side into
// skillName/skillImg/roll/targets), so a mirror client can rebuild it locally.
const ACTION_CARD_LOCAL_RENDER_KINDS = new Set(["Attack", "Guard", "Study", "Hinder", "Skill", "Objective"]);

// Display-only projection of a reaction candidate — exactly the fields
// buildReactionPills reads. The full candidate carries GM-only resolution state
// (payloadAtFire, chosen picks, callbacks) we must neither need nor ship.
function projectCardReactionForRender(p) {
  return {
    rowKey: p?.rowKey ?? null,
    carrierUuid: p?.carrierUuid ?? null,
    carrierName: p?.carrierName ?? null,
    carrierImg: p?.carrierImg ?? null,
    carrierDescription: p?.carrierDescription ?? null,
    mode: p?.mode ?? null,
    available: p?.available,
    unavailableKind: p?.unavailableKind ?? null,
    unavailableReason: p?.unavailableReason ?? null,
    reactorActorUuid: p?.reactorActorUuid ?? null,
    reactorActorName: p?.reactorActorName ?? null,
    reactorIsPlayer: p?.reactorIsPlayer ?? null,
    reactorOwnerUserId: p?.reactorOwnerUserId ?? null,
  };
}

// Compact, JSON-safe render payload for a mirror client. Projects the GM's actual
// effectivePayload through the canonical render-key set (so CONFIRM's overrides —
// invoke-stamped attacker, post-splice targets/perTargetResults — travel exactly as
// rendered) and shrinks the reaction candidates to their display fields. Returns
// null for nothing to render.
function projectActionCardRenderPayload(payload) {
  if (!payload) return null;
  const out = {};
  for (const k of ACTION_CARD_RENDER_KEYS) out[k] = payload[k];
  out.cardReactions = (Array.isArray(payload.cardReactions) ? payload.cardReactions : [])
    .map(projectCardReactionForRender);
  return out;
}

// Display-only projection of the actionResult that rides along with a mirror
// card. The player path uses it ONLY to repaint the card after an invoke
// (invoke-worker.patchCardDom + invoke-hud's restore/preview), so it needs the
// roll, the per-target rows and a few attacker/Study scalars — not the GM's
// full resolution state (targets, hitTokenUuids, payloadAtFire, _instanceId,
// callbacks). The raw object was being shipped whole alongside the already-
// compacted renderPayload, and again on every invoke-update and trait-reroll:
// three full copies per invoke, which is exactly what a thin connection cannot
// absorb.
//
// Player code never mutates or returns this — the GM re-derives from its own
// cardAr — so a lossy projection cannot corrupt GM state.
function projectActionResultForRender(ar) {
  if (!ar) return null;
  const roll = ar.roll ?? null;
  const tier = ar.tier ?? null;
  return {
    // Study branch of patchCardDom.
    kind: ar.kind ?? null,
    tier: tier ? { name: tier.name ?? null, threshold: tier.threshold ?? null } : null,
    previousBest: ar.previousBest ?? null,
    improved: ar.improved ?? null,
    attacker: {
      tokenUuid: ar.attacker?.tokenUuid ?? null,
      invokePointCount: ar.attacker?.invokePointCount ?? null,
    },
    roll: roll ? {
      rA: roll.rA, rB: roll.rB, dA: roll.dA, dB: roll.dB, A1: roll.A1, A2: roll.A2,
      total: roll.total, checkBonus: roll.checkBonus,
      isCrit: roll.isCrit, isFumble: roll.isFumble,
      opportunities: roll.opportunities ?? null,
    } : null,
    // Presence of the damage object (not just its values) switches the row
    // labels between HIT/MISS and SUCCESS/FAILED — keep null vs object exact.
    damage: ar.damage ? {
      finalIfHit: ar.damage.finalIfHit ?? null,
      ignoreHR: ar.damage.ignoreHR ?? null,
      // `base` is shipped EXPLICITLY, not reconstructed as finalIfHit − base by
      // whoever reads this. Without it a support GM's editor derived base 0 and
      // folded the whole figure into "Highest Roll", so the two GMs' editors
      // showed different numbers for the same action.
      base: ar.damage.base ?? null,
      // The element too — without it a support GM's editor showed
      // "Keep — unchanged" where the host showed "Keep — Physical", so they
      // could not tell that picking Fire would be overriding anything.
      element: ar.damage.element ?? null,
    } : null,
    // MAP, never filter: rows are matched to .fud-bf-target-row by index, so
    // dropping one would repaint the wrong target.
    perTargetResults: (Array.isArray(ar.perTargetResults) ? ar.perTargetResults : []).map((r) => {
      if (!r) return r ?? null;
      return {
        // Row IDENTITY. The invoke repaint matches by index, but a support GM's
        // edit surface has to name the target it is editing, and a per-target
        // override is keyed by token. Without these the editor rendered a
        // nameless row whose override could never be addressed. Discloses
        // nothing new — the same uuid already rides in `renderPayload.targets`
        // and its perTargetResults — and two short strings per row is not the
        // duplication this projection exists to prevent.
        tokenUuid: r.tokenUuid ?? null,
        name: r.name ?? null,
        hit: r.hit, crit: r.crit, isCrit: r.isCrit,
        damage: r.damage, affinity: r.affinity ?? null,
        resource: r.resource ?? null,
        // Read by the bond preview to recompute hit/miss; dropping it would
        // make every studied row preview as a Hit.
        defense: r.defense ?? null,
        studied: r.studied,
        grantAmount: r.grantAmount ?? null,
        grantResource: r.grantResource ?? null,
        resourceCur: r.resourceCur ?? null,
        resourceMax: r.resourceMax ?? null,
        vismagusSuppressed: r.vismagusSuppressed ?? null,
        damageOverride: r.damageOverride
          ? { from: r.damageOverride.from ?? null, to: r.damageOverride.to ?? null }
          : null,
      };
    }),
  };
}

// Assemble the action-card root <div> from a composed card object + reaction
// candidates — the SINGLE source of the card's outer DOM template, shared by the
// GM spawn (postActionCard) and the player-side local mirror render so the two are
// byte-identical. Does not attach to the document (the caller owns placement +
// the is-visible transition). Returns the root element and the initial pending-
// reaction count (the GM gates Confirm / auto-resolve on it).
// ─── GM edit surface ─────────────────────────────────────────────────────────
// A launch button on the card, and a SEPARATE editor card it opens. The action
// card itself carries no controls: the GM works in the editor, and nothing takes
// effect until Save. Cancel returns to the card having changed nothing.
//
// Two reasons the editor is its own card rather than a panel on this one:
//   • The target-row list is regenerated wholesale by rerenderCardTargetSurfaces
//     whenever a mutation changes the target set, which would destroy in-card
//     controls — and any half-typed value in them — on the next redirect.
//   • A staged edit needs somewhere to stage. Live-applying each keystroke made
//     every intermediate value (an empty box mid-retype, a half-typed "5" on the
//     way to "55") a real committed override broadcast to the whole table.
//
// Every value the editor sends is ABSOLUTE, so the patch stays idempotent end to
// end (see gm-card-override.js).

// The launch button — a pill DOCKED on the header's bottom rule, right-aligned
// to the same 16px gutter every fieldset uses (card border 2 + padding 14).
//
// It used to be a 28px filled square absolutely placed in a zero-height wrapper
// between the subtitle and the body. That kept it from displacing any existing
// layout, which was the right instinct, but it left the control floating in the
// gap between two elements with no alignment relationship to either — and three
// consequences followed from having no edge to sit on:
//
//   · it landed on the subtitle's optical centre line without being part of
//     that row, so the metadata line read as a label for the button;
//   · the count badge (top:-4px, right:-4px on a control at right:9px) was
//     CLIPPED by the card's own border;
//   · the active state was a solid gold gradient — the same weight as CONFIRM,
//     on a utility control that is not the card's decision.
//
// Docking on the rule gives it a real edge, so it reads as attached furniture
// rather than a sticker; the count moves INSIDE the pill where nothing can clip
// it; and the active state wears the "GM SET" amber that already marks the
// fieldsets this button's edits changed.
function buildGmEditLaunchHTML(gmOverride = null) {
  const summary = summarizeGmOverride(gmOverride);
  const count = gmEditCount(gmOverride);
  // The ACTION stays the accessible name ("Edit this action") — a screen reader
  // needs the verb, not a state string. The COUNT joins it, because it is the
  // one thing the pill shows that the verb does not; the full summary rides in
  // the tooltip.
  const desc = summary ? `Edited: ${summary}` : "";
  const label = count
    ? `Edit this action — ${count} change${count === 1 ? "" : "s"} made`
    : "Edit this action";
  // No wrapper element. It used to be a positioning parent; once the button
  // moved into the header it had no job left but `display: contents`, which
  // made the header's layout depend on TWO rules both landing (that rule AND
  // the button's own `position:absolute`). A client running new markup against
  // a cached stylesheet — ensureStyles early-returns on a fixed id — would then
  // get a real fourth flex item in a space-between row, throwing the title
  // off-centre. One rule is one failure mode.
  return `<button type="button" class="fud-gm-launch${summary ? " is-active" : ""}"
          data-fud-gm-launch="1" aria-label="${escapeHtml(label)}"
          title="${escapeHtml(summary ? `Edit this action — ${desc}` : "Edit this action")}">
    <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>${
      count ? `<span class="fud-gm-launch-dot" aria-hidden="true">${count}</span>` : ""}
  </button>`;
}

const GM_EDIT_ROOT_ID = "fud-gm-edit-card-root";

// The last-target rule paragraph. Referenced by aria-describedby from every
// blocked Remove, so the rule is announced with the button rather than
// hidden in a hover tooltip.
const GM_TBLOCK_ID = "fud-gm-target-block-note";

// Action kinds that keep a SECOND subject field beside `targets`, which this
// editor does not write.
//
// Guard keeps `coverTarget`; Study and Hinder keep `target`; Equipment and the
// Ultima commands are self-only. Editing `targets` on one of these would be HALF
// APPLIED, and the half that moves differs per kind — which is the actual reason
// the section is withheld:
//
//   · Hinder — `ar.targets` IS load-bearing (the chosen status goes to
//     `action_targets`, i.e. `ar.targets`), but `ar.target` drives the miss VFX
//     and the log line. A swap would inflict the status on the new creature
//     while the log named the old one.
//   · Study — `ar.target` drives `markStudied` and the tier bookkeeping; a swap
//     would study one creature and record it against another.
//   · Guard — BOTH matter, which is the trap. `ar.coverTarget` feeds the
//     `creature_guards` scan payload and the log line, but the Covered AE
//     reaches the ally through `action_targets` — i.e. `ar.targets`, whose sole
//     entry is the cover target. (`coverTarget` has no reserved target_ref, so
//     `action_targets` is the only channel it could travel by.) An edit here
//     would move the AE and leave the scan payload and log naming the old ally.
//     Do NOT read this kind as "inert and therefore the safe one to un-suppress
//     first" — that was the original mistake, made about Hinder.
//   · Equipment / Domination / Escape / Recovery — self-targeted; there is no
//     second creature for the GM to choose. Their `ar.targets` is load-bearing
//     all the same (Recovery's cleanse + MP restore go to `action_targets`), so
//     the Guard-style "inert" argument must not be extended to them either.
//
// Supporting these properly means writing the kind's own subject field as well,
// which is a separate override channel with its own RESOLVE paths to verify.
// Until then the control is withheld rather than shown doing half a job:
// building the list from `targets` (rather than from per-target result rows, as
// it used to be) is what made these rows appear at all, and a control that
// visibly works and silently half-applies is worse than no control. The Add
// picker was already inert on these cards before this pass.
const GM_COMPAT_TARGET_KINDS = new Set([
  "guard", "study", "hinder", "equipment", "domination", "escape", "recovery",
]);
// Project the card's reaction candidates into editor rows.
//
// `decisionOf` is the card's live decision map lookup and is only available on
// the HOST — a support GM's mirror has the candidate list but not the verdicts.
// It stays null there rather than being guessed at: the row then labels its
// "keep" option with the pill's dispatch MODE, which is true on both surfaces,
// instead of inventing an Applied/Skipped state the mirror cannot know.
function gmEditReactionRows(cands, decisionOf = null) {
  return (Array.isArray(cands) ? cands : []).filter(isGmEditableReaction).map((p) => ({
    rowKey: p.rowKey, carrierUuid: p.carrierUuid,
    carrierName: p.carrierName ?? "Reaction",
    reactorActorName: p.reactorActorUuid ? (p.reactorActorName ?? "Reactor") : null,
    mode: p.mode ?? null,
    available: p.available !== false,
    unavailableReason: p.available === false ? (p.unavailableReason ?? "Unavailable") : null,
    decision: decisionOf ? (decisionOf(p) ?? null) : null,
  }));
}

// Tokens on the canvas scene that are NOT already targets — the pool the editor
// can add from.
//
// A dropdown rather than a canvas target-picker on purpose: the editor is a
// modal dialog staging an edit, and a picker would have to hide it, take a
// click on the board, and come back — the card-hiding dance the redirect picker
// already needs. A GM correcting a target list is naming a creature, not aiming.
function gmAddableTargets(perTargetResults, attackerTokenUuid = null) {
  try {
    const taken = new Set((perTargetResults ?? []).map((r) => r?.tokenUuid).filter(Boolean));
    // Restricted to the scene THIS ACTION is on, not merely the current canvas.
    // A GM whose canvas has wandered to another scene would otherwise be offered
    // that scene's roster, and an off-canvas target is a known hazard: reaction
    // scans resolve reactors through `canvas.tokens`, so such a creature reads
    // as absent to half the engine.
    const actionSceneId = (() => {
      const anyTarget = (perTargetResults ?? []).find((r) => r?.tokenUuid)?.tokenUuid
        ?? attackerTokenUuid ?? "";
      const m = String(anyTarget).match(/^Scene\.([^.]+)\./);
      return m?.[1] ?? canvas?.scene?.id ?? null;
    })();
    const rows = (canvas?.tokens?.placeables ?? [])
      .map((t) => t?.document)
      .filter((d) => d?.uuid && d?.actor && !taken.has(d.uuid))
      // The attacker is not offered. Adding the actor to their own action is
      // almost always a misclick, and the engine's own add_target honours
      // `exclude_self`; this control has no targeting rules of its own.
      .filter((d) => !attackerTokenUuid || d.uuid !== attackerTokenUuid)
      .filter((d) => !actionSceneId || d.parent?.id === actionSceneId)
      // A creature declaring `cannot_be_targeted_by: "any"` is not offered. The
      // GM override changes the DECISION, never the RULES — every other pool in
      // the engine honours this contract, and a hand-added target that no
      // automatic path could ever produce is a rule bypass, not a correction.
      .filter((d) => !hasUnconditionalTargetBlock(d.actor))
      .map((d) => ({
        tokenUuid: d.uuid,
        name: d.name ?? d.actor?.name ?? "?",
        // Disposition, so allies and enemies are distinguishable in a list that
        // is otherwise just names — and so four identically-named goblins are
        // not four identical rows.
        hostile: Number(d.disposition) < 0,
      }));
    // Group enemies first, then allies, each alphabetical: a GM adding a target
    // is nearly always reaching for the other side.
    rows.sort((a, b) => (Number(b.hostile) - Number(a.hostile)) || a.name.localeCompare(b.name));
    // Disambiguate repeats by ordinal, since the dropdown shows names only.
    const seen = new Map();
    for (const r of rows) {
      const n = (seen.get(r.name) ?? 0) + 1;
      seen.set(r.name, n);
      r.ordinal = n;
    }
    const dupes = new Set([...seen].filter(([, n]) => n > 1).map(([n]) => n));
    return rows.map((r) => ({
      tokenUuid: r.tokenUuid,
      name: `${r.name}${dupes.has(r.name) ? ` (${r.ordinal})` : ""}${r.hostile ? "" : " — ally"}`,
    }));
  } catch (e) {
    warn("gmAddableTargets: scene scan threw", e);
    return [];
  }
}

// One row of the target list.
//
// Module scope because rows are emitted from TWO places — the builder, for the
// action's targets and anything a saved bag already holds, and the add control
// at runtime. Same markup from both, or a row restored after Save would behave
// differently from one just added.
//
// The row IS the state. Three attributes, and every behaviour follows from them:
//
//   data-fud-gm-token       the creature is CURRENTLY in the action
//   data-fud-gm-add-token   the GM put it there
//   data-fud-gm-drop="1"    staged for removal
//
// A row with `add-token` and no `token` is a staged add that has not been
// derived yet — nothing real is being changed, so its Remove discards the row
// outright and hands the option back to the picker. Every other row toggles a
// strike-through, because its Remove takes out a creature the action really
// has. That asymmetry is the point, not an inconsistency: a pending add and a
// committed member are not the same thing to undo.
function gmTargetRowHTML({ tokenUuid = null, addToken = null, name = "", cut = false, fields = "", engine = null }) {
  const live = tokenUuid ? ` data-fud-gm-token="${escapeHtml(String(tokenUuid))}"` : "";
  const add = addToken ? ` data-fud-gm-add-token="${escapeHtml(String(addToken))}"` : "";
  // ENGINE membership, which is NOT the same as carrying a token attribute: a
  // bag-only removal carries a token for a creature the action does not have.
  // Only this flag counts toward the last-target guard. Defaults to what the
  // token attribute says, so the runtime add control needs no extra argument.
  const eng = (engine ?? !!tokenUuid) ? ` data-fud-gm-engine="1"` : "";
  const nm = escapeHtml(String(name ?? ""));
  return `<div class="fud-gm-trow${cut ? " is-cut" : ""}${addToken ? " is-added" : ""}"
       data-fud-gm-trow${live}${add}${eng}${cut ? ` data-fud-gm-drop="1"` : ""}>
    <div class="fud-gm-thead">
      <span class="fud-gm-tname">${nm}</span>
      ${addToken ? `<span class="fud-gm-tbadge">Added by GM</span>` : ""}
      <span class="fud-gm-tcut" data-fud-gm-tcut>${cut ? "Will be removed" : ""}</span>
      <button type="button" class="fud-gm-tdrop" data-fud-gm-action="drop"
              aria-label="${cut ? "Restore" : "Remove"} ${nm}">${cut ? "Restore" : "Remove"}</button>
    </div>
    ${fields}
  </div>`;
}

// Per-target rows from two sources, joined by TOKEN and never by index — the
// frozen COMPUTE rows and the last recompute's rows describe the same action but
// not the same membership (a removal shortens one, a GM add lengthens the
// other), so position is not a join. Later wins on a shared token; rows the
// recompute no longer has are KEPT, because a creature staged for removal must
// still render with its real numbers so Restore shows what comes back.
function mergePerTargetRowsByToken(...lists) {
  const out = new Map();
  for (const list of lists) {
    for (const r of (Array.isArray(list) ? list : [])) {
      const u = String(r?.tokenUuid ?? "");
      if (!u) continue;
      out.set(u, r);
    }
  }
  return [...out.values()];
}

// The union of several target-snapshot arrays, deduped by token uuid, order
// preserved. Same join rule and the same reason as above.
function dedupeTargetRefs(...lists) {
  const out = new Map();
  for (const list of lists) {
    for (const t of (Array.isArray(list) ? list : [])) {
      const u = String(t?.tokenUuid ?? "");
      if (!u) continue;
      out.set(u, t);
    }
  }
  return [...out.values()];
}

// Project an actionResult (host) or render payload (mirror) into the editor's
// inputs. One projection for both surfaces, so a support GM's editor cannot show
// different numbers from the host's.
// `live` is the LAST RECOMPUTE's target set + rows (see `lastTargetSurface` in
// postActionCard). The action's own `perTargetResults` are frozen at COMPUTE and
// never rewritten by an edit, so without this a GM-added creature is invisible
// to the editor forever — it can never become a row with real numbers, only a
// bare name. Passing the recompute in is what lets an added target be edited
// like any other. It is display state, not authority: the bag is still the only
// thing Save writes.
function gmEditContextFor(src, kind = null, title = null, reactions = null, live = null) {
  // Every creature the action currently has a row for — the frozen rows plus
  // anything the last recompute derived (a GM add, an add_target splash, a
  // shield phantasm). Recompute wins on a shared token: it is the fresher
  // derivation of the same slot.
  const liveRows = Array.isArray(live?.perTargetResults) ? live.perTargetResults : [];
  const liveTargets = Array.isArray(live?.targets) ? live.targets : [];
  const mergedRows = mergePerTargetRowsByToken(src?.perTargetResults ?? [], liveRows);
  // Which creatures the ENGINE targets, INDEPENDENTLY of the GM's `added` set.
  //
  // This is the distinction the whole target list turns on, and it is not
  // "is it in the current target set" — the recompute's set INCLUDES the GM's
  // own additions. Removing an engine target is a REMOVAL (it goes to
  // `targets.removed`); removing a creature that is only there because the GM
  // added it is an UN-ADD (it leaves `targets.added` and nothing else happens).
  //
  // Conflating the two strands the creature: it lands in `removed`, where
  // "removal wins" over `added` forever, so it can never be re-added — and the
  // phantom row it leaves behind counts toward the last-target guard, which is
  // how an action could be reduced to ZERO targets.
  //
  // The frozen COMPUTE state is engine-owned by definition. A row the recompute
  // ADDED is engine-owned unless it carries the GM's own stamp (`addedVia.gm`,
  // set in applyTargetSetMutation) — which is what keeps the Protect case right:
  // a redirect that moves a GM-added protector into the engine's own slot makes
  // it a real target, and dropping it then IS a removal.
  //
  // The stamp is read as a VETO over the union, not as a per-entry filter. The
  // recompute rebuilds each per-target row through buildPerTarget, which does
  // not carry `addedVia` — so a token stamped on the TARGET would be readmitted
  // by its own unstamped result row, and a GM addition would go back to looking
  // engine-owned. One stamp anywhere disqualifies the token everywhere.
  const gmAddedLive = new Set([...liveTargets, ...liveRows]
    .filter((t) => t?.addedVia?.gm === true)
    .map((t) => String(t.tokenUuid ?? "")).filter(Boolean));
  const engineTokens = new Set([
    ...(src?.targets ?? []).map((t) => String(t?.tokenUuid ?? "")),
    ...(src?.perTargetResults ?? []).map((r) => String(r?.tokenUuid ?? "")),
  ].filter(Boolean));
  for (const t of [...liveTargets, ...liveRows]) {
    const u = String(t?.tokenUuid ?? "");
    if (u && !gmAddedLive.has(u)) engineTokens.add(u);
  }
  // The veto over the FROZEN half too, so this really is a veto over the union
  // rather than a filter on the live half. Unreachable today — ctx.actionResult
  // is never rewritten with the mutated target set — but that is exactly the
  // change someone makes to survive an F5, and it would silently restore the
  // strand while this comment still claimed immunity.
  for (const u of gmAddedLive) engineTokens.delete(u);
  return {
    engineTokens: [...engineTokens],
    // Placeholders must come from the FROZEN rows, never the recompute: the
    // recompute's rows are POST-override (composeGmDefenseOverrides rewrites
    // `defense`, applyGmDamageOverrides rewrites `damage`), so sourcing the grey
    // "what the engine produced" value from them showed the GM their own typed
    // number back as the engine's.
    engineRows: src?.perTargetResults ?? [],
    // Computed on whichever client opens the editor: both GMs see the same
    // canvas, and it is derived state, not an authored value the host owns.
    // Fed the ENGINE-OWNED membership: the target set as well as the rows (a
    // no-damage Skill's targets have no rows to be excluded by, so its own
    // victims were offered back in the picker), but NOT the GM's own additions.
    //
    // Excluding those was wrong in a way that only shows inside one session:
    // un-adding a derived add destroys its row, and the picker is rebuilt from
    // this list — so the creature had no row AND no option, recoverable only by
    // Cancel, which throws away every other edit in the dialog. The live picker
    // (`refreshAddOptions`) already hides anything that currently HAS a row, so
    // offering it here costs nothing and is what hands it back.
    addable: gmAddableTargets(
      dedupeTargetRefs(mergedRows, src?.targets ?? [], liveTargets)
        .filter((t) => engineTokens.has(String(t?.tokenUuid ?? ""))),
      src?.attacker?.tokenUuid ?? null),
    // The action's TARGET SET, which is not the same thing as its result rows:
    // a no-damage Skill (Hawkeye, Warning Shot, Barrage) carries real targets
    // and an EMPTY perTargetResults, so a list built from rows alone offered the
    // GM nothing to remove at all. Measured 2026-08-23: 2 targets, 0 rows.
    targets: dedupeTargetRefs(src?.targets ?? [], live?.targets ?? []),
    // Whether this action's target SET is what resolves — see
    // GM_COMPAT_TARGET_KINDS. `kind` is not on the render payload, so it has to
    // be threaded in; both editor surfaces already pass it.
    targetsEditable: !GM_COMPAT_TARGET_KINDS.has(String(kind ?? "").toLowerCase()),
    // The host passes its LIVE candidate list (which includes anything a cascade
    // injected since the card was posted); the mirror falls back to the payload's.
    reactions: reactions ?? gmEditReactionRows(src?.cardReactions),
    perTargetResults: mergedRows,
    roll: src?.roll ?? null,
    damage: src?.damage ?? null,
    // The action's current weapon category, for the weapon-type picker's
    // "keep" label. Spells carry none, which the picker renders as "unchanged".
    weaponType: src?.weapon?.weaponType ?? src?.damageType ?? null,
    // The actor's own fumble threshold, so the live preview applies the same
    // rule deriveCheck will. Defaults to 1 when the payload does not carry it.
    fumbleThreshold: src?.roll?.fumbleThreshold ?? src?.attacker?.fumbleThreshold ?? 1,
    hasDamage: src?.hasDamage !== false,
    gmOverride: src?.gmOverride ?? null,
    // DEF vs MDEF, derived exactly as the recompute's `redirectVsMDef` does.
    // `kind` is NOT part of the render payload, so it must be passed in — reading
    // it off the payload silently yielded undefined and mislabelled the defence
    // field on any mdef-tagged Attack.
    isSpellish: String(kind ?? "").toLowerCase() !== "attack"
      && resolvesVsMagicDefense({
        defenseTargetType: src?.defenseTargetType,
        isSpell: String(src?.skillType ?? "").toLowerCase() === "spell",
      }),
    title: title ?? src?.skillName ?? src?.weapon?.name ?? String(kind ?? "Action"),
  };
}

// Build the editor card's markup from the action's CURRENT values and whatever
// override is already in force. Engine values appear as placeholders, so an
// empty box always reads as "leave this to the engine" — never as zero.
function buildGmEditCardHTML({ perTargetResults, targets = [], engineTokens = [], engineRows = [], targetsEditable = true, roll, damage, weaponType = null, isSpellish = false, gmOverride = null, hasDamage = true, title = "Action", reactions = [], addable = [] }) {
  const gm = normalizeGmOverride(gmOverride);
  const defTag = isSpellish ? "MDEF" : "DEF";
  const num = (v) => (v == null ? "" : String(v));
  // ONE idiom for "no override" across every optional control: a leading
  // "Keep — <current>" entry. The die selects previously had no way to express
  // it at all (they always hold a concrete size), so a GM who changed one had
  // no marker showing what it had been and reverting was guesswork.
  const dieOpts = (sel, engine) =>
    `<option value="">Keep d${engine ?? "?"}</option>` + GM_DIE_SIZES.map((d) =>
      `<option value="${d}"${Number(sel) === d ? " selected" : ""}>d${d}</option>`).join("");
  // Damage/weapon-type pickers carry an explicit "keep" entry rather than
  // pre-selecting the engine's value: these are optional overrides, and a
  // select that always holds a concrete value cannot express "leave it alone".
  // The engine's own value is named in the keep option so it stays visible.
  const typeOpts = (list, sel, engine) => {
    const engLabel = engine ? cap(String(engine)) : "unchanged";
    return `<option value="">Keep — ${escapeHtml(engLabel)}</option>` + list.map((t) =>
      `<option value="${t}"${sel === t ? " selected" : ""}>${escapeHtml(cap(t))}</option>`).join("");
  };
  const engElement = String(damage?.element ?? "").toLowerCase() || null;
  const engWeapon = String(weaponType ?? "").toLowerCase() || null;
  // The action's OWN bonus, shown read-only beside the adjustment field. Both
  // adjustment fields add to what already exists rather than replacing it, so
  // the GM has to be able to see what they are adding to.
  const engBonus = Number(roll?.checkBonus ?? 0) || 0;
  const signed = (n) => (n > 0 ? `+${n}` : String(n));

  // Accuracy — each die's SIZE and rolled VALUE, plus the flat bonus. Total,
  // Highest Roll, crit and fumble are DERIVED from these, never typed.
  // Name the dice by the ATTRIBUTE they belong to, matching the card's own
  // "INS d12 + WLP d10" line. "First / Second value" forced the GM to map by
  // position, and a screen reader heard "Value" twice with nothing between them.
  const nameA = roll?.A1 ? String(roll.A1).toUpperCase() : "First";
  const nameB = roll?.A2 ? String(roll.A2).toUpperCase() : "Second";
  // Laid out as ROWS that read like the card's own accuracy line — one row per
  // die, one for the bonus — instead of a uniform grid of eight equally-loud
  // cells. Each row is "what it is → what you're changing it to", so the eye
  // scans down one column of inputs rather than hunting a checkerboard.
  // The CONNECTOR ("shows" / "adjust by") carries the whole semantic — whether
  // a typed number replaces or adds — so it reads at full weight. The field
  // name repeats what is already on the card behind this dialog, so it is
  // demoted to sentence case. Getting that hierarchy the wrong way round is
  // what made the panel hard to read: the eye landed on "INS" and slid off the
  // word that told you what your number would do.
  const dieRow = (label, dieField, resField, dieVal, engDie, resVal, engRes) => `
    <div class="fud-gm-row">
      <span class="fud-gm-rl">${escapeHtml(label)}</span>
      <select class="fud-gm-sel fud-gm-die" data-fud-gm-field="${dieField}"
              aria-label="${escapeHtml(label)} die size">${dieOpts(dieVal, engDie)}</select>
      <span class="fud-gm-sep">shows</span>
      <input type="number" class="fud-gm-num" data-fud-gm-field="${resField}" min="1" max="${Number(dieVal ?? engDie) || 12}"
             aria-label="${escapeHtml(label)} rolled result"
             value="${escapeHtml(num(resVal))}" placeholder="${escapeHtml(String(engRes ?? ""))}" />
    </div>`;
  const accuracy = roll ? `
    <fieldset class="fud-gm-sec">
      <legend>Accuracy check</legend>
      ${dieRow(nameA, "dA", "rA", gm.roll?.dA, roll.dA, gm.roll?.rA, roll.rA)}
      ${dieRow(nameB, "dB", "rB", gm.roll?.dB, roll.dB, gm.roll?.rB, roll.rB)}
      <div class="fud-gm-row">
        <span class="fud-gm-rl">Bonus</span>
        <span class="fud-gm-now">${signed(engBonus)}</span>
        <span class="fud-gm-sep is-verb">adjust by</span>
        <input type="number" class="fud-gm-num" data-fud-gm-field="bonus"
               aria-label="Accuracy bonus adjustment"
               value="${escapeHtml(num(gm.roll?.bonus))}" placeholder="0" />
      </div>
      <p class="fud-gm-derived" data-fud-gm-derived="accuracy"></p>
    </fieldset>` : "";

  // Damage — base, whether Highest Roll is added, and a flat bonus.
  const engBase = Number(damage?.base ?? 0);
  const engHr = Math.max(0, Number(damage?.finalIfHit ?? 0) - engBase);
  const hrOn = gm.damage?.useHR == null ? !damage?.ignoreHR : !!gm.damage.useHR;
  const dmgSec = (hasDamage && damage) ? `
    <fieldset class="fud-gm-sec">
      <legend>Damage</legend>
      <div class="fud-gm-row">
        <span class="fud-gm-rl">Base</span>
        <span class="fud-gm-now">${escapeHtml(String(engBase))}</span>
        <span class="fud-gm-sep is-verb">adjust by</span>
        <input type="number" class="fud-gm-num" data-fud-gm-field="dmgBonus"
               aria-label="Damage adjustment"
               value="${escapeHtml(num(gm.damage?.bonus))}" placeholder="0" />
      </div>
      <label class="fud-gm-row fud-gm-check">
        <input type="checkbox" data-fud-gm-field="useHR"${hrOn ? " checked" : ""} />
        <span>Add Highest Roll <b data-fud-gm-hrlabel>${engHr}</b></span>
      </label>
      <!-- Classification, not quantity — kept below the numbers and visually
           quieter so the two kinds of edit do not compete for the same glance. -->
      <div class="fud-gm-row fud-gm-types">
        <span class="fud-gm-rl">Element</span>
        <select class="fud-gm-sel" data-fud-gm-field="element" aria-label="Damage element">${
          typeOpts(GM_DAMAGE_TYPES, gm.damage?.element, engElement)}</select>
      </div>
      <div class="fud-gm-row">
        <span class="fud-gm-rl">Weapon</span>
        <select class="fud-gm-sel" data-fud-gm-field="weaponType" aria-label="Weapon category">${
          typeOpts(GM_WEAPON_TYPES, gm.damage?.weaponType, engWeapon)}</select>
      </div>
      <p class="fud-gm-derived" data-fud-gm-derived="damage" data-fud-gm-hr="${engHr}" aria-live="polite"></p>
    </fieldset>` : "";

  // ── Targets ────────────────────────────────────────────────────────────────
  // ONE list showing the RESULTING target set, with the add control at the foot
  // of the list it feeds.
  //
  // It used to be two disjoint controls: a "Remove from this action" checkbox
  // buried inside a fieldset called "Result", and a separate "Add a target"
  // fieldset holding a single <select>. Three faults with one root cause — the
  // editor never showed the GM the SET they were deciding:
  //
  //   · a creature picked in the add box appeared NOWHERE in the list, so the
  //     resulting membership was never visible
  //   · the add box sat in a different section from the thing it modified
  //   · ONE add per save. `added: addEl.value ? [addEl.value] : []` meant a
  //     second pick silently replaced the first, and one <select> could only
  //     ever pre-select one of several stored adds — even though the bag has
  //     always modelled `added` as an array.
  //
  // Read the ROWS, never a parallel JS array: keeping the two in step is how
  // this kind of editor drifts.
  // Membership comes from THREE places and the list is their union:
  //
  //   · perTargetResults — the derived rows (outcome / damage / defence). Merged
  //     with the last recompute's rows upstream, so a GM-added creature the
  //     engine has already derived arrives here as a real row.
  //   · targets          — the action's own target SET. NOT the same thing: a
  //     no-damage Skill (Hawkeye, Warning Shot, Barrage) carries real targets and
  //     an EMPTY perTargetResults, so a list built from rows alone rendered ZERO
  //     rows and the GM could not remove anything at all. Measured 2026-08-23 on
  //     Hawkeye with two targets: 2 targets, 0 rows, 0 list entries.
  //   · the bag          — every token `added`/`removed` names. The reduction
  //     reads both sets back OFF THE ROWS, so an unrendered entry is erased by
  //     the next Save.
  //
  // A row carries the FIELD GRID whenever we have a derived result for it, and
  // only then: a target with no row has no verdict, damage or defence for an
  // override to land on, and blank controls there would offer edits the engine
  // silently drops.
  const rowByToken = new Map();
  for (const r of (perTargetResults ?? [])) {
    const u = String(r?.tokenUuid ?? "");
    if (u) rowByToken.set(u, r);
  }
  // The FROZEN engine rows, kept apart from the merged set. Every grey
  // placeholder comes from here: the recompute's rows are POST-override
  // (composeGmDefenseOverrides rewrites `defense`, applyGmDamageOverrides
  // rewrites `damage`), so reading a placeholder off them showed the GM their
  // own typed number back as "what the engine produced".
  const engineRowByToken = new Map();
  for (const r of (engineRows ?? [])) {
    const u = String(r?.tokenUuid ?? "");
    if (u) engineRowByToken.set(u, r);
  }
  const targetTokens = (targets ?? []).map((t) => String(t?.tokenUuid ?? "")).filter(Boolean);
  const addedSet = new Set(gm.targets.added);
  const removedSet = new Set(gm.targets.removed);
  const addableName = new Map(addable.map((t) => [t.tokenUuid, t.name]));
  const nameOfToken = (u) =>
    rowByToken.get(u)?.name
    ?? (targets ?? []).find((t) => String(t?.tokenUuid ?? "") === u)?.name
    ?? addableName.get(u)
    // Only a creature the GM actually added earns that label. An engine target
    // this client cannot resolve is a target, not an add — calling it "Added
    // target" states the wrong provenance about somebody else's edit.
    ?? (addedSet.has(u) ? "Added target" : "Target");
  // ENGINE-owned membership — see gmEditContextFor. This is what makes Remove
  // mean REMOVAL on a real target and UN-ADD on a GM addition; the merged row
  // set cannot answer that, because it contains the GM's own additions.
  const engineSet = new Set(engineTokens ?? []);
  // Ordered: the action's own targets first, in the order the card shows them,
  // then any derived row it does not name, then bag-only tokens.
  const memberOrder = [];
  const seenMember = new Set();
  const pushMember = (u) => { if (u && !seenMember.has(u)) { seenMember.add(u); memberOrder.push(u); } };
  targetTokens.forEach(pushMember);
  for (const u of rowByToken.keys()) pushMember(u);
  gm.targets.added.forEach(pushMember);
  gm.targets.removed.forEach(pushMember);
  // A creature already in the list — or one the GM has staged for removal, whose
  // own row carries a Restore — must not also be offered by the picker.
  const addOptions = addable.filter((t) =>
    !addedSet.has(t.tokenUuid) && !seenMember.has(t.tokenUuid) && !removedSet.has(t.tokenUuid));
  const targetsSection = (targetsEditable && (memberOrder.length || addable.length)) ? `
    <fieldset class="fud-gm-sec fud-gm-targets" data-fud-gm-targets>
      <legend>Targets</legend>
      ${memberOrder.map((uuid) => {
        const r = rowByToken.get(uuid) ?? null;
        const ov = gm.perTarget[uuid] ?? {};
        // "" for keep, like every other select — it used to be "auto", which is a
        // non-empty value, so markEdited railed every untouched outcome row as
        // edited and "Clear all fields" was never disabled. Clear-all also sets
        // selects to "", which on an "auto" option list left the control BLANK.
        const sel = ov.hit === true ? "hit" : ov.hit === false ? "miss" : "";
        // Grant / heal rows carry no hit check, defence or damage — isGmEditableRow
        // is the same gate readForm uses to decide which rows it may read back.
        const editable = !!r && isGmEditableRow(r);
        // The engine's own figures for the grey placeholders. A GM-ADDED creature
        // has no frozen row at all, so its only source is the recompute — which
        // is post-override, so any field the bag currently sets shows NO
        // placeholder rather than echoing the GM's own number back at them.
        const eng = engineRowByToken.get(uuid) ?? null;
        const phDamage = eng ? eng.damage : (ov.damage != null ? null : r?.damage);
        const phDefense = eng ? eng.defense
          : (ov.defense != null ? (r?.defenseOverride?.from ?? null) : r?.defense);
        const isEngine = engineSet.has(uuid);
        return gmTargetRowHTML({
          // The token attribute is what makes a dropped row a REMOVAL. A
          // GM-added creature must NOT carry it — dropping it un-adds instead,
          // which is the only undo that leaves the bag able to converge. A
          // bag-`removed` token keeps it even when this client cannot see the
          // creature, or the reduction would read the row as a discarded staged
          // add and silently drop the GM's removal.
          tokenUuid: (isEngine || removedSet.has(uuid)) ? uuid : null,
          // Counted toward the last-target guard. Separate from `tokenUuid`
          // because the safety-net row above carries a token for a creature the
          // action does not have, and counting THAT is how the guard could be
          // walked around into a zero-target action.
          engine: isEngine,
          // Normalize guarantees a token is never in both sets, so an added row
          // can never also be a removed one.
          addToken: addedSet.has(uuid) ? uuid : null,
          name: nameOfToken(uuid),
          cut: removedSet.has(uuid),
          fields: editable ? `<div class="fud-gm-grid">
            <label class="fud-gm-f"><span>Outcome</span>
              <select class="fud-gm-sel" data-fud-gm-field="hit">
                <option value=""${sel === "" ? " selected" : ""}>Keep — engine</option>
                <option value="hit"${sel === "hit" ? " selected" : ""}>Hit</option>
                <option value="miss"${sel === "miss" ? " selected" : ""}>Miss</option>
              </select></label>
            ${hasDamage ? `<label class="fud-gm-f"><span>Damage</span>
              <input type="number" class="fud-gm-num" data-fud-gm-field="damage"
                     value="${escapeHtml(num(ov.damage))}" placeholder="${escapeHtml(num(phDamage))}" /></label>` : ""}
            <label class="fud-gm-f"><span>${defTag}</span>
              <input type="number" class="fud-gm-num" data-fud-gm-field="defense"
                     value="${escapeHtml(num(ov.defense))}" placeholder="${escapeHtml(num(phDefense))}" /></label>
          </div>` : "",
        });
      }).join("")}
      <div class="fud-gm-addrow">
        <label class="fud-gm-rl" for="fud-gm-addsel">Add</label>
        <select class="fud-gm-sel" id="fud-gm-addsel" data-fud-gm-field="addTarget">
          <option value="">Choose a creature…</option>
          ${addOptions.map((t) => `<option value="${escapeHtml(t.tokenUuid)}">${escapeHtml(t.name)}</option>`).join("")}
        </select>
        <!-- An explicit button, NOT an action bound to the select's change
             event. A native select fires change per option while arrowing
             through a closed list, so a keyboard GM reaching the third name
             would have staged the first two and destroyed their options on the
             way past. It also keeps every select in this dialog a revertible
             VALUE rather than a command. -->
        <button type="button" class="fud-btn fud-gm-addbtn" data-fud-gm-action="add" disabled>Add</button>
      </div>
      <p class="fud-gm-tlive" data-fud-gm-tlive role="status" aria-live="polite"></p>
      <p class="fud-gm-tnote">A creature added here runs through the action's own pipeline —
        its defence, affinity and damage reduction all apply. Save, and it gains the same
        outcome, damage and ${defTag} fields as every other target.</p>
      <!-- Emptying the action is ALLOWED and is not the same call as cancelling
           it, so this states the consequence rather than refusing. Two wordings,
           one before the choice and one after, because "would" and "will" are
           different pieces of information to a GM mid-decision. -->
      <p class="fud-gm-tnote fud-gm-tblock" id="${GM_TBLOCK_ID}" data-fud-gm-tblock hidden>
        <span data-fud-gm-tblock-ahead>Removing this one leaves the action with <b>no targets</b>.</span>
        <span data-fud-gm-tblock-warn hidden>This action now has <b>no targets</b>.</span>
        It still resolves — its cost is paid, the turn is spent and its self-effects
        run — but it hits nobody. To call the action off entirely, cancel it on the card
        instead.</p>
    </fieldset>` : "";

  // Reactions — what happens to each candidate, in the PILL's own vocabulary so
  // the GM is choosing between the same words the card shows everyone else:
  //
  //   Keep       no override; the engine and the player decide
  //   Apply      make it fire, including one the player skipped or can't afford
  //   Skip       stop it firing, including an `on`/`force` one already applied
  //   Ask again  hand the decision back — the pill returns to UNDECIDED, buttons
  //              live, exactly as it stood before anyone chose
  //
  // "Ask again" is the one that is not simply the opposite of another option.
  // Apply and Skip both DECIDE; only this un-decides, which is the correction a
  // table actually needs ("wait — un-apply that, we'll redo it") and the only way
  // to put an auto-fired `on` reaction back to a real choice.
  //
  // It is deliberately NOT called "Cancel": this dialog already has a Cancel, and
  // that one discards the GM's unsaved edits. Two Cancels meaning different
  // things in one dialog is a trap. "Ask again" also matches the card's own
  // "Asks (You choose)" mode label.
  //
  // The keep option names what the card would do on its own. On the host that is
  // the LIVE verdict ("Applied" / "Skipped" / still waiting); on a mirror only
  // the dispatch mode is knowable, so it says that instead of guessing.
  const rxRows = Array.isArray(reactions) ? reactions : [];
  // A carrier can present several rows (Adversity: one accuracy, one damage) and
  // the card collapses them into ONE pill. Listing them here as N identically
  // named rows gave the GM no way to tell which was which, so qualify the
  // duplicates by their row key. Only when there IS a duplicate — a lone row
  // stays plainly named.
  const rxNameCount = new Map();
  for (const r of rxRows) rxNameCount.set(r.carrierName, (rxNameCount.get(r.carrierName) ?? 0) + 1);
  const reactionSec = rxRows.length ? `
    <fieldset class="fud-gm-sec">
      <legend>Reactions</legend>
      ${rxRows.map((r) => {
        const key = gmReactionKey(r.rowKey, r.carrierUuid);
        const ov = gm.reactions[key];
        // "" is the no-override value for EVERY select in this editor — it is
        // what markEdited, "Clear all fields" and readForm all key on.
        const sel = ov === true ? "apply" : ov === false ? "skip" : "";
        const keepLabel =
          ov === "ask"           ? "Keep — reopened" :
          r.decision === "apply" ? "Keep — applied" :
          r.decision === "skip"  ? "Keep — skipped" :
          r.mode === "on" || r.mode === "force" ? "Keep — active" :
          r.mode === "off" ? "Keep — disabled" : "Keep — asks";
        // A cost-unavailable candidate stays selectable: the trigger fired and the
        // GM overruling the price is a normal table call. The reason is shown so
        // that call is made knowingly rather than by accident.
        const why = r.unavailableReason ? `<span class="fud-gm-rx-why">${escapeHtml(r.unavailableReason)}</span>` : "";
        const who = r.reactorActorName ? `<span class="fud-gm-rx-who">${escapeHtml(r.reactorActorName)}</span>` : "";
        // The bag value this row STARTED with, so Save can tell "the GM left a
        // stored reopen alone" from "the GM never reopened this". See readForm.
        return `<div class="fud-gm-rxrow" data-fud-gm-rx="${escapeHtml(key)}"${
          ov === "ask" ? ` data-fud-gm-rx-prev="ask"` : ""}>
          <div class="fud-gm-tname">${who}${escapeHtml(r.carrierName ?? "Reaction")}${
            (rxNameCount.get(r.carrierName) ?? 0) > 1
              ? `<span class="fud-gm-rx-why">row ${escapeHtml(String(r.rowKey))}</span>` : ""}${why}</div>
          <select class="fud-gm-sel" data-fud-gm-field="reaction"
                  aria-label="${escapeHtml(`${r.carrierName ?? "Reaction"} — fire this reaction`)}">
            <option value=""${sel === "" ? " selected" : ""}>${escapeHtml(keepLabel)}</option>
            <option value="apply"${sel === "apply" ? " selected" : ""}>Apply</option>
            <option value="skip"${sel === "skip" ? " selected" : ""}>Skip</option>
            <option value="ask">Ask again</option>
          </select>
        </div>`;
      }).join("")}
    </fieldset>` : "";

  const credit = describeGmEditors(gm) ?? "";
  return `<div class="fud-bf-card fud-gm-edit-card" role="dialog" aria-modal="true" aria-label="Edit action">
    <div class="fud-gm-edit-head">
      <span class="fud-gm-edit-title">Edit action</span>
      <span class="fud-gm-edit-sub">${escapeHtml(title)}</span>
    </div>
    <div class="fud-gm-edit-body">
      ${accuracy}${dmgSec}${reactionSec}${targetsSection}
      <p class="fud-gm-note" id="fud-gm-note">A blank box or a <b>Keep</b> entry means no override —
        the grey value beside it is what the engine produced. Nothing changes until you
        save.${credit ? ` <em>${escapeHtml(credit)}</em>` : ""}</p>
    </div>
    <div class="fud-gm-edit-foot">
      <button type="button" class="fud-btn fud-btn-clear" data-fud-gm-action="reset"
              title="Clear every field back to no override (still needs Save)"${isGmOverrideEmpty(gm) ? " disabled" : ""}>Clear all fields</button>
      <button type="button" class="fud-btn fud-btn-back" data-fud-gm-action="cancel">Cancel</button>
      <button type="button" class="fud-btn fud-btn-save" data-fud-gm-action="save">Save</button>
    </div>
  </div>`;
}

// Open the editor over `context`. Resolves to a PATCH on Save (or Clear all) and
// to null on Cancel. The caller decides what to do with it — the host applies it
// directly, a support GM ships it as an EDIT_CARD intent — so both surfaces
// share one editor and cannot drift.
function openGmEditCard(context) {
  return new Promise((resolve) => {
    document.getElementById(GM_EDIT_ROOT_ID)?.remove();
    const root = document.createElement("div");
    root.id = GM_EDIT_ROOT_ID;
    root.innerHTML = buildGmEditCardHTML(context);
    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add("is-visible"));

    const card = root.querySelector(".fud-gm-edit-card");
    const q = (sel) => card.querySelector(sel);
    // Clamp to the control’s own min/max. `min`/`max` on an input outside a
    // <form> are advisory only — nothing enforces them — so a d8 would happily
    // accept a result of 40 and feed it into the total, the crit test and Save.
    const valOf = (el) => {
      if (!el || el.value === "") return null;
      let n = Math.trunc(Number(el.value));
      if (!Number.isFinite(n)) return null;
      const lo = el.min === "" ? null : Number(el.min);
      const hi = el.max === "" ? null : Number(el.max);
      if (lo != null && n < lo) n = lo;
      if (hi != null && n > hi) n = hi;
      if (String(n) !== el.value) el.value = String(n);   // show the correction
      return n;
    };

    // Every optional control now says “no override” the same way — an empty
    // value — so overriding is simply “has a value”. No per-control special
    // cases, and a die size restored from a saved bag still reads as authored.
    const selOverriding = (el) => !!el && el.value !== "";

    // ── Target list ──────────────────────────────────────────────────────────
    // The DOM is the model. Every row carries its own token and staging flags,
    // and both the dirty check and Save reduce the SAME rows through the same
    // function — so "Clear all fields" can never be enabled for a state Save
    // would not write, and vice versa.
    const targetsSec = card.querySelector("[data-fud-gm-targets]");
    const addSel = card.querySelector('[data-fud-gm-field="addTarget"]');
    const liveEl = card.querySelector("[data-fud-gm-tlive]");
    const addableName = new Map((context.addable ?? []).map((t) => [t.tokenUuid, t.name]));
    const targetRows = () => [...card.querySelectorAll("[data-fud-gm-trow]")];

    const readTargetLists = () => reduceGmTargetRows(targetRows().map((row) => ({
      token: row.dataset.fudGmToken ?? null,
      addToken: row.dataset.fudGmAddToken ?? null,
      dropped: row.dataset.fudGmDrop === "1",
    })));
    // How many creatures the action would have after Save — the number the GM is
    // actually deciding, and the guard on removing the last one.
    //
    // Counts RESULTING MEMBERSHIP, not rendered rows. Those stopped being the
    // same thing once bag-only tokens started getting rows: a row can exist for
    // a creature the action does not have (the removal safety net), and counting
    // it inflated the total — which is a way to walk the last-target guard into
    // letting the GM empty the action entirely. A row counts when it survives
    // AND is either an engine member or a staged add.
    const survivingRows = () => targetRows().filter((r) =>
      r.dataset.fudGmDrop !== "1"
      && (r.dataset.fudGmEngine === "1" || !!r.dataset.fudGmAddToken));

    // Announce membership changes, and carry the resulting COUNT — the number a
    // GM is actually deciding, and the one thing a list of rows does not say
    // out loud. Doubles as the screen-reader channel for a row that appears or
    // vanishes without focus moving to it.
    const announce = (msg) => {
      if (!liveEl) return;
      const n = survivingRows().length;
      liveEl.textContent = `${msg} · ${n} target${n === 1 ? "" : "s"} after save`;
    };

    // Rebuild the picker from what is NOT already in the list, so a creature
    // cannot be staged twice and an unstaged one comes straight back.
    const refreshAddOptions = () => {
      if (!addSel) return;
      const taken = new Set(targetRows()
        .flatMap((r) => [r.dataset.fudGmToken, r.dataset.fudGmAddToken])
        .filter(Boolean));
      const opts = [...addableName].filter(([u]) => !taken.has(u));
      // Same placeholder the builder emits — they drifted once, so the picker
      // silently relabelled itself after the first add.
      addSel.innerHTML = `<option value="">Choose a creature…</option>`
        + opts.map(([u, n]) => `<option value="${escapeHtml(u)}">${escapeHtml(n)}</option>`).join("");
      addSel.value = "";
      addSel.closest(".fud-gm-addrow")?.classList.toggle("is-empty", opts.length === 0);
    };

    const markEdited = () => {
      for (const el of card.querySelectorAll(".fud-gm-num")) el.classList.toggle("is-edited", el.value !== "");
      for (const el of card.querySelectorAll(".fud-gm-sel")) el.classList.toggle("is-edited", selOverriding(el));
      // The add picker is a doing-control, not a stored override: its value is
      // consumed the instant it changes. Marking it edited would leave an amber
      // "you set this" rail on a control that holds nothing.
      addSel?.classList.remove("is-edited");
      // Paint each row from its own flag, every pass. `is-cut` used to be
      // written only at BUILD time from the saved bag, so the whole visual
      // signal for "this creature is being dropped" appeared one round late —
      // after Save and reopen, which is exactly when it stops being useful.
      const lastOne = survivingRows().length <= 1;
      for (const row of targetRows()) {
        const cut = row.dataset.fudGmDrop === "1";
        row.classList.toggle("is-cut", cut);
        const nm = row.querySelector(".fud-gm-tname")?.textContent?.trim() ?? "";
        const btn = row.querySelector('[data-fud-gm-action="drop"]');
        if (btn) {
          // The label flips rather than the button gaining a pressed state: a
          // toggle announced as "Remove, pressed" tells a screen-reader user
          // nothing about what pressing it again would do. The staged state is
          // carried by real text in the row (.fud-gm-tcut) and re-announced
          // through the live region, neither of which a strike-through is.
          btn.textContent = cut ? "Restore" : "Remove";
          // The whole phrase, not the bare verb: "Remove" beside a creature
          // name is ambiguous with deleting the token off the board.
          btn.setAttribute("aria-label",
            cut ? `Restore ${nm} to this action` : `Remove ${nm} from this action`);
          // Removing the last one is permitted; it is CONSEQUENTIAL, so the
          // button describes itself against the standing warning rather than
          // being disabled or silently doing nothing.
          const emptying = !cut && lastOne;
          btn.disabled = false;
          btn.dataset.fudGmBlocked = emptying ? "1" : "";
          if (emptying) btn.setAttribute("aria-describedby", GM_TBLOCK_ID);
          else btn.removeAttribute("aria-describedby");
          btn.title = emptying ? "This would leave the action with no targets at all" : "";
        }
        const flag = row.querySelector("[data-fud-gm-tcut]");
        if (flag) flag.textContent = cut ? "Will be removed" : "";
      }
      // The consequence, stated BEFORE it is chosen — visible while some row's
      // Remove would empty the action, and again (in its "done" wording) once
      // the action actually has no targets left.
      const blockNote = card.querySelector("[data-fud-gm-tblock]");
      const emptied = survivingRows().length === 0;
      if (blockNote) {
        blockNote.hidden = !((lastOne || emptied) && targetRows().length > 0);
        blockNote.classList.toggle("is-empty-now", emptied);
        const warn = blockNote.querySelector("[data-fud-gm-tblock-warn]");
        const ahead = blockNote.querySelector("[data-fud-gm-tblock-ahead]");
        if (warn) warn.hidden = !emptied;
        if (ahead) ahead.hidden = emptied;
      }
      // Nothing chosen, nothing to add.
      const addBtn = q('[data-fud-gm-action="add"]');
      if (addBtn) addBtn.disabled = !addSel?.value;
      const hrEl = q('[data-fud-gm-field="useHR"]');
      const hrDefault = !context.damage?.ignoreHR;
      hrEl?.closest(".fud-gm-check")?.classList.toggle("is-edited", !!hrEl && hrEl.checked !== hrDefault);
      // "Clear all fields" only means something once something is set.
      const t = readTargetLists();
      const anySet = [...card.querySelectorAll(".fud-gm-num")].some((e) => e.value !== "")
        || [...card.querySelectorAll(".fud-gm-sel")].some((e) => e !== addSel && selOverriding(e))
        || t.added.length > 0 || t.removed.length > 0
        || (!!hrEl && hrEl.checked !== hrDefault);
      const clearBtn = q('[data-fud-gm-action="reset"]');
      if (clearBtn) clearBtn.disabled = !anySet;
      _dirty = anySet;
    };
    // Whether anything is currently set — read by the discard guards.
    let _dirty = false;
    const isDirty = () => _dirty;

    // Read the whole form into a bag. Absolute values only; an empty box is a
    // real `null`, which the merge treats as "clear this override".
    const readForm = () => {
      const roll = context.roll ? {
        dA: valOf(q('[data-fud-gm-field="dA"]')),
        rA: valOf(q('[data-fud-gm-field="rA"]')),
        dB: valOf(q('[data-fud-gm-field="dB"]')),
        rB: valOf(q('[data-fud-gm-field="rB"]')),
        bonus: valOf(q('[data-fud-gm-field="bonus"]')),
      } : null;
      // The die selects carry an explicit "Keep" entry now, so an untouched one
      // is simply empty and valOf already returns null. No change-detection
      // needed, and a deliberate "this should have been a d20" survives Save.
      const hrEl = q('[data-fud-gm-field="useHR"]');
      const dmgBonus = valOf(q('[data-fud-gm-field="dmgBonus"]'));
      const hrDefault = !context.damage?.ignoreHR;
      const hrChanged = !!(hrEl && hrEl.checked !== hrDefault);
      // Empty string = the "Keep" entry, i.e. no override for that field.
      const elEl = q('[data-fud-gm-field="element"]');
      const wtEl = q('[data-fud-gm-field="weaponType"]');
      const element = elEl && elEl.value ? elEl.value : null;
      const weaponType = wtEl && wtEl.value ? wtEl.value : null;
      const damage = (dmgBonus != null || hrChanged || element || weaponType)
        ? { base: null, useHR: hrEl ? !!hrEl.checked : null, bonus: dmgBonus, element, weaponType }
        : null;
      const perTarget = {};
      // Which tokens got a rendered CONTROL SET this pass. Recorded rather than
      // re-derived, because the carry-forward below has to ask exactly this
      // question and the two answers must not drift.
      const fieldRowTokens = new Set();
      // Walk every ROW and take its token from EITHER attribute. A GM-added
      // creature deliberately carries only `add-token` (that is what makes its
      // Remove an un-add rather than a removal) — keying this loop on
      // `data-fud-gm-token` alone silently dropped every value the GM typed into
      // an added target's row, on a form that had just accepted the keystrokes.
      //
      // Only rows that actually CARRY the fields: a target with no derived
      // result has a row and no controls, and reading it would write an all-null
      // override entry for a creature the GM never touched.
      for (const row of card.querySelectorAll("[data-fud-gm-trow]")) {
        const uuid = row.dataset.fudGmToken || row.dataset.fudGmAddToken || "";
        if (!uuid) continue;
        const sel = row.querySelector('[data-fud-gm-field="hit"]');
        if (!sel) continue;
        fieldRowTokens.add(uuid);
        // A row staged for REMOVAL is read like any other.
        //
        // It used to be skipped — which, because Save replaces this section
        // wholesale and the row still counted as rendered, DESTROYED the GM's
        // outcome/damage for that creature on the next Save. Restore then handed
        // back a creature with its numbers wiped, which is the one thing a
        // reversible control must not do. The reason for the skip was that a
        // removed creature's override was still being COUNTED on the launch
        // button; that is fixed where it belongs, in `gmOverrideBits`, and the
        // consumers that walk `perTarget` now skip removed tokens themselves.
        perTarget[uuid] = {
          hit: sel?.value === "hit" ? true : sel?.value === "miss" ? false : null,
          damage: valOf(row.querySelector('[data-fud-gm-field="damage"]')),
          defense: valOf(row.querySelector('[data-fud-gm-field="defense"]')),
        };
      }
      // A control the editor could not RENDER must not be read as "the GM
      // cleared it". Save sends a wholesale `replace`, so an absent target list
      // would otherwise delete the other GM's target edit with no conflict
      // signal — the exact failure already fixed once for reactions. Fall back
      // to what the bag already holds.
      //
      // One list closes a gap the two-control version had: `removed` was gated
      // on the drop checkbox and `added` on the Add box SEPARATELY, so a client
      // whose canvas offered nothing addable fell back for one half while still
      // writing the other. The halves can no longer diverge.
      const prior = normalizeGmOverride(context.gmOverride);
      const targets = targetsSec ? readTargetLists() : prior.targets;

      // The same rule the target list already follows, applied PER KEY.
      // `perTarget` and `reactions` are reduced over rendered DOM rows, and Save
      // replaces both sections wholesale — so a bag entry whose row this client
      // could not render reads as "the GM cleared it" and is erased. A target
      // off this client's canvas, or a candidate filtered out of the reaction
      // list, is enough.
      //
      // Carry forward only keys that produced NO row. A row that rendered and
      // was deliberately dropped (fudGmDrop) or left on "keep" is a real
      // decision and must still win.
      // (the reactions half runs after that list is built, below)
      // Match the build loop's own test (it emits controls only for a row that
      // has a DERIVED result), not merely "a row exists": a target with no
      // per-target result — a no-damage Skill's victim, a staged add — renders
      // with no controls, and treating that as rendered would drop a prior
      // override instead of carrying it. `fieldRowTokens` is the loop's OWN
      // record of what it read, so the two cannot disagree — and it covers a row
      // identified by its add-token, which a `[data-fud-gm-token=...]` selector
      // does not reach.
      for (const [key, val] of Object.entries(prior.perTarget ?? {})) {
        if (!fieldRowTokens.has(key)) perTarget[key] = val;
      }
      // Reactions. Only real verdicts are sent — a "keep" row contributes NO key,
      // so an untouched candidate can never be mistaken for a suppressed one.
      // (Save replaces this section wholesale, so an omitted key IS the clear.)
      //
      // "Ask again" is TWO things, and they are stored differently on purpose:
      //
      //   the ACTION  — `reopen`, a patch-only list. Clears the decision NOW.
      //   the RULE    — `reactions[key] = "ask"`, stored. Stops the candidate
      //                 auto-firing again when the card is re-posted (F5).
      //
      // The action must never replay: once a player answers the reopened
      // question, re-sending `reopen` would wipe their answer. So a row the GM
      // LEFT ALONE re-emits the stored "ask" (preserving the rule) WITHOUT
      // joining `reopen` (not repeating the action). Picking Apply or Skip
      // overwrites the rule outright, which is what those verdicts mean.
      const reactions = {};
      const reopen = [];
      for (const row of card.querySelectorAll("[data-fud-gm-rx]")) {
        const key = row.dataset.fudGmRx;
        const v = row.querySelector('[data-fud-gm-field="reaction"]')?.value;
        if (v === "apply") reactions[key] = true;
        else if (v === "skip") reactions[key] = false;
        else if (v === "ask") { reopen.push(key); reactions[key] = "ask"; }
        else if (row.dataset.fudGmRxPrev === "ask") reactions[key] = "ask";
      }
      // Second half of the un-rendered-row rule (see perTarget above): a stored
      // verdict whose candidate row this client never drew must survive Save.
      for (const [key, val] of Object.entries(prior.reactions ?? {})) {
        if (!card.querySelector(`[data-fud-gm-rx="${CSS.escape(key)}"]`)) reactions[key] = val;
      }
      return { roll, damage, perTarget, reactions, reopen, targets };
    };

    // The Save patch. `reopen` is hoisted OUT of the replaced bag: the bag is a
    // state and the reopen list is an action, and the merge would silently drop
    // an unknown key inside `replace` anyway.
    const buildPatch = () => {
      const f = readForm();
      return {
        replace: { roll: f.roll, damage: f.damage, perTarget: f.perTarget, reactions: f.reactions, targets: f.targets },
        ...(f.reopen.length ? { reopen: f.reopen } : {}),
      };
    };

    // Live readout of what the typed dice actually produce. The GM enters
    // inputs; the total, Highest Roll and crit/fumble verdict are consequences.
    // Showing them while typing is the difference between entering dice and
    // guessing at a total. (Display only — the engine re-derives on Save with
    // this actor's real crit range and fumble threshold.)
    const refreshDerived = () => {
      const accEl = q('[data-fud-gm-derived="accuracy"]');
      const liveHr = () => {
        const rA = valOf(q('[data-fud-gm-field="rA"]')) ?? Number(context.roll?.rA ?? 0);
        const rB = valOf(q('[data-fud-gm-field="rB"]')) ?? Number(context.roll?.rB ?? 0);
        return Math.max(rA, rB);
      };
      if (accEl && context.roll) {
        const rA = valOf(q('[data-fud-gm-field="rA"]')) ?? Number(context.roll.rA ?? 0);
        const rB = valOf(q('[data-fud-gm-field="rB"]')) ?? Number(context.roll.rB ?? 0);
        // Adjustment, not replacement — so the readout spells the sum out.
        // "Total 19" alone left the GM working out whether their +3 had been
        // added to the existing +8 or had swallowed it.
        const engB = Number(context.roll.checkBonus ?? 0);
        const adj = valOf(q('[data-fud-gm-field="bonus"]')) ?? 0;
        const bonus = engB + adj;
        // Fumble uses the ACTOR's own threshold, not a hardcoded 1 — an actor
        // with fumble_threshold 2 fumbles on 2/2, and the preview said nothing.
        // Crit is flagged "if it lands", because a matching high pair still has
        // to beat each target's defence.
        const fThr = Math.max(1, Number(context.fumbleThreshold) || 1);
        const isFum = rA <= fThr && rB <= fThr;
        const isCrit = !isFum && rA === rB && rA >= 6;
        const verdict = isFum ? " · Fumble" : isCrit ? " · Critical if it lands" : "";
        const sum = adj ? `${rA}+${rB}${engB ? `+${engB}` : ""}${adj > 0 ? `+${adj}` : `−${Math.abs(adj)}`}`
                        : `${rA}+${rB}${engB ? `+${engB}` : ""}`;
        accEl.textContent = `Total ${rA + rB + bonus} (${sum}) · Highest Roll ${Math.max(rA, rB)}${verdict}`;
        accEl.classList.toggle("is-crit", isCrit);
        accEl.classList.toggle("is-fumble", isFum);
      }
      const dmgEl = q('[data-fud-gm-derived="damage"]');
      if (dmgEl && context.damage) {
        const engBase = Number(context.damage.base ?? 0);
        const base = engBase;
        const bonus = valOf(q('[data-fud-gm-field="dmgBonus"]')) ?? 0;
        const useHr = !!q('[data-fud-gm-field="useHR"]')?.checked;
        const hr = context.roll ? liveHr() : Number(dmgEl.dataset.fudGmHr ?? 0);
        const dSum = `${base}${useHr ? `+${hr}` : ""}${bonus ? (bonus > 0 ? `+${bonus}` : `−${Math.abs(bonus)}`) : ""}`;
        // The checkbox's own number has to track the edited dice too — baked in
        // at build time it kept showing the PRE-edit highest roll, contradicting
        // the accuracy readout two sections above it.
        const hrLabel = q("[data-fud-gm-hrlabel]");
        if (hrLabel) hrLabel.textContent = `(${hr})`;
        // Named for what it actually is: crit bonus/multiplier, damage
        // reduction, weapon efficiency and affinity all still apply after this.
        // "Before affinity" implied affinity was the only thing left.
        dmgEl.textContent = `Before crit and affinity: ${base + bonus + (useHr ? hr : 0)} (${dSum})`;
      }
      // Keep each die's max in step with its selected size, so a d8 cannot be
      // given a result of 40 and quietly feed that into the total.
      for (const [selSel, numSel] of [['[data-fud-gm-field="dA"]', '[data-fud-gm-field="rA"]'],
                                      ['[data-fud-gm-field="dB"]', '[data-fud-gm-field="rB"]']]) {
        const s = q(selSel), n = q(numSel);
        if (s && n) n.max = String(Number(s.value) || 12);
      }
      markEdited();
    };
    refreshDerived();
    card.addEventListener("input", refreshDerived);
    card.addEventListener("change", refreshDerived);

    // Add APPENDS a row and resets the picker, so the control can be used again
    // immediately — the whole point of the rebuild. The single <select> it
    // replaces held the pending add as its own value, which is why a second
    // pick silently overwrote the first.
    const addStagedTarget = () => {
      const uuid = addSel?.value;
      if (!uuid) return;
      const name = addableName.get(uuid) ?? "Target";
      addSel.closest(".fud-gm-addrow")
        ?.insertAdjacentHTML("beforebegin", gmTargetRowHTML({ addToken: uuid, name }));
      refreshAddOptions();
      announce(`${name} added`);
      // Focus stays on the picker, which is now back at its placeholder and
      // ready for the next creature.
      try { addSel.focus(); } catch { /* the picker may have just emptied */ }
      refreshDerived();
    };

    // Return focus where it came from — a GM who opened this from the keyboard
    // is otherwise dumped at the top of the document on close.
    const returnFocus = document.activeElement;
    let done = false;
    const close = (result) => {
      if (done) return;
      done = true;
      root.classList.remove("is-visible");
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => root.remove(), 160);
      try { returnFocus?.focus?.(); } catch { /* the card may already be gone */ }
      resolve(result);
    };

    const focusables = () => [...card.querySelectorAll(
      'input:not([disabled]), select:not([disabled]), button:not([disabled])')];

    // Escape cancels, matching every other dismissable overlay in the director.
    // Enter saves, so a GM who has just typed a value never has to reach for the
    // mouse. Tab is trapped: this is aria-modal, and without it focus walks
    // straight out into the action card behind the dimmer.
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault(); ev.stopPropagation();
        if (isDirty() && !confirm("Discard your unsaved edits to this action?")) return;
        return close(null);
      }
      if (ev.key === "Enter" && !ev.shiftKey && card.contains(ev.target)) {
        // Not from a button — Space/Enter on a button should do that button.
        // Not from a button, and not from a select — Enter is how you commit an
        // open native dropdown, so saving on it would fire the moment a GM
        // picked a die size with the keyboard.
        if (ev.target.tagName === "BUTTON" || ev.target.tagName === "SELECT") return;
        ev.preventDefault(); ev.stopPropagation();
        return close(buildPatch());
      }
      if (ev.key === "Tab") {
        const list = focusables();
        if (!list.length) return;
        const first = list[0], last = list[list.length - 1];
        const active = document.activeElement;
        if (!card.contains(active)) { ev.preventDefault(); first.focus(); return; }
        if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
        else if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);

    // Clicking the dimmed backdrop cancels — the same as Cancel, and the
    // behaviour a dimmer implies. Guarded to the backdrop itself so a click
    // inside the card never dismisses it.
    // Backdrop click cancels — but never silently throws away typed work. When
    // something is set it asks first; an accidental click outside a 384px
    // dialog should not cost the GM their edits.
    root.addEventListener("mousedown", (ev) => {
      if (ev.target !== root) return;
      if (isDirty() && !confirm("Discard your unsaved edits to this action?")) return;
      close(null);
    });

    // Focus the first real field so the editor is usable from the keyboard the
    // moment it opens.
    // Focus the first NUMBER field, never the die select: landing on a select
    // means the first Arrow-Down — or a scroll over the dialog — silently
    // changes the die size and records it as a deliberate override.
    requestAnimationFrame(() => {
      try { (card.querySelector(".fud-gm-num") ?? card).focus(); } catch { /* no-op */ }
    });

    card.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-fud-gm-action]");
      if (!btn) return;
      ev.preventDefault(); ev.stopPropagation();
      const action = btn.dataset.fudGmAction;
      if (action === "add") return addStagedTarget();
      // Remove / Restore on a target row.
      if (action === "drop") {
        const row = btn.closest("[data-fud-gm-trow]");
        if (!row) return;
        const name = row.querySelector(".fud-gm-tname")?.textContent?.trim() ?? "Target";
        // Removing the LAST target is ALLOWED, and is not the same call as
        // cancelling the card.
        //
        // It used to be refused, on the grounds that the card's surface rebuild
        // was gated on `recomputed.length` so an emptied action left every
        // original row painted as though still being hit. That was a RENDER
        // limitation dressed as a rule, and it made Remove unusable on the
        // commonest card shape there is — a single-target attack. The rebuild
        // now runs on an empty set and says so, and RESOLVE was measured on one
        // (2026-08-23, runDirectorAttackSimulate with every target removed):
        // it completes cleanly and writes NOTHING.
        //
        // The two calls are genuinely different and the GM needs both. Cancel
        // calls the action off — no cost, the turn is not spent. Emptying the
        // targets resolves it against nobody: the cost is still paid, the turn
        // is spent, self-effects still run. "Your shot goes wide, the creature
        // was never there" is the second one.
        // A staged add that has not been derived yet is not part of the action,
        // so there is nothing to strike through — discard the row and hand the
        // option back. Leaving a struck-through ghost for a creature the action
        // never had would read as "removing a target", which is false.
        if (row.dataset.fudGmAddToken && !row.dataset.fudGmToken) {
          row.remove();
          refreshAddOptions();
          announce(`${name} removed`);
          // Focus would otherwise fall to the document root, since the button
          // that had it no longer exists.
          try { addSel?.focus(); } catch { /* the picker may be hidden */ }
          refreshDerived();
          return;
        }
        if (row.dataset.fudGmDrop === "1") delete row.dataset.fudGmDrop;
        else row.dataset.fudGmDrop = "1";
        announce(`${name} ${row.dataset.fudGmDrop === "1" ? "will be removed" : "restored"}`);
        refreshDerived();
        return;
      }
      if (action === "cancel") return close(null);
      // Clear all is a FORM operation, not a commit. It used to close the
      // dialog and wipe every override for the table immediately — directly
      // contradicting the note two lines above it that says nothing changes
      // until you save, and sitting right beside Save where a mis-aimed click
      // lands. Now it empties the fields and leaves Save to commit, so Cancel
      // still undoes it.
      if (action === "reset") {
        for (const el of card.querySelectorAll(".fud-gm-num")) el.value = "";
        for (const el of card.querySelectorAll(".fud-gm-sel")) el.value = "";
        // The target list is not made of .fud-gm-num / .fud-gm-sel, so the two
        // loops above do not reach it. It was silently exempt once already:
        // Clear-all + Save dropped the add and KEPT the removal, the opposite
        // of what this button promises.
        for (const row of targetRows()) {
          // Clearing every override leaves the action with exactly what the
          // ENGINE targeted. A staged add was never part of that, so it goes.
          if (row.dataset.fudGmAddToken && !row.dataset.fudGmToken) { row.remove(); continue; }
          // A row the engine DOES target keeps its place, but stops carrying
          // the GM's marks: un-staged, and no longer counted as an add (which
          // is itself an override).
          delete row.dataset.fudGmDrop;
          delete row.dataset.fudGmAddToken;
          row.classList.remove("is-added");
          row.querySelector(".fud-gm-tbadge")?.remove();
        }
        refreshAddOptions();
        const hrEl = q('[data-fud-gm-field="useHR"]');
        if (hrEl) hrEl.checked = !context.damage?.ignoreHR;
        // The live region holds whatever the last membership change said. Left
        // alone it survives Clear-all and states a count that is now wrong,
        // which is worse than saying nothing.
        if (liveEl) announce("Cleared");
        refreshDerived();
        q('[data-fud-gm-field="rA"]')?.focus();
        return;
      }
      if (action === "save") return close(buildPatch());
    });
  });
}

// Wire the launch button inside any container (host card root OR a support GM's
// mirror wrapper). `getContext()` supplies the editor's current values at click
// time — not at wire time — so the editor always opens on the card's LATEST
// state, including anything a reaction changed since the card was posted.
function wireGmEditLaunch(container, getContext, onPatch) {
  const btn = container?.querySelector?.("[data-fud-gm-launch]");
  if (!btn || btn.dataset.fudGmWired === "1") return;
  btn.dataset.fudGmWired = "1";
  btn.addEventListener("click", async (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    if (btn.dataset.fudGmOpen === "1") return;
    btn.dataset.fudGmOpen = "1";
    try {
      const patch = await openGmEditCard(getContext());
      if (patch) await onPatch(patch);
    } catch (e) {
      warn("wireGmEditLaunch: editor threw", e);
    } finally {
      delete btn.dataset.fudGmOpen;
    }
  });
}
// ── Fitting the card to the viewport ─────────────────────────────────────────
//
// The card is position:fixed and centred, with nothing scrollable above it, so
// overflow is not merely ugly — it is UNREACHABLE. Measured before this existed:
// a 3-target card with 7 reaction pills stood 978px tall and put CONFIRM off the
// bottom at 1280x900, on a perfectly ordinary desktop.
//
// The panels are the readout the GM is deciding from, so every panel stays on
// screen. What gives is the content INSIDE the three regions that grow without
// bound — the target list, the reaction list and the effect prose.
//
// This is done here rather than in CSS because the cap depends on how much room
// the FIXED panels leave, which no CSS length can express. (The two pure-CSS
// attempts and why each failed are recorded beside the rules in ensureStyles.)
// Never crush a region past roughly one row. 36 rather than 46 is measured, not
// taste: at 46 a 3-target/7-pill card on a 720p laptop — the commonest small
// screen there is — came 22px short of fitting, so the body scrolled for the
// sake of 10px per region that nobody was reading.
const FIT_REGION_MIN = 36;
const FIT_VIEWPORT_PAD = 16;

export function fitActionCardToViewport(rootEl) {
  // Callers pass the ROOT (postActionCard), the mirror WRAPPER, or sometimes the
  // card itself (the delta patcher is called both ways) — accept all three.
  const card = rootEl?.classList?.contains?.("fud-bf-card")
    ? rootEl
    : rootEl?.querySelector?.(".fud-bf-card");
  if (!card) return;
  try {
    const regions = [
      card.querySelector(".fud-bf-target-list"),
      card.querySelector(".fud-bf-effect-body"),
      card.querySelector(".fud-bf-reactions-list"),
    ].filter(Boolean);
    if (!regions.length) return;
    // Measure the card's NATURAL height, which means undoing two things first:
    // last pass's caps (or the caps only ever ratchet downwards) and the CSS
    // max-height clamp. Leaving the clamp on was a silent no-op — the card
    // always measured exactly the viewport height, so the deficit was always
    // zero and nothing was ever capped.
    for (const el of regions) el.style.maxHeight = "";
    const prevClamp = card.style.maxHeight;
    card.style.maxHeight = "none";
    const natural = card.getBoundingClientRect().height;
    const sized = regions
      .map((el) => ({ el, h: el.getBoundingClientRect().height }))
      .filter((r) => r.h > FIT_REGION_MIN);
    card.style.maxHeight = prevClamp;               // back to the stylesheet

    // Mark whatever ends up clipped, so a capped list says so. Runs on every
    // path including the early return — a region can be scrollable for reasons
    // that have nothing to do with the cap.
    const markClipped = () => {
      for (const el of regions) {
        el.classList.toggle("is-clipped", el.scrollHeight > el.clientHeight + 1);
      }
    };

    const avail = Math.max(240, window.innerHeight - FIT_VIEWPORT_PAD);
    const deficit = Math.ceil(natural - avail);
    if (deficit <= 0) { markClipped(); return; }    // it already fits: leave it alone
    if (!sized.length) return;                      // nothing left to give


    // Water-filling: lower a common ceiling until the regions have collectively
    // given up the deficit. Trimming the TALLEST first is the point — a single
    // long description should not force the target list down to one row while
    // it keeps twenty.
    const total = sized.reduce((a, r) => a + r.h, 0);
    const target = Math.max(sized.length * FIT_REGION_MIN, total - deficit);
    const desc = [...sized].sort((a, b) => b.h - a.h);
    let ceiling = desc[0].h;
    for (let i = 0; i < desc.length; i++) {
      // If every region were capped at the next height down, would that be
      // enough? If so the answer lies between, so solve for it exactly.
      const next = i + 1 < desc.length ? desc[i + 1].h : FIT_REGION_MIN;
      const atNext = sized.reduce((a, r) => a + Math.min(r.h, next), 0);
      if (atNext <= target) {
        const n = i + 1;                             // regions currently at the ceiling
        const rest = sized.reduce((a, r) => a + Math.min(r.h, next), 0)
          - desc.slice(0, n).reduce((a, r) => a + Math.min(r.h, next), 0);
        ceiling = Math.max(FIT_REGION_MIN, (target - rest) / n);
        break;
      }
      ceiling = next;
    }
    for (const r of sized) {
      if (r.h > ceiling) r.el.style.maxHeight = `${Math.max(FIT_REGION_MIN, Math.floor(ceiling))}px`;
    }
    markClipped();
  } catch (e) {
    warn("fitActionCardToViewport threw", e);
  }
}

// One listener for the lifetime of the page, re-fitting whatever card is up.
// rAF-coalesced: a drag-resize fires resize continuously, and each fit is a
// forced layout.
let _fitPending = false;
function scheduleActionCardFit() {
  if (_fitPending) return;
  _fitPending = true;
  requestAnimationFrame(() => {
    _fitPending = false;
    for (const id of [ROOT_ID, MIRROR_ROOT_ID]) {
      const el = document.getElementById(id);
      if (el) fitActionCardToViewport(el);
    }
  });
}
// REPLACE the handler rather than guarding on a boolean. The flag lives on
// `window` and outlives a module re-import, so a boolean guard pins the listener
// to whichever instance loaded FIRST — in production that is merely untidy, but
// under the harness (which re-imports with a cache-bust every call) it meant the
// resize handler was permanently the first version loaded that session, and a
// fixed function kept measuring as if it were still broken.
if (typeof window !== "undefined") {
  if (window.__fudCardFitHandler) window.removeEventListener("resize", window.__fudCardFitHandler);
  window.__fudCardFitHandler = scheduleActionCardFit;
  window.addEventListener("resize", scheduleActionCardFit);
}

// ── Auto-confirm veto strip (Summon Autopilot) ───────────────────────────────
// A summon's card confirms itself after a veto window. The strip announces that
// and shows how long is left. The countdown BAR is a pure CSS animation started
// at render time, so the player-side mirror (which receives this markup verbatim,
// or rebuilds it from the projected render payload) shows a live, roughly-synced
// countdown with no extra sockets. The numeric readout + the actual confirm are
// driven GM-side by armAutoConfirmVeto — the CSS is decoration, never authority.
//
// Pausing while a reaction pill is undecided is handled in CSS off the card's
// existing data-fud-reactions-pending attribute, so it pauses on every client.
function buildAutoConfirmVetoHTML(autoConfirm) {
  const ms = Number(autoConfirm?.ms);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const secs = Math.max(0, Math.round(ms / 1000));
  return `
    <div class="fud-bf-veto" data-fud-veto-ms="${ms}">
      <div class="fud-bf-veto-bar" style="animation-duration:${ms}ms;"></div>
      <div class="fud-bf-veto-text">
        <span class="fud-bf-veto-label">🐾 Summon on autopilot</span>
        <span class="fud-bf-veto-count">${secs}s · click to hold</span>
      </div>
    </div>
  `;
}

function assembleActionCardRoot({ card, cardReactions, rootId, payload = null, kind = null }) {
  const list = Array.isArray(cardReactions) ? cardReactions : [];
  const askPassives = list.filter((p) => p?.mode === "ask" && p?.available !== false);
  const reactionRowHtml = list.length ? buildReactionPillRow(list) : "";
  // `initialPending` (ALL actionable ask pills) arms the GM's REACTION_CHOICE
  // listener loop so the owner can apply their OWN reactions too — keep it total.
  // The Confirm LOCK, however, only counts THIRD-PARTY ask pills (reactor is
  // another creature): a monster/ally reaction blocks the owner's Confirm, but
  // the owner's own reactions never do. Both must stay in sync with the
  // per-pill data-fud-reaction-gating flag the counter paths read.
  const initialPending = askPassives.length;
  const initialGating = askPassives.filter((p) => !!p?.reactorActorUuid).length;
  // GM edit launch button — rendered only for GM clients. The host's rendered
  // HTML is also broadcast verbatim to players for non-local-render kinds, so
  // the mirror handler STRIPS this node for non-GMs as well; that strip is the
  // authoritative gate and this check just keeps the markup out of the
  // local-render path.
  let gmEditHtml = "";
  try {
    if (game.user?.isGM) gmEditHtml = buildGmEditLaunchHTML(payload?.gmOverride ?? null);
  } catch (e) { warn("assembleActionCardRoot: GM edit launch build threw", e); }
  const innerHTML = `
    <div class="fud-bf-card" role="dialog" aria-label="${escapeHtml(card.titleText)}"${initialGating > 0 ? ` data-fud-reactions-pending="${initialGating}"` : ""}>
      <div class="fud-bf-header">
        <div class="fud-bf-portrait-slot left">${card.portraits?.left ?? ""}</div>
        <div class="fud-bf-title-row">
          ${card.titleIcon ?? ""}
          <span class="fud-bf-title">${escapeHtml(card.titleText)}</span>
        </div>
        <div class="fud-bf-portrait-slot right">${card.portraits?.right ?? ""}</div>
        <!-- Inside the HEADER so it can dock on that element's bottom rule.
             Absolutely placed, so it still displaces nothing; the header is
             also the one region no repaint path replaces
             (rerenderCardTargetSurfaces rebuilds the attacker row, the portrait
             slots' contents and the target list — never this). -->
        ${gmEditHtml}
      </div>
      ${card.subtitle ?? ""}
      <div class="fud-bf-body">${card.body}</div>
      ${reactionRowHtml}
      ${buildAutoConfirmVetoHTML(payload?.autoConfirm ?? null)}
      ${card.buttons}
    </div>
  `;
  const root = document.createElement("div");
  root.id = rootId;
  root.innerHTML = innerHTML;
  return { root, initialPending };
}

export function stripHtmlForDesc(html) {
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
// ─── Transform (weapon-form) + Equipment economy — shared card helpers ──────
// Used by BOTH the GM card (postActionCard) and the player mirror so the two
// stay in lockstep. They operate on any container element (GM `root` / mirror
// `wrapper`) via querySelector — no per-client state.

// Select a weapon-form chip: mark it active, stamp the row's current index,
// flag the row modified vs its initial form.
function handleFormChipClick(container, formChip) {
  const frow = formChip.closest(".fud-bf-form-row");
  if (!frow) return;
  for (const c of frow.querySelectorAll(".fud-bf-form-chip")) {
    c.classList.toggle("is-active", c === formChip);
  }
  frow.dataset.fudFormCurrent = formChip.dataset.fudFormIdx || "0";
  frow.classList.toggle("is-modified", frow.dataset.fudFormCurrent !== (frow.dataset.fudFormInitial || "0"));
}

// Collect the { main, off } → formIndex map from the card's form rows (or null).
function collectWeaponFormSelections(container) {
  const rows = container.querySelectorAll(".fud-bf-form-row[data-fud-form-slot]");
  if (!rows.length) return null;
  const map = {};
  for (const r of rows) {
    const slot = r.dataset.fudFormSlot;
    if (slot) map[slot] = Number(r.dataset.fudFormCurrent || 0) || 0;
  }
  return map;
}

// Live read of the Equipment action's economy from the DOM — mirrors
// planEquipmentActionCost (equipment-swap.js, the authoritative copy run at
// CONFIRM): a gear change OR a changed form on a weapon whose per-round free
// transform is spent (data-fud-form-free-avail !== "1", baked GM-side) makes the
// action cost the turn. Returns { gearChanged, formChanged, free }.
function computeEquipFreeState(container) {
  let gearChanged = false;
  for (const r of container.querySelectorAll(".fud-bf-equip-row[data-fud-equip-slot]")) {
    if ((r.dataset.fudEquipCurrent || "") !== (r.dataset.fudEquipInitial || "")) { gearChanged = true; break; }
  }
  let formChanged = false, allFreeAvail = true;
  for (const fr of container.querySelectorAll(".fud-bf-form-row[data-fud-form-slot]")) {
    if ((fr.dataset.fudFormCurrent || "0") !== (fr.dataset.fudFormInitial || "0")) {
      formChanged = true;
      if (fr.dataset.fudFormFreeAvail !== "1") allFreeAvail = false;
    }
  }
  return { gearChanged, formChanged, free: !gearChanged && allFreeAvail };
}

// Update the Equipment card's Done-button economy indicator in place.
function updateEquipFreeIndicator(container) {
  const ind = container.querySelector(".fud-bf-equip-free-ind");
  if (!ind) return;
  const { gearChanged, formChanged, free } = computeEquipFreeState(container);
  ind.classList.remove("is-free", "is-paid", "is-none");
  if (!gearChanged && !formChanged) {
    ind.classList.add("is-none");
    ind.textContent = "No changes — returns to menu";
  } else if (free) {
    ind.classList.add("is-free");
    ind.textContent = "Free Action — won't end your turn";
  } else {
    ind.classList.add("is-paid");
    ind.textContent = "Costs your Action";
  }
}

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

  // Pre-compute bonus from auto-accepted (on/force) card-reactions so the
  // damage header reflects passive bonuses before the player confirms.
  // "ask"-mode passives are uncertain — we don't pre-apply them to the header.
  // on AND force both auto-apply (isAutoFireReactionMode) — force is engine-
  // mandatory but otherwise identical to on, so it must fold into the damage too.
  // Fire-and-forget: any throw leaves effectivePayload = payload (no bonus shown).
  let effectivePayload = payload;
  {
    const autoCardReactions = (Array.isArray(payload?.cardReactions) ? payload.cardReactions : [])
      .filter((p) => isAutoFireReactionMode(p?.mode) && p?.available !== false);
    if (autoCardReactions.length && payload?.attackerActor && Array.isArray(payload?.perTargetResults)) {
      try {
        const { computeSenderDamageBonuses } = await import("./skill-effects.js");
        const bonusMap = await computeSenderDamageBonuses({
          casterActor: payload.attackerActor,
          acceptedCardReactions: autoCardReactions,
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
                cardReactionBonus: maxBonus,
              },
            };
          }
        }
      } catch (e) { warn("postActionCard: card-reaction bonus preview threw", e); }
    }
  }

  // Build the card defensively. If the whole composition throws, we
  // still produce a minimal "something went wrong but proceed" card so
  // the FSM doesn't abort — the player can confirm and the dice that
  // were already rolled get applied. Sub-section failures are absorbed
  // by tryBuild() inside the builders.
  // The Equipment card bakes each weapon's per-round free-transform availability
  // (for the Done-button economy indicator) — it needs the authoritative BD round.
  if (kind === "Equipment") {
    // Armor swap is RAW-forbidden mid-combat, so it's only offered in a debug /
    // lean battle (the commit re-checks this authoritatively). Same devMode/lean
    // signal the battle-end + init paths read.
    const allowArmor = !!(
      director?.ctx?.payload?.options?.devMode ||
      director?.ctx?.payload?.context?.lean
    );
    effectivePayload = { ...effectivePayload, round: director?.dCombat?.round ?? 0, allowArmor };
  }

  let card = null;
  try {
    // Known kinds (Attack/Guard/Study/Hinder/Equipment/Skill/Item) route through
    // the shared composer — single source of truth with rerenderActionCardBody +
    // the test harness. Unknown kinds fall through to the minimal card below.
    card = composeActionCardObject({ kind, payload: effectivePayload });
    if (!card) {
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
  const cardReactions = Array.isArray(payload?.cardReactions) ? payload.cardReactions : [];
  // Stamp each reaction candidate with the user who owns its REACTOR so
  // the mirror can gate Apply/Skip per-pill (a player applies only their
  // own creature's reactions). Self-reactions (no reactorActorUuid) react
  // as the action-taker, so they resolve against the attacker actor.
  {
    const attackerActorUuid = payload?.attacker?.actorUuid
      ?? payload?.attackerActorRef
      ?? payload?.attackerActor?.uuid
      ?? payload?.attackerActorUuid
      ?? null;
    for (const p of cardReactions) {
      try {
        p.reactorOwnerUserId = await resolveCardOwnerUserId(p.reactorActorUuid ?? attackerActorUuid);
      } catch { p.reactorOwnerUserId = null; }
    }
  }
  // Assemble the card via the shared template (single source with the player-side
  // mirror render). `initialPending` (count of ALL actionable ask pills) arms the
  // REACTION_CHOICE listener loop below so the owner can apply their own reactions;
  // the Confirm LOCK itself is driven by the third-party-only counter baked into
  // the card's data-fud-reactions-pending attribute (see assembleActionCardRoot).
  const { root, initialPending } = assembleActionCardRoot({ card, cardReactions, rootId: ROOT_ID, payload: effectivePayload, kind });
  document.body.appendChild(root);
  requestAnimationFrame(() => {
    root.classList.add("is-visible");
    // Cap the growing regions before the card is shown, not after — fitting a
    // visible card makes the lists visibly jump to their capped height.
    fitActionCardToViewport(root);
  });

  log("Battlefield action card spawned", card.titleText);

  // Broadcast the card to all active non-GM clients so they see the same card as
  // the GM. Owner gets interactive buttons; other observers get a read-only mirror.
  // See [[director-player-driven-input]].
  //
  // For kinds the client can re-derive (ACTION_CARD_LOCAL_RENDER_KINDS) we ship a
  // COMPACT render payload and let the mirror rebuild the card locally from the
  // shared builders — far less over the wire than the full rendered HTML, which is
  // the dominant slow-client latency for "card opens late". Equipment / Item /
  // unknown kinds fall back to shipping the rendered outerHTML. Owner detection
  // uses the attacker actor UUID embedded in the payload.
  let ownerUserId = null;
  try {
    const attackerActorUuid = payload?.attacker?.actorUuid
      ?? payload?.attackerActorRef
      ?? null;
    ownerUserId = attackerActorUuid
      ? (await resolveCardOwnerUserId(attackerActorUuid))
      : null;
    const useLocalRender = ACTION_CARD_LOCAL_RENDER_KINDS.has(kind);
    const renderPayload = useLocalRender ? projectActionCardRenderPayload(effectivePayload) : null;
    const cardHTML = useLocalRender ? null : root.outerHTML;
    // Broadcast to ALL non-primary clients: players + secondary GMs. Every
    // recipient gets the identical spec, so this is ONE emit addressed to all
    // of them rather than one per user — see IntentChannel.normalizeTargets.
    const onlineNonPrimary = (game.users?.contents ?? []).filter((u) => u.active && u.id !== game.user?.id);
    try {
      director.intentChannel?.broadcastMenuOpen({
        targetUserIds: onlineNonPrimary.map((u) => u.id),
        menuSpec: {
          kind: "action-card",
          combatId: director.combatId,
          cardKind: kind,
          ownerUserId,
          attackerActorUuid,
          html: cardHTML,
          renderPayload,
          actionResult: projectActionResultForRender(director.ctx.actionResult),
        },
      });
    } catch (e) { warn("postActionCard: broadcast threw", e); }
  } catch (e) { warn("postActionCard: broadcast setup threw", e); }

  // Tracks which invoke types have been used for this action card instance.
  // Mutated by invoke-worker; read by patchCardDom and the click handler.
  const invokeState = { trait: false, bond: false };

  // ── Per-card action-result identity (invoke targeting) ───────────────────
  // `director.ctx.actionResult` is a single SHARED slot that every FSM state
  // overwrites. Invoke must reroll/pay for the actor THIS card belongs to —
  // not whatever action the director happens to be tracking when the button
  // is clicked (e.g. after the GM selects another token). So capture the
  // card's own result + its stable instance id up front, mirror the live slot
  // into `cardAr` (kept in sync as invoke mutates it), and key every invoke
  // read off `cardAr` instead of the shared slot. `cardInstanceId` lets the
  // handlers detect when the director has genuinely moved on to a different
  // action and refuse, rather than acting on the wrong actor.
  let cardAr = director.ctx.actionResult;
  const cardInstanceId = cardAr?._instanceId ?? null;

  return new Promise((resolve) => {
    let resolved = false;
    let despawnTid = null;
    let keyListener = null;

    const finish = (outcome, extras = {}) => {
      if (resolved) return;
      resolved = true;
      // CRITICAL: everything between here and resolve() below can throw — DOM ops
      // on a torn-down card, or a malformed reaction-decision snapshot. If it does,
      // we MUST still call resolve(), or Confirm.onEnter's `await postActionCard`
      // hangs and the FSM parks in CONFIRM forever (the `.catch` on the remote
      // await is silenced once `resolved` is true, so the throw is invisible). Wrap
      // the whole body and resolve in a `finally`-style tail regardless of outcome.
      let reactionDecisions = [];
      try {
        // Abort the unused remote awaits so they don't linger and steal
        // the next turn's matching intent. Defined below in this Promise
        // constructor; safe to reference via closure hoisting.
        try { abortPendingAwaits?.(); } catch {}
        // Tell all non-primary clients (players + secondary GMs) to close
        // their mirror cards. GM-side DOM despawns via the timeout below.
        try {
          const onlineNonPrimary = (game.users?.contents ?? []).filter((u) => u.active && u.id !== game.user?.id);
          try {
            director.intentChannel?.broadcastMenuClose({
              targetUserIds: onlineNonPrimary.map((u) => u.id),
              kind: "action-card",
              reason: `card-${outcome}`,
            });
          } catch {}
        } catch {}

        for (const b of root.querySelectorAll(".fud-btn")) b.classList.add("is-resolved");

        root.classList.remove("is-visible");
        root.classList.add("is-resolving");
        const fadeMs = outcome === "confirm" ? 480 : 240;
        despawnTid = setTimeout(() => {
          try { root.remove(); } catch {}
          try { descTip?.remove(); } catch {}
          descTip = null;
          // Run the overlay's own teardown before dropping the entry. Deleting
          // it alone orphaned every listener/hook the card had registered —
          // the picker hooks below, and (once summons could auto-confirm) a
          // window keydown handler per card, since the NEXT postActionCard read
          // _overlays.get() → undefined and so never chained the prior cleanup.
          // cleanup() is re-entrant: `resolved` is already true, so its
          // resolve-guard is a no-op and a second root.remove() is harmless.
          // …but ONLY if the slot still holds OUR card. The fade is ~480ms and a
          // multi-pass action posts the next card inside that window, so an
          // unguarded cleanup here would tear down the card that just replaced
          // us — and an unguarded delete would drop its record.
          const rec = _overlays.get(director.combatId);
          if (rec?.root === root) {
            try { rec.cleanup?.(); } catch {}
            _overlays.delete(director.combatId);
          }
        }, fadeMs);

        if (keyListener) {
          try { window.removeEventListener("keydown", keyListener, true); } catch {}
          keyListener = null;
        }

        // Defensive: kill any pending tooltip work so a dwell timer or rAF
        // that hasn't fired yet doesn't surface a ghost tooltip on top of
        // the (already dismissed) card.
        try { hideDescTip(); } catch {}

        // Reaction-pill decisions so resolve can apply pre-accepted passives.
        reactionDecisions = snapshotReactionDecisions();
      } catch (e) {
        warn("postActionCard.finish: threw before resolve — resolving anyway to keep the FSM alive", e);
      }

      // Pass any caller-supplied button data (e.g. status pick on Hinder) back to
      // Confirm alongside the reaction-pill decisions. ALWAYS runs, even if the
      // body above threw — a partial teardown must never hang the turn.
      resolve({
        confirmed: outcome === "confirm",
        reactionDecisions,
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
    // What each pill would decide with NO GM opinion at all: the auto-fire
    // verdict at spawn, plus every genuine Apply/Skip. Kept beside the effective
    // map purely so CLEARING a GM reaction override can restore what the card
    // itself decided — the effective map alone has no memory of it, so a cleared
    // override would otherwise strand the pill on the GM's last verdict.
    const baseDecisionMap = new Map();
    // Decision-map keys (single colon) currently carrying a GM verdict. Read off
    // the live bag each time rather than cached — a support GM's edit lands via
    // the socket and must be visible to the very next pill write.
    const gmDecidedKeys = () => {
      const gm = normalizeGmOverride(director.ctx.actionResult?.gmOverride ?? cardAr?.gmOverride ?? null);
      const out = new Set();
      for (const key of Object.keys(gm.reactions)) {
        const i = key.lastIndexOf("::");
        if (i >= 0) out.add(`${key.slice(0, i)}:${key.slice(i + 2)}`);
      }
      return out;
    };
    // The engine/player write path. A GM verdict OUTRANKS the card, so a late
    // auto-accept or a stray click can never silently overwrite it — the base
    // still records what the card wanted, ready for the override being cleared.
    const setReactionDecision = (key, decision) => {
      baseDecisionMap.set(key, decision);
      if (!gmDecidedKeys().has(key)) reactionDecisionMap.set(key, decision);
    };
    const clearReactionDecision = (key) => {
      baseDecisionMap.delete(key);
      if (!gmDecidedKeys().has(key)) reactionDecisionMap.delete(key);
    };
    for (const p of cardReactions) {
      const key = `${p.rowKey}:${p.carrierUuid}`;
      // "on" + "force" both auto-apply (force is engine-mandatory, on
      // is player-set auto-apply; same effect on the decision map) — but NOT
      // when unavailable (can't pay cost): a surfaced-dimmed on/force pill must
      // never auto-fire, or RESOLVE would try to consume a resource the actor
      // doesn't have. It stays a dimmed informational pill instead.
      // A candidate the GM sent back to undecided must NOT re-arm itself on a
      // re-post — the auto-apply below runs on every card build, so without this
      // an F5 silently undid the un-decision.
      // Honour the same editability filter gmReactionDecisionChanges applies
      // (gm-card-override.js). A candidate the GM may no longer edit — an
      // unaffordable force, say — must not keep steering this build from a
      // stored verdict: isGmEditableReaction exists so a force cannot bank the
      // benefit without paying the cost. Unfiltered, a stale "ask" here also
      // suppresses auto-fire on a candidate the editor will never draw again,
      // and nothing in the UI can then clear it.
      if (!isGmEditableReaction(p)) continue;
      if (gmReactionBlocksAutoFire(cardAr?.gmOverride ?? null, p.rowKey, p.carrierUuid)) continue;
      if (isAutoFireReactionMode(p.mode) && p.available !== false) setReactionDecision(key, "apply");
      if (p.mode === "off") setReactionDecision(key, "skip");
    }
    // A card can be RE-POSTED with GM verdicts already in the bag — ar.gmOverride
    // rides the frozen actionResult through persistence, so an F5 or a restore
    // rebuilds this map from scratch while the bag remembers everything.
    // setReactionDecision deliberately refuses to write over a GM-decided key, so
    // without this pass those keys would hold NO effective entry at all, and
    // snapshotReactionDecisions defaults an absent entry to "skip" — silently
    // dropping a force the GM had already made. Seeding straight from the bag is
    // the same absolute-value rule the rest of the layer follows.
    for (const p of cardReactions) {
      // Same filter as above: seeding straight from the bag must not resurrect a
      // verdict on a candidate that is no longer GM-editable.
      if (!isGmEditableReaction(p)) continue;
      const d = gmReactionDecision(cardAr?.gmOverride ?? null, p.rowKey, p.carrierUuid);
      if (d) reactionDecisionMap.set(`${p.rowKey}:${p.carrierUuid}`, d);
    }

    function snapshotReactionDecisions() {
      const out = [];
      for (const p of cardReactions) {
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
          // Third-party reactor identity — present when the reaction
          // belongs to a non-action-taker (Protect on an Attack(ally)
          // card). RESOLVE-side firing reads these to route the chain
          // to the reactor's actor instead of the action-taker. Null
          // for action-taker-owned reactions (Healing Power etc.).
          reactorActorUuid: p.reactorActorUuid ?? null,
          reactorActorName: p.reactorActorName ?? null,
          // Sticky picked-subject cache. card-mutations.resolveRedirectSubjects
          // stores the player's pick on the in-memory candidate after the
          // first prompt; without round-tripping it here, the CONFIRM-stage
          // re-invocation of applyAcceptedCardMutations against the FROZEN
          // ar would see a fresh candidate and re-prompt the player. Both
          // shapes are passed through: the array form for multi-target
          // redirects (Prophetic Defender), the single-uuid form for
          // backward-compat with Protect's single-target.
          pickedSubjectActorUuid: p.pickedSubjectActorUuid ?? null,
          pickedSubjectActorUuids: Array.isArray(p.pickedSubjectActorUuids) ? [...p.pickedSubjectActorUuids] : null,
          // Menu picks the player made at Apply-click (previewReactionMenu).
          // Round-tripped so firePreAcceptedCandidate replays them at RESOLVE
          // (ctx.menuPicks) instead of re-prompting. Same role as
          // pickedSubjectActorUuids for Protect's target pick.
          chosenMenuPicks: Array.isArray(p.chosenMenuPicks) ? [...p.chosenMenuPicks] : null,
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
    // Visually commit a resolved pill — flips "pending" → "resolved",
    // patches the status chip, decrements the card-level pending count,
    // and broadcasts to mirrors. Split out from recordPillDecision so the
    // "apply" path can await the mutation pipeline (and any picker
    // prompt) BEFORE committing — if the player cancels the picker, the
    // pill stays in its pending state.
    function commitPillDecisionDom(rowKey, carrierUuid, decision) {
      const cardEl = root.querySelector(".fud-bf-card");
      const pillEl = root.querySelector(
        `.fud-bf-reaction-pill[data-fud-reaction-key="${CSS.escape(rowKey)}"][data-fud-reaction-carrier="${CSS.escape(carrierUuid)}"]`
      );
      if (!pillEl) return;
      if (pillEl.dataset.fudReactionPending !== "1") return;
      pillEl.dataset.fudReactionPending = "0";
      pillEl.classList.add("is-resolved", decision === "apply" ? "is-applied" : "is-skipped");
      const actions = pillEl.querySelector(".fud-bf-reaction-actions");
      if (actions) {
        actions.outerHTML = `<span class="fud-bf-reaction-status">${decision === "apply" ? "Applied" : "Skipped"}</span>`;
      }
      // Only third-party (gating) pills move the Confirm-lock counter; the
      // owner's own reactions never gated it, so resolving one leaves it as-is.
      const gates = pillEl.dataset.fudReactionGating === "1";
      const current = Number(cardEl?.dataset?.fudReactionsPending ?? 0);
      const next = gates ? Math.max(0, current - 1) : current;
      if (cardEl) {
        if (next > 0) cardEl.dataset.fudReactionsPending = String(next);
        else delete cardEl.dataset.fudReactionsPending;
      }
      // Broadcast pill state change to every mirror (players + secondary GMs)
      // so all observers see the decision flip in real time.
      try {
        const onlineNonPrimary = (game.users?.contents ?? []).filter((u) => u.active && u.id !== game.user?.id);
        director?.intentChannel?.broadcastMenuOpen({
          targetUserIds: onlineNonPrimary.map((u) => u.id),
          menuSpec: {
            kind: "action-card-pill-update",
            combatId: director.combatId,
            rowKey,
            carrierUuid,
            decision,
            pendingCount: next,
          },
        });
      } catch (e) { warn("commitPillDecisionDom: pill-update broadcast threw", e); }
    }

    // ── Reactive cascade: reaction list updates itself on card-state change ──
    // When a reaction is accepted, a follow-up reaction keyed on
    // `creature_completes_skill` may become eligible (Bullet Break after
    // Crossfire). Re-derive cascade candidates from the ledger of accepted
    // skill-completions and inject any NEW ones as pills in THIS panel. The
    // sequencing/diff/convergence is the pure reaction-derive core; only the
    // DOM append lives here (delegated click handler already covers new pills).
    const cascadeFiredKeys = new Set();   // candidateKeys already injected
    function appendCascadePills(cands) {
      if (!cands?.length) return;
      const card = root.querySelector(".fud-bf-card");
      const h0 = card ? card.offsetHeight : 0;   // height BEFORE the new pill
      let list = root.querySelector(".fud-bf-reactions-list");
      if (!list) {
        // No reaction row existed (no initial pills) — build the whole row.
        const host = card ?? root;
        host.insertAdjacentHTML("beforeend", buildReactionPillRow(cands));
        list = root.querySelector(".fud-bf-reactions-list");
      } else {
        list.insertAdjacentHTML("beforeend", buildReactionPills(cands));
      }
      const pills = list ? Array.from(list.querySelectorAll(".fud-bf-reaction-pill")) : [];
      const fresh = pills.slice(-cands.length);

      // Re-lock Confirm for each freshly-injected ACTIONABLE, THIRD-PARTY (ask)
      // pill. A cascade / targeted-injection pill can appear AFTER the player
      // already cleared the initial pending count (e.g. a redirect/shield brought
      // a new creature in, exposing its "when targeted" reaction) — without
      // bumping the card's data-fud-reactions-pending counter the Confirm button
      // would stay clickable while the new reaction still awaits a decision.
      // Mirrors initialGating (third-party ask pills only — the owner's own
      // cascade reactions never gate); commitPillDecisionDom decrements it.
      const freshPending = fresh.filter(
        (el) => el?.dataset?.fudReactionPending === "1" && el?.dataset?.fudReactionGating === "1"
      ).length;
      if (freshPending > 0 && card) {
        const current = Number(card.dataset.fudReactionsPending ?? 0);
        card.dataset.fudReactionsPending = String(current + freshPending);
      }

      const GROW_MS = 260;   // pill unfolds (its real height drives the reflow)
      const GLOW_MS = 1500;  // settle glow, right after the grow

      // Animate the new pill's own HEIGHT from 0 → natural. Because height is a
      // real layout property, the reaction panel, invoke/bond buttons, the
      // Confirm button AND the (auto-height) card all reflow SMOOTHLY together
      // each frame — no separate box animation with snapping children. opacity
      // fades the content in as it unfolds; glow fires when it settles.
      for (const el of fresh) {
        if (typeof el.animate !== "function") {
          el.classList.add("is-cascade-glow");
          setTimeout(() => el.classList.remove("is-cascade-glow"), GLOW_MS);
          continue;
        }
        const target = el.offsetHeight;            // natural height (incl. min-height)
        const prevOverflow = el.style.overflow;
        el.style.overflow = "hidden";
        // min-height must also animate from 0, else the CSS floor (min-height:34px)
        // pins the box and the unfold can't start collapsed.
        const anim = el.animate(
          [
            { height: "0px", minHeight: "0px", opacity: 0 },
            { height: `${target}px`, minHeight: `${target}px`, opacity: 1 },
          ],
          { duration: GROW_MS, easing: "cubic-bezier(.2,.7,.2,1)" },
        );
        const done = () => {
          el.style.overflow = prevOverflow;
          el.classList.add("is-cascade-glow");
          setTimeout(() => el.classList.remove("is-cascade-glow"), GLOW_MS);
        };
        anim.onfinish = done;
        anim.oncancel = done;
      }
    }
    async function injectCascadeReactions() {
      try {
        const rd = await import("./reaction-derive.js?cb=" + Date.now());
        const se = await import("./skill-effects.js?cb=" + Date.now());
        // Ledger = accepted candidates that represent a completed skill.
        const ledger = [];
        for (const p of cardReactions) {
          if (reactionDecisionMap.get(`${p.rowKey}:${p.carrierUuid}`) !== "apply") continue;
          ledger.push({
            reactorActorUuid: p.reactorActorUuid ?? payload?.attackerActor?.uuid ?? null,
            reactorTokenUuid: p.reactorTokenUuid ?? null,
            skillName: p.carrierName,
          });
        }
        if (!ledger.length) return;
        const cardCtx = {
          attackerActorUuid: payload?.attackerActor?.uuid ?? payload?.attackerActorUuid ?? null,
          attackerTokenUuid: payload?.attacker?.tokenUuid ?? payload?.attackerTokenUuid ?? null,
          checkTotal: payload?.roll?.total ?? payload?.checkTotal ?? null,
          weaponRange: payload?.weaponRange ?? payload?.weapon?.range ?? null,
          actionKind: kind,
        };
        const derived = await rd.deriveCascadeCandidates({
          ledger, cardCtx, firedKeys: cascadeFiredKeys,
          deps: {
            findPassiveCandidates: se.findPassiveCandidates,
            resolveActorByUuid: (u) => fromUuid(u).catch(() => null),
          },
        });
        const { added } = rd.diffCandidates(cardReactions, derived);
        if (!added.length) return;
        const cascadeAttackerUuid = payload?.attackerActor?.uuid ?? payload?.attackerActorUuid ?? null;
        for (const c of added) {
          const reactor = c.reactorActorUuid ? await fromUuid(c.reactorActorUuid).catch(() => null) : null;
          c.reactorActorName = reactor?.name ?? "Reactor";
          c.reactorIsPlayer = !!reactor?.hasPlayerOwner;
          // Per-pill owner (see initial enrichment) — reactor if known, else
          // the action-taker for self-cascades (Bullet Break after Crossfire).
          c.reactorOwnerUserId = reactor
            ? ownerUserIdForActor(reactor)
            : await resolveCardOwnerUserId(cascadeAttackerUuid);
          cascadeFiredKeys.add(rd.candidateKey(c));
          // Marks this pill as DERIVED — it exists only because some other
          // reaction was applied. A GM rolling any reaction back has to be able
          // to retract it; see reconcileGmReactions.
          c._cascadeInjected = true;
          cardReactions.push(c);
        }
        appendCascadePills(added);
        log(`injectCascadeReactions: +${added.length} cascade reaction(s) [${added.map((c) => c.carrierName).join(", ")}]`);
      } catch (e) {
        warn("injectCascadeReactions threw", e);
      }
    }

    // ── Re-scan "when targeted" reactions for creatures newly targeted by a
    // mid-card mutation (redirect destination, add_target splash). Without this,
    // a creature dragged into the action's target set never gets to use its own
    // creature_targeted_by_action reactions (they were scanned at CONFIRM against
    // the ORIGINAL targets). Models injectCascadeReactions; shares cascadeFiredKeys
    // + diffCandidates so a reaction (rowKey:carrier:reactor) is offered at most
    // once — NO REUSE — which also makes any redirect→react→redirect chain
    // self-terminate.
    // `recomputedRows` = the POST-mutation per-target results. Needed so each new
    // subject carries its own predicted `incomingDamage` (INCOMING_DAMAGE) — a
    // redirect destination's damage only exists after the mutation recomputes, so
    // it cannot come from the CONFIRM-time snapshot.
    async function injectTargetedReactionsForNewTargets(mutTargets, originalRows, recomputedRows) {
      try {
        const rd = await import("./reaction-derive.js?cb=" + Date.now());
        const se = await import("./skill-effects.js?cb=" + Date.now());
        const origActorUuids = new Set((originalRows ?? []).map((r) => r?.actorUuid).filter(Boolean));
        // Predicted damage per subject, keyed by token then actor — same shape
        // and same miss/heal-means-zero rule as the CONFIRM scan, so a beneficial
        // or missed action leaves INCOMING_DAMAGE at 0 and a "when you take
        // damage" reaction stays dormant instead of burning its charge.
        const rows = Array.isArray(recomputedRows) ? recomputedRows : [];
        const damageFor = (t) => {
          const row = rows.find((r) => (t?.tokenUuid && r?.tokenUuid === t.tokenUuid))
            ?? rows.find((r) => r?.actorUuid === t?.actorUuid);
          return row?.hit ? Math.max(0, Number(row.damage ?? 0) || 0) : 0;
        };
        // New subjects = entries a mutation brought in: a redirected slot (carries
        // redirectedFrom), an add_target splash (addedVia), or an actorUuid absent
        // from the pre-mutation rows.
        const newSubjects = (mutTargets ?? [])
          .filter((t) => t && (t.redirectedFrom || t.addedVia || !origActorUuids.has(t.actorUuid)))
          .map((t) => ({ actorUuid: t.actorUuid, tokenUuid: t.tokenUuid, incomingDamage: damageFor(t) }));
        if (!newSubjects.length) return;

        const attackerActorUuid = payload?.attackerActor?.uuid ?? payload?.attackerActorUuid ?? null;
        const combatants = Array.isArray(director?.dCombat?.combatants) ? director.dCombat.combatants : [];
        const reactorActors = [];
        for (const c of combatants) {
          if (c?.defeated) continue;
          const actor = c?.actorDoc ?? null;
          if (!actor || actor.uuid === attackerActorUuid) continue;
          reactorActors.push(actor);
        }
        if (!reactorActors.length) return;

        const cardCtx = {
          attackerActorUuid,
          attackerTokenUuid: payload?.attacker?.tokenUuid ?? payload?.attackerTokenUuid ?? null,
          actionIntent: payload?.actionIntent ?? (kind === "Attack" ? "harmful" : null),
          actionKind: kind,
          actionName: payload?.skillName ?? payload?.weapon?.name ?? kind,
          // No `?? kind` fallback — see buildTargetedPayload.
          sourceSkillName: payload?.skillName ?? payload?.weapon?.name ?? null,
          checkTotal: payload?.roll?.total ?? payload?.checkTotal ?? null,
          isCrit: !!payload?.roll?.isCrit,
          isFumble: !!payload?.roll?.isFumble,
          weaponRange: payload?.weaponRange ?? payload?.weapon?.range ?? null,
          weaponType: payload?.weapon?.weaponType ?? null,
          damageType: payload?.damage?.element ?? payload?.damageType ?? null,
          targetTokenUuids: (mutTargets ?? []).map((t) => t?.tokenUuid).filter(Boolean),
          // Which Defense this action's Check resolves against — SAME derivation
          // as the CONFIRM scan (explicit defense_target_type wins, else Spell →
          // MDEF), gated on canMiss so a no-Check action reads null. Feeds
          // ATTACK_VS_DEF / ATTACK_VS_MDEF for the newly-targeted creature.
          defenseResolved: payload?.canMiss
            ? (resolvesVsMagicDefense({
                defenseTargetType: payload?.defenseTargetType,
                isSpell: String(payload?.skillType ?? "").toLowerCase() === "spell",
              }) ? "mdef" : "def")
            : null,
        };

        const derived = await rd.deriveTargetedCandidates({
          newSubjects, reactorActors, cardCtx, firedKeys: cascadeFiredKeys,
          deps: { findPassiveCandidates: se.findPassiveCandidates },
        });
        const { added } = rd.diffCandidates(cardReactions, derived);
        if (!added.length) return;
        for (const c of added) {
          // Per-pill owner (see initial enrichment) — these are reactions of
          // newly-targeted creatures, so they gate on the reactor's owner.
          try {
            c.reactorOwnerUserId = await resolveCardOwnerUserId(c.reactorActorUuid ?? attackerActorUuid);
          } catch { c.reactorOwnerUserId = null; }
          cascadeFiredKeys.add(rd.candidateKey(c));
          // Marks this pill as DERIVED — it exists only because some other
          // reaction was applied. A GM rolling any reaction back has to be able
          // to retract it; see reconcileGmReactions.
          c._cascadeInjected = true;
          cardReactions.push(c);
        }
        appendCascadePills(added);
        log(`injectTargetedReactionsForNewTargets: +${added.length} reaction(s) for ${newSubjects.length} newly-targeted creature(s)`);
      } catch (e) {
        warn("injectTargetedReactionsForNewTargets threw", e);
      }
    }

    async function recordPillDecision(rowKey, carrierUuid, decision, routeUserId = null) {
      const pillEl = root.querySelector(
        `.fud-bf-reaction-pill[data-fud-reaction-key="${CSS.escape(rowKey)}"][data-fud-reaction-carrier="${CSS.escape(carrierUuid)}"]`
      );
      if (!pillEl) return;
      if (pillEl.dataset.fudReactionPending !== "1") return;

      // Remote-prompt routing — when a PLAYER applied this reaction (routeUserId
      // is their non-GM userId), any secondary picker (Protect target, Barrage
      // add-target, option-menu) renders on THEIR client instead of the GM's,
      // and nothing commits until they confirm. The GM clicking their own card
      // passes no routeUserId → local picks, card stays as-is. See remote-pick.js.
      const remotePrompt = (routeUserId
        && routeUserId !== game.user?.id
        && !game.users?.get(routeUserId)?.isGM)
        ? { channel: director.intentChannel, targetUserId: routeUserId, combatId: director.combatId }
        : null;
      // Player applied but their pill is mid-flight ("submitting" — pending=0,
      // buttons dimmed): if the secondary pick is cancelled, tell THEIR client
      // to restore the actionable pill (revert). No-op for GM-local picks.
      const revertRemotePill = () => {
        if (!remotePrompt) return;
        try {
          director.intentChannel?.broadcastMenuOpen({
            targetUserId: routeUserId,
            menuSpec: {
              kind: "action-card-pill-update",
              combatId: director.combatId,
              rowKey, carrierUuid,
              decision: "revert",
            },
          });
        } catch (e) { warn("recordPillDecision: revert broadcast threw", e); }
      };

      // Provisional set so recompute / card-mutations see the decision.
      // If "apply" needs a picker and the player cancels, we rewind this
      // before committing the DOM so the pill stays in pending state.
      setReactionDecision(`${rowKey}:${carrierUuid}`, decision);

      // Barrage (creature_performs_action, tagged `_addTarget`): the pill's
      // Apply runs the reaction's add_target chain (JRPG picker + MP cost) via
      // the CONFIRM onAddTargetApply callback, which splices the picked
      // target(s) into THIS action sharing the already-rolled accuracy total
      // ("shared roll, post-roll pick") and returns their result rows. The rows
      // are appended to the result list. A cancelled / empty / unaffordable
      // pick leaves the pill actionable (cost-last-in-chain → nothing spent).
      const addTargetCand = (cardReactions ?? []).find(
        (p) => String(p.rowKey) === String(rowKey)
          && String(p.carrierUuid) === String(carrierUuid)
          && p._addTarget
      );
      if (addTargetCand) {
        if (decision === "apply") {
          if (typeof payload.onAddTargetApply !== "function") {
            clearReactionDecision(`${rowKey}:${carrierUuid}`);
            return;
          }
          // The card auto-hides while the LOCAL targeting picker is up via the
          // picker-overlay hooks (onPickerOpen/onPickerClose). When routed to a
          // player, the picker is on THEIR screen and fires the hooks there, so
          // the GM card correctly stays visible.
          let res = null;
          try { res = await payload.onAddTargetApply(addTargetCand, remotePrompt); }
          catch (e) { warn("recordPillDecision: onAddTargetApply threw", e); }
          if (!res?.ok) {
            clearReactionDecision(`${rowKey}:${carrierUuid}`);
            revertRemotePill();
            log(`recordPillDecision: add_target apply ${res?.cancelled ? "cancelled" : "failed"} for ${rowKey}:${carrierUuid} — pill stays pending`);
            return;
          }
          if (Array.isArray(res.replaceRows)) {
            // Potion Rain heal-spread: the WHOLE result changed (headline restore
            // halved + per-target rows added/halved). Update the payload from the
            // single source the handler returned, then RE-RENDER the card body
            // from it — no per-panel patching, so the RESTORE headline and the
            // Result rows can't drift apart.
            log(`recordPillDecision: heal-spread replaceRows=${res.replaceRows.length} row(s) for ${rowKey}:${carrierUuid}`);
            payload.perTargetResults = res.replaceRows;
            if (res.damage !== undefined) payload.damage = res.damage;
            if (res.hasHealing !== undefined) payload.hasHealing = res.hasHealing;
            if (Array.isArray(res.targets)) payload.targets = res.targets;
            const newBody = rerenderActionCardBody(root, kind, payload);
            if (newBody) {
              // The body swap drops anything added to the body DOM after spawn
              // that ISN'T in payload — namely the reaction Effects panel + the
              // damage-nullify strike (added by OTHER accepted reactions). Rebuild
              // them from the accepted decisions (idempotent) so the re-render
              // preserves them instead of wiping them.
              try { applyReactionEffectPreview(); } catch (e) { warn("recordPillDecision: heal-spread effect preview threw", e); }
              // Mirror the FINAL body (incl. restored decorations) to player
              // clients so observers see the spread heal too (read-only).
              //
              // ⚠ This is the LAST remaining `action-card-body-update` emit. The
              // recompute path (recomputeTargetPreviews) now ships a structured
              // delta instead, but heal-spread is a different shape: it does not
              // patch surfaces, it REBUILDS the whole body from a mutated payload
              // (headline restore halved + rows added/halved together), so there
              // is no delta to express — the payload IS the card. It also fires
              // once per add-target apply on one skill family (Potion Rain),
              // not once per reaction on every damage action, so it is not on
              // the hot path the delta work targeted. Retiring it would mean
              // shipping `payload` + `kind` and having the mirror re-run
              // rerenderActionCardBody itself.
              const bodyEl = root.querySelector(".fud-bf-body");
              const finalBody = bodyEl ? bodyEl.innerHTML : newBody;
              try {
                const onlineNonPrimary = (game.users?.contents ?? []).filter((u) => u.active && u.id !== game.user?.id);
                director?.intentChannel?.broadcastMenuOpen({
                  targetUserIds: onlineNonPrimary.map((u) => u.id),
                  menuSpec: {
                    kind: "action-card-body-update",
                    combatId: director.combatId,
                    bodyHtml: finalBody,
                  },
                });
              } catch (e) { warn("recordPillDecision: body-update broadcast threw", e); }
            }
          } else {
            for (const r of (res.addedRows ?? [])) appendTargetRow(root, r, kind, payload);
          }
        }
        // skip → no row added; just commit the decision.
        commitPillDecisionDom(rowKey, carrierUuid, decision);
        return;
      }

      if (decision === "apply") {
        // Resolve any option-menu in this reaction's chain NOW (at Apply-click)
        // rather than at RESOLVE — Warning Shot's "choose a status", Hawkeye's
        // "aim vs free attack". The picks are cached on the candidate and
        // replayed at RESOLVE so nothing double-prompts; the chosen effects feed
        // the card's Effect panel below. Cancelling the menu rewinds the pill.
        const cand = (cardReactions ?? []).find(
          (p) => String(p.rowKey) === String(rowKey) && String(p.carrierUuid) === String(carrierUuid)
        );
        if (cand) {
          try {
            const se = await import("./skill-effects.js?cb=" + Date.now());
            const reactorActor = cand.reactorActorUuid
              ? await fromUuid(cand.reactorActorUuid).catch(() => null)
              : (payload?.attackerActor ?? null);
            if (reactorActor) {
              // The card auto-hides while the option-menu is up via the
              // picker-overlay hooks — only when a menu actually renders (a
              // no-menu reaction shows nothing, so the card no longer flashes).
              const menuRes = await se.previewReactionMenu({
                casterActor: reactorActor,
                candidate: cand,
                payload: cand.payloadAtFire ?? null,
                dCombat: director?.dCombat ?? null,
                remotePrompt,
              });
              if (menuRes?.cancelled) {
                clearReactionDecision(`${rowKey}:${carrierUuid}`);
                revertRemotePill();
                log(`recordPillDecision: ${rowKey}:${carrierUuid} menu cancelled — pill stays pending`);
                return;
              }
              cand.chosenMenuPicks = Array.isArray(menuRes?.picks) ? menuRes.picks : [];
              cand.previewEffects = Array.isArray(menuRes?.effects) ? menuRes.effects : [];
              cand.previewDamageNullified = !!menuRes?.damageNullified;
            }
          } catch (e) {
            warn(`recordPillDecision: previewReactionMenu threw for ${rowKey}:${carrierUuid}`, e);
          }
        }

        // Run the mutation pipeline (zeroes damage via adjust_damage, applies
        // redirects/accuracy overrides). If the chain needs a target picker
        // (Protect on a multi-ally attack) the action card is hidden while the
        // picker is open and revealed again on confirm/cancel. Cancellation
        // rewinds the decision so the pill is still actionable.
        let cancelled = false;
        try {
          const r = await recomputeTargetPreviews(remotePrompt);
          cancelled = !!r?.cancelled;
        } catch (e) {
          warn(`recordPillDecision: recompute threw for ${rowKey}:${carrierUuid}`, e);
        }
        if (cancelled) {
          clearReactionDecision(`${rowKey}:${carrierUuid}`);
          if (cand) { cand.chosenMenuPicks = null; cand.previewEffects = null; cand.previewDamageNullified = false; }
          revertRemotePill();
          log(`recordPillDecision: ${rowKey}:${carrierUuid} apply cancelled — pill stays pending`);
          return;
        }

        // Render the reaction's outcome on the card: strike the Damage panel if
        // the reaction zeroes damage + show an Effect panel of the chosen
        // statuses/costs. (Per-target rows are already flipped by recompute.)
        try { applyReactionEffectPreview(); } catch (e) { warn("recordPillDecision: effect preview render threw", e); }
      } else {
        // skip — clear any cached apply-click menu picks for this candidate,
        // re-run recompute (restores damage), and re-render the Effect panel
        // (drops chips for the now-skipped reaction).
        const cand = (cardReactions ?? []).find(
          (p) => String(p.rowKey) === String(rowKey) && String(p.carrierUuid) === String(carrierUuid)
        );
        if (cand) { cand.chosenMenuPicks = null; cand.previewEffects = null; cand.previewDamageNullified = false; }
        try { await recomputeTargetPreviews().catch(() => {}); } catch {}
        try { applyReactionEffectPreview(); } catch (e) { warn("recordPillDecision: effect preview render threw", e); }
      }

      commitPillDecisionDom(rowKey, carrierUuid, decision);

      // Reactive cascade: an accepted reaction may make a follow-up eligible
      // (Bullet Break after Crossfire). Re-derive + inject new pills into THIS
      // panel. Convergence-guarded, so re-running on every decision is safe.
      if (decision === "apply") { try { await injectCascadeReactions(); } catch (e) { warn("recordPillDecision: cascade inject threw", e); } }
    }

    // Render (or clear) the reaction Effect-preview surface on the card from the
    // currently-accepted candidates' apply-click previews:
    //   • strike the Damage panel when an accepted reaction zeroes outgoing
    //     damage ("deal no damage" — Warning Shot);
    //   • show an Effect panel listing the chosen statuses / resource costs.
    // Aggregates over every accepted candidate so toggling one pill in/out keeps
    // the panel consistent. Idempotent — fully rebuilt each call.
    // Which accepted reactions contribute preview chips / the damage strike.
    // Split from the RENDER half (module-level renderReactionEffectPreview) so
    // the same resolved data can ride the card delta out to player mirrors —
    // it used to reach them only baked inside the `.fud-bf-body` innerHTML dump.
    function computeReactionEffectPreviewData() {
      const effects = [];
      let damageNullified = false;
      for (const p of cardReactions ?? []) {
        if (reactionDecisionMap.get(`${p.rowKey}:${p.carrierUuid}`) !== "apply") continue;
        if (p.previewDamageNullified) damageNullified = true;
        for (const e of (Array.isArray(p.previewEffects) ? p.previewEffects : [])) {
          effects.push({ ...e, via: p.carrierName ?? "Reaction" });
        }
      }
      return { effects, damageNullified };
    }

    function applyReactionEffectPreview() {
      const card = root.querySelector(".fud-bf-card");
      if (!card) return;
      renderReactionEffectPreview(card, computeReactionEffectPreviewData());
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
    // The last recompute's TARGET SET + rows. The action's own perTargetResults
    // are frozen at COMPUTE and an edit only ever rewrites `gmOverride`, so a
    // GM-ADDED creature never reaches them — it could never become an editable
    // row, only a bare name with a Remove button. Kept here (not on the ar) so
    // it stays display state: the bag is still the only thing Save writes.
    let lastTargetSurface = null;
    async function recomputeTargetPreviews(remotePrompt = null) {
      // Run recompute when the card has a target list (Attack OR damage-
      // dealing Skill). Non-damage Skills (Soul Steal, Torpor, etc.)
      // shouldn't have their SUCCESS/FAILED labels overwritten — but
      // the card-mutation engine (redirect_target etc.) still applies
      // to their target rows. The result-span patching is gated below
      // on `hasDamageRows`.
      const hasDamageRows = !!payload?.hasDamage || kind === "Attack";
      const hasTargetRows = Array.isArray(payload?.perTargetResults) && payload.perTargetResults.length > 0;
      // Run whenever the card has TARGETS — not only when it has damage ROWS. A
      // no-damage Skill (Torment, Dreadwyrm) has EMPTY perTargetResults but still
      // renders target portraits/rows from ar.targets, and a redirect/add_target
      // mutation must update them. Gating on perTargetResults silently skipped the
      // recompute for those, so a redirect never reflected on the card even though
      // the mechanic applied. (Result-span patching stays gated on hasDamageRows.)
      const liveTargets = director?.ctx?.actionResult?.targets;
      const hasTargets = (Array.isArray(liveTargets) && liveTargets.length > 0)
        || (Array.isArray(payload?.targets) && payload.targets.length > 0);
      if (!hasTargetRows && !hasTargets) return { cancelled: false };
      if (_previewInFlight) { try { await _previewInFlight; } catch {} }
      _previewInFlight = (async () => {
        try {
          const accepted = [];
          for (const p of cardReactions) {
            const k = `${p.rowKey}:${p.carrierUuid}`;
            if (reactionDecisionMap.get(k) === "apply") accepted.push(p);
          }
          // Lazy-import — cross-module cache-bust pattern. card-mutations owns the
          // target-set mutation + recompute (applyTargetSetMutation); skill-effects
          // is still needed for applyDamageOp in the headline breakdown below.
          const sk = await import("./skill-effects.js?cb=" + Date.now());
          const cm = await import("./card-mutations.js?cb=" + Date.now());

          // Phase 1: card-mutations (redirect_target). Computes the
          // post-mutation target list against a synthetic ar built from
          // the card's payload. Returns new arrays; the original payload
          // stays immutable so the recompute is idempotent across
          // multiple toggle cycles. `kind` + `skillType` flow through
          // so the mutation engine picks the right defense (DEF for
          // Attack, MDEF for Spell-kind Skills) when recomputing the
          // redirected target's hit/damage.
          //
          // Use the live actionResult as the base when available — invoke
          // updates director.ctx.actionResult but not payload, so without
          // this, any pill Skip/Apply after an invoke would recompute from
          // stale pre-invoke dice and overwrite the accuracy display.
          // skillType + defenseTargetType are FSM-set constants and never
          // invoke-modified, so they always come from payload.
          const liveAr = director?.ctx?.actionResult ?? null;
          const base   = liveAr ?? payload;
          const arSnapshot = {
            kind,
            // Carry the stable action-instance id so a non-deterministic mutation
            // (check_reroll) memoizes the SAME rolled result here (preview) as at
            // the CONFIRM commit — keyed off this id. Without it the preview would
            // key on "" and roll different dice than the commit.
            _instanceId: base?._instanceId ?? null,
            targets: Array.isArray(base?.targets) ? base.targets : [],
            perTargetResults: Array.isArray(base?.perTargetResults) ? base.perTargetResults : [],
            roll: base?.roll ?? null,
            damage: base?.damage ?? null,
            // damageType is what describePrimary's Skill/Spell path reads to
            // classify the action as damage (Attack reads the weapon snapshot
            // instead). Omitting it made every Skill recompute fall to mode
            // "none" → no damage profile → reaction damage ops (element override
            // + bonus, e.g. Thermokinesis fire/ice) silently dropped on Skills
            // while Attacks worked. Carry it (+ skillName for breakdown labels).
            damageType: base?.damageType ?? null,
            skillName: base?.skillName ?? null,
            skillType: payload?.skillType ?? null,
            defenseTargetType: payload?.defenseTargetType ?? null,
            // Printed/base cost (resolved numeric map) so a live adjust_cost reaction
            // can show the EFFECTIVE cost on the card before Confirm.
            costSerialized: base?.costSerialized ?? null,
            // Check + damage descriptor fields that the Skill/Spell recompute
            // reads off the ar (describePrimary → ar.damageBonus; computeCheck →
            // ar.isCheck/checkBonus/rolledA1/rolledA2). Omitting them made an
            // OFFENSIVE SPELL recompute (e.g. Glacies + a force card reaction like
            // Magical Artillery) lose `check.required` — so effectiveHr fell to 0
            // AND the +N damage bonus dropped — collapsing the row to damage 0,
            // which renders "NO EFFECT" despite the hit. The Attack path reads
            // these from the weapon snapshot, so this only bit Skills/Spells.
            isCheck: base?.isCheck ?? null,
            hasDamage: base?.hasDamage ?? null,
            damageBonus: base?.damageBonus ?? null,
            checkBonus: base?.checkBonus ?? null,
            rolledA1: base?.rolledA1 ?? null,
            rolledA2: base?.rolledA2 ?? null,
            // Context the card-mutation layer needs to RE-DERIVE a redirected /
            // added target through buildPerTarget (computeActionProfile) — the
            // single per-target derivation. Without these the re-derive falls
            // back to the legacy clone, so the card would drift from RESOLVE
            // (which always has the full ar). Pull from the live actionResult.
            skillUuid: base?.skillUuid ?? null,
            attacker: base?.attacker ?? null,
            attackerActorRef: base?.attackerActorRef ?? null,
            weapon: base?.weapon ?? null,
            attackMode: base?.attackMode ?? null,
            // Free-action grant (check + damage bonus) so recomputeActionProfile
            // can re-fold it into the rebuilt per-target rows — else a granted
            // attack's per-target preview reverts to the un-granted base (e.g.
            // Blazing Sweep's -50% repeat shows full damage per target while the
            // header + the committed damage stay correct). Null for normal cards.
            freeActionGrant: base?.freeActionGrant ?? null,
            // Manual GM overrides (gm-card-override.js). This projection is an
            // EXPLICIT field list — a bag left unnamed here is dropped, and the
            // preview would silently re-derive without the GM's edits while the
            // commit (which reads the full live ar) kept them. That split is
            // exactly the drift this snapshot exists to prevent.
            gmOverride: base?.gmOverride ?? null,
            round: base?.round ?? director?.dCombat?.round ?? 0,
          };

          // SINGLE target-set mutation entrypoint — redirect/accuracy/add_target
          // rewrite the slots, will_deal_damage subjects re-resolve vs the mutated
          // set, then ALL per-target rows re-derive through buildPerTarget with the
          // accepted reactions folded in (accuracy override re-applied). Shared with
          // the CONFIRM recompute so the preview + commit CANNOT drift. `_cb` keeps
          // its internal imports on this file's cross-module cache-bust pattern.
          // When the pick is routed to a player (remotePrompt), the picker is
          // on THEIR screen — keep the GM card visible. Hide only for local picks.
          // Card visibility is driven by the picker-overlay hooks
          // (onPickerOpen/onPickerClose) — the card hides ONLY while a redirect
          // target-picker is actually on-screen. A pickerless recompute (the
          // common case) therefore no longer fades the card out-and-back-in.
          const mutationResult = await cm.applyTargetSetMutation({
            ar: arSnapshot,
            accepted,
            attackerActor: payload.attackerActor,
            round: director?.dCombat?.round ?? 0,
            _cb: Date.now(),
            remotePrompt,
          });
          if (mutationResult?.cancelled) {
            // Caller (recordPillDecision) reads `cancelled` to rewind
            // the provisional pill decision. Stop the recompute here —
            // don't apply partial mutation visuals or broadcast.
            return { cancelled: true };
          }
          // Per-target rows: the rebuild when present (damage actions), else the
          // mutated rows (pure no-damage skill — keeps the redirect markers for
          // the loop below).
          const recomputed = Array.isArray(mutationResult.perTargetResults)
            ? mutationResult.perTargetResults : [];
          // Publish the post-mutation membership for the GM editor (host) and,
          // via the delta below, for a support GM's mirror.
          lastTargetSurface = projectTargetSurfaceForEditor(mutationResult.targets, recomputed);

          // Build a `delta` describing per-slot mutations + non-mutation
          // damage updates. Shared between GM (patch local DOM + broadcast
          // to mirrors) and player (patch the mirror wrapper). Single
          // patching function so GM and player can't diverge on layout.
          // Build redirect deltas from the (mutated) TARGETS array — every
          // swapped slot carries `redirectedFrom` there regardless of whether
          // the action deals damage. A no-damage skill (Torment) has no/empty
          // perTargetResults, so a perTargetResults-only loop would never patch
          // the card even though the target genuinely changed. Per-target damage
          // details (affinity/hit/crit/damage) come from recomputed[i] WHEN
          // present; for no-damage skills those are simply absent (the result-
          // label re-derive is gated on hasDamageRows downstream anyway).
          const original = Array.isArray(arSnapshot.perTargetResults) ? arSnapshot.perTargetResults : [];
          const mutTargets = Array.isArray(mutationResult.targets) ? mutationResult.targets : [];
          // Defense kind for the redrawn rows — mirrors buildPerTarget's selector
          // (Attacks always vs DEF; Skills/Spells vs MDEF when Spell-kind or
          // defense_target_type='mdef'). Drives both the recomputed value pick
          // below and the DEF/MDEF label in applyCardTargetMutationDelta.
          const redirectVsMDef =
            String(arSnapshot.kind ?? "").toLowerCase() !== "attack" &&
            (String(arSnapshot.skillType ?? "").toLowerCase() === "spell" ||
             String(arSnapshot.defenseTargetType ?? "").toLowerCase() === "mdef");
          const redirects = [];
          for (let i = 0; i < mutTargets.length; i++) {
            const t = mutTargets[i];
            const rf = t?.redirectedFrom;
            if (!rf?.actorUuid) continue;
            const entry = recomputed[i] ?? {};
            redirects.push({
              origUuid: rf.actorUuid,
              newName: t.name ?? entry.name,
              newImg: t.tokenImg ?? entry.tokenImg,
              // Prefer the recomputed buildPerTarget value (`entry.defense` is the
              // action-correct DEF *or* MDEF for this target). `t.defense` is the
              // raw snapshot's physical DEF only — a magic action redirected onto
              // the protector must NOT fall back to it (would show physical DEF).
              newDefense: entry.defense ?? t.defense,
              newAffinity: entry.affinity,
              newHit: !!entry.hit,
              newCrit: !!entry.crit,
              newDamage: entry.damage,
              fromName: rf.name,
              via: rf.via,
            });
          }
          // Per-target HEAL/RESTORE boosts (Cognitive Focus's adjust_grant) —
          // surfaced on the delta so the SHARED applyCardTargetMutationDelta
          // repaints the heal chips + headline for BOTH the GM card and the
          // broadcast player mirror (the redirect loop only touches redirected
          // slots; a pure heal has none, and the damage loop skips grant rows).
          // Serializable plain data only (broadcast is structured-clone-safe).
          const grantRows = [];
          let grantHeadline = null;
          for (let i = 0; i < recomputed.length; i++) {
            const entry = recomputed[i], orig = original[i];
            if (!entry || typeof entry.grantAmount !== "number") continue;
            grantRows.push({
              tokenUuid: entry.tokenUuid ?? orig?.tokenUuid ?? null,
              actorUuid: entry.actorUuid ?? orig?.actorUuid ?? null,
              grantAmount: entry.grantAmount, grantResource: entry.grantResource,
              resourceCur: entry.resourceCur, resourceMax: entry.resourceMax,
              vismagusSuppressed: !!entry.vismagusSuppressed,
              studied: entry.studied, hit: entry.hit, crit: entry.crit,
            });
            // First boosted target drives the headline (common single-target heal).
            if (grantHeadline == null && typeof orig?.grantAmount === "number" && entry.grantAmount !== orig.grantAmount) {
              grantHeadline = entry.grantAmount;
            }
          }
          // Defense override rows (adjust_defense / Verónica): the recompute bumped
          // a target's OWN DEF and re-derived its hit. Surface them so the shared
          // applyCardTargetMutationDelta repaints the DEF number + hover + verdict —
          // the redirect loop only touches redirected slots, and a self +DEF has none.
          const defenseOverrideRows = [];
          for (const entry of (recomputed ?? [])) {
            if (!entry?.defenseOverride) continue;
            defenseOverrideRows.push({
              tokenUuid: entry.tokenUuid ?? null,
              actorUuid: entry.actorUuid ?? null,
              defense: entry.defense,
              from: entry.defenseOverride.from,
              to: entry.defenseOverride.to,
              via: entry.defenseOverride.via,
              hit: !!entry.hit, crit: !!entry.crit, damage: entry.damage,
              affinity: entry.affinity ?? null,
            });
          }
          // Cost adjustment (adjust_cost reaction: Hypercognition discount /
          // Cataclysm overcharge / Barrage's extra-target surcharge) — recompute the
          // EFFECTIVE cost from base + composed override so the card's cost bullet
          // reflects what RESOLVE will actually debit (previously the card kept the
          // printed base cost). Null when no cost override this pass → the patcher
          // reverts the bullet. NOT gated on costSerialized: a surcharge can seed a
          // cost on an action that natively charges nothing (Barrage on a plain
          // Attack), and that MP is exactly what the bullet must start showing.
          let costDelta = null;
          if (mutationResult.costOverride) {
            const eff = computeEffectiveCost(arSnapshot.costSerialized, mutationResult.costOverride);
            const parts = Array.isArray(mutationResult.costOverride._parts)
              ? mutationResult.costOverride._parts : [];
            costDelta = { effectiveText: formatCardCost(eff), parts };
          }
          const delta = {
            redirects,
            defenseOverrides: defenseOverrideRows,
            // Manual GM edits (gm-card-override.js) — repainted by the SAME
            // shared patcher as every other mutation, so the host card and every
            // mirrored client render an edit through one code path.
            gmOverrides: mutationResult.gmOverrideRows ?? [],
            gmEditors: describeGmEditors(arSnapshot.gmOverride),
            // Drives the launch button's active state + tooltip on every client,
            // so a GM can tell at a glance that this card carries manual edits —
            // including edits the OTHER GM made.
            gmEditSummary: summarizeGmOverride(arSnapshot.gmOverride),
            gmEditCount: gmEditCount(arSnapshot.gmOverride),
            // The BAG ITSELF, plus the live candidate rows, so a support GM's
            // editor opens on the host's CURRENT state.
            //
            // Without these it only ever saw the bag frozen into the original
            // card broadcast — an empty one — while its Save sends a wholesale
            // `replace`. A support GM nudging damage therefore SILENTLY WIPED
            // every verdict the host had made: reactions, roll, per-target, all
            // of it, with no conflict signal. Cascade-injected candidates were
            // missing from their form for the same reason, so those keys were
            // dropped too.
            gmOverrideBag: normalizeGmOverride(arSnapshot.gmOverride),
            gmEditReactions: gmEditReactionRows(cardReactions,
              (c) => reactionDecisionMap.get(`${c.rowKey}:${c.carrierUuid}`)),
            // The POST-mutation target membership. Same reason as the bag above:
            // a support GM's editor is built from the card-post payload, which
            // carries the PRE-edit rows, so a creature the host added was a name
            // with no fields on their screen — and Save replaces the target sets
            // wholesale from the rows it can see.
            gmTargetSurface: lastTargetSurface,
            // Reaction candidates a GM TARGET REMOVAL has made moot — see
            // dropGmRemovedReactions. They will not fire and will not bill, so
            // the pill must stop saying "Applied": the player clicked Apply, the
            // GM removed them, and without this the card goes on claiming their
            // reaction is in force on the host and every mirror while nothing
            // runs. The pill is the table's ONLY readout of reaction state.
            //
            // The CURRENT dropped set every pass, not an accumulating one, so
            // restoring the target un-marks the pill by the same code path.
            gmDroppedReactions: (mutationResult.gmDroppedReactions ?? []).map((c) => ({
              rowKey: c?.rowKey ?? null,
              carrierUuid: c?.carrierUuid ?? null,
              carrierName: c?.carrierName ?? null,
            })),
            // Which PANELS carry a hand-set value, so the accuracy and damage
            // fieldsets can be railed like an edited target row.
            gmRollEdited: !!normalizeGmOverride(arSnapshot.gmOverride).roll,
            gmDamageEdited: !!normalizeGmOverride(arSnapshot.gmOverride).damage,
            // Effective-cost repaint (adjust_cost) — null reverts the bullet to base.
            cost: costDelta,
            hasDamageRows,
            // DEF vs MDEF for the redrawn redirect rows (broadcast to player
            // mirrors too — both sides share applyCardTargetMutationDelta).
            vsMDef: redirectVsMDef,
            rollTotal: arSnapshot.roll?.total ?? null,
            element: arSnapshot.damage?.element ?? null,
            accuracyOverride: mutationResult.accuracyOverride ?? null,
            // Itemized accuracy roll — computed once in applyTargetSetMutation
            // (shared mutation entry) so every recompute path stays consistent.
            accuracyRoll: mutationResult.accuracyRoll ?? null,
            accuracyIsSpellish: !!mutationResult.accuracyIsSpellish,
            negated: !!mutationResult.negated,
            // Grant boost (heal/restore) — chips always; headline only when boosted.
            grantRows,
            grantHeadline,
            healHeadlineObj: (grantHeadline != null && payload?.damage) ? payload.damage : null,
            healHeadlineRoll: (grantHeadline != null && payload?.roll) ? payload.roll : null,
            // Study: carry the target's best-known result so the shared delta
            // patcher (GM + mirror) can re-derive + repaint the Tier Reached
            // fieldset from the mutated roll total. Serializable plain data.
            study: String(arSnapshot.kind ?? "") === "Study"
              ? { previousBest: Number(arSnapshot.previousBest) || 0 }
              : null,
          };
          // Unified target-surface render — when a mutation CHANGED THE TARGET SET
          // (redirect / add_target / shield) OR flipped a NO-DAMAGE skill's per-target
          // verdict, regenerate ALL target-displaying surfaces (Engagement row,
          // portraits, Result list) from the post-mutation list via the canonical
          // builders. Correct by construction for any target-mutation kind, and it
          // renders ADDED rows (add_target splash / shield phantasm) that the per-uuid
          // delta patcher can't inject. `redirectedFrom` is merged onto the flat rows
          // (projectProfileToActionResult drops it). Each surface is try/caught.
          //
          // Triggers:
          //   • a redirect is present, OR
          //   • the target set GREW (add_target / shield added a slot), OR
          //   • a NO-DAMAGE skill's verdict flipped (SUCCESS↔FAILED) from a check-adjust
          //     — the surgical result-span loop below is gated on hasDamageRows and so
          //     never repaints those. Damage skills keep the surgical + animated path.
          // CHANGED, not merely grew. A GM removal makes the set SHRINK, and the
          // surgical loop below walks `recomputed` and `original` BY INDEX — with
          // different lengths that misaligns, painting one target's hit/damage
          // onto another creature's row on the GM card and every mirror, while
          // the removed row stays on the card looking hit. A rebuild is the only
          // honest response to a set whose membership moved.
          const targetSetChanged = mutTargets.length !== original.length
            || mutTargets.some((t) => t?.addedVia || t?.shieldedVia);
          const verdictFlipped = recomputed.some((e, i) =>
            e && original[i] && (!!e.hit !== !!original[i].hit));
          const needsSurfaceRebuild =
            (Array.isArray(delta.redirects) && delta.redirects.length)
            || targetSetChanged
            || (!hasDamageRows && verdictFlipped);
          // `recomputed.length` alone would skip the one case that most needs a
          // rebuild — a GM removal that emptied the target set. Rebuilding an
          // EMPTY set is the honest response; not rebuilding leaves every
          // original row painted as though still being hit, which is exactly why
          // emptying used to be forbidden. A no-damage Skill (targets, no rows)
          // still takes the old path: nothing to repaint, nothing repainted.
          if (needsSurfaceRebuild && (recomputed.length || !mutTargets.length)) {
            const rowsSrc = recomputed.map((r, i) => ({
              ...r,
              redirectedFrom: mutTargets[i]?.redirectedFrom ?? r.redirectedFrom ?? null,
            }));
            // Rides the DELTA (applied below) instead of rendering here, so the
            // player mirror rebuilds the same surfaces from the same data rather
            // than receiving a pre-rendered `.fud-bf-body` dump.
            delta.surfaces = {
              attacker: toWireSafe(payload?.attacker ?? arSnapshot.attacker ?? null),
              targets: projectRowsForWire(mutTargets),
              perTargetResults: projectRowsForWire(rowsSrc),
              element: arSnapshot.damage?.element ?? null,
              roll: toWireSafe(arSnapshot.roll ?? null),
              vsMDef: redirectVsMDef,
              hasDamage: hasDamageRows,
            };
          }

          // Non-redirect result-span refresh — for the add_damage path
          // (Cheap Shot bonus toggles). Walks the recomputed list and
          // patches only rows that DIDN'T get a redirect (those are
          // already handled by the delta above). Gated on hasDamageRows
          // so non-damage Skills keep SUCCESS/FAILED labels.
          if (hasDamageRows) {
            // SELECTION ONLY — the DOM work moved to the shared delta patcher
            // (applyCardTargetMutationDelta section 2) so the player mirror
            // paints the same rows from the same data. The skip rules are
            // unchanged: redirected slots are handled by the redirect loop,
            // grant rows aren't damage, and an unstudied row stays masked
            // ("???") because painting a result there would leak "HIT N" onto a
            // row whose DEF still reads "???".
            //
            // The shipped field set is exactly what resultClsFor / resultLabelFor
            // / buildAffinityTagHTML read. `damageOverride` in particular is
            // load-bearing: it drives the NULLIFIED label and the muted class for
            // a soaked hit (Ninja Log), and dropping it would silently downgrade
            // those rows to a plain "HIT 0".
            //
            // Joined by TOKEN, not by index. `original` and `recomputed` are
            // only index-parallel while the set has the same membership, and a
            // GM removal makes it shrink: with targets [A, B, C] and A dropped,
            // i=1 paired B's uuid with C's numbers, so B's row — on the GM card
            // and on every mirror — was painted with C's damage and affinity.
            // The surface rebuild above does not save it; this loop runs after
            // it and re-corrupts the freshly-built rows.
            const origByToken = new Map((original ?? [])
              .filter((r) => r?.tokenUuid).map((r) => [r.tokenUuid, r]));
            const resultRows = [];
            for (const entry of recomputed) {
              // A GM-ADDED creature has no original row at all; it is its own
              // source for the DOM hooks.
              const origEntry = (entry?.tokenUuid && origByToken.get(entry.tokenUuid)) || entry;
              if (!origEntry?.actorUuid || !entry) continue;
              if (entry.redirectedFrom) continue;                     // already patched
              if (entry.studied === false) continue;                  // stays masked
              if (typeof entry.grantAmount === "number") continue;    // grant rows aren't damage
              resultRows.push({
                // Prefer the tokenUuid hook (unique per token — disambiguates two
                // linked tokens of one actor); actorUuid is the fallback.
                tokenUuid: origEntry.tokenUuid ?? entry.tokenUuid ?? null,
                actorUuid: origEntry.actorUuid ?? entry.actorUuid ?? null,
                name: entry.name ?? origEntry.name ?? "",
                hit: entry.hit,
                crit: entry.crit,
                affinity: entry.affinity ?? null,
                damage: entry.damage,
                resource: entry.resource ?? null,
                studied: entry.studied,
                damageOverride: entry.damageOverride
                  ? { from: entry.damageOverride.from ?? null, to: entry.damageOverride.to ?? null }
                  : null,
              });
            }
            delta.resultRows = resultRows;

            // Headline damage preview — the prominent `.fud-bf-dmg` fieldset
            // shows the weapon's base (finalIfHit) and its hover tooltip
            // itemizes where that damage came from. NEITHER is touched by the
            // per-target loop, so an outgoing reaction bonus (on/force buffs
            // like Hawkeye, accepted ask buffs like Cheap Shot, Bite's grappled
            // +50% adjust_damage) would show up in the per-target totals but be
            // missing from BOTH the headline number AND the tooltip breakdown.
            //
            // Find the representative hit target (pre-affinity base is uniform
            // across hit targets) and fold its reaction ops — captured by
            // recomputePerTargetDamages as `bonusBreakdown.ops` — back into a
            // patched `damage` object so the regenerated fieldset itemizes each
            // op by its carrier (e.g. "Bite: +24"). The headline number is then
            // re-pinned to the recomputed rawDamage to preserve the existing
            // post-reduction semantics. Idempotent: no bonus (e.g. a toggled-off
            // reaction) → byte-identical to the COMPUTE-time preview, since we
            // always rebuild from the immutable `payload.damage`.
            if (payload?.damage) {
              let repEntry = null;
              for (let i = 0; i < recomputed.length; i++) {
                const e = recomputed[i];
                if (e?.hit && typeof e.rawDamage === "number" && typeof e.grantAmount !== "number") {
                  repEntry = e;
                  break;
                }
              }
              // Per-source reaction deltas for the representative target — walk
              // its ops the same way action-profile's buildPerTarget does, so a
              // multiply/percentage op (Bite's ×1.5) surfaces as its integer
              // contribution attributed to the carrier skill, not a raw factor.
              const reactionParts = [];
              const ops = repEntry?.bonusBreakdown?.ops ?? [];
              if (ops.length) {
                let d = Number(repEntry.bonusBreakdown.from) || 0;
                for (const o of ops) {
                  const next = sk.applyDamageOp(d, o.op, o.amount);
                  const delta = Math.floor(next) - Math.floor(d);
                  if (delta !== 0) reactionParts.push({ source: o.source ?? "Reaction", amount: delta });
                  d = next;
                }
              }
              const reactionDelta = reactionParts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
              const baseDamage = payload.damage;
              // Element override (Tinkerer Infusions: Cryo/Pyro/… change the
              // attack's element). recomputePerTargetDamages stamps the new
              // element on the entry; fold it into the displayed damage so the
              // headline element label re-renders (e.g. Physical → Fire) instead
              // of staying on the weapon's base element.
              const newElement = repEntry?.bonusBreakdown?.element ?? repEntry?.element ?? null;
              const elementChanged = !!newElement &&
                String(newElement).toLowerCase() !== String(baseDamage.element ?? "").toLowerCase();
              const patchedDamage = (reactionDelta !== 0 || elementChanged)
                ? {
                    ...baseDamage,
                    ...(elementChanged ? { element: newElement } : {}),
                    base: (Number(baseDamage.base) || 0) + reactionDelta,
                    baseParts: [
                      ...(Array.isArray(baseDamage.baseParts) ? baseDamage.baseParts : []),
                      ...reactionParts,
                    ],
                    finalIfHit: (Number(baseDamage.finalIfHit) || 0) + reactionDelta,
                  }
                : baseDamage;
              // If the ROLL itself changed (check_reroll), payload.damage carries the
              // STALE HR baked into finalIfHit — take the recompute's headline damage
              // WHOLESALE (projectProfileToActionResult already folded the new HR +
              // reactions + element) and render it against the new roll, so the headline
              // agrees with the recomputed per-target rows. This sources the entire
              // headline from the single recompute instead of patching numbers piecemeal.
              const mutRoll = mutationResult.roll ?? null;
              const rollChanged = !!(mutationResult.recomputedDamage && mutRoll && payload?.roll
                && (mutRoll.rA !== payload.roll.rA || mutRoll.rB !== payload.roll.rB || mutRoll.total !== payload.roll.total));
              const headlineDamage = rollChanged ? mutationResult.recomputedDamage : patchedDamage;
              const headlineRoll = rollChanged ? mutRoll : (payload?.roll ?? null);
              // Rendering — the fieldset rebuild, the `is-blocked-dmg` carry-over
              // and the running-number tween — happens in the shared delta
              // patcher, so the player mirror gets an identical headline instead
              // of inheriting one inside a body dump.
              //
              // The number is whatever buildDamagePreviewHTML renders:
              // damage.finalIfHit = base + attacker-side reaction bonuses, BEFORE
              // any per-target incoming reduction. So an AoE shows the pre-split
              // base (e.g. 150) and each per-target row shows its own reduced
              // value. (Previously re-pinned to the representative target's
              // post-reduction rawDamage, which leaked one target's reduction —
              // e.g. Defensive Mastery -1 → headline 149 — into the shared number.)
              delta.damageHeadline = {
                damage: toWireSafe(headlineDamage),
                roll: toWireSafe(headlineRoll),
              };
            }
          }
          // Paint the GM's own card — ONE call that now covers every body surface
          // (redirects, defense, grants, accuracy, cost, study, target surfaces,
          // result spans, headline, effects panel). Everything below this point is
          // pill-side or wire-side.
          //
          // Project the delta ONCE, then use the SAME object for the local paint
          // and for the broadcast. Two reasons that pairing matters:
          //
          //  • Clone-safety. The WHOLE delta now crosses a socket, not just the
          //    fields added for the mirror — and structured clone THROWS on a
          //    class instance, so one future field carrying a Document would
          //    break every recompute. The projection makes that structurally
          //    impossible rather than a thing to remember.
          //  • No silent divergence. Anything the projection drops breaks the
          //    GM's OWN card too, so a projection bug shows up on the director's
          //    screen (and in the sim / regression run) instead of hiding on the
          //    thin-connection player's mirror where nobody would see it.
          delta.effectPreview = computeReactionEffectPreviewData();
          const wireDelta = toWireSafe(delta) ?? delta;
          applyCardTargetMutationDelta(root, wireDelta);

          // Creatures dragged into the target set by this mutation (redirect
          // destination / add_target splash) can now use their own "when I'm
          // targeted" reactions — re-scan + inject those as fresh pills. No-op
          // when the mutation added no new targets; no-reuse via cascadeFiredKeys.
          // Touches PILLS only (siblings of `.fud-bf-body`), so running it after
          // the body paint above cannot disturb the surfaces just rendered.
          if (!mutationResult.negated) {
            try { await injectTargetedReactionsForNewTargets(mutTargets, original, recomputed); }
            catch (e) { warn("recomputeTargetPreviews: targeted re-scan threw", e); }
          }

          // Negated/Blocked action — auto-reject any still-pending (undecided) ask
          // pills. Reacting to a nullified action is moot, and skipping them clears
          // the Confirm lock (the data-fud-reactions-pending counter). Uses the pure
          // DOM-commit (NOT recordPillDecision) to avoid re-entering this recompute.
          if (mutationResult.negated || mutationResult.accuracyOverride?.blocked) {
            for (const p of cardReactions ?? []) {
              if (p.mode !== "ask") continue;
              const k = `${p.rowKey}:${p.carrierUuid}`;
              if (reactionDecisionMap.has(k)) continue;   // already decided (incl. the negate/block pill itself)
              setReactionDecision(k, "skip");
              try { commitPillDecisionDom(p.rowKey, p.carrierUuid, "skip"); }
              catch (e) { warn("auto-reject pending pill on negate threw", e); }
            }
          }

          // Mirror to every player client as a STRUCTURED delta.
          //
          // This replaced an `action-card-body-update` broadcast that shipped the
          // whole rendered `.fud-bf-body` innerHTML. That swap was correct by
          // construction, but it sent the entire body to every client on every
          // damage-touching reaction — and it existed only because the per-target
          // result spans, the headline fieldset and the effects panel were painted
          // GM-side and had no delta representation. All three now ride the delta
          // (see applyCardTargetMutationDelta), so the mirror reaches the same
          // state from data at a fraction of the bytes.
          //
          // effectPreview is re-resolved HERE rather than reused from above: the
          // auto-reject sweep can flip pending pills to "skip", which changes
          // which reactions contribute chips.
          try {
            wireDelta.effectPreview = toWireSafe(computeReactionEffectPreviewData());
            const onlineNonPrimary = (game.users?.contents ?? []).filter((u) => u.active && u.id !== game.user?.id);
            if (onlineNonPrimary.length) {
              director?.intentChannel?.broadcastMenuOpen({
                targetUserIds: onlineNonPrimary.map((u) => u.id),
                menuSpec: {
                  kind: "action-card-target-mutation",
                  combatId: director.combatId,
                  delta: wireDelta,
                },
              });
            }
          } catch (e) { warn("recomputeTargetPreviews: delta broadcast threw", e); }

          return { cancelled: false };
        } catch (e) {
          warn("action-card: recomputeTargetPreviews threw", e);
          return { cancelled: false, error: String(e?.message ?? e) };
        }
      })();
      const result = await _previewInFlight;
      _previewInFlight = null;
      return result ?? { cancelled: false };
    }

    // Initial pass — surface "on" / "force" auto-applied reactions immediately
    // on card spawn (they pre-record as "apply" above). Besides damage bonuses,
    // resolve any auto reaction's option-menu NOW (so the menu prompts at card
    // creation, not deferred to RESOLVE), then recompute + render the Effect
    // panel. Fire-and-forget so the card return isn't blocked.
    (async () => {
      try {
        for (const p of cardReactions ?? []) {
          if (!isAutoFireReactionMode(p?.mode)) continue;
          if (reactionDecisionMap.get(`${p.rowKey}:${p.carrierUuid}`) !== "apply") continue;
          if (Array.isArray(p.chosenMenuPicks)) continue;   // already resolved
          try {
            const se = await import("./skill-effects.js?cb=" + Date.now());
            const reactorActor = p.reactorActorUuid
              ? await fromUuid(p.reactorActorUuid).catch(() => null)
              : (payload?.attackerActor ?? null);
            if (!reactorActor) continue;
            // Auto-hides while an option-menu actually renders (picker-overlay
            // hooks); an auto-resolved menu shows no UI, so the freshly-spawned
            // card no longer flashes out-and-in on appearance.
            const menuRes = await se.previewReactionMenu({
              casterActor: reactorActor, candidate: p, payload: p.payloadAtFire ?? null,
              dCombat: director?.dCombat ?? null,
              isPassive: true,   // honor skip_when_passive; still prompts a real choice
            });
            if (menuRes?.hasMenu && !menuRes.cancelled) {
              p.chosenMenuPicks = Array.isArray(menuRes.picks) ? menuRes.picks : [];
              p.previewEffects = Array.isArray(menuRes.effects) ? menuRes.effects : [];
              p.previewDamageNullified = !!menuRes.damageNullified;
            }
          } catch (e) { warn("postActionCard: auto reaction menu preview threw", e); }
        }
        await recomputeTargetPreviews().catch(() => {});
        try { applyReactionEffectPreview(); } catch (e) { warn("postActionCard: spawn effect preview threw", e); }
      } catch (e) { warn("postActionCard: spawn auto-pass threw", e); }
    })();

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
    let invokeAwait = null;
    let editAwait = null;
    let hudOpenAwait = null;
    let hudCloseAwait = null;
    let hudSelectAwait = null;
    const abortPendingAwaits = () => {
      try { confirmAwait?.abort?.("postActionCard-finish"); } catch {}
      try { cancelAwait?.abort?.("postActionCard-finish"); } catch {}
      try { reactionAwait?.abort?.("postActionCard-finish"); } catch {}
      try { invokeAwait?.abort?.("postActionCard-finish"); } catch {}
      try { editAwait?.abort?.("postActionCard-finish"); } catch {}
      try { hudOpenAwait?.abort?.("postActionCard-finish"); } catch {}
      try { hudCloseAwait?.abort?.("postActionCard-finish"); } catch {}
      try { hudSelectAwait?.abort?.("postActionCard-finish"); } catch {}
    };
    // Push the post-invoke actionResult to EVERY other active client so all
    // mirror cards (acting owner, spectator players, secondary GMs) reflect
    // the rerolled numbers. The primary GM already patched its own DOM in the
    // worker; the u.id filter skips re-sending to self. Same audience as the
    // initial card broadcast — spectators hold a mirror and offInvokeUpdate
    // no-ops if they don't. patchCardDom is pure DOM (no actor reads) and
    // preserves ??? masking for unstudied targets, so no info leak.
    const broadcastInvokeUpdate = () => {
      const menuSpec = {
        kind: "action-card-invoke-update",
        actionResult: projectActionResultForRender(cardAr),
        invokeState: { ...invokeState },
      };
      const targetUserIds = (game.users?.contents ?? [])
        .filter((u) => u.active && u.id !== game.user?.id)
        .map((u) => u.id);
      try { director.intentChannel?.broadcastMenuOpen({ targetUserIds, menuSpec }); } catch {}
    };

    // ── Spectator invoke HUD (read-only mirror of the theatrical panel) ───────
    // While the ACTOR decides (real HUD on their own client), show the same
    // dimmer/aura/panel — read-only — on every OTHER active client so the table
    // sees the beat instead of a silent number flip. The GM is always the
    // broadcaster (only the GM may broadcastMenuOpen); when a PLAYER is the
    // actor the GM is itself a spectator, so it also renders the panel locally.
    // Tracks whether the GM rendered its own local spectator panel so close
    // can tear it down.
    let _specHudShownLocally = false;

    // Build the serializable spectator render payload from the live
    // actionResult + attacker actor. Bond hearts are precomputed here so the
    // receiving client needs no actor read-permission.
    const buildSpectatorPayload = async (type) => {
      const ar = cardAr;
      if (!ar?.roll) return null;
      let actorName = "The attacker";
      let bonds = [];
      try {
        const uuid = ar.attackerActorRef ?? ar.attacker?.actorUuid ?? null;
        const actor = uuid ? await fromUuid(uuid) : null;
        if (actor?.name) actorName = actor.name;
        if (type === "bond" && actor) {
          const core = await import("./invoke/invoke-core.js");
          bonds = core.readActorBondsForSpectator(actor);
        }
      } catch {}
      const r = ar.roll;
      return {
        type, actorName, bonds,
        roll: { A1: r.A1, A2: r.A2, dA: r.dA, dB: r.dB, rA: r.rA, rB: r.rB },
        tokenUuid: ar.attacker?.tokenUuid ?? null,
      };
    };

    // Open the spectator HUD on all active clients except `excludeUserId` (the
    // actor). When the GM is not the actor, render it locally too.
    const openSpectatorHud = async (type, excludeUserId) => {
      try {
        const spec = await buildSpectatorPayload(type);
        if (!spec) return;
        const menuSpec = { kind: "invoke-hud-spectator", combatId: director.combatId, spec };
        const spectatorIds = (game.users?.contents ?? [])
          .filter((u) => u.active && u.id !== game.user?.id && u.id !== excludeUserId)
          .map((u) => u.id);
        try { director.intentChannel?.broadcastMenuOpen({ targetUserIds: spectatorIds, menuSpec }); } catch {}
        // GM is a spectator whenever someone else is the actor → render locally
        // (socket never echoes our own broadcast back to us). Dock it beside
        // the GM's own card root.
        if (excludeUserId && excludeUserId !== game.user?.id) {
          const hud = await import("./invoke/invoke-hud.js");
          if (type === "trait") hud.showTraitSpectator({ roll: spec.roll, actorName: spec.actorName, root, tokenUuid: spec.tokenUuid });
          else hud.showBondSpectator({ bonds: spec.bonds, actorName: spec.actorName, root, tokenUuid: spec.tokenUuid });
          _specHudShownLocally = true;
        }
      } catch (e) { warn("postActionCard: openSpectatorHud threw", e); }
    };

    // Close the spectator HUD everywhere. `traitOutcome` ({oldTotal,newTotal})
    // plays the dice + up/down cue in sync with the card result animation.
    // `type` ("trait"|"bond") gates the dismiss so a stale close can't tear
    // down a freshly-opened HUD of the other type (rapid type-switch).
    const closeSpectatorHud = ({ excludeUserId = null, traitOutcome = null, cancelled = false, type = null } = {}) => {
      const spectatorIds = (game.users?.contents ?? [])
        .filter((u) => u.active && u.id !== game.user?.id && u.id !== excludeUserId)
        .map((u) => u.id);
      try {
        director.intentChannel?.broadcastMenuClose({
          targetUserIds: spectatorIds, kind: "invoke-hud-spectator",
          data: { traitOutcome, cancelled, expectKind: type },
        });
      } catch {}
      if (_specHudShownLocally) {
        _specHudShownLocally = false;
        import("./invoke/invoke-hud.js").then((hud) => hud.dismissSpectator({ traitOutcome, cancelled, expectKind: type })).catch(() => {});
      }
    };

    // Live-selection echo (Phase 2) — relay the actor's in-progress die/bond
    // selection to every other client's read-only HUD via in-place MENU_PATCH
    // (uncached, no replay). When the GM is a spectator (a player is acting) it
    // also applies the selection to its own local panel.
    const broadcastSpectatorSelect = (type, sel, excludeUserId) => {
      const patch = { kind: "invoke-hud-spectator-select", type, sel };
      const spectatorIds = (game.users?.contents ?? [])
        .filter((u) => u.active && u.id !== game.user?.id && u.id !== excludeUserId)
        .map((u) => u.id);
      try { director.intentChannel?.broadcastMenuPatch({ targetUserIds: spectatorIds, patch }); } catch {}
      if (_specHudShownLocally && excludeUserId && excludeUserId !== game.user?.id) {
        import("./invoke/invoke-hud.js").then((hud) => {
          if (type === "trait") hud.applyTraitSpectatorSelection(sel ?? {});
          else hud.applyBondSpectatorSelection(sel ?? {});
        }).catch(() => {});
      }
    };

    // Trait reroll presentation — the actor's pick is committed (ctx.actionResult
    // already holds the rerolled values). Animate the dice on EVERY open invoke
    // HUD (the actor's real one + everyone's spectator one), THEN patch the card,
    // THEN play the up/down chime — so the card never updates before the dice
    // land. One authoritative roll drives all clients (the tumble frames are
    // local flavor; the landed value is identical everywhere).
    const presentTraitReroll = async ({ choice, oldTotal }) => {
      const newAr = cardAr;
      const roll  = newAr?.roll;
      if (!roll) return;
      const intense  = !!(roll.isCrit || roll.isFumble);
      const rollLite = { rA: roll.rA, rB: roll.rB, dA: roll.dA, dB: roll.dB, total: roll.total, isCrit: !!roll.isCrit, isFumble: !!roll.isFumble };
      const menuSpec = {
        kind: "invoke-trait-reroll",
        combatId: director.combatId,
        choice, oldTotal, intense, roll: rollLite,
        actionResult: projectActionResultForRender(newAr),
        invokeState: { ...invokeState },
      };
      // 1) Broadcast to every other active client (their handler animates → patches).
      const rerollUserIds = (game.users?.contents ?? [])
        .filter((u) => u.active && u.id !== game.user?.id)
        .map((u) => u.id);
      try { director.intentChannel?.broadcastMenuOpen({ targetUserIds: rerollUserIds, menuSpec }); } catch {}
      // 2) Present locally — animate the GM's open HUD (real if GM-acts, spectator
      //    if a player acted), then patch the card + chime.
      try {
        const hud = await import("./invoke/invoke-hud.js");
        await hud.animateInvokeReroll({ choice, rA: roll.rA, rB: roll.rB, dA: roll.dA, dB: roll.dB, intense });
        const worker = await import(`./invoke/invoke-worker.js?cb=${Date.now()}`);
        worker.patchCardDom(root, newAr, invokeState);
        hud.playTraitResultChime(oldTotal, roll.total);
      } catch (e) { warn("presentTraitReroll: local present threw", e); }
      if (roll.isCrit && !roll.isFumble) {
        try { (await import("./director-cutin.js")).playCritCutin(newAr); } catch {}
      }
      _specHudShownLocally = false; // the animation tore down any local spectator HUD
    };

    if (director?.intentChannel) {
      try {
        confirmAwait = director.intentChannel.awaitIntent(INTENTS.CONFIRM_ACTION, {
          timeoutMs: 30 * 60 * 1000,
        });
        cancelAwait = director.intentChannel.awaitIntent(INTENTS.CANCEL_ACTION, {
          timeoutMs: 30 * 60 * 1000,
        });
        // Acknowledge a remote Confirm/Cancel the INSTANT it lands (before running
        // the action) so the sender's mirror can stand down its no-response retry
        // timer — mirrors the reaction-pill "ack" contract. finish() then
        // broadcasts the card-close that tears their mirror down.
        const sendConfirmAck = (fromUid) => {
          if (!fromUid || fromUid === game.user?.id) return;
          try {
            director.intentChannel.broadcastMenuOpen({
              targetUserId: fromUid,
              menuSpec: { kind: "action-card-confirm-ack", combatId: director.combatId },
            });
          } catch (e) { warn("postActionCard: confirm-ack broadcast threw", e); }
        };
        confirmAwait.then((intent) => {
          log("postActionCard: remote CONFIRM_ACTION received");
          sendConfirmAck(intent?.fromUserId ?? null);
          const extras = intent?.body ?? {};
          finish("confirm", extras);
        }).catch((e) => {
          if (!resolved) warn("postActionCard: CONFIRM_ACTION await failed", e?.message);
        });
        cancelAwait.then((intent) => {
          log("postActionCard: remote CANCEL_ACTION received");
          sendConfirmAck(intent?.fromUserId ?? null);
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
            const fromUid = intent?.fromUserId ?? null;
            // Acknowledge receipt to the clicking player IMMEDIATELY so their
            // mirror cancels its no-response retry timer (the click landed). The
            // final Applied/Skipped/revert follows after resolution — which may
            // legitimately take a while if a secondary picker opens on their
            // client. Sent before recordPillDecision so a slow resolve never
            // looks like a dropped message.
            if (fromUid && fromUid !== game.user?.id) {
              try {
                director.intentChannel.broadcastMenuOpen({
                  targetUserId: fromUid,
                  menuSpec: {
                    kind: "action-card-pill-update",
                    combatId: director.combatId,
                    rowKey: String(body.rowKey ?? ""),
                    carrierUuid: String(body.carrierUuid ?? ""),
                    decision: "ack",
                  },
                });
              } catch (e) { warn("postActionCard: reaction ack broadcast threw", e); }
            }
            // intent.fromUserId = the player who applied → route their secondary
            // pickers back to their client (recordPillDecision builds remotePrompt).
            recordPillDecision(String(body.rowKey ?? ""), String(body.carrierUuid ?? ""), decision, fromUid);
            // Re-arm for the next pill click (or no-op if none left).
            armReactionAwait();
          }).catch((e) => {
            if (!resolved) log(`postActionCard: REACTION_CHOICE await aborted (${e?.message})`);
          });
        };
        armReactionAwait();

        // Invoke-choice loop — re-arm after each pick so the player can use
        // both Trait and Bond if their actor supports full invoke.
        const armInvokeAwait = () => {
          if (resolved) return;
          invokeAwait = director.intentChannel.awaitIntent(INTENTS.INVOKE_CHOICE, {
            timeoutMs: 30 * 60 * 1000,
            // No fromUserId filter — accept invoke from the acting owner OR
            // from any secondary GM who clicked Invoke on their mirror card.
          });
          invokeAwait.then(async (intent) => {
            const body = intent?.body ?? {};
            const type = body.type; // "trait" | "bond"
            const fromUserId = intent.fromUserId ?? null;
            log(`postActionCard: remote INVOKE_CHOICE received (${type})`);
            // Drift guard: if the director has moved on to a different action,
            // this card is no longer the live action — never reroll/charge the
            // wrong actor just because the live slot changed. Re-arm and bail.
            const liveInst = director.ctx.actionResult?._instanceId ?? null;
            if (liveInst && cardInstanceId && liveInst !== cardInstanceId) {
              warn(`postActionCard: INVOKE_CHOICE ignored — card ${cardInstanceId} is no longer the live action (live ${liveInst})`);
              ui.notifications?.warn("This action is no longer active — invoke can't be applied.");
              armInvokeAwait();
              return;
            }
            const oldTotal = cardAr?.roll?.total ?? 0;
            let ok = false;      // truthy on success (trait: choice string, bond: true)
            try {
              const worker = await import(`./invoke/invoke-worker.js?cb=${Date.now()}`);
              if (type === "trait") {
                ok = await worker.handleInvokeTrait({
                  director, ar: cardAr, root, invokeState,
                  prePickedChoice: body.choice ?? null,
                });
              } else if (type === "bond") {
                ok = await worker.handleInvokeBond({
                  director, ar: cardAr, root, invokeState,
                  prePickedBondIndex: body.bondIndex ?? null,
                });
              }
            } catch (e) {
              warn("postActionCard: INVOKE_CHOICE handler threw", e);
            }
            // Sync the card's snapshot with the rerolled/bonused result the
            // worker produced (it stamps invokeState.lastAr), so presentation
            // and any second invoke read the updated values — not the slot.
            if (ok) cardAr = invokeState.lastAr ?? cardAr;
            if (ok && type === "trait") {
              // Reroll: animate the dice on every client's open HUD, then patch
              // the card. Replaces the silent invoke-update + spectator-close.
              await presentTraitReroll({ choice: body.choice ?? ok, oldTotal });
            } else if (ok) {
              // Bond: flat bonus, no dice animation — patch + tear down spectators.
              broadcastInvokeUpdate();
              closeSpectatorHud({ excludeUserId: fromUserId, type: "bond" });
            } else {
              // Post-commit failure (rare, e.g. payment failed). Tear down ALL
              // open HUDs — including the actor's own committing one (excludeUserId
              // null, so the actor isn't skipped); dismissSpectator is committing-aware.
              closeSpectatorHud({ excludeUserId: null, cancelled: true, type });
            }
            armInvokeAwait();
          }).catch((e) => {
            if (!resolved) log(`postActionCard: INVOKE_CHOICE await aborted (${e?.message})`);
          });
        };
        if (ownerUserId) armInvokeAwait();

        // ─── Manual GM card edits ────────────────────────────────────────────
        // THE single writer. Both the host GM's own panel and a support GM's
        // EDIT_CARD intent land here, so there is exactly one place that mutates
        // ar.gmOverride and exactly one recompute+broadcast that follows it. A
        // support GM's edit therefore becomes visible to them only once the host
        // has echoed it — which is what keeps two GMs from diverging.
        // Re-derive the Confirm lock from the DOM rather than nudging it by ±1.
        // A GM edit can flip several pills at once and in either direction (an
        // undecided ask pill forced, a forced one cleared back to undecided), so
        // a delta would have to be exactly right in every combination; a recount
        // is right by construction.
        const recountReactionPending = () => {
          const cardEl = root.querySelector(".fud-bf-card");
          if (!cardEl) return 0;
          const n = root.querySelectorAll(
            '.fud-bf-reaction-pill[data-fud-reaction-pending="1"][data-fud-reaction-gating="1"]').length;
          if (n > 0) cardEl.dataset.fudReactionsPending = String(n);
          else delete cardEl.dataset.fudReactionsPending;
          return n;
        };

        // Push the GM's reaction verdicts into the card's decision map.
        //
        // That map is the SINGLE upstream of both the preview's accepted list and
        // snapshotReactionDecisions() — which feeds CONFIRM's mutation pass and
        // RESOLVE's firePreAcceptedCandidate — so writing it here is the same
        // "thread INTO the recompute" rule the roll and damage sections follow.
        // No result is patched, and the caller's recompute does the rest.
        const reconcileGmReactions = (gmOverride, reopenKeys = null) => {
          // Reopen FIRST, by clearing what the card decided unaided. After that
          // the ordinary want = gm ?? base computation lands on null all by
          // itself, so an un-decision travels the same single path as every
          // other verdict instead of getting its own repaint branch.
          const reopened = new Set(reopenKeys ?? []);
          for (const key of reopened) {
            const i = key.lastIndexOf("::");
            if (i >= 0) baseDecisionMap.delete(`${key.slice(0, i)}:${key.slice(i + 2)}`);
          }
          const changes = gmReactionDecisionChanges(
            cardReactions, gmOverride,
            (c) => reactionDecisionMap.get(`${c.rowKey}:${c.carrierUuid}`) ?? null,
            (c) => baseDecisionMap.get(`${c.rowKey}:${c.carrierUuid}`) ?? null,
            reopened,
          );
          if (!changes.length) return { total: 0, forced: 0 };
          for (const ch of changes) {
            const key = `${ch.rowKey}:${ch.carrierUuid}`;
            // ⚠ A GM verdict overrides the DECISION AND NOTHING ELSE.
            //
            // Only the decision map is written here. The CANDIDATE is never
            // touched — not `available`, not its cost rows — so a forced
            // reaction still runs the skill's whole normal process: the chain
            // fires in order, `consume_resource` charges as authored, and a
            // payer who is short hits that row's own `on_empty` (default
            // "abort", so the chain stops and no pool goes negative).
            //
            // USER RULING 2026-08-12: "GM only override decision. They still
            // have to go through the process of the skill (or the skill might
            // break)." So do NOT add a convenience bypass here — flipping
            // `available` or skipping the cost row to make a forced reaction
            // "work" would skip the very steps the rest of the skill depends on.
            // If a forced reaction does nothing, an unmet cost or gate is the
            // ANSWER, not a bug to route around.
            if (ch.decision == null) reactionDecisionMap.delete(key);
            else reactionDecisionMap.set(key, ch.decision);
            // Drop the apply-click residue when a reaction stops being applied,
            // exactly as recordPillDecision's skip branch does. Without this a
            // suppressed candidate keeps its cached menu picks, and a LATER
            // Apply from this editor replays them silently instead of asking —
            // the pill path always re-runs previewReactionMenu, so the two
            // surfaces would answer the same question differently.
            if (ch.decision !== "apply") {
              const cand = cardReactions.find((p) =>
                String(p.rowKey) === String(ch.rowKey) && String(p.carrierUuid) === String(ch.carrierUuid));
              if (cand) {
                cand.chosenMenuPicks = null;
                cand.previewEffects = null;
                cand.previewDamageNullified = false;
              }
            }
            const pillSel = `.fud-bf-reaction-pill[data-fud-reaction-key="${CSS.escape(String(ch.rowKey))}"][data-fud-reaction-carrier="${CSS.escape(String(ch.carrierUuid))}"]`;
            // buildReactionPills COLLAPSES several auto rows from one carrier
            // into a single pill (Adversity's two force rows), so an exact
            // rowKey match finds nothing for every row but the first — a Skip
            // then updated the map with no visible change at all. Fall back to
            // the carrier's pill, which is the one representing this row.
            const carrierSel = `.fud-bf-reaction-pill[data-fud-reaction-carrier="${CSS.escape(String(ch.carrierUuid))}"]`;
            let pillEl = root.querySelector(pillSel) ?? root.querySelector(carrierSel);
            // An `off`-mode candidate has NO pill — buildReactionPills hides
            // player-disabled rows. Forcing one would then fire a reaction the
            // card never mentions, which is the one thing a manual override must
            // not do: everyone at the table has to be able to see that it
            // happened. Inject the pill first, as an active row, and let the
            // paint below stamp it "Forced".
            // Only when the carrier has NO pill at all — the carrier fallback
            // above already covers a collapsed row, and injecting there would
            // add a second pill for a carrier that is on the card once.
            if (!pillEl && ch.decision === "apply") {
              const cand = cardReactions.find((p) =>
                String(p.rowKey) === String(ch.rowKey) && String(p.carrierUuid) === String(ch.carrierUuid));
              if (cand) {
                try { appendCascadePills([{ ...cand, mode: "force", available: true }]); }
                catch (e) { warn("reconcileGmReactions: pill injection threw", e); }
                pillEl = root.querySelector(pillSel);
              }
            }
            if (pillEl) {
              const cardEl = root.querySelector(".fud-bf-card");
              if (ch.decision == null) restoreReactionPillButtons(pillEl, cardEl);
              else resolveReactionPillDom(pillEl, cardEl, ch.decision, { gm: ch.byGm });
            }
            log(`GM reaction ${ch.reopened ? "reopened (undecided)" : (ch.decision ?? "cleared")}: ${ch.carrierName ?? ch.carrierUuid} (${key})`);
          }
          // ── Retract derived pills when anything is rolled back ─────────────
          // A cascade pill (Bullet Break after Crossfire) exists only because
          // another reaction was applied. Suppressing or reopening the set
          // without touching the children left them decided, in
          // acceptedCardReactions, and FIRING at RESOLVE — chained to an action
          // the card now says never happened.
          //
          // They are un-decided rather than skipped: nothing is committed before
          // CONFIRM, so handing the question back is the honest revert, and a
          // still-eligible child can simply be applied again. Scoped to
          // rollbacks — a force ADDS to the set, and injectCascadeReactions
          // re-derives from it.
          const rolledBack = changes.some((c) => c.decision !== "apply");
          if (rolledBack) {
            for (const cand of cardReactions) {
              if (!cand?._cascadeInjected) continue;
              const ckey = `${cand.rowKey}:${cand.carrierUuid}`;
              if (!reactionDecisionMap.has(ckey) && !baseDecisionMap.has(ckey)) continue;
              reactionDecisionMap.delete(ckey);
              baseDecisionMap.delete(ckey);
              const cEl = root.querySelector(
                `.fud-bf-reaction-pill[data-fud-reaction-key="${CSS.escape(String(cand.rowKey))}"][data-fud-reaction-carrier="${CSS.escape(String(cand.carrierUuid))}"]`);
              if (cEl) restoreReactionPillButtons(cEl, root.querySelector(".fud-bf-card"));
              log(`GM reaction rollback also retracted derived pill: ${cand.carrierName} (${ckey})`);
            }
          }
          const pending = recountReactionPending();
          // Mirror every flip out, with the recounted lock, so a player watching
          // sees the GM's call on their own pill instead of a stale Apply button.
          try {
            const onlineNonPrimary = (game.users?.contents ?? []).filter((u) => u.active && u.id !== game.user?.id);
            for (const ch of changes) {
              director?.intentChannel?.broadcastMenuOpen({
                targetUserIds: onlineNonPrimary.map((u) => u.id),
                menuSpec: {
                  kind: "action-card-pill-update",
                  combatId: director.combatId,
                  rowKey: ch.rowKey, carrierUuid: ch.carrierUuid,
                  decision: ch.decision ?? "revert",
                  // ALWAYS true here — every change on this path came from a GM
                  // edit, including one that CLEARS an override back to a pill
                  // with no baseline. Sending `byGm` instead sent false for that
                  // case, and the mirror then took its in-flight-revert branch
                  // (restoreReactionPillToActionable), which only clears
                  // submitting flags: the player was left looking at a "Forced"
                  // chip with no buttons and a locked Confirm, unable to make the
                  // decision the GM had just handed back to them.
                  gm: true,
                  pendingCount: pending,
                },
              });
            }
          } catch (e) { warn("reconcileGmReactions: pill-update broadcast threw", e); }
          // Split, because the caller acts on them differently: a FORCE has to
          // derive its follow-up cascade, the others must not.
          return { total: changes.length, forced: changes.filter((c) => c.decision === "apply").length };
        };

        const applyGmEditPatch = async (patch, editor) => {
          // Drift guard, same as invoke: never edit a card the director has
          // already moved past (an F5 or a fast Confirm can retire it).
          const liveInst = director.ctx.actionResult?._instanceId ?? null;
          if (liveInst && cardInstanceId && liveInst !== cardInstanceId) {
            warn(`postActionCard: EDIT_CARD ignored — card ${cardInstanceId} is no longer the live action (live ${liveInst})`);
            return false;
          }
          if (resolved) return false;
          try {
            const next = mergeGmOverride(director.ctx.actionResult?.gmOverride ?? null, patch, editor);
            director.ctx.actionResult = freezeActionResult({
              ...director.ctx.actionResult,
              gmOverride: next,
            });
            // Keep the card's private snapshot in step with the slot, exactly as
            // the invoke path does — every later read on this card uses cardAr.
            cardAr = director.ctx.actionResult;
            // Reaction verdicts BEFORE the recompute: the recompute builds its
            // accepted list from the decision map, so reconciling afterwards
            // would preview the previous set and only correct itself on the next
            // edit. (gmDecidedKeys reads the slot, which is already updated.)
            //
            // `reopen` is read off the PATCH, not the merged bag — it is an
            // action and was deliberately never stored there.
            const rxChanges = reconcileGmReactions(next, readGmReopenKeys(patch));
            // A player's Apply derives follow-up reactions (Bullet Break after
            // Crossfire) via injectCascadeReactions; a GM force must do the same
            // or it skips a step of the very process the force is meant to run
            // in full. Convergence-guarded, so running it per edit is safe.
            if (rxChanges.forced > 0) {
              try { await injectCascadeReactions(); }
              catch (e) { warn("applyGmEditPatch: cascade inject after force threw", e); }
            }
            // Reuse the shared recompute: it re-derives through the same mutation
            // entrypoint (which now folds the GM layer in) and broadcasts the
            // delta to every other client. No separate GM-edit render path.
            await recomputeTargetPreviews().catch(() => {});
            log(`postActionCard: GM edit applied by ${editor?.userName ?? "GM"}`);
            return true;
          } catch (e) {
            warn("postActionCard: applyGmEditPatch threw", e);
            return false;
          }
        };

        // Host GM's own launch button. The context is read at CLICK time from
        // the live actionResult, not captured now, so the editor always opens on
        // the card's current numbers — including anything a reaction changed
        // since the card was posted.
        try {
          wireGmEditLaunch(root, () => gmEditContextFor(
            director.ctx.actionResult ?? cardAr, kind, null,
            // The host's LIVE candidates + their current verdicts — the live ar
            // carries neither (cardReactions is this closure's array, and the
            // decisions are in the map), so reading them off the ar would show
            // the GM an empty Reactions section on every card.
            gmEditReactionRows(cardReactions, (c) => reactionDecisionMap.get(`${c.rowKey}:${c.carrierUuid}`)),
            // The POST-mutation membership, so a creature the GM already added
            // opens as a real row with its own derived damage and defence
            // instead of a bare name the editor can only remove.
            lastTargetSurface),
            (patch) => applyGmEditPatch(patch, {
              userId: game.user?.id, userName: game.user?.name, at: Date.now(),
            }));
        } catch (e) { warn("postActionCard: GM edit launch wiring threw", e); }

        // Support-GM edits arriving over the socket. Re-armed after each patch so
        // a co-GM can make a run of edits, mirroring the invoke loop.
        const armEditAwait = () => {
          if (resolved) return;
          editAwait = director.intentChannel.awaitIntent(INTENTS.EDIT_CARD, {
            timeoutMs: 30 * 60 * 1000,
          });
          editAwait.then(async (intent) => {
            const fromUid = intent?.fromUserId ?? null;
            const sender = fromUid ? game.users?.get(fromUid) : null;
            // Authority check. EDIT_CARD is GM-only: the mirror renders the panel
            // for GMs alone, but the socket is not a trusted surface — a crafted
            // intent from a player client would otherwise rewrite the card.
            // RE-ARM FIRST, before doing any async work. applyGmEditPatch awaits
            // a full recompute (hundreds of ms), and a GM editing a card types
            // into several fields in quick succession — re-arming afterwards
            // leaves a window with no EDIT_CARD listener, and every patch that
            // lands in it is dropped. Measured: a damage edit immediately
            // followed by a hit-toggle silently lost the toggle.
            // applyGmEditPatch serialises internally (recomputeTargetPreviews
            // queues on _previewInFlight), so overlapping patches are safe.
            armEditAwait();
            if (!sender?.isGM) {
              warn(`postActionCard: EDIT_CARD REJECTED — sender ${sender?.name ?? fromUid} is not a GM`);
              return;
            }
            await applyGmEditPatch(intent?.body?.patch ?? {}, {
              userId: fromUid, userName: sender.name, at: Date.now(),
            });
          }).catch((e) => {
            if (!resolved) log(`postActionCard: EDIT_CARD await aborted (${e?.message})`);
          });
        };
        armEditAwait();

        // Spectator-HUD relay — a player/secondary-GM actor announces when they
        // OPEN or DISMISS (cancel) their invoke HUD, before committing. The GM
        // mirrors it to the rest of the table (and locally). Re-arm after each
        // so it survives multiple opens (e.g. Trait then Bond, or open/cancel/
        // re-open). Commit is handled by the INVOKE_CHOICE close above.
        const armHudOpenAwait = () => {
          if (resolved) return;
          hudOpenAwait = director.intentChannel.awaitIntent(INTENTS.INVOKE_HUD_OPEN, { timeoutMs: 30 * 60 * 1000 });
          hudOpenAwait.then((intent) => {
            const t = intent?.body?.type;
            if (t === "trait" || t === "bond") openSpectatorHud(t, intent.fromUserId ?? null);
            armHudOpenAwait();
          }).catch((e) => { if (!resolved) log(`postActionCard: INVOKE_HUD_OPEN await aborted (${e?.message})`); });
        };
        const armHudCloseAwait = () => {
          if (resolved) return;
          hudCloseAwait = director.intentChannel.awaitIntent(INTENTS.INVOKE_HUD_CLOSE, { timeoutMs: 30 * 60 * 1000 });
          hudCloseAwait.then((intent) => {
            closeSpectatorHud({ excludeUserId: intent.fromUserId ?? null, cancelled: true, type: intent?.body?.type ?? null });
            armHudCloseAwait();
          }).catch((e) => { if (!resolved) log(`postActionCard: INVOKE_HUD_CLOSE await aborted (${e?.message})`); });
        };
        // Live-selection echo relay — high-frequency, re-armed per event.
        const armHudSelectAwait = () => {
          if (resolved) return;
          hudSelectAwait = director.intentChannel.awaitIntent(INTENTS.INVOKE_HUD_SELECT, { timeoutMs: 30 * 60 * 1000 });
          hudSelectAwait.then((intent) => {
            const t = intent?.body?.type;
            if (t === "trait" || t === "bond") broadcastSpectatorSelect(t, intent?.body?.sel ?? null, intent.fromUserId ?? null);
            armHudSelectAwait();
          }).catch((e) => { if (!resolved) log(`postActionCard: INVOKE_HUD_SELECT await aborted (${e?.message})`); });
        };
        armHudOpenAwait();
        armHudCloseAwait();
        armHudSelectAwait();
      } catch (e) { warn("postActionCard: remote intent setup threw", e); }
    }

    const onClick = (ev) => {
      // ── Keyword / status chip → explanation tooltip ───────────────────────
      // Toggles a left-side panel with the term's rules text (from the static
      // keyword-registry). The click SFX is played by the delegated
      // director-ui-sfx listener (the chip carries [data-fud-kw]).
      const kwChip = ev.target?.closest?.("[data-fud-kw]");
      if (kwChip) {
        ev.stopPropagation();
        const key = kwChip.getAttribute("data-fud-kw");
        const entry = lookupTerm(key);
        if (entry) toggleKeywordTooltip({ key, entry, cardRoot: root });
        return;
      }

      // ── Invoke Trait / Bond ────────────────────────────────────────────────
      const invokeBtn = ev.target?.closest?.("[data-fud-invoke]");
      if (invokeBtn) {
        ev.stopPropagation();
        if (invokeBtn.classList.contains("is-locked")) {
          ui.notifications?.warn("Invoke cannot be used on a Fumble.");
          return;
        }
        if (invokeBtn.classList.contains("is-resolved")) {
          const t = invokeBtn.dataset.fudInvoke;
          ui.notifications?.warn(`${t === "trait" ? "Trait" : "Bond"} already invoked for this action.`);
          return;
        }
        const type = invokeBtn.dataset.fudInvoke;
        (async () => {
          try {
            // Stable import (no cache-bust) so singleton HUD state persists
            const hud = await import("./invoke/invoke-hud.js");
            // Toggle: re-clicking an open invoke HUD closes it instead of reopening
            if (hud.getActiveType() === type) {
              hud.dismissActive({ root, ar: cardAr });
              // Tear down the read-only mirror on the rest of the table too.
              closeSpectatorHud({ excludeUserId: game.user?.id, cancelled: true, type });
              return;
            }
            // Drift guard — same as the remote path: don't invoke on a card the
            // director has moved past (would target the wrong, now-live actor).
            const liveInst = director.ctx.actionResult?._instanceId ?? null;
            if (liveInst && cardInstanceId && liveInst !== cardInstanceId) {
              ui.notifications?.warn("This action is no longer active — invoke can't be applied.");
              return;
            }
            const worker = await import(`./invoke/invoke-worker.js?cb=${Date.now()}`);
            const ar = cardAr;
            const oldTotal = ar?.roll?.total ?? 0;
            // GM is the actor → open the read-only spectator HUD on everyone
            // else (exclude self; the GM gets the real interactive HUD below).
            // Fire-and-forget: the GM's own HUD shouldn't wait on the broadcast.
            openSpectatorHud(type, game.user?.id);
            // Echo the GM's own die/bond selection to the table as they pick.
            const onSel = (sel) => broadcastSpectatorSelect(type, sel, game.user?.id);
            let ok = false;      // truthy on success (trait: choice string, bond: true)
            if (type === "trait") {
              ok = await worker.handleInvokeTrait({ director, ar, root, invokeState, onSelectionChange: onSel });
            } else {
              ok = await worker.handleInvokeBond({ director, ar, root, invokeState, onSelectionChange: onSel });
            }
            // Sync the card snapshot with the worker's result before presenting.
            if (ok) cardAr = invokeState.lastAr ?? cardAr;
            // GM invoked on their own card.
            if (ok && type === "trait") {
              // Reroll: animate the GM's open HUD + broadcast so the table
              // animates in sync, then patch the card.
              await presentTraitReroll({ choice: ok, oldTotal });
            } else if (ok) {
              // Bond: flat bonus, no animation — patch all mirrors + close spectators.
              broadcastInvokeUpdate();
              closeSpectatorHud({ excludeUserId: game.user?.id, type: "bond" });
            } else {
              closeSpectatorHud({ excludeUserId: game.user?.id, cancelled: true, type });
            }
          } catch (e) {
            warn("postActionCard: invoke handler threw", e);
            ui.notifications?.error("Invoke failed (see console).");
          }
        })();
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
          updateEquipFreeIndicator(root);
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

      // Transform form-chip clicks (Equipment card) — shared with the mirror.
      const formChip = ev.target?.closest?.(".fud-bf-form-chip");
      if (formChip) {
        ev.stopPropagation();
        handleFormChipClick(root, formChip);
        updateEquipFreeIndicator(root);
        return;
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
      // Transform form picks — { main, off } → formIndex (shared collector).
      const wf = collectWeaponFormSelections(root);
      if (wf) extras.weaponFormSelections = wf;
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
    // Initial economy indicator (Equipment card only; no-op otherwise).
    try { updateEquipFreeIndicator(root); } catch {}

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
      // Don't steal keys while the user is typing in an input field, textarea,
      // <select>, or any contenteditable surface (chat box, sheet fields, etc.).
      const ae = document.activeElement;
      if (ae) {
        const tag = ae.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ae.isContentEditable) return;
      }
      if (ev.key === "Enter") { ev.preventDefault(); finish("confirm"); }
    };
    window.addEventListener("keydown", keyListener, true);

    // Hide the card ONLY while a picker/menu overlay (target-picker banner,
    // list-picker menu) is genuinely on-screen. The pickers broadcast open/close
    // hooks; we ref-count so overlapping/nested picks keep the card hidden until
    // the LAST one closes. This replaces the old pattern of speculatively hiding
    // the card around every recompute — which faded it out-and-back-in even when
    // no picker ever appeared. Remote picks render on the player's client and
    // fire the hooks there, so the GM card correctly stays visible.
    let _pickDepth = 0;
    const onPickerOpen = () => {
      _pickDepth += 1;
      root.classList.add("is-hidden-during-pick");
    };
    const onPickerClose = () => {
      _pickDepth = Math.max(0, _pickDepth - 1);
      if (_pickDepth === 0) root.classList.remove("is-hidden-during-pick");
    };
    Hooks.on("fud.actionPickerOpen", onPickerOpen);
    Hooks.on("fud.actionPickerClose", onPickerClose);

    const cleanup = () => {
      try { Hooks.off("fud.actionPickerOpen", onPickerOpen); } catch {}
      try { Hooks.off("fud.actionPickerClose", onPickerClose); } catch {}
      try { clearTimeout(despawnTid); } catch {}
      try { window.removeEventListener("keydown", keyListener, true); } catch {}
      try { hideDescTip(); } catch {}
      try { descTip?.remove(); } catch {}
      try { dismissKeywordTooltip(); } catch {}
      try { root.remove(); } catch {}
      _overlays.delete(director.combatId);
      if (!resolved) {
        resolved = true;
        resolve({ confirmed: false, cancelled: true });
      }
    };

    _overlays.set(director.combatId, { cleanup, root });

    // ── Summon Autopilot: auto-confirm after a veto window ───────────────────
    // The card is live and fully wired, so we resolve it through the SAME
    // finish("confirm") path a human click takes — reaction snapshot, mirror
    // close and despawn all run identically.
    //
    // Three rules make this safe to leave running unattended:
    //   1. PAUSE while any ask-mode reaction pill is undecided. Confirm is
    //      CSS-locked in that state, and a countdown that expired behind the
    //      lock would confirm an action whose reactions nobody answered.
    //   2. VETO on the first sign of a human — pointerdown anywhere on the card
    //      (which covers every button and every reaction pill), any keypress, or
    //      a picker opening. Cancelling is permanent: the card is theirs now.
    //   3. NEVER in a sim. SimMode owns the confirm below; two timers racing on
    //      one card would double-finish (harmless — finish() is idempotent — but
    //      it would confirm before the sim's reaction brain had decided).
    const vetoEl = payload?.autoConfirm ? root.querySelector(".fud-bf-veto") : null;
    if (vetoEl && !SimMode.active) {
      const totalMs = Math.max(0, Number(payload.autoConfirm.ms) || 0);
      const cardEl = root.querySelector(".fud-bf-card");
      const countEl = vetoEl.querySelector(".fud-bf-veto-count");
      // A veto is per-TURN, not per-card. A multi-pass action posts one card per
      // pass and a reload re-enters CONFIRM with a fresh card, so a hold that
      // lived only in this closure evaporated exactly when the GM had just said
      // "I am driving this one". The director ctx outlives the card, so record
      // the hold there and let CONFIRM refuse to re-arm for the same turn.
      const vetoKey = payload.autoConfirm.turnKey ?? null;
      // WALL-CLOCK deadline, not a tick count. Chromium throttles timers in a
      // backgrounded window (a 100ms interval degrades toward 1/second), so
      // counting ticks stretched a 5s window into 12s+ whenever the GM tabbed
      // away — measured, not theorised. A deadline fires on the first tick past
      // the mark instead, which is exact while the window is visible and at
      // worst ~1s late while it is not.
      let deadline = performance.now() + totalMs;
      let lastTick = performance.now();
      let tickTid = null;
      let vetoed = false;

      const stopVeto = (reason) => {
        if (vetoed) return;
        vetoed = true;
        try { clearInterval(tickTid); } catch {}
        tickTid = null;
        try {
          vetoEl.classList.add("is-vetoed");
          if (countEl) countEl.textContent = "held — confirm when ready";
        } catch {}
        // Persist the hold for the rest of this turn (multi-pass + reload).
        try { if (vetoKey && director?.ctx) director.ctx.summonVetoHeldTurn = vetoKey; } catch {}
        log(`action-card: summon auto-confirm vetoed (${reason})`);
      };

      const onHumanTouch = () => stopVeto("user interaction");
      // Typing is not "taking the card". The card's own Enter-to-confirm
      // listener already ignores keys aimed at an input surface; without the
      // same guard, a GM writing a line of chat silently held the summon's card
      // and the table waited on someone who was doing something else.
      const onHumanKey = (ev) => {
        const ae = document.activeElement;
        if (ae) {
          const tag = ae.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ae.isContentEditable) return;
        }
        stopVeto(`keypress ${ev?.key ?? "?"}`);
      };
      root.addEventListener("pointerdown", onHumanTouch, true);
      window.addEventListener("keydown", onHumanKey, true);
      Hooks.on("fud.actionPickerOpen", onHumanTouch);
      const dropVetoListeners = () => {
        try { clearInterval(tickTid); } catch {}
        tickTid = null;
        try { root.removeEventListener("pointerdown", onHumanTouch, true); } catch {}
        try { window.removeEventListener("keydown", onHumanKey, true); } catch {}
        try { Hooks.off("fud.actionPickerOpen", onHumanTouch); } catch {}
      };

      const TICK_MS = 100;
      tickTid = setInterval(() => {
        // `resolved` covers the card ending by ANY route — a human Confirm, a
        // Cancel, a despawn. Drop the window listeners with it: they are global
        // (window keydown + a Hook), so one leaked pair per card means every
        // later keystroke in Foundry runs N dead handlers holding N detached
        // card DOMs alive.
        if (resolved || vetoed) { dropVetoListeners(); return; }
        const now = performance.now();
        const sinceLast = now - lastTick;
        lastTick = now;
        // Rule 1 — a pending third-party reaction freezes both the bar (CSS) and
        // the clock (here), so the two never disagree about how long is left.
        // Pushing the deadline out by the elapsed slice is what "pause" means on
        // a wall clock: time spent waiting is not time spent counting down.
        if (cardEl?.hasAttribute("data-fud-reactions-pending")) {
          deadline += sinceLast;
          if (countEl) countEl.textContent = "waiting on reactions";
          return;
        }
        const remaining = deadline - now;
        if (remaining > 0) {
          // Kept SHORT on purpose: the strip is now on every summon card (the
          // switch ships on), and the card is height-budgeted against the
          // viewport — a label that wraps to two lines costs ~18px on every one
          // of them. "Confirm" is the button right below; it needs no caption.
          if (countEl) countEl.textContent = `${Math.ceil(remaining / 1000)}s · click to hold`;
          return;
        }
        dropVetoListeners();
        log("action-card: summon auto-confirm fired");
        try { finish("confirm"); }
        catch (e) { warn("action-card: summon auto-confirm threw — card stays open for a manual confirm", e); }
      }, TICK_MS);

      // Belt and braces: the tick above drops the listeners on the next beat
      // after any resolution, and the overlay cleanup drops them immediately if
      // the card is despawned out from under us.
      const priorCleanup = _overlays.get(director.combatId)?.cleanup;
      _overlays.set(director.combatId, {
        root,
        cleanup: () => {
          dropVetoListeners();
          try { priorCleanup?.(); } catch {}
        },
      });
    }

    // ── Sim harness: nobody is at the keyboard ───────────────────────────────
    // The card is fully built and wired at this point, so we resolve it through
    // the SAME `finish("confirm")` path a human click takes — the reaction-pill
    // snapshot, the mirror-close broadcast and the despawn all run identically.
    // Undecided ask-mode pills snapshot as "skip" (snapshotReactionDecisions'
    // default), so this cannot deadlock on a pending pill; whether ask-mode
    // reactions fire at all is the run's `reactions` policy, applied upstream via
    // __FU_HARNESS_ACCEPT_PASSIVES__. Dwell is the run's pace (0 on batch).
    if (SimMode.active) {
      (async () => {
        // Decide the ask-mode reactions BEFORE confirming. This is the difference
        // between a party that defends itself and one that doesn't: Protect,
        // Prophetic Defender and Keren's damage riders are all ask-mode pills, and
        // an undecided pill snapshots as "skip" — so without this the party simply
        // never reacts. Decisions go through recordPillDecision, the SAME path a
        // human click takes, so the mutation pipeline (redirect subjects, costs,
        // re-render) runs for real.
        // INVOKE first — a Fabula Point can turn this miss into a hit, and it has to
        // happen BEFORE the reaction pills are decided so the damage riders see the
        // final hit/miss state rather than the pre-invoke one.
        try {
          const attackerActor = director.dCombat?.combatants
            ?.find((c) => c.tokenUuid === cardAr?.attacker?.tokenUuid)?.actorDoc
            ?? (cardAr?.attackerActorRef ? await fromUuid(cardAr.attackerActorRef).catch(() => null) : null);

          const invoked = await simInvoke({ director, ar: cardAr, root, invokeState, attackerActor });
          if (invoked) cardAr = invokeState.lastAr ?? cardAr;
        } catch (e) {
          warn("[SIM] invoke brain threw — carrying on", e);
        }

        try {
          // Safety net for element menus: any augment that lets the caster pick a
          // damage type opens one, and an unhinted picker takes option ONE. That is
          // how Keren fired Fire into an Inferex that absorbs it. Named policies
          // hint the right element; this covers the augments nobody has written a
          // policy for yet.
          SimMode.setElementFallback(bestElementForCard(cardAr, director));

          const decisions = decideReactions({
            cardReactions,
            ar: cardAr,
            director,
            decided: new Set(reactionDecisionMap.keys()),
          });
          for (const d of decisions) {
            if (d.hint) SimMode.setPickHint(d.hint);   // WHICH ally to cover
            await recordPillDecision(d.rowKey, d.carrierUuid, d.decision);
          }
        } catch (e) {
          warn("[SIM] reaction brain threw — confirming without reactions", e);
        } finally {
          SimMode.setElementFallback(null);   // card-scoped; don't leak to the next
        }

        // Dwell AFTER the pills resolve, so at "watch" pace you can actually read
        // the card in the state it will resolve in (reactions applied).
        const dwell = SimMode.cardDwellMs();
        if (dwell > 0) await new Promise((r) => setTimeout(r, dwell));

        try { finish("confirm"); }
        catch (e) { warn("[SIM] auto-confirm threw — card may hang", e); }
      })();
    }
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

// How long the owner's mirror waits after clicking a reaction Apply/Skip for
// the GM to acknowledge the click before assuming the message was lost (dropped
// socket / GM not listening). On timeout the pill is restored to actionable so
// the player can retry instead of being stuck on a dimmed button until they
// refresh. The GM sends an "ack" pill-update the instant it receives the click
// (BEFORE running any secondary picker), so a legitimately slow resolution —
// e.g. the player is still choosing a Protect target — does NOT trip this.
const REACTION_SUBMIT_TIMEOUT_MS = 8000;
// After the GM acks a Confirm/Cancel it normally follows with the card-close that
// tears the player's mirror down. If the host dies / refreshes MID-processing, that
// close never arrives — so the ack re-arms this longer completion fallback (instead
// of standing the safety net down entirely) to restore the buttons for a retry.
const CONFIRM_COMPLETION_TIMEOUT_MS = 20000;

// Restore a reaction pill from its in-flight "submitting" state back to
// actionable (pending, buttons live). Shared by the GM-broadcast "revert" path
// and the client-side no-response timeout. Also clears any pending retry timer.
function restoreReactionPillToActionable(pillEl) {
  if (!pillEl) return;
  if (pillEl._fudSubmitTimer) {
    try { clearTimeout(pillEl._fudSubmitTimer); } catch {}
    pillEl._fudSubmitTimer = null;
  }
  pillEl.dataset.fudReactionPending = "1";
  delete pillEl.dataset.fudReactionSubmitting;
  pillEl.classList.remove("is-submitting");
}

// Clear a pill's retry timer once the GM has responded (ack / final state).
function clearReactionPillTimer(pillEl) {
  if (pillEl?._fudSubmitTimer) {
    try { clearTimeout(pillEl._fudSubmitTimer); } catch {}
    pillEl._fudSubmitTimer = null;
  }
}

// Flip a reaction pill to its terminal resolved state (Applied / Skipped) in the
// local DOM. Shared by the GM's pill-update broadcast handler AND the player-side
// OPTIMISTIC skip — so a Skip reads as resolved instantly on slow links instead of
// waiting two socket hops (click → GM, GM → echo) for the visual flip. Idempotent:
// re-running with the same decision is a no-op (the actions block is already gone,
// so the selector no longer matches and the classes are already set). `pendingCount`
// SETS the card counter when the GM supplies its authoritative value; omitted (the
// optimistic path) it decrements the local counter by one.
function resolveReactionPillDom(pillEl, cardEl, decision, { pendingCount = null, gm = false } = {}) {
  if (!pillEl) return;
  clearReactionPillTimer(pillEl);
  // This rewrites the status slot, so any "restore me later" stash the
  // moot-pill patcher left is now describing a state two verdicts old. The
  // patcher also refuses to restore a slot it did not write (it tags its own
  // chip), so this is the second of two guards — but a stash nobody can use is
  // a trap left lying around, and clearing it at the rewrite is the honest half.
  delete pillEl.dataset.fudReactionMootPrev;
  delete pillEl.dataset.fudReactionSubmitting;
  delete pillEl.dataset.fudReactionAckPending;
  pillEl.classList.remove("is-submitting", "is-applied", "is-skipped", "is-gm-set");
  pillEl.dataset.fudReactionPending = "0";
  pillEl.classList.add("is-resolved", decision === "apply" ? "is-applied" : "is-skipped");
  // A GM's manual verdict is labelled for what it is. "Applied" on a pill the
  // player never touched — or on one they explicitly Skipped — reads as their
  // own decision, and hides the fact that the card was overruled at the table.
  if (gm) pillEl.classList.add("is-gm-set");
  const label = gm
    ? (decision === "apply" ? "Forced" : "Suppressed")
    : (decision === "apply" ? "Applied" : "Skipped");
  // Replace whatever's in the actions slot ("Waiting for…" chip on a non-owner
  // mirror; Apply/Skip buttons on the owner's) with the final status chip. An
  // is-auto pill has neither — it carries a plain status chip — so that is
  // matched too, or a suppressed auto reaction would go on saying "Active".
  const actions = pillEl.querySelector(".fud-bf-reaction-actions, .fud-bf-reaction-status");
  if (actions) {
    actions.outerHTML = `<span class="fud-bf-reaction-status">${label}</span>`;
  }
  if (cardEl) {
    // Explicit pendingCount (authoritative GM broadcast) wins verbatim. Otherwise
    // (local optimistic skip) only a third-party gating pill moves the counter —
    // the owner's own reactions never contributed to the Confirm lock.
    const cur = Number(cardEl.dataset.fudReactionsPending ?? 0);
    const gates = pillEl.dataset.fudReactionGating === "1";
    const next = pendingCount != null
      ? Math.max(0, Number(pendingCount))
      : (gates ? Math.max(0, cur - 1) : cur);
    if (next > 0) cardEl.dataset.fudReactionsPending = String(next);
    else delete cardEl.dataset.fudReactionsPending;
  }
}

// Roll an OPTIMISTICALLY-resolved pill back to its actionable state, rebuilding the
// Apply/Skip controls the optimistic commit replaced with a status chip. Used only
// by the no-response net: the host never acknowledged the click (dropped socket), so
// we restore the buttons (the delegated click handler lives on the card wrapper, so
// fresh buttons work without rebinding) and re-bump the card's pending counter the
// optimistic commit had decremented.
function restoreReactionPillButtons(pillEl, cardEl) {
  if (!pillEl) return;
  clearReactionPillTimer(pillEl);
  delete pillEl.dataset.fudReactionSubmitting;
  delete pillEl.dataset.fudReactionAckPending;
  // `is-auto` / `is-gm-set` too: the GM can send an auto-fired `on`/`force` pill
  // back to undecided, and it must then LOOK like the decision it now is —
  // an ask pill with live buttons, not an "Active" chip wearing buttons. Both
  // classes are absent on the optimistic-rollback path this is shared with, so
  // removing them there is a no-op.
  pillEl.classList.remove("is-submitting", "is-resolved", "is-applied", "is-skipped", "is-auto", "is-gm-set");
  pillEl.classList.add("is-ask");
  pillEl.dataset.fudReactionPending = "1";
  const status = pillEl.querySelector(".fud-bf-reaction-status");
  if (status) {
    status.outerHTML =
      `<div class="fud-bf-reaction-actions">` +
      `<div class="fud-btn fud-btn-reaction fud-btn-reaction-apply" data-fud-reaction-action="apply" role="button" tabindex="0">Apply</div>` +
      `<div class="fud-btn fud-btn-reaction fud-btn-reaction-skip" data-fud-reaction-action="skip" role="button" tabindex="0">Skip</div>` +
      `</div>`;
  }
  if (cardEl && pillEl.dataset.fudReactionGating === "1") {
    // Symmetric with the optimistic-skip decrement: only third-party gating pills
    // ever moved the Confirm-lock counter, so only they re-bump it on rollback.
    const cur = Number(cardEl.dataset.fudReactionsPending ?? 0);
    cardEl.dataset.fudReactionsPending = String(cur + 1);
  }
}

// Clear the no-response retry timer(s) on invoke buttons once the GM's reroll /
// invoke-update broadcast lands. `type` ("trait"|"bond") narrows it; omitted
// clears both. Invoke needs no GM ack: the player commits all choices in their
// local HUD before emitting, so the GM resolves immediately and the success
// broadcast always beats the timeout.
function clearInvokeSubmitTimers(wrapper, type = null) {
  if (!wrapper) return;
  const sel = type ? `[data-fud-invoke="${type}"]` : "[data-fud-invoke]";
  for (const btn of wrapper.querySelectorAll(sel)) {
    if (btn._fudInvokeTimer) {
      try { clearTimeout(btn._fudInvokeTimer); } catch {}
      btn._fudInvokeTimer = null;
    }
  }
}

// Arm the no-response net on an invoke button: after the player commits and
// emits INVOKE_CHOICE the button locks ("is-resolved"); if the GM's reroll /
// invoke-update never comes back, restore it so the player can retry instead of
// being stuck on a locked button.
function armInvokeSubmitTimer(invokeBtn, type) {
  if (!invokeBtn) return;
  if (invokeBtn._fudInvokeTimer) { try { clearTimeout(invokeBtn._fudInvokeTimer); } catch {} }
  invokeBtn._fudInvokeTimer = setTimeout(() => {
    invokeBtn._fudInvokeTimer = null;
    if (!invokeBtn.isConnected) return;
    if (!invokeBtn.classList.contains("is-resolved")) return;
    invokeBtn.classList.remove("is-resolved");
    try { ui.notifications?.warn(`No response from the host — try invoking ${type === "trait" ? "the Trait" : "the Bond"} again.`); } catch {}
  }, REACTION_SUBMIT_TIMEOUT_MS);
}

function cleanupMirror() {
  if (_mirrorCleanup) {
    try { _mirrorCleanup(); } catch {}
    _mirrorCleanup = null;
  }
  try { dismissKeywordTooltip(); } catch {}
  // Any read-only spectator invoke HUD belongs to this card — tear it down too
  // (no-ops if none is up). Covers card replace AND card close.
  import("./invoke/invoke-hud.js").then((hud) => hud.dismissSpectator({ cancelled: true })).catch(() => {});
  const existing = document.getElementById(MIRROR_ROOT_ID);
  // Stand down any pending Confirm/Cancel no-response timer so a card close/replace
  // can't fire a stray "tap again" toast after the mirror is gone.
  if (existing?._fudConfirmTimer) { try { clearTimeout(existing._fudConfirmTimer); } catch {} existing._fudConfirmTimer = null; }
  if (existing) try { existing.remove(); } catch {}
}

export function registerPlayerActionCardHandler(channel, isActiveDirector = () => false) {
  // Per-card closures — reset each time a new "action-card" MENU_OPEN arrives.
  // playerAr holds the serialized actionResult broadcast with the card so the
  // player can show the invoke HUD without accessing GM-only director state.
  let playerAr = null;
  // Host-authoritative GM override state, refreshed by every recompute delta.
  // A support GM edits from THESE, never from the card-post payload — see the
  // gmOverrideBag note on the delta.
  let playerGmOverride = undefined;
  let playerGmReactions = null;
  // Post-mutation target membership shipped by the host's delta — see
  // `gmTargetSurface`. Null until the first recompute reaches this client.
  let playerGmTargets = null;
  let playerInvokeState = { trait: false, bond: false };

  // Invoke-update handler — GM calls this after processing an INVOKE_CHOICE
  // so the player's mirror card reflects the new roll/damage/target results.
  const offInvokeUpdate = channel.onMenuOpen((menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "action-card-invoke-update") return;
    playerAr = menuSpec.actionResult ?? playerAr;
    playerInvokeState = menuSpec.invokeState ?? playerInvokeState;
    const wrapper = document.getElementById(MIRROR_ROOT_ID);
    if (!wrapper) return;
    clearInvokeSubmitTimers(wrapper); // GM responded — stop the no-response net
    import(`./invoke/invoke-worker.js?cb=${Date.now()}`).then((w) => {
      w.patchCardDom(wrapper, playerAr, playerInvokeState);
    }).catch((e) => warn("action-card-invoke-update: patchCardDom threw", e));
  });

  // Spectator invoke HUD — the GM broadcasts this while the ACTOR is deciding
  // so this client sees the dimmer + aura + panel read-only (no interaction).
  // Positioned next to the local mirror card; torn down by the matching
  // MENU_CLOSE (kind "invoke-hud-spectator") below, by cleanupMirror on card
  // close, or superseded by a later spectator open.
  const offSpectatorOpen = channel.onMenuOpen((menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "invoke-hud-spectator") return;
    const spec = menuSpec.spec;
    if (!spec?.type) return;
    const wrapper = document.getElementById(MIRROR_ROOT_ID);
    import("./invoke/invoke-hud.js").then((hud) => {
      if (spec.type === "trait") {
        hud.showTraitSpectator({ roll: spec.roll, actorName: spec.actorName, root: wrapper, tokenUuid: spec.tokenUuid });
      } else {
        hud.showBondSpectator({ bonds: spec.bonds, actorName: spec.actorName, root: wrapper, tokenUuid: spec.tokenUuid });
      }
    }).catch((e) => warn("invoke-hud-spectator open threw", e));
  });

  const offSpectatorClose = channel.onMenuClose((payload) => {
    if (payload?.kind !== "invoke-hud-spectator") return;
    const { traitOutcome = null, cancelled = false, expectKind = null } = payload?.data ?? {};
    import("./invoke/invoke-hud.js").then((hud) => hud.dismissSpectator({ traitOutcome, cancelled, expectKind })).catch(() => {});
  });

  // Trait reroll (Phase 3) — animate the dice on this client's open invoke HUD
  // (real owner HUD or spectator HUD), THEN patch the local mirror card, THEN
  // play the up/down chime. Mirrors the GM's local presentTraitReroll so the
  // reveal order is identical everywhere. If no HUD is up (latecomer), the
  // animation no-ops and we just patch the card.
  const offTraitReroll = channel.onMenuOpen((menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "invoke-trait-reroll") return;
    if (isActiveDirector()) return; // GM presents locally; never via its own (non-echoing) broadcast
    playerAr = menuSpec.actionResult ?? playerAr;
    playerInvokeState = menuSpec.invokeState ?? playerInvokeState;
    // GM responded — stop the no-response net before the (slower) reroll animation.
    clearInvokeSubmitTimers(document.getElementById(MIRROR_ROOT_ID));
    const r = menuSpec.roll ?? {};
    (async () => {
      try {
        const hud = await import("./invoke/invoke-hud.js");
        await hud.animateInvokeReroll({ choice: menuSpec.choice, rA: r.rA, rB: r.rB, dA: r.dA, dB: r.dB, intense: !!menuSpec.intense });
        const wrapper = document.getElementById(MIRROR_ROOT_ID);
        if (wrapper) {
          const w = await import(`./invoke/invoke-worker.js?cb=${Date.now()}`);
          w.patchCardDom(wrapper, playerAr, playerInvokeState);
        }
        hud.playTraitResultChime(menuSpec.oldTotal, r.total);
        // NOTE: the crit cut-in is fired ONCE by the GM (presentTraitReroll) and
        // socket-broadcast to every client, so we must NOT call it here too.
      } catch (e) { warn("invoke-trait-reroll receiver threw", e); }
    })();
  });

  // Live-selection echo (Phase 2) — in-place patch of the read-only spectator
  // HUD as the actor toggles dice / navigates bonds. No-ops if no spectator
  // HUD (of the matching kind) is up on this client.
  const offSpectatorSelect = channel.onMenuPatch((patch) => {
    if (!patch || patch.kind !== "invoke-hud-spectator-select") return;
    import("./invoke/invoke-hud.js").then((hud) => {
      if (patch.type === "trait") hud.applyTraitSpectatorSelection(patch.sel ?? {});
      else hud.applyBondSpectatorSelection(patch.sel ?? {});
    }).catch(() => {});
  });

  // Lightweight patch handler for pill state changes broadcast from
  // recordPillDecision (GM side). Applies the same DOM transformation
  // — pending → resolved + status chip — to the local mirror so the
  // observer sees Applied/Skipped flip in real time instead of staying
  // frozen on initial render.
  // Card target-mutation handler — propagates GM-side redirect (or
  // future card-mutation kinds) to the local mirror. Single patching
  // function shared with GM so visuals can't diverge.
  const offTargetMutation = channel.onMenuOpen((menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "action-card-target-mutation") return;
    const wrapper = document.getElementById(MIRROR_ROOT_ID);
    if (!wrapper) return;
    // Track the host's CURRENT override state before painting. A support GM's
    // editor reads these; stale, its Save (a wholesale replace) wipes whatever
    // the host has set since this card was posted.
    if (menuSpec.delta?.gmOverrideBag !== undefined) playerGmOverride = menuSpec.delta.gmOverrideBag;
    if (Array.isArray(menuSpec.delta?.gmEditReactions)) playerGmReactions = menuSpec.delta.gmEditReactions;
    // `!== undefined`, matching gmOverrideBag above: a delta carrying an explicit
    // `null` (a recompute that early-returned, or a cancelled mutation) must
    // CLEAR the surface, not leave the previous pass's membership standing for a
    // support GM to merge into a current editor.
    if (menuSpec.delta?.gmTargetSurface !== undefined) playerGmTargets = menuSpec.delta.gmTargetSurface;
    try {
      applyCardTargetMutationDelta(wrapper, menuSpec.delta);
    } catch (e) { warn("action-card-target-mutation: patch threw", e); }
  });

  const offPillUpdate = channel.onMenuOpen((menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "action-card-pill-update") return;
    const wrapper = document.getElementById(MIRROR_ROOT_ID);
    if (!wrapper) return;
    const cardEl = wrapper.querySelector(".fud-bf-card");
    const pillEl = wrapper.querySelector(
      `.fud-bf-reaction-pill[data-fud-reaction-key="${CSS.escape(String(menuSpec.rowKey ?? ""))}"][data-fud-reaction-carrier="${CSS.escape(String(menuSpec.carrierUuid ?? ""))}"]`
    );
    if (!pillEl) return;
    // "ack" — the GM received the click and is resolving it (possibly awaiting a
    // secondary pick on this client). Cancel the no-response retry timer but keep
    // the pill submitting; the final Applied/Skipped/revert follows. Also clear
    // the optimistic-skip ack flag so its no-response net stands down — the host
    // has the click, so the locally-resolved Skipped state is confirmed.
    if (menuSpec.decision === "ack") {
      clearReactionPillTimer(pillEl);
      delete pillEl.dataset.fudReactionAckPending;
      return;
    }
    // The GM responded — stop the retry timer regardless of outcome.
    clearReactionPillTimer(pillEl);
    // "revert" — the owner's secondary pick was cancelled; restore the pill to
    // its actionable (pending) state so they can click Apply/Skip again. The
    // Apply/Skip buttons were left in place during "submitting", so we only
    // clear the in-flight flags. (Skip never reverts — it opens no picker — so a
    // revert always lands on an apply-path pill whose buttons are intact.)
    if (menuSpec.decision === "revert") {
      // A GM CLEARING a manual verdict is a different revert: the pill is not
      // mid-flight, it is sitting on a status chip this client painted from the
      // GM's earlier force/suppress. Rebuild its controls (and take the host's
      // recounted lock) so it goes back to being the player's decision to make.
      if (menuSpec.gm) {
        restoreReactionPillButtons(pillEl, cardEl);
        if (cardEl) {
          const n = Math.max(0, Number(menuSpec.pendingCount ?? 0));
          if (n > 0) cardEl.dataset.fudReactionsPending = String(n);
          else delete cardEl.dataset.fudReactionsPending;
        }
        return;
      }
      restoreReactionPillToActionable(pillEl);
      return;
    }
    // Final state — flip to resolved using the GM's authoritative pending count.
    // For a pill the owner already resolved optimistically (Skip) this is an
    // idempotent confirm; for every other mirror it's the first resolution.
    const decision = menuSpec.decision === "apply" ? "apply" : "skip";
    resolveReactionPillDom(pillEl, cardEl, decision,
      { pendingCount: menuSpec.pendingCount ?? 0, gm: !!menuSpec.gm });
  });

  // Card body re-render handler — propagates a GM-side full-body rebuild
  // (Potion Rain heal-spread, future result mutations) to the local mirror so
  // the headline + per-target rows update together. Header/pills/buttons are
  // left untouched (siblings of `.fud-bf-body`), preserving mirror pill state.
  const offBodyUpdate = channel.onMenuOpen((menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "action-card-body-update") return;
    const wrapper = document.getElementById(MIRROR_ROOT_ID);
    if (!wrapper || !menuSpec.bodyHtml) return;
    const bodyEl = wrapper.querySelector(".fud-bf-body");
    if (bodyEl) bodyEl.innerHTML = menuSpec.bodyHtml;
  });

  // Confirm/Cancel ack — the GM received our Confirm/Cancel intent and is running
  // the action. Stand down the no-response retry timer; the card-close broadcast
  // that follows tears the mirror down. Symmetric with offPillUpdate's "ack".
  const offConfirmAck = channel.onMenuOpen((menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "action-card-confirm-ack") return;
    const wrapper = document.getElementById(MIRROR_ROOT_ID);
    if (!wrapper) return;
    const action = wrapper.dataset.fudConfirmSubmitting;
    if (!action) return; // nothing pending to reconcile
    // DON'T stand the safety net down entirely: the ack means the GM received our
    // click, but if the host dies / refreshes mid-processing the card-close never
    // arrives and the greyed buttons would stay stuck forever. Swap the short
    // no-response timer for a longer COMPLETION fallback that restores the buttons
    // (retryable) if the close doesn't come. The normal card-close disconnects this
    // wrapper first, so the fallback then bails harmlessly on !isConnected.
    if (wrapper._fudConfirmTimer) { try { clearTimeout(wrapper._fudConfirmTimer); } catch {} }
    wrapper._fudConfirmTimer = setTimeout(() => {
      wrapper._fudConfirmTimer = null;
      if (!wrapper.isConnected) return;
      if (wrapper.dataset.fudConfirmSubmitting !== action) return; // superseded / closed
      delete wrapper.dataset.fudConfirmSubmitting;
      for (const b of wrapper.querySelectorAll(".fud-btn")) b.classList.remove("is-resolved");
      try { ui.notifications?.warn("The host hasn't finished this action — tap the button again."); } catch {}
    }, CONFIRM_COMPLETION_TIMEOUT_MS);
  });

  const offOpen = channel.onMenuOpen((menuSpec) => {
    if (!menuSpec || menuSpec.kind !== "action-card") return;
    // Primary GM renders the card locally in postActionCard; skip the mirror
    // so there's no duplicate card on the director's own client.
    if (isActiveDirector()) return;
    // Resolve the card HTML — either shipped verbatim (Equipment / Item / unknown
    // kind) or re-derived LOCALLY from the compact render payload via the SAME
    // builders + template the GM used (Attack / Skill / Guard / Study / Hinder).
    // Local render keeps the heavy rendered HTML off the wire for the common
    // in-combat cards — the main slow-client win.
    let cardHtml = menuSpec.html ?? null;
    if (!cardHtml && menuSpec.renderPayload) {
      try {
        const built = composeActionCardObject({ kind: menuSpec.cardKind, payload: menuSpec.renderPayload });
        if (built) {
          const { root } = assembleActionCardRoot({
            card: built,
            cardReactions: menuSpec.renderPayload.cardReactions,
            rootId: ROOT_ID,
            payload: menuSpec.renderPayload,
            kind: menuSpec.cardKind,
          });
          cardHtml = root.outerHTML;
        }
      } catch (e) { warn("action-card MENU_OPEN: local render threw", e); }
    }
    if (!cardHtml) {
      warn("action-card MENU_OPEN: no html and no renderPayload to render");
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

    // Reset per-card state for the new card.
    playerAr = menuSpec.actionResult ?? null;
    playerGmOverride = undefined;
    playerGmReactions = null;
    playerGmTargets = null;
    playerInvokeState = { trait: false, bond: false };

    // Build a wrapper so we can hold both the imported HTML and the
    // event handlers. The imported HTML preserves the original DOM ids
    // (e.g. "fud-bf-action-card-root") so styles attach correctly.
    const wrapper = document.createElement("div");
    wrapper.id = MIRROR_ROOT_ID;
    wrapper.innerHTML = cardHtml;
    document.body.appendChild(wrapper);

    // Permission gate. Two layers:
    //  • Card-level (action-taker) — `isInteractive` gates the acting actor's
    //    own buttons (Confirm / Cancel / Invoke / equipment / item). The player
    //    owner OR a secondary GM (an active GM client that isn't the primary
    //    director) gets these; secondary GMs route actions back to the primary
    //    GM via socket intents just like a player owner would.
    //  • Per-pill (reactor) — each reaction's Apply/Skip is gated by the
    //    reactor's owner (`myUserId`), so a player applies ONLY pills carried
    //    by a creature THEY own, even when the GM or another player owns the
    //    action being reacted to. See [[director-player-driven-input]].
    const isPlayerOwner = !!(menuSpec.ownerUserId && menuSpec.ownerUserId === game.user?.id);
    const isSecondaryGm = !!(game.user?.isGM && !isActiveDirector());
    const isInteractive = isPlayerOwner || isSecondaryGm;
    const myUserId = game.user?.id ?? null;
    const card = wrapper.querySelector(".fud-bf-card");

    if (!isInteractive && card) {
      // Visually mark the card as read-only — also disables click via
      // event guard below. The class is purely informational; the real
      // gate is the event listener.
      card.classList.add("is-readonly-mirror");
      // No "Observing" banner — non-owners may still own a reaction pill
      // on this card, so we don't pre-label it as passive.

      // Hide the action buttons (Confirm / Cancel / Invoke / status grid)
      // entirely for non-owner observers — they can't act on the action
      // itself. Reaction pills live OUTSIDE .fud-bf-btn-row, so this does
      // NOT touch a player's own reaction Apply/Skip (handled below).
      for (const row of wrapper.querySelectorAll(".fud-bf-btn-row")) {
        row.style.display = "none";
      }
    }

    // ─── GM edit launch on the mirror ────────────────────────────────────────
    // AUTHORITATIVE strip: for non-local-render kinds the host's own rendered
    // HTML is broadcast verbatim, launch button included, so a player client
    // would otherwise receive it in its DOM. Remove the node outright rather
    // than hiding it — the host still rejects a forged EDIT_CARD from a non-GM,
    // but nothing about the edit surface should reach a player at all.
    if (!game.user?.isGM) {
      for (const p of wrapper.querySelectorAll(".fud-gm-launch")) p.remove();
    }

    // ─── Auto-confirm strip on the mirror: informational only ────────────────
    // The veto listeners live on the HOST's card and its window. A click here
    // never reaches them, so the host's "click to hold" wording would be a
    // promise this client cannot keep — worse on the OWNER's mirror, which is
    // otherwise the interactive one. Reword to what is actually true. (Wiring a
    // real player-side hold needs a veto intent on the wire; until then, do not
    // draw a control that does nothing.)
    if (!isActiveDirector()) {
      const cnt = wrapper.querySelector(".fud-bf-veto-count");
      if (cnt) cnt.textContent = "the GM can hold this";
    }
    if (game.user?.isGM && !isActiveDirector()) {
      // Support GM: the editor opens locally, but this client is NOT the writer.
      // Save ships one EDIT_CARD intent to the host, which merges it and
      // broadcasts the resulting delta back — so what a support GM ends up
      // seeing is always the host's committed state, never a local guess.
      try {
        wireGmEditLaunch(
          wrapper,
          // renderPayload is the COMPLETE display payload the card was built
          // from (skillType / defenseTargetType / hasDamage live only there);
          // playerAr is the fresher post-invoke state. Overlay the second on the
          // first so the editor gets both identity and currency — either alone
          // loses something the editor needs.
          () => gmEditContextFor({
            ...(menuSpec.renderPayload ?? {}),
            ...(playerAr ? { roll: playerAr.roll, damage: playerAr.damage ?? menuSpec.renderPayload?.damage,
                             perTargetResults: playerAr.perTargetResults } : {}),
            // The host's LIVE bag when a recompute has delivered one; the
            // card-post payload only until then. Save sends a wholesale
            // `replace`, so opening on a stale bag is not a display nit — it
            // silently deletes the host's edits.
            ...(playerGmOverride !== undefined ? { gmOverride: playerGmOverride } : {}),
          }, menuSpec.cardKind, null,
            // Likewise the candidate rows: the post-time projection misses
            // anything a cascade injected, and an absent row means an absent
            // key, which `replace` reads as "cleared".
            playerGmReactions ?? undefined,
            playerGmTargets),
          (patch) => {
            try {
              channel.emit({
                type: INTENTS.EDIT_CARD,
                body: { patch },
                combatId: menuSpec.combatId ?? null,
              });
            } catch (e) { warn("mirror: EDIT_CARD emit threw", e); }
          });
      } catch (e) { warn("mirror: GM edit launch wiring threw", e); }
    }

    // Reaction Apply/Skip — gate EACH pending pill on the reactor's owner,
    // independent of card ownership. Pills the local player owns keep their
    // buttons; everyone else's collapse to a "Waiting for [Owner]…" chip.
    // Already-resolved pills carry .is-resolved + a status chip from the
    // GM-side recordPillDecision DOM patch — leave those alone.
    for (const pill of wrapper.querySelectorAll(".fud-bf-reaction-pill.is-ask")) {
      if (pill.dataset.fudReactionPending !== "1") continue;
      const pillOwner = pill.dataset.fudReactionOwner ?? "";
      if (pillOwner && pillOwner === myUserId) continue;  // mine — keep buttons
      const ownerName = pillOwner
        ? (game.users.get(pillOwner)?.name ?? "Player")
        : "GM";
      const actions = pill.querySelector(".fud-bf-reaction-actions");
      if (actions) {
        actions.outerHTML = `<span class="fud-bf-reaction-status is-waiting">Waiting for ${escapeHtml(ownerName)}…</span>`;
      }
    }

    // Reaction-pill click — bound for EVERY client (card owner or not).
    // A player applies only the pills carried by a creature they own; the
    // per-pill owner stamp gates it. Emits REACTION_CHOICE so the GM-side
    // card records the decision. Card-level buttons (Confirm/Cancel/etc.)
    // remain attacker-owner-only via the handler(s) below.
    const onReactionClick = (ev) => {
      const reactionBtn = ev.target?.closest?.("[data-fud-reaction-action]");
      if (!reactionBtn) return;
      ev.stopPropagation();
      const pill = reactionBtn.closest(".fud-bf-reaction-pill");
      if (!pill) return;
      if (pill.dataset.fudReactionPending !== "1") return;
      // Per-pill ownership gate — only the reactor's owner may act on it.
      const pillOwner = pill.dataset.fudReactionOwner ?? "";
      if (!pillOwner || pillOwner !== myUserId) return;
      const rowKey  = pill.dataset.fudReactionKey ?? "";
      const carrier = pill.dataset.fudReactionCarrier ?? "";
      const decision = reactionBtn.dataset.fudReactionAction === "apply" ? "apply" : "skip";

      // ── OPTIMISTIC SKIP ──────────────────────────────────────────────────
      // A Skip is terminal and never opens a secondary picker, so its outcome is
      // fully determined the instant it's clicked. Resolve it locally NOW instead
      // of waiting two socket hops (click → GM, GM → echo) for the visual flip —
      // on a slow connection that round-trip is exactly the "I clicked but nothing
      // happened" lag. We still emit the choice so the GM records it; the GM's
      // immediate "ack" confirms receipt and its final "skip" echo (with the
      // authoritative pending count) reconciles. No-response net: if the host
      // never even ACKs (dropped socket), roll the pill back to actionable so it's
      // recoverable instead of stuck looking resolved while the table stalls.
      if (decision === "skip") {
        const cardEl = pill.closest(".fud-bf-card");
        resolveReactionPillDom(pill, cardEl, "skip");
        pill.dataset.fudReactionAckPending = "1";
        clearReactionPillTimer(pill);
        pill._fudSubmitTimer = setTimeout(() => {
          pill._fudSubmitTimer = null;
          if (!pill.isConnected) return;
          if (pill.dataset.fudReactionAckPending !== "1") return; // GM acked → keep resolved
          restoreReactionPillButtons(pill, cardEl);
          try { ui.notifications?.warn("No response from the host — tap Skip again."); } catch {}
        }, REACTION_SUBMIT_TIMEOUT_MS);
        channel.emit({
          type: INTENTS.REACTION_CHOICE,
          body: { rowKey, carrierUuid: carrier, decision: "skip" },
          combatId: menuSpec.combatId,
        });
        return;
      }

      // ── APPLY ────────────────────────────────────────────────────────────
      // Do NOT commit visually yet. The GM resolves the reaction — running any
      // secondary picker (target select / option-menu) on THIS client first —
      // and only then broadcasts the final Applied/Skipped via pill-update. This
      // is the "don't commit until the secondary menu is confirmed" contract.
      // Mark the pill "submitting" so it can't be re-clicked mid-flight; if the
      // player cancels the secondary pick, the GM broadcasts a "revert" that
      // restores the actionable pill. See recordPillDecision + remote-pick.js.
      pill.dataset.fudReactionPending = "0";
      pill.dataset.fudReactionSubmitting = "1";
      pill.classList.add("is-submitting");
      // Connection safety net: the GM owns the final Applied/Skipped (or revert)
      // broadcast, but if the click never reaches a listening GM (dropped socket
      // / desync) the pill would stay dimmed forever and the only recovery was a
      // client refresh. Arm a timer that restores the pill to actionable if the
      // GM hasn't even ACKNOWLEDGED the click within the window, so the player
      // can just tap again. The GM's immediate "ack" pill-update clears this, so
      // a legitimately slow resolution (secondary picker open on this client)
      // never trips it.
      clearReactionPillTimer(pill);
      pill._fudSubmitTimer = setTimeout(() => {
        pill._fudSubmitTimer = null;
        if (!pill.isConnected) return;
        if (pill.dataset.fudReactionSubmitting !== "1") return; // already resolved
        restoreReactionPillToActionable(pill);
        try { ui.notifications?.warn("No response from the host — tap Apply/Skip again."); } catch {}
      }, REACTION_SUBMIT_TIMEOUT_MS);
      // Card-level pending counter is owned by the GM's pill-update broadcasts —
      // don't decrement locally (a cancelled pick would leave it wrong).
      channel.emit({
        type: INTENTS.REACTION_CHOICE,
        body: { rowKey, carrierUuid: carrier, decision },
        combatId: menuSpec.combatId,
      });
    };
    wrapper.addEventListener("click", onReactionClick);

    // Keyword / status chip → explanation tooltip. Bound for EVERY client,
    // including non-interactive observers — reading a term's rules text is
    // informational and not gated by card ownership. Same toggle behavior +
    // click SFX (via [data-fud-kw] in director-ui-sfx) as the GM-side card.
    const onKeywordClick = (ev) => {
      const kwChip = ev.target?.closest?.("[data-fud-kw]");
      if (!kwChip) return;
      ev.stopPropagation();
      const key = kwChip.getAttribute("data-fud-kw");
      const entry = lookupTerm(key);
      if (entry) toggleKeywordTooltip({ key, entry, cardRoot: wrapper });
    };
    wrapper.addEventListener("click", onKeywordClick);

    // Click logic — replicates the GM-side onClick for interactive card
    // UI (Equipment dropdowns, Item tabs+rows, "Open Sheet" button,
    // Confirm/Cancel buttons). Reaction pills are handled by onReactionClick
    // above (per-pill owner); this layer is the action-taker's own controls,
    // gated on `isInteractive` (player owner or secondary GM). Non-interactive
    // observers get no bindings (.is-readonly-mirror visually disables them).
    let onClick = null;
    if (isInteractive) {
      onClick = (ev) => {
        // Invoke Trait / Bond — show local HUD then emit INVOKE_CHOICE to GM.
        const invokeBtn = ev.target?.closest?.("[data-fud-invoke]");
        if (invokeBtn) {
          ev.stopPropagation();
          if (invokeBtn.classList.contains("is-locked")) {
            ui.notifications?.warn("Invoke cannot be used on a Fumble.");
            return;
          }
          if (invokeBtn.classList.contains("is-resolved")) {
            const t = invokeBtn.dataset.fudInvoke;
            ui.notifications?.warn(`${t === "trait" ? "Trait" : "Bond"} already invoked for this action.`);
            return;
          }
          const type = invokeBtn.dataset.fudInvoke;
          (async () => {
            try {
              const hud = await import("./invoke/invoke-hud.js");
              if (hud.getActiveType() === type) {
                hud.dismissActive({ root: wrapper, ar: playerAr });
                // Tell the GM to tear down the table's read-only mirror too.
                channel.emit({ type: INTENTS.INVOKE_HUD_CLOSE, body: { type }, combatId: menuSpec.combatId });
                return;
              }
              if (!playerAr?.roll) return;
              if (type === "trait") {
                // Announce the open so the GM mirrors a read-only HUD to the
                // rest of the table while this player is deciding.
                channel.emit({ type: INTENTS.INVOKE_HUD_OPEN, body: { type: "trait" }, combatId: menuSpec.combatId });
                const choice = await hud.showTraitHUD({
                  roll: playerAr.roll,
                  root: wrapper,
                  tokenUuid: playerAr.attacker?.tokenUuid ?? null,
                  onSelectionChange: (sel) => channel.emit({ type: INTENTS.INVOKE_HUD_SELECT, body: { type: "trait", sel }, combatId: menuSpec.combatId }),
                });
                if (!choice) {
                  // Dismissed without committing → close the table's mirror.
                  channel.emit({ type: INTENTS.INVOKE_HUD_CLOSE, body: { type: "trait" }, combatId: menuSpec.combatId });
                  return;
                }
                invokeBtn.classList.add("is-resolved");
                channel.emit({
                  type: INTENTS.INVOKE_CHOICE,
                  body: { type: "trait", choice },
                  combatId: menuSpec.combatId,
                });
                armInvokeSubmitTimer(invokeBtn, "trait");
              } else {
                const attackerUuid = menuSpec.attackerActorUuid ?? null;
                if (!attackerUuid) return;
                let attacker = null;
                try { attacker = await fromUuid(attackerUuid); } catch {}
                if (!attacker) return;
                const { readActorBonds, getInvokeCapability } = await import("./invoke/invoke-core.js");
                if (getInvokeCapability(attacker) !== "full") {
                  ui.notifications?.warn("Bond invoke is not available for this actor.");
                  return;
                }
                const bonds = readActorBonds(attacker);
                const viable = bonds.filter((b) => b.bonus > 0);
                if (!viable.length) {
                  ui.notifications?.warn("No eligible Bonds (all bonds need at least 1 filled emotion).");
                  return;
                }
                // Announce the open (after validation) so the GM mirrors a
                // read-only HUD to the rest of the table.
                channel.emit({ type: INTENTS.INVOKE_HUD_OPEN, body: { type: "bond" }, combatId: menuSpec.combatId });
                const bondIndex = await hud.showBondHUD({
                  bonds: viable,
                  attacker,
                  root: wrapper,
                  ar: playerAr,
                  tokenUuid: playerAr.attacker?.tokenUuid ?? null,
                  onSelectionChange: (sel) => channel.emit({ type: INTENTS.INVOKE_HUD_SELECT, body: { type: "bond", sel }, combatId: menuSpec.combatId }),
                });
                if (bondIndex == null) {
                  channel.emit({ type: INTENTS.INVOKE_HUD_CLOSE, body: { type: "bond" }, combatId: menuSpec.combatId });
                  return;
                }
                invokeBtn.classList.add("is-resolved");
                channel.emit({
                  type: INTENTS.INVOKE_CHOICE,
                  body: { type: "bond", bondIndex },
                  combatId: menuSpec.combatId,
                });
                armInvokeSubmitTimer(invokeBtn, "bond");
              }
            } catch (e) {
              warn("mirror invoke handler threw", e);
              ui.notifications?.error("Invoke failed (see console).");
            }
          })();
          return;
        }
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
            updateEquipFreeIndicator(wrapper);
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
        // Transform form-chip clicks (Equipment card) — shared with the GM card.
        const formChip = ev.target?.closest?.(".fud-bf-form-chip");
        if (formChip) {
          ev.stopPropagation();
          handleFormChipClick(wrapper, formChip);
          updateEquipFreeIndicator(wrapper);
          return;
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
        // (Reaction-pill clicks handled by onReactionClick — bound for
        // every client and gated per-pill on the reactor's owner.)
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
        // Transform form picks — { main, off } → formIndex (shared collector).
        const wfMirror = collectWeaponFormSelections(wrapper);
        if (wfMirror) extras.weaponFormSelections = wfMirror;
        // Item selection (mode/key/cost stamped on .fud-bf-card root)
        const cardEl = wrapper.querySelector(".fud-bf-card");
        if (cardEl?.dataset.fudItemMode && cardEl?.dataset.fudItemKey) {
          extras.itemSelection = {
            mode: cardEl.dataset.fudItemMode,
            key:  cardEl.dataset.fudItemKey,
            cost: Number(cardEl.dataset.fudItemCost || 0) || 0,
          };
        }
        if (action === "confirm" || action === "cancel") {
          // Connection safety net — mirror the reaction-pill Apply/Skip contract:
          // grey the buttons (submitting), arm a no-response timer, THEN emit. If
          // the GM never acknowledges the click within the window (dropped socket /
          // desync), the buttons would otherwise stay greyed forever and the only
          // recovery was a refresh. The GM's "confirm-ack" (sent the instant it
          // receives the intent, before running the action) clears the timer; the
          // card-close broadcast that follows tears the mirror down. On timeout we
          // restore the buttons so the player can just click again.
          for (const b of wrapper.querySelectorAll(".fud-btn")) b.classList.add("is-resolved");
          wrapper.dataset.fudConfirmSubmitting = action;
          if (wrapper._fudConfirmTimer) { try { clearTimeout(wrapper._fudConfirmTimer); } catch {} }
          wrapper._fudConfirmTimer = setTimeout(() => {
            wrapper._fudConfirmTimer = null;
            if (!wrapper.isConnected) return;
            if (wrapper.dataset.fudConfirmSubmitting !== action) return; // acked / closed
            delete wrapper.dataset.fudConfirmSubmitting;
            for (const b of wrapper.querySelectorAll(".fud-btn")) b.classList.remove("is-resolved");
            try { ui.notifications?.warn("No response from the host — tap the button again."); } catch {}
          }, REACTION_SUBMIT_TIMEOUT_MS);
          channel.emit({
            type: action === "confirm" ? INTENTS.CONFIRM_ACTION : INTENTS.CANCEL_ACTION,
            body: action === "confirm" ? extras : {},
            combatId: menuSpec.combatId,
          });
        }
      };
      wrapper.addEventListener("click", onClick);
      // Initial economy indicator (Equipment card only; no-op otherwise).
      try { updateEquipFreeIndicator(wrapper); } catch {}
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
    // A player's mirror is the same card on a possibly smaller screen, so it
    // needs the same fit — the HTML arrives with the GM's caps baked in, which
    // are wrong for this viewport (fitActionCardToViewport clears them first).
    requestAnimationFrame(() => fitActionCardToViewport(wrapper));

    _mirrorCleanup = () => {
      try { wrapper.removeEventListener("click", onClick); } catch {}
      try { mirrorTipCleanup?.(); } catch {}
    };

    log(`action-card mirror rendered (owner=${isPlayerOwner ? "yes" : "observer"}, interactive=${isInteractive ? "yes" : "no"})`);
  });

  const offClose = channel.onMenuClose((payload) => {
    // Spectator-HUD closes are handled by offSpectatorClose — don't let them
    // tear down the card.
    if (payload?.kind && payload.kind !== "action-card") return;
    cleanupMirror();
  });

  return () => {
    try { offOpen?.(); } catch {}
    try { offClose?.(); } catch {}
    try { offConfirmAck?.(); } catch {}
    try { offPillUpdate?.(); } catch {}
    try { offTargetMutation?.(); } catch {}
    try { offBodyUpdate?.(); } catch {}
    try { offInvokeUpdate?.(); } catch {}
    try { offSpectatorOpen?.(); } catch {}
    try { offSpectatorClose?.(); } catch {}
    try { offSpectatorSelect?.(); } catch {}
    try { offTraitReroll?.(); } catch {}
  };
}
