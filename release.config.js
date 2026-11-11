export default {
  branches: [process.env.RELEASE_BRANCH || 'main'],
  tagFormat: 'v${version}',
  plugins: [
    './scripts/release-policy.mjs',
    [
      '@semantic-release/release-notes-generator',
      { preset: 'conventionalcommits' },
    ],
    ['@semantic-release/exec', { prepareCmd: 'npm run build' }],
    [
      '@semantic-release/npm',
      { npmPublish: true, tarballDir: 'release-artifacts' },
    ],
    [
      '@semantic-release/github',
      {
        successComment: false,
        failComment: false,
        failTitle: false,
        releasedLabels: false,
        assets: [{ path: 'release-artifacts/*.tgz', label: 'npm package' }],
      },
    ],
  ],
};
