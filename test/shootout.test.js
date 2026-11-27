'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, json, login, setDefaultCookie } = require('./helpers');

const PORT = 4615;
let srv;

test.before(async () => {
  srv = await startServer(PORT);
  const admin = await login(srv.base, 'higuy14/cool', 'favgame1');
  assert.equal(admin.status, 200);
  setDefaultCookie(admin.cookie);
});
test.after(async () => { await srv.close(); });

async function goal(gid, side) {
  return json(srv.base, 'POST', `/api/games/${gid}/events`, { body: { type: 'goal', side } });
}
async function removePens(gid, side) {
  return json(srv.base, 'POST', `/api/games/${gid}/events`, { body: { type: 'minus_goal', side } });
}
async function clock(gid, action) {
  return json(srv.base, 'POST', `/api/games/${gid}/clock`, { body: { action } });
}

test('a quick game can be a penalty shootout on its own', async () => {
  const res = await json(srv.base, 'POST', '/api/quick-games', {
    body: { sport: 'soccer', homeName: 'Spot FC', awayName: 'Twelve Yards' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.game.shootoutOnly, false);

  const pens = await json(srv.base, 'POST', '/api/quick-games', {
    body: { sport: 'soccer', homeName: 'Spot FC', awayName: 'Twelve Yards', shootout: true }
  });
  assert.equal(pens.status, 201);
  const game = pens.data.game;
  assert.equal(game.shootoutOnly, true);
  assert.equal(game.shootout.active, true);
  assert.equal(game.shootout.home, 0);
  assert.equal(game.period, 5);
  assert.equal(game.round, 'Penalty shootout');

  const one = await goal(game.id, 'home');
  assert.equal(one.status, 200);
  assert.equal(one.data.game.shootout.home, 1);
  assert.equal(one.data.game.shootout.away, 0);
  assert.equal(one.data.game.score.home, 0, 'a penalty never touches the scoreboard');
  assert.equal(one.data.game.events.at(-1).shootout, true);

  const two = await goal(game.id, 'away');
  assert.equal(two.data.game.shootout.away, 1);

  const back = await removePens(game.id, 'home');
  assert.equal(back.data.game.shootout.home, 0);
  const undo = await json(srv.base, 'POST', `/api/games/${game.id}/undo`, { body: {} });
  assert.equal(undo.data.game.shootout.home, 1, 'undo puts the taken-back penalty back');

  await removePens(game.id, 'away');
  const empty = await removePens(game.id, 'away');
  assert.equal(empty.status, 400, 'a team cannot go below zero penalties');
  assert.match(empty.data.error, /no penalty/i);

  const noClock = await clock(game.id, 'next');
  assert.equal(noClock.status, 200);
  assert.equal(noClock.data.game.period, 5, 'a shootout-only game stays in the shootout');
});

test('penalty shootouts are soccer only', async () => {
  const res = await json(srv.base, 'POST', '/api/quick-games', {
    body: { sport: 'basketball', homeName: 'Hoops', awayName: 'Rims', shootout: true }
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /soccer/i);
});

test('a knockout tie goes to penalties after extra time and keeps its own score', async () => {
  const created = await json(srv.base, 'POST', '/api/tournaments', {
    body: {
      name: 'Pens Cup',
      sport: 'soccer',
      teams: ['Alpha', 'Bravo', 'Charlie', 'Delta'],
      format: { groups: 1, groupStage: 'single', knockout: 'final', advancePerGroup: 2 }
    }
  });
  assert.equal(created.status, 201);
  const t = created.data.tournament;
  const teams = created.data.teams;
  const made = await json(srv.base, 'POST', `/api/tournaments/${t.id}/games`, {
    body: { homeTeamId: teams[0].id, awayTeamId: teams[1].id, stage: 'final', live: true }
  });
  assert.equal(made.status, 201);
  const gid = made.data.game.id;

  assert.equal((await clock(gid, 'next')).data.game.period, 2);
  assert.equal((await clock(gid, 'next')).data.game.period, 3);
  assert.equal((await clock(gid, 'next')).data.game.period, 4);
  const shootout = await clock(gid, 'next');
  assert.equal(shootout.data.game.period, 5);
  assert.equal(shootout.data.game.shootout.active, true);
  assert.equal(shootout.data.game.clock.running, false, 'the clock stops for penalties');

  const p1 = await goal(gid, 'home');
  const p2 = await goal(gid, 'home');
  const p3 = await goal(gid, 'away');
  assert.equal(p3.data.game.shootout.home, 2);
  assert.equal(p3.data.game.shootout.away, 1);
  assert.equal(p3.data.game.score.home, 0);
  assert.equal(p3.data.game.score.away, 0);

  const final = await json(srv.base, 'POST', `/api/games/${gid}/score`, {
    body: { home: 1, away: 1, final: true, pens: { home: 4, away: 3 } }
  });
  assert.equal(final.status, 200);
  assert.equal(final.data.game.status, 'final');
  assert.equal(final.data.game.score.home, 1);
  assert.equal(final.data.game.shootout.home, 4);

  const back = await json(srv.base, 'POST', `/api/games/${gid}/clock`, { body: { action: 'prev' } });
  assert.equal(back.data.game.shootout.active, false, 'going back leaves the shootout');
  assert.equal(back.data.game.period, 4);
  void p1; void p2;
});

test('a group game still just moves on to another half', async () => {
  const created = await json(srv.base, 'POST', '/api/tournaments', {
    body: {
      name: 'Group Cup',
      sport: 'soccer',
      teams: ['Echo', 'Foxtrot', 'Golf'],
      format: { groups: 1, groupStage: 'single', knockout: 'final', advancePerGroup: 2 }
    }
  });
  const t = created.data.tournament;
  const teams = created.data.teams;
  const made = await json(srv.base, 'POST', `/api/tournaments/${t.id}/games`, {
    body: { homeTeamId: teams[0].id, awayTeamId: teams[1].id, stage: 'group' }
  });
  assert.equal(made.status, 201);
  const gid = made.data.game.id;
  await clock(gid, 'next');
  await clock(gid, 'next');
  const extra = await clock(gid, 'next');
  assert.equal(extra.data.game.period, 4);
  assert.equal(extra.data.game.shootout.active, false);
  const goalRes = await goal(gid, 'home');
  assert.equal(goalRes.data.game.score.home, 1, 'an extra-time goal still counts on the scoreboard');
});

test('an admin can delete a game, a viewer cannot', async () => {
  const quick = await json(srv.base, 'POST', '/api/quick-games', {
    body: { sport: 'soccer', homeName: 'Delete FC', awayName: 'Gone United' }
  });
  assert.equal(quick.status, 201);
  const game = quick.data.game;

  await json(srv.base, 'POST', '/api/users', {
    body: { username: 'delete-viewer', password: 'watch123', role: 'viewer' }
  });
  const viewer = await login(srv.base, 'delete-viewer', 'watch123');
  assert.equal(viewer.status, 200);
  const denied = await json(srv.base, 'DELETE', `/api/games/${game.id}`, { cookie: viewer.cookie });
  assert.equal(denied.status, 403, 'a viewer cannot delete a game');

  const ok = await json(srv.base, 'DELETE', `/api/games/${game.id}`);
  assert.equal(ok.status, 200);
  const gone = await json(srv.base, 'GET', `/api/games/${game.id}`);
  assert.equal(gone.status, 404);
  const tournament = await json(srv.base, 'GET', `/api/tournaments/${game.tournamentId}`);
  assert.equal(tournament.status, 404, 'a one-game quick tournament goes with its last game');

  const missing = await json(srv.base, 'DELETE', `/api/games/${game.id}`);
  assert.equal(missing.status, 404, 'deleting a game twice is a clean 404');
});
