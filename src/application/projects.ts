/** Project registry input port. Each entry owns a separate Observer and subscriptions. */
import type { ProjectEntry } from '../types.js';
import type {
  ProjectPreference,
  ProjectPreferencePatch,
} from '../adapters/project-preferences.js';
export class Projects {
  #entries = new Map<string, ProjectEntry & { off: () => void }>();
  #preferences: Map<string, ProjectPreference>;
  #persist?: (
    preferences: ReadonlyMap<string, ProjectPreference>,
  ) => Promise<void>;
  #listeners = new Set<(list: ReturnType<Projects['list']>) => void>();
  constructor(
    preferences = new Map<string, ProjectPreference>(),
    persist?: (
      preferences: ReadonlyMap<string, ProjectPreference>,
    ) => Promise<void>,
  ) {
    this.#preferences = new Map(preferences);
    this.#persist = persist;
  }
  list(includeHidden = false) {
    return [...this.#entries.values()]
      .map(({ id, name, cwd, observer, hostVersions }) => {
        const saved = this.#preferences.get(id),
          alias = saved?.alias || null;
        return {
          id,
          name: alias || name,
          defaultName: name,
          alias,
          hidden: saved?.hidden || false,
          cwd,
          hostVersions: hostVersions || [],
          demo: observer.state.demo,
          error: observer.state.error,
          revision: observer.state.revision,
          issueCount: observer.state.issues.length,
          location: observer.state.location || null,
        };
      })
      .filter((project) => includeHidden || !project.hidden)
      .sort(
        (a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd),
      );
  }
  findByCanonicalRoot(root: string) {
    return [...this.#entries.values()]
      .filter((entry) => entry.canonicalRoot === root)
      .map((entry) => entry.id);
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
  async setPreference(id: string, patch: ProjectPreferencePatch) {
    const entry = this.#entries.get(id);
    if (!entry) {
      throw Object.assign(new Error('Unknown project'), { status: 404 });
    }
    const current = this.#preferences.get(id) || {
        alias: null,
        hidden: false,
      },
      next = {
        alias: patch.alias === undefined ? current.alias : patch.alias,
        hidden: patch.hidden === undefined ? current.hidden : patch.hidden,
      },
      preferences = new Map(this.#preferences);
    if (next.alias || next.hidden) preferences.set(id, next);
    else preferences.delete(id);
    if (next.alias !== current.alias || next.hidden !== current.hidden) {
      await this.#persist?.(preferences);
      this.#preferences = preferences;
      this.#emit();
    }
    return this.list(true).find((project) => project.id === id)!;
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
      project:
        this.#preferences.get(entry.id)?.alias || entry.observer.state.project,
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
