"use strict";
// Build the Deva test page from the repo (moves/deva/page.js), for the tests in this folder.
//   node test/assemble-deva.js [out.html]
const path = require("path");
const r = require("../moves/deva/page.js").build({ out: process.argv[2] || path.join(__dirname, "..", "out", "deva", "deva-anim.html") });
console.log("ok", r.out, "+", r.files.length, "asset files");
