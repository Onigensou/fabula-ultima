// ============================================================================
// Battle shatter transition — the field frame freezes, cracks from a bullet
// impact, the battle scene loads behind the glass, then the glass breaks into
// shards (four of them carry the party's cut-ins) that fly past the camera in
// slow motion and reveal the battlefield.
//
// Port of mockup v25 (claude.ai/artifact/Fth8shFRMvE4pfouiMh6WF). The tables
// below (shapes, cracks, light, timing) are the mockup's tuned values: edit
// them here, they are the production layout.
//
// Glass thickness (a band of slices behind every shard) is OFF by default and
// controlled by the client setting `battleTransitionGlassThickness` — it is
// the heavier "high graphics" variant.
//
// Everything that moves runs on WAAPI transforms/opacity (compositor), so the
// pieces stay smooth while Foundry is busy drawing the battle scene.
//
// API (see playShatterTransition below):
//   await playShatterTransition({ load, ready, cast, thickness })
// ============================================================================

const NS = "fabula-ultima-companion";
const TAG = "[FU Shatter]";
export const SHATTER_THICKNESS_SETTING = "battleTransitionGlassThickness";

// ── timing ──────────────────────────────────────────────────────────────────
// crack = the cracked frame's minimum time on screen (loading usually takes
// longer); push = the slow-down beat (u = 1 at its end: the authored hang
// pose); hang = then time at its slowest before the speed-up (the real hang
// lasts until `ready` resolves, at least this).
const BEAT = { crack: 600, push: 800, hang: 500 };
// the speed-up is booked this far ahead (real ms), or 1.3x the last build if that took longer
const HANDOVER = 200;
let lastBuild = 0;
// The time-speed curve, in design ms of real time since the cut. slowest = the floor scene time
// eases toward (a fraction of real speed); slowDown = how fast it gets there (exponential time
// constant); drift = past that the floor itself keeps easing off as drift / (drift + t), so even an
// endless hang never stops but never runs away; hangMax = how long the slow-down is laid out for;
// speedUp = the speed-up's exponential time constant; dolly = the camera's push through the glass
// (x P x u^3); fade = the depth band (x P) over which a piece fades out at the lens.
const TIME = { slowest: 0.04, slowDown: 317, drift: 2000, hangMax: 30000, speedUp: 237, dolly: 0.01, fade: [0.55, 0.78] };
const sSlow = (t) => (1 - TIME.slowest) * Math.exp(-t / TIME.slowDown) + TIME.slowest * TIME.drift / (TIME.drift + t);
const tauSlow = (t) => (1 - TIME.slowest) * TIME.slowDown * (1 - Math.exp(-t / TIME.slowDown)) + TIME.slowest * TIME.drift * Math.log(1 + t / TIME.drift);   // scene ms by t
// a hang never waits longer than this for `ready` (the slow-down is laid out for TIME.hangMax)
const READY_CAP = 25000;
// "ending" phase: this share of the whole glass sequence (from the cut until the last piece has
// passed the lens). Callers start what follows the transition here (user ruling: 95%).
const ENDING_AT = 0.95;

// ── look ────────────────────────────────────────────────────────────────────
// hi = colour of the light caught by a broken edge; line = the crack itself
const STYLES = {
  ink:     { line: "rgba(10,10,15,.9)", hi: "255,255,255", hiA: 0.9, lineGlow: null, glow: "rgba(255,255,255,.28)" },
  glass:   { line: "rgba(240,248,255,.55)", hi: "235,248,255", hiA: 1, lineGlow: "rgba(160,215,255,.8)", glow: "rgba(160,215,255,.5)" },
  gold:    { line: "rgba(27,19,6,.9)", hi: "255,222,130", hiA: 0.95, lineGlow: null, glow: "rgba(255,206,90,.45)" },
  crimson: { line: "rgba(42,0,8,.9)", hi: "255,140,155", hiA: 0.9, lineGlow: null, glow: "rgba(255,50,80,.4)" },
};
// one light for the whole scene, from the upper left
const LIGHT = { x: -0.55, y: -0.83 };
const SHEEN = { major: 0.38, minor: 0.7 };
// the shortest edge that gets its own glint, as a share of the screen's short side
const GLINT_MIN = 0.025;
const SHADOW = { back: { h: 8, alpha: 0.4 }, mid: { h: 14, alpha: 0.42 }, front: { h: 20, alpha: 0.38 }, major: { h: 30, alpha: 0.55 } };
// behind each cut-in the frozen frame is washed almost white, so the character reads first
const CUTIN_BACK = { b: 1.12, w: 0.8 };
// the cracked frame's light. Before the glass separates each piece is tipped "tilt" of its authored
// face; lighten / darken = brightness change per unit of tilt toward / away from the light, capped
// at max (0.15 = 15%); full strength at the impact, "floor" of it by "reach" (x the screen's short
// side). mirror: pieces whose N.H^exp passes "min" get a reflection band ("width" = its half-width
// as a share of the piece's diagonal), at "alpha" once N.H^exp reaches "full".
// settle: the shatter starts each sheet at this same tilt and reaches its full face by u = settle
const CRACK_LIGHT = { tilt: 0.33, settle: 0.3, lighten: 1.3, darken: 1.5, max: 0.15, floor: 0.35, reach: 0.9,
  mirror: { exp: 80, min: 0.05, full: 0.12, alpha: 0.22, width: 0.45 } };
// how strongly a cut-in leans with its shard (1 = exactly the shard's tilt)
const ART_TILT = 1.6;
// the four tones a small shard can be authored with: how far the frozen frame seen through it is
// darkened or lightened (b = brightness, w = white mixed in). Colour is kept. Neighbours alternate
// light and dark, which is where Persona 5 gets its depth.
const TONES = {
  dark:  { b: 0.42, w: 0 },
  mid:   { b: 0.78, w: 0 },
  light: { b: 1.12, w: 0.06 },
  white: { b: 1.3,  w: 0.16 },
};
// Glass thickness (graphics setting). A shard is drawn as its face plus n copies of its outline
// behind it, each pushed back along the shard's own normal (translateZ in its frame) by an equal
// share of the thickness; the collage's perspective reveals them as a band on the side turning away
// from the camera. Thickness is a share of the screen's short side. One slice draws the band for a
// flat shard; only the tumbling chips, seen edge-on, need more to fill it.
const THICK = { major: { t: 0.01, n: 1 }, minor: { t: 0.007, n: 1 }, chip: { t: 0.006, n: 3 } };
const EDGE = { dark: [34, 46, 48], lit: [170, 196, 192] };

// ── cast: who stands in which cut-in shard ──────────────────────────────────
// The party's critical / Zero Power cut-in art (actor prop cut_in_critical). focus = the face, as a
// fraction of the sprite; at = where on screen the face lands (screen fractions, like the shapes);
// h = sprite height as a fraction of the screen height; lean = extra in-plane rotation, degrees;
// fade = soft edge (% of the sprite) on sides where the art itself is cropped, so no straight cut
// shows inside the shard. The shards grow about 1.25x toward the camera, so frame for the hang
// (u = 1): faces sit a little in from where they should end up. Tune these to reframe a character.
// Keyed by actor name (first word, case-insensitive); anyone else gets SLOT_DEFAULTS.
export const CAST_FRAMING = {
  hina:    { slot: 1, focus: [0.28, 0.33], at: [0.225, 0.31], h: 0.92, lean: -2, fade: { l: 12, r: 10, b: 16 } },
  keren:   { slot: 2, focus: [0.35, 0.19], at: [0.67, 0.25],  h: 0.82, lean: 2,  fade: { b: 6 } },
  blanche: { slot: 3, focus: [0.53, 0.35], at: [0.765, 0.54], h: 0.9,  lean: 3,  fade: { r: 6, b: 10 } },
  zarg:    { slot: 4, focus: [0.52, 0.22], at: [0.36, 0.675], h: 0.62, lean: -3, fade: { b: 18 } },
};
const SLOT_DEFAULTS = {
  1: { focus: [0.45, 0.28], at: [0.225, 0.31], h: 0.9, lean: -2, fade: { l: 8, r: 8, b: 16 } },
  2: { focus: [0.45, 0.24], at: [0.67, 0.25], h: 0.82, lean: 2, fade: { l: 6, r: 6, b: 10 } },
  3: { focus: [0.5, 0.3], at: [0.765, 0.54], h: 0.9, lean: 3, fade: { r: 6, b: 10 } },
  4: { focus: [0.5, 0.25], at: [0.36, 0.675], h: 0.7, lean: -3, fade: { l: 6, r: 6, b: 18 } },
};

