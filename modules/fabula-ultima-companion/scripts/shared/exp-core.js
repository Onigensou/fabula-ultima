// ============================================================================
// exp-core.js — the single owner of EXP, character level and Skill Point writes.
//
// Before this module the game had FOUR paths that could write
// `system.props.experience`, each built against different assumptions:
//
//   • battle-director/battle-end/battle-end-summary-logic.js   (Director victory)
//   • Macro "[BattleEnd: SummaryLogic]"                        (legacy battles)
//   • exp-awarder/expAwarder-api.js                            (GM sidebar)
//   • Macro "Victory Loadout"                                  (orphaned)
//
// They disagreed on six things. The three LIVE module paths now delegate here;
// the two macros are DISCONTINUED and left untouched (see macros/ headers).
//
// ── What was reconciled ─────────────────────────────────────────────────────
//
//  1. THE GAUGE. Canonical is the Battle Director's: EXP runs 1 → 10, so a
//     level spans NINE points and rolls over to 1. expAwarder previously used
//     0 → 10 (ten-wide, rolling to 0). No data migration is needed — a stored
//     value below EXP_START is normalised up on the next award.
//
//  2. THE SKILL POINT. A gained level mints a Skill Point, spent later in the
//     level-up window at camp or the title screen. This used to happen ONLY in
//     expAwarder, which meant every Battle Director level-up silently produced
//     drift that a GM had to clear by hand with `healPoints()`. Minting lives
//     here now, so every path that can raise a level also mints.
//
//  3. OVER-CAP STORED VALUES. BD reset a stored `exp >= LEVEL_UP_AT` to
//     EXP_START, silently eating the pending level. expAwarder converted the
//     overflow into levels. expAwarder's behaviour is strictly better and is
//     what normaliseGauge() does — it only ever fires on already-broken data.
//
//  4. NEGATIVE AWARDS. expAwarder accepted them (clamping EXP, never reducing
//     level); BD floored the gain at 0 and silently discarded them. The
//     permissive behaviour wins: a negative is honoured, EXP clamps at
//     EXP_START, level never goes down. Callers that never pass a negative
//     (both battle paths) are unaffected.
//
//  5. SEGMENTS. The victory screen animates a per-level `segments` array that
//     only BD produced; the award panel approximated multi-level gains from
//     raw percentages. Every result now carries segments, so both surfaces can
//     animate the same way.
//
//  6. THE FORMULA. The v1.2 EXP formula existed twice — battle-end-rewards.js
//     and the "BattleInit — Battle Record Writer" macro. computeExpAward() is
//     now the single implementation; battle-end-rewards.js delegates to it.
//
// ── Discontinued on purpose ─────────────────────────────────────────────────
// `system.props.experience_ui` is NOT written here. It is a mirror field that
// only the orphaned "Victory Loadout" macro ever maintained, it has already
// drifted on live actors (exp 3.77 against experience_ui 0), and nothing in the
// module reads it. Writing it would mean reviving a field no surface trusts.
//
// ── Consumption ─────────────────────────────────────────────────────────────
// ESM callers import from here. Classic (non-module) scripts read the mirror
// at `globalThis["oni.ExpCore"]`, the same pattern shared/code-backed-content.js
// uses. The mirror is published at module-load, and every classic caller only
// reaches for it at award time, so script/esmodule load order is irrelevant.
//
// See docs/exp-award-pipeline.md.
// ============================================================================

const MODULE_TAG = "[ONI][ExpCore]";

// ── Canonical rule ──────────────────────────────────────────────────────────

export const EXP_RULE = Object.freeze({
  EXP_PATH:         "system.props.experience",
  LEVEL_PATH:       "system.props.level",
  SKILL_POINT_PATH: "system.props.skill_point",

  // The gauge. A level spans (LEVEL_UP_AT - EXP_START) = 9 points.
  EXP_START:   1,
  LEVEL_UP_AT: 10,
  DECIMALS:    2,

  // Clamp applied to a computed award. AWARD_FLOOR is what makes even a
  // trivial encounter worth something; AWARD_CAP stops a wildly over-levelled
  // fight handing out several levels at once.
  AWARD_FLOOR: 1,
  AWARD_CAP:   15,
});

