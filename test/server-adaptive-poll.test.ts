import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { BeadsSource } from '../src/adapters/beads-cli.js';
import { BeadsWriter } from '../src/adapters/beads-writer.js';
import { CreateIssue } from '../src/application/create-issue.js';
import { startServer } from '../src/bootstrap/server.js';
import type { Issue } from '../src/types.js';

test('stable snapshots back off per project and writes or errors restore the live cadence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 100_000 });
  const cwd = await mkdtemp(join(tmpdir(), 'observer-adaptive-poll-')),
    beads = join(cwd, '.beads'),
    bdPath = join(cwd, 'bd-fixture.cjs'),
    callPath = join(cwd, 'calls.ndjson'),
    snapshotPath = join(cwd, 'snapshot.json'),
    failurePath = join(cwd, 'fail-next-list');
  await mkdir(beads);
  await writeFile(callPath, '');
  const issue = (id: string): Issue => ({
    id,
    title: id,
    status: 'in_progress',
    issue_type: 'task',
    labels: [],
    dependencies: [],
  });
  await writeFile(
    snapshotPath,
    JSON.stringify({
      issues: [issue('stable')],
      ready: ['stable'],
      blocked: [],
    }),
  );
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const calls = ${JSON.stringify(callPath)};
const snapshot = ${JSON.stringify(snapshotPath)};
const beads = ${JSON.stringify(beads)};
const failNextList = ${JSON.stringify(failurePath)};
const finish = (output, status = 0, stderr = false) => {
  if (output) fs.writeSync(stderr ? 2 : 1, output);
  fs.appendFileSync(calls, JSON.stringify(args) + '\\n');
  process.exit(status);
};
if (args.includes('--version')) finish('fixture-bd');
if (args.includes('where')) finish(JSON.stringify({ path: beads }));
if (args.includes('list')) {
  if (fs.existsSync(failNextList)) {
    fs.unlinkSync(failNextList);
    finish('temporary Beads read failure', 1, true);
  }
  finish(JSON.stringify(JSON.parse(fs.readFileSync(snapshot, 'utf8')).issues));
}
if (args.includes('ready') || args.includes('blocked')) {
  const state = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  finish(JSON.stringify(state[args.includes('ready') ? 'ready' : 'blocked']));
}
if (args.includes('create')) {
  const state = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  const created = ${JSON.stringify(issue('from-write'))};
  state.issues = [created];
  state.ready = [created.id];
  state.blocked = [];
  fs.writeFileSync(snapshot, JSON.stringify(state));
  finish(JSON.stringify(created));
}
finish('unexpected fixture bd command: ' + JSON.stringify(args), 2, true);
`,
    { mode: 0o700 },
  );
  await chmod(bdPath, 0o700);
  const reader = new BeadsSource({ cwd, bdPath, beadsLocation: beads });
  let snapshots = 0;
  const source = {
    async snapshot() {
      try {
        return await reader.snapshot();
      } finally {
        snapshots++;
      }
    },
    detail: (id: string) => reader.detail(id),
  };
  const app = await startServer({
    port: 0,
    cwd,
    bdPath,
    source,
    writer: new BeadsWriter(reader),
    pollIntervalMs: 2000,
    sessionDirectory: join(cwd, 'state'),
  });
  const counts = async () => {
    const text = await readFile(callPath, 'utf8'),
      calls = text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
      count = (command: string) =>
        calls.filter((args) => args.includes(command)).length;
    return {
      list: count('list'),
      ready: count('ready'),
      blocked: count('blocked'),
      where: count('where'),
      version: count('--version'),
      create: count('create'),
    };
  };
  const waitFor = async (
    check: (value: Awaited<ReturnType<typeof counts>>) => boolean,
    message: string,
  ) => {
    for (let i = 0; i < 1000; i++) {
      const value = await counts();
      if (check(value)) {
        for (let j = 0; j < 10; j++) await setImmediate();
        return counts();
      }
      await setImmediate();
    }
    assert.fail(
      `timed out waiting for ${message}: ${JSON.stringify(await counts())}; error=${app.observer.state.error}`,
    );
  };
  const waitForSnapshot = (target: number, message: string) =>
    waitFor(() => snapshots >= target, message);
  const advance = async (milliseconds: number) => {
    for (let remaining = milliseconds; remaining > 0; remaining -= 100) {
      t.mock.timers.tick(Math.min(remaining, 100));
      await setImmediate();
    }
  };
  try {
    let current = await waitForSnapshot(1, 'initial snapshot');
    assert.deepEqual(current, {
      list: 1,
      ready: 1,
      blocked: 1,
      where: 1,
      version: 1,
      create: 0,
    });
    assert.equal(app.observer.state.issues[0].ready, true);
    assert.equal(app.observer.state.issues[0].blocked, false);

    await advance(1999);
    assert.equal((await counts()).list, 1);
    await advance(1);
    current = await waitForSnapshot(2, 'second snapshot');
    assert.equal(current.list, 2, 'the live cadence starts at two seconds');

    await advance(3999);
    assert.equal((await counts()).list, 2);
    await advance(1);
    current = await waitForSnapshot(3, 'third snapshot');
    assert.equal(current.list, 3, 'stable cadence doubles to four seconds');

    await writeFile(
      snapshotPath,
      JSON.stringify({
        issues: [issue('external-change')],
        ready: [],
        blocked: ['external-change'],
      }),
    );
    await advance(7999);
    assert.equal(
      (await counts()).list,
      3,
      'stable cadence is capped at eight seconds',
    );
    await advance(1);
    current = await waitForSnapshot(4, 'external change');
    assert.deepEqual(
      {
        list: current.list,
        ready: current.ready,
        blocked: current.blocked,
        where: current.where,
      },
      { list: 4, ready: 4, blocked: 4, where: 4 },
      'three stable intervals reduced Beads CLI snapshot reads versus the fixed two-second baseline',
    );
    assert.ok(
      current.list < 8,
      'fixed two-second cadence would run eight scans in 14 seconds',
    );
    assert.equal(
      current.list,
      4,
      'external changes are observed within eight seconds',
    );
    assert.equal(current.ready, 4);
    assert.equal(current.blocked, 4);
    assert.equal(app.observer.state.issues[0].id, 'external-change');
    assert.equal(app.observer.state.issues[0].ready, false);
    assert.equal(app.observer.state.issues[0].blocked, true);

    await advance(1999);
    assert.equal((await counts()).list, 4);
    await advance(1);
    await waitForSnapshot(5, 'live poll after changed snapshot');

    const projectId = app.projects.list()[0].id;
    await new CreateIssue(app.projects).execute(
      projectId,
      'request-id-123456',
      {
        title: 'Write',
        description: '',
        type: 'task',
        priority: 1,
        parent: '',
      },
    );
    current = await waitFor(
      (value) => value.create === 1 && value.list === 6 && snapshots === 6,
      'write-triggered snapshot',
    );
    assert.equal(current.list, 6, 'successful writes refresh immediately');
    assert.equal(app.observer.state.issues[0].id, 'from-write');
    assert.equal(app.observer.state.issues[0].ready, true);
    await advance(1999);
    assert.equal(
      (await counts()).list,
      6,
      'writes also reset the pending poll timer',
    );
    await advance(1);
    await waitForSnapshot(7, 'poll after write');

    await writeFile(failurePath, 'fail next snapshot');
    await advance(3999);
    assert.equal((await counts()).list, 7);
    await advance(1);
    await waitForSnapshot(8, 'failed snapshot');
    await waitFor(() => !!app.observer.state.error, 'visible snapshot error');
    assert.match(
      app.observer.state.error || '',
      /temporary Beads read failure/,
    );
    await advance(1999);
    assert.equal((await counts()).list, 8, 'errors retry at the live cadence');
    await advance(1);
    await waitForSnapshot(9, 'recovered snapshot');
    assert.equal(
      (await counts()).list,
      9,
      'recovery is checked after two seconds',
    );
    assert.equal(app.observer.state.error, null);
  } finally {
    await app.close();
    t.mock.timers.reset();
    await rm(cwd, { recursive: true, force: true });
  }
});
