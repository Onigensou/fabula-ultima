// Battle Director — backend Initiative Group Check (Fabula Ultima Core p.61).
//
// Runs the FU Initiative Group Check FULLY BACKEND (no lobby, no player input,
// no chat card) so it can be re-rolled every round without tedium. Only the
// director calls this, from ROUND_START (director-native orchestration); the
// single player-facing surface is the "Player/Enemy Initiative" banner that
// ROUND_START fires afterward with the returned side.
//
// RAW mechanic:
//   • The party performs an Initiative Group Check relying on DEX + INS.
//   • The LEADER's Check DL = the highest Initiative Score among adversaries.
//   • SUPPORTING characters roll a support Check at the standard DL 10; each
//     success grants the leader +1.
//   • Everyone applies their Initiative MODIFIER to their result.
//   • Leader succeeds → the heroes seize initiative (party acts first this
//     round); leader fails → the foes act first.
//
// Data model (verified against live actors):
//   • Enemy Initiative Score      = actor.system.props.init   (flat number)
//   • PC Initiative modifier      = -actor.system.props.init_penalty (armor)
//   • DEX / INS die sizes         = actor.system.props.dex_current / ins_current
//   PCs have no init score; they simply roll DEX + INS. The auto-leader is the
//   living PC with the best (dex_current + ins_current − init_penalty) proxy,
//   random tiebreak.

import { log, warn } from "./logger.js";

const HELPER_DL = 10;   // RAW: supporting characters' support Check DL.
const HELPER_BONUS = 1; // RAW: +1 to the leader per helper success.

function numberish(v, fallback = 0) {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

// Enemy Initiative Score — the flat `init` stat the party must beat. Falls back
// to the standard DL 10 if an enemy has no `init` prop authored.
export function readEnemyInitScore(actor) {
  const raw = actor?.system?.props?.init;
  if (raw == null || String(raw).trim() === "") return null;
  return numberish(raw, null);
}

// PC Initiative modifier applied to the DEX+INS roll — the negative of the
// armor initiative penalty. (init_penalty is stored as a positive magnitude.)
export function readPcInitiativeModifier(actor) {
  return -numberish(actor?.system?.props?.init_penalty, 0);
}

// Leader-selection proxy for PCs (they have no init score): higher DEX+INS die
// sizes minus armor penalty = "quicker to act". Only used to pick who leads.
function pcInitiativeProxy(actor) {
  const dex = numberish(actor?.system?.props?.dex_current, 8);
  const ins = numberish(actor?.system?.props?.ins_current, 8);
  return dex + ins + readPcInitiativeModifier(actor);
}

// Roll ONE silent DEX+INS check for `actor` at `dl`, applying that actor's
// Initiative modifier plus any extra modifiers (e.g. the leader's helper bonus).
// Returns the CheckResult (with .total/.pass/.isFumble) or null if the Check
// Requester isn't available.
async function rollInitiativeCheck(actor, dl, extraMods = []) {
  const CR = globalThis.ONI?.CheckRequester;
  if (!CR?.request) { warn("director-initiative: ONI.CheckRequester unavailable"); return null; }
  const modifiers = [];
  const initMod = readPcInitiativeModifier(actor);
  if (initMod !== 0) modifiers.push({ label: "Initiative", value: initMod });
  for (const m of extraMods) if (m && m.value) modifiers.push(m);
  const results = await CR.request([actor], {
    attrA: "DEX", attrB: "INS",
    dl,
    mode: "silent",
    postChat: false,
    allowInvokes: false,
    modifiers,
    context: { initiativeGroupCheck: true },
  });
  return results?.[0] ?? null;
}

// Resolve which side seizes initiative for the current round via a fully-backend
// Initiative Group Check. Reads the LIVE dCombat combatant lists so defeated
// members are excluded.
//
// Returns:
//   { side: "party"|"enemy", dl, bonus, leaderName, leaderTotal,
//     helperPasses, degraded? }
// Never throws — on any failure it degrades to "enemy" (foes act first, the
// safe default when the party couldn't organize a check) and flags `degraded`.
export async function resolveInitiativeGroupCheck(dCombat) {
  try {
    const party = dCombat.combatants.filter((c) => c.side === "party" && !c.isDefeatedLive());
    const enemies = dCombat.combatants.filter((c) => c.side === "enemy" && !c.isDefeatedLive());

    // Degenerate sides — no check needed.
    if (!party.length) return { side: "enemy", dl: 0, bonus: 0, degraded: false, reason: "no living party" };
    if (!enemies.length) return { side: "party", dl: 0, bonus: 0, degraded: false, reason: "no living enemies" };

    // Leader DL = highest enemy Initiative Score (fallback DL 10 if unauthored).
    const enemyScores = enemies.map((c) => readEnemyInitScore(c.actorDoc)).filter((n) => n != null);
    const dl = enemyScores.length ? Math.max(...enemyScores) : HELPER_DL;

    // Auto-pick leader: best PC initiative proxy, random tiebreak.
    const ranked = party
      .map((c) => ({ c, score: pcInitiativeProxy(c.actorDoc), jitter: Math.random() }))
      .sort((a, b) => (b.score - a.score) || (b.jitter - a.jitter));
    const leaderCombatant = ranked[0].c;
    const helperCombatants = ranked.slice(1).map((r) => r.c);

    // Phase A — helper support checks (DL 10). Each non-fumbled pass = +1.
    let helperPasses = 0;
    for (const hc of helperCombatants) {
      const actor = hc.actorDoc;
      if (!actor) continue;
      const res = await rollInitiativeCheck(actor, HELPER_DL);
      if (res?.pass && !res.isFumble) helperPasses++;
    }
    const bonus = helperPasses * HELPER_BONUS;

    // Phase B — leader check (DL = highest enemy init) with the helper bonus.
    const leaderActor = leaderCombatant.actorDoc;
    const leaderRes = leaderActor
      ? await rollInitiativeCheck(leaderActor, dl, bonus > 0 ? [{ label: `Helpers (+${bonus})`, value: bonus }] : [])
      : null;

    // No Check Requester / roll failure → degrade rather than wedge the round.
    if (!leaderRes) {
      return { side: "enemy", dl, bonus, leaderName: leaderCombatant.name, degraded: true, reason: "leader roll unavailable" };
    }

    const side = leaderRes.pass ? "party" : "enemy";
    log(`Initiative Group Check: leader ${leaderCombatant.name} total ${leaderRes.total} vs DL ${dl} (helpers +${bonus}) → ${side} seizes initiative`);
    return {
      side, dl, bonus,
      leaderName: leaderCombatant.name,
      leaderTotal: leaderRes.total,
      helperPasses,
      degraded: false,
    };
  } catch (e) {
    warn("resolveInitiativeGroupCheck threw — degrading to enemy-first", e);
    return { side: "enemy", dl: 0, bonus: 0, degraded: true, reason: String(e?.message ?? e) };
  }
}
