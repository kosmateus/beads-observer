import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript';

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
  if (path.endsWith('.js') || path.endsWith('.d.ts')) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
    );
    const checkImport = (specifier: string): void => {
      if (specifier.startsWith('.')) {
        const dependency = posix.normalize(
          posix.join(posix.dirname(path), specifier),
        );
        assert.ok(
          paths.has(dependency),
          `${path} imports an unpackaged file: ${dependency}`,
        );
        if (path.endsWith('.d.ts') && dependency.endsWith('.js')) {
          assert.ok(
            paths.has(dependency.replace(/\.js$/, '.d.ts')),
            `${path} imports missing declarations: ${dependency}`,
          );
        }
      } else {
        assert.ok(
          specifier.startsWith('node:') || specifier === '@opencode/plugin',
          `${path} imports an unexpected runtime dependency: ${specifier}`,
        );
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        checkImport(node.moduleSpecifier.text);
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument))
          checkImport(argument.text);
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        checkImport(node.argument.literal.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
console.log(
  `Package allowlist verified: ${paths.size} files, ${pack.unpackedSize} bytes unpacked.`,
);
