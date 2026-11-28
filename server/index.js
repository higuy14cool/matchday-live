'use strict';

const http = require('http');
const path = require('path');
const express = require('express');

const { Store } = require('./store');
const { createLiveHub } = require('./live');
const { createApi } = require('./api');
const { createAuth } = require('./auth');
const { createAuthApi } = require('./auth-api');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const store = new Store();
const auth = createAuth({ store });
auth.ensureBootstrapAdmin();
const hub = createLiveHub(store, { auth });
const app = express();

app.disable('x-powered-by');
// Hosts (Render, Railway, Fly) terminate TLS in front of us: trust one hop so
// req.ip and protocol come from the real client.
if (process.env.TRUST_PROXY !== '0') app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(auth.loadUser);
app.use('/api', createAuthApi({ auth, store }));
app.use('/api', createApi({ store, hub, auth }));
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: 0, extensions: ['html'] }));

// Client-side routing: hand every non-API path to the app shell.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Malformed JSON and other API-side failures answer in JSON, never HTML.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

const server = http.createServer(app);
hub.attach(server);

server.listen(PORT, HOST, () => {
  console.log(`Matchday Live running on http://localhost:${PORT} (${store.users.length} account(s))`);
});

function shutdown() {
  store.flush();
  hub.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
  store.flush();
  process.exit(1);
});
