/**
 * Seeded RNG + beta-PERT sampling.
 *
 * PERT is used instead of a symmetric +/- band because session durations are
 * not symmetric: a story beat that could run 30-40 minutes lands near 34 far
 * more often than it lands near 30, and the long tail is what busts a session.
 */

/** mulberry32 — small, fast, seedable. Same seed => same report. */
export function makeRng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Marsaglia-Tsang gamma sampler (shape > 0), needed to build the beta. */
function sampleGamma(rng, shape) {
  if (shape < 1) {
    // Boost low shapes: Gamma(a) = Gamma(a+1) * U^(1/a)
    return sampleGamma(rng, shape + 1) * Math.pow(rng() || Number.EPSILON, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      // Box-Muller for a standard normal
      const u1 = rng() || Number.EPSILON;
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng() || Number.EPSILON;
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(rng, alpha, beta) {
  const g1 = sampleGamma(rng, alpha);
  const g2 = sampleGamma(rng, beta);
  return g1 / (g1 + g2);
}

/**
 * Sample a beta-PERT variate from [min, mode, max].
 * lambda=4 is the standard PERT weight on the mode.
 */
export function samplePert(rng, [min, mode, max], lambda = 4) {
  if (max <= min) return min;
  const range = max - min;
  const alpha = 1 + (lambda * (mode - min)) / range;
  const beta  = 1 + (lambda * (max - mode)) / range;
  return min + sampleBeta(rng, alpha, beta) * range;
}

/** Analytic PERT mean — used for budget tables and the cost-table printout. */
export function pertMean([min, mode, max], lambda = 4) {
  return (min + lambda * mode + max) / (lambda + 2);
}

/** Percentile of an unsorted numeric array (linear interpolation). */
export function percentile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const idx = (s.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}
