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
  // Measured over the four PCs (275 items): 245 resolve to a live master by id
  // AND name, 86 of those are still identical to it (deletable), 159 have
  // diverged, and 30 have no master at all — the bespoke ones (Fugitive
  // Experiment, Starfall Comet, Draconic Roar, Lift off) plus the gear-skill
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
  //   • 154 of the 159 diverged copies differ in VALUES at the same row count in
  //     every authored table. They are kept conservatively, so a load will not
  //     clear debris that was itself customised. That is the direction that
  //     cannot lose work.
  //   • A create (item in the save, absent live) still restores the SAVED copy,
  //     definition included, because there is genuinely nothing live to prefer.
  //     After name re-pairing (below) that is 36 documents on slot 1 and 13 on
  //     slot 2. Of slot 1's 36: 10 still match a master, 21 diverge from one and
  //     5 have none — so 26 are not restorable from one. Slot 2's 13 split
  //     3 / 10 / 0. The diverging ones are mostly Hako's gear,
  //     where the difference is per-instance refinement rather than staleness.
  //     Sourcing these from the master instead would restore a current
  //     definition but drop that refinement, so neither side is plainly right;
  //     the saved copy is kept because it destroys nothing that exists.
  //
  // Deliberately NOT state, though it looks like it: `name`. It differs on 9 of
  // slot 1's items: 5 are refinement prefixes the live world earned after the
  // save ("Full Plate" against a live "+4 Full Plate"), and 4 are wholesale
  // renames (Hina's "PROPHETIC DEFENDER STYLE" -> "Prophetic Defender", three of
  // Geist's Zero Powers). Restoring either would undo authoring. Restoring the
  // saved name would quietly strip the +4; applyActorEmbeds re-points the equip
  // SLOTS at the live name instead. (`refine_count` / `refine_level` differ on 19
  // of slot 1's items — 38 prop-instances, two per item, over all four restored
  // buckets; an earlier 17/34 missed Hako, who is restored via npcData — and in every case the prop is present LIVE and absent
  // from the save, so adding them here would be a no-op under the hasOwnProperty gate
  // below. Refinement itself lives in the name and the stat props.)
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

  // Item FLAGS carry real content in this world — `coreAction`, `weaponForms`,
  // `orbment.slots`, `helperSkill`, `isArcanum`, `setId`, `cookingDish` — so they
  // belong in the signature. The only flags that differ between a restorable copy
  // and its master today are past migrations' `…Backup_v1` blobs, which are
  // bookkeeping about a patch rather than content.
  // Ignored alongside them: Foundry/CSB provenance and editor bookkeeping
  // (`core.sourceId` 169 docs, `custom-system-builder.version` 3965 — i.e. every
  // item — and the template undo history), plus three flags written by PLAY
  // rather than by an author: `hiddenUntilBattleEnd`, `activeForm`,
  // `transformFreeUsedRound`. Unlike the two counts above, those three sit on ONE
  // document each today, so they are pre-emptive rather than measured. The case
  // is that a battle sets `hiddenUntilBattleEnd`, and leaving it in the signature
  // would make an item hidden mid-session read as diverged from its master and so
  // escape the reset. Note that only bites a live-ONLY item — one the snapshot
  // also carries takes rule 1 and keeps its live flags either way.
  const FLAG_IGNORE = new Set([
    "core.sourceId",
    "custom-system-builder.version",
    "custom-system-builder.templateHistory",
    "custom-system-builder.templateHistoryRedo",
    "fabula-ultima-companion.hiddenUntilBattleEnd",
    "fabula-ultima-companion.activeForm",
    "fabula-ultima-companion.transformFreeUsedRound",
  ]);

  const flagSignature = (flags) => {
    const f = JSON.parse(JSON.stringify(flags ?? {}));
    for (const scope of Object.keys(f)) {
      if (!f[scope] || typeof f[scope] !== "object") continue;
      for (const key of Object.keys(f[scope])) {
        if (/Backup/i.test(key) || FLAG_IGNORE.has(`${scope}.${key}`)) delete f[scope][key];
      }
      if (!Object.keys(f[scope]).length) delete f[scope];
    }
    return stableJson(f);
  };

  function masterSignature(o) {
    const p = o?.system?.props ?? {};
    const keys = Object.keys(p).filter(k => !MASTER_SIG_IGNORE.has(k)).sort();
    // stableJson, not JSON.stringify: sorting `keys` orders only the TOP level,
    // and most of these props are objects (effect_table, related_item_list…).
    // The export key-sorts everything so this is invisible offline, but a live
    // `toObject()` does not, and an order-only difference would read as diverged.
    return stableJson([keys.map(k => [k, p[k]]), aeSignature(o?.effects), flagSignature(o?.flags)]);
  }

  // CSB stamps `system.uniqueId` with the originating world Item's id (verified:
  // it equals `_stats.compendiumSource` where both are present, and resolves for
  // 263 of 275 party items by id alone — 245 once the name must match too).
  // `compendiumSource` is the fallback.
  function masterFor(obj) {
    const uid = String(obj?.system?.uniqueId ?? "").trim();
    const src = String(obj?._stats?.compendiumSource ?? "").replace(/^Item\./, "").trim();
    for (const id of [uid, src]) {
      if (!id) continue;
      const byId = game.items.get(id);
      if (byId) return byId;
    }
    if (!uid) return null;
    // The name check belongs in the PREDICATE, not after the scan: 13 items share
    // Amber Pendant's uniqueId, and taking the first hit would surface a
    // wrong-named sibling and discard a correct master that sorts behind it.
    return game.items.find(i =>
      String(i.system?.uniqueId ?? "").trim() === uid && i.name === obj?.name) ?? null;
  }

  // Flip an item's EQUIP-LINKED effects to match its own `isEquipped`. The scope
  // is the whole correctness argument here, and it is wrong in BOTH obvious
  // directions — see isEquipLinked below before changing it.
  //
  // A previous version called the engine's syncItemEffectsToEquip, on the
  // reasoning that a local copy of a primitive is a smell. That helper resolves
  // ALL owned effects when an item declares no `item_activeEffect` refs (no world
  // item does), and an item's non-transfer AEs are not equip bonuses at all —
  // they are TEMPLATES that `apply_ae` clones. `resolveAeTemplate` returns such a
  // template regardless of `disabled`, and the clone path deletes `_id` without
  // resetting `disabled`, so disabling one poisons every future grant.
  //
  // Measured on slot 1: it disabled "Adrenaline Potion"'s own `Adrenaline` AE
  // (transfer:false, carrying the adr_soak reactionConfig that subtracts 15 from
  // incoming damage) and "Invisibility Cloak"'s `Hidden`. A consumable's
  // isEquipped is never true, so nothing ever flips it back — every future
  // potion would grant an inert effect, permanently.
  //
  // The "two passes would disagree" justification for widening was also wrong:
  // armor-equip-gate's ready sweep runs `if (isArmor(item))` only, so it never
  // touches the weapons, shields, accessories and consumables where all the
  // newly-flipped effects live.
  // Positive list of EQUIP-LINKED roles, because neither blanket answer works and
  // no single field proxies for it. Invisibility Cloak and Jetpack are both
  // accessories: the Cloak's `Hidden` is a template that must NOT be flipped, the
  // Jetpack's `Aerial Swiftness` is a carrier that MUST be. So ask what the
  // effect is for:
  //   • transfer:true — an equip bonus; enabled iff worn.
  //   • a `deriveStatus` spec — derived-status-reactor skips a rule whose AE is
  //     `disabled` and whose carrier item is not equipped, so its enabled state
  //     is equip state. Hina's Jetpack grants Swift while flying this way, and it
  //     is transfer:false with no `changes` at all.
  // Anything else is left alone. Over the ACTOR-EMBEDDED items this function can
  // actually reach: 237 effects match the transfer arm, exactly 1 matches the
  // deriveStatus arm (Hina / Jetpack / "Aerial Swiftness"), and 333 are left
  // untouched — mostly apply_ae templates and status containers. (World-wide the
  // same split is 592 / 1 / 543, but 565 of those sit on world items the load
  // never touches.)
  const isEquipLinked = (e) => {
    if (e.transfer === true) return true;
    // The reactor's equip gate is OPT-OUT (`requireEquipped !== false`), and the
    // spec may be an array, so read it rather than testing for its presence: a
    // rule marked `requireEquipped: false` fires while the item is merely held,
    // and disabling its AE would kill it outright (`:47` returns on `disabled`).
    const spec = e.flags?.[MOD]?.deriveStatus;
    if (!spec) return false;
    return (Array.isArray(spec) ? spec : [spec]).some(r => r?.requireEquipped !== false);
  };

  async function syncItemEquipEffects(item) {
    const equipped = item.system?.props?.isEquipped === true;
    const fx = [...item.getEmbeddedCollection("ActiveEffect").values()]
      .filter(e => isEquipLinked(e) && !!e.disabled === equipped)
      .map(e => ({ _id: e.id, disabled: !equipped }));
    if (fx.length) await item.updateEmbeddedDocuments("ActiveEffect", fx);
    return fx.length;
  }

  function restorableFromMaster(obj) {
    const m = masterFor(obj);
    if (!m) return false;
    // `uniqueId` is stamped on create and INHERITED by a duplicate, so it is not
    // per-instance: 13 world items share Amber Pendant's, and 382 embedded items
    // resolve to a master carrying a different NAME. None of those currently
    // also matches by signature, so the id alone has been giving the right
    // answer — by luck, not by construction. Requiring the name too closes it
    // at zero cost — the world-wide restorable count was 333 either way when this
    // was added (332 today; the one flip comes from the flag signature).
    if (m.name !== obj?.name) return false;
    return masterSignature(m.toObject()) === masterSignature(obj);
  }

  // Diff one embedded collection of `owner` (an Actor's Items or ActiveEffects)
  // toward the saved snapshot. Returns a summary for the load-level
  // observability rollup.
  //
  // IMPORTANT (verified live): updateEmbeddedDocuments on an Item MERGES its
  // embedded `effects` (updates by _id, inserts new) but does NOT delete effects
  // absent from the array. An updated Item's effects were therefore reconciled
  // RECURSIVELY here rather than left to the parent update, and `effects` is
  // stripped from the Item body update to keep ownership in one place.
  //
  // ⚠ That recursion has been REMOVED, not just bypassed. It was unreachable
  // (`guarded` is exactly `type === "Item"`), and it was a trap rather than a
  // spare part: it re-entered with `guarded === false`, which would have routed
  // an ITEM's effects through the ACTOR-AE keep rule and deleted any item effect
  // absent from the snapshot — the exact opposite of the invariant below, and it
  // would drop things like "+4 Full Plate"'s Armor DEF / Armor MDEF.
  async function applyEmbedsDiff(owner, type, savedArr = []) {
    const collection = owner.getEmbeddedCollection(type);
    const liveById   = new Map([...collection.values()].map(d => [d.id, d]));
    const savedById  = new Map((savedArr ?? []).map(d => [d._id, d]));

    const toCreate = [], toUpdate = [], toDelete = [], toUnequip = [];
    let skip = 0;
    const nested = { update: 0, create: 0, delete: 0 }; // effect ops on updated items
    const keptUnique = [];

    const guarded = type === "Item";

    // A document deleted and re-created since the save carries a NEW _id, so an
    // id-only diff sees ONE document as a delete plus a create — and the create
    // reintroduces the save's months-old copy in place of the current one. On
    // the real slots this is the dominant create — 15 such documents on slot 1
    // and 14 on slot 2 — and the saved twin is badly stale: Elemental Weapon's
    // snapshot carries no effect_table and no fire point at all, so the swap
    // leaves it inert.
    //
    // Re-pair those by NAME up front, so the pair is treated as what it is — one
    // document present on both sides. It then takes rule 1's path (state only,
    // live definition stands) instead of being deleted and rolled back.
    //
    // Pairing is POSITIONAL, as many as both sides have of that name. Restricting
    // it to the unambiguous 1:1 case looked safer and was not: "left to the id
    // diff" used to mean delete-plus-create, but the diff's delete half is now
    // the guard, which KEEPS the live copy — so both survived and the saved ones
    // were created on top. The save carries two documents named "Heal" for
    // Blanche where the live world has one, and that turned 1 into 3.
    //
    // A pair must at least be the same KIND of thing — matching type and CSB
    // template. That check is load-bearing rather than decorative, because a
    // container and its `_skill` child SHARE A NAME by construction: Zarg's
    // "Skull Orb" is a shell (template ZoiV53Va…) plus a gear-skill child
    // (j0F5Msw5…, the _Skill Template), and the save holds only an older shell.
    // Each saved document therefore takes the first COMPATIBLE live candidate,
    // not the positionally first one — pairing by position tried the child,
    // failed the kind check, and never got to the shell, which left the shell to
    // be re-created and Zarg holding three Skull Orbs.
    //
    // Since a pair only ever transfers state props, a wrong guess between two
    // same-named siblings costs a quantity or an equip flag, never a definition.
    let repaired = 0;
    const renamed = [];   // [saved props.name, live props.name] for matched pairs
    if (guarded) {
      const bucket = (m, k, v) => { (m.get(k) ?? m.set(k, []).get(k)).push(v); return m; };
      const unmatchedLive = new Map(), unmatchedSaved = new Map();
      for (const [id, d] of liveById)  if (!savedById.has(id)) bucket(unmatchedLive, d.name, id);
      for (const [id, d] of savedById) if (!liveById.has(id))  bucket(unmatchedSaved, d.name, id);
      const sameKind = (live, saved) =>
        live.type === saved.type &&
        String(live.system?.template ?? "") === String(saved.system?.template ?? "");
      for (const [name, sIds] of unmatchedSaved) {
        const lIds = unmatchedLive.get(name) ?? [];
        const taken = new Set();
        for (const sid of sIds) {
          const saved = savedById.get(sid);
          if (!saved) continue;
          const lid = lIds.find(x => !taken.has(x) && sameKind(liveById.get(x), saved));
          if (!lid) continue;
          taken.add(lid);
          savedById.delete(sid);
          savedById.set(lid, { ...saved, _id: lid });
          repaired++;
        }
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
        // A unit can span the two sides — a live-only shell holding a child the
        // save keeps. Deleting the shell cascades onto that child, and the
        // update pass would then write to a document that no longer exists,
        // taking the whole load down with it. Neither slot hits this today (0 of
        // 61 and 0 of 14 deletes), but the cost of being wrong is the entire
        // load, so the unit is kept whenever the save wants any member.
        const removable = !unit.some(u => savedById.has(u)) &&
          unit.every(u => restorableFromMaster(objs.get(u)));
        if (removable) { toDelete.push(id); continue; }
        keptUnique.push(live.name ?? id);
        // The save does not carry this document, so the actor was not wearing it
        // at save time. Keeping the DEFINITION is the whole point of the guard;
        // keeping it EQUIPPED is not — equip state is precisely what the save
        // owns. Before this, Hina finished a slot-1 load wearing BOTH the
        // restored "+4 Full Plate" and the kept "The Selfless", whose three
        // enabled transfer AEs (Armor DEF, Armor MDEF, Resistance Bolt) stacked
        // on top of it. That is a regression the guard itself introduced: the
        // old code deleted these documents, so equip state used to land exactly
        // where the snapshot put it. A kept item goes back in the bag, not on.
        if (live.system?.props?.isEquipped === true) toUnequip.push(id);
      }
    } else {
      // Actor-level AEs are mostly session state — statuses, Campfire Cake, Wet,
      // Dance — and clearing them is exactly what the reset use case is for. But
      // an AE carrying `reactionConfig` is an implementation carrier under this
      // project's canon, and unlike an Item there is no world master to restore
      // an actor AE from, so a wrong delete here is both unrecoverable and, until
      // now, unreported: this branch deleted every live-only AE outright.
      //
      // Two of the three keeps come straight from the engine's own contract
      // (`isTransientAE`, skill-effects.js): `crossScene` and `directorPermanent`
      // mark an effect that its sweeps must NEVER remove. An earlier rule here
      // used `reactionConfig && !directorAppliedBy` alone and so ignored them,
      // deleting five opted-out effects on slot 1 — including Keren's "Wet",
      // the aquatic 2-piece SET BONUS carrier (crossScene + directorPermanent).
      // set-bonus-hooks DOES schedule reconcileSetBonuses off our isEquipped
      // writes, so a rebuild is racing rather than absent — on a 100 ms debounce,
      // against a load that also creates 36 and deletes 65 documents. Deleting a
      // marked-permanent carrier and hoping a debounced rebuild wins is not a
      // contract. Also deleted was Hina's "Lucky Number", a
      // reactionConfig carrier with no world master: exactly the unrecoverable
      // case this guard exists for. `directorAppliedBy` alone is NOT the
      // discriminator — it means "the director created it", not "it is
      // disposable", and the author can then mark the result permanent. All FOUR
      // of slot 1's actor AEs carrying it are also directorPermanent.
      //
      // Borrowing `isTransientAE` WHOLESALE does not work either: it is
      // keep-biased by design (a passive AE with no duration, no buff/debuff tag
      // and no director stamp falls through to "keep"), and measured against slot
      // 1 it declines to delete any of the 12, which would leave the reset use
      // case doing nothing at all. So the snapshot stays authoritative and only
      // the explicit opt-outs, plus hand-placed config, are held back: 5 deleted
      // (Campfire Cake x4, Curse (Bad)) and 7 kept.
      //
      // ⚖ Declared divergence: those 5 all satisfy `isRestBound` in
      // shared/ae-lifetime.js — `statuses:["permanent"]` or a numeric
      // `campRestCharges` — which classes them as surviving every tick until a
      // Rest, food buffs named as the case. That module exists because three
      // systems used to answer AE lifetime independently and disagreed, so
      // differing from it needs saying out loud. The reason is RECOVERABILITY,
      // not lifetime — "a load is not a tick" would excuse overriding
      // directorPermanent too, and that one is kept. These five are reproducible
      // session state (all carry BOTH `statuses:["permanent"]` and
      // `campRestCharges: 0`): four Campfire Cakes and a Curse, acquired after
      // the save, belonging to the run being discarded — on a party swap they
      // would be another party's. The opted-out effects are kept because nothing
      // can put them back.
      for (const [id, live] of liveById) {
        if (savedById.has(id)) continue;
        const f = live.flags?.[MOD] ?? {};
        const keep = f.crossScene === true || f.directorPermanent === true ||
          (f.reactionConfig && !f.directorAppliedBy);
        if (keep) { keptUnique.push(live.name ?? id); continue; }
        toDelete.push(id);
      }
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
        // Rule 1 does not restore a name, so a document refined since the save
        // keeps its live one. Record the difference for the equip-slot fixup in
        // applyActorEmbeds — the actor's slot props were restored from the
        // snapshot and still name the OLD string.
        const sName = String(sp.name ?? ""), lName = String(lp.name ?? "");
        if (sName && lName && sName !== lName) renamed.push([sName, lName]);
        // CSB writes item_quantity as a number down some paths and a string down
        // others, so a raw compare queues an update that changes nothing — 4 of
        // them on slot 1, each costing a document write plus a CSB re-render
        // (~360 ms of synchronous block). Compare coerced.
        const sameState = (a, b) => String(a ?? "") === String(b ?? "");
        const stateDiffers = ITEM_STATE_PROPS.some(k =>
          Object.prototype.hasOwnProperty.call(sp, k) && !sameState(lp[k], sp[k]));
        // An equip flag present in the snapshot still needs the AE sync pass even
        // when the flag itself matches, so route those through toUpdate too.
        // Wrong-way test, scoped to the same transfer:true effects the sync
        // touches — widening it is what pulled consumables onto the update path
        // and let their template AEs be disabled.
        const needsEquipSync = Object.prototype.hasOwnProperty.call(sp, "isEquipped") &&
          [...live.getEmbeddedCollection("ActiveEffect").values()]
            .some(e => isEquipLinked(e) && !!e.disabled === (sp.isEquipped === true));
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
        // Reached only for ActiveEffects — `guarded` IS `type === "Item"`, so an
        // Item never gets here and needs no effects/items strip; the guarded
        // branch above returns a state-only object instead.
        const c = { ...d };
        delete c._stats;                              // Foundry owns these timestamps
        return c;
      });
      await owner.updateEmbeddedDocuments(type, updates);

      // Reconcile each updated Item's embedded effects (the merge-not-replace fix).
      if (type === "Item") {
        for (const saved of toUpdate) {
          const item = owner.getEmbeddedCollection("Item").get(saved._id);
          if (!item) continue;
          // An Item's AEs are part of its DEFINITION (a transfer:true gear AE, a
          // reactionConfig bridge), so they are never created or deleted from a
          // snapshot. But `disabled` carries the EQUIP toggle, and the update
          // above restores `isEquipped` — so sync the two, or the load leaves
          // worn gear inert. Reads the item's LIVE isEquipped (just written), so
          // an AE absent from an old snapshot is still switched on correctly.
          //
          // ⚠ For item_type "armor" this is NOT the only writer. Writing
          // `isEquipped` fires armor-equip-gate's ambient updateItem hook, which
          // calls the engine's syncItemEffectsToEquip — the BROAD all-owned-
          // effects scope that isEquipLinked exists to avoid — and the load does
          // not wrap its writes in withManagedEquip, so the hook does not stand
          // down. Inert today (no armor in the corpus carries a transfer:false
          // AE) but it means the narrow scope is not guaranteed on that path;
          // one authored armor template AE would expose it.
          if (!Object.prototype.hasOwnProperty.call(saved.system?.props ?? {}, "isEquipped")) continue;
          nested.update += await syncItemEquipEffects(item);
        }
      }
    }

    // Kept-but-not-in-the-save documents are unequipped, and their effects
    // switched off with them — the same primitive the equip sync above uses,
    // called after the flag is written because it reads the item's own state.
    if (toUnequip.length) {
      await owner.updateEmbeddedDocuments("Item",
        toUnequip.map(id => ({ _id: id, system: { props: { isEquipped: false } } })));
      for (const id of toUnequip) {
        const item = owner.getEmbeddedCollection("Item").get(id);
        if (item) nested.update += await syncItemEquipEffects(item);
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
      keptUnique: keptUnique.length, unequipped: toUnequip.length, renamed,
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
  // real slots, the opt-out deleted 27 (slot 1) and 33 (slot 2) live-only
  // documents unconditionally — including 12 and 7 `_skill` children whose
  // container shell SURVIVED, leaving orphaned gear, and Willy's authored
  // "Lens of Insight (Passive)".
  //
  // Under the guard those shops instead keep 23 and 21 documents that diverge
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
    const record = { actor: actor.name, ms, item, effect, slotsRepointed: 0 };
    (SS._diffReport ??= []).push(record);
    if (item.keptUnique) {
      console.log(`${TAG} ${actor.name}: kept ${item.keptUnique} unique document(s) the save predates` +
        ` (no world master, or diverged from it): ` +
        item.keptNames.slice(0, 12).join(", ") +
        (item.keptNames.length > 12 ? ` … +${item.keptNames.length - 12} more` : ""));
    }
    // The actor's slot props (main_hand / off_hand / accessory_name /
    // accessory2_name) say what is WORN, and resolve by the item's
    // `system.props.name` string — indexByEquippedName in equipment-swap.js.
    // Those props were just restored wholesale from the snapshot, while rule 1
    // deliberately does NOT restore an item's name: renaming a live "+4 Titanic
    // Shield" back to the snapshot's "Titanic Shield" would strip the
    // refinement. The two then disagree exactly where a refinement happened
    // after the save, and the slot resolves to nothing — on slot 1 that empties
    // Blanche's and Zarg's MAIN HAND, taking resolveAttackerWeapon, the sheet's
    // hand slots and the HAS_RANGED_WEAPON / HAS_MARTIAL_ARMOR gate family with
    // it. So carry the rename across to the SLOTS instead of into the item.
    if (item.renamed?.length) {
      // Keyed on the SAVED props.name, which is not guaranteed unique on one
      // actor — EXFURSION Party carries three "Ring of the Pupil", Hina two
      // "Arch Ice Wand". No slot collides on either real slot, but a plain Map
      // would be last-write-wins, so refining one of a duplicated pair after a
      // save could re-point the slot at the wrong twin. Ambiguous names are
      // dropped instead of guessed.
      const map = new Map();
      const ambiguous = new Set();
      for (const [from, to] of item.renamed) {
        if (map.has(from) && map.get(from) !== to) ambiguous.add(from);
        map.set(from, to);
      }
      for (const k of ambiguous) map.delete(k);
      const props = actor.system?.props ?? {};
      const fix   = {};
      // `armor_name` is display-only (the CSB sheet's armor rollMessage reads it)
      // where the other four drive indexByEquippedName, but it goes stale the
      // same way — on slot 1 Hina, Keren and Zarg all end with one naming an item
      // that no longer exists.
      for (const slot of ["main_hand", "off_hand", "accessory_name", "accessory2_name", "armor_name"]) {
        const cur = props[slot];
        if (cur && map.has(cur)) fix[`system.props.${slot}`] = map.get(cur);
      }
      if (Object.keys(fix).length) {
        await actor.update(fix);
        record.slotsRepointed = Object.keys(fix).length;
        console.log(`${TAG} ${actor.name}: re-pointed ${Object.keys(fix).length} equip slot(s) at renamed items — ` +
          Object.entries(fix).map(([k, v]) => `${k.split(".").pop()} = "${v}"`).join(", "));
      }
    }
    if (effect.keptUnique) {
      console.log(`${TAG} ${actor.name}: kept ${effect.keptUnique} effect(s) the snapshot does not carry ` +
        `(crossScene / directorPermanent / hand-placed config): ${effect.keptNames.join(", ")}`);
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
