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

/* ── Scroll label (potency / area / discipline) ─────────────────────────── */
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
.oni-ritual-scroll.solo .arrow { visibility: hidden; }
.oni-ritual-scroll .val {
  flex: 1; text-align: center; font-size: 17px; font-weight: 700; color: var(--rt-ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* Discipline: bold name with a white-yellow stroke, icon prefixed. */
.oni-ritual-scroll .val.disc { display: flex; align-items: center; justify-content: center; gap: 9px; }
.oni-ritual-scroll .disc-icon { width: 30px; height: 30px; object-fit: contain; }
.oni-ritual-scroll .disc-name {
  font-size: 21px; font-weight: 800; letter-spacing: .4px; color: var(--rt-ink);
  -webkit-text-stroke: 0.6px #fff6c9;
  text-shadow: 0 0 5px rgba(255,244,190,.8), 0 1px 1px rgba(0,0,0,.25);
}

.oni-ritual-alt { font-size: 12px; display: flex; align-items: center; gap: 8px; padding-left: 4px; }
.oni-ritual-alt label { display: flex; align-items: center; gap: 6px; cursor: pointer; }

/* ── Offer Material button ──────────────────────────────────────────────── */
.oni-ritual-mat {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  border: 2px solid var(--rt-gold-3); border-radius: 8px; background: var(--rt-parch-3);
  color: var(--rt-ink); font: 700 14px "Signika", sans-serif; padding: 10px 8px; cursor: pointer;
  min-height: 46px;
}
.oni-ritual-mat:hover { box-shadow: 0 0 8px var(--rt-glow); }
.oni-ritual-mat.offered { background: linear-gradient(180deg, var(--rt-gold-1), var(--rt-gold-2)); }
.oni-ritual-mat .mat-icon { width: 24px; height: 24px; object-fit: contain; }
.oni-ritual-mat .mat-off { font-weight: 800; color: var(--rt-ok); }

/* ── Group Check toggle switch ──────────────────────────────────────────── */
.oni-ritual-toggle {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  border: 2px solid var(--rt-gold-3); border-radius: 8px; background: var(--rt-parch-3);
  padding: 10px 12px; cursor: pointer; user-select: none; min-height: 46px;
}
.oni-ritual-toggle .tg-label { font-size: 14px; font-weight: 700; }
.oni-ritual-toggle .tg-switch {
  width: 44px; height: 22px; border-radius: 12px; background: #c9b899;
  border: 1px solid var(--rt-wood-3); position: relative; transition: background .16s ease;
  flex: none;
}
.oni-ritual-toggle .knob {
  position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--rt-parch-1); box-shadow: 0 1px 3px rgba(0,0,0,.4);
  transition: left .16s cubic-bezier(.22,.8,.3,1);
}
.oni-ritual-toggle.on .tg-switch { background: var(--rt-ok); }
.oni-ritual-toggle.on .knob { left: 24px; }

/* ── Intent ─────────────────────────────────────────────────────────────── */
.oni-ritual-intent { border: 2px solid var(--rt-gold-3); border-radius: 8px; background: var(--rt-parch-1); }
.oni-ritual-intent textarea {
  width: 100%; resize: none; padding: 7px 9px; border: 0; outline: none; border-radius: 6px;
  background: transparent; color: var(--rt-ink); font-family: inherit; font-size: 13px;
}

/* ── Finalize ───────────────────────────────────────────────────────────── */
.oni-ritual-final {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 14px; border-radius: 8px;
  background: var(--rt-parch-3); border: 2px solid var(--rt-gold-2);
}
.oni-ritual-final .fin-cost { font-size: 21px; font-weight: 800; line-height: 1.1; }
.oni-ritual-final .fin-note { font-size: 11px; opacity: .85; margin-top: 1px; min-height: 13px; }
.oni-ritual-final .fin-dl { display: flex; align-items: baseline; gap: 6px; }
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

/* ── Footer ─────────────────────────────────────────────────────────────── */
.oni-ritual-footer { display: flex; gap: 9px; align-items: center; padding: 0 14px 13px; }
.oni-ritual-footer .hint { font-size: 11px; opacity: .7; margin-right: auto; }
.oni-ritual-footer .hint b { font-weight: 700; opacity: .95; margin: 0 2px 0 6px; }
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
#oni-ritual-cursor {
  position: fixed; z-index: 2147483647;
  width: 40px; height: 40px; pointer-events: none;
  transform: translate(-88%, -50%) rotate(20deg);
  transition: left .18s cubic-bezier(0.22,1,0.36,1), top .18s cubic-bezier(0.22,1,0.36,1), opacity .12s ease;
  opacity: 0; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5));
}
#oni-ritual-cursor.is-visible { opacity: 1; animation: oniRitualCursorFloat 2.2s ease-in-out infinite; }
#oni-ritual-cursor.no-anim { transition: none !important; }
@keyframes oniRitualCursorFloat {
  0%, 100% { transform: translate(-88%, -50%) rotate(20deg) translateX(0px); }
  50%       { transform: translate(-88%, -50%) rotate(20deg) translateX(-6px); }
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
.oni-rmp-footer { display: flex; align-items: center; gap: 9px; padding: 9px 14px; border-top: 1px solid var(--rt-gold-2); }
.oni-rmp-footer .hint { font-size: 11px; opacity: .7; margin-right: auto; }
.oni-rmp-footer .hint b { font-weight: 700; opacity: .95; margin: 0 2px 0 6px; }

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
