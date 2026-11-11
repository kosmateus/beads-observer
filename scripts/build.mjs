import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
process.chdir(fileURLToPath(root));

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await check(path);
    else if (entry.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], {
        stdio: 'inherit',
      });
      if (result.status !== 0) throw new Error(`Invalid JavaScript: ${path}`);
    }
  }
}

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
for (const path of [
  pkg.exports['.'],
  pkg.bin['beads-observer'],
  'web/index.html',
  'web/style.css',
  'LICENSE',
]) {
  await access(path);
}
await check('src');
await check('web');
const entry = spawnSync(process.execPath, ['--check', 'index.js'], {
  stdio: 'inherit',
});
if (entry.status !== 0) throw new Error('Invalid plugin entry point');
console.log(
  `Validated ${pkg.name}@${pkg.version} (JavaScript sources; no compilation required).`,
);
