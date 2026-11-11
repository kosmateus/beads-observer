import { analyzeCommits as conventional } from '@semantic-release/commit-analyzer';
import type { AnalyzeCommitsContext } from 'semantic-release';

const releaseRank = {
  patch: 1,
  minor: 2,
  major: 3,
};

export async function analyzeCommits(
  _config: unknown,
  context: AnalyzeCommitsContext,
) {
  const requested = process.env.RELEASE_TYPE || 'auto';

  if (
    requested !== 'auto' &&
    requested !== 'patch' &&
    requested !== 'minor' &&
    requested !== 'major'
  ) {
    throw new Error(
      `Invalid RELEASE_TYPE "${requested}". Use auto, patch, minor or major.`,
    );
  }

  const detected = await conventional(
    { preset: 'conventionalcommits' },
    context,
  );

  if (requested === 'auto') {
    return detected ?? (context.commits.length > 0 ? 'patch' : null);
  }

  if (!detected) {
    return requested;
  }

  if (detected !== 'patch' && detected !== 'minor' && detected !== 'major') {
    return detected;
  }

  return releaseRank[requested] >= releaseRank[detected] ? requested : detected;
}
