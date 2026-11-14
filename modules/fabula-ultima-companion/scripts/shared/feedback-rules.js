// ============================================================================
// Feedback layer — the pure rules (no DOM, no Foundry).
// Runtime: feedback.js. Tests: feedback-rules.test.mjs.
//
// What players are shown when a status lands or damage is dealt, worked out
// from the results the APIs return. Agreed with the user 2026-11-14
// (mockup https://claude.ai/artifact/Ng4yf9Eiss65fjwtKRBDcs).
// ============================================================================

// How results are collected into one batch (one Apply = one set of lines): the
// batch closes BATCH_MS after the LAST result, never later than BATCH_MAX_MS
// after the first. An Apply writes statuses / damage one by one (database
// round-trips), so a fixed window split one Apply into several lines.
export const BATCH_MS = 250;
export const BATCH_MAX_MS = 1500;

// Status entry kinds. A line never mixes kinds, so "until the next battle" is
// always true for every name on it.
export const STATUS_KINDS = Object.freeze(["inflict", "held", "buff", "immune", "removed"]);

const join = (xs) => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/**
 * entries: [{ actorId, actorName, status, kind }]
 * partyIds: ids of the current party members (all of them on one line → "The party")
 * → System Message lines, in FU.SystemMessage markup ({st:} status + icon, {p:} party).
 *
 *   Zarg is inflicted with Slow!
 *   Hina and Zarg are inflicted with Slow and Dazed until the next battle!
 *   The party gains Swift!
 *   Keren is immune to Slow.
 *   Hina and Zarg recover from Slow!
 */
export function statusLines(entries = [], partyIds = []) {
  const party = new Set((partyIds ?? []).map(String));
  const byKind = new Map();
  for (const e of entries ?? []) {
    const kind = STATUS_KINDS.includes(e?.kind) ? e.kind : "inflict";
    const id = String(e?.actorId ?? e?.actorName ?? "");
    const status = String(e?.status ?? "").trim();
    if (!id || !status) continue;
    if (!byKind.has(kind)) byKind.set(kind, new Map());
    const byActor = byKind.get(kind);
    if (!byActor.has(id)) byActor.set(id, { name: String(e.actorName ?? id), statuses: [] });
    const a = byActor.get(id);
    if (!a.statuses.includes(status)) a.statuses.push(status);
  }
  const lines = [];
  for (const kind of STATUS_KINDS) {
    const byActor = byKind.get(kind);
    if (!byActor) continue;
    // members who got exactly the same statuses share a line
    const sets = new Map();
    for (const [id, a] of byActor) {
      const key = [...a.statuses].sort().join("|");
      if (!sets.has(key)) sets.set(key, { ids: [], names: [], statuses: a.statuses });
      sets.get(key).ids.push(id);
      sets.get(key).names.push(a.name);
    }
    for (const { ids, names, statuses } of sets.values()) {
      const whole = party.size > 1 && ids.length === party.size && ids.every((id) => party.has(id));
      const who = whole ? "{p:The party}" : join(names);
      const many = !whole && names.length > 1;
      const what = join(statuses.map((s) => `{st:${s}}`));
      if (kind === "immune") lines.push(`${who} ${many ? "are" : "is"} immune to ${what}.`);
      else if (kind === "removed") lines.push(`${who} ${many ? "recover" : "recovers"} from ${what}!`);
      else if (kind === "buff") lines.push(`${who} ${many ? "gain" : "gains"} ${what}!`);
      else lines.push(`${who} ${many ? "are" : "is"} inflicted with ${what}${kind === "held" ? " until the next battle" : ""}!`);
    }
  }
  return lines;
}

/**
 * ONE sound for a status batch — battle's generic beats (action-anim-rules.js
 * SFX: buff/cleanse = "up" Powerup, debuff = "down" Down2). Anything inflicted
 * wins; immune-only batches are silent.
 * → "down" | "up" | null
 */
export function statusSound(kinds = []) {
  const k = new Set(kinds ?? []);
  if (k.has("inflict") || k.has("held")) return "down";
  if (k.has("buff") || k.has("removed")) return "up";
  return null;
}

// Damage sounds: the damage API's own set (apply-damage-core.js _SFX).
const SFX_ROOT = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
export const DAMAGE_SFX = Object.freeze({
  hit: `${SFX_ROOT}HitSlashM.wav`,
  weak: `${SFX_ROOT}Hit_SlashingB.wav`,
  resist: `${SFX_ROOT}Soundboard/Parry.ogg`,
  heal: `${SFX_ROOT}Heal3.ogg`,
  mpLoss: `${SFX_ROOT}Dispel%20Magic.ogg`,
  mpGain: `${SFX_ROOT}AbsorbElement.ogg`,
});

/**
 * ONE sound for a whole batch; the strongest result wins.
 * kind: "damage" | "heal"; resource: "hp" | "mp"; affinities: per member ("VU"|"RS"|"IM"|"AB"|"NE"|null)
 */
export function damageSound({ kind = "damage", resource = "hp", affinities = [] } = {}) {
  if (resource === "mp") return kind === "heal" ? DAMAGE_SFX.mpGain : DAMAGE_SFX.mpLoss;
  if (kind === "heal") return DAMAGE_SFX.heal;
  const aff = (affinities ?? []).map((a) => String(a ?? "NE").toUpperCase());
  if (aff.includes("VU")) return DAMAGE_SFX.weak;
  if (aff.some((a) => !["RS", "IM", "AB"].includes(a))) return DAMAGE_SFX.hit;
  if (aff.includes("RS")) return DAMAGE_SFX.resist;
  return null;   // everyone immune or absorbed: silence
}

/** The screen flash colour key: the element on an HP hit, else recovery / MP. */
export function flashKey({ kind = "damage", resource = "hp", element = "physical" } = {}) {
  if (resource === "mp") return kind === "heal" ? "mpGain" : "mpLoss";
  if (kind === "heal") return "heal";
  return String(element || "physical").toLowerCase();
}

/** Resource Panel tag for a member's affinity on an HP hit. */
export function affinityTag(affinity) {
  switch (String(affinity ?? "").toUpperCase()) {
    case "VU": return "weak";
    case "RS": return "resist";
    case "IM": return "immune";
    case "AB": return "absorb";
    default: return null;
  }
}
