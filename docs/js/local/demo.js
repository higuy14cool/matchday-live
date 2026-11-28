import { newId } from './store.js';
import { newGame, publicGame } from './gameplay.js';

const MIN = 60 * 1000;

function build(store, { name, sport, teams, games }) {
  const tournament = {
    id: newId('tr'),
    name,
    sport,
    createdAt: Date.now() - Math.floor(Math.random() * 86400000)
  };
  store.insert('tournaments', tournament);

  const createdTeams = teams.map(([teamName, short, color]) => store.insert('teams', {
    id: newId('tm'),
    tournamentId: tournament.id,
    name: teamName,
    short,
    color,
    createdAt: Date.now()
  }));

  for (const spec of games) {
    const game = newGame({
      id: newId('gm'),
      tournamentId: tournament.id,
      sport,
      homeTeamId: createdTeams[spec.home].id,
      awayTeamId: createdTeams[spec.away].id,
      round: spec.round,
      venue: spec.venue,
      scheduledAt: spec.scheduledAt
    });
    if (spec.score) {
      game.score = { home: spec.score[0], away: spec.score[1] };
      game.status = 'live';
      game.clock.period = spec.period || 1;
      game.clock.elapsedMs = spec.elapsedMs || 0;
      game.clock.running = Boolean(spec.running);
      if (game.clock.running) game.clock.startedAt = Date.now();
    } else if (spec.final) {
      game.score = { home: spec.final[0], away: spec.final[1] };
      game.status = 'final';
      game.clock.elapsedMs = game.clock.periodLengthMs;
      game.clock.period = spec.period || 2;
    }
    store.insert('games', game);
  }

  return { tournament: { id: tournament.id, name, sport }, games: store.gamesOf(tournament.id).map(publicGame) };
}

function seedDemo(store) {
  const now = Date.now();
  return [
    build(store, {
      name: 'Sunday Cup',
      sport: 'soccer',
      teams: [
        ['Northside FC', 'NOR', '#9ae64b'],
        ['Harbour United', 'HAR', '#4cc9f0'],
        ['Ironworks SC', 'IRN', '#f7b32b'],
        ['Riverside Athletic', 'RIV', '#ff7a59']
      ],
      games: [
        { home: 0, away: 1, round: 'Round 1', venue: 'Riverside Park', scheduledAt: now - 40 * MIN, score: [1, 0], period: 2, elapsedMs: 3 * MIN + 20000, running: true },
        { home: 2, away: 3, round: 'Round 1', venue: 'Ironworks Ground', scheduledAt: now + 2 * 60 * MIN },
        { home: 0, away: 2, round: 'Round 2', venue: 'Northside Arena', scheduledAt: now + 26 * 60 * MIN },
        { home: 1, away: 3, round: 'Round 2', venue: 'Harbour Field', scheduledAt: now + 28 * 60 * MIN }
      ]
    }),
    build(store, {
      name: 'City Hoops League',
      sport: 'basketball',
      teams: [
        ['Downtown Kings', 'DTK', '#f7b32b'],
        ['Eastside Storm', 'EST', '#4cc9f0'],
        ['Lakeview Heat', 'LVH', '#ff5d8f'],
        ['Metro Titans', 'MTT', '#9ae64b']
      ],
      games: [
        { home: 0, away: 1, round: 'Week 3', venue: 'Central Court', scheduledAt: now - 20 * MIN, score: [54, 49], period: 3, elapsedMs: 10 * MIN - (4 * MIN + 12000), running: true },
        { home: 2, away: 3, round: 'Week 3', venue: 'Lakeview Dome', scheduledAt: now + 90 * MIN },
        { home: 0, away: 2, round: 'Week 4', venue: 'Central Court', scheduledAt: now + 2 * 24 * 60 * MIN }
      ]
    })
  ];
}

export { seedDemo };
