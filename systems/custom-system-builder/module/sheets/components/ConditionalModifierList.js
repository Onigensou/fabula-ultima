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
import ExtensibleTable from './ExtensibleTable.js';
import { getLocalizedAlignmentList } from '../../utils.js';
/**
 * Class ConditionalModifierList
 * @ignore
 */
class ConditionalModifierList extends ExtensibleTable {
    /** Should table header be displayed? */
    _headDisplay;
    /** Should info icon be displayed with tooltips with modifier descriptions? */
    _infoDisplay;
    /** Label of the selection column */
    _selectionLabel;
    /** Alignment of the selection column */
    _selectionAlign;
    /** Label of the group column */
    _groupLabel;
    /** Alignment of the group column */
    _groupAlign;
    /** Which groups can be displayed */
    _groupFilter;
    /** Formula defining which groups can be displayed. Overrides _groupFilter */
    _groupFilterFormula;
    constructor(props) {
        super(props);
        this._headDisplay = props.headDisplay;
        this._infoDisplay = props.infoDisplay;
        this._selectionLabel = props.selectionLabel;
        this._selectionAlign = props.selectionAlign;
        this._groupLabel = props.groupLabel;
        this._groupAlign = props.groupAlign;
        this._groupFilter = props.groupFilter;
        this._groupFilterFormula = props.groupFilterFormula;
    }
    /**
     * Renders component
     * @override
     * @param {TemplateSystem} entity Rendered entity (actor or item)
     * @param {boolean} [isEditable=true] Is the component editable by the current user ?
     * @param {ComponentRenderOptions} [options={}] Additional options usable by the final Component
     * @return {Promise<JQuery>} The jQuery element holding the component
     */
    async _getElement(entity, isEditable = true, options = {}) {
        const { reference } = options;
        const jQElement = await super._getElement(entity, isEditable, options);
        const tableElement = $('<table></table>');
        const tableBody = $('<tbody></tbody>');
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            tableBody.append(this._createTemplateColumns());
        }
        else if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            let sortedConditionalModifiers = entity.getSortedConditionalModifiers();
            let groupFilter;
            if (this._groupFilterFormula && this._groupFilterFormula !== '') {
                groupFilter = ComputablePhrase.computeMessageStatic(`\${${this._groupFilterFormula}}$`, entity.system.props, {
                    source: `${this.key}.groupFilterFormula`,
                    reference,
                    defaultValue: '',
                    triggerEntity: entity
                }).result.split(',');
            }
            else if (this._groupFilter.length !== 0) {
                groupFilter = this._groupFilter;
            }
            if (groupFilter) {
                sortedConditionalModifiers = Object.keys(sortedConditionalModifiers)
                    .filter((key) => groupFilter.includes(key))
                    .reduce((obj, key) => {
                    obj[key] = sortedConditionalModifiers[key];
                    return obj;
                }, {});
            }
            if (this._headDisplay) {
                tableBody.append(this._createTemplateColumns());
            }
            for (const [key, group] of Object.entries(sortedConditionalModifiers)) {
                tableBody.append(await this._createRow(key, group, entity));
            }
        }
        tableElement.append(tableBody);
        jQElement.append(tableElement);
        return jQElement;
    }
    /** Returns serialized component */
    toJSON() {
        const jsonObj = super.toJSON();
        return {
            ...jsonObj,
            headDisplay: this._headDisplay,
            infoDisplay: this._infoDisplay,
            selectionLabel: this._selectionLabel,
            selectionAlign: this._selectionAlign,
            groupLabel: this._groupLabel,
            groupAlign: this._groupAlign,
            groupFilter: this._groupFilter,
            groupFilterFormula: this._groupFilterFormula
        };
    }
    /**
     * Creates ConditionalModifierList from JSON description
     * @override
     * @param {ConditionalModifierListJson} json
     * @param {string} templateAddress
     * @param {Container|null} parent
     * @return {ConditionalModifierList}
     */
    static fromJSON(json, templateAddress, parent) {
        return new ConditionalModifierList({
            ...json,
            parent: parent,
            templateAddress: templateAddress,
            contents: [],
            rowLayout: {},
            deleteWarning: false
        });
    }
    /**
     * Gets technical name for this component's type
     * @return The technical name
     * @throws {Error} If not implemented
     */
    static getTechnicalName() {
        return 'conditionalModifierList';
    }
    /**
     * Gets pretty name for this component's type
     * @returns The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.ConditionalModifierList');
    }
    /** Get configuration form for component creation / edition */
    static async getConfigForm(entity, appId, existingComponent) {
        const predefinedValues = {
            headDisplay: existingComponent?.headDisplay ?? true,
            head: existingComponent?.head ?? true,
            selectionLabel: existingComponent?.selectionLabel ??
                game.i18n.localize('CSB.ComponentProperties.ConditionalModifierList.SelectionColumnNameDefault'),
            groupLabel: existingComponent?.groupLabel ??
                game.i18n.localize('CSB.ComponentProperties.ConditionalModifierList.GroupColumnNameDefault')
        };
        const mainElt = document.createElement('div');
        mainElt.innerHTML = await renderTemplate('systems/' + game.system.id + '/templates/_template/components/conditionalModifierList.hbs', {
            ...predefinedValues,
            availableGroups: this._getAvailableGroups(entity).map((group) => ({
                group,
                checked: existingComponent?.groupFilter?.includes(group) ?? false
            })),
            ALIGNMENTS: getLocalizedAlignmentList(),
            appId
        });
        return mainElt;
    }
    /**
     * Extracts configuration from submitted HTML form
     * @override
     * @param html The submitted form
     * @returns The JSON representation of the component
     * @throws {Error} If configuration is not correct
     */
    static extractConfig(rawConfigData, html) {
        const configData = rawConfigData;
        return {
            ...super.extractConfig(configData, html),
            headDisplay: configData.headDisplay ?? true,
            head: configData.head ?? true,
            infoDisplay: configData.infoDisplay ?? false,
            selectionLabel: configData.selectionLabel ?? '',
            selectionAlign: configData.selectionAlign ?? 'left',
            groupLabel: configData.groupLabel ?? '',
            groupAlign: configData.groupAlign ?? 'left',
            groupFilterFormula: configData.groupFilterFormula ?? '',
            groupFilter: (configData.groupFilter ?? []).filter((group) => group !== null)
        };
    }
    /** Creates the header-row of the table */
    _createTemplateColumns() {
        const firstRow = $('<tr></tr>');
        for (let i = 0; i < 2; i++) {
            const cell = $('<td></td>');
            cell.addClass('custom-system-cell');
            switch (i === 0 ? this._selectionAlign : this._groupAlign) {
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
            const colNameSpan = $('<span></span>');
            colNameSpan.append(i === 0 ? this._selectionLabel : this._groupLabel);
            cell.append(colNameSpan);
            firstRow.append(cell);
        }
        return firstRow;
    }
    /** Creates a table-row for every conditional modifier */
    async _createRow(key, modifiers, entity) {
        const totalColumns = this._infoDisplay ? 3 : 2;
        const tableRow = $('<tr></tr>');
        tableRow.addClass('custom-system-dynamicRow');
        for (let i = 0; i < totalColumns; i++) {
            const cell = $('<td></td>');
            cell.addClass('custom-system-cell');
            let alignment;
            switch (i) {
                case 0:
                    alignment = this._selectionAlign;
                    cell.append(await this._createIsSelectedCell(key, entity));
                    break;
                case 1:
                    alignment = this._groupAlign;
                    cell.append(this._createDataCell(key));
                    break;
                case 2:
                    alignment = 'right';
                    cell.append(this._createInfoCell(modifiers));
                    break;
                default:
                    alignment = 'left';
                    break;
            }
            switch (alignment) {
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
            tableRow.append(cell);
        }
        return tableRow;
    }
    async _createIsSelectedCell(key, entity) {
        entity.system.activeConditionalModifierGroups ??= [];
        const input = $('<input type="checkbox"/>');
        input.addClass('custom-system-conditional-modifier');
        input.prop('checked', entity.system.activeConditionalModifierGroups.includes(key) ?? false);
        input.on('click', async () => {
            if (input.is(':checked')) {
                entity.system.activeConditionalModifierGroups.push(key);
            }
            else {
                entity.system.activeConditionalModifierGroups = entity.system.activeConditionalModifierGroups.filter((group) => group !== key);
            }
            await entity.entity.update({
                system: {
                    activeConditionalModifierGroups: entity.system
                        .activeConditionalModifierGroups
                }
            });
        });
        return input;
    }
    _createDataCell(key) {
        const data = $('<div></div>');
        data.append(key);
        return data;
    }
    _createInfoCell(modifiers) {
        const data = $('<div class="custom-system-dynamic-table-row-icons"></div>');
        const infoIcon = $('<div class="custom-system-tooltip"><i class="fas fa-circle-info"></i></div>');
        const list = $('<ul class="custom-system-tooltip-box"></ul>');
        modifiers.forEach((modifier) => {
            modifier.description = ComputablePhrase.computeMessageStatic(modifier.description ?? '', modifier.originalEntity.entity.system.props, {
                source: `${this.key}.modifier.${modifier.key}.description`,
                defaultValue: 0,
                triggerEntity: modifier.originalEntity
            }).result;
            const tooltipRow = $('<li class="custom-system-tooltip-list-item"></li>');
            tooltipRow.append(modifier.description);
            list.append(tooltipRow);
        });
        infoIcon.append(list);
        data.append(infoIcon);
        return data;
    }
    /** Gets all available conditional modifier groups in all the items plus those set on the status effects of this template */
    static _getAvailableGroups(entity) {
        const availableGroups = new Set();
        game.items
            .map((item) => item.system.modifiers)
            .deepFlatten()
            .filter((modifier) => modifier?.conditionalGroup)
            .forEach((modifier) => {
            availableGroups.add(modifier.conditionalGroup);
        });
        if (entity.system.statusEffects) {
            Object.entries(entity.system.statusEffects).forEach(([_, modifiers]) => {
                modifiers
                    .filter((modifier) => modifier?.conditionalGroup)
                    .forEach((modifier) => {
                    availableGroups.add(modifier.conditionalGroup);
                });
            });
        }
        return Array.from(availableGroups);
    }
}
/**
 * @ignore
 */
export default ConditionalModifierList;
