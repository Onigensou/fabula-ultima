// ============================================================================
// Ritual System — window styles (injected once).
//
// Warm parchment theme, palette matched to the camp / shop / healing UIs so the
// ritual window reads as part of the same game.
//
// Note the explicit `border: 0` on the portrait <img>: a global stylesheet in
// this world puts a 1px solid black border on every <img>, which shows up as a
// black box around any injected media.
// ============================================================================

const STYLE_ID = "oni-ritual-hud-styles";

export function injectRitualStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.oni-ritual-overlay {
  --rt-parch-1: #f6ebd3; --rt-parch-2: #efdfc3; --rt-parch-3: #e7d3b1;
  --rt-wood-1: #a87649; --rt-wood-2: #8d5f38; --rt-wood-3: #6f4526;
  --rt-gold-1: #f4d488; --rt-gold-2: #caa44d; --rt-gold-3: #9a7a2b;
  --rt-ink: #3b2a19; --rt-glow: rgba(250,230,160,.55);
  --rt-mp: #2f5fae; --rt-bad: #b8392f; --rt-ok: #2f7d32;
  position: fixed; inset: 0; z-index: 120;
  display: flex; align-items: center; justify-content: center;
  background: rgba(18, 10, 5, 0.66);
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif; color: var(--rt-ink);
  opacity: 0; transition: opacity .18s ease;
}
.oni-ritual-overlay.visible { opacity: 1; }

.oni-ritual-frame {
  width: min(760px, 92vw); max-height: 88vh; overflow-y: auto;
  background: linear-gradient(180deg, var(--rt-parch-1), var(--rt-parch-2));
  border: 3px solid var(--rt-wood-2); border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0,0,0,.55), 0 0 0 1px var(--rt-gold-3) inset;
}

.oni-ritual-header {
  display: flex; align-items: center; gap: 12px; padding: 12px 16px;
  background: linear-gradient(180deg, var(--rt-wood-1), var(--rt-wood-3));
  border-bottom: 2px solid var(--rt-gold-3); border-radius: 8px 8px 0 0;
  color: var(--rt-parch-1);
}
.oni-ritual-header img {
  width: 42px; height: 42px; border: 0; outline: 0; box-shadow: none;
  background: none; border-radius: 50%; object-fit: cover;
}
.oni-ritual-header .title { font-size: 20px; font-weight: 700; letter-spacing: .5px; }
.oni-ritual-header .performer { margin-left: auto; font-size: 13px; opacity: .9; }
.oni-ritual-close { cursor: pointer; font-size: 18px; padding: 0 4px; opacity: .85; }
.oni-ritual-close:hover { opacity: 1; }

.oni-ritual-body { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.oni-ritual-section > h3 {
  margin: 0 0 6px; font-size: 13px; text-transform: uppercase;
  letter-spacing: 1px; color: var(--rt-wood-3); border-bottom: 1px solid var(--rt-gold-2);
}

.oni-ritual-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.oni-ritual-opt {
  padding: 8px 10px; border: 2px solid var(--rt-gold-3); border-radius: 8px;
  background: var(--rt-parch-3); cursor: pointer; transition: all .12s ease;
}
.oni-ritual-opt:hover:not(.disabled) { border-color: var(--rt-wood-2); box-shadow: 0 0 8px var(--rt-glow); }
.oni-ritual-opt.selected { background: var(--rt-gold-1); border-color: var(--rt-wood-3); }
.oni-ritual-opt.disabled { opacity: .42; cursor: not-allowed; filter: grayscale(.7); }
.oni-ritual-opt .name { font-weight: 700; font-size: 14px; }
.oni-ritual-opt .why { font-size: 11px; opacity: .85; margin-top: 2px; }

.oni-ritual-alt { margin-top: 8px; font-size: 13px; display: flex; align-items: center; gap: 8px; }

.oni-ritual-desc textarea {
  width: 100%; min-height: 68px; resize: vertical; padding: 8px;
  border: 2px solid var(--rt-gold-3); border-radius: 6px;
  background: var(--rt-parch-1); color: var(--rt-ink); font-family: inherit; font-size: 13px;
}

.oni-ritual-toggles { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.oni-ritual-toggles label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.oni-ritual-toggles input[type="text"] {
  flex: 1; padding: 4px 8px; border: 1px solid var(--rt-gold-3);
  border-radius: 4px; background: var(--rt-parch-1); color: var(--rt-ink);
}
.oni-ritual-toggles input[type="text"]:disabled { opacity: .45; }

.oni-ritual-readout {
  padding: 10px 12px; border-radius: 8px; text-align: center;
  background: var(--rt-parch-3); border: 2px solid var(--rt-gold-2);
}
.oni-ritual-readout .cost { font-size: 16px; font-weight: 700; }
.oni-ritual-readout .mp { font-size: 12px; margin-top: 3px; opacity: .85; }
.oni-ritual-readout .mp.short { color: var(--rt-bad); font-weight: 700; opacity: 1; }

.oni-ritual-footer { display: flex; gap: 10px; justify-content: flex-end; padding: 0 16px 16px; }
.oni-ritual-btn {
  padding: 8px 20px; border-radius: 8px; cursor: pointer; font-weight: 700;
  border: 2px solid var(--rt-wood-3);
  background: linear-gradient(180deg, var(--rt-gold-1), var(--rt-gold-2));
  color: var(--rt-wood-3);
}
.oni-ritual-btn:hover:not(:disabled) { box-shadow: 0 0 10px var(--rt-glow); }
.oni-ritual-btn:disabled { opacity: .45; cursor: not-allowed; filter: grayscale(.6); }
.oni-ritual-btn.ghost { background: var(--rt-parch-3); color: var(--rt-wood-3); }

/* Outcome chat card */
.oni-ritual-card { border: 1px solid var(--rt-gold-3, #9a7a2b); border-radius: 6px; padding: 8px; }
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
