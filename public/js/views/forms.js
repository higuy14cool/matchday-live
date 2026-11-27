import { api, getOwnerKey, setOwnerKey } from '../api.js';
import { showFormModal, toast, confirmDialog } from '../ui.js';
import { esc, toLocalInput, SPORT_LABEL } from '../util.js';

const DEFAULT_COLORS = ['#9ae64b', '#4cc9f0', '#ff9f45', '#ff5d8f', '#b28dff', '#f4d35e'];

export function openNewTournament() {
  const modal = showFormModal({
    title: 'New tournament',
    submitLabel: 'Create tournament',
    bodyHTML: `
      <div class="wizard-step"><span class="step-num">1</span><span>Name &amp; sport</span></div>
      <label class="field">
        <span class="label">Tournament name</span>
        <input class="input" name="name" maxlength="60" placeholder="Sunday Cup" required autocomplete="off">
      </label>
      <div class="field">
        <span class="label">Sport</span>
        <div class="row" style="gap:10px">
          <label class="ctrl-box" style="flex:1;cursor:pointer;margin:0;display:flex;align-items:center;gap:8px;padding:12px">
            <input type="radio" name="sport" value="soccer" checked>
            <span>⚽ Soccer</span>
          </label>
          <label class="ctrl-box" style="flex:1;cursor:pointer;margin:0;display:flex;align-items:center;gap:8px;padding:12px">
            <input type="radio" name="sport" value="basketball">
            <span>🏀 Basketball</span>
          </label>
        </div>
      </div>

      <div class="wizard-step"><span class="step-num">2</span><span>Teams</span></div>
      <label class="field">
        <span class="label">Team names <span class="muted">(one per line)</span></span>
        <textarea class="input" name="teams" rows="7" placeholder="Riverside FC&#10;Northside United&#10;Harbour City&#10;..."></textarea>
        <span class="hint" id="team-count">3 to 80 teams. Names must be different.</span>
      </label>

      <div class="wizard-step"><span class="step-num">3</span><span>Tournament format</span></div>
      <div class="form-row">
        <label class="field"><span class="label">Groups</span>
          <select class="select" name="groups" id="groups-select">
            <option value="1">1 group</option>
            <option value="2">2 groups</option>
            <option value="3">3 groups</option>
            <option value="4">4 groups</option>
            <option value="6">6 groups</option>
            <option value="8">8 groups</option>
            <option value="12">12 groups</option>
            <option value="16">16 groups</option>
          </select>
        </label>
        <label class="field"><span class="label">Group stage</span>
          <select class="select" name="groupStage" id="group-stage-select">
            <option value="single">Single round robin</option>
            <option value="double">Double round robin</option>
            <option value="none">No groups — straight knockout</option>
          </select>
        </label>
      </div>
      <div class="form-row">
        <label class="field"><span class="label">Knockout rounds</span>
          <select class="select" name="knockout">
            <option value="none">No knockout</option>
            <option value="final">Final only</option>
            <option value="semifinal">Semifinals + Final</option>
            <option value="quarterfinal" selected>Quarterfinals + Semifinals + Final</option>
          </select>
        </label>
        <label class="field"><span class="label">Advance per group</span>
          <select class="select" name="advancePerGroup">
            <option value="1">Top 1</option>
            <option value="2" selected>Top 2</option>
            <option value="3">Top 3</option>
            <option value="4">Top 4</option>
          </select>
        </label>
      </div>
      <p class="hint" id="format-hint">Group games are scheduled automatically. Create quarterfinal, semifinal and final games once the qualifiers are known.</p>`,
    onSubmit: async data => {
      const name = (data.name || '').trim();
      if (!name) throw new Error('Give the tournament a name');
      const teams = (data.teams || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      if (teams.length < 3) throw new Error('Add at least three teams');
      if (teams.length > 80) throw new Error('A tournament holds up to 80 teams');
      const seen = new Set();
      for (const team of teams) {
        if (seen.has(team.toLowerCase())) throw new Error(`Team name "${team}" is used twice`);
        seen.add(team.toLowerCase());
      }
      const groupStage = data.groupStage || 'single';
      const knockout = data.knockout || 'none';
      if (groupStage === 'none' && knockout === 'none') throw new Error('Choose a group stage or at least one knockout round');
      const groups = groupStage === 'none' ? 1 : Number(data.groups || 1);
      if (groupStage !== 'none' && groups * 2 > teams.length) {
        throw new Error(`${groups} groups need at least ${groups * 2} teams`);
      }
      const res = await api.post('/tournaments', {
        name,
        sport: data.sport || 'soccer',
        teams,
        format: {
          groups,
          groupStage,
          knockout,
          advancePerGroup: Number(data.advancePerGroup || 2)
        }
      });
      const { tournament, ownerKey } = res;
      if (ownerKey) setOwnerKey(tournament.id, ownerKey);
      const games = res.games ? res.games.length : 0;
      toast(`${teams.length} teams · ${games} group game${games === 1 ? '' : 's'} created`);
      location.hash = `#/t/${tournament.id}`;
    }
  });

  const form = modal.form;
  const teamsEl = form.querySelector('[name="teams"]');
  const countEl = form.querySelector('#team-count');
  const groupsEl = form.querySelector('#groups-select');
  const stageEl = form.querySelector('#group-stage-select');
  const hintEl = form.querySelector('#format-hint');

  function refresh() {
    const count = (teamsEl.value || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).length;
    countEl.textContent = `${count} team${count === 1 ? '' : 's'} — needs 3 to 80.`;
    countEl.style.color = count >= 3 && count <= 80 ? 'var(--muted)' : 'var(--red)';
    const straight = stageEl.value === 'none';
    groupsEl.disabled = straight;
    for (const option of groupsEl.options) {
      const n = Number(option.value);
      option.disabled = !straight && n * 2 > Math.max(count, 3);
    }
    if (!straight && Number(groupsEl.value) * 2 > count) {
      const usable = [...groupsEl.options].filter(o => !o.disabled).pop();
      if (usable) groupsEl.value = usable.value;
    }
    if (straight) hintEl.textContent = 'No group games are generated. Create each knockout game by hand as the bracket unfolds.';
    else hintEl.textContent = `${groupsEl.value} group${groupsEl.value === '1' ? '' : 's'} · ${stageEl.value === 'double' ? 'double' : 'single'} round robin. Group games are scheduled automatically; knockout games are created when the qualifiers are known.`;
  }
  teamsEl.addEventListener('input', refresh);
  stageEl.addEventListener('change', refresh);
  groupsEl.addEventListener('change', refresh);
  refresh();
}

export function openNewTeam(tournament, nextNumber = 1, onDone) {
  const color = DEFAULT_COLORS[(nextNumber - 1) % DEFAULT_COLORS.length];
  showFormModal({
    title: 'Add a team',
    submitLabel: 'Add team',
    bodyHTML: `
      <label class="field">
        <span class="label">Team name</span>
        <input class="input" name="name" maxlength="40" placeholder="Riverside FC" required autocomplete="off">
      </label>
      <div class="form-row">
        <label class="field">
          <span class="label">Short code</span>
          <input class="input" name="short" maxlength="4" placeholder="RFC" style="text-transform:uppercase" autocomplete="off">
        </label>
        <label class="field">
          <span class="label">Color</span>
          <input class="input" type="color" name="color" value="${color}" style="height:43px;padding:4px">
        </label>
      </div>`,
    onSubmit: async data => {
      const name = (data.name || '').trim();
      if (!name) throw new Error('Give the team a name');
      await api.post(`/tournaments/${encodeURIComponent(tournament.id)}/teams`, {
        name,
        short: (data.short || '').trim(),
        color: data.color
      }, getOwnerKey(tournament.id));
      toast('Team added');
      if (onDone) onDone();
    }
  });
}

function stageChoices(format) {
  if (!format) {
    return [
      ['group', 'Group stage'],
      ['qf', 'Quarterfinal'],
      ['sf', 'Semifinal'],
      ['final', 'Final']
    ];
  }
  const stages = [];
  if (format.groupStage !== 'none') stages.push(['group', 'Group stage']);
  if (format.knockout === 'quarterfinal') stages.push(['qf', 'Quarterfinal'], ['sf', 'Semifinal'], ['final', 'Final']);
  else if (format.knockout === 'semifinal') stages.push(['sf', 'Semifinal'], ['final', 'Final']);
  else if (format.knockout === 'final') stages.push(['final', 'Final']);
  return stages.length ? stages : [['group', 'Group stage']];
}

export function openNewGame(tournament, teams, onDone) {
  if (teams.length < 2) {
    toast('Add at least two teams first', 'error');
    return;
  }
  const options = teams.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  const stages = stageChoices(tournament.format);
  const stageOptions = stages.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('');
  showFormModal({
    title: 'Create a game',
    submitLabel: 'Create game',
    bodyHTML: `
      <div class="form-row">
        <label class="field"><span class="label">Home</span><select class="select" name="homeTeamId">${options}</select></label>
        <label class="field"><span class="label">Away</span><select class="select" name="awayTeamId">${options}</select></label>
      </div>
      <div class="form-row">
        <label class="field"><span class="label">Stage</span><select class="select" name="stage">${stageOptions}</select></label>
        <label class="field"><span class="label">Status</span>
          <select class="select" name="start">
            <option value="scheduled">Scheduled</option>
            <option value="live">Live now — start the clock</option>
          </select>
        </label>
      </div>
      <label class="field"><span class="label">Date &amp; time</span><input class="input" type="datetime-local" name="scheduledAt" value="${toLocalInput(Date.now() + 3600e3)}"></label>
      <label class="field"><span class="label">Round <span class="muted">(optional)</span></span><input class="input" name="round" maxlength="40" placeholder="Matchday 1"></label>
      <label class="field"><span class="label">Venue <span class="muted">(optional)</span></span><input class="input" name="venue" maxlength="60" placeholder="Riverside Park"></label>`,
    onSubmit: async data => {
      if (data.homeTeamId === data.awayTeamId) throw new Error('Pick two different teams');
      const res = await api.post(`/tournaments/${encodeURIComponent(tournament.id)}/games`, {
        homeTeamId: data.homeTeamId,
        awayTeamId: data.awayTeamId,
        stage: data.stage || '',
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt).toISOString() : undefined,
        round: data.round,
        venue: data.venue,
        live: data.start === 'live'
      }, getOwnerKey(tournament.id));
      if (data.start === 'live') {
        toast('Game is live — clock started');
        location.hash = `#/g/${res.game.id}`;
      } else {
        toast('Game scheduled');
        if (onDone) onDone();
      }
    }
  });
}

