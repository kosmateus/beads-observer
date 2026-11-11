/** Callers specify the expected element type for selectors not inferred by lib.dom. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
export function query<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
): T {
  return root.querySelector<T>(selector)!;
}
