'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { newGame, applyEvent, clockAction, replayTimeline, publicGame } = require('../server/gameplay');

function goal(game, side, replayMs) {
  const error = applyEvent(game, { side, type: 'goal', player: 'P', replayMs });
  assert.equal(error, null);
}

function basket(game, side, points, replayMs) {
  const error = applyEvent(game, { side, type: 'score', points, player: 'P', replayMs });
  assert.equal(error, null);
}

test('a replay steps through the score at the second each goal happened', () => {
  const game = newGame({ id: 'g1', tournamentId: 't1', sport: 'soccer', homeTeamId: 'h', awayTeamId: 'a' });
  goal(game, 'home', 5000);
  goal(game, 'away', 12000);
  goal(game, 'home', 30000);

  const steps = replayTimeline(game);
  assert.deepEqual(steps.map(s => [s.t, s.home, s.away]), [[5000, 1, 0], [12000, 1, 1], [30000, 2, 1]]);
  assert.equal(steps.every(s => s.shots === false), true);
  assert.equal(steps.at(-1).home, game.score.home, 'the last step is the real score');
  assert.equal(steps.at(-1).away, game.score.away);
});

test('a penalty shootout only shows its score once the penalties start', () => {
  const game = newGame({ id: 'g2', tournamentId: 't1', sport: 'soccer', homeTeamId: 'h', awayTeamId: 'a', stage: 'sf', round: 'Semifinal' });
  assert.equal(clockAction(game, 'next'), null); // extra time
  assert.equal(clockAction(game, 'next'), null);
  goal(game, 'home', 1000);
  // Penalties are only available from the shootout period; the API forces this
  // through clock action, so set the period the way the server does.
  game.clock.period = 5;
  game.shootout.active = true;
  goal(game, 'home', 20000);
  goal(game, 'home', 26000);

  const steps = replayTimeline(game);
  assert.equal(steps.at(-1).shots, true);
  assert.equal(steps.at(-1).pensHome, 2);
  assert.equal(steps.at(-1).pensAway, 0);
  assert.equal(steps.at(-1).home, 1, 'a penalty does not add to the score');
  assert.equal(steps.find(s => s.t === 1000).shots, false, 'no shootout pill before the penalties');
});

test('a direct score edit resets the running score from that second', () => {
  const game = newGame({ id: 'g3', tournamentId: 't1', sport: 'basketball', homeTeamId: 'h', awayTeamId: 'a' });
  basket(game, 'home', 2, 2000);
  game.scoreSets = [{ at: Date.now(), replayMs: 9000, home: 10, away: 8, pensHome: null, pensAway: null, period: 2 }];
  game.score = { home: 10, away: 8 };
  basket(game, 'away', 3, 11000);

  const steps = replayTimeline(game);
  assert.deepEqual(steps.map(s => [s.t, s.home, s.away]), [[2000, 2, 0], [9000, 10, 8], [11000, 10, 11]]);
  assert.equal(steps.at(-1).period, 2, 'the period comes along with the score');
});

test('without a video offset the clock time since filming started is used', () => {
  const game = newGame({ id: 'g4', tournamentId: 't1', sport: 'soccer', homeTeamId: 'h', awayTeamId: 'a' });
  game.recording = { size: 2048, duration: 60, startedAt: Date.now() - 10000, savedAt: Date.now() };
  goal(game, 'home', undefined);
  const steps = replayTimeline(game);
  assert.equal(steps.length, 1);
  assert.ok(steps[0].t >= 9500 && steps[0].t <= 11000, `offset was ${steps[0].t}`);
});

test('a game with no timing at all keeps everything at zero and the public game exposes the timeline', () => {
  const game = newGame({ id: 'g5', tournamentId: 't1', sport: 'soccer', homeTeamId: 'h', awayTeamId: 'a' });
  goal(game, 'home', undefined);
  assert.equal(replayTimeline(game)[0].t, 0);
  const pub = publicGame(game);
  assert.ok(Array.isArray(pub.timeline));
  assert.equal(pub.timeline.length, 1);
  assert.equal(pub.timeline[0].home, 1);
});
