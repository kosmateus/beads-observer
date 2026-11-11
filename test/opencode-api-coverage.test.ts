import assert from 'node:assert/strict';
import { test } from 'node:test';

test('API discovery and failure boundaries without host filesystem or network', async (t) => {
  const pid = 987654;
  const state = '/tmp/opencode/observer-api-fixture';
  const service = `${state}/opencode/service.json`;
  let files = new Map<string, string>();
  let links = new Map<string, string>();
  let reads: string[] = [];
  let requests: { url: URL; options: RequestInit | undefined }[] = [];
  let respond: (
    url: URL,
    options?: RequestInit,
  ) => Response | Promise<Response>;
  let now = 100000;
  t.mock.module('node:os', { namedExports: { homedir: () => state } });
  t.mock.module('node:fs/promises', {
    namedExports: {
      readFile: async (path: string) => {
        reads.push(path);
        const text = files.get(path);
        if (text === undefined) throw Error('fixture file missing');
        return text;
      },
      readdir: async (path: string) => {
        assert.equal(path, `/proc/${pid}/fd`);
        return [...links.keys()];
      },
      readlink: async (path: string) => {
        const target = links.get(path.split('/').at(-1)!);
        if (!target) throw Error('fixture descriptor disappeared');
        return target;
      },
    },
  });
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, options });
      return respond(url, options);
    },
  );
  t.mock.method(Date, 'now', () => now);
  const { openCodeAPI } = await import('../src/adapters/opencode-api.js');
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status });
  const registered = (url = 'http://localhost:4321', password?: string) =>
    files.set(service, JSON.stringify({ pid, url, password }));
  const api = (argv: string[] = []) =>
    openCodeAPI({ pid, env: { XDG_STATE_HOME: state }, argv });
  async function scenario(name: string, run: () => Promise<void>) {
    await t.test(name, async () => {
      files = new Map();
      links = new Map();
      reads = [];
      requests = [];
      now = 100000;
      respond = (url) => json(url.pathname === '/api/info' ? { pid } : []);
      await run();
    });
  }

  await scenario(
    'defaults and home fallback never read the real home',
    async () => {
      files.set(
        `${state}/.local/state/opencode/service.json`,
        JSON.stringify({ pid: process.pid, url: 'http://localhost:4321' }),
      );
      respond = (url) =>
        json(url.pathname === '/api/info' ? { pid: process.pid } : []);
      const originalEnv = process.env;
      process.env = { ...originalEnv, XDG_STATE_HOME: '' };
      try {
        await openCodeAPI().active();
      } finally {
        process.env = originalEnv;
      }
      assert.equal(reads[0], `${state}/.local/state/opencode/service.json`);
    },
  );
  await scenario(
    'authenticated endpoint expires, encodes IDs and forwards cancellation',
    async () => {
      registered('http://127.0.0.1:4321', 'fixture-password');
      const client = api();
      const controller = new AbortController();
      await client.active({ signal: controller.signal });
      await client.diff({ sessionID: 'a/b ?' });
      assert.equal(requests.length, 3);
      assert.equal(requests[2].url.pathname, '/api/session/a%2Fb%20%3F/diff');
      assert.equal(requests[2].url.search, '?context=3');
      assert.deepEqual(requests[0].options?.headers, {
        authorization: `Basic ${Buffer.from('opencode:fixture-password').toString('base64')}`,
      });
      const forwarded = requests[1].options?.signal;
      assert.ok(forwarded);
      controller.abort();
      assert.equal(forwarded.aborted, true);
      now += 30000;
      await client.diff({ sessionID: 'a', context: 0 });
      assert.equal(
        requests.filter((r) => r.url.pathname === '/api/info').length,
        2,
      );
      assert.equal(requests.at(-1)?.url.search, '?context=0');
    },
  );
  await scenario(
    '400 preserves discovery; other HTTP errors invalidate it',
    async () => {
      registered();
      const client = api();
      await client.active();
      let failure: Response;
      respond = (url) =>
        url.pathname === '/api/info' ? json({ pid }) : failure.clone();
      for (const [body, detail] of [
        [{ message: 'bad range' }, ': bad range'],
        [{ message: 4 }, ''],
        [null, ''],
      ] as const) {
        failure = json(body, 400);
        await assert.rejects(client.active(), {
          message: `OpenCode API HTTP 400${detail}`,
          status: 400,
        });
      }
      assert.equal(
        requests.filter((r) => r.url.pathname === '/api/info').length,
        1,
      );
      failure = new Response('not json', { status: 503 });
      await assert.rejects(client.active(), {
        message: 'OpenCode API HTTP 503',
        status: 503,
      });
      failure = json([]);
      await client.active();
      assert.equal(
        requests.filter((r) => r.url.pathname === '/api/info').length,
        2,
      );
    },
  );
  await scenario(
    'transport and successful-response JSON failures invalidate discovery',
    async () => {
      registered();
      const client = api();
      await client.active();
      respond = (url) => {
        if (url.pathname === '/api/info') return json({ pid });
        throw Error('transport failed');
      };
      await assert.rejects(client.active(), /transport failed/);
      respond = (url) =>
        url.pathname === '/api/info' ? json({ pid }) : new Response('invalid');
      await assert.rejects(client.active(), SyntaxError);
      respond = (url) => json(url.pathname === '/api/info' ? { pid } : []);
      await client.active();
      assert.equal(
        requests.filter((r) => r.url.pathname === '/api/info').length,
        3,
      );
    },
  );
  await scenario(
    'rejects unsafe endpoints before fetch and tries the explicit local port',
    async () => {
      for (const url of [
        'https://localhost:4321',
        'http://example.invalid:4321',
        'invalid URL',
      ]) {
        registered(url);
        await api(['--port=4322']).active();
      }
      assert.equal(requests.length, 6);
      assert.ok(
        requests.every((r) => r.url.origin === 'http://127.0.0.1:4322'),
      );
      assert.deepEqual(requests[0].options?.headers, {});
    },
  );
  await scenario(
    'foreign registration is ignored and a separate port argument is supported',
    async () => {
      files.set(
        service,
        JSON.stringify({ pid: pid + 1, url: 'http://localhost:9999' }),
      );
      await api(['--port', '4322']).active();
      assert.equal(requests[0].url.port, '4322');
    },
  );
  await scenario(
    'PID mismatch and discovery errors never become a cached endpoint',
    async () => {
      registered();
      respond = () => json({ pid: pid + 1 });
      await assert.rejects(api().active(), /activity unknown/);
      respond = () => {
        throw Error('offline');
      };
      await assert.rejects(api().active(), /activity unknown/);
      const controller = new AbortController();
      controller.abort();
      const aborted = Error('cancelled discovery');
      respond = (_url, options) => {
        assert.equal(options?.signal?.aborted, true);
        throw aborted;
      };
      await assert.rejects(
        api().active({ signal: controller.signal }),
        (error) => error === aborted,
      );
    },
  );
  await scenario(
    'invalid ports and unreadable process tables report unknown activity',
    async () => {
      for (const argv of [
        [],
        ['--port'],
        ['--port=abc'],
        ['--port=0'],
        ['--port=65536'],
      ])
        await assert.rejects(api(argv).active(), /activity unknown/);
      assert.equal(requests.length, 0);
      assert.ok(reads.includes(`/proc/${pid}/net/tcp`));
    },
  );
  await scenario(
    'Linux process sockets filter state and ownership, support IPv6 and cap probes',
    async () => {
      links.set('1', '/tmp/opencode/not-a-socket');
      links.set('2', '');
      links.set('3', 'socket:[42]');
      const row = (port: number, status = '0A', inode = '42') =>
        `0: 0100007F:${port.toString(16)} 00000000:0000 ${status} 0 0 0 0 0 ${inode}`;
      files.set(
        `/proc/${pid}/net/tcp`,
        `header\n${row(4000, '01')}\n${row(4001, '0A', '99')}\n${row(4002)}`,
      );
      files.set(
        `/proc/${pid}/net/tcp6`,
        `header\n${Array.from({ length: 17 }, (_, i) => row(5000 + i)).join('\n')}`,
      );
      respond = (url) =>
        json(
          url.pathname === '/api/info'
            ? { pid: Number(url.port) === 5014 ? pid : 0 }
            : [],
        );
      await api().active();
      const probes = requests.filter((r) => r.url.pathname === '/api/info');
      assert.equal(probes.length, 16);
      assert.equal(probes[0].url.origin, 'http://127.0.0.1:4002');
      assert.equal(probes.at(-1)?.url.origin, 'http://[::1]:5014');
      assert.ok(probes.slice(1).every((r) => r.url.hostname === '[::1]'));
    },
  );
  await scenario('non-Linux discovery does not inspect proc', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      await assert.rejects(api().active(), /activity unknown/);
      assert.deepEqual(reads, [service]);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });
});
