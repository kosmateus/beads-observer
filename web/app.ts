import { mountSessionPanel } from './sessions.js';
import { initResetUI } from './reset.js';
import { readRoute, routePath } from './routes.js';
import { typeIcon, typeHue } from './types.js';
import { personActivity } from './person-activity.js';
import { valueLabel } from './value-labels.js';
import { priorityMarkup } from './priority.js';
import { initSelects } from './select.js';
import {
  epicAncestors,
  epicChildren,
  epicColor,
  hierarchyPaths,
} from './epics.js';
import { t, locale, dateTime, initLanguage } from './i18n.js';
import { layoutGraph, graphSelection, stageSummary } from './graph.js';
import type {
  Issue,
  Edge,
  Snapshot,
  Activity,
  Project,
  PersonActivity,
  Session,
  SessionResult,
  ProjectView,
  EpicView,
  Position,
  Capabilities,
  MutationResult,
} from './contracts.js';
import { byId, query } from './dom.js';
type SelectId =
  | 'theme'
  | 'epic'
  | 'epic-sort'
  | 'history-order'
  | 'assignee'
  | 'priority'
  | 'type'
  | 'label'
  | 'sort'
  | 'group'
  | 'graph-mode'
  | 'edge-mode'
  | 'list-mode'
  | 'relation-type'
  | 'create-type'
  | 'create-priority'
  | 'create-parent'
  | 'project-select'
  | 'relation-issue'
  | 'relation-target';
type InputId = 'search' | 'graph-context' | 'create-title';
type ButtonId =
  | 'new-issue'
  | 'reset-project'
  | 'submit-create'
  | 'cancel-create'
  | 'submit-relation'
  | 'cancel-relation';
type AppElement<K extends string> = K extends SelectId
  ? HTMLSelectElement
  : K extends InputId
    ? HTMLInputElement
    : K extends ButtonId
      ? HTMLButtonElement
      : K extends 'create-form' | 'relation-form'
        ? HTMLFormElement
        : K extends 'create-dialog' | 'relation-dialog'
          ? HTMLDialogElement
          : K extends 'create-description'
            ? HTMLTextAreaElement
            : HTMLElement;
const $ = <K extends string>(id: K): AppElement<K> => byId(id) as AppElement<K>;
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (x) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        x as '&' | '<' | '>' | '"' | "'"
      ],
  );
function skeleton(kind = 'detail', count = 4) {
  return `<div class="loading-skeleton skeleton-${kind}" role="status" aria-label="${esc(t('loading'))}" aria-busy="true"><span class="sr-only">${t('loading')}</span>${Array.from({ length: count }, () => '<div class="skeleton-block" aria-hidden="true"><i></i><i></i><i></i></div>').join('')}</div>`;
}
const names = new Proxy<Record<string, string>>(
  {},
  { get: (_, key) => valueLabel('status', key) },
);
let liveAgentActivity: Record<string, Pick<Session, 'sessionID' | 'agent'>[]> =
    {},
  presenceTimer: ReturnType<typeof setTimeout>;
let activeAgent: string | null = null,
  agentLoad = 0,
  agentRows: PersonActivity[] = [],
  agentDone = 0,
  agentTotal = 0,
  agentFailures = 0,
  agentLoading = false;
let epicDetails: Partial<Issue> | null = null,
  epicLoad = 0;
let activeEpicId: string | null = null,
  epicSearch = '',
  epicSort = 'priority',
  epicSortDirection = 'asc';
function navigateTo(kind = view, id?: string | null, replace = false) {
  if (!activeProjectId) return;
  const url = new URL(location.href);
  url.pathname = routePath(activeProjectId, kind, id);
  url.hash = '';
  url.searchParams.delete('project');
  url.searchParams.delete('view');
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
}
function applyRoute() {
  const route = readRoute(new URL(location.href));
  if (route.project && route.project !== activeProjectId) {
    if (projectCatalog.some((p) => p.id === route.project))
      selectProject(route.project, true);
    return;
  }
  closeAgentPage(false);
  closeIssuePage(false);
  closeEpic(false);
  if (route.agent) openAgentPage(route.agent, false);
  else if (route.issue) openDetail(route.issue, false, true, false, true);
  else setView(route.view || view, false);
}
function toggleEpicPage(show: boolean) {
  query(document, 'main').classList.toggle('show-epic', show);
  $('epic-page').hidden = !show;
}
function openEpic(id: string, navigate = true) {
  closeAgentPage(false);
  if (activeEpicId !== id) {
    epicDetails = null;
    const savedEpic = epicViews.get(activeProjectId + ':' + id);
    epicSearch = savedEpic?.search || '';
    epicSort = savedEpic?.key || 'priority';
    epicSortDirection = savedEpic?.direction || 'asc';
  }
  activeEpicId = id;
  selectedID = null;
  detailVersion++;
  if (!$('detail').hidden) closeIssuePage(false);
  if (navigate) {
    navigateTo('issues', id);
  }
  issueActivityChoice = 'comments';
  $('detail-body').replaceChildren();
  toggleEpicPage(true);
  renderEpic();
  refreshEpicDetails();
  $('epic-heading')?.focus();
}
function closeEpic(navigate = true) {
  activeEpicId = null;
  toggleEpicPage(false);
  if (navigate) {
    navigateTo();
  }
}
window.addEventListener('popstate', applyRoute);
async function refreshEpicDetails() {
  if (!activeEpicId) return;
  const id = activeEpicId,
    project = activeProjectId,
    request = ++epicLoad;
  try {
    const detail = await fetchIssue(id);
    if (
      request !== epicLoad ||
      id !== activeEpicId ||
      project !== activeProjectId
    )
      return;
    epicDetails = detail;
    if ($('detail').hidden) renderEpic();
  } catch (error) {
    if (
      request === epicLoad &&
      id === activeEpicId &&
      project === activeProjectId
    ) {
      epicDetails = {
        statusEventsWarning:
          error instanceof Error ? error.message : String(error),
      };
      if ($('detail').hidden) renderEpic();
    }
  }
}
function renderEpic() {
  persistEpicView();
  const epic = data.issues.find((x) => x.id === activeEpicId);
  if (!epic || epic.issue_type !== 'epic') {
    $('epic-page').innerHTML =
      `<button id="epic-back">← ${t('board')}</button><p>${t('noIssues')}</p>`;
    $('epic-back').onclick = () => closeEpic();
    return;
  }
  const detail = {
    ...epic,
    ...epicDetails,
    status: epic.status,
    priority: epic.priority,
  };
  const relations = data.edges.filter(
    (e) =>
      e.type !== 'parent-child' &&
      (e.source === epic.id || e.target === epic.id),
  );
  $('epic-page').innerHTML =
    `<div class="detail-top"><button id="epic-back">← ${t(view)}</button>${issueBreadcrumbs(epic)}</div><div class="epic-detail-body"></div>`;
  mountIssueDetails(
    query($('epic-page'), '.epic-detail-body'),
    detail,
    relations,
  );
  if (!epicDetails)
    query($('epic-page'), '.epic-detail-body').insertAdjacentHTML(
      'beforeend',
      skeleton('activity', 2),
    );
  const heading = query($('epic-page'), 'h2');
  heading.id = 'epic-heading';
  heading.tabIndex = -1;
  $('epic-back').onclick = () => closeEpic();
}
function issueChildrenContent(epic: Issue) {
  const children = epicChildren(epic.id, data.issues, data.edges),
    done = children.filter((x) => x.status === 'closed').length;
  const rows = children
    .filter((x) =>
      (x.id + ' ' + x.title)
        .toLocaleLowerCase()
        .includes(epicSearch.toLocaleLowerCase()),
    )
    .sort((a, b) => compareIssues(a, b, epicSort, epicSortDirection));
  const percent = children.length
    ? Math.round((done / children.length) * 100)
    : 0;
  return `<section class="issue-section epic-child-section"><div class="epic-children-heading"><h2>${t('childIssues')} <span class="count">${children.length}</span></h2><button id="epic-create" class="primary" ${data.canCreate ? '' : 'disabled'}>+ ${t('addChild')}</button></div><div class="epic-progress"><progress max="${Math.max(1, children.length)}" value="${done}" aria-label="${t('closed')}"></progress><span>${done}/${children.length} · ${percent}% ${t('closed')}</span></div><p class="muted small">${t('directChildren')}</p><div class="epic-child-tools"><input id="epic-search" aria-label="${t('search')}" placeholder="${t('search')}" value="${esc(epicSearch)}"><select id="epic-sort" aria-label="${t('sort')}"><option value="priority" ${epicSort === 'priority' ? 'selected' : ''}>${t('priority')}</option><option value="title" ${epicSort === 'title' ? 'selected' : ''}>${t('title')}</option></select></div><div class="table-wrap"><table class="epic-children"><thead><tr>${sortHeader('id', 'ID', 'epic')}${sortHeader('title', t('issue'), 'epic')}${sortHeader('priority', t('priority'), 'epic')}${sortHeader('assignee', t('agent'), 'epic')}${sortHeader('status', t('status'), 'epic')}</tr></thead><tbody>${rows.map((child) => `<tr data-issue="${esc(child.id)}" tabindex="0"><td>${issueLink(child)}</td><td><button data-issue="${esc(child.id)}">${esc(child.title)}</button></td><td>${priorityMarkup(child.priority)}</td><td>${avatar(child)}</td><td>${statusBadge(child.status)}${child.blocked ? ' ⊘' : ''}</td></tr>`).join('') || `<tr><td colspan="5">${t('noIssues')}</td></tr>`}</tbody></table></div></section>`;
}
let refreshIssueDetails = () => {};
/** One detail component mounted into either the page or drawer shell. */
function mountIssueDetails(root: HTMLElement, issue: Issue, relations: Edge[]) {
  let closeSessionPanel: (() => void) | undefined;
  function renderComponent() {
    const focused =
      root.querySelector('#epic-search') === document.activeElement;
    const position =
      focused && document.activeElement instanceof HTMLInputElement
        ? document.activeElement.selectionStart
        : null;
    closeSessionPanel?.();
    root.innerHTML = issuePageContent(issue, relations);
    const layout = root.querySelector<HTMLElement>('.issue-layout');
    const children =
      layout?.querySelector<HTMLElement>('.epic-child-section') ||
      layout?.querySelector<HTMLElement>('.issue-activity-section');
    if (children && layout) {
      const lower = document.createElement('div');
      lower.className = 'issue-lower';
      let section: Element | null = children;
      while (section) {
        const next: Element | null = section.nextElementSibling;
        lower.append(section);
        section = next;
      }
      layout.after(lower);
    }
    const logs = root.querySelector<HTMLElement>('#issue-pane-sessions');
    closeSessionPanel = mountSessionPanel(logs, {
      issueId: issue.id,
      url: projectURL('sessions'),
      t,
      skeleton,
    });
    const search = root.querySelector<HTMLInputElement>('#epic-search');
    if (search)
      search.oninput = () => {
        epicSearch = search.value;
        renderComponent();
      };
    const sort = root.querySelector<HTMLSelectElement>('#epic-sort');
    if (sort)
      sort.onchange = () => {
        epicSort = sort.value;
        epicSortDirection = 'asc';
        renderComponent();
      };
    const create = root.querySelector<HTMLButtonElement>('#epic-create');
    if (create) create.onclick = () => newIssue(issue.id);
    const graph = root.querySelector<HTMLButtonElement>('#epic-graph');
    if (graph)
      graph.onclick = () => {
        $('epic').value = issue.id;
        setView('graph');
      };
    const order = root.querySelector<HTMLSelectElement>('#history-order');
    if (order)
      order.onchange = () => {
        historyOrder = order.value;
        storage.set('beads-history-order', historyOrder);
        renderComponent();
      };
    syncSelects();
    if (focused && search) {
      search.focus();
      search.setSelectionRange(position, position);
    }
  }
  refreshIssueDetails = renderComponent;
  renderComponent();
}

