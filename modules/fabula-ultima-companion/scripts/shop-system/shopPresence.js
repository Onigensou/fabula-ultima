// scripts/shop-system/shopPresence.js
//
// Ephemeral "who's browsing what" roster for open shop windows.
//
// Nothing here is persisted and nothing here writes a document, so — unlike the
// buy/sell handlers — this needs NO primary-GM gate: every client just renders
// the same roster. Two GMs both spectating correctly both show up in it.
//
// game.socket does not echo to the sender, so every local change is applied
// locally AND broadcast. Same shape as the camp system's HOVER_ACTIVITY.
//
// Routed in via ShopOpenBackend._onSocket (the module's single socket listener).

import { SHOPOPEN } from "./shopopen-const.js";

const DEFAULT_COLOR = "#8a6030";

export class ShopPresence {
  constructor() {
    // shopUuid -> Map(userId -> { userId, itemUuid, tab })
    this._roster = new Map();
    // shopUuid -> Set(callback)
    this._subs = new Map();

    this._onUserConnected = this._onUserConnected.bind(this);
    Hooks.on("userConnected", this._onUserConnected);
  }

  // ──────────────────────────────────────────────────────────────
  // Local user actions (apply locally + broadcast)
  // ──────────────────────────────────────────────────────────────

  enter(shopUuid) {
    this._set(shopUuid, game.user.id, { itemUuid: null, tab: null });
    this._emit(SHOPOPEN.MSG.PRESENCE_ENTER, { shopUuid, userId: game.user.id, itemUuid: null, tab: null });
    this._notify(shopUuid);
  }

  leave(shopUuid) {
    this._roster.get(shopUuid)?.delete(game.user.id);
    this._emit(SHOPOPEN.MSG.PRESENCE_LEAVE, { shopUuid, userId: game.user.id });
    this._notify(shopUuid);
  }

  /** Broadcast which item this user is looking at. No-ops if unchanged. */
  select(shopUuid, itemUuid, tab) {
    const mine = this._roster.get(shopUuid)?.get(game.user.id);
    if (mine && mine.itemUuid === itemUuid) return;

    this._set(shopUuid, game.user.id, { itemUuid, tab });
    this._emit(SHOPOPEN.MSG.PRESENCE_SELECT, { shopUuid, userId: game.user.id, itemUuid, tab });
    this._notify(shopUuid);
  }

  // ──────────────────────────────────────────────────────────────
  // Read
  // ──────────────────────────────────────────────────────────────

  /**
   * Viewers of a shop, resolved against the live User documents (name, colour and
   * linked character all replicate to every client, so nothing needs shipping in
   * the payload). Entries for users who have gone offline are dropped here, which
   * covers the client that reloaded without ever sending a LEAVE.
   */
  viewers(shopUuid, { excludeSelf = false } = {}) {
    const per = this._roster.get(shopUuid);
    if (!per) return [];

    const out = [];
    for (const [userId, entry] of per.entries()) {
      const user = game.users?.get(userId);
      if (!user?.active) { per.delete(userId); continue; }
      if (excludeSelf && userId === game.user.id) continue;

      out.push({
        userId,
        itemUuid: entry.itemUuid ?? null,
        tab:      entry.tab ?? null,
        isGM:     !!user.isGM,
        isSelf:   userId === game.user.id,
        color:    String(user.color ?? DEFAULT_COLOR),
        // The linked character is the name the table actually uses for each other.
        label:    user.character?.name ?? user.name ?? "?",
      });
    }
    return out;
  }

  subscribe(shopUuid, cb) {
    const set = this._subs.get(shopUuid) ?? new Set();
    set.add(cb);
    this._subs.set(shopUuid, set);
    return () => this.unsubscribe(shopUuid, cb);
  }

  unsubscribe(shopUuid, cb) {
    const set = this._subs.get(shopUuid);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) this._subs.delete(shopUuid);
  }

  // ──────────────────────────────────────────────────────────────
  // Socket (called by ShopOpenBackend._onSocket)
  // ──────────────────────────────────────────────────────────────

  onSocket(type, payload = {}) {
    const { shopUuid, userId } = payload;
    if (!shopUuid || !userId || userId === game.user.id) return;

    switch (type) {
      case SHOPOPEN.MSG.PRESENCE_ENTER: {
        this._set(shopUuid, userId, { itemUuid: payload.itemUuid ?? null, tab: payload.tab ?? null });

        // Handshake: someone just walked in, so everyone already in this shop
        // re-announces themselves — otherwise the late joiner sees an empty room.
        // `reply` stops the re-announce from triggering another round of replies.
        if (!payload.reply && this._roster.get(shopUuid)?.has(game.user.id)) {
          const mine = this._roster.get(shopUuid).get(game.user.id);
          this._emit(SHOPOPEN.MSG.PRESENCE_ENTER, {
            shopUuid, userId: game.user.id,
            itemUuid: mine.itemUuid ?? null, tab: mine.tab ?? null,
            reply: true,
          });
        }
        break;
      }

      case SHOPOPEN.MSG.PRESENCE_SELECT:
        // Ignore a selection from someone we never saw enter — an ENTER we missed
        // would otherwise leave them invisible; register them instead.
        this._set(shopUuid, userId, { itemUuid: payload.itemUuid ?? null, tab: payload.tab ?? null });
        break;

      case SHOPOPEN.MSG.PRESENCE_LEAVE:
        this._roster.get(shopUuid)?.delete(userId);
        break;

      default:
        return;
    }

    this._notify(shopUuid);
  }

  // ──────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────

  _set(shopUuid, userId, entry) {
    const per = this._roster.get(shopUuid) ?? new Map();
    per.set(userId, { userId, ...entry });
    this._roster.set(shopUuid, per);
  }

  _emit(type, payload) {
    for (const ch of SHOPOPEN.CHANNELS) {
      try { game.socket.emit(ch, { type, payload }); } catch {}
    }
  }

  _notify(shopUuid) {
    const subs = this._subs.get(shopUuid);
    if (!subs) return;
    for (const cb of subs) {
      try { cb(); } catch (e) { console.error("[ShopPresence] subscriber error:", e); }
    }
  }

  // A disconnect (including an F5) never sends LEAVE — clean up after them.
  _onUserConnected(user, connected) {
    if (connected || !user?.id) return;
    for (const [shopUuid, per] of this._roster.entries()) {
      if (per.delete(user.id)) this._notify(shopUuid);
    }
  }
}
