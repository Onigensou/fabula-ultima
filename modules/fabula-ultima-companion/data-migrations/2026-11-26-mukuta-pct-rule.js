/**
 * Migration: 2026-11-26-mukuta-pct-rule
 * ---------------------------------------------------------------------------
 * Puts Mukuta (Deva's stealable accessory, 2026-11-25-trio-elite-steals) on the
 * approved Max HP / MP % rule (scripts/shared/stat-rules.js, rule 1):
 *
 *   - its two ×1.12 effects drop their explicit priority 50, so they apply at the
 *     normal MULTIPLY step — on the sheet's BASE, before flat bonuses — and add
 *     together with any other Max HP / MP % source;
 *   - the `roundUp` flag goes: the % rule floors, like every other % item.
 *
 * The "6% more damage" passive is untouched. Decided by the user 2026-11-26.
 *
 * Scope: the world item AND every embedded copy (Deva, anyone who stole it), matched
 * by the effects' fixed ids or, for copies whose ids were re-rolled, by item + effect
 * name. One-time; also idempotent (a fixed effect has nothing left to change).
 */

export const key = "2026-11-26-mukuta-pct-rule";
export const description = "Mukuta: Max HP/MP ×1.12 effects follow the additive % rule (no priority 50, no round-up).";

const NS = "fabula-ultima-companion";
const AE_IDS = new Set(["TrElMukutaHpAE01", "TrElMukutaMpAE01"]);
const AE_NAMES = new Set(["Mukuta (Max HP)", "Mukuta (Max MP)"]);

function fixFor(item) {
  const updates = [];
  for (const eff of item.effects ?? []) {
    if (!AE_IDS.has(eff.id) && !(item.name === "Mukuta" && AE_NAMES.has(eff.name))) continue;
    const changes = (eff.changes ?? []).map((c) => {
      const out = { ...c };
      if ((c.key === "max_hp" || c.key === "max_mp") && Number(c.mode) === 1 && c.priority != null) out.priority = null;
      return out;
    });
    const prioChanged = changes.some((c, i) => c.priority !== (eff.changes[i]?.priority ?? null));
    const hasRoundUp = eff.flags?.[NS]?.roundUp != null;
    if (!prioChanged && !hasRoundUp) continue;
    const u = { _id: eff.id, changes };
    if (hasRoundUp) u[`flags.${NS}.-=roundUp`] = null;
    updates.push(u);
  }
  return updates;
}

export async function migrate(game, log = () => {}) {
  let fixed = 0;
  const carriers = [
    ...(game.items?.contents ?? []).map((i) => ["world", i]),
    ...(game.actors?.contents ?? []).flatMap((a) => (a.items?.contents ?? []).map((i) => [a.name, i])),
  ];
  for (const [where, item] of carriers) {
    if (item.name !== "Mukuta" && !(item.effects ?? []).some((e) => AE_IDS.has(e.id))) continue;
    const updates = fixFor(item);
    if (!updates.length) continue;
    await item.updateEmbeddedDocuments("ActiveEffect", updates);
    fixed += updates.length;
    log(`  • ${where} › ${item.name}: ${updates.length} effect${updates.length === 1 ? "" : "s"} put on the % rule`);
  }
  return { applied: true, summary: fixed ? `${fixed} Mukuta effect(s) now follow the additive % rule` : "Mukuta already on the % rule (nothing to change)" };
}
