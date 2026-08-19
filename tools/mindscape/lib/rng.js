"use strict";
//
// Mindscape — seeded RNG.
//
// Deterministic given a seed, so a surprising run can be replayed exactly.
// Without that, diagnosing an outlier means re-rolling and hoping.
//
// mulberry32: small, fast, and good enough for balance statistics. It is NOT
// cryptographic and does not need to be — what matters here is a flat
// distribution over die faces and reproducibility.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Turn any string into a 32-bit seed, so runs can be labelled ("asura-run-3")
// rather than numbered.
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

class Rng {
  constructor(seed) {
    this.seed = typeof seed === "string" ? hashSeed(seed) : (seed >>> 0);
    this._next = mulberry32(this.seed);
    this.draws = 0;
  }

  // [0, 1)
  float() { this.draws++; return this._next(); }

  // A die face, 1..sides inclusive. The ONLY place die faces are produced —
  // everything else in the model routes through here so a run is reproducible
  // end to end.
  die(sides) {
    if (!(sides > 0)) throw new Error(`Rng.die: bad die size ${sides}`);
    return 1 + Math.floor(this.float() * sides);
  }

  int(minInclusive, maxInclusive) {
    return minInclusive + Math.floor(this.float() * (maxInclusive - minInclusive + 1));
  }

  pick(arr) {
    if (!arr?.length) return null;
    return arr[Math.floor(this.float() * arr.length)];
  }
}

module.exports = { Rng, mulberry32, hashSeed };
