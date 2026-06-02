// ============================================================================
// ActiveEffectManager-fx.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Visual/audio feedback for ActiveEffectManager operations.
// - No token animation.
// - No token required on the scene.
// - Plays one pseudo-animation screen flash per Active Effect operation.
// - Debuff wins priority:
//     Debuff present      -> red flash + Dispel Magic SFX
//     Buff/Other only     -> green flash + Recovery SFX
//
// Public API:
//   FUCompanion.api.activeEffectManager.fx.play(report, options)
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:FX]";
  const DEBUG = false;

  const RECOVERY_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Recovery.ogg";
  const DEBUFF_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dispel%20Magic.ogg";

  const DEFAULTS = {
    enabled: true,

    // One operation = one screen flash.
    // The flash is intentionally short so it feels like JRPG battle log feedback.
    durationMs: 420,
    fadeInMs: 65,
    holdMs: 80,
    fadeOutMs: 275,

    // Visual intensity
    buffColor: "rgba(70, 255, 145, 0.34)",
    debuffColor: "rgba(255, 58, 72, 0.38)",
    otherColor: "rgba(70, 255, 145, 0.28)",

    blendMode: "screen",
    zIndex: 999999,

    // Audio
    volume: 0.72,

    // Debug
    silentWhenNoRows: true
  };

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // --------------------------------------------------------------------------
  // API root
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager =
      globalThis.FUCompanion.api.activeEffectManager || {};

    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function exposeApi(api) {
    const root = ensureApiRoot();
    root.fx = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.fx = api;
      }
    } catch (e) {
      warn("Could not expose FX API on module object.", e);
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
  }

  function getProperty(obj, path, fallback = undefined) {
    try {
      if (foundry?.utils?.getProperty) {
        const v = foundry.utils.getProperty(obj, path);
        return v === undefined ? fallback : v;
      }
    } catch (_e) {}

    try {
      return String(path)
        .split(".")
        .reduce((cur, key) => cur?.[key], obj) ?? fallback;
    } catch (_e) {
      return fallback;
    }
  }

  function normalizeCategory(value) {
    const s = safeString(value, "Other").toLowerCase();

    if (s === "buff") return "Buff";
    if (s === "debuff") return "Debuff";
    return "Other";
  }

  function statusFromRow(row = {}) {
    return safeString(row.status, row.ok === false ? "failed" : "applied").toLowerCase();
  }

  function isSuccessfulApplyRow(row = {}) {
    const status = statusFromRow(row);

    return (
      row?.ok !== false &&
      ["applied", "replaced", "stacked", "removed"].includes(status)
    );
  }

  function categoryFromFlags(effectLike = {}) {
    const flags = effectLike?.flags?.[MODULE_ID] ?? {};

    return safeString(
      flags?.category ??
      flags?.activeEffectManager?.sourceCategory ??
      flags?.activeEffectManager?.category ??
      ""
    );
  }

  function categoryFromRow(row = {}) {
    const direct = safeString(
      row?.effect?.identity?.category ??
      row?.effect?.category ??
      row?.category ??
      ""
    );

    if (direct) return normalizeCategory(direct);

    const fromCreated = categoryFromFlags(row?.created);
    if (fromCreated) return normalizeCategory(fromCreated);

    const fromBefore = categoryFromFlags(row?.before);
    if (fromBefore) return normalizeCategory(fromBefore);

    const fromAfter = categoryFromFlags(row?.after);
    if (fromAfter) return normalizeCategory(fromAfter);

    const fromRemoved = categoryFromFlags(row?.removed?.[0]);
    if (fromRemoved) return normalizeCategory(fromRemoved);

    return "Other";
  }

  function getRows(report = {}) {
    const rows = asArray(report.results);
    if (rows.length) return rows;

    if (report.action === "modify") {
      return [{
        ok: report.ok,
        status: report.ok ? "applied" : "failed",
        actor: report.actor,
        before: report.before,
        after: report.after,
        reason: report.reason,
        error: report.error
      }];
    }

    return [];
  }

  function classifyReport(report = {}) {
    const rows = getRows(report).filter(isSuccessfulApplyRow);

    if (!rows.length) {
      return {
        ok: false,
        kind: "none",
        reason: "no_successful_effect_rows",
        rows
      };
    }

    const categories = rows.map(categoryFromRow);

    const hasDebuff = categories.includes("Debuff");
    const hasBuff = categories.includes("Buff");
    const hasOther = categories.includes("Other");

    // Debuff wins if mixed.
    if (hasDebuff) {
      return {
        ok: true,
        kind: "debuff",
        color: DEFAULTS.debuffColor,
        soundSrc: DEBUFF_SFX,
        categories,
        rows
      };
    }

    if (hasBuff || hasOther) {
      return {
        ok: true,
        kind: hasBuff ? "buff" : "other",
        color: hasBuff ? DEFAULTS.buffColor : DEFAULTS.otherColor,
        soundSrc: RECOVERY_SFX,
        categories,
        rows
      };
    }

    return {
      ok: true,
      kind: "other",
      color: DEFAULTS.otherColor,
      soundSrc: RECOVERY_SFX,
      categories,
      rows
    };
  }

  function mergeOptions(options = {}) {
    return {
      ...DEFAULTS,
      ...(options ?? {})
    };
  }

  function makeRunId(report = {}) {
    const base =
      report.runId ??
      `AEM-FX-${Date.now().toString(36)}-${foundry?.utils?.randomID?.(6) ?? Math.random().toString(36).slice(2, 8)}`;

    return `aem-fx-${base}`;
  }

  // --------------------------------------------------------------------------
  // Pseudo animation scriptSource
  // --------------------------------------------------------------------------

  function buildScreenFlashScriptSource() {
    return `
      const params = ctx.params ?? {};

      const color = String(params.color ?? "rgba(255,255,255,0.28)");
      const soundSrc = String(params.soundSrc ?? "");
      const volume = Number(params.volume ?? 0.72);

      const fadeInMs = Math.max(0, Number(params.fadeInMs ?? 65));
      const holdMs = Math.max(0, Number(params.holdMs ?? 80));
      const fadeOutMs = Math.max(0, Number(params.fadeOutMs ?? 275));
      const zIndex = Number(params.zIndex ?? 999999);
      const blendMode = String(params.blendMode ?? "screen");

      async function playSound() {
        if (!soundSrc) return;

        try {
          await FAudioHelper.play({
            src: soundSrc,
            volume,
            autoplay: true,
            loop: false
          }, true);
        } catch (e) {
          console.warn("[ONI][AEM-FX][Pseudo] SFX failed.", e);
        }
      }

      function makeOverlay() {
        const el = document.createElement("div");

        el.dataset.oniAemFxFlash = ctx.runId ?? "no-run-id";
        el.style.position = "fixed";
        el.style.inset = "0";
        el.style.pointerEvents = "none";
        el.style.zIndex = String(zIndex);
        el.style.background = color;
        el.style.opacity = "0";
        el.style.mixBlendMode = blendMode;
        el.style.transition = "none";
        el.style.willChange = "opacity";
        el.style.contain = "layout style paint";

        document.body.appendChild(el);

        return el;
      }

      function nextFrame() {
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
      }

      const overlay = makeOverlay();

      try {
        playSound();

        await nextFrame();

        overlay.style.transition = \`opacity \${fadeInMs}ms ease-out\`;
        overlay.style.opacity = "1";

        await wait(fadeInMs + holdMs);

        overlay.style.transition = \`opacity \${fadeOutMs}ms ease-in\`;
        overlay.style.opacity = "0";

        await wait(fadeOutMs + 40);
      } finally {
        try {
          overlay.remove();
        } catch (_e) {}
      }
    `;
  }

  // --------------------------------------------------------------------------
  // Main FX player
  // --------------------------------------------------------------------------

  async function play(report = {}, options = {}) {
    const cfg = mergeOptions(options);

    if (!cfg.enabled) {
      log("FX disabled by options.");
      return {
        ok: false,
        reason: "disabled"
      };
    }

    if (report?.options?.silent === true || options?.silent === true) {
      log("FX skipped due to silent option.");
      return {
        ok: false,
        reason: "silent"
      };
    }

    const classified = classifyReport(report);

    if (!classified.ok) {
      if (!cfg.silentWhenNoRows) {
        warn("FX skipped: no successful Active Effect rows.", {
          runId: report?.runId,
          reason: classified.reason
        });
      }

      return {
        ok: false,
        reason: classified.reason
      };
    }

    const pseudo = game.ONI?.pseudo;

    if (typeof pseudo?.play !== "function") {
      warn("Pseudo Animation API not found. Expected game.ONI.pseudo.play(payload).");

      return {
        ok: false,
        reason: "pseudo_api_not_found"
      };
    }

    const runId = makeRunId(report);

    const payload = {
      scriptId: "aem.screenFlash",
      scriptSource: buildScreenFlashScriptSource(),

      // No token needed. Your Pseudo API allows casterTokenUuid to be optional.
      casterTokenUuid: null,
      targetTokenUuids: [],

      params: {
        color: classified.color,
        soundSrc: classified.soundSrc,
        volume: cfg.volume,

        fadeInMs: cfg.fadeInMs,
        holdMs: cfg.holdMs,
        fadeOutMs: cfg.fadeOutMs,
        zIndex: cfg.zIndex,
        blendMode: cfg.blendMode,

        kind: classified.kind,
        sourceRunId: report?.runId ?? null
      },

      meta: {
        source: "ActiveEffectManager",
        kind: classified.kind,
        reportRunId: report?.runId ?? null,
        effectRowCount: classified.rows.length
      },

      runId
    };

    const emittedRunId = pseudo.play(payload);

    log("Played Active Effect screen flash.", {
      runId,
      emittedRunId,
      kind: classified.kind,
      rowCount: classified.rows.length
    });

    return {
      ok: true,
      runId,
      emittedRunId,
      kind: classified.kind,
      rowCount: classified.rows.length
    };
  }

  async function preview(kind = "buff") {
    const fakeReport = {
      runId: `AEM-FX-PREVIEW-${Date.now().toString(36)}`,
      action: "apply",
      results: [{
        ok: true,
        status: "applied",
        effect: {
          name: kind === "debuff" ? "Test Debuff" : "Test Buff",
          identity: {
            category: kind === "debuff" ? "Debuff" : "Buff"
          }
        }
      }]
    };

    return await play(fakeReport, {
      silent: false
    });
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.2.0",
    play,
    preview,

    _internal: {
      classifyReport,
      categoryFromRow,
      getRows,
      buildScreenFlashScriptSource
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    log("Ready. Active Effect Manager FX API installed.", {
      api: "FUCompanion.api.activeEffectManager.fx.play(report)",
      previewBuff: "FUCompanion.api.activeEffectManager.fx.preview('buff')",
      previewDebuff: "FUCompanion.api.activeEffectManager.fx.preview('debuff')"
    });
  });
})();