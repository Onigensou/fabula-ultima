/**
 * ActiveEffect Charges API — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * Generic charge tracking for spells/skills that grant a fixed-use ability via
 * an Active Effect. Authors mark an AE with three flags; consumers query and
 * decrement charges through this API instead of duplicating the logic.
 *
 * Storage convention (on each ActiveEffect):
 *   flags.fabula-ultima-companion.charges      Number   current charges (>0 = usable)
 *   flags.fabula-ultima-companion.chargesMax   Number?  optional initial count, display only
 *   flags.fabula-ultima-companion.chargeKey    String?  optional feature id, e.g. "divination"
 *
 * Why a chargeKey: a character can hold several charged AEs at once
 * (Divination + Lucky Seven + ...). Consumers pass `key: "divination"` to
 * narrow queries and avoid consuming the wrong charge. If you omit the key
 * everywhere — both on the AE and on queries — you still get a usable
 * "any charged AE" interface.
 *
 * Public API: globalThis.FUCompanion.api.charges
 *   read(effect)
 *   findOnActor(actor, { key?, includeDisabled? })
 *   findOwned({ key? })
 *   findFirstOwned({ key? })
 *   consume(effect, { count = 1, deleteWhenEmpty = true })
 *   set(effect, n, { deleteWhenEmpty = true })
 *
 * All write paths are ownership-aware: if the caller can update the actor
 * directly, we do; otherwise we route through GMExecutor.
 */
