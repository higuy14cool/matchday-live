'use strict';

const { clockElapsed, newId } = require('./store');

const SPORTS = {
  soccer: { label: 'Soccer', periodLengthMs: 45 * 60 * 1000, periods: 2, periodLabel: 'Half' },
  basketball: { label: 'Basketball', periodLengthMs: 10 * 60 * 1000, periods: 4, periodLabel: 'Quarter' }
};

const SCORE_EVENTS = {
  soccer: new Set(['goal', 'own_goal']),
  basketball: new Set(['score'])
};

// What the browser sees. Owner keys never leave the server.
function publicTournament(t) {
  return { id: t.id, name: t.name, sport: t.sport, createdAt: t.createdAt };
}

function publicTeam(t) {
  return { id: t.id, tournamentId: t.tournamentId, name: t.name, short: t.short, color: t.color };
}

function publicGame(g) {
  const sport = SPORTS[g.sport] || SPORTS.soccer;
  return {
    id: g.id,
    tournamentId: g.tournamentId,
    sport: g.sport,
    round: g.round,
    venue: g.venue,
    scheduledAt: g.scheduledAt,
    status: g.status,
    homeTeamId: g.homeTeamId,
    awayTeamId: g.awayTeamId,
    score: { home: g.score.home, away: g.score.away },
    period: g.clock.period,
    periodLengthMs: sport.periodLengthMs,
    clock: {
      running: Boolean(g.clock.running),
      elapsedMs: clockElapsed(g),
      serverNow: Date.now()
    },
    events: g.events.slice(-80),
    streamUrl: g.streamUrl || '',
    updatedAt: g.updatedAt
  };
}

function newGame({ id, tournamentId, sport, homeTeamId, awayTeamId, round, venue, scheduledAt }) {
  const conf = SPORTS[sport] || SPORTS.soccer;
  return {
    id,
    tournamentId,
    sport,
    homeTeamId,
    awayTeamId,
    round: round || '',
    venue: venue || '',
    scheduledAt: scheduledAt || Date.now(),
    status: 'scheduled',
    score: { home: 0, away: 0 },
    clock: { running: false, elapsedMs: 0, startedAt: null, period: 1, periodLengthMs: conf.periodLengthMs },
    events: [],
    streamUrl: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function otherSide(side) {
  return side === 'home' ? 'away' : 'home';
}

/**
 * Apply one scoreboard event. Returns an error string, or null on success.
 * The event stores its own score delta so undo is exact.
 */
function applyEvent(game, input) {
  const { side, type, player } = input;
  if (side !== 'home' && side !== 'away') return 'side must be home or away';
  if (!SCORE_EVENTS[game.sport]) return 'Unknown sport';
  if (!SCORE_EVENTS[game.sport].has(type) && !['foul', 'yellow', 'red', 'timeout', 'sub'].includes(type)) {
    return 'Unknown event type for this sport';
  }
  if (game.status === 'final') return 'Game is finished — reopen it to make changes';

  const event = {
    id: newId('ev'),
    side,
    type,
    player: typeof player === 'string' ? player.slice(0, 40) : '',
    period: game.clock.period,
    clockMs: clockElapsed(game),
    at: Date.now(),
    scoreEffect: { home: 0, away: 0 }
  };

  if (type === 'goal') event.scoreEffect[side] = 1;
  if (type === 'own_goal') event.scoreEffect[otherSide(side)] = 1;
  if (type === 'score') {
    const points = Number(input.points);
    if (![1, 2, 3].includes(points)) return 'points must be 1, 2 or 3';
    event.points = points;
    event.scoreEffect[side] = points;
  }
  if (type === 'foul' || type === 'timeout') {
    if (game.sport !== 'basketball') return `${type} is a basketball stat`;
  }
  if (type === 'yellow' || type === 'red') {
    if (game.sport !== 'soccer') return 'Cards are a soccer stat';
  }

  game.score.home += event.scoreEffect.home;
  game.score.away += event.scoreEffect.away;
  game.events.push(event);
  game.updatedAt = Date.now();
  if (game.status === 'scheduled') game.status = 'live';
  return null;
}

function undoLast(game) {
  if (game.status === 'final') return 'Game is finished — reopen it to make changes';
  const event = game.events[game.events.length - 1];
  if (!event) return 'Nothing to undo';
  game.score.home = Math.max(0, game.score.home - event.scoreEffect.home);
  game.score.away = Math.max(0, game.score.away - event.scoreEffect.away);
  game.events.pop();
  game.updatedAt = Date.now();
  return null;
}

/** Clock actions: start | pause | reset | next | prev | set */
function clockAction(game, action, options = {}) {
  const c = game.clock;
  const conf = SPORTS[game.sport] || SPORTS.soccer;

  if (action === 'start') {
    if (game.status === 'final') return 'Game is finished — reopen it to make changes';
    if (!c.running) {
      // Never restart a movement that would run past the period: allow, sports
      // have stoppage time, but keep elapsed sane.
      c.running = true;
      c.startedAt = Date.now();
    }
    if (game.status === 'scheduled') game.status = 'live';
  } else if (action === 'pause') {
    if (c.running) {
      c.elapsedMs = clockElapsed(game);
      c.running = false;
      c.startedAt = null;
    }
  } else if (action === 'reset') {
    c.elapsedMs = 0;
    c.running = false;
    c.startedAt = null;
  } else if (action === 'next') {
    c.period = Math.min(conf.periods + 4, c.period + 1);
    c.elapsedMs = 0;
    c.running = false;
    c.startedAt = null;
  } else if (action === 'prev') {
    c.period = Math.max(1, c.period - 1);
    c.elapsedMs = 0;
    c.running = false;
    c.startedAt = null;
  } else if (action === 'set') {
    const ms = Number(options.elapsedMs);
    if (!Number.isFinite(ms) || ms < 0) return 'elapsedMs must be a positive number';
    c.elapsedMs = Math.min(ms, 60 * 60 * 1000);
    if (c.running) c.startedAt = Date.now();
    if (options.period != null) {
      const p = Number(options.period);
      if (!Number.isInteger(p) || p < 1 || p > conf.periods + 4) return 'Invalid period';
      c.period = p;
    }
  } else {
    return 'Unknown clock action';
  }

  game.updatedAt = Date.now();
  return null;
}

function endGame(game) {
  if (game.clock.running) {
    game.clock.elapsedMs = clockElapsed(game);
    game.clock.running = false;
    game.clock.startedAt = null;
  }
  game.status = 'final';
  game.updatedAt = Date.now();
}

module.exports = {
  SPORTS,
  publicTournament,
  publicTeam,
  publicGame,
  newGame,
  applyEvent,
  undoLast,
  clockAction,
  endGame
};
