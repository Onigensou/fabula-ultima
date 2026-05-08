/**
 * [ONI] Reaction System — Effect Output Layer (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Declarative reaction-effect dispatch, table-linked.
 *
 * Skills hold two sibling dynamic tables:
 *
 *   reaction_config_table  — trigger rows. Each row carries a `reaction_effect_ref`
 *                            string that identifies which effect to fire when
 *                            the row matches. Blank ref = no declarative effect.
 *
 *   reaction_effect_table  — effect rows. Each row has:
 *                              effect_label   (string identifier — what trigger rows reference)
 *                              effect_kind    ("grant" today; extensible later)
 *                              grant_resource / grant_amount / grant_target  (when kind=grant)
 *
 * When a row matches and fires (passive auto-fire OR manual reaction-skill
 * selection), applyEffectByLabel(...) looks up the effect on the same item
 * by label, dispatches by kind, and applies the effect. The chosen reaction
 * skill still runs through the action pipeline as before; the effect is
 * independent and does not require ACE/PassiveLogic on the skill.
 *
 * Group semantics (mirrors reaction_debuff_count_target):
 *   self  → reactor's actor
 *   ally  → same-disposition combat tokens, INCLUDING the reactor
 *   enemy → opposite-disposition combat tokens
 *   all   → every combat token
 *
 * Resource definitions: see RESOURCE_MAP. Adds a clamp to [0, max] (or to 0
 * for resources without a configured max). zero_power has a hard cap of 6.
 *
 * Cross-ownership writes (player-fired reaction targeting an actor the
 * player does not own) are dispatched through GMExecutor.executeSnippet.
 *
 * Exposed on:  window["oni.ReactionGrant"]
 */
