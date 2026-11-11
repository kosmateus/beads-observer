// Opt-in live browser probe. It uses a fresh context and permits only GET/HEAD
// on the Observer origin. No write controls are clicked and no profile is reused.
// Run with: node dist/test/browser-readonly.js
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { Project } from '../web/contracts.js';

interface BrowserProbe extends Window {
  __observerSSECount?: number;
  __replayObserverCatalog?: () => void;
  __replayObserverSnapshot?: () => void;
}

const baseURL = process.env.OBSERVER_URL || 'http://127.0.0.1:4317';
const origin = new URL(baseURL).origin;
assert(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname),
  'OBSERVER_URL must use a loopback host',
);
const healthResponse = await fetch(origin + '/api/health');
assert.equal(
  healthResponse.status,
  200,
  'Observer health endpoint is unavailable',
);
const health: { application: string; version: string } =
  await healthResponse.json();
assert.equal(health.application, 'beads-observer');
const projectResponse = await fetch(origin + '/api/projects');
assert.equal(projectResponse.status, 200);
const projects: Project[] = await projectResponse.json();
assert.equal(
  new Set(projects.map((project) => project.id)).size,
  projects.length,
);

let browser: Browser | undefined;
const forbidden: string[] = [];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && !['GET', 'HEAD'].includes(request.method())) {
      forbidden.push(`${request.method()} ${url.pathname}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const probe = window as BrowserProbe,
      OriginalEventSource = EventSource,
      sources: { url: URL; source: EventSource; payload?: string }[] = [];
    probe.__observerSSECount = 0;
    const WrappedEventSource = new Proxy(OriginalEventSource, {
      construct(target, args) {
        const source = Reflect.construct(target, args) as EventSource,
          url = new URL(String(args[0]), location.href);
        const entry = { url, source, payload: undefined as string | undefined };
        sources.push(entry);
        source.addEventListener('message', (event) => {
          entry.payload = (event as MessageEvent<string>).data;
          probe.__observerSSECount = (probe.__observerSSECount || 0) + 1;
        });
        if (url.pathname === '/api/projects/events')
          probe.__replayObserverCatalog = () => {
            if (entry.payload !== undefined)
              source.dispatchEvent(
                new MessageEvent('message', { data: entry.payload }),
              );
          };
        else if (/^\/api\/projects\/[^/]+\/events$/.test(url.pathname))
          probe.__replayObserverSnapshot = () => {
            if (entry.payload !== undefined)
              source.dispatchEvent(
                new MessageEvent('message', { data: entry.payload }),
              );
          };
        return source;
      },
    });
    Object.defineProperty(window, 'EventSource', { value: WrappedEventSource });
  });
  await page.goto(origin);
  await page.locator('#project-select').waitFor({ state: 'attached' });
  await page.locator('#content [data-issue]').first().waitFor();
  await page.waitForFunction(
    () => (window as BrowserProbe).__observerSSECount! >= 2,
  );

  const projectPicker = page.locator('[data-select="project-select"]');
  if (await projectPicker.isVisible()) {
    await projectPicker.click();
    const menu = page.locator('#select-menu');
    await menu.waitFor({ state: 'visible' });
    const before = await menu.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    await page.evaluate(() =>
      (window as BrowserProbe).__replayObserverCatalog?.(),
    );
    await page.waitForTimeout(50);
    assert.equal(
      await projectPicker.getAttribute('aria-expanded'),
      'true',
      'captured catalog SSE should not close the project picker',
    );
    const after = await menu.evaluate((element) => element.scrollTop);
    if (before > 0)
      assert(
        after >= before - 2,
        `captured catalog SSE moved the picker: ${before} -> ${after}`,
      );
    await page.keyboard.press('Escape');
  }

  for (const viewName of ['board', 'list', 'activity', 'graph']) {
    await page.locator(`[data-view="${viewName}"]`).click();
    const selector =
      viewName === 'graph'
        ? '#content > .graph-scroll'
        : '#content > .view-scroll';
    await page.locator(selector).waitFor();
    const before = await page.locator(selector).evaluate((element) => {
      if (element.scrollHeight <= element.clientHeight) return 0;
      element.scrollTop = Math.min(
        80,
        element.scrollHeight - element.clientHeight,
      );
      return element.scrollTop;
    });
    await page.evaluate(() =>
      (window as BrowserProbe).__replayObserverSnapshot?.(),
    );
    await page.waitForTimeout(50);
    const after = await page
      .locator(selector)
      .evaluate((element) => element.scrollTop);
    if (before > 0)
      assert(
        after >= before - 2,
        `${viewName} scroll changed after captured SSE: ${before} -> ${after}`,
      );
    assert.equal(await page.evaluate(() => scrollY), 0);
  }

  assert.deepEqual(forbidden, [], 'live browser attempted an HTTP write');
  console.log(
    `PASS readonly Observer ${health.version}: ${projects.length} projects, SSE replay, four views, zero writes`,
  );
  await context.close();
} finally {
  await browser?.close();
}
