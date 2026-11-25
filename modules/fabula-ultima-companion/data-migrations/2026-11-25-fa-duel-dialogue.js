/**
 * Migration: 2026-11-25-fa-duel-dialogue
 * ---------------------------------------------------------------------------
 * Fabula Arcana duel dialogue (approved review 2026-11-25, phase 1): every NPC
 * duelist gets four more lines next to its challenge quote. Today the only
 * duelist is Willy (Ruhig); the rest of the town arrives with the duelist
 * rollout (phase 5), using the same approved lines.
 *
 *   declineQuote    the party answers "Not now"
 *   npcWinQuote     the NPC won the duel
 *   playerWinQuote  the party won the duel
 *   rematchQuote    the greeting once the party has beaten them (instead of the challenge line)
 *
 * Only empty fields are filled: a line the GM has already written is left as it is.
 * Matched by actor id first, then by name.
 */

export const key = "2026-11-25-fa-duel-dialogue";
export const description = "Fabula Arcana: Willy's duel dialogue (decline, NPC win, player win, rematch lines).";

const MODULE_ID = "fabula-ultima-companion";
const FLAG = "faDuelist";

const LINES = [
  {
    id: "eINRStIK2owD6Qp8", name: "Willy",
    declineQuote: "O-oh. Okay. I'll just… polish my trinkets.",
    npcWinQuote: "I w-won? I actually won! Wait till my collection hears about this!",
    playerWinQuote: "W-well played… the card is yours. Fair and square!",
    rematchQuote: "B-back for more? I studied my deck all night!",
  },
];
const FIELDS = ["declineQuote", "npcWinQuote", "playerWinQuote", "rematchQuote"];

export async function migrate(game, log = () => {}) {
  const out = [];
  for (const L of LINES) {
    const actor = game.actors.get(L.id) ?? game.actors.find((a) => a.name === L.name && a.getFlag(MODULE_ID, FLAG));
    if (!actor) { out.push(`! ${L.name}: actor not found`); continue; }
    const cfg = actor.getFlag(MODULE_ID, FLAG);
    if (!cfg) { out.push(`! ${L.name}: not a duelist (no ${FLAG} flag), left alone`); continue; }
    const patch = {};
    for (const f of FIELDS) if (!String(cfg[f] ?? "").trim()) patch[`flags.${MODULE_ID}.${FLAG}.${f}`] = L[f];
    if (!Object.keys(patch).length) { out.push(`= ${L.name}: lines already set`); continue; }
    await actor.update(patch);
    out.push(`~ ${L.name}: ${Object.keys(patch).length} line(s)`);
  }
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
