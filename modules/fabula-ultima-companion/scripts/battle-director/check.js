// The Battle Director's ONE check primitive.
//
// A Fabula Ultima Check is: roll two attribute dice, sum them (+ a flat bonus),
// take the High Roll, and decide crit / fumble. That is ALL a check is — it does
// not know about weapons, damage, defenses, or targets. Those belong to the
// per-action layers around it (params in, comparison out).
//
// This replaces the check logic that had been copy-pasted across the COMPUTE
// branches (Attack/Skill via computeCheck, plus the bespoke Hinder / Study /
// grappled-break-free inline rolls), which had drifted: the open-check copies
// hardcoded `rA >= 6` and ignored the crit-modifier props. Here there is one
// rule, prop-aware, used everywhere.
//
// CANON (user-locked 2026-06-11):
//   - Crit   = isCriticalHit (minimum_critical_dice / critical_dice_range aware).
//   - Fumble = both dice <= `fumble_threshold` (default 1 = RAW "two 1s"; a
//              fumble_threshold buff raises it — kept from the BD's prior rule).
import { isCriticalHit } from "./skill-formulas.js";
import { attrDieSize, readPropNum } from "./snapshot.js";
import { warn } from "./logger.js";
import { SimMode } from "./sim/sim-mode.js";

// Pure derivation: given the two die faces (+ the roller's props + bonus), decide
// the outcome. The single source of truth for crit / fumble. Sync — no rolling.
export function deriveCheck({ rA = 0, rB = 0, props = null, fumbleThreshold = 1, checkBonus = 0 } = {}) {
  const a = Number(rA) || 0, b = Number(rB) || 0;
  const thr = Math.max(1, Number(fumbleThreshold) || 1);
  const isFumble = a <= thr && b <= thr;
  const isCrit = isCriticalHit({ rA: a, rB: b, props, isFumble });
  return { rA: a, rB: b, hr: Math.max(a, b), total: (a + b + (Number(checkBonus) || 0)) | 0, checkBonus: Number(checkBonus) || 0, isFumble, isCrit };
}

// THE check. Rolls the two attribute dice for `actor` (or takes forced dice from
// the test harness) and derives the outcome. Inputs: the roller + the two stats
// + an optional flat bonus. Nothing else.
export async function rollCheck({ actor, A1, A2, checkBonus = 0, dice = null, allowDieSwap = false, director = null } = {}) {
  const props = actor?.system?.props ?? null;
  // Psychokinesis-style pre-roll die swap: an owning skill with a check_die_swap
  // config may replace one Attribute die with a larger one (WLP) BEFORE rolling.
  // Only on accuracy checks (allowDieSwap) and live rolls (forced `dice` are kept
  // verbatim so the harness/crit machinery stays deterministic). `director` enables
  // the "ask"-mode interactive picker (else auto).
  let dieSwap = null;
  if (allowDieSwap && !dice) {
    const swaps = await resolveCheckDieSwap({ actor, A1, A2, director });
    if (Array.isArray(swaps) && swaps.length) {
      dieSwap = [];
      for (const sw of swaps) {
        if (sw.slot === "A1") A1 = sw.to; else if (sw.slot === "A2") A2 = sw.to;
        dieSwap.push({ from: sw.from, to: sw.to, slot: sw.slot, label: sw.label });
      }
    }
  }
  const dA = attrDieSize(actor, A1);
  const dB = attrDieSize(actor, A2);
  let rA, rB;
  if (dice) { rA = dice.rA ?? 0; rB = dice.rB ?? 0; }
  else {
    const r = await new Roll(`1d${dA} + 1d${dB}`).roll();
    const faces = r.dice.map((x) => x.results?.[0]?.result ?? 0);
    rA = faces[0] ?? 0; rB = faces[1] ?? 0;
  }
  const fumbleThreshold = readPropNum(actor, ["fumble_threshold"], 1);
  // Return the (possibly swapped) attributes so the caller can repaint the card
  // with the die that was actually rolled, plus the swap note for display.
  return { ...deriveCheck({ rA, rB, props, fumbleThreshold, checkBonus }), dA, dB, A1, A2, dieSwap };
}

