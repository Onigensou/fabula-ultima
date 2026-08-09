// ============================================================================
// [TreasureRoulette] Flow • Foundry VTT v12
// ----------------------------------------------------------------------------
// The ONE orchestrator for a loot tile, start to finish. Runs on the primary GM
// and is AWAITED by the Dungeon Pathing controller, so the dungeon turn stays
// blocked until the whole reward sequence has played out:
//
//   1. resolve tile type -> RollTable + read the party's auto-route option
//   2. Core.request({ award.mode: "deferred" })   -> winner locked, spin broadcast
//   3. clear the tile through DP's own TileState   (reward is already committed)
//   4. await Net.waitBarrier(packet)               -> every client finished the spin
//   5. RecipientUI  -> who gets it   (skipped when auto-route is ON)
//   6. AwardDispatcher.award()       -> grants, returns the granted instance uuid
//   7. EquipUI      -> equip now?    (equippable + a real party member only)
//   8. applyEquipmentSwap()
//   9. TR:COMPLETED
//
// AUTHORITY
// - Only the primary GM runs this (two GM clients are normal in a real session;
//   an ungated run rolls and awards twice).
// - Only the Movement Control MAIN CONTROLLER (or any GM) can touch the screens.
//   Everyone else gets the same overlay in spectator state. The GM holds a
//   first-response-wins lock per screen so a GM click and a controller click
//   can't both resolve it.
//
// FAILURE POLICY
// The tile is consumed at step 3, so from that point on the party MUST end up
// with the reward. Every await has a timeout and a safe default, and the finally
// block grants to Party Inventory if the flow died before awarding.
// ============================================================================

