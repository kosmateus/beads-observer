import { statusTimeline } from '../domain/status-timeline.js';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { array, normalize } from '../domain/model.js';
import type { Issue, Location, StatusEvent } from '../types.js';
import { errorInfo } from '../types.js';
const exec = promisify(execFile);
type Snapshot = ReturnType<typeof normalize> & {
  location: Location;
  beadsVersion: string | null;
};
export class MissingBeadsWorkspaceError extends Error {
  readonly code = 'BEADS_NO_WORKSPACE';
  constructor() {
    super('Beads workspace does not exist');
    this.name = 'MissingBeadsWorkspaceError';
  }
}

export function isMissingBeadsWorkspaceError(error: unknown) {
  if (error instanceof MissingBeadsWorkspaceError) return true;
  if (!(error instanceof Error)) return false;
  const stdout = (error as Error & { stdout?: unknown }).stdout;
  if (typeof stdout !== 'string') return false;
  try {
    return JSON.parse(stdout).error === 'no_beads_directory';
  } catch {
    return false;
  }
}

export class BeadsSource {
  #activeReads = 0;
  #readQueue: (() => void)[] = [];
  #snapshotRequest: Promise<Snapshot> | null = null;
  cwd: string;
  bdPath: string;
  timeoutMs: number;
  pinnedLocation?: string;
  versionRequest?: Promise<string | null> | null;
  async run<T = Record<string, unknown>>(args: string[]): Promise<T> {
    if (this.#activeReads >= 2)
      await new Promise<void>((resolve) => this.#readQueue.push(resolve));
    else this.#activeReads++;
    try {
      return await this.execute<T>(args);
    } finally {
      const next = this.#readQueue.shift();
      if (next) next();
      else this.#activeReads--;
    }
  }
  constructor({
    cwd,
    bdPath = 'bd',
    timeoutMs = 15000,
    beadsLocation,
  }: {
    cwd: string;
    bdPath?: string;
    timeoutMs?: number;
    beadsLocation?: string | null;
  }) {
    this.cwd = cwd;
    this.bdPath = bdPath;
    this.timeoutMs = timeoutMs;
    // canonicalProject supplied a realpath-verified location when available.
    this.pinnedLocation = beadsLocation || undefined;
  }
  async execute<T = Record<string, unknown>>(args: string[]): Promise<T> {
    let stdout: string;
    try {
      ({ stdout } = await exec(this.bdPath, ['--readonly', '--json', ...args], {
        cwd: this.cwd,
        timeout: this.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: projectEnvironment(process.env),
        windowsHide: true,
      }));
    } catch (error) {
      if (isMissingBeadsWorkspaceError(error))
        throw new MissingBeadsWorkspaceError();
      throw error;
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error('Beads nie zwrócił poprawnego JSON');
    }
  }
  async location() {
    const location = await this.run<Location>(['where']);
    if (!location.path) throw new MissingBeadsWorkspaceError();
    let actual: string;
    try {
      actual = await realpath(location.path);
    } catch (error) {
      if (errorInfo(error).code === 'ENOENT')
        throw new MissingBeadsWorkspaceError();
      throw error;
    }
    if (this.pinnedLocation && this.pinnedLocation !== actual)
      throw new Error(
        `Beads location changed: ${this.pinnedLocation} -> ${actual}. Re-register this project.`,
      );
    this.pinnedLocation = actual;
    return { ...location, path: actual };
  }
  async version() {
    if (!this.versionRequest)
      this.versionRequest = exec(this.bdPath, ['--version'], {
        cwd: this.cwd,
        env: projectEnvironment(process.env),
        timeout: this.timeoutMs,
        windowsHide: true,
      })
        .then(({ stdout }) => stdout.trim())
        .catch(() => {
          this.versionRequest = null;
          return null;
        });
    return this.versionRequest;
  }
  async issueCatalog() {
    await this.location();
    const issues = await this.run([
      'list',
      '--all',
      '--limit',
      '0',
      '--include-gates',
      '--include-infra',
      '--include-templates',
    ]);
    await this.location();
    return array<Issue>(issues);
  }
  snapshot(): Promise<Snapshot> {
    if (this.#snapshotRequest) return this.#snapshotRequest;
    this.#snapshotRequest = this.#readSnapshot().finally(() => {
      this.#snapshotRequest = null;
    });
    return this.#snapshotRequest;
  }
  async #readSnapshot(): Promise<Snapshot> {
    // Unpinned sources establish identity first; pinned reads validate after.
    if (!this.pinnedLocation) await this.location();
    const [issues, ready, blocked] = await Promise.all([
      this.run([
        'list',
        '--all',
        '--limit',
        '0',
        '--include-gates',
        '--include-infra',
        '--include-templates',
      ]),
      this.run(['ready', '--limit', '0']),
      this.run(['blocked']),
    ]);
    const location = await this.location();
    return {
      ...normalize(issues, ready, blocked),
      location,
      beadsVersion: await this.version(),
    };
  }
  async activity(id: string) {
    await this.location();
    const [comments, events] = await Promise.all([
      this.run(['comments', '--', id]),
      this.run(['history', '--events', '--limit', '0', '--', id]).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error: errorInfo(error) }),
      ),
    ]);
    await this.location();
    return {
      id,
      comments: array(comments),
      statusEvents: array(events.value),
      statusEventsWarning: events.error?.message,
    };
  }
  async detail(id: string) {
    await this.location();
    const [data, comments, historyResult, eventsResult] = await Promise.all([
      this.run<Issue | Issue[]>(['show', `--id=${id}`, '--long']),
      this.run(['comments', '--', id]),
      this.run(['history', '--limit', '50', '--', id]).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error: errorInfo(error) }),
      ),
      this.run(['history', '--events', '--limit', '0', '--', id]).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error: errorInfo(error) }),
      ),
    ]);
    const issue = Array.isArray(data) ? data[0] : data;
    const history = array(historyResult.value),
      statusEvents = array<StatusEvent>(eventsResult.value);
    const historyWarning = historyResult.error
      ? `Historia niedostępna: ${historyResult.error.message}`
      : undefined;
    const statusEventsWarning = eventsResult.error?.message;
    await this.location();
    return {
      ...issue,
      comments: array(comments),
      history,
      historyWarning,
      statusEvents,
      statusEventsWarning,
      statusTimeline: statusTimeline(issue, statusEvents),
    };
  }
}

/** Never inherit another project's Beads/Dolt/Git routing into a project reader. */
export function projectEnvironment(parent: NodeJS.ProcessEnv) {
  const env = Object.fromEntries(
    Object.entries(parent).filter(
      ([key]) =>
        !/^(BEADS_|BD_|DOLT_)/i.test(key) &&
        ![
          'GIT_DIR',
          'GIT_WORK_TREE',
          'GIT_COMMON_DIR',
          'GIT_INDEX_FILE',
        ].includes(key.toUpperCase()),
    ),
  );
  return { ...env, NO_COLOR: '1' };
}
