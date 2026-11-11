import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { generateNotes } from '@semantic-release/release-notes-generator';

interface ReleaseContext {
  cwd: string;
  commits: { hash: string; message: string }[];
  options: { repositoryUrl: string };
  logger: { log: (...arguments_: unknown[]) => void };
  lastRelease: { version: string; gitTag: string; gitHead: string };
  nextRelease: { version: string; gitTag: string; gitHead: string };
}

// These plugins are JavaScript at runtime. Keep their untyped API confined to
// this boundary and describe only the fields exercised by the real plugins.
const policyModule: unknown = await import('../scripts/release-policy.js');
const { analyzeCommits } = policyModule as {
  analyzeCommits: (
    config: unknown,
    context: ReleaseContext,
  ) => Promise<string | null>;
};

test('release policy and configured changelog preset generate real release notes', async () => {
  const configuration: unknown = JSON.parse(
    await readFile('.releaserc.json', 'utf8'),
  );
  assert.ok(typeof configuration === 'object' && configuration !== null);
  assert.ok('plugins' in configuration && Array.isArray(configuration.plugins));
  const notesPlugin: unknown = configuration.plugins.find(
    (plugin: unknown) =>
      Array.isArray(plugin) &&
      plugin[0] === '@semantic-release/release-notes-generator',
  );
  assert.ok(Array.isArray(notesPlugin));
  const options: unknown = notesPlugin[1];
  assert.ok(typeof options === 'object' && options !== null);
  assert.ok('preset' in options && typeof options.preset === 'string');

  const originalType = process.env.RELEASE_TYPE;
  try {
    for (const [message, requested, expected] of [
      ['fix: restore changelog generation', 'auto', 'patch'],
      ['feat: add release preview', 'auto', 'minor'],
      ['feat!: change release interface', 'patch', 'major'],
      ['docs: document publishing', 'auto', 'patch'],
      ['fix: restore changelog generation', 'minor', 'minor'],
    ]) {
      process.env.RELEASE_TYPE = requested;
      const context: ReleaseContext = {
        cwd: process.cwd(),
        commits: [{ hash: 'b'.repeat(40), message }],
        options: {
          repositoryUrl: 'https://github.com/kosmateus/beads-observer.git',
        },
        logger: { log: () => {} },
        lastRelease: {
          version: '0.16.3',
          gitTag: 'v0.16.3',
          gitHead: 'a'.repeat(40),
        },
        nextRelease: {
          version: '0.16.4',
          gitTag: 'v0.16.4',
          gitHead: 'b'.repeat(40),
        },
      };
      assert.equal(await analyzeCommits({}, context), expected, message);
      const notes = await generateNotes({ preset: options.preset }, context);
      assert.match(notes, /0\.16\.4/);
      assert.match(notes, /compare\/v0\.16\.3\.\.\.v0\.16\.4/);
      if (message.startsWith('fix:')) {
        assert.match(notes, /restore changelog generation/);
        assert.match(notes, /commit\/b{40}/);
      }
      if (message.startsWith('feat:')) assert.match(notes, /release preview/);
    }
  } finally {
    if (originalType === undefined) delete process.env.RELEASE_TYPE;
    else process.env.RELEASE_TYPE = originalType;
  }
});
