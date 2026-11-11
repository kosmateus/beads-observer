declare module '@semantic-release/commit-analyzer' {
  import type { AnalyzeCommitsContext, ReleaseType } from 'semantic-release';

  export interface ReleaseRule {
    release: ReleaseType | false;
    breaking?: boolean;
    revert?: boolean;
    [commitProperty: string]: unknown;
  }

  export interface AnalyzeCommitsConfig {
    preset?: string;
    config?: string;
    presetConfig?: Record<string, unknown>;
    parserOpts?: Record<string, unknown>;
    releaseRules?: string | readonly ReleaseRule[];
  }

  export function analyzeCommits(
    config: AnalyzeCommitsConfig,
    context: AnalyzeCommitsContext,
  ): Promise<ReleaseType | null>;
}
