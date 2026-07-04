/**
 * Migration: 2026-07-04-burn-champion-halved
 * ---------------------------------------------------------------------------
 * Champions take HALF the Burn tick. Rewrite the Burn AE's burn_dmg formula
 * from the flat 10%-of-max-HP tick to a rank-aware one:
 *
 *     ceil(MAX_HP * 0.1)   ->   ceil(MAX_HP * 0.1 * (1 - 0.5 * RANK_IS_CHAMPION))
 *
 * so a Champion-rank creature (e.g. the Wandering Flame, Actor.KygETN50UthluNPl)
 * takes 5% of its max HP per tick while everyone else keeps the full 10%.
 *
 * WHY THIS RESOLVES CORRECTLY
 * ---------------------------
 * The row is effect_kind "deal_damage", target_ref "self", so at tick time the
 * formula resolver's `actor` is the AFFLICTED creature (that is exactly why the
 * bare MAX_HP already yields the victim's — not the caster's — max HP; see
 * 2026-06-25-burn-dot-ceil + feedback_apply_ae_formula_bake_max_hp). RANK_IS_CHAMPION
 * reads that SAME resolver actor's `system.props.npc_rank` (skill-formulas.js),
 * so it evaluates the VICTIM's rank — 1 for a Champion, 0 otherwise. The engine
 * has no ?: ternary, hence the (1 - 0.5 * RANK_IS_CHAMPION) multiplier.
 * Non-Champion output is byte-identical to before: 0.1 * (1 - 0) = 0.1.
 *
 * SCOPE / SAFETY
 * --------------
 * Touches the Burn AEs that carry the DoT row: the world Debuff hub (the
 * canonical "Burn" every fire skill applies by ae_template_ref) + any embedded
 * copy that has its own DoT row (currently Jack). Matches a deal_damage row
 * whose formula reads MAX_HP and does NOT already reference RANK_IS_CHAMPION —
 * so it's drift-safe + idempotent on re-run and won't double-halve. Wraps the
 * existing amount expression, preserving any co-dev-tuned base rate.
 *
 * RUN ONCE (NOT manifest-tagged idempotent) so it won't re-apply over a co-dev's
 * later edits. Burn lives on co-dev world data; sharing is via WORLD-DATA PUSH
 * (feedback_world_data_sharing_hazard).
 */

export const key = "2026-07-04-burn-champion-halved";
export const description =
  "Burn DoT is halved vs Champions: ceil(MAX_HP*0.1) -> ceil(MAX_HP*0.1*(1 - 0.5*RANK_IS_CHAMPION)). " +
  "Patches the Burn AE's burn_dmg deal_damage row on the Debuff hub + embedded copies.";

const NS = "fabula-ultima-companion";
const CHAMP = "RANK_IS_CHAMPION";

// If `expr` is a single outer ceil(...) wrap with balanced inner parens, return
// the inner expression; else return null. Lets us re-wrap ONE ceil around the
// rank-scaled amount instead of nesting ceil(ceil(...)).
function unwrapOuterCeil(expr) {
  const m = /^\s*ceil\s*\(([\s\S]*)\)\s*$/.exec(expr);
  if (!m) return null;
  let depth = 0;
  const inner = m[1];
  for (const ch of inner) {
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth < 0) return null; } // ")" closes the ceil early → not a single wrap
  }
  return depth === 0 ? inner.trim() : null;
}

async function patchBurnAe(ae, where, log) {
  const rc = foundry.utils.deepClone(ae.flags?.[NS]?.reactionConfig ?? {});
  const et = rc.effect_table ?? rc.reaction_effect_table;
  if (!et || typeof et !== "object") return 0;
  let changed = false;
  for (const r of Object.values(et)) {
    if (!r || r.effect_kind !== "deal_damage") continue;
    const tref = String(r.target_ref ?? "self").trim() || "self";
    if (tref !== "self") continue;                              // only the self-tick DoT
    const amt = r.damage_amount;
    if (typeof amt !== "string" || !/MAX_HP/.test(amt)) continue;
    if (new RegExp(CHAMP).test(amt)) continue;                  // already rank-aware → skip
    // Scale the amount by (1 - 0.5*RANK_IS_CHAMPION) — half for Champions, full
    // otherwise — keeping any co-dev-tuned base rate. Re-wrap a SINGLE ceil so
    // the canonical ceil(MAX_HP * 0.1) becomes the clean rank-aware form rather
    // than a nested ceil(ceil(...)).
    const inner = unwrapOuterCeil(amt) ?? amt.trim();
    r.damage_amount = `ceil((${inner}) * (1 - 0.5 * ${CHAMP}))`;
    changed = true;
  }
  if (!changed) return 0;
  await ae.update({ [`flags.${NS}.-=reactionConfig`]: null });
  await ae.update({ [`flags.${NS}.reactionConfig`]: rc });
  log(`  [${where}] Burn burn_dmg → Champion-halved`);
  return 1;
}

export async function migrate(game, log = () => {}) {
  let changed = 0;
  for (const it of (game.items?.contents ?? []))
    for (const ae of it.effects)
      if (ae.name === "Burn") changed += await patchBurnAe(ae, `world/${it.name}`, log);
  for (const actor of (game.actors?.contents ?? []))
    for (const it of actor.items)
      for (const ae of it.effects)
        if (ae.name === "Burn") changed += await patchBurnAe(ae, `${actor.name}/${it.name}`, log);
  return { applied: true, summary: `Burn DoT halved vs Champions: ${changed} AE(s)` };
}
