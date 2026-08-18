// ============================================================================
// Save System — Domain Extractors
//
// Each extractor is registered in apply order:
//   1.  databasePointer     – which party database is active
//   2.  partyActorData      – full state (system, flags, items, effects) of the party/database actor
//   3.  partyData           – full state for each party member + bench character
//   4.  npcData             – full state for linked NPCs/bosses matching NPC template
//   5.  activeScene         – which scene is currently active
//   6.  sceneBackgrounds    – background image per scene (story progression)
//   7.  sceneAudio          – playlist + playlistSound per scene (story progression)
//   8.  dungeonTileData     – DungeonPathing flags (tileStates + visitedTiles)
//                             filtered to Dungeon/Exploration/Camp scenes only
//   9.  sceneTileVisibility – full Tile document per Dungeon/Exploration/Camp scene;
//                             extra tiles deleted, missing tiles recreated on load
//   10. sceneDrawingData    – full Drawing document state for Dungeon scenes;
//                             drawings added after save are deleted, missing recreated
//   11. sceneTokenData      – full Token document per Dungeon/Exploration/Camp scene;
//                             extra tokens deleted, missing tokens recreated on load;
//                             token visibility (hidden) is part of the snapshot
//   12. campState           – CampSystem world settings
//   13. encyclopediaData    – Monster Encyclopedia journal page flags + content
//   14. journalOwnership    – ownership map of every journal entry
//
// To add a new domain in future: call SS.registerExtractor({ key, label, extract, apply })
// anywhere that runs before the first save.
// ============================================================================
(() => {
  const SS  = globalThis.SaveSystem ??= {};
  const MOD = SS.MODULE_ID;
  const TAG = "[SaveSystem][Extractors]";

  // fromUuid inside module IIFEs can fail silently; use game.actors.get() directly
  // for world actors which are always already in memory.
  function actorFromUuid(uuid) {
    if (!uuid || typeof uuid !== "string") return null;
    const rawId = uuid.startsWith("Actor.") ? uuid.slice(6) : uuid;
    return game.actors.get(rawId) ?? null;
  }

  // V12 _deleteDocuments has no strict:false guard — any missing ID throws and
  // Foundry fires a UI notification at the socket layer before our catch runs.
  // Some actors have orphaned item references: the actor document has the ID
  // but the item sub-level record was never written (data corruption from a
  // partially-failed createEmbeddedDocuments in a prior session).
  //
  // Strategy: temporarily silence ui.notifications.error for "does not exist"
  // messages, fall back to individual deletes so we clear as many as possible,
  // then ALWAYS run creates so orphaned IDs get healed (keepId:true creates
  // them as real item records, fixing the corruption for subsequent loads).
  async function safeDeleteEmbeds(actor, type, ids) {
    if (!ids.length) return;
    // Mute notifications for the duration of this delete so orphaned-ref errors
    // don't appear in the UI.  The finally block always restores the original.
    const orig = ui?.notifications?.error?.bind(ui.notifications);
    if (ui?.notifications) {
      ui.notifications.error = (msg, ...rest) => {
        if (typeof msg === "string" && msg.includes("does not exist")) return;
        orig?.(msg, ...rest);
      };
    }
    try {
      await actor.deleteEmbeddedDocuments(type, ids);
    } catch {
      // Batch failed (at least one ID was orphaned); retry individually so
      // the real items still get deleted even when some IDs are missing.
      await Promise.allSettled(
        ids.map(id => actor.deleteEmbeddedDocuments(type, [id]).catch(() => {}))
      );
    } finally {
      if (ui?.notifications) ui.notifications.error = orig;
    }
  }

  // CSB stores list data as plain objects with numeric string keys (e.g. class_list,
  // memories_list). Foundry's actor.update() uses mergeObject internally, which never
  // removes keys that exist in the current document but are absent from the update data.
  // For list-type props this means deleted/added-after-save entries survive a load.
  // We resolve this by building explicit Foundry "-=" deletion keys before the full
  // system update so those stale rows are removed.
  async function wipeStaleCsbListEntries(actor, savedProps) {
    const currentProps = actor.system?.props ?? {};
    const deletions    = {};
    for (const [propKey, currentVal] of Object.entries(currentProps)) {
      if (typeof currentVal !== "object" || currentVal === null || Array.isArray(currentVal)) continue;
      const savedVal = savedProps?.[propKey];
      if (typeof savedVal !== "object" || savedVal === null) continue;
      for (const rowKey of Object.keys(currentVal)) {
        if (!(rowKey in savedVal)) {
          deletions[`system.props.${propKey}.-=${rowKey}`] = true;
        }
      }
    }
    if (Object.keys(deletions).length) await actor.update(deletions);
  }

  // ── Diff-based embedded application (Tier 2) ────────────────────────────────
  //
  // Replaces delete-all/recreate-all. Unchanged documents are left untouched, so
  // a load no longer tears down and rebuilds ~200 items per PC — it writes only
  // what actually changed. This removes the container delete-cascade (the source
  // of the "item <id> does not exist" spam) and most of the churn/re-render cost.
  //
  // canonicalizeEmbed strips volatile/derived fields so two serializations of the
  // same logical document compare equal:
  //   • _stats  — createdTime/modifiedTime, always volatile.
  //   • items   — the nested sub-item view. CSB stores contained children as
  //     separate flat sibling entries keyed by system.container, so a container's
  //     rendered `.items` is derived; comparing it flags every container falsely.
  // Verified against the live world: after this strip, the only real diffs are
  // value-changes (no live-only "stale" keys), so a plain in-place update is safe
  // — no delete needed to clear removed keys.
  function canonicalizeEmbed(obj) {
    if (Array.isArray(obj)) return obj.map(canonicalizeEmbed);
    if (obj && typeof obj === "object") {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "_stats" || k === "items") continue;
        out[k] = canonicalizeEmbed(v);
      }
      return out;
    }
    return obj;
  }

  // ── Load safety: the LIVE world owns definitions, the SAVE owns state ───────
  //
  // The diff below reconciles the live world TO the snapshot. That is right for
  // both real uses of this system — swapping between two party datasets, and
  // resetting the world before a session so test debris does not leak into play.
  // Both NEED deletion to work.
  //
  // What it gets wrong is that a save stores whole DOCUMENTS, and in CSB a
  // document fuses two unrelated things: campaign state (quantity, equipped) and
  // the item's DEFINITION (effect_table, formulas, fire-point refs). Nothing
  // marks which is which. So a snapshot of state is also a frozen copy of every
  // skill definition as it stood that day, and the load faithfully restores it.
  //
  // The slots are long-lived by design — slot 1 and slot 2 hold DIFFERENT party
  // actors (t6E3CQ0pGxwLgXrn / 0Ttg3RYQZUySixH1, no shared members), so they are
  // swap targets, not session checkpoints. They will always be stale against
  // ongoing authoring; re-saving is not a fix. Measured 2026-08-18 on slot 1
  // (2026-06-15): a plain reconcile deletes 150 embedded items across the four
  // PCs and rewrites definitions on ~50 more, with no textual diff anywhere.
  //
  // ── The rule ────────────────────────────────────────────────────────────────
  //
  //   1. Definitions are NEVER restored. An item present on both sides receives
  //      only ITEM_STATE_PROPS; its live definition stands.
  //   2. A live-only item is deleted only if it — and its container children —
  //      can be restored from a world master that still exists AND still matches.
  //      Anything with no master, or diverged from its master, is unique.
  //
  // Rule 2 is a RECOVERABILITY test, not a guess about authoring. This matters:
  // an earlier version of this guard tried to classify documents as content vs
  // inventory, which cannot work, because two of the nine implementation carriers
  // are invisible from the document — one is an inbound reference on someone
  // else's formula (`HAS_SKILL_PERFECT_AIM`), the other is engine code keyed by
  // name. Such a skill looks completely empty. Asking "can a master restore
  // this?" sidesteps the whole question.
  //
  // Measured over the four PCs (275 items): 263 resolve to a live master, 141 of
  // those are still identical to it (deletable), 122 have diverged, and 12 have
  // no master at all — and those 12 are exactly the bespoke ones: Fugitive
  // Experiment, Starfall Comet, Draconic Roar, Lift off, and the gear-skill
  // children. Test debris is spawned FROM a master and so is identical to it,
  // which is why the reset use case still works.
  //
  // 🪤 Container pairs. Gear here is two documents — a shell plus a same-named
  // `_skill` child holding its behaviour — and CSB's CustomItem._preDelete
  // cascade-deletes children with the parent, UNAWAITED. So the pair must be
  // decided as a unit. Verified they are recoverable together: 170 world masters
  // carry their own children (Icarus Wing -> "Icarus Wing (gear skill)", Cursed
  // Sword, Love Potion, Phoenix Feather), which is what copySubItemTree is for.
  //
  // ⚖ Two accepted costs, stated rather than implied:
  //   • 114 of the 122 diverged copies differ in VALUES at the same row count.
  //     They are kept conservatively, so a load will not clear debris that was
  //     itself customised. That is the direction that cannot lose work.
  //   • A create (item in the save, absent live) still restores the SAVED copy,
  //     definition included, because there is genuinely nothing live to prefer.
  //     After name re-pairing (below) that is 29 documents on slot 1 and 13 on
  //     slot 2, of which 5 and 10 differ from their master — mostly Hako's gear,
  //     where the difference is per-instance refinement rather than staleness.
  //     Sourcing these from the master instead would restore a current
  //     definition but drop that refinement, so neither side is plainly right;
  //     the saved copy is kept because it destroys nothing that exists.
  const ITEM_STATE_PROPS = ["isEquipped", "item_quantity"];

  // "Is this copy still the master's content?" — compared by DENYLIST, never by a
  // list of props to check. A checked-list fails PERMISSIVE: any prop not on it
  // differs unnoticed, the copy reads as a pure instance, and it gets deleted.
  // Caught in exactly that way — a 15-prop list declared Hina/Dark Orbit
  // identical to its master while `item_def_bonus` and `item_mdef_bonus`
  // differed, which is carrier-scan's own worked example of an implementation
  // living purely in stat props.
  //
  // Ignored: per-instance identity mirrors CSB recomputes on every load
  // (`id`/`uuid`/`img`), values it fills lazily (`details_roller`/`check`), and
  // the two STATE props — a copy is not "diverged" for holding a different
  // quantity or being equipped.
  const MASTER_SIG_IGNORE = new Set([
    "id", "uuid", "img", "details_roller", "check", "item_quantity", "isEquipped",
  ]);

  // An item's Active Effects are part of its definition — under the equipment
  // policy a gear item's behaviour lives on a carried transfer:true AE, so a
  // signature blind to them would call such an item a pure instance and delete
  // it against a master that cannot restore it. Compared by denylist for the
  // same reason as the props above.
  //
  // Ignored, measured over the 444 name-matched copy/master AE pairs in the
  // authored export: identity and provenance (`_id`/`_stats`/`origin`/`sort`,
  // and CSB's `originalId`/`originalUuid`/`originalParentId`, 143 pairs), the
  // runtime clock (`duration.start*`, 144), cosmetics (`img`), and `disabled` —
  // the AE-side twin of `isEquipped` (58). Everything else counts, including
  // `changes`, `statuses`, `system.tags` and the fabula/statuscounter flags.
  const AE_IGNORE_PATHS = [
    "_id", "_stats", "origin", "sort", "img", "disabled",
    "duration.startTime", "duration.startRound", "duration.startTurn",
    "flags.custom-system-builder.originalId",
    "flags.custom-system-builder.originalUuid",
    "flags.custom-system-builder.originalParentId",
  ];

  // Key-order-insensitive JSON, so two equal documents cannot read as different
  // just because Foundry rebuilt one of them in another order.
  function stableJson(v) {
    if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
    if (v && typeof v === "object") {
      return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
    }
    return JSON.stringify(v ?? null);
  }

  function aeSignature(list) {
    const sigs = (list ?? []).map(fx => {
      const e = JSON.parse(JSON.stringify(fx ?? {}));
      for (const p of AE_IGNORE_PATHS) {
        const parts = p.split(".");           // no scope in the list contains a dot
        let cur = e;
        for (let i = 0; i < parts.length - 1 && cur && typeof cur === "object"; i++) cur = cur[parts[i]];
        if (cur && typeof cur === "object") delete cur[parts.at(-1)];
      }
      return stableJson(e);
    });
    return sigs.sort().join("|");             // array order is not content
  }

  function masterSignature(o) {
    const p = o?.system?.props ?? {};
    const keys = Object.keys(p).filter(k => !MASTER_SIG_IGNORE.has(k)).sort();
    return JSON.stringify([keys.map(k => [k, p[k]]), aeSignature(o?.effects)]);
  }

  // CSB stamps `system.uniqueId` with the originating world Item's id (verified:
  // it equals `_stats.compendiumSource` where both are present, and resolves for
  // 263 of 275 party items). `compendiumSource` is the fallback.
  function masterFor(obj) {
    const uid = String(obj?.system?.uniqueId ?? "").trim();
    const src = String(obj?._stats?.compendiumSource ?? "").replace(/^Item\./, "").trim();
    for (const id of [uid, src]) {
      if (!id) continue;
      const byId = game.items.get(id);
      if (byId) return byId;
    }
    if (!uid) return null;
    return game.items.find(i => String(i.system?.uniqueId ?? "").trim() === uid) ?? null;
  }

  function restorableFromMaster(obj) {
    const m = masterFor(obj);
    if (!m) return false;
    return masterSignature(m.toObject()) === masterSignature(obj);
  }

  // Diff one embedded collection of `owner` (an Actor's Items/Effects, or — via
  // recursion — an Item's own Effects) toward the saved snapshot. Returns a
  // summary for the load-level observability rollup.
  //
  // IMPORTANT (verified live): updateEmbeddedDocuments on an Item MERGES its
  // embedded `effects` (updates by _id, inserts new) but does NOT delete effects
  // absent from the array. So an updated Item's effects are reconciled RECURSIVELY
  // here — not left to the parent update — and `effects` is stripped from the Item
  // body update to keep ownership of them in one place.
  async function applyEmbedsDiff(owner, type, savedArr = []) {
    const collection = owner.getEmbeddedCollection(type);
    const liveById   = new Map([...collection.values()].map(d => [d.id, d]));
    const savedById  = new Map((savedArr ?? []).map(d => [d._id, d]));

    const toCreate = [], toUpdate = [], toDelete = [];
    let skip = 0;
    const nested = { update: 0, create: 0, delete: 0 }; // effect ops on updated items
    const keptUnique = [];

    const guarded = type === "Item";

    // A document deleted and re-created since the save carries a NEW _id, so an
    // id-only diff sees ONE document as a delete plus a create — and the create
    // reintroduces the save's months-old copy in place of the current one. On
    // the real slots that is the dominant create (9 of 35 on slot 1, 14 of 27 on
    // slot 2) and the saved twin is badly stale: Elemental Weapon's snapshot
    // carries no effect_table and no fire point at all, so the swap leaves it
    // inert.
    //
    // Re-pair those by NAME up front, so the pair is treated as what it is — one
    // document present on both sides. It then takes rule 1's path (state only,
    // live definition stands) instead of being deleted and rolled back. Only
    // unambiguous names are paired: exactly one unmatched document of that name
    // on each side. Ambiguity (Blanche carries two documents named "Heal") is
    // left to the id diff rather than guessed at.
    let repaired = 0;
    if (guarded) {
      const bucket = (m, k, v) => { (m.get(k) ?? m.set(k, []).get(k)).push(v); return m; };
      const unmatchedLive = new Map(), unmatchedSaved = new Map();
      for (const [id, d] of liveById)  if (!savedById.has(id)) bucket(unmatchedLive, d.name, id);
      for (const [id, d] of savedById) if (!liveById.has(id))  bucket(unmatchedSaved, d.name, id);
      for (const [name, sIds] of unmatchedSaved) {
        const lIds = unmatchedLive.get(name);
        if (sIds.length !== 1 || !lIds || lIds.length !== 1) continue;
        const saved = savedById.get(sIds[0]);
        savedById.delete(sIds[0]);
        savedById.set(lIds[0], { ...saved, _id: lIds[0] });
        repaired++;
      }
    }

    // Present live but not in the save → remove, if it can be restored from a
    // master.
    if (guarded) {
      const objs = new Map([...liveById].map(([id, d]) => [id, d.toObject()]));

      // Decide the container PAIR as one unit: a shell and its `_skill` children
      // are removable only if every member is independently restorable, because
      // the CSB cascade takes them together regardless.
      const childrenOf = new Map();
      for (const [id, o] of objs) {
        const parent = String(o?.system?.container ?? "").trim();
        if (parent) (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)).push(id);
      }
      const unitOf = (id, seen = new Set()) => {
        if (seen.has(id)) return seen;
        seen.add(id);
        const parent = String(objs.get(id)?.system?.container ?? "").trim();
        if (parent && objs.has(parent)) unitOf(parent, seen);
        for (const c of (childrenOf.get(id) ?? [])) unitOf(c, seen);
        return seen;
      };

      for (const [id, live] of liveById) {
        if (savedById.has(id)) continue;
        const unit = [...unitOf(id)];
        const removable = unit.every(u => restorableFromMaster(objs.get(u)));
        if (removable) toDelete.push(id);
        else keptUnique.push(live.name ?? id);
      }
    } else {
      for (const id of liveById.keys()) if (!savedById.has(id)) toDelete.push(id);
    }
    // In the save → create if missing, update if changed, skip if identical.
    for (const [id, saved] of savedById) {
      const live = liveById.get(id);
      if (!live) { toCreate.push(saved); continue; }
      // When only state is applied, only state can make an update necessary.
      // Comparing whole documents here would queue an update for every item whose
      // DEFINITION drifted since the save — on slot 1 that is most of them — and
      // each would resolve to a no-op write plus a CSB re-render (~360ms/doc).
      if (guarded) {
        const lp = live.system?.props ?? {}, sp = saved.system?.props ?? {};
        const stateDiffers = ITEM_STATE_PROPS.some(k =>
          Object.prototype.hasOwnProperty.call(sp, k) &&
          JSON.stringify(lp[k]) !== JSON.stringify(sp[k]));
        // An equip flag present in the snapshot still needs the AE sync pass even
        // when the flag itself matches, so route those through toUpdate too.
        const needsEquipSync = Object.prototype.hasOwnProperty.call(sp, "isEquipped") &&
          [...live.getEmbeddedCollection("ActiveEffect").values()]
            .some(e => e.transfer === true && e.disabled === (sp.isEquipped === true));
        if (stateDiffers || needsEquipSync) toUpdate.push(saved); else skip++;
        continue;
      }
      if (foundry.utils.objectsEqual(canonicalizeEmbed(live.toObject()), canonicalizeEmbed(saved))) skip++;
      else toUpdate.push(saved); // saved carries _id
    }

    // safeDeleteEmbeds mutes any residual cascade "does not exist".
    if (toDelete.length) await safeDeleteEmbeds(owner, type, toDelete);

    if (toUpdate.length) {
      const updates = toUpdate.map(d => {
        // Rule 1: an Item that exists on both sides gets STATE ONLY. No
        // classification — every item is treated the same, which is what makes
        // this safe by construction rather than by a predicate that can be
        // incomplete. Its live definition always stands.
        if (guarded) {
          const state = { _id: d._id };
          const sp = d.system?.props;
          if (sp) {
            for (const k of ITEM_STATE_PROPS) {
              if (Object.prototype.hasOwnProperty.call(sp, k)) {
                ((state.system ??= {}).props ??= {})[k] = sp[k];
              }
            }
          }
          return state;
        }
        const c = { ...d };
        delete c._stats;                              // Foundry owns these timestamps
        if (type === "Item") { delete c.effects; delete c.items; } // reconciled separately
        return c;
      });
      await owner.updateEmbeddedDocuments(type, updates);

      // Reconcile each updated Item's embedded effects (the merge-not-replace fix).
      if (type === "Item") {
        for (const saved of toUpdate) {
          const item = owner.getEmbeddedCollection("Item").get(saved._id);
          if (!item) continue;
          if (guarded) {
            // An Item's AEs are part of its DEFINITION (a transfer:true gear AE,
            // a reactionConfig bridge), so they are never created or deleted from
            // a snapshot. But `disabled` carries the EQUIP toggle, and the update
            // above restores `isEquipped` — so sync the two, or the load leaves
            // worn gear inert. Nothing else repairs it: armor-equip-gate.js fires
            // only for item_type "armor", and reconcileEquip is never called on
            // the load path. Walk the LIVE transfer effects, not the saved ones,
            // so an AE absent from an old snapshot can still be switched on.
            if (!Object.prototype.hasOwnProperty.call(saved.system?.props ?? {}, "isEquipped")) continue;
            const equipped = saved.system.props.isEquipped === true;
            const fxUpdates = [];
            for (const lfx of item.getEmbeddedCollection("ActiveEffect").values()) {
              if (lfx.transfer !== true) continue;
              if (lfx.disabled === !equipped) continue;
              fxUpdates.push({ _id: lfx.id, disabled: !equipped });
            }
            if (fxUpdates.length) {
              await item.updateEmbeddedDocuments("ActiveEffect", fxUpdates);
              nested.update += fxUpdates.length;
            }
            continue;
          }
          const fx = await applyEmbedsDiff(item, "ActiveEffect", saved.effects ?? []);
          nested.update += fx.update; nested.create += fx.create; nested.delete += fx.delete;
        }
      }
    }

    if (toCreate.length) {
      // Creates carry their nested effects — createEmbeddedDocuments builds those
      // correctly, so no recursion is needed on the create path.
      try { await owner.createEmbeddedDocuments(type, toCreate, { keepId: true }); }
      catch {
        await Promise.allSettled(
          toCreate.map(d => owner.createEmbeddedDocuments(type, [d], { keepId: true }).catch(() => {}))
        );
      }
    }

    // Changed-document name lists are only built when verbose load debugging is
    // on — in normal play the counts are all that's kept.
    const debug = SS.DEBUG_LOAD;
    return {
      type,
      create: toCreate.length, update: toUpdate.length, delete: toDelete.length, skip, nested,
      // What the guard held back. Counted ALWAYS, not only under DEBUG_LOAD: a
      // load that protected 90 unique documents and one that had nothing to
      // protect must not look identical in the log.
      keptUnique: keptUnique.length,
      keptNames: keptUnique,
      repaired,
      updated: debug ? toUpdate.map(d => d.name) : [],
      created: debug ? toCreate.map(d => d.name) : [],
      deleted: debug ? toDelete.map(id => liveById.get(id)?.name ?? id) : [],
    };
  }

  // The guard applies to EVERY actor, shops included. Shops briefly had an
  // "exact restore" opt-out, on the reasoning that a shop's catalogue is
  // campaign state and its extractor promises the snapshot's exact stock. But
  // `isShop` means "sells things", not "holds no authored content": eleven
  // actors carry it and several are characters with real kits. Measured on the
  // real slots, the opt-out deleted 28 (slot 1) and 33 (slot 2) live-only
  // documents unconditionally — including 12 and 7 `_skill` children whose
  // container shell SURVIVED, leaving orphaned gear, and Willy's authored
  // "Lens of Insight (Passive)".
  //
  // Under the guard those shops instead keep 24 and 21 documents that diverge
  // from their master, so a load can leave a shop holding stock the snapshot
  // did not have. That is the accepted cost: leftover stock is visible and a GM
  // can remove it, whereas a deleted gear-skill is silent and unrecoverable.
  // Stock spawned straight from a master is still identical to it and is still
  // cleared, which is what the reset use case actually needs.
  async function applyActorEmbeds(actor, { items = [], effects = [] }) {
    const t0 = performance.now();
    const item   = await applyEmbedsDiff(actor, "Item", items);
    const effect = await applyEmbedsDiff(actor, "ActiveEffect", effects);
    const ms = Math.round(performance.now() - t0);
    (SS._diffReport ??= []).push({ actor: actor.name, ms, item, effect });
    if (item.keptUnique) {
      console.log(`${TAG} ${actor.name}: kept ${item.keptUnique} unique document(s) the save predates` +
        ` (no world master, or diverged from it): ` +
        item.keptNames.slice(0, 12).join(", ") +
        (item.keptNames.length > 12 ? ` … +${item.keptNames.length - 12} more` : ""));
    }
    if (item.repaired) {
      console.log(`${TAG} ${actor.name}: re-paired ${item.repaired} document(s) by name —` +
        ` re-created since the save under a new id, so the live definition stands`);
    }
  }

  // Scene mode is stored by the DungeonPathing / Fabula configuration system.
  function getSceneMode(scene) {
    return scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode ?? "none";
  }
  const TILE_SAVE_MODES = new Set(["dungeon", "exploration", "camp"]);

  // ── 1. Database Pointer ────────────────────────────────────────────────────
  SS.registerExtractor({
    key:   "databasePointer",
    label: "Database Pointer",
    critical: true,

    async extract({ currentGame }) {
      if (!currentGame) return null;
      return {
        gameActorUuid: currentGame.uuid,
        gameId:        currentGame.system?.props?.game_id ?? null,
      };
    },

    async apply(ctx, data) {
      if (!data?.gameId) return;
      const cg = SS.Core.findCurrentGameActor();
      if (!cg) { console.warn(TAG, "databasePointer apply: Current Game actor not found"); return; }
      const props = foundry.utils.deepClone(cg.system?.props ?? {});
      props.game_id = data.gameId;
      await cg.update({ "system.props": props });
    },
  });

  // ── 2. Party Actor (Database) — full state ────────────────────────────────
  SS.registerExtractor({
    key:   "partyActorData",
    label: "Party Actor",
    critical: true,

    async extract({ partyActor }) {
      if (!partyActor) return null;
      return {
        uuid:    partyActor.uuid,
        system:  foundry.utils.deepClone(partyActor.system  ?? {}),
        flags:   foundry.utils.deepClone(partyActor.flags   ?? {}),
        items:   (partyActor._source?.items   ?? []).map(d => foundry.utils.deepClone(d)),
        effects: (partyActor._source?.effects ?? []).map(d => foundry.utils.deepClone(d)),
      };
    },

    async apply(ctx, data) {
      if (!data?.uuid) return;
      const pa = actorFromUuid(data.uuid);
      if (!pa) { console.warn(TAG, "partyActorData apply: not found", data.uuid); return; }
      await wipeStaleCsbListEntries(pa, data.system?.props);
      await pa.update({ system: data.system, flags: data.flags });
      await applyActorEmbeds(pa, data);
    },
  });

  // ── 3. Party Members & Bench Characters — full state ─────────────────────
  SS.registerExtractor({
    key:   "partyData",
    label: "Party Members",
    critical: true,

    async extract({ memberUuids }) {
      const result = {};
      for (const uuid of memberUuids) {
        const actor = actorFromUuid(uuid);
        if (!actor) continue;
        result[uuid] = {
          name:    actor.name,
          system:  foundry.utils.deepClone(actor.system  ?? {}),
          flags:   foundry.utils.deepClone(actor.flags   ?? {}),
          items:   (actor._source?.items   ?? []).map(d => foundry.utils.deepClone(d)),
          effects: (actor._source?.effects ?? []).map(d => foundry.utils.deepClone(d)),
        };
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      for (const [uuid, actorData] of Object.entries(data)) {
        const actor = actorFromUuid(uuid);
        if (!actor) { console.warn(TAG, "partyData apply: not found", uuid); continue; }
        await wipeStaleCsbListEntries(actor, actorData.system?.props);
        await actor.update({ system: actorData.system, flags: actorData.flags });
        await applyActorEmbeds(actor, actorData);
      }
    },
  });

  // ── 4. Linked NPCs & Bosses — full state ─────────────────────────────────
  // Detection: system.template === npcTemplateId AND prototypeToken.actorLink === true
  // Unlinked actors (generic random-encounter monsters) are excluded — they
  // spawn fresh each encounter and their data does not persist.
  SS.registerExtractor({
    key:   "npcData",
    label: "Linked NPCs & Bosses",
    critical: true,

    async extract({ memberUuids }) {
      const npcTemplateId = SS.Storage.getNpcTemplateId();
      const memberSet     = new Set(memberUuids);
      const result = {};

      for (const actor of game.actors.contents) {
        if (actor.system?.template !== npcTemplateId) continue;
        if (!actor.prototypeToken?.actorLink) continue;
        if (memberSet.has(actor.uuid)) continue; // already captured in partyData
        result[actor.uuid] = {
          name:    actor.name,
          system:  foundry.utils.deepClone(actor.system  ?? {}),
          flags:   foundry.utils.deepClone(actor.flags   ?? {}),
          items:   (actor._source?.items   ?? []).map(d => foundry.utils.deepClone(d)),
          effects: (actor._source?.effects ?? []).map(d => foundry.utils.deepClone(d)),
        };
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      for (const [uuid, actorData] of Object.entries(data)) {
        const actor = actorFromUuid(uuid);
        if (!actor) { console.warn(TAG, "npcData apply: not found", uuid); continue; }
        await wipeStaleCsbListEntries(actor, actorData.system?.props);
        await actor.update({ system: actorData.system, flags: actorData.flags });
        // A SHOP routed through npcData needs the shop contract too: 8 of the 11
        // shop actors are linked NPC-template actors, which shopInventoryData
        // explicitly skips ("npcData already covers linked NPC template actors").
        // Opting out only there would reach 3 shops holding 24% of the stock.
        await applyActorEmbeds(actor, actorData);
      }
    },
  });

  // ── 5. Active Scene ────────────────────────────────────────────────────────
  // phase 1: activate LAST, after every scene-document mutation (backgrounds,
  // audio, dungeon flags, tiles, tokens, drawings) has landed — so the canvas
  // draws once, cleanly, instead of activating then churning heavy module tiles
  // (MAT/levels/tile-scroll) on the live canvas.
  SS.registerExtractor({
    key:   "activeScene",
    label: "Active Scene",
    phase: 1,

    async extract() {
      const s = game.scenes.active;
      return s ? { sceneId: s.id, sceneName: s.name } : null;
    },

    async apply(ctx, data) {
      if (!data?.sceneId) return;
      const scene = game.scenes.get(data.sceneId);
      if (scene) await scene.activate();
    },
  });

  // ── 6. Scene Backgrounds ──────────────────────────────────────────────────
  // Captures the background image for every scene — scenes can gain new
  // background images as story progresses and need to be restored per-save.
  SS.registerExtractor({
    key:   "sceneBackgrounds",
    label: "Scene Backgrounds",

    async extract() {
      const result = {};
      for (const scene of game.scenes.contents) {
        const bg = scene.background?.src;
        if (bg) result[scene.id] = bg;
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      await Promise.all(
        Object.entries(data).map(([id, bg]) => {
          const scene = game.scenes.get(id);
          if (!scene || scene.background?.src === bg) return null;
          return scene.update({ "background.src": bg });
        }).filter(Boolean)
      );
    },
  });

  // ── 7. Scene Audio (BGM) ──────────────────────────────────────────────────
  // Saves the playlist and playlistSound for every scene. Stored for ALL scenes
  // (not just dungeon modes) so that loading can restore null (no BGM) correctly —
  // only saving scenes that have audio would leave no way to clear a playlist that
  // was added after the save was taken.
  SS.registerExtractor({
    key:   "sceneAudio",
    label: "Scene Audio",

    async extract() {
      const result = {};
      for (const scene of game.scenes.contents) {
        const obj = scene.toObject();
        result[scene.id] = {
          playlist:      obj.playlist      ?? null,
          playlistSound: obj.playlistSound ?? null,
        };
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      await Promise.all(
        Object.entries(data).map(([id, { playlist, playlistSound }]) => {
          const scene = game.scenes.get(id);
          if (!scene) return null;
          const obj     = scene.toObject();
          const updates = {};
          if ((obj.playlist      ?? null) !== playlist)      updates.playlist      = playlist;
          if ((obj.playlistSound ?? null) !== playlistSound) updates.playlistSound = playlistSound;
          if (!Object.keys(updates).length) return null;
          return scene.update(updates);
        }).filter(Boolean)
      );
    },
  });

  // ── 8. Dungeon Tile States (DungeonPathing flags) ─────────────────────────
  // Saves tileStates (currentType/initialType) and visitedTiles per dungeon scene.
  SS.registerExtractor({
    key:   "dungeonTileData",
    label: "Dungeon Tile States",

    async extract() {
      const DP_KEY = "dungeonPathing";
      const result = {};
      for (const scene of game.scenes.contents) {
        if (!TILE_SAVE_MODES.has(getSceneMode(scene))) continue;
        const dp = scene.flags?.[MOD]?.[DP_KEY];
        if (!dp || (!dp.tileStates && !dp.visitedTiles)) continue;
        result[scene.id] = {
          tileStates:   foundry.utils.deepClone(dp.tileStates   ?? {}),
          visitedTiles: foundry.utils.deepClone(dp.visitedTiles ?? {}),
        };
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      const DP_KEY = "dungeonPathing";
      for (const [sceneId, { tileStates, visitedTiles }] of Object.entries(data)) {
        const scene = game.scenes.get(sceneId);
        if (!scene) continue;
        // unsetFlag first for both maps — setFlag uses update() with mergeObject
        // internally, which never removes keys present in current data but absent
        // from the save (e.g. a tile added after the save would leave a ghost entry).
        await scene.unsetFlag(MOD, `${DP_KEY}.tileStates`).catch(() => {});
        if (Object.keys(tileStates).length > 0) {
          await scene.setFlag(MOD, `${DP_KEY}.tileStates`, tileStates);
        }
        await scene.unsetFlag(MOD, `${DP_KEY}.visitedTiles`).catch(() => {});
        if (Object.keys(visitedTiles).length > 0) {
          await scene.setFlag(MOD, `${DP_KEY}.visitedTiles`, visitedTiles);
        }
      }
    },
  });

  // ── 9. Scene Tile Visibility ───────────────────────────────────────────────
  // Full Tile document state for Dungeon/Exploration/Camp scenes.
  // On load: tiles added after save are deleted; missing tiles are recreated;
  // existing tiles are updated to their saved state.
  SS.registerExtractor({
    key:   "sceneTileVisibility",
    label: "Scene Tile Data",

    async extract() {
      const result = {};
      for (const scene of game.scenes.contents) {
        if (!TILE_SAVE_MODES.has(getSceneMode(scene))) continue;
        if (!scene.tiles?.size) continue;
        const tiles = {};
        for (const tile of scene.tiles.values()) {
          tiles[tile.id] = foundry.utils.deepClone(tile.toObject());
        }
        result[scene.id] = tiles;
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      await Promise.all(
        Object.entries(data).map(async ([sceneId, tileDataMap]) => {
          const scene = game.scenes.get(sceneId);
          if (!scene) return;
          // Delete all current tiles then recreate from saved state.
          // updateEmbeddedDocuments uses mergeObject and will not clear keys
          // that were absent (default false) at save time, so delete+recreate
          // is the only way to guarantee full flag fidelity.
          const currentIds = [...scene.tiles.values()].map(t => t.id);
          if (currentIds.length) await scene.deleteEmbeddedDocuments("Tile", currentIds);
          const savedTiles = Object.values(tileDataMap);
          if (savedTiles.length) await scene.createEmbeddedDocuments("Tile", savedTiles, { keepId: true });
        })
      );
    },
  });

  // ── 10. Scene Drawing Data ─────────────────────────────────────────────────
  // Full Drawing document state for Dungeon-mode scenes only (drawings wire
  // tiles together as graph edges in the DungeonPathing system).
  // On load: drawings added after save are deleted; missing drawings are
  // recreated from saved data; existing drawings are updated to saved state.
  SS.registerExtractor({
    key:   "sceneDrawingData",
    label: "Scene Drawings (Dungeon)",

    async extract() {
      const result = {};
      for (const scene of game.scenes.contents) {
        if (getSceneMode(scene) !== "dungeon") continue;
        if (!scene.drawings?.size) continue;
        const drawings = {};
        for (const drawing of scene.drawings.values()) {
          drawings[drawing.id] = foundry.utils.deepClone(drawing.toObject());
        }
        result[scene.id] = drawings;
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      await Promise.all(
        Object.entries(data).map(async ([sceneId, drawings]) => {
          const scene = game.scenes.get(sceneId);
          if (!scene) return;
          // Same delete+recreate pattern as sceneTileVisibility — mergeObject
          // semantics on updateEmbeddedDocuments cannot clear absent-default flags.
          const currentIds = [...scene.drawings.values()].map(d => d.id);
          if (currentIds.length) await scene.deleteEmbeddedDocuments("Drawing", currentIds);
          const savedDrawings = Object.values(drawings);
          if (savedDrawings.length) await scene.createEmbeddedDocuments("Drawing", savedDrawings, { keepId: true });
        })
      );
    },
  });

  // ── 11. Scene Token Data ──────────────────────────────────────────────────
  // Full Token document state for Dungeon/Exploration/Camp scenes.
  // On load: tokens added after the save are deleted; missing tokens are
  // recreated; existing tokens are updated to their saved state.  Token
  // visibility (hidden flag) is included in the full toObject() snapshot.
  // Linked actor tokens correctly reflect restored actor data since partyData
  // and npcData run earlier in the apply chain.
  SS.registerExtractor({
    key:   "sceneTokenData",
    label: "Scene Token Data",

    async extract() {
      const result = {};
      for (const scene of game.scenes.contents) {
        if (!TILE_SAVE_MODES.has(getSceneMode(scene))) continue;
        if (!scene.tokens?.size) continue;
        const tokens = {};
        for (const token of scene.tokens.values()) {
          tokens[token.id] = foundry.utils.deepClone(token.toObject());
        }
        result[scene.id] = tokens;
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data) return;
      await Promise.all(
        Object.entries(data).map(async ([sceneId, tokenDataMap]) => {
          const scene = game.scenes.get(sceneId);
          if (!scene) return;

          // Build a snapshot of current tokens keyed by id.
          const currentById = new Map(
            [...scene.tokens.values()].map(t => [t.id, t.toObject()])
          );

          const toDelete = [];
          const toCreate = [];
          const toUpdate = [];

          // Tokens on canvas not in the save → remove.
          for (const id of currentById.keys()) {
            if (!(id in tokenDataMap)) toDelete.push(id);
          }
          // Tokens in save: create if missing, update in-place if changed, skip if equal.
          // In-place update (instead of delete+recreate) avoids the canvas blink where
          // all tokens vanish for a frame before reappearing.
          // Position (x, y, elevation) and visibility (hidden) are part of the saved
          // toObject() snapshot and are restored through this same path.
          for (const [id, saved] of Object.entries(tokenDataMap)) {
            if (!currentById.has(id)) {
              toCreate.push(saved);
            } else if (!foundry.utils.objectsEqual(currentById.get(id), saved)) {
              toUpdate.push(saved); // _id is included in toObject() output
            }
            // identical — no-op
          }

          if (toDelete.length)
            await scene.deleteEmbeddedDocuments("Token", toDelete);
          if (toUpdate.length)
            await scene.updateEmbeddedDocuments("Token", toUpdate);
          if (toCreate.length) {
            try {
              await scene.createEmbeddedDocuments("Token", toCreate, { keepId: true });
            } catch {
              // Batch create failed (e.g. a token's actorId no longer exists);
              // retry individually so as many tokens as possible are restored.
              await Promise.allSettled(
                toCreate.map(td =>
                  scene.createEmbeddedDocuments("Token", [td], { keepId: true }).catch(() => {})
                )
              );
            }
          }
        })
      );
    },
  });

  // ── 12. Camp State ────────────────────────────────────────────────────────
  // Captures all CampSystem world settings (phase, selections, bonds, etc.)
  SS.registerExtractor({
    key:   "campState",
    label: "Camp State",

    async extract() {
      const CAMP = globalThis.CampSystem;
      if (!CAMP?.SETTING) return null;
      const result = {};
      for (const key of Object.values(CAMP.SETTING)) {
        try { result[key] = game.settings.get(MOD, key); }
        catch { /* not yet registered — skip */ }
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data || !game.user?.isGM) return;
      for (const [key, value] of Object.entries(data)) {
        try { await game.settings.set(MOD, key, value); }
        catch { /* setting may not exist in this world */ }
      }
    },
  });

  // ── 13. Monster Encyclopedia ──────────────────────────────────────────────
  // Saves the study result flags and rendered content for every encyclopedia page.
  SS.registerExtractor({
    key:   "encyclopediaData",
    label: "Monster Encyclopedia",

    async extract() {
      const api   = globalThis.FUCompanion?.api?.encyclopedia;
      const entry = api?.getEntry?.();
      if (!entry?.pages) return null;
      const pages = [];
      for (const page of entry.pages.values()) {
        const encFlag = page.flags?.[MOD]?.encyclopedia;
        if (!encFlag?.actorUuid) continue;
        pages.push({
          actorUuid: encFlag.actorUuid,
          encFlag:   foundry.utils.deepClone(encFlag),
          content:   page.text?.content ?? "",
        });
      }
      return { pages };
    },

    async apply(ctx, data) {
      if (!data || !game.user?.isGM) return;
      const api   = globalThis.FUCompanion?.api?.encyclopedia;
      const entry = api?.getEntry?.();
      if (!entry) return;
      for (const { actorUuid, encFlag, content } of data.pages) {
        const page = [...entry.pages.values()].find(
          p => p.flags?.[MOD]?.encyclopedia?.actorUuid === actorUuid
        );
        if (!page) continue;
        await page.update({
          [`flags.${MOD}.encyclopedia`]: encFlag,
          "text.content": content,
        });
      }
    },
  });

  // ── 14. Journal Ownership ─────────────────────────────────────────────────
  // Journals revealed in session A should remain hidden when loading session B.
  SS.registerExtractor({
    key:   "journalOwnership",
    label: "Journal Ownership",

    async extract() {
      const result = {};
      for (const entry of game.journal.contents) {
        result[entry.id] = foundry.utils.deepClone(entry.ownership ?? {});
      }
      return result;
    },

    async apply(ctx, data) {
      if (!data || !game.user?.isGM) return;
      await Promise.all(
        Object.entries(data).map(async ([id, ownership]) => {
          const entry = game.journal.get(id);
          if (!entry) return null;
          // Build explicit "-=" deletions for userIds present in the current
          // ownership but absent from the save. Without this, mergeObject would
          // leave stale users (e.g. a journal revealed after the save was taken)
          // with their post-save ownership level intact after loading.
          const stale = {};
          for (const userId of Object.keys(entry.ownership ?? {})) {
            if (!(userId in ownership)) stale[`ownership.-=${userId}`] = true;
          }
          if (Object.keys(stale).length) await entry.update(stale);
          if (JSON.stringify(entry.ownership) === JSON.stringify(ownership)) return null;
          return entry.update({ ownership });
        }).filter(Boolean)
      );
    },
  });

  // ── 15. Shop NPC Inventory ────────────────────────────────────────────────
  // Captures the full item list (stock quantities + all props) for every world
  // actor flagged as a shop NPC via system.props.isShop === true.
  // On load: stock quantities are restored from the snapshot, and stock the save
  // does not have is cleared where a world master can put it back. Stock that
  // has diverged from its master is KEPT — see applyActorEmbeds for why several
  // of these eleven shop actors are also characters with authored kits.
  SS.registerExtractor({
    key:   "shopInventoryData",
    label: "Shop NPC Inventory",

    async extract() {
      const npcTemplateId = SS.Storage.getNpcTemplateId();
      const result = {};
      for (const actor of game.actors.contents) {
        if (actor.system?.props?.isShop !== true) continue;
        // npcData (#4) already covers linked NPC template actors — skip to avoid double-apply.
        if (actor.system?.template === npcTemplateId && actor.prototypeToken?.actorLink) continue;
        result[actor.uuid] = {
          name:    actor.name,
          system:  foundry.utils.deepClone(actor.system  ?? {}),
          flags:   foundry.utils.deepClone(actor.flags   ?? {}),
          items:   (actor._source?.items   ?? []).map(d => foundry.utils.deepClone(d)),
          effects: (actor._source?.effects ?? []).map(d => foundry.utils.deepClone(d)),
        };
      }
      return Object.keys(result).length ? result : null;
    },

    async apply(ctx, data) {
      if (!data) return;
      for (const [uuid, actorData] of Object.entries(data)) {
        const actor = actorFromUuid(uuid);
        if (!actor) { console.warn(TAG, "shopInventoryData apply: not found", uuid); continue; }
        await wipeStaleCsbListEntries(actor, actorData.system?.props);
        await actor.update({ system: actorData.system, flags: actorData.flags });
        await applyActorEmbeds(actor, actorData);
      }
    },
  });

  console.debug(TAG, "Extractors registered:", SS._extractors.map(e => e.key).join(", "));
})();
