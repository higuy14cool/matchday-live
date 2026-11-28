'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, json, login } = require('./helpers');

const PORT = 4615;
let srv;
let admin;
let viewer;

const as = (cookie, method, route, options = {}) => json(srv.base, method, route, { ...options, cookie });

test.before(async () => {
  srv = await startServer(PORT);
  admin = (await login(srv.base, 'higuy14/cool', 'favgame1')).cookie;
  await as(admin, 'POST', '/api/users', { body: { username: 'watcher', password: 'watch123', role: 'viewer' } });
  viewer = (await login(srv.base, 'watcher', 'watch123')).cookie;
});
test.after(async () => { await srv.close(); });

async function seeded() {
  const t = await as(admin, 'POST', '/api/tournaments', { body: { name: 'Backup Cup', sport: 'soccer' } });
  const id = t.data.tournament.id;
  const team = async name => (await as(admin, 'POST', `/api/tournaments/${id}/teams`, { body: { name } })).data.team;
  const home = await team('Alpha');
  const away = await team('Beta');
  const game = await as(admin, 'POST', `/api/tournaments/${id}/games`, {
    body: { homeTeamId: home.id, awayTeamId: away.id }
  });
  await as(admin, 'POST', `/api/games/${game.data.game.id}/events`, { body: { type: 'goal', side: 'home' } });
  return id;
}

test('a backup can only be downloaded or restored by an admin', async () => {
  assert.equal((await json(srv.base, 'GET', '/api/backup', { anonymous: true })).status, 401);
  assert.equal((await as(viewer, 'GET', '/api/backup')).status, 403);
  assert.equal((await as(viewer, 'POST', '/api/backup', { body: { confirm: 'replace', data: {} } })).status, 403);
});

test('the backup holds every tournament, team, game and account', async () => {
  const id = await seeded();
  const res = await as(admin, 'GET', '/api/backup');
  assert.equal(res.status, 200);
  assert.equal(res.data.app, 'matchday-live');
  assert.ok(res.data.data.tournaments.some(t => t.id === id));
  assert.ok(res.data.data.teams.length >= 2);
  assert.ok(res.data.data.games.length >= 1);
  assert.ok(res.data.data.users.some(u => u.username === 'watcher'));
});

test('restoring brings back a tournament that was deleted', async () => {
  const id = await seeded();
  const before = (await as(admin, 'GET', '/api/backup')).data.data;
  const snapshot = JSON.parse(JSON.stringify(before));

  assert.equal((await as(admin, 'DELETE', `/api/tournaments/${id}`)).status, 200);
  const gone = await as(admin, 'GET', `/api/tournaments/${id}`);
  assert.equal(gone.status, 404, 'tournament is really gone');

  const restored = await as(admin, 'POST', '/api/backup', { body: { confirm: 'replace', data: snapshot } });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.tournaments, snapshot.tournaments.length);
  assert.equal(restored.data.games, snapshot.games.length);

  const back = await as(admin, 'GET', `/api/tournaments/${id}`);
  assert.equal(back.status, 200, 'tournament is back');
  assert.equal(back.data.teams.length, 2);
  assert.equal(back.data.games.length, 1);
  assert.equal(back.data.games[0].score.home, 1, 'the goal survived the round trip');
});

test('a broken or foreign file is refused and the data stays untouched', async () => {
  const id = await seeded();
  const before = (await as(admin, 'GET', '/api/backup')).data.data;

  const cases = [
    { confirm: 'replace', data: { users: before.users } },
    { confirm: 'replace', data: { ...before, games: [{ nope: true }] } },
    { confirm: 'replace', data: { ...before, users: [] } },
    { confirm: 'replace', data: 'not an object' },
    { data: before }
  ];
  for (const body of cases) {
    const res = await as(admin, 'POST', '/api/backup', { body });
    assert.equal(res.status, 400, `refused: ${JSON.stringify(body).slice(0, 60)}`);
    assert.ok(res.data.error);
  }

  const after = await as(admin, 'GET', `/api/tournaments/${id}`);
  assert.equal(after.status, 200, 'the tournament is still there');
});

test('a copy of the database is kept once a day', async () => {
  await seeded();
  const dir = path.join(srv.dataDir, 'backups');
  assert.ok(fs.existsSync(dir), 'backups folder exists');
  const files = fs.readdirSync(dir).filter(f => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  assert.equal(files.length, 1, 'one copy for today');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.ok(Array.isArray(saved.tournaments));
});
