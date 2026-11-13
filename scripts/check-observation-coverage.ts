import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const files = [
  'src/adapters/opencode-api.ts',
  'src/adapters/opencode-sessions.ts',
  'src/adapters/beads-cli.ts',
  'src/bootstrap/server.ts',
];
const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8' }).trim();

function run(args: string[]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await mkdir('coverage', { recursive: true });
await copyFile('package.json', 'coverage/package.json');
run([
  'node_modules/typescript/bin/tsc',
  '-p',
  'tsconfig.json',
  '--outDir',
  'coverage/build',
  '--sourceMap',
  '--inlineSources',
]);
const tests = [
  'opencode-api.test.js',
  'opencode-api-coverage.test.js',
  'opencode-session-load.test.js',
  'opencode-sessions.test.js',
  'opencode-session-boundaries.test.js',
  'opencode-session-cadence.test.js',
  'opencode-session-eviction.test.js',
  'opencode-session-rpc-budget.test.js',
  'beads-cli.test.js',
  'beads-cli-overhead.test.js',
  'canonical-project-cache.test.js',
  'server-bootstrap-coverage.test.js',
  'server-adaptive-poll.test.js',
  'project-registry.test.js',
  'project-preferences.test.js',
].map((name) => `coverage/build/test/${name}`);
run([
  '--enable-source-maps',
  '--experimental-test-coverage',
  '--experimental-test-module-mocks',
  '--test-coverage-include=**/src/adapters/opencode-*.*',
  '--test-coverage-include=**/src/adapters/beads-cli.*',
  '--test-coverage-include=**/src/bootstrap/server.*',
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=' +
    resolve('coverage/build/scripts/observation-coverage-reporter.js'),
  '--test-reporter-destination=coverage/observation-node-coverage.json',
  '--test',
  ...tests,
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
  const { lines, branches } = counters;
  if (!lines.length || !branches.length)
    throw Error('Empty coverage scope for ' + file);
  results.push({
    file,
    sha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
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
    'Full source-mapped line and branch coverage of the established session-observation adapters and every runtime file changed for the Beads/Git overhead fix. The unchanged hub daemon is not part of this gate. No coverage exclusions are used.',
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
  '# Beads Observer runtime coverage',
  '',
  `Head: \`${report.head}\`; dirty runtime/test/tooling files: **${report.dirty}**.`,
  `Node: \`${process.version}\`.`,
  '',
  report.scope,
  '',
  '| Runtime source | Covered lines | Covered branches |',
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
  throw Error('Overhead fix requires 100% full-file line and branch coverage');
