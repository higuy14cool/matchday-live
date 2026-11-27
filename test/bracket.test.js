'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, json, login, setDefaultCookie } = require('./helpers');

const PORT = 4613;
let srv;

test.before(async () => {
  srv = await startServer(PORT);
  const admin = await login(srv.base, 'higuy14/cool', 'favgame1');
  setDefaultCookie(admin.cookie);
});
test.after(async () => { await srv.close(); });

async function createTournament(body) {
  const res = await json(srv.base, 'POST', '/api/tournaments', { body });
  assert.equal(res.status, 201, res.text);
  return res.data;
}

async function state(id) {
  const res = await json(srv.base, 'GET', `/api/tournaments/${id}`);
  assert.equal(res.status, 200);
  return res.data;
}

async function finish(key, game, home, away) {
  const res = await json(srv.base, 'POST', `/api/games/${game.id}/score`, {
    key, body: { home, away, final: true }
  });
  assert.equal(res.status, 200, res.text);
}

async function playGroupGames(id, key) {
  const data = await state(id);
  const names = new Map(data.teams.map(t => [t.id, t.name]));
  const rank = name => Number(name.slice(-1)) || 9;
  const group = data.games.filter(g => g.stage === 'group');
  assert.ok(group.length > 0);
  for (const game of group) {
    const homeWins = rank(names.get(game.homeTeamId)) < rank(names.get(game.awayTeamId));
    await finish(key, game, homeWins ? 2 : 0, homeWins ? 0 : 2);
  }
}

test('a 6-team two-group tournament asks for third and 5th/6th place games', async () => {
  const res = await createTournament({
    name: 'Six Team Cup',
    sport: 'soccer',
    teams: [
      { name: 'A1', group: 0 }, { name: 'A2', group: 0 }, { name: 'A3', group: 0 },
      { name: 'B1', group: 1 }, { name: 'B2', group: 1 }, { name: 'B3', group: 1 }
    ],
    format: { groups: 2, groupStage: 'single', knockout: 'semifinal', advancePerGroup: 2, thirdPlace: true, placement: true }
  });

  assert.equal(res.tournament.format.thirdPlace, true);
  assert.equal(res.tournament.format.placement, true);
  assert.equal(res.teams.length, 6);
  assert.deepEqual(res.teams.map(t => t.group), [0, 0, 0, 1, 1, 1]);
  assert.equal(res.games.length, 6, 'three games in each group');

  await playGroupGames(res.tournament.id, res.ownerKey);
  const afterGroups = await state(res.tournament.id);
  const semis = afterGroups.games.filter(g => g.stage === 'sf');
  const placement = afterGroups.games.filter(g => g.stage === 'placement');
  assert.equal(semis.length, 2, 'two semifinals are created');
  assert.equal(placement.length, 1, 'the 5th/6th place game is created');

  const byName = new Map(afterGroups.teams.map(t => [t.name, t.id]));
  const pairs = semis.map(g => [g.homeTeamId, g.awayTeamId].map(id => [...byName].find(([, v]) => v === id)[0]).sort());
  assert.deepEqual(pairs.sort(), [['A1', 'B2'].sort(), ['A2', 'B1'].sort()]);
  const fifth = placement[0];
  assert.deepEqual([fifth.homeTeamId, fifth.awayTeamId].map(id => [...byName].find(([, v]) => v === id)[0]).sort(), ['A3', 'B3'].sort());
});

test('semifinal winners reach the final and losers play for third', async () => {
  const res = await createTournament({
    name: 'Bracket Cup',
    sport: 'basketball',
    teams: [
      { name: 'A1', group: 0 }, { name: 'A2', group: 0 }, { name: 'A3', group: 0 },
      { name: 'B1', group: 1 }, { name: 'B2', group: 1 }, { name: 'B3', group: 1 }
    ],
    format: { groups: 2, groupStage: 'single', knockout: 'semifinal', advancePerGroup: 2, thirdPlace: true, placement: false }
  });
  const id = res.tournament.id;
  const key = res.ownerKey;
  await playGroupGames(id, key);

  let data = await state(id);
  const semis = data.games.filter(g => g.stage === 'sf');
  assert.equal(semis.length, 2);
  // Home wins the first semi, away wins the second.
  await finish(key, semis[0], 90, 80);
  await finish(key, semis[1], 70, 75);

  data = await state(id);
  const final = data.games.filter(g => g.stage === 'final');
  const third = data.games.filter(g => g.stage === 'third');
  assert.equal(final.length, 1, 'one final is created');
  assert.equal(third.length, 1, 'one third-place game is created');
  assert.equal(final[0].homeTeamId, semis[0].homeTeamId, 'first semifinal winner is home in the final');
  assert.equal(final[0].awayTeamId, semis[1].awayTeamId, 'second semifinal winner is away in the final');
  assert.equal(third[0].homeTeamId, semis[0].awayTeamId, 'first semifinal loser plays for third');
  assert.equal(third[0].awayTeamId, semis[1].homeTeamId, 'second semifinal loser plays for third');

  // Re-saving a result must not duplicate the next round.
  await finish(key, semis[0], 91, 80);
  data = await state(id);
  assert.equal(data.games.filter(g => g.stage === 'final').length, 1);
  assert.equal(data.games.filter(g => g.stage === 'third').length, 1);
});

