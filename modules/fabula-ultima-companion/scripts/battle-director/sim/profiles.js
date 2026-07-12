// Player Profiles — how each PC plays, for the automated playtest.
//
// A profile has two layers, because one alone can't express a real turn:
//
//   rows[]   — a rotation table, in the EXACT shape an NPC's `action_pattern_table`
//              uses. The brain injects these into ActionReader, so the party gets
//              the same engine the monsters do: cost feasibility, affinity-aware
//              targeting, anti-repeat, and debuff gating, all for free.
//
//   policy() — a code hook that runs FIRST and can pre-empt the rotation. The
//              table's conditions are all self-referential (own hp/mp/round/…);
//              there is no "an ally is hurt" condition, so healing — the single
//              most important thing a real party does — cannot be expressed as a
//              row at all. That lives here.
//
// STATUS: BASIC. These are first-draft rotations written from each PC's real kit,
// not from watching you play. They exist to make the sim's numbers mean something
// rather than to be correct. Treat every fight result as provisional until the
// profiles are tuned against how the party ACTUALLY plays.
//
// Known simplifications, all of which make the party read WEAKER than it is:
//   - no Fabula Point spends, no Opportunity picks (the sim declines those)
//   - no equipment swaps, no item/consumable use
//   - Blanche's Adoration-cost skills are not cost-checked (feasibility only
//     parses MP/IP), so her rotation stays deliberately thin

import { SimMode } from "./sim-mode.js";

// ── Tuning ──────────────────────────────────────────────────────────────────
// The judgement calls, in one place, so they can be moved from what the fights
// actually look like rather than from what anyone guessed up front. These are the
// numbers most likely to be wrong on the first pass — change them here.
export const TUNING = {
  // What counts as a hit worth spending a defensive reaction on: this fraction of
  // the target's MAX hp, or lethal.
  strongHitFraction: 0.30,
  // …and once it's down to the LAST enemy, the fight is won on action economy and
  // the only way to lose it is to drop somebody. So Blanche stops saving Protect for
  // a big hit that may never come and starts eating anything worth eating.
  strongHitFractionEndgame: 0.12,
  // What counts as "she can take it": at most this fraction of HER max hp.
  safeDamageFraction: 0.10,
  // Blanche's Protect, per round.
  protectPerRound: 1,
  // Hina only bothers redirecting an action onto herself if it hits this many.
  propheticMinTargets: 2,

  // Hina's heal is a LAST RESORT (user's spec): she stays on the offensive unless
  // an ally is genuinely about to die AND the party's defensive answer (Blanche's
  // Protect) is already spent this round.
  healKoRiskFraction: 0.30,   // an ally at/below this much max hp could be KO'd
  healWorthItFraction: 0.60,  // "hurt enough to be worth a heal slot"
  healMinTargets: 2,          // wait for this many hurt allies — Heal covers 3
  healEmergencyFraction: 0.15, // …unless someone is THIS low, then go now
  healMaxTargets: 3,          // Heal's own cap ("Up to three creatures")

  // Hina's ice. Iceberg is the bigger single hit; Glacies covers up to three.
  // We can't project Iceberg's damage before COMPUTE, so "can it finish them?" is
  // an HP threshold — the honest version of the question, and a knob rather than a
  // guess hidden in the logic. Raise it if she keeps failing to close kills.
  icebergKoHp: 60,
  glaciesMinWeak: 2,      // this many ice-VULNERABLE enemies makes Glacies pay
  glaciesMaxTargets: 3,   // Glacies' own cap

  // Acceleration grants an ally an extra action. Gated on the AE not already being
  // on the field rather than on a round cadence — re-casting it on someone who is
  // still accelerated is a wasted turn, and Hina's time is better spent on damage.
  accelerationPriority: ["Zarg", "Keren"],   // damage dealers, not the tank
  accelerationAe: /accelerat/i,
  // Stop strips an enemy activation. Only worth the turn when it removes a
  // meaningful share of the enemy's economy — i.e. when there is exactly one enemy
  // left. With two or more there is always somebody else to act anyway.
  stopMaxEnemies: 1,

  // Zarg's Gadgets: augments a normal attack (buff + element swap) for IP.
  gadgetIpCost: 2,
  gadgetReserveIp: 0,   // keep this much IP back for emergencies
  // Warning Shot is an opener — after round 1 he is better off just shooting.
  warningShotRounds: [1],

  // ── MP economy ────────────────────────────────────────────────────────────
  // The fight visibly slowed down late as the casters ran dry. A real party fixes
  // that with consumables, so the sim should too.
  mpItemThreshold: 0.30,   // an ally under this much MP wants a top-up
  mpItemMinTargets: 1,     // how many must be dry before somebody spends a turn
  mpItemsPerRound: 1,      // at most one party member plays potion-caddy per round
  hpItemsPerRound: 1,      // …and at most one emergency IP-bought heal
  // Who takes potion duty first. Zarg leads because Potion Rain makes his
  // consumables hit the whole party — one turn, everyone refilled.
  potionPriority: ["Zarg"],

  // Revival. The count the party carries is set per RUN (the sim panel), because
  // it's a scenario variable, not a character trait.
  phoenixFeather: /phoenix\s*feather/i,

  // ── Focus fire ────────────────────────────────────────────────────────────
  // A wounded enemy is a magnet: below this fraction of max HP the party drops
  // whatever it was doing and finishes them.
  focusLowHpFraction: 0.40,
  // Deviating from the called target is allowed only when the focus is a genuinely
  // terrible target for THIS character (they'd feed an absorb). Otherwise everyone
  // hits the same thing, because concentrated damage is what actually kills.
  focusRespectAffinity: true,
};

