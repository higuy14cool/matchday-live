import { api, getOwnerKey, setOwnerKey, forgetOwnerKey } from '../api.js';
import { toast, confirmDialog, showFormModal, copyText } from '../ui.js';
import { esc, colorOf, SPORT_ICON, SPORT_LABEL, computeStandings, periodLabel } from '../util.js';
import { gameRow, statusPill, sportPill } from '../components.js';
import { openNewTeam, openNewGame, openFixtures } from './forms.js';

function teamMap(teams) {
  return new Map(teams.map(t => [t.id, t]));
}

function gamesPanel(data) {
  const byId = teamMap(data.teams);
  const live = data.games.filter(g => g.status === 'live');
  const scheduled = data.games.filter(g => g.status === 'scheduled');
  const final = data.games.filter(g => g.status === 'final').slice().reverse();
  if (!data.games.length) {
    return `<div class="empty" style="border:0"><span class="big">📅</span><strong>No games yet</strong><span class="tiny">${getOwnerKey(data.tournament.id) ? 'Add a game or generate the full fixture list.' : 'The organizer has not scheduled any games yet.'}</span></div>`;
  }
  const rowsFor = list => list.map(g => gameRow(g, byId.get(g.homeTeamId), byId.get(g.awayTeamId))).join('');
  return `
    ${live.length ? `<div class="games-group">Live now</div>${rowsFor(live)}` : ''}
    ${scheduled.length ? `<div class="games-group">Upcoming</div>${rowsFor(scheduled)}` : ''}
    ${final.length ? `<div class="games-group">Results</div>${rowsFor(final)}` : ''}`;
}

function standingsPanel(data) {
  const rows = computeStandings(data.teams, data.games, data.tournament.sport);
  if (!rows.length) return '';
  const isBasket = data.tournament.sport === 'basketball';
  const head = isBasket
    ? '<th>Team</th><th>P</th><th>W</th><th>L</th><th>PF</th><th>PA</th><th>+/-</th>'
    : '<th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th>';
  const body = rows.map((row, i) => {
    const qualify = data.teams.length >= 4 && i < 2 && row.played > 0 ? ' class="qualify"' : '';
    const cells = isBasket
      ? `<td>${row.played}</td><td>${row.won}</td><td>${row.lost}</td><td>${row.gf}</td><td>${row.ga}</td><td>${row.gd > 0 ? '+' : ''}${row.gd}</td>`
      : `<td>${row.played}</td><td>${row.won}</td><td>${row.drawn}</td><td>${row.lost}</td><td>${row.gf}</td><td>${row.ga}</td><td>${row.gd > 0 ? '+' : ''}${row.gd}</td><td class="pts">${row.points}</td>`;
    return `<tr${qualify}>
      <td><div class="team-cell"><span class="swatch" style="background:${colorOf(row.team)}"></span>${esc(row.team.name)}</div></td>
      ${cells}
    </tr>`;
  }).join('');
  const noResults = !data.games.some(g => g.status === 'final');
  return `
    <section class="panel">
      <div class="panel-head">
        <span class="panel-title">Standings</span>
        <span class="tiny muted">${noResults ? 'Waiting for results' : isBasket ? 'Win / loss' : '3 points for a win'}</span>
      </div>
      ${noResults ? '<div class="panel-body tiny muted">The table fills in as games finish.</div>' : `
      <div class="table-wrap" style="border:0;border-radius:0">
        <table class="standings"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      </div>`}
    </section>`;
}

function teamsPanel(data) {
  const owner = Boolean(getOwnerKey(data.tournament.id));
  const rows = data.teams.map(t => `
    <div class="team-item">
      <span class="swatch" style="background:${colorOf(t)}"></span>
      <span class="nm">${esc(t.name)}</span>
      <span class="badge-short">${esc(t.short || '')}</span>
      ${owner ? `<button class="icon-btn" data-act="delete-team" data-id="${esc(t.id)}" title="Remove team" aria-label="Remove ${esc(t.name)}">✕</button>` : ''}
    </div>`).join('');
  return `
    <section class="panel">
      <div class="panel-head">
        <span class="panel-title">Teams <span class="muted">${data.teams.length}</span></span>
        ${owner ? `<button class="btn btn-sm btn-ghost" data-act="add-team">+ Add</button>` : ''}
      </div>
      ${rows ? `<div class="team-list">${rows}</div>` : '<div class="panel-body tiny muted">No teams yet.</div>'}
    </section>`;
}

