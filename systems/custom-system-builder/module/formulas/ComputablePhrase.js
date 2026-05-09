/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Formula from './Formula.js';
import { postAugmentedChatMessage } from '../utils.js';
import Logger from '../Logger.js';
/**
 * Class holding computed phrase details, for explanation
 */
export default class ComputablePhrase {
    /**
     * The initial phrase to be computed
     */
    _rawPhrase;
    /**
     * The built phrase with every inner formula replaced with a unique identifier
     */
    _buildPhrase;
    /**
     * All the inner formulas computed, assigned with a unique identifier
     */
    _computedFormulas = {};
    /** List of updates to make at the end of a computation. Populated at computation time with the calls to the `setPropertyInEntity` function. */
    _updates = {};
    /**
     * Constructs new ComputablePhrase with a phrase to compute
     * @param phrase The phrase to compute
     */
    constructor(phrase) {
        this._rawPhrase = phrase;
    }
    /**
     * Gets the raw formula
     */
    get formula() {
        let phrase = this._buildPhrase;
        for (const key in this._computedFormulas) {
            phrase = phrase.replaceAll(key, this._computedFormulas[key].raw);
        }
        return phrase;
    }
    /**
     * Gets the computed formula, i.e. the raw formula with all token replaced by their parsed values
     */
    get parsed() {
        let phrase = this._buildPhrase;
        for (const key in this._computedFormulas) {
            phrase = phrase.replaceAll(key, this._computedFormulas[key].parsed);
        }
        return phrase;
    }
    /**
     * Gets the phrase ready for replacements
     */
    get buildPhrase() {
        return this._buildPhrase;
    }
    /**
     * Gets the resulting phrase, i.e. the fully computed values
     */
    get result() {
        let phrase = this._buildPhrase;
        for (const key in this._computedFormulas) {
            phrase = phrase.replace(key, this._computedFormulas[key].result);
        }
        return phrase;
    }
    /**
     * Gets the computed formulas of the phrase, for building purposes
     */
    get values() {
        return this._computedFormulas;
    }
    /**
     * Posts phrase as a Chat Message
     * @param options Chat message options
     * @see https://foundryvtt.com/api/interfaces/foundry.types.ChatMessageData.html
     */
    postMessage(options) {
        postAugmentedChatMessage({ buildPhrase: this.buildPhrase, values: this.values }, options);
    }
    /**
     * Computes everything in the phrase, including dynamic data such as rolls and user inputs
     * @param props Properties used for computation
     * @param options Options to compute the phrase
     * @returns The updated computable phrase
     * @throws {UncomputableError} If a variable can not be computed
     */
    async compute(props, options = { computeExplanation: false, availableKeys: [] }) {
        Logger.debug('Computing ' + this._rawPhrase);
        const phrase = this._rawPhrase;
        let localVars = {};
        const computedFormulas = {};
        let nComputed = 0;
        const processFormulas = async ({ buildPhrase, expression }) => {
            const allFormulas = this._extractFormulas(expression);
            for (const textFormula of allFormulas) {
                const computedId = '${form' + nComputed + '}$';
                if (textFormula.startsWith('${') && textFormula.endsWith('}$')) {
                    // Recurse to handle potential sub-scripts
                    const processedFormula = await processFormulas({
                        buildPhrase: textFormula.substring(2).slice(0, -2),
                        expression: textFormula.substring(2).slice(0, -2)
                    });
                    const formula = new Formula(processedFormula.expression);
                    // options.defaultValue = undefined;
                    await formula.compute(props, {
                        localVars,
                        ...options
                    });
                    // Saves formula data
                    computedFormulas[computedId] = formula;
                    buildPhrase = buildPhrase.replace(textFormula, computedId);
                    expression = expression.replace(textFormula, formula.result);
                    localVars = {
                        ...localVars,
                        ...formula.localVars
                    };
                    if (formula.hasUpdates()) {
                        foundry.utils.mergeObject(this._updates, formula.updates);
                    }
                }
                else if (textFormula.startsWith('%{') && textFormula.endsWith('}%')) {
                    // Recurse to handle potential sub-scripts
                    const processedFormula = await processFormulas({
                        buildPhrase: textFormula.substring(2).slice(0, -2),
                        expression: textFormula.substring(2).slice(0, -2)
                    });
                    const AsyncFunction = async function () { }.constructor;
                    let result;
                    try {
                        result = await AsyncFunction('entity', 'linkedEntity', 'localVars', 'options', processedFormula.expression)(options.triggerEntity, options.linkedEntity, localVars, options);
                    }
                    catch (err) {
                        if (options.defaultValue !== null && options.defaultValue !== undefined) {
                            result = options.defaultValue;
                            Logger.error(err.message, err);
                        }
                        else {
                            throw err;
                        }
                    }
                    result = this._castScriptResult(result);
                    const formula = new Formula(String(result));
                    await formula.compute(props, {
                        localVars,
                        ...options
                    });
                    // Saves formula data
                    computedFormulas[computedId] = formula;
                    buildPhrase = buildPhrase.replace(textFormula, computedId);
                    expression = expression.replace(textFormula, String(result));
                    if (formula.hasUpdates()) {
                        foundry.utils.mergeObject(this._updates, formula.updates);
                    }
                }
                nComputed++;
            }
            return { buildPhrase, expression };
        };
        const processedFormula = await processFormulas({ buildPhrase: phrase, expression: phrase });
        this._buildPhrase = processedFormula.buildPhrase;
        this._computedFormulas = computedFormulas;
        if (Object.keys(this._updates).length > 0) {
            Logger.debug('Updating documents', this._updates);
            const uuids = Object.keys(this._updates);
            for (const uuid of uuids) {
                const document = (await fromUuid(uuid.replaceAll('-', '.')));
                await document.update(this._updates[uuid]);
            }
        }
        return this;
    }
    /**
     * Computes the phrase without any dynamic data such as rolls and user inputs. If rolls or user inputs syntax are present, will throw an error.
     * @param props Properties used for computation
     * @param options Options to compute the phrase
     * @returns The updated computable phrase
     * @throws {UncomputableError} If a variable can not be computed
     */
    computeStatic(props, options = { computeExplanation: false, availableKeys: [] }) {
        Logger.debug('Computing ' + this._rawPhrase);
        const phrase = this._rawPhrase;
        let localVars = {};
        const computedFormulas = {};
        let nComputed = 0;
        const processFormulas = ({ buildPhrase, expression }) => {
            const allFormulas = this._extractFormulas(expression);
            for (const textFormula of allFormulas) {
                const computedId = '${form' + nComputed + '}$';
                if (textFormula.startsWith('${') && textFormula.endsWith('}$')) {
                    // Recurse to handle potential sub-scripts
                    const processedFormula = processFormulas({
                        buildPhrase: textFormula.substring(2).slice(0, -2),
                        expression: textFormula.substring(2).slice(0, -2)
                    });
                    const formula = new Formula(processedFormula.expression);
                    // options.defaultValue = undefined;
                    formula.computeStatic(props, {
                        localVars,
                        ...options
                    });
                    // Saves formula data
                    computedFormulas[computedId] = formula;
                    buildPhrase = buildPhrase.replace(textFormula, computedId);
                    expression = expression.replace(textFormula, formula.result);
                    localVars = {
                        ...localVars,
                        ...formula.localVars
                    };
                }
                else if (textFormula.startsWith('%{') && textFormula.endsWith('}%')) {
                    // Recurse to handle potential sub-scripts
                    const processedFormula = processFormulas({
                        buildPhrase: textFormula.substring(2).slice(0, -2),
                        expression: textFormula.substring(2).slice(0, -2)
                    });
                    let result;
                    try {
                        result = Function('entity', 'linkedEntity', 'localVars', 'options', processedFormula.expression)(options.triggerEntity, options.linkedEntity, localVars, options);
                    }
                    catch (err) {
                        if (options.defaultValue !== null && options.defaultValue !== undefined) {
                            result = options.defaultValue;
                            Logger.error(err.message, err);
                        }
                        else {
                            throw err;
                        }
                    }
                    result = this._castScriptResult(result);
                    const formula = new Formula(String(result));
                    formula.computeStatic(props, {
                        localVars,
                        ...options
                    });
                    // Saves formula data
                    computedFormulas[computedId] = formula;
                    buildPhrase = buildPhrase.replace(textFormula, computedId);
                    expression = expression.replace(textFormula, String(result));
                }
                nComputed++;
            }
            return { buildPhrase, expression };
        };
        const processedFormula = processFormulas({ buildPhrase: phrase, expression: phrase });
        this._buildPhrase = processedFormula.buildPhrase;
        this._computedFormulas = computedFormulas;
        return this;
    }
    /**
     * Computes a phrase, including dynamic data such as rolls and user inputs
     * @param phrase The phrase to compute
     * @param props Properties used for computation
     * @param options Options to compute the phrase
     * @returns The computable phrase
     * @throws {UncomputableError} If a variable can not be computed
     */
    static async computeMessage(phrase, props, options = { computeExplanation: false, availableKeys: [] }) {
        const computablePhrase = new ComputablePhrase(phrase);
        await computablePhrase.compute(props, options);
        return computablePhrase;
    }
    /**
     * Computes a phrase without any dynamic data such as rolls and user inputs. If rolls or user inputs syntax are present, will throw an error.
     * @param phrase The phrase to compute
     * @param props Properties used for computation
     * @param options Options to compute the phrase
     * @returns The computable phrase
     * @throws {UncomputableError} If a variable can not be computed
     */
    static computeMessageStatic(phrase, props, options = { computeExplanation: false, availableKeys: [] }) {
        const computablePhrase = new ComputablePhrase(phrase);
        computablePhrase.computeStatic(props, options);
        return computablePhrase;
    }
    /**
     * Extracts formulas & scripts from a raw computable phrase
     * @param expression The expression in which to extract Formulas
     * @returns The array of extracted formulas and scripts
     */
    _extractFormulas(expression) {
        const formulaType = 'formula';
        const scriptType = 'script';
        const formulaBrackets = ['${', '}$'];
        const scriptBrackets = ['%{', '}%'];
        let nFormulaBrackets = 0;
        let nScriptBrackets = 0;
        const extracted = [];
        let currentExtract = '';
        let extracting = null;
        for (let i = 0; i < expression.length; i++) {
            const currentChar = expression.charAt(i);
            const nextChar = expression.charAt(i + 1);
            const currentPair = currentChar + nextChar;
            if (currentPair === formulaBrackets[0]) {
                nFormulaBrackets++;
                if (!extracting) {
                    extracting = formulaType;
                }
            }
            else if (currentPair === scriptBrackets[0]) {
                nScriptBrackets++;
                if (!extracting) {
                    extracting = scriptType;
                }
            }
            else if (currentPair === formulaBrackets[1]) {
                nFormulaBrackets--;
                if (nFormulaBrackets === 0 && extracting === formulaType) {
                    extracting = null;
                    extracted.push(currentExtract + currentPair);
                    currentExtract = '';
                }
            }
            else if (currentPair === scriptBrackets[1]) {
                nScriptBrackets--;
                if (nScriptBrackets === 0 && extracting === scriptType) {
                    extracting = null;
                    extracted.push(currentExtract + currentPair);
                    currentExtract = '';
                }
            }
            if (extracting) {
                currentExtract += currentChar;
            }
        }
        return extracted;
    }
    /**
     * Casts a value to a Defined Primitive
     * @param value The value to cast
     * @returns The casted value
     */
    _castScriptResult(value) {
        if (value === undefined) {
            return 'undefined';
        }
        if (value === null) {
            return 'null';
        }
        if (typeof value === 'object' && !Array.isArray(value)) {
            return 'object';
        }
        if (!(typeof value === 'number' || typeof value === 'boolean')) {
            return `'${value.toString()}'`;
        }
        return value;
    }
    /**
     * Returns the fully computed phrase as a string
     */
    toString() {
        return this.result;
    }
}
globalThis.ComputablePhrase = ComputablePhrase;
