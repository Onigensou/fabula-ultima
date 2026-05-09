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
import CustomActor from './documents/CustomActor.js';
import CustomItem from './documents/CustomItem.js';
import CustomDialogV2 from './applications/CustomDialogV2.js';
/**
 * @ignore
 * @module
 */
export const exportTemplates = () => {
    const actorFolder = {
        name: 'Base',
        depth: 0,
        children: game.folders.filter((folder) => folder.depth === 1 && folder.type === 'Actor'),
        contents: game.actors.filter((actor) => CustomActor.isTemplateActor(actor) && actor.folder === null),
        get folder() {
            return null;
        }
    };
    const itemFolder = {
        name: 'Base',
        depth: 0,
        children: game.folders.filter((folder) => folder.depth === 1 && folder.type === 'Item'),
        contents: game.items.filter((item) => CustomItem.isTemplateItem(item) && item.folder === null),
        get folder() {
            return null;
        }
    };
    const wrapperDiv = document.createElement('div');
    wrapperDiv.innerHTML = `<h1>${game.i18n.localize('CSB.Export.ExportDialog.Subtitle')}</h1>
<div class="custom_system_export_divider">
    <div id="custom_system_actor_export_list" class="custom_system_export_list">
        <h2>Actors :</h2>
        <label>
            <input type="checkbox" checked="checked" class="custom-system-full-selector" />${game.i18n.localize('SelectAll')}
        </label>
    </div>
    <div id="custom_system_item_export_list" class="custom_system_export_list">
        <h2>Items :</h2>
        <label>
            <input type="checkbox" checked="checked" class="custom-system-full-selector" />${game.i18n.localize('SelectAll')}
        </label>
    </div>
</div>`;
    wrapperDiv.querySelector('#custom_system_actor_export_list')?.append(getFolderStructure([actorFolder]));
    wrapperDiv.querySelector('#custom_system_item_export_list')?.append(getFolderStructure([itemFolder]));
    wrapperDiv.querySelectorAll('.custom-system-full-selector').forEach((elt) => elt.addEventListener('change', (ev) => {
        const target = ev.currentTarget;
        const newState = target.checked;
        target
            .closest('.custom_system_export_list')
            ?.querySelectorAll('input[type=checkbox]')
            .forEach((elt) => (elt.checked = newState));
    }));
    new CustomDialogV2({
        window: { title: game.i18n.localize('CSB.Export.ExportDialog.Title') },
        content: wrapperDiv,
        buttons: {
            ok: {
                default: true,
                label: game.i18n.localize('CSB.Export.ExportDialog.Action')
            }
        },
        submit: async (_result, _event, _button, dialog) => {
            // Fetch every templates
            const actorTemplates = game.actors.filter((actor) => CustomActor.isTemplateActor(actor));
            const itemTemplates = game.items.filter((item) => CustomItem.isTemplateItem(item));
            const tplIds = Array.from(dialog.querySelectorAll('input[type="checkbox"]'))
                .filter((elt) => elt.checked && elt.id)
                .map((elt) => elt.id);
            // Cleanup data
            const exportActorTemplates = actorTemplates
                .filter((tpl) => tplIds.includes(tpl.id))
                .map(sanitizeTemplateExport);
            const exportItemTemplates = itemTemplates
                .filter((tpl) => tplIds.includes(tpl.id))
                .map(sanitizeTemplateExport);
            const exportTemplates = {
                isCustomSystemExport: true,
                actors: exportActorTemplates,
                items: exportItemTemplates
            };
            // Download data as JSON
            saveDataToFile(JSON.stringify(exportTemplates, undefined, '\t'), CONST.TEXT_FILE_EXTENSIONS.json, 'export.json');
        },
        position: {
            height: 'auto'
        }
    }).render({ force: true });
};
function sanitizeTemplateExport(template) {
    const json = JSON.parse(JSON.stringify(template));
    delete json.system.props;
    delete json.flags['custom-system-builder'].templateHistory;
    delete json.flags['custom-system-builder'].templateHistoryRedo;
    return {
        id: json._id,
        type: json.type,
        name: json.name,
        data: json.system,
        flags: json.flags
    };
}
/**
 * @ignore
 */
