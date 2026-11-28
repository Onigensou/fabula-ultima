// status-cues.js — the token visual cues of the token status plan "G + E"
// (phase 6; approved look in claude.ai/artifact/6yk4Vym4JdmTq8fP7LuGwX).
//
// In a battle a token shows NO effect icons; a status shows on the token only
// through its own cue (status-classifier.js STATUS_CUES):
//
//   burn      flames rising off the body, warm underlight at the feet   + warm wash
//   blind     smoky black fog over the eyes, wisps curling off (FF9 Darkness)
//   poison    green bubbles rising and popping (Envenomed)            + green wash
//   wet       drops falling from the head and shoulders, ripples at the feet + cool wash
//   paralyze  yellow sparks crackling around the body                 + pale-yellow wash
//   silence   speech bubble beside the head with "…" filling in
//   provoked  throbbing red anger vein at the temple (taunts too)
//   sleep     three Zs drifting up from the head
//   stun      three yellow stars circling the head (Stunned, 2026-11-27)
//   berserk   red rage aura: a throbbing red underglow, red streaks ripping up off the body + red wash
//   zombie    deep-purple miasma rising from the feet up the body, a third of it BEHIND the
//             body (status-cues-back.js) + the Zombie grade (token-tint.js grade mode: a
//             violet-grey keep-lightness tint, gamma lift and a rim glow). The STATUS only:
//             a creature that is Undead by species draws nothing (2026-11-28).
//   bleed     a pierced heart beside the head on its back side, red glow pulsing (2026-11-28)
//   armorbreak / magicbreak   beside the chest on the unit's back side, just outside the
//             frame: the word DEF / MDEF + a small bobbing down arrow, no tile or frame,
//             orange = DEF (Armor Break, and Rakshasa's Crippled), blue = M.DEF (Magic
//             Break); both held = stacked.
//             Font = the damage-number tag face. Replaced a cracked-cuirass silhouette
//             (user pick, 2026-11-10): the word reads without learning an icon.
//
// Everything else draws nothing: the HUD pips, the unit label and the pop text
// carry it (see the fallback rules on the mockup page).
//
// CLIP CUES (data-driven, any effect): an effect can carry its own looping clip
// in flags.fabula-ultima-companion.cueClip = { src, x, y, size, angle, ax, ay,
// period, opacity } — x/y = 0..1 of the sprite as drawn facing right, size =
// clip height as a share of the sprite height, angle in degrees, (ax, ay) the
// clip's own anchor, period = ms between plays. First user: Asura's four element
// Marks, each playing RPG Maker MV's elemental slash along its own blade
// (approved 2026-11-09). When every member of the effects' poseCombo set is held
// (all four Marks = Asura Strike ready) the clips play faster.
//
// HOW
//   - Particles / marks: one DOM layer per token, docked every frame to the
//     RENDERED sprite rect (unit-anchors.js), the same pattern as brand-mark /
//     aspect-aura. Rebuilt only when the cue set changes or the sprite's size
//     changes by more than 8% (zoom).
//   - Washes: token-tint.js does the body tint (it already composes with the
//     document tint, fades, survives F5 and clones into cinematics); this module
//     registers itself as its status tint provider. An AE with its own
//     tokenTint flag still wins.
//   - Head point: top-centre of the sprite, eyes at 15% of its height. A
//     creature whose head is elsewhere (a quadruped) can carry an actor flag
//     flags.fabula-ultima-companion.cueHead = { x, y } in 0..1 of the sprite
//     as drawn facing right; mirrored tokens flip x.
//   - Hidden during action cinematics with the brand marks
//     ("fuBattleMarksHidden"), and outside battle.
//
// Per client, display only: no socket, no document writes.
//
// Not done (v1): stopping the idle bounce while Paralyzed (the idle API has
// no local pause yet); depth — the layer sits above every sprite, so a back
// unit's flames can draw over a front unit.

import { log, warn } from "./logger.js";
import { cueOf } from "./status-classifier.js";
import { battleActive } from "./battle-focus.js";
import { spriteRect } from "./unit-anchors.js";
import { setStatusTintProvider, syncActorTint, makeGradeSpec } from "./token-tint.js";
import { installBackCues, syncBackCues, setBackCuesHidden, miasmaPuffs } from "./status-cues-back.js";
import { installChargeOrbitFx } from "./charge-orbit-fx.js";
import { installSlayerFx } from "./slayer-fx.js";
import { applySpellFencerCues, sfCueCss, sfCueHTML } from "./spell-fencer-cues.js";

const NS = "fabula-ultima-companion";
const ROOT_ID = "fu-status-cue-root";
const STYLE_ID = "fu-status-cue-style";
const REF_H = 250;                 // the sprite height the particle sizes were tuned at
const EYE_Y = 0.15;

// ── Zombie + Bleed: ONE constants block, copied from the approved mockup ─────
// claude.ai/artifact/6yk4Vym4JdmTq8fP7LuGwX (page v38), sections "Zombie" and
// "Bleed", both "Approved 2026-11-28". Names follow the mockup's config (its LOCKED /
// DEF objects). Sizes are px at a 250 px sprite (REF_H) and scale with --k.
export const ZOMBIE_LOOK = Object.freeze({
  // Tint (token-tint.js grade mode): blend "Colour, keep lightness"; base sprite
  // saturation 2, contrast 1, drain 0, exposure 0.64; tint violet-grey #a99fbe turned
  // +60°, amount 1, brightness lift 0, gamma 1.38; rim glow amount 1, size 6.5 px.
  grade: Object.freeze({ blend: "col", sat: 2, con: 1, drain: 0, exp: 0.64, tintHex: "#a99fbe", hue: 60, str: 1, bright: 0,
    gamma: 1.38, glow: 1, glowPx: 6.5, refH: REF_H }),
  // Miasma: coverage 0.7 (feet → body), density 19, particle size 2×, drift speed 2.5×,
  // opacity 0.4, colour Deep purple (rgb 96,58,140). ~1/3 of the body puffs go BEHIND.
  miasma: Object.freeze({ cov: 0.7, rate: 19, size: 2, spd: 2.5, mo: 0.4, mc: "96,58,140" }),
});
export const BLEED_LOOK = Object.freeze({
  // Heart icon, Blade line, Back of the head. is = icon size, ox = side offset, oy = height
  // above the eyes, gs = glow size, ga = glow strength, pp = pulse (s), lt = line thickness,
  // la = line angle (deg).
  icon: "heart", line: "blade", side: "back",
  is: 44, ox: 70, oy: 31, gs: 76, ga: 0.85, pp: 1.4, lt: 2.4, la: -55,
});

