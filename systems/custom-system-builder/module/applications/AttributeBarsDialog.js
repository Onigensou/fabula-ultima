/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Logger from '../Logger.js';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
export default class AttributeBarsDialog extends HandlebarsApplicationMixin((ApplicationV2)) {
    entity;
    static DEFAULT_OPTIONS = {
        tag: 'form',
        form: {
            handler: AttributeBarsDialog.saveHandler,
            submitOnChange: false,
            closeOnSubmit: false
        },
        actions: {
            cancel: AttributeBarsDialog.cancel,
            addAttributeBar: AttributeBarsDialog.addAttributeBar,
            removeAttributeBar: AttributeBarsDialog.removeAttributeBar
        },
        window: {
            title: 'CSB.Attributes.EditAttributeBarsDialog.Title',
            icon: 'fas fa-bars-progress',
            resizable: true,
            minimizable: true,
            contentClasses: ['standard-form']
        },
        position: {
            width: 500,
            height: 'auto'
        },
        classes: ['custom-system-editAttributeBars custom-system-list-dialog']
    };
    static PARTS = {
        form: {
            get template() {
                return `systems/${game.system.id}/templates/settings/attributeBars.hbs`;
            }
        },
        footer: {
            template: 'templates/generic/form-footer.hbs'
        }
    };
    static async saveHandler(_event, _form, formData) {
        const formDataObj = foundry.utils.expandObject(Object.fromEntries(formData.entries()));
        const attributeBarsArray = Object.values(formDataObj.attributeBars ?? {});
        if (attributeBarsArray.some((attribute) => {
            return (!attribute.name ||
                attribute.name === '' ||
                !attribute.value ||
                attribute.value === '' ||
                !attribute.max ||
                attribute.max === '');
        })) {
            throw new Error(game.i18n.localize('CSB.Attributes.EditAttributeBarsDialog.MissingData'));
        }
        const finalData = Object.fromEntries(attributeBarsArray.map((attributeBar) => {
            return [attributeBar.name, { value: attributeBar.value, max: attributeBar.max, editable: false }];
        }));
        Logger.debug(`Saving attribute bars for ${this.entity.uuid}`, finalData);
        for (const barName in this.entity.system.attributeBar) {
            if (!finalData[barName]) {
                finalData['-=' + barName] = { value: '0', max: '0', editable: false };
            }
        }
        this.entity.update({
            system: {
                attributeBar: finalData
            }
        });
        this.close();
    }
    static async cancel(_event, _target) {
        this.close();
    }
    static async addAttributeBar(_event, target) {
        const windowContent = target.closest('.window-content');
        const newAttributeBarRow = windowContent.querySelector('.custom-system-attribute-bar-template').content.cloneNode(true);
        const currentIndex = parseInt(Array.from(windowContent.querySelectorAll('.custom-system-attribute-bar'))?.pop()?.dataset
            ?.index ?? '-1');
        const newIndex = currentIndex + 1;
        newAttributeBarRow.querySelector('.custom-system-attribute-bar').dataset.index =
            String(newIndex);
        newAttributeBarRow.querySelector('.custom-system-attribute-bar-name').name =
            `attributeBars.${newIndex}.name`;
        newAttributeBarRow.querySelector('.custom-system-attribute-bar-value').name =
            `attributeBars.${newIndex}.value`;
        newAttributeBarRow.querySelector('.custom-system-attribute-bar-max').name =
            `attributeBars.${newIndex}.max`;
        windowContent?.querySelector('.attributeBarList')?.append(newAttributeBarRow);
    }
    static async removeAttributeBar(_event, target) {
        target.closest('.custom-system-attribute-bar')?.remove();
    }
    constructor(entity) {
        super();
        this.entity = entity;
    }
    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        context.attributeBars = Object.entries(this.entity.system.attributeBar ?? {}).map(([key, data]) => {
            return { name: key, value: String(data.value), max: String(data.max) };
        });
        context.buttons = [
            { type: 'submit', icon: 'fa-solid fa-save', label: 'Save' },
            { type: 'button', action: 'cancel', icon: 'fa-solid fa-xmark', label: 'Cancel' }
        ];
        return context;
    }
}
