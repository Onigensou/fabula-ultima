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
import Logger from '../../Logger.js';
import InputComponent from './InputComponent.js';
import { COMPONENT_SIZES } from './SizedComponent.js';
/**
 * TextField component
 * @ignore
 */
class TextField extends InputComponent {
    /**
     * Text field allowed characters
     */
    _charList;
    /**
     * Max input length
     */
    _maxLength;
    /**
     * Input autocomplete formula
     */
    _autocomplete;
    /**
     * Text field constructor
     */
    constructor(props) {
        super(props);
        this._charList = props.charList;
        this._maxLength = props.maxLength;
        this._autocomplete = props.autocomplete ?? '';
    }
    /**
     * Renders component
     * @override
     * @param entity Rendered entity (actor or item)
     * @param isEditable Is the component editable by the current user ?
     * @param options Additional options usable by the final Component
     * @return The jQuery element holding the component
     */
    async _getElement(entity, isEditable = true, options = {}) {
        const { reference } = options;
        const jQElement = await super._getElement(entity, isEditable, options);
        jQElement.addClass('custom-system-text-field');
        const inputElement = $('<input />');
        inputElement.attr('type', 'text');
        inputElement.attr('id', this.getSluggedId(entity));
        jQElement.append(inputElement);
        if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            const props = { ...entity.system.props, ...options.customProps };
            inputElement.attr('name', 'system.props.' + this.key);
            const fieldValue = foundry.utils.getProperty(props, this.key) ??
                (this.defaultValue
                    ? ComputablePhrase.computeMessageStatic(this.defaultValue, props, {
                        source: `${this.key}.defaultValue`,
                        reference,
                        defaultValue: '',
                        triggerEntity: entity
                    }).result
                    : '');
            inputElement.val(fieldValue);
            if (!isEditable) {
                inputElement.attr('disabled', 'disabled');
            }
            let changeEventAdded = false;
            inputElement.on('keydown', () => {
                const oldValue = String(inputElement.val());
                // Triggers the change only once
                if (!changeEventAdded) {
                    changeEventAdded = true;
                    inputElement.one('change', () => {
                        changeEventAdded = false;
                        let newValue = String(inputElement.val());
                        if (this._maxLength && this._maxLength > 0 && newValue.length > this._maxLength) {
                            newValue = newValue.substring(0, this._maxLength);
                        }
                        if (this._charList) {
                            const validationRegex = new RegExp('^[' + this._charList.replace('\\', '\\\\') + ']*$');
                            if (!newValue.match(validationRegex)) {
                                newValue = oldValue;
                                ui.notifications.warn(game.i18n.localize('CSB.UserMessages.TextField.WrongValue'));
                            }
                        }
                        inputElement.val(newValue);
                    });
                }
            });
            if (this._autocomplete) {
                let autocompleteOptions;
                try {
                    autocompleteOptions = ComputablePhrase.computeMessageStatic(this._autocomplete, props, {
                        source: `${this.key}.autocompleteOptions`,
                        reference,
                        defaultValue: '',
                        triggerEntity: entity
                    }).result;
                }
                catch (err) {
                    Logger.error(err.message, err);
                    autocompleteOptions = '';
                }
                const autocompleteDataList = $('<datalist></datalist>');
                autocompleteDataList.attr('id', `${this.getSluggedId(entity)}-autocompleteOptions`);
                inputElement.attr('list', `${this.getSluggedId(entity)}-autocompleteOptions`);
                autocompleteDataList.append(autocompleteOptions.split(',').map((optionValue) => {
                    const optionElt = $('<option />');
                    optionElt.attr('value', optionValue);
                    return optionElt;
                }));
                jQElement.append(autocompleteDataList);
            }
        }
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            inputElement.val(this.defaultValue ?? '');
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
            charList: this._charList,
            maxLength: this._maxLength,
            autocomplete: this._autocomplete
        };
    }
    /**
     * Creates TextField from JSON description
     */
    static fromJSON(json, templateAddress, parent) {
        return new TextField({
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
        return 'textField';
    }
    /**
     * Gets pretty name for this component's type
     * @return The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.TextField');
    }
    /**
     * Get configuration form for component creation / edition
     * @return The jQuery element holding the component
     */
    static async getConfigForm(_entity, appId, existingComponent) {
        const mainElt = document.createElement('div');
        mainElt.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/components/textField.hbs`, {
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
     * @return The JSON representation of the component
     * @throws {Error} If configuration is not correct
     */
    static extractConfig(rawConfigData, html) {
        const configData = rawConfigData;
        const fieldData = {
            ...super.extractConfig(configData, html),
            charList: configData.charList,
            maxLength: configData.maxLength,
            autocomplete: configData.autocomplete
        };
        return fieldData;
    }
}
/**
 * @ignore
 */
export default TextField;
