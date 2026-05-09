/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { mathjsBlacklist } from '../formulas/Formula.js';
import Logger from '../Logger.js';
import Tab from '../sheets/components/Tab.js';
import { getLocalizedPermissionList, getLocalizedRoleList } from '../utils.js';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
export default class TabEditorDialog extends HandlebarsApplicationMixin((ApplicationV2)) {
    tabbedPanel;
    entity;
    tab;
    static DEFAULT_OPTIONS = {
        tag: 'form',
        form: {
            handler: TabEditorDialog.saveHandler,
            submitOnChange: false,
            closeOnSubmit: false
        },
        actions: {
            cancel: TabEditorDialog.cancel
        },
        window: {
            title: 'CSB.ComponentProperties.Tab.Dialog.TitleCreate',
            icon: 'fas fa-folder-closed',
            resizable: false,
            minimizable: true,
            contentClasses: ['standard-form']
        },
        position: {
            width: 'auto',
            height: 'auto'
        },
        classes: ['custom-system-editTab']
    };
    static PARTS = {
        form: {
            get template() {
                return `systems/${game.system.id}/templates/_template/dialogs/edit-tab.hbs`;
            }
        },
        footer: {
            template: 'templates/generic/form-footer.hbs'
        }
    };
    static async saveHandler(_event, _form, formData) {
        const tabData = {
            name: formData.get('name')?.toString(),
            key: formData.get('key')?.toString(),
            tooltip: formData.get('tooltip')?.toString(),
            role: Number(formData.get('role')?.toString()),
            permission: Number(formData.get('permission')?.toString()),
            visibilityFormula: formData.get('visibilityFormula')?.toString()
        };
        if (!tabData.name || !tabData.key) {
            ui.notifications.error(game.i18n.localize('CSB.ComponentProperties.Tab.Dialog.MissingData'));
            Logger.error(game.i18n.localize('CSB.ComponentProperties.Tab.Dialog.MissingData'), tabData);
            return;
        }
        // Checking for duplicate keys
        const existingTab = this.tabbedPanel.contents.filter((tab) => tab.key === tabData.key && tabData.key !== this.tab?.key);
        if (existingTab.length > 0) {
            ui.notifications.error(game.i18n.format('CSB.UserMessages.TabbedPanel.DuplicateTabKey', { KEY: tabData.key }));
            Logger.error(game.i18n.format('CSB.UserMessages.TabbedPanel.DuplicateTabKey', { KEY: tabData.key }), tabData);
            return;
        }
        Logger.debug(`Saving tab`, tabData);
        if (this.tab) {
            this.tab.update(this.entity, {
                name: tabData.name,
                key: tabData.key,
                role: tabData.role,
                permission: tabData.permission,
                visibilityFormula: tabData.visibilityFormula,
                tooltip: tabData.tooltip
            });
        }
        else {
            this.tabbedPanel.contents.push(Tab.fromJSON({
                name: tabData.name,
                key: tabData.key,
                cssClass: '',
                role: tabData.role,
                permission: tabData.permission,
                visibilityFormula: tabData.visibilityFormula,
                tooltip: tabData.tooltip,
                type: 'tabbedPanel',
                contents: []
            }, this.tabbedPanel.templateAddress + '-contents-' + this.tabbedPanel.contents.length, this.tabbedPanel));
            this.tabbedPanel.save(this.entity);
        }
        this.close();
    }
    static async cancel(_event, _target) {
        this.close();
    }
    constructor(tabbedPanel, entity, tab) {
        super();
        this.tabbedPanel = tabbedPanel;
        this.entity = entity;
        this.tab = tab;
    }
    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        context.PERMISSION_LIST = getLocalizedPermissionList('number');
        context.ROLE_LIST = getLocalizedRoleList('number');
        if (this.tab) {
            context.name = this.tab.name;
            context.key = this.tab.key;
            context.tooltip = this.tab.tooltip;
            context.role = this.tab.role;
            context.permission = this.tab.permission;
            context.visibilityFormula = this.tab.visibilityFormula;
        }
        else {
            context.name = '';
            context.key = '';
            context.tooltip = '';
            context.role = CONST.USER_ROLES.NONE;
            context.permission = CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
            context.visibilityFormula = '';
        }
        context.buttons = [
            { type: 'submit', icon: 'fa-solid fa-save', label: 'Save' },
            { type: 'button', action: 'cancel', icon: 'fa-solid fa-xmark', label: 'Cancel' }
        ];
        return context;
    }
    _onRender(context, options) {
        super._onRender(context, options);
        this.element.querySelector('[name="key"]')?.addEventListener('change', (event) => {
            const keyInput = event.currentTarget;
            const warningDiv = this.element.querySelector('.custom-system-key-warning');
            if (mathjsBlacklist.has(keyInput.value)) {
                warningDiv.style.display = 'block';
            }
            else {
                warningDiv.style.display = 'none';
            }
        });
    }
}
