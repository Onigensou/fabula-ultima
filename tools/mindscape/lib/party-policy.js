"use strict";
//
// Mindscape — party play policies (ruleset Part 4m).
//
// `legacy`   the original Mindscape party: utility layer + greedy damage pick, no items,
//            no Zero Power, no element swaps. Kept as the default so every published
//            calibration and expectation file reads exactly as before.
// `standard` the IN-GAME sim party, transcribed from battle-director/sim/profiles.js and
//            reaction-brain.js: per-character scripts for the four named PCs, basic attacks
//            for anyone else, party-wide revive / MP item / HP item, Zero Power, element
//            swaps, Warning Shot, Prophetic Defender, the endgame Protect bar. Use it to
//            measure the gap between Mindscape and a live sim run.
// `expert`   standard's support play for EVERY character, with the greedy best-damage pick
//            (any action, Adoration skills included) and best-element choices wherever the
//            in-game AI takes a menu's first entry. An upper bound on bot play.
// `novice`   a lower bound: no focus fire, no augments, no items, no Zero Power, random
//            affordable attack, heals only in an emergency.
//
// Divergences from the in-game AI that are deliberate or unavoidable are listed in
// NOT_PORTED and printed with every run that uses a non-legacy policy.

const R = require("./rules");
const U = require("./utility");
const { evaluate: evaluateFormula } = require("./formula");

const POLICIES = ["legacy", "standard", "expert", "novice"];

// profiles.js TUNING, the constants this module reads. Must equal the source.
const TUNING = {
  strongHitFraction: 0.30, strongHitFractionEndgame: 0.12,
  propheticMinTargets: 2,
  healKoRiskFraction: 0.30, healWorthItFraction: 0.60, healMinTargets: 2,
  healEmergencyFraction: 0.15, healMaxTargets: 3,
  icebergKoHp: 60, glaciesMinWeak: 2, glaciesMaxTargets: 3,
  accelerationPriority: ["Zarg", "Keren"], stopMaxEnemies: 1,
  gadgetIpCost: 2, gadgetReserveIp: 0, warningShotRounds: [1],
  mpItemThreshold: 0.30, mpItemMinTargets: 1, mpItemsPerRound: 1, hpItemsPerRound: 1,
  potionPriority: ["Zarg"],
  zeroPowerCost: 6, zeroPowerHealFraction: 0.55,
};

// The party's IP recipes (BD-canon recipe items on the party actor) and carried
// consumables, as read from the world on 2026-10-20.
const RECIPES = [
  { name: "Remedy", ip: 3, restores: "hp", amount: 50 },
  { name: "Elixir", ip: 3, restores: "mp", amount: 50 },
];
const CARRIED = [
  { re: /^mega-remedy$/i, restores: "hp", amount: 100 },
  { re: /^phoenix feather$/i, revive: true },
];

const ELEMENTS = ["air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"];
const AFF_SCORE = { VU: 3, NE: 1, NA: 1, RS: 0.4, IM: 0, AB: -5 };

const NOT_PORTED = [
  "Life Transference (Keren) — its heal formula is cut off in the item text",
  "For Whom the Bell Tolls (Keren) — needs Grave points, which nothing in the model grants",
  "Lightning Rod displacement in focus fire — matters only in Lightning Storm fights",
  "phantasms never act on their own; Create Phantasm only deals its strike and adds one to the count",
  "Hina's Foresight trigger — she never spends Zero Power, so it cannot change a fight",
];

const lc = (s) => String(s ?? "").trim().toLowerCase();
const frac = (c) => (c.maxHp ? c.hp / c.maxHp : 1);
const mpFrac = (c) => { const m = c.actor.mp.max ?? 0; return m ? c.mp / m : 1; };
const named = (c, name) => new RegExp(`^${name}\\b`, "i").test(String(c.name).trim());
const findItem = (c, re) => (c.actor.items ?? []).find((it) => re.test(String(it.name ?? "").trim()));
const hasSkill = (c, re) => !!findItem(c, re);

