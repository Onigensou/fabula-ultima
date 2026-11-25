// scripts/fabula-arcana/fa-feedback.js
// What the table sees OUTSIDE the duel window (approved plan 2026-11-25, phase 1):
//   - "obtained card" lines in the System Message box (FU.SystemMessage, the battle text box) for everyone:
//       NPC prize  "Keren won the Willy card!"        after the duel's exit (fa-client.js plays it)
//       drop       "Hina obtained the Wolf card!"     after a battle's return to the map (fu.battleEnd)
//       starter    "Zarg received a starter set: Wolf, Pyrefly, Sylph."
//     The card name is an item link ({it:uuid|Name}): the card's art as the icon, hover opens the card.
//   - the party's "beaten" record per NPC duelist (party actor flag faBeaten), so a duelist you've
//     beaten greets you with their rematch line instead of the challenge line.

import { TAG, MODULE_ID, Catalog } from "./fa-const.js";

export const FLAG_BEATEN = "faBeaten";
const DROP_LINE_DELAY_MS = 1500;   // after fu.battleEnd: lets every client finish loading the return scene first
const DROP_MAX_AGE_MS = 10 * 60 * 1000;

const clean = (s) => String(s ?? "").replace(/[{}|]/g, "").trim();
const cardTitle = (cid) => clean(Catalog()?.CARDS?.[cid]?.name ?? cid);

/** "{w:Keren} won the {it:Actor.x.Item.y|Willy} card!" (no uuid: the name in the name colour) */
export function cardLine(verb, actorName, cid, uuid = null) {
  const name = cardTitle(cid);
  const card = uuid ? `{it:${uuid}|${name}}` : `{w:${name}}`;
  return `{w:${clean(actorName) || "The party"}} ${verb} the ${card} card!`;
}
export function starterLine(actorName, cids) {
  const list = (cids || []).map((c) => `{w:${cardTitle(c)}}`).join(", ");
  return `{w:${clean(actorName)}} received a starter set: ${list}.`;
}
// A short battle-text line holds ~1.4 s by default; a card you just got stays up long enough to read and hover.
const CARD_LINE_HOLD_MS = 3500;
/** Every client, this one included. */
export function say(lines) {
  const list = (Array.isArray(lines) ? lines : [lines]).filter(Boolean).map((l) => (typeof l === "string" ? { text: l, hold: CARD_LINE_HOLD_MS } : l));
  if (!list.length) return;
  try { globalThis.FU?.SystemMessage?.broadcast?.(list); } catch (e) { console.warn(TAG, "system message", e); }
}

// ------------------------------------------------------------------ beaten record (party, so it follows the save)
// key = the duelist's actor id, or for a setup that lives on one token (townsfolk sharing an actor) the token's uuid
// with the dots swapped out (a dot would split the flag path).
export const npcKeyOf = ({ actorId = null, tokenUuid = null, perToken = false } = {}) =>
  perToken && tokenUuid ? `tok_${String(tokenUuid).replace(/\./g, "_")}` : (actorId || null);

// The duelist's prize order (2026-11-25): the first card in `prizes` the challenger doesn't own yet; none left = a friendly
// match. Old setups with a single `prize` read as a one-card list.
export function prizeList(cfg) {
  const C = Catalog()?.CARDS ?? {};
  const list = Array.isArray(cfg?.prizes) && cfg.prizes.length ? cfg.prizes : cfg?.prize ? [cfg.prize] : [];
  return list.map(String).filter((c, i, a) => C[c] && a.indexOf(c) === i);
}
export const nextPrize = (cfg, owned = []) => prizeList(cfg).find((c) => !owned.includes(c)) ?? null;
const partyActor = () => { try { return window.oni?.GameState?.partyActor?.() ?? null; } catch { return null; } };
export function hasBeaten(key) {
  if (!key) return false;
  return !!partyActor()?.getFlag?.(MODULE_ID, FLAG_BEATEN)?.[key];
}
export async function markBeaten(key) {
  if (!key || !game.user?.isGM || hasBeaten(key)) return;
  const a = partyActor(); if (!a) return;
  try { await a.update({ [`flags.${MODULE_ID}.${FLAG_BEATEN}.${key}`]: Date.now() }); }
  catch (e) { console.warn(TAG, "beaten record", e); }
}

// ------------------------------------------------------------------ battle drops → lines after the return to the map
// rollCardDrops (fa-drops.js, on the client running the battle end) hands its result here; the Victory screen
// still shows the cards on its Drops page, this adds the line everyone sees once the map is back.
let lastDrops = null;
export function noteDrops(list) { lastDrops = Array.isArray(list) && list.length ? { at: Date.now(), list } : null; }

let installed = false;
export function installFeedback() {
  if (installed) return; installed = true;
  Hooks.on("fu.battleEnd", (info) => {
    const d = lastDrops; lastDrops = null;
    if (!d || info?.outcome !== "victory" || Date.now() - d.at > DROP_MAX_AGE_MS) return;
    const lines = d.list.map((x) => cardLine("obtained", game.actors.get(x.actorId)?.name ?? "", x.cid, x.uuid ?? null));
    setTimeout(() => say(lines), DROP_LINE_DELAY_MS);
  });
}
