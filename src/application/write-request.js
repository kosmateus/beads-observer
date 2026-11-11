/** Idempotent project-scoped mutation coordinator; adapters implement explicit write methods. */
export class WriteRequest {
  constructor(projects, { validate, method }) {
    this.validate = validate;
    this.method = method;
    this.projects = projects;
    this.requests = new Map();
  }
  async execute(projectId, requestId, input) {
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
      const issue = await project.writer[this.method](draft);
      await project.observer.refresh();
      return issue;
    })();
    this.requests.set(key, { fingerprint, result });
    return result;
  }
}
