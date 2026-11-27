'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = { version: 1, users: [], tournaments: [], teams: [], games: [] };

class Store {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.data = this.load();
    this.writeTimer = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        users: Array.isArray(parsed.users) ? parsed.users : [],
        tournaments: Array.isArray(parsed.tournaments) ? parsed.tournaments : [],
        teams: Array.isArray(parsed.teams) ? parsed.teams : [],
        games: Array.isArray(parsed.games) ? parsed.games : []
      };
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Could not read db.json, starting empty:', err.message);
      return structuredClone(EMPTY);
    }
  }

  // Writes are debounced and atomic (tmp file + rename) so a crash cannot
  // leave a half-written database behind.
  save() {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 40);
  }

  flush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, DB_FILE);
  }

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

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

// Elapsed time in the current period, including time spent running.
function clockElapsed(game, now = Date.now()) {
  const c = game.clock;
  if (!c) return 0;
  const running = c.running && c.startedAt ? Math.max(0, now - c.startedAt) : 0;
  return Math.max(0, (c.elapsedMs || 0) + running);
}

module.exports = { Store, newId, clockElapsed, DB_FILE };
