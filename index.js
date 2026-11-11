import { observeOpenCodeSessions } from './src/adapters/opencode-sessions.js';
import { canonicalProject } from './src/bootstrap/server.js';
import { BeadsSource } from './src/adapters/beads-cli.js';
import { openBrowser } from './src/adapters/browser.js';
import { projectCommand } from './src/application/open-project.js';
import { Plugin } from '@opencode/plugin';
import { acquireSharedHub } from './src/bootstrap/shared-hub.js';
export default Plugin.define({
  id: 'beads.observer',
  async setup(ctx) {
    const currentProject = await canonicalProject({
      cwd: ctx.options?.cwd || ctx.location.directory,
    });
    const hub = await acquireSharedHub({
      ...ctx.options,
      opencodeVersion: ctx.app.version,
      cwd: ctx.options?.cwd || ctx.location.directory,
    });
    let sessionBridge;
    try {
      const source = new BeadsSource({
        ...ctx.options,
        cwd: ctx.options?.cwd || ctx.location.directory,
      });
      if (
        ctx.session?.list &&
        ctx.session?.get &&
        ctx.session?.context &&
        ctx.event?.subscribe &&
        ctx.storage
      )
        sessionBridge = await observeOpenCodeSessions(ctx, {
          directory: hub.directory,
          projectId: currentProject.id,
          cwd: currentProject.cwd,
          listIssues: () => source.issueCatalog(),
          beadsLocation: () => source.location(),
        });
      else
        console.warn(
          '[beads.observer] Session discovery unavailable: incomplete OpenCode context',
        );
      await ctx.command.transform((editor) =>
        editor.add(
          projectCommand({
            location: () => source.location(),
            url: hub.url,
            projectId: currentProject.id,
            open: openBrowser,
            bind: sessionBridge
              ? async (sessionID, issueId) => {
                  await source.detail(issueId);
                  await sessionBridge.bind(sessionID, issueId);
                }
              : undefined,
          }),
        ),
      );
    } catch (error) {
      await sessionBridge?.close();
      await hub.close();
      throw error;
    }
    console.info(`[beads.observer] ${hub.url}`);
    return async () => {
      await sessionBridge?.close();
      await hub.close();
    };
  },
});
