// ═════════ move-engine · GAME overrides (after the shared parts, before family parts / moves)
// The few shared helpers that are DOM-bound in the mockup get their game versions here. They are function declarations
// in the shared files, so they are re-assigned (a declaration here would be hoisted over the shared one by position).
afterimage = meAfterimage;                         // shared/common.js: a DOM sprite copy
chroma = meChroma;                                 // shared/fx-melee.js: the #lhCA filter on the page's #shake layer
camGo = () => {};                                  // shared/fx-melee.js: the mockup's follow camera (live board: camera untouched)
camHome = (ms) => wait(ms || 0);
startDance = meUnsupported("startDance"); stopDance = () => {};
wingsOn = (...a) => { meUnsupported("wingsOn")(); return WINGS; };
