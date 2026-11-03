// The Active Effect registry as built at startup, plus the time a refresh takes.
// Diff two dumps (e.g. --code HEAD vs the working tree): entries must be identical.
const reg = FUCompanion.api.activeEffectRegistry;
const boot = reg.getLastReport();
const times = [];
for (let i = 0; i < 3; i++) { const t0 = performance.now(); await reg.refresh({ scanCompendiums: false }); times.push(Math.round(performance.now() - t0)); }
const last = reg.getLastReport();
const strip = (r) => { const c = structuredClone(r); delete c.refreshedAt; delete c.durationMs; return c; };
return { bootMs: boot?.durationMs, refreshMs: times, boot: strip(boot), last: strip(last), grouped: reg.getGrouped(), statusTab: reg.getStatusTabMetadata() };
