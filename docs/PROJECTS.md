# Projects and activity

## Project identity and availability

The registry identifies a Beads workspace from the real Git common directory
and the canonical location returned by read-only `bd where`. Git worktrees
that resolve to the same Beads database share one Observer entry. Separate
Git repositories or distinct Beads locations remain separate entries. A
directory without an active Beads workspace is not listed.

A missing current working directory or a missing Beads location removes that
registration automatically. Other command failures are treated as temporary:
the daemon retains an already-known project while its registration lease is
still valid and does not infer that its database was deleted.

## Display names and list visibility

Open **Manage projects** beside the project picker to set an optional display
alias or hide a project from the picker. Hidden projects remain available in
the management list, where **Restore to list** makes them visible again. These
preferences never rename a Git/OpenCode project and never remove a directory,
`.beads` data, or issues.

Preferences are stored separately from Beads in the per-hub private
`project-preferences.json` file. They are keyed by the canonical project ID,
not by a saved filesystem path, and survive Observer daemon restarts. A hidden
project stays hidden when an OpenCode lease refreshes.

The read-only endpoint `GET /api/projects/preferences` includes hidden entries.
The preference write endpoint is
`POST /api/projects/:id/preferences`, protected by the Observer origin and
CSRF checks. Its JSON body accepts only an `alias` (up to 80 Unicode code
points, or `null` to clear it) and/or a boolean `hidden` value.

## Session activity

OpenCode 2.2.5's `session.active` response is an exact map of running session
IDs to `{ "type": "running" }`; sessions absent from that response are not
marked active based on Beads `in_progress`, model names, or parent sessions.
When an activity read fails, the last confirmed running state is retained for
at most 15 seconds, then becomes unknown until the API confirms it again.

A session whose reported worktree directory no longer exists is kept only as
an offline historical snapshot when one was already recorded. This local
`realpath` ENOENT does not become a repeated global warning. Other session
read errors remain attached to that session; project-wide activity or catalog
errors remain project-level warnings.

Exact `metadata.sessionID` matches in the current project's Beads issue
metadata can link a session to an issue. Ambiguous matches stay unassigned,
and a child session does not inherit a task from its parent without its own
evidence.

## Local browser checks

The browser checks are opt-in and are not part of CI:

- `test/project-refresh-scroll.ts` starts a separate port-0 server with only
  in-memory demo data. Its browser context blocks every non-GET/HEAD request
  and exercises the real SSE-to-render path for menu and page scrolling.
- `test/browser-readonly.ts` defaults to `http://127.0.0.1:4317` (override with
  `OBSERVER_URL`), opens a fresh browser context without a user profile, blocks
  and fails any write request to that Observer origin, and only navigates,
  scrolls, switches views, and replays captured read-only SSE payloads.

Build before running either script. The live probe must never click create,
reset, rename, hide, or restore controls; preference-write behavior is tested
with isolated temporary directories and HTTP fixtures instead.

Example:

```sh
npm run build
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium node dist/test/project-refresh-scroll.js
OBSERVER_URL=http://127.0.0.1:4317 PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium node dist/test/browser-readonly.js
```