const getFolderStructure = (folderArray) => {
    const folderList = document.createElement('div');
    for (let folder of folderArray) {
        if (!folder.name) {
            folder = folder.folder;
        }
        let className = '';
        if (folder.depth ?? 0 > 1) {
            className = 'custom_system_export_folder';
        }
        let baseFolderElt;
        const checkFolderButton = document.createElement('input');
        checkFolderButton.type = 'checkbox';
        checkFolderButton.checked = true;
        if (folder.depth ?? 0 > 0) {
            baseFolderElt = document.createElement('details');
            baseFolderElt.open = true;
            const folderNameSpan = document.createElement('summary');
            const folderIcon = document.createElement('i');
            folderIcon.classList = 'fas fa-folder-open';
            folderNameSpan.append(checkFolderButton);
            folderNameSpan.append(folderIcon);
            folderNameSpan.append(folder.name ?? '');
            baseFolderElt.append(folderNameSpan);
        }
        else {
            baseFolderElt = document.createElement('div');
        }
        baseFolderElt.classList = className;
        const subFolderStructure = getFolderStructure(folder.children);
        const actorContainer = document.createElement('div');
        if (folder.depth ?? 0 > 0) {
            actorContainer.classList = 'custom_system_export_folder';
        }
        for (const entity of folder.contents) {
            if (CustomActor.isTemplateActor(entity) || CustomItem.isTemplateItem(entity)) {
                const baseActorElt = document.createElement('p');
                const baseActorCheckbox = document.createElement('input');
                baseActorCheckbox.type = 'checkbox';
                baseActorCheckbox.id = entity.id ?? '';
                baseActorCheckbox.checked = true;
                baseActorCheckbox.dataset.type = entity.type;
                const baseActorName = document.createElement('label');
                baseActorName.htmlFor = entity.id ?? '';
                const baseActorIcon = document.createElement('i');
                baseActorIcon.classList = 'fas fa-user';
                baseActorName.append(baseActorIcon);
                baseActorName.append(entity.name);
                baseActorElt.append(baseActorCheckbox);
                baseActorElt.append(baseActorName);
                actorContainer.append(baseActorElt);
            }
        }
        subFolderStructure.append(actorContainer);
        checkFolderButton.addEventListener('change', () => {
            subFolderStructure.querySelectorAll('input').forEach((elt) => {
                elt.checked = checkFolderButton.checked;
                elt.dispatchEvent(new Event('change'));
            });
        });
        baseFolderElt.append(subFolderStructure);
        folderList.append(baseFolderElt);
    }
    return folderList;
};
/**
 * @ignore
 */
export const importTemplates = () => {
    // Create File Picker to get export JSON
    const fp = new FilePicker({
        callback: async (filePath) => {
            // Get file from server
            const response = await fetch(filePath);
            const importedPack = (await response.json());
            // If imported pack is array, trigger only actor import (old format)
            if (Array.isArray(importedPack)) {
                await importActorTemplate(importedPack);
            }
            else if (importedPack.isCustomSystemExport) {
                await importItemTemplate(importedPack.items);
                await importActorTemplate(importedPack.actors);
            }
            new CustomDialogV2({
                window: { title: game.i18n.localize('CSB.Export.ImportDialog.Title') },
                content: `<p>${game.i18n.localize('CSB.Export.ImportDialog.Content')}</p>`,
                buttons: {
                    one: {
                        label: game.i18n.localize('Close'),
                        callback: async () => {
                            window.location.reload();
                        }
                    }
                }
            }).render({ force: true });
        }
    });
    // Tweak to allow only json files to be uploaded / selected
    fp.extensions = ['.json'];
    fp.browse('');
};
const importActorTemplate = async (importedPack) => {
    const actorTemplates = game.actors.filter((actor) => CustomActor.isTemplateActor(actor));
    for (const imported of importedPack) {
        // If a same name template exist, we replace its data with the imported data
        const matchingLocalTemplates = actorTemplates.filter((tpl) => tpl.name === imported.name && tpl.type === imported.type);
        if (matchingLocalTemplates.length > 0) {
            for (const match of matchingLocalTemplates) {
                match
                    .update({
                    system: {
                        hidden: imported.data.hidden,
                        header: imported.data.header,
                        body: imported.data.body,
                        templateSystemUniqueVersion: imported.data.templateSystemUniqueVersion ?? (Math.random() * 0x100000000) >>> 0
                    },
                    flags: imported.flags
                })
                    .then(() => {
                    match.render(false);
                });
            }
        }
        else {
            // If no same name template exists, we create the template from imported data
            await Actor.create({
                _id: imported.id,
                name: imported.name,
                type: imported.type,
                system: {
                    ...imported.data,
                    templateSystemUniqueVersion: imported.data.templateSystemUniqueVersion ?? (Math.random() * 0x100000000) >>> 0
                },
                flags: imported.flags
            }, {
                keepId: true
            });
        }
    }
};
const importItemTemplate = async (importedPack) => {
    const itemTemplates = game.items.filter((item) => CustomItem.isTemplateItem(item));
    for (const imported of importedPack) {
        // If a same name template exist, we replace its data with the imported data
        const matchingLocalTemplates = itemTemplates.filter((tpl) => tpl.name === imported.name && tpl.type === imported.type);
        if (matchingLocalTemplates.length > 0) {
            for (const match of matchingLocalTemplates) {
                match
                    .update({
                    system: {
                        hidden: imported.data.hidden,
                        header: imported.data.header,
                        body: imported.data.body,
                        modifiers: imported.data.modifiers,
                        templateSystemUniqueVersion: imported.data.templateSystemUniqueVersion ?? (Math.random() * 0x100000000) >>> 0
                    },
                    flags: imported.flags
                })
                    .then(() => {
                    match.render(false);
                });
            }
        }
        else {
            // If no same name template exists, we create the template from imported data
            await Item.create({
                _id: imported.id,
                name: imported.name,
                type: imported.type,
                system: {
                    hidden: imported.data.hidden,
                    header: imported.data.header,
                    body: imported.data.body,
                    modifiers: imported.data.modifiers,
                    templateSystemUniqueVersion: imported.data.templateSystemUniqueVersion ?? (Math.random() * 0x100000000) >>> 0
                },
                flags: imported.flags
            }, {
                keepId: true
            });
        }
    }
};
