# Session observation regression coverage

Run `npm run test:observation-coverage` (Node.js 22+). It is also required by
`npm test`, so `npm run check` and the existing Node 22/24 CI jobs run the gate.
No live OpenCode instance, browser, Beads database or network API is exercised.

The command compiles isolated tests with TypeScript source maps and inline source
content into ignored `coverage/build/`, then collects Node's native line and
branch counters. It fails unless **100% of lines and 100% of branches in each
entire modified runtime file**, including its pre-existing code, are covered in:

- `src/adapters/opencode-sessions.ts`
- `src/adapters/opencode-api.ts`

The file list is explicit and stable after merge; this is not a whole-repository
coverage requirement. There are no coverage-ignore directives, percentage
rounding or excluded runtime branches. Native Node source-map counters determine
which TypeScript source lines correspond to executed JavaScript; type-only and
unmapped lines do not create executable counters. Coverage uses only fixtures,
mocked filesystem/process boundaries and local fixture HTTP servers, not live
OpenCode or external services.

Generated reports (all ignored by Git):

- `coverage/observation-coverage.md`: concise scoped report, exact HEAD SHA and
  whether runtime/test/tooling files were dirty.
- `coverage/observation-coverage.json`: Node version, source SHA-256 hashes,
  full-file counters and exact totals.
- `coverage/observation-node-coverage.json`: unfiltered source-mapped Node
  counters for the two runtime adapters.
- `coverage/build/**/*.js.map`: mapping from executed JavaScript to the exact
  TypeScript source included in each map.

Run the gate again **after committing** for a report pinned to the clean PR
head. Test fixtures cover seven-session token storms, deduplication, bounded
live logs, tool/native-shell changes, read-only and incomplete tool records,
scope changes, persistent and transient errors, new user turns, final snapshots,
storage restoration, scope/cache bounds, subscription recovery and HTTP fallback.
Fake timers verify actual scheduled five-second cadence after semantic events;
a blocked in-flight context verifies that closing never starts queued RPCs.
Historical rotation covers 260 idle sessions plus an active session: permanent
range failures survive eviction from the 128-entry context cache, while a new
user turn or location still retries. The small failure marker lives with the
existing session record, not in another growing cache or a retry-TTL table.
They never create sessions or inbox messages in a running host. Module mocking
uses Node's `--experimental-test-module-mocks` test-only flag.
