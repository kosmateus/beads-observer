import type { Project, Translate, Capabilities } from './contracts.js';
import { query } from './dom.js';
interface ResetTicket {
  token: string;
  path: string;
  mode: string;
  preview: string;
  error?: string;
}
export function initResetUI({
  button,
  getProject,
  url,
  t,
  onReset,
}: {
  button: HTMLElement;
  getProject: () => Project | undefined;
  url: (id: string, action: string) => string;
  t: Translate;
  onReset: () => Promise<void>;
}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'reset-dialog';
  document.body.append(dialog);
  let busy = false,
    generation = 0;
  button.onclick = async () => {
    const current = ++generation;
    const project = getProject();
    if (!project?.id) return;
    let ticket: ResetTicket | null = null;
    dialog.innerHTML = `<form><h2></h2><p class="reset-scope"></p><strong class="reset-project"></strong><pre class="reset-path"></pre><p class="reset-preview"></p><label><span></span><input name="confirmation" autocomplete="off" spellcheck="false"></label><p class="reset-error" role="alert"></p><div class="reset-actions"><button type="button" class="cancel"></button><button type="submit" class="danger-button" disabled></button></div></form>`;
    query(dialog, 'h2').textContent = t('resetTitle');
    query(dialog, '.reset-scope').textContent = t('resetScope');
    query(dialog, '.reset-project').textContent = project.name;
    query(dialog, 'label span').textContent = t('resetType');
    query(dialog, '.cancel').textContent = t('cancel');
    query(dialog, '[type=submit]').textContent = t('resetConfirm');
    const input = query<HTMLInputElement>(dialog, 'input'),
      submit = query<HTMLButtonElement>(dialog, '[type=submit]'),
      error = query(dialog, '.reset-error');
    const post = async (
      action: string,
      payload: Record<string, string>,
    ): Promise<ResetTicket> => {
      const cap: Capabilities = await (await fetch('/api/capabilities')).json();
      const response = await fetch(url(project.id, action), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Observer-Token': cap.csrfToken,
        },
        body: JSON.stringify(payload),
      });
      const result: ResetTicket = await response.json();
      if (!response.ok) throw Error(result.error || t('readError'));
      return result;
    };
    query(dialog, '.cancel').onclick = () => {
      if (!busy) dialog.close();
    };
    dialog.oncancel = (e) => {
      if (busy) e.preventDefault();
    };
    const updateInput = () => {
      submit.disabled = busy || !ticket || input.value !== 'delete';
    };
    input.oninput = updateInput;
    query<HTMLFormElement>(dialog, 'form').onsubmit = async (e) => {
      e.preventDefault();
      if (busy || !ticket || input.value !== 'delete') return;
      if (getProject()?.id !== project.id) {
        error.textContent = t('resetChanged');
        return;
      }
      busy = true;
      submit.disabled = true;
      input.disabled = true;
      try {
        await post('reset', { token: ticket.token, confirmation: input.value });
        dialog.close();
        await onReset();
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
        ticket = null;
      } finally {
        busy = false;
        input.disabled = false;
      }
    };
    dialog.showModal();
    input.focus();
    try {
      const prepared = await post('reset-preview', {});
      if (current !== generation || !dialog.open) return;
      ticket = prepared;
      query(dialog, '.reset-path').textContent = ticket.path;
      query(dialog, '.reset-scope').textContent = t(
        ticket.mode === 'embedded' ? 'resetEmbeddedScope' : 'resetScope',
      );
      query(dialog, '.reset-preview').textContent = ticket.preview;
      updateInput();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    }
  };
}
