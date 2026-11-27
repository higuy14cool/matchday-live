'use strict';

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const MAX_MESSAGE_BYTES = 128 * 1024;
const RATE_LIMIT = 120; // messages per 10s window

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function createLiveHub(store, { auth } = {}) {
  const connections = new Map(); // connId -> conn
  const rooms = new Map();       // gameId -> Set<connId>
  const onAir = new Map();       // gameId -> connId of broadcaster
  let wss = null;

  function roomIds(gameId) {
    return rooms.get(gameId) || new Set();
  }

  function viewerCount(gameId) {
    return [...roomIds(gameId)].filter(id => onAir.get(gameId) !== id).length;
  }

  function join(conn, gameId) {
    leave(conn);
    if (!store.game(gameId)) {
      send(conn.ws, { type: 'error', message: 'Game not found' });
      return;
    }
    conn.gameId = gameId;
    if (!rooms.has(gameId)) rooms.set(gameId, new Set());
    rooms.get(gameId).add(conn.id);

    send(conn.ws, {
      type: 'hello',
      id: conn.id,
      gameId,
      viewers: viewerCount(gameId),
      onAir: Boolean(onAir.get(gameId))
    });

    const broadcasterId = onAir.get(gameId);
    if (broadcasterId && broadcasterId !== conn.id) {
      const broadcaster = connections.get(broadcasterId);
      if (broadcaster) send(broadcaster.ws, { type: 'viewer-joined', viewerId: conn.id });
    }
    notifyPresence(gameId);
  }

  function leave(conn) {
    if (!conn.gameId) return;
    const gameId = conn.gameId;
    const set = rooms.get(gameId);
    if (set) {
      set.delete(conn.id);
      if (set.size === 0) rooms.delete(gameId);
    }
    if (onAir.get(gameId) === conn.id) {
      onAir.delete(gameId);
      roomBroadcast(gameId, { type: 'onair', on: false, viewers: viewerCount(gameId) });
    }
    conn.gameId = null;
    notifyPresence(gameId);
  }

  function notifyPresence(gameId) {
    roomBroadcast(gameId, {
      type: 'presence',
      viewers: viewerCount(gameId),
      onAir: Boolean(onAir.get(gameId))
    });
  }

  function roomBroadcast(gameId, payload) {
    for (const id of roomIds(gameId)) {
      const conn = connections.get(id);
      if (conn) send(conn.ws, payload);
    }
  }

  // Push a fresh game state to everyone watching that game.
  function broadcastGame(game) {
    roomBroadcast(game.id, { type: 'game', game });
  }

  function handleMessage(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(conn.ws, { type: 'error', message: 'Invalid message' });
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'subscribe':
        if (typeof msg.gameId === 'string') join(conn, msg.gameId);
        break;
      case 'unsubscribe':
        leave(conn);
        break;
      case 'broadcast': {
        if (!conn.gameId) return;
        const gameId = conn.gameId;
        if (msg.on) {
          const previous = onAir.get(gameId);
          if (previous && previous !== conn.id) {
            const old = connections.get(previous);
            if (old) send(old.ws, { type: 'onair', on: false, viewers: viewerCount(gameId) });
          }
          onAir.set(gameId, conn.id);
          send(conn.ws, {
            type: 'onair',
            on: true,
            self: true,
            viewers: viewerCount(gameId),
            viewerIds: [...roomIds(gameId)].filter(id => id !== conn.id)
          });
          // Everyone else hears about the stream; the broadcaster already knows.
          for (const id of roomIds(gameId)) {
            if (id === conn.id) continue;
            const watcher = connections.get(id);
            if (watcher) send(watcher.ws, { type: 'onair', on: true, viewers: viewerCount(gameId) });
          }
        } else if (onAir.get(gameId) === conn.id) {
          onAir.delete(gameId);
          roomBroadcast(gameId, { type: 'onair', on: false, viewers: viewerCount(gameId) });
        }
        break;
      }
      case 'signal': {
        // Relay WebRTC offers/answers/candidates between people watching the same game.
        if (!conn.gameId || typeof msg.to !== 'string') return;
        const target = connections.get(msg.to);
        if (!target || target.gameId !== conn.gameId) return;
        send(target.ws, { type: 'signal', from: conn.id, data: msg.data });
        break;
      }
      case 'ping':
        send(conn.ws, { type: 'pong' });
        break;
      default:
        break;
    }
  }

  function attach(server) {
    wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

    wss.on('connection', (ws, req) => {
      // Scores stream to signed-in viewers only.
      if (auth && !auth.sessionUser(req)) {
        ws.close(1008, 'Please sign in');
        return;
      }
      // Reject connections from other origins only when explicitly configured.
      const allowed = process.env.ALLOWED_ORIGIN;
      if (allowed && req.headers.origin && req.headers.origin !== allowed) {
        ws.close(1008, 'Origin not allowed');
        return;
      }

      const conn = { id: crypto.randomBytes(6).toString('hex'), ws, gameId: null, alive: true, budget: RATE_LIMIT };
      connections.set(conn.id, conn);
      send(ws, { type: 'welcome', id: conn.id });

      ws.on('message', data => {
        conn.budget -= 1;
        if (conn.budget < 0) {
          ws.close(1008, 'Too many messages');
          return;
        }
        handleMessage(conn, data.toString());
      });
      ws.on('pong', () => { conn.alive = true; });
      ws.on('close', () => {
        leave(conn);
        connections.delete(conn.id);
      });
      ws.on('error', () => {});
    });

    const heartbeat = setInterval(() => {
      for (const conn of connections.values()) {
        if (!conn.alive) { conn.ws.terminate(); continue; }
        conn.alive = false;
        conn.budget = RATE_LIMIT;
        try { conn.ws.ping(); } catch { /* socket already gone */ }
      }
    }, 30000);
    heartbeat.unref();

    wss.on('close', () => clearInterval(heartbeat));
    return wss;
  }

  return { attach, broadcastGame, viewerCount, close: () => wss && wss.close() };
}

module.exports = { createLiveHub };
