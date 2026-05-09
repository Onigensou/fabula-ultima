/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { getDiceGroupsFromRoll } from './utils.js';
// Displays roll explanation in a floating div
async function expandMfsRoll(ev) {
    // Get clicked roll
    const target = ev.currentTarget;
    const data = $(target).data('roll-data');
    if (data) {
        data.arrayExplanation = [];
        // Adding roll results to the explanation
        for (const roll of data.rolls) {
            const rollObject = Roll.fromJSON(JSON.stringify(roll.roll));
            const rollGroups = getDiceGroupsFromRoll(rollObject);
            /* let htmlTooltip = $(await rollObject.getTooltip());
            let diceIcons = htmlTooltip.find('.dice-rolls li');

            let spanIcons = [];
            for (let icon of diceIcons) {
                let span = $('<span>');
                span.addClass($(icon).attr('class'));
                span.addClass('custom-system-roll-tooltip-dice');
                span.text($(icon).text());

                spanIcons.push(span.prop('outerHTML'));
            } */
            data.arrayExplanation.push({
                name: roll.formula,
                value: roll.roll.total,
                dice: rollGroups
            });
        }
        function getFormattedExplanation(node, branch = '') {
            const isGraphHead = branch.length === 0;
            const children = node.children || [];
            if (node.display) {
                let correctedToken = node.display;
                const specialCharCodes = correctedToken.matchAll(/\u037E([0-9]+)\u037E/g);
                let charCode = specialCharCodes.next();
                while (!charCode.done) {
                    const charCodeNumber = Number(charCode.value[1]);
                    correctedToken = correctedToken.replace('\u037E' + charCodeNumber + '\u037E', String.fromCodePoint(charCodeNumber));
                    charCode = specialCharCodes.next();
                }
                let branchHead = '';
                if (!isGraphHead) {
                    branchHead = children && children.length !== 0 ? '┬&nbsp;' : '─&nbsp;';
                }
                const offset = branch + branchHead;
                data.arrayExplanation.push({
                    name: correctedToken,
                    value: node.value,
                    offset: '<span style="font-family: monospace">' +
                        (offset.length > 0 ? '&nbsp;' : '') +
                        offset +
                        '</span>'
                });
            }
            let baseBranch = branch;
            if (!isGraphHead) {
                const isChildOfLastBranch = branch.slice(-2) === '└─';
                baseBranch = branch.slice(0, -2) + (isChildOfLastBranch ? '&nbsp;&nbsp;' : '│&nbsp;');
            }
            const nextBranch = baseBranch + '├─';
            const lastBranch = baseBranch + '└─';
            children.forEach((child, index) => {
                getFormattedExplanation(child, children.length - 1 === index ? lastBranch : nextBranch);
            });
        }
        for (const node of Array.from(data.tokens.children)) {
            getFormattedExplanation(node);
        }
        // Get message element
        const message = $(target).parents('.message-content');
        if (data) {
            const template_file = `systems/${game.system.id}/templates/chat/chat-roll-tooltip.hbs`;
            // Render explanation template
            renderTemplate(template_file, data).then((html) => {
                // Add last-minute CSS
                const tooltipWrapper = $(html)[0];
                const tooltip = tooltipWrapper.children[0];
                // Append the explanation to the message (Adding to DOM)
                message.append($(tooltipWrapper));
                $(tooltip).css({
                    width: `max-content`,
                    'min-width': `280px`,
                    'max-width': `800px`
                });
                // Set the position
                const pa = target.getBoundingClientRect();
                const pt = tooltip.getBoundingClientRect();
                const zi = getComputedStyle(target).zIndex;
                $(tooltip).css({
                    left: `${Math.min(pa.x, window.innerWidth - (pt.width + 3))}px`,
                    top: `${Math.min(pa.y + pa.height + 3, window.innerHeight - (pt.height + 3))}px`,
                    zIndex: Number.isNumeric(zi) ? zi + 1 : 100
                });
                // Adding a handler to remove explanation on click anywhere on the page
                $(document).one('click', () => {
                    $(tooltipWrapper).remove();
                });
            });
        }
    }
}
/**
 * Hides roll data if needed by current roll mode
 * @param roll The roll element
 */
const hideRollData = (roll) => {
    roll.data('roll-data', null);
    roll.find('span').text('?');
};
export default function initChat() {
    $(() => {
        // Adding the handler on every roll in the page, now and future
        $(document).on('click', '.custom-system-roll', expandMfsRoll);
    });
    // When rendering a chat message, applying roll mode
    Hooks.on('renderChatMessage', (message, elt) => {
        const rolls = $(elt).find('.custom-system-roll');
        for (const rollElt of rolls) {
            const roll = $(rollElt);
            const rollMode = roll.data('roll-mode');
            if (rollMode === CONST.DICE_ROLL_MODES.PRIVATE && !game.user.isGM && !message.isAuthor) {
                hideRollData(roll);
            }
            else if (rollMode === CONST.DICE_ROLL_MODES.BLIND && !game.user.isGM) {
                hideRollData(roll);
            }
            else if (rollMode === CONST.DICE_ROLL_MODES.SELF && !message.isAuthor) {
                hideRollData(roll);
            }
            if (roll.data('hidden')) {
                roll.addClass('custom-system-hidden-roll');
                if (!(game.user.isGM && game.settings.get(game.system.id, 'showHiddenRoll'))) {
                    roll.hide();
                }
            }
        }
        const dicePools = $(elt).find('.custom-system-dice-pool');
        for (const dicePoolElt of dicePools) {
            const dicePool = $(dicePoolElt);
            if (dicePool.data('hidden')) {
                dicePool.addClass('custom-system-hidden-roll');
                dicePool.removeClass('custom-system-dice-pool-multiple');
                if (!(game.user.isGM && game.settings.get(game.system.id, 'showHiddenRoll'))) {
                    dicePool.hide();
                }
            }
        }
    });
    Hooks.on('preCreateChatMessage', (document, data, _options, _userId) => {
        data.content = String(data.content ?? '');
        // Handling actor references. They are @{<actor_name OR selected OR target>|<prop>}
        const messageReferences = data.content.matchAll(/@{(.*?)\|(.*?)}/g);
        let reference = messageReferences.next();
        while (!reference.done) {
            const [fullRef, actorName, refPropRaw] = reference.value;
            let refProp = refPropRaw;
            let actor = null;
            // Recovering the right actor
            if (actorName === 'selected') {
                actor = canvas.tokens.controlled[0]?.actor ?? game.user.character;
            }
            else if (actorName === 'target') {
                actor = game.user.targets.values().next().value?.actor;
            }
            else {
                actor = game.actors.filter((e) => e.name === actorName)[0];
            }
            // If actor was found
            if (actor && actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED)) {
                const refPropSplitted = refProp.split('.');
                const [filterMatch, parentProp, filterProp, filterValue] = refPropSplitted.shift()?.match(/^([a-zA-Z0-9_]+)\(([a-zA-Z0-9_]+)=(.+)\)$/) ?? [];
                if (filterMatch) {
                    const parent = foundry.utils.getProperty(actor.getRollData(), parentProp);
                    const index = Object.keys(parent).filter((key) => parent[key][filterProp] === filterValue)[0];
                    refProp = parentProp + '.' + index + '.' + refPropSplitted.join('.');
                }
                // Recovering value from data
                const value = foundry.utils.getProperty(actor.getRollData(), refProp);
                if (value) {
                    document.content = document.content.replace(fullRef, () => value);
                }
            }
            reference = messageReferences.next();
        }
        if (document.content !== data.content) {
            document.updateSource({
                content: document.content
            });
        }
    });
}