// Build one pattern row in the raw shape readPatternTable expects
// ({ rowKey, rowIndex, data }), keyed by the action_pattern_* props.
export function row(i, { name, cond = "always", v1 = 0, v2 = 0, str = "", prio = 10, focus = "", cd = 0 }) {
  return {
    rowKey: `sim-${i}`,
    rowIndex: i,
    data: {
      action_pattern_name: name,
      action_pattern_condition: cond,
      action_pattern_value_1: v1,
      action_pattern_value_2: v2,
      action_pattern_string: str,
      action_pattern_priority: prio,
      action_pattern_target_focus: focus,
      action_pattern_cooldown: cd,
      $deleted: false,
    },
  };
}

// ── Policy helpers ──────────────────────────────────────────────────────────
export const pct = (cur, max) => {
  const c = Number(cur), m = Number(max);
  if (!Number.isFinite(c) || !Number.isFinite(m) || m <= 0) return 1;
  return c / m;
};

const propNum = (actor, key) => Number(actor?.system?.props?.[key]);

// The most-hurt living ally (including self), as { dc, frac } — or null.
function weakestAlly(api) {
  const allies = api.allies();
  if (!allies.length) return null;
  const scored = allies.map((dc) => ({
    dc,
    frac: pct(propNum(dc.actorDoc, "current_hp"), propNum(dc.actorDoc, "max_hp")),
  }));
  scored.sort((a, b) => a.frac - b.frac);
  return scored[0];
}

// A simple heal: worst-off ally below `threshold`, pay, cast. Used by anyone whose
// heal is a straightforward "top someone up" (Blanche, Keren).
function healPolicy({ spellName, threshold = 0.45, mpCost = 10 }) {
  return (api) => {
    const worst = weakestAlly(api);
    if (!worst || worst.frac > threshold) return null;
    if (propNum(api.self, "current_mp") < mpCost) return null;
    const item = api.findItem(spellName);
    if (!item) return null;
    return api.castOn(item, [worst.dc]);
  };
}

