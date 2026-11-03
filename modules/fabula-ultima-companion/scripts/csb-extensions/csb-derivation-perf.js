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

    const csbImports = Promise.all([
        import('/systems/custom-system-builder/module/sheets/components/ItemContainer.js'),
        import('/systems/custom-system-builder/module/documents/CustomActiveEffect.js'),
        import('/systems/custom-system-builder/module/documents/TemplateSystem.js')
    ]).then(([ic, ae, ts]) => ({ ItemContainer: ic.default, CustomActiveEffect: ae.default, TemplateSystem: ts.default }));
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
