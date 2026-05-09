/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { finishMigration, logProgress } from './migrationUtils.js';
async function processMigration() {
    const versionNumber = '4.6.4';
    const activeEffectContainerItems = game.items.filter((item) => item.type === 'activeEffectContainer');
    const allEffects = [];
    for (const item of activeEffectContainerItems) {
        allEffects.push(...item.effects.filter((effect) => effect.getFlag(game.system.id, 'isPredefined') !== true));
    }
    if (allEffects.length === 0)
        return;
    for (let i = 0; i < allEffects.length; i++) {
        const effect = allEffects[i];
        logProgress(effect, versionNumber, i, allEffects.length);
        await effect.setFlag(game.system.id, 'isPredefined', true);
    }
    finishMigration();
}
export default {
    processMigration
};
