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
 *   effect_table           — effect rows. Each row has:
 *                              effect_label   (string identifier — what other rows reference)
 *                              effect_kind    ("targeting" | "grant" | "apply_ae" |
 *                                              "consume_charge" | "open_action_menu" |
 *                                              "redirect_target" | "chain")
 *                              per-kind fields (see docs/reaction-config-schema.md)
 *                              target_ref     — for effects that act on tokens;
 *                                               points at a `targeting` row
 *
 * Targeting is its own effect_kind that resolves to a named token list other
 * rows consume via `target_ref`. The dispatcher hands off to the unified
 * resolver at FUCompanion.api.effectTargeting.resolveTargetRef(...). No
 * per-kind targeting fields (grant_target / target_lock) — those were
 * removed in the Phase F refactor.
 *
 * When a row matches and fires (passive auto-fire OR manual reaction-skill
 * selection), applyEffectByLabel(...) looks up the effect on the same item
 * by label, dispatches by kind, and applies the effect. The chosen reaction
 * skill still runs through the action pipeline as before; the effect is
 * independent and does not require ACE/PassiveLogic on the skill.
 *
 * Resource definitions: see RESOURCE_MAP. Adds a clamp to [0, max] (or to 0
 * for resources without a configured max). zero_power has a hard cap of 6.
 *
 * Cross-ownership writes (player-fired reaction targeting an actor the
 * player does not own) are dispatched through GMExecutor.executeSnippet.
 *
 * Exposed on:  window["oni.ReactionGrant"]
 */
(() => {
  function bootReactionGrant() { _installReactionGrant(); }
  if (globalThis?.game?.ready) bootReactionGrant();
  else Hooks.once("ready", bootReactionGrant);
})();

