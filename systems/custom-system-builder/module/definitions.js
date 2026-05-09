/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
export function isAppliedTemplateEntity(entity) {
    return !!entity && ['character', 'equippableItem'].includes(entity.type);
}
export function isBuilderTemplateEntity(entity) {
    return (!!entity &&
        ['_template', '_equippableItemTemplate', 'subTemplate', 'userInputTemplate'].includes(entity.type));
}
export function isFullBuilderTemplateEntity(entity) {
    return !!entity && ['_template', '_equippableItemTemplate'].includes(entity.type);
}
export function isFullTemplateEntity(entity) {
    return isAppliedTemplateEntity(entity) || isFullBuilderTemplateEntity(entity);
}
export function isBaseSheetTemplateEntity(entity) {
    return (!!entity &&
        ['character', '_template', 'equippableItem', '_equippableItemTemplate'].includes(entity.type));
}
export function isBaseTemplateEntity(entity) {
    return (!!entity &&
        [
            'character',
            '_template',
            'equippableItem',
            '_equippableItemTemplate',
            'subTemplate',
            'userInputTemplate',
            'activeEffectContainer'
        ].includes(entity.type));
}
