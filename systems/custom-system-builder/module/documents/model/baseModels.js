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
const { ObjectField } = foundry.data.fields;
export const DisplayModel = () => new ObjectField({
    required: true,
    initial: () => {
        return {
            width: 600,
            height: 600,
            fix_size: false,
            pp_width: 64,
            pp_height: 64
        };
    }
});
export const BodyModel = () => new ObjectField({
    required: true,
    initial: () => {
        return {
            contents: [],
            key: 'custom_body'
        };
    }
});
export const HeaderModel = () => new ObjectField({
    required: true,
    initial: () => {
        return {
            contents: [],
            key: 'custom_header'
        };
    }
});
