/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Logger from '../Logger.js';
export function logProgress(document, version, current, total) {
    Logger.log('Processing migration ' + version + ' for ' + document.name + ' - ' + document.id);
    SceneNavigation.displayProgressBar({
        label: `CSB: Migration to Version ${version}. Updating ${document.constructor.name} ${current + 1} / ${total}`,
        pct: Math.round((current * 100) / total)
    });
}
export function finishMigration() {
    SceneNavigation.displayProgressBar({
        label: 'CSB: Migration finished',
        pct: 100
    });
}
export function getActorsToMigrate(versionNumber) {
    return game.actors.filter((actor) => foundry.utils.isNewerVersion(versionNumber, actor.getFlag(game.system.id, 'version')));
}
export function getItemsToMigrate(versionNumber) {
    return game.items.filter((item) => foundry.utils.isNewerVersion(versionNumber, item.getFlag(game.system.id, 'version')));
}
export async function updateDocuments(documents, versionNumber, callback) {
    for (let i = 0; i < documents.length; i++) {
        const document = documents[i];
        logProgress(document, versionNumber, i, documents.length);
        const diff = callback(document);
        await document.update(diff);
        // @ts-expect-error setFlag is not compatible between actor & item
        await document.setFlag(game.system.id, 'version', versionNumber);
    }
}
export async function reloadTemplatesInEmbeddedItems(actors, versionNumber) {
    const items = actors.flatMap((actor) => Array.from(actor.items));
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        logProgress(item, versionNumber, i, items.length);
        try {
            await item.templateSystem.reloadTemplate();
        }
        catch (err) {
            Logger.error(err.message, err);
        }
        await item.setFlag(game.system.id, 'version', versionNumber);
    }
}
export async function reloadTemplatesInDocuments(documents, versionNumber) {
    for (let i = 0; i < documents.length; i++) {
        const document = documents[i];
        logProgress(document, versionNumber, i, documents.length);
        try {
            await document.templateSystem.reloadTemplate();
        }
        catch (err) {
            Logger.error(err.message, err);
        }
        // @ts-expect-error setFlag is not compatible between actor & item
        await document.setFlag(game.system.id, 'version', versionNumber);
    }
}
export function updateComponents(component, predicate, callback) {
    if (predicate(component)) {
        component = callback(component);
    }
    if (component?.contents) {
        const container = component;
        container.contents = (container.contents ?? []).map((subComp) => {
            if (Array.isArray(subComp)) {
                const tableContents = subComp.map((subSubComp) => {
                    if (subSubComp) {
                        return updateComponents(subSubComp, predicate, callback);
                    }
                });
                return tableContents;
            }
            else {
                return updateComponents(subComp, predicate, callback);
            }
        });
    }
    if (component?.rowLayout) {
        const extensibleTable = component;
        extensibleTable.rowLayout = extensibleTable.rowLayout?.map((subComp) => {
            return updateComponents(subComp, predicate, callback);
        });
    }
    return component;
}
export function getComponentKeys(component, predicate) {
    let allKeys = new Set();
    if (component.key && predicate(component)) {
        allKeys.add(component.key);
    }
    if (component?.contents) {
        const container = component;
        (container.contents ?? []).forEach((subComp) => {
            if (Array.isArray(subComp)) {
                subComp.forEach((subSubComp) => {
                    if (subSubComp) {
                        allKeys = new Set([...allKeys, ...getComponentKeys(subSubComp, predicate)]);
                    }
                });
            }
            else {
                allKeys = new Set([...allKeys, ...getComponentKeys(subComp, predicate)]);
            }
        });
    }
    if (component?.rowLayout) {
        const extensibleTable = component;
        extensibleTable.rowLayout?.forEach((subComp) => {
            allKeys = new Set([...allKeys, ...getComponentKeys(subComp, predicate)]);
        });
    }
    return allKeys;
}
