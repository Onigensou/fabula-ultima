/**
 * [ONI] CSB Formula Compat — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * Two surgical fixes for noisy CSB formula errors. Both apply at the `setup`
 * hook so initial actor data preparation is already covered.
 *
 *   (1) ItemContainer filter formulas (schema-aware item.* defaults)
 *       Filter formulas like `and(item.isSpell, not(item.isOffensiveSpell))`
 *       throw mathjs TypeErrors when an item lacks a referenced property.
 *       The filter still works (CSB swallows the error → falsy) but the
 *       console fills with one error per (formula × non-matching item).
 *
 *       Fix: wrap `item.system.props` in a Proxy whose `get` trap returns
 *       `false` for keys present on at least one *other* item in the actor's
 *       inventory, and `undefined` for keys no item has — so genuine typos
 *       still surface as the original mathjs error.
 *
 *   (2) Legacy formula function aliases
 *       Older CSB formulas reference function names that no longer exist
 *       (e.g. `fetchFromDynamicTable`, signature-identical to current
 *       `lookup`). mathjs throws "Undefined function ...".
 *
 *       Fix: extend FormulaFunctionImporter.importCustomFunctions to alias
 *       legacy names to current implementations. Add to LEGACY_ALIASES to
 *       register more.
 */

const TAG = '[CSB-FormulaCompat]';

// Map old CSB formula function names -> current name. Add as more surface.
const LEGACY_ALIASES = {
    fetchFromDynamicTable: 'lookup'
};

// Kick off dynamic imports immediately (script-evaluation time, before any
// hook fires) so they are already resolved when `init` runs. Patching at
// `init` matches the convention used by sibling csb-extensions and ensures
// our changes are in place before CSB's TemplateSystem walks any data.
const _csbImports = (() => {
    const route = (rel) => foundry.utils.getRoute(rel);
    return Promise.all([
        import(route('systems/custom-system-builder/module/formulas/Formula.js')),
        import(route('systems/custom-system-builder/module/formulas/FormulaFunctionImporter.js')),
        import(route('systems/custom-system-builder/module/utils.js')),
        import(route('systems/custom-system-builder/module/documents/CustomItem.js'))
    ]).then(([fm, ffim, utm, cim]) => ({
        Formula: fm.default,
        FormulaFunctionImporter: ffim.FormulaFunctionImporter,
        castToPrimitive: utm.castToPrimitive,
        CustomItem: cim.default
    }));
})();

Hooks.once('init', async () => {
    let imports;
    try {
        imports = await _csbImports;
    } catch (e) {
        console.warn(`${TAG} could not import CSB internals; skipping.`, e);
        return;
    }
    const { Formula, FormulaFunctionImporter, castToPrimitive, CustomItem } = imports;
    patchItemContainerFilter(Formula, castToPrimitive, CustomItem);
    patchFormulaFunctionAliases(FormulaFunctionImporter);
});

function patchItemContainerFilter(Formula, castToPrimitive, CustomItem) {
    if (typeof globalThis.componentFactory?.getComponentClass !== 'function') {
        console.warn(`${TAG} componentFactory unavailable; skipping filterItems patch.`);
        return;
    }
    let ItemContainer;
    try {
        ItemContainer = globalThis.componentFactory.getComponentClass('itemContainer');
    } catch (e) {
        console.warn(`${TAG} itemContainer class not found; skipping.`, e);
        return;
    }
    if (!ItemContainer?.prototype?.filterItems) return;
    if (ItemContainer.prototype.filterItems.__fuPatched) return;

    const buildKnownKeys = (items) => {
        const known = new Set();
        for (const it of items) {
            const props = it?.system?.props;
            if (!props) continue;
            for (const k of Object.keys(props)) known.add(k);
        }
        return known;
    };

    // Hybrid default for missing keys, in order:
    //   1. If at least one sibling item defines the key, return false.
    //   2. Else if the key looks like a boolean predicate (is*/has*/can*/
    //      should*/will*), return false. This covers "virtual" predicates
    //      that are never stored on items (e.g. `isFacet`, derived from an
    //      actor-level table).
    //   3. Otherwise return undefined so mathjs throws and a real typo
    //      surfaces in the console.
    const BOOL_KEY_RX = /^(is|has|can|should|will)[A-Z_]/;
    const wrapItemProps = (props, knownKeys) => new Proxy(props ?? {}, {
        get(target, key) {
            if (typeof key === 'symbol') return Reflect.get(target, key);
            if (key in target) return target[key];
            if (knownKeys.has(key)) return false;
            if (BOOL_KEY_RX.test(key)) return false;
            return undefined;
        }
    });

    const patched = function (entity, options) {
        const knownKeys = buildKnownKeys(entity.items);
        return entity.items.filter((item) => {
            if (!CustomItem.isEquippableItem(item)) return false;
            const tplFilter = this._templateFilter ?? [];
            if (!item.system.template ||
                (tplFilter.length > 0 && !tplFilter.includes(item.system.template))) {
                return false;
            }
            if (!this._itemFilterFormula) return true;
            const result = new Formula(this._itemFilterFormula).computeStatic(
                {
                    ...entity.system.props,
                    item: wrapItemProps(item.system.props, knownKeys)
                },
                { ...options, source: `${this.key}.${item.name}.filter` }
            ).result;
            return !!castToPrimitive(result);
        });
    };
    patched.__fuPatched = true;
    ItemContainer.prototype.filterItems = patched;
    console.log(`${TAG} ItemContainer.filterItems patched (schema-aware item.* defaults).`);
}

function patchFormulaFunctionAliases(FormulaFunctionImporter) {
    if (!FormulaFunctionImporter?.importCustomFunctions) {
        console.warn(`${TAG} FormulaFunctionImporter.importCustomFunctions missing; skipping alias patch.`);
        return;
    }
    if (FormulaFunctionImporter.importCustomFunctions.__fuPatched) return;

    const original = FormulaFunctionImporter.importCustomFunctions.bind(FormulaFunctionImporter);
    const patched = function (mathInstance, props, options) {
        const fns = original(mathInstance, props, options);
        for (const [legacy, current] of Object.entries(LEGACY_ALIASES)) {
            if (typeof fns[current] === 'function' && typeof fns[legacy] !== 'function') {
                fns[legacy] = fns[current];
            }
        }
        return fns;
    };
    patched.__fuPatched = true;
    FormulaFunctionImporter.importCustomFunctions = patched;
    console.debug(`${TAG} FormulaFunctionImporter aliases registered: ${Object.keys(LEGACY_ALIASES).join(', ')}`);
}
