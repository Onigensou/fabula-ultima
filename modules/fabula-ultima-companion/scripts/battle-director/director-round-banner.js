// Director-native start-of-round banner.
//
// Screen-fixed DOM cinematic shown at the start of each round: a centered dark
// band fades in, gold accent lines sweep open from the center, and "ROUND N"
// rises in — holds — then fades out. Self-contained: own socketlib channel,
// own render surface, own SFX. No legacy dependency (the legacy "round
// announcer" was end-of-round chat cards coupled to Lancer Initiative + the
// chat log, which the director doesn't use).
//
// SFX: Critical_1.wav, loaded via Web Audio (fetch the FULL file →
// decodeAudioData → play). Foundry's HTML5 AudioHelper uses Range requests,
// and some Forge .wav assets fail to decode on a 206 partial response
// (ERR_CONTENT_DECODING_FAILED); a plain full fetch (200) sidesteps that.
//
// Flow:
//   boot        → initDirectorRoundBanner() registers the socket handler.
//   ROUND_START → playRoundBanner({round}) renders locally + broadcasts.

import { log, warn } from "./logger.js";
import { registerSurface, unregisterSurface } from "./director-surfaces.js";
import { pWait } from "./presentation-clock.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION_PLAY = "FU_DIRECTOR_ROUND_PLAY";
const ACTION_HIDE = "FU_DIRECTOR_ROUND_HIDE";
const ACTION_BATTLE_START = "FU_DIRECTOR_BATTLE_START_PLAY";
const ACTION_TURNACTIONS = "FU_DIRECTOR_TURNACTIONS";
const STYLE_ID = "fu-dir-round-style";
const LAYER_ID = "fu-dir-round-layer";
const ROUND_SFX_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav";
const ACCENT = "#ffd866";
// ── Follow-up flash (Initiative / Ambush / Advantage) ──────────────────────
// A transient centered banner shown AFTER the round banner docks, announcing
// which side seized initiative this round (rolled mode) or the surprise-round
// engagement. Its own layer/style so it overlays WITHOUT disturbing the docked
// round HUD (turn tracker). SFX are the two Forge initiative cues.
const FOLLOWUP_LAYER_ID = "fu-dir-initiative-layer";
const FOLLOWUP_STYLE_ID = "fu-dir-initiative-style";
const SFX_PLAYER_INIT_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/player_initiative.wav";
const SFX_ENEMY_INIT_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/enemy_initiative.wav";
// Disposition base colours (match the legacy initiative tracker's border tints):
// party/ally = blue, enemy = red. The LABEL text is always white; the
// disposition colour lives on the framing accent lines + the wash.
const DISP_BLUE = "#5aaaff";  // party / advantage favour
const DISP_RED  = "#ff5050";  // enemy / ambush favour
// Per-kind label + line colour + SFX. Text is white for every kind.
const FOLLOWUP_SPECS = {
  playerInitiative: { text: "Player Initiative", line: DISP_BLUE, sfx: SFX_PLAYER_INIT_URL },
  enemyInitiative:  { text: "Enemy Initiative",  line: DISP_RED,  sfx: SFX_ENEMY_INIT_URL },
  advantage:        { text: "ADVANTAGE!",        line: DISP_BLUE, sfx: SFX_PLAYER_INIT_URL },
  ambush:           { text: "AMBUSH!",           line: DISP_RED,  sfx: SFX_ENEMY_INIT_URL },
};
// Icon dimensions (vh) — shared between the CSS and the JS that reserves equal
// width for both sides so the ROUND text stays screen-centred with uneven
// combatant counts.
const ICON_W_VH = 13.5;
const ICON_H_VH = 9.5;
// Parallelogram slant (vh). Drives the CSS `--slant` var AND the JS width math:
// adjacent icons overlap by this much so their slanted edges tessellate flush
// (no inter-icon gap), so each icon after the first advances ICON_W_VH-SLANT_VH.
const SLANT_VH = 1;
// How far the gold ray overflows the top+bottom accent lines, so it reads as
// icon-plus-border tall instead of a thin line-bordered cell.
const END_OVERFLOW_VH = 0;
// Rhombus (parallelogram) icon outline — same top/bottom width, but the top
// edge is shifted by `--slant` so both top corners sit away from the centre.
// Base shape leans toward the RIGHT (= outward for party icons); the left
// (enemy) group's scaleX(-1) mirror makes it lean left, so both lean outward.
const RHOMBUS_CLIP = "polygon(var(--slant) 0, 100% 0, calc(100% - var(--slant)) 100%, 0 100%)";
// Active-turn spotlight (centre) dimensions (vh). The combatant currently taking
// its turn is LIFTED out of its side row and shown here, larger than the lineup
// icons and in a SYMMETRIC, upright frame (vs the leaning side trapezoids) so it
// reads as the "now acting" focus. The banner docks at the screen TOP, so the
// spotlight breaks DOWNWARD — it hangs below the bar, with a small ROUND N
// beneath it. SPOT_SLANT is symmetric (both top corners pulled in equally),
// giving an upright portrait-plinth silhouette distinct from the side icons.
const SPOT_W_VH = 26;
const SPOT_H_VH = 18;
// Match the lineup icons' edge ANGLE so the spotlight's slanted left/right
// borders run PARALLEL to the adjacent icon borders (one continuous angled
// gap). The icons lean by SLANT_VH over ICON_H_VH of height; scale that same
// angle to the spotlight's taller height: SPOT_SLANT/SPOT_H == SLANT/ICON_H.
const SPOT_SLANT_VH = SPOT_H_VH * (SLANT_VH / ICON_H_VH);
// Top edge is the WIDE one (top corners pushed OUT past the bottom corners) — an
// inverted-trapezoid / keystone that flares outward at the top. The right edge
// leans like the party (right-group) icons, the left edge mirrors the enemy
// (left-group, scaleX-mirrored) icons.
const SPOT_CLIP = "polygon(0 0, 100% 0, calc(100% - var(--spot-slant)) 100%, var(--spot-slant) 100%)";
// Energetic ease-out for the banner's motion (dock glide, line sweep, text rise,
// spotlight reveal): very high initial velocity (slope ≈ y1/x1 ≈ 10) that bursts
// out of the gate, then a quick, crisp deceleration to rest — punchy, not a long
// lazy drift. Shared by the WAAPI animations and the CSS transitions below.
const EASE_ENERGETIC = "cubic-bezier(.08, .82, .17, 1)";
// Round-number text: ONE element (the hero ROUND N) shrinks down to the small
// docked size and is pushed into place below the spotlight — no separate
// fade-in element. Dock scale = smallVh / heroVh (2.6 / 6.2).
const TX_DOCK_SCALE = 2.6 / 6.2;
// Band-local downward shift that moves the (shrunk) ROUND N from the bar centre
// to its resting spot just below the hanging spotlight.
const TX_DOCK_SHIFT_VH = 15.5;
// How far ABOVE its resting top the spotlight starts its slide-in (fully above
// the bar, so it reads as dropping in from the top and pushing the text down).
const SPOT_SLIDE_VH = SPOT_H_VH + 2;
// Single gold "ray" behind the whole bar (emulated background light). RAY_VH =
// the tail length past each bar end where the gold fades to transparent; the
// body runs SOLID gold straight through the centre.
const RAY_VH = 13;
const END_GOLD = "rgba(255,216,102,.42)";
const END_GOLD_FADE = "rgba(255,216,102,.12)";
// Lineup icon enter/exit animation. When an activation is taken its icon is
// REMOVED: it collapses its layout footprint (margins → -half its width) while
// shrinking + fading, so the flex row slides the remaining icons toward the
// centre to fill the gap. A newly-appearing icon does the reverse (grows from
// nothing, pushing neighbours out) and glows for a few seconds.
const ICON_ANIM_MS = 360;
const ICON_ENTER_GLOW_MS = 2500;
// Enters use the snappy energetic curve; exits use a plain/normal ease.
const EASE_EXIT = "ease";

let _socket = null;
// Surface-registry id for the banner overlay while it's visible (it persists
// in the DOM via an .active class flip, which the DOM observer can't see, so
// we register/unregister it explicitly).
let _bannerSurfaceId = null;
// Turn-action icon reveal state. Icons stay hidden through the banner
// entrance + dock, then fade in staggered from the middle out. `_revealGen`
// cancels a pending stagger if a new round (or hide) supersedes it.
let _iconsRevealed = false;
let _revealGen = 0;
// Last dCombat we rendered, so an actor HP-change hook can re-snapshot (live
// crisis tint) without the turn-action hook having fired.
let _lastDCombat = null;

// ── boot: socket registration (idempotent; call once after socketlib up) ──
export function initDirectorRoundBanner() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("director-round-banner: socketlib unavailable — banner will be local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_PLAY, playRoundBannerLocal);
    _socket.register(ACTION_HIDE, () => { exitRoundBannerLocal({ animate: true }); clearTurnActionsLocal(); });
    _socket.register(ACTION_BATTLE_START, playBattleStartBannerLocal);
    // Payload is { list, animate } (tolerate a bare array from older senders).
    _socket.register(ACTION_TURNACTIONS, (p) =>
      renderTurnActionsLocal(Array.isArray(p) ? p : p?.list, { animate: !!p?.animate }));
    log("director-round-banner: socket registered");
  } catch (e) {
    warn("director-round-banner: init failed", e);
  }
  // Pre-decode the initiative + round SFX so the (frequent, timing-sensitive)
  // initiative banner plays instantly from cache on the first round. Ensure the
  // style/layer exist too so the first reveal isn't stalled by DOM/style setup.
  try {
    prewarmSfx([SFX_PLAYER_INIT_URL, SFX_ENEMY_INIT_URL, ROUND_SFX_URL]);
    ensureFollowupStyle();
  } catch (e) { warn("director-round-banner: sfx/style prewarm failed", e); }
  // GM drives the turn-action tracker off dCombat's state-change hook (fired
  // from director-combat.js). Registered outside the socket guard so the GM's
  // own local render still works even if socketlib is unavailable.
  try {
    // Mid-round turn changes → animate the spotlight swap + lineup enter/exit.
    Hooks.on("fu-director-turnactions", (dCombat) => refreshTurnActions(dCombat, { animate: true }));
  } catch (e) { warn("director-round-banner: turnactions hook registration failed", e); }

  // Live crisis / defeated tint — re-snapshot when a combatant's HP changes
  // while the banner is showing. updateActor covers linked tokens / world
  // actors; updateActorDelta covers unlinked (synthetic) token actors in v12.
  // DEBOUNCED (trailing): a rewind restores many actors in one burst BEFORE the
  // rewound combat is mounted, so an immediate refresh would render against the
  // STALE pre-rewind dCombat. Coalescing to one trailing call lets _lastDCombat
  // settle on the newly-mounted combat first.
  try {
    const hpChanged = (changes) => {
      const p = changes?.system?.props;
      return !!p && (p.current_hp !== undefined || p.max_hp !== undefined);
    };
    Hooks.on("updateActor", (_a, changes) => { if (hpChanged(changes)) scheduleLiveRefresh(); });
    Hooks.on("updateActorDelta", (_d, changes) => { if (hpChanged(changes)) scheduleLiveRefresh(); });
  } catch (e) { warn("director-round-banner: crisis HP hook registration failed", e); }
}

