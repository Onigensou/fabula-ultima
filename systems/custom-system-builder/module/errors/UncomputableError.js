/*
 * Author: Jean-Baptiste Louvet-Daniel
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Error thrown when a Formula can not be computed
 */
export class UncomputableError extends Error {
    source;
    formula;
    props;
    /**
     * UncomputableError constructor
     * @param message Error message
     * @param source The source, for which the computation failed
     * @param formula The full formula
     * @param props The props at computation time
     */
    constructor(message, source, formula, props) {
        super(message);
        this.source = source;
        this.formula = formula;
        this.props = props;
    }
}
