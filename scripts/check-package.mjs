import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const result = spawnSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  },
);
assert.equal(result.status, 0, result.stderr);
const [pack] = JSON.parse(result.stdout);
const paths = new Set(pack.files.map((file) => file.path));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.bin['beads-observer'], 'src/cli.js');
assert.ok(
  readFileSync(pkg.bin['beads-observer'], 'utf8').startsWith(
    '#!/usr/bin/env node',
  ),
);
for (const required of [
  'index.js',
  'package.json',
  'README.md',
  'LICENSE',
  'src/cli.js',
  'src/application/observer.js',
  'src/domain/model.js',
  'web/index.html',
  'web/style.css',
  'web/app.js',
])
  assert.ok(paths.has(required), `Missing runtime file: ${required}`);
for (const path of paths) {
  assert.ok(
    /^(index\.js|package\.json|README\.md|LICENSE|opencode\.example\.json|src\/.*\.js|web\/.*\.(js|css|html|png|svg|ico|woff2?))$/.test(
      path,
    ),
    `Unexpected published file: ${path}`,
  );
  assert.ok(!path.includes('Zone.Identifier'), `Windows metadata: ${path}`);
}
console.log(
  `Package allowlist verified: ${paths.size} files, ${pack.unpackedSize} bytes unpacked.`,
);