Hooks.once("ready", () => {
  const KEY = "oni.ReactionGrant";
  if (window[KEY]) {
    console.log("[ReactionGrant] Already installed.");
    return;
  }

  const TAG = "[ReactionGrant]";

  // ---------------------------------------------------------------------------
  // Resource catalog
  // ---------------------------------------------------------------------------
  // current: dot-path on actor that holds the live value.
  // max:     dot-path on actor that holds the actor-specific cap (or null).
  // capConst: hard cap independent of the actor (or null).
  // Floor is always 0; resources cannot drain below empty.
  const RESOURCE_MAP = Object.freeze({
    hp:         { current: "system.props.current_hp",       max: "system.props.max_hp", capConst: null, label: "HP" },
    mp:         { current: "system.props.current_mp",       max: "system.props.max_mp", capConst: null, label: "MP" },
    ip:         { current: "system.props.current_ip",       max: "system.props.max_ip", capConst: null, label: "IP" },
    zero_power: { current: "system.props.zero_power_value", max: null,                  capConst: 6,    label: "Zero Power" },
    zenit:      { current: "system.props.zenit",            max: null,                  capConst: null, label: "Zenit" },
    enmity:     { current: "system.props.enmity",           max: null,                  capConst: null, label: "Enmity" }
  });

  // ---------------------------------------------------------------------------
  // Effect-table reading
  // ---------------------------------------------------------------------------
  function readEffectRows(item) {
    const sys = item?.system ?? {};
    const props = sys.props ?? sys;
    const tbl = props?.reaction_effect_table;
    if (!tbl) return [];
    if (Array.isArray(tbl)) return tbl.filter(r => r && typeof r === "object");
    if (typeof tbl === "object") return Object.values(tbl).filter(r => r && typeof r === "object");
    return [];
  }

  function findEffectByLabel(item, label) {
    if (!item || !label) return null;
    const want = String(label).trim();
    if (!want) return null;
    const rows = readEffectRows(item);
    for (const row of rows) {
      const have = (row.effect_label ?? "").toString().trim();
      if (have === want) return row;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Disposition / ownership / number reading
  // ---------------------------------------------------------------------------
  function normalizeDisposition(disposition) {
    if (disposition === -2) return 0;   // Secret → treat as Neutral
    if (disposition === 1)  return 1;
    if (disposition === -1) return -1;
    return 0;
  }

  function actorIsOwnedByMe(actor) {
    try {
      return !!actor?.isOwner;
    } catch (_e) {
      return false;
    }
  }

  function readNumberAt(actor, path) {
    if (!actor || !path) return null;
    try {
      const v = foundry.utils.getProperty(actor, path);
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    } catch (_e) {
      return null;
    }
  }

  function resolveCapForActor(actor, def) {
    if (def.capConst !== null && def.capConst !== undefined) return def.capConst;
    if (def.max) {
      const m = readNumberAt(actor, def.max);
      if (m !== null) return m;
    }
    return null; // uncapped
  }

  // ---------------------------------------------------------------------------
  // Target resolution
  // ---------------------------------------------------------------------------
  function resolveTargetActors(targetMode, reactionToken, combat) {
    const mode = (targetMode || "self").toLowerCase();
    const reactActor = reactionToken?.actor ?? null;

    if (mode === "self") {
      return reactActor ? [reactActor] : [];
    }

    if (!combat) return [];

    const reactDisp = normalizeDisposition(reactionToken?.document?.disposition ?? 0);
    const combatants = combat.combatants?.contents ?? combat.combatants ?? [];
    const seen = new Set();
    const out = [];

    for (const cmbt of combatants) {
      const actor = cmbt?.actor;
      if (!actor || !actor.uuid) continue;
      if (seen.has(actor.uuid)) continue;

      const tokenDoc = cmbt.token ?? canvas?.tokens?.get(cmbt.tokenId)?.document ?? null;
      const subDisp = normalizeDisposition(tokenDoc?.disposition ?? 0);

      let included = false;
      switch (mode) {
        case "ally":
          included = (reactDisp === 1 && subDisp === 1) ||
                     (reactDisp === -1 && subDisp === -1);
          break;
        case "enemy":
          included = (reactDisp === 1 && subDisp === -1) ||
                     (reactDisp === -1 && subDisp === 1);
          break;
        case "all":
          included = true;
          break;
        default:
          included = false;
      }

      if (included) {
        seen.add(actor.uuid);
        out.push(actor);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Per-actor resource update
  // ---------------------------------------------------------------------------
  async function applyOneActor(actor, resourceKey, delta) {
    const def = RESOURCE_MAP[resourceKey];
    if (!def) return { ok: false, reason: "unknown_resource", resourceKey };

    const cur = readNumberAt(actor, def.current);
    if (cur === null) return { ok: false, reason: "non_finite_current", resourceKey };

    const cap = resolveCapForActor(actor, def);

    let next = cur + delta;
    if (next < 0) next = 0;
    if (cap !== null && next > cap) next = cap;

    if (next === cur) {
      return { ok: true, noop: true, resourceKey, before: cur, after: next, cap };
    }

    const update = {};
    foundry.utils.setProperty(update, def.current, next);

    try {
      if (actorIsOwnedByMe(actor)) {
        await actor.update(update);
      } else {
        const gmExec = globalThis?.FUCompanion?.api?.GMExecutor;
        if (!gmExec?.executeSnippet) {
          return { ok: false, reason: "gm_executor_unavailable", resourceKey };
        }
        const scriptText = `
          const a = await fromUuid(payload.actorUuid);
          if (!a) return { ok: false, reason: "actor_resolve_failed" };
          await a.update(payload.update);
          return { ok: true };
        `;
        const res = await gmExec.executeSnippet({
          scriptText,
          payload: { actorUuid: actor.uuid, update },
          actorUuid: actor.uuid
        });
        if (!res?.ok) {
          return { ok: false, reason: res?.reason || "gm_bridge_failed", resourceKey, raw: res };
        }
      }
    } catch (e) {
      console.error(TAG, "actor.update failed", { actor: actor?.name, update }, e);
      return { ok: false, reason: "update_threw", resourceKey, error: String(e?.message ?? e) };
    }

    return { ok: true, noop: false, resourceKey, before: cur, after: next, cap };
  }

  // ---------------------------------------------------------------------------
  // Effect dispatch
  // ---------------------------------------------------------------------------
  async function applyGrantEffect(effectRow, reactionToken, combat) {
    const resourceKey = (effectRow.grant_resource ?? "").toString().trim().toLowerCase();
    if (!resourceKey) {
      return { ok: true, skipped: true, reason: "no_resource", applied: [] };
    }
    if (!RESOURCE_MAP[resourceKey]) {
      return { ok: false, reason: "unknown_resource", resourceKey, applied: [] };
    }

    const amountStr = (effectRow.grant_amount === null || effectRow.grant_amount === undefined)
      ? ""
      : String(effectRow.grant_amount).trim();
    if (amountStr === "") {
      return { ok: true, skipped: true, reason: "no_amount", applied: [] };
    }
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount === 0) {
      return { ok: true, skipped: true, reason: "zero_or_invalid_amount", applied: [] };
    }

    const targetMode = (effectRow.grant_target ?? "self").toString().trim().toLowerCase() || "self";
    const targetActors = resolveTargetActors(targetMode, reactionToken, combat);
    if (!targetActors.length) {
      console.warn(TAG, "applyGrantEffect: no target actors resolved", {
        targetMode,
        reactorName: reactionToken?.actor?.name,
        hasCombat: !!combat
      });
      return { ok: false, reason: "no_targets", applied: [] };
    }

    const applied = [];
    for (const actor of targetActors) {
      const res = await applyOneActor(actor, resourceKey, amount);
      applied.push({ actorUuid: actor.uuid, actorName: actor.name, ...res });
    }
    return { ok: true, applied, kind: "grant", resourceKey, amount, targetMode };
  }

  // ---------------------------------------------------------------------------
  // Public entries
  // ---------------------------------------------------------------------------
  // applyEffectByLabel(item, effectLabel, reactionToken, combat?)
  //   → Promise<{ ok, skipped?, reason?, applied: [...] }>
  //
  // Looks up an effect row on `item.system.props.reaction_effect_table` by
  // its `effect_label`, dispatches by `effect_kind`. Blank label = silent
  // skip (the trigger row simply has no declarative effect).
  async function applyEffectByLabel(item, effectLabel, reactionToken, combat = game.combat) {
    if (!item) return { ok: false, reason: "missing_item", applied: [] };
    if (!reactionToken) return { ok: false, reason: "missing_reaction_token", applied: [] };

    const ref = (effectLabel ?? "").toString().trim();
    if (!ref) return { ok: true, skipped: true, reason: "no_effect_ref", applied: [] };

    const effectRow = findEffectByLabel(item, ref);
    if (!effectRow) {
      console.warn(TAG, `applyEffectByLabel: no effect with label "${ref}" on item "${item?.name}"`);
      return { ok: false, reason: "effect_not_found", effectLabel: ref, applied: [] };
    }

    const kind = (effectRow.effect_kind ?? "").toString().trim().toLowerCase() || "grant";
    let result;
    switch (kind) {
      case "grant":
        result = await applyGrantEffect(effectRow, reactionToken, combat);
        break;
      default:
        console.warn(TAG, `applyEffectByLabel: unknown effect_kind "${kind}" on label "${ref}"`);
        return { ok: false, reason: "unknown_effect_kind", effectKind: kind, effectLabel: ref, applied: [] };
    }

    console.log(TAG, "applyEffectByLabel complete", {
      itemName: item?.name,
      effectLabel: ref,
      kind,
      reactorName: reactionToken?.actor?.name,
      result
    });
    return result;
  }

  // applyEffectsForGroup(chosenGroup, reactionToken, combat?)
  // Iterates every matched row of every entry in the chosen reaction group
  // and applies the effect referenced by each row's reaction_effect_ref.
  // Used by the manual-reaction path.
  async function applyEffectsForGroup(chosenGroup, reactionToken, combat = game.combat) {
    const out = [];
    if (!chosenGroup) return out;
    const entries = Array.isArray(chosenGroup.entries) ? chosenGroup.entries : [];
    for (const entry of entries) {
      const item = entry?.item ?? chosenGroup.item ?? null;
      if (!item) continue;
      const rows = Array.isArray(entry?.rows) ? entry.rows : [];
      for (const row of rows) {
        const ref = row?.reaction_effect_ref;
        if (!ref) continue;
        const res = await applyEffectByLabel(item, ref, reactionToken, combat);
        out.push(res);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  window[KEY] = {
    applyEffectByLabel,
    applyEffectsForGroup,
    findEffectByLabel,
    readEffectRows,
    RESOURCE_MAP
  };

  // Mirror to the FUCompanion API root for parity with other subsystems.
  try {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.reactionGrant = window[KEY];
  } catch (_e) { /* non-fatal */ }

  console.log(TAG, "Installed. Resources:", Object.keys(RESOURCE_MAP).join(", "));
});
