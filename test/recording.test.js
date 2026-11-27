'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, json, login, setDefaultCookie } = require('./helpers');

const PORT = 4616;
// A tiny stand-in for the webm the browser uploads after a broadcast.
const VIDEO = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 7)]);

let srv;
let adminCookie;
let viewerCookie;
let gameId;

test.before(async () => {
  srv = await startServer(PORT);
  const admin = await login(srv.base, 'higuy14/cool', 'favgame1');
  assert.equal(admin.status, 200);
  adminCookie = admin.cookie;
  setDefaultCookie(adminCookie);

  const game = await json(srv.base, 'POST', '/api/quick-games', {
    body: { sport: 'soccer', homeName: 'Film FC', awayName: 'Replay Rovers' }
  });
  assert.equal(game.status, 201);
  gameId = game.data.game.id;
  assert.equal(game.data.game.recording, null, 'a new game has no recording');

  const made = await json(srv.base, 'POST', '/api/users', {
    body: { username: 'rewatch', password: 'watch123', role: 'viewer' }
  });
  assert.equal(made.status, 201);
  viewerCookie = (await login(srv.base, 'rewatch', 'watch123')).cookie;
});

test.after(async () => { await srv.close(); });

async function upload(cookie, { method = 'PUT', gid = gameId } = {}) {
  const headers = { 'content-type': 'video/webm' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${srv.base}/api/games/${gid}/recording?duration=95`, { method, headers, body: VIDEO });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function download(cookie) {
  const headers = cookie ? { cookie } : {};
  return fetch(`${srv.base}/api/games/${gameId}/recording`, { headers });
}

test('only a signed-in organizer can upload a recording', async () => {
  const anon = await upload(null);
  assert.equal(anon.status, 401, 'no account, no upload');
  assert.equal((await download(null)).status, 401, 'no account, no video');

  const viewer = await upload(viewerCookie);
  assert.equal(viewer.status, 403, 'a viewer cannot replace the recording');
});

test('the organizer saves the broadcast and a viewer can watch it afterwards', async () => {
  const saved = await upload(adminCookie);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.game.recording.available, true);
  assert.equal(saved.data.game.recording.duration, 95);
  assert.equal(saved.data.game.recording.size, VIDEO.length);

  const game = await json(srv.base, 'GET', `/api/games/${gameId}`, { cookie: viewerCookie });
  assert.equal(game.status, 200);
  assert.equal(game.data.game.recording.available, true, 'the recording is listed on the game');

  const res = await download(viewerCookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /video\/webm/);
  assert.equal(res.headers.get('accept-ranges'), 'bytes', 'the player can seek');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, VIDEO.length);
  assert.deepEqual(body.subarray(0, 4), VIDEO.subarray(0, 4));

  const ranged = await fetch(`${srv.base}/api/games/${gameId}/recording`, {
    headers: { cookie: viewerCookie, range: 'bytes=0-99' }
  });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);

  // sendBeacon on page close arrives as POST.
  const beacon = await upload(adminCookie, { method: 'POST' });
  assert.equal(beacon.status, 200);
});

test('a game without a recording says so', async () => {
  const other = await json(srv.base, 'POST', '/api/quick-games', {
    body: { sport: 'basketball', homeName: 'Hoop A', awayName: 'Hoop B' }
  });
  const res = await fetch(`${srv.base}/api/games/${other.data.game.id}/recording`, { headers: { cookie: viewerCookie } });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /no recording/i);
});

test('deleting a game removes its recording too', async () => {
  assert.equal((await upload(adminCookie)).status, 200);
  const del = await json(srv.base, 'DELETE', `/api/games/${gameId}`, { cookie: adminCookie });
  assert.equal(del.status, 200);
  assert.equal((await download(adminCookie)).status, 404, 'the video went with the game');
});