// Trailing-debounced live refresh. Re-reads _lastDCombat at fire time so it
// always renders the CURRENT combat, never a transient one mid-rewind.
let _liveRefreshTimer = null;
function scheduleLiveRefresh() {
  if (!game.user?.isGM) return;
  clearTimeout(_liveRefreshTimer);
  _liveRefreshTimer = setTimeout(() => {
    _liveRefreshTimer = null;
    try {
      if (_lastDCombat && document.getElementById(LAYER_ID)?.classList.contains("active")) {
        refreshTurnActions(_lastDCombat);
      }
    } catch (_e) {}
  }, 150);
}

// ── Web Audio SFX (full-file fetch → decode → play; cached per session) ───
const _audio = { ctx: null, cache: {} };
async function playRoundSfx(url = ROUND_SFX_URL, vol = 0.6) {
  try {
    _audio.ctx = _audio.ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audio.ctx.state === "suspended") { try { await _audio.ctx.resume(); } catch {} }
    let buf = _audio.cache[url];
    if (!buf) {
      const resp = await fetch(url, { cache: "reload" }); // full 200, no Range
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      buf = await _audio.ctx.decodeAudioData((await resp.arrayBuffer()).slice(0));
      _audio.cache[url] = buf;
    }
    const src = _audio.ctx.createBufferSource();
    const gain = _audio.ctx.createGain();
    gain.gain.value = vol;
    src.buffer = buf;
    src.connect(gain).connect(_audio.ctx.destination);
    src.start(0);
  } catch (e) {
    warn("director-round-banner: sfx failed", e);
  }
}

// Pre-decode SFX into the buffer cache so the FIRST play has no fetch+decode lag
// — important for the initiative banner, which fires every round and must stay
// tightly synced to its curtain reveal. `decodeAudioData` works on a suspended
// context (no user gesture needed), so we can warm the cache at boot; only
// playback needs the resumed context (handled in playRoundSfx). Idempotent:
// cached URLs are skipped, so repeated calls are cheap.
async function prewarmSfx(urls = []) {
  try {
    _audio.ctx = _audio.ctx || new (window.AudioContext || window.webkitAudioContext)();
    for (const url of urls) {
      if (!url || _audio.cache[url]) continue;
      try {
        const resp = await fetch(url, { cache: "reload" });
        if (!resp.ok) continue;
        _audio.cache[url] = await _audio.ctx.decodeAudioData((await resp.arrayBuffer()).slice(0));
      } catch (e) {
        warn("director-round-banner: prewarmSfx decode failed for", url, e);
      }
    }
  } catch (e) {
    warn("director-round-banner: prewarmSfx failed", e);
  }
}

// ── DOM surface (created lazily, reused) ──────────────────────────────────
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
/* z-index 99 = just BELOW Foundry application windows (which float at 100+), so
   CSB sheets / dialogs render OVER the docked HUD instead of being covered by
   it, while the banner still sits above the canvas/battlefield + chrome. */
#${LAYER_ID} { position: fixed; inset: 0; z-index: 99; pointer-events: none; overflow: hidden; display: none; --slant: ${SLANT_VH}vh; --spot-slant: ${SPOT_SLANT_VH}vh; }
#${LAYER_ID}.active { display: block; }
#${LAYER_ID} .fu-rb-band {
  position: absolute; top: 50%; left: 0; right: 0; transform: translateY(-50%);
  /* Scale about the TOP-centre so the docked banner's top edge stays pinned to
     the screen top (entrance is unaffected — it scales at 1). */
  transform-origin: 50% 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 0; padding: 0;
}
#${LAYER_ID} .fu-rb-bg {
  position: absolute; inset: 0;
  /* No dark backdrop — the HUD (gold lines, spotlight, icons, ROUND N) floats
     over the canvas. The element is kept (its opacity/scaleY still drive the
     entrance/dock fade), it just paints nothing. */
  background: none;
}
/* Fit-content column so the accent lines stretch to exactly the icon span. */
#${LAYER_ID} .fu-rb-inner {
  position: relative; display: flex; flex-direction: column; align-items: stretch;
  gap: 0; width: fit-content; max-width: 96vw;
}
#${LAYER_ID} .fu-rb-line {
  /* Stretches to the content (all icons) — no fixed width. Hugs the icons
     vertically (band gap 0). */
  position: relative; height: 2px; align-self: stretch; transform-origin: center;
  background: linear-gradient(90deg, transparent, ${ACCENT} 4%, ${ACCENT} 96%, transparent);
  box-shadow: 0 0 8px ${ACCENT};
}
/* Single gold "ray" behind the whole bar — emulated band of background light.
   Spans the full bar width PLUS a RAY_VH tail past each end, as ONE continuous
   horizontal gradient (set inline per render): transparent tips → gold body that
   runs UNBROKEN through the centre (behind the spotlight). Shoots open from the
   centre once on reveal, then settles. Full bar height. */
#${LAYER_ID} .fu-rb-ray {
  position: absolute; top: -${END_OVERFLOW_VH}vh; bottom: -${END_OVERFLOW_VH}vh;
  left: -${RAY_VH}vh; right: -${RAY_VH}vh;
  pointer-events: none; opacity: 0; transform-origin: center center;
}
#${LAYER_ID} .fu-rb-ray.lit { animation: fu-rb-ray-shoot 1.15s ease-out forwards; }
@keyframes fu-rb-ray-shoot {
  /* Grows from the centre with a subtle overshoot (1.02), pulsing a SYMMETRIC
     gold glow (drop-shadow follows the gradient's alpha, not a box edge), then
     settles to no glow at a steady resting opacity. */
  0%   { opacity: 0;   transform: scaleX(.08);
         filter: drop-shadow(0 0 0 rgba(255,216,102,0)) drop-shadow(0 0 0 rgba(255,255,255,0)); }
  35%  { opacity: 1;   transform: scaleX(1.02);
         filter: drop-shadow(0 0 13px rgba(255,216,102,.95)) drop-shadow(0 0 5px rgba(255,255,255,.85)); }
  100% { opacity: .85; transform: scaleX(1);
         filter: drop-shadow(0 0 0 rgba(255,216,102,0)) drop-shadow(0 0 0 rgba(255,255,255,0)); }
}
/* The "hero" ROUND N — big + screen-centred during the entrance cinematic. It
   lives in the absolute .fu-rb-center overlay (not the bar row), so on dock it
   fades out while the spotlight + small ROUND N take over below the bar. */
#${LAYER_ID} .fu-rb-text {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  color: #fff; white-space: nowrap; letter-spacing: .1em;
  font: 900 6.2vh "Pixel Operator", system-ui, sans-serif;
  /* Subtle black outline so ROUND N stays readable on any background (incl. the
     gold ray now running behind it). The stroke is proportional — it scales with
     the text, so the border looks the same at the big entrance size and the
     small docked size; paint-order keeps the stroke behind the fill so glyphs
     stay crisp. The blurred shadows add a soft dark halo for extra contrast. */
  -webkit-text-stroke: 0.6px rgba(0,0,0,.9); paint-order: stroke fill;
  text-shadow: 0 0 3px rgba(0,0,0,.85), 0 2px 10px rgba(0,0,0,.6);
}
/* Turn-action tracker — creature icons flanking ROUND X (enemies left, party right). */
#${LAYER_ID} .fu-rb-row {
  /* Roomy gap so the icon clusters don't crowd the ROUND text. */
  position: relative; display: flex; align-items: center; justify-content: center; gap: 0;
}
/* Reserves horizontal room in the BAR for the centre spotlight (which hangs
   below but whose tucked-in top overlaps the bar), so the left/right groups
   leave a gap. Width set inline per render (= spotlight width). */
#${LAYER_ID} .fu-rb-center-spacer { flex: 0 0 auto; height: ${ICON_H_VH}vh; }
#${LAYER_ID} .fu-rb-ta-group { display: flex; align-items: center; gap: 0; }
/* Both sides reserve equal width (set in JS) and align their icons toward the
   centre, so ROUND text stays screen-centred even with uneven counts; the
   shorter side's empty space falls on its OUTER edge. */
#${LAYER_ID} .fu-rb-ta-group.left  { justify-content: flex-end; }
#${LAYER_ID} .fu-rb-ta-group.right { justify-content: flex-start; }
#${LAYER_ID} .fu-rb-ta-icon {
  /* Bigger, landscape TRAPEZOID — Dota-2 hero-portrait style. The icon element
     itself stays a rectangle (so its box-shadow glow + reveal opacity work); the
     visible trapezoid is two clipped children (gold .fu-rb-ta-frame + inset
     .fu-rb-ta-wrap that masks the sprite). Icons sit flush (gap 0). Hidden
     (opacity 0) until the staggered reveal adds .shown. pointer-events: auto so
     the title tooltip works (the layer itself is pointer-events:none). */
  box-sizing: border-box;
  position: relative; width: ${ICON_W_VH}vh; height: ${ICON_H_VH}vh;
  flex: 0 0 auto;
  /* Drop-shadow (not box-shadow) so the resting shadow + glows follow the
     parallelogram alpha of the clipped frame, not a rectangle. */
  filter: drop-shadow(0 1px 2px rgba(0,0,0,.5));
  opacity: 0; pointer-events: auto;
  transition: opacity .35s ease, filter .25s ease;
}
/* Overlap adjacent icons by the slant so their parallelogram edges tessellate
   flush — closes the thin slanted gap the rectangles-touching layout leaves. */
#${LAYER_ID} .fu-rb-ta-icon + .fu-rb-ta-icon { margin-left: calc(-1 * var(--slant)); }
#${LAYER_ID} .fu-rb-ta-icon.shown { opacity: 1; }
/* Left side (enemies) mirror horizontally to face the centre (trapezoid is
   symmetric, so the slant is unaffected). */
#${LAYER_ID} .fu-rb-ta-group.left .fu-rb-ta-icon { transform: scaleX(-1); }
/* Gold frame (the trapezoid border) — the inset .wrap leaves ~2px of it showing
   as the rim on every edge, slants included. */
#${LAYER_ID} .fu-rb-ta-frame {
  position: absolute; inset: 0; background: ${ACCENT}; clip-path: ${RHOMBUS_CLIP};
}
#${LAYER_ID} .fu-rb-ta-wrap {
  position: absolute; inset: 2px; background: #0a0a0e; overflow: hidden; clip-path: ${RHOMBUS_CLIP};
}
#${LAYER_ID} .fu-rb-ta-icon .fu-rb-ta-media {
  /* Token sprite masked into the frame: focal point + zoom set inline per actor. */
  width: 100%; height: 100%; object-fit: cover; object-position: center top;
  transform: scale(2); transform-origin: center top; display: block;
}
/* Spent activations aren't greyed — the icon is REMOVED from the lineup (one
   icon per pending activation), so there's no .spent state anymore. */
