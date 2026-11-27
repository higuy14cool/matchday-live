import { loadingHTML, errorHTML } from './ui.js';
import { renderHome } from './views/home.js';
import { renderTournament } from './views/tournament.js';
import { renderGame } from './views/game.js';
import { renderBoard } from './views/board.js';
import { openNewTournament } from './views/forms.js';

const app = document.getElementById('app');
const topnav = document.querySelector('.topnav');

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

async function route() {
  const myId = ++routeId;
  const seg = parts();
  const board = seg[0] === 'g' && seg[2] === 'board';
  markNav(seg);

  if (cleanup) {
    try { await cleanup(); } catch { /* a failed cleanup must not block navigation */ }
    cleanup = null;
  }
  document.body.classList.toggle('board-mode', board);
  app.innerHTML = loadingHTML(board ? 'Loading scoreboard' : undefined);

  try {
    let next = null;
    if (!seg.length) {
      next = await renderHome(app);
    } else if (seg[0] === 'live') {
      next = await renderHome(app, { liveOnly: true });
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
    app.innerHTML = errorHTML(err.message || 'Something went wrong loading this page.', location.hash || '#/');
  }
}

window.addEventListener('hashchange', route);
route();

const newBtn = topnav.querySelector('[data-action="new-tournament"]');
if (newBtn) newBtn.addEventListener('click', openNewTournament);

const yearEl = document.querySelector('[data-year]');
if (yearEl) yearEl.textContent = String(new Date().getFullYear());