let data: Snapshot = {
    issues: [],
    edges: [],
    activity: [],
    revision: 0,
    project: 'OpenCode',
  },
  view = 'board',
  onlyReady = false,
  onlyBlocked = false,
  selectedID: string | null = null,
  detailVersion = 0,
  zoom = 1,
  edgeMode = 'blocking',
  graphMode = 'all',
  listMode = 'all',
  graphContext = false,
  changed = new Set<string>();
const storage = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
let activeProjectId: string | null = null,
  projectCatalog: Project[] = [],
  projectStream: EventSource | null = null,
  projectEpoch = 0;
const detailRequests = new Map<
  string,
  { at: number; request: Promise<Issue> }
>();
function fetchIssue(
  id: string,
  force = false,
  activityOnly = false,
): Promise<Issue> {
  const key = JSON.stringify([
    activeProjectId,
    data.revision,
    id,
    activityOnly,
  ]);
  const cached = detailRequests.get(key);
  if (!force && cached && Date.now() - cached.at < 10000) return cached.request;
  const request = fetch(
    projectURL('issues/' + encodeURIComponent(id)) +
      (activityOnly ? '?activity=1' : ''),
  ).then(async (response) => {
    const result: Issue & { error?: string } = await response.json();
    if (!response.ok) throw Error(result.error || t('readError'));
    return result;
  });
  const entry = { at: Date.now(), request };
  detailRequests.set(key, entry);
  request.catch(() => {
    if (detailRequests.get(key) === entry) detailRequests.delete(key);
  });
  if (detailRequests.size > 250)
    detailRequests.delete(detailRequests.keys().next().value!);
  return request;
}
function storedMap<T>(key: string): Map<string, T> {
  try {
    const value: unknown = JSON.parse(storage.get(key) || '[]');
    return new Map(
      Array.isArray(value)
        ? value.filter(
            (item: unknown): item is [string, T] =>
              Array.isArray(item) &&
              typeof item[0] === 'string' &&
              item[1] &&
              typeof item[1] === 'object',
          )
        : [],
    );
  } catch {
    return new Map();
  }
}
const projectViews = storedMap<ProjectView>('beads-project-views-v1');
const epicViews = storedMap<EpicView>('beads-epic-views-v1');
let listSort = { key: 'priority', direction: 'asc' };
function persistEpicView() {
  if (!activeProjectId || !activeEpicId) return;
  epicViews.set(activeProjectId + ':' + activeEpicId, {
    search: epicSearch,
    key: epicSort,
    direction: epicSortDirection,
  });
  storage.set('beads-epic-views-v1', JSON.stringify([...epicViews]));
}
function compareIssues(a: Issue, b: Issue, key: string, direction: string) {
  const read = (x: Issue) =>
    key === 'epic'
      ? epics(x.id)
          .map((e) => e.title)
          .join(' · ')
      : key === 'relations'
        ? (x.dependencies || []).length
        : key === 'status'
          ? names[x.status] || x.status
          : key === 'priority'
            ? (x.priority ?? 99)
            : x[key as keyof Issue] || '';
  const av = read(a),
    bv = read(b);
  const order =
    typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv), locale(), { numeric: true });
  return (direction === 'desc' ? -1 : 1) * order || a.id.localeCompare(b.id);
}
function sortHeader(key: string, label: string, scope = 'list') {
  const current =
    scope === 'epic'
      ? { key: epicSort, direction: epicSortDirection }
      : listSort;
  const active = current.key === key;
  return `<th aria-sort="${active ? (current.direction === 'desc' ? 'descending' : 'ascending') : 'none'}"><button class="column-sort" data-column-sort="${key}" data-sort-scope="${scope}">${esc(label)}<span aria-hidden="true">${active ? (current.direction === 'desc' ? '↓' : '↑') : '↕'}</span></button></th>`;
}
document.addEventListener('click', (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-column-sort]')
      : null;
  if (!button) return;
  const key = button.dataset.columnSort!;
  if (button.dataset.sortScope === 'epic') {
    epicSortDirection =
      epicSort === key && epicSortDirection === 'asc' ? 'desc' : 'asc';
    epicSort = key;
    refreshIssueDetails();
  } else {
    listSort = {
      key,
      direction:
        listSort.key === key && listSort.direction === 'asc' ? 'desc' : 'asc',
    };
    render();
  }
});
const filterIDs = [
  'search',
  'assignee',
  'priority',
  'type',
  'label',
  'epic',
  'sort',
  'group',
] as const;
function emptyProject(name = 'Beads'): Snapshot {
  return {
    issues: [],
    edges: [],
    activity: [],
    revision: 0,
    project: name,
    demo: false,
    error: null,
    updatedAt: null,
  };
}
function projectURL(suffix: string) {
  if (!activeProjectId) throw new Error('No active project');
  return `/api/projects/${encodeURIComponent(activeProjectId)}/${suffix}`;
}
const media = matchMedia('(prefers-color-scheme: dark)');
$('theme').value = storage.get('beads-theme') || 'system';
function theme() {
  document.documentElement.dataset.theme =
    $('theme').value === 'system'
      ? media.matches
        ? 'dark'
        : 'light'
      : $('theme').value;
  storage.set('beads-theme', $('theme').value);
}
$('theme').onchange = theme;
media.addEventListener('change', theme);
theme();
function populate(id: SelectId, values: (string | undefined)[], label: string) {
  const current = $(id).value;
  $(id).innerHTML =
    `<option value="">${label}</option>` +
    [...new Set(values.filter(Boolean))]
      .sort()
      .map(
        (x) =>
          `<option value="${esc(x)}">${esc(id === 'type' ? valueLabel('type', x) : x)}</option>`,
      )
      .join('');
  $(id).value = current;
}
function epics(id: string) {
  return epicAncestors(id, data.issues, data.edges);
}
function parent(id: string) {
  return epics(id)[0]?.id;
}
function epicBadge(x: Pick<Issue, 'id' | 'issue_type'>) {
  const ancestors = epics(x.id);
  if (!ancestors.length)
    return x.issue_type === 'epic'
      ? `<span class="epic-membership epic-self" style="--epic-color:${epicColor(x.id)}">ϟ ${t('epic')}</span>`
      : '';
  return ancestors
    .map(
      (epic) =>
        `<a class="epic-membership" data-epic="${esc(epic.id)}" href="${routePath(activeProjectId, 'issues', epic.id)}" style="--epic-color:${epicColor(epic.id)}" title="${esc(epic.id + ' · ' + epic.title)}">${esc(epic.title)}</a>`,
    )
    .join('');
}
function filtered() {
  const q = $('search').value.toLocaleLowerCase();
  return data.issues
    .filter(
      (x) =>
        (!q ||
          [x.id, x.title, x.description, ...x.labels]
            .join(' ')
            .toLocaleLowerCase()
            .includes(q)) &&
        (!$('assignee').value || x.assignee === $('assignee').value) &&
        (!$('priority').value || String(x.priority) === $('priority').value) &&
        (!$('type').value || x.issue_type === $('type').value) &&
        (!$('label').value || x.labels.includes($('label').value)) &&
        (!$('epic').value ||
          x.id === $('epic').value ||
          epics(x.id).some((e) => e.id === $('epic').value)) &&
        (!onlyReady || x.ready) &&
        (!onlyBlocked || x.blocked),
    )
    .sort((a, b) =>
      $('sort').value === 'title'
        ? a.title.localeCompare(b.title, locale())
        : $('sort').value === 'updated'
          ? String(b.updated_at).localeCompare(String(a.updated_at))
          : (a.priority ?? 4) - (b.priority ?? 4) || a.id.localeCompare(b.id),
    );
}
function agentPortrait(actor: string | undefined | null) {
  if (!actor)
    return `<svg class="unassigned-icon" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
  // Stable pseudorandom appearance: the same agent keeps its portrait in every project/view.
  let seed = 2166136261;
  for (const c of actor)
    seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  const hue = seed % 360,
    eye = 2 + ((seed >>> 4) % 2),
    antenna = 9 + ((seed >>> 8) % 15);
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="10" fill="hsl(${hue} 55% 32%)"/><path d="M${antenna} 10V5" stroke="hsl(${hue} 80% 82%)" stroke-width="2"/><circle cx="${antenna}" cy="5" r="2" fill="hsl(${(hue + 60) % 360} 90% 72%)"/><rect x="5" y="10" width="22" height="18" rx="${5 + (seed % 4)}" fill="hsl(${hue} 65% 82%)"/><circle cx="11" cy="18" r="${eye}" fill="#182038"/><circle cx="21" cy="18" r="${eye}" fill="#182038"/><path d="M12 24h8" stroke="#182038" stroke-width="2" stroke-linecap="round"/></svg>`;
}
function avatar(x: { id?: string; assignee?: string }) {
  return `<span class="agent-identity"><span class="avatar agent-avatar" title="${esc(x.assignee || t('unassigned'))}" data-agent="${esc(x.assignee || '')}" data-issue-agent="${esc(x.id || '')}" ${x.assignee ? 'role="button" tabindex="0"' : ''}>${agentPortrait(x.assignee)}</span><span class="agent-name">${esc(x.assignee?.replace('agent/', '') || t('unassigned'))}</span></span>`;
}
function statusBadge(status: string) {
  const hues: Record<string, number> = {
    open: 215,
    in_progress: 265,
    blocked: 350,
    deferred: 38,
    closed: 150,
    pinned: 185,
    hooked: 185,
  };
  let hash = 0;
  for (const c of String(status || 'unknown'))
    hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const hue = hues[status] ?? hash % 360;
  return `<span class="status" data-status="${esc(status || 'unknown')}" style="--status-hue:${hue}">${esc(names[status] || status || t('unknown'))}</span>`;
}
function typeBadge(x: Pick<Issue, 'issue_type'>) {
  return `<span class="issue-type" style="--type-hue:${typeHue(x.issue_type)}">${typeIcon(x.issue_type)} ${esc(valueLabel('type', x.issue_type))}</span>`;
}
function relationLabel(type: string) {
  return valueLabel('relation', type);
}
function issueLink(x: { id: string; issue_type?: string }, current = false) {
  x = { ...data.issues.find((item) => item.id === x.id), ...x };
  return `<a class="issue-id-link" style="--type-hue:${typeHue(x.issue_type)}" ${current ? 'id="detail-id" aria-current="page"' : ''} data-detail="${esc(x.id)}" href="${routePath(activeProjectId, 'issues', x.id)}" title="${esc(valueLabel('type', x.issue_type))}">${typeIcon(x.issue_type)}<span>${esc(x.id)}</span></a>`;
}
function issueBreadcrumbs(
  x: { id: string; issue_type?: string },
  detail = false,
) {
  const paths = hierarchyPaths(x.id, data.edges);
  return `<nav class="issue-breadcrumbs" aria-label="${esc(t('parentIssue'))}">${paths
    .map(
      (path, pathIndex) =>
        `<div class="breadcrumb-path">${path
          .map((id, index) => {
            const item =
              id === x.id
                ? x
                : data.issues.find((item) => item.id === id) || {
                    id,
                    issue_type: 'external',
                  };
            return `${index ? '<span class="breadcrumb-separator" aria-hidden="true">/</span>' : ''}${issueLink(item, detail && id === x.id && pathIndex === 0)}`;
          })
          .join('')}</div>`,
    )
    .join('')}</nav>`;
}
function childSection(x: Issue) {
  return issueChildrenContent(x);
}
function card(x: Issue, graph = false) {
  return `<article class="issue ${graph ? 'graph-node' : ''} ${x.graphContext ? 'graph-context' : ''} ${changed.has(x.id) ? 'changed' : ''}" style="--type-hue:${typeHue(x.issue_type)}" data-issue="${esc(x.id)}" tabindex="0" aria-label="${esc(x.id + ' ' + x.title)}"><div class="issue-title">${esc(x.status === 'external' ? t('external') : x.title)}</div>${epicBadge(x)}<div class="issue-footer">${issueLink(x)}<span class="card-people">${priorityMarkup(x.priority)}${avatar(x)}</span></div>${graph ? `<div class="graph-status">${statusBadge(x.status)}${x.blocked ? `<span class="blocker-note">⊘ ${t('blocked')}</span>` : ''}</div>${x.graphContext ? `<small class="graph-context-label">${t('graphContextLabel')}</small>` : ''}` : ''}</article>`;
}
function renderBoard(rows: Issue[]) {
  const group = $('group').value,
    groups = new Map<string, Issue[]>();
  for (const x of rows) {
    const key =
      group === 'assignee'
        ? x.assignee || t('unassigned')
        : group === 'epic'
          ? (x.issue_type === 'epic' ? x.id : parent(x.id)) || t('noEpic')
          : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(x);
  }
  if (!rows.length) groups.set('', []);
  return [...groups]
    .map(
      ([key, items]) =>
        `${key ? `<h2 class="lane-title">${esc(data.issues.find((x) => x.id === key)?.title || key)} · ${esc(key)} · ${items.length}</h2>` : ''}<div class="board">${[
          ...new Set([
            'open',
            'in_progress',
            'blocked',
            'closed',
            ...items.map((x) => x.status),
          ]),
        ]
          .map((status) => {
            const tasks = items.filter((x) => x.status === status);
            return `<div class="column"><div class="column-head"><span class="dot" style="background:${status === 'closed' ? 'var(--green)' : status === 'blocked' ? 'var(--red)' : status === 'in_progress' ? 'var(--accent)' : 'var(--muted)'}"></span>${esc(names[status] || status)} <span class="count">${tasks.length}</span><span class="dots">···</span></div>${tasks.map((x) => card(x)).join('') || `<div class="empty-column">${t('noIssues')}</div>`}</div>`;
          })
          .join('')}</div>`,
    )
    .join('');
}
function typeFilterOptions(selected: string) {
  const types = [
    ...new Set([
      'task',
      'epic',
      'bug',
      'feature',
      'chore',
      'decision',
      'spike',
      'story',
      'milestone',
      ...data.issues.map((x) => x.issue_type).filter(Boolean),
    ]),
  ];
  return (
    `<option value="all" ${selected === 'all' ? 'selected' : ''}>${t('allIssues')}</option>` +
    types
      .map(
        (type) =>
          `<option value="${esc(type)}" ${selected === type ? 'selected' : ''}>${esc(valueLabel('type', type))}</option>`,
      )
      .join('')
  );
}
function stageHeader(index: number, positions: Position[]) {
  const summary = stageSummary(
    positions.filter((p) => p.x === 30 + index * 380).map((p) => p.node),
    !!data.error,
  );
  const label = {
    closed: 'stageClosed',
    in_progress: 'stageRunning',
    ready: 'stageReady',
    blocked: 'stageBlocked',
    deferred: 'stageDeferred',
    open: 'stageOpen',
    incomplete: 'stageIncomplete',
  }[summary.status]!;
  return `<span class="stage-heading">${t('stage')} ${String(index + 1).padStart(2, '0')} <span class="stage-status stage-${summary.status}">${t(label)}</span></span><span class="stage-progress">${summary.closed}/${summary.total} ${t('closed')} · ${summary.running} ${t('inProgress')} · ${summary.blocked} ${t('blocked')}</span>`;
}
function renderGraph(rows: Issue[]) {
  const selection = graphSelection(
    rows,
    data.issues,
    data.edges,
    graphMode,
    edgeMode,
    graphContext,
  );
  const edges = selection.edges;
  const layout = layoutGraph(selection.nodes, edges);
  const positioned = [...layout.positions.values()];
  return `<div class="graph-controls"><select id="graph-mode" aria-label="${t('type')}">${typeFilterOptions(graphMode)}</select><label class="graph-context-toggle"><input type="checkbox" id="graph-context" ${graphContext ? 'checked' : ''}>${t('showGraphContext')}</label><span>${t('dependencyDirection')}</span><select id="edge-mode" aria-label="${t('relations')}"><option value="blocking" ${edgeMode === 'blocking' ? 'selected' : ''}>${t('execution')}</option><option value="all" ${edgeMode === 'all' ? 'selected' : ''}>${t('allRelations')}</option></select><button id="zoom-out" aria-label="${t('zoomOut')}">−</button><span>${Math.round(zoom * 100)}%</span><button id="zoom-in" aria-label="${t('zoomIn')}">+</button><button id="zoom-reset">100%</button><span class="graph-legend">${[...new Set(edges.map((e) => e.type))].map((type) => `<span class="relation-key"><i class="${type === 'blocks' ? '' : 'dashed'}"></i>${esc(relationLabel(type))}</span>`).join(' ')}${selection.hiddenEdges ? ` · ${t('hiddenRelations')}: ${selection.hiddenEdges}` : ''}</span></div><div class="graph-direction-help"><span class="cleared-path-key">${t('clearedDependency')}</span><span class="waiting-path-key">${t('waitingDependency')}</span><span>━━ ${t('blockerDirection')}</span><span>┄┄ ${t('hierarchyDirection')}</span></div><div class="graph-scroll"><div style="width:${layout.width * zoom}px;height:${layout.height * zoom}px"><div class="graph-canvas" style="width:${layout.width}px;height:${layout.height}px;transform:scale(${zoom})"><svg width="${layout.width}" height="${layout.height}" aria-label="${t('dependencies')}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)"/></marker><marker id="arrow-cleared" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--green)"/></marker></defs>${edges
    .map((e) => {
      const a = layout.positions.get(e.source)!,
        b = layout.positions.get(e.target)!,
        x = a.x + 260,
        y = a.y + 58,
        tx = b.x,
        ty = b.y + 58,
        m = (x + tx) / 2;
      const cleared = e.type === 'blocks' && a.node.status === 'closed';
      return `<path class="graph-edge ${e.type === 'blocks' ? '' : 'other'} ${cleared ? 'edge-cleared' : 'edge-waiting'}" style="stroke:${cleared ? 'var(--green)' : 'var(--muted)'};stroke-width:${cleared ? 3.5 : 1};opacity:${cleared ? 1 : 0.55}" marker-end="url(#${cleared ? 'arrow-cleared' : 'arrow'})" d="M ${x} ${y} C ${m} ${y}, ${m} ${ty}, ${tx - 4} ${ty}"/><text class="graph-edge-label" x="${m}" y="${(y + ty) / 2 - 7}" text-anchor="middle">${esc(relationLabel(e.type))}</text>`;
    })
    .join(
      '',
    )}</svg>${Array.from({ length: layout.columns }, (_, i) => `<span class="graph-stage" style="left:${30 + i * 380}px">${stageHeader(i, positioned)}</span>`).join('')}${positioned.map((p) => `<div style="position:absolute;left:${p.x}px;top:${p.y}px">${card(p.node, true)}${p.cycle ? `<span class="tag">${t('cycle')}</span>` : ''}</div>`).join('')}</div></div></div>`;
}
function renderList(rows: Issue[]) {
  const options = `<div class="list-controls"><label>${t('type')} <select id="list-mode">${typeFilterOptions(listMode)}</select></label></div>`;
  rows = [...rows].sort((a, b) =>
    compareIssues(a, b, listSort.key, listSort.direction),
  );
  const visible = rows.filter(
    (x) => listMode === 'all' || x.issue_type === listMode,
  );
  const ordered: { x: Issue; depth: number }[] = [],
    seen = new Set<string>(),
    included = new Map(visible.map((x) => [x.id, x]));
  // Preserve the real hierarchy for every type; never infer parenthood from IDs.
  if (listMode === 'all') {
    for (const x of visible)
      for (const path of hierarchyPaths(x.id, data.edges))
        for (const id of path) {
          const ancestor = data.issues.find((item) => item.id === id);
          if (ancestor) included.set(id, ancestor);
        }
  }
  const parent = new Map<string, string>();
  if (listMode === 'all')
    for (const x of included.values()) {
      const relation = data.edges.find(
        (edge) =>
          edge.type === 'parent-child' &&
          edge.target === x.id &&
          included.has(edge.source),
      );
      if (relation) parent.set(x.id, relation.source);
    }
  const visit = (x: Issue, depth: number) => {
    if (seen.has(x.id)) return;
    seen.add(x.id);
    ordered.push({ x, depth });
    for (const child of [...included.values()].sort((a, b) =>
      compareIssues(a, b, listSort.key, listSort.direction),
    ))
      if (parent.get(child.id) === x.id) visit(child, depth + 1);
  };
  for (const x of [...included.values()].sort((a, b) =>
    compareIssues(a, b, listSort.key, listSort.direction),
  ))
    if (!parent.has(x.id)) visit(x, 0);
  for (const x of included.values()) visit(x, 0);
  return (
    options +
    '<div class="view-scroll">' +
    `<div class="table-wrap"><table><thead><tr>${sortHeader('id', 'ID')}${sortHeader('title', t('issue'))}${sortHeader('epic', t('parentIssue'))}${sortHeader('status', t('status'))}${sortHeader('priority', t('priority'))}${sortHeader('assignee', t('agent'))}${sortHeader('relations', t('relations'))}</tr></thead><tbody>${ordered
      .map(
        ({ x, depth }) =>
          `<tr class="${x.issue_type === 'epic' ? 'epic-row' : ''} ${[...parent.values()].includes(x.id) ? 'tree-parent' : ''} ${depth === 0 ? 'tree-root' : 'tree-child'}" data-depth="${depth}" data-list-issue="${esc(x.id)}" data-issue="${esc(x.id)}" tabindex="0"><td class="tree-identity"><div class="tree-indent" style="--tree-depth:${depth}">${depth ? `<span class="tree-branch" aria-hidden="true"></span>` : ''}${issueLink(x)}</div></td><td><button data-issue="${esc(x.id)}">${esc(x.title)}</button></td><td class="epic-cell">${
            data.edges
              .filter(
                (edge) => edge.type === 'parent-child' && edge.target === x.id,
              )
              .map((edge) =>
                issueLink(
                  data.issues.find((item) => item.id === edge.source) || {
                    id: edge.source,
                  },
                ),
              )
              .join(' ') || `<span class="muted">—</span>`
          }</td><td>${statusBadge(x.status)} ${x.blocked ? '⊘' : ''}</td><td>${priorityMarkup(x.priority)}</td><td>${avatar(x)}</td><td>${x.dependencies.length}</td></tr>`,
      )
      .join('')}</tbody></table></div>` +
    '</div>'
  );
}
function renderActivity(rows: Issue[]) {
  const ids = new Set(rows.map((x) => x.id));
  const events = data.activity.filter((x) => ids.has(x.id));
  return events.length
    ? `<div class="activity-list">${events.map((x) => `<div class="activity-row"><span class="avatar">${esc(x.actor.slice(-2).toUpperCase())}</span><div class="activity-content"><div class="activity-heading">${issueLink(x)}<button data-issue="${esc(x.id)}">${esc(x.status === 'external' ? t('external') : x.title)}</button></div><small>${esc(x.actor)} · ${esc(activityText(x))}</small></div><time>${dateTime(x.at, true)}</time></div>`).join('')}</div>`
    : `<div class="empty">${t('emptyActivity')}<br><small>${t('activityScope')}</small></div>`;
}
const syncSelects = initSelects();
function render() {
  if (data.revision) saveProjectView();
  $('sort').closest('label')!.hidden = view === 'list';
  $('view-title').textContent = t(view);
  if (activeEpicId && $('detail').hidden) renderEpic();
  if (
    activeAgent ||
    activeEpicId ||
    query(document, 'main').classList.contains('show-issue')
  )
    return;
  const rows = filtered();
  $('result-count').textContent =
    `${rows.length} ${t('of')} ${data.issues.length} · ${t('issues')}`;
  $('activity-count').textContent = String(data.activity.length);
  $('footer-count').textContent =
    `${t('relations')}: ${data.edges.length} · ${t('revision')}: ${data.revision}`;
  const scroll =
    $('content').querySelector('.graph-scroll') ||
    $('content').querySelector('.view-scroll');
  const pos = scroll ? [scroll.scrollLeft, scroll.scrollTop] : [0, 0];
  const innerScroll = [
    ...$('content').querySelectorAll('.board, .table-wrap'),
  ].map((node) => node.scrollLeft);
  $('content').innerHTML =
    !data.revision && !data.error
      ? skeleton(view, view === 'board' ? 6 : 4)
      : view === 'graph'
        ? renderGraph(rows)
        : view === 'list'
          ? renderList(rows)
          : view === 'activity'
            ? `<div class="view-scroll">${renderActivity(rows)}</div>`
            : `<div class="view-scroll">${renderBoard(rows)}</div>`;
  syncSelects();
  const after =
    $('content').querySelector('.graph-scroll') ||
    $('content').querySelector('.view-scroll');
  if (after) {
    after.scrollLeft = pos[0];
    after.scrollTop = pos[1];
  }
  [...$('content').querySelectorAll('.board, .table-wrap')].forEach(
    (node, index) => {
      node.scrollLeft = innerScroll[index] || 0;
    },
  );
  if ($('list-mode'))
    $('list-mode').onchange = () => {
      listMode = $('list-mode').value;
      render();
    };
  if ($('graph-mode'))
    $('graph-mode').onchange = () => {
      graphMode = $('graph-mode').value;
      render();
    };
  if ($('graph-context'))
    $('graph-context').onchange = () => {
      graphContext = $('graph-context').checked;
      render();
    };
  if ($('edge-mode'))
    $('edge-mode').onchange = () => {
      edgeMode = $('edge-mode').value;
      render();
    };
  for (const [id, fn] of [
    ['zoom-out', () => (zoom = Math.max(0.5, zoom - 0.1))],
    ['zoom-in', () => (zoom = Math.min(1.5, zoom + 0.1))],
    ['zoom-reset', () => (zoom = 1)],
  ] as const)
    if ($(id))
      $(id).onclick = () => {
        fn();
        render();
      };
}
function setView(next: string, navigate = true) {
  if (activeAgent) closeAgentPage(false);
  if (!$('detail').hidden) closeIssuePage(false);
  if (activeEpicId) closeEpic(false);
  view = next;
  if (navigate) navigateTo(next);
  document
    .querySelectorAll<HTMLElement>('[data-view]')
    .forEach((b) => b.classList.toggle('selected', b.dataset.view === view));
  $('view-title').textContent = (
    {
      board: t('board'),
      graph: t('graph'),
      list: t('list'),
      activity: t('activity'),
    } as Record<string, string>
  )[view];
  $('group').disabled = view !== 'board';
  render();
}
document
  .querySelectorAll<HTMLElement>('[data-view]')
  .forEach((b) => (b.onclick = () => setView(b.dataset.view!)));
