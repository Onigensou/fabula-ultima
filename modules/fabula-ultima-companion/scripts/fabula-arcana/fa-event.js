// scripts/fabula-arcana/fa-event.js
// Fabula Arcana inside story events (event row "Card Duel", event-system/event-rows-card-duel.js).
//
//   eventDuel({ npcTokenUuid, team, diff, style, bestOf, quote, userId?, challengerActorId? })
//     GM (the duel host): the Main Controller plays the NPC token's actor with this exact team. Works while the
//     game is still locked (fa-const UNLOCK_SWITCH): it is how the story unlocks it. Resolves when the duel window
//     closes: { result: "win" | "loss" | "draw" | "cancel" } (fa-host.js startEventDuel).
//   grantStarterToParty()
//     GM: every party member who can't field a team yet gets the starter gift (three 1-star cards).
//     Running it twice gives nothing twice. Resolves [{ actorId, name, given: [cid] }].

import { TAG, isHostGM, uid } from "./fa-const.js";
import { startEventDuel } from "./fa-host.js";
import { grantStarter, ownedCards, canPlay } from "./fa-collection.js";
import { controller, partyMemberIds } from "./fa-entry.js";

async function partyActors() {
  return [...(await partyMemberIds())].map((id) => game.actors.get(id)).filter((a) => a && a.type !== "database" && a.hasPlayerOwner);
}

/** Who sits down for the party: the Main Controller and their character (else the GM with the first party member). */
async function whoPlays() {
  const ctl = await controller();
  const actor = game.actors.get(ctl?.partyMemberActorId ?? ctl?.linkedActorId ?? "") ?? null;
  const user = ctl?.userId ? game.users.get(ctl.userId) : null;
  if (actor && user?.active) return { userId: user.id, actor };
  const first = actor ?? (await partyActors())[0] ?? null;
  return { userId: game.user.id, actor: first };
}

export async function eventDuel({ npcTokenUuid, npcActorId = null, team = null, diff = "casual", style = null, bestOf = 1, quote = "", userId = null, challengerActorId = null } = {}) {
  if (!game.user?.isGM) throw new Error(`${TAG} eventDuel is GM only.`);
  if (!isHostGM()) { console.warn(TAG, "eventDuel: this GM is not the duel host"); return { result: "cancel", reason: "not-host" }; }
  let who = { userId, actor: challengerActorId ? game.actors.get(challengerActorId) : null };
  if (!who.userId || !who.actor) who = await whoPlays();
  if (!who.actor) { ui.notifications?.warn?.("Card Duel: no party member to play."); return { result: "cancel", reason: "no-player" }; }
  return startEventDuel({ reqId: uid(), userId: who.userId, challengerActorId: who.actor.id, npcTokenUuid, npcActorId, team, diff, style, bestOf, quote });
}

export async function grantStarterToParty() {
  if (!game.user?.isGM) throw new Error(`${TAG} grantStarterToParty is GM only.`);
  const out = [];
  for (const a of await partyActors()) {
    let given = [];
    if (!canPlay(ownedCards(a))) { try { given = await grantStarter(a); } catch (e) { console.error(TAG, "starter gift", a.name, e); } }
    out.push({ actorId: a.id, name: a.name, given });
  }
  return out;
}
