// ═════════ move-engine · shared move framework (host-neutral; after shared/fx-melee.js, before family parts)
// def(key, { name, tune, beats: [{ name, run: async (C) => … }] }) registers a move in SK (each host has its own SK).
// T / TO build the move's tune sliders; tv(C, k) (shared/common.js) reads one. The mockup page shows the sliders; the
// game uses their defaults, or the approved values the build passes (cfg.tune).
const SKL = [];
function def(key, s) { s.tune = s.tune || []; if (!SK[key]) SKL.push(key); SK[key] = s; }
const T = (k, label, v, min, max, step = 10) => ({ k, label, v, min, max, step });
const TO = (k, label, opts, v = 0) => ({ k, label, v, opts });
