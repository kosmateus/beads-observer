#!/usr/bin/env node
import { VERSION } from './version.js';
import { acquireSharedHub } from './bootstrap/shared-hub.js';
import { BeadsSource } from './adapters/beads-cli.js';
import { openBrowser } from './adapters/browser.js';
import { canonicalProject } from './bootstrap/server.js';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { startServer } from './bootstrap/server.js';
import type { ServerOptions, HubHealth } from './types.js';
import { errorInfo } from './types.js';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Beads Observer\n\nbeads-observer open [--cwd path] [--port 4317] [--bd path]\nbeads-observer [--project path ...] [--config file] [--port 4317]\nbeads-observer --demo\n\nNode.js 22+ and Beads bd are required for real projects.',
  );
  process.exit(0);
}
const value = (key: string, fallback?: string | number) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
try {
  let options: ServerOptions = {};
  if (args.includes('--config')) {
    const configPath = resolve(String(value('--config')));
    options = JSON.parse(await readFile(configPath, 'utf8'));
    if (options.projects)
      options.projects = options.projects.map((p) =>
        typeof p === 'string'
          ? { cwd: resolve(dirname(configPath), p) }
          : { ...p, cwd: resolve(dirname(configPath), p.cwd || '.') },
      );
  }
  const repeated = args.flatMap((arg, i) =>
    arg === '--project' ? [{ cwd: resolve(args[i + 1]) }] : [],
  );
  const config = {
    ...options,
    port: Number(value('--port', options.port ?? 4317)),
    cwd: String(value('--cwd', options.cwd || process.cwd())),
    bdPath: String(value('--bd', options.bdPath || 'bd')),
    demo: args.includes('--demo') || options.demo,
    ...(repeated.length ? { projects: repeated } : {}),
  };
  let app: { url: string; close: () => Promise<void> } | undefined;
  if (args[0] === 'open') {
    const canonical = await canonicalProject(config);
    if (!config.demo) await new BeadsSource(canonical).location();
    const url = `http://127.0.0.1:${config.port}`;
    let existing = false;
    try {
      const health = await fetch(url + '/api/health', {
        signal: AbortSignal.timeout(1200),
      }).then((r) => r.json() as Promise<HubHealth>);
      if (
        health.application === 'beads-observer' &&
        health.version === VERSION
      ) {
        const projects = await fetch(url + '/api/projects').then(
          (r) => r.json() as Promise<{ id: string }[]>,
        );
        existing = projects.some((p) => p.id === canonical.id);
      }
    } catch {}
    if (existing) {
      const result = await openBrowser(`${url}/?project=${canonical.id}`);
      console.log(result.opened ? `Beads Observer: ${url}` : result.message);
    } else {
      app = await acquireSharedHub(config);
      const result = await openBrowser(`${app.url}/?project=${canonical.id}`);
      if (!result.opened) console.log(result.message);
      // Keep the CLI's project lease alive until Ctrl+C.
      const keepAlive = setInterval(() => {}, 60000);
      const close = app.close;
      app.close = async () => {
        clearInterval(keepAlive);
        await close();
      };
    }
  } else app = await startServer(config);
  if (app) console.log(`Beads Observer: ${app.url} (Ctrl+C to stop)`);
  if (app)
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, async () => {
        await app!.close();
        process.exit(0);
      });
} catch (error) {
  console.error(errorInfo(error).message);
  process.exitCode = 1;
}
