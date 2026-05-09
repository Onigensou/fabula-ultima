/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Logger from '../Logger.js';
async function processMigration() {
    const versionNumber = '3.1.2';
    const actorsToMigrate = game.actors.filter((actor) => foundry.utils.isNewerVersion(versionNumber, actor.getFlag(game.system.id, 'version')));
    if (actorsToMigrate.length === 0) {
        return;
    }
    const templates = actorsToMigrate.filter((document) => document.isTemplate);
    const actors = actorsToMigrate.filter((document) => !document.isTemplate);
    for (let i = 0; i < templates.length; i++) {
        const template = templates[i];
        logProgress(template, versionNumber, i, templates.length);
        template.system.header = updateItemContainersInComponent(template.system.header);
        template.system.body = updateItemContainersInComponent(template.system.body);
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
const updateItemContainersInComponent = (component) => {
    if (component.type === 'itemContainer') {
        if (component.itemFilter) {
            const formulaVersion = [];
            for (const filter of component.itemFilter) {
                let operator;
                switch (filter.operator) {
                    case 'gt':
                        operator = '>';
                        break;
                    case 'geq':
                        operator = '>=';
                        break;
                    case 'lt':
                        operator = '<';
                        break;
                    case 'leq':
                        operator = '<=';
                        break;
                    case 'eq':
                    default:
                        operator = '==';
                        break;
                }
                if (Number.isNumeric(filter.value)) {
                    formulaVersion.push(`item.${filter.prop}${operator}${filter.value}`);
                }
                else {
                    formulaVersion.push(`equalText(item.${filter.prop}, '${filter.value}')`);
                }
            }
            component.itemFilterFormula = formulaVersion.join(' and ');
        }
    }
    else {
        if (component.contents) {
            const container = component;
            container.contents = (container.contents ?? []).map((subComp) => {
                if (Array.isArray(subComp)) {
                    const tableContents = subComp.map((subSubComp) => {
                        if (subSubComp) {
                            return updateItemContainersInComponent(subSubComp);
                        }
                    });
                    return tableContents;
                }
                else {
                    return updateItemContainersInComponent(subComp);
                }
            });
        }
    }
    return component;
};
export default {
    processMigration
};