// Hina's heal, which is a different animal (user's spec): a LAST RESORT, not a
// reflex. She stays on the offensive while the party still has a defensive answer,
// and when she does heal she tries to make the action pay for itself — Heal covers
// up to three creatures, so topping up one target is a wasted turn.
//
// The gate, in order:
//   1. Is anyone actually at risk of dying?            (else stay on offense)
//   2. Has Blanche already spent her Protect?          (else SHE handles it)
//   3. Is it worth the action yet — enough hurt allies to fill the cast —
//      unless somebody is critical, in which case go now and don't be clever.
function hinaHealPolicy(api) {
  const round = api.round;
  const allies = api.allies();
  if (!allies.length) return null;

  const hurt = allies
    .map((dc) => ({ dc, frac: pct(propNum(dc.actorDoc, "current_hp"), propNum(dc.actorDoc, "max_hp")) }))
    .filter((a) => a.frac < TUNING.healWorthItFraction)
    .sort((a, b) => a.frac - b.frac);

  if (!hurt.length) return null;

  const atRisk = hurt.filter((a) => a.frac <= TUNING.healKoRiskFraction);
  const critical = hurt.some((a) => a.frac <= TUNING.healEmergencyFraction);

  // ENDGAME. One enemy left means four actions against one — the fight is already
  // won on economy, and all that remains is closing it out without losing anybody.
  // So the pressure to keep pushing damage comes off: top the party up now rather
  // than waiting for someone to nearly die. Racing a fight you have already won is
  // how a clean victory turns into a casualty.
  if (api.isEndgame()) return api.castOn(api.findItem("Heal"), hurt.slice(0, TUNING.healMaxTargets).map((a) => a.dc));

  // 1. Nobody is close to dying → keep casting Ice.
  if (!atRisk.length && !critical) return null;

  // 2. Blanche can still Protect → that is the party's answer to this, not a heal.
  //    Skipped when it is already an emergency: at that point nobody is being cute.
  if (!critical && !api.protectExhausted(round)) return null;

  // 3. Action economy: hold until the cast is worth its slot — unless critical.
  if (!critical && hurt.length < TUNING.healMinTargets) return null;

  const item = api.findItem("Heal");
  if (!item) return null;

  // "10 x T MP" — per target. Only bring as many targets as she can pay for.
  const mp = propNum(api.self, "current_mp");
  const affordable = Math.max(1, Math.floor(mp / 10));
  const targets = hurt.slice(0, Math.min(TUNING.healMaxTargets, affordable)).map((a) => a.dc);
  if (!targets.length || mp < 10) return null;

  return api.castOn(item, targets);
}

export const ELEMENTS = ["air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"];

// ── Focus fire ──────────────────────────────────────────────────────────────
// Four characters each picking their own favourite target spreads damage across the
// whole enemy line, and spread damage kills nothing. Nothing dying means nobody
// stops acting — which is a large part of why the AI needs 9 rounds where the table
// needs 3. Real players just say "everyone on the big one", so the party gets to do
// the same: ONE called target, shared by all four brains, held until it dies.
//
// Two rules, both of them things a table does without thinking:
//   1. A wounded enemy is a magnet. Anything under focusLowHpFraction gets finished,
//      overriding the standing call — a corpse stops taking turns.
//   2. Otherwise, stick with the call. Switching targets mid-fight is how you end up
//      with three enemies on half health instead of one dead one.
//
// The fresh call goes to whoever dies soonest (lowest current HP), because removing
// a body is worth more than damaging two.
//
// Yes, this "knows" enemy HP the players wouldn't. That's the user's explicit call
// and it is the right one: at a real table the GM's descriptions, the damage numbers
// and simple counting give players a good enough read, and modelling the fog would
// mostly add noise to a balance signal.
export function refreshFocus(api) {
  const foes = api.foes();
  if (!foes.length) { api.setFocus(null); return null; }

  const hurt = foes
    .filter((f) => pct(propNum(f.actorDoc, "current_hp"), propNum(f.actorDoc, "max_hp")) <= TUNING.focusLowHpFraction)
    .sort((a, b) => propNum(a.actorDoc, "current_hp") - propNum(b.actorDoc, "current_hp"));

  if (hurt.length) {
    const kill = hurt[0];
    if (api.focusUuid() !== kill.tokenUuid) {
      SimMode.note("focus", `party switches to ${kill.name} — they're nearly down`);
    }
    api.setFocus(kill.tokenUuid);
    return kill;
  }

  // Standing call still alive? Keep it.
  const current = foes.find((f) => f.tokenUuid === api.focusUuid());
  if (current) return current;

  const call = foes
    .slice()
    .sort((a, b) => propNum(a.actorDoc, "current_hp") - propNum(b.actorDoc, "current_hp"))[0];
  api.setFocus(call.tokenUuid);
  SimMode.note("focus", `party calls the target: ${call.name}`);
  return call;
}