function affinity(target, element) {
  if (!element) return "NE";
  return R.resolveAffinity(target.actor, element);
}
const affScore = (aff) => AFF_SCORE[String(aff ?? "NE").toUpperCase()] ?? 1;

// ── Per-fight state ─────────────────────────────────────────────────────────
function init(state, name) {
  const policy = { name, budget: {}, notes: new Set() };
  for (const c of state.combatants) {
    c.statuses = c.statuses ?? {};
    if (c.side !== "party") continue;
    c.adoration = 0;
    c.phantasms = 0;
    c.prophecy = hasSkill(c, /^divination$/i) && hasSkill(c, /^prophetic defender$/i) ? 1 : 0;
    c.pack = [];
    for (const it of c.actor.items ?? []) {
      const p = it.props ?? {};
      if (lc(p.item_type) !== "consumable") continue;
      const qty = Number(p.item_quantity ?? p.quantity ?? 0) || 0;
      const kind = CARRIED.find((k) => k.re.test(String(it.name).trim()));
      if (kind && qty > 0) c.pack.push({ name: it.name, qty, ...kind });
    }
  }
  return policy;
}

function budgetSpent(state, key) { return state.policy.budget[`${state.round}:${key}`] ?? 0; }
function spendBudget(state, key) { const k = `${state.round}:${key}`; state.policy.budget[k] = (state.policy.budget[k] ?? 0) + 1; }

function allies(state, actor) { return state.combatants.filter((c) => c.side === actor.side && c.alive); }
function foes(state, actor) { return state.combatants.filter((c) => c.side !== actor.side && c.alive); }
const endgame = (state, actor) => foes(state, actor).length <= 1;

// ── Built-in actions not in the extracted kit ───────────────────────────────
// Built from the item's own props, so a sheet change carries through.
function skillAction(c, re, over = {}) {
  const it = findItem(c, re);
  if (!it) return null;
  const p = it.props ?? {};
  const dmg = evaluateFormula(p.damage_bonus, c.actor);
  const A = { DEX: "dex", INS: "ins", MIG: "mig", WLP: "wlp" };
  return {
    name: it.name,
    attrA: A[String(p.rolled_atr1).toUpperCase()] ?? null,
    attrB: A[String(p.rolled_atr2).toUpperCase()] ?? null,
    damageBonus: dmg.ok ? dmg.value : 0,
    element: lc(p.type_damage) || "physical",
    defenseTarget: lc(p.skill_type) === "spell" ? "mdef" : "def",
    target: { side: "enemy", count: 1 },
    cost: { resource: null, amount: 0 },
    keywords: null,
    ...over,
  };
}

// ── Healing and items ───────────────────────────────────────────────────────
function healTargets(state, actor, list, amount) {
  for (const t of list) {
    t.hp = Math.min(t.maxHp, t.hp + amount);
  }
  state.log.push({ round: state.round, actor: actor.name, action: "Heal", heal: list.map((t) => t.name), amount });
}

// Potion Rain: a single-target restore reaches up to SL more allies at half strength.
function potionRainExtra(state, actor, first, resource) {
  const pr = findItem(actor, /^potion rain$/i);
  if (!pr) return [];
  const sl = Number(pr.props?.skill_level ?? pr.props?.sl ?? 1) || 1;
  const key = resource === "mp" ? mpFrac : frac;
  return allies(state, actor).filter((c) => c !== first).sort((a, b) => key(a) - key(b)).slice(0, sl);
}

function restore(state, actor, target, resource, amount, label) {
  const extra = potionRainExtra(state, actor, target, resource);
  const half = extra.length ? Math.floor(amount / 2) : amount;
  for (const t of [target, ...extra]) {
    if (resource === "hp") t.hp = Math.min(t.maxHp, t.hp + half);
    else t.mp = Math.min(t.actor.mp.max ?? t.mp, t.mp + half);
  }
  state.log.push({ round: state.round, actor: actor.name, action: label, target: [target, ...extra].map((t) => t.name), restore: resource, amount: half });
}

