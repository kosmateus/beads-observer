import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { atomicJSON } from './hub-files.js';
import { sessionView } from '../domain/session-view.js';
import { resolveSessionLinks } from '../domain/session-links.js';
import { openCodeAPI } from './opencode-api.js';
import { BeadsSource } from './beads-cli.js';
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

const data = <T>(value: ResponseData<T>): T =>
  value && Object.hasOwn(value, 'data')
    ? (value as { data: T }).data
    : (value as T);
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
  }: {
    directory: string;
    projectId: string;
    cwd: string;
    listIssues?: () => Promise<(string | { id: string })[]>;
    beadsLocation?: () => Promise<{ path: string }>;
    api?: OpenCodeAPI;
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
    catalogAt = 0,
    issueAt = 0,
    recent: string[] = [],
    previousActive: string[] = [],
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
    const path = await realpath(info.location.directory);
    if (path === canonical) return true;
    const cached = scopeCache.get(path);
    if (cached && Date.now() - cached.at < 30000) return cached.value;
    let value = false;
    if (beadsLocation)
      try {
        const [own, other] = await Promise.all([
          beadsLocation(),
          new BeadsSource({ cwd: path }).location(),
        ]);
        value = own.path === other.path;
      } catch {}
    scopeCache.set(path, { value, at: Date.now() });
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
        active = data(
          await (ctx.session.active
            ? ctx.session.active()
            : api.active({ signal: controller.signal })),
        );
        if (!active || typeof active !== 'object' || Array.isArray(active))
          throw Error('Invalid session.active response');
      } catch (error) {
        active = null;
        warnings.push(
          'Session activity unavailable: ' + (error as Error).message,
        );
      }
      if (Date.now() - issueAt > 30000) {
        try {
          known = new Set(
            (await listIssues()).map((x) => (typeof x === 'string' ? x : x.id)),
          );
          issueAt = Date.now();
        } catch {
          warnings.push(
            'Beads issue catalog unavailable; automatic links may be incomplete',
          );
        }
      }
      if (
        ctx.session.list &&
        (Date.now() - catalogAt > 30000 || catalogCursor)
      ) {
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
          catalogAt = Date.now();
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
        failed = new Set<string>();
      async function load(sessionID: string) {
        if (closed || sessions.has(sessionID) || failed.has(sessionID)) return;
        try {
          const info = data(await ctx.session.get({ sessionID }));
          if (!(await belongs(info))) {
            failed.add(sessionID);
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
              ? Date.now() - cached.at < 5000
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
            at: reuse ? cached!.at : Date.now(),
            messages,
          };
          contextCache.set(sessionID, snapshot);
          if (contextCache.size > 128)
            contextCache.delete(contextCache.keys().next().value!);
          sessions.set(sessionID, { info, messages, cached: snapshot });
        } catch (error) {
          failed.add(sessionID);
          warnings.push(
            'Session ' + sessionID + ': ' + (error as Error).message,
          );
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
      const links = resolveSessionLinks(sessions, known, manual, remembered);
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
        const localWarnings = [...warnings];
        if (active === null) localWarnings.push('Session activity unavailable');
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
            (Date.now() - cached.diffAt! >= 30000 &&
              (cached.diffError || runningTool)));
        const coolingDown =
          cached.diffError &&
          !cached.permanent &&
          Date.now() - cached.diffAt! < 30000;
        if (due && !coolingDown) {
          cached.diffKey = diffKey;
          cached.diffScope = diffScope;
          cached.diffAt = Date.now();
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
          connected: true,
          updatedAt: Date.now(),
        };
        if (active === null) record.status = 'unknown';
        records.set(sessionID, record);
        await atomicJSON(filename(sessionID), record);
      });
      if (active !== null) previousActive = Object.keys(active);
      await persist().catch((error) =>
        warnings.push('Session storage: ' + error.message),
      );
      for (const id of failed) {
        dirty.delete(id);
        const old = records.get(id);
        if (old) {
          const stale = {
            ...old,
            status: 'unknown',
            connected: false,
            updatedAt: Date.now(),
          };
          records.set(id, stale);
          await atomicJSON(filename(id), stale);
        }
      }
      await atomicJSON(bridgeFile, {
        projectId,
        connected: true,
        activityAvailable: active !== null && issueAt > 0 && catalogAt > 0,
        updatedAt: Date.now(),
        warnings,
      });
    })().finally(() => {
      pending = null;
      if (dirty.size) schedule();
      else {
        const now = Date.now();
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
    const at = Date.now() + delay;
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
          updatedAt: Date.now(),
        });
      await atomicJSON(bridgeFile, {
        projectId,
        connected: false,
        activityAvailable: false,
        updatedAt: Date.now(),
        warnings: ['Session observer disconnected'],
      });
    },
  };
}
