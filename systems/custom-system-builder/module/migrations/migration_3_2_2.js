/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { finishMigration, getActorsToMigrate, getItemsToMigrate, reloadTemplatesInDocuments, reloadTemplatesInEmbeddedItems, updateComponents, updateDocuments } from './migrationUtils.js';
async function processMigration() {
    const versionNumber = '3.2.2';
    const actorsToMigrate = getActorsToMigrate(versionNumber);
    const itemsToMigrate = getItemsToMigrate(versionNumber);
    if (actorsToMigrate.length + itemsToMigrate.length === 0) {
        return;
    }
    const templates = actorsToMigrate.filter((document) => document.isTemplate);
    const actors = actorsToMigrate.filter((document) => !document.isTemplate);
    const itemTemplates = itemsToMigrate.filter((document) => document.isTemplate);
    const items = itemsToMigrate.filter((document) => !document.isTemplate);
    await updateDocuments(templates, versionNumber, (template) => {
        return {
            system: {
                header: updateComponents(template.system.header, (component) => component?.type === 'select', (component) => updateDropdown(component)),
                body: updateComponents(template.system.body, (component) => component?.type === 'select', (component) => updateDropdown(component)),
                templateSystemUniqueVersion: (Math.random() * 0x100000000) >>> 0
            }
        };
    });
    await reloadTemplatesInDocuments(actors, versionNumber);
    await updateDocuments(itemTemplates, versionNumber, (template) => {
        return {
            system: {
                header: updateComponents(template.system.header, (component) => component?.type === 'select', (component) => updateDropdown(component)),
                body: updateComponents(template.system.body, (component) => component?.type === 'select', (component) => updateDropdown(component)),
                templateSystemUniqueVersion: (Math.random() * 0x100000000) >>> 0
            }
        };
    });
    await reloadTemplatesInDocuments(items, versionNumber);
    await reloadTemplatesInEmbeddedItems(actors, versionNumber);
    finishMigration();
}
function updateDropdown(component) {
    return {
        ...component,
        selectedOptionType: component.tableKey ? 'table' : component.formulaKeyOptions ? 'formula' : 'custom'
    };
}
export default {
    processMigration
};