// ── the pieces the glass breaks into, and the cracks that foretell them ─────
// major pieces: hand-drawn, in screen fractions (x of width, y of height; the impact is at
// 0.47, 0.50). The first point of each is its tip, aimed at the impact. "bulge" bows an edge
// (edge i runs from point i to point i+1; + bows outward, - inward). Edit these to reshape.
// "face" = where the sheet's normal points at the cut, as its screen-plane part ([0, 0] = square to
// the camera); "turn" = how far it rotates by u = 1, degrees (it keeps spinning at that rate).
const MAJOR_SHAPES = [
  { slot: 1, face: [-0.12, -0.1], turn: [-7, -9, -2], pts: [[0.43, 0.45], [0.33, 0.5], [0.16, 0.49], [0.13, 0.455], [-0.03, 0.47], [-0.03, -0.03], [0.33, -0.03], [0.375, 0.16]], bulge: { 7: 0.015 } },
  { slot: 2, face: [0.13, -0.08], turn: [9, -5, 2], pts: [[0.503, 0.435], [0.543, 0.155], [0.613, -0.015], [0.883, -0.025], [0.863, 0.115], [0.923, 0.195], [0.743, 0.345], [0.623, 0.405]], bulge: { 6: 0.02 } },
  { slot: 3, face: [0.15, 0.05], turn: [10, 5, -2], pts: [[0.531, 0.547], [0.676, 0.422], [0.836, 0.372], [1.026, 0.312], [1.036, 0.782], [0.896, 0.822], [0.861, 0.742], [0.716, 0.782], [0.616, 0.672]], bulge: { 7: 0.02 } },
  { slot: 4, face: [-0.08, 0.14], turn: [-8, 9, 2], pts: [[0.449, 0.56], [0.514, 0.76], [0.574, 1.02], [0.134, 1.02], [0.174, 0.89], [0.074, 0.82], [0.194, 0.7], [0.314, 0.625]], bulge: { 6: -0.015 } },
];
// small shards: hand-placed in the gaps the major pieces leave, same units, first point = the
// sharp tip, aimed at the impact. Persona 5 shard frame: a dark slab per gap (z "back"), a medium
// shard ("mid"), a thin bright sliver crossing them ("front"); "chip" = impact debris, flies first.
// The authored outlines only decide which cracked panes are whose: every shard is drawn with the
// outline traced from its panes (crackRegions). B2 and L3 own no pane and are left out.
const MINOR_SHAPES = [
  // top gap, between cut-ins 1 and 2
  { id: "T1", z: "back", tone: "dark", face: [-0.06, -0.22], turn: [-5, -8, -2], pts: [[0.445, 0.333], [0.341, -0.011], [0.431, -0.011], [0.441, 0.078], [0.461, 0.167]] },
  { id: "T2", z: "mid", tone: "mid", face: [0.2, -0.08], turn: [9, -3, 3], pts: [[0.495, 0.367], [0.531, 0.178], [0.6, -0.011], [0.507, -0.011], [0.494, 0.133], [0.481, 0.233]] },
  { id: "T3", z: "front", tone: "white", face: [-0.26, -0.3], turn: [8, 6, -5], pts: [[0.479, 0.29], [0.445, -0.008], [0.475, -0.013], [0.48, 0.142]] },
  { id: "T4", z: "front", tone: "light", face: [0.1, 0.18], turn: [-10, -14, 6], pts: [[0.47, 0.444], [0.453, 0.333], [0.492, 0.353]] },
  // right gap, between cut-ins 2 and 3, and the top-right corner
  { id: "R1", z: "mid", tone: "light", face: [0.1, -0.25], turn: [-6, -6, -2], pts: [[0.619, 0.444], [0.826, 0.291], [0.844, 0.316], [0.82, 0.34]] },
  { id: "R2", z: "front", tone: "white", face: [-0.2, -0.3], turn: [10, 10, 8], pts: [[0.541, 0.496], [0.593, 0.438], [0.611, 0.442], [0.598, 0.479]] },
  { id: "R5", z: "back", tone: "dark", face: [0.28, 0.06], turn: [6, 4, 2], pts: [[0.841, 0.353], [0.925, 0.227], [1.006, 0.167], [1.006, 0.304], [0.919, 0.333]] },
  { id: "R4", z: "mid", tone: "mid", face: [0.05, -0.3], turn: [-12, 0, -3], pts: [[0.906, 0.116], [1.006, 0.011], [1.006, 0.133], [0.956, 0.142]] },
  { id: "R6", z: "front", tone: "white", face: [-0.3, -0.36], turn: [5, -6, 6], pts: [[0.899, 0.058], [0.956, -0.011], [0.924, -0.011]] },
  // bottom-right gap, between cut-ins 3 and 4, and the bottom-right corner
  { id: "B1", z: "back", tone: "dark", face: [0.15, 0.25], turn: [5, 6, 2], pts: [[0.505, 0.6], [0.578, 1.011], [0.681, 1.011], [0.625, 0.8], [0.55, 0.656]] },
  { id: "B2", z: "mid", tone: "light", face: [-0.12, -0.1], turn: [-8, -14, -3], pts: [[0.546, 0.622], [0.713, 0.796], [0.735, 0.853], [0.681, 0.88], [0.631, 0.778]] },
  { id: "B3", z: "front", tone: "white", face: [-0.25, -0.32], turn: [12, 10, 5], pts: [[0.544, 0.654], [0.626, 0.825], [0.654, 0.961], [0.64, 0.967], [0.599, 0.834]] },
  { id: "B4", z: "back", tone: "dark", face: [0.22, 0.18], turn: [4, 8, -2], pts: [[0.72, 0.813], [0.87, 0.787], [0.892, 0.836], [1.006, 0.807], [1.006, 1.011], [0.887, 1.011]] },
  { id: "B5", z: "front", tone: "light", face: [-0.05, -0.2], turn: [-10, -10, 4], pts: [[0.756, 0.858], [0.887, 0.944], [0.95, 1.011], [0.9, 1.011], [0.806, 0.933]] },
  { id: "B6", z: "mid", tone: "mid", face: [0.3, 0.1], turn: [6, -2, 2], pts: [[0.681, 0.88], [0.844, 0.978], [0.85, 1.011], [0.719, 1.011]] },
  // left gap, between cut-ins 4 and 1, and the bottom-left corner
  { id: "L1", z: "back", tone: "dark", face: [-0.22, 0.06], turn: [-6, -10, -2], pts: [[0.394, 0.509], [0.269, 0.573], [0.113, 0.609], [-0.006, 0.644], [-0.006, 0.48], [0.16, 0.503], [0.33, 0.514]] },
  { id: "L2", z: "mid", tone: "light", face: [-0.18, -0.32], turn: [6, 10, -3], pts: [[0.376, 0.542], [0.216, 0.656], [0.077, 0.736], [0.103, 0.666], [0.224, 0.607]] },
  { id: "L3", z: "front", tone: "white", face: [-0.1, -0.15], turn: [-8, -12, -5], pts: [[0.417, 0.541], [0.186, 0.603], [0.18, 0.589], [0.275, 0.565]] },
  { id: "L5", z: "mid", tone: "dark", face: [-0.05, 0.3], turn: [-6, 4, 3], pts: [[0.169, 0.707], [0.037, 0.806], [-0.006, 0.824], [-0.006, 0.711], [0.075, 0.698]] },
  { id: "L4", z: "back", tone: "mid", face: [-0.3, 0.15], turn: [-4, -10, 2], pts: [[0.144, 0.896], [-0.006, 0.969], [-0.006, 0.878], [0.063, 0.844]] },
  // chips around the impact (they tumble, so their turns are whole turns)
  { id: "C1", z: "chip", tone: "white", face: [-0.3, 0.1], turn: [260, -180, 140], pts: [[0.461, 0.501], [0.415, 0.531], [0.408, 0.494]] },
  { id: "C2", z: "chip", tone: "dark", face: [0.2, -0.3], turn: [-220, 160, -200], pts: [[0.456, 0.489], [0.432, 0.486], [0.435, 0.457]] },
  { id: "C3", z: "chip", tone: "light", face: [-0.1, -0.4], turn: [180, 240, 90], pts: [[0.466, 0.488], [0.446, 0.447], [0.46, 0.424]] },
  { id: "C4", z: "chip", tone: "dark", face: [0.3, 0.2], turn: [-240, -200, 160], pts: [[0.469, 0.467], [0.459, 0.404], [0.475, 0.396]] },
  { id: "C5", z: "chip", tone: "white", face: [-0.35, -0.2], turn: [200, 140, -120], pts: [[0.473, 0.483], [0.476, 0.434], [0.49, 0.436]] },
  { id: "C6", z: "chip", tone: "mid", face: [0.1, 0.35], turn: [-180, 260, 200], pts: [[0.48, 0.493], [0.519, 0.439], [0.53, 0.453], [0.533, 0.472]] },
  { id: "C7", z: "chip", tone: "white", face: [-0.2, -0.25], turn: [240, -120, -160], pts: [[0.495, 0.506], [0.525, 0.501], [0.526, 0.524]] },
  { id: "C8", z: "chip", tone: "dark", face: [0.35, -0.1], turn: [-200, -240, 120], pts: [[0.478, 0.511], [0.506, 0.532], [0.498, 0.56]] },
  { id: "C9", z: "chip", tone: "light", face: [-0.25, 0.3], turn: [160, 200, -180], pts: [[0.474, 0.523], [0.498, 0.598], [0.479, 0.619]] },
  { id: "C10", z: "chip", tone: "white", face: [0.15, -0.35], turn: [-260, 180, 140], pts: [[0.468, 0.515], [0.472, 0.563], [0.457, 0.565]] },
  { id: "C11", z: "chip", tone: "mid", face: [-0.4, 0], turn: [220, -160, 200], pts: [[0.459, 0.512], [0.444, 0.545], [0.433, 0.528]] },
  { id: "C12", z: "chip", tone: "light", face: [0, 0.3], turn: [-160, -220, -140], pts: [[0.449, 0.479], [0.434, 0.474], [0.437, 0.456]] },
];
// the crack on the frozen frame: hand-made from the shatter. CRACKS runs down the gaps between the
// pieces above, so every crack is a line a piece later separates along; edit a piece and its cracks
// together. HAIRLINES start on a crack, run into a piece and stop. Neither these nor RINGS change the
// pieces: they are surface fractures that do not go through.
const CRACKS = [
  // top gap: between cut-in 1, T1, T3, T2 and cut-in 2
  [[0.463, 0.478], [0.45, 0.43], [0.437, 0.36], [0.428, 0.335], [0.393, 0.198], [0.344, 0.013], [0.336, -0.03]],
  [[0.437, 0.36], [0.449, 0.329], [0.464, 0.3], [0.463, 0.164], [0.448, 0.082], [0.438, -0.03]],
  [[0.487, 0.462], [0.497, 0.383], [0.492, 0.351], [0.478, 0.323], [0.481, 0.216], [0.486, 0.136], [0.49, -0.03]],
  [[0.478, 0.31], [0.457, 0.32]],
  [[0.497, 0.383], [0.502, 0.376], [0.533, 0.187], [0.544, 0.145], [0.604, -0.007], [0.6, -0.03]],
  // right gap: cut-in 2 / R1, R2 / cut-in 3, and the top-right corner
  [[0.49, 0.486], [0.517, 0.476], [0.537, 0.454], [0.594, 0.424], [0.619, 0.424], [0.715, 0.366], [0.82, 0.286], [0.855, 0.284], [0.931, 0.2], [0.939, 0.174], [1.004, 0.149], [1.03, 0.149]],
  [[0.49, 0.505], [0.527, 0.516], [0.555, 0.506], [0.599, 0.482], [0.615, 0.453], [0.674, 0.417], [0.836, 0.349], [0.851, 0.358], [1.008, 0.309], [1.03, 0.279]],
  [[0.836, 0.35], [0.849, 0.322], [0.855, 0.284]],
  [[0.939, 0.174], [0.897, 0.13], [0.887, 0.089], [0.888, 0.033], [0.902, -0.03]],
  [[0.892, 0.073], [0.917, 0.069], [0.963, 0.017], [0.98, -0.03]],
  // bottom-right gap: cut-in 3 / B2, B3, B1 / cut-in 4, and the bottom-right corner
  [[0.49, 0.52], [0.499, 0.544], [0.516, 0.576], [0.535, 0.596], [0.556, 0.609], [0.639, 0.709], [0.72, 0.791], [0.731, 0.793], [0.851, 0.767], [0.87, 0.78], [0.892, 0.827], [1.011, 0.798], [1.03, 0.8]],
  [[0.535, 0.596], [0.543, 0.634], [0.616, 0.768], [0.633, 0.803], [0.654, 0.862], [0.669, 0.887], [0.682, 0.88], [0.741, 0.88], [0.754, 0.858], [0.857, 0.928], [0.948, 1.004], [0.96, 1.03]],
  [[0.669, 0.887], [0.695, 1.002], [0.699, 1.03]],
  [[0.741, 0.88], [0.791, 0.931], [0.846, 0.971], [0.854, 0.989], [0.868, 1.03]],
  [[0.478, 0.515], [0.494, 0.513], [0.495, 0.538], [0.484, 0.571], [0.492, 0.627], [0.518, 0.736], [0.574, 1.006], [0.585, 1.03]],
  [[0.562, 0.668], [0.604, 0.818]],
  // left gap: cut-in 1 / L1, L3, L2 / L5, L4 / cut-in 4
  [[0.455, 0.494], [0.41, 0.496], [0.326, 0.507], [0.156, 0.496], [0.104, 0.473], [-0.03, 0.473]],
  [[0.456, 0.506], [0.411, 0.512], [0.381, 0.531], [0.343, 0.562], [0.191, 0.61], [0.095, 0.639], [0.07, 0.661], [-0.03, 0.676]],
  [[0.374, 0.53], [0.286, 0.564], [0.181, 0.589]],
  [[0.462, 0.512], [0.436, 0.526], [0.424, 0.553], [0.409, 0.556], [0.346, 0.586], [0.184, 0.69], [0.1, 0.701], [-0.03, 0.703]],
  [[0.18, 0.692], [0.172, 0.712], [0.066, 0.806], [0.062, 0.82], [-0.03, 0.849]],
  [[0.062, 0.82], [0.149, 0.884], [0.154, 0.898], [0.113, 0.964], [0.084, 1.03]],
];
const HAIRLINES = [
  [[0.37, 0.112], [0.345, 0.104], [0.322, 0.109], [0.305, 0.1]],
  [[0.25, 0.502], [0.246, 0.47], [0.237, 0.452]],
  [[0.523, 0.246], [0.548, 0.236], [0.566, 0.241]],
  [[0.802, 0.299], [0.796, 0.27], [0.799, 0.252]],
  [[0.95, 0.327], [0.946, 0.36], [0.953, 0.385]],
  [[0.584, 0.643], [0.61, 0.628], [0.628, 0.632]],
  [[0.247, 0.649], [0.255, 0.68], [0.251, 0.705]],
  [[0.502, 0.671], [0.478, 0.682], [0.462, 0.679]],
];
// the bullet hole at the impact: a small ragged HOLE (dark: the void behind the glass) inside a
// ring of crushed, frosted glass (FROST, its outer edge). Points are px on a 1600 x 900 screen,
// relative to the impact point, so the hole stays round on any screen. The rays start at FROST.
const HOLE = [[6.5, 0], [3.6, 4.4], [-1, 7.2], [-4.9, 4.6], [-7.4, 1.1], [-6, -2.6], [-5.6, -5.9], [-1.6, -6.4], [2.4, -7.6], [3.9, -4.3], [6.8, -3.1]];
const FROST = [[26.7, 4], [19, 13], [14.5, 25.1], [1.9, 24.9], [-8, 20.5], [-20.5, 19], [-28.7, 8.8], [-23.7, -3.6], [-21.5, -14.7], [-11.5, -19.9], [-2.2, -28.9], [9.9, -25.1], [16.1, -15], [23.9, -7.4]];
// RINGS: the cracks across the main ones, short chords from crack to crack (each starts and ends
// on a crack and crosses none), dense close to the impact and sparse further out
const RINGS = [
  [[0.427, 0.495], [0.439, 0.473], [0.452, 0.436]],
  [[0.452, 0.436], [0.474, 0.438], [0.491, 0.433]],
  [[0.491, 0.433], [0.499, 0.46], [0.509, 0.479]],
  [[0.509, 0.479], [0.507, 0.491], [0.508, 0.51]],
  [[0.508, 0.51], [0.502, 0.528], [0.499, 0.545]],
  [[0.499, 0.545], [0.493, 0.551], [0.488, 0.559]],
  [[0.488, 0.559], [0.458, 0.539], [0.433, 0.533]],
  [[0.41, 0.496], [0.433, 0.461], [0.447, 0.414]],
  [[0.494, 0.409], [0.506, 0.447], [0.521, 0.471]],
  [[0.488, 0.6], [0.464, 0.573], [0.421, 0.554]],
  [[0.421, 0.554], [0.42, 0.536], [0.416, 0.511]],
  [[0.39, 0.499], [0.414, 0.462], [0.443, 0.392]],
  [[0.543, 0.451], [0.537, 0.484], [0.537, 0.513]],
  [[0.537, 0.513], [0.53, 0.557], [0.529, 0.59]],
  [[0.529, 0.59], [0.505, 0.602], [0.491, 0.621]],
  [[0.48, 0.327], [0.489, 0.343], [0.505, 0.358]],
  [[0.505, 0.358], [0.524, 0.401], [0.555, 0.445]],
  [[0.559, 0.504], [0.545, 0.56], [0.539, 0.599]],
  [[0.536, 0.603], [0.518, 0.635], [0.503, 0.673]],
  [[0.385, 0.567], [0.384, 0.544], [0.381, 0.531]],
  [[0.588, 0.427], [0.592, 0.461], [0.6, 0.48]],
  [[0.36, 0.536], [0.355, 0.522], [0.346, 0.504]],
  [[0.407, 0.251], [0.431, 0.236], [0.463, 0.203]],
  [[0.574, 0.71], [0.543, 0.75], [0.529, 0.788]],
];
// The debris is the fastest thing in the scene. Its depth always stays ahead of the cut-ins'
// (z 0.2-0.23 P at u = 1), matching the paint order.
const DEBRIS = { chip: { far: [0.08, 0.3], z: [0.26, 0.5] }, flake: { far: [0.04, 0.3], z: [0.24, 0.5] } };
const TRACE_EPS = 1.6;   // px a traced outline may stray from the pixel edge of its panes

