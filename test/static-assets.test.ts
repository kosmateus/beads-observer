import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { startServer } from '../src/bootstrap/server.js';

test('HTTP serves HTML assets and every local import in compiled frontend modules', async () => {
  const web = new URL('../web/', import.meta.url);
  const html = await readFile(new URL('index.html', web), 'utf8');
  const paths = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)=["'](\/[^"']+)["']/g))
    paths.add(match[1]);

  // Inspect emitted JavaScript, not TypeScript: type-only imports must not be
  // mistaken for runtime dependencies, and every module's imports are checked.
  for (const file of (await readdir(web)).filter((name) =>
    name.endsWith('.js'),
  )) {
    const code = await readFile(new URL(file, web), 'utf8');
    const imports =
      /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]/g;
    for (const match of code.matchAll(imports)) {
      const dependency = new URL(
        match[1] ?? match[2],
        `http://localhost/${file}`,
      );
      paths.add(dependency.pathname);
    }
  }
  assert(paths.has('/app.js'));
  assert(paths.has('/style.css'));
  assert(
    paths.has('/dom.js'),
    'the DOM helper must be covered by the import scan',
  );

  const app = await startServer({ port: 0, empty: true });
  try {
    for (const path of [...paths].sort()) {
      const response = await fetch(app.url + path);
      assert.equal(response.status, 200, `${path}: missing runtime asset`);
      assert.match(
        response.headers.get('content-type') || '',
        path.endsWith('.css') ? /^text\/css/ : /^text\/javascript/,
        `${path}: incorrect asset content type`,
      );
      assert.equal(
        await response.text(),
        await readFile(new URL(path.slice(1), web), 'utf8'),
        `${path}: HTTP must return the compiled runtime asset`,
      );
    }
    for (const path of ['/', '/projects/test/board']) {
      const response = await fetch(app.url + path);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), html);
    }
    for (const path of ['/missing.js', '/contracts.d.ts', '/src/types.ts'])
      assert.equal((await fetch(app.url + path)).status, 404, path);
  } finally {
    await app.close();
  }
});
