import { t } from './i18n.js';
const priorityKeys = ['critical', 'high', 'medium', 'low', 'backlog'];
const priorityPaths = [
  'M5 11 10 6 15 11 M5 16 10 11 15 16',
  'M5 13 10 8 15 13',
  'M5 8h10 M5 12h10',
  'M5 7 10 12 15 7',
  'M5 4 10 9 15 4 M5 9 10 14 15 9',
];
export function validPriority(value: unknown) {
  return (
    value !== null &&
    value !== undefined &&
    value !== '' &&
    Number.isInteger(Number(value)) &&
    Number(value) >= 0 &&
    Number(value) <= 4
  );
}
export function priorityLabel(value: unknown) {
  return validPriority(value)
    ? `P${Number(value)} · ${t(priorityKeys[Number(value)])}`
    : t('unknown');
}
export function priorityIcon(value: unknown) {
  if (!validPriority(value)) return '';
  return `<svg class="priority-icon priority-${Number(value)}" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="${priorityPaths[Number(value)]}" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
export function priorityMarkup(value: unknown) {
  if (!validPriority(value)) return '<span class="muted">—</span>';
  const label = priorityLabel(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c as '&' | '<' | '>' | '"' | "'"
      ],
  );
  return `<span class="priority-badge" title="${label}" aria-label="${label}">${priorityIcon(value)}<span>P${Number(value)}</span></span>`;
}
