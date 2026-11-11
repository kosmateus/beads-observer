import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoSource } from '../src/adapters/demo.js';
import { startServer } from '../src/bootstrap/server.js';

test('project aliases and hidden state persist, restore, and never modify Beads data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'observer-project-prefs-')),
    cwd = join(root, 'fixture-project'),
    state = join(root, 'state');
  await mkdir(cwd);
  const source = new DemoSource();
  const start = () =>
    startServer({
      port: 0,
      cwd,
      project: 'Fixture project',
      demo: true,
      source,
      sessionDirectory: state,
      pollIntervalMs: 3600000,
    });
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await start();
    const project = (
      await fetch(app.url + '/api/projects').then((r) => r.json())
    )[0];
    assert.ok(project.id);
    const update = async (
      body: Record<string, unknown>,
      useWrongToken = false,
    ) => {
      const current = app!,
        capabilities = await fetch(current.url + '/api/capabilities').then(
          (r) => r.json(),
        );
      return fetch(`${current.url}/api/projects/${project.id}/preferences`, {
        method: 'POST',
        headers: {
          Origin: current.url,
          'Content-Type': 'application/json',
          'X-Observer-Token': useWrongToken
            ? 'wrong-token'
            : capabilities.csrfToken,
        },
        body: JSON.stringify(body),
      });
    };

    assert.equal((await update({ alias: 'Żółw 🦉' })).status, 200);
    assert.equal((await update({ hidden: true })).status, 200);
    assert.equal((await update({ hidden: 'yes' })).status, 400);
    assert.equal(
      (await update({ alias: '<img src=x onerror=alert(1)>' })).status,
      200,
    );
    assert.equal((await update({ unexpected: 'value' })).status, 400);
    assert.equal((await update({ hidden: false }, true)).status, 403);
    assert.equal(
      (await fetch(app.url + '/api/projects').then((r) => r.json())).length,
      0,
    );
    await app.close();
    app = undefined;

    app = await start();
    await app.register({
      cwd,
      project: 'Fixture project',
      demo: true,
      source: new DemoSource(),
      pollIntervalMs: 3600000,
    });
    const preferences = await fetch(app.url + '/api/projects/preferences').then(
      (r) => r.json(),
    );
    assert.equal(preferences[0].alias, '<img src=x onerror=alert(1)>');
    assert.equal(preferences[0].hidden, true);
    assert.equal((await update({ hidden: false })).status, 200);
    let visible = await fetch(app.url + '/api/projects').then((r) => r.json());
    assert.equal(visible[0].name, '<img src=x onerror=alert(1)>');
    assert.equal((await update({ alias: null })).status, 200);
    visible = await fetch(app.url + '/api/projects').then((r) => r.json());
    assert.equal(visible[0].name, 'Fixture project');

    const saved = await readFile(
      join(state, 'project-preferences.json'),
      'utf8',
    );
    assert.equal(saved.includes(cwd), false);
    assert.equal(saved.includes('Fixture project'), false);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
