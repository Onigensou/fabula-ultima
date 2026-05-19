// ============================================================================
// Save System — Core Orchestrator
//
// Discovery chain (zero hardcoded IDs):
//   Current Game actor  →  self-referential props.uuid === actor.uuid
//   Party actor         →  fromUuid(currentGame.system.props.game_id)
//   Party members       →  partyActor.system.props.member_id_1..N + bench_id_1..N
//   Linked NPCs         →  system.template === npcTemplateId && prototypeToken.actorLink
// ============================================================================
(() => {
  const SS  = globalThis.SaveSystem ??= {};
  const TAG = "[SaveSystem][Core]";

  // ── Discovery helpers ──────────────────────────────────────────────────────

  function resolveActorUuid(id) {
    if (!id || typeof id !== "string" || !id.trim()) return null;
    return id.startsWith("Actor.") ? id : `Actor.${id}`;
  }

  function findCurrentGameActor() {
    return game.actors.find(a =>
      a.system?.props?.uuid && a.system.props.uuid === a.uuid
    ) ?? null;
  }

  async function findPartyActor(currentGame) {
    const gameId = currentGame?.system?.props?.game_id;
    if (!gameId) return null;
    return await fromUuid(resolveActorUuid(gameId)).catch(() => null);
  }

  function gatherMemberUuids(partyProps) {
    const uuids = [];
    for (let i = 1; i <= 10; i++) {
      const mid = resolveActorUuid(partyProps[`member_id_${i}`]);
      const bid = resolveActorUuid(partyProps[`bench_id_${i}`]);
      if (mid) uuids.push(mid);
      if (bid) uuids.push(bid);
    }
    return [...new Set(uuids)];
  }

  async function buildContext() {
    const currentGame = findCurrentGameActor();
    const partyActor  = currentGame ? await findPartyActor(currentGame) : null;
    const memberUuids = partyActor ? gatherMemberUuids(partyActor.system?.props ?? {}) : [];
    return { currentGame, partyActor, memberUuids };
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  async function save(slotId) {
    if (!game.user?.isGM) return { ok: false, error: "GM only" };
    if (slotId < 1 || slotId > SS.SLOT_COUNT) return { ok: false, error: "invalid slot" };

    console.log(TAG, `Saving to slot ${slotId}…`);
    const ctx = await buildContext();
    console.debug(TAG, "context →", {
      currentGame: ctx.currentGame?.name ?? "none",
      partyActor:  ctx.partyActor?.name  ?? "none",
      members:     ctx.memberUuids,
    });

    const data = {};
    for (const ext of SS.getExtractors()) {
      try {
        data[ext.key] = await ext.extract(ctx);
        console.debug(TAG, `  ✓ extracted [${ext.key}]`);
      } catch (e) {
        console.error(TAG, `  ✗ extract failed [${ext.key}]:`, e);
        data[ext.key] = null;
      }
    }

    const activeScene = game.scenes.active;
    const gameName    = ctx.partyActor?.system?.props?.game_name ?? "Unknown";
    const blob = {
      version:   SS.SAVE_VERSION,
      savedAt:   new Date().toISOString(),
      label:     `${gameName} — ${activeScene?.name ?? "?"}`,
      thumbnail: activeScene?.background?.src ?? "",
      data,
    };

    await SS.Storage.setSlot(slotId, blob);
    ui.notifications?.info?.(`[Save System] Saved to Slot ${slotId}: "${blob.label}"`);
    console.log(TAG, `Saved slot ${slotId}: "${blob.label}"`);
    return { ok: true, label: blob.label };
  }

  // ── Load ───────────────────────────────────────────────────────────────────

  async function load(slotId) {
    if (!game.user?.isGM) return { ok: false, error: "GM only" };
    const blob = SS.Storage.getSlot(slotId);
    if (!blob) return { ok: false, error: "empty slot" };
    if (blob.version > SS.SAVE_VERSION) {
      return { ok: false, error: `save version ${blob.version} not supported` };
    }

    console.log(TAG, `Loading slot ${slotId}: "${blob.label}"…`);
    const ctx = await buildContext();

    for (const ext of SS.getExtractors()) {
      const domainData = blob.data?.[ext.key];
      try {
        await ext.apply(ctx, domainData);
        console.debug(TAG, `  ✓ applied [${ext.key}]`);
      } catch (e) {
        console.error(TAG, `  ✗ apply failed [${ext.key}]:`, e);
      }
    }

    ui.notifications?.info?.(`[Save System] Loaded Slot ${slotId}: "${blob.label}"`);
    console.log(TAG, `Loaded slot ${slotId}`);
    return { ok: true, label: blob.label };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  SS.Core = {
    save,
    load,
    buildContext,
    findCurrentGameActor,
    resolveActorUuid,
  };

  console.debug(TAG, "Core loaded.");
})();
