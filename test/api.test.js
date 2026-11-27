'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, json, login, setDefaultCookie } = require('./helpers');

const PORT = 4611;
let srv;

test.before(async () => {
  srv = await startServer(PORT);
  const admin = await login(srv.base, 'higuy14/cool', 'favgame1');
  assert.equal(admin.status, 200, 'the bootstrap admin can sign in');
  setDefaultCookie(admin.cookie);
});
test.after(async () => { await srv.close(); });

async function makeTournament(sport = 'soccer', name = 'Test Cup') {
  const res = await json(srv.base, 'POST', '/api/tournaments', { body: { name, sport } });
  assert.equal(res.status, 201);
  return { id: res.data.tournament.id, tournament: res.data.tournament };
}

async function addTeams(t, names) {
  const teams = [];
  for (const name of names) {
    const res = await json(srv.base, 'POST', `/api/tournaments/${t.id}/teams`, {
      key: t.key, body: { name }
    });
    assert.equal(res.status, 201, `team ${name}`);
    teams.push(res.data.team);
  }
  return teams;
}

test('health reports both sports', async () => {
  const res = await json(srv.base, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.sport.sort(), ['basketball', 'soccer']);
});

test('nothing hands out legacy owner keys', async () => {
  const t = await makeTournament('soccer', 'Key Cup');
  const list = await json(srv.base, 'GET', '/api/tournaments');
  const one = await json(srv.base, 'GET', `/api/tournaments/${t.id}`);
  for (const body of [list.text, one.text]) {
    assert.ok(!body.includes('ownerKey'), 'no owner key in public payloads');
    assert.ok(!body.includes('ownerHash'), 'no owner hash in public payloads');
  }
});

