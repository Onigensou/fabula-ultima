// Enemy Autopilot — automates the COMPOSE phase of enemy-side NPC turns by
// driving the existing "Action Pattern" enemy-AI (ActionReader) and handing the
// Battle Director the same data a human would produce at the two decision gates:
//
//   1. TURN_START — WHO acts (initiative-ranked pick among eligible enemies)
//   2. DECLARE    — WHAT action + WHICH targets (a compose "bundle")
//
// The automation deliberately STOPS at the action card: decideAction() returns
// a bundle, state-handlers' DECLARE applies it via applyComposedBundleAndAdvance,
// the FSM auto-runs TARGET → COMPUTE, posts the card, and BLOCKS at CONFIRM for a
// human. The autopilot NEVER emits CONFIRM_ACTION — reactions + confirm stay
// manual, exactly as a player-declared action.
//
// Scope (v2): every non-player combatant — enemies AND GM-owned guest allies
// (player-owned PCs stay manual). If a turn can't be automated (no Action Pattern
// configured, nothing feasible, an unsupported command, or an action-gating
// debuff), the driver returns null and the caller falls back to today's manual
// composeAction (the GM's Octopath menu). See [[project_action_pattern_ai]] +
// [[project_battle_director]].
//
// Dual-GM: both entry points are invoked from onEnter handlers that already run
// only on the active director client, so this module adds no sockets and no
// per-client hooks. See [[project_gm_host_dedupe_pattern]].

import { log, warn } from "./logger.js";
import { registerDevTool } from "./dev-tools-menu.js";
import { SimMode } from "./sim/sim-mode.js";
import { decidePlayerAction } from "./sim/player-brain.js";

// ── ActionReader pipeline (direct ESM import — same singleton the world macro
//    drives through the module API). We run every stage EXCEPT AnnounceResult:
//    we want the picked data, not the GM whisper. ──────────────────────────────
import { ActionReaderCore } from "../action-reader/actionReader-core.js";
import { resolveActionReaderPerformer } from "../action-reader/actionReader-resolvePerformer.js";
import { buildActionReaderContext } from "../action-reader/actionReader-buildContext.js";
import { readActionReaderPatternTable } from "../action-reader/actionReader-readPatternTable.js";
import { evaluateActionReaderConditions } from "../action-reader/actionReader-evaluateConditions.js";
import { matchAndPickActionReaderAction } from "../action-reader/actionReader-matchAndPickAction.js";
import { parseActionReaderTargetRule } from "../action-reader/actionReader-parseTargetRule.js";
import { buildAndPickActionReaderTargets } from "../action-reader/actionReader-buildAndPickTargets.js";

const MODULE_ID = "fabula-ultima-companion";
const SETTING_KEY = "bdEnemyAutopilot";

// ── Tunable pacing (ms). Randomized "thinking" pauses so automation reads as a
//    human playing the monster rather than an instant robot. All jitter lives
//    here so the feel is tuned in one place. ──────────────────────────────────
export const AUTOPILOT_TIMING = {
  turnPick: [500, 1200],   // pause before committing WHO acts
  decision: [900, 2100],   // pause before committing the action bundle
};

