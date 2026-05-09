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
import { ComponentValidationError, RequiredFieldError } from '../../errors/ComponentValidationError.js';
import { isAppliedTemplateEntity } from '../../definitions.js';
import { COMPONENT_SIZES } from './SizedComponent.js';
/**
 * Dropdown component
 * @ignore
 */
class Dropdown extends InputComponent {
    _selectedOptionType;
    /** Options */
    _options;
    /** Dynamic table key */
    _tableKey;
    /** Key of the column to use as options keys */
    _tableKeyColumn;
    /** Key of the column to use as labels */
    _tableLabelColumn;
    /** Formula of the column to use as options keys */
    _formulaKeyOptions;
    /** Formula of the column to use as labels */
    _formulaLabelOptions;
    /** Dropdown constructor */
    constructor(props) {
        super(props);
        this._selectedOptionType = props.selectedOptionType ?? 'custom';
        this._options = props.options ?? [];
        this._tableKey = props.tableKey;
        this._tableKeyColumn = props.tableKeyColumn;
        this._tableLabelColumn = props.tableLabelColumn;
        this._formulaKeyOptions = props.formulaKeyOptions;
        this._formulaLabelOptions = props.formulaLabelOptions;
    }
    get key() {
        return this._key;
    }
    /**
     * Renders component
     * @override
     * @param {TemplateSystem} entity Rendered entity (actor or item)
     * @param {boolean} [isEditable=true] Is the component editable by the current user ?
     * @param {ComponentRenderOptions} [options={}] Additional options usable by the final Component
     * @return {Promise<JQuery>} The jQuery element holding the component
     */
    async _getElement(entity, isEditable = true, options = {}) {
        const { reference } = options;
        const props = { ...entity.system.props, ...options.customProps };
        const jQElement = await super._getElement(entity, isEditable, options);
        jQElement.addClass('custom-system-select');
        const selectElement = $('<select />');
        selectElement.attr('id', this.getSluggedId(entity));
        if (!this.defaultValue) {
            const emptyOption = $('<option></option>');
            emptyOption.attr('value', '');
            selectElement.append(emptyOption);
        }
        const optionKeys = new Set();
        if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            selectElement.attr('name', 'system.props.' + this.key);
            if (!isEditable) {
                selectElement.attr('disabled', 'disabled');
            }
            if (this._selectedOptionType === 'table') {
                let baseProps = entity.system.props;
                let tableKey = this._tableKey;
                if (tableKey.startsWith('parent.') &&
                    entity.entity.parent &&
                    isAppliedTemplateEntity(entity.entity.parent)) {
                    baseProps = entity.entity.parent.system.props;
                    tableKey = tableKey.split('.', 2)[1];
                }
                const dynamicProps = foundry.utils.getProperty(baseProps, tableKey);
                if (dynamicProps) {
                    for (const rowIndex in dynamicProps) {
                        if (dynamicProps[rowIndex] && !dynamicProps[rowIndex]?.$deleted) {
                            selectElement.append(this._addOption(optionKeys, dynamicProps[rowIndex][this._tableKeyColumn], this._tableLabelColumn
                                ? dynamicProps[rowIndex][this._tableLabelColumn]
                                : dynamicProps[rowIndex][this._tableKeyColumn]));
                        }
                    }
                }
            }
            else if (this._selectedOptionType === 'formula' && TemplateSystem.isAppliedTemplateSystem(entity)) {
                const keyOptions = (await ComputablePhrase.computeMessage(this._formulaKeyOptions, props, {
                    ...options,
                    source: `${this.key}.keyOptions`,
                    reference,
                    defaultValue: '',
                    triggerEntity: entity
                })).result.split(',');
                const labelOptions = (await ComputablePhrase.computeMessage(this._formulaLabelOptions ?? '', props, {
                    ...options,
                    source: `${this.key}.labelOptions`,
                    reference,
                    defaultValue: '',
                    triggerEntity: entity
                })).result.split(',');
                if (labelOptions[0] !== '' && keyOptions.length !== labelOptions.length) {
                    ui.notifications.error(game.i18n.format('CSB.UserMessages.Dropdown.OptionsLengthError', { COMPONENT_KEY: this.key }));
                }
                else {
                    for (let i = 0; i < keyOptions.length; i++) {
                        selectElement.append(this._addOption(optionKeys, keyOptions[i], labelOptions[0] === '' ? keyOptions[i] : labelOptions[i]));
                    }
                }
            }
            else {
                for (const option of this._options) {
                    selectElement.append(this._addOption(optionKeys, option.key, option.value));
                }
            }
            const selectedValue = foundry.utils.getProperty(props, this.key) ??
                ComputablePhrase.computeMessageStatic(this.defaultValue ?? '', props, {
                    source: this.key,
                    reference,
                    defaultValue: '',
                    triggerEntity: entity
                }).result;
            selectElement.val(optionKeys.has(selectedValue) ? selectedValue : selectElement.find('option:first').val());
        }
        jQElement.append(selectElement);
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            jQElement.addClass('custom-system-editable-component');
            selectElement.addClass('custom-system-editable-field');
            jQElement.on('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.editComponent(entity);
            });
        }
        return jQElement;
    }
    /** Returns serialized component */
    toJSON() {
        const jsonObj = super.toJSON();
        return {
            ...jsonObj,
            selectedOptionType: this._selectedOptionType,
            options: this._options,
            tableKey: this._tableKey,
            tableKeyColumn: this._tableKeyColumn,
            tableLabelColumn: this._tableLabelColumn,
            formulaKeyOptions: this._formulaKeyOptions,
            formulaLabelOptions: this._formulaLabelOptions
        };
    }
    /** Creates Dropdown from JSON description */
    static fromJSON(json, templateAddress, parent) {
        return new Dropdown({
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
        return 'select';
    }
    /**
     * Gets pretty name for this component's type
     * @returns The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.Dropdown');
    }
    /** Get configuration form for component creation / edition */
    static async getConfigForm(_entity, appId, existingComponent) {
        const predefinedValues = { ...existingComponent };
        predefinedValues.selectedOptionType = predefinedValues.selectedOptionType ?? 'custom';
        const mainElt = document.createElement('div');
        mainElt.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/components/dropdown.hbs`, {
            ...predefinedValues,
            COMPONENT_SIZES,
            appId
        });
        mainElt.addEventListener('click', (event) => {
            const target = event.target.closest('.custom-system-delete-option');
            if (target) {
                const row = target.closest('tr');
                // Remove it from the DOM
                row.remove();
            }
        });
        mainElt.querySelector('.addOption')?.addEventListener('click', (event) => {
            const target = event.currentTarget;
            // Create new row
            const newRow = mainElt
                .querySelector('.custom-system-dropdown-option-template')
                ?.content.cloneNode(true);
            const newIndex = String(parseInt(Array.from(target
                .closest('.custom-system-form-field')
                .querySelectorAll('.custom-system-dropdown-option'))?.pop()?.dataset?.index ?? '-1') + 1);
            newRow.querySelector('.custom-system-dropdown-option').dataset.index = newIndex;
            newRow.querySelector('.custom-system-dropdown-option-key').name =
                `optionKeys.${newIndex}`;
            newRow.querySelector('.custom-system-dropdown-option-value').name =
                `optionValues.${newIndex}`;
            // Insert new row
            target.closest('table')?.querySelector('tbody')?.append(newRow);
        });
        mainElt.querySelectorAll("input[name='dropdownOptionMode']").forEach((elt) => {
            elt.addEventListener('change', (event) => {
                const target = event.currentTarget;
                const customOptions = $('.custom-system-custom-options');
                const dynamicTableOptions = $('.custom-system-dynamic-options');
                const formulaOptions = $('.custom-system-formula-options');
                const slideValue = 200;
                console.log('Selected ' + target.value);
                switch (target.value) {
                    case 'custom':
                        customOptions.slideDown(slideValue);
                        dynamicTableOptions.slideUp(slideValue);
                        formulaOptions.slideUp(slideValue);
                        break;
                    case 'table':
                        customOptions.slideUp(slideValue);
                        dynamicTableOptions.slideDown(slideValue);
                        formulaOptions.slideUp(slideValue);
                        break;
                    case 'formula':
                        customOptions.slideUp(slideValue);
                        dynamicTableOptions.slideUp(slideValue);
                        formulaOptions.slideDown(slideValue);
                        break;
                }
            });
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
     * @override
     * @param {JQuery} html The submitted form
     * @return {DropdownJson} The JSON representation of the component
     * @throws {Error} If configuration is not correct
     */
    static extractConfig(rawConfigData, html) {
        const configData = rawConfigData;
        const options = [];
        const selectedOptionType = configData.dropdownOptionMode ?? 'custom';
        let tableKey;
        let tableKeyColumn;
        let tableLabelColumn;
        let formulaKeyOptions;
        let formulaLabelOptions;
        switch (selectedOptionType) {
            case 'custom': {
                const optionKeys = configData.optionKeys ?? {};
                const optionValues = configData.optionValues ?? {};
                Object.entries(optionKeys).forEach(([idx, key]) => {
                    options.push({
                        key,
                        value: optionValues[idx]
                    });
                });
                break;
            }
            case 'table':
                tableKey = configData.tableKey;
                tableKeyColumn = configData.tableKeyColumn;
                tableLabelColumn = configData.tableLabelColumn;
                break;
            case 'formula':
                formulaKeyOptions = configData.formulaKeyOptions;
                formulaLabelOptions = configData.formulaLabelOptions;
                break;
        }
        const fieldData = {
            ...super.extractConfig(configData, html),
            selectedOptionType: selectedOptionType,
            options: options,
            tableKey: tableKey,
            tableKeyColumn: tableKeyColumn,
            tableLabelColumn: tableLabelColumn,
            formulaKeyOptions: formulaKeyOptions,
            formulaLabelOptions: formulaLabelOptions
        };
        return fieldData;
    }
    static validateConfig(json) {
        super.validateConfig(json);
        switch (json.selectedOptionType) {
            case 'custom':
                json.options ??= [];
                json.options.forEach((option) => {
                    if (option.key === '') {
                        throw new ComponentValidationError(game.i18n.localize('CSB.ComponentProperties.Errors.DropdownOptionValidationError'), 'options', json);
                    }
                });
                break;
            case 'formula':
                if (!json.formulaKeyOptions) {
                    throw new RequiredFieldError(game.i18n.localize('CSB.ComponentProperties.Dropdown.OptionsOrigin.FormulaForKeyOption'), json);
                }
                break;
            case 'table':
                if (!json.tableKey) {
                    throw new RequiredFieldError(game.i18n.localize('CSB.ComponentProperties.Dropdown.OptionsOrigin.DynamicTableKey'), json);
                }
                if (!json.tableKeyColumn) {
                    throw new RequiredFieldError(game.i18n.localize('CSB.ComponentProperties.Dropdown.OptionsOrigin.DynamicTableOptionKey'), json);
                }
                break;
        }
    }
    /**
     * Adds an option to the provided collection
     * @param collection {Set}
     * @param key {String}
     * @param value {String}
     * @returns {JQuery}
     * @private
     */
    _addOption(collection, key, value) {
        const optionElement = $('<option></option>');
        collection.add(key);
        optionElement.attr('value', key);
        optionElement.text(value);
        return optionElement;
    }
}
/**
 * @ignore
 */
export default Dropdown;
