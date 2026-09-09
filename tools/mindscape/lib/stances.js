"use strict";
//
// Mindscape — the stance cycle.
//
// WHY THIS EXISTS
// `chooseAction` picks the affordable action with the highest projected damage.
// It has no notion of the live `action_pattern_table`, so a monster that must
// spend an activation ARMING before it may attack was modelled as attacking on
// every activation. For a 4-activation boss whose real cadence is
// Shift → Strike → Shift → Strike that is a 2x overstatement of its entire
// output — the single largest error the model could make about such a fight,
// and invisible in the verdict because the number it produces is a perfectly
// plausible one.
//
// This is a deliberately SMALL abstraction. It does not implement action
// patterns (conditions, priorities, weighted windows, cooldowns, target focus);
// it implements the one structural fact those patterns are used to express here:
// some actions are locked behind a state that another action grants, and using
// them spends it.
//
//   mindscape_stance_grants: "Sword,Bow,Throwing,Flail"
//       This action is an ARMING action. It deals no damage, costs the
//       activation, and sets the actor's stance to one of these, drawn at
//       random EXCLUDING the current one — mirroring `ae_pool_skip_existing`,
//       which is how the live Form Shift guarantees it never redraws.
//
//   mindscape_stance_requires: "Sword"
//       This action is only legal while holding that stance, and CONSUMES it.
//
// Everything else about the cycle then falls out on its own: with no stance the
// only legal action is the arming one, and after a strike the stance is gone —
// so the alternation is a consequence of the rules rather than a scripted
// sequence, exactly as it is in play.
//
// LIMIT, stated rather than hidden: the arming action's choice is uniform over
// the other stances. The live version is also a random pool draw, so this is
// faithful TODAY — but a future Rakshasa that picks its form tactically (say,
// Sword whenever a PC is in Crisis) would be modelled as dumber than it plays.

// GRANTS THE INFERENCE CANNOT SEE.
//
// The inference below reads an action's OWN effect_table. Asura's arming works
// differently: 'Sword Enchant - Fire' applies only a self-buff, and it is the
// PASSIVE 'Elemental Aspect' that stamps `Enchanted` (and the Aspect) when an
// enchant is used, with `Ascension` stamping the Mark. The link between action
// and status therefore lives in the live trigger graph, which this model does
// not read at all -- no amount of local inference can recover it.
//
// Declared here rather than as mindscape_* props on the world actor: the world
// is the game's data, not the simulator's, and a sim-only prop on a shipped
// monster is exactly the kind of thing that gets wiped by the next rebuild.
//
// `persistent` means the status is NOT spent by the action it gates -- see
// stanceConsumes below.
const GRANT_OVERRIDES = {
  "sword enchant - fire": { grants: ["Enchanted"], persistent: true },
  "sword enchant - bolt": { grants: ["Enchanted"], persistent: true },
  "sword enchant - ice":  { grants: ["Enchanted"], persistent: true },
  "sword enchant - air":  { grants: ["Enchanted"], persistent: true },
};