for (const id of [
  'search',
  'assignee',
  'priority',
  'type',
  'label',
  'epic',
  'sort',
  'group',
] as const)
  $(id).addEventListener(id === 'search' ? 'input' : 'change', render);
for (const id of ['ready', 'blocked'])
  $(id).onclick = () => {
    if (id === 'ready') onlyReady = !onlyReady;
    else onlyBlocked = !onlyBlocked;
    $(id).setAttribute(
      'aria-pressed',
      String(id === 'ready' ? onlyReady : onlyBlocked),
    );
    render();
  };
$('clear').onclick = () => {
  for (const id of [
    'search',
    'assignee',
    'priority',
    'type',
    'label',
    'epic',
  ] as const)
    $(id).value = '';
  onlyReady = onlyBlocked = false;
  $('ready').setAttribute('aria-pressed', 'false');
  $('blocked').setAttribute('aria-pressed', 'false');
  render();
};
function closeIssuePage(navigate = true) {
  $('detail').hidden = true;
  $('detail-body').replaceChildren();
  query(document, 'main').classList.remove('show-issue');
  if (activeEpicId) renderEpic();
  selectedID = null;
  detailVersion++;
  if (navigate) {
    if (activeEpicId) navigateTo('issues', activeEpicId);
    else navigateTo();
  }
}
$('close-detail').onclick = () => closeIssuePage();
document.addEventListener('keydown', (e) => {
  if (
    e.key === '/' &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(
      document.activeElement?.tagName || '',
    ) &&
    $('detail').hidden
  ) {
    e.preventDefault();
    $('search').focus();
  }
});
document.addEventListener('click', (e) => {
  if (!(e.target instanceof Element)) return;
  const link = e.target.closest<HTMLElement>('[data-detail]');
  if (link) {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      openDetail(link.dataset.detail!, false, false, true, true);
    }
    return;
  }
  const epic = e.target.closest<HTMLElement>('[data-epic]');
  if (epic) {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      openEpic(epic.dataset.epic!);
    }
    return;
  }
  const button = e.target.closest<HTMLElement>('[data-issue]');
  if (button) openDetail(button.dataset.issue!);
});
function duration(ms: number) {
  return new Intl.NumberFormat(locale(), {
    maximumFractionDigits: 1,
    style: 'unit',
    unit: ms >= 3600000 ? 'hour' : ms >= 60000 ? 'minute' : 'second',
    unitDisplay: 'short',
  }).format(ms / (ms >= 3600000 ? 3600000 : ms >= 60000 ? 60000 : 1000));
}
function statusStatistics(x: Issue) {
  const timeline = x.statusTimeline;
  if (!timeline || timeline.reason)
    return `<section class="status-statistics"><h3>${t('statusTiming')}</h3><p class="muted">${t(timeline?.reason === 'ambiguous' ? 'timingAmbiguous' : 'timingUnavailable')}</p></section>`;
  const total = timeline.totals.reduce((sum, item) => sum + item.durationMs, 0);
  return `<section class="status-statistics"><h3>${t('statusTiming')}</h3><p class="timing-scope">${t('timingScope')}<br>${esc(dateTime(timeline.from))} → ${esc(dateTime(timeline.asOf))}</p><div class="status-totals">${timeline.totals.map((item) => `<div><span>${esc(names[item.status] || item.status)}</span><strong>${esc(duration(item.durationMs))}</strong><div class="timing-bar"><i style="width:${total ? (item.durationMs / total) * 100 : 0}%"></i></div></div>`).join('')}</div><ol class="status-timeline">${timeline.transitions.map((item) => `<li>${statusBadge(item.status)}<time>${esc(dateTime(item.at))}</time><strong>${esc(duration(item.durationMs))}${item.ongoing ? ' · ' + t('timingCurrent') : ''}</strong><small>${esc(item.actor)}</small></li>`).join('')}</ol></section>`;
}
let historyOrder =
  storage.get('beads-history-order') === 'oldest' ? 'oldest' : 'newest';
