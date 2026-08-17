// ============================================================================
// Lightning Storm — Rod-movement rule harness.
//
//     node scripts/conflict-event/events/lightning-storm.test.mjs
//
// Covers rodRecipientFor, the predicate deciding whether a damage event moves
// the Lightning Rod. Every subtle ruling in the design doc lands in one of
// these filters, and a mistake in any of them is invisible until it has
// already misfired at a table — the Rod silently sticking to one PC, or
// self-refreshing forever, or ping-ponging off Burn ticks nobody controls.
//
// Not covered here (needs a live Foundry): the AE writes themselves, and the
// singleton enforcement in moveRodTo.
// ============================================================================

globalThis.game = { user: { isGM: true } };
globalThis.canvas = null;

const { rodRecipientFor, strikeCinematicFor, rodDropOnDefeat } = await import("./lightning-storm.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const HERO = "Actor.hero";
const MONSTER = "Actor.monster";

const ev = (payload, trigger = "creature_lose_resource") => ({ trigger, payload });
const hit = (over = {}) => ev({
  resource: "hp", cause: "damage",
  subjectActorUuid: HERO, causeActorUuid: MONSTER,
  ...over,
});

// ── The common case ─────────────────────────────────────────────────────────

eq("a normal hit moves the Rod to the victim", rodRecipientFor(hit()), HERO);
eq("case is not significant",
  rodRecipientFor(hit({ resource: "HP", cause: "Damage" })), HERO);

// ── Rule: only HP loss ──────────────────────────────────────────────────────

eq("MP loss does not move it", rodRecipientFor(hit({ resource: "mp" })), null);
eq("IP loss does not move it", rodRecipientFor(hit({ resource: "ip" })), null);
eq("zero_power loss does not move it", rodRecipientFor(hit({ resource: "zero_power" })), null);
eq("shield loss does not move it", rodRecipientFor(hit({ resource: "shield" })), null);

// ── Rule: only creature-inflicted damage ────────────────────────────────────
// `hazard` is the single filter covering BOTH of the design's exclusions.

eq("the Rod's own strike does not move it (hazard)",
  rodRecipientFor(hit({ cause: "hazard" })), null);
eq("a Burn tick does not move it (hazard)",
  rodRecipientFor(hit({ cause: "hazard", originLabel: "Burn", element: "fire" })), null);
eq("a paid cost does not move it", rodRecipientFor(hit({ cause: "cost" })), null);
eq("a drain does not move it", rodRecipientFor(hit({ cause: "drain" })), null);
eq("a missing cause does not move it", rodRecipientFor(hit({ cause: null })), null);

// ── Rule: dealt by ANOTHER creature ─────────────────────────────────────────

eq("self-inflicted damage does not move it",
  rodRecipientFor(hit({ causeActorUuid: HERO })), null);
eq("damage with no known cause still moves it",
  rodRecipientFor(hit({ causeActorUuid: null })), HERO);

// ── Rule: the subject is the recipient, never the attacker ──────────────────
// Getting this backwards would hand the Rod to whoever swung, inverting the
// whole mechanic: attacking would protect you instead of endangering the target.

eq("the recipient is the victim, not the attacker",
  rodRecipientFor(hit({ subjectActorUuid: HERO, causeActorUuid: MONSTER })), HERO);
eq("and symmetrically the other way",
  rodRecipientFor(hit({ subjectActorUuid: MONSTER, causeActorUuid: HERO })), MONSTER);
eq("no subject → nothing to move it to",
  rodRecipientFor(hit({ subjectActorUuid: null })), null);

// ── Rule: only the loss family ──────────────────────────────────────────────
// An ABSORBING creature emits creature_gain_resource, not lose. Ignoring the
// gain family is what preserves "an absorber cannot GAIN the Rod" — the
// Electro Slime sponge behaviour is deliberate, not an oversight.

eq("an absorb (gain_resource) does not move it",
  rodRecipientFor(ev({ resource: "hp", cause: "damage", subjectActorUuid: HERO, causeActorUuid: MONSTER },
    "creature_gain_resource")), null);
eq("a defeat event does not move it",
  rodRecipientFor(ev({ resource: "hp", cause: "damage", subjectActorUuid: HERO }, "creature_defeated")), null);
eq("a status event does not move it",
  rodRecipientFor(ev({ resource: "hp", cause: "damage", subjectActorUuid: HERO }, "creature_status_applied")), null);

// ── Malformed input must never throw ────────────────────────────────────────
// This predicate runs inside the settle loop on every ledger event in the game.

eq("null cfg", rodRecipientFor(null), null);
eq("undefined cfg", rodRecipientFor(undefined), null);
eq("empty cfg", rodRecipientFor({}), null);
eq("trigger but no payload", rodRecipientFor({ trigger: "creature_lose_resource" }), null);

// ── strikeCinematicFor — who gets the light show ────────────────────────────
// `turn_start` is dispatched across EVERY combatant, so the acting-creature
// filter is the whole thing standing between one cinematic per strike and one
// cinematic per combatant per turn. The Rod is a singleton, but a strip→grant
// window or a rewind can briefly show two holders, so the predicate takes a
// list and answers only about the creature actually taking its turn.

const sc = (actingActorUuid, holderUuids) => strikeCinematicFor({ actingActorUuid, holderUuids });

eq("the holder's own turn plays the strike", sc(HERO, [HERO]), HERO);
eq("a non-holder's turn plays nothing", sc(MONSTER, [HERO]), null);
eq("nobody holds it → nothing", sc(HERO, []), null);
eq("acting creature among several holders still matches", sc(MONSTER, [HERO, MONSTER]), MONSTER);
eq("a transient double-hold that excludes the actor → nothing", sc("Actor.third", [HERO, MONSTER]), null);

// Malformed input — this runs at the top of every single turn in a Storm.
eq("no acting actor", sc(null, [HERO]), null);
eq("no holder list", sc(HERO, null), null);
eq("no arguments at all", strikeCinematicFor(), null);
eq("empty object", strikeCinematicFor({}), null);

// ── rodDropOnDefeat — the Rod dies with its holder ──────────────────────────
// Regression: this was DESIGNED from the start ("holder is defeated → Rod dies
// with them") and never implemented. The failure was not neutral. From the
// moment a holder is defeated the strip cannot see them at all (collectReactors
// omits the downed), so the Rod sat on the corpse while rule 5 — which only
// counts live holders — seeded a replacement every round. A round-5 playtest
// had three Rods on three KO'd PCs.

eq("a defeat drops the subject's Rod",
  rodDropOnDefeat({ trigger: "creature_defeated", payload: { subjectActorUuid: HERO } }), HERO);
eq("the DEFEATED creature is the subject, not the killer",
  rodDropOnDefeat({ trigger: "creature_defeated", payload: { subjectActorUuid: HERO, causeActorUuid: MONSTER } }), HERO);

// Only defeat drops it. Every other ledger event in the family must fall
// through to the rule-3 movement path instead of silently deleting a Rod.
eq("an hp loss does not drop it", rodDropOnDefeat(hit()), null);
eq("a status event does not drop it",
  rodDropOnDefeat({ trigger: "creature_status_applied", payload: { subjectActorUuid: HERO } }), null);
eq("a gain event does not drop it",
  rodDropOnDefeat({ trigger: "creature_gain_resource", payload: { subjectActorUuid: HERO } }), null);

// The two predicates must never both claim the same event, or a defeat would
// move the Rod ONTO the corpse and then drop it (or worse, depending on order).
const defeatEvent = { trigger: "creature_defeated", payload: { resource: "hp", cause: "damage", subjectActorUuid: HERO, causeActorUuid: MONSTER } };
eq("defeat is not also a rod-movement event", rodRecipientFor(defeatEvent), null);
eq("...while it IS a drop event", rodDropOnDefeat(defeatEvent), HERO);

// Malformed input.
eq("defeat with no subject", rodDropOnDefeat({ trigger: "creature_defeated", payload: {} }), null);
eq("defeat with no payload", rodDropOnDefeat({ trigger: "creature_defeated" }), null);
eq("null cfg to the drop predicate", rodDropOnDefeat(null), null);
eq("empty cfg to the drop predicate", rodDropOnDefeat({}), null);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
