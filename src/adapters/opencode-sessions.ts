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
      Omit<SessionRecord, 'activeIssueId'> & {
        activeIssueId: string | null;
        diffs?: SessionDiff[];
        diffFailure?: { scope: string; error: string };
        observationRevision?: string;
      }
    >(),
    controller = new AbortController();
  const contextCache = new Map<
      string,
      {
        revision?: string;
        location: string;
        at: number;
        messages: SessionMessage[];
        diffs?: SessionDiff[];
        diffKey?: string;
        diffScope?: string;
        diffAt?: number;
        diffError?: string;
        permanent?: boolean;
      }
    >(),
    remembered = new Map<string, SessionLink>(),
    dirty = new Set<string>(),
    urgent = new Set<string>(),
    mutations = new Map<string, number>(),
    metadataCache = new Map<
      string,
      {
        info: ObserverSessionInfo;
        belongs: boolean;
        at: number;
      }
    >(),
    scopeCache = new Map<string, { value: boolean; at: number }>();
  let persisted = '',
    catalogCursor: string | undefined;
  // Metadata/activity remain cheap and parallel; never overlap full snapshots.
  let heavyRead: Promise<unknown> = Promise.resolve();
  function heavy<T>(work: () => Promise<T>): Promise<T> {
    const result = heavyRead.then(() => {
      if (closed) throw Error('Session observer closed');
      return work();
    });
    heavyRead = result.catch(() => {});
    return result;
  }
  let closed = false,
    pending: Promise<void> | null = null,
    timer: ReturnType<typeof setTimeout> | null = null,
    timerAt = 0,
    known = new Set<string>(),
    issueMetadataLinks = new Map<string, string[]>(),
    catalogAt = 0,
    issueAt = 0,
    maintenanceAt = 0,
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
        .map(([id, link]) => [id, { ...link }, history.get(id)!]),
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
          recent = [
            ...new Set([...recent, ...ids.filter((id) => !records.has(id))]),
          ];
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
          {
            info: ObserverSessionInfo;
            messages: SessionMessage[];
            cached: NonNullable<ReturnType<typeof contextCache.get>>;
          }
        >(),
        failed = new Set<string>(),
        staleLocations = new Set<string>(),
        sessionWarnings = new Map<string, string[]>();
      async function load(sessionID: string) {
        if (closed || sessions.has(sessionID) || failed.has(sessionID)) return;
        try {
          let metadata = metadataCache.get(sessionID);
          const activityChanged =
            active !== null &&
            Boolean(active[sessionID]) !== previousActive.includes(sessionID);
          if (
            !metadata ||
            (metadata.belongs && activityChanged) ||
            clock() - metadata.at >= (metadata.belongs ? 5000 : 30000)
          ) {
            const info = data(await ctx.session.get({ sessionID }));
            metadata = { info, belongs: await belongs(info), at: clock() };
            metadataCache.set(sessionID, metadata);
            if (metadataCache.size > 600)
              metadataCache.delete(metadataCache.keys().next().value!);
          }
          if (!metadata.belongs) {
            failed.add(sessionID);
            return;
          }
          const info = metadata.info;
          const observationRevision = JSON.stringify([
            info.location,
            info.time,
          ]);
          const old = records.get(sessionID);
          // Stable idle sessions need fresh membership/metadata, not another
          // context/diff just because their messages left the bounded cache.
          if (
            info.time?.updated !== undefined &&
            old?.connected &&
            active !== null &&
            !active[sessionID] &&
            !previousActive.includes(sessionID) &&
            !dirty.has(sessionID) &&
            old.observationRevision === observationRevision &&
            old.status === (info.outcome || 'idle')
          ) {
            const fresh = { ...old, updatedAt: clock() };
            records.set(sessionID, fresh);
            await atomicJSON(filename(sessionID), fresh);
            return;
          }
          let cached = contextCache.get(sessionID);
          const revision = JSON.stringify(info.time);
          const location = JSON.stringify(info.location);
          const force = urgent.delete(sessionID);
          const changed = dirty.delete(sessionID);
          const stopped =
            active !== null &&
            previousActive.includes(sessionID) &&
            !active[sessionID];
          if (cached?.location !== location) cached = undefined;
          const reuse =
            cached &&
            !force &&
            !stopped &&
            (active === null || active[sessionID]
              ? clock() - cached.at < 5000
              : cached.revision === revision && !changed);
          const messages = reuse
            ? cached!.messages
            : data(await heavy(() => ctx.session.context({ sessionID })));
          if (!Array.isArray(messages))
            throw Error('Invalid session.context response');
          const snapshot = {
            ...cached,
            revision,
            location,
            at: reuse ? cached!.at : clock(),
            messages,
          };
          contextCache.set(sessionID, snapshot);
          if (contextCache.size > 128)
            contextCache.delete(contextCache.keys().next().value!);
          sessions.set(sessionID, { info, messages, cached: snapshot });
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
      const maintenance = clock() - maintenanceAt >= 5000;
      if (maintenance) maintenanceAt = clock();
      const idle = maintenance
        ? [...records.keys()].filter((id) => !active?.[id])
        : [];
      const idleBatch = Array.from(
        { length: Math.min(20, idle.length) },
        (_, index) => idle[(idleCursor + index) % idle.length],
      );
      if (maintenance)
        idleCursor = idle.length ? (idleCursor + 20) % idle.length : 0;
      await parallel(
        [
          ...new Set([
            ...Object.keys(active || {}),
            ...previousActive,
            ...dirty,
            ...manual.keys(),
            ...idleBatch,
            ...(maintenance ? recent.splice(0, 20) : []),
          ]),
        ],
        load,
      );
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
      await parallel([...sessions], async ([sessionID, session]) => {
        const { info, messages, cached } = session;
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
        const old = records.get(sessionID);
        let diffs = cached.diffs || old?.diffs || [];
        // Ignore text/output deltas and known read-only tools. Unknown tools
        // can write files too (not just patch), so retain their terminal state.
        // A bounded fallback covers writes inside a still-running shell/execute.
        const tools = messages.flatMap((message) =>
          message.type === 'shell' && message.status !== 'running'
            ? [[message.id, message.status, message.command, message.exit]]
            : (message.content || [])
                .filter(
                  (part) =>
                    part.type === 'tool' &&
                    ['completed', 'error'].includes(part.state?.status || '') &&
                    !/^(read|glob|grep|list|webfetch|websearch)$/.test(
                      part.name || '',
                    ),
                )
                .map((part) => [
                  message.id,
                  part.id,
                  part.name,
                  part.state?.status,
                  part.state?.input,
                ]),
        );
        const runningTool = messages.some(
          (message) =>
            (message.type === 'shell' && message.status === 'running') ||
            message.content?.some(
              (part) =>
                part.type === 'tool' && part.state?.status === 'running',
            ),
        );
        const diffScope = JSON.stringify([
          cached.location,
          messages.filter((message) => message.type === 'user').at(-1)?.id,
        ]);
        // The 128-entry message cache is disposable; a rejected range is not.
        // Keep its tiny marker with the already-retained session record, so
        // historical rotation cannot turn a permanent error into another RPC.
        if (old?.diffFailure?.scope === diffScope) {
          cached.diffScope = diffScope;
          cached.diffError = old.diffFailure.error;
          cached.permanent = true;
        }
        if (cached.diffScope && cached.diffScope !== diffScope) {
          cached.permanent = false;
          cached.diffError = undefined;
        }
        const diffKey = JSON.stringify([
          diffScope,
          tools,
          mutations.get(sessionID) || 0,
          info.outcome,
          active === null
            ? previousActive.includes(sessionID)
            : Boolean(active[sessionID]),
        ]);
        // The default endpoint's turn range cannot be repaired by another tool
        // call. Keep a 400 unavailable until location/range is actually changed
        // (a new user message ID selects a new turn); never retry on token/tools.
        const due =
          !cached.permanent &&
          (cached.diffKey !== diffKey ||
            (clock() - cached.diffAt! >= 30000 &&
              (cached.diffError || runningTool)));
        const coolingDown =
          cached.diffError &&
          !cached.permanent &&
          clock() - cached.diffAt! < 30000;
        if (due && !coolingDown) {
          cached.diffKey = diffKey;
          cached.diffScope = diffScope;
          cached.diffAt = clock();
          try {
            diffs = data(
              await heavy(() =>
                ctx.session.diff
                  ? ctx.session.diff({ sessionID, context: 3 })
                  : api.diff(
                      { sessionID, context: 3 },
                      { signal: controller.signal },
                    ),
              ),
            );
            cached.diffs = diffs;
            cached.diffError = undefined;
            cached.permanent = false;
          } catch (error) {
            const failure = error as Error & { status?: number };
            cached.diffError = 'Diff unavailable: ' + failure.message;
            cached.permanent =
              failure.status === 400 ||
              /HTTP 400|Turn range spans a location change/.test(
                failure.message,
              );
          }
        }
        if (cached.diffError) localWarnings.push(cached.diffError);
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
          diffFailure: cached.permanent
            ? { scope: diffScope, error: cached.diffError! }
            : undefined,
          observationRevision: JSON.stringify([info.location, info.time]),
          connected: true,
          updatedAt: clock(),
        };
        if (active === null && !info.outcome) record.status = 'unknown';
        records.set(sessionID, record);
        await atomicJSON(filename(sessionID), record);
      });
      if (active === null) {
        // Only activity-derived statuses become unknown when observation is
        // unavailable; a confirmed terminal outcome remains authoritative.
        for (const [id, old] of records)
          if (!failed.has(id) && !old.outcome && old.status !== 'unknown') {
            const stale = { ...old, status: 'unknown', updatedAt: clock() };
            records.set(id, stale);
            await atomicJSON(filename(id), stale);
          }
      } else previousActive = Object.keys(active);
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
      else {
        const now = clock();
        const deadlines = previousActive.flatMap((id) => {
          const cached = contextCache.get(id);
          return cached
            ? [cached.at + 5000 > now ? cached.at + 5000 : now + 5000]
            : [];
        });
        if (deadlines.length) schedule(Math.min(...deadlines) - now);
      }
    });
    return pending;
  }
  function schedule(delay = 500) {
    const at = clock() + delay;
    if (!closed && (!timer || at < timerAt)) {
      if (timer) clearTimeout(timer);
      timerAt = at;
      timer = setTimeout(() => {
        timer = null;
        void update().catch((error) =>
          console.warn('[beads.observer] Session refresh: ' + error.message),
        );
      }, delay);
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
            const known = metadataCache.get(event.data.sessionID);
            const moved = /^session\.(created|moved)$/.test(event.type || '');
            if (known && !known.belongs && clock() - known.at < 30000 && !moved)
              continue;
            if (
              /^session\.(created|moved|deleted|renamed|agent\.selected|model\.selected|metadata\.updated|execution\.(started|succeeded|failed|interrupted))$/.test(
                event.type || '',
              )
            )
              metadataCache.delete(event.data.sessionID);
            dirty.add(event.data.sessionID);
            if (
              /^session\.(tool\.(success|failed)|shell\.ended|moved|revert\.(committed|cleared)|execution\.(succeeded|failed|interrupted))$/.test(
                event.type || '',
              )
            ) {
              urgent.add(event.data.sessionID);
              if (!/^session\.(tool\.|shell\.)/.test(event.type || ''))
                mutations.set(
                  event.data.sessionID,
                  (mutations.get(event.data.sessionID) || 0) + 1,
                );
            }
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
      metadataCache.delete(sessionID);
      manual.set(sessionID, [
        ...(manual.get(sessionID) || []).filter((id) => id !== issueId),
        issueId,
      ]);
      await persist();
      dirty.add(sessionID);
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
