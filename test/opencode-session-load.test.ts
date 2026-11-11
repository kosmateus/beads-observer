import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { observeOpenCodeSessions } from '../src/adapters/opencode-sessions.js';
import { readSessionRecords } from '../src/adapters/session-records.js';
import type { ObserverContext } from '../src/adapters/opencode-types.js';
import type { SessionPart } from '../src/types.js';
import { memoryStorage } from './fixtures.js';

test('token storms keep seven sessions current without repeating heavy reads; mutations, moves and errors invalidate selectively', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'observer-load-'));
  let now = Date.now(),
    revision = 1,
    location = directory;
  t.mock.method(Date, 'now', () => now);
  const ids = Array.from({ length: 7 }, (_, i) => 'session' + i);
  let active = Object.fromEntries(ids.map((id) => [id, {}]));
  let contexts = 0,
    diffs = 0,
    concurrent = 0,
    maximum = 0;
  let failure: Error | undefined;
  let userTurn = 'user-1';
  let shellState: string | undefined;
  const parts = new Map<string, SessionPart[]>();
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  const emit = async (type: string, sessionID = ids[0]) => {
    queue.push(JSON.stringify({ type, data: { sessionID } }));
    wake?.();
    await setImmediate();
  };
  async function mutate() {
    parts.set(ids[0], [
      ...(parts.get(ids[0]) || []),
      {
        type: 'tool',
        id: String(revision++),
        name: 'execute',
        state: { status: 'completed', input: { code: 'writeFile(...)' } },
      },
    ]);
    await emit('session.tool.success');
  }
  async function heavy() {
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    await setImmediate();
    concurrent--;
  }
  const ctx: ObserverContext = {
    storage: memoryStorage(),
    session: {
      active: async () => active,
      list: async () => ids.map((id) => ({ id })),
      get: async ({ sessionID }) => ({
        id: sessionID,
        location: { directory: location },
        time: { updated: revision },
      }),
      context: async ({ sessionID }) => {
        contexts++;
        await heavy();
        return [
          ...(shellState
            ? [
                {
                  type: 'shell',
                  id: 'native-shell',
                  command: 'write-file',
                  status: shellState,
                },
              ]
            : []),
          {
            type: 'user',
            id: sessionID === ids[0] ? userTurn : 'user-1',
            text: 'Work on test-a',
          },
          {
            type: 'assistant',
            content: [
              { type: 'text', text: 'Token ' + revision },
              ...(parts.get(sessionID) || []),
            ],
          },
        ];
      },
      diff: async ({ sessionID }) => {
        diffs++;
        await heavy();
        if (failure && sessionID === ids[0]) throw failure;
        return [{ file: 'changed.ts', patch: '+' + revision }];
      },
    },
    event: {
      async *subscribe({ signal }) {
        signal?.addEventListener('abort', () => wake?.(), { once: true });
        while (!signal?.aborted) {
          if (queue.length) yield queue.shift()!;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      },
    },
  };
  const observer = await observeOpenCodeSessions(ctx, {
    directory,
    cwd: directory,
    projectId: 'project',
    listIssues: async () => ['test-a'],
  });
  try {
    await observer.refresh();
    assert.equal(contexts, 7);
    assert.equal(diffs, 7);
    for (let round = 0; round < 3; round++) {
      now += 600;
      revision++;
      for (const id of ids)
        for (let n = 0; n < 20; n++) await emit('session.text.delta', id);
      await Promise.all([observer.refresh(), observer.refresh()]);
    }
    assert.equal(contexts, 7, 'streaming snapshots are throttled');
    assert.equal(diffs, 7, 'token events never invalidate the file diff');
    assert.equal(
      maximum,
      1,
      'expensive context/diff reads are serialized across sessions',
    );
    now += 5000;
    await observer.refresh();
    assert.equal(contexts, 14, 'logs still receive bounded fresh snapshots');
    assert.ok(
      JSON.stringify(await readSessionRecords(directory, 'project')).includes(
        'Token ' + revision,
      ),
    );
    assert.equal(diffs, 7);
    await mutate();
    await observer.refresh();
    assert.equal(
      diffs,
      8,
      'arbitrary tool completion, including execute/shell, refreshes files',
    );
    assert.equal(contexts, 15);
    await emit('session.tool.success');
    await observer.refresh();
    assert.equal(diffs, 8, 'duplicate terminal events reuse the diff');
    assert.equal(
      (await readSessionRecords(directory, 'project'))[0].status,
      'running',
    );
    location += '/.';
    for (const id of ids) await emit('session.moved', id);
    await observer.refresh();
    assert.equal(
      diffs,
      15,
      'location invalidates even without a time revision',
    );
    failure = Object.assign(new Error('Turn range spans a location change'), {
      status: 400,
    });
    await mutate();
    await observer.refresh();
    const after400 = diffs;
    now += 60000;
    revision++;
    await emit('session.text.delta');
    await observer.refresh();
    await observer.refresh();
    assert.equal(
      diffs,
      after400,
      'permanent 400 is cached across tokens and heartbeat',
    );
    for (let i = 0; i < 4; i++) {
      await mutate();
      await observer.refresh();
    }
    assert.equal(
      diffs,
      after400,
      'tools cannot repair a conflicting historical turn range',
    );
    assert.ok(
      (await readSessionRecords(directory, 'project')).some((record) =>
        JSON.stringify(record).includes('Turn range spans a location change'),
      ),
    );
    failure = undefined;
    userTurn = 'user-2';
    now += 5000;
    await observer.refresh();
    assert.equal(
      diffs,
      after400 + 1,
      'a real new user turn in the same directory retries the range',
    );
    assert.ok(
      !(await readSessionRecords(directory, 'project')).some((record) =>
        JSON.stringify(record).includes('Turn range spans a location change'),
      ),
    );
    failure = new Error('temporarily offline');
    await mutate();
    await observer.refresh();
    const afterTransient = diffs;
    await observer.refresh();
    assert.equal(diffs, afterTransient, 'transient failure has a cooldown');
    failure = undefined;
    now += 30000;
    await observer.refresh();
    assert.equal(
      diffs,
      afterTransient + 1,
      'transient failures eventually recover',
    );
    active = {};
    await observer.refresh();
    assert.equal(
      diffs,
      afterTransient + 8,
      'idle transition captures the final diff',
    );
    active = { [ids[0]]: {} };
    parts.set(ids[0], [
      {
        type: 'tool',
        id: 'long-shell',
        name: 'shell',
        state: { status: 'running' },
      },
    ]);
    now += 5000;
    await observer.refresh();
    const beforeFallback = diffs;
    now += 600;
    await emit('session.text.delta');
    await observer.refresh();
    assert.equal(diffs, beforeFallback);
    now += 30000;
    await observer.refresh();
    assert.equal(
      diffs,
      beforeFallback + 1,
      'long-running arbitrary tools have a bounded fallback',
    );
    parts.set(ids[0], [
      {
        type: 'tool',
        id: 'long-shell',
        name: 'shell',
        state: { status: 'completed' },
      },
    ]);
    await emit('session.tool.success');
    await observer.refresh();
    assert.equal(
      diffs,
      beforeFallback + 2,
      'completion captures writes from a long-running tool',
    );
    parts.set(ids[0], [
      ...parts.get(ids[0])!,
      {
        type: 'tool',
        id: 'read',
        name: 'read',
        state: { status: 'completed' },
      },
    ]);
    await emit('session.tool.success');
    await observer.refresh();
    assert.equal(
      diffs,
      beforeFallback + 2,
      'known read-only tools update logs but not the diff',
    );
    parts.set(ids[0], [
      ...parts.get(ids[0])!,
      { type: 'tool', id: 'no-state' },
      { type: 'tool', id: 'no-name', state: { status: 'completed' } },
    ]);
    await emit('session.tool.success');
    await observer.refresh();
    shellState = 'running';
    now += 5000;
    await observer.refresh();
    const beforeNativeShell = diffs;
    now += 30000;
    await observer.refresh();
    assert.ok(
      diffs > beforeNativeShell,
      'native shell also receives a bounded fallback',
    );
    shellState = 'completed';
    await emit('session.shell.ended');
    await observer.refresh();
    const afterNativeShell = diffs;
    await emit('');
    await observer.refresh();
    assert.equal(
      diffs,
      afterNativeShell,
      'untyped events do not invalidate file snapshots',
    );
  } finally {
    await observer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
