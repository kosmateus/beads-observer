import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeadsSource } from '../src/adapters/beads-cli.js';

test('concurrent snapshots share one read cycle and validate their pinned location once', async () => {
  const source = new BeadsSource({
    cwd: '/project',
    beadsLocation: '/project/.beads',
  });
  const commands: string[] = [];
  let locationReads = 0;
  source.location = async () => {
    locationReads++;
    return { path: '/project/.beads' };
  };
  source.run = async <T = Record<string, unknown>>(args: string[]) => {
    commands.push(args[0]!);
    if (args[0] === 'list')
      return [{ id: 'task-1', title: 'Task', status: 'open' }] as T;
    if (args[0] === 'ready') return ['task-1'] as T;
    if (args[0] === 'blocked') return [] as T;
    throw new Error(`Unexpected Beads command: ${args[0]}`);
  };
  source.version = async () => '0.17.1';

  const firstRequest = source.snapshot();
  const secondRequest = source.snapshot();
  const [first, second] = await Promise.all([firstRequest, secondRequest]);

  assert.deepEqual(commands.sort(), ['blocked', 'list', 'ready']);
  assert.equal(locationReads, 1);
  assert.strictEqual(secondRequest, firstRequest);
  assert.strictEqual(second, first);
  assert.equal(first.issues[0]?.ready, true);
  assert.equal(first.location.path, '/project/.beads');
});

test('a failed shared snapshot can be retried without retaining stale work', async () => {
  const source = new BeadsSource({
    cwd: '/project',
    beadsLocation: '/project/.beads',
  });
  let listReads = 0;
  source.location = async () => ({ path: '/project/.beads' });
  source.run = async <T = Record<string, unknown>>(args: string[]) => {
    if (args[0] === 'list' && listReads++ === 0)
      throw new Error('temporary read failure');
    if (args[0] === 'list') return [{ id: 'task-1' }] as T;
    if (args[0] === 'ready') return ['task-1'] as T;
    return [] as T;
  };
  source.version = async () => null;

  await assert.rejects(source.snapshot(), /temporary read failure/);
  const retry = await source.snapshot();

  assert.equal(listReads, 2);
  assert.equal(retry.issues[0]?.id, 'task-1');
});

test('completed snapshots are reread so later Beads changes stay fresh', async () => {
  const source = new BeadsSource({
    cwd: '/project',
    beadsLocation: '/project/.beads',
  });
  let title = 'Initial';
  let listReads = 0;
  source.location = async () => ({ path: '/project/.beads' });
  source.run = async <T = Record<string, unknown>>(args: string[]) => {
    if (args[0] === 'list') {
      listReads++;
      return [{ id: 'task-1', title }] as T;
    }
    if (args[0] === 'ready') return ['task-1'] as T;
    return [] as T;
  };
  source.version = async () => null;

  const first = await source.snapshot();
  title = 'Changed';
  const second = await source.snapshot();

  assert.equal(first.issues[0]?.title, 'Initial');
  assert.equal(second.issues[0]?.title, 'Changed');
  assert.equal(listReads, 2);
});
