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
  // The plaque is ATTACHED to the left edge of the screen: its left end runs
  // off-frame by OVERSHOOT_PX, so only its right corners are ever seen and it
  // reads as sliding out of the screen edge rather than floating near it.
  OVERSHOOT_PX: 28,
  // It now travels its own full width instead of a 56px nudge, so the durations
  // are longer to keep the same unhurried drift.
  IN_MS:    1100,           // slide + fade in
  HOLD_MS:  4000,           // idle dwell, per spec
  OUT_MS:    950,           // slide + fade out, back the way it came
  EASE_IN:  "cubic-bezier(.22,.61,.36,1)",   // ease-out quad — entrance
  EASE_OUT: "cubic-bezier(.55,.06,.68,.19)", // ease-in quad  — exit

  // Plaque scale. The mockup draws it about a tenth of the screen tall; these
  // land a little under that, which is the number to nudge after a live look.
  FONT_PX:   30,
  PAD_Y_PX:  15,
  PAD_X_PX:  32,            // right-hand padding; the left adds OVERSHOOT_PX
  RADIUS_PX: 12,

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
