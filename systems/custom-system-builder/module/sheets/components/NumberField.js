/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Logger from '../../Logger.js';
import InputComponent from './InputComponent.js';
import { COMPONENT_SIZES } from './SizedComponent.js';
export const NUMBER_FIELD_INPUT_STYLES = {
    text: 'CSB.ComponentProperties.NumberField.DisplayStyle.DisplayAsTextField',
    range: 'CSB.ComponentProperties.NumberField.DisplayStyle.DisplayAsSlider'
};
const defaultInputStyle = 'text';
export const NUMBER_FIELD_CONTROLS_STYLES = {
    hover: 'CSB.ComponentProperties.NumberField.ControlStyle.Hover',
    full: 'CSB.ComponentProperties.NumberField.ControlStyle.FullControl'
};
export const NUMBER_FIELD_CONTROLS_DEFAULT_INCREMENTS = {
    hover: [-1, 1],
    full: [-10, -1, 1, 10]
};
const defaultControlsStyle = 'hover';
/**
 * NumberField component
 * @ignore
 */
class NumberField extends InputComponent {
    static valueType = 'number';
    /**
     * Allows for decimal numbers
     */
    _allowDecimal;
    /**
     * Min value
     * Can be a Number or a Formula
     */
    _minVal;
    /**
     * Max value
     * Can be a Number or a Formula
     */
    _maxVal;
    /**
     * If value can be changed by relative operations
     */
    _allowRelative;
    /**
     * Whether to show controls on render
     */
    _showControls;
    /**
     * Controls style
     */
    _controlsStyle;
    /**
     * Comma-separated numbers to use as button increments
     */
    _controlsCustomIncrements;
    /**
     * Field style
     */
    _inputStyle;
    /**
     * Text field constructor
     */
    constructor(props) {
        super(props);
        this._allowDecimal = props.allowDecimal ?? false;
        this._minVal = props.minVal;
        this._maxVal = props.maxVal;
        this._allowRelative = props.allowRelative ?? false;
        this._showControls = props.showControls ?? false;
        this._controlsStyle = props.controlsStyle ?? defaultControlsStyle;
        this._controlsCustomIncrements = props.controlsCustomIncrements;
        this._inputStyle = props.inputStyle ?? defaultInputStyle;
    }
    /**
     * Compute the max value of this Number Field
     * @param entity Entity computing the max value
     * @param options Options to alter computation
     * @param keyOverride Override the source key to the computation
     * @returns The max value
     */
    getMaxValue(entity, options, keyOverride) {
        return this._getMaxVal(entity, entity.system.props, { ...options, source: keyOverride ?? this.key });
    }
    /**
     * Compute the value of this Number Field
     * @param entity Entity computing the value
     * @param _options Ignored
     * @param keyOverride Override the source key to the computation
     * @returns The value
     */
    getValue(entity, _options, keyOverride) {
        return Number(entity.system.props[keyOverride ?? this.key]);
    }
    /**
     * @inheritdoc
     */
    isEditable() {
        return true;
    }
    _getMinVal(entity, props, options) {
        let min = -Infinity;
        if (this._minVal) {
            min = Number(this._minVal);
            if (Number.isNaN(min)) {
                min = Number(ComputablePhrase.computeMessageStatic(this._minVal, props, {
                    source: `${options?.source ?? this.key}.min`,
                    reference: options?.reference,
                    defaultValue: '0',
                    triggerEntity: entity
                }).result);
            }
            if (Number.isNaN(min)) {
                min = -Infinity;
            }
        }
        return min;
    }
    _getMaxVal(entity, props, options) {
        let max = Infinity;
        if (this._maxVal) {
            max = Number(this._maxVal);
            if (Number.isNaN(max)) {
                max = Number(ComputablePhrase.computeMessageStatic(this._maxVal, props, {
                    source: `${options?.source ?? this.key}.max`,
                    reference: options?.reference,
                    defaultValue: '0',
                    triggerEntity: entity
                }).result);
            }
            if (Number.isNaN(max)) {
                max = Infinity;
            }
        }
        return max;
    }
    /**
     * Renders component
     * @override
     * @return The jQuery element holding the component
     */
    async _getElement(entity, isEditable = true, options = {}) {
        const { reference } = options;
        const jQElement = await super._getElement(entity, isEditable, options);
        jQElement.addClass('custom-system-number-field');
        const fieldSpan = $('<span></span>');
        fieldSpan.addClass('custom-system-number-input-span');
        const hiddenInputElement = $('<input />');
        hiddenInputElement.attr('type', 'hidden');
        const inputElement = $('<input />');
        inputElement.attr('type', this._inputStyle);
        inputElement.attr('id', this.getSluggedId(entity));
        if (!isEditable) {
            hiddenInputElement.attr('disabled', 'disabled');
            inputElement.attr('disabled', 'disabled');
        }
        if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            const props = { ...entity.system.props, ...options.customProps };
            if (this._inputStyle === 'range') {
                inputElement.attr('min', this._getMinVal(entity, props, options));
                inputElement.attr('max', this._getMaxVal(entity, props, options));
            }
            const fieldValue = options.overrideValue ??
                foundry.utils.getProperty(props, this.key) ??
                (this.defaultValue
                    ? Number(ComputablePhrase.computeMessageStatic(this.defaultValue, props, {
                        source: `${this.key}.defaultValue`,
                        reference,
                        defaultValue: '',
                        triggerEntity: entity
                    }).result)
                    : '');
            if (!options.noName) {
                hiddenInputElement.attr('name', 'system.props.' + this.key);
            }
            if (options.changeCallback) {
                hiddenInputElement.on('change', options.changeCallback);
            }
            hiddenInputElement.val(fieldValue);
            inputElement.val(fieldValue);
            const persistValue = () => {
                let newValue = String(inputElement.val());
                const oldValue = String(hiddenInputElement.val());
                let persistedValue;
                if (isNaN(Number(newValue))) {
                    persistedValue = Number(oldValue);
                    ui.notifications.warn(game.i18n.localize('CSB.UserMessages.NumberField.ValueNotNumeric'));
                }
                else {
                    if (!this._allowDecimal && !Number.isInteger(Number(newValue))) {
                        newValue = oldValue;
                        ui.notifications.warn(game.i18n.localize('CSB.UserMessages.NumberField.ValueNotInteger'));
                    }
                    persistedValue = Number(newValue);
                    if (this._allowRelative && (newValue.startsWith('+') || newValue.startsWith('-'))) {
                        persistedValue = Number(oldValue) + Number(newValue);
                    }
                    const min = this._getMinVal(entity, props, options);
                    if (persistedValue < min) {
                        persistedValue = min;
                        ui.notifications.warn(game.i18n.format('CSB.UserMessages.NumberField.ValueNotTooLow', { VALUE: min }));
                    }
                    const max = this._getMaxVal(entity, props, options);
                    if (persistedValue > max) {
                        persistedValue = max;
                        ui.notifications.warn(game.i18n.format('CSB.UserMessages.NumberField.ValueNotTooHigh', { VALUE: max }));
                    }
                }
                inputElement.val(persistedValue);
                if (String(persistedValue) !== oldValue) {
                    Logger.debug('Saving value ' + persistedValue);
                    hiddenInputElement.attr('value', persistedValue).trigger('change');
                    hiddenInputElement[0].form?.dispatchEvent(new Event('change'));
                }
            };
            if (!isEditable) {
                jQElement.append(inputElement);
            }
            else {
                let hasBeenModified = false;
                inputElement
                    .on('focus', () => {
                    inputElement.trigger('select');
                })
                    .on('keydown', () => {
                    if (inputElement.val() !== fieldValue) {
                        hasBeenModified = true;
                    }
                })
                    .on('blur', () => {
                    if (hasBeenModified) {
                        persistValue();
                    }
                })
                    .on('change', (event) => {
                    persistValue();
                    event.preventDefault();
                    event.stopPropagation();
                });
                fieldSpan.append(hiddenInputElement);
                fieldSpan.append(inputElement);
                if (this._showControls) {
                    const min = this._getMinVal(entity, props, options);
                    const max = this._getMaxVal(entity, props, options);
                    const validCustomIncrements = Array.from(new Set((await ComputablePhrase.computeMessage(this._controlsCustomIncrements ?? '', props, {
                        ...options,
                        source: `${this.key}.controlsCustomIncrements`,
                        reference,
                        defaultValue: '',
                        triggerEntity: entity
                    })).result
                        .split(',')
                        .map(Number)
                        .filter((n) => isFinite(n) && n != 0 && (this._allowDecimal || Number.isInteger(n))) ??
                        []));
                    const increments = validCustomIncrements.length > 0
                        ? validCustomIncrements
                        : NUMBER_FIELD_CONTROLS_DEFAULT_INCREMENTS[this._controlsStyle];
                    const negativeButtons = [];
                    const positiveButtons = [];
                    let showIncrementValue = true;
                    if (increments.every((num) => Math.abs(num) === 1)) {
                        showIncrementValue = false;
                    }
                    increments
                        .sort((a, b) => a - b)
                        .forEach((value) => {
                        const button = $('<button type="button"></button>');
                        button.addClass('custom-system-number-field-control');
                        button.on('click', () => {
                            inputElement.val(Math.clamp(Number(inputElement.val()) + value, min, max));
                        });
                        if (value < 0) {
                            button.text(showIncrementValue ? value : '-');
                            negativeButtons.push(button);
                        }
                        else {
                            button.text('+' + (showIncrementValue ? value : ''));
                            positiveButtons.push(button);
                        }
                    });
                    if (this._controlsStyle === 'full') {
                        fieldSpan.addClass('custom-system-number-input-span-full-controls');
                        for (let i = negativeButtons.length - 1; i >= 0; --i) {
                            fieldSpan.prepend(negativeButtons[i]);
                        }
                        for (let i = 0; i < positiveButtons.length; ++i) {
                            fieldSpan.append(positiveButtons[i]);
                        }
                        fieldSpan.on('mouseleave', () => {
                            if (!inputElement.is(':focus')) {
                                persistValue();
                            }
                        });
                    }
                    else {
                        fieldSpan.addClass('custom-system-number-input-span-hover-controls');
                        const negativeButtonsSpan = $('<span></span>');
                        negativeButtonsSpan.addClass('custom-system-number-input-span');
                        negativeButtonsSpan.addClass('custom-system-number-field-controls-multi-buttons-span');
                        negativeButtonsSpan.addClass('custom-system-number-field-control-minus');
                        negativeButtons.forEach((button) => {
                            button.addClass('custom-system-number-field-control-minus');
                            negativeButtonsSpan.append(button);
                        });
                        negativeButtonsSpan.hide();
                        fieldSpan.prepend(negativeButtonsSpan);
                        const positiveButtonsSpan = $('<span></span>');
                        positiveButtonsSpan.addClass('custom-system-number-input-span');
                        positiveButtonsSpan.addClass('custom-system-number-field-controls-multi-buttons-span');
                        positiveButtonsSpan.addClass('custom-system-number-field-control-plus');
                        positiveButtons.forEach((button) => {
                            button.addClass('custom-system-number-field-control-plus');
                            positiveButtonsSpan.append(button);
                        });
                        positiveButtonsSpan.hide();
                        fieldSpan.append(positiveButtonsSpan);
                        fieldSpan
                            .on('mouseover', () => {
                            const totalButtonsWidth = (negativeButtonsSpan?.width() ?? 0) + (positiveButtonsSpan?.width() ?? 0);
                            if ((inputElement.width() ?? 0) < totalButtonsWidth) {
                                negativeButtonsSpan.addClass('custom-system-number-field-control-outer');
                                positiveButtonsSpan.addClass('custom-system-number-field-control-outer');
                            }
                            else {
                                negativeButtonsSpan.removeClass('custom-system-number-field-control-outer');
                                positiveButtonsSpan.removeClass('custom-system-number-field-control-outer');
                            }
                            negativeButtonsSpan.show();
                            positiveButtonsSpan.show();
                        })
                            .on('mouseleave', () => {
                            negativeButtonsSpan.hide();
                            positiveButtonsSpan.hide();
                            if (!inputElement.is(':focus')) {
                                persistValue();
                            }
                        });
                    }
                }
                jQElement.append(fieldSpan);
            }
        }
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            jQElement.addClass('custom-system-editable-component');
            inputElement.addClass('custom-system-editable-field');
            inputElement.val(this.defaultValue ?? '');
            jQElement.on('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.editComponent(entity);
            });
            jQElement.append(inputElement);
        }
        return jQElement;
    }
    /**
     * Returns serialized component
     * @override
     */
    toJSON() {
        const jsonObj = super.toJSON();
        return {
            ...jsonObj,
            allowDecimal: this._allowDecimal,
            minVal: this._minVal,
            maxVal: this._maxVal,
            allowRelative: this._allowRelative,
            showControls: this._showControls,
            controlsStyle: this._controlsStyle,
            controlsCustomIncrements: this._controlsCustomIncrements,
            inputStyle: this._inputStyle
        };
    }
    /**
     * Creates TextField from JSON description
     * @override
     */
    static fromJSON(json, templateAddress, parent) {
        return new NumberField({
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
        return 'numberField';
    }
    /**
     * Gets pretty name for this component's type
     * @return The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.NumberField');
    }
    /**
     * Get configuration form for component creation / edition
     * @return The jQuery element holding the component
     */
    static async getConfigForm(_entity, appId, existingComponent) {
        const mainElt = document.createElement('div');
        mainElt.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/components/numberField.hbs`, {
            ...existingComponent,
            COMPONENT_SIZES,
            NUMBER_FIELD_CONTROLS_STYLES,
            NUMBER_FIELD_INPUT_STYLES,
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
        const showControls = mainElt.querySelector('[name="showControls"]');
        const controlsSettings = mainElt.querySelector('[name="numberFieldControlsSettings"]');
        if (showControls && controlsSettings) {
            const toggleFieldControlsSettingsBlock = () => (controlsSettings.style.display = showControls.checked ? 'block' : 'none');
            showControls.addEventListener('change', toggleFieldControlsSettingsBlock);
            toggleFieldControlsSettingsBlock();
        }
        const controlsStyleSelect = mainElt.querySelector('[name="controlsStyle"]');
        const controlsCustomIncrements = mainElt.querySelector('[name="controlsCustomIncrements"]');
        controlsCustomIncrements.placeholder =
            NUMBER_FIELD_CONTROLS_DEFAULT_INCREMENTS[controlsStyleSelect.value].join(',');
        controlsStyleSelect.addEventListener('change', () => {
            controlsCustomIncrements.placeholder =
                NUMBER_FIELD_CONTROLS_DEFAULT_INCREMENTS[controlsStyleSelect.value].join(',');
        });
        return mainElt;
    }
    /**
     * Extracts configuration from submitted HTML form
     * @override
     * @return The JSON representation of the component
     * @throws {Error} If configuration is not correct
     */
    static extractConfig(rawConfigData, html) {
        const configData = rawConfigData;
        const fieldData = {
            ...super.extractConfig(configData, html),
            allowDecimal: configData.allowDecimal,
            minVal: configData.minVal,
            maxVal: configData.maxVal,
            allowRelative: configData.allowRelative,
            showControls: configData.showControls,
            controlsStyle: configData.controlsStyle ?? defaultControlsStyle,
            controlsCustomIncrements: configData.controlsCustomIncrements,
            inputStyle: configData.inputStyle ?? defaultInputStyle
        };
        return fieldData;
    }
}
/**
 * @ignore
 */
export default NumberField;
