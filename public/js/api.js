let currentUser = null;
let unauthorizedHandler = null;

export function setUser(user) {
  currentUser = user || null;
}

export function getUser() {
  return currentUser;
}

/** Admins run the competition; viewers only watch. */
export function canEdit() {
  return Boolean(currentUser && currentUser.role === 'admin');
}

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

async function request(path, { method = 'GET', body, quiet401 = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
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
    if (res.status === 401 && !quiet401 && unauthorizedHandler) {
      setUser(null);
      unauthorizedHandler();
    }
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path) => request(path, { method: 'DELETE' }),
  login: (username, password) => request('/auth/login', { method: 'POST', body: { username, password }, quiet401: true }),
  logout: () => request('/auth/logout', { method: 'POST', body: {}, quiet401: true }),
  me: async () => {
    try {
      return await request('/auth/me', { quiet401: true });
    } catch (err) {
      if (err.status === 401) return null;
      throw err;
    }
  },
  users: {
    list: () => request('/users'),
    create: (body) => request('/users', { method: 'POST', body }),
    remove: (id) => request(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    setPassword: (current, password) => request('/auth/password', { method: 'POST', body: { current, password } })
  }
};
