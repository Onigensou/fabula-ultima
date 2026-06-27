/**
 * Shared hot-reload registry — lets a module route a cross-module dependency
 * through a bumpable cache-bust token so edits to that dependency take effect
 * WITHOUT a hard browser reload (Ctrl+Shift+R).
 *
 * Why this exists
 * ---------------
 * Browser ESM caches modules by URL forever. A static
 *   import { x } from "./dep.js"
 * resolves the URL once and never re-fetches it, so editing dep.js is invisible
 * until a cache-BYPASS reload (Ctrl+Shift+R) — a plain F5 / Foundry bridge
 * reload reuses the cached module. Re-importing through a fresh URL
 *   import("./dep.js?cb=<token>")
 * forces a re-fetch. This registry centralizes the token + the re-import
 * bookkeeping so two callers share ONE mechanism:
 *   - the director test harness, which bumps the token per call, and
 *   - a live `FUCompanion.api.test.reloadHot()` during a real session.
 *
 * Usage — in the CONSUMING module (the one that knows the relative path):
 *
 *   import * as _depStatic from "./dep.js";
 *   import { registerHotModule } from "./hot-reload.js";
 *   const DEP = registerHotModule("battle-director/dep.js",
 *     (t) => import(`./dep.js?cb=${t}`), _depStatic);
 *   ...later...  await DEP().someExport(args)   // call THROUGH the accessor
 *
 * The accessor returns the static (boot) namespace until `refreshHotModules()`
 * runs, then the freshly-imported one. Callers MUST await `refreshHotModules()`
 * (or `reloadHot()`) after bumping the token before relying on fresh code.
 *
 * The loader thunk is defined in the consuming module on purpose: a dynamic
 * `import("./dep.js?…")` resolves relative to the file it is written in, so the
 * relative specifier stays correct. The registry only stores + invokes it.
 *
 * State lives on globalThis (not module scope) so it survives this module being
 * re-imported with a cache-bust by the harness — the registry is a singleton
 * regardless of how many times hot-reload.js is loaded.
 */

const TAG = "[FUCompanion][HotReload]";
const REGISTRY_KEY = "__FU_HOT_REGISTRY__";

function registry() {
  if (!Array.isArray(globalThis[REGISTRY_KEY])) globalThis[REGISTRY_KEY] = [];
  return globalThis[REGISTRY_KEY];
}

/** The current global cache-bust token (0 until the first bump). */
export function currentHotToken() {
  return globalThis.__FU_CB ?? 0;
}

/**
 * Register a hot-reloadable dependency and get back a synchronous accessor.
 *
 * @param {string}   key      Stable identity for this edge (e.g. the dep's
 *                            relpath). De-dupes across re-registration: the
 *                            harness re-imports the consuming module per call,
 *                            so its top-level registerHotModule runs again —
 *                            we reuse the existing entry instead of leaking a
 *                            new one each call, and every re-imported consumer
 *                            shares the one freshly-loaded namespace.
 * @param {(t:any)=>Promise<object>} loader  `(token) => import("./dep.js?cb="+token)`.
 * @param {object}  staticNs  The boot/static namespace, used until first refresh.
 * @returns {() => object}    Accessor returning the current namespace.
 */
export function registerHotModule(key, loader, staticNs) {
  const reg = registry();
  let entry = reg.find((e) => e.key === key);
  if (!entry) {
    entry = { key, loader, ns: staticNs, token: null };  // token null = never refreshed
    reg.push(entry);
  } else {
    // Keep the latest loader closure (relative path is identical, but the new
    // consumer instance owns the most current one). ns/token are preserved so a
    // module already refreshed this session stays fresh.
    entry.loader = loader;
  }
  return () => entry.ns;
}

/**
 * Re-import every registered dependency whose stored token is stale relative to
 * the current global token. Idempotent — an entry already at the current token
 * is skipped (no redundant import). A failed re-import keeps the previous
 * namespace (logged) so a typo mid-edit can't brick the live engine.
 *
 * @returns {Promise<number>} how many modules were actually re-imported.
 */
export async function refreshHotModules() {
  const token = currentHotToken();
  let refreshed = 0;
  await Promise.all(registry().map(async (entry) => {
    if (entry.token === token) return;  // already fresh for this token
    try {
      entry.ns = await entry.loader(token);
      entry.token = token;
      refreshed++;
    } catch (e) {
      console.error(`${TAG} re-import failed for "${entry.key}"; keeping previous module`, e);
    }
  }));
  return refreshed;
}

/**
 * Bump the global token and re-import every registered hot module. This is the
 * engine half of `FUCompanion.api.test.reloadHot()`.
 *
 * @returns {Promise<{token:any, refreshed:number, edges:string[]}>}
 */
export async function bumpAndRefresh() {
  globalThis.__FU_CB = currentHotToken() + 1;
  const refreshed = await refreshHotModules();
  return { token: globalThis.__FU_CB, refreshed, edges: registry().map((e) => e.key) };
}