export function openQuickGame() {
  showFormModal({
    title: 'Quick game',
    submitLabel: 'Create game',
    bodyHTML: `
      <p class="hint" style="margin-top:0">No tournament needed — this creates one game you can score and stream right away.</p>
      <div class="field">
        <span class="label">Sport</span>
        <div class="row" style="gap:10px">
          <label class="ctrl-box" style="flex:1;cursor:pointer;margin:0;display:flex;align-items:center;gap:8px;padding:12px">
            <input type="radio" name="sport" value="soccer" checked><span>⚽ Soccer</span>
          </label>
          <label class="ctrl-box" style="flex:1;cursor:pointer;margin:0;display:flex;align-items:center;gap:8px;padding:12px">
            <input type="radio" name="sport" value="basketball"><span>🏀 Basketball</span>
          </label>
        </div>
      </div>
      <div class="form-row">
        <label class="field"><span class="label">Home team</span><input class="input" name="homeName" maxlength="40" placeholder="Riverside FC" required></label>
        <label class="field"><span class="label">Away team</span><input class="input" name="awayName" maxlength="40" placeholder="Northside United" required></label>
      </div>
      <label class="field"><span class="label">Start</span>
        <select class="select" name="start">
          <option value="scheduled">Scheduled</option>
          <option value="live">Live now — start the clock</option>
        </select>
      </label>`,
    onSubmit: async data => {
      const homeName = (data.homeName || '').trim();
      const awayName = (data.awayName || '').trim();
      if (!homeName || !awayName) throw new Error('Give both teams a name');
      if (homeName.toLowerCase() === awayName.toLowerCase()) throw new Error('Pick two different teams');
      const res = await api.post('/quick-games', {
        sport: data.sport || 'soccer',
        homeName,
        awayName,
        live: data.start === 'live'
      });
      if (res.ownerKey) setOwnerKey(res.tournament.id, res.ownerKey);
      toast(data.start === 'live' ? 'Quick game is live' : 'Quick game created');
      location.hash = `#/g/${res.game.id}`;
    }
  });
}

