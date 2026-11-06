// Battle Director — Passive Card: what a firing passive did, and whether it gets a card.
//
// The rule, "one announcement per event" (passive card v2, 2026-11-03), tuned by
// the detail dials in passive-card-config.js: a card for a passive that acts,
// reaches another creature or changes tracked points. A passive that only puts a
// state on its owner is told by that state's pop and icon; one that changed
// nothing (a failed roll, a re-arm of something already Ready, a +0 bonus, a
// points reset at 0) shows nothing.
//
// Two halves:
//   chainProfile()   static: walks the passive's effect chain before it runs.
//   decideAfter()    for a chain quick enough to wait for (no prompt, no
//                    animation, no damage): compares the owner before and after.
// A chain that can't be waited for gets its card up front, tiered by its rows
// (staticTier), so a big moment still shows before it plays out.
//
// Pure apart from the actor/item reads: the offline audit runs it on the export.

import { classifyEffect, TIER as AE, isNpcActor } from "../status-classifier.js";
import { resolveResourceDef } from "../resources.js";

const NS = "fabula-ultima-companion";

// Row fields that name another step of the same chain (skill-forge/graph-model.js REF_FIELDS).
const STEP_FIELDS = ["chain_steps", "menu_option_refs", "on_hit_effect_refs", "confirm_button_refs",
  "chain_then_ref", "chance_then_ref", "chance_else_ref"];

// Riders change the action in flight (its damage, accuracy, cost, element, keywords).
const RIDERS = new Set(["adjust_damage", "adjust_accuracy", "adjust_defense", "adjust_grant", "adjust_cost",
  "change_damage_element", "apply_action_keyword", "check_buff"]);

// What a card can wait for: one document write or less, no prompt, no animation.
const QUICK = new Set(["chain", "chance", "apply_ae", "remove_ae", "remove_tagged_ae", "adjust_charges",
  "consume_charge", "grant", "consume_resource", "set_resource", ...RIDERS]);

// Triggers where the owner and the other creature are trading blows: whatever
// it takes off that creature is hostile.
const CLASH_TRIGGERS = new Set(["creature_deals_damage", "creature_will_deal_damage", "creature_completes_attack",
  "creature_performs_action", "creature_hit_by_action", "creature_targeted_by_action", "creature_takes_damage"]);

// Resources that are tracked points; the rest (HP, MP, IP, Shield…) are the owner's own numbers.
const POINT_RESOURCES = new Set(["zero_power", "fp"]);
const OWN_NUMBERS = ["hp", "mp", "ip", "shield"];

const listOf = (v) => String(v ?? "").split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);
const kindOf = (r) => String(r?.effect_kind ?? "").trim().toLowerCase();

// Which way one effect row pushes the action it fires on: 1 stronger, -1 weaker,
// 0 can't tell from the row. A formula amount only counts where every value it can
// take points one way (an addition). Own damage taken to 0 is 0 here on purpose: it
// is a trade the reactor chose, so whose side it is decides.
function actionPush(r, k) {
  const literal = (v) => { const s = String(v ?? "").trim(); return s !== "" && Number.isFinite(Number(s)) ? Number(s) : null; };
  if (k === "adjust_damage") {
    const op = String(r.damage_operation ?? "add").trim().toLowerCase(), a = literal(r.damage_amount);
    const incoming = String(r.damage_stage ?? "outgoing").trim().toLowerCase() === "incoming";
    let dir = 0;
    if (op === "add") dir = a != null && a < 0 ? -1 : a === 0 ? 0 : 1;
    else if (op === "subtract") dir = a != null && a < 0 ? 1 : a === 0 ? 0 : -1;
    else if (op === "multiply" && a != null && a !== 0 && a !== 1) dir = a > 1 ? 1 : -1;
    return dir;
  }
  if (k === "adjust_accuracy") {
    const a = literal(r.accuracy_amount);
    if (a == null) return 0;
    const op = String(r.accuracy_operation ?? "add").trim().toLowerCase();
    if (op === "add") return Math.sign(a);
    return op === "set" && a === 0 ? -1 : 0;
  }
  if (k === "adjust_defense" || k === "negate_action") return -1;
  if (k === "add_target" || k === "apply_action_keyword") return 1;
  return 0;
}

export function hasKeyword(item, keyword) {
  const raw = item?.system?.props?.action_keywords ?? "";
  return String(raw).replace(/<[^>]*>/g, " ").split(/[,\n]+/).map((k) => k.trim().toLowerCase()).includes(keyword);
}

function templateOf(item, name) {
  const n = String(name ?? "").trim();
  const coll = item?.effects;
  const arr = coll?.contents ?? (Array.isArray(coll) ? coll : []);
  return n ? (arr.find((e) => String(e?.name ?? "").trim() === n) ?? null) : null;
}