#${LAYER_ID} .fu-rb-ta-icon.glow { animation: fu-rb-icon-glow 1.1s ease-out; }
@keyframes fu-rb-icon-glow {
  0%   { filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)) drop-shadow(0 0 0 rgba(255,255,255,0)); }
  22%  { filter: drop-shadow(0 0 13px rgba(255,216,102,1)) drop-shadow(0 0 6px rgba(255,255,255,.95)); }
  100% { filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)) drop-shadow(0 0 0 rgba(255,255,255,0)); }
}
/* A newly-added lineup icon glows gold for a couple seconds as it slides in. */
#${LAYER_ID} .fu-rb-ta-icon.fu-rb-enter-glow { animation: fu-rb-icon-enter-glow 2.4s ease-out; }
@keyframes fu-rb-icon-enter-glow {
  0%   { filter: drop-shadow(0 0 0 rgba(255,216,102,0)); }
  16%  { filter: drop-shadow(0 0 14px rgba(255,216,102,1)) drop-shadow(0 0 6px rgba(255,255,255,.95)); }
  70%  { filter: drop-shadow(0 0 9px rgba(255,216,102,.8)) drop-shadow(0 0 3px rgba(255,255,255,.5)); }
  100% { filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
}
/* The spotlight glows gold for a couple seconds when a new actor grows in. */
#${LAYER_ID} .fu-rb-spotlight.fu-rb-spot-glow { animation: fu-rb-spot-glow 2.4s ease-out; }
@keyframes fu-rb-spot-glow {
  0%   { filter: drop-shadow(0 4px 10px rgba(0,0,0,.6)); }
  16%  { filter: drop-shadow(0 0 20px rgba(255,216,102,1)) drop-shadow(0 0 9px rgba(255,255,255,.9)) drop-shadow(0 4px 10px rgba(0,0,0,.6)); }
  70%  { filter: drop-shadow(0 0 12px rgba(255,216,102,.8)) drop-shadow(0 4px 10px rgba(0,0,0,.6)); }
  100% { filter: drop-shadow(0 4px 10px rgba(0,0,0,.6)); }
}
/* Enemy spotlight: the appear-glow is strong RED instead of gold. More specific
   than the gold rule above (3 classes vs 2), so it wins for enemies. */
#${LAYER_ID} .fu-rb-spotlight.enemy.fu-rb-spot-glow { animation: fu-rb-spot-glow-red 2.4s ease-out; }
@keyframes fu-rb-spot-glow-red {
  0%   { filter: drop-shadow(0 4px 10px rgba(0,0,0,.6)); }
  16%  { filter: drop-shadow(0 0 22px rgba(235,25,25,1)) drop-shadow(0 0 10px rgba(255,130,100,.95)) drop-shadow(0 4px 10px rgba(0,0,0,.6)); }
  70%  { filter: drop-shadow(0 0 13px rgba(225,30,30,.9)) drop-shadow(0 4px 10px rgba(0,0,0,.6)); }
  100% { filter: drop-shadow(0 4px 10px rgba(0,0,0,.6)); }
}
/* Crisis (HP <= half) — subtle pulsing red tint over the sprite as a warning.
   A multiply overlay keeps the sprite's detail (vs a flat red wash); the gentle
   alpha/hue drift reads as "danger" without being distracting. */
#${LAYER_ID} .fu-rb-ta-icon.crisis .fu-rb-ta-wrap::after {
  /* Tint lives on the sprite layer (inset inside the gold rim) so it reddens
     ONLY the sprite, never the border. wrap's overflow/clip confines it. */
  content: ""; position: absolute; inset: 0; pointer-events: none;
  mix-blend-mode: multiply;
  background: rgba(225,25,20,.32);
  animation: fu-rb-icon-crisis 2.6s ease-in-out infinite;
}
@keyframes fu-rb-icon-crisis {
  0%, 100% { background: rgba(220,30,25,.22); }
  50%      { background: rgba(240,15,15,.42); }
}
/* Defeated (HP 0, still on the scene — e.g. a downed PC) — grey the sprite and
   stamp a skull. Suppresses the crisis pulse so the skull stays clean. Placed
   AFTER crisis to win on equal specificity. */
#${LAYER_ID} .fu-rb-ta-icon.defeated {
  filter: none; animation: none; box-shadow: none;
}
#${LAYER_ID} .fu-rb-ta-icon.defeated .fu-rb-ta-frame { background: #6f6f77; }
#${LAYER_ID} .fu-rb-ta-icon.defeated .fu-rb-ta-media { filter: grayscale(1) brightness(.45); }
#${LAYER_ID} .fu-rb-ta-icon.defeated .fu-rb-ta-wrap::after { display: none; }
#${LAYER_ID} .fu-rb-ta-icon.defeated::before {
  content: "💀"; position: absolute; inset: 0; z-index: 2;
  display: flex; align-items: center; justify-content: center;
  font-size: 5.2vh; line-height: 1; pointer-events: none;
  filter: drop-shadow(0 1px 3px rgba(0,0,0,.95));
}
/* Keep the skull upright on the mirrored (left) side. */
#${LAYER_ID} .fu-rb-ta-group.left .fu-rb-ta-icon.defeated::before { transform: scaleX(-1); }
/* Enemy icons (left group) open that monster's encyclopedia page on click; a
   book badge fades in on hover as the affordance. */
#${LAYER_ID} .fu-rb-ta-group.left .fu-rb-ta-icon { cursor: pointer; }
#${LAYER_ID} .fu-rb-ta-book {
  position: absolute; inset: 0; z-index: 3; pointer-events: none;
  display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity .15s ease;
  background: rgba(0,0,0,.42); clip-path: ${RHOMBUS_CLIP};
}
#${LAYER_ID} .fu-rb-ta-book i { color: ${ACCENT}; font-size: 4vh; text-shadow: 0 1px 5px rgba(0,0,0,.95); }
#${LAYER_ID} .fu-rb-ta-icon:hover .fu-rb-ta-book { opacity: 1; }
/* Un-mirror just the glyph on the left side (book box keeps the leaning clip). */
#${LAYER_ID} .fu-rb-ta-group.left .fu-rb-ta-book i { transform: scaleX(-1); }
/* Small persistent book badge, bottom-right corner — shown when NOT hovering. */
#${LAYER_ID} .fu-rb-ta-book-mini {
  position: absolute; bottom: 0.5vh; right: 0.5vh; z-index: 4; pointer-events: none;
  display: flex; align-items: center; justify-content: center;
  width: 2.6vh; height: 2.6vh; border-radius: 3px;
  background: rgba(0,0,0,.55); transition: opacity .15s ease;
}
#${LAYER_ID} .fu-rb-ta-book-mini i { color: ${ACCENT}; font-size: 1.5vh; }
#${LAYER_ID} .fu-rb-ta-icon:hover .fu-rb-ta-book-mini { opacity: 0; }
/* On the mirrored (left) side, put the badge at the visual bottom-RIGHT (local
   left) and un-mirror the glyph. */
#${LAYER_ID} .fu-rb-ta-group.left .fu-rb-ta-book-mini { right: auto; left: 0.5vh; }
#${LAYER_ID} .fu-rb-ta-group.left .fu-rb-ta-book-mini i { transform: scaleX(-1); }
/* ── Active-turn spotlight ──────────────────────────────────────────────────
   Absolute overlay anchored over the bar (inner is position:relative). Holds
   the hero ROUND N (enter), the spotlight portrait (hangs below the bar), and
   the small docked ROUND N (below the portrait). pointer-events stay off. */
#${LAYER_ID} .fu-rb-center { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
/* Larger, keystone-framed portrait of the current turn-taker. Anchored to the
   TOP of the bar (top: 0) so when the banner is docked at the screen top, the
   portrait's top edge reaches the screen top; it hangs DOWNWARD from there
   (transform-origin top). Hidden (scaled-down) until .shown. */
#${LAYER_ID} .fu-rb-spotlight {
  position: absolute; left: 50%; top: 0; width: ${SPOT_W_VH}vh; height: ${SPOT_H_VH}vh;
  transform: translate(-50%, 0); transform-origin: 50% 0;
  opacity: 0; transition: opacity .2s ease;
  filter: drop-shadow(0 4px 10px rgba(0,0,0,.6));
}
/* Resting (docked) state. The slide-in DOWN from the top is played as a WAAPI
   transform animation on dock; this just holds the final opacity + position. */
#${LAYER_ID} .fu-rb-spotlight.shown { opacity: 1; }
#${LAYER_ID} .fu-rb-spot-frame { position: absolute; inset: 0; background: ${ACCENT}; clip-path: ${SPOT_CLIP}; }
/* Enemy in the spotlight faces LEFT — mirror the FRAME (not the media, which
   carries the inline focal-zoom transform), like the enemy lineup icons. The
   keystone clip is symmetric, so only the sprite visibly flips. */
