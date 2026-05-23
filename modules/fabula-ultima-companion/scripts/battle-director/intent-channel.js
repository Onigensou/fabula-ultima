// IntentChannel — GM ↔ player socket envelope.
// Adopts the JRPGTargeting envelope shape per design doc §6.1.
//
// v1 scope: minimal. The GM client drives all UI (Turn UI, target picker,
// action card) and the director only runs on the GM. This channel is
// scaffolding for the eventual player-side menus, but in v1 it really only:
//
//   - lets non-GM macros call FUCompanion.api.experimental.battleDirector.start
//     (request bounces to the GM, GM starts director, response back).
//   - broadcasts "menu open / close" events that the legacy turn-ui-manager
//     respects (so players see *something* even if they can't interact).
//
// All payloads use namespace "battle-director".

import { log, warn } from "./logger.js";

const NS = "battle-director";
const CHANNEL = "module.fabula-ultima-companion";

export class IntentChannel {
  constructor({ director }) {
    this.director = director;
    this._installed = false;
    this._socketHandler = null;
  }

  install() {
    if (this._installed) return;
    if (!game.socket) {
      warn("IntentChannel.install: game.socket unavailable");
      return;
    }
    this._socketHandler = (data) => this._onSocket(data);
    game.socket.on(CHANNEL, this._socketHandler);
    this._installed = true;
    log("IntentChannel installed");
  }

  uninstall() {
    if (!this._installed) return;
    try { game.socket.off(CHANNEL, this._socketHandler); } catch (e) { warn("IntentChannel.uninstall failed", e); }
    this._installed = false;
    this._socketHandler = null;
    log("IntentChannel uninstalled");
  }

  // GM-side: receive an intent from a player client and dispatch into the
  // director (if it's for this combat).
  _onSocket(data) {
    if (!game.user?.isGM) return;
    if (!data || data.ns !== NS) return;
    if (data.event !== "INTENT") return;
    const payload = data.payload ?? {};
    if (payload.combatId !== this.director?.combatId) return;
    if (!payload.fromUserId || !payload.type) {
      warn("malformed intent from socket", data);
      return;
    }
    // Ownership check: caller must own the actor named in the intent body,
    // or be the GM. v1 is GM-only so this is mostly a no-op gate.
    const user = game.users?.get(payload.fromUserId);
    if (!user) {
      warn("unknown fromUserId on intent", payload.fromUserId);
      return;
    }
    log("intent over socket:", payload.type, "from", user.name);
    this.director.dispatch({ type: payload.type, body: payload.body });
  }

  // Player-side: emit an intent to the GM. (Stubbed for v1 — the GM drives
  // all UI today so this is rarely invoked.)
  emit(intent) {
    if (!game.socket) {
      warn("IntentChannel.emit: no socket");
      return;
    }
    const env = {
      ns: NS,
      event: "INTENT",
      payload: {
        requestId: foundry.utils?.randomID?.() ?? `bd-${Date.now()}`,
        combatId: this.director?.combatId ?? null,
        fromUserId: game.user?.id ?? null,
        type: intent.type,
        body: intent.body ?? null,
      },
      senderUserId: game.user?.id ?? null,
      timestamp: Date.now(),
    };
    game.socket.emit(CHANNEL, env);
  }

  // GM-side broadcast: open a menu on a specific user's client. v1 unused;
  // scaffolding for the eventual player-side reaction menus.
  broadcastMenuOpen({ targetUserId, menuSpec }) {
    if (!game.user?.isGM) return;
    const env = {
      ns: NS,
      event: "MENU_OPEN",
      payload: {
        requestId: foundry.utils?.randomID?.() ?? `bd-${Date.now()}`,
        targetUserId,
        menuSpec,
      },
      senderUserId: game.user?.id ?? null,
      timestamp: Date.now(),
    };
    game.socket.emit(CHANNEL, env);
  }
}
