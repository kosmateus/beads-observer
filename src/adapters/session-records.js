import { readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const recordCache = new Map();
export async function readSessionRecords(directory, projectId, issueId) {
  if (!directory) return [];
  const latest = new Map(),
    now = Date.now();
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
      const record =
        cached?.signature === signature
          ? cached.record
          : JSON.parse(await readFile(path, 'utf8'));
      recordCache.set(path, { signature, record });
      if (recordCache.size > 512)
        recordCache.delete(recordCache.keys().next().value);
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
        (Array.isArray(record.issueIds) && record.issueIds.includes(issueId)),
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