// Body washes (multiply, 0..1 strength). One per token: first in this order wins.
// Zombie first (mockup "One wash per token"): it lasts longest and changes what a heal does.
const WASH_ORDER = ["zombie", "burn", "berserk", "poison", "wet", "paralyze"];
const WASH = {
  zombie: { grade: ZOMBIE_LOOK.grade },
  burn: { color: "#ffc993", strength: 0.35 },
  berserk: { color: "#ff9a9a", strength: 0.3 },
  poison: { color: "#a6e58a", strength: 0.42 },
  wet: { color: "#a9c9ff", strength: 0.38 },
  paralyze: { color: "#fff0a6", strength: 0.3 },
};

const S = { recs: new Map(), ticker: null, hidden: false };   // tokenId -> { el, sig, w, h }

const SMOKE = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><filter id="s" x="0" y="0" width="120" height="120" filterUnits="userSpaceOnUse"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="4" seed="11" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 0.05  0 0 0 0 0.03  0 0 0 0 0.09  2.6 0 0 0 -0.7"/></filter><rect width="120" height="120" filter="url(#s)"/></svg>`);

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
#${ROOT_ID} { position: fixed; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: var(--z-index-canvas, 0); }
.fu-cue { position: absolute; left: 0; top: 0; pointer-events: none; transition: opacity 250ms ease; }
.fu-cue.is-anim-hidden { opacity: 0 !important; }
.fu-cue i, .fu-cue b, .fu-cue svg, .fu-cue span { position: absolute; display: block; }
/* berserk */
.fu-cue .bz { left: 4%; right: 4%; bottom: 0; height: 16%; border-radius: 50%;
  background: radial-gradient(ellipse, rgba(255,40,30,.75), rgba(200,0,0,0) 70%); animation: fuCueRage .5s ease-in-out infinite alternate; }
.fu-cue .bs { width: calc(var(--s) * .32); height: var(--s); margin-left: calc(var(--s) * -.16); border-radius: 50%;
  background: linear-gradient(to top, rgba(255,40,30,0), rgba(255,60,40,.95) 45%, #ffd0c0); filter: drop-shadow(0 0 3px rgba(255,30,20,.9));
  opacity: 0; animation: fuCueRageUp .7s ease-in infinite; }
@keyframes fuCueRage { from { opacity: .55; transform: scaleX(.92); } to { opacity: 1; transform: scaleX(1.06); } }
@keyframes fuCueRageUp { 0% { transform: translateY(0) scaleY(.4); opacity: 0; } 20% { opacity: 1; } 100% { transform: translateY(var(--rise)) scaleY(1.1); opacity: 0; } }
/* burn */
.fu-cue .fl { width: var(--s); height: calc(var(--s) * 1.5); margin-left: calc(var(--s) * -.5); border-radius: 50% 50% 42% 42% / 66% 66% 34% 34%;
  background: radial-gradient(ellipse at 50% 70%, #fffbe0 0, #ffe06a 20%, #ff9a2a 45%, rgba(255,80,10,.85) 60%, rgba(255,60,0,0) 74%);
  filter: drop-shadow(0 0 4px rgba(255,120,20,.9)); opacity: 0; animation: fuCueFlame 1.1s ease-out infinite; }
.fu-cue .gl { left: 8%; right: 8%; bottom: 1%; height: 13%; border-radius: 50%;
  background: radial-gradient(ellipse, rgba(255,150,40,.7), rgba(255,90,0,0) 70%); animation: fuCueFlick .45s steps(2) infinite alternate; }
@keyframes fuCueFlame { 0% { transform: translateY(0) scale(.7); opacity: 0; } 14% { opacity: 1; } 100% { transform: translateY(var(--rise)) scale(.15); opacity: 0; } }
@keyframes fuCueFlick { to { opacity: .55; } }
/* poison */
.fu-cue .bb { width: var(--s); height: var(--s); margin-left: calc(var(--s) * -.5); border-radius: 50%; border: 1.5px solid rgba(175,255,120,.95);
  background: radial-gradient(circle at 34% 30%, rgba(255,255,255,.9) 0 12%, rgba(120,230,80,.38) 30%, rgba(60,170,40,.16) 70%);
  box-shadow: 0 0 6px rgba(120,255,80,.6); opacity: 0; animation: fuCueBub 2.2s ease-in infinite; }
@keyframes fuCueBub { 0% { transform: translate(0,0) scale(.4); opacity: 0; } 15% { opacity: 1; }
  80% { transform: translate(var(--w), var(--rise)) scale(1); opacity: 1; } 90% { transform: translate(var(--w), var(--rise)) scale(1.45); opacity: .55; }
  100% { transform: translate(var(--w), var(--rise)) scale(1.7); opacity: 0; } }
/* wet */
.fu-cue .dr { width: calc(4px * var(--k)); height: calc(7px * var(--k)); margin-left: calc(-2px * var(--k));
  border-radius: 50% 50% 50% 50% / 65% 65% 35% 35%; background: linear-gradient(#eef8ff, #5fb2ff);
  box-shadow: 0 0 2px rgba(60,140,255,.85); opacity: 0; animation: fuCueDrip 1.4s cubic-bezier(.55,0,1,.6) infinite; }
.fu-cue .rp { bottom: 3%; width: calc(26px * var(--k)); height: calc(8px * var(--k)); margin-left: calc(-13px * var(--k));
  border-radius: 50%; border: 1.5px solid rgba(150,205,255,.85); opacity: 0; animation: fuCueRipple 1.4s ease-out infinite; }
@keyframes fuCueDrip { 0% { transform: translateY(0) scaleY(.5); opacity: 0; } 12% { opacity: 1; transform: translateY(0) scaleY(1); }
  30% { transform: translateY(3px); } 94% { opacity: .95; } 100% { transform: translateY(var(--f)); opacity: 0; } }
@keyframes fuCueRipple { 0% { transform: scale(.3); opacity: 0; } 20% { opacity: .9; } 100% { transform: scale(1.5); opacity: 0; } }
/* paralyze */
.fu-cue .zp { width: calc(18px * var(--k)); height: calc(28px * var(--k)); overflow: visible; opacity: 0; animation: fuCueZap 1.6s steps(1) infinite;
  filter: drop-shadow(0 0 2px #ffe94a) drop-shadow(0 0 6px #ffb800); }
.fu-cue .zp polyline { fill: none; stroke: #fffbd0; stroke-width: 2.4; stroke-linejoin: round; stroke-linecap: round; }
@keyframes fuCueZap { 0% { opacity: 0; } 8% { opacity: 1; } 13% { opacity: 0; } 17% { opacity: 1; } 22% { opacity: 0; } 100% { opacity: 0; } }
/* blind */
.fu-cue .bl { width: 0; height: 0; }
.fu-cue .bl .sm { left: calc(-42px * var(--k)); top: calc(-21px * var(--k)); width: calc(84px * var(--k)); height: calc(42px * var(--k));
  background: url("${SMOKE}") 0 0 / calc(120px * var(--k)) calc(120px * var(--k)) repeat;
  -webkit-mask: radial-gradient(ellipse 50% 50% at 50% 50%, #000 32%, rgba(0,0,0,.55) 58%, rgba(0,0,0,0) 78%);
  mask: radial-gradient(ellipse 50% 50% at 50% 50%, #000 32%, rgba(0,0,0,.55) 58%, rgba(0,0,0,0) 78%); filter: blur(1px); animation: fuCueSmoke 6s linear infinite; }
.fu-cue .bl .sm.b2 { opacity: .9; animation: fuCueSmoke2 4.4s linear infinite; }
.fu-cue .bl .core { left: calc(-26px * var(--k)); top: calc(-9px * var(--k)); width: calc(52px * var(--k)); height: calc(18px * var(--k));
  border-radius: 50%; background: rgba(10,6,18,.8); filter: blur(4px); animation: fuCueHaze 3s ease-in-out infinite; }
.fu-cue .bl .wisp { width: calc(16px * var(--k)); height: calc(16px * var(--k)); margin: calc(-8px * var(--k)); border-radius: 50%;
  background: radial-gradient(circle, rgba(16,10,26,.8), rgba(16,10,26,0) 70%); filter: blur(2px); opacity: 0; animation: fuCueWisp 2.8s ease-out infinite; }
@keyframes fuCueSmoke { from { background-position: 0 0; } to { background-position: calc(120px * var(--k)) calc(-40px * var(--k)); } }
@keyframes fuCueSmoke2 { from { background-position: 0 0; } to { background-position: calc(-84px * var(--k)) calc(-28px * var(--k)); } }
@keyframes fuCueHaze { 50% { transform: scale(1.1, 1.08); opacity: .85; } }
@keyframes fuCueWisp { 0% { opacity: 0; transform: translate(0,0) scale(.6); } 25% { opacity: .9; } 100% { opacity: 0; transform: translate(var(--dx), calc(-28px * var(--k))) scale(1.9); } }
/* silence */
.fu-cue .sil { width: calc(40px * var(--k)); height: calc(24px * var(--k)); border-radius: calc(12px * var(--k)); background: #fffdf6; border: 2px solid #3a3228;
  box-shadow: 0 2px 4px rgba(0,0,0,.35); display: flex !important; align-items: center; justify-content: center; gap: calc(4px * var(--k)); animation: fuCueBob 2.2s ease-in-out infinite; }
.fu-cue .sil::before { content: ""; position: absolute; left: 6px; bottom: -9px; border: 6px solid transparent; border-top: 9px solid #3a3228; border-bottom: 0; transform: skewX(28deg); }
.fu-cue .sil::after { content: ""; position: absolute; left: 8px; bottom: -5px; border: 4px solid transparent; border-top: 6px solid #fffdf6; border-bottom: 0; transform: skewX(28deg); }
.fu-cue .sil i { position: static; width: calc(5px * var(--k)); height: calc(5px * var(--k)); border-radius: 50%; background: #3a3228; opacity: .15; animation: fuCueDot 1.5s steps(1) infinite; }
.fu-cue .sil i:nth-child(2) { animation-delay: .25s; } .fu-cue .sil i:nth-child(3) { animation-delay: .5s; }
@keyframes fuCueDot { 0% { opacity: .15; } 20% { opacity: 1; } 85% { opacity: 1; } 100% { opacity: .15; } }
@keyframes fuCueBob { 50% { transform: translateY(-2px); } }
/* provoked */
.fu-cue .vein { width: calc(24px * var(--k)); height: calc(24px * var(--k)); margin: calc(-12px * var(--k)); overflow: visible;
  filter: drop-shadow(0 0 1.5px #fff) drop-shadow(0 1px 1px rgba(0,0,0,.4)); animation: fuCueThrob .9s ease-in-out infinite; }
.fu-cue .vein path { fill: none; stroke: #e8241c; stroke-width: 3.4; stroke-linecap: round; }
@keyframes fuCueThrob { 0%, 100% { transform: scale(1); } 12% { transform: scale(1.28); } 24% { transform: scale(.95); } 36% { transform: scale(1.15); } }
/* sleep */
.fu-cue .zz b { left: 0; top: 0; font: 900 var(--z) "Signika", sans-serif; color: #eef3ff; opacity: 0; animation: fuCueZ 1.6s ease-out infinite;
  text-shadow: 1px 0 0 #34407a, -1px 0 0 #34407a, 0 1px 0 #34407a, 0 -1px 0 #34407a, 0 0 4px rgba(52,64,122,.7); }
@keyframes fuCueZ { 0% { opacity: 0; transform: translate(0,0) rotate(-8deg) scale(.6); } 20% { opacity: 1; }
  100% { opacity: 0; transform: translate(calc(26px * var(--k)), calc(-38px * var(--k))) rotate(10deg) scale(1.15); } }
/* stunned: three yellow stars circling the head (an ellipse; the front of the loop is larger).
   Sizes approved on the mockup 2026-11-27: star 24, orbit 30 x 11, 40 above the eyes. */
.fu-cue .stn b { left: 0; top: 0; margin: calc(-12px * var(--k)); font: 900 calc(24px * var(--k))/1 "Signika", sans-serif; color: #ffd84a;
  text-shadow: 1px 0 0 #6b4a00, -1px 0 0 #6b4a00, 0 1px 0 #6b4a00, 0 -1px 0 #6b4a00, 0 0 5px rgba(255,210,60,.8);
  animation: fuCueStar 1.5s linear infinite; }
@keyframes fuCueStar { 0% { transform: translate(calc(30px * var(--k)), 0) scale(.85); opacity: .8; } 12.5% { transform: translate(calc(21.2px * var(--k)), calc(7.8px * var(--k))) scale(1.06); opacity: .94; } 25% { transform: translate(0, calc(11px * var(--k))) scale(1.15); opacity: 1; } 37.5% { transform: translate(calc(-21.2px * var(--k)), calc(7.8px * var(--k))) scale(1.06); opacity: .94; } 50% { transform: translate(calc(-30px * var(--k)), 0) scale(.85); opacity: .8; } 62.5% { transform: translate(calc(-21.2px * var(--k)), calc(-7.8px * var(--k))) scale(.64); opacity: .66; } 75% { transform: translate(0, calc(-11px * var(--k))) scale(.55); opacity: .6; } 87.5% { transform: translate(calc(21.2px * var(--k)), calc(-7.8px * var(--k))) scale(.64); opacity: .66; } 100% { transform: translate(calc(30px * var(--k)), 0) scale(.85); opacity: .8; } }
/* armor break / magic break: the word DEF / MDEF + a small down arrow that bobs (a status
   visual beside the body, not an icon tile). --c = the word's font size. */
.fu-cue .brk { display: flex; align-items: center; gap: calc(var(--c) * .08); white-space: nowrap;
  transform: translateY(-50%); animation: fuCueBrkIn .45s cubic-bezier(.3,1.6,.5,1) both; }
.fu-cue .brk b { position: relative; font: 400 var(--c)/1 'Bebas Neue', 'Oswald', 'Haettenschweiler', 'Impact', sans-serif;
  letter-spacing: .02em; color: transparent; background: var(--g); -webkit-background-clip: text; background-clip: text;
  -webkit-text-stroke: calc(var(--c) * .035) rgba(20,10,4,.9); paint-order: stroke fill;
  filter: drop-shadow(0 0 1px rgba(0,0,0,.9)) drop-shadow(0 0 calc(var(--c) * .14) var(--glow));
  animation: fuCueBrkGlow 2.4s ease-in-out .45s infinite; }
.fu-cue .brk i { position: relative; width: calc(var(--c) * .42); height: calc(var(--c) * .6);
  filter: drop-shadow(0 0 1px rgba(0,0,0,.95)) drop-shadow(0 0 1px rgba(0,0,0,.8));
  animation: fuCueBrkArrow 1.3s ease-in-out .45s infinite; }
.fu-cue .brk i svg { position: static; width: 100%; height: 100%; overflow: visible; }
.fu-cue .brk.def { --g: linear-gradient(#ffe0a8, #ff9a3c 55%, #d0601c); --glow: rgba(255,140,40,.7); }
.fu-cue .brk.mdef { --g: linear-gradient(#e0f0ff, #5fb4ff 55%, #2c62cc); --glow: rgba(70,150,255,.7); }
@keyframes fuCueBrkIn { 0% { opacity: 0; transform: translateY(-50%) scale(.5); } 100% { opacity: 1; transform: translateY(-50%) scale(1); } }
@keyframes fuCueBrkGlow { 50% { filter: drop-shadow(0 0 1px rgba(0,0,0,.9)) drop-shadow(0 0 calc(var(--c) * .28) var(--glow)); } }
@keyframes fuCueBrkArrow { 0%, 100% { transform: translateY(-6%); } 50% { transform: translateY(14%); } }
/* zombie: deep-purple miasma from the feet up the body (mockup .zb-cue .pool / .ms + zbMist).
   The puffs that pass BEHIND the body are PIXI, in status-cues-back.js. */
.fu-cue .zm { left: 0; top: 0; width: 100%; height: 100%; animation: fuCueFadeIn .5s ease both; }
.fu-cue .zm .pool { left: 4%; right: 4%; bottom: -3%; height: 14%; border-radius: 50%;
  background: radial-gradient(ellipse, rgba(var(--mc), calc(var(--mo) * .8)), rgba(var(--mc), calc(var(--mo) * .3)) 50%, rgba(var(--mc), 0) 72%);
  filter: blur(calc(2px * var(--k))); animation: fuCueZPool 3.2s ease-in-out infinite alternate; }
.fu-cue .zm .ms { width: var(--s); height: calc(var(--s) * var(--sq, .5)); margin-left: calc(var(--s) * -.5); border-radius: 50%;
  background: radial-gradient(ellipse, rgba(var(--mc), .9), rgba(var(--mc), .4) 45%, rgba(var(--mc), 0) 70%);
  filter: blur(calc(2.4px * var(--k))); opacity: 0; animation: fuCueZMist 4s ease-in-out infinite; }
@keyframes fuCueZPool { from { opacity: .65; transform: scaleX(.94); } to { opacity: 1; transform: scaleX(1.05); } }
@keyframes fuCueZMist { 0% { opacity: 0; transform: translate(0,0) scale(.6); } 30% { opacity: var(--mo); } 70% { opacity: calc(var(--mo) * .8); }
  100% { opacity: 0; transform: translate(var(--dx), var(--rise)) scale(1.45); } }
@keyframes fuCueFadeIn { from { opacity: 0; } to { opacity: 1; } }
/* bleed: a pierced heart beside the head, on its back side, glow pulsing (mockup .bl-cue .pc).
   --is icon size, --gs glow size, --ga glow strength, --pp pulse period (px at a 250 px sprite). */
.fu-cue .bld { width: 0; height: 0; animation: fuCueFadeIn .4s ease both; }
.fu-cue .bld .halo { left: calc(var(--gs) * -.5 * var(--k)); top: calc(var(--gs) * -.5 * var(--k)); width: calc(var(--gs) * var(--k)); height: calc(var(--gs) * var(--k)); border-radius: 50%;
  background: radial-gradient(circle, rgba(230,10,20,var(--ga)) 0, rgba(170,0,10,calc(var(--ga) * .6)) 32%, rgba(110,0,6,calc(var(--ga) * .25)) 52%, rgba(90,0,0,0) 70%);
  animation: fuCueBlHalo var(--pp) ease-in-out infinite; }
@keyframes fuCueBlHalo { 0%, 100% { transform: scale(.86); opacity: .75; } 50% { transform: scale(1.1); opacity: 1; } }
.fu-cue .bld svg { left: calc(var(--is) * -.5 * var(--k)); top: calc(var(--is) * -.5 * var(--k)); width: calc(var(--is) * var(--k)); height: calc(var(--is) * var(--k));
  overflow: visible; filter: drop-shadow(0 1px 1px rgba(40,0,0,.6)); animation: fuCueBlBeat var(--pp) ease-in-out infinite; }
@keyframes fuCueBlBeat { 0%, 100% { transform: scale(1); } 12% { transform: scale(1.1); } 24% { transform: scale(.97); } 36% { transform: scale(1.05); } }
/* clip cues (an effect's own looping clip, e.g. Asura's blade slashes) */
.fu-cue video.clip { position: absolute; display: block; pointer-events: none; object-fit: contain; }
@media (prefers-reduced-motion: reduce) { .fu-cue * { animation-play-state: paused !important; } .fu-cue .zm, .fu-cue .bld { animation: none !important; } }
` + sfCueCss();   // Spell Fencer rhythm auras (spell-fencer-cues.js)
  document.head.appendChild(st);
}

function ensureRoot() {
  let root = document.getElementById(ROOT_ID);
  if (!root) { root = document.createElement("div"); root.id = ROOT_ID; document.body.appendChild(root); }
  return root;
}

// Deterministic per token so a rebuild does not reshuffle the particles.
function rng(seed) {
  let s = 7;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const px = (v) => `${Math.round(v)}px`;

/** The cue ids active on an actor (deduped). */
export function cuesOf(actor) {
  const out = new Set();
  try {
    for (const e of actor?.appliedEffects ?? actor?.effects ?? []) {
      if (e?.disabled) continue;
      const c = cueOf(e);
      if (c) out.add(c);
    }
  } catch { /* */ }
  // Spell Fencer: "Resonance ready" from the charge count, and the Rhapsody braid hiding the other three
  try { applySpellFencerCues(actor, out); } catch { /* */ }
  return out;
}

/** The clip cues on an actor: [{ key, src, x, y, size, angle, ax, ay, period, opacity }]. */
export function clipCuesOf(actor) {
  const out = [];
  try {
    for (const e of actor?.appliedEffects ?? actor?.effects ?? []) {
      if (e?.disabled) continue;
      const c = e.flags?.[NS]?.cueClip;
      const src = String(c?.src ?? "").trim();
      if (!src) continue;
      out.push({ key: `${e.name}|${src}`, src, x: +c.x || 0.5, y: +c.y || 0.5, size: +c.size || 0.25, angle: +c.angle || 0,
        ax: c.ax ?? 0.5, ay: c.ay ?? 0.5, period: Math.max(200, +c.period || 1000), opacity: c.opacity ?? 1 });
    }
  } catch { /* */ }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** True when the actor holds every member of an effect combo set (all four Asura Marks). */
function comboComplete(actor) {
  try {
    const held = new Set(); let order = null;
    for (const e of actor?.appliedEffects ?? actor?.effects ?? []) {
      const c = e?.disabled ? null : e?.flags?.[NS]?.poseCombo;
      if (!c?.key || !Array.isArray(c.order)) continue;
      held.add(String(c.key)); order ??= c.order;
    }
    return !!order && order.every((k) => held.has(String(k)));
  } catch { return false; }
}

function clipHTML(token, clips, w, H) {
  const flip = (token.mesh?.scale?.x ?? 1) < 0;
  return clips.map((c, i) => {
    const h = H * c.size, x = w * (flip ? 1 - c.x : c.x), y = H * c.y, ang = flip ? -c.angle : c.angle;
    return `<video class="clip" data-i="${i}" muted playsinline preload="auto" src="${c.src}" style="height:${px(h)};left:${px(x)};top:${px(y)};opacity:${c.opacity};`
      + `transform:translate(${(-c.ax * 100).toFixed(1)}%, ${(-c.ay * 100).toFixed(1)}%) rotate(${ang}deg)${flip ? " scaleX(-1)" : ""};transform-origin:${(c.ax * 100).toFixed(1)}% ${(c.ay * 100).toFixed(1)}%"></video>`;
  }).join("");
}

// Each clip replays every `period` ms (faster when the combo set is complete).
function startClips(rec, clips, fast) {
  stopClips(rec);
  const rate = fast ? 1.6 : 1;
  rec.el.querySelectorAll("video.clip").forEach((v) => {
    const c = clips[Number(v.dataset.i)]; if (!c) return;
    const play = () => { try { v.currentTime = 0; v.playbackRate = rate; v.play()?.catch?.(() => {}); } catch { /* */ } };
    play();
    rec.timers.push(setInterval(play, Math.round(c.period / rate)));
  });
}
function stopClips(rec) { for (const t of rec?.timers ?? []) clearInterval(t); if (rec) rec.timers = []; }

function headFrac(token) {
  let x = 0.5, y = EYE_Y;
  try {
    const f = token.actor?.getFlag?.(NS, "cueHead") ?? token.actor?.flags?.[NS]?.cueHead;
    if (f && Number.isFinite(Number(f.x)) && Number.isFinite(Number(f.y))) { x = Number(f.x); y = Number(f.y); }
  } catch { /* */ }
  if ((token.mesh?.scale?.x ?? 1) < 0) x = 1 - x;
  return { x, y };
}

// The word + a chunky down arrow (viewBox 10×13) in the same gradient.
// Orange = DEF (Armor Break), blue = M.DEF (Magic Break).
const BRK_GRAD = { armorbreak: ["#ffe0a8", "#ff9a3c", "#d0601c"], magicbreak: ["#e0f0ff", "#5fb4ff", "#2c62cc"] };
const BRK_WORD = { armorbreak: "DEF", magicbreak: "MDEF" };
function brkHTML(cue) {
  const [a, b, c] = BRK_GRAD[cue];
  return `<b>${BRK_WORD[cue]}</b><i><svg viewBox="0 0 10 13"><defs><linearGradient id="fuBrk-${cue}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs>`
    + `<path fill="url(#fuBrk-${cue})" d="M3 0 H7 V6 H10 L5 13 L0 6 H3 Z"/></svg></i>`;
}

function cueHTML(token, cues, w, H) {
  const k = H / REF_H;
  const id = token.id;
  const hd = headFrac(token);
  const hx = w * hd.x, hy = H * hd.y;
  let h = "";
  let r, d;
  if (cues.has("burn")) {
    r = rng(id + "b");
    h += `<i class="gl"></i>`;
    for (let i = 0; i < 10; i++) {
      d = 0.9 + r() * 0.6;
      h += `<i class="fl" style="left:${px(w * (0.22 + r() * 0.56))};bottom:${px(H * (0.06 + r() * 0.5))};--s:${px((13 + r() * 11) * k)};--rise:${px(-74 * k)};animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"></i>`;
    }
  }
  if (cues.has("berserk")) {
    r = rng(id + "z");
    h += `<i class="bz"></i>`;
    for (let i = 0; i < 9; i++) {
      d = 0.55 + r() * 0.35;
      const side = i % 2 ? 1 : 0;
      h += `<i class="bs" style="left:${px(w * (side ? 0.62 + r() * 0.22 : 0.16 + r() * 0.22))};bottom:${px(H * (0.1 + r() * 0.55))};--s:${px((22 + r() * 16) * k)};--rise:${px(-60 * k)};animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"></i>`;
    }
  }
  if (cues.has("poison")) {
    r = rng(id + "p");
    for (let i = 0; i < 8; i++) {
      d = 1.8 + r() * 0.9;
      h += `<i class="bb" style="left:${px(w * (0.2 + r() * 0.6))};bottom:${px(H * (0.14 + r() * 0.46))};--s:${px((6 + r() * 6) * k)};--w:${px((r() * 14 - 7) * k)};--rise:${px(-50 * k)};animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"></i>`;
    }
  }
  if (cues.has("wet")) {
    r = rng(id + "w");
    for (let i = 0; i < 8; i++) {
      d = 1.1 + r() * 0.7;
      const top = H * (hd.y + 0.04 + r() * 0.26);
      h += `<i class="dr" style="left:${px(w * (0.28 + r() * 0.44))};top:${px(top)};--f:${px(H * 0.93 - top)};animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"></i>`;
    }
    for (let i = 0; i < 2; i++) {
      d = 1.3 + r() * 0.4;
      h += `<i class="rp" style="left:${px(w * (0.35 + r() * 0.3))};animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"></i>`;
    }
  }
  if (cues.has("paralyze")) {
    r = rng(id + "z");
    const pts = ["10,0 3,12 11,14 5,28", "8,0 13,10 5,15 12,28", "11,0 4,9 12,13 3,20 9,28"];
    for (let i = 0; i < 6; i++) {
      d = 1.2 + r() * 1.0;
      h += `<svg class="zp" viewBox="0 0 18 28" style="left:${px(w * (0.08 + r() * 0.72))};top:${px(H * (0.12 + r() * 0.6))};transform:rotate(${Math.round(r() * 70 - 35)}deg);animation-duration:${d.toFixed(2)}s;animation-delay:-${(r() * d).toFixed(2)}s"><polyline points="${pts[i % 3]}"/></svg>`;
    }
  }
  if (cues.has("blind")) {
    const wp = [[-24, -4, -10, 0], [22, -6, 12, -0.9], [-8, -12, -6, -1.7], [12, 0, 8, -2.3]];
    h += `<span class="bl" style="left:${px(hx)};top:${px(hy)}"><i class="core"></i><i class="sm"></i><i class="sm b2"></i>`
      + wp.map((p) => `<i class="wisp" style="left:${px(p[0] * k)};top:${px(p[1] * k)};--dx:${px(p[2] * k)};animation-delay:${p[3]}s"></i>`).join("")
      + `</span>`;
  }
  if (cues.has("silence")) h += `<span class="sil" style="left:${px(hx + 12 * k)};top:${px(hy - 50 * k)}"><i></i><i></i><i></i></span>`;
  if (cues.has("provoked")) {
    h += `<svg class="vein" viewBox="0 0 24 24" style="left:${px(hx - w * 0.18)};top:${px(hy - 16 * k)}"><path d="M9 3 Q9 9 3 9"/><path d="M15 3 Q15 9 21 9"/><path d="M9 21 Q9 15 3 15"/><path d="M15 21 Q15 15 21 15"/></svg>`;
  }
  const brk = ["armorbreak", "magicbreak"].filter((c) => cues.has(c));
  if (brk.length) {
    // Beside the chest on the unit's BACK side (the side away from where it faces), so it
    // stays clear of the head cues, the waist passive card and the feet status strip.
    const flip = (token.mesh?.scale?.x ?? 1) < 0;          // drawn facing right unless flipped
    const c = Math.max(22, 30 * k);                         // word font size
    // Anchored just OUTSIDE the frame edge and growing away from the body: PC battler
    // frames are narrow and the body fills them, so an inset spot sat on the body.
    // MDEF is wider than DEF, so anchor the near edge rather than the centre.
    const edge = w * 0.06;
    const side = flip ? `left:${px(w - edge)}` : `right:${px(w - edge)}`;
    brk.forEach((cue, i) => {
      h += `<span class="brk ${cue === "armorbreak" ? "def" : "mdef"}" style="--c:${px(c)};${side};top:${px(H * 0.4 + i * (c + 4))}">${brkHTML(cue)}</span>`;
    });
  }
  if (cues.has("sleep")) {
    h += `<span class="zz" style="left:${px(hx + 8 * k)};top:${px(hy - 22 * k)}">`
      + [0, 1, 2].map((i) => `<b style="--z:${px((20 + i * 5) * k)};animation-delay:-${(i * 1.6 / 3).toFixed(2)}s">Z</b>`).join("")
      + `</span>`;
  }
  if (cues.has("stun")) {
    h += `<span class="stn" style="left:${px(hx)};top:${px(hy - 40 * k)}">`
      + [0, 1, 2].map((i) => `<b style="animation-delay:-${(i * 0.5).toFixed(1)}s">★</b>`).join("")
      + `</span>`;
  }
  if (cues.has("zombie")) {
    // The in-front two thirds of the miasma + the pool at the feet; the rest is PIXI, behind
    // the body (status-cues-back.js), from the SAME puff list.
    const M = ZOMBIE_LOOK.miasma;
    h += `<span class="zm" style="--mc:${M.mc};--mo:${M.mo}"><i class="pool"></i>`
      + miasmaPuffs(id, M).filter((p) => !p.back).map((p) =>
        `<i class="ms" style="left:${px(w * p.x)};bottom:${px(H * p.yb)};--s:${px(p.s * k)};--sq:${p.sq};--dx:${px(p.dx * k)};--rise:${px(p.rise * k)};animation-duration:${p.d.toFixed(2)}s;animation-delay:-${p.delay.toFixed(2)}s"></i>`).join("")
      + `</span>`;
  }
  if (cues.has("bleed")) {
    // Beside the head on its BACK side (away from where the unit looks), the blade entering
    // from outside: the line mirrors with the side it sits on (mockup paintCue).
    const B = BLEED_LOOK, dir = B.side === "back" ? -facingOf(token) : facingOf(token);
    h += `<span class="bld" style="left:${px(hx + dir * B.ox * k)};top:${px(hy - B.oy * k)};--is:${B.is}px;--gs:${B.gs}px;--ga:${B.ga};--pp:${B.pp}s">`
      + `<i class="halo"></i>${pierceSVG(id, B.icon, B.line, B.lt, B.la, dir < 0)}</span>`;
  }
  h += sfCueHTML(id, cues, w, H, rng, px);   // Spell Fencer rhythm auras (spell-fencer-cues.js)
  return h;
}

// Which way a battler looks on screen: +1 right, -1 left. Battle art is drawn facing
// LEFT unless its token carries "Art is drawn facing right" (spriteFacesRight, the
// same mark leave-exit-fx / the walk maps read); a mirrored mesh turns it round.
function facingOf(token) {
  let drawnRight = false;
  try {
    const f = token.document?.getFlag?.(NS, "spriteFacesRight")
      ?? game.actors?.get?.(token.document?.actorId)?.prototypeToken?.flags?.[NS]?.spriteFacesRight;
    drawnRight = f === true || String(f ?? "").toLowerCase() === "true";
  } catch { /* */ }
  const flip = (token.mesh?.scale?.x ?? 1) < 0;
  return (drawnRight ? 1 : -1) * (flip ? -1 : 1);
}

// The Bleed icon: viewBox -20..20, a glossy heart (or drop) and the line across it.
// Straight port of the mockup's pierceSVG.
function pierceSVG(id, ic, ln, lt, la, mirror) {
  const g = `fuBlG-${id}`;
  const shape = ic === "heart"
    ? "M0 13 C-4 9.5 -15 3 -15 -5 C-15 -10.5 -10.5 -14 -6 -14 C-3 -14 -1 -12.4 0 -10.4 C1 -12.4 3 -14 6 -14 C10.5 -14 15 -10.5 15 -5 C15 3 4 9.5 0 13Z"
    : "M0 -15 C4 -7 11 -1 11 5.5 A11 11 0 0 1 -11 5.5 C-11 -1 -4 -7 0 -15Z";
  const a = mirror ? -la : la;
  let L;
  if (ln === "blade") {
    // tapered blade from tip (-21) to guard (+14), grip past it
    L = `<g transform="rotate(${a})">`
      + `<polygon points="-22,0 13,${(-lt * 0.9).toFixed(2)} 13,${(lt * 0.9).toFixed(2)}" fill="#e9ecf2" stroke="#3a3a44" stroke-width=".7" stroke-linejoin="round"/>`
      + `<line x1="-20" y1="0" x2="12" y2="0" stroke="#9aa2b0" stroke-width=".5"/>`
      + `<rect x="13" y="${(-3.2 - lt * 0.4).toFixed(2)}" width="2.2" height="${(6.4 + lt * 0.8).toFixed(2)}" rx=".8" fill="#c9a24a" stroke="#4a3410" stroke-width=".6"/>`
      + `<rect x="15.2" y="-1.1" width="6" height="2.2" rx="1" fill="#5a3a22" stroke="#2a1a0c" stroke-width=".5"/>`
      + `<circle cx="21.6" cy="0" r="1.6" fill="#c9a24a" stroke="#4a3410" stroke-width=".5"/></g>`;
  } else {
    L = `<g transform="rotate(${a})"><line x1="-19" y1="0" x2="19" y2="0" stroke="#2a0a0c" stroke-width="${(lt + 1.6).toFixed(2)}" stroke-linecap="round"/>`
      + `<line x1="-19" y1="0" x2="19" y2="0" stroke="#fff2ee" stroke-width="${lt.toFixed(2)}" stroke-linecap="round"/></g>`;
  }
  const hy = ic === "heart" ? -8 : -1;
  return `<svg viewBox="-20 -20 40 40" aria-hidden="true"><defs><radialGradient id="${g}" cx="38%" cy="32%" r="75%">`
    + `<stop offset="0" stop-color="#ffb0a8"/><stop offset=".28" stop-color="#ff3b3b"/><stop offset=".7" stop-color="#c00814"/><stop offset="1" stop-color="#6a020a"/></radialGradient></defs>`
    + `<path d="${shape}" fill="url(#${g})" stroke="#4a0006" stroke-width="1.1"/>`
    + `<ellipse cx="-6" cy="${hy}" rx="3.4" ry="2.1" transform="rotate(-30 -6 ${hy})" fill="#fff" opacity=".6"/>`
    + L + `</svg>`;
}

// The behind-the-body half of a token's cues (today: the Zombie miasma), or null.
function backWant(token, cues) {
  if (!cues.has("zombie")) return null;
  const M = ZOMBIE_LOOK.miasma;
  return { key: `zombie|${token.id}`, mc: M.mc, mo: M.mo, puffs: miasmaPuffs(token.id, M) };
}

function wants(token) { return !!(battleActive() && token?.actor && !token.destroyed); }

function drop(id) { const r = S.recs.get(id); if (r) { stopClips(r); r.el.remove(); S.recs.delete(id); } try { syncBackCues({ id }, null); } catch { /* */ } }

/** (Re)build one token's cue layer. */
export function renderCues(token) {
  if (!token) return;
  const cues = wants(token) ? cuesOf(token.actor) : new Set();
  const clips = wants(token) ? clipCuesOf(token.actor) : [];
  try { syncBackCues(token, backWant(token, cues)); } catch (e) { warn("[StatusCues] back layer sync failed", e); }
  if (!cues.size && !clips.length) { drop(token.id); return; }
  const rect = spriteRect(token);
  if (!rect) return;
  const fast = clips.length ? comboComplete(token.actor) : false;
  const flip = (token.mesh?.scale?.x ?? 1) < 0;
  const sig = [...cues].sort().join(",") + "|" + clips.map((c) => c.key).join(",") + (fast ? "|fast" : "") + (flip ? "|flip" : "");
  let rec = S.recs.get(token.id);
  if (!rec) {
    const el = document.createElement("div");
    el.className = "fu-cue";
    if (S.hidden) el.classList.add("is-anim-hidden");
    ensureRoot().appendChild(el);
    rec = { el, sig: "", w: 0, h: 0, timers: [] };
    S.recs.set(token.id, rec);
  }
  if (rec.sig !== sig || Math.abs(rect.height - rec.h) > rec.h * 0.08 || Math.abs(rect.width - rec.w) > rec.w * 0.08) {
    rec.el.style.setProperty("--k", (rect.height / REF_H).toFixed(3));
    rec.el.innerHTML = cueHTML(token, cues, rect.width, rect.height) + clipHTML(token, clips, rect.width, rect.height);
    rec.sig = sig; rec.w = rect.width; rec.h = rect.height;
    if (clips.length) startClips(rec, clips, fast); else stopClips(rec);
  }
  place(token, rec, rect);
}

function shown(token) {
  return token.visible && token.renderable !== false && (token.mesh?.alpha ?? 1) > 0.05 && (token.mesh?.worldAlpha ?? 1) > 0.05;
}

function place(token, rec, rect = spriteRect(token)) {
  if (!rect || !shown(token)) { rec.el.style.display = "none"; return; }
  rec.el.style.display = "";
  rec.el.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
  rec.el.style.width = `${Math.round(rect.width)}px`;
  rec.el.style.height = `${Math.round(rect.height)}px`;
  // Zoom changed the sprite size enough → rebuild at the new scale.
  if (Math.abs(rect.height - rec.h) > rec.h * 0.08 || Math.abs(rect.width - rec.w) > rec.w * 0.08) renderCues(token);
}

function tick() {
  if (!S.recs.size) return;
  for (const [id, rec] of S.recs) {
    const t = canvas?.tokens?.get(id);
    if (!t) { drop(id); continue; }
    place(t, rec);
  }
}

export function renderAllCues() {
  ensureStyles();
  const live = new Set();
  for (const t of canvas?.tokens?.placeables ?? []) { live.add(t.id); renderCues(t); syncTint(t.actor); }
  for (const id of [...S.recs.keys()]) if (!live.has(id)) drop(id);
}

// Wash: the first cue in WASH_ORDER that the actor carries, in battle only.
const _gradeSpecs = {};
function statusTint(actor) {
  if (!battleActive() || !actor) return null;
  const cues = cuesOf(actor);
  for (const c of WASH_ORDER) {
    if (!cues.has(c)) continue;
    const w = WASH[c];
    if (w.grade) {
      _gradeSpecs[c] ??= makeGradeSpec(w.grade);   // built once, shared by every token
      return { color: [1, 1, 1], strength: 1, mode: "grade", grade: _gradeSpecs[c], target: "bearer", applierActorUuid: null };
    }
    const col = foundry.utils.Color.from(w.color);
    return { color: [col.r, col.g, col.b], strength: w.strength, mode: "multiply", target: "bearer", applierActorUuid: null };
  }
  return null;
}
function syncTint(actor) { try { if (actor) syncActorTint(actor); } catch (e) { warn("[StatusCues] tint sync failed", e); } }

function setHidden(hidden) {
  S.hidden = !!hidden;
  setBackCuesHidden(S.hidden);
  for (const rec of S.recs.values()) rec.el.classList.toggle("is-anim-hidden", S.hidden);
}

function actorOfEffect(eff) {
  const p = eff?.parent;
  return p?.documentName === "Actor" ? p : p?.parent?.documentName === "Actor" ? p.parent : null;
}

export function initStatusCues() {
  setStatusTintProvider(statusTint);
  // Charge cues that must pass BEHIND the body (Skizzik's Static orbit) can't live in
  // this DOM layer, which sits over the whole canvas; they are PIXI, in their own module.
  try { installChargeOrbitFx(); } catch (e) { warn("[StatusCues] charge orbit install threw", e); }
  try { installSlayerFx(); } catch (e) { warn("[StatusCues] slayer fx install threw", e); }
  // The behind-the-body cue layer (Zombie miasma's back puffs), PIXI in canvas.primary.
  try { installBackCues(); } catch (e) { warn("[StatusCues] back layer install threw", e); }
  const onAE = (eff) => {
    const actor = actorOfEffect(eff);
    if (!actor) return;
    for (const t of actor.getActiveTokens?.(false, false) ?? []) renderCues(t);
    syncTint(actor);
  };
  Hooks.on("createActiveEffect", onAE);
  Hooks.on("updateActiveEffect", onAE);
  Hooks.on("deleteActiveEffect", onAE);
  Hooks.on("createToken", (doc) => setTimeout(() => { renderCues(doc?.object); syncTint(doc?.object?.actor); }, 0));
  Hooks.on("deleteToken", (doc) => drop(doc?.id));
  Hooks.on("canvasTearDown", () => { for (const id of [...S.recs.keys()]) drop(id); });
  Hooks.on("canvasReady", () => {
    if (S.ticker) { try { canvas.app.ticker.remove(S.ticker); } catch { /* */ } }
    S.ticker = tick; canvas.app.ticker.add(S.ticker);
    renderAllCues();
  });
  Hooks.on("fuBattleFocusChanged", () => renderAllCues());
  Hooks.on("fuBattleMarksHidden", (hidden) => setHidden(hidden));
  if (canvas?.ready) { S.ticker = tick; canvas.app.ticker.add(S.ticker); renderAllCues(); }
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.statusCues = { renderAll: renderAllCues, cuesOf, clipCuesOf, count: () => S.recs.size };
  log("[StatusCues] ready");
}
