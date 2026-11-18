/**
 * Migration: 2026-11-18-botc-minion-soldier-hp  (Necromancer, Birth of the Cruel)
 * ---------------------------------------------------------------------------
 * Report: reports/2026-11-18-botc-minion-soldier-rules.md
 *
 * Birth of the Cruel turns the corpse into a SOLDIER. A soldier's HP is fixed by
 * the Core Rulebook (p. 303, step 7): 2 × level + 5 × base Might die. The old
 * override halved the sheet HP, which is only a soldier for a book-built elite
 * (HP = soldier × 2). Our house elites sit far above ×2, so Gigas (800) came out
 * at 400 where a level-45, Might-d12 soldier has 150. User ruling 2026-11-18:
 * switch to the formula. MP stays as it is (elite rank never touched MP).
 *
 * Three things, every copy (world Items, actor items, unlinked token items):
 *   1. botc_summon.summon_overrides  max_hp / current_hp → the soldier formula.
 *      A soldier corpse keeps its own sheet HP. The overrides are evaluated
 *      against the clone BEFORE npc_rank is overwritten, so RANK_IS_SOLDIER
 *      reads the corpse's original rank (the old formula relied on the same).
 *   2. The description's Rank bullet, that one <li> only.
 *   3. Minions that already exist (isPersistentSummon + kind "minion") whose
 *      source creature is not a soldier: max HP → the formula, current HP
 *      clamped to it. The source is found by name (clone name minus the
 *      " (Reanimated)" suffix); a Minion whose source cannot be found is left
 *      alone and logged.
 *
 * IDEMPOTENT: rows already carrying the formula, text already rewritten, and
 * Minions already at or under the soldier HP are skipped.
 */

export const key = "2026-11-18-botc-minion-soldier-hp";
export const description =
  "Birth of the Cruel: Minion max HP = soldier formula (2×level + 5×MIG die) instead of half the " +
  "sheet HP — overrides, Rank text, and existing Minions.";

const NS = "fabula-ultima-companion";
const SKILL_NAME = "Birth of the Cruel";
const SOLDIER_HP = "=RANK_IS_SOLDIER*MAX_HP + (1-RANK_IS_SOLDIER)*(2*CHAR_LEVEL + 5*MIG_BASE_DIE)";

const OLD_RANK_LI_RE = /<li>Its <strong>Rank<\/strong> becomes <strong>soldier<\/strong>;[\s\S]*?<\/li>/;
const NEW_RANK_LI =
  "<li>Its <strong>Rank</strong> becomes <strong>soldier</strong>; if the original creature was an " +
  "<strong>elite</strong> or <strong>champion</strong>, its <strong>maximum HP</strong> becomes a soldier's: " +
  "<strong>【twice its level + five times its base Might die】</strong> (<strong>Skills are maintained</strong>). " +
  "Its MP is unchanged.</li>";

export function soldierHp(props) {
  const lvl = Number(props?.level) || 0;
  const mig = Number(props?.mig_base) || 0;
  return 2 * lvl + 5 * mig;
}

export function rewriteOverrides(raw) {
  let ov;
  try { ov = typeof raw === "string" ? JSON.parse(raw) : { ...(raw ?? {}) }; } catch { return null; }
  if (!ov || typeof ov !== "object") return null;
  if (ov.max_hp === SOLDIER_HP && ov.current_hp === SOLDIER_HP) return null;
  ov.max_hp = SOLDIER_HP;
  ov.current_hp = SOLDIER_HP;
  return JSON.stringify(ov);
}

export function rewriteDescription(html) {
  const s = String(html ?? "");
  if (!s || s.includes("five times its base Might die")) return null;
  if (!OLD_RANK_LI_RE.test(s)) return null;
  return s.replace(OLD_RANK_LI_RE, NEW_RANK_LI);
}

async function fixSkillCopies(items, where, log) {
  let rows = 0, texts = 0;
  for (const it of items ?? []) {
    if (String(it?.name ?? "").trim() !== SKILL_NAME) continue;
    const props = it.system?.props ?? {};
    const update = {};
    for (const [rk, row] of Object.entries(props.effect_table ?? {})) {
      if (row?.effect_label !== "botc_summon") continue;
      const next = rewriteOverrides(row.summon_overrides);
      if (next != null) { update[`system.props.effect_table.${rk}.summon_overrides`] = next; rows += 1; }
    }
    const desc = rewriteDescription(props.description);
    if (desc != null) { update["system.props.description"] = desc; texts += 1; }
    if (!Object.keys(update).length) continue;
    try { await it.update(update); log(`  ${where}: ${it.name} updated`); }
    catch (e) { log(`  ${where}: ${it.name} failed — ${e?.message ?? e}`); }
  }
  return { rows, texts };
}

async function fixExistingMinions(game, log) {
  let fixed = 0;
  const actors = game.actors?.contents ?? [];
  for (const a of actors) {
    const f = a.flags?.[NS] ?? {};
    if (f.isPersistentSummon !== true || f.persistentSummonKind !== "minion") continue;
    const srcName = String(a.name ?? "").replace(/\s*\(Reanimated\)\s*$/, "").trim();
    const src = actors.find((x) => x.name === srcName && x.flags?.[NS]?.isPersistentSummon !== true);
    if (!src) { log(`  Minion ${a.name}: source "${srcName}" not found — left as is`); continue; }
    const rank = String(src.system?.props?.npc_rank ?? "").trim().toLowerCase();
    if (!rank || rank === "soldier") continue;
    const target = soldierHp(src.system?.props);
    if (!(target > 0)) continue;
    const curMax = Number(a.system?.props?.max_hp) || 0;
    const curHp = Number(a.system?.props?.current_hp) || 0;
    if (curMax <= target) continue;
    try {
      await a.update({ "system.props.max_hp": target, "system.props.current_hp": Math.min(curHp, target) });
      log(`  Minion ${a.name}: max HP ${curMax} → ${target}`);
      fixed += 1;
    } catch (e) { log(`  Minion ${a.name} failed — ${e?.message ?? e}`); }
  }
  return fixed;
}

export async function migrate(game, log) {
  let rows = 0, texts = 0;
  const add = (r) => { rows += r.rows; texts += r.texts; };
  add(await fixSkillCopies(game.items?.contents ?? [], "world", log));
  for (const a of game.actors?.contents ?? []) add(await fixSkillCopies(a.items?.contents ?? [], a.name, log));
  for (const sc of game.scenes?.contents ?? []) {
    for (const t of sc.tokens?.contents ?? []) {
      if (t.actorLink || !t.actor) continue;
      add(await fixSkillCopies(t.actor.items?.contents ?? [], `${sc.name}/${t.name}`, log));
    }
  }
  const minions = await fixExistingMinions(game, log);
  return {
    applied: true,
    summary: `Birth of the Cruel soldier HP — ${rows} override row(s), ${texts} description(s), ${minions} existing Minion(s)`,
  };
}
