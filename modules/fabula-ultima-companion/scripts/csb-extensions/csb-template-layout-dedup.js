/**
 * [ONI] CSB Template Layout Dedup — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * CSB stores a FULL COPY of the template's sheet layout (`system.body` +
 * `system.header`) on every instance. It is written by one assignment in
 * TemplateSystem.reloadTemplate (`body: template.system.body`) and read back by
 * prepareData to build `customBody`/`customHeader`. Nothing keeps the copy in
 * sync afterwards.
 *
 * Measured on this world (2026-07-28):
 *   - Hina: 100 embedded items carry only THREE distinct layouts. All 61 skills
 *     share ONE byte-identical 115 KB blob => 7,041 KB where 115 KB would do.
 *     12,099 KB of her 14,367 KB is repeated copies.
 *   - World-wide: ~280 MB of a ~409 MB join payload is duplicated layout.
 *   - Batch verified over 3,713 documents: 68.6% of items render BYTE-IDENTICAL
 *     from the master, 31.4% gain content they were missing (stale copies), and
 *     ZERO shrink.
 *
 * This file makes the stored copy OPTIONAL:
 *   (1) READ  — prepareData resolves the layout from the master when the
 *               instance's own is absent/empty.
 *   (2) WRITE — reloadTemplate stops re-stamping the copy onto instances, so a
 *               stripped world does not creep back as you author.
 *
 * SCOPE: ITEMS resolve from their MASTER template. Actors do not — measured
 * 2026-07-28, stripping a STALE actor to its template provably loses UI:
 * "Cradle" lost 22 rendered fields (the whole chanter_* block) because PC
 * instances carry per-instance layout the char template cannot reproduce. See
 * character-creation/cc-const.js, which already documents that re-stamping
 * resets authored dropdowns on PCs.
 *
 * ACTORS share their OWN layout instead (2026-11-03, see SHARED ACTOR LAYOUTS):
 * 316 actors stored 47 MB of layout but only 33 distinct layouts (5.6 MB). Each
 * distinct layout is kept ONCE, on the `_Layout Library` actor, and an actor
 * whose stored body is empty points at its entry by `flags.<ns>.layoutRef`. The
 * actor gets back exactly the layout it had: nothing is re-derived from a
 * template.
 *
 * SAFETY RAILS
 *   - Off by default. Enable via the `csbLayoutDedup` world setting.
 *   - Never touches an entity whose template does not RESOLVE: today's stored
 *     copy is the only thing rendering those, and blanking them would leave a
 *     dead sheet. (314 item docs are in that state right now.)
 *   - Never touches template/sub-template documents themselves — they are the
 *     source of truth and MUST keep their layout.
 *   - Shape-guarded: if CSB's internals stop looking like 4.8.5, the patch
 *     declines and logs rather than half-applying.
 *
 * NOT handled here: stripping the EXISTING copies. That is a separate migration
 * (a direct `update({system:{body:EMPTY}})`, never reloadTemplate — reload also
 * prunes props missing from the template and would delete authored data).
 *
 * ⚠ IIFE-wrapped: module.json scripts are CLASSIC scripts sharing one global
 * lexical scope, so a top-level `const` here collides with sibling files and
 * throws at PARSE time, silently skipping this ENTIRE file. Keep the wrapper.
 */

