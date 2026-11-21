// timed-strikes-rules.js — pure math for the `timed_strikes` effect kind
// (Lionheart's Renzokuken, 2026-11-21). No Foundry access: unit-testable.
//
// A timed-strikes move is N strikes on its targets. Before each strike a gauge
// sweeps once; a press inside the TRIGGER zone makes that strike a TRIGGER.
//   strike damage = round(swing × hitMult)   on a TRIGGER
//                 = round(swing × missMult)  otherwise
//   a perfect set (every strike a TRIGGER) adds a finisher = round(swing × finisherMult)
// `swing` is computed ONCE by the caller (the weapon's normal damage with HR 0,
// the attacker's flat outgoing bonuses already folded in) — strikes never re-add
// those bonuses. Affinity / DR / weapon efficiency apply per strike downstream.

export const TIMED_STRIKE_DEFAULTS = Object.freeze({
  count: 6,
  hitMult: 0.55,
  missMult: 0.20,
  finisherMult: 1.2,
  finisherLabel: "",
  sweepMs: 650,
  zone: Object.freeze([0.70, 0.92]),
  gapMs: 260,
  autoRate: 0.7,
});

const num = (v, d) => {
  const n = Number(String(v ?? "").trim());
  return (String(v ?? "").trim() !== "" && Number.isFinite(n)) ? n : d;
};

// "70-92" | "0.7-0.92" | "70,92" → [0.70, 0.92]
export function parseZone(raw, def = TIMED_STRIKE_DEFAULTS.zone) {
  const parts = String(raw ?? "").split(/[-,\s]+/).map((s) => Number(s)).filter((n) => Number.isFinite(n));
  if (parts.length !== 2) return [...def];
  let [a, b] = parts;
  if (a > 1 || b > 1) { a /= 100; b /= 100; }
  a = Math.max(0, Math.min(1, a)); b = Math.max(0, Math.min(1, b));
  return a < b ? [a, b] : [...def];
}

// Effect-row fields → config (blank fields take the defaults).
export function readTimedStrikeConfig(row = {}) {
  const D = TIMED_STRIKE_DEFAULTS;
  const rate = num(row.auto_rate, D.autoRate);
  return {
    count: Math.max(1, Math.min(12, Math.floor(num(row.strike_count, D.count)))),
    hitMult: num(row.strike_hit_mult, D.hitMult),
    missMult: num(row.strike_miss_mult, D.missMult),
    finisherMult: num(row.finisher_mult, 0),
    finisherLabel: String(row.finisher_label ?? "").trim(),
    sweepMs: Math.max(200, Math.min(3000, Math.floor(num(row.gauge_sweep_ms, D.sweepMs)))),
    zone: parseZone(row.gauge_zone),
    gapMs: Math.max(0, Math.min(2000, Math.floor(num(row.gauge_gap_ms, D.gapMs)))),
    autoRate: rate > 1 ? rate / 100 : Math.max(0, rate),
    title: String(row.gauge_title ?? "").trim(),
  };
}

export const strikeDamage = (swing, hit, cfg) =>
  Math.max(0, Math.round((Number(swing) || 0) * (hit ? cfg.hitMult : cfg.missMult)));

export const finisherDamage = (swing, cfg) =>
  Math.max(0, Math.round((Number(swing) || 0) * (Number(cfg.finisherMult) || 0)));

// A press position (0..1 of the sweep, null = no press) judged against the zone.
export const judgePress = (pos, zone) => pos != null && Number.isFinite(pos) && pos >= zone[0] && pos <= zone[1];

// Result tier for the text. With 6 strikes: 6 Perfect, 5 Strong, 3-4 Okay, 0-2 Fumble.
export function tierOf(hits, count) {
  if (hits >= count) return "Perfect";
  if (hits >= count - 1) return "Strong";
  if (hits >= Math.ceil(count / 2)) return "Okay";
  return "Fumble";
}

// The automatic path (no player client / sim): each strike is a TRIGGER with
// probability `rate`. Returns a press position so the HUD can draw it: inside
// the zone for a TRIGGER, early or none otherwise.
export function autoPress(cfg, rng = Math.random) {
  const [z0, z1] = cfg.zone;
  const w = z1 - z0;
  if (rng() < cfg.autoRate) return { hit: true, pos: z0 + w * (0.15 + 0.7 * rng()) };
  return { hit: false, pos: rng() < 0.5 ? Math.max(0.05, z0 - 0.08 - 0.4 * rng()) : null };
}
