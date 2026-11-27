'use strict';

const express = require('express');
const { newId } = require('./store');
const { publicTournament, publicTeam, publicGame, newGame, SPORTS } = require('./gameplay');
const { ensureAdmin, bad, str, color, optionalDate } = require('./api-helpers');
const { createGamesApi } = require('./games-api');
const { seedDemo } = require('./demo');
const { normalizeFormat, stagesFor, stageLabel, buildGroupFixtures } = require('./format');

const MAX_TEAMS = 80;
const MAX_GAMES = 2000;
const TEAM_COLORS = ['#9ae64b', '#4cc9f0', '#ff9f45', '#ff5d8f', '#b28dff', '#f4d35e', '#5ee0b5', '#ff8f6b'];

function createApi({ store, hub, auth }) {
  const router = express.Router();
  router.use(express.json({ limit: '96kb' }));
  // Everything below needs a signed-in account; /health stays public.
  router.use((req, res, next) => (req.path === '/health' ? next() : auth.requireUser(req, res, next)));

  const pushGame = game => hub.broadcastGame(publicGame(game));

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

  // Team names arrive together with the tournament so the organizer can set
  // up the whole competition in one step. An entry may be a plain name or
  // { name, group } when the organizer assigns teams to groups by hand.
  function parseTeamNames(raw) {
    if (raw === undefined) return { names: [] };
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

  // ---------------------------------------------------------------- health
  router.get('/health', (req, res) => res.json({ ok: true, sport: Object.keys(SPORTS) }));

  // ----------------------------------------------------------- tournaments
  router.get('/tournaments', (req, res) => {
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
    res.json({ tournaments: rows });
  });

  router.post('/tournaments', (req, res) => {
    if (!ensureAdmin(req, res)) return;
    const body = req.body || {};
    const name = str(body.name, 60);
    const sport = body.sport;
    if (!name) return bad(res, 'Give the tournament a name');
    if (!SPORTS[sport]) return bad(res, 'sport must be soccer or basketball');

    const parsedTeams = parseTeamNames(body.teams);
    if (parsedTeams.error) return bad(res, parsedTeams.error);
    const teamNames = parsedTeams.names;

    let format = null;
    if (body.format !== undefined) {
      const parsed = normalizeFormat(body.format, teamNames.length);
      if (parsed.error) return bad(res, parsed.error);
      format = parsed.format;
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
    const teams = buildTeams(tournament, teamNames, parsedTeams.groups);

    let games = [];
    if (format) {
      const built = buildGroupFixtures({
        tournament,
        teams,
        format,
        startAt: Date.now() + 24 * 60 * 60 * 1000,
        makeId: () => uniqueId('gm', id => Boolean(store.game(id)))
      });
      if (built.error) return bad(res, built.error);
      games = built.games.map(props => newGame(props));
    }

    store.insert('tournaments', tournament);
    teams.forEach(team => store.insert('teams', team));
    games.forEach(game => store.insert('games', game));

    res.status(201).json({
      tournament: publicTournament(tournament),
      teams: teams.map(publicTeam),
      games: games.map(publicGame)
    });
  });

  router.get('/tournaments/:id', (req, res) => {
    const t = store.tournament(req.params.id);
    if (!t) return bad(res, 'Tournament not found', 404);
    res.json(tournamentPayload(t));
  });

  router.patch('/tournaments/:id', (req, res) => {
    const t = store.tournament(req.params.id);
    if (!t) return bad(res, 'Tournament not found', 404);
    if (!ensureAdmin(req, res)) return;
    if (req.body && req.body.name !== undefined) {
      const name = str(req.body.name, 60);
      if (!name) return bad(res, 'Name cannot be empty');
      t.name = name;
    }
    store.save();
    res.json({ ...tournamentPayload(t) });
  });

  router.delete('/tournaments/:id', (req, res) => {
    const t = store.tournament(req.params.id);
    if (!t) return bad(res, 'Tournament not found', 404);
    if (!ensureAdmin(req, res)) return;
    store.data.games = store.games.filter(g => g.tournamentId !== t.id);
    store.data.teams = store.teams.filter(x => x.tournamentId !== t.id);
    store.remove('tournaments', t.id);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ teams
  router.post('/tournaments/:id/teams', (req, res) => {
    const t = store.tournament(req.params.id);
    if (!t) return bad(res, 'Tournament not found', 404);
    if (!ensureAdmin(req, res)) return;
    const name = str(req.body && req.body.name, 40);
    if (!name) return bad(res, 'Give the team a name');
    if (store.teamsOf(t.id).length >= MAX_TEAMS) return bad(res, `A tournament holds up to ${MAX_TEAMS} teams`);
    const short = str(req.body.short, 4).toUpperCase() || name.slice(0, 3).toUpperCase();
    const team = {
      id: uniqueId('tm', id => Boolean(store.team(id))),
      tournamentId: t.id,
      name,
      short,
      color: color(req.body.color),
      createdAt: Date.now()
    };
    store.insert('teams', team);
    res.status(201).json({ team: publicTeam(team) });
  });

  router.patch('/teams/:id', (req, res) => {
    const team = store.team(req.params.id);
    if (!team) return bad(res, 'Team not found', 404);
    const t = store.tournament(team.tournamentId);
    if (!ensureAdmin(req, res)) return;
    if (req.body.name !== undefined) {
      const name = str(req.body.name, 40);
      if (!name) return bad(res, 'Team name cannot be empty');
      team.name = name;
    }
    if (req.body.short !== undefined) team.short = str(req.body.short, 4).toUpperCase() || team.short;
    if (req.body.color !== undefined) team.color = color(req.body.color, team.color);
    store.save();
    res.json({ team: publicTeam(team) });
  });

  router.delete('/teams/:id', (req, res) => {
    const team = store.team(req.params.id);
    if (!team) return bad(res, 'Team not found', 404);
    const t = store.tournament(team.tournamentId);
    if (!ensureAdmin(req, res)) return;
    const used = store.games.some(g => g.homeTeamId === team.id || g.awayTeamId === team.id);
    if (used) return bad(res, 'This team already has games. Delete those games first.', 409);
    store.remove('teams', team.id);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- game create
  router.post('/tournaments/:id/games', (req, res) => {
    const t = store.tournament(req.params.id);
    if (!t) return bad(res, 'Tournament not found', 404);
    if (!ensureAdmin(req, res)) return;

    const home = store.team(req.body && req.body.homeTeamId);
    const away = store.team(req.body && req.body.awayTeamId);
    if (!home || !away) return bad(res, 'Pick two teams');
    if (home.id === away.id) return bad(res, 'A team cannot play itself');
    if (home.tournamentId !== t.id || away.tournamentId !== t.id) {
      return bad(res, 'Both teams must belong to this tournament');
    }
    if (store.gamesOf(t.id).length >= MAX_GAMES) return bad(res, 'This tournament has the maximum number of games');

    const scheduledAt = optionalDate(req.body.scheduledAt);
    if (req.body.scheduledAt && scheduledAt === null) return bad(res, 'Invalid date');
    if (req.body.live !== undefined && typeof req.body.live !== 'boolean') return bad(res, 'live must be true or false');
    const live = req.body.live === true;

    const stage = str(req.body.stage, 12);
    if (stage && !['group', 'qf', 'sf', 'third', 'final', 'placement'].includes(stage)) return bad(res, 'Invalid stage');
    if (stage && t.format && !stagesFor(t.format).includes(stage)) {
      return bad(res, `This tournament does not have a ${stageLabel(stage)}`);
    }

    const game = newGame({
      id: uniqueId('gm', id => Boolean(store.game(id))),
      tournamentId: t.id,
      sport: t.sport,
      homeTeamId: home.id,
      awayTeamId: away.id,
      stage,
      round: str(req.body.round, 40) || stageLabel(stage),
      venue: str(req.body.venue, 60),
      scheduledAt: live ? Date.now() : scheduledAt || Date.now()
    });
    if (live) {
      game.status = 'live';
      game.clock.running = true;
      game.clock.startedAt = Date.now();
    }
    store.insert('games', game);
    res.status(201).json({ game: publicGame(game) });
  });

  // Full single round-robin schedule for every team in the tournament.
  router.post('/tournaments/:id/fixtures', (req, res) => {
    const t = store.tournament(req.params.id);
    if (!t) return bad(res, 'Tournament not found', 404);
    if (!ensureAdmin(req, res)) return;

    const teams = store.teamsOf(t.id);
    if (teams.length < 2) return bad(res, 'Add at least two teams first');
    if (store.gamesOf(t.id).length > 0) {
      return bad(res, 'Clear the existing games before generating a schedule', 409);
    }
    if (teams.length * (teams.length - 1) / 2 > MAX_GAMES) {
      return bad(res, `That would create more than ${MAX_GAMES} games. Use the group format instead.`);
    }

    const start = optionalDate(req.body && req.body.startAt) || Date.now() + 24 * 60 * 60 * 1000;
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
      // rotate all but the first team
      list.splice(1, 0, list.pop());
    }
    res.status(201).json({ games: created, count: created.length });
  });

  // ------------------------------------------------------------ quick games
  router.post('/quick-games', (req, res) => {
    if (!ensureAdmin(req, res)) return;
    const body = req.body || {};
    const sport = body.sport;
    const homeName = str(body.homeName, 40);
    const awayName = str(body.awayName, 40);
    if (!SPORTS[sport]) return bad(res, 'sport must be soccer or basketball');
    if (!homeName || !awayName) return bad(res, 'Give both teams a name');
    if (homeName.toLowerCase() === awayName.toLowerCase()) return bad(res, 'Pick two different teams');
    if (body.live !== undefined && typeof body.live !== 'boolean') return bad(res, 'live must be true or false');

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
      round: 'Quick game',
      venue: '',
      scheduledAt: Date.now()
    });
    if (body.live === true) {
      game.status = 'live';
      game.clock.running = true;
      game.clock.startedAt = Date.now();
    }
    store.insert('tournaments', tournament);
    teams.forEach(team => store.insert('teams', team));
    store.insert('games', game);
    res.status(201).json({
      tournament: publicTournament(tournament),
      teams: teams.map(publicTeam),
      game: publicGame(game)
    });
  });

  router.get('/quick-games', (req, res) => {
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
    res.json({ games });
  });

  // ----------------------------------------------------------------- demo
  router.post('/demo', (req, res) => {
    if (!ensureAdmin(req, res)) return;
    if (store.tournaments.length >= 40) return bad(res, 'Demo limit reached', 409);
    const created = seedDemo(store);
    res.status(201).json({ created });
  });

  router.use(createGamesApi({ store, hub, pushGame }));

  // Unknown API route -> JSON 404 instead of the SPA shell.
  router.use((req, res) => res.status(404).json({ error: 'Not found' }));

  return router;
}

module.exports = { createApi };
