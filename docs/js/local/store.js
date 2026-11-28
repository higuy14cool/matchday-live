// Browser stand-in for server/store.js: the same shape and API, kept in
// localStorage so the app works on GitHub Pages with no backend at all.

const KEY = 'matchday.db.v2';

const EMPTY = { version: 2, users: [], tournaments: [], teams: [], games: [] };

export function newId(prefix) {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

function read() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return structuredClone(EMPTY);
    return {
      version: 2,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      tournaments: Array.isArray(parsed.tournaments) ? parsed.tournaments : [],
      teams: Array.isArray(parsed.teams) ? parsed.teams : [],
      games: Array.isArray(parsed.games) ? parsed.games : []
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

export class Store {
  constructor() {
    this.data = read();
    // Another tab wrote the database: reload it and let the UI redraw.
    addEventListener('storage', event => {
      if (event.key !== KEY) return;
      this.data = read();
      dispatchEvent(new CustomEvent('matchday:external-change'));
    });
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (err) {
      console.error('Could not write the local database', err);
      dispatchEvent(new CustomEvent('matchday:storage-full'));
    }
  }

  flush() { this.save(); }

  get users() { return this.data.users; }
  get tournaments() { return this.data.tournaments; }
  get teams() { return this.data.teams; }
  get games() { return this.data.games; }

  user(id) { return this.data.users.find(u => u.id === id); }
  userByName(username) {
    const key = String(username || '').toLowerCase();
    return this.data.users.find(u => u.username.toLowerCase() === key);
  }

  tournament(id) { return this.data.tournaments.find(t => t.id === id); }
  team(id) { return this.data.teams.find(t => t.id === id); }
  game(id) { return this.data.games.find(g => g.id === id); }

  teamsOf(tournamentId) { return this.data.teams.filter(t => t.tournamentId === tournamentId); }
  gamesOf(tournamentId) { return this.data.games.filter(g => g.tournamentId === tournamentId); }

  insert(collection, record) {
    this.data[collection].push(record);
    this.save();
    return record;
  }

  remove(collection, id) {
    const list = this.data[collection];
    const i = list.findIndex(r => r.id === id);
    if (i === -1) return null;
    const [removed] = list.splice(i, 1);
    this.save();
    return removed;
  }
}

// Elapsed time in the current period, including time spent running.
export function clockElapsed(game, now = Date.now()) {
  const c = game.clock;
  if (!c) return 0;
  const running = c.running && c.startedAt ? Math.max(0, now - c.startedAt) : 0;
  return Math.max(0, (c.elapsedMs || 0) + running);
}
