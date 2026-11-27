'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startServer, json, login, setDefaultCookie } = require('./helpers');

const PORT = 4612;
let srv;
let wsCookie = null;

test.before(async () => {
  srv = await startServer(PORT);
  const admin = await login(srv.base, 'higuy14/cool', 'favgame1');
  setDefaultCookie(admin.cookie);
  wsCookie = admin.cookie;
});
test.after(async () => { await srv.close(); });

class Client {
  constructor(url, cookie = wsCookie) {
    this.ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
    this.messages = [];
    this.waiters = [];
    this.ws.on('message', raw => {
      const msg = JSON.parse(String(raw));
      this.messages.push(msg);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(msg)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(msg);
        }
      }
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  waitFor(type, predicate = () => true, timeout = 3000) {
    const existing = this.messages.find(m => m.type === type && predicate(m));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: m => m.type === type && predicate(m),
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting for ${type}; got ${JSON.stringify(this.messages.map(m => m.type))}`));
        }, timeout)
      };
      this.waiters.push(waiter);
    });
  }
  close() { this.ws.close(); }
}

async function seedGame() {
  const t = await json(srv.base, 'POST', '/api/tournaments', { body: { name: 'Live Cup', sport: 'basketball' } });
  const id = t.data.tournament.id;
  const key = undefined;
  const team = async name => (await json(srv.base, 'POST', `/api/tournaments/${id}/teams`, { key, body: { name } })).data.team;
  const home = await team('Home Hoops');
  const away = await team('Away Hoops');
  const game = await json(srv.base, 'POST', `/api/tournaments/${id}/games`, {
    key, body: { homeTeamId: home.id, awayTeamId: away.id }
  });
  return { tournamentId: id, key, gameId: game.data.game.id };
}

test('a socket without a session is closed with 1008', async () => {
  const anon = new WebSocket(srv.ws, {});
  const code = await new Promise(resolve => {
    anon.on('close', c => resolve(c));
    anon.on('error', () => {});
  });
  assert.equal(code, 1008);
});

test('viewers see live score updates pushed over the socket', async () => {
  const { gameId, key } = await seedGame();
  const a = new Client(srv.ws);
  const b = new Client(srv.ws);
  await Promise.all([a.open(), b.open()]);
  a.send({ type: 'subscribe', gameId });
  b.send({ type: 'subscribe', gameId });

  const helloB = await b.waitFor('hello');
  assert.equal(helloB.gameId, gameId);
  assert.equal(helloB.onAir, false);

  const scored = await json(srv.base, 'POST', `/api/games/${gameId}/events`, {
    key, body: { type: 'score', side: 'home', points: 2 }
  });
  assert.equal(scored.status, 200);

  const pushedA = await a.waitFor('game');
  const pushedB = await b.waitFor('game');
  assert.equal(pushedA.game.score.home, 2);
  assert.equal(pushedB.game.score.home, 2);

  a.close();
  b.close();
});

test('broadcast handshake, signalling relay and step-down', async () => {
  const { gameId } = await seedGame();
  const broadcaster = new Client(srv.ws);
  const watcher = new Client(srv.ws);
  await Promise.all([broadcaster.open(), watcher.open()]);
  broadcaster.send({ type: 'subscribe', gameId });
  watcher.send({ type: 'subscribe', gameId });
  const hello = await broadcaster.waitFor('hello');
  const watcherHello = await watcher.waitFor('hello');

  broadcaster.send({ type: 'broadcast', on: true });
  const self = await broadcaster.waitFor('onair', m => m.self === true);
  assert.equal(self.on, true);
  assert.deepEqual(self.viewerIds, [watcherHello.id]);
  assert.equal(self.viewers, 1);

  const seen = await watcher.waitFor('onair', m => !m.self);
  assert.equal(seen.on, true);
  assert.equal(seen.viewers, 1);

  // The broadcaster must not be told to become a viewer of its own stream.
  await new Promise(r => setTimeout(r, 150));
  assert.equal(broadcaster.messages.filter(m => m.type === 'onair' && !m.self).length, 0);

  watcher.send({ type: 'signal', to: hello.id, data: { kind: 'answer', sdp: 'fake' } });
  const signal = await broadcaster.waitFor('signal');
  assert.equal(signal.from !== undefined, true);
  assert.equal(signal.data.kind, 'answer');

  broadcaster.send({ type: 'broadcast', on: false });
  const off = await watcher.waitFor('onair', m => m.on === false);
  assert.equal(off.on, false);
  assert.ok(off.viewers >= 1, 'people in the room are still reported');

  broadcaster.close();
  watcher.close();
});

test('unknown games and garbage messages are refused', async () => {
  const c = new Client(srv.ws);
  await c.open();
  c.send({ type: 'subscribe', gameId: 'gm_missing' });
  const err = await c.waitFor('error');
  assert.equal(err.message, 'Game not found');

  c.ws.send('not json');
  const bad = await c.waitFor('error', m => m.message === 'Invalid message');
  assert.equal(bad.message, 'Invalid message');
  c.close();
});
