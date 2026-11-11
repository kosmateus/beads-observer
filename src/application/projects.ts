/** Project registry input port. Each entry owns a separate Observer and subscriptions. */
import type { ProjectEntry } from '../types.js';
export class Projects {
  #entries = new Map<string, ProjectEntry & { off: () => void }>();
  #listeners = new Set<(list: ReturnType<Projects['list']>) => void>();
  list() {
    return [...this.#entries.values()]
      .map(({ id, name, cwd, observer, hostVersions }) => ({
        id,
        name,
        cwd,
        hostVersions: hostVersions || [],
        demo: observer.state.demo,
        error: observer.state.error,
        revision: observer.state.revision,
        issueCount: observer.state.issues.length,
        location: observer.state.location || null,
      }))
      .sort(
        (a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd),
      );
  }
  add(entry: ProjectEntry) {
    if (this.#entries.has(entry.id))
      throw new Error('Project already registered');
    const off = entry.observer.subscribe(() => this.#emit());
    this.#entries.set(entry.id, { ...entry, off });
    this.#emit();
  }
  setHostVersions(id: string, versions: string[]) {
    const entry = this.get(id);
    if (JSON.stringify(entry.hostVersions) !== JSON.stringify(versions)) {
      entry.hostVersions = versions;
      this.#emit();
    }
  }
  remove(id: string) {
    const entry = this.#entries.get(id);
    if (entry) {
      entry.off();
      this.#entries.delete(id);
      this.#emit();
    }
  }
  get(id?: string) {
    if (!id && this.#entries.size === 1)
      return this.#entries.values().next().value!;
    const entry = id === undefined ? undefined : this.#entries.get(id);
    if (!entry) {
      const error = Object.assign(
        new Error(id ? 'Unknown project' : 'Select a project'),
        { status: id ? 404 : 409 },
      );
      throw error;
    }
    return entry;
  }
  snapshot(id?: string) {
    const entry = this.get(id);
    return {
      ...entry.observer.state,
      projectId: entry.id,
      projectPath: entry.cwd,
      hostVersions: entry.hostVersions || [],
      canReset: typeof entry.writer?.reset === 'function',
      canCreate: !!entry.writer,
      canEdit: typeof entry.writer?.update === 'function',
      canRelate: typeof entry.writer?.addRelation === 'function',
    };
  }
  subscribe(listener: (list: ReturnType<Projects['list']>) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit() {
    for (const listener of this.#listeners) {
      try {
        listener(this.list());
      } catch {}
    }
  }
}
