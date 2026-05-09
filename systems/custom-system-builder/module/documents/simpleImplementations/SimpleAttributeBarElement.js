/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Simple attribute bar class, used initially to compute custom attribute bars in sheets
 */
export default class SimpleAttributeBarElement {
    key;
    valueFormula;
    maxFormula;
    _isEditable;
    /**
     * @param key Attribute bar key
     * @param valueFormula Formula for the value of the Attribute bar
     * @param maxFormula Formula for the maximum of the Attribute bar
     * @param _isEditable Is the Attribute Bar editable?
     */
    constructor(key, valueFormula, maxFormula, _isEditable) {
        this.key = key;
        this.valueFormula = valueFormula;
        this.maxFormula = maxFormula;
        this._isEditable = _isEditable;
    }
    /**
     * @inheritdoc
     */
    getMaxValue(templateSystem, options, keyOverride) {
        return Number(ComputablePhrase.computeMessageStatic(String(this.maxFormula), templateSystem.entity.system.props, {
            ...options,
            source: keyOverride ?? this.key,
            availableKeys: Object.keys(templateSystem.entity.system.props),
            triggerEntity: templateSystem,
            defaultValue: 0
        }).result);
    }
    /**
     * @inheritdoc
     */
    getValue(templateSystem, options, keyOverride) {
        return Number(ComputablePhrase.computeMessageStatic(String(this.valueFormula), templateSystem.entity.system.props, {
            ...options,
            source: keyOverride ?? this.key,
            availableKeys: Object.keys(templateSystem.entity.system.props),
            triggerEntity: templateSystem,
            defaultValue: 0
        }).result);
    }
    /**
     * @inheritdoc
     */
    isEditable() {
        return this._isEditable;
    }
}
