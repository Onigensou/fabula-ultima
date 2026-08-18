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

  // ── Concurrency guards ─────────────────────────────────────────────────────
  //
  // save() and load() rewrite every party actor's embedded items with a
  // delete-all/recreate-all, and rewrite the shared fu-saves/index.json. Two
  // clients doing that at once corrupts both. The game runs two GM clients, and
  // these are reachable from the save menu on either of them, from the title
  // lobby, and from FUCompanion.api.saveSystem in the console — so the guard
  // lives here, on the dangerous function, rather than trusting every caller.
  //
  // The gate is identity-based (one designated client), not a lock: a
  // check-then-set lock across clients is not atomic and would still race.

  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? false;

  let _inFlight = null; // "save" | "load" | null — this client, this tick

  // Set when an apply() timed out. That apply is still running and still
  // writing; we cannot cancel it, so no further save/load may start on this
  // client until a reload clears the page. Fail closed.
  let _poisoned = null;

  // Returns an error string if the operation must not run, else null.
  function _guard(op) {
    const Op = op === "save" ? "Save" : "Load";
    if (!game.user?.isGM) return "GM only";
    if (_poisoned) return `${Op} blocked — ${_poisoned}. Reload the client (F5).`;
    if (!isPrimaryGM()) {
      const gm = globalThis.FUCompanion?.primaryGM?.()?.name;
      return gm
        ? `${Op} must be run by the primary GM (${gm}).`
        : `${Op} must be run by the primary GM.`;
    }
    if (_inFlight) return `a ${_inFlight} is already in progress`;
    return null;
  }

  // ── Discovery helpers ──────────────────────────────────────────────────────

  function resolveActorUuid(id) {
    if (!id || typeof id !== "string" || !id.trim()) return null;
    return id.startsWith("Actor.") ? id : `Actor.${id}`;
  }

  function findCurrentGameActor() {
    // CSB auto-fills props.uuid on every actor, so self-referential props check
    // matches 700+ actors. The movementControlState flag is set exclusively on
    // the "Current Game" actor by the movement control system.
    return game.actors.find(a =>
      a.flags?.[SS.MODULE_ID]?.movementControlState?.currentGameActorId === a.id
    ) ?? null;
  }

  function findPartyActor(currentGame) {
    const gameId = currentGame?.system?.props?.game_id;
    if (!gameId) return null;
    const rawId = gameId.startsWith("Actor.") ? gameId.slice(6) : gameId;
    return game.actors.get(rawId) ?? null;
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
    // Route through SS.Core so the exported (hot-patchable) reference is used.
    // This also makes fresh reloads with correct cache work out of the box.
    const currentGame = SS.Core ? SS.Core.findCurrentGameActor() : findCurrentGameActor();
    const partyActor  = currentGame ? findPartyActor(currentGame) : null;
    const memberUuids = partyActor ? gatherMemberUuids(partyActor.system?.props ?? {}) : [];
    return { currentGame, partyActor, memberUuids };
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  async function save(slotId) {
    const blocked = _guard("save");
    if (blocked) return { ok: false, error: blocked };
    if (slotId < 1 || slotId > SS.SLOT_COUNT) return { ok: false, error: "invalid slot" };

    _inFlight = "save";
    try {
      console.log(TAG, `Saving to slot ${slotId}…`);
      const ctx = await buildContext();
      console.debug(TAG, "context →", {
        currentGame: ctx.currentGame?.name ?? "none",
        partyActor:  ctx.partyActor?.name  ?? "none",
        members:     ctx.memberUuids,
      });

      const data   = {};
      const failed = [];
      for (const ext of SS.getExtractors()) {
        try {
          data[ext.key] = await ext.extract(ctx);
          console.debug(TAG, `  ✓ extracted [${ext.key}]`);
        } catch (e) {
          console.error(TAG, `  ✗ extract failed [${ext.key}]:`, e);
          data[ext.key] = null;
          failed.push(ext.key);
        }
      }

      // A save with a null domain silently restores nothing for that domain on
      // load. Refuse to write it rather than hand back a save that looks fine.
      if (failed.length) {
        const error = `extract failed: ${failed.join(", ")}`;
        console.error(TAG, `Save aborted — ${error}`);
        return { ok: false, error, failed };
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
    } finally {
      _inFlight = null;
    }
  }

  // ── Load ───────────────────────────────────────────────────────────────────

  // An apply() that never settles hangs the whole load, leaving the title-screen
  // dimmer up over a half-restored world with no error anywhere. Bound it.
  //
  // Generous: partyData rewrites every embedded item on every party member, and
  // CSB's prepareData costs 300-600ms per PC. This is a deadlock tripwire, not
  // a performance budget.
  const APPLY_TIMEOUT_MS = 120_000;

  class ApplyTimeout extends Error {}

  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ApplyTimeout(`[${label}] timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function load(slotId) {
    const blocked = _guard("load");
    if (blocked) return { ok: false, error: blocked };

    _inFlight = "load";
    try {
      const blob = await SS.Storage.getSlotFull(slotId);
      if (!blob) return { ok: false, error: "empty slot" };
      if (blob.version > SS.SAVE_VERSION) {
        return { ok: false, error: `save version ${blob.version} not supported` };
      }

      console.log(TAG, `Loading slot ${slotId}: "${blob.label}"…`);
      const ctx = await buildContext();
      SS._diffReport = []; // per-actor embed diff summaries, filled during apply
      const loadStart = performance.now();

      // Load-wide suppression of "does not exist" delete errors. applyActorEmbeds
      // deletes each actor's items en masse; CSB's CustomItem._preDelete then
      // cascade-deletes contained children UNAWAITED, so the batch's own delete of
      // those children lands as "does not exist" — asynchronously, after any
      // per-call mute would have restored. The end state is correct (verified: no
      // orphans). Route the noise to the console for the whole load instead.
      const restoreNotify = _suppressMissingDocErrors();

      const failedCritical = [];
      const failedCosmetic = [];
      try {
        for (const ext of SS.getExtractors()) {
          const domainData = blob.data?.[ext.key];
          try {
            await withTimeout(ext.apply(ctx, domainData), APPLY_TIMEOUT_MS, ext.key);
            console.debug(TAG, `  ✓ applied [${ext.key}]`);
          } catch (e) {
            console.error(TAG, `  ✗ apply failed [${ext.key}]${ext.critical ? " (CRITICAL)" : ""}:`, e);
            (ext.critical ? failedCritical : failedCosmetic).push(ext.key);
            // A thrown apply has settled — the next one can safely run. A timed-out
            // apply is still running: continuing would put two extractors' writes
            // on the wire at once, which is the corruption we are here to prevent.
            if (e instanceof ApplyTimeout) {
              _poisoned = `a previous load timed out in [${ext.key}] and may still be writing`;
              console.error(TAG, "Aborting load — a timed-out apply is still in flight.");
              break;
            }
          }
        }
      } finally {
        restoreNotify();
      }

      // Only a CRITICAL failure (actor/database data) fails the load and drives the
      // retry UI. A cosmetic miss (a scene layer, journal, shop) still loads — the
      // core state is intact — and comes back as a soft warning, not a scary error
      // that throws the table back to the picker over a working world.
      if (failedCritical.length) {
        const error = `apply failed: ${failedCritical.join(", ")}`;
        console.error(TAG, `Load FAILED — ${error}`);
        ui.notifications?.error?.(`[Save System] Load failed — ${error}`);
        return { ok: false, error, failed: failedCritical, label: blob.label };
      }

      if (failedCosmetic.length) {
        console.warn(TAG, `Loaded with cosmetic misses: ${failedCosmetic.join(", ")}`);
        ui.notifications?.warn?.(`[Save System] Loaded — some visuals didn't fully restore: ${failedCosmetic.join(", ")}`);
      } else {
        ui.notifications?.info?.(`[Save System] Loaded Slot ${slotId}: "${blob.label}"`);
      }
      _reportDiff(slotId, blob.label, Math.round(performance.now() - loadStart));
      console.log(TAG, `Loaded slot ${slotId}`);
      return { ok: true, label: blob.label, warnings: failedCosmetic };
    } finally {
      _inFlight = null;
    }
  }

  // ── Load observability ──────────────────────────────────────────────────────
  // Print a readable per-actor embed-diff summary and stash the full report on
  // SS._lastLoadReport so it can be inspected programmatically (test bridge). This
  // is the debug surface for the diff-based apply: at a glance you see how many
  // items/effects were updated/created/deleted vs left untouched, and which ones.
  function _reportDiff(slotId, label, totalMs) {
    const report = SS._diffReport ?? [];
    const sum = (sel) => report.reduce((n, r) => n + sel(r), 0);
    const totals = {
      itemUpdate: sum(r => r.item.update),   itemCreate: sum(r => r.item.create),
      itemDelete: sum(r => r.item.delete),   itemSkip:   sum(r => r.item.skip),
      fxUpdate:   sum(r => r.effect.update), fxCreate:   sum(r => r.effect.create),
      fxDelete:   sum(r => r.effect.delete), fxSkip:     sum(r => r.effect.skip),
      // Documents the load-safety rule kept (no world master, or diverged from
      // it). Without this the programmatic surface reports `itemDelete` with no
      // sign that a larger delete set was declined — the console line had the
      // context and the object the test bridge reads did not.
      keptUnique: sum(r => r.item.keptUnique ?? 0),
      // Same argument for the rest of what the guard did: documents re-paired by
      // name (a delete+create collapsed into one state-only update), documents
      // kept but taken OFF the body, and hand-placed reaction-config effects the
      // actor-AE pass declined to clear.
      repaired:   sum(r => r.item.repaired   ?? 0),
      unequipped: sum(r => r.item.unequipped ?? 0),
      fxKept:     sum(r => r.effect.keptUnique ?? 0),
      // Renames observed, and equip slots actually re-pointed at them. Without
      // the second number the test bridge cannot assert the slot fixup RAN --
      // it existed only in a console line.
      renamed:        sum(r => r.item.renamed?.length ?? 0),
      slotsRepointed: sum(r => r.slotsRepointed ?? 0),
      nestedFx:       sum(r => (r.item.nested?.update ?? 0) + (r.item.nested?.create ?? 0) + (r.item.nested?.delete ?? 0)),
    };
    SS._lastLoadReport = { slotId, label, totalMs, actors: report, totals };

    if (!SS.DEBUG_LOAD) return; // counts kept on _lastLoadReport; skip the console group

    try {
      console.groupCollapsed(
        `%c[SaveSystem][Diff] slot ${slotId} — ${totals.itemUpdate + totals.itemCreate + totals.itemDelete} item writes, ` +
        `${totals.fxUpdate + totals.fxCreate + totals.fxDelete} effect writes ` +
        `(${totals.itemSkip} items untouched) in ${totalMs}ms`,
        "color:#c9a22a;font-weight:bold"
      );
      for (const r of report) {
        const i = r.item, e = r.effect, n = i.nested ?? { update: 0, create: 0, delete: 0 };
        console.log(
          `%c${r.actor}%c  items: ${i.skip} skip / ${i.update} upd / ${i.create} new / ${i.delete} del` +
          `   item-fx: ${n.update} upd / ${n.create} new / ${n.delete} del` +
          `   actor-fx: ${e.skip} skip / ${e.update} upd / ${e.create} new / ${e.delete} del   (${r.ms}ms)`,
          "font-weight:bold", "color:inherit"
        );
        if (i.updated.length) console.log(`    item upd: ${i.updated.join(", ")}`);
        if (i.created.length) console.log(`    item new: ${i.created.join(", ")}`);
        if (i.deleted.length) console.log(`    item del: ${i.deleted.join(", ")}`);
        if (e.updated.length) console.log(`    actor-fx upd: ${e.updated.join(", ")}`);
        if (e.deleted.length) console.log(`    actor-fx del: ${e.deleted.join(", ")}`);
      }
      console.log("Full report → SaveSystem._lastLoadReport");
      console.groupEnd();
    } catch { /* console grouping is best-effort */ }
  }

  // Temporarily filter "does not exist" out of ui.notifications.error for the
  // duration of a load. Returns a restore fn. Everything else passes through, and
  // the suppressed messages are still logged (console.debug) so nothing is hidden.
  function _suppressMissingDocErrors() {
    const notif = ui?.notifications;
    if (!notif?.error) return () => {};
    const orig = notif.error.bind(notif);
    notif.error = (msg, ...rest) => {
      if (typeof msg === "string" && msg.includes("does not exist")) {
        console.debug(TAG, "(suppressed)", msg);
        return;
      }
      return orig(msg, ...rest);
    };
    return () => { notif.error = orig; };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  SS.Core = {
    save,
    load,
    buildContext,
    findCurrentGameActor,
    resolveActorUuid,
    // Why save/load would refuse right now (null = it would run). Lets the UI
    // grey out a button instead of only reporting after the click.
    blockedReason: (op = "load") => _guard(op),
  };

  console.debug(TAG, "Core loaded.");
})();
