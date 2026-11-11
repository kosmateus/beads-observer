import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserCommand, openBrowser } from '../src/adapters/browser.js';

const url = 'http://127.0.0.1:4317/projects/example/board';
const wsl = {
  platform: 'linux' as const,
  env: { WSL_INTEROP: '/run/WSL/123_interop' },
  kernelRelease: '6.18.33.2-microsoft-standard-WSL2',
};

test('routes WSL to the Windows browser instead of xdg-open', () => {
  assert.deepEqual(browserCommand(url, wsl), [
    'rundll32.exe',
    ['url.dll,FileProtocolHandler', url],
  ]);
});

test('routes Linux, macOS, and Windows to their native openers', () => {
  assert.deepEqual(
    browserCommand(url, {
      platform: 'linux',
      env: { DISPLAY: ':0' },
      kernelRelease: '6.8.0-linux',
    }),
    ['xdg-open', [url]],
  );
  assert.deepEqual(
    browserCommand(url, {
      platform: 'darwin',
      env: {},
      kernelRelease: 'Darwin',
    }),
    ['open', [url]],
  );
  assert.deepEqual(
    browserCommand(url, {
      platform: 'win32',
      env: {},
      kernelRelease: 'Windows',
    }),
    ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
  );
});

test('returns a manual URL when WSL interop or a graphical session is unavailable', async () => {
  let ran = false;
  const disabledInterop = await openBrowser(url, {
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    kernelRelease: '6.18.33.2-microsoft-standard-WSL2',
    run: async () => {
      ran = true;
    },
  });
  assert.equal(disabledInterop.opened, false);
  assert.equal(ran, false);
  assert.match(disabledInterop.message, /Open this URL manually/);
  const headlessLinux = await openBrowser(url, {
    platform: 'linux',
    env: {},
    kernelRelease: '6.8.0-linux',
  });
  assert.equal(headlessLinux.opened, false);
  assert.match(headlessLinux.message, /Open this URL manually/);
  assert.equal(
    browserCommand(url, {
      platform: 'linux',
      env: {},
      kernelRelease: '6.8.0-linux',
    }),
    undefined,
  );
  assert.equal(
    browserCommand(url, {
      platform: 'linux',
      env: { SSH_CONNECTION: 'client server port' },
      kernelRelease: '6.8.0-linux',
    }),
    undefined,
  );
});

test('passes a validated local URL as a literal argument without a shell', async () => {
  const injectedText = 'http://127.0.0.1:4317/?q=%3B%20echo%20injected';
  let call:
    | {
        command: string;
        args: string[];
        options: { timeout: number; windowsHide: boolean };
      }
    | undefined;
  const result = await openBrowser(injectedText, {
    platform: 'win32',
    env: {},
    run: async (command, args, options) => {
      call = { command, args, options };
    },
  });
  assert.deepEqual(call, {
    command: 'rundll32.exe',
    args: ['url.dll,FileProtocolHandler', injectedText],
    options: { timeout: 10000, windowsHide: true },
  });
  assert.deepEqual(result, { opened: true, url: injectedText });
});

test('falls back to a manual URL when the native helper is missing or times out', async () => {
  for (const code of ['ENOENT', 'ETIMEDOUT']) {
    const result = await openBrowser(url, {
      platform: 'linux',
      env: { DISPLAY: ':0' },
      kernelRelease: '6.8.0-linux',
      run: async () => {
        throw Object.assign(new Error(code), { code });
      },
    });
    assert.deepEqual(result, {
      opened: false,
      url,
      message: `No browser could be opened here. Open this URL manually: ${url}`,
    });
  }
});

test('rejects non-local or non-HTTP URLs', () => {
  for (const invalid of [
    'https://127.0.0.1:4317/',
    'http://localhost:4317/',
    'http://127.0.0.1.example:4317/',
    'http://user@127.0.0.1:4317/',
    'file:///tmp/board.html',
  ])
    assert.throws(
      () => browserCommand(invalid, wsl),
      /Expected local Observer URL/,
    );
});
