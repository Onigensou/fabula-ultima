/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Logger from '../../Logger.js';
import { RequiredFieldError } from '../../errors/ComponentValidationError.js';
import SizedComponent, { COMPONENT_SIZES } from './SizedComponent.js';
const METER_TEXT_OPTIONS = {
    none: 'CSB.ComponentProperties.Meter.TextDisplay.None',
    showVal: 'CSB.ComponentProperties.Meter.TextDisplay.Value',
    showMax: 'CSB.ComponentProperties.Meter.TextDisplay.ValueAndMaximum',
    showPercent: 'CSB.ComponentProperties.Meter.TextDisplay.ValueAsPercentage'
};
const textOptionDefault = 'none';
const METER_COLORS = {
    GOOD_VALUE: '#00AB60',
    BAD_VALUE: '#FFBD4F',
    WORSE_VALUE: '#E22850'
};
class Meter extends SizedComponent {
    static valueType = 'none';
    /**
     * Component label
     */
    _label;
    /**
     * Meter value formula
     */
    _value;
    /**
     * Minimum value formula
     */
    _min;
    /**
     * Maximum value formula
     */
    _max;
    /**
     * Low value formula
     */
    _low;
    /**
     * High value formula
     */
    _high;
    /**
     * Optimum value formula
     */
    _optimum;
    /**
     * Text display option
     */
    _textOption;
    /**
     * Meter constructor
     */
    constructor(props) {
        super(props);
        this._label = props.label;
        this._value = props.value;
        this._min = props.min;
        this._max = props.max;
        this._low = props.low;
        this._high = props.high;
        this._optimum = props.optimum;
        this._textOption = props.textOption ?? textOptionDefault;
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
        const { customProps = {}, linkedEntity, reference } = options;
        const jQElement = await super._getElement(entity, isEditable, options);
        if (this._label) {
            const label = $('<label></label>');
            label.attr('for', this.getSluggedId(entity));
            label.text(this._label);
            jQElement.append(label);
        }
        const meterElement = $('<div></div>');
        meterElement.addClass('custom-system-meter');
        const meterFill = $('<span></span>');
        meterFill.addClass('custom-system-meter-fill');
        const meterText = $('<span></span>');
        meterText.addClass('custom-system-meter-content');
        meterElement.append(meterFill);
        meterElement.append(meterText);
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            meterFill.css({ width: `50%`, 'background-color': METER_COLORS.GOOD_VALUE });
            switch (this._textOption) {
                case 'showVal':
                    meterText.text('50');
                    break;
                case 'showMax':
                    meterText.text('50 / 100');
                    break;
                case 'showPercent':
                    meterText.text('50%');
                    break;
            }
            jQElement.addClass('custom-system-editable-component');
            jQElement.on('click', () => {
                this.editComponent(entity);
            });
        }
        else if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            const formulaProps = foundry.utils.mergeObject(entity.system.props, customProps, { inplace: false });
            let min = 0;
            if (this._min) {
                min = parseFloat(this._computeParam(this._min, entity, { ...options, source: `${this.key}.min` }));
            }
            let max = 1;
            if (this._max) {
                max = parseFloat(this._computeParam(this._max, entity, { ...options, source: `${this.key}.max` }));
            }
            let low;
            if (this._low) {
                low = parseFloat(this._computeParam(this._low, entity, { ...options, source: `${this.key}.low` }));
            }
            let high;
            if (this._high) {
                high = parseFloat(this._computeParam(this._high, entity, { ...options, source: `${this.key}.high` }));
            }
            let optimum;
            if (this._optimum) {
                optimum = parseFloat(this._computeParam(this._optimum, entity, {
                    ...options,
                    source: `${this.key}.optimum`
                }));
            }
            let meterValue = 0;
            // If Meter has a key, it was computed with the derivedData of the entity, no need to recompute it
            if (this.key &&
                foundry.utils.getProperty(formulaProps, this.key) !== null &&
                foundry.utils.getProperty(formulaProps, this.key) !== undefined) {
                meterValue = foundry.utils.getProperty(formulaProps, this.key);
                Logger.debug('Using precomputed value for ' + this.key + ' : ' + meterValue);
            }
            else {
                try {
                    meterValue = parseFloat((await ComputablePhrase.computeMessage(this._value ?? '', formulaProps, {
                        source: `${this.key}`,
                        reference,
                        defaultValue: '',
                        triggerEntity: entity,
                        linkedEntity
                    })).result);
                }
                catch (err) {
                    Logger.error(err.message, err);
                    meterValue = 0;
                }
            }
            let color = METER_COLORS.GOOD_VALUE;
            if (optimum !== undefined) {
                if (low !== undefined && high !== undefined) {
                    if (optimum < low) {
                        if (meterValue > high) {
                            color = METER_COLORS.WORSE_VALUE;
                        }
                        else if (meterValue > low) {
                            color = METER_COLORS.BAD_VALUE;
                        }
                    }
                    else if (optimum > high) {
                        if (meterValue < low) {
                            color = METER_COLORS.WORSE_VALUE;
                        }
                        else if (meterValue < high) {
                            color = METER_COLORS.BAD_VALUE;
                        }
                    }
                    else {
                        if (meterValue < low || meterValue > high) {
                            color = METER_COLORS.BAD_VALUE;
                        }
                    }
                }
                else {
                    const gateValue = low ?? high;
                    if (gateValue !== undefined) {
                        if (optimum < gateValue && meterValue > gateValue) {
                            color = METER_COLORS.BAD_VALUE;
                        }
                        else if (optimum > gateValue && meterValue < gateValue) {
                            color = METER_COLORS.BAD_VALUE;
                        }
                    }
                }
            }
            else {
                if (low !== undefined && meterValue < low) {
                    color = METER_COLORS.BAD_VALUE;
                }
                if (high !== undefined && meterValue > high) {
                    color = METER_COLORS.BAD_VALUE;
                }
            }
            const meterPercent = ((meterValue - min) * 100) / (max - min);
            meterFill.css({ width: `${meterPercent}%`, 'background-color': color });
            switch (this._textOption) {
                case 'showVal':
                    meterText.text(meterValue);
                    break;
                case 'showMax':
                    meterText.text(`${meterValue} / ${max}`);
                    break;
                case 'showPercent':
                    meterText.text(`${Math.round(meterPercent * 100) / 100}%`);
                    break;
            }
        }
        jQElement.append(meterElement);
        return jQElement;
    }
    _computeParam(valueFormula, entity, options) {
        const formulaProps = foundry.utils.mergeObject(entity.system.props, options?.customProps ?? {}, {
            inplace: false
        });
        return ComputablePhrase.computeMessageStatic(valueFormula, formulaProps, {
            ...options,
            defaultValue: 0,
            triggerEntity: entity
        }).result;
    }
    getComputeFunctions(_entity, _modifiers, options, keyOverride) {
        const computationKey = keyOverride ?? this.key;
        if (!computationKey) {
            return {};
        }
        return {
            [computationKey]: {
                formula: this._value ?? '',
                options
            }
        };
    }
    resetComputeValue(valueKeys) {
        const resetValues = {};
        for (const key of valueKeys) {
            foundry.utils.setProperty(resetValues, key, undefined);
        }
        return resetValues;
    }
    getMaxValue(entity, options, keyOverride) {
        return parseFloat(this._computeParam(this._max ?? '0', entity, { ...options, source: `${keyOverride ?? this.key}.max` }));
    }
    getValue(entity, _options, keyOverride) {
        return entity.system.props[keyOverride ?? this.key];
    }
    isEditable() {
        return false;
    }
    /**
     * Returns serialized component
     * @override
     */
    toJSON() {
        const jsonObj = super.toJSON();
        return {
            ...jsonObj,
            label: this._label,
            value: this._value,
            min: this._min,
            max: this._max,
            low: this._low,
            high: this._high,
            optimum: this._optimum,
            textOption: this._textOption,
            type: 'meter'
        };
    }
    /**
     * Creates meter from JSON description
     * @override
     */
    static fromJSON(json, templateAddress, parent) {
        return new Meter({
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
        return 'meter';
    }
    /**
     * Gets pretty name for this component's type
     * @return The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.Meter');
    }
    /**
     * Get configuration form for component creation / edition
     * @return The jQuery element holding the component
     */
    static async getConfigForm(_entity, appId, existingComponent) {
        const mainElt = document.createElement('div');
        const predefinedValuesComponent = { ...existingComponent };
        mainElt.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/components/meter.hbs`, {
            ...predefinedValuesComponent,
            COMPONENT_SIZES,
            METER_TEXT_OPTIONS,
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
     * @override
     * @param html The submitted form
     * @return The JSON representation of the component
     * @throws {Error} If configuration is not correct
     */
    static extractConfig(rawConfigData, html) {
        const configData = rawConfigData;
        const fieldData = {
            ...super.extractConfig(configData, html),
            type: 'meter',
            label: configData.label,
            value: configData.value ?? '',
            min: configData.min,
            max: configData.max,
            low: configData.low,
            high: configData.high,
            optimum: configData.optimum,
            textOption: configData.textOption ?? textOptionDefault
        };
        return fieldData;
    }
    static validateConfig(json) {
        super.validateConfig(json);
        if (json.value === '') {
            throw new RequiredFieldError(game.i18n.localize('CSB.ComponentProperties.Meter.Value'), json);
        }
    }
}
/**
 * @ignore
 */
export default Meter;
