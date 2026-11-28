import { loadingHTML, errorHTML } from './ui.js';
import { api, setUser, getUser, canEdit, setUnauthorizedHandler } from './api.js';
import { esc } from './util.js';
import { renderHome } from './views/home.js';
import { renderTournament } from './views/tournament.js';
import { renderGame } from './views/game.js';
import { renderBoard } from './views/board.js';
import { renderLogin } from './views/login.js';
import { renderUsers } from './views/users.js';
import { openNewTournament } from './views/forms.js';

const app = document.getElementById('app');
const topnav = document.querySelector('.topnav');
const userArea = document.getElementById('user-area');

let cleanup = null;
let routeId = 0;

function parts() {
  return (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
}

function markNav(seg) {
  const path = seg.length ? `/${seg[0]}` : '/';
  topnav.querySelectorAll('a[data-nav]').forEach(a => {
    const href = a.getAttribute('href').replace(/^#/, '');
    a.classList.toggle('active', href === path);
  });
}

/** Header reflects who is signed in: viewers get no editing controls at all. */
function paintChrome() {
  const user = getUser();
  const newBtn = topnav.querySelector('[data-action="new-tournament"]');
  if (newBtn) newBtn.hidden = !canEdit();

  if (!user) {
    userArea.innerHTML = '';
    document.body.classList.add('signed-out');
    return;
  }
  document.body.classList.remove('signed-out');
  userArea.innerHTML = `
    ${canEdit() ? '<a class="nav-link" href="#/users" data-nav="users">Accounts</a>' : ''}
    <span class="user-chip" title="Signed in as ${esc(user.username)}">
      <span class="role-pill ${user.role}">${esc(user.role)}</span>
      <span class="user-name">${esc(user.username)}</span>
    </span>
    <button class="btn btn-sm btn-ghost" data-action="logout">Sign out</button>`;
}

async function beforeNavigate() {
  if (!cleanup) return;
  try { await cleanup(); } catch { /* a failed cleanup must not block navigation */ }
  cleanup = null;
}

async function showLogin(notice = '') {
  await beforeNavigate();
  routeId++; // any in-flight route is now stale
  document.body.classList.remove('board-mode');
  paintChrome();
  renderLogin(app, {
    notice,
    onDone: async () => {
      paintChrome();
      await route();
    }
  });
}

async function route() {
  const myId = ++routeId;
  const seg = parts();
  const board = seg[0] === 'g' && seg[2] === 'board';

  if (!getUser()) {
    await showLogin();
    return;
  }

  markNav(seg);
  await beforeNavigate();
  document.body.classList.toggle('board-mode', board);
  app.innerHTML = loadingHTML(board ? 'Loading scoreboard' : undefined);

  try {
    let next = null;
    if (!seg.length) {
      next = await renderHome(app);
    } else if (seg[0] === 'live') {
      next = await renderHome(app, { liveOnly: true });
    } else if (seg[0] === 'users') {
      if (!canEdit()) {
        app.innerHTML = errorHTML('Accounts are managed by the organizer.', '#/');
        return;
      }
      next = await renderUsers(app);
    } else if (seg[0] === 't' && seg[1]) {
      next = await renderTournament(app, decodeURIComponent(seg[1]));
    } else if (board && seg[1]) {
      next = await renderBoard(app, decodeURIComponent(seg[1]));
    } else if (seg[0] === 'g' && seg[1]) {
      next = await renderGame(app, decodeURIComponent(seg[1]));
    } else {
      app.innerHTML = errorHTML('That page does not exist.', '#/');
      return;
    }
    if (myId !== routeId) return; // a newer navigation already started
    cleanup = typeof next === 'function' ? next : null;
    if (!board) window.scrollTo({ top: 0 });
  } catch (err) {
    if (myId !== routeId) return;
    if (err.status === 401) return; // the 401 handler already showed the sign-in page
    app.innerHTML = errorHTML(err.message || 'Something went wrong loading this page.', location.hash || '#/');
  }
}

setUnauthorizedHandler(() => {
  showLogin('Your session ended. Please sign in again.');
});

window.addEventListener('hashchange', route);

topnav.addEventListener('click', async e => {
  const out = e.target.closest('[data-action="logout"]');
  if (!out) return;
  out.disabled = true;
  try { await api.logout(); } catch { /* signing out locally is enough */ }
  setUser(null);
  if (location.hash && location.hash !== '#/') location.hash = '#/';
  await showLogin('You are signed out.');
});

const newBtn = topnav.querySelector('[data-action="new-tournament"]');
if (newBtn) newBtn.addEventListener('click', () => { if (canEdit()) openNewTournament(); });

const yearEl = document.querySelector('[data-year]');
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

// ---------------------------------------------------------------- start up
(async function boot() {
  try {
    const me = await api.me();
    if (me) setUser(me.user);
  } catch { /* offline: fall through to the sign-in page */ }
  paintChrome();
  if (!getUser()) {
    await showLogin();
    return;
  }
  await route();
})();