export async function openFixtures(tournament, onDone) {
  const ok = await confirmDialog({
    title: 'Generate fixtures',
    message: 'Every team plays every other team once. This replaces nothing — it only works when the tournament has no games yet.',
    confirmLabel: 'Generate',
    danger: false
  });
  if (!ok) return;
  try {
    const res = await api.post(`/tournaments/${encodeURIComponent(tournament.id)}/fixtures`, {
      startAt: new Date(Date.now() + 24 * 3600e3).toISOString()
    }, getOwnerKey(tournament.id));
    toast(`${res.count || 0} games created`);
    if (onDone) onDone();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function openStreamLink(game, onDone) {
  showFormModal({
    title: 'Embed a video stream',
    submitLabel: 'Embed stream',
    bodyHTML: `
      <label class="field">
        <span class="label">Video link</span>
        <input class="input" name="url" maxlength="500" placeholder="https://youtube.com/watch?v=…" value="${esc(game.streamUrl || '')}">
        <span class="hint">Paste a YouTube or Twitch link. Viewers see it under the live scoreboard.</span>
      </label>`,
    onSubmit: async data => {
      const url = (data.url || '').trim();
      if (!url) throw new Error('Paste a link first');
      await api.patch(`/games/${encodeURIComponent(game.id)}`, { streamUrl: url }, getOwnerKey(game.tournamentId));
      toast('Stream embedded');
      if (onDone) onDone();
    }
  });
}

export { SPORT_LABEL };
