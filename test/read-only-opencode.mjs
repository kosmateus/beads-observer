// Explicit opt-in integration check against a running managed OpenCode service.
// All OpenCode/FMCAD access is GET-only; records and hub live in a fresh temp dir.
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { observeOpenCodeSessions } from '../src/adapters/opencode-sessions.js';
import { openCodeAPI } from '../src/adapters/opencode-api.js';
import { BeadsSource } from '../src/adapters/beads-cli.js';
import { startServer, projectID } from '../src/bootstrap/server.js';
import { readSessionRecords } from '../src/adapters/session-records.js';

const cwd = resolve(process.argv[2] || '.');
const service = JSON.parse(
  await readFile(
    join(
      process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
      'opencode',
      'service.json',
    ),
    'utf8',
  ),
);
const headers = {
  authorization:
    'Basic ' + Buffer.from('opencode:' + service.password).toString('base64'),
};
async function get(path) {
  const response = await fetch(new URL(path, service.url), {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error('HTTP ' + response.status);
  return response.json();
}
const info = await get('/api/info');
assert.equal(info.pid, service.pid);
const location = await (
  await fetch(new URL('/api/location', service.url), {
    headers: { ...headers, 'x-opencode-directory': cwd },
  })
).json();
const store = new Map(),
  directory = await mkdtemp(join(tmpdir(), 'observer-read-only-'));
const ctx = {
  location,
  storage: {
    get: async (key) => store.get(key),
    set: async (key, value) => store.set(key, value),
  },
  session: {
    list: (input) => get('/api/session?' + new URLSearchParams(input)),
    get: ({ sessionID }) => get(`/api/session/${sessionID}`),
    context: ({ sessionID }) => get(`/api/session/${sessionID}/context`),
  },
  event: {
    async *subscribe({ signal }) {
      await new Promise((resolve) =>
        signal.addEventListener('abort', resolve, { once: true }),
      );
    },
  },
};
const source = new BeadsSource({ cwd }),
  id = projectID(cwd);
let observer, server;
try {
  observer = await observeOpenCodeSessions(ctx, {
    directory,
    projectId: id,
    cwd,
    listIssues: () => source.issueCatalog(),
    beadsLocation: () => source.location(),
    api: openCodeAPI({ pid: info.pid }),
  });
  await observer.refresh();
  // Discovery is deliberately batched; allow the first page's historical queue
  // to drain so the check covers finished as well as currently active children.
  for (let batch = 0; batch < 4; batch++) await observer.refresh();
  server = await startServer({
    port: 0,
    sessionDirectory: directory,
    projects: [{ cwd }],
  });
  await server.observer.refresh();
  const summary = await (
    await fetch(`${server.url}/api/projects/${id}/sessions?summary=1`)
  ).json();
  assert.equal(summary.available, true);
  const issue = process.argv[3];
  const records = await readSessionRecords(directory, id);
  assert.ok(
    records.some(
      (s) => s.status === 'running' && s.blocks.some((b) => b.kind === 'tool'),
    ),
    'Missing live tool context',
  );
  console.log(
    JSON.stringify({
      version: info.version,
      available: summary.available,
      activeTasks: Object.keys(summary.activity).length,
      sessions: Object.values(summary.activity).flat().length,
      linkedSessions: records.length,
      toolBlocks: records
        .flatMap((s) => s.blocks)
        .filter((b) => b.kind === 'tool').length,
      diffFiles: records.flatMap((s) => s.diffs).length,
    }),
  );
  if (issue) {
    const details = await (
      await fetch(
        `${server.url}/api/projects/${id}/sessions?issue=${encodeURIComponent(issue)}`,
      )
    ).json();
    assert.ok(details.sessions.length, 'No sessions linked to requested issue');
    assert.ok(
      details.sessions.some((s) => s.blocks?.length),
      'Missing actual context',
    );
    console.log(
      JSON.stringify({
        issue,
        linked: details.sessions.length,
        blocks: details.sessions.reduce((n, s) => n + s.blocks.length, 0),
        diffs: details.sessions.reduce((n, s) => n + s.diffs.length, 0),
      }),
    );
  }
} finally {
  await observer?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
