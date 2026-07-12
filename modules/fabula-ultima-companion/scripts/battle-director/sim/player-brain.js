// Player Brain — decides a turn for a combatant with no Action Pattern (the PCs).
//
// Enemies think with ActionReader because they carry an `action_pattern_table`
// prop. PCs don't have one, so their ActionReader run yields nothing and the
// autopilot would hand back to the manual menu — which, with nobody at the
// keyboard, is a hang. This is what answers instead.
//
// The design: rather than write a bespoke AI, we feed the SAME ActionReader
// pipeline a rotation table injected from a profile ([[profiles.js]]). The
// injection point is `actorData.actionPatternRowsRaw` — the exact field
// readPatternTable reads — so the party inherits cost feasibility, affinity
// targeting, anti-repeat and debuff gating with ZERO changes to the action-reader.
//
// Decision order, each step falling through to the next:
//   1. profile.policy()  — pre-emptive code decisions (heal a dying ally). The
//                          rotation table cannot express these: every condition
//                          the engine supports is self-referential, so "an ally is
//                          hurt" is unsayable as a row.
//   2. rotation          — the profile's rows, through ActionReader.
//   3. basic attack      — affinity-aware: never swing an element the target
//                          ABSORBS, prefer one it is VULNERABLE to.
//   4. null              — caller (enemy-autopilot) terminally falls back to Guard.
//
// See [[project_action_pattern_ai]] and [[project_enemy_autopilot]].

import { log, warn } from "../logger.js";
import { profileFor } from "./profiles.js";
import { SimMode } from "./sim-mode.js";
import { canAffordItem } from "./cost.js";
import { protectExhausted } from "./reaction-brain.js";

import { ActionReaderCore as AR } from "../../action-reader/actionReader-core.js";
import { resolveActionReaderPerformer } from "../../action-reader/actionReader-resolvePerformer.js";
import { buildActionReaderContext } from "../../action-reader/actionReader-buildContext.js";
import { readActionReaderPatternTable } from "../../action-reader/actionReader-readPatternTable.js";
import { evaluateActionReaderConditions } from "../../action-reader/actionReader-evaluateConditions.js";
import { matchAndPickActionReaderAction } from "../../action-reader/actionReader-matchAndPickAction.js";
import { parseActionReaderTargetRule } from "../../action-reader/actionReader-parseTargetRule.js";
import { buildAndPickActionReaderTargets } from "../../action-reader/actionReader-buildAndPickTargets.js";

// ── Board access ────────────────────────────────────────────────────────────
function selfCombatant(director, snap) {
  return director?.dCombat?.combatants?.find?.((c) => c.tokenId === snap?.tokenId) ?? null;
}

