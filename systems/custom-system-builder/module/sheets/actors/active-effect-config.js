/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { isModuleActive } from '../../utils.js';
export default class CustomActiveEffectConfig extends ActiveEffectConfig {
    async getData(options) {
        const data = (await super.getData(options));
        data.labels.transfer.name = game.i18n.localize('CSB.ActiveEffects.Transfer.Name');
        data.labels.transfer.hint = game.i18n.localize('CSB.ActiveEffects.Transfer.Hint');
        return data;
    }
}
Hooks.on('renderActiveEffectConfig', async (activeEffectConfig, html, _data) => {
    if (html.hasClass('window-app')) {
        html.css({
            height: 'auto'
        });
    }
    else {
        html.parents('.window-app').css({
            height: 'auto'
        });
    }
    if (isModuleActive('statuscounter')) {
        const footerSection = html[0].querySelector('footer');
        const counterConfigure = document.createElement('button');
        counterConfigure.type = 'button';
        counterConfigure.addEventListener('click', () => {
            activeEffectConfig.document.statusCounter?.configure();
        });
        counterConfigure.textContent = game.i18n.localize('CSB.ActiveEffects.ConfigureCounter');
        footerSection.prepend(counterConfigure);
    }
    const detailsSection = html[0].querySelector("section[data-tab='details']");
    const tagsElement = foundry.applications.elements.HTMLStringTagsElement.create({
        name: `system.tags`,
        value: activeEffectConfig.document.tags,
        slug: false
    });
    //@ts-expect-error Going around a protected function because it doesn't work otherwise...
    tagsElement._initializeTags();
    const tagsFormGroup = document.createElement('div');
    tagsFormGroup.className = 'form-group';
    const tagsLabel = document.createElement('label');
    tagsLabel.innerHTML = game.i18n.localize('CSB.ComponentProperties.ActiveEffectContainer.FilterByTags.FieldLabel');
    const tagsFormFields = document.createElement('div');
    tagsFormFields.className = 'form-fields';
    tagsFormFields.append(tagsElement);
    tagsFormGroup.append(tagsLabel, tagsFormFields);
    detailsSection?.append(tagsFormGroup);
    const effectsSection = html[0].querySelector("section[data-tab='effects']");
    const effectHeader = effectsSection?.querySelector('header.effect-change');
    const effectRows = effectsSection?.querySelectorAll('li.effect-change');
    const priorityContainer = document.createElement('div');
    priorityContainer.className = 'priority';
    const priorityHeader = priorityContainer.cloneNode();
    priorityHeader.textContent = game.i18n.localize('CSB.ActiveEffects.EffectPriorityLabel');
    effectHeader?.querySelector('.value')?.after(priorityHeader);
    const priorityInput = document.createElement('input');
    priorityInput.type = 'number';
    effectRows?.forEach((row) => {
        const index = parseInt(row.dataset.index);
        const container = priorityContainer.cloneNode();
        const input = priorityInput.cloneNode();
        input.name = `changes.${index}.priority`;
        input.value = String(activeEffectConfig.document.changes[index].priority ?? '');
        container.appendChild(input);
        row.querySelector('.value')?.after(container);
        const keyInput = row.querySelector('.key > input');
        const keyTextarea = document.createElement('textarea');
        keyTextarea.name = keyInput.name;
        keyTextarea.innerHTML = keyInput.value;
        keyInput.replaceWith(keyTextarea);
        const valueInput = row.querySelector('.value > input');
        const valueTextarea = document.createElement('textarea');
        valueTextarea.name = valueInput.name;
        valueTextarea.innerHTML = valueInput.value;
        valueInput.replaceWith(valueTextarea);
    });
});
