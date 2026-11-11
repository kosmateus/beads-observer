import { randomUUID } from 'node:crypto';
import { realpath, lstat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectEnvironment } from './beads-cli.js';
import type { BeadsSource } from './beads-cli.js';
import type { Draft, Update, Relation, IssueDetail } from '../types.js';
import { errorInfo } from '../types.js';
const execute = promisify(execFile);
/** Write port: only creation, with a fixed command and whitelisted arguments. */
export class BeadsWriter {
  reader: BeadsSource;
  constructor(reader: BeadsSource) {
    this.reader = reader;
  }
  async resetPreview() {
    const expected = join(await realpath(this.reader.cwd), '.beads');
    const stat = await lstat(expected);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error(
        'Reset requires a local .beads directory, not a redirect or symlink.',
      );
    const location = await this.reader.location();
    if (location.path !== expected)
      throw Error('Reset refused: database is outside the selected project.');
    const identity = String(stat.dev) + ':' + String(stat.ino);
    try {
      const result = await execute(this.reader.bdPath, ['admin', 'reset'], {
        cwd: this.reader.cwd,
        env: projectEnvironment(process.env),
        timeout: this.reader.timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return {
        path: expected,
        identity,
        mode: 'native',
        preview: result.stdout,
      };
    } catch (caught) {
      const error = errorInfo(caught);
      if (!String(error.stderr).includes('not yet supported in embedded mode'))
        throw error;
      return { path: expected, identity, mode: 'embedded', preview: expected };
    }
  }
  async reset(
    expectedPath: string,
    expectedIdentity: string,
    expectedMode?: string,
  ) {
    const preview = await this.resetPreview();
    if (
      preview.path !== expectedPath ||
      preview.identity !== expectedIdentity ||
      (expectedMode && preview.mode !== expectedMode)
    )
      throw Error('Database location changed. Confirm again.');
    if (preview.mode === 'embedded') {
      const pending = expectedPath + '.observer-delete-' + randomUUID();
      await rename(expectedPath, pending);
      const stat = await lstat(pending);
      if (String(stat.dev) + ':' + String(stat.ino) !== expectedIdentity) {
        await rename(pending, expectedPath);
        throw Error('Database changed during reset; deletion cancelled.');
      }
      await rm(pending, { recursive: true });
    } else {
      await execute(this.reader.bdPath, ['admin', 'reset', '--force'], {
        cwd: this.reader.cwd,
        env: projectEnvironment(process.env),
        timeout: Math.max(this.reader.timeoutMs, 30000),
        maxBuffer: 1024 * 1024,
      });
    }
  }
  async update(draft: Update) {
    const reader = this.reader;
    await reader.location();
    await reader.detail(draft.id);
    await reader.location();
    try {
      await execute(
        reader.bdPath,
        [
          '--json',
          '--actor',
          'beads-observer/user',
          'update',
          draft.id,
          `--title=${draft.title}`,
          `--description=${draft.description}`,
          `--priority=${draft.priority}`,
        ],
        {
          cwd: reader.cwd,
          env: projectEnvironment(process.env),
          timeout: reader.timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
      );
      return await reader.detail(draft.id);
    } catch (caught) {
      const error = errorInfo(caught);
      throw Object.assign(
        new Error(
          `Update could not be confirmed. Check the project before submitting again. ${error.message}`,
        ),
        { status: 502 },
      );
    }
  }
  async addRelation(draft: Relation) {
    const reader = this.reader;
    await reader.location();
    await reader.detail(draft.issue);
    await reader.detail(draft.target);
    await reader.location();
    try {
      const { stdout } = await execute(
        reader.bdPath,
        [
          '--json',
          '--actor',
          'beads-observer/user',
          'dep',
          'add',
          draft.issue,
          draft.target,
          `--type=${draft.type}`,
        ],
        {
          cwd: reader.cwd,
          env: projectEnvironment(process.env),
          timeout: reader.timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
      );
      return {
        issue: draft.issue,
        target: draft.target,
        type: draft.type,
        result: JSON.parse(stdout) as unknown,
      };
    } catch (caught) {
      const error = errorInfo(caught);
      throw Object.assign(
        new Error(
          `Relation could not be confirmed. Check the project before submitting again. ${error.message}`,
        ),
        { status: 502 },
      );
    }
  }
  async create(draft: Draft) {
    const reader = this.reader;
    await reader.location();
    if (draft.parent) {
      await reader.detail(draft.parent);
    }
    await reader.location();
    const args = [
      '--json',
      '--actor',
      'beads-observer/user',
      'create',
      `--title=${draft.title}`,
      `--description=${draft.description}`,
      `--type=${draft.type}`,
      `--priority=${draft.priority}`,
      `--repo=${reader.cwd}`,
    ];
    if (draft.parent) args.push(`--parent=${draft.parent}`);
    try {
      const { stdout } = await execute(reader.bdPath, args, {
        cwd: reader.cwd,
        env: projectEnvironment(process.env),
        timeout: reader.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      const result: IssueDetail = JSON.parse(stdout);
      if (!result?.id) throw Error('No issue ID returned');
      return result;
    } catch (caught) {
      const error = errorInfo(caught);
      throw Object.assign(
        new Error(
          `Creation could not be confirmed. Check the project before submitting again. ${error.message}`,
        ),
        { status: 502 },
      );
    }
  }
}