// The called target, IF it's a sane thing for this character to hit. A character
// whose element the focus absorbs would be healing it — they peel off rather than
// blindly obey the call, which is also what a real player does.
export function focusFor(api, element = null) {
  const foes = api.foes();
  const focus = foes.find((f) => f.tokenUuid === api.focusUuid());
  if (!focus) return null;
  if (!TUNING.focusRespectAffinity || !element) return focus;

  const aff = api.affinityOf(focus, element);
  if (aff === "AB" || aff === "IM") return null;   // don't feed it — pick your own
  return focus;
}

// ── Revival (party-wide, runs before everything) ────────────────────────────
// A downed ally is a death spiral: the party loses a quarter of its output, takes
// the same incoming damage, and falls further behind — which is exactly how the run
// where Keren went down early ended in a wipe.
//
// The ordering is the user's, and it is the right one: stabilise the LIVING first.
// Reviving somebody at half HP while another ally is one hit from joining them just
// trades one corpse for another. So a feather is only spent when nobody still
// standing is in danger — otherwise this abstains and the heal policies take the
// turn instead.
export function revivePolicy(api) {
  const down = api.koAllies();
  if (!down.length) return null;

  const threatened = api.allies().some(
    (dc) => pct(propNum(dc.actorDoc, "current_hp"), propNum(dc.actorDoc, "max_hp")) <= TUNING.healKoRiskFraction
  );
  if (threatened) return null;   // heal first — a revive now just makes two casualties

  // A revive is USE-only: it is a carried consumable with finite stock, and unlike
  // an Elixir there is no IP recipe for one. This is exactly the distinction the
  // sim now draws — you cannot conjure your way out of a death.
  const feather = api.findItemByName(TUNING.phoenixFeather);
  if (!feather) return null;

  // Bring back whoever will survive the longest on a crisis-score revive (the item
  // restores to ~50%), so the party gets a body that can actually hold a line.
  const target = down
    .slice()
    .sort((a, b) => propNum(b.actorDoc, "max_hp") - propNum(a.actorDoc, "max_hp"))[0];

  return api.useItem(feather, [target]);
}

// ── MP economy (party-wide, runs before every profile) ──────────────────────
// The fight slowed to a crawl late on because the casters ran out of MP and fell
// back to poking with sticks. A real party fixes that with a consumable, so this
// runs for EVERY character, ahead of their own policy.
//
// MP-restorers are found by EFFECT, not by name: a consumable whose effect_table
// grants `mp` (Elixir, Grape Juice, whatever gets added next). No name list to
// maintain and nothing to forget.
//
// Zarg gets first refusal because Potion Rain (creature_performs_action) turns his
// consumable into an area effect — one turn, the whole party refilled. Everybody
// else defers to him while he is alive and holding one; if he isn't, whoever has a
// potion picks up the duty rather than letting the party grind to a halt.
export function mpItemPolicy(api) {
  const round = api.round;
  if (api.budgetSpent(round, "mp-item") >= TUNING.mpItemsPerRound) return null;

  const dry = api.allies().filter(
    (dc) => pct(propNum(dc.actorDoc, "current_mp"), propNum(dc.actorDoc, "max_mp")) < TUNING.mpItemThreshold
  );
  if (dry.length < TUNING.mpItemMinTargets) return null;

  // CREATE beats USE. Paying IP for an Elixir is something ANYONE can do and costs
  // no stock, whereas a carried consumable is finite and only whoever holds it can
  // spend it. So reach for the IP first and keep the pack for what IP can't buy.
  const recipe = api.findCreatableRestoring("mp");
  const carried = recipe ? null : api.findConsumableRestoring("mp");
  if (!recipe && !carried) return null;

  // Zarg still gets first refusal — Potion Rain turns his item into an area effect,
  // so one turn from him refills everybody. Defer to him only while he can actually
  // do it (has the IP or the item); otherwise whoever can, does.
  const preferred = TUNING.potionPriority.find((name) =>
    api.allies().some((dc) => new RegExp(name, "i").test(dc.name ?? "") && api.allyCanRestore(dc, "mp"))
  );
  const iAmPreferred = preferred && new RegExp(preferred, "i").test(api.self?.name ?? "");
  if (preferred && !iAmPreferred) return null;

  api.spendBudget(round, "mp-item");

  const target = dry.sort(
    (a, b) => pct(propNum(a.actorDoc, "current_mp"), propNum(a.actorDoc, "max_mp"))
            - pct(propNum(b.actorDoc, "current_mp"), propNum(b.actorDoc, "max_mp"))
  )[0];

  return recipe ? api.createItem(recipe, [target]) : api.useItem(carried, [target]);
}

