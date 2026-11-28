import { api } from '../api.js';
import { esc, colorOf, clockState, periodLabel, pensLabel, eventLabel, OVERLAY_EVENTS } from '../util.js';
import { GameSocket } from '../live.js';

function boardHTML(data, game) {
  const { home, away, tournament } = data;
  const clock = clockState(game, Date.now());
  const live = game.status === 'live';
  return `
    <div class="board-screen">
      <div class="board-top">
        <span class="board-tour">${esc(tournament.name)}</span>
        <span class="board-state ${live ? 'live' : ''}">${live ? '● LIVE' : game.status === 'final' ? 'FULL TIME' : 'SCHEDULED'}</span>
      </div>

      <div class="board-main">
        <div class="board-team">
          <span class="board-crest" style="background:${colorOf(home)}">${esc(home.short || 'HOM')}</span>
          <span class="board-name">${esc(home.name)}</span>
          <span class="board-score" data-board-home>${game.score.home}</span>
        </div>

        <div class="board-center">
          <span class="board-clock${clock.running ? ' running' : ''}" data-board-clock>${esc(clock.text)}</span>
          <span class="board-period">${esc(periodLabel(game.sport, game.period))}</span>
          ${pensLabel(game) ? `<span class="board-pens" data-board-pens>${esc(pensLabel(game))}</span>` : ''}
          <span class="board-sport">${game.sport === 'basketball' ? '🏀 Basketball' : '⚽ Soccer'}</span>
        </div>

        <div class="board-team away">
          <span class="board-crest" style="background:${colorOf(away)}">${esc(away.short || 'AWY')}</span>
          <span class="board-name">${esc(away.name)}</span>
          <span class="board-score" data-board-away>${game.score.away}</span>
        </div>
      </div>

      <div class="board-events" id="board-events"></div>
      <div class="board-foot">
        <span class="board-meta">${game.venue ? esc(game.venue) + ' · ' : ''}${esc(game.round || '')}</span>
        <div class="board-actions">
          <a class="btn btn-sm btn-ghost" href="#/g/${encodeURIComponent(game.id)}">← Back to game</a>
          <button class="btn btn-sm btn-primary" data-act="fullscreen">⛶ Fullscreen</button>
        </div>
      </div>
    </div>`;
}

export async function renderBoard(app, id) {
  let data = await api.get(`/games/${encodeURIComponent(id)}`);
  let game = data.game;
  let syncedAt = Date.now();
  let alive = true;

  app.innerHTML = boardHTML(data, game);
  const homeEl = app.querySelector('[data-board-home]');
  const awayEl = app.querySelector('[data-board-away]');
  const clockEl = app.querySelector('[data-board-clock]');
  const stateEl = app.querySelector('.board-state');
  const periodEl = app.querySelector('.board-period');
  const pensEl = app.querySelector('[data-board-pens]');
  const eventsEl = app.querySelector('#board-events');

  function renderEvents() {
    const seen = (game.events || []).filter(ev => OVERLAY_EVENTS.has(ev.type)).slice(-3).reverse();
    eventsEl.innerHTML = seen.length && game.status !== 'scheduled'
      ? seen.map(ev => {
          const info = eventLabel(ev, data.home, data.away, game.sport);
          return `<div class="stage-ev"><span class="sev-icon">${info.icon}</span><span class="sev-text">${info.html}</span></div>`;
        }).join('')
      : '';
  }
  renderEvents();

  const socket = new GameSocket(game.id);
  socket.on('game', msg => {
    if (!msg.game || msg.game.id !== game.id) return;
    const prev = game.score;
    game = msg.game;
    syncedAt = Date.now();
    homeEl.textContent = String(game.score.home);
    awayEl.textContent = String(game.score.away);
    homeEl.classList.toggle('scored', game.score.home > prev.home);
    awayEl.classList.toggle('scored', game.score.away > prev.away);
    setTimeout(() => {
      homeEl.classList.remove('scored');
      awayEl.classList.remove('scored');
    }, 500);
    const live = game.status === 'live';
    stateEl.textContent = live ? '● LIVE' : game.status === 'final' ? 'FULL TIME' : 'SCHEDULED';
    stateEl.classList.toggle('live', live);
    if (periodEl) periodEl.textContent = periodLabel(game.sport, game.period);
    if (pensEl) {
      const text = pensLabel(game);
      pensEl.textContent = text;
      pensEl.hidden = !text;
    }
    renderEvents();
    tick();
  });
  socket.connect();

  function tick() {
    if (!alive) return;
    const clock = clockState(game, syncedAt);
    clockEl.textContent = clock.text;
    clockEl.classList.toggle('running', clock.running);
  }

  const timer = setInterval(tick, 250);

  const onFullscreen = () => {
    const el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  };
  const btn = app.querySelector('[data-act="fullscreen"]');
  if (btn) btn.addEventListener('click', onFullscreen);

  // Fullscreen needs a real click; the board is often opened from the game page,
  // so show a hint on touch devices instead of failing silently.
  if (btn && !document.documentElement.requestFullscreen) btn.hidden = true;

  return () => {
    alive = false;
    clearInterval(timer);
    socket.close();
    if (btn) btn.removeEventListener('click', onFullscreen);
  };
}
