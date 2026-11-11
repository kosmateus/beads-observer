import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  directSessionLink,
  resolveSessionLinks,
} from '../src/domain/session-links.js';
import { readSessionRecords } from '../src/adapters/session-records.js';

const known = new Set(['task-a', 'task-b']);
const tool = (
  name: string,
  input: Record<string, unknown>,
  content: { type: string; text: string }[] = [],
  status = 'completed',
) => ({
  type: 'assistant',
  content: [{ type: 'tool', name, state: { status, input, content } }],
});
const shell = (command: string) => tool('shell', { command });

test('children need their own evidence; remembered parent links are not evidence', () => {
  const sessions = new Map([
    [
      'parent',
      { info: {}, messages: [{ type: 'user', text: 'Pracuj nad task-a.' }] },
    ],
    ['child', { info: { parentID: 'parent' }, messages: [] }],
    [
      'assigned',
      {
        info: { parentID: 'parent' },
        messages: [{ type: 'user', text: 'Twoje zadanie to task-b.' }],
      },
    ],
  ]);
  const links = resolveSessionLinks(
    sessions,
    known,
    new Map(),
    new Map([['child', { issueId: 'task-a', source: 'parent' }]]),
  );
  assert.equal(links.get('parent')?.issueId, 'task-a');
  assert.equal(links.get('child'), null);
  assert.equal(links.get('assigned')?.issueId, 'task-b');
});

test('manual assignment wins, and remembered direct evidence survives compaction', () => {
  const sessions = new Map([['s', { info: {}, messages: [] }]]);
  const remembered = new Map([
    ['s', { issueId: 'task-a', source: 'beads-command' }],
  ]);
  assert.equal(
    resolveSessionLinks(sessions, known, new Map(), remembered).get('s')
      ?.issueId,
    'task-a',
  );
  assert.equal(
    resolveSessionLinks(
      sessions,
      known,
      new Map([['s', ['task-b']]]),
      remembered,
    ).get('s')?.issueId,
    'task-b',
  );
});

test('latest real command changes task and ambiguous evidence cancels remembered selection', () => {
  assert.deepEqual(
    directSessionLink(
      [shell('bd show task-a'), shell('bd update task-b --claim')],
      known,
    ),
    { ids: ['task-b'], source: 'beads-command' },
  );
  const sessions = new Map([
    [
      's',
      {
        info: {},
        messages: [{ type: 'user', text: 'Porównaj task-a i task-b.' }],
      },
    ],
  ]);
  assert.deepEqual(
    resolveSessionLinks(
      sessions,
      known,
      new Map(),
      new Map([['s', { issueId: 'task-a', source: 'prompt' }]]),
    ).get('s'),
    { ambiguous: true, source: 'prompt' },
  );
});

test('shell commands handle quoted separators, comments, flags and explicit IDs', () => {
  for (const command of [
    'cd /project && bd update task-a --claim',
    'bd update --claim task-a',
    'LANG=C /usr/bin/bd --json show task-a',
    'bd show --id task-a',
    'bd show --id=task-a',
    'bd update task-a --notes "now; bd show task-b"',
    "bd update task-a --notes 'now && bd show task-b'",
    'bd show task-a # bd show task-b',
  ])
    assert.deepEqual(
      directSessionLink([shell(command)], known)?.ids,
      ['task-a'],
      command,
    );
});

test('output, descriptions, non-shell input and quoted examples never become command evidence', () => {
  for (const message of [
    tool('read', { command: 'bd show task-a' }, [
      { type: 'text', text: 'task-b' },
    ]),
    shell('echo "bd show task-a; bd show task-b"'),
    shell('bd update unknown --notes task-a'),
    shell('cat <<EOF\nbd show task-a\nEOF'),
    shell('echo $(printf x; bd show task-a)'),
    shell('echo `printf x; bd show task-a`'),
    tool('shell', { command: 'bd list' }, [{ type: 'text', text: 'task-a' }]),
    { type: 'assistant', content: [{ type: 'text', text: 'task-a' }] },
    {
      type: 'shell',
      command: 'bd list',
      status: 'exited',
      output: { output: 'task-a' },
    },
    tool('shell', { command: 'bd show task-a' }, [], 'error'),
  ])
    assert.equal(
      directSessionLink([message], known),
      null,
      JSON.stringify(message),
    );
});

test('native shell messages and structured Beads inputs provide evidence', () => {
  assert.deepEqual(
    directSessionLink(
      [{ type: 'shell', command: 'bd show task-b', status: 'exited', exit: 0 }],
      known,
    )?.ids,
    ['task-b'],
  );
  assert.deepEqual(
    directSessionLink([tool('beads.show', { issue_id: 'task-a' })], known),
    { ids: ['task-a'], source: 'beads-tool' },
  );
  assert.equal(
    directSessionLink(
      [tool('beads.list', {}, [{ type: 'text', text: 'task-a' }])],
      known,
    ),
    null,
  );
});

