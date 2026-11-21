"use strict";
// move-engine · GAME build: one approved move (the same file the mockup page runs) → a BD animation_script.
//
//   const GB = require("<repo>/tools/move-engine/build/game-build.js");
//   const r = GB.buildScript({ key: "gb_sword", name: "Gunblade · Sword", files: [familyHead, movesFile],
//                              assets: GB.assetsFromMeta(meta, { only: source }), cfg: { tune: {...} } });
//   r.script (outer, for animation_script after encode) · r.encoded · r.inner · r.warnings
//
// Storage: the inner goes into the outer as a JSON string literal with every "$" and backtick escaped (\u0024, \u0060),
// so the stored field never holds a backtick or a dollar-brace, whatever the move's code uses (template literals are
// fine). The old String.raw-inner "exactly 2 backticks" rule does not apply to move-engine scripts.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const rd = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const { encode } = require(path.join(ROOT, "..", "anim-studio", "lib", "encode.js"));

const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const ORDER = ["shared/core.js", "game/runtime.js", "shared/fx-core.js", "shared/common.js", "shared/fx-melee.js", "shared/moves.js", "game/overrides.js"];
// DOM-only mockup helpers the game runtime does not draw: a move calling one is refused (list kept in step with runtime.js)
const UNSUPPORTED = ["silhouette", "swapArt", "restoreArt", "setLineup", "groundPortal", "impactFrame", "startDance", "wingsOn", "sprite", "battlerCopy", "castFocus", "castUnfocus"];
const WARN_ONLY = { cutin: "the game plays Zero Power cut-ins itself; the move only keeps its length", critCutin: "BD plays the crit cut-in BEFORE the animation; the move's call is a no-op" };

const src = (f) => (typeof f === "string" ? { name: path.basename(f), text: rd(f) } : f);

