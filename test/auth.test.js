'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, json, login } = require('./helpers');

const PORT = 4614;
let srv;
let admin;
let viewer;

function as(cookie, method, path, options = {}) {
  return json(srv.base, method, path, { ...options, cookie });
}

test.before(async () => {
  srv = await startServer(PORT);
  const login1 = await login(srv.base, 'higuy14/cool', 'favgame1');
  assert.equal(login1.status, 200, 'bootstrap admin signs in');
  admin = login1.cookie;

  const made = await as(admin, 'POST', '/api/users', { body: { username: 'grandma', password: 'watch123', role: 'viewer' } });
  assert.equal(made.status, 201);
  const login2 = await login(srv.base, 'grandma', 'watch123');
  assert.equal(login2.status, 200);
  viewer = login2.cookie;
});
test.after(async () => { await srv.close(); });

async function soccerGame() {
  const t = await as(admin, 'POST', '/api/tournaments', { body: { name: 'Login Cup', sport: 'soccer' } });
  assert.equal(t.status, 201);
  const id = t.data.tournament.id;
  const team = async name => (await as(admin, 'POST', `/api/tournaments/${id}/teams`, { body: { name } })).data.team;
  const home = await team('Manchester');
  const away = await team('Liverpool');
  const game = await as(admin, 'POST', `/api/tournaments/${id}/games`, {
    body: { homeTeamId: home.id, awayTeamId: away.id, live: true }
  });
  assert.equal(game.status, 201);
  return { tournamentId: id, home, away, gameId: game.data.game.id };
}

test('the site is closed to anyone without a session', async () => {
  assert.equal((await json(srv.base, 'GET', '/api/tournaments', { anonymous: true })).status, 401);
  assert.equal((await json(srv.base, 'GET', '/api/live', { anonymous: true })).status, 401);
  assert.equal((await json(srv.base, 'POST', '/api/auth/login', {
    anonymous: true, body: { username: 'higuy14/cool', password: 'nope-nope' }
  })).status, 401);
});

test('a viewer can read everything but change nothing', async () => {
  const t = await soccerGame();

  for (const path of ['/api/tournaments', `/api/tournaments/${t.tournamentId}`, '/api/live', `/api/games/${t.gameId}`]) {
    assert.equal((await as(viewer, 'GET', path)).status, 200, `viewer may read ${path}`);
  }

  const writes = [
    ['POST', '/api/tournaments', { name: 'Hijack Cup', sport: 'soccer' }],
    ['POST', '/api/quick-games', { sport: 'soccer', homeName: 'A', awayName: 'B' }],
    ['POST', '/api/demo', {}],
    ['POST', `/api/tournaments/${t.tournamentId}/teams`, { name: 'Sneaky FC' }],
    ['POST', `/api/tournaments/${t.tournamentId}/fixtures`, {}],
    ['POST', `/api/tournaments/${t.tournamentId}/games`, { homeTeamId: t.home.id, awayTeamId: t.away.id }],
    ['PATCH', `/api/tournaments/${t.tournamentId}`, { name: 'Renamed by viewer' }],
    ['DELETE', `/api/tournaments/${t.tournamentId}`, undefined],
    ['POST', `/api/games/${t.gameId}/events`, { type: 'goal', side: 'home' }],
    ['POST', `/api/games/${t.gameId}/clock`, { action: 'start' }],
    ['POST', `/api/games/${t.gameId}/stream`, { streamUrl: 'https://example.com/x' }],
    ['PATCH', `/api/games/${t.gameId}`, { status: 'final' }],
    ['DELETE', `/api/games/${t.gameId}`, undefined],
    ['GET', '/api/users', undefined]
  ];
  for (const [method, path, body] of writes) {
    const res = await as(viewer, method, path, body === undefined ? {} : { body });
    assert.equal(res.status, 403, `viewer must not ${method} ${path}`);
  }

  const list = await as(viewer, 'GET', '/api/tournaments');
  assert.ok(!list.text.includes('Hijack Cup'), 'nothing the viewer sent was stored');
});

