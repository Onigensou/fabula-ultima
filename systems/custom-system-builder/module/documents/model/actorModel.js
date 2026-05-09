/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { BodyModel, DisplayModel, HeaderModel } from './baseModels.js';
const { NumberField, StringField, ArrayField, ObjectField } = foundry.data.fields;
export class TemplateActorDataModel extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            body: BodyModel(),
            display: DisplayModel(),
            header: HeaderModel(),
            hidden: new ArrayField(new ObjectField()),
            templateSystemUniqueVersion: new NumberField(),
            attributeBar: new ObjectField(),
            statusEffects: new ObjectField()
        };
    }
}
export class CharacterActorDataModel extends TemplateActorDataModel {
    static defineSchema() {
        return {
            ...super.defineSchema(),
            template: new StringField(),
            props: new ObjectField(),
            activeConditionalModifierGroups: new ArrayField(new StringField())
        };
    }
}
