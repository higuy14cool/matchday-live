import { api, getOwnerKey, setOwnerKey } from '../api.js';
import { showFormModal, toast, confirmDialog } from '../ui.js';
import { esc, toLocalInput, SPORT_LABEL } from '../util.js';

const DEFAULT_COLORS = ['#9ae64b', '#4cc9f0', '#ff9f45', '#ff5d8f', '#b28dff', '#f4d35e'];

export function openNewTournament() {
  showFormModal({
    title: 'New tournament',
    submitLabel: 'Create tournament',
    bodyHTML: `
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
        <span class="hint">Soccer plays two 45-minute halves. Basketball plays four 10-minute quarters.</span>
      </div>`,
    onSubmit: async data => {
      const name = (data.name || '').trim();
      if (!name) throw new Error('Give the tournament a name');
      const res = await api.post('/tournaments', { name, sport: data.sport || 'soccer' });
      const { tournament, ownerKey } = res;
      if (ownerKey) setOwnerKey(tournament.id, ownerKey);
      toast('Tournament created');
      location.hash = `#/t/${tournament.id}`;
    }
  });
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

export function openNewGame(tournament, teams, onDone) {
  if (teams.length < 2) {
    toast('Add at least two teams first', 'error');
    return;
  }
  const options = teams.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  showFormModal({
    title: 'Schedule a game',
    submitLabel: 'Create game',
    bodyHTML: `
      <div class="form-row">
        <label class="field"><span class="label">Home</span><select class="select" name="homeTeamId">${options}</select></label>
        <label class="field"><span class="label">Away</span><select class="select" name="awayTeamId">${options}</select></label>
      </div>
      <div class="form-row">
        <label class="field"><span class="label">Date &amp; time</span><input class="input" type="datetime-local" name="scheduledAt" value="${toLocalInput(Date.now() + 3600e3)}"></label>
        <label class="field"><span class="label">Round <span class="muted">(optional)</span></span><input class="input" name="round" maxlength="40" placeholder="Matchday 1"></label>
      </div>
      <label class="field"><span class="label">Venue <span class="muted">(optional)</span></span><input class="input" name="venue" maxlength="60" placeholder="Riverside Park"></label>`,
    onSubmit: async data => {
      if (data.homeTeamId === data.awayTeamId) throw new Error('Pick two different teams');
      await api.post(`/tournaments/${encodeURIComponent(tournament.id)}/games`, {
        homeTeamId: data.homeTeamId,
        awayTeamId: data.awayTeamId,
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt).toISOString() : undefined,
        round: data.round,
        venue: data.venue
      }, getOwnerKey(tournament.id));
      toast('Game scheduled');
      if (onDone) onDone();
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
