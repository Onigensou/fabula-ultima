// ============================================================================
// Shared — Spectator / participant roles
//
// A connected user is one of:
//   "gm"          — any GM client.
//   "participant" — a player whose LINKED character (User → Character) is one
//                   of the current party members (Database actor member_id_1..4).
//   "spectator"   — every other user: stream windows, alts, players whose
//                   character is not in this campaign's party.
//
// The role is DERIVED from the party every time, never stored on the account,
// so the same user can be a spectator in one campaign and a player in the next
// just by linking them to a party character. The only stored state is the
// optional world setting "Always-spectator users" — a safety net for the stream
// window so it can never be pulled into a party by accident.
//
// Rule of thumb for callers:
//   - PARTICIPATION (who may act, who gates "all ready") → participants only.
//   - VISIBILITY (who watches) → everyone; never hide broadcasts from spectators.
//
// `deciderUserIdForActor` is THE answer to "which player client decides for
// this actor" (Confirm buttons, reactions, pickers). Ownership alone is not
// enough: `default: OWNER` on an actor would make every user — spectators
// included — an owner, and the old "first owner by id" rule elected whichever
// user id sorted first.
// ============================================================================
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const SETTING   = "alwaysSpectatorUsers";
  const TAG       = "[Shared][Spectator]";
  const OWNER     = 3;

  globalThis.FUCompanion     = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};

  // Set<actorId> of the current party, or null until the first resolve.
  let _partyIds = null;

  const _stripActor = (raw) => String(raw ?? "").trim().replace(/^Actor\./i, "");

  function _user(userOrId) {
    if (userOrId == null) return game.user ?? null;
    if (typeof userOrId === "string") return game.users?.get(userOrId) ?? null;
    return userOrId;
  }

  function _forcedIds() {
    let raw = "";
    try { raw = game.settings.get(MODULE_ID, SETTING) ?? ""; } catch { return new Set(); }
    const out = new Set();
    for (const tok of String(raw).split(/[,\n]/).map(s => s.trim()).filter(Boolean)) {
      const u = game.users?.get(tok) ?? game.users?.getName?.(tok);
      if (u) out.add(u.id);
    }
    return out;
  }

  function role(userOrId) {
    const u = _user(userOrId);
    if (!u) return "spectator";
    if (u.isGM) return "gm";
    if (_forcedIds().has(u.id)) return "spectator";
    const charId = u.character?.id ?? null;
    if (!charId) return "spectator";
    // Party not resolved yet (early boot): any linked player counts.
    if (!_partyIds) return "participant";
    return _partyIds.has(charId) ? "participant" : "spectator";
  }

  const isSpectator   = (u) => role(u) === "spectator";
  const isParticipant = (u) => role(u) === "participant";

  function participantUsers({ requireActive = true } = {}) {
    return (game.users?.contents ?? []).filter(u =>
      (!requireActive || u.active) && role(u) === "participant");
  }

  // Which player client decides for `actor`. Returns a userId, or null when no
  // participant qualifies (callers then fall back to the GM, as before).
  //   1. the participant whose linked character IS this actor;
  //   2. else a participant with EXPLICIT owner permission on it;
  //   3. else a participant who is owner through any route (default level).
  // Ties break by user id so every client computes the same answer.
  function deciderUserIdForActor(actor, { requireActive = true } = {}) {
    if (!actor) return null;
    const pool = participantUsers({ requireActive });
    if (!pool.length) return null;
    const byId = (a, b) => a.id.localeCompare(b.id);

    const linked = pool.find(u => u.character?.id === actor.id);
    if (linked) return linked.id;

    const explicit = pool.filter(u => (actor.ownership?.[u.id] ?? 0) >= OWNER).sort(byId);
    if (explicit.length) return explicit[0].id;

    const any = pool.filter(u => {
      try { return !!actor.testUserPermission?.(u, "OWNER"); } catch { return false; }
    }).sort(byId);
    return any[0]?.id ?? null;
  }

  function _applyBodyClass() {
    try { document.body?.classList.toggle("fu-spectator", isSpectator()); } catch {}
  }

  async function refresh() {
    try {
      const res   = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
      const props = res?.db?.system?.props ?? null;
      if (props) {
        const ids = new Set();
        for (let i = 1; i <= 4; i++) {
          const id = _stripActor(props[`member_id_${i}`]);
          if (id) ids.add(id);
        }
        _partyIds = ids;
      }
    } catch (err) {
      console.warn(TAG, "Party refresh failed.", err);
    }
    _applyBodyClass();
    return _partyIds ? [..._partyIds] : null;
  }

  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, SETTING, {
      name: "Always-spectator users",
      hint: "User names or ids (comma separated) that are ALWAYS spectators, even if linked to a party character. Meant for the stream window account. Everyone else is a spectator only while their linked character is not in the party.",
      scope: "world",
      config: true,
      type: String,
      default: "",
      onChange: () => _applyBodyClass(),
    });
  });

  Hooks.once("ready", () => { refresh(); });

  // Foundry core opens User Configuration on EVERY load for a player with no
  // linked character (client/game.js setupGame). A spectator never has one, so
  // the stream window would boot behind that sheet. Close that one automatic
  // opening; a later manual open is left alone.
  let _bootSheetHandled = false;
  Hooks.on("renderUserConfig", (app) => {
    if (_bootSheetHandled) return;
    // ApplicationV2 sheets expose .document; V1 sheets .object.
    if ((app.document ?? app.object)?.id !== game.user?.id || game.user?.isGM || game.user?.character) return;
    _bootSheetHandled = true;
    if (isSpectator()) app.close();
  });

  // Re-resolve when the party roster or the Current Game pointer changes.
  Hooks.on("updateActor", (_actor, changes) => {
    const keys = Object.keys(foundry.utils.flattenObject(changes ?? {}));
    if (keys.some(k => /^system\.props\.(member_id_\d|game_id)$/.test(k))) refresh();
  });
  // A user's linked character changed — only their own body class can move.
  Hooks.on("updateUser", (user, changes) => {
    if ("character" in (changes ?? {}) && user.id === game.user?.id) _applyBodyClass();
  });

  globalThis.FUCompanion.api.Spectator = {
    role,
    isSpectator,
    isParticipant,
    participantUsers,
    deciderUserIdForActor,
    refresh,
    partyActorIds: () => (_partyIds ? [..._partyIds] : null),
  };

  console.debug(TAG, "Helper loaded.");
})();
