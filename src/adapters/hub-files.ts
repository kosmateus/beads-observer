import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  rename,
  unlink,
  readdir,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { Lease } from '../types.js';
export const LEASE_TTL_MS = 25000;
export async function hubDirectory(port: number, root = tmpdir()) {
  const directory = join(
    resolve(root),
    `beads-observer-${process.getuid?.() ?? 'user'}-v1-${port}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Unsafe hub directory');
  if (
    process.platform !== 'win32' &&
    (info.uid !== process.getuid?.() || info.mode & 0o077)
  )
    throw new Error('Hub directory must be owned by this user with mode 0700');
  return directory;
}
export function runtimeIdentity(directory: string) {
  return createHash('sha256').update(directory).digest('hex');
}
export async function atomicJSON(path: string, value: unknown) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function readJSON<T = Record<string, unknown>>(
  path: string,
): Promise<T> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024)
    throw new Error('Invalid hub record');
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function readLeases(directory: string, now = Date.now()) {
  const leases: Lease[] = [];
  for (const file of (await readdir(directory))
    .filter((x) => /^lease-[0-9a-f-]+\.json$/.test(x))
    .sort()) {
    try {
      const lease = await readJSON<Lease>(join(directory, file));
      if (
        !Array.isArray(lease.projects) ||
        !Number.isFinite(lease.updatedAt) ||
        now - lease.updatedAt > LEASE_TTL_MS ||
        lease.updatedAt > now + LEASE_TTL_MS
      ) {
        await unlink(join(directory, file)).catch(() => {});
        await unlink(join(directory, file + '.result')).catch(() => {});
        continue;
      }
      leases.push({ ...lease, file });
    } catch {
      /* A broken registration never prevents other projects from being served. */
    }
  }
  return leases;
}
