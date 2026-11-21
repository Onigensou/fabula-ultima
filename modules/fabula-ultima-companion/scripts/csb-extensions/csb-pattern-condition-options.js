/**
 * [ONI] CSB Pattern Condition Options — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * The NPC `action_pattern_table` column `action_pattern_condition` is a CSB
 * dropdown with a FIXED option list stored in the layout. CSB renders a row's
 * select from that list and, when the row's value is not in it, selects the
 * first option ("always"); the next sheet submit saves it. So a condition key
 * the layout does not list (e.g. `formula`, added 2026-11-19) is silently reset
 * to "always" the first time someone opens the sheet.
 *
 * An actor renders from its OWN layout — its stored `system.body`, or the
 * `_Layout Library` entry it shares by `flags.<ns>.layoutRef`
 * (csb-template-layout-dedup.js). Writing the option into each actor's body
 * would undo that sharing (a stored body wins over the ref, and the header then
 * resolves from the empty stored panel, blanking the sheet header), and the
 * library entries are content-addressed and must never be edited.
 *
 * So the option list is widened at RENDER instead, where it is read: CSB reads
 * a dropdown's `_options` ONLY in Dropdown#_getElement (no prepare-time or
 * save-time validation), and a dynamic table builds a fresh cell component per
 * row per render (`component.toJSON()` -> createOneComponent), so the widened
 * list lives on a throwaway object. Every key the evaluator knows
 * (actionReader-readPatternTable patternConditionOptions) is appended after the
 * layout's own options, which keep their order and labels. No document is
 * written; dedup is untouched. Builder (template) rendering is left alone: it
 * lists no options there, and the component editor must save the authored list.
 *
 * ⚠ IIFE-wrapped: module.json scripts are CLASSIC scripts sharing one global
 * lexical scope (see csb-template-layout-dedup.js).
 */

(() => {
    const TAG = '[CSB-PatternConditionOptions]';
    const MODULE_ID = 'fabula-ultima-companion';
    const KEY = 'action_pattern_condition';
    // Each widened column and where its evaluator's option list comes from. The
    // target-focus column has the same failure (`highest_max_hp`, added 2026-11-19).
    const SOURCES = {
        [KEY]: ['actionReader-readPatternTable.js', 'patternConditionOptions'],
        action_pattern_target_focus: ['actionReader-buildAndPickTargets.js', 'patternTargetFocusOptions'],
    };

    const known = {};   // column key -> Promise<{ key, value }[]>
    const knownOptions = (col = KEY) => {
        const [file, fn] = SOURCES[col] ?? [];
        if (!file) return Promise.resolve([]);
        known[col] ??= import(`/modules/${MODULE_ID}/scripts/action-reader/${file}`)
            .then((m) => (typeof m[fn] === 'function' ? m[fn]() : []))
            .catch((e) => { console.warn(`${TAG} could not load the ${col} keys; options not widened.`, e); return []; });
        return known[col];
    };

    // The widened column this cell is, or null.
    const columnOf = (k) => (typeof k === 'string'
        ? Object.keys(SOURCES).find((col) => k === col || k.endsWith(`.${col}`)) ?? null
        : null);

    // Inspect / A-B: `off = true` restores stock CSB rendering (the check's control).
    const state = { installed: false, reason: "customSystemBuilderInit has not fired", off: false, widened: 0, knownOptions };
    // Record why the install was skipped (read by csb-pattern-condition-guard.js).
    const skip = (reason, e) => { state.reason = reason; console.error(`${TAG} ${reason}; skipping.`, e ?? ""); };
    globalThis.__fuPatternConditionOptions = state;

    Hooks.once('customSystemBuilderInit', async () => {
        let Dropdown, TemplateSystem;
        try {
            [Dropdown, TemplateSystem] = await Promise.all([
                import('/systems/custom-system-builder/module/sheets/components/Dropdown.js').then((m) => m.default),
                import('/systems/custom-system-builder/module/documents/TemplateSystem.js').then((m) => m.default),
            ]);
        } catch (e) { skip("could not import CSB Dropdown/TemplateSystem", e); return; }

        const proto = Dropdown?.prototype;
        const orig = proto?._getElement;
        if (typeof orig !== 'function' || typeof TemplateSystem?.isAppliedTemplateSystem !== 'function') {
            skip("CSB Dropdown shape not as expected");
            return;
        }
        if (orig.__fuPatternConditionOptions) { state.installed = true; state.reason = null; return; }
        if (!String(orig).includes('this._options')) {
            skip("Dropdown#_getElement no longer reads _options");
            return;
        }

        const patched = async function (entity, isEditable, options) {
            const col = state.off ? null : columnOf(this._key);
            if (col && (this._selectedOptionType ?? 'custom') === 'custom'
                && TemplateSystem.isAppliedTemplateSystem(entity)) {
                try {
                    const all = await knownOptions(col);
                    const have = new Set((this._options ?? []).map((o) => o?.key));
                    const add = all.filter((o) => o?.key && !have.has(o.key));
                    // A new array: never mutate the layout JSON the cell was built from.
                    if (add.length) {
                        this._options = [...(this._options ?? []), ...add.map((o) => ({ key: o.key, value: o.value }))];
                        state.widened++;
                    }
                } catch (e) { console.warn(`${TAG} widening failed for ${this._key}`, e); }
            }
            return orig.call(this, entity, isEditable, options);
        };
        patched.__fuPatternConditionOptions = true;
        proto._getElement = patched;
        state.reason = null;
        state.installed = true;
        for (const col of Object.keys(SOURCES)) knownOptions(col);
        console.info(`${TAG} installed.`);
    });
})();
