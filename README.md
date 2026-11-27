# Matchday Live

Tournaments, fixtures, live scoreboards and a phone-camera stream for **soccer** and **basketball**.
One small Node server, no build step, no database to install.

![two sports](https://img.shields.io/badge/sports-soccer%20%7C%20basketball-9ae64b)

## What it does

- **Tournaments** – create one per competition, pick soccer or basketball, add up to 64 teams.
- **Fixtures** – schedule games by hand or generate a full round-robin in one click.
- **Live scoreboard** – score, fouls/cards, period clock, undo and a play-by-play feed. Every change is pushed to all viewers over a WebSocket, so phones in the stands stay in sync.
- **Big scoreboard** – a full-screen board (`#/g/<id>/board`) for a projector or a second screen, with a fullscreen button.
- **Live video** – the organizer can go live from the phone camera (WebRTC, peer to peer) or embed a YouTube/Twitch link. The scoreboard overlays the video.
- **Organizer keys** – whoever creates a tournament gets a private key stored in the browser. Only that browser can change scores, start streams or edit the tournament. Everyone else gets a read-only view.

## Run it

```bash
npm install
npm start
# open http://localhost:3000
```

Node 18 or newer. For development with auto-restart: `npm run dev`.
Tests: `npm test` (spins up a throwaway server and data directory).

Optional environment variables:

| Variable   | Default      | Meaning                                   |
| ---------- | ------------ | ----------------------------------------- |
| `PORT`     | `3000`       | HTTP port                                 |
| `HOST`     | `0.0.0.0`    | bind address                              |
| `DATA_DIR` | `./data`     | where `db.json` is written                |

Data lives in a single JSON file (`data/db.json`), written atomically and debounced. Back it up by copying that file.

## Try the demo

With no tournaments yet, the home page shows **Load demo data** (or call `POST /api/demo`). It seeds a basketball league and a soccer cup with teams, games and one live game each. The response contains the owner key for the demo tournaments; the browser stores it automatically when you use the button.

## Live video notes

- Phone camera streaming needs **HTTPS or localhost** (browser rule for `getUserMedia`). On a LAN, put the app behind a TLS proxy or use a tunnel.
- One broadcaster per game; if a second organizer goes live, the first is stepped down and viewers switch to the new stream.
- Embedded links need no camera and work for any number of viewers, but only while no one is broadcasting from a camera.
- Video is peer to peer (WebRTC); the server only relays signalling messages.

## API at a glance

All writes to a tournament or its games need the header `X-Owner-Key: <key>`.

| Method   | Path                                   | Purpose                          |
| -------- | -------------------------------------- | -------------------------------- |
| `GET`    | `/api/health`                          | status + supported sports        |
| `GET`    | `/api/tournaments`                     | list tournaments                 |
| `POST`   | `/api/tournaments`                     | create (returns `ownerKey` once) |
| `GET`    | `/api/tournaments/:id`                 | tournament, teams, games         |
| `PATCH`  | `/api/tournaments/:id`                 | rename / change sport            |
| `DELETE` | `/api/tournaments/:id`                 | delete tournament and its games  |
| `POST`   | `/api/tournaments/:id/teams`           | add team                         |
| `POST`   | `/api/tournaments/:id/fixtures`        | round-robin fixture list         |
| `POST`   | `/api/tournaments/:id/games`           | schedule a game                  |
| `GET`    | `/api/live`                            | games currently in play          |
| `GET`    | `/api/games/:id`                       | game + teams                     |
| `POST`   | `/api/games/:id/events`                | goal / score / card / foul       |
| `POST`   | `/api/games/:id/undo`                  | undo last event                  |
| `POST`   | `/api/games/:id/score`                 | set the score outright           |
| `POST`   | `/api/games/:id/clock`                 | start / pause / reset / next     |
| `POST`   | `/api/games/:id/stream`                | set or clear an embed URL        |

WebSocket: `ws://<host>/ws`. Send `{"type":"subscribe","gameId":"gm_…"}` to join a game room; the server pushes `game`, `presence`, `onair`, `viewer-joined` and relayed `signal` messages.

## Layout

```
server/   express app, JSON store, gameplay rules, WebSocket hub
public/   plain ES modules + CSS (no bundler)
test/     node:test suites for the REST API and the live layer
```

## Known limits

- Scores, clocks and keys are trusted to the organizer's browser; there is no user account system.
- The JSON store is single-process; it is fine for a club or a school, not for a fleet of servers.
- Camera streams are peer to peer, so a very large audience needs an embedded stream or an SFU.
