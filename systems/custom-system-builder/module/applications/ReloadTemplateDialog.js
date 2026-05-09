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
import CustomActor from '../documents/CustomActor.js';
import Logger from '../Logger.js';
import { getGameCollectionAsTemplateSystems } from '../utils.js';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
var SCENE_SELECTION_OPTIONS;
(function (SCENE_SELECTION_OPTIONS) {
    SCENE_SELECTION_OPTIONS["none"] = "CSB.ReloadTemplates.SceneSelect.None";
    SCENE_SELECTION_OPTIONS["current"] = "CSB.ReloadTemplates.SceneSelect.Current";
    SCENE_SELECTION_OPTIONS["all"] = "CSB.ReloadTemplates.SceneSelect.All";
})(SCENE_SELECTION_OPTIONS || (SCENE_SELECTION_OPTIONS = {}));
export default class ReloadTemplatesDialog extends HandlebarsApplicationMixin((ApplicationV2)) {
    entity;
    static DEFAULT_OPTIONS = {
        tag: 'form',
        form: {
            handler: ReloadTemplatesDialog.submitHandler,
            submitOnChange: false,
            closeOnSubmit: false
        },
        actions: {
            cancel: ReloadTemplatesDialog.cancel
        },
        window: {
            title: 'CSB.TemplateActions.ReloadSheetsDialog.Title',
            icon: 'fas fa-arrows-rotate',
            resizable: false,
            minimizable: true,
            contentClasses: ['standard-form']
        },
        position: {
            width: 'auto',
            height: 'auto'
        },
        classes: ['custom-system-reloadTemplates']
    };
    static PARTS = {
        form: {
            get template() {
                return `systems/${game.system.id}/templates/_template/dialogs/reloadTemplates.hbs`;
            }
        },
        footer: {
            template: 'templates/generic/form-footer.hbs'
        }
    };
    static async submitHandler(_event, _form, formData) {
        const includeActorsInGameDirectory = formData.get('actorsInGameDirectory') === 'true';
        const sceneSelection = formData.get('tokensInScenes');
        const entities = [].concat((sceneSelection === 'all'
            ? Array.from(game.scenes).flatMap((scene) => Array.from(scene.tokens))
            : sceneSelection === 'current'
                ? Array.from(game.scenes.get(game.user?.viewedScene ?? '')?.tokens ?? [])
                : [])
            .filter((token) => !token.actorLink && token.actor && CustomActor.isCharacterActor(token.actor))
            .map((token) => token.actor.templateSystem), includeActorsInGameDirectory
            ? game.actors.filter((actor) => CustomActor.isCharacterActor(actor)).map((actor) => actor.templateSystem)
            : []);
        const filteredCollection = this.entityType === 'item'
            ? entities.flatMap((entity) => Array.from(entity.items))
                .filter((item) => item.system.template === this.entity.id)
                .map((item) => item.templateSystem)
            : entities;
        this.reloadTemplatesOfEntities(getGameCollectionAsTemplateSystems(this.entityType)
            .filter((entity) => entity.entity.system.template === this.entity.id)
            .concat(filteredCollection));
        this.close();
    }
    async reloadTemplatesOfEntities(entities) {
        let counter = 1;
        return Promise.all(entities.map((entity) => entity.reloadTemplate().then(() => this.logReloadProgress(entity, counter++, entities.length)))).then(() => this.finishReloadProgress(entities.length));
    }
    logReloadProgress(entity, current, max) {
        Logger.log(`Reloaded ${entity.entity.name} (${entity.uuid}): ${current} / ${max}`);
        SceneNavigation.displayProgressBar({
            label: game.i18n.format('CSB.ProgressBar.ReloadingTemplates', {
                NAME: entity.entity.name,
                UUID: entity.uuid,
                CURRENT: current,
                MAX: max
            }),
            pct: Math.round((current * 100) / max)
        });
    }
    finishReloadProgress(max) {
        Logger.log(`Reloading Templates of Documents finished (reloaded ${max} documents)`);
        SceneNavigation.displayProgressBar({
            label: game.i18n.format('CSB.ProgressBar.ReloadingTemplatesFinished', { MAX: max }),
            pct: 100
        });
    }
    static async cancel(_event, _target) {
        this.close();
    }
    entityType;
    constructor(entity) {
        super();
        this.entity = entity;
        if (!this.entity.templateSystem.entityType) {
            throw new Error(`Cannot reload templates from entity ${this.entity.uuid}, unknown entity type`);
        }
        this.entityType = this.entity.templateSystem.entityType;
    }
    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        context.documentType = this.entityType;
        context.type = this.entity instanceof Actor ? 'Actors' : 'Items';
        context.documentTypeLocalized = game.i18n.localize(`DOCUMENT.${context.type}`);
        context.SCENE_SELECTION_OPTIONS = SCENE_SELECTION_OPTIONS;
        context.buttons = [
            { type: 'submit', icon: 'fa-solid fa-arrows-rotate', label: 'CSB.ReloadTemplates.Reload' },
            { type: 'button', action: 'cancel', icon: 'fa-solid fa-xmark', label: 'Cancel' }
        ];
        return context;
    }
}
