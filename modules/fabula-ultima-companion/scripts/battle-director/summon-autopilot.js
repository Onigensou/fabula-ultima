// Summon Autopilot — self-driving turns for SUMMONED creatures (a player's
// Numen, a reanimated minion, a drake), independent of the enemy autopilot.
//
// Why a separate switch: `bdEnemyAutopilot` is the GM's "let the Director play
// the monsters" toggle, and a GM who prefers to hand-drive monsters still does
// NOT want to hand-drive the party's own summons — those are the player's
// creatures, and a summon that waits for a human is a summon that stalls the
// table. The two are orthogonal, so they get two switches.
//
// What it automates (the enemy-autopilot pipeline, verbatim):
//   1. TURN_START — a side made entirely of automatable summons auto-picks who
//      acts, instead of parking on the manual turn picker.
//   2. DECLARE    — the summon's Action Pattern (ActionReader) decides the action
//      + targets, exactly as it does for an autopiloted monster.
//   3. CONFIRM    — UNLIKE the enemy autopilot, which stops dead at the card: a
//      summon's card auto-confirms after a VETO WINDOW (the timer lives beside
//      postActionCard's sim auto-confirm, in action-card.js). Any interaction
//      cancels the countdown and hands the card back to the human, and the GM
//      can always press Confirm to resolve it EARLY — the countdown is a floor
//      on how long the card waits, never a floor on how fast the GM can go.
//
// ON by default. The switch exists so a GM can turn it off, not so they have to
// turn it on; a summon idling on a menu is the exact friction this removes.
//
// What it does NOT change: a summon with no Action Pattern still falls through
// to the manual Octopath menu (the same failsafe the enemy autopilot has), and
// a summon on a side that still holds un-acted PCs does not steal the turn
// picker — the player keeps choosing turn ORDER. See CLAUDE.md + the
// [[project_enemy_autopilot]] / [[project_player_summon_autopilot]] notes.

import { log, warn } from "./logger.js";
import { registerDevTool } from "./dev-tools-menu.js";
import { SimMode } from "./sim/sim-mode.js";

const MODULE_ID = "fabula-ultima-companion";
const FLAG_NS = MODULE_ID;
const SETTING_KEY = "bdSummonAutopilot";
const VETO_SETTING_KEY = "bdSummonVetoSeconds";

// Veto window bounds (seconds). 0 = confirm on the timer's first beat (~100ms
// after the card is up) — the card is still posted and the strip still drawn, so
// nothing resolves entirely off-screen, but there is no practical chance to veto.
export const SUMMON_VETO_DEFAULT_SECONDS = 5;
const SUMMON_VETO_MAX_SECONDS = 60;

// ── Settings ────────────────────────────────────────────────────────────────
export function registerSummonAutopilotSetting() {
  try {
    game.settings.register(MODULE_ID, SETTING_KEY, {
      name: "Summon Autopilot (Battle Director)",
      hint: "When on, the party's SUMMONED creatures (Numen, reanimated minions, drakes) drive their own turns from their Action Pattern and auto-confirm the action card after a short veto window. Independent of the AI Autopilot toggle; a summon with no Action Pattern still falls back to the manual menu.",
      scope: "world",
      config: false,   // toggled via the dev-tools button, like the enemy autopilot
      type: Boolean,
      // ON by default (user call, 2026-08-15). A summon that waits for a human is
      // the problem this exists to remove, so the useful state is the default one
      // — including for a PLAYER-OWNED summon like the Numen, whose actor belongs
      // to the summoner's player. The dev-tools 🐾 toggle turns it off per world.
      default: true,
    });
  } catch (e) {
    warn("registerSummonAutopilotSetting threw", e);
  }
  try {
    game.settings.register(MODULE_ID, VETO_SETTING_KEY, {
      name: "Summon auto-confirm delay (seconds)",
      hint: "How long a summon's action card waits before confirming itself. Any click, keypress or reaction decision on the card cancels the countdown and returns it to manual. 0 confirms as soon as the card is up.",
      scope: "world",
      config: true,
      type: Number,
      default: SUMMON_VETO_DEFAULT_SECONDS,
      range: { min: 0, max: SUMMON_VETO_MAX_SECONDS, step: 1 },
    });
  } catch (e) {
    warn("registerSummonAutopilotSetting (veto) threw", e);
  }
}

export function isSummonAutopilotEnabled() {
  // A sim has nobody at the keyboard — everything is automated there, and the
  // sim's own auto-confirm path owns the card. Reporting "on" here would arm a
  // second confirm timer on top of it.
  if (SimMode.active) return false;
  try { return game.settings.get(MODULE_ID, SETTING_KEY) === true; }
  catch { return false; }
}

export function setSummonAutopilotEnabled(on) {
  try { return game.settings.set(MODULE_ID, SETTING_KEY, !!on); }
  catch (e) { warn("setSummonAutopilotEnabled threw", e); }
}

// Veto window in ms. Clamped so a bad setting value can neither confirm before
// the card renders (negative) nor park the turn for an hour.
export function summonVetoMs() {
  let s = SUMMON_VETO_DEFAULT_SECONDS;
  try {
    const raw = Number(game.settings.get(MODULE_ID, VETO_SETTING_KEY));
    if (Number.isFinite(raw)) s = raw;
  } catch { /* setting not registered yet — use the default */ }
  return Math.max(0, Math.min(SUMMON_VETO_MAX_SECONDS, s)) * 1000;
}

