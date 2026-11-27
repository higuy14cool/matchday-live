import { api } from '../api.js';
import { setOwnerKey } from '../api.js';
import { toast } from '../ui.js';
import { openNewTournament, openQuickGame } from './forms.js';
import { liveCard, tournamentCard } from '../components.js';
import { esc } from '../util.js';

function hero(tournaments, live, gameCount) {
  return `
    <section class="hero">
      <div class="hero-grid">
        <div>
          <span class="eyebrow">● Live scoreboards &amp; video</span>
          <h1>Run the tournament.<br><em>Stream every game.</em></h1>
          <p class="hero-sub">Create soccer and basketball tournaments, schedule the fixtures, run the clock and score live, and stream the game from your phone with a scoreboard on screen.</p>
          <div class="hero-actions">
            <button class="btn btn-primary btn-lg" data-act="new-tournament">+ New tournament</button>
            <button class="btn btn-ghost btn-lg" data-act="quick-game">+ Quick game</button>
            <a class="btn btn-ghost btn-lg" href="#/live">Live now ${live.length ? `<span class="pill pill-live">${live.length}</span>` : ''}</a>
          </div>
        </div>
        <div class="hero-stats">
          <div class="hero-stat"><span>Tournaments</span><b>${tournaments.length}</b></div>
          <div class="hero-stat"><span>Games</span><b>${gameCount}</b></div>
          <div class="hero-stat"><span>Live now</span><b style="color:${live.length ? 'var(--red)' : 'inherit'}">${live.length}</b></div>
        </div>
      </div>
    </section>`;
}

function liveSection(live) {
  if (!live.length) {
    return `
      <section class="section">
        <div class="section-head"><h2>Live now</h2></div>
        <div class="empty"><span class="big">📺</span><strong>No games are live right now</strong><span class="tiny">Open a game and press “Go live” to start a broadcast and scoreboard.</span></div>
      </section>`;
  }
  return `
    <section class="section">
      <div class="section-head">
        <h2>Live now <span class="count">${live.length}</span></h2>
        <a class="link tiny" href="#/live">See all →</a>
      </div>
      <div class="live-strip">${live.map(liveCard).join('')}</div>
    </section>`;
}

function quickCard(row) {
  const g = row.game;
  const status = g.status === 'live' ? '<span class="pill pill-live">Live</span>' : g.status === 'final' ? '<span class="pill">Final</span>' : '<span class="pill">Scheduled</span>';
  return `
    <a class="t-card" href="#/g/${encodeURIComponent(g.id)}">
      <div class="t-card-top">
        <div class="row" style="gap:10px;min-width:0">
          <span class="sport-chip">${g.sport === 'basketball' ? '🏀' : '⚽'}</span>
          <div style="min-width:0"><h3>${esc(row.home.name)} vs ${esc(row.away.name)}</h3>
          <div class="tiny muted">${esc(g.round || 'Quick game')}</div></div>
        </div>
        ${status}
      </div>
      <div class="t-meta"><span class="mono" style="font-size:18px;color:var(--text)">${g.score.home}–${g.score.away}</span>
      <span>${esc(new Date(g.scheduledAt).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span></div>
      <div class="t-card-foot"><span class="tiny muted">Open game</span><span class="link">View →</span></div>
    </a>`;
}

function quickSection(rows) {
  if (!rows.length) return '';
  return `
    <section class="section">
      <div class="section-head">
        <h2>Quick games <span class="count">${rows.length}</span></h2>
        <button class="btn btn-sm btn-ghost" data-act="quick-game">+ Quick game</button>
      </div>
      <div class="grid grid-3">${rows.map(quickCard).join('')}</div>
    </section>`;
}

function tournamentsSection(tournaments) {
  if (!tournaments.length) {
    return `
      <section class="section">
        <div class="section-head"><h2>Tournaments</h2></div>
        <div class="empty" style="padding:44px 18px">
          <span class="big">🏆</span>
          <strong>Start your first tournament</strong>
          <span class="tiny">Pick a sport, add teams, then generate the fixtures in one click.</span>
          <div class="row" style="margin-top:10px">
            <button class="btn btn-primary" data-act="new-tournament">Create tournament</button>
            <button class="btn btn-ghost" data-act="demo">Load demo data</button>
          </div>
        </div>
      </section>`;
  }
  return `
    <section class="section">
      <div class="section-head">
        <h2>Tournaments <span class="count">${tournaments.length}</span></h2>
        <button class="btn btn-sm btn-ghost" data-act="new-tournament">+ New tournament</button>
      </div>
      <div class="grid grid-3">${tournaments.map(tournamentCard).join('')}</div>
    </section>`;
}

async function loadDemo() {
  const res = await api.post('/demo');
  const created = res.created || [];
  for (const row of created) {
    if (row.ownerKey && row.tournament) setOwnerKey(row.tournament.id, row.ownerKey);
  }
  toast('Demo tournaments loaded — you own them on this device');
  const first = created.find(row => row.tournament && row.tournament.sport === 'soccer') || created[0];
  if (first && first.tournament) location.hash = `#/t/${first.tournament.id}`;
  else location.reload();
}

export async function renderHome(app, { liveOnly = false } = {}) {
  const [liveRes, tournamentRes, quickRes] = await Promise.all([api.get('/live'), api.get('/tournaments'), api.get('/quick-games')]);
  const live = liveRes.games || [];
  const tournaments = tournamentRes.tournaments || [];
  const quick = quickRes.games || [];
  const gameCount = tournaments.reduce((sum, t) => sum + (t.gameCount || 0), 0) + quick.length;

  if (liveOnly) {
    app.innerHTML = `
      <a class="backlink" href="#/">← All tournaments</a>
      <div class="page-head">
        <div>
          <h1>Live now</h1>
          <p class="page-sub">${live.length ? `${live.length} game${live.length === 1 ? '' : 's'} in play` : 'Nothing is being played yet'}</p>
        </div>
        <button class="btn btn-sm btn-ghost" data-act="refresh">↻ Refresh</button>
      </div>
      ${live.length
        ? `<div class="grid grid-3">${live.map(liveCard).join('')}</div>`
        : `<div class="empty"><span class="big">🌙</span><strong>No live games</strong><span class="tiny">When a game kicks off it will show up here with its score and stream.</span><a class="btn btn-sm btn-ghost" href="#/">Browse tournaments</a></div>`}
    `;
  } else {
    app.innerHTML = hero(tournaments, live, gameCount) + liveSection(live) + quickSection(quick) + tournamentsSection(tournaments);
  }

  app.querySelectorAll('[data-act="new-tournament"]').forEach(btn => btn.addEventListener('click', openNewTournament));
  app.querySelectorAll('[data-act="quick-game"]').forEach(btn => btn.addEventListener('click', openQuickGame));
  app.querySelectorAll('[data-act="demo"]').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      await loadDemo();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Load demo data';
    }
  }));
  app.querySelectorAll('[data-act="refresh"]').forEach(btn => btn.addEventListener('click', () => {
    btn.disabled = true;
    renderHome(app, { liveOnly }).catch(err => {
      toast(err.message, 'error');
      btn.disabled = false;
    });
  }));
  return () => {};
}
