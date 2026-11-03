/**
 * [ONI] CSB Derivation Perf — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * Surgical performance patches for CSB 4.8.5 (and, in (4), Foundry 12's
 * actor-update path; see that section). All are pure engine-side
 * fixes: NO world data, NO template surgery, NO migration.
 *
 * Measured on this world (Hina, 100 items, no sheets open, no combat):
 *
 *   (1) ItemContainer row fast-path
 *       Every `actor.prepareData()` re-derives each itemContainer's row props.
 *       For each matching item CSB emits ~10 compute entries (3 predefined
 *       hidden columns + one per row-layout column) and evaluates each through
 *       ComputablePhrase -> mathjs. Almost all of those formulas are trivial
 *       passthroughs (`${item.cost}$`), so the mathjs parse is pure overhead:
 *       measured 5.23 ms PER ROW, linear in row count.
 *
 *       CSB's own compute loop already accepts a plain function instead of a
 *       {formula, options} pair (TemplateSystem.js `_prepareEntityData`:
 *       `if (typeof computeValue === 'function')`). So a recognizably trivial
 *       column can be emitted as a closure and skip the formula engine wholly.
 *
 *       Result: prepareData 558 -> 211 ms (Hina), 369 -> 143 (Keren),
 *       163 -> 60 (Hako), 129 -> 63 (Kiki).
 *
 *       Anything NOT trivially recognizable falls back to CSB's original path,
 *       so semantics are preserved exactly. Verified byte-identical across all
 *       13 containers / 75 rows on Hina.
 *
 *   (2) CustomActiveEffect._onCreateOperation flag batching
 *       CSB stamps four bookkeeping flags on every newly created AE using four
 *       SEQUENTIAL AWAITED setFlag calls (CustomActiveEffect.js:19-22). Each is
 *       a separate document update, and each forces a full actor re-derive.
 *       An AE create therefore costs FIVE prepareData passes.
 *
 *       Measured baseline: 4,016 / 4,092 / 4,059 ms per AE create.
 *       Batched into one update: 5 passes -> 2, 4,389 -> 1,814 ms.
 *       With patch (1) also active: ~890 ms.
 *
 * Both patches latch on `customSystemBuilderInit` (the hook sibling extensions
 * use) and are shape-guarded: if CSB's internals don't look like the version
 * these were written against, the patch declines to install and warns rather
 * than silently changing behavior. Re-verify on any CSB upgrade.
 *
 * ⚠ EVERYTHING lives inside an IIFE. `module.json` scripts are CLASSIC scripts
 * sharing ONE global lexical scope, so a top-level `const X` here collides with
 * the same name in any sibling script — that throws SyntaxError at PARSE time
 * and silently skips this ENTIRE file. It bit exactly that way: `const TAG` and
 * `const _csbImports` both clash with csb-formula-compat.js. Keep the wrapper.
 */