// Emergency HP, paid in IP. "Anyone can pay IP to restore HP or MP" — so a
// character with no heal spell (or no MP left to cast one) is not helpless when an
// ally is about to die: they can conjure an Apple Juice. Only fires when somebody is
// genuinely at KO risk, so it never competes with putting damage out.
export function hpItemPolicy(api) {
  const round = api.round;
  if (api.budgetSpent(round, "hp-item") >= TUNING.hpItemsPerRound) return null;

  const dying = api.allies().filter(
    (dc) => pct(propNum(dc.actorDoc, "current_hp"), propNum(dc.actorDoc, "max_hp")) <= TUNING.healKoRiskFraction
  );
  if (!dying.length) return null;

  // If I can cast a real heal, do that instead — it heals more and up to three.
  const heal = api.findItem("Heal");
  if (heal && propNum(api.self, "current_mp") >= 10) return null;

  const recipe = api.findCreatableRestoring("hp");
  const carried = recipe ? null : api.findConsumableRestoring("hp");
  if (!recipe && !carried) return null;

  api.spendBudget(round, "hp-item");

  const target = dying.sort(
    (a, b) => pct(propNum(a.actorDoc, "current_hp"), propNum(a.actorDoc, "max_hp"))
            - pct(propNum(b.actorDoc, "current_hp"), propNum(b.actorDoc, "max_hp"))
  )[0];

  return recipe ? api.createItem(recipe, [target]) : api.useItem(carried, [target]);
}

// ── Hina's turn ─────────────────────────────────────────────────────────────
// Her whole turn is a judgement call, so none of it can live in a pattern row.
//
//   1. Heal        — last resort only (see hinaHealPolicy).
//   2. Acceleration— on a cadence, and only when nobody needs healing.
//   3. Stop        — shave an activation off a small enemy field.
//   4. Ice         — Glacies vs Iceberg, chosen properly (below).
//
// GLACIES vs ICEBERG is the interesting one. Iceberg is the bigger single-target
// hit; Glacies covers up to three. So: if Iceberg can finish someone, finish them.
// Otherwise, if two or more enemies are weak to ice, Glacies pays for itself.
// Otherwise Iceberg.
//
// We cannot cheaply predict Iceberg's damage before COMPUTE runs, so "can it KO?"
// is a tunable HP threshold rather than a real projection. It is the honest
// version of the question and it is a knob (TUNING.icebergKoHp), not a guess
// buried in the logic.
function hinaOffense(api) {
  const foes = api.foes();
  if (!foes.length) return null;

  const iceberg = api.findItem("Iceberg");
  const glacies = api.findItem("Glacies");
  const takesIce = (f) => !["RS", "IM", "AB"].includes(api.affinityOf(f, "ice"));

  // 1. Can Iceberg finish someone off? Then do that — a dead enemy stops acting.
  if (iceberg) {
    const finishable = foes
      .filter((f) => takesIce(f) && propNum(f.actorDoc, "current_hp") <= TUNING.icebergKoHp)
      .sort((a, b) => propNum(a.actorDoc, "current_hp") - propNum(b.actorDoc, "current_hp"))[0];
    if (finishable) return api.castOn(iceberg, [finishable]);
  }

  // 2. Enough targets weak to ice → Glacies hits up to three of them. (Only worth
  //    breaking focus for: an AOE isn't spreading damage, it's adding it.)
  if (glacies) {
    const weak = foes.filter((f) => api.affinityOf(f, "ice") === "VU");
    if (weak.length >= TUNING.glaciesMinWeak) {
      return api.castOn(glacies, weak.slice(0, TUNING.glaciesMaxTargets));
    }
  }

  // 3. Single hit — on the party's CALLED target if ice does anything to them.
  if (iceberg) {
    const called = focusFor(api, "ice");
    if (called) return api.castOn(iceberg, [called]);

    const target = foes
      .filter(takesIce)
      .sort((a, b) => {
        const av = api.affinityOf(a, "ice") === "VU" ? 0 : 1;
        const bv = api.affinityOf(b, "ice") === "VU" ? 0 : 1;
        return av - bv || propNum(a.actorDoc, "current_hp") - propNum(b.actorDoc, "current_hp");
      })[0];
    if (target) return api.castOn(iceberg, [target]);
  }

  return null;   // no ice available (or nobody takes it) → rotation / basic attack
}

