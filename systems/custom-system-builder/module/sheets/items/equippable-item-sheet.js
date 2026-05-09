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
import CustomItem from '../../documents/CustomItem.js';
import Logger from '../../Logger.js';
import { isBaseSheetTemplateEntity } from '../../definitions.js';
/**
 * Extend the basic ItemSheet
 * @abstract
 * @extends {ItemSheet}
 * @ignore
 */
export class EquippableItemSheet extends ItemSheet {
    hasBeenRenderedOnce = false;
    get item() {
        return super.item;
    }
    constructor(item, options) {
        options.resizable = !item.system.display?.fix_size;
        super(item, options);
    }
    /** @override */
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            classes: ['custom-system', 'sheet', 'item', 'item-v1'],
            template: 'systems/' + game.system.id + '/templates/item/item-sheet.hbs',
            width: 600,
            height: 600,
            tabs: [
                {
                    navSelector: '.sheet-tabs',
                    contentSelector: '.sheet-body'
                }
            ],
            scrollY: ['.custom-system-actor-content'],
            dragDrop: [{ dragSelector: '.item-list .item', dropSelector: null }]
        });
    }
    /**
     * @override
     * @ignore
     */
    get template() {
        return `systems/${game.system.id}/templates/item/${this.item.type}-sheet.hbs`;
    }
    get title() {
        return super.title + (this.item.templateSystem.isModified ? ' *' : '');
    }
    /**
     * Define whether a user is able to begin a dragstart workflow for a given drag selector
     * @param selector       The candidate HTML selector for dragging
     * @returns              Can the current user drag this selector?
     * @protected
     * @override
     * @ignore
     */
    _canDragStart(_selector) {
        return this.isEditable;
    }
    /* -------------------------------------------- */
    /**
     * Define whether a user is able to conclude a drag-and-drop workflow for a given drop selector
     * @param selector       The candidate HTML selector for the drop target
     * @returns              Can the current user drop on this selector?
     * @protected
     * @override
     * @ignore
     */
    _canDragDrop(_selector) {
        return this.isEditable;
    }
    /* -------------------------------------------- */
    /** @override */
    async getData() {
        // Retrieve the data structure from the base sheet. You can inspect or log
        // the context variable to see the structure, but some key properties for
        // sheets are the actor object, the data object, whether or not it's
        // editable, the items array, and the effects array.
        const baseContext = super.getData();
        if (!(baseContext.item instanceof CustomItem)) {
            throw new Error('Tried to render an ActiveEffectContainerSheet without a CustomItem');
        }
        const context = {
            ...baseContext,
            ...(await baseContext.item.templateSystem.getSheetData()),
            isEmbedded: baseContext.item.isEmbedded,
            isEditable: this.isEditable,
            canEditModifiers: baseContext.item.canEditModifiers
        };
        return context;
    }
    /**
     * @override
     * @ignore
     */
    render(force, options = {}) {
        if (isBaseSheetTemplateEntity(this.item)) {
            if (!this.hasBeenRenderedOnce) {
                this.position.width = this.item.system.display.width;
                this.position.height = this.item.system.display.height;
                this.hasBeenRenderedOnce = true;
            }
            this.options.resizable = !this.item.system.display.fix_size;
        }
        if (this.item.system.container) {
            const parentCollection = this.item.getParentCollection();
            parentCollection.get(this.item.system.container).prepareData();
            parentCollection.get(this.item.system.container).render(false);
        }
        return super.render(force, options);
    }
    async _onSubmit(event, options) {
        if (game.settings.get(game.system.id, 'manualEntitySaving') && event.type === 'change') {
            await this.item.templateSystem.handleSheetSubmit();
            return {};
        }
        else {
            this.item.templateSystem.isModified = false;
            return super._onSubmit(event, options);
        }
    }
    /**
     * Render the inner application content
     * @param data         The data used to render the inner template
     * @returns  A promise resolving to the constructed jQuery object
     * @private
     * @override
     * @ignore
     */
    async _renderInner(data) {
        if (this.item.templateSystem.isModified) {
            this.submit();
        }
        const html = await super._renderInner(data);
        // Append built sheet to html
        html.find('.custom-system-customHeader').append(data.headerPanel);
        html.find('.custom-system-customBody').append(data.bodyPanel);
        return html;
    }
    /** @override */
    activateListeners(html) {
        this.item.templateSystem.activateListeners(html);
        super.activateListeners(html);
    }
    /** @override */
    async _onDrop(event) {
        const data = TextEditor.getDragEventData(event);
        if (data && data.type === 'Item') {
            if (this.actor && !this.actor.isOwner)
                return false;
            const item = await CustomItem.fromDropData(data);
            if (CustomItem.isEquippableItem(item)) {
                Logger.debug('Got item data ' + item.name);
                // Building list of container ids of the new item position, from nearest to farthest up
                const targetContainerTree = [
                    this.item.id,
                    ...this.item.getAllContainerIds(),
                    ...(this.actor ? [this.actor.id] : [])
                ];
                // If the item is in the new container list, we cannot update it (it would contain itself)
                if (targetContainerTree.includes(item._id)) {
                    ui.notifications.error(game.i18n.localize('CSB.UserMessages.CannotMoveItemInItself'));
                    Logger.error(game.i18n.localize('CSB.UserMessages.CannotMoveItemInItself'));
                    return;
                }
                // Calculating if the item is moved in the same entity, meaning it has an item containing both the old container and the new one
                const targetParentActor = this.actor;
                const originalParentActor = item.parent;
                let originalContainerTree = [];
                let originalContainer = undefined;
                // If the item had a container, we fetch it
                if (item.system.container) {
                    if (originalParentActor) {
                        originalContainer = originalParentActor.items.get(item.system.container);
                    }
                    else {
                        originalContainer = game.items.get(item.system.container);
                    }
                    // And we get the old container list
                    originalContainerTree = [originalContainer.id, ...originalContainer.getAllContainerIds()];
                }
                // We add the old actor id to the list, if in an actor, to move items from the actor to an item in the actor
                if (originalParentActor) {
                    originalContainerTree.push(originalParentActor.id);
                }
                // If an id in the original container list matches an id in the new container list, we shoudl move the item instead of copying it
                const isMove = originalContainerTree.some((id) => {
                    return targetContainerTree.includes(id);
                });
                if (isMove) {
                    const itemOrigin = originalContainer ?? originalParentActor;
                    Logger.info(`Moving item ${item.name} from ${itemOrigin?.name ?? 'item sidebar'} to ${this.item.name}${this.actor ? ` in ${this.actor.name}` : ''}`);
                    return CustomItem.updateDocuments([
                        {
                            _id: item._id,
                            system: { container: this.item.id }
                        }
                    ], { parent: targetParentActor }).then(() => {
                        itemOrigin?.render(false);
                        this.render(false);
                    });
                }
                Logger.info(`Creating item ${item.name} in item ${this.item.name}`);
                return this._onDropItemCreate(item, event);
            }
        }
    }
    /**
     * Handle the final creation of dropped Item data on the Actor.
     * @protected
     */
    async _onDropItemCreate(itemData, _event) {
        const items = (itemData instanceof Array ? itemData : [itemData]).filter((item) => CustomItem.isEquippableItem(item));
        if (!CustomItem.isEquippableItem(this.item)) {
            return [];
        }
        // Create the owned items & contents as normal
        const toCreate = await CustomItem.createWithContents(items, this.item);
        Logger.info('Created items ' + toCreate.map((item) => item._id));
        const newItemPromise = CustomItem.createDocuments(toCreate, {
            pack: this.actor?.pack,
            parent: this.actor,
            keepId: true
        });
        newItemPromise.then(() => {
            this.render(false);
        });
        return newItemPromise;
    }
}
let focusedElt;
/* Insert tabs & header on sheet rendering */
Hooks.on('renderEquippableItemSheet', function (app, html, _data) {
    // Register in-sheet rich text editors
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore Going around the protected modifier on this
    html.find('.editor-content[data-edit]').each((_i, div) => app._activateEditor(div));
    html.find('*').on('focus', (ev) => {
        focusedElt = ev.currentTarget.id;
        globalThis.focusedApp = app.id;
    });
    if (focusedElt && globalThis.focusedApp === app.id) {
        html.find('#' + focusedElt).trigger('focus');
    }
});