// ── Dev-tools toggle button ─────────────────────────────────────────────────
function summonToolIcon() { return isSummonAutopilotEnabled() ? "🐾" : "🖐"; }
function summonToolLabel() {
  return isSummonAutopilotEnabled()
    ? "Summon Autopilot: ON (click for manual)"
    : "Summon Autopilot: OFF (click to automate)";
}

export function registerSummonAutopilotDevTool() {
  const register = () => registerDevTool({
    id: "summon-autopilot",
    icon: summonToolIcon(),
    label: summonToolLabel(),
    onClick: async () => {
      await setSummonAutopilotEnabled(!isSummonAutopilotEnabled());
      const on = isSummonAutopilotEnabled();
      const secs = Math.round(summonVetoMs() / 1000);
      ui.notifications?.info(on
        ? `Summon Autopilot ON — summons act on their own and auto-confirm after ${secs}s (click the card to hold).`
        : "Summon Autopilot OFF — summon turns are manual.");
      register(); // re-register to refresh icon/label
    },
  });
  register();
}

// ── Is this combatant an automatable SUMMON? ────────────────────────────────
// Persistent state only, so the answer survives a reload: the token flags the
// summon effect stamps (`isSummon` / `isPhantasm` / `summonedBy`), plus the
// legacy actor props (`isSummon`, and `isPhantasm` — the prop director-combat
// reads for the Fox fire template, whose token may predate the flag).
//
// A PHANTASM is included deliberately even though it holds 0 turns/round: it
// never reaches TURN_START, so including it costs nothing, and if a future
// phantasm ever does get an activation it should self-drive like the rest.
export function isSummonCombatant(dc) {
  if (!dc) return false;
  try {
    const td = dc.tokenDoc ?? null;
    const f = td?.flags?.[FLAG_NS] ?? {};
    if (f.isSummon || f.isPhantasm || f.summonedBy) return true;
  } catch { /* fall through to the actor props */ }
  const p = dc.actorDoc?.system?.props ?? {};
  const truthy = (v) => v === true || v === "true" || v === 1 || v === "1";
  if (truthy(p.isSummon) || truthy(p.isPhantasm)) return true;
  // A GUEST is a summon in every way that matters here: a GM-owned party-side
  // body the players did not roll up, which exists to act on its own. It is
  // marked on the ACTOR (bdGuest), not the token, because a guest outlives any
  // one spawn. Folding it in here is what lets a guest ride this switch instead
  // of needing the GM to leave the monster autopilot on.
  return isGuestActor(dc.actorDoc);
}

// The guest marker — same flag defeat-reactor / snapshot / skill-targeting read.
export function isGuestActor(actorDoc) {
  try {
    return !!foundry.utils.getProperty(actorDoc ?? {}, `flags.${FLAG_NS}.bdGuest`);
  } catch { return false; }
}

// Same question, asked of a bare token document (the CONFIRM path has the card's
// attacker token, not a DirectorCombatant).
export function isSummonTokenDoc(tokenDoc, actorDoc = null) {
  return isSummonCombatant({ tokenDoc, actorDoc: actorDoc ?? tokenDoc?.actor ?? null });
}

// Should THIS combatant be driven by the summon autopilot right now?
//
// PARTY SIDE ONLY. `isSummonCombatant` is side-blind — an enemy necromancer's
// reanimated minions carry the same `summonedBy` flag as the party's Numen — so
// without this scope a GM who turned the AI Autopilot OFF specifically to
// hand-drive their monsters would find the monsters' summons driving themselves
// anyway. This switch is about the PARTY's summons; an enemy-side summon stays
// with the enemy autopilot, which the GM controls separately.
export function isAutomatedSummon(dc) {
  if (!isSummonAutopilotEnabled()) return false;
  if (!isSummonCombatant(dc)) return false;
  return String(dc?.side ?? "") === "party";
}

// Is the given TURN an automated summon's? The DECLARE gate.
//
// It takes the turn SNAPSHOT, not just the director, on purpose. A free action
// is taken by the REACTOR — on somebody else's turn — so a director-only lookup
// (`dc.currentCombatantId`) answers for the wrong creature: it would have let
// the AI spend a PLAYER's free action just because a summon happened to hold
// the current turn. enemy-autopilot documents the same asymmetry for its twin.
// Falls back to the current combatant only when no snapshot is supplied.
export function isAutomatedSummonTurn(director, snap = null) {
  try {
    if (!isSummonAutopilotEnabled()) return false;
    const dc = director?.dCombat;
    if (!dc) return false;
    const list = dc.combatants ?? [];
    const subject = snap
      ? (list.find?.((c) => c.tokenDoc?.uuid && c.tokenDoc.uuid === snap.tokenUuid)
        ?? list.find?.((c) => c.tokenId && c.tokenId === snap.tokenId)
        ?? list.find?.((c) => c.actorDoc?.uuid && c.actorDoc.uuid === snap.actorUuid)
        ?? null)
      : (list.find?.((c) => c.id === dc.currentCombatantId) ?? null);
    if (!subject) return false;
    const yes = isAutomatedSummon(subject);
    if (yes) log(`summon-autopilot: ${subject.name} is an automated summon turn`);
    return yes;
  } catch (e) {
    warn("isAutomatedSummonTurn threw", e);
    return false;
  }
}
