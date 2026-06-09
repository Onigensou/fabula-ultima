/**
 * Migration: 2026-06-09-grappling-reciprocal-author
 * ---------------------------------------------------------------------------
 * Grappled "shared space" splash (rule #1 of the Grappled Advanced Debuff).
 * Two pieces, both on the shared status hub Item that holds the "Grappled" AE:
 *
 *  1. Mark the "Grappled" template with `flags.fabula-ultima-companion.
 *     reciprocalAe = "Grappling"`. skill-effects.applyApplyAeEffect reads this
 *     and — inside the supervised apply flow — also applies the named AE to the
 *     APPLIER (the grappler). So whoever inflicts Grappled automatically gains
 *     "Grappling", with no per-skill authoring (works for any grapple skill).
 *
 *  2. Author the "Grappling" AE: a creature_targeted_by_action / source:self /
 *     harmful / FORCE reaction whose add_target row resolves `grappled_by_self`.
 *     When the grappler is attacked, its grappled victim(s) are spliced into the
 *     attacker's action (card-mutations.js add_target Phase 3), sharing the
 *     locked roll. The targeting source excludes the attacker, so a grappled
 *     unit attacking its own grappler doesn't splash onto itself.
 *
 * Matches the hub by the presence of a "Grappled" AE (NAME-based) so it
 * self-heals on a co-dev's world regardless of the hub Item UUID. IDEMPOTENT:
 * re-runs as a no-op once the marker + AE are in place. See
 * [[project_grappled_advanced_debuff]].
 */

export const key = "2026-06-09-grappling-reciprocal-author";
export const description =
  "Grappled shared-space splash: mark Grappled reciprocalAe→Grappling and " +
  "author the Grappling AE (creature_targeted_by_action force add_target → " +
  "grappled_by_self) on the status hub.";

const NS = "fabula-ultima-companion";
const GRAPPLING_ICON = "icons/svg/net.svg";

// Reaction config — AE shape (reaction_config_table + reaction_effect_table),
// matching the live convention (e.g. Acceleration). FORCE = engine-mandatory,
// UI-invisible (RAW: the shared-space rule is automatic, not a "may").
const GRAPPLING_REACTION_CONFIG = {
  name: "Grappling",
  reaction_config_table: {
    "0": {
      $deleted: false,
      reaction_trigger: "creature_targeted_by_action",
      reaction_source: "self",
      reaction_action_intent: "harmful",
      reaction_effect_ref: "grappling_splash",
      reaction_passive_mode: "force",
    },
  },
  reaction_effect_table: {
    "0": {
      $deleted: false,
      effect_label: "grappling_splash",
      effect_kind: "add_target",
      // Inline targeting sugar — the grappler's grappled victim(s); the
      // collector excludes the attacker (rule: "someone OTHER than the
      // grappled unit"). Resolved by skill-targeting collectGrappledBySelf.
      target_ref: { candidate_source: "grappled_by_self", mode: "all" },
    },
  },
};

const GRAPPLING_AE = (img) => ({
  name: "Grappling",
  img,
  icon: img,
  description: "<p><em>Grappling:</em> You hold a foe in your grip — attacks against you also strike whoever you hold.</p>",
  transfer: false,
  disabled: false,
  statuses: ["fud-grappling"],
  duration: { startTime: null, seconds: null, combat: null, rounds: null, turns: null, startRound: null, startTurn: null },
  flags: {
    [NS]: {
      // Persist until the grapple ends (break-free / scene sweep) rather than
      // ticking on a turn schedule. Removal is handled supervised in
      // grappled.breakFree / the scene-end sweep.
      directorPermanent: true,
      reactionConfig: GRAPPLING_REACTION_CONFIG,
    },
    core: { statusId: "fud-grappling" },
  },
  system: { tags: [] },
});

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

export async function migrate(game, log = () => {}) {
  let touched = 0;
  for (const item of game.items?.contents ?? []) {
    const effects = item.effects?.contents ?? [];
    const grappled = effects.find((e) => String(e.name ?? "").trim().toLowerCase() === "grappled");
    if (!grappled) continue;

    // 1. reciprocalAe marker on Grappled.
    if (grappled.flags?.[NS]?.reciprocalAe !== "Grappling") {
      await grappled.update({ [`flags.${NS}.reciprocalAe`]: "Grappling" });
      touched++;
      log(`  "${item.name}"/Grappled: reciprocalAe → "Grappling"`);
    }

    // 2. Grappling AE on the same hub (create-if-missing + drift-correct).
    const img = grappled.img ?? grappled.icon ?? GRAPPLING_ICON;
    const existing = effects.find((e) => String(e.name ?? "").trim().toLowerCase() === "grappling");
    if (!existing) {
      await item.createEmbeddedDocuments("ActiveEffect", [GRAPPLING_AE(img)]);
      touched++;
      log(`  "${item.name}": created "Grappling" AE`);
    } else {
      const curRC = existing.flags?.[NS]?.reactionConfig ?? null;
      const permOk = existing.flags?.[NS]?.directorPermanent === true;
      if (!deepEqual(curRC, GRAPPLING_REACTION_CONFIG) || !permOk) {
        await existing.update({
          [`flags.${NS}.reactionConfig`]: GRAPPLING_REACTION_CONFIG,
          [`flags.${NS}.directorPermanent`]: true,
        });
        touched++;
        log(`  "${item.name}"/Grappling: reactionConfig + directorPermanent drift-corrected`);
      }
    }
  }
  return { applied: true, summary: `Grappling reciprocal authored (touched: ${touched})` };
}
