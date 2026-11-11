import { readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionRecord } from '../types.js';
const recordCache = new Map<
  string,
  { signature: string; record: SessionRecord }
>();
export async function readSessionRecords(
  directory: string | undefined,
  projectId: string,
  issueId?: string | null,
  now = Date.now(),
) {
  if (!directory) return [];
  const latest = new Map<string, SessionRecord>();
  let files;
  try {
    files = await readdir(directory);
  } catch {
    return [];
  }
  for (const file of files
    .filter(
      (x) => x.startsWith('session-' + projectId + '-') && x.endsWith('.json'),
    )
    .sort()) {
    try {
      const path = join(directory, file),
        stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 2 * 1024 * 1024
      )
        continue;
      const cached = recordCache.get(path);
      const signature = String(stat.mtimeMs) + ':' + stat.size;
      const record: SessionRecord =
        cached?.signature === signature
          ? cached.record
          : JSON.parse(await readFile(path, 'utf8'));
      recordCache.set(path, { signature, record });
      if (recordCache.size > 512)
        recordCache.delete(recordCache.keys().next().value!);
      if (
        record.projectId !== projectId ||
        typeof record.sessionID !== 'string' ||
        !record.sessionID ||
        !Number.isFinite(record.updatedAt)
      )
        continue;
      const previous = latest.get(record.sessionID);
      if (
        !previous ||
        previous.updatedAt < record.updatedAt ||
        (previous.updatedAt === record.updatedAt && record.connected === false)
      )
        latest.set(record.sessionID, record);
    } catch {}
  }
  return [...latest.values()]
    .filter(
      (record) =>
        issueId === undefined ||
        (Array.isArray(record.issueIds) &&
          record.issueIds.includes(issueId as string)),
    )
    .map((record) => {
      const connected =
        record.connected === true &&
        record.updatedAt <= now &&
        now - record.updatedAt < 15000;
      return {
        ...record,
        connected,
        status:
          !connected && ['running', 'streaming'].includes(record.status)
            ? 'unknown'
            : record.status,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
