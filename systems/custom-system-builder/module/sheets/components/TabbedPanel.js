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
import Tab from './Tab.js';
import TabEditorDialog from '../../applications/TabEditorDialog.js';
/**
 * Tabbed Panel component
 * @ignore
 */
class TabbedPanel extends Container {
    /**
     * Can container accept dropped components ?
     */
    static droppable = false;
    _contents;
    constructor(props) {
        super(props);
        this._contents = props.contents ?? [];
    }
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
        let activeKey = null;
        const renderableTabs = this.contents.filter((tab) => tab.canBeRendered(entity));
        try {
            activeKey = String(game.user.getFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.activeTab'));
        }
        catch (_e) {
            // Nothing should happen
        }
        if (renderableTabs.filter((tab) => tab.key === activeKey).length === 0) {
            activeKey = renderableTabs?.[0]?.key;
        }
        // Generating content
        const tabSection = $('<section></section>');
        const tabsContent = {};
        // Generating nav
        const tabNav = $('<nav></nav>');
        const tabsLink = {};
        tabNav.addClass('custom-tabs');
        for (const tab of renderableTabs) {
            tabsContent[tab.key] = await tab.render(entity, isEditable, options);
            tabSection.append(tabsContent[tab.key]);
            const tabSpan = $('<span></span>');
            if (tab.tooltip) {
                tabSpan.attr('title', tab.tooltip);
            }
            const tabLink = $('<a></a>');
            tabLink.addClass('item');
            tabLink.addClass(tab.key);
            tabLink.text(tab.name);
            tabLink.on('click', () => {
                tabsContent[activeKey].removeClass('active');
                tabsContent[tab.key].addClass('active');
                tabsLink[activeKey].removeClass('active');
                tabLink.addClass('active');
                game.user.setFlag(game.system.id, entity.uuid + '.' + this.templateAddress + '.activeTab', tab.key);
                activeKey = tab.key;
            });
            tabsLink[tab.key] = tabLink;
            tabSpan.append(tabLink);
            if (TemplateSystem.isBuilderTemplateSystem(entity)) {
                const sortLeftTabButton = $('<a><i class="fas fa-caret-left custom-system-clickable"></i></a>');
                sortLeftTabButton.addClass('item custom-system-sort-left');
                sortLeftTabButton.attr('title', game.i18n.localize('CSB.ComponentProperties.TabbedPanel.SortTabToLeft'));
                sortLeftTabButton.on('click', () => {
                    tab.sortBeforeInParent(entity);
                });
                tabLink.before(sortLeftTabButton);
                const sortRightTabButton = $('<a><i class="fas fa-caret-right custom-system-clickable"></i></a>');
                sortRightTabButton.addClass('item custom-system-sort-right');
                sortRightTabButton.attr('title', game.i18n.localize('CSB.ComponentProperties.TabbedPanel.SortTabToRight'));
                sortRightTabButton.on('click', () => {
                    tab.sortAfterInParent(entity);
                });
                tabLink.after(sortRightTabButton);
            }
            tabNav.append(tabSpan);
        }
        if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            const controlSpan = $('<span></span>');
            const addTabButton = $('<a><i class="fas fa-plus-circle custom-system-clickable"></i></a>');
            addTabButton.addClass('item');
            addTabButton.addClass('custom-system-builder-add-tab');
            addTabButton.attr('title', game.i18n.localize('CSB.ComponentProperties.TabbedPanel.AddTab'));
            addTabButton.on('click', () => {
                new TabEditorDialog(this, entity).render({ force: true });
            });
            const editTabButton = $('<a><i class="fas fa-edit custom-system-clickable"></i></a>');
            editTabButton.addClass('item');
            editTabButton.addClass('custom-system-builder-edit-tab');
            editTabButton.attr('title', game.i18n.localize('CSB.ComponentProperties.TabbedPanel.EditTab'));
            editTabButton.on('click', () => {
                if (activeKey) {
                    const tab = this.contents.filter((tab) => tab.key === activeKey)[0];
                    new TabEditorDialog(this, entity, tab).render({ force: true });
                }
            });
            const deleteTabButton = $('<a><i class="fas fa-trash custom-system-clickable"></i></a>');
            deleteTabButton.addClass('item');
            deleteTabButton.addClass('custom-system-builder-delete-tab');
            deleteTabButton.attr('title', game.i18n.localize('CSB.ComponentProperties.TabbedPanel.DeleteTab'));
            deleteTabButton.on('click', () => {
                if (activeKey) {
                    this.contents.filter((tab) => tab.key === activeKey)[0].delete(entity);
                }
            });
            controlSpan.append(addTabButton);
            controlSpan.append(editTabButton);
            controlSpan.append(deleteTabButton);
            tabNav.append(controlSpan);
        }
        const jQElement = await super._getElement(entity, isEditable, options);
        const internalContents = jQElement.hasClass('custom-system-component-contents')
            ? jQElement
            : jQElement.find('.custom-system-component-contents');
        internalContents.append(tabNav);
        internalContents.append(tabSection);
        if (activeKey) {
            tabsContent[activeKey].addClass('active');
            tabsLink[activeKey].addClass('active');
        }
        return jQElement;
    }
    /**
     * Creates Tabbed Panel from JSON description
     * @override
     * @param {ContainerJson} json
     * @param {string} templateAddress
     * @param {Container|null} parent
     * @return {TabbedPanel}
     */
    static fromJSON(json, templateAddress, parent) {
        const tabbedPanel = new TabbedPanel({
            ...json,
            contents: [],
            parent: parent,
            templateAddress: templateAddress
        });
        tabbedPanel._contents =
            json?.contents?.map((tab, index) => Tab.fromJSON(tab, templateAddress + '-contents-' + index, tabbedPanel)) ?? [];
        return tabbedPanel;
    }
    /**
     * Gets technical name for this component's type
     * @return The technical name
     * @throws {Error} If not implemented
     */
    static getTechnicalName() {
        return 'tabbedPanel';
    }
    /**
     * Gets pretty name for this component's type
     * @returns The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.TabbedPanel');
    }
    /** Get configuration form for component creation / edition */
    static async getConfigForm(_entity, appId, existingComponent) {
        const mainElt = document.createElement('div');
        mainElt.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/components/tabbed-panel.hbs`, {
            ...existingComponent,
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
    static extractConfig(configData, html) {
        return super.extractConfig(configData, html);
    }
}
/**
 * @ignore
 */
export default TabbedPanel;
