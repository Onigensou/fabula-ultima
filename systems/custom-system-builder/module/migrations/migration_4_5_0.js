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
import { finishMigration, getActorsToMigrate, reloadTemplatesInDocuments, updateDocuments } from './migrationUtils.js';
async function processMigration() {
    const versionNumber = '4.5.0';
    const actorsToMigrate = getActorsToMigrate(versionNumber);
    if (actorsToMigrate.length === 0) {
        return;
    }
    const templates = actorsToMigrate.filter((document) => document.isTemplate);
    const actors = actorsToMigrate.filter((document) => !document.isTemplate);
    await updateDocuments(templates, versionNumber, (template) => {
        return {
            system: {
                //@ts-expect-error Migration
                statusEffects: template.system.activeEffects,
                ['-=activeEffects']: true,
                templateSystemUniqueVersion: (Math.random() * 0x100000000) >>> 0
            }
        };
    });
    await reloadTemplatesInDocuments(actors, versionNumber);
    finishMigration();
}
export default {
    processMigration
};
