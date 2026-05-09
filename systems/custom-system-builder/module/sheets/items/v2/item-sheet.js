/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import CustomItem from '../../../documents/CustomItem.js';
import { isBaseSheetTemplateEntity } from '../../../definitions.js';
export class ItemSheetV2 extends foundry.applications.api.HandlebarsApplicationMixin((foundry.applications.sheets.ItemSheetV2)) {
    static DEFAULT_OPTIONS = {
        ...super.DEFAULT_OPTIONS,
        form: {
            submitOnChange: true
        },
        classes: ['custom-system', 'sheet', 'item', 'item-v2'],
        scrollable: 'item-v2',
        actions: {
            ...super.DEFAULT_OPTIONS.actions,
            editImage: this.onEditImage
        }
    };
    static PARTS = {
        form: {
            get template() {
                throw new Error('Should not use this class directly');
            },
            classes: ['custom-system-item-content']
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
    static canEditModifiers() {
        return game.user.hasRole(game.settings.get(game.system.id, 'minimumRoleEditItemModifiers'));
    }
    hasBeenRenderedOnce = false;
    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        context.item = this.item;
        return {
            ...context,
            ...(await context.item.templateSystem.getSheetData()),
            isEditable: this.isEditable
        };
    }
    /**
     * @override
     * @ignore
     */
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
        if (isBaseSheetTemplateEntity(this.item)) {
            if (!this.hasBeenRenderedOnce) {
                options.position = {
                    ...options.position,
                    width: this.item.system.display.width,
                    height: this.item.system.display.height
                };
                this.hasBeenRenderedOnce = true;
            }
            this.options.window.resizable = !this.item.system.display?.fix_size;
        }
        if (CustomItem.isEquippableItem(this.item) && this.item.system.container) {
            const parentCollection = this.item.getParentCollection();
            parentCollection.get(this.item.system.container).prepareData();
            parentCollection.get(this.item.system.container).render(false);
        }
        return super.render(options);
    }
    /**
     * Render the inner application content
     * @private
     * @override
     * @ignore
     */
    async _renderHTML(context, options) {
        const html = $((await super._renderHTML(context, options)).form);
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
        this.item.templateSystem.activateListeners($(this.element));
    }
}
