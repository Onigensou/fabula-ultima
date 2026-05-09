/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { EquippableItemSheetV2 } from './equippable-item-sheet.js';
import { ItemSheetV2 } from './item-sheet.js';
/**
 * Extend the basic EquippableItemSheetV2 with some very simple modifications
 * @ignore
 */
export class EquippableItemTemplateSheetV2 extends ItemSheetV2 {
    static DEFAULT_OPTIONS = {
        ...super.DEFAULT_OPTIONS,
        window: {
            ...super.DEFAULT_OPTIONS.window,
            controls: [
                ...(super.DEFAULT_OPTIONS.window?.controls ?? []),
                {
                    label: 'CSB.TemplateActions.ConfigureSheetDisplay',
                    icon: 'fas fa-window',
                    action: 'configureSheetDisplay',
                    ownership: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
                },
                {
                    label: 'CSB.TemplateActions.ConfigureHiddenAttributes',
                    icon: 'fas fa-eye-slash',
                    action: 'configureHiddenAttributes',
                    ownership: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
                },
                {
                    label: 'CSB.Sheets.ConfigureItemModifier',
                    icon: 'fas fa-sliders',
                    action: 'configureItemModifier',
                    ownership: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
                    get visible() {
                        return EquippableItemSheetV2.canEditModifiers();
                    }
                },
                {
                    label: 'CSB.TemplateActions.ReloadItemSheet',
                    icon: 'fas fa-arrows-rotate',
                    action: 'reloadItemSheet',
                    ownership: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
                }
            ]
        },
        actions: {
            ...super.DEFAULT_OPTIONS.actions,
            configureSheetDisplay: EquippableItemTemplateSheetV2.configureSheetDisplay,
            configureHiddenAttributes: EquippableItemTemplateSheetV2.configureHiddenAttributes,
            configureItemModifier: EquippableItemTemplateSheetV2.configureItemModifier,
            reloadItemSheet: EquippableItemTemplateSheetV2.reloadItemSheet
        }
    };
    static PARTS = {
        form: {
            get template() {
                return `systems/${game.system.id}/templates/item/v2/_equippableItemTemplate-sheet.hbs`;
            },
            classes: super.PARTS.form.classes
        }
    };
    static configureSheetDisplay(_event, _target) {
        this.item.templateSystem.editDisplaySettings();
    }
    static configureHiddenAttributes(_event, _target) {
        this.item.templateSystem.configureAttributes();
    }
    static configureItemModifier(_event, _target) {
        this.item.templateSystem.configureModifiers();
    }
    static reloadItemSheet(_event, _target) {
        this.item.templateSystem.reloadAllSheets();
    }
    /**
     * Render the inner application content
     * @private
     * @override
     * @ignore
     */
    async _renderHTML(context, options) {
        if (this.item.templateSystem.isModified) {
            this.submit();
        }
        const html = $((await super._renderHTML(context, options)).form);
        // Append built sheet to html
        if (context.headerPanel)
            html.find('.custom-system-customHeader').append(context.headerPanel);
        return { form: html[0] };
    }
}
