// ============================================================================
// Area Name Panel — pure core
// ----------------------------------------------------------------------------
// The gate ("does this scene get a panel, and what does it say?") plus every
// tunable constant. No DOM, no Foundry globals — importable by bare Node, which
// is what `area-panel-core.test.mjs` leans on.
//
// The rendering half lives in `area-panel.js`.
// ============================================================================

export const MODULE_ID = "fabula-ultima-companion";

// Flag path: scene.flags[MODULE_ID].oniFabula.general.<key>
// Mirrors the keys declared in scripts/custom-ui/dungeon-configuration-ui.js —
// keep the two in step.
export const FABULA_ROOT_KEY = "oniFabula";
export const GENERAL_KEY     = "general";
export const AREA_NAME_KEY   = "areaName";           // string: label shown on the panel
export const AREA_ENABLED_KEY = "areaPanelEnabled";  // boolean: per-scene gate (UNSET => on)
export const AREA_ALWAYS_KEY  = "areaPanelAlwaysShow"; // boolean: bypass repeat suppression

// The diamond that heads the label. Its own constant so it can become an icon
// later without hunting through the CSS.
export const GLYPH = "\u25C8"; // ◈

// Scene modes that never announce an area.
//
// `title` owns the whole screen when it comes up — a plaque sliding in over the
// title overlay reads as a glitch, not as an establishing shot. `conflict` and
// `gacha` are a fight and a pull screen, not a place the party walks into; the
// Scene Config block is hidden for those two as well, and this set is what keeps
// a scene switched to Conflict AFTER a name was typed from announcing anyway.
export const SUPPRESSED_SCENE_MODES = new Set(["title", "conflict", "gacha"]);

// ── Tuning ────────────────────────────────────────────────────────────────
// Everything that decides how the panel FEELS lives here, so a re-tune after a
// live look is a constant change and not a code change. Curves are quad, not
// cubic: a cubic packs its travel into a fast middle and reads as a whoosh at
// any duration.
export const TUNING = {
  // ── Look: every key here is exposed in the tuner (see TUNABLE) ──────────
  //
  // The plaque is ATTACHED to the left edge of the screen: POS_X_PX is
  // NEGATIVE, so its left end runs off-frame and only the right corners are
  // ever seen. The left padding adds that overhang back, so the text is not
  // crowded against the edge.
  POS_X_PX:  -28,
  POS_Y_PX:    0,           // extra offset BELOW the auto anchor (under Foundry's chrome)
  FONT_PX:     30,          // area-name size
  GLYPH_SCALE: 1,           // diamond size, as a multiple of the area-name size
  GLYPH_GAP_PX: 12,         // space between the diamond and the name
  PANEL_SCALE: 1,           // whole-plaque multiplier, from its left edge
  MIN_W_PX:     0,          // 0 = fit the text
  MIN_H_PX:     0,          // 0 = let the padding decide
  PAD_X_PX:    32,          // right-hand padding; the left adds the overhang
  PAD_Y_PX:    15,
  OUTLINE_PX:   3,          // frame thickness
  RADIUS_PX:   12,

  // ── Motion ───────────────────────────────────────────────────────────────
  // It travels its own full width (translateX(-100%)), not a small nudge, so
  // the durations are long enough to keep that an unhurried drift.
  IN_MS:    1100,           // slide + fade in
  HOLD_MS:  4000,           // idle dwell, per spec
  OUT_MS:    950,           // slide + fade out, back the way it came
  EASE_IN:  "cubic-bezier(.22,.61,.36,1)",   // ease-out quad — entrance
  EASE_OUT: "cubic-bezier(.55,.06,.68,.19)", // ease-in quad  — exit

  // ── Plumbing: not tunable from the UI ────────────────────────────────────
  // Sequencing against the screen-transition curtain (z 99999). Playing on the
  // raw `updateScene` would animate the panel behind solid black.
  DELAY_AFTER_REVEAL_MS: 450, // settle beat after the curtain lifts
  SETTLE_MS:             600, // no redraw by now => we were already here, play
  WATCHDOG_MS:          6000, // last resort; must clear canvasReady + a 700ms reveal

  // A player alt-tabbed to Discord has document.hidden === true, and a hidden
  // tab throttles timers and never paints — the beat would be spent on a blank
  // screen. The panel is held instead and plays when they come back, as long as
  // they come back within this window and the party is still in that area.
  DEFER_MAX_MS: 180000,
  DEFER_SETTLE_MS: 500,     // beat after the tab becomes visible again

  MAX_LABEL_CHARS: 64,      // hard clamp; the CSS also ellipsises
  EDGE_PAD_PX:     14,      // gap from Foundry chrome when anchoring
  Z_INDEX:         62,      // above #interface (30) and the controller badge (61),
                            // below the transition curtain (99999)
};

