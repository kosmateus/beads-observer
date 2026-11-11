// Opt-in integration assertions against a PRIVATE OpenCode 2.1.3 instance.
// Fixture: git+Beads project and linked worktree, isolated XDG directories,
// Observer configured with a private hub port and a local streaming provider.
// The provider must turn SPAWN_CHILDREN into three real subagent calls with
// background:true, prompts for LIVE_TASKS[1,2,0], and HOLD/HOLD_LONG delays.
// No service discovery, global installation, credentials, or daemon restart.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface LiveSession {
  id: string;
  title: string;
}
interface LiveDiff {
  file: string;
  patch: string;
}
interface LiveRecord {
  connected: boolean;
  sessionID: string;
  status: string;
  parentSessionID?: string;
  activeIssueId?: string;
  warnings: string[];
  issueIds: string[];
  projectId: string;
  diffs: LiveDiff[];
}
interface LiveMessage {
  type: string;
  content: { name?: string; state: { input: { background?: boolean } } }[];
}
interface LiveEvent {
  type: string;
  data: { sessionID: string };
}

const root = process.env.LIVE_ROOT || '/tmp/opencode/observer-live-test';
const base = process.env.LIVE_URL || 'http://127.0.0.1:44328';
const hub =
  process.env.LIVE_HUB ||
  join(root, `hub/beads-observer-${process.getuid?.() ?? 'user'}-v1-44327`);
const tasks = (process.env.LIVE_TASKS || 'live-3rg,live-39o,live-7yn').split(
  ',',
);
assert(process.env.LIVE_PASSWORD, 'Set LIVE_PASSWORD for your private server');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization:
        'Basic ' +
        Buffer.from('opencode:' + process.env.LIVE_PASSWORD).toString('base64'),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert(response.ok, response.status + ' ' + path + ': ' + text);
  return JSON.parse(text || 'null') as T;
}
async function records() {
  const files = (await readdir(hub)).filter(
    (x) => x.startsWith('session-') && x.endsWith('.json'),
  );
  const all = await Promise.all(
    files.map(async (x): Promise<LiveRecord> =>
      JSON.parse(await readFile(join(hub, x), 'utf8')),
    ),
  );
  return all.filter((x) => x.connected);
}
async function until<T>(
  label: string,
  predicate: () => Promise<T | false>,
  timeout = 45000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await predicate();
    if (result) {
      console.log('PASS', label);
      return result;
    }
    await sleep(250);
  }
  throw Error('Timed out: ' + label);
}
const create = async (directory: string, title: string) =>
  (
    await api<{ data: LiveSession }>('/api/session', {
      location: { directory },
      title,
    })
  ).data;
const prompt = (id: string, text: string) =>
  api(`/api/session/${id}/prompt`, { text });
