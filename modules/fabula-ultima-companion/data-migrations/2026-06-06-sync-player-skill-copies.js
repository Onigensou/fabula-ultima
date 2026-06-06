/**
 * Migration: 2026-06-06-sync-player-skill-copies
 * ---------------------------------------------------------------------------
 * Replace LEGACY skill copies on the 4 player actors with their BD-master
 * mechanics ("use the BD version, for what is already made").
 *
 * Root cause this fixes: BD masters are correctly authored, but actor copies
 * are stale/empty (CSB doesn't propagate effect_table/reaction_config, and the
 * author-migration ledger marks them "done" so they never re-sync). Surfaced
 * live: Zarg's Hawkeye copy was completely empty while the master was fully
 * wired. See [[feedback_master_update_doesnt_sync_actor_copies]].
 *
 * What it syncs (master -> copy), ONLY where the master value is MEANINGFUL
 * (non-empty), so display-stub masters never degrade a richer copy:
 *   - effect_table, reaction_config_table        (delete-then-set; Foundry
 *                                                  merges by key otherwise)
 *   - recipe, post_damage_effect_ref, on_activate_effect_ref, skill_target
 *   - isReaction — only pushed when master === true (isOffensiveSpell is NOT
 *     synced: it only drives intent and some masters carry it inconsistently)
 *   - embedded AEs the copy LACKS (created by name, full data shape)
 *
 * What it PRESERVES (per-actor / identity / legacy — never touched):
 *   - level, damage_bonus (per-actor SL + derived), and every display field
 *     (cost/duration/skill_range/skill_type/animation*)
 *   - custom_logic_* (legacy, reference-only, not executed by BD)
 *   - uniqueId / template / the copy's own id
 *
 * Master match: by system.uniqueId first, else by name; the master must be
 * "wired" (has an effect_table / reaction_config_table / mechanical AE).
 *
 * Scope: the 4 player actors only (Keren, Hina, Blanche, Zarg).
 * IDEMPOTENT: re-runs no-op once copies match. Returns a per-skill change log.
 */

export const key = "2026-06-06-sync-player-skill-copies";
export const description =
  "Sync the 4 players' skill copies from their BD masters (mechanical surface " +
  "+ missing AEs; preserves per-actor SL / display / legacy logic).";

const PLAYERS = ["Keren", "Hina", "Blanche", "Zarg"];
const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT = "Battle Director";

// Mechanical fields synced only where the master value is meaningful.
const TABLE_FIELDS = ["effect_table", "reaction_config_table"];
const STRING_FIELDS = ["recipe", "post_damage_effect_ref", "on_activate_effect_ref", "skill_target"];
// Only isReaction is pushed (when master === true). isOffensiveSpell is
// deliberately NOT synced: it only drives intent classification (true =>
// "harmful"/enemy-targeted), and some masters carry it inconsistently on
// self/passive skills (Agony, Heart of Darkness) — propagating it would
// mis-target a working skill. Leave routing flags to per-skill authoring.
const BOOL_TRUE_FIELDS = ["isReaction"]; // pushed only when master === true

function inBD(item) {
  let f = item?.folder;
  while (f) { if (f.name === BD_ROOT && !(f.folder?.id ?? f.folder)) return true; f = f.folder; }
  return false;
}
function hasRows(t) { return !!t && typeof t === "object" && Object.keys(t).length > 0; }
function aeMechanical(it) {
  return (it?.effects?.contents ?? []).some((e) => {
    if ((e.changes?.length ?? 0) > 0) return true;
    const rc = e.flags?.[MODULE_ID]?.reactionConfig;
    return rc && (Array.isArray(rc) ? rc.length : Object.keys(rc).length);
  });
}
function isWired(it) {
  const p = it?.system?.props ?? {};
  return hasRows(p.effect_table) || hasRows(p.reaction_config_table) || aeMechanical(it);
}
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
const eq = (a, b) => stableStringify(a) === stableStringify(b);

