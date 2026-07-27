/**
 * [ONI] CSB Template Layout Dedup — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * CSB stores a FULL COPY of the template's sheet layout (`system.body` +
 * `system.header`) on every instance. It is written by one assignment in
 * TemplateSystem.reloadTemplate (`body: template.system.body`) and read back by
 * prepareData to build `customBody`/`customHeader`. Nothing keeps the copy in
 * sync afterwards.
 *
 * Measured on this world (2026-07-28):
 *   - Hina: 100 embedded items carry only THREE distinct layouts. All 61 skills
 *     share ONE byte-identical 115 KB blob => 7,041 KB where 115 KB would do.
 *     12,099 KB of her 14,367 KB is repeated copies.
 *   - World-wide: ~280 MB of a ~409 MB join payload is duplicated layout.
 *   - Batch verified over 3,713 documents: 68.6% of items render BYTE-IDENTICAL
 *     from the master, 31.4% gain content they were missing (stale copies), and
 *     ZERO shrink.
 *
 * This file makes the stored copy OPTIONAL:
 *   (1) READ  — prepareData resolves the layout from the master when the
 *               instance's own is absent/empty.
 *   (2) WRITE — reloadTemplate stops re-stamping the copy onto instances, so a
 *               stripped world does not creep back as you author.
 *
 * SCOPE: ITEMS ONLY. Actors are deliberately excluded — measured 2026-07-28,
 * only 2.6 MB of their 41 MB of layout is safely reclaimable, and stripping a
 * STALE actor provably loses UI: "Cradle" lost 22 rendered fields (the whole
 * chanter_* block) because PC instances carry per-instance layout the char
 * template cannot reproduce. See character-creation/cc-const.js, which already
 * documents that re-stamping resets authored dropdowns on PCs.
 *
 * SAFETY RAILS
 *   - Off by default. Enable via the `csbLayoutDedup` world setting.
 *   - Never touches an entity whose template does not RESOLVE: today's stored
 *     copy is the only thing rendering those, and blanking them would leave a
 *     dead sheet. (314 item docs are in that state right now.)
 *   - Never touches template/sub-template documents themselves — they are the
 *     source of truth and MUST keep their layout.
 *   - Shape-guarded: if CSB's internals stop looking like 4.8.5, the patch
 *     declines and logs rather than half-applying.
 *
 * NOT handled here: stripping the EXISTING copies. That is a separate migration
 * (a direct `update({system:{body:EMPTY}})`, never reloadTemplate — reload also
 * prunes props missing from the template and would delete authored data).
 *
 * ⚠ IIFE-wrapped: module.json scripts are CLASSIC scripts sharing one global
 * lexical scope, so a top-level `const` here collides with sibling files and
 * throws at PARSE time, silently skipping this ENTIRE file. Keep the wrapper.
 */

