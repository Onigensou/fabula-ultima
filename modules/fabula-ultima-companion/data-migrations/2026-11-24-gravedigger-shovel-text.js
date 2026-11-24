/**
 * Migration: 2026-11-24-gravedigger-shovel-text
 * ---------------------------------------------------------------------------
 * The Gravedigger Shovel's curse applies WHILE EQUIPPED (user ruling
 * 2026-11-24; its "Cursed" AE is equip-linked), but the text said "You are
 * always Curse". Only that line changes, on the world item, its (Passive) child
 * and every actor copy (refine prefix ignored). Other bullets are left as
 * written.
 *
 * Exact-substring replace: a copy whose text no longer holds the old line is
 * reported and left alone, so a re-run, or later hand edits, are never touched.
 */

export const key = "2026-11-24-gravedigger-shovel-text";
export const description = "Gravedigger Shovel: curse line now reads 'While equipped, you gain Curse.' (world item, Passive child, every actor copy).";

const BASE = "Gravedigger Shovel";
const PASSIVE = "Gravedigger Shovel (Passive)";
const CURSE_LINK = `<a class="content-link" data-uuid="JournalEntry.V8mKI3BdXusfSBLq" data-id="V8mKI3BdXusfSBLq" data-type="JournalEntry">Curse</a>`;

const EDITS = {
  [BASE]: {
    from: `<p>You are always ${CURSE_LINK}</p>`,
    to: `<p>While equipped, you gain ${CURSE_LINK}.</p>`,
  },
  [PASSIVE]: {
    from: `You are always Cursed.`,
    to: `While equipped, you gain Curse.`,
  },
};

const baseOf = (n) => String(n ?? "").replace(/^\+\d+\s+/, "").trim();
const label = (doc) => `${doc.parent?.name ? doc.parent.name + ": " : ""}${doc.name}`;

async function fix(doc, out) {
  const edit = EDITS[baseOf(doc.name)];
  if (!edit) return;
  const patch = {};
  for (const field of ["description", "skill_description"]) {
    const v = doc.system?.props?.[field];
    if (typeof v === "string" && v.includes(edit.from)) patch[`system.props.${field}`] = v.replace(edit.from, edit.to);
  }
  if (!Object.keys(patch).length) {
    const done = String(doc.system?.props?.description ?? "").includes(edit.to);
    out.push(`${done ? "=" : "!"} ${label(doc)} ${done ? "already updated" : "old line not found, left alone"}`);
    return;
  }
  await doc.update(patch);
  out.push(`~ ${label(doc)}`);
}

export async function migrate(game, log = () => {}) {
  const out = [];
  for (const it of game.items) await fix(it, out);
  for (const a of game.actors) {
    for (const it of a.items) {
      try { await fix(it, out); } catch (e) { out.push(`! ${label(it)}: ${e?.message ?? e}`); }
    }
  }
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") || "no Gravedigger Shovel found" };
}
