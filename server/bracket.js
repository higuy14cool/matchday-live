'use strict';

const { newGame } = require('./gameplay');
const { seedOrder, bracketSize, firstKnockoutStage, stageLabel } = require('./format');

// One table per group. Group membership comes from the "Group X · Round N"
// round name, so it works for both automatic and hand-assigned groups.
function tableFor(teams, games, sport) {
  const rows = new Map(teams.map(team => [team.id, {
    team, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, points: 0
  }]));
  for (const game of games) {
    if (game.status !== 'final') continue;
    const home = rows.get(game.homeTeamId);
    const away = rows.get(game.awayTeamId);
    if (!home || !away) continue;
    home.played++; away.played++;
    home.gf += game.score.home; home.ga += game.score.away;
    away.gf += game.score.away; away.ga += game.score.home;
    if (game.score.home > game.score.away) {
      home.won++; away.lost++; home.points += 3;
    } else if (game.score.home < game.score.away) {
      away.won++; home.lost++; away.points += 3;
    } else {
      home.drawn++; away.drawn++; home.points++; away.points++;
    }
  }
  const list = [...rows.values()];
  for (const row of list) row.gd = row.gf - row.ga;
  const cmp = sport === 'basketball'
    ? (a, b) => b.won - a.won || b.gd - a.gd || b.gf - a.gf
    : (a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf;
  list.sort(cmp);
  return list;
}

function groupTables(teams, games, format, sport) {
  const groupGames = games.filter(game => game.stage === 'group');
  if (format.groups <= 1) {
    return [{ key: '', teams, rows: tableFor(teams, groupGames, sport) }];
  }

  const membership = new Map();
  for (const game of groupGames) {
    const match = /^Group ([A-Z])/.exec(game.round || '');
    if (!match) continue;
    const index = match[1].charCodeAt(0) - 65;
    membership.set(game.homeTeamId, index);
    membership.set(game.awayTeamId, index);
  }

  const tables = [];
  for (let i = 0; i < format.groups; i++) {
    const inGroup = teams.filter(team => membership.get(team.id) === i);
    if (!inGroup.length) continue;
    const ids = new Set(inGroup.map(team => team.id));
    const inGroupGames = groupGames.filter(game => ids.has(game.homeTeamId) && ids.has(game.awayTeamId));
    tables.push({ key: String.fromCharCode(65 + i), teams: inGroup, rows: tableFor(inGroup, inGroupGames, sport) });
  }
  return tables;
}

// Tier-ordered ranking: every group's 1st places, then every 2nd place, etc.,
// so qualification follows group position before points.
function globalRanking(tables, sport) {
  const ranked = [];
  const maxPos = Math.max(0, ...tables.map(table => table.rows.length));
  for (let pos = 0; pos < maxPos; pos++) {
    const tier = [];
    for (const table of tables) {
      if (table.rows[pos]) tier.push(table.rows[pos]);
    }
    tier.sort(sport === 'basketball'
      ? (a, b) => b.won - a.won || b.gd - a.gd || b.gf - a.gf
      : (a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);
    ranked.push(...tier.map(row => row.team));
  }
  return ranked;
}

function winnerOf(game) {
  if (game.status !== 'final') return null;
  if (game.score.home > game.score.away) return game.homeTeamId;
  if (game.score.away > game.score.home) return game.awayTeamId;
  return null;
}

function loserOf(game) {
  if (game.status !== 'final') return null;
  if (game.score.home > game.score.away) return game.awayTeamId;
  if (game.score.away > game.score.home) return game.homeTeamId;
  return null;
}

function stageGames(games, stage) {
  return games
    .filter(game => game.stage === stage)
    .sort((a, b) => (a.bracketSlot || 0) - (b.bracketSlot || 0) || a.scheduledAt - b.scheduledAt);
}

/**
 * Create whatever game follows a result, once its round is complete.
 * Returns the new games (already stored) so the caller can broadcast them.
 */
function advanceTournament(store, tournament, finished, makeId) {
  const format = tournament.format;
  if (!format || format.knockout === 'none') return [];
  const games = store.gamesOf(tournament.id);
  const created = [];
  let offset = 1;

  function insert(props) {
    const game = newGame({
      id: makeId(),
      tournamentId: tournament.id,
      sport: tournament.sport,
      homeTeamId: props.homeTeamId,
      awayTeamId: props.awayTeamId,
      stage: props.stage,
      round: props.round,
      venue: '',
      scheduledAt: Date.now() + offset++ * 24 * 60 * 60 * 1000
    });
    game.bracketSlot = props.bracketSlot || 0;
    store.insert('games', game);
    created.push(game);
    return game;
  }

  if (finished.stage === 'group') {
    const groupGames = games.filter(game => game.stage === 'group');
    if (!groupGames.length || !groupGames.every(game => game.status === 'final')) return [];
    if (games.some(game => ['qf', 'sf', 'final'].includes(game.stage))) return [];

    const teams = store.teamsOf(tournament.id);
    const tables = groupTables(teams, games, format, tournament.sport);
    const ranked = globalRanking(tables, tournament.sport);
    const size = bracketSize(format.knockout);
    if (ranked.length < size) return [];

    const stage = firstKnockoutStage(format.knockout);
    const order = seedOrder(size);
    for (let i = 0; i < size; i += 2) {
      const home = ranked[order[i] - 1];
      const away = ranked[order[i + 1] - 1];
      if (!home || !away || home.id === away.id) continue;
      insert({ homeTeamId: home.id, awayTeamId: away.id, stage, round: stageLabel(stage), bracketSlot: i / 2 });
    }

    if (format.placement && ranked.length >= size + 2) {
      const third = ranked[size];
      const fourth = ranked[size + 1];
      if (third && fourth && third.id !== fourth.id) {
        insert({ homeTeamId: third.id, awayTeamId: fourth.id, stage: 'placement', round: '5th/6th place', bracketSlot: 0 });
      }
    }
    return created;
  }

  if (finished.stage === 'qf') {
    const qf = stageGames(games, 'qf');
    if (qf.length < 2 || !qf.every(game => game.status === 'final')) return [];
    if (stageGames(games, 'sf').length) return [];
    for (let i = 0; i < qf.length; i += 2) {
      const home = winnerOf(qf[i]);
      const away = qf[i + 1] ? winnerOf(qf[i + 1]) : null;
      if (!home || !away) continue;
      insert({ homeTeamId: home, awayTeamId: away, stage: 'sf', round: stageLabel('sf'), bracketSlot: i / 2 });
    }
    return created;
  }

  if (finished.stage === 'sf') {
    const sf = stageGames(games, 'sf');
    if (sf.length < 2 || !sf.every(game => game.status === 'final')) return [];
    if (!stageGames(games, 'final').length) {
      const home = winnerOf(sf[0]);
      const away = winnerOf(sf[1]);
      if (home && away) {
        insert({ homeTeamId: home, awayTeamId: away, stage: 'final', round: stageLabel('final'), bracketSlot: 0 });
      }
    }
    if (format.thirdPlace && !stageGames(games, 'third').length) {
      const home = loserOf(sf[0]);
      const away = loserOf(sf[1]);
      if (home && away) {
        insert({ homeTeamId: home, awayTeamId: away, stage: 'third', round: stageLabel('third'), bracketSlot: 0 });
      }
    }
    return created;
  }

  return [];
}

module.exports = { advanceTournament, tableFor, groupTables, globalRanking, winnerOf, loserOf };