#${LAYER_ID} .fu-rb-spotlight.enemy .fu-rb-spot-frame { transform: scaleX(-1); }
#${LAYER_ID} .fu-rb-spot-wrap { position: absolute; inset: 3px; background: #0a0a0e; overflow: hidden; clip-path: ${SPOT_CLIP}; }
#${LAYER_ID} .fu-rb-spotlight .fu-rb-ta-media {
  width: 100%; height: 100%; object-fit: cover; object-position: center top;
  transform: scale(2); transform-origin: center top; display: block;
}
/* Neutral "awaiting" placeholder (no one acting / between turns / post-enter). */
#${LAYER_ID} .fu-rb-spot-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
#${LAYER_ID} .fu-rb-spot-ph i { color: ${ACCENT}; font-size: 6vh; opacity: .5; filter: drop-shadow(0 1px 4px rgba(0,0,0,.8)); }
/* Crisis tint (≤ half HP) on the spotlight sprite — mirrors the lineup icons. */
#${LAYER_ID} .fu-rb-spotlight.crisis .fu-rb-spot-wrap::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  mix-blend-mode: multiply; background: rgba(225,25,20,.32);
  animation: fu-rb-icon-crisis 2.6s ease-in-out infinite;
}
#${LAYER_ID} .fu-rb-spotlight.defeated .fu-rb-spot-frame { background: #6f6f77; }
#${LAYER_ID} .fu-rb-spotlight.defeated .fu-rb-ta-media { filter: grayscale(1) brightness(.45); }
#${LAYER_ID} .fu-rb-spotlight.defeated .fu-rb-spot-wrap::after { display: none; }
#${LAYER_ID} .fu-rb-spotlight.defeated::before {
  content: "💀"; position: absolute; inset: 0; z-index: 2;
  display: flex; align-items: center; justify-content: center;
  font-size: 7vh; line-height: 1; pointer-events: none;
  filter: drop-shadow(0 1px 3px rgba(0,0,0,.95));
}
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function ensureLayer() {
  ensureStyle();
  let layer = document.getElementById(LAYER_ID);
  if (layer && layer.__fu) return layer;
  layer = document.createElement("div");
  layer.id = LAYER_ID;
  const band = document.createElement("div"); band.className = "fu-rb-band";
  const bg = document.createElement("div"); bg.className = "fu-rb-bg";
  // Fit-content inner column: top line, [enemy icons | ROUND N | party icons]
  // row, bottom line. Its width is the icon span, so the lines (align-self:
  // stretch) cover exactly all the icons.
  const inner = document.createElement("div"); inner.className = "fu-rb-inner";
  const lt = document.createElement("div"); lt.className = "fu-rb-line";
  const row = document.createElement("div"); row.className = "fu-rb-row";
  const leftGroup = document.createElement("div"); leftGroup.className = "fu-rb-ta-group left";
  // Empty spacer holding the centre gap in the BAR (the spotlight hangs below
  // but its tucked-in top overlaps the bar). Width set per render = spotlight w.
  const spacer = document.createElement("div"); spacer.className = "fu-rb-center-spacer";
  const rightGroup = document.createElement("div"); rightGroup.className = "fu-rb-ta-group right";
  row.append(leftGroup, spacer, rightGroup);
  const lb = document.createElement("div"); lb.className = "fu-rb-line";
  // Single gold "ray" spanning the whole bar (+ a tail past each end) as one
  // continuous gradient that fills the centre too. Appended FIRST so it paints
  // BEHIND the lines + icons + spotlight.
  const ray = document.createElement("div"); ray.className = "fu-rb-ray";
  // Centre overlay (absolute over the bar). During the entrance it shows the big
  // "hero" ROUND N; on dock that shrinks to the small docked size and is pushed
  // below the spotlight, which drops in from the top.
  const center = document.createElement("div"); center.className = "fu-rb-center";
  const spotlight = document.createElement("div"); spotlight.className = "fu-rb-spotlight";
  // ONE round-number text: big + centred for the entrance, then it shrinks to
  // the small docked size and is pushed below the spotlight (no second element).
  const tx = document.createElement("div"); tx.className = "fu-rb-text";
  center.append(spotlight, tx);
  inner.append(ray, lt, row, lb, center);
  band.append(bg, inner);
  layer.append(band);
  document.body.appendChild(layer);
  layer.__fu = { band, bg, lt, lb, tx, row, leftGroup, rightGroup, inner, ray, center, spotlight, spacer, turnActionKey: "", spotKey: "" };
  return layer;
}

// Presentation dwell — collapses to zero while the window is hidden, so a
// backgrounded client doesn't park on each banner hold and then replay the
// whole round-banner sequence on refocus. See presentation-clock.js.
const sleep = pWait;

// ── exit: fade out + clear the docked banner ──────────────────────────────
// Used both on round change (before the next banner enters) and at battle end.
// Function declaration → hoisted, so playRoundBannerLocal can call it above.
async function exitRoundBannerLocal({ animate = true } = {}) {
  try {
    const layer = document.getElementById(LAYER_ID);
    if (!layer || !layer.__fu || !layer.classList.contains("active")) return;
    const { band, bg, lt, lb, tx, spotlight } = layer.__fu;
    if (animate) {
      // Single-keyframe → fades from each element's CURRENT opacity to 0
      // (the docked banner sits at reduced bg opacity, full text/lines). The
      // spotlight fades with it so a round-change exit is clean.
      await Promise.all([
        bg.animate([{ opacity: 0 }], { duration: 300, easing: "ease-in", fill: "forwards" }).finished,
        lt.animate([{ opacity: 0 }], { duration: 300, fill: "forwards" }).finished,
        lb.animate([{ opacity: 0 }], { duration: 300, fill: "forwards" }).finished,
        tx.animate([{ opacity: 0 }], { duration: 300, easing: "ease-in", fill: "forwards" }).finished,
        ...(spotlight ? [spotlight.animate([{ opacity: 0 }], { duration: 300, easing: "ease-in", fill: "forwards" }).finished] : []),
      ]);
    }
    for (const el of [band, bg, lt, lb, tx, spotlight]) el?.getAnimations?.().forEach((a) => a.cancel());
    layer.classList.remove("active");
    if (_bannerSurfaceId) { unregisterSurface(_bannerSurfaceId); _bannerSurfaceId = null; }
  } catch (e) {
    warn("exitRoundBannerLocal threw", e);
  }
}

// ── shared enter sequence ─────────────────────────────────────────────────
// Reset to centered start state, then play the entrance: band fades in,
// accent lines sweep open from the center, text rises in. Resolves once the
// text is fully in. Both the round banner (→ dock) and the battle-start
// banner (→ exit) build on this. Returns the layer's element refs.
async function enterBannerLocal({ text = "", sfx = true, sfxVol = 0.6 } = {}) {
  const layer = ensureLayer();
  const { band, bg, lt, lb, tx, spotlight } = layer.__fu;

  // If a prior banner is still on screen (docked round indicator), fade it
  // out first so the new one enters from center cleanly (no jump from top).
  if (layer.classList.contains("active")) await exitRoundBannerLocal({ animate: true });

  for (const el of [band, bg, lt, lb, tx]) el.getAnimations?.().forEach((a) => a.cancel());

  tx.textContent = text;
  // Centre starts in its "hero" state: the spotlight is hidden and the ROUND N
  // is big + centred (it shrinks + gets pushed below the spotlight on dock).
  spotlight?.classList.remove("shown");
  // Clear any docked transform a prior instant/dock left inline, so the entrance
  // animation's hero keyframes (translate(-50%,-50%)) are the start state.
  tx.style.transform = "";

  // Move + size the band to its centred start state BEFORE revealing it, so a
  // prior docked/instant position can never flash at the top for a frame.
  band.style.top = "50%";
  band.style.transform = "translateY(-50%) scale(1)";
  bg.style.opacity = "0";
  tx.style.opacity = "0";
  lt.style.transform = "scaleX(0)";
  lb.style.transform = "scaleX(0)";

  layer.classList.add("active");
  if (!_bannerSurfaceId) _bannerSurfaceId = registerSurface({ kind: "round-banner" });
  if (sfx) playRoundSfx(ROUND_SFX_URL, sfxVol);

  // Enter: band fades in, accent lines sweep open, text rises in.
  bg.animate([{ opacity: 0, transform: "scaleY(.55)" }, { opacity: 1, transform: "scaleY(1)" }],
    { duration: 240, easing: "ease-out", fill: "forwards" });
  await Promise.all([
    lt.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: 400, easing: EASE_ENERGETIC, fill: "forwards" }).finished,
    lb.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: 400, easing: EASE_ENERGETIC, fill: "forwards" }).finished,
  ]);
  await tx.animate([
    { opacity: 0, transform: "translate(-50%, -50%) translateY(16px)" },
    { opacity: 1, transform: "translate(-50%, -50%) translateY(0)" },
  ], { duration: 300, easing: EASE_ENERGETIC, fill: "forwards" }).finished;

  return layer.__fu;
}

// ── local render (runs on every client via socket) ───────────────────────
// Enter center → hold → DOCK to middle-top and persist as a round indicator.
async function playRoundBannerLocal(payload = {}) {
  try {
    const {
      round = 0, holdMs = 800, sfx = true, sfxVol = 0.6,
      // dockTopPct = 0 → top edge pinned to the screen top (no blank space
      // above); dockScale bumped 20% (0.4 → 0.48), uniform so the ratio holds.
      dockTopPct = 0, dockScale = 0.48, dockBgOpacity = 0.3,
      instant = false,
      // Optional follow-up flash ({ kind, side }) shown AFTER this banner docks.
      followup = null,
    } = payload;

    // Instant mode (rewind restore) — jump straight to the docked persistent
    // state with no entrance cinematic + no SFX. Used so a rewind doesn't
    // replay the ~2.5s banner each time. F5 resume uses the animated path.
    if (instant) {
      const layer = ensureLayer();
      const { band, bg, lt, lb, tx } = layer.__fu;
      for (const el of [band, bg, lt, lb, tx]) el.getAnimations?.().forEach((a) => a.cancel());
      tx.textContent = `ROUND ${round}`;
      // Position docked BEFORE revealing so it doesn't flash at centre first.
      band.style.top = `${dockTopPct}%`;
      band.style.transform = `translateY(0%) scale(${dockScale})`;
      bg.style.opacity = String(dockBgOpacity);
      // Docked state: ROUND N is the small text resting below the spotlight.
      tx.style.opacity = "1";
      tx.style.transform = `translate(-50%, calc(-50% + ${TX_DOCK_SHIFT_VH}vh)) scale(${TX_DOCK_SCALE})`;
      lt.style.transform = "scaleX(1)";
      lb.style.transform = "scaleX(1)";
      layer.classList.add("active");
      if (!_bannerSurfaceId) _bannerSurfaceId = registerSurface({ kind: "round-banner" });
      showAllTurnActionIcons(); // rewind / instant restore — no stagger
      return;
    }

    // Icons stay hidden through the entrance + dock; revealed staggered after.
    hideTurnActionIcons();

    const fu = await enterBannerLocal({ text: `ROUND ${round}`, sfx, sfxVol });
    const { band, bg } = fu;

    await sleep(holdMs);

    // ── Phase 1: the components glide to the top while ROUND N shrinks. ──
    // Band: shrink + glide to middle-top, then STAY (persistent indicator).
    const dockAnim = band.animate(
      [
        { top: "50%", transform: "translateY(-50%) scale(1)" },
        { top: `${dockTopPct}%`, transform: `translateY(0%) scale(${dockScale})` },
      ],
      { duration: 520, easing: EASE_ENERGETIC, fill: "forwards" }
    );
    bg.animate([{ opacity: 1 }, { opacity: dockBgOpacity }],
      { duration: 520, easing: "ease-in-out", fill: "forwards" });
    // The big hero ROUND N shrinks to the small docked size as the band glides
    // up — staying centred in the bar for now (Phase 2 pushes it down). Same
    // element throughout, so it reads as one continuous "ROUND N shrinks".
    fu.tx?.animate?.([
      { transform: "translate(-50%, -50%) scale(1)" },
      { transform: `translate(-50%, -50%) scale(${TX_DOCK_SCALE})` },
    ], { duration: 520, easing: EASE_ENERGETIC, fill: "forwards" });

    try { await dockAnim.finished; } catch (_e) {}
    // BAKE the band's docked transform into inline styles and DROP only the BAND
    // animation. A fill:forwards animation outranks inline styles in the
    // cascade, so if it lingered, the NEXT round's centred-start reset
    // (band.style.top = "50%" in enterBannerLocal) would be ignored and the
    // entrance would replay from the docked top. The band is the ONLY element
    // with no entrance animation of its own, so only it needs this. Do NOT
    // commit/cancel the bg + text dock animations: each sits ON TOP of a
    // still-filling ENTRANCE animation it deliberately overrides — cancelling it
    // would let that entrance animation resurface. Those self-correct on the
    // next round (enterBannerLocal cancels + re-animates them).
    try { dockAnim.commitStyles(); dockAnim.cancel(); } catch (_e) {}

    // ── Phase 2: the spotlight drops IN from the top (high start speed, snappy)
    // and pushes the shrunk ROUND N down to its resting place below it. ──
    fu.spotlight?.classList.add("shown"); // opacity 1; CSS holds the resting transform
    fu.spotlight?.animate?.([
      { transform: `translate(-50%, ${-SPOT_SLIDE_VH}vh)` },
      { transform: "translate(-50%, 0)" },
    ], { duration: 360, easing: EASE_ENERGETIC }); // no fill → CSS .shown holds the end
    // Pushed: the text slides from the bar centre down to below the spotlight,
    // synced with the spotlight's arrival.
    fu.tx?.animate?.([
      { transform: `translate(-50%, -50%) scale(${TX_DOCK_SCALE})` },
      { transform: `translate(-50%, calc(-50% + ${TX_DOCK_SHIFT_VH}vh)) scale(${TX_DOCK_SCALE})` },
    ], { duration: 360, easing: EASE_ENERGETIC, fill: "forwards" });

    // Then populate the creature icons one-by-one from the middle out.
    revealTurnActionIconsStaggered();
    // Note: NO layer.classList.remove — the banner persists until the next
    // round (exited above) or battle end (hideRoundBanner).

    // ── Follow-up flash (Initiative / Ambush / Advantage) ──
    // Sequenced AFTER the round banner has docked + icons begun revealing, so it
    // reads as a distinct "second banner". Carried on the SAME ACTION_PLAY
    // broadcast (payload.followup), so every client plays it in the same order
    // with no extra socket. The instant/resume path returns early above, so a
    // reload/rewind never replays the flash. AWAITED (not fire-and-forget) so
    // this function's promise resolves only once the whole sequence has cleared —
    // that promise is what the director tracks to gate the enemy autopilot.
    if (followup?.kind) {
      await sleep(320);
      await playFollowupBannerLocal(followup);
    }
  } catch (e) {
    warn("playRoundBannerLocal threw", e);
  }
}

