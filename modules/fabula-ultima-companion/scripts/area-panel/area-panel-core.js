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

// Scene modes that own the whole screen when they come up. A plaque sliding in
// over the title screen's overlay reads as a glitch, not as an establishing
// shot, so those modes never get one.
export const SUPPRESSED_SCENE_MODES = new Set(["title"]);

// ── Tuning ────────────────────────────────────────────────────────────────
// Everything that decides how the panel FEELS lives here, so a re-tune after a
// live look is a constant change and not a code change. Curves are quad, not
// cubic: a cubic packs its travel into a fast middle and reads as a whoosh at
// any duration.
export const TUNING = {
  SLIDE_PX: 56,             // how far left of rest the panel starts/ends
  IN_MS:    900,            // slide + fade in
  HOLD_MS:  4000,           // idle dwell, per spec
  OUT_MS:   800,            // slide + fade out, back the way it came
  EASE_IN:  "cubic-bezier(.22,.61,.36,1)",   // ease-out quad — entrance
  EASE_OUT: "cubic-bezier(.55,.06,.68,.19)", // ease-in quad  — exit

  // Sequencing against the screen-transition curtain (z 99999). Playing on the
  // raw `updateScene` would animate the panel behind solid black.
  DELAY_AFTER_REVEAL_MS: 450, // settle beat after the curtain lifts
  SETTLE_MS:             600, // no redraw by now => we were already here, play
  WATCHDOG_MS:          6000, // last resort; must clear canvasReady + a 700ms reveal

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

/** Collapse whitespace and clamp, then head it with the glyph. */
export function formatLabel(name) {
  const clean = String(name ?? "").replace(/\s+/g, " ").trim();
  const clipped = clean.length > TUNING.MAX_LABEL_CHARS
    ? `${clean.slice(0, TUNING.MAX_LABEL_CHARS - 1).trimEnd()}\u2026`
    : clean;
  return clipped ? `${GLYPH} ${clipped}` : "";
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
  const deny = (reason, name = "") => ({ show: false, reason, name, label: "" });

  if (!scene) return deny("no-scene");

  const cfg = readAreaConfig(scene);
  if (!cfg.name) return deny("no-name");
  if (!cfg.enabled) return deny("disabled", cfg.name);
  if (SUPPRESSED_SCENE_MODES.has(cfg.sceneMode)) return deny("suppressed-scene-mode", cfg.name);

  const isRepeat = typeof lastAreaName === "string"
    && lastAreaName.trim().length > 0
    && lastAreaName.trim() === cfg.name;
  if (isRepeat && !cfg.alwaysShow) return deny("repeat", cfg.name);

  return { show: true, reason: cfg.alwaysShow && isRepeat ? "always-show" : "ok", name: cfg.name, label: formatLabel(cfg.name) };
}