/**
 * What the tuner puts on screen, in the order it shows them.
 *
 * This list is the single source of truth for the tuning UI AND for the
 * snippet it exports, so adding a knob is one entry here plus one CSS var —
 * there is no second place to keep in step.
 */
export const TUNABLE = [
  { group: "Type",   key: "FONT_PX",      label: "Area name size",  min: 8,    max: 96,   step: 1,    unit: "px" },
  { group: "Type",   key: "GLYPH_SCALE",  label: "Diamond scale",   min: 0,    max: 3,    step: 0.05, unit: "×",
    hint: "0 hides the diamond" },
  { group: "Type",   key: "GLYPH_GAP_PX", label: "Diamond gap",     min: 0,    max: 60,   step: 1,    unit: "px" },

  { group: "Panel",  key: "PANEL_SCALE",  label: "Panel scale",     min: 0.25, max: 3,    step: 0.05, unit: "×",
    hint: "scales the whole plaque from its left edge" },
  { group: "Panel",  key: "MIN_W_PX",     label: "Min width",       min: 0,    max: 1400, step: 5,    unit: "px",
    hint: "0 = fit the text" },
  { group: "Panel",  key: "MIN_H_PX",     label: "Min height",      min: 0,    max: 400,  step: 2,    unit: "px",
    hint: "0 = let the padding decide" },
  { group: "Panel",  key: "PAD_X_PX",     label: "Padding X",       min: 0,    max: 160,  step: 1,    unit: "px" },
  { group: "Panel",  key: "PAD_Y_PX",     label: "Padding Y",       min: 0,    max: 120,  step: 1,    unit: "px" },

  { group: "Place",  key: "POS_X_PX",     label: "X offset",        min: -400, max: 400,  step: 1,    unit: "px",
    hint: "negative hangs it off the screen edge" },
  { group: "Place",  key: "POS_Y_PX",     label: "Y offset",        min: -300, max: 800,  step: 1,    unit: "px",
    hint: "added below Foundry's own chrome" },

  { group: "Frame",  key: "OUTLINE_PX",   label: "Outline",         min: 0,    max: 16,   step: 0.5,  unit: "px" },
  { group: "Frame",  key: "RADIUS_PX",    label: "Corner radius",   min: 0,    max: 60,   step: 1,    unit: "px" },

  { group: "Timing", key: "IN_MS",        label: "Slide in",        min: 100,  max: 4000, step: 50,   unit: "ms" },
  { group: "Timing", key: "HOLD_MS",      label: "Hold",            min: 500,  max: 15000, step: 100, unit: "ms" },
  { group: "Timing", key: "OUT_MS",       label: "Slide out",       min: 100,  max: 4000, step: 50,   unit: "ms" },
];

const TUNABLE_BY_KEY = new Map(TUNABLE.map((f) => [f.key, f]));

/**
 * Keep only known numeric keys, clamped to their declared range.
 *
 * Overrides arrive from a world setting, i.e. from whatever was last saved by
 * a tuner that may be older than this code. A stale or hand-edited key must not
 * be able to push a NaN into the CSS and blank the plaque.
 */
export function sanitizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    const field = TUNABLE_BY_KEY.get(key);
    if (!field) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    out[key] = Math.min(field.max, Math.max(field.min, n));
  }
  return out;
}

/** The shipped defaults with sanitized overrides laid on top. */
export function mergeTuning(overrides) {
  return { ...TUNING, ...sanitizeOverrides(overrides) };
}