function splitList(raw) {
  return String(raw ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Read the stance fields for a skill.
//
// Two sources, in order:
//   1. `mindscape_stance_*` on the item — an explicit declaration, used by paper
//      specs where there is no action_pattern_table to infer from.
//   2. INFERRED from the shipped data, so a monster already in the world models
//      correctly with nothing authored for the sim's benefit. Inference beats
//      declaration here: a hand-maintained mirror of live data drifts, and the
//      drift is silent.
//
// The inference is deliberately narrow, and both halves must agree:
//   · a skill the action_pattern gates on `self_has_status: "X"` REQUIRES X
//   · a skill whose apply_ae draws from a pool of names, where those names are
//     the very statuses other rows gate on, GRANTS one of them
// So "an action that hands out the states other actions are locked behind" is
// what identifies the cycle — not a name, a flag, or a guess about intent.
function readStanceFields(props, actor, itemName) {
  const override = GRANT_OVERRIDES[String(itemName ?? "").trim().toLowerCase()];
  if (override) return { stanceGrants: override.grants, stanceRequires: null };

  const declaredGrants = splitList(props?.mindscape_stance_grants);
  const declaredRequires = String(props?.mindscape_stance_requires ?? "").trim() || null;
  if (declaredGrants.length || declaredRequires) {
    return {
      stanceGrants: declaredGrants.length ? declaredGrants : null,
      stanceRequires: declaredRequires,
    };
  }

  const gated = gatedStatuses(actor);
  if (!gated.size) return null;

  // REQUIRES — this skill's own row in the pattern gates on a status.
  const name = String(itemName ?? "").trim().toLowerCase();
  for (const row of patternRows(actor)) {
    if (String(row.action_pattern_name ?? "").trim().toLowerCase() !== name) continue;
    if (String(row.action_pattern_condition ?? "").trim().toLowerCase() !== "self_has_status") continue;
    const st = String(row.action_pattern_string ?? "").trim();
    if (st) return { stanceGrants: null, stanceRequires: st, stanceConsumes: spendsStatus(props, st) };
  }

  // GRANTS — a self-targeted apply_ae drawing from a pool of those same statuses.
  for (const row of Object.values(props?.effect_table ?? {})) {
    if (row?.$deleted) continue;
    if (String(row.effect_kind ?? "").trim().toLowerCase() !== "apply_ae") continue;
    const pool = splitList(row.ae_name_pool);
    if (pool.length < 2) continue;
    if (!pool.every((n) => gated.has(n.toLowerCase()))) continue;
    return { stanceGrants: pool, stanceRequires: null };
  }

  return null;
}

// Does this action SPEND the status it is gated on?
//
// Rakshasa's strikes each carry a remove_ae naming their own stance, which is
// what makes Shift -> Strike -> Shift -> Strike a cadence rather than one Shift
// followed by unlimited strikes. Asura's enchanted slash carries no such row:
// `Enchanted` persists, so it arms ONCE and then swings for the rest of the
// fight. Treating every gated action as consuming would have halved Asura's
// output; treating none as consuming would have doubled Rakshasa's. The
// distinction is in the data, so read it rather than assuming either way.
function spendsStatus(props, status) {
  const want = String(status ?? "").trim().toLowerCase();
  if (!want) return false;
  for (const row of Object.values(props?.effect_table ?? {})) {
    if (row?.$deleted) continue;
    if (String(row.effect_kind ?? "").trim().toLowerCase() !== "remove_ae") continue;
    if (String(row.ae_template_ref ?? "").trim().toLowerCase() === want) return true;
  }
  return false;
}

function patternRows(actor) {
  const t = actor?._rawProps?.action_pattern_table ?? {};
  return Object.values(t).filter((r) => r && !r.$deleted);
}

// The `hp` pattern condition, as an inclusive PERCENT range — the form the live
// evaluator uses (value_1/value_2 are min%/max%, NOT a threshold plus a chance).
//
// Without this the model cannot see a phase change that is expressed as two
// rows split across the HP bar: both would read legal at once and the greedy
// picker would silently take whichever came first in item order, so a whole
// Crisis kit could look like it never existed. Returns null for every other
// condition, which is the common case.
function readHpGate(actor, itemName) {
  const name = String(itemName ?? "").trim().toLowerCase();
  for (const row of patternRows(actor)) {
    if (String(row.action_pattern_name ?? "").trim().toLowerCase() !== name) continue;
    if (String(row.action_pattern_condition ?? "").trim().toLowerCase() !== "hp") continue;
    const a = Number(row.action_pattern_value_1);
    const b = Number(row.action_pattern_value_2);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  return null;
}

// Percent of max HP, ceil'd — matches evaluatePercentageRangeCondition.
function hpGateOpen(gate, actor) {
  if (!gate) return true;
  const max = actor?.maxHp || 0;
  if (!max) return true;
  const pct = Math.ceil((actor.hp / max) * 100);
  return pct >= gate.min && pct <= gate.max;
}

// Every status the action pattern locks an action behind.
function gatedStatuses(actor) {
  const out = new Set();
  for (const row of patternRows(actor)) {
    if (String(row.action_pattern_condition ?? "").trim().toLowerCase() !== "self_has_status") continue;
    const st = String(row.action_pattern_string ?? "").trim();
    if (st) out.add(st.toLowerCase());
  }
  return out;
}

// Is this action legal for the actor right now?
// An action requiring a stance needs that exact stance held. An arming action is
// legal only when it would actually change something — an actor already holding
// a stance must spend it before re-arming, which is what stops the model from
// burning every activation on Form Shift when that scores no damage.
function isLegal(action, actor) {
  // An hp-gated row is simply not on the menu outside its band.
  if (!hpGateOpen(action?.hpGate, actor)) return false;
  if (action?.stanceRequires) return actor.stance === action.stanceRequires;
  if (action?.stanceGrants) return actor.stance == null;
  // An actor inside a stance cycle must not fall back on its unstanced actions;
  // otherwise the arming cost is free and the cadence collapses back to 2x.
  if (actor.stanceCycle) return false;
  return true;
}

// Does this actor participate in the stance cycle at all? Derived from its
// actions so a spec cannot forget to declare it.
// A cycle exists only if something can actually ARM it. Asura reached this file
// with two actions gated on statuses and nothing recognised as granting them:
// every gated action was illegal for want of the status, and isLegal's
// `stanceCycle` guard then made its ONE ungated attack illegal too, so the
// monster silently did nothing for an entire run and reported 100% party HP.
// A monster that cannot act is never the answer -- if nothing grants, there is
// no cycle to protect and the ungated actions must stay available.
function hasStanceCycle(actions) {
  const list = actions ?? [];
  const grants = list.some((a) => a.stanceGrants);
  const requires = list.some((a) => a.stanceRequires);
  return grants && requires;
}

// Reported by the caller so the lockout can never be silent again.
function brokenCycle(actions) {
  const list = actions ?? [];
  if (list.some((a) => a.stanceGrants)) return null;
  const req = [...new Set(list.filter((a) => a.stanceRequires).map((a) => a.stanceRequires))];
  return req.length ? req : null;
}

// Apply an arming action. Returns the stance taken, or null if it could not arm.
// `rng` is the seeded generator — never Math.random, or runs stop reproducing.
function arm(actor, action, rng) {
  const pool = (action.stanceGrants ?? []).filter((s) => s !== actor.stance);
  if (!pool.length) return null;
  const next = rng.pick(pool);
  actor.stance = next;
  return next;
}

// A strike spends the stance it required.
function consume(actor, action) {
  if (action?.stanceConsumes === false) return;
  if (action?.stanceRequires && actor.stance === action.stanceRequires) actor.stance = null;
}

module.exports = { readStanceFields, isLegal, hasStanceCycle, brokenCycle, arm, consume, splitList, readHpGate, hpGateOpen };
