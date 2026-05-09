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
import InputComponent from './InputComponent.js';
import { getValueFromProseMirror, trimProseMirrorEmptyValue } from '../../utils.js';
import CustomDialogV2 from '../../applications/CustomDialogV2.js';
export const RICH_TEXT_AREA_STYLES = {
    sheet: 'CSB.ComponentProperties.TextArea.Style.InSheetEditor',
    dialog: 'CSB.ComponentProperties.TextArea.Style.DialogEditor',
    icon: 'CSB.ComponentProperties.TextArea.Style.IconOnly'
};
/**
 * Rich text area component
 * @ignore
 */
class RichTextArea extends InputComponent {
    /**
     * Rich text area style
     */
    _style;
    /**
     * Rich text area constructor
     */
    constructor(props) {
        super(props);
        this._style = props.style;
    }
    /**
     * Renders component
     */
    async _getElement(entity, isEditable = true, options = {}) {
        const jQElement = await super._getElement(entity, isEditable, options);
        jQElement.addClass('custom-system-text-area');
        jQElement.addClass('custom-system-rich-editor' + (this._style !== 'sheet' ? '-dialog' : ''));
        if (TemplateSystem.isAppliedTemplateSystem(entity)) {
            const props = { ...entity.system.props, ...options.customProps };
            const contents = (foundry.utils.getProperty(props, this.key) || this.defaultValue) ?? '';
            const enrichedContents = await TextEditor.enrichHTML(contents, {
                secrets: isEditable,
                rollData: entity.getRollData()
            });
            const editButton = $('<a></a>');
            editButton.addClass('custom-system-rich-editor-button');
            editButton.html('<i class="fas fa-edit"></i>');
            editButton.on('click', () => {
                const content = `<${foundry.applications.elements.HTMLProseMirrorElement.tagName} style="height: 100%" value="${contents.replace(/"/g, '&quot;')}">${enrichedContents}</${foundry.applications.elements.HTMLProseMirrorElement.tagName}><input type="hidden" class="closingAction" value="save" />`;
                // Dialog creation
                const d = new CustomDialogV2({
                    content: content,
                    buttons: {
                        save: {
                            default: true,
                            icon: 'fas fa-check',
                            label: game.i18n.localize('Save'),
                            callback: async (_event, _button, dialog) => {
                                const editorValue = getValueFromProseMirror(dialog.querySelector('prose-mirror'));
                                const newValue = editorValue;
                                foundry.utils.setProperty(entity.system.props, this.key, trimProseMirrorEmptyValue(newValue));
                                entity.entity.update({
                                    system: {
                                        props: entity.system.props
                                    }
                                });
                            }
                        },
                        cancel: {
                            icon: 'fas fa-times',
                            label: game.i18n.localize('Cancel')
                        }
                    },
                    submitOnClose: true,
                    position: {
                        width: 550,
                        height: 480
                    },
                    window: {
                        title: game.i18n.localize('CSB.ComponentProperties.TextArea.Dialog.Title'),
                        resizable: true
                    }
                });
                d.render({ force: true });
            });
            const editor = $('<div></div>');
            editor.addClass('custom-system-rich-content');
            switch (this._style) {
                case 'sheet':
                    if (isEditable) {
                        editor.append(`<${foundry.applications.elements.HTMLProseMirrorElement.tagName} name="system.props.${this.key}" value="${contents.replace(/"/g, '&quot;')}" toggled="toggled">${enrichedContents}</${foundry.applications.elements.HTMLProseMirrorElement.tagName}>`);
                    }
                    else {
                        editor.html(enrichedContents);
                    }
                    break;
                case 'dialog':
                    editor.html(enrichedContents);
                    if (contents !== '') {
                        editButton.addClass('custom-system-rich-editor-button-float');
                    }
                    jQElement
                        .on('mouseover', () => {
                        editButton.show();
                    })
                        .on('mouseleave', () => {
                        if (contents !== '') {
                            editButton.hide();
                        }
                    });
                    break;
                case 'icon':
                default:
                    break;
            }
            jQElement.append(editor);
            if (isEditable && this._style !== 'sheet') {
                jQElement.append(editButton);
            }
        }
        else if (TemplateSystem.isBuilderTemplateSystem(entity)) {
            jQElement.addClass('custom-system-editable-component');
            jQElement.append(this.defaultValue === '' || this.defaultValue === undefined ? '&#9744;' : this.defaultValue);
            jQElement.append($('<i class="fas fa-paragraph"></i>'));
            jQElement.on('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.editComponent(entity);
            });
        }
        return jQElement;
    }
    /**
     * Returns serialized component
     */
    toJSON() {
        const jsonObj = super.toJSON();
        return {
            ...jsonObj,
            style: this._style
        };
    }
    /**
     * Creates RichTextArea from JSON description
     */
    static fromJSON(json, templateAddress, parent) {
        return new RichTextArea({
            ...json,
            parent: parent,
            templateAddress: templateAddress
        });
    }
    /**
     * Gets technical name for this component's type
     * @return The technical name
     * @throws {Error} If not implemented
     */
    static getTechnicalName() {
        return 'textArea';
    }
    /**
     * Gets pretty name for this component's type
     * @returns The pretty name
     * @throws {Error} If not implemented
     */
    static getPrettyName() {
        return game.i18n.localize('CSB.ComponentProperties.ComponentType.RichTextArea');
    }
    /**
     * Get configuration form for component creation / edition
     * @returns The jQuery element holding the component
     */
    static async getConfigForm(_entity, appId, existingComponent) {
        const mainElt = document.createElement('div');
        mainElt.innerHTML = await renderTemplate(`systems/${game.system.id}/templates/_template/components/textArea.hbs`, {
            ...existingComponent,
            RICH_TEXT_AREA_STYLES,
            appId
        });
        return mainElt;
    }
    /**
     * Extracts configuration from submitted HTML form
     * @param html The submitted form
     * @returns The JSON representation of the component
     * @throws {Error} If configuration is not correct
     */
    static extractConfig(rawConfigData, html) {
        const configData = rawConfigData;
        const editorValue = getValueFromProseMirror(html.querySelector('prose-mirror[name="textAreaValue"]'));
        const fieldData = {
            ...super.extractConfig(configData, html),
            defaultValue: trimProseMirrorEmptyValue(editorValue),
            style: configData.textAreaStyle
        };
        return fieldData;
    }
}
/**
 * @ignore
 */
export default RichTextArea;
