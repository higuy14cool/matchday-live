import { clockElapsed, newId } from './store.js';

const SPORTS = {
  soccer: { label: 'Soccer', periodLengthMs: 45 * 60 * 1000, periods: 2, periodLabel: 'Half' },
  basketball: { label: 'Basketball', periodLengthMs: 10 * 60 * 1000, periods: 4, periodLabel: 'Quarter' }
};

const SCORE_EVENTS = {
  soccer: new Set(['goal', 'own_goal', 'minus_goal']),
  basketball: new Set(['score'])
};

// Referee actions the scorer can send during a live match. Cards and VAR are
// soccer, fouls and timeouts are basketball.
const CARD_EVENTS = new Set(['yellow', 'red', 'yellow_red']);
const OTHER_EVENTS = new Set(['foul', 'timeout', 'sub', 'var']);

// A knockout tie that is still level after extra time goes to penalties: the
// 5th soccer period. Goals then count in the shootout, not on the scoreboard.
const KNOCKOUT_STAGES = new Set(['qf', 'sf', 'final', 'third', 'placement']);
const SHOOTOUT_PERIOD = 5;

function inShootout(game) {
  return Boolean(game.shootout && game.shootout.active);
}

function canStartShootout(game) {
  if (game.sport !== 'soccer' || game.shootoutOnly) return false;
  if (!KNOCKOUT_STAGES.has(game.stage)) return false;
  return game.clock.period >= 4; // after a second period of extra time
}

/**
 * Score snapshots through the recording, so a replay can put the score back to
 * what it was at any second of the video. `t` is milliseconds into the
 * recording: the filming client's own offset when it has one, otherwise the
 * event time measured from the moment filming started.
 */
function replayTimeline(g) {
  const start = g.recording && g.recording.startedAt ? g.recording.startedAt : 0;
  const when = item => {
    if (Number.isFinite(item.replayMs)) return Math.max(0, Math.round(item.replayMs));
    if (start && Number.isFinite(item.at)) return Math.max(0, item.at - start);
    return 0;
  };
  const steps = [];
  for (const ev of g.events) steps.push({ t: when(ev), ev });
  for (const set of (g.scoreSets || [])) steps.push({ t: when(set), set });
  steps.sort((a, b) => a.t - b.t);

  let shots = Boolean(g.shootoutOnly);
  let home = 0;
  let away = 0;
  let pensHome = 0;
  let pensAway = 0;
  let period = g.shootoutOnly ? SHOOTOUT_PERIOD : 1;
  const out = [];
  for (const step of steps) {
    if (step.set) {
      home = step.set.home;
      away = step.set.away;
      if (step.set.pensHome != null) {
        shots = true;
        pensHome = step.set.pensHome;
        pensAway = step.set.pensAway || 0;
      }
      if (step.set.period) period = step.set.period;
    } else {
      const ev = step.ev;
      if (ev.scoreEffect) {
        home = Math.max(0, home + ev.scoreEffect.home);
        away = Math.max(0, away + ev.scoreEffect.away);
      }
      if (ev.pensEffect) {
        shots = true;
        pensHome = Math.max(0, pensHome + ev.pensEffect.home);
        pensAway = Math.max(0, pensAway + ev.pensEffect.away);
      }
      if (Number.isInteger(ev.period) && ev.period > period) period = ev.period;
    }
    out.push({ t: step.t, home, away, shots, pensHome, pensAway, period });
  }
  return out;
}

// What the browser sees. Owner keys never leave the server.
function publicTournament(t) {
  return {
    id: t.id,
    name: t.name,
    sport: t.sport,
    format: t.format || null,
    quick: Boolean(t.quick),
    createdAt: t.createdAt
  };
}

function publicTeam(t) {
  return { id: t.id, tournamentId: t.tournamentId, name: t.name, short: t.short, color: t.color, group: Number.isInteger(t.group) ? t.group : null };
}

function publicGame(g) {
  const sport = SPORTS[g.sport] || SPORTS.soccer;
  return {
    id: g.id,
    tournamentId: g.tournamentId,
    sport: g.sport,
    round: g.round,
    stage: g.stage || '',
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
    shootout: {
      active: Boolean(g.shootout && g.shootout.active),
      home: g.shootout ? g.shootout.home : 0,
      away: g.shootout ? g.shootout.away : 0
    },
    shootoutOnly: Boolean(g.shootoutOnly),
    events: g.events.slice(-80),
    timeline: replayTimeline(g),
    scoreSets: (g.scoreSets || []).slice(-200),
    streamUrl: g.streamUrl || '',
    recording: g.recording
      ? {
        available: true,
        duration: g.recording.duration || null,
        size: g.recording.size || 0,
        startedAt: g.recording.startedAt || null,
        savedAt: g.recording.savedAt || null
      }
      : null,
    updatedAt: g.updatedAt
  };
}

