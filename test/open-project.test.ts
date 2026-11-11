import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectCommand } from '../src/application/open-project.js';
import { sessionNotification } from '../src/adapters/opencode-notification.js';

test('notifies the OpenCode session when no browser can open the board', async () => {
  const notifications: { sessionID: string; text: string }[] = [];
  const command = projectCommand({
    location: async () => undefined,
    url: 'http://127.0.0.1:4317',
    projectId: 'example',
    open: async (url) => ({
      opened: false,
      url,
      message: `No browser could be opened here. Open this URL manually: ${url}`,
    }),
    notify: async (sessionID, text) => {
      notifications.push({ sessionID, text });
    },
  });

  await command.execute({ sessionID: 'session-1', prompt: { text: '' } });

  assert.deepEqual(notifications, [
    {
      sessionID: 'session-1',
      text: 'No browser could be opened here. Open this URL manually: http://127.0.0.1:4317/projects/example/board',
    },
  ]);
});

test('does not notify when the browser opens successfully', async () => {
  let notified = false;
  const command = projectCommand({
    location: async () => undefined,
    url: 'http://127.0.0.1:4317',
    projectId: 'example',
    open: async (url) => ({ opened: true, url }),
    notify: async () => {
      notified = true;
    },
  });

  await command.execute({ sessionID: 'session-1', prompt: { text: '' } });

  assert.equal(notified, false);
});

test('delivers fallback text with resume false and never prompts the model', async () => {
  let received:
    | {
        sessionID: string;
        text: string;
        description: string;
        resume: false;
      }
    | undefined;
  let prompted = false;
  const session: Parameters<typeof sessionNotification>[0] & {
    prompt: () => Promise<void>;
  } = {
    synthetic: async (input) => {
      received = input;
    },
    prompt: async () => {
      prompted = true;
    },
  };
  const notify = sessionNotification(session);

  await notify(
    'session-1',
    'No browser could be opened here. Open this URL manually: http://127.0.0.1:4317/projects/example/board',
  );

  assert.deepEqual(received, {
    sessionID: 'session-1',
    text: 'No browser could be opened here. Open this URL manually: http://127.0.0.1:4317/projects/example/board',
    description: 'Beads Observer browser URL',
    resume: false,
  });
  assert.equal(prompted, false);
});

test('keeps unresolved locations and issue binding failures as errors', async () => {
  const locationFailure = projectCommand({
    location: async () => {
      throw new Error('Beads database not found');
    },
    url: 'http://127.0.0.1:4317',
    projectId: 'example',
    open: async (url) => ({ opened: true, url }),
    notify: async () => undefined,
  });
  await assert.rejects(
    locationFailure.execute({ sessionID: 'session-1' }),
    /Beads database not found/,
  );

  const bindFailure = projectCommand({
    location: async () => undefined,
    url: 'http://127.0.0.1:4317',
    projectId: 'example',
    open: async (url) => ({ opened: true, url }),
    notify: async () => undefined,
    bind: async () => {
      throw new Error('Issue not found');
    },
  });
  await assert.rejects(
    bindFailure.execute({ sessionID: 'session-1', prompt: { text: 'bd-1' } }),
    /Issue not found/,
  );
});
