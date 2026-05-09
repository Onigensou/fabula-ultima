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
import { getLocalizedAlignmentList } from '../../utils.js';
const defaultFlow = 'vertical';
const defaultAlign = 'center';
const defaultTitleStyle = 'default';
export const LAYOUTS = {
    vertical: 'CSB.ComponentProperties.Panel.PanelLayout.Vertical',
    horizontal: 'CSB.ComponentProperties.Panel.PanelLayout.Horizontal',
    'grid-2': 'CSB.ComponentProperties.Panel.PanelLayout.GridOf2',
    'grid-3': 'CSB.ComponentProperties.Panel.PanelLayout.GridOf3',
    'grid-4': 'CSB.ComponentProperties.Panel.PanelLayout.GridOf4',
    'grid-5': 'CSB.ComponentProperties.Panel.PanelLayout.GridOf5',
    'grid-6': 'CSB.ComponentProperties.Panel.PanelLayout.GridOf6',
    'grid-7': 'CSB.ComponentProperties.Panel.PanelLayout.GridOf7',
    'grid-8': 'CSB.ComponentProperties.Panel.PanelLayout.GridOf8',
    'grid-9': 'CSB.ComponentProperties.Panel.PanelLayout.GridOf9',
    'grid-10': 'CSB.ComponentProperties.Panel.PanelLayout.GridOf10',
    'grid-11': 'CSB.ComponentProperties.Panel.PanelLayout.GridOf11',
    'grid-12': 'CSB.ComponentProperties.Panel.PanelLayout.GridOf12'
};
export const TITLE_STYLES = {
    default: 'Default',
    title: 'Title'
};
/**
 * Panel component
 * @ignore
 */
