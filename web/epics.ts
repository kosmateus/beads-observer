/** All epic ancestors, nearest first; parent-child is hierarchy, never a blocking inference. */
import type { Issue, Edge } from './contracts.js';
export function epicAncestors(
  id: string,
  issues: Issue[],
  edges: Edge[],
): Issue[] {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const parents = new Map<string, string[]>();
  for (const edge of edges)
    if (edge.type === 'parent-child') {
      if (!parents.has(edge.target)) parents.set(edge.target, []);
      parents.get(edge.target)!.push(edge.source);
    }
  const seen = new Set([id]),
    queue = [...(parents.get(id) || [])],
    result: Issue[] = [];
  for (let i = 0; i < queue.length; i++) {
    const next = queue[i];
    if (seen.has(next)) continue;
    seen.add(next);
    const issue = byId.get(next);
    if (issue?.issue_type === 'epic') result.push(issue);
    queue.push(...(parents.get(next) || []));
  }
  return result;
}

/** Direct children only: blocking/related issues are never counted as children. */
export function epicChildren(
  id: string,
  issues: Issue[],
  edges: Edge[],
): Issue[] {
  const ids = new Set(
    edges
      .filter(
        (e) => e.type === 'parent-child' && e.source === id && e.target !== id,
      )
      .map((e) => e.target),
  );
  return [...ids].map(
    (id) =>
      issues.find((issue) => issue.id === id) || {
        id,
        status: 'external',
        title: id,
        issue_type: 'external',
        labels: [],
        dependencies: [],
      },
  );
}
export function epicColor(id: string) {
  const colors = [
    '#6e56cf',
    '#176bba',
    '#147d64',
    '#a23a70',
    '#805b12',
    '#395ab5',
  ];
  let hash = 0;
  for (const character of id)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

/** Actual parent-child paths; no inference from IDs or issue types. Bound cycles and branching. */
export function hierarchyPaths(id: string, edges: Edge[]) {
  const paths: string[][] = [];
  function visit(current: string, trail: string[]) {
    if (paths.length >= 32) return;
    const parents = [
      ...new Set(
        edges
          .filter(
            (edge) => edge.type === 'parent-child' && edge.target === current,
          )
          .map((edge) => edge.source),
      ),
    ].filter((parent) => !trail.includes(parent));
    if (!parents.length || trail.length >= 32) {
      paths.push([...trail].reverse());
      return;
    }
    for (const parent of parents) visit(parent, [...trail, parent]);
  }
  visit(id, [id]);
  return paths;
}