test('the referee buttons land on the scoreboard and in the viewer feed', async () => {
  const t = await soccerGame();

  assert.equal((await as(admin, 'POST', `/api/games/${t.gameId}/events`, { body: { type: 'yellow', side: 'away' } })).status, 400, 'a card needs a player');
  const card = await as(admin, 'POST', `/api/games/${t.gameId}/events`, { body: { type: 'yellow', side: 'away', player: 'M. Salah' } });
  assert.equal(card.status, 200);
  assert.equal(card.data.game.events.at(-1).player, 'M. Salah');
  assert.equal(card.data.game.score.away, 0, 'a card does not touch the score');

  const goal = await as(admin, 'POST', `/api/games/${t.gameId}/events`, { body: { type: 'goal', side: 'home', player: 'E. Haaland' } });
  assert.equal(goal.status, 200);
  assert.equal(goal.data.game.score.home, 1);

  const minus = await as(admin, 'POST', `/api/games/${t.gameId}/events`, { body: { type: 'minus_goal', side: 'home' } });
  assert.equal(minus.status, 200);
  assert.equal(minus.data.game.score.home, 0, 'subtract goal takes the point off the board');

  assert.equal((await as(admin, 'POST', `/api/games/${t.gameId}/events`, { body: { type: 'var', side: 'home' } })).status, 400, 'VAR needs a description');
  const review = await as(admin, 'POST', `/api/games/${t.gameId}/events`, {
    body: { type: 'var', side: 'home', note: 'Possible handball before the goal' }
  });
  assert.equal(review.status, 200);
  assert.equal(review.data.game.events.at(-1).note, 'Possible handball before the goal');

  const seen = await as(viewer, 'GET', `/api/games/${t.gameId}`);
  assert.equal(seen.status, 200);
  const types = seen.data.game.events.map(e => e.type);
  for (const type of ['yellow', 'goal', 'minus_goal', 'var']) assert.ok(types.includes(type), `viewer sees ${type}`);
  assert.equal(seen.data.game.events.find(e => e.type === 'yellow').player, 'M. Salah');
});

test('the admin hands out and removes accounts', async () => {
  const made = await as(admin, 'POST', '/api/users', { body: { username: 'uncle', password: 'watch456' } });
  assert.equal(made.status, 201);
  assert.equal(made.data.user.role, 'viewer', 'new accounts default to viewer');
  assert.ok(!('hash' in made.data.user), 'no password hash leaves the server');

  const uncle = await login(srv.base, 'uncle', 'watch456');
  assert.equal(uncle.status, 200);
  assert.equal((await as(uncle.cookie, 'GET', '/api/auth/me')).status, 200);

  const dup = await as(admin, 'POST', '/api/users', { body: { username: 'Uncle', password: 'watch456' } });
  assert.equal(dup.status, 409, 'usernames are unique regardless of case');
  assert.equal((await as(admin, 'POST', '/api/users', { body: { username: 'shorty', password: '123' } })).status, 400);

  const removed = await as(admin, 'DELETE', `/api/users/${made.data.user.id}`);
  assert.equal(removed.status, 200);
  assert.equal((await as(uncle.cookie, 'GET', '/api/auth/me')).status, 401, 'a removed account is signed out at once');

  const me = await as(admin, 'GET', '/api/auth/me');
  assert.equal((await as(admin, 'DELETE', `/api/users/${me.data.user.id}`)).status, 400, 'no deleting yourself');
  assert.equal((await login(srv.base, 'uncle', 'watch456')).status, 401, 'a removed account cannot sign back in');
});

test('people can change their own password', async () => {
  await as(admin, 'POST', '/api/users', { body: { username: 'auntie', password: 'first123', role: 'viewer' } });
  const first = await login(srv.base, 'auntie', 'first123');
  assert.equal(first.status, 200);
  assert.equal((await as(first.cookie, 'POST', '/api/auth/password', {
    body: { current: 'wrong-one', password: 'second123' }
  })).status, 403);
  assert.equal((await as(first.cookie, 'POST', '/api/auth/password', {
    body: { current: 'first123', password: 'second123' }
  })).status, 200);
  assert.equal((await login(srv.base, 'auntie', 'first123')).status, 401);
  assert.equal((await login(srv.base, 'auntie', 'second123')).status, 200);
});
