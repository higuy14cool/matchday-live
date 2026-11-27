'use strict';

const express = require('express');
const { publicGame, publicTeam, publicTournament, applyEvent, undoLast, clockAction, endGame } = require('./gameplay');
const { ensureOwner, bad, str, optionalDate, httpUrl } = require('./api-helpers');

function createGamesApi({ store, hub, pushGame }) {
  const router = express.Router();

  function load(req, res) {
    const game = store.game(req.params.id);
    if (!game) {
      bad(res, 'Game not found', 404);
      return null;
    }
    const tournament = store.tournament(game.tournamentId);
    if (!tournament) {
      bad(res, 'Tournament not found', 404);
      return null;
    }
    if (!ensureOwner(tournament, req, res)) return null;
    return { game, tournament };
  }

  function detail(game) {
    return {
      game: publicGame(game),
      tournament: publicTournament(store.tournament(game.tournamentId)),
      home: publicTeam(store.team(game.homeTeamId) || { id: game.homeTeamId, name: 'Home', short: 'HOM', color: '#9ae64b' }),
      away: publicTeam(store.team(game.awayTeamId) || { id: game.awayTeamId, name: 'Away', short: 'AWY', color: '#ff7a59' })
    };
  }

  router.get('/live', (req, res) => {
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
    res.json({ games: rows });
  });

  router.get('/games/:id', (req, res) => {
    const game = store.game(req.params.id);
    if (!game) return bad(res, 'Game not found', 404);
    res.json(detail(game));
  });

  router.patch('/games/:id', (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    const { game } = ctx;
    const body = req.body || {};

    if (body.venue !== undefined) game.venue = str(body.venue, 60);
    if (body.round !== undefined) game.round = str(body.round, 40);
    if (body.scheduledAt !== undefined) {
      const ms = optionalDate(body.scheduledAt);
      if (ms === null) return bad(res, 'Invalid date');
      game.scheduledAt = ms;
    }
    if (body.streamUrl !== undefined) {
      const url = httpUrl(body.streamUrl);
      if (url === null) return bad(res, 'Stream link must start with http:// or https://');
      game.streamUrl = url;
    }
    if (body.status !== undefined) {
      if (!['scheduled', 'live', 'final'].includes(body.status)) return bad(res, 'Invalid status');
      if (body.status === 'final') endGame(game);
      else {
        if (game.status === 'final' && game.clock.elapsedMs >= game.clock.periodLengthMs) {
          // Reopening a finished game should not look like it ended mid-clock.
          game.clock.running = false;
        }
        game.status = body.status;
      }
    }
    game.updatedAt = Date.now();
    store.save();
    pushGame(game);
    res.json(detail(game));
  });

  router.delete('/games/:id', (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    store.remove('games', ctx.game.id);
    res.json({ ok: true });
  });

  router.post('/games/:id/events', (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    const body = req.body || {};
    const error = applyEvent(ctx.game, {
      type: body.type,
      side: body.side,
      points: body.points,
      player: body.player
    });
    if (error) return bad(res, error);
    store.save();
    pushGame(ctx.game);
    res.json(detail(ctx.game));
  });

  router.post('/games/:id/undo', (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    const error = undoLast(ctx.game);
    if (error) return bad(res, error);
    store.save();
    pushGame(ctx.game);
    res.json(detail(ctx.game));
  });

  router.post('/games/:id/score', (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    const body = req.body || {};
    const home = body.home;
    const away = body.away;
    if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0 || home > 999 || away > 999) {
      return bad(res, 'home and away must be whole numbers between 0 and 999');
    }
    if (body.final !== undefined && typeof body.final !== 'boolean') return bad(res, 'final must be true or false');
    ctx.game.score.home = home;
    ctx.game.score.away = away;
    if (body.final === true) {
      const error = endGame(ctx.game);
      if (error) return bad(res, error);
    }
    ctx.game.updatedAt = Date.now();
    store.save();
    pushGame(ctx.game);
    res.json(detail(ctx.game));
  });

  router.post('/games/:id/clock', (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    const body = req.body || {};
    const error = clockAction(ctx.game, body.action, { elapsedMs: body.elapsedMs, period: body.period });
    if (error) return bad(res, error);
    store.save();
    pushGame(ctx.game);
    res.json(detail(ctx.game));
  });

  router.post('/games/:id/stream', (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    const url = httpUrl(req.body && req.body.url);
    if (url === null) return bad(res, 'Stream link must start with http:// or https://');
    ctx.game.streamUrl = url;
    ctx.game.updatedAt = Date.now();
    store.save();
    pushGame(ctx.game);
    res.json(detail(ctx.game));
  });

  return router;
}

module.exports = { createGamesApi };
