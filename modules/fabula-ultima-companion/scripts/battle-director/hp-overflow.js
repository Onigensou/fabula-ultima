// HP above Max HP, drawn on an HP bar. Pure helpers + the ONE colour token.
//
// A creature can hold more HP than its Max (Nidhogg's Soul Confluence merges
// Soul Fragments into one). The bar keeps its look while HP <= Max. When HP is
// above Max the bar's FULL LENGTH becomes the current HP: the normal fill covers
// Max/HP of it and the extra (HP - Max)/HP is drawn in OVERFLOW_COLOR, the same
// way the white SHIELD segment is stacked to the right of the fill.
//
// Shield + overflow rule: left to right  [HP fill up to Max][overflow][shield].
// Below Max the shield is clipped at the bar's end, as before. Above Max the bar
// grows to HP + shield, so the shield is never clipped.
//
// All lengths are in "Max units" (1 = Max HP) so an animated bar can tween
// between layouts. len = the length the bar spans, widths = value / len.

// ── the colour (change HERE only) ──────────────────────────────────────────
// Violet: not white (shield), not the green/yellow/red HP fill, not the red or
// amber damage ghost, not the blue MP bar, not the orange ZP bar.
export const OVERFLOW_COLOR_VIOLET = "#a66bff";
// Alternatives for comparison stills.
export const OVERFLOW_COLOR_TEAL = "#27e0d0";
export const OVERFLOW_COLOR_PINK = "#ff5fb8";
// User decision 2026-11-24: a pinkish violet between the violet and pink candidates.
export const OVERFLOW_COLOR_FINAL = "#cc66ff";
export const OVERFLOW_COLOR = OVERFLOW_COLOR_FINAL;

// CSS custom property every renderer reads; a stylesheet or a test can override
// it on any ancestor (the comparison stills set it on <html>).
export const OVERFLOW_CSS_VAR = "--fu-hp-overflow";
export const overflowColorCss = `var(${OVERFLOW_CSS_VAR}, ${OVERFLOW_COLOR})`;
/** Top-lit gradient for a vertical bar (floating bar), from the one token. */
export const overflowGradient = (dir = "to bottom") =>
  `linear-gradient(${dir}, color-mix(in srgb, ${overflowColorCss} 60%, #ffffff) 0%, ${overflowColorCss} 55%, color-mix(in srgb, ${overflowColorCss} 70%, #000000) 100%)`;

/**
 * Segment layout in Max units.
 * @returns {{fill:number, over:number, shield:number, total:number, len:number}}
 *  fill = end of the normal fill, over = end of the overflow segment (== fill when
 *  none), total = end of the shield segment (>= over), len = what the bar spans.
 */
export function hpBarSegments(hp, max, shield = 0) {
  const m = Number(max);
  if (!(m > 0)) return { fill: 0, over: 0, shield: 0, total: 0, len: 1 };
  const h = Math.max(0, Number(hp) || 0) / m;
  const s = Math.max(0, Number(shield) || 0) / m;
  return segmentsFromFractions(h, s);
}

/** Same, from fractions of Max (what the floating bar's payload carries). */
export function segmentsFromFractions(frac, shieldFrac = 0) {
  const h = Math.max(0, Number(frac) || 0);
  const s = Math.max(0, Number(shieldFrac) || 0);
  if (h > 1) {
    const total = h + s;
    return { fill: 1, over: h, shield: s, total, len: total };
  }
  const total = Math.min(1, h + s);
  return { fill: h, over: h, shield: Math.max(0, total - h), total, len: 1 };
}

export const hasOverflow = (hp, max) => Number(max) > 0 && Number(hp) > Number(max);

/** Percent widths (0..100) of each layer inside a bar spanning `len`. */
export function layerPercents(seg, len = seg.len) {
  const L = len > 0 ? len : 1;
  const p = (x) => Math.max(0, Math.min(100, (x / L) * 100));
  return { fill: p(seg.fill), over: p(seg.over), total: p(seg.total) };
}
