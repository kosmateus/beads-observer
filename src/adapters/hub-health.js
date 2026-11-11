import { get } from 'node:http';
import { isConnectionRefused } from './network-errors.js';
/** Fixed loopback health probe. Avoid runtime-specific fetch error wrapping. */
export function probeHub(port, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const request = get(
      { hostname: '127.0.0.1', port, path: '/api/health', agent: false },
      (response) => {
        let body = '',
          size = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > 32768)
            request.destroy(new Error('Unexpected oversized hub response'));
          else body += chunk;
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve({
              ok: response.statusCode === 200,
              info: JSON.parse(body),
            });
          } catch {
            reject(new Error(`Port ${port} is occupied by another service`));
          }
        });
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new Error('Hub health probe timed out')),
      timeoutMs,
    );
    request.on('close', () => clearTimeout(deadline));
    request.on('error', (error) =>
      isConnectionRefused(error) ? resolve(null) : reject(error),
    );
  });
}
