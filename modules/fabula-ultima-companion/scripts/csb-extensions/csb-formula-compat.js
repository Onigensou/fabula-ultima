/**
 * [ONI] CSB Formula Compat — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * Four surgical fixes for noisy CSB formula errors. All patches latch on the
 * `customSystemBuilderInit` hook, which CSB fires at the tail end of its own
 * `init` handler (after componentFactory/TemplateSystem are populated, but
 * BEFORE `initializeDocuments` runs prepareData). This is the same hook
 * sibling extensions (CompactDynamicTable, visibilityPresetPicker) use.
 *
 *   (1) Universal Formula.computeStatic item/target Proxy
 *       Many filter, column, hidden-column, and label formulas reference
 *       `item.X` and `target.X` where the prop is missing — mathjs throws
 *       TypeError on `not(undefined)`, `equalText(undefined, ...)`,
 *       `addScalar(undefined, ...)`, `compareText(undefined, ...)`, etc.
 *       CSB swallows the error (filter falls falsy / value becomes undefined)
 *       but the console floods with hundreds of errors per boot.
 *
 *       Fix: wrap `props.item` and `props.target` in a Proxy with three
 *       traps consistently defined — `get`, `has`, and
 *       `getOwnPropertyDescriptor`. mathjs's typed-function dispatch checks
 *       `has` + `gopd`, not just `get`. A Proxy with only `get` falls back to
 *       the underlying target for has/gopd, so missing keys still surface as
 *       `undefined` to mathjs.
 *
 *       Missing-key defaults:
 *         - `item.X`: '' (empty string — safe for `equalText`, `not` and
 *           arithmetic both treat it as 0/false).
 *         - `target.X`: false (AE-applied actor; `2 + target.clock_brainwave`
 *           where target lacks the prop should yield 2, not throw).
 *
 *   (2) Empty-formula short-circuit (inside the same computeStatic patch)
 *       Template fields like `${item.X}` resolve to an empty inner formula
 *       when X is missing or the field is blank. mathjs then parses '' and
 *       throws "Value expected (char 1)" SyntaxError — CSB logs it via
 *       Logger.error. We detect the empty case before calling original and
 *       synthesize a minimal Formula state (`_result = undefined`); the
 *       caller still sees `.result === 'ERROR'` via Formula's getter ??,
 *       so semantics are preserved — only the noise is suppressed.
 *
 *   (3) Legacy formula function aliases + `Number()`
 *       Older CSB formulas reference function names that no longer exist:
 *       `fetchFromDynamicTable` (now `lookup`) and `Number(x)` (mathjs only
 *       has lowercase `number`). mathjs throws "Undefined function ...".
 *       Fix: extend FormulaFunctionImporter.importCustomFunctions to alias
 *       legacy names to current implementations (add to LEGACY_ALIASES) and
 *       inject a `Number` shim that wraps JS-global Number.
 *
 *   (4) Variadic `or` / `and` overrides
 *       mathjs's built-in `or`/`and` are strictly binary and throw "Too many
 *       arguments in function or (expected: 2, actual: 3)" on a 3-arg call
 *       like `or(a, b, c)` that some older CSB templates use. Fix: override
 *       with variadic JS-truthy versions; tuned so that 2-arg calls remain
 *       binary-compatible.
 */

const TAG = '[CSB-FormulaCompat]';

// Early load marker — proves the script was parsed and executed. If we don't
// see this in the console at boot, the file failed to load (404 / parse error).
console.info(`${TAG} script loaded — patches will apply on customSystemBuilderInit.`);

// Map old CSB formula function names -> current name. Extend as more surface.
const LEGACY_ALIASES = {
    fetchFromDynamicTable: 'lookup'
};

// Boolean-predicate naming convention: keys starting with is/has/can/should/
// will *_*X often correspond to actor-level/derived flags that aren't stored
// on items but are referenced in filters. Default to `false` regardless of
// the per-context `defaultMissing`.
const BOOL_KEY_RX = /^(is|has|can|should|will)[A-Z_]/;

