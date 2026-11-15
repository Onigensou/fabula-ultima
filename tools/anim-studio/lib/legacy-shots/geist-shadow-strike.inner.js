// ── Geist · Shadow Strike (self-buff; upkeep + the approved sounds) ──
// Darkness5 as 26 dark motes spiral in to his body (900 ms) -> at 800 ms Darkness3 + Magic4, an additive
// violet shimmer copy of him (opacity .7, 600 ms) and a violet flare; gate there. No dim.
const body = center('k');
S_(0, 'darkness5', 0.5);
windWisps(0, body, { n: 26, r: 200, rgb: DARK, ms: 900 });
const POP = 800;
S_(POP, 'darkness3', 0.45); S_(POP, 'magic4', 0.3);
ghost(POP, { op: 0.7, ms: 600, hue: 280, comp: 'lighter', z: 31 });
flashK(POP, '#c08cff', 400);
await go(POP + 600, POP);
