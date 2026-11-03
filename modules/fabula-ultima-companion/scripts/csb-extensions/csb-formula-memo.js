/**
 * [ONI] CSB Formula Memo — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * CSB re-evaluates EVERY formula of an actor and of every item container row on
 * every document update, even when the change is one HP number. Measured
 * 2026-11-03 (Snapshot Runner, Hina, one HP write ~285 ms): formula evaluation
 * through Formula#computeStatic is ~2/3 of that, and each evaluation also pays
 * for a full copy of the props, a re-import of every CSB formula function into
 * mathjs and a fresh parse.
 *
 * A formula is a pure function of the values it reads, unless it calls a
 * function that reaches outside its arguments. So:
 *   1. Each formula text is parsed ONCE and its inputs listed: every symbol and
 *      every constant property path (`item.item_type`). A formula that calls an
 *      impure function (lookup, ref, sameRow, fetchFrom*, random, ...), assigns,
 *      or indexes dynamically is marked "always evaluate".
 *   2. At call time the inputs are read from the props, and (formula, options
 *      that change the result, input values) is looked up in a cache. A hit
 *      returns the cached result without evaluating; a miss evaluates as before
 *      and stores the result.
 * Only primitive inputs and results are cached. Anything else (an object input,
 * an object result, local variables, a thrown UncomputableError, an undefined
 * result) goes through CSB's own path untouched, so a case this file does not
 * understand costs speed, never correctness.
 *
 * Kill switch: world setting `csbFormulaMemo` (default on; reload to apply).
 * Live A/B and stats: globalThis.__fuFormulaMemo ({ on, hits, misses, bypass, ... }).
 *
 * ⚠ IIFE-wrapped: module.json scripts are CLASSIC scripts sharing one global
 * lexical scope. Keep the wrapper.
 */

