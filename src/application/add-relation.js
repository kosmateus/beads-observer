import { WriteRequest } from './write-request.js';
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
export function validateRelation(input) {
  const validId = (value) =>
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
    !relationTypes.includes(input.type)
  )
    throw Object.assign(new Error('Invalid relation'), { status: 400 });
  return { issue: input.issue, target: input.target, type: input.type };
}
/** Reuses the idempotent request coordinator with a distinct validation and write port. */
export class AddRelation extends WriteRequest {
  constructor(projects) {
    super(projects, { validate: validateRelation, method: 'addRelation' });
  }
}
