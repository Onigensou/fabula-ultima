/*:
 * @target Foundry VTT v12
 * @plugindesc [ONI] Safe probe for AE Syntax / AE Gate libWrapper self-conflict.
 *
 * File:
 * modules/fabula-ultima-companion/scripts/probes/probe-ae-libwrapper-conflict.js
 *
 * V2:
 * - Does NOT modify libWrapper.register
 * - Does NOT patch Actor.applyActiveEffects
 * - Does NOT patch ActiveEffect.apply
 * - Only reads status objects, prototype info, and captures console warnings
 */

(() => {
  "use strict";

  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][AE-LW-Probe]";

  const state = globalThis.__ONI_AE_LW_PROBE__ ??= {
    version: "2.0.0",
    loadedAt: new Date().toISOString(),
    consoleWarnSpyInstalled: false,
    originalConsoleWarn: null,
    warningCalls: []
  };

  function safeString(value) {
    try {
      if (typeof value === "string") return value;
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      return String(value ?? "");
    } catch (_err) {
      return "(unstringifiable)";
    }
  }

  function shortStack() {
    try {
      return String(new Error().stack ?? "")
        .split("\n")
        .slice(2, 9)
        .join("\n");
    } catch (_err) {
      return "";
    }
  }

  function installConsoleWarnSpy() {
    if (state.consoleWarnSpyInstalled) return true;
    if (!console?.warn) return false;

    state.originalConsoleWarn = console.warn;

    console.warn = function oniAeLibWrapperProbeWarnSpy(...args) {
      try {
        const text = args.map(safeString).join(" ");

        const relevant =
          /libWrapper/i.test(text) &&
          (
            /FabulaUltimaCompanion/i.test(text) ||
            /fabula-ultima-companion/i.test(text) ||
            /modify the same FoundryVTT functionality/i.test(text)
          );

        if (relevant) {
          state.warningCalls.push({
            time: new Date().toISOString(),
            text,
            stack: shortStack()
          });
        }
      } catch (_err) {}

      return state.originalConsoleWarn.apply(this, args);
    };

    state.consoleWarnSpyInstalled = true;
    console.log(TAG, "console.warn spy installed.");
    return true;
  }

  function restoreConsoleWarn() {
    if (!state.consoleWarnSpyInstalled) return false;

    if (state.originalConsoleWarn) {
      console.warn = state.originalConsoleWarn;
    }

    state.consoleWarnSpyInstalled = false;
    console.log(TAG, "console.warn spy restored.");
    return true;
  }

  function safeCall(fn, fallback = null) {
    try {
      if (typeof fn === "function") return fn();
      return fallback;
    } catch (err) {
      return {
        ok: false,
        error: String(err?.message ?? err)
      };
    }
  }

  function getSettingSafe(key) {
    try {
      return game.settings.get(MODULE_ID, key);
    } catch (_err) {
      return null;
    }
  }

  function getStatusObjects() {
    const syntaxApi =
      globalThis.FUCompanion?.api?.activeEffectSyntax ??
      game.modules?.get(MODULE_ID)?.api?.activeEffectSyntax ??
      null;

    const gateApi =
      globalThis.FUCompanion?.api?.activeEffectConditionalGate ??
      game.modules?.get(MODULE_ID)?.api?.activeEffectConditionalGate ??
      null;

    return {
      syntaxStatus: safeCall(() => syntaxApi?.status?.(), null),
      gateStatus: safeCall(() => gateApi?.status?.(), null),
      hasSyntaxApi: !!syntaxApi,
      hasGateApi: !!gateApi
    };
  }

  function functionSnapshot(label, fn) {
    const text = (() => {
      try {
        return Function.prototype.toString.call(fn);
      } catch (_err) {
        return "";
      }
    })();

    return {
      label,
      exists: typeof fn === "function",
      name: fn?.name ?? null,
      mentionsAeSyntax: /AE-Syntax|oniAeSyntax|withTransformedEffectChanges|transformApplyArgs/i.test(text),
      mentionsAeGate: /AE-Gate|oniAeConditionalGate|withGatedActorChanges|transformApplyArgsOrSkip/i.test(text),
      mentionsLibWrapper: /libWrapper|wrapped/i.test(text),
      textStart: text.slice(0, 220)
    };
  }

  function getPrototypeSnapshot() {
    const actorProto =
      CONFIG?.Actor?.documentClass?.prototype ??
      globalThis.Actor?.prototype ??
      null;

    const effectProto =
      CONFIG?.ActiveEffect?.documentClass?.prototype ??
      globalThis.ActiveEffect?.prototype ??
      null;

    return {
      actorClass:
        CONFIG?.Actor?.documentClass?.name ??
        globalThis.Actor?.name ??
        null,

      activeEffectClass:
        CONFIG?.ActiveEffect?.documentClass?.name ??
        globalThis.ActiveEffect?.name ??
        null,

      actorPatchFlags: actorProto ? {
        syntaxDirectFlag: !!actorProto.__oniAeSyntaxActorApplyPatched,
        gateDirectFlag: !!actorProto.__oniAeConditionalGateActorPatched,
        hasSyntaxOriginal: !!actorProto.__oniAeSyntaxOriginalApplyActiveEffects,
        hasGateOriginal: !!actorProto.__oniAeConditionalGateOriginalApplyActiveEffects
      } : null,

      activeEffectPatchFlags: effectProto ? {
        syntaxDirectFlag: !!effectProto.__oniAeSyntaxCustomApplyPatched,
        gateDirectFlag: !!effectProto.__oniAeConditionalGateApplyPatched,
        hasSyntaxOriginal: !!effectProto.__oniAeSyntaxOriginalCustomApply,
        hasGateOriginal: !!effectProto.__oniAeConditionalGateOriginalApply
      } : null,

      functions: [
        functionSnapshot("Actor.applyActiveEffects", actorProto?.applyActiveEffects),
        functionSnapshot("ActiveEffect.apply", effectProto?.apply)
      ]
    };
  }

  function getLibWrapperSnapshot() {
    const lw = globalThis.libWrapper ?? null;

    let registerDescriptor = null;
    try {
      registerDescriptor = Object.getOwnPropertyDescriptor(lw, "register");
    } catch (_err) {}

    let protoRegisterDescriptor = null;
    try {
      protoRegisterDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(lw), "register");
    } catch (_err) {}

    return {
      exists: !!lw,
      type: typeof lw,
      version: lw?.version ?? null,
      registerType: typeof lw?.register,
      registerDescriptor: registerDescriptor ? {
        writable: registerDescriptor.writable,
        configurable: registerDescriptor.configurable,
        enumerable: registerDescriptor.enumerable,
        hasValue: "value" in registerDescriptor,
        hasGetter: typeof registerDescriptor.get === "function",
        hasSetter: typeof registerDescriptor.set === "function"
      } : null,
      protoRegisterDescriptor: protoRegisterDescriptor ? {
        writable: protoRegisterDescriptor.writable,
        configurable: protoRegisterDescriptor.configurable,
        enumerable: protoRegisterDescriptor.enumerable,
        hasValue: "value" in protoRegisterDescriptor,
        hasGetter: typeof protoRegisterDescriptor.get === "function",
        hasSetter: typeof protoRegisterDescriptor.set === "function"
      } : null
    };
  }

  function sameNonBlank(a, b) {
    const aa = String(a ?? "").trim();
    const bb = String(b ?? "").trim();
    return !!aa && !!bb && aa === bb;
  }

  function buildPredictedConflicts({ syntaxStatus, gateStatus }) {
    const conflicts = [];

    const syntaxActorMode = syntaxStatus?.actorPatchMode ?? null;
    const gateActorMode = gateStatus?.actorPatchMode ?? null;

    const syntaxActorTarget = syntaxStatus?.actorPatchTarget ?? null;
    const gateActorTarget = gateStatus?.actorPatchTarget ?? null;

    const syntaxEffectMode =
      syntaxStatus?.customEffectPatchMode ??
      syntaxStatus?.effectPatchMode ??
      null;

    const gateEffectMode = gateStatus?.effectPatchMode ?? null;

    const syntaxEffectTarget =
      syntaxStatus?.customEffectPatchTarget ??
      syntaxStatus?.effectPatchTarget ??
      null;

    const gateEffectTarget = gateStatus?.effectPatchTarget ?? null;

    if (
      syntaxActorMode === "libWrapper" &&
      gateActorMode === "libWrapper" &&
      sameNonBlank(syntaxActorTarget, gateActorTarget)
    ) {
      conflicts.push({
        target: "CONFIG.Actor.documentClass.prototype.applyActiveEffects",
        confidence: "high",
        reason: "Both AE Syntax and AE Gate report libWrapper patching the same Actor applyActiveEffects target."
      });
    }

    if (
      syntaxEffectMode === "libWrapper" &&
      gateEffectMode === "libWrapper" &&
      sameNonBlank(syntaxEffectTarget, gateEffectTarget)
    ) {
      conflicts.push({
        target: "CONFIG.ActiveEffect.documentClass.prototype.apply",
        confidence: "high",
        reason: "Both AE Syntax and AE Gate report libWrapper patching the same ActiveEffect apply target."
      });
    }

    return conflicts;
  }

  function collectEffectSyntaxExamples({ limit = 40 } = {}) {
    const rows = [];

    const hasAeSyntax = (value) => {
      return /\b(?:ae|aeUuid|aeStatus|countAe|aeValue)\s*\(/.test(String(value ?? ""));
    };

    const hasGateSyntax = (value) => {
      return /\b(?:aeWhen|aeUuidWhen|aeStatusWhen)\s*\(/i.test(String(value ?? ""));
    };

    const addChange = ({ actor, item = null, effect, change, source }) => {
      const value = String(change?.value ?? "");
      const normal = hasAeSyntax(value);
      const gate = hasGateSyntax(value);

      if (!normal && !gate) return;

      rows.push({
        actor: actor?.name ?? "(no actor)",
        item: item?.name ?? "",
        effect: effect?.name ?? effect?.label ?? effect?.id ?? "(effect)",
        key: change?.key ?? "",
        value,
        hasAeSyntax: normal,
        hasGateSyntax: gate,
        bothInSameValue: normal && gate,
        source
      });
    };

    for (const actor of Array.from(game.actors ?? [])) {
      for (const effect of Array.from(actor.effects ?? [])) {
        for (const change of Array.from(effect?.changes ?? [])) {
          addChange({ actor, effect, change, source: "actor.effects" });
          if (rows.length >= limit) return rows;
        }
      }

      for (const item of Array.from(actor.items ?? [])) {
        for (const effect of Array.from(item.effects ?? [])) {
          for (const change of Array.from(effect?.changes ?? [])) {
            addChange({ actor, item, effect, change, source: "item.effects" });
            if (rows.length >= limit) return rows;
          }
        }
      }
    }

    return rows;
  }

  function buildReport() {
    installConsoleWarnSpy();

    const statusObjects = getStatusObjects();
    const prototypeSnapshot = getPrototypeSnapshot();
    const libWrapperSnapshot = getLibWrapperSnapshot();
    const syntaxExamples = collectEffectSyntaxExamples();

    const predictedConflicts = buildPredictedConflicts(statusObjects);

    return {
      ok: true,
      version: state.version,
      time: new Date().toISOString(),

      settings: {
        activeEffectSyntaxEnabled: getSettingSafe("activeEffectSyntax.enabled"),
        activeEffectSyntaxUseLibWrapper: getSettingSafe("activeEffectSyntax.useLibWrapper"),
        activeEffectConditionalGateEnabled: getSettingSafe("activeEffectConditionalGate.enabled"),
        activeEffectConditionalGateUseLibWrapper: getSettingSafe("activeEffectConditionalGate.useLibWrapper")
      },

      ...statusObjects,

      libWrapperSnapshot,
      prototypeSnapshot,

      warningCalls: state.warningCalls,
      syntaxExamples,
      predictedConflicts
    };
  }

  function printReport() {
    const report = buildReport();

    console.groupCollapsed(`${TAG} Report V2`);
    console.log("Raw report object:", report);

    console.table([
      {
        system: "AE Syntax",
        actorPatched: report.syntaxStatus?.actorPatched ?? null,
        actorPatchTarget: report.syntaxStatus?.actorPatchTarget ?? null,
        actorPatchMode: report.syntaxStatus?.actorPatchMode ?? null,
        effectPatched: report.syntaxStatus?.customEffectPatched ?? report.syntaxStatus?.effectPatched ?? null,
        effectPatchTarget: report.syntaxStatus?.customEffectPatchTarget ?? report.syntaxStatus?.effectPatchTarget ?? null,
        effectPatchMode: report.syntaxStatus?.customEffectPatchMode ?? report.syntaxStatus?.effectPatchMode ?? null
      },
      {
        system: "AE Gate",
        actorPatched: report.gateStatus?.actorPatched ?? null,
        actorPatchTarget: report.gateStatus?.actorPatchTarget ?? null,
        actorPatchMode: report.gateStatus?.actorPatchMode ?? null,
        effectPatched: report.gateStatus?.effectPatched ?? null,
        effectPatchTarget: report.gateStatus?.effectPatchTarget ?? null,
        effectPatchMode: report.gateStatus?.effectPatchMode ?? null
      }
    ]);

    console.log("libWrapper snapshot:", report.libWrapperSnapshot);
    console.log("Prototype snapshot:", report.prototypeSnapshot);

    if (report.predictedConflicts.length) {
      console.warn(`${TAG} Predicted self-conflict:`, report.predictedConflicts);
    } else {
      console.log(`${TAG} No predicted self-conflict from status objects.`);
    }

    if (report.warningCalls.length) {
      console.log("Captured libWrapper warnings:");
      console.table(report.warningCalls.map(w => ({
        time: w.time,
        text: w.text.slice(0, 240)
      })));
    } else {
      console.log("No libWrapper warning captured by this probe yet. Reload with this probe before the syntax scripts to capture startup warnings.");
    }

    if (report.syntaxExamples.length) {
      console.log("Detected AE syntax examples:");
      console.table(report.syntaxExamples.map(r => ({
        actor: r.actor,
        item: r.item,
        effect: r.effect,
        key: r.key,
        hasAeSyntax: r.hasAeSyntax,
        hasGateSyntax: r.hasGateSyntax,
        bothInSameValue: r.bothInSameValue,
        source: r.source,
        value: r.value.slice(0, 120)
      })));
    }

    console.groupEnd();

    return report;
  }

  function installApi() {
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};

    globalThis.FUCompanion.api.aeLibWrapperProbe = {
      version: state.version,

      status() {
        installConsoleWarnSpy();

        return {
          ok: true,
          version: state.version,
          consoleWarnSpyInstalled: state.consoleWarnSpyInstalled,
          capturedWarnings: state.warningCalls.length,
          libWrapper: getLibWrapperSnapshot()
        };
      },

      report() {
        return printReport();
      },

      data() {
        return state;
      },

      restoreConsoleWarn
    };
  }

  installApi();
  installConsoleWarnSpy();

  Hooks.once("ready", () => {
    setTimeout(() => {
      printReport();
    }, 1200);
  });

  console.log(TAG, "Probe V2 loaded. API: FUCompanion.api.aeLibWrapperProbe.report()");
})();