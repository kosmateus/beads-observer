declare module '@semantic-release/release-notes-generator' {
  export function generateNotes(
    config: { preset: string },
    context: {
      cwd: string;
      commits: { hash: string; message: string }[];
      options: { repositoryUrl: string };
      logger: { log: (...arguments_: unknown[]) => void };
      lastRelease: { version: string; gitTag: string; gitHead: string };
      nextRelease: { version: string; gitTag: string; gitHead: string };
    },
  ): Promise<string>;
}