function hinaPolicy(api) {
  // 1. Heal — last resort, fully gated.
  const heal = hinaHealPolicy(api);
  if (heal) return heal;

  const allies = api.allies();
  const anyoneHurt = allies.some(
    (dc) => pct(propNum(dc.actorDoc, "current_hp"), propNum(dc.actorDoc, "max_hp")) < TUNING.healWorthItFraction
  );

  // 2. Acceleration — an extra action for an ally is the strongest thing she can do
  //    with a quiet turn. Gated on nobody ALREADY being accelerated: re-casting it
  //    on someone who still has the AE is a thrown-away turn, and the point of the
  //    gate is to buy her more time on damage.
  if (!anyoneHurt && !allies.some((dc) => api.hasAe(dc, TUNING.accelerationAe))) {
    const acc = api.findItem("Acceleration");
    if (acc) {
      const target = pickAccelerationTarget(api, allies);
      if (target) return api.castOn(acc, [target]);
    }
  }

  // 3. Stop — strips an activation. Only worth the turn when it takes a real bite
  //    out of the enemy's economy (i.e. one enemy left), and only against somebody
  //    who still has an activation to lose this round.
  if (api.foes().length <= TUNING.stopMaxEnemies) {
    const stop = api.findItem("Stop");
    const victim = api.foes()
      .filter((f) => (f.turnsRemaining ?? 0) >= 1)
      .sort((a, b) => (b.turnsRemaining ?? 0) - (a.turnsRemaining ?? 0))[0];
    if (stop && victim) return api.castOn(stop, [victim]);
  }

  // 4. Ice.
  return hinaOffense(api);
}

// Whoever benefits most from an extra action: a damage dealer, not the tank and
// not herself. Name-ordered so it's obvious and editable rather than inferred.
function pickAccelerationTarget(api, allies) {
  const others = allies.filter((dc) => dc.actorDoc?.uuid !== api.self?.uuid);
  for (const want of TUNING.accelerationPriority) {
    const hit = others.find((dc) => new RegExp(want, "i").test(dc.name ?? ""));
    if (hit) return hit;
  }
  return others[0] ?? null;
}

