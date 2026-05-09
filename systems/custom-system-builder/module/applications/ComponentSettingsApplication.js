/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { getLocalizedAlignmentList, getLocalizedPermissionList, getLocalizedRoleList } from '../utils.js';
import { mathjsBlacklist } from '../formulas/Formula.js';
import { NotUniqueError } from '../errors/ComponentValidationError.js';
import Logger from '../Logger.js';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
/**
 * @ignore
 * @module
 */
export default class ComponentSettingsApplication extends HandlebarsApplicationMixin((ApplicationV2)) {
    entity;
    parentComponent;
    static DEFAULT_OPTIONS = {
        tag: 'form',
        form: {
            handler: ComponentSettingsApplication.saveHandler,
            submitOnChange: false,
            closeOnSubmit: false
        },
        actions: {
            cancel: ComponentSettingsApplication.cancel,
            delete: ComponentSettingsApplication.delete
        },
        window: {
            title: 'CSB.ComponentProperties.ComponentDialog.Edit.Title',
            icon: 'fas fa-puzzle',
            resizable: true,
            minimizable: true,
            contentClasses: ['standard-form']
        },
        position: {
            width: 560,
            height: 'auto'
        },
        classes: ['custom-system-componentSettings custom-system-list-dialog']
    };
    static PARTS = {
        form: {
            get template() {
                return `systems/${game.system.id}/templates/_template/dialogs/componentSettings.hbs`;
            }
        },
        footer: {
            template: 'templates/generic/form-footer.hbs'
        }
    };
    static async saveHandler(_event, form, formData) {
        const configData = foundry.utils.expandObject(formData.object);
        const newCompType = configData.type;
        if (newCompType) {
            const componentClass = componentFactory.getComponentClass(newCompType);
            const fieldData = componentClass.extractConfig(configData, form);
            try {
                componentClass.validateConfig(fieldData);
                if (fieldData.key &&
                    fieldData.key !== this.component?.key &&
                    this.entity.getKeys().has(fieldData.key)) {
                    throw new NotUniqueError(game.i18n.localize('CSB.ComponentProperties.ComponentKey'), fieldData);
                }
                if (this.component) {
                    this.component.update(this.entity, fieldData);
                }
                else {
                    await this.parentComponent.addNewComponent(this.entity, fieldData, this.componentOptions);
                }
                this.close();
            }
            catch (err) {
                Logger.error(err.message, err);
                ui.notifications.error(err.message);
            }
        }
    }
    static async cancel(_event, _target) {
        this.close();
    }
    static async delete(_event, _target) {
        const shouldDelete = await foundry.applications.api.DialogV2.confirm({
            content: `<p>${game.i18n.localize('CSB.ComponentProperties.ComponentDialog.Delete.Content')}</p>`,
            rejectClose: false,
            modal: true
        });
        if (shouldDelete) {
            this.component?.delete(this.entity, true);
        }
        this.close();
    }
    component;
    allowedComponents;
    componentOptions;
    additionalConfigElements;
    additionalAttributes;
    constructor(entity, parentComponent, props) {
        super();
        this.entity = entity;
        this.parentComponent = parentComponent;
        this.component = props?.component;
        this.allowedComponents = props?.allowedComponents ?? [];
        this.componentOptions = props?.options;
        this.additionalConfigElements = props?.additionalConfigElements ?? [];
        this.additionalAttributes = props?.additionalAttributes ?? {};
    }
    addAdditionalConfigElement(element) {
        this.additionalConfigElements.push(element);
    }
    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        context.appId = this.id;
        const componentData = this.component
            ? foundry.utils.mergeObject(this.component?.toJSON(), this.additionalAttributes)
            : undefined;
        context.component = componentData ?? {};
        context.PERMISSION_LIST = getLocalizedPermissionList('number');
        context.ROLE_LIST = getLocalizedRoleList('number');
        context.ALIGNMENT_LIST = getLocalizedAlignmentList();
        context.additionalSections = this.additionalConfigElements ?? [];
        context.componentSections = {};
        context.componentList = [];
        // Component settings
        for (const componentType of componentFactory.componentTypes) {
            if (this.allowedComponents.length === 0 || this.allowedComponents.includes(componentType)) {
                const componentClass = componentFactory.getComponentClass(componentType);
                const componentDiv = document.createElement('div');
                componentDiv.classList = `custom-system-component-editor custom-system-${componentType}-editor`;
                componentDiv.append(await componentClass.getConfigForm(this.entity, this.id, componentData));
                context.componentSections[componentType] = componentDiv;
                context.componentList.push({ key: componentType, label: componentClass.getPrettyName() });
            }
        }
        // Buttons
        context.buttons = [{ type: 'submit', icon: 'fa-solid fa-save', label: 'Save' }];
        if (this.component) {
            context.buttons.push({ type: 'button', action: 'delete', icon: 'fa-solid fa-trash', label: 'Delete' });
        }
        context.buttons.push({ type: 'button', action: 'cancel', icon: 'fa-solid fa-xmark', label: 'Cancel' });
        return context;
    }
    /**
     * Actions performed after any render of the Application.
     * Post-render steps are not awaited by the render process.
     */
    _onRender(context, options) {
        super._onRender(context, options);
        const mainDiv = this.element.querySelector('.custom-system-component-editor-dialog');
        context.additionalSections.forEach((section) => {
            mainDiv?.append(section);
        });
        let currentType = context.component.type ?? context.componentList[0].key;
        const initialSection = context.componentSections[currentType];
        mainDiv?.appendChild(initialSection);
        initialSection.style.display = 'block';
        const typeSelect = mainDiv.querySelector('select.compType');
        const keyInput = mainDiv.querySelector('input.compKey');
        // Change displayed fields based on previous and new types
        function changeDisplayedControls(ev) {
            const target = ev.currentTarget;
            const newType = target.value;
            // Hide previous type's fields
            $(context.componentSections[currentType]).slideUp(200, () => {
                context.componentSections[currentType].remove();
                currentType = newType;
            });
            const newSection = context.componentSections[newType];
            // Show new type's fields
            mainDiv.append(newSection);
            $(newSection).slideDown(200);
        }
        typeSelect?.addEventListener('change', changeDisplayedControls);
        function checkComponentKey() {
            const val = keyInput?.value;
            if (val && val.match(/^[a-zA-Z0-9_]+$/)) {
                if (mathjsBlacklist.has(val)) {
                    $(mainDiv).find('.custom-system-key-warning').show();
                }
                else {
                    try {
                        // @ts-expect-error Global var
                        math.parse(val);
                        // @ts-expect-error Global var
                        math.evaluate(val);
                        $(mainDiv).find('.custom-system-key-warning').show();
                    }
                    catch (_err) {
                        $(mainDiv).find('.custom-system-key-warning').hide();
                    }
                }
            }
            else {
                $(mainDiv).find('.custom-system-key-warning').hide();
            }
        }
        keyInput?.addEventListener('change', checkComponentKey);
        checkComponentKey();
        // this.setPosition({ top: 0 });
    }
}
