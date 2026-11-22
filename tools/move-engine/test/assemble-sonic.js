"use strict";
// Build the Sonic Katar test page from the repo (moves/sonic-katar/page.js), for the tests in this folder.
//   node test/assemble-sonic.js [out.html]
const path = require("path");
const out = require("../moves/sonic-katar/page.js").build({ out: process.argv[2] || path.join(__dirname, "..", "out", "sonic-katar-move-engine.html") });
console.log("ok", out);