(() => {
    const TAG = '[CSB-LayoutDedup]';
    const SETTING = 'csbLayoutDedup';
    const EMPTY_BODY = { key: 'custom_body', type: 'panel', contents: [] };
    const EMPTY_HEADER = { key: 'custom_header', type: 'panel', contents: [] };

    const csbImport = import('/systems/custom-system-builder/module/documents/TemplateSystem.js')
        .then((m) => m.default);
    csbImport.catch(() => {});

    const enabled = () => {
        try { return !!game.settings.get('fabula-ultima-companion', SETTING); } catch { return false; }
    };

    /** Is this an INSTANCE we may dedup? Items only, never templates. */
    const isDedupableInstance = (entity) => {
        if (!entity || entity.documentName !== 'Item') return false;
        // Template + sub-template documents own the layout; never blank them.
        if (['_template', '_equippableItemTemplate'].includes(entity.type)) return false;
        return !!entity.system?.template;
    };

    /** Resolve an instance's master, or null when it dangles. */
    const resolveMaster = (entity) => {
        const tid = entity?.system?.template;
        if (!tid) return null;
        return game.items?.get(tid) ?? null;
    };

    const isEmptyPanel = (p) => !p || !Array.isArray(p.contents) || p.contents.length === 0;

    /* ------------------------------------------------- SHARED LAYOUT TREES -- */
    // CSB turns each document's layout JSON into a component tree (Panel.fromJSON)
    // the first time it prepares that document, and keeps one tree per document.
    // Measured 2026-11-03 on this world: 617 documents carry their own layout but
    // only 57 layouts are distinct, and the ~4,000 items that carry none (the READ
    // patch below) were handed a deep clone of their master's on EVERY prepare —
    // every actor update — though CSB builds the tree only once. Together ~4 s of
    // every client load.
    //
    // A tree is a pure function of its JSON, and CSB mutates trees only in the
    // template BUILDER (add / move / delete component), i.e. on template documents,
    // which never use this cache. So documents whose layout is the same share one
    // tree, built from a private copy of the JSON so it never aliases document data
    // (building mutates its input, which is why the READ patch used to clone).
    //
    // Kill switch: world setting `csbLayoutTreeCache` (default on; reload to apply).
    // Inspect: globalThis.__fuLayoutTreeCache.
    const TREE_SETTING = 'csbLayoutTreeCache';
    const TEMPLATE_TYPES = ['_template', '_equippableItemTemplate'];
    const TREE_CACHE_MAX = 500;
    const treeCache = new Map();     // key -> Panel
    const ownKeys = new WeakMap();   // a document's layout JSON object -> its content key
    const treeStats = { hits: 0, misses: 0 };
    let parseCtx = null;             // set only around a prepareData this file handles
    let treeOn = null;
    // Read once: settings.get scans the world settings on every call, and this runs
    // on every prepare of every document.
    const treeCacheOn = () => {
        if (treeOn !== null) return treeOn;
        try { treeOn = game.settings.get('fabula-ultima-companion', TREE_SETTING) !== false; }
        catch { return false; }
        return treeOn;
    };
    // A master's layout is identified by the document and its last change: a template
    // save bumps templateSystemUniqueVersion, and any server-side update stamps modifiedTime.
    const masterKey = (m) => `${m.id}|${m.system?.templateSystemUniqueVersion ?? ''}|${m._stats?.modifiedTime ?? ''}`;

    function patchFromJSON(Panel) {
        const orig = Panel.fromJSON;
        if (typeof orig !== 'function' || orig.__fuTreeCache) return;
        const patched = function (json, templateAddress, parent) {
            const ctx = parseCtx;
            // Only ROOT panels built by a prepareData we handle; everything else
            // (the builder, nested panels, other callers) is untouched.
            if (!ctx || parent !== undefined || !json || typeof json !== 'object') {
                return orig.call(this, json, templateAddress, parent);
            }
            let key;
            if (ctx.master && (json === ctx.master.body || json === ctx.master.header)) {
                key = `m|${ctx.master.key}|${json === ctx.master.body ? 'body' : 'header'}|${templateAddress}`;
            } else {
                key = ownKeys.get(json);
                if (!key) { key = `o|${templateAddress}|${JSON.stringify(json)}`; ownKeys.set(json, key); }
            }
            let tree = treeCache.get(key);
            if (tree) { treeStats.hits++; return tree; }
            treeStats.misses++;
            tree = orig.call(this, foundry.utils.deepClone(json), templateAddress, parent);
            if (treeCache.size >= TREE_CACHE_MAX) treeCache.delete(treeCache.keys().next().value);
            treeCache.set(key, tree);
            return tree;
        };
        patched.__fuTreeCache = true;
        Panel.fromJSON = patched;
        globalThis.__fuLayoutTreeCache = {
            stats: treeStats,
            get size() { return treeCache.size; },
            get on() { return treeCacheOn(); },
            clear() { treeCache.clear(); treeStats.hits = 0; treeStats.misses = 0; },
        };
    }

    Hooks.once('init', () => {
        try {
            game.settings.register('fabula-ultima-companion', TREE_SETTING, {
                name: 'CSB: share built sheet layouts',
                hint: 'Documents with the same sheet layout share one built layout instead of each '
                    + 'building its own. Speeds up loading. Requires a reload.',
                scope: 'world',
                config: false,
                type: Boolean,
                default: true,
            });
        } catch (e) { console.warn(`${TAG} tree-cache setting registration failed`, e); }
        try {
            game.settings.register('fabula-ultima-companion', SETTING, {
                name: 'CSB: resolve sheet layout from template',
                hint: 'Stops storing a full copy of the template sheet layout on every item. '
                    + 'Items resolve their layout from the master template instead. Items only; '
                    + 'actors are excluded. Requires a reload.',
                scope: 'world',
                config: false,       // deliberate: flip via API after verifying, not by accident
                type: Boolean,
                default: false,
            });
        } catch (e) { console.warn(`${TAG} setting registration failed`, e); }
    });

    Hooks.once('customSystemBuilderInit', async () => {
        let TemplateSystem;
        try { TemplateSystem = await csbImport; }
        catch (e) { console.warn(`${TAG} could not import TemplateSystem; skipping.`, e); return; }

        const proto = TemplateSystem?.prototype;
        if (!proto) { console.warn(`${TAG} TemplateSystem.prototype missing; skipping.`); return; }

        let Panel;
        try { Panel = (await import('/systems/custom-system-builder/module/sheets/components/Panel.js')).default; }
        catch (e) { console.warn(`${TAG} could not import Panel; shared layout trees disabled.`, e); }
        if (Panel) patchFromJSON(Panel);

        patchRead(proto);
        patchWrite(proto);
        console.info(`${TAG} installed (active: ${enabled()}, shared trees: ${!!Panel?.fromJSON?.__fuTreeCache}).`);
    });

    /* ------------------------------------------------ SHARED ACTOR LAYOUTS -- */
    // An actor with an empty stored body and `flags.<ns>.layoutRef` uses the layout
    // kept under that ref on the library actor (`flags.<ns>.layoutLibrary.layouts`),
    // a hidden `_template` actor written by tools/safe-edit/bin/_share-actor-layouts.js.
    // Content-addressed (the ref is a hash of the layout), so an entry never changes.
    //
    // Unlike the item path, the resolved layout STAYS on the prepared document
    // (`actor.system.body`, in memory only; `_source` keeps the empty one), because
    // module code reads it directly: battle-end-cleanup walks a PC's body for its
    // number fields, and the Active Effect Manager scans it for status tabs. Foundry
    // rebuilds `system` from `_source` on every update, so it is resolved again on
    // each prepare. Not gated by `csbLayoutDedup`: an actor with a ref has no other
    // layout, so resolving is never worse than stock.
    //
    // reloadTemplate on such an actor still stamps the template's layout onto it
    // (stock CSB); a stored body then wins over the ref, exactly as before.
    const NS = 'fabula-ultima-companion';
    const LIB_FLAG = 'layoutLibrary';
    const REF_FLAG = 'layoutRef';
    let libId = null;
    const missingRefs = new Set();
    function libraryLayouts() {
        let doc = libId ? game.actors?.get(libId) : null;
        if (!doc) {
            doc = game.actors?.find?.((a) => a.flags?.[NS]?.[LIB_FLAG]) ?? null;
            if (doc) libId = doc.id;
        }
        const lib = doc
            ? doc.flags[NS][LIB_FLAG]
            : game.data?.actors?.find?.((a) => a.flags?.[NS]?.[LIB_FLAG])?.flags?.[NS]?.[LIB_FLAG];
        return lib?.layouts ?? null;
    }
    /** The shared layout { ref, body, header } an actor points at, or null. */
    function sharedActorLayout(entity) {
        if (entity?.documentName !== 'Actor' || TEMPLATE_TYPES.includes(entity.type)) return null;
        const ref = entity.flags?.[NS]?.[REF_FLAG];
        if (!ref) return null;
        const entry = libraryLayouts()?.[ref];
        const body = entity.system?.body;
        // Empty stored body, or already resolved by an earlier prepare of this instance.
        if (entry && (isEmptyPanel(body) || body === entry.body)) return { ref, body: entry.body, header: entry.header };
        if (!entry && isEmptyPanel(body) && !missingRefs.has(ref)) {
            missingRefs.add(ref);
            console.error(`${TAG} ${entity.name}: shared layout ${ref} is not in the layout library — the sheet will be empty.`);
            if (game.user?.isGM) ui.notifications?.error(`Sheet layout missing for ${entity.name} (shared layout ${ref}). Is the "_Layout Library" actor present?`, { permanent: true });
        }
        return null;
    }
    globalThis.__fuSharedActorLayouts = { libraryLayouts, sharedActorLayout, missing: missingRefs };

    /* ---------------------------------------------------------------- READ -- */
    // prepareData builds customBody/customHeader from `this.entity.system.body`.
    // When an instance has no stored layout, substitute a DEEP CLONE of the
    // master's for the duration of the original call.
    //
    // The clone is load-bearing: handing prepareData a live reference to the
    // master lets CSB mutate the master's own component data, which silently
    // corrupts every other instance derived from it (observed 2026-07-28).
    function patchRead(proto) {
        const orig = proto.prepareData;
        if (typeof orig !== 'function') { console.warn(`${TAG} prepareData missing; skipping read patch.`); return; }
        if (orig.__fuLayoutDedup) return;

        const src = String(orig);
        if (!src.includes('customBody') || !src.includes('Panel.fromJSON')) {
            console.warn(`${TAG} prepareData body not as expected; skipping read patch.`);
            return;
        }

        const patched = function () {
            const entity = this.entity;
            const sys = entity?.system;
            const master = (enabled() && sys && isDedupableInstance(entity) && isEmptyPanel(sys.body))
                ? resolveMaster(entity) : null;   // null on a dangling pointer: stock behaviour
            const shared = (!master && sys) ? sharedActorLayout(entity) : null;
            if (shared) {
                // Left in place after the call (see SHARED ACTOR LAYOUTS).
                if (!treeCacheOn()) {
                    sys.body = foundry.utils.deepClone(shared.body);
                    sys.header = foundry.utils.deepClone(shared.header);
                    return orig.call(this);
                }
                sys.body = shared.body;
                sys.header = shared.header;
                const prev = parseCtx;
                parseCtx = { master: { key: `lib|${shared.ref}`, body: shared.body, header: shared.header } };
                try { return orig.call(this); } finally { parseCtx = prev; }
            }

            // Shared layout trees (see SHARED LAYOUT TREES below). Never for template
            // documents: the builder edits their trees in place.
            if (treeCacheOn() && sys && !TEMPLATE_TYPES.includes(entity.type)) {
                const prev = parseCtx;
                if (!master) {
                    parseCtx = { master: null };
                    try { return orig.call(this); } finally { parseCtx = prev; }
                }
                // The master's LIVE layout is safe to hand over here: CSB only reads it
                // through Panel.fromJSON, which this context routes to a tree built from
                // a private copy. No per-prepare clone, which CSB would discard anyway
                // whenever the tree is already built.
                const ob = sys.body, oh = sys.header;
                sys.body = master.system.body;
                sys.header = master.system.header;
                parseCtx = { master: { key: masterKey(master), body: sys.body, header: sys.header } };
                try { return orig.call(this); }
                finally { parseCtx = prev; sys.body = ob; sys.header = oh; }
            }

            if (!master) return orig.call(this);
            const ob = sys.body, oh = sys.header;
            sys.body = foundry.utils.deepClone(master.system.body);
            sys.header = foundry.utils.deepClone(master.system.header);
            try { return orig.call(this); }
            finally { sys.body = ob; sys.header = oh; }
        };
        patched.__fuLayoutDedup = true;
        proto.prepareData = patched;
    }

    /* --------------------------------------------------------------- WRITE -- */
    // reloadTemplate re-stamps `body`/`header` from the master onto the instance
    // (TemplateSystem.js ~694). Left alone, every re-stamp re-inflates the world.
    // We let CSB run untouched — its prop reconciliation must still happen — then
    // blank the layout it just wrote, so the READ patch supplies it instead.
    function patchWrite(proto) {
        const orig = proto.reloadTemplate;
        if (typeof orig !== 'function') { console.warn(`${TAG} reloadTemplate missing; skipping write patch.`); return; }
        if (orig.__fuLayoutDedup) return;

        const src = String(orig);
        if (!src.includes('body:') || !src.includes('templateSystemUniqueVersion')) {
            console.warn(`${TAG} reloadTemplate body not as expected; skipping write patch.`);
            return;
        }

        const patched = async function (templateId) {
            const result = await orig.call(this, templateId);
            if (!enabled()) return result;
            try {
                const entity = this.entity;
                if (!isDedupableInstance(entity)) return result;
                if (!resolveMaster(entity)) return result;
                if (isEmptyPanel(entity.system?.body)) return result;   // already lean
                await entity.update({ system: { body: EMPTY_BODY, header: EMPTY_HEADER } });
            } catch (e) {
                console.warn(`${TAG} post-reload blank failed for ${this.entity?.uuid}`, e);
            }
            return result;
        };
        patched.__fuLayoutDedup = true;
        proto.reloadTemplate = patched;
    }
})();
