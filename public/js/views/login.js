import { api, setUser } from '../api.js';
import { esc } from '../util.js';

/** Full-page sign-in. Accounts are handed out by the organizer. */
export function renderLogin(app, { onDone, notice = '' } = {}) {
  app.innerHTML = `
    <div class="auth-wrap">
      <form class="auth-card card" id="login-form" novalidate>
        <div class="auth-brand">
          <span class="auth-mark" aria-hidden="true">⚽</span>
          <div>
            <h1>Matchday<span style="color:var(--lime)">Live</span></h1>
            <p class="tiny muted">Sign in to watch or run the tournament</p>
          </div>
        </div>
        <label class="field">
          <span>Username</span>
          <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required />
        </label>
        <label class="field">
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <p class="err hidden" id="login-error"></p>
        <button class="btn btn-primary auth-submit" type="submit">Sign in</button>
        <p class="tiny muted auth-note">${notice ? esc(notice) : 'Viewers can watch every tournament, scoreboard and live video. Only admins can create, score or delete anything. Ask the organizer for an account.'}</p>
      </form>
    </div>`;

  const form = app.querySelector('#login-form');
  const errorEl = app.querySelector('#login-error');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) {
      errorEl.textContent = 'Enter your username and password';
      errorEl.classList.remove('hidden');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';
    try {
      const res = await api.login(username, password);
      setUser(res.user);
      await onDone(res.user);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  });

  const first = form.querySelector('input[name="username"]');
  if (first) first.focus();
}
