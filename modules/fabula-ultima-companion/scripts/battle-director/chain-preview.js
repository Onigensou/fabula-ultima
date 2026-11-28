// ── Random-target Chain card: the preview ranges ───────────────────────────
//
// A Chain whose strikes draw their targets at random (`seek`, `random`,
// `volley`: chain-strikes.js isDrawnChainMode) cannot honestly show one result
// per row before it is confirmed: strike 1's roll is only one of N, and who each
// strike lands on is the draw itself. So its card shows RANGES instead (approved
// mockup "Random-target Chain HUD", round 7, 2026-11-28):
//
//   Accuracy  — the totals the dice can make: 1 + 1 + bonus .. both maxed + bonus.
//   Damage    — one strike before the target: HR 1 .. HR max, through the
//               attacker's own multipliers and Volley's shared flat bonus.
//   Each row  — what one strike can deal to THAT target: flat reduction → weapon
//               efficiency → the affinity of the strike's element, spanning every
//               element the strikes carry. An element the target absorbs is a
//               "<ELEMENT> HEALS" note, an immune one "<ELEMENT> 0".
//   Left out  — crits, Sonic Blow's all-hit ×1.5, Pierce's half on a miss, and
//               reactions applied on the card.
//
// No parallel maths: every number comes from the game's own per-target pipeline
// (action-profile.js buildPerTarget, through recomputeActionProfile). Each
// sample forces a hit on every target (gmHitOverrides) and stands in for the HR
// with the GM damage input (HR off, +h on the base), which is exactly
// `(h + base)` at the one point the base is assembled. Non-crit dice are used,
// so no crit bonus leaks in.
//
// The assembly below is pure (node-testable: chain-preview.test.mjs); the
// adapter at the bottom needs Foundry (recomputeActionProfile).

import { isDrawnChainMode } from "./chain-strikes.js";
import { strikeArFor } from "./chain-plan.js";

// The separator every range on the card uses (the mockup's full-width tilde).
export const RANGE_SEP = "～";
export function formatRange(min, max) {
  const a = Math.round(Number(min)), b = Math.round(Number(max));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
  return a === b ? `${a}` : `${a}${RANGE_SEP}${b}`;
}

// The Chains this card is for: a real Chain (2+) whose strikes are drawn, and not
// a hidden presentation split.
export function isDrawnChainPreviewSpec(spec) {
  return !!spec && Number(spec.count) >= 2 && !spec.hidden && isDrawnChainMode(spec.mode);
}

// The totals the two dice can make, plus the flat bonus (the check total's own
// formula: rA + rB + checkBonus). 1 + 1 is the floor even though it fumbles —
// the card says so in the hover.
export function chainAccuracyRange(roll) {
  if (!roll) return null;
  const dA = Number(roll.dA) || 0, dB = Number(roll.dB) || 0;
  if (!(dA > 0) || !(dB > 0)) return null;
  const cb = Number(roll.checkBonus) || 0;
  return { min: 2 + cb, max: dA + dB + cb };
}

// The element strike k (1-based) deals: strike 1 is the card's own; later
// strikes follow the authored list (a short list repeats its last entry), else
// the card's element. Mirrors chain-plan.js strikeArFor.
export function strikeElement(spec, k, cardElement) {
  const list = Array.isArray(spec?.elements) ? spec.elements : null;
  if (!list || !list.length || k <= 1) return String(cardElement ?? "").toLowerCase() || null;
  return String(list[Math.min(k, list.length) - 1] ?? cardElement ?? "").toLowerCase() || null;
}
export function strikeElements(spec, cardElement) {
  const n = Math.max(0, Math.floor(Number(spec?.count) || 0));
  return Array.from({ length: n }, (_, i) => strikeElement(spec, i + 1, cardElement));
}

// Which strikes need pricing. Strikes with the same element price the same, so
// one per element is enough — except a Volley, whose flat share falls from the
// first shots to the last (splitVolleyFlat: the remainder goes to the earliest
// shots), so it prices the first AND the last shot of each element.
export function previewStrikesToSample(spec, cardElement) {
  const n = Math.max(0, Math.floor(Number(spec?.count) || 0));
  const groups = new Map();   // element -> [k...]
  for (let k = 1; k <= n; k++) {
    const el = strikeElement(spec, k, cardElement) ?? "";
    if (!groups.has(el)) groups.set(el, []);
    groups.get(el).push(k);
  }
  const out = [];
  for (const [element, ks] of groups) {
    out.push({ k: ks[0], element });
    if (spec?.mode === "volley" && ks.length > 1) out.push({ k: ks[ks.length - 1], element });
  }
  return out;
}

