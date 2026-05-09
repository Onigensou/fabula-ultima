/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Component from './Component.js';
import InputComponent from './InputComponent.js';
import { updateKeysOnCopy } from '../../utils.js';
import ComponentSettingsApplication from '../../applications/ComponentSettingsApplication.js';
/**
 * Abstract container class
 * @abstract
 */
class Container extends Component {
    /**
     * Container contents
     */
    _contents;
    /**
     * @inheritdoc
     */
    static addWrapperOnTemplate = true;
    /**
     * Can container accept dropped components ?
     */
    static droppable = true;
    /**
     * Constructor
     */
    constructor(props) {
        super(props);
        if (this.constructor === Container) {
            throw new TypeError('Abstract class "Container" cannot be instantiated directly');
        }
        this._contents = props.contents ?? [];
    }
    /**
     * Container contents
     */
    get contents() {
        return this._contents;
    }
    /**
     * Renders contents component
     * @param entity Rendered entity (actor or item)
     * @param isEditable Is the component editable by the current user ?
     * @param options Additional options usable by the final Component
     * @return The jQuery elements holding the components
     */
    async renderContents(entity, isEditable = true, options) {
        const jqElts = [];
        for (const component of this._contents) {
            jqElts.push(await component.render(entity, isEditable, options));
        }
        return jqElts;
    }
    /**
     * Renders template controls
     * @param entity Rendered entity (actor or item)
     * @param options Component adding options
     * @return The jQuery element holding the component
     */
    async renderTemplateControls(entity, options = {}) {
        const containerControls = $('<div></div>');
        containerControls.addClass('custom-system-template-tab-controls');
        if (this.constructor.droppable) {
            containerControls.addClass('custom-system-droppable-container');
            containerControls
                .on('dragenter', (event) => {
                event.stopPropagation();
                event.preventDefault();
                $('.custom-system-drop-target').remove();
                containerControls.addClass('custom-system-template-dragged-over');
            })
                .on('dragover', (event) => {
                event.stopPropagation();
                event.preventDefault();
                const sourceId = globalThis.copiedComponent?.sourceId;
                if (event.originalEvent?.dataTransfer) {
                    if (event.ctrlKey || sourceId !== entity.uuid) {
                        event.originalEvent.dataTransfer.dropEffect = 'copy';
                    }
                    else {
                        event.originalEvent.dataTransfer.dropEffect = 'move';
                    }
                }
            })
                .on('dragleave', (_event) => {
                containerControls.removeClass('custom-system-template-dragged-over');
            })
                .on('drop', async (event) => {
                await this.dropOnComponent(entity, event, this, options);
            });
        }
        const addElement = $('<a></a>');
        addElement.addClass('item custom-system-template-tab-controls-add-element');
        addElement.attr('title', game.i18n.localize('CSB.TemplateActions.AddNewElement'));
        addElement.append('<i class="fas fa-plus-circle custom-system-clickable custom-system-add-component"></i>');
        addElement.on('click', () => {
            this.openComponentEditor(entity, options);
        });
        containerControls.append(addElement);
        return containerControls;
    }
    /**
     * Opens component editor
     * @param entity Rendered entity (actor or item)
     * @param options Component options
     * @param component
     */
    async openComponentEditor(entity, options = {}, component) {
        let allowedComponents = options.allowedComponents;
        if (allowedComponents) {
            allowedComponents = allowedComponents.filter((value) => entity.allowedComponents.includes(value));
        }
        else {
            allowedComponents = entity.allowedComponents;
        }
        return new ComponentSettingsApplication(entity, this, { component, allowedComponents, options }).render({
            force: true
        });
    }
    /**
     * Adds new component to container
     * @param entity Rendered entity (actor or item)
     * @param component JSONified new component
     * @param options Component options
     * @param isMovement Is the new component a moved component (Drag&Drop)
     */
    async addNewComponent(entity, component, options = {}, isMovement = false) {
        if (!Array.isArray(component)) {
            component = [component];
        }
        if (!isMovement) {
            component = updateKeysOnCopy(component, entity.getKeys());
        }
        let splittingPoint = this._contents.length;
        if (options.insertBefore) {
            const index = this._contents.indexOf(options.insertBefore);
            if (index > -1) {
                splittingPoint = index;
            }
        }
        const firstSlice = this._contents.slice(0, splittingPoint);
        const lastSlice = this._contents.slice(splittingPoint, this._contents.length);
        // Add component
        this._contents = firstSlice
            .concat(componentFactory.createMultipleComponents(component, undefined, this))
            .concat(lastSlice);
        this.recalculateAddresses(this.templateAddress);
        await this.save(entity);
    }
    /**
     * Deletes component in the current Container. Does not save the template afterwards.
     * @param component The component to delete
     */
    deleteComponent(component) {
        this._contents = this._contents.filter((elt) => elt !== component);
        this.recalculateAddresses(this.templateAddress);
    }
    /**
     * Replaces component in the current Container. Does not save the template afterwards.
     * @param oldComponent The component to be replaced
     * @param newComponent The component to replace with (Can be a Component Instance or a JSONified Component)
     */
    replaceComponent(oldComponent, newComponent) {
        const componentIndex = this._contents.indexOf(oldComponent);
        if (!(newComponent instanceof Component)) {
            newComponent = componentFactory.createOneComponent(newComponent, oldComponent.templateAddress, this);
        }
        this._contents[componentIndex] = newComponent;
    }
    /**
     * Sorts component after in the current Container. Does not save the template afterwards.
     * @param component The component to sort
     */
    sortComponentAfter(component) {
        const componentIndex = this._contents.indexOf(component);
        if (componentIndex < this._contents.length - 1 && componentIndex > -1) {
            this._contents[componentIndex] = this._contents[componentIndex + 1];
            this._contents[componentIndex + 1] = component;
        }
        this.recalculateAddresses(this.templateAddress);
    }
    /**
     * Sorts component before in the current Container. Does not save the template afterwards.
     * @param component The component to sort
     */
    sortComponentBefore(component) {
        const componentIndex = this._contents.indexOf(component);
        if (componentIndex > 0) {
            this._contents[componentIndex] = this._contents[componentIndex - 1];
            this._contents[componentIndex - 1] = component;
        }
        this.recalculateAddresses(this.templateAddress);
    }
    /**
     * Go through the contents to get every keyed component in a flat object
     * @override
     */
    getComponentMap() {
        const componentMap = super.getComponentMap();
        for (const component of this.contents) {
            foundry.utils.mergeObject(componentMap, component.getComponentMap());
        }
        return componentMap;
    }
    /**
     * Returns an object of all the component's keys in the Container and their default value
     * @param entity The entity containing the Container
     * @returns The record of all the component's default value
     */
    getAllProperties(entity) {
        let properties = {};
        if (this.propertyKey) {
            properties[this.propertyKey] = undefined;
        }
        for (const component of this.contents) {
            if (component instanceof Container) {
                properties = {
                    ...properties,
                    ...component.getAllProperties(entity)
                };
            }
            else {
                if (component.propertyKey) {
                    if (component instanceof InputComponent) {
                        properties = {
                            ...properties,
                            [component.propertyKey]: component.defaultValue && TemplateSystem.isAppliedTemplateSystem(entity)
                                ? ComputablePhrase.computeMessageStatic(component.defaultValue, entity.system.props, {
                                    source: `${this.key}.${component.propertyKey}.defaultValue`,
                                    defaultValue: '',
                                    triggerEntity: entity
                                }).result
                                : undefined
                        };
                    }
                    else {
                        properties[component.propertyKey] = undefined;
                    }
                }
            }
        }
        return properties;
    }
    recalculateAddresses(newAddress) {
        super.recalculateAddresses(newAddress);
        this.contents.forEach((component, index) => {
            component.recalculateAddresses(this.templateAddress + '-contents-' + index);
        });
    }
    /**
     * Returns serialized component
     * @override
     */
    toJSON() {
        const jsonObj = super.toJSON();
        const contentsJSON = [];
        for (const component of this.contents) {
            // Handling Tables, which handle their contents themselves
            if (component instanceof Component) {
                contentsJSON.push(component.toJSON());
            }
        }
        return {
            ...jsonObj,
            contents: contentsJSON
        };
    }
}
/**
 * @ignore
 */
export default Container;