function _installReactionGrant() {
  const KEY = "oni.ReactionGrant";
  if (window[KEY]) {
    console.debug("[ReactionGrant] Already installed.");
    return;
  }

  const TAG = "[ReactionGrant]";

  // ---------------------------------------------------------------------------
  // Effect-kind registry — exposed for the AE reaction-config UI editor so
  // the dropdown stays in sync with the dispatcher's switch (see
  // applyEffectByLabel's switch later in this file). Single source of truth.
  // ---------------------------------------------------------------------------
  const EFFECT_KINDS = Object.freeze([
    "grant",
    "apply_ae",
    "consume_charge",
    "redirect_target",
    "chain",
    "open_action_menu"
  ]);
  window["oni.ReactionEffectKinds"] = Object.freeze({
    list: () => EFFECT_KINDS
  });

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
    // Phase D rename: prefer `effect_table` (the table is general-purpose
    // skill effects, not reaction-specific). Fall back to the legacy
    // `reaction_effect_table` for back-compat during migration.
    const tbl = props?.effect_table ?? props?.reaction_effect_table;
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
  // Ownership / number reading
  // ---------------------------------------------------------------------------
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

  // Target resolution moved to scripts/reaction-system/effect-targeting-resolver.js
  // (the unified `effect_kind: "targeting"` system). The old per-kind
  // `grant_target` / `target_lock` paths and the `resolveTargetActors`
  // helper that backed them were removed; handlers now read `target_ref`
  // and call `FUCompanion.api.effectTargeting.resolveTargetRef` instead.

  // ---------------------------------------------------------------------------
  // Per-actor resource update
  // ---------------------------------------------------------------------------
  // For hp/mp/shield resources, delegates to FUCompanion.api.applyDamage.applyToActor
  // so the floating scrolling number (and VFX/SFX where relevant) shows up — same
  // visuals as Create Damage Card. Other resource types (ip/zenit/enmity/zero_power)
  // don't have a damage-pipeline shape, so they use the legacy actor.update path.
  async function applyOneActor(actor, resourceKey, delta, opts = {}) {
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

    // Path A: use applyDamage.applyToActor for the resources it supports so the
    // floating heal/damage number renders at the target token. Verbosity is "fx"
    // — caller (e.g. autoPassive) handles its own chat-card broadcast. We want
    // numbers + FX + audio but NOT a duplicate damage card.
    const supportsAV = (resourceKey === "hp" || resourceKey === "mp" || resourceKey === "shield");
    const applyDamageApi = supportsAV ? globalThis?.FUCompanion?.api?.applyDamage : null;
    if (applyDamageApi?.applyToActor) {
      try {
        const adResult = await applyDamageApi.applyToActor({
          baseDamage: Math.abs(delta),
          valueType: resourceKey,
          isRecovery: delta > 0,
          targetActor: actor,
          targetToken: opts.targetToken ?? null,
          attackerName: opts.attackerName ?? "Reaction",
          attackerUuid: opts.attackerUuid ?? "",
          sourceType: opts.sourceType ?? "Reaction",
          verbosity: "fx"
        });
        // Prefer the real post values from applyToActor; fall back to current
        // actor doc if it didn't return them.
        const after = (() => {
          const k = resourceKey;
          if (k === "hp"     && Number.isFinite(adResult?.postHP))     return adResult.postHP;
          if (k === "mp"     && Number.isFinite(adResult?.postMP))     return adResult.postMP;
          if (k === "shield" && Number.isFinite(adResult?.postShield)) return adResult.postShield;
          return readNumberAt(actor, def.current) ?? next;
        })();
        return { ok: true, noop: false, resourceKey, before: cur, after, cap };
      } catch (e) {
        console.warn(TAG, "applyDamage.applyToActor threw; falling back to plain update.", { actor: actor?.name, resourceKey, error: String(e?.message ?? e) });
      }
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
  async function applyGrantEffect(effectRow, reactionToken, combat, ctx) {
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

    // Evaluate the amount expression. Falls through to plain-number parsing
    // for literals (e.g. "10"); identifiers / arithmetic require the formula
    // evaluator. Authors can write "SL * 2", "MP_DEALT_TOTAL / 2", etc.
    let amount;
    const formula = window["oni.ReactionFormula"];
    if (formula?.evaluate) {
      const formulaContext = {
        reactorActor: reactionToken?.actor ?? null,
        reactorToken: reactionToken ?? null,
        firingSkill: ctx?.item ?? null,
        subjectToken: ctx?.subjectToken ?? null,
        payload: ctx?.payload ?? null
      };
      amount = formula.evaluate(amountStr, formulaContext);
    } else {
      amount = Number(amountStr);
    }
    if (!Number.isFinite(amount) || amount === 0) {
      return { ok: true, skipped: true, reason: "zero_or_invalid_amount", applied: [], amountExpr: amountStr };
    }

    // Recipient list comes from a `targeting` row referenced by `target_ref`.
    // The resolver handles disposition filter, candidate source, mode (exact /
    // up_to / all), and auto-confirm / passive-skip semantics. See
    // docs/reaction-config-schema.md.
    const targetRef = String(effectRow.target_ref ?? "").trim();
    if (!targetRef) {
      console.warn(TAG, "applyGrantEffect: target_ref missing on row", effectRow?.effect_label);
      return { ok: false, reason: "missing_target_ref", applied: [] };
    }
    const targetingApi = globalThis?.FUCompanion?.api?.effectTargeting;
    if (typeof targetingApi?.resolveTargetRef !== "function") {
      return { ok: false, reason: "targeting_api_unavailable", applied: [] };
    }
    const item = ctx?.item;
    if (!item) {
      return { ok: false, reason: "no_item_in_context", applied: [] };
    }
    const resolved = await targetingApi.resolveTargetRef(item, targetRef, ctx?.effectTargetingCtx);
    if (!resolved?.ok) {
      if (resolved?.cancelled) {
        return { ok: false, cancelled: true, abort: true, reason: "cancelled", applied: [], targetRef };
      }
      return { ok: false, reason: resolved?.reason ?? "targeting_failed", applied: [], targetRef };
    }
    const targetPairs = (resolved.tokens ?? [])
      .map(td => ({ actor: td?.actor, token: td }))
      .filter(p => p.actor);
    if (!targetPairs.length) {
      return { ok: false, reason: "no_target_actors", applied: [], targetRef };
    }

    const reactorActor = reactionToken?.actor ?? null;
    const firingItem = ctx?.item ?? null;
    const applied = [];
    for (const { actor, token } of targetPairs) {
      const res = await applyOneActor(actor, resourceKey, amount, {
        targetToken: token,
        attackerName: firingItem?.name ?? "Reaction",
        attackerUuid: reactorActor?.uuid ?? "",
        sourceType: "Reaction"
      });
      applied.push({ actorUuid: actor.uuid, actorName: actor.name, ...res });
    }
    return { ok: true, applied, kind: "grant", resourceKey, amount, targetRef };
  }

  // ---------------------------------------------------------------------------
  // apply_ae effect_kind — apply an Active Effect onto target actors
  // ---------------------------------------------------------------------------
  // Row fields:
  //   ae_template_ref    string  — registry id / Item.x.ActiveEffect.y uuid /
  //                                effect name registered in the AEM registry,
  //                                forwarded to applyEffects as-is.
  //   target_ref         string  — effect_label of a `targeting` row in this
  //                                same effect_table. Recipients of the AE.
  //                                Resolved via FUCompanion.api.effectTargeting.
  //                                See docs/reaction-config-schema.md.
  //   ae_duplicate_mode  "skip"|"replace"|"stack"|"remove"|"ask" (default "replace")
  //
  // Authors create the AE itself on a skill item / via the AEM registry and
  // reference it by string here. Inline JSON authoring was removed — keep the
  // single source of truth in the AE document.
  //
  // target_prompt mode (Phase G — Heart of Darkness):
  //   target_prompt          "" | "visible"   — when "visible", open the
  //                                              visible-token picker and
  //                                              stamp the picked target's
  //                                              name into the applied AE's
  //                                              flags.fabula-ultima-companion.bondAE.bond_name.
  //                                              grant_target is ignored when
  //                                              prompt mode is active — the
  //                                              AE always lands on the reactor
  //                                              (the bond exists on the reactor,
  //                                              not the picked target).
  //   target_prompt_filter   "" | "no_existing_bond"
  //                          — excludes candidates already in the reactor's
  //                            bond set (props + AE-borne, via BondUpdater).
  //   target_prompt_title    optional Dialog title
  //   target_prompt_message  optional body text
  async function applyApplyAeEffect(effectRow, reactionToken, combat, ctx) {
    const aem = globalThis?.FUCompanion?.api?.activeEffectManager;
    if (typeof aem?.applyEffects !== "function") {
      return { ok: false, reason: "aem_unavailable", applied: [] };
    }

    const ref = (effectRow.ae_template_ref ?? "").toString().trim();
    if (!ref) {
      return { ok: true, skipped: true, reason: "no_ae_template_ref", applied: [] };
    }

    const dup = (effectRow.ae_duplicate_mode ?? "replace").toString().trim().toLowerCase() || "replace";
    const promptMode = String(effectRow.target_prompt ?? "").trim().toLowerCase();
    const isPassive = !!ctx?.isPassive;

    // -------- prompt-target branch --------
    if (promptMode === "visible") {
      const picker = globalThis["oni.VisibleTokenPicker"];
      if (typeof picker?.pickVisibleToken !== "function" || typeof picker?._collectCandidates !== "function") {
        return { ok: false, reason: "picker_unavailable", applied: [] };
      }
      const reactorActor = reactionToken?.actor ?? null;
      if (!reactorActor) {
        return { ok: false, reason: "no_reactor_actor", applied: [] };
      }

      // Build exclusion set if filter is active.
      const filter = String(effectRow.target_prompt_filter ?? "").trim().toLowerCase();
      let excludeNames = [];
      if (filter === "no_existing_bond") {
        const bonds = globalThis.BondUpdater?.readBondsAll?.(reactorActor) ?? [];
        excludeNames = bonds.map(b => String(b?.name ?? "").trim()).filter(Boolean);
      }

      // Auto-skip policy: passive reactions shouldn't open a picker when the
      // result is unambiguous. Resolve candidates up front; if isPassive and
      // exactly one survives the filter, auto-pick. Manual reactions always
      // prompt so the player can cancel.
      const candidates = picker._collectCandidates({
        reactorToken: reactionToken,
        excludeNames
      });

      let pick;
      if (!candidates.length) {
        pick = { ok: false, reason: "no_candidates" };
      } else if (isPassive && candidates.length === 1) {
        const c = candidates[0];
        pick = {
          ok: true,
          tokenUuid: c.tokenUuid,
          actorUuid: c.actorUuid,
          tokenName: c.tokenName,
          actorName: c.actorName,
          autoResolved: true
        };
      } else {
        pick = await picker.pickVisibleToken({
          reactorToken: reactionToken,
          excludeNames,
          title: effectRow.target_prompt_title || "Choose a Target",
          prompt: effectRow.target_prompt_message || "Choose a creature you can see."
        });
      }

      if (!pick?.ok) {
        return { ok: !!pick?.cancelled, abort: !pick?.cancelled, applied: [], reason: pick?.reason ?? "picker_no_pick", kind: "apply_ae", templateRef: ref };
      }

      // Resolve the template AE and patch its bondAE.bond_name with the pick.
      let templateDoc;
      try { templateDoc = await fromUuid(ref); }
      catch (e) { return { ok: false, reason: "template_uuid_invalid", applied: [], error: String(e?.message ?? e) }; }
      if (!templateDoc) return { ok: false, reason: "template_not_found", applied: [] };

      const baked = templateDoc.toObject?.() ?? foundry.utils.deepClone(templateDoc);
      // Strip ids that would collide on create.
      delete baked._id; delete baked.id; delete baked.folder; delete baked.sort; delete baked.ownership; delete baked._stats;
      baked.flags = baked.flags ?? {};
      baked.flags["fabula-ultima-companion"] = baked.flags["fabula-ultima-companion"] ?? {};
      const bondAE = baked.flags["fabula-ultima-companion"].bondAE ?? null;
      if (bondAE) {
        baked.flags["fabula-ultima-companion"].bondAE = {
          ...bondAE,
          bond_name: pick.tokenName || pick.actorName || bondAE.bond_name
        };
      }
      // Optionally retitle the AE so the actor inventory shows the target name.
      if (bondAE && (pick.tokenName || pick.actorName)) {
        const targetLabel = pick.actorName || pick.tokenName;
        baked.name = baked.name?.includes("{target}")
          ? baked.name.replaceAll("{target}", targetLabel)
          : `${baked.name ?? "Bond"} — ${targetLabel}`;
      }

      try {
        const res = await aem.applyEffects({
          actorUuids: [reactorActor.uuid],
          effects: [{ effectData: baked }],
          duplicateMode: dup
        });
        return {
          ok: true,
          applied: [{ actorUuid: reactorActor.uuid, actorName: reactorActor.name, ok: res?.ok !== false, report: res }],
          kind: "apply_ae",
          targetMode: "self",
          duplicateMode: dup,
          templateRef: ref,
          promptPick: { tokenUuid: pick.tokenUuid, actorUuid: pick.actorUuid, name: pick.tokenName || pick.actorName }
        };
      } catch (e) {
        return { ok: false, reason: "apply_threw", error: String(e?.message ?? e), applied: [], kind: "apply_ae", templateRef: ref };
      }
    }

    // -------- default branch (no prompt) — read target_ref via resolver --------
    const targetRef = String(effectRow.target_ref ?? "").trim();
    if (!targetRef) {
      console.warn(TAG, "applyApplyAeEffect: target_ref missing on row", effectRow?.effect_label);
      return { ok: false, reason: "missing_target_ref", applied: [] };
    }

    const targetingApi = globalThis?.FUCompanion?.api?.effectTargeting;
    if (typeof targetingApi?.resolveTargetRef !== "function") {
      return { ok: false, reason: "targeting_api_unavailable", applied: [] };
    }

    const item = ctx?.item;
    if (!item) {
      return { ok: false, reason: "no_item_in_context", applied: [] };
    }

    const resolved = await targetingApi.resolveTargetRef(item, targetRef, ctx?.effectTargetingCtx);
    if (!resolved?.ok) {
      // User-cancelled picker is a distinct outcome — propagate the
      // signal up so the dispatcher can reopen the reaction menu instead
      // of treating this as a hard abort. Same shape used by every
      // handler so applyEffectsForGroup can detect it generically.
      if (resolved?.cancelled) {
        return { ok: false, cancelled: true, abort: true, reason: "cancelled", applied: [], targetRef };
      }
      return { ok: false, reason: resolved?.reason ?? "targeting_failed", applied: [], targetRef };
    }

    // Walk targeting row's iteration_mode (together / per_token) to decide
    // whether to invoke applyEffects once with all actors or once per actor.
    const targetActors = (resolved.tokens ?? [])
      .map(td => td?.actor)
      .filter(Boolean)
      .map(a => ({ actor: a }));
    if (!targetActors.length) {
      return { ok: false, reason: "no_target_actors", applied: [], targetRef };
    }

    const applied = [];
    for (const { actor } of targetActors) {
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
    return { ok: true, applied, kind: "apply_ae", targetRef, duplicateMode: dup, templateRef: ref };
  }

  // ---------------------------------------------------------------------------
  // consume_charge effect_kind — gate-and-consume one charged AE
  // ---------------------------------------------------------------------------
  // Row fields:
  //   charge_key      string                 — chargeKey to find/consume
  //   target_ref      string (effect_label)  — references a `targeting` row that
  //                                            resolves the actors whose charges
  //                                            are consumed (typically a row
  //                                            with candidate_source: "self").
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
  async function applyConsumeChargeEffect(effectRow, reactionToken, combat, ctx) {
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

    const targetRef = String(effectRow.target_ref ?? "").trim();
    if (!targetRef) {
      console.warn(TAG, "applyConsumeChargeEffect: target_ref missing on row", effectRow?.effect_label);
      return { ok: false, reason: "missing_target_ref", applied: [] };
    }
    const targetingApi = globalThis?.FUCompanion?.api?.effectTargeting;
    if (typeof targetingApi?.resolveTargetRef !== "function") {
      return { ok: false, reason: "targeting_api_unavailable", applied: [] };
    }
    const item = ctx?.item;
    if (!item) {
      return { ok: false, reason: "no_item_in_context", applied: [] };
    }
    const resolved = await targetingApi.resolveTargetRef(item, targetRef, ctx?.effectTargetingCtx);
    if (!resolved?.ok) {
      if (resolved?.cancelled) {
        return { ok: false, cancelled: true, abort: true, reason: "cancelled", applied: [], targetRef };
      }
      return { ok: false, reason: resolved?.reason ?? "targeting_failed", applied: [], targetRef };
    }
    const targetActors = (resolved.tokens ?? [])
      .map(td => ({ actor: td?.actor }))
      .filter(p => p.actor);
    if (!targetActors.length) {
      return { ok: false, reason: "no_target_actors", applied: [], targetRef };
    }

    const applied = [];
    let anyConsumed = false;
    let anyEmpty = false;

    for (const { actor } of targetActors) {
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
    // row says "abort". With a "self"-targeting row (the common case) this
    // collapses to "no charge → abort", which is what gates expect.
    const abort = (onEmpty === "abort") && anyEmpty && !anyConsumed;

    return { ok: !abort, abort, applied, kind: "consume_charge", chargeKey, targetRef, onEmpty, count };
  }

  // ---------------------------------------------------------------------------
  // consume_resource effect_kind — gate-and-deduct an actor resource
  // ---------------------------------------------------------------------------
  // Generalizes consume_charge to HP/MP/IP/etc. Validates that each target's
  // current resource >= amount; deducts on success. With on_empty="abort",
  // insufficient resource cancels the chain AND signals callers to skip the
  // skill body. Use at the END of a chain so a cancel in a prior step (e.g.
  // a targeting picker on redirect_target) doesn't cost the resource.
  //
  // Row fields:
  //   grant_resource   string   — resource key (mp / hp / ip / ...)
  //   grant_amount     number|formula — amount to deduct per target
  //   target_ref       string (effect_label) — who pays the cost
  //   on_empty         "abort"|"skip" — what to do on insufficient resource
  async function applyConsumeResourceEffect(effectRow, reactionToken, combat, ctx) {
    const resourceKey = String(effectRow.grant_resource ?? "").trim().toLowerCase();
    if (!resourceKey) {
      return { ok: true, skipped: true, reason: "no_resource", applied: [] };
    }
    if (!RESOURCE_MAP[resourceKey]) {
      return { ok: false, reason: "unknown_resource", resourceKey, applied: [] };
    }

    const amountStr = (effectRow.grant_amount == null) ? "" : String(effectRow.grant_amount).trim();
    if (amountStr === "") {
      return { ok: true, skipped: true, reason: "no_amount", applied: [] };
    }
    let amount;
    const formula = window["oni.ReactionFormula"];
    if (formula?.evaluate) {
      const formulaContext = {
        reactorActor: reactionToken?.actor ?? null,
        reactorToken: reactionToken ?? null,
        firingSkill: ctx?.item ?? null,
        subjectToken: ctx?.subjectToken ?? null,
        payload: ctx?.payload ?? null
      };
      amount = formula.evaluate(amountStr, formulaContext);
    } else {
      amount = Number(amountStr);
    }
    amount = Math.max(0, Math.floor(Number(amount) || 0));
    if (!amount) {
      return { ok: true, skipped: true, reason: "zero_amount", applied: [], amountExpr: amountStr };
    }

    const onEmpty = String(effectRow.on_empty ?? "abort").trim().toLowerCase() || "abort";

    const targetRef = String(effectRow.target_ref ?? "").trim();
    if (!targetRef) {
      return { ok: false, reason: "missing_target_ref", applied: [] };
    }
    const targetingApi = globalThis?.FUCompanion?.api?.effectTargeting;
    if (typeof targetingApi?.resolveTargetRef !== "function") {
      return { ok: false, reason: "targeting_api_unavailable", applied: [] };
    }
    const item = ctx?.item;
    if (!item) {
      return { ok: false, reason: "no_item_in_context", applied: [] };
    }
    const resolved = await targetingApi.resolveTargetRef(item, targetRef, ctx?.effectTargetingCtx);
    if (!resolved?.ok) {
      if (resolved?.cancelled) {
        return { ok: false, cancelled: true, abort: true, reason: "cancelled", applied: [], targetRef };
      }
      return { ok: false, reason: resolved?.reason ?? "targeting_failed", applied: [], targetRef };
    }
    const targetActors = (resolved.tokens ?? [])
      .map(td => ({ actor: td?.actor, token: td }))
      .filter(p => p.actor);
    if (!targetActors.length) {
      return { ok: false, reason: "no_target_actors", applied: [], targetRef };
    }

    // Validate sufficient resource on all targets FIRST. If any target is
    // short, abort (or skip per onEmpty) — atomic semantics, no partial spend.
    const def = RESOURCE_MAP[resourceKey];
    const insufficient = [];
    for (const { actor } of targetActors) {
      const curr = readNumberAt(actor, def.current) ?? 0;
      if (curr < amount) insufficient.push({ actor, curr });
    }
    if (insufficient.length) {
      const reason = `insufficient_${resourceKey}`;
      const applied = insufficient.map(({ actor, curr }) => ({
        actorUuid: actor.uuid, actorName: actor.name, ok: false, reason, have: curr, need: amount
      }));
      if (onEmpty === "abort") {
        return { ok: false, abort: true, applied, kind: "consume_resource", resourceKey, amount, reason };
      }
      return { ok: true, skipped: true, applied, kind: "consume_resource", resourceKey, amount, reason };
    }

    // Sufficient on all targets — deduct via the existing applyOneActor
    // path (negative amount → drain).
    const reactorActor = reactionToken?.actor ?? null;
    const firingItem = ctx?.item ?? null;
    const applied = [];
    for (const { actor, token } of targetActors) {
      const res = await applyOneActor(actor, resourceKey, -amount, {
        targetToken: token,
        attackerName: firingItem?.name ?? "Cost",
        attackerUuid: reactorActor?.uuid ?? "",
        sourceType: "Reaction"
      });
      applied.push({ actorUuid: actor.uuid, actorName: actor.name, ...res });
    }
    return { ok: true, applied, kind: "consume_resource", resourceKey, amount, targetRef };
  }

  // ---------------------------------------------------------------------------
  // redirect_target effect_kind — rewrite the pending action card's target
  // ---------------------------------------------------------------------------
  // Action-mutation verb. Wraps the existing oni.ReactionRedirectPendingAction
  // helper so authors don't write JS to express "intercept the incoming attack
  // and aim it at me instead" (Protect, Cover, Bodyguard).
  //
  // Row fields:
  //   target_ref        string (effect_label) — references a `targeting` row
  //                      resolving WHICH target slot(s) of the originating
  //                      action card to move. Classic Protect: a row with
  //                      candidate_source: "action_targets", mode: "exact",
  //                      count: 1.
  //   destination_ref   string (effect_label) — references a targeting row
  //                      resolving WHERE the action lands. Classic Protect:
  //                      a row with candidate_source: "self".
  //   rebuild_card      boolean — whether to re-render the redirected card
  //                      (default true).
  //
  // Returns { ok: true, skipBody: true } on success — suppresses the
  // reactor's skill body (no card posts on top of the redirected card)
  // but lets the rest of the chain continue. Cost-deducting steps
  // (consume_charge / consume_resource) should be placed AFTER the
  // redirect so a cancellation in this step doesn't cost the resource.
  async function applyRedirectTargetEffect(effectRow, reactionToken, combat, ctx) {
    const redirectApi = window["oni.ReactionRedirectPendingAction"];
    if (typeof redirectApi?.redirectFromPayload !== "function") {
      return { ok: false, abort: true, reason: "redirect_api_unavailable", applied: [] };
    }

    const payload = ctx?.payload ?? null;
    if (!payload) {
      return { ok: false, abort: true, reason: "no_payload", applied: [] };
    }

    const targetingApi = globalThis?.FUCompanion?.api?.effectTargeting;
    if (typeof targetingApi?.resolveTargetRef !== "function") {
      return { ok: false, abort: true, reason: "targeting_api_unavailable", applied: [] };
    }
    const item = ctx?.item;
    if (!item) {
      return { ok: false, abort: true, reason: "no_item_in_context", applied: [] };
    }

    // Source slot — which target(s) of the incoming action card to redirect.
    const targetRef = String(effectRow.target_ref ?? "").trim();
    if (!targetRef) {
      return { ok: false, abort: true, reason: "missing_target_ref", applied: [] };
    }
    const slotResolved = await targetingApi.resolveTargetRef(item, targetRef, ctx?.effectTargetingCtx);
    if (!slotResolved?.ok || !slotResolved.tokens?.length) {
      if (slotResolved?.cancelled) {
        return { ok: false, cancelled: true, abort: true, reason: "cancelled", applied: [], targetRef };
      }
      return { ok: false, abort: true, reason: slotResolved?.reason ?? "source_slot_unresolved", applied: [], targetRef };
    }
    const protectedTargetUUIDs = slotResolved.tokens.map(td => td?.uuid).filter(Boolean);

    // Destination — where the action lands.
    const destinationRef = String(effectRow.destination_ref ?? "").trim();
    if (!destinationRef) {
      return { ok: false, abort: true, reason: "missing_destination_ref", applied: [] };
    }
    const destResolved = await targetingApi.resolveTargetRef(item, destinationRef, ctx?.effectTargetingCtx);
    if (!destResolved?.ok || !destResolved.tokens?.length) {
      if (destResolved?.cancelled) {
        return { ok: false, cancelled: true, abort: true, reason: "cancelled", applied: [], destinationRef };
      }
      return { ok: false, abort: true, reason: destResolved?.reason ?? "destination_unresolved", applied: [], destinationRef };
    }
    // redirectFromPayload's current model lands on a single token. Take the
    // first; multi-destination redirect is a future enhancement.
    const destTokenDoc = destResolved.tokens[0];
    const reactorUuid = destTokenDoc?.actor?.uuid ?? destTokenDoc?.uuid ?? null;
    const reactorTokenUuid = destTokenDoc?.uuid ?? null;
    const reactorActorUuid = destTokenDoc?.actor?.uuid ?? null;
    const reactorName = destTokenDoc?.name ?? destTokenDoc?.actor?.name ?? null;

    const rebuildCard = effectRow.rebuild_card !== false; // default true

    // We already know everything `openRedirectDialog` would prompt for:
    //   - the source action card (sourceRef from the trigger payload — the
    //     reaction was emitted FOR this card)
    //   - which target slot(s) to protect (the chosen token(s) from target_ref,
    //     resolved via the unified targeting system; the user already saw
    //     the picker there for multi-target attacks)
    //   - where to land (destination_ref, typically `self` for Protect)
    //
    // Multi-source loop: when target_ref resolves to N tokens (e.g. Hina's
    // Prophetic Defender Style targets ALL action_targets), we iterate over
    // the candidate's matchingIndexes and apply the redirect once per index.
    // The redirect script edits in-place (same messageId across iterations)
    // so successive iterations see the prior modifications without
    // re-discovery. Single-target Protect goes through the same loop with
    // one iteration — no behavior change.
    let result;
    let iterationResults = [];
    try {
      const sourceRef = redirectApi.extractSourceActionRef
        ? redirectApi.extractSourceActionRef(payload)
        : {
            sourceActionId:              payload?.meta?.sourceActionId             ?? payload?.sourceActionId             ?? null,
            sourceActionCardId:          payload?.meta?.sourceActionCardId         ?? payload?.sourceActionCardId         ?? null,
            sourceActionCardVersion:     payload?.meta?.sourceActionCardVersion    ?? payload?.sourceActionCardVersion    ?? null,
            sourceActionCardMessageId:   payload?.meta?.sourceActionCardMessageId  ?? payload?.sourceActionCardMessageId  ?? null
          };

      const candidates = await redirectApi.findPendingActionCandidates({
        sourceRef,
        protectedTargetUUIDs
      });
      const candidate = candidates?.[0] ?? null;

      if (!candidate) {
        // Source action card no longer matches (was deleted, applied, or
        // moved). Fall back to the legacy dialog as a last resort so the
        // player can pick from anything that's still pending. Falls back
        // to single-target only (the dialog flow doesn't support multi).
        console.warn(TAG, "applyRedirectTargetEffect: no candidate matched sourceRef; falling back to openRedirectDialog");
        result = await redirectApi.redirectFromPayload(payload, {
          kind: "redirect_target",
          rebuildCard,
          reactorUuid,
          protectedTargetUUIDs
        });
        iterationResults = result ? [result] : [];
      } else {
        // Loop over every matching index — one redirect per source slot.
        // Multiplicity is preserved: a 3-target attack with all 3 in the
        // protected set becomes 3 instances of "danger hits reactor",
        // matching RAW's "affects you once for each creature it was
        // threatening" semantic.
        const indexes = Array.isArray(candidate.matchingIndexes) && candidate.matchingIndexes.length
          ? candidate.matchingIndexes
          : [0];

        for (const targetIndex of indexes) {
          const originalTargetName =
            candidate.targetNames?.[targetIndex] ??
            `Target #${Number(targetIndex) + 1}`;

          const selection = {
            messageId: candidate.messageId,
            targetIndex,
            originalTargetName,
            reactorName,
            reactorTokenUuid,
            reactorActorUuid
          };
          const iterResult = await redirectApi.applyRedirectSelection(selection, {
            payload,
            rebuildCard,
            kind: "redirect_target"
          });
          iterationResults.push(iterResult);

          if (iterResult?.cancelled) {
            // First-cancel-stops; remaining indices are not redirected.
            // (Currently applyRedirectSelection doesn't have a cancel path,
            // but defending against it future-proofs the loop.)
            result = iterResult;
            break;
          }
          if (!iterResult?.ok) {
            // Bail on first hard failure so partial state is visible to
            // the chain (which will abort the consume step too).
            result = iterResult;
            break;
          }
          result = iterResult; // keep updating; last successful is "result"
        }
      }
    } catch (e) {
      return {
        ok: false, abort: true,
        reason: "redirect_threw",
        error: String(e?.message ?? e),
        applied: iterationResults.map(r => ({ ok: !!r?.ok, info: r }))
      };
    }

    if (result?.cancelled) {
      return {
        ok: true, abort: true, kind: "redirect_target",
        reason: "player_cancelled",
        applied: iterationResults.map(r => ({ ok: !!r?.ok, info: r }))
      };
    }
    if (!result?.ok) {
      return {
        ok: false, abort: true, kind: "redirect_target",
        reason: result?.reason ?? "redirect_failed",
        applied: iterationResults.map(r => ({ ok: !!r?.ok, error: r?.reason ?? null, info: r }))
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
      replacementActorUuid:  result?.replacementActorUuid ?? null,
      iterationCount:        iterationResults.length
    };

    // Success: return skipBody (not abort) so the rest of the chain
    // continues — typically a `consume_charge` / `consume_resource` step
    // that should ONLY fire when the redirect actually went through.
    // The skipBody flag still tells executeChosenReaction to suppress
    // ADF.execute (no Protect skill body should post on top of the
    // redirected card).
    return {
      ok: true, skipBody: true, kind: "redirect_target",
      applied: iterationResults.map(r => ({ ok: !!r?.ok, info: r }))
    };
  }

  // ---------------------------------------------------------------------------
  // open_action_menu effect_kind — spawn the Octopath action menu over the
  // reactor's token with a button-label filter and a one-shot "free action"
  // flag stamped on the reactor's actor.
  // ---------------------------------------------------------------------------
  // Row fields:
  //   allowed_types  string — comma-separated TurnUI button labels
  //                           (e.g. "Attack,Spell"). Other buttons render
  //                           disabled (grayed out, click-blocked).
  //   free_mode      boolean — when true, registers a pending free action
  //                            in `FUCompanion.api.freeActions` keyed by the
  //                            reactor's actor.id; ActionDataFetch consumes
  //                            the entry and bypasses the budget gate for
  //                            the next action.
  //   source_effect_uuid string — optional. Set automatically when the
  //                               trigger row came from a synthesized AE
  //                               item; the consume-charge step uses it
  //                               to drain the bonus-action grant after
  //                               the free action completes.
  //
  // Use case: Acceleration. Player picks "Acceleration" from the reaction
  // picker at turn_end; the action menu pops up with only Attack and Spell
  // enabled; whichever they click runs as a free action consuming the AE
  // charge.
  async function applyOpenActionMenuEffect(effectRow, reactionToken, combat, ctx) {
    const allowedRaw = String(effectRow.allowed_types ?? "").trim();
    const enabledLabels = allowedRaw
      ? allowedRaw.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
      : [];
    const freeMode = !!effectRow.free_mode;

    // max_mp_cost (optional, integer string). Caps the MP of any spell
    // selectable through the free Spell action; null/0/blank = no cap.
    // Used by playtest Acceleration ("a spell with total MP cost ≤ 10").
    let maxMpCost = null;
    {
      const raw = effectRow.max_mp_cost;
      if (raw != null && String(raw).trim() !== "") {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) maxMpCost = Math.floor(n);
      }
    }

    // Unwrap the dispatcher's chosen-skill wrapper to find the *real* phase
    // payload (with trigger key + source uuids + damage values). The reaction
    // chooseSkill dispatcher places the phase payload at
    // `ctx.payload.reaction_phase_payload`; synthetic tests pass the raw
    // phase payload directly. Handle both shapes.
    const outerPayload = ctx?.payload ?? null;
    const phasePayload =
      (outerPayload?.reaction_phase_payload && typeof outerPayload.reaction_phase_payload === "object" && Object.keys(outerPayload.reaction_phase_payload).length)
        ? outerPayload.reaction_phase_payload
        : outerPayload;
    const triggerKey = phasePayload?.trigger ?? outerPayload?.reaction_trigger_key ?? null;

    // target_ref (optional). When set, references a `targeting` row that
    // resolves to a single TokenDocument; we stash that token's UUID on the
    // free-action grant so consumers (Study macro, Counterattack-style flows)
    // restrict their target picker to that token. Mirrors the "on that
    // creature" clause in skills like Painful Lesson.
    //
    // Blank target_ref = no lock (free-action grant accepts any target).
    let lockedTargetTokenUuid = null;
    {
      const targetRef = String(effectRow.target_ref ?? "").trim();
      const targetingApi = globalThis?.FUCompanion?.api?.effectTargeting;
      if (targetRef && typeof targetingApi?.resolveTargetRef === "function" && ctx?.item) {
        const resolved = await targetingApi.resolveTargetRef(ctx.item, targetRef, ctx?.effectTargetingCtx);
        if (resolved?.ok && resolved.tokens?.length) {
          // First token only — open_action_menu locks to a single creature.
          // If a multi-target lock semantic ever appears, surface it here.
          const td = resolved.tokens[0];
          if (td?.uuid) lockedTargetTokenUuid = td.uuid;
        } else if (resolved?.cancelled) {
          // User backed out of the targeting picker — bail without
          // opening the action menu so the dispatcher can re-spawn the
          // reaction menu for them to pick again.
          return { ok: false, cancelled: true, abort: true, reason: "cancelled", applied: [], targetRef };
        } else {
          console.warn(TAG, "applyOpenActionMenuEffect: target_ref present but resolver returned no token", {
            targetRef,
            reason: resolved?.reason
          });
        }
      }
    }

    // check_bonus_formula / damage_bonus_formula (optional). Resolved NOW
    // against the reactor + firing skill, then stashed on the free-action
    // grant so the next action's pipeline (or a special-case macro like
    // Study) can read + apply them. Used by Painful Lesson: "perform a free
    // Study with +SL to the Check".
    let resolvedCheckBonus = 0;
    let resolvedDamageBonus = 0;
    {
      const evaluator = globalThis?.["oni.ReactionFormula"];
      const reactorActor = reactionToken?.actor ?? null;
      const firingSkill = ctx?.item ?? null;
      // For formula identifiers like DAMAGE_DEALT to resolve, the evaluator
      // needs the real phase payload (with finalValue + valueType), not the
      // dispatcher's outer wrapper. Use the same unwrap as target_lock above.
      const formulaCtx = {
        reactorActor,
        firingSkill,
        payload: phasePayload
      };
      const checkExpr = String(effectRow.check_bonus_formula ?? "").trim();
      if (checkExpr && evaluator?.evaluate) {
        try {
          const v = Number(evaluator.evaluate(checkExpr, formulaCtx)) || 0;
          if (v) resolvedCheckBonus = v;
        } catch (e) {
          console.warn(TAG, "applyOpenActionMenuEffect: check_bonus_formula failed", { expr: checkExpr, error: String(e?.message ?? e) });
        }
      }
      const dmgExpr = String(effectRow.damage_bonus_formula ?? "").trim();
      if (dmgExpr && evaluator?.evaluate) {
        try {
          const v = Number(evaluator.evaluate(dmgExpr, formulaCtx)) || 0;
          if (v) resolvedDamageBonus = v;
        } catch (e) {
          console.warn(TAG, "applyOpenActionMenuEffect: damage_bonus_formula failed", { expr: dmgExpr, error: String(e?.message ?? e) });
        }
      }
    }

    const item = ctx?.item ?? null;
    const sourceEffectUuid = item?.__sourceEffectUuid
      ?? effectRow.source_effect_uuid
      ?? null;

    const turnUI = globalThis.TurnUI ?? null;
    if (!turnUI?.spawnButtonsForToken) {
      console.warn(TAG, "applyOpenActionMenuEffect: TurnUI.spawnButtonsForToken not available.");
      return { ok: false, reason: "no_turnui", applied: [] };
    }

    const actor = reactionToken?.actor ?? null;

    // Resolve the budget label NOW (rather than letting the menu peek the
    // store later). Source of truth: the source AE's bonusActionGrant
    // .sourceLabel (e.g. "Acceleration"). Fall back to the item name and
    // then to the generic "Free Action" so the menu always shows SOMETHING
    // meaningful instead of "No Action Left".
    let budgetLabel = "Free Action";
    try {
      if (sourceEffectUuid) {
        const eff = fromUuidSync(sourceEffectUuid);
        const srcLabel = eff?.flags?.["fabula-ultima-companion"]?.bonusActionGrant?.sourceLabel;
        if (srcLabel) budgetLabel = String(srcLabel);
        else if (eff?.name) budgetLabel = String(eff.name);
      } else if (item?.name) {
        budgetLabel = String(item.name);
      }
    } catch (e) {
      console.warn(TAG, "applyOpenActionMenuEffect: budget label resolve threw (non-fatal); using fallback.", e);
    }

    if (freeMode && actor) {
      const faApi = globalThis.FUCompanion?.api?.freeActions ?? null;
      if (faApi?.set) {
        try {
          faApi.set(actor.id, {
            enabledLabels,
            sourceEffectUuid,
            maxMpCost,
            checkBonus: resolvedCheckBonus,
            damageBonus: resolvedDamageBonus,
            lockedTargetTokenUuid
          });
        } catch (e) {
          console.warn(TAG, "applyOpenActionMenuEffect: freeActions.set threw.", e);
        }
      } else {
        console.warn(TAG, "applyOpenActionMenuEffect: FUCompanion.api.freeActions unavailable; ADF gate bypass will NOT fire.");
      }

      // Drain one charge from the source AE NOW (at pick time), not at the
      // action's success terminal. Reasons:
      //   1. The action pipeline can short-circuit before reaching the
      //      success terminal (cancelled targeting, blocked execution,
      //      `combat.turn === null` causing ADF to skip the gate block) —
      //      pick-time consume is robust against all of those.
      //   2. Semantically: once the reactor picks Acceleration, they have
      //      committed to using one charge of the grant. Whether they then
      //      take the free action is a separate choice; the charge is
      //      already spent.
      // `charges.consume` with `deleteWhenEmpty: true` auto-deletes the AE
      // when the last charge drains, so an Acceleration with chargesMax=2
      // self-removes after the second pick.
      if (sourceEffectUuid) {
        const chargesApi = globalThis.FUCompanion?.api?.charges ?? null;
        if (chargesApi?.consume) {
          try {
            const eff = await fromUuid(sourceEffectUuid);
            if (eff) {
              const res = await chargesApi.consume(eff, { count: 1, deleteWhenEmpty: true });
              console.log(TAG, "applyOpenActionMenuEffect: drained 1 charge on pick.", {
                sourceEffectUuid, before: res?.before, after: res?.after, deleted: res?.deleted
              });
            } else {
              console.warn(TAG, "applyOpenActionMenuEffect: source AE not found for charge consume.", { sourceEffectUuid });
            }
          } catch (e) {
            console.warn(TAG, "applyOpenActionMenuEffect: charges.consume threw (non-fatal).", e);
          }
        } else {
          console.warn(TAG, "applyOpenActionMenuEffect: charges API unavailable; charge NOT drained.");
        }
      }
    }

    try {
      turnUI.spawnButtonsForToken(reactionToken, { enabledLabels, freeMode, budgetLabel });
    } catch (e) {
      console.warn(TAG, "applyOpenActionMenuEffect: spawnButtonsForToken threw.", e);
      return { ok: false, reason: "spawn_threw", error: String(e?.message ?? e), applied: [] };
    }

    // Fire pickerPicked manually so the substrate marks this reactor's
    // sub-window as "chose" (semantically correct — the user did pick
    // Acceleration) BEFORE we return skipBody:true. The substrate will
    // then broadcast a close tick → the reaction-buttonUI tick listener
    // schedules a 250ms leave animation. To dodge any race where an
    // unrelated spawnButton call would revive the leaving rec via
    // updateExistingButton (cancelling the finish timer), we also
    // FORCE-remove the button directly right after.
    try {
      const rs = globalThis.FUCompanion?.api?.reactionSystem;
      const phasePayload = ctx?.payload?.reaction_phase_payload ?? ctx?.payload ?? null;
      if (rs?._internals?.buildSubKey && phasePayload) {
        const bucket = rs._internals.computeBucket(phasePayload);
        const actionCardId = phasePayload?.actionCardId ?? phasePayload?.meta?.actionCardId ?? null;
        const subKey = rs._internals.buildSubKey({
          bucket, actionCardId, reactorTokenId: reactionToken.id
        });
        if (subKey) {
          Hooks.callAll("oni:reactionWindow:pickerPicked", { subKey, item });
        }
      }
      const uiApi = window["oni.ReactionButtonUI"];
      if (uiApi?.removeButton) uiApi.removeButton(reactionToken.id);
    } catch (e) {
      console.warn(TAG, "applyOpenActionMenuEffect: pickerPicked fire threw (non-fatal).", e);
    }

    return {
      ok: true,
      // skipBody is a softer cousin of `abort`: skip the chooseSkill
      // dispatcher's ADF.execute(synth) (which would pop a mysterious
      // second menu) but DON'T show a "could not fire" warning, and
      // DON'T fire pickerClosed (we already fired pickerPicked above).
      skipBody: true,
      kind: "open_action_menu",
      enabledLabels,
      freeMode,
      sourceEffectUuid,
      applied: [{ ok: true, info: { tokenId: reactionToken.id, enabledLabels, freeMode } }]
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
    let chainSkipBody = false;
    for (const stepLabel of steps) {
      const res = await applyEffectByLabel(item, stepLabel, reactionToken, combat, ctx?.payload, {
        isPassive: !!ctx?.isPassive,
        effectTargetingCtx: ctx?.effectTargetingCtx ?? null
      });
      stepResults.push({ stepLabel, result: res });
      // Propagate skipBody from any step — chain rolls it up so the
      // dispatcher knows to skip ADF.execute when the chain contains a
      // self-contained effect (e.g. redirect_target or open_action_menu).
      if (res?.skipBody) chainSkipBody = true;
      if (res?.cancelled) {
        return {
          ok: false, cancelled: true, abort: true, kind: "chain",
          chainSteps: steps, applied: stepResults, failedAt: stepLabel,
          skipBody: chainSkipBody
        };
      }
      if (res?.abort) {
        return {
          ok: res.ok !== false, abort: true, kind: "chain",
          chainSteps: steps, applied: stepResults,
          skipBody: chainSkipBody
        };
      }
      if (res?.ok === false) {
        return {
          ok: false, abort: true, kind: "chain",
          chainSteps: steps, applied: stepResults,
          reason: "step_failed", failedAt: stepLabel,
          skipBody: chainSkipBody
        };
      }
    }
    return { ok: true, kind: "chain", chainSteps: steps, applied: stepResults, skipBody: chainSkipBody };
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
  async function applyEffectByLabel(item, effectLabel, reactionToken, combat = game.combat, payload = null, opts = {}) {
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
    // ctx threads cross-handler context:
    //   item                 — for chain step lookups
    //   payload              — trigger phase data
    //   isPassive            — true when this came from the auto-passive
    //                          runner; handlers can use it to skip user UI
    //                          when the result is unambiguous.
    //   effectTargetingCtx   — chain ctx for the unified targeting resolver
    //                          (Map of resolved target_ref → tokens, shared
    //                          across all handlers in this chain so the same
    //                          target_ref isn't prompted twice). Lazy-created
    //                          here when an opts.effectTargetingCtx isn't
    //                          already in flight from a parent invocation.
    const targetingApi = globalThis?.FUCompanion?.api?.effectTargeting;
    const effectTargetingCtx =
      opts.effectTargetingCtx
      ?? (typeof targetingApi?.makeChainCtx === "function"
        ? targetingApi.makeChainCtx({
            reactorActor: reactionToken?.actor,
            reactorToken: reactionToken?.document ?? reactionToken,
            phasePayload: payload ?? {},
            triggerKey: payload?.trigger ?? payload?.reaction_trigger_key ?? null,
            isPassive: !!opts.isPassive,
            combat
          })
        : null);
    const ctx = { item, payload, isPassive: !!opts.isPassive, effectTargetingCtx };
    let result;
    switch (kind) {
      case "grant":
        result = await applyGrantEffect(effectRow, reactionToken, combat, ctx);
        break;
      case "apply_ae":
        result = await applyApplyAeEffect(effectRow, reactionToken, combat, ctx);
        break;
      case "consume_charge":
        result = await applyConsumeChargeEffect(effectRow, reactionToken, combat, ctx);
        break;
      case "consume_resource":
        result = await applyConsumeResourceEffect(effectRow, reactionToken, combat, ctx);
        break;
      case "redirect_target":
        result = await applyRedirectTargetEffect(effectRow, reactionToken, combat, ctx);
        break;
      case "chain":
        result = await applyChainEffect(effectRow, reactionToken, combat, ctx);
        break;
      case "open_action_menu":
        result = await applyOpenActionMenuEffect(effectRow, reactionToken, combat, ctx);
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
    if (!chosenGroup) return { results, aborted: false, skipBody: false };

    let skipBody = false;
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
        if (res?.skipBody) skipBody = true;
        if (res?.cancelled) {
          // User cancelled a targeting picker mid-dispatch. Surface the
          // signal distinctly from a hard abort so the caller can
          // re-spawn the reaction menu instead of treating it as a
          // resource-gate failure.
          return {
            results,
            aborted: true,
            cancelled: true,
            skipBody: false,
            abortInfo: { itemName: item?.name ?? null, effectLabel: ref, result: res }
          };
        }
        if (res?.abort) {
          return {
            results,
            aborted: true,
            skipBody,
            abortInfo: { itemName: item?.name ?? null, effectLabel: ref, result: res }
          };
        }
      }
    }
    return { results, aborted: false, skipBody };
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
}
