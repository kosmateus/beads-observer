import { join, dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  startServer,
  canonicalProject,
  configurationSignature,
} from './server.js';
import {
  hubDirectory,
  runtimeIdentity,
  readLeases,
  atomicJSON,
} from '../adapters/hub-files.js';

/** Local daemon. Its only write operations are private registration metadata, never Beads. */
export async function runDaemon({
  port,
  directory,
  scanMs = 1000,
  idleMs = 10000,
}) {
  const expected = await hubDirectory(port, dirname(directory));
  if ((await realpath(expected)) !== (await realpath(directory)))
    throw new Error('Invalid hub directory');
  const app = await startServer({
    port,
    empty: true,
    sessionDirectory: directory,
    runtimeId: runtimeIdentity(directory),
  });
  let stopped = false,
    timer,
    idleSince = null;
  const results = new Map();
  const close = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    await app.close();
  };
  async function scan() {
    try {
      const leases = await readLeases(directory),
        wanted = new Set(),
        groups = new Map();
      const outcomes = new Map(
        leases.map((lease) => [lease.file, { projectIds: [], errors: [] }]),
      );
      for (const lease of leases)
        for (const input of lease.projects) {
          try {
            const config = await canonicalProject(input);
            const entries = groups.get(config.id) || [];
            entries.push({
              config,
              file: lease.file,
              signature: configurationSignature(config),
            });
            groups.set(config.id, entries);
          } catch (error) {
            outcomes.get(lease.file).errors.push(error.message);
          }
        }
      for (const [id, entries] of groups) {
        wanted.add(id);
        if (new Set(entries.map((entry) => entry.signature)).size > 1) {
          for (const entry of entries)
            outcomes
              .get(entry.file)
              .errors.push(`Conflicting options for ${entry.config.cwd}`);
          continue;
        }
        try {
          await app.register(
            {
              ...entries[0].config,
              hostVersions: [
                ...new Set(
                  entries.map((e) => e.config.opencodeVersion).filter(Boolean),
                ),
              ].sort(),
            },
            { replace: true },
          );
          for (const entry of entries)
            outcomes.get(entry.file).projectIds.push(id);
        } catch (error) {
          for (const entry of entries)
            outcomes.get(entry.file).errors.push(error.message);
        }
      }
      for (const [file, result] of outcomes) {
        result.projectIds = [...new Set(result.projectIds)];
        const signature = JSON.stringify(result);
        if (results.get(file) !== signature) {
          await atomicJSON(join(directory, file + '.result'), result);
          results.set(file, signature);
        }
      }
      for (const file of results.keys())
        if (!outcomes.has(file)) results.delete(file);
      for (const project of app.projects.list())
        if (!wanted.has(project.id)) app.unregister(project.id);
      if (!leases.length) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= idleMs) {
          await close();
          return;
        }
      } else idleSince = null;
    } catch (error) {
      console.error('[beads.observer]', error.message);
    }
    if (!stopped) {
      timer = setTimeout(scan, scanMs);
      timer.unref();
    }
  }
  void scan();
  return { url: app.url, projects: app.projects, close };
}
if (
  process.argv[1] &&
  new URL(import.meta.url).pathname.endsWith('/hub-daemon.js') &&
  process.argv.includes('--hub-daemon')
) {
  try {
    const app = await runDaemon({
      port: Number(process.argv[process.argv.indexOf('--port') + 1]),
      directory: process.argv[process.argv.indexOf('--directory') + 1],
    });
    for (const signal of ['SIGTERM', 'SIGINT'])
      process.once(signal, async () => {
        await app.close();
        process.exit(0);
      });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
