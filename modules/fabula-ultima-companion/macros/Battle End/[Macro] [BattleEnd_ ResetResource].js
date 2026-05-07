// ============================================================================
// [BattleEnd: ResetResource] • Foundry VTT v12
// ----------------------------------------------------------------------------
// Purpose:
// - Reset battle-only custom actor resources after battle ends.
// - Designed as a separate BattleEnd step after Cleanup.
// - Uses a central reset/persist policy so this stays modular and scalable.
//
// Current policy:
//   RESET after battle:
//     - Brainwave Clock  -> system.props.clock_brainwave
//     - Adoration Clock  -> system.props.clock_adoration
//
//   PERSIST after battle:
//     - Trade Points     -> system.props.clock_trade
//     - Resource X       -> system.props.resource_value_1 / 2 / 3 / etc.
//
// Expected Manager payload:
//   globalThis.__PAYLOAD = {
//     resetResource: {
//       actorIds: ["actorId1", "actorId2", ...]
//     }
//   }
//
// Safe fallback:
// - If no injected payload exists, this script tries to read the latest
//   BattleInit canonical payload before giving up.
// ============================================================================

(async () => {
  const DEBUG = true;

  const tag = "[BattleEnd:ResetResource]";
  const log = (...a) => DEBUG && console.log(tag, ...a);
  const warn = (...a) => console.warn(tag, ...a);

  // --------------------------------------------------------------------------
  // CONFIG
  // --------------------------------------------------------------------------

  const STORE_SCOPE = "world";
  const CANONICAL_KEY = "battleInit.latestPayload";

  // Resources that SHOULD reset after battle.
  const RESET_RESOURCE_KEYS = new Set([
    "clock_brainwave",
    "clock_adoration"
  ]);

  // Resources that SHOULD persist after battle.
  const PERSIST_RESOURCE_KEYS = new Set([
    "clock_trade",
    "resource_value_1",
    "resource_value_2",
    "resource_value_3"
  ]);

  // Future-proof: Resource 4, Resource 5, etc. also persist by default.
  const RESOURCE_VALUE_RE = /^resource_value_\d+$/i;

  // Unknown custom resources should NOT reset unless you explicitly add them above.
  const UNKNOWN_RESOURCE_BEHAVIOR = "persist";

  // --------------------------------------------------------------------------
  // Guards
  // --------------------------------------------------------------------------

  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleEnd: ResetResource is GM-only.");
    return;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  function safeNumber(v, fallback = 0) {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : fallback;
  }

  function parseIsoToMs(iso) {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? t : 0;
  }

  function uniq(arr) {
    return [...new Set((arr ?? []).map(x => String(x ?? "").trim()).filter(Boolean))];
  }

  function getActorProp(actor, key) {
    return foundry.utils.getProperty(actor, `system.props.${key}`);
  }

  function actorHasProp(actor, key) {
    const props = actor?.system?.props;
    if (!props || typeof props !== "object") return false;
    return Object.prototype.hasOwnProperty.call(props, key);
  }

  function decideResourcePolicy(key) {
    const k = String(key ?? "").trim();

    if (RESET_RESOURCE_KEYS.has(k)) return "reset";
    if (PERSIST_RESOURCE_KEYS.has(k)) return "persist";
    if (RESOURCE_VALUE_RE.test(k)) return "persist";

    return UNKNOWN_RESOURCE_BEHAVIOR;
  }

  function isResourceLikeKey(key) {
    const k = String(key ?? "").trim();
    return (
      k.startsWith("clock_") ||
      RESOURCE_VALUE_RE.test(k) ||
      RESET_RESOURCE_KEYS.has(k) ||
      PERSIST_RESOURCE_KEYS.has(k)
    );
  }

  function extractLabelNearNumberField(fieldNode) {
    // This is only for nicer debug logs.
    // The sheet structure usually stores a label right before the numberField.
    return String(fieldNode?.__nearLabel ?? "").trim();
  }

  function scanNumberFieldsFromActorSheet(actor) {
    const root = actor?.system?.body?.contents;
    const found = new Map();

    function walk(node, previousLabel = "") {
      if (!node) return;

      if (Array.isArray(node)) {
        let lastLabel = previousLabel;

        for (const child of node) {
          if (child?.type === "label" && String(child?.value ?? "").trim()) {
            lastLabel = String(child.value).trim();
          }

          if (child && typeof child === "object") {
            if (child.type === "numberField" && child.key) {
              child.__nearLabel = lastLabel;
            }

            walk(child, lastLabel);
          }
        }

        return;
      }

      if (typeof node !== "object") return;

      if (node.type === "numberField" && node.key) {
        const key = String(node.key).trim();

        if (!found.has(key)) {
          found.set(key, {
            key,
            defaultValue: node.defaultValue,
            minVal: node.minVal,
            maxVal: node.maxVal,
            label: extractLabelNearNumberField(node),
            raw: node
          });
        }
      }

      // Important: recurse into nested panels/tables/tabs.
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") {
          walk(value, previousLabel);
        }
      }
    }

    walk(root);
    return [...found.values()];
  }

  function pickLatestPayloadAcrossScenes() {
    let best = null;

    for (const s of game.scenes?.contents ?? []) {
      const p = s.getFlag(STORE_SCOPE, CANONICAL_KEY);
      if (!p) continue;

      const createdAtMs =
        parseIsoToMs(p?.meta?.createdAt) ||
        Number(p?.step4?.transitionedAt ?? 0) ||
        0;

      if (!best || createdAtMs > best.createdAtMs) {
        best = { scene: s, payload: p, createdAtMs };
      }
    }

    return best;
  }

  function extractActorIdsFromPayload(payload) {
    const ids = [];

    const injectedIds = payload?.resetResource?.actorIds;
    if (Array.isArray(injectedIds)) ids.push(...injectedIds);

    const directIds = payload?.actorIds;
    if (Array.isArray(directIds)) ids.push(...directIds);

    const partyMembers = payload?.party?.members;
    if (Array.isArray(partyMembers)) {
      for (const m of partyMembers) {
        ids.push(
          m?.actorId ??
          m?.id ??
          m?.actor_id ??
          ""
        );
      }
    }

    const contextPartyIds = payload?.context?.partyActorIds;
    if (Array.isArray(contextPartyIds)) ids.push(...contextPartyIds);

    return uniq(ids);
  }

  function fallbackActorIdsFromControlledTokens() {
    const ids = [];
    for (const token of canvas?.tokens?.controlled ?? []) {
      const id = token?.actor?.id;
      if (id) ids.push(id);
    }
    return uniq(ids);
  }

  async function resolveActorById(actorId) {
    const id = String(actorId ?? "").trim();
    if (!id) return null;

    const actor = game.actors?.get?.(id);
    if (actor) return actor;

    // UUID fallback, in case a future Manager passes Actor.xxxxx
    if (id.startsWith("Actor.")) {
      try {
        const doc = await fromUuid(id);
        return doc?.documentName === "Actor" ? doc : null;
      } catch (err) {
        warn("fromUuid failed while resolving actor:", id, err);
      }
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Locate actor IDs
  // --------------------------------------------------------------------------

  const injectedPayload = globalThis.__PAYLOAD ?? {};
  let actorIds = extractActorIdsFromPayload(injectedPayload);

  if (!actorIds.length) {
    const latest = pickLatestPayloadAcrossScenes();
    if (latest?.payload) {
      actorIds = extractActorIdsFromPayload(latest.payload);
      log("Using fallback actor IDs from latest canonical payload.", {
        sourceScene: latest.scene?.name,
        actorIds
      });
    }
  }

  if (!actorIds.length) {
    actorIds = fallbackActorIdsFromControlledTokens();
    if (actorIds.length) {
      log("Using fallback actor IDs from controlled tokens.", actorIds);
    }
  }

  if (!actorIds.length) {
    ui.notifications?.warn?.("BattleEnd ResetResource: No actor IDs found.");
    warn("No actor IDs found. Expected __PAYLOAD.resetResource.actorIds from Manager.");
    return;
  }

  // --------------------------------------------------------------------------
  // Main reset process
  // --------------------------------------------------------------------------

  const actors = [];
  for (const actorId of actorIds) {
    const actor = await resolveActorById(actorId);
    if (actor) actors.push(actor);
    else warn("Could not resolve actor:", actorId);
  }

  if (!actors.length) {
    ui.notifications?.warn?.("BattleEnd ResetResource: Could not resolve any actors.");
    return;
  }

  const updateReports = [];
  const skippedReports = [];

  for (const actor of actors) {
    const fields = scanNumberFieldsFromActorSheet(actor)
      .filter(f => isResourceLikeKey(f.key));

    const updates = {};
    const actorReport = {
      actorId: actor.id,
      actorName: actor.name,
      reset: [],
      persist: [],
      unknown: [],
      missing: []
    };

    for (const field of fields) {
      const key = field.key;
      const policy = decideResourcePolicy(key);

      const currentExists = actorHasProp(actor, key);
      const currentValue = getActorProp(actor, key);

      const defaultValue = safeNumber(field.defaultValue, 0);
      const currentNumber = safeNumber(currentValue, 0);

      const niceName = field.label || key;

      if (!currentExists) {
        actorReport.missing.push({
          key,
          name: niceName,
          reason: "prop-missing-on-actor"
        });
        continue;
      }

      if (policy === "reset") {
        if (currentNumber === defaultValue) {
          actorReport.reset.push({
            key,
            name: niceName,
            before: currentValue,
            after: defaultValue,
            changed: false
          });
          continue;
        }

        updates[`system.props.${key}`] = defaultValue;

        actorReport.reset.push({
          key,
          name: niceName,
          before: currentValue,
          after: defaultValue,
          changed: true
        });

        continue;
      }

      if (policy === "persist") {
        actorReport.persist.push({
          key,
          name: niceName,
          value: currentValue,
          reason: RESET_RESOURCE_KEYS.has(key)
            ? "unexpected-reset-key"
            : "persist-policy"
        });
        continue;
      }

      actorReport.unknown.push({
        key,
        name: niceName,
        value: currentValue,
        behavior: UNKNOWN_RESOURCE_BEHAVIOR
      });
    }

    if (Object.keys(updates).length) {
      try {
        await actor.update(updates);
        updateReports.push({
          actor: actor.name,
          updates,
          report: actorReport
        });

        log(`Reset resources for ${actor.name} ✅`, actorReport);
      } catch (err) {
        warn(`Failed to update actor ${actor.name}:`, err, { updates, actorReport });
      }
    } else {
      skippedReports.push({
        actor: actor.name,
        report: actorReport
      });

      log(`No resource changes needed for ${actor.name}.`, actorReport);
    }
  }

  // --------------------------------------------------------------------------
  // Summary notification
  // --------------------------------------------------------------------------

  const changedCount = updateReports.reduce((sum, row) => {
    return sum + Object.keys(row.updates ?? {}).length;
  }, 0);

  const actorCount = actors.length;

  ui.notifications?.info?.(
    `BattleEnd ResetResource: reset ${changedCount} resource field(s) across ${actorCount} actor(s).`
  );

  log("Finished ✅", {
    actorCount,
    changedCount,
    updated: updateReports,
    skipped: skippedReports,
    policy: {
      reset: [...RESET_RESOURCE_KEYS],
      persist: [...PERSIST_RESOURCE_KEYS],
      resourceValueRegex: String(RESOURCE_VALUE_RE),
      unknownBehavior: UNKNOWN_RESOURCE_BEHAVIOR
    }
  });
})();
