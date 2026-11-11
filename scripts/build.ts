import { access, chmod, cp, mkdir, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
// Only the generated output directory is removed; source and local data stay intact.
await rm('dist', { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
  {
    stdio: 'inherit',
  },
);
if (result.status !== 0) process.exit(result.status ?? 1);

async function copyAssets(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await copyAssets(path);
    else if (!/\.(ts|js|map)$/.test(entry.name)) {
      await mkdir(`dist/${directory}`, { recursive: true });
      await cp(path, `dist/${path}`);
    }
  }
}

await copyAssets('web');
await chmod('dist/src/cli.js', 0o755);
for (const path of [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/src/cli.js',
  'dist/web/app.js',
  'dist/web/index.html',
  'dist/web/style.css',
]) {
  await access(path);
}
console.log(
  'TypeScript compiled successfully; runtime assets staged in dist/.',
);
