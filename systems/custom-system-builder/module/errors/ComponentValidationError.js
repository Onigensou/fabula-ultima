/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
export class ComponentValidationError extends Error {
    propertyName;
    sourceObject;
    constructor(message, propertyName, sourceObject) {
        super(message);
        this.propertyName = propertyName;
        this.sourceObject = sourceObject;
        this.name = this.constructor.name;
    }
}
export class RequiredFieldError extends ComponentValidationError {
    propertyName;
    sourceObject;
    constructor(propertyName, sourceObject) {
        super(game.i18n.format('CSB.ComponentProperties.Errors.RequiredFieldError', { PROPERTY_NAME: propertyName }), propertyName, sourceObject);
        this.propertyName = propertyName;
        this.sourceObject = sourceObject;
    }
}
export class AlphanumericPatternError extends ComponentValidationError {
    propertyName;
    sourceObject;
    constructor(propertyName, sourceObject) {
        super(game.i18n.format('CSB.ComponentProperties.Errors.AlphanumericPatternError', {
            PROPERTY_NAME: propertyName
        }), propertyName, sourceObject);
        this.propertyName = propertyName;
        this.sourceObject = sourceObject;
    }
}
export class NotUniqueError extends ComponentValidationError {
    propertyName;
    sourceObject;
    constructor(propertyName, sourceObject) {
        super(game.i18n.format('CSB.ComponentProperties.Errors.NotUniqueError', { PROPERTY_NAME: propertyName }), propertyName, sourceObject);
        this.propertyName = propertyName;
        this.sourceObject = sourceObject;
    }
}
export class NotGreaterThanZeroError extends ComponentValidationError {
    propertyName;
    sourceObject;
    constructor(propertyName, sourceObject) {
        super(game.i18n.format('CSB.ComponentProperties.Errors.NotGreaterThanZeroError', { PROPERTY_NAME: propertyName }), propertyName, sourceObject);
        this.propertyName = propertyName;
        this.sourceObject = sourceObject;
    }
}
