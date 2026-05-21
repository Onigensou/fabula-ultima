/**
 * [ONI] Effect Targeting Resolver (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * The runtime side of the unified `effect_kind: "targeting"` system documented
 * in `docs/reaction-config-schema.md`. Per-kind effect handlers read their
 * recipient list by calling `resolveTargetRef(item, targetRef, ctx)` instead
 * of doing their own ad-hoc target resolution from per-kind fields.
 *
 *   - Lazy: a targeting row is evaluated only when first demanded by a
 *     consumer's `target_ref` / `destination_ref`.
 *   - Memoized: the same `target_ref` referenced twice in one chain
 *     resolves once and returns the same TokenDocument list both times.
 *     (Critical so the player isn't asked to pick the same target twice
 *     when, say, both `consume_charge` and `redirect_target` reference the
 *     same `self_target` row.)
 *   - JRPG-backed: the prompt path delegates to
 *     `JRPGTargeting.requestTargeting`, so socket routing, player-side
 *     prompts, allowlist enforcement, and canvas highlight all work
 *     unchanged.
 *
 * Exposed:
 *   globalThis.FUCompanion.api.effectTargeting.resolveTargetRef(item, targetRef, ctx)
 *   globalThis.FUCompanion.api.effectTargeting.makeChainCtx({...})
 *
 * `ctx` shape (chain execution context — created by the dispatcher at the
 * top of a chain and threaded down through `applyEffectByLabel` calls):
 *
 *   {
 *     reactorActor:    Actor,
 *     reactorToken:    Token | TokenDocument,
 *     phasePayload:    object,        // the trigger phase payload
 *     triggerKey:      string,
 *     isPassive:       boolean,
 *     combat:          Combat | null,
 *     resolvedTargets: Map<string, ResolveResult>   // memo cache
 *   }
 *
 *   ResolveResult = { ok: true, tokens: TokenDocument[] }
 *                 | { ok: false, reason: string, tokens: [] }
 * ---------------------------------------------------------------------------
 */

(() => {
  const TAG = "[EffectTargetingResolver]";
  const NS = "fabula-ultima-companion";

  // Run on `ready` for fresh boots; run immediately if `ready` has already
  // fired (dynamic-install via evalGM during dev iteration). The latter
  // matters because `Hooks.once("ready", fn)` does NOT call fn if ready
  // has already passed — the listener just sits idle until the next reload.
  function install() {
    if (globalThis?.FUCompanion?.api?.effectTargeting?.resolveTargetRef) {
      console.debug(TAG, "Already installed.");
      return;
    }
    _install();
  }

  if (globalThis?.game?.ready) install();
  else Hooks.once("ready", install);
})();