// v1.2 EXP formula constants. Ported from "BattleInit — Battle Record Writer"
// by way of battle-end-rewards.js, which now delegates here.
export const EXP_FORMULA = Object.freeze({
  A:       10,    // level-delta scaling denominator inside the exponent
  M_MIN:   0.25,  // clamp floor for the level multiplier
  M_MAX:   5.0,   // clamp ceiling for the level multiplier
  // Diminishing weights against enemies sorted by contribution, descending.
  // The tail repeats the last entry, so a seventh enemy still counts 0.40.
  WEIGHTS: Object.freeze([1.00, 0.70, 0.55, 0.45, 0.40]),
});

// ── Small helpers ───────────────────────────────────────────────────────────

const gp = (obj, path) => foundry.utils.getProperty(obj, path);

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function safeNumber(v, fallback = 0) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function roundTo(x, dec) {
  const p = Math.pow(10, dec);
  return Math.round(x * p) / p;
}

function weightAt(k1) {
  const i = k1 - 1;
  const W = EXP_FORMULA.WEIGHTS;
  return i < W.length ? W[i] : W[W.length - 1];
}

function makeRunId() {
  return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

/** Position within the current level, 0–100. Denominator is 9, not 10. */
export function expToPct(exp) {
  const { EXP_START, LEVEL_UP_AT } = EXP_RULE;
  const denom = Math.max(1e-6, LEVEL_UP_AT - EXP_START);
  return clamp(((safeNumber(exp, EXP_START) - EXP_START) / denom) * 100, 0, 100);
}

// ── Gauge maths ─────────────────────────────────────────────────────────────

/**
 * Bring a stored (exp, level) pair back onto the canonical gauge.
 *
 * Below EXP_START is raised to it — that is the whole migration story for
 * actors previously written by expAwarder's 0-based gauge. At or above
 * LEVEL_UP_AT the overflow is converted into levels rather than discarded,
 * which is what BD used to get wrong.
 */
function normaliseGauge(expRaw, levelRaw) {
  const { EXP_START, LEVEL_UP_AT } = EXP_RULE;

  let level = Math.max(1, Math.floor(safeNumber(levelRaw, 1)));
  let exp   = safeNumber(expRaw, EXP_START);

  if (!Number.isFinite(exp) || exp < EXP_START) exp = EXP_START;

  let guard = 0;
  while (exp >= LEVEL_UP_AT && guard++ < 9999) {
    exp = EXP_START + (exp - LEVEL_UP_AT);
    level += 1;
  }

  return { exp, level };
}

/**
 * Apply a gain to a stored (exp, level) pair.
 *
 * @returns {{
 *   beforeExp:number, afterExp:number, gained:number,
 *   beforeLevel:number, afterLevel:number, levelsGained:number,
 *   segments:Array<{from:number,to:number,levelUp:boolean}>
 * }}
 *
 * `segments` describes the bar animation: one entry per level crossed, each
 * running from where the bar started to where it ended, with `levelUp` true on
 * every segment that hit the cap. A zero or negative gain yields one flat
 * segment so a consumer never has to special-case an empty array.
 */
export function computeExpAndLevel(beforeExpRaw, beforeLevelRaw, gainedRaw) {
  const { EXP_START, LEVEL_UP_AT, DECIMALS } = EXP_RULE;
  const { exp: startExp, level: startLevel } = normaliseGauge(beforeExpRaw, beforeLevelRaw);

  const gained = safeNumber(gainedRaw, 0);

  // Non-positive: never reduces level, never falls below EXP_START.
  if (gained <= 0) {
    const afterExp = Math.max(EXP_START, startExp + gained);
    return {
      beforeExp:    roundTo(startExp, DECIMALS),
      afterExp:     roundTo(afterExp, DECIMALS),
      gained:       roundTo(gained, DECIMALS),
      beforeLevel:  startLevel,
      afterLevel:   startLevel,
      levelsGained: 0,
      segments: [{
        from:    roundTo(startExp, DECIMALS),
        to:      roundTo(afterExp, DECIMALS),
        levelUp: false,
      }],
    };
  }

  const segments = [];
  let runningExp   = startExp;
  let runningLevel = startLevel;
  let total        = startExp + gained;
  let levelsGained = 0;

  let guard = 0;
  while (total >= LEVEL_UP_AT && guard++ < 9999) {
    segments.push({ from: roundTo(runningExp, DECIMALS), to: roundTo(LEVEL_UP_AT, DECIMALS), levelUp: true });
    total        = EXP_START + (total - LEVEL_UP_AT);
    runningLevel += 1;
    levelsGained += 1;
    runningExp    = EXP_START;
  }
  segments.push({ from: roundTo(runningExp, DECIMALS), to: roundTo(total, DECIMALS), levelUp: false });

  return {
    beforeExp:    roundTo(startExp, DECIMALS),
    afterExp:     roundTo(total, DECIMALS),
    gained:       roundTo(gained, DECIMALS),
    beforeLevel:  startLevel,
    afterLevel:   runningLevel,
    levelsGained,
    segments,
  };
}

// ── The v1.2 award formula ──────────────────────────────────────────────────

/** Rank bucket for an enemy actor. Anything unrecognised counts as soldier. */
export function enemyRankOf(actorDoc) {
  const raw = String(actorDoc?.system?.props?.npc_rank ?? "").toLowerCase().trim();
  if (raw === "champion") return "champion";
  if (raw === "elite")    return "elite";
  return "soldier";
}

function levelOf(actorDoc) {
  const n = safeNumber(gp(actorDoc, EXP_RULE.LEVEL_PATH), NaN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/**
 * Read the tunable multipliers off the Current Game DB actor.
 * Every value is a DB prop so balance moves without a code change.
 */
export async function readExpMultipliers() {
  const out = { G: 1.0, soldier: 1.0, elite: 1.5, champion: 3.0, boss: 1.6 };
  try {
    const api = globalThis.FUCompanion?.api;
    if (!api?.getCurrentGameDb) return out;
    const { source: db } = await api.getCurrentGameDb();
    if (!db) return out;
    out.G        = safeNumber(gp(db, "system.props.exp_global_multiplier"),    out.G);
    out.soldier  = safeNumber(gp(db, "system.props.exp_soldier_multiplier"),   out.soldier);
    out.elite    = safeNumber(gp(db, "system.props.exp_elite_multiplier"),     out.elite);
    out.champion = safeNumber(gp(db, "system.props.exp_champion_multiplier"),  out.champion);
    out.boss     = safeNumber(gp(db, "system.props.exp_boss_multiplier"),      out.boss);
  } catch (e) {
    console.warn(MODULE_TAG, "DB multiplier read failed — using defaults:", e);
  }
  return out;
}

/**
 * The v1.2 EXP formula, per PC, over a set of defeated enemies.
 *
 *   c_ij = B_rank[j] × clamp( 2^((E_j − L_i) / A), M_MIN, M_MAX )
 *   R_i  = Σ_k W[k] × c_ij, contributions sorted descending
 *   EXP_i = clamp( P_i × G × R_i × β × mult, floor, cap )
 *
 * `mult` and `floor` are the levers a non-combat source needs. A stealth
 * takedown passes mult < 1 to pay less than the same enemies would in a fight,
 * with its own lower floor so the discount survives the clamp — applying the
 * multiplier AFTER a floor of 1 would let the floor swallow it entirely on
 * small hauls. Both default to the values a normal fight already uses, so
 * existing callers pass neither.
 *
 * Pure: reads actors, writes nothing.
 *
 * @param {object}  args
 * @param {Actor[]} args.partyActors
 * @param {Actor[]} args.enemyActors
 * @param {boolean} [args.isBoss=false]
 * @param {object}  [args.multipliers]  from readExpMultipliers(); read if omitted
 * @param {number}  [args.mult=1]
 * @param {number}  [args.floor=EXP_RULE.AWARD_FLOOR]
 * @param {number}  [args.cap=EXP_RULE.AWARD_CAP]
 * @returns {Promise<{expByActorId:Record<string,number>, detail:object[]}>}
 */
export async function computeExpAward({
  partyActors = [],
  enemyActors = [],
  isBoss = false,
  multipliers = null,
  mult = 1,
  floor = EXP_RULE.AWARD_FLOOR,
  cap = EXP_RULE.AWARD_CAP,
} = {}) {
  const expByActorId = {};
  const detail = [];

  const party = partyActors.filter(Boolean);
  const foes  = enemyActors.filter(Boolean);
  if (!party.length || !foes.length) return { expByActorId, detail };

  const M = multipliers ?? await readExpMultipliers();

  // The boss premium applies when the battle is flagged boss OR any champion
  // is present — a champion showing up IS the boss fight, however it started.
  const anyChampion = foes.some((a) => enemyRankOf(a) === "champion");
  const beta = (isBoss || anyChampion) ? M.boss : 1.0;

  const foeStats = foes.map((a) => {
    const rank = enemyRankOf(a);
    return {
      name: a?.name ?? "",
      level: levelOf(a),
      rank,
      rankMult: rank === "champion" ? M.champion : rank === "elite" ? M.elite : M.soldier,
    };
  });

  for (const pc of party) {
    const actorId = pc?.id;
    if (!actorId) continue;

    const Li = levelOf(pc);
    const Pi = safeNumber(gp(pc, "system.props.character_exp_multiplier"), 1.0);

    const contribs = foeStats
      .map((e) => ({
        ...e,
        c: e.rankMult * clamp(Math.pow(2, (e.level - Li) / EXP_FORMULA.A), EXP_FORMULA.M_MIN, EXP_FORMULA.M_MAX),
      }))
      .sort((x, y) => y.c - x.c);

    let Ri = 0;
    for (let k = 0; k < contribs.length; k++) Ri += weightAt(k + 1) * contribs[k].c;

    const raw = Pi * M.G * Ri * beta * mult;
    expByActorId[actorId] = clamp(raw, floor, cap);

    detail.push({ actorId, actorName: pc?.name ?? "", level: Li, Pi, Ri, beta, mult, raw, final: expByActorId[actorId], contribs });
  }

  return { expByActorId, detail };
}

// ── The single writer ───────────────────────────────────────────────────────

/** Accepts uuid strings, {actorUuid}, {uuid}, {actorId} or Actor documents. */
async function resolveTarget(t) {
  if (!t) return null;
  if (typeof t === "string") {
    if (t.includes(".")) { try { return await fromUuid(t); } catch { return null; } }
    return game.actors?.get?.(t) ?? null;
  }
  if (t.documentName === "Actor") return t;
  const uuid = t.actorUuid ?? t.uuid ?? null;
  if (uuid) { try { return await fromUuid(uuid); } catch { return null; } }
  if (t.actorId) return game.actors?.get?.(t.actorId) ?? null;
  return null;
}

/**
 * Apply EXP to actors. THE only place experience, character level and
 * skill_point are written.
 *
 * Two calling shapes, because the two existing callers had two:
 *
 *   applyExpAward({ targets: [uuid, ...], amount: 2.5, source: "..." })
 *   applyExpAward({ amountByActorId: { <actorId>: 2.5, ... }, source: "..." })
 *
 * Returns one entry per updated actor carrying BOTH consumers' key shapes —
 * the flat `expBefore` / `levelAfter` / `expPctFrom` set the award panel reads,
 * and the nested `exp` / `level` / `segments` set the victory screen reads — so
 * neither surface needed changing.
 *
 * @param {object}   args
 * @param {Array}    [args.targets]
 * @param {number}   [args.amount]
 * @param {object}   [args.amountByActorId]
 * @param {string}   [args.source=""]
 * @param {boolean}  [args.playUi=true]      emit oni:expAwarded (panel + badge)
 * @param {boolean}  [args.mintSkillPoints=true]
 * @param {object}   [args.user]
 * @returns {Promise<{ok:boolean, runId:string, entries:object[], errors:string[]}>}
 */
export async function applyExpAward({
  targets = null,
  amount = null,
  amountByActorId = null,
  source = "",
  playUi = true,
  mintSkillPoints = true,
  user = null,
} = {}) {
  const runId = makeRunId();
  const { EXP_PATH, LEVEL_PATH, SKILL_POINT_PATH, DECIMALS } = EXP_RULE;

  const entries = [];
  const errors  = [];

  const awardingUser = {
    id:   user?.id   ?? game.user?.id   ?? null,
    name: user?.name ?? game.user?.name ?? "Unknown",
  };

  // Normalise both calling shapes into one list of { actor, amount, meta }.
  const work = [];

  if (amountByActorId && typeof amountByActorId === "object") {
    for (const [actorId, amt] of Object.entries(amountByActorId)) {
      const actor = game.actors?.get?.(actorId);
      if (!actor) { errors.push(`Missing actor: ${actorId}`); continue; }
      work.push({ actor, amount: safeNumber(amt, 0), meta: {} });
    }
  }

  if (Array.isArray(targets) && targets.length) {
    const flat = safeNumber(amount, NaN);
    if (!Number.isFinite(flat)) {
      errors.push("INVALID_AMOUNT");
    } else {
      for (const t of targets) {
        const actor = await resolveTarget(t);
        if (!actor) { errors.push(`Unresolved target: ${JSON.stringify(t)?.slice(0, 80)}`); continue; }
        const meta = (t && typeof t === "object")
          ? { label: String(t.label ?? "").trim(), group: String(t.group ?? "").trim() }
          : {};
        work.push({ actor, amount: flat, meta });
      }
    }
  }

  if (!work.length) {
    return { ok: false, runId, entries, errors: errors.length ? errors : ["NO_TARGETS"] };
  }

  for (const { actor, amount: gain, meta } of work) {
    const calc = computeExpAndLevel(gp(actor, EXP_PATH), gp(actor, LEVEL_PATH), gain);

    // A gained level mints a Skill Point, spent later in the level-up window.
    // Levels are never lost here, so a point is never reclaimed — refunds are
    // the level-up window's job.
    const pointsBefore = safeNumber(gp(actor, SKILL_POINT_PATH), 0);
    const pointsAfter  = mintSkillPoints
      ? pointsBefore + Math.max(0, calc.levelsGained)
      : pointsBefore;

    try {
      const update = {
        [EXP_PATH]:   calc.afterExp,
        [LEVEL_PATH]: calc.afterLevel,
      };
      if (pointsAfter !== pointsBefore) update[SKILL_POINT_PATH] = pointsAfter;
      await actor.update(update);
    } catch (e) {
      errors.push(`EXP update failed for ${actor.name}: ${e?.message ?? e}`);
      console.warn(MODULE_TAG, "actor.update threw", actor?.name, e);
      continue;
    }

    entries.push({
      // identity
      actorId:   actor.id,
      actorUuid: actor.uuid,
      actorName: actor.name ?? "",
      label:     meta.label ?? "",
      group:     meta.group ?? "",
      amount:    calc.gained,
      source,
      awardedBy: awardingUser,

      // nested shape — battle-end-summary-ui.js
      exp:   { before: calc.beforeExp, gained: calc.gained, after: calc.afterExp },
      level: {
        before: calc.beforeLevel,
        after:  calc.afterLevel,
        gained: calc.levelsGained,
        leveledUp: calc.levelsGained > 0,
      },
      segments: calc.segments,

      // flat shape — expAwarder-ui.js
      expBefore:    calc.beforeExp,
      expAfter:     calc.afterExp,
      levelBefore:  calc.beforeLevel,
      levelAfter:   calc.afterLevel,
      levelsGained: calc.levelsGained,
      expPctFrom:   roundTo(expToPct(calc.beforeExp), DECIMALS),
      expPctTo:     roundTo(expToPct(calc.afterExp),  DECIMALS),

      // skill points
      skillPointsBefore: pointsBefore,
      skillPointsAfter:  pointsAfter,
      skillPointsMinted: pointsAfter - pointsBefore,
    });
  }

  if (!entries.length) {
    return { ok: false, runId, entries, errors: errors.length ? errors : ["NO_UPDATES"] };
  }

  if (playUi) {
    try {
      Hooks.callAll("oni:expAwarded", {
        runId, ts: Date.now(), source, awardedBy: awardingUser, entries,
      });
    } catch (e) {
      console.error(MODULE_TAG, "oni:expAwarded emit failed", e);
    }
  }

  return { ok: true, runId, entries, errors };
}

// ── Classic-script mirror ───────────────────────────────────────────────────
// expAwarder-api.js is a plain IIFE and cannot import. It reads this at award
// time, long after boot, so load order between scripts and esmodules is moot.

globalThis["oni.ExpCore"] = Object.freeze({
  EXP_RULE,
  EXP_FORMULA,
  expToPct,
  computeExpAndLevel,
  computeExpAward,
  readExpMultipliers,
  enemyRankOf,
  applyExpAward,
});
