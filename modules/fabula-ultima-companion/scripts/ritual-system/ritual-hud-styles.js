// ============================================================================
// Ritual System — window + material-picker styles (injected once).
//
// Warm parchment theme, palette matched to the camp / shop / healing UIs so the
// ritual window reads as part of the same game.
//
// Note the explicit `border: 0` on every injected <img>: a global stylesheet in
// this world puts a 1px solid black border on all images, which otherwise shows
// as a black box around the discipline icons, the feather cursor and the
// material thumbnails.
// ============================================================================

const STYLE_ID = "oni-ritual-hud-styles";

export function injectRitualStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.oni-ritual-overlay, .oni-rmp-overlay {
  --rt-parch-1: #f6ebd3; --rt-parch-2: #efdfc3; --rt-parch-3: #e7d3b1;
  --rt-wood-1: #a87649; --rt-wood-2: #8d5f38; --rt-wood-3: #6f4526;
  --rt-gold-1: #f4d488; --rt-gold-2: #caa44d; --rt-gold-3: #9a7a2b;
  --rt-ink: #3b2a19; --rt-glow: rgba(250,230,160,.55);
  --rt-bad: #b8392f; --rt-ok: #2f7d32;
  position: fixed; inset: 0; z-index: 120;
  display: flex; align-items: center; justify-content: center;
  background: rgba(18, 10, 5, 0.66);
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif; color: var(--rt-ink);
  opacity: 0; transition: opacity .18s ease;
}
.oni-rmp-overlay { z-index: 130; }
.oni-ritual-overlay.visible, .oni-rmp-overlay.visible { opacity: 1; }
.oni-ritual-overlay img, .oni-rmp-overlay img {
  border: 0 !important; outline: 0 !important; box-shadow: none !important; background: transparent !important;
}

.oni-ritual-frame {
  width: min(600px, 92vw);
  background: linear-gradient(180deg, var(--rt-parch-1), var(--rt-parch-2));
  border: 3px solid var(--rt-wood-2); border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0,0,0,.55), 0 0 0 1px var(--rt-gold-3) inset;
}

/* ── Header ─────────────────────────────────────────────────────────────── */
.oni-ritual-header {
  display: flex; align-items: center; gap: 10px; padding: 9px 14px;
  background: linear-gradient(180deg, var(--rt-wood-1), var(--rt-wood-3));
  border-bottom: 2px solid var(--rt-gold-3); border-radius: 8px 8px 0 0;
  color: var(--rt-parch-1);
}
.oni-ritual-header img { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; }
.oni-ritual-header .title { font-size: 18px; font-weight: 700; letter-spacing: .5px; }
.oni-ritual-header .performer { margin-left: auto; font-size: 13px; opacity: .92; }
.oni-ritual-close { cursor: pointer; font-size: 16px; padding: 0 2px; opacity: .85; }
.oni-ritual-close:hover { opacity: 1; }

.oni-ritual-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 9px; }
.oni-ritual-duo { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }

/* ── Focus ring + feather anchor ────────────────────────────────────────── */
.oni-ritual-focusable { outline: none; transition: box-shadow .12s ease, border-color .12s ease; }
.oni-ritual-focusable.focused { border-color: var(--rt-wood-3) !important; box-shadow: 0 0 0 2px var(--rt-gold-2), 0 0 12px var(--rt-glow); }
/* ENGAGED: this row has taken ←/→ and is now changing its own value. A hotter
   ring plus solid arrows is the only cue that the keys mean something different. */
.oni-ritual-focusable.engaged {
  box-shadow: 0 0 0 2px var(--rt-wood-3), 0 0 16px rgba(250,220,120,.85);
  background: var(--rt-gold-1);
}
.oni-ritual-focusable.engaged .arrow { opacity: 1; color: var(--rt-wood-3); transform: scale(1.15); }
.oni-ritual-scroll .arrow, .oni-ritual-disc .arrow { transition: opacity .12s ease, transform .12s ease; }

