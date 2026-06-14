// Director-native animation runner.
//
// Ports the core gate + script-execution logic from the legacy
// ActionAnimationHandler macro into a director-owned ESM module so animations
// are managed by the FSM (ANIMATION state) rather than firing as a macro
// side-effect. All existing item `animation_script` field content works
// unchanged — same hook protocol (oni:animationStart / oni:animationEnd), same
// Function(payload, targets) call shape, same globalThis.__PAYLOAD/__TARGETS
// publishing convention.
//
// BD is GM-only in v1, so the non-GM GMExecutor path from the legacy
// ActionAnimationHandler is deliberately omitted — the animation always
// executes on the GM client.

import { log, warn } from "./logger.js";
import { INTENTS } from "./intents.js";

// Compiled function cache — avoids re-parsing the same animation script on
// every use. Keyed by script text (exact string), module-level singleton.
const _scriptCache = new Map();

// ── Spec resolution ─────────────────────────────────────────────────────
//
// Resolves animation parameters from an actionResult. Tries, in order:
//   1. Pre-stamped fields on ar (animationScriptRaw / animTimingMode / animTimingOffset)
//      — future-proofing: a COMPUTE handler that already fetched the item can
//        stamp these so the async fetch below is skipped entirely.
//   2. ar.skillUuid → skill item's system.props  (Skill / Spell / Item actions)
//   3. ar.weapon    → weapon item's system.props  (Attack actions)
//
// Returns { hasScript: bool, script: string, timingMode: string, timingOffset: number }.

export async function resolveAnimationSpec(ar) {
  const EMPTY = { hasScript: false, script: "", timingMode: "default", timingOffset: 0 };
  if (!ar) return EMPTY;

  // 1. Pre-stamped fields (COMPUTE handler already read the item).
  if (ar.animationScriptRaw !== undefined) {
    return _buildSpec(ar.animationScriptRaw, ar.animTimingMode, ar.animTimingOffset);
  }

  // 2. Skill / Spell / Item action — fetch the backing item by UUID.
  const skillUuid = ar.skillUuid ?? null;
  if (skillUuid) {
    try {
      const item = await fromUuid(skillUuid);
      if (item?.system?.props) {
        const p = item.system.props;
        return _buildSpec(
          p.animation_script,
          p.animation_damage_timing_options,
          p.animation_damage_timing_offset,
        );
      }
    } catch (e) {
      warn("[BD Anim] resolveAnimationSpec: skill fromUuid threw", e);
    }
  }

  // 3. Attack action — try the weapon's backing item. The weapon snapshot
  //    on `ar` may carry `.uuid` (set by some TARGET paths) or `.weaponUuid`.
  const weaponUuid = ar.weapon?.uuid ?? ar.weapon?.weaponUuid ?? null;
  if (weaponUuid) {
    try {
      const item = await fromUuid(weaponUuid);
      if (item?.system?.props) {
        const p = item.system.props;
        return _buildSpec(
          p.animation_script,
          p.animation_damage_timing_options,
          p.animation_damage_timing_offset,
        );
      }
    } catch (e) {
      warn("[BD Anim] resolveAnimationSpec: weapon fromUuid threw", e);
    }
  }

  return EMPTY;
}

// Strip HTML tags produced by Foundry's ProseMirror/TipTap rich-text editor.
// The animation_script CSB field is a rich-text area: each source line is
// wrapped in a <p>...</p>. We must convert </p> and <br> to newlines BEFORE
// stripping tags — otherwise textContent concatenates all lines into one,
// turning the leading // comment into a single-line comment that swallows the
// entire rest of the script.
function _stripHtml(html) {
  const raw = String(html ?? "")
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  if (typeof document !== "undefined") {
    const el = document.createElement("div");
    el.innerHTML = raw;
    return el.textContent ?? el.innerText ?? "";
  }
  // Fallback for non-browser environments (tests).
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function _buildSpec(rawScript, rawMode, rawOffset) {
  const script = _stripHtml(rawScript).trim();
  // Reject empty strings and the legacy placeholder sentinel (same check as
  // ActionAnimationHandler's isPlaceholderScript).
  if (!script || /insert your sequencer animation here/i.test(script)) {
    return { hasScript: false, script: "", timingMode: "default", timingOffset: 0 };
  }
  return {
    hasScript: true,
    script,
    timingMode:   _parseTimingMode(rawMode),
    timingOffset: _parseTimingOffset(rawOffset),
  };
}

function _parseTimingMode(raw) {
  const s = String(raw ?? "default").trim().toLowerCase();
  return (s === "offset" || s === "timing_offset") ? "timing_offset" : "default";
}

function _parseTimingOffset(raw) {
  const n = Number(raw ?? 0);
  return (Number.isFinite(n) && n >= 0) ? n : 0;
}

// ── Preload URL extraction ──────────────────────────────────────────────
//
// Scans actor skill items for the `animation_preload_urls` template field
// (comma- or newline-separated URL list). Content authors list the Sequencer
// effect paths their animation script references here so they can be warmed
// during the PREP curtain, eliminating the first-use network hitch.
//
// TODO (future): Also parse `animation_script` fields via regex to extract
// .file("...") Sequencer calls automatically, removing the need for a
// separate URL list. Regex-scraping arbitrary JS is fragile, so it is
// deferred; `animation_preload_urls` is the stable explicit contract for now.
export function extractAnimationUrlsFromActors(actorDocs) {
  const urls = new Set();
  for (const actor of (actorDocs ?? [])) {
    for (const item of (actor?.items?.contents ?? [])) {
      const raw = String(item?.system?.props?.animation_preload_urls ?? "").trim();
      if (!raw) continue;
      for (const url of raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)) {
        urls.add(url);
      }
    }
  }
  return Array.from(urls);
}