function auditHistory(issue: Issue) {
  const events = [...(issue.statusEvents || [])].sort(
    (a, b) =>
      (Date.parse(b.created_at) - Date.parse(a.created_at)) *
      (historyOrder === 'oldest' ? -1 : 1),
  );
  const parse = (value: string | undefined): Record<string, unknown> | null => {
    try {
      const x: unknown = JSON.parse(value!);
      return x && typeof x === 'object' && !Array.isArray(x)
        ? (x as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const value = (key: string, v: unknown): string =>
    key === 'assignee'
      ? avatar({ assignee: typeof v === 'string' ? v : undefined })
      : v === undefined || v === null
        ? '—'
        : key === 'status'
          ? statusBadge(String(v))
          : key === 'priority'
            ? priorityMarkup(v)
            : key === 'assignee'
              ? avatar({ assignee: typeof v === 'string' ? v : undefined })
              : key === 'issue_type'
                ? esc(valueLabel('type', v))
                : key === 'dependency_type' || key === 'relation_type'
                  ? esc(valueLabel('relation', v))
                  : esc(typeof v === 'object' ? JSON.stringify(v) : String(v));
  const controls = `<div class="audit-controls"><span>${t('historyScope')}</span><select id="history-order" aria-label="${t('sort')}"><option value="newest" ${historyOrder === 'newest' ? 'selected' : ''}>${t('newestFirst')}</option><option value="oldest" ${historyOrder === 'oldest' ? 'selected' : ''}>${t('oldestFirst')}</option></select></div>`;
  if (!events.length)
    return `<p class="muted">${t(issue.statusEventsWarning ? 'historyUnavailable' : 'noHistory')}</p>`;
  return (
    controls +
    `<ol class="audit-history">${events
      .map((event) => {
        const before = parse(event.old_value),
          after = parse(event.new_value);
        const changes = after
          ? Object.entries(after).filter(
              ([key, v]) =>
                !['id', 'created_at', 'updated_at'].includes(key) &&
                JSON.stringify(before?.[key]) !== JSON.stringify(v),
            )
          : [];
        const eventName = valueLabel('event', event.event_type);
        return `<li><span class="avatar agent-avatar" title="${esc(event.actor || t('unknown'))}" data-agent="${esc(event.actor || '')}" role="button" tabindex="0">${agentPortrait(event.actor)}</span><div class="audit-entry"><div class="audit-heading"><strong>${esc(event.actor || t('unknown'))}</strong><span>${esc(eventName)}</span><time>${esc(dateTime(event.created_at))}</time></div>${changes.map(([key, v]) => `<div class="audit-change"><strong>${esc(valueLabel('field', key))}</strong><span>${value(key, before?.[key])}</span><span aria-hidden="true">→</span><span>${value(key, v)}</span></div>`).join('')}${!after && event.new_value ? `<p class="prose">${esc(event.new_value)}</p>` : ''}</div></li>`;
      })
      .join('')}</ol>`
  );
}
function linkedIssues(id: string, relations: Edge[]) {
  if (!relations.length) return `<p class="muted">${t('noRelations')}</p>`;
  const groups = new Map<
    string,
    { type: string; outgoing: boolean; edges: Edge[] }
  >();
  for (const edge of relations) {
    const outgoing = edge.source === id;
    const key = edge.type + (outgoing ? ':out' : ':in');
    if (!groups.has(key))
      groups.set(key, { type: edge.type, outgoing, edges: [] });
    groups.get(key)!.edges.push(edge);
  }
  return [...groups.values()]
    .map((group) => {
      const heading =
        group.type === 'blocks'
          ? t(group.outgoing ? 'blocks' : 'waitsFor')
          : relationLabel(group.type) + (group.outgoing ? ' →' : ' ←');
      return `<section class="linked-group"><h4>${esc(heading)}</h4><div class="linked-rows">${group.edges
        .map((edge) => {
          const other = group.outgoing ? edge.target : edge.source;
          const item: Pick<
            Issue,
            'id' | 'title' | 'issue_type' | 'status' | 'priority' | 'assignee'
          > = data.issues.find((x) => x.id === other) || {
            id: other,
            title: t('external'),
            issue_type: 'external',
            status: 'external',
          };
          return `<div class="linked-row" tabindex="0" data-issue="${esc(other)}" aria-label="${esc(other + ' · ' + item.title)}">${issueLink({ ...item, id: other })}<span class="linked-title">${esc(item.title)}</span>${priorityMarkup(item.priority)}<span class="avatar agent-avatar" title="${esc(item.assignee || t('unassigned'))}" data-agent="${esc(item.assignee || '')}" role="button" tabindex="0">${agentPortrait(item.assignee)}</span>${statusBadge(item.status)}</div>`;
        })
        .join('')}</div></section>`;
    })
    .join('');
}
let issueActivityChoice = 'comments';
function issuePageContent(x: Issue, relations: Edge[]) {
  const tab = issueActivityChoice;
  const comments =
    (x.comments || [])
      .map(
        (c) =>
          `<article class="comment"><div class="comment-author"><span class="comment-identity">${avatar({ assignee: c.author })}</span><time>${esc(dateTime(c.created_at))}</time></div><p class="prose">${esc(c.text || c.body || c.content)}</p></article>`,
      )
      .join('') || `<p class="muted">${t('noComments')}</p>`;
  const fields: [string, string | undefined][] = [
    ['description', x.description],
    ['acceptance', x.acceptance_criteria],
    ['design', x.design],
    ['notes', x.notes],
  ];
  return `<div class="issue-page-title"><div><h2>${typeIcon(x.issue_type)} ${esc(x.title)}</h2>${epicBadge(x)}</div></div><div class="issue-actions">${x.issue_type === 'epic' ? `<button id="epic-graph">⑂ ${t('graph')}</button>` : ''}<button data-edit-issue="${esc(x.id)}">${t('editIssue')}</button><button data-new-child="${esc(x.id)}">+ ${t('addChild')}</button><button data-add-relation="${esc(x.id)}">+ ${t('addRelation')}</button>${statusBadge(x.status)}${x.status === 'closed' && x.close_reason ? `<span class="close-reason-badge" title="${esc(t('closeReason'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m7 12 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg><span>${esc(t('closeReason'))}: ${esc(x.close_reason)}</span></span>` : ''}</div><div class="issue-layout"><div class="issue-main"><section class="issue-section"><h3>${t('details')}</h3><dl class="issue-details"><dt>${t('type')}</dt><dd>${typeBadge(x)}</dd><dt>${t('priority')}</dt><dd>${priorityMarkup(x.priority)}</dd><dt>${t('label')}</dt><dd>${(x.labels || []).map((label) => `<span class="tag">${esc(label)}</span>`).join(' ') || '—'}</dd></dl></section>${fields
    .filter(([key, v]) => key === 'description' || v)
    .map(
      ([key, v]) =>
        `<section class="issue-section"><h3>${t(key)}</h3><div class="prose">${esc(v || '—')}</div></section>`,
    )
    .join(
      '',
    )}${childSection(x)}<section class="issue-section"><div class="section-heading"><h3>${t('dependencies')} · ${relations.length}</h3><button class="section-add" data-add-relation="${esc(x.id)}" aria-label="${esc(t('addRelation'))}" title="${esc(t('addRelation'))}">+</button></div>${linkedIssues(x.id, relations)}</section><section class="issue-section issue-activity-section"><div class="activity-section-heading"><h3>${t('activity')}</h3><select id="issue-activity" aria-label="${t('activity')}">${[
    ['comments', t('comments')],
    ['history', t('changeHistory')],
    ['timing', t('statusTiming')],
    ['sessions', t('openCodeSessions')],
  ]
    .map(
      ([key, label]) =>
        `<option value="${key}" ${tab === key ? 'selected' : ''}>${label}</option>`,
    )
    .join(
      '',
    )}</select></div><div id="issue-pane-comments" role="region" aria-label="${t('comments')}" ${tab !== 'comments' ? 'hidden' : ''}>${comments}</div><div id="issue-pane-history" role="region" aria-label="${t('changeHistory')}" ${tab !== 'history' ? 'hidden' : ''}>${auditHistory(x)}</div><div id="issue-pane-timing" role="region" aria-label="${t('statusTiming')}" ${tab !== 'timing' ? 'hidden' : ''}>${statusStatistics(x)}</div><div id="issue-pane-sessions" role="region" aria-label="${t('openCodeSessions')}" ${tab !== 'sessions' ? 'hidden' : ''}></div></section></div><aside class="issue-sidebar"><section><h3>${t('people')}</h3><dl><dt>${t('agent')}</dt><dd>${avatar(x)}</dd><dt>${t('reporter')}</dt><dd>${x.created_by ? avatar({ assignee: x.created_by }) : '—'}</dd></dl></section><section><h3>${t('dates')}</h3><dl>${[
    ['dateCreated', x.created_at],
    ['updated', x.updated_at],
    ['due', x.due_at],
    ['deferredUntil', x.defer_until],
    ['closed', x.closed_at],
  ]
    .filter(
      ([key, value]) => value || key === 'dateCreated' || key === 'updated',
    )
    .map(
      ([key, value]) => `<dt>${t(key!)}</dt><dd>${esc(dateTime(value))}</dd>`,
    )
    .join('')}</dl></section></aside></div>`;
}
document.addEventListener('change', (event) => {
  if (
    !(event.target instanceof HTMLSelectElement) ||
    event.target.id !== 'issue-activity'
  )
    return;
  issueActivityChoice = event.target.value;
  for (const key of ['comments', 'history', 'timing', 'sessions'])
    $('issue-pane-' + key).hidden = key !== issueActivityChoice;
});
async function openDetail(
  id: string,
  quiet = false,
  _force = false,
  navigate = true,
  page = false,
) {
  if (
    !quiet &&
    page &&
    data.issues.find((x) => x.id === id)?.issue_type === 'epic'
  ) {
    openEpic(id, navigate);
    return;
  }
  if (!quiet || selectedID !== id) issueActivityChoice = 'comments';
  if (activeEpicId) $('epic-page').replaceChildren();
  if (activeAgent && page) {
    closeAgentPage(false);
  }
  selectedID = id;
  const version = ++detailVersion;
  const epoch = projectEpoch;
  $('detail-breadcrumbs').innerHTML = issueBreadcrumbs(
    data.issues.find((item) => item.id === id) || { id },
    true,
  );
  $('detail').hidden = false;
  if (!quiet || !$('detail').dataset.mode)
    $('detail').dataset.mode = page ? 'page' : 'drawer';
  if (page) $('detail').dataset.mode = 'page';
  const fullPage = $('detail').dataset.mode === 'page';
  query(document, 'main').classList.toggle('show-issue', fullPage);
  $('close-detail').textContent = fullPage ? '←' : '✕';
  $('detail-resize').hidden = fullPage;
  if (!quiet && navigate && fullPage) {
    navigateTo('issues', id);
  }
  if (!quiet) $('detail-body').innerHTML = skeleton('detail', 3);
  try {
    const x = await fetchIssue(id);
    if (version !== detailVersion || epoch !== projectEpoch) return;
    const relation = data.edges.filter(
      (e) => e.type !== 'parent-child' && (e.source === id || e.target === id),
    );
    $('detail-breadcrumbs').innerHTML = issueBreadcrumbs(x, true);
    mountIssueDetails($('detail-body'), x, relation);
  } catch (error) {
    if (version === detailVersion && epoch === projectEpoch)
      $('detail-body').innerHTML =
        `<p role="alert">${esc(error instanceof Error ? error.message : String(error))}</p>`;
  }
}
function refreshChrome() {
  for (const option of $('relation-type').options)
    option.textContent = valueLabel('relation', option.value);
  for (const option of $('create-type').options)
    option.textContent = valueLabel('type', option.value);
  $('project').textContent = data.project;
  const selected = projectCatalog.find((p) => p.id === activeProjectId);
  $('project-path').textContent = selected?.cwd || '';
  $('project-path').title = selected?.cwd || '';
  $('database-path').textContent = data.location?.path || '';
  $('database-path').title = data.location?.path || '';
  $('new-issue').disabled = !activeProjectId;
  $('reset-project').disabled = !data.canReset;

  const versions = selected?.hostVersions || data.hostVersions || [];
  $('host-version').hidden = !versions.length;
  $('host-version').textContent = versions.length
    ? `OpenCode ${versions.join(' / ')}`
    : '';
  $('error').hidden = !data.error;
  $('error').textContent = data.error ? t('readError') + '\n' + data.error : '';
  $('beads-version').textContent = data.beadsVersion || '';
  $('beads-version').hidden = !data.beadsVersion;
  $('connection').textContent = data.error ? t('stale') : t('live');
  $('connection-dot').style.background = data.error
    ? 'var(--red)'
    : 'var(--green)';
  $('sync-time').textContent = data.updatedAt
    ? t('sync') + ' ' + dateTime(data.updatedAt, true)
    : '';
  populate(
    'assignee',
    data.issues.map((x) => x.assignee),
    t('agents'),
  );
  populate(
    'type',
    data.issues.map((x) => x.issue_type),
    t('type'),
  );
  populate(
    'label',
    data.issues.flatMap((x) => x.labels),
    t('noFilter'),
  );
  populate(
    'epic',
    data.issues.filter((x) => x.issue_type === 'epic').map((x) => x.id),
    t('epics'),
  );
  for (const option of $('epic').options)
    if (option.value) {
      const epic = data.issues.find((x) => x.id === option.value);
      option.textContent = epic ? `${epic.title} · ${epic.id}` : option.value;
    }
}
function activityText(event: Activity) {
  const transition = event.text?.split(' → ');
  if (transition?.length === 2)
    return transition.map((status) => names[status] || status).join(' → ');
  const keys: Record<string, string> = {
    'Nowe zadanie': 'newIssue',
    'Aktualizacja zadania': 'updatedIssue',
    'Zadanie usunięte': 'deletedIssue',
  };
  return keys[event.text] ? t(keys[event.text]) : event.text;
}
function receive(next: Snapshot) {
  const old = new Map(data.issues.map((x) => [x.id, x]));
  changed = new Set(
    next.issues
      .filter(
        (x) =>
          old.has(x.id) && JSON.stringify(x) !== JSON.stringify(old.get(x.id)),
      )
      .map((x) => x.id),
  );
  data = next;
  if (activeAgent) renderAgentPage();
  if (activeEpicId) refreshEpicDetails();
  refreshChrome();
  render();
  if (selectedID) openDetail(selectedID, true);
  const route = readRoute(new URL(location.href));
  if (!activeAgent && route.agent) openAgentPage(route.agent, false);
  if (!selectedID && !activeEpicId && route.issue)
    openDetail(route.issue, true, true, false, true);
}
function saveProjectView() {
  if (!activeProjectId) return;
  projectViews.set(activeProjectId, {
    view,
    onlyReady,
    onlyBlocked,
    zoom,
    edgeMode,
    graphMode,
    listMode,
    listSort,
    graphContext,
    filters: Object.fromEntries(filterIDs.map((id) => [id, $(id).value])),
  });
  storage.set('beads-project-views-v1', JSON.stringify([...projectViews]));
}
function selectProject(id: string | null, preserveRoute = false) {
  const requestedRoute = readRoute(new URL(location.href));
  const retainRoute = preserveRoute || !activeProjectId;
  if (id === activeProjectId) return;
  closeAgentPage(false);
  saveProjectView();
  if (activeEpicId) closeEpic(false);
  projectStream?.close();
  projectStream = null;
  projectEpoch++;
  detailVersion++;
  selectedID = null;
  if (!$('detail').hidden) closeIssuePage(false);
  activeProjectId = id;
  liveAgentActivity = {};
  storage.set('beads-project', id || '');
  const selected = projectCatalog.find((p) => p.id === id);
  const saved = projectViews.get(id!);
  view = (retainRoute ? requestedRoute.view : null) || saved?.view || 'board';
  onlyReady = saved?.onlyReady || false;
  onlyBlocked = saved?.onlyBlocked || false;
  zoom = saved?.zoom || 1;
  edgeMode =
    new URLSearchParams(location.search).get('relations') === 'all'
      ? 'all'
      : saved?.edgeMode || 'blocking';
  graphMode =
    ({ tasks: 'task', epics: 'epic' } as Record<string, string>)[
      saved?.graphMode || ''
    ] ||
    saved?.graphMode ||
    'all';
  listMode =
    ({ tasks: 'task', epics: 'epic' } as Record<string, string>)[
      saved?.listMode || ''
    ] ||
    saved?.listMode ||
    'all';
  listSort = saved?.listSort || { key: 'priority', direction: 'asc' };
  graphContext = saved?.graphContext ?? false;
  for (const key of filterIDs)
    $(key).value = key === 'sort' ? 'priority' : key === 'group' ? 'none' : '';
  $('ready').setAttribute('aria-pressed', String(onlyReady));
  $('blocked').setAttribute('aria-pressed', String(onlyBlocked));
  changed = new Set();
  data = emptyProject(selected?.name);
  refreshChrome();
  setView(view, false);
  if (retainRoute && requestedRoute.agent)
    navigateTo('agents', requestedRoute.agent, true);
  else if (retainRoute && requestedRoute.issue)
    navigateTo('issues', requestedRoute.issue, true);
  else navigateTo(view, undefined, true);
  $('project-select').value = id || '';
  if (!id) {
    $('connection').textContent = t('waiting');
    return;
  }
  const epoch = projectEpoch;
  let first = true;
  projectStream = new EventSource(projectURL('events'));
  projectStream.onmessage = (e) => {
    if (epoch !== projectEpoch) return;
    try {
      const next: Snapshot = JSON.parse(e.data);
      if (next.projectId !== activeProjectId) return;
      receive(next);
      // Wait for the first successful data load before restoring select options.
      if (first && next.revision) {
        first = false;
        if (saved) {
          for (const key of filterIDs)
            $(key).value = saved.filters?.[key] || '';
          render();
        }
      }
    } catch (error) {
      $('error').hidden = false;
      $('error').textContent =
        error instanceof Error ? error.message : String(error);
    }
  };
  projectStream.onerror = () => {
    if (epoch !== projectEpoch) return;
    $('connection').textContent = t('reconnecting');
    $('connection-dot').style.background = 'var(--amber)';
  };
  projectStream.addEventListener('project-removed', () => {
    if (epoch === projectEpoch) selectProject(null);
  });
}
function updateProjects(next: Project[]) {
  projectCatalog = next;
  $('project-select').replaceChildren();
  if (!next.length) $('project-select').add(new Option(t('waiting'), ''));
  for (const project of next)
    $('project-select').add(
      new Option(`${project.name} — ${project.cwd}`, project.id),
    );
  const selected = next.some((p) => p.id === activeProjectId)
    ? activeProjectId
    : next.find(
        (p) =>
          p.id ===
          (readRoute(new URL(location.href)).project ||
            storage.get('beads-project')),
      )?.id ||
      next[0]?.id ||
      null;
  $('project-select').value = selected || '';
  selectProject(selected);
  refreshChrome();
}
$('project-select').addEventListener('change', () => {
  const previous = location.href;
  selectProject($('project-select').value);
  const next = location.href;
  if (previous !== next) {
    history.replaceState(null, '', previous);
    history.pushState(null, '', next);
  }
});
const catalogStream = new EventSource('/api/projects/events');
catalogStream.onmessage = (e) => {
  try {
    updateProjects(JSON.parse(e.data));
  } catch (error) {
    $('error').hidden = false;
    $('error').textContent =
      error instanceof Error ? error.message : String(error);
  }
};
catalogStream.onerror = () => {
  if (!activeProjectId) $('connection').textContent = t('reconnecting');
};
window.addEventListener('pagehide', () => {
  catalogStream.close();
  projectStream?.close();
});
initLanguage(() => {
  refreshChrome();
  render();
  if (selectedID) openDetail(selectedID, true);
});

let creating = false,
  draftProject: string | null = null,
  draftRequestId: string | null = null,
  editingID: string | null = null;
function newIssue(parentId = '', type = 'task') {
  editingID = null;
  for (const option of [...$('create-type').options])
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
      ].includes(option.value)
    )
      option.remove();
  $('create-type').disabled = false;
  $('create-parent').disabled = false;
  $('submit-create').textContent = t('create');
  draftProject = activeProjectId;
  draftRequestId = crypto.randomUUID();
  $('create-form').reset();
  $('create-type').value = type;
  $('create-error').hidden = true;
  $('create-notice').hidden = !!data.canCreate;
  $('create-notice').textContent = t('readOnlyCreation');
  $('submit-create').disabled = !data.canCreate;
  $('submit-create').hidden = !data.canCreate;
  $('create-heading').textContent = t(type === 'epic' ? 'epic' : 'newIssue');
  $('create-project').textContent =
    `${data.project} · ${data.projectPath || ''}`;
  $('create-parent').replaceChildren(new Option(t('noParent'), ''));
  for (const item of data.issues.filter((x) => x.status !== 'external')) {
    const option = new Option(
      `${valueLabel('type', item.issue_type)} · ${item.title} · ${item.id}`,
      item.id,
    );
    option.dataset.issueType = item.issue_type;
    option.dataset.issueId = item.id;
    option.dataset.issueTitle = item.title;
    $('create-parent').add(option);
  }
  $('create-parent').value = parentId;
  syncSelects();
  $('create-dialog').showModal();
  $('create-title').focus();
}
$('new-issue').onclick = () => newIssue();

$('cancel-create').onclick = () => {
  if (!creating) $('create-dialog').close();
};
$('create-dialog').addEventListener('cancel', (event) => {
  if (creating) event.preventDefault();
});
$('create-form').onsubmit = async (event) => {
  event.preventDefault();
  if (
    !(editingID ? data.canEdit : data.canCreate) ||
    draftProject !== activeProjectId ||
    creating ||
    !$('create-form').reportValidity()
  )
    return;
  creating = true;
  $('submit-create').disabled = true;
  $('cancel-create').disabled = true;
  $('submit-create').textContent = t('creating');
  $('create-error').hidden = true;
  const payload = {
    title: $('create-title').value,
    description: $('create-description').value,
    type: $('create-type').value,
    priority: Number($('create-priority').value),
    parent: $('create-parent').value,
  };
  try {
    const capabilities = await fetch('/api/capabilities');
    if (!capabilities.ok) throw Error('Unavailable');
    const { csrfToken }: Capabilities = await capabilities.json();
    const response = await fetch(
      `/api/projects/${encodeURIComponent(draftProject!)}/${editingID ? 'updates' : 'issues'}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Observer-Token': csrfToken,
          'X-Request-ID': draftRequestId!,
        },
        body: JSON.stringify(
          editingID
            ? {
                id: editingID,
                title: payload.title,
                description: payload.description,
                priority: payload.priority,
              }
            : payload,
        ),
      },
    );
    const result: MutationResult = await response.json();
    if (!response.ok) throw Error(result.error || 'Creation failed');
    $('create-dialog').close();
    if (editingID) {
      const snapshot = await fetch(projectURL('snapshot'));
      if (snapshot.ok) receive(await snapshot.json());
    }
    createdToast(result.id, editingID ? 'updated' : payload.type, draftProject);
  } catch (error) {
    $('create-error').hidden = false;
    $('create-error').textContent =
      t('createUncertain') +
      ' ' +
      (error instanceof Error ? error.message : String(error));
  } finally {
    creating = false;
    $('submit-create').disabled = false;
    $('cancel-create').disabled = false;
    $('submit-create').textContent = t('create');
  }
};

