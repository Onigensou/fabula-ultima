/**
 * [ONI] CSB Derivation Perf — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * Two surgical performance patches for CSB 4.8.5. Both are pure engine-side
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
        import('/systems/custom-system-builder/module/documents/CustomActiveEffect.js')
    ]).then(([ic, ae]) => ({ ItemContainer: ic.default, CustomActiveEffect: ae.default }));
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
