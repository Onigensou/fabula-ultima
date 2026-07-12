// Player Brain — decides a turn for a combatant that has no Action Pattern.
//
// Enemies think with ActionReader ([[project_action_pattern_ai]]) because they
// carry an `action_pattern_table` prop. PCs don't have one, so in a sim their
// ActionReader run yields nothing and the autopilot would normally hand back to
// the manual Octopath menu — which, with nobody at the keyboard, is a hang. This
// module is what answers instead.
//
// PHASE 0 (this file): the dumbest defensible policy — swing your main weapon at
// the enemy closest to dying. It exists to prove the FSM can run a fight
// hands-free, NOT to model how your party actually plays. Any balance number
// read off this brain is a FLOOR, not a forecast: a real party heals, spends MP,
// exploits affinities, and picks better targets, so a fight this brain finds
// hard is genuinely hard, while a fight it finds easy tells you very little.
//
// PHASE 2 replaces the guts here with per-PC profiles fed through ActionReader
// itself (injected pattern table), so the party gets feasibility, affinity
// targeting and anti-repeat for free. The signature below is the seam that
// swap plugs into — keep it stable.

import { log } from "../logger.js";

// Living opposing combatants, from the director's authoritative model.
function livingOpponents(director, snap) {
  const dc = director?.dCombat;
  if (!dc) return [];
  const self = dc.combatants?.find?.((c) => c.tokenId === snap?.tokenId) ?? null;
  const mySide = self?.side ?? "party";
  return (dc.combatants ?? []).filter((c) => c.side !== mySide && !c.isDefeatedLive?.());
}

function readHp(actorDoc) {
  const p = actorDoc?.system?.props ?? {};
  const n = Number(p.current_hp);
  return Number.isFinite(n) ? n : Infinity;
}

// A PC can make a weapon Attack if it has something in its main hand. CSB stores
// the equipped hand as a bare name on `main_hand`; an empty/SHI hand means no
// usable weapon (see readWeapon in snapshot.js), and we'd rather Guard than emit
// an Attack the TARGET stage can't resolve a weapon for.
function hasMainWeapon(actorDoc) {
  const raw = String(actorDoc?.system?.props?.main_hand ?? "").trim();
  return raw !== "" && raw.toUpperCase() !== "SHI";
}

function tokenUuidOf(dc) {
  return dc?.tokenDoc?.uuid ?? canvas?.tokens?.get(dc?.tokenId)?.document?.uuid ?? null;
}

// Decide a turn. Returns a compose bundle (the same shape composeAction hands to
// applyComposedBundleAndAdvance) or null to let the caller fall through to its
// terminal Guard fallback.
//
// Attack bundle shape is the PC one — `attackMode: "main"`, no weapon uuid. The
// TARGET stage derives the weapon from the attacker's equipped hand
// (state-handlers' Attack branch), which is exactly what a human click produces.
export async function decidePlayerAction(director, snap) {
  const actorDoc = snap?.actorDoc ?? canvas?.tokens?.get(snap?.tokenId)?.actor ?? null;

  if (!hasMainWeapon(actorDoc)) {
    log(`[SIM] player-brain: ${snap?.name} has no main-hand weapon — no attack available`);
    return null;
  }

  const foes = livingOpponents(director, snap);
  if (!foes.length) {
    log(`[SIM] player-brain: ${snap?.name} sees no living opponents`);
    return null;
  }

  // Focus fire the closest-to-dead. Crude, but it's the one heuristic a real
  // party reliably does apply, and it keeps the floor from being absurdly low.
  const target = foes.slice().sort((a, b) => readHp(a.actorDoc) - readHp(b.actorDoc))[0];
  const targetUuid = tokenUuidOf(target);
  if (!targetUuid) return null;

  log(`[SIM] player-brain: ${snap?.name} → Attack ${target.name} (hp ${readHp(target.actorDoc)})`);
  return { command: "Attack", attackMode: "main", targetUuids: [targetUuid] };
}
