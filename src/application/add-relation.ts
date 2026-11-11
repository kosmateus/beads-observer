import { WriteRequest } from './write-request.js';
import { record } from '../types.js';
import type { Relation } from '../types.js';
import type { Projects } from './projects.js';
export const relationTypes = [
  'blocks',
  'tracks',
  'related',
  'parent-child',
  'discovered-from',
  'until',
  'caused-by',
  'validates',
  'relates-to',
  'supersedes',
];
export function validateRelation(value: unknown): Relation {
  const input = record(value);
  const validId = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);
  if (
    !input ||
    Object.keys(input).some(
      (key) => !['issue', 'target', 'type'].includes(key),
    ) ||
    !validId(input.issue) ||
    !validId(input.target) ||
    input.issue === input.target ||
    typeof input.type !== 'string' ||
    !relationTypes.includes(input.type)
  )
    throw Object.assign(new Error('Invalid relation'), { status: 400 });
  return {
    issue: input.issue,
    target: input.target,
    type: input.type as string,
  };
}
/** Reuses the idempotent request coordinator with a distinct validation and write port. */
export class AddRelation extends WriteRequest<'addRelation'> {
  constructor(projects: Projects) {
    super(projects, { validate: validateRelation, method: 'addRelation' });
  }
}
