/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Simple computable element class, used initially to compute hidden attributes in the sheet
 */
export default class SimpleComputableElement {
    key;
    phrase;
    /**
     * @param key The key of the computable element, used to set it into the props
     * @param phrase The formula to compute
     */
    constructor(key, phrase) {
        this.key = key;
        this.phrase = phrase;
    }
    /**
     * Get the function to compute the value of the component
     * @param _templateSystem The entity to compute the element from
     * @param _modifiers The modifiers of the entity to eventually apply to the computed value
     * @param options Options to compute the value
     * @param keyOverride An optional key to override the initial key of the prop
     * @returns The anonymous function to compute the property
     */
    getComputeFunctions(_templateSystem, _modifiers, options, keyOverride) {
        const computationKey = keyOverride ?? this.key;
        if (!computationKey) {
            return {};
        }
        return {
            [computationKey]: {
                formula: this.phrase,
                options
            }
        };
    }
    /**
     * Returns a record of nullified values to ensure a clean slate before computation
     * @param valueKeys All keys returned by the getComputeFunctions of this element
     */
    resetComputeValue(valueKeys) {
        const resetValues = {};
        for (const key of valueKeys) {
            foundry.utils.setProperty(resetValues, key, undefined);
        }
        return resetValues;
    }
}
