export function array(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  for (const key of ['issues', 'items', 'data', 'results'])
    if (Array.isArray(value[key])) return value[key];
  throw new Error('Nieznany format odpowiedzi Beads');
}
export function normalize(raw, ready = [], blocked = []) {
  const issues = array(raw).map((x) => ({
    ...x,
    id: String(x.id),
    title: x.title || x.id,
    status: x.status || 'open',
    issue_type: x.issue_type || 'task',
    labels: x.labels || [],
    dependencies: x.dependencies || [],
  }));
  const readyIDs = new Set(
    array(ready).map((x) => (typeof x === 'string' ? x : x.id)),
  );
  const blockedIDs = new Set(
    array(blocked).map((x) => (typeof x === 'string' ? x : x.id)),
  );
  const edges = new Map();
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
