'use strict';

const express = require('express');

/**
 * Sign-in, session and account management. Mounted at /api before the
 * data routes so login does not need a session of its own.
 */
function createAuthApi({ auth, store }) {
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));

  const bad = (res, message, status = 400) => {
    res.status(status).json({ error: message });
    return null;
  };

  router.post('/auth/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (auth.tooManyAttempts(ip)) return bad(res, 'Too many attempts. Try again in a few minutes.', 429);

    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim().slice(0, 40) : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    if (!username || !password) return bad(res, 'Enter your username and password');

    const user = store.userByName(username);
    if (!user || !auth.verifyPassword(user, password)) {
      auth.noteAttempt(ip, false);
      return bad(res, 'Wrong username or password', 401);
    }
    auth.noteAttempt(ip, true);
    auth.startSession(res, user);
    res.json({ user: auth.publicUser(user) });
  });

  router.post('/auth/logout', (req, res) => {
    auth.endSession(req, res);
    res.json({ ok: true });
  });

  router.get('/auth/me', auth.requireUser, (req, res) => {
    res.json({ user: auth.publicUser(req.user) });
  });

  router.post('/auth/password', auth.requireUser, (req, res) => {
    const body = req.body || {};
    if (!auth.verifyPassword(req.user, String(body.current || ''))) {
      return bad(res, 'Your current password is not right', 403);
    }
    const result = auth.setPassword(req.user, body.password);
    if (result.error) return bad(res, result.error);
    auth.endSession(req, res);
    auth.startSession(res, req.user);
    res.json({ ok: true, user: auth.publicUser(req.user) });
  });

  // ------------------------------------------------------------- accounts
  router.get('/users', auth.requireAdmin, (req, res) => {
    res.json({ users: store.users.map(auth.publicUser) });
  });

  router.post('/users', auth.requireAdmin, (req, res) => {
    const body = req.body || {};
    const role = body.role === 'admin' ? 'admin' : 'viewer';
    const result = auth.createUser({
      username: body.username,
      password: body.password,
      role,
      createdBy: req.user.id
    });
    if (result.error) return bad(res, result.error, result.status || 400);
    res.status(201).json({ user: auth.publicUser(result.user) });
  });

  router.delete('/users/:id', auth.requireAdmin, (req, res) => {
    const user = store.user(req.params.id);
    if (!user) return bad(res, 'Account not found', 404);
    if (user.id === req.user.id) return bad(res, 'You cannot delete your own account');
    if (user.role === 'admin' && store.users.filter(u => u.role === 'admin').length < 2) {
      return bad(res, 'Keep at least one admin account');
    }
    store.remove('users', user.id);
    auth.revokeUser(user.id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createAuthApi };
