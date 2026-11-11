import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readActivityAvailability, listenHttp } from '../src/adapters/http.js';
import { renderSessions } from '../web/sessions.js';

test('bridge availability is fresh, project-scoped and never follows symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'observer-activity-'));
  const file = join(directory, 'bridge-project-host.json');
  const bridge = (overrides) =>
    writeFile(
      file,
      JSON.stringify({
        projectId: 'project',
        updatedAt: Date.now(),
        connected: true,
        activityAvailable: true,
        warnings: [],
        ...overrides,
      }),
    );
  try {
    assert.deepEqual(await readActivityAvailability(directory, 'project'), {
      available: false,
      warnings: [],
    });
    await bridge({});
    assert.equal(
      (await readActivityAvailability(directory, 'project')).available,
      true,
    );
    for (const invalid of [
      { updatedAt: Date.now() - 16000 },
      { updatedAt: Date.now() + 60000 },
      { projectId: 'other' },
      { connected: false },
      { activityAvailable: false },
    ]) {
      await bridge(invalid);
      assert.equal(
        (await readActivityAvailability(directory, 'project')).available,
        false,
      );
    }
    await bridge({ warnings: ['limited', 'limited', 42] });
    assert.deepEqual(
      (await readActivityAvailability(directory, 'project')).warnings,
      ['limited'],
    );
    await rm(file);
    const target = join(directory, 'target.json');
    await writeFile(
      target,
      JSON.stringify({
        projectId: 'project',
        updatedAt: Date.now(),
        connected: true,
        activityAvailable: true,
      }),
    );
    await symlink(target, file);
    assert.equal(
      (await readActivityAvailability(directory, 'project')).available,
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP summary separates availability from activity and excludes disconnected sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'observer-activity-'));
  let http;
  try {
    const bridge = join(directory, 'bridge-project-host.json');
    await writeFile(
      bridge,
      JSON.stringify({
        projectId: 'project',
        updatedAt: Date.now(),
        connected: true,
        activityAvailable: true,
        warnings: [],
      }),
    );
    const record = {
      projectId: 'project',
      updatedAt: Date.now(),
      sessionID: 'ses-active',
      connected: true,
      status: 'running',
      agent: 'build',
      activeIssueId: 'task-1',
      issueIds: ['task-1'],
    };
    await writeFile(
      join(directory, 'session-project-active.json'),
      JSON.stringify(record),
    );
    await writeFile(
      join(directory, 'session-project-disconnected.json'),
      JSON.stringify({
        ...record,
        sessionID: 'ses-disconnected',
        connected: false,
      }),
    );
    const project = {
      id: 'project',
      observer: { state: { issues: [{ id: 'task-1' }] } },
    };
    http = await listenHttp(
      { get: () => project, subscribe: () => () => {} },
      { port: 0, sessionDirectory: directory },
    );
    const get = (query) =>
      fetch(http.url + '/api/projects/project/sessions' + query).then((r) =>
        r.json(),
      );
    assert.deepEqual(await get('?summary=1'), {
      activity: { 'task-1': [{ agent: 'build', sessionID: 'ses-active' }] },
      available: true,
      warnings: [],
    });
    await rm(bridge);
    assert.deepEqual(await get('?summary=1'), {
      activity: {},
      available: false,
      warnings: [],
    });
    const detail = await get('?issue=task-1');
    assert.equal(detail.available, false);
    assert.equal(
      detail.sessions.find((s) => s.sessionID === 'ses-disconnected').status,
      'unknown',
    );
  } finally {
    await http?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('session panel does not claim missing links when activity reads are unavailable', () => {
  const t = (key) => key;
  assert.equal(
    renderSessions([], t, 'task-1', { available: false }),
    '<p class="muted">sessionReadUnavailable</p>',
  );
  assert.match(
    renderSessions([], t, 'task-1', { available: true }),
    /sessionNotLinked/,
  );
  assert.doesNotMatch(
    renderSessions([], t, 'task-1', { warnings: ['<script>'] }),
    /<script>/,
  );
});
