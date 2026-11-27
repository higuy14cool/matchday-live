import { api, getUser } from '../api.js';
import { esc, fmtDate } from '../util.js';
import { toast, confirmDialog, errorHTML } from '../ui.js';

/** Admin-only page: hand out viewer or admin accounts, remove them. */
export async function renderUsers(app) {
  let data;
  try {
    data = await api.users.list();
  } catch (err) {
    app.innerHTML = errorHTML(err.message, '#/');
    return null;
  }

  const me = getUser();
  const rows = data.users
    .slice()
    .sort((a, b) => (a.role === b.role ? a.username.localeCompare(b.username) : a.role === 'admin' ? -1 : 1))
    .map(user => `
      <tr>
        <td><b>${esc(user.username)}</b>${user.id === me.id ? ' <span class="tiny muted">(you)</span>' : ''}</td>
        <td><span class="role-pill ${user.role}">${esc(user.role)}</span></td>
        <td class="tiny muted">${esc(fmtDate(user.createdAt))}</td>
        <td style="text-align:right">
          ${user.id === me.id ? '' : `<button class="btn btn-sm btn-ghost" data-remove="${esc(user.id)}" data-name="${esc(user.username)}">Delete</button>`}
        </td>
      </tr>`)
    .join('');

  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Accounts</h1>
        <div class="page-sub">Admins run the tournaments. Viewers can watch everything but change nothing.</div>
      </div>
    </div>
    <div class="tour-layout">
      <section class="panel">
        <div class="panel-head"><span class="panel-title">Everyone who can sign in</span><span class="tiny muted">${data.users.length} account${data.users.length === 1 ? '' : 's'}</span></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Username</th><th>Role</th><th>Added</th><th></th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4" class="tiny muted">No accounts yet.</td></tr>'}</tbody>
          </table>
        </div>
      </section>
      <div>
        <section class="panel">
          <div class="panel-head"><span class="panel-title">New account</span></div>
          <div class="panel-body">
            <form class="stack" id="new-user">
              <label class="field"><span>Username</span><input name="username" autocomplete="off" required placeholder="e.g. grandma" /></label>
              <label class="field"><span>Password</span><input name="password" type="text" autocomplete="off" required minlength="6" placeholder="at least 6 characters" /></label>
              <label class="field"><span>Role</span>
                <select name="role">
                  <option value="viewer">Viewer — watch only</option>
                  <option value="admin">Admin — full control</option>
                </select>
              </label>
              <button class="btn btn-primary" type="submit">Create account</button>
              <p class="tiny muted">Give the person this username and password so they can sign in on their own device.</p>
            </form>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><span class="panel-title">Your password</span></div>
          <div class="panel-body">
            <form class="stack" id="change-password">
              <label class="field"><span>Current password</span><input name="current" type="password" autocomplete="current-password" required /></label>
              <label class="field"><span>New password</span><input name="password" type="password" autocomplete="new-password" required minlength="6" /></label>
              <button class="btn btn-ghost" type="submit">Update password</button>
            </form>
          </div>
        </section>
      </div>
    </div>`;

  const newForm = app.querySelector('#new-user');
  newForm.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = newForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(newForm).entries());
      const res = await api.users.create(body);
      toast(`${res.user.username} can sign in as ${res.user.role}`);
      await renderUsers(app);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });

  const pwForm = app.querySelector('#change-password');
  pwForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const { current, password } = Object.fromEntries(new FormData(pwForm).entries());
      await api.users.setPassword(current, password);
      toast('Password updated');
      pwForm.reset();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  app.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Delete account',
        message: `${btn.dataset.name} will no longer be able to sign in.`,
        confirmLabel: 'Delete account'
      });
      if (!ok) return;
      try {
        await api.users.remove(btn.dataset.remove);
        toast('Account deleted');
        await renderUsers(app);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  return null;
}
