/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import CustomItem from '../documents/CustomItem.js';
import { castToPrimitive, quoteString } from '../utils.js';
import Logger from '../Logger.js';
import Formula from './Formula.js';
import CustomActor from '../documents/CustomActor.js';
import { UncomputableError } from '../errors/UncomputableError.js';
export class FormulaFunctionImporter {
    static importCustomFunctions(mathInstance, props, options) {
        const customFunctions = {
            sameRow: (columnName, fallbackValue = null) => {
                const fullReference = `${options.reference}.${columnName}`;
                // Fetching the value inside dynamic table's row
                const returnValue = castToPrimitive(foundry.utils.getProperty(props, fullReference)) ??
                    fallbackValue ??
                    options.defaultValue;
                if (returnValue === undefined) {
                    throw new UncomputableError(`Uncomputable token "sameRow(${quoteString(columnName)})". Failed to obtain value from the same row in the column "${columnName}". Make sure, that the column-key is correct.`, options.source, options.formula, props);
                }
                options.computedTokens[`sameRow(${quoteString(columnName)})`] = returnValue;
                return returnValue;
            },
            sameRowRef: (columnName) => {
                return `${options.reference}.${columnName}`;
            },
            sameRowIndex: () => {
                if (!options.reference) {
                    throw new UncomputableError('"sameRowIndex()" can only be used in referencable Tables', options.source, options.formula, props);
                }
                const referenceParts = options.reference.split('.');
                const dynamicTableProps = foundry.utils.getProperty(props, referenceParts[0]);
                const rowKeys = Object.entries(dynamicTableProps)
                    .filter(([_, row]) => !row.$deleted)
                    .map(([key, _]) => key);
                return Number(rowKeys.findIndex((row) => row === referenceParts[1]));
            },
            lookupRef: (extensibleTableKey, targetColumn, filterColumn = null, filterValue = null) => {
                const extensibleTableProps = foundry.utils.getProperty(props, extensibleTableKey);
                if (extensibleTableProps === undefined) {
                    throw new UncomputableError(`Uncomputable token "lookupRef(${quoteString(extensibleTableKey)}, ${quoteString(targetColumn)}, ${quoteString(filterColumn)}, ${quoteString(filterValue)})"`, options.source, options.formula, props);
                }
                return Object.entries(extensibleTableProps)
                    .filter(([_, row]) => (!row.$deleted && filterColumn ? row[filterColumn] === filterValue : true))
                    .map(([key]) => `${extensibleTableKey}.${key}.${targetColumn}`);
            },
            lookup: (extensibleTableKey, targetColumn, filterColumn = null, filterValue = null, comparisonOperator = '===') => {
                let values = [];
                let filterFunction = () => true;
                if (filterColumn) {
                    filterFunction = (elt) => {
                        switch (comparisonOperator) {
                            case '===':
                                return elt[filterColumn] === filterValue;
                            case '==':
                                return elt[filterColumn] == filterValue;
                            case '>':
                                return Number(elt[filterColumn]) > Number(filterValue);
                            case '>=':
                                return Number(elt[filterColumn]) >= Number(filterValue);
                            case '<':
                                return Number(elt[filterColumn]) < Number(filterValue);
                            case '<=':
                                return Number(elt[filterColumn]) <= Number(filterValue);
                            case '!==':
                                return elt[filterColumn] !== filterValue;
                            case '!=':
                                return elt[filterColumn] != filterValue;
                            case '~':
                                return String(elt[filterColumn]).match(String(filterValue));
                            default:
                                Logger.error(`"${comparisonOperator}" is not a valid comparison operator.`);
                                return false;
                        }
                    };
                }
                const extensibleTableProps = foundry.utils.getProperty(props, extensibleTableKey);
                const extensibleTablePropsArray = Object.values(extensibleTableProps ?? {})
                    .filter((row) => !row.$deleted)
                    .map((row) => {
                    const filteredRow = {};
                    for (const prop of Object.keys(row).filter((key) => !key.startsWith('$'))) {
                        filteredRow[prop] = row[prop];
                    }
                    return filteredRow;
                });
                if (extensibleTablePropsArray.length > 0 &&
                    !extensibleTablePropsArray.some((row) => Object.keys(row).length > 0 && row[targetColumn] !== undefined && row[targetColumn] !== null)) {
                    throw new UncomputableError(`Uncomputable token "lookup(${quoteString(extensibleTableKey)}, ${quoteString(targetColumn)}, ${quoteString(filterColumn)}, ${quoteString(filterValue)}, ${quoteString(comparisonOperator)})"`, options.source, options.formula, props);
                }
                values = extensibleTablePropsArray
                    .filter((row) => !row.$deleted && filterFunction(row))
                    .map((row) => castToPrimitive(row[targetColumn]))
                    .filter((value) => value !== undefined && value !== null);
                options.computedTokens[`lookup(${quoteString(extensibleTableKey)}, ${quoteString(targetColumn)}, ${quoteString(filterColumn)}, ${quoteString(filterValue)}, ${quoteString(comparisonOperator)})`] = values;
                return values;
            },
            alookup: (extensibleTableKey, targetColumn, ...filterArgs) => {
                if (filterArgs.length % 3 != 0) {
                    throw new UncomputableError(`The amount of filter arguments must be a multiple of 3, but you have only ${filterArgs.length}`, options.source, options.formula, props);
                }
                let values = [];
                const extensibleTableProps = foundry.utils.getProperty(props, extensibleTableKey);
                let extensibleTablePropsArray = Object.values(extensibleTableProps ?? {})
                    .filter((row) => !row.$deleted)
                    .map((row) => {
                    const filteredRow = {};
                    for (const prop of Object.keys(row).filter((key) => !key.startsWith('$'))) {
                        filteredRow[prop] = row[prop];
                    }
                    return filteredRow;
                });
                if (extensibleTablePropsArray.length > 0 &&
                    !extensibleTablePropsArray.some((row) => Object.keys(row).length > 0 && row[targetColumn] !== undefined && row[targetColumn] !== null)) {
                    throw new UncomputableError(`Uncomputable token "alookup(${quoteString(extensibleTableKey)}, ${quoteString(targetColumn)},
                            ${filterArgs.map((arg) => `'${arg}'`).join(', ')})"`, options.source, options.formula, props);
                }
                for (let i = 0; i < filterArgs.length / 3; i++) {
                    const filterColumn = filterArgs[i * 3];
                    const comparisonOperator = filterArgs[i * 3 + 1];
                    const filterValue = filterArgs[i * 3 + 2];
                    let filterFunction = () => true;
                    if (filterColumn) {
                        filterFunction = (elt) => {
                            switch (comparisonOperator) {
                                case '===':
                                    return elt[filterColumn] === filterValue;
                                case '==':
                                    return elt[filterColumn] == filterValue;
                                case '>':
                                    return Number(elt[filterColumn]) > Number(filterValue);
                                case '>=':
                                    return Number(elt[filterColumn]) >= Number(filterValue);
                                case '<':
                                    return Number(elt[filterColumn]) < Number(filterValue);
                                case '<=':
                                    return Number(elt[filterColumn]) <= Number(filterValue);
                                case '!==':
                                    return elt[filterColumn] !== filterValue;
                                case '!=':
                                    return elt[filterColumn] != filterValue;
                                case '~':
                                    return String(elt[filterColumn]).match(String(filterValue));
                                default:
                                    Logger.error(`"${comparisonOperator}" is not a valid comparison operator.`);
                                    return false;
                            }
                        };
                    }
                    extensibleTablePropsArray = extensibleTablePropsArray.filter((row) => filterFunction(row));
                }
                values = extensibleTablePropsArray
                    .map((row) => castToPrimitive(row[targetColumn]))
                    .filter((value) => value !== undefined && value !== null);
                options.computedTokens[`alookup(${quoteString(extensibleTableKey)}, ${quoteString(targetColumn)},
                            ${filterArgs.map((arg) => `'${arg}'`).join(', ')})`] = values;
                return values;
            },
            lookupRange(extensibleTableKey, targetColumn, lookupColumn, value, opts = {
                orderBy: 'ASC',
                isSorted: false,
                isInclusive: true
            }) {
                const extensibleTableProps = foundry.utils.getProperty(props, extensibleTableKey);
                const extensibleTablePropsArray = Object.values(extensibleTableProps ?? {})
                    .filter((row) => !row.$deleted)
                    .map((row) => {
                    const filteredRow = {};
                    for (const prop of Object.keys(row).filter((key) => !key.startsWith('$'))) {
                        filteredRow[prop] = row[prop];
                    }
                    return filteredRow;
                });
                if (extensibleTablePropsArray.length > 0 &&
                    !extensibleTablePropsArray.some((row) => Object.keys(row).length > 0 && row[targetColumn] !== undefined && row[targetColumn] !== null)) {
                    throw new UncomputableError(`Uncomputable token "lookupRange(${quoteString(extensibleTableKey)}, ${quoteString(targetColumn)}, ${quoteString(lookupColumn)}, ${quoteString(value)}, 
                            {orderBy: ${quoteString(opts.orderBy)}, isSorted: ${opts.isSorted}, isInclusive: ${opts.isInclusive}})"`, options.source, options.formula, props);
                }
                if (!opts.isSorted) {
                    const compareSort = opts.orderBy === 'ASC'
                        ? (a, b) => a[lookupColumn] - b[lookupColumn]
                        : (a, b) => b[lookupColumn] - a[lookupColumn];
                    extensibleTablePropsArray.sort(compareSort);
                }
                const hasReachedRange = opts.orderBy === 'ASC'
                    ? opts.isInclusive
                        ? (a, b) => a <= b
                        : (a, b) => a < b
                    : opts.isInclusive
                        ? (a, b) => a >= b
                        : (a, b) => a > b;
                const returnRow = extensibleTablePropsArray
                    .reverse()
                    .find((row) => hasReachedRange(Number(row[lookupColumn]), Number(value)));
                const returnValue = returnRow ? returnRow[targetColumn] : null;
                options.computedTokens[`lookupRange(${quoteString(extensibleTableKey)}, ${quoteString(targetColumn)},
                            ${quoteString(lookupColumn)}, ${quoteString(value)}, 
                            {orderBy: ${quoteString(opts.orderBy)}, isSorted: ${opts.isSorted}, isInclusive: ${opts.isInclusive}})`] = returnValue;
                return returnValue;
            },
            find: (extensibleTableKey, targetColumn, filterColumn = null, filterValue = null, comparisonOperator = '===') => {
                let filterFunction = () => true;
                if (filterColumn) {
                    filterFunction = (elt) => {
                        switch (comparisonOperator) {
                            case '===':
                                return elt[filterColumn] === filterValue;
                            case '==':
                                return elt[filterColumn] == filterValue;
                            case '>':
                                return Number(elt[filterColumn]) > Number(filterValue);
                            case '>=':
                                return Number(elt[filterColumn]) >= Number(filterValue);
                            case '<':
                                return Number(elt[filterColumn]) < Number(filterValue);
                            case '<=':
                                return Number(elt[filterColumn]) <= Number(filterValue);
                            case '!==':
                                return elt[filterColumn] !== filterValue;
                            case '!=':
                                return elt[filterColumn] != filterValue;
                            case '~':
                                return String(elt[filterColumn]).match(String(filterValue));
                            default:
                                Logger.error(`"${comparisonOperator}" is not a valid comparison operator.`);
                                return false;
                        }
                    };
                }
                const extensibleTableProps = foundry.utils.getProperty(props, extensibleTableKey);
                const returnRow = Object.values(extensibleTableProps ?? {}).find((row) => {
                    if (Object.keys(row).length === 0 ||
                        row[targetColumn] === undefined ||
                        row[targetColumn] === null) {
                        throw new UncomputableError(`Uncomputable token "find(${quoteString(extensibleTableKey)}, ${quoteString(targetColumn)}, ${quoteString(filterColumn)}, ${quoteString(filterValue)}, ${quoteString(comparisonOperator)})"`, options.source, options.formula, props);
                    }
                    return !row.$deleted && filterFunction(row);
                });
                const returnValue = returnRow ? returnRow[targetColumn] : null;
                options.computedTokens[`find(${quoteString(extensibleTableKey)}, ${quoteString(targetColumn)}, ${quoteString(filterColumn)}, ${quoteString(filterValue)}, ${quoteString(comparisonOperator)})`] = returnValue;
                return returnValue;
            },
            first: (list = [], fallbackValue = null) => {
                let returnValue = fallbackValue ?? options.defaultValue;
                if (list.length > 0) {
                    returnValue = castToPrimitive(list[0]);
                }
                return returnValue;
            },
            fallback(value, fallback) {
                return value ?? fallback;
            },
            consoleLog: (dataLog) => {
                console.log(dataLog);
                return dataLog;
            },
            consoleTable: (dataLog) => {
                console.table(dataLog);
                return dataLog;
            },
            ref: (valueRef, fallbackValue = null) => {
                let returnValue = fallbackValue ?? options.defaultValue;
                let realValue = undefined;
                if (valueRef) {
                    realValue = foundry.utils.getProperty(props, valueRef);
                    returnValue = castToPrimitive(realValue) ?? returnValue;
                }
                if (returnValue === undefined ||
                    (realValue === undefined && options.availableKeys.includes(valueRef))) {
                    throw new UncomputableError(`Uncomputable token ref(${quoteString(valueRef)})`, options.source, options.formula, props);
                }
                options.computedTokens[`ref(${quoteString(valueRef)}, ${quoteString(fallbackValue)})`] = returnValue;
                return returnValue;
            },
            replace: (text, pattern, replacement) => {
                return text.toString().replace(pattern, replacement);
            },
            replaceAll: (text, pattern, replacement) => {
                return text.toString().replaceAll(pattern, replacement);
            },
            concat: (...values) => {
                return ''.concat(...values.map(String));
            },
            recalculate: (userInputData) => {
                if (userInputData === undefined) {
                    throw new UncomputableError('Uncomputable token recalculate()', options.source, options.formula, props);
                }
                try {
                    const value = ComputablePhrase.computeMessageStatic(userInputData.toString(), props, options).result;
                    return castToPrimitive(value);
                }
                catch (_err) {
                    throw new UncomputableError('Uncomputable token recalculate()', options.source, options.formula, props);
                }
            },
            fetchFromParent: (formula, opt) => {
                if (options.triggerEntity?.entity instanceof CustomItem) {
                    const parentEntity = opt?.top
                        ? options?.triggerEntity?.entity?.parent
                        : options?.triggerEntity?.entity?.getParent();
                    if (!parentEntity) {
                        return opt?.fallback ?? options.defaultValue;
                    }
                    const returnValue = castToPrimitive(new Formula(formula).computeStatic(parentEntity.system.props, {
                        ...options,
                        defaultValue: opt?.fallback ?? options.defaultValue
                    }).result);
                    mathInstance.import(this.importCustomFunctions(mathInstance, props, options), {
                        override: true
                    });
                    return returnValue;
                }
                else {
                    throw new UncomputableError('fetchFromParent() is only usable in Items', options.source, options.formula, props);
                }
            },
            fetchFromActor: (actorName, formula, fallbackValue = null) => {
                let actor;
                switch (actorName) {
                    case 'selected':
                        actor = canvas?.tokens?.controlled[0]?.actor ?? game.user.character;
                        break;
                    case 'target':
                        actor = game.user.targets.values().next().value?.actor;
                        break;
                    case 'attached':
                        Logger.warn("fetchFromActor('attached', ...) is deprecated in favor of fetchFromParent(). It will be removed with V14", options.source, options.formula, props);
                        actor = options?.triggerEntity?.entity.parent;
                        break;
                    default:
                        actor = game.actors.filter((e) => e.name === actorName)[0];
                }
                // If actor was found
                if (actor) {
                    const actorProps = actor.system.props;
                    const returnValue = castToPrimitive(new Formula(formula).computeStatic(actorProps, {
                        ...options,
                        defaultValue: fallbackValue ?? options.defaultValue
                    }).result);
                    mathInstance.import(this.importCustomFunctions(mathInstance, props, options), {
                        override: true
                    });
                    return returnValue;
                }
                return fallbackValue ?? options.defaultValue;
            },
            fetchFromUuid: (uuid, formula, fallback = null) => {
                const entity = fromUuidSync(uuid);
                if (!(entity instanceof CustomActor || entity instanceof CustomItem)) {
                    return fallback ?? options.defaultValue;
                }
                if (!entity) {
                    return fallback ?? options.defaultValue;
                }
                const returnValue = castToPrimitive(new Formula(formula).computeStatic(entity.system.props, {
                    ...options,
                    defaultValue: fallback ?? options.defaultValue
                }).result);
                mathInstance.import(this.importCustomFunctions(mathInstance, props, options), {
                    override: true
                });
                return returnValue;
            },
            switchCase: (expression, ...args) => {
                while (args.length > 1 && args.shift() !== expression) {
                    args.shift();
                }
                return args.shift() ?? null;
            },
            setPropertyInEntity: (entityName, propertyName, formula, fallbackValue = null) => {
                let entity;
                switch (entityName) {
                    case 'self':
                        if (!options.triggerEntity) {
                            throw new UncomputableError(`Missing entity. Make sure, that you provide the triggering Entity in the Options of Formula or ComputablePhrase`, options.source, options.formula, props);
                        }
                        entity = options.triggerEntity.entity;
                        break;
                    case 'selected':
                        entity = (canvas?.tokens?.controlled[0]?.actor ?? game.user.character);
                        break;
                    case 'target':
                        entity = game.user.targets.values().next().value?.actor;
                        break;
                    case 'attached':
                        entity = options?.triggerEntity?.entity.parent;
                        break;
                    case 'item':
                        if (!options.linkedEntity) {
                            throw new UncomputableError(`Missing entity. Make sure, that you provide the linked Entity in the Options of Formula or ComputablePhrase`, options.source, formula, props);
                        }
                        entity = options.linkedEntity;
                        break;
                    default:
                        entity = game.actors.filter((e) => e.name === entityName)[0];
                }
                if (!entity) {
                    throw new UncomputableError(`Entity "${entityName}" not found`, options.source, options.formula, props);
                }
                const actorProps = entity.system.props;
                const value = castToPrimitive(new Formula(formula).computeStatic({ ...props, target: actorProps }, {
                    ...options,
                    defaultValue: fallbackValue ?? options.defaultValue
                }).result);
                const uuid = entity.uuid.replaceAll('.', '-');
                const keys = typeof propertyName === 'string' ? [propertyName] : propertyName;
                const diff = { system: { props: {} } };
                keys.forEach((key) => (diff.system.props[key] = value));
                if (Object.keys(options.updates).some((key) => key === uuid)) {
                    foundry.utils.mergeObject(options.updates, { [uuid]: diff });
                }
                else {
                    options.updates[uuid] = diff;
                }
                mathInstance.import(this.importCustomFunctions(mathInstance, props, options), {
                    override: true
                });
                return value;
            },
            setValues: (uuid, ...updateArgs) => {
                if (updateArgs.length % 2 != 0) {
                    throw new UncomputableError(`The amount of update arguments must be a multiple of 2, but you have only ${updateArgs.length}`, options.source, options.formula, props);
                }
                const uuids = typeof uuid === 'string' ? [uuid] : uuid;
                return uuids
                    .map((uuid) => {
                    const entity = fromUuidSync(uuid);
                    if (!(entity instanceof CustomActor || entity instanceof CustomItem)) {
                        Logger.error(`"${uuid}" couldn't be resolved to an Actor or Item`);
                        return `${uuid} => ERROR`;
                    }
                    const diff = { system: { props: {} } };
                    for (let i = 0; i < updateArgs.length / 2; i++) {
                        const key = updateArgs[i * 2];
                        const formula = updateArgs[i * 2 + 1];
                        diff.system.props[key] = castToPrimitive(new Formula(formula).computeStatic({ ...props, target: entity.system.props }, options)
                            .result);
                    }
                    const formattedUuid = uuid.replaceAll('.', '-');
                    if (Object.keys(options.updates).some((key) => key === uuid)) {
                        foundry.utils.mergeObject(options.updates, { [formattedUuid]: diff });
                    }
                    else {
                        options.updates[formattedUuid] = diff;
                    }
                    return `${entity.name} => ${JSON.stringify(diff.system.props)}`;
                })
                    .join(', ');
            },
            notify: (messageType, message) => {
                const validTypes = ['info', 'warn', 'error'];
                if (!validTypes.includes(messageType)) {
                    throw new UncomputableError(`Message-Type "${messageType}" is not valid`, options.source, options.formula, props);
                }
                ui.notifications[messageType](message);
                return message;
            },
            escapeQuotes: (value) => {
                return value.replaceAll("'", "\\'");
            },
            array: (...values) => {
                return values;
            }
        };
        return customFunctions;
    }
}
