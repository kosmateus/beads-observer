import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import * as filesystem from 'node:fs/promises';
import type {
  Activity,
  ObserverContext,
  ObserverSessionInfo,
} from '../src/adapters/opencode-types.js';
import type { SessionMessage } from '../src/types.js';
import { memoryStorage } from './fixtures.js';

test('session observer storage, scope, failure and lifecycle boundaries are isolated', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  const writes = new Map<string, Record<string, unknown>>();
  let writeError = false;
  const locations = new Map<string, string | Error>();
  class MissingBeadsWorkspaceError extends Error {}
  t.mock.module('node:fs/promises', {
    namedExports: {
      ...filesystem,
      realpath: async (path: string) => path,
    },
  });
  t.mock.module(new URL('../src/adapters/hub-files.js', import.meta.url), {
    namedExports: {
      atomicJSON: async (path: string, value: Record<string, unknown>) => {
        if (writeError) {
          writeError = false;
          throw Error('write failed');
        }
        writes.set(path, value);
      },
    },
  });
  t.mock.module(new URL('../src/adapters/beads-cli.js', import.meta.url), {
    namedExports: {
      BeadsSource: class {
        constructor(private options: { cwd: string }) {}
        async location() {
          const value = locations.get(this.options.cwd);
          if (value instanceof Error) throw value;
          return { path: value || '/different-beads' };
        }
      },
      MissingBeadsWorkspaceError,
    },
  });
  const { observeOpenCodeSessions } =
    await import('../src/adapters/opencode-sessions.js');
  const options = {
    directory: '/records',
    projectId: 'project',
    cwd: '/project',
  };
  function fixture() {
    const infos = new Map<string, ObserverSessionInfo>([
      [
        'one',
        {
          id: 'one',
          location: { directory: '/project' },
          time: { updated: 1 },
        },
      ],
    ]);
    let activity: unknown = { one: { type: 'running' } };
    let messages: SessionMessage[] = [
      { type: 'user', id: 'user', text: 'test-a' },
    ];
    let getError = false,
      contextError = false,
      catalogError = false;
    const ctx: ObserverContext = {
      storage: memoryStorage(),
      session: {
        active: async () => activity as Activity,
        list: async () => {
          if (catalogError) throw Error('catalog offline');
          return { data: [...infos.values()] };
        },
        get: async ({ sessionID }) => {
          if (getError) throw Error('session offline');
          return infos.get(sessionID)!;
        },
        context: async () => {
          if (contextError) return {} as SessionMessage[];
          return messages;
        },
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
    return {
      ctx,
      infos,
      set activity(value: unknown) {
        activity = value;
      },
      set messages(value: SessionMessage[]) {
        messages = value;
      },
      set getError(value: boolean) {
        getError = value;
      },
      set contextError(value: boolean) {
        contextError = value;
      },
      set catalogError(value: boolean) {
        catalogError = value;
      },
    };
  }
  const issues = async () => ['test-a', { id: 'test-b' }];

  const empty = fixture();
  empty.ctx.location = { project: { id: 'host-project' } };
  empty.activity = {};
  empty.infos.clear();
  t.mock.method(empty.ctx.storage, 'get', async () => {
    throw Error('storage offline');
  });
  const noSessions = await observeOpenCodeSessions(empty.ctx, options);
  await noSessions.refresh();
  Reflect.deleteProperty(empty.ctx.session, 'list');
  await noSessions.refresh();
  await noSessions.close();
  await noSessions.refresh();

  const stored = fixture();
  stored.infos.set('two', { id: 'two', location: { directory: '/project' } });
  await stored.ctx.storage.set('beads-observer.sessions.project', [
    ['one', ['test-a', 7]],
    ['two', ['test-a']],
    'invalid',
    [3, []],
    ['invalid', 'not-array'],
  ]);
  const manual = await observeOpenCodeSessions(stored.ctx, {
    ...options,
    listIssues: issues,
  });
  await manual.refresh();
  await manual.bind('one', 'test-b');
  await manual.bind('one', 'test-b');
  await manual.close();

  const automatic = fixture();
  for (const id of ['ambiguous', 'stale', 'no-history'])
    automatic.infos.set(id, { id, location: { directory: '/project' } });
  automatic.activity = Object.fromEntries(
    [...automatic.infos.keys()].map((id) => [id, { type: 'running' }]),
  );
  automatic.messages = [{ type: 'user', text: 'test-a test-b' }];
  await automatic.ctx.storage.set('beads-observer.sessions.project', {
    manual: [['manual-invalid', 'not-array']],
    automatic: [
      ['ambiguous', { issueId: 'test-a', source: 'prompt' }, ['test-a', 42]],
      ['stale', { issueId: 'test-a', source: 'obsolete' }, ['test-a']],
      ['no-history', { issueId: 'test-a', source: 'prompt' }, false],
      [null, null, []],
      ['invalid-link', null, []],
    ],
  });
  const restored = await observeOpenCodeSessions(automatic.ctx, {
    ...options,
    listIssues: issues,
  });
  await restored.refresh();
  assert.ok(
    [...writes.values()].some((value) =>
      JSON.stringify(value).includes('Several Beads IDs'),
    ),
  );
  automatic.messages = [];
  now += 5000;
  await restored.refresh();
  t.mock.method(automatic.ctx.storage, 'set', async () => {
    throw Error('storage write offline');
  });
  await restored.bind('one', 'test-a').catch(() => {});
  await restored.refresh();
  automatic.getError = true;
  await restored.refresh();
  assert.ok(
    [...writes.values()].some(
      (value) => value.sessionID === 'one' && value.connected === false,
    ),
  );
  automatic.getError = false;
  automatic.contextError = true;
  now += 5000;
  await restored.refresh();
  await restored.close();

  const unavailable = fixture();
  unavailable.infos.clear();
  unavailable.catalogError = true;
  const broken = await observeOpenCodeSessions(unavailable.ctx, {
    ...options,
    listIssues: async () => {
      throw Error('issues offline');
    },
  });
  for (const value of [null, 1, []]) {
    unavailable.activity = value;
    await broken.refresh();
  }
  const unavailableBridge = [...writes.keys()]
    .filter((path) => path.includes('/bridge-project-'))
    .at(-1)!;
  unavailable.activity = { one: { type: 'idle' } };
  await broken.refresh();
  assert.ok(
    (writes.get(unavailableBridge)?.warnings as string[]).includes(
      'Session activity unavailable: Invalid session.active response',
    ),
    'non-running activity entries are rejected rather than treated as idle',
  );
  await broken.close();

  const scope = fixture();
  scope.activity = {};
  scope.infos.clear();
  scope.infos.set('missing', { id: 'missing' });
  scope.infos.set('foreign', {
    id: 'foreign',
    location: { directory: '/foreign' },
  });
  scope.infos.set('same-foreign', {
    id: 'same-foreign',
    location: { directory: '/foreign' },
  });
  const isolated = await observeOpenCodeSessions(scope.ctx, {
    ...options,
    listIssues: issues,
  });
  await isolated.refresh();
  await assert.rejects(isolated.bind('foreign', 'test-a'), /another project/);
  await isolated.close();

  const shared = fixture();
  shared.infos.clear();
  for (let i = 0; i < 602; i++) {
    const id = 'shared-' + i,
      path = '/worktree/' + i;
    shared.infos.set(id, { id, location: { directory: path } });
    locations.set(
      path,
      i === 0 ? new MissingBeadsWorkspaceError() : '/shared-beads',
    );
  }
  shared.activity = Object.fromEntries(
    [...shared.infos.keys()].map((id) => [id, { type: 'running' }]),
  );
  const sharedObserver = await observeOpenCodeSessions(shared.ctx, {
    ...options,
    listIssues: issues,
    beadsLocation: async () => ({ path: '/shared-beads' }),
  });
  await sharedObserver.refresh();
  await sharedObserver.close();

  const scopeFailure = fixture();
  const scopedError = await observeOpenCodeSessions(scopeFailure.ctx, {
    ...options,
    listIssues: issues,
    beadsLocation: async () => ({ path: '/shared-beads' }),
  });
  await scopedError.refresh();
  scopeFailure.infos.set('one', {
    id: 'one',
    location: { directory: '/unavailable-worktree' },
    time: { updated: 1 },
  });
  locations.set('/unavailable-worktree', Error('bd permission denied'));
  await scopedError.refresh();
  assert.ok(
    [...writes.values()].some(
      (value) =>
        value.sessionID === 'one' &&
        Array.isArray(value.warnings) &&
        value.warnings.includes(
          'Session read unavailable: bd permission denied',
        ),
    ),
    'unexpected Beads lookup errors remain visible on the affected session',
  );
  await scopedError.close();

  const missingSnapshot = fixture();
  missingSnapshot.contextError = true;
  const recordsBefore = [...writes.values()].filter(
    (value) => value.sessionID === 'one',
  ).length;
  const noSnapshot = await observeOpenCodeSessions(missingSnapshot.ctx, {
    ...options,
    listIssues: issues,
  });
  await noSnapshot.refresh();
  assert.equal(
    [...writes.values()].filter((value) => value.sessionID === 'one').length,
    recordsBefore,
    'an active session without a first context snapshot is not persisted as a read failure',
  );
  await noSnapshot.close();

  const reconnect = fixture();
  let subscriptions = 0;
  reconnect.ctx.event.subscribe = async function* ({ signal }) {
    subscriptions++;
    if (subscriptions === 1) throw Error('subscription offline');
    yield { data: {} };
    yield { type: 'session.moved', data: { sessionID: 'one' } };
    await new Promise((resolve) =>
      signal?.addEventListener('abort', resolve, { once: true }),
    );
    yield { data: { sessionID: 'one' } };
  };
  const reconnecting = await observeOpenCodeSessions(reconnect.ctx, {
    ...options,
    listIssues: issues,
  });
  writeError = true;
  await delay(1100);
  assert.ok(subscriptions >= 2);
  assert.ok(
    warnings.some((message) =>
      message.includes('Session refresh: write failed'),
    ),
  );
  await reconnecting.close();

  const stopDuringReconnect = fixture();
  stopDuringReconnect.ctx.event.subscribe = async function* () {
    throw Error('retry later');
  };
  const retrying = await observeOpenCodeSessions(
    stopDuringReconnect.ctx,
    options,
  );
  await setImmediate();
  await retrying.close();

  const racing = fixture();
  let deliver: (() => void) | undefined;
  racing.ctx.event.subscribe = async function* ({ signal }) {
    await new Promise<void>((resolve) => {
      deliver = resolve;
    });
    yield { data: { sessionID: 'one' } };
    await new Promise((resolve) =>
      signal?.addEventListener('abort', resolve, { once: true }),
    );
  };
  racing.ctx.session.context = async () => {
    deliver?.();
    await setImmediate();
    return [{ type: 'user', text: 'test-a' }];
  };
  const racingObserver = await observeOpenCodeSessions(racing.ctx, {
    ...options,
    listIssues: issues,
  });
  await racingObserver.refresh();
  await racingObserver.close();

  const stopping = fixture();
  for (let i = 0; i < 8; i++)
    stopping.infos.set('stop-' + i, {
      id: 'stop-' + i,
      location: { directory: '/project' },
    });
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  stopping.ctx.session.get = async ({ sessionID }) => {
    started();
    await blocked;
    return stopping.infos.get(sessionID)!;
  };
  const stoppingObserver = await observeOpenCodeSessions(stopping.ctx, {
    ...options,
    listIssues: issues,
  });
  const refresh = stoppingObserver.refresh();
  const rejected = assert.rejects(refresh, /write failed/);
  await readStarted;
  const closing = stoppingObserver.close();
  writeError = true;
  release();
  await rejected;
  await closing;
});
