'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

async function startServer(port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matchday-test-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 8000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('running on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}): ${output}`));
    });
  });

  return {
    base: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}/ws`,
    dataDir,
    async close() {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

let defaultCookie = null;

function setDefaultCookie(cookie) {
  defaultCookie = cookie;
}

async function login(base, username, password) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const header = setCookies[0] || res.headers.get('set-cookie') || '';
  const data = await res.json().catch(() => null);
  return { status: res.status, data, cookie: header.split(';')[0] };
}

async function json(base, method, urlPath, { body, cookie, anonymous = false, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const jar = anonymous ? null : cookie !== undefined ? cookie : defaultCookie;
  if (jar) headers.cookie = jar;
  const res = await fetch(base + urlPath, {
    method,
    headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, data, text, type: res.headers.get('content-type') || '' };
}

module.exports = { startServer, json, login, setDefaultCookie };
