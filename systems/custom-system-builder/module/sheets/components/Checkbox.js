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
import InputComponent from './InputComponent.js';
import { COMPONENT_SIZES } from './SizedComponent.js';
/**
 * Checkbox component
 * @ignore
 */
class Checkbox extends InputComponent {
    static valueType = 'boolean';
    /**
     * Checkbox default state
     */
    _defaultChecked;
    /**
     * Checkbox constructor
     */
    constructor(props) {
        super(props);
        this._defaultChecked = props.defaultChecked ?? false;
    }
    /**
     * Renders component
     * @override
     * @param entity Rendered entity (actor or item)
     * @param isEditable Is the component editable by the current user?
     * @param options Additional options usable by the final Component
     * @returns The jQuery element holding the component
     */
    async _getElement(entity, isEditable = true, options = {}) {
        const props = { ...entity.system.props, ...options.customProps };
        const jQElement = await super._getElement(entity, isEditable, options);
        jQElement.addClass('custom-system-checkbox');
        const inputElement = $('<input />');
        inputElement.attr('type', 'checkbox');
        inputElement.attr('id', this.getSluggedId(entity));
        const checkedStatus = foundry.utils.getProperty(props, this.key);
        const checked = checkedStatus || (checkedStatus === undefined && this._defaultChecked);
        if (checked) {
            inputElement.attr('checked', 'checked');
        }
        jQElement.append(inputElement);
        if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            inputElement.attr('name', 'system.props.' + this.key);
            foundry.utils.setProperty(entity.system.props, this.key, checked);
            if (!isEditable) {
                inputElement.attr('disabled', 'disabled');
            }
        }
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            if (this._defaultChecked) {
                inputElement.attr('checked', 'checked');
            }
            jQElement.addClass('custom-system-editable-component');
            inputElement.addClass('custom-system-editable-field');
            jQElement.on('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.editComponent(entity);
            });
        }
        return jQElement;
    }
    /**
     * Returns serialized component
     */
    toJSON() {
        const jsonObj = super.toJSON();
        return {
            ...jsonObj,
            defaultChecked: this._defaultChecked
        };
    }
    /**
     * Creates checkbox from JSON description
     */
    static fromJSON(json, templateAddress, parent) {
        return new Checkbox({
            ...json,
            parent: parent,
            templateAddress: templateAddress
        });
    }
    /**
     * Gets technical name for this component's type
     * @return The technical name
     * @throws {Error} If not implemented
     */
    static getTechnicalName() {
        return 'checkbox';
    }
    /**
     * Gets pretty name for this component's type
     * @returns The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.Checkbox');
    }
    /**
     * Get configuration form for component creation / edition
     * @returns The jQuery element holding the component
     */
    static async getConfigForm(_entity, appId, existingComponent) {
        const mainElt = document.createElement('div');
        mainElt.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/components/checkbox.hbs`, {
            ...existingComponent,
            COMPONENT_SIZES,
            appId
        });
        mainElt.querySelector('[name="size"]')?.addEventListener('change', (event) => {
            const target = event.currentTarget;
            const customSizeBlock = $(mainElt.querySelector('.custom-system-size-custom'));
            const slideValue = 200;
            switch (target.value) {
                case 'custom':
                    customSizeBlock.slideDown(slideValue);
                    break;
                default:
                    customSizeBlock.slideUp(slideValue);
                    break;
            }
        });
        return mainElt;
    }
    /**
     * Extracts configuration from submitted HTML form
     * @param html The submitted form
     * @returns The JSON representation of the component
     * @throws {Error} If configuration is not correct
     */
    static extractConfig(rawConfigData, html) {
        const configData = rawConfigData;
        const fieldData = {
            ...super.extractConfig(configData, html),
            defaultChecked: configData.defaultChecked
        };
        return fieldData;
    }
}
/**
 * @ignore
 */
export default Checkbox;
