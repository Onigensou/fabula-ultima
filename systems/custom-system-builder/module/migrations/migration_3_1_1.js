/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Logger from '../Logger.js';
async function processMigration() {
    const versionNumber = '3.1.1';
    const actorsToMigrate = game.actors.filter((actor) => foundry.utils.isNewerVersion(versionNumber, actor.getFlag(game.system.id, 'version')));
    const itemsToMigrate = game.items.filter((item) => foundry.utils.isNewerVersion(versionNumber, item.getFlag(game.system.id, 'version')));
    if (actorsToMigrate.length + itemsToMigrate.length === 0) {
        return;
    }
    const templates = actorsToMigrate.filter((document) => document.isTemplate);
    const actors = actorsToMigrate.filter((document) => !document.isTemplate);
    const items = itemsToMigrate.filter((document) => !document.isTemplate);
    const itemTemplates = itemsToMigrate.filter((document) => document.isTemplate);
    for (let i = 0; i < templates.length; i++) {
        const template = templates[i];
        logProgress(template, versionNumber, i, templates.length);
        template.system.header = updateDuplicateKeysInComponent(template.system.header);
        template.system.body = updateDuplicateKeysInComponent(template.system.body);
        await template.update({
            system: {
                header: template.system.header,
                body: template.system.body,
                templateSystemUniqueVersion: (Math.random() * 0x100000000) >>> 0
            }
        });
        await template.setFlag(game.system.id, 'version', versionNumber);
    }
    for (let i = 0; i < actors.length; i++) {
        const actor = actors[i];
        logProgress(actor, versionNumber, i, actors.length);
        try {
            await actors[i].templateSystem.reloadTemplate();
        }
        catch (err) {
            Logger.error(err.message, err);
        }
        await actors[i].setFlag(game.system.id, 'version', versionNumber);
    }
    for (let i = 0; i < itemTemplates.length; i++) {
        const itemTemplate = itemTemplates[i];
        logProgress(itemTemplate, versionNumber, i, items.length);
        if (itemTemplate.system.header) {
            itemTemplate.system.header = updateDuplicateKeysInComponent(itemTemplate.system.header);
        }
        itemTemplate.system.body = updateDuplicateKeysInComponent(itemTemplate.system.body);
        await itemTemplate.update({
            system: {
                header: itemTemplate.system.header,
                body: itemTemplate.system.body,
                templateSystemUniqueVersion: (Math.random() * 0x100000000) >>> 0
            }
        });
        await itemTemplates[i].setFlag(game.system.id, 'version', versionNumber);
    }
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        logProgress(item, versionNumber, i, items.length);
        try {
            await item.templateSystem.reloadTemplate();
        }
        catch (err) {
            Logger.error(err.message, err);
        }
        await items[i].setFlag(game.system.id, 'version', versionNumber);
    }
    SceneNavigation.displayProgressBar({
        label: 'CSB: Migration finished',
        pct: 100
    });
}
const logProgress = (document, version, current, total) => {
    Logger.log('Processing migration ' + version + ' for ' + document.name + ' - ' + document.id);
    SceneNavigation.displayProgressBar({
        label: `CSB: Migration to Version ${version}. Updating ${document.constructor.name} ${current + 1} / ${total}`,
        pct: Math.round((current * 100) / total)
    });
};
const updateDuplicateKeysInComponent = (component, keyList = new Set()) => {
    if (component.type !== 'tab' && component.key) {
        if (keyList.has(component.key)) {
            let i = 1;
            do {
                component.key = `${component.key}_${i}`;
                i++;
            } while (keyList.has(component.key));
        }
        keyList.add(component.key);
    }
    if (component.contents) {
        const container = component;
        container.contents = (container.contents ?? []).map((subComp) => {
            if (Array.isArray(subComp)) {
                const tableContents = subComp.map((subSubComp) => {
                    if (subSubComp) {
                        return updateDuplicateKeysInComponent(subSubComp, keyList);
                    }
                });
                return tableContents;
            }
            else {
                return updateDuplicateKeysInComponent(subComp, keyList);
            }
        });
    }
    return component;
};
export default {
    processMigration
};