// ── local render: battle-start flash ──────────────────────────────────────
// Same entrance as the round banner, but on hold-end it EXITS (fades out)
// right away instead of docking to the top. Awaited by the GM so the battle
// process kicks off only after the flash has cleared the screen.
async function playBattleStartBannerLocal(payload = {}) {
  try {
    const { text = "BATTLE START", holdMs = 900, sfx = true, sfxVol = 0.6 } = payload;
    await enterBannerLocal({ text, sfx, sfxVol });
    await sleep(holdMs);
    await exitRoundBannerLocal({ animate: true });
  } catch (e) {
    warn("playBattleStartBannerLocal threw", e);
  }
}

// ── Follow-up flash (Initiative / Ambush / Advantage) ──────────────────────
// A short centered banner on ITS OWN layer (so the docked round HUD is left
// untouched): bold-italic coloured label fades + scales in, holds, fades out.
// Reuses the module's Web-Audio SFX helper for the two Forge initiative cues.
let _followupSurfaceId = null;

// Animation timing (ms) — kept as named constants so the sequence stays precise
// and easy to retune. Total ≈ WASH + CURTAIN + TEXT_IN + hold + TEXT_OUT + FADE.
const FU_WASH_MS    = 200;   // panel wash fades in first
const FU_CURTAIN_MS = 440;   // accent lines sweep open from centre (curtain)
const FU_TEXT_IN_MS = 300;   // label slides in from the left + fades
const FU_TEXT_OUT_MS = 300;  // label slides out to the right + fades
const FU_FADE_MS    = 320;   // whole banner fades out
const FU_TEXT_SHIFT = "9vw"; // horizontal slide distance for the label in/out

function ensureFollowupStyle() {
  if (document.getElementById(FOLLOWUP_STYLE_ID)) return;
  const css = `
#${FOLLOWUP_LAYER_ID} { position: fixed; inset: 0; z-index: 99; pointer-events: none; display: none; }
#${FOLLOWUP_LAYER_ID}.active { display: block; }
/* Framing panel: two disposition-coloured accent lines with a subtle wash
   between them. Centred; --line drives the disposition colour. */
#${FOLLOWUP_LAYER_ID} .fu-init-band {
  position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%);
  width: 88vw; height: 12vh;
  display: flex; flex-direction: column; justify-content: space-between;
  --line: ${DISP_BLUE};
}
#${FOLLOWUP_LAYER_ID} .fu-init-wash {
  position: absolute; inset: 0; opacity: 0;
  /* horizontal band of disposition light, brightest at the centre. Set inline. */
}
#${FOLLOWUP_LAYER_ID} .fu-init-line {
  position: relative; width: 100%; height: 3px; transform: scaleX(0);
  transform-origin: 50% 50%;  /* curtain opens from the centre outward */
  background: linear-gradient(90deg, transparent 0%, var(--line) 6%, var(--line) 94%, transparent 100%);
  box-shadow: 0 0 10px var(--line), 0 0 3px var(--line);
}
#${FOLLOWUP_LAYER_ID} .fu-init-text {
  position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%);
  white-space: nowrap; font-style: italic; font-weight: 900;
  font-family: "Pixel Operator", system-ui, sans-serif;
  font-size: 6.4vh; letter-spacing: .03em; opacity: 0; color: #fff;
  /* Dark outline + halo so the white label reads on any battlefield. */
  -webkit-text-stroke: 0.9px rgba(0,0,0,.92); paint-order: stroke fill;
  text-shadow: 0 0 5px rgba(0,0,0,.9), 0 3px 16px rgba(0,0,0,.7);
}
`.trim();
  const style = document.createElement("style");
  style.id = FOLLOWUP_STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function ensureFollowupLayer() {
  ensureFollowupStyle();
  let layer = document.getElementById(FOLLOWUP_LAYER_ID);
  if (layer && layer.__fu) return layer;
  layer = document.createElement("div");
  layer.id = FOLLOWUP_LAYER_ID;
  const band = document.createElement("div"); band.className = "fu-init-band";
  const wash = document.createElement("div"); wash.className = "fu-init-wash";
  const topLine = document.createElement("div"); topLine.className = "fu-init-line top";
  const bottomLine = document.createElement("div"); bottomLine.className = "fu-init-line bottom";
  band.append(wash, topLine, bottomLine);
  const tx = document.createElement("div"); tx.className = "fu-init-text";
  layer.append(band, tx);
  document.body.appendChild(layer);
  layer.__fu = { band, wash, topLine, bottomLine, tx };
  return layer;
}

// Resolve a followup descriptor to its display spec. `kind` is "initiative"
// (side decides Player/Enemy), "ambush", or "advantage".
function resolveFollowupSpec(followup) {
  const kind = String(followup?.kind ?? "");
  if (kind === "ambush") return FOLLOWUP_SPECS.ambush;
  if (kind === "advantage") return FOLLOWUP_SPECS.advantage;
  if (kind === "initiative") {
    return followup?.side === "party" ? FOLLOWUP_SPECS.playerInitiative : FOLLOWUP_SPECS.enemyInitiative;
  }
  return null;
}

// Play the follow-up flash locally (runs on every client via the round-banner
// broadcast that carries `payload.followup`). Sequence:
//   1. panel WASH fades in,
//   2. accent lines CURTAIN-open from the centre outward,
//   3. white label SLIDES + fades in from the left,
//   4. hold,
//   5. label slides OUT to the opposite (right) side,
//   6. the whole banner fades out.
// SFX fires exactly at the curtain reveal (played from the pre-warmed cache so
// there's no first-play decode lag). Guarded so a bad descriptor never throws.
async function playFollowupBannerLocal(followup = {}, { holdMs = 850, sfx = true } = {}) {
  try {
    const spec = resolveFollowupSpec(followup);
    if (!spec) return;
    const layer = ensureFollowupLayer();
    const { band, wash, topLine, bottomLine, tx } = layer.__fu;
    for (const el of [wash, topLine, bottomLine, tx]) el.getAnimations?.().forEach((a) => a.cancel());

    // Disposition colour on the band (drives the line var) + the wash gradient.
    band.style.setProperty("--line", spec.line);
    wash.style.background =
      `linear-gradient(90deg, transparent 0%, ${spec.line}22 24%, ${spec.line}3a 50%, ${spec.line}22 76%, transparent 100%)`;
    tx.textContent = spec.text;

    // Reset to the fully-masked start state before revealing.
    wash.style.opacity = "0";
    topLine.style.transform = "scaleX(0)";
    bottomLine.style.transform = "scaleX(0)";
    tx.style.opacity = "0";
    tx.style.transform = `translate(-50%, -50%) translateX(-${FU_TEXT_SHIFT})`;

    layer.classList.add("active");
    if (!_followupSurfaceId) _followupSurfaceId = registerSurface({ kind: "initiative-banner" });

    // 1. Panel wash in.
    await wash.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: FU_WASH_MS, easing: "ease-out", fill: "forwards" }).finished;

    // SFX at the curtain reveal — cached buffer → instant, precise sync.
    if (sfx && spec.sfx) playRoundSfx(spec.sfx, 0.7);

    // 2. Curtain: both accent lines sweep open from the centre.
    await Promise.all([
      topLine.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { duration: FU_CURTAIN_MS, easing: EASE_ENERGETIC, fill: "forwards" }).finished,
      bottomLine.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { duration: FU_CURTAIN_MS, easing: EASE_ENERGETIC, fill: "forwards" }).finished,
    ]);

    // 3. Label slides in from the left + fades.
    await tx.animate([
      { opacity: 0, transform: `translate(-50%, -50%) translateX(-${FU_TEXT_SHIFT})` },
      { opacity: 1, transform: "translate(-50%, -50%) translateX(0)" },
    ], { duration: FU_TEXT_IN_MS, easing: EASE_ENERGETIC, fill: "forwards" }).finished;

    // 4. Hold.
    await sleep(holdMs);

    // 5. Label slides out to the opposite (right) side + fades.
    await tx.animate([
      { opacity: 1, transform: "translate(-50%, -50%) translateX(0)" },
      { opacity: 0, transform: `translate(-50%, -50%) translateX(${FU_TEXT_SHIFT})` },
    ], { duration: FU_TEXT_OUT_MS, easing: "ease-in", fill: "forwards" }).finished;

    // 6. Whole banner fades out (wash + both lines together).
    await Promise.all([
      wash.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FU_FADE_MS, easing: "ease-in", fill: "forwards" }).finished,
      topLine.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FU_FADE_MS, easing: "ease-in", fill: "forwards" }).finished,
      bottomLine.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FU_FADE_MS, easing: "ease-in", fill: "forwards" }).finished,
    ]);

    for (const el of [wash, topLine, bottomLine, tx]) el.getAnimations?.().forEach((a) => a.cancel());
    layer.classList.remove("active");
    if (_followupSurfaceId) { unregisterSurface(_followupSurfaceId); _followupSurfaceId = null; }
  } catch (e) {
    warn("playFollowupBannerLocal threw", e);
  }
}

