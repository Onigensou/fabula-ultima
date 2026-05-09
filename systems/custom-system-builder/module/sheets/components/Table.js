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
import Label from './Label.js';
import Container from './Container.js';
import { updateKeysOnCopy } from '../../utils.js';
import { NotGreaterThanZeroError } from '../../errors/ComponentValidationError.js';
import ComponentSettingsApplication from '../../applications/ComponentSettingsApplication.js';
/**
 * Table component
 * @ignore
 */
class Table extends Container {
    /**
     * Column count
     * @type {Number}
     * @private
     */
    _cols;
    /**
     * Row count
     * @type {Number}
     * @private
     */
    _rows;
    /**
     * Table layout
     * @type {string|null}
     * @private
     */
    _layout;
    /**
     * Table contents
     * @override
     * @type {Array<Array<Component>>}
     * @private
     */
    _contents;
    /**
     * Constructor
     * @param {Object} data Component data
     * @param {string} data.key Component key
     * @param {string|null} [data.tooltip] Component tooltip
     * @param {string} data.templateAddress Component address in template, i.e. component path from entity.system object
     * @param {Number} [data.cols=1] Column count
     * @param {Number} [data.rows=1] Row count
     * @param {string|null} [data.layout=null] Table layout
     * @param {Array<Array<Component>>} [data.contents=[]] Container contents
     * @param {string|null} [data.cssClass=null] Additional CSS class to apply at render
     * @param {Number} [data.role=0] Component minimum role
     * @param {Number} [data.permission=0] Component minimum permission
     * @param {string|null} [data.visibilityFormula=null] Component visibility formula
     * @param {Container|null} [data.parent=null] Component's container
     */
    constructor({ key, tooltip = null, templateAddress, cols = 1, rows = 1, layout = null, contents = [], cssClass = null, role = 0, permission = 0, visibilityFormula = null, parent = null }) {
        super({
            key: key,
            tooltip: tooltip,
            templateAddress: templateAddress,
            contents: [],
            cssClass: cssClass,
            role: role,
            permission: permission,
            visibilityFormula: visibilityFormula,
            parent: parent
        });
        this._cols = cols;
        this._rows = rows;
        this._layout = layout;
        this._contents = contents;
    }
    /**
     * contents getter
     * @override
     * @return {Array<Array<Component>>}
     */
    get contents() {
        return this._contents;
    }
    /**
     * Renders component
     * @override
     * @param {TemplateSystem} entity Rendered entity (actor or item)
     * @param {boolean} [isEditable=true] Is the component editable by the current user?
     * @param {ComponentRenderOptions} [options={}]
     * @return {Promise<JQuery>} The jQuery element holding the component
     */
    async _getElement(entity, isEditable = true, options = {}) {
        let baseElement = await super._getElement(entity, isEditable, options);
        let internalContents = baseElement.hasClass('custom-system-component-contents')
            ? baseElement
            : baseElement.find('.custom-system-component-contents');
        let jQElement = $('<table></table>');
        let tableBody = $('<tbody></tbody>');
        const ignoreCells = [];
        for (let rowNum = 0; rowNum < this._rows; rowNum++) {
            let tableRow = $('<tr></tr>');
            for (let colNum = 0; colNum < this._cols; colNum++) {
                if (ignoreCells.includes(`${rowNum}-${colNum}`)) {
                    continue;
                }
                let cellAlignment = this._layout ? this._layout.substr(colNum, 1) : 'l';
                let cellClass;
                switch (cellAlignment) {
                    case 'c':
                        cellClass = 'custom-system-cell-alignCenter';
                        break;
                    case 'r':
                        cellClass = 'custom-system-cell-alignRight';
                        break;
                    case 'l':
                    default:
                        cellClass = 'custom-system-cell-alignLeft';
                        break;
                }
                let cell = $('<td></td>');
                cell.addClass(cellClass);
                cell.addClass('custom-system-cell');
                const component = this.contents?.[rowNum]?.[colNum];
                if (component) {
                    cell.append(await component.render(entity, isEditable, options));
                    cell.attr('colspan', component.colSpan);
                    cell.attr('rowspan', component.rowSpan);
                    for (let rowSpan = rowNum; rowSpan <= rowNum + component.rowSpan - 1; rowSpan++) {
                        for (let colSpan = colNum; colSpan <= colNum + component.colSpan - 1; colSpan++) {
                            ignoreCells.push(`${rowSpan}-${colSpan}`);
                        }
                    }
                }
                else {
                    if (TemplateSystem.isBuilderTemplateSystem(entity)) {
                        cell.append(await this.renderTemplateControls(entity, { rowNum, colNum }));
                    }
                    else {
                        cell.append(await new Label({
                            key: null,
                            icon: null,
                            value: '',
                            rollMessage: null,
                            style: null,
                            size: 'full-size'
                        }).render(entity));
                    }
                }
                tableRow.append(cell);
            }
            tableBody.append(tableRow);
        }
        jQElement.append(tableBody);
        internalContents.append(jQElement);
        return baseElement;
    }
    /**
     * Opens component editor
     * @param {TemplateSystem} entity Rendered entity (actor or item)
     * @param {Object} options Component options
     * @param {Number} options.rowNum New component's row number
     * @param {Number} options.colNum New component's col number
     * @param {Component?} component Existing component
     */
    async openComponentEditor(entity, { rowNum, colNum, allowedComponents }, component) {
        if (allowedComponents) {
            allowedComponents = allowedComponents.filter((value) => entity.allowedComponents.includes(value));
        }
        else {
            allowedComponents = entity.allowedComponents;
        }
        new ComponentSettingsApplication(entity, this, {
            component,
            allowedComponents,
            options: { rowNum, colNum }
        }).render({
            force: true
        });
    }
    /**
     * Adds new component to container, handling rowLayout
     * @override
     * @param {TemplateSystem} entity Rendered entity (actor or item)
     * @param {Object|Array<Object>} components
     * @param {Object} options Component data
     * @param {Number} [options.rowNum] New component's row number
     * @param {Number} [options.colNum] New component's col number
     * @param {Component} [options.insertBefore] Insert new component before this one. Default behaviour is to insert last.
     * @param isMovement
     */
    async addNewComponent(entity, components, { rowNum, colNum, insertBefore }, isMovement = false) {
        // Add component
        if ((rowNum !== undefined && colNum === undefined) || (rowNum === undefined && colNum !== undefined)) {
            throw new Error('Adding to a table should be done by specifying both rowNum and colNum if one is specified.');
        }
        else if (insertBefore) {
            for (let i = 0; i < this.contents.length; i++) {
                for (let j = 0; j < this.contents[i].length; j++) {
                    if (this.contents[i][j] === insertBefore) {
                        rowNum = i;
                        colNum = j;
                    }
                }
            }
        }
        if (rowNum === undefined && colNum === undefined) {
            throw new Error('Could not find position to add element.');
        }
        else {
            if (!this._contents[rowNum]) {
                this._contents[rowNum] = [];
            }
        }
        if (!Array.isArray(components)) {
            components = [components];
        }
        if (!isMovement) {
            components = updateKeysOnCopy(components, entity.getKeys());
        }
        let componentToAdd;
        if (this._contents[rowNum][colNum]) {
            componentToAdd = {
                type: 'panel',
                contents: [...components, this._contents[rowNum][colNum].toJSON()]
            };
        }
        else if (components.length > 1) {
            componentToAdd = {
                type: 'panel',
                contents: components
            };
        }
        else {
            componentToAdd = components[0];
        }
        this._contents[rowNum][colNum] = componentFactory.createOneComponent(componentToAdd, undefined, this);
        this.recalculateAddresses(this.templateAddress);
        await this.save(entity);
    }
    deleteComponent(component) {
        this._contents = this._contents.map((row) => {
            let idx = row.indexOf(component);
            if (idx !== -1) {
                row[idx] = null;
            }
            return row;
        });
    }
    replaceComponent(oldComponent, newComponent) {
        for (let i = 0; i < this._contents.length; i++) {
            for (let j = 0; j < this._contents[i].length; j++) {
                if (this._contents[i][j] === oldComponent) {
                    this._contents[i][j] = componentFactory.createOneComponent(newComponent, oldComponent.templateAddress, this);
                    return;
                }
            }
        }
    }
    /**
     * Returns an object of all the component's keys in the Container and their default value
     * @param {TemplateSystem} entity The entity containing the Container
     * @returns {Object}
     */
    getAllProperties(entity) {
        let properties = { [this.propertyKey]: undefined };
        for (let row of this.contents) {
            if (row) {
                for (let component of row) {
                    if (component) {
                        if (component instanceof Container) {
                            properties = {
                                ...properties,
                                ...component.getAllProperties(entity)
                            };
                        }
                        else {
                            properties = {
                                ...properties,
                                [component.propertyKey]: component.defaultValue
                                    ? ComputablePhrase.computeMessageStatic(component.defaultValue, entity.system.props, {
                                        source: `${this.key}.${component.propertyKey}.defaultValue`,
                                        defaultValue: '',
                                        triggerEntity: entity
                                    }).result
                                    : undefined
                            };
                        }
                    }
                }
            }
        }
        return properties;
    }
    getAllKeys() {
        let keys = [this.key];
        for (let row of this.contents) {
            if (row) {
                for (let component of row) {
                    if (component) {
                        if (component instanceof Container) {
                            keys = keys.concat(component.getAllKeys());
                        }
                        else {
                            keys.push(component.key);
                        }
                    }
                }
            }
        }
        return keys;
    }
    /**
     * @inheritdoc
     */
    getComponentMap() {
        const componentMap /*: Record<string, Component>*/ = {};
        if (this.key) {
            componentMap[this.key] = this;
        }
        for (let row of this.contents) {
            if (row) {
                for (let component of row) {
                    if (component) {
                        foundry.utils.mergeObject(componentMap, component.getComponentMap());
                    }
                }
            }
        }
        return componentMap;
    }
    recalculateAddresses(newAddress) {
        this._templateAddress = newAddress;
        this.contents.forEach((row, rowIdx) => {
            row.forEach((component, colIdx) => {
                if (component) {
                    component.recalculateAddresses(`${this.templateAddress}-contents-${rowIdx}-${colIdx}`);
                }
            });
        });
    }
    /**
     * @typedef {ContainerJson} TableJson
     * @type {Object}
     * @property {number} cols
     * @property {number} rows
     * @property {string | null} layout
     * @property {Component[][]} contents
     */
    /**
     * Returns serialized component
     * @override
     * @return {Object}
     */
    toJSON() {
        let jsonObj = super.toJSON();
        let tableContents = [];
        for (let row of this.contents ?? []) {
            if (!Array.isArray(row)) {
                row = [];
            }
            let rowContents = [];
            for (let component of row) {
                rowContents.push(component?.toJSON() ?? null);
            }
            tableContents.push(rowContents);
        }
        return {
            ...jsonObj,
            cols: this._cols,
            rows: this._rows,
            layout: this._layout,
            contents: tableContents
        };
    }
    /**
     * Creates Table from JSON description
     * @override
     * @param {TableJson} json
     * @param {string} templateAddress
     * @param {Container|null} parent
     * @return {Table}
     */
    static fromJSON(json, templateAddress, parent = null) {
        let tableContents = [];
        let table = new Table({
            ...json,
            contents: tableContents,
            parent: parent,
            templateAddress: templateAddress
        });
        for (let [rowIdx, row] of (json.contents ?? []).entries()) {
            const rowContents = [];
            for (let [colIdx, componentJson] of row.entries()) {
                if (componentJson) {
                    rowContents.push(componentFactory.createOneComponent(componentJson, `${templateAddress}-contents-${rowIdx}-${colIdx}`, table));
                }
                else {
                    rowContents.push(undefined);
                }
            }
            tableContents.push(rowContents);
        }
        return table;
    }
    /**
     * Gets technical name for this component's type
     * @return The technical name
     * @throws {Error} If not implemented
     */
    static getTechnicalName() {
        return 'table';
    }
    /**
     * Gets pretty name for this component's type
     * @return {string} The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.Table');
    }
    /**
     * Get configuration form for component creation / edition
     * @param {TableJson & JSONObject} existingComponent
     * @param {TemplateSystem} entity
     * @return {Promise<HTMLElement>} The jQuery element holding the component
     */
    static async getConfigForm(entity, appId, existingComponent) {
        const predefinedValues = { ...existingComponent };
        predefinedValues.rows = predefinedValues?.rows ?? 1;
        predefinedValues.cols = predefinedValues?.cols ?? 1;
        const mainElt = document.createElement('div');
        mainElt.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/components/table.hbs`, {
            ...predefinedValues,
            appId
        });
        return mainElt;
    }
    /**
     * Extracts configuration from submitted HTML form
     * @override
     * @param {JQuery} html The submitted form
     * @return {TableJson} The JSON representation of the component
     * @throws {Error} If configuration is not correct
     */
    static extractConfig(configData, html) {
        let fieldData = super.extractConfig(configData, html);
        fieldData.rows = configData.rows ?? 1;
        fieldData.cols = configData.cols ?? 1;
        fieldData.layout = configData.layout;
        return fieldData;
    }
    /**
     * @param {TableJson} json
     */
    static validateConfig(json) {
        super.validateConfig(json);
        if (json.rows <= 0) {
            throw new NotGreaterThanZeroError(game.i18n.localize('CSB.ComponentProperties.Table.RowCount'), json);
        }
        if (json.cols <= 0) {
            throw new NotGreaterThanZeroError(game.i18n.localize('CSB.ComponentProperties.Table.ColCount'), json);
        }
    }
}
/**
 * @ignore
 */
export default Table;
