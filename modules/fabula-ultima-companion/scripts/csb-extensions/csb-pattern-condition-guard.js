/**
 * [ONI] CSB Pattern Condition Guard — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * Safety net for csb-pattern-condition-options.js. That file widens the NPC
 * `action_pattern_table` dropdowns (`formula` condition, `highest_max_hp`
 * focus) at render. If it fails to install, CSB re-stamps every unlisted
 * option to the dropdown default on the next sheet save, silently.
 *
 *  (a) LOUD: at `ready`, GM only, a failed install raises ui.notifications.error
 *      once and console.error's the recorded reason.
 *  (b) REFUSE: while the widener is NOT installed, a preUpdateActor hook strips
 *      the re-stamp fields (never the whole update) and warns.
 *
 * Decision logic is pure and exported (see csb-pattern-condition-guard.test.mjs).
 */

const TAG = '[CSB-PatternConditionGuard]';
const MODULE_ID = 'fabula-ultima-companion';

export const TABLE_PATH = 'system.props.action_pattern_table';
export const COL_CONDITION = 'action_pattern_condition';
export const COL_STRING = 'action_pattern_string';
export const COL_FOCUS = 'action_pattern_target_focus';
export const CONDITION_FORMULA = 'formula';
/** Focus values the widener adds (not in the layout's own list). */
export const WIDENED_FOCUS = ['highest_max_hp'];
/** Value CSB re-stamps an unlisted focus to (the first option). */
export const FOCUS_DEFAULTS = ['auto', ''];

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

/**
 * @param {Record<string, any>} flat  flattenObject(change)
 * @param {Record<string, any>} table existing action_pattern_table (rowKey -> row)
 * @param {{installed?: boolean, widenedFocus?: string[]}} [opts]
 * @returns {{ strip: string[], notes: {rowKey: string, col: string, reason: string}[] }}
 */
export function guardPatternChange(flat, table, opts = {}) {
    const out = { strip: [], notes: [] };
    if (opts.installed || !flat || typeof flat !== 'object') return out;
    const widened = opts.widenedFocus ?? WIDENED_FOCUS;
    const prefix = `${TABLE_PATH}.`;
    for (const [path, value] of Object.entries(flat)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const dot = rest.indexOf('.');
        if (dot < 0) continue;
        const rowKey = rest.slice(0, dot);
        const col = rest.slice(dot + 1);
        const row = table?.[rowKey];
        if (!row || typeof row !== 'object') continue;
        if (col === COL_CONDITION) {
            if (row[COL_CONDITION] === CONDITION_FORMULA && value !== CONDITION_FORMULA
                && !isBlank(row[COL_STRING])) {
                out.strip.push(path);
                out.notes.push({ rowKey, col, reason: `condition would be reset from "formula" to "${value}"` });
            }
        } else if (col === COL_FOCUS) {
            const was = row[COL_FOCUS];
            if (widened.includes(was) && !widened.includes(value) && FOCUS_DEFAULTS.includes(value ?? '')) {
                out.strip.push(path);
                out.notes.push({ rowKey, col, reason: `target focus would be reset from "${was}" to "${value}"` });
            }
        }
    }
    return out;
}

/** Remove stripped paths from a (possibly nested) change object, in place. */
export function stripPaths(change, paths) {
    for (const p of paths) {
        if (p in change) { delete change[p]; continue; }   // already-dotted key
        const parts = p.split('.');
        let o = change;
        for (let i = 0; i < parts.length - 1 && o; i++) o = o[parts[i]];
        if (o && typeof o === 'object') delete o[parts[parts.length - 1]];
    }
    return change;
}

export function widenerStatus(g = globalThis) {
    const s = g.__fuPatternConditionOptions;
    return { installed: !!s?.installed, reason: s?.reason ?? (s ? 'unknown (no reason recorded)' : 'widener script never loaded') };
}

function install() {
    if (typeof Hooks === 'undefined') return;
    Hooks.on('preUpdateActor', (actor, change) => {
        try {
            const { installed } = widenerStatus();
            if (installed) return;
            const flat = foundry.utils.flattenObject(change ?? {});
            const table = actor?._source?.system?.props?.action_pattern_table ?? actor?.system?.props?.action_pattern_table;
            const { strip, notes } = guardPatternChange(flat, table, { installed });
            if (!strip.length) return;
            stripPaths(change, strip);
            for (const n of notes) {
                const name = table?.[n.rowKey]?.action_pattern_name || n.rowKey;
                const msg = `${TAG} ${actor?.name}: row "${name}" ${n.reason}; change refused (pattern widener not installed).`;
                console.warn(msg);
                ui.notifications?.warn(msg);
            }
        } catch (e) { console.error(`${TAG} guard failed`, e); }
    });
    // Checked a few seconds after ready: the widener installs from an async import inside
    // customSystemBuilderInit, so a check AT ready could race it and raise a false alarm.
    Hooks.once('ready', () => setTimeout(() => {
        if (!game.user?.isGM) return;
        const { installed, reason } = widenerStatus();
        if (installed) return;
        console.error(`${TAG} pattern widener NOT installed: ${reason}`);
        ui.notifications?.error('Pattern-table options (formula conditions, extra target-focus values) will be reset by any sheet save of an enemy with such rows. Do not save those sheets until the widener is fixed (see console).', { permanent: true });
    }, 3000));
}

install();