// ── Damage gate ─────────────────────────────────────────────────────────
//
// Mirrors the timing logic from ActionAnimationHandler:
//   "default"       → await oni:animationEnd  (script fires this when done)
//   "timing_offset" → await oni:animationStart then wait offsetMs
// A wall-clock failsafe resolves the promise if neither hook arrives within
// timeoutMs (matching the 35 s ANIMATION state FSM timeout with some margin).

function waitForDamageMoment(timingMode, timingOffset, { timeoutMs = 35000 } = {}) {
  if (timingMode === "timing_offset") {
    return new Promise((resolve) => {
      let started = false;
      let offsetTimer = null;
      let failSafe = null;

      const cleanup = () => {
        Hooks.off("oni:animationStart", onStart);
        if (offsetTimer) clearTimeout(offsetTimer);
        if (failSafe)   clearTimeout(failSafe);
      };

      const onStart = () => {
        if (started) return;
        started = true;
        if (timingOffset <= 0) { cleanup(); resolve(); return; }
        offsetTimer = setTimeout(() => { cleanup(); resolve(); }, timingOffset);
      };

      Hooks.on("oni:animationStart", onStart);
      failSafe = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
    });
  }

  // Default: oni:animationEnd
  return new Promise((resolve) => {
    let done = false;
    let timer;

    const cleanup = () => {
      Hooks.off("oni:animationEnd", onEnd);
      clearTimeout(timer);
    };

    const onEnd = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };

    Hooks.on("oni:animationEnd", onEnd);
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    }, timeoutMs);
  });
}

// ── Script compiler ─────────────────────────────────────────────────────

function compileScript(script) {
  let fn = _scriptCache.get(script);
  if (!fn) {
    fn = new Function("payload", "targets", '"use strict";\n' + script);
    _scriptCache.set(script, fn);
  }
  return fn;
}

// ── Main runner ─────────────────────────────────────────────────────────
//
// Called from AnimationState.onEnter. Runs the animation script, awaits the
// damage gate, then enqueues INTERNAL_DONE so the FSM advances to RESOLVE.
//
// Sets director.ctx.animationController = { playing: true, abort: fn } for the
// duration so `director.isAnimationPlaying` returns true and
// `director.skipAnimation()` can abort early.
//
// The script receives `payload` and `targets` matching the
// ActionAnimationHandler convention. globalThis.__PAYLOAD / __TARGETS are also
// published so animation scripts that reference those globals continue to work.

export async function playDirectorAnimation({ spec, director, casterTokenUuid, targetTokenUuids }) {
  const { script, timingMode, timingOffset } = spec;

  // Resolve token placeables for the `targets` argument. Scripts typically
  // call target.position, target.center, etc. on the placeable.
  const targets = (targetTokenUuids ?? []).map((u) => {
    const id = String(u ?? "").split(".Token.").pop();
    return id ? (canvas?.tokens?.get?.(id) ?? null) : null;
  }).filter(Boolean);

  // Payload shape that mirrors what ActionAnimationHandler publishes so
  // existing animation scripts' PAYLOAD references resolve correctly.
  const payload = {
    sourceTokenUuid:  casterTokenUuid ?? null,
    casterTokenUuid:  casterTokenUuid ?? null,
    targetTokenUuids: targetTokenUuids ?? [],
    // Legacy aliases — existing animation scripts use targetTokenIds / targets[].tokenUuid
    // via their pickTargetsFromPayload helpers. UUIDs are valid input to resolveToken.
    targetTokenIds: targetTokenUuids ?? [],
    targets: (targetTokenUuids ?? []).map((u) => ({
      tokenUuid: u,
      tokenId: String(u ?? "").split(".Token.").pop(),
    })),
    animationScriptRaw: script,
    animation_damage_timing_options: timingMode,
    animation_damage_timing_offset:  timingOffset,
  };

  // Abort mechanism: calling abortResolve() collapses the gate Promise.race.
  let abortResolve;
  const abortPromise = new Promise((res) => { abortResolve = res; });

  director.ctx.animationController = { playing: true, abort: abortResolve };

  try {
    const fn = compileScript(script);

    // Race the normal gate against the abort signal so skipAnimation() resolves
    // the gate immediately without needing a separate state transition.
    const gatePromise = Promise.race([
      waitForDamageMoment(timingMode, timingOffset, { timeoutMs: 35000 }),
      abortPromise,
    ]);

    // Publish globals for animation scripts that read __PAYLOAD / __TARGETS
    // (the convention the legacy ActionAnimationHandler established).
    const prevPayload = globalThis.__PAYLOAD;
    const prevTargets = globalThis.__TARGETS;
    globalThis.__PAYLOAD = payload;
    globalThis.__TARGETS = targets;
    try {
      const result = fn(payload, targets);
      if (result && typeof result.then === "function") await result;
    } catch (e) {
      warn("[BD Anim] animation script threw", e);
    } finally {
      globalThis.__PAYLOAD = prevPayload;
      globalThis.__TARGETS = prevTargets;
    }

    await gatePromise;
    log("[BD Anim] gate resolved — advancing to RESOLVE");
  } catch (e) {
    warn("[BD Anim] playDirectorAnimation threw", e);
  } finally {
    director.ctx.animationController = null;
  }

  // Always advance — even on error or abort, RESOLVE must run to apply damage.
  director.enqueue({ type: INTENTS.INTERNAL_DONE });
}
