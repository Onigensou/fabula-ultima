/**
 * ONI Token Mask Persist (MODULE VERSION, Foundry V12)
 * - Auto reapplies token masks from world flags on every session load
 * - Designed to be loaded via module.json -> "esmodules"
 *
 * Uses flags:
 *   scope: "world"
 *   key:   "oniTokenMask"
 */

const FLAG_SCOPE  = "world";
const FLAG_KEY    = "oniTokenMask";
const MASK_NAME   = `${FLAG_KEY}.mask`;
const RUNTIME_KEY = "_oniMaskGfx";
const LASTCFG_KEY = "_oniMaskLastCfgKey";

const DEBUG = true;
const LOG_PREFIX = "[ONI][TokenMaskPersist:MOD]";

function log(...args) { if (DEBUG) console.log(LOG_PREFIX, ...args); }
function warn(...args) { console.warn(LOG_PREFIX, ...args); }

function getMaskTarget(token, maskWholeToken) {
  if (!token) return null;
  if (maskWholeToken) return token;
  return token.mesh ?? token.icon ?? token;
}

function clearMaskRuntime(token) {
  try {
    if (!token) return;

    const rt = token[RUNTIME_KEY];
    if (rt) {
      if (token.mesh?.mask === rt) token.mesh.mask = null;
      if (token.mask === rt) token.mask = null;
      if (rt.parent) rt.parent.removeChild(rt);
      rt.destroy({ children: true });
      token[RUNTIME_KEY] = null;
    }

    const leftovers = (token.children ?? []).filter(c => c?.name === MASK_NAME);
    for (const g of leftovers) {
      if (token.mesh?.mask === g) token.mesh.mask = null;
      if (token.mask === g) token.mask = null;
      if (g.parent) g.parent.removeChild(g);
      g.destroy({ children: true });
    }

    token[LASTCFG_KEY] = null;
  } catch (e) {
    warn("clearMaskRuntime failed", e);
  }
}

function applyMaskRuntime(token, cfg) {
  if (!token || !cfg) return;

  const cfgKey = JSON.stringify(cfg ?? {});
  if (token[RUNTIME_KEY] && token[LASTCFG_KEY] === cfgKey) return;

  clearMaskRuntime(token);

  const w = token.w;
  const h = token.h;

  const left   = Math.max(0, Number(cfg.left ?? 0));
  const right  = Math.max(0, Number(cfg.right ?? 0));
  const top    = Math.max(0, Number(cfg.top ?? 0));
  const bottom = Math.max(0, Number(cfg.bottom ?? 0));
  const pad    = Math.max(0, Number(cfg.pad ?? 2));

  const mw = Math.max(0, w - left - right);
  const mh = Math.max(0, h - top - bottom);
  if (mw <= 0 || mh <= 0) return;

  const g = new PIXI.Graphics();
  g.name = MASK_NAME;

  const rx = left - pad;
  const ry = top - pad;
  const rw = mw + pad * 2;
  const rh = mh + pad * 2;

  g.beginFill(0xFFFFFF, 1.0);
  g.drawRect(rx, ry, rw, rh);
  g.endFill();

  token.addChild(g);

  const target = getMaskTarget(token, !!cfg.maskWholeToken);
  if (target) target.mask = g;

  token[RUNTIME_KEY] = g;
  token[LASTCFG_KEY] = cfgKey;
}

function getFlagData(token) {
  try {
    return token?.document?.getFlag(FLAG_SCOPE, FLAG_KEY) ?? null;
  } catch (e) {
    warn("getFlagData failed", e);
    return null;
  }
}

function applyFromFlags(token, reason) {
  const data = getFlagData(token);
  const enabled = !!data?.enabled;
  const cfg = data?.cfg;

  if (!enabled || !cfg) {
    if (token?.[RUNTIME_KEY]) {
      log("CLEAR (no flag/enabled)", { reason, token: token.name, id: token.id });
      clearMaskRuntime(token);
    }
    return;
  }

  log("APPLY", { reason, token: token.name, id: token.id, cfg });
  applyMaskRuntime(token, cfg);
}

function sweep(reason) {
  const list = canvas.tokens?.placeables ?? [];
  log("SWEEP", { reason, scene: canvas?.scene?.name, count: list.length });

  for (const t of list) applyFromFlags(t, `sweep:${reason}`);
}

function installOnce() {
  // one install per browser session
  globalThis.__ONI_TOKEN_MASK_PERSIST_MOD__ ??= { installed: false };
  const state = globalThis.__ONI_TOKEN_MASK_PERSIST_MOD__;

  if (state.installed) {
    log("Already installed; doing initial sweep.");
    sweep("alreadyInstalled");
    return;
  }

  state.installed = true;
  log("Installing module persist hooks...");

  Hooks.on("canvasReady", () => sweep("canvasReady"));

  Hooks.on("drawToken", (token) => applyFromFlags(token, "drawToken"));
  Hooks.on("refreshToken", (token) => applyFromFlags(token, "refreshToken"));

  // If we’re already on a canvas, apply immediately
  if (canvas?.ready) sweep("postInstall");
}

function boot() {
  log("Boot start", { gameReady: !!game?.ready });
  installOnce();
}

// Robust: works even if the script is hot-loaded after ready
if (game?.ready) boot();
else Hooks.once("ready", boot);
