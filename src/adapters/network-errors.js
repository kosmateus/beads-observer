/** Node fetch wraps socket errors in cause; Bun may put code on the error itself. */
export function isConnectionRefused(error) {
  const seen = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (value.code === 'ECONNREFUSED') return true;
    if (visit(value.cause)) return true;
    // An aggregate is a refusal only when every attempted address refused.
    return (
      Array.isArray(value.errors) &&
      value.errors.length > 0 &&
      value.errors.every(visit)
    );
  }
  return visit(error);
}
