// ============================================================================
//  ActionAnimationHandler – Custom Skill Animation + Timing Gate
//  - Supports BOTH damage actions and "no-damage" utility actions.
//  - Fixes caster/target resolution by enriching payload and publishing
//    globalThis.__PAYLOAD / globalThis.__TARGETS during script execution.
//  - Uses generic GMExecutor on non-GM clients when available.
//  - Falls back to local execution if generic GMExecutor is unavailable.
//
//  Usage:
//    - Called headless by Action System via macro.execute({ __AUTO:true, __PAYLOAD:{...} })
//    - For no-damage actions: pass __PAYLOAD.animationPurpose = "vfx_only"
//
//  Returns:
//    true  = a non-placeholder animation script ran AND the chosen gate resolved
//    false = no script / placeholder / error
// ============================================================================

return (async () => {
  const MODULE_ID = "fabula-ultima-companion";

  let AUTO, PAYLOAD;
  if (typeof __AUTO !== "undefined") {
    AUTO = __AUTO;
    PAYLOAD = __PAYLOAD ?? {};
  } else {
    AUTO = false;
    PAYLOAD = globalThis.__PAYLOAD ?? {};
  }

  const isHeadless = !!AUTO;
  const hasPayload = PAYLOAD && typeof PAYLOAD === "object";
  if (!isHeadless && !hasPayload) return false;

  const attackerUuid =
    PAYLOAD?.meta?.attackerUuid ??
    PAYLOAD?.attackerUuid ??
    PAYLOAD?.attackerActorUuid ??
    null;

  const gmExecutor =
    game.modules?.get(MODULE_ID)?.api?.GMExecutor ??
    globalThis.FUCompanion?.api?.GMExecutor ??
    null;

  const canUseGMExecutor = !!(
    !game.user?.isGM &&
    gmExecutor &&
    typeof gmExecutor.executeSnippet === "function"
  );

  function clone(obj, fallback = {}) {
    try {
      if (obj == null) {
        return foundry?.utils?.deepClone
          ? foundry.utils.deepClone(fallback)
          : JSON.parse(JSON.stringify(fallback));
      }
      return foundry?.utils?.deepClone
        ? foundry.utils.deepClone(obj)
        : JSON.parse(JSON.stringify(obj));
    } catch {
      if (Array.isArray(obj)) return [...obj];
      if (obj && typeof obj === "object") return { ...obj };
      return foundry?.utils?.deepClone
        ? foundry.utils.deepClone(fallback)
        : fallback;
    }
  }

  function mergeRemotePayloadInPlace(target, source) {
    if (!source || typeof source !== "object") return target;

    try {
      foundry.utils.mergeObject(target, source, {
        insertKeys: true,
        insertValues: true,
        overwrite: true,
        recursive: true,
        inplace: true
      });
    } catch {
      Object.assign(target, source);
    }

    if (Array.isArray(source.targets)) {
      target.targets = clone(source.targets, []);
    }

    if (Array.isArray(source.originalTargetUUIDs)) {
      target.originalTargetUUIDs = clone(source.originalTargetUUIDs, []);
    }

    if (Array.isArray(source.targetTokenIds)) {
      target.targetTokenIds = clone(source.targetTokenIds, []);
    }

    if (Array.isArray(source.targetTokenUuids)) {
      target.targetTokenUuids = clone(source.targetTokenUuids, []);
    }

    return target;
  }

  function htmlToPlain(html = "") {
    const container = document.createElement("div");
    container.innerHTML = html;

    const paragraphs = container.querySelectorAll("p");
    if (paragraphs.length > 0) {
      const lines = Array.from(paragraphs).map(p => (p.textContent || "").trimEnd());
      return lines.join("\n\n");
    }

    const text = container.textContent || container.innerText || "";
    return text;
  }

  async function normalizeTargets(rawTargets) {
    const list = Array.isArray(rawTargets) ? rawTargets : [];
    const resolved = [];

    for (let i = 0; i < list.length; i++) {
      const t = list[i];

      try {
        if (typeof t === "string" && t.trim()) {
          const uuid = t.trim();
          const doc = (typeof fromUuid === "function") ? await fromUuid(uuid) : null;
          if (!doc) { resolved.push(t); continue; }

          if (doc.documentName === "Token") {
            resolved.push(doc.object ?? doc);
            continue;
          }

          if (doc.documentName === "Actor") {
            const tok = doc.getActiveTokens?.(true, true)?.[0] ?? null;
            resolved.push(tok ?? doc);
            continue;
          }

          resolved.push(doc);
          continue;
        }

        if (t?.document?.documentName === "Token") {
          resolved.push(t);
          continue;
        }

        if (t?.documentName === "Token") {
          resolved.push(t.object ?? t);
          continue;
        }

        if (t?.documentName === "Actor" || t?.actor) {
          const actor = t?.documentName === "Actor" ? t : t?.actor;
          const tok = actor?.getActiveTokens?.(true, true)?.[0] ?? null;
          resolved.push(tok ?? actor ?? t);
          continue;
        }

        resolved.push(t);
      } catch {
        resolved.push(t);
      }
    }

    return resolved;
  }

  function toTokenPlaceable(x) {
    if (x?.document?.documentName === "Token") return x;
    if (x?.documentName === "Token") return x.object ?? null;
    return null;
  }

  function asUuid(x) {
    return (typeof x === "string" && x.includes(".")) ? x : null;
  }

  async function resolveCasterTokenFromPayload(p) {
    const direct =
      p?.sourceTokenUuid || p?.casterTokenUuid || p?.tokenUuid || p?.tokenUUID || null;

    if (asUuid(direct) && typeof fromUuid === "function") {
      try {
        const doc = await fromUuid(direct);
        if (doc?.documentName === "Token") return doc.object ?? null;
      } catch {}
    }

    const attackerRef =
      p?.attackerUuid || p?.attackerUUID ||
      p?.meta?.attackerUuid || p?.meta?.attackerUUID ||
      null;

    if (asUuid(attackerRef) && typeof fromUuid === "function") {
      try {
        const doc = await fromUuid(attackerRef);
        if (doc?.documentName === "Token") return doc.object ?? null;
        if (doc?.documentName === "Actor") return doc.getActiveTokens?.(true, true)?.[0] ?? null;

        const actor = doc?.actor ?? null;
        if (actor?.getActiveTokens) return actor.getActiveTokens(true, true)?.[0] ?? null;
      } catch {}
    }

    return (
      game.user?.character?.getActiveTokens?.(true, true)?.[0] ??
      canvas.tokens?.controlled?.[0] ??
      null
    );
  }

  const MAX_TIMEOUT_DEFAULT = 30000;

  async function waitForAnimationEnd({ timeoutMs = MAX_TIMEOUT_DEFAULT } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const cleanup = () => {
        Hooks.off("oni:animationEnd", onEnd);
        if (timer) clearTimeout(timer);
      };

      const onEnd = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };

      Hooks.on("oni:animationEnd", onEnd);

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      }, timeoutMs);
    });
  }

  async function waitForDamageMoment(timingMode, offsetMs, { timeoutMs = MAX_TIMEOUT_DEFAULT } = {}) {
    const mode = String(timingMode ?? "default").trim().toLowerCase();

    if (mode === "timing_offset") {
      await new Promise((resolve) => {
        let started = false;
        let offsetTimer = null;
        let failSafe = null;

        const cleanup = () => {
          Hooks.off("oni:animationStart", onStart);
          Hooks.off("oni:animationEnd", onEnd);
          if (offsetTimer) clearTimeout(offsetTimer);
          if (failSafe) clearTimeout(failSafe);
        };

        const onStart = () => {
          if (started) return;
          started = true;

          if (offsetMs <= 0) {
            cleanup();
            resolve();
            return;
          }

          offsetTimer = setTimeout(() => {
            cleanup();
            resolve();
          }, offsetMs);
        };

        const onEnd = () => {};

        Hooks.on("oni:animationStart", onStart);
        Hooks.on("oni:animationEnd", onEnd);

        failSafe = setTimeout(() => {
          cleanup();
          resolve();
        }, timeoutMs);
      });

      return;
    }

    await waitForAnimationEnd({ timeoutMs });
  }

  function fuGetAnimationConfig(payload) {
    const rawMode = String(payload?.animation_damage_timing_options ?? "default").trim().toLowerCase();
    const rawOffset = payload?.animation_damage_timing_offset;

    let mode = "default";
    if (rawMode === "offset" || rawMode === "timing_offset") mode = "timing_offset";

    let offsetMs = 0;
    if (mode === "timing_offset" && rawOffset !== undefined && rawOffset !== null) {
      const parsed = Number(rawOffset);
      if (!Number.isNaN(parsed) && parsed >= 0) offsetMs = parsed;
    }

    return { mode, offsetMs };
  }

  function extractRawScript(payload) {
    return String(payload?.animationScriptRaw ?? payload?.animationScript ?? "").trim();
  }

  function isPlaceholderScript(raw) {
    return /insert your sequencer animation here/i.test(raw);
  }

  async function fuRunSkillAnimationIfAny(payload, targets, timingMode, offsetMs) {
    const purpose = String(payload?.animationPurpose ?? "damage").trim().toLowerCase();
    const purposeMode = (purpose === "vfx_only") ? "vfx_only" : "damage";

    try {
      const raw = extractRawScript(payload);
      if (!raw) return false;
      if (isPlaceholderScript(raw)) return false;

      let js = htmlToPlain(raw).replace(/\r\n/g, "\n").trim();
      if (!js) return false;

      globalThis.__ONI_ACTION_ANIM_FN_CACHE__ ??= new Map();

let fn = globalThis.__ONI_ACTION_ANIM_FN_CACHE__.get(js);

if (!fn) {
  fn = new Function("payload", "targets", "\"use strict\";\n" + js);
  globalThis.__ONI_ACTION_ANIM_FN_CACHE__.set(js, fn);
}

      const worker = async () => {
        const gatePromise =
          (purposeMode === "vfx_only")
            ? waitForAnimationEnd({ timeoutMs: MAX_TIMEOUT_DEFAULT })
            : waitForDamageMoment(timingMode, offsetMs, { timeoutMs: MAX_TIMEOUT_DEFAULT });

        try {
          const __prevPAYLOAD = globalThis.__PAYLOAD;
          const __prevTARGETS = globalThis.__TARGETS;

          globalThis.__PAYLOAD = payload;
          globalThis.__TARGETS = targets;

          try {
            const result = fn(payload, targets);
            if (result && typeof result.then === "function") await result;
          } finally {
            globalThis.__PAYLOAD = __prevPAYLOAD;
            globalThis.__TARGETS = __prevTARGETS;
          }
        } catch (e) {
          console.error("[ActionAnimationHandler] Animation script error:", e);
          await gatePromise.catch(() => {});
          return false;
        }

        await gatePromise;
        return true;
      };

      const hasTurnUI =
        !!(globalThis.TurnUI &&
           typeof TurnUI.hideUIForAnimation === "function" &&
           typeof TurnUI.showUIAfterAnimation === "function");

      if (hasTurnUI && game?.socket) {
        const uiPayload = { sceneId: canvas.scene?.id ?? null };
        const SOCKET_CHANNEL = `module.${MODULE_ID}`;

        const sendHide = () => {
          try { game.socket.emit(SOCKET_CHANNEL, { type: "ONI_TURNUI_HIDE_FOR_ANIMATION", payload: uiPayload }); } catch {}
          try { game.socket.emit("world", { _oniTurnUI: "HIDE_FOR_ANIMATION", payload: uiPayload }); } catch {}
          try { TurnUI.hideUIForAnimation(uiPayload); } catch {}
        };

        const sendShow = () => {
          try { game.socket.emit(SOCKET_CHANNEL, { type: "ONI_TURNUI_SHOW_AFTER_ANIMATION", payload: uiPayload }); } catch {}
          try { game.socket.emit("world", { _oniTurnUI: "SHOW_AFTER_ANIMATION", payload: uiPayload }); } catch {}
          try { TurnUI.showUIAfterAnimation(uiPayload); } catch {}
        };

        sendHide();
        try {
          return await worker();
        } finally {
          sendShow();
        }
      }

      return await worker();
    } catch (err) {
      console.error("[ActionAnimationHandler] Handler error:", err);
      return false;
    }
  }

  async function runLocal() {
    const rawTargets = Array.isArray(PAYLOAD.targets) ? PAYLOAD.targets : [];
    const targets = await normalizeTargets(rawTargets);

    const casterToken = await resolveCasterTokenFromPayload(PAYLOAD);

    const targetTokens = (targets || []).map(toTokenPlaceable).filter(Boolean);
    const targetTokenIds = targetTokens.map(t => t.id).filter(Boolean);
    const targetTokenUuids = targetTokens.map(t => t.document?.uuid).filter(Boolean);

    PAYLOAD.sourceTokenId = PAYLOAD.sourceTokenId ?? (casterToken?.id ?? null);
    PAYLOAD.sourceTokenUuid = PAYLOAD.sourceTokenUuid ?? (casterToken?.document?.uuid ?? null);
    PAYLOAD.casterTokenId = PAYLOAD.casterTokenId ?? (casterToken?.id ?? null);
    PAYLOAD.casterTokenUuid = PAYLOAD.casterTokenUuid ?? (casterToken?.document?.uuid ?? null);

    if (!Array.isArray(PAYLOAD.targetTokenIds) || PAYLOAD.targetTokenIds.length === 0) {
      PAYLOAD.targetTokenIds = targetTokenIds;
    }
    if (!Array.isArray(PAYLOAD.targetTokenUuids) || PAYLOAD.targetTokenUuids.length === 0) {
      PAYLOAD.targetTokenUuids = targetTokenUuids;
    }

    const { mode: animTimingMode, offsetMs: animTimingOffset } = fuGetAnimationConfig(PAYLOAD);
    const used = await fuRunSkillAnimationIfAny(PAYLOAD, targets, animTimingMode, animTimingOffset);
    return !!used;
  }

  async function runViaGMExecutor() {
    try {
      const wrappedScript = [
        'async function htmlToPlainRemote(html = "") {',
        '  const container = document.createElement("div");',
        '  container.innerHTML = html;',
        '  const paragraphs = container.querySelectorAll("p");',
        '  if (paragraphs.length > 0) {',
        '    const lines = Array.from(paragraphs).map(p => (p.textContent || "").trimEnd());',
        '    return lines.join("\\n\\n");',
        '  }',
        '  const text = container.textContent || container.innerText || "";',
        '  return text;',
        '}',
        '',
        'async function normalizeTargetsRemote(rawTargets) {',
        '  const list = Array.isArray(rawTargets) ? rawTargets : [];',
        '  const resolved = [];',
        '  for (let i = 0; i < list.length; i++) {',
        '    const t = list[i];',
        '    try {',
        '      if (typeof t === "string" && t.trim()) {',
        '        const uuid = t.trim();',
        '        const doc = (typeof fromUuid === "function") ? await fromUuid(uuid) : null;',
        '        if (!doc) { resolved.push(t); continue; }',
        '        if (doc.documentName === "Token") {',
        '          resolved.push(doc.object ?? doc);',
        '          continue;',
        '        }',
        '        if (doc.documentName === "Actor") {',
        '          const tok = doc.getActiveTokens?.(true, true)?.[0] ?? null;',
        '          resolved.push(tok ?? doc);',
        '          continue;',
        '        }',
        '        resolved.push(doc);',
        '        continue;',
        '      }',
        '      if (t?.document?.documentName === "Token") {',
        '        resolved.push(t);',
        '        continue;',
        '      }',
        '      if (t?.documentName === "Token") {',
        '        resolved.push(t.object ?? t);',
        '        continue;',
        '      }',
        '      if (t?.documentName === "Actor" || t?.actor) {',
        '        const actor = t?.documentName === "Actor" ? t : t?.actor;',
        '        const tok = actor?.getActiveTokens?.(true, true)?.[0] ?? null;',
        '        resolved.push(tok ?? actor ?? t);',
        '        continue;',
        '      }',
        '      resolved.push(t);',
        '    } catch {',
        '      resolved.push(t);',
        '    }',
        '  }',
        '  return resolved;',
        '}',
        '',
        'function toTokenPlaceableRemote(x) {',
        '  if (x?.document?.documentName === "Token") return x;',
        '  if (x?.documentName === "Token") return x.object ?? null;',
        '  return null;',
        '}',
        '',
        'function asUuidRemote(x) {',
        '  return (typeof x === "string" && x.includes(".")) ? x : null;',
        '}',
        '',
        'async function resolveCasterTokenFromPayloadRemote(p) {',
        '  const direct = p?.sourceTokenUuid || p?.casterTokenUuid || p?.tokenUuid || p?.tokenUUID || null;',
        '  if (asUuidRemote(direct) && typeof fromUuid === "function") {',
        '    try {',
        '      const doc = await fromUuid(direct);',
        '      if (doc?.documentName === "Token") return doc.object ?? null;',
        '    } catch {}',
        '  }',
        '  const attackerRef = p?.attackerUuid || p?.attackerUUID || p?.meta?.attackerUuid || p?.meta?.attackerUUID || null;',
        '  if (asUuidRemote(attackerRef) && typeof fromUuid === "function") {',
        '    try {',
        '      const doc = await fromUuid(attackerRef);',
        '      if (doc?.documentName === "Token") return doc.object ?? null;',
        '      if (doc?.documentName === "Actor") return doc.getActiveTokens?.(true, true)?.[0] ?? null;',
        '      const actor = doc?.actor ?? null;',
        '      if (actor?.getActiveTokens) return actor.getActiveTokens(true, true)?.[0] ?? null;',
        '    } catch {}',
        '  }',
        '  return (game.user?.character?.getActiveTokens?.(true, true)?.[0] ?? canvas.tokens?.controlled?.[0] ?? null);',
        '}',
        '',
        'const MAX_TIMEOUT_DEFAULT_REMOTE = 30000;',
        '',
        'async function waitForAnimationEndRemote(opts = {}) {',
        '  const timeoutMs = opts.timeoutMs ?? MAX_TIMEOUT_DEFAULT_REMOTE;',
        '  return await new Promise((resolve) => {',
        '    let done = false;',
        '    const cleanup = () => {',
        '      Hooks.off("oni:animationEnd", onEnd);',
        '      if (timer) clearTimeout(timer);',
        '    };',
        '    const onEnd = () => {',
        '      if (done) return;',
        '      done = true;',
        '      cleanup();',
        '      resolve();',
        '    };',
        '    Hooks.on("oni:animationEnd", onEnd);',
        '    const timer = setTimeout(() => {',
        '      if (done) return;',
        '      done = true;',
        '      cleanup();',
        '      resolve();',
        '    }, timeoutMs);',
        '  });',
        '}',
        '',
        'async function waitForDamageMomentRemote(timingMode, offsetMs, opts = {}) {',
        '  const timeoutMs = opts.timeoutMs ?? MAX_TIMEOUT_DEFAULT_REMOTE;',
        '  const mode = String(timingMode ?? "default").trim().toLowerCase();',
        '  if (mode === "timing_offset") {',
        '    await new Promise((resolve) => {',
        '      let started = false;',
        '      let offsetTimer = null;',
        '      let failSafe = null;',
        '      const cleanup = () => {',
        '        Hooks.off("oni:animationStart", onStart);',
        '        Hooks.off("oni:animationEnd", onEnd);',
        '        if (offsetTimer) clearTimeout(offsetTimer);',
        '        if (failSafe) clearTimeout(failSafe);',
        '      };',
        '      const onStart = () => {',
        '        if (started) return;',
        '        started = true;',
        '        if (offsetMs <= 0) {',
        '          cleanup();',
        '          resolve();',
        '          return;',
        '        }',
        '        offsetTimer = setTimeout(() => {',
        '          cleanup();',
        '          resolve();',
        '        }, offsetMs);',
        '      };',
        '      const onEnd = () => {};',
        '      Hooks.on("oni:animationStart", onStart);',
        '      Hooks.on("oni:animationEnd", onEnd);',
        '      failSafe = setTimeout(() => {',
        '        cleanup();',
        '        resolve();',
        '      }, timeoutMs);',
        '    });',
        '    return;',
        '  }',
        '  await waitForAnimationEndRemote({ timeoutMs });',
        '}',
        '',
        'function getAnimationConfigRemote(payload) {',
        '  const rawMode = String(payload?.animation_damage_timing_options ?? "default").trim().toLowerCase();',
        '  const rawOffset = payload?.animation_damage_timing_offset;',
        '  let mode = "default";',
        '  if (rawMode === "offset" || rawMode === "timing_offset") mode = "timing_offset";',
        '  let offsetMs = 0;',
        '  if (mode === "timing_offset" && rawOffset !== undefined && rawOffset !== null) {',
        '    const parsed = Number(rawOffset);',
        '    if (!Number.isNaN(parsed) && parsed >= 0) offsetMs = parsed;',
        '  }',
        '  return { mode, offsetMs };',
        '}',
        '',
        'function extractRawScriptRemote(payload) {',
        '  return String(payload?.animationScriptRaw ?? payload?.animationScript ?? "").trim();',
        '}',
        '',
        'function isPlaceholderScriptRemote(raw) {',
        '  return /insert your sequencer animation here/i.test(raw);',
        '}',
        '',
        'const rawTargets = Array.isArray(payload.targets) ? payload.targets : (Array.isArray(targets) ? targets : []);',
        'const normalizedTargets = await normalizeTargetsRemote(rawTargets);',
        'const casterToken = await resolveCasterTokenFromPayloadRemote(payload);',
        'const targetTokens = (normalizedTargets || []).map(toTokenPlaceableRemote).filter(Boolean);',
        'const targetTokenIds = targetTokens.map(t => t.id).filter(Boolean);',
        'const targetTokenUuids = targetTokens.map(t => t.document?.uuid).filter(Boolean);',
        '',
        'payload.sourceTokenId = payload.sourceTokenId ?? (casterToken?.id ?? null);',
        'payload.sourceTokenUuid = payload.sourceTokenUuid ?? (casterToken?.document?.uuid ?? null);',
        'payload.casterTokenId = payload.casterTokenId ?? (casterToken?.id ?? null);',
        'payload.casterTokenUuid = payload.casterTokenUuid ?? (casterToken?.document?.uuid ?? null);',
        '',
        'if (!Array.isArray(payload.targetTokenIds) || payload.targetTokenIds.length === 0) {',
        '  payload.targetTokenIds = targetTokenIds;',
        '}',
        'if (!Array.isArray(payload.targetTokenUuids) || payload.targetTokenUuids.length === 0) {',
        '  payload.targetTokenUuids = targetTokenUuids;',
        '}',
        '',
        'const purpose = String(payload?.animationPurpose ?? "damage").trim().toLowerCase();',
        'const purposeMode = (purpose === "vfx_only") ? "vfx_only" : "damage";',
        'const raw = extractRawScriptRemote(payload);',
        'if (!raw) return { used: false };',
        'if (isPlaceholderScriptRemote(raw)) return { used: false };',
        'let js = (await htmlToPlainRemote(raw)).replace(/\\r\\n/g, "\\n").trim();',
        'if (!js) return { used: false };',
        'const cfg = getAnimationConfigRemote(payload);',
        'const animTimingMode = cfg.mode;',
        'const animTimingOffset = cfg.offsetMs;',
        'const fn = new Function("payload", "targets", "\"use strict\";\\n" + js);',
        '',
        'const worker = async () => {',
        '  const gatePromise = (purposeMode === "vfx_only")',
        '    ? waitForAnimationEndRemote({ timeoutMs: MAX_TIMEOUT_DEFAULT_REMOTE })',
        '    : waitForDamageMomentRemote(animTimingMode, animTimingOffset, { timeoutMs: MAX_TIMEOUT_DEFAULT_REMOTE });',
        '  try {',
        '    const __prevPAYLOAD = globalThis.__PAYLOAD;',
        '    const __prevTARGETS = globalThis.__TARGETS;',
        '    globalThis.__PAYLOAD = payload;',
        '    globalThis.__TARGETS = normalizedTargets;',
        '    try {',
        '      const result = fn(payload, normalizedTargets);',
        '      if (result && typeof result.then === "function") await result;',
        '    } finally {',
        '      globalThis.__PAYLOAD = __prevPAYLOAD;',
        '      globalThis.__TARGETS = __prevTARGETS;',
        '    }',
        '  } catch (e) {',
        '    console.error("[ActionAnimationHandler] Animation script error:", e);',
        '    await gatePromise.catch(() => {});',
        '    return false;',
        '  }',
        '  await gatePromise;',
        '  return true;',
        '};',
        '',
        'const hasTurnUI = !!(globalThis.TurnUI && typeof TurnUI.hideUIForAnimation === "function" && typeof TurnUI.showUIAfterAnimation === "function");',
        'if (hasTurnUI && game?.socket) {',
        '  const uiPayload = { sceneId: canvas.scene?.id ?? null };',
        '  const SOCKET_CHANNEL = "module.' + MODULE_ID + '";',
        '  const sendHide = () => {',
        '    try { game.socket.emit(SOCKET_CHANNEL, { type: "ONI_TURNUI_HIDE_FOR_ANIMATION", payload: uiPayload }); } catch {}',
        '    try { game.socket.emit("world", { _oniTurnUI: "HIDE_FOR_ANIMATION", payload: uiPayload }); } catch {}',
        '    try { TurnUI.hideUIForAnimation(uiPayload); } catch {}',
        '  };',
        '  const sendShow = () => {',
        '    try { game.socket.emit(SOCKET_CHANNEL, { type: "ONI_TURNUI_SHOW_AFTER_ANIMATION", payload: uiPayload }); } catch {}',
        '    try { game.socket.emit("world", { _oniTurnUI: "SHOW_AFTER_ANIMATION", payload: uiPayload }); } catch {}',
        '    try { TurnUI.showUIAfterAnimation(uiPayload); } catch {}',
        '  };',
        '  sendHide();',
        '  try {',
        '    const used = await worker();',
        '    return { used: !!used };',
        '  } finally {',
        '    sendShow();',
        '  }',
        '}',
        '',
        'const used = await worker();',
        'return { used: !!used };'
      ].join("\n");

      const remote = await gmExecutor.executeSnippet({
        mode: "generic",
        scriptText: wrappedScript,
        payload: PAYLOAD,
        targets: Array.isArray(PAYLOAD.targets) ? PAYLOAD.targets : [],
        actorUuid: attackerUuid ?? null,
        auto: !!AUTO,
        metadata: {
          origin: "ActionAnimationHandler"
        }
      });

      if (remote?.payload) {
        mergeRemotePayloadInPlace(PAYLOAD, remote.payload);
      }

      if (!remote?.ok) {
        console.error("[ActionAnimationHandler] GMExecutor error:", remote?.error ?? "unknown error");
        return false;
      }

      return !!remote?.resultValue?.used;
    } catch (e) {
      console.error("[ActionAnimationHandler] GMExecutor fatal error:", e);
      return false;
    }
  }

  try {
    if (canUseGMExecutor) {
      return await runViaGMExecutor();
    }

    if (!game.user?.isGM && !gmExecutor?.executeSnippet) {
      console.warn("[ActionAnimationHandler] GMExecutor generic API unavailable; falling back to local execution.");
    }

    return await runLocal();
  } catch (e) {
    console.error("[ActionAnimationHandler] Fatal error:", e);
    return false;
  }
})();