function bestRestore(actor, resource) {
  const recipe = RECIPES.filter((r) => r.restores === resource && r.ip <= actor.ip).sort((a, b) => b.amount - a.amount)[0];
  if (recipe) return { recipe };
  const carried = actor.pack.filter((p) => p.restores === resource && p.qty > 0).sort((a, b) => b.amount - a.amount)[0];
  return carried ? { carried } : null;
}

function useRestore(state, actor, target, resource) {
  const pick = bestRestore(actor, resource);
  if (!pick) return false;
  if (pick.recipe) { actor.ip -= pick.recipe.ip; restore(state, actor, target, resource, pick.recipe.amount, `${pick.recipe.name} (${pick.recipe.ip} IP)`); }
  else { pick.carried.qty--; restore(state, actor, target, resource, pick.carried.amount, pick.carried.name); }
  return true;
}

// profiles.js revivePolicy: only when nobody standing is at KO risk.
function tryRevive(state, actor) {
  const down = state.combatants.filter((c) => c.side === actor.side && !c.alive);
  if (!down.length) return false;
  if (allies(state, actor).some((c) => frac(c) <= TUNING.healKoRiskFraction)) return false;
  const feather = actor.pack.find((p) => p.revive && p.qty > 0);
  if (!feather) return false;
  const target = down.slice().sort((a, b) => b.maxHp - a.maxHp)[0];
  feather.qty--;
  target.alive = true;
  target.hp = Math.floor(target.maxHp / 2);
  state.log.push({ round: state.round, actor: actor.name, action: feather.name, target: target.name, revive: true });
  return true;
}

// profiles.js mpItemPolicy: one per round, Zarg first while he can do it.
function tryMpItem(state, actor) {
  if (budgetSpent(state, "mp-item") >= TUNING.mpItemsPerRound) return false;
  const dry = allies(state, actor).filter((c) => (c.actor.mp.max ?? 0) > 0 && mpFrac(c) < TUNING.mpItemThreshold);
  if (dry.length < TUNING.mpItemMinTargets) return false;
  if (!bestRestore(actor, "mp")) return false;
  const pref = TUNING.potionPriority.find((n) => allies(state, actor).some((c) => named(c, n) && (c.ip >= 2 || c.pack.some((p) => p.restores === "mp" && p.qty > 0))));
  if (pref && !named(actor, pref)) return false;
  spendBudget(state, "mp-item");
  return useRestore(state, actor, dry.sort((a, b) => mpFrac(a) - mpFrac(b))[0], "mp");
}

// profiles.js hpItemPolicy: someone at KO risk and this character cannot cast Heal.
function tryHpItem(state, actor, { threshold = TUNING.healKoRiskFraction } = {}) {
  if (budgetSpent(state, "hp-item") >= TUNING.hpItemsPerRound) return false;
  const dying = allies(state, actor).filter((c) => frac(c) <= threshold);
  if (!dying.length) return false;
  if (U.has(actor, "heal") && actor.mp >= 10) return false;
  if (!bestRestore(actor, "hp")) return false;
  spendBudget(state, "hp-item");
  return useRestore(state, actor, dying.sort((a, b) => frac(a) - frac(b))[0], "hp");
}

// ── Zero Power ──────────────────────────────────────────────────────────────
function unleash(state, actor) {
  actor.zp -= TUNING.zeroPowerCost;
  // Zero Trigger: Motivation — an ally unleashing fills the holder to 6.
  for (const c of allies(state, actor)) {
    if (c !== actor && hasSkill(c, /^zero trigger: motivation$/i)) c.zp = 6;
  }
}