// "self" when every part of a target ref is the owner, "other" when any part isn't.
function sideOf(ref, byLabel) {
  const parts = listOf(ref);
  if (!parts.length) return "none";
  for (const p of parts) {
    if (p === "self") continue;
    const t = byLabel.get(p);
    const self = kindOf(t) === "targeting" && String(t.candidate_source ?? "").trim().toLowerCase() === "self";
    if (!self) return "other";
  }
  return "self";
}

function resourceOf(r) {
  return resolveResourceDef(r.grant_resource ?? r.resource ?? r.resource_kind ?? r.consume_resource ?? r.set_resource ?? "");
}

/**
 * Is a reaction helping or hindering the action it fires on? "pos" or "neg".
 * Its rows decide when they all point one way. Otherwise (no row changes the
 * action, a moved target, an accuracy formula, a damage-to-0 trade, a mix) whose
 * side it comes from does: the acting creature or its side helps, the other hinders.
 */
export function reactionTone({ profile = null, reactorIsActor = false, sameSide = true } = {}) {
  if (profile && profile.pushUp !== profile.pushDown) return profile.pushUp ? "pos" : "neg";
  return reactorIsActor || sameSide ? "pos" : "neg";
}

/**
 * Static profile of the chain a reaction row runs.
 * @param {object} a
 * @param {object} a.table    the carrier's runtime effect table
 * @param {string} a.ref      the reaction row's effect ref
 * @param {object} a.item     the skill whose embedded AEs are the chain's templates
 * @param {string} a.trigger  the reaction row's trigger
 * @param {boolean} a.foreign the carrier is an effect another creature put on
 *                            the owner (Searing Brand): harm to "self" is an attack
 */
export function chainProfile({ table, ref, item = null, trigger = "", foreign = false } = {}) {
  const byLabel = new Map();
  for (const r of Object.values(table ?? {})) {
    const l = String(r?.effect_label ?? "").trim();
    if (r && !r.$deleted && l) byLabel.set(l, r);
  }
  const p = {
    trigger: String(trigger ?? "").trim(),
    startKind: kindOf(byLabel.get(String(ref ?? "").trim())),
    kinds: new Set(), quick: true, reachesOthers: false, riders: false, ridersOnly: true,
    offense: false, defense: false, support: false, spotlight: false,
    selfAes: new Set(), selfChargeNames: new Set(), selfChargeKeys: new Set(),
    selfPoints: new Map(),     // actor prop → resource def (Zero Power…)
    selfNumbers: false,        // grants / costs / damage on the owner's HP, MP…
    damageRiders: [],          // outgoing adjust_damage rows
    pushUp: false, pushDown: false,   // some row makes the action stronger / weaker
  };
  const seen = new Set(), q = [String(ref ?? "").trim()];
  while (q.length) {
    const label = q.shift();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const r = byLabel.get(label);
    if (!r) continue;
    for (const f of STEP_FIELDS) for (const x of listOf(r[f])) q.push(x);
    const k = kindOf(r);
    if (!k || k === "targeting") continue;
    p.kinds.add(k);
    const push = actionPush(r, k);
    if (push > 0) p.pushUp = true; else if (push < 0) p.pushDown = true;
    if (!QUICK.has(k)) p.quick = false;
    if (RIDERS.has(k)) p.riders = true;
    else if (k !== "chain" && k !== "chance") p.ridersOnly = false;
    const side = RIDERS.has(k) ? "none" : sideOf(r.target_ref, byLabel);
    if (side === "other") p.reachesOthers = true;
    const clash = CLASH_TRIGGERS.has(p.trigger);
    switch (k) {
      case "apply_ae": {
        const name = String(r.ae_template_ref ?? r.ae_name ?? "").trim();
        if (side === "self") { if (name) p.selfAes.add(name); break; }
        // A buff or a Ready on someone else helps them; anything else (a
        // condition, a mark, a stack) is put on a foe.
        const tier = classifyEffect(templateOf(item, name) ?? { name });
        if (tier === AE.BUFF || tier === AE.READY) p.support = true; else p.offense = true;
        break;
      }
      case "adjust_charges": case "consume_charge":
        if (side === "other") { p.offense = true; break; }
        if (r.charge_ae_name) p.selfChargeNames.add(String(r.charge_ae_name).trim());
        if (r.charge_key) p.selfChargeKeys.add(String(r.charge_key).trim());
        break;
      case "grant": case "consume_resource": case "set_resource": {
        const def = resourceOf(r);
        if (side === "other") { if (k === "grant") p.support = true; else p.offense = true; break; }
        if (def && POINT_RESOURCES.has(def.key)) p.selfPoints.set(def.prop, def);
        else if (foreign && k !== "grant") p.offense = true;
        else p.selfNumbers = true;
        break;
      }
      case "deal_damage":
        if (side === "other") { p.offense = true; if (p.trigger === "creature_defeated") p.spotlight = true; }
        else if (foreign) p.offense = true;
        else p.selfNumbers = true;
        break;
      case "adjust_damage":
        if (String(r.damage_stage ?? "outgoing").trim().toLowerCase() === "incoming") p.defense = true;
        else p.damageRiders.push(r);
        break;
      case "adjust_defense": case "redirect_target": case "negate_action":
        p.defense = true; break;
      case "free_action": case "trigger_status": case "transfer_ae":
        p.offense = true; break;
      case "remove_ae": case "remove_tagged_ae":
        // Off someone else: stripped from a foe mid-attack, else cleansed off an ally.
        if (side === "other") { if (clash) p.offense = true; else p.support = true; }
        break;
      case "modify_turns": case "take_turn_next": case "destroy_summon":
        p.support = true; break;
      case "play_animation": case "set_battle_outcome": case "conflict_event_action":
        p.spotlight = true; break;
      default: break;
    }
  }
  // Card can wait for the result: the chain is quick, and either touches only its
  // owner (the before/after compare reads it) or opens on a roll (a miss shows nothing).
  p.waits = p.quick && (!p.reachesOthers || p.startKind === "chance");
  return p;
}