function rand(min, max) {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

function jitterDelay([min, max]) {
  return new Promise((resolve) => setTimeout(resolve, rand(min, max)));
}

// ── Setting ────────────────────────────────────────────────────────────────
export function registerAutopilotSetting() {
  try {
    game.settings.register(MODULE_ID, SETTING_KEY, {
      name: "AI Autopilot (Battle Director)",
      hint: "When on, the Director auto-drives every non-player combatant (enemies AND GM-owned guest allies) from its Action Pattern — picking turn order + action + targets, stopping at the action card for you to confirm. Player-owned PCs stay manual; any combatant with no Action Pattern falls back to the manual menu.",
      scope: "world",
      config: false,   // toggled via the dev-tools button, not the settings sheet
      type: Boolean,
      default: false,
    });
  } catch (e) {
    warn("registerAutopilotSetting threw", e);
  }
}

export function isAutopilotEnabled() {
  // A sim has nobody at the keyboard — the autopilot is mandatory, regardless of
  // what the GM's toggle happens to be set to.
  if (SimMode.active) return true;
  try { return game.settings.get(MODULE_ID, SETTING_KEY) === true; }
  catch { return false; }
}

export function setAutopilotEnabled(on) {
  try { return game.settings.set(MODULE_ID, SETTING_KEY, !!on); }
  catch (e) { warn("setAutopilotEnabled threw", e); }
}

// ── Dev-tools toggle button ──────────────────────────────────────────────────
// A single 🤖 button in the Developer Tools speed-dial. Click flips the world
// setting; the label + icon reflect the live state and a notification confirms
// the switch so the GM can flip to/from manual mid-combat with one click.
function autopilotToolIcon() { return isAutopilotEnabled() ? "🤖" : "🕹️"; }
function autopilotToolLabel() {
  return isAutopilotEnabled() ? "AI Autopilot: ON (click for manual)" : "AI Autopilot: OFF (click to automate)";
}

export function registerAutopilotDevTool() {
  const register = () => registerDevTool({
    id: "enemy-autopilot",
    icon: autopilotToolIcon(),
    label: autopilotToolLabel(),
    onClick: async () => {
      await setAutopilotEnabled(!isAutopilotEnabled());
      const on = isAutopilotEnabled();
      ui.notifications?.info(`AI Autopilot ${on ? "ON — Director drives non-player combatants (enemies + guests) up to the action card." : "OFF — all turns are manual."}`);
      register(); // re-register to refresh icon/label (rebuilds the stack if open)
    },
  });
  register();
}

// ── Initiative ranking ───────────────────────────────────────────────────────
// Fabula Ultima has no per-combatant initiative roll for turn order (the Director
// orders by SIDE). To honour "pick who acts by their initiative stats", we derive
// a proxy from the actor's attributes: DEX + INS die sizes (+ optional flat
// bonus). Higher acts first. Defensive across field names — degrades to a random
// pick if attributes are missing, which still "simulates a human".
function readInitiativeScore(actorDoc) {
  const p = actorDoc?.system?.props ?? {};
  const num = (v) => {
    const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const dex = num(p.dex_current) ?? num(p.dexterity) ?? num(p.dex) ?? 8;
  const ins = num(p.ins_current) ?? num(p.insight) ?? num(p.ins) ?? 8;
  const bonus = num(p.initiative) ?? num(p.init_bonus) ?? num(p.initiative_bonus) ?? 0;
  return dex + ins + bonus;
}

// Rank eligible enemy combatants and return the one who should act. Highest
// initiative wins; a small random jitter breaks ties (and near-ties) organically
// so repeated fights don't feel scripted. Returns the chosen DirectorCombatant
// or null.
function rankEnemyCombatants(eligible) {
  const scored = eligible.map((dc) => {
    const base = readInitiativeScore(dc.actorDoc);
    return { dc, score: base + Math.random() * 2 - 1, base };
  });
  scored.sort((a, b) => b.score - a.score);
  if (scored.length) {
    log(`autopilot: initiative order → ${scored.map((s) => `${s.dc.name}(${s.base})`).join(", ")}`);
  }
  return scored[0]?.dc ?? null;
}

// ── Thinking pip (DOM overlay anchored over the acting token) ─────────────────
const PIP_STYLE_ID = "fud-autopilot-pip-style";

function ensurePipStyle() {
  if (document.getElementById(PIP_STYLE_ID)) return;
  const css = `
.fud-ap-pip{
  position:fixed; left:0; top:0; z-index:75; pointer-events:none;
  transform:translate(-50%,-100%);
  display:flex; align-items:center; justify-content:center;
  min-width:34px; height:26px; padding:0 8px;
  border-radius:14px;
  background:linear-gradient(180deg,#2b2f3a,#171a21);
  border:1px solid rgba(255,255,255,.22);
  box-shadow:0 3px 10px rgba(0,0,0,.5);
  color:#e8eaf0; font-size:15px; letter-spacing:2px; font-weight:800;
  opacity:0; transition:opacity .18s ease;
}
.fud-ap-pip.shown{ opacity:1 }
.fud-ap-pip .dot{ animation:fud-ap-bounce 1s infinite ease-in-out; }
.fud-ap-pip .dot:nth-child(2){ animation-delay:.15s }
.fud-ap-pip .dot:nth-child(3){ animation-delay:.3s }
@keyframes fud-ap-bounce{ 0%,80%,100%{ transform:translateY(0); opacity:.5 } 40%{ transform:translateY(-3px); opacity:1 } }
`.trim();
  const style = document.createElement("style");
  style.id = PIP_STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

// Anchor a token's top-center (world coords) to page coords.
function tokenTopClient(token) {
  try {
    const w = token.w ?? 100;
    const c = token.center ?? { x: (token.x ?? 0) + w / 2, y: (token.y ?? 0) + (token.h ?? 100) / 2 };
    const topY = c.y - (token.h ?? 100) / 2 - (token.h ?? 100) * 0.12;
    const wt = canvas.stage.worldTransform;
    const out = wt.apply({ x: c.x, y: topY }, new PIXI.Point());
    const rect = canvas.app.view.getBoundingClientRect();
    return { x: rect.left + out.x, y: rect.top + out.y };
  } catch {
    return null;
  }
}

// Show the "…thinking" pip over a token for the duration of an awaited delay.
// Returns a handle with .remove(). Safe if the token/canvas is unavailable.
function showThinkingPip(token) {
  if (!token || token.destroyed) return { remove() {} };
  ensurePipStyle();
  const el = document.createElement("div");
  el.className = "fud-ap-pip";
  el.innerHTML = `<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>`;
  document.body.appendChild(el);

  const position = () => {
    const pt = tokenTopClient(token);
    if (!pt) return;
    el.style.left = `${pt.x}px`;
    el.style.top = `${pt.y}px`;
  };
  position();
  requestAnimationFrame(() => el.classList.add("shown"));

  const ticker = PIXI.Ticker?.shared ?? null;
  const tick = () => { try { position(); } catch {} };
  try { ticker?.add(tick); } catch {}

  return {
    remove() {
      try { ticker?.remove(tick); } catch {}
      try { el.remove(); } catch {}
    },
  };
}

// Await a "thinking" pause with the pip shown over the token, then tear it down.
//
// In a sim the pause is whatever the run's pace says (zero on fast/batch) — the
// jitter exists to make a monster read as hand-played, and a playtest run has
// nobody to read it. Same for the pip: it's pure decoration, and at batch pace
// it would just be DOM churn between instant decisions.
async function think(token, range) {
  const inSim = SimMode.active;
  const effRange = inSim ? SimMode.thinkRange() : range;
  const pip = (inSim && !SimMode.showPip()) ? { remove() {} } : showThinkingPip(token);
  try { await jitterDelay(effRange); }
  finally { pip.remove(); }
}

// ── ActionReader run ──────────────────────────────────────────────────────────
// Chain the pipeline for a single token, stopping before AnnounceResult. Returns
// the ActionReader context (with chosenAction + chosenTargets) or null on any
// stage failure. Never throws.
async function runActionReader({ token, combat, combatant }) {
  try {
    let ctx = ActionReaderCore.createBaseContext();

    await resolveActionReaderPerformer(ctx, { token, combat, combatant });
    if (!ctx.performer?.actor) { log("autopilot: ActionReader resolvePerformer produced no actor"); return null; }

    await buildActionReaderContext(ctx);
    await readActionReaderPatternTable(ctx);
    await evaluateActionReaderConditions(ctx);
    await matchAndPickActionReaderAction(ctx);
    if (!ctx.chosenAction) { log("autopilot: ActionReader picked no action (no pattern / nothing feasible)"); return null; }

    await parseActionReaderTargetRule(ctx);
    await buildAndPickActionReaderTargets(ctx);
    if (!Array.isArray(ctx.chosenTargets) || !ctx.chosenTargets.length) {
      log("autopilot: ActionReader resolved no targets");
      return null;
    }
    return ctx;
  } catch (e) {
    warn("autopilot: runActionReader threw", e);
    return null;
  }
}

// ── Bundle adapter (ActionReader chosenAction/chosenTargets → compose bundle) ──
function targetUuidsFrom(chosenTargets) {
  return chosenTargets
    .map((t) => t?.tokenDocument?.uuid ?? t?.uuid ?? null)
    .filter(Boolean);
}

function itemUuidFrom(chosenAction) {
  return chosenAction?.item?.uuid
    ?? chosenAction?.itemSnapshot?.uuid
    ?? chosenAction?.candidate?.itemUuid
    ?? null;
}

function skillTypeOf(chosenAction) {
  const raw = chosenAction?.skillType
    ?? chosenAction?.itemSnapshot?.props?.skill_type
    ?? chosenAction?.item?.system?.props?.skill_type
    ?? "";
  return String(raw).trim().toLowerCase();
}

// Map to the exact bundle shapes applyComposedBundleAndAdvance/compose-action
// use. Returns { bundle } or { unsupported:true }. Only the offensive core is
// supported in v1 (Attack / Spell / Skill); anything else defers to manual.
function toBundle(chosenAction, chosenTargets) {
  const itemUuid = itemUuidFrom(chosenAction);
  const targetUuids = targetUuidsFrom(chosenTargets);
  if (!itemUuid) return { unsupported: true, reason: "no item uuid on chosen action" };

  const st = skillTypeOf(chosenAction);

  if (st === "attack") {
    return { bundle: { command: "Attack", attackMode: "npc", npcAttackItemUuid: itemUuid, targetUuids } };
  }
  if (st === "spell") {
    return { bundle: { command: "Spell", skillUuid: itemUuid, sourceItemUuid: itemUuid, targetUuids } };
  }
  if (st === "active" || st === "skill" || st === "") {
    // Blank skill_type on a matched (non-passive) action → treat as a Skill.
    return { bundle: { command: "Skill", skillUuid: itemUuid, sourceItemUuid: itemUuid, targetUuids } };
  }
  return { unsupported: true, reason: `unsupported skill_type "${st}"` };
}

// ── Gate: is a combatant AI-controlled? ───────────────────────────────────────
// v2: the signal is player-OWNERSHIP, not side/disposition. BD normalizes every
// combatant to disposition ±1 at spawn (director-init forces party→1, enemy→-1),
// so a Guest ally and a PC both read as disposition 1 on the party side —
// ownership is the only reliable "AI vs player" signal inside a Director battle.
// A GM-owned combatant (enemy OR guest ally) is AI-controlled; a player-owned
// actor (a PC) stays manual. Combined with the no-Action-Pattern → manual
// failsafe, this lets the dev opt any specific GM actor out of AI by leaving its
// pattern blank. A party-side guest keeps disposition 1, so ActionReader targets
// the hostiles correctly with no override. See [[project_enemy_autopilot]].
export function isAiControlledCombatant(dc) {
  const actor = dc?.actorDoc ?? null;
  if (!actor) return false;
  // In a sim EVERY combatant is AI-controlled — the party included. (The sim's
  // party is a set of GM-owned clones, so `hasPlayerOwner` would already be
  // false; this makes it true by construction rather than by accident, so a sim
  // can never stall waiting on a player-owned actor.)
  if (SimMode.active) return true;
  return !actor.hasPlayerOwner;
}

// Is the CURRENT Director turn an AI-controlled combatant?
export function isAiControlledTurn(director) {
  try {
    const dc = director?.dCombat;
    if (!dc) return false;
    const cur = dc.combatants?.find?.((c) => c.id === dc.currentCombatantId) ?? null;
    return isAiControlledCombatant(cur);
  } catch { return false; }
}

// ── Public: TURN_START — pick WHO acts ────────────────────────────────────────
// eligible = DirectorCombatant[] on the enemy side (already filtered by caller).
// Returns the chosen combatant id (with a thinking pause + pip), or null to let
// the caller fall back to the manual picker.
export async function autopilotPickCombatant(director, eligible) {
  try {
    if (!Array.isArray(eligible) || !eligible.length) return null;
    const chosen = rankEnemyCombatants(eligible);
    if (!chosen) return null;

    const token = canvas?.tokens?.get(chosen.tokenId) ?? null;
    log(`autopilot: TURN_START picking ${chosen.name}`);
    await think(token, AUTOPILOT_TIMING.turnPick);
    return chosen.id;
  } catch (e) {
    warn("autopilotPickCombatant threw", e);
    return null;
  }
}

// ── Public: DECLARE — decide WHAT action + WHICH targets ──────────────────────
// snap = the acting actor's turnSnapshot. Returns a compose bundle (with a
// thinking pause + pip) or null → caller falls back to manual composeAction.
//
// In a sim, "fall back to manual" is a deadlock: there is nobody to open the
// menu for. So a sim never returns null — it escalates through the fallback
// chain below (ActionReader → player brain → Guard) until something is
// actionable. Real play is untouched: outside a sim this still returns null and
// the GM gets the Octopath menu exactly as before.
export async function autopilotDecideAction(director, snap) {
  const bundle = await decideViaActionReader(director, snap);
  if (bundle) return bundle;
  if (!SimMode.active) return null;   // real play — manual fallback, unchanged
  return await simFallbackBundle(director, snap);
}

// The sim's terminal fallback. ActionReader had nothing (no pattern table, as on
// every PC; or nothing feasible/legal), so:
//   1. ask the player brain for an action, then
//   2. Guard — which always composes, needs no picker (coverTokenUuid null =
//      self-guard) and is never gated by a debuff, so the turn always resolves.
// A Guard here is a real in-fiction choice, not a skipped turn, so it shows up
// honestly in the transcript rather than silently vanishing.
async function simFallbackBundle(director, snap) {
  // Identify THIS combatant's turn. A re-entry into DECLARE for the same
  // (round, combatant) means the last action bounced — see SimMode's re-declare
  // guard. Retire it and let the brain pick again, rather than looping on it.
  const turnKey = `${director?.dCombat?.round ?? 0}:${snap?.combatantId ?? snap?.tokenId ?? "?"}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    let bundle = null;
    try {
      bundle = await decidePlayerAction(director, snap, SimMode.blockedForTurn(turnKey));
    } catch (e) {
      warn("[SIM] player brain threw", e);
      break;
    }
    if (!bundle) break;

    // An action-gating debuff (Silence on a Spell, etc.) — the menu would grey it
    // out, so don't declare it.
    const gated = (snap?.blockedActions ?? []).find((b) => b?.label === bundle.command);
    if (gated) {
      log(`[SIM] ${snap?.name}: ${bundle.command} is gated by ${gated.reason}`);
      SimMode.blockForTurn(turnKey, bundle._name ?? bundle.command);
      continue;
    }

    // Signature identifies the ACTION, not just the command: two different spells
    // are different declarations.
    const sig = `${bundle.command}:${bundle.skillUuid ?? bundle.attackMode ?? ""}`;
    if (SimMode.declaredThisTurn(turnKey, sig)) {
      // We already tried exactly this and we're back here — it didn't take.
      SimMode.blockForTurn(turnKey, bundle._name ?? bundle.skillUuid ?? bundle.command);
      continue;
    }

    SimMode.recordDeclaration(turnKey, sig);
    SimMode.note("decide", `${snap?.name} → ${bundle.command}${bundle._name ? ` "${bundle._name}"` : ""} (player brain)`);
    return bundle;
  }

  SimMode.note("decide", `${snap?.name} → Guard (nothing left that works)`);
  return { command: "Guard", coverTokenUuid: null };
}

async function decideViaActionReader(director, snap) {
  try {
    const token = canvas?.tokens?.get(snap?.tokenId) ?? null;
    if (!token) { log("autopilot: DECLARE has no canvas token — manual fallback"); return null; }

    // Foundry combatant (for ActionReader anti-repeat memory + disposition).
    const combat = director?.combat ?? game.combat ?? null;
    const combatant = combat?.combatants?.find?.((c) => c.tokenId === snap.tokenId) ?? null;

    // Show the pip WHILE the AI deliberates + for a jittered "reading" beat, so
    // the pause overlaps the actual compute rather than adding pure dead time.
    // In a sim both the pip and the jitter follow the run's pace (nil on fast).
    const inSim = SimMode.active;
    const pip = (inSim && !SimMode.showPip()) ? { remove() {} } : showThinkingPip(token);
    let ctx = null;
    try {
      ctx = await runActionReader({ token, combat, combatant });
      await jitterDelay(inSim ? SimMode.thinkRange() : AUTOPILOT_TIMING.decision);
    } finally {
      pip.remove();
    }
    if (!ctx) return null;   // no pattern / nothing feasible / no targets → manual

    const mapped = toBundle(ctx.chosenAction, ctx.chosenTargets);
    if (mapped.unsupported) {
      log(`autopilot: ${snap.name} → unsupported (${mapped.reason}) — manual fallback`);
      return null;
    }
    const bundle = mapped.bundle;

    // Action-gating backstop (defense-in-depth). ActionReader now filters
    // debuff-blocked action types out of the candidate pool itself
    // (matchAndPickAction #5 → actorData.blockedActionLabels), so a blocked
    // command should essentially never reach here. This stays as a cheap last
    // resort (e.g. an ActionReader run that skipped BuildContext): if the chosen
    // command is still blocked, hand back to the manual menu — which greys the
    // blocked action so the GM picks a legal one — rather than forcing a refusal.
    const blocked = (snap.blockedActions ?? []).find((b) => b?.label === bundle.command);
    if (blocked) {
      warn(`autopilot: ${snap.name} → command "${bundle.command}" reached backstop still blocked by ${blocked.reason} (ActionReader gating should have caught this) — manual fallback`);
      return null;
    }

    if (!bundle.targetUuids?.length) {
      log(`autopilot: ${snap.name} → mapped bundle has no targets — manual fallback`);
      return null;
    }

    log(`autopilot: ${snap.name} → ${bundle.command} "${ctx.chosenAction?.name}" on ${bundle.targetUuids.length} target(s)`);
    SimMode.note("decide", `${snap.name} → ${bundle.command} "${ctx.chosenAction?.name}" on ${bundle.targetUuids.length} target(s)`);
    return bundle;
  } catch (e) {
    warn("autopilotDecideAction threw", e);
    return null;
  }
}
