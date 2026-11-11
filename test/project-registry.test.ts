import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isMissingBeadsWorkspaceError,
  MissingBeadsWorkspaceError,
} from '../src/adapters/beads-cli.js';
import { atomicJSON, hubDirectory } from '../src/adapters/hub-files.js';
import { runDaemon } from '../src/bootstrap/hub-daemon.js';
import {
  canonicalProjectID,
  gitCommonDirectory,
} from '../src/bootstrap/server.js';

test('Git worktrees share identity only when their real common directory and Beads location match', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'observer-project-identity-')),
    main = join(root, 'main'),
    worktree = join(root, 'worktree');
  try {
    await mkdir(main);
    await execFileSync('git', ['init', '--quiet', main]);
    await execFileSync('git', [
      '-C',
      main,
      'config',
      'user.email',
      'fixture@example.invalid',
    ]);
    await execFileSync('git', ['-C', main, 'config', 'user.name', 'Fixture']);
    await writeFile(join(main, 'fixture.txt'), 'fixture');
    await execFileSync('git', ['-C', main, 'add', 'fixture.txt']);
    await execFileSync('git', [
      '-C',
      main,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
    await execFileSync('git', [
      '-C',
      main,
      'worktree',
      'add',
      '--detach',
      '--quiet',
      worktree,
      'HEAD',
    ]);
    const [mainCommon, worktreeCommon] = await Promise.all([
      gitCommonDirectory(main),
      gitCommonDirectory(worktree),
    ]);
    assert.ok(mainCommon);
    assert.equal(worktreeCommon, mainCommon);
    const sharedBeads = join(main, '.beads');
    assert.equal(
      canonicalProjectID(main, mainCommon, sharedBeads),
      canonicalProjectID(worktree, worktreeCommon, sharedBeads),
    );
    assert.notEqual(
      canonicalProjectID(main, mainCommon, sharedBeads),
      canonicalProjectID(worktree, worktreeCommon, join(worktree, '.beads')),
    );
    assert.notEqual(
      canonicalProjectID(main, mainCommon, sharedBeads),
      canonicalProjectID(main, join(root, 'other.git'), sharedBeads),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip('Git is unavailable in this test environment');
      return;
    }
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing Beads workspace is distinct from an unavailable CLI or transient error', async () => {
  const noWorkspace = Object.assign(new Error('bd where failed'), {
      stdout: JSON.stringify({ error: 'no_beads_directory' }),
    }),
    unavailable = Object.assign(new Error('bd where failed'), {
      stdout: JSON.stringify({ error: 'temporary_database_unavailable' }),
    });
  assert.equal(isMissingBeadsWorkspaceError(noWorkspace), true);
  assert.equal(
    isMissingBeadsWorkspaceError(new MissingBeadsWorkspaceError()),
    true,
  );
  assert.equal(isMissingBeadsWorkspaceError(unavailable), false);
  assert.equal(
    isMissingBeadsWorkspaceError(
      Object.assign(new Error(), { code: 'ENOENT' }),
    ),
    false,
  );
});

test(
  'daemon retains a registered project through transient bd errors and removes it when its Beads location disappears',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'observer-project-lifecycle-')),
      cwd = join(root, 'project'),
      beads = join(cwd, '.beads'),
      mode = join(root, 'bd-mode'),
      bdPath = join(root, 'bd-fixture'),
      port = 0;
    await mkdir(cwd);
    await mkdir(beads);
    await writeFile(mode, 'ready');
    await writeFile(
      bdPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fixture-bd'); process.exit(0); }
if (args.includes('where')) {
  if (fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim() === 'offline') {
    process.stdout.write(JSON.stringify({ error: 'temporary_database_unavailable' }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ path: ${JSON.stringify(beads)} }));
  process.exit(0);
}
process.stdout.write('[]');
`,
      { mode: 0o700 },
    );
    await chmod(bdPath, 0o700);
    const directory = await hubDirectory(port, root),
      lease = join(
        directory,
        'lease-00000000-0000-4000-8000-000000000001.json',
      );
    await atomicJSON(lease, {
      pid: process.pid,
      updatedAt: Date.now(),
      projects: [
        {
          cwd,
          project: 'Temporary fixture',
          bdPath,
          pollIntervalMs: 3600000,
          timeoutMs: 5000,
        },
        {
          cwd: join(root, 'deleted-worktree'),
          project: 'Deleted fixture',
          bdPath,
          pollIntervalMs: 3600000,
          timeoutMs: 5000,
        },
      ],
    });
    let daemon: Awaited<ReturnType<typeof runDaemon>> | undefined;
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail('Timed out waiting for daemon registry state');
    };
    try {
      daemon = await runDaemon({ port, directory, scanMs: 20, idleMs: 3000 });
      await waitFor(() => {
        const project = daemon!.projects.list()[0];
        return (
          !!project &&
          daemon!.projects.list().length === 1 &&
          project.revision > 0
        );
      });
      const leaseResult = JSON.parse(await readFile(lease + '.result', 'utf8'));
      assert.deepEqual(leaseResult.errors, []);
      assert.equal(leaseResult.projectIds.length, 1);
      await writeFile(mode, 'offline');
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(daemon.projects.list().length, 1);

      await writeFile(mode, 'ready');
      await rmdir(beads);
      await waitFor(() => daemon!.projects.list().length === 0);
      assert.equal(daemon.projects.list().length, 0);
    } finally {
      await daemon?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
