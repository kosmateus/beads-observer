import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicJSON, readJSON } from './hub-files.js';

export interface ProjectPreference {
  alias: string | null;
  hidden: boolean;
}

export type ProjectPreferencePatch = {
  alias?: string | null;
  hidden?: boolean;
};

export function normalizeProjectAlias(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Alias must be text');
  const alias = value.normalize('NFC').trim();
  if (
    [...alias].length > 80 ||
    [...alias].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    })
  )
    throw new Error('Alias must be at most 80 characters without controls');
  return alias || null;
}

export function projectPreferencePatch(value: unknown): ProjectPreferencePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid project preference');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['alias', 'hidden'].includes(key)) ||
    !Object.keys(input).length
  )
    throw new Error('Invalid project preference');
  const patch: ProjectPreferencePatch = {};
  if (Object.hasOwn(input, 'alias'))
    patch.alias = normalizeProjectAlias(input.alias);
  if (Object.hasOwn(input, 'hidden')) {
    if (typeof input.hidden !== 'boolean')
      throw new Error('Hidden must be boolean');
    patch.hidden = input.hidden;
  }
  return patch;
}

function preference(value: unknown): ProjectPreference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['alias', 'hidden'].includes(key)))
    return null;
  try {
    return {
      alias: normalizeProjectAlias(input.alias ?? null),
      hidden: input.hidden === true,
    };
  } catch {
    return null;
  }
}

export async function readProjectPreferences(path: string | undefined) {
  if (!path) return new Map<string, ProjectPreference>();
  let value: unknown;
  try {
    value = await readJSON(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return new Map<string, ProjectPreference>();
    throw error;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { projects?: unknown }).projects)
  )
    throw new Error('Invalid project preferences file');
  const projects = (value as { projects: unknown[] }).projects,
    result = new Map<string, ProjectPreference>();
  for (const entry of projects) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      !/^[a-f0-9]{24}$/.test(entry[0])
    )
      continue;
    const saved = preference(entry[1]);
    if (saved) result.set(entry[0], saved);
  }
  return result;
}

export async function writeProjectPreferences(
  path: string | undefined,
  values: ReadonlyMap<string, ProjectPreference>,
) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicJSON(path, { version: 1, projects: [...values] });
}