const cap = (s) => { s = String(s ?? ""); return s ? s[0].toUpperCase() + s.slice(1) : ""; };

// Assemble the preview from the priced samples.
//   samples: [{ k, element, hr, outgoing, rows: [{ tokenUuid, name, value, affinity, parts }] }]
//     hr       — the HR this sample stands for (1 or the larger die)
//     outgoing — the hit before the target (action-profile's `outgoing`)
//     value    — the per-target damage after reduction / efficiency / affinity
//     affinity — the affinity code the pipeline settled on (VU/RS/IM/AB/NE)
//     parts    — the row's damage-mod parts (reduction, efficiency …), for the hover
// Returns plain JSON (it rides the action result and the wire).
export function assembleChainPreview({ spec, cardElement = null, pierce = false, roll = null, samples = [] } = {}) {
  if (!isDrawnChainPreviewSpec(spec)) return null;
  const elements = strikeElements(spec, cardElement);
  const distinct = [...new Set(elements.filter(Boolean))];
  let dmgMin = Infinity, dmgMax = -Infinity;
  const per = new Map();   // tokenUuid -> { name, byEl: Map(el -> { min, max, aff, parts }) }
  for (const s of samples ?? []) {
    const out = Number(s?.outgoing);
    if (Number.isFinite(out)) { dmgMin = Math.min(dmgMin, out); dmgMax = Math.max(dmgMax, out); }
    const el = String(s?.element ?? "").toLowerCase();
    for (const r of s?.rows ?? []) {
      if (!r?.tokenUuid) continue;
      let t = per.get(r.tokenUuid);
      if (!t) { t = { name: r.name ?? "", byEl: new Map() }; per.set(r.tokenUuid, t); }
      let e = t.byEl.get(el);
      if (!e) { e = { min: Infinity, max: -Infinity, aff: "NE", parts: [] }; t.byEl.set(el, e); }
      const v = Math.max(0, Math.floor(Number(r.value) || 0));
      e.min = Math.min(e.min, v); e.max = Math.max(e.max, v);
      // A heal / an immunity on ANY sample of the element marks the element.
      if (e.aff !== "AB" && e.aff !== "IM") e.aff = String(r.affinity ?? "NE").toUpperCase();
      for (const p of r.parts ?? []) {
        const src = String(p?.source ?? "").trim();
        if (src && Number(p?.amount) !== 0 && !e.parts.includes(src)) e.parts.push(src);
      }
    }
  }
  const perTarget = {};
  for (const [uuid, t] of per) {
    let min = Infinity, max = -Infinity;
    const heals = [], zero = [], why = [];
    // Hover lines in the strikes' element order.
    const order = [...distinct, ...[...t.byEl.keys()].filter((k) => !distinct.includes(k))];
    for (const el of order) {
      const e = t.byEl.get(el);
      if (!e) continue;
      const label = cap(el) || "Damage";
      const head = [`${label}${e.aff !== "NE" ? ` ${e.aff}` : ""}`, ...e.parts].join(", ");
      if (e.aff === "AB") { heals.push(label); why.push(`${head}: heals`); continue; }
      if (e.aff === "IM") { zero.push(label); why.push(`${head}: 0`); continue; }
      min = Math.min(min, e.min); max = Math.max(max, e.max);
      why.push(`${head}: ${formatRange(e.min, e.max)}`);
    }
    perTarget[uuid] = {
      name: t.name,
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
      heals, zero, why,
    };
  }
  return {
    v: 1,
    mode: spec.mode,
    count: Math.floor(Number(spec.count)),
    pierce: !!pierce,
    // per strike, strike 1 first (the Multi-Type hover lists them)
    elements,
    mixed: distinct.length > 1,
    element: distinct[0] ?? (String(cardElement ?? "").toLowerCase() || null),
    damage: Number.isFinite(dmgMin) ? { min: dmgMin, max: dmgMax } : null,
    accuracy: chainAccuracyRange(roll),
    perTarget,
  };
}

// Merge a later batch of rows (a creature that joined the card: Protect's
// protector, an added target) into an existing preview. Rows already priced win.
export function mergeChainPreview(base, extra) {
  if (!base) return extra ?? null;
  if (!extra) return base;
  return { ...base, perTarget: { ...(extra.perTarget ?? {}), ...(base.perTarget ?? {}) } };
}

