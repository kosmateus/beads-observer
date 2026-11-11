import { readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// V2.1.3 exposes active/diff over HTTP, but omits them from the plugin Context.
// Never discover/start another service: activity belongs to this exact process.
export function openCodeAPI({
  pid = process.pid,
  env = process.env,
  argv = process.argv,
} = {}) {
  let endpoint,
    checkedAt = 0;
  async function request(base, path, password, signal) {
    const url = new URL(base);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    )
      throw Error('OpenCode endpoint must be local');
    const response = await fetch(new URL(path, url), {
      signal,
      headers: password
        ? {
            authorization:
              'Basic ' + Buffer.from('opencode:' + password).toString('base64'),
          }
        : {},
    });
    if (!response.ok) throw Error(`OpenCode API HTTP ${response.status}`);
    return response.json();
  }
  async function discover(signal) {
    if (endpoint && Date.now() - checkedAt < 30000) return endpoint;
    const candidates = [];
    try {
      const info = JSON.parse(
        await readFile(
          join(
            env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
            'opencode',
            'service.json',
          ),
          'utf8',
        ),
      );
      if (info.pid === pid)
        candidates.push({ url: info.url, password: info.password });
    } catch {}
    const index = argv.indexOf('--port');
    const port =
      index >= 0
        ? argv[index + 1]
        : argv.find((x) => x.startsWith('--port='))?.split('=')[1];
    if (/^\d+$/.test(port || '') && Number(port) > 0 && Number(port) <= 65535)
      candidates.push({
        url: `http://127.0.0.1:${port}`,
        password: env.OPENCODE_SERVER_PASSWORD,
      });
    // Private TUI/Kimaki servers may choose an ephemeral port and have no service
    // registration. On Linux inspect only this process's listening sockets, not
    // every user's ports. An authenticated /api/info PID check remains mandatory.
    if (process.platform === 'linux' && !candidates.length)
      try {
        const inodes = new Set();
        for (const fd of await readdir(`/proc/${pid}/fd`)) {
          const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(
            () => '',
          );
          const inode = target.match(/^socket:\[(\d+)\]$/)?.[1];
          if (inode) inodes.add(inode);
        }
        for (const table of ['tcp', 'tcp6']) {
          const text = await readFile(`/proc/${pid}/net/${table}`, 'utf8');
          for (const line of text.trim().split('\n').slice(1)) {
            const fields = line.trim().split(/\s+/);
            if (fields[3] !== '0A' || !inodes.has(fields[9])) continue;
            const address = fields[1].split(':');
            const host = table === 'tcp6' ? '[::1]' : '127.0.0.1';
            if (candidates.length < 16)
              candidates.push({
                url: `http://${host}:${parseInt(address[1], 16)}`,
                password: env.OPENCODE_SERVER_PASSWORD,
              });
          }
        }
      } catch {}
    for (const candidate of candidates)
      try {
        const info = await request(
          candidate.url,
          '/api/info',
          candidate.password,
          signal,
        );
        if (info.pid === pid) {
          endpoint = candidate;
          checkedAt = Date.now();
          return endpoint;
        }
      } catch (error) {
        if (signal.aborted) throw error;
      }
    throw Error(
      'API of this OpenCode process is unavailable (activity unknown)',
    );
  }
  async function get(path, { signal } = {}) {
    const timeout = AbortSignal.timeout(5000),
      combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const target = await discover(combined);
    try {
      return await request(target.url, path, target.password, combined);
    } catch (error) {
      endpoint = null;
      throw error;
    }
  }
  return {
    active: (options) => get('/api/session/active', options),
    diff: ({ sessionID, context = 3 }, options) =>
      get(
        `/api/session/${encodeURIComponent(sessionID)}/diff?context=${context}`,
        options,
      ),
  };
}