// Dev/preview helper — render the follow-up initiative banner in ISOLATION on
// its own layer (never touches the docked round HUD), for tuning + smoke tests.
// `followup` is { kind:"initiative", side:"party"|"enemy" } | { kind:"ambush" }
// | { kind:"advantage" }. Local-only (no broadcast). Safe to call mid-battle.
export function previewInitiativeBanner(followup = { kind: "initiative", side: "party" }) {
  playFollowupBannerLocal(followup);
}

// ── public: fire from ROUND_START ─────────────────────────────────────────
// Render on THIS (GM) client + broadcast to all OTHERS. Fire-and-forget so the
// FSM is not blocked by the ~2.5s cinematic.
export function playRoundBanner({ round = 0, followup = null } = {}) {
  try {
    // Populate the icons from the LIVE combat before revealing them. The
    // dCombat start()/nextTurn turn-action hook normally builds them, but after
    // a resume the combat is RECONSTRUCTED (not start()ed) so that hook never
    // fired — without this re-snapshot the staggered reveal would animate an
    // empty set (the F5-into-round-0 → "ROUND 1 with no icons" bug). Harmless
    // in the normal path (re-snapshots the same data). GM-only inside.
    try { globalThis.FUCompanion?.api?.experimental?.battleDirector?.refreshTurnActions?.(); }
    catch (_e) {}
    const payload = { round, ...(followup ? { followup } : {}) };
    // Capture the GM-local completion so the caller (ROUND_START) can hand the
    // director a signal to gate the enemy autopilot on. Still non-blocking: the
    // broadcast + return happen immediately; only the RETURNED promise waits.
    const localDone = playRoundBannerLocal(payload);
    try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
    catch (e) { warn("director-round-banner: broadcast failed", e); }
    return localDone;
  } catch (e) {
    warn("playRoundBanner threw", e);
    return Promise.resolve();
  }
}

// ── public: restore the docked banner + icons after a reload / rewind ──────
// The banner + turn-action icons are client DOM, wiped on F5, and the resume
// path never re-enters ROUND_START (which is what normally draws them). Call
// this from resumeFromSavedState with the reconstructed dCombat to bring the
// HUD back. `animate:true` (F5) replays the full enter→dock cinematic; false
// (rewind) snaps straight to docked. Awaited so the caller can let the
// animation finish before transitioning into the resumed state. GM broadcasts
// to all clients (the icon snapshot + banner both fan out).
export async function showRoundBannerForResume(dCombat, { animate = true } = {}) {
  try {
    const round = Number(dCombat?.round) || 0;
    if (round < 1) {
      // Rewound to before Round 1 (start of conflict, round 0). There's no
      // round to show — clear any stale docked banner + icons so the old
      // ROUND N HUD doesn't linger. It re-appears when Round 1 actually
      // begins (ROUND_START → playRoundBanner). Broadcasts the clear too.
      hideRoundBanner();
      return;
    }
    // Populate the icons FIRST so they're present when the band docks. GM-only
    // inside refreshTurnActions; it also broadcasts the icon snapshot.
    refreshTurnActions(dCombat);
    const payload = { round, instant: !animate };
    try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
    catch (e) { warn("showRoundBannerForResume: broadcast failed", e); }
    await playRoundBannerLocal(payload);
  } catch (e) {
    warn("showRoundBannerForResume threw", e);
  }
}

// Build a turn-action snapshot from a PERSISTED director-state (scene flag),
// resolving each combatant's token/actor locally. Unlike buildTurnActionSnapshot
// (which walks the live GM-side dCombat object) this reads the serialized shape
// { combatants:[{ id, tokenUuid, side, turnsRemaining, ... }], currentCombatantId },
// so a player client can render the HUD without the GM's in-memory dCombat.
async function buildSnapshotFromState(dc) {
  const out = [];
  const activeId = dc?.currentCombatantId ?? null;
  for (const sc of dc?.combatants ?? []) {
    let td = null;
    try { td = await fromUuid(sc.tokenUuid); } catch (_e) {}
    // fromUuid on a Token UUID yields a TokenDocument; tolerate a Token too.
    if (td && td.documentName !== "Token") td = td.document ?? td;
    const baseActor = game.actors?.get?.(td?.actorId) ?? null;
    // Shim shaped like a live combatant so the crisis/defeated HP helpers work.
    const shim = { tokenDoc: td, actorDoc: td?.actor ?? baseActor ?? null };
    out.push({
      id: sc.id,
      side: sc.side === "enemy" ? "enemy" : "party",
      name: td?.name ?? sc.name ?? "",
      img: td?.texture?.src ?? baseActor?.img ?? null,
      // Remaining activations this round → one lineup icon each (champions > 1).
      turnsRemaining: Number(sc.turnsRemaining) || 0,
      active: !!activeId && sc.id === activeId,
      crisis: combatantInCrisis(shim),
      defeated: combatantDefeated(shim),
      tokenUuid: sc.tokenUuid ?? null,
      focus: normalizeIconFocus(baseActor?.getFlag?.(MODULE_ID, "iconFocus")),
    });
  }
  return out;
}

// ── public: PLAYER-side self-restore from the persisted scene flag ─────────
// The round HUD is client DOM, wiped on F5. On the GM it's redrawn by the GM
// resume path (which also broadcasts). A PLAYER reload gets no broadcast (the
// GM didn't change anything), so the HUD would stay blank until the next GM
// action. This restores it LOCALLY from the saved director-state — no GM, no
// broadcast. Defaults to `instant` (just show the docked HUD, no cinematic/SFX).
export async function showRoundBannerForResumeFromState(state, { animate = false } = {}) {
  try {
    const dc = state?.dCombat;
    const round = Number(dc?.round) || 0;
    // Nothing to show unless a round is actually in progress.
    if (!dc || !dc.started || dc.ended || round < 1) return;
    const snap = await buildSnapshotFromState(dc);
    renderTurnActionsLocal(snap);          // local-only renderer (no broadcast)
    await playRoundBannerLocal({ round, instant: !animate }); // local-only
  } catch (e) {
    warn("showRoundBannerForResumeFromState threw", e);
  }
}

// ── public: battle-start flash (fire at the start of battle) ──────────────
// Broadcast to all OTHER clients, then play + AWAIT locally. Unlike
// playRoundBanner this is awaited by the caller (runDirectorInit) so the
// battle process only begins once the flash has entered, held, and exited.
export async function playBattleStartBanner({ text = "BATTLE START", holdMs = 900 } = {}) {
  try {
    const payload = { text, holdMs };
    try { _socket?.executeForOthers?.(ACTION_BATTLE_START, payload); }
    catch (e) { warn("director-round-banner: battle-start broadcast failed", e); }
    await playBattleStartBannerLocal(payload);
  } catch (e) {
    warn("playBattleStartBanner threw", e);
  }
}

// ── Turn-action tracker ───────────────────────────────────────────────────
// Creature icons flanking ROUND X: enemies on the left, party on the right.
// Each icon is the token sprite masked into a trapezoid; there is ONE icon per
// PENDING activation, so as a creature spends its turn action(s) its icons are
// removed one by one (a champion with N activations starts with N). Driven by
// the `fu-director-turnactions` hook (director-combat.js fires it on start /
// nextTurn / round reset); the GM builds a snapshot, renders locally, and
// broadcasts to every client.

export function isVideoSrc(u) {
  return /\.(webm|mp4|m4v|ogv)(\?|#|$)/i.test(String(u ?? ""));
}

// Per-actor focal point for the masked icon — which point of the token sprite
// sits at the centre of the crop, plus the zoom. Default (50% 0%, ×2) frames
// the top-centre, which clips actors whose face sits lower (Hina, Blanche) to
// the ears. Override per actor via flags.fabula-ultima-companion.iconFocus.
export const ICON_FOCUS_DEFAULT = Object.freeze({ x: 50, y: 0, zoom: 2 });

const _clampPct = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : d; };
const _clampZoom = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(6, Math.max(1, n)) : d; };

export function normalizeIconFocus(raw) {
  return {
    x: _clampPct(raw?.x, ICON_FOCUS_DEFAULT.x),
    y: _clampPct(raw?.y, ICON_FOCUS_DEFAULT.y),
    zoom: _clampZoom(raw?.zoom, ICON_FOCUS_DEFAULT.zoom),
  };
}

// Apply a focus to a masked media element. object-position picks WHICH point
// of the cover-cropped sprite is anchored; matching transform-origin keeps
// that same point fixed while scale() zooms in. Reused by the focus tuner so
// its preview matches the live icon exactly.
export function applyIconFocusStyle(media, focus) {
  if (!media) return;
  const f = normalizeIconFocus(focus);
  media.style.objectPosition = `${f.x}% ${f.y}%`;
  media.style.transformOrigin = `${f.x}% ${f.y}%`;
  media.style.transform = `scale(${f.zoom})`;
}

function buildTurnActionIcon(c) {
  const icon = document.createElement("div");
  icon.className = "fu-rb-ta-icon" + (c.crisis ? " crisis" : "") + (c.defeated ? " defeated" : "");
  // Unique per activation icon (id#activationIndex) so multi-activation creatures
  // get one addressable icon each.
  icon.dataset.cid = `${c.id}#${c._act ?? 0}`;
  icon.title = c.name ?? "";
  let media;
  if (isVideoSrc(c.img)) {
    media = document.createElement("video");
    media.autoplay = true; media.loop = true; media.muted = true;
    media.playsInline = true; media.setAttribute("playsinline", "");
  } else {
    media = document.createElement("img");
    media.draggable = false;
  }
  media.className = "fu-rb-ta-media";
  if (c.img) media.src = c.img;
  applyIconFocusStyle(media, c.focus);
  // icon (rect, owns glow/opacity) > frame (gold trapezoid) > wrap (inset
  // trapezoid that masks the sprite, leaving the gold rim) > media.
  const frame = document.createElement("div"); frame.className = "fu-rb-ta-frame";
  const wrap = document.createElement("div"); wrap.className = "fu-rb-ta-wrap";
  wrap.appendChild(media);
  frame.appendChild(wrap);
  icon.appendChild(frame);
  // Enemy icons open that monster's Monster Encyclopedia page on click; a book
  // badge fades in on hover as the affordance (see CSS, keyed off .left group).
  if (c.side === "enemy" && c.tokenUuid) {
    // Small book badge at the top-right corner — the persistent affordance when
    // NOT hovering (hidden on hover, where the full overlay takes over).
    const bookMini = document.createElement("div");
    bookMini.className = "fu-rb-ta-book-mini";
    bookMini.innerHTML = `<i class="fas fa-book"></i>`;
    icon.appendChild(bookMini);
    const book = document.createElement("div");
    book.className = "fu-rb-ta-book";
    book.innerHTML = `<i class="fas fa-book"></i>`;
    icon.appendChild(book);
    icon.addEventListener("click", (ev) => {
      ev.stopPropagation();
      try { globalThis.FUCompanion?.api?.encyclopedia?.openEncyclopediaForToken?.(c.tokenUuid); }
      catch (e) { warn("turn-action icon: encyclopedia open failed", e); }
    });
  }
  return icon;
}

