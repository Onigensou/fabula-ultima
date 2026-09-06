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
import { freeActions } from "./free-actions.js";

// ── ActionReader pipeline (direct ESM import — same singleton the world macro
//    drives through the module API). We run every stage EXCEPT AnnounceResult:
//    we want the picked data, not the GM whisper. ──────────────────────────────
import { ActionReaderCore } from "../action-reader/actionReader-core.js";
import { resolveActionReaderPerformer } from "../action-reader/actionReader-resolvePerformer.js";
import { buildActionReaderContext } from "../action-reader/actionReader-buildContext.js";
import { readActionReaderPatternTable } from "../action-reader/actionReader-readPatternTable.js";
import { isBrainDrivableSummon, maybeInjectSummonFallbackPattern, synthesizeSummonPatternRows } from "./summon-autopilot.js";
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
async function runActionReader({ token, combat, combatant, activationIndex, director = null, directorCombatant = null }) {
  try {
    let ctx = ActionReaderCore.createBaseContext();

    await resolveActionReaderPerformer(ctx, { token, combat, combatant });
    if (!ctx.performer?.actor) { log("autopilot: ActionReader resolvePerformer produced no actor"); return null; }

    // The `activation` pattern condition reads this override (1-based slot of
    // the performer's current round). Absent/0 = condition fails closed.
    const overrides = Number.isFinite(activationIndex) && activationIndex > 0
      ? { activationIndex: Math.trunc(activationIndex) }
      : {};
    await buildActionReaderContext(ctx, { overrides });
    // A summon the autopilot is driving but nobody authored a pattern for gets one
    // synthesized from its own actions. Must sit between BuildContext (which fills
    // actionPatternRowsRaw) and ReadPatternTable (which is the only reader of it).
    // No-op for everything else, including an unpatterned MONSTER — a blank pattern
    // is that dev's documented way to keep a GM actor off the AI.
    maybeInjectSummonFallbackPattern(ctx, directorCombatant);
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
    // In a sim, EVERY declaration is the AI's — including the ones that are not a
    // "turn" at all.
    //
    // This lookup resolves the CURRENT combatant, and a FREE ACTION is not taken by the
    // current combatant: it is taken by the REACTOR, on somebody else's turn (or, for a
    // conflict_start grant like High Speed, before anyone's turn — where
    // currentCombatantId is still null and this returned false outright).
    //
    // So the autopilot gate never fired for those declarations, DECLARE fell straight
    // through to composeAction, and the free action was forfeited: the journal showed
    // Acceleration firing and queueing (queued:2) and then "nothing legal to declare"
    // with no grant line, because the brain was never even asked.
    if (SimMode.active) return true;

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
  // A live free-action grant (Shadow Strike / Shadowbringers free Attack, Barrage,
  // Dance…) carries an allow-list of what it may be spent on. ActionReader is
  // grant-BLIND: for a PATTERNED NPC (a boss) it would ignore the grant and re-pick a
  // whole new turn action from the pattern — silently discarding the granted Attack, so
  // the free-attack half of a combo never fires. A PC has no pattern, so this never bit
  // the party; it only surfaces on monsters. When a grant is live, route straight to the
  // grant-aware fallback (which honours enabledLabels) instead of the pattern. The
  // orphaned-grant clear in DECLARE runs just before this, so a grant present here is a
  // legitimate free-action frame.
  if (SimMode.active) {
    // Skill-under-test: a scripted directive FORCES this combatant to cast a chosen
    // skill (see sim/scripted-action.js). Checked before everything else so the
    // directive wins over both the free-action fallback and the pattern table. When
    // it doesn't apply — no directive, unaffordable, no target, or it already bounced
    // this turn — it returns null and the normal chain below takes over.
    try {
      const { scriptedBundleFor } = await import("./sim/scripted-action.js");
      const scripted = await scriptedBundleFor(director, snap);
      if (scripted) return scripted;
    } catch (e) { warn("autopilotDecideAction: scripted-action check threw", e); }

    try {
      const { freeActions } = await import("./free-actions.js");
      const grant = freeActions.get?.(snap?.actorId) ?? null;
      if (grant?.enabledLabels?.length) return await simFallbackBundle(director, snap);
    } catch (e) { warn("autopilotDecideAction: free-action grant check threw", e); }
  }

  // Real-play free-action frame (Option B → A ladder). If a compose-style
  // free-action grant is live for this actor, the FSM is inside a
  // FREE_ACTION_WINDOW and this DECLARE must spend the grant on what it PERMITS —
  // NOT re-read the whole turn pattern. Running decideViaActionReader here is
  // exactly the Shadowbringers bug: it is grant-BLIND, re-picks a fresh turn
  // action (e.g. Shadowbringers again), and applyComposedBundleAndAdvance injects
  // it straight past the grant's Octopath allow-list → the granting skill
  // re-fires → infinite loop, turn never advances. So on a free frame we resolve
  // the grant directly (auto); if we can't do it cleanly we return null → the
  // GM's grant-filtered compose menu (manual, the last-resort rung). Either way we
  // NEVER fall through to the pattern read below. The sim path above already does
  // the equivalent via simFallbackBundle; this is the real-play twin.
  //
  // A grant readable HERE is a reliable "we are in a free frame" signal: DECLARE's
  // orphan guard clears any stray grant on a normal turn BEFORE autopilot runs,
  // and a `preset` grant is consumed by DECLARE's preset shortcut BEFORE this — so
  // whatever survives to this point is a legitimate compose-style free action.
  if (!SimMode.active) {
    const grant = freeActions.get(snap?.actorId) ?? null;
    if (grant && !grant.preset) {
      return await decideFreeActionBundle(director, snap, grant);
    }
  }

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
  // Is this turn a granted FREE ACTION? If so it carries an allow-list of the
  // commands it may be spent on (Barrage grants a free Attack), exactly as the
  // Octopath menu would enforce. Pass it down or the brain re-picks a Skill and
  // the granted action is thrown away.
  // The WHOLE grant is threaded down, not just its labels: it also carries the spell MP
  // cap (Acceleration: ≤10), the skill allow-list (Counter Pass: Passes only) and any
  // locked target. Passing only the labels meant the brain could not answer a Skill
  // grant at all, so the FSM fell back to the manual menu and a human had to click.
  let grant = null;
  let freeTag = "";
  try {
    const { freeActions } = await import("./free-actions.js");
    const g = freeActions.get?.(snap?.actorId);
    if (g?.enabledLabels?.length) {
      grant = g;
      freeTag = `:free:${g.sourceLabel ?? "?"}`;
      SimMode.note(
        "free-action",
        `${snap?.name} has a free action from ${g.sourceLabel ?? "?"} (${g.enabledLabels.join(", ")}`
        + `${g.maxMpCost != null ? `, ≤${g.maxMpCost} MP` : ""}`
        + `${g.allowedSkillRefs?.length ? `, only: ${g.allowedSkillRefs.join("/")}` : ""})`
      );
    }
  } catch (e) { warn("[SIM] free-action lookup threw", e); }

  const allowedLabels = grant?.enabledLabels ?? null;

  // The free action gets its OWN declaration space. Without `freeTag` a granted
  // free Attack collides with the Attack the same combatant may already have made
  // this round — the re-declare guard would read that as a bounce and Guard
  // instead of taking the free shot.
  const turnKey = `${director?.dCombat?.round ?? 0}:${snap?.combatantId ?? snap?.tokenId ?? "?"}${freeTag}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    let bundle = null;
    try {
      bundle = await decidePlayerAction(director, snap, SimMode.blockedForTurn(turnKey), grant);
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

  // Terminal fallback. On a NORMAL turn, Guard always composes and always resolves.
  //
  // Under a FREE-ACTION grant it is a trap: the grant's enabledLabels do not include
  // Guard (Dance permits only "Skill"), so declaring it is illegal, the FSM rejects it
  // and re-opens the compose menu — which is precisely the menu a human then had to
  // click. A free action we cannot answer should be DECLINED, not Guarded: returning
  // null lets DECLARE fall through to composeAction, which in a sim cancels rather than
  // prompting (see compose-action.js).
  const grantLabels = (allowedLabels ?? []).map((l) => String(l).trim().toLowerCase());
  if (grantLabels.length && !grantLabels.includes("guard")) {
    SimMode.note("decide", `${snap?.name} → declines the free action (nothing legal to spend it on)`);
    return null;
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

    // Which activation of this combatant's round is this? (1-based.) nextTurn
    // decrements turnsRemaining AFTER the turn completes, so mid-turn the
    // current activation is still counted in turnsRemaining.
    const dc = director?.dCombat?.findByTokenId?.(snap?.tokenId) ?? null;
    const activationIndex = dc && Number.isFinite(dc.turnsPerRound) && Number.isFinite(dc.turnsRemaining)
      ? Math.max(1, dc.turnsPerRound - dc.turnsRemaining + 1)
      : 0;

    // Show the pip WHILE the AI deliberates + for a jittered "reading" beat, so
    // the pause overlaps the actual compute rather than adding pure dead time.
    // In a sim both the pip and the jitter follow the run's pace (nil on fast).
    const inSim = SimMode.active;
    const pip = (inSim && !SimMode.showPip()) ? { remove() {} } : showThinkingPip(token);
    let ctx = null;
    try {
      ctx = await runActionReader({ token, combat, combatant, activationIndex, director, directorCombatant: dc });
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

// ── Free-action grant resolver (Option B — auto; Option A — manual last resort) ─
// A compose-style free-action grant hands the actor a mini-turn restricted to the
// grant's allow-list (`enabledLabels` / `allowedSkillRefs`) — e.g. Shadow Strike's
// free Attack, or Counter Pass's free Pass. It is NOT a licence to run the whole
// turn pattern again. This resolver composes exactly what the grant permits and
// picks targets with ActionReader's own targeting stages, so an AI-controlled boss
// spends its granted sub-actions by itself. Anything it can't resolve cleanly (an
// ambiguous "any Skill/Spell" grant with no named ref, an unaffordable or
// action-gated pick, no legal target, no basic attack) returns null → DECLARE
// falls through to the GM's grant-filtered compose menu. It NEVER returns a bundle
// outside the grant's allow-list — that constraint is what makes the Shadowbringers
// loop structurally impossible rather than merely unlikely.

// Normalize enabledLabels → a lowercase Set, or null for "unrestricted".
function normalizeLabelSet(enabledLabels) {
  if (!Array.isArray(enabledLabels) || !enabledLabels.length) return null;
  const set = new Set(enabledLabels.map((l) => String(l).trim().toLowerCase()).filter(Boolean));
  return set.size ? set : null;
}

// null allow = unrestricted → permits anything.
function labelPermits(allow, command) {
  return !allow || allow.has(String(command).trim().toLowerCase());
}

// skill_type → canonical compose command. Mirrors toBundle / matchAndPickAction.
function commandForItem(item) {
  const st = String(item?.system?.props?.[ActionReaderCore.keys.skillType] ?? "").trim().toLowerCase();
  if (st === "attack") return "Attack";
  if (st === "spell") return "Spell";
  return "Skill"; // active / blank → Skill
}

function buildGrantBundle(command, itemUuid, targetUuids) {
  if (command === "Attack") return { command: "Attack", attackMode: "npc", npcAttackItemUuid: itemUuid, targetUuids };
  if (command === "Spell") return { command: "Spell", skillUuid: itemUuid, sourceItemUuid: itemUuid, targetUuids };
  return { command: "Skill", skillUuid: itemUuid, sourceItemUuid: itemUuid, targetUuids };
}

// Can the actor pay for this item right now? Reads the ActionReader context's
// resource snapshot (mp/ip). Unknown/free cost never blocks (fail-open, matching
// the pattern feasibility filter in matchAndPickAction).
function grantItemAffordable(item, ctx) {
  try {
    const cost = ActionReaderCore.parseActionCost(item?.system?.props?.[ActionReaderCore.keys.cost]);
    if (cost.free) return true;
    if (cost.resource === "mp" || cost.resource === "ip") {
      const pool = cost.resource === "mp" ? ctx?.actorData?.resources?.mp : ctx?.actorData?.resources?.ip;
      const current = ActionReaderCore.toNumber(pool?.current, 0);
      return current >= cost.amount;
    }
    return true;
  } catch { return true; }
}

// Resolve grant.allowedSkillRefs (names or uuids) to the first legal, permitted,
// affordable item on the actor. null when none qualify.
function pickNamedGrantItem(actor, refs, allow, ctx, snap) {
  const items = actor?.items ? Array.from(actor.items) : [];
  for (const it of items) {
    const nm = String(it?.name ?? "").trim().toLowerCase();
    const uid = String(it?.uuid ?? "").trim().toLowerCase();
    if (!refs.includes(nm) && !refs.includes(uid)) continue;
    const command = commandForItem(it);
    if (!labelPermits(allow, command)) continue;
    if ((snap?.blockedActions ?? []).some((b) => b?.label === command)) continue;
    if (!grantItemAffordable(it, ctx)) continue;
    return it;
  }
  return null;
}

// The actor's basic NPC attack item (first of snap.npcAttackItems), resolved to a
// live doc. null for actors with no NPC attack (casters, PC-shaped guests).
async function resolveFirstNpcAttackItem(snap) {
  const list = Array.isArray(snap?.npcAttackItems) ? snap.npcAttackItems : [];
  if (!list.length) return null;
  try { return await fromUuid(list[0].uuid); } catch { return null; }
}

// A grant that names exactly ONE action type has already answered "which kind?",
// so resolving it directly (the basic NPC attack for "Attack") is unambiguous.
// A grant that names SEVERAL — "Attack,Skill" — or none at all has not, and that
// is precisely the question the creature's own Action Pattern exists to answer.
function grantIsAmbiguous(allow) {
  return !allow || allow.size > 1;
}

// Consult the creature's action_pattern_table for a free-action grant. Returns
// the patterned bundle when the grant permits what the pattern chose, else null.
// The grant keeps the final say — this decides WHICH action, never WHETHER one
// is allowed.
// The minimal item shape `synthesizeSummonPatternRows` reads, built straight off
// an actor. BuildContext produces the same three fields inside `actorData.items`,
// but the pattern gate below runs BEFORE any ActionReader context exists, and
// building one just to answer "could we synthesize anything?" would cost a full
// pipeline setup per free-action frame.
function collectSynthItemShapes(actor) {
  return ActionReaderCore.getActorItems(actor).map((item) => {
    const props = ActionReaderCore.getItemProps(item);
    return {
      name: item?.name ?? "",
      skillType: String(props?.[ActionReaderCore.keys.skillType] ?? ""),
      skillTarget: String(props?.[ActionReaderCore.keys.skillTarget] ?? ""),
    };
  });
}

async function tryPatternedGrantPick(director, snap, actor, allow, grant) {
  // decideViaActionReader is grant-BLIND — it is handed the director and snap,
  // never the grant (contrast the sim twin, which passes it to decidePlayerAction).
  // So the ONLY constraint this path can enforce is enabledLabels, checked below.
  // A grant carrying any of the other three would have them silently dropped:
  //   maxMpCost             — Acceleration's "a spell with total MP cost <= 10"
  //   allowedSkillRefs      — Counter Pass's "Passes only"
  //   lockedTargetTokenUuid — a forced target the composed action must hit
  // Refuse rather than resolve it wrongly; the caller falls through to the basic
  // attack or the GM's grant-filtered compose menu, both of which DO honour them.
  const unenforceable = [];
  if (grant?.maxMpCost != null) unenforceable.push("maxMpCost");
  if (grant?.allowedSkillRefs?.length) unenforceable.push("allowedSkillRefs");
  if (grant?.lockedTargetTokenUuid) unenforceable.push("lockedTargetTokenUuid");
  if (grant?.weaponRange) unenforceable.push("weaponRange");
  if (unenforceable.length) {
    log(`autopilot: free-action grant "${grant?.sourceLabel ?? "?"}" carries ${unenforceable.join("+")} which the Action Pattern path cannot enforce — declining the pattern`);
    return null;
  }

  const hasPattern = Object.values(
    actor?.system?.props?.[ActionReaderCore.keys.actionPatternTableKey] ?? {}
  ).some((r) => r && !r[ActionReaderCore.keys.actionPatternDeletedKey]);
  // 🪤 This gate reads the ACTOR's authored table directly, so it short-circuits
  // BEFORE decideViaActionReader — which is where a synthesized pattern gets
  // injected. Leaving it as a bare `if (!hasPattern) return null` would make the
  // fallback dead code on the ONE path that needs it most: a Numen-style summon
  // acts through a free-action grant at its owner's turn end, never through a turn
  // of its own, so this is the only route Birth of the Cruel's Minion ever takes.
  // An automated summon with synthesizable actions is therefore allowed through;
  // decideViaActionReader still returns null if nothing is feasible.
  if (!hasPattern) {
    const sdc = director?.dCombat?.findByTokenId?.(snap?.tokenId) ?? null;
    const canSynthesize = isBrainDrivableSummon(sdc)
      && synthesizeSummonPatternRows({ items: collectSynthItemShapes(actor) }).length > 0;
    if (!canSynthesize) return null;
    log(`autopilot: ${snap.name} has no authored pattern but is an automated summon — trying a synthesized one`);
  }

  const patterned = await decideViaActionReader(director, snap);
  const cmd = patterned?.command ?? patterned?.bundle?.command ?? null;
  if (patterned && cmd && labelPermits(allow, cmd)) {
    log(`autopilot: free-action grant "${grant?.sourceLabel ?? "?"}" for ${snap.name} resolved from its Action Pattern → ${cmd}`);
    return patterned;
  }
  if (patterned && cmd) {
    log(`autopilot: free-action pattern pick ${cmd} not permitted by grant (allow=${allow ? [...allow].join("/") : "any"}) — declining the pattern`);
  }
  return null;
}

async function decideFreeActionBundle(director, snap, grant) {
  try {
    const token = canvas?.tokens?.get(snap?.tokenId) ?? null;
    if (!token) { log("autopilot: free-action frame has no canvas token — manual fallback"); return null; }

    const combat = director?.combat ?? game.combat ?? null;
    const combatant = combat?.combatants?.find?.((c) => c.tokenId === snap.tokenId) ?? null;

    let actor = null;
    try { actor = await fromUuid(snap?.actorUuid); } catch {}
    if (!actor) { log("autopilot: free-action frame — actor doc unresolved — manual fallback"); return null; }

    const allow = normalizeLabelSet(grant?.enabledLabels);
    const refs = Array.isArray(grant?.allowedSkillRefs)
      ? grant.allowedSkillRefs.map((r) => String(r).trim().toLowerCase()).filter(Boolean)
      : [];

    // One ActionReader context, reused for affordability + targeting. The roster
    // and the per-action target survey arrive from the ambient battle provider
    // (target-survey.js), so this frame needs no injection of its own — which is
    // the point: this is the entry point that was missed when they did.
    let ctx = ActionReaderCore.createBaseContext();
    await resolveActionReaderPerformer(ctx, { token, combat, combatant });
    if (!ctx.performer?.actor) { log("autopilot: free-action frame — resolvePerformer produced no actor — manual fallback"); return null; }
    await buildActionReaderContext(ctx, {});

    // Choose the granted item: a named skill first. Then — for a grant that did
    // NOT name a single action type — the creature's Action Pattern, consulted
    // BEFORE the generic NPC-attack fallback.
    //
    // Order is the whole fix here. This block used to run resolveFirstNpcAttackItem
    // first and reach the pattern only `if (!item)`. But any NPC with a basic
    // attack always resolves that call, so `item` was never null and the pattern
    // was DEAD CODE for exactly the creatures that have one — an ambiguous
    // "Attack,Skill" grant silently collapsed to npcAttackItems[0]. Measured
    // 2026-08-26 on Create Phantasm: Numen, whose Crysta could never reach her
    // Crescent Cut. Named refs still win, and a grant naming one type still
    // resolves directly, so only a genuinely ambiguous grant changes hands.
    let item = null;
    if (refs.length) item = pickNamedGrantItem(actor, refs, allow, ctx, snap);

    if (!item && grantIsAmbiguous(allow)) {
      const patterned = await tryPatternedGrantPick(director, snap, actor, allow, grant);
      if (patterned) return patterned;
    }

    if (!item && labelPermits(allow, "Attack")) item = await resolveFirstNpcAttackItem(snap);

    // An UNAMBIGUOUS grant can still land here with nothing resolved — "Skill" on
    // a creature that has no Attack item, say — so the pattern gets its chance
    // before we hand the GM a compose menu. (The ambiguous case already tried.)
    if (!item) {
      if (!grantIsAmbiguous(allow)) {
        const patterned = await tryPatternedGrantPick(director, snap, actor, allow, grant);
        if (patterned) return patterned;
      }
      log(`autopilot: free-action grant "${grant?.sourceLabel ?? "?"}" for ${snap.name} not auto-resolvable (allow=${allow ? [...allow].join("/") : "any"}) — manual fallback`);
      return null;
    }

    const command = commandForItem(item);
    if (!labelPermits(allow, command)) {
      log(`autopilot: free-action pick ${command} "${item.name}" not permitted by grant — manual fallback`);
      return null;
    }
    if ((snap?.blockedActions ?? []).some((b) => b?.label === command)) {
      log(`autopilot: free-action pick ${command} "${item.name}" is action-gated — manual fallback`);
      return null;
    }

    // Targets: a locked target wins; otherwise ActionReader targeting on the item.
    let targetUuids = null;
    if (grant?.lockedTargetTokenUuid) {
      targetUuids = [grant.lockedTargetTokenUuid];
    } else {
      ctx.chosenAction = {
        item,
        name: item.name,
        skillType: String(item.system?.props?.[ActionReaderCore.keys.skillType] ?? ""),
        skillTarget: ActionReaderCore.getActionTargetText(item),
      };
      await parseActionReaderTargetRule(ctx);
      await buildAndPickActionReaderTargets(ctx);
      targetUuids = targetUuidsFrom(ctx.chosenTargets ?? []);
    }
    if (!targetUuids?.length) {
      log(`autopilot: free-action ${command} "${item.name}" resolved no target — manual fallback`);
      return null;
    }

    // UX parity with the pattern path — a brief "thinking" beat + pip.
    await think(token, AUTOPILOT_TIMING.decision);

    const bundle = buildGrantBundle(command, item.uuid, targetUuids);
    log(`autopilot: ${snap.name} free action → ${command} "${item.name}" on ${targetUuids.length} target(s) [grant "${grant?.sourceLabel ?? "?"}"]`);
    SimMode.note("decide", `${snap.name} free action → ${command} "${item.name}" on ${targetUuids.length} target(s)`);
    return bundle;
  } catch (e) {
    warn("autopilot: decideFreeActionBundle threw — manual fallback", e);
    return null;
  }
}
