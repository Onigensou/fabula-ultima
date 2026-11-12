/**
 * Migration: 2026-11-12-polymorph-potion-wording  (Polymorph, potions)
 * ---------------------------------------------------------------------------
 * Every "Polymorph Potion: <Monster>" says how long the form lasts. The
 * duration line only, in the user's exact words (2026-11-12):
 *
 *   before:  Transform into the <strong>Inferex </strong>until the end of the scene
 *   after:   Transform into the <strong>Inferex</strong>. Lasts until the end of
 *            the scene or your next 3 turns during a conflict.
 *
 * Only the "until the end of (the) scene" phrase is rewritten (plus the stray
 * space inside the bold name it leaves dangling). Nothing else in the text moves.
 *
 * EVERY COPY (item text convention): world Items, items on every world actor
 * (PCs, the party stash, shops), and items on unlinked scene tokens.
 *
 * IDEMPOTENT: a description that already carries the new sentence is skipped.
 */

export const key = "2026-11-12-polymorph-potion-wording";
export const description =
  "Polymorph Potions: duration line → \"Lasts until the end of the scene or your next 3 turns during a conflict.\" " +
  "on every copy (world, actors, unlinked tokens).";

const NEW_SENTENCE = "Lasts until the end of the scene or your next 3 turns during a conflict.";
const NAME_RE = /^\s*polymorph\s+potion\s*:/i;
// "<strong>X </strong>until the end of the scene" (strong optional, "the" optional)
const OLD_RE = /(<strong>)?([^<]*?)\s*(<\/strong>)?\s*until the end of (the )?scene\.?/i;

export function rewrite(html) {
  const s = String(html ?? "");
  if (!s || s.includes("your next 3 turns during a conflict")) return null;
  if (!OLD_RE.test(s)) return null;
  return s.replace(OLD_RE, (_m, open, name, close) =>
    `${open ?? ""}${String(name ?? "").replace(/\s+$/, "")}${close ?? ""}. ${NEW_SENTENCE}`);
}

async function fixItems(items, where, log) {
  let n = 0;
  for (const it of items ?? []) {
    if (!NAME_RE.test(String(it?.name ?? ""))) continue;
    const next = rewrite(it.system?.props?.description);
    if (next == null) continue;
    try {
      await it.update({ "system.props.description": next });
      n += 1;
    } catch (e) { log(`  ${where}: ${it.name} failed — ${e?.message ?? e}`); }
  }
  return n;
}

export async function migrate(game, log) {
  let total = 0;
  total += await fixItems(game.items?.contents ?? [], "world", log);
  for (const a of game.actors?.contents ?? []) total += await fixItems(a.items?.contents ?? [], a.name, log);
  for (const sc of game.scenes?.contents ?? []) {
    for (const t of sc.tokens?.contents ?? []) {
      if (t.actorLink || !t.actor) continue;
      total += await fixItems(t.actor.items?.contents ?? [], `${sc.name}/${t.name}`, log);
    }
  }
  return { applied: true, summary: `Polymorph Potion wording — ${total} description(s) updated` };
}