function buildKnownKeys(items) {
    const known = new Set();
    if (!items) return known;
    const iter = items.contents ?? items;
    for (const it of iter) {
        const props = it?.system?.props;
        if (!props) continue;
        for (const k of Object.keys(props)) known.add(k);
    }
    return known;
}

function synthDefault(knownKeys, defaultMissing, key) {
    if (typeof key !== 'string') return undefined;
    if (BOOL_KEY_RX.test(key)) return false;
    if (knownKeys && knownKeys.has(key)) return defaultMissing;
    return defaultMissing;
}

function wrapMissingProps(props, knownKeys, defaultMissing) {
    const target = props ?? {};
    return new Proxy(target, {
        get(t, key) {
            if (typeof key === 'symbol') return Reflect.get(t, key);
            if (key in t) {
                const v = t[key];
                return v === undefined ? synthDefault(knownKeys, defaultMissing, key) : v;
            }
            return synthDefault(knownKeys, defaultMissing, key);
        },
        has(t, key) {
            if (typeof key === 'symbol') return Reflect.has(t, key);
            // Report virtual presence so mathjs's `key in props` checks pass.
            return true;
        },
        getOwnPropertyDescriptor(t, key) {
            if (typeof key === 'symbol') return Reflect.getOwnPropertyDescriptor(t, key);
            const real = Reflect.getOwnPropertyDescriptor(t, key);
            if (real) {
                if ('value' in real && real.value === undefined) {
                    return {
                        configurable: true, enumerable: true, writable: false,
                        value: synthDefault(knownKeys, defaultMissing, key)
                    };
                }
                return real;
            }
            // Synthetic descriptor for missing keys. Non-enumerable so
            // Object.keys() / Object.assign() don't surface phantom keys.
            return {
                configurable: true, enumerable: false, writable: false,
                value: synthDefault(knownKeys, defaultMissing, key)
            };
        }
    });
}

// Kick off dynamic imports at script-load. `import(...)` itself never throws
// synchronously — it always returns a promise, so this is safe at module-
// script-load even if `foundry.utils` isn't ready yet. The promise resolves
// as a microtask, which (for cached modules) lands before any Foundry hook
// fires. Absolute URLs — Foundry's module loader caches by URL, so dynamic
// import here yields the same instance CSB itself loaded.
const _csbImports = Promise.all([
    import('/systems/custom-system-builder/module/formulas/Formula.js'),
    import('/systems/custom-system-builder/module/formulas/FormulaFunctionImporter.js')
]).then(([fm, ffim]) => ({
    Formula: fm.default,
    FormulaFunctionImporter: ffim.FormulaFunctionImporter
}));
// Attach a no-op rejection handler eagerly so an early failure doesn't
// surface as an "unhandledrejection" warning before the hook awaits it.
// The real handler is in the customSystemBuilderInit callback below.
_csbImports.catch(() => {});

// Apply on `customSystemBuilderInit` — CSB fires this at the tail of its own
// init handler, after componentFactory/TemplateSystem are populated, but
// BEFORE `setupGame`/`initializeDocuments` runs prepareData. Sibling
// extensions (CompactDynamicTable, visibilityPresetPicker) use the same hook.
Hooks.once('customSystemBuilderInit', async () => {
    let imports;
    try {
        imports = await _csbImports;
    } catch (e) {
        console.warn(`${TAG} dynamic import of CSB internals failed; skipping patches.`, e);
        return;
    }
    const { Formula, FormulaFunctionImporter } = imports;
    patchFormulaItemPropsProxy(Formula);
    patchFormulaFunctionAliases(FormulaFunctionImporter);
});

