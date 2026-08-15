/**
 * Who advancement is for: the PC/NPC discriminator and the UI target it feeds.
 *
 * advancement-subject touches no Foundry global at import time — only inside
 * advancementTarget(), which reads `canvas` and `game` when called — so this
 * runs in plain node with those stubbed per case.
 *
 *   node scripts/advancement/advancement-subject.test.mjs
 */
const S = await import("./advancement-subject.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};

/** An actor-shaped stub. Pass only the props under test. */
const actor = (props, name = "stub") => ({ name, system: { props } });

// ── isAdvancementSubject ───────────────────────────────────────────────────
{
  console.log("\nisAdvancementSubject");

  eq("a PC carries neither marker",
    S.isAdvancementSubject(actor({ level: 41, mig_base: "10" }, "Hina")), true);
  eq("an actor with no props at all is a subject",
    S.isAdvancementSubject({ name: "bare" }), true);
  eq("an actor with no system is a subject",
    S.isAdvancementSubject({ name: "bare", system: {} }), true);

  eq("rank + species is an NPC",
    S.isAdvancementSubject(actor({ level: 45, npc_rank: "elite", species: "MONSTER" }, "Flame Drake")), false);
  eq("rank alone is an NPC",
    S.isAdvancementSubject(actor({ level: 32, npc_rank: "soldier" })), false);

  // The case a rank-only test waves straight through. Cardinal Gora is level 30
  // with an EMPTY npc_rank and species HUMANOID; without the species half of
  // the check it would badge as a player character.
  eq("species alone is an NPC (the Cardinal Gora case)",
    S.isAdvancementSubject(actor({ level: 30, npc_rank: "", species: "HUMANOID" }, "Cardinal Gora")), false);

  eq("blank markers are not markers",
    S.isAdvancementSubject(actor({ level: 41, npc_rank: "", species: "" })), true);
  eq("whitespace-only markers are not markers",
    S.isAdvancementSubject(actor({ level: 41, npc_rank: "  ", species: "\t" })), true);
  eq("null markers are not markers",
    S.isAdvancementSubject(actor({ level: 41, npc_rank: null, species: null })), true);

  eq("no actor is not a subject", S.isAdvancementSubject(null), false);
  eq("undefined is not a subject", S.isAdvancementSubject(undefined), false);
}

// ── subjectFailure ─────────────────────────────────────────────────────────
{
  console.log("\nsubjectFailure");

  eq("a PC has no failure", S.subjectFailure(actor({ level: 41 })), null);
  eq("an NPC reports the wrong-subject reason",
    S.subjectFailure(actor({ npc_rank: "champion", species: "HUMANOID" })), "not_a_player_character");
  // The write handlers check `!actor` first, but the reason must still be the
  // right one if this is ever called on its own.
  eq("a missing actor reports not-found, not wrong-subject",
    S.subjectFailure(null), "actor_not_found");
}

// ── advancementTarget ──────────────────────────────────────────────────────
{
  console.log("\nadvancementTarget");

  const setup = (selected, own) => {
    globalThis.canvas = { tokens: { controlled: selected ? [{ actor: selected }] : [] } };
    globalThis.game = { user: { character: own ?? null } };
  };

  const hina = actor({ level: 41 }, "Hina");
  const zarg = actor({ level: 41 }, "Zarg");
  const drake = actor({ level: 45, npc_rank: "elite", species: "MONSTER" }, "Flame Drake");

  setup(hina, null);
  eq("a selected PC is the target", S.advancementTarget()?.name, "Hina");

  // The reported bug: a GM at camp clicks a monster and is told it has unspent
  // Attribute Points.
  setup(drake, null);
  eq("a selected monster is no target", S.advancementTarget(), null);

  // And it must not silently retarget the GM's own character instead — the
  // badge would then be about someone the user did not select.
  setup(drake, zarg);
  eq("a selected monster does not fall through to the own character",
    S.advancementTarget(), null);

  setup(null, zarg);
  eq("no selection falls back to the own character", S.advancementTarget()?.name, "Zarg");

  setup(null, drake);
  eq("an NPC assigned as the own character is still no target",
    S.advancementTarget(), null);

  setup(null, null);
  eq("nothing selected and no character is no target", S.advancementTarget(), null);

  // A GM seat: no assigned character, nothing selected. This is the state the
  // badge is in most of the time and it must stay silent.
  setup(null, undefined);
  eq("a bare GM seat is no target", S.advancementTarget(), null);

  delete globalThis.canvas;
  delete globalThis.game;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