function createdToast(id: string, type: string, project: string | null) {
  const toast = $('toast');
  toast.innerHTML = `<span>${t(type === 'updated' ? 'issueUpdated' : type === 'epic' ? 'epicCreated' : 'issueCreated')}</span>${issueLink(data.issues.find((item) => item.id === id) || { id, issue_type: type })}<button id="toast-view">${t('viewCreated')}</button><button id="toast-dismiss" aria-label="${t('close')}">✕</button>`;
  toast.hidden = false;
  $('toast-dismiss').onclick = () => (toast.hidden = true);
  $('toast-view').onclick = async () => {
    if (activeProjectId !== project) selectProject(project);
    try {
      const response = await fetch(projectURL('snapshot'));
      if (!response.ok) throw Error(t('readError'));
      const snapshot: Snapshot = await response.json();
      if (activeProjectId !== project) return;
      receive(snapshot);
      toast.hidden = true;
      await openDetail(id, false, false, true, true);
    } catch (error) {
      query(toast, 'span').textContent =
        error instanceof Error ? error.message : String(error);
    }
  };
}
let relationProject: string | null = null,
  relationRequest: string | null = null,
  relating = false;
function relationDirection() {
  const type = $('relation-type').value;
  $('relation-direction').textContent = t(
    type === 'blocks'
      ? 'relationBlocksHelp'
      : type === 'parent-child'
        ? 'relationParentHelp'
        : 'relationOtherHelp',
  );
}
function newRelation(issueId = '') {
  relationProject = activeProjectId;
  relationRequest = crypto.randomUUID();
  $('relation-form').reset();
  $('relation-error').hidden = true;
  for (const id of ['relation-issue', 'relation-target'] as const) {
    $(id).replaceChildren(new Option(t('selectIssue'), ''));
    for (const item of data.issues) {
      const option = new Option(`${item.id} · ${item.title}`, item.id);
      option.dataset.issueType = item.issue_type;
      option.dataset.issueId = item.id;
      option.dataset.issueTitle = item.title;
      $(id).add(option);
    }
  }
  $('relation-issue').value = issueId;
  $('relation-notice').hidden = !!data.canRelate;
  $('relation-notice').textContent = t('readOnlyCreation');
  $('submit-relation').hidden = !data.canRelate;
  $('submit-relation').disabled = !data.canRelate;
  relationDirection();
  syncSelects();
  $('relation-dialog').showModal();
}
$('new-relation').onclick = () => newRelation();
document.addEventListener('click', (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-add-relation]')
      : null;
  if (button) newRelation(button.dataset.addRelation);
});
$('relation-type').onchange = relationDirection;
$('cancel-relation').onclick = () => {
  if (!relating) $('relation-dialog').close();
};
$('relation-dialog').addEventListener('cancel', (event) => {
  if (relating) event.preventDefault();
});
$('relation-form').onsubmit = async (event) => {
  event.preventDefault();
  if (
    relating ||
    !data.canRelate ||
    activeProjectId !== relationProject ||
    !$('relation-form').reportValidity()
  )
    return;
  const payload = {
    issue: $('relation-issue').value,
    target: $('relation-target').value,
    type: $('relation-type').value,
  };
  if (payload.issue === payload.target) {
    $('relation-error').textContent = t('selfRelation');
    $('relation-error').hidden = false;
    return;
  }
  relating = true;
  $('submit-relation').disabled = true;
  $('cancel-relation').disabled = true;
  try {
    const capabilities = await fetch('/api/capabilities');
    if (!capabilities.ok) throw Error(t('readError'));
    const { csrfToken }: Capabilities = await capabilities.json();
    const response = await fetch(
      `/api/projects/${encodeURIComponent(relationProject!)}/relations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Observer-Token': csrfToken,
          'X-Request-ID': relationRequest!,
        },
        body: JSON.stringify(payload),
      },
    );
    const result: MutationResult = await response.json();
    if (!response.ok) throw Error(result.error || t('readError'));
    $('relation-dialog').close();
    if (activeProjectId === relationProject) {
      const snapshot = await fetch(projectURL('snapshot'));
      if (snapshot.ok) receive(await snapshot.json());
    }
  } catch (error) {
    $('relation-error').textContent =
      error instanceof Error ? error.message : String(error);
    $('relation-error').hidden = false;
  } finally {
    relating = false;
    $('submit-relation').disabled = false;
    $('cancel-relation').disabled = false;
  }
};

async function editIssue(id: string) {
  const project = activeProjectId;
  try {
    const issue = await fetchIssue(id);
    if (activeProjectId !== project) return;
    const parentId =
      data.edges.find(
        (edge) => edge.type === 'parent-child' && edge.target === id,
      )?.source || '';
    newIssue(parentId, issue.issue_type);
    if (
      parentId &&
      ![...$('create-parent').options].some(
        (option) => option.value === parentId,
      )
    ) {
      $('create-parent').add(new Option(parentId, parentId));
      $('create-parent').value = parentId;
    }
    editingID = id;
    $('create-title').value = issue.title;
    $('create-description').value = issue.description || '';
    $('create-priority').value = String(issue.priority ?? 2);
    if (
      ![...$('create-type').options].some(
        (option) => option.value === issue.issue_type,
      )
    )
      $('create-type').add(
        new Option(valueLabel('type', issue.issue_type), issue.issue_type),
      );
    $('create-type').value = issue.issue_type;
    $('create-type').disabled = true;
    $('create-parent').disabled = true;
    $('create-heading').textContent = t('editIssue');
    $('submit-create').textContent = t('save');
    $('submit-create').hidden = !data.canEdit;
    $('submit-create').disabled = !data.canEdit;
    $('create-notice').hidden = !!data.canEdit;
    syncSelects();
  } catch (error) {
    $('error').hidden = false;
    $('error').textContent =
      error instanceof Error ? error.message : String(error);
  }
}
document.addEventListener('click', (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-edit-issue]')
      : null;
  if (button) editIssue(button.dataset.editIssue!);
});

function drawerWidth(width: number | string | null, persist = true) {
  const size = Math.max(
    320,
    Math.min(Number(width) || 620, Math.max(320, innerWidth - 32)),
  );
  document.documentElement.style.setProperty('--drawer-width', size + 'px');
  $('detail-resize').setAttribute('aria-valuenow', String(Math.round(size)));
  $('detail-resize').setAttribute('aria-label', t('resizePanel'));
  if (persist) storage.set('beads-drawer-width', String(Math.round(size)));
}
drawerWidth(storage.get('beads-drawer-width'), false);
$('detail-resize').onpointerdown = (event) => {
  event.preventDefault();
  const handle = $('detail-resize');
  handle.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => drawerWidth(innerWidth - e.clientX, false);
  const up = (e: PointerEvent) => {
    drawerWidth(innerWidth - e.clientX);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
};
$('detail-resize').onkeydown = (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  drawerWidth(
    Number($('detail-resize').getAttribute('aria-valuenow')) +
      (event.key === 'ArrowLeft' ? 40 : -40),
  );
};

function closeAgentPage(navigate = false) {
  if (!activeAgent) return;
  activeAgent = null;
  agentLoad++;
  agentLoading = false;
  $('agent-page').hidden = true;
  query(document, 'main').classList.remove('show-agent');
  if (navigate) {
    navigateTo();
  }
}
function renderAgentPage() {
  if (!activeAgent) return;
  const assigned = data.issues.filter((item) => item.assignee === activeAgent),
    created = data.issues.filter((item) => item.created_by === activeAgent);
  const rows = [
    ...new Map(agentRows.map((row) => [row.key, row])).values(),
  ].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  $('agent-page').innerHTML =
    `<div class="detail-top"><button id="agent-back">← ${t('back')}</button><span>${esc(data.project)}</span></div><div class="agent-body"><div class="agent-heading"><span class="agent-portrait">${agentPortrait(activeAgent)}</span><div><h1>${esc(activeAgent)}</h1><p class="muted">${t('agentProfile')}</p></div><button id="agent-refresh" ${agentLoading ? 'disabled' : ''}>${t('refresh')}</button></div><div class="agent-summary"><span>${t('assignedIssues')}: <strong>${assigned.length}</strong></span><span>${t('createdIssues')}: <strong>${created.length}</strong></span><span>${t('activity')}: <strong>${rows.length}</strong></span></div><h2>${t('assignedIssues')}</h2><div class="agent-assigned">${assigned.map((item) => `<div data-issue="${esc(item.id)}" tabindex="0">${issueLink(item)}<span>${esc(item.title)}</span>${statusBadge(item.status)}</div>`).join('') || `<p class="muted">${t('noIssues')}</p>`}</div><h2>${t('activity')}</h2><p class="muted">${t('agentHistoryScope')}</p><p class="muted">${agentLoading ? t('loading') : t('readComplete')} · ${agentDone}/${agentTotal}${agentFailures ? ' · ' + t('historyUnavailable') + ': ' + agentFailures : ''}</p><ol class="agent-history">${rows.map((row) => `<li><time>${esc(dateTime(row.at))}</time><div><span class="agent-event">${row.kind === 'comment' ? t('comments') : esc(valueLabel('event', row.eventType))}</span>${issueLink(data.issues.find((x) => x.id === row.issue) || { id: row.issue })} <button data-issue="${esc(row.issue)}">${esc(row.title)}</button>${row.kind === 'comment' ? `<p class="prose">${esc(row.text)}</p>` : ''}</div></li>`).join('') || `<li>${agentLoading ? skeleton('activity', 3) : t('noHistory')}</li>`}</ol></div>`;
  $('agent-back').onclick = () => history.back();
  $('agent-refresh').onclick = () => {
    detailRequests.clear();
    loadAgentHistory();
  };
}
async function loadAgentHistory() {
  const actor = activeAgent,
    project = activeProjectId,
    token = ++agentLoad,
    issues = [...data.issues].sort(
      (a, b) =>
        Number(b.assignee === actor || b.created_by === actor) -
        Number(a.assignee === actor || a.created_by === actor),
    );
  agentRows = [];
  agentDone = 0;
  agentFailures = 0;
  agentTotal = issues.length;
  agentLoading = true;
  renderAgentPage();
  let cursor = 0,
    lastRender = 0;
  const current = () =>
    token === agentLoad && project === activeProjectId && actor === activeAgent;
  async function worker() {
    while (current() && cursor < issues.length) {
      const item = issues[cursor++];
      try {
        const detail = await fetchIssue(item.id, false, true);
        if (!current()) return;
        agentRows.push(...personActivity(detail, actor));
        if (detail.statusEventsWarning) agentFailures++;
      } catch {
        if (!current()) return;
        agentFailures++;
      }
      agentDone++;
      if (Date.now() - lastRender >= 150) {
        lastRender = Date.now();
        renderAgentPage();
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, issues.length) }, worker));
  if (token === agentLoad) {
    agentLoading = false;
    renderAgentPage();
  }
}
function openAgentPage(actor: string, navigate = true) {
  if (!actor) return;
  closeEpic(false);
  closeIssuePage(false);
  activeAgent = actor;
  $('agent-page').hidden = false;
  query(document, 'main').classList.add('show-agent');
  if (navigate) {
    navigateTo('agents', actor);
  }
  loadAgentHistory();
}
document.addEventListener(
  'click',
  (event) => {
    const avatar =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-agent]')
        : null;
    if (!avatar?.dataset.agent) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openAgentPage(avatar.dataset.agent);
  },
  true,
);
document.addEventListener(
  'keydown',
  (event) => {
    const avatar =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-agent]')
        : null;
    if (!avatar?.dataset.agent || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openAgentPage(avatar.dataset.agent);
  },
  true,
);

document.addEventListener('keydown', (event) => {
  if (
    ['Enter', ' '].includes(event.key) &&
    event.target instanceof HTMLElement &&
    event.target.matches('[data-issue][tabindex]')
  ) {
    event.preventDefault();
    openDetail(event.target.dataset.issue!);
  }
});

document.addEventListener('click', (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-new-child]')
      : null;
  if (button) newIssue(button.dataset.newChild);
});

initResetUI({
  button: $('reset-project'),
  getProject: () => projectCatalog.find((p) => p.id === activeProjectId),
  url: (id, action) => '/api/projects/' + encodeURIComponent(id) + '/' + action,
  t,
  onReset: async () => {
    closeAgentPage(false);
    closeIssuePage(false);
    closeEpic(false);
    detailRequests.clear();
    navigateTo('board');
    receive(await (await fetch(projectURL('snapshot'))).json());
  },
});

function paintAgentPresence() {
  for (const avatar of document.querySelectorAll<HTMLElement>(
    '[data-issue-agent]',
  )) {
    const actor = avatar.dataset.agent,
      id = avatar.dataset.issueAgent;
    const sessions = liveAgentActivity[id!] || [];
    // Agent IDs are types (e.g. build), not necessarily Beads assignee names.
    // Expose task activity without pretending it belongs to the assigned person.
    let indicator = avatar.nextElementSibling?.classList.contains(
      'task-session-presence',
    )
      ? (avatar.nextElementSibling as HTMLElement)
      : null;
    if (sessions.length) {
      if (!indicator) {
        indicator = document.createElement('span');
        indicator.className = 'task-session-presence';
        avatar.after(indicator);
      }
      const label = '● ' + sessions.length;
      if (indicator.textContent !== label) indicator.textContent = label;
      indicator.title =
        t('activeTaskSessions') +
        ': ' +
        sessions.map((s) => s.agent || s.sessionID).join(', ');
      indicator.setAttribute('aria-label', indicator.title);
    } else indicator?.remove();
    avatar.classList.remove('agent-working');
    avatar.title = actor || t('unassigned');
    avatar.setAttribute('aria-label', avatar.title);
  }
}
async function refreshAgentPresence() {
  const project = activeProjectId;
  try {
    if (project && !document.hidden) {
      const response = await fetch(projectURL('sessions') + '?summary=1');
      if (!response.ok) throw Error();
      const result: SessionResult = await response.json();
      if (project !== activeProjectId) return;
      liveAgentActivity =
        result.available === true ? result.activity || {} : {};
    } else liveAgentActivity = {};
  } catch {
    if (project === activeProjectId) liveAgentActivity = {};
  } finally {
    paintAgentPresence();
    presenceTimer = setTimeout(refreshAgentPresence, 2500);
  }
}
void refreshAgentPresence();
const presenceObserver = new MutationObserver(() => paintAgentPresence());
presenceObserver.observe(query(document, '#observer-app'), {
  childList: true,
  subtree: true,
});
window.addEventListener('pagehide', () => {
  clearTimeout(presenceTimer);
  presenceObserver.disconnect();
});
