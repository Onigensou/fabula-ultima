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
export default class CustomDialog extends Dialog {
    /**
     * Submit the Dialog by selecting one of its buttons
     * @param {Object} button         The configuration of the chosen button
     * @param {PointerEvent} event    The originating click event
     * @private
     * @override
     */
    submit(button, event) {
        if (!button) {
            return;
        }
        try {
            let result = true;
            if (button.callback)
                result = !!button.callback(this.options.jQuery ? this.element : this.element[0], event);
            if (result !== false)
                this.close();
        }
        catch (err) {
            ui.notifications.error(err.message);
            if (err instanceof Error) {
                ui.notifications.error(err.message);
                throw err;
            }
            ui.notifications.error(String(err));
            throw new Error(String(err));
        }
    }
}
