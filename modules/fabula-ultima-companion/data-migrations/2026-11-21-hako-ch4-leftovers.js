/**
 * Migration: 2026-11-21-hako-ch4-leftovers  (follow-ups to the Hako Ch4 batch, v1.0.650)
 * ---------------------------------------------------------------------------
 *   1. Muramasa's self-Doom: uncleansable only WHILE Muramasa is equipped.
 *      The Doom template on Muramasa (Passive) gets
 *      `flags.fabula-ultima-companion.equipLock = "Muramasa"`; the engine hook
 *      scripts/battle-director/equip-lock-release.js clears `uncleansable` +
 *      `directorPermanent` (and the lock) once the bearer no longer has a
 *      Muramasa equipped, so the Doom stays but is a normal, cleansable Doom.
 *      Already-applied Muramasa Dooms on actors get the same lock (and are
 *      released here if their bearer has no Muramasa equipped).
 *   2. Break Free (Objective): the card shows the DL the engine checks. The
 *      "DL 10 (or the escape DL of whoever holds you)" text becomes a live
 *      value, <span data-fu-formula="GRAPPLE_ESCAPE_DL">10</span> (live-text.js):
 *      13 while a Luchador Pant wearer holds you, 10 otherwise. The check row
 *      already reads GRAPPLE_ESCAPE_DL (2026-11-21-luchador-author).
 *
 * SEED-ONLY: every edit is gated by `flags.fabula-ultima-companion.hakoLeftovers`
 * on the document it touches (or by the text no longer matching), so a re-run
 * never re-applies and hand edits made afterwards are kept.
 */

export const key = "2026-11-21-hako-ch4-leftovers";
export const description = "Hako Ch4 leftovers: Muramasa's Doom becomes cleansable once Muramasa is unequipped; Break Free shows the real escape DL.";

const M = "fabula-ultima-companion";
const FLAG = "hakoLeftovers";
const MURAMASA = "Muramasa";
const MURA_PSV = "HkC4MuramasaPsv1";
const MURA_DOOM = "HkC4MuraDoomAE01";
const BREAK_FREE = "MV3cvmYEtB1N6TmA";
const OLD_DL = "<strong>DL 10</strong> (or the escape DL of whoever holds you)";
const LIVE_DL = "<strong>DL <span data-fu-formula=\"GRAPPLE_ESCAPE_DL\">10</span></strong>";

const wields = (actor) => actor.items.some((i) => !i.system?.container && i.name === MURAMASA && i.system?.props?.isEquipped === true);

// Every actor that can carry an applied effect: world actors + unlinked tokens.
function allActors() {
  const out = [...game.actors];
  for (const s of game.scenes) for (const t of s.tokens) if (!t.actorLink && t.actor) out.push(t.actor);
  return out;
}

async function muramasaLock(out) {
  // The template (world item) and every copy of the passive on actors (shop stock, owners).
  const passives = [game.items.get(MURA_PSV), ...game.actors.contents.flatMap((a) => a.items.filter((i) => i.name === "Muramasa (Passive)"))].filter(Boolean);
  let tpl = 0;
  for (const p of passives) {
    const ae = p.effects.get(MURA_DOOM) ?? p.effects.find((e) => e.getFlag(M, "muramasaDoom"));
    if (!ae || ae.getFlag(M, FLAG)) continue;
    await ae.update({ [`flags.${M}.equipLock`]: MURAMASA, [`flags.${M}.${FLAG}`]: true });
    tpl++;
  }
  out.push(`~ Muramasa Doom template: equip-locked (${tpl} doc${tpl === 1 ? "" : "s"})`);

  // Dooms already applied by Muramasa.
  let locked = 0, released = 0;
  for (const actor of allActors()) {
    const dooms = actor.effects.filter((e) => e.getFlag(M, "muramasaDoom") && !e.getFlag(M, FLAG));
    if (!dooms.length) continue;
    const held = wields(actor);
    await actor.updateEmbeddedDocuments("ActiveEffect", dooms.map((e) => held
      ? { _id: e.id, [`flags.${M}.equipLock`]: MURAMASA, [`flags.${M}.${FLAG}`]: true }
      : { _id: e.id, [`flags.${M}.uncleansable`]: false, [`flags.${M}.directorPermanent`]: false, [`flags.${M}.${FLAG}`]: true }));
    if (held) locked += dooms.length; else released += dooms.length;
  }
  out.push(`~ applied Muramasa Dooms: ${locked} locked to the equipped blade, ${released} released (no Muramasa equipped)`);
}

async function breakFreeDl(out) {
  const docs = [game.items.get(BREAK_FREE), ...game.actors.contents.flatMap((a) => a.items.filter((i) => i.getFlag(M, "coreAction") === "objective:break_free"))].filter(Boolean);
  let n = 0;
  for (const d of docs) {
    if (d.getFlag(M, FLAG)) continue;
    const desc = String(d.system?.props?.description ?? "");
    if (!desc.includes(OLD_DL)) continue;
    await d.update({ "system.props.description": desc.replace(OLD_DL, LIVE_DL), [`flags.${M}.${FLAG}`]: true });
    n++;
  }
  out.push(n ? `~ Break Free: DL shown live (${n} doc${n === 1 ? "" : "s"})` : "= Break Free text already live (or hand-edited)");
}


// Hako's sheet lists (normal_spell_list etc.) are CSB mirrors of her embedded
// items. The v1.0.650 restock removed her old stock, incl. Budding Maple Wand,
// whose contained Heal had been mirrored into normal_spell_list, so that row
// now points at a deleted item (preflight broken-ref warning). Drop every list
// row whose key is no longer an embedded item. Hako only; idempotent.
const HAKO = "srAH3OHOoK0tvFih";
async function pruneHakoLists(out) {
  const hako = game.actors.get(HAKO);
  if (!hako) { out.push("! Hako missing"); return; }
  const props = hako.system?.props ?? {};
  const upd = {}; let n = 0;
  for (const [k, v] of Object.entries(props)) {
    if (!/_list$/.test(k) || !v || typeof v !== "object") continue;
    for (const id of Object.keys(v)) {
      if (/^[A-Za-z0-9]{16}$/.test(id) && !hako.items.get(id)) { upd[`system.props.${k}.-=${id}`] = null; n++; }
    }
  }
  if (!n) { out.push("= Hako lists clean"); return; }
  await hako.update(upd);
  out.push(`~ Hako: dropped ${n} stale list row(s)`);
}

export async function migrate(game, log = () => {}) {
  const out = [];
  await muramasaLock(out);
  await breakFreeDl(out);
  await pruneHakoLists(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