function tryZeroPower(state, actor, api, { bestElement = false } = {}) {
  if (!(actor.zp >= TUNING.zeroPowerCost)) return false;
  const lvl = Number(actor.actor.level) || 0;
  const fs = foes(state, actor);

  if (named(actor, "Blanche") && hasSkill(actor, /^zero power:/i)) {
    const worst = allies(state, actor).sort((a, b) => frac(a) - frac(b))[0];
    if (!worst || frac(worst) > TUNING.zeroPowerHealFraction) return false;
    unleash(state, actor);
    const team = allies(state, actor);
    for (const c of team) c.statuses = {};
    healTargets(state, actor, team, 40 + Math.floor(lvl / 2));
    state.log.at(-1).action = "Zero Power (party heal)";
    return true;
  }
  if (named(actor, "Keren") && hasSkill(actor, /^zero power: last den/i)) {
    if (actor.phantasms < 1 || !fs.length) return false;
    const n = actor.phantasms;
    unleash(state, actor);
    actor.phantasms = 0;
    actor.zp = Math.min(6, actor.zp + n);    // Zero Trigger: Shattered Phantasm, +1 each
    for (const f of fs) api.applyFlatDamage(state, actor, f, n * 20 + 20, "fire", "Zero Power: Last Den of Cinders");
    return true;
  }
  if (named(actor, "Zarg") && hasSkill(actor, /^zero power: meteor shower$/i)) {
    if (!fs.length) return false;
    let element = "poison";
    if (bestElement) {
      const ranked = ELEMENTS.map((el) => ({ el, affs: fs.map((f) => affinity(f, el)) }))
        .filter((x) => !x.affs.some((a) => a === "IM" || a === "AB"))
        .map((x) => ({ ...x, score: x.affs.reduce((s, a) => s + affScore(a), 0) }))
        .sort((a, b) => b.score - a.score);
      if (!ranked.length) return false;
      element = ranked[0].el;
    } else if (fs.some((f) => ["IM", "AB"].includes(affinity(f, "poison")))) {
      return false;
    }
    unleash(state, actor);
    for (const f of fs) {
      api.applyFlatDamage(state, actor, f, 30 + Math.floor(lvl / 2), element, "Zero Power: Meteor Shower");
      // The menu's first two statuses (dazed, shaken) unless a brain hints otherwise.
      f.statuses = { ...f.statuses, isDazed: true, isShaken: true };
    }
    return true;
  }
  return false;
}

// ── Focus helpers (profiles.js focusFor) ────────────────────────────────────
function focusFor(state, actor, element) {
  const focus = state.focus && state.focus.alive ? state.focus : null;
  if (!focus || !element) return focus;
  const aff = affinity(focus, element);
  if (aff === "AB" || aff === "IM") return null;
  if (aff !== "VU" && foes(state, actor).some((f) => affinity(f, element) === "VU")) return null;
  return focus;
}

// ── Hina (profiles.js hinaPolicy) ───────────────────────────────────────────
function protectExhausted(state, actor) {
  const protector = allies(state, actor).find((c) => U.has(c, "protect"));
  return !protector || (protector.protectedThisRound ?? 0) >= 1;
}

function hinaHeal(state, actor) {
  if (!U.has(actor, "heal") || actor.mp < 10) return false;
  const hurt = allies(state, actor).filter((c) => frac(c) < TUNING.healWorthItFraction).sort((a, b) => frac(a) - frac(b));
  if (!hurt.length) return false;
  const atRisk = hurt.filter((c) => frac(c) <= TUNING.healKoRiskFraction);
  const critical = hurt.some((c) => frac(c) <= TUNING.healEmergencyFraction);
  if (!endgame(state, actor)) {
    if (!atRisk.length && !critical) return false;
    if (!critical && !protectExhausted(state, actor)) return false;
    if (!critical && hurt.length < TUNING.healMinTargets) return false;
  }
  const n = Math.min(TUNING.healMaxTargets, Math.max(1, Math.floor(actor.mp / 10)));
  const targets = hurt.slice(0, n);
  actor.mp -= 10 * targets.length;
  healTargets(state, actor, targets, U.healAmount(actor.actor));
  return true;
}