const info = await api<{ version: string; pid: number }>('/api/info');
assert.equal(info.version, '2.1.3');
const parent = await create(
  join(root, 'project'),
  'Automated background integration',
);
await prompt(parent.id, `Work only on ${tasks[0]}. SPAWN_CHILDREN`);
const probe = await until('private plugin loaded', async () => {
  const value: { pid: number; sessionKeys: string[] } = JSON.parse(
    await readFile(join(root, 'context.json'), 'utf8'),
  );
  return value.pid === info.pid && value;
});
assert(!probe.sessionKeys.includes('active'));
assert(!probe.sessionKeys.includes('diff'));
console.log(
  'PASS real Context omits active/diff and process matches private API',
);
const children = await until(
  'three actual background children with idle parent',
  async () => {
    const active = (
      await api<{ data: Record<string, unknown> }>('/api/session/active')
    ).data;
    const children = (
      await api<{ data: LiveSession[] }>('/api/session?parentID=' + parent.id)
    ).data;
    return (
      children.length === 3 &&
      !active[parent.id] &&
      children.every((x) => active[x.id]) &&
      children
    );
  },
);
const taskFor = (child: LiveSession) => {
  const suffix = child.title.at(-1);
  assert(suffix === 'A' || suffix === 'B' || suffix === 'C');
  return tasks[{ A: 1, B: 2, C: 0 }[suffix]];
};
await until('all children linked to their own tasks, no warnings', async () => {
  const all = await records();
  return children.every((child) =>
    all.some(
      (r) =>
        r.sessionID === child.id &&
        r.status === 'running' &&
        r.parentSessionID === parent.id &&
        r.activeIssueId === taskFor(child) &&
        !r.warnings.length,
    ),
  );
});
const childB = children.find((x) => x.title.endsWith('B'));
assert.ok(childB);
assert.equal(
  (
    await api<{ interrupted: boolean }>(`/api/session/${childB.id}/interrupt`, {
      resume: false,
    })
  ).interrupted,
  true,
);
await until('interrupt clears running state', async () =>
  (await records()).some(
    (r) => r.sessionID === childB.id && r.status === 'interrupted',
  ),
);
await prompt(parent.id, 'Switch current work to ' + tasks[1]);
await until('task switch retains old task history', async () =>
  (await records()).some(
    (r) =>
      r.sessionID === parent.id &&
      r.activeIssueId === tasks[1] &&
      r.issueIds.includes(tasks[0]) &&
      r.issueIds.includes(tasks[1]),
  ),
);
const foreign = await create(join(root, 'other'), 'Foreign project');
await api(`/api/session/${foreign.id}/prompt`, {
  text: 'Mention ' + tasks[0],
  resume: false,
});
const wt = await create(join(root, 'worktree'), 'Same Beads worktree');
await prompt(wt.id, 'Work only on ' + tasks[2]);
await until('shared Beads worktree included', async () =>
  (await records()).some(
    (r) => r.sessionID === wt.id && r.activeIssueId === tasks[2],
  ),
);
await until('natural completion of remaining children', async () => {
  const all = await records();
  return children
    .filter((c) => c.id !== childB.id)
    .every((c) =>
      all.some((r) => r.sessionID === c.id && r.status === 'succeeded'),
    );
});
const all = await records();
const parentRecord = all.find((r) => r.sessionID === parent.id);
assert.ok(parentRecord);
const projectID = parentRecord.projectId;
assert(
  !all.some((r) => r.sessionID === foreign.id && r.projectId === projectID),
);
assert.equal(all.find((r) => r.sessionID === wt.id)?.projectId, projectID);
console.log(
  'PASS other project excluded; shared worktree has same Observer project',
);
const context = await api<{ data: LiveMessage[] }>(
  `/api/session/${parent.id}/context`,
);
const get = await api<{ data: LiveSession }>(`/api/session/${parent.id}`);
assert(Array.isArray(context.data));
assert.equal(get.data.id, parent.id);
assert(
  context.data.some(
    (m) =>
      m.type === 'assistant' &&
      m.content.some(
        (p) => p.name === 'subagent' && p.state.input.background === true,
      ),
  ),
);
console.log(
  'PASS actual context {data}, native subagent tool inputs background:true',
);
const diffSession = await create(join(root, 'project'), 'Live snapshot diff');
await prompt(diffSession.id, `Work only on ${tasks[0]}. MAKE_DIFF`);
await until('real model tool call creates nonempty snapshot diff', async () => {
  const record = (await records()).find((r) => r.sessionID === diffSession.id);
  return (
    record?.status === 'succeeded' &&
    record.diffs.some(
      (d) =>
        d.file.endsWith('live-diff.txt') &&
        d.patch.includes('live integration diff'),
    )
  );
});
const directDiff = await api<{ data: LiveDiff[] }>(
  `/api/session/${diffSession.id}/diff?context=3`,
);
assert(directDiff.data.some((d) => d.file.endsWith('live-diff.txt')));
console.log('PASS HTTP diff fallback agrees with Observer record');
const events = (await readFile(join(root, 'events.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((line): LiveEvent => {
    const event = JSON.parse(line);
    return typeof event === 'string' ? JSON.parse(event) : event;
  });
assert(
  events.some(
    (e) => e.type === 'session.tool.called' && e.data.sessionID === parent.id,
  ),
);
assert(
  events.some(
    (e) =>
      e.type === 'session.execution.interrupted' &&
      e.data.sessionID === childB.id,
  ),
);
assert(
  events.some(
    (e) =>
      e.type === 'session.execution.succeeded' &&
      children.some((c) => c.id === e.data.sessionID),
  ),
);
console.log('PASS real session tool/interrupt/completion events received');
await writeFile(
  join(root, 'assertions-result.json'),
  JSON.stringify(
    {
      info,
      parent: parent.id,
      children: children.map((c) => c.id),
      foreign: foreign.id,
      worktree: wt.id,
      diffSession: diffSession.id,
      directDiff: directDiff.data,
      checkedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log('PASS all live assertions');