// the move's parts must not call DOM-only helpers; returns { errors, warnings }
function checkMoveSource(files) {
  const errors = [], warnings = [];
  for (const f of files.map(src)) {
    const body = f.text.replace(/\/\/[^\n]*/g, "");
    for (const n of UNSUPPORTED) if (new RegExp("(^|[^.\\w$])" + n + "\\s*\\(").test(body)) errors.push(f.name + ": calls " + n + "() — not in the game runtime");
    for (const [n, why] of Object.entries(WARN_ONLY)) if (new RegExp("(^|[^.\\w$])" + n + "\\s*\\(").test(body)) warnings.push(f.name + ": " + n + "() — " + why);
    if (/(^|[^.\w$])document\./.test(body)) warnings.push(f.name + ": touches document.* (the page DOM does not exist in the game)");
    if (/(^|[^.\w$])\$\(/.test(body)) warnings.push(f.name + ": uses $(…) page elements (a dummy in the game)");
  }
  return { errors, warnings };
}

// inner script = shared parts + game host + family parts + moves + the play call
function innerSource({ files = [], key, playOpts = null }) {
  const parts = ORDER.map((p) => "// ══ " + p + "\n" + rd(path.join(ROOT, p)));
  for (const f of files.map(src)) parts.push("// ══ " + f.name + "\n" + f.text);
  parts.push("// ══ play\nreturn await MOVE_PLAY(" + JSON.stringify(key) + (playOpts ? ", " + JSON.stringify(playOpts) : "") + ");");
  return parts.join("\n");
}

// clip / sound URLs on Forge for a mockup's meta.json (clips: { key: { w, h, ax, ay, dur, impact, ro } }, sfxSrc: { key: "Sound/…" })
function clipUrl(key, over) {
  if (over && over[key]) return over[key];
  if (/^\d{3}_/.test(key)) return FORGE + "Animation/RPG%20Maker%20MV/" + key + ".webm";
  if (/^gg_/.test(key)) return FORGE + "Animation/Guilty%20Gear%20Strive/webm/" + key.slice(3) + ".webm";
  if (key === "ro_sonicblow") return FORGE + "Animation/Ragnarok%20Online/sonicblow.webm";
  return null;
}
function assetsFromMeta(meta, { only = null, clipUrls = null, sfxUrls = null } = {}) {
  const used = (k) => !only || only.includes('"' + k + '"') || only.includes("'" + k + "'");
  const clips = {}, sfx = {}, missing = [];
  for (const [k, c] of Object.entries(meta.clips || {})) { if (!used(k)) continue; const url = clipUrl(k, clipUrls); if (!url) { missing.push("clip " + k); continue; }
    clips[k] = { url, w: c.w, h: c.h, dur: c.dur, ax: c.ax, ay: c.ay, k: c.ro || /^ro_/.test(k) ? 1.1 : .55, impact: c.impact, add: false }; }
  // a mockup's meta.sfxSrc is a Forge path for the game's sounds ("Sound/…"), but for ripped sounds it names the rip source
  // ("data.grf · …"): only Forge-looking paths are trusted; anything else needs sfxUrls, or it is reported missing
  for (const k of Object.keys(meta.sfx || {})) { if (!used(k)) continue; const src0 = meta.sfxSrc && meta.sfxSrc[k]; const rel = (sfxUrls && sfxUrls[k]) || (/^(Sound|Animation|Campaign|Resource)\//.test(src0 || "") ? src0 : null);
    if (!rel) { missing.push("sfx " + k); continue; } sfx[k] = /^https?:/.test(rel) ? rel : FORGE + rel.split("/").map(encodeURIComponent).join("/"); }
  return { clips, sfx, missing };
}

// the outer animation_script: hands the inner to pseudo.play with this action's caster / targets / outcomes / strikes
function shell({ key, name, cfg = {}, assets = {}, inner, timeout = 20000 }) {
  const j = (v) => JSON.stringify(v);
  const esc = (s) => JSON.stringify(s).replace(/\$/g, "\\u0024").replace(/`/g, "\\u0060");
  return [
    "// " + name + " · move-engine " + j(key) + " (tools/move-engine/build/game-build.js) — generated, do not edit by hand",
    "(async () => {",
    "const CFG = " + esc(cfg) + ";",
    "const ASSETS = " + esc(assets) + ";",
    "const ANIM_KEY = " + j("oni.move." + key) + ";",
    "const TAG = " + j("[ONI][Move][" + name + "]") + ";",
    "const P = globalThis.__PAYLOAD ?? payload ?? {};",
    "function tokFromUuid(u) { try { const d = fromUuidSync?.(u); return d?.object ?? null; } catch (_) { return null; } }",
    "function resolveSource() { for (const c of [P?.casterTokenUuid, P?.sourceTokenUuid, P?.tokenUuid]) { const t = tokFromUuid(c); if (t) return t; } return canvas?.tokens?.controlled?.[0] ?? null; }",
    "function resolveTargets() { const out = []; const arg = Array.isArray(targets) ? targets : []; for (const t of arg) if (t?.center) out.push(t);",
    "  if (!out.length && Array.isArray(globalThis.__TARGETS)) for (const t of globalThis.__TARGETS) if (t?.center) out.push(t); return out; }",
    "const sourceToken = resolveSource();",
    "const partyTargets = resolveTargets();",
    "const doneHook = 'oni.anim.' + ANIM_KEY + '.' + (foundry?.utils?.randomID?.(8) ?? String(Date.now()));",
    "const readyHook = doneHook + '.ready';",
    "function onceHook(hookName, timeoutMs) { return new Promise((resolve) => { let settled = false;",
    "  const timer = setTimeout(() => { if (settled) return; settled = true; Hooks.off(hookName, h); resolve({ ok: false, timeout: true }); }, timeoutMs);",
    "  const h = (d) => { if (settled) return; settled = true; clearTimeout(timer); Hooks.off(hookName, h); resolve(d ?? { ok: true }); }; Hooks.on(hookName, h); }); }",
    "function emitLocal(n, d) { try { Hooks.callAll(n, d); } catch (_) {} }",
    "const scriptSource = " + esc(inner) + ";",
    "try {",
    "  const waitReady = onceHook(readyHook, 8000);",
    "  const waitDone = onceHook(doneHook, CFG.totalTimeoutMs || " + timeout + ");",
    "  await game.ONI.pseudo.play({",
    "    scriptId: ANIM_KEY,",
    "    scriptSource,",
    "    casterTokenUuid: sourceToken?.document?.uuid ?? null,",
    "    targetTokenUuids: partyTargets.map((t) => t.document.uuid),",
    "    params: { doneHook, readyHook, cfg: CFG, assets: ASSETS, strikes: Array.isArray(P?.strikes) ? P.strikes : [], outcomes: Array.isArray(P?.outcomes) ? P.outcomes : null, variant: P?.variant ?? null },",
    "    meta: { source: " + j(name) + " },",
    "  });",
    "  await waitReady;",
    "  emitLocal('oni:animationStart', { type: ANIM_KEY, sceneId: canvas.scene?.id ?? null, sourceTokenId: sourceToken?.id ?? null });",
    "  const result = await waitDone;",
    "  if (!result?.ok) console.warn(TAG, 'pseudo non-OK / timeout', result);",
    "} catch (err) {",
    "  console.error(TAG, 'failed', err);",
    "} finally {",
    "  emitLocal('oni:animationEnd', { type: ANIM_KEY, timestamp: Date.now(), sourceTokenId: sourceToken?.id ?? null });",
    "}",
    "})();",
    "",
  ].join("\n");
}

// parse checks + the storage rules this format guarantees
function validateScript(script, inner) {
  const errors = [];
  try { new Function("payload", "targets", '"use strict";\n' + script); } catch (e) { errors.push("outer does not parse: " + e.message); }
  try { new Function("ctx", "canvas", "PIXI", "FAudioHelper", "loadTexture", "fromUuid", "wait", "foundry", "oni", "Sequence", '"use strict"; return (async () => {\n' + inner + "\n})();"); } catch (e) { errors.push("inner does not parse: " + e.message); }
  if (script.includes("`")) errors.push("outer holds a backtick");
  if (script.includes("${")) errors.push("outer holds a dollar-brace");
  return errors;
}

function buildScript({ key, name = key, files = [], assets = {}, cfg = {}, playOpts = null, timeout }) {
  const check = checkMoveSource(files);
  const inner = innerSource({ files, key, playOpts });
  const script = shell({ key, name, cfg, assets, inner, timeout });
  const errors = check.errors.concat(validateScript(script, inner));
  return { ok: !errors.length, errors, warnings: check.warnings, inner, script, encoded: encode(script), chars: script.length };
}

module.exports = { FORGE, ORDER, UNSUPPORTED, checkMoveSource, innerSource, assetsFromMeta, clipUrl, shell, validateScript, buildScript };
