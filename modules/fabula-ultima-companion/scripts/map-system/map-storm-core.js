// ============================================================================
// Map storm: the pure half (no Foundry, no PIXI). Reads a scene's storm flag
// into numbers and plans each strike. map-storm.js draws it. Tested by
// map-storm-core.test.mjs.
//
// Scene flag (flags.fabula-ultima-companion.ambience.storm):
//   {
//     mode: "above" | "below",   above: forked bolts in the open sky, drawn behind
//                                the ground (Sacrificial Altar). below: no bolts,
//                                the clouds under the map flare from beneath and
//                                the thunder is deeper and quieter (Fafnir Castle).
//     every: [6, 14],            seconds between strikes (random in the range)
//     zones: [{ x: [a, b], y: [a, b], sheet: false, far: 1 }]
//                                where strikes land, map px. y = where a bolt ends
//                                (above) or where the cloud flares (below).
//                                sheet: true = sheet lightning inside low cloud
//                                (no bolt, fainter). far: > 1 = farther (quieter,
//                                later thunder).
//     solid: [[x, y], ...]       above only: the ground's outline. Bolts and their
//                                sky glow are cut out of it, so they sit behind.
//     flash: 0.16,               screen flicker strength at a full strike (0 = none)
//     mist: 0.9,                 how much a strike lights the churning mist
//     sounds: ["…/Thunder1.ogg", …],
//     volume: 0.45,              thunder volume at a near strike (the Ambient slider
//                                scales it)
//   }
// ============================================================================

export const DEFAULT_SOUNDS = [1, 3, 5, 7, 9].map((n) => `https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Thunder${n}.ogg`);

const DEFAULTS = Object.freeze({
  above: { every: [6, 14], flash: 0.16, mist: 0.9, volume: 0.45, rate: [0.82, 1], delay: [300, 1600], sheetDelay: [900, 2200] },
  below: { every: [7, 16], flash: 0.07, mist: 1.1, volume: 0.22, rate: [0.66, 0.78], delay: [500, 1700], sheetDelay: [500, 1700] }
});

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pair = (v, d) => (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(Number(n)))
  ? [Math.min(+v[0], +v[1]), Math.max(+v[0], +v[1])] : d);

/** The scene's storm flag → a clean config, or null when there is no (usable) storm. */
export function readStormConfig(raw) {
  if (!raw || typeof raw !== "object" || raw.enabled === false) return null;
  const mode = raw.mode === "below" ? "below" : "above";
  const D = DEFAULTS[mode];
  const zones = (Array.isArray(raw.zones) ? raw.zones : [])
    .map((z) => ({ x: pair(z?.x, null), y: pair(z?.y, null), sheet: mode === "below" || z?.sheet === true, far: Math.max(0.3, num(z?.far, 1)) }))
    .filter((z) => z.x && z.y);
  if (!zones.length) return null;
  const solid = Array.isArray(raw.solid) && raw.solid.length >= 3 && raw.solid.every((p) => Array.isArray(p) && p.length >= 2)
    ? raw.solid.map((p) => [+p[0], +p[1]]) : null;
  const every = pair(raw.every, D.every);
  return {
    mode,
    every: [Math.max(1, every[0]), Math.max(1, every[1])],
    zones,
    solid: mode === "above" ? solid : null,
    flash: Math.max(0, Math.min(0.6, num(raw.flash, D.flash))),
    mist: Math.max(0, Math.min(1.5, num(raw.mist, D.mist))),
    sounds: Array.isArray(raw.sounds) && raw.sounds.length ? raw.sounds.filter((s) => typeof s === "string" && s) : DEFAULT_SOUNDS,
    volume: Math.max(0, Math.min(1, num(raw.volume, D.volume))),
    rate: D.rate,
    delay: D.delay,
    sheetDelay: D.sheetDelay
  };
}

/** Milliseconds until the next strike. */
export function nextDelayMs(cfg, rand = Math.random) {
  return Math.round((cfg.every[0] + (cfg.every[1] - cfg.every[0]) * rand()) * 1000);
}

/** Where the next strike lands. */
export function pickStrike(cfg, rand = Math.random) {
  const z = cfg.zones[Math.min(cfg.zones.length - 1, Math.floor(rand() * cfg.zones.length))];
  return { x: z.x[0] + (z.x[1] - z.x[0]) * rand(), y: z.y[0] + (z.y[1] - z.y[0]) * rand(), sheet: z.sheet, far: z.far };
}

// Brightness over time, [ms, level]: a bolt flickers twice; sheet lightning
// is one softer pulse; below the castle it rolls a little longer.
const PATTERNS = {
  bolt: [[0, 1], [60, 0.25], [110, 0.9], [190, 0.3], [260, 0.6], [380, 0]],
  sheet: [[0, 0.5], [90, 0.1], [160, 0.35], [300, 0]],
  below: [[0, 0.9], [80, 0.2], [150, 0.7], [260, 0.15], [400, 0]]
};
export function patternFor(cfg, strike) { return cfg.mode === "below" ? PATTERNS.below : strike.sheet ? PATTERNS.sheet : PATTERNS.bolt; }
export function patternLength(pat) { return pat[pat.length - 1][0]; }

/** The pattern's level at ms (linear between keys, 0 after the end). */
export function levelAt(pat, ms) {
  if (ms <= 0) return pat[0][1];
  for (let i = 1; i < pat.length; i++) {
    if (ms < pat[i][0]) { const a = pat[i - 1], b = pat[i]; return a[1] + (b[1] - a[1]) * (ms - a[0]) / (b[0] - a[0]); }
  }
  return 0;
}

/** A forked bolt from above the map down to (x0, yEnd): main line + a few short branches. */
export function makeBolt(x0, yEnd, rand = Math.random) {
  const r = (a, b) => a + (b - a) * rand();
  const main = [[x0, -20]]; const branches = [];
  let x = x0, y = -20;
  while (y < yEnd) {
    x += r(-38, 38); y = Math.min(yEnd, y + r(28, 62)); main.push([x, y]);
    if (rand() < 0.22 && y < yEnd - 80) {
      const b = [[x, y]]; let bx = x, by = y; const dir = rand() < 0.5 ? -1 : 1;
      for (let i = 0; i < 4; i++) { bx += dir * r(10, 40); by += r(20, 45); b.push([bx, by]); }
      branches.push(b);
    }
  }
  return { main, branches };
}

/** When and how the thunder for a strike plays. */
export function thunderFor(cfg, strike, rand = Math.random) {
  const r = (a, b) => a + (b - a) * rand();
  const d = strike.sheet && cfg.mode === "above" ? cfg.sheetDelay : cfg.delay;
  return {
    src: cfg.sounds[Math.min(cfg.sounds.length - 1, Math.floor(rand() * cfg.sounds.length))],
    delayMs: Math.round(d[0] + (d[1] - d[0]) * rand() * strike.far),
    volume: Math.min(1, cfg.volume * (strike.sheet && cfg.mode === "above" ? 0.5 : 1) / strike.far),
    rate: r(cfg.rate[0], cfg.rate[1])
  };
}
