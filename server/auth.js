'use strict';

const crypto = require('crypto');
const { newId } = require('./store');

const COOKIE = 'mid_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const ROLES = new Set(['admin', 'viewer']);
const MIN_PASSWORD = 6;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(user, password) {
  if (!user || !user.salt || !user.hash) return false;
  const given = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const expected = Buffer.from(user.hash, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name) out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Accounts and sessions. Passwords are scrypt hashes; sessions live in memory,
 * so a restart asks everyone to sign in again.
 */
function createAuth({ store }) {
  const sessions = new Map();
  const attempts = new Map();

  function createUser({ username, password, role = 'viewer', createdBy = '' }) {
    const name = String(username || '').trim();
    if (name.length < 3 || name.length > 40) return { error: 'Username must be 3 to 40 characters' };
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) return { error: 'Username can use letters, numbers and . _ / -' };
    if (String(password || '').length < MIN_PASSWORD) return { error: `Password must be at least ${MIN_PASSWORD} characters` };
    if (!ROLES.has(role)) return { error: 'Role must be admin or viewer' };
    if (store.userByName(name)) return { error: 'That username is taken', status: 409 };
    const { salt, hash } = hashPassword(password);
    const user = {
      id: newId('us'),
      username: name,
      role,
      salt,
      hash,
      createdAt: Date.now(),
      createdBy
    };
    store.insert('users', user);
    return { user };
  }

  function setPassword(user, password) {
    if (String(password || '').length < MIN_PASSWORD) return { error: `Password must be at least ${MIN_PASSWORD} characters` };
    const { salt, hash } = hashPassword(password);
    user.salt = salt;
    user.hash = hash;
    user.updatedAt = Date.now();
    store.save();
    // Any other browser signed in as this account must sign in again.
    for (const [token, session] of sessions) {
      if (session.userId === user.id) sessions.delete(token);
    }
    return { user };
  }

  /** Drop every session of an account, so a deleted user is out at once. */
  function revokeUser(userId) {
    for (const [token, session] of sessions) {
      if (session.userId === userId) sessions.delete(token);
    }
  }

  function tooManyAttempts(ip) {
    const entry = attempts.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.first > ATTEMPT_WINDOW_MS) {
      attempts.delete(ip);
      return false;
    }
    return entry.count >= MAX_ATTEMPTS;
  }

  function noteAttempt(ip, ok) {
    if (ok) {
      attempts.delete(ip);
      return;
    }
    const entry = attempts.get(ip);
    if (!entry) attempts.set(ip, { count: 1, first: Date.now() });
    else entry.count += 1;
  }

  function startSession(res, user) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { userId: user.id, createdAt: Date.now() });
    res.append('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
    return token;
  }

  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) sessions.delete(token);
    res.append('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  }

  function sessionUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(token);
      return null;
    }
    const user = store.user(session.userId);
    if (!user) {
      sessions.delete(token);
      return null;
    }
    return user;
  }

  /** Attaches req.user when a valid session cookie is present. */
  function loadUser(req, res, next) {
    req.user = sessionUser(req) || null;
    next();
  }

  function requireUser(req, res, next) {
    if (!req.user) {
      res.status(401).json({ error: 'Please sign in' });
      return;
    }
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user) {
      res.status(401).json({ error: 'Please sign in' });
      return;
    }
    if (req.user.role !== 'admin') {
      res.status(403).json({ error: 'Only an admin can do that' });
      return;
    }
    next();
  }

  // The first admin is seeded once; env vars let a deployment pick its own.
  function ensureBootstrapAdmin() {
    if (store.users.some(u => u.role === 'admin')) return null;
    const username = process.env.ADMIN_USERNAME || 'higuy14/cool';
    const password = process.env.ADMIN_PASSWORD || 'favgame1';
    const existing = store.userByName(username);
    if (existing) {
      existing.role = 'admin';
      const { salt, hash } = hashPassword(password);
      existing.salt = salt;
      existing.hash = hash;
      store.save();
      return existing;
    }
    const { user } = createUser({ username, password, role: 'admin', createdBy: 'setup' });
    return user || null;
  }

  return {
    COOKIE,
    MIN_PASSWORD,
    createUser,
    setPassword,
    revokeUser,
    verifyPassword,
    publicUser,
    parseCookies,
    sessionUser,
    startSession,
    endSession,
    loadUser,
    requireUser,
    requireAdmin,
    tooManyAttempts,
    noteAttempt,
    ensureBootstrapAdmin
  };
}

module.exports = { createAuth, publicUser, parseCookies, MIN_PASSWORD };
