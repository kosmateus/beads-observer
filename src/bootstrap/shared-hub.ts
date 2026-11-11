import { VERSION } from '../version.js';
import { probeHub } from '../adapters/hub-health.js';
import { join, resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { canonicalProject, HUB_PROTOCOL } from './server.js';
import type { ServerOptions, ProjectOptions, LeaseResult } from '../types.js';
import { errorInfo } from '../types.js';
import {
  hubDirectory,
  runtimeIdentity,
  atomicJSON,
  readJSON,
} from '../adapters/hub-files.js';
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** OpenCode entrypoint adapter. A renewable file lease shares one daemon across processes. */
export async function acquireSharedHub(options: ServerOptions = {}) {
  const port = options.port ?? 4317;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      'Shared hub port must be 1..65535; use a fixed port for discovery',
    );
  const base = resolve(options.cwd || process.cwd());
  const inputs = [
    { ...options, cwd: base },
    ...(options.projects || []).map((x) =>
      typeof x === 'string' ? { cwd: x } : x,
    ),
  ];
  const configs: ProjectOptions[] = [];
  for (const input of inputs) {
    const config = await canonicalProject({
      ...options,
      ...input,
      cwd: resolve(base, input.cwd || base),
    });
    // Persist only declarative options. No credentials, environment or executable arguments.
    configs.push({
      cwd: config.cwd,
      project: config.project,
      bdPath:
        config.bdPath.includes('/') || config.bdPath.includes('\\')
          ? resolve(base, config.bdPath)
          : config.bdPath,
      pollIntervalMs: config.pollIntervalMs,
      timeoutMs: config.timeoutMs,
      demo: !!config.demo,
      opencodeVersion: options.opencodeVersion || null,
    });
  }
  const directory = await hubDirectory(port, options.runtimeDirectory),
    runtimeId = runtimeIdentity(directory);
  const path = join(directory, `lease-${randomUUID()}.json`),
    url = `http://127.0.0.1:${port}`;
  let closed = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    pending: Promise<void> | null = null,
    lastSpawn = 0,
    spawnError: Error | null = null;
  const writeLease = () =>
    atomicJSON(path, {
      updatedAt: Date.now(),
      pid: process.pid,
      projects: configs,
    });
  async function health() {
    let response;
    try {
      response = await probeHub(port);
    } catch (caught) {
      const error = errorInfo(caught);
      throw new Error(
        `Observer health probe failed on port ${port}: ${error.message}`,
        { cause: caught },
      );
    }
    if (!response) return false;
    const { info } = response;
    if (
      !response.ok ||
      info.application !== 'beads-observer' ||
      info.protocol !== HUB_PROTOCOL ||
      info.runtimeId !== runtimeId ||
      info.version !== VERSION
    )
      throw new Error(
        `Port ${port} is occupied by another service or incompatible Observer`,
      );
    return true;
  }
  function launch() {
    if (Date.now() - lastSpawn < 1500) return;
    lastSpawn = Date.now();
    const child = spawn(
      options.nodePath || 'node',
      [
        fileURLToPath(new URL('./hub-daemon.js', import.meta.url)),
        '--hub-daemon',
        '--port',
        String(port),
        '--directory',
        directory,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.on('error', (error) => {
      spawnError = error;
    });
    child.unref();
  }
  async function ensure() {
    if (!(await health())) launch();
    if (spawnError)
      throw new Error(
        `Cannot start hub: ${errorInfo(spawnError).message}. Set nodePath to Node.js 22+.`,
      );
  }
  const close = async () => {
    closed = true;
    clearTimeout(timer);
    await pending?.catch(() => {});
    await unlink(path).catch(() => {});
    await unlink(path + '.result').catch(() => {});
  };
  try {
    await writeLease();
    await ensure();
    let result: LeaseResult | null = null;
    for (let i = 0; i < 50; i++) {
      if (spawnError) throw spawnError;
      if (await health()) {
        result = await readJSON<LeaseResult>(path + '.result').catch(
          () => null,
        );
        if (result) {
          if (result.errors.length) throw new Error(result.errors.join('; '));
          break;
        }
      }
      await delay(200);
    }
    if (!result) throw new Error(`Hub did not register projects on ${url}`);
    const renew = () => {
      if (closed) return;
      pending = (async () => {
        await writeLease();
        await ensure();
      })()
        .catch((error) => console.error('[beads.observer]', error.message))
        .finally(() => {
          if (!closed) {
            timer = setTimeout(renew, 5000);
            timer.unref();
          }
        });
    };
    timer = setTimeout(renew, 5000);
    timer.unref();
    return { url, directory, projectIds: result.projectIds, close };
  } catch (error) {
    await close();
    throw error;
  }
}