/** The tier a chain's rows give it, for a card raised before the chain runs. */
export function staticTier(p, item = null) {
  if (p.spotlight || hasKeyword(item, "spotlight")) return "spotlight";
  if (p.offense) return "offense";
  if (p.defense) return "defense";
  if (p.support) return "support";
  if (p.selfPoints.size) return "points";
  return "background";
}

// ── Owner before / after ──────────────────────────────────────────────────────

/** The owner's state the chain can touch: its named AEs, its point props, its numbers. */
export function snapshotOwner(actor, p) {
  const aes = new Map();
  for (const e of actor?.effects ?? []) {
    const name = String(e?.name ?? "").trim();
    const f = e?.flags?.[NS] ?? {};
    const watched = p.selfAes.has(name) || p.selfChargeNames.has(name)
      || (f.chargeKey != null && p.selfChargeKeys.has(String(f.chargeKey)));
    if (!watched) continue;
    const prev = aes.get(name);
    aes.set(name, {
      tier: classifyEffect(e),
      charges: (prev?.charges ?? 0) + (Number(f.charges ?? 0) || 0),
      max: Number(f.chargesMax ?? 0) || prev?.max || null,
      count: (prev?.count ?? 0) + 1,
    });
  }
  const props = actor?.system?.props ?? {};
  const points = new Map();
  for (const [prop] of p.selfPoints) points.set(prop, Number(props[prop] ?? 0) || 0);
  const numbers = {};
  for (const key of OWN_NUMBERS) {
    const def = resolveResourceDef(key);
    if (def) numbers[key] = Number(props[def.prop] ?? 0) || 0;
  }
  return { aes, points, numbers };
}

function diffOwner(before, after, p) {
  const out = { points: [], newReady: [], refreshed: [], newStates: [], numbersChanged: false };
  for (const name of new Set([...before.aes.keys(), ...after.aes.keys()])) {
    const b = before.aes.get(name), a = after.aes.get(name);
    const tier = (a ?? b).tier;
    if (tier === AE.RESOURCE) {
      const bc = b?.charges ?? 0, ac = a?.charges ?? 0;
      // Created at the value it had (a gauge seeded at 0) is no change.
      if (ac !== bc) out.points.push({ name, before: bc, after: ac, max: (a ?? b).max });
    } else if (tier === AE.READY) {
      if (!a) continue;
      const became = !b || (b.charges <= 0 && a.charges > 0) || a.count > b.count;
      (became ? out.newReady : out.refreshed).push(name);
    } else if (tier !== AE.HIDDEN && a && !b) {
      out.newStates.push({ name, tier });
    }
  }
  for (const [prop, def] of p.selfPoints) {
    const bv = before.points.get(prop) ?? 0, av = after.points.get(prop) ?? 0;
    if (av !== bv) out.points.push({ name: def.label, before: bv, after: av, max: def.hardMax ?? null });
  }
  for (const k of Object.keys(after.numbers)) if (after.numbers[k] !== before.numbers[k]) out.numbersChanged = true;
  return out;
}

/** What a points line says: "+1 Adoration (1/5)", "Adoration reset (0/5)", "−2 Zero Power (1/6)". */
export function readoutOf(change) {
  if (!change) return null;
  const n = change.after - change.before;
  return { name: change.name, op: change.after === 0 && n < 0 ? "reset" : (n < 0 ? "spend" : "add"), n: Math.abs(n), after: change.after, max: change.max };
}

