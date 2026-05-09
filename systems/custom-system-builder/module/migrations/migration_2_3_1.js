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
    const versionNumber = '2.3.1';
    let actors = game.actors;
    let items = game.items;
    const nActors = actors.filter((actor) => foundry.utils.isNewerVersion(versionNumber, actor.getFlag(game.system.id, 'version'))).length;
    const nItems = items.filter((actor) => foundry.utils.isNewerVersion(versionNumber, actor.getFlag(game.system.id, 'version'))).length;
    if (nActors + nItems > 0) {
        for (let actor of actors) {
            if (foundry.utils.isNewerVersion(versionNumber, actor.getFlag(game.system.id, 'version'))) {
                Logger.log('Processing migration ' + versionNumber + ' for ' + actor.name + ' - ' + actor.id);
                actor.setFlag(game.system.id, 'version', versionNumber);
                if (actor.isTemplate && !actor.system.templateSystemUniqueVersion) {
                    await actor.update({
                        system: {
                            templateSystemUniqueVersion: (Math.random() * 0x100000000) >>> 0
                        }
                    });
                }
            }
        }
        for (let item of items) {
            if (foundry.utils.isNewerVersion(versionNumber, item.getFlag(game.system.id, 'version'))) {
                Logger.log('Processing migration ' + versionNumber + ' for ' + item.name + ' - ' + item.id);
                item.setFlag(game.system.id, 'version', versionNumber);
                if (item.isTemplate && !item.system.templateSystemUniqueVersion) {
                    await item.update({
                        system: {
                            templateSystemUniqueVersion: (Math.random() * 0x100000000) >>> 0
                        }
                    });
                }
            }
        }
    }
}
export default { processMigration };
