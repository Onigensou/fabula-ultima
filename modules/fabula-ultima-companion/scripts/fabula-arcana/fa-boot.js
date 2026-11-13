// scripts/fabula-arcana/fa-boot.js
// Fabula Arcana — the camp card minigame (three-card monster duels, Best of 1/3/5, NPC ante cards).
// Rules: fa-catalog.js + fa-engine.js (classic scripts, node-tested). This file wires the Foundry side.
//
// API: FUCompanion.api.fabulaArcana
//   .challengeNpc(token, { challenger? })        walk up to a duelist NPC (same as its Card Duel button)
//   .challengePlayer(actor, { bestOf? })         camp challenge to another player's character
//   .practice({ name?, team?, diff?, style?, bestOf?, challenger? })   a duel against a made-up AI challenger (GM / testing)
//   .setDuelist(actor, { teams, diff, style, bestOf, quote, prize, requiresSwitch })   GM: make an NPC challengeable (false = remove)
//   .grantCard(actor, cid) / .grantStarter(actor) / .ownedCards(actor) / .cardItemData(cid)
//   .spectate(sid) / .sessions() / .closeAll()    (GM)
//   .Catalog / .Engine

import { TAG, MODULE_ID, SETTING_SESSIONS, Catalog, Engine, isHostGM, hostGM } from "./fa-const.js";
import { install as installNet, send } from "./fa-net.js";
import { installHost, restore, listSessions, closeAll } from "./fa-host.js";
import { installClient, currentDuel } from "./fa-client.js";
import { installEntry, challengeNpc, challengePlayer, spectate, setDuelist } from "./fa-entry.js";
import { ownedCards, grantCard, grantStarter, cardItemData } from "./fa-collection.js";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_SESSIONS, { scope: "world", config: false, type: Object, default: {} });
});

Hooks.once("ready", () => {
  if (!Engine() || !Catalog()) { console.error(TAG, "rules engine missing (fa-catalog.js / fa-engine.js not loaded)"); return; }
  installNet(); installHost(); installClient(); installEntry();
  if (isHostGM()) restore();
  // ask the host for anything this client was part of (reload during a duel → the window reopens)
  const h = hostGM();
  if (h && h.id !== game.user.id) send(h.id, "hello-client", {});
  else if (h) send(h.id, "hello-client", {});

  const api = {
    challengeNpc, challengePlayer, spectate, setDuelist,
    practice: (opts = {}) => challengeNpc(null, { challenger: opts.challenger ?? null, practice: { name: opts.name ?? "Practice Duelist", team: opts.team, diff: opts.diff, style: opts.style, bestOf: opts.bestOf ?? 1, quote: opts.quote ?? "", prize: opts.prize ?? null } }),
    grantCard, grantStarter, ownedCards, cardItemData,
    sessions: () => listSessions(), closeAll, current: currentDuel,
    Catalog: Catalog(), Engine: Engine(),
  };
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.fabulaArcana = api;
  console.log(TAG, `ready — ${Engine().IDS.length} cards in the pool`);
});
