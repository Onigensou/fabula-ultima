// foundry-app — where this machine's Foundry install keeps its client files (resources/app).
// The runner serves them, so it needs the path; it differs per machine, so it is not in the
// shared runner.config.json. First found wins:
//   1. FVTT_APP (env)
//   2. tools/fvtt-playwright/config.local.json: foundryMain's folder, else <foundryExe dir>/resources/app
//      (the file every harness client already needs; see config.local.example.json)
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PW_CONFIG = resolve(HERE, "../../fvtt-playwright/config.local.json");

export function foundryApp() {
  const tried = [];
  if (process.env.FVTT_APP) { tried.push(`FVTT_APP=${process.env.FVTT_APP}`); if (existsSync(join(process.env.FVTT_APP, "public"))) return process.env.FVTT_APP; }
  if (existsSync(PW_CONFIG)) {
    const c = JSON.parse(readFileSync(PW_CONFIG, "utf8"));
    for (const p of [c.foundryMain ? dirname(c.foundryMain) : null, c.foundryExe ? join(dirname(c.foundryExe), "resources", "app") : null]) {
      if (!p) continue;
      tried.push(p);
      if (existsSync(join(p, "public"))) return p;
    }
  } else tried.push(`${PW_CONFIG} (missing)`);
  throw new Error(`cannot find Foundry's resources/app (tried: ${tried.join("; ")}). Set foundryExe in tools/fvtt-playwright/config.local.json, or FVTT_APP.`);
}
