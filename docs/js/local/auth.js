// Accounts for the offline edition. Passwords are PBKDF2-SHA256 hashes kept in
// this browser only; the session is a user id in localStorage.

import { newId } from './store.js';

const SESSION_KEY = 'matchday.session.v1';
const MIN_PASSWORD = 6;
const ROLES = new Set(['admin', 'viewer']);
const ITERATIONS = 120000;

const encoder = new TextEncoder();

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return toHex(bits);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}

export function createAuth({ store }) {
  function currentUser() {
    const id = localStorage.getItem(SESSION_KEY);
    return id ? store.user(id) || null : null;
  }

  function setSession(user) {
    if (user) localStorage.setItem(SESSION_KEY, user.id);
    else localStorage.removeItem(SESSION_KEY);
  }

  async function login(username, password) {
    const name = typeof username === 'string' ? username.trim().slice(0, 40) : '';
    const pass = typeof password === 'string' ? password.slice(0, 200) : '';
    if (!name || !pass) return { error: 'Enter your username and password' };
    const user = store.userByName(name);
    if (!user) return { error: 'Wrong username or password', status: 401 };
    const hash = await hashPassword(pass, user.salt);
    if (!safeEqual(hash, user.hash)) return { error: 'Wrong username or password', status: 401 };
    setSession(user);
    return { user };
  }

  async function createUser({ username, password, role = 'viewer', createdBy = '' }) {
    const name = String(username || '').trim();
    if (name.length < 3 || name.length > 40) return { error: 'Username must be 3 to 40 characters' };
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) return { error: 'Username can use letters, numbers and . _ / -' };
    if (String(password || '').length < MIN_PASSWORD) return { error: `Password must be at least ${MIN_PASSWORD} characters` };
    if (!ROLES.has(role)) return { error: 'Role must be admin or viewer' };
    if (store.userByName(name)) return { error: 'That username is taken', status: 409 };
    const salt = randomSalt();
    const user = {
      id: newId('us'),
      username: name,
      role,
      salt,
      hash: await hashPassword(password, salt),
      createdAt: Date.now(),
      createdBy
    };
    store.insert('users', user);
    return { user };
  }

  async function setPassword(user, password) {
    if (String(password || '').length < MIN_PASSWORD) return { error: `Password must be at least ${MIN_PASSWORD} characters` };
    user.salt = randomSalt();
    user.hash = await hashPassword(password, user.salt);
    user.updatedAt = Date.now();
    store.save();
    return { user };
  }

  /** First run: one admin account so the app is usable straight away. */
  async function seedAdmin() {
    if (store.users.length) return;
    await createUser({ username: 'higuy14/cool', password: 'favgame1', role: 'admin' });
  }

  return { currentUser, login, logout: () => setSession(null), setSession, createUser, setPassword, seedAdmin };
}
