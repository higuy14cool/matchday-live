# Matchday Live

Tournaments, fixtures, live scoreboards and a phone-camera stream for **soccer** and **basketball**.
One small Node server, no build step, no database to install.

![two sports](https://img.shields.io/badge/sports-soccer%20%7C%20basketball-9ae64b)

## What it does

- **Tournaments** – a 3-step wizard: name and sport, then 3 to 80 team names, then the format (1–16 groups, single/double round robin or straight knockout, and final-only, semifinals or quarterfinals).
- **Custom groups** – after the team list you can put each team in a group yourself; if you do not, teams are split evenly.
- **Placement matches** – optionally add a third-place match when the format has semifinals or quarterfinals, and a 5th/6th place match when there are enough teams left.
- **Quick games** – a standalone game between two teams, outside any tournament, from the home page.
- **Fixtures** – group games are generated automatically when the tournament is created; knockout games (quarterfinal, semifinal, final) are created once the qualifiers are known.
- **Automatic progression** – quarterfinal winners meet in the semifinals, semifinal winners go to the final, semifinal losers go to the third-place match, and the next two teams play for 5th/6th. Every game has a *Change teams* control while it is still scheduled, so you can set a semifinal matchup by hand; the result still moves on the same way.
- **Standings** – a table per group (P, W, D, L, goals/points for and against, goal difference, points) with the qualifying places highlighted.
- **Live scoreboard** – score, fouls/cards, period clock, undo and a play-by-play feed. Every change is pushed to all viewers over a WebSocket, so phones in the stands stay in sync.
- **Final scores** – enter the result and tick “This is the final score” to finish the game, stop the clock, and let the bracket fill the next round in one step.
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
| `POST`   | `/api/tournaments`                     | create with teams + format (returns `ownerKey` once) |
| `POST`   | `/api/quick-games`                     | create a standalone two-team game |
| `GET`    | `/api/quick-games`                     | recent quick games               |
| `GET`    | `/api/tournaments/:id`                 | tournament, teams, games         |
| `PATCH`  | `/api/tournaments/:id`                 | rename / change sport            |
| `DELETE` | `/api/tournaments/:id`                 | delete tournament and its games  |
| `POST`   | `/api/tournaments/:id/teams`           | add team                         |
| `POST`   | `/api/tournaments/:id/fixtures`        | round-robin fixture list         |
| `POST`   | `/api/tournaments/:id/games`           | create a game (scheduled or live) |
| `GET`    | `/api/live`                            | games currently in play          |
| `GET`    | `/api/games/:id`                       | game + teams                     |
| `POST`   | `/api/games/:id/events`                | goal / score / card / foul       |
| `PATCH`  | `/api/games/:id`                       | change teams, venue or status    |
| `POST`   | `/api/games/:id/undo`                  | undo last event                  |
| `POST`   | `/api/games/:id/score`                 | set the score outright           |
| `POST`   | `/api/games/:id/clock`                 | start / pause / reset / next     |
| `POST`   | `/api/games/:id/stream`                | set or clear an embed URL        |

Creating a game accepts `"live": true` to set it live and start the clock right away; the default is a scheduled game. It also accepts `"stage"`: `group`, `qf`, `sf`, `third`, `final` or `placement`; the stage is checked against the tournament's format (a final-only tournament refuses a quarterfinal).

`PATCH /api/games/:id` with `{"homeTeamId": "...", "awayTeamId": "..."}` changes who plays a scheduled knockout game (group games and games that have started keep their teams).

Set a score with `POST /api/games/:id/score` and `{"home": 3, "away": 1, "final": true}` to store the final result and finish the game. Finishing a group round or a knockout round creates the next games automatically.

A tournament can be created in one request:

```json
POST /api/tournaments
{
  "name": "Sunday Cup",
  "sport": "soccer",
  "teams": [
    { "name": "Riverside FC", "group": 0 },
    { "name": "Northside United", "group": 1 },
    { "name": "Harbour City", "group": 0 },
    { "name": "Hilltop Rovers", "group": 1 }
  ],
  "format": { "groups": 2, "groupStage": "single", "knockout": "semifinal", "advancePerGroup": 1, "thirdPlace": true, "placement": false }
}
```

Teams can also be plain names (`"teams": ["A", "B", "C"]`), in which case they are split evenly across the groups. Group numbers start at 0.

`groupStage` is `single`, `double` or `none`; `knockout` is `none`, `final`, `semifinal` or `quarterfinal`. `thirdPlace` is honoured for semifinal and quarterfinal formats; `placement` (the 5th/6th place game) needs a group stage and at least two teams beyond the knockout bracket.

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