// ── The profiles ────────────────────────────────────────────────────────────
// Keyed by actor name (the clone's " [SIM]" suffix is stripped before lookup).
export const PROFILES = {
  // Ice mage / healer. The single biggest lesson of the first live run: she owns
  // Iceberg + Glacies and never cast them, while the Wandering Flame sat there
  // Ice-VULNERABLE. by_affinity targeting is the whole point of her rotation.
  // Ice caster. Almost her whole turn is judgement the rotation table cannot make,
  // so it all lives in the policy: pick the RIGHT ice spell, slot in utility on a
  // cadence, heal only as a last resort. Her big defensive contribution — Prophetic
  // Defender — is a REACTION and lives in reaction-brain.js.
  Hina: {
    label: "Hina — ice caster; utility on a cadence, heals last",
    policy: hinaPolicy,
    rows: [
      // Only the MP-starved fallback. Everything else is decided above.
      row(0, { name: "Drain Spirit", cond: "mp", v1: 0, v2: 19, prio: 8, focus: "auto" }),
    ],
  },

  // Archer — and his turn is simply to SHOOT. Nearly his whole kit is augments that
  // ride on that shot rather than replace it:
  //     Barrage      creature_performs_action     (10 MP)
  //     Warning Shot creature_will_deal_damage    (free)
  //     Gadgets      creature_will_deal_damage    (2 IP)  — buff + element swap
  //     High Speed   conflict_start               (fires itself; never "cast")
  // All four live in reaction-brain.js. An empty rotation is CORRECT here: the
  // brain falls through to an affinity-aimed basic attack, and the augments then
  // stack onto it. Declaring any of them as a turn action burns the turn and does
  // nothing — which is exactly what "Zarg keeps casting Barrage and never attacks"
  // was. (isAugment() in player-brain.js now blocks that structurally.)
  Zarg: {
    label: "Zarg — archer; his kit rides on the shot, so he just shoots",
    policy: null,
    rows: [],
  },

  // Phantasm controller.
  //
  // Detonate Phantasm needs a PHANTASM ON THE FIELD — a precondition that exists
  // nowhere on the item, so neither ActionReader nor any row condition can see
  // it. Declared without one, the FSM bounces back to DECLARE and a deterministic
  // brain re-picks it forever; that is exactly what parked our first profiled
  // run. The re-declare guard now catches this class of thing generically, but
  // guessing wrong still burns a turn — so gate it properly here, in the policy
  // layer, which is the one place that can look at the actual board.
  //
  // Create Phantasm: Strike is free, so it is the floor.
  // She ALTERNATES: conjure a phantasm, then blow it up. Detonate needs one on the
  // field — a precondition that exists nowhere on the item, so only the policy
  // layer (which can see the board) can gate it. Her damage riders — Thermokinesis
  // and For Whom the Bell Tolls — are REACTIONS on her own action card and live in
  // reaction-brain.js; they fire when the target won't shrug the damage off.
  Keren: {
    label: "Keren — alternates Create ↔ Detonate Phantasm",
    policy: (api) => {
      const heal = healPolicy({ spellName: "Life Transference", threshold: 0.3, mpCost: 20 })(api);
      if (heal) return heal;

      const hasPhantasm = api.allies().some((dc) => /phantasm|numen/i.test(dc.name ?? ""));
      if (!hasPhantasm) return null;   // nothing to detonate → rotation conjures one

      const spell = api.findItem("Detonate Phantasm");
      if (!spell || propNum(api.self, "current_mp") < 20) return null;

      const foes = api.foes();
      if (!foes.length) return null;
      // Detonate is VAR_ELEMENT, so there is no element to reason about — just put
      // it on the called target.
      const target = focusFor(api) ?? foes.slice().sort((a, b) =>
        propNum(a.actorDoc, "current_hp") - propNum(b.actorDoc, "current_hp"))[0];
      return api.castOn(spell, [target]);
    },
    rows: [
      row(0, { name: "Create Phantasm: Strike", cond: "always", prio: 14, focus: "lowest_hp" }),
    ],
  },

  // Tank / support. Her damage skills cost Adoration, which the feasibility check
  // cannot see (it only parses MP/IP), so the rotation stays thin on purpose and
  // she leans on Heal + her weapon. Guarding is handled by the terminal fallback.
  Blanche: {
    label: "Blanche — tank, healing support",
    policy: healPolicy({ spellName: "Heal", threshold: 0.5, mpCost: 10 }),
    rows: [
      row(0, { name: "Muleta", cond: "always", prio: 12, focus: "lowest_hp" }),
    ],
  },
};

// Anything not named above: no rotation, no policy — the brain falls straight
// through to an affinity-aware basic attack. A sane floor for a guest or a PC
// nobody has written up yet.
export const GENERIC_PROFILE = { label: "generic — basic attacks only", policy: null, rows: [] };

export function profileFor(actorName) {
  const base = String(actorName ?? "").replace(/\s*\[SIM\]\s*$/i, "").trim();
  return PROFILES[base] ?? GENERIC_PROFILE;
}