function patchFormulaItemPropsProxy(Formula) {
    if (!Formula?.prototype?.computeStatic) {
        console.warn(`${TAG} Formula.prototype.computeStatic missing; skipping universal patch.`);
        return;
    }
    if (Formula.prototype.computeStatic.__fuPatched) return;
    const orig = Formula.prototype.computeStatic;
    const PROXIED = new WeakSet();

    const patched = function (props, options, formula) {
        // Short-circuit empty/whitespace formulas. mathjs parses '' as
        // "Value expected (char 1)" SyntaxError — CSB then logs it via
        // Logger.error. Empty formulas come from template fields that were
        // either left blank or have an interpolation like `${item.X}` where
        // X is missing, producing an empty inner formula. The result is
        // 'ERROR' (Formula.result's ?? fallback) either way; we just skip
        // the noisy parse+catch round-trip.
        const effective = (formula ?? this._raw);
        if (typeof effective === 'string' && effective.trim() === '') {
            this._result = undefined;
            this._localVars = options?.localVars ?? {};
            this._parsed = '';
            this._hasDice = false;
            this._tokens = [];
            this._rolls = [];
            return this;
        }
        if (!props || typeof props !== 'object') return orig.call(this, props, options, formula);
        let changed = false;
        let next = props;
        // Wrap props.item — per-row item context: filter formulas, column
        // formulas, hidden columns, label values inside an ItemContainer.
        // Use '' as the missing-key default — safe for equalText/not/arithmetic.
        const item = props.item;
        if (item && typeof item === 'object' && !PROXIED.has(item)) {
            const linked = options?.linkedEntity;
            const siblings = linked?.parent?.items ?? null;
            const knownKeys = siblings ? buildKnownKeys(siblings) : new Set();
            const wrapped = wrapMissingProps(item, knownKeys, '');
            PROXIED.add(wrapped);
            if (!changed) { next = { ...props }; changed = true; }
            next.item = wrapped;
        }
        // Wrap props.target — typical in ActiveEffect change `value` formulas
        // like `2 + target.clock_brainwave` where the actor receiving the AE
        // may not have the referenced prop. Use `false` as default so
        // arithmetic doesn't blow up (mathjs treats false as 0).
        const target = props.target;
        if (target && typeof target === 'object' && !PROXIED.has(target)) {
            const wrapped = wrapMissingProps(target, new Set(), false);
            PROXIED.add(wrapped);
            if (!changed) { next = { ...props }; changed = true; }
            next.target = wrapped;
        }
        return orig.call(this, next, options, formula);
    };
    patched.__fuPatched = true;
    patched.__fuOriginal = orig;
    Formula.prototype.computeStatic = patched;
    console.info(`${TAG} Formula.computeStatic patched (universal item/target proxy).`);
}

function patchFormulaFunctionAliases(FormulaFunctionImporter) {
    if (!FormulaFunctionImporter?.importCustomFunctions) {
        console.warn(`${TAG} FormulaFunctionImporter.importCustomFunctions missing; skipping alias patch.`);
        return;
    }
    if (FormulaFunctionImporter.importCustomFunctions.__fuPatched) return;

    // Variadic boolean fold — JS-truthy semantics. Single arg returns truthy
    // coercion. Two args remain binary (drop-in for mathjs's stock or/and).
    // Three+ args fold left-to-right.
    const variadicOr  = (...vals) => vals.some(v => !!v);
    const variadicAnd = (...vals) => vals.length > 0 && vals.every(v => !!v);
    // Type cast — older CSB templates call `Number(x)` (capital-N) to coerce
    // a string column to numeric. mathjs has no `Number` (only lowercase
    // `number`). Use JS-global Number for parity with the original intent.
    const numberCast = (v) => Number(v);

    const original = FormulaFunctionImporter.importCustomFunctions.bind(FormulaFunctionImporter);
    const patched = function (mathInstance, props, options) {
        const fns = original(mathInstance, props, options);
        // Aliases — point legacy names at current implementations.
        for (const [legacy, current] of Object.entries(LEGACY_ALIASES)) {
            if (typeof fns[current] === 'function' && typeof fns[legacy] !== 'function') {
                fns[legacy] = fns[current];
            }
        }
        // Override mathjs's binary or/and with variadic versions so older
        // 3+ arg templates evaluate instead of throwing arity errors.
        fns.or  = variadicOr;
        fns.and = variadicAnd;
        // Provide Number() since mathjs only exposes lowercase `number`.
        fns.Number = numberCast;
        return fns;
    };
    patched.__fuPatched = true;
    patched.__fuOriginal = original;
    FormulaFunctionImporter.importCustomFunctions = patched;
    console.info(`${TAG} FormulaFunctionImporter patched (aliases + variadic or/and).`);
}
