'use strict';

const { checkOwner } = require('./store');

function ownerKey(req) {
  return req.get('x-owner-key') || '';
}

/** Answers 403 itself when the key is wrong; returns true when the caller may act. */
function ensureOwner(tournament, req, res) {
  if (!checkOwner(tournament, ownerKey(req))) {
    res.status(403).json({ error: 'This action needs the tournament owner key' });
    return false;
  }
  return true;
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

module.exports = { ownerKey, ensureOwner, bad, str, color, optionalDate, httpUrl };
