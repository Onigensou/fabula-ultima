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
import Logger from '../Logger.js';
async function processMigration() {
    const versionNumber = '1.1.0';
    let actors = game.actors;
    const nActors = actors.filter((actor) => foundry.utils.isNewerVersion(versionNumber, actor.getFlag(game.system.id, 'version'))).length;
    if (nActors > 0) {
        for (let actor of actors) {
            if (!actor.getFlag(game.system.id, 'version')) {
                Logger.log('Processing migration ' + versionNumber + ' for ' + actor.name + ' - ' + actor.id);
                let system = actor.system;
                migrateTextFieldsToNumberFields(system.header);
                for (let tab of system.tabs) {
                    migrateTextFieldsToNumberFields(tab);
                }
                actor.setFlag(game.system.id, 'version', versionNumber);
                await actor.update({
                    system: {
                        header: actor.system.header,
                        tabs: actor.system.tabs
                    }
                });
                Logger.log('\tFinished migration ' + versionNumber + ' for ' + actor.name + ' - ' + actor.id);
            }
        }
    }
}
function migrateTextFieldsToNumberFields(component) {
    if (component) {
        if (component.type === 'textField') {
            if (component.format === 'integer') {
                component.type = 'numberField';
                component.allowRelative = true;
                component.allowDecimal = false;
                delete component.format;
            }
            else if (component.format === 'numeric') {
                component.type = 'numberField';
                component.allowRelative = true;
                component.allowDecimal = true;
                delete component.format;
            }
        }
        if (Array.isArray(component.contents)) {
            for (let subComp of component.contents) {
                if (Array.isArray(subComp)) {
                    for (let trueSubComp of subComp) {
                        migrateTextFieldsToNumberFields(trueSubComp);
                    }
                }
                else {
                    migrateTextFieldsToNumberFields(subComp);
                }
            }
        }
        if (Array.isArray(component.rowLayout)) {
            for (let subComp of component.rowLayout) {
                migrateTextFieldsToNumberFields(subComp);
            }
        }
    }
}
export default { processMigration };
