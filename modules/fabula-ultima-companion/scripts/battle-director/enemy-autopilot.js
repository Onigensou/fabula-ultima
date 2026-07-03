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
// Scope (v1): enemy side only. If a turn can't be automated (no Action Pattern
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
      name: "Enemy Autopilot (Battle Director)",
      hint: "When on, the Director auto-picks enemy turn order + actions from each monster's Action Pattern, stopping at the action card for you to confirm. Enemies with no Action Pattern fall back to the manual menu.",
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
  return isAutopilotEnabled() ? "Enemy Autopilot: ON (click for manual)" : "Enemy Autopilot: OFF (click to automate)";
}

export function registerAutopilotDevTool() {
  const register = () => registerDevTool({
    id: "enemy-autopilot",
    icon: autopilotToolIcon(),
    label: autopilotToolLabel(),
    onClick: async () => {
      await setAutopilotEnabled(!isAutopilotEnabled());
      const on = isAutopilotEnabled();
      ui.notifications?.info(`Enemy Autopilot ${on ? "ON — Director drives enemy turns up to the action card." : "OFF — enemy turns are manual."}`);
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
async function think(token, range) {
  const pip = showThinkingPip(token);
  try { await jitterDelay(range); }
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

// ── Gate: is the CURRENT Director turn an autopilot-eligible enemy NPC? ───────
// v1 scope: enemy side only. Also declines when a player owns the actor AND is
// online — they puppet that enemy manually. Reads dCombat's current combatant.
export function isEnemyNpcTurn(director) {
  try {
    const dc = director?.dCombat;
    if (!dc) return false;
    const cur = dc.combatants?.find?.((c) => c.id === dc.currentCombatantId) ?? null;
    if (!cur || cur.side !== "enemy") return false;
    const actor = cur.actorDoc ?? null;
    if (actor?.hasPlayerOwner) {
      const ownedOnline = (game.users?.contents ?? []).some(
        (u) => !u.isGM && u.active && actor.testUserPermission?.(u, "OWNER"),
      );
      if (ownedOnline) return false;
    }
    return true;
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
export async function autopilotDecideAction(director, snap) {
  try {
    const token = canvas?.tokens?.get(snap?.tokenId) ?? null;
    if (!token) { log("autopilot: DECLARE has no canvas token — manual fallback"); return null; }

    // Foundry combatant (for ActionReader anti-repeat memory + disposition).
    const combat = director?.combat ?? game.combat ?? null;
    const combatant = combat?.combatants?.find?.((c) => c.tokenId === snap.tokenId) ?? null;

    // Show the pip WHILE the AI deliberates + for a jittered "reading" beat, so
    // the pause overlaps the actual compute rather than adding pure dead time.
    const pip = showThinkingPip(token);
    let ctx = null;
    try {
      ctx = await runActionReader({ token, combat, combatant });
      await jitterDelay(AUTOPILOT_TIMING.decision);
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

    // Action-gating backstop: if the chosen command is blocked (Frightened bars
    // Attack, etc.), don't force a refusal at DECLARE — hand back to the manual
    // menu, which greys the blocked action so the GM picks a legal one.
    const blocked = (snap.blockedActions ?? []).find((b) => b?.label === bundle.command);
    if (blocked) {
      log(`autopilot: ${snap.name} → command "${bundle.command}" blocked by ${blocked.reason} — manual fallback`);
      return null;
    }

    if (!bundle.targetUuids?.length) {
      log(`autopilot: ${snap.name} → mapped bundle has no targets — manual fallback`);
      return null;
    }

    log(`autopilot: ${snap.name} → ${bundle.command} "${ctx.chosenAction?.name}" on ${bundle.targetUuids.length} target(s)`);
    return bundle;
  } catch (e) {
    warn("autopilotDecideAction threw", e);
    return null;
  }
}