// Resolve a pre-roll Attribute-die swap for `actor`'s accuracy check. Collects
// EVERY `check_die_swap` skill the actor owns (multiple skills can grant swaps,
// possibly to different attributes), builds the beneficial swap candidates
// (slot × target where the new die is larger), then:
//   - if ANY granting skill is "ask" AND a `director` is present → the interactive
//     picker (player chooses which die/target, or keeps the roll);
//   - else (all "on"/"force") → auto-apply the biggest upgrade.
// Returns { slot:"A1"|"A2", from, to, label } or null (no skill / mode off /
// no upgrade / picker kept the roll). "off" skills are dropped entirely.
async function resolveCheckDieSwap({ actor, A1, A2, director = null }) {
  const configs = findCheckDieSwapConfigs(actor).filter((c) => c.mode !== "off");
  if (!configs.length) return null;
  const A1u = String(A1).toUpperCase();
  const A2u = String(A2).toUpperCase();
  const dA = attrDieSize(actor, A1u);
  const dB = attrDieSize(actor, A2u);
  // Beneficial candidates across all distinct swap targets. A slot already on the
  // target is ineligible; only strictly-larger dice are offered (so "may replace"
  // is satisfied — we never propose a downgrade).
  const targets = [...new Set(configs.map((c) => c.to))];
  const sourceFor = (to) => [...new Set(configs.filter((c) => c.to === to).map((c) => c.label).filter(Boolean))].join(" / ");
  // ALL swap candidates (slot × target where the target differs from the slot's
  // attribute); gain may be ≤ 0. `upgrades` is the strictly-positive subset.
  const all = [];
  for (const to of targets) {
    const dTo = attrDieSize(actor, to);
    if (A1u !== to) all.push({ slot: "A1", from: A1u, to, dTo, gain: dTo - dA, source: sourceFor(to) });
    if (A2u !== to) all.push({ slot: "A2", from: A2u, to, dTo, gain: dTo - dB, source: sourceFor(to) });
  }
  const upgrades = all.filter((c) => c.gain > 0);
  if (!upgrades.length) return null;   // no beneficial swap → no prompt / no auto-swap

  // ONE die per skill: each skill is a single swap "charge" for its target, so a
  // target may be applied at most (# skills granting it) times across the two dice
  // — and a single skill can never swap both dice. Budget = per-target charge count
  // (its sum = the total swap cap = number of skills).
  const budget = {};
  for (const c of configs) budget[c.to] = (budget[c.to] ?? 0) + 1;

  const askMode = configs.some((c) => c.mode === "ask");

  // A sim has nobody to answer the picker, and it opens on EVERY accuracy check
  // the owner makes (Keren's Psychokinesis), so the overlay would park the run
  // until the stall watchdog fired. Fall through to the auto path below, which
  // already assigns each skill's charge to the biggest upgrade — i.e. exactly
  // what a player opening this picker would pick anyway. Note this is currently
  // latent for Keren (DEX d12 > WLP d10 → no beneficial swap → no picker), but
  // one DEX debuff makes the swap an upgrade and the picker appears.
  if (askMode && director && !SimMode.active) {
    const label = [...new Set(configs.map((c) => c.label).filter(Boolean))].join(" · ") || "Die swap";
    // BOTH dice are shown, each with ALL its swap options (up OR down) + the change
    // and the granting skill. The picker enforces the per-target `budget` so the
    // player can't spend one skill on two dice.
    const slots = [
      { slot: "A1", attr: A1u, die: dA, options: all.filter((c) => c.slot === "A1").map((c) => ({ to: c.to, dTo: c.dTo, gain: c.gain, source: c.source })) },
      { slot: "A2", attr: A2u, die: dB, options: all.filter((c) => c.slot === "A2").map((c) => ({ to: c.to, dTo: c.dTo, gain: c.gain, source: c.source })) },
    ];
    try {
      // Routes to the acting actor's OWNER (online player) with a GM-local
      // picker racing it; falls back to GM-local for NPCs / offline owners.
      const { resolveDieSwapInteractive } = await import("./check-die-swap-picker.js");
      const swaps = await resolveDieSwapInteractive({ director, actor, label, A1: A1u, A2: A2u, dA, dB, slots, budget });
      return (swaps ?? []).map((p) => ({ slot: p.slot, from: p.from, to: p.to, label: sourceFor(p.to) }));
    } catch (e) {
      warn("check_die_swap: picker threw — keeping the original roll", e);
      return [];
    }
  }

  // Auto: greedily assign skill charges to dice by biggest gain — each die swapped
  // at most once, each target capped by its budget. A single skill → one die.
  const remaining = { ...budget };
  const usedDie = new Set();
  const out = [];
  for (const u of upgrades.slice().sort((a, b) => b.gain - a.gain)) {
    if (usedDie.has(u.slot) || (remaining[u.to] ?? 0) <= 0) continue;
    out.push({ slot: u.slot, from: u.from, to: u.to, label: sourceFor(u.to) });
    usedDie.add(u.slot);
    remaining[u.to] -= 1;
  }
  if (out.length && askMode && SimMode.active) {
    SimMode.note(
      "die-swap",
      `${actor?.name}: ${out.map((s) => `${s.slot} ${s.from}→${s.to}`).join(", ")} (auto — ask-mode picker skipped)`
    );
  }
  return out;
}