// Card target uuids the preview has no row for.
export function missingPreviewTargets(preview, targets = []) {
  const have = preview?.perTarget ?? {};
  return (targets ?? []).filter((t) => t?.tokenUuid && !have[t.tokenUuid]);
}

// ── Engine adapter (Foundry) ────────────────────────────────────────────────
// Dice for a sample: any non-matching pair is never a crit under the default
// rule; a pair the attacker's crit range still counts as a crit is skipped.
const SAMPLE_DICE = [[1, 2], [2, 1], [1, 3], [2, 3], [3, 4]];

// Price the action's strikes against `targets` (default: the card's) and
// assemble the preview. `ar` is the frozen action result with its `chain` spec.
// Returns null when this is not a drawn Chain or nothing could be priced.
export async function computeDrawnChainPreview({ ar, targets = null } = {}) {
  const spec = ar?.chain ?? null;
  if (!isDrawnChainPreviewSpec(spec) || !ar?.roll) return null;
  const tgts = (Array.isArray(targets) ? targets : (ar.targets ?? [])).filter((t) => t?.tokenUuid);
  if (!tgts.length) return null;
  const { recomputeActionProfile, actionKeywordsForActionResult } = await import("./action-profile.js");
  const dA = Number(ar.roll.dA) || 6, dB = Number(ar.roll.dB) || 6;
  const ignoreHR = !!ar.damage?.ignoreHR;
  const maxHR = Math.max(dA, dB);
  const hrs = ignoreHR ? [0] : (maxHR > 1 ? [1, maxHR] : [1]);
  const cardElement = String(ar.damage?.element ?? ar.damageType ?? ar.weapon?.damageType ?? "").toLowerCase() || null;
  const gmHitOverrides = Object.fromEntries(tgts.map((t) => [t.tokenUuid, true]));
  const dice = SAMPLE_DICE.filter(([a, b]) => a <= dA && b <= dB);
  // Pierce (a miss deals half): named in the Multi-Type hover. Same keyword set
  // buildPerTarget folds.
  let pierce = false;
  try { pierce = (await actionKeywordsForActionResult(ar)).includes("pierce") || !!ar.weapon?.hasPierce; } catch { pierce = !!ar.weapon?.hasPierce; }

  const price = async ({ k, element }, h) => {
    const arK = strikeArFor(ar, spec, k);
    for (const [rA, rB] of dice.length ? dice : [[1, Math.min(2, dB)]]) {
      const delta = await recomputeActionProfile({
        ar: { ...arK, roll: { ...ar.roll, rA, rB }, gmOverride: null, accuracyOverride: null },
        targets: tgts,
        gmHitOverrides,
        gmDamage: { base: null, useHR: false, bonus: h, element: null, weaponType: null },
        withProfile: true,
      });
      if (!delta?._profile) return null;
      if (delta.roll?.isCrit) continue;   // the attacker's crit range caught this pair: try another
      const prim = (r) => (r?.effects ?? []).find((x) => x?.type === "resource_delta" && x.valence === "harmful" && x.damageClass === "primary");
      const rows = [];
      let outgoing = null;
      for (const r of delta._profile.perTarget ?? []) {
        const d = prim(r);
        if (!d || !r?.target?.tokenUuid) continue;
        if (outgoing == null && Number.isFinite(Number(d.outgoing))) outgoing = Number(d.outgoing);
        rows.push({ tokenUuid: r.target.tokenUuid, name: r.target.name ?? "", value: d.value, affinity: d.affinity, parts: d.incomingBreakdown ?? [] });
      }
      return { k, element, hr: h, outgoing, rows };
    }
    return null;
  };

  const jobs = [];
  for (const s of previewStrikesToSample(spec, cardElement)) for (const h of hrs) jobs.push(price(s, h));
  const samples = (await Promise.all(jobs)).filter(Boolean);
  if (!samples.length) return null;
  return assembleChainPreview({ spec, cardElement, pierce, roll: ar.roll, samples });
}

// The preview for a card whose target set moved (Protect, an added target):
// prices only the creatures it has no row for, and keeps the rest.
export async function extendChainPreview(preview, ar, targets = []) {
  if (!preview) return preview;
  const missing = missingPreviewTargets(preview, targets);
  if (!missing.length) return preview;
  const extra = await computeDrawnChainPreview({ ar, targets: missing }).catch(() => null);
  return extra ? { ...mergeChainPreview(preview, extra), accuracy: preview.accuracy } : preview;
}
