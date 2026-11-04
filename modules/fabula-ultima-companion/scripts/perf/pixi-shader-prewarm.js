/**
 * [ONI] PIXI shader prewarm — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * Compiles the battle's known effect shaders while the page is idle after a
 * scene loads, instead of the first time a battle draws them.
 *
 * Compiling a WebGL program blocks the drawing thread until the GPU process
 * has linked it (PIXI asks for the link status at once), and it also waits for
 * every draw already queued. Measured 2026-11-04, seeded battle on a real GPU
 * with a warm browser shader cache: the acting-token outline took 115-156 ms
 * and a ColorMatrixFilter 80-97 ms, both mid-battle, at the first turn start.
 *
 * PIXI keeps one Program per shader source (Program.from) and its compiled
 * copy per WebGL context, so drawing one throwaway instance once is enough:
 * every later filter with the same source finds it compiled.
 *
 * Register what to warm from the code that owns the effect:
 *   globalThis.__fuShaderPrewarm.register("turn-glow", () => [filterA, filterB]);
 * The function returns the filters to draw on a 4x4 white sprite, or a whole
 * display object to draw as it is (null skips). Each entry is drawn once per
 * WebGL context, one per idle slice, into a small render texture.
 *
 * Kill switch: client setting `pixiShaderPrewarm` (default on).
 * Stats: globalThis.__fuShaderPrewarm.stats ({ warmed: [{ name, ms }], failed }).
 *
 * Classic script: everything stays inside the IIFE (module.json scripts share
 * one global lexical scope).
 */

(() => {
    const NS = 'fabula-ultima-companion';
    const SETTING = 'pixiShaderPrewarm';
    const TAG = '[FU-ShaderPrewarm]';
    const entries = new Map();   // name -> () => PIXI.Filter[] | null
    const done = new Set();      // `${contextUid}:${name}`
    const stats = { warmed: [], failed: 0 };
    let queued = false;

    const api = (globalThis.__fuShaderPrewarm = {
        stats,
        register(name, make) {
            if (typeof make !== 'function') return;
            entries.set(String(name), make);
            schedule();
        },
    });

    // Every PIXI ColorMatrixFilter shares one source: battle poses, target dimming, the
    // targeting highlight and the event effects all use it.
    api.register('color-matrix', () => (typeof PIXI?.ColorMatrixFilter === 'function' ? [new PIXI.ColorMatrixFilter()] : null));

    Hooks.once('init', () => {
        try {
            game.settings.register(NS, SETTING, {
                name: 'Graphics: prepare battle effects in advance',
                hint: 'Compiles the battle\'s effect shaders while the page is idle after a scene loads, '
                    + 'so the first turn of a battle does not pause to compile them.',
                scope: 'client',
                config: false,
                type: Boolean,
                default: true,
            });
        } catch (e) { console.warn(`${TAG} setting registration failed`, e); }
    });

    const enabled = () => { try { return game.settings.get(NS, SETTING) !== false; } catch { return false; } };
    const idle = (fn) => (globalThis.requestIdleCallback ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 200));

    function schedule() {
        if (queued || !globalThis.canvas?.ready) return;
        queued = true;
        idle(step);
    }

    // One entry per idle slice: each may block for a compile.
    function step() {
        queued = false;
        const renderer = globalThis.canvas?.app?.renderer;
        if (!renderer || !enabled()) return;
        const uid = renderer.CONTEXT_UID;
        const next = [...entries.keys()].find((n) => !done.has(`${uid}:${n}`));
        if (!next) return;
        done.add(`${uid}:${next}`);
        let sprite = null, rt = null, filters = null;
        const t = performance.now();
        try {
            const made = entries.get(next)();
            if (made instanceof PIXI.DisplayObject) sprite = made;
            else if (Array.isArray(made) && made.length) {
                filters = made;
                sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
                sprite.width = sprite.height = 4;
                sprite.filters = filters;
            }
            if (sprite) {
                rt = PIXI.RenderTexture.create({ width: 16, height: 16 });
                renderer.render(sprite, { renderTexture: rt, clear: true });
                stats.warmed.push({ name: next, ms: Math.round(performance.now() - t) });
            }
        } catch (e) {
            stats.failed++;
            console.warn(`${TAG} ${next} failed`, e);
        } finally {
            try { sprite?.destroy({ children: true, texture: false, baseTexture: false }); } catch { /* */ }
            try { rt?.destroy(true); } catch { /* */ }
            for (const f of filters ?? []) { try { f?.destroy?.(); } catch { /* */ } }
        }
        schedule();
    }

    Hooks.on('canvasReady', () => schedule());
})();
