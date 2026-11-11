import { WriteRequest } from './write-request.js';
/** Explicit create use case. Read paths never call the writer. */
export function validateDraft(input) {
  const invalid = (message) => {
    const error = new Error(message);
    error.status = 400;
    throw error;
  };
  if (!input || typeof input !== 'object' || Array.isArray(input))
    invalid('Invalid issue');
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
    input.priority < 0 ||
    input.priority > 4
  )
    invalid('Priority must be 0–4');
  if (
    input.parent &&
    (typeof input.parent !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(input.parent))
  )
    invalid('Invalid parent ID');
  return { ...input, title: input.title.trim(), parent: input.parent || '' };
}
export class CreateIssue extends WriteRequest {
  constructor(projects) {
    super(projects, { validate: validateDraft, method: 'create' });
  }
}
