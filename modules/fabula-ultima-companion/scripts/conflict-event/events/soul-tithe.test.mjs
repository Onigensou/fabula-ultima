// Bare-Node harness for Soul Tithe's pure rules.
//   node scripts/conflict-event/events/soul-tithe.test.mjs
import { callingSteal, resolveCalling, lockWound, returnedHp, fragmentMayCall, fragmentName, MAX_HP_FLOOR } from "./soul-tithe.js";

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error(`FAIL ${name}`); } }
const eq = (name, a, b) => ok(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b));

// One full round end, in the event's order: Calling, then the lock.
function roundEnd(s, { mayCall = true } = {}) {
  let { max, hp, fHp, fMax } = s;
  if (mayCall && fHp > 0 && hp > 0) {
    const r = resolveCalling({ ownerMax: max, ownerHp: hp, fragmentHp: fHp, fragmentMax: fMax });
    ({ ownerMax: max, ownerHp: hp, fragmentHp: fHp, fragmentMax: fMax } = r);
  }
  const w = lockWound({ ownerMax: max, ownerHp: hp });
  return { max: max - w, hp, fHp: fHp + w, fMax: fMax + w };
}

// The lock
eq("lock: wounded", lockWound({ ownerMax: 120, ownerHp: 90 }), 30);
eq("lock: full HP", lockWound({ ownerMax: 120, ownerHp: 120 }), 0);
eq("lock: KO'd is skipped", lockWound({ ownerMax: 120, ownerHp: 0 }), 0);
eq("lock: 1 HP leaves the floor", lockWound({ ownerMax: 120, ownerHp: 1 }), 119);

// Calling: the settled numbers from the design talk
eq("steal = fragment current HP", callingSteal({ fragmentHp: 30, ownerMax: 90 }), 30);
eq("steal stops at the floor", callingSteal({ fragmentHp: 60, ownerMax: 60 }), 60 - MAX_HP_FLOOR);
eq("nothing left to steal", callingSteal({ fragmentHp: 60, ownerMax: 1 }), 0);
eq("adds the stolen amount, does not heal to full",
  resolveCalling({ ownerMax: 60, ownerHp: 60, fragmentHp: 10, fragmentMax: 60 }),
  { stolen: 10, ownerMax: 50, ownerHp: 50, fragmentHp: 20, fragmentMax: 70 });
eq("the stolen amount takes missing HP first",
  resolveCalling({ ownerMax: 90, ownerHp: 70, fragmentHp: 30, fragmentMax: 30 }).ownerHp, 60);

// Hina, 120 HP, one 30-damage hit, fragment ignored: 30 -> 60 -> 119, she ends 1/1.
let s = { max: 120, hp: 90, fHp: 0, fMax: 0 };
s = roundEnd(s, { mayCall: false });
eq("end of round 1", s, { max: 90, hp: 90, fHp: 30, fMax: 30 });
s = roundEnd(s);
eq("end of round 2", s, { max: 60, hp: 60, fHp: 60, fMax: 60 });
s = roundEnd(s);
eq("end of round 3", s, { max: 1, hp: 1, fHp: 119, fMax: 119 });
eq("the invariant: fragment Max is all that was stolen", s.fMax, 120 - s.max);
s = roundEnd(s);
eq("end of round 4: nothing left, nothing changes", s, { max: 1, hp: 1, fHp: 119, fMax: 119 });

// Wound and Calling overlap: the player loses the larger, not both.
let w = roundEnd({ max: 90, hp: 70, fHp: 30, fMax: 30 });
eq("wound 20 < Calling 30: loses 30", w, { max: 60, hp: 60, fHp: 60, fMax: 60 });
w = roundEnd({ max: 90, hp: 40, fHp: 30, fMax: 30 });
eq("wound 50 > Calling 30: loses 50", w, { max: 40, hp: 40, fHp: 80, fMax: 80 });
eq("the invariant holds with a wound", w.fMax, 120 - w.max);
w = roundEnd({ max: 90, hp: 70, fHp: 20, fMax: 30 });
eq("a chipped fragment steals less", w, { max: 70, hp: 70, fHp: 40, fMax: 50 });
eq("the invariant holds when chipped", w.fMax, 120 - w.max);

// Destroying it
eq("return: Max and HP both come back", returnedHp({ ownerHp: 1, ownerMax: 120, stolen: 119 }), 120);
eq("return: a fresh wound stays a wound", returnedHp({ ownerHp: 50, ownerMax: 120, stolen: 40 }), 90);
eq("return: capped at Max", returnedHp({ ownerHp: 110, ownerMax: 120, stolen: 40 }), 120);
eq("return: a KO'd owner stays down", returnedHp({ ownerHp: 0, ownerMax: 120, stolen: 40 }), 0);

// Timing
ok("a new fragment does not Call", !fragmentMayCall({ spawnRound: 3, calledRound: 0, round: 3 }));
ok("it Calls the round after", fragmentMayCall({ spawnRound: 3, calledRound: 0, round: 4 }));
ok("once a round, even after an F5", !fragmentMayCall({ spawnRound: 3, calledRound: 4, round: 4 }));
eq("name", fragmentName("Hina"), "Hina's Soul Fragment");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
