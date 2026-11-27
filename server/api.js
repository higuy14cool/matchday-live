'use strict';

const express = require('express');
const { newId, makeOwnerKey, hashKey } = require('./store');
const { publicTournament, publicTeam, publicGame, newGame, SPORTS } = require('./gameplay');
const { ensureOwner, bad, str, color, optionalDate } = require('./api-helpers');
const { createGamesApi } = require('./games-api');
const { seedDemo } = require('./demo');

function createApi({ store, hub }) {
  const router = express.Router();
  router.use(express.json({ limit: '96kb' }));

  const pushGame = game => hub.broadcastGame(publicGame(game));

  function uniqueId(prefix, exists) {
    let id = newId(prefix);
    while (exists(id)) id = newId(prefix);
    return id;
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
    const name = str(req.body && req.body.name, 60);
    const sport = req.body && req.body.sport;
    if (!name) return bad(res, 'Give the tournament a name');
    if (!SPORTS[sport]) return bad(res, 'sport must be soccer or basketball');
    const key = makeOwnerKey();
    const tournament = {
      id: uniqueId('tr', id => Boolean(store.tournament(id))),
      name,
      sport,
      ownerHash: hashKey(key),
      createdAt: Date.now()
    };
    store.insert('tournaments', tournament);
    res.status(201).json({ tournament: publicTournament(tournament), ownerKey: key });
  });

  router.get('/tournaments/:id', (req, res) => {
    const t = store.tournament(req.params.id);
    if (!t) return bad(res, 'Tournament not found', 404);
    res.json(tournamentPayload(t));
  });

  router.patch('/tournaments/:id', (req, res) => {
    const t = store.tournament(req.params.id);
    if (!t) return bad(res, 'Tournament not found', 404);
    if (!ensureOwner(t, req, res)) return;
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
    if (!ensureOwner(t, req, res)) return;
    store.data.games = store.games.filter(g => g.tournamentId !== t.id);
    store.data.teams = store.teams.filter(x => x.tournamentId !== t.id);
    store.remove('tournaments', t.id);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ teams
  router.post('/tournaments/:id/teams', (req, res) => {
    const t = store.tournament(req.params.id);
    if (!t) return bad(res, 'Tournament not found', 404);
    if (!ensureOwner(t, req, res)) return;
    const name = str(req.body && req.body.name, 40);
    if (!name) return bad(res, 'Give the team a name');
    if (store.teamsOf(t.id).length >= 64) return bad(res, 'A tournament holds up to 64 teams');
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
    if (!ensureOwner(t, req, res)) return;
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
    if (!ensureOwner(t, req, res)) return;
    const used = store.games.some(g => g.homeTeamId === team.id || g.awayTeamId === team.id);
    if (used) return bad(res, 'This team already has games. Delete those games first.', 409);
    store.remove('teams', team.id);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- game create
  router.post('/tournaments/:id/games', (req, res) => {
    const t = store.tournament(req.params.id);
    if (!t) return bad(res, 'Tournament not found', 404);
    if (!ensureOwner(t, req, res)) return;

    const home = store.team(req.body && req.body.homeTeamId);
    const away = store.team(req.body && req.body.awayTeamId);
    if (!home || !away) return bad(res, 'Pick two teams');
    if (home.id === away.id) return bad(res, 'A team cannot play itself');
    if (home.tournamentId !== t.id || away.tournamentId !== t.id) {
      return bad(res, 'Both teams must belong to this tournament');
    }
    if (store.gamesOf(t.id).length >= 400) return bad(res, 'This tournament has the maximum number of games');

    const scheduledAt = optionalDate(req.body.scheduledAt);
    if (req.body.scheduledAt && scheduledAt === null) return bad(res, 'Invalid date');

    const game = newGame({
      id: uniqueId('gm', id => Boolean(store.game(id))),
      tournamentId: t.id,
      sport: t.sport,
      homeTeamId: home.id,
      awayTeamId: away.id,
      round: str(req.body.round, 40),
      venue: str(req.body.venue, 60),
      scheduledAt: scheduledAt || Date.now()
    });
    store.insert('games', game);
    res.status(201).json({ game: publicGame(game) });
  });

  // Full single round-robin schedule for every team in the tournament.
  router.post('/tournaments/:id/fixtures', (req, res) => {
    const t = store.tournament(req.params.id);
    if (!t) return bad(res, 'Tournament not found', 404);
    if (!ensureOwner(t, req, res)) return;

    const teams = store.teamsOf(t.id);
    if (teams.length < 2) return bad(res, 'Add at least two teams first');
    if (store.gamesOf(t.id).length > 0) {
      return bad(res, 'Clear the existing games before generating a schedule', 409);
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

  // ----------------------------------------------------------------- demo
  router.post('/demo', (req, res) => {
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
