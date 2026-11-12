import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { DemoSource } from '../src/adapters/demo.js';

test('server bootstrap covers defaults, registration conflicts, and cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'observer-server-coverage-')),
    cwd = join(root, 'project'),
    beads = join(cwd, '.beads'),
    bin = join(root, 'bin'),
    bdPath = join(bin, 'bd'),
    missingBdPath = join(bin, 'bd-missing'),
    previousPath = process.env.PATH,
    ports: number[] = [],
    closed: number[] = [];
  await mkdir(join(cwd, '.git'), { recursive: true });
  await mkdir(beads);
  await mkdir(bin);
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env node
process.stdout.write('.git\\n');
`,
    { mode: 0o700 },
  );
  await writeFile(
    bdPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fixture-bd'); process.exit(0); }
if (args.includes('where')) { process.stdout.write(JSON.stringify({ path: ${JSON.stringify(beads)} })); process.exit(0); }
process.stdout.write('[]');
`,
    { mode: 0o700 },
  );
  await writeFile(
    missingBdPath,
    `#!/usr/bin/env node
if (process.argv.includes('where')) {
  process.stdout.write(JSON.stringify({ error: 'no_beads_directory' }));
  process.exit(1);
}
process.stdout.write('[]');
`,
    { mode: 0o700 },
  );
  await chmod(join(bin, 'git'), 0o700);
  await chmod(bdPath, 0o700);
  await chmod(missingBdPath, 0o700);
  process.env.PATH = [bin, previousPath].filter(Boolean).join(delimiter);
  t.mock.module(new URL('../src/adapters/http.js', import.meta.url), {
    namedExports: {
      listenHttp: async (_projects: unknown, options: { port: number }) => {
        ports.push(options.port);
        return {
          url: `http://127.0.0.1:${options.port}`,
          close: async () => {
            closed.push(options.port);
          },
        };
      },
    },
  });

  let app:
    | Awaited<
        ReturnType<typeof import('../src/bootstrap/server.js').startServer>
      >
    | undefined;
  try {
    const { canonicalProject, startServer } =
      await import('../src/bootstrap/server.js');
    const defaultCwd = await canonicalProject({ demo: true });
    assert.equal(defaultCwd.cwd, process.cwd());
    assert.equal(defaultCwd.beadsWorkspace, 'custom');

    app = await startServer({
      sessionDirectory: root,
      projects: [cwd],
      demo: true,
      pollIntervalMs: 3600000,
    });
    assert.deepEqual(ports, [4317]);
    assert.ok(app.observer);
    const id = app.projects.list()[0].id;
    assert.equal(
      await app.register({ cwd, demo: true, pollIntervalMs: 3600000 }),
      id,
    );
    await assert.rejects(
      app.register({ cwd, demo: true, pollIntervalMs: 500 }),
      /Conflicting options/,
    );
    assert.equal(
      await app.register(
        { cwd, demo: true, pollIntervalMs: 500 },
        { replace: true },
      ),
      id,
    );
    app.unregister('unknown-project');
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.unregister(id);
    assert.equal(app.projects.list().length, 0);
    await app.close();
    app = undefined;

    const missing = await startServer({
      port: 0,
      sessionDirectory: join(root, 'missing-state'),
      projects: [{ cwd, bdPath: missingBdPath }],
    });
    assert.equal(missing.projects.list().length, 0);
    await missing.close();

    await assert.rejects(
      startServer({
        port: 0,
        sessionDirectory: join(root, 'unavailable-state'),
        projects: [{ cwd, bdPath: join(bin, 'absent-bd') }],
      }),
      /Could not verify Beads workspace/,
    );

    await assert.rejects(
      startServer({
        port: 0,
        sessionDirectory: join(root, 'rollback-state'),
        projects: [
          { cwd, demo: true },
          { cwd, demo: true, pollIntervalMs: 499 },
        ],
      }),
      /pollIntervalMs must be >= 500/,
    );

    const invalidProjects = {
      port: 0,
      empty: true,
      sessionDirectory: join(root, 'invalid-state'),
    };
    Reflect.set(invalidProjects, 'projects', 'not-an-array');
    await assert.rejects(
      startServer(invalidProjects),
      /projects must be an array/,
    );
    await startServer({
      port: 0,
      empty: true,
      sessionDirectory: join(root, 'empty-state'),
    }).then((empty) => empty.close());
    await startServer({ port: 0, empty: true }).then((empty) => empty.close());
    await startServer({
      port: 4318,
      empty: true,
      runtimeDirectory: root,
    }).then((empty) => empty.close());

    const sourceCwd = join(root, 'custom-source-project');
    await mkdir(sourceCwd);
    const customSource = await startServer({
      port: 0,
      sessionDirectory: join(root, 'custom-source-state'),
      projects: [{ cwd: sourceCwd, source: new DemoSource() }],
    });
    assert.equal(customSource.projects.list().length, 1);
    await customSource.close();

    for (const port of [-1, 65536, 1.5])
      await assert.rejects(startServer({ port }), /Invalid port/);

    const invalidPollInterval = { cwd, demo: true, pollIntervalMs: 499.5 };
    await assert.rejects(
      canonicalProject(invalidPollInterval),
      /pollIntervalMs must be >= 500/,
    );
    await assert.rejects(
      canonicalProject({ cwd, demo: true, pollIntervalMs: 499 }),
      /pollIntervalMs must be >= 500/,
    );
    await assert.rejects(
      canonicalProject({ cwd, demo: true, timeoutMs: 999.5 }),
      /timeoutMs must be >= 1000/,
    );
    await assert.rejects(
      canonicalProject({ cwd, demo: true, timeoutMs: 999 }),
      /timeoutMs must be >= 1000/,
    );
    await assert.rejects(
      canonicalProject({ cwd, demo: true, bdPath: '' }),
      /Invalid bdPath/,
    );
    const invalidBdPath = { cwd, demo: true };
    Reflect.set(invalidBdPath, 'bdPath', 1);
    await assert.rejects(canonicalProject(invalidBdPath), /Invalid bdPath/);
  } finally {
    await app?.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(closed, [4317, 0, 0, 0, 0, 0, 0, 4318, 0]);
});