(() => {
  const TAG = "[ONI][AECharges]";
  const MODULE_ID = "fabula-ultima-companion";
  const FLAG_CHARGES = "charges";
  const FLAG_MAX     = "chargesMax";
  const FLAG_KEY     = "chargeKey";

  if (globalThis.FUCompanion?.api?.charges) {
    console.log(`${TAG} Already installed.`);
    return;
  }

  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function safeInt(v, fb = 0) {
    if (typeof v === "number") return Number.isFinite(v) ? v : fb;
    const n = parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : fb;
  }

  function safeStr(v, fb = "") {
    if (v === null || v === undefined) return fb;
    const s = String(v).trim();
    return s.length ? s : fb;
  }

  function getFlag(effect, key) {
    if (!effect) return undefined;
    try {
      if (typeof effect.getFlag === "function") return effect.getFlag(MODULE_ID, key);
    } catch (_) {}
    return effect?.flags?.[MODULE_ID]?.[key];
  }

  function actorIsOwnedByMe(actor) {
    try { return !!actor?.isOwner; } catch (_) { return false; }
  }

  function effectIsLive(effect) {
    if (!effect) return false;
    if (effect.disabled) return false;
    if (effect.isSuppressed) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------
  function read(effect) {
    if (!effect) return null;
    const rawCharges = getFlag(effect, FLAG_CHARGES);
    if (rawCharges === undefined || rawCharges === null) return null;
    const charges = safeInt(rawCharges, 0);
    const max = safeInt(getFlag(effect, FLAG_MAX), 0) || null;
    const key = safeStr(getFlag(effect, FLAG_KEY), "") || null;
    return { charges, max, key };
  }

  function matchesKey(entry, wantedKey) {
    if (!wantedKey) return true;
    return entry.key === wantedKey;
  }

  // ---------------------------------------------------------------------------
  // Find
  // ---------------------------------------------------------------------------
  function findOnActor(actor, { key = null, includeDisabled = false } = {}) {
    const out = [];
    if (!actor) return out;
    const effects = actor.effects?.contents ?? actor.effects ?? [];
    for (const eff of effects) {
      if (!eff) continue;
      if (!includeDisabled && !effectIsLive(eff)) continue;
      const info = read(eff);
      if (!info) continue;
      if (info.charges <= 0) continue;
      if (!matchesKey(info, key)) continue;
      out.push({ effect: eff, ...info });
    }
    return out;
  }

  function findOwned({ key = null } = {}) {
    const actors = game.actors?.contents ?? Array.from(game.actors ?? []);
    const out = [];
    for (const actor of actors) {
      if (!actor) continue;
      if (!actorIsOwnedByMe(actor)) continue;
      const hits = findOnActor(actor, { key });
      for (const hit of hits) out.push({ actor, ...hit });
    }
    return out;
  }

  function findFirstOwned({ key = null } = {}) {
    const actors = game.actors?.contents ?? Array.from(game.actors ?? []);
    for (const actor of actors) {
      if (!actor) continue;
      if (!actorIsOwnedByMe(actor)) continue;
      const hits = findOnActor(actor, { key });
      if (hits.length) return { actor, ...hits[0] };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Write (ownership-aware)
  // ---------------------------------------------------------------------------
  async function gmUpdateEffect(effect, change) {
    const gmExec = globalThis?.FUCompanion?.api?.GMExecutor;
    if (!gmExec?.executeSnippet) {
      throw new Error("GMExecutor unavailable for cross-permission AE write.");
    }
    const scriptText = `
      const eff = await fromUuid(payload.effectUuid);
      if (!eff) return { ok: false, reason: "effect_not_found" };
      await eff.update(payload.change);
      return { ok: true };
    `;
    const res = await gmExec.executeSnippet({
      scriptText,
      payload: { effectUuid: effect.uuid, change }
    });
    if (!res?.ok) throw new Error(`GMExecutor refused AE update: ${safeStr(res?.reason, "unknown")}`);
  }

  async function gmDeleteEffect(effect) {
    const gmExec = globalThis?.FUCompanion?.api?.GMExecutor;
    if (!gmExec?.executeSnippet) {
      throw new Error("GMExecutor unavailable for cross-permission AE delete.");
    }
    const scriptText = `
      const eff = await fromUuid(payload.effectUuid);
      if (!eff) return { ok: false, reason: "effect_not_found" };
      await eff.delete();
      return { ok: true };
    `;
    const res = await gmExec.executeSnippet({
      scriptText,
      payload: { effectUuid: effect.uuid }
    });
    if (!res?.ok) throw new Error(`GMExecutor refused AE delete: ${safeStr(res?.reason, "unknown")}`);
  }

  async function updateEffect(effect, change) {
    const ownsActor = actorIsOwnedByMe(effect?.parent);
    if (ownsActor) return await effect.update(change);
    return await gmUpdateEffect(effect, change);
  }

  async function deleteEffect(effect) {
    const ownsActor = actorIsOwnedByMe(effect?.parent);
    if (ownsActor) {
      try { return await effect.delete(); }
      catch (e) {
        warn("effect.delete failed despite owner; falling back to disable.", e);
        return await effect.update({ disabled: true });
      }
    }
    return await gmDeleteEffect(effect);
  }

  async function set(effect, nextValue, { deleteWhenEmpty = true } = {}) {
    const info = read(effect);
    const before = info?.charges ?? 0;
    const next = Math.max(0, safeInt(nextValue, 0));

    if (next <= 0 && deleteWhenEmpty) {
      try {
        await deleteEffect(effect);
        return { ok: true, before, after: 0, deleted: true };
      } catch (e) {
        warn("deleteEffect failed; disabling instead.", e);
        try { await updateEffect(effect, { disabled: true }); }
        catch (_) {}
        return { ok: false, before, after: 0, deleted: false, error: String(e?.message ?? e) };
      }
    }

    try {
      await updateEffect(effect, { [`flags.${MODULE_ID}.${FLAG_CHARGES}`]: next });
      return { ok: true, before, after: next, deleted: false };
    } catch (e) {
      return { ok: false, before, after: before, deleted: false, error: String(e?.message ?? e) };
    }
  }

  async function consume(effect, { count = 1, deleteWhenEmpty = true } = {}) {
    const info = read(effect);
    if (!info) return { ok: false, before: 0, after: 0, deleted: false, error: "not_a_charged_effect" };
    const want = Math.max(1, safeInt(count, 1));
    const next = Math.max(0, info.charges - want);
    return await set(effect, next, { deleteWhenEmpty });
  }

  // ---------------------------------------------------------------------------
  // Hook helper (consumers usually just listen to Foundry hooks themselves,
  // but this filters to only charged-AE changes on owned actors, saving work)
  // ---------------------------------------------------------------------------
  function isOwnedChargedEvent(effect) {
    if (!effect) return false;
    const parent = effect.parent;
    if (!parent || parent.documentName !== "Actor") return false;
    if (!actorIsOwnedByMe(parent)) return false;
    return read(effect) !== null;
  }

  // ---------------------------------------------------------------------------
  // Expose
  // ---------------------------------------------------------------------------
  const api = Object.freeze({
    MODULE_ID,
    FLAG_CHARGES,
    FLAG_MAX,
    FLAG_KEY,
    read,
    findOnActor,
    findOwned,
    findFirstOwned,
    consume,
    set,
    isOwnedChargedEvent
  });

  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.charges = api;

  try {
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod) {
      mod.api = mod.api || {};
      mod.api.charges = api;
    }
  } catch (_) {}

  log("Installed at FUCompanion.api.charges");
})();
