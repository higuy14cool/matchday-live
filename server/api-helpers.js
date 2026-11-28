'use strict';

/** Answers 403 itself when the caller is not an admin; true when they may act. */
function ensureAdmin(req, res) {
  if (req.user && req.user.role === 'admin') return true;
  res.status(req.user ? 403 : 401).json({ error: req.user ? 'Only an admin can do that' : 'Please sign in' });
  return false;
}

function bad(res, message, status = 400) {
  res.status(status).json({ error: message });
  return null;
}

function str(value, max = 80) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function color(value, fallback = '#9ae64b') {
  return /^#[0-9a-fA-F]{6}$/.test(value || '') ? value : fallback;
}

function optionalDate(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function httpUrl(value) {
  const url = str(value, 500);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** A backup file is only accepted when every collection still looks like ours. */
function checkBackup(data) {
  if (!data || typeof data !== 'object') return { error: 'This file is not a Matchday backup' };
  const out = { version: 1 };
  for (const key of ['users', 'tournaments', 'teams', 'games']) {
    const list = data[key];
    if (!Array.isArray(list)) return { error: `The backup has no "${key}" list` };
    if (list.length > 5000) return { error: `The backup has too many ${key}` };
    for (const row of list) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) {
        return { error: `The backup has a broken ${key} entry` };
      }
    }
    out[key] = list;
  }
  if (!out.users.some(u => u && u.role === 'admin')) {
    return { error: 'A backup needs at least one admin account' };
  }
  return { data: out };
}

module.exports = { ensureAdmin, bad, str, color, optionalDate, httpUrl, checkBackup };
