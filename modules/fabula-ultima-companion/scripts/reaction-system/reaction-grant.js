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
    console.debug("[ReactionGrant] Already installed.");
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
  // apply_ae effect_kind — apply an Active Effect onto target actors
  // ---------------------------------------------------------------------------
  // Row fields:
  //   ae_template_ref    string  — registry id / Item.x.ActiveEffect.y uuid /
  //                                effect name registered in the AEM registry,
  //                                forwarded to applyEffects as-is.
  //   grant_target       "self"|"ally"|"enemy"|"all"  (default "self")
  //   ae_duplicate_mode  "skip"|"replace"|"stack"|"remove"|"ask" (default "replace")
  //
  // Authors create the AE itself on a skill item / via the AEM registry and
  // reference it by string here. Inline JSON authoring was removed — keep the
  // single source of truth in the AE document.
  async function applyApplyAeEffect(effectRow, reactionToken, combat) {
    const aem = globalThis?.FUCompanion?.api?.activeEffectManager;
    if (typeof aem?.applyEffects !== "function") {
      return { ok: false, reason: "aem_unavailable", applied: [] };
    }

    const ref = (effectRow.ae_template_ref ?? "").toString().trim();
    if (!ref) {
      return { ok: true, skipped: true, reason: "no_ae_template_ref", applied: [] };
    }

    const targetMode = (effectRow.grant_target ?? "self").toString().trim().toLowerCase() || "self";
    const targetActors = resolveTargetActors(targetMode, reactionToken, combat);
    if (!targetActors.length) {
      return { ok: false, reason: "no_targets", applied: [] };
    }

    const dup = (effectRow.ae_duplicate_mode ?? "replace").toString().trim().toLowerCase() || "replace";

    const applied = [];
    for (const actor of targetActors) {
      try {
        const res = await aem.applyEffects({
          actorUuids: [actor.uuid],
          effects: [ref],
          duplicateMode: dup
        });
        applied.push({
          actorUuid: actor.uuid,
          actorName: actor.name,
          ok: res?.ok !== false,
          report: res
        });
      } catch (e) {
        applied.push({
          actorUuid: actor.uuid,
          actorName: actor.name,
          ok: false,
          error: String(e?.message ?? e)
        });
      }
    }
    return { ok: true, applied, kind: "apply_ae", targetMode, duplicateMode: dup, templateRef: ref };
  }

  // ---------------------------------------------------------------------------
  // consume_charge effect_kind — gate-and-consume one charged AE
  // ---------------------------------------------------------------------------
  // Row fields:
  //   charge_key      string                 — chargeKey to find/consume
  //   grant_target    "self"|"ally"|...      — typically "self" (default "self")
  //   on_empty        "abort"|"skip"         — what to do if no charges available
  //                                            (default "abort": stop the chain
  //                                             AND signal callers to skip the
  //                                             skill body)
  //   count           number                 — charges to consume per target
  //                                            (default 1)
  //
  // Returns { ok, abort, applied, ... }. `abort: true` means the caller
  // (manual reaction dispatcher / autoPassive runner) should NOT proceed to
  // run the skill's action pipeline.
  async function applyConsumeChargeEffect(effectRow, reactionToken, combat) {
    const chargesApi = globalThis?.FUCompanion?.api?.charges;
    if (typeof chargesApi?.findOnActor !== "function" || typeof chargesApi?.consume !== "function") {
      return { ok: false, reason: "charges_api_unavailable", applied: [] };
    }

    const chargeKey = (effectRow.charge_key ?? "").toString().trim();
    if (!chargeKey) {
      return { ok: true, skipped: true, reason: "no_charge_key", applied: [] };
    }

    const onEmpty = ((effectRow.on_empty ?? "abort").toString().trim().toLowerCase()) || "abort";
    const count = Math.max(1, Number(effectRow.count) || 1);

    const targetMode = (effectRow.grant_target ?? "self").toString().trim().toLowerCase() || "self";
    const targetActors = resolveTargetActors(targetMode, reactionToken, combat);
    if (!targetActors.length) {
      return { ok: false, reason: "no_targets", applied: [] };
    }

    const applied = [];
    let anyConsumed = false;
    let anyEmpty = false;

    for (const actor of targetActors) {
      const owned = chargesApi.findOnActor(actor, { key: chargeKey });
      if (!owned.length) {
        applied.push({
          actorUuid: actor.uuid, actorName: actor.name,
          ok: false, reason: "no_charge", chargeKey
        });
        anyEmpty = true;
        continue;
      }
      const consumeRes = await chargesApi.consume(owned[0].effect, { count, deleteWhenEmpty: true });
      applied.push({
        actorUuid: actor.uuid, actorName: actor.name,
        ok: !!consumeRes?.ok,
        before: consumeRes?.before, after: consumeRes?.after,
        deleted: !!consumeRes?.deleted,
        chargeKey
      });
      if (consumeRes?.ok) anyConsumed = true;
    }

    // Abort if we couldn't consume anything for at least one target and the
    // row says "abort". With grant_target="self" (the common case) this
    // collapses to "no charge → abort", which is what gates expect.
    const abort = (onEmpty === "abort") && anyEmpty && !anyConsumed;

    return { ok: !abort, abort, applied, kind: "consume_charge", chargeKey, targetMode, onEmpty, count };
  }

  // ---------------------------------------------------------------------------
  // redirect_target effect_kind — rewrite the pending action card's target
  // ---------------------------------------------------------------------------
  // Action-mutation verb. Wraps the existing oni.ReactionRedirectPendingAction
  // helper so authors don't write JS to express "intercept the incoming attack
  // and aim it at me instead" (Protect, Cover, Bodyguard).
  //
  // Row fields:
  //   target_select   "first" (only mode today; reserved for future "all" / uuid)
  //   rebuild_card    boolean — whether to re-render the redirected card (default true)
  //
  // Always returns abort:true on success because a successful redirect means
  // the reactor's own skill body must NOT continue (no Protect card created).
  async function applyRedirectTargetEffect(effectRow, reactionToken, combat, ctx) {
    const redirectApi = window["oni.ReactionRedirectPendingAction"];
    if (typeof redirectApi?.redirectFromPayload !== "function") {
      return { ok: false, abort: true, reason: "redirect_api_unavailable", applied: [] };
    }

    const payload = ctx?.payload ?? null;
    if (!payload) {
      return { ok: false, abort: true, reason: "no_payload", applied: [] };
    }

    const reactorUuid =
      reactionToken?.actor?.uuid ??
      reactionToken?.document?.actor?.uuid ??
      payload?.meta?.attackerUuid ??
      payload?.attackerUuid ??
      payload?.attackerActorUuid ??
      null;

    const rebuildCard = effectRow.rebuild_card !== false; // default true

    let result;
    try {
      result = await redirectApi.redirectFromPayload(payload, {
        kind: "redirect_target",
        rebuildCard,
        reactorUuid
      });
    } catch (e) {
      return {
        ok: false, abort: true,
        reason: "redirect_threw",
        error: String(e?.message ?? e),
        applied: []
      };
    }

    if (result?.cancelled) {
      return {
        ok: true, abort: true, kind: "redirect_target",
        reason: "player_cancelled",
        applied: [{ ok: true, info: result }]
      };
    }
    if (!result?.ok) {
      return {
        ok: false, abort: true, kind: "redirect_target",
        reason: result?.reason ?? "redirect_failed",
        applied: [{ ok: false, error: result?.reason ?? null, info: result }]
      };
    }

    // Mirror the meta side-effects the old custom_logic_action used to set,
    // so downstream consumers (Protect resolution safeguard) see the same flag.
    payload.meta = payload.meta || {};
    payload.meta.protectRedirectApplied = true;
    payload.meta.protectRedirectResult = {
      messageId:             result?.messageId ?? null,
      oldMessageId:          result?.oldMessageId ?? null,
      newMessageId:          result?.newMessageId ?? null,
      actionId:              result?.actionId ?? null,
      actionCardId:          result?.actionCardId ?? null,
      actionCardVersion:     result?.actionCardVersion ?? null,
      targetIndex:           result?.targetIndex ?? null,
      replacementTargetUuid: result?.replacementTargetUuid ?? null,
      replacementActorUuid:  result?.replacementActorUuid ?? null
    };

    return {
      ok: true, abort: true, kind: "redirect_target",
      applied: [{ ok: true, info: result }]
    };
  }

  // ---------------------------------------------------------------------------
  // chain effect_kind — invoke other effect labels in order
  // ---------------------------------------------------------------------------
  // Row fields:
  //   chain_steps   string — comma-separated effect_label values in order
  //
  // Stops at the first step that returns `abort: true` OR `ok: false`. Aborts
  // the whole chain (and therefore the skill body) when any step does.
  async function applyChainEffect(effectRow, reactionToken, combat, ctx) {
    const stepsRaw = String(effectRow.chain_steps ?? "").trim();
    const steps = stepsRaw.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    if (!steps.length) {
      return { ok: true, skipped: true, reason: "no_chain_steps", applied: [] };
    }
    const item = ctx?.item;
    if (!item) {
      return { ok: false, abort: true, reason: "no_item_in_context", applied: [] };
    }

    const stepResults = [];
    for (const stepLabel of steps) {
      const res = await applyEffectByLabel(item, stepLabel, reactionToken, combat, ctx?.payload);
      stepResults.push({ stepLabel, result: res });
      if (res?.abort) {
        return {
          ok: res.ok !== false, abort: true, kind: "chain",
          chainSteps: steps, applied: stepResults
        };
      }
      if (res?.ok === false) {
        return {
          ok: false, abort: true, kind: "chain",
          chainSteps: steps, applied: stepResults,
          reason: "step_failed", failedAt: stepLabel
        };
      }
    }
    return { ok: true, kind: "chain", chainSteps: steps, applied: stepResults };
  }

  // ---------------------------------------------------------------------------
  // Public entries
  // ---------------------------------------------------------------------------
  // applyEffectByLabel(item, effectLabel, reactionToken, combat?, payload?)
  //   → Promise<{ ok, abort?, skipped?, reason?, applied: [...] }>
  //
  // Looks up an effect row on `item.system.props.reaction_effect_table` by
  // its `effect_label`, dispatches by `effect_kind`. Blank label = silent
  // skip (the trigger row simply has no declarative effect).
  //
  // `payload` is the reaction phase payload (or chosen-skill payload) and
  // is passed via `ctx.payload` to handlers that mutate the action card
  // (redirect_target, future damage_change/etc.). Resource handlers ignore it.
  async function applyEffectByLabel(item, effectLabel, reactionToken, combat = game.combat, payload = null) {
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
    const ctx = { item, payload };
    let result;
    switch (kind) {
      case "grant":
        result = await applyGrantEffect(effectRow, reactionToken, combat);
        break;
      case "apply_ae":
        result = await applyApplyAeEffect(effectRow, reactionToken, combat);
        break;
      case "consume_charge":
        result = await applyConsumeChargeEffect(effectRow, reactionToken, combat);
        break;
      case "redirect_target":
        result = await applyRedirectTargetEffect(effectRow, reactionToken, combat, ctx);
        break;
      case "chain":
        result = await applyChainEffect(effectRow, reactionToken, combat, ctx);
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

  // applyEffectsForGroup(chosenGroup, reactionToken, combat?, payload?)
  //   → Promise<{ results: [...], aborted: boolean, abortInfo?: {...} }>
  //
  // Iterates every matched row of every entry in the chosen reaction group
  // and applies the effect referenced by each row's reaction_effect_ref.
  // Used by the manual-reaction path. Stops at the first effect that returns
  // `{ abort: true }` (e.g. a `consume_charge` gate with no charges left) and
  // surfaces `aborted: true` so the caller can skip running the skill body.
  // `payload` is the chosen-skill execution payload, threaded to handlers
  // that mutate the source action card (redirect_target, etc.).
  async function applyEffectsForGroup(chosenGroup, reactionToken, combat = game.combat, payload = null) {
    const results = [];
    if (!chosenGroup) return { results, aborted: false };

    const entries = Array.isArray(chosenGroup.entries) ? chosenGroup.entries : [];
    for (const entry of entries) {
      const item = entry?.item ?? chosenGroup.item ?? null;
      if (!item) continue;
      const rows = Array.isArray(entry?.rows) ? entry.rows : [];
      for (const row of rows) {
        const ref = row?.reaction_effect_ref;
        if (!ref) continue;
        const res = await applyEffectByLabel(item, ref, reactionToken, combat, payload);
        results.push(res);
        if (res?.abort) {
          return {
            results,
            aborted: true,
            abortInfo: { itemName: item?.name ?? null, effectLabel: ref, result: res }
          };
        }
      }
    }
    return { results, aborted: false };
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

  console.debug(TAG, "Installed. Resources:", Object.keys(RESOURCE_MAP).join(", "));
});
