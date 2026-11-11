import { randomUUID } from 'node:crypto';
/** Two-step, expiring confirmation bound to the concrete project and database. */
export class ResetProject {
  #tickets = new Map();
  constructor(projects) {
    this.projects = projects;
  }
  async prepare(projectId) {
    const entry = this.projects.get(projectId);
    if (!entry.writer?.resetPreview)
      throw Object.assign(Error('Reset unavailable'), { status: 403 });
    const preview = await entry.writer.resetPreview();
    const token = randomUUID();
    for (const [id, ticket] of this.#tickets)
      if (ticket.expires < Date.now()) this.#tickets.delete(id);
    this.#tickets.set(token, {
      projectId,
      path: preview.path,
      identity: preview.identity,
      mode: preview.mode,
      expires: Date.now() + 120000,
    });
    return { ...preview, token, project: entry.name, projectPath: entry.cwd };
  }
  async execute(projectId, input) {
    const ticket = this.#tickets.get(input?.token);
    if (
      input?.confirmation !== 'delete' ||
      !ticket ||
      ticket.projectId !== projectId ||
      ticket.expires < Date.now()
    )
      throw Object.assign(
        Error('Confirmation invalid or expired. Open the dialog again.'),
        { status: 400 },
      );
    const entry = this.projects.get(projectId);
    this.#tickets.delete(input.token);
    await entry.writer.reset(ticket.path, ticket.identity, ticket.mode);
    entry.observer.clear();
    return { reset: true };
  }
}
