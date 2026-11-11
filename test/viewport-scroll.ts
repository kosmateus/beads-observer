// Opt-in real-browser check; Playwright is a development-only dependency.
// Install Chromium with `npx playwright install chromium`, or point
// PLAYWRIGHT_EXECUTABLE_PATH at an existing compatible Chromium executable.
// If host libraries are missing, extract their .deb archives under /tmp/opencode
// and set LD_LIBRARY_PATH to that directory (do not use install-deps/sudo).
// TMPDIR=/tmp/opencode node dist/test/viewport-scroll.js
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/bootstrap/server.js';
import { DemoSource, demoIssues } from '../src/adapters/demo.js';
import { normalize } from '../src/domain/model.js';

const source = new DemoSource();
source.issues = Array.from({ length: 160 }, (_, i) => ({
  ...demoIssues()[4],
  id: `viewport-${String(i).padStart(3, '0')}`,
  title: `Viewport fixture ${i}`,
  issue_type: 'task',
  status: i % 3 ? 'open' : 'in_progress',
  dependencies: [],
  description: Array.from(
    { length: 90 },
    (_, line) =>
      `Paragraph ${line}: long issue detail verifies unrestricted reading.`,
  ).join('\n\n'),
}));
source.events = new Map(source.issues.map((issue) => [issue.id, []]));
source.snapshot = async () => normalize(structuredClone(source.issues), [], []);

let server: Awaited<ReturnType<typeof startServer>> | undefined;
let browser: Browser | undefined;
try {
  server = await startServer({
    port: 0,
    demo: true,
    source,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    project: 'Viewport test DEMO',
    pollIntervalMs: 3600000,
    sessionDirectory: '/tmp/opencode/observer-viewport/no-sessions',
  });
  assert.notEqual(new URL(server.url).port, '4317');
  await server.observer.refresh();
  source.issues.forEach((issue) => {
    issue.notes = 'Updated fixture';
  });
  await server.observer.refresh();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  });
  const failures: string[] = [];
  for (const viewport of [
    { width: 2000, height: 900 },
    { width: 1100, height: 800 },
    { width: 390, height: 844 },
  ]) {
    const page: Page = await browser.newPage({
      viewport,
      reducedMotion: 'reduce',
    });
    const label = `${viewport.width}x${viewport.height}`;
    try {
      await page.goto(server.url);
      await page.locator('#content [data-issue]').first().waitFor();
      for (const view of ['board', 'list', 'activity', 'graph']) {
        try {
          await page.locator(`[data-view="${view}"]`).click();
          const selector = `#content > .${view === 'graph' ? 'graph-scroll' : 'view-scroll'}`;
          await page.locator(selector).waitFor();
          await page.locator(selector).evaluate((element) => {
            element.scrollTop = 0;
          });
          const measure = () =>
            page.evaluate((selector) => {
              const region = document.querySelector(selector);
              if (!region)
                throw new Error('Missing scroll region: ' + selector);
              const fixed = [
                '.app-header',
                '.topbar',
                '.filters',
                '.results-row',
                '.list-controls',
                '.graph-controls',
              ];
              return {
                scrollTop: region.scrollTop,
                clientHeight: region.clientHeight,
                scrollHeight: region.scrollHeight,
                documentHeight: document.documentElement.scrollHeight,
                documentWidth: document.documentElement.scrollWidth,
                viewportWidth: innerWidth,
                viewportHeight: innerHeight,
                windowY: scrollY,
                fixed: Object.fromEntries(
                  fixed.flatMap((selector) => {
                    const element = document.querySelector(selector);
                    if (!element || !element.getClientRects().length) return [];
                    const box = element.getBoundingClientRect();
                    return [[selector, [box.x, box.y, box.width, box.height]]];
                  }),
                ),
              };
            }, selector);
          const before = await measure();
          assert(
            before.clientHeight > 0,
            `${view}: content viewport has zero height`,
          );
          assert(
            before.scrollHeight > before.clientHeight,
            `${view}: fixture must overflow`,
          );
          await page.locator(selector).hover();
          await page.mouse.wheel(0, 600);
          await page.waitForFunction(
            (selector) =>
              (document.querySelector(selector)?.scrollTop ?? 0) > 0,
            selector,
          );
          const after = await measure();
          assert(after.scrollTop > 0, `${view}: wheel must scroll content`);
          assert(
            after.documentHeight <= after.viewportHeight + 1,
            `${view}: document overflow ${after.documentHeight}/${after.viewportHeight}`,
          );
          assert.equal(after.windowY, 0, `${view}: document must not scroll`);
          assert(
            after.documentWidth <= after.viewportWidth + 1,
            `${view}: document must not overflow horizontally`,
          );
          assert.deepEqual(
            after.fixed,
            before.fixed,
            `${view}: controls moved`,
          );
          console.log(
            `PASS ${label} ${view}: scrollTop=${after.scrollTop}, region=${after.clientHeight}/${after.scrollHeight}, document=${after.documentHeight}`,
          );
        } catch (error) {
          failures.push(
            `${label} ${view}: ${error instanceof Error ? error.stack : String(error)}`,
          );
          console.error(
            `FAIL ${label} ${view}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      for (const mode of ['drawer', 'page']) {
        await page.locator('[data-view="board"]').click();
        await page.locator('#content > .view-scroll').evaluate((element) => {
          element.scrollTop = 0;
        });
        await page
          .locator(
            mode === 'drawer'
              ? '#content .issue-title'
              : '#content [data-detail]',
          )
          .first()
          .click();
        await page
          .locator(`#detail[data-mode="${mode}"] #detail-body .issue-layout`)
          .waitFor();
        await page.locator('#detail-body').hover();
        await page.mouse.wheel(0, 700);
        await page.waitForFunction(() => {
          let element = document.querySelector('#detail-body');
          while (element) {
            if (element.scrollTop > 0) return true;
            element = element.parentElement;
          }
          return window.scrollY > 0;
        });
        console.log(
          `PASS ${label} ${mode}: real wheel scroll reaches long detail`,
        );
        await page.locator('#close-detail').click();
      }
    } catch (error) {
      failures.push(
        `${label}: ${error instanceof Error ? error.stack : String(error)}`,
      );
      console.error(
        `FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await page.close();
    }
  }
  assert.equal(failures.length, 0, failures.join('\n\n'));
} finally {
  await browser?.close();
  await server?.close();
}
