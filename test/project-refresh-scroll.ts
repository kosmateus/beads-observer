// Opt-in local browser regression check; uses only in-memory DemoSource data.
// Run with: node dist/test/project-refresh-scroll.js
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { DemoSource, demoIssues } from '../src/adapters/demo.js';
import { startServer } from '../src/bootstrap/server.js';
import { normalize } from '../src/domain/model.js';

const root = await mkdtemp(join(tmpdir(), 'observer-refresh-scroll-'));
const source = new DemoSource();
source.issues = Array.from({ length: 120 }, (_, index) => ({
  ...demoIssues()[4],
  id: `scroll-${String(index).padStart(3, '0')}`,
  title: `Scroll fixture ${index}`,
  assignee: `agent/member-${String(index).padStart(3, '0')}`,
  dependencies: [],
}));
source.events = new Map(source.issues.map((issue) => [issue.id, []]));
source.snapshot = async () => normalize(structuredClone(source.issues), [], []);

const projects = await Promise.all(
  Array.from({ length: 20 }, async (_, index) => {
    const cwd = join(root, `project-${String(index).padStart(2, '0')}`);
    await mkdir(cwd);
    return {
      cwd,
      project: `Project fixture ${String(index).padStart(2, '0')}`,
      source,
      pollIntervalMs: 3600000,
    };
  }),
);

let server: Awaited<ReturnType<typeof startServer>> | undefined;
let browser: Browser | undefined;
try {
  server = await startServer({
    port: 0,
    projects,
    sessionDirectory: join(root, 'no-sessions'),
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const forbidden: string[] = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) {
      forbidden.push(`${request.method()} ${new URL(request.url()).pathname}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.locator('#content [data-issue]').first().waitFor();
  await page.locator('[data-select="project-select"]').click();
  const popup = page.locator('#select-menu');
  await popup.waitFor({ state: 'visible' });
  const before = await popup.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  assert(before > 0, 'project picker fixture must have a scrollable menu');

  const projectId = await page.locator('#project-select').inputValue();
  const previousFooter = await page.locator('#footer-count').textContent();
  const updated = page.waitForFunction(
    (value) => document.querySelector('#footer-count')?.textContent !== value,
    previousFooter,
  );
  source.issues[0].notes = 'Updated in-memory fixture';
  await server.projects.get(projectId).observer.refresh();
  await updated;

  assert.equal(
    await page
      .locator('[data-select="project-select"]')
      .getAttribute('aria-expanded'),
    'true',
    'project picker should remain open during an SSE catalog refresh',
  );
  const after = await popup.evaluate((element) => element.scrollTop);
  assert(
    after >= before - 2,
    `project picker jumped after an SSE catalog refresh: ${before} -> ${after}`,
  );

  await page.keyboard.press('Escape');
  await page.locator('[data-view="list"]').click();
  const view = page.locator('#content > .view-scroll');
  await page.waitForFunction(() => {
    const element = document.querySelector('#content > .view-scroll');
    return !!element && element.scrollHeight > element.clientHeight;
  });
  const viewBefore = await view.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  const footerBefore = await page.locator('#footer-count').textContent();
  const viewUpdated = page.waitForFunction(
    (value) => document.querySelector('#footer-count')?.textContent !== value,
    footerBefore,
  );
  source.issues[1].notes = 'Second in-memory fixture update';
  await server.projects.get(projectId).observer.refresh();
  await viewUpdated;
  const viewAfter = await view.evaluate((element) => element.scrollTop);
  assert(
    viewAfter >= viewBefore - 2,
    `page scroll changed after an SSE snapshot: ${viewBefore} -> ${viewAfter}`,
  );
  assert.deepEqual(forbidden, [], 'browser must not send write requests');
  await context.close();
  console.log(
    `PASS SSE preserved project-menu scroll (${before} -> ${after}) and page scroll (${viewBefore} -> ${viewAfter})`,
  );
} finally {
  await browser?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
