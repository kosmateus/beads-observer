import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeOpenCodeSessions } from '../src/adapters/opencode-sessions.js';
import { readSessionRecords } from '../src/adapters/session-records.js';
import type { ObserverContext } from '../src/adapters/opencode-types.js';
import { memoryStorage } from './fixtures.js';

test('V2 envelopes without active/diff context methods; independent child, change, unknown and cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'observer-session-test-'));
  let active: Record<string, { type: string }> = { child: { type: 'running' } };
  let task = 'test-a',
    fail = false;
  const infos: Record<
    string,
    {
      id: string;
      parentID?: string;
      agent?: string;
      location: { directory: string };
      time: { updated: number };
      outcome?: string;
    }
  > = {
    parent: { id: 'parent', location: { directory }, time: { updated: 1 } },
    child: {
      id: 'child',
      parentID: 'parent',
      agent: 'build',
      location: { directory },
      time: { updated: 1 },
    },
  };
  const ctx: ObserverContext = {
    storage: memoryStorage(),
    session: {
      list: async () => ({ data: Object.values(infos), cursor: {} }),
      get: async ({ sessionID }: { sessionID: string }) => ({
        data: infos[sessionID],
      }),
      context: async ({ sessionID }: { sessionID: string }) => ({
        data: [
          {
            id: 'm',
            type: 'user',
            text: sessionID === 'child' ? `Work on ${task}` : 'No task',
          },
        ],
      }),
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
  const api = {
    active: async () => {
      if (fail) throw Error('offline');
      return { data: active };
    },
    diff: async () => ({
      data: [{ file: 'a.js', patch: '+test', additions: 1, deletions: 0 }],
    }),
  };
  const observer = await observeOpenCodeSessions(ctx, {
    directory,
    projectId: 'project',
    cwd: directory,
    listIssues: async () => ['test-a', 'test-b'],
    api,
  });
  try {
    await observer.refresh();
    let records = await readSessionRecords(directory, 'project');
    assert.equal(records.length, 1);
    assert.equal(records[0].sessionID, 'child');
    assert.equal(records[0].status, 'running');
    assert.equal(records[0].activeIssueId, 'test-a');
    const childRecord: unknown = records[0];
    assert.ok(
      childRecord && typeof childRecord === 'object' && 'diffs' in childRecord,
    );
    assert.ok(Array.isArray(childRecord.diffs));
    assert.equal(childRecord.diffs[0].file, 'a.js');
    task = 'test-b';
    infos.child.time.updated++;
    await observer.refresh();
    records = await readSessionRecords(directory, 'project');
    assert.equal(records[0].activeIssueId, 'test-b');
    active = {};
    infos.child.outcome = 'interrupted';
    infos.child.time.updated++;
    await observer.refresh();
    records = await readSessionRecords(directory, 'project');
    assert.equal(records[0].status, 'interrupted');
    fail = true;
    await observer.refresh();
    records = await readSessionRecords(directory, 'project');
    assert.equal(records[0].status, 'unknown');
    const bridge = (await readdir(directory)).find((x) =>
      x.startsWith('bridge-'),
    );
    assert.ok(bridge);
    assert.equal(
      JSON.parse(await readFile(join(directory, bridge), 'utf8'))
        .activityAvailable,
      false,
    );
  } finally {
    await observer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('JSON event discovers a child between catalog polls and subscription closes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'observer-event-test-'));
  let deliver: ((value: string | null) => void) | undefined;
  let aborted = false,
    revision = 1;
  const ctx: ObserverContext = {
    storage: memoryStorage(),
    session: {
      active: async () => ({ data: { newchild: { type: 'running' } } }),
      list: async () => ({ data: [], cursor: {} }),
      get: async ({ sessionID }: { sessionID: string }) => ({
        data: {
          id: sessionID,
          parentID: 'idle-parent',
          agent: 'general',
          location: { directory },
          time: { updated: revision },
        },
      }),
      context: async () => ({
        data: [{ type: 'user', id: 'm', text: 'Work on test-a' }],
      }),
      diff: async () => ({ data: [] }),
    },
    event: {
      async *subscribe({ signal }) {
        assert.ok(signal);
        const value = await new Promise<string | null>((resolve) => {
          deliver = resolve;
          signal.addEventListener('abort', () => resolve(null), { once: true });
        });
        if (value) yield value;
        if (!signal.aborted)
          await new Promise((resolve) =>
            signal.addEventListener('abort', resolve, { once: true }),
          );
        aborted = signal.aborted;
      },
    },
  };
  const observer = await observeOpenCodeSessions(ctx, {
    directory,
    projectId: 'project',
    cwd: directory,
    listIssues: async () => ['test-a'],
  });
  try {
    await observer.refresh();
    revision++;
    assert.ok(deliver);
    deliver(
      JSON.stringify({
        type: 'session.created',
        data: { sessionID: 'eventchild' },
      }),
    );
    const deadline = Date.now() + 3000;
    let records = [];
    do {
      await new Promise((resolve) => setTimeout(resolve, 30));
      records = await readSessionRecords(directory, 'project');
    } while (
      !records.some((s) => s.sessionID === 'eventchild') &&
      Date.now() < deadline
    );
    assert.ok(records.some((s) => s.sessionID === 'eventchild'));
  } finally {
    await observer.close();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(aborted, true);
});

test('discovery follows seven cursor pages with at most four concurrent reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'observer-pages-test-'));
  let pages = 0,
    reads = 0,
    maxReads = 0;
  const ctx: ObserverContext = {
    storage: memoryStorage(),
    session: {
      active: async () => ({ data: {} }),
      list: async ({ cursor }: { cursor?: string }) => {
        const page = Number(cursor || 0);
        pages++;
        return {
          data: [{ id: 'page' + page }],
          cursor: { next: page < 6 ? String(page + 1) : undefined },
        };
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        reads++;
        maxReads = Math.max(maxReads, reads);
        await Promise.resolve();
        reads--;
        return {
          data: {
            id: sessionID,
            location: { directory },
            time: { updated: 1 },
          },
        };
      },
      context: async () => ({
        data: [{ type: 'user', id: 'm', text: 'test-a' }],
      }),
      diff: async () => ({ data: [] }),
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
  const observer = await observeOpenCodeSessions(ctx, {
    directory,
    projectId: 'project',
    cwd: directory,
    listIssues: async () => ['test-a'],
  });
  try {
    for (let i = 0; i < 7; i++) await observer.refresh();
    assert.equal(pages, 7);
    assert.ok(maxReads <= 4);
    assert.ok(
      (await readSessionRecords(directory, 'project')).some(
        (s) => s.sessionID === 'page6',
      ),
    );
  } finally {
    await observer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
