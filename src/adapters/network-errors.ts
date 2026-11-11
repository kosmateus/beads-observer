/** Node fetch wraps socket errors in cause; Bun may put code on the error itself. */
export function isConnectionRefused(error: unknown) {
  const seen = new Set<object>();
  function visit(value: unknown): boolean {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const error = value as {
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (error.code === 'ECONNREFUSED') return true;
    if (visit(error.cause)) return true;
    // An aggregate is a refusal only when every attempted address refused.
    return (
      Array.isArray(error.errors) &&
      error.errors.length > 0 &&
      error.errors.every(visit)
    );
  }
  return visit(error);
}