function tryStop(state, actor, api) {
  if (foes(state, actor).length > TUNING.stopMaxEnemies || actor.mp < 10) return false;
  const stop = skillAction(actor, /^stop$/i, { defenseTarget: "mdef", element: null });
  if (!stop || !stop.attrA) return false;
  const victim = foes(state, actor).sort((a, b) => b.baseTurns - a.baseTurns)[0];
  if (!victim) return false;
  actor.mp -= 10;
  const check = R.accuracyCheck(state.rng, { dieA: api.attrs(actor)[stop.attrA], dieB: api.attrs(actor)[stop.attrB], bonus: 0, dl: victim.actor.mdef });
  if (check.hit) victim.turnDebt += 1;
  state.log.push({ round: state.round, actor: actor.name, action: "Stop", target: victim.name, miss: !check.hit });
  return true;
}

function hinaOffense(state, actor) {
  const fs = foes(state, actor);
  const byName = (n) => actor.actions.find((a) => lc(a.name) === n);
  const iceberg = byName("iceberg"), glacies = byName("glacies");
  const takesIce = (f) => !["RS", "IM", "AB"].includes(affinity(f, "ice"));
  if (iceberg && actor.mp >= (iceberg.cost?.amount ?? 0)) {
    const fin = fs.filter((f) => takesIce(f) && f.hp <= TUNING.icebergKoHp).sort((a, b) => a.hp - b.hp)[0];
    if (fin) return { action: iceberg, targets: [fin] };
  }
  if (glacies) {
    const weak = fs.filter((f) => affinity(f, "ice") === "VU").slice(0, TUNING.glaciesMaxTargets);
    const cost = glacies.cost?.perTarget ? glacies.cost.amount * weak.length : glacies.cost?.amount ?? 0;
    if (weak.length >= TUNING.glaciesMinWeak && actor.mp >= cost) return { action: { ...glacies, target: { ...glacies.target, count: weak.length } }, targets: weak };
  }
  if (iceberg && actor.mp >= (iceberg.cost?.amount ?? 0)) {
    const called = focusFor(state, actor, "ice");
    if (called) return { action: iceberg, targets: [called] };
    const t = fs.filter(takesIce).sort((a, b) => (affinity(a, "ice") === "VU" ? 0 : 1) - (affinity(b, "ice") === "VU" ? 0 : 1) || a.hp - b.hp)[0];
    if (t) return { action: iceberg, targets: [t] };
  }
  // Pattern row: Drain Spirit while her own MP sits at 0-19%.
  const drain = byName("drain spirit");
  if (drain && mpFrac(actor) <= 0.19 && actor.mp >= (drain.cost?.amount ?? 0)) {
    const t = focusFor(state, actor, drain.element) ?? fs.slice().sort((a, b) => a.hp - b.hp)[0];
    if (t) return { action: drain, targets: [t] };
  }
  return null;
}

// ── Per-character scripts (standard) ────────────────────────────────────────
function scriptFor(actor) {
  for (const n of ["Hina", "Zarg", "Keren", "Blanche"]) if (named(actor, n)) return n;
  return null;
}

function standardOwnTurn(state, actor, api, opts) {
  const who = scriptFor(actor);
  const fs = foes(state, actor);
  if (who === "Hina") {
    if (hinaHeal(state, actor)) return "done";
    const hurt = allies(state, actor).some((c) => frac(c) < TUNING.healWorthItFraction);
    if (!hurt && U.tryAccelerate(state, actor)) {
      state.log.push({ round: state.round, actor: actor.name, action: "Acceleration" });
      return "done";
    }
    if (tryStop(state, actor, api)) return "done";
    return hinaOffense(state, actor);
  }
  if (who === "Zarg") {
    if (tryZeroPower(state, actor, api, opts)) return "done";
    return null;                                   // he just shoots
  }
  if (who === "Keren") {
    if (tryZeroPower(state, actor, api, opts)) return "done";
    const det = actor.actions.find((a) => /^detonate phantasm$/i.test(a.name));
    if (det && actor.phantasms >= 1 && actor.mp >= 20 && fs.length) {
      const t = focusFor(state, actor, null) ?? fs.slice().sort((a, b) => a.hp - b.hp)[0];
      return { action: det, targets: [t], detonate: true };
    }
    const create = actor.actions.find((a) => /^create phantasm: strike$/i.test(a.name));
    if (create && api.canAfford(actor, create, 1) && fs.length) {
      return { action: create, targets: [fs.slice().sort((a, b) => a.hp - b.hp)[0]], creates: true };
    }
    return null;
  }
  if (who === "Blanche") {
    if (tryZeroPower(state, actor, api, opts)) return "done";
    const worst = allies(state, actor).sort((a, b) => frac(a) - frac(b))[0];
    if (U.has(actor, "heal") && worst && frac(worst) <= 0.5 && actor.mp >= 10) {
      actor.mp -= 10;
      healTargets(state, actor, [worst], U.healAmount(actor.actor));
      return "done";
    }
    const muleta = skillAction(actor, /^muleta$/i, { adoration: 1 });
    if (muleta && actor.adoration >= 1 && fs.length) {
      return { action: muleta, targets: [fs.slice().sort((a, b) => a.hp - b.hp)[0]] };
    }
    return null;
  }
  return null;                                     // GENERIC_PROFILE: basic attacks only
}

