import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export function browserCommand(
  url: string,
  platform = process.platform,
): [string, string[]] {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1')
    throw new Error('Expected local Observer URL');
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32')
    return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}
export async function openBrowser(url: string) {
  const [command, args] = browserCommand(url);
  try {
    await execute(command, args, { timeout: 10000, windowsHide: true });
  } catch {
    throw new Error(
      `Cannot open a browser here. Open this URL on the machine running OpenCode: ${url}`,
    );
  }
}