(() => {
    const TAG = '[CSB-LayoutDedup]';
    const SETTING = 'csbLayoutDedup';
    const EMPTY_BODY = { key: 'custom_body', type: 'panel', contents: [] };
    const EMPTY_HEADER = { key: 'custom_header', type: 'panel', contents: [] };

    const csbImport = import('/systems/custom-system-builder/module/documents/TemplateSystem.js')
        .then((m) => m.default);
    csbImport.catch(() => {});

    const enabled = () => {
        try { return !!game.settings.get('fabula-ultima-companion', SETTING); } catch { return false; }
    };

    /** Is this an INSTANCE we may dedup? Items only, never templates. */
    const isDedupableInstance = (entity) => {
        if (!entity || entity.documentName !== 'Item') return false;
        // Template + sub-template documents own the layout; never blank them.
        if (['_template', '_equippableItemTemplate'].includes(entity.type)) return false;
        return !!entity.system?.template;
    };

    /** Resolve an instance's master, or null when it dangles. */
    const resolveMaster = (entity) => {
        const tid = entity?.system?.template;
        if (!tid) return null;
        return game.items?.get(tid) ?? null;
    };

    const isEmptyPanel = (p) => !p || !Array.isArray(p.contents) || p.contents.length === 0;

    Hooks.once('init', () => {
        try {
            game.settings.register('fabula-ultima-companion', SETTING, {
                name: 'CSB: resolve sheet layout from template',
                hint: 'Stops storing a full copy of the template sheet layout on every item. '
                    + 'Items resolve their layout from the master template instead. Items only; '
                    + 'actors are excluded. Requires a reload.',
                scope: 'world',
                config: false,       // deliberate: flip via API after verifying, not by accident
                type: Boolean,
                default: false,
            });
        } catch (e) { console.warn(`${TAG} setting registration failed`, e); }
    });

    Hooks.once('customSystemBuilderInit', async () => {
        let TemplateSystem;
        try { TemplateSystem = await csbImport; }
        catch (e) { console.warn(`${TAG} could not import TemplateSystem; skipping.`, e); return; }

        const proto = TemplateSystem?.prototype;
        if (!proto) { console.warn(`${TAG} TemplateSystem.prototype missing; skipping.`); return; }

        patchRead(proto);
        patchWrite(proto);
        console.info(`${TAG} installed (active: ${enabled()}).`);
    });

    /* ---------------------------------------------------------------- READ -- */
    // prepareData builds customBody/customHeader from `this.entity.system.body`.
    // When an instance has no stored layout, substitute a DEEP CLONE of the
    // master's for the duration of the original call.
    //
    // The clone is load-bearing: handing prepareData a live reference to the
    // master lets CSB mutate the master's own component data, which silently
    // corrupts every other instance derived from it (observed 2026-07-28).
    function patchRead(proto) {
        const orig = proto.prepareData;
        if (typeof orig !== 'function') { console.warn(`${TAG} prepareData missing; skipping read patch.`); return; }
        if (orig.__fuLayoutDedup) return;

        const src = String(orig);
        if (!src.includes('customBody') || !src.includes('Panel.fromJSON')) {
            console.warn(`${TAG} prepareData body not as expected; skipping read patch.`);
            return;
        }

        const patched = function () {
            if (!enabled()) return orig.call(this);
            const sys = this.entity?.system;
            if (!sys || !isDedupableInstance(this.entity) || !isEmptyPanel(sys.body)) {
                return orig.call(this);
            }
            const master = resolveMaster(this.entity);
            if (!master) return orig.call(this);   // dangling pointer: leave stock behaviour

            const ob = sys.body, oh = sys.header;
            sys.body = foundry.utils.deepClone(master.system.body);
            sys.header = foundry.utils.deepClone(master.system.header);
            try { return orig.call(this); }
            finally { sys.body = ob; sys.header = oh; }
        };
        patched.__fuLayoutDedup = true;
        proto.prepareData = patched;
    }

    /* --------------------------------------------------------------- WRITE -- */
    // reloadTemplate re-stamps `body`/`header` from the master onto the instance
    // (TemplateSystem.js ~694). Left alone, every re-stamp re-inflates the world.
    // We let CSB run untouched — its prop reconciliation must still happen — then
    // blank the layout it just wrote, so the READ patch supplies it instead.
    function patchWrite(proto) {
        const orig = proto.reloadTemplate;
        if (typeof orig !== 'function') { console.warn(`${TAG} reloadTemplate missing; skipping write patch.`); return; }
        if (orig.__fuLayoutDedup) return;

        const src = String(orig);
        if (!src.includes('body:') || !src.includes('templateSystemUniqueVersion')) {
            console.warn(`${TAG} reloadTemplate body not as expected; skipping write patch.`);
            return;
        }

        const patched = async function (templateId) {
            const result = await orig.call(this, templateId);
            if (!enabled()) return result;
            try {
                const entity = this.entity;
                if (!isDedupableInstance(entity)) return result;
                if (!resolveMaster(entity)) return result;
                if (isEmptyPanel(entity.system?.body)) return result;   // already lean
                await entity.update({ system: { body: EMPTY_BODY, header: EMPTY_HEADER } });
            } catch (e) {
                console.warn(`${TAG} post-reload blank failed for ${this.entity?.uuid}`, e);
            }
            return result;
        };
        patched.__fuLayoutDedup = true;
        proto.reloadTemplate = patched;
    }
})();