// ── pure helpers ────────────────────────────────────────────────────────────
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const lerp = (p, q, k) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function segDist2(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t); }
function polyInfo(poly) {
  let A = 0, cx = 0, cy = 0, minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], c = p.x * q.y - q.x * p.y;
    A += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  A /= 2;
  return { area: Math.abs(A), cx: cx / (6 * A), cy: cy / (6 * A), minX, minY, maxX, maxY };
}
function trace(ctx, poly, close) { ctx.moveTo(poly[0].x, poly[0].y); for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y); if (close) ctx.closePath(); }
// a tapered segment as a filled quad, plus a round cap so consecutive segments join smoothly;
// every shape is wound the same way so one nonzero fill unions them
function quad(x, a, b, wa, wb, ox, oy) {
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
  const A = { x: a.x + ox, y: a.y + oy }, B = { x: b.x + ox, y: b.y + oy };
  x.moveTo(A.x + nx * wa / 2, A.y + ny * wa / 2); x.lineTo(B.x + nx * wb / 2, B.y + ny * wb / 2);
  x.lineTo(B.x - nx * wb / 2, B.y - ny * wb / 2); x.lineTo(A.x - nx * wa / 2, A.y - ny * wa / 2); x.closePath();
  if (wa > 0.4) { x.moveTo(A.x + wa / 2, A.y); x.arc(A.x, A.y, wa / 2, 0, Math.PI * 2, true); }
}
const curveEdges = (pts, bulge) => {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]; out.push(p);
    const bw = bulge[i]; if (!bw) continue;
    const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy), c = { x: (p.x + q.x) / 2 + dy / l * bw * l * 2, y: (p.y + q.y) / 2 - dx / l * bw * l * 2 };
    for (const t of [0.25, 0.5, 0.75]) out.push({ x: (1 - t) * (1 - t) * p.x + 2 * (1 - t) * t * c.x + t * t * q.x, y: (1 - t) * (1 - t) * p.y + 2 * (1 - t) * t * c.y + t * t * q.y });
  }
  return out;
};
const ptInPoly = (p, x0, y0) => { let c = false; for (let i = 0, k = p.length - 1; i < p.length; k = i++) { const a = p[i], b = p[k]; if ((a.y > y0) !== (b.y > y0) && x0 < (b.x - a.x) * (y0 - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
const frostOut = (sc) => Math.max(...FROST.map(([fx, fy]) => Math.hypot(fx, fy))) * sc;
// ── shards in 3D: every shard is a flat sheet with its own orientation, lit per moment ──
const v3 = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return { x: x / l, y: y / l, z: z / l }; };
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
// the key light: the same upper-left light as the crack, standing in front of the glass
const L3 = v3(LIGHT.x * 0.76, LIGHT.y * 0.76, 0.65);
const SUN = { x: -L3.x / L3.z, y: -L3.y / L3.z };   // how far a shadow falls per px of height
const rot3 = (m, v) => {
  if (m.r) { const r = m.r; return { x: r[0] * v.x + r[1] * v.y + r[2] * v.z, y: r[3] * v.x + r[4] * v.y + r[5] * v.z, z: r[6] * v.x + r[7] * v.y + r[8] * v.z }; }
  const p = m.transformPoint(new DOMPoint(v.x, v.y, v.z, 0)); return { x: p.x, y: p.y, z: p.z };
};
// the rotation CSS draws for rotateX(rx) rotateY(ry) rotateZ(rz) (degrees), as a plain 3x3 matrix
const rotM = (rx, ry, rz) => {
  const d = Math.PI / 180, a = rx * d, b = ry * d, c = rz * d, ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  return { r: [cb * cc, -cb * sc, sb, sa * sb * cc + ca * sc, -sa * sb * sc + ca * cc, -sa * cb, -ca * sb * cc + sa * sc, ca * sb * sc + sa * cc, ca * cb] };
};
const lift = (x, y, N) => v3(x, y, -(N.x * x + N.y * y) / N.z);   // a screen direction laid into the sheet's plane
// the sheet's normal at u: at the cut it is tipped CRACK_LIGHT.tilt of its face (as its pane in the
// cracked frame), and settles into the full face by u = CRACK_LIGHT.settle
const faceAt = (f, u) => {
  const k = CRACK_LIGHT.tilt + (1 - CRACK_LIGHT.tilt) * (u == null ? 1 : Math.min(1, u / CRACK_LIGHT.settle) ** 0.5), fx = f[0] * k, fy = f[1] * k;
  return v3(fx, fy, Math.sqrt(Math.max(0.2, 1 - fx * fx - fy * fy)));
};
function shine(lt, M, pos, cam, u) {
  const N = rot3(M, lt.f ? faceAt(lt.f, u) : lt.N0), V = v3(cam.x - pos.x, cam.y - pos.y, cam.z - pos.z);
  const Hh = v3(L3.x + V.x, L3.y + V.y, L3.z + V.z);
  const lit = dot3(N, L3) - L3.z;   // compared with a sheet square to the camera
  // An edge flashes when the half-vector lies in the plane across that edge, on the outer side.
  const edges = lt.edges.map((e) => {
    const t = rot3(M, e.t3), o = rot3(M, e.o3), ho = dot3(Hh, o), ht = dot3(Hh, t);
    const g = ho <= 0 ? 0 : Math.pow(1 - ht * ht, 40) * clamp(ho / 0.2, 0, 1);
    return clamp((g - 0.16) / 0.2, 0, 1);   // hard: on or off, with a short fade between
  });
  return {
    light: clamp(lit * 0.9, 0, 0.24), dark: clamp(-lit * 1.7, 0, 0.5),
    sheen: Math.pow(Math.max(0, dot3(N, Hh)), 40),
    band: clamp(((N.x - Hh.x) * LIGHT.x + (N.y - Hh.y) * LIGHT.y) * 3, -1.3, 1.3),
    edges,
  };
}
const bandAt = (ov, v) => `rotate(${ov.angle.toFixed(1)}deg) translateX(${(v.band * ov.size * 0.3).toFixed(1)}px)`;
// Full precision: in slow motion a small shard moves ~0.01 px per ms; rounded positions step unevenly.
const tf = (x, y, z, rx, ry, rz, s = 1) => `translate3d(${x.toFixed(3)}px,${y.toFixed(3)}px,${z.toFixed(3)}px) rotateX(${rx.toFixed(4)}deg) rotateY(${ry.toFixed(4)}deg) rotateZ(${rz.toFixed(4)}deg) scale(${s})`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// one animation frame, or a timeout: a hidden window pauses rAF and the transition must not park
const frame = (cap = 250) => new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(go); setTimeout(go, cap); });
const raceTimeout = (p, ms) => Promise.race([p, wait(ms)]);

// ── the cracked panes, cached per screen size (they depend only on W x H) ───
let regionCache = null;

// ============================================================================
// A scene: everything that depends on the screen size, in one closure (the
// mockup's code, near verbatim). els = the overlay's canvases (absent for a
// prewarm, which only needs crackRegions).
// ============================================================================
function makeScene({ W, H, DPR, thick = false, st = STYLES.ink, els = {} }) {
  const { snapC, refrC, glowC, cracksC, collage } = els;

  function buildGeometry() {
    const U = Math.min(W, H), I = { x: 0.47 * W, y: 0.5 * H }, R = rng(9157), TAU = Math.PI * 2;
    const sc = U / 900;   // line widths below are px on a 1600 x 900 screen
    const px = (l) => l.map(([u, v]) => ({ x: u * W, y: v * H }));
    const cells = [
      ...MAJOR_SHAPES.map((m) => ({ poly: curveEdges(px(m.pts), m.bulge), kind: "major", id: `cut-in ${m.slot}`, face: m.face })),
      ...MINOR_SHAPES.map((m) => ({ poly: px(m.pts), kind: m.z === "chip" ? "core" : "minor", id: m.id, face: m.face })),
    ];
    // Every crack is a stroke with a width at each point: the main cracks are heaviest at the impact
    // and thin out with distance; ring cracks and hairlines are finer; a free end tapers to a point.
    const dist = (p) => Math.hypot(p.x - I.x, p.y - I.y);
    const mainW = (p) => 3 * sc * (1 - 0.45 * Math.min(1, dist(p) / (0.9 * U)));
    // FROST's radius in direction a (px on a 900-high screen), interpolated between its points
    const frostR = (a) => {
      const pol = FROST.map(([fx, fy]) => ({ a: Math.atan2(fy, fx), r: Math.hypot(fx, fy) })).sort((p, q) => p.a - q.a);
      for (let i = 0; i < pol.length; i++) {
        const p = pol[i], q = pol[(i + 1) % pol.length], span = ((q.a - p.a) + TAU) % TAU, d = ((a - p.a) + TAU) % TAU;
        if (d <= span) return p.r + (q.r - p.r) * (d / span);
      }
      return pol[0].r;
    };
    // The first cracks spring from the crushed ring: a main crack whose end lies near the impact is
    // joined to FROST's edge, straight out from the hole.
    const spring = (pts) => {
      for (const end of [0, pts.length - 1]) {
        const p = pts[end], dx = p.x - I.x, dy = p.y - I.y, r = Math.hypot(dx, dy);
        if (r > 0.07 * U) continue;
        const a = Math.atan2(dy, dx), e = { x: I.x + Math.cos(a) * frostR(a) * sc, y: I.y + Math.sin(a) * frostR(a) * sc };
        if (r <= frostR(a) * sc + 1) pts[end] = e;
        else if (end === 0) pts.unshift(e); else pts.push(e);
      }
      return pts;
    };
    const strokes = [
      ...CRACKS.map((l) => ({ pts: spring(px(l)), kind: "main", w: mainW })),
      ...RINGS.map((l) => ({ pts: px(l), kind: "ring", w: (p) => 1.35 * sc * (1 - 0.3 * Math.min(1, dist(p) / (0.5 * U))) })),
      ...HAIRLINES.map((l) => ({ pts: px(l), kind: "hair", w: () => 0.95 * sc })),
    ];
    // A crack end that stops just short of another main crack is run on to meet it (a proper T).
    const mains = strokes.filter((s) => s.kind === "main");
    const nearestOn = (p, self) => {
      let best = null;
      for (const s of mains) {
        if (s === self) continue;
        for (let i = 0; i + 1 < s.pts.length; i++) {
          const a = s.pts[i], b = s.pts[i + 1], dx = b.x - a.x, dy = b.y - a.y;
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
          const c = { x: a.x + dx * t, y: a.y + dy * t }, d = Math.hypot(c.x - p.x, c.y - p.y);
          if (!best || d < best.d) best = { c, d };
        }
      }
      return best;
    };
    for (const s of mains) for (const end of [0, s.pts.length - 1]) {
      const p = s.pts[end];
      if (Math.hypot(p.x - I.x, p.y - I.y) < 0.07 * U) continue;
      const n = nearestOn(p, s);
      if (n && n.d > 0.5 && n.d < 16 * sc) s.pts[end] = n.c;
    }
    // the impact itself: a starburst of fine straight rays from the edge of the frosted ring
    const N = 34;
    for (let i = 0; i < N; i++) {
      const a = (i + (R() - 0.5) * 0.7) * TAU / N, r0 = frostR(a) * (0.92 + R() * 0.2) * sc, r1 = (0.04 + Math.pow(R(), 1.7) * 0.12) * U;
      strokes.push({ pts: [{ x: I.x + Math.cos(a) * r0, y: I.y + Math.sin(a) * r0 }, { x: I.x + Math.cos(a) * r1, y: I.y + Math.sin(a) * r1 }], kind: "ray", w: () => (0.9 + R() * 0.6) * sc });
    }
    // free ends taper: an end is free when it touches no other stroke
    const near = (p, self) => strokes.some((s) => s !== self && s.pts.some((q, i) => i + 1 < s.pts.length && segDist2(p, q, s.pts[i + 1]) < 3.5));
    for (const s of strokes) {
      const n = s.pts.length, cum = [0];
      for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(s.pts[i].x - s.pts[i - 1].x, s.pts[i].y - s.pts[i - 1].y));
      const L = cum[n - 1] || 1, tl = Math.min(28 * sc, L * 0.45);
      const offScreen = (p) => p.x < -2 || p.y < -2 || p.x > W + 2 || p.y > H + 2;
      const atCrater = (p) => dist(p) < 0.06 * U;
      const free0 = s.kind !== "ray" && !offScreen(s.pts[0]) && !atCrater(s.pts[0]) && !near(s.pts[0], s);
      const free1 = s.kind === "ray" || (!offScreen(s.pts[n - 1]) && !atCrater(s.pts[n - 1]) && !near(s.pts[n - 1], s));
      s.width = s.pts.map((p, i) => {
        let w = s.w(p);
        if (s.kind === "ray") return w * (1 - cum[i] / L);
        if (free0) w *= Math.min(1, cum[i] / tl);
        if (free1) w *= Math.min(1, (L - cum[i]) / tl);
        return w;
      });
    }
    return { I, U, cells, strokes };
  }

  const onSide = (p) => { const s = []; if (p.x < 0.5) s.push("L"); if (p.x > W - 0.5) s.push("R"); if (p.y < 0.5) s.push("T"); if (p.y > H - 0.5) s.push("B"); return s; };
  const isBorderEdge = (p, q) => { const a = onSide(p); if (!a.length) return false; const b = onSide(q); return a.some((s) => b.includes(s)); };

  // segments, each oriented away from the impact, carrying its widths at both ends. Radial ones run
  // first in the crack's growth; the rest follow.
  function toSegs(geo) {
    const segs = [];
    for (const s of geo.strokes) for (let i = 0; i + 1 < s.pts.length; i++) {
      let p = s.pts[i], q = s.pts[i + 1], w0 = s.width[i], w1 = s.width[i + 1];
      let d0 = Math.hypot(p.x - geo.I.x, p.y - geo.I.y), d1 = Math.hypot(q.x - geo.I.x, q.y - geo.I.y);
      if (d1 < d0) { [p, q] = [q, p]; [d0, d1] = [d1, d0]; [w0, w1] = [w1, w0]; }
      const dx = q.x - p.x, dy = q.y - p.y, mx = (p.x + q.x) / 2 - geo.I.x, my = (p.y + q.y) / 2 - geo.I.y;
      const radial = s.kind === "ray" || (s.kind === "main" && Math.abs(mx * dx + my * dy) / ((Math.hypot(mx, my) || 1) * (Math.hypot(dx, dy) || 1)) > 0.8);
      segs.push({ p, q, d0, d1, w0, w1, kind: s.kind, cls: radial ? "radial" : "ring" });
    }
    return segs;
  }
  function drawCracks(geo, segs, rMain, rWeb) {
    const x = cracksC.getContext("2d");
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cracksC.width, cracksC.height);
    x.setTransform(DPR, 0, 0, DPR, 0, 0);
    const lim = (s) => (s.cls === "radial" ? rMain : rWeb);
    const cut = (s) => { const L = lim(s); if (s.d0 > L) return null; const k = s.d1 <= L ? 1 : (L - s.d0) / Math.max(1e-3, s.d1 - s.d0); return { e: lerp(s.p, s.q, k), we: s.w0 + (s.w1 - s.w0) * k }; };
    paintStrokes(x, segs, cut);
    drawHole(x, geo);
  }
  // the crack strokes on any canvas (the cracked frame, or a shard): cut(s) trims a segment as the
  // crack grows out, or returns null to skip it; by default every segment is drawn whole
  function paintStrokes(x, segs, cut = (s) => ({ e: s.q, we: s.w1 })) {
    // its thin light edge: a crack is a groove, and the wall facing the light catches it
    const buckets = new Map();
    for (const s of segs) {
      const dx = s.q.x - s.p.x, dy = s.q.y - s.p.y, l = Math.hypot(dx, dy) || 1;
      let nx = -dy / l, ny = dx / l;
      const facing = nx * LIGHT.x + ny * LIGHT.y;
      if (facing > 0) { nx = -nx; ny = -ny; }
      const k = Math.abs(facing);
      if (k < 0.25) continue;
      const a = Math.round(Math.pow(k, 1.4) * 10);
      if (!buckets.has(a)) buckets.set(a, []);
      buckets.get(a).push({ s, nx, ny });
    }
    for (const [a, list] of buckets) {
      x.fillStyle = `rgba(${st.hi},${(st.hiA * a / 10).toFixed(2)})`;
      x.beginPath();
      for (const { s, nx, ny } of list) {
        const c = cut(s); if (!c) continue;
        const off = (w) => w / 2 + Math.max(0.35, w * 0.22);
        const ea = Math.max(0.5, s.w0 * 0.42) * Math.min(1, s.w0 / 0.8), eb = Math.max(0.5, c.we * 0.42) * Math.min(1, c.we / 0.8);
        const A = { x: s.p.x + nx * off(s.w0), y: s.p.y + ny * off(s.w0) }, B = { x: c.e.x + nx * off(c.we), y: c.e.y + ny * off(c.we) };
        quad(x, A, B, ea, eb, 0, 0);
      }
      x.fill("nonzero");
    }
    // the crack lines go on top of every light edge, so a light edge never cuts across a T-junction
    x.fillStyle = st.line;
    if (st.lineGlow) { x.shadowColor = st.lineGlow; x.shadowBlur = 6 * DPR; }
    x.beginPath();
    for (const s of segs) { const c = cut(s); if (c) quad(x, s.p, c.e, s.w0, c.we, 0, 0); }
    x.fill("nonzero");
    x.shadowBlur = 0;
  }
  // The bullet hole: dark, with a thin lit lip on the side away from the light, inside the frost.
  function drawHole(x, geo) {
    drawFrost(x, geo);
    const sc = geo.U / 900, I = geo.I;
    const hole = HOLE.map(([fx, fy]) => ({ x: I.x + fx * sc, y: I.y + fy * sc }));
    x.fillStyle = "rgba(6,6,10,.94)";
    x.beginPath(); trace(x, hole, true); x.fill();
    x.strokeStyle = `rgba(${st.hi},${(0.85 * st.hiA).toFixed(2)})`; x.lineWidth = 1.1 * sc; x.lineJoin = "round";
    x.beginPath();
    let on = false;
    for (let i = 0; i <= hole.length; i++) {
      const p = hole[i % hole.length], fx = (p.x - I.x), fy = (p.y - I.y), l = Math.hypot(fx, fy) || 1;
      const lit = -(fx / l * LIGHT.x + fy / l * LIGHT.y) > 0.25;
      if (lit) { x[on ? "lineTo" : "moveTo"](I.x + fx * 0.86, I.y + fy * 0.86); on = true; } else on = false;
    }
    x.stroke();
  }
  // the frosted ring of crushed glass round the hole (seeded, so every copy is the same frost)
  function drawFrost(x, geo) {
    const sc = geo.U / 900, I = geo.I, R = rng(77), TAU = Math.PI * 2;
    const frost = FROST.map(([fx, fy]) => ({ x: I.x + fx * sc, y: I.y + fy * sc }));
    const rOut = frostOut(sc), rIn = 6 * sc;
    x.save();
    x.beginPath(); trace(x, frost, true); x.clip();
    const g = x.createRadialGradient(I.x, I.y, rIn, I.x, I.y, rOut);
    g.addColorStop(0, "rgba(236,241,246,.5)"); g.addColorStop(0.55, "rgba(236,241,246,.24)"); g.addColorStop(1, "rgba(236,241,246,.04)");
    x.fillStyle = g; x.fillRect(I.x - rOut, I.y - rOut, rOut * 2, rOut * 2);
    for (let i = 0; i < 170; i++) {
      const a = R() * TAU, r = rIn + Math.pow(R(), 1.6) * (rOut - rIn), s = (0.7 + R() * 1.6) * sc, b = R() * TAU;
      const cx = I.x + Math.cos(a) * r, cy = I.y + Math.sin(a) * r, light = R() < 0.72;
      x.fillStyle = light ? `rgba(255,255,255,${(0.35 + R() * 0.5).toFixed(2)})` : `rgba(20,22,28,${(0.25 + R() * 0.35).toFixed(2)})`;
      x.beginPath();
      for (let k = 0; k < 3; k++) { const aa = b + k * 2.1 + (R() - 0.5) * 0.8; x[k ? "lineTo" : "moveTo"](cx + Math.cos(aa) * s, cy + Math.sin(aa) * s); }
      x.closePath(); x.fill();
    }
    x.strokeStyle = st.line; x.lineCap = "round";
    for (let i = 0; i < 22; i++) {
      const a = R() * TAU, r1 = rIn + R() * 4 * sc, r2 = r1 + (4 + R() * 9) * sc, bend = (R() - 0.5) * 0.5;
      x.lineWidth = (0.5 + R() * 0.5) * sc; x.beginPath();
      x.moveTo(I.x + Math.cos(a) * r1, I.y + Math.sin(a) * r1); x.lineTo(I.x + Math.cos(a + bend * 0.2) * r2, I.y + Math.sin(a + bend * 0.2) * r2); x.stroke();
    }
    x.restore();
  }

  // The cracked frame's panes are the regions the drawn cracks enclose, so the picture can only shift
  // or change light ACROSS a crack line, never in the middle of the glass. Found once per screen size:
  // every crack drawn as a barrier, the crushed ring kept apart, the rest flood-filled into regions,
  // each region owned by the shard that covers most of it. Returns per-shard masks (drawn at the
  // impact with destination-in) and per-shard outlines traced from the owned panes (the shatter
  // starts from exactly the cracked frame's pieces).
  function crackRegions(geo) {
    const key = `${W}x${H}@${DPR}`;
    if (regionCache && regionCache.key === key) return regionCache;
    const n = W * H, lab = new Int32Array(n);   // per css pixel: 0 = unfilled, -1 = crushed ring, -2 = crack line, >0 = region
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const x = cv.getContext("2d", { willReadFrequently: true });
    const sc = geo.U / 900;
    x.fillStyle = "#fff"; x.beginPath();
    for (const s of geo.strokes) for (let i = 0; i + 1 < s.pts.length; i++) quad(x, s.pts[i], s.pts[i + 1], Math.max(2, s.width[i]), Math.max(2, s.width[i + 1]), 0, 0);
    x.fill("nonzero");
    let d = x.getImageData(0, 0, W, H).data;
    for (let i = 0; i < n; i++) if (d[i * 4 + 3] > 0) lab[i] = -2;
    x.clearRect(0, 0, W, H); x.beginPath(); trace(x, FROST.map(([fx, fy]) => ({ x: geo.I.x + fx * sc, y: geo.I.y + fy * sc })), true); x.fill();
    d = x.getImageData(0, 0, W, H).data;
    for (let i = 0; i < n; i++) if (d[i * 4 + 3] > 127) lab[i] = -1;
    // flood fill, 4-connected, so a diagonal one-pixel line still holds
    const q = new Int32Array(n), sum = [null];
    let count = 0;
    for (let s = 0; s < n; s++) {
      if (lab[s] !== 0) continue;
      const id = ++count; let head = 0, tail = 0, sx = 0, sy = 0, px = 0;
      lab[s] = id; q[tail++] = s;
      while (head < tail) {
        const i = q[head++], ix = i % W, iy = (i - ix) / W; sx += ix; sy += iy; px++;
        if (ix > 0 && lab[i - 1] === 0) { lab[i - 1] = id; q[tail++] = i - 1; }
        if (ix < W - 1 && lab[i + 1] === 0) { lab[i + 1] = id; q[tail++] = i + 1; }
        if (iy > 0 && lab[i - W] === 0) { lab[i - W] = id; q[tail++] = i - W; }
        if (iy < H - 1 && lab[i + W] === 0) { lab[i + W] = id; q[tail++] = i + W; }
      }
      sum.push({ px, cx: sx / px, cy: sy / px });
    }
    // the line pixels join a neighbouring region, so the edge between two panes runs inside the line
    for (let pass = 0; pass < 6; pass++) {
      let left = 0;
      for (let i = 0; i < n; i++) {
        if (lab[i] !== -2) continue;
        const ix = i % W, v = (ix > 0 && lab[i - 1] > 0 && lab[i - 1]) || (ix < W - 1 && lab[i + 1] > 0 && lab[i + 1]) || (i >= W && lab[i - W] > 0 && lab[i - W]) || (i < n - W && lab[i + W] > 0 && lab[i + W]);
        if (v) lab[i] = -3 - v; else left++;
      }
      for (let i = 0; i < n; i++) if (lab[i] < -2) lab[i] = -lab[i] - 3;
      if (!left) break;
    }
    // which shard covers most of each region: the shards drawn with their index in the red channel
    // (in steps of 6, so an anti-aliased edge between two shards never reads as a third)
    x.clearRect(0, 0, W, H);
    geo.cells.forEach((c, k) => { x.fillStyle = `rgb(${(k + 1) * 6},0,0)`; x.beginPath(); trace(x, c.poly, true); x.fill(); });
    d = x.getImageData(0, 0, W, H).data;
    const K = geo.cells.length + 1, votes = new Uint32Array((count + 1) * K);
    for (let i = 0; i < n; i++) {
      const r = lab[i]; if (r <= 0 || d[i * 4 + 3] !== 255) continue;
      const v = d[i * 4]; if (v % 6) continue;
      votes[r * K + v / 6]++;
    }
    const centres = geo.cells.map((c) => polyInfo(c.poly));
    const owner = new Int32Array(count + 1).fill(-1);
    for (let r = 1; r <= count; r++) {
      let best = 0, bv = 0;
      for (let k = 1; k < K; k++) if (votes[r * K + k] > bv) { bv = votes[r * K + k]; best = k; }
      if (best) { owner[r] = best - 1; continue; }
      let bd = Infinity;   // a pane no shard reaches (out in a gap): the nearest shard's
      centres.forEach((ci, k) => { const dd = Math.hypot(ci.cx - sum[r].cx, ci.cy - sum[r].cy); if (dd < bd) { bd = dd; owner[r] = k; } });
    }
    const K1 = geo.cells.length, box = Array.from({ length: K1 }, () => ({ x0: W, y0: H, x1: -1, y1: -1 }));
    for (let i = 0; i < n; i++) {
      const r = lab[i]; if (r <= 0) continue;
      const b = box[owner[r]], ix = i % W, iy = (i - ix) / W;
      if (ix < b.x0) b.x0 = ix; if (ix > b.x1) b.x1 = ix; if (iy < b.y0) b.y0 = iy; if (iy > b.y1) b.y1 = iy;
    }
    const masks = [];
    box.forEach((b, k) => {
      if (b.x1 < 0) return;
      const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1, im = new ImageData(bw, bh), a = im.data;
      for (let y = 0; y < bh; y++) for (let xx = 0; xx < bw; xx++) {
        const r = lab[(b.y0 + y) * W + b.x0 + xx];
        if (r > 0 && owner[r] === k) a[(y * bw + xx) * 4 + 3] = 255;
      }
      const mc = document.createElement("canvas"); mc.width = bw; mc.height = bh; mc.getContext("2d").putImageData(im, 0, 0);
      masks.push({ k, bx: b.x0, by: b.y0, bw, bh, cv: mc });
    });
    // each shard's outline: largest 4-connected part of its panes, marching squares along pixel
    // corners, Douglas-Peucker to within TRACE_EPS px
    const polys = box.map((b, k) => {
      if (b.x1 < 0) return null;
      const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1, own = new Uint8Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let xx = 0; xx < bw; xx++) { const r = lab[(b.y0 + y) * W + b.x0 + xx]; if (r > 0 && owner[r] === k) own[y * bw + xx] = 1; }
      const comp = new Int32Array(bw * bh), q2 = new Int32Array(bw * bh);
      let best = 0, bestN = 0, ids = 0;
      for (let i = 0; i < bw * bh; i++) {
        if (!own[i] || comp[i]) continue;
        const id = ++ids; let h = 0, t = 0; comp[i] = id; q2[t++] = i;
        while (h < t) { const j = q2[h++], jx = j % bw; for (const nb of [jx > 0 ? j - 1 : -1, jx < bw - 1 ? j + 1 : -1, j - bw, j + bw]) if (nb >= 0 && nb < bw * bh && own[nb] && !comp[nb]) { comp[nb] = id; q2[t++] = nb; } }
        if (t > bestN) { bestN = t; best = id; }
      }
      const inside = (x, y) => x >= 0 && y >= 0 && x < bw && y < bh && comp[y * bw + x] === best;
      const DX = [1, 0, 1, 1, -1, 0, -1, 1, 0, 0, 0, 0, -1, 0, -1, NaN], DY = [0, -1, 0, 0, 0, -1, 0, 0, 1, -1, 1, 1, 0, -1, 0, NaN];
      let sx = 0, sy = 0;
      outer: for (sy = 0; sy < bh; sy++) for (sx = 0; sx < bw; sx++) if (inside(sx, sy)) break outer;
      const pts = []; let x = sx, y = sy, pdx = NaN, pdy = NaN, guard = 0;
      do {
        let i = 0;
        if (inside(x - 1, y - 1)) i += 1; if (inside(x, y - 1)) i += 2; if (inside(x - 1, y)) i += 4; if (inside(x, y)) i += 8;
        let dx, dy;
        if (i === 6) { dx = pdy === -1 ? -1 : 1; dy = 0; } else if (i === 9) { dx = 0; dy = pdx === 1 ? -1 : 1; } else { dx = DX[i]; dy = DY[i]; }
        if (dx !== pdx || dy !== pdy) { pts.push({ x: b.x0 + x, y: b.y0 + y }); pdx = dx; pdy = dy; }
        x += dx; y += dy;
      } while ((x !== sx || y !== sy) && ++guard < 4 * (bw + bh) * 8);
      const simplify = (pl, eps) => {
        if (pl.length < 4) return pl;
        const keep = new Uint8Array(pl.length); keep[0] = keep[pl.length - 1] = 1;
        const st2 = [[0, pl.length - 1]];
        while (st2.length) {
          const [i0, i1] = st2.pop(); let md = 0, mi = -1;
          for (let i = i0 + 1; i < i1; i++) { const dd = segDist2(pl[i], pl[i0], pl[i1]); if (dd > md) { md = dd; mi = i; } }
          if (md > eps) { keep[mi] = 1; st2.push([i0, mi], [mi, i1]); }
        }
        return pl.filter((_, i) => keep[i]);
      };
      // split the loop at its farthest point from the start so both halves simplify cleanly
      let far = 0, fd = 0; pts.forEach((v, i) => { const dd = Math.hypot(v.x - pts[0].x, v.y - pts[0].y); if (dd > fd) { fd = dd; far = i; } });
      const half1 = simplify(pts.slice(0, far + 1), TRACE_EPS), half2 = simplify([...pts.slice(far), pts[0]], TRACE_EPS);
      const out = [...half1, ...half2.slice(1, -1)];
      return { poly: out.length >= 3 ? out : null, px: bestN, stray: own.reduce((nn, v) => nn + v, 0) - bestN };
    });
    const scratch = document.createElement("canvas"); scratch.width = Math.round(W * DPR); scratch.height = Math.round(H * DPR);
    regionCache = { key, count, centres, masks, scratch, polys };
    return regionCache;
  }

  // Broken glass bends the light a little differently in each piece (a 1-2 px shift per piece), and
  // each piece is already tipped CRACK_LIGHT.tilt of the orientation it flies with, lit by the same
  // light as its shard after the cut.
  function drawRefraction(geo) {
    const C = CRACK_LIGHT, I = geo.I, R = rng(4242), reg = crackRegions(geo);
    const cam = { x: I.x, y: I.y, z: W * 0.9 };
    const look = geo.cells.map((c, k) => {
      const info = reg.centres[k], dx = info.cx - I.x, dy = info.cy - I.y, dl = Math.hypot(dx, dy) || 1;
      const amt = (0.6 + R() * 1.4) * (c.kind === "core" ? 1.8 : 1);
      const o = { sx: Math.round((dx / dl * amt + (R() - 0.5)) * DPR), sy: Math.round((dy / dl * amt + (R() - 0.5)) * DPR), k: 0, white: true, band: null };
      const f = c.face || [0, 0], fx = f[0] * C.tilt, fy = f[1] * C.tilt;
      const N = v3(fx, fy, Math.sqrt(1 - fx * fx - fy * fy));
      const lit = dot3(N, L3) - L3.z;
      o.white = lit > 0; o.k = lit > 0 ? Math.min(C.max, lit * C.lighten) : Math.min(C.max, -lit * C.darken);
      const V = v3(cam.x - info.cx, cam.y - info.cy, cam.z), Hh = v3(L3.x + V.x, L3.y + V.y, L3.z + V.z);
      const spec = Math.pow(Math.max(0, dot3(N, Hh)), C.mirror.exp);
      if (spec > C.mirror.min) {
        const diag = Math.hypot(info.maxX - info.minX, info.maxY - info.minY);
        const b = clamp(((N.x - Hh.x) * LIGHT.x + (N.y - Hh.y) * LIGHT.y) * 3, -1.3, 1.3);
        o.band = { a: C.mirror.alpha * Math.min(1, spec / C.mirror.full), mx: info.cx + LIGHT.x * b * diag * 0.3, my: info.cy + LIGHT.y * b * diag * 0.3, h: diag * C.mirror.width };
      }
      return o;
    });
    const x = refrC.getContext("2d"), t = reg.scratch, tx = t.getContext("2d");
    x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = "copy"; x.drawImage(snapC, 0, 0); x.globalCompositeOperation = "source-over";
    const reach = C.reach * geo.U;
    for (const m of reg.masks) {
      const o = look[m.k], BX = Math.round(m.bx * DPR), BY = Math.round(m.by * DPR), BW = Math.round(m.bw * DPR), BH = Math.round(m.bh * DPR);
      tx.setTransform(1, 0, 0, 1, 0, 0); tx.globalCompositeOperation = "copy";
      tx.drawImage(snapC, BX - o.sx, BY - o.sy, BW, BH, 0, 0, BW, BH);
      tx.globalCompositeOperation = "source-over"; tx.setTransform(DPR, 0, 0, DPR, -m.bx * DPR, -m.by * DPR);
      if (o.k) {
        const rgb = o.white ? "255,255,255" : "0,0,0", g = tx.createRadialGradient(I.x, I.y, 0, I.x, I.y, reach);
        g.addColorStop(0, `rgba(${rgb},${o.k.toFixed(3)})`); g.addColorStop(1, `rgba(${rgb},${(o.k * C.floor).toFixed(3)})`);
        tx.fillStyle = g; tx.fillRect(m.bx, m.by, m.bw, m.bh);
      }
      if (o.band) {
        const b = o.band, r = tx.createLinearGradient(b.mx - LIGHT.x * b.h, b.my - LIGHT.y * b.h, b.mx + LIGHT.x * b.h, b.my + LIGHT.y * b.h);
        for (const [off, kk] of [[0, 0], [0.3, 0.25], [0.5, 1], [0.7, 0.25], [1, 0]]) r.addColorStop(off, `rgba(255,255,255,${(b.a * kk).toFixed(3)})`);
        tx.fillStyle = r; tx.fillRect(m.bx, m.by, m.bw, m.bh);
      }
      tx.setTransform(1, 0, 0, 1, 0, 0); tx.globalCompositeOperation = "destination-in"; tx.imageSmoothingEnabled = false;
      tx.drawImage(m.cv, 0, 0, BW, BH);
      tx.imageSmoothingEnabled = true; tx.globalCompositeOperation = "source-over";
      x.drawImage(t, 0, 0, BW, BH, BX, BY, BW, BH);
    }
  }
  // a soft glow breathing along the main cracks while the battle loads behind them
  function drawGlow(segs) {
    const x = glowC.getContext("2d");
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, glowC.width, glowC.height);
    x.setTransform(DPR, 0, 0, DPR, 0, 0); x.lineCap = "round";
    x.shadowColor = st.glow; x.shadowBlur = 12 * DPR; x.strokeStyle = st.glow;
    const buckets = new Map();
    for (const s of segs) { if (s.kind !== "main") continue; const b = Math.round(s.w0 + s.w1); if (!buckets.has(b)) buckets.set(b, []); buckets.get(b).push(s); }
    for (const [b, list] of buckets) {
      x.lineWidth = Math.max(1, b * 1.2); x.beginPath();
      for (const s of list) { x.moveTo(s.p.x, s.p.y); x.lineTo(s.q.x, s.q.y); }
      x.stroke();
    }
  }

  // what a shard keeps of the crack: the surface cracks (rings, hairlines, rays) and the frost
  function paintMarks(x, poly, info, marks) {
    const g = marks.geo, fr = frostOut(g.U / 900);
    if (info.maxX > g.I.x - fr && info.minX < g.I.x + fr && info.maxY > g.I.y - fr && info.minY < g.I.y + fr) drawFrost(x, g);
    const list = marks.segs.filter((s) => Math.max(s.p.x, s.q.x) > info.minX - 4 && Math.min(s.p.x, s.q.x) < info.maxX + 4 && Math.max(s.p.y, s.q.y) > info.minY - 4 && Math.min(s.p.y, s.q.y) < info.maxY + 4);
    if (list.length) paintStrokes(x, list);
  }
  function makePiece(poly, opts) {
    const info = polyInfo(poly);
    const bx = Math.floor(info.minX) - 2, by = Math.floor(info.minY) - 2;
    const bw = Math.ceil(info.maxX) + 2 - bx, bh = Math.ceil(info.maxY) + 2 - by;
    const el = document.createElement("div"); el.className = "fsh-piece";
    const lx = (v) => `${(v.x - bx).toFixed(1)}px ${(v.y - by).toFixed(1)}px`;
    Object.assign(el.style, { width: bw + "px", height: bh + "px", left: bx + "px", top: by + "px", transformOrigin: `${info.cx - bx}px ${info.cy - by}px`, clipPath: `polygon(${poly.map(lx).join(",")})` });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bw * DPR)); c.height = Math.max(1, Math.round(bh * DPR));
    const x = c.getContext("2d");
    x.setTransform(DPR, 0, 0, DPR, -bx * DPR, -by * DPR);
    x.beginPath(); trace(x, poly, true); x.clip();
    // the picture seen through this piece, nudged by its own refraction, darkened or lightened only
    const sh = opts.shift || 0;
    if (opts.tone) x.filter = `brightness(${opts.tone.b.toFixed(2)})`;
    x.drawImage(snapC, (opts.R() - 0.5) * 2 * sh, (opts.R() - 0.5) * 2 * sh, W, H);
    if (opts.marks && !opts.major) paintMarks(x, poly, info, opts.marks);
    x.filter = "none";
    if (opts.tone && opts.tone.w) { x.fillStyle = `rgba(255,255,255,${opts.tone.w.toFixed(2)})`; x.fillRect(bx, by, bw, bh); }
    el.appendChild(c);
    const f = opts.face || [0, 0], fz = Math.sqrt(Math.max(0.2, 1 - f[0] * f[0] - f[1] * f[1]));
    if (opts.art) {
      // the character's cut-in, placed so its focus point (the face) lands on "at", printed on the
      // tilted sheet: the shard's tilt, in perspective about that point. The shard's outline clips it.
      const a = opts.art, sh2 = a.h * H, sw = sh2 * a.aspect;
      const sx = a.at[0] * W - a.focus[0] * sw, sy = a.at[1] * H - a.focus[1] * sh2;
      const img = document.createElement("img"); img.className = "fsh-art"; img.src = a.src; img.alt = ""; img.decoding = "sync";
      const ty = Math.asin(clamp(f[0], -0.9, 0.9)) * 180 / Math.PI * ART_TILT, tx = -Math.asin(clamp(f[1], -0.9, 0.9)) * 180 / Math.PI * ART_TILT;
      Object.assign(img.style, { left: (sx - bx) + "px", top: (sy - by) + "px", width: sw + "px", height: sh2 + "px",
        transformOrigin: `${(a.focus[0] * sw).toFixed(1)}px ${(a.focus[1] * sh2).toFixed(1)}px`,
        transform: `perspective(${Math.round(1.2 * W)}px) rotateY(${ty.toFixed(2)}deg) rotateX(${tx.toFixed(2)}deg) rotateZ(${(a.lean || 0).toFixed(2)}deg)` });
      const fd = a.fade || {};
      if (fd.l || fd.r || fd.b || fd.t) {
        const mk = `linear-gradient(to right, transparent 0, #000 ${fd.l || 0}%, #000 ${100 - (fd.r || 0)}%, transparent 100%), linear-gradient(to bottom, transparent 0, #000 ${fd.t || 0}%, #000 ${100 - (fd.b || 0)}%, transparent 100%)`;
        Object.assign(img.style, { maskImage: mk, webkitMaskImage: mk, maskComposite: "intersect", webkitMaskComposite: "source-in" });
      }
      el.appendChild(img);
    }
    if (opts.marks && opts.major) {
      // on a cut-in the cracks lie over the art, in front of it, on a layer of their own
      const m = document.createElement("canvas"); m.width = c.width; m.height = c.height;
      const mx = m.getContext("2d");
      mx.setTransform(DPR, 0, 0, DPR, -bx * DPR, -by * DPR);
      mx.beginPath(); trace(mx, poly, true); mx.clip();
      paintMarks(mx, poly, info, opts.marks);
      el.appendChild(m);
    }
    // the sheet in 3D, and the light layers its orientation drives
    const N0 = v3(f[0], f[1], fz);
    const ov = { angle: Math.atan2(LIGHT.y, LIGHT.x) * 180 / Math.PI, size: 2 * Math.hypot(bw, bh) };
    for (const k of ["lit", "dim"]) { const dd = document.createElement("div"); dd.className = `fsh-ov fsh-${k}`; el.appendChild(dd); ov[k] = dd; }
    const sn = document.createElement("div"); sn.className = "fsh-sheen";
    const bwid = 0.36 * ov.size, blen = Math.hypot(bw, bh);
    Object.assign(sn.style, { width: bwid + "px", height: blen + "px", left: (info.cx - bx - bwid / 2) + "px", top: (info.cy - by - blen / 2) + "px" });
    el.appendChild(sn); ov.sheen = sn;
    const gw = Math.max(1.2, (opts.major ? 0.0026 : 0.0021) * opts.U);
    const edges = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1, tx = dx / l, ty = dy / l;
      const mx = (p.x + q.x) / 2 - info.cx, my = (p.y + q.y) / 2 - info.cy;
      const sgn = mx * ty - my * tx > 0 ? 1 : -1;   // outward = away from the middle of the piece
      const e = { t3: lift(tx, ty, N0), o3: lift(ty * sgn, -tx * sgn, N0), el: null };
      if (!isBorderEdge(p, q) && l > GLINT_MIN * opts.U) {
        // a long edge glints along part of its length only: a reflection, not an outline
        let t0 = 0, t1 = 1;
        if (l > 0.07 * opts.U) { t0 = opts.R() * 0.35; t1 = Math.min(1, t0 + 0.35 + opts.R() * 0.5); }
        const a = lerp(p, q, t0), g = document.createElement("div"); g.className = "fsh-gl";
        const glen = l * (t1 - t0), tp = Math.min(28 * opts.U / 900, glen * 0.35) / glen * 100;
        Object.assign(g.style, { left: (a.x - bx) + "px", top: (a.y - by - gw) + "px", width: glen + "px", height: (gw * 2) + "px", transform: `rotate(${Math.atan2(dy, dx)}rad)`, background: `rgb(${st.hi})`,
          clipPath: `polygon(0 50%, ${tp.toFixed(1)}% 0, ${(100 - tp).toFixed(1)}% 0, 100% 50%, ${(100 - tp).toFixed(1)}% 100%, ${tp.toFixed(1)}% 100%)` });
        el.appendChild(g); e.el = g;
      }
      edges.push(e);
    }
    const pc = { el, info, bx, by, bw, bh, ov, lt: { N0, edges, f }, major: !!opts.major, turn: opts.turn || [0, 0, 0] };
    if (opts.major) {
      const shade = document.createElement("div"); shade.className = "fsh-shade";
      el.append(shade);
      el._shade = shade;
    }
    // what the cut frame shows before anything moves
    const s0 = shine(pc.lt, new DOMMatrixReadOnly(), { x: info.cx, y: info.cy, z: 0 }, opts.cam, 0);
    pc.s0 = s0;
    const m = opts.major ? 0.5 : 1;   // light on a cut-in sheet stays gentle so the art stays readable
    ov.lit.style.opacity = s0.light * m; ov.dim.style.opacity = s0.dark * m;
    sn.style.opacity = s0.sheen * (opts.major ? SHEEN.major : SHEEN.minor); sn.style.transform = bandAt(ov, s0);
    edges.forEach((e, k) => { if (e.el) e.el.style.opacity = s0.edges[k]; });
    return pc;
  }
  // glass thickness: n clip-path copies of the shard behind it (see THICK). Off = no slices.
  function addSlabs(pc, U, kind) {
    if (!thick) { pc.slabs = []; return pc; }
    const t = THICK[kind].t * U, n = THICK[kind].n, s0 = pc.s0;
    const f = clamp(0.45 + s0.light * 2.5 - s0.dark * 1.2, 0.12, 1);
    const mix = (k) => EDGE.dark.map((v, i) => Math.round(v + (EDGE.lit[i] - v) * k)).join(",");
    const ang = Math.atan2(-LIGHT.x, LIGHT.y) * 180 / Math.PI;   // from the lit side to the far side
    const bg = `linear-gradient(${ang.toFixed(1)}deg, rgb(${mix(f)}) 0%, rgb(${mix(f * 0.25)}) 100%)`;
    pc.slabs = [];
    for (let i = n; i >= 1; i--) {   // back-most first, so they paint in depth order
      const el = document.createElement("div"); el.className = "fsh-piece";
      const z = ` translateZ(${(-t * i / n).toFixed(2)}px)`;
      const s = pc.el.style;
      Object.assign(el.style, { width: s.width, height: s.height, left: s.left, top: s.top, transformOrigin: s.transformOrigin, clipPath: s.clipPath, background: bg, transform: z.trim() });
      pc.slabs.push({ el, z, depth: t * i / n });
    }
    return pc;
  }
  // a soft shadow cast onto whatever lies behind, offset along the light by the sheet's height
  function makeShadow(poly, U, alpha, h) {
    const info = polyInfo(poly), pad = Math.ceil(Math.max(0.03 * U, h * 1.6));
    const bx = Math.floor(info.minX) - pad, by = Math.floor(info.minY) - pad;
    const bw = Math.ceil(info.maxX) + pad - bx, bh = Math.ceil(info.maxY) + pad - by;
    const el = document.createElement("div"); el.className = "fsh-piece";
    Object.assign(el.style, { width: bw + "px", height: bh + "px", left: bx + "px", top: by + "px", transformOrigin: `${info.cx - bx}px ${info.cy - by}px`, opacity: "0" });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bw * DPR)); c.height = Math.max(1, Math.round(bh * DPR));
    const x = c.getContext("2d");
    x.setTransform(DPR, 0, 0, DPR, -bx * DPR, -by * DPR);
    x.shadowColor = "rgba(0,0,0,.9)"; x.shadowBlur = (4 + h * 0.5) * DPR; x.fillStyle = "rgba(0,0,0,.55)";
    x.beginPath(); trace(x, poly, true); x.fill();
    el.appendChild(c);
    return { el, alpha };
  }

  function buildCollage(geo, cast) {
    const R = rng(91);
    collage.replaceChildren();
    const P = W * 0.9, F = geo.I, U = geo.U;
    collage.style.perspective = `${Math.round(P)}px`;
    collage.style.perspectiveOrigin = `${F.x}px ${F.y}px`;
    const dirOf = (pc) => { const dx = pc.info.cx - F.x, dy = pc.info.cy - F.y, dl = Math.hypot(dx, dy) || 1; return { x: dx / dl, y: dy / dl, d: dl }; };
    const cam = { x: F.x, y: F.y, z: P };   // the eye sits at the perspective origin
    // a little jitter so two shards of the same tone never match exactly
    const toneOf = (tone) => { const t = TONES[tone] || TONES.mid; return { b: t.b * (0.95 + R() * 0.1), w: t.w }; };
    // what the shards keep of the crack: every stroke except the main cracks (the gaps)
    const marks = { geo, segs: toSegs(geo).filter((s) => s.kind !== "main") };
    const sliverPiece = (poly, s) => makePiece(poly, { R, U, cam, marks, face: s.face, turn: s.turn, shift: 2, tone: toneOf(s.tone) });
    const back = [], mid = [], front = [], majors = [], cores = [];
    const reg = crackRegions(geo), traced = (k) => reg.polys[k] && reg.polys[k].poly;
    const majorDefs = MAJOR_SHAPES.map((m, k) => ({ slot: m.slot, face: m.face, turn: m.turn, traced: !!traced(k), poly: traced(k) || curveEdges(m.pts.map(([u, v]) => ({ x: u * W, y: v * H })), m.bulge) }));
    // an untraced major may not cover the impact point: slide it outward until it stops short
    const segDist = (p, a, b) => segDist2(p, a, b);
    const clearance = (poly) => (ptInPoly(poly, F.x, F.y) ? -1 : Math.min(...poly.map((v, i) => segDist(F, v, poly[(i + 1) % poly.length]))));
    for (const m of majorDefs) {
      if (m.traced) continue;
      const inf = polyInfo(m.poly), dx = inf.cx - F.x, dy = inf.cy - F.y, dl = Math.hypot(dx, dy) || 1;
      for (let k = 0; k < 40 && clearance(m.poly) < 0.06 * U; k++) m.poly = m.poly.map((v) => ({ x: v.x + dx / dl * 0.01 * U, y: v.y + dy / dl * 0.01 * U }));
    }
    const LAYERS = { back, mid, front, chip: cores };
    // the crushed ring itself, apart from what the chips carry: it bursts into powder at the cut
    const fr = frostOut(U / 900), pad = Math.ceil(fr) + 2;
    const puff = document.createElement("div"); puff.className = "fsh-piece";
    Object.assign(puff.style, { width: 2 * pad + "px", height: 2 * pad + "px", left: (F.x - pad) + "px", top: (F.y - pad) + "px", transformOrigin: `${pad}px ${pad}px` });
    const pcv = document.createElement("canvas"); pcv.width = Math.round(2 * pad * DPR); pcv.height = Math.round(2 * pad * DPR);
    const px = pcv.getContext("2d"); px.setTransform(DPR, 0, 0, DPR, (pad - F.x) * DPR, (pad - F.y) * DPR);
    drawFrost(px, geo);
    puff.appendChild(pcv);
    for (const z of ["back", "mid", "front", "chip"]) {
      for (const s of MINOR_SHAPES) {
        if (s.z !== z) continue;
        const tk = MAJOR_SHAPES.length + MINOR_SHAPES.indexOf(s);
        // a small shard that owns no pane is left out: its glass belongs to a neighbour
        if (reg.polys.some(Boolean) && !traced(tk)) continue;
        const poly = traced(tk) || s.pts.map(([u, v]) => ({ x: u * W, y: v * H }));
        const pc = addSlabs(sliverPiece(poly, s), U, z === "chip" ? "chip" : "minor");
        pc.dir = dirOf(pc); pc.r = R(); pc.id = s.id; LAYERS[z].push(pc);
        if (z !== "chip") pc.shadow = makeShadow(poly, U, SHADOW[z].alpha, SHADOW[z].h);
      }
      for (const pc of LAYERS[z]) if (pc.shadow) collage.appendChild(pc.shadow.el);
      if (z !== "chip") for (const pc of LAYERS[z]) collage.append(...pc.slabs.map((sl) => sl.el), pc.el);
    }
    // the flakes are the crushed ring breaking up: most start inside it, the rest just outside
    const flakes = [], FR = rng(613);
    for (let i = 0; i < 70; i++) {
      const el = document.createElement("div"); el.className = "fsh-flake";
      const inRing = FR() < 0.75, a = FR() * Math.PI * 2, r = inRing ? Math.sqrt(FR()) * fr : fr * (1 + FR() * 2.5);
      const k = FR(), patch = k < 0.25, dark = !patch && k < 0.4;
      const sz = (patch ? 0.008 + FR() * 0.01 : 0.003 + FR() * 0.008) * U;
      const x0 = F.x + Math.cos(a) * r, y0 = F.y + Math.sin(a) * r;
      el.style.width = sz + "px"; el.style.height = sz + "px";
      el.style.background = patch ? "rgba(236,241,246,.55)" : dark ? `rgba(20,22,28,${(0.45 + FR() * 0.3).toFixed(2)})` : `rgba(255,255,255,${(0.6 + FR() * 0.35).toFixed(2)})`;
      el.style.clipPath = `polygon(${(FR() * 40).toFixed(0)}% 0%, 100% ${(40 + FR() * 60).toFixed(0)}%, ${(FR() * 30).toFixed(0)}% 100%)`;
      el.style.transform = `translate3d(${x0}px,${y0}px,0)`; el.style.opacity = "0";
      flakes.push({ el, x0, y0, a, r: FR() });
    }
    // the mockup's old flake scatter drew 480 numbers from R; drawing them keeps the cut-ins' motion
    // and glints exactly as tuned
    for (let i = 0; i < 480; i++) R();
    for (const m of majorDefs) {
      const art = cast.find((c) => c.slot === m.slot) || null;
      const pc = makePiece(m.poly, { R, U, cam, marks, major: true, slot: m.slot, face: m.face, turn: m.turn, shift: 0, tone: art ? CUTIN_BACK : TONES.light, art });
      addSlabs(pc, U, "major");
      pc.dir = dirOf(pc); pc.r = R(); pc.slot = m.slot; pc.id = `cut-in ${m.slot}`; pc.shadow = makeShadow(m.poly, U, SHADOW.major.alpha, SHADOW.major.h); majors.push(pc);
    }
    for (const pc of majors) collage.appendChild(pc.shadow.el);   // one cut-in shades the slivers, never another cut-in
    for (const pc of majors) collage.append(...pc.slabs.map((sl) => sl.el), pc.el);
    // the debris flies toward the camera faster than any cut-in, so it is drawn in front of them
    collage.appendChild(puff);
    for (const pc of cores) collage.append(...pc.slabs.map((sl) => sl.el), pc.el);
    for (const f of flakes) collage.appendChild(f.el);
    return { back, mid, front, majors, cores, flakes, puff, P };
  }

  return { buildGeometry, toSegs, crackRegions, drawCracks, drawRefraction, drawGlow, buildCollage };
}

