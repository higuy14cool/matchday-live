'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { publicGame, publicTeam, publicTournament, applyEvent, undoLast, clockAction, endGame } = require('./gameplay');
const { ensureAdmin, bad, str, optionalDate, httpUrl } = require('./api-helpers');
const { newId, DATA_DIR } = require('./store');
const { advanceTournament } = require('./bracket');

// Camera broadcasts are recorded in the browser and uploaded here, so a
// finished game keeps its video for anyone who opens it later.
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');

function createGamesApi({ store, hub, pushGame }) {
  const router = express.Router();

  // When a round finishes, create the games that follow it (QF winners into
  // the semifinals, SF winners into the final, SF losers into third place).
  function advance(game) {
    if (game.status !== 'final') return;
    const tournament = store.tournament(game.tournamentId);
    if (!tournament) return;
    const makeId = () => {
      let id = newId('gm');
      while (store.game(id)) id = newId('gm');
      return id;
    };
    const created = advanceTournament(store, tournament, game, makeId);
    for (const next of created) pushGame(next);
  }

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
    if (!ensureAdmin(req, res)) return null;
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
    if (body.homeTeamId !== undefined || body.awayTeamId !== undefined) {
      if (game.status !== 'scheduled') return bad(res, 'Teams can only be changed before a game starts');
      if (game.stage === 'group') return bad(res, 'Group game teams are fixed');
      const homeId = body.homeTeamId !== undefined ? String(body.homeTeamId) : game.homeTeamId;
      const awayId = body.awayTeamId !== undefined ? String(body.awayTeamId) : game.awayTeamId;
      const homeTeam = store.team(homeId);
      const awayTeam = store.team(awayId);
      if (!homeTeam || homeTeam.tournamentId !== game.tournamentId) return bad(res, 'Home team is not in this tournament');
      if (!awayTeam || awayTeam.tournamentId !== game.tournamentId) return bad(res, 'Away team is not in this tournament');
      if (homeId === awayId) return bad(res, 'A team cannot play itself');
      game.homeTeamId = homeId;
      game.awayTeamId = awayId;
    }
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
    advance(game);
    res.json(detail(game));
  });

  router.delete('/games/:id', (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    store.remove('games', ctx.game.id);
    if (ctx.game.recording) {
      fs.promises.unlink(path.join(RECORDINGS_DIR, `${ctx.game.id}.webm`)).catch(() => {});
    }
    // A quick game owns a throwaway tournament: drop it with its last game.
    if (ctx.tournament.quick && store.gamesOf(ctx.tournament.id).length === 0) {
      for (const team of store.teamsOf(ctx.tournament.id)) store.remove('teams', team.id);
      store.remove('tournaments', ctx.tournament.id);
    }
    res.json({ ok: true });
  });

  // Save the broadcast recording. Admins only; the file overwrites the previous one.
  // The body is streamed straight to disk, so a long match never sits in memory.
  function saveRecording(req, res) {
    const ctx = load(req, res);
    if (!ctx) return;
    const target = path.join(RECORDINGS_DIR, `${ctx.game.id}.webm`);
    const partial = `${target}.part`;
    let bytes = 0;
    let failed = false;

    fs.promises.mkdir(RECORDINGS_DIR, { recursive: true }).then(() => {
      const out = fs.createWriteStream(partial);
      req.on('data', chunk => { bytes += chunk.length; });
      req.on('aborted', () => {
        failed = true;
        out.destroy();
        fs.promises.unlink(partial).catch(() => {});
      });
      out.on('error', err => {
        failed = true;
        console.error('Could not save the recording:', err);
        if (!res.headersSent) bad(res, 'Could not save the recording', 500);
      });
      out.on('finish', async () => {
        if (failed) return;
        if (bytes < 1024) {
          await fs.promises.unlink(partial).catch(() => {});
          return bad(res, 'No video data received', 400);
        }
        try {
          await fs.promises.rename(partial, target);
        } catch (err) {
          console.error('Could not store the recording:', err);
          return bad(res, 'Could not save the recording', 500);
        }
        const duration = Number(req.query.duration);
        const startedAt = Number(req.query.startedAt);
        ctx.game.recording = {
          size: bytes,
          duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
          startedAt: Number.isFinite(startedAt) && startedAt > 0 ? Math.round(startedAt) : null,
          savedAt: Date.now()
        };
        ctx.game.updatedAt = Date.now();
        store.save();
        pushGame(ctx.game);
        res.json({ ok: true, game: publicGame(ctx.game) });
      });
      req.pipe(out);
    }).catch(err => {
      console.error('Could not create the recordings folder:', err);
      bad(res, 'Could not save the recording', 500);
    });
  }
  // POST as well, so the browser can flush a recording with sendBeacon on page close.
  router.put('/games/:id/recording', saveRecording);
  router.post('/games/:id/recording', saveRecording);

  // Anyone signed in can watch a finished game's recording, viewers included.
  router.get('/games/:id/recording', (req, res) => {
    const game = store.game(req.params.id);
    if (!game) return bad(res, 'Game not found', 404);
    if (!game.recording) return bad(res, 'This game has no recording', 404);
    res.type('video/webm');
    res.setHeader('Cache-Control', 'private, max-age=0');
    res.sendFile(path.join(RECORDINGS_DIR, `${game.id}.webm`), err => {
      if (err && !res.headersSent) bad(res, 'This game has no recording', 404);
    });
  });

  router.post('/games/:id/events', (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    const body = req.body || {};
    const error = applyEvent(ctx.game, {
      type: body.type,
      side: body.side,
      points: body.points,
      player: body.player,
      note: body.note,
      replayMs: body.replayMs
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
    if (body.pens !== undefined) {
      if (!ctx.game.shootout || !ctx.game.shootout.active) return bad(res, 'This game has no penalty shootout');
      const pens = body.pens || {};
      if (!Number.isInteger(pens.home) || !Number.isInteger(pens.away) || pens.home < 0 || pens.away < 0 || pens.home > 99 || pens.away > 99) {
        return bad(res, 'pens.home and pens.away must be whole numbers between 0 and 99');
      }
      ctx.game.shootout.home = pens.home;
      ctx.game.shootout.away = pens.away;
    }
    ctx.game.score.home = home;
    ctx.game.score.away = away;
    // Direct score edits are part of the replay timeline too.
    const replayMs = Number(body.replayMs);
    const scoreSets = Array.isArray(ctx.game.scoreSets) ? ctx.game.scoreSets : (ctx.game.scoreSets = []);
    scoreSets.push({
      at: Date.now(),
      replayMs: Number.isFinite(replayMs) && replayMs >= 0 ? Math.round(replayMs) : null,
      home,
      away,
      pensHome: ctx.game.shootout && ctx.game.shootout.active ? ctx.game.shootout.home : null,
      pensAway: ctx.game.shootout && ctx.game.shootout.active ? ctx.game.shootout.away : null,
      period: ctx.game.clock.period
    });
    if (scoreSets.length > 200) scoreSets.splice(0, scoreSets.length - 200);
    if (body.final === true) {
      const error = endGame(ctx.game);
      if (error) return bad(res, error);
    }
    ctx.game.updatedAt = Date.now();
    store.save();
    pushGame(ctx.game);
    advance(ctx.game);
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
