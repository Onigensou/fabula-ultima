/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Formula from '../../formulas/Formula.js';
import Logger from '../../Logger.js';
import CustomItem from '../../documents/CustomItem.js';
import { AlphanumericPatternError } from '../../errors/ComponentValidationError.js';
/**
 * Abstract component class
 * @abstract
 */
export default class Component {
    /**
     * The value type of this component. This is used to display an input field in the Dynamic Table's templates
     * This should be 'none' | 'string' | 'number' | 'boolean'
     */
    static valueType = 'none';
    /**
     * Component key
     */
    _key;
    /**
     * Component address in template definition
     */
    _templateAddress;
    /**
     * Component column spanning
     */
    _colSpan;
    /**
     *  Component row spanning
     */
    _rowSpan;
    /**
     * Component css class
     */
    _cssClass;
    /**
     * Component minimum role to be visible
     */
    _role;
    /**
     * Component minimum role to be editable
     */
    _editRole;
    /**
     * Component minimum permission to be visible
     */
    _permission;
    /**
     * Component tooltip
     */
    _tooltip;
    /**
     * Component visibility formula
     */
    _visibilityFormula;
    /**
     * Composant parent
     * @type {Container}
     */
    _parent;
    /**
     * Should be true if the template version should show a wrapper, as is made for templates
     */
    static addWrapperOnTemplate = false;
    /**
     * Should be true if the component is draggable to be copied
     */
    static draggable = true;
    /**
     * Component constructor
     * @constructor
     * @param componentProps Component properties
     */
    constructor({ key, templateAddress, colSpan, rowSpan, cssClass = '', role = CONST.USER_ROLES.NONE, permission = CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, editRole = CONST.USER_ROLES.NONE, tooltip = '', visibilityFormula = '', parent }) {
        if (this.constructor === Component) {
            throw new TypeError('Abstract class "Component" cannot be instantiated directly');
        }
        this._key = key;
        this._templateAddress = templateAddress;
        this._colSpan = colSpan ?? 1;
        this._rowSpan = rowSpan ?? 1;
        this._cssClass = cssClass;
        this._role = role;
        this._permission = permission;
        this._editRole = editRole;
        this._tooltip = tooltip;
        this._visibilityFormula = visibilityFormula;
        this._parent = parent;
    }
    /**
     * Component key
     */
    get key() {
        return this._key;
    }
    /**
     * Component property key
     */
    get propertyKey() {
        return undefined;
    }
    /**
     * Component tooltip
     */
    get tooltip() {
        return this._tooltip;
    }
    /**
     * Component address in template, i.e. component path from entity.system object
     */
    get templateAddress() {
        return this._templateAddress;
    }
    /**
     * Component column spanning
     */
    get colSpan() {
        return this._colSpan;
    }
    /**
     *  Component row spanning
     */
    get rowSpan() {
        return this._rowSpan;
    }
    /**
     * Additional CSS class
     */
    get cssClass() {
        return this._cssClass;
    }
    /**
     * Component minimum role to be visible
     */
    get role() {
        return this._role;
    }
    /**
     * Component minimum role to be editable
     */
    get editRole() {
        return this._editRole;
    }
    /**
     * Component minimum permission to be visible
     */
    get permission() {
        return this._permission;
    }
    /**
     * Component raw visibility formula
     */
    get visibilityFormula() {
        return this._visibilityFormula;
    }
    /**
     * Component should have header on template mode
     * @returns {boolean}
     */
    get addWrapperOnTemplate() {
        return this.constructor.addWrapperOnTemplate;
    }
    /**
     * Component is draggable
     */
    get draggable() {
        return this.constructor.draggable;
    }
    /**
     * Returns component's parent
     */
    get parent() {
        return this._parent;
    }
    /**
     * Check if component can be rendered for the current user
     * @param entity The Template System used to render the component
     * @param options Options to compute the visibility formula
     * @returns `true` if the component can be rendered, `false` otherwise
     */
    canBeRendered(entity, options = {}) {
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            return true;
        }
        let canRender = game.user.role >= this.role && (entity.entity.permission ?? 0) >= this.permission;
        if (this.visibilityFormula) {
            const formula = new Formula(this.visibilityFormula);
            try {
                const formulaProps = {
                    ...entity.system?.props,
                    ...options.customProps
                };
                formula.computeStatic(formulaProps, {
                    ...options,
                    source: `${this.key}.visibilityFormula`,
                    triggerEntity: entity,
                    reference: options.reference
                });
                canRender = canRender && !!formula.result; // Cast to boolean
            }
            catch (_e) {
                canRender = false;
            }
        }
        return canRender;
    }
    /**
     * Handles the component rendering, including checking if component can be rendered.
     * This function should not be overriden, instead override the _getElement function to actually render your component.
     * @param entity Rendered entity (actor or item)
     * @param isEditable Is the component editable by the current user ?
     * @param options Additional options usable by the final Component
     * @return The jQuery element holding the component
     */
    async render(entity, isEditable = true, options = {}) {
        const canBeEdited = isEditable && game.user.role >= this.editRole;
        const element = await this._getElement(entity, canBeEdited, {
            ...options,
            customProps: {
                ...options.customProps,
                this: this.key && TemplateSystem.isAppliedTemplateSystem(entity)
                    ? foundry.utils.getProperty(entity.system.props, this.key)
                    : null
            }
        });
        return this.canBeRendered(entity, options) ? element : $('<div style="display: none"></div>').append(element);
    }
    /**
     * Actual function which renders the component.
     * @abstract
     * @param entity Rendered entity (actor or item)
     * @param _isEditable Is the component editable by the current user ?
     * @param options Additional options usable by the final Component
     * @return The jQuery element holding the component
     */
    async _getElement(entity, _isEditable = true, options = {}) {
        let jQElement = $('<div></div>');
        jQElement.addClass('custom-system-component-contents');
        jQElement.addClass(this.key ?? '');
        let cssClass = this.cssClass;
        if (cssClass && TemplateSystem.isAppliedTemplateSystem(entity)) {
            try {
                cssClass =
                    (await ComputablePhrase.computeMessage(cssClass, {
                        ...entity.system.props,
                        ...options.customProps
                    }, {
                        ...options,
                        source: `${this.key}.css`,
                        triggerEntity: entity,
                        reference: options.reference
                    })).result ?? 'ERROR';
            }
            catch (err) {
                Logger.error(err.message, err);
                cssClass = 'ERROR';
            }
        }
        jQElement.addClass(cssClass);
        if (this.tooltip) {
            let tooltipText = this.tooltip;
            if (TemplateSystem.isAppliedTemplateSystem(entity)) {
                try {
                    tooltipText =
                        (await ComputablePhrase.computeMessage(this.tooltip, {
                            ...entity.system.props,
                            ...options.customProps
                        }, {
                            ...options,
                            source: `${this.key}.tooltip`,
                            triggerEntity: entity,
                            reference: options.reference
                        })).result ?? 'ERROR';
                }
                catch (err) {
                    Logger.error(err.message, err);
                    tooltipText = 'ERROR';
                }
            }
            jQElement.attr('data-tooltip', tooltipText);
        }
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            if (this.templateAddress !== 'body' && this.templateAddress !== 'header') {
                let dragHandle = jQElement;
                if (this.addWrapperOnTemplate) {
                    const templateWrapper = $('<div></div>');
                    templateWrapper.addClass('custom-system-editable-panel');
                    templateWrapper.addClass(cssClass);
                    const panelTitle = $('<div></div>');
                    panelTitle.addClass('custom-system-editable-panel-title custom-system-editable-component');
                    if (this.key) {
                        panelTitle.addClass(`custom-system-edit-${this.key}`);
                    }
                    panelTitle.text(`${this.constructor.getPrettyName()}${this.key ? ` ${this.key}` : ''}`);
                    panelTitle.on('click', () => {
                        this.editComponent(entity);
                    });
                    templateWrapper.append(panelTitle);
                    templateWrapper.append(jQElement);
                    jQElement = templateWrapper;
                    dragHandle = panelTitle;
                }
                if (this.draggable) {
                    this._handleDragEvents(entity, jQElement, dragHandle);
                }
            }
        }
        jQElement.addClass('custom-system-component-root');
        jQElement.addClass(`grid-span-${this.colSpan}`);
        jQElement.addClass(`grid-row-span-${this.rowSpan}`);
        return jQElement;
    }
    /**
     * Go through the component to get every keyed component in a flat object
     * @returns A flat map of keyed components
     */
    getComponentMap() {
        const componentMap = {};
        if (this.key && this.key !== '') {
            componentMap[this.key] = this;
        }
        return componentMap;
    }
    /**
     * Handles drag & drop events for Components
     * @param entity Rendered entity (actor or item)
     * @param jQElement The JQuery element being dragged
     * @param dragHandle The JQuery element acting as the handle. This can be part of the jQElement or be the jQElement itself
     */
    _handleDragEvents(entity, jQElement, dragHandle) {
        dragHandle.attr('draggable', 'true');
        dragHandle.on('dragstart', (ev) => {
            if (ev.originalEvent) {
                ev.originalEvent.stopPropagation();
                if (ev.originalEvent.dataTransfer) {
                    ev.originalEvent.dataTransfer.effectAllowed = 'copyMove';
                    ev.originalEvent.dataTransfer.dropEffect = 'move';
                }
            }
            globalThis.copiedComponent = {
                sourceId: entity.uuid,
                component: this
            };
            setTimeout(() => {
                jQElement.hide();
            }, 0);
        });
        dragHandle.on('dragend', () => {
            $('.custom-system-drop-target').remove();
            entity.render(false);
        });
        if (this.parent?.constructor?.droppable) {
            dragHandle.on('dragover', (ev) => {
                this.dragOverComponent(entity, ev);
            });
            dragHandle.on('dragenter', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                $('.custom-system-drop-target').remove();
                const dropTarget = $('<div>Insert here</div>');
                dropTarget.addClass('custom-system-drop-target');
                dropTarget.on('dragover', (ev) => {
                    this.dragOverComponent(entity, ev);
                });
                dropTarget.on('dragleave', () => {
                    $('.custom-system-drop-target').remove();
                });
                dropTarget.on('drop', (event) => {
                    this.dropOnComponent(entity, event, this.parent, {
                        insertBefore: this
                    });
                });
                dropTarget.insertBefore(jQElement);
            });
            dragHandle.on('drop', (event) => {
                this.dropOnComponent(entity, event, this.parent, {
                    insertBefore: this
                });
            });
        }
    }
    /**
     * Handles component editor dialog
     * @param entity Template containing the component
     * @param additionalAttributes Additional attributes. Currently used for extensibleTables, like the column name
     * @param allowedComponents Allowed components to replace this component with
     */
    editComponent(entity, additionalAttributes, allowedComponents) {
        this.parent?.openComponentEditor(entity, { allowedComponents, additionalAttributes }, this);
    }
    /**
     * Saves component in database
     * @param entity Template containing the component
     */
    async save(entity) {
        await entity.saveTemplate();
    }
    /**
     * Updates component with the data from the edition popup
     * @param entity Template containing the component
     * @param data JSON data of the component to edit
     */
    async update(entity, data) {
        const newComponent = foundry.utils.mergeObject(this.toJSON(), data);
        this.parent.replaceComponent(this, newComponent);
        // After actions have been taken care of, save entity
        await this.save(entity);
    }
    /**
     * Deletes component
     * @param entity Template containing the component
     * @param triggerSave Whether to save the template after deletion or not
     */
    async delete(entity, triggerSave = true) {
        this.parent.deleteComponent(this);
        if (triggerSave) {
            await this.save(entity);
        }
    }
    /**
     * Sort after in the same container
     * @param entity Template containing the component
     */
    async sortAfterInParent(entity) {
        this.parent.sortComponentAfter(this);
        // After actions have been taken care of, save entity
        await this.save(entity);
    }
    /**
     * Sort before in the same container
     * @param entity Template containing the component
     */
    async sortBeforeInParent(entity) {
        this.parent.sortComponentBefore(this);
        // After actions have been taken care of, save entity
        await this.save(entity);
    }
    /**
     * Handles the dragover event
     * @param entity Template containing the component
     * @param event The DragEvent
     */
    async dragOverComponent(entity, event) {
        event.stopPropagation();
        event.preventDefault();
        const sourceId = globalThis.copiedComponent?.sourceId;
        if (event.originalEvent?.dataTransfer) {
            event.originalEvent.dataTransfer.dropEffect = event.ctrlKey || sourceId !== entity.uuid ? 'copy' : 'move';
        }
    }
    /**
     * Handles components and subtemplates drops on a component
     * @param entity Template containing the component
     * @param event The DropEvent
     * @param insertionTarget The target Container
     * @param insertionOptions Options to create the component
     */
    async dropOnComponent(entity, event, insertionTarget, insertionOptions) {
        event.stopPropagation();
        event.preventDefault();
        let dropData;
        try {
            dropData = JSON.parse(event.originalEvent.dataTransfer.getData('text/plain'));
        }
        catch (_e) {
            // Nothing should happen
        }
        if (dropData) {
            try {
                const item = await Item.fromDropData(dropData);
                if (CustomItem.isSubTemplate(item)) {
                    try {
                        await insertionTarget.addNewComponent(entity, item.system.body.contents ?? [], insertionOptions);
                    }
                    catch (e) {
                        ui.notifications.error(e.message);
                    }
                }
                else {
                    ui.notifications.error(game.i18n.localize('CSB.UserMessages.WrongDragOnTemplate'));
                }
            }
            catch (_e) {
                // Nothing should happen
            }
        }
        const droppedData = globalThis.copiedComponent;
        const sourceId = droppedData?.sourceId;
        const droppedComponent = droppedData?.component;
        if (droppedComponent) {
            let isMovement = false;
            if (sourceId === entity.uuid && !event.ctrlKey && !event.metaKey) {
                await droppedComponent.delete(entity, false);
                isMovement = true;
            }
            try {
                await insertionTarget.addNewComponent(entity, droppedComponent.toJSON(), insertionOptions, isMovement);
                globalThis.copiedComponent = null;
            }
            catch (e) {
                ui.notifications.error(e.message);
            }
        }
    }
    recalculateAddresses(newAddress) {
        this._templateAddress = newAddress;
    }
    getSluggedId(entity) {
        return `${entity.uuid}-${this.key}`.replace(/[. #]/g, '-');
    }
    /**
     * Returns serialized component
     * Should be overridden by each Component subclass
     * @returns The JSONified component
     */
    toJSON() {
        return {
            key: this._key,
            colSpan: this.colSpan,
            rowSpan: this.rowSpan,
            cssClass: this.cssClass,
            role: this.role,
            editRole: this.editRole,
            permission: this.permission,
            tooltip: this.tooltip,
            visibilityFormula: this.visibilityFormula,
            type: this.constructor.getTechnicalName()
        };
    }
    /**
     * Creates a new component from a JSON description
     * Should be implemented by each Component subclass
     * @abstract
     * @throws {Error} If not implemented
     * @returns The new Component
     */
    static fromJSON(_json, _templateAddress, _parent = null) {
        throw new Error('You must implement this function');
    }
    /**
     * Gets technical name for this component's type
     * @return The technical name
     * @throws {Error} If not implemented
     */
    static getTechnicalName() {
        // V13 DEPRECATION WARNING
        Logger.warn(`static getTechnicalName was not implemented for Component Type ${this.constructor.name}. This will be mandatory for v5.0.0, with the Foundry 13 compatibility.`);
        return 'component';
    }
    /**
     * Gets pretty name for this component's type
     * Should be implemented by each Component subclass
     * @abstract
     * @throws {Error} If not implemented
     * @returns A pretty name for the component
     */
    static getPrettyName() {
        throw new Error(`Function not implemented : static getPrettyName(): string (in ${this.constructor.name}`);
    }
    /**
     * Get configuration form for component creation / edition
     * Should be implemented by each Component subclass
     * @abstract
     * @throws {Error} If not implemented
     * @returns A JQuery Element containing the form
     */
    static async getConfigForm(_entity, _appId, _existingComponent) {
        throw new Error('You must implement this function');
    }
    /**
     * Extracts configuration from submitted HTML form after Component Configuration dialog validation
     * Should be overridden by each Component subclass
     * @abstract
     * @param configData
     * @param _html The submitted HTML-form
     * @throws {ComponentValidationError} If configuration contains validation errors
     * @returns The JSON version of the new Component configuration
     */
    static extractConfig(configData, _html) {
        const componentConfigData = configData;
        return {
            type: componentConfigData.type,
            key: componentConfigData.key,
            colSpan: componentConfigData.colSpan,
            rowSpan: componentConfigData.rowSpan,
            cssClass: componentConfigData.cssClass,
            permission: parseInt(componentConfigData.permission ?? '0'),
            role: parseInt(componentConfigData.role ?? '0'),
            editRole: parseInt(componentConfigData.editRole ?? '0'),
            tooltip: componentConfigData.tooltip,
            visibilityFormula: componentConfigData.visibilityFormula,
            extraConf: componentConfigData.extraConf
        };
    }
    /**
     * Validates if the passed JSON-Object meets all criteria for Component creation.
     * Can be overridden by each Component's subclass.
     * @param json The new Component's JSON
     * @throws {ComponentValidationError} If configuration contains validation errors
     */
    static validateConfig(json) {
        if (json.key && !json.key.match(/^[a-zA-Z0-9_]+$/)) {
            throw new AlphanumericPatternError(game.i18n.localize('CSB.ComponentProperties.ComponentKey'), json);
        }
    }
}
