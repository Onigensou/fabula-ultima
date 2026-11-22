// ── Carrier attacks: a skill that IS an attack with the weapon that grants it ─
//
// "Perform an attack with this weapon" (Sonic Katar's Sonic Blow, 2026-11-21).
// The skill is picked from the Skill menu like any Active skill (it shows its
// cost there), but it resolves as ONE weapon Attack card: the carrier weapon's
// accuracy pair, damage, type, range and category (its active form included),
// plus the skill's own riders. Authored on the skill:
//
//   props.attack_with_carrier  true            — this skill is a carrier attack
//   props.check_bonus          "-2"            — added to the weapon's accuracy
//   props.action_keywords      "chain 8 volley" — merged with the weapon's own
//   props.cost                 "30 MP"         — charged like an NPC attack item's
//   flags.<ns>.carrierAttack = {
//     damageMult: 2,            the attack's damage ×; a Volley Chain shares it
//                               over its shots (action-profile)
//     critDamageMult: 1.5,      a Critical Success hit deals × this
//     noCritOpportunity: true,  a Critical Success grants no Opportunity
//     perfectMult: 1.5,         a Chain whose every strike lands: total × this
//   }
//
// The engine side: DECLARE rewrites the Skill bundle into an Attack bundle
// (attackMode "npc", the skill as the attack item — the path that already
// prices an attack item's printed cost), and TARGET builds the pseudo-weapon
// here instead of from the item's own attribute fields. The weapon's uuid stays
// the CARRIER's, so its on-hit rows (reaction_requires_weapon_used) still see
// "this weapon"; the skill is named on `animationItemUuid` / `npcAttackItemUuid`.
//
// Pure helpers (no Foundry globals) — carrier-attack.test.mjs.

const NS = "fabula-ultima-companion";

const truthy = (v) => v === true || v === 1 || ["true", "1", "yes"].includes(String(v ?? "").trim().toLowerCase());

export function isCarrierAttackSkill(item) {
  return !!item && truthy(item?.system?.props?.attack_with_carrier);
}

// The carrier weapon's snapshot among the turn snapshot's hands, by the skill's
// container id (an embedded skill's system.container = its weapon's id).
export function findCarrierWeaponSnapshot(skill, attacker) {
  const cid = String(skill?.system?.container ?? "").trim();
  if (!cid) return null;
  for (const w of [attacker?.weapon, attacker?.offWeapon]) {
    const u = String(w?.uuid ?? "");
    if (u && u.split(".").pop() === cid) return w;
  }
  return null;
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// The rider block, normalised. Missing = neutral.
export function carrierRiders(skill) {
  const f = skill?.flags?.[NS]?.carrierAttack ?? {};
  return {
    damageMult: Math.max(0, num(f.damageMult, 1)),
    critDamageMult: Math.max(0, num(f.critDamageMult, 1)),
    noCritOpportunity: truthy(f.noCritOpportunity),
    perfectMult: Math.max(0, num(f.perfectMult, 1)),
  };
}

// Build the attack's pseudo-weapon: the carrier snapshot + the skill's riders.
// Null when the skill is not a carrier attack or its weapon is not in hand.
export function buildCarrierAttackWeapon(skill, attacker) {
  if (!isCarrierAttackSkill(skill)) return null;
  const w = findCarrierWeaponSnapshot(skill, attacker);
  if (!w) return null;
  const p = skill.system?.props ?? {};
  const r = carrierRiders(skill);
  const kw = [w.actionKeywords, p.action_keywords].map((s) => String(s ?? "").trim()).filter(Boolean).join(", ");
  const target = String(p.skill_target ?? "").trim();
  return Object.freeze({
    ...w,
    hand: "npc",
    carrierHand: w.hand ?? null,
    name: String(skill.name ?? p.name ?? w.name),
    checkBonus: (Number(w.checkBonus) || 0) + (Number(p.check_bonus) || 0),
    actionKeywords: kw,
    skillTarget: target && target !== "-" ? target : (w.skillTarget ?? ""),
    imageUrl: skill.img ?? w.imageUrl ?? null,
    descriptionHtml: String(p.description ?? ""),
    npcAttackItemUuid: skill.uuid ?? null,
    animationItemUuid: skill.uuid ?? null,
    carrierAttack: true,
    ...(r.damageMult !== 1 ? { damageMult: r.damageMult } : {}),
    ...(r.critDamageMult !== 1 ? { critDamageMult: r.critDamageMult } : {}),
    ...(r.noCritOpportunity ? { noCritOpportunity: true } : {}),
    ...(r.perfectMult !== 1 ? { chainPerfectMult: r.perfectMult } : {}),
  });
}

// DECLARE: a Skill bundle naming a carrier-attack skill becomes an Attack bundle.
// `getItem(uuid)` resolves the skill (fromUuidSync on the GM). Returns the bundle
// unchanged for anything else.
export function rewriteCarrierAttackBundle(bundle, getItem) {
  if (!bundle || bundle._commandOnly || bundle.command !== "Skill" || !bundle.skillUuid) return bundle;
  let item = null;
  try { item = getItem(bundle.skillUuid); } catch { item = null; }
  if (!isCarrierAttackSkill(item)) return bundle;
  return {
    ...bundle,
    command: "Attack",
    attackMode: "npc",
    npcAttackItemUuid: bundle.skillUuid,
    carrierAttack: true,
  };
}

// ── Volley damage multiplier ─────────────────────────────────────────────────
// "The attack deals ×M damage" on a Volley Chain of N shots: the attack's damage
// is counted once and shared over the shots, so each shot's own HR + weapon
// bonus is × M / N and the shared flat bonuses total × M. On anything else
// the whole hit is × M. Returns { shotMult, flatMult }.
export function carrierDamageMults(weapon, volley) {
  const M = Math.max(0, Number(weapon?.damageMult ?? 1));
  if (!Number.isFinite(M) || M === 1) return { shotMult: 1, flatMult: 1 };
  if (volley && Number(volley.shots) >= 2) return { shotMult: M / Number(volley.shots), flatMult: M };
  return { shotMult: M, flatMult: 1 };
}
