import { esc } from './util.js';

export function toast(message, type = 'ok') {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast${type === 'error' ? ' error' : ''}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, 3600);
}

export function loadingHTML(label = 'Loading…') {
  return `<div class="empty" style="padding:60px 18px"><span class="big">◌</span><strong>${esc(label)}</strong></div>`;
}

export function errorHTML(message, retryHref = '') {
  return `<div class="card card-pad" style="max-width:560px;margin:40px auto;text-align:center">
    <div style="font-size:28px;margin-bottom:6px">⚠️</div>
    <h2 style="font-size:18px;margin-bottom:6px">That didn’t work</h2>
    <p class="muted" style="font-size:14px">${esc(message)}</p>
    <div style="margin-top:16px"><a class="btn btn-primary" href="${esc(retryHref || '#/')}">Back to tournaments</a></div>
  </div>`;
}

function mountModal(innerHTML) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${innerHTML}</div>`;
  root.appendChild(backdrop);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  const onKey = e => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', e => {
    if (e.target === backdrop) close();
  });
  const closeBtn = backdrop.querySelector('[data-close]');
  if (closeBtn) closeBtn.addEventListener('click', close);
  return { backdrop, close };
}

/**
 * Form modal. `onSubmit(data, ctx)` may throw an Error to show it inline.
 * Returning false keeps the modal open.
 */
export function showFormModal({ title, bodyHTML, submitLabel = 'Save', danger = false, onSubmit, hideSubmit = false }) {
  const { backdrop, close } = mountModal(`
    <form novalidate>
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body stack">
        ${bodyHTML}
        <p class="err hidden" data-error></p>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        ${hideSubmit ? '' : `<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(submitLabel)}</button>`}
      </div>
    </form>
  `);

  const form = backdrop.querySelector('form');
  const errorEl = backdrop.querySelector('[data-error]');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.label = submitBtn.textContent;
      submitBtn.textContent = 'Saving…';
    }
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      const result = await onSubmit(data, { close, form, setError });
      if (result !== false) close();
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = submitBtn.dataset.label || submitLabel;
      }
    }
  });

  function setError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }

  const firstInput = form.querySelector('input, select, textarea');
  if (firstInput) setTimeout(() => firstInput.focus(), 60);
  return { close, form };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = true }) {
  return new Promise(resolve => {
    let answered = false;
    const { backdrop, close } = mountModal(`
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body"><p class="muted" style="font-size:14px">${esc(message)}</p></div>
      <div class="modal-foot">
        <button type="button" class="btn btn-ghost" data-no>Cancel</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(confirmLabel)}</button>
      </div>
    `);
    const finish = value => {
      if (answered) return;
      answered = true;
      close();
      resolve(value);
    };
    backdrop.querySelector('[data-yes]').addEventListener('click', () => finish(true));
    backdrop.querySelectorAll('[data-no], [data-close]').forEach(b => b.addEventListener('click', () => finish(false)));
    backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) finish(false); });
  });
}

export async function copyText(text, message = 'Link copied') {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast(message);
    return true;
  } catch {
    toast('Could not copy — select the link manually', 'error');
    return false;
  }
}

export function shareGame() {
  copyText(location.href, 'Game link copied');
}