function _install() {
  const TAG = "[EffectTargetingResolver]";
  const NS = "fabula-ultima-companion";

  // -------------------------------------------------------------------------
  // Helpers — token resolution
  // -------------------------------------------------------------------------

  // Resolve a uuid-ish string (Token UUID, Actor UUID, raw token id) into a
  // TokenDocument. Mirrors reaction-triggerCore's findTokenByUuidish — kept
  // small and inline to avoid a hard cross-module dependency.
  function findTokenDocByUuidish(uuidish, combat = game.combat) {
    if (!uuidish || typeof uuidish !== "string") return null;

    // Direct token id on canvas.
    const direct = canvas?.tokens?.get?.(uuidish);
    if (direct?.document) return direct.document;

    // Scene.x.Token.y form.
    const m = uuidish.match(/\.Token\.([A-Za-z0-9]+)$/);
    if (m) {
      const tok = canvas?.tokens?.get?.(m[1]);
      if (tok?.document) return tok.document;
    }

    try {
      const doc = (typeof fromUuidSync === "function") ? fromUuidSync(uuidish) : null;
      if (!doc) return null;
      if (doc.documentName === "Token" || doc.documentName === "TokenDocument") return doc;
      if (doc.documentName === "Actor") {
        // Prefer a combat token.
        const cmbts = combat?.combatants?.contents ?? combat?.combatants ?? [];
        for (const c of cmbts) {
          const cTok = c?.token ?? canvas?.tokens?.get?.(c?.tokenId)?.document ?? null;
          if (cTok?.actor?.uuid === doc.uuid) return cTok;
        }
        const active = doc.getActiveTokens?.(true, true) ?? doc.getActiveTokens?.() ?? [];
        const first = active?.[0];
        return first?.document ?? first ?? null;
      }
    } catch (_e) {}
    return null;
  }

  function dedupTokens(list) {
    const seen = new Set();
    const out = [];
    for (const t of list ?? []) {
      const id = t?.id ?? t?.document?.id ?? null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(t.document ?? t);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Helpers — effect row lookup
  // -------------------------------------------------------------------------

  function readEffectTable(item) {
    const props = item?.system?.props ?? {};
    const tbl = props?.effect_table ?? props?.reaction_effect_table ?? null;
    if (!tbl) return [];
    if (Array.isArray(tbl)) return tbl.filter(r => r && typeof r === "object" && !r.$deleted);
    return Object.values(tbl).filter(r => r && typeof r === "object" && !r.$deleted);
  }

  function findEffectByLabel(item, label) {
    const ref = String(label ?? "").trim();
    if (!ref) return null;
    for (const row of readEffectTable(item)) {
      if (String(row?.effect_label ?? "").trim() === ref) return row;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Candidate pool — driven by candidate_source
  // -------------------------------------------------------------------------

  function combatTokens(combat) {
    const cmbts = combat?.combatants?.contents ?? combat?.combatants ?? [];
    const out = [];
    for (const c of cmbts) {
      const td = c?.token ?? canvas?.tokens?.get?.(c?.tokenId)?.document ?? null;
      if (td) out.push(td);
    }
    return out;
  }

  function resolveTokensFromShape(shape, payload, combat) {
    if (!shape || !payload) return [];
    const out = [];

    // tokenFields / tokenListFields hold uuid-ish strings.
    for (const f of shape.tokenFields ?? []) {
      const t = findTokenDocByUuidish(payload?.[f], combat);
      if (t) out.push(t);
    }
    for (const f of shape.tokenListFields ?? []) {
      for (const u of payload?.[f] ?? []) {
        const t = findTokenDocByUuidish(u, combat);
        if (t) out.push(t);
      }
    }

    // actorFields / actorListFields hold Actor uuids — resolve via combat.
    const resolveActorToToken = (actorUuid) => {
      if (!actorUuid) return null;
      const cmbts = combat?.combatants?.contents ?? combat?.combatants ?? [];
      for (const c of cmbts) {
        const td = c?.token ?? canvas?.tokens?.get?.(c?.tokenId)?.document ?? null;
        if (td?.actor?.uuid === actorUuid) return td;
      }
      return null;
    };
    for (const f of shape.actorFields ?? []) {
      const t = resolveActorToToken(payload?.[f]);
      if (t) out.push(t);
    }
    for (const f of shape.actorListFields ?? []) {
      for (const u of payload?.[f] ?? []) {
        const t = resolveActorToToken(u);
        if (t) out.push(t);
      }
    }

    return dedupTokens(out);
  }

  function buildCandidatePool(effectRow, ctx) {
    const source = String(effectRow?.candidate_source ?? "combat").trim().toLowerCase();
    const combat = ctx?.combat ?? game.combat;

    switch (source) {
      case "self": {
        const td = ctx?.reactorToken?.document ?? ctx?.reactorToken;
        return td ? [td] : [];
      }
      case "combat":
        return combatTokens(combat);
      case "trigger_subject": {
        const registry = window["oni.ReactionTriggers"];
        const shape = registry?.subjectShapeFor?.(ctx?.triggerKey);
        return shape ? resolveTokensFromShape(shape, ctx?.phasePayload, combat) : [];
      }
      case "trigger_actor": {
        const registry = window["oni.ReactionTriggers"];
        const shape = registry?.damageSourceShapeFor?.(ctx?.triggerKey);
        return shape ? resolveTokensFromShape(shape, ctx?.phasePayload, combat) : [];
      }
      case "action_targets": {
        const payload = ctx?.phasePayload ?? {};
        const out = [];
        for (const f of ["targetUuid", "targetTokenUuid"]) {
          const t = findTokenDocByUuidish(payload?.[f], combat);
          if (t) out.push(t);
        }
        for (const f of ["targets", "targetTokenUuids"]) {
          for (const u of payload?.[f] ?? []) {
            const t = findTokenDocByUuidish(u, combat);
            if (t) out.push(t);
          }
        }
        return dedupTokens(out);
      }
      default:
        console.warn(TAG, `unknown candidate_source "${source}"; returning empty pool`);
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // Disposition filter — category
  // -------------------------------------------------------------------------

  function filterByCategory(tokens, category, reactorToken) {
    const cat = String(category ?? "").trim().toLowerCase();
    if (!cat || cat === "creature") return tokens.slice();

    const reactorDoc = reactorToken?.document ?? reactorToken;
    const reactorDisp = reactorDoc?.disposition ?? 0;

    return tokens.filter(td => {
      const d = td?.disposition ?? 0;
      // ally = same side as reactor + neutral (-2 / 0 / reactor's side)
      if (cat === "ally") {
        if (reactorDisp >= 0) return d >= 0 || d === -2;
        return d <= 0;
      }
      if (cat === "enemy") {
        if (reactorDisp >= 0) return d < 0 && d !== -2 ? true : d === -2;
        return d >= 0 || d === -2;
      }
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Build a JRPG parsedTargeting from the effect_row
  // -------------------------------------------------------------------------

  function buildParsedTargetingForRow(effectRow) {
    const mode = String(effectRow?.mode ?? "exact").trim().toLowerCase();
    const category = String(effectRow?.category ?? "").trim().toLowerCase() || "creature";
    const rawCount = effectRow?.count;
    const count = Number.isFinite(Number(rawCount)) ? Math.max(0, Number(rawCount)) : 1;

    const MODES = {
      EXACT: "exact",
      UP_TO: "up_to",
      ALL:   "all"
    };

    if (mode === MODES.ALL) {
      return {
        raw: "",
        normalized: "all",
        recognized: true,
        mode: "all",
        category,
        count: null,
        minTargets: null,
        maxTargets: null,
        autoSelectAll: true,
        acceptsZero: true,
        promptText: `Pick all eligible ${category}${category === "creature" ? "s" : ""}`
      };
    }
    if (mode === MODES.UP_TO) {
      return {
        raw: "",
        normalized: "up_to",
        recognized: true,
        mode: "up_to",
        category,
        count,
        minTargets: 0,
        maxTargets: count,
        autoSelectAll: false,
        acceptsZero: true,
        promptText: `Pick up to ${count} ${category}${count === 1 ? "" : "s"}`
      };
    }
    // exact (default)
    return {
      raw: "",
      normalized: "exact",
      recognized: true,
      mode: "exact",
      category,
      count,
      minTargets: count,
      maxTargets: count,
      autoSelectAll: false,
      acceptsZero: false,
      promptText: `Pick ${count} ${category}${count === 1 ? "" : "s"}`
    };
  }

  // -------------------------------------------------------------------------
  // Core resolver
  // -------------------------------------------------------------------------

  // Public: create a fresh chain ctx. The dispatcher calls this once per
  // top-level applyEffectsForGroup invocation and threads the result down.
  function makeChainCtx({ reactorActor, reactorToken, phasePayload, triggerKey, isPassive, combat }) {
    return {
      reactorActor: reactorActor ?? null,
      reactorToken: reactorToken ?? null,
      phasePayload: phasePayload ?? {},
      triggerKey: String(triggerKey ?? ""),
      isPassive: !!isPassive,
      combat: combat ?? game.combat ?? null,
      resolvedTargets: new Map()
    };
  }

  function memoize(ctx, targetRef, result) {
    ctx?.resolvedTargets?.set?.(targetRef, result);
    return result;
  }

  async function resolveTargetRef(item, targetRef, ctx) {
    const ref = String(targetRef ?? "").trim();
    if (!ref) return { ok: false, reason: "missing_target_ref", tokens: [] };
    if (!item) return { ok: false, reason: "missing_item", tokens: [] };
    if (!ctx?.resolvedTargets) {
      console.warn(TAG, "resolveTargetRef called without a chain ctx — creating ephemeral one");
      ctx = makeChainCtx({ reactorActor: null, reactorToken: null });
    }

    // Memo hit?
    if (ctx.resolvedTargets.has(ref)) return ctx.resolvedTargets.get(ref);

    const effectRow = findEffectByLabel(item, ref);
    if (!effectRow) {
      return memoize(ctx, ref, { ok: false, reason: "targeting_row_not_found", tokens: [] });
    }
    const kind = String(effectRow.effect_kind ?? "").trim().toLowerCase();
    if (kind !== "targeting") {
      console.warn(TAG, `target_ref "${ref}" points at effect_kind "${kind}", not "targeting"`);
      return memoize(ctx, ref, { ok: false, reason: "ref_not_targeting", tokens: [] });
    }

    // 1+2+3. Candidate pool + category filter + exclude_self filter.
    const pool = buildCandidatePool(effectRow, ctx);
    let filtered = filterByCategory(pool, effectRow.category, ctx.reactorToken);
    if (effectRow.exclude_self) {
      const reactorTokenId = ctx?.reactorToken?.id ?? ctx?.reactorToken?.document?.id ?? null;
      const reactorActorUuid = ctx?.reactorActor?.uuid ?? null;
      filtered = filtered.filter(td => {
        if (reactorTokenId && (td?.id === reactorTokenId)) return false;
        if (reactorActorUuid && (td?.actor?.uuid === reactorActorUuid)) return false;
        return true;
      });
    }

    if (!filtered.length) {
      return memoize(ctx, ref, { ok: false, reason: "no_candidates", tokens: [] });
    }

    // 3. Decide whether to prompt.
    const mode = String(effectRow.mode ?? "exact").trim().toLowerCase();
    const skipPassive = effectRow.skip_when_passive !== false; // default true
    const autoConfirm = effectRow.auto_confirm_when_obvious !== false; // default true

    if (skipPassive && ctx.isPassive) {
      return memoize(ctx, ref, { ok: true, tokens: filtered.slice(), autoResolved: "passive_skip" });
    }
    if (autoConfirm && filtered.length === 1) {
      return memoize(ctx, ref, { ok: true, tokens: filtered.slice(), autoResolved: "single_candidate" });
    }
    if (mode === "all") {
      return memoize(ctx, ref, { ok: true, tokens: filtered.slice(), autoResolved: "mode_all" });
    }

    // 4. Prompt via JRPGTargeting.
    const jrpg = globalThis?.__ONI_JRPG_TARGETING_API__
              ?? game?.modules?.get?.(NS)?.api?.JRPGTargeting
              ?? null;
    if (typeof jrpg?.requestTargeting !== "function") {
      console.error(TAG, "JRPGTargeting.requestTargeting unavailable; cannot prompt");
      return memoize(ctx, ref, { ok: false, reason: "jrpg_unavailable", tokens: [] });
    }

    const allowedUuids = filtered.map(td => td?.uuid).filter(Boolean);
    const parsedTargeting = buildParsedTargetingForRow(effectRow);

    let picked;
    try {
      picked = await jrpg.requestTargeting({
        sourceActorUuid: ctx.reactorActor?.uuid ?? null,
        userId: game.user?.id,
        parsedTargeting,
        allowedTargetTokenUuids: allowedUuids,
        uiTitleText: `Pick targets — ${item.name ?? ref}`
      });
    } catch (err) {
      console.error(TAG, "requestTargeting threw:", err);
      return memoize(ctx, ref, { ok: false, reason: "jrpg_threw", error: String(err?.message ?? err), tokens: [] });
    }

    if (!picked?.ok) {
      const wasCancelled = !!picked?.cancelled;
      return memoize(ctx, ref, {
        ok: false,
        cancelled: wasCancelled,
        reason: wasCancelled ? "cancelled" : (picked?.reason ?? "pick_failed"),
        tokens: []
      });
    }

    // requestTargeting returns Token (placeable) objects — normalize to docs.
    const pickedDocs = (picked.tokens ?? []).map(t => t?.document ?? t).filter(Boolean);
    return memoize(ctx, ref, { ok: true, tokens: pickedDocs });
  }

  // -------------------------------------------------------------------------
  // Iteration mode helper — handlers use this to dispatch "together" vs
  // "per_token" when invoking their effect against the resolved list.
  // -------------------------------------------------------------------------
  //
  //   await runForEach(resolveResult, async (tokensSlice) => { ... apply ... });
  //
  // The targeting row's `iteration_mode`:
  //   - "together" (default): invokes fn once with the full token array.
  //   - "per_token":          invokes fn once per token, each call receiving
  //                           a 1-element array.
  //
  // Handlers stay agnostic about which mode is in play — they just describe
  // "what to do given a list" and let this helper handle the dispatch.
  async function runForEach(item, targetRef, resolveResult, fn) {
    if (!resolveResult?.ok) return { ok: false, invocations: 0, results: [] };
    const row = findEffectByLabel(item, targetRef);
    const mode = String(row?.iteration_mode ?? "together").trim().toLowerCase();
    const tokens = resolveResult.tokens ?? [];

    if (mode === "per_token") {
      const results = [];
      for (const td of tokens) {
        try {
          results.push(await fn([td]));
        } catch (err) {
          results.push({ ok: false, error: String(err?.message ?? err) });
        }
      }
      return { ok: true, invocations: results.length, results };
    }
    // together (default)
    try {
      const r = await fn(tokens);
      return { ok: true, invocations: 1, results: [r] };
    } catch (err) {
      return { ok: false, invocations: 1, results: [{ ok: false, error: String(err?.message ?? err) }] };
    }
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
  globalThis.FUCompanion.api.effectTargeting = {
    resolveTargetRef,
    makeChainCtx,
    runForEach,
    // Internals — exposed for unit tests / debugging.
    _internals: {
      buildCandidatePool,
      filterByCategory,
      buildParsedTargetingForRow,
      findEffectByLabel,
      readEffectTable
    }
  };

  console.debug(TAG, "Installed. globalThis.FUCompanion.api.effectTargeting ready.");
}
