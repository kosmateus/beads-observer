const html = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
export function terminalText(text) {
  const colors = {
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
  let color = null,
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
export function patchMarkup(patch) {
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
function blockMarkup(block, t) {
  const duration =
    block.time?.completed && block.time?.created
      ? ` · ${Math.max(0, (new Date(block.time.completed) - new Date(block.time.created)) / 1000).toFixed(1)}s`
      : '';
  if (block.kind === 'reasoning')
    return `<details class="session-thought" data-log-key="${html(block.id)}"><summary>✦ ${t('sessionThought')}${duration}</summary><pre>${html(block.text)}</pre></details>`;
  if (block.kind === 'tool') {
    const lines = (block.text || '').split('\n');
    return `<article class="session-tool"><header><span class="tool-name">${html(block.name)}</span><span class="session-state state-${html(block.status)}">${html(t('session_' + block.status))}</span><span>${duration}</span></header>${block.command ? `<pre class="session-command"><span>$</span> ${html(block.command)}</pre>` : ''}<details data-log-key="${html(block.id)}"><summary>${t('sessionOutput')} · ${lines.length} ${t('sessionLines')}</summary><pre>${terminalText(block.text)}</pre></details><pre class="session-tail">${terminalText(lines.slice(-6).join('\n'))}</pre>${block.error ? `<p class="session-error">${html(block.error)}</p>` : ''}</article>`;
  }
  return `<div class="session-message session-${html(block.kind)}"><small>${block.kind === 'user' ? t('sessionUser') : t('sessionAssistant')}</small><pre>${html(block.text)}</pre></div>`;
}
export function renderSessions(
  sessions,
  t,
  issueId,
  { available = false, warnings = [] } = {},
) {
  const notice =
    (!available ? `<p class="muted">${t('sessionReadUnavailable')}</p>` : '') +
    warnings.map((w) => `<p class="session-error">${html(w)}</p>`).join('');
  if (!sessions.length)
    return (
      notice +
      (available
        ? `<p class="muted">${t('sessionNotLinked')}</p><code>/beads-observer ${html(issueId)}</code>`
        : '')
    );
  return (
    notice +
    sessions
      .map(
        (session) =>
          `<article class="session-record"><header class="session-record-heading"><strong>${html(session.title)}</strong><span class="session-state state-${html(session.status)}">${html(t('session_' + session.status))}</span><span class="${session.connected ? 'session-online' : 'muted'}">${t(session.connected ? 'sessionConnected' : 'sessionDisconnected')}</span></header><p class="muted small">${html(session.sessionID)} · ${html(session.agent || '')} · ${t('sessionScope')}</p><p class="muted small">${t('sessionLinkSource')}: ${html(t('sessionLink_' + (session.linkSource || 'manual')))}${session.parentSessionID ? ' · ' + t('sessionParent') + ': ' + html(session.parentSessionID) : ''}</p>${session.limited ? `<p class="notice">${t('sessionLimited')}</p>` : ''}${(session.warnings || []).map((w) => `<p class="session-error">${html(w)}</p>`).join('')}<div class="session-transcript">${(session.blocks || []).map((b) => blockMarkup(b, t)).join('')}</div><h4>${t('sessionDiff')}</h4>${session.diffLimited ? `<p>${t('sessionLimited')}</p>` : ''}<div class="session-diffs">${(session.diffs || []).map((file) => `<details data-log-key="${html(session.sessionID + ':' + file.file)}"><summary><strong>${html(file.file)}</strong> <span class="ansi-green">+${Number(file.additions) || 0}</span> <span class="ansi-red">−${Number(file.deletions) || 0}</span></summary><div class="patch-view">${patchMarkup(file.patch)}</div>${file.truncated ? `<p>${t('sessionLimited')}</p>` : ''}</details>`).join('') || `<p class="muted">${t('sessionNoDiff')}</p>`}</div></article>`,
      )
      .join('')
  );
}
export function mountSessionPanel(root, { issueId, url, t, skeleton }) {
  if (!root) return;
  root.innerHTML = `<h3>${t('sessionLog')}</h3><div class="session-live-body">${skeleton('activity', 2)}</div>`;
  const body = root.querySelector('.session-live-body');
  let last = '',
    timer,
    closed = false;
  const controller = new AbortController();
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
      const result = await response.json();
      if (!response.ok) throw Error(result.error || t('readError'));
      if (!root.isConnected || closed) return;
      const signature = JSON.stringify(result);
      if (signature !== last) {
        const opened = new Set(
          [...body.querySelectorAll('details[open]')].map(
            (x) => x.dataset.logKey,
          ),
        );
        const scrolls = [...body.querySelectorAll('.session-transcript')].map(
          (x) => ({
            top: x.scrollTop,
            follow: x.scrollHeight - x.clientHeight - x.scrollTop < 40,
          }),
        );
        body.innerHTML = renderSessions(result.sessions, t, issueId, result);
        for (const item of body.querySelectorAll('details'))
          item.open = opened.has(item.dataset.logKey);
        [...body.querySelectorAll('.session-transcript')].forEach((x, i) => {
          x.scrollTop = scrolls[i]?.follow
            ? x.scrollHeight
            : scrolls[i]?.top || 0;
        });
        last = signature;
      }
    } catch (error) {
      if (!controller.signal.aborted && root.isConnected) {
        body.innerHTML = `<p class="session-error">${html(error.message)}</p>`;
        last = '';
      }
    }
    if (!closed) timer = setTimeout(refresh, 1500);
  }
  void refresh();
  return () => {
    closed = true;
    clearTimeout(timer);
    controller.abort();
  };
}
