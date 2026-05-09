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
/**
 * Picture component
 * @ignore
 */
class Picture extends InputComponent {
    static valueType = 'string';
    /**
     * Width of the final picture, in pixels
     */
    _width;
    /**
     * Height of the final picture, in pixels
     */
    _height;
    /**
     * Picture constructor
     */
    constructor(props) {
        super(props);
        this._defaultValue = props.defaultValue ?? 'icons/svg/cancel.svg';
        this._width = props.width;
        this._height = props.height;
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
        const fieldValue = foundry.utils.getProperty(props, this.key) ??
            (this.defaultValue
                ? ComputablePhrase.computeMessageStatic(this.defaultValue, props, {
                    source: `${this.key}.defaultValue`,
                    reference: options.reference,
                    defaultValue: '',
                    triggerEntity: entity
                }).result
                : '');
        const jQElement = await super._getElement(entity, isEditable, options);
        jQElement.addClass('custom-system-picture');
        const hiddenInputElement = document.createElement('input');
        hiddenInputElement.type = 'hidden';
        if (!isEditable) {
            hiddenInputElement.disabled = true;
        }
        const imgElement = document.createElement('img');
        imgElement.src = fieldValue;
        imgElement.id = this.getSluggedId(entity);
        if (this._width) {
            imgElement.width = this._width;
            imgElement.style.width = `${this._width}px`;
        }
        if (this._height) {
            imgElement.height = this._height;
            imgElement.style.height = `${this._height}px`;
        }
        jQElement.append(imgElement);
        if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            if (!options.noName) {
                hiddenInputElement.name = 'system.props.' + this.key;
            }
            if (options.changeCallback) {
                $(hiddenInputElement).on('change', options.changeCallback);
            }
            hiddenInputElement.value = fieldValue;
            if (isEditable) {
                imgElement.classList.add('custom-system-clickable');
                imgElement.addEventListener('click', (_event) => {
                    const fp = new FilePicker({
                        current: hiddenInputElement.value,
                        type: 'image',
                        callback: (path) => {
                            imgElement.src = path;
                            hiddenInputElement.value = path;
                            hiddenInputElement.form?.dispatchEvent(new Event('change'));
                        }
                    });
                    fp.browse(hiddenInputElement.value);
                });
                jQElement.append(hiddenInputElement);
            }
        }
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            jQElement.addClass('custom-system-editable-component');
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
            width: this._width,
            height: this._height
        };
    }
    /**
     * Creates picture from JSON description
     */
    static fromJSON(json, templateAddress, parent) {
        return new Picture({
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
        return 'picture';
    }
    /**
     * Gets pretty name for this component's type
     * @returns The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.Picture');
    }
    /**
     * Get configuration form for component creation / edition
     * @returns The jQuery element holding the component
     */
    static async getConfigForm(_entity, appId, existingComponent) {
        const mainElt = document.createElement('div');
        mainElt.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/components/picture.hbs`, {
            ...existingComponent,
            appId
        });
        mainElt.querySelector('button[data-configAction="openFilePicker"]')?.addEventListener('click', () => {
            const defaultValueField = mainElt.querySelector('[name="defaultValue"]');
            const fp = new FilePicker({
                current: defaultValueField.value,
                type: 'image',
                callback: (path) => {
                    defaultValueField.value = path;
                }
            });
            try {
                fp.browse(defaultValueField.value);
            }
            catch (err) {
                ui.notifications.warn(err.message);
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
            width: configData.width,
            height: configData.height
        };
        return fieldData;
    }
}
/**
 * @ignore
 */
export default Picture;