// Populate the centre spotlight with the active turn-taker (lifted out of its
// side row), or a neutral "awaiting" placeholder when no one is acting. Rebuilds
// the inner media only when the subject changes (keyed on id+img); crisis /
// defeated state classes toggle every call, and the focal crop re-applies so a
// tuner change updates without a rebuild. Mirrors buildTurnActionIcon's frame.
// Build the spotlight's inner frame/wrap/media (or placeholder) for `active`.
function buildSpotlightContent(sp, active) {
  const hasMedia = !!(active && active.img);
  sp.classList.toggle("placeholder", !hasMedia);
  sp.replaceChildren();
  const frame = document.createElement("div"); frame.className = "fu-rb-spot-frame";
  const wrap = document.createElement("div"); wrap.className = "fu-rb-spot-wrap";
  if (hasMedia) {
    let media;
    if (isVideoSrc(active.img)) {
      media = document.createElement("video");
      media.autoplay = true; media.loop = true; media.muted = true;
      media.playsInline = true; media.setAttribute("playsinline", "");
    } else {
      media = document.createElement("img");
      media.draggable = false;
    }
    media.className = "fu-rb-ta-media";
    media.src = active.img;
    applyIconFocusStyle(media, active.focus);
    wrap.appendChild(media);
  } else {
    const ph = document.createElement("div");
    ph.className = "fu-rb-spot-ph";
    ph.innerHTML = `<i class="fas fa-hourglass-half"></i>`;
    wrap.appendChild(ph);
  }
  frame.appendChild(wrap);
  sp.appendChild(frame);
}

function setSpotlight(fu, active, animate) {
  const sp = fu?.spotlight;
  if (!sp) return;
  const hasMedia = !!(active && active.img);
  const key = active ? `A:${active.id}:${active.img ?? ""}` : "P";
  sp.classList.toggle("crisis", !!active?.crisis);
  sp.classList.toggle("defeated", !!active?.defeated);
  // Enemy in the spotlight → mirror to face left + red appear-glow (vs gold).
  sp.classList.toggle("enemy", active?.side === "enemy");
  if (fu.spotKey === key) {
    // Same subject — just re-apply focus (tuner Save) without a rebuild.
    const media = sp.querySelector(".fu-rb-ta-media");
    if (media && active) applyIconFocusStyle(media, active.focus);
    return;
  }
  const prevKey = fu.spotKey;
  fu.spotKey = key;
  // Mid-round turn change while the spotlight is docked + visible: shrink + fade
  // the OLD actor OUT (normal easing), swap, then grow + fade the NEW actor IN
  // with a glow (snappy easing). prevKey "" = first set / not yet shown → no
  // animation (the dock slide-in handles the initial appearance).
  const swap = animate && prevKey !== "" && sp.classList.contains("shown") && sp.children.length;
  for (const a of sp.getAnimations?.() ?? []) a.cancel();
  if (!swap) { buildSpotlightContent(sp, active); return; }
  const out = sp.animate(
    [{ opacity: 1, transform: "translate(-50%, 0) scale(1)" },
     { opacity: 0, transform: "translate(-50%, 0) scale(.55)" }],
    { duration: 200, easing: EASE_EXIT, fill: "forwards" });
  out.finished.then(() => {
    buildSpotlightContent(sp, active);
    out.cancel(); // drop the opacity:0 fill so the in-animation can take over
    sp.animate(
      [{ opacity: 0, transform: "translate(-50%, 0) scale(.55)" },
       { opacity: 1, transform: "translate(-50%, 0) scale(1)" }],
      { duration: 300, easing: EASE_ENERGETIC });
    if (hasMedia) {
      sp.classList.add("fu-rb-spot-glow");
      setTimeout(() => sp.classList.remove("fu-rb-spot-glow"), 2400);
    }
  }).catch(() => {});
}

// Animate a lineup icon OUT (its activation was taken): collapse its layout
// footprint (margins → -half its width) while it shrinks + fades, so the flex
// row slides the remaining icons toward the centre to fill the gap. Normal ease.
function exitIconAnimated(el, left) {
  if (el.classList.contains("fu-rb-exit")) return;
  el.classList.add("fu-rb-exit");
  el.style.pointerEvents = "none";
  const half = ICON_W_VH / 2;
  const base = left ? "scaleX(-1) " : "";
  el.animate(
    [{ transform: base + "scale(1)", opacity: 1 },
     { marginLeft: `-${half}vh`, marginRight: `-${half}vh`, transform: base + "scale(.3)", opacity: 0 }],
    { duration: ICON_ANIM_MS, easing: EASE_EXIT, fill: "forwards" });
  setTimeout(() => el.remove(), ICON_ANIM_MS + 60);
}

// Animate a freshly-added lineup icon IN (a new activation): it slides in from
// the OUTER end of its side ("getting in line") while growing + fading, and
// glows for a couple seconds. Snappy easing. The slot is already reserved
// (full width), so neighbours don't move — it just fills the outer empty space.
function enterIconAnimated(el, left) {
  const base = left ? "scaleX(-1) " : "";
  const fromX = `${left ? "-" : ""}${(ICON_W_VH * 0.8).toFixed(2)}vh`;
  el.animate(
    [{ opacity: 0, transform: `translateX(${fromX}) ${base}scale(.6)` },
     { opacity: 1, transform: `${base}scale(1)` }],
    { duration: ICON_ANIM_MS, easing: EASE_ENERGETIC });
  el.classList.add("fu-rb-enter-glow");
  setTimeout(() => el.classList.remove("fu-rb-enter-glow"), ICON_ENTER_GLOW_MS);
}

// Reconcile one side's group to the desired activation icons WITH animation:
// removed icons animate out (slide-fill), added icons animate in (at the end),
// kept icons stay (and follow the reflow driven by the exiting icons' margins).
function reconcileGroupAnimated(group, desired, left) {
  const desiredSet = new Set(desired.map((c) => `${c.id}#${c._act}`));
  // EXIT: live (non-exiting) icons no longer desired.
  for (const el of [...group.children]) {
    if (el.classList.contains("fu-rb-exit")) continue;
    if (!desiredSet.has(el.dataset.cid)) exitIconAnimated(el, left);
  }
  // ENTER + order: walk desired, reuse kept, create + animate missing.
  let prev = null;
  for (const c of desired) {
    const cid = `${c.id}#${c._act}`;
    let el = null;
    for (const child of group.children) {
      if (!child.classList.contains("fu-rb-exit") && child.dataset.cid === cid) { el = child; break; }
    }
    if (!el) {
      el = buildTurnActionIcon(c);
      el.classList.add("shown");
      if (prev) prev.after(el); else group.prepend(el);
      enterIconAnimated(el, left);
    }
    prev = el;
  }
}

// Render. `opts.animate` (mid-round turn change, via the turnactions hook) runs
// the enter/exit/slide animations; otherwise (round start / resume) it's a
// plain build that the staggered reveal + dock slide handle. Geometry (bar
// width / spacer / ray) is set only on the plain path so the bar stays put
// while icons slide; crisis/defeated are cheap class toggles when membership
// is unchanged.
function renderTurnActionsLocal(combatants = [], opts = {}) {
  try {
    const animate = !!opts.animate;
    const layer = ensureLayer();
    const { leftGroup, rightGroup } = layer.__fu;
    if (!leftGroup || !rightGroup) return;
    const list = Array.isArray(combatants) ? combatants : [];
    // The current turn-taker is LIFTED out of its side row into the centre
    // spotlight (or a placeholder when no one is acting). The side rows render
    // everyone else; the active one returns to its slot when its turn ends.
    const active = list.find((c) => c.active) ?? null;
    setSpotlight(layer.__fu, active, animate);
    // ONE lineup icon per PENDING activation (not per creature): a creature with
    // multiple activations (a champion) shows that many icons, and each is
    // REMOVED as its activation is taken. turnsRemaining counts a creature's
    // remaining activations this round; the active creature's CURRENT activation
    // is shown in the spotlight, so it contributes (turnsRemaining - 1) lineup
    // icons. Fully-spent creatures contribute none. `_act` makes each icon's id
    // unique (id#i) for the diff key + per-icon DOM lookup.
    const sideList = [];
    for (const c of list) {
      const n = Math.max(0, (Number(c.turnsRemaining) || 0) - (c.active ? 1 : 0));
      for (let i = 0; i < n; i++) sideList.push({ ...c, _act: i });
    }
    const leftDesired = sideList.filter((c) => c.side === "enemy");
    const rightDesired = sideList.filter((c) => c.side !== "enemy");
    const leftN = leftDesired.length;
    const rightN = rightDesired.length;
    const animatedPath = animate && _iconsRevealed;

    // Geometry — set only on the PLAIN path (round start / resume). The animated
    // mid-round path leaves the bar width untouched so it stays put while icons
    // slide; a removed icon collapses its own footprint to fill the gap.
    if (!animatedPath) {
      // The spacer reserves the bar's centre gap for the spotlight. Narrowed by
      // 2×SLANT so the innermost icon on each side butts FLUSH against the
      // spotlight's slanted edge (collinear borders, no gap).
      if (layer.__fu.spacer) layer.__fu.spacer.style.width = `${SPOT_W_VH - 2 * SLANT_VH}vh`;
      // Reserve equal width for both sides (= the larger side's icon span) so
      // the spotlight stays screen-centred with uneven counts.
      const maxN = Math.max(leftN, rightN);
      // Icons overlap by SLANT_VH (tessellation): maxN icons span
      // maxN*ICON_W_VH - (maxN-1)*SLANT_VH.
      const grpVh = maxN > 0 ? (maxN * ICON_W_VH - (maxN - 1) * SLANT_VH) : 0;
      leftGroup.style.minWidth = `${grpVh}vh`;
      rightGroup.style.minWidth = `${grpVh}vh`;
      // Single gold ray spans the FULL bar width (both groups + the centre
      // spacer) so the gold runs unbroken through the middle.
      const barVh = 2 * grpVh + (SPOT_W_VH - 2 * SLANT_VH);
      setRayGeometry(layer.__fu.ray, barVh);
    }

    // Key encodes one entry per pending activation (id#i) + img, so it changes —
    // and an icon is added/removed — whenever an activation is taken/granted.
    const key = sideList.map((c) => `${c.side === "enemy" ? "L" : "R"}:${c.id}#${c._act}:${c.img ?? ""}`).join("|");
    // Count only LIVE (non-exiting) children, so a still-animating exit icon
    // doesn't trip the desync rebuild.
    const liveCount = (g) => [...g.children].filter((e) => !e.classList.contains("fu-rb-exit")).length;
    const desync = liveCount(leftGroup) !== leftN || liveCount(rightGroup) !== rightN;
    if (key !== layer.__fu.turnActionKey || desync) {
      if (animatedPath) {
        reconcileGroupAnimated(leftGroup, leftDesired, true);
        reconcileGroupAnimated(rightGroup, rightDesired, false);
      } else {
        leftGroup.replaceChildren();
        rightGroup.replaceChildren();
        for (const c of sideList) {
          const grp = c.side === "enemy" ? leftGroup : rightGroup;
          const iconEl = buildTurnActionIcon(c);
          // If icons are already revealed (mid-battle membership change), show
          // the new one immediately; otherwise leave it hidden for the staggered
          // reveal the docked banner triggers.
          if (_iconsRevealed) iconEl.classList.add("shown");
          grp.appendChild(iconEl);
        }
      }
      layer.__fu.turnActionKey = key;
    } else {
      for (const c of sideList) {
        const grp = c.side === "enemy" ? leftGroup : rightGroup;
        const cid = `${c.id}#${c._act}`;
        const sel = `.fu-rb-ta-icon[data-cid="${(window.CSS?.escape?.(cid)) ?? cid}"]:not(.fu-rb-exit)`;
        const icon = grp.querySelector(sel);
        if (!icon) continue;
        icon.classList.toggle("crisis", !!c.crisis); // crisis warning tint
        icon.classList.toggle("defeated", !!c.defeated); // HP-0 grey + skull
        // Re-apply focus too, so a focal-point change (tuner Save) updates the
        // existing icons even though membership is unchanged.
        const media = icon.querySelector(".fu-rb-ta-media");
        if (media) applyIconFocusStyle(media, c.focus);
      }
    }
  } catch (e) {
    warn("renderTurnActionsLocal threw", e);
  }
}