// ── Ledger: "the first time each battle" ─────────────────────────────────────
const _ledger = { key: null, seen: new Set() };
function firstThisBattle(key) {
  const battle = globalThis.game?.combat?.id ?? "none";
  if (_ledger.key !== battle) { _ledger.key = battle; _ledger.seen.clear(); }
  if (_ledger.seen.has(key)) return false;
  _ledger.seen.add(key);
  return true;
}

// Background tier under the bg dial: every time, the first time each battle, or never.
function backgroundCard(dial, key, why) {
  if (dial.bg === "every") return { show: true, tier: "background", why };
  if (dial.bg === "once") return firstThisBattle(key) ? { show: true, tier: "background", why: `${why}, first time this battle` } : { show: false, why: `${why}, already shown this battle` };
  return { show: false, why: `${why}: the number shows it` };
}

// Outgoing damage riders that all came to 0 against every target (Glowstick's
// +5 against a creature that is neither beast nor plant). Other rider kinds
// can't be read here, so they count as doing something.
async function ridersAddedNothing(p, { actor, item, candidate, payload, round }) {
  if (!p.ridersOnly || !p.damageRiders.length) return false;
  if ([...p.kinds].some((k) => RIDERS.has(k) && k !== "adjust_damage")) return false;
  const { buildSkillResolver, evaluateFormula, readAdjustment } = await import("../skill-formulas.js");
  const subjects = Array.isArray(candidate?.appliesToTargetUuids) && candidate.appliesToTargetUuids.length
    ? candidate.appliesToTargetUuids
    : [candidate?.subjectActorUuid ?? payload?.subjectActorUuid].filter(Boolean);
  if (!subjects.length) return false;
  for (const uuid of subjects) {
    const resolver = buildSkillResolver({ actor, payload: { ...(candidate?.payloadAtFire ?? payload ?? {}), subjectActorUuid: uuid }, skill: item, round });
    for (const r of p.damageRiders) {
      const { amountFormula } = readAdjustment(r, "damage");
      if ((Number(evaluateFormula(amountFormula, resolver)) || 0) !== 0) return false;
    }
  }
  return true;
}

/**
 * Card decision for a chain that was waited for.
 * @returns {Promise<{show:boolean, tier?:string, res?:object, chime?:boolean, why:string}>}
 */
export async function decideAfter({ p, result, before, actor, item, title, tokenUuid, dial, candidate, payload, round }) {
  if (!result?.ok || result.skipped) return { show: false, why: "nothing ran" };
  if (p.startKind === "chance" && result.passed === false) return { show: false, why: "the roll failed" };
  let live = actor;
  try { live = globalThis.fromUuidSync?.(actor?.uuid) ?? actor; } catch { /* keep the reference we have */ }
  const d = diffOwner(before, snapshotOwner(live, p), p);
  const pts = d.points[0] ?? null;
  const res = readoutOf(pts);
  const key = `${tokenUuid}|${title}`;

  // Acted on another creature (a roll that hit), or shielded its owner from a hit.
  if (p.offense || p.defense || p.support || p.spotlight) return { show: true, tier: staticTier(p, item), res, why: "acted" };
  if (pts) return { show: true, tier: "points", res, why: "changed tracked points" };
  if (d.newReady.length) {
    if (dial.ready === "card") return { show: true, tier: "ready", why: `${d.newReady[0]} became Ready` };
    return { show: false, chime: dial.ready === "chime", why: `${d.newReady[0]} became Ready: the gold pop shows it` };
  }
  if (d.refreshed.length && !d.newStates.length && !d.numbersChanged) return { show: false, why: "already Ready, nothing changed" };
  if (d.newStates.length) {
    if (!isNpcActor(actor)) return { show: false, why: `party setup: ${d.newStates[0].name} shows on its pop and icon` };
    if (dial.enemy === "once") return firstThisBattle(key) ? { show: true, tier: "background", why: "enemy state, first time this battle" } : { show: false, why: "enemy state, already shown this battle" };
    return { show: false, why: "enemy state: its status icon shows it" };
  }
  if (p.riders) {
    if (await ridersAddedNothing(p, { actor, item, candidate, payload, round })) return { show: false, why: "added +0 against this target" };
    return backgroundCard(dial, key, "on-hit bonus");
  }
  if (d.numbersChanged) return backgroundCard(dial, key, "the owner's own numbers");
  return { show: false, why: "nothing visible changed" };
}

/** Card decision for a chain that can't be waited for (shown before it runs). */
export function decideBefore({ p, item, title, tokenUuid, dial }) {
  const tier = staticTier(p, item);
  if (tier === "background") return backgroundCard(dial, `${tokenUuid}|${title}`, "the owner's own numbers");
  return { show: true, tier, why: "acts" };
}