test('execute recognizes literal shell calls, not code strings, comments or output', () => {
  for (const code of [
    'return await tools.shell({command:"bd show task-a"});',
    "await tools['shell']({command:'bd update task-a --claim'});",
    'await tools.functions.shell({command:`bd show task-a`});',
    'await Promise.all([tools.shell({command:"bd show task-b"}),tools.shell({command:"bd show task-a"})]);',
  ])
    assert.deepEqual(
      directSessionLink([tool('execute', { code })], known)?.ids,
      ['task-a'],
      code,
    );
  for (const code of [
    'return "tools.shell({command: \'bd show task-a\'})";',
    '// tools.shell({command:"bd show task-a"})\nreturn null;',
    '/* tools.shell({command:"bd show task-a"}) */ return null;',
    'return await tools.read({command:"bd show task-a"});',
    'return await tools.shell({command:`bd show ${issue}`});',
    'return await tools.shell({command:"bd show task-a" + suffix});',
  ])
    assert.equal(
      directSessionLink(
        [tool('execute', { code }, [{ type: 'text', text: 'task-a' }])],
        known,
      ),
      null,
      code,
    );
});

async function recordsFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'observer-records-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = {
    projectId: 'p',
    sessionID: 's',
    issueIds: ['task-a'],
    activeIssueId: 'task-a',
    connected: true,
    status: 'running',
    updatedAt: Date.now(),
  };
  const put = (name: string, value: Record<string, unknown>) =>
    writeFile(
      join(directory, `session-p-${name}.json`),
      JSON.stringify({ ...record, ...value }),
    );
  return { directory, record, put };
}

test('records deduplicate before issue filtering, so an obsolete host cannot resurrect a link', async (t) => {
  const { directory, record, put } = await recordsFixture(t);
  await put('old', { updatedAt: record.updatedAt - 1000 });
  await put('new', { issueIds: ['task-b'], activeIssueId: 'task-b' });
  assert.deepEqual(await readSessionRecords(directory, 'p', 'task-a'), []);
  const selected = await readSessionRecords(directory, 'p', 'task-b');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].activeIssueId, 'task-b');
});

test('disconnected or expired records never report live running/streaming activity', async (t) => {
  const { directory, record, put } = await recordsFixture(t);
  await put('stale', {
    sessionID: 'stale',
    updatedAt: record.updatedAt - 16000,
  });
  await put('future', {
    sessionID: 'future',
    updatedAt: record.updatedAt + 60000,
  });
  await put('offline', {
    sessionID: 'offline',
    connected: false,
    status: 'streaming',
  });
  await put('done', {
    sessionID: 'done',
    connected: false,
    status: 'succeeded',
  });
  await put('live', { sessionID: 'live' });
  const result = new Map(
    (await readSessionRecords(directory, 'p')).map((r) => [r.sessionID, r]),
  );
  for (const id of ['stale', 'future', 'offline']) {
    assert.equal(result.get(id)?.connected, false);
    assert.equal(result.get(id)?.status, 'unknown');
  }
  assert.equal(result.get('done')?.status, 'succeeded');
  assert.equal(result.get('live')?.connected, true);
  assert.equal(result.get('live')?.status, 'running');
});

test('same-timestamp offline record wins and TTL is reevaluated on cache hits', async (t) => {
  const { directory, record, put } = await recordsFixture(t);
  await put('a', { connected: false });
  await put('z', {});
  assert.equal((await readSessionRecords(directory, 'p'))[0].connected, false);
  await put('live', { sessionID: 'live' });
  assert.equal(
    (await readSessionRecords(directory, 'p')).find(
      (r) => r.sessionID === 'live',
    )?.connected,
    true,
  );
  const realNow = Date.now;
  Date.now = () => record.updatedAt + 15000;
  try {
    const expired = (await readSessionRecords(directory, 'p')).find(
      (r) => r.sessionID === 'live',
    );
    assert.equal(expired?.connected, false);
    assert.equal(expired?.status, 'unknown');
  } finally {
    Date.now = realNow;
  }
});

test('all matching files are considered, including records beyond the first 200', async (t) => {
  const { directory, put } = await recordsFixture(t);
  await Promise.all(
    Array.from({ length: 205 }, (_, i) =>
      put(String(i).padStart(3, '0'), { sessionID: 's' + i }),
    ),
  );
  assert.equal((await readSessionRecords(directory, 'p')).length, 205);
});

test('malformed and unrelated records are ignored, and a missing directory is harmless', async (t) => {
  const { directory, put } = await recordsFixture(t);
  await put('wrong', { projectId: 'other' });
  await put('invalid', { updatedAt: 'now' });
  await put('no-session', { sessionID: null });
  await writeFile(join(directory, 'session-p-broken.json'), '{');
  assert.deepEqual(await readSessionRecords(directory, 'p'), []);
  assert.deepEqual(
    await readSessionRecords(join(directory, 'missing'), 'p'),
    [],
  );
});
