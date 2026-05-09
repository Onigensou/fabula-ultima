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
export default class CustomToken extends TokenDocument {
    getBarAttribute(barName, options) {
        const barData = super.getBarAttribute(barName, options);
        if (barData) {
            const barAttribute = barData.attribute;
            const actor = this.actor;
            if (barAttribute.startsWith('attributeBar')) {
                barData.editable = foundry.utils.getProperty(actor.system, barAttribute).editable;
            }
            else {
                if (foundry.utils.getProperty(actor.system, barAttribute) !== undefined)
                    barData.editable = true;
            }
        }
        return barData;
    }
    static getTrackedAttributes(data, _path = []) {
        const attributeBarDescription = this._getTrackedAttributesFromObject(data?.attributeBar ?? {}, ['attributeBar']);
        const propBarDescription = this._getTrackedAttributesFromObject(data?.props ?? {}, ['props']);
        return {
            bar: [...attributeBarDescription.bar, ...propBarDescription.bar],
            value: [...attributeBarDescription.value, ...propBarDescription.value]
        };
    }
}
