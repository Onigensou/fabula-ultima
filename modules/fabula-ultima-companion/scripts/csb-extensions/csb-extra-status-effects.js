/**
 * [ONI] CSB extra status effects — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * Adds status effects to CONFIG.statusEffects from module code, next to the
 * ones CSB loads from its `customStatusEffects` world setting.
 *
 * Why code and not the setting: the setting lives in the world's `settings`
 * LevelDB store, which also holds per-session churn (users, scene state…) that
 * world commits deliberately leave out. A status registered here ships with
 * the module like any other code change.
 *
 * Each entry has the same shape CSB uses: { id, name, img, linkedEffectId }.
 * `linkedEffectId` is the template Active Effect's id on the Debuff library
 * item (Item.XVOWOq9oUmEECGrU); with Convenient Effects active CSB resolves it
 * through CE, exactly like Bane. An id already present (e.g. someone later
 * adds the same status in CSB's Status Effects dialog) is skipped, never
 * duplicated.
 *
 * Runs on `setup`: CSB assigns CONFIG.statusEffects synchronously in its own
 * `init`, so by `setup` the list is final.
 *
 * ⚠ IIFE-wrapped: module.json scripts are CLASSIC scripts sharing one global
 * lexical scope (see csb-template-layout-dedup.js).
 */

(() => {
    const TAG = '[CSB-ExtraStatus]';
    const ICON = 'https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/';

    // Added 2026-11-10: Armor Break / Magic Break (DEF / M.DEF x0.75, rounded up).
    const EXTRA = [
        { id: 'ArmrBreakStatId1', name: 'Armor Break', img: ICON + '07_MNK/rockbreaker.png',       linkedEffectId: 'ArmrBreakAE00001' },
        { id: 'MagcBreakStatId1', name: 'Magic Break', img: ICON + '17_PCT/Role_Actions/Addle.png', linkedEffectId: 'MagcBreakAE00001' },
    ];

    Hooks.once('setup', () => {
        if (!Array.isArray(CONFIG.statusEffects)) return;
        const have = new Set(CONFIG.statusEffects.map((s) => s?.id));
        let added = 0;
        for (const s of EXTRA) {
            if (have.has(s.id)) continue;
            CONFIG.statusEffects.push({ ...s });
            added++;
        }
        console.info(`${TAG} added ${added} status effect(s).`);
    });
})();
