import { catalogs } from './catalogs.js';

// Flags are visual language shortcuts, not an assertion about EU membership.
export const languages = [
  ['bg', '🇧🇬', 'Български'],
  ['cs', '🇨🇿', 'Čeština'],
  ['da', '🇩🇰', 'Dansk'],
  ['de', '🇩🇪', 'Deutsch'],
  ['el', '🇬🇷', 'Ελληνικά'],
  ['en', '🇬🇧', 'English'],
  ['es', '🇪🇸', 'Español'],
  ['et', '🇪🇪', 'Eesti'],
  ['fi', '🇫🇮', 'Suomi'],
  ['fr', '🇫🇷', 'Français'],
  ['ga', '🇮🇪', 'Gaeilge'],
  ['hr', '🇭🇷', 'Hrvatski'],
  ['hu', '🇭🇺', 'Magyar'],
  ['it', '🇮🇹', 'Italiano'],
  ['lt', '🇱🇹', 'Lietuvių'],
  ['lv', '🇱🇻', 'Latviešu'],
  ['mt', '🇲🇹', 'Malti'],
  ['nl', '🇳🇱', 'Nederlands'],
  ['pl', '🇵🇱', 'Polski'],
  ['pt', '🇵🇹', 'Português'],
  ['ro', '🇷🇴', 'Română'],
  ['sk', '🇸🇰', 'Slovenčina'],
  ['sl', '🇸🇮', 'Slovenščina'],
  ['sv', '🇸🇪', 'Svenska'],
];
const supported = new Set(languages.map(([code]) => code));
let activeLocale = 'en';

/** Pure locale policy, independent of browser or storage adapters. */
export function resolveLocale(preference = 'system', systemLanguage = 'en') {
  const candidate = preference === 'system' ? systemLanguage : preference;
  if (typeof candidate !== 'string') return 'en';
  const base = candidate
    .trim()
    .replaceAll('_', '-')
    .toLowerCase()
    .split('-')[0];
  return supported.has(base) ? base : 'en';
}
export function locale() {
  return activeLocale;
}
export function t(key) {
  return catalogs[activeLocale]?.[key] ?? catalogs.en[key] ?? key;
}
export function dateTime(value, timeOnly = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(
    activeLocale,
    timeOnly
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { dateStyle: 'medium', timeStyle: 'short' },
  ).format(date);
}
export function translateStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = (node.dataset.i18nPrefix || '') + t(node.dataset.i18n);
  });
  for (const [attribute, dataKey] of [
    ['placeholder', 'i18nPlaceholder'],
    ['aria-label', 'i18nAria'],
  ]) {
    root
      .querySelectorAll(
        `[data-${dataKey.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}]`,
      )
      .forEach((node) => {
        node.setAttribute(attribute, t(node.dataset[dataKey]));
      });
  }
}
/** Browser adapter: selection, system changes, persistence and semantic document language. */
export function initLanguage(onChange) {
  const select = document.getElementById('language');
  let preference = 'system';
  try {
    const saved = localStorage.getItem('beads-language');
    if (saved === 'system' || supported.has(saved)) preference = saved;
  } catch {
    /* Storage can be disabled in private or embedded browsers. */
  }
  const apply = () => {
    activeLocale = resolveLocale(
      preference,
      navigator.language || navigator.languages?.[0] || 'en',
    );
    document.documentElement.lang = activeLocale;
    select.replaceChildren();
    const current = languages.find(([code]) => code === activeLocale);
    select.add(new Option(`🌐 ${t('system')}`, 'system'));
    for (const [code, flag, name] of languages)
      select.add(new Option(`${flag} ${name}`, code));
    select.value = preference;
    document.getElementById('resolved-language').textContent =
      `${current[1]} ${current[2]}`;
    translateStatic();
    onChange(activeLocale);
    window.dispatchEvent(
      new CustomEvent('beads:language', { detail: activeLocale }),
    );
  };
  select.addEventListener('change', () => {
    preference =
      select.value === 'system' || supported.has(select.value)
        ? select.value
        : 'system';
    try {
      localStorage.setItem('beads-language', preference);
    } catch {}
    apply();
  });
  window.addEventListener('languagechange', () => {
    if (preference === 'system') apply();
  });
  apply();
  return {
    get preference() {
      return preference;
    },
  };
}