function clearTurnActionsLocal() {
  _iconsRevealed = false;
  _revealGen++; // cancel any pending staggered reveal
  unlightEnds();
  const layer = document.getElementById(LAYER_ID);
  if (!layer?.__fu) return;
  layer.__fu.leftGroup?.replaceChildren();
  layer.__fu.rightGroup?.replaceChildren();
  // Clear the centre spotlight too (battle end / hide).
  layer.__fu.spotlight?.replaceChildren();
  layer.__fu.spotlight?.classList.remove("shown", "crisis", "defeated", "placeholder");
  layer.__fu.turnActionKey = "";
  layer.__fu.spotKey = "";
}

// ── icon reveal helpers ────────────────────────────────────────────────────
// All operate on the icons currently in the banner's two groups.
function _allIcons() {
  const layer = document.getElementById(LAYER_ID);
  const fu = layer?.__fu;
  if (!fu) return [];
  return [...(fu.leftGroup?.children ?? []), ...(fu.rightGroup?.children ?? [])];
}

// Gradient for the single full-width gold ray. The element is positioned by CSS
// (left/right: -RAY_VH), so its rendered width is barVh + 2*RAY_VH. The gradient
// is SYMMETRIC: transparent at both outer tips, fading up to solid gold over the
// RAY_VH tails, then solid gold across the whole body — INCLUDING the centre,
// where it used to be masked. barVh = the bar's content width (both groups + the
// centre spacer).
function setRayGeometry(el, barVh) {
  if (!el) return;
  const total = barVh + 2 * RAY_VH;
  // Fraction of the strip (from each outer tip) that is the fading tail.
  const tailPct = total > 0 ? Math.round((RAY_VH / total) * 100) : 0;
  const midPct = Math.round(tailPct * 0.55); // soft mid-stop inside each tail
  el.style.background =
    `linear-gradient(90deg, transparent 0%, ${END_GOLD_FADE} ${midPct}%, ${END_GOLD} ${tailPct}%, ` +
    `${END_GOLD} ${100 - tailPct}%, ${END_GOLD_FADE} ${100 - midPct}%, transparent 100%)`;
}

// Fire the ray once (shoot open from the centre + settle, then stay static).
// Remove + re-add `.lit` with a reflow so the entrance restarts each round.
function lightEnds() {
  const el = document.getElementById(LAYER_ID)?.__fu?.ray;
  if (!el) return;
  el.classList.remove("lit");
  void el.offsetWidth; // force reflow so re-adding restarts the animation
  el.classList.add("lit");
}
function unlightEnds() {
  document.getElementById(LAYER_ID)?.__fu?.ray?.classList.remove("lit");
}


// Hide every icon (used at the start of the banner entrance). Bumps the
// reveal generation so a stagger still in flight from a prior round is voided.
function hideTurnActionIcons() {
  _iconsRevealed = false;
  _revealGen++;
  for (const ic of _allIcons()) ic.classList.remove("shown", "glow");
  // Reset the centre to its "hero" state — spotlight hidden.
  const fu = document.getElementById(LAYER_ID)?.__fu;
  fu?.spotlight?.classList.remove("shown");
  unlightEnds();
}

// Show every icon at once (rewind / instant restore — no animation).
function showAllTurnActionIcons() {
  _revealGen++;
  _iconsRevealed = true;
  for (const ic of _allIcons()) ic.classList.add("shown");
  // Docked centre: spotlight shown + ROUND N at its small resting transform.
  const fu = document.getElementById(LAYER_ID)?.__fu;
  if (fu?.tx) {
    fu.tx.style.opacity = "1";
    fu.tx.style.transform = `translate(-50%, calc(-50% + ${TX_DOCK_SHIFT_VH}vh)) scale(${TX_DOCK_SCALE})`;
  }
  fu?.spotlight?.classList.add("shown");
  lightEnds();
}

// Reveal icons one-by-one from the middle outward — the inner-most icon of
// each side fades in first (both sides together), then step outward. Each
// gets a one-second glow as it appears.
function revealTurnActionIconsStaggered() {
  const layer = document.getElementById(LAYER_ID);
  const fu = layer?.__fu;
  if (!fu) return;
  const STEP_MS = 140;
  const gen = ++_revealGen;
  _iconsRevealed = true;
  // Left group renders left→right, so its middle-most icon is the LAST child;
  // reverse it so index 0 is the one nearest the centre. Right group's
  // middle-most is already its first child.
  const left = Array.from(fu.leftGroup?.children ?? []).reverse();
  const right = Array.from(fu.rightGroup?.children ?? []);
  const revealOne = (ic, delay) => setTimeout(() => {
    if (gen !== _revealGen) return; // superseded by a newer round / hide
    ic.classList.add("shown", "glow");
    setTimeout(() => { if (gen === _revealGen) ic.classList.remove("glow"); }, 1000);
  }, delay);
  left.forEach((ic, i) => revealOne(ic, i * STEP_MS));
  right.forEach((ic, i) => revealOne(ic, i * STEP_MS));
  // After the wave reaches the OUTER edge of the wider side (counting the empty
  // gap on the shorter side), throw the ray off both bar ends once.
  const maxN = Math.max(left.length, right.length);
  setTimeout(() => { if (gen === _revealGen) lightEnds(); }, maxN * STEP_MS);
}

// HP read from the LIVE combatant actor (the token's synthetic actor for
// unlinked tokens) so each copy's own HP is used, not the shared base actor.
function combatantHp(c) {
  const actor = c?.tokenDoc?.actor ?? c?.actorDoc ?? null;
  if (!actor) return null;
  const cur = Number(foundry.utils.getProperty(actor, "system.props.current_hp"));
  const max = Number(foundry.utils.getProperty(actor, "system.props.max_hp"));
  return { cur, max };
}

// Crisis (Fabula Ultima) = current HP <= ceil(max HP / 2).
function combatantInCrisis(c) {
  const hp = combatantHp(c);
  if (!hp || !Number.isFinite(hp.cur) || !(hp.max > 0)) return false;
  return hp.cur <= Math.ceil(hp.max / 2);
}

// Defeated = HP at 0 (still on the scene — e.g. a downed PC that isn't removed).
function combatantDefeated(c) {
  const hp = combatantHp(c);
  return !!hp && Number.isFinite(hp.cur) && hp.cur <= 0;
}

// GM: snapshot dCombat's combatants into the slim shape the renderer needs.
function buildTurnActionSnapshot(dCombat) {
  const out = [];
  const activeId = dCombat?.currentCombatantId ?? null;
  for (const c of (dCombat?.combatants ?? [])) {
    const td = c.tokenDoc;
    // Focal point is stored on the BASE (world) actor so every copy of a
    // monster shares one setting — read it from there, not the per-token
    // synthetic actor (which is unique per unlinked token).
    const baseActor = game.actors?.get?.(td?.actorId) ?? c.actorDoc;
    out.push({
      id: c.id,
      side: c.side === "enemy" ? "enemy" : "party",
      // Prefer the TOKEN name (carries the A/B/C suffix) over the actor name.
      name: td?.name ?? c.name ?? "",
      img: td?.texture?.src ?? c.actorDoc?.img ?? null,
      // Remaining activations this round → one lineup icon each (champions > 1).
      turnsRemaining: Number(c.turnsRemaining) || 0,
      active: !!activeId && c.id === activeId,
      crisis: combatantInCrisis(c),
      defeated: combatantDefeated(c),
      // Token UUID so enemy icons can open that monster's encyclopedia page.
      tokenUuid: c.tokenUuid ?? td?.uuid ?? null,
      focus: normalizeIconFocus(baseActor?.getFlag?.(MODULE_ID, "iconFocus")),
    });
  }
  return out;
}

// GM: build the snapshot, render locally, and broadcast to every other client.
// Fired from the `fu-director-turnactions` hook (mid-round turn changes →
// `animate:true`) and from round-start/resume (`animate:false`, plain). No-op
// for non-GM (the hook only fires where dCombat lives, but guard anyway).
export function refreshTurnActions(dCombat, { animate = false } = {}) {
  try {
    if (!game.user?.isGM) return;
    _lastDCombat = dCombat ?? _lastDCombat;
    const snap = buildTurnActionSnapshot(dCombat);
    renderTurnActionsLocal(snap, { animate });
    try { _socket?.executeForOthers?.(ACTION_TURNACTIONS, { list: snap, animate }); }
    catch (e) { warn("refreshTurnActions broadcast failed", e); }
  } catch (e) {
    warn("refreshTurnActions threw", e);
  }
}

// ── public: clear the docked banner at battle end ─────────────────────────
// Fade out + remove on THIS client and broadcast the same to all others, so
// the persistent round indicator never lingers after the director stops.
export function hideRoundBanner() {
  try {
    exitRoundBannerLocal({ animate: true });
    clearTurnActionsLocal();
    try { _socket?.executeForOthers?.(ACTION_HIDE); }
    catch (e) { warn("director-round-banner: hide broadcast failed", e); }
  } catch (e) {
    warn("hideRoundBanner threw", e);
  }
}
