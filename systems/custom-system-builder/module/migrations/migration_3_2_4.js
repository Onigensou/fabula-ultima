/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { finishMigration, getActorsToMigrate, getComponentKeys, getItemsToMigrate, reloadTemplatesInDocuments, reloadTemplatesInEmbeddedItems, updateComponents, updateDocuments } from './migrationUtils.js';
async function processMigration() {
    const versionNumber = '3.2.4';
    const actorsToMigrate = getActorsToMigrate(versionNumber);
    const itemsToMigrate = getItemsToMigrate(versionNumber);
    if (actorsToMigrate.length + itemsToMigrate.length === 0) {
        return;
    }
    const templates = actorsToMigrate.filter((document) => document.isTemplate);
    const actors = actorsToMigrate.filter((document) => !document.isTemplate);
    const itemTemplates = itemsToMigrate.filter((document) => document.isTemplate);
    const items = itemsToMigrate.filter((document) => !document.isTemplate);
    const allEmbeddedItems = actors.map((actor) => Array.from(actor.items)).flat();
    await updateDocuments(templates, versionNumber, (template) => {
        return {
            system: {
                header: updateComponents(template.system.header, (component) => component?.type === 'dynamicTable', (component) => updateDynamicTable(component)),
                body: updateComponents(template.system.body, (component) => component?.type === 'dynamicTable', (component) => updateDynamicTable(component)),
                templateSystemUniqueVersion: (Math.random() * 0x100000000) >>> 0
            }
        };
    });
    await reloadTemplatesInDocuments(actors, versionNumber);
    await updateDocuments(itemTemplates, versionNumber, (template) => {
        return {
            system: {
                header: updateComponents(template.system.header, (component) => component?.type === 'dynamicTable', (component) => updateDynamicTable(component)),
                body: updateComponents(template.system.body, (component) => component?.type === 'dynamicTable', (component) => updateDynamicTable(component)),
                templateSystemUniqueVersion: (Math.random() * 0x100000000) >>> 0
            }
        };
    });
    await reloadTemplatesInDocuments(items, versionNumber);
    await reloadTemplatesInEmbeddedItems(actors, versionNumber);
    await updateDynamicTableInDocuments(actors, versionNumber);
    await updateDynamicTableInDocuments(items, versionNumber);
    await updateDynamicTableInDocuments(allEmbeddedItems, versionNumber);
    finishMigration();
}
function updateDynamicTable(component) {
    const internalProps = ['deleted', 'predefinedIdx', 'deletionDisabled'];
    const newPredefinedLines = [...(component.predefinedLines ?? [])];
    for (const rowIdx in newPredefinedLines) {
        const row = newPredefinedLines[rowIdx];
        for (const propKey in row) {
            if (internalProps.includes(propKey)) {
                row[`$${propKey}`] = row[propKey];
                delete row[propKey];
            }
        }
    }
    return {
        ...component,
        predefinedLines: newPredefinedLines
    };
}
async function updateDynamicTableInDocuments(documents, versionNumber) {
    await updateDocuments(documents, versionNumber, (document) => {
        const newProps = {};
        console.log('Migrating ' + document.name);
        const allDTableKeys = [
            ...getComponentKeys(document.system.header, (component) => component?.type === 'dynamicTable'),
            ...getComponentKeys(document.system.body, (component) => component?.type === 'dynamicTable')
        ];
        allDTableKeys.forEach((key) => {
            if (document.system.props[key]) {
                foundry.utils.mergeObject(newProps, updateDynamicTableProps(key, document.system.props[key]));
            }
        });
        return { system: { props: newProps } };
    });
}
function updateDynamicTableProps(key, props) {
    const newObj = { ...props };
    const internalProps = ['deleted', 'predefinedIdx', 'deletionDisabled'];
    for (const rowIdx in newObj) {
        const row = newObj[rowIdx];
        for (const propKey in row) {
            if (internalProps.includes(propKey)) {
                row[`$${propKey}`] = row[propKey];
                row[`-=${propKey}`] = true;
                delete row[propKey];
            }
        }
    }
    return { [key]: newObj };
}
export default {
    processMigration
};
