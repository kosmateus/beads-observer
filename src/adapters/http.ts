import { VERSION } from '../version.js';
import { readSessionRecords } from './session-records.js';
import { ResetProject } from '../application/reset-project.js';
import { UpdateIssue } from '../application/update-issue.js';
import { AddRelation } from '../application/add-relation.js';
import { randomBytes } from 'node:crypto';
import { CreateIssue } from '../application/create-issue.js';
import { createServer } from 'node:http';
import { readFile, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Projects } from '../application/projects.js';
import { errorInfo } from '../types.js';
interface BridgeRecord {
  projectId: string;
  updatedAt: number;
  connected?: boolean;
  activityAvailable?: boolean;
  warnings?: unknown[];
}
interface EventClient {
  res: ServerResponse;
  projectId?: string;
  catalog: boolean;
  revision: string | null;
  waiting?: boolean;
  pending?: { event: string; data: unknown } | null;
}

export async function readActivityAvailability(
  directory: string | undefined,
  projectId: string,
) {
  const bridges: BridgeRecord[] = [],
    now = Date.now();
  let files;
  try {
    if (!directory) return { available: false, warnings: [] };
    files = await readdir(directory);
  } catch {
    return { available: false, warnings: [] };
  }
  for (const file of files.filter(
    (name) => name.startsWith(`bridge-${projectId}-`) && name.endsWith('.json'),
  )) {
    let handle;
    try {
      // Open without following links, then inspect the actual opened file (no lstat/read race).
      handle = await open(
        join(directory, file),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536) continue;
      const record: BridgeRecord = JSON.parse(await handle.readFile('utf8'));
      if (
        record.projectId !== projectId ||
        !Number.isFinite(record.updatedAt) ||
        record.updatedAt > now ||
        now - record.updatedAt >= 15000
      )
        continue;
      bridges.push(record);
    } catch {
    } finally {
      await handle?.close();
    }
  }
  return {
    available:
      bridges.length > 0 &&
      bridges.every(
        (record) =>
          record.connected === true && record.activityAvailable === true,
      ),
    warnings: [
      ...new Set(
        bridges.flatMap((record) =>
          Array.isArray(record.warnings)
            ? record.warnings.filter(
                (warning): warning is string => typeof warning === 'string',
              )
            : [],
        ),
      ),
    ],
  };
}
const assets = new Map<string, string[]>([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ...[
    'app',
    'routes',
    'sessions',
    'reset',
    'i18n',
    'catalogs',
    'value-labels',
    'person-activity',
    'graph',
    'priority',
    'flags',
    'select',
    'types',
    'epics',
  ].map((name): [string, string[]] => [
    `/${name}.js`,
    [`${name}.js`, 'text/javascript; charset=utf-8'],
  ]),
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
export async function listenHttp(
  projects: Projects,
  {
    port,
    runtimeId,
    protocol,
    sessionDirectory,
  }: {
    port: number;
    runtimeId: string;
    protocol: number;
    sessionDirectory?: string;
  },
) {
  const clients = new Set<EventClient>();
  const resetProject = new ResetProject(projects);
  const addRelation = new AddRelation(projects);
  const updateIssue = new UpdateIssue(projects);
  const createIssue = new CreateIssue(projects),
    csrfToken = randomBytes(32).toString('hex');
  let actualPort!: number;
  function send(client: EventClient, event: string, data: unknown) {
    if (client.res.destroyed || client.res.writableEnded) return;
    // write(false) means accepted but buffered, not failed. Keep only the newest
    // unsent snapshot while the socket drains so slow readers cannot grow a queue.
    if (client.waiting) {
      client.pending = { event, data };
      return;
    }
    client.waiting = !client.res.write(
      `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`,
    );
    if (client.waiting)
      client.res.once('drain', () => {
        client.waiting = false;
        const pending = client.pending;
        client.pending = null;
        if (pending) send(client, pending.event, pending.data);
      });
  }
  const server = createServer(async (req, res) => {
    const allowed = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    );
    if (
      !allowed.includes(req.headers.host || '') ||
      (req.headers.origin &&
        !allowed.map((host) => 'http://' + host).includes(req.headers.origin))
    ) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (
        req.method === 'POST' &&
        /^\/api\/projects\/[^/]+\/(issues|relations|updates|reset-preview|reset)$/.test(
          url.pathname,
        )
      ) {
        if (
          !req.headers.origin ||
          req.headers['x-observer-token'] !== csrfToken ||
          !req.headers['content-type']?.startsWith('application/json')
        ) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        let raw = '',
          size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 100000)
            throw Object.assign(new Error('Request too large'), {
              status: 413,
            });
          raw += chunk;
        }
        let draft;
        try {
          draft = JSON.parse(raw);
        } catch {
          throw Object.assign(new Error('Invalid JSON'), { status: 400 });
        }
        if (
          url.pathname.endsWith('/reset-preview') ||
          url.pathname.endsWith('/reset')
        ) {
          const projectId = decodeURIComponent(url.pathname.split('/')[3]);
          const result = url.pathname.endsWith('/reset-preview')
            ? await resetProject.prepare(projectId)
            : await resetProject.execute(projectId, draft);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        const useCase = url.pathname.endsWith('/relations')
          ? addRelation
          : url.pathname.endsWith('/updates')
            ? updateIssue
            : createIssue;
        const result = await useCase.execute(
          decodeURIComponent(url.pathname.split('/')[3]),
          req.headers['x-request-id'],
          draft,
        );
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method || '')) {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end('Method not allowed');
        return;
      }

      const sessionMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/sessions$/,
      );
      if (sessionMatch) {
        const project = projects.get(decodeURIComponent(sessionMatch[1]));
        if (url.searchParams.get('summary') === '1') {
          const availability = await readActivityAvailability(
            sessionDirectory,
            project.id,
          );
          const sessions = availability.available
            ? await readSessionRecords(sessionDirectory, project.id)
            : [];
          const activity: Record<
            string,
            { agent?: string; sessionID: string }[]
          > = {};
          for (const session of sessions)
            if (
              session.connected &&
              session.status === 'running' &&
              session.activeIssueId &&
              project.observer.state.issues.some(
                (x) => x.id === session.activeIssueId,
              )
            )
              (activity[session.activeIssueId] ??= []).push({
                agent: session.agent,
                sessionID: session.sessionID,
              });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ activity, ...availability }));
          return;
        }
        const issueId = url.searchParams.get('issue');
        if (!project.observer.state.issues.some((x) => x.id === issueId))
          throw Object.assign(Error('Unknown issue'), { status: 404 });
        const sessions = await readSessionRecords(
          sessionDirectory,
          project.id,
          issueId,
        );
        const availability = await readActivityAvailability(
          sessionDirectory,
          project.id,
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions, ...availability }));
        return;
      }
      const match = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/(snapshot|events|issues\/([^/]+))$/,
      );
      const catalog = url.pathname === '/api/projects/events';
      let projectId = match ? decodeURIComponent(match[1]) : undefined;
      const action = match ? match[2] : url.pathname.slice(5);
      if (catalog || action === 'events') {
        if (!catalog) projectId = projects.get(projectId).id;
        if (req.method === 'HEAD') {
          res.writeHead(200);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const initial = catalog
          ? projects.list()
          : projects.snapshot(projectId);
        const state = catalog ? null : projects.snapshot(projectId);
        const client: EventClient = {
          res,
          projectId,
          catalog,
          revision: catalog
            ? null
            : JSON.stringify([state!.revision, state!.error, state!.updatedAt]),
        };
        clients.add(client);
        send(client, '', initial);
        res.on('close', () => {
          client.pending = null;
          clients.delete(client);
        });
        return;
      }
      let body,
        type = 'application/json; charset=utf-8';
      if (url.pathname === '/api/capabilities')
        body = JSON.stringify({ csrfToken });
      else if (url.pathname === '/api/health')
        body = JSON.stringify({
          application: 'beads-observer',
          version: VERSION,
          protocol,
          runtimeId,
        });
      else if (url.pathname === '/api/projects')
        body = JSON.stringify(projects.list());
      else if (
        (match && action === 'snapshot') ||
        url.pathname === '/api/snapshot'
      )
        body = JSON.stringify(projects.snapshot(projectId));
      else if (
        (match && action.startsWith('issues/')) ||
        url.pathname.startsWith('/api/issues/')
      ) {
        const id = decodeURIComponent(
          match ? match[3] : url.pathname.slice(12),
        );
        body = JSON.stringify(
          await projects
            .get(projectId)
            .observer.detail(id, url.searchParams.get('activity') === '1'),
        );
      } else if (
        /^\/projects\/[^/]+\/(board|graph|list|activity|issues\/[^/]+|agents\/[^/]+)\/?$/.test(
          url.pathname,
        )
      ) {
        type = 'text/html; charset=utf-8';
        body = await readFile(new URL('../../web/index.html', import.meta.url));
      } else if (assets.has(url.pathname)) {
        const asset = assets.get(url.pathname)!;
        type = asset[1];
        body = await readFile(
          new URL(`../../web/${asset[0]}`, import.meta.url),
        );
      } else {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (caught) {
      const error = errorInfo(caught);
      res.writeHead(error.status || 502, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ error: String(error.message) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      actualPort = (server.address() as AddressInfo).port;
      resolve();
    });
  });
  const unsubscribe = projects.subscribe((list) => {
    for (const client of clients) {
      if (client.catalog) {
        send(client, '', list);
        continue;
      }
      try {
        const state = projects.snapshot(client.projectId);
        const revision = JSON.stringify([
          state.revision,
          state.error,
          state.updatedAt,
        ]);
        if (client.revision !== revision) {
          client.revision = revision;
          send(client, '', state);
        }
      } catch {
        send(client, 'project-removed', { projectId: client.projectId });
        client.res.end();
        clients.delete(client);
      }
    }
  });
  const heartbeat = setInterval(() => {
    for (const client of clients)
      if (!client.waiting && !client.res.destroyed)
        client.res.write(': heartbeat\n\n');
  }, 15000);
  heartbeat.unref();
  return {
    url: `http://127.0.0.1:${actualPort}`,
    async close() {
      clearInterval(heartbeat);
      unsubscribe();
      for (const client of clients) client.res.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
