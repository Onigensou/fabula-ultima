/**
 * [ONI] Client setting memo — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * Makes `game.settings.get` cheap for client-scope settings.
 *
 * Foundry 12 answers every get of a client setting by building a whole Setting
 * document (`new Setting({key, value: localStorage.getItem(key)})`): a DataModel
 * construction plus a JSON parse, on every call. Debug-log gates, chat-card
 * renderers and per-frame options read these constantly; a seeded battle spent
 * 184 ms in settings.get, 160 ms of it building those documents (measured
 * 2026-11-04; the worst single task had 33 ms of it).
 *
 * The memo keeps the last value per key together with the raw string it was
 * read from (and the registration). A get whose raw string and registration are
 * unchanged returns the kept value; anything else asks Foundry as before. So a
 * write through any path (game.settings.set, another tab, a module writing
 * localStorage directly) is picked up on the next read.
 *
 * Only primitive values are kept (boolean, number, string, null). Foundry hands
 * out a FRESH object for an object-valued client setting on every get, and a
 * caller may change the copy it got, so those always go to Foundry. World
 * settings are untouched (Foundry already keeps them as documents).
 *
 * Kill switch: client setting `clientSettingMemo` (default on; takes effect at
 * once). Stats: globalThis.__fuClientSettingMemo ({ on, hits, misses }).
 *
 * Classic script: everything stays inside the IIFE (module.json scripts share
 * one global lexical scope).
 */

(() => {
    const NS = 'fabula-ultima-companion';
    const SETTING = 'clientSettingMemo';
    const TAG = '[FU-ClientSettingMemo]';
    const stats = (globalThis.__fuClientSettingMemo = { on: true, hits: 0, misses: 0 });

    // eslint-disable-next-line no-undef
    const CS = typeof ClientSettings === 'function' ? ClientSettings : null;
    if (typeof CS?.prototype?.get !== 'function') {
        console.warn(`${TAG} ClientSettings#get not found; client settings are read as before.`);
        return;
    }

    const memo = new Map();   // "ns.key" -> { config, raw, value }
    const original = CS.prototype.get;
    const isPrimitive = (v) => v === null || (typeof v !== 'object' && typeof v !== 'function');

    CS.prototype.get = function (namespace, key, ...rest) {
        if (!stats.on || rest.length) return original.call(this, namespace, key, ...rest);
        const full = `${namespace}.${key}`;
        const config = this.settings?.get(full);
        if (config?.scope !== 'client') return original.call(this, namespace, key);
        let raw;
        try { raw = this.storage.get('client').getItem(full); }
        catch { return original.call(this, namespace, key); }
        const kept = memo.get(full);
        if (kept && kept.raw === raw && kept.config === config) { stats.hits++; return kept.value; }
        stats.misses++;
        const value = original.call(this, namespace, key);
        if (isPrimitive(value)) memo.set(full, { config, raw, value });
        else memo.delete(full);
        return value;
    };

    Hooks.once('init', () => {
        try {
            game.settings.register(NS, SETTING, {
                name: 'Performance: remember client settings between reads',
                hint: 'Reading a simple per-browser setting returns the value read last time while it is '
                    + 'unchanged, instead of rebuilding it each time.',
                scope: 'client',
                config: false,
                type: Boolean,
                default: true,
                onChange: (v) => { stats.on = v !== false; memo.clear(); },
            });
            stats.on = original.call(game.settings, NS, SETTING) !== false;
        } catch (e) { console.warn(`${TAG} setting registration failed`, e); }
    });
})();
