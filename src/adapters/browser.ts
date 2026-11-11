import { execFile } from 'node:child_process';
import { release } from 'node:os';
import { promisify } from 'node:util';
import type { BrowserOpenResult } from '../ports/browser.js';

const execute = promisify(execFile);

type BrowserRunnerOptions = { timeout: number; windowsHide: boolean };
type BrowserRunner = (
  command: string,
  args: string[],
  options: BrowserRunnerOptions,
) => Promise<unknown>;

export interface BrowserEnvironment {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  kernelRelease?: string;
  run?: BrowserRunner;
}

type BrowserCommand = [string, string[]];

function localURL(url: string) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username ||
    parsed.password
  )
    throw new Error('Expected local Observer URL');
  return parsed.href;
}

function resolveBrowserCommand(
  url: string,
  environment: BrowserEnvironment,
): BrowserCommand | undefined {
  const platform = environment.platform ?? process.platform;
  const env = environment.env ?? process.env;
  const kernelRelease = environment.kernelRelease ?? release();
  const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  const remoteHeadless = Boolean(
    (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) && !hasDisplay,
  );
  const isWSL =
    platform === 'linux' &&
    Boolean(
      env.WSL_INTEROP ||
      env.WSL_DISTRO_NAME ||
      /microsoft/i.test(kernelRelease),
    );

  if (isWSL) {
    if (!env.WSL_INTEROP) return undefined;
    return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  }
  if (remoteHeadless) return undefined;
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32')
    return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'linux') {
    if (!hasDisplay) return undefined;
    return ['xdg-open', [url]];
  }
  return undefined;
}

export function browserCommand(
  url: string,
  environment: BrowserEnvironment = {},
): BrowserCommand | undefined {
  return resolveBrowserCommand(localURL(url), environment);
}

function manualResult(url: string): BrowserOpenResult {
  return {
    opened: false,
    url,
    message: `No browser could be opened here. Open this URL manually: ${url}`,
  };
}

export async function openBrowser(
  url: string,
  environment: BrowserEnvironment = {},
): Promise<BrowserOpenResult> {
  const validatedURL = localURL(url);
  const command = resolveBrowserCommand(validatedURL, environment);
  if (!command) return manualResult(validatedURL);

  try {
    const run = environment.run ?? execute;
    await run(command[0], command[1], { timeout: 10000, windowsHide: true });
    return { opened: true, url: validatedURL };
  } catch {
    return manualResult(validatedURL);
  }
}
