import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCodeAPI } from '../src/adapters/opencode-api.js';

test('HTTP fallback uses only the registered owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'observer-api-'));
  let responsePid = 123;
  const server = createServer((req, res) => {
    if (
      req.headers.authorization !==
      'Basic ' + Buffer.from('opencode:test-password').toString('base64')
    ) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/api/info'
          ? { pid: responsePid }
          : req.url === '/api/session/active'
            ? { data: { child: { type: 'running' } } }
            : { data: [] },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await mkdir(join(dir, 'opencode'));
    await writeFile(
      join(dir, 'opencode/service.json'),
      JSON.stringify({
        pid: 123,
        url: `http://127.0.0.1:${address.port}`,
        password: 'test-password',
      }),
    );
    const api = openCodeAPI({
      pid: 123,
      env: { XDG_STATE_HOME: dir },
      argv: [],
    });
    assert.deepEqual(await api.active(), {
      data: { child: { type: 'running' } },
    });
    assert.deepEqual(await api.diff({ sessionID: 'child' }), { data: [] });
    await assert.rejects(
      openCodeAPI({
        pid: 456,
        env: { XDG_STATE_HOME: dir },
        argv: [],
      }).active(),
      /activity unknown/,
    );
    if (process.platform === 'linux') {
      responsePid = process.pid;
      const privateAPI = openCodeAPI({
        env: { XDG_STATE_HOME: dir, OPENCODE_SERVER_PASSWORD: 'test-password' },
        argv: ['opencode', 'serve', '--port', '0'],
      });
      assert.deepEqual(await privateAPI.active(), {
        data: { child: { type: 'running' } },
      });
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