/* ── Scroll label (potency / area) ──────────────────────────────────────── */
.oni-ritual-scroll {
  border: 2px solid var(--rt-gold-3); border-radius: 8px; background: var(--rt-parch-3);
  padding: 5px 8px 7px; cursor: pointer; user-select: none;
}
.oni-ritual-scroll .lbl {
  font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
  color: var(--rt-wood-3); opacity: .8; text-align: center;
}
.oni-ritual-scroll .picker { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.oni-ritual-scroll .arrow {
  font-size: 13px; color: var(--rt-wood-2); padding: 0 4px; opacity: .75;
}
.oni-ritual-scroll .arrow:hover { opacity: 1; color: var(--rt-wood-3); }
/* Potency and Area clamp at their ends; the dead arrow says so. */
.oni-ritual-scroll .arrow.spent { opacity: .18; cursor: default; }
.oni-ritual-scroll .arrow.spent:hover { opacity: .18; color: var(--rt-wood-2); }
/* The value host clips its two sliding layers. */
.oni-ritual-scroll .val {
  flex: 1; position: relative; height: 23px; overflow: hidden;
}
.v-layer {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 17px; font-weight: 700; color: inherit; white-space: nowrap;
  transition: transform 200ms cubic-bezier(.22,.8,.3,1), opacity 200ms ease;
}
/* A layer on its way out must not be picked up as the current value. */
.v-layer.exit { pointer-events: none; }

/* ── Discipline carousel ────────────────────────────────────────────────── */
/* No panel: the current discipline floats on the parchment with its faded
   neighbours either side, so the eye reads it as a reel, not a field. */
.oni-ritual-disc { padding: 2px 4px 4px; cursor: pointer; user-select: none; border-radius: 8px; }
.oni-ritual-disc .lbl {
  font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
  color: var(--rt-wood-3); opacity: .8; text-align: center;
}
.oni-ritual-disc .picker { display: flex; align-items: center; gap: 4px; }
.oni-ritual-disc .arrow { font-size: 14px; color: var(--rt-wood-2); padding: 0 2px; opacity: .75; flex: none; }
.oni-ritual-disc .arrow:hover { opacity: 1; color: var(--rt-wood-3); }
.oni-ritual-disc.solo .arrow { visibility: hidden; }
.disc-viewport { flex: 1; overflow: hidden; min-width: 0; }
/* FIVE slots of a third of the viewport each, so three are on screen and one
   waits just off each edge. Those two are what slide IN during a scroll; with
   only three slots the vacated end position stayed empty for the whole slide
   and the arriving neighbour could not appear until the rebuild.
   Track = 5/3 of the viewport, pulled left by one slot so slot 2 is centred.
   One scroll step is therefore 20% of the track's own width. */
.disc-track {
  display: grid; grid-template-columns: repeat(5, 20%);
  width: 166.6667%; margin-left: -33.3333%;
  transform: translate3d(0,0,0);
  backface-visibility: hidden;   /* keeps the promoted layer off the fractional-pixel path */
}
/* Every slot is built at the SAME type size and differentiated by scale, so the
   size change can tween across the slide instead of popping at the end. Animating
   font-size would relayout each frame; scale rides the compositor. */
.disc-slot {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  min-width: 0; padding: 2px 4px; overflow: hidden;
  transform: scale(.74); opacity: .34; filter: grayscale(.55);
  transition: transform 280ms cubic-bezier(0.33, 0.0, 0.15, 1.0),
              opacity 280ms ease, filter 280ms ease;
  will-change: transform, opacity;
}
.disc-slot.cur { transform: scale(1); opacity: 1; filter: none; }
.disc-slot .disc-icon { width: 30px; height: 30px; object-fit: contain; flex: none; }
.disc-slot .disc-name {
  font-size: 21px; font-weight: 800; letter-spacing: .4px; color: var(--rt-ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  -webkit-text-stroke: 0.6px #fff6c9;
  text-shadow: 0 0 5px rgba(255,244,190,.8), 0 1px 1px rgba(0,0,0,.25);
  transition: text-shadow 280ms ease;
}
/* Neighbours drop the glow, but keep the stroke so it does not flash on arrival. */
.disc-slot.side .disc-name { text-shadow: none; }
.oni-ritual-disc.solo .disc-slot.side { visibility: hidden; }


/* ── Actions row: the material button, then Group Check as bare text ────── */
.oni-ritual-actions { display: flex; align-items: center; justify-content: flex-start; gap: 14px; }

/* The one button that should shout. Dark reddish-brown fill, vivid yellow
   border, dark-brown label carved out with a yellow stroke.
   The width:auto below is load-bearing: Foundry's core stylesheet sets
   button { width: 100% }, which stretched this to the full row and shoved
   Group Check off the right edge of the frame. flex:none does not stop it. */
/* Every knob below is a CSS variable with an inline fallback, and NOTHING
   declares them. That is deliberate: the live tuner
   (FUCompanion.api.ritual.tuner.material()) sets them on document.documentElement,
   and an inherited root variable only wins if no closer rule declares one. */
.oni-ritual-mat {
  width: auto; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  gap: var(--rm-gap, 8px);
  border: var(--rm-border-w, 2px) solid var(--rm-border, #ffd84d);
  border-radius: var(--rm-radius, 9px);
  background: linear-gradient(180deg, var(--rm-fill-1, #7d3428) 0%, var(--rm-fill-2, #57231b) 100%);
  color: var(--rm-text, #3b2a19);
  font-family: "Signika", sans-serif;
  font-weight: var(--rm-weight, 500);
  font-size: var(--rm-size, 14.5px);
  letter-spacing: var(--rm-letter, .3px);
  padding: var(--rm-pad-y, 6px) var(--rm-pad-x, 14px);
  cursor: pointer; min-height: var(--rm-min-h, 36px); line-height: 1;
  box-shadow: 0 3px 0 var(--rm-lip, #3a1712), 0 5px 14px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.10);
  transition: transform .1s ease, box-shadow .12s ease;
}
/* Dark brown on dark red only separates BECAUSE of the yellow edge, so thinning
   the stroke has to buy the contrast back somewhere.
   The glyph is fattened by four hairline same-colour shadows (a faux-bold that
   Signika has no heavier weight for), the yellow rim is cut to a whisker so the
   letter counters stay open, and a tight yellow glow sits behind everything to
   lift the whole word off the red. Shadow order matters: the fattening offsets
   are listed first so they paint above the glow. */
/* ── The outline sits OUTSIDE the glyph, never inside it ─────────────────────
   -webkit-text-stroke centres its stroke on the glyph outline: half grows
   outward, half eats inward, so raising the width visibly thins the letters.
   paint-order: stroke fill is the spec's answer, but this is Chromium 122
   (Electron 29), where paint-order applies to SVG text only and is ignored for
   HTML text — it computes, and does nothing.

   So we draw the word twice. ::before is a stroked, transparent-filled copy
   sitting one layer BEHIND; the solid fill on top covers the stroke's inner
   half, leaving only its outer half visible. The stroke is therefore doubled,
   because the user only ever sees half of it — --rm-stroke-w means "outside
   width" and the maths keeps that promise.

   The copy is driven by data-text, so ritual-hud-app.js must keep that
   attribute in sync with the label. */
/* Direct child only: when a material is offered the label also contains a
   .mat-off span, which must not sprout an outline layer of its own.
   (NB: never use backticks in this stylesheet — it is a template literal.) */
.oni-ritual-mat > span {
  position: relative; z-index: 0;
  display: inline-flex; align-items: center;
  font-weight: var(--rm-weight, 500);
  /* Faux-bold: four hairline same-colour offsets thicken the glyph. Fill only —
     the outline layer must not be fattened. Off by default: once the outline
     genuinely sits outside the letters, a lighter face reads better against it
     than a fattened one. */
  text-shadow:
    var(--rm-fat, 0px) 0 0 currentColor, calc(-1 * var(--rm-fat, 0px)) 0 0 currentColor,
    0 var(--rm-fat, 0px) 0 currentColor, 0 calc(-1 * var(--rm-fat, 0px)) 0 currentColor;
}
.oni-ritual-mat > span::before {
  content: attr(data-text);
  position: absolute; inset: 0; z-index: -1;
  display: flex; align-items: center; justify-content: flex-start;
  white-space: nowrap; pointer-events: none;
  font: inherit; letter-spacing: inherit;
  color: transparent;                       /* only the stroke of this copy shows */
  -webkit-text-stroke: calc(var(--rm-stroke-w, 1px) * 2) var(--rm-stroke, #ffe14d);
  /* The glow belongs on the layer behind the fill, or it washes the letters out.
     The inner blur is tight so it reads as a rim light on the outline rather
     than a haze around the word. */
  text-shadow:
    0 0 var(--rm-glow-1, 2px) var(--rm-glow-c1, rgba(255,225,77,.95)),
    0 0 var(--rm-glow-2, 11px) var(--rm-glow-c2, rgba(255,216,77,.6));
}
.oni-ritual-mat:hover { box-shadow: 0 3px 0 #3a1712, 0 0 14px var(--rt-glow); }
.oni-ritual-mat:active { transform: translateY(2px); box-shadow: 0 1px 0 #3a1712; }
.oni-ritual-mat.offered { background: linear-gradient(180deg, #8d4a24 0%, #6b3218 100%); }
.oni-ritual-mat .mat-crystal {
  width: var(--rm-icon, 22px); height: var(--rm-icon, 22px);
  object-fit: contain; flex: none;
}
.oni-ritual-mat .mat-off {
  margin-left: 7px; font-weight: 900; color: #bff5c2; -webkit-text-stroke: 0.4px #14421a;
}

/* Group Check and MIG+WLP: no panel. Bare text on the parchment, beside the
   button. display:inline-flex beats [hidden]'s UA display:none, so the hidden
   state has to be restated — the MIG+WLP switch only exists for Chimerism and
   would otherwise stay on screen for every discipline. */
.oni-ritual-group {
  display: inline-flex; align-items: center; gap: 9px; flex: 0 0 auto;
  cursor: pointer; user-select: none; padding: 6px 4px; border-radius: 6px;
  white-space: nowrap;
}
.oni-ritual-group[hidden] { display: none; }
.oni-ritual-group .tg-label { font-size: 14px; font-weight: 700; color: var(--rt-wood-3); }
.oni-ritual-group.on .tg-label { color: var(--rt-ok); }
.oni-ritual-group .tg-switch {
  width: 44px; height: 22px; border-radius: 12px; background: #c9b899;
  border: 1px solid var(--rt-wood-3); position: relative; transition: background .16s ease;
  flex: none;
}
.oni-ritual-group .knob {
  position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--rt-parch-1); box-shadow: 0 1px 3px rgba(0,0,0,.4);
  transition: left .16s cubic-bezier(.22,.8,.3,1);
}
.oni-ritual-group.on .tg-switch { background: var(--rt-ok); }
.oni-ritual-group.on .knob { left: 24px; }

/* ── Intent ─────────────────────────────────────────────────────────────── */
.oni-ritual-intent { border: 2px solid var(--rt-gold-3); border-radius: 8px; background: var(--rt-parch-1); }
.oni-ritual-intent textarea {
  width: 100%; resize: none; padding: 7px 9px; border: 0; outline: none; border-radius: 6px;
  background: transparent; color: var(--rt-ink); font-family: inherit; font-size: 13px;
}

/* ── Finalize ───────────────────────────────────────────────────────────── */
.oni-ritual-final {
  position: relative; display: flex; align-items: center; justify-content: center;
  padding: 9px 14px; border-radius: 8px;
  background: var(--rt-parch-3); border: 2px solid var(--rt-gold-2);
}
/* The cost is centred in the PANEL, not merely in the space the DL leaves —
   so the DL is taken out of flow and pinned right. */
.oni-ritual-final .fin-mid { text-align: center; }
/* Mind Points read as mana: blue, glowing, bold italic — and the glow is the
   fastest read of "can I cast this", long before the shortage line is parsed. */
.oni-ritual-final .fin-cost {
  font-size: 32px; font-weight: 800; font-style: italic; line-height: 1.1;
  color: #2f5fae;
  text-shadow: 0 0 12px rgba(95,168,239,.75), 0 0 26px rgba(95,168,239,.35), 0 1px 1px rgba(0,0,0,.22);
}
.oni-ritual-final .fin-note { font-size: 11px; opacity: .85; margin-top: 1px; min-height: 13px; }
.oni-ritual-final .fin-dl {
  position: absolute; right: 16px; top: 50%; transform: translateY(-50%);
  display: flex; align-items: baseline; gap: 6px;
}
.oni-ritual-final .dl-lbl { font-size: 12px; letter-spacing: 2px; opacity: .75; }
.oni-ritual-final .dl-val { font-size: 34px; font-weight: 800; line-height: 1; }
/* Not performable: the WHOLE panel goes red, not just the number. */
.oni-ritual-final.short {
  border-color: var(--rt-bad); background: rgba(184,57,47,.10);
}
.oni-ritual-final.short .fin-cost,
.oni-ritual-final.short .fin-note,
.oni-ritual-final.short .dl-lbl,
.oni-ritual-final.short .dl-val { color: var(--rt-bad); opacity: 1; }
/* The blue mana glow becomes a red one — same weight, opposite meaning. */
.oni-ritual-final.short .fin-cost {
  text-shadow: 0 0 12px rgba(220,74,60,.75), 0 0 26px rgba(220,74,60,.35), 0 1px 1px rgba(0,0,0,.22);
}

/* ── Footer ─────────────────────────────────────────────────────────────── */
/* No keyboard legend: the scheme is the same one the Healing HUD teaches, and
   the row is worth more as button space. */
.oni-ritual-footer { display: flex; gap: 9px; align-items: center; justify-content: flex-end; padding: 0 14px 13px; }
.oni-ritual-btn {
  padding: 7px 18px; border-radius: 8px; cursor: pointer; font-weight: 700;
  border: 2px solid var(--rt-wood-3);
  background: linear-gradient(180deg, var(--rt-gold-1), var(--rt-gold-2));
  color: var(--rt-wood-3); font-family: inherit;
}
.oni-ritual-btn:hover:not(:disabled) { box-shadow: 0 0 10px var(--rt-glow); }
.oni-ritual-btn:disabled { opacity: .45; cursor: not-allowed; filter: grayscale(.6); }
.oni-ritual-btn.ghost { background: var(--rt-parch-3); color: var(--rt-wood-3); }

/* ── Feather cursor (same asset + motion as the Healing HUD) ────────────── */
/* The cursor is appended to document.body, NOT inside .oni-ritual-overlay, so
   the overlay's img reset never reaches it and the world's global stylesheet
   paints a 1px solid black border around the transparent PNG. Reset it here.
   scale(-1,1) mirrors the quill so its tip points INTO the row it marks. */
#oni-ritual-cursor {
  position: fixed; z-index: 2147483647;
  width: 40px; height: 40px; pointer-events: none;
  border: 0 !important; outline: 0 !important; box-shadow: none !important;
  background: transparent !important;
  transform: translate(-88%, -50%) scale(-1, 1) rotate(20deg);
  transition: left .18s cubic-bezier(0.22,1,0.36,1), top .18s cubic-bezier(0.22,1,0.36,1), opacity .12s ease;
  opacity: 0; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5));
}
#oni-ritual-cursor.is-visible { opacity: 1; animation: oniRitualCursorFloat 2.2s ease-in-out infinite; }
#oni-ritual-cursor.no-anim { transition: none !important; }
@keyframes oniRitualCursorFloat {
  0%, 100% { transform: translate(-88%, -50%) scale(-1, 1) rotate(20deg) translateX(0px); }
  50%       { transform: translate(-88%, -50%) scale(-1, 1) rotate(20deg) translateX(6px); }
}

/* ── Material picker ────────────────────────────────────────────────────── */
.oni-rmp-frame {
  width: min(460px, 90vw); max-height: 74vh; display: flex; flex-direction: column;
  background: linear-gradient(180deg, var(--rt-parch-1), var(--rt-parch-2));
  border: 3px solid var(--rt-wood-2); border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0,0,0,.55), 0 0 0 1px var(--rt-gold-3) inset;
}
.oni-rmp-header {
  display: flex; align-items: center; gap: 10px; padding: 9px 14px;
  background: linear-gradient(180deg, var(--rt-wood-1), var(--rt-wood-3));
  border-bottom: 2px solid var(--rt-gold-3); border-radius: 8px 8px 0 0; color: var(--rt-parch-1);
}
.oni-rmp-header .title { font-size: 16px; font-weight: 700; }
.oni-rmp-header .sub { font-size: 11px; opacity: .8; margin-left: auto; }
.oni-rmp-close { cursor: pointer; opacity: .85; padding-left: 6px; }
.oni-rmp-close:hover { opacity: 1; }

.oni-rmp-list { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 5px; }
.oni-rmp-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 9px; cursor: pointer;
  border: 2px solid transparent; border-radius: 8px; background: var(--rt-parch-3);
}
.oni-rmp-row.focused { border-color: var(--rt-wood-3); box-shadow: 0 0 8px var(--rt-glow); background: var(--rt-gold-1); }
.oni-rmp-row .rmp-icon { width: 30px; height: 30px; object-fit: contain; flex: none; }
.oni-rmp-row .rmp-mid { flex: 1; min-width: 0; }
.oni-rmp-row .rmp-name { font-weight: 700; font-size: 14px; }
.oni-rmp-row .rmp-sub { font-size: 11px; opacity: .8; }
.oni-rmp-row .rmp-rarity { font-weight: 700; }
.oni-rmp-row .rmp-off { font-weight: 800; color: var(--rt-ok); font-size: 15px; }
.oni-rmp-empty { padding: 22px 16px; text-align: center; font-size: 13px; opacity: .9; }
.oni-rmp-empty .hint { margin-top: 6px; font-size: 11px; opacity: .7; }
.oni-rmp-footer { display: flex; align-items: center; justify-content: flex-end; gap: 9px; padding: 9px 14px; border-top: 1px solid var(--rt-gold-2); }

/* ── Outcome chat card ──────────────────────────────────────────────────── */
.oni-ritual-card { border: 1px solid #9a7a2b; border-radius: 6px; padding: 8px; }
.oni-ritual-card header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.oni-ritual-card header img { border: 0; outline: 0; box-shadow: none; border-radius: 50%; }
.oni-ritual-card .ritual-title { font-weight: 700; }
.oni-ritual-card .ritual-sub { font-size: 11px; opacity: .8; }
.oni-ritual-card .ritual-desc { font-style: italic; margin: 6px 0; opacity: .9; }
.oni-ritual-card .ritual-row { display: flex; justify-content: space-between; font-size: 12px; padding: 1px 0; }
.oni-ritual-card .ritual-verdict { margin-top: 6px; padding: 5px; border-radius: 4px; text-align: center; font-weight: 700; }
.oni-ritual-card .ritual-verdict.ok { background: rgba(47,125,50,.16); color: #2f7d32; }
.oni-ritual-card .ritual-verdict.bad { background: rgba(184,57,47,.16); color: #b8392f; }
`;
  document.head.appendChild(s);
}
