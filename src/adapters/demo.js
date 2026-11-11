import { statusTimeline } from '../domain/status-timeline.js';
import { normalize } from '../domain/model.js';
export function demoIssues() {
  const titles = [
    'Platforma agentów · wydanie 2.0',
    'Kontrakt API i schemat danych',
    'Strumień zdarzeń agentów',
    'Uwierzytelnianie połączeń SSE',
    'Tablica zadań w czasie rzeczywistym',
    'Graf zależności i blokad',
    'Obsługa ponownego połączenia',
    'Testy integracyjne przepływu',
    'Przegląd dostępności interfejsu',
    'Publikacja wydania',
    'Dokumentacja konfiguracji',
    'Analiza wydajności dużych grafów',
    'Akceptacja pipeline CI',
    'Uzgodnienie formatu zdarzeń',
  ];
  const states = [
    'in_progress',
    'closed',
    'in_progress',
    'blocked',
    'in_progress',
    'open',
    'open',
    'blocked',
    'open',
    'open',
    'closed',
    'deferred',
    'open',
    'closed',
  ];
  const deps = {
    2: [1],
    3: [2],
    4: [2],
    5: [4],
    6: [2],
    7: [3, 4, 5],
    8: [4],
    9: [7, 8, 12],
    12: [7],
  };
  return titles.map((title, i) => ({
    id: `obs-${String(i + 1).padStart(3, '0')}`,
    title: i === 13 ? 'Wydanie i stabilizacja' : title,
    status: i === 13 ? 'open' : states[i],
    priority: i === 3 ? 0 : i < 8 ? 1 : 2,
    issue_type:
      i === 0
        ? 'epic'
        : i === 3
          ? 'bug'
          : i === 12
            ? 'gate'
            : i === 13
              ? 'epic'
              : i === 5
                ? 'feature'
                : 'task',
    assignee: [
      '',
      'agent/atlas',
      'agent/nova',
      'agent/atlas',
      'agent/iris',
      'agent/iris',
      'agent/nova',
    ][i % 7],
    labels: [i % 2 ? 'backend' : 'frontend', i < 9 ? 'release:2.0' : 'quality'],
    description: `${title}. Współpraca agentów oraz aktualizacje odczytywane przez Beads Observer.`,
    acceptance_criteria:
      'Zmiana jest przetestowana. Zależności są zamknięte. Dokumentacja została zaktualizowana.',
    design: 'Dane pozostają w Beads. Interfejs służy wyłącznie do obserwacji.',
    notes: 'Status aktualizowany wraz z postępem prac.',
    created_at: '2026-10-24T07:00:00Z',
    updated_at: '2026-10-24T08:10:00Z',
    dependencies: [
      ...(deps[i] || []).map((n) => ({
        issue_id: `obs-${String(i + 1).padStart(3, '0')}`,
        depends_on_id: `obs-${String(n + 1).padStart(3, '0')}`,
        type: 'blocks',
      })),
      ...(i > 0 && i < 13
        ? [
            {
              depends_on_id: i === 9 || i === 10 ? 'obs-014' : 'obs-001',
              type: 'parent-child',
            },
          ]
        : []),
      ...(i === 13
        ? [
            { depends_on_id: 'obs-001', type: 'blocks' },
            { depends_on_id: 'obs-003', type: 'blocks' },
          ]
        : []),
    ],
    comments: [
      {
        author: 'agent/atlas',
        text: 'Zakres potwierdzony. Czekam na zakończenie zależności.',
        created_at: '2026-10-24T08:00:00Z',
      },
    ],
  }));
}
export class DemoSource {
  constructor() {
    this.issues = demoIssues();
    this.step = 0;
    this.events = new Map(
      this.issues.map((issue, i) => [
        issue.id,
        [
          {
            id: issue.id + '-start',
            event_type: 'status_changed',
            new_value: JSON.stringify({ status: 'open' }),
            created_at: new Date(
              Date.now() - 7200000 - i * 60000,
            ).toISOString(),
            actor: 'agent/atlas',
          },
          {
            id: issue.id + '-state',
            event_type: 'status_changed',
            new_value: JSON.stringify({ status: issue.status }),
            created_at: new Date(
              Date.now() - 1800000 - i * 30000,
            ).toISOString(),
            actor: issue.assignee || 'agent/atlas',
          },
        ],
      ]),
    );
    this.tick = 0;
  }
  async snapshot() {
    const previous = new Map(this.issues.map((x) => [x.id, x.status]));
    if (++this.tick % 4 === 0) {
      const rows = this.issues.filter(
        (x) => x.issue_type !== 'epic' && x.issue_type !== 'gate',
      );
      const active = rows.filter((x) => x.status === 'in_progress');
      const next = rows.find(
        (x) => x.status === 'open' && this.blockers(x).length === 0,
      );
      const item =
        this.step++ % 2 === 0 ? active[0] || next : next || active[0];
      if (item) {
        item.status = item.status === 'in_progress' ? 'closed' : 'in_progress';
        item.assignee ||= 'agent/nova';
        item.updated_at = new Date().toISOString();
      } else {
        this.issues = [
          ...demoIssues(),
          ...this.issues.filter((x) => x.id.startsWith('obs-user-')),
        ];
      }
      for (const x of this.issues)
        if (x.status === 'blocked' && !this.blockers(x).length)
          x.status = 'open';
    }
    for (const issue of this.issues)
      if (previous.get(issue.id) !== issue.status) {
        this.events.get(issue.id).push({
          id: issue.id + '-' + Date.now(),
          event_type: 'status_changed',
          new_value: JSON.stringify({ status: issue.status }),
          created_at: new Date().toISOString(),
          actor: issue.assignee || 'agent/atlas',
        });
      }
    const blocked = this.issues.filter(
      (x) => x.status !== 'closed' && this.blockers(x).length,
    );
    const ready = this.issues.filter(
      (x) => x.status === 'open' && !this.blockers(x).length,
    );
    return normalize(structuredClone(this.issues), ready, blocked);
  }
  blockers(x, seen = new Set()) {
    if (seen.has(x.id)) return [];
    seen.add(x.id);
    const direct = x.dependencies.filter(
      (d) =>
        d.type === 'blocks' &&
        this.issues.find((y) => y.id === d.depends_on_id)?.status !== 'closed',
    );
    const inherited = x.dependencies
      .filter((d) => d.type === 'parent-child')
      .flatMap((d) => {
        const parent = this.issues.find((y) => y.id === d.depends_on_id);
        return parent ? this.blockers(parent, new Set(seen)) : [];
      });
    return [...direct, ...inherited];
  }
  async create(draft) {
    if (
      draft.parent &&
      !this.issues.some((x) => x.id === draft.parent && x.issue_type === 'epic')
    )
      throw new Error('Selected parent is not an epic');
    const issue = {
      id: 'obs-user-' + Date.now().toString(36),
      title: draft.title,
      description: draft.description,
      issue_type: draft.type,
      priority: draft.priority,
      status: 'open',
      labels: [],
      dependencies: draft.parent
        ? [{ depends_on_id: draft.parent, type: 'parent-child' }]
        : [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      comments: [],
    };
    this.issues.push(issue);
    this.events.set(issue.id, []);
    return structuredClone(issue);
  }
  async detail(id) {
    const issue = structuredClone(this.issues.find((x) => x.id === id));
    if (!issue) return issue;
    issue.statusEvents = structuredClone(this.events.get(id));
    issue.statusTimeline = statusTimeline(issue, issue.statusEvents);
    return issue;
  }
}
