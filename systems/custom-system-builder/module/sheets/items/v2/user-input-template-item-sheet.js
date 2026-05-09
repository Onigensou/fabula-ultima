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
import { ItemSheetV2 } from './item-sheet.js';
/**
 * Extend the basic ItemSheet with some very simple modifications
 * @ignore
 */
export class UserInputTemplateItemSheetV2 extends ItemSheetV2 {
    static DEFAULT_OPTIONS = {
        ...super.DEFAULT_OPTIONS,
        classes: [...super.DEFAULT_OPTIONS.classes, 'userInputTemplate']
    };
    static PARTS = {
        form: {
            get template() {
                return `systems/${game.system.id}/templates/item/v2/userInputTemplate-sheet.hbs`;
            },
            classes: super.PARTS.form.classes
        }
    };
}
