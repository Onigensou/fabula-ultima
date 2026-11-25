// scripts/fabula-arcana/fa-boot.js
// Fabula Arcana — the camp card minigame (three-card monster duels, Best of 1/3/5, NPC ante cards).
// Rules: fa-catalog.js + fa-engine.js (classic scripts, node-tested). This file wires the Foundry side.
//
// API: FUCompanion.api.fabulaArcana
//   .challengeNpc(token, { challenger? })        walk up to a duelist NPC (same as its Card Duel button)
//   .challengePlayer(actor, { bestOf?, format? })   camp challenge to another player's character (format = match rules, Engine.Format)
//   .openChallenge(actor)                          the challenger's setup panel (rules + Best of), then challengePlayer
//   .practice({ name?, team?, diff?, style?, bestOf?, challenger? })   a duel against a made-up AI challenger (GM / testing)
//   .setDuelist(actor, { teams, diff, style, bestOf, quote, prize, requiresSwitch })   GM: make an NPC challengeable (false = remove)
//   .grantCard(actor, cid) / .grantStarter(actor) / .ownedCards(actor) / .cardItemData(cid)
//   .spectate(sid) / .sessions() / .closeAll()    (GM)
//   .eventDuel({ npcTokenUuid, challengerActorId, userId, team, diff, style, bestOf, quote })   GM: an event's duel
//        (event row "Card Duel"); resolves { result: "win" | "loss" | "draw" | "cancel" } when the window closes
//   .grantStarterToParty()                         GM: top every party member up to a playable starter set
//   tutorial "fabula-arcana" (System Tutorial, FUCompanion.api.systemTutorial)
//   .cardForEnemy(actor) / .setCardDrop(actor, cid | false | null) / .rollCardDrops(enemies, recipients)   monster card drops (fa-drops.js)
//   .Catalog / .Engine

import { TAG, MODULE_ID, SETTING_SESSIONS, Catalog, Engine, isHostGM, hostGM, ASSET_BASE } from "./fa-const.js";
import { install as installNet, send } from "./fa-net.js";
import { installHost, restore, listSessions, closeAll, cancelEventDuels } from "./fa-host.js";
import { eventDuel, grantStarterToParty } from "./fa-event.js";
import { registerTutorial } from "../system-tutorial/system-tutorial.js";
import { installClient, currentDuel } from "./fa-client.js";
import { installEntry, challengeNpc, challengePlayer, openChallenge, spectate, setDuelist } from "./fa-entry.js";
import { ownedCards, grantCard, grantStarter, cardItemData } from "./fa-collection.js";
import { cardForEnemy, rollCardDrops, FLAG_DROP } from "./fa-drops.js";
import { installFeedback } from "./fa-feedback.js";

// The rules, one idea per page (Willy's First Duel opens it; any event can, with Show Tutorial).
const shot = (n) => `${ASSET_BASE}tutorial/fa-tutorial-${n}.webp`;
registerTutorial("fabula-arcana", {
  kicker: "System tutorial", title: "Fabula Arcana", accent: "#7a3a8a", aspect: "4 / 3",
  pages: [
    { image: shot(1), text: "Choose three monster cards for your team without exceeding the star limit." },
    { image: shot(2), text: "Each round, both players secretly choose an action before revealing them simultaneously." },
    { image: shot(3), text: "When both monsters attack, the one with higher SPD strikes first." },
    { image: shot(4), text: "Attacks deal 2 extra damage against a weakness and 2 less damage against a resistance." },
    { image: shot(5), text: "Use items for special effects or switch monsters to gain an advantage." },
    { image: shot(6), text: "Knock out all three enemy monsters to win the duel!" },
  ],
});

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_SESSIONS, { scope: "world", config: false, type: Object, default: {} });
});

Hooks.once("ready", () => {
  if (!Engine() || !Catalog()) { console.error(TAG, "rules engine missing (fa-catalog.js / fa-engine.js not loaded)"); return; }
  installNet(); installHost(); installClient(); installEntry(); installFeedback();
  if (isHostGM()) restore();
  // ask the host for anything this client was part of (reload during a duel → the window reopens)
  const h = hostGM();
  if (h && h.id !== game.user.id) send(h.id, "hello-client", {});
  else if (h) send(h.id, "hello-client", {});

  const api = {
    challengeNpc, challengePlayer, openChallenge, spectate, setDuelist,
    practice: (opts = {}) => challengeNpc(null, { challenger: opts.challenger ?? null, practice: { name: opts.name ?? "Practice Duelist", team: opts.team, diff: opts.diff, style: opts.style, bestOf: opts.bestOf ?? 1, quote: opts.quote ?? "", prize: opts.prize ?? null } }),
    grantCard, grantStarter, ownedCards, cardItemData,
    // card drops: which card a monster drops; GM override per actor (a card id, or false for none; null clears)
    cardForEnemy, rollCardDrops,
    setCardDrop: (actor, cid) => (cid === null || cid === undefined)
      ? actor?.unsetFlag(MODULE_ID, FLAG_DROP)
      : actor?.setFlag(MODULE_ID, FLAG_DROP, cid === false ? false : String(cid)),
    sessions: () => listSessions(), closeAll, current: currentDuel,
    eventDuel, grantStarterToParty, cancelEventDuels,
    Catalog: Catalog(), Engine: Engine(),
  };
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.fabulaArcana = api;
  console.log(TAG, `ready — ${Engine().IDS.length} cards in the pool`);
});
