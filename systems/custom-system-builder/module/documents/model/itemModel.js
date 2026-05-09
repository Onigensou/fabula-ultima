/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { BodyModel, DisplayModel, HeaderModel } from './baseModels.js';
const { ObjectField, NumberField, StringField, ArrayField, BooleanField } = foundry.data.fields;
export class BaseItemDataModel extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            body: BodyModel(),
            templateSystemUniqueVersion: new NumberField()
        };
    }
}
export class TemplateItemDataModel extends BaseItemDataModel {
    static defineSchema() {
        return {
            ...super.defineSchema(),
            display: DisplayModel(),
            header: HeaderModel(),
            hidden: new ArrayField(new ObjectField()),
            modifiers: new ArrayField(new ObjectField())
        };
    }
}
export class EquippableItemDataModel extends TemplateItemDataModel {
    static defineSchema() {
        return {
            ...super.defineSchema(),
            template: new StringField(),
            props: new ObjectField(),
            container: new StringField({ required: false, nullable: true }),
            unique: new BooleanField(),
            uniqueId: new StringField()
        };
    }
}
