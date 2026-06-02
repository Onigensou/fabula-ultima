// Scoped console logger for the Battle Director.
// All director-side log lines start with `[BD]` so they're filterable.

const TAG = "[BD]";

export function log(...args) { console.log(TAG, ...args); }
export function warn(...args) { console.warn(TAG, ...args); }
export function err(...args) { console.error(TAG, ...args); }
export function debug(...args) { console.debug(TAG, ...args); }
