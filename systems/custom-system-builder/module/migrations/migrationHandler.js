/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Logger from '../Logger.js';
import migration_1_1_0 from './migration_1_1_0.js';
import migration_1_4_0 from './migration_1_4_0.js';
import migration_2_3_1 from './migration_2_3_1.js';
import migration_3_1_0 from './migration_3_1_0.js';
import migration_3_1_1 from './migration_3_1_1.js';
import migration_3_1_2 from './migration_3_1_2.js';
import migration_3_2_2 from './migration_3_2_2.js';
import migration_3_2_4 from './migration_3_2_4.js';
import migration_4_5_0 from './migration_4_5_0.js';
import migration_4_5_1 from './migration_4_5_1.js';
import migration_4_6_4 from './migration_4_6_4.js';
import CustomDialogV2 from '../applications/CustomDialogV2.js';
export default async function processMigrations() {
    await detectSwitchVersion();
    await migration_1_1_0.processMigration();
    await migration_1_4_0.processMigration();
    await migration_2_3_1.processMigration();
    await migration_3_1_0.processMigration();
    await migration_3_1_1.processMigration();
    await migration_3_1_2.processMigration();
    await migration_3_2_2.processMigration();
    await migration_3_2_4.processMigration();
    await migration_4_5_0.processMigration();
    await migration_4_5_1.processMigration();
    await migration_4_6_4.processMigration();
}
async function detectSwitchVersion() {
    if (!game.user.isGM) {
        return;
    }
    const migrateFrom = needsMigration();
    if (migrateFrom) {
        await new Promise((resolve) => {
            new CustomDialogV2({
                window: { title: `System switch detected` },
                content: `<h2>System switch detected from <code>${migrateFrom}</code> to <code>${game.system.id}</code></h2><p>Do you want to migrate settings and flags (recommended)?</p><p>PLEASE BACK UP YOUR WORLD BEFORE DOING ANYTHING</p>`,
                buttons: {
                    yes: {
                        default: true,
                        icon: '<i class="fas fa-check"></i>',
                        label: 'Migrate Settings & Flags (recommended)',
                        callback: async () => {
                            await switchCSBVersion(migrateFrom, game.system.id);
                            resolve();
                        }
                    },
                    delete: {
                        icon: '<i class="fas fa-trash"></i>',
                        label: 'Do not migrate and only delete old settings & flags',
                        callback: async () => {
                            await switchCSBVersion(migrateFrom, game.system.id, true);
                            resolve();
                        }
                    },
                    no: {
                        icon: '<i class="fas fa-xmark"></i>',
                        label: 'Do nothing (this window will pop-up again on the next reload)',
                        callback: async () => {
                            resolve();
                        }
                    }
                }
            }).render({ force: true });
        });
    }
}
export const switchCSBVersion = async (fromKey, toKey, deleteOnly = false) => {
    if (!game.user.isGM) {
        return;
    }
    // We need to port any and all settings over from the original version and any or all flags.
    //First, settings.
    const systemSettings = [];
    try {
        for (const s of game.data.settings) {
            const splitSettingKey = s.key.split('.', 2);
            if (splitSettingKey[0] === fromKey) {
                systemSettings.push({
                    _id: s._id,
                    key: `${toKey}.${splitSettingKey[1]}`,
                    value: s.value
                });
            }
        }
        if (deleteOnly) {
            await Setting.deleteDocuments(systemSettings.map((setting) => setting._id) ?? []);
        }
        else {
            await Setting.updateDocuments(systemSettings);
        }
    }
    catch (error) {
        Logger.error(error.message, error);
    }
    // Now flags, let us write a convenience function
    async function changeFlagsInCollection(collection) {
        const total = collection.size;
        let current = 0;
        for (const doc of collection) {
            logProgress(doc, current, total);
            const flags = doc.flags[fromKey];
            if (flags) {
                if (!deleteOnly) {
                    await doc.update({ [`flags.${toKey}`]: flags }, { recursive: false });
                }
                await doc.update({ [`flags.-=${fromKey}`]: null });
            }
            current++;
        }
    }
    // Users
    await changeFlagsInCollection(game.users);
    // Actors
    await changeFlagsInCollection(game.actors);
    // Items in Actors
    for (const doc of game.actors) {
        await changeFlagsInCollection(doc.items);
    }
    // Items
    await changeFlagsInCollection(game.items);
    // Scenes
    await changeFlagsInCollection(game.scenes);
    // Tokens
    for (const doc of game.scenes) {
        await changeFlagsInCollection(doc.tokens);
    }
    // Combats
    await changeFlagsInCollection(game.combats);
    // Combatants
    for (const doc of game.combats) {
        await changeFlagsInCollection(doc.combatants);
    }
    SceneNavigation.displayProgressBar({
        label: `CSB: Migration of flags finished`,
        pct: 100
    });
};
/**
 * Checks if system needs migration, i.e. if it has been switched from one version to another (between stable, beta and unstable)
 * @returns The system id to migrate from
 */
export const needsMigration = () => {
    const CSBSettings = game.data.settings?.filter((setting) => setting.key.startsWith(`custom-system-builder`)) ?? [];
    for (const setting of CSBSettings) {
        const settingSystemKey = setting.key.split('.')[0];
        if (settingSystemKey !== game.system.id) {
            return settingSystemKey;
        }
    }
    if (game.actors.size > 0) {
        const actorFlags = Array.from(game.actors.values())[0].flags;
        const CSBActorKeys = Object.keys(actorFlags).filter((key) => key.startsWith(`custom-system-builder`)) ?? [];
        for (const key of CSBActorKeys) {
            if (key !== game.system.id) {
                return key;
            }
        }
    }
    if (game.items.size > 0) {
        const itemFLags = Array.from(game.items.values())[0].flags;
        const CSBItemKeys = Object.keys(itemFLags).filter((key) => key.startsWith(`custom-system-builder`)) ?? [];
        for (const key of CSBItemKeys) {
            if (key !== game.system.id) {
                return key;
            }
        }
    }
    return;
};
export const logProgress = (document, current, total) => {
    Logger.log('Migrating flags for ' + document.name + ' - ' + document.id);
    SceneNavigation.displayProgressBar({
        label: `CSB: Migrating flags. Updating ${document.constructor.name} ${current + 1} / ${total}`,
        pct: Math.round((current * 100) / total)
    });
};
