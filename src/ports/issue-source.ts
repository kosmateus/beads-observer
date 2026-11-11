/**
 * Output port, implemented by BeadsCliSource and DemoSource.
 * No transport, runtime or framework types may cross this boundary.
 * @typedef {Object} IssueSource
 * @property {() => Promise<{issues: Object[], edges: Object[]}>} snapshot
 * @property {(id: string) => Promise<Object>} detail
 */
import type { IssueSource } from '../types.js';
export function assertIssueSource(source: IssueSource): IssueSource {
  if (
    !source ||
    typeof source.snapshot !== 'function' ||
    typeof source.detail !== 'function'
  )
    throw new TypeError('IssueSource must implement snapshot() and detail(id)');
  return source;
}
