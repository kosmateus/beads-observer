import { assertIssueSource } from '../ports/issue-source.js';
/** Application service. Injected source and clock; framework-independent. */
export class Observer {
  #source;
  #details = new Map();
  #generation = 0;
  #listeners = new Set();
  #pending;
  #fingerprint;
  #clock;
  constructor(
    source,
    {
      clock = () => new Date().toISOString(),
      project = 'Beads',
      demo = false,
    } = {},
  ) {
    this.#source = assertIssueSource(source);
    this.#clock = clock;
    this.state = {
      issues: [],
      edges: [],
      activity: [],
      revision: 0,
      project,
      demo,
      error: null,
      updatedAt: null,
    };
  }
  clear() {
    this.#generation++;
    this.#details.clear();
    this.#fingerprint = undefined;
    this.state = {
      ...this.state,
      issues: [],
      edges: [],
      activity: [],
      revision: this.state.revision + 1,
      updatedAt: this.#clock(),
      error:
        'Beads workspace reset. Run bd init in this project to initialize it again.',
    };
    this.#emit();
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit() {
    for (const fn of this.#listeners) {
      try {
        fn(this.state);
      } catch {
        /* One observer cannot break others. */
      }
    }
  }
  refresh() {
    if (this.#pending) return this.#pending;
    this.#pending = this.#refresh().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }
  async #refresh() {
    const generation = this.#generation;
    try {
      const snapshot = await this.#source.snapshot();
      if (generation !== this.#generation) return this.state;
      const fingerprint = JSON.stringify(snapshot);
      const wasError = !!this.state.error;
      const now = this.#clock();
      if (fingerprint !== this.#fingerprint) {
        const previous = new Map(this.state.issues.map((x) => [x.id, x]));
        const activity = [...this.state.activity];
        if (this.state.revision) {
          for (const issue of snapshot.issues) {
            const old = previous.get(issue.id);
            if (!old || JSON.stringify(old) !== JSON.stringify(issue)) {
              activity.unshift({
                id: issue.id,
                title: issue.title,
                actor: issue.assignee || 'Beads',
                at: now,
                text: !old
                  ? 'Nowe zadanie'
                  : old.status !== issue.status
                    ? `${old.status} → ${issue.status}`
                    : 'Aktualizacja zadania',
              });
            }
            previous.delete(issue.id);
          }
          for (const old of previous.values())
            activity.unshift({
              id: old.id,
              title: old.title,
              at: now,
              actor: 'Beads',
              text: 'Zadanie usunięte',
            });
        }
        this.state = {
          ...this.state,
          ...snapshot,
          activity: activity.slice(0, 100),
          revision: this.state.revision + 1,
          updatedAt: now,
          error: null,
        };
        this.#fingerprint = fingerprint;
        this.#emit();
      } else if (wasError) {
        this.state = { ...this.state, error: null, updatedAt: now };
        this.#emit();
      }
    } catch (error) {
      const message =
        error.code === 'ENOENT'
          ? 'Nie znaleziono bd. Zainstaluj Beads lub ustaw bdPath.'
          : String(error.message).slice(0, 1500);
      if (this.state.error !== message) {
        this.state = { ...this.state, error: message };
        this.#emit();
      }
    }
    return this.state;
  }
  async detail(id, activityOnly = false) {
    if (!this.state.issues.some((x) => x.id === id)) {
      const e = new Error('Nie znaleziono zadania');
      e.status = 404;
      throw e;
    }
    const key = JSON.stringify([this.state.revision, id, activityOnly]);
    const cached = this.#details.get(key);
    if (cached && Date.now() - cached.at < 5000) return cached.promise;
    const promise =
      activityOnly && this.#source.activity
        ? this.#source.activity(id).then((result) => ({
            ...result,
            title: this.state.issues.find((x) => x.id === id)?.title || id,
          }))
        : this.#source.detail(id);
    const entry = { at: Date.now(), promise };
    this.#details.set(key, entry);
    promise.catch(() => {
      if (this.#details.get(key) === entry) this.#details.delete(key);
    });
    if (this.#details.size > 250)
      this.#details.delete(this.#details.keys().next().value);
    return promise;
  }
}