test('quarterfinals feed the semifinals', async () => {
  const names = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];
  const res = await createTournament({
    name: 'Eight Cup',
    sport: 'soccer',
    teams: names.map(name => ({ name, group: 0 })),
    format: { groups: 1, groupStage: 'single', knockout: 'quarterfinal', advancePerGroup: 4, thirdPlace: false, placement: false }
  });
  const id = res.tournament.id;
  const key = res.ownerKey;

  let data = await state(id);
  for (const game of data.games.filter(g => g.stage === 'group')) {
    await finish(key, game, 3, 0);
  }

  data = await state(id);
  const qf = data.games.filter(g => g.stage === 'qf');
  assert.equal(qf.length, 4, 'four quarterfinals are created');
  for (const game of qf) await finish(key, game, 2, 0);
  data = await state(id);
  assert.equal(data.games.filter(g => g.stage === 'sf').length, 2, 'two semifinals follow');
});

test('the organizer can change who plays a scheduled knockout game', async () => {
  const res = await createTournament({
    name: 'Pick Your Semi',
    sport: 'soccer',
    teams: [
      { name: 'A1', group: 0 }, { name: 'A2', group: 0 }, { name: 'A3', group: 0 },
      { name: 'B1', group: 1 }, { name: 'B2', group: 1 }, { name: 'B3', group: 1 }
    ],
    format: { groups: 2, groupStage: 'single', knockout: 'semifinal', advancePerGroup: 2, thirdPlace: true, placement: false }
  });
  const id = res.tournament.id;
  const key = res.ownerKey;
  await playGroupGames(id, key);

  const data = await state(id);
  const semi = data.games.find(g => g.stage === 'sf');
  const teams = new Map(data.teams.map(t => [t.name, t.id]));

  // Group games and finished games keep their teams.
  const groupGame = data.games.find(g => g.stage === 'group');
  const wrong = await json(srv.base, 'PATCH', `/api/games/${groupGame.id}`, {
    key, body: { homeTeamId: teams.get('A1'), awayTeamId: teams.get('A2') }
  });
  assert.equal(wrong.status, 400);

  const swapped = await json(srv.base, 'PATCH', `/api/games/${semi.id}`, {
    key, body: { homeTeamId: teams.get('B3'), awayTeamId: teams.get('A3') }
  });
  assert.equal(swapped.status, 200, swapped.text);
  assert.equal(swapped.data.game.homeTeamId, teams.get('B3'));
  assert.equal(swapped.data.game.awayTeamId, teams.get('A3'));
  assert.equal(swapped.data.home.name, 'B3');

  const same = await json(srv.base, 'PATCH', `/api/games/${semi.id}`, {
    key, body: { homeTeamId: teams.get('A1'), awayTeamId: teams.get('A1') }
  });
  assert.equal(same.status, 400);

  const outsider = await json(srv.base, 'PATCH', `/api/games/${semi.id}`, {
    key, body: { homeTeamId: 'tm_nothere' }
  });
  assert.equal(outsider.status, 400);

  // The new matchup still feeds the final and the third-place match.
  await finish(key, swapped.data.game, 2, 0);
  const rest = (await state(id)).games.filter(g => g.stage === 'sf' && g.status !== 'final');
  for (const game of rest) await finish(key, game, 1, 0);
  const after = await state(id);
  const final = after.games.find(g => g.stage === 'final');
  assert.ok(final, 'final is created');
  assert.equal(final.homeTeamId, teams.get('B3'), 'the winner of the edited semifinal reaches the final');
});

test('a group with fewer than two teams is refused', async () => {
  const res = await json(srv.base, 'POST', '/api/tournaments', {
    body: {
      name: 'Broken Groups',
      sport: 'soccer',
      teams: [
        { name: 'Only One', group: 0 },
        { name: 'B1', group: 1 }, { name: 'B2', group: 1 }
      ],
      format: { groups: 2, groupStage: 'single', knockout: 'none', advancePerGroup: 1 }
    }
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /at least two teams/i);
});

test('third place is ignored when there are no semifinals', async () => {
  const res = await createTournament({
    name: 'Final Only',
    sport: 'soccer',
    teams: [
      { name: 'A1', group: 0 }, { name: 'A2', group: 0 }, { name: 'A3', group: 0 }
    ],
    format: { groups: 1, groupStage: 'single', knockout: 'final', advancePerGroup: 2, thirdPlace: true, placement: true }
  });
  assert.equal(res.tournament.format.thirdPlace, false);
  assert.equal(res.tournament.format.placement, false, 'three teams cannot fill a 5th/6th place game');
});
