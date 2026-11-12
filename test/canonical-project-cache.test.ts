import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJSON, hubDirectory } from '../src/adapters/hub-files.js';
import { runDaemon } from '../src/bootstrap/hub-daemon.js';
import { canonicalProject } from '../src/bootstrap/server.js';

test(
  'repeated daemon scans reuse canonical identity instead of re-running Git and bd where',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'observer-canonical-cache-')),
      repo = join(root, 'repo'),
      cwd = join(repo, 'worktree'),
      beads = join(cwd, '.beads'),
      bin = join(root, 'bin'),
      gitCount = join(root, 'git-count'),
      whereCount = join(root, 'where-count'),
      bdPath = join(bin, 'bd'),
      directory = await hubDirectory(0, root),
      lease = join(
        directory,
        'lease-00000000-0000-4000-8000-000000000001.json',
      ),
      previousPath = process.env.PATH;
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(beads);
    await mkdir(bin);
    await writeFile(gitCount, '');
    await writeFile(whereCount, '');
    await writeFile(
      join(bin, 'git'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(gitCount)}, 'git\\n');
process.stdout.write(process.cwd() === ${JSON.stringify(repo)} ? '.git\\n' : '../.git\\n');
`,
      { mode: 0o700 },
    );
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fixture-bd'); process.exit(0); }
if (args.includes('where')) {
  fs.appendFileSync(${JSON.stringify(whereCount)}, 'where\\n');
  const location = [${JSON.stringify(beads)}, ${JSON.stringify(join(repo, '.beads'))}].find(fs.existsSync);
  if (!location) { process.stdout.write(JSON.stringify({ error: 'no_beads_directory' })); process.exit(1); }
  process.stdout.write(JSON.stringify({ path: location }));
  process.exit(0);
}
process.stdout.write('[]');
`,
      { mode: 0o700 },
    );
    await chmod(join(bin, 'git'), 0o700);
    await chmod(bdPath, 0o700);
    await atomicJSON(lease, {
      pid: process.pid,
      updatedAt: Date.now(),
      projects: [
        {
          cwd,
          bdPath,
          pollIntervalMs: 3600000,
          timeoutMs: 5000,
          opencodeVersion: 'scan-1',
        },
      ],
    });
    process.env.PATH = [bin, previousPath].filter(Boolean).join(delimiter);

    let daemon: Awaited<ReturnType<typeof runDaemon>> | undefined;
    const count = async (path: string) =>
      (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).length;
    const waitForResult = async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try {
          await readFile(lease + '.result', 'utf8');
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.fail('Timed out waiting for the first daemon scan');
    };
    const waitForHostVersion = async (version: string) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (daemon?.projects.list()[0]?.hostVersions.includes(version)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`Timed out waiting for daemon scan ${version}`);
    };
    const writeLease = async (opencodeVersion: string) =>
      atomicJSON(lease, {
        pid: process.pid,
        updatedAt: Date.now(),
        projects: [
          {
            cwd,
            bdPath,
            pollIntervalMs: 3600000,
            timeoutMs: 5000,
            opencodeVersion,
          },
        ],
      });
    try {
      daemon = await runDaemon({
        port: 0,
        directory,
        scanMs: 1000,
        idleMs: 3000,
      });
      await waitForResult();
      await waitForHostVersion('scan-1');
      await writeLease('scan-2');
      await waitForHostVersion('scan-2');
      await writeLease('scan-3');
      await waitForHostVersion('scan-3');

      assert.equal(await count(gitCount), 1);
      assert.equal(await count(whereCount), 3);

      await rm(beads, { recursive: true });
      const missingDeadline = Date.now() + 3000;
      while (Date.now() < missingDeadline && daemon.projects.list().length)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(daemon.projects.list().length, 0);
      assert.deepEqual(
        JSON.parse(await readFile(lease + '.result', 'utf8')).projectIds,
        [],
      );
      assert.equal(await count(gitCount), 2);
      assert.equal(await count(whereCount), 4);

      const movedBeads = join(repo, '.beads');
      await mkdir(movedBeads);
      await writeLease('scan-4');
      await waitForHostVersion('scan-4');
      assert.equal(daemon.projects.list()[0].cwd, repo);
      assert.equal(await count(gitCount), 3);
      assert.equal(await count(whereCount), 6);
    } finally {
      await daemon?.close();
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'canonical identity cache separates configuration, expires, and does not cache transient Beads errors',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'observer-canonical-expiry-')),
      cwd = join(root, 'project'),
      beadsA = join(root, 'beads-a', '.beads'),
      beadsB = join(root, 'beads-b', '.beads'),
      bin = join(root, 'bin'),
      gitCount = join(root, 'git-count'),
      whereCount = join(root, 'where-count'),
      alternateWhereCount = join(root, 'alternate-where-count'),
      mode = join(root, 'mode'),
      location = join(root, 'location'),
      bdPath = join(bin, 'bd'),
      alternateBdPath = join(bin, 'bd-alternate'),
      previousPath = process.env.PATH;
    const originalDateNow = Date.now;
    let now = originalDateNow();
    Date.now = () => now;
    await mkdir(join(cwd, '.git'), { recursive: true });
    await mkdir(beadsA, { recursive: true });
    await mkdir(beadsB, { recursive: true });
    await mkdir(bin);
    await writeFile(gitCount, '');
    await writeFile(whereCount, '');
    await writeFile(alternateWhereCount, '');
    await writeFile(mode, 'ready');
    await writeFile(location, beadsA);
    await writeFile(
      join(bin, 'git'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(gitCount)}, 'git\\n');
