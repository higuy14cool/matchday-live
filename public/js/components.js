import { esc, SPORT_ICON, SPORT_LABEL, fmtDate, colorOf, periodLabel, eventClockLabel, eventLabel, clockState } from './util.js';

export function gameHref(game) {
  return `#/g/${encodeURIComponent(game.id)}`;
}

export function statusPill(game) {
  if (game.status === 'live') return '<span class="pill pill-live">Live</span>';
  if (game.status === 'final') return '<span class="pill pill-final">Final</span>';
  return '<span class="pill pill-scheduled">Scheduled</span>';
}

export function sportPill(sport) {
  return `<span class="pill pill-${sport === 'basketball' ? 'basketball' : 'soccer'}">${SPORT_ICON[sport] || ''} ${esc(SPORT_LABEL[sport] || sport)}</span>`;
}

export function crest(team, cls = 'mini-crest') {
  const color = colorOf(team);
  const short = esc((team && (team.short || team.name || '?'))).slice(0, 4);
  return `<span class="${cls}" style="background:${color}">${short}</span>`;
}

export function scoreText(game) {
  if (game.status === 'scheduled' && game.score.home === 0 && game.score.away === 0) return '';
  return `${game.score.home}–${game.score.away}`;
}

export function gameRow(game, home, away) {
  const score = scoreText(game);
  const when = game.status === 'scheduled' ? fmtDate(game.scheduledAt) : game.status === 'final' ? 'Full time' : 'In play';
  const clock = clockState(game, game._syncedAt || Date.now());
  return `
    <a class="game-row" href="${gameHref(game)}">
      <div class="game-side home">${crest(home)}<span class="nm">${esc(home ? home.name : 'Home')}</span></div>
      <div class="game-mid">
        ${score ? `<span class="game-score ${game.status === 'live' ? 'live' : ''}">${score}</span>` : '<span class="game-vs">vs</span>'}
      </div>
      <div class="game-side away right">${crest(away)}<span class="nm">${esc(away ? away.name : 'Away')}</span></div>
      <div class="game-when">
        <b>${esc(when)}</b>
        <span>${game.status === 'live' ? esc(clock.text) : esc(game.round || '')}${game.recording && game.recording.available ? ' · ▶ Replay' : ''}</span>
      </div>
    </a>`;
}

export function liveCard(game) {
  const clock = clockState(game, game._syncedAt || Date.now());
  return `
    <a class="live-card" href="${gameHref(game)}">
      <div class="live-card-head">
        <span>${esc(game.tournamentName || '')}</span>
        <span class="pill pill-live">Live</span>
      </div>
      <div class="live-card-score">
        <div class="live-team"><span>${esc(game.homeName)}</span><small>${esc(game.homeShort || '')}</small></div>
        <span class="live-scoreline">${game.score.home}–${game.score.away}</span>
        <div class="live-team right"><span>${esc(game.awayName)}</span><small>${esc(game.awayShort || '')}</small></div>
      </div>
      <div class="live-card-foot">
        <span>${game.sport === 'basketball' ? esc(periodLabel(game.sport, game.period)) : esc(periodLabel(game.sport, game.period))}</span>
        <span class="mono">${esc(clock.text)}</span>
      </div>
    </a>`;
}

export function tournamentCard(t) {
  const live = t.liveCount > 0 ? `<span class="pill pill-live">${t.liveCount} live</span>` : '';
  return `
    <a class="t-card" href="#/t/${encodeURIComponent(t.id)}">
      <div class="t-card-top">
        <div class="row" style="gap:12px;min-width:0">
          <span class="sport-chip">${SPORT_ICON[t.sport] || '🏆'}</span>
          <div style="min-width:0">
            <h3 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</h3>
            <div class="tiny muted" style="margin-top:2px">${esc(SPORT_LABEL[t.sport] || t.sport)}</div>
          </div>
        </div>
        ${live}
      </div>
      <div class="t-meta">
        <span><b>${t.teamCount}</b> teams</span>
        <span><b>${t.gameCount}</b> games</span>
        <span>since ${esc(new Date(t.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span>
      </div>
      <div class="t-card-foot">
        <span class="tiny muted">Open tournament</span>
        <span class="link">View →</span>
      </div>
    </a>`;
}

export function feedItem(event, home, away, sport) {
  const info = eventLabel(event, home, away, sport);
  return `
    <div class="feed-item">
      <span class="feed-time">${esc(eventClockLabel(event, sport, event.periodLengthMs || 0))}</span>
      <span class="feed-icon">${info.icon}</span>
      <span class="feed-text">${info.html}</span>
    </div>`;
}

export { eventClockLabel };