// Shared "kit capability" scan: walk the actor's owned skill Items for effect_table
// rows of a given effect_kind — a standing config carried on a skill (read at a
// pipeline point, vs a fired reaction or an AE change). Returns [{ row, item }].
function collectKitConfigs(actor, kind) {
  const out = [];
  for (const item of actor?.items ?? []) {
    const et = item.system?.props?.effect_table;
    if (!et || typeof et !== "object") continue;
    for (const row of Object.values(et)) {
      if (row?.effect_kind === kind) out.push({ row, item });
    }
  }
  return out;
}

// All of the actor's check_die_swap configs — { mode, to, label } per swap skill.
// Mode + target live on the effect row itself (swap_mode / swap_to_attribute); no
// companion reaction row. Multiple swap skills → multiple entries.
function findCheckDieSwapConfigs(actor) {
  return collectKitConfigs(actor, "check_die_swap").map(({ row, item }) => ({
    mode: String(row.swap_mode ?? "on").trim().toLowerCase(),
    to: String(row.swap_to_attribute ?? "WLP").trim().toUpperCase(),
    label: item.name ?? "",
  }));
}

// ── Comparison layer (the per-action interpretation) ───────────────────────
// Generic comparisons live here; action-specific ladders (e.g. Study's
// encyclopedia tiers) stay with the action. A check result never carries the
// comparison — the caller supplies the defense / DL.
export const checkVsDefense = (r, defense) => ({
  hit: r.isCrit || (!r.isFumble && r.total >= Number(defense)),
  margin: r.total - Number(defense),
});
export const checkVsThreshold = (r, dl) => ({
  success: r.isCrit ? true : r.isFumble ? false : r.total >= Number(dl),
});

// Single source of truth for "does this action hit this target?" given a
// possibly-overridden accuracy `total` and a possibly-overridden `defense`.
// `roll` is the action's accuracy roll, or NULL when the action has no accuracy
// check — a guaranteed hit. Encodes FU's terminal outcomes in one place: no
// check → auto-hit; a Critical always hits; a Fumble always misses; otherwise
// total ≥ defense. The adjust_accuracy / adjust_defense card-mutations and their
// recompute mirrors all route through this, so the rule (and the auto-hit
// invariant that keeps a checkless action from ever being recomputed into a
// miss) can never drift or be forgotten at one site. Callers own the ARITHMETIC
// (compose the new total / new defense); this owns only the DECISION.
export const decideHit = (roll, total, defense) =>
  !roll ? true
  : roll.isCrit ? true
  : roll.isFumble ? false
  : Number(total) >= Number(defense ?? 10);
