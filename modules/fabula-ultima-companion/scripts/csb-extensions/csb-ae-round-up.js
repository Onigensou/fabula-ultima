/**
 * [ONI] CSB AE Round-Up — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * Lets an Active Effect ask for the props it changes to be ROUNDED UP to a whole
 * number once the actor is fully derived:
 *
 *   flags.fabula-ultima-companion.roundUp = ["defense"]     (or "defense, magic_defense")
 *
 * Why: a MULTIPLY change halves a value exactly (Rakshasa's Crippled: DEF 11 x 0.5
 * = 5.5), and neither Foundry nor CSB can round inside an AE change. A CSB formula
 * that reads the prop it overrides (`${ceil(defense / 2)}$`) was tried first and
 * measured unsafe (2026-11-04): stacked with another `defense` AE it left DEF
 * UNDEFINED on Blanche, which every reader turns into 0 = always hit. The multiply
 * stays as the change; this rounds its result, so the sheet, the HUD, the Inspect
 * card and the hit check all see the same whole number.
 *
 * Runs after CustomActor.prepareDerivedData (CSB computes every prop there), only
 * for keys an ACTIVE effect on the actor names, and only on a finite non-integer
 * number, so an actor without such an effect is untouched.
 *
 * ⚠ IIFE-wrapped: module.json scripts are CLASSIC scripts sharing one global
 * lexical scope (see csb-template-layout-dedup.js).
 */

(() => {
    const TAG = '[CSB-AeRoundUp]';
    const NS = 'fabula-ultima-companion';

    const keysOf = (raw) => (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
        .map((k) => String(k).trim())
        .filter(Boolean);

    function roundUpProps(actor) {
        const props = actor?.system?.props;
        if (!props) return;
        const effects = typeof actor.allApplicableEffects === 'function' ? actor.allApplicableEffects() : (actor.effects ?? []);
        for (const eff of effects) {
            const raw = eff?.flags?.[NS]?.roundUp;
            if (!raw || eff.disabled || eff.isSuppressed) continue;
            for (const key of keysOf(raw)) {
                const v = props[key];
                if (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) props[key] = Math.ceil(v);
            }
        }
    }

    Hooks.once('customSystemBuilderInit', async () => {
        let CustomActor;
        try { CustomActor = (await import('/systems/custom-system-builder/module/documents/CustomActor.js')).default; }
        catch (e) { console.warn(`${TAG} could not import CustomActor; AE round-up disabled.`, e); return; }
        const proto = CustomActor?.prototype;
        const orig = proto?.prepareDerivedData;
        if (typeof orig !== 'function') { console.warn(`${TAG} CustomActor.prepareDerivedData missing; skipping.`); return; }
        if (orig.__fuAeRoundUp) return;
        const patched = function (...args) {
            const result = orig.apply(this, args);
            try { roundUpProps(this); } catch (e) { console.warn(`${TAG} round-up failed for ${this?.name}`, e); }
            return result;
        };
        patched.__fuAeRoundUp = true;
        proto.prepareDerivedData = patched;
        console.info(`${TAG} installed.`);
    });
})();
