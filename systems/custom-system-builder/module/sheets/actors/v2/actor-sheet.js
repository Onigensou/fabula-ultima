/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import CustomActor from '../../../documents/CustomActor.js';
/**
 * Extend the basic ActorSheet
 * @abstract
 * @extends {foundry.applications.sheets.ActorSheetV2 }
 */
export class CustomActorSheetV2 extends foundry.applications.api.HandlebarsApplicationMixin((foundry.applications.sheets.ActorSheetV2)) {
    static DEFAULT_OPTIONS = {
        ...super.DEFAULT_OPTIONS,
        form: {
            submitOnChange: true
        },
        classes: ['custom-system', 'sheet', 'actor', 'actor-v2'],
        scrollable: 'actor-v2',
        actions: {
            ...super.DEFAULT_OPTIONS.actions,
            editImage: this.onEditImage
        }
    };
    static PARTS = {
        form: {
            get template() {
                return '';
            },
            classes: ['custom-system-actor-content']
        }
    };
    static async onEditImage(_event, target) {
        const field = target.dataset.field || 'img';
        const current = foundry.utils.getProperty(this.document, field);
        const fp = new FilePicker({
            type: 'image',
            current: current,
            callback: (path) => this.document.update({ [field]: path })
        });
        fp.render(true);
    }
    /* -------------------------------------------- */
    hasBeenRenderedOnce = false;
    constructor(options = {}) {
        super(options);
        this.options.window.resizable = !this.document.system.display?.fix_size;
    }
    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        context.actor = this.actor;
        return { ...context, ...(await context.actor.templateSystem.getSheetData()) };
    }
    async render(options, trueOptions) {
        if (options === undefined || typeof options === 'boolean')
            options = Object.assign(trueOptions ?? {}, { force: options });
        // Fix for a rendering bug triggering a warning notification on any sheet update for players who have no permissions over the sheet
        try {
            this._canRender(options);
        }
        catch (_err) {
            return this;
        }
        if (CustomActor.isCharacterActor(this.actor) || CustomActor.isTemplateActor(this.actor)) {
            if (!this.hasBeenRenderedOnce) {
                options.position = {
                    ...options.position,
                    width: this.actor.system.display.width,
                    height: this.actor.system.display.height
                };
                this.hasBeenRenderedOnce = true;
            }
            this.options.window.resizable = !this.actor.system.display?.fix_size;
        }
        return super.render(options);
    }
    /**
     * Render the inner application content
     * @param {object} data         The data used to render the inner template
     * @returns {Promise<jQuery>}   A promise resolving to the constructed jQuery object
     * @private
     * @override
     * @ignore
     */
    async _renderHTML(context, options) {
        const html = $((await super._renderHTML(context, options)).form);
        // Append built sheet to html
        if (context.headerPanel)
            html.find('.custom-system-customHeader').append(context.headerPanel);
        if (context.bodyPanel)
            html.find('.custom-system-customBody').append(context.bodyPanel);
        return { form: html[0] };
    }
    /**
     * Actions performed after any render of the Application.
     * Post-render steps are not awaited by the render process.
     */
    _onRender(context, options) {
        super._onRender(context, options);
        this.actor.templateSystem.activateListeners($(this.element));
    }
}
