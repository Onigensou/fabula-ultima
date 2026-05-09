/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
export var MODIFIER_OPERATOR;
(function (MODIFIER_OPERATOR) {
    MODIFIER_OPERATOR["SET"] = "set";
    MODIFIER_OPERATOR["ADD"] = "add";
    MODIFIER_OPERATOR["SUBTRACT"] = "subtract";
    MODIFIER_OPERATOR["MULTIPLY"] = "multiply";
    MODIFIER_OPERATOR["DIVIDE"] = "divide";
})(MODIFIER_OPERATOR || (MODIFIER_OPERATOR = {}));
export const MODIFIER_OPERATORS = {
    [MODIFIER_OPERATOR.ADD]: '+',
    [MODIFIER_OPERATOR.MULTIPLY]: 'x',
    [MODIFIER_OPERATOR.SUBTRACT]: '-',
    [MODIFIER_OPERATOR.DIVIDE]: '/',
    [MODIFIER_OPERATOR.SET]: '='
};
export const applyModifiers = (value, modifiers = []) => {
    const filteredModifiers = modifiers
        .filter((modifier) => !!modifier.isSelected)
        .sort((mod1, mod2) => {
        const operatorOrder = ['set', 'multiply', 'divide', 'add', 'subtract'];
        let sortIndex = mod1.priority - mod2.priority;
        if (sortIndex === 0) {
            sortIndex = operatorOrder.indexOf(mod1.operator) - operatorOrder.indexOf(mod2.operator);
        }
        return sortIndex;
    });
    for (const modifier of filteredModifiers) {
        switch (modifier.operator) {
            case MODIFIER_OPERATOR.SET:
                if (String(modifier.value) !== '') {
                    value = isNaN(Number(modifier.value)) ? String(modifier.value) : Number(modifier.value);
                }
                break;
            case MODIFIER_OPERATOR.MULTIPLY:
                value = Number(value) * Number(modifier.value);
                break;
            case MODIFIER_OPERATOR.DIVIDE:
                value = Number(value) / Number(modifier.value);
                break;
            case MODIFIER_OPERATOR.SUBTRACT:
                value = Number(value) - Number(modifier.value);
                break;
            case MODIFIER_OPERATOR.ADD:
            default:
                value = Number(value) + Number(modifier.value);
                break;
        }
    }
    return value;
};
