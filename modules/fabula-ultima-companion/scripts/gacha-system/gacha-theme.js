// ============================================================================
// Gacha System — Theme
// ----------------------------------------------------------------------------
// The house look is warm parchment, not the cool slate this system was first
// built in. Palette is lifted from the Level-Up window
// (scripts/levelup-system/levelup-app.js), which is the closest analogue: a
// full-screen parchment UI that composites text over per-item artwork.
//
// Everything is exposed as CSS custom properties on :root so the overlay, the
// panels and the FX layer all derive from one place instead of each carrying
// its own hex literals.
//
// The `--gc-over-*` block is the Level-Up trick for text laid over artwork:
// a thick parchment stroke plus a parchment glow, so a label stays readable
// whatever item icon happens to sit behind it. Item art varies wildly and
// cannot be designed around, so the text has to defend itself.
// ============================================================================

const STYLE_ID = "gacha-theme-vars";

export const THEME_CSS = `
:root {
  /* surfaces, lightest → deepest */
  --gc-parch:      #f7f0df;
  --gc-parch-2:    #f1e6c6;
  --gc-panel:      #e6dabd;
  --gc-panel-2:    #e2d3b6;
  --gc-sunk:       #ebdfc2;

  /* borders */
  --gc-line:       #c6ae87;
  --gc-line-2:     #b79c72;
  --gc-line-3:     #8a6c45;

  /* ink */
  --gc-ink:        #2f2618;
  --gc-ink-2:      #3b2a17;
  --gc-ink-3:      #5a4a30;
  --gc-ink-soft:   rgba(58,47,30,.62);

  /* accents */
  --gc-title:      #5c1f2e;   /* deep red — banner + panel titles */
  --gc-gold:       #a98a4e;
  --gc-gold-soft:  rgba(169,138,78,.28);

  /* inverted surface (selected rows, primary buttons) */
  --gc-deep:       #5d4630;
  --gc-deep-2:     #3a2b17;
  --gc-deep-ink:   #f6ecd8;

  /* rarity — semantic, unchanged by the reskin */
  --gc-r3:         #3C6FF0;
  --gc-r4:         #A335FF;
  --gc-r5:         #e6a015;

  --gc-radius:     8px;
  --gc-radius-lg:  12px;
  --gc-shadow:     0 18px 48px -16px rgba(40,26,10,.6);
}

/* Text over artwork. Applied to any label that floats on top of item art. */
.gc-over {
  paint-order: stroke fill;
  -webkit-text-stroke: 3px rgba(247,240,223,.92);
  text-shadow: 0 0 8px var(--gc-parch), 0 0 16px var(--gc-parch), 0 1px 0 rgba(247,240,223,.9);
}
.gc-over-thin {
  paint-order: stroke fill;
  -webkit-text-stroke: 2px rgba(247,240,223,.9);
  text-shadow: 0 0 6px var(--gc-parch), 0 0 12px var(--gc-parch);
}

/* Foundry styles bare <button> and <input> globally, and these overlays are
   appended to document.body rather than living inside a Foundry window — so
   those globals apply and win. Chief offender: a bare button rule setting width
   to 100%, which turned every tab and action button into a full-width bar.
   Neutralise it once, here, for everything the gacha system renders.

   TRAP: this is an ID-level rule, so it also outranks plain class rules. A
   <button> that wants an explicit width must be declared id-scoped too
   ("#gacha-panel .gp-step { width: ... }"), or it silently falls back to
   content width. Divs are unaffected. */
#gacha-ui button, #gacha-panel button,
#gacha-ui input, #gacha-panel input {
  width: auto;
  flex: 0 0 auto;
  font-family: inherit;
  line-height: normal;
}

/* Shared button. Sized by CONTENT — never stretched by a flex or grid parent. */
.gc-btn {
  width: auto; align-self: center; flex: 0 0 auto;
  min-width: 132px; max-width: 100%;
  padding: 10px 22px;
  font-family: inherit; font-size: 13px; letter-spacing: 2px;
  text-transform: uppercase; white-space: nowrap; cursor: pointer;
  border-radius: var(--gc-radius);
  border: 1px solid var(--gc-line-3);
  background: linear-gradient(180deg, var(--gc-parch), var(--gc-panel));
  color: var(--gc-ink);
  transition: background .13s, border-color .13s, transform .13s, box-shadow .13s;
}
.gc-btn:hover:not(:disabled) {
  background: linear-gradient(180deg, #fffaec, var(--gc-parch-2));
  border-color: var(--gc-gold);
  transform: translateY(-1px);
  box-shadow: 0 4px 14px -6px rgba(60,40,14,.55);
}
.gc-btn:disabled { opacity: .42; cursor: default; filter: saturate(.4); }

.gc-btn.is-primary {
  background: linear-gradient(180deg, var(--gc-deep), var(--gc-deep-2));
  border-color: var(--gc-deep-2);
  color: var(--gc-deep-ink);
}
.gc-btn.is-primary:hover:not(:disabled) {
  background: linear-gradient(180deg, #6f5539, #4a3720);
  border-color: var(--gc-gold);
}
`;

export function ensureTheme() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = THEME_CSS;
  document.head.appendChild(s);
}
