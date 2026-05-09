/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import CustomDialogV2 from '../applications/CustomDialogV2.js';
import { UncomputableError } from '../errors/UncomputableError.js';
import Logger from '../Logger.js';
import Panel from '../sheets/components/Panel.js';
import { FormulaFunctionImporter } from './FormulaFunctionImporter.js';
import { castToPrimitive } from '../utils.js';
import AbortFormulaError from '../errors/AbortFormulaError.js';
const userInputDisplayRegex = /^(?<name>.+?)(:(?<displayName>.+?))?(\[(?<type>.+?)])?$/;
const userInputValuesRegex = /^(?<key>".+?"|.+?)(,(?<value>".+?"|.+?))?$/;
export const mathjsBlacklist = new Set([
    'end',
    'height',
    'name',
    'uuid',
    'id',
    'img',
    'index',
    'item',
    'target',
    'this',
    'tabs'
]);
/**
 * @typedef {ComputablePhraseOptions} FormulaOptions
 * @type {Object}
 * @property {object} [localVars = {}] Local variables computed from previous formulas in the same ComputablePhrase
 */
/**
 * @typedef {FormulaOptions} StaticFormulaOptions
 * @type {Object}
 * @property {Object} [textVars = {}] Text variables pre-computed by compute method
 * @property {Array} [rolls = []] Rolls variables pre-computed by compute method
 * @property {string?} formula Formula override used by compute method
 */
/**
 * Class holding formula details, for explanation
 */
