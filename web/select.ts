import { t } from './i18n.js';
import { typeIcon, typeHue } from './types.js';
import { priorityIcon, priorityLabel, validPriority } from './priority.js';
import { flagImages } from './flags.js';
interface Control {
  select: HTMLSelectElement;
  button: HTMLButtonElement;
  signature: string;
}
/** Progressive enhancement: native selects retain values; one portal owns interaction. */
export function initSelects() {
  const controls = new Map<HTMLSelectElement, Control>();
  let active: Control | null = null,
    cursor = 0,
    prefix = '',
    lastKey = 0;
  const popup = document.createElement('div');
  popup.className = 'select-menu';
  popup.id = 'select-menu';
  popup.setAttribute('role', 'listbox');
  popup.hidden = true;
  document.body.append(popup);
  let query = '';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'select-search';
  const searchable = () =>
    active &&
    ['create-parent', 'relation-issue', 'relation-target'].includes(
      active.select.id,
    );
  const matches = (option: HTMLOptionElement) =>
    !query ||
    `${option.textContent} ${option.value} ${option.dataset.issueType || ''}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase());
  const signature = (select: HTMLSelectElement) =>
    JSON.stringify(
      Array.from(select.options, (option) => [
        option.value,
        option.textContent,
        option.disabled,
        option.selected,
        option.dataset.issueId,
        option.dataset.issueTitle,
        option.dataset.issueType,
      ]),
    );
  search.addEventListener('input', () => {
    if (!active) return;
    query = search.value;
    cursor = [...active.select.options].findIndex(
      (o) => !o.disabled && matches(o),
    );
    paint(true);
    search.focus();
  });
  search.addEventListener('keydown', (event) => {
    if (!active) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (cursor >= 0) choose(cursor);
      return;
    }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const indices = [...active.select.options]
        .map((o, i) => (!o.disabled && matches(o) ? i : -1))
        .filter((i) => i >= 0);
      if (indices.length) {
        cursor =
          indices[
            (indices.indexOf(cursor) +
              (event.key === 'ArrowDown' ? 1 : -1) +
              indices.length) %
              indices.length
          ];
        paint(true);
        search.focus();
      }
    }
  });
  function label(
    element: HTMLElement,
    text: string,
    select: HTMLSelectElement,
    value: string,
  ) {
    element.replaceChildren();
    const item = [...select.options].find((option) => option.value === value);
    if (item?.dataset.issueId) {
      const badge = document.createElement('span');
      badge.className = 'issue-id-badge';
      badge.style.setProperty(
        '--type-hue',
        String(typeHue(item.dataset.issueType)),
      );
      badge.innerHTML = typeIcon(item.dataset.issueType);
      badge.append(document.createTextNode(item.dataset.issueId));
      const title = document.createElement('span');
      title.className = 'select-label';
      title.textContent = item.dataset.issueTitle || '';
      element.append(badge, title);
      return;
    }
    if (
      (['create-type', 'graph-mode', 'list-mode'].includes(select.id) &&
        value !== 'all') ||
      (select.id === 'create-parent' && value)
    ) {
      const icon = document.createElement('span');
      icon.innerHTML = typeIcon(
        select.id === 'create-parent'
          ? [...select.options].find((o) => o.value === value)?.dataset
              .issueType
          : value,
      );
      element.append(icon);
    }
    if (
      ['priority', 'create-priority'].includes(select.id) &&
      validPriority(value)
    ) {
      const icon = document.createElement('span');
      icon.innerHTML = priorityIcon(value);
      element.append(icon);
      text = priorityLabel(value);
    }
    if (select.id === 'language' && value !== 'system') {
      const country =
        (
          {
            cs: 'cz',
            da: 'dk',
            el: 'gr',
            en: 'gb',
            et: 'ee',
            ga: 'ie',
            sl: 'si',
            sv: 'se',
          } as Record<string, string>
        )[value] || value;
      if (flagImages[country]) {
        const image = document.createElement('img');
        image.src = flagImages[country];
        image.alt = '';
        image.className = 'language-flag';
        element.append(image);
        text = text.replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, '');
      }
    }
    const span = document.createElement('span');
    span.className = 'select-label';
    span.textContent = text;
    element.append(span);
  }
  function close(focus = false) {
    const previous = active;
    active = null;
    popup.hidden = true;
    if (previous) {
      previous.button.setAttribute('aria-expanded', 'false');
      previous.button.removeAttribute('aria-activedescendant');
      if (focus) previous.button.focus();
    }
  }
  function position() {
    if (!active) return;
    const rect = active.button.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 24);
    popup.style.width = width + 'px';
    popup.style.left =
      Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
    const below = window.innerHeight - rect.bottom - 16,
      above = rect.top - 16;
    const up = below < 200 && above > below;
    popup.style.maxHeight =
      Math.max(100, Math.min(320, up ? above : below)) + 'px';
    popup.style.top = up ? 'auto' : rect.bottom + 6 + 'px';
    popup.style.bottom = up ? window.innerHeight - rect.top + 6 + 'px' : 'auto';
  }
  function paint(revealCursor = false) {
    if (!active) return;
    const previousScroll = popup.scrollTop,
      restoreSearch = document.activeElement === search,
      selection = restoreSearch
        ? [search.selectionStart, search.selectionEnd]
        : null;
    popup.replaceChildren();
    if (searchable()) {
      search.placeholder = t('search');
      search.setAttribute('aria-label', t('search'));
      popup.append(search);
    }
    popup.setAttribute(
      'aria-label',
      active.button.getAttribute('aria-label') || '',
    );
    const control = active;
    Array.from(active.select.options).forEach((option, i) => {
      if (searchable() && !matches(option)) return;
      const row = document.createElement('div');
      row.className = 'select-option';
      row.id = 'select-option-' + i;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.selected));
      row.setAttribute('aria-disabled', String(option.disabled));
      row.classList.toggle('focused', i === cursor);
      label(row, option.textContent || '', control.select, option.value);
      row.dataset.index = String(i);
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => choose(i));
      popup.append(row);
    });
    active.button.setAttribute(
      'aria-activedescendant',
      'select-option-' + cursor,
    );
    if (revealCursor)
      popup
        .querySelector(`#select-option-${cursor}`)
        ?.scrollIntoView?.({ block: 'nearest' });
    else popup.scrollTop = previousScroll;
    if (!popup.querySelector('.select-option')) {
      const empty = document.createElement('p');
      empty.className = 'select-empty';
      empty.textContent = t('noIssues');
      popup.append(empty);
    }
    position();
    if (restoreSearch) {
      search.focus();
      if (selection && selection[0] !== null && selection[1] !== null)
        search.setSelectionRange(selection[0], selection[1]);
    }
  }
  function choose(index: number) {
    if (
      !active ||
      !active.select.options[index] ||
      active.select.options[index].disabled
    )
      return;
    const select = active.select;
    select.selectedIndex = index;
    close(true);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
  }
  function open(control: Control) {
    close();
    active = control;
    query = '';
    search.value = '';
    (control.select.closest('dialog') || document.body).append(popup);
    popup.scrollTop = 0;
    cursor = Math.max(0, control.select.selectedIndex);
    prefix = '';
    popup.hidden = false;
    control.button.setAttribute('aria-expanded', 'true');
    paint(true);
    if (searchable()) search.focus();
  }
  function sync() {
    let activeOptionsChanged = false,
      activeCursorValue: string | undefined;
    for (const [select, control] of controls)
      if (!select.isConnected) {
        if (active === control) close();
        controls.delete(select);
      }
    document.querySelectorAll('select').forEach((select) => {
      let control = controls.get(select);
      if (!control) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'select-trigger';
        button.dataset.select = select.id;
        button.setAttribute('role', 'combobox');
        button.setAttribute('aria-haspopup', 'listbox');
        button.setAttribute('aria-controls', popup.id);
        button.setAttribute('aria-expanded', 'false');
        select.classList.add('native-select');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        select.after(button);
        control = { select, button, signature: signature(select) };
        controls.set(select, control);
        button.addEventListener('click', () =>
          active === control ? close() : open(control!),
        );
        button.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') {
            close();
            return;
          }
          if (e.key === 'Escape') {
            if (active) {
              e.preventDefault();
              close(true);
            }
            return;
          }
          if (
            ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(
              e.key,
            )
          ) {
            e.preventDefault();
            if (!active || active !== control) {
              open(control!);
              return;
            }
            if (e.key === 'Enter' || e.key === ' ') return choose(cursor);
            const options = Array.from(select.options);
            const enabled = options
              .map((o, i) => (o.disabled ? -1 : i))
              .filter((i) => i >= 0);
            const at = enabled.indexOf(cursor);
            cursor =
              e.key === 'Home'
                ? enabled[0]
                : e.key === 'End'
                  ? enabled.at(-1)!
                  : enabled[
                      (at + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) %
                        enabled.length
                    ];
            paint(true);
          } else if (
            e.key.length === 1 &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey
          ) {
            e.preventDefault();
            if (active !== control) open(control!);
            prefix = Date.now() - lastKey > 700 ? e.key : prefix + e.key;
            lastKey = Date.now();
            const i = Array.from(select.options).findIndex(
              (o) =>
                !o.disabled &&
                (o.textContent || '')
                  .trim()
                  .toLocaleLowerCase()
                  .startsWith(prefix.toLocaleLowerCase()),
            );
            if (i >= 0) {
              cursor = i;
              paint(true);
            }
          }
        });
        select.addEventListener('change', sync);
      }
      const nextSignature = signature(select);
      if (control.signature !== nextSignature) {
        if (active === control) {
          activeCursorValue = select.options[cursor]?.value;
          activeOptionsChanged = true;
        }
        control.signature = nextSignature;
      }
      label(
        control.button,
        select.selectedOptions[0]?.textContent || '—',
        select,
        select.value,
      );
      control.button.disabled = select.disabled;
      control.button.setAttribute(
        'aria-label',
        select.getAttribute('aria-label') ||
          select.labels?.[0]?.textContent?.trim() ||
          select.id,
      );
      control.button.title = control.button.textContent || '';
    });
    if (activeOptionsChanged && active) {
      const preservedCursor = activeCursorValue
        ? Array.from(active.select.options).findIndex(
            (option) => option.value === activeCursorValue,
          )
        : -1;
      cursor =
        preservedCursor >= 0
          ? preservedCursor
          : Math.min(
              Math.max(0, active.select.selectedIndex),
              Math.max(0, active.select.options.length - 1),
            );
      paint();
    }
  }
  document.addEventListener('pointerdown', (e) => {
    if (
      active &&
      !popup.contains(e.target instanceof Node ? e.target : null) &&
      !active.button.contains(e.target instanceof Node ? e.target : null)
    )
      close();
  });
  document.addEventListener('focusin', (e) => {
    if (
      active &&
      e.target !== active.button &&
      !popup.contains(e.target instanceof Node ? e.target : null)
    )
      close();
  });
  window.addEventListener('resize', position);
  document.addEventListener(
    'scroll',
    (e) => {
      if (e.target !== popup) position();
    },
    true,
  );
  new MutationObserver((records) => {
    if (
      records.some(
        (r) =>
          (r.target instanceof Element && r.target.closest('select')) ||
          Array.from(r.addedNodes).some(
            (n) =>
              n instanceof Element &&
              (n.matches('select') || n.querySelector('select')),
          ),
      )
    )
      sync();
  }).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-label'],
  });
  sync();
  return sync;
}