function view(data) {
  const { tournament } = data;
  const owner = Boolean(getOwnerKey(tournament.id));
  const liveCount = data.games.filter(g => g.status === 'live').length;
  const nextGame = data.games
    .filter(g => g.status === 'scheduled')
    .sort((a, b) => a.scheduledAt - b.scheduledAt)[0];

  return `
    <a class="backlink" href="#/">← All tournaments</a>
    <div class="page-head">
      <div>
        <h1>${SPORT_ICON[tournament.sport] || '🏆'} ${esc(tournament.name)}</h1>
        <div class="page-sub">
          ${sportPill(tournament.sport)}
          <span>${data.teams.length} teams · ${data.games.length} games</span>
          ${liveCount ? `<span class="pill pill-live">${liveCount} live</span>` : ''}
          ${owner ? '<span class="pill" style="color:var(--lime);border-color:rgba(154,230,75,.3)">You organize this</span>' : '<span class="pill">Read only</span>'}
        </div>
      </div>
      <div class="head-actions">
        <button class="btn btn-sm btn-ghost" data-act="copy" title="Copy a link to this tournament">🔗 Copy link</button>
        ${owner
          ? `<button class="btn btn-sm btn-ghost" data-act="rename">Rename</button>
             <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>`
          : `<button class="btn btn-sm btn-ghost" data-act="use-key">I have the key</button>`}
      </div>
    </div>

    ${owner ? `
    <div class="row wrap" style="margin-bottom:16px">
      <button class="btn btn-primary btn-sm" data-act="new-game">+ Schedule game</button>
      <button class="btn btn-ghost btn-sm" data-act="add-team">+ Add team</button>
      ${data.games.length === 0 && data.teams.length >= 2 ? '<button class="btn btn-ghost btn-sm" data-act="fixtures">⚡ Generate full fixture list</button>' : ''}
    </div>` : ''}

    <div class="tour-layout">
      <div>
        <section class="panel">
          <div class="panel-head">
            <span class="panel-title">Games</span>
            ${nextGame ? `<span class="tiny muted">Next: ${esc(new Date(nextGame.scheduledAt).toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</span>` : ''}
          </div>
          ${gamesPanel(data)}
        </section>
        ${standingsPanel(data)}
      </div>
      <div>
        ${teamsPanel(data)}
        <section class="panel">
          <div class="panel-head"><span class="panel-title">How it works</span></div>
          <div class="panel-body tiny muted" style="line-height:1.7">
            Open any game to run the clock, update the score and start a live video with an on-screen scoreboard.
            ${tournament.sport === 'soccer' ? 'Games are two 45-minute halves.' : 'Games are four 10-minute quarters.'}
            ${owner ? '' : '<br><br>Only the organizer can change scores. You can still watch every update live.'}
          </div>
        </section>
      </div>
    </div>`;
}

export async function renderTournament(app, id) {
  let alive = true;

  async function paint() {
    const data = await api.get(`/tournaments/${encodeURIComponent(id)}`);
    if (!alive) return;
    app.innerHTML = view(data);
    bind(data);
  }

  function refresh() {
    paint().catch(err => toast(err.message, 'error'));
  }

  function bind(data) {
    const { tournament } = data;
    const owner = Boolean(getOwnerKey(tournament.id));
    const on = (act, fn) => app.querySelectorAll(`[data-act="${act}"]`).forEach(el => el.addEventListener('click', fn));

    on('copy', () => copyText(location.href, 'Tournament link copied'));
    if (owner) {
      on('new-game', () => openNewGame(tournament, data.teams, refresh));
      on('add-team', () => openNewTeam(tournament, data.teams.length + 1, refresh));
      on('fixtures', () => openFixtures(tournament, refresh));
      on('delete-team', async e => {
        const btn = e.currentTarget;
        const team = data.teams.find(t => t.id === btn.dataset.id);
        if (!team) return;
        const ok = await confirmDialog({ title: 'Remove team', message: `Remove ${team.name} from this tournament?`, confirmLabel: 'Remove' });
        if (!ok) return;
        try {
          await api.del(`/teams/${encodeURIComponent(team.id)}`, getOwnerKey(tournament.id));
          toast('Team removed');
          refresh();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      on('rename', () => {
        showFormModal({
          title: 'Rename tournament',
          submitLabel: 'Save',
          bodyHTML: `<label class="field"><span class="label">Name</span><input class="input" name="name" maxlength="60" value="${esc(tournament.name)}" required></label>`,
          onSubmit: async fields => {
            const name = (fields.name || '').trim();
            if (!name) throw new Error('Name cannot be empty');
            await api.patch(`/tournaments/${encodeURIComponent(tournament.id)}`, { name }, getOwnerKey(tournament.id));
            toast('Tournament renamed');
            refresh();
          }
        });
      });
      on('delete', async () => {
        const ok = await confirmDialog({
          title: 'Delete tournament',
          message: `Delete “${tournament.name}” with all its teams and games? This cannot be undone.`,
          confirmLabel: 'Delete tournament'
        });
        if (!ok) return;
        try {
          await api.del(`/tournaments/${encodeURIComponent(tournament.id)}`, getOwnerKey(tournament.id));
          forgetOwnerKey(tournament.id);
          toast('Tournament deleted');
          location.hash = '#/';
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    } else {
      on('use-key', () => {
        showFormModal({
          title: 'Organizer key',
          submitLabel: 'Unlock',
          bodyHTML: `<label class="field">
            <span class="label">Owner key</span>
            <input class="input" name="key" placeholder="Paste the key you saved" autocomplete="off">
            <span class="hint">The key was shown once when the tournament was created. It lets you edit scores and start streams on this device.</span>
          </label>`,
          onSubmit: async fields => {
            const key = (fields.key || '').trim();
            if (!key) throw new Error('Paste the key first');
            try {
              await api.patch(`/tournaments/${encodeURIComponent(tournament.id)}`, { name: tournament.name }, key);
              setOwnerKey(tournament.id, key);
              toast('You can now manage this tournament');
              refresh();
            } catch (err) {
              if (err.status === 403) throw new Error('That key does not match this tournament');
              throw err;
            }
          }
        });
      });
    }

    // Keep the header clock-free but refresh the game list every 30s while
    // nothing else is happening, so other people's updates appear.
    clearTimeout(bind.timer);
    bind.timer = setTimeout(() => { if (alive) refresh(); }, 30000);
  }

  await paint();
  return () => {
    alive = false;
    clearTimeout(bind.timer);
  };
}