(() => {
    const TAG = '[CSB-FormulaMemo]';
    const SETTING = 'csbFormulaMemo';
    const CACHE_MAX = 200000;

    // Functions whose result depends on more than their arguments. A formula calling any of
    // these, or any function this file does not know, is never cached.
    // SELF_ONLY ones read the evaluating document's own props by a computed name (tables, refs);
    // EXTERNAL ones reach other documents, the dice, a runtime registry, or write. A document
    // whose formulas reach outside itself must never have its derived data reused
    // (csb-derivation-perf.js (5)), so an item evaluating one is flagged through __fuPrepCtx.
    const SELF_ONLY = new Set([
        'sameRow', 'sameRowRef', 'sameRowIndex', 'lookupRef', 'lookup', 'alookup', 'find', 'ref',
        'consoleLog', 'consoleTable', 'fetchFromDynamicTable',
    ]);
    const EXTERNAL = new Set([
        'recalculate', 'fetchFromParent', 'fetchFromActor', 'fetchFromUuid', 'setPropertyInEntity', 'setValues', 'notify',
        // our own mathjs functions (reaction-formulaFunctions.js): read a runtime registry
        'triggerNeeds', 'triggerHasSubject', 'triggerInFamily',
        // mathjs randomness
        'random', 'randomInt', 'pickRandom',
    ]);
    // CSB custom functions that only use their arguments.
    const PURE_CSB = new Set(['fallback', 'replace', 'replaceAll', 'concat', 'switchCase', 'escapeQuotes', 'array', 'first']);

    const stats = { on: null, hits: 0, misses: 0, bypass: 0, uncacheable: 0, formulas: 0, impureFormulas: 0, size: 0 };
    const plans = new Map();        // formula text -> { paths } (cacheable) | { external: bool } (always evaluate)
    const cache = new Map();        // key -> { result, parsed, hasDice }

    const memoOn = () => {
        if (stats.on !== null) return stats.on;
        try { stats.on = game.settings.get('fabula-ultima-companion', SETTING) !== false; }
        catch { return false; }
        return stats.on;
    };

    /** List the inputs of a formula ({ paths }), or say why it must always be evaluated ({ external }). */
    function planFor(formula) {
        let plan = plans.get(formula);
        if (plan !== undefined) return plan;
        plan = analyse(formula);
        plans.set(formula, plan);
        stats.formulas++;
        if (!plan.paths) stats.impureFormulas++;
        return plan;
    }

    function analyse(formula) {
        if (typeof formula !== 'string') return { external: true };
        // local variables and escaped quotes stay inside the formula: always evaluate, not external
        if (formula.includes(':=') || formula.includes('\\')) return { external: false };
        const m = globalThis.math;
        if (!m?.parse) return { external: true };
        let root;
        try { root = m.parse(formula.trim()); } catch { return { external: true }; }
        const paths = new Set();
        let cacheable = true, external = false;
        const pathOf = (node) => {
            // a.b.c / a['b'] / a[1] with constant indices -> "a.b.c"; anything else -> null
            if (node.type === 'SymbolNode') return node.name;
            if (node.type === 'AccessorNode') {
                const base = pathOf(node.object);
                if (base === null) return null;
                const dims = node.index?.dimensions ?? [];
                if (dims.length !== 1 || dims[0].type !== 'ConstantNode') return null;
                return `${base}.${dims[0].value}`;
            }
            return null;
        };
        const walk = (node) => {
            if (external) return;
            switch (node.type) {
                case 'ConstantNode': return;
                case 'SymbolNode': paths.add(node.name); return;
                case 'AccessorNode': {
                    const p = pathOf(node);
                    if (p === null) { cacheable = false; node.forEach((child) => walk(child)); return; }
                    paths.add(p); return;
                }
                case 'FunctionNode': {
                    const name = node.fn?.type === 'SymbolNode' ? node.fn.name : null;
                    if (!name || EXTERNAL.has(name)) { external = true; return; }
                    if (SELF_ONLY.has(name)) cacheable = false;
                    else if (!PURE_CSB.has(name) && typeof m[name] !== 'function') { external = true; return; }
                    // the name itself is looked up in the scope first: record it, so a prop
                    // that shadows a function is part of the key
                    paths.add(name);
                    node.args.forEach(walk); return;
                }
                case 'OperatorNode': case 'ParenthesisNode': case 'ConditionalNode': case 'ArrayNode':
                case 'RangeNode': case 'RelationalNode': case 'IndexNode': case 'BlockNode': case 'ObjectNode':
                    node.forEach((child) => walk(child)); return;
                default: external = true;   // AssignmentNode, FunctionAssignmentNode, anything new
            }
        };
        try { walk(root); } catch { external = true; }
        if (external) return { external: true };
        return cacheable ? { paths: [...paths] } : { external: false };
    }

    const isPrim = (v) => v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);
    const enc = (v) => (v === undefined ? 'u' : v === null ? 'n' : (typeof v)[0] + String(v));
    const getPath = (obj, path) => {
        if (!path.includes('.')) return obj?.[path];
        let cur = obj;
        for (const part of path.split('.')) { if (cur === null || cur === undefined) return undefined; cur = cur[part]; }
        return cur;
    };

    function patchComputeStatic(Formula) {
        const proto = Formula?.prototype;
        if (typeof proto?.computeStatic !== 'function') {
            console.warn(`${TAG} Formula.prototype.computeStatic missing; not installed.`);
            return;
        }
        if (proto.computeStatic.__fuMemo) return;
        const orig = proto.computeStatic;
        const patched = function (props, options = {}, formula = null) {
            const text = formula ?? this._raw;
            // An item being prepared must learn whether any of its formulas reaches outside it,
            // memo on or off (csb-derivation-perf.js (5) reuses only self-contained items).
            const ctx = globalThis.__fuPrepCtx;
            if (ctx && !ctx.external && planFor(text).external) ctx.external = true;
            if (!memoOn() || !props || typeof props !== 'object' || typeof text !== 'string') return orig.call(this, props, options, formula);
            const opts = options ?? {};
            if ((opts.localVars && Object.keys(opts.localVars).length) || (opts.textVars && Object.keys(opts.textVars).length)
                || (opts.rolls && opts.rolls.length) || opts.computeExplanation) {
                stats.bypass++;
                return orig.call(this, props, options, formula);
            }
            const plan = planFor(text);
            if (!plan.paths) { stats.bypass++; return orig.call(this, props, options, formula); }
            let key = `${text}\u0001${enc(opts.defaultValue)}\u0001${opts.reference ?? ''}`;
            for (const p of plan.paths) {
                const v = getPath(props, p);
                if (!isPrim(v)) { stats.uncacheable++; return orig.call(this, props, options, formula); }
                key += '\u0001' + enc(v);
            }
            const hit = cache.get(key);
            if (hit) {
                stats.hits++;
                this._result = hit.result;
                this._localVars = opts.localVars ?? {};
                this._parsed = hit.parsed;
                this._hasDice = false;
                this._tokens = [];
                this._rolls = opts.rolls ?? [];
                return this;
            }
            stats.misses++;
            const out = orig.call(this, props, options, formula);   // throws UncomputableError as before
            const result = this._result;
            if (result !== undefined && isPrim(result) && !this._hasDice) {
                if (cache.size >= CACHE_MAX) cache.clear();
                cache.set(key, { result, parsed: this._parsed });
                stats.size = cache.size;
            }
            return out;
        };
        patched.__fuMemo = true;
        patched.__fuOriginal = orig;
        proto.computeStatic = patched;
        globalThis.__fuFormulaMemo = Object.assign(stats, {
            clear() { cache.clear(); plans.clear(); stats.hits = stats.misses = stats.bypass = stats.uncacheable = stats.formulas = stats.impureFormulas = stats.size = 0; },
            planFor,
        });
        console.info(`${TAG} Formula.computeStatic memo installed.`);
    }

    // %{ ... }% blocks in a phrase run arbitrary JS with the entity in hand: external.
    function patchPhraseScripts(ComputablePhrase) {
        const proto = ComputablePhrase?.prototype;
        if (typeof proto?.computeStatic !== 'function' || proto.computeStatic.__fuMemo) return false;
        const orig = proto.computeStatic;
        const patched = function (...args) {
            const ctx = globalThis.__fuPrepCtx;
            if (ctx && !ctx.external && String(this._rawPhrase ?? '').includes('%{')) ctx.external = true;
            return orig.apply(this, args);
        };
        patched.__fuMemo = true;
        proto.computeStatic = patched;
        return true;
    }

    const formulaImport = import('/systems/custom-system-builder/module/formulas/Formula.js').then((m) => m.default);
    formulaImport.catch(() => {});
    const phraseImport = import('/systems/custom-system-builder/module/formulas/ComputablePhrase.js').then((m) => m.default);
    phraseImport.catch(() => {});

    Hooks.once('init', () => {
        try {
            game.settings.register('fabula-ultima-companion', SETTING, {
                name: 'CSB: remember formula results',
                hint: 'A formula whose inputs did not change returns its last result instead of being '
                    + 'evaluated again. Requires a reload.',
                scope: 'world',
                config: false,
                type: Boolean,
                default: true,
            });
        } catch (e) { console.warn(`${TAG} setting registration failed`, e); }
    });

    Hooks.once('customSystemBuilderInit', async () => {
        try {
            patchComputeStatic(await formulaImport);
            // Reuse of an item's derived data depends on this detection: say it is in place.
            if (patchPhraseScripts(await phraseImport) && globalThis.__fuFormulaMemo) globalThis.__fuFormulaMemo.detectsExternal = true;
        } catch (e) { console.warn(`${TAG} could not import Formula / ComputablePhrase; not installed.`, e); }
    });
})();
