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
import { CustomActorSheetV2 } from './actor-sheet.js';
import CustomItem from '../../../documents/CustomItem.js';
import Logger from '../../../Logger.js';
/**
 * The character actor sheets
 * @extends {CustomActorSheetV2}
 */
export class CharacterSheetV2 extends CustomActorSheetV2 {
    static DEFAULT_OPTIONS = {
        ...super.DEFAULT_OPTIONS,
        dragDrop: [{ dragSelector: '.item-list .item', dropSelector: null }],
        window: {
            ...super.DEFAULT_OPTIONS.window,
            controls: [
                ...(super.DEFAULT_OPTIONS.window?.controls ?? []),
                {
                    label: 'CSB.Sheets.SeeHiddenAttributes',
                    icon: 'fas fa-eye-slash',
                    action: 'openHiddenAttributes',
                    ownership: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
                },
                {
                    label: 'CSB.Sheets.SeeAttributeBars',
                    icon: 'fas fa-bars-progress',
                    action: 'openAttributeBars',
                    ownership: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
                }
            ]
        },
        actions: {
            ...super.DEFAULT_OPTIONS.actions,
            openHiddenAttributes: CharacterSheetV2.openHiddenAttributes,
            openAttributeBars: CharacterSheetV2.openAttributeBars
        }
    };
    static PARTS = {
        form: {
            get template() {
                return `systems/${game.system.id}/templates/actor/v2/actor-character-sheet.hbs`;
            },
            classes: super.PARTS.form.classes
        }
    };
    static openHiddenAttributes(_event, _target) {
        this.actor.templateSystem.openAttributesVision();
    }
    static openAttributeBars(_event, _target) {
        this.actor.templateSystem.openAttributeBarsVision();
    }
    /* ------------------------------------- */
    dragDrop;
    constructor(options = {}) {
        super(options);
        this.dragDrop = this.createDragDropHandlers();
    }
    createDragDropHandlers() {
        return this.options.dragDrop.map((d) => {
            d.permissions = {
                dragstart: this._canDragStart.bind(this),
                drop: this._canDragDrop.bind(this)
            };
            d.callbacks = {
                dragstart: this._onDragStart.bind(this),
                dragover: this._onDragOver.bind(this),
                drop: this._onDrop.bind(this)
            };
            return new DragDrop(d);
        });
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
    /**
     * Actions performed after any render of the Application.
     * Post-render steps are not awaited by the render process.
     */
    _onRender(context, options) {
        super._onRender(context, options);
        this.dragDrop.forEach((d) => d.bind(this.element));
    }
    /**
     * Callback actions which occur at the beginning of a drag start workflow.
     * @param {DragEvent} event       The originating DragEvent
     * @protected
     */
    _onDragStart(event) {
        // Extract the data you need
        const dragData = null;
        if (!dragData)
            return;
        // Set data transfer
        event.dataTransfer.setData('text/plain', JSON.stringify(dragData));
    }
    /**
     * Callback actions which occur when a dragged element is over a drop target.
     * @protected
     */
    _onDragOver(_event) { }
    /**
     * Callback actions which occur when a dragged element is dropped on a target.
     * @param {DragEvent} event       The originating DragEvent
     * @protected
     */
    async _onDrop(event) {
        if (!this.actor.isOwner)
            return false;
        const data = TextEditor.getDragEventData(event);
        if (data) {
            const dragData = data;
            // Handle different data types
            switch (dragData.type) {
                case 'Item':
                    return this._onDropItem(event, dragData);
            }
        }
    }
    /**
     * Handle dropping of an item reference or item data onto an Actor Sheet
     * @returns   The created or updated Item instances, or false if the drop was not permitted.
     * @protected
     */
    async _onDropItem(event, data) {
        if (!this.actor.isOwner)
            return false;
        const item = await Item.implementation.fromDropData(data);
        if (item && CustomItem.isEquippableItem(item)) {
            // Handle item sorting within the same Actor
            if (this.actor.uuid === item.parent?.uuid) {
                if (item.system.container !== null && item.system.container !== undefined) {
                    const originalParent = this.actor.items.get(item.system.container);
                    return await item.update({ system: { container: null } }).then(() => {
                        originalParent.render(false);
                        this.render({ force: false });
                    });
                }
            }
            // Create the owned item
            return this._onDropItemCreate(item, event);
        }
        return false;
    }
    /**
     * Handle the final creation of dropped Item data on the Actor.
     * @protected
     */
    async _onDropItemCreate(itemData, _event) {
        const items = itemData instanceof Array ? itemData : [itemData];
        // Create the owned items & contents as normal
        const toCreate = await CustomItem.createWithContents(items);
        Logger.info('Created item contents ' + toCreate.map((item) => item._id).join(', '));
        return CustomItem.createDocuments(toCreate, { pack: this.actor.pack, parent: this.actor, keepId: true });
    }
    async _processSubmitData(event, form, submitData) {
        if (game.settings.get(game.system.id, 'manualEntitySaving') && event.type === 'change') {
            return this.actor.templateSystem.handleSheetSubmit();
        }
        else {
            this.actor.templateSystem.isModified = false;
            return super._processSubmitData(event, form, submitData);
        }
    }
    async close(options) {
        await this.submit();
        return super.close(options);
    }
}
