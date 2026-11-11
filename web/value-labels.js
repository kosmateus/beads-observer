import { catalogs } from './catalogs.js';
import { locale } from './i18n.js';
// Values are presentation-only. Namespace allowlists prevent custom values such as
// "title" or "constructor" from accidentally matching unrelated UI strings.
const valueKeys = {
  type: Object.fromEntries(
    [
      'task',
      'epic',
      'bug',
      'feature',
      'chore',
      'decision',
      'spike',
      'story',
      'milestone',
      'gate',
      'external',
    ].map((key) => [key, key]),
  ),
  status: {
    open: 'open',
    in_progress: 'inProgress',
    blocked: 'blocked',
    deferred: 'deferred',
    closed: 'closed',
    hooked: 'pinned',
    pinned: 'pinned',
    external: 'external',
  },
  relation: Object.fromEntries(
    [
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
      'conditional-blocks',
      'waits-for',
    ].map((key) => [key, 'relation_' + key]),
  ),
  event: Object.fromEntries(
    [
      'created',
      'updated',
      'closed',
      'reopened',
      'status_changed',
      'priority_changed',
      'assignee_changed',
      'title_changed',
      'description_changed',
      'comment_added',
      'dependency_added',
      'dependency_removed',
      'label_added',
      'label_removed',
      'type_changed',
    ].map((key) => [key, 'event_' + key]),
  ),
  field: {
    status: 'status',
    assignee: 'agent',
    priority: 'priority',
    title: 'title',
    description: 'description',
    issue_type: 'type',
    labels: 'label',
    due_at: 'due',
    defer_until: 'deferredUntil',
    close_reason: 'closeReason',
    notes: 'notes',
    created_at: 'dateCreated',
    updated_at: 'updated',
    created_by: 'reporter',
    acceptance_criteria: 'acceptance',
    design: 'design',
    type: 'type',
  },
};
export function valueLabel(kind, value, language = locale()) {
  if (value === null || value === undefined) return '—';
  const raw = String(value),
    keys = valueKeys[kind];
  if (!keys || !Object.hasOwn(keys, raw)) return raw;
  const key = keys[raw],
    catalog = catalogs[language];
  return catalog &&
    Object.hasOwn(catalog, key) &&
    typeof catalog[key] === 'string' &&
    catalog[key]
    ? catalog[key]
    : raw;
}
