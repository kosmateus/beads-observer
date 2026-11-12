import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as filesystem from 'node:fs/promises';
import { promisify } from 'node:util';

test('Beads CLI reads preserve pinning, failures and project isolation', async (t) => {
  const calls: string[][] = [];
  const failures = new Map<string, Error[]>();
  let wherePath: string | undefined = '/project/.beads';
  let realpathFailure: NodeJS.ErrnoException | undefined;
  let invalidJSON = false;
  let listResult: unknown = [{ id: 'task-1', title: 'Task', status: 'open' }];
  let showResult: unknown = { id: 'task-1', title: 'Task', status: 'open' };

  function failNext(command: string, error: Error) {
    failures.set(command, [...(failures.get(command) || []), error]);
  }

  function failureKey(args: string[]) {
    if (args[0] === '--version') return 'version';
    const command = args[2] || args[0] || '';
    return command === 'history' && args.includes('--events')
      ? 'history-events'
      : command;
  }

  const fakeExec = Object.assign(
    (_file: string, _args: string[], _options: unknown) => {},
    {
      [promisify.custom]: async (
        _file: string,
        args: string[],
        _options: unknown,
      ) => {
        calls.push(args);
        const key = failureKey(args);
        const queued = failures.get(key);
        if (queued?.length) {
          const [error] = queued.splice(0, 1);
          throw error;
        }
        if (args[0] === '--version') return { stdout: '0.17.1\n', stderr: '' };
        if (invalidJSON) return { stdout: '{', stderr: '' };
        const command = args[2];
        let value: unknown;
        if (command === 'where') value = { path: wherePath };
        else if (command === 'list') value = listResult;
        else if (command === 'ready') value = ['task-1'];
        else if (command === 'blocked') value = [];
        else if (command === 'comments') value = [{ text: 'comment' }];
        else if (command === 'history') value = [];
        else if (command === 'show') value = showResult;
        else throw new Error(`Unexpected command: ${command}`);
        return { stdout: JSON.stringify(value), stderr: '' };
      },
    },
  );
  t.mock.module('node:child_process', {
    namedExports: {
      ...childProcess,
      execFile: fakeExec as unknown as typeof childProcess.execFile,
    },
  });
  t.mock.module('node:fs/promises', {
    namedExports: {
      ...filesystem,
      realpath: async (path: string | Buffer | URL) => {
        if (realpathFailure) throw realpathFailure;
        return String(path) === '/project/link'
          ? '/project/.beads'
          : String(path);
      },
    },
  });

  const {
    BeadsSource,
    MissingBeadsWorkspaceError,
    isMissingBeadsWorkspaceError,
    projectEnvironment,
  } = await import('../src/adapters/beads-cli.js');

  const missing = new MissingBeadsWorkspaceError();
  assert.equal(missing.name, 'MissingBeadsWorkspaceError');
  assert.equal(missing.code, 'BEADS_NO_WORKSPACE');
  assert.equal(isMissingBeadsWorkspaceError(missing), true);
  assert.equal(isMissingBeadsWorkspaceError('wrong'), false);
  assert.equal(isMissingBeadsWorkspaceError(new Error('no stdout')), false);
  assert.equal(
    isMissingBeadsWorkspaceError(
      Object.assign(new Error('bad json'), { stdout: '{' }),
    ),
    false,
  );
  assert.equal(
    isMissingBeadsWorkspaceError(
      Object.assign(new Error('other error'), {
        stdout: JSON.stringify({ error: 'other' }),
      }),
    ),
    false,
  );

  const env = projectEnvironment({
    HOME: '/home/test',
    BEADS_DIR: '/foreign',
    bd_database: 'foreign',
    DOLT_HOST: 'foreign',
    GIT_DIR: '/foreign/.git',
    GIT_WORK_TREE: '/foreign',
    GIT_COMMON_DIR: '/foreign/.git',
    GIT_INDEX_FILE: '/foreign/index',
    GIT_OPTIONAL_LOCKS: '0',
    NO_COLOR: '0',
  });
  assert.deepEqual(env, {
    HOME: '/home/test',
    GIT_OPTIONAL_LOCKS: '0',
    NO_COLOR: '1',
  });

  const source = new BeadsSource({
    cwd: '/project',
    bdPath: '/bin/bd-test',
    timeoutMs: 3000,
    beadsLocation: '/project/.beads',
  });
  const snapshot = await source.snapshot();
  assert.equal(snapshot.location.path, '/project/.beads');
  assert.equal(snapshot.issues[0]?.ready, true);
  assert.equal(snapshot.issues[0]?.blocked, false);
  assert.equal(calls.filter((args) => args[2] === 'where').length, 1);
  assert.ok(
    calls.every(
      (args) =>
        args[0] === '--version' ||
        (args[0] === '--readonly' && args[1] === '--json'),
    ),
  );

  const unpinned = new BeadsSource({ cwd: '/project' });
  await unpinned.snapshot();
  assert.equal(calls.filter((args) => args[2] === 'where').length, 3);

  wherePath = '/project/link';
  const canonical = new BeadsSource({ cwd: '/project' });
  assert.deepEqual(await canonical.location(), { path: '/project/.beads' });
  assert.equal(canonical.pinnedLocation, '/project/.beads');
  wherePath = '/another/.beads';
  await assert.rejects(canonical.location(), /Beads location changed/);
  wherePath = undefined;
  await assert.rejects(
    new BeadsSource({ cwd: '/project' }).location(),
    MissingBeadsWorkspaceError,
  );
  wherePath = '/project/.beads';
  realpathFailure = Object.assign(new Error('deleted'), { code: 'ENOENT' });
  await assert.rejects(
    new BeadsSource({ cwd: '/project' }).location(),
    MissingBeadsWorkspaceError,
  );
  realpathFailure = Object.assign(new Error('permission denied'), {
    code: 'EACCES',
  });
  await assert.rejects(
    new BeadsSource({ cwd: '/project' }).location(),
    /permission denied/,
  );
  realpathFailure = undefined;

  listResult = { issues: [{ id: 'task-1', title: 'Task', status: 'open' }] };
  assert.deepEqual(await source.issueCatalog(), [
    { id: 'task-1', title: 'Task', status: 'open' },
  ]);

  const activity = await source.activity('task-1');
  assert.equal(activity.comments.length, 1);
  failNext('history-events', new Error('history unavailable'));
  const partialActivity = await source.activity('task-1');
  assert.match(
    partialActivity.statusEventsWarning || '',
    /history unavailable/,
  );

  showResult = [{ id: 'task-1', title: 'Task', status: 'open' }];
  failNext('history', new Error('history unavailable'));
  failNext('history-events', new Error('events unavailable'));
  const detail = await source.detail('task-1');
  assert.equal(detail.id, 'task-1');
  assert.match(detail.historyWarning || '', /history unavailable/);
  assert.match(detail.statusEventsWarning || '', /events unavailable/);
  showResult = { id: 'task-1', title: 'Task', status: 'open' };
  const fullDetail = await source.detail('task-1');
  assert.equal(fullDetail.statusTimeline.reason, 'unavailable');

  await assert.rejects(
    source.execute(['unknown']),
    /Unexpected command: unknown/,
  );
  failNext(
    'where',
    Object.assign(new Error('missing'), {
      stdout: JSON.stringify({ error: 'no_beads_directory' }),
    }),
  );
  await assert.rejects(source.execute(['where']), MissingBeadsWorkspaceError);
  failNext('list', new Error('command failed'));
  await assert.rejects(source.execute(['list']), /command failed/);
  invalidJSON = true;
  await assert.rejects(source.execute(['list']), /poprawnego JSON/);
  invalidJSON = false;

  source.versionRequest = null;
  failNext('version', new Error('version unavailable'));
  assert.equal(await source.version(), null);
  assert.equal(await source.version(), '0.17.1');
  assert.equal(await source.version(), '0.17.1');
  assert.ok(calls.some((args) => args.length === 1 && args[0] === '--version'));
});