class Formula {
    /**
     * The raw uncomputed formula
     * @type {string}
     * @private
     */
    _raw;
    /**
     * The formula's computed result
     * @type {string}
     * @private
     */
    _result;
    /**
     * Local variables used in the formula's computing
     * @type {Object}
     * @private
     */
    _localVars;
    /**
     * The parsed version of the formulas, with needed replacements of tokens with unique identifiers
     * @type {string}
     * @private
     */
    _parsed;
    /**
     * Indicates if the formula contains dice rolls
     * @type {boolean}
     * @private
     */
    _hasDice;
    /**
     * All formulas computed variables, except for rolls
     * @type {Array<Object>}
     * @private
     */
    _tokens;
    /**
     * Formula computed rolls
     * @type {Object<Roll>}
     * @private
     */
    _rolls;
    /**
     * Indicates if formula should be hidden from players
     * @type {boolean}
     * @private
     */
    _hidden = false;
    /**
     * Indicates if formula should be explained
     * @type {boolean}
     * @private
     */
    _explanation = true;
    /**
     * List of updates to make at the end of a computation. Populated at computation time with the calls to the `setPropertyInEntity` function.
     * @type {Record<string, DefferedUpdate>}
     * @private
     */
    _updates = {};
    /**
     * Construct a new formula from a string
     * @param {string} formula The formula to compute
     */
    constructor(formula) {
        this._raw = formula;
    }
    /**
     * The raw uncomputed formula
     * @return {string}
     */
    get raw() {
        return this._raw;
    }
    /**
     * The formula's computed result
     * @return {string}
     */
    get result() {
        return this._result ?? 'ERROR';
    }
    /**
     * Local variables used in the formula's computing
     * @return {Object}
     */
    get localVars() {
        return this._localVars;
    }
    /**
     * The parsed version of the formulas, with needed replacements of tokens with unique identifiers
     * @return {string}
     */
    get parsed() {
        return this._parsed;
    }
    /**
     * Indicates if the formula contains dice rolls
     * @return {boolean}
     */
    get hasDice() {
        return this._hasDice;
    }
    /**
     * All formulas computed variables, except for rolls
     * @return {Array<Object>}
     */
    get tokens() {
        return this._tokens;
    }
    /**
     * Formula computed rolls
     * @return {Object<Roll>}
     */
    get rolls() {
        return this._rolls;
    }
    /**
     * Indicates if formula should be hidden from players
     * @return {boolean}
     */
    get hidden() {
        return this._hidden;
    }
    /**
     * Indicates if formula explanation should be added.
     * This will wrap the formula result with a clickable <div></div>, which contains a pop-up with the explanation
     * @return {boolean}
     */
    get explanation() {
        return this._explanation;
    }
    /**
     * List of updates to make at the end of a computation. Populated at computation time with the calls to the `setPropertyInEntity` function.
     * @type {Record<string, DefferedUpdate>}
     */
    get updates() {
        return this._updates;
    }
    /**
     * Returns true if at least one update exists in this Formula
     */
    hasUpdates() {
        return Object.keys(this.updates).length > 0;
    }
    /**
     * Returns a plain object describing the formula
     * @return {{result: string, hasDice: boolean, hidden: boolean, raw: string, parsed: string, tokens: Object<string>, rolls: Object<Roll>}}
     */
    toJSON() {
        return {
            raw: this.raw,
            result: this.result,
            parsed: this.parsed,
            hasDice: this.hasDice,
            tokens: this.tokens,
            rolls: this.rolls,
            hidden: this.hidden,
            explanation: this.explanation
        };
    }
    /**
     * Computes this formula with given props and options, computing dynamic data like rolls and user inputs
     * @param {Object} props Token attributes to replace inside the formula
     * @param {FormulaOptions} [options = {}] Computation options
     * @returns {Promise<Formula>} This formula
     * @throws {UncomputableError} If a variable can not be computed
     */
    async compute(props, options = {}) {
        // Reference is used to compute formulas in dynamic table, to reference a same-line data
        // Default value is used in case a token is not computable
        // Local vars are used to re-use previously defined vars in the phrase
        let { localVars = {}, reference = null } = options ?? {};
        Logger.debug('Computing rolls & user inputs in ${' + this._raw + '}$');
        let { formula, textVars } = handleTextVars(this._raw);
        // Rolls are formula-local tokens which hold the roll data
        let rolls = [];
        // If formula starts with #, it should not be visible by default
        if (formula.startsWith('#')) {
            this._hidden = true;
            formula = formula.substring(1);
        }
        // If formula starts with !, it should not be explained in the final chat message
        if (formula.startsWith('!')) {
            this._explanation = false;
            formula = formula.substring(1);
        }
        // Isolating user inputs templates, enclosed in ?#{} inside the formula
        let userInputTemplateTokens = formula.matchAll(/\?#{.*?}/g);
        let userInputTemplateToken = userInputTemplateTokens.next();
        while (!userInputTemplateToken.done) {
            // Removing ?#{} around the token
            let userInputTemplateName = userInputTemplateToken.value[0].substring(3).slice(0, -1);
            let templateItem = game.items.filter((item) => item.name === userInputTemplateName)[0];
            if (!templateItem) {
                const warnMsg = game.i18n.format('CSB.UserMessages.UserInputTemplateNotFound', {
                    TEMPLATE_NAME: userInputTemplateName
                });
                Logger.warn(warnMsg);
                ui.notifications.warn(warnMsg);
            }
            else {
                const tmpPanelElt = await Panel.fromJSON(templateItem.system.body, 'body').render(options.triggerEntity, true, {
                    reference: reference,
                    customProps: localVars
                });
                try {
                    let userData = await new Promise((resolve, reject) => {
                        new CustomDialogV2({
                            content: tmpPanelElt[0],
                            window: {
                                contentClasses: [templateItem.id]
                            },
                            buttons: {
                                ok: {
                                    default: true,
                                    icon: 'fas fa-checkmark',
                                    label: game.i18n.localize('Submit')
                                }
                            },
                            position: {
                                width: 'auto',
                                height: 'auto'
                            },
                            rejectClose: true,
                            submitOnClose: true,
                            submit: (result, event, button, dialog) => {
                                if (result !== 'ok') {
                                    reject(new AbortFormulaError('Dialog rejected by the user'));
                                }
                                const formData = new FormDataExtended(dialog.querySelector('form'));
                                // Get data from User Input Template
                                const values = Object.fromEntries(Array.from(formData.entries()).map(([key, value]) => {
                                    return [key.replace('system.props.', ''), castToPrimitive(value)];
                                }));
                                let labels = dialog.querySelectorAll('div[data-value]');
                                for (let elt of labels) {
                                    let eltName = elt.dataset.name.replace('system.props.', '');
                                    if (eltName) {
                                        values[eltName] = elt.dataset.value;
                                    }
                                }
                                // Get updated modifiers or Active Effect data if needed
                                let conditionalModifiers = options.triggerEntity.getSortedConditionalModifiers();
                                for (let groupKey of Object.keys(conditionalModifiers)) {
                                    conditionalModifiers[groupKey].forEach((modifier) => {
                                        const modifierKey = ComputablePhrase.computeMessageStatic(modifier.key, modifier.originalEntity.entity.system.props, {
                                            source: `modifier.${modifier.key}.key`,
                                            defaultValue: 0,
                                            triggerEntity: modifier.originalEntity
                                        }).result;
                                        foundry.utils.setProperty(values, modifierKey, foundry.utils.getProperty(options.triggerEntity.system.props, modifierKey));
                                    });
                                }
                                let activeEffects = options.triggerEntity.getSortedActiveEffects(options.triggerEntity.system, true);
                                for (const key of Object.keys(activeEffects)) {
                                    foundry.utils.setProperty(values, key, foundry.utils.getProperty(options.triggerEntity.system.props, key));
                                }
                                resolve(values);
                            }
                        }).render({ force: true });
                    });
                    localVars = { ...localVars, ...userData };
                }
                catch (err) {
                    Logger.debug(err.message);
                    throw err;
                }
            }
            formula = formula.replace(userInputTemplateToken.value[0], `"${userInputTemplateName}"`);
            this._hidden = true;
            userInputTemplateToken = userInputTemplateTokens.next();
        }
        // Isolating user inputs, enclosed in ?{} inside the formula
        let userInputTokens = formula.matchAll(/\?{.*?}/g);
        let userInputToken = userInputTokens.next();
        let allUserVars = [];
        while (!userInputToken.done) {
            let userInputSettings = {};
            // Removing ?{} around the token
            let userInputData = userInputToken.value[0].substring(2).slice(0, -1);
            let userInputDisplaySettingsRaw = userInputData.split('|')[0];
            let userInputDisplaySettings = userInputDisplayRegex.exec(userInputDisplaySettingsRaw).groups;
            userInputSettings.name = userInputDisplaySettings.name;
            userInputSettings.displayName = userInputDisplaySettings.displayName
                ? (await new Formula(userInputDisplaySettings.displayName).compute({ ...props, ...localVars }, options))
                    .result
                : userInputDisplaySettings.name;
            userInputSettings.type = userInputDisplaySettings.type ?? 'text';
            let userInputChoices = userInputData.split('|').splice(1);
            let values = [];
            for (let choice of userInputChoices) {
                let parsedChoice = userInputValuesRegex.exec(choice).groups;
                let name = (await new Formula(parsedChoice.key).compute({ ...props, ...localVars }, options)).result;
                let displayValue = parsedChoice.value
                    ? (await new Formula(parsedChoice.value).compute({ ...props, ...localVars }, options)).result
                    : name;
                let computedChoice = { name, displayValue };
                values.push(computedChoice);
            }
            if (values.length > 1) {
                userInputSettings.choices = true;
                userInputSettings.values = values;
            }
            else {
                userInputSettings.choices = false;
                userInputSettings.defaultValue = values[0]?.name;
            }
            allUserVars.push(userInputSettings);
            formula = formula.replace(userInputToken.value[0], userInputSettings.name);
            userInputToken = userInputTokens.next();
        }
        if (allUserVars.length > 0) {
            let content = await renderTemplate(`systems/${game.system.id}/templates/_template/dialogs/user-input.hbs`, {
                allUserVars: allUserVars,
                appId: foundry.utils.randomID()
            });
            try {
                let userData = await new Promise((resolve, reject) => {
                    new CustomDialogV2({
                        content: content,
                        buttons: {
                            ok: {
                                default: true,
                                icon: 'fas fa-checkmark',
                                label: game.i18n.localize('Submit')
                            }
                        },
                        submit: (result, event, button, dialog) => {
                            if (result !== 'ok') {
                                reject(new AbortFormulaError('Dialog rejected by the user'));
                            }
                            const formData = new FormDataExtended(dialog.querySelector('form'));
                            // Get data from User Input Template
                            const values = formData.object;
                            resolve(values);
                        },
                        onRender: (html) => {
                            html.querySelector('input,select')?.focus();
                            html.querySelector('input')?.select();
                            html.addEventListener('click', (event) => {
                                const target = event.target.closest('.custom-system-user-input-button');
                                if (target) {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    const btn = target;
                                    const targetRef = btn.dataset.inputref;
                                    const action = btn.dataset.inputaction;
                                    const targetInput = html.querySelector(`#${targetRef}`);
                                    const targetVal = Number.isNaN(parseInt(targetInput.value))
                                        ? 0
                                        : parseInt(targetInput.value);
                                    const actionOperation = action.split('-')[0];
                                    const actionAmount = parseInt(action.split('-')[1]);
                                    switch (actionOperation) {
                                        case 'add':
                                            targetInput.value = targetVal + actionAmount;
                                            break;
                                        case 'sub':
                                            targetInput.value = targetVal - actionAmount;
                                            break;
                                    }
                                }
                            });
                        },
                        position: {
                            width: 'auto',
                            height: 'auto'
                        },
                        rejectClose: true,
                        submitOnClose: true
                    }).render({ force: true });
                });
                localVars = { ...localVars, ...userData };
            }
            catch (err) {
                Logger.debug(err.message);
                throw err;
            }
        }
        // Handling rolls - rolls are enclosed in brackets []
        let rollMessages = formula.matchAll(/\[(:?\[[^\[\]]+\]|.)+?\]/g);
        let roll = rollMessages.next();
        while (!roll.done) {
            // Evaluating roll with Foundry VTT Roll API
            let rollString = roll.value[0];
            Logger.debug('\tRolling ' + rollString);
            let rollResult = await this.evaluateRoll(rollString.substr(1).slice(0, -1), props, options);
            if (rollResult.results) {
                formula = formula.replace(rollString, () => "'" + rollResult.results.map((e) => e.getChatText()).join(', ') + "'");
            }
            else {
                // Replacing roll result in formula for computing and saving roll data for display in chat message
                formula = formula.replace(rollString, rollResult.roll.total);
                let rollFormula = rollString === '[' + rollResult.roll.formula + ']'
                    ? rollString
                    : rollString + ' → [' + rollResult.roll.formula + ']';
                rolls.push({
                    formula: rollFormula,
                    roll: rollResult.roll.toJSON(),
                    expandRollInChatCard: rollResult.expandRollInChatCard ?? false
                });
            }
            roll = rollMessages.next();
        }
        return this.computeStatic({ ...options.triggerEntity?.props, ...props }, {
            ...options,
            localVars,
            textVars,
            rolls,
            computeExplanation: options.computeExplanation && this._explanation
        }, formula);
    }
    /**
     * Computes this formula with given props and options, computing only static data
     * @param {Object} props Token attributes to replace inside the formula
     * @param {StaticFormulaOptions} [options = {}] Computation options
     * @param {?string} [formula = null] Formula override used by compute method
     * @returns {Formula} This formula
     * @throws {UncomputableError} If a variable can not be computed
     */
    computeStatic(props, options = {}, formula = null) {
        formula = formula ?? this._raw;
        Logger.debug('Computing ${' + formula + '}$');
        let { source, reference, defaultValue, localVars = {}, textVars = {}, rolls = [], computeExplanation = false, availableKeys = [] } = options;
        const allValues = { ...props };
        if (localVars) {
            foundry.utils.mergeObject(allValues, localVars);
        }
        const computedTokens = {};
        //const mathInstance = math.create(math.all, {});
        const mathInstance = math;
        mathInstance.import(FormulaFunctionImporter.importCustomFunctions(mathInstance, allValues, {
            reference,
            defaultValue,
            source,
            formula,
            availableKeys,
            computedTokens: computedTokens,
            triggerEntity: options.triggerEntity,
            linkedEntity: options.linkedEntity,
            updates: this.updates
        }), {
            override: true
        });
        // Detecting local variable to set
        let localVarName = null;
        let localVarDecomposed = `${formula}`.match(/^([a-zA-Z0-9_-]+):=(.*)$/);
        if (localVarDecomposed) {
            localVarName = localVarDecomposed[1];
            formula = localVarDecomposed[2];
        }
        // If text-vars exist, they have already been handled ; no need to do it again
        let textVarResult = handleTextVars(formula, textVars);
        formula = textVarResult.formula;
        textVars = textVarResult.textVars;
        // Stripping formula from remaining spaces to have a consistent parsable string
        let strippedFormula = formula.trim();
        let mathTokens = { ...computedTokens, ...textVars, ...allValues };
        for (const token in mathTokens) {
            if (mathTokens[token] === undefined) {
                delete mathTokens[token];
            }
        }
        Logger.debug('Tokens for computation', { formula: strippedFormula, scope: mathTokens });
        let result;
        let explanation = [];
        let onUndefinedSymbol = mathInstance.SymbolNode.onUndefinedSymbol;
        try {
            mathInstance.SymbolNode.onUndefinedSymbol = (name) => {
                if (defaultValue !== undefined) {
                    return defaultValue;
                }
                else {
                    throw new UncomputableError(`Uncomputable token "${name}"`, source, formula, props);
                }
            };
            let node = mathInstance.parse(strippedFormula);
            result = node.evaluate(mathTokens);
            for (const [key, value] of Object.entries(textVars)) {
                result = result.replace(key, value);
            }
            if (computeExplanation) {
                explanation = this.getSymbolsInOrder(node, { children: [] }, mathTokens);
                Logger.debug(strippedFormula, {
                    name: strippedFormula,
                    children: [this.getSymbolTree(node)],
                    listInOrder: explanation
                });
            }
        }
        catch (err) {
            if (err instanceof UncomputableError) {
                throw err;
            }
            else {
                result = undefined;
                Logger.error(err.message, err, { formula, props, source });
            }
        }
        finally {
            // Reset onUndefinedSymbol
            mathInstance.SymbolNode.onUndefinedSymbol = onUndefinedSymbol;
        }
        if (localVarName) {
            localVars[localVarName] = result;
        }
        // Save every detail of the computation
        this._result = result;
        this._localVars = localVars;
        this._parsed = strippedFormula;
        this._hasDice = rolls.length > 0;
        this._tokens = explanation;
        this._rolls = rolls;
        return this;
    }
    /**
     * Evaluates a roll expression through Foundry VTT Roll API
     * @param {string} rollText The FoundryVTT roll expression
     * @param {Object} props Token attributes to replace inside the formula
     * @param {ComputablePhraseOptions} options Computation options for replaceable variables in the roll expression
     * @returns {Roll}
     */
    async evaluateRoll(rollText, props, options) {
        const computeRollPhrase = async (text) => {
            // Roll can contain parameters delimited by colons (:)
            let textParamMatcher = text.matchAll(/:(.*?):/g);
            let textParam = textParamMatcher.next();
            // Start by building a temporary phrase with every found parameter
            // A roll like [1d100 + :STR:] will become [1d100 + ${STR}$], which can be computed like other formulas
            while (!textParam.done) {
                text = text.replace(textParam.value[0], () => `\${${textParam.value[1]}}\$`);
                textParam = textParamMatcher.next();
            }
            // Temporary phrase is computed to get a number & dice only phrase
            let finalText = new ComputablePhrase(text);
            await finalText.compute(props, options);
            return finalText;
        };
        let isRollTable = false;
        let expandRollInChatCard = false;
        let selectValue = null;
        if (rollText.startsWith('!')) {
            expandRollInChatCard = true;
            rollText = rollText.substring(1);
        }
        if (rollText.startsWith('#')) {
            isRollTable = true;
            let separatedRoll = rollText.substring(1).split('|', 2);
            rollText = separatedRoll[0];
            selectValue = separatedRoll[1] ?? null;
        }
        let finalRollText = await computeRollPhrase(rollText);
        if (isRollTable) {
            let rollTable = game.tables.filter((e) => e.name === finalRollText.result)[0];
            if (selectValue) {
                let finalSelectValue = await computeRollPhrase(selectValue);
                let roll = new Roll(finalSelectValue.result);
                await roll.evaluate();
                return { ...(await rollTable.draw({ displayChat: false, roll })), expandRollInChatCard };
            }
            else {
                return { ...(await rollTable.draw({ displayChat: false })), expandRollInChatCard };
            }
        }
        else {
            // Roll evaluation
            let roll = new Roll(finalRollText.result);
            await roll.evaluate();
            return { roll, expandRollInChatCard };
        }
    }
    getSymbolsInOrder(rootNode, currentSymbol, mathTokens) {
        if (rootNode.type === 'SymbolNode' && !math[rootNode.name] && !rootNode.name.startsWith('_')) {
            currentSymbol = {
                display: rootNode.name,
                handle: rootNode.name,
                children: [],
                value: rootNode.evaluate(mathTokens)
            };
        }
        else if (rootNode.type === 'FunctionNode' &&
            ['lookup', 'lookupRef', 'ref', 'sameRow', 'first', 'replace', 'replaceAll', 'fetchFromActor'].includes(rootNode.name)) {
            let argsName = [];
            switch (rootNode.name) {
                case 'lookup':
                case 'lookupRef':
                    argsName = [
                        '',
                        game.i18n.localize('CSB.Formula.Target'),
                        game.i18n.localize('CSB.Formula.Where'),
                        game.i18n.localize('CSB.Formula.Is'),
                        game.i18n.localize('CSB.Formula.Operator')
                    ];
                    break;
                case 'ref':
                case 'sameRow':
                case 'first':
                    argsName = ['', game.i18n.localize('CSB.Formula.Default')];
                    break;
                case 'replace':
                case 'replaceAll':
                    argsName = [
                        '',
                        game.i18n.localize('CSB.Formula.Search'),
                        game.i18n.localize('CSB.Formula.ReplaceWith')
                    ];
                    break;
                case 'fetchFromActor':
                    argsName = ['', '', game.i18n.localize('CSB.Formula.Default')];
                    break;
                case 'setPropertyInEntity':
                    argsName = [
                        '',
                        game.i18n.localize('CSB.Formula.Property'),
                        game.i18n.localize('CSB.Formula.NewValue'),
                        game.i18n.localize('CSB.Formula.Default')
                    ];
                    break;
            }
            let functionHandle = rootNode.name +
                '(' +
                rootNode.args
                    .map((arg, idx) => (argsName[idx]
                    ? '<span class="custom-system-arg-tooltip">' + argsName[idx] + ' : </span>'
                    : '') + arg)
                    .join(', ') +
                ')';
            currentSymbol = {
                handle: rootNode.toString(),
                display: functionHandle,
                children: [],
                value: rootNode.evaluate(mathTokens)
            };
        }
        rootNode.forEach((node, path, parent) => {
            let subSymbol = this.getSymbolsInOrder(node, currentSymbol, mathTokens);
            if (subSymbol.display !== currentSymbol.display) {
                if (!currentSymbol.children.some((e) => e.display === subSymbol.display)) {
                    currentSymbol.children.push(subSymbol);
                }
            }
        });
        return currentSymbol;
    }
    getSymbolTree(rootNode) {
        let treeNode = {
            name: rootNode.type +
                ' (' +
                (rootNode.name ?? rootNode.op ?? rootNode.value ?? '') +
                ') --- ' +
                rootNode.toString(),
            children: []
        };
        rootNode.forEach((node, path, parent) => {
            treeNode.children.push(this.getSymbolTree(node));
        });
        return treeNode;
    }
}
/**
 * Handles text variables by extracting them and replacing them with tokens
 * @param formula
 * @param textVars Text vars are formula-local tokens which hold the texts
 * @returns {Object}
 * @ignore
 */
const handleTextVars = (formula, textVars = {}) => {
    formula = formula.toString();
    // Isolating text data, enclosed in '' inside the formula
    // The (?<!\\)' part means match quotes (') which are not preceded by \
    let textTokens = formula.matchAll(/(?<!\\)'.*?(?<!\\)'/g);
    let textToken = textTokens.next();
    while (!textToken.done) {
        let textValue = textToken.value[0].substring(1, textToken.value[0].length - 1);
        if (textValue.includes("'")) {
            let textRef = '_computedText_' + (Object.keys(textVars).length + 1);
            // Recreate apostrophes inside text + removing delimiters
            textVars[textRef] = textValue.replaceAll('\\', '');
            formula = formula.replace(textToken.value[0], textRef);
        }
        textToken = textTokens.next();
    }
    return { formula, textVars };
};
export default Formula;
