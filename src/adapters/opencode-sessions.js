import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { atomicJSON } from './hub-files.js';
import { sessionView } from '../domain/session-view.js';
import { resolveSessionLinks } from '../domain/session-links.js';
import { openCodeAPI } from './opencode-api.js';
import { BeadsSource } from './beads-cli.js';
const data = (value) =>
  value && Object.hasOwn(value, 'data') ? value.data : value;
async function parallel(items, work) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) await work(items[cursor++]);
    }),
  );
}
/** Project-scoped V2 session discovery. No dependence on parent execution state. */
export async function observeOpenCodeSessions(
  ctx,
  {
    directory,
    projectId,
    cwd,
    listIssues = async () => [],
    beadsLocation,
    api = openCodeAPI(),
  },
) {
  const host = randomUUID(),
    manual = new Map(),
    history = new Map(),
    records = new Map(),
    controller = new AbortController();
  const contextCache = new Map(),
    remembered = new Map(),
    dirty = new Set(),
    scopeCache = new Map();
  let persisted = '',
    catalogCursor;
  let closed = false,
    pending = null,
    timer = null,
    known = new Set(),
    catalogAt = 0,
    issueAt = 0,
    recent = [],
    previousActive = [],
    idleCursor = 0;
  const filename = (id) =>
    join(
      directory,
      `session-${projectId}-${createHash('sha256')
        .update(id + host)
        .digest('hex')}.json`,
    );
  const canonical = await realpath(cwd),
    storageKey = 'beads-observer.sessions.' + projectId;
  const bridgeFile = join(directory, `bridge-${projectId}-${host}.json`);
  async function belongs(info) {
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
      scopeCache.delete(scopeCache.keys().next().value);
    return value;
  }
  const saved = await ctx.storage.get(storageKey).catch(() => null);
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
  if (Array.isArray(saved?.automatic))
    for (const [id, link, issues] of saved.automatic.slice(-500)) {
      if (typeof id === 'string' && typeof link?.issueId === 'string') {
        remembered.set(id, link);
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
        .map(([id, link]) => [id, link, history.get(id) || []]),
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
      const warnings = [];
      let active = null;
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
        warnings.push('Session activity unavailable: ' + error.message);
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
          warnings.push('Session discovery unavailable: ' + error.message);
        }
      }
      const sessions = new Map(),
        failed = new Set();
      async function load(sessionID) {
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
            contextCache.delete(contextCache.keys().next().value);
          sessions.set(sessionID, { info, messages });
        } catch (error) {
          failed.add(sessionID);
          warnings.push('Session ' + sessionID + ': ' + error.message);
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
      if (active !== null) previousActive = Object.keys(active);
      const links = resolveSessionLinks(sessions, known, manual, remembered);
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
        const localWarnings = [...warnings];
        if (active === null) localWarnings.push('Session activity unavailable');
        if (link?.ambiguous)
          localWarnings.push(
            'Several Beads IDs found; no current task selected automatically',
          );
        const cached = contextCache.get(sessionID) || {},
          old = records.get(sessionID);
        let diffs = cached.diffs || [];
        if (
          !old ||
          old.time?.updated !== info.time?.updated ||
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
            active?.[sessionID],
            diffs,
            localWarnings,
          ),
          projectId,
          issueIds,
          activeIssueId: link?.issueId || null,
          linkSource: link?.source || null,
          parentSessionID: info.parentID || null,
          connected: true,
          updatedAt: Date.now(),
        };
        if (active === null) record.status = 'unknown';
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
          console.warn('[beads.observer] Session events: ' + error.message);
      }
      if (!closed)
        await new Promise((resolve) => {
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
      clearTimeout(timer);
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