test('writes need a signed-in admin', async () => {
  const t = await makeTournament();
  const anonTeam = await json(srv.base, 'POST', `/api/tournaments/${t.id}/teams`, {
    anonymous: true, body: { name: 'Anon FC' }
  });
  assert.equal(anonTeam.status, 401);
  const anonRename = await json(srv.base, 'PATCH', `/api/tournaments/${t.id}`, {
    anonymous: true, body: { name: 'Intruder FC' }
  });
  assert.equal(anonRename.status, 401);
  const ok = await json(srv.base, 'PATCH', `/api/tournaments/${t.id}`, { body: { name: 'Renamed Cup' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.tournament.name, 'Renamed Cup');
});

test('validation refuses bad input instead of crashing', async () => {
  assert.equal((await json(srv.base, 'POST', '/api/tournaments', { body: { name: '', sport: 'soccer' } })).status, 400);
  assert.equal((await json(srv.base, 'POST', '/api/tournaments', { body: { name: 'X', sport: 'tennis' } })).status, 400);
  const longName = await json(srv.base, 'POST', '/api/tournaments', { body: { name: 'x'.repeat(500), sport: 'soccer' } });
  assert.equal(longName.status, 201);
  assert.equal(longName.data.tournament.name.length, 60, 'over-long names are trimmed, not stored whole');

  const bad = await json(srv.base, 'POST', '/api/tournaments', { raw: '{not json', body: undefined });
  assert.equal(bad.status, 400);
  assert.match(bad.type, /application\/json/);

  assert.equal((await json(srv.base, 'GET', '/api/tournaments/tr_nope')).status, 404);
  const unknown = await json(srv.base, 'GET', '/api/does-not-exist');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error, 'Not found');
});

test('fixtures create a full single round robin', async () => {
  const t = await makeTournament('soccer', 'Fixture Cup');
  await addTeams(t, ['Alpha', 'Bravo', 'Charlie', 'Delta']);
  const res = await json(srv.base, 'POST', `/api/tournaments/${t.id}/fixtures`, { key: t.key, body: {} });
  assert.equal(res.status, 201);
  assert.equal(res.data.count, 6, '4 teams => 6 games');

  const again = await json(srv.base, 'POST', `/api/tournaments/${t.id}/fixtures`, { key: t.key, body: {} });
  assert.equal(again.status, 409, 'does not stack a second schedule');

  const page = await json(srv.base, 'GET', `/api/tournaments/${t.id}`);
  assert.equal(page.data.games.length, 6);
  const pairs = new Set(page.data.games.map(g => [g.homeTeamId, g.awayTeamId].sort().join('-')));
  assert.equal(pairs.size, 6, 'every pairing appears exactly once');
});

test('a tournament is created with 3 to 80 teams and a format', async () => {
  const body = {
    name: 'Wizard Cup',
    sport: 'soccer',
    teams: ['Alpha', 'Bravo', 'Charlie'],
    format: { groups: 1, groupStage: 'single', knockout: 'final', advancePerGroup: 2 }
  };
  const res = await json(srv.base, 'POST', '/api/tournaments', { body });
  assert.equal(res.status, 201);
  assert.equal(res.data.teams.length, 3);
  assert.equal(res.data.games.length, 3, 'three teams play a single round robin');
  assert.equal(res.data.tournament.format.knockout, 'final');
  assert.ok(res.data.games.every(g => g.stage === 'group'));
  assert.ok(res.data.games.every(g => /^Round \d+$/.test(g.round)));

  const duplicate = await json(srv.base, 'POST', '/api/tournaments', {
    body: { ...body, teams: ['Same', 'same', 'Other'] }
  });
  assert.equal(duplicate.status, 400);
  const tooFew = await json(srv.base, 'POST', '/api/tournaments', {
    body: { ...body, teams: ['One', 'Two'] }
  });
  assert.equal(tooFew.status, 400);
  const tooMany = await json(srv.base, 'POST', '/api/tournaments', {
    body: { ...body, teams: Array.from({ length: 81 }, (_, i) => `Team ${i}`) }
  });
  assert.equal(tooMany.status, 400);
});

test('the maximum of 80 teams is grouped into a workable schedule', async () => {
  const teams = Array.from({ length: 80 }, (_, i) => `Team ${String(i + 1).padStart(2, '0')}`);
  const res = await json(srv.base, 'POST', '/api/tournaments', {
    body: {
      name: 'Eighty Cup',
      sport: 'basketball',
      teams,
      format: { groups: 16, groupStage: 'single', knockout: 'quarterfinal', advancePerGroup: 2 }
    }
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.teams.length, 80);
  assert.equal(res.data.games.length, 160, '16 groups of five, single round robin');
  assert.ok(res.data.games.every(g => g.stage === 'group'));
});

test('knockout stages are limited to the chosen format and can be created by hand', async () => {
  const res = await json(srv.base, 'POST', '/api/tournaments', {
    body: {
      name: 'Stage Cup',
      sport: 'soccer',
      teams: ['Alpha', 'Bravo', 'Charlie', 'Delta'],
      format: { groups: 1, groupStage: 'single', knockout: 'final', advancePerGroup: 2 }
    }
  });
  assert.equal(res.status, 201);
  const t = { id: res.data.tournament.id };
  const teams = res.data.teams;
  const final = await json(srv.base, 'POST', `/api/tournaments/${t.id}/games`, {
    key: t.key,
    body: { homeTeamId: teams[0].id, awayTeamId: teams[1].id, stage: 'final' }
  });
  assert.equal(final.status, 201);
  assert.equal(final.data.game.stage, 'final');
  assert.equal(final.data.game.round, 'Final');

  const quarter = await json(srv.base, 'POST', `/api/tournaments/${t.id}/games`, {
    key: t.key,
    body: { homeTeamId: teams[0].id, awayTeamId: teams[2].id, stage: 'qf' }
  });
  assert.equal(quarter.status, 400);
  assert.match(quarter.data.error, /Quarterfinal/);
});

test('a quick game exists outside a tournament and can start live', async () => {
  const res = await json(srv.base, 'POST', '/api/quick-games', {
    body: { sport: 'basketball', homeName: 'Downtown', awayName: 'Uptown', live: true }
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.game.status, 'live');
  assert.equal(res.data.game.clock.running, true);
  assert.equal(res.data.tournament.quick, true);

  const list = await json(srv.base, 'GET', '/api/quick-games');
  assert.equal(list.status, 200);
  assert.ok(list.data.games.some(row => row.game.id === res.data.game.id));
  assert.ok(list.data.games.every(row => row.game.tournamentName === row.tournament.name));

  const same = await json(srv.base, 'POST', '/api/quick-games', {
    body: { sport: 'soccer', homeName: 'Same', awayName: 'same' }
  });
  assert.equal(same.status, 400);
});

test('a final score can be saved and finishes the game in one request', async () => {
  const res = await json(srv.base, 'POST', '/api/quick-games', {
    body: { sport: 'soccer', homeName: 'Riverside', awayName: 'Northside', live: true }
  });
  assert.equal(res.status, 201);
  const game = res.data.game;
  const saved = await json(srv.base, 'POST', `/api/games/${game.id}/score`, {
    key: res.data.ownerKey,
    body: { home: 3, away: 1, final: true }
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.game.score, { home: 3, away: 1 });
  assert.equal(saved.data.game.status, 'final');
  assert.equal(saved.data.game.clock.running, false);

  const bad = await json(srv.base, 'POST', `/api/games/${game.id}/score`, {
    key: res.data.ownerKey,
    body: { home: 1, away: 0, final: 'yes' }
  });
  assert.equal(bad.status, 400);
});

test('soccer scoring, undo and the clock behave', async () => {
  const t = await makeTournament('soccer', 'Score Cup');
  const [home, away] = await addTeams(t, ['Home FC', 'Away FC']);
  const created = await json(srv.base, 'POST', `/api/tournaments/${t.id}/games`, {
    key: t.key, body: { homeTeamId: home.id, awayTeamId: away.id, venue: 'Main Pitch' }
  });
  assert.equal(created.status, 201);
  const gid = created.data.game.id;

  const goal = await json(srv.base, 'POST', `/api/games/${gid}/events`, {
    key: t.key, body: { type: 'goal', side: 'home' }
  });
  assert.equal(goal.status, 200);
  assert.equal(goal.data.game.score.home, 1);
  assert.equal(goal.data.game.status, 'live');
  assert.equal(goal.data.game.events.length, 1);

  const own = await json(srv.base, 'POST', `/api/games/${gid}/events`, {
    key: t.key, body: { type: 'own_goal', side: 'away' }
  });
  assert.equal(own.data.game.score.home, 2, 'own goal by away credits home');

  const undo = await json(srv.base, 'POST', `/api/games/${gid}/undo`, { key: t.key });
  assert.equal(undo.data.game.score.home, 1);

  assert.equal((await json(srv.base, 'POST', `/api/games/${gid}/events`, { key: t.key, body: { type: 'goal', side: 'bench' } })).status, 400);
  assert.equal((await json(srv.base, 'POST', `/api/games/${gid}/events`, { key: t.key, body: { type: 'score', side: 'home', points: 2 } })).status, 400);

  const start = await json(srv.base, 'POST', `/api/games/${gid}/clock`, { key: t.key, body: { action: 'start' } });
  assert.equal(start.data.game.clock.running, true);
  await new Promise(r => setTimeout(r, 250));
  const running = await json(srv.base, 'GET', `/api/games/${gid}`);
  assert.ok(running.data.game.clock.elapsedMs >= 200, 'clock advances while running');

  const pause = await json(srv.base, 'POST', `/api/games/${gid}/clock`, { key: t.key, body: { action: 'pause' } });
  const frozen = pause.data.game.clock.elapsedMs;
  assert.equal(pause.data.game.clock.running, false);
  await new Promise(r => setTimeout(r, 150));
  const still = await json(srv.base, 'GET', `/api/games/${gid}`);
  assert.equal(still.data.game.clock.elapsedMs, frozen, 'paused clock stays put');

  const next = await json(srv.base, 'POST', `/api/games/${gid}/clock`, { key: t.key, body: { action: 'next' } });
  assert.equal(next.data.game.period, 2);
  assert.equal(next.data.game.clock.elapsedMs, 0);

  const final = await json(srv.base, 'PATCH', `/api/games/${gid}`, { key: t.key, body: { status: 'final' } });
  assert.equal(final.data.game.status, 'final');
  const blocked = await json(srv.base, 'POST', `/api/games/${gid}/events`, { key: t.key, body: { type: 'goal', side: 'home' } });
  assert.equal(blocked.status, 400, 'finished games cannot be scored');
  const reopen = await json(srv.base, 'PATCH', `/api/games/${gid}`, { key: t.key, body: { status: 'live' } });
  assert.equal(reopen.data.game.status, 'live');
});

test('a game can be created already live', async () => {
  const t = await makeTournament('soccer', 'Kickoff Cup');
  const [home, away] = await addTeams(t, ['Early FC', 'Late FC']);

  const created = await json(srv.base, 'POST', `/api/tournaments/${t.id}/games`, {
    key: t.key, body: { homeTeamId: home.id, awayTeamId: away.id, live: true, scheduledAt: '2030-01-01T12:00:00.000Z' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.game.status, 'live');
  assert.equal(created.data.game.clock.running, true, 'the clock starts with the game');
  assert.ok(created.data.game.scheduledAt <= Date.now(), 'a live game is dated now, not in the future');

  const live = await json(srv.base, 'GET', '/api/live');
  assert.ok(live.data.games.some(g => g.id === created.data.game.id), 'it shows up under live games');

  const scheduled = await json(srv.base, 'POST', `/api/tournaments/${t.id}/games`, {
    key: t.key, body: { homeTeamId: away.id, awayTeamId: home.id, live: false }
  });
  assert.equal(scheduled.data.game.status, 'scheduled');
  assert.equal(scheduled.data.game.clock.running, false);

  const invalid = await json(srv.base, 'POST', `/api/tournaments/${t.id}/games`, {
    key: t.key, body: { homeTeamId: home.id, awayTeamId: away.id, live: 'yes' }
  });
  assert.equal(invalid.status, 400, 'live must be a boolean');
});

test('basketball uses quarters and 1/2/3 point scores', async () => {
  const t = await makeTournament('basketball', 'Hoops Cup');
  const [home, away] = await addTeams(t, ['Kings', 'Storm']);
  const created = await json(srv.base, 'POST', `/api/tournaments/${t.id}/games`, {
    key: t.key, body: { homeTeamId: home.id, awayTeamId: away.id }
  });
  const gid = created.data.game.id;
  assert.equal(created.data.game.periodLengthMs, 10 * 60 * 1000);

  const three = await json(srv.base, 'POST', `/api/games/${gid}/events`, {
    key: t.key, body: { type: 'score', side: 'away', points: 3 }
  });
  assert.equal(three.data.game.score.away, 3);
  const free = await json(srv.base, 'POST', `/api/games/${gid}/events`, {
    key: t.key, body: { type: 'score', side: 'away', points: 1 }
  });
  assert.equal(free.data.game.score.away, 4);
  assert.equal((await json(srv.base, 'POST', `/api/games/${gid}/events`, { key: t.key, body: { type: 'score', side: 'away', points: 4 } })).status, 400);
  assert.equal((await json(srv.base, 'POST', `/api/games/${gid}/events`, { key: t.key, body: { type: 'yellow', side: 'away' } })).status, 400);

  const set = await json(srv.base, 'POST', `/api/games/${gid}/score`, { key: t.key, body: { home: 54, away: 49 } });
  assert.equal(set.data.game.score.home, 54);
  assert.equal((await json(srv.base, 'POST', `/api/games/${gid}/score`, { key: t.key, body: { home: -1, away: 3 } })).status, 400);
  assert.equal((await json(srv.base, 'POST', `/api/games/${gid}/score`, { key: t.key, body: { home: '5', away: 3 } })).status, 400);
});

test('a team with games cannot be deleted, an empty one can', async () => {
  const t = await makeTournament('soccer', 'Delete Cup');
  const [home, away, spare] = await addTeams(t, ['One', 'Two', 'Spare']);
  await json(srv.base, 'POST', `/api/tournaments/${t.id}/games`, {
    key: t.key, body: { homeTeamId: home.id, awayTeamId: away.id }
  });
  assert.equal((await json(srv.base, 'DELETE', `/api/teams/${home.id}`, { key: t.key })).status, 409);
  assert.equal((await json(srv.base, 'DELETE', `/api/teams/${spare.id}`, { key: t.key })).status, 200);
});

test('games cannot be created across tournaments or against themselves', async () => {
  const a = await makeTournament('soccer', 'A Cup');
  const b = await makeTournament('soccer', 'B Cup');
  const [a1, a2] = await addTeams(a, ['A1', 'A2']);
  const [b1] = await addTeams(b, ['B1']);
  const self = await json(srv.base, 'POST', `/api/tournaments/${a.id}/games`, {
    key: a.key, body: { homeTeamId: a1.id, awayTeamId: a1.id }
  });
  assert.equal(self.status, 400);
  const cross = await json(srv.base, 'POST', `/api/tournaments/${a.id}/games`, {
    key: a.key, body: { homeTeamId: a1.id, awayTeamId: b1.id }
  });
  assert.equal(cross.status, 400);
  const ok = await json(srv.base, 'POST', `/api/tournaments/${a.id}/games`, {
    key: a.key, body: { homeTeamId: a1.id, awayTeamId: a2.id }
  });
  assert.equal(ok.status, 201);
});

test('stream links accept http(s) only', async () => {
  const t = await makeTournament('soccer', 'Stream Cup');
  const [home, away] = await addTeams(t, ['S1', 'S2']);
  const g = await json(srv.base, 'POST', `/api/tournaments/${t.id}/games`, {
    key: t.key, body: { homeTeamId: home.id, awayTeamId: away.id }
  });
  const gid = g.data.game.id;
  assert.equal((await json(srv.base, 'POST', `/api/games/${gid}/stream`, { key: t.key, body: { url: 'javascript:alert(1)' } })).status, 400);
  const ok = await json(srv.base, 'POST', `/api/games/${gid}/stream`, { key: t.key, body: { url: 'https://example.com/watch?v=abc' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.game.streamUrl, 'https://example.com/watch?v=abc');
});

test('the app shell is served for client routes but not for api routes', async () => {
  const page = await json(srv.base, 'GET', '/t/tr_123');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.text, /id="app"/);
  assert.match(page.text, /viewport/, 'page declares a mobile viewport');
});
