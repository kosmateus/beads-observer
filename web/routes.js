const routeViews = new Set(['board', 'graph', 'list', 'activity']);
export function readRoute(url) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const legacy = new URLSearchParams(url.hash.slice(1));
  if (parts[0] === 'projects' && parts[1]) {
    return {
      project: parts[1],
      view: routeViews.has(parts[2]) ? parts[2] : null,
      issue: parts[2] === 'issues' ? parts[3] : null,
      agent: parts[2] === 'agents' ? parts[3] : null,
    };
  }
  return {
    project: url.searchParams.get('project'),
    view: routeViews.has(url.searchParams.get('view'))
      ? url.searchParams.get('view')
      : null,
    issue: legacy.get('issue') || legacy.get('epic'),
    agent: legacy.get('agent'),
  };
}
export function routePath(project, kind = 'board', id) {
  return (
    '/projects/' +
    encodeURIComponent(project) +
    '/' +
    kind +
    (id == null ? '' : '/' + encodeURIComponent(id))
  );
}
