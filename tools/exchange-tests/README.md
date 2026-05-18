# Reaction Exchange — test scenarios

Test harness for the GM-authoritative state machine in
[`scripts/reaction-system/reaction-exchange.js`](../../modules/fabula-ultima-companion/scripts/reaction-system/reaction-exchange.js).
Scenarios exercise mutations, validation, and lifecycle transitions
through the test-bridge — no UI required.

## Prerequisites

1. Foundry running with the `fabula-ultima-2` world loaded.
2. The test-bridge is active (auto-arms on world load via the watcher).

## Run

```sh
# all scenarios
node tools/exchange-tests/run-scenarios.js

# one by name substring
node tools/exchange-tests/run-scenarios.js once-per-chain

# verbose: include per-step log for failures
EXCHANGE_TEST_VERBOSE=1 node tools/exchange-tests/run-scenarios.js
```

Exits non-zero on any failure. Prints a summary at the end.

## Adding a scenario

Drop a JSON file in [`scenarios/`](./scenarios/) following the shape:

```jsonc
{
  "name": "06-my-scenario",
  "description": "What this proves.",
  "scenario": {
    "reset": true,
    "open": {
      "kind": "action_card",
      "boundaryKey": "card-...",
      "payload": { /* ... */ },
      "initialTriggers": [ { "key": "creature_takes_damage" } ],
      "eligibleUserIds": ["user-a", "GM"]
    },
    "script": [
      { "op": "addEntry", "actor": "user-a", "params": {
          "skillUuid": "Item.X", "skillName": "X"
      } },
      { "op": "expect", "path": "queue.length", "value": 1 },
      { "op": "setReady", "actor": "user-a", "isReady": true },
      { "op": "setReady", "actor": "GM", "isReady": true },
      { "op": "expect", "path": "status", "value": "resolving" }
    ],
    "expectations": {
      "finalStatus": "resolving",
      "queueSize": 1
    }
  }
}
```

See [`reaction-exchange-test-helpers.js`](../../modules/fabula-ultima-companion/scripts/reaction-system/reaction-exchange-test-helpers.js)
for the full operation reference.

### Available `op` values in `script`

| op | required fields | notes |
|---|---|---|
| `addEntry` | `actor`, `params.skillUuid` | `params.userId` defaults to `actor` |
| `removeEntry` | `actor`, `entryRef`, plus `entryId`/`entryIndex`/`entryUserId` | by-id / by-index / by-user selector |
| `reorderEntry` | `actor`, `entryRef`, `newIndex`, selector | clamped to queue bounds |
| `setReady` | `actor`, `isReady` | players can only set their own; GM can override |
| `forceResolve` | `actor` | non-GM must have every OTHER eligible user Ready |
| `markResolved` | `usedSkillUuids?`, `resolutionLog?` | status must be `resolving` |
| `close` | `reason?` | from any status |
| `abort` | `reason?` | cleanup path for cancelled action cards |
| `snapshot` | `label?` | captures current state into log |
| `expect` | `path`, `value` | strict-equals on JSON-stringified value at path |
| `expectThrows` | `inner` (another op) | passes only if the wrapped op throws |

## How it works

The driver writes a `req-<id>.json` into the bridge inbox; the in-Foundry
bridge dispatch (case `runExchangeScenario` in [`_test-bridge.js`](../../modules/fabula-ultima-companion/scripts/_test-bridge.js))
invokes `FUCompanion.api.reactionExchangeTest.runScenario(scenario)`,
which drives the state machine in process. Result is written back to
`res-<id>.json`, the driver polls it and unlinks both files (bridge
contract).