// Expert: every character, support first, then the best damage on the board.
function expertOwnTurn(state, actor, api, opts) {
  if (tryZeroPower(state, actor, api, opts)) return "done";
  if (named(actor, "Hina") ? hinaHeal(state, actor) : genericHeal(state, actor)) return "done";
  const hurt = allies(state, actor).some((c) => frac(c) < TUNING.healWorthItFraction);
  if (!hurt && U.tryAccelerate(state, actor)) {
    state.log.push({ round: state.round, actor: actor.name, action: "Acceleration" });
    return "done";
  }
  if (tryStop(state, actor, api)) return "done";

  const candidates = [];
  const pick = api.chooseAction(state, actor);
  if (pick && !pick.arming) candidates.push(pick);
  // Adoration skills the extractor cannot price: offer them when the gauge pays.
  for (const [re, need] of [[/^descabello$/i, 5], [/^tafallera$/i, 3], [/^muleta$/i, 1]]) {
    if (actor.adoration < need) continue;
    const a = skillAction(actor, re, { adoration: need });
    if (!a || !a.attrA) continue;
    const all = /tafallera/i.test(a.name);
    if (all) a.target = { side: "enemy", count: Infinity };
    candidates.push({ action: a, targets: api.chooseTargets(state, actor, a) });
  }
  const w = api.weaponAction(actor);
  if (w) candidates.push({ action: w, targets: api.chooseTargets(state, actor, w), weapon: true });
  let best = null;
  for (const c of candidates) {
    if (!c.targets?.length) continue;
    const s = api.projectTotal(actor, c.action, c.targets);
    if (!best || s > best.score) best = { ...c, score: s };
  }
  if (best?.weapon) return null;                   // the engine's weapon path adds the riders
  if (best && /^detonate phantasm$/i.test(best.action.name)) {
    if (actor.phantasms < 1) return null;
    best.detonate = true;
  }
  if (best && /^create phantasm/i.test(best.action.name)) best.creates = true;
  return best;
}

function genericHeal(state, actor) {
  if (!U.has(actor, "heal") || actor.mp < 10) return false;
  const hurt = allies(state, actor).filter((c) => frac(c) <= TUNING.healKoRiskFraction).sort((a, b) => frac(a) - frac(b));
  if (!hurt.length) return false;
  const n = Math.min(TUNING.healMaxTargets, Math.floor(actor.mp / 10));
  const targets = allies(state, actor).filter((c) => frac(c) < TUNING.healWorthItFraction).sort((a, b) => frac(a) - frac(b)).slice(0, n);
  actor.mp -= 10 * targets.length;
  healTargets(state, actor, targets, U.healAmount(actor.actor));
  return true;
}

