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
import type {
  ObserverContext,
  SessionCatalog,
  ObserverSessionInfo,
  ResponseData,
} from '../src/adapters/opencode-types.js';
import type { SessionMessage } from '../src/types.js';
import { memoryStorage } from './fixtures.js';

interface RecordDetails {
  status: string;
  blocks: { kind: string }[];
  diffs: unknown[];
}
interface SessionDetails {
  sessions: { blocks: unknown[]; diffs: unknown[] }[];
}
function assertRecordDetails(
  records: unknown,
): asserts records is RecordDetails[] {
  assert.ok(Array.isArray(records));
  for (const record of records) {
    assert.equal(typeof record.status, 'string');
    assert.ok(Array.isArray(record.blocks));
    assert.ok(Array.isArray(record.diffs));
    for (const block of record.blocks)
      assert.equal(typeof block.kind, 'string');
  }
}

const cwd = resolve(process.argv[2] || '.');
const service: { password: string; url: string; pid: number } = JSON.parse(
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
async function get<T = unknown>(path: string): Promise<T> {
  const response = await fetch(new URL(path, service.url), {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error('HTTP ' + response.status);
  return response.json();
}
const info = await get<{ pid: number; version: string }>('/api/info');
assert.equal(info.pid, service.pid);
const location: ObserverContext['location'] = await (
  await fetch(new URL('/api/location', service.url), {
    headers: { ...headers, 'x-opencode-directory': cwd },
  })
).json();
const directory = await mkdtemp(join(tmpdir(), 'observer-read-only-'));
const ctx: ObserverContext = {
  location,
  storage: memoryStorage(),
  session: {
    list: (input) =>
      get<SessionCatalog>(
        '/api/session?' +
          new URLSearchParams(
            Object.fromEntries(
              Object.entries(input)
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => [key, String(value)]),
            ),
          ),
      ),
    get: ({ sessionID }: { sessionID: string }) =>
      get<ResponseData<ObserverSessionInfo>>(`/api/session/${sessionID}`),
    context: ({ sessionID }: { sessionID: string }) =>
      get<ResponseData<SessionMessage[]>>(`/api/session/${sessionID}/context`),
  },
  event: {
    async *subscribe({ signal }) {
      assert.ok(signal);
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
  const summary: { available: boolean; activity: Record<string, unknown[]> } =
    await (
      await fetch(`${server.url}/api/projects/${id}/sessions?summary=1`)
    ).json();
  assert.equal(summary.available, true);
  const issue = process.argv[3];
  const records: unknown = await readSessionRecords(directory, id);
  assertRecordDetails(records);
  assert.ok(
    records.some(
      (s) =>
        s.status === 'running' &&
        s.blocks.some((b: { kind: string }) => b.kind === 'tool'),
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
    const details: SessionDetails = await (
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
