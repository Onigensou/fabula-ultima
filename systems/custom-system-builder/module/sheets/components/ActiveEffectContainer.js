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
import ExtensibleTable, { COMPARISON_OPERATOR, SIMPLE_TABLE_SORT_OPTIONS, TABLE_SORT_OPTION } from './ExtensibleTable.js';
import { fastSetFlag, getLocalizedAlignmentList, isModuleActive } from '../../utils.js';
import CustomActiveEffect from '../../documents/CustomActiveEffect.js';
import NumberField from './NumberField.js';
import CustomItem from '../../documents/CustomItem.js';
export var DESCRIPTION_FORMAT;
(function (DESCRIPTION_FORMAT) {
    DESCRIPTION_FORMAT["FULL"] = "full";
    DESCRIPTION_FORMAT["SHORT"] = "short";
})(DESCRIPTION_FORMAT || (DESCRIPTION_FORMAT = {}));
export const DESCRIPTION_FORMATS = {
    [DESCRIPTION_FORMAT.FULL]: 'CSB.ComponentProperties.ActiveEffectContainer.Columns.Description.Format.Full',
    [DESCRIPTION_FORMAT.SHORT]: 'CSB.ComponentProperties.ActiveEffectContainer.Columns.Description.Format.Short'
};
class ActiveEffectContainer extends ExtensibleTable {
    _staticRowLayout;
    /** Table title */
    _title;
    /** Should Table be hidden if empty? */
    _hideEmpty;
    /** Should Table header be displayed? */
    _headDisplay;
    /** Show delete button */
    _showDelete;
    /** Should the Create-Button be shown to create Active Effects through this Container? */
    _showCreateButton;
    /**
     * Which sort option should be applied
     */
    _sortOption;
    /**
     * Should the displayer show only effects from its parent, and not from items in the parent
     */
    _showOnlyOwnEffects;
    /**
     * Should the displayer suggest effects already existing on the entity
     */
    _suggestExistingEffects;
    /**
     * Filter displayed Active Effects based on tags
     */
    _filterTags;
    /** ActiveEffectContainer constructor */
    constructor(props) {
        super(props);
        this._staticRowLayout = props.staticRowLayout;
        if (this._staticRowLayout?.name)
            this._staticRowLayout.name.enabled = true;
        this._title = props.title;
        this._hideEmpty = props.hideEmpty ?? false;
        this._headDisplay = props.headDisplay ?? true;
        this._showDelete = props.showDelete ?? true;
        this._showCreateButton = props.showCreateButton ?? true;
        this._sortOption = props.sortOption ?? TABLE_SORT_OPTION.MANUAL;
        this._showOnlyOwnEffects = props.showOnlyOwnEffects ?? false;
        this._suggestExistingEffects = props.suggestExistingEffects ?? false;
        this._filterTags = props.filterTags?.filter((tag) => tag !== '') ?? [];
    }
    /**
     * Renders component
     * @override
     * @param {TemplateSystem} entity Rendered entity (actor or item)
     * @param {boolean} [isEditable=true] Is the component editable by the current user?
     * @param {ComponentRenderOptions} [options={}] Additional options usable by the final Component
     * @return {Promise<JQuery>} The jQuery element holding the component
     */
    async _getElement(entity, isEditable = true, options = {}) {
        const jQElement = await super._getElement(entity, isEditable, options);
        const activeEffects = this._sortEffects(this._getFilteredEffects(entity), entity);
        const tableElement = $('<table></table>');
        if (!TemplateSystem.isBuilderTemplateSystem(entity) && this._hideEmpty && activeEffects.length === 0) {
            tableElement.addClass('hidden');
        }
        if (this._title) {
            const captionElement = $('<caption></caption>');
            captionElement.append(this._title);
            tableElement.append(captionElement);
        }
        const tableBody = $('<tbody></tbody>');
        if (TemplateSystem.isBuilderTemplateSystem(entity) || this._headDisplay) {
            tableBody.append(this._createTemplateColumns(entity));
        }
        for (const activeEffect of activeEffects) {
            tableBody.append(await this._createRow(entity, activeEffect, isEditable));
        }
        tableElement.append(tableBody);
        if ((isEditable && this._showCreateButton) ||
            TemplateSystem.isFullBuilderTemplateSystem(entity) ||
            CustomItem.isActiveEffectContainer(entity.entity)) {
            const addRow = $('<tr></tr>');
            const effectSelectorCell = $('<td></td>');
            effectSelectorCell.attr('colspan', Object.values(this._staticRowLayout).filter((row) => row.enabled).length);
            effectSelectorCell.addClass('custom-system-cell-alignRight');
            const effectSelector = $('<select></select>');
            const predefinedEffects = CustomActiveEffect.getPredefinedEffectsData();
            predefinedEffects.forEach((effect) => {
                if (this._filterTags.length === 0 ||
                    this._filterTags.some((tag) => {
                        return effect.tags.includes(tag);
                    }))
                    if (this._suggestExistingEffects || !entity.entity.effects.getName(effect.name)) {
                        const option = $('<option></option>');
                        option.attr('value', effect.id);
                        option.append(effect.name);
                        effectSelector.append(option);
                    }
            });
            const newEffectOption = $('<option></option>');
            newEffectOption.attr('value', '');
            newEffectOption.append(game.i18n.localize('CSB.ComponentProperties.ActiveEffectContainer.NewActiveEffect'));
            effectSelector.append(newEffectOption);
            effectSelectorCell.append(effectSelector);
            const addButtonCell = $('<td></td>');
            const addButton = $('<a class="custom-system-addDynamicLine custom-system-clickable"><i class="fas fa-plus-circle"></i></a>');
            addButton.on('click', async () => {
                const effectId = effectSelector.val();
                if (effectId && effectId !== '') {
                    CustomActiveEffect.addActiveEffect(entity.entity, String(effectId));
                }
                else {
                    CustomActiveEffect.createDialog({
                        img: 'icons/svg/aura.svg'
                    }, {
                        parent: entity.entity
                    });
                }
            });
            addButtonCell.append(addButton);
            addRow.append(effectSelectorCell);
            addRow.append(addButtonCell);
            tableBody.append(addRow);
        }
        jQElement.append(tableElement);
        return jQElement;
    }
    /**
     * Returns serialized component
     * @override
     */
    toJSON() {
        const jsonObj = super.toJSON();
        return {
            ...jsonObj,
            title: this._title,
            hideEmpty: this._hideEmpty,
            headDisplay: this._headDisplay,
            showDelete: this._showDelete,
            staticRowLayout: this._staticRowLayout,
            showCreateButton: this._showCreateButton,
            sortOption: this._sortOption,
            showOnlyOwnEffects: this._showOnlyOwnEffects,
            suggestExistingEffects: this._suggestExistingEffects,
            filterTags: this._filterTags
        };
    }
    /**
     * Creates ActiveEffectContainer from JSON description
     * @override
     */
    static fromJSON(json, templateAddress, parent) {
        return new ActiveEffectContainer({
            ...json,
            parent: parent,
            templateAddress: templateAddress,
            contents: [],
            rowLayout: {}
        });
    }
    /**
     * Gets technical name for this component's type
     * @return The technical name
     * @throws {Error} If not implemented
     */
    static getTechnicalName() {
        return 'activeEffectContainer';
    }
    /**
     * Gets pretty name for this component's type
     * @return The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.ActiveEffectContainer');
    }
    /**
     * Get configuration form for component creation / edition
     * @return The jQuery element holding the configuration form
     */
    static async getConfigForm(_entity, appId, existingComponent) {
        const mainElt = document.createElement('div');
        mainElt.innerHTML = await renderTemplate('systems/' + game.system.id + '/templates/_template/components/activeEffectContainer.hbs', {
            title: existingComponent?.title ?? '',
            hideEmpty: existingComponent?.hideEmpty ?? false,
            headDisplay: existingComponent?.headDisplay ?? true,
            head: existingComponent?.head ?? true,
            showDelete: existingComponent?.showDelete ?? true,
            deleteWarning: existingComponent?.deleteWarning ?? true,
            showCreateButton: existingComponent?.showCreateButton ?? true,
            showOnlyOwnEffects: existingComponent?.showOnlyOwnEffects ?? false,
            sortOption: existingComponent?.sortOption ?? TABLE_SORT_OPTION.MANUAL,
            filterTags: existingComponent?.filterTags?.join(',') ?? '',
            staticRowLayout: existingComponent?.staticRowLayout ?? {
                active: {
                    enabled: true,
                    colName: game.i18n.localize('CSB.ComponentProperties.ActiveEffectContainer.Columns.Active.LabelDefault'),
                    align: 'left',
                    sort: 1
                },
                name: {
                    enabled: true,
                    colName: game.i18n.localize('CSB.ComponentProperties.ActiveEffectContainer.Columns.Ref.LabelDefault'),
                    align: 'center',
                    sort: 2
                },
                origin: {
                    enabled: true,
                    colName: game.i18n.localize('CSB.ComponentProperties.ActiveEffectContainer.Columns.Origin.LabelDefault'),
                    align: 'center',
                    sort: 3
                },
                description: {
                    enabled: true,
                    colName: game.i18n.localize('CSB.ComponentProperties.ActiveEffectContainer.Columns.Description.LabelDefault'),
                    align: 'left',
                    sort: 4,
                    format: DESCRIPTION_FORMAT.FULL
                },
                count: {
                    enabled: false,
                    colName: game.i18n.localize('CSB.ComponentProperties.ActiveEffectContainer.Columns.Count.LabelDefault'),
                    align: 'center',
                    sort: 5,
                    readonly: false
                }
            },
            ALIGNMENTS: getLocalizedAlignmentList(),
            DESCRIPTION_FORMATS,
            SIMPLE_TABLE_SORT_OPTIONS,
            STATUS_COUNTER_ENABLED: isModuleActive('statuscounter'),
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
            title: configData.title ?? '',
            hideEmpty: configData.hideEmpty,
            headDisplay: configData.headDisplay,
            head: configData.head,
            showDelete: configData.showDelete,
            deleteWarning: configData.deleteWarning,
            showCreateButton: configData.showCreateButton,
            sortOption: configData.sortOption ?? TABLE_SORT_OPTION.MANUAL,
            showOnlyOwnEffects: configData.showOnlyOwnEffects,
            suggestExistingEffects: configData.suggestExistingEffects,
            filterTags: configData.filterTags,
            staticRowLayout: {
                active: {
                    enabled: configData.activeEnabled ?? true,
                    colName: configData.activeLabel ??
                        game.i18n.localize('CSB.ComponentProperties.ActiveEffectContainer.Columns.Active.LabelDefault'),
                    align: configData.activeAlign ?? 'left',
                    sort: configData.activeSort ?? 1
                },
                name: {
                    enabled: true,
                    colName: configData.nameLabel ??
                        game.i18n.localize('CSB.ComponentProperties.ActiveEffectContainer.Columns.Ref.LabelDefault'),
                    align: configData.nameAlign ?? 'center',
                    sort: configData.nameSort ?? 2
                },
                origin: {
                    enabled: configData.originEnabled ?? true,
                    colName: configData.originLabel ??
                        game.i18n.localize('CSB.ComponentProperties.ActiveEffectContainer.Columns.Origin.LabelDefault'),
                    align: configData.originAlign ?? 'center',
                    sort: configData.originSort ?? 3
                },
                description: {
                    enabled: configData.descriptionEnabled ?? true,
                    colName: configData.descriptionLabel ??
                        game.i18n.localize('CSB.ComponentProperties.ActiveEffectContainer.Columns.Description.LabelDefault'),
                    align: configData.descriptionAlign ?? 'left',
                    sort: configData.descriptionSort ?? 4,
                    format: configData.descriptionFormat ?? DESCRIPTION_FORMAT.FULL
                },
                count: {
                    enabled: configData.countEnabled ?? false,
                    colName: configData.countLabel ??
                        game.i18n.localize('CSB.ComponentProperties.ActiveEffectContainer.Columns.Count.LabelDefault'),
                    align: configData.countAlign ?? 'center',
                    sort: configData.countSort ?? 5,
                    readonly: configData.countReadonly
                }
            }
        };
    }
    /** Creates the header-row of the table */
    _createTemplateColumns(entity) {
        let columnSortOption = undefined;
        if (this._sortOption === TABLE_SORT_OPTION.MANUAL) {
            columnSortOption = game.user.getFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.sortOption');
        }
        const firstRow = $('<tr></tr>');
        Object.entries(this._staticRowLayout)
            .filter(([, col]) => col.enabled)
            .sort(([, aCol], [, bCol]) => aCol.sort - bCol.sort)
            .forEach(([key, row]) => {
            const cell = $('<td></td>');
            cell.addClass('custom-system-cell');
            switch (row.align) {
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
            colNameSpan.append(row.colName ?? 'Unknown');
            if (this._sortOption === TABLE_SORT_OPTION.MANUAL) {
                let nextSortIsToAsc = true;
                if (columnSortOption && columnSortOption.prop === key) {
                    nextSortIsToAsc = columnSortOption.operator !== COMPARISON_OPERATOR.LESSER_THAN;
                    colNameSpan.append(`&nbsp;<i class="fas fa-caret-${columnSortOption.operator === COMPARISON_OPERATOR.GREATER_THAN ? 'up' : 'down'}"></i>`);
                }
                cell.addClass('custom-system-clickable');
                cell.on('click', async () => {
                    fastSetFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.sortOption', {
                        prop: key,
                        operator: nextSortIsToAsc
                            ? COMPARISON_OPERATOR.LESSER_THAN
                            : COMPARISON_OPERATOR.GREATER_THAN
                    });
                    entity.render(false);
                });
            }
            cell.append(colNameSpan);
            firstRow.append(cell);
        });
        return firstRow;
    }
    /** Creates a table-row for every activeEffect */
    async _createRow(entity, activeEffect, isEditable) {
        const tableRow = $('<tr></tr>');
        tableRow.addClass('custom-system-dynamicRow');
        for (const [key, row] of Object.entries(this._staticRowLayout)
            .filter(([, col]) => col.enabled)
            .sort(([, row1], [, row2]) => row1.sort - row2.sort)) {
            const cell = $('<td></td>');
            cell.addClass('custom-system-cell');
            switch (key) {
                case 'active':
                    cell.append(this._generateActiveEffectActiveCheckbox(entity, activeEffect, isEditable));
                    break;
                case 'name':
                    cell.append(this._generateActiveEffectLink(activeEffect));
                    break;
                case 'origin':
                    if (activeEffect.parent.uuid !== entity.uuid) {
                        cell.append(this._generateActiveEffectOriginLink(activeEffect));
                    }
                    break;
                case 'description':
                    cell.append(this._generateActiveEffectDescription(activeEffect, row.format));
                    break;
                case 'count': {
                    const countField = new NumberField({
                        allowDecimal: false,
                        allowRelative: true,
                        controlsStyle: 'hover',
                        inputStyle: 'text',
                        showControls: true,
                        templateAddress: '',
                        minVal: '0',
                        size: 'small'
                    });
                    cell.append(await countField.render(entity, !row.readonly && isEditable, {
                        changeCallback: async (event) => {
                            const newValue = event.currentTarget.value;
                            await activeEffect.statusCounter.setValue(parseInt(newValue));
                            entity.render(false);
                        },
                        noName: true,
                        overrideValue: activeEffect.count
                    }));
                    break;
                }
                default:
                    break;
            }
            switch (row.align) {
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
        if (this._showDelete) {
            const controlCell = $('<td></td>');
            const controlDiv = $('<div></div>');
            controlDiv.addClass('custom-system-dynamic-table-row-icons');
            if ((isEditable &&
                this._showDelete &&
                !activeEffect.getFlag(game.system.id, 'isFromTemplate') &&
                activeEffect.parent === entity.entity) ||
                TemplateSystem.isBuilderTemplateSystem(entity)) {
                const deleteLink = $('<a><i class="fas fa-trash custom-system-deleteDynamicLine custom-system-clickable"></i></a>');
                const deleteActiveEffect = async () => {
                    if (!activeEffect.id) {
                        return;
                    }
                    await entity.entity.deleteEmbeddedDocuments('ActiveEffect', [activeEffect.id]);
                    entity.render(false);
                };
                if (this._deleteWarning) {
                    deleteLink.on('click', async () => {
                        const shouldDelete = await foundry.applications.api.DialogV2.confirm({
                            // @ts-expect-error Types too strict
                            window: {
                                title: game.i18n.localize('CSB.ComponentProperties.ItemContainer.DeleteItemDialog.Title'),
                                icon: 'fas fa-trash'
                            },
                            content: `<p>${game.i18n.localize('CSB.ComponentProperties.ItemContainer.DeleteItemDialog.Content')}</p>`,
                            defaultYes: false,
                            modal: true,
                            rejectClose: true
                        });
                        if (shouldDelete) {
                            deleteActiveEffect();
                        }
                    });
                }
                else {
                    deleteLink.on('click', deleteActiveEffect);
                }
                controlDiv.append(deleteLink);
            }
            controlCell.append(controlDiv);
            tableRow.append(controlCell);
        }
        return tableRow;
    }
    /** Generates the element to display the active checkbox in the Container */
    _generateActiveEffectActiveCheckbox(entity, activeEffect, isEditable) {
        const activeEffectBox = $('<span></span>');
        const activeEffectCheckbox = $('<input></input>');
        activeEffectCheckbox.attr('type', 'checkbox');
        if (!activeEffect.disabled) {
            activeEffectCheckbox.attr('checked', 'checked');
        }
        if (!isEditable) {
            activeEffectCheckbox.attr('readonly', 'readonly');
        }
        activeEffectCheckbox.on('click', () => {
            activeEffect.update({ disabled: !activeEffect.disabled }).then(() => {
                if (activeEffect.parent.uuid !== entity.uuid) {
                    entity.render(false);
                }
            });
        });
        activeEffectBox.append(activeEffectCheckbox);
        return activeEffectBox;
    }
    /** Generates the element to display the item link in the Container */
    _generateActiveEffectLink(activeEffect) {
        const activeEffectBox = $('<span></span>');
        const activeEffectLink = $('<a></a>');
        activeEffectLink.addClass('content-link');
        activeEffectLink.attr({
            'data-type': 'ActiveEffect',
            'data-entity': 'ActiveEffect',
            'data-id': activeEffect.id,
            'data-uuid': activeEffect.uuid,
            'data-tooltip': activeEffect.name ?? 'ActiveEffect',
            'data-link': '',
            'data-scope': '',
            draggable: 'true'
        });
        const activeEffectImg = $('<img>');
        activeEffectImg.attr({
            src: activeEffect.img,
            alt: `${activeEffect.name ?? 'Active Effect'} image`,
            draggable: 'false'
        });
        activeEffectImg.addClass('custom-system-active-effect-container-image');
        activeEffectLink.append(activeEffectImg);
        activeEffectLink.append(activeEffect.name ?? '');
        activeEffectLink.on('click', () => {
            activeEffect.sheet?.render(true);
        });
        activeEffectBox.append(activeEffectLink);
        return activeEffectBox;
    }
    /** Generates the element to display the item link in the Container */
    _generateActiveEffectOriginLink(activeEffect) {
        const activeEffectBox = $('<span></span>');
        const activeEffectLink = $('<a></a>');
        activeEffectLink.addClass('content-link');
        activeEffectLink.attr({
            'data-type': 'Item',
            'data-entity': 'Item',
            'data-id': activeEffect.parent.id,
            'data-uuid': activeEffect.parent.uuid,
            'data-tooltip': activeEffect.parent.name,
            'data-link': '',
            'data-scope': '',
            draggable: 'true'
        });
        const activeEffectImg = $('<img>');
        activeEffectImg.attr({
            src: activeEffect.parent.img,
            alt: `${activeEffect.parent.name ?? 'Item'} image`,
            draggable: 'false'
        });
        activeEffectImg.addClass('custom-system-active-effect-container-image');
        activeEffectLink.append(activeEffectImg);
        activeEffectLink.append(activeEffect.parent.name ?? '');
        activeEffectLink.on('click', () => {
            activeEffect.parent.sheet?.render(true);
        });
        activeEffectBox.append(activeEffectLink);
        return activeEffectBox;
    }
    _generateActiveEffectDescription(activeEffect, format) {
        if (format === DESCRIPTION_FORMAT.SHORT) {
            const fullDescription = activeEffect.description;
            if (fullDescription.length === 0) {
                return '';
            }
            const firstElt = $(fullDescription)[0];
            const descriptionHTML = firstElt.innerHTML;
            if (firstElt.tagName === 'ul' || firstElt.tagName === 'ol')
                Array.from(firstElt.children).forEach((value, idx) => {
                    if (idx > 0) {
                        value.remove();
                    }
                });
            if (descriptionHTML.includes('.')) {
                return $(`<${firstElt.tagName}>${firstElt.innerHTML.split('.')[0]}.</${firstElt.tagName}>`)[0]
                    .outerHTML;
            }
            else {
                return firstElt.outerHTML;
            }
        }
        else {
            return activeEffect.description;
        }
    }
    /**
     * Gets all relevant Active Effet based on the COntainer configuration
     */
    _getFilteredEffects(entity) {
        let relevantEffects = Array.from(entity.entity.allApplicableEffects({ excludeExternal: this._showOnlyOwnEffects, excludeTransfer: false }));
        if (this._filterTags.length > 0) {
            relevantEffects = relevantEffects.filter((effect) => effect.tags.some((tag) => this._filterTags.includes(tag)));
        }
        return relevantEffects;
    }
    /**
     * Sorts an array of active effects based on sort predicates
     */
    _sortEffects(effects, entity) {
        let columnSortOption = undefined;
        let sortProp;
        let aValue, bValue;
        switch (this._sortOption) {
            case TABLE_SORT_OPTION.MANUAL:
                columnSortOption = game.user.getFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.sortOption');
                sortProp = columnSortOption?.prop ?? 'name';
                // Get all properties and collect all relevant rows (not-deleted)
                effects.sort((a, b) => {
                    switch (sortProp) {
                        case 'active':
                            aValue = a.active;
                            bValue = b.active;
                            break;
                        case 'name':
                            aValue = a.name ?? '';
                            bValue = b.name ?? '';
                            break;
                        case 'origin':
                            aValue = a.parent.name;
                            bValue = b.parent.name;
                            break;
                        case 'description':
                            aValue = $(a.description).text();
                            bValue = $(b.description).text();
                            break;
                        case 'count':
                            aValue = a.count;
                            bValue = b.count;
                            break;
                        default:
                            break;
                    }
                    return ActiveEffectContainer.getSortOrder(aValue, bValue, undefined, columnSortOption?.operator ?? COMPARISON_OPERATOR.LESSER_THAN);
                });
                break;
            case TABLE_SORT_OPTION.DISABLED:
            default:
                effects.sort((a, b) => a._stats.createdTime - b._stats.createdTime);
                break;
        }
        return effects;
    }
}
/**
 * @ignore
 */
export default ActiveEffectContainer;
