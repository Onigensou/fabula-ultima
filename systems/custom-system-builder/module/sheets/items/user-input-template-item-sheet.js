/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * @ignore
 * @module
 */
/**
 * Extend the basic ItemSheet with some very simple modifications
 * @extends {ItemSheet}
 * @ignore
 */
export class UserInputTemplateItemSheet extends ItemSheet {
    /** @override */
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            classes: ['custom-system', 'sheet', 'item', 'item-v1', 'userInputTemplate'],
            template: `systems/${game.system.id}/templates/item/item-sheet.hbs`,
            width: 600,
            height: 600,
            tabs: [
                {
                    navSelector: '.sheet-tabs',
                    contentSelector: '.sheet-body'
                }
            ],
            scrollY: ['.custom-system-actor-content']
        });
    }
    /**
     * @override
     * @ignore
     */
    get template() {
        return `systems/${game.system.id}/templates/item/${this.item.type}-sheet.hbs`;
    }
    /** @override */
    async getData() {
        // Retrieve the data structure from the base sheet. You can inspect or log
        // the context variable to see the structure, but some key properties for
        // sheets are the actor object, the data object, whether or not it's
        // editable, the items array, and the effects array.
        let context = super.getData();
        return { ...context, ...(await context.item.templateSystem.getSheetData()) };
    }
    /** @override */
    activateListeners(html) {
        this.item.templateSystem.activateListeners(html);
        super.activateListeners(html);
    }
    /**
     * Render the inner application content
     * @param {object} data         The data used to render the inner template
     * @returns {Promise<jQuery>}   A promise resolving to the constructed jQuery object
     * @private
     * @override
     * @ignore
     */
    async _renderInner(data) {
        let html = await super._renderInner(data);
        // Append built sheet to html
        html.find('.custom-system-customBody').append(data.bodyPanel);
        return html;
    }
}
