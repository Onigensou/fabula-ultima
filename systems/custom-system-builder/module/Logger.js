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
export var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["NONE"] = 0] = "NONE";
    LogLevel[LogLevel["ERROR"] = 1] = "ERROR";
    LogLevel[LogLevel["WARN"] = 2] = "WARN";
    LogLevel[LogLevel["INFO"] = 3] = "INFO";
    LogLevel[LogLevel["LOG"] = 4] = "LOG";
    LogLevel[LogLevel["DEBUG"] = 5] = "DEBUG";
})(LogLevel || (LogLevel = {}));
export class Logger {
    logLevel;
    constructor(logLevel = LogLevel.LOG) {
        this.logLevel = logLevel;
    }
    static instance;
    static getInstance(logLevel = LogLevel.LOG) {
        if (!Logger.instance) {
            Logger.instance = new Logger(logLevel);
        }
        return Logger.instance;
    }
    _logToConsole(level, msg, ...args) {
        if (!console[level]) {
            console.warn(`Custom System Builder | Called Logger with unknown level ${level}`);
            level = 'log';
        }
        msg = 'Custom System Builder | ' + msg;
        console[level](msg, ...args);
    }
    error(msg, ...args) {
        if (this.logLevel >= LogLevel.ERROR) {
            this._logToConsole('error', msg, ...args);
        }
    }
    warn(msg, ...args) {
        if (this.logLevel >= LogLevel.WARN) {
            this._logToConsole('warn', msg, ...args);
        }
    }
    info(msg, ...args) {
        if (this.logLevel >= LogLevel.INFO) {
            this._logToConsole('info', msg, ...args);
        }
    }
    log(msg, ...args) {
        if (this.logLevel >= LogLevel.LOG) {
            this._logToConsole('log', msg, ...args);
        }
    }
    debug(msg, ...args) {
        if (this.logLevel >= LogLevel.DEBUG) {
            this._logToConsole('debug', msg, ...args);
        }
    }
    setLogLevel(newLevel) {
        if (typeof newLevel === 'number') {
            if (!Object.values(LogLevel).includes(newLevel)) {
                console.error(`Custom System Builder | Tried to set unknown level ${newLevel}`);
            }
            else {
                this.logLevel = newLevel;
            }
        }
        else {
            if (!(newLevel in LogLevel)) {
                console.error(`Custom System Builder | Tried to set unknown level ${newLevel}`);
            }
            else {
                this.logLevel = LogLevel[newLevel];
            }
        }
    }
}
export default Logger.getInstance();
