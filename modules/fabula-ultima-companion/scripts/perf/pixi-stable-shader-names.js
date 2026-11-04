/**
 * [ONI] PIXI stable shader names — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * Lets the browser's GPU shader cache work for every PIXI shader, so a filter
 * or effect that was compiled in an earlier session is not compiled again.
 *
 * PIXI 7 writes `#define SHADER_NAME <name>-<n>` into each program's source,
 * where <n> counts the programs created with that name so far IN THIS PAGE
 * (Program constructor, `nameCache`). Programs are created in a different
 * order from one session to the next (modules load asynchronously, effects are
 * created when first used), so the same shader gets a different number each
 * time. The browser keys its compiled-shader cache on the exact source text,
 * so a renamed shader is a cache miss and is compiled from scratch, on the
 * drawing thread, the first time it is drawn.
 *
 * Measured 2026-11-04 (seeded battle, real GPU, the same browser profile run
 * three times): programs whose number stayed the same took 1-5 ms (cache hit);
 * the turn-glow OutlineFilter and a ColorMatrixFilter got new numbers each run
 * and took 115-133 ms and 92-97 ms every time, mid-battle.
 *
 * Fix: just before PIXI compiles a program, replace the counter with a hash of
 * the program's own source. The same source then always has the same name, and
 * two different sources still get different names. The name is only a label
 * for debugging tools; nothing else reads it.
 *
 * Kill switch: client setting `pixiStableShaderNames` (default on; reload).
 * Stats: globalThis.__fuShaderNames ({ on, renamed, compiled }).
 *
 * Classic script: everything stays inside the IIFE (module.json scripts share
 * one global lexical scope).
 */

(() => {
    const NS = 'fabula-ultima-companion';
    const SETTING = 'pixiStableShaderNames';
    const TAG = '[FU-ShaderNames]';
    const stats = (globalThis.__fuShaderNames = { on: null, renamed: 0, compiled: 0 });

    Hooks.once('init', () => {
        try {
            game.settings.register(NS, SETTING, {
                name: 'Graphics: reuse compiled effects between sessions',
                hint: 'Gives every visual effect the same internal name each session, so the browser can '
                    + 'reuse the copy it compiled last time instead of compiling it again mid-battle. '
                    + 'Requires a reload.',
                scope: 'client',
                config: false,
                type: Boolean,
                default: true,
            });
        } catch (e) { console.warn(`${TAG} setting registration failed`, e); }
    });

    const enabled = () => {
        if (stats.on === null) {
            try { stats.on = game.settings.get(NS, SETTING) !== false; }
            catch { return true; }   // before settings are ready: default on, decide again later
        }
        return stats.on;
    };

    // 32-bit FNV-1a, as 8 hex digits.
    const hash = (s) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return (h >>> 0).toString(16).padStart(8, '0');
    };

    // PIXI puts the define on the first line, or on the second when it adds a precision line
    // in front. Only that line is touched; a SHADER_NAME the shader author wrote is left alone.
    const DEFINE = /^#define SHADER_NAME (\S+?)(?:-\d+)?$/;
    function headerIndex(lines) {
        for (let i = 0; i < 2 && i < lines.length; i++) if (DEFINE.test(lines[i])) return i;
        return -1;
    }

    function stabilize(program) {
        if (!program || program.__fuStableName) return;
        program.__fuStableName = true;
        const v = String(program.vertexSrc ?? '').split('\n');
        const f = String(program.fragmentSrc ?? '').split('\n');
        const vi = headerIndex(v), fi = headerIndex(f);
        if (vi < 0 || fi < 0 || v[vi] !== f[fi]) return;   // not PIXI's pair of defines
        const base = v[vi].match(DEFINE)[1];
        const rest = (lines, i) => lines.filter((_, k) => k !== i).join('\n');
        const line = `#define SHADER_NAME ${base}-${hash(`${rest(v, vi)}\u0000${rest(f, fi)}`)}`;
        v[vi] = line; f[fi] = line;
        program.vertexSrc = v.join('\n');
        program.fragmentSrc = f.join('\n');
        stats.renamed++;
    }

    const SS = globalThis.PIXI?.ShaderSystem?.prototype;
    if (typeof SS?.generateProgram !== 'function') {
        console.warn(`${TAG} PIXI.ShaderSystem#generateProgram not found; shader names left as they are.`);
        return;
    }
    const original = SS.generateProgram;
    SS.generateProgram = function (shader) {
        stats.compiled++;
        if (enabled()) {
            try { stabilize(shader?.program); } catch (e) { console.warn(`${TAG} rename failed`, e); }
        }
        return original.call(this, shader);
    };
})();
