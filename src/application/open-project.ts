/** Command use case, independent of OpenCode and the operating system. */
export interface ProjectCommandOptions {
  location: () => Promise<unknown>;
  url: string;
  projectId: string;
  open: (url: string) => Promise<unknown>;
  bind?: (sessionID: string, issueId: string) => Promise<unknown>;
}
export function projectCommand({
  location,
  url,
  projectId,
  open,
  bind,
}: ProjectCommandOptions) {
  return {
    name: 'beads-observer',
    description: 'Open the Beads board for this project',
    async execute(
      input: { prompt?: { text?: string }; sessionID?: string } = {},
    ) {
      await location(); // Resolve Beads before opening; missing databases must never select another project.
      const issueId = input.prompt?.text?.trim();
      if (issueId) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(issueId))
          throw Error('Use /beads-observer <issue-id>');
        if (!bind || !input.sessionID)
          throw Error(
            'Session integration unavailable in this OpenCode version',
          );
        await bind(input.sessionID, issueId);
      }
      await open(
        `${url}/projects/${encodeURIComponent(projectId)}/${issueId ? 'issues/' + encodeURIComponent(issueId) : 'board'}`,
      );
    },
  };
}
