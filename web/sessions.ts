import type {
  Translate,
  Session,
  SessionBlock,
  SessionResult,
} from './contracts.js';
import { query } from './dom.js';
const html = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c as '&' | '<' | '>' | '"' | "'"
      ],
  );
export function terminalText(text: string) {
  const colors: Record<string, string> = {
    30: 'muted',
    31: 'red',
    32: 'green',
    33: 'amber',
    34: 'blue',
    35: 'purple',
    36: 'blue',
    37: 'text',
    90: 'muted',
    91: 'red',
    92: 'green',
    93: 'amber',
    94: 'blue',
    95: 'purple',
    96: 'blue',
    97: 'text',
  };
  let color: string | null = null,
    result = '',
    offset = 0;
  // ANSI escape sequences intentionally include the ESC control character.
  // eslint-disable-next-line no-control-regex
  const regex = /\x1b\[([0-9;]*)m/g;
  let match;
  while ((match = regex.exec(text || ''))) {
    const segment = html(text.slice(offset, match.index));
    result += color ? `<span class="ansi-${color}">${segment}</span>` : segment;
    for (const code of match[1].split(';')) {
      if (code === '0' || code === '39' || code === '') color = null;
      else if (colors[code]) color = colors[code];
    }
    offset = regex.lastIndex;
  }
  const tail = html((text || '').slice(offset));
  return result + (color ? `<span class="ansi-${color}">${tail}</span>` : tail);
}
export function patchMarkup(patch: string | undefined) {
  let before = 0,
    after = 0;
  return String(patch || '')
    .split('\n')
    .map((line) => {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (hunk) {
        before = Number(hunk[1]);
        after = Number(hunk[2]);
      }
      const header = hunk || /^(diff |index |--- |\+\+\+ )/.test(line),
        added = !header && line.startsWith('+'),
        removed = !header && line.startsWith('-');
      const old = header || added ? '' : before++,
        next = header || removed ? '' : after++;
      return `<div class="patch-line ${header ? 'patch-header' : added ? 'patch-add' : removed ? 'patch-remove' : ''}"><span>${old}</span><span>${next}</span><code>${html(line) || ' '}</code></div>`;
    })
    .join('');
}
type SessionAuthor =
  | 'human'
  | 'coordinator'
  | 'agent'
  | 'delegation'
  | 'system'
  | 'synthetic'
  | 'unknown';
type DisplayBlock = SessionBlock & { author?: SessionAuthor };
type SessionWithTime = Session & { time?: unknown };

interface SessionPanelState {
  active?: ReadonlyMap<string, boolean>;
  expanded?: ReadonlyMap<string, boolean>;
  following?: ReadonlyMap<string, boolean>;
  logOpen?: ReadonlyMap<string, boolean>;
}

function blockAuthor(block: DisplayBlock): SessionAuthor {
  const author = block.author;
  if (author) return author;
  if (block.kind === 'system') return 'system';
  if (block.kind === 'synthetic') return 'synthetic';
  return 'unknown';
}

function logKey(block: SessionBlock, index: number, sessionID: string) {
  const id =
    typeof block.id === 'string' && block.id
      ? block.id
      : `${block.kind}:${index}`;
  return sessionID ? `${sessionID}:${id}` : id;
}

function sessionTime(session: SessionWithTime): number | undefined {
  const time = session.time;
  if (!time || typeof time !== 'object' || !('created' in time))
    return undefined;
  const created = time.created;
  if (typeof created === 'number' && Number.isFinite(created)) return created;
  if (typeof created === 'string') {
    const parsed = Date.parse(created);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function activeStatus(status: string) {
  return ['running', 'streaming', 'active', 'busy'].includes(status);
}

function stableOrder(sessions: SessionWithTime[]) {
  return [...sessions].sort((a, b) => {
    const aTime = sessionTime(a);
    const bTime = sessionTime(b);
    return aTime !== undefined && bTime !== undefined && aTime !== bTime
      ? aTime - bTime
      : a.sessionID.localeCompare(b.sessionID);
  });
}

function followIcon(following: boolean) {
  const path = following
    ? '<path d="M10 2v12m-5-5 5 5 5-5M4 18h12" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>'
    : '<path d="M10 2v12m-5-5 5 5 5-5M4 18h12M3 3l14 14" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>';
  return `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">${path}</svg>`;
}

function blockMarkup(
  block: DisplayBlock,
  t: Translate,
  key: string,
  expanded: boolean,
) {
  const duration =
    block.time?.completed && block.time?.created
      ? ` · ${Math.max(0, (new Date(block.time.completed).getTime() - new Date(block.time.created).getTime()) / 1000).toFixed(1)}s`
      : '';
  if (block.kind === 'reasoning')
    return `<details class="session-thought" data-log-key="${html(key)}"${expanded ? ' open' : ''}><summary>✦ ${t('sessionThought')}${duration}</summary><pre>${html(block.text)}</pre></details>`;
  if (block.kind === 'tool') {
    const text = block.text || '';
    const lines = text ? text.split('\n') : [];
    const pending =
      !text && ['pending', 'receiving', 'running'].includes(block.status || '');
    const emptyLabel = t(
      pending ? 'sessionOutputPending' : 'sessionOutputEmpty',
    );
    const count = text ? `${lines.length} ${t('sessionLines')}` : emptyLabel;
    const output = text
      ? `<pre>${terminalText(text)}</pre>`
      : `<p class="muted">${emptyLabel}</p>`;
    return `<article class="session-tool"><header><span class="tool-name">${html(block.name)}</span><span class="session-state state-${html(block.status)}">${html(t('session_' + block.status))}</span><span>${duration}</span></header>${block.command ? `<pre class="session-command"><span>$</span> ${html(block.command)}</pre>` : ''}<details data-log-key="${html(key)}"${expanded ? ' open' : ''}><summary>${t('sessionOutput')} · ${count}</summary>${output}</details>${block.error ? `<p class="session-error">${html(block.error)}</p>` : ''}</article>`;
  }
  const author = blockAuthor(block);
  return `<div class="session-message session-${html(block.kind)}"><small>${t('sessionAuthor' + author[0].toUpperCase() + author.slice(1))}</small><pre>${html(block.text)}</pre></div>`;
}
function sessionMarkup(
  session: Session,
  t: Translate,
  state: SessionPanelState,
  globalWarnings: Set<string>,
  seenWarnings: Set<string>,
) {
  const active =
    state.active?.get(session.sessionID) ?? activeStatus(session.status);
  const expanded = state.expanded?.get(session.sessionID) ?? active;
  const following = state.following?.get(session.sessionID) ?? true;
  const followLabel = t(
    following ? 'sessionFollowEnabled' : 'sessionFollowDisabled',
  );
  const warnings = (session.warnings || []).filter((warning) => {
    if (globalWarnings.has(warning) || seenWarnings.has(warning)) return false;
    seenWarnings.add(warning);
    return true;
  });
  const blocks = (session.blocks || [])
    .map((block, index) => {
      const key = logKey(block, index, session.sessionID);
      const expanded = state.logOpen?.get(key) ?? false;
      return blockMarkup(block, t, key, expanded);
    })
    .join('');
  const diffs = (session.diffs || [])
    .map((file) => {
      const key = `${session.sessionID}:diff:${file.file}`;
      const open = state.logOpen?.get(key) ? ' open' : '';
      return `<details data-log-key="${html(key)}"${open}><summary><strong>${html(file.file)}</strong> <span class="ansi-green">+${Number(file.additions) || 0}</span> <span class="ansi-red">−${Number(file.deletions) || 0}</span></summary><div class="patch-view">${patchMarkup(file.patch)}</div>${file.truncated ? `<p>${t('sessionLimited')}</p>` : ''}</details>`;
    })
    .join('');
  return `<details class="session-record" data-session-key="${html(session.sessionID)}"${expanded ? ' open' : ''}><summary class="session-record-heading"><div><strong>${html(session.title)}</strong><span class="session-state state-${html(session.status)}">${html(t('session_' + session.status))}</span><span class="${session.connected ? 'session-online' : 'muted'}">${t(session.connected ? 'sessionConnected' : 'sessionDisconnected')}</span></div><p class="muted small">${html(session.sessionID)} · ${html(session.agent || '')} · ${t('sessionScope')}</p><p class="muted small">${t('sessionLinkSource')}: ${html(t('sessionLink_' + (session.linkSource || 'manual')))}${session.parentSessionID ? ' · ' + t('sessionParent') + ': ' + html(session.parentSessionID) : ''}</p></summary><div class="session-record-content">${session.limited ? `<p class="notice">${t('sessionLimited')}</p>` : ''}${warnings.map((warning) => `<p class="session-error">${html(warning)}</p>`).join('')}<button type="button" data-session-follow="${html(session.sessionID)}" aria-label="${html(followLabel)}" aria-pressed="${following}" title="${html(followLabel)}">${followIcon(following)}</button><div class="session-transcript" data-session-id="${html(session.sessionID)}">${blocks}</div><h4>${t('sessionDiff')}</h4>${session.diffLimited ? `<p>${t('sessionLimited')}</p>` : ''}<div class="session-diffs">${diffs || `<p class="muted">${t('sessionNoDiff')}</p>`}</div></div></details>`;
}

export function renderSessions(
  sessions: Session[],
  t: Translate,
  issueId: string,
  {
    available = false,
    warnings = [],
  }: Pick<SessionResult, 'available' | 'warnings'> = {},
  state: SessionPanelState = {},
) {
  const globalWarnings = new Set(warnings);
  const notice =
    (!available ? `<p class="muted">${t('sessionReadUnavailable')}</p>` : '') +
    [...new Set(warnings)]
      .map((warning) => `<p class="session-error">${html(warning)}</p>`)
      .join('');
  if (!sessions.length)
    return (
      notice +
      (available
        ? `<p class="muted">${t('sessionNotLinked')}</p><code>/beads-observer ${html(issueId)}</code>`
        : '')
    );

  const seenWarnings = new Set<string>();
  const active = stableOrder(
    sessions.filter(
      (session) =>
        state.active?.get(session.sessionID) ?? activeStatus(session.status),
    ),
  );
  const history = stableOrder(
    sessions.filter(
      (session) =>
        !(state.active?.get(session.sessionID) ?? activeStatus(session.status)),
    ),
  );
  const group = (name: 'active' | 'history', values: Session[]) =>
    values.length
      ? `<section class="session-group" data-session-group="${name}"><h4>${t(name === 'active' ? 'sessionActiveGroup' : 'sessionHistoryGroup')}</h4>${values.map((session) => sessionMarkup(session, t, state, globalWarnings, seenWarnings)).join('')}</section>`
      : '';
  return notice + group('active', active) + group('history', history);
}
const followStates = new Map<string, boolean>();
const sessionOpenStates = new Map<string, boolean>();
const logOpenStates = new Map<string, boolean>();
const scrollPositions = new Map<string, number>();
const activityStates = new Map<
  string,
  { active: boolean; inactivePolls: number }
>();
const SESSION_ACTIVITY_FRESHNESS_MS = 15000;

export function mountSessionPanel(
  element: HTMLElement | null,
  {
    issueId,
    url,
    t,
    skeleton,
  }: {
    issueId: string;
    url: string;
    t: Translate;
    skeleton: (kind: string, count: number) => string;
  },
) {
  if (!element) return;
  const root = element;
  root.innerHTML = `<h3>${t('sessionLog')}</h3><div class="session-live-body">${skeleton('activity', 2)}</div>`;
  const body = query(root, '.session-live-body');
  let last = '',
    lastActivity = '',
    lastSuccessAt = 0,
    lastResult: SessionResult | undefined,
    staleActivityRendered = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    closed = false;
  const controller = new AbortController();

  function stableActivity(sessions: Session[]) {
    const active = new Map<string, boolean>();
    for (const session of sessions) {
      const current = activeStatus(session.status);
      const previous = activityStates.get(session.sessionID);
      if (!previous) {
        activityStates.set(session.sessionID, {
          active: current,
          inactivePolls: 0,
        });
      } else if (current) {
        previous.active = true;
        previous.inactivePolls = 0;
      } else if (previous.active) {
        previous.inactivePolls++;
        if (previous.inactivePolls >= 2) previous.active = false;
      }
      active.set(
        session.sessionID,
        activityStates.get(session.sessionID)!.active,
      );
    }
    return active;
  }

  function saveScrollPositions() {
    for (const transcript of body.querySelectorAll<HTMLElement>(
      '.session-transcript[data-session-id]',
    )) {
      const id = transcript.dataset.sessionId;
      if (id) scrollPositions.set(id, transcript.scrollTop);
    }
  }

  function restoreScrollPositions() {
    for (const transcript of body.querySelectorAll<HTMLElement>(
      '.session-transcript[data-session-id]',
    )) {
      const id = transcript.dataset.sessionId;
      if (!id) continue;
      const following = followStates.get(id) ?? true;
      transcript.scrollTop = following
        ? transcript.scrollHeight
        : scrollPositions.get(id) || 0;
      scrollPositions.set(id, transcript.scrollTop);
    }
  }

  function setFollowButton(button: HTMLButtonElement, following: boolean) {
    const label = t(
      following ? 'sessionFollowEnabled' : 'sessionFollowDisabled',
    );
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(following));
    button.title = label;
    button.innerHTML = followIcon(following);
  }

  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>(
      'button[data-session-follow]',
    );
    if (button && root.contains(button)) {
      const id = button.dataset.sessionFollow;
      if (!id) return;
      const following = !(followStates.get(id) ?? true);
      followStates.set(id, following);
      setFollowButton(button, following);
      const transcript = [
        ...body.querySelectorAll<HTMLElement>(
          '.session-transcript[data-session-id]',
        ),
      ].find((item) => item.dataset.sessionId === id);
      if (transcript) {
        if (following) transcript.scrollTop = transcript.scrollHeight;
        scrollPositions.set(id, transcript.scrollTop);
      }
      event.preventDefault();
      return;
    }
    const summary = target.closest('summary');
    const details = summary?.parentElement;
    if (!(details instanceof HTMLDetailsElement) || !root.contains(details))
      return;
    const sessionID = details.dataset.sessionKey;
    const logID = details.dataset.logKey;
    if (!sessionID && !logID) return;
    window.setTimeout(() => {
      if (closed || !root.isConnected) return;
      if (sessionID) sessionOpenStates.set(sessionID, details.open);
      if (logID) logOpenStates.set(logID, details.open);
    }, 0);
  };

  const onScroll = (event: Event) => {
    const target = event.target;
    if (
      !(target instanceof HTMLElement) ||
      !target.matches('.session-transcript')
    )
      return;
    const id = target.dataset.sessionId;
    if (id) scrollPositions.set(id, target.scrollTop);
  };
  root.addEventListener('click', onClick);
  root.addEventListener('scroll', onScroll, true);

  function showReadError(error: unknown) {
    let notice = body.querySelector<HTMLElement>('[data-session-read-status]');
    if (!notice) {
      notice = document.createElement('p');
      notice.className = 'session-error';
      notice.dataset.sessionReadStatus = 'true';
      body.prepend(notice);
    }
    const message = error instanceof Error ? error.message : String(error);
    notice.textContent = `${t('sessionReadUnavailable')}: ${message}`;
  }

  async function refresh() {
    if (closed || !root.isConnected) {
      controller.abort();
      return;
    }
    if (document.hidden || root.closest('[hidden]')) {
      timer = setTimeout(refresh, 1500);
      return;
    }
    try {
      const response = await fetch(
        url + '?issue=' + encodeURIComponent(issueId),
        { signal: controller.signal },
      );
      const result: SessionResult = await response.json();
      if (!response.ok) throw Error(result.error || t('readError'));
      if (!root.isConnected || closed) return;
      lastSuccessAt = Date.now();
      lastResult = result;
      staleActivityRendered = false;
      const signature = JSON.stringify(result);
      const active = stableActivity(result.sessions);
      const activitySignature = JSON.stringify([...active]);
      if (signature !== last || activitySignature !== lastActivity) {
        saveScrollPositions();
        body.innerHTML = renderSessions(result.sessions, t, issueId, result, {
          active,
          expanded: sessionOpenStates,
          following: followStates,
          logOpen: logOpenStates,
        });
        restoreScrollPositions();
        last = signature;
        lastActivity = activitySignature;
      } else {
        body.querySelector('[data-session-read-status]')?.remove();
      }
    } catch (error) {
      if (!controller.signal.aborted && root.isConnected) {
        if (
          lastResult &&
          !staleActivityRendered &&
          Date.now() - lastSuccessAt >= SESSION_ACTIVITY_FRESHNESS_MS
        ) {
          saveScrollPositions();
          const staleSessions = lastResult.sessions.map((session) =>
            activeStatus(session.status)
              ? { ...session, status: 'unknown', connected: false }
              : session,
          );
          const active = new Map(
            staleSessions.map((session) => [session.sessionID, false]),
          );
          body.innerHTML = renderSessions(
            staleSessions,
            t,
            issueId,
            lastResult,
            {
              active,
              expanded: sessionOpenStates,
              following: followStates,
              logOpen: logOpenStates,
            },
          );
          restoreScrollPositions();
          last = '';
          lastActivity = JSON.stringify([...active]);
          staleActivityRendered = true;
        }
        showReadError(error);
      }
    }
    if (!closed) timer = setTimeout(refresh, 1500);
  }
  void refresh();
  return () => {
    closed = true;
    clearTimeout(timer);
    controller.abort();
    root.removeEventListener('click', onClick);
    root.removeEventListener('scroll', onScroll, true);
  };
}
