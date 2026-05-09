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
import { CustomActorSheet } from './actor-sheet.js';
/**
 * The character actor sheets
 * @extends {CustomActorSheet}
 */
export class CharacterSheet extends CustomActorSheet {
    hasBeenRenderedOnce = false;
    constructor(actor, options) {
        options.resizable = !actor.system.display?.fix_size;
        super(actor, options);
    }
    render(force, options = {}) {
        if (!this.hasBeenRenderedOnce) {
            this.position.width = this.actor.system.display?.width;
            this.position.height = this.actor.system.display?.height;
            this.hasBeenRenderedOnce = true;
        }
        this.options.resizable = !this.actor.system.display?.fix_size;
        let data = super.render(force, options);
        return data;
    }
}
