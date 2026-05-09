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
    const versionNumber = '1.4.0';
    let actors = game.actors;
    const nActors = actors.filter((actor) => foundry.utils.isNewerVersion(versionNumber, actor.getFlag(game.system.id, 'version'))).length;
    if (nActors > 0) {
        for (let actor of actors) {
            if (foundry.utils.isNewerVersion(versionNumber, actor.getFlag(game.system.id, 'version'))) {
                Logger.log('Processing migration ' + versionNumber + ' for ' + actor.name + ' - ' + actor.id);
                let system = actor.system;
                let newContents = [];
                if (system.display.header_below) {
                    for (let component of system.header.contents) {
                        newContents.push(component);
                    }
                    system.header.contents = [];
                }
                if (system.tabs) {
                    newContents.push({
                        type: 'tabbedPanel',
                        key: '',
                        cssClass: '',
                        contents: system.tabs
                    });
                    system.tabs = null;
                }
                system.body.contents = newContents;
                actor.setFlag(game.system.id, 'version', versionNumber);
                await actor.update({
                    system: {
                        header: actor.system.header,
                        body: actor.system.body,
                        '-=tabs': null,
                        display: { '-=header_below': null }
                    }
                });
                Logger.log('\tFinished migration ' + versionNumber + ' for ' + actor.name + ' - ' + actor.id);
            }
        }
    }
}
export default { processMigration };
