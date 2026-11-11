# Beads Observer — agent instructions

Local Beads dashboard and OpenCode 2 plugin. Requires Node.js 22+ and the
Beads CLI (`bd`) for real projects. Runtime code has no npm dependencies.

## Structure

- `index.js`: OpenCode plugin entry point.
- `src/domain/`, `src/application/`, `src/ports/`: domain and use cases.
- `src/adapters/`, `src/bootstrap/`: CLI, HTTP, OpenCode and shared server.
- `web/`: browser UI and translations; no bundler or external CDN.
- `test/`: Node.js tests; live-host scripts are manual checks.

## Verification

```sh
npm ci
npm run check
```

`build` validates the JavaScript and required runtime assets; sources run
directly without transpilation. Do not claim live OpenCode or browser
integration was tested unless it actually was.

`npm ci` installs Husky hooks. Pre-commit runs ESLint fixes and Prettier on
staged files via lint-staged; pre-push checks lint and formatting without edits.

## Working rules

- Keep domain logic independent of CLI, HTTP and OpenCode adapters.
- Preserve localhost binding, request validation and project isolation.
- Never commit local Beads data, session logs, credentials or IDE settings.
- Use `bd` for task tracking when a local Beads workspace is available;
  run `bd prime` for its workflow. The database is local and ignored by Git.
- Releases use semantic version tags and the GitHub release workflow.
  Publish only with explicit authorization; never store npm tokens in files.
