import { WriteRequest } from './write-request.js';
import { validateDraft } from './create-issue.js';
export function validateUpdate(input) {
  if (
    !input ||
    Object.keys(input).some(
      (key) => !['id', 'title', 'description', 'priority'].includes(key),
    ) ||
    typeof input.id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(input.id)
  )
    throw Object.assign(
      new Error('Invalid update; status changes are not allowed'),
      { status: 400 },
    );
  const draft = validateDraft({
    title: input.title,
    description: input.description,
    priority: input.priority,
    type: 'task',
    parent: '',
  });
  return {
    id: input.id,
    title: draft.title,
    description: draft.description,
    priority: draft.priority,
  };
}
export class UpdateIssue extends WriteRequest {
  constructor(projects) {
    super(projects, { validate: validateUpdate, method: 'update' });
  }
}
