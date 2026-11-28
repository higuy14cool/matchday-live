// The server's REST API, rewritten as one function that the fetch shim calls.
// Route behaviour matches server/api.js, games-api.js and auth-api.js.

import { newId } from './store.js';
import {
  SPORTS, publicTournament, publicTeam, publicGame, newGame,
  applyEvent, undoLast, clockAction, endGame
} from './gameplay.js';
import { normalizeFormat, stagesFor, stageLabel, buildGroupFixtures } from './format.js';
import { advanceTournament } from './bracket.js';
import { seedDemo } from './demo.js';
import { publicUser } from './auth.js';
import { saveRecording, getRecording, deleteRecording } from './recordings.js';

const MAX_TEAMS = 80;
const MAX_GAMES = 2000;
const TEAM_COLORS = ['#9ae64b', '#4cc9f0', '#ff9f45', '#ff5d8f', '#b28dff', '#f4d35e', '#5ee0b5', '#ff8f6b'];

const str = (value, max = 80) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const color = (value, fallback = '#9ae64b') => (/^#[0-9a-fA-F]{6}$/.test(value || '') ? value : fallback);
const optionalDate = value => {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};
const httpUrl = value => {
  const url = str(value, 500);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
};

const ok = (data, status = 200) => ({ status, data });
const fail = (error, status = 400) => ({ status, data: { error } });

export function createBackend({ store, auth, publishGame = () => {} }) {
  function uniqueId(prefix, exists) {
    let id = newId(prefix);
    while (exists(id)) id = newId(prefix);
    return id;
  }

  function shortName(name, used) {
    const base = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'TEAM';
    let short = base;
    let n = 2;
    while (used.has(short)) {
      short = (base.slice(0, 2) + n).slice(0, 4);
      n += 1;
    }
    used.add(short);
    return short;
  }

  function parseTeamNames(raw) {
    if (raw === undefined) return { names: [], groups: [] };
    if (!Array.isArray(raw)) return { error: 'teams must be an array of names' };
    if (raw.length < 3 || raw.length > MAX_TEAMS) {
      return { error: `A tournament needs between 3 and ${MAX_TEAMS} teams` };
    }
    const names = [];
    const groups = [];
    const seen = new Set();
    for (const item of raw) {
      const rawName = typeof item === 'string' ? item : item && item.name;
      const name = str(rawName, 40);
      if (!name) return { error: 'Every team needs a name' };
      const key = name.toLowerCase();
      if (seen.has(key)) return { error: `Team name "${name}" is used twice` };
      seen.add(key);
      names.push(name);
      if (item && typeof item === 'object' && item.group !== undefined && item.group !== null) {
        const group = Number(item.group);
        if (!Number.isInteger(group) || group < 0 || group > 15) {
          return { error: 'Group numbers must be whole numbers starting at 0' };
        }
        groups.push(group);
      } else {
        groups.push(null);
      }
    }
    return { names, groups };
  }

  function buildTeams(tournament, names, groups = []) {
    const usedShorts = new Set();
    return names.map((name, i) => {
      const team = {
        id: uniqueId('tm', id => Boolean(store.team(id))),
        tournamentId: tournament.id,
        name,
        short: shortName(name, usedShorts),
        color: TEAM_COLORS[i % TEAM_COLORS.length],
        createdAt: Date.now()
      };
      if (Number.isInteger(groups[i])) team.group = groups[i];
      return team;
    });
  }

  function tournamentPayload(t) {
    const teams = store.teamsOf(t.id);
    const games = store.gamesOf(t.id);
    return {
      tournament: publicTournament(t),
      teams: teams.map(publicTeam),
      games: games.map(publicGame).sort((a, b) => a.scheduledAt - b.scheduledAt),
      liveCount: games.filter(g => g.status === 'live').length
    };
  }

  function advance(game) {
    if (game.status !== 'final') return;
    const tournament = store.tournament(game.tournamentId);
    if (!tournament) return;
    const makeId = () => {
      let id = newId('gm');
      while (store.game(id)) id = newId('gm');
      return id;
    };
    for (const next of advanceTournament(store, tournament, game, makeId)) publishGame(next);
  }

  function detail(game) {
    return {
      game: publicGame(game),
      tournament: publicTournament(store.tournament(game.tournamentId)),
      home: publicTeam(store.team(game.homeTeamId) || { id: game.homeTeamId, name: 'Home', short: 'HOM', color: '#9ae64b' }),
      away: publicTeam(store.team(game.awayTeamId) || { id: game.awayTeamId, name: 'Away', short: 'AWY', color: '#ff7a59' })
    };
  }

  // Admin-only routes: same answers the server gave.
  function needAdmin() {
    const user = auth.currentUser();
    if (!user) return fail('Please sign in', 401);
    if (user.role !== 'admin') return fail('Only an admin can do that', 403);
    return null;
  }

  /** Load a game for an editing route. */
  function loadGame(id) {
    const game = store.game(id);
    if (!game) return { error: fail('Game not found', 404) };
    if (!store.tournament(game.tournamentId)) return { error: fail('Tournament not found', 404) };
    const denied = needAdmin();
    if (denied) return { error: denied };
    return { game };
  }

  // ------------------------------------------------------------ auth routes
  async function login(body) {
    const result = await auth.login(body.username, body.password);
    if (result.error) return fail(result.error, result.status || 400);
    return ok({ user: publicUser(result.user) });
  }

  async function changePassword(body) {
    const user = auth.currentUser();
    if (!user) return fail('Please sign in', 401);
    const check = await auth.login(user.username, String(body.current || ''));
    if (check.error) return fail('Your current password is not right', 403);
    const result = await auth.setPassword(user, body.password);
    if (result.error) return fail(result.error);
    return ok({ ok: true, user: publicUser(user) });
  }

  async function createAccount(body) {
    const denied = needAdmin();
    if (denied) return denied;
    const role = body.role === 'admin' ? 'admin' : 'viewer';
    const result = await auth.createUser({
      username: body.username,
      password: body.password,
      role,
      createdBy: (auth.currentUser() || {}).id || ''
    });
    if (result.error) return fail(result.error, result.status || 400);
    return ok({ user: publicUser(result.user) }, 201);
  }

  function deleteAccount(id) {
    const denied = needAdmin();
    if (denied) return denied;
    const user = store.user(id);
    if (!user) return fail('Account not found', 404);
    const me = auth.currentUser();
    if (user.id === me.id) return fail('You cannot delete your own account');
    if (user.role === 'admin' && store.users.filter(u => u.role === 'admin').length < 2) {
      return fail('Keep at least one admin account');
    }
    store.remove('users', user.id);
    return ok({ ok: true });
  }

  // ------------------------------------------------------- tournament routes
  function createTournament(body) {
    const denied = needAdmin();
    if (denied) return denied;
    const name = str(body.name, 60);
    const sport = body.sport;
    if (!name) return fail('Give the tournament a name');
    if (!SPORTS[sport]) return fail('sport must be soccer or basketball');

    const parsed = parseTeamNames(body.teams);
    if (parsed.error) return fail(parsed.error);
    const teamNames = parsed.names;

    let format = null;
    if (body.format !== undefined) {
      const norm = normalizeFormat(body.format, teamNames.length);
      if (norm.error) return fail(norm.error);
      format = norm.format;
    } else if (teamNames.length) {
      format = { groups: 1, groupStage: 'single', knockout: 'none', advancePerGroup: 2 };
    }

    const tournament = {
      id: uniqueId('tr', id => Boolean(store.tournament(id))),
      name,
      sport,
      format,
      createdAt: Date.now()
    };
    const teams = buildTeams(tournament, teamNames, parsed.groups);

    let games = [];
    if (format) {
      const built = buildGroupFixtures({
        tournament,
        teams,
        format,
        startAt: Date.now() + 24 * 60 * 60 * 1000,
        makeId: () => uniqueId('gm', id => Boolean(store.game(id)))
      });
      if (built.error) return fail(built.error);
      games = built.games.map(props => newGame(props));
    }

    store.insert('tournaments', tournament);
    teams.forEach(team => store.insert('teams', team));
    games.forEach(game => store.insert('games', game));

    return ok({
      tournament: publicTournament(tournament),
      teams: teams.map(publicTeam),
      games: games.map(publicGame)
    }, 201);
  }

  function listTournaments() {
    const rows = store.tournaments
      .filter(t => !t.quick)
      .map(t => {
        const games = store.gamesOf(t.id);
        return {
          ...publicTournament(t),
          teamCount: store.teamsOf(t.id).length,
          gameCount: games.length,
          liveCount: games.filter(g => g.status === 'live').length
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    return ok({ tournaments: rows });
  }

  function createFixtureSchedule(id, body) {
    const t = store.tournament(id);
    if (!t) return fail('Tournament not found', 404);
    const denied = needAdmin();
    if (denied) return denied;

    const teams = store.teamsOf(t.id);
    if (teams.length < 2) return fail('Add at least two teams first');
    if (store.gamesOf(t.id).length > 0) return fail('Clear the existing games before generating a schedule', 409);
    if (teams.length * (teams.length - 1) / 2 > MAX_GAMES) {
      return fail(`That would create more than ${MAX_GAMES} games. Use the group format instead.`);
    }

    const start = optionalDate(body && body.startAt) || Date.now() + 24 * 60 * 60 * 1000;
    const gapMs = 2 * 60 * 60 * 1000;
    const list = teams.slice();
    if (list.length % 2) list.push(null);
    const rounds = list.length - 1;
    const half = list.length / 2;
    const created = [];
    let slot = 0;

    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < half; i++) {
        const a = list[i];
        const b = list[list.length - 1 - i];
        if (!a || !b) continue;
        const game = newGame({
          id: uniqueId('gm', id => Boolean(store.game(id))),
          tournamentId: t.id,
          sport: t.sport,
          homeTeamId: a.id,
          awayTeamId: b.id,
          round: `Round ${r + 1}`,
          venue: '',
          scheduledAt: start + slot * gapMs
        });
        slot += 1;
        store.insert('games', game);
        created.push(publicGame(game));
      }
      list.splice(1, 0, list.pop());
    }
    return ok({ games: created, count: created.length }, 201);
  }

  function createTournamentGame(id, body) {
    const t = store.tournament(id);
    if (!t) return fail('Tournament not found', 404);
    const denied = needAdmin();
    if (denied) return denied;

    const home = store.team(body && body.homeTeamId);
    const away = store.team(body && body.awayTeamId);
    if (!home || !away) return fail('Pick two teams');
    if (home.id === away.id) return fail('A team cannot play itself');
    if (home.tournamentId !== t.id || away.tournamentId !== t.id) {
      return fail('Both teams must belong to this tournament');
    }
    if (store.gamesOf(t.id).length >= MAX_GAMES) return fail('This tournament has the maximum number of games');

    const scheduledAt = optionalDate(body.scheduledAt);
    if (body.scheduledAt && scheduledAt === null) return fail('Invalid date');
    if (body.live !== undefined && typeof body.live !== 'boolean') return fail('live must be true or false');
    const live = body.live === true;

    const stage = str(body.stage, 12);
    if (stage && !['group', 'qf', 'sf', 'third', 'final', 'placement'].includes(stage)) return fail('Invalid stage');
    if (body.shootout !== undefined && typeof body.shootout !== 'boolean') return fail('shootout must be true or false');
    const shootout = body.shootout === true;
    if (shootout && t.sport !== 'soccer') return fail('Penalty shootouts are soccer only');
    if (stage && t.format && !stagesFor(t.format).includes(stage)) {
      return fail(`This tournament does not have a ${stageLabel(stage)}`);
    }

    const game = newGame({
      id: uniqueId('gm', id => Boolean(store.game(id))),
      tournamentId: t.id,
      sport: t.sport,
      homeTeamId: home.id,
      awayTeamId: away.id,
      stage,
      round: str(body.round, 40) || (shootout ? 'Penalty shootout' : stageLabel(stage)),
      venue: str(body.venue, 60),
      scheduledAt: live ? Date.now() : scheduledAt || Date.now(),
      shootout
    });
    if (live) {
      game.status = 'live';
      game.clock.running = true;
      game.clock.startedAt = Date.now();
    }
    store.insert('games', game);
    return ok({ game: publicGame(game) }, 201);
  }

  function createQuickGame(body) {
    const denied = needAdmin();
    if (denied) return denied;
    const sport = body.sport;
    const homeName = str(body.homeName, 40);
    const awayName = str(body.awayName, 40);
    if (!SPORTS[sport]) return fail('sport must be soccer or basketball');
    if (!homeName || !awayName) return fail('Give both teams a name');
    if (homeName.toLowerCase() === awayName.toLowerCase()) return fail('Pick two different teams');
    if (body.live !== undefined && typeof body.live !== 'boolean') return fail('live must be true or false');
    if (body.shootout !== undefined && typeof body.shootout !== 'boolean') return fail('shootout must be true or false');
    const shootout = body.shootout === true;
    if (shootout && sport !== 'soccer') return fail('Penalty shootouts are soccer only');

    const tournament = {
      id: uniqueId('tr', id => Boolean(store.tournament(id))),
      name: `${homeName} vs ${awayName}`,
      sport,
      format: null,
      quick: true,
      createdAt: Date.now()
    };
    const teams = buildTeams(tournament, [homeName, awayName]);
    const game = newGame({
      id: uniqueId('gm', id => Boolean(store.game(id))),
      tournamentId: tournament.id,
      sport,
      homeTeamId: teams[0].id,
      awayTeamId: teams[1].id,
      stage: '',
      round: shootout ? 'Penalty shootout' : 'Quick game',
      venue: '',
      scheduledAt: Date.now(),
      shootout
    });
    if (body.live === true) {
      game.status = 'live';
      game.clock.running = true;
      game.clock.startedAt = Date.now();
    }
    store.insert('tournaments', tournament);
    teams.forEach(team => store.insert('teams', team));
    store.insert('games', game);
    return ok({
      tournament: publicTournament(tournament),
      teams: teams.map(publicTeam),
      game: publicGame(game)
    }, 201);
  }

  function listQuickGames() {
    const games = store.tournaments
      .filter(t => t.quick)
      .map(t => {
        const game = store.gamesOf(t.id)[0];
        if (!game) return null;
        return {
          game: { ...publicGame(game), tournamentName: t.name },
          tournament: publicTournament(t),
          home: publicTeam(store.team(game.homeTeamId)),
          away: publicTeam(store.team(game.awayTeamId))
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.game.updatedAt - a.game.updatedAt)
      .slice(0, 12);
    return ok({ games });
  }

  // ---------------------------------------------------------- game mutations
  function updateGame(id, body) {
    const loaded = loadGame(id);
    if (loaded.error) return loaded.error;
    const game = loaded.game;

    if (body.venue !== undefined) game.venue = str(body.venue, 60);
    if (body.round !== undefined) game.round = str(body.round, 40);
    if (body.homeTeamId !== undefined || body.awayTeamId !== undefined) {
      if (game.status !== 'scheduled') return fail('Teams can only be changed before a game starts');
      if (game.stage === 'group') return fail('Group game teams are fixed');
      const homeId = body.homeTeamId !== undefined ? String(body.homeTeamId) : game.homeTeamId;
      const awayId = body.awayTeamId !== undefined ? String(body.awayTeamId) : game.awayTeamId;
      const homeTeam = store.team(homeId);
      const awayTeam = store.team(awayId);
      if (!homeTeam || homeTeam.tournamentId !== game.tournamentId) return fail('Home team is not in this tournament');
      if (!awayTeam || awayTeam.tournamentId !== game.tournamentId) return fail('Away team is not in this tournament');
      if (homeId === awayId) return fail('A team cannot play itself');
      game.homeTeamId = homeId;
      game.awayTeamId = awayId;
    }
    if (body.scheduledAt !== undefined) {
      const ms = optionalDate(body.scheduledAt);
      if (ms === null) return fail('Invalid date');
      game.scheduledAt = ms;
    }
    if (body.streamUrl !== undefined) {
      const url = httpUrl(body.streamUrl);
      if (url === null) return fail('Stream link must start with http:// or https://');
      game.streamUrl = url;
    }
    if (body.status !== undefined) {
      if (!['scheduled', 'live', 'final'].includes(body.status)) return fail('Invalid status');
      if (body.status === 'final') endGame(game);
      else {
        if (game.status === 'final' && game.clock.elapsedMs >= game.clock.periodLengthMs) {
          game.clock.running = false;
        }
        game.status = body.status;
      }
    }
    game.updatedAt = Date.now();
    store.save();
    publishGame(game);
    advance(game);
    return ok(detail(game));
  }

  async function removeGame(id) {
    const loaded = loadGame(id);
    if (loaded.error) return loaded.error;
    const { game } = loaded;
    const tournament = store.tournament(game.tournamentId);
    store.remove('games', game.id);
    await deleteRecording(game.id).catch(() => {});
    if (tournament && tournament.quick && store.gamesOf(tournament.id).length === 0) {
      for (const team of store.teamsOf(tournament.id)) store.remove('teams', team.id);
      store.remove('tournaments', tournament.id);
    }
    return ok({ ok: true });
  }

  function addEvent(id, body) {
    const loaded = loadGame(id);
    if (loaded.error) return loaded.error;
    const error = applyEvent(loaded.game, {
      type: body.type,
      side: body.side,
      points: body.points,
      player: body.player,
      note: body.note,
      replayMs: body.replayMs
    });
    if (error) return fail(error);
    store.save();
    publishGame(loaded.game);
    return ok(detail(loaded.game));
  }

  function undo(id) {
    const loaded = loadGame(id);
    if (loaded.error) return loaded.error;
    const error = undoLast(loaded.game);
    if (error) return fail(error);
    store.save();
    publishGame(loaded.game);
    return ok(detail(loaded.game));
  }

  function setScore(id, body) {
    const loaded = loadGame(id);
    if (loaded.error) return loaded.error;
    const { game } = loaded;
    const { home, away } = body;
    if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0 || home > 999 || away > 999) {
      return fail('home and away must be whole numbers between 0 and 999');
    }
    if (body.final !== undefined && typeof body.final !== 'boolean') return fail('final must be true or false');
    if (body.pens !== undefined) {
      if (!game.shootout || !game.shootout.active) return fail('This game has no penalty shootout');
      const pens = body.pens || {};
      if (!Number.isInteger(pens.home) || !Number.isInteger(pens.away) || pens.home < 0 || pens.away < 0 || pens.home > 99 || pens.away > 99) {
        return fail('pens.home and pens.away must be whole numbers between 0 and 99');
      }
      game.shootout.home = pens.home;
      game.shootout.away = pens.away;
    }
    game.score.home = home;
    game.score.away = away;
    // Direct score edits are part of the replay timeline too.
    const replayMs = Number(body.replayMs);
    const scoreSets = Array.isArray(game.scoreSets) ? game.scoreSets : (game.scoreSets = []);
    scoreSets.push({
      at: Date.now(),
      replayMs: Number.isFinite(replayMs) && replayMs >= 0 ? Math.round(replayMs) : null,
      home,
      away,
      pensHome: game.shootout && game.shootout.active ? game.shootout.home : null,
      pensAway: game.shootout && game.shootout.active ? game.shootout.away : null,
      period: game.clock.period
    });
    if (scoreSets.length > 200) scoreSets.splice(0, scoreSets.length - 200);
    if (body.final === true) {
      const error = endGame(game);
      if (error) return fail(error);
    }
    game.updatedAt = Date.now();
    store.save();
    publishGame(game);
    advance(game);
    return ok(detail(game));
  }

  function setClock(id, body) {
    const loaded = loadGame(id);
    if (loaded.error) return loaded.error;
    const error = clockAction(loaded.game, body.action, { elapsedMs: body.elapsedMs, period: body.period });
    if (error) return fail(error);
    store.save();
    publishGame(loaded.game);
    return ok(detail(loaded.game));
  }

  function setStream(id, body) {
    const loaded = loadGame(id);
    if (loaded.error) return loaded.error;
    const url = httpUrl(body && body.url);
    if (url === null) return fail('Stream link must start with http:// or https://');
    loaded.game.streamUrl = url;
    loaded.game.updatedAt = Date.now();
    store.save();
    publishGame(loaded.game);
    return ok(detail(loaded.game));
  }

  // ---------------------------------------------------------- recordings
  async function saveRecordedVideo(id, blob, duration, startedAt) {
    const loaded = loadGame(id);
    if (loaded.error) return loaded.error;
    if (!blob || !blob.size) return fail('No video data received');
    await saveRecording(id, blob);
    const seconds = Number(duration);
    const startAt = Number(startedAt);
    loaded.game.recording = {
      size: blob.size,
      duration: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null,
      startedAt: Number.isFinite(startAt) && startAt > 0 ? Math.round(startAt) : null,
      savedAt: Date.now()
    };
    loaded.game.updatedAt = Date.now();
    store.save();
    publishGame(loaded.game);
    return ok({ ok: true, game: publicGame(loaded.game) });
  }

  async function readRecording(id) {
    const game = store.game(id);
    if (!game) return fail('Game not found', 404);
    if (!game.recording) return fail('This game has no recording', 404);
    const blob = await getRecording(id);
    if (!blob) return fail('This game has no recording', 404);
    return { status: 200, blob };
  }

  // ----------------------------------------------------------- the router
  async function handle(method, rawUrl, body) {
    const url = new URL(rawUrl, location.origin);
    const path = url.pathname.replace(/^\/api\/?/, '/').replace(/\/$/, '') || '/';
    const query = url.searchParams;
    const seg = path.split('/').filter(Boolean);
    const json = body && typeof body === 'object' && !(body instanceof Blob) ? body : {}; 
    const m = method.toUpperCase();

    // Health and sign-in are open to everyone.
    if (path === '/health') return ok({ ok: true, sport: Object.keys(SPORTS) });
    if (path === '/auth/login' && m === 'POST') return login(json);
    if (path === '/auth/logout' && m === 'POST') {
      auth.logout();
      return ok({ ok: true });
    }
    if (path === '/auth/me' && m === 'GET') {
      const user = auth.currentUser();
      return user ? ok({ user: publicUser(user) }) : fail('Please sign in', 401);
    }
    if (path === '/auth/password' && m === 'POST') return changePassword(json);

    // Everything else needs an account.
    if (!auth.currentUser()) return fail('Please sign in', 401);

    if (seg[0] === 'users') {
      if (m === 'GET') {
        const denied = needAdmin();
        if (denied) return denied;
        return ok({ users: store.users.map(publicUser) });
      }
      if (m === 'POST') return createAccount(json);
      if (m === 'DELETE' && seg[1]) return deleteAccount(decodeURIComponent(seg[1]));
      return fail('Not found', 404);
    }

    if (seg[0] === 'tournaments') {
      if (seg.length === 1) {
        if (m === 'GET') return listTournaments();
        if (m === 'POST') return createTournament(json);
        return fail('Not found', 404);
      }
      const tournament = store.tournament(decodeURIComponent(seg[1]));
      if (!tournament) return fail('Tournament not found', 404);

      if (seg.length === 2) {
        if (m === 'GET') return ok(tournamentPayload(tournament));
        if (m === 'PATCH') {
          const denied = needAdmin();
          if (denied) return denied;
          if (json.name !== undefined) {
            const name = str(json.name, 60);
            if (!name) return fail('Name cannot be empty');
            tournament.name = name;
          }
          store.save();
          return ok(tournamentPayload(tournament));
        }
        if (m === 'DELETE') {
          const denied = needAdmin();
          if (denied) return denied;
          store.data.games = store.games.filter(g => g.tournamentId !== tournament.id);
          store.data.teams = store.teams.filter(x => x.tournamentId !== tournament.id);
          store.remove('tournaments', tournament.id);
          return ok({ ok: true });
        }
        return fail('Not found', 404);
      }

      if (seg[2] === 'teams' && m === 'POST') {
        const denied = needAdmin();
        if (denied) return denied;
        const name = str(json.name, 40);
        if (!name) return fail('Give the team a name');
        if (store.teamsOf(tournament.id).length >= MAX_TEAMS) return fail(`A tournament holds up to ${MAX_TEAMS} teams`);
        const short = str(json.short, 4).toUpperCase() || name.slice(0, 3).toUpperCase();
        const team = {
          id: uniqueId('tm', id => Boolean(store.team(id))),
          tournamentId: tournament.id,
          name,
          short,
          color: color(json.color),
          createdAt: Date.now()
        };
        store.insert('teams', team);
        return ok({ team: publicTeam(team) }, 201);
      }
      if (seg[2] === 'games' && m === 'POST') return createTournamentGame(tournament.id, json);
      if (seg[2] === 'fixtures' && m === 'POST') return createFixtureSchedule(tournament.id, json);
      return fail('Not found', 404);
    }

    if (seg[0] === 'teams' && seg[1]) {
      const team = store.team(decodeURIComponent(seg[1]));
      if (!team) return fail('Team not found', 404);
      const denied = needAdmin();
      if (denied) return denied;
      if (m === 'PATCH') {
        if (json.name !== undefined) {
          const name = str(json.name, 40);
          if (!name) return fail('Team name cannot be empty');
          team.name = name;
        }
        if (json.short !== undefined) team.short = str(json.short, 4).toUpperCase() || team.short;
        if (json.color !== undefined) team.color = color(json.color, team.color);
        store.save();
        return ok({ team: publicTeam(team) });
      }
      if (m === 'DELETE') {
        const used = store.games.some(g => g.homeTeamId === team.id || g.awayTeamId === team.id);
        if (used) return fail('This team already has games. Delete those games first.', 409);
        store.remove('teams', team.id);
        return ok({ ok: true });
      }
      return fail('Not found', 404);
    }

    if (seg[0] === 'quick-games') {
      if (m === 'GET') return listQuickGames();
      if (m === 'POST') return createQuickGame(json);
      return fail('Not found', 404);
    }

    if (seg[0] === 'demo' && m === 'POST') {
      const denied = needAdmin();
      if (denied) return denied;
      if (store.tournaments.length >= 40) return fail('Demo limit reached', 409);
      const created = seedDemo(store);
      return ok({ created }, 201);
    }

    if (seg[0] === 'live' && m === 'GET') {
      const rows = store.games
        .filter(g => g.status === 'live')
        .map(g => {
          const home = store.team(g.homeTeamId);
          const away = store.team(g.awayTeamId);
          const t = store.tournament(g.tournamentId);
          return {
            ...publicGame(g),
            homeName: home ? home.name : 'Home',
            awayName: away ? away.name : 'Away',
            homeShort: home ? home.short : 'HOM',
            awayShort: away ? away.short : 'AWY',
            tournamentName: t ? t.name : ''
          };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return ok({ games: rows });
    }

    if (seg[0] === 'games' && seg[1]) {
      const gameId = decodeURIComponent(seg[1]);
      const game = store.game(gameId);
      if (seg.length === 2) {
        if (!game) return fail('Game not found', 404);
        if (m === 'GET') return ok(detail(game));
        if (m === 'PATCH') return updateGame(gameId, json);
        if (m === 'DELETE') return removeGame(gameId);
        return fail('Not found', 404);
      }
      if (seg[2] === 'events' && m === 'POST') return addEvent(gameId, json);
      if (seg[2] === 'undo' && m === 'POST') return undo(gameId);
      if (seg[2] === 'score' && m === 'POST') return setScore(gameId, json);
      if (seg[2] === 'clock' && m === 'POST') return setClock(gameId, json);
      if (seg[2] === 'stream' && m === 'POST') return setStream(gameId, json);
      if (seg[2] === 'recording') {
        if (m === 'GET') return readRecording(gameId);
        if (m === 'PUT' || m === 'POST') return saveRecordedVideo(gameId, body, query.get('duration'), query.get('startedAt'));
      }
      return fail('Not found', 404);
    }

    return fail('Not found', 404);
  }

  return { handle };
}
