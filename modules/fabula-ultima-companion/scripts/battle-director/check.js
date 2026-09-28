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
import { isCriticalHit, buildSkillResolver, evaluateFormula } from "./skill-formulas.js";
import { attrDieSize, readPropNum, resolveAttackerWeapon } from "./snapshot.js";
import { log, warn } from "./logger.js";
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
export async function rollCheck({ actor, A1, A2, checkBonus = 0, dice = null, allowDieSwap = false, director = null, actionPayload = null } = {}) {
  const props = actor?.system?.props ?? null;
  // Psychokinesis-style pre-roll die swap: an owning skill with a check_die_swap
  // config may replace one Attribute die with a larger one (WLP) BEFORE rolling.
  // Only on accuracy checks (allowDieSwap) and live rolls (forced `dice` are kept
  // verbatim so the harness/crit machinery stays deterministic). `director` enables
  // the "ask"-mode interactive picker (else auto).
  let dieSwap = null;
  // WEAPON pair mode (Spellblade): replace BOTH dice with a chosen equipped
  // weapon's accuracy pair. Needs `actionPayload` (the Skill/Spell COMPUTE caller
  // passes it) — its condition_formula is judged against the action, so a call
  // without one (the Attack path) never offers it. `checkBonusDelta` is returned
  // for the CALLER to fold into its own check bonus (this function's checkBonus
  // arg is not the one the Skill COMPUTE profile reads).
  let weaponSwap = null;
  if (allowDieSwap && !dice && actionPayload) {
    weaponSwap = await resolveWeaponPairSwap({ actor, A1, A2, director, actionPayload });
    if (weaponSwap) {
      dieSwap = [{ from: `${String(A1).toUpperCase()}+${String(A2).toUpperCase()}`, to: `${weaponSwap.A1}+${weaponSwap.A2}`, slot: "pair", label: weaponSwap.label }];
      A1 = weaponSwap.A1; A2 = weaponSwap.A2;
    }
  }
  if (allowDieSwap && !dice) {
    const swaps = await resolveCheckDieSwap({ actor, A1, A2, director, actionPayload });
    if (Array.isArray(swaps) && swaps.length) {
      dieSwap = dieSwap ?? [];
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
  return { ...deriveCheck({ rA, rB, props, fumbleThreshold, checkBonus }), dA, dB, A1, A2, dieSwap,
    weaponSwap, checkBonusDelta: Number(weaponSwap?.checkBonusDelta ?? 0) || 0 };
}

// Headless = nobody can answer a picker: a sim, or a harness run (which sets
// __FU_HARNESS_HEADLESS__). Both take the auto path.
const _noHumanToPick = () => SimMode.active || globalThis.__FU_HARNESS_HEADLESS__ === true;

// Does a check_die_swap config apply to THIS action? Blank condition = always.
// Resolved with the config's OWN item as the skill, so `SL` is that skill's level.
// With no payload the condition sees an empty one — fails closed for any gate
// that reads the action.
function swapConditionHolds(cfg, actor, actionPayload) {
  const cond = String(cfg.condition ?? "").trim();
  if (!cond) return true;
  try {
    const resolver = buildSkillResolver({ actor, payload: actionPayload ?? {}, skill: cfg.item ?? null });
    return !!Number(evaluateFormula(cond, resolver, 0));
  } catch (e) {
    warn(`check_die_swap: condition on ${cfg.label} threw — not applied`, e);
    return false;
  }
}

// WEAPON pair mode (Spellblade). Each qualifying config offers every equipped
// weapon (main + off hand) in its category list; a weapon's option carries its own
// accuracy pair, its accuracy bonus, and the config's check_bonus_formula (with
// WEAPON_USES_DEX = 1 when either die of the pair is DEX). ask + a live director
// with a human → a list picker routed to the owner; otherwise the best expected
// total is taken, and only when it beats the check as rolled ("may").
// Returns { A1, A2, checkBonusDelta, label, weapon } or null (kept).
async function resolveWeaponPairSwap({ actor, A1, A2, director = null, actionPayload = null }) {
  if (!actor || !actionPayload) return null;
  const all = findCheckDieSwapConfigs(actor).filter((c) => c.to === "WEAPON" && c.mode !== "off");
  if (!all.length) return null;
  const configs = all.filter((c) => {
    const ok = swapConditionHolds(c, actor, actionPayload);
    if (!ok) log(`check_die_swap: ${c.label} — condition refused (targets=${actionPayload?.targets?.length ?? 0} costMp=${actionPayload?.costMp} type=${actionPayload?.actionSkillType} isCheck=${actionPayload?.actionIsCheck})`);
    return ok;
  });
  if (!configs.length) return null;
  const weapons = [];
  for (const which of ["main", "off"]) {
    const w = resolveAttackerWeapon(actor, { which });
    if (!w?.A1 || !w?.A2) continue;
    if (weapons.some((x) => x.name === w.name && x.A1 === w.A1 && x.A2 === w.A2)) continue;
    weapons.push(w);
  }
  const options = [];
  for (const cfg of configs) {
    const allow = String(cfg.categories ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const w of weapons) {
      const cat = String(w.weaponType ?? "").trim().toLowerCase();
      if (allow.length && !allow.includes(cat)) continue;
      const usesDex = (w.A1 === "DEX" || w.A2 === "DEX") ? 1 : 0;
      let extra = 0;
      const f = String(cfg.bonusFormula ?? "").trim();
      if (f) {
        try {
          const resolver = buildSkillResolver({ actor, payload: actionPayload, skill: cfg.item ?? null, vars: { WEAPON_USES_DEX: usesDex } });
          extra = Number(evaluateFormula(f, resolver, 0)) || 0;
        } catch (e) { warn(`check_die_swap: check_bonus_formula on ${cfg.label} threw — 0`, e); }
      }
      const delta = (Number(w.checkBonus) || 0) + extra;
      const dA = attrDieSize(actor, w.A1), dB = attrDieSize(actor, w.A2);
      options.push({ A1: w.A1, A2: w.A2, checkBonusDelta: delta, label: cfg.label, weapon: w.name, category: cat,
        ev: (dA + 1) / 2 + (dB + 1) / 2 + delta, dA, dB, mode: cfg.mode });
    }
  }
  if (!options.length) {
    log(`check_die_swap: ${configs.map((c) => c.label).join(" / ")} — no qualifying weapon (equipped: ${weapons.map((w) => `${w.name}[${w.weaponType || "?"}]`).join(", ") || "none"})`);
    return null;
  }
  const A1u = String(A1).toUpperCase(), A2u = String(A2).toUpperCase();
  const baseEv = (attrDieSize(actor, A1u) + 1) / 2 + (attrDieSize(actor, A2u) + 1) / 2;
  const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const askMode = options.some((o) => o.mode === "ask");
  if (askMode && director && !_noHumanToPick()) {
    const listArgs = {
      title: [...new Set(options.map((o) => o.label))].join(" · ") || "Weapon Check",
      subtitle: "Roll this check with a weapon's Accuracy formula?",
      options: [
        { value: -1, primary: `Keep ${A1u} + ${A2u}`, secondary: `d${attrDieSize(actor, A1u)} + d${attrDieSize(actor, A2u)}` },
        ...options.map((o, i) => ({ value: i, primary: `${o.weapon}: ${o.A1} + ${o.A2} ${sign(o.checkBonusDelta)}`,
          secondary: `d${o.dA} + d${o.dB} ${sign(o.checkBonusDelta)} (${o.category || "weapon"})` })),
      ],
      zIndex: 97,
    };
    let picked = null;
    try {
      const channel = director?.intentChannel ?? null;
      const owner = (game.users?.contents ?? [])
        .filter((u) => !u.isGM && u.active && (() => { try { return actor.testUserPermission?.(u, "OWNER"); } catch { return false; } })())
        .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
      if (game.user?.isGM && owner && channel) {
        const { remotePick, REMOTE_PICK_KINDS } = await import("./remote-pick.js");
        picked = await remotePick({ channel, targetUserId: owner.id, combatId: director?.combatId ?? null,
          kind: REMOTE_PICK_KINDS.LIST, onTimeoutValue: null, spec: listArgs });
      } else {
        const { pickFromList } = await import("./list-picker.js");
        picked = await pickFromList(listArgs);
      }
    } catch (e) {
      warn("check_die_swap: weapon picker threw — keeping the original roll", e);
      return null;
    }
    const idx = Number(picked);
    if (picked == null || !Number.isInteger(idx) || idx < 0 || idx >= options.length) return null;
    const o = options[idx];
    log(`check_die_swap: ${o.label} → ${o.weapon} (${o.A1}+${o.A2} ${sign(o.checkBonusDelta)}) [picked]`);
    return { A1: o.A1, A2: o.A2, checkBonusDelta: o.checkBonusDelta, label: o.label, weapon: o.weapon };
  }
  const best = options.slice().sort((a, b) => b.ev - a.ev)[0];
  if (!(best.ev > baseEv)) {
    log(`check_die_swap: ${best.label} — no weapon beats ${A1u}+${A2u} (best ${best.weapon} ev ${best.ev} vs ${baseEv}); kept`);
    return null;
  }
  log(`check_die_swap: ${best.label} → ${best.weapon} (${best.A1}+${best.A2} ${sign(best.checkBonusDelta)}) [auto]`);
  if (askMode && SimMode.active) SimMode.note("die-swap", `${actor?.name}: ${best.label} → ${best.weapon} (auto — ask-mode picker skipped)`);
  return { A1: best.A1, A2: best.A2, checkBonusDelta: best.checkBonusDelta, label: best.label, weapon: best.weapon };
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
async function resolveCheckDieSwap({ actor, A1, A2, director = null, actionPayload = null }) {
  // WEAPON (pair mode) configs are resolveWeaponPairSwap's; a single-die config
  // with a condition_formula applies only when it holds for this action.
  const configs = findCheckDieSwapConfigs(actor)
    .filter((c) => c.mode !== "off" && c.to !== "WEAPON")
    .filter((c) => swapConditionHolds(c, actor, actionPayload));
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
    item,
    condition: String(row.condition_formula ?? ""),
    categories: String(row.swap_weapon_categories ?? ""),
    bonusFormula: String(row.check_bonus_formula ?? ""),
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
//
// `roll.invertHit` — the `Trick` keyword (Keyword Repository 1v5xrozP0fHlnjQj):
// "an accuracy check result LOWER than the target's defense counts as a hit,
// while a result HIGHER counts as a miss". Only the COMPARISON reverses: a
// Critical still hits and a Fumble still misses (the databook reverses the
// success condition, not the terminal outcomes). The flag rides on the ROLL
// rather than arriving as an argument precisely so it cannot be forgotten at one
// of the six call sites — every one of them already passes the roll, and both
// reroll paths rebuild via `{ ...roll, ...derived }` so it survives an invoke.
export const decideHit = (roll, total, defense) =>
  !roll ? true
  : roll.isCrit ? true
  : roll.isFumble ? false
  : roll.invertHit ? Number(total) < Number(defense ?? 10)
  : Number(total) >= Number(defense ?? 10);

// ── Fickle: the concealed check ──────────────────────────────────────────────
// The `Fickle` action keyword hides an action's accuracy: the card shows "?" for
// each die and the possible TOTAL RANGE instead of the rolled total, and each
// per-target row shows a CHANCE TO HIT instead of HIT/MISS. Nothing about the
// mechanics changes — the real roll still decides, it is simply not shown.
//
// Concealment only works if the % is honest, so the chance is enumerated over
// the ACTUAL die faces through `deriveCheck` — the same rule that produced the
// real roll — rather than approximated. dA/dB are ≤ d12, so this is ≤ 144 cheap
// iterations, run ONCE per action at check time.
//
// Returns { n, crit, fumble, counts, min, max }: `counts` is a histogram of the
// non-terminal totals (a Critical always hits and a Fumble always misses, so
// they are counted separately and never compared to a defense). Histogram, not a
// flat list — this object rides the action result into every player mirror's
// broadcast, so it stays ~20 keys instead of 144 entries.
export function buildCheckDistribution({ dA, dB, props = null, fumbleThreshold = 1, checkBonus = 0 } = {}) {
  const sa = Math.max(1, Number(dA) || 0);
  const sb = Math.max(1, Number(dB) || 0);
  // A PLAIN object, not Object.create(null): this rides the actionResult through
  // freezeActionResult and the structured-clone broadcast to every player mirror,
  // and Foundry's own deep-walk helpers assume an ordinary prototype. Keys are
  // stringified integers, so there is nothing for a prototype key to collide with.
  const counts = {};
  let n = 0, crit = 0, fumble = 0, min = Infinity, max = -Infinity;
  for (let a = 1; a <= sa; a++) {
    for (let b = 1; b <= sb; b++) {
      const d = deriveCheck({ rA: a, rB: b, props, fumbleThreshold, checkBonus });
      n++;
      if (d.total < min) min = d.total;
      if (d.total > max) max = d.total;
      if (d.isCrit) { crit++; continue; }
      if (d.isFumble) { fumble++; continue; }
      counts[d.total] = (counts[d.total] ?? 0) + 1;
    }
  }
  // The bonus the histogram was ENUMERATED at, carried with it. checkHitChance
  // measures a later adjustment against this rather than against whatever
  // `roll.checkBonus` currently says — see the note there.
  return { n, crit, fumble, counts, checkBonus: Number(checkBonus) || 0,
           min: n ? min : 0, max: n ? max : 0 };
}

// Chance (0..1) that a Fickle action hits `defense`, or null when the roll is
// not Fickle. Deliberately shaped like `decideHit` — same argument order, same
// call sites — because every place that decides a hit must also refresh the
// chance, or a reaction that moves the accuracy total / the target's defense
// would leave a stale percentage standing next to a changed verdict.
//
// `total` is the EFFECTIVE accuracy total being compared (post accuracy-override).
// The distribution was enumerated from the unmodified check, so the gap between
// `total` and the roll's OWN unmodified total is the shift a reaction applied, and
// every outcome in the histogram moves by it — which is exactly how an
// adjust_accuracy changes the odds, not just the one rolled result.
//
// That base is reconstructed from the DICE plus the bonus the DISTRIBUTION was
// enumerated at (`dist.checkBonus`) — never from a stored total, and never from
// the roll's CURRENT checkBonus. Both alternatives are wrong in opposite
// directions, and both were shipped and caught:
//
//   • A stored base goes stale the moment something REPLACES the dice.
//     check_reroll and set_check_die rebuild the roll as `{ ...roll, rA, rB,
//     total }`, so a carried-over base survives against a new total and the
//     shift becomes the reroll's delta — the percentage would literally encode
//     how far the reroll moved the number (21 → 8 reading as 71% → 4%), off a
//     panel that claims the roll is hidden.
//
//   • The roll's CURRENT checkBonus goes stale the other way, when something
//     adds to the bonus WITHOUT re-enumerating. A GM typing "+5 accuracy"
//     produces a roll whose checkBonus and total both already contain the +5, so
//     base === total, the shift computes as zero, and the odds stay put while the
//     displayed range moves — two numbers on one card disagreeing about the same
//     action.
//
// `dist.checkBonus` is immune to both: it moves only when the histogram is
// actually rebuilt (which computeCheck does when it folds a committed Bond bonus
// in), so a dice swap shifts by zero and a bonus laid on top shifts by exactly
// that bonus.
// Is this roll's outcome hidden from the table right now?
//
// THE SINGLE PREDICATE every display surface asks. Fickle hides the roll — with
// one exception, which is a game rule rather than a rendering detail: a CRITICAL
// announces itself as normal. A crit is a spectacle, and it auto-hits every
// target, so there is nothing left to be uncertain about; the keyword's tension
// lives in the ordinary rolls and the fumbles, which stay hidden.
//
// Routing every surface through one function is what makes that exception cheap.
// The crit banner, the Opportunity note, the cut-in, the real dice and total, the
// per-target verbs and the crit-gated reaction pills all come back on a crit
// because each of them is already gated on "is this concealed", not on "is this
// Fickle". It also closes a leak by construction: a reaction row conditioned on
// ATTACK_IS_CRIT renders only on a crit, so its mere presence used to announce
// the hidden outcome. Now a crit is public, so the pill tells nobody anything
// they were not already being shown.
export function isConcealedRoll(roll) {
  if (!roll?.fickle) return false;
  return !(roll.isCrit && !roll.isFumble);
}

export function checkHitChance(roll, total, defense) {
  // A revealed Critical shows its real verdict, so there is no chance to quote —
  // null here is what stops every caller stamping `hitChance` onto those rows,
  // which is what lets resultLabelFor fall through to the normal HIT/damage verb.
  if (!isConcealedRoll(roll)) return null;
  const dist = roll?.fickleDist;
  if (!dist || !dist.n) return null;
  const def = Number(defense ?? 10);
  const rA = Number(roll.rA), rB = Number(roll.rB);
  // Pre-roll (dice not yet known) has no base to measure against — no shift.
  const base = (Number.isFinite(rA) && Number.isFinite(rB))
    ? rA + rB + (Number(dist.checkBonus) || 0)
    : NaN;
  const eff = Number(total);
  const shift = (Number.isFinite(base) && Number.isFinite(eff)) ? eff - base : 0;
  return chanceAtShift(dist, shift, def, !!roll.invertHit);
}

// The histogram lookup itself, with the shift given outright. Split out because a
// caller can know the shift directly and NOT the base — the Bond hover preview on
// a player mirror is exactly that: it knows the bonus it is previewing, and it
// must not need the concealed dice to work out what that bonus buys.
export function chanceAtShift(dist, shift, defense, inverted = false) {
  if (!dist || !dist.n) return null;
  const def = Number(defense ?? 10);
  const d = Number(shift) || 0;
  let hits = dist.crit;                       // a Critical always hits
  for (const key of Object.keys(dist.counts ?? {})) {
    const v = Number(key) + d;
    if (inverted ? v < def : v >= def) hits += dist.counts[key];
  }
  return hits / dist.n;                       // Fumbles are absent → never hit
}

// Percent string for a card ("62%"). Kept beside the math so the GM card, the
// player mirror and the tooltips can never round differently.
export function formatHitChance(chance) {
  const p = Math.round((Number(chance) || 0) * 100);
  return `${Math.max(0, Math.min(100, p))}%`;
}
