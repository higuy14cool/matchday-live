const KEY_STORAGE = 'matchday.ownerKeys.v1';

function readKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY_STORAGE) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeKeys(keys) {
  try {
    localStorage.setItem(KEY_STORAGE, JSON.stringify(keys));
  } catch {
    /* storage can be unavailable in private modes */
  }
}

export function getOwnerKey(tournamentId) {
  return readKeys()[tournamentId] || '';
}

export function setOwnerKey(tournamentId, key) {
  const keys = readKeys();
  keys[tournamentId] = key;
  writeKeys(keys);
}

export function forgetOwnerKey(tournamentId) {
  const keys = readKeys();
  delete keys[tournamentId];
  writeKeys(keys);
}

async function request(path, { method = 'GET', body, key } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['X-Owner-Key'] = key;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new Error('Cannot reach the server. Check your connection and try again.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body, key) => request(path, { method: 'POST', body, key }),
  patch: (path, body, key) => request(path, { method: 'PATCH', body, key }),
  del: (path, key) => request(path, { method: 'DELETE', key })
};
