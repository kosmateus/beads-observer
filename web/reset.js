export function initResetUI({ button, getProject, url, t, onReset }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'reset-dialog';
  document.body.append(dialog);
  let busy = false,
    generation = 0;
  button.onclick = async () => {
    const current = ++generation;
    const project = getProject();
    if (!project?.id) return;
    let ticket;
    dialog.innerHTML = `<form><h2></h2><p class="reset-scope"></p><strong class="reset-project"></strong><pre class="reset-path"></pre><p class="reset-preview"></p><label><span></span><input name="confirmation" autocomplete="off" spellcheck="false"></label><p class="reset-error" role="alert"></p><div class="reset-actions"><button type="button" class="cancel"></button><button type="submit" class="danger-button" disabled></button></div></form>`;
    dialog.querySelector('h2').textContent = t('resetTitle');
    dialog.querySelector('.reset-scope').textContent = t('resetScope');
    dialog.querySelector('.reset-project').textContent = project.name;
    dialog.querySelector('label span').textContent = t('resetType');
    dialog.querySelector('.cancel').textContent = t('cancel');
    dialog.querySelector('[type=submit]').textContent = t('resetConfirm');
    const input = dialog.querySelector('input'),
      submit = dialog.querySelector('[type=submit]'),
      error = dialog.querySelector('.reset-error');
    const post = async (action, payload) => {
      const cap = await (await fetch('/api/capabilities')).json();
      const response = await fetch(url(project.id, action), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Observer-Token': cap.csrfToken,
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || t('readError'));
      return result;
    };
    dialog.querySelector('.cancel').onclick = () => {
      if (!busy) dialog.close();
    };
    dialog.oncancel = (e) => {
      if (busy) e.preventDefault();
    };
    input.oninput = () => {
      submit.disabled = busy || !ticket || input.value !== 'delete';
    };
    dialog.querySelector('form').onsubmit = async (e) => {
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
        error.textContent = e.message;
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
      dialog.querySelector('.reset-path').textContent = ticket.path;
      dialog.querySelector('.reset-scope').textContent = t(
        ticket.mode === 'embedded' ? 'resetEmbeddedScope' : 'resetScope',
      );
      dialog.querySelector('.reset-preview').textContent = ticket.preview;
      input.oninput();
    } catch (e) {
      error.textContent = e.message;
    }
  };
}
