/** Pure graph layout: SCC condensation prevents cycles from exploding the layout. */
import type { Issue, Edge, Position } from './contracts.js';
export function layoutGraph(issues: Issue[], edges: Edge[]) {
  const nodes = new Map(issues.map((x) => [x.id, x]));
  for (const e of edges)
    for (const id of [e.source, e.target])
      if (!nodes.has(id))
        nodes.set(id, {
          id,
          title: 'Zależność spoza widoku',
          status: 'external',
          issue_type: 'external',
          labels: [],
          dependencies: [],
        });
  const adjacency = new Map<string, string[]>(
    [...nodes.keys()].map((id) => [id, []]),
  );
  for (const e of edges) adjacency.get(e.source)!.push(e.target);
  let counter = 0;
  const indices = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    onStack = new Set<string>(),
    components: string[][] = [];
  function visit(id: string) {
    indices.set(id, counter);
    low.set(id, counter++);
    stack.push(id);
    onStack.add(id);
    for (const next of adjacency.get(id)!) {
      if (!indices.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
      } else if (onStack.has(next))
        low.set(id, Math.min(low.get(id)!, indices.get(next)!));
    }
    if (low.get(id) === indices.get(id)) {
      const component = [];
      let member;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      components.push(component);
    }
  }
  for (const id of nodes.keys()) if (!indices.has(id)) visit(id);
  const owner = new Map<string, number>();
  components.forEach((c, i) => c.forEach((id) => owner.set(id, i)));
  const dag = components.map(() => new Set<number>()),
    degree = components.map(() => 0),
    rank = components.map(() => 0);
  for (const e of edges) {
    const a = owner.get(e.source)!,
      b = owner.get(e.target)!;
    if (a !== b && !dag[a].has(b)) {
      dag[a].add(b);
      degree[b]++;
    }
  }
  const queue = degree.flatMap((n, i) => (n === 0 ? [i] : []));
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    for (const b of dag[a]) {
      rank[b] = Math.max(rank[b], rank[a] + 1);
      if (--degree[b] === 0) queue.push(b);
    }
  }
  const rows = new Map<number, number>(),
    positions = new Map<string, Position>();
  [...nodes.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach((node) => {
      const col = rank[owner.get(node.id)!],
        row = rows.get(col) || 0;
      rows.set(col, row + 1);
      positions.set(node.id, {
        node,
        x: 30 + col * 380,
        y: 120 + row * 280,
        cycle: components[owner.get(node.id)!].length > 1,
      });
    });
  return {
    positions,
    width: Math.max(600, (Math.max(0, ...rank) + 1) * 380),
    height: Math.max(380, ...[...rows.values()].map((n) => n * 280 + 135)),
    columns: Math.max(0, ...rank) + 1,
  };
}

/** Filter actual nodes and edges; never invent aggregate epic dependencies. */
export function graphSelection(
  rows: Issue[],
  issues: Issue[],
  edges: Edge[],
  mode = 'all',
  edgeMode = 'blocking',
  context = true,
) {
  const selected = rows.filter(
    (x) =>
      mode === 'all' ||
      (mode === 'epics'
        ? x.issue_type === 'epic'
        : mode === 'tasks'
          ? x.issue_type !== 'epic'
          : x.issue_type === mode),
  );
  const ids = new Set(selected.map((x) => x.id));
  const candidates = edges.filter(
    (e) =>
      (ids.has(e.source) || ids.has(e.target)) &&
      (edgeMode === 'all' ||
        ['blocks', 'conditional-blocks', 'waits-for'].includes(e.type)),
  );
  const visible = candidates.filter(
    (e) => context || (ids.has(e.source) && ids.has(e.target)),
  );
  const nodes = new Map(selected.map((x) => [x.id, x]));
  for (const e of visible)
    for (const id of [e.source, e.target])
      if (!nodes.has(id)) {
        const actual = issues.find((x) => x.id === id);
        nodes.set(
          id,
          actual
            ? { ...actual, graphContext: true }
            : {
                id,
                title: id,
                status: 'external',
                issue_type: 'external',
                labels: [],
                dependencies: [],
                graphContext: true,
              },
        );
      }
  return {
    nodes: [...nodes.values()],
    edges: visible,
    hiddenEdges: candidates.length - visible.length,
  };
}

/** Derived display state; readiness is authoritative Beads data, never inferred from open. */
export function stageSummary(nodes: Issue[], stale = false) {
  const items = nodes.filter((x) => !x.graphContext);
  const total = items.length,
    closed = items.filter((x) => x.status === 'closed').length;
  const remaining = items.filter((x) => x.status !== 'closed');
  const running = remaining.filter((x) => x.status === 'in_progress').length;
  const ready = remaining.filter((x) => x.ready === true).length;
  const blocked = remaining.filter(
    (x) => x.blocked === true || x.status === 'blocked',
  ).length;
  const incomplete =
    stale ||
    !total ||
    items.some(
      (x) =>
        ![
          'open',
          'closed',
          'in_progress',
          'blocked',
          'deferred',
          'pinned',
          'hooked',
        ].includes(x.status),
    );
  const status = incomplete
    ? 'incomplete'
    : closed === total
      ? 'closed'
      : running
        ? 'in_progress'
        : ready
          ? 'ready'
          : blocked
            ? 'blocked'
            : remaining.every((x) => x.status === 'deferred')
              ? 'deferred'
              : 'open';
  return { status, total, closed, running, ready, blocked };
}