function noviceOwnTurn(state, actor, api) {
  if (U.has(actor, "heal") && actor.mp >= 10) {
    const worst = allies(state, actor).sort((a, b) => frac(a) - frac(b))[0];
    if (worst && frac(worst) <= TUNING.healEmergencyFraction) {
      actor.mp -= 10;
      healTargets(state, actor, [worst], U.healAmount(actor.actor));
      return "done";
    }
  }
  if (tryHpItem(state, actor, { threshold: TUNING.healEmergencyFraction })) return "done";
  const options = actor.actions.filter((a) => !a.stanceGrants && a.target?.side !== "ally" && api.canAfford(actor, a, 1));
  if (options.length && state.rng.float() < 0.5) {
    const a = options[Math.floor(state.rng.float() * options.length)];
    const t = api.chooseTargets(state, actor, a);
    if (t.length) return { action: a, targets: t };
  }
  return null;                                     // weapon swing, no augments
}

// ── The turn hook the engine calls for a party member ───────────────────────
// Returns "done" (a support action spent the turn), { action, targets } (resolve
// this), or null (fall through to the weapon swing).
function partyTurn(state, actor, { granted = false }, api) {
  const name = state.policy.name;
  // A granted free attack ("perform a free attack") is a weapon attack: fall through
  // to the engine's weapon swing and its riders.
  if (granted) return null;
  if (name === "novice") return noviceOwnTurn(state, actor, api);
  if (tryRevive(state, actor) || tryMpItem(state, actor) || tryHpItem(state, actor)) return "done";
  const opts = { bestElement: name === "expert" };
  return name === "expert" ? expertOwnTurn(state, actor, api, opts) : standardOwnTurn(state, actor, api, opts);
}

// After the engine resolves a policy pick: pay what the engine does not know about.
function afterPick(state, actor, pick) {
  if (pick.action.adoration) actor.adoration = Math.max(0, actor.adoration - pick.action.adoration);
  if (pick.creates) actor.phantasms += 1;
  if (pick.detonate && actor.phantasms > 0) {
    actor.phantasms -= 1;
    if (hasSkill(actor, /^zero trigger: shattered phantasm$/i)) actor.zp = Math.min(6, actor.zp + 1);
  }
}

// ── Damage-time riders ──────────────────────────────────────────────────────
// Element swaps never fire without naming an element, and never onto one that any
// target in the volley absorbs or is immune to (reaction-brain bestElementAcross).
function bestElementAcross(targets, choices = ELEMENTS) {
  const ranked = choices.map((el) => {
    const affs = targets.map((t) => affinity(t, el));
    return { el, feeds: affs.some((a) => a === "AB" || a === "IM"), resisted: affs.some((a) => a === "RS"),
      vu: affs.filter((a) => a === "VU").length, score: affs.reduce((s, a) => s + affScore(a), 0) };
  }).filter((c) => !c.feeds);
  if (!ranked.length) return null;
  const clean = ranked.filter((c) => !c.resisted);
  const pool = clean.length ? clean : ranked;
  return pool.sort((a, b) => b.vu - a.vu || b.score - a.score)[0].el;
}

// Called once per attack, before targets are rolled. Returns the riders that will
// apply on every target that is hit.
function declareAttack(state, actor, action, targets) {
  const name = state.policy?.name;
  if (!name || name === "legacy" || name === "novice" || actor.side !== "party") return null;
  const riders = {};
  const ranged = actor.actor.weapon?.range === "ranged";

  // Warning Shot — the in-game AI's opener: round 1, ranged basic attack, no damage, Shaken.
  if (name === "standard" && action.basicAttack && ranged && hasSkill(actor, /^warning shot$/i)
      && TUNING.warningShotRounds.includes(state.round)
      && !targets.every((t) => ["IM", "AB", "RS"].includes(affinity(t, action.element)))) {
    riders.warningShot = true;
    return riders;
  }
  // Gadgets — 2 IP on an attack: +5 damage and the best element across the volley.
  if (action.basicAttack && hasSkill(actor, /^gadgets$/i) && actor.ip - TUNING.gadgetIpCost >= TUNING.gadgetReserveIp) {
    const el = bestElementAcross(targets);
    if (el) { riders.element = el; riders.extra = 5; riders.ipCost = TUNING.gadgetIpCost; riders.label = "Gadgets"; }
  }
  // Thermokinesis — Keren, when she deals damage: Fire or Ice, +2, 5 MP.
  if (!riders.element && hasSkill(actor, /^thermokinesis$/i) && actor.mp >= 5 && !action.basicAttack) {
    const el = bestElementAcross(targets, ["fire", "ice"]);
    if (el) { riders.element = el; riders.extra = 2; riders.mpCost = 5; riders.label = "Thermokinesis"; }
  }
  return Object.keys(riders).length ? riders : null;
}

