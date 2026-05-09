/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Component factory. Used to create components from JSON.
 * This is a singleton object exported globally
 */
export class ComponentFactory {
    /**
     * Record of the available component types
     */
    _componentTypes = {};
    /**
     * Returns currently registered component types
     * @returns All available component types
     */
    get componentTypes() {
        return Object.keys(this._componentTypes);
    }
    /**
     * Creates an array of components from an array of JSON-described components
     * @param json The JSON description of the components.
     * @param templateAddress The base address of the components. The array index is appended to the address if json is an array.
     * @param parent The component's parent
     * @returns An array of components or one component if json is not an Array
     */
    createMultipleComponents(json = [], templateAddress = '', parent) {
        const contents = [];
        for (const [index, component] of json.entries()) {
            contents.push(this.createOneComponent(component, templateAddress + '-' + index, parent));
        }
        return contents;
    }
    /**
     * Creates one component from a JSON description
     * @param json The JSON description of the component.
     * @param templateAddress The base address of the component. The array index is appended to the address if json is an array.
     * @param parent The component's parent
     * @returns The new Component
     * @private
     */
    createOneComponent(json, templateAddress = '', parent) {
        let component;
        if (this._componentTypes[json.type]) {
            component = this._componentTypes[json.type].fromJSON(json, templateAddress, parent);
        }
        else {
            throw new Error('Unrecognized component type ' + json.type);
        }
        return component;
    }
    addComponentType(arg0, arg1) {
        if (typeof arg0 === 'string') {
            this._componentTypes[arg0] = arg1;
        }
        else {
            this._componentTypes[arg0.getTechnicalName()] = arg0;
        }
    }
    /**
     * Returns a registered component's class
     * @param name The component class name
     * @return The component class
     * @throws {Error} If the name does not match a registered Component Class
     */
    getComponentClass(name) {
        if (this._componentTypes[name]) {
            return this._componentTypes[name];
        }
        else {
            throw new Error('Unrecognized component class name ' + name);
        }
    }
}
globalThis.componentFactory = new ComponentFactory();
