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
let modifiersDialog = null;
const modifiers = async (callback, blocks) => {
    // Render the dialog's contents
    let content = await renderTemplate(`systems/${game.system.id}/templates/_template/dialogs/modifiers.hbs`, {
        blocks,
        MODIFIER_OPERATORS: {
            add: '+',
            multiply: 'x',
            subtract: '-',
            divide: '/',
            set: '='
        }
    });
    if (modifiersDialog && modifiersDialog.rendered) {
        await modifiersDialog.close();
    }
    // Create the dialog
    modifiersDialog = new Dialog({
        title: game.i18n.localize('CSB.Modifier.EditDialog.Title'),
        content: content,
        buttons: {
            validate: {
                icon: '<i class="fas fa-check"></i>',
                label: game.i18n.localize('Save'),
                callback: (html) => {
                    let newModifiers = {};
                    let modifierBlocks = html.find('.custom-system-modifiers');
                    for (let block of modifierBlocks) {
                        if ($(block).data('block-editable')) {
                            let blockId = $(block).data('block-id');
                            // Fetch all attribute rows
                            let modifierEltList = $(block).find('tr.custom-system-modifier');
                            /**
                             * @type {Modifier[]}
                             */
                            let modifierList = [];
                            // For each of them, recover key and formula, and ensure none is empty
                            for (let modifierElt of modifierEltList) {
                                let modifierId = $(modifierElt).find('.custom-system-modifier-id')?.val() ||
                                    foundry.utils.randomID();
                                let modifierConditionalGroup = $(modifierElt)
                                    .find('.custom-system-modifier-conditionalGroup')
                                    .val();
                                let modifierPriority = $(modifierElt)
                                    .find('.custom-system-modifier-priority')
                                    .val();
                                let modifierKey = $(modifierElt).find('.custom-system-modifier-key').val();
                                let modifierOperator = $(modifierElt)
                                    .find('.custom-system-modifier-operator')
                                    .val();
                                let modifierFormula = $(modifierElt).find('.custom-system-modifier-formula').val();
                                let modifierDescription = $(modifierElt)
                                    .find('.custom-system-modifier-description')
                                    .val();
                                if (modifierKey === '' || modifierFormula === '') {
                                    throw new Error(game.i18n.localize('CSB.Modifier.EditDialog.MissingData'));
                                }
                                modifierList.push({
                                    id: modifierId,
                                    conditionalGroup: modifierConditionalGroup,
                                    priority: Number.isNaN(Number(modifierPriority)) ? 0 : Number(modifierPriority),
                                    key: modifierKey,
                                    operator: modifierOperator,
                                    formula: modifierFormula,
                                    description: modifierDescription
                                });
                            }
                            newModifiers[blockId] = modifierList;
                        }
                    }
                    callback(newModifiers);
                }
            },
            cancel: {
                icon: '<i class="fas fa-times"></i>',
                label: game.i18n.localize('Cancel')
            }
        },
        default: 'cancel',
        render: (html) => {
            let dialogElt = html.find('.custom-system-modifiers').parents('.dialog');
            dialogElt.css({ 'max-height': '75%' });
            html.find('.custom-system-block-title').on('click', (ev) => {
                let target = $(ev.currentTarget);
                let blockId = target.data('block-id');
                let modifiersDiv = html.find('#modifiers_' + blockId);
                if (modifiersDiv.is(':visible')) {
                    modifiersDiv.slideUp(500);
                    target.find('.fa-caret-down').addClass('fa-caret-right').removeClass('fa-caret-down');
                }
                else {
                    modifiersDiv.slideDown(500);
                    target.find('.fa-caret-right').addClass('fa-caret-down').removeClass('fa-caret-right');
                }
            });
            // Add attributes button
            html.find('.custom-system-modifiers #addModifier').on('click', (ev) => {
                const target = $(ev.currentTarget);
                // Last row contains only the add button
                const lastRow = target.parents('tr');
                // Create new row
                const newRow = $(html).find('#custom-system-modifier-template')[0].content.cloneNode(true);
                $(newRow).find('.custom-system-modifier-id').val(foundry.utils.randomID());
                // Insert new row before control row
                lastRow.before(newRow);
            });
            // Delete attribute button
            html.on('click', '.custom-system-modifiers .custom-system-delete-modifier', (ev) => {
                // Get attributes row
                const target = $(ev.currentTarget);
                let row = target.parents('tr');
                // Remove it from the DOM
                $(row).remove();
            });
            html.on('keydown', (event) => {
                event.stopPropagation();
            });
        }
    }, {
        height: 'auto',
        width: 600,
        resizable: true
    });
    modifiersDialog.render(true);
};
export default {
    modifiers
};