function sides(director, snap) {
  const dc = director?.dCombat;
  const mine = selfCombatant(director, snap)?.side ?? "party";
  const all = (dc?.combatants ?? []).filter((c) => !c.isDefeatedLive?.());
  return {
    allies: all.filter((c) => c.side === mine),
    foes: all.filter((c) => c.side !== mine),
  };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const hpOf = (dc) => num(dc?.actorDoc?.system?.props?.current_hp) ?? Infinity;
const tokenUuidOf = (dc) => dc?.tokenUuid ?? dc?.tokenDoc?.uuid ?? null;

// CSB stores the equipped hand as a bare name; empty/SHI means nothing usable
// (see readWeapon in snapshot.js). Better to Guard than to emit an Attack the
// TARGET stage cannot resolve a weapon for.
function hasMainWeapon(actorDoc) {
  const raw = String(actorDoc?.system?.props?.main_hand ?? "").trim();
  return raw !== "" && raw.toUpperCase() !== "SHI";
}

// ── Is this an AUGMENT rather than an action? ────────────────────────────────
// Three times now a profile has tried to "cast" something that is not castable.
// Zarg's Barrage, Warning Shot and High Speed, and his Gadgets, are all AUGMENTS:
// they carry a reaction trigger and fire ON another action (or at conflict start),
// buffing it. Declaring one as a turn action burns the turn and does nothing — the
// exact symptom of "Zarg keeps casting Barrage and never attacks".
//
// The tell is structural, not a name list: a trigger-driven skill with NO target
// has nothing to be cast AT. A real castable skill always names a target ("Self",
// "One Enemy", "Up to three creatures"). So encode the rule once, here, and the
// next augment somebody adds can't fool a rotation either.
function isAugment(item) {
  const p = item?.system?.props ?? {};
  const target = String(p.skill_target ?? "").trim();
  if (target && target !== "-") return false;   // it has something to aim at → castable

  const rc = p.reaction_config_table;
  const rows = Array.isArray(rc) ? rc : Object.values(rc ?? {});
  return rows.some((r) => String(r?.reaction_trigger ?? "").trim() !== "");
}

// ── Affinity-aware target choice for the BASIC ATTACK ────────────────────────
// The first live run had the party plinking a boss with no regard for what it was
// immune to. A basic attack carries the weapon's damage type, so score every
// living foe by how that element lands, and break ties by who is closest to dying.
const AFFINITY_SCORE = { VU: 3, NA: 1, RS: 0.4, IM: 0, AB: -5 };

function bestAttackTarget(actorDoc, foes) {
  const element = String(actorDoc?.system?.props?.weapon1_damagetype ?? "").trim().toLowerCase();

  const scored = foes.map((dc) => {
    // getAffinityForType takes the ACTOR (it resolves the map itself) and
    // normalizes the damage type for us.
    let aff = "NA";
    try {
      if (element) aff = AR.getAffinityForType(dc.actorDoc, element) ?? "NA";
    } catch { /* unknown element → treat as neutral */ }
    const affScore = AFFINITY_SCORE[String(aff).toUpperCase()] ?? 1;
    return { dc, aff, affScore, hp: hpOf(dc) };
  });

  // Prefer anything we don't actively feed. Only if EVERY foe absorbs/ignores our
  // element do we accept the least-bad one — swinging is still better than idling.
  const viable = scored.filter((s) => s.affScore > 0);
  const pool = viable.length ? viable : scored;

  pool.sort((a, b) => (b.affScore - a.affScore) || (a.hp - b.hp));
  return pool[0] ?? null;
}

// ── Bundle builders (PC shapes) ──────────────────────────────────────────────
// A PC weapon attack is `attackMode: "main"` with NO item uuid — TARGET derives
// the weapon from the equipped hand. (An NPC attack is the other shape entirely:
// attackMode "npc" + npcAttackItemUuid. Don't cross the two.)
const attackBundle = (targetUuids) => ({ command: "Attack", attackMode: "main", targetUuids });

function castBundle(item, targetUuids) {
  const st = String(item?.system?.props?.skill_type ?? "").trim().toLowerCase();
  const command = st === "spell" ? "Spell" : "Skill";
  // `_name` is carried for the re-declare guard + transcript. applyComposedBundle
  // ignores unknown keys, so it costs nothing downstream.
  return { command, skillUuid: item.uuid, sourceItemUuid: item.uuid, targetUuids, _name: item.name };
}

// ── The policy API handed to profile.policy() ────────────────────────────────
function makePolicyApi(director, snap, self) {
  const { allies, foes } = sides(director, snap);
  return {
    self: self?.actorDoc ?? null,
    round: director?.dCombat?.round ?? 0,
    allies: () => allies,
    foes: () => foes,

    findItem(name) {
      const want = String(name).trim().toLowerCase();
      return self?.actorDoc?.items?.find?.((i) => String(i.name).trim().toLowerCase() === want) ?? null;
    },

    castOn(item, targetDcs) {
      const uuids = targetDcs.map(tokenUuidOf).filter(Boolean);
      if (!item || !uuids.length) return null;
      // An augment fires ON an action; it cannot BE one. Same guard as the
      // rotation, so a hand-written policy can't make this mistake either.
      if (isAugment(item)) {
        warn(`[SIM] policy tried to cast the augment "${item.name}" — that is a reaction, not a turn action`);
        return null;
      }
      // Only offer an action we can actually pay for — feasibility upstream can't
      // price custom resources (see cost.js).
      if (!canAffordItem(self?.actorDoc, item).ok) return null;
      return castBundle(item, uuids);
    },

    // A combatant's affinity to an element ("VU"/"RS"/"IM"/"AB"/"NA").
    affinityOf(dc, element) {
      try { return String(AR.getAffinityForType(dc?.actorDoc, element) ?? "NA").toUpperCase(); }
      catch { return "NA"; }
    },

    // Pre-answer the menu this action is about to open (Zarg's Gadgets element).
    // Consumed once, by the next picker.
    hintPick(hint) { SimMode.setPickHint(hint); },

    // Has the party's defensive answer already been spent this round? Hina's heal
    // is explicitly gated on this.
    protectExhausted(round) { return protectExhausted(round); },
  };
}

// ── The rotation: profile rows through the real ActionReader ─────────────────
async function runRotation({ token, combat, combatant, actorDoc, rows, blocked }) {
  const rowName = (r) => String(r?.data?.action_pattern_name ?? "").trim();

  // Drop anything that already bounced this turn, and anything the actor cannot
  // PAY for. The affordability pass is ours because ActionReader's feasibility
  // check only prices mp/ip/zenit — see cost.js. Both filters run BEFORE the
  // engine sees the rows, so the priority window and weighted pick only ever
  // consider actions that can actually happen.
  const filteredRows = rows.filter((r) => {
    const name = rowName(r);
    if (blocked?.has(name.toLowerCase())) return false;

    const item = actorDoc?.items?.find?.((i) => String(i.name).trim().toLowerCase() === name.toLowerCase());
    if (!item) return true;   // not an item we own → let the engine drop it

    // An augment can't be declared as a turn action — it fires on one.
    if (isAugment(item)) {
      SimMode.note("rotation", `${actorDoc.name}: "${name}" is an augment, not an action — the reaction brain owns it`);
      return false;
    }

    const afford = canAffordItem(actorDoc, item);
    if (!afford.ok) {
      SimMode.note("cost", `${actorDoc.name} can't afford ${name} (${afford.have ?? 0}/${afford.need} ${afford.res})`);
      return false;
    }
    return true;
  });
  if (!filteredRows.length) return null;
  try {
    const ctx = AR.createBaseContext();

    await resolveActionReaderPerformer(ctx, { token, combat, combatant });
    if (!ctx.performer?.actor) return null;

    await buildActionReaderContext(ctx);
    if (!ctx.actorData) return null;

    // THE INJECTION. readPatternTable reads exactly this field; a PC has no
    // action_pattern_table prop, so we hand it the profile's rows instead. No
    // action-reader edit, and every downstream stage behaves as it does for a
    // monster.
    ctx.actorData.actionPatternRowsRaw = filteredRows;

    await readActionReaderPatternTable(ctx);
    await evaluateActionReaderConditions(ctx);
    await matchAndPickActionReaderAction(ctx);
    if (!ctx.chosenAction) return null;

    await parseActionReaderTargetRule(ctx);
    await buildAndPickActionReaderTargets(ctx);
    if (!ctx.chosenTargets?.length) return null;

    const item = ctx.chosenAction.item
      ?? (ctx.chosenAction.itemSnapshot?.uuid ? await fromUuid(ctx.chosenAction.itemSnapshot.uuid) : null);
    if (!item?.uuid) return null;

    const uuids = ctx.chosenTargets.map((t) => t?.tokenDocument?.uuid ?? t?.uuid).filter(Boolean);
    if (!uuids.length) return null;

    return { bundle: castBundle(item, uuids), name: item.name };
  } catch (e) {
    warn("[SIM] player-brain: rotation threw", e);
    return null;
  }
}

// ── Public ───────────────────────────────────────────────────────────────────
// Returns a compose bundle, or null to let the caller fall back to Guard.
// `blocked` = action names that already bounced this turn (SimMode's re-declare
// guard) — skip them at every layer, or we just re-offer the thing that failed.
export async function decidePlayerAction(director, snap, blocked = new Set(), allowedLabels = null) {
  const self = selfCombatant(director, snap);
  const actorDoc = self?.actorDoc ?? null;
  if (!actorDoc) return null;

  const profile = profileFor(actorDoc.name);
  const { foes } = sides(director, snap);
  const isBlocked = (name) => blocked.has(String(name ?? "").trim().toLowerCase());

  // A FREE ACTION grant restricts what may be declared (Zarg's Barrage grants a
  // free ATTACK; Counter Pass grants only Passes). The Octopath menu greys the
  // rest out, so the brain must honour the same allow-list — otherwise it offers
  // a Skill the free action can't be spent on, the declaration bounces, and the
  // granted attack is silently lost. Which is exactly what happened: Zarg cast
  // Barrage every turn and never once fired the shot it paid for.
  const allow = Array.isArray(allowedLabels) && allowedLabels.length
    ? new Set(allowedLabels.map((l) => String(l).trim().toLowerCase()))
    : null;
  const permits = (cmd) => !allow || allow.has(String(cmd).trim().toLowerCase());

  // 1. Policy — the things a rotation table cannot say (heal a dying ally).
  if (typeof profile.policy === "function") {
    try {
      const bundle = profile.policy(makePolicyApi(director, snap, self));
      if (bundle && !isBlocked(bundle._name) && permits(bundle.command)) return bundle;
    } catch (e) {
      warn(`[SIM] player-brain: ${actorDoc.name} policy threw — falling through`, e);
    }
  }

  // 2. Rotation — the profile's rows, through the monsters' own AI engine.
  const token = canvas?.tokens?.get(snap?.tokenId) ?? null;
  const combat = director?.combat ?? game.combat ?? null;
  const combatant = combat?.combatants?.find?.((c) => c.tokenId === snap?.tokenId) ?? null;

  // Under a free-action grant that doesn't permit Skill/Spell (the common case:
  // "Attack"), skip the rotation entirely and go spend the granted attack.
  const rotationAllowed = permits("Skill") || permits("Spell");

  if (token && rotationAllowed) {
    const picked = await runRotation({ token, combat, combatant, actorDoc, rows: profile.rows, blocked });
    if (picked && permits(picked.bundle.command)) return picked.bundle;
  }

  // 3. Basic attack, aimed with its head up. Also the landing spot for a granted
  // free Attack.
  if (!permits("Attack")) return null;
  if (!hasMainWeapon(actorDoc)) {
    log(`[SIM] player-brain: ${snap?.name} has no main-hand weapon`);
    return null;
  }
  if (!foes.length) return null;

  const pick = bestAttackTarget(actorDoc, foes);
  const uuid = pick ? tokenUuidOf(pick.dc) : null;
  if (!uuid) return null;

  SimMode.note("attack", `${snap?.name} swings at ${pick.dc.name} [${pick.aff}]`);
  return attackBundle([uuid]);
}
