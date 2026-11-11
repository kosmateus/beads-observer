import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import type { ObserverContext } from '../src/adapters/opencode-types.js';
import { memoryStorage } from './fixtures.js';

test('token storms bound get/context/diff for seven active sessions, 260 historical sessions and a foreign session', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.module('node:fs/promises', {
    namedExports: { ...filesystem, realpath: async (path: string) => path },
  });
  const records = new Map<string, Record<string, unknown>>();
  t.mock.module(new URL('../src/adapters/hub-files.js', import.meta.url), {
    namedExports: {
      atomicJSON: async (_path: string, value: Record<string, unknown>) => {
        if (typeof value.sessionID === 'string')
          records.set(value.sessionID, value);
      },
    },
  });
  const { observeOpenCodeSessions } =
    await import('../src/adapters/opencode-sessions.js');
  const active = Array.from({ length: 7 }, (_, i) => 'active-' + i);
  const activeIDs = new Set([...active, 'foreign']);
  const history = Array.from({ length: 260 }, (_, i) => 'history-' + i);
  const counts = {
    active: 0,
    list: 0,
    get: 0,
    context: 0,
    diff: 0,
    foreignGet: 0,
  };
  let foreignDirectory = '/foreign';
  let manualDirectory = '/foreign';
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let pauseNextActive = false,
    activeStarted: (() => void) | undefined,
    releaseActive: (() => void) | undefined;
  const emit = async (id: string, type = 'session.text.delta') => {
    queue.push(JSON.stringify({ type, data: { sessionID: id } }));
    wake?.();
    await setImmediate();
  };
  const ctx: ObserverContext = {
    storage: memoryStorage(),
    session: {
      active: async () => {
        counts.active++;
        if (pauseNextActive) {
          pauseNextActive = false;
          activeStarted?.();
          await new Promise<void>((resolve) => {
            releaseActive = resolve;
          });
        }
        return Object.fromEntries([...activeIDs].map((id) => [id, {}]));
      },
      list: async () => {
        counts.list++;
        return history.map((id) => ({ id }));
      },
      get: async ({ sessionID }) => {
        counts.get++;
        if (sessionID === 'foreign') counts.foreignGet++;
        return {
          id: sessionID,
          location: {
            directory:
              sessionID === 'foreign'
                ? foreignDirectory
                : sessionID === 'manual-target'
                  ? manualDirectory
                  : '/project',
          },
          time: { updated: 1 },
        };
      },
      context: async () => {
        counts.context++;
        return [{ type: 'user', id: 'user-1', text: 'test-a' }];
      },
      diff: async () => {
        counts.diff++;
        return [];
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
  try {
    for (let round = 0; round < 140; round++) {
      now += 1000;
      await observer.refresh();
    }
    assert.equal(
      records.size,
      267,
      'all history and active sessions remain observed',
    );
    now += 5000;
    await emit('foreign', 'session.moved');
    await observer.refresh();
    const before = { ...counts };
    for (let round = 0; round < 20; round++) {
      now += 500;
      for (const id of [...active, 'foreign'])
        for (let token = 0; token < 5; token++) await emit(id);
      await observer.refresh();
    }
    t.diagnostic(
      JSON.stringify({
        windowMs: 10000,
        active: counts.active - before.active,
        list: counts.list - before.list,
        get: counts.get - before.get,
        context: counts.context - before.context,
        diff: counts.diff - before.diff,
        foreignGet: counts.foreignGet - before.foreignGet,
      }),
    );
    assert.ok(
      counts.active - before.active <= 2,
      `token streaming should make at most two activity reads per 10 s, got ${counts.active - before.active}`,
    );
    assert.equal(
      counts.list - before.list,
      0,
      'unchanged token activity does not restart catalog discovery',
    );
    assert.ok(
      counts.get - before.get <= 54,
      `10 s budget: at most 14 active + 40 historical get calls, got ${counts.get - before.get}`,
    );
    assert.equal(
      counts.context - before.context,
      14,
      'only seven active contexts twice; unchanged historical contexts are not reloaded',
    );
    assert.equal(
      counts.diff - before.diff,
      0,
      'streaming and unchanged historical sweeps never repeat diff',
    );
    assert.equal(
      counts.foreignGet,
      before.foreignGet,
      'known foreign token storms do not trigger metadata RPCs',
    );
    const beforeActivityEnd = counts.active;
    activeIDs.delete('active-0');
    await emit('active-0', 'session.execution.succeeded');
    await observer.refresh();
    assert.equal(
      counts.active,
      beforeActivityEnd + 1,
      'session completion refreshes activity immediately',
    );
    assert.equal(records.get('active-0')?.status, 'idle');
    activeIDs.add('active-0');
    await emit('active-0', 'session.execution.started');
    await observer.refresh();
    assert.equal(
      counts.active,
      beforeActivityEnd + 2,
      'new execution refreshes activity immediately',
    );
    assert.equal(records.get('active-0')?.status, 'running');
    const beforeRace = counts.active;
    let signalActiveStarted!: () => void;
    const activeRequestStarted = new Promise<void>((resolve) => {
      signalActiveStarted = resolve;
    });
    pauseNextActive = true;
    activeStarted = signalActiveStarted;
    activeIDs.delete('active-1');
    await emit('active-1', 'session.text.ended');
    const inFlight = observer.refresh();
    await activeRequestStarted;
    activeIDs.add('active-1');
    await emit('active-1', 'session.execution.started');
    releaseActive!();
    await inFlight;
    await observer.refresh();
    assert.equal(
      counts.active,
      beforeRace + 2,
      'lifecycle changes during an in-flight read force a fresh activity result',
    );
    assert.equal(records.get('active-1')?.status, 'running');
    const beforeMoved = counts.foreignGet;
    const beforeMovedActivity = counts.active;
    foreignDirectory = '/project';
    await emit('foreign', 'session.moved');
    await observer.refresh();
    assert.equal(counts.foreignGet, beforeMoved + 1);
    assert.equal(
      counts.active,
      beforeMovedActivity + 1,
      'moves refresh activity immediately',
    );
    assert.ok(
      records.has('foreign'),
      'moved sessions are promptly rediscovered in this project',
    );
    const beforeNewChildActivity = counts.active;
    await emit('new-child', 'session.created');
    await observer.refresh();
    assert.equal(
      counts.active,
      beforeNewChildActivity + 1,
      'new children refresh activity immediately',
    );
    assert.ok(
      records.has('new-child'),
      'unknown children bypass historical maintenance cadence',
    );
    await emit('manual-target', 'session.created');
    await observer.refresh();
    assert.ok(!records.has('manual-target'));
    manualDirectory = '/project';
    await observer.bind('manual-target', 'test-a');
    assert.ok(
      records.has('manual-target'),
      'explicit binding revalidates cached foreign metadata immediately',
    );
  } finally {
    await observer.close();
  }
});
