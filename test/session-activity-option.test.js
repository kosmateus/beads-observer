import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { catalogs } from '../web/catalogs.js';

test('OpenCode sessions follow status timing in the activity selector', async () => {
  const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(
    app,
    /\[['"]timing['"],\s*t\(['"]statusTiming['"]\)\],\s*\[['"]sessions['"],\s*t\(['"]openCodeSessions['"]\)\]/,
  );
  assert.match(
    app,
    /id="issue-pane-sessions" role="region"[^>]*tab !== ['"]sessions['"]/,
  );
  assert.match(
    app,
    /\[['"]comments['"],\s*['"]history['"],\s*['"]timing['"],\s*['"]sessions['"]\]/,
  );
  assert.match(
    app,
    /const logs\s*=\s*root\.querySelector\('#issue-pane-sessions'\)/,
  );
  assert.doesNotMatch(app, /root\.append\(logs\)/);
  assert.equal(catalogs.pl.openCodeSessions, 'Sesje OpenCode');
  assert.equal(catalogs.en.openCodeSessions, 'OpenCode sessions');
});
