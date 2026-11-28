/**
 * Migration: 2026-11-28-deva-form-lines  (user, playtest 2026-11-28: "I want the quote when she enters the form")
 * ---------------------------------------------------------------------------
 * The Fury / Focus lines (2026-11-28-deva-tuning) rode Ground Slam / Rahu's Eclipse, so she only spoke on her first
 * cast of those moves, not as she entered the form. They now ride the form effects themselves: Celestial Discipline's
 * "Strike Form" (Fury) and "Magic Form" (Focus) templates carry flags.bossLine, and boss-line.js plays a line from an
 * effect the battle applies (initBossLineEffects). Same text, same switches (once per playthrough).
 * Enlightenment keeps its line on the Enlightenment cast; its own Strike / Magic Form copies carry no line.
 * Every copy (world actors, unlinked tokens). Idempotent.
 */
export const key = "2026-11-28-deva-form-lines";
export const description = "Deva's Fury / Focus lines play as she enters the form (on the form effects), not on Ground Slam / Rahu's Eclipse.";

const M = "fabula-ultima-companion";
const DEVA = "amxILxU7mqQ0jKhZ";
const FORM_LINES = {
  "Strike Form": { text: "Steel, and more steel. ...Then let me show you how it's swung.", switch: "Deva Fury Line", speaker: "Deva", hold: 2600 },
  "Magic Form": { text: "So fond of your little spells. Let's see you cast them empty.", switch: "Deva Focus Line", speaker: "Deva", hold: 2600 },
};
const OLD_CARRIERS = ["Ground Slam", "Rahu's Eclipse"];

function actorsNamed(re, id) {
  const out = []; for (const a of game.actors) if (a.id === id || re.test(a.name ?? "")) out.push(a);
  for (const s of game.scenes) for (const t of s.tokens) if (!t.actorLink && t.actor && re.test(t.actor.name ?? "")) out.push(t.actor);
  return out;
}

export async function migrate(game, log = () => {}) {
  const out = [];
  for (const a of actorsNamed(/^deva$/i, DEVA)) {
    const who = `${a.name}${a.isToken ? " (token)" : ""}`;
    for (const it of a.items) {
      if (OLD_CARRIERS.includes(it.name) && it.getFlag(M, "bossLine")) { await it.update({ [`flags.${M}.-=bossLine`]: null }); out.push(`- ${who} / ${it.name}: line moved off`); }
      if (it.name !== "Celestial Discipline") continue;
      for (const e of it.effects) {
        const line = FORM_LINES[e.name]; if (!line) continue;
        if (JSON.stringify(e.getFlag(M, "bossLine")) === JSON.stringify(line)) continue;
        await e.update({ [`flags.${M}.bossLine`]: line }); out.push(`~ ${who} / Celestial Discipline / ${e.name}: form line`);
      }
    }
  }
  if (!out.length) out.push("= Deva form lines already on the form effects (or no Deva in the world)");
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
