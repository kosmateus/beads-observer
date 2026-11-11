import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import type { ObserverContext } from '../src/adapters/opencode-types.js';
import { memoryStorage } from './fixtures.js';

test('historical rotation beyond 128 contexts retains permanent diff errors, active reads and scope recovery', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.module('node:fs/promises', {
    namedExports: {
      ...filesystem,
      realpath: async (path: string) => path.replace(/\/\.$/, ''),
    },
  });
  const records = new Map<string, Record<string, unknown>>();
  t.mock.module(new URL('../src/adapters/hub-files.js', import.meta.url), {
    namedExports: {
      atomicJSON: async (_path: string, record: Record<string, unknown>) => {
        if (typeof record.sessionID === 'string')
          records.set(record.sessionID, record);
      },
    },
  });
  const { observeOpenCodeSessions } =
    await import('../src/adapters/opencode-sessions.js');
  const historical = Array.from({ length: 260 }, (_, i) => 'history-' + i);
  const targets = [historical[0], historical[70], historical[180]];
  const blocked = new Set(targets);
  const turns = new Map<string, string>(),
    locations = new Map<string, string>();
  const calls = new Map<string, number>(),
    contexts = new Map<string, number>();
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  const emit = async (sessionID: string, type: string) => {
    queue.push(JSON.stringify({ type, data: { sessionID } }));
    wake?.();
    await setImmediate();
  };
  const ctx: ObserverContext = {
    storage: memoryStorage(),
    session: {
      active: async () => ({ active: {} }),
      list: async () => historical.map((id) => ({ id })),
      get: async ({ sessionID }) => ({
        id: sessionID,
        location: { directory: locations.get(sessionID) || '/project' },
        time: { updated: turns.get(sessionID) === 'user-2' ? 2 : 1 },
      }),
      context: async ({ sessionID }) => {
        contexts.set(sessionID, (contexts.get(sessionID) || 0) + 1);
        return [
          {
            type: 'user',
            id: turns.get(sessionID) || 'user-1',
            text: 'test-a',
          },
        ];
      },
      diff: async ({ sessionID }) => {
        calls.set(sessionID, (calls.get(sessionID) || 0) + 1);
        if (blocked.has(sessionID))
          throw Object.assign(Error('Turn range spans a location change'), {
            status: 400,
          });
        return [{ file: sessionID + '.ts', patch: '+current file change' }];
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
    cwd: '/project',
    directory: '/records',
    projectId: 'project',
    listIssues: async () => ['test-a'],
  });
  const rotate = async () => {
    for (let i = 0; i < 120; i++) {
      now += 1000;
      await observer.refresh();
    }
  };
  try {
    await rotate();
    assert.equal(
      records.size,
      261,
      'history is still discovered, not disabled',
    );
    assert.ok(
      contexts.get('active')! > 1,
      'active logs keep receiving snapshots',
    );
    for (const id of targets) await emit(id, 'session.text.delta');
    await observer.refresh();
    assert.ok(
      contexts.get(targets[0])! > 1,
      'the regression actually evicts and reloads historical context',
    );
    for (const id of targets) {
      assert.equal(
        calls.get(id),
        1,
        'unchanged invalid range is requested once: ' + id,
      );
      assert.ok(
        JSON.stringify(records.get(id)?.warnings).includes(
          'Turn range spans a location change',
        ),
      );
    }
    blocked.delete(targets[0]);
    turns.set(targets[0], 'user-2');
    await emit(targets[0], 'session.text.ended');
    await observer.refresh();
    assert.equal(
      calls.get(targets[0]),
      2,
      'new user turn retries after eviction',
    );
    assert.ok(
      !JSON.stringify(records.get(targets[0])?.warnings).includes(
        'Turn range spans a location change',
      ),
    );
    blocked.delete(targets[1]);
    locations.set(targets[1], '/project/.');
    await emit(targets[1], 'session.moved');
    await observer.refresh();
    assert.equal(
      calls.get(targets[1]),
      2,
      'location change retries after eviction',
    );
    assert.ok(
      JSON.stringify(records.get(targets[1])?.diffs).includes(
        'current file change',
      ),
    );
    const previouslySuccessful = historical[220];
    blocked.add(previouslySuccessful);
    turns.set(previouslySuccessful, 'user-2');
    await emit(previouslySuccessful, 'session.tool.success');
    await observer.refresh();
    const attempts = calls.get(previouslySuccessful);
    for (const id of historical.slice(0, 180))
      await emit(id, 'session.text.delta');
    await observer.refresh();
    await emit(previouslySuccessful, 'session.text.delta');
    await observer.refresh();
    await rotate();
    assert.equal(
      calls.get(previouslySuccessful),
      attempts,
      'a later permanent failure also survives rotation',
    );
    assert.ok(
      JSON.stringify(records.get(previouslySuccessful)?.diffs).includes(
        'current file change',
      ),
      'last successful diff is retained while unavailable',
    );
    assert.equal(
      calls.get(targets[2]),
      1,
      'recovering another session never unlocks this invalid range',
    );
  } finally {
    await observer.close();
  }
});
