"use strict";

/**
 * preflight/registry — the ordered list of check suites the runner executes.
 * Add a suite by dropping a module in ./checks and listing it here. Each module
 * exports { id, title, run(world) -> findings[] }.
 */

const CHECKS = [
  require("./checks/refs"),
  require("./checks/scenes"),
  require("./checks/tiles"),
  require("./checks/tables"),
  require("./checks/automation"),
];

module.exports = { CHECKS };
