import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionView } from '../src/domain/session-view.js';
import { renderSessions } from '../web/sessions.js';
import type { Session } from '../web/contracts.js';
import type { SessionMessage } from '../src/types.js';

interface TestMessage extends SessionMessage {
  metadata?: Record<string, unknown>;
  agent?: string;
}

const translate = (key: string) => key;

function author(block: object) {
  return 'author' in block && typeof block.author === 'string'
    ? block.author
    : undefined;
}

function record(
  sessionID: string,
  status: string,
  values: Partial<Session> = {},
): Session {
  return {
    sessionID,
    title: sessionID,
    status,
    ...values,
  };
}

test('session view orders timestamped messages oldest first without guessing from text', () => {
  const view = sessionView(
    { id: 'session-a' },
    [
      {
        id: 'newer',
        type: 'user',
        text: 'quoted delegation text',
        time: { created: 200 },
      },
      {
        id: 'older',
        type: 'user',
        text: 'earlier user message',
        time: { created: 100 },
      },
    ],
    false,
    [],
  );

  assert.deepEqual(
    view.blocks.map((block) => block.text),
    ['earlier user message', 'quoted delegation text'],
  );
  assert.deepEqual(view.blocks.map(author), ['unknown', 'unknown']);
  const untimestamped = sessionView(
    { id: 'session-b' },
    [
      { type: 'user', text: 'first from the API' },
      { type: 'user', text: 'second from the API' },
    ],
    false,
    [],
  );
  assert.deepEqual(
    untimestamped.blocks.map((block) => block.text),
    ['first from the API', 'second from the API'],
  );
  const partiallyTimestamped = sessionView(
    { id: 'session-c' },
    [
      { type: 'user', text: 'later', time: { created: 200 } },
      { type: 'user', text: 'time not exposed' },
      { type: 'user', text: 'earlier', time: { created: 100 } },
    ],
    false,
    [],
  );
  assert.deepEqual(
    partiallyTimestamped.blocks.map((block) => block.text),
    ['earlier', 'time not exposed', 'later'],
  );
});

test('session view attributes messages only from explicit origin metadata', () => {
  const messages: TestMessage[] = [
    {
      type: 'user',
      text: 'The word delegate appears in this human note.',
      metadata: { origin: 'human' },
    },
    { type: 'user', text: 'coordinator', metadata: { origin: 'coordinator' } },
    { type: 'user', text: 'agent', metadata: { origin: 'agent' } },
    { type: 'user', text: 'delegated', metadata: { origin: 'delegation' } },
    { type: 'user', text: 'unknown' },
    { type: 'system', text: 'system context' },
    { type: 'synthetic', text: 'synthetic context' },
    {
      type: 'assistant',
      agent: 'build',
      content: [{ type: 'text', text: 'agent response' }],
    },
    {
      type: 'assistant',
      content: [{ type: 'text', text: 'unattributed assistant context' }],
    },
  ];
  const view = sessionView({ id: 'session-a' }, messages, false, []);

  assert.deepEqual(view.blocks.map(author), [
    'human',
    'coordinator',
    'agent',
    'delegation',
    'unknown',
    'system',
    'synthetic',
    'agent',
    'unknown',
  ]);
});

test('session view gives blocks without native IDs deterministic session-scoped keys', () => {
  const messages: TestMessage[] = [
    {
      type: 'assistant',
      time: { created: 100 },
      content: [
        { type: 'reasoning', text: 'thinking' },
        {
          type: 'tool',
          name: 'patch',
          state: { status: 'running', input: {} },
        },
      ],
    },
  ];
  const first = sessionView({ id: 'session-a' }, messages, true, []);
  const repeated = sessionView({ id: 'session-a' }, messages, true, []);
  const otherSession = sessionView({ id: 'session-b' }, messages, true, []);

  assert.deepEqual(
    first.blocks.map((block) => block.id),
    repeated.blocks.map((block) => block.id),
  );
  assert.equal(new Set(first.blocks.map((block) => block.id)).size, 2);
  assert.ok(first.blocks.every((block) => block.id?.startsWith('session-a:')));
  assert.ok(
    otherSession.blocks.every((block) => block.id?.startsWith('session-b:')),
  );

  const timestamped: TestMessage[] = [
    {
      type: 'assistant',
      time: { created: 200 },
      content: [{ type: 'reasoning', text: 'later' }],
    },
    {
      type: 'assistant',
      time: { created: 100 },
      content: [{ type: 'reasoning', text: 'earlier' }],
    },
  ];
  const inOneOrder = sessionView({ id: 'session-c' }, timestamped, true, []);
  const inAnotherOrder = sessionView(
    { id: 'session-c' },
    [...timestamped].reverse(),
    true,
    [],
  );
  assert.deepEqual(
    inOneOrder.blocks.map((block) => block.id),
    inAnotherOrder.blocks.map((block) => block.id),
  );
});

test('session panel groups active sessions first and orders each group by stable session ID', () => {
  const html = renderSessions(
    [
      record('history-z', 'succeeded'),
      record('active-z', 'running'),
      record('history-a', 'failed'),
      record('active-a', 'streaming'),
    ],
    translate,
    'issue-a',
  );
  const activeGroup = html.indexOf('data-session-group="active"');
  const historyGroup = html.indexOf('data-session-group="history"');

  assert.ok(activeGroup >= 0 && historyGroup > activeGroup);
  assert.ok(
    html.indexOf('data-session-key="active-a"') <
      html.indexOf('data-session-key="active-z"'),
  );
  assert.ok(
    html.indexOf('data-session-key="history-a"') <
      html.indexOf('data-session-key="history-z"'),
  );
  assert.match(html, /data-session-key="active-a" open/);
  assert.match(html, /data-session-key="history-a"/);
  assert.doesNotMatch(html, /data-session-key="history-a" open/);
});

test('empty receiving output is a pending placeholder, not one fake output line', () => {
  const html = renderSessions(
    [
      record('active-a', 'running', {
        blocks: [
          {
            id: 'session-a:tool:one',
            kind: 'tool',
            name: 'patch',
            status: 'running',
            text: '',
          },
        ],
      }),
    ],
    translate,
    'issue-a',
  );

  assert.match(html, /sessionOutputPending/);
  assert.doesNotMatch(html, /sessionLines/);
  assert.doesNotMatch(html, /class="session-tail"/);
  assert.match(html, /aria-label="sessionFollowEnabled"/);
  assert.match(html, /aria-pressed="true"/);
});