export async function migrate(game, log = () => {}) {
  // Master indices.
  const byUid = new Map(), byNameBD = new Map(), byNameAny = new Map();
  for (const it of game.items?.contents ?? []) {
    const uid = String(it.system?.uniqueId ?? "").trim();
    if (uid && !byUid.has(uid)) byUid.set(uid, it);
    if (!byNameAny.has(it.name)) byNameAny.set(it.name, it);
    if (inBD(it) && !byNameBD.has(it.name)) byNameBD.set(it.name, it);
  }
  const findMaster = (copy) => {
    const uid = String(copy.system?.uniqueId ?? "").trim();
    let m = uid ? byUid.get(uid) : null;
    if (m && m.id !== copy.id) return m;
    m = byNameBD.get(copy.name) ?? byNameAny.get(copy.name);
    return (m && m.id !== copy.id) ? m : null;
  };

  const report = [];
  let copiesTouched = 0, backup = [];

  for (const name of PLAYERS) {
    const actor = game.actors?.getName?.(name);
    if (!actor) { log(`actor "${name}" not found`); continue; }
    for (const copy of actor.items?.contents ?? []) {
      if (!/skill|spell|active|passive|arcana|heroic/i.test(String(copy.system?.props?.skill_type ?? ""))) continue;
      const master = findMaster(copy);
      if (!master || !isWired(master)) continue;
      const mp = master.system?.props ?? {}, cp = copy.system?.props ?? {};

      const setUpdate = {};
      const delThenSet = [];   // table fields needing delete-then-set
      const changed = [];

      for (const f of TABLE_FIELDS) {
        if (hasRows(mp[f]) && !eq(mp[f], cp[f])) { delThenSet.push(f); changed.push(f); }
      }
      for (const f of STRING_FIELDS) {
        const mv = mp[f];
        if (typeof mv === "string" && mv.trim() !== "" && mv !== cp[f]) { setUpdate[`system.props.${f}`] = mv; changed.push(f); }
      }
      for (const f of BOOL_TRUE_FIELDS) {
        if (mp[f] === true && cp[f] !== true) { setUpdate[`system.props.${f}`] = true; changed.push(f); }
      }

      // Embedded AEs the copy LACKS (by name).
      const copyAENames = new Set((copy.effects?.contents ?? []).map((e) => e.name));
      const aeCreates = [];
      for (const mAE of (master.effects?.contents ?? [])) {
        if (copyAENames.has(mAE.name)) continue;
        const data = mAE.toObject(false);
        delete data._id;
        aeCreates.push(data);
      }

      if (!changed.length && !aeCreates.length) continue;

      // Backup pre-sync state (reversibility).
      backup.push({
        actor: name, skill: copy.name, uuid: copy.uuid,
        before: {
          effect_table: foundry.utils.deepClone(cp.effect_table ?? null),
          reaction_config_table: foundry.utils.deepClone(cp.reaction_config_table ?? null),
          ...Object.fromEntries([...STRING_FIELDS, ...BOOL_TRUE_FIELDS].map((f) => [f, cp[f] ?? null])),
          aeNames: [...copyAENames],
        },
      });

      try {
        for (const f of delThenSet) {
          await copy.update({ [`system.props.-=${f}`]: null });
          await copy.update({ [`system.props.${f}`]: foundry.utils.deepClone(mp[f]) });
        }
        if (Object.keys(setUpdate).length) await copy.update(setUpdate);
        if (aeCreates.length) await copy.createEmbeddedDocuments("ActiveEffect", aeCreates);
        copiesTouched++;
        report.push({ actor: name, skill: copy.name, props: changed, aeCreated: aeCreates.map((a) => a.name) });
        log(`  ${name} / ${copy.name}: props[${changed.join(",") || "-"}] AEs[${aeCreates.map((a) => a.name).join(",") || "-"}]`);
      } catch (e) {
        log(`  ${name} / ${copy.name}: FAILED ${e?.message ?? e}`);
      }
    }
  }

  return { applied: true, summary: `synced ${copiesTouched} player skill copy/copies`, report, backup };
}
