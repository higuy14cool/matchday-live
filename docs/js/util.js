export const SPORT_LABEL = { soccer: 'Soccer', basketball: 'Basketball' };
export const SPORT_ICON = { soccer: '⚽', basketball: '🏀' };

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

export function periodLabel(sport, period) {
  if (sport === 'basketball') {
    if (period <= 4) return `Q${period}`;
    return period === 5 ? 'OT' : `OT${period - 4}`;
  }
  const names = ['1st Half', '2nd Half', 'ET 1', 'ET 2', 'Penalties'];
  return names[period - 1] || `Half ${period}`;
}

export function shortPeriod(sport, period) {
  if (sport === 'basketball') return periodLabel(sport, period);
  if (period >= 5) return 'PENS';
  return periodLabel(sport, period).replace('Half', 'H');
}

/** "Pens 4–2" when a shootout has started, otherwise an empty string. */
export function pensLabel(game) {
  const pens = game.shootout;
  if (!pens || (!pens.active && !pens.home && !pens.away)) return '';
  return `Pens ${pens.home}–${pens.away}`;
}

/**
 * Live clock for a game snapshot. `syncedAt` is when the browser received it,
 * so a running clock keeps counting without another server round-trip.
 */
export function clockState(game, syncedAt = Date.now()) {
  const elapsedMs = game.clock.elapsedMs + (game.clock.running ? Math.max(0, Date.now() - syncedAt) : 0);
  if (game.sport === 'basketball') {
    const remaining = Math.max(0, game.periodLengthMs - elapsedMs);
    return { text: fmtClock(remaining), elapsedMs, running: game.clock.running, overtime: remaining === 0 };
  }
  return { text: fmtClock(elapsedMs), elapsedMs, running: game.clock.running, overtime: false };
}

export function eventClockLabel(event, sport, periodLengthMs) {
  const elapsed = event.clockMs || 0;
  if (sport === 'basketball') return `${shortPeriod(sport, event.period)} ${fmtClock(Math.max(0, periodLengthMs - elapsed))}`;
  return `${shortPeriod(sport, event.period)} ${fmtClock(elapsed)}`;
}

export function eventLabel(event, home, away, sport) {
  const team = event.side === 'home' ? home : away;
  const name = team ? esc(team.name) : 'Team';
  const who = event.player ? ` <span class="ev-player">${esc(event.player)}</span>` : '';
  if (event.type === 'goal' && event.shootout) return { icon: '⚽', html: `<b>${name}</b> penalty scored${who}` };
  if (event.type === 'minus_goal' && event.shootout) return { icon: '↩️', html: `<b>${name}</b> penalty removed${who}` };
  if (event.type === 'goal') return { icon: '⚽', html: `<b>${name}</b> goal${who}` };
  if (event.type === 'minus_goal') return { icon: '↩️', html: `<b>${name}</b> goal removed${who}` };
  if (event.type === 'own_goal') return { icon: '🥴', html: `<b>${name}</b> own goal${who}` };
  if (event.type === 'score') return { icon: '🏀', html: `<b>${name}</b> +${event.points}${who}` };
  if (event.type === 'yellow') return { icon: '🟨', html: `<b>${name}</b> yellow card${who}` };
  if (event.type === 'red') return { icon: '🟥', html: `<b>${name}</b> red card${who}` };
  if (event.type === 'yellow_red') return { icon: '🟨🟥', html: `<b>${name}</b> second yellow → red${who}` };
  if (event.type === 'var') return { icon: '📺', html: `VAR: ${esc(event.note || 'review')} <span class="ev-player">${esc(name)}</span>` };
  if (event.type === 'foul') return { icon: '✋', html: `<b>${name}</b> foul${who}` };
  if (event.type === 'timeout') return { icon: '⏱', html: `<b>${name}</b> timeout` };
  if (event.type === 'sub') return { icon: '🔁', html: `<b>${name}</b> substitution${who}` };
  return { icon: '•', html: `<b>${name}</b> ${esc(event.type)}` };
}

/** Events worth showing on the video overlay: referee calls and score changes. */
export const OVERLAY_EVENTS = new Set(['goal', 'minus_goal', 'own_goal', 'yellow', 'red', 'yellow_red', 'var', 'score']);

export function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay(d, today)) return `Today ${time}`;
  if (sameDay(d, tomorrow)) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export function fmtDateShort(ts) {
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function toLocalInput(ts) {
  const d = new Date(ts || Date.now());
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

/** Standings from finished games. */
export function computeStandings(teams, games, sport) {
  const rows = new Map();
  for (const team of teams) {
    rows.set(team.id, {
      team, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0,
      points: 0, pct: 0
    });
  }
  for (const game of games) {
    if (game.status !== 'final') continue;
    const home = rows.get(game.homeTeamId);
    const away = rows.get(game.awayTeamId);
    if (!home || !away) continue;
    const hs = game.score.home;
    const as = game.score.away;
    home.played++; away.played++;
    home.gf += hs; home.ga += as;
    away.gf += as; away.ga += hs;
    if (hs > as) {
      home.won++; away.lost++;
      home.points += 3;
    } else if (hs < as) {
      away.won++; home.lost++;
      away.points += 3;
    } else {
      home.drawn++; away.drawn++;
      home.points += 1; away.points += 1;
    }
  }
  for (const row of rows.values()) {
    row.gd = row.gf - row.ga;
    row.pct = row.played ? (row.won * 100) / row.played : 0;
  }
  const list = [...rows.values()];
  if (sport === 'basketball') {
    list.sort((a, b) => b.won - a.won || b.gd - a.gd || b.gf - a.gf);
  } else {
    list.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);
  }
  return list;
}

export function colorOf(team, fallback = '#9ae64b') {
  return team && /^#[0-9a-fA-F]{6}$/.test(team.color || '') ? team.color : fallback;
}

/** Turn a YouTube/Twitch watch link into something that can be embedded. */
export function embedUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = u.searchParams.get('v') || (u.pathname.startsWith('/live/') ? u.pathname.split('/')[2] : '');
      if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}`;
    }
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1);
      if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}`;
    }
    if (host === 'twitch.tv') {
      const channel = u.pathname.split('/').filter(Boolean)[0];
      if (channel) return `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(location.hostname)}`;
    }
    return u.toString();
  } catch {
    return '';
  }
}

export function ordinal(n) {
  return `${n}`;
}
