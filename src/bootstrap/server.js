import { BeadsWriter } from '../adapters/beads-writer.js';
import { resolve, basename } from 'node:path';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Observer } from '../application/observer.js';
import { Projects } from '../application/projects.js';
import { BeadsSource } from '../adapters/beads-cli.js';
import { DemoSource } from '../adapters/demo.js';
import { listenHttp } from '../adapters/http.js';

export const HUB_PROTOCOL = 1;
export function projectID(cwd) {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 24);
}
export async function canonicalProject(input, defaults = {}) {
  const config = { ...defaults, ...input };
  config.cwd = await realpath(resolve(config.cwd || process.cwd()));
  config.id = projectID(config.cwd);
  config.project = config.project || basename(config.cwd);
  config.pollIntervalMs ??= 2000;
  config.timeoutMs ??= 15000;
  config.bdPath ??= 'bd';
  if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 500)
    throw new Error('pollIntervalMs must be >= 500');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000)
    throw new Error('timeoutMs must be >= 1000');
  if (typeof config.bdPath !== 'string' || !config.bdPath)
    throw new Error('Invalid bdPath');
  return config;
}
export function configurationSignature(config) {
  return JSON.stringify([
    config.cwd,
    config.project,
    config.bdPath,
    config.pollIntervalMs,
    config.timeoutMs,
    !!config.demo,
  ]);
}
export async function startServer(options = {}) {
  const port = options.port ?? 4317;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid port');
  const projects = new Projects(),
    running = new Map();
  const http = await listenHttp(projects, {
    port,
    runtimeId: options.runtimeId || 'standalone',
    protocol: HUB_PROTOCOL,
    sessionDirectory: options.sessionDirectory,
  });
  async function register(input, { replace = false } = {}) {
    const config = await canonicalProject(input, options);
    const signature = configurationSignature(config);
    if (running.has(config.id)) {
      if (running.get(config.id).signature === signature) {
        projects.setHostVersions(config.id, config.hostVersions || []);
        return config.id;
      }
      if (!replace) throw new Error(`Conflicting options for ${config.cwd}`);
      unregister(config.id);
    }
    const source =
      config.source ||
      (config.demo ? new DemoSource() : new BeadsSource(config));
    const observer = new Observer(source, {
      project: config.project,
      demo: config.demo,
    });
    const record = { observer, signature, timer: null, stopped: false };
    running.set(config.id, record);
    projects.add({
      id: config.id,
      cwd: config.cwd,
      name: config.project,
      hostVersions: config.hostVersions || [],
      writer:
        config.writer ||
        (config.demo
          ? source
          : source instanceof BeadsSource
            ? new BeadsWriter(source)
            : null),
      observer,
    });
    const poll = async () => {
      await observer.refresh();
      if (!record.stopped) {
        record.timer = setTimeout(poll, config.pollIntervalMs);
        record.timer.unref();
      }
    };
    void poll();
    return config.id;
  }
  function unregister(id) {
    const record = running.get(id);
    if (record) {
      record.stopped = true;
      clearTimeout(record.timer);
      running.delete(id);
      projects.remove(id);
    }
  }
  try {
    const inputs = options.projects ?? (options.empty ? [] : [options]);
    if (!Array.isArray(inputs)) throw new Error('projects must be an array');
    for (const input of inputs)
      await register(typeof input === 'string' ? { cwd: input } : input);
  } catch (error) {
    for (const id of running.keys()) unregister(id);
    await http.close();
    throw error;
  }
  return {
    ...http,
    projects,
    register,
    unregister,
    get observer() {
      return projects.get().observer;
    },
    async close() {
      for (const id of running.keys()) unregister(id);
      await http.close();
    },
  };
}