(() => {
    const TAG = '[CSB-DerivationPerf]';

    console.info(`${TAG} script loaded — patches will apply on customSystemBuilderInit.`);

    // CSB's own predefined `id` hidden column is `'${item.id}'` — note the missing
    // closing `}$`. CSB therefore does NOT interpolate it; it emits the raw literal.
    // We reproduce that literal exactly rather than "fixing" it, so this patch is a
    // pure perf change. (`name` and `uuid` are correctly terminated and DO resolve.)
    // Verified against a pristine session: slow path yields this string for every row.
    const PREDEFINED_ID_LITERAL = '${item.id}';

    // Trivial row-column formula shapes. Each captures the item prop name.
    //   ${item.foo}$
    //   ${item.foo ? item.foo : ""}$      (the description columns)
    //   <p>${item.foo}$</p>               (wrapped description columns)
    const RX_PLAIN = /^\$\{item\.([A-Za-z_]\w*)\}\$$/;
    const RX_TERNARY = /^\$\{item\.([A-Za-z_]\w*) \? item\.\1 : ""\}\$$/;
    const RX_WRAPPED = /^(<p>|<b>|<i>)\$\{item\.([A-Za-z_]\w*)\}\$(<\/p>|<\/b>|<\/i>)$/;

    // Memoise the per-column decision on the component instance. Components are
    // built once from the template JSON and reused across every prepareData, so
    // this analysis runs once per column rather than once per row per derivation.
    const PLAN = Symbol('fuRowPlan');

    function planForField(field) {
        if (Object.prototype.hasOwnProperty.call(field, PLAN)) return field[PLAN];
        let plan = null;
        const raw = String(field?._value ?? '');
        let m;
        if ((m = RX_PLAIN.exec(raw)) || (m = RX_TERNARY.exec(raw))) {
            plan = { prop: m[1], prefix: '', suffix: '' };
        } else if ((m = RX_WRAPPED.exec(raw))) {
            plan = { prop: m[2], prefix: m[1], suffix: m[3] };
        }
        // null = "not trivially recognizable" -> always use CSB's original path.
        Object.defineProperty(field, PLAN, { value: plan, enumerable: false, writable: false });
        return plan;
    }

    const CSB = '/systems/custom-system-builder/module';
    const csbImports = Promise.all([
        import(`${CSB}/sheets/components/ItemContainer.js`),
        import(`${CSB}/documents/CustomActiveEffect.js`),
        import(`${CSB}/documents/TemplateSystem.js`),
        // what _prepareEntityData uses, for (7)
        import(`${CSB}/utils.js`),
        import(`${CSB}/errors/UncomputableError.js`),
        import(`${CSB}/interfaces/ComputableElement.js`),
        import(`${CSB}/interfaces/AttributeBarElement.js`),
        import(`${CSB}/documents/simpleImplementations/SimpleComputableElement.js`),
        import(`${CSB}/documents/simpleImplementations/SimpleAttributeBarElement.js`),
        import(`${CSB}/formulas/ComputablePhrase.js`),
        import(`${CSB}/Logger.js`),
        import(`${CSB}/interfaces/Modifier.js`),
    ]).then(([ic, ae, ts, u, ue, ce, abe, sce, sabe, cp, lg, mod]) => ({
        ItemContainer: ic.default, CustomActiveEffect: ae.default, TemplateSystem: ts.default,
        castToPrimitive: u.castToPrimitive, removeNull: u.removeNull, UncomputableError: ue.UncomputableError,
        isComputableElement: ce.isComputableElement, isAttributeBarElement: abe.isAttributeBarElement,
        SimpleComputableElement: sce.default, SimpleAttributeBarElement: sabe.default,
        ComputablePhrase: cp.default, Logger: lg.default, applyModifiers: mod.applyModifiers,
    }));
    csbImports.catch(() => {});

    Hooks.once('customSystemBuilderInit', async () => {
        let imports;
        try {
            imports = await csbImports;
        } catch (e) {
            console.warn(`${TAG} dynamic import of CSB internals failed; skipping patches.`, e);
            return;
        }
        patchItemContainerRowComputes(imports.ItemContainer);
        patchActiveEffectPreCreateStamp(imports.CustomActiveEffect);
        patchActiveEffectFlagBatching(imports.CustomActiveEffect);
        patchItemPrepareOnce();
        patchPassSnapshot(imports.TemplateSystem);
        patchIncrementalPrepare(imports);
        patchLazyDataMirror();
    });

    Hooks.once('init', () => {
        try {
            game.settings.register('fabula-ultima-companion', ITEM_ONCE_SETTING, {
                name: 'CSB: prepare items once per actor update',
                hint: 'An actor update prepares each of its items once instead of twice. '
                    + 'Requires a reload.',
                scope: 'world',
                config: false,
                type: Boolean,
                default: true,
            });
        } catch (e) { console.warn(`${TAG} item-prepare-once setting registration failed`, e); }
        try {
            game.settings.register('fabula-ultima-companion', ITEM_REUSE_SETTING, {
                name: 'CSB: keep unchanged items on an actor update',
                hint: 'An actor update keeps the derived data of items that did not change instead of '
                    + 'rebuilding every item. Requires a reload.',
                scope: 'world',
                config: false,
                type: Boolean,
                default: true,
            });
        } catch (e) { console.warn(`${TAG} item-reuse setting registration failed`, e); }
        try {
            game.settings.register('fabula-ultima-companion', SNAP_SETTING, {
                name: 'CSB: copy-on-write formula snapshot',
                hint: 'Each calculation pass copies the props only where the pass changes them instead '
                    + 'of deep-copying all of them. Requires a reload.',
                scope: 'world',
                config: false,
                type: Boolean,
                default: true,
            });
        } catch (e) { console.warn(`${TAG} pass-snapshot setting registration failed`, e); }
        try {
            game.settings.register('fabula-ultima-companion', INC_SETTING, {
                name: 'CSB: recalculate only what changed',
                hint: 'A calculation whose inputs are the same as last time keeps its last result instead '
                    + 'of going through the formula engine again. Requires a reload.',
                scope: 'world',
                config: false,
                type: Boolean,
                default: true,
            });
        } catch (e) { console.warn(`${TAG} incremental-prepare setting registration failed`, e); }
        try {
            game.settings.register('fabula-ultima-companion', MIRROR_SETTING, {
                name: 'Foundry: copy updated documents into game.data only when read',
                hint: 'An update no longer deep-copies the whole document into game.data; the copy is '
                    + 'made the first time something reads it. Requires a reload.',
                scope: 'world',
                config: false,
                type: Boolean,
                default: true,
            });
        } catch (e) { console.warn(`${TAG} lazy-mirror setting registration failed`, e); }
    });

    /* -------------------------------------------------------------- (1) --- */

    function patchItemContainerRowComputes(ItemContainer) {
        const proto = ItemContainer?.prototype;
        if (typeof proto?.getComputeFunctions !== 'function' ||
            typeof proto?._getRowEntries !== 'function' ||
            typeof proto?._getComputeFunctionsOfField !== 'function' ||
            typeof ItemContainer.getPredefinedHiddenColumns !== 'function') {
            console.warn(`${TAG} ItemContainer internals not as expected; skipping row fast-path.`);
            return;
        }
        if (proto.getComputeFunctions.__fuPatched) return;

        // Shape guard: we reproduce the three predefined hidden columns by hand, so
        // bail out if CSB's set ever changes (added/removed/renamed column).
        const predefined = ItemContainer.getPredefinedHiddenColumns().map((c) => c.key).sort();
        if (predefined.join(',') !== 'id,name,uuid') {
            console.warn(`${TAG} unexpected predefined hidden columns [${predefined}]; skipping row fast-path.`);
            return;
        }

        const orig = proto.getComputeFunctions;

        const patched = function (entity, modifiers, options, keyOverride) {
            const computationKey = keyOverride ?? this.key;
            const computableFields = this.contents.filter(
                (component) => typeof component?.getComputeFunctions === 'function'
            );
            const customHidden = this._hiddenColumns ?? [];
            const fns = {};

            for (const entry of this._getRowEntries(entity, computationKey, options)) {
                const item = entry.data;
                const itemProps = item?.system?.props ?? {};
                const ref = entry.reference;

                // Predefined hidden columns — resolved directly. `name`/`uuid` match
                // what CSB's formulas produce; `id` keeps CSB's un-interpolated literal.
                fns[`${ref}.name`] = () => item.name;
                fns[`${ref}.id`] = () => PREDEFINED_ID_LITERAL;
                fns[`${ref}.uuid`] = () => item.uuid;

                // Author-defined hidden columns are arbitrary formulas — original path.
                for (const hiddenColumn of customHidden) {
                    fns[`${ref}.${hiddenColumn.key}`] = {
                        formula: hiddenColumn.formula,
                        options: {
                            ...options,
                            reference: ref,
                            customProps: { ...options?.customProps, item: itemProps },
                            linkedEntity: item
                        }
                    };
                }

                for (const field of computableFields) {
                    const plan = planForField(field);
                    if (plan) {
                        const { prop, prefix, suffix } = plan;
                        fns[`${ref}.${field.key}`] = prefix || suffix
                            ? () => `${prefix}${itemProps[prop] ?? ''}${suffix}`
                            : () => itemProps[prop] ?? '';
                    } else {
                        Object.assign(
                            fns,
                            this._getComputeFunctionsOfField(entity, modifiers, entry, field, options)
                        );
                    }
                }
            }
            return fns;
        };

        patched.__fuPatched = true;
        patched.__fuOriginal = orig;
        proto.getComputeFunctions = patched;
        console.info(`${TAG} ItemContainer.getComputeFunctions patched (trivial row-column fast path).`);
    }

    /* -------------------------------------------------------------- (3) --- */
    // Stamp CSB's four bookkeeping flags DURING creation instead of after it, so
    // the whole AE-create costs ONE document cycle instead of two.
    //
    // Patch (2) below already collapsed CSB's four sequential setFlags into one
    // update — but that update is still a second full cycle (~500 ms on a heavy
    // PC). The flags can't simply be written pre-create because `originalId` /
    // `originalUuid` need the document's `_id`, and VERIFIED on this install:
    // at `_preCreateOperation` time `id`, `_id` and `_source._id` are all null
    // and `uuid` is the malformed "Actor.<id>.ActiveEffect." with an empty tail.
    //
    // So we assign the id ourselves and ask Foundry to honour it via
    // `operation.keepId`. Measured: 1,018 ms / 2 passes -> 466 ms / 1 pass, with
    // identical flag values and the assigned id surviving to the created doc.
    //
    // SAFETY — only for batches where EVERY document is a fresh creation (no
    // incoming `_id`). `keepId` is per-operation, not per-document, so forcing it
    // on a batch containing a COPY (effects duplicated from a template or another
    // parent carry their source `_id`) could collide with the source document's
    // id. Those batches fall through untouched and are handled by patch (2).
    function patchActiveEffectPreCreateStamp(CustomActiveEffect) {
        if (typeof CustomActiveEffect?._preCreateOperation !== 'function') {
            console.warn(`${TAG} _preCreateOperation missing; skipping pre-create stamping.`);
            return;
        }
        if (CustomActiveEffect._preCreateOperation.__fuPatched) return;
        if (typeof foundry?.utils?.randomID !== 'function') {
            console.warn(`${TAG} foundry.utils.randomID missing; skipping pre-create stamping.`);
            return;
        }

        const orig = CustomActiveEffect._preCreateOperation;
        const isFullBuilderTemplateEntity = (entity) =>
            !!entity && ['_template', '_equippableItemTemplate'].includes(entity.type);

        const patched = async function (documents, operation, user) {
            try {
                if (user?.id === game.user?.id && Array.isArray(documents) && documents.length) {
                    const allFresh = documents.every(
                        (d) => d && typeof d.updateSource === 'function' && !d._source?._id && !d.id
                    );
                    if (allFresh) {
                        const sid = game.system.id;
                        operation.keepId = true;
                        for (const effect of documents) {
                            const parent = effect.parent;
                            if (!parent?.uuid) continue;
                            const id = foundry.utils.randomID();
                            effect.updateSource({
                                _id: id,
                                [`flags.${sid}.originalParentId`]: parent.id,
                                [`flags.${sid}.originalId`]: id,
                                [`flags.${sid}.originalUuid`]: `${parent.uuid}.ActiveEffect.${id}`,
                                [`flags.${sid}.isFromTemplate`]: isFullBuilderTemplateEntity(parent)
                            });
                        }
                    }
                }
            } catch (e) {
                // Never let an optimisation break document creation — fall through
                // to the normal path, where patch (2) still stamps the flags.
                console.warn(`${TAG} pre-create stamping failed; falling back.`, e);
            }
            return orig.call(this, documents, operation, user);
        };

        patched.__fuPatched = true;
        patched.__fuOriginal = orig;
        CustomActiveEffect._preCreateOperation = patched;
        console.info(`${TAG} CustomActiveEffect._preCreateOperation patched (pre-create flag stamping).`);
    }

    /* -------------------------------------------------------------- (4) --- */
    // Foundry 12 prepares every item TWICE on each actor update (or AE add/remove):
    //   1. Actor#_initialize re-initializes the items collection, and each item's
    //      own _initialize prepares it (ClientDocumentMixin#_initialize);
    //   2. the actor's prepareData then prepares them all again in
    //      prepareEmbeddedDocuments.
    // Pass 2 overwrites everything pass 1 derived, and nothing reads the items in
    // between. Measured 2026-11-03 (Snapshot Runner): Hina's HP update = 222 item
    // prepares for 111 items. At boot Foundry prepares each item once (pass 1 is
    // skipped before documents are ready), so skipping it on updates as well
    // matches what every client already does on load.
    //
    // Pass 1 is skipped only while its own actor is inside _initialize, and the
    // skip ends as soon as that actor starts preparing. An item updated on its own
    // still prepares itself as before.
    //
    // Kill switch: world setting `csbItemPrepareOnce` (default on; reload to apply).
    // Toggle live for an A/B: globalThis.__fuItemPrepareOnce.on = false.
    //
    // (5) ITEM REUSE. Even prepared once, all 111 of Hina's items are rebuilt from their
    // source and re-derived on every write to HER, though none of them changed: ~40% of an
    // HP write after the formula memo (measured 2026-11-03). An item's derived data is a
    // function of its own source, its siblings (container items list them), its master
    // template's layout, and nothing else, UNLESS one of its formulas reaches outside the
    // item (fetchFromParent, fetchFromActor, a %{ }% script, randomness...), which
    // csb-formula-memo.js reports while the item prepares. So on an actor re-initialization
    // an item keeps its current fields and derived data, skipping both Foundry's
    // re-initialization and the prepare, when ALL of these hold:
    //   - it was fully prepared before and none of its formulas reached outside it;
    //   - its source object is the one it was prepared from;
    //   - no item of this actor changed since (the actor's items generation: bumped when
    //     any item initializes on its own, the set of item ids changes, or an actor update
    //     carries `items`);
    //   - its master template is the same version.
    // Anything else takes the full path, exactly as before.
    //
    // Kill switch: world setting `csbItemReuse` (default on; reload to apply).
    // Live A/B and stats: globalThis.__fuItemReuse ({ on, reused, full, external }).
    const ITEM_ONCE_SETTING = 'csbItemPrepareOnce';
    const ITEM_REUSE_SETTING = 'csbItemReuse';
    const REINIT = Symbol('fuReinitItems');
    const PASS = Symbol('fuActorPass');        // actor: id of the current re-initialization
    const GEN = Symbol('fuItemsGen');          // actor: items generation
    const IDS = Symbol('fuItemIds');           // actor: item-id signature at the last re-initialization
    const PREP = Symbol('fuItemPrep');         // item: what it was last fully prepared from
    const REUSED = Symbol('fuItemReused');     // item: the actor pass it was reused in
    const itemOnce = { on: null, skipped: 0 };
    const itemReuse = { on: null, reused: 0, full: 0, external: 0 };
    let passSeq = 0;

    const masterKey = (item) => {
        const m = game.items?.get?.(item.system?.template);
        return m ? `${m.id}|${m.system?.templateSystemUniqueVersion ?? ''}|${m._stats?.modifiedTime ?? ''}` : '';
    };

    function patchItemPrepareOnce() {
        const AP = CONFIG.Actor?.documentClass?.prototype;
        const IP = CONFIG.Item?.documentClass?.prototype;
        if (typeof AP?._initialize !== 'function' || typeof AP?._safePrepareData !== 'function' ||
            typeof AP?.updateSource !== 'function' ||
            typeof IP?._safePrepareData !== 'function' || typeof IP?._initialize !== 'function') {
            console.warn(`${TAG} Actor/Item _initialize/_safePrepareData/updateSource missing; skipping item-prepare-once.`);
            return;
        }
        if (IP._safePrepareData.__fuPatched) return;

        const origActorInit = AP._initialize;
        const origActorPrep = AP._safePrepareData;
        const origActorUpdateSource = AP.updateSource;
        const origItemInit = IP._initialize;
        const origItemPrep = IP._safePrepareData;

        AP.updateSource = function (changes, ...rest) {
            if (changes && typeof changes === 'object' && 'items' in changes) this[GEN] = (this[GEN] ?? 0) + 1;
            return origActorUpdateSource.call(this, changes, ...rest);
        };
        AP._initialize = function (...args) {
            this[REINIT] = true;
            this[PASS] = ++passSeq;
            const ids = Array.isArray(this._source?.items) ? this._source.items.map((i) => i?._id).join(',') : '';
            if (ids !== this[IDS]) { this[IDS] = ids; this[GEN] = (this[GEN] ?? 0) + 1; }
            try { return origActorInit.apply(this, args); }
            finally { this[REINIT] = false; }
        };
        AP._safePrepareData = function (...args) {
            this[REINIT] = false;
            // Scope for caches valid for exactly one prepare of this actor (the Active Effect
            // syntax files keep their per-actor effect index here).
            const prevScope = globalThis.__fuActorPrepScope;
            globalThis.__fuActorPrepScope = { actor: this, caches: new Map() };
            try { return origActorPrep.apply(this, args); }
            finally { globalThis.__fuActorPrepScope = prevScope; }
        };
        IP._initialize = function (...args) {
            const actor = this.parent;
            if (actor?.[REINIT]) {
                const prep = this[PREP];
                if (prep && !prep.external && itemReuseOn() && prep.src === this._source
                    && prep.gen === (actor[GEN] ?? 0) && prep.master === masterKey(this)) {
                    this[REUSED] = actor[PASS];
                    itemReuse.reused++;
                    return;
                }
            } else if (actor?.documentName === 'Actor') {
                // the item changed on its own: every sibling must re-derive next time
                actor[GEN] = (actor[GEN] ?? 0) + 1;
            }
            this[REUSED] = undefined;
            return origItemInit.apply(this, args);
        };
        const patched = function (...args) {
            const actor = this.parent;
            if (actor?.[REINIT] && itemOnceOn()) { itemOnce.skipped++; return; }
            if (this[REUSED] !== undefined && this[REUSED] === actor?.[PASS]) return;
            // Full prepare: learn whether any formula reaches outside the item.
            const prevCtx = globalThis.__fuPrepCtx;
            const ctx = { external: false };
            globalThis.__fuPrepCtx = ctx;
            try { return origItemPrep.apply(this, args); }
            finally {
                globalThis.__fuPrepCtx = prevCtx;
                if (actor?.documentName === 'Actor') {
                    // Without the formula memo's detection nothing proves an item self-contained.
                    const external = ctx.external || !globalThis.__fuFormulaMemo?.detectsExternal;
                    this[PREP] = { src: this._source, gen: actor[GEN] ?? 0, master: masterKey(this), external };
                    itemReuse.full++;
                    if (external) itemReuse.external++;
                }
            }
        };
        patched.__fuPatched = true;
        patched.__fuOriginal = origItemPrep;
        IP._safePrepareData = patched;
        globalThis.__fuItemPrepareOnce = itemOnce;
        globalThis.__fuItemReuse = itemReuse;
        console.info(`${TAG} item-prepare-once + item reuse installed.`);
    }

    // Read once, on first use: this patch installs during CSB's init, possibly
    // before the setting is registered, and settings.get is too slow per prepare.
    function itemOnceOn() {
        if (itemOnce.on === null) {
            try { itemOnce.on = game.settings.get('fabula-ultima-companion', ITEM_ONCE_SETTING) !== false; }
            catch { return true; }
        }
        return itemOnce.on;
    }
    function itemReuseOn() {
        if (itemReuse.on === null) {
            try { itemReuse.on = game.settings.get('fabula-ultima-companion', ITEM_REUSE_SETTING) !== false; }
            catch { return false; }
        }
        return itemReuse.on;
    }

    /* -------------------------------------------------------------- (6) --- */
    // PER-PASS SNAPSHOT. CSB computes an entity's props in passes (Hina: 4), and every pass
    // starts with `mergeObject(system.props, {}, { inplace: false })`: a deep copy of all of
    // them (375 props, 14 lists and tables), so that every formula in the pass reads the
    // values as they were when the pass began. ~1/6 of an HP write (measured 2026-11-03).
    //
    // Same contract, paid only where needed: the snapshot is a SHALLOW copy, and a list or
    // table inside it is deep-copied only at the moment the pass is about to write INTO it
    // (copy-on-write). A top-level value that is replaced (not written into) needs no copy:
    // the snapshot still holds the old one. Writes are seen through foundry.utils.setProperty,
    // which is how CSB's loop writes (`system.props`, and Active Effects through the actor).
    // Outside _prepareEntityData, and for any other mergeObject / setProperty call, nothing
    // changes.
    //
    // Kill switch: world setting `csbPassSnapshot` (default on; reload to apply).
    // Live A/B and stats: globalThis.__fuPassSnapshot ({ on, passes, copies }).
    const SNAP_SETTING = 'csbPassSnapshot';
    const passSnap = { on: null, passes: 0, copies: 0, layered: 0 };
    let snapCtx = null;   // { entity, live, snapshot } for the _prepareEntityData running now

    function patchPassSnapshot(TemplateSystem) {
        const proto = TemplateSystem?.prototype;
        const utils = globalThis.foundry?.utils;
        if (typeof proto?._prepareEntityData !== 'function' || typeof utils?.mergeObject !== 'function'
            || typeof utils?.setProperty !== 'function' || typeof utils?.deepClone !== 'function') {
            console.warn(`${TAG} _prepareEntityData / foundry.utils not as expected; skipping pass snapshot.`);
            return;
        }
        if (proto._prepareEntityData.__fuSnap) return;
        // Shape guard: the pass snapshot we replace must still be there.
        const src = String(proto._prepareEntityData);
        if (!/mergeObject\(system\.props, computedProps, \{\s*inplace: false\s*\}\)/.test(src)) {
            console.warn(`${TAG} _prepareEntityData no longer snapshots with mergeObject; skipping pass snapshot.`);
            return;
        }
        const origPrep = proto._prepareEntityData;
        const origMerge = utils.mergeObject;
        const origSet = utils.setProperty;
        const deepClone = utils.deepClone;

        // foundry.utils is a frozen module namespace, so its functions cannot be replaced. CSB
        // reaches them as `foundry.utils.X` at call time, though, and `foundry` is a plain
        // object: while a _prepareEntityData runs (synchronously, so nothing else runs in
        // between), `foundry.utils` points at a view of the namespace with these two overridden.
        const mergeObject = function (original, other, options) {
            const c = snapCtx;
            if (c && options && options.inplace === false && original && original === c.entity?.system?.props
                && other && typeof other === 'object' && Object.getPrototypeOf(other) === Object.prototype
                && Object.keys(other).length === 0) {
                passSnap.passes++;
                c.live = original;
                c.snapshot = { ...original };
                return c.snapshot;
            }
            // A formula with custom props (an item-container row: `item`, the row's own values)
            // reads `mergeObject(snapshot, customProps, { inplace: false })`: CSB deep-copies the
            // whole snapshot for every such formula. Same result, copying only what the merge
            // writes into: a shallow copy, with a deep copy of each top-level object the custom
            // props merge INTO, then the merge itself in place on that copy.
            if (c && c.snapshot && original === c.snapshot && options && options.inplace === false
                && other && typeof other === 'object' && Object.getPrototypeOf(other) === Object.prototype
                && !Object.keys(other).some((k) => k.includes('.'))) {   // dotted keys expand: CSB's own path
                const out = { ...original };
                for (const k of Object.keys(other)) {
                    const v = other[k], cur = out[k];
                    if (v && typeof v === 'object' && cur && typeof cur === 'object') out[k] = deepClone(cur);
                }
                passSnap.layered++;
                return origMerge(out, other, { ...options, inplace: true });
            }
            return origMerge(original, other, options);
        };
        const setProperty = function (object, key, value) {
            const c = snapCtx;
            if (c && c.snapshot && typeof key === 'string') {
                let sub = null;
                if (object === c.live) sub = key;
                else if (object === c.entity && key.startsWith('system.props.')) sub = key.slice(13);
                else if (object === c.entity?.system && key.startsWith('props.')) sub = key.slice(6);
                if (sub !== null) {
                    const dot = sub.indexOf('.');
                    if (dot > 0) {
                        const top = sub.slice(0, dot);
                        const cur = c.live[top];
                        if (cur && typeof cur === 'object' && c.snapshot[top] === cur) {
                            c.snapshot[top] = deepClone(cur);
                            passSnap.copies++;
                        }
                    }
                }
            }
            return origSet(object, key, value);
        };
        const realUtils = globalThis.foundry.utils;
        const view = Object.create(realUtils, {
            mergeObject: { value: mergeObject, enumerable: true },
            setProperty: { value: setProperty, enumerable: true },
        });
        globalThis.foundry.utils = view;
        const swappable = globalThis.foundry.utils === view;
        globalThis.foundry.utils = realUtils;
        if (!swappable) {
            console.warn(`${TAG} foundry.utils cannot be swapped; skipping pass snapshot.`);
            return;
        }

        const prep = function (...args) {
            if (!passSnapOn()) return origPrep.apply(this, args);
            const prevCtx = snapCtx;
            const prevUtils = globalThis.foundry.utils;
            snapCtx = { entity: this.entity, live: null, snapshot: null };
            globalThis.foundry.utils = view;
            try { return origPrep.apply(this, args); }
            finally { snapCtx = prevCtx; globalThis.foundry.utils = prevUtils; }
        };
        prep.__fuSnap = true;
        prep.__fuOriginal = origPrep;
        proto._prepareEntityData = prep;
        globalThis.__fuPassSnapshot = passSnap;
        console.info(`${TAG} copy-on-write pass snapshot installed.`);
    }

    function passSnapOn() {
        if (passSnap.on === null) {
            try { passSnap.on = game.settings.get('fabula-ultima-companion', SNAP_SETTING) !== false; }
            catch { return false; }
        }
        return passSnap.on;
    }

    /* -------------------------------------------------------------- (7) --- */
    // RECALCULATE ONLY WHAT CHANGED. After (1)-(6) and the formula memo, most of an HP write
    // was still CSB's calculation loop itself, though nearly every result comes back the same:
    // each formula, cache hit or not, is parsed into a phrase, gets a list of all 375 prop names,
    // a merged copy of the props when it lists an item, and a thrown error each pass it has to
    // wait for another prop (measured 2026-11-03: ~30 of Hina's ~51 ms).
    //
    // This is CSB 4.8.5's _prepareEntityData with the same passes, the same order, the same
    // pass-start reads, Active Effects, deprecated modifiers and attribute bars, and one change:
    // before a phrase is evaluated, the values it reads are compared with the values it read the
    // last time this prop was attempted on this document. Same values, same result (including
    // "not computable yet"), so the recorded result is reused and the formula engine is not
    // entered. A phrase's inputs come from the formula memo's plan of each of its formulas, so the
    // contract is the memo's: a formula reading only plain values is a function of them. Anything
    // else is evaluated exactly as CSB does, every time: a phrase with a script, a nested formula,
    // a local variable or any function the memo calls impure; an input that is not a plain value;
    // a row's custom props that would merge into an existing object. Deprecated modifiers and
    // Active Effects on a prop are applied to its result every time, reused or not.
    //
    // Also cheaper than CSB, same result: the pass-start copy of the props is copy-on-write along
    // the written path (see (6)); the prop-name list is built once per pass instead of once per
    // formula; the reset values merge without Foundry's dotted-key scan of all props per
    // component; an item container's reset finds "is any key under this row" by binary search;
    // a document built from a template keeps its component map until its layout tree changes.
    // Guarded by a hash of CSB's function: any other CSB version keeps CSB's own loop.
    //
    // Measured 2026-11-03 (Snapshot Runner): Hina's HP write 51 -> 19 ms under the profiler, ~13 ms
    // unprofiled, with (8) and the Active Effect gate's trace-only work skipped; Keren/Blanche/Zarg ~7 ms. Seeded battle: CSB
    // prepare 0.66 -> 0.32 s (6 ms a call), same battle. Parity: every actor and the party's input,
    // item and effect edits equal a full rebuild with all patches off (430/430).
    //
    // Kill switch: world setting `csbIncrementalPrepare` (default on; reload to apply).
    // Live A/B and stats: globalThis.__fuIncPrepare ({ on, prepares, replayed, evaluated, ... }).
    const INC_SETTING = 'csbIncrementalPrepare';
    // hash of CSB 4.8.5's TemplateSystem#_prepareEntityData with whitespace removed
    const CSB_PREP_HASH = '4786:hht46i';
    const inc = { on: null, prepares: 0, replayed: 0, evaluated: 0, unkeyed: 0, fns: 0, copies: 0 };
    const REC = Symbol('fuIncRecord');     // TemplateSystem: Map prop -> { formula, dv, ref, attempts }
    let incCtx = null;                      // { entity, live, snapshot } for the loop running now
    const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const isPlain = (v) => v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
    const hashOf = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return `${s.length}:${h.toString(36)}`; };
    const getPath = (obj, path) => {
        let cur = obj;
        for (const part of path.split('.')) { if (cur === null || cur === undefined) return undefined; cur = cur[part]; }
        return cur;
    };

    function patchIncrementalPrepare(H) {
        const proto = H.TemplateSystem?.prototype;
        const prev = proto?._prepareEntityData;
        if (typeof prev !== 'function' || prev.__fuInc) return;
        const hash = hashOf(String(prev.__fuOriginal ?? prev).replace(/\s+/g, ''));
        if (hash !== CSB_PREP_HASH) {
            console.warn(`${TAG} _prepareEntityData is not CSB 4.8.5's (hash ${hash}); skipping incremental prepare.`);
            return;
        }
        const { castToPrimitive, removeNull, UncomputableError, isComputableElement, isAttributeBarElement,
            SimpleComputableElement, SimpleAttributeBarElement, ComputablePhrase, Logger, applyModifiers } = H;
        const extract = ComputablePhrase?.prototype?._extractFormulas;
        const utils = globalThis.foundry?.utils;
        if ([castToPrimitive, removeNull, UncomputableError, isComputableElement, isAttributeBarElement,
            SimpleComputableElement, SimpleAttributeBarElement, ComputablePhrase, applyModifiers, extract,
            H.TemplateSystem.isAppliedTemplateSystem, utils?.mergeObject, utils?.setProperty, utils?.deepClone]
            .some((f) => typeof f !== 'function') || !Logger) {
            console.warn(`${TAG} CSB helpers for the calculation loop not found; skipping incremental prepare.`);
            return;
        }
        const realUtils = utils;
        const realMerge = utils.mergeObject, realSet = utils.setProperty, deepClone = utils.deepClone;

        // The pass-start copy shares every object the pass has not written into yet. Before a write
        // at `path` (relative to the props), copy each object on the path that is still shared.
        const detach = (c, path) => {
            if (path.indexOf('.') < 0) return;
            const parts = path.split('.');
            let s = c.snapshot, l = c.live;
            for (let i = 0; i < parts.length - 1; i++) {
                const k = parts[i];
                const lv = l[k];
                if (!lv || typeof lv !== 'object') return;          // created or replaced by the write
                let sv = s[k];
                if (sv === lv) { sv = Array.isArray(lv) ? lv.slice() : { ...lv }; s[k] = sv; inc.copies++; }
                else if (!sv || typeof sv !== 'object') return;
                s = sv; l = lv;
            }
        };
        const setProperty = function (object, key, value) {
            const c = incCtx;
            if (c && typeof key === 'string') {
                let sub = null;
                if (object === c.live) sub = key;
                else if (object === c.entity && key.startsWith('system.props.')) sub = key.slice(13);
                else if (object === c.entity?.system && key.startsWith('props.')) sub = key.slice(6);
                if (sub !== null) detach(c, sub);
            }
            return realSet(object, key, value);
        };
        // Writes from Active Effects reach the props through foundry.utils.setProperty; see (6) for
        // why foundry.utils is swapped rather than patched.
        const view = Object.create(realUtils, { setProperty: { value: setProperty, enumerable: true } });
        // The loop's own writes into the props: setProperty and the copy-on-write in one walk.
        const writeLive = (c, path, value) => {
            if (!path) return;
            if (path.indexOf('.') < 0) { c.live[path] = value; return; }
            const parts = path.split('.');
            let s = c.snapshot, l = c.live;
            for (let i = 0; i < parts.length - 1; i++) {
                const k = parts[i];
                if (!l || typeof l !== 'object') { detach(c, path); realSet(c.live, path, value); return; }
                if (!hasOwn(l, k)) l[k] = {};
                const lv = l[k];
                if (s) {
                    let sv = s[k];
                    if (sv === lv && lv && typeof lv === 'object') { sv = Array.isArray(lv) ? lv.slice() : { ...lv }; s[k] = sv; inc.copies++; }
                    s = sv && typeof sv === 'object' ? sv : null;
                }
                l = lv;
            }
            if (!l || typeof l !== 'object') { realSet(c.live, path, value); return; }
            l[parts[parts.length - 1]] = value;
        };

        // mergeObject(props, resetValues) as Foundry does it, without scanning all 375 prop names for a
        // dotted key on every call (one scan per prepare instead; reset values never have one).
        const getType = utils.getType;
        const fastMerge = (original, other) => {
            for (const k of Object.keys(other)) {
                const v = other[k];
                if (hasOwn(original, k)) {
                    const x = original[k];
                    if (getType(v) === 'Object' && getType(x) === 'Object') fastMerge(x, v);
                    else original[k] = v;
                } else if (v?.constructor === Object) original[k] = fastMerge({}, v);
                else original[k] = v;
            }
            return original;
        };
        // ItemContainer#resetComputeValue asks, for every existing row, whether ANY compute key
        // starts with it: rows x keys. A sorted key list answers each in one binary search.
        const IC = H.ItemContainer?.prototype;
        const icReset = IC?.resetComputeValue;
        const icResetSrc = String(icReset ?? '').replace(/\s+/g, '');
        const icResetKnown = typeof icReset === 'function'
            && icResetSrc.includes('constexistingRows=foundry.utils.getProperty(entity.system.props,this.key);')
            && icResetSrc.includes('if(!valueKeys.some((key)=>key.startsWith(buildKey))){foundry.utils.setProperty(resetValues,buildKey,null);}');
        const fastIcReset = function (valueKeys, entity) {
            const resetValues = {};
            for (const key of valueKeys) realSet(resetValues, key, undefined);
            const existingRows = utils.getProperty(entity.system.props, this.key);
            let sorted = null;
            for (const existingKey in existingRows) {
                const buildKey = `${this.key}.${existingKey}`;
                sorted ??= [...valueKeys].sort();
                let lo = 0, hi = sorted.length;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < buildKey) lo = mid + 1; else hi = mid; }
                if (!(lo < sorted.length && sorted[lo].startsWith(buildKey))) realSet(resetValues, buildKey, null);
            }
            return resetValues;
        };

        // A phrase's inputs: the union of its formulas' inputs, or null when it must be evaluated.
        const phrasePlans = new Map();
        const phrasePlan = (phrase, planFor) => {
            let p = phrasePlans.get(phrase);
            if (p !== undefined) return p;
            p = null;
            if (typeof phrase === 'string' && !phrase.includes('%{')) {
                const paths = new Set(), refs = new Set(), tables = new Set();
                let ok = true;
                for (const block of extract.call(null, phrase)) {
                    const inner = block.startsWith('${') && block.endsWith('}$') ? block.slice(2, -2) : null;
                    const fp = inner === null || inner.includes('${') ? null : planFor(inner);
                    if (!fp?.paths) { ok = false; break; }
                    fp.paths.forEach((x) => paths.add(x));
                    fp.refs.forEach((x) => refs.add(x));
                    fp.tables.forEach((x) => tables.add(x));
                }
                if (ok) p = { paths: [...paths], refs: [...refs], tables: [...tables] };
            }
            phrasePlans.set(phrase, p);
            return p;
        };
        // what the formula reads at `path` from `mergeObject(snapshot, customProps)`
        const read = (snap, cp, path) => {
            const dot = path.indexOf('.');
            const top = dot < 0 ? path : path.slice(0, dot);
            const base = cp && hasOwn(cp, top) ? cp : snap;
            return dot < 0 ? base[path] : getPath(base, path);
        };
        // The values this attempt reads, or null when it cannot be compared.
        const attemptValues = (plan, options, snap, cp) => {
            if (options && ((options.localVars && Object.keys(options.localVars).length)
                || (options.textVars && Object.keys(options.textVars).length)
                || (options.rolls && options.rolls.length) || options.computeExplanation)) return null;
            if (cp) {
                for (const k of Object.keys(cp)) {
                    const a = snap[k], b = cp[k];
                    if (k.includes('.') || b === undefined || (a && typeof a === 'object' && b && typeof b === 'object')) return null;
                }
            }
            const vals = [];
            for (const p of plan.paths) {
                const v = read(snap, cp, p);
                if (!isPlain(v)) return null;
                vals.push(v);
            }
            for (const r of plan.refs) {
                const v = read(snap, cp, r);
                if (!isPlain(v)) return null;
                vals.push(hasOwn(snap, r) || (!!cp && hasOwn(cp, r)), v);
            }
            for (const t of plan.tables) {
                const v = read(snap, cp, t);
                if (isPlain(v)) vals.push(v);
                else { try { vals.push('\u0003' + JSON.stringify(v)); } catch { return null; } }
            }
            return vals;
        };
        const sameValues = (a, b) => {
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
            return true;
        };
        // CSB: mergeObject(snapshot, customProps, { inplace: false }); copied only where the merge writes
        const layered = (snap, cp) => {
            if (Object.keys(cp).some((k) => k.includes('.'))) return realMerge(snap, cp, { inplace: false });
            const out = { ...snap };
            for (const k of Object.keys(cp)) {
                const v = cp[k], c = out[k];
                if (v && typeof v === 'object' && c && typeof c === 'object') out[k] = deepClone(c);
            }
            return realMerge(out, cp, { inplace: true });
        };

        // CSB 4.8.5 TemplateSystem#_prepareEntityData, line for line where not noted.
        function prepare(planFor) {
            let triggeredModifierWarning = false;
            if (!H.TemplateSystem.isAppliedTemplateSystem(this)) return;
            const system = this.entity.system;
            system.props.name = this.entity.name;
            system.props.uuid = this.uuid;
            system.props.id = this.entity.id;
            system.props.img = this.entity.img;
            const modifierPropsByKey = {};
            const allModifiers = this.getModifiers();
            for (const modifier of allModifiers) {
                this._computeModifierValues(modifier, modifier.originalEntity, modifierPropsByKey);
            }
            const activeEffectsByKey = this.getSortedActiveEffects(system);
            const computableComponents = Object.keys(this.componentMap)
                .filter((key) => isComputableElement(this.componentMap[key]))
                .reduce((res, key) => ((res[key] = this.componentMap[key]), res), {});
            const attributeBars = {
                ...Object.keys(system.attributeBar ?? {}).reduce((res, key) => ((res[key] = new SimpleAttributeBarElement(key, system.attributeBar[key].value ?? '', system.attributeBar[key].max, system.attributeBar[key].editable)),
                    res), {}),
                ...Object.keys(this.componentMap)
                    .filter((key) => isAttributeBarElement(this.componentMap[key]))
                    .reduce((res, key) => ((res[key] = this.componentMap[key]), res), {})
            };
            for (const hidden of system.hidden ?? []) {
                computableComponents[hidden.name] = new SimpleComputableElement(hidden.name, hidden.value);
            }
            const computeFormulas = {};
            const merge = Object.keys(system.props).some((k) => k.includes('.')) ? realMerge : fastMerge;
            for (const component in computableComponents) {
                const comp = computableComponents[component];
                const computeFunctions = comp.getComputeFunctions(this, modifierPropsByKey);
                const keys = Object.keys(computeFunctions);
                const reset = icResetKnown && comp.resetComputeValue === icReset
                    ? fastIcReset.call(comp, keys, this) : comp.resetComputeValue(keys, this);
                if (merge === fastMerge && Object.keys(reset).some((k) => k.includes('.'))) realMerge(system.props, reset);
                else merge(system.props, reset);
                // CSB spreads into a new object each time (quadratic); same keys, same order
                Object.assign(computeFormulas, computeFunctions);
            }
            system.props = removeNull(system.props);
            // CSB iterates `for (prop in uncomputedProps)` and deletes what it computes; the same order
            // with arrays (for...in over own string keys = Object.keys order)
            let pending = Object.keys(computeFormulas);
            const last = this[REC] instanceof Map ? this[REC] : null;
            const next = new Map();
            let nLoops = 0, nComputed = 0;
            do {
                nLoops++;
                nComputed = 0;
                const computedProps = {};
                const live = system.props;
                const snapshot = { ...live };        // CSB: a deep copy; here copy-on-write
                const ctx = { entity: this.entity, live, snapshot };
                incCtx = ctx;
                let snapKeys = null;
                const still = [];
                for (const prop of pending) {
                    const computeValue = computeFormulas[prop];
                    let value, ok = true;
                    if (typeof computeValue === 'function') {
                        inc.fns++;
                        try { value = computeValue(computedProps); }
                        catch (err) { if (err instanceof UncomputableError) ok = false; else throw err; }
                    } else {
                        const { formula, options } = computeValue;
                        const cp = options?.customProps;
                        const plan = phrasePlan(formula, planFor);
                        const vals = plan ? attemptValues(plan, options, snapshot, cp) : null;
                        let hit = null;
                        if (vals) {
                            const old = last?.get(prop);
                            if (old && old.formula === formula && old.dv === options?.defaultValue && old.ref === options?.reference) {
                                for (const a of old.attempts) if (sameValues(a.vals, vals)) { hit = a; break; }
                            }
                        } else inc.unkeyed++;
                        if (hit) {
                            inc.replayed++;
                            ok = hit.ok;
                            value = hit.value;
                        } else {
                            inc.evaluated++;
                            // __fuIncPrepare.trace = new Map() to count why props are evaluated
                            if (inc.trace) {
                                const why = !plan ? 'impure' : !vals ? 'unplain input'
                                    : !last?.get(prop) ? 'first attempt' : 'inputs changed';
                                const k = `${why} | ${String(formula).slice(0, 80)}`;
                                inc.trace.set(k, (inc.trace.get(k) ?? 0) + 1);
                            }
                            const formulaProps = cp ? layered(snapshot, cp) : snapshot;
                            const availableKeys = cp ? Object.keys(formulaProps) : (snapKeys ??= Object.keys(snapshot));
                            try {
                                value = ComputablePhrase.computeMessageStatic(formula, formulaProps, {
                                    ...options,
                                    source: prop,
                                    availableKeys,
                                    triggerEntity: this
                                }).result;
                            } catch (err) { if (err instanceof UncomputableError) ok = false; else throw err; }
                        }
                        // what is recorded is the phrase's own result; modifiers and Active Effects run every time
                        if (vals) {
                            let rec = next.get(prop);
                            if (!rec) next.set(prop, (rec = { formula, dv: options?.defaultValue, ref: options?.reference, attempts: [] }));
                            rec.attempts.push(hit ?? { vals, ok, value });
                        }
                        if (ok && (modifierPropsByKey[prop] || activeEffectsByKey[prop])) {
                            try {
                                if (modifierPropsByKey[prop]) {
                                    if (!triggeredModifierWarning) {
                                        Logger.warn(game.i18n.localize('CSB.Modifier.EditDialog.DeprecationWarning'));
                                        triggeredModifierWarning = true;
                                    }
                                    value = applyModifiers(value, modifierPropsByKey[prop]);
                                }
                                setProperty(system.props, prop, castToPrimitive(value));
                                if (activeEffectsByKey[prop]) {
                                    activeEffectsByKey[prop].forEach(({ activeEffect, change }) => {
                                        if (!activeEffect.active) return;
                                        const override = activeEffect.apply(this.entity, change, true);
                                        if (Object.values(override)[0] !== undefined && Object.values(override)[0] !== null) {
                                            value = Object.values(override)[0];
                                        }
                                    });
                                }
                            } catch (err) { if (err instanceof UncomputableError) ok = false; else throw err; }
                        }
                    }
                    if (ok) {
                        const v = castToPrimitive(value);
                        writeLive(ctx, prop, v);
                        realSet(computedProps, prop, v);
                        nComputed++;
                    } else {
                        writeLive(ctx, prop, undefined);
                        still.push(prop);
                    }
                }
                pending = still;
            } while (pending.length > 0 && nComputed > 0);
            incCtx = null;
            this[REC] = next;
            if (pending.length > 0) {
                const uncomputedProps = {};
                for (const prop of pending) uncomputedProps[prop] = computeFormulas[prop];
                Logger.warn('Some props were not computed.', { uncomputedProps, scope: system.props });
            }
            Logger.info(`All props for ${this.entity.name} (${this.entity.id}) computed in ${nLoops} loops.`);
            if (this.entityType === 'actor') {
                for (const prop in attributeBars) {
                    const max = attributeBars[prop].getMaxValue(this);
                    const value = attributeBars[prop].getValue(this);
                    const editable = attributeBars[prop].isEditable();
                    realSet(system.attributeBar, prop, { value, max, key: prop, editable });
                }
            }
        }

        const patched = function (...args) {
            const planFor = globalThis.__fuFormulaMemo?.planFor;
            if (!incOn() || typeof planFor !== 'function') return prev.apply(this, args);
            inc.prepares++;
            const prevCtx = incCtx;
            const prevUtils = globalThis.foundry.utils;
            globalThis.foundry.utils = view;
            try { return prepare.call(this, planFor); }
            finally { incCtx = prevCtx; globalThis.foundry.utils = prevUtils; }
        };
        globalThis.foundry.utils = view;
        const swappable = globalThis.foundry.utils === view;
        globalThis.foundry.utils = realUtils;
        if (!swappable) {
            console.warn(`${TAG} foundry.utils cannot be swapped; skipping incremental prepare.`);
            return;
        }
        patched.__fuInc = true;
        patched.__fuOriginal = prev.__fuOriginal ?? prev;
        proto._prepareEntityData = patched;

        // The component map (every keyed component of the sheet, flat) is rebuilt by walking the
        // whole layout tree on every prepare (~2 ms on Hina), though it depends on nothing but the
        // tree. A document built from a template keeps its tree until the template changes, when
        // CSB builds a new one: same tree objects, same map. Builder templates are edited in place,
        // so they always rebuild.
        const origMap = proto._getComponentMap;
        if (typeof origMap === 'function' && !origMap.__fuInc) {
            const CMAP = Symbol('fuComponentMap');
            const mapPatched = function () {
                const h = this.customHeader, b = this.customBody;
                if (!incOn() || (!h && !b) || !H.TemplateSystem.isAppliedTemplateSystem(this)) return origMap.call(this);
                const c = this[CMAP];
                if (c && c.h === h && c.b === b) return c.map;
                const map = origMap.call(this);
                this[CMAP] = { h, b, map };
                return map;
            };
            mapPatched.__fuInc = true;
            proto._getComponentMap = mapPatched;
        }
        globalThis.__fuIncPrepare = inc;
        console.info(`${TAG} incremental prepare installed.`);
    }

    function incOn() {
        if (inc.on === null) {
            try { inc.on = game.settings.get('fabula-ultima-companion', INC_SETTING) !== false; }
            catch { return false; }
        }
        return inc.on;
    }

    /* -------------------------------------------------------------- (8) --- */
    // LAZY game.data MIRROR. Every document update ends in DocumentCollection#set, which replaces
    // the document's entry in game.data (the collection's `_source` array) with
    // `document.toObject()`: a deep copy of the whole document, all 111 of Hina's items included,
    // for every HP write (~4 ms of it, measured 2026-11-03). Nothing reads that array during play:
    // Foundry itself only for invalid documents (getInvalid), which are never `set`.
    //
    // So on an update (an id already in the collection) the entry becomes a stand-in that makes
    // the same copy the first time anything other than its `_id` is read, and from then on is that
    // copy. A new document is still copied at once, as before. The one difference: a stand-in read
    // later shows the document as it is when read, not as it was at the update; every change that
    // goes through the database calls set again anyway.
    //
    // Kill switch: world setting `foundryLazyDataMirror` (default on; reload to apply).
    // Stats: globalThis.__fuLazyMirror ({ on, deferred, materialized }).
    const MIRROR_SETTING = 'foundryLazyDataMirror';
    const mirror = { on: null, deferred: 0, materialized: 0 };

    function lazyEntry(document, id) {
        let real = null;
        const mat = () => {
            if (!real) { real = document.toObject(); mirror.materialized++; }
            return real;
        };
        return new Proxy({}, {
            get: (t, k) => (k === '_id' && !real ? id : Reflect.get(mat(), k)),
            has: (t, k) => (k === '_id' && !real ? true : Reflect.has(mat(), k)),
            set: (t, k, v) => Reflect.set(mat(), k, v),
            deleteProperty: (t, k) => Reflect.deleteProperty(mat(), k),
            defineProperty: (t, k, d) => Reflect.defineProperty(mat(), k, d),
            ownKeys: () => Reflect.ownKeys(mat()),
            getOwnPropertyDescriptor: (t, k) => {
                const d = Reflect.getOwnPropertyDescriptor(mat(), k);
                if (d) d.configurable = true;   // the empty target cannot hold a fixed property
                return d;
            },
            getPrototypeOf: () => Object.getPrototypeOf(mat()),
        });
    }

    function patchLazyDataMirror() {
        // DocumentCollection is not exposed on globalThis in v12: find it from the actors' collection
        let proto = CONFIG.Actor?.collection?.prototype ?? null;
        while (proto && !(Object.prototype.hasOwnProperty.call(proto, 'set') && String(proto.set).includes('_source.findSplice'))) {
            proto = Object.getPrototypeOf(proto);
        }
        const orig = proto?.set;
        const src = String(orig ?? '').replace(/\s+/g, '');
        if (typeof orig !== 'function' || orig.__fuLazy
            || !src.includes('constreplacement=this.has(document.id);super.set(document.id,document);if(replacement)this._source.findSplice(e=>e._id===id,document.toObject());elsethis._source.push(document.toObject());')) {
            console.warn(`${TAG} DocumentCollection#set not as expected; skipping lazy game.data mirror.`);
            return;
        }
        const superSet = Object.getPrototypeOf(proto)?.set;
        if (typeof superSet !== 'function') return;
        const patched = function (id, document) {
            if (!mirrorOn() || !(document instanceof this.documentClass) || !this.has(document.id)) {
                return orig.call(this, id, document);
            }
            superSet.call(this, document.id, document);
            this._source.findSplice((e) => e._id === id, lazyEntry(document, id));
            mirror.deferred++;
        };
        patched.__fuLazy = true;
        patched.__fuOriginal = orig;
        proto.set = patched;
        globalThis.__fuLazyMirror = mirror;
        console.info(`${TAG} lazy game.data mirror installed.`);
    }

    function mirrorOn() {
        if (mirror.on === null) {
            try { mirror.on = game.settings.get('fabula-ultima-companion', MIRROR_SETTING) !== false; }
            catch { return false; }
        }
        return mirror.on;
    }

    /* -------------------------------------------------------------- (2) --- */
    // Fallback for anything patch (3) deliberately skipped (copies, mixed
    // batches) and for template parents, which CSB always re-stamps. When (3)
    // has already stamped, the `originalUuid` guard makes this a no-op — no
    // second cycle.

    function patchActiveEffectFlagBatching(CustomActiveEffect) {
        if (typeof CustomActiveEffect?._onCreateOperation !== 'function') {
            console.warn(`${TAG} CustomActiveEffect._onCreateOperation missing; skipping flag batching.`);
            return;
        }
        if (CustomActiveEffect._onCreateOperation.__fuPatched) return;

        const orig = CustomActiveEffect._onCreateOperation;
        const src = String(orig);
        const STAMPED = ['originalParentId', 'originalId', 'originalUuid', 'isFromTemplate'];
        // Shape guard: we REPLACE the stamping loop (rather than pre-empting it, which
        // would double the work on template parents), so bail if it isn't the loop we
        // measured against.
        if (!STAMPED.every((k) => src.includes(k)) || !src.includes('setFlag')) {
            console.warn(`${TAG} _onCreateOperation body not as expected; skipping flag batching.`);
            return;
        }

        // Same predicate CSB uses (definitions.js `isFullBuilderTemplateEntity`).
        const isFullBuilderTemplateEntity = (entity) =>
            !!entity && ['_template', '_equippableItemTemplate'].includes(entity.type);

        // Call ActiveEffect's own static directly — we are replacing CSB's loop, not
        // wrapping it, so CSB's version must not also run.
        const superOnCreate = Object.getPrototypeOf(CustomActiveEffect)?._onCreateOperation;
        if (typeof superOnCreate !== 'function') {
            console.warn(`${TAG} could not resolve super._onCreateOperation; skipping flag batching.`);
            return;
        }

        const patched = async function (documents, operation, user) {
            if (user.id === game.user.id) {
                for (const effect of documents) {
                    const sid = game.system.id;
                    if (!effect.getFlag(sid, 'originalUuid') || isFullBuilderTemplateEntity(effect.parent)) {
                        // ONE update instead of four sequential awaited setFlags: four
                        // document updates each triggered a full parent re-derive.
                        await effect.update({
                            [`flags.${sid}.originalParentId`]: effect.parent.id,
                            [`flags.${sid}.originalId`]: effect.id,
                            [`flags.${sid}.originalUuid`]: effect.uuid,
                            [`flags.${sid}.isFromTemplate`]: isFullBuilderTemplateEntity(effect.parent)
                        });
                    }
                }
            }
            return superOnCreate.call(this, documents, operation, user);
        };

        patched.__fuPatched = true;
        patched.__fuOriginal = orig;
        CustomActiveEffect._onCreateOperation = patched;
        console.info(`${TAG} CustomActiveEffect._onCreateOperation patched (batched flag stamping).`);
    }
})();
