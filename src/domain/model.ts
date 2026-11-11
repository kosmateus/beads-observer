import type { Issue, Edge } from '../types.js';
export function array<T = Record<string, unknown>>(value: unknown): T[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  for (const key of ['issues', 'items', 'data', 'results']) {
    const item = (value as Record<string, unknown>)[key];
    if (Array.isArray(item)) return item;
  }
  throw new Error('Nieznany format odpowiedzi Beads');
}
export function normalize(
  raw: unknown,
  ready: unknown = [],
  blocked: unknown = [],
) {
  const issues: Issue[] = array<Partial<Issue>>(raw).map((x) => ({
    ...x,
    id: String(x.id),
    title: x.title || String(x.id),
    status: x.status || 'open',
    issue_type: x.issue_type || 'task',
    labels: x.labels || [],
    dependencies: x.dependencies || [],
  }));
  const readyIDs = new Set(
    array<string | Issue>(ready).map((x) => (typeof x === 'string' ? x : x.id)),
  );
  const blockedIDs = new Set(
    array<string | Issue>(blocked).map((x) =>
      typeof x === 'string' ? x : x.id,
    ),
  );
  const edges = new Map<string, Edge>();
  for (const issue of issues) {
    issue.ready = readyIDs.has(issue.id);
    issue.blocked = blockedIDs.has(issue.id) || issue.status === 'blocked';
    for (const dep of issue.dependencies) {
      const source = dep.depends_on_id || dep.id;
      const target = dep.issue_id || issue.id;
      if (!source) continue;
      const type = dep.type || dep.dependency_type || 'blocks';
      const edge = { source, target, type };
      edges.set(`${source}|${target}|${type}`, edge);
    }
  }
  return { issues, edges: [...edges.values()] };
}
