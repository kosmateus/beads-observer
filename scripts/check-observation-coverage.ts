import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
// A fixed pre-fix base keeps the gate meaningful after squash/merge to main.
const base = 'a27eef5cabc073ae71fd7a2e0bec07325bfb1818';
const files = [
  'src/adapters/opencode-api.ts',
  'src/adapters/opencode-sessions.ts',
];
const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8' }).trim();
if (spawnSync('git', ['cat-file', '-e', base + '^{commit}']).status !== 0)
  git('fetch', '--no-tags', '--depth=1', 'origin', base);

function run(args: string[]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await mkdir('coverage', { recursive: true });
run([
  'node_modules/typescript/bin/tsc',
  '-p',
  'tsconfig.json',
  '--outDir',
  'coverage/build',
  '--sourceMap',
  '--inlineSources',
]);
run([
  '--enable-source-maps',
  '--experimental-test-coverage',
  '--test-coverage-include=**/src/adapters/opencode-*.*',
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=' +
    resolve('coverage/build/scripts/observation-coverage-reporter.js'),
  '--test-reporter-destination=coverage/observation-node-coverage.json',
  '--test',
  'coverage/build/test/opencode-api.test.js',
  'coverage/build/test/opencode-session-load.test.js',
  'coverage/build/test/opencode-sessions.test.js',
]);

interface Counter {
  line: number;
  count: number;
}
const raw = JSON.parse(
  await readFile('coverage/observation-node-coverage.json', 'utf8'),
) as {
  summary: { files: { path: string; lines: Counter[]; branches: Counter[] }[] };
};
const results = [];
for (const file of files) {
  const counters = raw.summary.files.find(
    (entry) => entry.path === resolve(file),
  );
  if (!counters) throw Error('Missing source-mapped coverage for ' + file);
  const diff = git('diff', '--unified=0', base, '--', file);
  const changed = new Set<number>();
  for (const match of diff.matchAll(/^@@ .*\+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]),
      count = match[2] === undefined ? 1 : Number(match[2]);
    for (let index = 0; index < count; index++) changed.add(start + index);
  }
  const lines = counters.lines.filter((entry) => changed.has(entry.line));
  const branches = counters.branches.filter((entry) => changed.has(entry.line));
  if (!lines.length || !branches.length)
    throw Error('Empty coverage scope for ' + file);
  results.push({
    file,
    sha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
    changedSourceLines: [...changed],
    lines,
    branches,
    coveredLines: lines.filter((entry) => entry.count > 0).length,
    totalLines: lines.length,
    coveredBranches: branches.filter((entry) => entry.count > 0).length,
    totalBranches: branches.length,
  });
}
const report = {
  head: git('rev-parse', 'HEAD'),
  base,
  dirty: Boolean(
    git(
      'status',
      '--porcelain',
      '--',
      ...files,
      'test',
      'scripts',
      'package.json',
    ),
  ),
  node: process.version,
  generatedAt: new Date().toISOString(),
  scope:
    'Source-mapped executable lines and branch counters located on changed runtime source lines; type-only and unmapped lines are not executable.',
  results,
};
await writeFile(
  'coverage/observation-coverage.json',
  JSON.stringify(report, null, 2) + '\n',
);
const rows = results.map(
  (entry) =>
    `| ${entry.file} | ${entry.coveredLines}/${entry.totalLines} | ${entry.coveredBranches}/${entry.totalBranches} |`,
);
const markdown = [
  '# Session observation fix coverage',
  '',
  `Head: \`${report.head}\`; dirty runtime/test/tooling files: **${report.dirty}**.`,
  `Baseline: \`${base}\`; Node: \`${process.version}\`.`,
  '',
  report.scope,
  '',
  '| Runtime source | Covered changed lines | Covered changed branches |',
  '| --- | ---: | ---: |',
  ...rows,
  '',
  'Raw source-mapped Node counters: `coverage/observation-node-coverage.json`.',
  'Exact source hashes and selected counters: `coverage/observation-coverage.json`.',
  '',
].join('\n');
await writeFile('coverage/observation-coverage.md', markdown);
console.log(markdown);
if (
  results.some(
    (entry) =>
      entry.coveredLines !== entry.totalLines ||
      entry.coveredBranches !== entry.totalBranches,
  )
)
  throw Error(
    'Observation fix requires 100% changed-line and changed-branch coverage',
  );
