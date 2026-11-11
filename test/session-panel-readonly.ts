import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Session, SessionResult } from '../web/contracts.js';

type FixtureSession = Session & { time?: { created: number; updated: number } };
type Fixture = Omit<SessionResult, 'sessions'> & { sessions: FixtureSession[] };

const textBlock = (index: number) => ({
  id: `active-a:user:${index}`,
  kind: 'user',
  author: 'unknown',
  text: `Fixture log entry ${index} with enough text to fill the scroll container.`,
});

function initialFixture(): Fixture {
  return {
    available: true,
    sessions: [
      {
        sessionID: 'active-b',
        title: 'Active B',
        status: 'running',
        connected: true,
        time: { created: 100, updated: 1 },
        blocks: [textBlock(0)],
      },
      {
        sessionID: 'history-z',
        title: 'History Z',
        status: 'succeeded',
        connected: false,
        time: { created: 300, updated: 9000 },
        blocks: [
          { id: 'history-z:user', kind: 'user', text: 'History fixture' },
        ],
      },
      {
        sessionID: 'active-a',
        title: 'Active A',
        status: 'streaming',
        connected: true,
        agent: 'build',
        linkSource: 'prompt',
        time: { created: 200, updated: 10 },
        blocks: [
          {
            id: 'active-a:tool:patch-1',
            kind: 'tool',
            name: 'patch',
            status: 'completed',
            text: 'diff output line 1\ndiff output line 2',
          },
          {
            id: 'active-a:reasoning:1',
            kind: 'reasoning',
            text: 'Fixture reasoning, not user data.',
          },
          ...Array.from({ length: 35 }, (_, index) => textBlock(index + 1)),
        ],
        diffs: [
          {
            file: 'src/example.ts',
            additions: 1,
            deletions: 0,
            patch: '@@ -1 +1 @@\n+fixture change',
          },
        ],
      },
    ],
  };
}

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body { font: 14px sans-serif; }
#panel { width: 420px; }
.session-transcript { height: 150px; max-height: 150px; overflow: auto; border: 1px solid #999; }
.session-message { min-height: 52px; padding: 5px; }
.session-record-heading { display: block; }
</style></head><body><main id="panel"></main>
<script type="module">
import { mountSessionPanel } from '/dist/web/sessions.js';
const labels = {
  sessionLog: 'Session log', sessionFollowEnabled: 'Follow new entries on',
  sessionFollowDisabled: 'Follow new entries off', sessionActiveGroup: 'Active',
  sessionHistoryGroup: 'History', sessionOutput: 'Output', sessionLines: 'lines',
  sessionOutputPending: 'Waiting for output', sessionOutputEmpty: 'No output',
  sessionThought: 'Reasoning', sessionDiff: 'Diff', sessionNoDiff: 'No diff',
  sessionScope: 'Linked session', sessionLinkSource: 'Source',
  sessionLink_prompt: 'Prompt', sessionParent: 'Parent',
  sessionConnected: 'Connected', sessionDisconnected: 'Disconnected',
  session_running: 'Running', session_streaming: 'Streaming',
  session_succeeded: 'Succeeded', session_unknown: 'Unknown',
  session_failed: 'Failed', sessionReadUnavailable: 'Read unavailable',
  sessionNotLinked: 'Not linked', sessionLimited: 'Limited',
  sessionAuthorUnknown: 'Message', sessionAuthorHuman: 'Human',
  sessionAuthorAgent: 'Agent', sessionAuthorCoordinator: 'Coordinator',
  sessionAuthorDelegation: 'Delegated', sessionAuthorSystem: 'System',
  sessionAuthorSynthetic: 'Synthetic', sessionLink_manual: 'Manual'
};
const translate = (key) => labels[key] || key;
window.disposePanel = mountSessionPanel(document.querySelector('#panel'), {
  issueId: 'fixture-issue', url: '/api/sessions', t: translate,
  skeleton: () => '<p>Loading fixture</p>'
});
</script></body></html>`;

async function main() {
  let fixture = initialFixture();
  let failReads = false;
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    const path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    if (path === '/api/sessions') {
      if (failReads) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'fixture read failure' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fixture));
      return;
    }
    if (path.startsWith('/dist/web/')) {
      const name = path.slice('/dist/web/'.length);
      if (!['sessions.js', 'dom.js'].includes(name)) {
        response.writeHead(404).end();
        return;
      }
      const source = await readFile(join(process.cwd(), 'dist', 'web', name));
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
      });
      response.end(source);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  const context = await browser.newContext();
  const unsafeRequests: string[] = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method()) || url.origin !== origin) {
      unsafeRequests.push(`${request.method()} ${url.origin}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.goto(origin);
    await page.locator('[data-session-key="active-a"]').waitFor();
    const activeGroup = page.locator('[data-session-group="active"]');
    assert.deepEqual(
      await activeGroup
        .locator('[data-session-key]')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-session-key')),
        ),
      ['active-b', 'active-a'],
    );
    assert.equal(
      await page
        .locator('[data-session-key="active-a"]')
        .evaluate((node) => (node as HTMLDetailsElement).open),
      true,
    );
    assert.equal(
      await page
        .locator('[data-session-key="history-z"]')
        .evaluate((node) => (node as HTMLDetailsElement).open),
      false,
    );

    const follow = page.locator('button[data-session-follow="active-a"]');
    assert.equal(await follow.getAttribute('aria-pressed'), 'true');
    assert.equal((await follow.innerText()).trim(), '');
    assert.equal(
      await follow.getAttribute('aria-label'),
      'Follow new entries on',
    );
    const onIcon = await follow.locator('svg path').getAttribute('d');

    const output = page.locator(
      '[data-session-key="active-a"] .session-tool details',
    );
    await output.locator('summary').click();
    await page
      .locator('[data-session-key="active-a"] .session-thought summary')
      .click();
    await page
      .locator('[data-session-key="active-a"] .session-diffs details summary')
      .click();
    const history = page.locator('[data-session-key="history-z"]');
    await history.locator('summary').click();

    await follow.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () =>
        document
          .querySelector('button[data-session-follow="active-a"]')
          ?.getAttribute('aria-pressed') === 'false',
    );
    assert.notEqual(await follow.locator('svg path').getAttribute('d'), onIcon);
    const transcript = page.locator(
      '.session-transcript[data-session-id="active-a"]',
    );
    await transcript.evaluate((node) => {
      node.scrollTop = 90;
    });
    const savedScroll = await transcript.evaluate((node) => node.scrollTop);
    await page.evaluate(() => window.scrollTo(0, 400));
    const pageScroll = await page.evaluate(() => window.scrollY);

    fixture = {
      ...fixture,
      sessions: [
        { ...fixture.sessions[1], time: { created: 300, updated: 99999 } },
        {
          ...fixture.sessions[0],
          time: { created: 200, updated: 99999 },
          blocks: [...(fixture.sessions[0].blocks || []), textBlock(70)],
        },
        {
          ...fixture.sessions[2],
          status: 'unknown',
          time: { created: 100, updated: 99999 },
          blocks: [
            ...(fixture.sessions[2].blocks || []),
            {
              id: 'active-a:user:new',
              kind: 'user',
              text: 'New fixture entry',
            },
          ],
        },
      ],
    };
    await page.getByText('New fixture entry').waitFor({ timeout: 4000 });
    assert.equal(await follow.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => window.scrollY), pageScroll);
    assert.ok(
      Math.abs(
        (await transcript.evaluate((node) => node.scrollTop)) - savedScroll,
      ) <= 1,
    );
    assert.equal(
      await output.evaluate((node) => (node as HTMLDetailsElement).open),
      true,
    );
    assert.equal(
      await page
        .locator('[data-session-key="active-a"] .session-thought')
        .evaluate((node) => (node as HTMLDetailsElement).open),
      true,
    );
    assert.equal(
      await page
        .locator('[data-session-key="active-a"] .session-diffs details')
        .evaluate((node) => (node as HTMLDetailsElement).open),
      true,
    );
    assert.equal(
      await page
        .locator('[data-session-key="history-z"]')
        .evaluate((node) => (node as HTMLDetailsElement).open),
      true,
    );
    assert.equal(
      await page
        .locator('[data-session-group="active"] [data-session-key="active-a"]')
        .count(),
      1,
      'one inactive status sample must not move an active session to history',
    );

    const otherFollow = page.locator('button[data-session-follow="active-b"]');
    assert.equal(await otherFollow.getAttribute('aria-pressed'), 'true');
    await follow.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () =>
        document
          .querySelector('button[data-session-follow="active-a"]')
          ?.getAttribute('aria-pressed') === 'true',
    );
    assert.equal(
      await transcript.evaluate(
        (node) => node.scrollTop + node.clientHeight === node.scrollHeight,
      ),
      true,
    );
    assert.equal(await otherFollow.getAttribute('aria-pressed'), 'true');

    failReads = true;
    await page.getByText('fixture read failure').waitFor({ timeout: 4000 });
    assert.equal(
      await page.locator('[data-session-key="active-a"]').count(),
      1,
    );
    assert.equal(await page.getByText('New fixture entry').count(), 1);
    assert.equal(
      await page.getByText('Read unavailable: fixture read failure').count(),
      1,
    );
    await page.evaluate(() => {
      const now = Date.now();
      Date.now = () => now + 16000;
    });
    await page
      .locator('[data-session-group="history"] [data-session-key="active-b"]')
      .waitFor({ timeout: 4000 });
    assert.equal(await page.getByText('New fixture entry').count(), 1);
    failReads = false;
    await page
      .locator('[data-session-group="history"] [data-session-key="active-a"]')
      .waitFor({ timeout: 4000 });
    assert.equal(
      await page
        .locator('[data-session-group="active"] [data-session-key="active-a"]')
        .count(),
      0,
      'the backend stale status must eventually move the session out of active',
    );
    assert.deepEqual(unsafeRequests, []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

await main();
