/**
 * movementControl-resolver.js
 * Fabula Ultima Companion - Movement Control System Resolver
 * Foundry VTT v12
 *
 * Purpose:
 * - Resolve the Current Game actor
 * - Resolve the active Central Party Actor from Current Game
 * - Read party member slots from the Central Party Actor
 * - Match online users to party members via Foundry's linked Actor system
 * - Resolve the live central party token on the current canvas
 *
 * Notes:
 * - This script is read-only. It does not update flags, token data, or controller status.
 * - It is meant to be used by store/api/runtime/ui scripts later.
 *
 * Globals:
 *   globalThis.__ONI_MOVEMENT_CONTROL_RESOLVER__
 *
 * API:
 *   FUCompanion.api.MovementControlResolver
 */

(() => {
  const GLOBAL_KEY = "__ONI_MOVEMENT_CONTROL_RESOLVER__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "movementControl";
  const CURRENT_GAME_FALLBACK_NAME = "Current Game";

  function getDebug() {
    const dbg = globalThis.__ONI_MOVEMENT_CONTROL_DEBUG__;
    if (dbg?.installed) return dbg;

    const noop = () => {};
    return {
      log: noop,
      info: noop,
      verbose: noop,
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      group: noop,
      groupCollapsed: noop,
      table: noop,
      divider: noop,
      startTimer: noop,
      endTimer: () => null
    };
  }

  const DBG = getDebug();

  function safeGet(obj, path, fallback = undefined) {
    try {
      const parts = String(path).split(".");
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return fallback;
        cur = cur[p];
      }
      return cur === undefined ? fallback : cur;
    } catch {
      return fallback;
    }
  }

  function asString(value, fallback = "") {
    if (value == null) return fallback;
    return String(value);
  }

  function cleanString(value) {
    return asString(value).trim();
  }

  function hasText(value) {
    return cleanString(value).length > 0;
  }

  function uniqueBy(array, keyFn) {
    const seen = new Set();
    const out = [];

    for (const item of array) {
      const key = keyFn(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }

    return out;
  }

  function actorRefToActorUuid(actorRef) {
    const raw = cleanString(actorRef);
    if (!raw) return null;

    if (raw.startsWith("Actor.")) return raw;

    // Raw Foundry Actor id
    if (!raw.includes(".")) return `Actor.${raw}`;

    // Already some sort of full ref; keep as-is
    return raw;
  }

  function actorRefToActorId(actorRef) {
    const raw = cleanString(actorRef);
    if (!raw) return null;

    if (raw.startsWith("Actor.")) {
      const [, id] = raw.split(".");
      return id || null;
    }

    if (!raw.includes(".")) return raw;

    // Fallback for odd uuid-like refs ending in Actor.<id>
    const parts = raw.split(".");
    const idx = parts.lastIndexOf("Actor");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];

    return null;
  }

  async function resolveActorFromRef(actorRef) {
    const raw = cleanString(actorRef);
    if (!raw) return null;

    const actorId = actorRefToActorId(raw);
    if (actorId) {
      const byId = game.actors?.get(actorId) ?? null;
      if (byId) return byId;
    }

    const actorUuid = actorRefToActorUuid(raw);
    if (actorUuid) {
      try {
        const doc = await fromUuid(actorUuid);
        if (doc?.documentName === "Actor") return doc;
      } catch (err) {
        DBG.verbose("Resolver", "fromUuid failed during actor resolution", {
          actorRef: raw,
          actorUuid,
          error: err?.message ?? err
        });
      }
    }

    return null;
  }

  function getCurrentGameActorCandidates() {
    const out = [];

    // 1) Exact name fallback
    const byName = game.actors?.getName?.(CURRENT_GAME_FALLBACK_NAME) ?? null;
    if (byName) out.push(byName);

    // 2) system.props.name exact
    for (const actor of game.actors ?? []) {
      const propsName = safeGet(actor, "system.props.name", "");
      if (cleanString(propsName) === CURRENT_GAME_FALLBACK_NAME) out.push(actor);
    }

    return uniqueBy(out, a => a.id);
  }

  async function resolveCurrentGameActor() {
    DBG.startTimer("resolve-current-game", "Resolver", "Resolving Current Game actor");

    try {
      const candidates = getCurrentGameActorCandidates();

      if (candidates.length > 0) {
        const actor = candidates[0];
        DBG.groupCollapsed("Resolver", "Resolved Current Game actor", {
          actorId: actor.id,
          actorName: actor.name,
          candidates: candidates.map(a => ({ id: a.id, name: a.name }))
        });
        return actor;
      }

      DBG.warn("Resolver", "Unable to resolve Current Game actor");
      return null;
    } finally {
      DBG.endTimer("resolve-current-game", "Resolver", "Resolved Current Game actor");
    }
  }

  function getCentralPartyActorRefFromCurrentGame(currentGameActor) {
    return cleanString(safeGet(currentGameActor, "system.props.game_id", ""));
  }

  async function resolveCentralPartyActor(currentGameActor) {
    if (!currentGameActor) return null;

    const actorRef = getCentralPartyActorRefFromCurrentGame(currentGameActor);
    if (!actorRef) {
      DBG.warn("Resolver", "Current Game actor has no game_id reference", {
        currentGameActorId: currentGameActor.id,
        currentGameActorName: currentGameActor.name
      });
      return null;
    }

    const actor = await resolveActorFromRef(actorRef);

    DBG.groupCollapsed("Resolver", "Resolved Central Party Actor", {
      currentGameActorId: currentGameActor.id,
      currentGameActorName: currentGameActor.name,
      actorRef,
      resolvedActorId: actor?.id ?? null,
      resolvedActorName: actor?.name ?? null
    });

    return actor;
  }

  function getPartyMemberSlotIndexesFromProps(props) {
    const indexes = new Set();

    for (const key of Object.keys(props ?? {})) {
      const match = key.match(/^member_(?:name|id|sprite|level|exp|zenit|currenthp|maxhp|currentmp|maxmp|currentip|maxip|currentzp|maxzp)_(\d+)$/);
      if (match?.[1]) indexes.add(Number(match[1]));
    }

    return Array.from(indexes).sort((a, b) => a - b);
  }

  async function extractPartyMembers(partyActor) {
    if (!partyActor) return [];

    const props = safeGet(partyActor, "system.props", {});
    const indexes = getPartyMemberSlotIndexesFromProps(props);

    const members = [];

    for (const slot of indexes) {
      const rawName = cleanString(props[`member_name_${slot}`]);
      const rawRef = cleanString(props[`member_id_${slot}`]);

      if (!rawName && !rawRef) continue;

      const normalizedActorId = actorRefToActorId(rawRef);
      const normalizedActorUuid = actorRefToActorUuid(rawRef);

      let actor = null;
      if (rawRef) actor = await resolveActorFromRef(rawRef);

      const member = {
        slot,
        rawName,
        rawActorRef: rawRef || null,
        normalizedActorId: normalizedActorId || null,
        normalizedActorUuid: normalizedActorUuid || null,
        actorId: actor?.id ?? normalizedActorId ?? null,
        actorUuid: actor?.uuid ?? normalizedActorUuid ?? null,
        actorName: actor?.name ?? rawName ?? null,
        actor
      };

      members.push(member);
    }

    DBG.table(
      "Resolver",
      "Extracted party member slots",
      members.map(m => ({
        slot: m.slot,
        rawName: m.rawName,
        rawActorRef: m.rawActorRef,
        actorId: m.actorId,
        actorName: m.actorName
      }))
    );

    return members;
  }

  function getLinkedActorForUser(user) {
    if (!user) return null;
    return user.character ?? null;
  }

  function getUserDescriptor(user) {
    const linkedActor = getLinkedActorForUser(user);

    return {
      user,
      userId: user?.id ?? null,
      userName: user?.name ?? null,
      isActive: !!user?.active,
      isGM: !!user?.isGM,
      linkedActor,
      linkedActorId: linkedActor?.id ?? null,
      linkedActorUuid: linkedActor?.uuid ?? null,
      linkedActorName: linkedActor?.name ?? null
    };
  }

  function matchUserToPartyMember(userDescriptor, partyMembers) {
    if (!userDescriptor?.linkedActor) {
      return {
        matched: false,
        matchType: null,
        partyMember: null
      };
    }

    const linkedActor = userDescriptor.linkedActor;
    const linkedActorId = linkedActor.id;
    const linkedActorName = cleanString(linkedActor.name).toLowerCase();

    // Strong match: actor id
    let member = partyMembers.find(m => m.actorId && m.actorId === linkedActorId);
    if (member) {
      return {
        matched: true,
        matchType: "actorId",
        partyMember: member
      };
    }

    // Fallback: actor name
    member = partyMembers.find(m => cleanString(m.actorName).toLowerCase() === linkedActorName);
    if (member) {
      return {
        matched: true,
        matchType: "actorName",
        partyMember: member
      };
    }

    return {
      matched: false,
      matchType: null,
      partyMember: null
    };
  }

  function buildUserMatches(partyMembers, { onlineOnly = false, includeGM = false } = {}) {
    const users = Array.from(game.users ?? []);
    const rows = [];

    for (const user of users) {
      if (onlineOnly && !user.active) continue;
      if (!includeGM && user.isGM) continue;

      const descriptor = getUserDescriptor(user);
      const match = matchUserToPartyMember(descriptor, partyMembers);

      rows.push({
        ...descriptor,
        matched: match.matched,
        matchType: match.matchType,
        partyMember: match.partyMember,
        partyMemberSlot: match.partyMember?.slot ?? null,
        partyMemberActorId: match.partyMember?.actorId ?? null,
        partyMemberActorName: match.partyMember?.actorName ?? null
      });
    }

    rows.sort((a, b) => {
      const slotA = a.partyMemberSlot ?? 9999;
      const slotB = b.partyMemberSlot ?? 9999;
      if (slotA !== slotB) return slotA - slotB;
      return cleanString(a.userName).localeCompare(cleanString(b.userName));
    });

    return rows;
  }

  function getEligibleControllers(partyMembers, { onlineOnly = true, includeGM = false } = {}) {
    return buildUserMatches(partyMembers, { onlineOnly, includeGM }).filter(row => row.matched);
  }

  function getDefaultController(eligibleControllers) {
    // Preferred default: slot 1 owner
    const slotOne = eligibleControllers.find(row => row.partyMemberSlot === 1);
    if (slotOne) return slotOne;

    return eligibleControllers[0] ?? null;
  }

  function findControllerByUserId(eligibleControllers, userId) {
    const cleanUserId = cleanString(userId);
    if (!cleanUserId) return null;
    return eligibleControllers.find(row => row.userId === cleanUserId) ?? null;
  }

  function resolveCentralPartyTokenOnCanvas(partyActor) {
    if (!canvas?.ready || !partyActor) return null;

    // Strong match: actor id
    let token = canvas.tokens?.placeables?.find(t => t?.actor?.id === partyActor.id) ?? null;
    if (token) return token;

    // Fallback: token name equals actor name
    token = canvas.tokens?.placeables?.find(t => cleanString(t?.name) === cleanString(partyActor.name)) ?? null;
    if (token) return token;

    return null;
  }

  function getTokenDescriptor(token) {
    if (!token) return null;

    return {
      token,
      tokenId: token.id ?? null,
      tokenName: token.name ?? null,
      tokenUuid: token.document?.uuid ?? null,
      actorId: token.actor?.id ?? null,
      actorName: token.actor?.name ?? null,
      sceneId: canvas?.scene?.id ?? null,
      textureSrc: safeGet(token, "document.texture.src", null),
      scaleX: safeGet(token, "document.texture.scaleX", null),
      scaleY: safeGet(token, "document.texture.scaleY", null)
    };
  }

  async function resolveSnapshot({ onlineOnly = true, includeGM = false, preferredControllerUserId = null } = {}) {
    DBG.startTimer("resolve-snapshot", "Resolver", "Resolving Movement Control snapshot");

    try {
      const currentGameActor = await resolveCurrentGameActor();
      const centralPartyActor = await resolveCentralPartyActor(currentGameActor);
      const partyMembers = await extractPartyMembers(centralPartyActor);
      const userMatchesAll = buildUserMatches(partyMembers, { onlineOnly: false, includeGM });
      const eligibleControllers = getEligibleControllers(partyMembers, { onlineOnly, includeGM });

      const preferredController = findControllerByUserId(eligibleControllers, preferredControllerUserId);
      const defaultController = getDefaultController(eligibleControllers);
      const resolvedController = preferredController ?? defaultController ?? null;

      const centralPartyToken = resolveCentralPartyTokenOnCanvas(centralPartyActor);
      const centralPartyTokenData = getTokenDescriptor(centralPartyToken);

      const snapshot = {
        currentGameActor,
        currentGameActorId: currentGameActor?.id ?? null,
        currentGameActorName: currentGameActor?.name ?? null,
        currentGameActorUuid: currentGameActor?.uuid ?? null,

        centralPartyActor,
        centralPartyActorId: centralPartyActor?.id ?? null,
        centralPartyActorName: centralPartyActor?.name ?? null,
        centralPartyActorUuid: centralPartyActor?.uuid ?? null,
        centralPartyActorRef: currentGameActor ? getCentralPartyActorRefFromCurrentGame(currentGameActor) : null,

        centralPartyToken,
        centralPartyTokenData,

        partyMembers,
        userMatchesAll,
        eligibleControllers,

        preferredControllerUserId: preferredControllerUserId ?? null,
        preferredController: preferredController ?? null,
        defaultController: defaultController ?? null,
        resolvedController: resolvedController ?? null,

        resolvedAt: Date.now()
      };

      DBG.groupCollapsed("Resolver", "Movement Control snapshot resolved", {
        currentGameActorId: snapshot.currentGameActorId,
        currentGameActorName: snapshot.currentGameActorName,
        centralPartyActorId: snapshot.centralPartyActorId,
        centralPartyActorName: snapshot.centralPartyActorName,
        partyMemberCount: snapshot.partyMembers.length,
        eligibleControllerCount: snapshot.eligibleControllers.length,
        resolvedControllerUserId: snapshot.resolvedController?.userId ?? null,
        resolvedControllerUserName: snapshot.resolvedController?.userName ?? null,
        centralPartyTokenId: snapshot.centralPartyTokenData?.tokenId ?? null,
        centralPartyTokenName: snapshot.centralPartyTokenData?.tokenName ?? null
      });

      return snapshot;
    } finally {
      DBG.endTimer("resolve-snapshot", "Resolver", "Resolved Movement Control snapshot");
    }
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,

    actorRefToActorUuid,
    actorRefToActorId,
    resolveActorFromRef,

    resolveCurrentGameActor,
    resolveCentralPartyActor,
    extractPartyMembers,

    getLinkedActorForUser,
    buildUserMatches,
    getEligibleControllers,
    getDefaultController,
    findControllerByUserId,

    resolveCentralPartyTokenOnCanvas,
    getTokenDescriptor,

    resolveSnapshot
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.MovementControlResolver = api;
    } catch (err) {
      console.warn("[MovementControl:Resolver] Failed to attach API to FUCompanion.api", err);
    }

    DBG.verbose("Resolver", "movementControl-resolver.js ready", {
      moduleId: MODULE_ID,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });
  });
})();
