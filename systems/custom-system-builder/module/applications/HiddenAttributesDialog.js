/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Logger from '../Logger.js';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
export default class HiddenAttributesDialog extends HandlebarsApplicationMixin((ApplicationV2)) {
    entity;
    static DEFAULT_OPTIONS = {
        tag: 'form',
        form: {
            handler: HiddenAttributesDialog.saveHandler,
            submitOnChange: false,
            closeOnSubmit: false
        },
        actions: {
            cancel: HiddenAttributesDialog.cancel,
            addAttribute: HiddenAttributesDialog.addAttribute,
            removeAttribute: HiddenAttributesDialog.removeAttribute
        },
        window: {
            title: 'CSB.Attributes.EditHiddenAttributesDialog.Title',
            icon: 'fas fa-eye-slash',
            resizable: true,
            minimizable: true,
            contentClasses: ['standard-form']
        },
        position: {
            width: 500,
            height: 'auto'
        },
        classes: ['custom-system-editHiddenAttributes custom-system-list-dialog']
    };
    static PARTS = {
        form: {
            get template() {
                return `systems/${game.system.id}/templates/settings/hiddenAttributes.hbs`;
            }
        },
        footer: {
            template: 'templates/generic/form-footer.hbs'
        }
    };
    static async saveHandler(_event, _form, formData) {
        const formDataObj = foundry.utils.expandObject(Object.fromEntries(formData.entries()));
        const attributesArray = Object.values(formDataObj.attributes ?? {});
        if (attributesArray.some((attribute) => {
            return !attribute.name || attribute.name === '' || !attribute.value || attribute.value === '';
        })) {
            throw new Error(game.i18n.localize('CSB.Attributes.EditHiddenAttributesDialog.MissingData'));
        }
        Logger.debug(`Saving hidden attributes for ${this.entity.uuid}`, attributesArray);
        this.entity.update({
            system: {
                hidden: attributesArray
            }
        });
        this.close();
    }
    static async cancel(_event, _target) {
        this.close();
    }
    static async addAttribute(_event, target) {
        const windowContent = target.closest('.window-content');
        const newAttributeRow = windowContent.querySelector('.custom-system-hidden-attribute-template').content.cloneNode(true);
        const currentIndex = parseInt(Array.from(windowContent.querySelectorAll('.custom-system-hidden-attribute'))?.pop()
            ?.dataset?.index ?? '-1');
        const newIndex = currentIndex + 1;
        newAttributeRow.querySelector('.custom-system-hidden-attribute').dataset.index =
            String(newIndex);
        newAttributeRow.querySelector('.custom-system-attribute-name').name =
            `attributes.${newIndex}.name`;
        newAttributeRow.querySelector('.custom-system-attribute-formula').name =
            `attributes.${newIndex}.value`;
        windowContent?.querySelector('.hiddenAttributesList')?.append(newAttributeRow);
    }
    static async removeAttribute(_event, target) {
        target.closest('.custom-system-hidden-attribute')?.remove();
    }
    constructor(entity) {
        super();
        this.entity = entity;
    }
    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        context.attributes = this.entity.system.hidden ?? [];
        context.buttons = [
            { type: 'submit', icon: 'fa-solid fa-save', label: 'Save' },
            { type: 'button', action: 'cancel', icon: 'fa-solid fa-xmark', label: 'Cancel' }
        ];
        return context;
    }
}
