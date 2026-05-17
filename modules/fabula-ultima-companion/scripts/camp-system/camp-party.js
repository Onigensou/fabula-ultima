// ============================================================================
// Camp System — Party Member Resolver
//
// Reads party_member_1..4 from the DB actor, resolves each to an Actor
// document, and finds the owning player user for each.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  const TAG  = "[CampSystem][Party]";

  CAMP.Party = {
    /**
     * Resolve all active party members from the DB actor.
     * Returns: Array<{ actor: Actor, actorId: string, userId: string|null, userName: string }>
     */
    async resolve() {
      const result = await window.FUCompanion?.api?.getCurrentGameDb?.();
      if (!result?.db) {
        console.warn(TAG, "DB actor not found.");
        return [];
      }
      const db = result.db;
      const props = db.system?.props ?? {};

      const entries = [];

      for (let i = 1; i <= 4; i++) {
        const raw = String(props[`party_member_${i}`] ?? "").trim();
        if (!raw) continue;

        // Resolve actor (plain ID or UUID)
        let actor = null;
        if (/^Actor\./i.test(raw)) {
          actor = await fromUuid(raw).catch(() => null);
        } else {
          actor = game.actors?.get(raw)
               ?? await fromUuid(`Actor.${raw}`).catch(() => null);
        }
        if (!actor) { console.warn(TAG, `party_member_${i} not found:`, raw); continue; }

        // Find owning user (permission level OWNER = 3)
        const userId   = Object.entries(actor.ownership ?? {}).find(([uid, lvl]) => {
          return lvl >= 3 && uid !== "default" && game.users?.get(uid);
        })?.[0] ?? null;
        const user     = userId ? game.users.get(userId) : null;
        const userName = user?.name ?? actor.name;

        entries.push({ actor, actorId: actor.id, userId, userName });
      }

      return entries;
    },

    /**
     * Find the party entry for the current user.
     * Returns { actor, actorId, userId, userName } or null.
     */
    async getMine() {
      const party = await this.resolve();
      return party.find(e => e.userId === game.user?.id) ?? null;
    },

    /**
     * Find the party entry for a given userId.
     */
    async getForUser(userId) {
      const party = await this.resolve();
      return party.find(e => e.userId === userId) ?? null;
    },

    /**
     * Get all active non-GM user IDs that have a party actor.
     */
    async getActiveUserIds() {
      const party  = await this.resolve();
      const active = game.users?.filter(u => u.active && !u.isGM) ?? [];
      return active.filter(u => party.some(e => e.userId === u.id)).map(u => u.id);
    },
  };

  console.debug(TAG, "Party resolver loaded.");
})();
