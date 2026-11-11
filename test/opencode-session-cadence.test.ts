import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import * as filesystem from 'node:fs/promises';
import type { ObserverContext } from '../src/adapters/opencode-types.js';
import { memoryStorage } from './fixtures.js';

test('scheduled snapshots retain a five-second cadence and closing skips queued RPCs', async (t) => {
  t.mock.module('node:fs/promises', {
    namedExports: { ...filesystem, realpath: async (path: string) => path },
  });
  t.mock.module(new URL('../src/adapters/hub-files.js', import.meta.url), {
    namedExports: { atomicJSON: async () => {} },
  });
  const { observeOpenCodeSessions } =
    await import('../src/adapters/opencode-sessions.js');
  const options = {
    cwd: '/project',
    directory: '/records',
    projectId: 'project',
    listIssues: async () => ['test-a'],
  };
  function context(ids: string[]): ObserverContext {
    return {
      storage: memoryStorage(),
      session: {
        active: async () => Object.fromEntries(ids.map((id) => [id, {}])),
        list: async () => ids.map((id) => ({ id })),
        get: async ({ sessionID }) => ({
          id: sessionID,
          location: { directory: '/project' },
          time: { updated: 1 },
        }),
        context: async () => [{ type: 'user', text: 'test-a' }],
        diff: async () => [],
      },
      event: {
        async *subscribe({ signal }) {
          await new Promise((resolve) =>
            signal?.addEventListener('abort', resolve, { once: true }),
          );
        },
      },
    };
  }
  await t.test(
    'semantic snapshot does not postpone the next live snapshot to a second heartbeat',
    async (sub) => {
      sub.mock.timers.enable({
        apis: ['Date', 'setTimeout', 'setInterval'],
        now: 100000,
      });
      const ctx = context(['one']);
      const reads: number[] = [];
      let deliver: (() => void) | undefined;
      ctx.session.context = async () => {
        reads.push(Date.now());
        return [{ type: 'user', text: 'test-a' }];
      };
      ctx.event.subscribe = async function* ({ signal }) {
        await new Promise<void>((resolve) => {
          deliver = resolve;
        });
        yield { type: 'session.tool.success', data: { sessionID: 'one' } };
        await new Promise((resolve) =>
          signal?.addEventListener('abort', resolve, { once: true }),
        );
      };
      const observer = await observeOpenCodeSessions(ctx, options);
      const advance = async (milliseconds: number) => {
        for (let remaining = milliseconds; remaining > 0; remaining -= 100) {
          sub.mock.timers.tick(Math.min(remaining, 100));
          await setImmediate();
        }
      };
      try {
        await advance(5600);
        deliver?.();
        await setImmediate();
        await advance(500);
        assert.equal(
          reads.at(-1),
          106100,
          'terminal event forces a live snapshot',
        );
        await advance(5000);
        assert.equal(
          reads.at(-1),
          111100,
          'snapshot expiry, not heartbeat phase, sets the next read',
        );
        await advance(5000);
        assert.equal(reads.at(-1), 116100);
        assert.ok(
          reads.slice(1).every((at, index) => at - reads[index] <= 5000),
        );
      } finally {
        await observer.close();
      }
    },
  );
  await t.test(
    'close lets the in-flight context finish but never starts queued contexts',
    async () => {
      const ctx = context(['a', 'b', 'c', 'd']);
      let release!: () => void, entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const reads: string[] = [];
      ctx.session.context = async ({ sessionID }) => {
        reads.push(sessionID);
        entered();
        await blocked;
        return [{ type: 'user', text: 'test-a' }];
      };
      const observer = await observeOpenCodeSessions(ctx, options);
      const refreshing = observer.refresh();
      await started;
      await setImmediate();
      const closing = observer.close();
      release();
      await refreshing;
      await closing;
      assert.deepEqual(reads, ['a']);
    },
  );
});
