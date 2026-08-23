// BD-native Battle Log surface — director-supervised port of the legacy
// `BattleLog: Append` macro chain (Miss.js / AdvanceDamage.js / apply-damage-core
// → battleLogBatch → BattleLog: Append). The BD never participated in that
// chain, so BD-applied damage/heal/miss never reached the GM's battle log. This
// re-feeds the SAME storage (the "DB actor"'s `battle_log` JSON + `battle_log_table`
// rows) in the SAME shape, so the existing sheet table + Battle End summary render
// unchanged — but the WRITE is owned by the BD (one direct `dbActor.update`, no
// macro hop, inside the dispatch lock).
//
// Design (see the damage-unification + battle-log discussion):
//   - ONE damage/heal seam: applyDamageToTarget builds a row per commit and
//     pushes it to a caller-owned SINK (an array). Misses have no commit, so the
//     attack RESOLVE loop pushes Miss rows to the same sink.
//   - The owning action flushes the sink ONCE → a Multi-N action = ONE write,
//     not N. resolveAction owns the sink for attacks/skills (+ their riders);
//     a standalone deal_damage (Burn tick) owns its own sink.
//
// Storage (ported from BattleLog: Append):
//   - `system.props.battle_log`        — JSON string array of rich entries (audit)
//   - `system.props.battle_log_table`  — flat row array (the rendered table)
//   Both capped at the last MAX entries.

import { log, warn } from "./logger.js";
import { displayElement } from "./skill-formulas.js";

const MAX = 30;

// Affinity code → human label, mirroring the legacy _affinityLabel map.
const AFFINITY_LABEL = { NE: "Normal", RS: "Resisted", VU: "Vulnerable", IM: "Immune", AB: "Absorbed" };
const VALUE_TYPE_LABEL = { hp: "HP", mp: "MP", shield: "Shield" };

function _cap(s) {
  const v = String(s ?? "").trim();
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : v;
}
function _affLabel(code) { return AFFINITY_LABEL[code] ?? "Normal"; }

// ── DB-actor resolution (ported from BattleLog: Append) ────────────────────
// Preferred: the module's DB resolver; fallback: the fixed "Current Game" actor
// → its `game_id` → the storage actor. Not cached — one fromUuid per flush is
// cheap and avoids a stale handle after a world/DB swap.
async function getBattleLogDbActor() {
  try {
    const api = globalThis.FUCompanion?.api;
    if (api?.getCurrentGameDb) {
      const res = await api.getCurrentGameDb();
      if (res?.db) return res.db;
    }
  } catch (e) { warn("director-battle-log: getCurrentGameDb failed", e); }
  try {
    const cur = await fromUuid("Actor.DMpK5Bi119jIrCFZ");
    const id = cur?.system?.props?.game_id;
    if (id) {
      const db = await fromUuid(id);
      if (db) return db;
    }
  } catch (e) { warn("director-battle-log: Current Game → game_id resolve failed", e); }
  return null;
}

function _parseExistingLog(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    } catch (_e) { return []; }
  }
  return [];
}

function _normalizeTable(table) {
  if (Array.isArray(table)) return table.slice();
  if (table && typeof table === "object") return Object.values(table);
  return [];
}

// ── The single write ───────────────────────────────────────────────────────
// `records` = array of { entry, row }. GM-only (the director runs GM-side; one
// writer avoids dup appends). Caps each field to the last MAX. One update.
export async function appendBattleLog(records) {
  if (!Array.isArray(records) || !records.length) return;
  if (!game.user?.isGM) return;
  const entries = records.map((r) => r?.entry).filter(Boolean);
  const rows = records.map((r) => r?.row).filter(Boolean);
  if (!entries.length && !rows.length) return;

  const db = await getBattleLogDbActor();
  if (!db) { warn("appendBattleLog: no DB actor (Current Game → game_id unset?)"); return; }

  const update = {};
  if (entries.length) {
    let logArr = _parseExistingLog(db.system?.props?.battle_log);
    logArr.push(...entries);
    if (logArr.length > MAX) logArr = logArr.slice(-MAX);
    // Serialize COMPACT. This blob is machine-read only (`_parseExistingLog`
    // JSON.parse's it; nothing renders it raw — the sheet table is the separate
    // `battle_log_table`), so the 2-space indent was pure overhead on a value
    // rewritten in full on every flush. Measured on a 30-entry log: 23,996 →
    // 15,970 chars (-33%), and the DB-actor update cycle 460 → 386 ms (-16%),
    // since the whole prop is re-serialized, diffed, persisted and re-derived
    // each time. Also shrinks every world-data commit that carries this actor.
    // JSON.parse is format-agnostic, so old pretty-printed logs still load.
    update["system.props.battle_log"] = JSON.stringify(logArr);
  }
  if (rows.length) {
    let table = _normalizeTable(db.system?.props?.battle_log_table);
    table.push(...rows);
    if (table.length > MAX) table = table.slice(-MAX);
    update["system.props.battle_log_table"] = table;
  }
  if (!Object.keys(update).length) return;
  try {
    await db.update(update);
    log(`battle-log: appended ${entries.length} entr${entries.length === 1 ? "y" : "ies"} / ${rows.length} row(s)`);
  } catch (e) { warn("appendBattleLog: dbActor.update failed", e); }
}

