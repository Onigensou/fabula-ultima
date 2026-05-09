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
import Container from './Container.js';
/**
 * @ignore
 */
class Tab extends Container {
    /** Tab name */
    _name;
    static addWrapperOnTemplate = false;
    static draggable = false;
    /** Tab constructor */
    constructor(props) {
        super(props);
        this._name = props.name;
    }
    get name() {
        return this._name;
    }
    get key() {
        return this._key;
    }
    /**
     * Renders component
     * @override
     * @param {TemplateSystem} entity Rendered entity (actor or item)
     * @param {boolean} [isEditable=true] Is the component editable by the current user?
     * @param {ComponentRenderOptions} [options={}]
     * @return {Promise<jQuery>} The jQuery element holding the component
     */
    async _getElement(entity, isEditable = true, options = {}) {
        const jQElement = await super._getElement(entity, isEditable, options);
        jQElement.addClass('tab');
        jQElement.attr('data-tab', this.key);
        jQElement.attr('data-group', 'primary');
        const mainPanelElement = $('<div></div>');
        mainPanelElement.addClass('flexcol flex-group-center');
        mainPanelElement.append(await this.renderContents(entity, isEditable, options));
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            mainPanelElement.append(await this.renderTemplateControls(entity));
        }
        jQElement.append(mainPanelElement);
        return jQElement;
    }
    /**
     * Edits component
     * @param {TemplateSystem} entity Rendered entity (actor or item)
     * @param {Partial<TabJson>} data Diff data
     */
    async update(entity, data) {
        const newComponentJSON = foundry.utils.mergeObject(this.toJSON(), data);
        const newComponent = Tab.fromJSON(newComponentJSON, this.templateAddress, this.parent);
        this.parent.replaceComponent(this, newComponent);
        // After actions have been taken care of, save entity
        await this.save(entity);
    }
    /**
     * @inheritdoc
     */
    getComponentMap() {
        const componentMap = {};
        for (const component of this.contents) {
            foundry.utils.mergeObject(componentMap, component.getComponentMap());
        }
        return componentMap;
    }
    /** Returns serialized component */
    toJSON() {
        const jsonObj = super.toJSON();
        return {
            ...jsonObj,
            name: this.name
        };
    }
    /** Creates Tab from JSON description */
    static fromJSON(json, templateAddress, parent) {
        const tab = new Tab({
            ...json,
            contents: [],
            parent: parent,
            templateAddress: templateAddress
        });
        tab._contents = componentFactory.createMultipleComponents(json.contents, templateAddress + '-contents', tab);
        return tab;
    }
    /**
     * Gets technical name for this component's type
     * @return The technical name
     * @throws {Error} If not implemented
     */
    static getTechnicalName() {
        return 'tab';
    }
    /**
     * Gets pretty name for this component's type
     * @returns The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.Tab');
    }
}
/**
 * @ignore
 */
export default Tab;
