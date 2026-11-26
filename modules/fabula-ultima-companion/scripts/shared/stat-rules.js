// Percentage stat rules — the ONE place the game decides how % bonuses combine.
// Approved 2026-11-26 (Status page / % bonus redesign):
//
//   1. Max HP / MP %   — ADD together, applied once to the sheet's own base
//                        (the template formula), rounded down; flat bonuses
//                        (ADD-mode effects) still land after. Authored as
//                        MULTIPLY-mode effects (×1.10 = +10%), as Mukuta is.
//   2. Damage %        — `damage_outgoing_percentage_*` ADD together and apply
//      (outgoing)        once at the attacker's damage-multiplier step.
//   3. Damage reduction % — ADD together (All + range + element + Orbment), then
//                        a quiet diminishing curve: exact up to 30%, each point
//                        past it counts for less, never 100%. The curve is
//                        BACKEND ONLY — no player-facing text ever explains it.
//
// Both damage paths (Battle Director skill-formulas.js and apply-damage-core.js)
// and the Party Menu Status page read the curve from here, so a displayed number
// can never disagree with the damage it causes. apply-damage-core is a classic
// script (no imports), so this file also publishes itself on globalThis.

export const DR_KNEE = 30;   // full value up to here
export const DR_SOFT = 70;   // how gently the rest bends (70 → a 100% stack gives 65%)

/** Raw summed damage-reduction % → the % actually applied (floored). Negative = vulnerability, never curved. */
export function effectiveReductionPct(raw) {
  const r = Number(raw) || 0;
  if (r <= DR_KNEE) return r;
  const x = r - DR_KNEE;
  return Math.floor(DR_KNEE + (100 - DR_KNEE) * x / (x + DR_SOFT));
}

export const ELEMENTS = ["physical", "air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"];

/** Every outgoing Damage % key (registered as hidden sheet fields by the 2026-11-26 migration). */
export const OUTGOING_PCT_KEYS = [
  "damage_outgoing_percentage_all", "damage_outgoing_percentage_melee", "damage_outgoing_percentage_ranged",
  "damage_outgoing_percentage_spell", ...ELEMENTS.map((e) => `damage_outgoing_percentage_${e}`),
];

/** Every damage-reduction % key (the flat-key quirk: the ranged % key is `_range`). */
export const RECEIVING_PCT_KEYS = [
  "damage_receiving_percentage_all", "damage_receiving_percentage_melee", "damage_receiving_percentage_range",
  ...ELEMENTS.map((e) => `damage_receiving_percentage_${e}`),
];

const num = (v) => { const n = parseFloat(String(v ?? "").replace("%", "")); return Number.isFinite(n) ? n : 0; };

/**
 * Summed outgoing Damage % for one hit. `range` "melee" | "ranged" | null, `isSpell`
 * for spells, `element` lowercased. Returns a percent (10 = +10%).
 */
export function outgoingPct(props, { range = null, isSpell = false, element = null } = {}) {
  if (!props) return 0;
  let pct = num(props.damage_outgoing_percentage_all);
  if (range === "melee")  pct += num(props.damage_outgoing_percentage_melee);
  if (range === "ranged") pct += num(props.damage_outgoing_percentage_ranged);
  if (isSpell)            pct += num(props.damage_outgoing_percentage_spell);
  const el = String(element ?? "").toLowerCase();
  if (ELEMENTS.includes(el)) pct += num(props[`damage_outgoing_percentage_${el}`]);
  return pct;
}

// ── Rule 1: Max HP / MP % add together ──────────────────────────────────────
// CSB applies a prop's effects in priority order (MULTIPLY = 10 before ADD = 20),
// after computing the prop's formula. Foundry's MULTIPLY compounds (×1.10 then
// ×1.05 = ×1.155); for these two keys we instead keep, per actor per data prep,
// the formula base and the running sum of (multiplier − 1), and write
// floor(base × (1 + sum)). One source gives exactly Foundry's result (Mukuta).
const ADDITIVE_PCT_KEYS = new Set(["system.props.max_hp", "system.props.max_mp"]);
const _pctState = new WeakMap();   // actor → { [key]: { base, sum } }, reset at each prepareData

export function additiveMultiply(actor, key, current, delta) {
  let byKey = _pctState.get(actor);
  if (!byKey) { byKey = {}; _pctState.set(actor, byKey); }
  let st = byKey[key];
  // A new pass starts when the value coming in is not the one this rule last wrote:
  // CSB has just recomputed the formula (the base). Covers CSB's sheet-render prepare
  // (TemplateSystem.getSheetData), which runs outside Actor.prepareData.
  if (!st || num(current) !== st.last) st = byKey[key] = { base: num(current), sum: 0, last: null };
  st.sum += (Number(delta) || 1) - 1;
  st.last = Math.floor(st.base * (1 + st.sum));
  return st.last;
}

function installAdditivePercent() {
  const AE = CONFIG.ActiveEffect?.documentClass;
  const Actor = CONFIG.Actor?.documentClass;
  if (!AE?.prototype?._applyMultiply || !Actor?.prototype?.prepareData) {
    console.warn("[FU stat-rules] ActiveEffect._applyMultiply / Actor.prepareData missing; Max HP/MP % will compound");
    return;
  }
  const multiply = function (wrapped, actor, change, current, delta, changes) {
    if (!ADDITIVE_PCT_KEYS.has(change?.key)) return wrapped(actor, change, current, delta, changes);
    changes[change.key] = additiveMultiply(actor, change.key, current, delta);
  };
  const prepare = function (wrapped, ...args) {
    _pctState.delete(this);
    return wrapped(...args);
  };
  if (globalThis.libWrapper) {
    libWrapper.register("fabula-ultima-companion", "CONFIG.ActiveEffect.documentClass.prototype._applyMultiply", multiply, "MIXED");
    libWrapper.register("fabula-ultima-companion", "CONFIG.Actor.documentClass.prototype.prepareData", prepare, "WRAPPER");
  } else {
    const m0 = AE.prototype._applyMultiply, p0 = Actor.prototype.prepareData;
    AE.prototype._applyMultiply = function (...a) { return multiply.call(this, m0.bind(this), ...a); };
    Actor.prototype.prepareData = function (...a) { return prepare.call(this, p0.bind(this), ...a); };
  }
}

const api = { DR_KNEE, DR_SOFT, effectiveReductionPct, outgoingPct, OUTGOING_PCT_KEYS, RECEIVING_PCT_KEYS, ELEMENTS, additiveMultiply };
globalThis.FUStatRules = Object.assign(globalThis.FUStatRules ?? {}, api);

if (globalThis.Hooks) Hooks.once("setup", installAdditivePercent);
