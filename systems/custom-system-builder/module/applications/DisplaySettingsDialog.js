/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Logger from '../Logger.js';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
/**
 * @ignore
 * @module
 */
export default class DisplaySettingsDialog extends HandlebarsApplicationMixin((ApplicationV2)) {
    entity;
    static DEFAULT_OPTIONS = {
        tag: 'form',
        form: {
            handler: DisplaySettingsDialog.saveHandler,
            submitOnChange: false,
            closeOnSubmit: false
        },
        actions: {
            cancel: DisplaySettingsDialog.cancel,
            defaultValues: DisplaySettingsDialog.defaultValues
        },
        window: {
            title: 'CSB.Display.EditDialog.Title',
            icon: 'fas fa-window',
            resizable: false,
            minimizable: true,
            contentClasses: ['standard-form']
        },
        position: {
            width: 'auto',
            height: 'auto'
        },
        classes: ['custom-system-editDisplaySettings']
    };
    static PARTS = {
        form: {
            get template() {
                return `systems/${game.system.id}/templates/settings/displaySettings.hbs`;
            }
        },
        footer: {
            template: 'templates/generic/form-footer.hbs'
        }
    };
    static FIELD_RULES = {
        width: {
            required: true,
            type: 'number',
            integer: true,
            min: 100,
            max: Number.MAX_VALUE,
            default: 600
        },
        height: {
            required: true,
            type: 'number',
            integer: true,
            min: 100,
            max: Number.MAX_VALUE,
            default: 600
        },
        pp_width: {
            required: false,
            type: 'number',
            integer: true,
            min: 0,
            max: Number.MAX_VALUE,
            default: 64
        },
        pp_height: {
            required: false,
            type: 'number',
            integer: true,
            min: 0,
            max: Number.MAX_VALUE,
            default: 64
        },
        fix_size: {
            required: false,
            type: 'boolean',
            default: false
        }
    };
    static async saveHandler(_event, _form, formData) {
        const finalValues = {};
        for (const field of Object.keys(DisplaySettingsDialog.FIELD_RULES)) {
            const value = DisplaySettingsDialog.validateField(field, formData.get(field));
            finalValues[field] = value;
        }
        Logger.debug(`Saving display settings for ${this.entity.uuid}`, finalValues);
        this.entity
            .update({
            system: {
                display: finalValues
            }
        })
            .then(() => {
            this.entity.sheet.hasBeenRenderedOnce = false;
            this.entity.render();
        });
        this.close();
    }
    static validateField(name, value) {
        if (Object.keys(DisplaySettingsDialog.FIELD_RULES).includes(name)) {
            const rules = DisplaySettingsDialog.FIELD_RULES[name];
            switch (rules.type) {
                case 'number':
                    return this.validateNumber(name, value, rules);
                case 'boolean':
                    return this.validateBoolean(name, value, rules);
                default:
                    return value;
            }
        }
    }
    static validateNumber(name, value, rules) {
        if (value === undefined) {
            if (rules.required) {
                throw new Error(`${name} is mandatory`);
            }
            return rules.default;
        }
        else {
            if (!Number.isNumeric(value)) {
                throw new Error(`${name} must be a Number`);
            }
            const numberValue = Number(value);
            if (rules.integer && !Number.isInteger(numberValue)) {
                throw new Error(`${name} must be an Integer`);
            }
            if (numberValue < rules.min) {
                throw new Error(`${name} must be greater than ${rules.min}`);
            }
            if (numberValue > rules.max) {
                throw new Error(`${name} must be lesser than ${rules.max}`);
            }
            return numberValue;
        }
    }
    static validateBoolean(name, value, rules) {
        if (value === undefined) {
            if (rules.required) {
                throw new Error(`${name} is mandatory`);
            }
            return rules.default;
        }
        else {
            if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
                throw new Error(`${name} must be a Boolean`);
            }
            return !!value && value !== 'false';
        }
    }
    static async cancel(_event, _target) {
        this.close();
    }
    static async defaultValues(_event, target) {
        const appRoot = target.closest('.custom-system-editDisplaySettings');
        for (const field of Object.keys(DisplaySettingsDialog.FIELD_RULES)) {
            const htmlElement = appRoot.querySelector(`[name=${field}]`);
            switch (htmlElement.type) {
                case 'checkbox':
                    htmlElement.checked = !!DisplaySettingsDialog.FIELD_RULES[field].default;
                    break;
                default:
                    htmlElement.value = DisplaySettingsDialog.FIELD_RULES[field].default?.toString() ?? '';
                    break;
            }
        }
    }
    constructor(entity) {
        super();
        this.entity = entity;
    }
    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        context.width = this.entity.system.display?.width ?? 600;
        context.height = this.entity.system.display?.height ?? 600;
        context.pp_width = this.entity.system.display?.pp_width ?? 64;
        context.pp_height = this.entity.system.display?.pp_height ?? 64;
        context.fix_size = this.entity.system.display?.fix_size ?? false;
        context.buttons = [
            { type: 'submit', icon: 'fa-solid fa-save', label: 'Save' },
            { type: 'button', action: 'defaultValues', icon: 'fa-solid fa-undo', label: 'Reset' },
            { type: 'button', action: 'cancel', icon: 'fa-solid fa-xmark', label: 'Cancel' }
        ];
        return context;
    }
}
