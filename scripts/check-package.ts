import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

interface PackPreview {
  files: { path: string }[];
  unpackedSize: number;
}

const result = spawnSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  },
);
assert.equal(result.status, 0, result.stderr);
const [pack] = JSON.parse(result.stdout) as PackPreview[];
assert.ok(pack, 'npm pack returned no package');
const paths = new Set(pack.files.map((file) => file.path));
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  bin: Record<string, string>;
};
assert.equal(pkg.bin['beads-observer'], 'dist/src/cli.js');
assert.ok(
  readFileSync(pkg.bin['beads-observer'], 'utf8').startsWith(
    '#!/usr/bin/env node',
  ),
);
for (const required of [
  'dist/index.js',
  'dist/index.d.ts',
  'package.json',
  'README.md',
  'LICENSE',
  'dist/src/cli.js',
  'dist/src/application/observer.js',
  'dist/src/domain/model.js',
  'dist/web/index.html',
  'dist/web/style.css',
  'dist/web/app.js',
])
  assert.ok(paths.has(required), `Missing runtime file: ${required}`);
for (const path of paths) {
  assert.ok(
    /^(package\.json|README\.md|LICENSE|opencode\.example\.json|dist\/index\.(js|d\.ts)|dist\/src\/.*\.(js|d\.ts)|dist\/web\/.*\.(js|d\.ts|css|html|png|svg|ico|woff2?))$/.test(
      path,
    ),
    `Unexpected published file: ${path}`,
  );
  assert.ok(!path.includes('Zone.Identifier'), `Windows metadata: ${path}`);
}
console.log(
  `Package allowlist verified: ${paths.size} files, ${pack.unpackedSize} bytes unpacked.`,
);
