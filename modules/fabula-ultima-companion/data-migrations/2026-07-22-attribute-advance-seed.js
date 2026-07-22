/**
 * Migration: 2026-07-22-attribute-advance-seed
 * ---------------------------------------------------------------------------
 * Seeds the attribute-advance ledger for characters whose level-20 / level-40
 * die steps were already applied by hand, before the system existed.
 *
 * WHY THIS IS NEEDED AT ALL
 * -------------------------
 * Advances available = milestones reached − milestones claimed. The ledger is
 * new, so `claimed` reads 0 for everyone, while the party is level 41 and has
 * reached both. Without seeding, the Status window would offer all four
 * characters two advances they already took, and a player clicking through
 * would push their attribute total from 36 to 40.
 *
 * The evidence they were already taken is arithmetic, not assumption. The
 * Fabula Ultima starting array (d8/d8/d10/d6) totals 32, and each milestone is
 * one die step (+2). Every party member totals exactly 36:
 *
 *     Zarg     DEX 12  INS  8  MIG  8  WLP  8   = 36
 *     Hina     DEX  6  INS 12  MIG  8  WLP 10   = 36
 *     Keren    DEX  8  INS 12  MIG  6  WLP 10   = 36
 *     Blanche  DEX 12  INS  6  MIG 12  WLP  6   = 36
 *
 * 32 + 2 + 2. All four, no exceptions.
 *
 * WHY A FLAG AND NOT A PROP
 * -------------------------
 * `reloadTemplate` prunes props missing from `getAllProperties()` and persists
 * the deletion. A ledger prop with no template node would therefore be erased
 * by any re-stamp — silently resetting `claimed` to 0 and re-offering the
 * advances this migration exists to prevent. Giving it template nodes would
 * mean splicing a 282kB header onto every actor for two values nobody is meant
 * to read. Flags sit outside CSB's property system: nothing prunes them, and
 * they need no template change.
 *
 * SCOPE
 * -----
 * The db-resolved party only — the characters actually being played. The world
 * carries retired PCs, test dummies and a "Hina (Backup)" at level 30; none of
 * them are in play, and seeding a character nobody opens is churn. Anyone who
 * joins later is handled by the same arithmetic being wrong for them: if their
 * dice have NOT been hand-advanced, they should genuinely receive the advance.
 *
 * The seed is marked `legacy: true` with no per-step entries, because there is
 * no record of WHICH attributes were raised — only that both milestones were.
 * A future refund therefore has nothing to unwind for these characters, which
 * is correct: it must not guess at a die it never wrote.
 *
 * IDEMPOTENT — an actor that already carries the flag is skipped, so a re-run
 * cannot double-seed or overwrite a value a GM has since corrected.
 */

export const key = "2026-07-22-attribute-advance-seed";
export const description =
  "Seed attribute-advance ledger (claimed = milestones reached) for the party, " +
  "whose level 20/40 die steps were already applied by hand.";

const FLAG_SCOPE = "fabula-ultima-companion";
const FLAG_KEY = "attributeAdvance";
const MILESTONES = [20, 40];

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * The characters actually being played, read from the Database actor's
 * `member_id_1..4` — the same resolution the skill-point migration uses, so
 * both systems agree on who "the party" is.
 */
async function resolvePartyActors(game, log) {
  const out = [];
  try {
    const api = globalThis.FUCompanion?.api;
    if (!api?.getCurrentGameDb) {
      log?.("  • db-resolver unavailable — nothing seeded");
      return out;
    }
    const { db, source } = await api.getCurrentGameDb();
    const dbActor = source ?? db;
    if (!dbActor) {
      log?.("  • Database actor not found — nothing seeded");
      return out;
    }
    const props = dbActor.system?.props ?? {};
    for (let i = 1; i <= 4; i++) {
      const raw = String(props[`member_id_${i}`] ?? "").trim();
      if (!raw) continue;
      const id = raw.startsWith("Actor.") ? raw.slice("Actor.".length) : raw;
      const actor = game.actors?.get(id) ?? null;
      if (actor) out.push(actor);
      else log?.(`  • member_id_${i} "${raw}" did not resolve`);
    }
  } catch (e) {
    log?.(`  • party resolution threw: ${e?.message ?? e}`);
  }
  return out;
}

export async function migrate(game, log) {
  const party = await resolvePartyActors(game, log);
  if (!party.length) {
    log?.("no party members resolved — nothing seeded (safe: the window repairs on open)");
    return { seeded: 0, skipped: 0 };
  }

  let seeded = 0, skipped = 0;
  for (const actor of party) {
    if (actor.type !== "character") { skipped++; continue; }

    // Already carries a ledger: either seeded before, or the system has since
    // written a real advance. Either way this must not touch it.
    if (actor.getFlag(FLAG_SCOPE, FLAG_KEY)) {
      log?.(`${actor.name}: ledger present — skipped`);
      skipped++;
      continue;
    }

    const level = num(actor.system?.props?.level, 0);
    const reached = MILESTONES.filter((m) => level >= m).length;
    if (!reached) {
      log?.(`${actor.name}: level ${level}, no milestone reached — nothing to seed`);
      skipped++;
      continue;
    }

    await actor.setFlag(FLAG_SCOPE, FLAG_KEY, {
      claimed: reached,
      log: [],
      legacy: true,
      seededAt: new Date().toISOString(),
      seededLevel: level,
    });
    log?.(`${actor.name}: level ${level} → claimed ${reached} (legacy, applied by hand)`);
    seeded++;
  }

  return { seeded, skipped };
}
