// ─────────────────────────────────────────────────────────────
// ResourceGate — Foundry V12
// Purpose:
//  • Block unaffordable actions BEFORE the Action Card is created.
//  • Only SPEND LATER (on Apply / execution) — this macro just checks & forwards.
//
// Expects (__AUTO/__PAYLOAD headless style):
//  • __PAYLOAD.meta.costRaw          ← original cost (usually from item)
//  • OPTIONAL overrides:
//      - __PAYLOAD.meta.costRawOverride
//      - __PAYLOAD.meta.costRawFinal
//  • __PAYLOAD.meta.attackerUuid
//  • __PAYLOAD.targets (or originalTargetUUIDs) for “x T” costs
//
// Normal manual flow:
//  • If affordable → attaches meta.costsNormalized and forwards to CreateActionCard.
//  • If not affordable → warns and stops (no card).
//
// Defensive auto-passive flow:
//  • If a passive execution reaches ResourceGate, DO NOT create a card.
//  • Instead, attach meta.costsNormalized and hand off directly to
//    FUCompanion.api.actionExecution.execute(...).
// ─────────────────────────────────────────────────────────────
(async () => {
  const U = FUCompanion.Utilities;
  const runId = `RG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const { log, warn, err } = FUCompanion.createLogger(`[ONI][ResourceGate] ${runId}`);

  let AUTO = false, PAYLOAD = {};
  if (typeof __AUTO !== "undefined") { AUTO = __AUTO; PAYLOAD = __PAYLOAD ?? {}; }

  if (!PAYLOAD?.meta) return ui.notifications?.error("ResourceGate: Missing payload meta.");

  PAYLOAD.meta = PAYLOAD.meta || {};
  PAYLOAD.core = PAYLOAD.core || {};

  const meta = PAYLOAD.meta;
  const source = U.str(PAYLOAD?.source, "Skill");
  const sourceLc = U.norm(source);

  // Local check adds a `source === autopassive` rail on top of the shared helper
  const isAutoPassive = FUCompanion.Payload.isPassiveExecution(PAYLOAD) || sourceLc === "autopassive";

  const targetList = U.dedupe(FUCompanion.Payload.getTargets(PAYLOAD));
  const TARGETS_COUNT = targetList.length ? targetList.length : 1;

  // ---------------- Cost source selection ----------------
  // Preserve original cost the first time Gate sees it (so you can inspect later)
  if (meta.costRawOriginal === undefined) {
    meta.costRawOriginal = U.str(meta.costRaw);
  }

  // Final cost priority: costRawFinal → costRawOverride → costRaw
  const costRawFinal = FUCompanion.Payload.getCost(PAYLOAD);

  const attackerUuid = meta.attackerUuid || null;

  log("START", {
    source,
    executionMode: U.str(meta.executionMode),
    isAutoPassive,
    attackerUuid,
    skillName: PAYLOAD?.core?.skillName ?? null,
    targetsCount: TARGETS_COUNT,
    targetList,
    costRawOriginal: meta.costRawOriginal,
    costRawOverride: meta.costRawOverride ?? null,
    costRawFinal: meta.costRawFinal ?? null,
    usedCost: costRawFinal
  });

  async function forwardToCreateActionCard(payload) {
    const card = game.macros.getName("CreateActionCard");
    if (!card) {
      return FUCompanion.ErrorResponse.notifyAndErr(
        "create_action_card_not_found",
        'ResourceGate: Macro "CreateActionCard" not found or no permission.'
      );
    }

    log("FORWARD → CreateActionCard", {
      skillName: payload?.core?.skillName ?? null,
      targetsCount: (Array.isArray(payload?.originalTargetUUIDs) ? payload.originalTargetUUIDs.length : 0),
      costsNormalized: payload?.meta?.costsNormalized ?? []
    });

    await card.execute({ __AUTO: true, __PAYLOAD: payload });
    return { ok: true, forwardedTo: "CreateActionCard" };
  }

  async function forwardToExecutionCore(payload) {
    const executor = globalThis.FUCompanion?.api?.actionExecution?.execute ?? null;
    if (!executor) {
      return FUCompanion.ErrorResponse.notifyAndErr(
        "action_execution_core_not_found",
        "ResourceGate: Action Execution Core API not found."
      );
    }

    payload.meta = payload.meta || {};
    payload.meta.executionMode = "autoPassive";
    payload.meta.isPassiveExecution = true;

    log("FORWARD → ActionExecutionCore", {
      skillName: payload?.core?.skillName ?? null,
      attackerUuid: payload?.meta?.attackerUuid ?? null,
      targetsCount: (Array.isArray(payload?.originalTargetUUIDs) ? payload.originalTargetUUIDs.length : 0),
      costsNormalized: payload?.meta?.costsNormalized ?? []
    });

    return await executor({
      actionContext: payload,
      args: {},
      chatMsgId: null,
      executionMode: "autoPassive",
      confirmingUserId: game.userId ?? null,
      skipVisualFeedback: false
    });
  }

  async function forwardByMode(payload) {
    if (isAutoPassive) return await forwardToExecutionCore(payload);
    return await forwardToCreateActionCard(payload);
  }

  // ---------------- Early allow (no/zero cost) ----------------
  const ZEROish = !costRawFinal
               || costRawFinal === "-"
               || /^\s*\+?\s*0(\s*[%]?\s*(?:x|\*)\s*T)?\s*[a-z]*\s*$/i.test(costRawFinal);

  if (ZEROish) {
    PAYLOAD.meta.costsNormalized = []; // nothing to spend
    log("ALLOW (zero-ish cost)", { usedCost: costRawFinal, isAutoPassive });
    return await forwardByMode(PAYLOAD);
  }

  // ---------------- Resolve actor ----------------
  const actor = await FUCompanion.ActorResolver.fromUuid(attackerUuid);
  if (!actor) return ui.notifications?.error("ResourceGate: Could not resolve attacker actor.");

  const props = actor.system?.props ?? actor.system ?? {};

  // ---------------- Supported resources ----------------
  const RESOURCES = {
    mp: { cur: "current_mp", max: "max_mp", label: "MP" },
    ip: { cur: "current_ip", max: "max_ip", label: "IP" },
  };

  // ---------------- Parsing helpers ----------------
  // Accept tokens like:
  //  "10 MP", "20% MP", "10 x T MP", "20% x T MP", "1 IP"
  // Split lists like "5 MP + 1 IP" or "10% MP, 1 IP"
  function splitCostList(raw) {
    return String(raw)
      .split(/[,]+|[+\/&]+/g)
      .map(s => s.trim())
      .filter(Boolean);
  }

  function parseOneTokenT(token, T) {
    const str = String(token).trim();

    // resource key must be the trailing word
    const rm = str.match(/^(.+?)\s*([a-z]+)$/i); // [amountExpr, resource]
    if (!rm) return null;
    const amountExpr = rm[1].trim();
    const typeKey = (rm[2] || "").toLowerCase();
    if (!RESOURCES[typeKey]) return null;

    // Accept:
    //  N
    //  N%
    //  N x T
    //  N% x T
    const pm =
      amountExpr.match(/^(\d+)\s*(%?)\s*(?:(?:x|\*)\s*T)?$/i) ||
      amountExpr.match(/^(\d+)\s*(?:(?:x|\*)\s*T)\s*(%?)$/i);
    if (!pm) return null;

    const base = Number(pm[1] || 0);
    const isPct = !!pm[2];
    const usesT = /(?:^|\s)(?:x|\*)\s*T(?:\s|$)/i.test(amountExpr);

    return { type: typeKey, base, isPct, usesT, T };
  }

  function parseCostListT(raw, T) {
    return splitCostList(raw).map(tok => parseOneTokenT(tok, T)).filter(Boolean);
  }

  const parsed = parseCostListT(costRawFinal, TARGETS_COUNT);
  log("PARSE", { usedCost: costRawFinal, parsed, isAutoPassive });

  // Unknown/unsupported format → do not block; just forward
  if (!parsed.length) {
    PAYLOAD.meta.costsNormalized = [];
    warn("UNKNOWN COST FORMAT → not blocking (forwarding)", {
      usedCost: costRawFinal,
      isAutoPassive
    });
    return await forwardByMode(PAYLOAD);
  }

  // ---------------- Compute spend plan ----------------
  const spendPlan = parsed.map(c => {
    const defs = RESOURCES[c.type];
    const cur  = Number(props?.[defs.cur] ?? 0) || 0;
    const mx   = Number(props?.[defs.max] ?? 0) || 0;

    const baseReq = c.isPct ? Math.ceil((mx * c.base) / 100) : c.base;
    const req = baseReq * (c.usesT ? c.T : 1);

    return {
      type: c.type,
      label: defs.label,
      req,
      cur,
      mx,
      curKey: defs.cur,
      maxKey: defs.max,
    };
  });

  log("SPEND PLAN", spendPlan);

  // ---------------- Affordability check ----------------
  const lacking = spendPlan.filter(x => x.cur < x.req);
  if (lacking.length) {
    const msg = lacking.map(x => `${x.label} ${x.req} needed (you have ${x.cur})`).join(", ");
    ui.notifications?.warn?.(`Not enough resources: ${msg}`);
    warn("BLOCK (not affordable)", { lacking, usedCost: costRawFinal, isAutoPassive });
    return; // block: no card / no execution
  }

  // Attach normalized costs so Apply / execution core can spend later
  PAYLOAD.meta.costsNormalized = spendPlan;
  log("ALLOW (affordable)", { usedCost: costRawFinal, isAutoPassive, spendPlan });

  return await forwardByMode(PAYLOAD);
})();
