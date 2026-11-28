// Starts the offline edition. The rest of the app is the hosted app's code,
// unchanged: this file gives it a local database and answers /api calls
// inside the page instead of talking to a server.

import { Store } from './store.js';
import { createAuth } from './auth.js';
import { createBackend } from './backend.js';
import { publishGame } from '../live.js';
import { publicGame } from './gameplay.js';

const store = new Store();
const auth = createAuth({ store });
// Sockets get the same trimmed shape the hosted server broadcast.
const backend = createBackend({ store, auth, publishGame: game => publishGame(publicGame(game)) });

const realFetch = window.fetch.bind(window);

window.fetch = async function localFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  let parsed;
  try {
    parsed = new URL(url, location.href);
  } catch {
    return realFetch(input, init);
  }
  if (parsed.origin !== location.origin || !parsed.pathname.startsWith('/api/')) {
    return realFetch(input, init);
  }

  let body;
  if (init.body instanceof Blob) {
    body = init.body;
  } else if (typeof init.body === 'string' && init.body) {
    try { body = JSON.parse(init.body); } catch { body = {}; }
  }

  const result = await backend.handle(init.method || 'GET', parsed.pathname + parsed.search, body);
  if (result.blob) {
    return new Response(result.blob, {
      status: result.status,
      headers: { 'Content-Type': result.blob.type || 'video/webm', 'Cache-Control': 'no-store' }
    });
  }
  return new Response(JSON.stringify(result.data ?? null), {
    status: result.status,
    headers: { 'Content-Type': 'application/json' }
  });
};

// Closing the tab flushes the last recording with sendBeacon.
Object.defineProperty(navigator, 'sendBeacon', {
  configurable: true,
  value: (url, blob) => {
    const parsed = new URL(url, location.href);
    if (!parsed.pathname.startsWith('/api/')) return false;
    backend.handle('POST', parsed.pathname + parsed.search, blob).catch(() => {});
    return true;
  }
});

window.__matchdayLocal = { store, auth, backend };

await auth.seedAdmin();
await import('../main.js');