// ── Row builders (legacy entry/row shape) ──────────────────────────────────
// A damage OR heal record. apply_mode = "Healing" on a recover direction
// (AB-absorb), else "Damage". `bands` = { hp/mp/shield: { from, to } } actually
// committed. `value` = the applied amount (post-affinity). Missing attacker-side
// fields (weapon/efficiency/range) default to the legacy "—"/100% placeholders.
export function buildDamageRow({
  attackerName = "Unknown",
  targetName = "",
  targetDisposition = null,
  element = "elementless",
  resource = "hp",
  affinity = "NE",
  value = 0,
  valueDirection = "loss",
  bands = {},
  weaponType = null,
  efficiency = 100,
  range = null,
  accuracy = null,
  isCrit = false,
  sourceType = "None",
  noEffectReason = null,
} = {}) {
  const isHeal = valueDirection === "recover";
  const displayAmt = Math.abs(Number(value) || 0);
  const effLabel = _affLabel(affinity);
  const valueTypeLbl = VALUE_TYPE_LABEL[resource] ?? "HP";
  const tgtDisp = targetDisposition === 1 ? "ally" : targetDisposition === -1 ? "enemy" : "neutral";

  let summary;
  if (isHeal) summary = `${attackerName} heals ${targetName} for ${displayAmt} ${valueTypeLbl}`;
  else if (resource === "hp") summary = `${attackerName} deals ${displayAmt} ${displayElement(element)} damage to ${targetName} [${effLabel}]`;
  else summary = `${attackerName} deals ${displayAmt} damage to ${targetName}'s ${valueTypeLbl}`;

  const entry = {
    ts: new Date().toISOString(),
    accuracy: accuracy != null ? String(accuracy) : "-",
    dealer: { name: attackerName, disposition: "neutral", range: range ?? "None", sourceType },
    target: { name: targetName, disposition: tgtDisp },
    inputs: { isRecovery: isHeal, element, valueType: resource, weaponType, isCrit },
    computed: { finalValue: displayAmt, effectiveness: effLabel },
    result: {
      hp: bands.hp ?? null, mp: bands.mp ?? null, shield: bands.shield ?? null,
      affected: !noEffectReason, noEffectReason: noEffectReason ?? null,
    },
    summary,
  };

  const row = {
    $deleted: false,
    attacker: attackerName,
    attack_target: targetName,
    accuracy: entry.accuracy,
    value: noEffectReason ? "—" : String(displayAmt),
    value_type: valueTypeLbl,
    apply_mode: isHeal ? "Healing" : "Damage",
    damage_type: resource === "hp" ? _cap(element) : "—",
    affinity: effLabel,
    efficiency: resource === "hp" ? `${Math.round(efficiency)}%` : "100%",
    weapon_type: weaponType ? _cap(weaponType) : "—",
    range: range ?? "None",
    source_type: sourceType,
  };

  return { entry, row };
}

// A whiffed attack — no commit happened, so this is built by the attack RESOLVE
// loop, not the commit seam. apply_mode "Miss", value "—".
// `applyMode` exists so a row that is NOT a missed attack can still use this
// builder. The end-of-battle rank keys the party's accuracy statistic off
// `apply_mode` with `.includes("miss")` (battle-end-rank.js), so any row shaped
// as a Miss counts against the party's F–S grade. A GM emptying an action's
// target list has to leave a record, but it is an audit note about a table
// decision, not a shot the party fluffed — pass "No Targets" for those and the
// rank ignores the row while the log still shows it.
export function buildMissRow({
  attackerName = "Unknown",
  targetName = "",
  targetDisposition = null,
  element = "elementless",
  accuracy = null,
  weaponType = null,
  range = null,
  sourceType = "None",
  applyMode = "Miss",
  summary = null,
} = {}) {
  const tgtDisp = targetDisposition === 1 ? "ally" : targetDisposition === -1 ? "enemy" : "neutral";
  const entry = {
    ts: new Date().toISOString(),
    accuracy: accuracy != null ? String(accuracy) : "-",
    dealer: { name: attackerName, disposition: "neutral", range: range ?? "None", sourceType },
    target: { name: targetName, disposition: tgtDisp },
    inputs: { element, weaponType },
    // `miss` drives the log RENDERER's styling; a non-Miss mode is not a whiff.
    miss: applyMode === "Miss",
    summary: summary ?? `${attackerName} misses ${targetName}`,
  };
  const row = {
    $deleted: false,
    attacker: attackerName,
    attack_target: targetName,
    accuracy: entry.accuracy,
    value: "—",
    value_type: "HP",
    apply_mode: applyMode,
    damage_type: _cap(element),
    affinity: "—",
    efficiency: "—",
    weapon_type: weaponType ? _cap(weaponType) : "—",
    range: range ?? "None",
    source_type: sourceType,
  };
  return { entry, row };
}
