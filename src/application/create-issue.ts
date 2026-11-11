import { WriteRequest } from './write-request.js';
import type { Draft } from '../types.js';
import type { Projects } from './projects.js';
import { record } from '../types.js';
/** Explicit create use case. Read paths never call the writer. */
export function validateDraft(value: unknown): Draft {
  const invalid = (message: string): never => {
    const error = Object.assign(new Error(message), { status: 400 });
    throw error;
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('Invalid issue');
  const input = record(value);
  if (
    Object.keys(input).some(
      (key) =>
        !['title', 'description', 'type', 'priority', 'parent'].includes(key),
    )
  )
    invalid('Unknown field');
  if (
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.length > 500 ||
    input.title.includes('\0')
  )
    invalid('Title must be 1–500 characters');
  if (
    typeof input.description !== 'string' ||
    input.description.length > 20000 ||
    input.description.includes('\0')
  )
    invalid('Description must be at most 20000 characters');
  if (
    typeof input.type !== 'string' ||
    ![
      'bug',
      'feature',
      'task',
      'epic',
      'chore',
      'decision',
      'spike',
      'story',
      'milestone',
    ].includes(input.type)
  )
    invalid('Unsupported issue type');
  if (
    !Number.isInteger(input.priority) ||
    Number(input.priority) < 0 ||
    Number(input.priority) > 4
  )
    invalid('Priority must be 0–4');
  if (
    input.parent &&
    (typeof input.parent !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(input.parent))
  )
    invalid('Invalid parent ID');
  return {
    ...input,
    title: (input.title as string).trim(),
    description: input.description as string,
    type: input.type as string,
    priority: input.priority as number,
    parent: (input.parent || '') as string,
  };
}
export class CreateIssue extends WriteRequest<'create'> {
  constructor(projects: Projects) {
    super(projects, { validate: validateDraft, method: 'create' });
  }
}