class Panel extends Container {
    /**
     * Panel flow
     */
    _flow;
    /**
     * Panel alignment
     */
    _align;
    /**
     * Panel collapsible
     */
    _collapsible;
    /**
     * Panel default collapsed
     */
    _defaultCollapsed;
    /**
     * Panel title
     */
    _title;
    /**
     * Panel title style
     */
    _titleStyle;
    /**
     * Constructor
     */
    constructor(props) {
        super(props);
        this._flow = props.flow ?? defaultFlow;
        this._align = props.align ?? defaultAlign;
        this._collapsible = props.collapsible ?? false;
        this._defaultCollapsed = props.defaultCollapsed ?? true;
        this._title = props.title ?? '';
        this._titleStyle = props.titleStyle ?? defaultTitleStyle;
    }
    /**
     * Renders component
     * @override
     * @param entity Rendered entity (actor or item)
     * @param isEditable Is the component editable by the current user?
     * @param options
     * @return The jQuery element holding the component
     */
    async _getElement(entity, isEditable = true, options = {}) {
        let jQElement = await super._getElement(entity, isEditable, options);
        const internalContents = jQElement.hasClass('custom-system-component-contents')
            ? jQElement
            : jQElement.find('.custom-system-component-contents');
        let layoutClass = '';
        switch (this._flow) {
            case 'vertical':
                layoutClass = '';
                break;
            case 'horizontal':
                layoutClass = 'flexrow';
                break;
            default:
                if (/^grid-([1-9]$|1[0-2]$)/.test(this._flow)) {
                    layoutClass = 'grid grid-' + this._flow.substring(5) + 'col';
                }
                break;
        }
        internalContents.addClass(layoutClass);
        let alignClass;
        switch (this._align) {
            case 'center':
                alignClass = 'flex-group-center';
                break;
            case 'left':
                alignClass = 'flex-group-left';
                break;
            case 'right':
                alignClass = 'flex-group-right';
                break;
            case 'justify':
                alignClass = 'flex-between';
                break;
            default:
                alignClass = '';
                break;
        }
        internalContents.addClass(alignClass);
        internalContents.addClass('custom-system-panel');
        internalContents.append(await this.renderContents(entity, isEditable, options));
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            internalContents.append(await this.renderTemplateControls(entity));
        }
        if (this._collapsible) {
            const isExtended = game.user.getFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.extended') ??
                !this._defaultCollapsed;
            const detailsElt = $('<details></details>');
            if (this.key) {
                detailsElt.addClass(`custom-system-details-${this.key}`);
            }
            detailsElt.on('toggle', (e) => {
                game.user.setFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.extended', e.currentTarget.open);
            });
            if (isExtended) {
                detailsElt.attr('open', 'open');
            }
            const summaryElt = $('<summary></summary>');
            let titleStyleTag = 'span';
            switch (this._titleStyle) {
                case 'title':
                    titleStyleTag = 'h3';
                    break;
                default:
                    break;
            }
            const titleElt = $(`<${titleStyleTag}></${titleStyleTag}>`);
            titleElt.addClass('custom-system-panel-' + this._titleStyle);
            titleElt.append(this._title ?? '');
            summaryElt.append(titleElt);
            summaryElt.on('click', (e) => {
                e.preventDefault();
                if (e.currentTarget.parentElement.open) {
                    internalContents.slideUp(100, () => {
                        $(e.currentTarget.parentElement).removeAttr('open');
                    });
                }
                else {
                    $(e.currentTarget.parentElement).attr('open', 'open');
                    internalContents.slideUp(0, () => {
                        internalContents.slideDown(100);
                    });
                }
            });
            detailsElt.append(summaryElt);
            detailsElt.append('<hr>');
            detailsElt.append(internalContents);
            if (internalContents === jQElement) {
                jQElement = detailsElt;
            }
            else {
                jQElement.append(detailsElt);
            }
        }
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
            flow: this._flow,
            align: this._align,
            collapsible: this._collapsible,
            defaultCollapsed: this._defaultCollapsed,
            title: this._title,
            titleStyle: this._titleStyle
        };
    }
    /**
     * Creates Panel from JSON description
     */
    static fromJSON(json, templateAddress, parent) {
        const panel = new Panel({
            ...json,
            contents: [],
            parent: parent,
            templateAddress: templateAddress
        });
        panel._contents = componentFactory.createMultipleComponents(json.contents, templateAddress + '-contents', panel);
        return panel;
    }
    /**
     * Gets technical name for this component's type
     * @return The technical name
     * @throws {Error} If not implemented
     */
    static getTechnicalName() {
        return 'panel';
    }
    /**
     * Gets pretty name for this component's type
     * @return The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.Panel');
    }
    /**
     * Get configuration form for component creation / edition
     * @return The jQuery element holding the component
     */
    static async getConfigForm(_entity, appId, existingComponent) {
        const predefinedValuesComponent = { ...existingComponent };
        predefinedValuesComponent.collapsible = predefinedValuesComponent.collapsible ?? false;
        predefinedValuesComponent.defaultCollapsed = predefinedValuesComponent.defaultCollapsed ?? false;
        predefinedValuesComponent.title = predefinedValuesComponent.title ?? '';
        predefinedValuesComponent.titleStyle = predefinedValuesComponent.titleStyle ?? defaultTitleStyle;
        predefinedValuesComponent.align = predefinedValuesComponent.align ?? defaultAlign;
        predefinedValuesComponent.flow = predefinedValuesComponent.flow ?? defaultFlow;
        const mainElt = document.createElement('div');
        mainElt.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/components/panel.hbs`, {
            ...predefinedValuesComponent,
            ALIGNMENTS: getLocalizedAlignmentList(true),
            TITLE_STYLES,
            LAYOUTS,
            appId
        });
        const toggleCollapsibleOption = (display) => {
            const collapsiblePanelOptions = mainElt.querySelector('.collapsiblePanelOptions');
            if (display) {
                collapsiblePanelOptions.style.display = 'block';
            }
            else {
                collapsiblePanelOptions.style.display = 'none';
            }
        };
        mainElt.querySelectorAll('[name="collapsible"]').forEach((element) => {
            element.addEventListener('change', (event) => {
                const target = event.currentTarget;
                toggleCollapsibleOption(target.value === 'true');
            });
        });
        toggleCollapsibleOption(!!predefinedValuesComponent.collapsible);
        return mainElt;
    }
    /**
     * Extracts configuration from submitted HTML form
     * @override
     * @param html The submitted form
     * @return The JSON representation of the component
     * @throws {Error} If configuration is not correct
     */
    static extractConfig(rawConfigData, html) {
        const configData = rawConfigData;
        const superFieldData = super.extractConfig(configData, html);
        const fieldData = {
            ...superFieldData,
            flow: configData.flow ?? defaultFlow,
            align: configData.align ?? defaultAlign,
            collapsible: configData.collapsible === 'true',
            defaultCollapsed: configData.defaultCollapsed === 'true',
            title: configData.title,
            titleStyle: configData.titleStyle
        };
        return fieldData;
    }
}
/**
 * @ignore
 */
export default Panel;
