/** Idempotent project-scoped mutation coordinator; adapters implement explicit write methods. */
import type { Projects } from './projects.js';
import type { Draft, Update, Relation } from '../types.js';
type Inputs = { create: Draft; update: Update; addRelation: Relation };
export class WriteRequest<K extends keyof Inputs> {
  validate: (input: unknown) => Inputs[K];
  method: K;
  projects: Projects;
  requests: Map<string, { fingerprint: string; result: Promise<unknown> }>;
  constructor(
    projects: Projects,
    {
      validate,
      method,
    }: { validate: (input: unknown) => Inputs[K]; method: K },
  ) {
    this.validate = validate;
    this.method = method;
    this.projects = projects;
    this.requests = new Map();
  }
  async execute(projectId: string, requestId: unknown, input: unknown) {
    const draft = this.validate(input);
    if (
      typeof requestId !== 'string' ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)
    )
      throw Object.assign(new Error('Invalid request ID'), { status: 400 });
    const key = projectId + ':' + requestId,
      fingerprint = JSON.stringify(draft),
      previous = this.requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw Object.assign(
          new Error('Request ID reused with different data'),
          { status: 409 },
        );
      return previous.result;
    }
    const project = this.projects.get(projectId);
    if (typeof project.writer?.[this.method] !== 'function')
      throw Object.assign(new Error('Creating issues is unavailable'), {
        status: 403,
      });
    if (this.requests.size >= 1000)
      throw Object.assign(
        new Error('Creation request limit reached; restart the Observer'),
        { status: 429 },
      );
    const result = (async () => {
      const write = project.writer![this.method] as (
        input: Inputs[K],
      ) => Promise<unknown>;
      const issue = await write.call(project.writer, draft);
      await project.observer.refresh();
      return issue;
    })();
    this.requests.set(key, { fingerprint, result });
    return result;
  }
}