(() => {
  const KEY = "oni.TreasureRoulette.Flow";
  if (window[KEY]) {
    console.warn(`[TreasureRoulette][Flow] Already installed as window["${KEY}"].`);
    return;
  }

  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_CHANNEL = `module.${MODULE_ID}`;
  const TAG = "[TreasureRoulette][Flow]";

  // Screens are broadcast so spectators see the decision happen.
  const MSG_SHOW  = "ONI_TRF_SHOW";   // GM     -> all    { screen, requestId, payload, controllerUserId }
  const MSG_PICK  = "ONI_TRF_PICK";   // client -> GM     { screen, requestId, choice, userId }
  const MSG_CLOSE = "ONI_TRF_CLOSE";  // GM     -> all    { screen, requestId }

  // Screen budgets. On timeout we take the safe default rather than stall the turn.
  const RECIPIENT_TIMEOUT_MS = 60000;
  const EQUIP_TIMEOUT_MS     = 45000;

  const DEFAULT_POOL_SIZE = 8;
  const DEFAULT_SPIN_MS   = 6000;

  // Party option (Main Party actor, CSB select ON/OFF). ON = send everything
  // straight to Party Inventory and show no screens.
  const OPT_AUTO_ROUTE = "option_lootAutoRoute";

  // DP tile type key -> roulette config. lootKey indexes the scene's dungeon
  // config: flags.<MODULE_ID>.oniDungeon.loot.<lootKey>
  const DP_TYPE_CONFIG = Object.freeze({
    treasure:   { rouletteType: "Treasure",    lootKey: "treasure",   label: "Treasure"   },
    gold:       { rouletteType: "Zenit",       lootKey: "zenit",      label: "Zenit"      },
    weapon:     { rouletteType: "Weapon",      lootKey: "weapon",     label: "Weapon"     },
    armor:      { rouletteType: "Armor",       lootKey: "armor",      label: "Armor"      },
    accessory:  { rouletteType: "Accessories", lootKey: "accessory",  label: "Accessory"  },
    consumable: { rouletteType: "Consumable",  lootKey: "consumable", label: "Consumable" },
    item:       { rouletteType: "IP",          lootKey: "item",       label: "Item (IP)"  },
  });

  // Which slots an item type can occupy. Shields are off-hand only here — the
  // Dual Shieldbearer main-hand exception is a combat-card concern and would
  // just add a dead option to a loot prompt.
  const SLOTS_BY_ITEM_TYPE = Object.freeze({
    weapon:    ["main", "off"],
    shield:    ["off"],
    accessory: ["accessory1", "accessory2"],
    armor:     ["armor"],
  });

  const SLOT_LABELS = Object.freeze({
    main: "Main Hand",
    off: "Off Hand",
    accessory1: "Accessory 1",
    accessory2: "Accessory 2",
    armor: "Armor",
  });

  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? false;

  // Tiles with a flow in progress (GM-side re-entry guard).
  const _busy = new Set();

  // Open screens awaiting a decision: `${requestId}:${screen}` -> finish(choice, reason)
  const _pending = new Map();

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------
  const emit = (type, payload) => {
    try { game.socket?.emit(SOCKET_CHANNEL, { type, payload }); }
    catch (e) { warn("socket emit failed:", type, e); }
  };

  const readDungeonData = (scene) => {
    try {
      const mod = scene?.flags?.[MODULE_ID]?.oniDungeon;
      if (mod && typeof mod === "object" && Object.keys(mod).length) return mod;
      const world = scene?.flags?.world?.oniDungeon;
      if (world && typeof world === "object" && Object.keys(world).length) return world;
      const legacy = scene?.flags?.oniDungeon;
      if (legacy && typeof legacy === "object" && Object.keys(legacy).length) return legacy;
    } catch {}
    return {};
  };

  function getLootTableUuid(dpTypeKey, scene) {
    const cfg = DP_TYPE_CONFIG[dpTypeKey];
    if (!cfg) return "";
    const uuid = readDungeonData(scene)?.loot?.[cfg.lootKey];
    return (typeof uuid === "string" && uuid.trim()) ? uuid.trim() : "";
  }

  async function getDb() {
    try {
      const api = window.FUCompanion?.api;
      if (!api?.getCurrentGameDb) return { db: null, dbUuid: null };
      const { db, dbUuid } = await api.getCurrentGameDb();
      return { db: db ?? null, dbUuid: dbUuid ?? db?.uuid ?? null };
    } catch (e) {
      warn("getCurrentGameDb failed:", e);
      return { db: null, dbUuid: null };
    }
  }

  // ON/OFF CSB select -> boolean. Mirrors defeat-reactor's parseDbOption.
  function optionIsOn(raw) {
    if (raw === true) return true;
    const s = String(raw ?? "").trim().toLowerCase();
    return s === "on" || s === "true" || s === "1" || s === "yes";
  }

  async function readAutoRouteOption(db) {
    const props = db?.system?.props ?? db?.system?.actor?.props ?? {};
    return optionIsOn(props[OPT_AUTO_ROUTE]);
  }

  async function resolvePartyMembers(db) {
    const props = db?.system?.props ?? {};
    const out = [];
    for (let i = 1; i <= 4; i++) {
      const rawId = String(props[`member_id_${i}`] ?? "").trim();
      if (!rawId) continue;
      let actor = null;
      try {
        actor = /^Actor\./i.test(rawId)
          ? await fromUuid(rawId)
          : (game.actors.get(rawId) ?? await fromUuid(`Actor.${rawId}`).catch(() => null));
      } catch {}
      if (actor) out.push(actor);
    }
    return out;
  }

  function portraitOf(actor) {
    const std = String(actor?.system?.props?.sprite_standard ?? "").trim();
    const proto = String(actor?.prototypeToken?.texture?.src ?? "").trim();
    return std || proto || actor?.img || "icons/svg/mystery-man.svg";
  }

  function ipOf(actor) {
    const p = actor?.system?.actor?.props ?? actor?.system?.props ?? {};
    const cur = Number(p.current_ip ?? 0) || 0;
    const max = Number(p.max_ip ?? 0) || 0;
    return { cur, max };
  }

  // The Movement Control main controller — the only player allowed to drive the
  // screens. GMs are always eligible on top of this.
  function resolveControllerUserId(explicit) {
    if (explicit) return explicit;
    try {
      const api = globalThis.__ONI_MOVEMENT_CONTROL_API__
        ?? globalThis.FUCompanion?.api?.MovementControl
        ?? null;
      return api?.getLastSnapshot?.()?.resolvedController?.userId ?? null;
    } catch { return null; }
  }

  // --------------------------------------------------------------------------
  // Gear description — shares BD's builders so the comparison window and the
  // Equipment card describe an item identically.
  // --------------------------------------------------------------------------
  let _equipModPromise = null;
  function equipMod() {
    _equipModPromise ??= import(
      `/modules/${MODULE_ID}/scripts/battle-director/equipment-swap.js`
    ).catch((e) => {
      warn("equipment-swap import failed — equip step will be skipped:", e);
      return null;
    });
    return _equipModPromise;
  }

  async function describeGear(item) {
    if (!item) return null;
    const mod = await equipMod();
    if (!mod) return null;
    const type = String(item?.system?.props?.item_type ?? "").trim().toLowerCase();
    try {
      if (type === "accessory") return mod.buildAccCandidate(item);
      if (type === "armor")     return mod.buildArmorCandidate(item);
      return mod.buildHandCandidate(item);   // weapon + shield
    } catch (e) {
      warn("describeGear failed:", e);
      return null;
    }
  }

  function itemTypeOf(item) {
    return String(item?.system?.props?.item_type ?? "").trim().toLowerCase();
  }

  function isEquippable(item) {
    return Object.prototype.hasOwnProperty.call(SLOTS_BY_ITEM_TYPE, itemTypeOf(item));
  }

  // Build the equip screen payload: the incoming item plus what currently sits in
  // each slot it could occupy. Slot preference is "first empty, else slot 1".
  async function buildEquipPayload(actor, templateItem) {
    const mod = await equipMod();
    if (!mod?.gatherEquipmentSlots) return null;

    const type = itemTypeOf(templateItem);
    const slotKeys = SLOTS_BY_ITEM_TYPE[type] ?? [];
    if (!slotKeys.length) return null;

    let gathered;
    try {
      gathered = mod.gatherEquipmentSlots(actor, { includeArmor: true });
    } catch (e) {
      warn("gatherEquipmentSlots failed:", e);
      return null;
    }

    const slots = [];
    for (const key of slotKeys) {
      const slot = (gathered?.slots ?? []).find((s) => s.key === key) ?? null;
      const currentId = slot?.currentItemId ?? null;
      const current = currentId
        ? (slot.candidates ?? []).find((c) => c.id === currentId) ?? null
        : null;

      // Legality travels WITH the slot so the screen can disable it and say why.
      // canEquip is the shared predicate (martial proficiency from classes, hand
      // slots, Dual Shieldbearer) — the UI never re-derives those rules.
      let legal = true;
      let reason = null;
      try {
        const verdict = mod.canEquip?.(actor, templateItem, key);
        if (verdict) { legal = verdict.ok !== false; reason = verdict.reason ?? null; }
      } catch (e) {
        warn("canEquip failed; treating slot as legal:", e);
      }

      slots.push({
        key,
        label: SLOT_LABELS[key] ?? key,
        current,                       // null => empty slot, rendered as "(Empty)" / "-"
        occupied: !!current,
        legal,
        reason,
      });
    }

    // Auto-pick: first EMPTY legal slot, else first legal slot, else nothing.
    const preferred =
      slots.find((s) => s.legal && !s.occupied)?.key
      ?? slots.find((s) => s.legal)?.key
      ?? null;

    return {
      actorUuid: actor.uuid,
      actorName: actor.name,
      portrait: portraitOf(actor),
      incoming: await describeGear(templateItem),
      slots,
      preferredSlotKey: preferred,
    };
  }

  // --------------------------------------------------------------------------
  // Screen driver — broadcast, gate input, first-response-wins, timeout default
  // --------------------------------------------------------------------------
  function localUiFor(screen) {
    const ns = globalThis.ONI?.TreasureRoulette ?? {};
    return screen === "recipient" ? ns.RecipientUI : ns.EquipUI;
  }

  /**
   * Show a screen on every client, accept exactly one answer, close everywhere.
   * @returns {Promise<{choice:any, reason:string}>}
   */
  function askScreen({ screen, requestId, payload, controllerUserId, timeoutMs, fallback }) {
    const key = `${requestId}:${screen}`;

    // Spectators name who they're waiting on, so a table watching a frozen
    // screen knows whose turn it is to click.
    const shown = {
      ...payload,
      controllerName: (controllerUserId && game.users?.get?.(controllerUserId)?.name) || null,
    };

    return new Promise((resolve) => {
      let done = false;
      let timer = null;

      const finish = (choice, reason) => {
        if (done) return;                    // first response wins
        done = true;
        _pending.delete(key);
        try { clearTimeout(timer); } catch {}

        emit(MSG_CLOSE, { screen, requestId });
        try { localUiFor(screen)?.hide?.(); } catch {}

        log(`screen "${screen}" resolved by ${reason}:`, choice);
        resolve({ choice: choice ?? fallback, reason });
      };

      _pending.set(key, finish);
      timer = setTimeout(() => finish(fallback, "timeout"), timeoutMs);

      // Spectators + the controller.
      emit(MSG_SHOW, { screen, requestId, payload: shown, controllerUserId });

      // The GM's own copy is always interactive (GM override).
      try {
        const ui = localUiFor(screen);
        if (ui?.show) {
          Promise.resolve(ui.show({ payload: shown, interactive: true, requestId }))
            .then((choice) => { if (choice != null) finish(choice, "gm"); })
            .catch((e) => warn(`local ${screen} UI threw:`, e));
        } else {
          warn(`${screen} UI not installed on this client — falling back to default.`);
          finish(fallback, "ui-missing");
        }
      } catch (e) {
        warn(`local ${screen} UI failed:`, e);
        finish(fallback, "ui-error");
      }
    });
  }

  // --------------------------------------------------------------------------
  // Main flow
  // --------------------------------------------------------------------------
  /**
   * @param {object} opts
   * @param {TileDocument}  opts.tileDoc
   * @param {TokenDocument} opts.tokenDoc
   * @param {Scene}         opts.scene
   * @param {string}        opts.dpTypeKey        DP tile type ("treasure", "weapon", …)
   * @param {string|null}   [opts.controllerUserId] who may drive the screens
   * @returns {Promise<{ok:boolean, reason?:string, requestId?:string}>}
   */
  async function run({ tileDoc, tokenDoc, scene, dpTypeKey, controllerUserId = null } = {}) {
    if (!isPrimaryGM()) return { ok: false, reason: "not-primary-gm" };
    if (!tileDoc || !scene) return { ok: false, reason: "missing-tile-or-scene" };

    const cfg = DP_TYPE_CONFIG[dpTypeKey];
    if (!cfg) return { ok: false, reason: `unknown tile type "${dpTypeKey}"` };

    if (_busy.has(tileDoc.id)) {
      log("flow already running for this tile; ignoring re-entry.");
      return { ok: false, reason: "busy" };
    }
    _busy.add(tileDoc.id);

    const tableUuid = getLootTableUuid(dpTypeKey, scene);
    if (!tableUuid) {
      _busy.delete(tileDoc.id);
      ui.notifications?.warn?.(
        `[TreasureRoulette] No RollTable configured for "${cfg.label}" on this scene (Dungeon Configuration → Loot).`
      );
      return { ok: false, reason: "no-table" };
    }

    const core = window["oni.TreasureRoulette.Core"];
    const net  = window["oni.TreasureRoulette.Net"];
    const dispatcher = window["oni.TreasureRoulette.AwardDispatcher"];
    if (!core?.request || !dispatcher?.award) {
      _busy.delete(tileDoc.id);
      ui.notifications?.error?.("[TreasureRoulette] Core/AwardDispatcher missing.");
      return { ok: false, reason: "core-missing" };
    }

    const decider = resolveControllerUserId(controllerUserId);
    const { db, dbUuid } = await getDb();
    const autoRoute = await readAutoRouteOption(db);

    let packet = null;
    let awarded = false;
    let recipientActorUuid = null;

    try {
      // ── 1-2. Lock the winner and start the spin everywhere ─────────────────
      const res = await core.request({
        tableUuid,
        rouletteType: cfg.rouletteType,
        pool: { poolSize: DEFAULT_POOL_SIZE },
        ui: { spinMs: DEFAULT_SPIN_MS },
        authorityMode: "gmOnly",
        visibility: "all",
        award: { mode: "deferred" },
        roller: { userId: decider ?? game.user?.id, actorUuid: null },
        meta: {
          source: "TR.Flow",
          tileUuid: tileDoc.uuid,
          tileId: tileDoc.id,
          sceneId: scene.id,
          tileType: dpTypeKey,
        },
      });

      if (!res?.ok || !res.packet) {
        warn("Core.request rejected:", res);
        return { ok: false, reason: "core-rejected" };
      }
      packet = res.packet;

      // ── 3. Consume the tile. The winner is already locked, so a crash from
      //       here on must not hand out a second, better roll. ───────────────
      await DP_clearTile(scene, tileDoc.id);

      // ── 4. Wait for every client to finish the spin + reveal ───────────────
      if (net?.waitBarrier) {
        await net.waitBarrier(packet).catch((e) => warn("waitBarrier failed:", e));
      } else {
        warn("Net not installed — awarding without the animation barrier.");
      }

      // ── 5. Who gets it ────────────────────────────────────────────────────
      const kind = String(packet?.reward?.kind ?? "").toLowerCase();
      const isIp = kind === "itempoint";

      const members = await resolvePartyMembers(db);

      if (autoRoute && !isIp) {
        recipientActorUuid = dbUuid;
        log("auto-route ON — sending straight to Party Inventory.");
      } else if (!members.length && !isIp) {
        recipientActorUuid = dbUuid;
        warn("no party members resolved — defaulting to Party Inventory.");
      } else {
        const fallbackUuid = isIp ? (members[0]?.uuid ?? null) : dbUuid;

        // Auto-route can't apply to IP (it cannot live on the DB actor), so an
        // IP reward still prompts even when the option is ON.
        const { choice } = await askScreen({
          screen: "recipient",
          requestId: packet.requestId,
          controllerUserId: decider,
          timeoutMs: RECIPIENT_TIMEOUT_MS,
          fallback: { kind: isIp ? "member" : "party", actorUuid: fallbackUuid },
          payload: {
            title: cfg.label,
            reward: {
              name: packet?.winner?.name ?? "Reward",
              img: packet?.winner?.img ?? "icons/svg/chest.svg",
              kind,
            },
            // IP can never be stored on the Party Inventory actor (game rule).
            allowParty: !isIp,
            partyInventory: dbUuid ? { actorUuid: dbUuid, name: db?.name ?? "Party Inventory" } : null,
            members: members.map((m) => ({
              actorUuid: m.uuid,
              name: m.name,
              portrait: portraitOf(m),
              ip: ipOf(m),
            })),
          },
        });

        recipientActorUuid = choice?.actorUuid ?? fallbackUuid;
      }

      // ── 6. Grant ──────────────────────────────────────────────────────────
      const awardRes = await dispatcher.award({
        packet,
        recipientActorUuid,
        postChat: true,
        showTransferCard: false,
      });
      awarded = !!awardRes?.ok;

      if (!awarded) {
        warn("award() failed:", awardRes?.reason);
        return { ok: false, reason: awardRes?.reason ?? "award-failed", requestId: packet.requestId };
      }

      // ── 7-8. Equip now? ───────────────────────────────────────────────────
      const isPartyInventory = !!(dbUuid && recipientActorUuid === dbUuid);
      const grantedUuid = awardRes.receiverItemUuid ?? null;

      if (!autoRoute && !isPartyInventory && grantedUuid) {
        await maybeEquip({
          packet,
          recipientActorUuid,
          grantedUuid,
          decider,
        });
      }

      return { ok: true, requestId: packet.requestId };

    } catch (e) {
      console.error(TAG, "flow threw:", e);
      return { ok: false, reason: String(e?.message ?? e) };

    } finally {
      // The tile is already consumed. If we died before granting, the party still
      // gets the reward — into Party Inventory, which is always a legal target
      // for everything except IP.
      if (packet && !awarded) {
        try {
          const fallbackUuid = recipientActorUuid ?? dbUuid;
          if (fallbackUuid) {
            warn("flow ended without awarding — granting to fallback recipient.");
            await dispatcher.award({
              packet,
              recipientActorUuid: fallbackUuid,
              postChat: true,
              showTransferCard: false,
            });
          }
        } catch (e) {
          console.error(TAG, "fallback award failed — reward LOST:", e, packet);
        }
      }

      // Make sure nothing is left on screen if we bailed mid-screen.
      for (const screen of ["recipient", "equip"]) {
        const k = packet ? `${packet.requestId}:${screen}` : null;
        if (k && _pending.has(k)) {
          try { _pending.get(k)(null, "flow-ended"); } catch {}
        }
      }

      _busy.delete(tileDoc.id);

      if (packet) {
        for (const hook of ["TR:COMPLETED", "oni.TR:COMPLETED"]) {
          try { Hooks.callAll(hook, { requestId: packet.requestId, packet, reason: "flow" }); }
          catch (e) { warn(`Hooks.callAll(${hook}) failed:`, e); }
        }
      }
    }
  }

  // Clear through DP's own state machine so `tileStates.currentType` becomes
  // BLANK. The old roulette path only swapped the texture, which left DP still
  // believing the tile was a loot tile (stale-tileState class of bug).
  async function DP_clearTile(scene, tileId) {
    const DP = globalThis.DungeonPathing;
    try {
      if (DP?.TileState?.clearTile) {
        await DP.TileState.clearTile(scene, tileId);
      } else {
        warn("DP.TileState.clearTile unavailable — tile not cleared.");
      }
    } catch (e) {
      warn("clearTile failed:", e);
    }

    // Keep the smoke puff + door sound the tile has always played when consumed.
    try {
      window["oni.TreasureRoulette.TileFrontEnd"]?.playClearFx?.(scene?.id, tileId);
    } catch (e) {
      warn("clear FX failed:", e);
    }
  }

  // --------------------------------------------------------------------------
  // Equip step
  // --------------------------------------------------------------------------
  async function maybeEquip({ packet, recipientActorUuid, grantedUuid, decider }) {
    let actor = null;
    let granted = null;
    try {
      actor = await fromUuid(recipientActorUuid);
      granted = await fromUuid(grantedUuid);
    } catch {}
    if (!actor || !granted) return;

    if (!isEquippable(granted)) return;    // consumables/materials stop at one screen

    const payload = await buildEquipPayload(actor, granted);
    if (!payload) return;

    const { choice } = await askScreen({
      screen: "equip",
      requestId: packet.requestId,
      controllerUserId: decider,
      timeoutMs: EQUIP_TIMEOUT_MS,
      fallback: { equip: false, slotKey: payload.preferredSlotKey },   // default is No
      payload,
    });

    if (!choice?.equip) return;

    const slotKey = choice.slotKey ?? payload.preferredSlotKey;
    if (!slotKey) return;

    const mod = await equipMod();
    if (!mod?.applyEquipmentSwap) {
      warn("applyEquipmentSwap unavailable — equip skipped.");
      return;
    }

    // applyEquipmentSwap reads `selections` as the COMPLETE desired loadout —
    // any slot it doesn't find an id for is treated as "nothing equipped". BD's
    // Equipment card always submits all four slots, so submitting only the
    // target slot silently STRIPS the others (measured: equipping a main-hand
    // weapon cleared Keren's off-hand shield). Send the current loadout with
    // just the one slot overridden.
    const selections = {};
    for (const s of payload.slots ?? []) selections[s.key] = s.current?.id ?? null;
    try {
      const gathered = mod.gatherEquipmentSlots(actor, { includeArmor: true });
      for (const s of gathered?.slots ?? []) {
        if (!(s.key in selections)) selections[s.key] = s.currentItemId ?? null;
      }
    } catch (e) {
      warn("could not read current loadout; equipping conservatively:", e);
    }
    selections[slotKey] = granted.id;

    try {
      await mod.applyEquipmentSwap(actor, selections, { allowArmor: true });
      log(`equipped ${granted.name} to ${actor.name} (${slotKey}).`, selections);
    } catch (e) {
      warn("applyEquipmentSwap failed:", e);
      ui.notifications?.warn?.(`[TreasureRoulette] Could not equip ${granted.name}.`);
    }
  }

  // --------------------------------------------------------------------------
  // Socket
  // --------------------------------------------------------------------------
  function installSocket() {
    const GUARD = "__ONI_TR_FLOW_SOCKET__";
    if (window[GUARD]) return;
    window[GUARD] = true;

    game.socket.on(SOCKET_CHANNEL, async (msg) => {
      try {
        if (!msg?.type) return;

        // ── Everyone: render the screen ────────────────────────────────────
        if (msg.type === MSG_SHOW) {
          const { screen, requestId, payload, controllerUserId } = msg.payload ?? {};
          // The PRIMARY GM already opened its own interactive copy in askScreen().
          // A secondary GM (Co-DM) must still see the screen — and can override,
          // same as the primary.
          if (isPrimaryGM()) return;

          const interactive = !!game.user?.isGM || (!!controllerUserId && game.user?.id === controllerUserId);
          const uiApi = localUiFor(screen);
          if (!uiApi?.show) return;

          const choice = await Promise.resolve(
            uiApi.show({ payload, interactive, requestId })
          ).catch((e) => { warn(`${screen} UI threw:`, e); return null; });

          if (choice != null && interactive) {
            emit(MSG_PICK, { screen, requestId, choice, userId: game.user?.id });
          }
          return;
        }

        // ── Everyone: dismiss ──────────────────────────────────────────────
        if (msg.type === MSG_CLOSE) {
          const { screen } = msg.payload ?? {};
          try { localUiFor(screen)?.hide?.(); } catch {}
          return;
        }

        // ── Primary GM: accept a decision ──────────────────────────────────
        if (msg.type === MSG_PICK) {
          if (!isPrimaryGM()) return;
          const { screen, requestId, choice, userId } = msg.payload ?? {};

          const finish = _pending.get(`${requestId}:${screen}`);
          if (!finish) return;   // already resolved, or never ours

          // Only the main controller (or a GM) may decide.
          const decider = resolveControllerUserId(null);
          const user = game.users?.get?.(userId) ?? null;
          if (!user?.isGM && userId !== decider) {
            warn(`rejected ${screen} pick from non-controller`, { userId, decider });
            return;
          }

          finish(choice, `client:${user?.name ?? userId}`);
          return;
        }
      } catch (e) {
        console.error(TAG, "socket handler error:", e);
      }
    });

    console.debug(TAG, "socket listener installed.");
  }

  // --------------------------------------------------------------------------
  // Install
  // --------------------------------------------------------------------------
  Hooks.once("ready", () => { installSocket(); });

  const api = {
    run,
    DP_TYPE_CONFIG,
    SLOTS_BY_ITEM_TYPE,
    _debug: { getLootTableUuid, buildEquipPayload, describeGear, _pending, _busy },
  };

  window[KEY] = api;
  globalThis.ONI ??= {};
  globalThis.ONI.TreasureRoulette ??= {};
  globalThis.ONI.TreasureRoulette.Flow = api;

  console.debug(`${TAG} Installed as window["${KEY}"].`);
})();
