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
import ExtensibleTable, { TABLE_SORT_OPTION, COMPARISON_OPERATOR, SORT_OPERATORS } from './ExtensibleTable.js';
import { castToPrimitive, fastSetFlag, getLocalizedAlignmentList } from '../../utils.js';
import { isComputableElement } from '../../interfaces/ComputableElement.js';
import { isChatSenderElement } from '../../interfaces/ChatSenderElement.js';
import Checkbox from './Checkbox.js';
import Dropdown from './Dropdown.js';
import Label from './Label.js';
import NumberField from './NumberField.js';
import RadioButton from './RadioButton.js';
import RichTextArea from './RichTextArea.js';
import TextField from './TextField.js';
import Meter from './Meter.js';
import InputComponent from './InputComponent.js';
import CustomDialogV2 from '../../applications/CustomDialogV2.js';
import ComponentSettingsApplication from '../../applications/ComponentSettingsApplication.js';
const isPredefinedLine = (entry) => entry[1].$predefinedIdx !== undefined;
/**
 * DynamicTable component
 * @ignore
 */
class DynamicTable extends ExtensibleTable {
    static ALLOWED_COMPONENTS = [
        Checkbox.getTechnicalName(),
        Dropdown.getTechnicalName(),
        Label.getTechnicalName(),
        Meter.getTechnicalName(),
        NumberField.getTechnicalName(),
        RadioButton.getTechnicalName(),
        RichTextArea.getTechnicalName(),
        TextField.getTechnicalName()
    ];
    /**
     * All predefined lines for this Dynamic Table
     */
    _predefinedLines;
    /**
     * Can players add lines to the table?
     */
    _canPlayerAdd;
    /**
     * Hidden columns containing computable fields
     */
    _hiddenColumns;
    /**
     * The sort option to be applied
     */
    _sortOption;
    /**
     * Sort predicates
     */
    _sortPredicates;
    /**
     * Constructor
     * @param props Component data
     */
    constructor(props) {
        super(props);
        this._predefinedLines = [...(props.predefinedLines ?? [])];
        this._canPlayerAdd = props.canPlayerAdd ?? true;
        this._hiddenColumns = props.hiddenColumns ?? [];
        this._sortOption = props.sortOption ?? TABLE_SORT_OPTION.MANUAL;
        this._sortPredicates = props.sortPredicates ?? [];
    }
    /**
     * @returns {PredefinedLine[]}
     */
    get predefinedLines() {
        return this._predefinedLines;
    }
    /**
     * @returns {boolean}
     */
    get canPlayerAdd() {
        return game.user.isGM || this._canPlayerAdd;
    }
    /**
     * Renders component
     * @override
     * @param entity Rendered entity (actor or item)
     * @param isEditable Is the component editable by the current user ?
     * @param options Additional options
     * @return The jQuery element holding the component
     */
    async _getElement(entity, isEditable = true, options) {
        if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            await this._synchronizePredefinedLines(entity);
        }
        const sampleNewRow = {
            $deleted: false
        };
        const baseElement = await super._getElement(entity, isEditable, options);
        const columnsVisibility = {};
        const jQElement = $('<table></table>');
        const tableBody = $('<tbody></tbody>');
        const firstRow = $('<tr></tr>');
        for (const component of this._contents) {
            const cell = $('<td></td>');
            // Columns are not visible by default, one visible component in the column will make it visible
            columnsVisibility[component.key] = { column: cell[0], visible: false };
            cell.addClass('custom-system-cell');
            switch (this._rowLayout[component.key].align) {
                case 'center':
                    cell.addClass('custom-system-cell-alignCenter');
                    break;
                case 'right':
                    cell.addClass('custom-system-cell-alignRight');
                    break;
                case 'left':
                default:
                    cell.addClass('custom-system-cell-alignLeft');
                    break;
            }
            if (this._head) {
                cell.addClass('custom-system-cell-boldTitle');
            }
            if (TemplateSystem.isBuilderTemplateSystem(entity)) {
                const sortLeftTabButton = $('<a><i class="fas fa-caret-left custom-system-clickable"></i></a>');
                sortLeftTabButton.addClass('item');
                sortLeftTabButton.addClass('custom-system-sort-left');
                sortLeftTabButton.attr('title', game.i18n.localize('CSB.ComponentProperties.ExtensibleTable.ColumnSort.SortLeft'));
                sortLeftTabButton.on('click', () => {
                    component.sortBeforeInParent(entity);
                });
                cell.append(sortLeftTabButton);
            }
            const colNameSpan = $('<span></span>');
            colNameSpan.append(this._rowLayout[component.key].colName ?? '');
            if (TemplateSystem.isBuilderTemplateSystem(entity)) {
                colNameSpan.addClass('custom-system-editable-component');
                colNameSpan.addClass(component.key);
                colNameSpan.append(' {' + component.key + '}');
                colNameSpan.on('click', () => {
                    component.editComponent(entity, this._rowLayout[component.key], DynamicTable.ALLOWED_COMPONENTS);
                });
            }
            if (TemplateSystem.isAppliedTemplateSystem(entity) && this._sortOption === TABLE_SORT_OPTION.MANUAL) {
                const columnSortOption = game.user.getFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.sortOption');
                colNameSpan.append('&nbsp;');
                let nextSortIsToAsc = true;
                if (columnSortOption && columnSortOption.prop === component.key) {
                    nextSortIsToAsc = columnSortOption.operator !== COMPARISON_OPERATOR.LESSER_THAN;
                    colNameSpan.append(`<i class="fas fa-caret-${columnSortOption.operator === COMPARISON_OPERATOR.GREATER_THAN ? 'up' : 'down'}"></i>`);
                }
                cell.addClass('custom-system-clickable');
                cell.on('click', async () => {
                    fastSetFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.sortOption', {
                        prop: component.key,
                        operator: nextSortIsToAsc ? COMPARISON_OPERATOR.LESSER_THAN : COMPARISON_OPERATOR.GREATER_THAN
                    });
                    entity.render(false);
                });
            }
            cell.append(colNameSpan);
            if (TemplateSystem.isBuilderTemplateSystem(entity)) {
                const sortRightTabButton = $('<a><i class="fas fa-caret-right custom-system-clickable"></i></a>');
                sortRightTabButton.addClass('item');
                sortRightTabButton.addClass('custom-system-sort-right');
                sortRightTabButton.attr('title', game.i18n.localize('CSB.ComponentProperties.ExtensibleTable.ColumnSort.SortRight'));
                sortRightTabButton.on('click', () => {
                    component.sortAfterInParent(entity);
                });
                cell.append(sortRightTabButton);
            }
            firstRow.append(cell);
            if (component instanceof InputComponent) {
                sampleNewRow[component.key] = component.defaultValue;
            }
        }
        const headControlsRow = $('<td></td>');
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            headControlsRow.addClass('custom-system-cell custom-system-cell-alignCenter');
            headControlsRow.append(await this.renderTemplateControls(entity, {
                allowedComponents: DynamicTable.ALLOWED_COMPONENTS
            }));
        }
        firstRow.append(headControlsRow);
        tableBody.append(firstRow);
        // Get all properties and collect all relevant rows (not-deleted)
        let dynamicProps;
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            dynamicProps = this.predefinedLines;
        }
        else if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            dynamicProps = foundry.utils.getProperty(entity.system.props, this.key);
        }
        else {
            throw new Error('Entity type cannot render this element : ' + entity.entity.type);
        }
        const rowOrder = this._sortRows(dynamicProps, entity);
        fastSetFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.sortOption.savedOrder', rowOrder);
        for (const [index, line] of Object.entries(rowOrder)) {
            const parsedIndex = parseInt(index);
            const tableRow = $('<tr></tr>');
            tableRow.addClass('custom-system-dynamicRow');
            for (const component of this.contents) {
                const cell = $('<td></td>');
                cell.addClass('custom-system-cell');
                switch (this._rowLayout[component.key].align) {
                    case 'center':
                        cell.addClass('custom-system-cell-alignCenter');
                        break;
                    case 'right':
                        cell.addClass('custom-system-cell-alignRight');
                        break;
                    case 'left':
                    default:
                        cell.addClass('custom-system-cell-alignLeft');
                        break;
                }
                if (TemplateSystem.isBuilderTemplateSystem(entity)) {
                    const fieldSpan = $('<span></span>');
                    fieldSpan.addClass(`${this.key}.${line}.${component.key}`);
                    let predefinedField = $('<input />');
                    predefinedField.on('change', () => {
                        let rawVal = predefinedField.val();
                        if (Array.isArray(rawVal)) {
                            rawVal = rawVal.join();
                        }
                        this._predefinedLines[line][component.key] = rawVal;
                        this.save(entity);
                    });
                    switch (component.constructor.valueType) {
                        case 'string':
                            predefinedField.prop('type', 'text');
                            predefinedField.prop('value', this.predefinedLines[line][component.key]);
                            break;
                        case 'number':
                            predefinedField.prop('type', 'number');
                            predefinedField.prop('value', this.predefinedLines[line][component.key]);
                            break;
                        case 'boolean':
                            predefinedField.prop('type', 'checkbox');
                            if (this.predefinedLines[line][component.key] === true) {
                                predefinedField.prop('checked', 'checked');
                            }
                            predefinedField.on('change', () => {
                                this._predefinedLines[line][component.key] = predefinedField.is(':checked');
                                this.save(entity);
                            });
                            break;
                        default:
                            predefinedField = $(`<span>${component.constructor.getPrettyName()}</span>`);
                            break;
                    }
                    fieldSpan.append(predefinedField);
                    cell.append(fieldSpan);
                    columnsVisibility[component.key].visible = true;
                }
                else {
                    const newCompJson = component.toJSON();
                    newCompJson.key = `${this.key}.${line}.${component.key}`;
                    let canEdit = isEditable;
                    if (dynamicProps[line].$predefinedIdx) {
                        canEdit = canEdit && !this._rowLayout[component.key].readonlyPredefined;
                    }
                    const newComponent = componentFactory.createOneComponent(newCompJson);
                    cell.append(await newComponent.render(entity, canEdit, { ...options, reference: `${this.key}.${line}` }));
                    const visible = newComponent.canBeRendered(entity, {
                        ...options,
                        reference: `${this.key}.${line}`
                    });
                    if (!visible) {
                        cell.addClass('custom-system-cell-hidden');
                    }
                    columnsVisibility[component.key].visible = columnsVisibility[component.key].visible || visible;
                }
                tableRow.append(cell);
            }
            const controlCell = $('<td></td>');
            const controlDiv = $('<div></div>');
            controlDiv.addClass('custom-system-dynamic-table-row-icons');
            if (this._sortOption === TABLE_SORT_OPTION.MANUAL) {
                const sortSpan = $('<span></span>');
                sortSpan.addClass('custom-system-dynamic-table-sort-icon-wrapper');
                // If we are in a template, we do not move the row order, we directly update the predefined lines array
                // Line is the real index in the props array, parsedIndex is the displayed row number
                const currentIndex = TemplateSystem.isBuilderTemplateSystem(entity) ? line : parsedIndex;
                if (isEditable && line !== rowOrder[0]) {
                    const sortUpLink = $('<a class="custom-system-sortUpDynamicLine custom-system-clickable"><i class="fas fa-sort-up custom-system-dynamic-table-sort-icon"></i></a>');
                    sortSpan.append(sortUpLink);
                    sortUpLink.on('click', () => {
                        this._swapElements(entity, currentIndex - 1, currentIndex);
                    });
                }
                if (isEditable && line !== rowOrder[rowOrder.length - 1]) {
                    const sortDownLink = $('<a class="custom-system-sortDownDynamicLine custom-system-clickable"><i class="fas fa-sort-down custom-system-dynamic-table-sort-icon"></i></a>');
                    sortSpan.append(sortDownLink);
                    sortDownLink.on('click', () => {
                        this._swapElements(entity, currentIndex + 1, currentIndex);
                    });
                }
                controlDiv.append(sortSpan);
            }
            if (isEditable) {
                let deletionDisabled = false;
                if (TemplateSystem.isAppliedTemplateSystem(entity)) {
                    const predefinedLineIdx = foundry.utils.getProperty(entity.system.props, `${this.key}.${line}.$predefinedIdx`);
                    deletionDisabled =
                        predefinedLineIdx !== null
                            ? !!this._predefinedLines[predefinedLineIdx]?.$deletionDisabled
                            : false;
                }
                if (!deletionDisabled || game.user.isGM) {
                    const deleteLink = $('<a class="custom-system-deleteDynamicLine custom-system-clickable"><i class="fas fa-trash"></i></a>');
                    if (this._deleteWarning) {
                        deleteLink.on('click', async () => {
                            const shouldDelete = await foundry.applications.api.DialogV2.confirm({
                                // @ts-expect-error Types too strict
                                window: {
                                    title: game.i18n.localize('CSB.ComponentProperties.DynamicTable.DeleteRowDialog.Title'),
                                    icon: 'fas fa-trash'
                                },
                                content: `<p>${game.i18n.localize('CSB.ComponentProperties.DynamicTable.DeleteRowDialog.Content')}</p>`,
                                defaultYes: false,
                                modal: true,
                                rejectClose: true
                            });
                            if (shouldDelete) {
                                this._deleteRow(entity, line);
                            }
                        });
                    }
                    else {
                        deleteLink.on('click', () => {
                            this._deleteRow(entity, line);
                        });
                    }
                    controlDiv.append(deleteLink);
                }
            }
            if (TemplateSystem.isBuilderTemplateSystem(entity)) {
                const preventDeleteLink = $('<a class="custom-system-clickable"><i class="fas fa-trash-slash"></i></a>');
                if (!this._predefinedLines[line].$deletionDisabled) {
                    preventDeleteLink.addClass('custom-system-link-disabled');
                }
                preventDeleteLink.on('click', () => {
                    this._predefinedLines[line].$deletionDisabled = !this._predefinedLines[line].$deletionDisabled;
                    this.save(entity);
                });
                controlDiv.append(preventDeleteLink);
            }
            controlCell.append(controlDiv);
            tableRow.append(controlCell);
            tableBody.append(tableRow);
        }
        Object.entries(columnsVisibility).forEach(([key, { column, visible }]) => {
            if (!visible && rowOrder.length === 0) {
                const dummyComponent = this.contents.find((comp) => comp.key === key);
                visible = dummyComponent.canBeRendered(entity, {
                    ...options
                });
            }
            if (!visible) {
                column.textContent = '';
                column.classList.add('custom-system-cell-hidden');
            }
        });
        if (isEditable && this.canPlayerAdd) {
            const addRow = $('<tr></tr>');
            const fillCell = $('<td></td>');
            fillCell.attr('colspan', this.contents.length);
            const addButtonCell = $('<td></td>');
            const addButton = $('<a class="custom-system-addDynamicLine custom-system-clickable"><i class="fas fa-plus-circle"></i></a>');
            addButton.on('click', async () => {
                return this._createRow(entity, sampleNewRow);
            });
            addButton.on('contextmenu', (ev) => {
                const contextMenuElement = $('<nav></nav>');
                contextMenuElement.attr('id', `context-menu`);
                contextMenuElement.addClass('custom-system-roll-context');
                const contextActionList = $('<ol></ol>');
                contextActionList.addClass('context-items');
                const actionBullet = $('<li></li>');
                actionBullet.addClass('context-item');
                actionBullet.html(`<i class="fas fa-plus-circle"></i>${game.i18n.localize('CSB.ComponentProperties.DynamicTable.AddMultipleRowsDialog.AddMultipleRows')}`);
                actionBullet.on('click', async () => {
                    return new CustomDialogV2({
                        window: {
                            title: game.i18n.localize('CSB.ComponentProperties.DynamicTable.AddMultipleRowsDialog.AddMultipleRows')
                        },
                        content: await renderTemplate(`systems/${game.system.id}/templates/_template/dialogs/addMultipleRows.hbs`, {
                            appId: foundry.utils.randomID()
                        }),
                        buttons: {
                            confirm: {
                                default: true,
                                label: 'Confirm',
                                callback: async (_event, _button, dialog) => {
                                    const rowCount = parseInt(String($(dialog).find('[data-action="rowCount"]').val() ?? '0'));
                                    if (rowCount === 0 || isNaN(rowCount)) {
                                        throw new Error(game.i18n.localize('CSB.ComponentProperties.DynamicTable.AddMultipleRowsDialog.RowCountError'));
                                    }
                                    for (let i = 0; i < rowCount; i++) {
                                        await this._createRow(entity, sampleNewRow, false);
                                    }
                                    if (TemplateSystem.isAppliedTemplateSystem(entity)) {
                                        await entity.entity.update({
                                            system: {
                                                props: entity.system.props
                                            }
                                        });
                                    }
                                    else {
                                        await this.save(entity);
                                    }
                                }
                            },
                            cancel: {
                                label: 'Cancel'
                            }
                        },
                        position: {
                            width: 'auto'
                        }
                    }).render({ force: true });
                    /*
                    contextMenuElement.slideUp(200, () => {
                        contextMenuElement.remove();
                    });
                     */
                });
                contextActionList.append(actionBullet);
                contextMenuElement.append(contextActionList);
                $('body').append(contextMenuElement);
                // Set the position
                const locationX = ev.pageX;
                const locationY = ev.pageY;
                contextMenuElement.css('left', `${Math.min(locationX, window.innerWidth - ((contextMenuElement.width() ?? 0) + 3))}px`);
                contextMenuElement.css('top', `${Math.min(locationY + 3, window.innerHeight - ((contextMenuElement.height() ?? 0) + 3))}px`);
                contextMenuElement.css('zIndex', ++_maxZ);
                $('body').one('mousedown', (ev) => {
                    if (contextMenuElement.has($(ev.target)[0]).length === 0) {
                        contextMenuElement.slideUp(200, () => {
                            contextMenuElement.remove();
                        });
                    }
                });
            });
            addButtonCell.append(addButton);
            addRow.append(fillCell);
            addRow.append(addButtonCell);
            tableBody.append(addRow);
        }
        const internalContents = baseElement.hasClass('custom-system-component-contents')
            ? baseElement
            : baseElement.find('.custom-system-component-contents');
        jQElement.append(tableBody);
        internalContents.append(jQElement);
        return baseElement;
    }
    async _createRow(entity, defaultRow, save = true) {
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            this.predefinedLines.push({
                ...defaultRow,
                $predefinedIdx: this.predefinedLines.length,
                $deletionDisabled: false,
                $deleted: false
            });
            if (save) {
                await this.save(entity);
            }
        }
        else if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            let tableProps = foundry.utils.getProperty(entity.system.props, this.key) ?? {};
            const newIdx = Math.max(...Object.keys(tableProps).map((key) => Number(key))) + 1;
            // Compute new row
            const newRow = {
                $deleted: false
            };
            let keysToCompute = Object.keys(defaultRow).filter((key) => {
                return key !== '$deleted' && defaultRow[key] !== undefined;
            });
            let computedKeys = [];
            do {
                computedKeys = [];
                for (const key of keysToCompute) {
                    try {
                        const tmpProps = foundry.utils.mergeObject(entity.system.props, {
                            [this.key]: {
                                [newIdx]: newRow
                            }
                        }, { inplace: false });
                        newRow[key] = defaultRow[key]
                            ? ComputablePhrase.computeMessageStatic(String(defaultRow[key]), tmpProps, {
                                source: `${this.key}.${newIdx}.${key}.defaultValue`,
                                triggerEntity: entity,
                                reference: `${this.key}.${newIdx}`
                            }).result
                            : undefined;
                        computedKeys.push(key);
                    }
                    catch (_err) {
                        // Nothing should happen
                    }
                }
                keysToCompute = keysToCompute.filter((key) => !computedKeys.includes(key));
            } while (keysToCompute.length > 0 && computedKeys.length > 0);
            // Add new row to table data
            if (newIdx > 0) {
                tableProps[newIdx] = { ...newRow };
            }
            else {
                tableProps = {
                    0: { ...newRow }
                };
            }
            foundry.utils.setProperty(entity.system.props, this.key, tableProps);
            if (save) {
                await entity.entity.update({
                    system: {
                        props: entity.system.props
                    }
                });
            }
        }
    }
    _sortRows(dynamicProps, entity) {
        let rowOrder = [];
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            rowOrder = Object.keys(dynamicProps)
                .filter((rowIndex) => !dynamicProps[rowIndex].$deleted)
                .map((rowIndex) => parseInt(rowIndex))
                .sort((a, b) => a - b);
        }
        else if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            const columnSortOption = game.user.getFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.sortOption');
            for (const rowIndex in dynamicProps) {
                if (dynamicProps[rowIndex] && !dynamicProps[rowIndex].$deleted) {
                    rowOrder.push(parseInt(rowIndex));
                }
            }
            switch (this._sortOption) {
                case TABLE_SORT_OPTION.AUTO:
                    this._sortPredicates
                        .map((predicate) => ({ ...predicate }))
                        .reverse()
                        .forEach((predicate) => {
                        rowOrder.sort((a, b) => {
                            const aValue = castToPrimitive(dynamicProps[a][predicate.prop]) ?? '';
                            const bValue = castToPrimitive(dynamicProps[b][predicate.prop]) ?? '';
                            const value = castToPrimitive(predicate.value);
                            return DynamicTable.getSortOrder(aValue, bValue, value, predicate.operator);
                        });
                    });
                    break;
                case TABLE_SORT_OPTION.MANUAL:
                    if (columnSortOption?.prop) {
                        rowOrder.sort((a, b) => {
                            const aValue = castToPrimitive(dynamicProps[a][columnSortOption.prop]) ?? '';
                            const bValue = castToPrimitive(dynamicProps[b][columnSortOption.prop]) ?? '';
                            return DynamicTable.getSortOrder(aValue, bValue, undefined, columnSortOption.operator);
                        });
                    }
                    else {
                        let savedOrder = columnSortOption?.savedOrder ?? [];
                        savedOrder = savedOrder.filter((id) => rowOrder.includes(id));
                        rowOrder.forEach((id) => {
                            if (!savedOrder.includes(id)) {
                                savedOrder.push(id);
                            }
                        });
                        rowOrder = savedOrder;
                    }
                    break;
                case TABLE_SORT_OPTION.DISABLED:
                default:
                    rowOrder = rowOrder.sort((a, b) => a - b);
                    break;
            }
        }
        return rowOrder;
    }
    /**
     * Swaps two dynamic table elements
     * @param entity Rendered entity (actor or item)
     * @param rowIdx1
     * @param rowIdx2
     * @override
     */
    _swapElements(entity, rowIdx1, rowIdx2) {
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            const tmpRow = { ...this.predefinedLines[rowIdx1] };
            this._predefinedLines[rowIdx1] = this._predefinedLines[rowIdx2];
            this._predefinedLines[rowIdx2] = tmpRow;
            this.save(entity);
        }
        else if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            const rowOrder = game.user.getFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.sortOption.savedOrder');
            const temp = rowOrder[rowIdx1];
            rowOrder[rowIdx1] = rowOrder[rowIdx2];
            rowOrder[rowIdx2] = temp;
            fastSetFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.sortOption', {
                ['-=prop']: true,
                ['-=operator']: true,
                savedOrder: rowOrder
            });
            entity.render(false);
        }
    }
    /**
     * Deletes a row from the Table
     */
    async _deleteRow(entity, rowIdx) {
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            this._predefinedLines[rowIdx].$deleted = true;
            this.save(entity);
            return;
        }
        if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            const tablePropsPath = `${this.key}.${rowIdx}`;
            const tableProps = foundry.utils.getProperty(entity.system.props, tablePropsPath);
            if (tableProps.$predefinedIdx != null) {
                tableProps.$deleted = true;
                await entity.entity.update({ [`system.props.${tablePropsPath}`]: tableProps });
                return;
            }
            super._deleteRow(entity, rowIdx);
        }
    }
    /**
     * Synchronizes predefined lines, adding predefined lines to the current line of Dynamic Table
     */
    async _synchronizePredefinedLines(entity) {
        const existingPredefinedIdx = {};
        const dynamicProps = foundry.utils.getProperty(entity.system.props, this.key) ?? {};
        // Fetching all existing predefined lines in the actor
        Object.entries(dynamicProps)
            .filter(isPredefinedLine)
            .forEach(([index, line]) => (existingPredefinedIdx[line.$predefinedIdx] = index));
        this.predefinedLines.forEach((predefinedLine) => {
            if (predefinedLine.$deleted) {
                return;
            }
            // If line is not already added to the actor, we add it
            if (!Object.keys(existingPredefinedIdx).includes(String(predefinedLine.$predefinedIdx))) {
                const newIdx = Object.keys(dynamicProps).length === 0
                    ? 0
                    : Math.max(...Object.keys(dynamicProps).map((key) => Number(key))) + 1;
                dynamicProps[newIdx] = { ...predefinedLine };
            }
            else {
                const row = dynamicProps[existingPredefinedIdx[predefinedLine.$predefinedIdx]];
                for (const column of Object.keys(row)) {
                    let newValue;
                    if (this._rowLayout[column]?.readonlyPredefined) {
                        newValue = predefinedLine[column];
                    }
                    else {
                        newValue = row[column] ?? predefinedLine[column];
                    }
                    dynamicProps[existingPredefinedIdx[predefinedLine.$predefinedIdx]][column] = newValue;
                }
                dynamicProps[existingPredefinedIdx[predefinedLine.$predefinedIdx]].$deletionDisabled =
                    predefinedLine.$deletionDisabled;
            }
        });
        foundry.utils.setProperty(entity.system.props, this.key, dynamicProps);
        if (entity.entity.permission === CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
            await entity.entity.update({
                system: {
                    props: entity.system.props
                }
            });
        }
    }
    _getRowEntries(entity, computationKey, _options) {
        return Object.keys(foundry.utils.getProperty(entity.system.props ?? {}, computationKey) ?? {}).map((key) => ({
            reference: `${computationKey}.${key}`,
            data: {}
        }));
    }
    getComputeFunctions(entity, modifiers, options, keyOverride) {
        const computationKey = keyOverride ?? this.key;
        const computableFields = this.contents.filter((component) => isComputableElement(component));
        let computationFunctions = {};
        this._getRowEntries(entity, computationKey, options).forEach((entry) => {
            this._hiddenColumns.forEach((hiddenColumn) => {
                computationFunctions[`${entry.reference}.${hiddenColumn.key}`] = {
                    formula: hiddenColumn.formula,
                    options: {
                        ...options,
                        reference: entry.reference
                    }
                };
            });
            computableFields.forEach((field) => {
                const newFormulas = this._getComputeFunctionsOfField(entity, modifiers, entry, field, options);
                computationFunctions = {
                    ...computationFunctions,
                    ...newFormulas
                };
            });
        });
        return computationFunctions;
    }
    _getComputeFunctionsOfField(entity, modifiers, entry, field, options) {
        return field.getComputeFunctions(entity, modifiers, {
            ...options,
            reference: entry.reference
        }, `${entry.reference}.${field.key}`);
    }
    resetComputeValue(valueKeys) {
        const resetValues = {};
        for (const key of valueKeys) {
            foundry.utils.setProperty(resetValues, key, null);
        }
        return resetValues;
    }
    getSendToChatFunctions(entity, options = {}) {
        if (!this.key) {
            return {};
        }
        const relevantFields = this.contents.filter((component) => isChatSenderElement(component));
        const res = {};
        for (const row in foundry.utils.getProperty(entity.system.props, this.key)) {
            res[row] = {};
            for (const chatSenderElement of relevantFields) {
                foundry.utils.mergeObject(res[row], chatSenderElement.getSendToChatFunctions(entity, {
                    ...options,
                    reference: `${this.key}.${row}`
                }));
            }
        }
        return {
            [this.key]: res
        };
    }
    recalculateAddresses(newAddress) {
        this._templateAddress = newAddress;
        this.contents.forEach((component, index) => {
            component.recalculateAddresses(this.templateAddress + '-rowLayout-' + index);
        });
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
        const componentSettingsApp = new ComponentSettingsApplication(entity, this, {
            allowedComponents,
            options,
            component
        });
        const extensibleSettingsSection = document.createElement('div');
        extensibleSettingsSection.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/dialogs/componentExtensibleTableFields.hbs`, {
            component: component ? this._rowLayout[component.key] : {},
            ALIGNMENT_LIST: getLocalizedAlignmentList(),
            appId: componentSettingsApp.id
        });
        const readonlyPredefinedDiv = document.createElement('div');
        readonlyPredefinedDiv.classList = 'custom-system-form-field';
        const readonlyPredefinedLabel = document.createElement('label');
        readonlyPredefinedLabel.htmlFor = `compReadonlyPredefined-${componentSettingsApp.id}`;
        readonlyPredefinedLabel.textContent = game.i18n.localize('CSB.ComponentProperties.DynamicTable.ReadonlyPredefined');
        const readonlyPredefinedLabelInfo = document.createElement('div');
        readonlyPredefinedLabelInfo.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/partials/icon-info.hbs`, {
            title: game.i18n.localize('CSB.ComponentProperties.DynamicTable.ReadonlyPredefinedInfo')
        });
        readonlyPredefinedLabel.append(readonlyPredefinedLabelInfo.firstChild);
        const readonlyPredefinedInput = document.createElement('input');
        readonlyPredefinedInput.type = 'checkbox';
        readonlyPredefinedInput.classList = 'compReadonlyPredefined';
        readonlyPredefinedInput.id = `compReadonlyPredefined-${componentSettingsApp.id}`;
        readonlyPredefinedInput.dataset.key = 'readonlyPredefined';
        readonlyPredefinedInput.name = 'extraConf.readonlyPredefined';
        readonlyPredefinedInput.checked = component ? this._rowLayout[component.key].readonlyPredefined : false;
        readonlyPredefinedDiv.append(readonlyPredefinedLabel);
        readonlyPredefinedDiv.append(readonlyPredefinedInput);
        const fields = extensibleSettingsSection.querySelectorAll('.custom-system-form-field');
        fields[fields.length - 1].after(readonlyPredefinedDiv);
        componentSettingsApp.addAdditionalConfigElement(extensibleSettingsSection.firstChild);
        return componentSettingsApp.render({ force: true });
    }
    /**
     * Adds new component to container, handling rowLayout
     * @override
     * @param entity Rendered entity (actor or item)
     * @param component New component
     * @param _options Ignored
     */
    async addNewComponent(entity, component, _options = {}) {
        if (!Array.isArray(component)) {
            component = [component];
        }
        for (const aComp of component) {
            if (this._rowLayout[aComp.key]) {
                throw new Error("Component keys should be unique in the component's columns.");
            }
        }
        for (const aComponent of component) {
            // Add component
            this.contents.push(componentFactory.createOneComponent(aComponent, undefined, this));
            this._rowLayout[aComponent.key] = {
                align: aComponent.extraConf.align,
                colName: aComponent.extraConf.colName,
                readonlyPredefined: aComponent.extraConf.readonlyPredefined
            };
        }
        this.recalculateAddresses(this.templateAddress);
        await this.save(entity);
    }
    /**
     *  @inheritdoc
     */
    replaceComponent(oldComponent, newComponent) {
        super.replaceComponent(oldComponent, newComponent);
        this._rowLayout[newComponent.key].readonlyPredefined = newComponent.extraConf.readonlyPredefined;
    }
    /**
     * Returns serialized component
     * @override
     */
    toJSON() {
        const jsonObj = super.toJSON();
        const rowLayout = [];
        for (const component of jsonObj.rowLayout ?? []) {
            rowLayout.push({
                ...component,
                align: this._rowLayout?.[component.key].align ?? 'left',
                colName: this._rowLayout?.[component.key].colName ?? '',
                readonlyPredefined: this._rowLayout?.[component.key].readonlyPredefined ?? false
            });
        }
        return {
            ...jsonObj,
            predefinedLines: this.predefinedLines,
            canPlayerAdd: this._canPlayerAdd,
            hiddenColumns: this._hiddenColumns,
            sortOption: this._sortOption,
            sortPredicates: this._sortPredicates,
            rowLayout
        };
    }
    /**
     * Creates DynamicTable from JSON description
     * @override
     */
    static fromJSON(json, templateAddress, parent) {
        const rowContents = [];
        const rowLayout = {};
        const dynamicTable = new DynamicTable({
            ...json,
            contents: rowContents,
            rowLayout: rowLayout,
            parent: parent,
            templateAddress: templateAddress
        });
        for (const [index, componentDesc] of (json.rowLayout ?? []).entries()) {
            const component = componentFactory.createOneComponent(componentDesc, templateAddress + '-rowLayout-' + index, dynamicTable);
            rowContents.push(component);
            rowLayout[component.key] = {
                align: componentDesc.align,
                colName: componentDesc.colName,
                readonlyPredefined: componentDesc.readonlyPredefined
            };
        }
        return dynamicTable;
    }
    /**
     * Gets technical name for this component's type
     * @return The technical name
     * @throws {Error} If not implemented
     */
    static getTechnicalName() {
        return 'dynamicTable';
    }
    /**
     * Gets pretty name for this component's type
     * @return The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.DynamicTable');
    }
    /**
     * Get a configuration form for component creation / edition
     * @return The jQuery element holding the component
     */
    static async getConfigForm(_entity, appId, existingComponent) {
        const predefinedValuesComponent = { ...existingComponent };
        predefinedValuesComponent.hiddenColumns ??= [];
        predefinedValuesComponent.canPlayerAdd ??= true;
        predefinedValuesComponent.sortOption ??= TABLE_SORT_OPTION.MANUAL;
        const mainElt = document.createElement('div');
        mainElt.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/components/dynamicTable.hbs`, {
            ...predefinedValuesComponent,
            SORT_OPERATORS,
            appId
        });
        mainElt.querySelectorAll("input[name='tableSortOption']").forEach((elt) => {
            elt.addEventListener('change', (event) => {
                const targetValue = event.currentTarget.value;
                const autoSort = $(mainElt.querySelector('.custom-system-sort-auto'));
                const columnSort = $(mainElt.querySelector('.custom-system-sort-column'));
                const manualSort = $(mainElt.querySelector('.custom-system-sort-manual'));
                const disabledSort = $(mainElt.querySelector('.custom-system-sort-disabled'));
                const slideValue = 200;
                autoSort.slideUp(slideValue);
                columnSort.slideUp(slideValue);
                manualSort.slideUp(slideValue);
                disabledSort.slideUp(slideValue);
                switch (targetValue) {
                    case 'auto':
                        autoSort.slideDown(slideValue);
                        break;
                    case 'column':
                        columnSort.slideDown(slideValue);
                        break;
                    case 'manual':
                        manualSort.slideDown(slideValue);
                        break;
                    case 'disabled':
                        disabledSort.slideDown(slideValue);
                        break;
                }
            });
        });
        mainElt.querySelector('.custom-system-add-sort-predicate')?.addEventListener('click', () => {
            const newId = String(parseInt(Array.from(mainElt.querySelectorAll('.custom-system-table-sort-predicate')).pop()
                ?.dataset.index ?? '-1') + 1);
            const newRow = mainElt.querySelector('.custom-system-table-sort-predicate-template').content.cloneNode(true);
            newRow.querySelector('.custom-system-table-sort-predicate').dataset.index = newId;
            newRow.querySelector('.custom-system-table-sort-predicate-property').name =
                `tableSortProp.${newId}`;
            newRow.querySelector('.custom-system-table-sort-predicate-operation').name =
                `tableSortOp.${newId}`;
            newRow.querySelector('.custom-system-table-sort-predicate-value').name =
                `tableSortValue.${newId}`;
            mainElt.querySelector('.custom-system-table-sort-predicates > tbody')?.append(newRow);
        });
        mainElt.querySelector('.custom-system-table-sort-predicates')?.addEventListener('click', (ev) => {
            const target = ev.target.closest('.custom-system-delete-sort-predicate');
            if (target) {
                target.closest('tr')?.remove();
            }
        });
        mainElt.querySelector('.custom-system-add-hidden-column')?.addEventListener('click', () => {
            const newId = String(parseInt(Array.from(mainElt.querySelectorAll('.custom-system-table-hidden-column')).pop()
                ?.dataset.index ?? '-1') + 1);
            const newRow = mainElt.querySelector('.custom-system-table-hidden-column-template').content.cloneNode(true);
            newRow.querySelector('.custom-system-table-hidden-column').dataset.index = newId;
            newRow.querySelector('.custom-system-table-hidden-column-key').name =
                `hiddenColumnKey.${newId}`;
            newRow.querySelector('.custom-system-table-hidden-column-formula').name =
                `hiddenColumnFormula.${newId}`;
            newRow.querySelector('.custom-system-table-hidden-column-is-predefined').name =
                `hiddenColumnIsPredefined.${newId}`;
            mainElt.querySelector('.custom-system-table-hidden-columns > tbody')?.append(newRow);
        });
        mainElt.querySelector('.custom-system-table-hidden-columns')?.addEventListener('click', (ev) => {
            const target = ev.target.closest('.custom-system-delete-hidden-column');
            if (target) {
                target.closest('tr')?.remove();
            }
        });
        return mainElt;
    }
    /**
     * Extracts configuration from submitted HTML form
     * @override
     * @param rawConfigData
     * @param html The submitted form
     * @return The JSON representation of the component
     * @throws {Error} If configuration is not correct
     */
    static extractConfig(rawConfigData, html) {
        const configData = rawConfigData;
        const fieldData = super.extractConfig(configData, html);
        fieldData.canPlayerAdd = configData.canPlayerAdd;
        fieldData.sortOption = configData.tableSortOption;
        fieldData.head = configData.head;
        fieldData.deleteWarning = configData.deleteWarning;
        fieldData.hiddenColumns = Object.entries(configData.hiddenColumnKey ?? {}).map(([idx, key]) => ({
            key,
            formula: (configData.hiddenColumnFormula ?? {})[idx],
            isPredefined: (configData.hiddenColumnIsPredefined ?? {})[idx]
        }));
        if (fieldData.sortOption === TABLE_SORT_OPTION.AUTO) {
            fieldData.sortPredicates = Object.entries(configData.tableSortProp ?? {}).map(([idx, prop]) => ({
                prop,
                operator: (configData.tableSortOp ?? {})[idx],
                value: (configData.tableSortValue ?? {})[idx]
            }));
        }
        else {
            fieldData.sortPredicates = [];
        }
        return fieldData;
    }
    /**
     * Add a new Component as eligible for this Container
     *
     * @param name The technical name which identifies the component in the ComponentFactory
     */
    static addAllowedComponent(name) {
        this.ALLOWED_COMPONENTS.push(name);
    }
}
/**
 * @ignore
 */
export default DynamicTable;
