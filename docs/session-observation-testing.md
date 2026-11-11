# Session observation regression coverage

Run `npm run test:observation-coverage` (Node.js 22+). It is also required by
`npm test`, so `npm run check` and the existing Node 22/24 CI jobs run the gate.
No live OpenCode instance, browser, Beads database or network API is exercised.

The command compiles isolated tests with TypeScript source maps and inline source
content into ignored `coverage/build/`, then collects Node's native line and
branch counters. It fails unless **100% of executable changed lines and 100% of
branch counters on changed runtime lines** are covered in:

- `src/adapters/opencode-sessions.ts`
- `src/adapters/opencode-api.ts`

The comparison uses fixed pre-fix commit
`a27eef5cabc073ae71fd7a2e0bec07325bfb1818`, not the current merge base: otherwise
the coverage scope would disappear after merging the fix into `main`. A shallow
checkout fetches this exact commit if needed. There are no coverage-ignore
directives, percentage rounding or excluded runtime branches. Type-only lines,
comments and unmapped lines are not executable; their inclusion in a source diff
does not create executable counters. The older adapter code outside the diff is
reported by Node as context but is not claimed to have 100% coverage.

Generated reports (all ignored by Git):

- `coverage/observation-coverage.md`: concise scoped report, exact HEAD SHA and
  whether runtime/test/tooling files were dirty.
- `coverage/observation-coverage.json`: fixed baseline, Node version, source
  SHA-256 hashes, all changed source line numbers, selected counters and totals.
- `coverage/observation-node-coverage.json`: unfiltered source-mapped Node
  counters for the two runtime adapters, including old code outside the fix.
- `coverage/build/**/*.js.map`: mapping from executed JavaScript to the exact
  TypeScript source included in each map.

Run the gate again **after committing** for a report pinned to the clean PR
head. Test fixtures cover seven-session token storms, deduplication, bounded
live logs, tool/native-shell changes, read-only and incomplete tool records,
scope changes, persistent and transient errors, new user turns, final snapshots,
discovery and HTTP fallback. They never create sessions or inbox messages in a
running host.
