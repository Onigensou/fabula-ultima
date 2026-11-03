/**
 * [ONI] CSB AE Upgrade No-Op — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * Keeps an UPGRADE / DOWNGRADE change that does nothing from wiping the prop it
 * targets, which silently cancelled every later change to the same prop.
 *
 * Root cause (Foundry 12.343, measured 2026-11-03): `ActiveEffect#_applyUpgrade`
 * writes `changes[key] = undefined` when the value is already past the bound
 * (UPGRADE 12 on DEF 19). CSB props are not schema fields, so the change goes
 * through `_applyLegacy`, whose `mergeObject(actor, changes)` then sets
 * `system.props.defense = undefined` on the actor. CSB's AE loop
 * (TemplateSystem.js) applies the next change to that prop against the blanked
 * value: a MULTIPLY gets `null` and yields nothing, so the change is dropped;
 * a formula reading the prop throws Uncomputable. The prop is restored to its
 * pre-effect formula value afterwards, so it looks as if nothing applied at all.
 *
 * Seen as: Rakshasa's Crippled (DEF x0.5) had no effect on Blanche (DEF 19)
 * while Barrier (DEF UPGRADE 12) was on her, but worked on Keren (DEF 11), where
 * the upgrade really applies. Any no-op UPGRADE/DOWNGRADE stacked with a later
 * change hits it (Barrier, Psychic Shield).
 *
 * Fix: a no-op on a number/boolean keeps the current value instead of
 * undefined, which is what "no change" means. Other types are left as Foundry
 * has them.
 *
 * ⚠ IIFE-wrapped: module.json scripts are CLASSIC scripts sharing one global
 * lexical scope (see csb-template-layout-dedup.js).
 */

(() => {
    const TAG = '[CSB-AeUpgradeNoop]';

    Hooks.once('init', () => {
        // Bare name, not globalThis.ActiveEffect: foundry.js declares it with a
        // top-level `class`, a global lexical binding that is not on window.
        const proto = typeof ActiveEffect === 'function' ? ActiveEffect.prototype : undefined;
        const orig = proto?._applyUpgrade;
        if (typeof orig !== 'function') { console.warn(`${TAG} ActiveEffect._applyUpgrade missing; skipping.`); return; }
        if (orig.__fuAeUpgradeNoop) return;
        const patched = function (actor, change, current, delta, changes) {
            orig.call(this, actor, change, current, delta, changes);
            const ct = foundry.utils.getType(current);
            if (changes[change.key] === undefined && (ct === 'number' || ct === 'boolean')) changes[change.key] = current;
        };
        patched.__fuAeUpgradeNoop = true;
        proto._applyUpgrade = patched;
        console.info(`${TAG} installed.`);
    });
})();