/** Only the keys that actually differ from the shipped defaults. */
export function diffFromDefaults(overrides) {
  const clean = sanitizeOverrides(overrides);
  const out = {};
  for (const [key, value] of Object.entries(clean)) if (value !== TUNING[key]) out[key] = value;
  return out;
}

/**
 * The block to paste back into TUNING above, so a tuning session can be made
 * permanent instead of living in a world setting forever.
 */
export function exportSnippet(overrides) {
  const merged = mergeTuning(overrides);
  const changed = diffFromDefaults(overrides);
  const width = Math.max(...TUNABLE.map((f) => f.key.length));
  const lines = TUNABLE.map((f) => {
    const v = merged[f.key];
    const mark = f.key in changed ? "   // changed" : "";
    return `  ${f.key.padEnd(width)}: ${v},${mark}`;
  });
  return `// area-panel-core.js — TUNING\n${lines.join("\n")}`;
}

// ── Flag reading ──────────────────────────────────────────────────────────

/** Read the raw general block off a scene-like object. Never throws. */
export function readGeneral(scene) {
  return scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY]?.[GENERAL_KEY] ?? {};
}

/**
 * Normalise the three area keys.
 *
 * `enabled` defaults to TRUE when unset: a dev who types a name gets a panel.
 * That is safe for every legacy scene because they carry no name, and the name
 * is the harder gate.
 */
export function readAreaConfig(scene) {
  const g = readGeneral(scene);
  const rawName = g?.[AREA_NAME_KEY];
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const rawEnabled = g?.[AREA_ENABLED_KEY];
  const enabled = (rawEnabled === undefined || rawEnabled === null) ? true : !!rawEnabled;
  return {
    name,
    enabled,
    alwaysShow: !!g?.[AREA_ALWAYS_KEY],
    sceneMode: g?.sceneMode ?? null,
  };
}

/**
 * Collapse whitespace and clamp \u2014 the bare area name, no glyph.
 *
 * Kept separate from formatLabel so the glyph is added in exactly one place.
 * An early build drew it on a gold spine AND prepended it here, and the first
 * live screenshot read "\u25c8 \u25c8 Eisendrache Kingdom".
 */
export function cleanName(name) {
  const clean = String(name ?? "").replace(/\s+/g, " ").trim();
  return clean.length > TUNING.MAX_LABEL_CHARS
    ? `${clean.slice(0, TUNING.MAX_LABEL_CHARS - 1).trimEnd()}\u2026`
    : clean;
}

/** The full "\u25c8 Area" line \u2014 what the plaque prints, and what any text surface
 *  (a log line, a chat card, a tooltip) should use. */
export function formatLabel(name) {
  const clean = cleanName(name);
  return clean ? `${GLYPH} ${clean}` : "";
}

/**
 * The gate.
 *
 * `lastAreaName` is the area this client last announced. Re-announcing it is
 * suppressed so a castle spread over six maps says its name once — unless the
 * scene opts out with Always Show.
 *
 * Returns { show, reason, name, label }. `reason` is for the debug API and the
 * tests; nothing branches on it at runtime.
 */
export function shouldShowForScene(scene, { lastAreaName = null } = {}) {
  const deny = (reason, name = "") => ({ show: false, reason, name, display: "", label: "" });

  if (!scene) return deny("no-scene");

  const cfg = readAreaConfig(scene);
  if (!cfg.name) return deny("no-name");
  if (!cfg.enabled) return deny("disabled", cfg.name);
  if (SUPPRESSED_SCENE_MODES.has(cfg.sceneMode)) return deny("suppressed-scene-mode", cfg.name);

  const isRepeat = typeof lastAreaName === "string"
    && lastAreaName.trim().length > 0
    && lastAreaName.trim() === cfg.name;
  if (isRepeat && !cfg.alwaysShow) return deny("repeat", cfg.name);

  return {
    show: true,
    reason: cfg.alwaysShow && isRepeat ? "always-show" : "ok",
    name: cfg.name,
    display: cleanName(cfg.name), // the bare name
    label: formatLabel(cfg.name), // glyph included — what the plaque prints
  };
}
