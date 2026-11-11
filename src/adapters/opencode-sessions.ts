import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { atomicJSON } from './hub-files.js';
import { sessionView } from '../domain/session-view.js';
import {
  metadataSessionLinks,
  resolveSessionLinks,
} from '../domain/session-links.js';
import { openCodeAPI } from './opencode-api.js';
import { BeadsSource, MissingBeadsWorkspaceError } from './beads-cli.js';
import type {
  SessionDiff,
  SessionLink,
  SessionMessage,
  SessionRecord,
} from '../types.js';
import type {
  Activity,
  ObserverContext,
  ObserverSessionInfo,
  OpenCodeAPI,
  ResponseData,
  SessionBridge,
} from './opencode-types.js';

class MissingSessionLocationError extends Error {}

const data = <T>(value: ResponseData<T>): T =>
  value && Object.hasOwn(value, 'data')
    ? (value as { data: T }).data
    : (value as T);
function activeSessions(value: unknown): Activity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid session.active response');
  const result: Activity = {};
  for (const [sessionID, status] of Object.entries(value)) {
    if (
      !sessionID ||
      !status ||
      typeof status !== 'object' ||
      Array.isArray(status) ||
      (status as { type?: unknown }).type !== 'running'
    )
      throw Error('Invalid session.active response');
    result[sessionID] = { type: 'running' };
  }
  return result;
}
async function parallel<T>(items: T[], work: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) await work(items[cursor++]);
    }),
  );
}
/** Project-scoped V2 session discovery. No dependence on parent execution state. */
export async function observeOpenCodeSessions(
  ctx: ObserverContext,
  {
    directory,
    projectId,
    cwd,
    listIssues = async () => [],
    beadsLocation,
    api = openCodeAPI(),
    clock = Date.now,
  }: {
    directory: string;
    projectId: string;
    cwd: string;
    listIssues?: () => Promise<(string | { id: string; metadata?: unknown })[]>;
    beadsLocation?: () => Promise<{ path: string }>;
    api?: OpenCodeAPI;
    clock?: () => number;
  },
): Promise<SessionBridge> {
  const host = randomUUID(),
    manual = new Map<string, string[]>(),
    history = new Map<string, string[]>(),
    records = new Map<
      string,
      Omit<SessionRecord, 'activeIssueId'> & { activeIssueId: string | null }
    >(),
    controller = new AbortController();
  const contextCache = new Map<
      string,
      { revision?: string; messages: SessionMessage[]; diffs?: SessionDiff[] }
    >(),
    remembered = new Map<string, SessionLink>(),
    dirty = new Set<string>(),
    scopeCache = new Map<string, { value: boolean; at: number }>();
  let persisted = '',
    catalogCursor: string | undefined;
  let closed = false,
    pending: Promise<void> | null = null,
    timer: ReturnType<typeof setTimeout> | null = null,
    known = new Set<string>(),
    issueMetadataLinks = new Map<string, string[]>(),
    catalogAt = 0,
    issueAt = 0,
    recent: string[] = [],
    previousActive: string[] = [],
    lastActive: Activity | null = null,
    lastActiveAt = 0,
    idleCursor = 0;
  const filename = (id: string) =>
    join(
      directory,
      `session-${projectId}-${createHash('sha256')
        .update(id + host)
        .digest('hex')}.json`,
    );
  const canonical = await realpath(cwd),
    storageKey = 'beads-observer.sessions.' + projectId;
  const bridgeFile = join(directory, `bridge-${projectId}-${host}.json`);
  async function belongs(info: ObserverSessionInfo) {
    if (!info.location?.directory) return false;
    let path: string;
    try {
      path = await realpath(info.location.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new MissingSessionLocationError();
      throw error;
    }
    if (path === canonical) return true;
    const cached = scopeCache.get(path);
    if (cached && clock() - cached.at < 30000) return cached.value;
    let value = false;
    if (beadsLocation)
      try {
        const [own, other] = await Promise.all([
          beadsLocation(),
          new BeadsSource({ cwd: path }).location(),
        ]);
        value = own.path === other.path;
      } catch (error) {
        if (!(error instanceof MissingBeadsWorkspaceError)) throw error;
      }
    scopeCache.set(path, { value, at: clock() });
    if (scopeCache.size > 600)
      scopeCache.delete(scopeCache.keys().next().value!);
    return value;
  }
  const saved = (await ctx.storage.get(storageKey).catch(() => null)) as
    | null
    | {
        manual?: unknown;
        automatic?: [unknown, SessionLink | null, unknown][];
      }
    | unknown[];
  const entries = Array.isArray(saved) ? saved : saved?.manual;
  if (Array.isArray(entries))
    for (const entry of entries.slice(-100))
      if (
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        Array.isArray(entry[1])
      )
        manual.set(
          entry[0],
          entry[1].filter((x) => typeof x === 'string'),
        );
  if (saved && !Array.isArray(saved) && Array.isArray(saved.automatic))
    for (const [id, link, issues] of saved.automatic.slice(-500)) {
      if (typeof id === 'string' && typeof link?.issueId === 'string') {
        remembered.set(id, link!);
        history.set(
          id,
          Array.isArray(issues)
            ? issues.filter((x) => typeof x === 'string')
            : [],
        );
      }
    }
  async function persist() {
    const value = {
      manual: [...manual],
      automatic: [...remembered]
        .slice(-500)
        .map(([id, link]) => [id, { ...link }, history.get(id) || []]),
    };
    const signature = JSON.stringify(value);
    if (signature !== persisted) {
      await ctx.storage.set(storageKey, value);
      persisted = signature;
    }
  }
  async function update() {
    if (closed || pending) return pending;
    pending = (async () => {
      const warnings: string[] = [];
      let active: Activity | null = null;
      try {
        active = activeSessions(
          data(
            await (ctx.session.active
              ? ctx.session.active()
              : api.active({ signal: controller.signal })),
          ),
        );
        lastActive = active;
        lastActiveAt = clock();
      } catch (error) {
        active =
          lastActive && clock() - lastActiveAt < 15000 ? lastActive : null;
        warnings.push(
          'Session activity unavailable: ' + (error as Error).message,
        );
      }
      if (clock() - issueAt > 30000) {
        try {
          const issues = await listIssues();
          known = new Set(
            issues.map((x) => (typeof x === 'string' ? x : x.id)),
          );
          issueMetadataLinks = metadataSessionLinks(
            issues.filter(
              (x): x is { id: string; metadata?: unknown } =>
                typeof x !== 'string',
            ),
          );
          issueAt = clock();
        } catch {
          warnings.push(
            'Beads issue catalog unavailable; automatic links may be incomplete',
          );
        }
      }
      if (ctx.session.list && (clock() - catalogAt > 30000 || catalogCursor)) {
        try {
          const filter = ctx.location?.project?.id
            ? { project: ctx.location.project.id }
            : { directory: canonical };
          const result = await ctx.session.list(
            catalogCursor
              ? { cursor: catalogCursor, limit: 100 }
              : { ...filter, limit: 100, order: 'desc' },
          );
          const ids = data(result).map((x) => x.id);
          catalogCursor = result.cursor?.next;
          recent = [...new Set([...recent, ...ids])];
          catalogAt = clock();
        } catch (error) {
          catalogCursor = undefined;
          warnings.push(
            'Session discovery unavailable: ' + (error as Error).message,
          );
        }
      }
      const sessions = new Map<
          string,
          { info: ObserverSessionInfo; messages: SessionMessage[] }
        >(),
        failed = new Set<string>(),
        staleLocations = new Set<string>(),
        sessionWarnings = new Map<string, string[]>();
      async function load(sessionID: string) {
        if (closed || sessions.has(sessionID) || failed.has(sessionID)) return;
        try {
          const info = data(await ctx.session.get({ sessionID }));
          if (!(await belongs(info))) {
            failed.add(sessionID);
            return;
          }
          const cached = contextCache.get(sessionID);
          const revision = JSON.stringify(info.time);
          const messages =
            cached?.revision === revision &&
            !active?.[sessionID] &&
            !dirty.has(sessionID)
              ? cached.messages
              : data(await ctx.session.context({ sessionID }));
          if (!Array.isArray(messages))
            throw Error('Invalid session.context response');
          contextCache.set(sessionID, {
            revision,
            messages,
            diffs: cached?.diffs,
          });
          dirty.delete(sessionID);
          if (contextCache.size > 128)
            contextCache.delete(contextCache.keys().next().value!);
          sessions.set(sessionID, { info, messages });
          sessionWarnings.delete(sessionID);
        } catch (error) {
          failed.add(sessionID);
          if (error instanceof MissingSessionLocationError)
            staleLocations.add(sessionID);
          else
            sessionWarnings.set(sessionID, [
              'Session read unavailable: ' + (error as Error).message,
            ]);
        }
      }
      // Active sessions and event IDs bypass the bounded historical queue.
      const idle = [...records.keys()].filter((id) => !active?.[id]);
      const idleBatch = Array.from(
        { length: Math.min(20, idle.length) },
        (_, index) => idle[(idleCursor + index) % idle.length],
      );
      idleCursor = idle.length ? (idleCursor + 20) % idle.length : 0;
      await parallel(
        [
          ...new Set([
            ...Object.keys(active || {}),
            ...previousActive,
            ...dirty,
            ...manual.keys(),
            ...idleBatch,
            ...recent.splice(0, 20),
          ]),
        ],
        load,
      );
      previousActive = active === null ? [] : Object.keys(active);
      const linkSessions = new Map(
        [...sessions].map(([id, session]) => [
          id,
          { messages: session.messages, metadata: session.info.metadata },
        ]),
      );
      const links = resolveSessionLinks(
        linkSessions,
        known,
        manual,
        remembered,
        issueMetadataLinks,
      );
      await parallel([...sessions], async ([sessionID, { info, messages }]) => {
        if (closed) return;
        const link = links.get(sessionID);
        const previous = history.get(sessionID) || [];
        const issueIds = [
          ...new Set([
            ...previous,
            ...(manual.get(sessionID) || []),
            ...(link?.issueId ? [link.issueId] : []),
          ]),
        ];
        if (!issueIds.length) return;
        history.set(sessionID, issueIds);
        if (link?.issueId && !manual.has(sessionID))
          remembered.set(sessionID, link);
        else if (link?.ambiguous) remembered.delete(sessionID);
        const localWarnings = [...(sessionWarnings.get(sessionID) || [])];
        if (link?.ambiguous)
          localWarnings.push(
            'Several Beads IDs found; no current task selected automatically',
          );
        const cached = contextCache.get(sessionID) || { messages: [] },
          old = records.get(sessionID);
        let diffs = cached.diffs || [];
        if (
          !old ||
          (old.time as ObserverSessionInfo['time'])?.updated !==
            info.time?.updated ||
          active?.[sessionID]
        ) {
          diffs = await (
            ctx.session.diff
              ? ctx.session.diff({ sessionID, context: 3 })
              : api.diff(
                  { sessionID, context: 3 },
                  { signal: controller.signal },
                )
          )
            .then(data)
            .catch((error) => {
              localWarnings.push('Diff: ' + error.message);
              return cached.diffs || [];
            });
          cached.diffs = diffs;
        }
        const record = {
          ...sessionView(
            info,
            messages,
            Boolean(active?.[sessionID]),
            diffs,
            localWarnings,
          ),
          projectId,
          issueIds,
          activeIssueId: link?.issueId || null,
          linkSource: link?.source || null,
          parentSessionID: info.parentID || null,
          connected: true,
          updatedAt: clock(),
        };
        if (active === null && !info.outcome) record.status = 'unknown';
        records.set(sessionID, record);
        await atomicJSON(filename(sessionID), record);
      });
      await persist().catch((error) =>
        warnings.push('Session storage: ' + error.message),
      );
      for (const id of failed) {
        dirty.delete(id);
        const old = records.get(id);
        if (old) {
          const stale = {
            ...old,
            status:
              staleLocations.has(id) &&
              typeof old.status === 'string' &&
              ['succeeded', 'failed', 'interrupted'].includes(old.status)
                ? old.status
                : 'unknown',
            connected: false,
            updatedAt: old.updatedAt,
            warnings: sessionWarnings.get(id) || [],
          };
          records.set(id, stale);
          await atomicJSON(filename(id), stale);
        }
      }
      await atomicJSON(bridgeFile, {
        projectId,
        connected: true,
        activityAvailable: active !== null && issueAt > 0 && catalogAt > 0,
        updatedAt: clock(),
        warnings,
      });
    })().finally(() => {
      pending = null;
      if (dirty.size) schedule();
    });
    return pending;
  }
  function schedule() {
    if (!closed && !timer) {
      timer = setTimeout(() => {
        timer = null;
        void update().catch((error) =>
          console.warn('[beads.observer] Session refresh: ' + error.message),
        );
      }, 500);
      timer.unref?.();
    }
  }
  const heartbeat = setInterval(schedule, 5000);
  heartbeat.unref?.();
  // Unknown sessions must also trigger discovery: they may be new background children.
  const streamTask = (async () => {
    while (!closed) {
      try {
        for await (const raw of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          if (closed) break;
          const event = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (event.data?.sessionID) {
            dirty.add(event.data.sessionID);
            schedule();
          }
        }
      } catch (error) {
        if (!closed)
          console.warn(
            '[beads.observer] Session events: ' + (error as Error).message,
          );
      }
      if (!closed)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(t);
            controller.signal.removeEventListener('abort', done);
            resolve();
          };
          const t = setTimeout(done, 1000);
          t.unref?.();
          controller.signal.addEventListener('abort', done, { once: true });
        });
    }
  })();
  schedule();
  return {
    refresh: update,
    async bind(sessionID, issueId) {
      const info = data(await ctx.session.get({ sessionID }));
      if (!(await belongs(info)))
        throw Error('Session belongs to another project');
      manual.set(sessionID, [
        ...(manual.get(sessionID) || []).filter((id) => id !== issueId),
        issueId,
      ]);
      await persist();
      await pending;
      await update();
    },
    async close() {
      closed = true;
      controller.abort();
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      await streamTask;
      await pending?.catch(() => {});
      for (const [id, record] of records)
        await atomicJSON(filename(id), {
          ...record,
          connected: false,
          status: 'unknown',
          updatedAt: clock(),
        });
      await atomicJSON(bridgeFile, {
        projectId,
        connected: false,
        activityAvailable: false,
        updatedAt: clock(),
        warnings: ['Session observer disconnected'],
      });
    },
  };
}