process.stdout.write('.git\\n');
`,
      { mode: 0o700 },
    );
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fixture-bd'); process.exit(0); }
if (args.includes('where')) {
  fs.appendFileSync(${JSON.stringify(whereCount)}, 'where\\n');
  const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim();
  if (mode === 'transient') {
    process.stdout.write(JSON.stringify({ error: 'temporary_database_unavailable' }));
    process.exit(1);
  }
  if (mode === 'missing') {
    process.stdout.write(JSON.stringify({ error: 'no_beads_directory' }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ path: fs.readFileSync(${JSON.stringify(location)}, 'utf8').trim() }));
  process.exit(0);
}
process.stdout.write('[]');
      `,
      { mode: 0o700 },
    );
    await writeFile(
      alternateBdPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('where')) {
  fs.appendFileSync(${JSON.stringify(alternateWhereCount)}, 'where\\n');
  process.stdout.write(JSON.stringify({ path: ${JSON.stringify(beadsB)} }));
  process.exit(0);
}
process.stdout.write('[]');
`,
      { mode: 0o700 },
    );
    await chmod(join(bin, 'git'), 0o700);
    await chmod(bdPath, 0o700);
    await chmod(alternateBdPath, 0o700);
    process.env.PATH = [bin, previousPath].filter(Boolean).join(delimiter);

    try {
      const first = await canonicalProject({ cwd, bdPath, timeoutMs: 5000 });
      assert.equal(first.beadsLocation, beadsA);
      await rm(join(root, 'beads-a'), { recursive: true });
      await writeFile(join(root, 'beads-a'), 'not a directory');
      await writeFile(location, beadsB);
      assert.equal(
        (await canonicalProject({ cwd, bdPath, timeoutMs: 5000 }))
          .beadsLocation,
        beadsB,
      );
      const beforeExpiry = await readFile(whereCount, 'utf8');
      now += 10_001;
      assert.equal(
        (await canonicalProject({ cwd, bdPath, timeoutMs: 5000 }))
          .beadsLocation,
        beadsB,
      );
      assert.equal(
        (await readFile(whereCount, 'utf8')).trim().split('\n').length,
        beforeExpiry.trim().split('\n').length + 1,
      );
      assert.equal(
        (
          await canonicalProject({
            cwd,
            bdPath: alternateBdPath,
            timeoutMs: 5000,
          })
        ).beadsLocation,
        beadsB,
      );
      assert.equal(
        (await canonicalProject({ cwd, bdPath, timeoutMs: 6000 }))
          .beadsLocation,
        beadsB,
      );

      await writeFile(mode, 'transient');
      assert.equal(
        (await canonicalProject({ cwd, bdPath, timeoutMs: 7000 }))
          .beadsWorkspace,
        'unavailable',
      );
      await writeFile(mode, 'ready');
      assert.equal(
        (await canonicalProject({ cwd, bdPath, timeoutMs: 7000 }))
          .beadsLocation,
        beadsB,
      );

      await writeFile(mode, 'missing');
      assert.equal(
        (await canonicalProject({ cwd, bdPath, timeoutMs: 8000 }))
          .beadsWorkspace,
        'missing',
      );
      const beforeMissing = (await readFile(whereCount, 'utf8')).trim();
      assert.equal(
        (await canonicalProject({ cwd, bdPath, timeoutMs: 8000 }))
          .beadsWorkspace,
        'missing',
      );
      assert.equal(
        (await readFile(whereCount, 'utf8')).trim().split('\n').length,
        beforeMissing.trim().split('\n').length + 1,
      );

      await writeFile(mode, 'ready');
      assert.equal(
        (await canonicalProject({ cwd, bdPath, timeoutMs: 8000 }))
          .beadsLocation,
        beadsB,
      );
      assert.equal(
        (await readFile(whereCount, 'utf8')).trim().split('\n').length,
        beforeMissing.trim().split('\n').length + 2,
      );
      assert.equal(
        (await readFile(alternateWhereCount, 'utf8')).trim().split('\n').length,
        1,
      );
    } finally {
      Date.now = originalDateNow;
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'canonical identity cache invalidates when a Git worktree changes its common directory',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'observer-canonical-worktree-')),
      cwd = join(root, 'worktree'),
      beads = join(cwd, '.beads'),
      commonA = join(root, 'common-a', '.git'),
      commonB = join(root, 'common-b', '.git'),
      bin = join(root, 'bin'),
      commonDirFile = join(root, 'common-dir'),
      gitCount = join(root, 'git-count'),
      whereCount = join(root, 'where-count'),
      bdPath = join(bin, 'bd'),
      previousPath = process.env.PATH;
    await mkdir(beads, { recursive: true });
    await mkdir(commonA, { recursive: true });
    await mkdir(commonB, { recursive: true });
    await mkdir(bin);
    await writeFile(join(cwd, '.git'), 'gitdir: common-a\n');
    await writeFile(commonDirFile, commonA);
    await writeFile(gitCount, '');
    await writeFile(whereCount, '');
    await writeFile(
      join(bin, 'git'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(gitCount)}, 'git\\n');
process.stdout.write(fs.readFileSync(${JSON.stringify(commonDirFile)}, 'utf8'));
`,
      { mode: 0o700 },
    );
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('where')) {
  fs.appendFileSync(${JSON.stringify(whereCount)}, 'where\\n');
  process.stdout.write(JSON.stringify({ path: ${JSON.stringify(beads)} }));
  process.exit(0);
}
process.stdout.write('[]');
`,
      { mode: 0o700 },
    );
    await chmod(join(bin, 'git'), 0o700);
    await chmod(bdPath, 0o700);
    process.env.PATH = [bin, previousPath].filter(Boolean).join(delimiter);

    try {
      const first = await canonicalProject({ cwd, bdPath, timeoutMs: 5000 });
      assert.equal(first.canonicalRoot, commonA);
      await writeFile(join(cwd, '.git'), 'gitdir: common-b\n');
      await writeFile(commonDirFile, commonB);
      const second = await canonicalProject({ cwd, bdPath, timeoutMs: 5000 });
      assert.equal(second.canonicalRoot, commonB);
      assert.equal(
        (await readFile(gitCount, 'utf8')).trim().split('\n').length,
        2,
      );
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'canonical identity cache evicts older projects instead of growing without bound',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'observer-canonical-bound-')),
      bin = join(root, 'bin'),
      gitCount = join(root, 'git-count'),
      previousPath = process.env.PATH;
    await mkdir(bin);
    await writeFile(gitCount, '');
    await writeFile(
      join(bin, 'git'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(gitCount)}, 'git\\n');
process.exit(1);
`,
      { mode: 0o700 },
    );
    await chmod(join(bin, 'git'), 0o700);
    process.env.PATH = [bin, previousPath].filter(Boolean).join(delimiter);

    try {
      const projects = Array.from({ length: 129 }, (_, index) =>
        join(root, `project-${index}`),
      );
      await Promise.all(projects.map((cwd) => mkdir(cwd)));
      for (const cwd of projects) await canonicalProject({ cwd, demo: true });
      await canonicalProject({ cwd: projects[0], demo: true });
      assert.equal(
        (await readFile(gitCount, 'utf8')).trim().split('\n').length,
        130,
      );
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  },
);