// ============================================================================
// Overlay DOM + styles
// ============================================================================
const STYLE_ID = "fuc-shatter-style";
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#fuc-shatter { position: fixed; inset: 0; overflow: hidden; pointer-events: auto; contain: strict; }
#fuc-shatter.fsh-passthrough { pointer-events: none; }
#fuc-shatter .fsh-shaker, #fuc-shatter .fsh-layer { position: absolute; inset: 0; }
#fuc-shatter canvas.fsh-layer, #fuc-shatter .fsh-layer > canvas { width: 100%; height: 100%; display: block; }
#fuc-shatter .fsh-arena-dim { background: #000; opacity: 0; }
#fuc-shatter .fsh-crack { visibility: hidden; }
#fuc-shatter .fsh-refr { opacity: 0; }
#fuc-shatter .fsh-glow.fsh-breathe { animation: fsh-breathe var(--fsh-breathe, 1.6s) ease-in-out infinite alternate; }
@keyframes fsh-breathe { from { opacity: .25; } to { opacity: 1; } }
#fuc-shatter .fsh-collage { visibility: hidden; }
#fuc-shatter .fsh-piece { position: absolute; left: 0; top: 0; will-change: transform, opacity; backface-visibility: visible; }
#fuc-shatter .fsh-piece canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
#fuc-shatter .fsh-shade { position: absolute; inset: 0; opacity: 0; background: #000; will-change: opacity; }
#fuc-shatter img.fsh-art { position: absolute; max-width: none; max-height: none; border: 0; pointer-events: none; user-select: none; }
#fuc-shatter .fsh-ov, #fuc-shatter .fsh-sheen, #fuc-shatter .fsh-gl { position: absolute; pointer-events: none; will-change: opacity, transform; }
#fuc-shatter .fsh-ov { inset: 0; }
#fuc-shatter .fsh-lit { background: #fff; }
#fuc-shatter .fsh-ov.fsh-dim { background: #000; }
#fuc-shatter .fsh-sheen { background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.28) 33.3%, rgba(255,255,255,.9) 48.6%, rgba(255,255,255,.9) 51.4%, rgba(255,255,255,.28) 66.7%, rgba(255,255,255,0) 100%); }
#fuc-shatter .fsh-gl { transform-origin: 0 50%; }
#fuc-shatter .fsh-flake { position: absolute; left: 0; top: 0; will-change: transform, opacity; }
#fuc-shatter .fsh-flash { pointer-events: none; opacity: 0; background: radial-gradient(circle at var(--fsh-ix, 47%) var(--fsh-iy, 50%), #fff 0, rgba(255,255,255,.85) 22%, rgba(255,255,255,.35) 60%, rgba(255,255,255,.15) 100%); }
body.fuc-shatter-active #loading { display: none !important; }
`;
  document.head.appendChild(s);
}
function mountOverlay(W, H, DPR, zIndex) {
  injectStyles();
  document.getElementById("fuc-shatter")?.remove();
  const root = document.createElement("div"); root.id = "fuc-shatter";
  root.style.zIndex = String(zIndex);
  const mk = (tag, cls) => { const e = document.createElement(tag); e.className = cls; return e; };
  const shaker = mk("div", "fsh-shaker");
  const dim = mk("div", "fsh-layer fsh-arena-dim");
  const crackFrame = mk("div", "fsh-layer fsh-crack");
  const snapC = mk("canvas", "fsh-layer"), refrC = mk("canvas", "fsh-layer fsh-refr"), glowC = mk("canvas", "fsh-layer fsh-glow"), cracksC = mk("canvas", "fsh-layer");
  for (const c of [snapC, refrC, glowC, cracksC]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
  crackFrame.append(snapC, refrC, glowC, cracksC);
  const collage = mk("div", "fsh-layer fsh-collage");
  const flash = mk("div", "fsh-layer fsh-flash");
  shaker.append(dim, crackFrame, collage, flash);
  root.appendChild(shaker);
  return { root, shaker, dim, crackFrame, snapC, refrC, glowC, cracksC, collage, flash };
}

// ============================================================================
// Freeze: render one frame of the Foundry canvas and copy it in the same task
// (the WebGL buffer is not preserved, so it must be read before it is presented).
// Returns false when there is nothing to freeze.
// ============================================================================
function freezeCanvas(snapC) {
  const view = globalThis.canvas?.app?.view;
  const renderer = globalThis.canvas?.app?.renderer;
  if (!view || !renderer || !view.width || !view.height) return false;
  try {
    renderer.render(globalThis.canvas.app.stage);
    const x = snapC.getContext("2d");
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.drawImage(view, 0, 0, snapC.width, snapC.height);
  } catch (e) {
    console.warn(TAG, "freeze failed", e);
    return false;
  }
  // a blank (all-black) copy means the read missed the frame
  const c = document.createElement("canvas"); c.width = 32; c.height = 18;
  const cx = c.getContext("2d", { willReadFrequently: true }); cx.drawImage(snapC, 0, 0, 32, 18);
  const d = cx.getImageData(0, 0, 32, 18).data; let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) lit++;
  return lit > 0;
}

// frame meter: rAF gaps per phase while the shards are on screen (for tuning on real GPUs)
function frameMeter() {
  const ts = [], phases = [];
  let on = true;
  const step = (t) => { if (!on) return; ts.push(t); requestAnimationFrame(step); };
  requestAnimationFrame(step);
  return {
    phase(name) { phases.push({ name, at: performance.now() }); },
    stop() {
      on = false;
      const gaps = ts.slice(1).map((t, i) => ({ at: t, d: t - ts[i] }));
      if (gaps.length < 4) return null;
      const base = [...gaps].map((g) => g.d).sort((a, b) => a - b)[Math.floor(gaps.length * 0.1)];
      return {
        hz: Math.round(1000 / base),
        phases: phases.map((ph, i) => {
          const end = phases[i + 1] ? phases[i + 1].at : Infinity, g = gaps.filter((x) => x.at >= ph.at && x.at < end);
          if (!g.length) return null;
          return { name: ph.name, frames: g.length, late: g.filter((x) => x.d > base * 1.5).length, worst: Math.round(Math.max(...g.map((x) => x.d))) };
        }).filter(Boolean),
      };
    },
  };
}

// ============================================================================
// Settings + cast
// ============================================================================
export function getShatterThickness() {
  try { return !!game.settings.get(NS, SHATTER_THICKNESS_SETTING); } catch { return false; }
}

const imageCache = new Map();   // src -> Promise<{ w, h } | null>
function loadImage(src) {
  if (!imageCache.has(src)) {
    imageCache.set(src, new Promise((ok) => {
      const i = new Image();
      i.onload = () => { (i.decode ? i.decode() : Promise.resolve()).catch(() => {}).then(() => ok({ w: i.naturalWidth, h: i.naturalHeight, img: i })); };
      i.onerror = () => { imageCache.delete(src); ok(null); };
      i.src = src;
    }));
  }
  return imageCache.get(src);
}

/**
 * Cast entries for the four cut-in shards from party actors (or { name, src } records).
 * Actors with a tuned CAST_FRAMING entry keep their slot; everyone else fills the free slots.
 * Returns [{ slot, name, src, focus, at, h, lean, fade }] (aspect is filled in at preload).
 */
export function resolveShatterCast(members = []) {
  const rows = [];
  for (const m of members) {
    if (!m) continue;
    const name = String(m.name ?? "");
    const src = m.src ?? m.system?.props?.cut_in_critical ?? null;
    if (!src || typeof src !== "string") continue;
    const key = name.trim().split(/\s+/)[0].toLowerCase();
    rows.push({ name, src, framing: CAST_FRAMING[key] ?? null });
  }
  const used = new Set(), out = [];
  for (const r of rows) {
    if (!r.framing || used.has(r.framing.slot)) continue;
    used.add(r.framing.slot);
    out.push({ ...r.framing, name: r.name, src: r.src });
  }
  for (const r of rows) {
    if (out.some((o) => o.src === r.src && o.name === r.name)) continue;
    const slot = [1, 2, 3, 4].find((s) => !used.has(s));
    if (!slot) break;
    used.add(slot);
    out.push({ slot, ...SLOT_DEFAULTS[slot], name: r.name, src: r.src });
  }
  return out;
}

/** Start loading the cut-in art (call when the encounter is decided). */
export function preloadShatterCast(cast = []) {
  return Promise.all(cast.map((c) => loadImage(c.src)));
}

async function readyCast(cast) {
  const out = [];
  for (const c of cast) {
    const im = await loadImage(c.src);
    if (!im || !im.w || !im.h) continue;
    out.push({ ...c, aspect: im.w / im.h });
  }
  return out;
}

/**
 * Find the cracked panes for the current screen size ahead of time (a few hundred ms of CPU once
 * per size). Runs at boot when idle and after a resize; the transition does it at the impact
 * otherwise.
 */
export function prewarmShatter() {
  const W = Math.max(1, Math.round(window.innerWidth)), H = Math.max(1, Math.round(window.innerHeight));
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  if (regionCache && regionCache.key === `${W}x${H}@${DPR}`) return;
  const t = performance.now();
  const sc = makeScene({ W, H, DPR });
  sc.crackRegions(sc.buildGeometry());
  console.debug(TAG, `cracked panes for ${W}x${H} found in ${Math.round(performance.now() - t)} ms`);
}

// ============================================================================
// The transition
// ============================================================================
let running = null;
export let lastShatterStats = null;
// Inspection only: CONFIG.fuShatter = { speed: 20 } plays every shatter (the director's too) at 1/20
// speed, e.g. to record it on a slow client and play the frames back at real speed.
export const shatterDebugSpeed = () => Math.max(0.1, Number(globalThis.CONFIG?.fuShatter?.speed) || 1);
export const isShatterRunning = () => !!running;

/**
 * Play the battle shatter transition.
 *
 * @param {object}   o
 * @param {Function} [o.load]      async () => any. Runs behind the cracked frame (the scene switch).
 *                                 The glass breaks once it resolves (and at least BEAT.crack ms in).
 * @param {Promise|Function} [o.ready]  The hang lasts until this resolves (a function is called
 *                                 after load). Absent = the authored 0.5 s hang.
 * @param {Array}    [o.cast]      resolveShatterCast() output; [] = no cut-in art.
 * @param {boolean}  [o.thickness] glass thickness; default = the client graphics setting.
 * @param {string}   [o.style]     crack colour: ink | glass | gold | crimson.
 * @param {number}   [o.speed]     time scale for inspection (2 = half speed).
 * @param {number}   [o.zIndex]
 * @param {Function} [o.onPhase]   (name) => void: impact, hold, cut, hang, speedup, ending, done
 *                                 (skip instead of the rest when there is nothing to freeze).
 * @returns {Promise<any>} load()'s result, once the glass has cleared.
 */
export async function playShatterTransition(o = {}) {
  if (running) {
    console.warn(TAG, "already running; loading without the effect");
    try { o.onPhase?.("skip"); } catch { /* caller's */ }
    return o.load ? o.load() : undefined;
  }
  const p = runShatter(o);
  running = p;
  try { return await p; } finally { running = null; }
}

async function runShatter(o) {
  const load = typeof o.load === "function" ? o.load : async () => {};
  const S = Math.max(0.1, Number(o.speed) || shatterDebugSpeed()), T = (ms) => ms * S;
  const onPhase = (n) => { phaseAt[n] = Math.round(performance.now() - t00); try { o.onPhase?.(n); } catch (e) { console.warn(TAG, "onPhase threw", e); } };
  const st = STYLES[o.style] || STYLES.ink;
  const thick = o.thickness ?? getShatterThickness();
  const W = Math.max(1, Math.round(window.innerWidth)), H = Math.max(1, Math.round(window.innerHeight));
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const els = mountOverlay(W, H, DPR, o.zIndex ?? 100000);
  const anims = [];
  const play = (el, frames, opts) => { const a = el.animate(frames, opts); anims.push(a); return a; };
  // a piece and the slices of its thickness move as one: each slice runs the piece's keyframes with
  // its own push back along the piece's normal (thin[i] scales it near the lens)
  const playPiece = (pc, frames, opts, thin) => {
    const a = play(pc.el, frames, opts);
    for (const sl of pc.slabs || []) play(sl.el, frames.map((f, i) => (f.transform ? { ...f, transform: f.transform + (thin ? ` translateZ(${(-sl.depth * thin[i]).toFixed(3)}px)` : sl.z) } : f)), opts);
    return a;
  };
  const t00 = performance.now(), phaseAt = {};
  // t0Epoch + timings/phases (ms after it) line recorded frames up with the beats
  const stats = { W, H, DPR, thick, speed: S, cast: 0, t0Epoch: performance.timeOrigin + t00, timings: {}, phases: phaseAt };
  const mark = (k) => { stats.timings[k] = Math.round(performance.now() - t00); };
  let loadResult, loadError = null, loadStarted = false;
  const cleanup = () => {
    for (const a of anims) { try { a.cancel(); } catch { /* gone */ } }
    els.root.remove();
    document.body.classList.remove("fuc-shatter-active");
  };
  // watchdog: whatever happens, the overlay never outlives a stuck transition
  const watchdog = setTimeout(() => { console.warn(TAG, "watchdog: removing a stuck overlay"); cleanup(); }, 60000 + T(15000));

  try {
    const castP = readyCast(Array.isArray(o.cast) ? o.cast : []);
    document.body.appendChild(els.root);
    document.body.classList.add("fuc-shatter-active");
    try { Hooks.callAll("fuc:shatterStart"); } catch { /* listeners' */ }

    // ── IMPACT: freeze the field frame ──
    if (!freezeCanvas(els.snapC)) {
      console.warn(TAG, "nothing to freeze; loading without the effect");
      cleanup(); clearTimeout(watchdog);
      onPhase("skip");
      loadStarted = true;
      try { loadResult = await load(); } catch (e) { loadError = e; }
      return loadError ? Promise.reject(loadError) : loadResult;
    }
    onPhase("impact"); mark("impact");
    els.crackFrame.style.visibility = "visible";
    const tImpact = performance.now();
    const sc = makeScene({ W, H, DPR, thick, st, els });
    const geo = sc.buildGeometry();
    const segs = sc.toSegs(geo), maxD = Math.max(...segs.map((s) => s.d1));
    sc.drawRefraction(geo);
    play(els.refrC, [{ opacity: 0 }, { opacity: 1 }], { duration: T(80), fill: "forwards" });
    els.root.style.setProperty("--fsh-ix", `${(geo.I.x / W) * 100}%`); els.root.style.setProperty("--fsh-iy", `${(geo.I.y / H) * 100}%`);
    els.root.style.setProperty("--fsh-breathe", `${1.6 * S}s`);
    els.shaker.style.transformOrigin = `${geo.I.x}px ${geo.I.y}px`;
    // the punch
    const k = [1, -0.85, 0.7, -0.5, 0.32, -0.18, 0.08, 0], pxs = Math.max(6, geo.U * 0.02);
    play(els.shaker, k.map((v, i) => {
      const decay = Math.pow(1 - i / (k.length - 1), 1.6);
      return { transform: `translate(${(v * pxs).toFixed(2)}px, ${(v * pxs * 0.55 * (i % 2 ? 1 : -1)).toFixed(2)}px) scale(${(1 + 0.05 * decay).toFixed(4)})` };
    }), { duration: T(320), easing: "linear" });
    play(els.flash, [{ opacity: 1 }, { opacity: 0.55, offset: 0.25 }, { opacity: 0 }], { duration: T(200), easing: "ease-out" });
    // the crack grows: radials run first, concentric cracks follow
    const mainMs = T(80), webMs = T(200), webLag = T(45);
    await new Promise((done) => {
      let over = false;
      const finish = () => { if (over) return; over = true; sc.drawCracks(geo, segs, maxD, maxD); done(); };
      const step = (now) => {
        if (over) return;
        const e = now - tImpact, em = Math.min(1, e / mainMs), ew = Math.max(0, Math.min(1, (e - webLag) / webMs));
        sc.drawCracks(geo, segs, (1 - Math.pow(1 - em, 2)) * maxD, (1 - Math.pow(1 - ew, 3)) * maxD);
        if (ew < 1) requestAnimationFrame(step); else finish();
      };
      requestAnimationFrame(step);
      setTimeout(finish, webLag + webMs + 400);   // a hidden window never runs rAF
    });
    sc.drawGlow(segs);
    els.glowC.classList.add("fsh-breathe");
    mark("cracked");

    // ── the shards, cut now from the frozen frame (before the scene switch loads the CPU) ──
    const cast = await raceTimeout(castP, 1500) ?? [];
    stats.cast = cast.length;
    const col = sc.buildCollage(geo, cast);
    mark("collage");

    const P = col.P, cam = { x: geo.I.x, y: geo.I.y, z: P };
    // ── MOTION: one real-speed path per piece, played through a time-speed curve ──
    // Every piece has ONE path, a function of u = scene time / REF: it bursts out at a constant
    // velocity and spin (its authored hang pose at u = 1) while the camera pushes through the glass
    // (TIME.dolly x u^3), so every piece ends up rushing past the lens. Slow motion is the same paths
    // with scene time slowed (sSlow) and later sped back up, so nothing ever stops or jumps.
    const REF = tauSlow(BEAT.push);
    const dolly = (u) => TIME.dolly * P * u * u * u;
    const path = (x1, y1, z1, T3) => (u) => ({ x: x1 * u, y: y1 * u, z: z1 * u + dolly(u), rx: -T3[1] * u, ry: T3[0] * u, rz: T3[2] * u });
    const fadeAt = (z) => clamp((TIME.fade[1] * P - z) / ((TIME.fade[1] - TIME.fade[0]) * P), 0, 1);
    const uGone = (pose) => { let a = 0, b = 30; for (let i = 0; i < 50; i++) { const m = (a + b) / 2; if (pose(m).z < TIME.fade[1] * P) a = m; else b = m; } return b; };
    const shards = [...col.back, ...col.mid, ...col.front, ...col.majors];
    const layer = (list, zLo, zHi, dLo, dHi, h0) => {
      for (const pc of list) {
        const d = (dLo + pc.r * (dHi - dLo)) * geo.U, z1 = P * (zLo + pc.r * (zHi - zLo));
        pc.z1 = z1; pc.h0 = h0; pc.pose = path(pc.dir.x * d, pc.dir.y * d, z1, pc.turn);
      }
    };
    layer(col.back, 0.02, 0.04, 0.005, 0.015, SHADOW.back.h);
    layer(col.mid, 0.07, 0.11, 0.015, 0.035, SHADOW.mid.h);
    layer(col.front, 0.14, 0.18, 0.025, 0.05, SHADOW.front.h);
    col.majors.forEach((pc, kk) => {
      const d = 0.03 * geo.U * (1 + pc.r * 0.5), z1 = P * (0.2 + 0.03 * ((kk * 7) % 4) / 3);
      pc.z1 = z1; pc.h0 = SHADOW.major.h; pc.pose = path(pc.dir.x * d, pc.dir.y * d, z1, pc.turn);
    });
    const span = (r, [a, b]) => a + r * (b - a);
    // No debris parks on a face: a chip or flake whose hanging spot comes within FACE_CLEAR of a
    // cut-in's face (projected, u 0.85-1.3) flies the first distance in TRY that clears every face.
    const F = geo.I, HANG = [0.85, 1, 1.12, 1.3], FACE_CLEAR = 0.16 * geo.U, TRY = [1, 0.75, 1.3, 0.5, 1.7, 0.3, 2.2, 3];
    const proj = (x, y, z) => ({ x: F.x + (x - F.x) * P / (P - z), y: F.y + (y - F.y) * P / (P - z) });
    const faces = col.majors.map((pc) => {
      const c = cast.find((a) => a.slot === pc.slot);
      return c && HANG.map((u) => { const pp = pc.pose(u); return proj(c.at[0] * W + pp.x, c.at[1] * H + pp.y, pp.z); });
    }).filter(Boolean);
    const clearOf = (x0, y0, dx, dy, z) => HANG.every((u, i) => { const q = proj(x0 + dx * u, y0 + dy * u, z * u + dolly(u)); return faces.every((f) => Math.hypot(q.x - f[i].x, q.y - f[i].y) > FACE_CLEAR); });
    const keepOff = (x0, y0, dx, dy, z) => TRY.find((t) => clearOf(x0, y0, dx * t, dy * t, z)) ?? 3;
    for (const s of col.cores) {
      const far = span(s.r, DEBRIS.chip.far), z = P * span(s.r, DEBRIS.chip.z);
      const kk = keepOff(s.info.cx, s.info.cy, s.dir.x * W * far, s.dir.y * H * far, z);
      s.z1 = z; s.pose = path(s.dir.x * W * far * kk, s.dir.y * H * far * kk, z, s.turn);
    }
    for (const f of col.flakes) {
      const far = span(f.r, DEBRIS.flake.far) * W, z = P * span(f.r, DEBRIS.flake.z), spin = (f.r * 2 - 1) * 720;
      const kk = keepOff(f.x0, f.y0, Math.cos(f.a) * far, Math.sin(f.a) * far * 0.8, z), cx = Math.cos(f.a) * far * kk, cy = Math.sin(f.a) * far * 0.8 * kk;
      f.pose = (u) => ({ x: cx * u, y: cy * u, z: z * u + dolly(u), spin: spin * u });
    }
    // a piece that has faded out stays where it vanished: flying on, its layer would blow up to
    // tens of thousands of px
    for (const x of [...shards, ...col.cores, ...col.flakes]) { const g = uGone(x.pose), raw = x.pose; x.pose = (u) => raw(Math.min(u, g)); x.uGone = g; }
    const uEnd = Math.max(...[...shards, ...col.cores, ...col.flakes].map((x) => x.uGone));
    // keyframes close enough that neither the time speed (4%) nor the scene (0.02 u) changes much
    // between neighbours: between keyframes the motion is linear
    const samples = (tA, tB, s) => {
      const ts = [tA];
      while (ts[ts.length - 1] < tB) {
        const t = ts[ts.length - 1], g = Math.abs(Math.log(s(t + 1) / s(t))) || 1e-9;
        ts.push(Math.min(tB, t + clamp(Math.min(0.04 / g, 0.02 * REF / s(t)), 6, 2000)));
      }
      return ts;
    };
    const lightUp = (pc, frames, timing) => {
      const sv = frames.map((f) => shine(pc.lt, f.M, f.pos, cam, f.u)), at = (i) => frames[i].off;
      const ov = pc.ov, kS = pc.major ? SHEEN.major : SHEEN.minor, m = pc.major ? 0.5 : 1;
      // a light layer that never shows in this stretch is switched off: invisible layers still blend
      const show = (el, vals) => { const on = vals.some((v) => v > 0.006); el.style.display = on ? "" : "none"; return on; };
      if (show(ov.lit, sv.map((v) => v.light * m))) play(ov.lit, sv.map((v, i) => ({ offset: at(i), opacity: v.light * m })), timing);
      if (show(ov.dim, sv.map((v) => v.dark * m))) play(ov.dim, sv.map((v, i) => ({ offset: at(i), opacity: v.dark * m })), timing);
      if (show(ov.sheen, sv.map((v) => v.sheen * kS))) play(ov.sheen, sv.map((v, i) => ({ offset: at(i), opacity: v.sheen * kS, transform: bandAt(ov, v) })), timing);
      pc.lt.edges.forEach((e, j) => {
        if (!e.el) return;
        if (!sv.some((v) => v.edges[j] > 0)) { e.el.style.display = "none"; return; }
        e.el.style.display = "";
        play(e.el, sv.map((v, i) => ({ offset: at(i), opacity: v.edges[j] })), timing);
      });
    };
    // every animation of the scene for real time tA..tB (design ms), from the scene's u at each moment
    const build = (ts, uOf, fillMode) => {
      const tA = ts[0], len = ts[ts.length - 1] - tA, timing = { duration: T(len), easing: "linear", fill: fillMode };
      const fr = ts.map((t) => ({ off: (t - tA) / len, u: uOf(t) })), first = anims.length;
      const lit = (pc) => {
        const ps = fr.map((f) => pc.pose(f.u));
        // near the lens the thickness slices spread apart: their push-back shrinks with ((P - z) / P)^2
        const thin = ps.map((pp) => Math.pow(Math.max(0, P - pp.z) / P, 2));
        pc.anim = playPiece(pc, fr.map((f, i) => { const pp = ps[i]; return { offset: f.off, transform: tf(pp.x, pp.y, pp.z, pp.rx, pp.ry, pp.rz), opacity: fadeAt(pp.z) }; }), timing, thin);
        lightUp(pc, fr.map((f, i) => { const pp = ps[i]; return { off: f.off, u: f.u, M: rotM(pp.rx, pp.ry, pp.rz), pos: { x: pc.info.cx + pp.x, y: pc.info.cy + pp.y, z: pp.z } }; }), timing);
        return ps;
      };
      for (const pc of shards) {
        const ps = lit(pc);
        // the shadow falls along the light, further and fainter the higher the sheet rises
        play(pc.shadow.el, fr.map((f, i) => { const pp = ps[i], h = pc.h0 + pc.z1 * 0.06 * f.u; return { offset: f.off, transform: tf(pp.x + SUN.x * h, pp.y + SUN.y * h, pc.z1 * 0.35 * f.u, pp.rx, pp.ry, pp.rz), opacity: pc.shadow.alpha * Math.max(0, 1 - 0.45 * f.u) }; }), timing);
        // a cut-in darkens as it nears the lens and its light is cut off
        if (pc.el._shade) play(pc.el._shade, fr.map((f, i) => ({ offset: f.off, opacity: 0.05 + 0.4 * clamp((ps[i].z - 0.5 * P) / (0.4 * P), 0, 1) })), timing);
      }
      for (const s of col.cores) lit(s);
      for (const f of col.flakes) {
        play(f.el, fr.map((q) => { const pp = f.pose(q.u); return { offset: q.off, transform: `translate3d(${(f.x0 + pp.x).toFixed(3)}px,${(f.y0 + pp.y).toFixed(3)}px,${pp.z.toFixed(3)}px) rotate(${pp.spin.toFixed(3)}deg)`, opacity: fadeAt(pp.z) }; }), timing);
      }
      // the rest of the crushed ring goes to powder, gone by u = 1
      play(col.puff, fr.map((f) => ({ offset: f.off, transform: `translateZ(${(P * 0.25 * f.u).toFixed(3)}px) scale(${(1 + 1.2 * f.u).toFixed(5)})`, opacity: Math.max(0, 1 - f.u) })), timing);
      // the battlefield behind holds still; its dimming lifts as the glass clears
      play(els.dim, fr.map((f) => ({ offset: f.off, opacity: 0.4 * (1 - Math.min(1, f.u / uEnd)) })), timing);
      return anims.slice(first);
    };
    const uA = (t) => tauSlow(t) / REF;
    // The speed-up from real time tw (design ms after the cut): scene time speeds back up from
    // wherever it is, at TIME.speedUp's exponential rate, from the slow-down's exact place and speed.
    const speedUp = (tw) => {
      const uw = uA(tw), sw = sSlow(tw);
      const sC = (t) => sw * Math.exp(t / TIME.speedUp), uC = (t) => uw + TIME.speedUp * sw * (Math.exp(t / TIME.speedUp) - 1) / REF;
      const tOfU = (u) => TIME.speedUp * Math.log(1 + Math.max(0, u - uw) * REF / (TIME.speedUp * sw));
      const endC = tOfU(uEnd);
      return { sw, sC, uC, endC, ts: samples(0, endC, sC) };
    };
    const tw0 = BEAT.push + BEAT.hang;
    let C = null, phaseA = null;
    const buildPlanned = () => {
      C = speedUp(tw0);
      const ts = [...samples(0, tw0, sSlow), ...C.ts.slice(1).map((t) => t + tw0)];
      return build(ts, (t) => (t <= tw0 ? uA(t) : C.uC(t - tw0)), "both");
    };

    // ── CRACKED · LOADING: the scene switch happens behind the frozen frame ──
    onPhase("hold");
    els.dim.style.opacity = "0.4";
    // With no `ready` to wait for (the director's case) the whole glass track is known already, so it
    // is built now, paused, and every shard is painted once behind an invisible collage while the
    // frame is still. The cut then only starts what is built and drawn. Built at the cut, it held the
    // main thread on the very frame the glass breaks (buildMs 364 headless, 2026-10-23).
    const prebuilt = !o.ready;
    if (prebuilt) {
      const tb0 = performance.now();
      phaseA = buildPlanned();
      for (const a of phaseA) a.pause();
      stats.buildMs = Math.round(performance.now() - tb0);
      stats.animations = anims.length;
      // will-change keeps an opacity-0 layer painted and rasterised (without it Chrome skips it)
      Object.assign(els.collage.style, { willChange: "opacity", opacity: "0", visibility: "visible" });
      mark("prebuilt");
      await frame();
    }
    await frame();   // the cracked frame is on screen before the load takes the main thread
    loadStarted = true;
    try { loadResult = await load(); } catch (e) { loadError = e; console.error(TAG, "load failed", e); }
    mark("loaded");
    const beatLeft = T(BEAT.crack) - (performance.now() - tImpact);
    if (beatLeft > 0) await wait(beatLeft);
    // the hang waits for `ready` (started now, so it can overlap the slow-down)
    let isReady = !o.ready;
    const readyP = o.ready ? Promise.resolve(typeof o.ready === "function" ? o.ready(loadResult) : o.ready).catch((e) => console.warn(TAG, "ready rejected", e)).then(() => { isReady = true; }) : Promise.resolve();
    await frame();   // a fresh frame of the battle scene before the glass opens on it

    // ── HARD CUT → SHATTER ──
    onPhase("cut"); mark("cut");
    // screen-transition.js blacks out beneath the glass if this client's scene is still drawing
    try { Hooks.callAll("fuc:shatterBreak"); } catch { /* listeners' */ }
    const tCutReal = performance.now();
    if (prebuilt) { const t = document.timeline.currentTime; for (const a of phaseA) a.startTime = t; }
    els.crackFrame.style.visibility = "hidden"; els.glowC.classList.remove("fsh-breathe");
    Object.assign(els.collage.style, { visibility: "visible", opacity: "1" });
    const fm = frameMeter(); fm.phase("slow-down");
    play(els.flash, [{ opacity: 0.5 }, { opacity: 0 }], { duration: T(70), easing: "ease-out" });
    // Ready already: slow-down, hang and speed-up are ONE track per piece (no hand-over) — built
    // during the hold when there is no `ready` to wait for, else now.
    // Not yet: the slow-down is laid out for TIME.hangMax and the speed-up is booked when ready.
    const planned = isReady;
    if (!prebuilt) {
      const tb0 = performance.now();
      phaseA = planned ? buildPlanned() : build(samples(0, TIME.hangMax, sSlow), uA, "both");
      stats.buildMs = Math.round(performance.now() - tb0);
      stats.animations = anims.length;
    }
    // time the beat from when the motion actually starts on screen (the first frame is a heavy one)
    if (col.majors[0]?.anim) await raceTimeout(col.majors[0].anim.ready, 1000);
    const tCut = document.timeline.currentTime;
    await wait(T(BEAT.push));
    onPhase("hang"); fm.phase("hang");
    await wait(T(BEAT.hang));
    if (!planned) {
      fm.phase("held");
      await raceTimeout(readyP, READY_CAP);
      // Book the speed-up a little ahead (never pause the slow-down to build it: a pause reaches the
      // screen only after the work, and the pieces snap back). If the build overruns T0 the speed-up
      // simply starts part-way in, already faster than the slow-down: it can only step forward.
      const now = document.timeline.currentTime, T0 = now + Math.max(HANDOVER, lastBuild * 1.3);
      const tc0 = performance.now();
      const start = phaseA[0]?.startTime ?? tCut;
      C = speedUp((T0 - start) / S);
      const phaseC = build(C.ts, C.uC, "forwards");
      for (const a of phaseC) a.startTime = T0;
      lastBuild = performance.now() - tc0;
      setTimeout(() => { for (const a of phaseA) { try { a.cancel(); } catch { /* gone */ } } }, Math.max(0, T0 - document.timeline.currentTime) + 300);
      stats.handover = { buildMs: Math.round(lastBuild), budgetMs: Math.round(T0 - now) };
      await wait(Math.max(0, T0 - document.timeline.currentTime));
    }
    onPhase("speedup"); fm.phase("speed-up");
    els.root.classList.add("fsh-passthrough");
    // ENDING_AT of the whole glass, from the cut: what has played so far plus what the speed-up has left
    const sinceCut = performance.now() - tCutReal, left = T(C.endC);
    const toEnding = Math.max(0, ENDING_AT * (sinceCut + left) - sinceCut);
    await wait(toEnding);
    onPhase("ending");
    await wait(Math.max(0, left - toEnding) + T(60));
    stats.frames = fm.stop();
    mark("done");
    lastShatterStats = stats;
    console.debug(TAG, "stats", stats);
  } catch (e) {
    console.error(TAG, "transition failed", e);
    if (!loadStarted) { cleanup(); onPhase("skip"); try { loadResult = await load(); } catch (err) { loadError = err; } }
  } finally {
    clearTimeout(watchdog);
    cleanup();
    onPhase("done");
    // screen-transition.js holds its "revealed" hook for us while the glass was up
    try { Hooks.callAll("fuc:shatterDone"); } catch { /* listeners' */ }
  }
  if (loadError) throw loadError;
  return loadResult;
}

// ============================================================================
// Boot: the graphics setting, idle prewarm, API
// ============================================================================
Hooks.once("init", () => {
  game.settings.register(NS, SHATTER_THICKNESS_SETTING, {
    name: "Battle transition: glass thickness",
    hint: "Draws a thickness edge on every shard of the battle-start shatter. Heavier on the GPU; off by default.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });
});

Hooks.once("ready", () => {
  const idle = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 8000 }) : setTimeout(fn, 3000));
  setTimeout(() => idle(() => { try { prewarmShatter(); } catch (e) { console.warn(TAG, "prewarm failed", e); } }), 4000);
  let rT = 0;
  window.addEventListener("resize", () => {
    clearTimeout(rT);
    rT = setTimeout(() => idle(() => { if (!running) { try { prewarmShatter(); } catch { /* next time */ } } }), 1500);
  });
  const api = { play: playShatterTransition, resolveCast: resolveShatterCast, preloadCast: preloadShatterCast, prewarm: prewarmShatter, get lastStats() { return lastShatterStats; }, CAST_FRAMING };
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.shatter = api;
});
