# Beads Observer

A local dashboard for [Beads](https://github.com/gastownhall/beads) and an
**OpenCode 2** plugin. Browse boards, lists, dependency graphs, epics, agent
activity and explicitly linked OpenCode sessions. The interface supports all
24 official EU languages, light/dark themes and system preferences.

Written in **TypeScript**, with a compiled Node.js CLI and browser UI. No
production npm dependencies, remote fonts or runtime CDN requests.

## Requirements

- **Node.js 22+** and npm.
- The Beads CLI (`bd`) and an initialized Beads project for real data.
- **OpenCode 2.2.5+** for plugin integration (tested with SDK 2.2.5). Standalone mode does not require OpenCode.

## Install the CLI

```sh
npm install --global @opentoria/beads-observer
cd /path/to/your/project
beads-observer open
```

The default address is **http://127.0.0.1:4317**. The `open` command opens your
browser and registers the current project. On Linux it uses `xdg-open`; on
macOS it uses `open`; on Windows and WSL it uses the native Windows URL handler.
If no graphical browser is available (for example, in a headless SSH session),
the command prints a URL to open manually. For SSH, use a secure port forward.

```sh
beads-observer --help
beads-observer --cwd /projects/backend --port 4318
beads-observer --project /projects/backend --project /projects/frontend
beads-observer --demo
```

Demo mode uses in-memory data and does not require Beads.

## OpenCode 2 plugin

Add the package to your existing `opencode.json` or `opencode.jsonc`, preserving
other plugins and settings:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@opentoria/beads-observer",
      "options": {
        "port": 4317,
        "pollIntervalMs": 2000,
        "bdPath": "bd"
      }
    }
  ]
}
```

OpenCode installs the package from npm; a global CLI installation is not needed
for plugin use. Configuration reloads automatically; `/reload` forces a reload.

- `/beads-observer` opens the current project's board.
- `/beads-observer ISSUE-ID` links the current session to that issue and opens its details.
- Multiple instances owned by the same user can share one local server.

This plugin uses the OpenCode 2 `@opencode/plugin` API, not the OpenCode 1 API.
Session views require compatible host APIs. Adapter tests are not a substitute
for an end-to-end test in a real OpenCode installation.

### Options

| Option             | Default                    | Purpose                                                       |
| ------------------ | -------------------------- | ------------------------------------------------------------- |
| `port`             | `4317`                     | Local HTTP port.                                              |
| `pollIntervalMs`   | `2000`                     | Beads polling interval; at least 500 ms.                      |
| `bdPath`           | `bd`                       | Beads executable name or absolute path.                       |
| `cwd`              | OpenCode project directory | Beads project directory.                                      |
| `project`          | Directory name             | Project display name.                                         |
| `projects`         | `[]`                       | Additional paths or `{ "cwd": "…", "project": "…" }` entries. |
| `timeoutMs`        | `15000`                    | Beads command timeout.                                        |
| `nodePath`         | `node`                     | Node.js 22+ executable for the shared server.                 |
| `runtimeDirectory` | System temporary directory | Parent directory for private runtime registrations.           |
| `demo`             | `false`                    | Use demonstration data instead of a Beads database.           |

## Features and limitations

- Boards and lists with filters, priorities, assignees and epic hierarchy.
- Dependency graphs that distinguish blockers from parent–child relationships.
- Issue/epic creation, title/description/priority editing and dependency creation.
- Details, comments and retained Beads audit events.
- Agent profiles and logs/diffs from explicitly linked OpenCode sessions.
- Isolated project data/preferences and server-sent updates.

Beads remains authoritative for readiness and blockers. Agents/Beads manage
issue status and assignment. History includes retained events, not a guaranteed
complete audit trail. There are no sprints, SLAs, remote authentication or team
permission controls.

## Security and privacy

The server binds to **127.0.0.1 only**. Do not expose it publicly. Writes require
matching Origin, a session token and validated JSON. CLI commands use argument
arrays, not a shell. Session logs and diffs can contain sensitive information;
they stay in a private local runtime directory and are not uploaded to npm or
GitHub. Database reset is destructive, requires separate confirmation, and
should only be used after stopping active agents.

Local `.beads` databases, credentials, editor settings, archives and Windows
download metadata are ignored by Git. The npm package includes only compiled
runtime files, declarations, static assets, the license, README and example config.

## Development

Use Node.js **24.10+** (recommended) or **22.22.1+** for the development tooling.
The compiled CLI and plugin support Node.js 22+.

```sh
git clone https://github.com/kosmateus/beads-observer.git
cd beads-observer
npm ci
npm run check
```

| Command                | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `npm run lint`         | ESLint with TypeScript rules; warnings fail the check. |
| `npm run lint:fix`     | Apply safe ESLint fixes.                               |
| `npm run format`       | Format with Prettier.                                  |
| `npm run format:check` | Check formatting without editing files.                |
| `npm run typecheck`    | Strict TypeScript checking without emitting files.     |
| `npm run build`        | Compile TypeScript and stage static assets in `dist/`. |
| `npm test`             | Build and run automated Node.js tests.                 |
| `npm run pack:check`   | Verify the npm package file allowlist after building.  |
| `npm run demo`         | Build and start the demonstration dashboard.           |

Source code lives in `index.ts`, `src/`, `web/`, `test/` and `scripts/`.
JavaScript under `dist/` is generated and is not committed. Tests are compiled
to `dist/test/`; manual live-host/browser checks are not run by default CI.

### Formatting and Git hooks

Prettier uses two spaces, 80-column wrapping, semicolons, single quotes, trailing
commas, parenthesized arrow arguments and LF line endings. ESLint combines the
recommended JavaScript/TypeScript rules with checks for unused variables,
strict equality, accidental `var` declarations and unsafe eval.

`npm ci` installs Husky hooks:

- **Pre-commit:** lint-staged runs ESLint fixes and Prettier on staged files only.
  Errors that cannot be fixed automatically block the commit.
- **Pre-push:** ESLint, Prettier and TypeScript check the project without edits.

GitHub CI repeats these checks; local hooks are not a branch security boundary.

## Releases

The `main` branch requires a squash PR and a successful **CI gate**. CI checks
lint, formatting, types, build, tests and package contents on Node.js 22 and 24.
Merged PRs trigger semantic-release; Conventional Commits determine the version,
with at least a patch release for new commits. Maintainers can also run the
`Release` workflow manually. Release tags and GitHub assets are created without
pushing a version commit directly to protected `main`.

Publishing uses **npm Trusted Publishing (OIDC)**, not a stored npm token. After
the initial authenticated publication, configure the package's trusted publisher
for GitHub repository `kosmateus/beads-observer`, workflow `release.yml`, with
no environment requirement, and enable **Allow npm publish**. The first publication requires npm access to the
`opentoria` organization and may require interactive 2FA.

Maintainers can configure that trust relationship after the package exists
using npm CLI **11.21+**:

```sh
npm trust github @opentoria/beads-observer --repo kosmateus/beads-observer --file release.yml --allow-publish --allow-stage-publish --yes
```

This command may require a separate 2FA confirmation. Never commit an npm token
or disable account 2FA to make a release work.

## License

[MIT](LICENSE).