// Riders are paid once, on the first target the attack actually hits (live:
// creature_will_deal_damage only offers the pill on a landing action).
function payRiders(state, actor, riders) {
  if (!riders || riders.paid) return;
  riders.paid = true;
  if (riders.ipCost) actor.ip -= riders.ipCost;
  if (riders.mpCost) actor.mp -= riders.mpCost;
  if (riders.label) state.log.push({ round: state.round, actor: actor.name, action: riders.label, element: riders.element, reaction: true });
}

// Prophetic Defender: Hina takes the place of every ally threatened by a multi-target
// enemy action, but only when it cannot hurt her (immune, absorbs). Costs 1 Prophecy.
function redirectTargets(state, attacker, action, targets) {
  const name = state.policy?.name;
  if (!name || name === "legacy" || name === "novice" || attacker.side !== "enemy") return targets;
  if (targets.length < TUNING.propheticMinTargets) return targets;
  const hina = state.combatants.find((c) => c.side === "party" && c.alive && c.prophecy > 0 && hasSkill(c, /^prophetic defender$/i));
  if (!hina) return targets;
  const aff = affinity(hina, action.element);
  if (aff !== "IM" && aff !== "AB") return targets;
  hina.prophecy -= 1;
  state.log.push({ round: state.round, actor: hina.name, action: "Prophetic Defender", reaction: true, soaked: targets.length });
  return targets.map(() => hina);
}

// An enemy attack on a party member resolved: Adoration fills on a miss, resets on damage.
function onEnemyAttack(state, attacker, victim, { hit, damage }) {
  if (!state.policy || state.policy.name === "legacy" || victim.side !== "party") return;
  if (!hasSkill(victim, /^pases$/i)) return;
  if (!hit) {
    const fill = 1 + (hasSkill(victim, /^elegance showmanship$/i) ? 1 : 0);
    victim.adoration = Math.min(5, (victim.adoration ?? 0) + fill);
  } else if (damage > 0) {
    victim.adoration = 0;
  }
}

function onRoundStart(state) {
  if (!state.policy || state.policy.name === "legacy") return;
  if (state.round % 2 === 0) {
    for (const c of state.combatants) if (c.side === "party" && c.alive && hasSkill(c, /^prophetic defender$/i)) c.prophecy += 1;
  }
}

// Zero Trigger: Strategy — end of Zarg's turn, enemies carrying 2+ distinct statuses.
function onTurnEnd(state, actor) {
  if (!state.policy || state.policy.name === "legacy" || actor.side !== "party") return;
  if (!hasSkill(actor, /^zero trigger: strategy$/i)) return;
  const distinct = new Set();
  for (const f of foes(state, actor)) for (const [k, v] of Object.entries(f.statuses ?? {})) if (v) distinct.add(k);
  if (distinct.size >= 2) actor.zp = Math.min(6, actor.zp + 1);
}

function protectBar(state) {
  const name = state.policy?.name;
  if (!name || name === "legacy") return TUNING.strongHitFraction;
  const enemies = state.combatants.filter((c) => c.side === "enemy" && c.alive).length;
  return enemies <= 1 ? TUNING.strongHitFractionEndgame : TUNING.strongHitFraction;
}

module.exports = {
  POLICIES, TUNING, NOT_PORTED, RECIPES,
  init, partyTurn, afterPick, declareAttack, payRiders, redirectTargets, onEnemyAttack, onRoundStart, onTurnEnd, protectBar,
  bestElementAcross,
};