function newGame({ id, tournamentId, sport, homeTeamId, awayTeamId, stage, round, venue, scheduledAt, shootout }) {
  const conf = SPORTS[sport] || SPORTS.soccer;
  const pensOnly = Boolean(shootout) && sport === 'soccer';
  return {
    id,
    tournamentId,
    sport,
    homeTeamId,
    awayTeamId,
    stage: stage || '',
    round: round || '',
    venue: venue || '',
    scheduledAt: scheduledAt || Date.now(),
    status: 'scheduled',
    score: { home: 0, away: 0 },
    clock: { running: false, elapsedMs: 0, startedAt: null, period: pensOnly ? SHOOTOUT_PERIOD : 1, periodLengthMs: conf.periodLengthMs },
    shootout: { active: pensOnly, home: 0, away: 0 },
    shootoutOnly: pensOnly,
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
  if (!SCORE_EVENTS[game.sport].has(type) && !CARD_EVENTS.has(type) && !OTHER_EVENTS.has(type)) {
    return 'Unknown event type for this sport';
  }
  if (game.status === 'final') return 'Game is finished — reopen it to make changes';

  const event = {
    id: newId('ev'),
    side,
    type,
    player: typeof player === 'string' ? player.trim().slice(0, 40) : '',
    note: typeof input.note === 'string' ? input.note.trim().slice(0, 160) : '',
    period: game.clock.period,
    clockMs: clockElapsed(game),
    at: Date.now(),
    scoreEffect: { home: 0, away: 0 }
  };
  // How far into the recorded video this happened, so a replay can rebuild the
  // score as it stood at each moment. Only the filming client knows this.
  if (Number.isFinite(input.replayMs) && input.replayMs >= 0) event.replayMs = Math.round(input.replayMs);

  // During a shootout a goal is a penalty: it moves the shootout score only.
  if (inShootout(game) && (type === 'goal' || type === 'minus_goal')) {
    if (type === 'minus_goal' && game.shootout[side] < 1) return 'That team has no penalty to remove';
    event.shootout = true;
    event.pensEffect = { home: 0, away: 0 };
    event.pensEffect[side] = type === 'goal' ? 1 : -1;
    game.shootout.home += event.pensEffect.home;
    game.shootout.away += event.pensEffect.away;
    game.events.push(event);
    game.updatedAt = Date.now();
    if (game.status === 'scheduled') game.status = 'live';
    return null;
  }

  if (type === 'goal') event.scoreEffect[side] = 1;
  if (type === 'own_goal') event.scoreEffect[otherSide(side)] = 1;
  // A removed goal can never push a score below zero, and the stored delta is
  // the one that actually applied so undo stays exact.
  if (type === 'minus_goal') {
    if (game.score[side] < 1) return 'That team has no goal to remove';
    event.scoreEffect[side] = -1;
  }
  if (type === 'score') {
    const points = Number(input.points);
    if (![1, 2, 3].includes(points)) return 'points must be 1, 2 or 3';
    event.points = points;
    event.scoreEffect[side] = points;
  }
  if (type === 'foul' || type === 'timeout') {
    if (game.sport !== 'basketball') return `${type} is a basketball stat`;
  }
  if (CARD_EVENTS.has(type)) {
    if (game.sport !== 'soccer') return 'Cards are a soccer stat';
    if (!event.player) return 'Say which player the card is for';
  }
  if (type === 'var') {
    if (!event.note) return 'Describe what was reviewed';
  }
  if (type === 'minus_goal' && game.sport !== 'soccer') return 'minus_goal is a soccer stat';

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
  if (event.pensEffect) {
    game.shootout.home = Math.max(0, game.shootout.home - event.pensEffect.home);
    game.shootout.away = Math.max(0, game.shootout.away - event.pensEffect.away);
  } else {
    game.score.home = Math.max(0, game.score.home - event.scoreEffect.home);
    game.score.away = Math.max(0, game.score.away - event.scoreEffect.away);
  }
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
    if (game.shootoutOnly) return null; // a shootout has no next period
    if (canStartShootout(game)) {
      game.shootout.active = true;
      c.period = SHOOTOUT_PERIOD;
    } else if (inShootout(game)) {
      return null; // already in the shootout
    } else {
      c.period = Math.min(conf.periods + 4, c.period + 1);
    }
    c.elapsedMs = 0;
    c.running = false;
    c.startedAt = null;
  } else if (action === 'prev') {
    if (game.shootoutOnly) return null;
    if (inShootout(game)) {
      game.shootout.active = false;
      c.period = 4;
    } else {
      c.period = Math.max(1, c.period - 1);
    }
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

export {
  SPORTS,
  publicTournament,
  publicTeam,
  publicGame,
  newGame,
  applyEvent,
  inShootout,
  canStartShootout,
  undoLast,
  clockAction,
  endGame
};
